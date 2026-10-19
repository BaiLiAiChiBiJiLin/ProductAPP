import type { ProductionImage } from './impositionRecords'

export type Point = { x: number; y: number }
export type Polygon = Array<[number, number]>
export type Region = { left: number; top: number; right: number; bottom: number }
export type Bounds = Region

export type PackedImpositionItem = { image: ProductionImage; x: number; y: number; width: number; height: number; rotation?: number; polygon?: Polygon }
export function bounds(item: PackedImpositionItem, rotation: number, x = item.x, y = item.y): Bounds {
  const angle = rotation * Math.PI / 180
  const width = Math.abs(Math.cos(angle)) * item.width + Math.abs(Math.sin(angle)) * item.height
  const height = Math.abs(Math.sin(angle)) * item.width + Math.abs(Math.cos(angle)) * item.height
  return { left: x, top: y, right: x + width, bottom: y + height }
}

export function sourcePolygon(item: PackedImpositionItem): Polygon {
  if (item.polygon && item.polygon.length >= 3) return item.polygon
  return [[0, 0], [item.width, 0], [item.width, item.height], [0, item.height]]
}

export function polygonArea(polygon: Polygon) {
  let twiceArea = 0
  for (let index = 0; index < polygon.length; index++) {
    const [x, y] = polygon[index]
    const [nextX, nextY] = polygon[(index + 1) % polygon.length]
    twiceArea += x * nextY - nextX * y
  }
  return Math.abs(twiceArea) / 2
}

/** Match Konva's full-image frame rotation, including transparent contour margins. */
export function transformedPolygon(item: PackedImpositionItem, rotation: number, x = item.x, y = item.y): Point[] {
  const angle = rotation * Math.PI / 180
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  const rotated = sourcePolygon(item).map(([px, py]) => ({ x: cos * px - sin * py, y: sin * px + cos * py }))
  const minX = Math.min(0, cos * item.width) + Math.min(0, -sin * item.height)
  const minY = Math.min(0, sin * item.width) + Math.min(0, cos * item.height)
  return rotated.map(point => ({ x: x + point.x - minX, y: y + point.y - minY }))
}

export function polygonBounds(polygon: Point[]): Bounds {
  return polygon.reduce<Bounds>((result, point) => ({ left: Math.min(result.left, point.x), top: Math.min(result.top, point.y), right: Math.max(result.right, point.x), bottom: Math.max(result.bottom, point.y) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity })
}

function cross(a: Point, b: Point, c: Point) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) }
function onSegment(a: Point, b: Point, point: Point) { return Math.abs(cross(a, b, point)) <= 1e-7 && point.x >= Math.min(a.x, b.x) - 1e-7 && point.x <= Math.max(a.x, b.x) + 1e-7 && point.y >= Math.min(a.y, b.y) - 1e-7 && point.y <= Math.max(a.y, b.y) + 1e-7 }
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const ab = cross(a, b, c); const ad = cross(a, b, d); const ca = cross(c, d, a); const cb = cross(c, d, b)
  return (ab > 1e-7 && ad < -1e-7 || ab < -1e-7 && ad > 1e-7) && (ca > 1e-7 && cb < -1e-7 || ca < -1e-7 && cb > 1e-7) || (Math.abs(ab) <= 1e-7 && onSegment(a, b, c)) || (Math.abs(ad) <= 1e-7 && onSegment(a, b, d)) || (Math.abs(ca) <= 1e-7 && onSegment(c, d, a)) || (Math.abs(cb) <= 1e-7 && onSegment(c, d, b))
}
function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const current = polygon[index]; const prior = polygon[previous]
    if ((current.y > point.y) !== (prior.y > point.y) && point.x < (prior.x - current.x) * (point.y - current.y) / (prior.y - current.y) + current.x) inside = !inside
  }
  return inside
}
function distanceToSegmentSquared(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x; const dy = end.y - start.y
  if (dx === 0 && dy === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
  const x = start.x + t * dx; const y = start.y + t * dy
  return (point.x - x) ** 2 + (point.y - y) ** 2
}
function polygonDistanceSquared(left: Point[], right: Point[]) {
  let distance = Infinity
  for (let index = 0; index < right.length; index++) {
    const start = right[index]; const end = right[(index + 1) % right.length]
    for (const point of left) distance = Math.min(distance, distanceToSegmentSquared(point, start, end))
  }
  for (let index = 0; index < left.length; index++) {
    const start = left[index]; const end = left[(index + 1) % left.length]
    for (const point of right) distance = Math.min(distance, distanceToSegmentSquared(point, start, end))
  }
  return distance
}

/** Narrow phase for concave outlines. The broad phase is performed by SpatialIndex. */
export function polygonsConflict(left: Point[], right: Point[], spacing: number) {
  const leftBounds = polygonBounds(left); const rightBounds = polygonBounds(right)
  if (leftBounds.right < rightBounds.left - spacing || rightBounds.right < leftBounds.left - spacing || leftBounds.bottom < rightBounds.top - spacing || rightBounds.bottom < leftBounds.top - spacing) return false
  for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
    const leftStart = left[leftIndex]; const leftEnd = left[(leftIndex + 1) % left.length]
    for (let rightIndex = 0; rightIndex < right.length; rightIndex++) if (segmentsIntersect(leftStart, leftEnd, right[rightIndex], right[(rightIndex + 1) % right.length])) return true
  }
  if (pointInPolygon(left[0], right) || pointInPolygon(right[0], left)) return true
  // Rotated coordinates can round an exact 3 mm gap a few ulps below 3.
  const requiredDistance = Math.max(0, spacing - 1e-7)
  return spacing > 0 && polygonDistanceSquared(left, right) < requiredDistance * requiredDistance
}

/** Uniform grid index used as the broad phase for drag and collision checks. */
export class SpatialIndex {
  private readonly cells = new Map<string, PackedImpositionItem[]>()
  private readonly cellSize = 32
  constructor(items: PackedImpositionItem[]) { items.forEach(item => this.insert(item)) }
  private key(x: number, y: number) { return `${x}:${y}` }
  private range(area: Bounds, padding = 0) {
    const minX = Math.floor((area.left - padding) / this.cellSize); const maxX = Math.floor((area.right + padding) / this.cellSize)
    const minY = Math.floor((area.top - padding) / this.cellSize); const maxY = Math.floor((area.bottom + padding) / this.cellSize)
    const cells: string[] = []
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) cells.push(this.key(x, y))
    return cells
  }
  private insert(item: PackedImpositionItem) {
    this.range(bounds(item, item.rotation ?? 0)).forEach(key => this.cells.set(key, [...(this.cells.get(key) ?? []), item]))
  }
  query(area: Bounds, padding = 0) {
    const result: PackedImpositionItem[] = []; const seen = new Set<string>()
    this.range(area, padding).forEach(key => (this.cells.get(key) ?? []).forEach(item => { if (!seen.has(item.image.id)) { seen.add(item.image.id); result.push(item) } }))
    return result
  }
}

export function isValidPlacement(item: PackedImpositionItem, pageIndex: number, indices: SpatialIndex[], region: Region, spacing: number) {
  const frame = bounds(item, item.rotation ?? 0)
  if (frame.left < region.left - 1e-7 || frame.top < region.top - 1e-7 || frame.right > region.right + 1e-7 || frame.bottom > region.bottom + 1e-7) return false
  const polygon = transformedPolygon(item, item.rotation ?? 0)
  const itemBounds = polygonBounds(polygon)
  if (itemBounds.left < region.left - 1e-7 || itemBounds.top < region.top - 1e-7 || itemBounds.right > region.right + 1e-7 || itemBounds.bottom > region.bottom + 1e-7) return false
  const peers = indices[pageIndex]?.query(itemBounds, spacing) ?? []
  return !peers.some(other => other.image.id !== item.image.id && polygonsConflict(polygon, transformedPolygon(other, other.rotation ?? 0), spacing))
}

