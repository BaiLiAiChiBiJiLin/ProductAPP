import { GROUP_GAP, HEADER_BLOCK_HEIGHT, headerColumnBounds, type Page } from '../../../model.ts'
import { headerFor } from '../arrangement/pageSections.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { manualRulerGeometry } from './canvasAnnotationService.ts'

type RestoredBlock = { source: Page; original: ImageGroup; page: Page; dx: number; dy: number }

/** A manually added face changes a block's membership beyond the default product template. */
export function restoreManualBackBlocks(previous: Page[], generated: Page[]): RestoredBlock[] {
  const restored: RestoredBlock[] = []
  const originalsKey = (page: Page, group: ImageGroup) => JSON.stringify(page.items
    .filter(item => group.itemIds.includes(item.id) && !item.derivedFrom).map(item => item.id).sort())
  for (const source of previous) for (const original of source.imageGroups ?? []) {
    if (!source.items.some(item => original.itemIds.includes(item.id) && item.manualBack)) continue
    const key = originalsKey(source, original)
    if (key === '[]') continue
    const page = generated.find(candidate => candidate.imageGroups?.some(group => originalsKey(candidate, group) === key))
    const target = page?.imageGroups?.find(group => originalsKey(page, group) === key)
    if (!page || !target) continue
    const dx = target.x - original.x, dy = target.y - original.y
    const nativeHeader = headerFor(page, target)
    const oldHeader = headerFor(source, original)
    const header = oldHeader ?? nativeHeader
    const columns = oldHeader ? headerColumnBounds(oldHeader) : []
    const column = columns.find(column => Math.abs(oldHeader!.x + column.x - original.x) < 1e-6)?.column
      ?? header?.columns[0]
    const oldMembers = new Set(original.itemIds), nativeMembers = new Set(target.itemIds)
    const members = source.items.filter(item => oldMembers.has(item.id)).map(item => ({ ...item, x: item.x + dx, y: item.y + dy }))
    let inserted = false
    page.items = page.items.flatMap(item => {
      if (!nativeMembers.has(item.id)) return [item]
      if (inserted) return []
      inserted = true
      return members
    })
    Object.assign(target, original, { x: target.x, y: target.y,
      backgroundColor: original.backgroundColor ?? source.backgroundColor,
      detailsX: original.detailsX === undefined ? undefined : original.detailsX + dx,
      imageCells: original.imageCells?.map(cell => ({ ...cell, x: cell.x + dx, y: cell.y + dy })),
      preserveBackgroundHeight: true,
    })
    // An expanded block can be wider than its regenerated one-column header.
    // Give the packing pass an explicit owning header, with one merged column.
    if (header && column) page.headerBlocks = [...page.headerBlocks ?? [], {
      ...header, id: `manual-back-header-${target.id}`, x: target.x,
      y: target.y - HEADER_BLOCK_HEIGHT - GROUP_GAP, width: target.width,
      columns: [{ ...column, id: `manual-back-column-${target.id}`, span: undefined }],
      detailWidth: target.detailWidth, assetIds: [...new Set(members.map(item => item.assetId))],
    }]
    restored.push({ source, original, page, dx, dy })
  }
  return restored
}

/** Page restoration copies annotations; keep block-owned annotations with the restored content. */
export function translateManualBackAnnotations(pages: Page[], blocks: RestoredBlock[]) {
  const moves = new Map<string, { pageId: number; dx: number; dy: number }>()
  for (const block of blocks) for (const annotation of block.source.annotations ?? []) {
    const group = block.original
    const contains = (x: number, y: number) => x >= group.x && x <= group.x + group.width
      && y >= group.y && y <= group.y + Math.max(group.height, group.backgroundHeight ?? 0)
    const baseline = annotation.kind === 'ruler' ? manualRulerGeometry(annotation).extension : undefined
    const belongs = annotation.kind === 'ruler' && annotation.sourceItemId
      ? group.itemIds.includes(annotation.sourceItemId)
      : contains(annotation.x, annotation.y) || Boolean(baseline && contains((baseline[0][0] + baseline[1][0]) / 2, (baseline[0][1] + baseline[1][1]) / 2))
    if (belongs) moves.set(annotation.id, { pageId: block.page.id, dx: block.dx, dy: block.dy })
  }
  const relocated = new Map<number, NonNullable<Page['annotations']>>()
  for (const page of pages) page.annotations = page.annotations?.filter(annotation => {
    const move = moves.get(annotation.id)
    if (!move) return true
    const next = { ...annotation, x: annotation.x + move.dx, y: annotation.y + move.dy,
      ...(annotation.kind === 'ruler' ? { x2: annotation.x2 + move.dx, y2: annotation.y2 + move.dy } : {}) }
    relocated.set(move.pageId, [...relocated.get(move.pageId) ?? [], next])
    return false
  })
  for (const page of pages) if (relocated.has(page.id)) page.annotations = [...page.annotations ?? [], ...relocated.get(page.id)!]
}
