import { GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT, type LayoutBounds, type Page, type HeaderBlock } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'

const EPS = 1e-7
function headerFor(page: Page, group: ImageGroup) {
  return page.headerBlocks?.filter(header => header.y + HEADER_BLOCK_HEIGHT <= group.y + EPS).at(-1)
}
function compatible(header: HeaderBlock, source: HeaderBlock) {
  return header.columns.length === source.columns.length && Math.abs((header.detailWidth ?? 0) - (source.detailWidth ?? 0)) < EPS
}
function overlaps(x: number, y: number, group: ImageGroup, other: ImageGroup) {
  return x < other.x + other.width + GROUP_GAP - EPS && x + group.width + GROUP_GAP > other.x + EPS
    && y < other.y + other.height + GROUP_GAP - EPS && y + group.height + GROUP_GAP > other.y + EPS
}

/** Close vacated rows and leading columns without changing any artwork size. */
export function compactPageSections(page: Page, bounds: LayoutBounds) {
  // Resolve section membership before moving headers or group coordinates.
  const sections = (page.headerBlocks ?? []).map(header => ({ header,
    groups: (page.imageGroups ?? []).filter(group => headerFor(page, group) === header).sort((a, b) => a.y - b.y || a.x - b.x) }))
  let nextY = bounds.top
  for (const { header, groups } of sections) {
    if (!groups.length) continue
    header.y = nextY
    nextY += HEADER_BLOCK_HEIGHT + GROUP_GAP
    const rows: ImageGroup[][] = []
    for (const group of groups) {
      const row = rows.at(-1)
      if (row && Math.abs(row[0].y - group.y) < EPS) row.push(group)
      else rows.push([group])
    }
    const columnWidth = (header.width - GROUP_GAP * (header.columns.length - 1)) / header.columns.length
    for (const row of rows) {
      const height = Math.max(...row.map(group => group.height))
      row.forEach((group, index) => {
        const x = header.x + index * (columnWidth + GROUP_GAP)
        const dx = x - group.x, dy = nextY - group.y
        const ids = new Set(group.itemIds)
        for (const item of page.items) if (ids.has(item.id)) { item.x += dx; item.y += dy }
        group.x = x; group.y = nextY
        if (group.detailsX !== undefined) group.detailsX += dx
        for (const cell of group.imageCells ?? []) { cell.x += dx; cell.y += dy }
        group.backgroundHeight = height
      })
      nextY += height + GROUP_GAP
    }
  }
  page.headerBlocks = sections.filter(section => section.groups.length).map(section => section.header)
}

/** Fill earlier column vacancies and page tails by moving complete groups, never resizing. */
export function backfillPages(pages: Page[], bounds: LayoutBounds): Page[] {
  const bottom = PAPER_HEIGHT - bounds.bottom
  for (let sourceIndex = 1; sourceIndex < pages.length; sourceIndex++) {
    const source = pages[sourceIndex]
    for (const group of [...source.imageGroups ?? []]) {
      const sourceHeader = headerFor(source, group)
      if (!sourceHeader) continue
      for (const target of pages.slice(0, sourceIndex)) {
        const groups = target.imageGroups ?? []
        const headers = target.headerBlocks ?? []
        let placement: { x: number; y: number; header?: HeaderBlock } | undefined
        // Reuse a compatible section's empty column, bounded by its next header.
        for (const [index, header] of headers.entries()) {
          if (!compatible(header, sourceHeader)) continue
          const limit = headers[index + 1]?.y ?? bottom
          const ys = new Set([header.y + HEADER_BLOCK_HEIGHT + GROUP_GAP, ...groups.filter(g => headerFor(target, g) === header).map(g => g.y)])
          const columnWidth = (header.width - GROUP_GAP * (header.columns.length - 1)) / header.columns.length
          for (const y of ys) for (let col = 0; col < header.columns.length; col++) {
            const x = header.x + col * (columnWidth + GROUP_GAP)
            if (group.width > columnWidth + EPS || y + group.height > limit - (headers[index + 1] ? GROUP_GAP : 0) + EPS) continue
            if (!groups.some(other => overlaps(x, y, group, other))) { placement = { x, y }; break }
          }
          if (placement) break
        }
        if (!placement) {
          const lastHeader = headers.at(-1)
          const tail = Math.max(bounds.top, ...groups.map(g => g.y + g.height), ...headers.map(h => h.y + HEADER_BLOCK_HEIGHT)) + GROUP_GAP
          const needsHeader = !lastHeader || !compatible(lastHeader, sourceHeader)
          const y = tail + (needsHeader ? HEADER_BLOCK_HEIGHT + GROUP_GAP : 0)
          if (y + group.height <= bottom + EPS) placement = { x: bounds.left, y,
            header: needsHeader ? { ...sourceHeader, id: `backfill-${target.id}-${group.id}`, x: bounds.left, y: tail } : undefined }
        }
        if (!placement) continue
        const dx = placement.x - group.x, dy = placement.y - group.y
        const ids = new Set(group.itemIds)
        target.items.push(...source.items.filter(item => ids.has(item.id)).map(item => ({ ...item, x: item.x + dx, y: item.y + dy })))
        source.items = source.items.filter(item => !ids.has(item.id))
        target.imageGroups!.push({ ...group, x: placement.x, y: placement.y,
          detailsX: group.detailsX === undefined ? undefined : group.detailsX + dx,
          imageCells: group.imageCells?.map(cell => ({ ...cell, x: cell.x + dx, y: cell.y + dy })) })
        if (placement.header) target.headerBlocks!.push(placement.header)
        source.imageGroups = source.imageGroups!.filter(candidate => candidate !== group)
        break
      }
    }
    // Remove headers only after all source groups have been classified.
    const usedHeaders = new Set(source.imageGroups?.map(group => headerFor(source, group)))
    source.headerBlocks = source.headerBlocks?.filter(header => usedHeaders.has(header))
    compactPageSections(source, bounds)
  }
  return pages.filter(page => page.items.length).map((page, index) => ({ ...page, id: index + 1, name: `页面 ${index + 1}` }))
}
