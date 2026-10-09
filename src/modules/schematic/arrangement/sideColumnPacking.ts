import { GROUP_GAP, headerColumnBounds, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT, PAPER_WIDTH, type HeaderBlock, type LayoutBounds, type Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { headerFor, sharesMixedWidthRow, SECTION_EPS as EPS } from './pageSections.ts'

/** Fill the third base column beside wide standees using whole, already-sized groups. */
export function fillSideColumns(pages: Page[], bounds: LayoutBounds) {
  const baseWidth = (PAPER_WIDTH - bounds.left - bounds.right - 2 * GROUP_GAP) / 3
  const owners = new Map<ImageGroup, HeaderBlock>()
  for (const page of pages) for (const group of page.imageGroups ?? []) {
    const header = headerFor(page, group)
    if (header) owners.set(group, header)
  }
  for (const [pageIndex, target] of pages.entries()) {
    if (target.imageGroups?.some(group => group.protectPageFill)) continue
    // Snapshot original headers so newly added side headers do not redefine the region.
    const headers = [...target.headerBlocks ?? []].sort((a, b) => a.y - b.y)
    for (const wideHeader of headers) {
      if (!wideHeader.auto || wideHeader.columns.length !== 1 || wideHeader.columns[0].imageMode !== 'front-back'
        || Math.abs(wideHeader.width - (2 * baseWidth + GROUP_GAP)) > EPS) continue
      const x = wideHeader.x + wideHeader.width + GROUP_GAP
      if (x + baseWidth > PAPER_WIDTH - bounds.right + EPS) continue
      const nextHeader = headers.find(header => header.y > wideHeader.y + EPS)
      const limit = nextHeader ? nextHeader.y - GROUP_GAP : PAPER_HEIGHT - bounds.bottom
      let y = wideHeader.y
      let sideHeader: HeaderBlock | undefined
      for (const source of pages.slice(pageIndex)) {
        for (const group of [...source.imageGroups ?? []]) {
          const owner = owners.get(group)
          if (!owner || source.imageGroups?.some(candidate => candidate.protectPageFill) || group.preventRowFill || group.protectPageFill
            || sharesMixedWidthRow(source, group) || Math.abs(group.width - baseWidth) > EPS || (source === target && group.y < limit - EPS)) continue
          const column = headerColumnBounds(owner).find(slot => Math.abs(owner.x + slot.x - group.x) < EPS
            && Math.abs(slot.width - group.width) < EPS)?.column
          if (!column) continue
          const needsHeader = !sideHeader || sideHeader.columns[0].imageMode !== column.imageMode
            || sideHeader.columns[0].detailLabel !== column.detailLabel || sideHeader.detailWidth !== owner.detailWidth
          const groupY = y + (needsHeader ? HEADER_BLOCK_HEIGHT + GROUP_GAP : 0)
          if (groupY + group.height > limit + EPS) continue
          const anchor = target.imageGroups?.find(candidate => owners.get(candidate) === wideHeader && Math.abs(candidate.y - groupY) <= EPS)
          if (anchor?.preventRowFill) continue
          if (anchor?.productKey && group.productKey && anchor.productKey !== group.productKey) continue
          if (needsHeader) {
            sideHeader = { ...owner, id: `side-${target.id}-${group.id}`, x, y, width: baseWidth,
              columns: [{ ...column, id: `side-column-${group.id}` }], assetIds: [] }
            target.headerBlocks!.push(sideHeader)
          }
          const ids = new Set(group.itemIds)
          const items = source.items.filter(item => ids.has(item.id))
          source.items = source.items.filter(item => !ids.has(item.id))
          source.imageGroups = source.imageGroups!.filter(candidate => candidate !== group)
          const dx = x - group.x, dy = groupY - group.y
          target.items.push(...items.map(item => ({ ...item, x: item.x + dx, y: item.y + dy })))
          group.x = x; group.y = groupY; group.backgroundHeight = group.height
          if (group.detailsX !== undefined) group.detailsX += dx
          for (const cell of group.imageCells ?? []) { cell.x += dx; cell.y += dy }
          target.imageGroups!.push(group)
          owners.set(group, sideHeader!)
          y = groupY + group.height + GROUP_GAP
        }
      }
    }
  }
  for (const page of pages) {
    const used = new Set(page.imageGroups?.map(group => owners.get(group)))
    page.headerBlocks = page.headerBlocks?.filter(header => !header.auto || used.has(header))
  }
}
