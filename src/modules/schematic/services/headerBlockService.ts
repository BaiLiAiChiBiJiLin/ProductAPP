import { constrainHeaderBlock, HEADER_BLOCK_HEIGHT, normalizeLayoutBounds, PAPER_HEIGHT, PAPER_WIDTH, type HeaderBlock, type HeaderColumn, type LayoutBounds } from '../../../model.ts'

export function newHeaderColumn(): HeaderColumn {
  return { id: crypto.randomUUID(), imageMode: 'front-back', detailLabel: 'Size/QT/Finish' }
}

export function resizeHeaderColumns(block: HeaderBlock, count: number): HeaderBlock {
  const length = Math.max(1, Math.min(8, Math.floor(Number.isFinite(count) ? count : 1)))
  return { ...block, columns: Array.from({ length }, (_, index) => block.columns[index] ?? newHeaderColumn()) }
}

export function createHeaderBlock(bounds: LayoutBounds, existing: HeaderBlock[]): HeaderBlock {
  const area = normalizeLayoutBounds(bounds)
  let y = area.top
  if (existing.length) {
    const sorted = [...existing].sort((a, b) => a.y - b.y)
    const gaps = sorted.map((block, index) => ({ from: block.y + HEADER_BLOCK_HEIGHT, to: sorted[index + 1]?.y ?? PAPER_HEIGHT - area.bottom }))
    gaps.unshift({ from: area.top, to: sorted[0].y })
    const largest = gaps.sort((a, b) => (b.to - b.from) - (a.to - a.from))[0]
    y = largest.from + Math.max(0, (largest.to - largest.from - HEADER_BLOCK_HEIGHT) / 2)
  }
  return constrainHeaderBlock({ id: crypto.randomUUID(), x: area.left, y, width: PAPER_WIDTH - area.left - area.right, columns: [newHeaderColumn(), newHeaderColumn()] }, area)
}
