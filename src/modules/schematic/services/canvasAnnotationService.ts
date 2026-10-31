import type { Asset, Page } from '../../../model.ts'
import type { CanvasAnnotation } from '../layoutTypes.ts'
import { itemForCanvasDisplay } from './canvasDisplayScaleService.ts'
import { physicalSourceSize } from './imageDimensionService.ts'
import { imageGroupsForPage } from './groupBackgroundService.ts'
import { RULER_COLOR, RULER_STROKE_WIDTH } from './imageDimensionService.ts'
import { updateDetailText, type DetailTextSelection } from './detailTextService.ts'

export type EditorSelection = { kind: 'annotation'; id: string } | { kind: 'caption'; id: string } | { kind: 'empty-caption'; id: string; groupId: string } | DetailTextSelection
export type CanvasTool = 'select' | 'pan' | 'text' | 'ruler'
export type RulerMode = 'free' | 'vertical' | 'horizontal'
export type Point = { x: number; y: number }
export type RulerCalibration = { x: number; y: number; rotation: number; sourceItemId?: string }
export type BackgroundScope = 'batch' | 'page' | 'group'

/** Calibrate against the image under the first click, including visual zoom and rotation. */
export function rulerCalibration(page: Page, assets: Map<string, Asset>, start: Point, scales?: ReadonlyMap<string, number>): RulerCalibration {
  for (const original of [...page.items].reverse()) {
    const item = itemForCanvasDisplay(original, scales?.get(original.id) ?? 1)
    const angle = item.rotation * Math.PI / 180
    const dx = start.x - item.x, dy = start.y - item.y
    const x = dx * Math.cos(angle) + dy * Math.sin(angle)
    const y = -dx * Math.sin(angle) + dy * Math.cos(angle)
    const asset = assets.get(item.assetId)
    if (!asset || Math.abs(x) > item.w / 2 || Math.abs(y) > item.h / 2) continue
    const physical = physicalSourceSize(asset)
    return { x: physical.width / item.w, y: physical.height / item.h, rotation: angle, sourceItemId: item.id }
  }
  return { x: 210 / 500, y: 210 / 500, rotation: 0 }
}

export function measuredDistance(start: Point, end: Point, calibration: RulerCalibration) {
  const dx = end.x - start.x, dy = end.y - start.y
  return Math.hypot((dx * Math.cos(calibration.rotation) + dy * Math.sin(calibration.rotation)) * calibration.x,
    (-dx * Math.sin(calibration.rotation) + dy * Math.cos(calibration.rotation)) * calibration.y)
}

/** Lock the measured baseline to the selected ruler direction. The third
 * placement click remains unconstrained so the user can choose either side
 * and length of the extension lines independently. */
export function constrainRulerPoint(start: Point, point: Point, mode: RulerMode): Point {
  if (mode === 'vertical') return { x: start.x, y: point.y }
  if (mode === 'horizontal') return { x: point.x, y: start.y }
  return point
}

export function manualRulerLabel(mm: number) { return `${Number(mm.toFixed(2))} mm` }

/** Place the dimension line parallel to two measured points at the chosen signed offset. */
export function manualRulerPlacement(start: Point, end: Point, pointer: Point) {
  const length = Math.max(0.001, Math.hypot(end.x - start.x, end.y - start.y))
  const nx = -(end.y - start.y) / length, ny = (end.x - start.x) / length
  const extensionOffset = (pointer.x - start.x) * nx + (pointer.y - start.y) * ny
  return { x: start.x + nx * extensionOffset, y: start.y + ny * extensionOffset,
    x2: end.x + nx * extensionOffset, y2: end.y + ny * extensionOffset, extensionOffset }
}

/** Geometry shared by the Konva editor and exported SVG for a hand-drawn ruler.
 * Endpoints retain their legacy meaning as arrow positions; extensionOffset
 * points back to the measured baseline and defaults to the old short extensions.
 */
export function manualRulerGeometry(annotation: Extract<CanvasAnnotation, { kind: 'ruler' }>) {
  const { x, y, x2, y2 } = annotation
  const dx = x2 - x, dy = y2 - y
  const length = Math.max(0.001, Math.hypot(dx, dy))
  const ux = dx / length, uy = dy / length
  const nx = -uy, ny = ux
  const extensionLength = Number.isFinite(annotation.extensionOffset) ? annotation.extensionOffset! : Math.min(18, Math.max(8, length * 0.22))
  const textWidth = Math.max(16, manualRulerLabel(annotation.measuredMm).length * 4 + 4)
  const gap = Math.min(textWidth / 2 + 3, Math.max(0, length / 2 - 5))
  const mx = (x + x2) / 2, my = (y + y2) / 2
  const angle = Math.atan2(dy, dx) * 180 / Math.PI
  const textRotation = angle >= 90 ? angle - 180 : angle < -90 ? angle + 180 : angle
  const textAngle = textRotation * Math.PI / 180
  const extension: [number, number, number, number][] = [
    [x - nx * extensionLength, y - ny * extensionLength, x, y],
    [x2 - nx * extensionLength, y2 - ny * extensionLength, x2, y2],
  ]
  const segment: [[number, number, number, number], [number, number, number, number]] = [
    [x, y, mx - ux * gap, my - uy * gap],
    [mx + ux * gap, my + uy * gap, x2, y2],
  ]
  const arrowStart: [number, number, number, number, number, number] = [
    x, y, x + ux * 5 + nx * 2, y + uy * 5 + ny * 2, x + ux * 5 - nx * 2, y + uy * 5 - ny * 2,
  ]
  const arrowEnd: [number, number, number, number, number, number] = [
    x2, y2, x2 - ux * 5 + nx * 2, y2 - uy * 5 + ny * 2, x2 - ux * 5 - nx * 2, y2 - uy * 5 - ny * 2,
  ]
  return { length, ux, uy, nx, ny, extension, segment, arrowStart, arrowEnd, textWidth, textRotation,
    textX: mx + Math.sin(textAngle) * 4, textY: my - Math.cos(textAngle) * 4 }
}

export function recolorBackground(pages: Page[], pageId: number, groupIds: string[], scope: BackgroundScope, color: string): Page[] {
  return pages.map(page => {
    if (scope !== 'batch' && page.id !== pageId) return page
    return { ...page, ...(scope !== 'group' ? { backgroundColor: color } : {}),
      imageGroups: imageGroupsForPage(page).map(group => scope !== 'group' || groupIds.includes(group.id) ? { ...group, backgroundColor: color } : group) }
  })
}

export function deleteEditorSelection(page: Page, selection: EditorSelection): Page {
  if (selection.kind === 'detail') return updateDetailText(page, selection, { hidden: true })
  if (selection.kind === 'annotation') return { ...page, annotations: page.annotations?.filter(item => item.id !== selection.id) }
  if (selection.kind === 'caption') return { ...page, items: page.items.map(item => item.id === selection.id ? { ...item, captionHidden: true } : item) }
  return { ...page, imageGroups: page.imageGroups?.map(group => group.id !== selection.groupId ? group : { ...group, imageCells: group.imageCells?.map(cell => cell.itemId === selection.id ? { ...cell, label: undefined } : cell) }) }
}

const escapeXml = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]!))
export function annotationsSvg(annotations: CanvasAnnotation[] = []) {
  return `<g data-canvas-annotations="true" font-family="Arial, Microsoft YaHei, sans-serif">${annotations.map(annotation => {
    const color = annotation.kind === 'ruler' ? RULER_COLOR : escapeXml(annotation.color)
    if (annotation.kind === 'text') return `<text x="${annotation.x}" y="${annotation.y}" fill="${color}" font-size="${annotation.fontSize}">${annotation.text.split('\n').map((line, i) => `<tspan x="${annotation.x}" dy="${i ? annotation.fontSize * 1.2 : annotation.fontSize}">${escapeXml(line)}</tspan>`).join('')}</text>`
    const geometry = manualRulerGeometry(annotation)
    const line = ([x1, y1, x2, y2]: [number, number, number, number]) => `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${color}" stroke-width="${RULER_STROKE_WIDTH}" stroke-linecap="round"/>`
    const polygon = (points: [number, number, number, number, number, number]) => `<path d="M${points[0]} ${points[1]}L${points[2]} ${points[3]}L${points[4]} ${points[5]}Z" fill="${color}" stroke="${color}" stroke-width="${RULER_STROKE_WIDTH}"/>`
    return `<g>${geometry.extension.map(line).join('')}${geometry.segment.map(line).join('')}${polygon(geometry.arrowStart)}${polygon(geometry.arrowEnd)}<text x="${geometry.textX}" y="${geometry.textY}" text-anchor="middle" dominant-baseline="central" transform="rotate(${geometry.textRotation} ${geometry.textX} ${geometry.textY})" font-size="8" fill="${color}">${manualRulerLabel(annotation.measuredMm)}</text></g>`
  }).join('')}</g>`
}
