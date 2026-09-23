import { defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, normalizeLayoutBounds, PAPER_HEIGHT, PAPER_WIDTH, type Asset, type Item, type LayoutBounds, type Page } from '../../../model.ts'
import { detailsForAsset } from '../services/assetDetailsService.ts'
import { dimensionForItem, physicalSourceSize } from '../services/imageDimensionService.ts'
import { backLayerSvg } from '../services/svgBackLayerService.ts'
import { backfillPages } from './backfillPages.ts'
import { fillFreeRegions } from './freeRegionPacking.ts'
import { imageDetailsLayout, sizeLabelWidth } from '../services/imageDetailsLayoutService.ts'
import type { ProductConfig } from '../services/productConfigService.ts'
import type { ImageGroup } from '../layoutTypes.ts'

type Kind = 'ordinary' | 'holder' | 'standee' | 'chain'
type Cell = { asset: Asset; x: number; y: number; width: number; height: number; caption?: string; back?: boolean; ruler?: boolean; base?: boolean }
type Unit = { assets: Asset[]; kind: Kind }
const GAP = GROUP_GAP
export function productLayoutKind(asset: Asset): Kind {
  const name = `${asset.productName ?? ''} ${asset.productId}`.toLowerCase()
  if (/photocard holders|照片夹|shaker|摇摇乐/.test(name)) return 'holder'
  if (/standees|立牌/.test(name)) return 'standee'
  if (/串串|串联|串連|chained|linked charm|connecting charm/.test(name)) return 'chain'
  return 'ordinary'
}
export function isDifferentDesign(asset: Asset) {
  return Object.values(asset.attributes ?? {}).some(value => /double\s*sided\s*different\s*design|双面不同图/i.test(value))
}
function unitsFor(assets: Asset[]): Unit[] {
  const result: Unit[] = [], groups = new Map<string, Unit>()
  // A free combination may mix ordinary products with a holder/standee/chain.
  // Resolve its layout once for the whole group before collecting any members.
  const groupKinds = new Map<string, Kind>()
  for (const asset of assets) {
    const kind = productLayoutKind(asset)
    if (asset.productGroupId && kind !== 'ordinary' && !groupKinds.has(asset.productGroupId)) {
      groupKinds.set(asset.productGroupId, kind)
    }
  }
  for (const asset of assets) {
    const kind = (asset.productGroupId && groupKinds.get(asset.productGroupId)) || productLayoutKind(asset)
    const id = kind === 'ordinary' && !asset.productGroupId?.startsWith('group-combined-') ? undefined : asset.productGroupId
    let unit = id ? groups.get(id) : undefined
    if (!unit) { unit = { assets: [], kind }; result.push(unit); if (id) groups.set(id, unit) }
    unit.assets.push(asset)
  }
  for (const unit of result) unit.assets.sort((a, b) => (a.productGroupPosition ?? 0) - (b.productGroupPosition ?? 0))
  return result
}

/** Ordinary/same-design chain groups use three columns; different-design chains two; holders one. */
export function paginateThreeColumns(assets: Asset[], bounds: LayoutBounds = defaultLayoutBounds, configs: ProductConfig[] = []): Page[] {
  const area = normalizeLayoutBounds(bounds)
  const width = PAPER_WIDTH - area.left - area.right
  // Reserve Size at the same font size as QT, including after unit switches.
  const minimumDetailsWidth = Math.max(74, ...assets.flatMap(asset => (['mm', 'cm', 'in'] as const).map(rulerUnit => sizeLabelWidth(dimensionForItem(asset, { rulerUnit }).label) + 8)))
  const bottom = PAPER_HEIGHT - area.bottom
  const contentTop = area.top + HEADER_BLOCK_HEIGHT + GAP
  const available = bottom - contentTop
  const pages: Page[] = []
  let page: Page, y = bottom, column = 0, rowHeight = 0
  let headerKey = ''
  const newPage = (columns: number, sectionWidth: number, imageMode: 'photo' | 'front-back', key: string) => {
    page = { id: pages.length + 1, name: `页面 ${pages.length + 1}`, items: [], imageGroups: [], headerBlocks: [{ id: `header-${pages.length + 1}`, x: area.left, y: area.top, width: sectionWidth, auto: true, columns: Array.from({ length: columns }, (_, i) => ({ id: `column-${i}`, imageMode, detailLabel: 'Size/QT/Finish/Accessory' })) }] }
    pages.push(page); headerKey = key; y = contentTop; column = 0; rowHeight = 0
  }
  for (const unit of unitsFor(assets)) {
    const leader = unit.assets[0]
    const shaker = unit.assets.some(asset => /shaker|摇摇乐/i.test(`${asset.productName ?? ''} ${asset.productId}`))
    // The final member of a multi-member standee is a base, not a front/back pair.
    const standeePictures = unit.assets.length > 1 ? unit.assets.slice(0, -1) : unit.assets
    const wideStandee = unit.kind === 'standee' && standeePictures.some(isDifferentDesign)
    const columns = wideStandee || unit.kind === 'holder' ? 1 : unit.kind === 'chain' && unit.assets.some(isDifferentDesign) ? 2 : 3
    // Merge exactly two base slots (including their intervening gap), not half a page.
    const sectionWidth = wideStandee ? 2 * (width - 2 * GAP) / 3 + GAP : width
    const imageMode = unit.kind === 'standee' ? 'front-back' : 'photo'
    const sectionKey = `${columns}:${sectionWidth}:${imageMode}`
    const groupWidth = (sectionWidth - GAP * (columns - 1)) / columns
    const detailWidth = Math.max(minimumDetailsWidth, unit.kind === 'holder' ? Math.min(100, width * 0.24) : 0)
    if (groupWidth - detailWidth < 36) throw new Error('排列区域过窄，无法同时容纳图片和完整 Size，请增大排列区域宽度。')
    const imageWidth = groupWidth - detailWidth
    const cells: Cell[] = []
    let height = 120
    let chainReference: number | undefined
    if (unit.kind === 'holder') {
      // Half an arrangement area includes the header, its gap and the
      // trailing group gap; the artwork itself uses only the remainder.
      height = (bottom - area.top) / 2 - HEADER_BLOCK_HEIGHT - 2 * GAP
      const firstHeight = height * 0.32, secondHeight = height * 0.38
      const hasSavedOrder = unit.assets.some(asset => (asset.productGroupPosition ?? 0) > 0)
      // Saved combination order owns the fixed slots. Legacy names may identify
      // a role, but product attributes such as "Front Side Epoxy" never do.
      const findRole = (name: string) => hasSavedOrder ? undefined
        : unit.assets.find(asset => new RegExp(`\\b${name}\\b`, 'i').test(asset.name))
      const example = findRole('example') ?? unit.assets[0]
      cells.push({ asset: example, x: 0, y: 0, width: imageWidth, height: firstHeight, caption: 'Example' })
      const used = new Set([example.id])
      for (const [index, name] of ['Front', 'Inside', 'Back'].entries()) {
        const named = findRole(name)
        const asset = named && !used.has(named.id) ? named : unit.assets.find(asset => !used.has(asset.id))
        if (!asset || used.has(asset.id)) continue
        used.add(asset.id)
        const roleRowWidth = groupWidth
        cells.push({ asset, x: index * roleRowWidth / 3, y: firstHeight, width: roleRowWidth / 3, height: secondHeight, caption: name, ruler: false })
      }
      const rest = unit.assets.filter(asset => !used.has(asset.id))
      const columns = Math.max(1, Math.min(5, rest.length)), rows = Math.ceil(rest.length / columns)
      rest.forEach((asset, i) => cells.push({ asset, x: i % columns * imageWidth / columns, y: firstHeight + secondHeight + Math.floor(i / columns) * (height - firstHeight - secondHeight) / rows, width: imageWidth / columns, height: (height - firstHeight - secondHeight) / rows }))
    } else {
      const base = unit.kind === 'standee' && unit.assets.length > 1 ? unit.assets.at(-1) : undefined
      const pictures = unit.assets.filter(asset => asset !== base)
      const perRow = 1
      const rows = Math.ceil(pictures.length / perRow)
      const verticalBack = unit.kind === 'ordinary' && pictures.some(isDifferentDesign)
      const cellHeight = verticalBack ? 190 : 120
      height = Math.min(available, Math.max(120, rows * cellHeight))
      const rowH = height / rows
      const chainHasBackColumn = unit.kind === 'chain' && pictures.some(isDifferentDesign)
      // Chain charms often contain source SVGs with very different physical
      // bounds. Use a shared visual scale reference so a front/back pair is
      // always identical, while retaining a small, visible size difference
      // between genuinely different charms. Never enlarge an original asset.
      if (unit.kind === 'chain') {
        const lengths = pictures.map(asset => {
          const physical = physicalSourceSize(asset)
          return Math.max(physical.width, physical.height)
        }).sort((a, b) => a - b)
        // Also cap against the smallest member: wider vertical cells must not
        // let a large charm dominate once horizontal packing no longer limits it.
        chainReference = Math.min(lengths[Math.floor(lengths.length / 2)], lengths[0] * 1.8 / 1.08)
      }
      pictures.forEach((asset, index) => {
        const x = index % perRow * imageWidth / perRow, yy = Math.floor(index / perRow) * rowH
        const w = imageWidth / perRow
        const back = isDifferentDesign(asset)
        if (unit.kind === 'chain') {
          // A member owns one complete row. Reserve consistent front/back
          // columns across the group, even when one member has no back.
          const faceWidth = chainHasBackColumn ? w / 2 : w
          cells.push({ asset, x, y: yy, width: faceWidth, height: rowH })
          if (back) cells.push({ asset, x: x + faceWidth, y: yy, width: faceWidth, height: rowH, back: true, ruler: false })
        } else if (back && unit.kind === 'standee') {
          cells.push({ asset, x, y: yy, width: w / 2, height: rowH }, { asset, x: x + w / 2, y: yy, width: w / 2, height: rowH, back: true, ruler: false })
        } else if (back) {
          cells.push({ asset, x, y: yy, width: w, height: rowH / 2, caption: 'Front' }, { asset, x, y: yy + rowH / 2, width: w, height: rowH / 2, caption: 'Back', back: true, ruler: false })
        } else cells.push({ asset, x, y: yy, width: w, height: rowH })
      })
      // A standee base belongs in the right-hand property area. Reserve the
      // lower part of that panel for it so the size/QT fields stay readable,
      // then let the normal proportional fitting make the base as large as
      // the remaining panel allows.
      if (base) {
        const baseY = height * 0.48
        cells.push({ asset: base, x: imageWidth, y: baseY, width: detailWidth, height: height - baseY, caption: 'base', base: true })
      }
    }
    if (unit.kind === 'chain') {
      // Remove unused row space using the same fit limits as the renderer.
      let nextY = 0
      for (const rowY of [...new Set(cells.map(cell => cell.y))]) {
        const row = cells.filter(cell => cell.y === rowY)
        const compactHeight = Math.max(...row.map(cell => {
          const physical = physicalSourceSize(cell.asset)
          const w = physical.width * PAPER_WIDTH / 210, h = physical.height * PAPER_WIDTH / 210
          const scale = Math.min(1, chainReference! * 1.08 * PAPER_WIDTH / 210 / Math.max(w, h), Math.max(1, cell.width - 18) / w, Math.max(1, cell.height - 19) / h)
          return h * scale + 19
        }))
        for (const cell of row) { cell.y = nextY; cell.height = compactHeight }
        nextY += compactHeight
      }
      const details = { ...detailsForAsset(leader, configs), sizes: unit.assets.map(asset => ({ itemId: `item-${asset.id}`, label: dimensionForItem(asset, {}).label })) }
      const layout = imageDetailsLayout({ id: 'measure', itemIds: [], x: 0, y: 0, width: groupWidth, height: available, detailsX: imageWidth, detailWidth, details })
      const textHeight = Math.max(6, layout.fields.length + 2) * 11 + 8
      const accessoryHeight = details.accessoryImage ? Math.min(72, detailWidth - 12) + (details.accessoryCode ? 14 : 4) : 0
      const noteHeight = layout.noteLines.length * 11 + (details.noteImage ? Math.min(64, detailWidth - 8) : 0)
      height = Math.min(available, Math.max(nextY, textHeight + accessoryHeight + noteHeight))
    }
    const groupDetails = detailsForAsset(leader, configs)
    groupDetails.finish = [...new Set(unit.assets.map(asset => detailsForAsset(asset, configs).finish).filter(Boolean))].join(' / ')
    if (pages.length && headerKey !== sectionKey) {
      if (column) { y += rowHeight + GAP; column = 0; rowHeight = 0 }
      if (y + HEADER_BLOCK_HEIGHT + GAP + height <= bottom) {
        page!.headerBlocks!.push({ id: `header-${pages.length}-${y}`, x: area.left, y, width: sectionWidth, auto: true, detailWidth, columns: Array.from({ length: columns }, (_,i) => ({ id: `column-${y}-${i}`, imageMode, detailLabel: 'Size/QT/Finish/Accessory' })) })
        y += HEADER_BLOCK_HEIGHT + GAP; headerKey = sectionKey
      } else y = bottom
    }
    if (!pages.length || y + height > bottom + 1e-7) newPage(columns, sectionWidth, imageMode, sectionKey)
    page!.headerBlocks!.at(-1)!.detailWidth = detailWidth
    if (height > available + 1e-7) throw new Error('排列区域太小，无法容纳产品组，请增大排列区域。')
    const x = area.left + column * (groupWidth + GAP)
    const standeeHasBase = unit.kind === 'standee' && unit.assets.length > 1
    const group: ImageGroup = { id: `group-${leader.id}`, productGroupId: leader.productGroupId, itemIds: [], x, y, width: groupWidth, height, detailsX: x + imageWidth, detailWidth, details: detailsForAsset(leader, configs), detailsHeight: standeeHasBase ? height * 0.48 : undefined, imageCells: [] }
    group.details = groupDetails
    // The full-width role row starts below Example. Keep all property content
    // in the upper-right panel so accessories/notes cannot cover Back.
    if (unit.kind === 'holder') group.detailsHeight = height * 0.32
    if (unit.kind === 'chain' && group.details) group.details.sizes = unit.assets.map(asset => ({ itemId: `item-${asset.id}`, label: dimensionForItem(asset, {}).label }))
    const verticallyCenterSingleImage = cells.length === 1 && !cells[0].back && !cells[0].caption && unit.kind !== 'chain'
    const photoHolder = unit.kind === 'holder' && !shaker
    const roleCells = photoHolder ? cells.filter(cell => cell.caption).slice(0, 4) : []
    // A common longest edge keeps role artwork visually consistent without
    // distorting aspect ratios or enlarging any source beyond its physical size.
    const roleLongest = Math.min(...roleCells.map(cell => {
      const physical = physicalSourceSize(cell.asset)
      const w = physical.width * PAPER_WIDTH / 210, h = physical.height * PAPER_WIDTH / 210
      const left = w >= h ? 4 : 13
      const bottom = groupDetails.finish && cell.y + cell.height >= height - 0.1 ? 16 : 5
      return Math.max(w, h) * Math.min(1, Math.max(1, cell.width - left - 5) / w, Math.max(1, cell.height - 23 - bottom) / h)
    }))
    cells.forEach(cell => {
      const physical = physicalSourceSize(cell.asset)
      const originalW = physical.width * PAPER_WIDTH / 210, originalH = physical.height * PAPER_WIDTH / 210
      const top = cell.base ? 23 : cell.caption ? 23 : 14
      // Horizontal artwork only needs side arrow clearance. The larger left
      // gutter is reserved for vertical measurement text, not every image.
      const left = cell.base ? 4 : shaker ? 13 : originalW >= originalH ? 4 : 13
      // A lone landscape artwork can use the full image column up to the
      // details boundary; the details renderer already provides text padding.
      const fillSingleLandscape = verticallyCenterSingleImage && originalW > originalH && !shaker && !chainReference
      const right = cell.base ? 4 : fillSingleLandscape ? 0 : 5
      // Front and derived Back share the most restrictive bottom clearance.
      const pairedAtBottom = cells.some(other => other.asset.id === cell.asset.id && other.y + other.height >= height - 0.1)
      const bottomPadding = cell.base ? (groupDetails.finish ? 16 : 5) : groupDetails.finish && pairedAtBottom ? 16 : verticallyCenterSingleImage ? top : 5
      const sourceLongest = Math.max(originalW, originalH)
      const sharedScale = chainReference && sourceLongest > 0
        ? Math.min(1, chainReference * 1.08 * PAPER_WIDTH / 210 / sourceLongest)
        : roleCells.includes(cell) ? Math.min(1, roleLongest / sourceLongest)
        : unit.kind === 'holder' ? 1 : Infinity
      const scale = Math.min(sharedScale, Math.max(1, cell.width - left - right) / originalW, Math.max(1, cell.height - top - bottomPadding) / originalH)
      const w = originalW * scale, h = originalH * scale
      const sourceId = `item-${cell.asset.id}`
      const centerY = verticallyCenterSingleImage
        ? y + cell.y + (cell.height + top - bottomPadding) / 2
        : y + cell.y + top + h / 2
      const item: Item = { id: cell.back ? `${sourceId}-back` : sourceId, assetId: cell.asset.id, x: x + cell.x + left + (cell.width - left - right) / 2, y: centerY, w, h, rotation: 0, caption: cell.caption, captionAlign: cell.base ? 'left' : undefined, captionFontSize: cell.base ? 7 : undefined, mirrorX: cell.back, backSvg: cell.back ? backLayerSvg(cell.asset.svg, unit.kind === 'standee') : undefined, derivedFrom: cell.back ? sourceId : undefined, suppressRuler: cell.ruler === false }
      page!.items.push(item); group.itemIds.push(item.id)
      if (unit.kind === 'holder' && cell.caption && cell.caption !== 'Example') item.x = x + cell.x + cell.width / 2
      group.imageCells!.push({ itemId: item.id, x: x + cell.x, y: y + cell.y, width: cell.width, height: cell.height })
    })
    page!.imageGroups!.push(group)
    rowHeight = Math.max(rowHeight, height)
    column += 1
    if (column >= columns) { y += rowHeight + GAP; column = 0; rowHeight = 0 }
  }
  return fillFreeRegions(backfillPages(pages, area), area)
}



