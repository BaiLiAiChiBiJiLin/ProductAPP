import { invoke, isTauri } from '@tauri-apps/api/core'

export type BatchThumbnail = { assetId: string; name: string; url: string }

// A history page can contain many cards; decode only one card's previews at a
// time, and skip queued cards as soon as the user changes page or opens a batch.
let pending: Promise<void> = Promise.resolve()
export function loadBatchThumbnails(id: string, signal: AbortSignal): Promise<BatchThumbnail[]> {
  const request = pending.then(() => signal.aborted || !isTauri()
    ? [] : invoke<BatchThumbnail[]>('load_batch_thumbnails', { id }))
  pending = request.then(() => undefined, () => undefined)
  return request
}
