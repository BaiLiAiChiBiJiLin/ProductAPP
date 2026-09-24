import { GROUP_GAP, HEADER_BLOCK_HEIGHT, type HeaderBlock, type HeaderColumn, type LayoutBounds, type Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { findFreeRegions, type FreeRegion } from './freeRegions.ts'
import { headerFor, SECTION_EPS as EPS } from './pageSections.ts'

type Candidate = { source: Page; group: ImageGroup; header: HeaderBlock; column: HeaderColumn }
type Placement = { x: number; y: number; header?: HeaderBlock; reuse?: HeaderBlock }
function candidates(pages: Page[], start: number): Candidate[] {
  return pages.slice(start).flatMap(source => [...source.imageGroups ?? []]
    .sort((a, b) => a.y - b.y || a.x - b.x).flatMap(group => {
      const header = headerFor(source, group)
      if (!header) return []
      const width = (header.width - GROUP_GAP * (header.columns.length - 1)) / header.columns.length
      const column = header.columns[Math.round((group.x - header.x) / (width + GROUP_GAP))]
      return column ? [{ source, group, header, column }] : []
    }))
}
function before(x: number, y: number, group: ImageGroup) {
  return y < group.y - EPS || (Math.abs(y - group.y) <= EPS && x < group.x - EPS)
}
function placementFor(target: Page, free: FreeRegion, candidate: Candidate): Placement | undefined {
  const { source, group, header, column } = candidate
  if (free.width < group.width - EPS || free.height < group.height - EPS) return
  const existing = headerFor(target, { ...group, x: free.x, y: free.y })
  if (existing) {
    const columnWidth = (existing.width - GROUP_GAP * (existing.columns.length - 1)) / existing.columns.length
    const index = Math.ceil((free.x - existing.x - EPS) / (columnWidth + GROUP_GAP))
    const x = existing.x + index * (columnWidth + GROUP_GAP)
    const destination = existing.columns[index]
    if (destination?.imageMode === column.imageMode && destination.detailLabel === column.detailLabel
      && existing.detailWidth === header.detailWidth && Math.abs(columnWidth - group.width) < EPS
      && x >= free.x - EPS && x + group.width <= free.x + free.width + EPS
      && (source !== target || before(x, free.y, group))) return { x, y: free.y, reuse: existing }
    // A free rectangle that is already owned by a header is not a place where
    // another header may start.  Doing so creates a nested header in the
    // remaining part of a section; the next free-region pass then treats that
    // nested header as a new column and can move a third group underneath it.
    // Leave incompatible groups for a later page/section instead.
    return
  }
  // Free-region packing may only start a new header on a new section row.
  // Starting one beside an existing header is how a two-column section ended
  // up with a third, unrelated header in the same row. Side-column packing
  // handles the one intentional exception for wide standees separately.
  if ((target.headerBlocks ?? []).some(other => other.auto
    && (Math.abs(other.y - free.y) <= EPS
      || Math.abs(other.y + HEADER_BLOCK_HEIGHT + GROUP_GAP - free.y) <= EPS))) return
  const y = free.y + HEADER_BLOCK_HEIGHT + GROUP_GAP
  if (y + group.height > free.y + free.height + EPS || (source === target && !before(free.x, y, group))) return
  const added: HeaderBlock = { ...header, id: `free-${target.id}-${group.id}`, x: free.x, y: free.y,
    width: group.width, columns: [{ ...column, id: `free-column-${group.id}` }], assetIds: undefined }
  // A header placed in a hole must not take ownership of existing artwork below it.
  const preview = { ...target, headerBlocks: [...target.headerBlocks ?? [], added] }
  if ((target.imageGroups ?? []).some(other => other !== group && headerFor(preview, other) !== headerFor(target, other))) return
  return { x: free.x, y, header: added }
}

/** Final post-layout pass. Only move forward in reading order; never resize or split a group. */
export function fillFreeRegions(pages: Page[], bounds: LayoutBounds): Page[] {
  for (let targetIndex = 0; targetIndex < pages.length; targetIndex++) {
    const target = pages[targetIndex]
    for (;;) {
      const pending = candidates(pages, targetIndex)
      let match: { candidate: Candidate; placement: Placement } | undefined
      for (const region of findFreeRegions(target, bounds)) {
        for (const candidate of pending) {
          const placement = placementFor(target, region, candidate)
          if (placement) { match = { candidate, placement }; break }
        }
        if (match) break
      }
      if (!match) break
      const { candidate: { source, group }, placement } = match
      const owners = new Map((source.imageGroups ?? []).map(other => [other, headerFor(source, other)]))
      const ids = new Set(group.itemIds)
      const moving = source.items.filter(item => ids.has(item.id))
      source.items = source.items.filter(item => !ids.has(item.id))
      source.imageGroups = source.imageGroups!.filter(other => other !== group)
      const used = new Set(source.imageGroups.map(other => owners.get(other)))
      source.headerBlocks = source.headerBlocks?.filter(header => !header.auto || used.has(header) || (source === target && header === placement.reuse))
      if (placement.header) target.headerBlocks = [...target.headerBlocks ?? [], placement.header]
      const dx = placement.x - group.x, dy = placement.y - group.y
      target.items.push(...moving.map(item => ({ ...item, x: item.x + dx, y: item.y + dy })))
      group.x = placement.x; group.y = placement.y; group.backgroundHeight = group.height
      if (group.detailsX !== undefined) group.detailsX += dx
      for (const cell of group.imageCells ?? []) { cell.x += dx; cell.y += dy }
      target.imageGroups = [...target.imageGroups ?? [], group]
      // Re-detect after every move: maximal free rectangles are overlapping alternatives.
    }
  }
  return pages.filter(page => page.items.length).map((page, index) => ({ ...page, id: index + 1, name: `页面 ${index + 1}` }))
}
