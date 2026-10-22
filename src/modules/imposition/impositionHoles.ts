export const BOARD_HOLE_COLOR = '#2563eb'
export const BOARD_HOLE_STROKE_MM = 0.15

/** spanMm runs from the upper hole's top to the next hole's bottom. */
export function boardHoleLayout(heightMm: number, count: number, diameterMm: number, spanMm: number) {
  const pitchMm = Math.max(0, spanMm - diameterMm)
  const extentMm = count > 0 ? Math.max(0, count - 1) * pitchMm + diameterMm : 0
  return { startMm: (heightMm - extentMm) / 2, pitchMm }
}

/** The circular path's diameter is the configured hole size, in millimetres. */
export function boardHolePath(leftMm: number, topMm: number, diameterMm: number) {
  const radius = diameterMm / 2
  const centerY = topMm + radius
  const right = leftMm + diameterMm
  const n = (value: number) => Number(value.toFixed(6))
  return `M ${n(leftMm)} ${n(centerY)} A ${n(radius)} ${n(radius)} 0 1 0 ${n(right)} ${n(centerY)} A ${n(radius)} ${n(radius)} 0 1 0 ${n(leftMm)} ${n(centerY)} Z`
}
