import { artworkBounds, defaultLayoutBounds, DETAIL_AREA_RATIO, GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_WIDTH, headerColumnBounds, type Asset, type Item, type LayoutBounds, type Page } from '../../../model.ts'
import { headerFor } from '../arrangement/pageSections.ts'
import type { ArrangementDisplayState } from './arrangementDisplayState.ts'
import { itemForCanvasDisplay } from './canvasDisplayScaleService.ts'
import { imageGroupsForPage } from './groupBackgroundService.ts'
import { selectSvgLayers, svgLayers, withWindowLayerOverlay } from './svgLayerService.ts'

/** Add an editable back placement without regenerating the source or its group. */
export function showBackArtwork(page: Page, itemId: string, asset: Asset, display: ArrangementDisplayState, bounds: LayoutBounds = defaultLayoutBounds) {
  const source = page.items.find(item => item.id === itemId && item.assetId === asset.id)
  if (!source) return undefined
  const layers = svgLayers(asset.svg, asset.sourceImages)
  const covered = new Set<string>()
  const backIds = layers.filter(layer => {
    if (layer.role !== 'back') return false
    const ids = layer.imageNodeIds ?? []
    if (ids.length && ids.every(id => covered.has(id))) return false
    ids.forEach(id => covered.add(id))
    return true
  }).map(layer => layer.id)
  if (!backIds.length) return undefined
  const ids = withWindowLayerOverlay(layers, backIds, asset.sourceImages)
  const sourceId = source.derivedFrom ?? source.id
  // Repeated clicks select the existing back, including automatically arranged
  // backs, rather than stacking indistinguishable copies on top of each other.
  const existing = page.items.find(item => item.assetId === asset.id && item.derivedFrom === sourceId
    && (item.svgLayerIds?.length ? ids.length === item.svgLayerIds.length && ids.every(id => item.svgLayerIds!.includes(id))
      : !item.svgLayerId && item.caption?.toLowerCase() === 'back'))
  if (existing) return { page, display, itemId: existing.id, requiresReflow: false }
  let id = `${sourceId}-back`
  for (let suffix = 2; page.items.some(item => item.id === id); suffix++) id = `${sourceId}-back-${suffix}`
  const scale = display.visualScales.get(source.id) ?? 1
  const visible = itemForCanvasDisplay(source, scale)
  const angle = source.rotation * Math.PI / 180
  const width = Math.abs(Math.cos(angle)) * visible.w + Math.abs(Math.sin(angle)) * visible.h
  const height = Math.abs(Math.sin(angle)) * visible.w + Math.abs(Math.cos(angle)) * visible.h
  const dx = width + GROUP_GAP * 2
  const back: Item = { ...source, id, derivedFrom: sourceId, manualBack: true, x: source.x + dx,
    backSvg: selectSvgLayers(asset.svg, ids), svgLayerIds: ids, svgLayerId: ids.length === 1 ? ids[0] : undefined,
    mirrorX: true, caption: 'Back', captionHidden: false, note: undefined,
    suppressRuler: true, rulerWidth: false, rulerHeight: false }
  const groups = imageGroupsForPage(page)
  let requiresReflow = false
  const shifted = new Set<string>()
  const members = groups.find(group => group.itemIds.includes(source.id))!.itemIds
  const footprint = (item: Item) => {
    const visible = itemForCanvasDisplay(item, item.id === id ? scale : display.visualScales.get(item.id) ?? 1)
    const angle = item.rotation * Math.PI / 180
    const width = Math.abs(Math.cos(angle)) * visible.w + Math.abs(Math.sin(angle)) * visible.h
    const height = Math.abs(Math.sin(angle)) * visible.w + Math.abs(Math.cos(angle)) * visible.h
    return { left: item.x - width / 2, right: item.x + width / 2,
      top: item.y - height / 2 - (item.caption && !item.captionHidden ? 20 : 0), bottom: item.y + height / 2 + (item.note ? 10 : 0) }
  }
  const backBox = footprint(back)
  const sameRow = (item: Item) => footprint(item).bottom > backBox.top - GROUP_GAP && footprint(item).top < backBox.bottom + GROUP_GAP
  // Insert a column next to this image, translating any later columns and the
  // properties panel rather than covering them or resizing existing artwork.
  for (const item of page.items) if (members.includes(item.id) && item.id !== source.id && item.x > source.x && sameRow(item)
    && footprint(item).left < backBox.right + GROUP_GAP) shifted.add(item.id)
  if (shifted.size) for (const item of page.items) if (members.includes(item.id) && item.x > source.x && sameRow(item)) shifted.add(item.id)
  const imageGroups = groups.map(group => {
    if (!group.itemIds.includes(source.id)) return group
    const sourceCell = group.imageCells?.find(cell => cell.itemId === source.id)
    const cell = sourceCell
      ? { ...sourceCell, itemId: id, x: sourceCell.x + dx, label: 'Back' }
      : { itemId: id, x: back.x - width / 2, y: back.y - height / 2, width, height, label: 'Back' }
    const itemIds = [...group.itemIds]
    itemIds.splice(itemIds.indexOf(source.id) + 1, 0, id)
    const footprints = [...page.items.filter(item => members.includes(item.id)), back].map(item => {
      const box = footprint(item)
      return { ...box, right: box.right + (shifted.has(item.id) ? dx : 0) }
    })
    const artworkRight = Math.max(...footprints.map(box => box.right)) + GROUP_GAP
    const hasDetails = Boolean(group.details || group.detailGroups?.length)
    const detailWidth = hasDetails ? group.detailWidth ?? group.width * DETAIL_AREA_RATIO : 0
    const detailsTop = group.y + (group.detailsOffsetY ?? 0)
    const detailsBottom = detailsTop + (group.detailsHeight ?? group.height)
    const detailsX = Math.max(group.detailsX ?? group.x + group.width - detailWidth,
      ...footprints.filter(box => box.bottom > detailsTop && box.top < detailsBottom).map(box => box.right + GROUP_GAP))
    const requiredWidth = Math.max(detailsX + detailWidth, artworkRight) - group.x
    const area = artworkBounds(bounds)
    const fullWidth = PAPER_WIDTH - area.left - area.right
    if (requiredWidth > fullWidth + 1e-6) throw new Error('当前图片大小无法在一行内同时放下正背面，请先缩小图片后再展示背面。')
    const column = (fullWidth - GROUP_GAP * 2) / 3
    const nextWidth = requiredWidth > group.width + 1e-6
      ? [column, column * 2 + GROUP_GAP, fullWidth].find(value => value + 1e-6 >= requiredWidth)!
      : group.width
    requiresReflow = nextWidth > group.width + 1e-6
    return { ...group, width: nextWidth, itemIds, manualSize: requiresReflow || group.manualSize,
      detailWidth: hasDetails ? detailWidth : group.detailWidth, detailsX: hasDetails ? detailsX : group.detailsX,
      imageCells: [...(group.imageCells ?? []).map(cell => shifted.has(cell.itemId) ? { ...cell, x: cell.x + dx } : cell), cell],
      detailGroups: group.detailGroups?.map(panel => panel.itemIds.includes(source.id)
        ? { ...panel, itemIds: [...panel.itemIds, id] } : panel) }
  })
  const items = page.items.map(item => shifted.has(item.id) ? { ...item, x: item.x + dx } : item)
  items.splice(page.items.indexOf(source) + 1, 0, back)
  const annotations = page.annotations?.map(annotation => annotation.kind === 'ruler' && annotation.sourceItemId && shifted.has(annotation.sourceItemId)
    ? { ...annotation, x: annotation.x + dx, x2: annotation.x2 + dx } : annotation)
  let headerBlocks = page.headerBlocks
  if (requiresReflow) {
    const previous = groups.find(group => group.itemIds.includes(source.id))!
    const group = imageGroups.find(group => group.id === previous.id)!
    const header = headerFor(page, previous)
    if (header) {
      const column = headerColumnBounds(header).find(column => source.x >= header.x + column.x && source.x <= header.x + column.x + column.width)?.column ?? header.columns[0]
      const expanded = { ...header, id: `back-header-${group.id}`, x: group.x, y: group.y - HEADER_BLOCK_HEIGHT - GROUP_GAP,
        width: group.width, columns: [{ ...column, span: undefined }], detailWidth: group.detailWidth,
        assetIds: [...new Set(items.filter(item => group.itemIds.includes(item.id)).map(item => item.assetId))] }
      const shared = groups.some(other => other.id !== previous.id && headerFor(page, other)?.id === header.id)
      headerBlocks = [...(page.headerBlocks ?? []).filter(candidate => shared || candidate.id !== header.id), expanded]
    }
  }
  const visualScales = new Map(display.visualScales)
  visualScales.set(id, scale)
  const dimensionDisplayOverrides = new Map(display.dimensionDisplayOverrides)
  const dimensions = dimensionDisplayOverrides.get(source.id)
  if (dimensions) dimensionDisplayOverrides.set(id, { ...dimensions })
  return { page: { ...page, items, imageGroups, annotations, headerBlocks }, display: { ...display, visualScales, dimensionDisplayOverrides }, itemId: id, requiresReflow }
}
