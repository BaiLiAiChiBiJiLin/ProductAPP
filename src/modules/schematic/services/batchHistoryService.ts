import { isTauri } from '@tauri-apps/api/core'
import { invoke } from '../../../services/backend'
import { deleteBatchWithPendingSync, flushCloudSyncQueue, pendingCloudAssetPaths } from '../../../services/cloudSyncQueue'
import type { Asset } from '../../../model'
import type { BatchMetadata } from '../types'
import { loadAssetSvg } from './assetSvgService'
import { clearAssetPreviewCache } from './assetPreviewService'

export type BatchRecord = { id: string; savedAt: string; assets: Asset[]; metadata?: BatchMetadata }
export type BatchLoadProgress = { completed: number; total: number }
export type BatchSummary = { id: string; savedAt: string; customerName: string; assetCount: number }
export type BatchListQuery = { page: number; pageSize: number; search?: string; dateFrom?: string; dateTo?: string }
export type BatchListResult = { records: BatchSummary[]; total: number; page: number; pageSize: number }

export function listHistoryBatches(query: BatchListQuery): Promise<BatchListResult> {
  if (!isTauri()) return Promise.resolve({ records: [], total: 0, page: 1, pageSize: query.pageSize })
  return invoke('list_batches', { query })
}

export function deleteHistoryBatch(id: string): Promise<void> {
  return deleteBatchWithPendingSync(id)
}

export function discardTemporaryAssets(assets: Asset[]): Promise<void> {
  // Returning to history only needs file references for temporary-file cleanup.
  // Sending the SVGs back would reintroduce a batch-sized IPC request.
  const pending = pendingCloudAssetPaths()
  const unused = assets.filter(asset => !asset.storagePath || !pending.has(asset.storagePath))
  return unused.length ? invoke('discard_temp_assets', { assets: unused.map(asset => ({ ...asset, svg: '', previewUrl: '', thumbnailUrl: '' })) }) : Promise.resolve()
}

export async function loadHistoryBatch(id: string, onProgress?: (progress: BatchLoadProgress) => void): Promise<BatchRecord> {
  await flushCloudSyncQueue(id)
  const record = await invoke<BatchRecord>('load_batch', { id })
  clearAssetPreviewCache(id)
  const assets: Asset[] = []
  onProgress?.({ completed: 0, total: record.assets.length })
  // Normal history is a metadata manifest. Visible cards and editing actions
  // read their own source files instead of blocking on every SVG in the batch.
  // Older local records can contain inline-only artwork without a saved path;
  // hydrate only those records so saving/grouping never loses their source.
  for (const asset of record.assets) {
    if (!asset.svg && !asset.storagePath) {
      try { assets.push({ ...asset, svg: await loadAssetSvg(asset, id) }) }
      catch (error) { throw new Error(`无法加载 ${asset.name}：${String(error)}`) }
    } else {
      assets.push(asset)
    }
  }
  onProgress?.({ completed: assets.length, total: record.assets.length })
  return { ...record, assets }
}
