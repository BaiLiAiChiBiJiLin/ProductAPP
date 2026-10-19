import { bounds, type PackedImpositionItem } from './impositionGeometry'

/** Image positions describe the rotated frame's top-left; Konva rotates about its center. */
export function rotateAroundCenter(item: PackedImpositionItem, rotation: number): PackedImpositionItem {
  const previous = bounds(item, item.rotation ?? 0)
  const rotated = bounds(item, rotation, 0, 0)
  return {
    ...item,
    rotation,
    x: (previous.left + previous.right - rotated.right) / 2,
    y: (previous.top + previous.bottom - rotated.bottom) / 2,
  }
}

/** Stop at the legal angular boundary instead of reverting the whole gesture on release. */
export function constrainRotation(
  lastValid: PackedImpositionItem,
  targetAngle: number,
  isValid: (candidate: PackedImpositionItem) => boolean,
  { budgetMs = 8, now = () => performance.now() }: { budgetMs?: number; now?: () => number } = {},
): { item: PackedImpositionItem; limited: boolean } {
  const started = now()
  const requested = rotateAroundCenter(lastValid, targetAngle)
  if (isValid(requested)) return { item: requested, limited: false }
  const previousAngle = lastValid.rotation ?? 0
  const delta = ((targetAngle - previousAngle + 180) % 360 + 360) % 360 - 180
  let accepted = lastValid
  let low = 0
  let high = 1
  // Refine only within an interaction frame; one in-flight geometry check cannot be interrupted.
  for (let attempt = 0; attempt < 10 && Math.abs(delta) * (high - low) > 0.05; attempt++) {
    if (now() - started >= budgetMs) break
    const fraction = (low + high) / 2
    const candidate = rotateAroundCenter(lastValid, previousAngle + delta * fraction)
    if (isValid(candidate)) { accepted = candidate; low = fraction }
    else high = fraction
  }
  return { item: accepted, limited: true }
}
