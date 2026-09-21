import type { Asset, Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { buildProductGroupDetails } from '../arrangement/productGroupDetails.ts'

/**
 * Combine two existing image groups into one logical group. The source items
 * stay as separate vector items so each SVG remains editable; the group marks
 * them as a vertical stack for the layout and renderer.
 */
export function combineImageGroups(page: Page, groupIds: string[], assets: Asset[]): Page {
  if (groupIds.length !== 2) throw new Error('组合需要选择两组图片。')
  const groups = (page.imageGroups ?? []).filter(group => groupIds.includes(group.id))
  if (groups.length !== 2 || groups.some(group => !group.itemIds.length)) throw new Error('请选择两个有效的图片组。')
  const items = groups.flatMap(group => group.itemIds.map(id => page.items.find(item => item.id === id))).filter(Boolean)
  const products = new Set(items.map(item => assets.find(asset => asset.id === item!.assetId)?.productId).filter(Boolean))
  if (products.size !== 1) throw new Error('只能组合相同产品的图片。')

  const first = groups[0]
  const itemIds = groups.flatMap(group => group.itemIds)
  const width = Math.max(...groups.map(group => group.width))
  const gap = 1.8 * 500 / 210
  const height = groups.reduce((total, group) => total + group.height, 0) + gap
  const x = Math.min(...groups.map(group => group.x))
  const y = Math.min(...groups.map(group => group.y))
  const combined: ImageGroup = {
    ...first,
    id: `group-combined-${itemIds.join('-')}`,
    itemIds,
    x,
    y,
    width,
    height,
    stacked: 'vertical',
    // Product attributes/details are identical by contract; keep the first.
    details: first.details,
    ...(groups.some(group => group.productGroupId) ? {
      productGroupId: `combined-${itemIds.join('-')}`, imageCells: undefined, imageColumns: undefined,
      detailGroups: buildProductGroupDetails(items as Page['items'], new Map(assets.map(asset => [asset.id, asset]))),
    } : {}),
  }
  let offsetY = y
  const nextItems = page.items.map(item => {
    const index = itemIds.indexOf(item.id)
    if (index < 0) return item
    const sourceGroup = groups.find(group => group.itemIds.includes(item.id))!
    const sourceX = x + width / 2
    const itemY = offsetY + sourceGroup.height / 2
    if (sourceGroup.itemIds[sourceGroup.itemIds.length - 1] === item.id) offsetY += sourceGroup.height + gap
    return { ...item, x: sourceX, y: itemY }
  })
  return {
    ...page,
    items: nextItems,
    imageGroups: [...(page.imageGroups ?? []).filter(group => !groupIds.includes(group.id)), combined],
  }
}

export type GroupSelection = { pageId: number; groupId: string }

/** Combines groups selected from different pages into the first selected page. */
export function combineImageGroupsAcrossPages(pages: Page[], selections: GroupSelection[], assets: Asset[]): Page[] {
  if (selections.length !== 2) throw new Error('组合需要选择两组图片。')
  const locations = selections.map(selection => {
    const pageIndex = pages.findIndex(page => page.id === selection.pageId)
    const page = pages[pageIndex]
    const group = page?.imageGroups?.find(candidate => candidate.id === selection.groupId)
    if (pageIndex < 0 || !group) throw new Error('请选择两个有效的图片组。')
    return { pageIndex, page, group }
  })
  const anchorIndex = Math.min(...locations.map(location => location.pageIndex))
  const anchor = pages[anchorIndex]
  const selectedIds = new Set(locations.flatMap(location => location.group.itemIds))
  const synthetic: Page = {
    ...anchor,
    items: [...anchor.items, ...locations.filter(location => location.pageIndex !== anchorIndex).flatMap(location => location.group.itemIds.map(id => pages[location.pageIndex].items.find(item => item.id === id)).filter(Boolean) as NonNullable<Page['items'][number]>[])],
    imageGroups: [...(anchor.imageGroups ?? []), ...locations.filter(location => location.pageIndex !== anchorIndex).flatMap(location => [location.group])],
  }
  // combineImageGroups validates product identity and keeps the first group's details.
  const combined = combineImageGroups(synthetic, locations.map(location => location.group.id), assets)
  const foreignPageIds = new Set(locations.filter(location => location.pageIndex !== anchorIndex).map(location => location.pageIndex))
  return pages.map((page, index) => {
    if (index === anchorIndex) return combined
    if (!foreignPageIds.has(index)) return page
    return {
      ...page,
      items: page.items.filter(item => !selectedIds.has(item.id)),
      imageGroups: page.imageGroups?.filter(group => !group.itemIds.some(id => selectedIds.has(id))),
    }
  })
}
