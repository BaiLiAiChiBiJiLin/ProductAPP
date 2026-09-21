import { GROUP_GAP, HEADER_BLOCK_HEIGHT, normalizeLayoutBounds, PAPER_HEIGHT, PAPER_WIDTH, sourceAssetSize, type Asset, type HeaderBlock, type HeaderImageMode, type LayoutBounds, type Page, type Item } from '../../../model.ts'
import type { ProductConfig } from './productConfigService.ts'
import { AUTO_DETAIL_LABEL, AUTO_MAX_COLUMNS, AUTO_MIN_DETAIL_WIDTH, detailsForAsset, headerModeForAsset } from './automaticArrangementService.ts'
import { AUTO_ROW_HEIGHT } from './pageLayoutService.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { imageCenterWithDimensionGutter } from './imageDimensionService.ts'
import { placeProductGroup, productGroupFootprint } from '../arrangement/productGroupLayout.ts'
import { packCompactSections } from '../arrangement/compactSectionPacking.ts'

type ReflowUnit = { items: Item[]; group?: ImageGroup; mode: HeaderImageMode; columns?: number; productPlan?: ReturnType<typeof productGroupFootprint> }

function footprint(item: Item) {
  const radians = item.rotation * Math.PI / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  return { width: item.w * cos + item.h * sin, height: item.w * sin + item.h * cos }
}

function unitSize(unit: ReflowUnit): { imageWidth: number; height: number; detailWidth?: number } {
  if (unit.productPlan) return unit.productPlan
  const boxes = unit.items.map(footprint)
  const vertical = unit.group?.stacked === 'vertical'
  return {
    imageWidth: vertical ? Math.max(...boxes.map(box => box.width)) + GROUP_GAP * 2
      : Math.max(...boxes.map(box => box.width + GROUP_GAP * 2)) * boxes.length,
    height: Math.max(AUTO_ROW_HEIGHT, (vertical
      ? boxes.reduce((sum, box) => sum + box.height, 0) + GROUP_GAP * (boxes.length - 1)
      : Math.max(...boxes.map(box => box.height))) + GROUP_GAP * 2),
  }
}

function unitsFromPages(pages: Page[], assets: Map<string, Asset>) {
  const units: ReflowUnit[] = []
  for (const page of pages) {
    const groups = page.imageGroups ?? []
    const byId = new Map(page.items.map(item => [item.id, item]))
    const consumed = new Set<string>()
    for (const item of page.items) {
      if (consumed.has(item.id)) continue
      const group = groups.find(candidate => candidate.itemIds.includes(item.id))
      const items = group ? group.itemIds.map(id => byId.get(id)).filter((candidate): candidate is Item => !!candidate) : [item]
      items.forEach(candidate => consumed.add(candidate.id))
      const asset = assets.get(item.assetId)
      const header = page.headerBlocks?.find(block => block.assetIds?.includes(item.assetId))
      const mode = header?.columns[0]?.imageMode ?? (asset ? headerModeForAsset(asset) : 'front-back')
      units.push({ items, group, mode, columns: header?.columns.length })
    }
  }
  return units
}

function placeUnit(unit: ReflowUnit, x: number, y: number, width: number, height: number, assets: Map<string, Asset>, configs: ProductConfig[]) {
  if (unit.productPlan && unit.group) return placeProductGroup(unit.items, unit.group, x, y, width, height, unit.productPlan.columns, unit.productPlan.detailWidth)
  const boxes = unit.items.map(footprint)
  const vertical = unit.group?.stacked === 'vertical'
  const totalHeight = boxes.reduce((sum, box) => sum + box.height, 0) + GROUP_GAP * (boxes.length - 1)
  let top = y + (height - totalHeight) / 2
  const slotWidth = width / 2 / (vertical ? 1 : unit.items.length)
  const items = unit.items.map((item, index) => {
    const asset = assets.get(item.assetId)
    const source = asset ? sourceAssetSize(asset) : undefined
    const verticalMarker = source ? source.width < source.height : item.w < item.h
    const slot = { x: x + slotWidth * (vertical ? 0 : index), width: slotWidth }
    const next = { ...item, x: imageCenterWithDimensionGutter(slot, boxes[index].width, verticalMarker), y: vertical ? top + boxes[index].height / 2 : y + height / 2 }
    top += boxes[index].height + GROUP_GAP
    return next
  })
  const asset = assets.get(items[0].assetId)
  const group: ImageGroup = {
    ...unit.group, id: unit.group?.id ?? `group-${items[0].id}`, itemIds: items.map(item => item.id), x, y, width, height,
    details: unit.group?.details ?? (asset ? detailsForAsset(asset, configs) : undefined),
  }
  return { items, group }
}

/** Repack current-size groups row by row; combination never invokes image fitting. */
export function reflowAfterCombination(pages: Page[], startIndex: number, assets: Asset[], bounds: LayoutBounds, configs: ProductConfig[]): Page[] {
  const prefix = pages.slice(0, startIndex)
  const source = pages.slice(startIndex)
  const byAsset = new Map(assets.map(asset => [asset.id, asset]))
  const units = unitsFromPages(source, byAsset)
  if (!units.length) return prefix
  const area = normalizeLayoutBounds(bounds)
  const width = PAPER_WIDTH - area.left - area.right
  const bottom = PAPER_HEIGHT - area.bottom
  for (const unit of units) if (unit.group?.productGroupId) {
    // Product groups are complete image-plus-details units. When a mode has
    // multiple groups, first try the width of two row slots so two groups can
    // share a line; large groups can fall back to the full page width when
    // their reduced column count would exceed the available height.
    const sameModeCount = units.filter(candidate => candidate.mode === unit.mode).length
    const sharedRowWidth = sameModeCount > 1 ? (width - GROUP_GAP) / 2 : width
    try {
      unit.productPlan = productGroupFootprint(unit.items, bottom - area.top - HEADER_BLOCK_HEIGHT - GROUP_GAP, unit.group, sharedRowWidth, unit.group.imageColumns)
    } catch (error) {
      if (sharedRowWidth >= width - 1e-7) throw error
      unit.productPlan = productGroupFootprint(unit.items, bottom - area.top - HEADER_BLOCK_HEIGHT - GROUP_GAP, unit.group, width, unit.group.imageColumns)
    }
  }
  const sections = new Map<HeaderImageMode, ReflowUnit[]>()
  for (const unit of units) {
    const section = sections.get(unit.mode) ?? []
    section.push(unit)
    sections.set(unit.mode, section)
  }
  const output: Page[] = []
  let nextId = Math.max(...pages.map(page => page.id)) + 1
  const newPage = (): Page => {
    const index = output.length
    const page = { ...source[index] ?? source.at(-1)!, id: source[index]?.id ?? nextId++, name: `页面 ${startIndex + index + 1}`, items: [], imageGroups: [], headerBlocks: [] }
    output.push(page)
    return page
  }
  if (units.some(unit => unit.productPlan)) {
    const plans = packCompactSections([...sections].map(([key, section]) => ({ key, maxColumns: AUTO_MAX_COLUMNS,
      units: section.map(unit => {
        const size = unitSize(unit)
        const width = unit.productPlan ? size.imageWidth + (size.detailWidth ?? AUTO_MIN_DETAIL_WIDTH) : 2 * Math.max(AUTO_MIN_DETAIL_WIDTH, size.imageWidth)
        return { value: unit, width, height: size.height }
      }),
    })), { x: area.left, y: area.top, width, height: bottom - area.top }, HEADER_BLOCK_HEIGHT, GROUP_GAP)
    for (const sections of plans) {
      const page = newPage()
      for (const section of sections) {
        const mode = section.key as HeaderImageMode
        const compactDetailWidth = Math.max(0, ...section.placements.map(placement => placement.value.productPlan?.detailWidth ?? 0)) || undefined
        const header: HeaderBlock = { id: `auto-reflow-${page.id}-${mode}`, x: section.x, y: section.y, width: section.width, auto: true, assetIds: [],
          detailWidth: compactDetailWidth,
          columns: Array.from({ length: section.columns }, (_, index) => ({ id: `reflow-${page.id}-${mode}-${index}`, imageMode: mode, detailLabel: AUTO_DETAIL_LABEL })) }
        page.headerBlocks!.push(header)
        for (const placement of section.placements) {
          const placed = placeUnit(placement.value, placement.x, placement.y, placement.width, placement.height, byAsset, configs)
          page.items.push(...placed.items)
          page.imageGroups!.push(placed.group)
          header.assetIds!.push(...placed.items.map(item => item.assetId))
        }
      }
    }
    return [...prefix, ...output]
  }
  let page = newPage()
  let y = area.top
  for (const [mode, section] of sections) {
    // Keep the existing table density where possible. Reduce columns only if
    // the current artwork needs wider cells; image dimensions remain untouched.
    const requiredWidth = 2 * Math.max(AUTO_MIN_DETAIL_WIDTH, ...section.map(unit => unitSize(unit).imageWidth))
    const fittingColumns = Math.floor((width + GROUP_GAP + 1e-7) / (requiredWidth + GROUP_GAP))
    if (fittingColumns < 1) throw new Error('组合后的图片宽度超出排列区域，请扩大排列区域。')
    const preferred = section.map(unit => unit.columns).filter((count): count is number => !!count)
    const columns = Math.min(AUTO_MAX_COLUMNS, fittingColumns, preferred.length ? Math.max(...preferred) : section.length)
    const groupWidth = (width - GROUP_GAP * (columns - 1)) / columns
    let pending = [...section]
    while (pending.length) {
      let header: HeaderBlock | undefined
      while (pending.length) {
        const rowTop = y + (header ? 0 : HEADER_BLOCK_HEIGHT + GROUP_GAP)
        const row: ReflowUnit[] = []
        let rowHeight = 0
        for (const unit of pending) {
          const height = Math.max(rowHeight, unitSize(unit).height)
          // A tall stack may need the next page while later ordinary groups
          // still fit this row. Backfill only within the same header mode.
          if (rowTop + height > bottom + 1e-7) continue
          rowHeight = height
          row.push(unit)
          if (row.length === columns) break
        }
        if (!row.length) break
        if (!header) {
          header = { id: `auto-reflow-${page.id}-${mode}`, x: area.left, y, width, auto: true, assetIds: [],
            columns: Array.from({ length: columns }, (_, index) => ({ id: `reflow-${page.id}-${mode}-${index}`, imageMode: mode, detailLabel: AUTO_DETAIL_LABEL })) }
          page.headerBlocks!.push(header)
        }
        for (const [index, unit] of row.entries()) {
          const placed = placeUnit(unit, area.left + index * (groupWidth + GROUP_GAP), rowTop, groupWidth, rowHeight, byAsset, configs)
          page.items.push(...placed.items)
          page.imageGroups!.push(placed.group)
          header.assetIds!.push(...placed.items.map(item => item.assetId))
        }
        y = rowTop + rowHeight + GROUP_GAP
        const placed = new Set(row)
        pending = pending.filter(unit => !placed.has(unit))
      }
      if (!pending.length) break
      if (!page.items.length) throw new Error('组合后的图片高度超出整页排列区域，请扩大排列区域或减少组合图片。')
      page = newPage()
      y = area.top
    }
  }
  return [...prefix, ...output]
}
