import type { Item, Page } from '../../../model.ts'

/**
 * Per-selection visual zoom used by the arrangement canvas.
 *
 * The value is deliberately kept outside Item/Page.  It changes only the
 * rendered footprint on the canvas and in exports, never source dimensions or the
 * persisted packing coordinates.
 */
export const MIN_CANVAS_DISPLAY_SCALE = 0.25
export const MAX_CANVAS_DISPLAY_SCALE = 3
export const CANVAS_DISPLAY_SCALE_STEP = 0.1

export function clampCanvasDisplayScale(value: number) {
  const numeric = Number.isFinite(value) ? value : 1
  return Math.max(MIN_CANVAS_DISPLAY_SCALE, Math.min(MAX_CANVAS_DISPLAY_SCALE, numeric))
}

export function itemForCanvasDisplay(item: Item, scale = 1): Item {
  return scale === 1 ? item : { ...item, w: item.w * scale, h: item.h * scale }
}

export function pageForCanvasDisplay(page: Page, scales?: ReadonlyMap<string, number>): Page {
  if (!scales?.size) return page
  const items = page.items.map(item => itemForCanvasDisplay(item, scales.get(item.id)))
  return items.some((item, index) => item !== page.items[index]) ? { ...page, items } : page
}

