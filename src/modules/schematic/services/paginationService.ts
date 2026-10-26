import { defaultLayoutBounds, type Asset, type Item, type LayoutBounds, type Page } from '../../../model.ts'
import type { ProductConfig } from './productConfigService.ts'
import { paginateThreeColumns } from '../arrangement/threeColumnLayout.ts'
import { rulerDimensionLabel } from './imageDimensionService.ts'
import { horizontalGroupPages } from './horizontalGroupReflowService.ts'
import { resizeImageGroup } from './groupResizeService.ts'

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
  const groupByAsset = new Map<string, { id: string; position?: number }>()
  for (const page of pages) for (const group of page.imageGroups ?? []) {
    if (group.stacked !== 'vertical' && !(group.layoutMode === 'horizontal' && (group.productGroupId || group.id.startsWith('group-combined-')))) continue
    const itemsById = new Map(page.items.map(item => [item.id, item]))
    const manual = group.id.startsWith('group-combined-')
    const members = new Set<string>()
    for (const id of group.itemIds) {
      const item = itemsById.get(id)
      if (!item || item.derivedFrom || members.has(sourceId(item))) continue
      members.add(sourceId(item))
      groupByAsset.set(sourceId(item), { id: manual ? group.id : group.productGroupId || group.id,
        // Old positions belong to separate source groups and can interleave
        // their members after combining. Manual block order is authoritative.
        ...(manual ? { position: members.size } : {}) })
    }
  }
  const chosen = assets.filter(asset => used.has(asset.id)).map(asset => {
    const group = groupByAsset.get(asset.id)
    return group ? { ...asset, productGroupId: group.id, ...(group.position === undefined ? {} : { productGroupPosition: group.position }) } : asset
  })
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
  const manualGroups = new Map([...previousGroups.values()].filter(({ group }) => group.id.startsWith('group-combined-')).map(previous => [previous.group.id, previous]))
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
      const manual = manualGroups.get(group.productGroupId ?? '')
      // Native role inference can invent a derived Back for an earlier
      // standee base. Match the unchanged originals before restoring the
      // exact saved manual membership, including its existing Back images.
      const originalsKey = (sourcePage: Page, ids: string[]) => membershipKey(sourcePage.items.filter(item => ids.includes(item.id) && !item.derivedFrom).map(item => item.id))
      const previous = previousGroups.get(membershipKey(group.itemIds))
        ?? (manual && originalsKey(manual.page, manual.group.itemIds) === originalsKey(page, group.itemIds) ? manual : undefined)
      if (previous) {
        if (previous.group.id.startsWith('group-combined-')) {
          // The native product layout supplies this block's page/rectangle,
          // but its role inference cannot describe several existing products
          // combined together (for example, two separate standee bases).
          const mappedPage = resizeImageGroup(previous.page, previous.group.id,
            { x: group.x, y: group.y, width: group.width, height: group.height }, bounds, visualScales)
          const mappedGroup = mappedPage.imageGroups!.find(value => value.id === previous.group.id)!
          const mappedItems = new Map(mappedPage.items.filter(value => previous.group.itemIds.includes(value.id)).map(value => [value.id, value]))
          const currentItems = new Map(page.items.map(value => [value.id, value]))
          const members = previous.group.itemIds.map(id => {
            const mapped = mappedItems.get(id)!
            const value = currentItems.get(id) ?? mapped
            return { ...value, x: mapped.x, y: mapped.y, w: mapped.w, h: mapped.h, rotation: mapped.rotation,
              captionAlign: mapped.captionAlign, captionFontSize: mapped.captionFontSize, captionHidden: mapped.captionHidden,
              captionColor: mapped.captionColor, suppressRuler: mapped.suppressRuler, note: mapped.note }
          })
          const generatedIds = new Set(group.itemIds)
          let inserted = false
          page.items = page.items.flatMap(value => {
            if (!generatedIds.has(value.id)) return [value]
            if (inserted) return []
            inserted = true
            return members
          })
          Object.assign(group, mappedGroup, { productGroupId: previous.group.id, manualSize: previous.group.manualSize })
          group.details = mappedGroup.details ? { ...mappedGroup.details } : undefined
          if (label && group.details) group.details.size = label
          group.detailGroups = mappedGroup.detailGroups?.map(panel => {
            const member = page.items.find(value => panel.itemIds.includes(value.id) && !value.derivedFrom)
              ?? page.items.find(value => panel.itemIds.includes(value.id))
            const source = member && assetsById.get(member.assetId)
            const size = member && source ? rulerDimensionLabel(source, member) : undefined
            const sizes = panel.details.sizes?.map(value => {
              const entry = page.items.find(item => item.id === value.itemId)
              const asset = entry && assetsById.get(entry.assetId)
              const label = entry && asset ? rulerDimensionLabel(asset, entry) : undefined
              return label ? { ...value, label } : { ...value }
            })
            return { ...panel, itemIds: [...panel.itemIds], details: { ...panel.details, size: size ?? panel.details.size, ...(sizes ? { sizes } : {}) } }
          })
        }
        group.id = previous.group.id
        if (group.details && previous.group.details?.textOverrides) group.details = { ...group.details, textOverrides: previous.group.details.textOverrides }
        group.detailGroups = group.detailGroups?.map(panel => {
          const original = previous.group.detailGroups?.find(candidate => membershipKey(candidate.itemIds) === membershipKey(panel.itemIds))
          return original?.details.textOverrides ? { ...panel, details: { ...panel.details, textOverrides: original.details.textOverrides } } : panel
        })
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


