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
  error?: string
  /** Keep the snapshot for recovery, but never upload it after a delete request. */
  deletionRequested?: boolean
}

export type CloudSyncStatus = { state: 'idle' | 'queued' | 'syncing' | 'error'; pending: number; error?: string }
export type CloudBatchSaveResult = { batchId?: string; assets?: unknown[]; metadata?: unknown; duplicate?: boolean }
export type CloudBatchSaveComplete = { id: string; revision: string; submitted: CloudBatchSaveArgs; result: CloudBatchSaveResult }
const STORAGE_KEY = 'printflow-cloud-sync-queue-v1'
const RETRY_DELAYS = [2_000, 5_000, 15_000, 30_000, 60_000]
const listeners = new Set<(status: CloudSyncStatus) => void>()
const saveListeners = new Set<(event: CloudBatchSaveComplete) => void>()
let runner: Promise<void> | undefined
let inFlight: QueueEntry | undefined
let inFlightDone: Promise<void> | undefined
const deletions = new Map<string, Promise<void>>()
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
  lastError = error ?? readQueue().find(entry => entry.error)?.error ?? ''
  const status = { state: lastError && state === 'queued' ? 'error' as const : state, pending, ...(lastError ? { error: lastError } : {}) }
  for (const listener of listeners) listener(status)
  window.dispatchEvent(new CustomEvent<CloudSyncStatus>('printflow-cloud-sync', { detail: status }))
}
export function onCloudSyncStatus(listener: (status: CloudSyncStatus) => void) {
  listeners.add(listener)
  const entries = readQueue()
  const error = entries.find(entry => entry.error)?.error || lastError || (entries.some(entry => entry.deletionRequested) ? '批次删除尚未完成，待同步修改已保留，请重试删除' : '')
  listener({ state: error ? 'error' : entries.length ? 'queued' : 'idle', pending: entries.length, ...(error ? { error } : {}) })
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
      const available = entries.filter(item => !item.deletionRequested)
      const entry = available.find(item => item.nextAttemptAt <= Date.now())
      if (!entry) {
        const next = available.reduce<number | undefined>((value, item) => value === undefined ? item.nextAttemptAt : Math.min(value, item.nextAttemptAt), undefined)
        if (next !== undefined) scheduleRetry(next)
        const interruptedDelete = entries.some(item => item.deletionRequested && !deletions.has(item.args.id))
        emit(interruptedDelete ? 'error' : entries.length ? 'queued' : 'idle', entries.length,
          interruptedDelete ? '批次删除尚未完成，待同步修改已保留，请重试删除' : undefined)
        return
      }
      inFlight = entry
      let finishFlight!: () => void
      inFlightDone = new Promise(resolve => { finishFlight = resolve })
      try {
        if (!(await storageMode()).shared) { scheduleRetry(Date.now() + 10_000); emit('queued', entries.length); return }
        if (readQueue().find(item => item.key === entry.key)?.deletionRequested) continue
        emit('syncing', entries.length)
        const result = await invoke<CloudBatchSaveResult>('save_batch', entry.args as Record<string, unknown>)
        // A newer edit may have replaced this entry while the network call
        // was in flight. Only remove the exact revision that was uploaded.
        const current = readQueue().find(item => item.key === entry.key)
        // Deletion waits for this native call, then removes the batch. Retain
        // its files/snapshot if deletion fails or the application closes.
        if (current?.deletionRequested) continue
        const acknowledged = current?.revision === entry.revision
        const remaining = acknowledged
          ? readQueue().filter(item => item.key !== entry.key)
          : readQueue().map(item => item.key === entry.key ? { ...item, attempts: 0, nextAttemptAt: Date.now(), error: undefined } : item)
        writeQueue(remaining)
        if (acknowledged && entry.args.preserveTempAssets) {
          const staged = entry.args.assets.filter(asset => asset && typeof asset === 'object' && typeof (asset as { storagePath?: unknown }).storagePath === 'string')
          if (staged.length) void invoke('discard_temp_assets', { assets: staged }).catch(error => console.warn('共享批次同步后的临时图片清理失败', error))
        }
        lastError = ''
        // Obsolete replies may advance the backend version, but must not
        // restore an older snapshot in an editor that has already moved on.
        if (acknowledged) {
          const completed: CloudBatchSaveComplete = { id: entry.args.id, revision: entry.revision, submitted: entry.args, result }
          for (const listener of saveListeners) {
            try { listener(completed) } catch (error) { console.warn('共享批次同步完成通知失败', error) }
          }
          window.dispatchEvent(new CustomEvent<CloudBatchSaveComplete>('printflow-cloud-batch-saved', { detail: completed }))
        }
        emit(remaining.length ? 'queued' : 'idle', remaining.length)
      } catch (error) {
        const current = readQueue().find(item => item.key === entry.key)
        if (!current || current.deletionRequested) continue
        // Failure belongs to the attempted revision, not a newer edit waiting
        // behind it. Send the newer snapshot without inheriting the old backoff.
        if (current.revision !== entry.revision) continue
        const attempts = current.attempts + 1
        const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
        const next = readQueue().map(item => item.key === entry.key ? { ...item, attempts, nextAttemptAt: Date.now() + delay, error: String(error) } : item)
        writeQueue(next)
        emit('error', next.length, String(error))
        // A failed batch keeps its files and retry state, but must not prevent
        // other batches from reaching the cloud. The next loop schedules the
        // earliest remaining retry after all currently ready work is handled.
      } finally {
        inFlight = undefined
        inFlightDone = undefined
        finishFlight()
      }
    }
  })().finally(() => { runner = undefined })
  return runner
}
export function enqueueCloudBatchSave(args: CloudBatchSaveArgs) {
  const entries = readQueue().filter(entry => entry.key !== `save_batch:${args.id}`)
  entries.push({ key: `save_batch:${args.id}`, command: 'save_batch', args: { ...args, preserveTempAssets: true }, revision: crypto.randomUUID(), attempts: 0, nextAttemptAt: Date.now(), ...(deletions.has(args.id) ? { deletionRequested: true } : {}) })
  writeQueue(entries)
  emit('queued', entries.length)
  void runQueue()
}
export function clearCloudBatchSave(id: string) {
  const remaining = readQueue().filter(entry => entry.key !== `save_batch:${id}`)
  writeQueue(remaining)
  if (!remaining.length && retryTimer !== undefined) { window.clearTimeout(retryTimer); retryTimer = undefined }
  emit(remaining.length ? 'queued' : 'idle', remaining.length)
}
/** Cancel saves only for the deleted batch; a failed upload must not block deletion. */
export function deleteBatchWithPendingSync(id: string): Promise<void> {
  const existing = deletions.get(id)
  if (existing) return existing
  // Persist the intent before waiting: even a restart must not upload this
  // snapshot after a delete that may already have committed on the server.
  writeQueue(readQueue().map(entry => entry.args.id === id ? { ...entry, deletionRequested: true } : entry))
  const activeSave = inFlight?.args.id === id ? inFlightDone : undefined
  const operation = (async () => {
    await activeSave
    try {
      await invoke('delete_batch', { id })
      clearCloudBatchSave(id)
    } catch (error) {
      emit('error', readQueue().length, `批次删除未完成，待同步修改已保留，请重试删除：${String(error)}`)
      throw error
    } finally {
      deletions.delete(id)
      const available = readQueue().filter(entry => !entry.deletionRequested)
      if (available.length) scheduleRetry(Math.min(...available.map(entry => entry.nextAttemptAt)))
    }
  })()
  deletions.set(id, operation)
  return operation
}
/** Local cleanup must retain files referenced by queued or already running saves. */
export function pendingCloudAssetPaths(): Set<string> {
  const entries = readQueue()
  if (inFlight) entries.push(inFlight)
  return new Set(entries.flatMap(entry => entry.args.assets.flatMap(asset => {
    if (!asset || typeof asset !== 'object') return []
    const path = (asset as { storagePath?: unknown }).storagePath
    return typeof path === 'string' && path ? [path] : []
  })))
}
export async function flushCloudSyncQueue(batchId?: string) {
  if (batchId !== undefined) {
    const pending = readQueue().find(entry => entry.args.id === batchId)
    if (!pending) return
    if (pending.deletionRequested) throw new Error('批次删除尚未完成，待同步修改已保留，请重试删除')
    // Explicit actions only depend on their own batch. Subscribe before
    // starting work so unrelated uploads cannot delay a completed batch.
    writeQueue(readQueue().map(entry => entry.args.id === batchId ? { ...entry, nextAttemptAt: Date.now(), error: undefined } : entry))
    return new Promise<void>((resolve, reject) => {
      const check = (finished = false) => {
        const current = readQueue().find(entry => entry.args.id === batchId)
        const error = current?.deletionRequested
          ? '批次删除尚未完成，待同步修改已保留，请重试删除'
          : current?.error || (finished && current ? '云端同步尚未完成，请恢复连接后重试' : '')
        if (current && !error) return
        listeners.delete(listener)
        if (error) reject(new Error(error))
        else resolve()
      }
      const listener = () => check()
      listeners.add(listener)
      void runQueue().then(() => check(true))
    })
  }
  // Explicit save/confirm is a synchronization barrier, including entries that
  // were waiting for a retry. Background failures remain queued and visible.
  if (retryTimer !== undefined) { window.clearTimeout(retryTimer); retryTimer = undefined }
  writeQueue(readQueue().map(entry => ({ ...entry, nextAttemptAt: Date.now() })))
  await runQueue()
  if (readQueue().length) throw new Error(lastError || '云端同步尚未完成，请恢复连接后重试')
}

