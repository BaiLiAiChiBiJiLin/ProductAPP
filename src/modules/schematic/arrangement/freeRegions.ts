import { GROUP_GAP, HEADER_BLOCK_HEIGHT, normalizeLayoutBounds, PAPER_HEIGHT, PAPER_WIDTH, type LayoutBounds, type Page } from '../../../model.ts'

export type FreeRegion = { x: number; y: number; width: number; height: number }
const EPS = 1e-7
export function intersects(a: FreeRegion, b: FreeRegion) {
  return a.x < b.x + b.width - EPS && b.x < a.x + a.width - EPS
    && a.y < b.y + b.height - EPS && b.y < a.y + a.height - EPS
}
function contains(a: FreeRegion, b: FreeRegion) {
  return a.x <= b.x + EPS && a.y <= b.y + EPS
    && a.x + a.width >= b.x + b.width - EPS && a.y + a.height >= b.y + b.height - EPS
}

/** Maximal empty rectangles may overlap each other, but never the occupied geometry.
 * Recompute after each placement; these are alternative choices, not disjoint slots.
 */
export function findFreeRegions(page: Page, bounds: LayoutBounds): FreeRegion[] {
  const area = normalizeLayoutBounds(bounds)
  let free: FreeRegion[] = [{ x: area.left, y: area.top,
    width: PAPER_WIDTH - area.left - area.right, height: PAPER_HEIGHT - area.top - area.bottom }]
  const grouped = new Set(page.imageGroups?.flatMap(group => group.itemIds))
  const occupied: FreeRegion[] = [
    ...(page.imageGroups ?? []).map(group => ({ ...group, height: Math.max(group.height, group.backgroundHeight ?? 0) })),
    ...(page.headerBlocks ?? []).map(header => ({ ...header, height: HEADER_BLOCK_HEIGHT })),
    ...page.items.filter(item => !grouped.has(item.id)).map(item => {
      const radians = item.rotation * Math.PI / 180
      const width = Math.abs(Math.cos(radians) * item.w) + Math.abs(Math.sin(radians) * item.h)
      const height = Math.abs(Math.sin(radians) * item.w) + Math.abs(Math.cos(radians) * item.h)
      return { x: item.x - width / 2, y: item.y - height / 2, width, height }
    }),
  ]
  for (const rect of occupied) {
    const block = { x: rect.x - GROUP_GAP, y: rect.y - GROUP_GAP,
      width: rect.width + 2 * GROUP_GAP, height: rect.height + 2 * GROUP_GAP }
    free = free.flatMap(region => {
      if (!intersects(region, block)) return [region]
      const right = region.x + region.width, bottom = region.y + region.height
      return [
        { ...region, width: block.x - region.x },
        { ...region, x: block.x + block.width, width: right - block.x - block.width },
        { ...region, height: block.y - region.y },
        { ...region, y: block.y + block.height, height: bottom - block.y - block.height },
      ].filter(part => part.width > EPS && part.height > EPS)
    })
    free = free.filter((region, index) => !free.some((other, j) => j !== index && contains(other, region)
      && (!contains(region, other) || j < index)))
  }
  return free.sort((a, b) => a.y - b.y || a.x - b.x || b.width * b.height - a.width * a.height)
}
