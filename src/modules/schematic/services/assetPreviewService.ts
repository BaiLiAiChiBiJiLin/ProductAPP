import { invoke } from '../../../services/backend'
import type { Asset } from '../../../model'

type Source = Pick<Asset, 'svg' | 'storagePath' | 'id'>
export type AssetPreviewPriority = { visible: boolean; order?: number }
type Priority = () => AssetPreviewPriority
type Read = { promise: Promise<string>; users: number; batchId?: string; priorities: Set<Priority>; cancelQueued: () => boolean }
type QueuedRead = { start: () => void; priority: Priority; sequence: number }
const pending = new Map<string, Read>()
const cached = new Map<string, { batchId?: string; url: string; bytes: number }>()
const MAX_CACHE_ENTRIES = 128
const MAX_CACHE_BYTES = 16 * 1024 * 1024
let cachedBytes = 0
const waiting: QueuedRead[] = []
let active = false
let sequence = 0
let pumpTimer: ReturnType<typeof setTimeout> | undefined

/** Reopening a history record must revalidate previews against its latest files. */
export function clearAssetPreviewCache(batchId?: string) {
  for (const [key, entry] of cached) {
    if (batchId !== undefined && entry.batchId !== batchId) continue
    cachedBytes -= entry.bytes
    cached.delete(key)
  }
  for (const [key, read] of pending) {
    if (batchId === undefined || read.batchId === batchId) pending.delete(key)
  }
}

function remember(key: string, batchId: string | undefined, url: string) {
  const bytes = (key.length + url.length) * 2
  if (bytes > MAX_CACHE_BYTES) return
  const previous = cached.get(key)
  if (previous) cachedBytes -= previous.bytes
  cached.delete(key)
  cached.set(key, { batchId, url, bytes })
  cachedBytes += bytes
  while (cached.size > MAX_CACHE_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
    const oldest = cached.entries().next().value
    if (!oldest) break
    cachedBytes -= oldest[1].bytes
    cached.delete(oldest[0])
  }
}

function cancelled() { return new DOMException('预览读取已取消', 'AbortError') }
function before(left: AssetPreviewPriority, right: AssetPreviewPriority) {
  if (left.visible !== right.visible) return left.visible
  const order = (value: AssetPreviewPriority) => Number.isFinite(value.order) ? value.order! : Infinity
  return order(left) < order(right)
}

function currentPriority(read: Read): AssetPreviewPriority {
  let best: AssetPreviewPriority = { visible: false }
  for (const priority of read.priorities) {
    const candidate = priority()
    if (before(candidate, best)) best = candidate
  }
  return best
}

function queuePump(delayMs = 16) {
  if (active || pumpTimer !== undefined || !waiting.length) return
  // Let IntersectionObserver deliver the latest viewport before choosing work.
  // Every dispatch reads live priorities; a scroll never freezes an old order.
  pumpTimer = setTimeout(() => {
    pumpTimer = undefined
    if (active || !waiting.length) return
    let nextIndex = 0
    let best = waiting[0].priority()
    for (let index = 1; index < waiting.length; index++) {
      const candidate = waiting[index].priority()
      if (before(candidate, best) || (!before(best, candidate) && waiting[index].sequence < waiting[nextIndex].sequence)) {
        nextIndex = index
        best = candidate
      }
    }
    const [next] = waiting.splice(nextIndex, 1)
    active = true
    next.start()
  }, delayMs)
}

function schedule(read: () => Promise<string>, priority: Priority) {
  let rejectQueued!: (reason: unknown) => void
  const queued: QueuedRead = { start: () => {}, priority, sequence: sequence++ }
  const promise = new Promise<string>((resolve, reject) => {
    rejectQueued = reject
    queued.start = () => {
      void Promise.resolve().then(read).then(resolve, reject).finally(() => { active = false; queuePump() })
    }
  })
  waiting.push(queued)
  queuePump(32)
  return { promise, cancelQueued: () => {
    const index = waiting.indexOf(queued)
    if (index < 0) return false // Running native work is allowed to finish.
    waiting.splice(index, 1)
    rejectQueued(cancelled())
    if (!waiting.length && pumpTimer !== undefined) { clearTimeout(pumpTimer); pumpTimer = undefined }
    return true
  } }
}

async function readPreview(asset: Source, batchId: string | undefined, maxEdgePx: number): Promise<string> {
  let result: string | undefined
  const temporary = asset.storagePath && /(?:^|[\\/])temp-assets[\\/][^\\/]+\.svg$/i.test(asset.storagePath)
  if (asset.storagePath && (temporary || !batchId)) {
    try { result = await invoke<string>('load_temp_asset_preview', { path: asset.storagePath, maxEdgePx }) }
    catch (error) { if (!batchId) throw error }
  }
  if (!result && batchId) result = await invoke<string>('load_batch_asset_preview', { batchId, assetId: asset.id, maxEdgePx })
  if (!result && !asset.storagePath && !batchId && asset.svg) {
    if (asset.svg.length > 256 * 1024) throw new Error('此图片需要源文件路径才能生成安全预览')
    result = await invoke<string>('load_inline_asset_preview', { svg: asset.svg, maxEdgePx })
  }
  if (typeof result !== 'string' || result.length > 2 * 1024 * 1024 || !result.startsWith('data:image/png;base64,')) throw new Error('图片预览暂不可用')
  return result
}

/** A serial preview pipeline never falls back to original SVGs in the WebView. */
export function loadAssetPreview(asset: Source, batchId?: string, maxEdgePx = 256, signal?: AbortSignal, priority?: Priority): Promise<string> {
  if (signal?.aborted) return Promise.reject(cancelled())
  const edge = Math.max(128, Math.min(512, maxEdgePx))
  const inline = !asset.storagePath && !batchId
  if (inline && asset.svg.length > 256 * 1024) return Promise.reject(new Error('此图片需要源文件路径才能生成安全预览'))
  const key = JSON.stringify([batchId ?? '', asset.id, asset.storagePath ?? '', edge, inline ? asset.svg : ''])
  const cachedPreview = cached.get(key)
  if (cachedPreview) {
    cached.delete(key)
    cached.set(key, cachedPreview)
    return Promise.resolve(cachedPreview.url)
  }
  let read = pending.get(key)
  if (!read) {
    const source = { id: asset.id, storagePath: asset.storagePath, svg: inline ? asset.svg : '' }
    const next: Read = { users: 0, promise: Promise.resolve(''), batchId, priorities: new Set(), cancelQueued: () => false }
    const scheduled = schedule(() => next.users ? readPreview(source, batchId, edge) : Promise.reject(cancelled()), () => currentPriority(next))
    next.cancelQueued = scheduled.cancelQueued
    next.promise = scheduled.promise
      .then(url => { if (pending.get(key) === next) remember(key, batchId, url); return url })
    pending.set(key, next)
    const complete = () => { if (pending.get(key) === next) pending.delete(key) }
    void next.promise.then(complete, complete)
    read = next
  }
  const shared = read
  const getPriority = () => priority?.() ?? { visible: true }
  shared.priorities.add(getPriority)
  shared.users++
  return new Promise((resolve, reject) => {
    let done = false
    const release = () => {
      if (done) return false
      done = true
      shared.users--
      shared.priorities.delete(getPriority)
      signal?.removeEventListener('abort', abort)
      if (!shared.users && shared.cancelQueued() && pending.get(key) === shared) pending.delete(key)
      return true
    }
    const abort = () => { if (release()) reject(cancelled()) }
    signal?.addEventListener('abort', abort, { once: true })
    void shared.promise.then(value => { if (release()) resolve(value) }, error => { if (release()) reject(error) })
  })
}
