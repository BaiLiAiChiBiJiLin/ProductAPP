import { artworkBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, HOLDER_DETAIL_AREA_RATIO, PAPER_HEIGHT, PAPER_WIDTH, headerColumnBounds, headerDetailLabel, type HeaderColumn, type Item, type LayoutBounds, type Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { headerFor } from '../arrangement/pageSections.ts'
import { imageGroupsForPage } from './groupBackgroundService.ts'

const EPS = 1e-6
type HeaderGeometry = { sourcePageId: number; sourceId?: string; x: number; width: number; columns: HeaderColumn[]; detailWidth?: number; metadataKey?: string }
type GroupGeometry = { sourcePageId: number; id: string; x: number; y: number; width: number; height: number; productKey?: string }
type RowGeometry = { header: HeaderGeometry; groups: GroupGeometry[]; horizontal?: boolean }
type HorizontalSlot = { itemId: string; width: number; height: number; originalWidth?: number; originalHeight?: number; displayScale: number; label?: string; labelColor?: string; caption: boolean; note: boolean }

/** Only geometry and short identifiers cross the worker boundary, never artwork/media. */
export type HorizontalGroupReflowRequest = {
  pageIds: number[]
  newPageId: number
  bounds: { left: number; top: number; width: number; bottom: number }
  rows: RowGeometry[]
  selected: { pageId: number; groupId: string; slots: HorizontalSlot[]; detailHeight: number; detailWidth: number }
}
type GroupPlacement = GroupGeometry & { pageId: number; backgroundHeight: number }
type HorizontalLayout = { pageId: number; groupId: string; detailWidth: number; imageColumns: number; imageCells: NonNullable<ImageGroup['imageCells']>; items: Array<Pick<Item, 'id' | 'x' | 'y' | 'w' | 'h'>> }
export type HorizontalGroupReflowPlan = {
  pageIds: number[]
  sourcePageIds: number[]
  groups: GroupPlacement[]
  headers: Array<HeaderGeometry & { pageId: number; id: string; y: number }>
  horizontal: HorizontalLayout
}

function protectedPage(page: Page) {
  return page.imageGroups?.some(group => group.protectPageFill || /stickers?|贴纸/i.test(group.productKey ?? ''))
}

function detailHeight(group: ImageGroup) {
  const panels = group.detailGroups?.map(panel => panel.details) ?? (group.details ? [group.details] : [])
  return panels.reduce((sum, details) => {
    const fields = (details.sizes?.length || (details.size ? 1 : 0)) + 1 + (details.heading ? 1 : 0) + (details.fields?.length ?? 0)
    const notes = details.note ? Math.min(80, 16 + Math.ceil(details.note.length / 14) * 9) : 0
    const media = details.accessoryImage || details.noteImage || details.noteImages?.length ? 56 : 0
    return sum + Math.max(76, 12 + fields * 13 + notes + media + (details.finish ? 18 : 0))
  }, 0)
}

export function createHorizontalGroupReflowRequest(pages: Page[], pageId: number, groupId: string, bounds: LayoutBounds, visualScales?: ReadonlyMap<string, number>): HorizontalGroupReflowRequest {
  const start = pages.findIndex(page => page.id === pageId)
  if (start < 0) throw new Error('当前示意图页面不存在。')
  const selectedPage = pages[start]
  const selected = imageGroupsForPage(selectedPage).find(group => group.id === groupId)
  if (!selected) throw new Error('请先选择需要横排的图片组。')
  const area = artworkBounds(bounds)
  const width = PAPER_WIDTH - area.left - area.right
  // A sticker group may be edited locally; its page never exchanges content
  // with the surrounding batch or pulls later product pages forward.
  const eligible = protectedPage(selectedPage) ? [selectedPage] : pages.slice(start).filter(page => !protectedPage(page))
  const rows: RowGeometry[] = []
  for (const page of eligible) {
    const groups = imageGroupsForPage(page).sort((a, b) => a.y - b.y || a.x - b.x)
    for (const group of groups) {
      const header = headerFor(page, group)
      const headerGeometry: HeaderGeometry = {
        sourcePageId: page.id, sourceId: header?.id, x: header?.x ?? area.left,
        width: header?.width ?? width, columns: header?.columns.map(column => ({ ...column })) ?? [{ id: 'horizontal-default-column', imageMode: 'photo', detailLabel: 'Size/QT/Accessory' }],
        detailWidth: header?.detailWidth,
        metadataKey: JSON.stringify([header?.auto, header?.productId, header?.productLabel, header?.printOption]),
      }
      const geometry = { sourcePageId: page.id, id: group.id, x: group.x, y: group.y, width: group.width, height: group.height, productKey: group.productKey }
      if (page.id === pageId && group.id === groupId) {
        rows.push({ header: { ...headerGeometry, x: area.left, width,
          columns: [{ id: `${groupId}-horizontal-column`, imageMode: header?.columns[0]?.imageMode ?? 'photo', detailLabel: 'Size/QT/Accessory' }],
          detailWidth: width * HOLDER_DETAIL_AREA_RATIO }, groups: [geometry], horizontal: true })
      } else {
        const last = rows.at(-1)
        if (last && !last.horizontal && last.header.sourcePageId === page.id && last.header.sourceId === header?.id
          && Math.abs(last.groups[0].y - group.y) < EPS) last.groups.push(geometry)
        else rows.push({ header: headerGeometry, groups: [geometry] })
      }
    }
  }
  const byId = new Map(selectedPage.items.map(item => [item.id, item]))
  const slots: HorizontalSlot[] = selected.itemIds.flatMap(id => {
    const item = byId.get(id)
    if (!item) return []
    const scale = visualScales?.get(id) ?? 1
    const displayScale = Number.isFinite(scale) && scale > 0 ? scale : 1
    const radians = item.rotation * Math.PI / 180
    const cell = selected.imageCells?.find(cell => cell.itemId === id)
    return [{ itemId: id, width: (Math.abs(Math.cos(radians)) * item.w + Math.abs(Math.sin(radians)) * item.h) * displayScale,
      height: (Math.abs(Math.sin(radians)) * item.w + Math.abs(Math.cos(radians)) * item.h) * displayScale,
      originalWidth: item.w, originalHeight: item.h, displayScale,
      label: cell?.label, labelColor: cell?.labelColor, caption: Boolean(item.caption && !item.captionHidden), note: Boolean(item.note) }]
  })
  for (const cell of selected.imageCells ?? []) if (!selected.itemIds.includes(cell.itemId)) {
    slots.unshift({ itemId: cell.itemId, width: Math.max(1, ...slots.map(slot => slot.width)), height: 0, displayScale: 1, label: cell.label, labelColor: cell.labelColor, caption: Boolean(cell.label), note: false })
  }
  if (!slots.length) throw new Error('当前图片组没有可排列的图片。')
  return { pageIds: eligible.map(page => page.id), newPageId: Math.max(0, ...pages.map(page => page.id)) + 1,
    bounds: { left: area.left, top: area.top + GROUP_GAP, width, bottom: PAPER_HEIGHT - area.bottom }, rows,
    selected: { pageId, groupId, slots, detailHeight: detailHeight(selected), detailWidth: width * HOLDER_DETAIL_AREA_RATIO } }
}

function headerSignature(header: HeaderGeometry) {
  return JSON.stringify([header.x, header.width, header.detailWidth ?? 0, header.metadataKey, header.columns.map(column => [column.imageMode, headerDetailLabel(column.detailLabel), column.span ?? 1])])
}

function horizontalLayout(request: HorizontalGroupReflowRequest) {
  const { slots, detailWidth, detailHeight: minimumDetails } = request.selected
  const imageWidth = request.bounds.width - detailWidth
  const gap = GROUP_GAP * 2
  const availableWidth = Math.max(1, imageWidth - gap * (slots.length + 1))
  const scale = Math.min(1, availableWidth / Math.max(1, slots.reduce((sum, slot) => sum + slot.width, 0)))
  const captionSpace = 22 // Captions and width rulers both need clearance above the image.
  const noteSpace = slots.some(slot => slot.note) ? 16 : GROUP_GAP
  const imageHeight = Math.max(...slots.map(slot => slot.height * scale))
  const height = Math.max(imageHeight + captionSpace + noteSpace + GROUP_GAP * 2, minimumDetails)
  const unused = Math.max(0, imageWidth - slots.reduce((sum, slot) => sum + slot.width * scale, 0) - gap * (slots.length + 1))
  let x = request.bounds.left + gap + unused / 2
  const cells = slots.map(slot => {
    const width = slot.width * scale
    const cell = { itemId: slot.itemId, label: slot.label, labelColor: slot.labelColor, x: x - gap / 2, y: 0, width: width + gap, height }
    x += width + gap
    return cell
  })
  return { height, cells, items: slots.flatMap((slot, index) => slot.originalWidth === undefined ? [] : [{ id: slot.itemId,
    x: cells[index].x + cells[index].width / 2, y: captionSpace + (height - captionSpace - noteSpace) / 2,
    w: slot.originalWidth * scale, h: slot.originalHeight! * scale }]) }
}

/** Pure CPU work: usable directly or inside a dedicated Worker. */
export function planHorizontalGroupReflow(request: HorizontalGroupReflowRequest): HorizontalGroupReflowPlan {
  const selected = horizontalLayout(request)
  const rows = request.rows.map(row => ({ ...row, groups: row.groups.map(group => ({ ...group })) }))
  for (const row of rows) if (row.horizontal) {
    row.groups[0].width = request.bounds.width
    row.groups[0].height = selected.height
  }
  const pageIds = [...request.pageIds]
  const groups: GroupPlacement[] = []
  const headers: HorizontalGroupReflowPlan['headers'] = []
  let pageIndex = 0, nextId = request.newPageId, y = request.bounds.top
  let currentSignature = ''
  let horizontal: HorizontalLayout | undefined
  for (const row of rows) {
    const signature = headerSignature(row.header)
    const height = Math.max(...row.groups.map(group => group.height))
    const headerHeight = HEADER_BLOCK_HEIGHT + GROUP_GAP
    if (height + headerHeight > request.bounds.bottom - request.bounds.top + EPS) throw new Error('横排后的图片或属性内容超出整页高度，请缩小图片或扩大排列区域。')
    let needsHeader = currentSignature !== signature
    if (y + (needsHeader ? headerHeight : 0) + height > request.bounds.bottom + EPS) {
      pageIndex++
      if (pageIds[pageIndex] === undefined) pageIds.push(nextId++)
      y = request.bounds.top
      currentSignature = ''
      needsHeader = true
    }
    const pageId = pageIds[pageIndex]
    if (needsHeader) {
      headers.push({ ...row.header, pageId, id: `horizontal-header-${pageId}-${headers.length}`, y })
      y += headerHeight
      currentSignature = signature
    }
    const columns = headerColumnBounds({ ...row.header, id: '', y: 0 })
    let nextX = 0
    for (const group of row.groups) {
      const column = columns.find(column => column.x >= nextX - EPS && Math.abs(column.width - group.width) < EPS)
      const x = row.horizontal ? request.bounds.left : column ? row.header.x + column.x : group.x
      nextX = x - row.header.x + group.width + GROUP_GAP
      groups.push({ ...group, pageId, x, y, backgroundHeight: height })
      if (row.horizontal) horizontal = { pageId, groupId: group.id, detailWidth: request.selected.detailWidth,
        imageColumns: request.selected.slots.length,
        imageCells: selected.cells.map(cell => ({ ...cell, y })), items: selected.items.map(item => ({ ...item, y: item.y + y })) }
    }
    y += height + GROUP_GAP
  }
  if (!horizontal) throw new Error('横排图片组已不存在，请重新选择。')
  return { pageIds: pageIds.slice(0, pageIndex + 1), sourcePageIds: request.pageIds, groups, headers, horizontal }
}

/** Apply a geometric plan to original objects so SVGs, colours and edits remain intact. */
export function applyHorizontalGroupReflow(pages: Page[], plan: HorizontalGroupReflowPlan): Page[] {
  const pageById = new Map(pages.map(page => [page.id, page]))
  const originals = new Map(pages.flatMap(page => imageGroupsForPage(page).map(group => [`${page.id}:${group.id}`, group] as const)))
  const changedPages = new Map<number, Page>()
  const horizontalItems = new Map(plan.horizontal.items.map(item => [item.id, item]))
  for (const pageId of new Set([...plan.sourcePageIds, ...plan.pageIds])) {
    const previous = pageById.get(pageId)
    const page: Page = { ...previous, id: pageId, name: previous?.name ?? `页面 ${pageId}`, items: [], imageGroups: [], headerBlocks: [] }
    for (const placement of plan.groups.filter(group => group.pageId === pageId)) {
      const original = originals.get(`${placement.sourcePageId}:${placement.id}`)
      const source = pageById.get(placement.sourcePageId)
      if (!original || !source) throw new Error('页面内容已变化，请重新执行横排。')
      const dx = placement.x - original.x, dy = placement.y - original.y
      const isHorizontal = placement.id === plan.horizontal.groupId && placement.pageId === plan.horizontal.pageId
      const ids = new Set(original.itemIds)
      page.items.push(...source.items.filter(item => ids.has(item.id)).map(item => ({ ...item,
        ...(isHorizontal ? horizontalItems.get(item.id) : { x: item.x + dx, y: item.y + dy }) })))
      page.imageGroups!.push({ ...original, x: placement.x, y: placement.y, width: placement.width, height: placement.height, backgroundHeight: placement.backgroundHeight,
        backgroundColor: original.backgroundColor ?? source.backgroundColor,
        detailsX: original.detailsX === undefined ? undefined : original.detailsX + dx,
        imageCells: original.imageCells?.map(cell => ({ ...cell, x: cell.x + dx, y: cell.y + dy })),
        ...(isHorizontal ? { layoutMode: 'horizontal', stacked: undefined, imageColumns: plan.horizontal.imageColumns,
          imageCells: plan.horizontal.imageCells, detailWidth: plan.horizontal.detailWidth, detailColumns: 1,
          detailsX: placement.x + placement.width - plan.horizontal.detailWidth, detailsHeight: undefined } : {}) })
    }
    page.headerBlocks = plan.headers.filter(header => header.pageId === pageId).map(header => {
      const previousHeader = pageById.get(header.sourcePageId)?.headerBlocks?.find(candidate => candidate.id === header.sourceId)
      return { ...previousHeader, id: header.id, x: header.x, y: header.y, width: header.width, columns: header.columns, detailWidth: header.detailWidth }
    })
    for (const header of page.headerBlocks) {
      const sectionGroups = page.imageGroups!.filter(group => headerFor(page, group) === header)
      const members = new Set(sectionGroups.flatMap(group => group.itemIds))
      header.assetIds = page.items.filter(item => members.has(item.id)).map(item => item.assetId)
    }
    changedPages.set(pageId, page)
  }
  const result = pages.map(page => changedPages.get(page.id) ?? page)
  for (const id of plan.pageIds) if (!pageById.has(id)) result.push(changedPages.get(id)!)
  return result.filter(page => !changedPages.has(page.id) || page.items.length > 0 || Boolean(page.annotations?.length))
}

export function horizontalGroupPages(pages: Page[], pageId: number, groupId: string, bounds: LayoutBounds, visualScales?: ReadonlyMap<string, number>): Page[] {
  return applyHorizontalGroupReflow(pages, planHorizontalGroupReflow(createHorizontalGroupReflowRequest(pages, pageId, groupId, bounds, visualScales)))
}
