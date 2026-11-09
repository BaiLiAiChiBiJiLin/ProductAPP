import { invoke, storageMode } from './backend'
import { classifyCloudSyncError } from './cloudSyncErrors'
import { LocalSyncState } from './localSyncState'

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
  blocked?: boolean
  /** Keep the snapshot for recovery, but never upload it after a delete request. */
  deletionRequested?: boolean
}

export type CloudSyncStatus = { state: 'idle' | 'queued' | 'syncing' | 'error' | 'blocked'; pending: number; error?: string }
export type CloudSyncTask = { id: string; name: string; customerName?: string; operation: 'save_batch' | 'delete_batch'; assetCount: number; state: Exclude<CloudSyncStatus['state'], 'idle'>; attempts: number; error?: string; action?: string; blocked: boolean; deletionRequested?: boolean; nextAttemptAt?: number }
export type CloudBatchSaveResult = { batchId?: string; assets?: unknown[]; metadata?: unknown; duplicate?: boolean }
export type CloudBatchSaveComplete = { id: string; revision: string; submitted: CloudBatchSaveArgs; result: CloudBatchSaveResult }
const STORAGE_KEY = 'printflow-cloud-sync-queue-v1'
const queueStore = new LocalSyncState<QueueEntry[]>('cloud-sync-queue', 'batches', STORAGE_KEY, () => [],
  (value): value is QueueEntry[] => Array.isArray(value) && value.every(entry => entry && typeof entry === 'object'
    && typeof entry.key === 'string' && entry.command === 'save_batch' && typeof entry.revision === 'string'
    && typeof entry.attempts === 'number' && Number.isFinite(entry.attempts) && entry.attempts >= 0
    && typeof entry.nextAttemptAt === 'number' && Number.isFinite(entry.nextAttemptAt)
    && (entry.error === undefined || typeof entry.error === 'string')
    && (entry.blocked === undefined || typeof entry.blocked === 'boolean')
    && (entry.deletionRequested === undefined || typeof entry.deletionRequested === 'boolean')
    && entry.args && typeof entry.args.id === 'string' && Array.isArray(entry.args.assets)))
const RETRY_DELAYS = [2_000, 5_000, 15_000, 30_000, 60_000]
const listeners = new Set<(status: CloudSyncStatus) => void>()
const saveListeners = new Set<(event: CloudBatchSaveComplete) => void>()
let runner: Promise<void> | undefined
let inFlight: QueueEntry | undefined
let inFlightDone: Promise<void> | undefined
const deletions = new Map<string, Promise<void>>()
let retryTimer: number | undefined
let lastError = ''
let initialization: Promise<void> | undefined
const persistenceFailures = new Map<string, QueueEntry>()
const retainedAssetPaths = new Map<string, number>()
const requestedRevisions = new Map<string, string>()
const deferredCleanup = new Map<string, unknown>()
const pendingEnqueues = new Map<string, QueueEntry>()

const isLatestRequested = (entry: QueueEntry) => !requestedRevisions.has(entry.args.id) || requestedRevisions.get(entry.args.id) === entry.revision

function readQueue() {
  try { return queueStore.snapshot() }
  catch { return [] } // ready()/update() surface invalid recovery data without deleting it.
}
function visibleQueue() {
  const entries = new Map(readQueue().map(entry => [entry.args.id, entry]))
  for (const [id, entry] of persistenceFailures) entries.set(id, entry)
  return [...entries.values()]
}
function readyQueue() {
  initialization ??= queueStore.ready().then(async () => {
    // Previous versions stored large request logs in the WebView quota. Once
    // the queue has migrated, those failures can be retried from local files.
    const recoverable = (entry: QueueEntry) => !entry.deletionRequested && !!entry.error && classifyCloudSyncError(entry.error).kind === 'local-storage'
    if (readQueue().some(recoverable)) await queueStore.update(entries => entries.map(entry => recoverable(entry)
      ? { ...entry, error: undefined, blocked: false, nextAttemptAt: Date.now() } : entry))
  }).catch(error => { initialization = undefined; throw error })
  return initialization
}
class QueuePersistenceError extends Error {
  constructor(error: unknown) { super(`本地同步队列写入失败，请保留当前页面后重试：${error instanceof Error ? error.message : String(error)}`) }
}
async function updateQueue(change: (entries: QueueEntry[]) => QueueEntry[], failedEntry?: QueueEntry | (() => QueueEntry | undefined), replaceFailure = false) {
  try { return await queueStore.update(change) }
  catch (error) {
    const failure = new QueuePersistenceError(error)
    const entry = typeof failedEntry === 'function' ? failedEntry() : failedEntry
    if (entry && (replaceFailure || !persistenceFailures.has(entry.args.id))) {
      persistenceFailures.set(entry.args.id, { ...entry, blocked: true, error: String(failure) })
    }
    emit('blocked', visibleQueue().length, String(failure))
    throw failure
  }
}
const isBlocked = (entry: QueueEntry) => entry.blocked || !!entry.error && !classifyCloudSyncError(entry.error).retryable
export function cloudSyncTasks(): CloudSyncTask[] {
  return visibleQueue().map(entry => {
    const failure = entry.error ? classifyCloudSyncError(entry.error) : undefined
    const metadata = entry.args.metadata as { customerName?: unknown } | undefined
    const customerName = typeof metadata?.customerName === 'string' ? metadata.customerName.trim() : undefined
    const blocked = !!entry.deletionRequested || !!isBlocked(entry)
    const state = blocked ? 'blocked' : inFlight?.revision === entry.revision ? 'syncing' : entry.error ? 'error' : 'queued'
    return { id: entry.args.id, name: customerName || entry.args.id, customerName, operation: entry.deletionRequested ? 'delete_batch' : 'save_batch',
      assetCount: entry.args.assets.length, state, attempts: entry.attempts,
      error: entry.error, action: entry.deletionRequested ? '删除尚未完成，请在历史记录中重试删除。' : failure?.action,
      blocked,
      deletionRequested: entry.deletionRequested,
      ...(!entry.deletionRequested && !isBlocked(entry) && entry.error ? { nextAttemptAt: entry.nextAttemptAt } : {}) }
  })
}
function emit(state: CloudSyncStatus['state'], _pending = visibleQueue().length, error?: string) {
  const entries = visibleQueue()
  const pending = entries.length
  lastError = error ?? entries.find(entry => entry.error)?.error ?? ''
  const blocked = entries.some(entry => isBlocked(entry) || entry.deletionRequested && !deletions.has(entry.args.id))
  const status = { state: state !== 'syncing' && blocked ? 'blocked' as const : lastError && state === 'queued' ? 'error' as const : state, pending, ...(lastError ? { error: lastError } : {}) }
  for (const listener of listeners) {
    try { listener(status) } catch { console.warn('同步状态通知失败') }
  }
  window.dispatchEvent(new CustomEvent<CloudSyncStatus>('printflow-cloud-sync', { detail: status }))
}
export function onCloudSyncStatus(listener: (status: CloudSyncStatus) => void) {
  listeners.add(listener)
  const entries = visibleQueue()
  const error = entries.find(entry => entry.error)?.error || lastError || (entries.some(entry => entry.deletionRequested) ? '批次删除尚未完成，待同步修改已保留，请重试删除' : '')
  listener({ state: entries.some(entry => isBlocked(entry) || entry.deletionRequested) ? 'blocked' : error ? 'error' : entries.length ? 'queued' : 'idle', pending: entries.length, ...(error ? { error } : {}) })
  void readyQueue().then(() => { if (listeners.has(listener)) emit(inFlight ? 'syncing' : visibleQueue().length ? 'queued' : 'idle') })
    .catch(error => { if (listeners.has(listener)) emit('blocked', visibleQueue().length, String(error)) })
  return () => { listeners.delete(listener) }
}
export function onCloudBatchSaveComplete(listener: (event: CloudBatchSaveComplete) => void) {
  saveListeners.add(listener)
  return () => { saveListeners.delete(listener) }
}
function scheduleRetry(at: number) {
  if (retryTimer !== undefined) window.clearTimeout(retryTimer)
  retryTimer = window.setTimeout(() => { retryTimer = undefined; startQueue() }, Math.max(250, Math.min(60_000, at - Date.now())))
}
function startQueue() { void runQueue().catch(error => { emit('blocked', readQueue().length, String(error)) }) }
async function runQueue(): Promise<void> {
  if (runner) return runner
  runner = (async () => {
    await readyQueue()
    await queueStore.flush()
    while (true) {
      const entries = readQueue()
      const available = entries.filter(item => isLatestRequested(item) && !item.deletionRequested && !deletions.has(item.args.id) && !persistenceFailures.has(item.args.id) && !isBlocked(item))
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
        const latest = readQueue().find(item => item.key === entry.key)
        if (!latest || !isLatestRequested(entry) || latest.revision !== entry.revision || latest.deletionRequested || deletions.has(entry.args.id) || persistenceFailures.has(entry.args.id)) continue
        emit('syncing', entries.length)
        const result = await invoke<CloudBatchSaveResult>('save_batch', entry.args as Record<string, unknown>)
        // A newer edit may have replaced this entry while the network call
        // was in flight. Only remove the exact revision that was uploaded.
        let acknowledged = false
        let deleting = false
        const remaining = await updateQueue(current => {
          const latest = current.find(item => item.key === entry.key)
          // Deletion waits for this native call. Retain the snapshot even if
          // the delete intent is still waiting for its own disk commit.
          deleting = !!latest?.deletionRequested || deletions.has(entry.args.id)
          if (deleting) return current
          acknowledged = latest?.revision === entry.revision && isLatestRequested(entry) && !persistenceFailures.has(entry.args.id)
          return acknowledged ? current.filter(item => item.key !== entry.key)
            : current.map(item => item.key === entry.key ? { ...item, attempts: 0, nextAttemptAt: Date.now(), error: undefined } : item)
        }, () => readQueue().find(item => item.key === entry.key))
        if (deleting) continue
        acknowledged = acknowledged && isLatestRequested(entry)
        if (acknowledged && entry.args.preserveTempAssets) {
          for (const asset of entry.args.assets) {
            const path = asset && typeof asset === 'object' ? (asset as { storagePath?: unknown }).storagePath : undefined
            if (typeof path === 'string') deferredCleanup.set(path, asset)
          }
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
        if (error instanceof QueuePersistenceError) throw error
        const current = readQueue().find(item => item.key === entry.key)
        if (!current || !isLatestRequested(entry) || current.deletionRequested || deletions.has(entry.args.id) || persistenceFailures.has(entry.args.id)) continue
        // Failure belongs to the attempted revision, not a newer edit waiting
        // behind it. Send the newer snapshot without inheriting the old backoff.
        if (current.revision !== entry.revision) continue
        const attempts = current.attempts + 1
        const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
        // Spread reconnects from multiple workstations without increasing the 60 s cap.
        const jittered = Math.min(60_000, Math.ceil(delay * (1 + Math.random() * 0.2)))
        const failure = classifyCloudSyncError(error)
        let failureSaved = false
        const next = await updateQueue(entries => entries.map(item => {
          if (item.key !== entry.key || !isLatestRequested(entry) || item.revision !== entry.revision || item.deletionRequested || deletions.has(item.args.id)) return item
          failureSaved = true
          return { ...item, attempts, nextAttemptAt: Date.now() + jittered, error: String(error), blocked: !failure.retryable }
        }), () => readQueue().find(item => item.key === entry.key))
        if (!failureSaved) continue
        emit('error', next.length, String(error))
        // A failed batch keeps its files and retry state, but must not prevent
        // other batches from reaching the cloud. The next loop schedules the
        // earliest remaining retry after all currently ready work is handled.
      } finally {
        inFlight = undefined
        inFlightDone = undefined
        finishFlight()
        cleanDeferredAssets()
      }
    }
  })().finally(() => { runner = undefined })
  return runner
}
export async function enqueueCloudBatchSave(args: CloudBatchSaveArgs) {
  const detached = JSON.parse(JSON.stringify({ ...args, preserveTempAssets: true })) as CloudBatchSaveArgs
  const entry: QueueEntry = { key: `save_batch:${args.id}`, command: 'save_batch', args: detached, revision: crypto.randomUUID(), attempts: 0, nextAttemptAt: Date.now() }
  requestedRevisions.set(args.id, entry.revision)
  pendingEnqueues.set(entry.revision, entry)
  try { await readyQueue() }
  catch (error) {
    const failure = new QueuePersistenceError(error)
    persistenceFailures.set(args.id, { ...entry, error: String(failure), blocked: true })
    pendingEnqueues.delete(entry.revision)
    emit('blocked', visibleQueue().length, String(failure))
    throw failure
  }
  const previousFailure = persistenceFailures.get(args.id)
  let entries: QueueEntry[]
  try {
    entries = await updateQueue(current => [...current.filter(item => item.key !== entry.key),
      { ...entry, ...(deletions.has(args.id) || current.find(item => item.key === entry.key)?.deletionRequested ? { deletionRequested: true } : {}) }], entry, true)
  } finally { pendingEnqueues.delete(entry.revision) }
  if (persistenceFailures.get(args.id) === previousFailure) persistenceFailures.delete(args.id)
  emit('queued', entries.length)
  startQueue()
}
export async function clearCloudBatchSave(id: string) {
  const failed = persistenceFailures.get(id)
  await readyQueue()
  const remaining = await updateQueue(current => current.filter(entry => entry.key !== `save_batch:${id}`), () => visibleQueue().find(entry => entry.args.id === id))
  if (persistenceFailures.get(id) === failed) persistenceFailures.delete(id)
  if (!remaining.length && retryTimer !== undefined) { window.clearTimeout(retryTimer); retryTimer = undefined }
  emit(remaining.length ? 'queued' : 'idle', remaining.length)
  cleanDeferredAssets()
}
/** Cancel saves only for the deleted batch; a failed upload must not block deletion. */
export function deleteBatchWithPendingSync(id: string): Promise<void> {
  const existing = deletions.get(id)
  if (existing) return existing
  const operation = (async () => {
    try {
      await readyQueue()
      // Persist the intent before any native delete. The in-memory deletion
      // map also pauses this batch while the intent is being committed.
      await updateQueue(current => {
        const failed = persistenceFailures.get(id)
        const entries = failed && !current.some(entry => entry.args.id === id) ? [...current, failed] : current
        return entries.map(entry => entry.args.id === id ? { ...entry, deletionRequested: true } : entry)
      }, () => visibleQueue().find(entry => entry.args.id === id))
      persistenceFailures.delete(id)
      await (inFlight?.args.id === id ? inFlightDone : undefined)
      await invoke('delete_batch', { id })
      await clearCloudBatchSave(id)
    } catch (error) {
      const message = `批次删除未完成，待同步修改已保留，请重试删除：${String(error)}`
      if (!(error instanceof QueuePersistenceError)) await updateQueue(current => current.map(entry => entry.args.id === id ? { ...entry, error: message } : entry), () => visibleQueue().find(entry => entry.args.id === id))
      emit('error', readQueue().length, message)
      throw error
    } finally {
      deletions.delete(id)
      const available = readQueue().filter(entry => !entry.deletionRequested && !isBlocked(entry))
      if (available.length) scheduleRetry(Math.min(...available.map(entry => entry.nextAttemptAt)))
    }
  })()
  deletions.set(id, operation)
  return operation
}
/** Local cleanup must retain files referenced by queued or already running saves. */
export function pendingCloudAssetPaths(): Set<string> {
  const entries = [...visibleQueue(), ...pendingEnqueues.values()]
  if (inFlight) entries.push(inFlight)
  return new Set([...retainedAssetPaths.keys(), ...entries.flatMap(entry => entry.args.assets.flatMap(asset => {
    if (!asset || typeof asset !== 'object') return []
    const path = (asset as { storagePath?: unknown }).storagePath
    return typeof path === 'string' && path ? [path] : []
  }))])
}
function cleanDeferredAssets() {
  if (!deferredCleanup.size) return
  const protectedPaths = pendingCloudAssetPaths()
  const ready = [...deferredCleanup].filter(([path]) => !protectedPaths.has(path))
  if (!ready.length) return
  for (const [path] of ready) deferredCleanup.delete(path)
  void invoke('discard_temp_assets', { assets: ready.map(([, asset]) => asset) }).catch(error => {
    for (const [path, asset] of ready) if (!deferredCleanup.has(path)) deferredCleanup.set(path, asset)
    console.warn('共享批次同步后的临时图片清理失败', error)
  })
}
/** Keep queued originals alive while an editor hydrates or copies them. */
export function retainCloudAssetPaths(paths: Iterable<string>): () => void {
  const retained = new Set(paths)
  for (const path of retained) retainedAssetPaths.set(path, (retainedAssetPaths.get(path) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    for (const path of retained) {
      const count = (retainedAssetPaths.get(path) ?? 1) - 1
      if (count > 0) retainedAssetPaths.set(path, count)
      else retainedAssetPaths.delete(path)
    }
    cleanDeferredAssets()
  }
}
export async function flushCloudSyncQueue(batchId?: string) {
  await readyQueue()
  if (batchId !== undefined) {
    const pending = visibleQueue().find(entry => entry.args.id === batchId)
    if (!pending) return
    if (pending.deletionRequested) throw new Error('批次删除尚未完成，待同步修改已保留，请重试删除')
    // Explicit actions only depend on their own batch. Subscribe before
    // starting work so unrelated uploads cannot delay a completed batch.
    const failed = persistenceFailures.get(batchId)
    await updateQueue(current => {
      const latest = current.find(entry => entry.args.id === batchId)
      if (latest?.deletionRequested || deletions.has(batchId)) return current
      const entries = failed ? [...current.filter(entry => entry.args.id !== batchId), failed] : current
      return entries.map(entry => entry.args.id === batchId ? { ...entry, nextAttemptAt: Date.now(), error: undefined, blocked: false } : entry)
    }, pending)
    if (persistenceFailures.get(batchId) === failed) persistenceFailures.delete(batchId)
    return new Promise<void>((resolve, reject) => {
      const check = (finished = false) => {
        const current = visibleQueue().find(entry => entry.args.id === batchId)
        if (!current && [...pendingEnqueues.values()].some(entry => entry.args.id === batchId)) return
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
      void runQueue().then(() => check(true), error => { listeners.delete(listener); reject(error) })
    })
  }
  // Explicit save/confirm is a synchronization barrier, including entries that
  // were waiting for a retry. Background failures remain queued and visible.
  if (retryTimer !== undefined) { window.clearTimeout(retryTimer); retryTimer = undefined }
  const failed = new Map(persistenceFailures)
  await updateQueue(current => {
    const entries = new Map(current.map(entry => [entry.args.id, entry]))
    for (const [id, entry] of failed) if (!entries.get(id)?.deletionRequested && !deletions.has(id)) entries.set(id, entry)
    return [...entries.values()].map(entry => entry.deletionRequested ? entry : { ...entry, nextAttemptAt: Date.now(), error: undefined, blocked: false })
  })
  for (const [id, entry] of failed) if (persistenceFailures.get(id) === entry) persistenceFailures.delete(id)
  await runQueue()
  if (visibleQueue().length) throw new Error(lastError || '云端同步尚未完成，请恢复连接后重试')
}

/** Recover transient work on launch, reconnect and resume without resetting hard conflicts. */
export function startCloudSyncRecovery() {
  let lastWake = -Infinity
  let stopped = false
  const wake = () => {
    if (Date.now() - lastWake < 1_000 || document.visibilityState === 'hidden') return
    lastWake = Date.now()
    void (async () => {
      await readyQueue()
      if (stopped) return
      const entries = readQueue()
      if (!entries.some(entry => !entry.deletionRequested && !isBlocked(entry) && !persistenceFailures.has(entry.args.id))) return
      await updateQueue(current => current.map(entry => !entry.deletionRequested && !isBlocked(entry) && !persistenceFailures.has(entry.args.id) ? { ...entry, nextAttemptAt: Date.now() } : entry))
      if (stopped) return
      startQueue()
    })().catch(error => { emit('blocked', readQueue().length, String(error)) })
  }
  window.addEventListener('online', wake)
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', wake)
  wake()
  return () => {
    stopped = true
    window.removeEventListener('online', wake)
    window.removeEventListener('focus', wake)
    document.removeEventListener('visibilitychange', wake)
  }
}

