import { sourceAssetSize, type Asset } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import type { Page } from '../../../model.ts'

const GROUP_GAP = 1.8 * 500 / 210
const VERTICAL_MARKER_INSET = 10
const VERTICAL_MARKER_GAP = 2

/** Use the right-hand whitespace for a vertical ruler without resizing artwork. */
export function imageCenterWithDimensionGutter(slot: { x: number; width: number }, width: number, vertical: boolean) {
  const center = slot.x + slot.width / 2
  if (!vertical) return center
  const available = Math.max(0, (slot.width - width) / 2 - 0.5)
  return center + Math.min(6, available)
}

export type ImageDimension = {
  label: string
  horizontal: boolean
}

/** Formatting used only for the currently selected canvas dimension label. */
export type DimensionDisplayPrecision = 'default' | 'round' | 'truncate'

export type ImageDimensionMarkerLayout = ImageDimension & {
  x1: number
  y1: number
  x2: number
  y2: number
  extension: Array<[number, number, number, number]>
  textX: number
  textY: number
  textWidth: number
  textRotation: number
  gap: number
}

const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, '')

function sourceSize(asset: Asset) {
  const attributes = asset.attributes ?? {}
  const key = Object.keys(attributes).find(candidate => ['size', '尺', '尺寸'].includes(normalize(candidate)))
  return key ? String(attributes[key] ?? '').trim() : ''
}

function number(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)))
}

export function formatDimensionNumber(value: number, precision: DimensionDisplayPrecision = 'default') {
  if (precision === 'round') return String(Math.round(value))
  if (precision === 'truncate') return String(Math.trunc(value))
  return number(value)
}

export function physicalSourceSize(asset: Asset) {
  const widthMm = Number(asset.sourceGroupWidthMm)
  const heightMm = Number(asset.sourceGroupHeightMm)
  const rawWidth = Number(asset.width)
  const rawHeight = Number(asset.height)
  if (widthMm > 0 && heightMm > 0 && rawWidth > 0 && rawHeight > 0) {
    const physicalRatio = widthMm / heightMm
    const sourceRatio = rawWidth / rawHeight
    if (Number.isFinite(physicalRatio) && Number.isFinite(sourceRatio)
      && Math.abs(Math.log(physicalRatio / sourceRatio)) <= 0.08) {
      return { width: widthMm, height: heightMm }
    }
  }
  // SVG user units without a physical root unit default to CSS px. This is
  // only a fallback for old records that predate sourceGroupWidthMm.
  return { width: rawWidth * 25.4 / 96, height: rawHeight * 25.4 / 96 }
}

function sizeMillimetres(raw: string, originalLongest: number) {
  const values = [...raw.matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0])).filter(Number.isFinite)
  if (!values.length) return originalLongest
  const longest = Math.max(...values)
  const unit = raw.match(/mm|cm|inch(?:es)?|in\b|英寸|毫米|厘米|["']/i)?.[0]?.toLowerCase()
  const multiplier = !unit || unit === 'mm' || unit === '毫米'
    ? 1
    : unit === 'cm' || unit === '厘米'
      ? 10
      : 25.4
  return longest * multiplier
}

/** Dimension text always comes from the persisted source size, never item.w/item.h. */
export function imageDimensionForAsset(asset: Asset, precision: DimensionDisplayPrecision = 'default'): ImageDimension {
  const source = sourceAssetSize(asset)
  const physical = physicalSourceSize(asset)
  const horizontal = source.width >= source.height
  const originalLongest = Math.max(physical.width, physical.height)
  return { label: `${formatDimensionNumber(sizeMillimetres(sourceSize(asset), originalLongest), precision)} mm`, horizontal }
}

export function imageDimensionForGroup(group: ImageGroup, page: Page, assets: Map<string, Asset>) {
  const item = page.items.find(candidate => group.itemIds.includes(candidate.id))
  const asset = item ? assets.get(item.assetId) : undefined
  return asset ? imageDimensionForAsset(asset) : undefined
}

/** Each ruler belongs to one image, even when several images share one product/details group. */
export function imageGroupsForDimension(page: Page): ImageGroup[] {
  const byId = new Map(page.items.map(item => [item.id, item]))
  const grouped = new Set<string>()
  const groups = (page.imageGroups ?? []).flatMap(group => {
    const items = group.itemIds.map(id => byId.get(id)).filter((item): item is Page['items'][number] => !!item && !grouped.has(item.id))
    items.forEach(item => grouped.add(item.id))
    const explicit = new Map(group.imageCells?.map(cell => [cell.itemId, cell]))
    if (items.length === 1 && !explicit.has(items[0].id)) return [{ ...group, itemIds: [items[0].id] }]
    const vertical = group.stacked === 'vertical'
    const ordered = [...items].sort((a, b) => vertical ? a.y - b.y : a.x - b.x)
    return items.map(item => {
      const index = ordered.indexOf(item)
      const previous = ordered[index - 1]
      const next = ordered[index + 1]
      const top = previous ? (previous.y + Math.abs(previous.h) / 2 + item.y - Math.abs(item.h) / 2) / 2 : group.y
      const bottom = next ? (item.y + Math.abs(item.h) / 2 + next.y - Math.abs(next.h) / 2) / 2 : group.y + group.height
      const cell = explicit.get(item.id) ?? {
        itemId: item.id,
        x: vertical ? group.x : group.x + index * group.width / 2 / items.length,
        y: vertical ? top : group.y,
        width: group.width / 2 / (vertical ? 1 : items.length),
        height: vertical ? Math.max(1, bottom - top) : group.height,
      }
      // The public marker layout reserves the right half of its region for details.
      // Doubling the cell width keeps its image half exactly equal to this cell.
      return { ...group, id: `${group.id}-dimension-${item.id}`, itemIds: [item.id],
        x: cell.x, y: cell.y, width: cell.width * 2, height: cell.height, imageCells: [cell],
        detailsX: cell.x + cell.width, detailWidth: cell.width }
    })
  })
  return [...groups, ...page.items.filter(item => !grouped.has(item.id)).map(item => ({
    id: `dimension-${item.id}`,
    itemIds: [item.id],
    x: item.x - item.w / 2 - GROUP_GAP,
    y: item.y - item.h / 2 - GROUP_GAP,
    width: item.w + GROUP_GAP * 2,
    height: item.h + GROUP_GAP * 2,
  }))]
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

/** Place the measurement outside the source artwork while retaining its source-size label. */
export function imageDimensionMarkerLayout(group: ImageGroup, page: Page, assets: Map<string, Asset>, precision: DimensionDisplayPrecision = 'default'): ImageDimensionMarkerLayout | undefined {
  let dimension = imageDimensionForGroup(group, page, assets)
  const item = page.items.find(candidate => group.itemIds.includes(candidate.id))
  if (!dimension || !item || item.suppressRuler) return undefined
  const asset = assets.get(item.assetId)!
  const axis = group.id.endsWith('-width') ? 'width' : group.id.endsWith('-height') ? 'height' : undefined
  dimension = dimensionForItem(asset, item, axis, precision)
  const imageLeft = item.x - Math.abs(item.w) / 2
  const imageRight = item.x + Math.abs(item.w) / 2
  const imageTop = item.y - Math.abs(item.h) / 2
  const imageBottom = item.y + Math.abs(item.h) / 2
  const labelWidth = Math.max(16, dimension.label.length * 4 + 4)
  const gap = labelWidth / 2 + 3
  if (dimension.horizontal) {
    // Placement already constrains the artwork to its cell. A ruler measures
    // those actual edges, including when artwork fills the details boundary.
    const x1 = imageLeft
    const x2 = imageRight
    // Keep the label just above the measurement line inside the green image
    // cell. The short extension lines then reach the actual artwork edge.
    const y = Math.max(group.y + 3, imageTop - 2)
    return { ...dimension, x1, y1: y, x2, y2: y, extension: [[x1, y, x1, item.y], [x2, y, x2, item.y]], textX: (x1 + x2) / 2, textY: y - 3, textWidth: labelWidth, textRotation: 0, gap }
  }
  const y1 = clamp(imageTop, group.y + 4, group.y + group.height - 20)
  const y2 = clamp(imageBottom, y1 + 16, group.y + group.height - 4)
  // Reserve room for the rotated label to the left of the ruler, inside the group.
  const x = Math.max(group.x + VERTICAL_MARKER_INSET, imageLeft - VERTICAL_MARKER_GAP)
  return { ...dimension, x1: x, y1, x2: x, y2, extension: [[x, y1, item.x, y1], [x, y2, item.x, y2]], textX: x, textY: (y1 + y2) / 2, textWidth: labelWidth, textRotation: -90, gap }
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] ?? character))
}

export function imageDimensionMarkersSvg(page: Page, assets: Map<string, Asset>) {
  return dimensionGroups(page).flatMap(group => {
    const marker = imageDimensionMarkerLayout(group, page, assets)
    if (!marker) return []
    const line = marker.horizontal
      ? `<line x1="${marker.x1}" y1="${marker.y1}" x2="${marker.textX - marker.gap}" y2="${marker.y1}"/><line x1="${marker.textX + marker.gap}" y1="${marker.y1}" x2="${marker.x2}" y2="${marker.y1}"/><path d="M${marker.x1} ${marker.y1}l5 -2v4Z" fill="#2f6fa3"/><path d="M${marker.x2} ${marker.y1}l-5 -2v4Z" fill="#2f6fa3"/>`
      : `<line x1="${marker.x1}" y1="${marker.y1}" x2="${marker.x1}" y2="${marker.textY - marker.gap}"/><line x1="${marker.x1}" y1="${marker.textY + marker.gap}" x2="${marker.x1}" y2="${marker.y2}"/><path d="M${marker.x1} ${marker.y1}l-2 5h4Z" fill="#2f6fa3"/><path d="M${marker.x1} ${marker.y2}l-2 -5h4Z" fill="#2f6fa3"/>`
    const extensions = marker.extension.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`).join('')
    return [`<g data-printflow-dimension="true" data-item-id="${escape(group.itemIds[0])}" fill="none" stroke="#2f6fa3" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round">${extensions}${line}<text x="${marker.textX}" y="${marker.textY}" text-anchor="middle" stroke="none" fill="#2f6fa3" font-family="Arial, Microsoft YaHei, sans-serif" font-size="7" transform="${marker.textRotation ? `rotate(${marker.textRotation} ${marker.textX} ${marker.textY})` : ''}">${escape(marker.label)}</text></g>`]
  }).join('')
}

/** Source size determines both axes; Size sets the longest edge in physical units. */
export function dimensionForItem(asset: Asset, item: Pick<Page['items'][number], 'rulerUnit'>, axis?: 'width' | 'height', precision: DimensionDisplayPrecision = 'default'): ImageDimension {
  const physical = physicalSourceSize(asset)
  const longestMm = sizeMillimetres(sourceSize(asset), Math.max(physical.width, physical.height))
  const horizontal = axis ? axis === 'width' : asset.width >= asset.height
  const edgeMm = axis ? longestMm * (horizontal ? asset.width : asset.height) / Math.max(asset.width, asset.height) : longestMm
  const unit = item.rulerUnit ?? 'mm'
  return { horizontal, label: `${formatDimensionNumber(edgeMm / (unit === 'cm' ? 10 : unit === 'in' ? 25.4 : 1), precision)} ${unit}` }
}

export function dimensionGroups(page: Page): ImageGroup[] {
  return imageGroupsForDimension(page).flatMap(group => {
    const item = page.items.find(item => item.id === group.itemIds[0])
    if (!item || item.suppressRuler) return []
    if (item.rulerWidth === undefined && item.rulerHeight === undefined) return [group]
    return [item.rulerWidth ? { ...group, id: group.id + '-width' } : undefined,
      item.rulerHeight ? { ...group, id: group.id + '-height' } : undefined].filter((group): group is ImageGroup => !!group)
  })
}

