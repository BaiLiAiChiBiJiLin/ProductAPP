import { defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, normalizeLayoutBounds, PAPER_HEIGHT, PAPER_WIDTH, proportionalAssetSizeForAsset, type Asset, type HeaderBlock, type HeaderImageMode, type LayoutBounds, type Page } from '../../../model.ts'
import { detailsForAsset } from './assetDetailsService.ts'
import { buildProductGroupDetails } from '../arrangement/productGroupDetails.ts'
export { detailsForAsset } from './assetDetailsService.ts'
import { arrangePage, AUTO_ROW_HEIGHT } from './pageLayoutService.ts'
import type { ProductConfig } from './productConfigService.ts'

/** Minimum intended image width scale when choosing automatic columns. */
export const AUTO_MIN_IMAGE_SCALE = 0.45
export const AUTO_MAX_COLUMNS = 8
// Includes padding; a smaller details cell makes the fixed labels hard to read.
export const AUTO_MIN_DETAIL_WIDTH = 70
export const AUTO_DETAIL_LABEL = 'Size/QT/Finish/Accessory'

type Section = { key: string; productId: string; productLabel: string; printOption: string; mode: HeaderImageMode; assets: Asset[] }

const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
const attr = (asset: Asset, keys: string[]) => {
  const values = asset.attributes ?? {}
  const wanted = keys.map(normalize)
  const key = Object.keys(values).find(candidate => wanted.includes(normalize(candidate)))
  return key ? String(values[key] ?? '').trim() : ''
}

export function headerModeForAsset(asset: Asset): HeaderImageMode {
  const product = (asset.productName || asset.productId || '').toLowerCase()
  if (product.includes('standees')) return 'front-back'
  const print = normalize(attr(asset, ['Print Option', 'Print', '印刷选项', '印刷']))
  if (print.includes('doublesidedsamedesign') || print.includes('双面同图')) return 'photo'
  if (print.includes('doublesideddifferentdesign') || print.includes('双面不同图')) return 'separate'
  return 'front-back'
}

function productLabel(asset: Asset, configs: ProductConfig[]) {
  return asset.productName || configs.find(config => config.id === asset.productId)?.title || asset.productId || '未命名产品'
}

export function groupAssetsByArrangement(assets: Asset[], configs: ProductConfig[] = []): Section[] {
  // A header describes the visual image mode, so all assets with the same
  // mode belong to one logical section even when product records are
  // interleaved in the upload order. Pagination may split that section later,
  // but it must never create two logical sections with the same header mode.
  const sections: Section[] = []
  const byKey = new Map<string, Section>()
  assets.forEach(asset => {
    const mode = headerModeForAsset(asset)
    const printOption = attr(asset, ['Print Option', 'Print', '印刷选项', '印刷'])
    // Group by the visual header mode. Product identity and print options stay
    // on each asset/detail group, but do not create duplicate visual headers.
    const key = mode
    let section = byKey.get(key)
    if (!section) {
      section = { key, productId: asset.productId, productLabel: productLabel(asset, configs), printOption, mode, assets: [] }
      byKey.set(key, section)
      sections.push(section)
    }
    section.assets.push(asset)
    if (section.productId !== asset.productId) { section.productId = 'multiple'; section.productLabel = '多个产品' }
  })
  return sections
}

function columnsForSection(section: Section, bounds: LayoutBounds) {
  const areaWidth = PAPER_WIDTH - bounds.left - bounds.right
  // Use the same proportional reference size as the items placed on the canvas.
  // SVG coordinate units are not millimetres and must not limit column count.
  const maxWidth = Math.max(1, ...section.assets.map(asset => proportionalAssetSizeForAsset(asset).w))
  const imageSlots = imagesPerColumn(section.mode)
  const requiredImageWidth = (maxWidth * AUTO_MIN_IMAGE_SCALE + GROUP_GAP * 2) * imageSlots
  const requiredGroupWidth = 2 * Math.max(AUTO_MIN_DETAIL_WIDTH, requiredImageWidth)
  const groupCount = Math.ceil(section.assets.length / imageSlots)
  return Math.max(1, Math.min(AUTO_MAX_COLUMNS, groupCount, Math.floor((areaWidth + GROUP_GAP) / (requiredGroupWidth + GROUP_GAP))))
}

function imagesPerColumn(mode: HeaderImageMode) { return mode === 'separate' ? 2 : 1 }

function estimatedSectionHeight(section: Section, bounds: LayoutBounds) {
  const columns = columnsForSection(section, bounds)
  const rows = Math.ceil(section.assets.length / Math.max(1, columns * imagesPerColumn(section.mode)))
  return HEADER_BLOCK_HEIGHT + GROUP_GAP + rows * AUTO_ROW_HEIGHT + rows * GROUP_GAP
}

function headerBlockForSection(section: Section, y: number, bounds: LayoutBounds): HeaderBlock {
  const columns = columnsForSection(section, bounds)
  return {
    id: `auto-header-${section.key.replace(/[^a-z0-9]+/gi, '-')}-${y}`,
    x: bounds.left,
    y,
    width: PAPER_WIDTH - bounds.left - bounds.right,
    auto: true,
    productId: section.productId,
    productLabel: section.productLabel,
    printOption: section.printOption,
    assetIds: section.assets.map(asset => asset.id),
    columns: Array.from({ length: columns }, (_, index) => ({ id: `auto-column-${section.key}-${index}`, imageMode: section.mode, detailLabel: AUTO_DETAIL_LABEL })),
  }
}

/** Recompute generated columns on an existing page; user-edited headers keep their settings. */
export function refreshAutomaticHeaders(page: Page, assets: Asset[], bounds: LayoutBounds): Page {
  const pageAssets = new Set(page.items.map(item => item.assetId))
  const refreshed = page.headerBlocks?.map(block => {
    if (!block.auto) return block
    const matching = assets.filter(asset => pageAssets.has(asset.id) && (block.assetIds
      ? block.assetIds.includes(asset.id)
      : headerModeForAsset(asset) === block.columns[0]?.imageMode))
    if (!matching.length) return block
    const mode = block.columns[0]?.imageMode ?? headerModeForAsset(matching[0])
    const section = groupAssetsByArrangement(matching).find(candidate => candidate.mode === mode) ?? groupAssetsByArrangement(matching)[0]
    const count = columnsForSection(section, { ...bounds, left: block.x, right: PAPER_WIDTH - block.x - block.width })
    return { ...block, assetIds: matching.map(asset => asset.id), columns: Array.from({ length: count }, (_, index) => ({
      id: `${block.id}-column-${index}`, imageMode: section.mode, detailLabel: AUTO_DETAIL_LABEL,
    })) }
  })
  if (!refreshed) return { ...page, headerBlocks: refreshed }
  // Older saved pages may already contain duplicate automatic blocks. Merge
  // those blocks before arranging so re-opening or clicking “自动排列” also
  // repairs the persisted page instead of adding another identical header.
  const merged: HeaderBlock[] = []
  for (const block of refreshed) {
    if (!block.auto) { merged.push(block); continue }
    const mode = block.columns[0]?.imageMode
    const existing = merged.find(candidate => candidate.auto && candidate.columns[0]?.imageMode === mode)
    if (!existing) { merged.push(block); continue }
    existing.assetIds = Array.from(new Set([...(existing.assetIds ?? []), ...(block.assetIds ?? [])]))
    if (existing.productId !== block.productId) { existing.productId = 'multiple'; existing.productLabel = '多个产品' }
  }
  return { ...page, headerBlocks: merged }
}

function enrichGroups(page: Page, assets: Asset[], configs: ProductConfig[]) {
  const byItem = new Map(page.items.map(item => [item.assetId, assets.find(asset => asset.id === item.assetId)]))
  return { ...page, imageGroups: (page.imageGroups ?? []).map(group => {
    const asset = group.itemIds.map(id => page.items.find(item => item.id === id)).map(item => item && byItem.get(item.assetId)).find(Boolean)
    return asset ? { ...group, details: detailsForAsset(asset, configs) } : group
  }) }
}

/** Refresh the rendered detail payload without moving any canvas item. */
export function refreshPageAssetDetails(page: Page, assets: Asset[], configs: ProductConfig[] = []): Page {
  const byAsset = new Map(assets.map(asset => [asset.id, asset]))
  const byItem = new Map(page.items.map(item => [item.id, byAsset.get(item.assetId)]))
  return {
    ...page,
    imageGroups: (page.imageGroups ?? []).map(group => {
      const groupItems = group.itemIds.map(id => {
        const asset = byItem.get(id)
        const item = page.items.find(candidate => candidate.id === id)
        return asset && item ? { asset, item } : undefined
      }).filter((value): value is { asset: Asset; item: Page['items'][number] } => Boolean(value))
      if (!groupItems.length) return group
      if (group.detailGroups?.length) {
        const detailGroups = buildProductGroupDetails(groupItems.map(value => value.item), byAsset, configs)
        return { ...group, detailGroups, details: detailGroups[0]?.details }
      }
      return { ...group, details: detailsForAsset(groupItems[0].asset, configs) }
    }),
  }
}

/** Fill available cells in order using the same row height as canvas placement. */
export function paginateAutomaticAssets(assets: Asset[], pageSize = 12, bounds: LayoutBounds = defaultLayoutBounds, configs: ProductConfig[] = []): Page[] {
  if (!assets.length) return []
  const area = normalizeLayoutBounds(bounds)
  const sections = groupAssetsByArrangement(assets, configs)
  const availableHeight = PAPER_HEIGHT - area.top - area.bottom
  const itemLimit = Math.max(1, Math.floor(pageSize) || 1)
  const pages: Page[] = []
  let sectionIndex = 0
  let assetOffset = 0
  let pageId = 1
  while (sectionIndex < sections.length) {
    const pageSections: Section[] = []
    let count = 0
    let height = 0
    while (sectionIndex < sections.length) {
      const source = sections[sectionIndex]
      const remaining = source.assets.slice(assetOffset)
      const roomForItems = Math.max(0, itemLimit - count)
      if (!remaining.length || !roomForItems) break
      // Find the largest prefix that fits the free height on this page. This
      // lets a following section use spare rows instead of moving the whole
      // section to the next page and producing uneven density.
      let fitting = 0
      for (let candidate = 1; candidate <= Math.min(roomForItems, remaining.length); candidate++) {
        const candidateHeight = estimatedSectionHeight({ ...source, assets: remaining.slice(0, candidate) }, area)
        if (height + candidateHeight <= availableHeight) fitting = candidate
      }
      // Keep the largest fitting prefix. Consistent row height provides stable
      // density; equalizing image counts would leave otherwise usable cells empty.
      if (!fitting) {
        // Start the section on a new page when the current page has content.
        // Keep one item on an otherwise empty page so the layout service can
        // report its precise capacity error instead of looping forever.
        if (pageSections.length) break
        fitting = 1
      }
      const chunk = { ...source, assets: remaining.slice(0, fitting) }
      pageSections.push(chunk)
      count += fitting
      height += estimatedSectionHeight(chunk, area)
      assetOffset += fitting
      if (assetOffset >= source.assets.length) { sectionIndex += 1; assetOffset = 0 }
      // A remaining part of the same logical section must continue on the
      // next page; adding it here would render a second identical header.
      if (assetOffset > 0) break
      if (count >= itemLimit) break
    }
    const pageAssets = pageSections.flatMap(section => section.assets)
    const items = pageAssets.map((asset, index) => ({ id: `${asset.id}-${index}`, assetId: asset.id, x: 0, y: 0, rotation: 0, ...proportionalAssetSizeForAsset(asset) }))
    let y = area.top
    const headerBlocks = pageSections.map(section => {
      const block = headerBlockForSection(section, y, area)
      y += estimatedSectionHeight(section, area)
      return block
    })
    const arranged = arrangePage({ id: pageId, name: `页面 ${pageId}`, headerBlocks, items }, area)
    pages.push(enrichGroups(arranged, pageAssets, configs))
    pageId += 1
  }
  return pages
}

