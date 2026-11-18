import type { Asset } from '../../../model'
import { invoke } from '../../../services/backend'
import { artworkSource, hasInlineArtwork } from './artworkSourceService'

const pending = new Map<string, Promise<string>>()
/** Only linked charms need picture-bottom geometry beyond physical dimensions. */
export function needsArtworkGeometry(asset: Asset) {
  return !hasInlineArtwork(asset.svg) && !asset.geometrySvg && /串串|串联|串連|chained|linked charm|connecting charm/i.test(asset.productName ?? '')
}
export function loadArtworkGeometry(asset: Asset, batchId?: string) {
  const source = artworkSource(asset, undefined, batchId)
  const key = JSON.stringify(source)
  let request = pending.get(key)
  if (!request) {
    request = invoke<string>('load_artwork_geometry', { source })
    pending.set(key, request)
    void request.then(svg => { if (svg.length > 256 * 1024 && pending.get(key) === request) pending.delete(key) }).catch(() => {})
    void request.catch(() => { if (pending.get(key) === request) pending.delete(key) })
    while (pending.size > 64) pending.delete(pending.keys().next().value!)
  }
  return request
}
export async function withArtworkGeometry(assets: Asset[], batchId?: string) {
  const result: Asset[] = []
  for (const asset of assets) result.push(needsArtworkGeometry(asset) ? { ...asset, geometrySvg: await loadArtworkGeometry(asset, batchId) } : asset)
  return result
}
