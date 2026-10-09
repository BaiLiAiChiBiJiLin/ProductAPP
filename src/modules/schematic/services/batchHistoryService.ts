import { invoke, isTauri } from '@tauri-apps/api/core'
import type { Asset } from '../../../model'
import type { BatchMetadata } from '../types'

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
  return invoke('delete_batch', { id })
}

export function discardTemporaryAssets(assets: Asset[]): Promise<void> {
  // Returning to history only needs file references for temporary-file cleanup.
  // Sending the SVGs back would reintroduce a batch-sized IPC request.
  return invoke('discard_temp_assets', { assets: assets.map(asset => ({ ...asset, svg: '', previewUrl: '', thumbnailUrl: '' })) })
}

export async function loadHistoryBatch(id: string, onProgress?: (progress: BatchLoadProgress) => void): Promise<BatchRecord> {
  const record = await invoke<BatchRecord>('load_batch', { id })
  const assets: Asset[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  onProgress?.({ completed: 0, total: record.assets.length })
  // Await each response before reading the next image. Promise.all would bring
  // back the same memory peak as one giant batch response in the WebView.
  for (const asset of record.assets) {
    try {
      const bytes = await invoke<ArrayBuffer>('load_batch_asset_svg', { batchId: id, assetId: asset.id })
      const svg = decoder.decode(bytes)
      if (!svg) throw new Error('原始图片内容为空')
      assets.push({ ...asset, svg })
    } catch (error) {
      throw new Error(`无法加载 ${asset.name}：${String(error)}`)
    }
    onProgress?.({ completed: assets.length, total: record.assets.length })
  }
  return { ...record, assets }
}
