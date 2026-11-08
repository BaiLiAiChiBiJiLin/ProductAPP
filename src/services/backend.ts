import { CloudWriteJournal, type PendingCloudWrite } from './cloudWriteJournal'
import { classifyCloudSyncError } from './cloudSyncErrors'
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
type Args = Record<string, unknown>
type Versioned = { version?: number; records?: Array<{ id: string; version?: number }> }
type CloudSession = {
  journal: CloudWriteJournal
  listedVersions: Map<string, number>
  tails: Map<string, Promise<unknown>>
  flights: Map<string, Promise<unknown>>
}
const sessions = new Map<string, CloudSession>()
let userRequest: Promise<unknown> | undefined
let registeredName = ''

function session(mode: StorageMode, name: string): CloudSession {
  const scope = JSON.stringify([mode.environment ?? '', mode.configPath ?? '', mode.storageRoot ?? '', name])
  let state = sessions.get(scope)
  if (!state) {
    state = { journal: new CloudWriteJournal(scope), listedVersions: new Map(), tails: new Map(), flights: new Map() }
    sessions.set(scope, state)
  }
  return state
}
function rememberListed(state: CloudSession, key: string, version: number) {
  state.listedVersions.set(key, Math.max(state.listedVersions.get(key) ?? 0, version))
}
function recordKey(command: string, args: Args): string {
  if (command.includes('pools')) return 'pools:shared'
  if (command.includes('imposition') && command !== 'submit_schematic_review_to_imposition') return `job:${args.jobId ?? args.id ?? ''}`
  if (command.includes('schematic_review')) return `review:${args.id ?? (args.record as { id?: string } | undefined)?.id ?? ''}`
  return `batch:${args.batchId ?? args.id ?? ''}`
}
function fingerprint(command: string, args: Args): string {
  const stableArgs = command === 'save_batch' ? { ...args, savedAt: undefined }
    : command === 'save_schematic_review' ? { ...args, record: { ...(args.record as Args), savedAt: undefined } } : args
  return JSON.stringify([command, stableArgs])
}
function expectedVersion(state: CloudSession, command: string, key: string): number {
  const listAction = ['delete_batch', 'delete_schematic_review', 'send_shared_batch', 'submit_schematic_review_to_imposition', 'return_imposition_to_review'].includes(command)
  return (listAction ? state.listedVersions.get(key) : state.journal.version(key)) ?? state.journal.version(key) ?? 0
}

// Registration resets must not discard requests whose cloud outcome is unknown.
export function resetCloudSession() {
  userRequest = undefined
  registeredName = ''
  for (const state of sessions.values()) state.listedVersions.clear()
}

async function sendWrite(state: CloudSession, key: string, pending: PendingCloudWrite): Promise<unknown> {
  let response: { result: unknown }
  try {
    response = await nativeInvoke('cloud_operation', {
      command: pending.command, args: pending.args,
      expectedVersion: pending.expectedVersion, requestId: pending.requestId,
    })
  } catch (error) {
    const failure = classifyCloudSyncError(error)
    // Only dispatch rejections after the server's idempotency lookup prove this
    // request did not commit. Configuration, identity and request-digest failures
    // can precede that lookup even when an earlier attempt already committed.
    const rejectedData = failure.kind === 'data' && /图片资产格式错误|批次没有图片|图片 ID 缺失或重复|缺少或无效字段|历史批次不存在|历史批次已删除/.test(failure.message)
    const rejectedVersion = failure.kind === 'conflict' && failure.message.startsWith('记录已被其他用户修改')
    if (failure.kind === 'source' || rejectedVersion || rejectedData) {
      state.journal.finish(key, pending.requestId)
    }
    throw error
  }
  if (!response || typeof response !== 'object' || !Object.hasOwn(response, 'result')) {
    throw new Error('云端保存响应无效，请稍后重试确认保存结果')
  }
  const result = response.result as Versioned | null
  const removed = ['delete_batch', 'delete_schematic_review', 'send_shared_batch'].includes(pending.command)
  // The acknowledgement and new base revision are persisted together. If this
  // fails, the original pending request remains available for another replay.
  state.journal.finish(key, pending.requestId, result?.version, removed)
  if (removed) state.listedVersions.delete(key)
  else if (typeof result?.version === 'number') rememberListed(state, key, result.version)
  return response.result
}

function write(state: CloudSession, key: string, command: string, args: Args): Promise<unknown> {
  const content = fingerprint(command, args)
  const flightKey = `${key}:${content}`
  const active = state.flights.get(flightKey)
  if (active && state.tails.get(key) === active) return active
  // Capture edits now: a queued call must not observe later caller mutations.
  const snapshot = JSON.parse(JSON.stringify(args)) as Args
  const previous = state.tails.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    const pending = state.journal.pending(key)
    if (pending) {
      if (!writes.has(pending.command) || recordKey(pending.command, pending.args) !== key || fingerprint(pending.command, pending.args) !== pending.fingerprint) {
        throw new Error('本地云端同步日志内容无效，请保留本地数据并联系管理员恢复')
      }
      try {
        const acknowledged = await sendWrite(state, key, pending)
        if (pending.fingerprint === content) return acknowledged
      } catch (error) {
        if (state.journal.pending(key) || pending.fingerprint === content) throw error
      }
    }
    const request = state.journal.begin(key, {
      command, fingerprint: content, requestId: crypto.randomUUID(),
      expectedVersion: expectedVersion(state, command, key), args: snapshot,
    }, ['save_batch', 'delete_batch', 'delete_asset', 'send_shared_batch'].includes(command))
    return sendWrite(state, key, request)
  })
  state.tails.set(key, operation)
  state.flights.set(flightKey, operation)
  const clear = () => {
    if (state.tails.get(key) === operation) state.tails.delete(key)
    if (state.flights.get(flightKey) === operation) state.flights.delete(flightKey)
  }
  void operation.then(clear, clear)
  return operation
}

function discardTemporaryAssets(command: string, args: Args) {
  if (command !== 'save_batch' || args.preserveTempAssets === true || !Array.isArray(args.assets)) return
  const temporary = args.assets.filter(asset => asset && typeof asset === 'object' && asset.storagePath).map(asset => ({ id: asset.id, name: asset.name, width: asset.width, height: asset.height, productId: asset.productId, svg: '', storagePath: asset.storagePath }))
  if (temporary.length) void nativeInvoke('discard_temp_assets', { assets: temporary }).catch(error => console.warn('已保存批次的临时图片清理失败', error))
}

export async function invoke<T>(command: string, args: Args = {}): Promise<T> {
  if (!sharedCommands.has(command)) return nativeInvoke<T>(command, args)
  const mode = await storageMode()
  if (!mode.shared) return nativeInvoke<T>(command, args)
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
  const state = session(mode, name)
  const key = recordKey(command, args)
  if (writes.has(command)) {
    const result = await write(state, key, command, args)
    discardTemporaryAssets(command, args)
    return result as T
  }
  // Errors propagate. A shared operation must never fall back to local SQLite.
  const result = await nativeInvoke<T>('cloud_operation', { command, args, expectedVersion: expectedVersion(state, command, key), requestId: undefined })
  const versioned = result as Versioned | null
  if (typeof versioned?.version === 'number' && versioned.version < (state.journal.version(key) ?? 0)) {
    throw new Error('读取的云端记录已过期，请重新打开或刷新后重试')
  }
  const revisions: Array<[string, number]> = []
  if (typeof versioned?.version === 'number') {
    revisions.push([key, versioned.version])
    rememberListed(state, key, versioned.version)
  }
  const listKind = command === 'list_batches' ? 'batch' : command === 'list_schematic_reviews' ? 'review' : command === 'list_pending_impositions' ? 'job' : undefined
  if (listKind) for (const item of versioned?.records ?? []) {
    const itemKey = `${listKind}:${item.id}`
    if (typeof item.version === 'number') {
      rememberListed(state, itemKey, item.version)
      // A list refresh cannot advance the base of an already opened editor.
      if (state.journal.version(itemKey) === undefined) revisions.push([itemKey, item.version])
    }
  }
  state.journal.remember(revisions)
  return result
}
