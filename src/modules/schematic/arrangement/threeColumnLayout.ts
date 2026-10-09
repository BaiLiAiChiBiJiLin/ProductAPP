import { defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, normalizeLayoutBounds, PAPER_HEIGHT, PAPER_WIDTH, type Asset, type Item, type LayoutBounds, type Page } from '../../../model.ts'
import { cleanFinishLabel, detailsForAsset } from '../services/assetDetailsService.ts'
import { dimensionForItem, physicalSourceSize } from '../services/imageDimensionService.ts'
import { backLayerSvg } from '../services/svgBackLayerService.ts'
import { backfillPages } from './backfillPages.ts'
import { fillFreeRegions } from './freeRegionPacking.ts'
import { applyPhysicalImageScale } from './physicalImageSizing.ts'
import { imageDetailsLayout, sizeLabelWidth } from '../services/imageDetailsLayoutService.ts'
import type { ProductConfig } from '../services/productConfigService.ts'
import type { ImageGroup } from '../layoutTypes.ts'

type Kind = 'ordinary' | 'holder' | 'standee' | 'chain'
type Cell = { asset: Asset; x: number; y: number; width: number; height: number; caption?: string; note?: string; back?: boolean; ruler?: boolean; base?: boolean }
type Unit = { assets: Asset[]; kind: Kind }
const GAP = GROUP_GAP

/**
 * Chain assets can have a source viewport whose aspect ratio includes extra
 * transparent space.  Keep that SVG aspect ratio for rendering, but use the
 * measured source longest edge as the physical scale.  Falling back to the
 * raw CSS-pixel size in this case is what makes two similarly-sized chain
 * charms render at visibly different scales.
 */
function chainSourceSize(asset: Asset) {
  const sourceWidth = Number(asset.sourceGroupWidthMm)
  const sourceHeight = Number(asset.sourceGroupHeightMm)
  const rawWidth = Number(asset.width) * 25.4 / 96
  const rawHeight = Number(asset.height) * 25.4 / 96
  const rawLongest = Math.max(rawWidth, rawHeight)
  const sourceLongest = Math.max(sourceWidth, sourceHeight)
  if (sourceWidth > 0 && sourceHeight > 0 && rawLongest > 0 && Number.isFinite(sourceLongest)) {
    const factor = sourceLongest / rawLongest
    return { width: rawWidth * factor, height: rawHeight * factor }
  }
  return physicalSourceSize(asset)
}

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

function productKey(asset: Asset) {
  const name = String(asset.productName ?? '').trim().toLowerCase()
  const id = String(asset.productId ?? '').trim().toLowerCase()
  return name || id || 'unassigned'
}

function standeeSpan(unit: Unit) {
  const pictures = unit.assets.length > 1 ? unit.assets.slice(0, -1) : unit.assets
  return pictures.some(isDifferentDesign) ? 2 : 1
}

/** Plan complete standee rows so mixed column widths share a header and a page. */
function planStandeeRows(units: Unit[], height: number) {
  const plans = new Map<Unit, { spans: number[]; height: number }>()
  let row: Unit[] = []
  const finish = () => {
    if (!row.length) return
    const spans = row.map(standeeSpan)
    // Homogeneous single-column sections retain their existing three-column header.
    if (spans.every(span => span === 1)) while (spans.length < 3) spans.push(1)
    const plan = { spans, height }
    row.forEach(unit => plans.set(unit, plan))
    row = []
  }
  for (const unit of units) {
    if (unit.kind !== 'standee') { finish(); continue }
    if (row.length && (productKey(row[0].assets[0]) !== productKey(unit.assets[0])
      || row[0].assets.some(isStickerProduct) !== unit.assets.some(isStickerProduct)
      || row.reduce((sum, member) => sum + standeeSpan(member), 0) + standeeSpan(unit) > 3)) finish()
    row.push(unit)
  }
  finish()
  return plans
}

export function isStickerProduct(asset: Asset) {
  return /stickers?|贴纸/i.test(`${asset.productName ?? ''} ${asset.productId ?? ''}`)
}

export function isProtectedProductKey(key?: string) {
  return Boolean(key && /stickers?|贴纸/i.test(key))
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
  let rowProductKey: string | undefined
  let headerKey = ''
  const newPage = (spans: number[], sectionWidth: number, imageMode: 'photo' | 'front-back', key: string) => {
    page = { id: pages.length + 1, name: `页面 ${pages.length + 1}`, items: [], imageGroups: [], headerBlocks: [{ id: `header-${pages.length + 1}`, x: area.left, y: area.top, width: sectionWidth, auto: true, columns: spans.map((span, i) => ({ id: `column-${i}`, span, imageMode, detailLabel: 'Size/QT/Finish/Accessory' })) }] }
    pages.push(page); headerKey = key; y = contentTop; column = 0; rowHeight = 0
  }
  const units = unitsFor(assets)
  const standeeRows = planStandeeRows(units, (bottom - area.top) / 3)
  for (const unit of units) {
    const leader = unit.assets[0]
    const shaker = unit.assets.some(asset => /shaker|摇摇乐/i.test(`${asset.productName ?? ''} ${asset.productId}`))
    const stickerUnit = unit.assets.some(isStickerProduct)
    const standeeRow = standeeRows.get(unit)
    const spans = standeeRow?.spans ?? Array<number>(unit.kind === 'holder' ? 1 : unit.kind === 'chain' && unit.assets.some(isDifferentDesign) ? 2 : 3).fill(1)
    const columns = spans.length
    const totalSpan = spans.reduce((sum, span) => sum + span, 0)
    // One- and two-slot standees can share the same three-slot row.
    const sectionWidth = standeeRow ? totalSpan * (width - 2 * GAP) / 3 + (totalSpan - 1) * GAP : width
    const slotWidth = (sectionWidth - GAP * (totalSpan - 1)) / totalSpan
    const imageMode = unit.kind === 'standee' ? 'front-back' : 'photo'
    const sectionKey = `${spans.join(',')}:${sectionWidth}:${imageMode}`
    const currentProductKey = productKey(leader)
    // A sticker page intentionally keeps its unused cells open.  The old
    // protection only ran during backfill, so the first pass could append the
    // next product into the remaining rows of that same page.  Start a new
    // page whenever the sticker/non-sticker boundary changes in either
    // direction; sticker units can still share their own page.
    const currentPage = pages.at(-1)
    const pageHasSticker = Boolean(currentPage?.imageGroups?.some(group => group.protectPageFill))
    const pageHasNonSticker = Boolean(currentPage?.imageGroups?.some(group => !group.protectPageFill))
    if (pages.length && ((stickerUnit && pageHasNonSticker) || (!stickerUnit && pageHasSticker))) {
      y = bottom
      column = 0
      rowHeight = 0
      rowProductKey = undefined
      headerKey = ''
    }
    if (column > 0 && headerKey === sectionKey && rowProductKey && rowProductKey !== currentProductKey) {
      // A product row is intentionally allowed to end with unused columns.
      // Mark its existing groups so later free-space passes cannot pull a
      // different product into the remaining cells.
      pages.at(-1)?.imageGroups?.forEach(group => {
        if (Math.abs(group.y - y) <= 1e-7) group.preventRowFill = true
      })
      y += rowHeight + GAP
      column = 0
      rowHeight = 0
      rowProductKey = undefined
    }
    const span = standeeRow ? standeeSpan(unit) : 1
    const groupWidth = slotWidth * span + GAP * (span - 1)
    const detailWidth = Math.max(minimumDetailsWidth, unit.kind === 'holder' ? Math.min(100, width * 0.24) : 0)
    if (groupWidth - detailWidth < 36) throw new Error('排列区域过窄，无法同时容纳图片和完整 Size，请增大排列区域宽度。')
    const imageWidth = groupWidth - detailWidth
    const cells: Cell[] = []
    let height = 120
    let chainTargetLongest: number | undefined
    let chainScaleCap = 1
    let chainNearEqual = false
    let holderPortraitRoles = false
    let emptyExampleMerged = false
    if (unit.kind === 'holder') {
      // Half an arrangement area includes the header, its gap and the
      // trailing group gap; the artwork itself uses only the remainder.
      height = (bottom - area.top) / 2 - HEADER_BLOCK_HEIGHT - 2 * GAP
      const firstHeight = height * 0.32, secondHeight = height * 0.38
      const hasSavedOrder = unit.assets.some(asset => (asset.productGroupPosition ?? 0) > 0)
      const emptyExample = hasSavedOrder
        && !unit.assets.some(asset => (asset.productGroupPosition ?? 0) === 1)
        && unit.assets.some(asset => (asset.productGroupPosition ?? 0) >= 2)
      // Saved combination order owns the fixed slots. Legacy names may identify
      // a role, but product attributes such as "Front Side Epoxy" never do.
      const findRole = (name: string) => hasSavedOrder ? undefined
        : unit.assets.find(asset => new RegExp(`\\b${name}\\b`, 'i').test(asset.name))
      const example = emptyExample ? undefined : findRole('example') ?? unit.assets[0]
      const roleAssets: Array<{ asset: Asset; caption: string }> = example ? [{ asset: example, caption: 'Example' }] : []
      const used = new Set(example ? [example.id] : [])
      for (const name of ['Front', 'Inside', 'Back']) {
        const named = findRole(name)
        const asset = named && !used.has(named.id) ? named : unit.assets.find(asset => !used.has(asset.id))
        if (!asset || used.has(asset.id)) continue
        used.add(asset.id)
        roleAssets.push({ asset, caption: name })
      }
      const rest = unit.assets.filter(asset => !used.has(asset.id))
      const portraitRoles = !emptyExample && roleAssets.length === 4 && roleAssets.every(({ asset }) => {
        const physical = physicalSourceSize(asset)
        return physical.height > physical.width
      })
      holderPortraitRoles = portraitRoles
      if (emptyExample) {
        // When Example is intentionally empty, use that top area for the
        // actual Front/Inside/Back artwork. The three roles share only the
        // image area; the details column remains reserved on the right.
        emptyExampleMerged = true
        const roleHeight = height * 0.48
        roleAssets.forEach(({ asset, caption }, index) => cells.push({
          asset, x: index * imageWidth / 3, y: 0, width: imageWidth / 3, height: roleHeight,
          caption, note: asset.note?.trim() || undefined, ruler: caption === 'Front',
        }))
        const columns = Math.max(1, Math.min(5, rest.length)), rows = Math.ceil(rest.length / columns)
        rest.forEach((asset, i) => cells.push({ asset, x: i % columns * imageWidth / columns, y: roleHeight + Math.floor(i / columns) * (height - roleHeight) / rows, width: imageWidth / columns, height: (height - roleHeight) / rows, note: asset.note?.trim() || undefined }))
      } else if (portraitRoles) {
        const roleHeight = height * 0.48
        roleAssets.forEach(({ asset, caption }, index) => cells.push({ asset, x: index * imageWidth / 4, y: 0, width: imageWidth / 4, height: roleHeight, caption, note: asset.note?.trim() || undefined, ruler: caption === 'Example' }))
        const columns = Math.max(1, Math.min(5, rest.length)), rows = Math.ceil(rest.length / columns)
        rest.forEach((asset, i) => cells.push({ asset, x: i % columns * imageWidth / columns, y: roleHeight + Math.floor(i / columns) * (height - roleHeight) / rows, width: imageWidth / columns, height: (height - roleHeight) / rows, note: asset.note?.trim() || undefined }))
      } else {
        if (example) cells.push({ asset: example, x: 0, y: 0, width: imageWidth, height: firstHeight, caption: 'Example', note: example.note?.trim() || undefined })
        roleAssets.slice(1).forEach(({ asset, caption }, index) => cells.push({ asset, x: index * groupWidth / 3, y: firstHeight, width: groupWidth / 3, height: secondHeight, caption, note: asset.note?.trim() || undefined, ruler: false }))
        const columns = Math.max(1, Math.min(5, rest.length)), rows = Math.ceil(rest.length / columns)
        rest.forEach((asset, i) => cells.push({ asset, x: i % columns * imageWidth / columns, y: firstHeight + secondHeight + Math.floor(i / columns) * (height - firstHeight - secondHeight) / rows, width: imageWidth / columns, height: (height - firstHeight - secondHeight) / rows, note: asset.note?.trim() || undefined }))
      }
    } else {
      const base = unit.kind === 'standee' && unit.assets.length > 1 ? unit.assets.at(-1) : undefined
      const pictures = unit.assets.filter(asset => asset !== base)
      const perRow = 1
      const rows = Math.ceil(pictures.length / perRow)
      const verticalBack = unit.kind === 'ordinary' && pictures.some(isDifferentDesign)
      const cellHeight = verticalBack ? 190 : 120
      // Standee content rows occupy exactly one third of the arrangement
      // frame. Extra page space must not stretch their cells afterward.
      height = standeeRow?.height ?? Math.min(available, Math.max(120, rows * cellHeight))
      const rowH = height / rows
      const chainHasBackColumn = unit.kind === 'chain' && pictures.some(isDifferentDesign)
      // Chain charms often contain source SVGs with very different physical
      // bounds. Use a shared visual scale reference so a front/back pair is
      // always identical. Near-equal members use one common longest edge;
      // genuinely different charms retain a small, visible size difference.
      if (unit.kind === 'chain') {
        const lengths = pictures.map(asset => {
          const physical = chainSourceSize(asset)
          return Math.max(physical.width, physical.height)
        }).sort((a, b) => a - b)
        if (lengths.length) {
          const smallest = lengths[0]
          const largest = lengths[lengths.length - 1]
          // Members that are already close in real size should share one
          // visual longest edge.  Previously every member stayed at 100% when
          // it was below the median target, which made near-identical charms
          // look different simply because their source boxes were a few pixels
          // apart.  Limit the enlargement to this near-equal case only.
          chainNearEqual = smallest > 0 && largest / smallest <= 1.12
          chainTargetLongest = chainNearEqual
            ? largest * PAPER_WIDTH / 210
            // For genuinely different sizes, keep the existing conservative
            // normalization and never enlarge a source artwork.
            : Math.min(lengths[Math.floor(lengths.length / 2)], smallest * 1.8 / 1.08) * 1.08 * PAPER_WIDTH / 210
          chainScaleCap = chainNearEqual ? largest / smallest : 1
        }
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
      if (unit.kind === 'chain' && chainNearEqual && chainTargetLongest) {
        // The available face width can be more restrictive for a square
        // charm than for a tall one. Use the smallest per-member drawable
        // longest edge as the common target so aspect ratio does not turn
        // into a visible size difference after fitting.
        const fitLongest = Math.min(...cells.filter(cell => !cell.back).map(cell => {
          const physical = chainSourceSize(cell.asset)
          const w = physical.width * PAPER_WIDTH / 210
          const h = physical.height * PAPER_WIDTH / 210
          const fit = Math.min(Math.max(1, cell.width - 18) / w, Math.max(1, cell.height - 19) / h)
          return Math.max(w, h) * Math.max(0, fit)
        }))
        chainTargetLongest = Math.min(chainTargetLongest, fitLongest)
        const smallestLongest = Math.min(...pictures.map(asset => {
          const physical = chainSourceSize(asset)
          return Math.max(physical.width, physical.height) * PAPER_WIDTH / 210
        }))
        chainScaleCap = Math.min(chainScaleCap, chainTargetLongest / smallestLongest)
      }
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
          const physical = chainSourceSize(cell.asset)
          const w = physical.width * PAPER_WIDTH / 210, h = physical.height * PAPER_WIDTH / 210
          const scale = Math.min(chainScaleCap, chainTargetLongest! / Math.max(w, h), Math.max(1, cell.width - 18) / w, Math.max(1, cell.height - 19) / h)
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
    groupDetails.finish = [...new Set(unit.assets.map(asset => cleanFinishLabel(detailsForAsset(asset, configs).finish)).filter(value => value && !/^\d+(?:\.\d+)?$/.test(value)))].join(' / ')
    const requiredHeight = standeeRow?.height ?? height
    if (pages.length && headerKey !== sectionKey) {
      if (column) { y += rowHeight + GAP; column = 0; rowHeight = 0; rowProductKey = undefined }
      if (y + HEADER_BLOCK_HEIGHT + GAP + requiredHeight <= bottom) {
        page!.headerBlocks!.push({ id: `header-${pages.length}-${y}`, x: area.left, y, width: sectionWidth, auto: true, detailWidth, columns: spans.map((span,i) => ({ id: `column-${y}-${i}`, span, imageMode, detailLabel: 'Size/QT/Finish/Accessory' })) })
        y += HEADER_BLOCK_HEIGHT + GAP; headerKey = sectionKey
      } else y = bottom
    }
    if (!pages.length || y + requiredHeight > bottom + 1e-7) {
      newPage(spans, sectionWidth, imageMode, sectionKey)
      rowProductKey = undefined
    }
    page!.headerBlocks!.at(-1)!.detailWidth = detailWidth
    if (height > available + 1e-7) throw new Error('排列区域太小，无法容纳产品组，请增大排列区域。')
    const x = area.left + spans.slice(0, column).reduce((sum, span) => sum + span, 0) * (slotWidth + GAP)
    const standeeHasBase = unit.kind === 'standee' && unit.assets.length > 1
    const protectPageFill = unit.assets.some(isStickerProduct)
    const group: ImageGroup = { id: `group-${leader.id}`, productGroupId: leader.productGroupId, productKey: currentProductKey, itemIds: [], x, y, width: groupWidth, height, detailsX: x + imageWidth, detailWidth, details: detailsForAsset(leader, configs), detailsHeight: standeeHasBase ? height * 0.48 : undefined, imageCells: [], emptyExample: emptyExampleMerged, emptyExampleMerged, preventRowFill: protectPageFill, protectPageFill }
    group.details = groupDetails
    // The full-width role row starts below Example. Keep all property content
    // in the upper-right panel so accessories/notes cannot cover Back.
    if (unit.kind === 'holder') group.detailsHeight = holderPortraitRoles ? height : height * 0.32
    if (unit.kind === 'chain' && group.details) group.details.sizes = unit.assets.map(asset => ({ itemId: `item-${asset.id}`, label: dimensionForItem(asset, {}).label }))
    const verticallyCenterSingleImage = cells.length === 1 && !cells[0].back && !cells[0].caption && unit.kind !== 'chain'
    const roleCells = emptyExampleMerged
      ? cells.filter(cell => cell.caption && ['Front', 'Inside', 'Back'].includes(cell.caption)).slice(0, 3)
      : unit.kind === 'holder' ? cells.filter(cell => cell.caption).slice(0, 4) : []
    // A common longest edge keeps role artwork visually consistent without
    // distorting aspect ratios or enlarging any source beyond its physical size.
    const roleLongest = Math.min(...roleCells.map(cell => {
      const physical = physicalSourceSize(cell.asset)
      const w = physical.width * PAPER_WIDTH / 210, h = physical.height * PAPER_WIDTH / 210
      const left = w >= h ? 4 : 13
      const bottom = (groupDetails.finish && cell.y + cell.height >= height - 0.1 ? 16 : 5) + (cell.note ? 13 : 0)
      return Math.max(w, h) * Math.min(emptyExampleMerged || holderPortraitRoles ? Infinity : 1, Math.max(1, cell.width - left - 5) / w, Math.max(1, cell.height - 23 - bottom) / h)
    }))
    // The first four holder/shaker images establish the group's visual scale.
    // Later images may exceed it only when their real source artwork is larger.
    const roleSourceLongest = roleCells.length ? Math.max(...roleCells.map(cell => {
      const physical = physicalSourceSize(cell.asset)
      return Math.max(physical.width, physical.height) * PAPER_WIDTH / 210
    })) : 0
    const roleVisualLongest = roleCells.length ? Math.max(...roleCells.map(cell => {
      const physical = physicalSourceSize(cell.asset)
      return Math.min(Math.max(physical.width, physical.height) * PAPER_WIDTH / 210, roleLongest)
    })) : 0
    cells.forEach(cell => {
      const physical = unit.kind === 'chain' ? chainSourceSize(cell.asset) : physicalSourceSize(cell.asset)
      const originalW = physical.width * PAPER_WIDTH / 210, originalH = physical.height * PAPER_WIDTH / 210
      // Keep role captions safely inside the group; the artwork still uses
      // the enlarged upper-half row and is fitted independently below it.
      const top = cell.base ? 23 : cell.caption ? 23 : 14
      // Horizontal artwork only needs side arrow clearance. The larger left
      // gutter is reserved for vertical measurement text, not every image.
      const left = cell.base ? 4 : shaker ? 13 : originalW >= originalH ? 4 : 13
      // A lone landscape artwork can use the full image column up to the
      // details boundary; the details renderer already provides text padding.
      const fillSingleLandscape = verticallyCenterSingleImage && originalW > originalH && !shaker && !chainTargetLongest
      const right = cell.base ? 4 : fillSingleLandscape ? 0 : 5
      // Front and derived Back share the most restrictive bottom clearance.
      const pairedAtBottom = cells.some(other => other.asset.id === cell.asset.id && other.y + other.height >= height - 0.1)
      const notePadding = cell.note ? 13 : 0
      const bottomPadding = cell.base ? (groupDetails.finish ? 16 : 5) : groupDetails.finish && pairedAtBottom ? 16 : verticallyCenterSingleImage ? top : 5 + notePadding
      const sourceLongest = Math.max(originalW, originalH)
      const holderExtraCap = unit.kind === 'holder' && roleCells.length && !roleCells.includes(cell)
        && sourceLongest <= roleSourceLongest + 1e-7 && roleVisualLongest > 0
        ? roleVisualLongest / sourceLongest
        : Infinity
      const sharedScale = chainTargetLongest && sourceLongest > 0
        ? Math.min(chainScaleCap, chainTargetLongest / sourceLongest)
        : roleCells.includes(cell) ? emptyExampleMerged ? Infinity : Math.min(holderPortraitRoles ? Infinity : 1, roleLongest / sourceLongest)
        : unit.kind === 'holder' ? Math.min(1, holderExtraCap) : Infinity
      const scale = Math.min(sharedScale, Math.max(1, cell.width - left - right) / originalW, Math.max(1, cell.height - top - bottomPadding) / originalH)
      const w = originalW * scale, h = originalH * scale
      const sourceId = `item-${cell.asset.id}`
      const centerY = verticallyCenterSingleImage
        ? y + cell.y + (cell.height + top - bottomPadding) / 2
        : y + cell.y + top + h / 2
      const item: Item = { id: cell.back ? `${sourceId}-back` : sourceId, assetId: cell.asset.id, x: x + cell.x + left + (cell.width - left - right) / 2, y: centerY, w, h, rotation: 0, caption: cell.caption, captionAlign: cell.base ? 'left' : undefined, captionFontSize: cell.base ? 7 : undefined, note: cell.note, mirrorX: cell.back, backSvg: cell.back ? backLayerSvg(cell.asset.svg, unit.kind === 'standee') : undefined, derivedFrom: cell.back ? sourceId : undefined, suppressRuler: cell.ruler === false }
      page!.items.push(item); group.itemIds.push(item.id)
      if (unit.kind === 'holder' && cell.caption && (holderPortraitRoles || cell.caption !== 'Example')) item.x = x + cell.x + cell.width / 2
      group.imageCells!.push({ itemId: item.id, x: x + cell.x, y: y + cell.y, width: cell.width, height: cell.height })
    })
    page!.imageGroups!.push(group)
    rowHeight = Math.max(rowHeight, height)
    rowProductKey = currentProductKey
    column += 1
    if (column >= columns) { y += rowHeight + GAP; column = 0; rowHeight = 0; rowProductKey = undefined }
  }
  const arranged = fillFreeRegions(backfillPages(pages, area), area)
  const physicalSizes = new Map(units.flatMap(unit => unit.assets.map(asset => [asset.id,
    unit.kind === 'chain' ? chainSourceSize(asset) : physicalSourceSize(asset)] as const)))
  return applyPhysicalImageScale(arranged, physicalSizes)
}



