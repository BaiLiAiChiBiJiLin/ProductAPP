import type { Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'

type PhysicalSize = { width: number; height: number }
type ScaleReference = { largest: number; reference: number }

/** Fit the cells, with comparable visual sizes for the same product on each page. */
export function applyPhysicalImageScale(pages: Page[], sizes: ReadonlyMap<string, PhysicalSize>): Page[] {
  const entries = pages.flatMap(page => {
    // Product references belong to this page only. Unknown products retain
    // their own group reference rather than being compared as one product.
    const references = new Map<string | ImageGroup, ScaleReference>()
    return (page.imageGroups ?? []).flatMap(group => {
      const product = group.productKey?.trim().toLowerCase()
      const key = product && product !== 'unassigned' ? product : group
      const scale = references.get(key) ?? { largest: 0, reference: Infinity }
      references.set(key, scale)
      const items = page.items.filter(item => group.itemIds.includes(item.id))
      const cells = new Map(group.imageCells?.map(cell => [cell.itemId, cell]))
      return items.flatMap(item => {
        const size = sizes.get(item.assetId)
        const cell = cells.get(item.id)
        if (!size || !cell || !(size.width > 0 && size.height > 0)) return []
        const base = item.caption?.toLowerCase() === 'base'
        const standee = !base && /立牌|standees?/i.test(group.productKey ?? '')
        const top = item.caption ? 23 : 14
        const single = items.length === 1 && !item.caption
        const bottom = (group.details?.finish && cell.y + cell.height >= group.y + group.height - 0.1 ? 16 : single ? 14 : 5)
          + (item.note ? 13 : 0)
        const left = base || size.width >= size.height ? 4 : 13
        const fillSingle = single && !standee
        const right = base ? 4 : fillSingle ? 0 : 5
        // A single picture uses all space up to the property column, regardless
        // of aspect ratio. Recenter it in that area so the old left half does not
        // keep limiting its width after the right-hand gutter is reclaimed.
        const imageCenterX = fillSingle ? cell.x + left + (cell.width - left - right) / 2 : item.x
        // Role/multi-picture cells retain their existing column centers.
        const width = Math.max(1, 2 * Math.min(imageCenterX - cell.x - left, cell.x + cell.width - right - imageCenterX))
        const height = Math.max(1, cell.height - top - bottom)
        const defaultFit = Math.min(width / size.width, height / size.height)
        // Reclaim five units on each side of portrait standees: eight on the
        // left holds the rotated ruler text plus frame clearance; the right can meet
        // the property boundary. Stop at the available cell instead of spilling.
        const standeeWidth = Math.max(1, cell.width - 8)
        const fit = standee ? Math.min(defaultFit * 1.2, standeeWidth / size.width, height / size.height) : defaultFit
        const centerX = standee ? cell.x + 8 + standeeWidth / 2 : imageCenterX
        return [{ item, size, base, fit, centerX, scale,
          longest: Math.max(size.width, size.height), centerY: cell.y + top + height / 2 }]
      })
    })
  })
  for (const entry of entries) {
    if (entry.base) continue
    entry.scale.largest = Math.max(entry.scale.largest, entry.longest)
  }
  // Square-root compression distinguishes different sizes without making small
  // charms unreadable. The 70% floor is a visual aid, never a physical dimension.
  const weight = (longest: number, largest: number) => Math.max(0.7, Math.sqrt(longest / largest))
  for (const entry of entries) {
    if (entry.base) continue
    const scale = entry.scale
    scale.reference = Math.min(scale.reference, entry.longest * entry.fit / weight(entry.longest, scale.largest))
  }
  for (const { item, size, base, fit, centerX, centerY, scale, longest } of entries) {
    const factor = base ? fit : scale.reference * weight(longest, scale.largest) / longest
    item.w = size.width * factor
    item.h = size.height * factor
    item.x = centerX
    item.y = centerY
  }
  return pages
}
