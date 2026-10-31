import type { Asset } from '../../../model'
import { invoke } from '../../../services/backend'

const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Read one artwork only when a component needs to display or edit it. During
 * large uploads the asset event intentionally contains metadata and a staged
 * file path instead of the SVG text itself.
 */
export async function loadAssetSvg(asset: Pick<Asset, 'svg' | 'storagePath' | 'id'>, batchId?: string) {
  if (asset.svg) return asset.svg
  if (asset.storagePath) {
    try {
      const bytes = await invoke<ArrayBuffer>('load_temp_asset_svg', { path: asset.storagePath })
      const svg = decoder.decode(bytes)
      if (svg) return svg
    } catch {
      // A saved shared/local asset is not under temp-assets; try the batch
      // resource below when the caller has a persisted batch id.
    }
  }
  if (batchId) {
    const bytes = await invoke<ArrayBuffer>('load_batch_asset_svg', { batchId, assetId: asset.id })
    const svg = decoder.decode(bytes)
    if (svg) return svg
  }
  throw new Error('图片源文件不可访问')
}
