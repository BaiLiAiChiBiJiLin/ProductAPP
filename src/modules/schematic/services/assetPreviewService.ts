import { invoke } from '../../../services/backend'
import type { Asset } from '../../../model'
import { StagedArtwork } from './stagedArtworkService'
import { artworkVersion } from './artworkVersionService'
import { artworkSource, hasInlineArtwork } from './artworkSourceService'
import type { Item } from '../../../model'

type Source = Pick<Asset, 'svg' | 'storagePath' | 'id'> & { sourceSvg?: string; layerIds?: readonly string[]; artworkVariant?: Item['artworkVariant'] }
export type AssetPreviewPriority = { visible: boolean; order?: number; canvas?: boolean; interactive?: boolean }
type Priority = () => AssetPreviewPriority
type Read = { promise: Promise<string>; users: number; batchId?: string; priorities: Set<Priority>; cancelQueued: () => boolean }
type QueuedRead = { start: () => void; priority: Priority; sequence: number }
const pending = new Map<string, Read>()
const cached = new Map<string, { batchId?: string; url: string; bytes: number }>()
const MAX_CACHE_ENTRIES = 128
const MAX_CACHE_BYTES = 16 * 1024 * 1024
let cachedBytes = 0
const waiting: QueuedRead[] = []
let active = 0
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
  if (Boolean(left.interactive) !== Boolean(right.interactive)) return Boolean(left.interactive)
  if (Boolean(left.canvas) !== Boolean(right.canvas)) return Boolean(left.canvas)
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
  const cores = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4
  const slots = Math.max(1, Math.min(4, Math.floor(cores / 2)))
  if (active >= slots || pumpTimer !== undefined || !waiting.length) return
  // Let IntersectionObserver deliver the latest viewport before choosing work.
  // Every dispatch reads live priorities; a scroll never freezes an old order.
  pumpTimer = setTimeout(() => {
    pumpTimer = undefined
    while (active < slots && waiting.length) {
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
      active++
      next.start()
    }
  }, delayMs)
}

function schedule(read: () => Promise<string>, priority: Priority) {
  let rejectQueued!: (reason: unknown) => void
  const queued: QueuedRead = { start: () => {}, priority, sequence: sequence++ }
  const promise = new Promise<string>((resolve, reject) => {
    rejectQueued = reject
    queued.start = () => {
      void Promise.resolve().then(read).then(resolve, reject).finally(() => { active--; queuePump() })
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

async function readPreview(asset: Source, batchId: string | undefined, maxEdgePx: number, stagedInline: boolean): Promise<string> {
  let result: string | undefined
  if (asset.artworkVariant || (asset.svg && !hasInlineArtwork(asset.svg))) {
    const source = artworkSource(asset, { artworkVariant: asset.artworkVariant }, batchId)
    const resources = new StagedArtwork()
    try {
      if (hasInlineArtwork(source.svg) && source.svg.length > 256 * 1024) {
        source.svg = resources.reference(source.svg)
        await resources.write()
      }
      result = await invoke<string>('load_artwork_preview', { source, maxEdgePx })
      if (typeof result !== 'string' || result.length > 2 * 1024 * 1024 || !result.startsWith('data:image/png;base64,')) throw new Error('图片预览暂不可用')
      return result
    } finally { await resources.dispose() }
  }
  const temporary = asset.storagePath && /(?:^|[\\/])temp-assets[\\/][^\\/]+\.svg$/i.test(asset.storagePath)
  const canInline = hasInlineArtwork(asset.svg) && (stagedInline || asset.svg.length <= 256 * 1024)
  if (asset.storagePath && (temporary || !batchId)) {
    try { result = await invoke<string>('load_temp_asset_preview', { path: asset.storagePath, maxEdgePx }) }
    catch (error) { if (!batchId && !canInline) throw error }
  }
  if (!result && batchId) {
    try { result = await invoke<string>('load_batch_asset_preview', { batchId, assetId: asset.id, maxEdgePx }) }
    catch (error) { if (!canInline) throw error }
  }
  // Review snapshots own their artwork independently of the original batch.
  // A deleted/moved source path must not make restored artwork disappear.
  if (!result && canInline) {
    if (asset.svg.length > 256 * 1024) {
      if (!stagedInline) throw new Error('此图片需要源文件路径才能生成安全预览')
      const resources = new StagedArtwork()
      try {
        const reference = resources.reference(asset.svg)
        await resources.write()
        result = await invoke<string>('load_inline_asset_preview', { svg: reference, maxEdgePx })
      } finally { await resources.dispose() }
    } else result = await invoke<string>('load_inline_asset_preview', { svg: asset.svg, maxEdgePx })
  }
  if (typeof result !== 'string' || result.length > 2 * 1024 * 1024 || !result.startsWith('data:image/png;base64,')) throw new Error('图片预览暂不可用')
  return result
}

/** Bounded parallel previews never fall back to original SVGs in the WebView. */
export async function loadAssetPreview(asset: Source, batchId?: string, maxEdgePx = 256, signal?: AbortSignal, priority?: Priority, stagedInline = false): Promise<string> {
  if (signal?.aborted) return Promise.reject(cancelled())
  const edge = Math.max(128, Math.min(512, maxEdgePx))
  const inline = !asset.storagePath && !batchId
  if (inline && asset.svg.length > 256 * 1024 && !stagedInline) return Promise.reject(new Error('此图片需要源文件路径才能生成安全预览'))
  const version = asset.svg ? await artworkVersion(asset.svg) : ''
  const sourceVersion = asset.sourceSvg && asset.sourceSvg !== asset.svg ? await artworkVersion(asset.sourceSvg) : version
  if (signal?.aborted) throw cancelled()
  const key = JSON.stringify([batchId ?? '', asset.id, asset.storagePath ?? '', sourceVersion, asset.layerIds ?? ['all'], asset.artworkVariant, version, edge])
  const cachedPreview = cached.get(key)
  if (cachedPreview) {
    cached.delete(key)
    cached.set(key, cachedPreview)
    return Promise.resolve(cachedPreview.url)
  }
  let read = pending.get(key)
  if (!read) {
    const source = { id: asset.id, storagePath: asset.storagePath, artworkVariant: asset.artworkVariant, svg: inline || stagedInline || asset.svg.length <= 256 * 1024 || !hasInlineArtwork(asset.svg) ? asset.svg : '' }
    const next: Read = { users: 0, promise: Promise.resolve(''), batchId, priorities: new Set(), cancelQueued: () => false }
    const scheduled = schedule(() => next.users ? readPreview(source, batchId, edge, stagedInline) : Promise.reject(cancelled()), () => currentPriority(next))
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
