import { GROUP_GAP, HEADER_BLOCK_HEIGHT, normalizeLayoutBounds, PAPER_HEIGHT, PAPER_WIDTH, type Asset, type HeaderBlock, type HeaderImageMode, type LayoutBounds, type Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import type { ProductConfig } from '../services/productConfigService.ts'
import { paginateAutomaticAssets, headerModeForAsset } from '../services/automaticArrangementService.ts'
import { reflowAfterCombination } from '../services/combinationReflowService.ts'
import { buildProductGroupDetails } from './productGroupDetails.ts'

function collectMemberships(assets: Asset[]) {
  const memberships = new Map<string, Asset[]>()
  for (const asset of assets) if (asset.productGroupId) {
    const members = memberships.get(asset.productGroupId) ?? []
    members.push(asset); memberships.set(asset.productGroupId, members)
  }
  for (const members of memberships.values()) {
    if (members.some(asset => (asset.productGroupPosition ?? 0) > 0)) members.sort((a, b) => (a.productGroupPosition ?? 0) - (b.productGroupPosition ?? 0))
  }
  for (const [id, members] of memberships) if (members.length < 2) memberships.delete(id)
  return memberships
}

function renumberPages(pages: Page[]): Page[] {
  return pages.map((page, index) => ({ ...page, id: index + 1, name: `页面 ${index + 1}` }))
}

/** Layout product-group assets only. Ordinary assets are intentionally kept out of this pass so a wide group cannot force them into one column. */
function paginateGroupedAssets(assets: Asset[], bounds: LayoutBounds, configs: ProductConfig[]): Page[] {
  const memberships = collectMemberships(assets)
  // Use ordinary placement as the reference image size: joining a group never makes an image smaller.
  const reference = paginateAutomaticAssets(assets, 1000, bounds, configs)
  const referenceItems = new Map(reference.flatMap(page => page.items.map(item => [item.assetId, item] as const)))
  const byAsset = new Map(assets.map(asset => [asset.id, asset]))
  const units = new Map<string, { group: ImageGroup; items: Page['items']; header: HeaderBlock }>()
  for (const [id, members] of memberships) {
    const leader = members.find(member => member.id === members[0].productGroupLeaderId) ?? members[0]
    const ordered = members.some(member => (member.productGroupPosition ?? 0) > 0)
      ? [...members]
      : [leader, ...members.filter(member => member.id !== leader.id)]
    const items = ordered.map(asset => referenceItems.get(asset.id)!)
    const detailGroups = buildProductGroupDetails(items, byAsset, configs)
    const group: ImageGroup = { id: `product-group-${id}`, productGroupId: id, itemIds: items.map(item => item.id),
      x: 0, y: 0, width: 0, height: 0, detailGroups, details: detailGroups[0]?.details }
    const header = reference.flatMap(page => page.headerBlocks ?? []).find(block => block.assetIds?.includes(leader.id))!
    const unit = { group, items, header: { ...header, columns: header.columns.map(column => ({ ...column, imageMode: headerModeForAsset(leader) })) } }
    members.forEach(asset => units.set(asset.id, unit))
  }
  const ordered = [...new Set(assets.map(asset => units.get(asset.id)!))]
  const seed: Page = { id: 1, name: '页面 1', items: ordered.flatMap(unit => unit.items), imageGroups: ordered.map(unit => unit.group),
    headerBlocks: ordered.map((unit, index) => ({ ...unit.header, id: `product-unit-header-${index}`, assetIds: unit.items.map(item => item.assetId) })) }
  return reflowAfterCombination([seed], 0, assets, bounds, configs)
}

type BackfillPlan = {
  mode: HeaderImageMode
  source: Page
  sourceHeader: HeaderBlock
  groups: ImageGroup[]
  items: Page['items']
  headerY: number
  firstRowY: number
  targetFirstRowY: number
}

function pageContentBottom(page: Page, area: LayoutBounds) {
  return Math.max(area.top, ...(page.headerBlocks ?? []).map(block => block.y + HEADER_BLOCK_HEIGHT), ...(page.imageGroups ?? []).map(group => group.y + group.height))
}

function groupedRows(groups: ImageGroup[]) {
  const rows = new Map<number, ImageGroup[]>()
  for (const group of groups) {
    const key = Math.round(group.y * 1e6) / 1e6
    const row = rows.get(key) ?? []
    row.push(group)
    rows.set(key, row)
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([y, row]) => ({ y, groups: row.sort((a, b) => a.x - b.x) }))
}

function makeBackfillPlan(page: Page, modeAssets: Asset[], mode: HeaderImageMode, bounds: LayoutBounds, configs: ProductConfig[]): BackfillPlan | undefined {
  if (!modeAssets.length) return undefined
  const source = paginateAutomaticAssets(modeAssets, 1000, bounds, configs)[0]
  const sourceHeader = source?.headerBlocks?.find(header => header.columns[0]?.imageMode === mode)
  if (!source || !sourceHeader) return undefined
  const sourceAssetIds = new Set(sourceHeader.assetIds ?? [])
  const sourceGroups = (source.imageGroups ?? []).filter(group => group.itemIds.some(itemId => {
    const item = source.items.find(candidate => candidate.id === itemId)
    return item ? sourceAssetIds.has(item.assetId) : false
  }))
  if (!sourceGroups.length) return undefined
  const rows = groupedRows(sourceGroups)
  const area = normalizeLayoutBounds(bounds)
  const lastHeaderY = Math.max(...(page.headerBlocks ?? []).map(header => header.y), -Infinity)
  const existingHeader = page.headerBlocks?.find(header => header.y === lastHeaderY && header.columns[0]?.imageMode === mode)
  const contentBottom = pageContentBottom(page, area)
  const headerY = existingHeader ? existingHeader.y : contentBottom + GROUP_GAP
  const firstRowY = rows[0].y
  const targetFirstRowY = existingHeader ? contentBottom + GROUP_GAP : headerY + HEADER_BLOCK_HEIGHT + GROUP_GAP
  const available = PAPER_HEIGHT - area.bottom - targetFirstRowY
  const selectedRows: ImageGroup[][] = []
  for (const row of rows) {
    const rowBottom = Math.max(...row.groups.map(group => group.y + group.height))
    if (rowBottom - firstRowY > available + 1e-7) break
    // A compact product header has one logical column even when the product
    // image grid itself is wider. Keep appended ordinary groups in that same
    // column so a later arrange/refresh cannot make them overlap the product
    // group or force it into an invalid header column.
    selectedRows.push(existingHeader ? row.groups.slice(0, existingHeader.columns.length) : row.groups)
  }
  const groups = selectedRows.flat()
  if (!groups.length) return undefined
  const selectedItemIds = new Set(groups.flatMap(group => group.itemIds))
  return { mode, source, sourceHeader, groups, items: source.items.filter(item => selectedItemIds.has(item.id)), headerY, firstRowY, targetFirstRowY }
}

/** Pull complete ordinary rows into genuine free space below compact product groups. */
function backfillOrdinaryAssets(groupedPages: Page[], ordinaryAssets: Asset[], bounds: LayoutBounds, configs: ProductConfig[]) {
  const queues = new Map<HeaderImageMode, Asset[]>()
  for (const asset of ordinaryAssets) {
    const mode = headerModeForAsset(asset)
    queues.set(mode, [...(queues.get(mode) ?? []), asset])
  }
  const pages = groupedPages.map(page => ({ ...page, items: [...page.items], imageGroups: [...(page.imageGroups ?? [])], headerBlocks: [...(page.headerBlocks ?? [])] }))
  const area = normalizeLayoutBounds(bounds)
  const consumed = new Set<string>()
  for (const page of pages) {
    while (true) {
      const candidates = [...queues.entries()]
        .map(([mode, queue]) => makeBackfillPlan(page, queue, mode, area, configs))
        .filter((plan): plan is BackfillPlan => !!plan)
      const plan = candidates.sort((a, b) => b.groups.length - a.groups.length || a.targetFirstRowY - b.targetFirstRowY)[0]
      if (!plan) break
      const sourceAssetIds = new Set(plan.items.map(item => item.assetId))
      const dy = plan.targetFirstRowY - plan.firstRowY
      const dx = area.left - plan.sourceHeader.x
      const lastHeaderY = Math.max(...page.headerBlocks!.map(header => header.y), -Infinity)
      const existingHeader = page.headerBlocks!.find(header => header.y === lastHeaderY && header.columns[0]?.imageMode === plan.mode)
      const targetColumns = existingHeader?.columns.length ?? plan.sourceHeader.columns.length
      const targetWidth = existingHeader
        ? (existingHeader.width - GROUP_GAP * Math.max(0, targetColumns - 1)) / Math.max(1, targetColumns)
        : undefined
      const translatedGroups = plan.groups.map((group, index) => {
        const targetX = existingHeader && targetWidth !== undefined
          ? existingHeader.x + (index % targetColumns) * (targetWidth + GROUP_GAP)
          : group.x + dx
        const deltaX = targetX - group.x
        const width = targetWidth ?? group.width
        const detailWidth = existingHeader?.detailWidth ?? group.detailWidth
        return { ...group,
          x: targetX, y: group.y + dy, width,
          itemIds: [...group.itemIds],
          detailWidth,
          detailsX: detailWidth ? targetX + width - detailWidth : group.detailsX,
          imageCells: group.imageCells?.map(cell => ({ ...cell, x: cell.x + deltaX, y: cell.y + dy })),
          __deltaX: deltaX,
        }
      })
      const translatedItems = plan.items.map(item => {
        const groupIndex = plan.groups.findIndex(group => group.itemIds.includes(item.id))
        const deltaX = translatedGroups[groupIndex]?.__deltaX ?? dx
        return { ...item, x: item.x + deltaX, y: item.y + dy }
      })
      const cleanGroups = translatedGroups.map(({ __deltaX: _deltaX, ...group }) => group)
      page.items.push(...translatedItems)
      page.imageGroups!.push(...cleanGroups)
      if (existingHeader) {
        existingHeader.assetIds = [...new Set([...(existingHeader.assetIds ?? []), ...translatedItems.map(item => item.assetId)])]
      } else {
        page.headerBlocks!.push({ ...plan.sourceHeader, id: `backfill-header-${page.id}-${page.headerBlocks!.length}`, x: area.left,
          y: plan.headerY, width: PAPER_WIDTH - area.left - area.right, assetIds: translatedItems.map(item => item.assetId),
          columns: plan.sourceHeader.columns.map((column, index) => ({ ...column, id: `backfill-column-${page.id}-${index}` })) })
      }
      for (const id of sourceAssetIds) consumed.add(id)
      queues.set(plan.mode, (queues.get(plan.mode) ?? []).filter(asset => !sourceAssetIds.has(asset.id)))
    }
  }
  return { pages, remainingAssets: ordinaryAssets.filter(asset => !consumed.has(asset.id)) }
}

/** Saved product groups are indivisible units before pagination, even across print-option sections. */
export function paginateProductGroups(assets: Asset[], bounds: LayoutBounds, configs: ProductConfig[]): Page[] {
  const memberships = collectMemberships(assets)
  const groupedIds = new Set([...memberships.values()].flatMap(members => members.map(asset => asset.id)))
  const groupedAssets = assets.filter(asset => groupedIds.has(asset.id))
  const ordinaryAssets = assets.filter(asset => !groupedIds.has(asset.id))

  // Keep the two layout regimes independent. Product groups use compact shared
  // detail panels, while ordinary assets use the regular automatic column
  // calculation. Mixing them in one reflow section lets the widest product
  // group dictate every ordinary cell width and collapses those pages to one
  // vertical column.
  const groupedPages = groupedAssets.length ? paginateGroupedAssets(groupedAssets, bounds, configs) : []
  const backfilled = groupedPages.length ? backfillOrdinaryAssets(groupedPages, ordinaryAssets, bounds, configs) : { pages: [], remainingAssets: ordinaryAssets }
  const ordinaryPages = backfilled.remainingAssets.length ? paginateAutomaticAssets(backfilled.remainingAssets, 1000, bounds, configs) : []
  return renumberPages([...backfilled.pages, ...ordinaryPages])
}
