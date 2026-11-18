import type { Asset } from '../../../model'
import { invoke } from '../../../services/backend'
import { parseSnapshotArtwork } from './artworkSourceService'

const decoder = new TextDecoder('utf-8', { fatal: true })
const maxConcurrentReads = 2
let activeReads = 0
const waitingReads: Array<() => void> = []
type SharedRead = { promise: Promise<string>; users: number }
const pendingReads = new Map<string, SharedRead>()

function aborted() {
  const error = new Error('图片读取已取消')
  error.name = 'AbortError'
  return error
}

function scheduleRead(read: () => Promise<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = () => {
      activeReads += 1
      void Promise.resolve().then(read).then(resolve, reject).finally(() => {
        activeReads -= 1
        waitingReads.shift()?.()
      })
    }
    if (activeReads < maxConcurrentReads) start()
    else waitingReads.push(start)
  })
}

function subscribe(read: SharedRead, signal?: AbortSignal): Promise<string> {
  read.users += 1
  return new Promise((resolve, reject) => {
    let finished = false
    const release = () => {
      if (finished) return false
      finished = true
      read.users -= 1
      signal?.removeEventListener('abort', cancel)
      return true
    }
    const cancel = () => { if (release()) reject(aborted()) }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    void read.promise.then(value => { if (release()) resolve(value) }, error => { if (release()) reject(error) })
  })
}

async function readAssetSvg(asset: Pick<Asset, 'svg' | 'storagePath' | 'id'>, batchId?: string) {
  const temporary = asset.storagePath && /(?:^|[\\/])temp-assets[\\/][^\\/]+\.svg$/i.test(asset.storagePath)
  if (asset.storagePath && (!batchId || temporary)) {
    try {
      const bytes = await invoke<ArrayBuffer>('load_temp_asset_svg', { path: asset.storagePath })
      const svg = decoder.decode(bytes)
      if (svg) return svg
    } catch {
      // A background save can publish this asset and clean its temporary file
      // while its preview is queued. The persisted batch remains authoritative.
    }
  }
  if (batchId) {
    const bytes = await invoke<ArrayBuffer>('load_batch_asset_svg', { batchId, assetId: asset.id })
    const svg = decoder.decode(bytes)
    if (svg) return svg
    throw new Error('原始图片内容为空')
  }
  throw new Error('图片源文件不可访问')
}

/**
 * Read one artwork only when a component needs to display or edit it. During
 * large uploads the asset event intentionally contains metadata and a staged
 * file path instead of the SVG text itself.
 */
export function loadAssetSvg(asset: Pick<Asset, 'svg' | 'storagePath' | 'id'>, batchId?: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(aborted())
  const snapshot = parseSnapshotArtwork(asset.svg)
  if (snapshot) return invoke<ArrayBuffer>('load_schematic_review_resource', { id: snapshot.id, resourceId: snapshot.resourceId }).then(bytes => decoder.decode(bytes))
  if (asset.svg) return Promise.resolve(asset.svg)
  const key = JSON.stringify([batchId ?? '', asset.id, asset.storagePath ?? ''])
  let read = pendingReads.get(key)
  if (!read) {
    const source = { id: asset.id, storagePath: asset.storagePath, svg: asset.svg }
    const next: SharedRead = { promise: Promise.resolve(''), users: 0 }
    next.promise = scheduleRead(() => next.users ? readAssetSvg(source, batchId) : Promise.reject(aborted()))
    pendingReads.set(key, next)
    const complete = () => { if (pendingReads.get(key) === next) pendingReads.delete(key) }
    void next.promise.then(complete, complete)
    read = next
  }
  return subscribe(read, signal)
}
