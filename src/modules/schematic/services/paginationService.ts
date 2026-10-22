import { defaultLayoutBounds, type Asset, type Item, type LayoutBounds, type Page } from '../../../model.ts'
import type { ProductConfig } from './productConfigService.ts'
import { paginateThreeColumns } from '../arrangement/threeColumnLayout.ts'
import { rulerDimensionLabel } from './imageDimensionService.ts'
import { horizontalGroupPages } from './horizontalGroupReflowService.ts'

/** Follow image identities when regeneration splits, merges, or reorders pages. */
function restorePageEdits(previous: Page[], generated: Page[]) {
  const previousByItem = new Map(previous.flatMap(page => page.items.map(item => [item.id, page] as const)))
  const scores = new Map(generated.map(page => {
    const owners = new Map<Page, number>()
    for (const item of page.items) {
      const owner = previousByItem.get(item.id)
      if (owner) owners.set(owner, (owners.get(owner) ?? 0) + 1)
    }
    return [page, [...owners.entries()].sort((a, b) => b[1] - a[1])]
  }))
  const destinations = new Map<Page, Page>()
  for (const original of previous) {
    const ranked = generated.map(page => ({ page, count: scores.get(page)?.find(([owner]) => owner === original)?.[1] ?? 0 })).sort((a, b) => b.count - a.count)
    if (ranked[0]?.count) destinations.set(original, ranked[0].page)
  }
  const independent = previous.filter(page => page.annotations?.length && !destinations.has(page))
  const usedIds = new Set(independent.map(page => page.id))
  let nextId = Math.max(0, ...previous.map(page => page.id), ...generated.map(page => page.id)) + 1
  for (const page of generated) {
    const owners = scores.get(page) ?? []
    const origin = owners[0]?.[0]
    const identity = owners.find(([owner]) => !usedIds.has(owner.id))?.[0]
    page.id = identity?.id ?? nextId++
    usedIds.add(page.id)
    if (identity) page.name = identity.name
    page.backgroundColor = origin?.backgroundColor
  }
  for (const original of previous) {
    const destination = destinations.get(original)
    if (destination && original.annotations?.length) destination.annotations = [...destination.annotations ?? [], ...original.annotations.map(annotation => ({ ...annotation }))]
  }
  const result = [...generated]
  for (const original of independent) {
    const previousIndex = previous.indexOf(original)
    const preceding = previous.slice(0, previousIndex).reverse().map(page => destinations.get(page) ?? result.find(candidate => candidate.id === page.id)).find(Boolean)
    const index = preceding ? result.indexOf(preceding) + 1 : 0
    const retained = original.items.length ? { ...original, items: [], imageGroups: [], headerBlocks: [] } : original
    result.splice(index, 0, retained)
    destinations.set(original, retained)
  }
  return result
}
export function paginateAssets(assets: Asset[], _pageSize = 12, bounds: LayoutBounds = defaultLayoutBounds, configs: ProductConfig[] = []): Page[] {
  return paginateThreeColumns(assets, bounds, configs)
}
export function autoArrangePages(pages: Page[], _activePage: number, assets: Asset[], bounds: LayoutBounds, configs: ProductConfig[] = [], additionalAssetIds: readonly string[] = [], visualScales?: ReadonlyMap<string, number>): Page[] {
  const previousItems = pages.flatMap(page => page.items)
  const sourceId = (item: Item) => item.arrangementSourceAssetId ?? item.assetId
  const originals = previousItems.filter(item => !item.derivedFrom)
  const used = new Set([...originals.map(sourceId), ...additionalAssetIds])
  const assetsById = new Map(assets.map(asset => [asset.id, asset]))
  const previousByRole = new Map<string, Item[]>()
  const roleKey = (item: Item) => `${sourceId(item)}:${item.derivedFrom ? 'back' : 'front'}`
  for (const item of previousItems) {
    const key = roleKey(item)
    const candidates = previousByRole.get(key) ?? []
    candidates.push(item)
    previousByRole.set(key, candidates)
  }
  const groupByAsset = new Map<string, string>()
  for (const page of pages) for (const group of page.imageGroups ?? []) {
    if (group.stacked !== 'vertical' && !(group.layoutMode === 'horizontal' && (group.productGroupId || group.id.startsWith('group-combined-')))) continue
    for (const item of page.items) if (group.itemIds.includes(item.id)) groupByAsset.set(sourceId(item), group.productGroupId || group.id)
  }
  const chosen = assets.filter(asset => used.has(asset.id)).map(asset => groupByAsset.has(asset.id) ? { ...asset, productGroupId: groupByAsset.get(asset.id) } : asset)
  const result = paginateThreeColumns(chosen, bounds, configs)
  const restoredIds = new Map<string, string>()
  for (const page of result) {
    page.items = page.items.map(item => {
      const candidates = previousByRole.get(roleKey(item))
      if (!candidates?.length) return item
      const exactIndex = candidates.findIndex(candidate => candidate.id === item.id)
      const [previous] = candidates.splice(exactIndex < 0 ? 0 : exactIndex, 1)
      // Replacing a source resource must not invalidate display settings keyed
      // by canvas item ID. Remap generated group references after all pages.
      restoredIds.set(item.id, previous.id)
      const restored = { ...item, id: previous.id, rulerUnit: previous.rulerUnit, rulerWidth: previous.rulerWidth, rulerHeight: previous.rulerHeight, sizeAxis: previous.sizeAxis, rulerWidthRange: previous.rulerWidthRange, rulerHeightRange: previous.rulerHeightRange, rulerWidthMm: previous.rulerWidthMm, rulerHeightMm: previous.rulerHeightMm,
        ...(Object.hasOwn(previous, 'caption') ? { caption: previous.caption } : {}), captionHidden: previous.captionHidden, captionColor: previous.captionColor }
      // Front and Back are independent canvas instances. Restore only explicit
      // artwork edits; unedited backs retain the newly generated default layer.
      if (!previous.arrangementSourceAssetId && previous.svgLayerId === undefined && previous.svgLayerIds === undefined) return restored
      const artwork = assetsById.get(previous.assetId)
      if (!artwork) return restored
      const scale = Math.min(item.w / artwork.width, item.h / artwork.height)
      return {
        ...restored, assetId: previous.assetId, arrangementSourceAssetId: previous.arrangementSourceAssetId,
        backSvg: previous.backSvg, svgLayerId: previous.svgLayerId, svgLayerIds: previous.svgLayerIds, mirrorX: previous.mirrorX,
        ...(previous.arrangementSourceAssetId ? { w: artwork.width * scale, h: artwork.height * scale } : {}),
      }
    })
  }
  const restoreId = (id: string) => restoredIds.get(id) ?? id
  const membershipKey = (ids: readonly string[]) => JSON.stringify([...ids].sort())
  const previousGroups = new Map(pages.flatMap(page => (page.imageGroups ?? []).map(group => [membershipKey(group.itemIds), { group, page }] as const)))
  const horizontalIds: string[] = []
  for (const page of result) {
    page.items = page.items.map(item => item.derivedFrom ? { ...item, derivedFrom: restoreId(item.derivedFrom) } : item)
    for (const group of page.imageGroups ?? []) {
      group.itemIds = group.itemIds.map(restoreId)
      if (group.imageCells) group.imageCells = group.imageCells.map(cell => ({ ...cell, itemId: restoreId(cell.itemId) }))
      for (const panel of group.detailGroups ?? []) {
        panel.itemIds = panel.itemIds.map(restoreId)
        if (panel.details.sizes) panel.details.sizes = panel.details.sizes.map(value => ({ ...value, itemId: restoreId(value.itemId) }))
      }
      if (group.details?.sizes) group.details.sizes = group.details.sizes.map(value => ({ ...value, itemId: restoreId(value.itemId) }))
      const firstMember = page.items.find(item => group.itemIds.includes(item.id))
      if (firstMember && groupByAsset.has(sourceId(firstMember))) group.stacked = 'vertical'
      const item = page.items.find(item => group.itemIds.includes(item.id) && !item.derivedFrom)
      const asset = item && assetsById.get(item.assetId)
      if (group.details?.sizes) group.details.sizes = group.details.sizes.map(value => {
        const member = page.items.find(item => item.id === value.itemId)
        const source = member && assetsById.get(member.assetId)
        const label = member && source ? rulerDimensionLabel(source, member) : undefined
        return label ? { ...value, label } : value
      })
      const label = item && asset ? rulerDimensionLabel(asset, item) : undefined
      if (label && group.details) group.details.size = label
      const previous = previousGroups.get(membershipKey(group.itemIds))
      if (previous) {
        group.id = previous.group.id
        group.backgroundColor = previous.group.backgroundColor ?? previous.page.backgroundColor
        group.layoutMode = previous.group.layoutMode
        group.detailColumns = previous.group.detailColumns
        const previousCells = new Map(previous.group.imageCells?.map(cell => [cell.itemId, cell]))
        const emptyCells = previous.group.imageCells?.filter(cell => !previous.group.itemIds.includes(cell.itemId)) ?? []
        let emptyIndex = 0
        group.imageCells = group.imageCells?.map(cell => {
          const empty = !group.itemIds.includes(cell.itemId)
          const emptyOriginal = empty ? emptyCells[emptyIndex++] : undefined
          const original = previousCells.get(cell.itemId) ?? emptyOriginal
          return original ? { ...cell, ...(empty ? { itemId: original.itemId } : {}), label: original.label, labelColor: original.labelColor } : cell
        })
        if (group.layoutMode === 'horizontal') horizontalIds.push(group.id)
      }
    }
  }
  let restored = restorePageEdits(pages, result)
  for (const id of horizontalIds) {
    const page = restored.find(page => page.imageGroups?.some(group => group.id === id))
    if (page) restored = horizontalGroupPages(restored, page.id, id, bounds, visualScales)
  }
  return restored
}


