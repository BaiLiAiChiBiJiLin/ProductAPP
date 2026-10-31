import { invoke, storageMode } from './backend'

/** Shared-mode edits are coalesced locally and pushed after the editor is free. */
export type CloudBatchSaveArgs = {
  id: string
  savedAt: string
  assets: unknown[]
  metadata?: unknown
  /** Keep staged artwork until this queue revision has been acknowledged. */
  preserveTempAssets?: boolean
}

type QueueEntry = {
  key: string
  command: 'save_batch'
  args: CloudBatchSaveArgs
  revision: string
  attempts: number
  nextAttemptAt: number
}

export type CloudSyncStatus = { state: 'idle' | 'queued' | 'syncing' | 'error'; pending: number; error?: string }
export type CloudBatchSaveResult = { batchId?: string; assets?: unknown[]; metadata?: unknown; duplicate?: boolean }
export type CloudBatchSaveComplete = { id: string; revision: string; result: CloudBatchSaveResult }
const STORAGE_KEY = 'printflow-cloud-sync-queue-v1'
const RETRY_DELAYS = [2_000, 5_000, 15_000, 30_000, 60_000]
const listeners = new Set<(status: CloudSyncStatus) => void>()
const saveListeners = new Set<(event: CloudBatchSaveComplete) => void>()
let runner: Promise<void> | undefined
let retryTimer: number | undefined
let lastError = ''

function readQueue(): QueueEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && typeof (item as QueueEntry).key === 'string') as QueueEntry[] : []
  } catch { return [] }
}
function writeQueue(entries: QueueEntry[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)) }
  catch (error) { console.warn('云端同步队列无法持久化', error) }
}
function emit(state: CloudSyncStatus['state'], pending = readQueue().length, error?: string) {
  lastError = error ?? (state === 'error' ? lastError : '')
  const status = { state, pending, ...(lastError ? { error: lastError } : {}) }
  for (const listener of listeners) listener(status)
  window.dispatchEvent(new CustomEvent<CloudSyncStatus>('printflow-cloud-sync', { detail: status }))
}
export function onCloudSyncStatus(listener: (status: CloudSyncStatus) => void) {
  listeners.add(listener)
  listener({ state: readQueue().length ? 'queued' : 'idle', pending: readQueue().length, ...(lastError ? { error: lastError } : {}) })
  return () => { listeners.delete(listener) }
}
export function onCloudBatchSaveComplete(listener: (event: CloudBatchSaveComplete) => void) {
  saveListeners.add(listener)
  return () => { saveListeners.delete(listener) }
}
function scheduleRetry(at: number) {
  if (retryTimer !== undefined) window.clearTimeout(retryTimer)
  retryTimer = window.setTimeout(() => { retryTimer = undefined; void runQueue() }, Math.max(250, at - Date.now()))
}
async function runQueue(): Promise<void> {
  if (runner) return runner
  runner = (async () => {
    while (true) {
      const entries = readQueue()
      const entry = entries.find(item => item.nextAttemptAt <= Date.now())
      if (!entry) {
        const next = entries.reduce<number | undefined>((value, item) => value === undefined ? item.nextAttemptAt : Math.min(value, item.nextAttemptAt), undefined)
        if (next !== undefined) scheduleRetry(next)
        emit(entries.length ? 'queued' : 'idle', entries.length)
        return
      }
      try {
        if (!(await storageMode()).shared) { scheduleRetry(Date.now() + 10_000); emit('queued', entries.length); return }
        emit('syncing', entries.length)
        const result = await invoke<CloudBatchSaveResult>('save_batch', entry.args as Record<string, unknown>)
        // A newer edit may have replaced this entry while the network call
        // was in flight. Only remove the exact revision that was uploaded.
        const current = readQueue().find(item => item.key === entry.key)
        const acknowledged = current?.revision === entry.revision
        const remaining = acknowledged
          ? readQueue().filter(item => item.key !== entry.key)
          : readQueue().map(item => item.key === entry.key ? { ...item, attempts: 0, nextAttemptAt: Date.now() } : item)
        writeQueue(remaining)
        if (acknowledged && entry.args.preserveTempAssets) {
          const staged = entry.args.assets.filter(asset => asset && typeof asset === 'object' && typeof (asset as { storagePath?: unknown }).storagePath === 'string')
          if (staged.length) void invoke('discard_temp_assets', { assets: staged }).catch(error => console.warn('共享批次同步后的临时图片清理失败', error))
        }
        lastError = ''
        const completed: CloudBatchSaveComplete = { id: entry.args.id, revision: entry.revision, result }
        for (const listener of saveListeners) {
          try { listener(completed) } catch (error) { console.warn('共享批次同步完成通知失败', error) }
        }
        window.dispatchEvent(new CustomEvent<CloudBatchSaveComplete>('printflow-cloud-batch-saved', { detail: completed }))
        emit(remaining.length ? 'queued' : 'idle', remaining.length)
      } catch (error) {
        const current = readQueue().find(item => item.key === entry.key)
        if (!current) continue
        const attempts = current.attempts + 1
        const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
        const next = readQueue().map(item => item.key === entry.key ? { ...item, attempts, nextAttemptAt: Date.now() + delay } : item)
        writeQueue(next)
        emit('error', next.length, String(error))
        scheduleRetry(Date.now() + delay)
        return
      }
    }
  })().finally(() => { runner = undefined })
  return runner
}
export function enqueueCloudBatchSave(args: CloudBatchSaveArgs) {
  const entries = readQueue().filter(entry => entry.key !== `save_batch:${args.id}`)
  entries.push({ key: `save_batch:${args.id}`, command: 'save_batch', args: { ...args, preserveTempAssets: true }, revision: crypto.randomUUID(), attempts: 0, nextAttemptAt: Date.now() })
  writeQueue(entries)
  emit('queued', entries.length)
  void runQueue()
}
export function clearCloudBatchSave(id: string) {
  const remaining = readQueue().filter(entry => entry.key !== `save_batch:${id}`)
  writeQueue(remaining)
  emit(remaining.length ? 'queued' : 'idle', remaining.length)
}
export async function flushCloudSyncQueue() { await runQueue() }

