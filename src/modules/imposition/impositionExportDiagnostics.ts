import type { ImpositionExportTemplate } from './impositionSvgExport'
import { bounds, polygonBounds, polygonsConflict, SpatialIndex, transformedPolygon, type Polygon, type Region } from './impositionGeometry'

export type ExportGeometryCheck = { polygons: Record<string, Polygon>; region: Region; spacing: number }

/** Reuse source outlines and the canvas broad phase. Never classify overlapping
 * image rectangles as a collision when their true outlines can interlock. */
export function checkExportTemplate(board: ImpositionExportTemplate, width: number, height: number, geometry?: ExportGeometryCheck): string[] {
  const issues = new Set<string>()
  const region = geometry?.region ?? { left: 0, top: 0, right: width, bottom: height }
  const valid = board.placements.flatMap(item => {
    const name = item.image.name
    if (![item.x, item.y, item.width, item.height, item.rotation].every(Number.isFinite) || item.width <= 0 || item.height <= 0) {
      issues.add(`${name}：位置、尺寸或角度无效`)
      return []
    }
    const frame = bounds(item, item.rotation)
    if (frame.left < region.left - 1e-7 || frame.top < region.top - 1e-7 || frame.right > region.right + 1e-7 || frame.bottom > region.bottom + 1e-7) {
      issues.add(`${name}：超出版面有效区域`)
      return []
    }
    const sourceId = item.image.sourceImageId ?? item.image.id.split('#qt-')[0]
    const polygon = geometry?.polygons[sourceId]
    return polygon ? [{ ...item, polygon }] : []
  })
  if (!geometry) return [...issues]
  const index = new SpatialIndex(valid)
  const shapes = new Map(valid.map(item => [item.image.id, transformedPolygon(item, item.rotation)]))
  const checked = new Set<string>()
  for (const item of valid) {
    const polygon = shapes.get(item.image.id)!
    for (const peer of index.query(polygonBounds(polygon), geometry.spacing)) {
      if (peer.image.id === item.image.id || checked.has(peer.image.id)) continue
      if (polygonsConflict(polygon, shapes.get(peer.image.id)!, geometry.spacing)) {
        issues.add(`${item.image.name} / ${peer.image.name}：轮廓重叠或间距小于 ${geometry.spacing} mm`)
        if (issues.size >= 10) return [...issues]
      }
    }
    checked.add(item.image.id)
  }
  return [...issues]
}
