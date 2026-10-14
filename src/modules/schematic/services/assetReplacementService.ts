import type { Asset } from '../../../model'
import { discardTemporaryAssets } from './batchHistoryService'
import { importAssets, type ImportProgress } from './uploadService'

/** Use the normal SVG importer without streaming candidates into the current list. */
export async function importReplacementAsset(onProgress?: (progress: ImportProgress) => void): Promise<Asset | null> {
  const pending = new Map<string, Asset>()
  try {
    const imported = await importAssets(onProgress, batch => batch.forEach(asset => pending.set(asset.id, asset)))
    imported.forEach(asset => pending.set(asset.id, asset))
    if (!imported.length) return null // File picker cancelled.
    if (imported.length !== 1) throw new Error(`该 SVG 解析出了 ${imported.length} 张图片，请选择仅包含一张图片的 SVG 更换。`)
    return imported[0]
  } catch (error) {
    if (pending.size) await discardTemporaryAssets([...pending.values()]).catch(() => {})
    throw error
  }
}

/** Artwork has a new resource ID; business properties and the list position stay put. */
export function replaceAssetArtwork(assets: Asset[], originalId: string, artwork: Asset): Asset[] {
  const original = assets.find(asset => asset.id === originalId)
  if (!original) throw new Error('需要更换的图片已不在当前批次中')
  if (!artwork.id || assets.some(asset => asset.id === artwork.id)) throw new Error('新图片资源 ID 与当前批次冲突，请重新选择文件')
  const replacement: Asset = {
    ...original,
    id: artwork.id,
    name: artwork.name,
    sourceFileName: artwork.sourceFileName,
    svg: artwork.svg,
    previewUrl: artwork.previewUrl,
    thumbnailUrl: artwork.thumbnailUrl,
    storagePath: artwork.storagePath,
    width: artwork.width,
    height: artwork.height,
    sourceGroupWidthMm: artwork.sourceGroupWidthMm,
    sourceGroupHeightMm: artwork.sourceGroupHeightMm,
    sourceGroupBounds: artwork.sourceGroupBounds,
    sourceImages: artwork.sourceImages,
    modeUsed: artwork.modeUsed,
    mergeStatus: artwork.mergeStatus,
    sourceGroupId: artwork.sourceGroupId,
  }
  return assets.map(asset => {
    const next = asset.id === originalId ? replacement : asset
    return next.productGroupLeaderId === originalId ? { ...next, productGroupLeaderId: artwork.id } : next
  })
}

export function replaceSelectedAssetId(ids: Set<string>, originalId: string, replacementId: string): Set<string> {
  return ids.has(originalId) ? new Set([...ids].map(id => id === originalId ? replacementId : id)) : ids
}
