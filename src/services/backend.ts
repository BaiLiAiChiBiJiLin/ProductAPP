import { invoke as nativeInvoke, isTauri } from '@tauri-apps/api/core'

export type StorageMode = { shared: boolean; environment: string; configPath: string; storageRoot?: string }
let modeRequest: Promise<StorageMode> | undefined
export function storageMode(): Promise<StorageMode> {
  if (!isTauri()) return Promise.resolve({ shared: false, environment: 'browser', configPath: '' })
  modeRequest ??= nativeInvoke<StorageMode>('storage_mode').then(mode => { if (typeof mode?.shared !== 'boolean') throw new Error('存储模式响应无效，请重启软件'); return mode }).catch(error => { modeRequest = undefined; throw error })
  return modeRequest
}
const sharedCommands = new Set([
  'save_batch', 'load_batch', 'list_batches', 'delete_batch', 'delete_asset', 'load_batch_asset_svg', 'load_batch_thumbnails',
  'initialize_shared_user', 'list_shared_transfer_users', 'shared_transfer_directory', 'preview_shared_batch_transfer', 'send_shared_batch', 'refresh_shared_transfers',
  'save_schematic_review', 'load_schematic_review', 'list_schematic_reviews', 'load_schematic_review_resource', 'delete_schematic_review', 'update_schematic_review_payment_status',
  'submit_schematic_review_to_imposition', 'list_pending_impositions', 'load_imposition_job', 'return_imposition_to_review', 'update_imposition_image_quantity', 'update_imposition_image_quantities',
  'load_storage_settings', 'save_storage_settings', 'load_cloud_pools', 'save_cloud_pools',
  'check_shared_storage', 'preview_cloud_migration', 'migrate_local_data', 'delete_local_data', 'cleanup_cloud_resources',
])
const writes = new Set(['save_batch', 'delete_batch', 'delete_asset', 'send_shared_batch', 'save_schematic_review', 'delete_schematic_review', 'update_schematic_review_payment_status', 'submit_schematic_review_to_imposition', 'return_imposition_to_review', 'update_imposition_image_quantity', 'update_imposition_image_quantities', 'save_cloud_pools'])
const versions = new Map<string, number>()
const listedVersions = new Map<string, number>()
const retries = new Map<string, { fingerprint: string; requestId: string; args: Args }>()
let userRequest: Promise<unknown> | undefined
let registeredName = ''

type Args = Record<string, unknown>
type Versioned = { version?: number; records?: Array<{ id: string; version?: number }> }
function recordKey(command: string, args: Args): string {
  if (command.includes('pools')) return 'pools:shared'
  if (command.includes('imposition') && command !== 'submit_schematic_review_to_imposition') return `job:${args.jobId ?? args.id ?? ''}`
  if (command.includes('schematic_review')) return `review:${args.id ?? (args.record as { id?: string } | undefined)?.id ?? ''}`
  return `batch:${args.batchId ?? args.id ?? ''}`
}
export function resetCloudSession() { userRequest = undefined; registeredName = ''; versions.clear(); listedVersions.clear(); retries.clear() }

export async function invoke<T>(command: string, args: Args = {}): Promise<T> {
  if (!sharedCommands.has(command) || !(await storageMode()).shared) return nativeInvoke<T>(command, args)
  const name = command === 'initialize_shared_user' ? String(args.userName ?? '') : localStorage.getItem('printflow-account-name')?.trim() ?? ''
  if (!name) throw new Error('请先设置用户名')
  if (!userRequest || registeredName !== name) {
    registeredName = name
    userRequest = nativeInvoke('cloud_operation', { command: 'initialize_shared_user', args: { userName: name } })
      .catch(error => { userRequest = undefined; throw error })
  }
  const initialized = await userRequest
  if (command === 'initialize_shared_user') return initialized as T
  if (command === 'load_batch_asset_svg' || command === 'load_schematic_review_resource') {
    return nativeInvoke<T>('cloud_resource', { command, args })
  }
  const key = recordKey(command, args)
  const listAction = ['delete_batch', 'delete_schematic_review', 'send_shared_batch', 'submit_schematic_review_to_imposition', 'return_imposition_to_review'].includes(command)
  const expectedVersion = (listAction ? listedVersions.get(key) : versions.get(key)) ?? versions.get(key) ?? 0
  const stableArgs = command === 'save_batch' ? { ...args, savedAt: undefined } : command === 'save_schematic_review' ? { ...args, record: { ...(args.record as Args), savedAt: undefined } } : args
  const fingerprint = writes.has(command) ? JSON.stringify([command, expectedVersion, stableArgs]) : ''
  const retryKey = `${command}:${key}`
  let retry = retries.get(retryKey)
  if (writes.has(command) && retry?.fingerprint !== fingerprint) {
    retry = { fingerprint, requestId: crypto.randomUUID(), args }
    retries.set(retryKey, retry)
  }
  // Errors propagate. A shared operation must never fall back to local SQLite.
  const response = await nativeInvoke<T | { result: T }>('cloud_operation', { command, args: retry?.args ?? args, expectedVersion, requestId: retry?.requestId })
  const result = writes.has(command) ? (response as { result: T }).result : response as T
  if (writes.has(command)) retries.delete(retryKey)
  const versioned = result as Versioned | null
  if (typeof versioned?.version === 'number') { versions.set(key, versioned.version); listedVersions.set(key, versioned.version) }
  const listKind = command === 'list_batches' ? 'batch' : command === 'list_schematic_reviews' ? 'review' : command === 'list_pending_impositions' ? 'job' : undefined
  if (listKind) for (const item of versioned?.records ?? []) {
    const itemKey = `${listKind}:${item.id}`
    if (typeof item.version === 'number') listedVersions.set(itemKey, item.version)
    // Listing must not advance an open editor's revision behind its back.
    if (!versions.has(itemKey) && typeof item.version === 'number') versions.set(itemKey, item.version)
  }
  if (command === 'delete_batch' || command === 'delete_schematic_review' || command === 'send_shared_batch') versions.delete(key)
  if (command === 'save_batch' && Array.isArray(args.assets)) {
    const temporary = args.assets.filter(asset => asset && typeof asset === 'object' && asset.storagePath).map(asset => ({ id: asset.id, name: asset.name, width: asset.width, height: asset.height, productId: asset.productId, svg: '', storagePath: asset.storagePath }))
    if (temporary.length) void nativeInvoke('discard_temp_assets', { assets: temporary }).catch(error => console.warn('已保存批次的临时图片清理失败', error))
  }
  return result
}
