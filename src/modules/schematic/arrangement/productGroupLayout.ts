import { GROUP_GAP, type Item } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { imageCenterWithDimensionGutter } from '../services/imageDimensionService.ts'
import { quantityLabel, wrapNote } from '../services/imageDetailsLayoutService.ts'

export const PRODUCT_GROUP_ROW_HEIGHT = 110
// The ruler is drawn close to the artwork. Keep only a small clearance in the
// footprint; the old 14-unit reservation made product-group images needlessly small.
export const PRODUCT_GROUP_MARKER_SPACE = 3
// Keep the four fixed detail labels readable while allowing two compact
// product groups to share one row when their fields are short or empty.
export const PRODUCT_GROUP_DETAIL_MIN_WIDTH = 70
export const PRODUCT_GROUP_DETAIL_MAX_WIDTH = 132

function footprint(item: Item) {
  const radians = item.rotation * Math.PI / 180
  return { width: Math.abs(Math.cos(radians)) * item.w + Math.abs(Math.sin(radians)) * item.h,
    height: Math.abs(Math.sin(radians)) * item.w + Math.abs(Math.cos(radians)) * item.h }
}

/** Add the widest feasible image grid instead of reserving one tall row per member. */
export function productGroupFootprint(items: Item[], maxHeight: number, group?: ImageGroup, maxWidth = Number.POSITIVE_INFINITY, preferredColumns?: number) {
  const boxes = items.map(footprint)
  const cellWidth = Math.max(...boxes.map((box, index) => box.width
    + (items[index].w < items[index].h ? PRODUCT_GROUP_MARKER_SPACE : 0)
    + GROUP_GAP))
  const cellHeight = Math.max(PRODUCT_GROUP_ROW_HEIGHT, ...boxes.map(box => box.height + PRODUCT_GROUP_MARKER_SPACE * 2))
  // Keep the product image matrix readable. Three image columns already use
  // the available horizontal space once the compact details panel is removed;
  // additional columns make the individual ruler and artwork too small.
  const widestFirst = Array.from({ length: Math.min(items.length, 3) }, (_, index) => Math.min(items.length, 3) - index)
  const preferred = Number.isInteger(preferredColumns) && preferredColumns! >= 1 && preferredColumns! <= items.length ? [preferredColumns!] : []
  const candidates = [...preferred, ...widestFirst.filter(columns => !preferred.includes(columns))]
  const detailWidth = detailWidthForPanels(group?.detailGroups ?? [])
  for (const columns of candidates) {
    const imageWidth = cellWidth * columns
    // Keep the product information panel compact so it cannot consume an
    // otherwise usable image column.
    if (imageWidth + detailWidth > maxWidth + 1e-7) continue
    const panels = group?.detailGroups ?? []
    const detailColumns = Math.min(columns, Math.max(1, panels.length))
    const detailPanelWidth = Math.max(1, detailWidth / detailColumns - 8)
    const detailHeight = Math.max(0, ...panels.map(({ details }) => {
      const lines = [details.heading ?? '', `Size: ${details.size}`, quantityLabel(details.qt), 'Accessory:', ...(details.fields ?? []).map(field => field.text)]
        .reduce((total, text) => total + wrapNote(text, detailPanelWidth, 10).length, 0)
      const noteLines = details.note ? wrapNote(details.note, detailPanelWidth, 8).length : 0
      return 8 + lines * 11 + noteLines * 10 + (details.accessoryImage ? 48 : 0) + (details.noteImage ? 32 : 0)
    }))
    const height = Math.max(cellHeight * Math.ceil(items.length / columns), Math.ceil(panels.length / detailColumns) * detailHeight)
    if (height <= maxHeight + 1e-7) return { imageWidth, height, columns, cellHeight, detailWidth }
  }
  throw new Error('产品组的图片或产品信息超出整页排列区域，请扩大排列区域或减少组内图片。')
}

function textWidth(text: string, fontSize = 10) {
  return [...text].reduce((width, character) => width + (/[\u0000-\u00ff]/.test(character) ? fontSize * 0.6 : fontSize), 0)
}

function detailWidthForPanels(panels: NonNullable<ImageGroup['detailGroups']>) {
  const widest = Math.max(0, ...panels.flatMap(({ details }) => [
    details.heading ?? '', details.size ? `Size: ${details.size}` : '', quantityLabel(details.qt),
    details.finish ? `Finish: ${details.finish}` : '', 'Accessory:', ...(details.fields ?? []).map(field => field.text), details.note ?? '',
  ].map(text => textWidth(text))))
  return Math.min(PRODUCT_GROUP_DETAIL_MAX_WIDTH, Math.max(PRODUCT_GROUP_DETAIL_MIN_WIDTH, widest + 12))
}

/** Placement keeps current image sizes and reserves independent dimension/label gutters. */
export function placeProductGroup(items: Item[], group: ImageGroup, x: number, y: number, width: number, height: number, columns: number, detailWidth = detailWidthForPanels(group.detailGroups ?? [])) {
  const compactDetailWidth = Math.min(Math.max(1, width - 1), detailWidth)
  const imageAreaWidth = width - compactDetailWidth
  const cellWidth = imageAreaWidth / columns
  const rows = Math.ceil(items.length / columns)
  const cellHeight = height / rows
  const imageCells = items.map((item, index) => ({ itemId: item.id, label: `图 ${index + 1}`,
    x: x + (index % columns) * cellWidth, y: y + Math.floor(index / columns) * cellHeight, width: cellWidth, height: cellHeight }))
  const placed = items.map((item, index) => {
    const cell = imageCells[index]
    const box = footprint(item)
    const vertical = item.w < item.h
    // Horizontal rulers sit above the artwork and need no lateral reserve;
    // vertical rulers only keep the small inset needed for their label.
    const markerSpace = vertical ? PRODUCT_GROUP_MARKER_SPACE : 0
    const availableWidth = Math.max(1, cell.width - markerSpace - GROUP_GAP)
    const availableHeight = Math.max(1, cell.height - GROUP_GAP * 2)
    const scale = Math.max(1, Math.min(availableWidth / box.width, availableHeight / box.height))
    const widthScaled = item.w * scale
    const heightScaled = item.h * scale
    if (box.width * scale + markerSpace + GROUP_GAP > cell.width + 1e-7 || box.height * scale + GROUP_GAP * 2 > cell.height + 1e-7) {
      throw new Error('产品组占位不足，请扩大排列区域或减少组内图片。')
    }
    return { ...item, w: widthScaled, h: heightScaled, x: imageCenterWithDimensionGutter(cell, widthScaled, vertical), y: cell.y + cell.height / 2 }
  })
  return { items: placed, group: { ...group, x, y, width, height, imageColumns: columns, imageCells, detailWidth: compactDetailWidth, detailsX: x + imageAreaWidth } }
}
