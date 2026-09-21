import { constrain, defaultLayoutBounds, GROUP_GAP, headerCells, HEADER_BLOCK_HEIGHT, normalizeLayoutBounds, PAPER_HEIGHT, PAPER_WIDTH, type HeaderBlock, type Item, type LayoutBounds, type Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { imageCenterWithDimensionGutter } from './imageDimensionService.ts'
import { rearrangeProductPage } from '../arrangement/rearrangeProductPage.ts'

type Slot = { x: number; width: number }
type Column = { x: number; width: number; images: Slot[] }
type Section = { top: number; bottom: number; columns: Column[]; assetIds?: string[]; auto?: boolean }
const PADDING = GROUP_GAP
const NATURAL_HEIGHT = 100 + PADDING * 2
// Pagination and placement share a comfortable row height. Missing accessory
// metadata or a short final page must not change the visual density.
export const AUTO_ROW_HEIGHT = 110

function layout(items: Item[], bounds: LayoutBounds, blocks: HeaderBlock[], stacks: ImageGroup[] = []): { items: Item[]; imageGroups: ImageGroup[] } {
  if (!items.length) return { items: [], imageGroups: [] }
  const area = normalizeLayoutBounds(bounds)
  const width = PAPER_WIDTH - area.left - area.right
  const bottom = PAPER_HEIGHT - area.bottom
  const columnWidth = (width - GROUP_GAP * 3) / 4
  const defaultColumns = Array.from({ length: 4 }, (_, index) => {
    const x = area.left + index * (columnWidth + GROUP_GAP)
    return { x, width: columnWidth, images: [{ x, width: columnWidth }] }
  })
  const sorted = [...blocks].filter(block => block.columns.length).sort((a, b) => a.y - b.y)
  const sections: Section[] = []
  if (!sorted.length || sorted[0].y - area.top > 40) sections.push({ top: area.top, bottom: sorted[0] ? sorted[0].y - GROUP_GAP : bottom, columns: defaultColumns })
  sorted.forEach((block, index) => {
    const top = block.y + HEADER_BLOCK_HEIGHT + GROUP_GAP
    const end = (sorted[index + 1]?.y ?? bottom) - (sorted[index + 1] ? GROUP_GAP : 0)
    const cells = headerCells(block)
    const groupWidth = (block.width - GROUP_GAP * (block.columns.length - 1)) / block.columns.length
    if (end > top) sections.push({ top, bottom: end, assetIds: block.assetIds, auto: block.auto, columns: block.columns.map((column, columnIndex) => ({
      x: block.x + columnIndex * (groupWidth + GROUP_GAP), width: groupWidth,
      images: cells.filter(cell => cell.id.startsWith(column.id + '-image-')).map(cell => ({ x: block.x + cell.x, width: cell.width })),
    })) })
  })
  if (!sections.length) throw new Error('排列区域不足，请移动表头、减少本页图片或扩大排列区域。')
  const placed: Item[] = []
  const imageGroups: ImageGroup[] = []
  const stackByItem = new Map<string, ImageGroup>()
  stacks.filter(group => group.stacked === 'vertical').forEach(group => group.itemIds.forEach(id => stackByItem.set(id, group)))
  const units = items.reduce<Array<{ items: Item[]; stack?: ImageGroup }>>((result, item) => {
    const stack = stackByItem.get(item.id)
    if (!stack) result.push({ items: [item] })
    else if (!result.some(unit => unit.stack?.id === stack.id)) result.push({ items: stack.itemIds.map(id => items.find(candidate => candidate.id === id)).filter(Boolean) as Item[], stack })
    return result
  }, [])
  const assignedAssets = new Set(sorted.flatMap(block => block.assetIds ?? []))
  for (const [sectionIndex, section] of sections.entries()) {
    const placedIds = new Set(placed.map(item => item.id))
    const remaining = units.filter(unit => !unit.items.some(item => placedIds.has(item.id)) && (!section.assetIds || unit.items.some(item => section.assetIds!.includes(item.assetId))
      || (sectionIndex === sections.length - 1 && unit.items.some(item => !assignedAssets.has(item.assetId)))))
    if (!remaining.length) continue
    const height = section.bottom - section.top
    const perRow = section.columns.reduce((total, column) => total + column.images.length, 0)
    const naturalRows = Math.max(1, Math.floor((height + GROUP_GAP) / (NATURAL_HEIGHT + GROUP_GAP)))
    const count = section.assetIds || sectionIndex === sections.length - 1 ? remaining.length : Math.min(remaining.length, naturalRows * perRow)
    const rows = Math.ceil(count / perRow)
    const availableRowHeight = (height - (rows - 1) * GROUP_GAP) / rows
    const ordinaryAutoSection = section.auto && remaining.every(unit => !unit.stack)
    const rowHeight = ordinaryAutoSection ? Math.min(availableRowHeight, AUTO_ROW_HEIGHT) : availableRowHeight
    if (rowHeight <= 1 || section.columns.some(column => column.width <= 1)) throw new Error('排列区域不足以保留 1.8mm 组间留白，请减少本页图片或扩大排列区域。')
    let cursor = 0
    for (let row = 0; row < rows; row++) {
      for (const column of section.columns) {
        if (cursor >= count) break
        const y = section.top + row * (rowHeight + GROUP_GAP)
        const firstUnit = remaining[cursor]
        if (!firstUnit) continue
        const group: ImageGroup = { id: 'group-' + firstUnit.items[0].id, itemIds: [], x: column.x, y, width: column.width, height: rowHeight, stacked: firstUnit.stack?.stacked }
        for (const slot of column.images) {
          if (cursor >= count) break
          const current = remaining[cursor]
          const padX = Math.min(PADDING, slot.width / 4)
          const padY = Math.min(PADDING, rowHeight / 4)
          if (current.stack?.stacked === 'vertical') {
            const totalHeight = current.items.reduce((sum, item) => sum + item.h, 0) + PADDING * (current.items.length - 1)
            const maxWidth = Math.max(...current.items.map(item => item.w))
            const ratio = Math.min((slot.width - padX * 2) / maxWidth, (rowHeight - padY * 2) / totalHeight)
            let stackY = y + (rowHeight - totalHeight * ratio) / 2
            current.items.forEach(item => {
              const w = item.w * ratio
              const h = item.h * ratio
              placed.push(constrain({ ...item, w, h, rotation: 0, x: imageCenterWithDimensionGutter(slot, w, w < h), y: stackY + h / 2 }, area))
              group.itemIds.push(item.id)
              stackY += h + PADDING * ratio
            })
            cursor++
            break
          } else {
            const item = current.items[0]
            // Fit the image in either direction so previously reduced images can grow again.
            const ratio = Math.min((slot.width - padX * 2) / item.w, (rowHeight - padY * 2) / item.h)
            const w = item.w * ratio
            const h = item.h * ratio
            placed.push(constrain({ ...item, w, h, rotation: 0, x: imageCenterWithDimensionGutter(slot, w, w < h), y: y + rowHeight / 2 }, area))
            group.itemIds.push(item.id)
            cursor++
          }
        }
        imageGroups.push(group)
      }
    }
  }
  if (placed.length !== items.length) throw new Error('部分图片没有可用的表头排列区域，请重新生成或调整表头。')
  return { items: placed, imageGroups }
}

/** Images and details share one rectangular background; separate Front/Back images share that group. */
export function arrangePage(page: Page, bounds: LayoutBounds = defaultLayoutBounds): Page {
  if (page.imageGroups?.some(group => group.productGroupId)) return rearrangeProductPage(page, bounds)
  const result = layout(page.items, bounds, page.headerBlocks ?? [], page.imageGroups ?? [])
  const previous = page.imageGroups ?? []
  return { ...page, ...result, imageGroups: result.imageGroups.map(group => {
    const old = previous.find(candidate => candidate.itemIds.some(id => group.itemIds.includes(id)))
    return old?.details ? { ...group, details: old.details, stacked: old.stacked } : group
  }) }
}

export function arrangeItems(items: Item[], bounds: LayoutBounds = defaultLayoutBounds, blocks: HeaderBlock[] = []): Item[] {
  return layout(items, bounds, blocks).items
}
