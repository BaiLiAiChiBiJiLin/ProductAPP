import type { Asset, Item } from '../../../model'

export const SNAPSHOT_ARTWORK_PREFIX = 'printflow-snapshot:'
export type SnapshotArtwork = { id: string; resourceId: string; savedAt: string }
export function snapshotArtwork(reference: SnapshotArtwork) { return SNAPSHOT_ARTWORK_PREFIX + JSON.stringify(reference) }
export function parseSnapshotArtwork(svg: string): SnapshotArtwork | undefined {
  if (!svg.startsWith(SNAPSHOT_ARTWORK_PREFIX)) return undefined
  return JSON.parse(svg.slice(SNAPSHOT_ARTWORK_PREFIX.length)) as SnapshotArtwork
}
export function hasInlineArtwork(svg: string) { return Boolean(svg) && !svg.startsWith(SNAPSHOT_ARTWORK_PREFIX) }
export function artworkGeometrySvg(svg: string) {
  return svg.replace(/(\b(?:[\w.-]+:)?href\s*=\s*)(["'])data:([^,]*),[\s\S]*?\2/gi, '$1$2data:$3,$2')
}
export function artworkSource(asset: Pick<Asset, 'id' | 'svg' | 'storagePath'>, item?: Pick<Item, 'backSvg' | 'artworkVariant'>, batchId?: string) {
  return { assetId: asset.id, svg: item?.backSvg ?? asset.svg, path: asset.storagePath, batchId, variant: item?.backSvg ? undefined : item?.artworkVariant }
}
