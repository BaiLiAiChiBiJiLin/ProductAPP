import { artworkBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT, PAPER_WIDTH, headerColumnBounds, type HeaderBlock, type HeaderColumn, type LayoutBounds, type Page } from '../../../model.ts'
import type { CanvasAnnotation, ImageGroup } from '../layoutTypes.ts'
import { headerFor } from '../arrangement/pageSections.ts'
import { GROUP_BACKGROUND, imageGroupsForPage } from './groupBackgroundService.ts'
import { manualRulerGeometry } from './canvasAnnotationService.ts'

const EPS = 1e-6
type Unit = { source: Page; group: ImageGroup; header?: HeaderBlock; column: HeaderColumn; key: string; annotations: CanvasAnnotation[] }
type Row = { units: Unit[]; width: number; height: number; schema: Unit[] }
const protectedPage = (page: Page) => page.imageGroups?.some(group => group.protectPageFill || /stickers?|贴纸/i.test(group.productKey ?? ''))
const sameColumn = (a: Unit, b: Unit) => Math.abs(a.group.width - b.group.width) < EPS && a.column.imageMode === b.column.imageMode
  && a.column.detailLabel === b.column.detailLabel && a.group.detailWidth === b.group.detailWidth
const compatibleSchemas = (a: Unit[], b: Unit[]) => a[0].key === b[0].key && a.slice(0, Math.min(a.length, b.length)).every((unit, index) => sameColumn(unit, b[index]))
const groupHeight = (group: ImageGroup) => Math.max(group.height, group.backgroundHeight ?? group.height)

function ownerOf(annotation: CanvasAnnotation, units: Unit[]) {
  if (annotation.kind === 'ruler' && annotation.sourceItemId) {
    return units.find(unit => unit.group.itemIds.includes(annotation.sourceItemId!))
  }
  const point = annotation.kind === 'text' ? annotation : { x: (annotation.x + annotation.x2) / 2, y: (annotation.y + annotation.y2) / 2 }
  // Prefer the smallest containing block when a legacy file has overlapping backgrounds.
  const containing = (x: number, y: number) => units.filter(({ group }) => x >= group.x - EPS && x <= group.x + group.width + EPS
    && y >= group.y - EPS && y <= group.y + groupHeight(group) + EPS).sort((a, b) => a.group.width * groupHeight(a.group) - b.group.width * groupHeight(b.group))[0]
  if (annotation.kind === 'text') return containing(point.x, point.y)
  // A hand-drawn dimension line may sit outside its block; its measured baseline
  // is offset in the opposite normal direction from the displayed arrow line.
  const [start, end] = manualRulerGeometry(annotation).extension
  return containing((start[0] + end[0]) / 2, (start[1] + end[1]) / 2) ?? containing(point.x, point.y)
}

function translateAnnotation(annotation: CanvasAnnotation, dx: number, dy: number): CanvasAnnotation {
  return { ...annotation, x: annotation.x + dx, y: annotation.y + dy,
    ...(annotation.kind === 'ruler' ? { x2: annotation.x2 + dx, y2: annotation.y2 + dy } : {}) }
}

/** Fill earlier holes by translating complete existing blocks, never fitting or regenerating artwork. */
export function refreshArrangementPages(pages: Page[], pageId: number, bounds: LayoutBounds): Page[] {
  const start = pages.findIndex(page => page.id === pageId)
  if (start < 0) return pages
  const selected = pages[start]
  const localOnly = protectedPage(selected)
  const eligible = localOnly ? [selected] : pages.slice(start).filter(page => !protectedPage(page))
  const area = artworkBounds(bounds)
  const width = PAPER_WIDTH - area.left - area.right
  const headerTop = area.top + GROUP_GAP
  const bottom = PAPER_HEIGHT - area.bottom
  const headerHeight = HEADER_BLOCK_HEIGHT + GROUP_GAP
  const units: Unit[] = []
  const freeAnnotations = new Map<number, CanvasAnnotation[]>()
  const freeHeaders = new Map<number, HeaderBlock[]>()

  for (const source of eligible) {
    // Capture the visible source geometry once. The preservation flag prevents
    // rendering the new row from changing a block's details or footer geometry.
    const groups = imageGroupsForPage(source).sort((a, b) => a.y - b.y || a.x - b.x)
    const sourceUnits: Unit[] = groups.map(group => {
      const memberAssets = new Set(source.items.filter(item => group.itemIds.includes(item.id)).map(item => item.assetId))
      const header = headerFor({ ...source, headerBlocks: source.headerBlocks?.filter(header => header.assetIds === undefined
        || header.assetIds.some(id => memberAssets.has(id))) }, group)
      const columns = header ? headerColumnBounds(header) : []
      const column = columns.find(column => Math.abs(header!.x + column.x - group.x) < EPS)?.column
        ?? columns.find(column => group.x + group.width / 2 >= header!.x + column.x - EPS && group.x + group.width / 2 <= header!.x + column.x + column.width + EPS)?.column
        ?? header?.columns[0] ?? { id: `refresh-column-${group.id}`, imageMode: 'photo' as const, detailLabel: 'Size/QT/Accessory' }
      return { source, group, header, column, annotations: [],
        key: JSON.stringify([group.productKey ?? '', header?.productId, header?.productLabel, header?.printOption, header?.auto, header?.detailWidth,
          // A headerless block remains headerless; refreshing never creates labels that were intentionally removed.
          Boolean(header)]) }
    })
    for (const annotation of source.annotations ?? []) {
      const owner = ownerOf(annotation, sourceUnits)
      if (owner) owner.annotations.push(annotation)
      else freeAnnotations.set(source.id, [...(freeAnnotations.get(source.id) ?? []), annotation])
    }
    const usedHeaders = new Set(sourceUnits.map(unit => unit.header?.id))
    // Empty membership is explicit: a later refresh must not adopt this free
    // table just because a previously headerless block has moved underneath it.
    freeHeaders.set(source.id, (source.headerBlocks ?? []).filter(header => !usedHeaders.has(header.id) && !header.auto)
      .map(header => ({ ...header, assetIds: [] })))
    units.push(...sourceUnits)
  }
  if (!units.length) return pages

  const rows: Row[] = []
  for (const unit of units) {
    const height = groupHeight(unit.group)
    if (![unit.group.width, height].every(value => Number.isFinite(value) && value > 0)
      || unit.group.width > width + EPS || height + (unit.header ? headerHeight : 0) > bottom - headerTop + EPS) {
      throw new Error('图片块超过排列区域，刷新不会缩放块内内容。请先调整块大小或页面边距。')
    }
    const row = rows.at(-1)
    if (row && row.units[0].key === unit.key && row.width + GROUP_GAP + unit.group.width <= width + EPS) {
      row.units.push(unit); row.width += GROUP_GAP + unit.group.width; row.height = Math.max(row.height, height)
    } else rows.push({ units: [unit], schema: [], width: unit.group.width, height })
  }
  // A final partially filled row can use the same table header as preceding rows.
  // Different edited column labels or merged column widths form a new section.
  for (let i = 0; i < rows.length;) {
    let schema = rows[i].units, end = i + 1
    while (end < rows.length && compatibleSchemas(schema, rows[end].units)) {
      if (rows[end].units.length > schema.length) schema = rows[end].units
      end++
    }
    for (; i < end; i++) rows[i].schema = schema
  }

  const outputs = new Map<number, Page>()
  const destinationIds = eligible.map(page => page.id)
  let nextId = Math.max(0, ...pages.map(page => page.id)) + 1
  let destinationIndex = 0, y = headerTop, currentSchema: Unit[] | undefined, activeHeader: HeaderBlock | undefined
  const target = () => {
    if (destinationIds[destinationIndex] === undefined) destinationIds.push(nextId++)
    const id = destinationIds[destinationIndex]
    let output = outputs.get(id)
    if (!output) {
      const original = eligible.find(page => page.id === id)
      output = { ...original, id, name: original?.name ?? `页面 ${id}`, items: [], imageGroups: [],
        headerBlocks: [...(freeHeaders.get(id) ?? [])], annotations: [...(freeAnnotations.get(id) ?? [])] }
      outputs.set(id, output)
    }
    return output
  }
  for (const row of rows) {
    let page = target()
    let needsHeader = Boolean(row.units[0].header) && (!currentSchema || !compatibleSchemas(currentSchema, row.schema))
    let top = y + (needsHeader ? headerHeight : 0)
    const clearFreeHeaders = () => {
      // Page-owned custom headers stay put and remain clear of compacted blocks.
      for (const header of [...(freeHeaders.get(page.id) ?? [])].sort((a, b) => a.y - b.y)) {
        const startY = top - (needsHeader ? headerHeight : 0)
        if (startY < header.y + HEADER_BLOCK_HEIGHT + GROUP_GAP - EPS && top + row.height > header.y - EPS) {
          top = header.y + HEADER_BLOCK_HEIGHT + GROUP_GAP + (needsHeader ? headerHeight : 0)
        }
      }
    }
    clearFreeHeaders()
    if (top + row.height > bottom + EPS) {
      destinationIndex++; y = headerTop; currentSchema = undefined; activeHeader = undefined
      page = target(); needsHeader = Boolean(row.units[0].header); top = y + (needsHeader ? headerHeight : 0)
      clearFreeHeaders()
      if (top + row.height > bottom + EPS) throw new Error('页面中的独立表头占用了补位空间，请先移动表头再刷新。')
    }
    if (needsHeader) {
      const source = row.schema[0].header!
      const base = Math.min(...row.schema.map(unit => unit.group.width)) + GROUP_GAP
      activeHeader = { ...source, id: `refresh-header-${page.id}-${row.units[0].group.id}`, x: area.left,
        y: top - headerHeight, width: row.schema.reduce((sum, unit) => sum + unit.group.width + GROUP_GAP, -GROUP_GAP),
        columns: row.schema.map((unit, index) => ({ ...unit.column, id: `refresh-column-${page.id}-${row.units[0].group.id}-${index}`,
          span: (unit.group.width + GROUP_GAP) / base })), assetIds: [],
        detailWidth: source.detailWidth }
      page.headerBlocks!.push(activeHeader)
    }
    if (!row.units[0].header) activeHeader = undefined
    let x = area.left
    for (const unit of row.units) {
      const dx = x - unit.group.x, dy = top - unit.group.y
      const ids = new Set(unit.group.itemIds)
      const items = unit.source.items.filter(item => ids.has(item.id))
      page.items.push(...items.map(item => ({ ...item, x: item.x + dx, y: item.y + dy })))
      page.imageGroups!.push({ ...unit.group, x, y: top, preserveBackgroundHeight: true,
        ...(unit.source.id !== page.id && unit.group.backgroundColor === undefined
          ? { backgroundColor: unit.source.backgroundColor ?? GROUP_BACKGROUND } : {}),
        detailsX: unit.group.detailsX === undefined ? undefined : unit.group.detailsX + dx,
        imageCells: unit.group.imageCells?.map(cell => ({ ...cell, x: cell.x + dx, y: cell.y + dy })) })
      page.annotations!.push(...unit.annotations.map(annotation => translateAnnotation(annotation, dx, dy)))
      if (activeHeader) activeHeader.assetIds = [...new Set([...activeHeader.assetIds ?? [], ...items.map(item => item.assetId)])]
      x += unit.group.width + GROUP_GAP
    }
    currentSchema = row.schema
    y = top + row.height + GROUP_GAP
  }
  // Source pages that no longer contain blocks still keep their page-owned text and headers.
  for (const source of eligible) if (!outputs.has(source.id)) outputs.set(source.id, { ...source, items: [], imageGroups: [],
    annotations: [...(freeAnnotations.get(source.id) ?? [])], headerBlocks: [...(freeHeaders.get(source.id) ?? [])] })
  const result = pages.map(page => outputs.get(page.id) ?? page)
  const added = destinationIds.filter(id => !pages.some(page => page.id === id)).map(id => outputs.get(id)!).filter(Boolean)
  if (localOnly) result.splice(start + 1, 0, ...added)
  else result.push(...added)
  return result.filter(page => !outputs.has(page.id) || page.items.length > 0 || Boolean(page.annotations?.length || page.headerBlocks?.length))
}
