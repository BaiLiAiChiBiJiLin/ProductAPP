import type { Asset } from '../../../model'
import { invoke } from '../../../services/backend'
import { artworkSource, hasInlineArtwork } from './artworkSourceService'
import { artworkVersion } from './artworkVersionService'
import { StagedArtwork } from './stagedArtworkService'

export type ArtworkLayerDocument = { svg: string; version: string; deferred: boolean }
const documents = new Map<string, { promise: Promise<ArtworkLayerDocument>; bytes: number }>()
let retainedBytes = 0
const MAX_BYTES = 4 * 1024 * 1024

/** Cache only raster-free XML. Full originals stay in their owning backend. */
export async function loadArtworkLayers(asset: Asset, batchId?: string): Promise<ArtworkLayerDocument> {
  if (hasInlineArtwork(asset.svg) && asset.svg.length <= 256 * 1024) return { svg: asset.svg, version: '', deferred: false }
  const source = artworkSource(asset, undefined, batchId)
  const key = JSON.stringify([source.batchId, source.assetId, source.path, hasInlineArtwork(source.svg) ? await artworkVersion(source.svg) : source.svg])
  const cached = documents.get(key)
  if (cached) { documents.delete(key); documents.set(key, cached); return cached.promise }
  const entry = { promise: Promise.resolve({ svg: '', version: '', deferred: true }), bytes: 0 }
  entry.promise = (async () => {
    const staged = new StagedArtwork()
    try {
      if (hasInlineArtwork(source.svg)) { source.svg = staged.reference(source.svg); await staged.write() }
      const value = await invoke<{ svg: string; version: string }>('load_artwork_layer_document', { source })
      if (!value?.svg || !value.version) throw new Error('图片图层暂不可用')
      if (documents.get(key) === entry) {
        entry.bytes = value.svg.length * 2; retainedBytes += entry.bytes
        while (documents.size > 16 || retainedBytes > MAX_BYTES) {
          const oldest = documents.entries().next().value
          if (!oldest) break
          documents.delete(oldest[0]); retainedBytes -= oldest[1].bytes
        }
      }
      return { ...value, deferred: true }
    } finally { await staged.dispose() }
  })()
  documents.set(key, entry)
  void entry.promise.catch(() => {
    if (documents.get(key) === entry) { documents.delete(key); retainedBytes -= entry.bytes }
  })
  return entry.promise
}
