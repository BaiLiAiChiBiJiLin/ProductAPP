export const POOL_DROP_EVENT = 'printflow:pool-image-drop'
export type PoolImageDrop = { assetId: string; clientX: number; clientY: number }

export function poolDropPoint(drop: PoolImageDrop, bounds: { left: number; top: number }, origin: { x: number; y: number }, scale: number, paper: { width: number; height: number }) {
  const x = (drop.clientX - bounds.left - origin.x) / scale
  const y = (drop.clientY - bounds.top - origin.y) / scale
  return scale > 0 && x >= 0 && y >= 0 && x <= paper.width && y <= paper.height ? { x, y } : undefined
}
