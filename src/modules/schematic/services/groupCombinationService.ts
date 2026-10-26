import { DETAIL_AREA_RATIO, GROUP_GAP, type Asset, type Item, type Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { buildProductGroupDetails } from '../arrangement/productGroupDetails.ts'

/** Each SVG stays independently editable when any number of groups are combined. */
export function combineImageGroups(page: Page, groupIds: string[], assets: Asset[]): Page {
  return combineImageGroupsAcrossPages([page], groupIds.map(groupId => ({ pageId: page.id, groupId })), assets)[0]
}

export type GroupSelection = { pageId: number; groupId: string }
type GroupLocation = { pageIndex: number; page: Page; group: ImageGroup; items: Item[] }

function imageRegionWidth(group: ImageGroup) {
  const width = group.detailsX === undefined
    ? group.width - (group.detailWidth ?? group.width * DETAIL_AREA_RATIO)
    : group.detailsX - group.x
  return Math.max(1, Math.min(group.width, width))
}

function resolveLocations(pages: Page[], selections: GroupSelection[], assets: Map<string, Asset>): GroupLocation[] {
  const unique = [...new Map(selections.map(selection => [JSON.stringify([selection.pageId, selection.groupId]), selection])).values()]
  if (unique.length < 2) throw new Error('组合需要选择至少两组不同的图片。')
  const locations = unique.map(selection => {
    const pageIndex = pages.findIndex(page => page.id === selection.pageId)
    const page = pages[pageIndex]
    const group = page?.imageGroups?.find(candidate => candidate.id === selection.groupId)
    if (!page || !group?.itemIds.length) throw new Error('请选择有效的图片组。')
    const byId = new Map(page.items.map(item => [item.id, item]))
    const items = [...new Set(group.itemIds)].map(id => {
      const item = byId.get(id)
      if (!item || !assets.has(item.assetId)) throw new Error('图片组中有不存在的图片，请重新选择。')
      return item
    })
    return { pageIndex, page, group, items }
  }).sort((a, b) => a.pageIndex - b.pageIndex || a.group.y - b.group.y || a.group.x - b.group.x)
  const products = new Set(locations.flatMap(location => location.items.map(item => assets.get(item.assetId)!.productId)))
  if (products.size !== 1 || ![...products][0]) throw new Error('只能组合相同产品的图片。')
  return locations
}

function combinedDetails(locations: GroupLocation[], assets: Map<string, Asset>) {
  const panels: NonNullable<ImageGroup['detailGroups']> = []
  const assigned = new Set<string>()
  for (const { group, items } of locations) {
    const members = new Set(items.map(item => item.id))
    const source = group.detailGroups?.length ? group.detailGroups
      : group.details ? [{ itemIds: items.map(item => item.id), details: group.details }] : buildProductGroupDetails(items, assets)
    for (const panel of source) {
      const itemIds = [...new Set(panel.itemIds)].filter(id => members.has(id) && !assigned.has(id))
      if (!itemIds.length) continue
      itemIds.forEach(id => assigned.add(id))
      panels.push({ ...panel, itemIds })
    }
    const missing = items.filter(item => !assigned.has(item.id))
    for (const panel of buildProductGroupDetails(missing, assets)) {
      panel.itemIds.forEach(id => assigned.add(id))
      panels.push(panel)
    }
  }
  return panels
}

/** Flatten selected groups into the earliest page, preserving page and group reading order. */
export function combineImageGroupsAcrossPages(pages: Page[], selections: GroupSelection[], assets: Asset[]): Page[] {
  const byAsset = new Map(assets.map(asset => [asset.id, asset]))
  const locations = resolveLocations(pages, selections, byAsset)
  const anchorIndex = locations[0].pageIndex
  const anchor = pages[anchorIndex]
  const first = locations[0].group
  const itemIds = [...new Set(locations.flatMap(location => location.items.map(item => item.id)))]
  const width = Math.max(...locations.map(location => location.group.width))
  const imageWidth = Math.max(width * imageRegionWidth(first) / Math.max(1, first.width), ...locations.map(location => imageRegionWidth(location.group)))
  const detailWidth = width - imageWidth
  const height = locations.reduce((total, location) => total + location.group.height, 0) + GROUP_GAP * (locations.length - 1)
  const x = Math.min(...locations.filter(location => location.pageIndex === anchorIndex).map(location => location.group.x))
  const y = Math.min(...locations.filter(location => location.pageIndex === anchorIndex).map(location => location.group.y))
  const moved = new Map<string, Item>()
  const cells: NonNullable<ImageGroup['imageCells']> = []
  const cellIds = new Set<string>()
  let top = y
  for (const { group, items } of locations) {
    // Translate each source group once. Every member keeps its own position
    // inside that group, including Front/Back pairs and earlier combinations.
    const dx = x + (imageWidth - imageRegionWidth(group)) / 2 - group.x, dy = top - group.y
    for (const item of items) if (!moved.has(item.id)) moved.set(item.id, { ...item, x: item.x + dx, y: item.y + dy })
    for (const cell of group.imageCells ?? []) if (!cellIds.has(cell.itemId)) {
      cells.push({ ...cell, x: cell.x + dx, y: cell.y + dy }); cellIds.add(cell.itemId)
    }
    top += group.height + GROUP_GAP
  }
  const id = `group-combined-${itemIds.join('-')}`
  const combined: ImageGroup = { ...first, id, productGroupId: id, itemIds, x, y, width, height, backgroundHeight: height,
    stacked: 'vertical', layoutMode: undefined, imageColumns: undefined, detailColumns: undefined,
    imageCells: cells.length ? cells : undefined, detailGroups: combinedDetails(locations, byAsset),
    detailsX: x + width - detailWidth, detailWidth, detailsHeight: undefined,
    protectPageFill: locations.some(location => location.group.protectPageFill),
  }
  return pages.map((page, index) => {
    const local = locations.filter(location => location.pageIndex === index)
    if (!local.length) return page
    const selectedGroups = new Set(local.map(location => location.group.id))
    const selectedItems = new Set(local.flatMap(location => location.items.map(item => item.id)))
    const groups = page.imageGroups ?? []
    if (index !== anchorIndex) return { ...page, items: page.items.filter(item => !selectedItems.has(item.id)),
      imageGroups: groups.filter(group => !selectedGroups.has(group.id)) }
    const insertion = groups.findIndex(group => selectedGroups.has(group.id))
    const nextGroups = groups.flatMap((group, groupIndex) => [
      ...(groupIndex === insertion ? [combined] : []), ...(!selectedGroups.has(group.id) ? [group] : []),
    ])
    const existing = new Set(anchor.items.map(item => item.id))
    return { ...page, imageGroups: nextGroups,
      items: [...anchor.items.map(item => moved.get(item.id) ?? item), ...itemIds.filter(id => !existing.has(id)).map(id => moved.get(id)!)],
    }
  })
}
