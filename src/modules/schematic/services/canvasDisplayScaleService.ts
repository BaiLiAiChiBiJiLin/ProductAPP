/**
 * Per-selection visual zoom used by the arrangement canvas.
 *
 * The value is deliberately kept outside Item/Page.  It changes only the
 * rendered footprint for review and never changes source dimensions or the
 * persisted packing coordinates.
 */
export const MIN_CANVAS_DISPLAY_SCALE = 0.25
export const MAX_CANVAS_DISPLAY_SCALE = 3
export const CANVAS_DISPLAY_SCALE_STEP = 0.1

export function clampCanvasDisplayScale(value: number) {
  const numeric = Number.isFinite(value) ? value : 1
  return Math.max(MIN_CANVAS_DISPLAY_SCALE, Math.min(MAX_CANVAS_DISPLAY_SCALE, numeric))
}

