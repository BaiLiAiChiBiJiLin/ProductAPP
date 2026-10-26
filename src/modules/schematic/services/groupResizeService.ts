import { artworkBounds, DETAIL_AREA_RATIO, GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT, PAPER_WIDTH, type HeaderBlock, type HeaderColumn, type Item, type LayoutBounds, type Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { headerFor } from '../arrangement/pageSections.ts'
import { imageGroupsForPage } from './groupBackgroundService.ts'

export type GroupRect = { x: number; y: number; width: number; height: number }
export type GroupResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const EPS = 1e-6
const MIN_HEIGHT = 40
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

function areaFor(bounds: LayoutBounds) {
  const area = artworkBounds(bounds)
  return { x: area.left, y: area.top + HEADER_BLOCK_HEIGHT + GROUP_GAP * 2,
    width: PAPER_WIDTH - area.left - area.right, bottom: PAPER_HEIGHT - area.bottom }
}

/** Horizontal handles use one, two or three base columns; vertical handles remain continuous. */
export function snapGroupResizeRect(group: GroupRect, desired: GroupRect, bounds: LayoutBounds, edge: GroupResizeEdge = 'se'): GroupRect {
  const area = areaFor(bounds)
  const unit = (area.width - GROUP_GAP * 2) / 3
  const widths = [unit, unit * 2 + GROUP_GAP, area.width]
  const horizontal = edge.includes('e') || edge.includes('w')
  const vertical = edge.includes('n') || edge.includes('s')
  const right = group.x + group.width, bottom = group.y + group.height
  const requestedWidth = Math.max(1, finite(desired.width, group.width))
  const width = horizontal
    ? widths.reduce((a, b) => Math.abs(b - requestedWidth) < Math.abs(a - requestedWidth) ? b : a)
    : group.width
  // Preserve the opposite edge where possible. At the page boundary, shift
  // the resized block inward so every starting column can reach full width.
  const x = edge.includes('w') ? right - width : group.x
  const minHeight = Math.min(MIN_HEIGHT, area.bottom - area.y)
  const maxHeight = edge.includes('n') ? bottom - area.y : area.bottom - group.y
  const height = vertical ? clamp(finite(desired.height, group.height), Math.min(minHeight, maxHeight), maxHeight) : group.height
  const y = edge.includes('n') ? bottom - height : group.y
  return { x: clamp(x, area.x, area.x + area.width - width), y: clamp(y, area.y, area.bottom - height), width, height }
}

function normalizedRect(rect: GroupRect, bounds: LayoutBounds): GroupRect {
  const area = areaFor(bounds)
  const width = clamp(finite(rect.width, 1), 1, area.width)
  const height = clamp(finite(rect.height, MIN_HEIGHT), Math.min(MIN_HEIGHT, area.bottom - area.y), area.bottom - area.y)
  return { x: clamp(finite(rect.x, area.x), area.x, area.x + area.width - width),
    y: clamp(finite(rect.y, area.y), area.y, area.bottom - height), width, height }
}

function fallbackCells(group: ImageGroup) {
  const detailWidth = group.detailWidth ?? group.width * DETAIL_AREA_RATIO
  const imageWidth = Math.max(1, (group.detailsX ?? group.x + group.width - detailWidth) - group.x)
  const columns = group.stacked === 'vertical' ? 1 : Math.max(1, Math.min(group.itemIds.length, group.imageColumns ?? group.itemIds.length))
  const rows = Math.max(1, Math.ceil(group.itemIds.length / columns))
  return group.itemIds.map((itemId, index) => ({ itemId, x: group.x + index % columns * imageWidth / columns,
    y: group.y + Math.floor(index / columns) * group.height / rows, width: imageWidth / columns, height: group.height / rows }))
}

function resizeContent(page: Page, group: ImageGroup, rect: GroupRect, scales?: ReadonlyMap<string, number>) {
  const sx = rect.width / Math.max(1, group.width), sy = rect.height / Math.max(1, group.height)
  const cells = group.imageCells?.length ? group.imageCells : fallbackCells(group)
  const nextCells = cells.map(cell => ({ ...cell, x: rect.x + (cell.x - group.x) * sx, y: rect.y + (cell.y - group.y) * sy,
    width: cell.width * sx, height: cell.height * sy }))
  const byCell = new Map(cells.map((cell, index) => [cell.itemId, { before: cell, after: nextCells[index] }]))
  const ids = new Set(group.itemIds)
  const members = page.items.filter(item => ids.has(item.id))
  const footprints = members.map(item => {
    const rotation = item.rotation * Math.PI / 180
    const visual = Math.max(.01, finite(scales?.get(item.id) ?? 1, 1))
    return { width: (Math.abs(Math.cos(rotation)) * item.w + Math.abs(Math.sin(rotation)) * item.h) * visual,
      height: (Math.abs(Math.sin(rotation)) * item.w + Math.abs(Math.cos(rotation)) * item.h) * visual }
  })
  // Shrink all artwork uniformly only when it no longer fits; enlarging a block
  // adds room without silently changing the user's selected picture percentage.
  const shrink = Math.min(1, ...members.map((item, index) => {
    const pair = byCell.get(item.id)
    const oldCell = pair?.before ?? group, cell = pair?.after ?? rect
    const top = item.caption && !item.captionHidden ? 22 : GROUP_GAP
    const bottom = item.note ? 14 : GROUP_GAP
    return Math.min(cell.width < oldCell.width - EPS ? Math.max(1, cell.width - GROUP_GAP * 2) / Math.max(1, footprints[index].width) : 1,
      cell.height < oldCell.height - EPS ? Math.max(1, cell.height - top - bottom) / Math.max(1, footprints[index].height) : 1)
  }))
  const resized = new Map(members.map((item, index) => {
    const pair = byCell.get(item.id)
    const oldCell = pair?.before ?? group, cell = pair?.after ?? rect
    const halfW = footprints[index].width * shrink / 2, halfH = footprints[index].height * shrink / 2
    const top = item.caption && !item.captionHidden ? 22 : GROUP_GAP
    const bottom = item.note ? 14 : GROUP_GAP
    const horizontalGutter = Math.min(GROUP_GAP, Math.max(0, cell.width / 2 - halfW))
    const verticalGutterScale = Math.min(1, Math.max(0, cell.height - halfH * 2) / (top + bottom))
    const x = cell.x + (item.x - oldCell.x) / Math.max(1, oldCell.width) * cell.width
    const y = cell.y + (item.y - oldCell.y) / Math.max(1, oldCell.height) * cell.height
    return [item.id, { ...item, w: item.w * shrink, h: item.h * shrink,
      x: halfW * 2 > cell.width ? cell.x + cell.width / 2 : clamp(x, cell.x + halfW + horizontalGutter, cell.x + cell.width - halfW - horizontalGutter),
      y: halfH * 2 > cell.height ? cell.y + cell.height / 2 : clamp(y, cell.y + halfH + top * verticalGutterScale, cell.y + cell.height - halfH - bottom * verticalGutterScale) }] as const
  }))
  return { items: page.items.map(item => resized.get(item.id) ?? item), group: { ...group, ...rect, manualSize: true, backgroundHeight: rect.height,
    imageCells: nextCells, detailWidth: group.detailWidth === undefined ? undefined : group.detailWidth * sx,
    detailsX: group.detailsX === undefined ? undefined : rect.x + (group.detailsX - group.x) * sx,
    detailsHeight: group.detailsHeight === undefined ? undefined : group.detailsHeight * sy } }
}

/** Local preview changes only the selected block and its own artwork. */
export function resizeImageGroup(page: Page, groupId: string, desired: GroupRect, bounds: LayoutBounds, visualScales?: ReadonlyMap<string, number>): Page {
  const groups = imageGroupsForPage(page)
  const group = groups.find(group => group.id === groupId)
  if (!group) return page
  const rect = normalizedRect(desired, bounds)
  if (Math.abs(group.x - rect.x) < EPS && Math.abs(group.y - rect.y) < EPS && Math.abs(group.width - rect.width) < EPS && Math.abs(group.height - rect.height) < EPS) return page
  const result = resizeContent(page, group, rect, visualScales)
  return { ...page, items: result.items, imageGroups: groups.map(value => value.id === groupId ? result.group : value) }
}

type Unit = { source: Page; group: ImageGroup; header?: HeaderBlock; column: HeaderColumn; items: Item[]; key: string }
type Row = { units: Unit[]; width: number; height: number }
const protectedPage = (page: Page) => page.imageGroups?.some(group => group.protectPageFill || /stickers?|贴纸/i.test(group.productKey ?? ''))

/** Reflow only the edited page and later eligible pages, retaining artwork and product boundaries. */
export function resizeGroupPages(pages: Page[], pageId: number, groupId: string, desired: GroupRect, bounds: LayoutBounds, visualScales?: ReadonlyMap<string, number>): Page[] {
  const start = pages.findIndex(page => page.id === pageId)
  if (start < 0) return pages
  const selectedPage = pages[start]
  if (!imageGroupsForPage(selectedPage).some(group => group.id === groupId)) return pages
  const resized = resizeImageGroup(selectedPage, groupId, desired, bounds, visualScales)
  if (resized === selectedPage) return pages
  const eligible = protectedPage(selectedPage) ? [selectedPage] : pages.slice(start).filter(page => !protectedPage(page))
  const area = areaFor(bounds)
  const units: Unit[] = eligible.flatMap(source => {
    const effective = source.id === pageId ? resized : source
    const changedById = new Map(imageGroupsForPage(effective).map(group => [group.id, group]))
    return imageGroupsForPage(source).sort((a, b) => a.y - b.y || a.x - b.x).map(original => {
      const group = changedById.get(original.id) ?? original
      const header = headerFor(source, original)
      const ordered = imageGroupsForPage(source).filter(candidate => Math.abs(candidate.y - original.y) < EPS).sort((a, b) => a.x - b.x)
      const column = header?.columns[Math.min(ordered.findIndex(candidate => candidate.id === group.id), header.columns.length - 1)]
        ?? { id: `${group.id}-column`, imageMode: 'photo' as const, detailLabel: 'Size/QT/Accessory' }
      return { source, group, header, column, items: effective.items.filter(item => group.itemIds.includes(item.id)),
        key: JSON.stringify([group.productKey ?? '', header?.productId, header?.productLabel, header?.printOption, header?.auto, column.imageMode, column.detailLabel]) }
    })
  })
  const rows: Row[] = []
  for (const unit of units) {
    if (unit.group.width > area.width + EPS || unit.group.height > area.bottom - area.y + EPS) throw new Error('图片块超过整页排列区域，请缩小块或扩大排列区域。')
    const row = rows.at(-1)
    if (row && row.units[0].key === unit.key && row.width + GROUP_GAP + unit.group.width <= area.width + EPS) {
      row.units.push(unit); row.width += GROUP_GAP + unit.group.width; row.height = Math.max(row.height, unit.group.height)
    } else rows.push({ units: [unit], width: unit.group.width, height: unit.group.height })
  }
  const outputs = new Map<number, Page>()
  const pageIds = eligible.map(page => page.id)
  let nextId = Math.max(0, ...pages.map(page => page.id)) + 1
  let pageIndex = 0, y = area.y, signature = ''
  const target = () => {
    if (pageIds[pageIndex] === undefined) pageIds.push(nextId++)
    const id = pageIds[pageIndex]
    let page = outputs.get(id)
    if (!page) {
      const old = eligible.find(page => page.id === id)
      page = { ...old, id, name: old?.name ?? `页面 ${id}`, items: [], imageGroups: [], headerBlocks: [] }
      outputs.set(id, page)
    }
    return page
  }
  for (const row of rows) {
    const rowSignature = JSON.stringify([row.units[0].key, row.units.map(unit => unit.group.width)])
    let newHeader = signature !== rowSignature
    let top = y + (signature && newHeader ? HEADER_BLOCK_HEIGHT + GROUP_GAP : 0)
    // A top-edge resize can intentionally leave room above its row. Preserve
    // that anchor unless preceding content or a page break requires movement.
    if (pageIndex === 0 && row.units.some(unit => unit.source.id === pageId && unit.group.id === groupId)) top = Math.max(top, desired.y)
    if (top + row.height > area.bottom + EPS) {
      pageIndex++; y = area.y; top = y; signature = ''; newHeader = true
    }
    const page = target()
    let x = area.x
    for (const unit of row.units) {
      const dx = x - unit.group.x, dy = top - unit.group.y
      page.items.push(...unit.items.map(item => ({ ...item, x: item.x + dx, y: item.y + dy })))
      page.imageGroups!.push({ ...unit.group, x, y: top, backgroundHeight: unit.group.manualSize ? unit.group.height : row.height,
        backgroundColor: unit.group.backgroundColor ?? unit.source.backgroundColor,
        detailsX: unit.group.detailsX === undefined ? undefined : unit.group.detailsX + dx,
        imageCells: unit.group.imageCells?.map(cell => ({ ...cell, x: cell.x + dx, y: cell.y + dy })) })
      x += unit.group.width + GROUP_GAP
    }
    if (newHeader) {
      // The base span ratios also cover legacy half-page groups without changing their widths.
      const baseWidth = Math.min(...row.units.map(unit => unit.group.width))
      const columns = row.units.map((unit, index) => ({ ...unit.column, id: `resize-column-${page.id}-${page.headerBlocks!.length}-${index}`,
        span: (unit.group.width + GROUP_GAP) / (baseWidth + GROUP_GAP) }))
      const source = row.units[0].header
      page.headerBlocks!.push({ ...source, id: `resize-header-${page.id}-${page.headerBlocks!.length}`, x: area.x,
        y: top - HEADER_BLOCK_HEIGHT - GROUP_GAP, width: row.width, columns,
        detailWidth: row.units.length === 1 ? row.units[0].group.detailWidth : undefined,
        assetIds: row.units.flatMap(unit => unit.items.map(item => item.assetId)) })
    } else {
      const header = page.headerBlocks!.at(-1)!
      header.assetIds = [...new Set([...(header.assetIds ?? []), ...row.units.flatMap(unit => unit.items.map(item => item.assetId))])]
    }
    signature = rowSignature
    y = top + row.height + GROUP_GAP
  }
  for (const source of eligible) if (!outputs.has(source.id)) outputs.set(source.id, { ...source, items: [], imageGroups: [], headerBlocks: [] })
  const result = pages.map(page => outputs.get(page.id) ?? page)
  const addedPages = pageIds.filter(id => !pages.some(page => page.id === id) && outputs.has(id)).map(id => outputs.get(id)!)
  // A protected page never mixes with later products; its overflow must also
  // stay adjacent instead of jumping behind the rest of the batch.
  if (protectedPage(selectedPage)) result.splice(start + 1, 0, ...addedPages)
  else result.push(...addedPages)
  return result.filter(page => !outputs.has(page.id) || page.items.length > 0 || Boolean(page.annotations?.length))
}
