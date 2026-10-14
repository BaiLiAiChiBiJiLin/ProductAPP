import { useEffect, useMemo, useRef, useState } from 'react'
import { Circle, Group, Image as KonvaImage, Layer, Rect, Stage, Text, Transformer } from 'react-konva'
import type Konva from 'konva'
import type { ProductionImage } from './impositionRecords'
import { groupRepeatedPackingPages } from './packingAlgorithms'

type Point = { x: number; y: number }
type Polygon = Array<[number, number]>
type Region = { left: number; top: number; right: number; bottom: number }
type Bounds = Region

export type PackedImpositionItem = { image: ProductionImage; x: number; y: number; width: number; height: number; rotation?: number; polygon?: Polygon }
type Props = { pages: PackedImpositionItem[][]; imageSources: Record<string, string>; polygons?: Record<string, Polygon>; collapseRepeatedLayouts?: boolean; boardWidth: number; boardHeight: number; boardScale: number; effectiveX: number; effectiveY: number; effectiveWidth: number; effectiveHeight: number; spacing: number; holeCount: number; holeSize: number; holeLeft: number; holeStart: number; holeGap: number; zoom: number; panOffset: { x: number; y: number }; panMode: boolean; selectedImageId?: string; onSelectImage: (id: string) => void; onPagesChange?: (pages: PackedImpositionItem[][]) => void }

const imageCache = new Map<string, HTMLImageElement>()
function useSourceImage(source?: string) {
  const [image, setImage] = useState<HTMLImageElement>()
  useEffect(() => {
    if (!source) { setImage(undefined); return }
    const cached = imageCache.get(source)
    if (cached) { setImage(cached); return }
    const next = new window.Image()
    let cancelled = false
    next.onload = () => { imageCache.set(source, next); if (!cancelled) setImage(next) }
    next.src = source
    return () => { cancelled = true; next.onload = null }
  }, [source])
  return image
}

function bounds(item: PackedImpositionItem, rotation: number, x = item.x, y = item.y): Bounds {
  const angle = rotation * Math.PI / 180
  const width = Math.abs(Math.cos(angle)) * item.width + Math.abs(Math.sin(angle)) * item.height
  const height = Math.abs(Math.sin(angle)) * item.width + Math.abs(Math.cos(angle)) * item.height
  return { left: x, top: y, right: x + width, bottom: y + height }
}

function sourcePolygon(item: PackedImpositionItem): Polygon {
  if (item.polygon && item.polygon.length >= 3) return item.polygon
  return [[0, 0], [item.width, 0], [item.width, item.height], [0, item.height]]
}

function polygonArea(polygon: Polygon) {
  let twiceArea = 0
  for (let index = 0; index < polygon.length; index++) {
    const [x, y] = polygon[index]
    const [nextX, nextY] = polygon[(index + 1) % polygon.length]
    twiceArea += x * nextY - nextX * y
  }
  return Math.abs(twiceArea) / 2
}

/** Match Konva's full-image frame rotation, including transparent contour margins. */
function transformedPolygon(item: PackedImpositionItem, rotation: number, x = item.x, y = item.y): Point[] {
  const angle = rotation * Math.PI / 180
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  const rotated = sourcePolygon(item).map(([px, py]) => ({ x: cos * px - sin * py, y: sin * px + cos * py }))
  const minX = Math.min(0, cos * item.width) + Math.min(0, -sin * item.height)
  const minY = Math.min(0, sin * item.width) + Math.min(0, cos * item.height)
  return rotated.map(point => ({ x: x + point.x - minX, y: y + point.y - minY }))
}

function polygonBounds(polygon: Point[]): Bounds {
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
function polygonsConflict(left: Point[], right: Point[], spacing: number) {
  const leftBounds = polygonBounds(left); const rightBounds = polygonBounds(right)
  if (leftBounds.right < rightBounds.left - spacing || rightBounds.right < leftBounds.left - spacing || leftBounds.bottom < rightBounds.top - spacing || rightBounds.bottom < leftBounds.top - spacing) return false
  for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
    const leftStart = left[leftIndex]; const leftEnd = left[(leftIndex + 1) % left.length]
    for (let rightIndex = 0; rightIndex < right.length; rightIndex++) if (segmentsIntersect(leftStart, leftEnd, right[rightIndex], right[(rightIndex + 1) % right.length])) return true
  }
  if (pointInPolygon(left[0], right) || pointInPolygon(right[0], left)) return true
  return spacing > 0 && polygonDistanceSquared(left, right) < spacing * spacing
}

/** Uniform grid index used as the broad phase for drag and collision checks. */
class SpatialIndex {
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

type ResolvedMove = { valid: boolean; pageIndex: number; item: PackedImpositionItem; stagePosition: Point }
type DragTransaction = { itemId: string; sourcePageIndex: number; original: PackedImpositionItem; lastValid: ResolvedMove; lastStagePosition: Point }

function isValidPlacement(item: PackedImpositionItem, pageIndex: number, indices: SpatialIndex[], region: Region, spacing: number) {
  const frame = bounds(item, item.rotation ?? 0)
  if (frame.left < region.left - 1e-7 || frame.top < region.top - 1e-7 || frame.right > region.right + 1e-7 || frame.bottom > region.bottom + 1e-7) return false
  const polygon = transformedPolygon(item, item.rotation ?? 0)
  const itemBounds = polygonBounds(polygon)
  if (itemBounds.left < region.left - 1e-7 || itemBounds.top < region.top - 1e-7 || itemBounds.right > region.right + 1e-7 || itemBounds.bottom > region.bottom + 1e-7) return false
  const peers = indices[pageIndex]?.query(itemBounds, spacing) ?? []
  return !peers.some(other => other.image.id !== item.image.id && polygonsConflict(polygon, transformedPolygon(other, other.rotation ?? 0), spacing))
}

function CanvasImage({ item, source, scale, editable, onSelect, onDragStart, onDragMove, onDragEnd, onTransformEnd, nodeRef }: { item: PackedImpositionItem; source?: string; scale: number; editable: boolean; onSelect: () => void; onDragStart: (node: Konva.Image) => void; onDragMove: (node: Konva.Image) => ResolvedMove; onDragEnd: (node: Konva.Image) => void; onTransformEnd: (node: Konva.Image) => void; nodeRef: (node: Konva.Image | null) => void }) {
  const image = useSourceImage(source)
  const rotation = item.rotation ?? 0
  const visual = bounds(item, rotation, 0, 0)
  const lastValidPosition = useRef<Point>({ x: 0, y: 0 })
  const restore = (node: Konva.Image) => node.absolutePosition(lastValidPosition.current)
  return <KonvaImage ref={nodeRef} image={image} x={(item.x + (visual.right - visual.left) / 2) * scale} y={(item.y + (visual.bottom - visual.top) / 2) * scale} width={item.width * scale} height={item.height * scale} offsetX={item.width * scale / 2} offsetY={item.height * scale / 2} rotation={rotation} perfectDrawEnabled={false} draggable={editable}
    onClick={event => { event.cancelBubble = true; onSelect() }}
    onDragStart={editable ? event => { const node = event.target as Konva.Image; node.moveToTop(); lastValidPosition.current = node.absolutePosition(); onDragStart(node) } : undefined}
    onDragMove={editable ? event => { const node = event.target as Konva.Image; const result = onDragMove(node); if (result.valid) { node.absolutePosition(result.stagePosition); lastValidPosition.current = result.stagePosition } else restore(node) } : undefined}
    onDragEnd={editable ? event => onDragEnd(event.target as Konva.Image) : undefined}
    onTransformEnd={editable ? event => onTransformEnd(event.target as Konva.Image) : undefined} opacity={image ? 1 : .35} />
}

export default function ImpositionKonvaCanvas(props: Props) {
  const { pages, imageSources, polygons = {}, collapseRepeatedLayouts = false, boardWidth, boardHeight, boardScale, effectiveX, effectiveY, effectiveWidth, effectiveHeight, spacing, holeCount, holeSize, holeLeft, holeStart, holeGap, zoom, panOffset, panMode, selectedImageId, onSelectImage } = props
  const [localPages, setLocalPages] = useState(pages)
  const pagesChangedRef = useRef(props.onPagesChange)
  pagesChangedRef.current = props.onPagesChange
  useEffect(() => { pagesChangedRef.current?.(localPages) }, [localPages])
  const displayGroups = useMemo(() => collapseRepeatedLayouts ? groupRepeatedPackingPages(localPages) : localPages.map((page, pageIndex) => ({ page, pageIndices: [pageIndex], repeatCount: 1 })), [localPages, collapseRepeatedLayouts])
  const pageUtilizations = useMemo(() => {
    // Each source outline is measured once even when QT produces many copies.
    const areas = new Map<Polygon, number>()
    return localPages.map(page => page.reduce((sum, item) => {
      const polygon = item.polygon ?? polygons[item.image.sourceImageId ?? item.image.id]
      if (!polygon || polygon.length < 3) return sum + item.width * item.height
      let area = areas.get(polygon)
      if (area === undefined) { area = polygonArea(polygon); areas.set(polygon, area) }
      return sum + area
    }, 0) / Math.max(1, effectiveWidth * effectiveHeight) * 100)
  }, [localPages, polygons, effectiveWidth, effectiveHeight])
  const [viewport, setViewport] = useState({ width: 1, height: 1 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef<Record<string, Konva.Image | null>>({})
  const transformerRef = useRef<Konva.Transformer>(null)
  const transactionRef = useRef<DragTransaction | undefined>(undefined)
  useEffect(() => setLocalPages(pages), [pages])
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => setViewport({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const node = selectedImageId ? nodeRefs.current[selectedImageId] : null
    if (node && transformerRef.current) transformerRef.current.nodes([node])
    else transformerRef.current?.nodes([])
  }, [selectedImageId, localPages, collapseRepeatedLayouts])
  const gap = 24
  const pageWidth = boardWidth * boardScale
  const pageHeight = boardHeight * boardScale
  const columns = 4
  const rows = Math.max(1, Math.ceil(displayGroups.length / columns))
  const stageWidth = columns * pageWidth + (columns - 1) * gap
  const stageHeight = rows * pageHeight + (rows - 1) * gap
  const pageGap = gap / boardScale
  const sceneX = panOffset.x + Math.max(0, (viewport.width - stageWidth * zoom) / 2)
  const sceneY = 24 * zoom + panOffset.y + Math.max(0, (viewport.height - stageHeight * zoom) / 2)
  const indices = useMemo(() => collapseRepeatedLayouts ? [] : localPages.map(page => new SpatialIndex(page.map(item => ({ ...item, polygon: item.polygon ?? polygons[item.image.sourceImageId ?? item.image.id] })))), [localPages, polygons, collapseRepeatedLayouts])
  const region = useMemo(() => ({ left: effectiveX, top: effectiveY, right: effectiveX + effectiveWidth, bottom: effectiveY + effectiveHeight }), [effectiveX, effectiveY, effectiveWidth, effectiveHeight])
  const pagePosition = (pageIndex: number) => ({ column: pageIndex % columns, row: Math.floor(pageIndex / columns) })
  const toGlobalMm = (stagePosition: Point) => ({ x: (stagePosition.x - sceneX) / (zoom * boardScale), y: (stagePosition.y - sceneY) / (zoom * boardScale) })
  const toStagePosition = (pageIndex: number, item: PackedImpositionItem) => {
    const page = pagePosition(pageIndex); const itemBounds = bounds(item, item.rotation ?? 0)
    const x = page.column * (boardWidth + pageGap) + item.x + (itemBounds.right - itemBounds.left) / 2
    const y = page.row * (boardHeight + pageGap) + item.y + (itemBounds.bottom - itemBounds.top) / 2
    return { x: sceneX + x * zoom * boardScale, y: sceneY + y * zoom * boardScale }
  }
  const resolveMove = (sourcePageIndex: number, original: PackedImpositionItem, node: Konva.Image): ResolvedMove => {
    const global = toGlobalMm(node.absolutePosition()); const visual = bounds(original, node.rotation(), 0, 0)
    const targetColumn = Math.max(0, Math.min(columns - 1, Math.floor(global.x / (boardWidth + pageGap))))
    const targetRow = Math.max(0, Math.floor(global.y / (boardHeight + pageGap)))
    const targetPageIndex = targetRow * columns + targetColumn
    const fallback = { valid: false, pageIndex: sourcePageIndex, item: original, stagePosition: transactionRef.current?.lastStagePosition ?? node.absolutePosition() }
    if (targetPageIndex >= localPages.length) return fallback
    const targetPageOrigin = { x: targetColumn * (boardWidth + pageGap), y: targetRow * (boardHeight + pageGap) }
    const value = { x: global.x - targetPageOrigin.x - (visual.right - visual.left) / 2, y: global.y - targetPageOrigin.y - (visual.bottom - visual.top) / 2 }
    const base = { ...original, x: value.x, y: value.y, rotation: node.rotation(), polygon: original.polygon ?? polygons[original.image.id] ?? polygons[original.image.sourceImageId ?? ''] }
    const valid = isValidPlacement(base, targetPageIndex, indices, region, Math.max(0, spacing))
    return { valid, pageIndex: targetPageIndex, item: base, stagePosition: toStagePosition(targetPageIndex, base) }
  }
  const commitTransaction = (transaction: DragTransaction) => {
    const preview = transaction.lastValid
    setLocalPages(current => {
      const withoutSource = current.map(items => items.filter(candidate => candidate.image.id !== transaction.itemId))
      const target = withoutSource[preview.pageIndex] ?? []
      withoutSource[preview.pageIndex] = [...target, preview.item]
      return withoutSource
    })
  }
  const beginTransaction = (pageIndex: number, item: PackedImpositionItem, node: Konva.Image) => {
    const initial = { valid: true, pageIndex, item, stagePosition: node.absolutePosition() }
    transactionRef.current = { itemId: item.image.id, sourcePageIndex: pageIndex, original: item, lastValid: initial, lastStagePosition: initial.stagePosition }
  }
  const moveTransaction = (pageIndex: number, item: PackedImpositionItem, node: Konva.Image) => {
    const transaction = transactionRef.current
    if (!transaction || transaction.itemId !== item.image.id) beginTransaction(pageIndex, item, node)
    const result = resolveMove(pageIndex, transactionRef.current?.original ?? item, node)
    if (result.valid && transactionRef.current) { transactionRef.current.lastValid = result; transactionRef.current.lastStagePosition = result.stagePosition }
    return result
  }
  const endTransaction = (node: Konva.Image) => {
    const transaction = transactionRef.current
    if (transaction) commitTransaction(transaction)
    else node.absolutePosition(node.absolutePosition())
    transactionRef.current = undefined
  }
  const commitTransform = (pageIndex: number, item: PackedImpositionItem, node: Konva.Image) => {
    const result = resolveMove(pageIndex, item, node)
    if (result.valid) commitTransaction({ itemId: item.image.id, sourcePageIndex: pageIndex, original: item, lastValid: result, lastStagePosition: result.stagePosition })
    else { node.rotation(item.rotation ?? 0); node.absolutePosition(toStagePosition(pageIndex, item)) }
  }
  const selectedNode = selectedImageId ? nodeRefs.current[selectedImageId] : null
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
  const visiblePages = displayGroups.map(({ page, pageIndices, repeatCount }, displayIndex) => ({ page, pageIndex: pageIndices[0], displayIndex, repeatCount, x: (displayIndex % columns) * (pageWidth + gap), y: Math.floor(displayIndex / columns) * (pageHeight + gap) })).filter(({ x, y }) => x * zoom + sceneX < viewport.width && (x + pageWidth) * zoom + sceneX > 0 && y * zoom + sceneY < viewport.height && (y + pageHeight) * zoom + sceneY > 0)
  return <div ref={viewportRef} className="imposition-konva-viewport"><Stage width={viewport.width} height={viewport.height} pixelRatio={pixelRatio} listening={!panMode} className="imposition-konva-stage"><Layer><Group x={sceneX} y={sceneY} scaleX={zoom} scaleY={zoom}>
    {visiblePages.map(({ pageIndex, x: pageX, y: pageY }) => <Group key={pageIndex} x={pageX} y={pageY}>
      <Rect width={pageWidth} height={pageHeight} fill="#fff" stroke="#cbd5e1" strokeWidth={1}/>
      <Rect x={effectiveX * boardScale} y={effectiveY * boardScale} width={effectiveWidth * boardScale} height={effectiveHeight * boardScale} stroke="#ef4444" dash={[2 * boardScale, 2 * boardScale]} strokeWidth={.8} listening={false}/>
      {Array.from({ length: Math.max(0, holeCount) }).map((_, index) => <Circle key={index} x={(holeLeft + holeSize / 2) * boardScale} y={(holeStart + index * holeGap + holeSize / 2) * boardScale} radius={holeSize * boardScale / 2} fill="#2563eb" listening={false}/>) }
    </Group>)}
    {visiblePages.map(({ pageIndex, displayIndex, repeatCount, x: pageX, y: pageY }) => <Text key={`utilization-${pageIndex}`} x={pageX + pageWidth / 2} y={pageY - 18} width={pageWidth} align="center" offsetX={pageWidth / 2} text={`${collapseRepeatedLayouts ? `方案 ${displayIndex + 1} · 需生产 ${repeatCount} 块 · ` : ''}利用率 ${Math.round(pageUtilizations[pageIndex] ?? 0)}%`} fontSize={11} fill="#dc2626" listening={false}/>) }
    {visiblePages.flatMap(({ page, pageIndex, x: pageX, y: pageY }) => page.map(item => <Group key={`page-${pageIndex}-image-${item.image.id}`} x={pageX} y={pageY}><CanvasImage item={{ ...item, polygon: item.polygon ?? polygons[item.image.id] ?? polygons[item.image.sourceImageId ?? ''] }} source={imageSources[item.image.sourceImageId ?? item.image.id]} scale={boardScale} editable={!collapseRepeatedLayouts} onSelect={() => onSelectImage(item.image.id)} onDragStart={node => beginTransaction(pageIndex, item, node)} onDragMove={node => moveTransaction(pageIndex, item, node)} onDragEnd={endTransaction} onTransformEnd={node => commitTransform(pageIndex, item, node)} nodeRef={node => { nodeRefs.current[item.image.id] = node }}/></Group>))}
    <Transformer ref={transformerRef} resizeEnabled={false} rotateEnabled={!panMode && !collapseRepeatedLayouts} rotateAnchorOffset={22} borderStroke="#2563eb" visible={Boolean(selectedNode)} />
  </Group></Layer></Stage></div>
}
