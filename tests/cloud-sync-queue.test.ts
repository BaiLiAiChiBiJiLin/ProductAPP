import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const api = vi.hoisted(() => ({ invoke: vi.fn(), storageMode: vi.fn() }))
vi.mock('../src/services/backend', () => api)

import { clearCloudBatchSave, cloudSyncTasks, deleteBatchWithPendingSync, enqueueCloudBatchSave, flushCloudSyncQueue, onCloudBatchSaveComplete, onCloudSyncStatus, pendingCloudAssetPaths, retainCloudAssetPaths, startCloudSyncRecovery } from '../src/services/cloudSyncQueue'

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  api.storageMode.mockResolvedValue({ shared: true })
})
afterEach(() => { localStorage.clear() })

test('uploads staged artwork in the background and cleans it only after the acknowledged revision', async () => {
  let resolveSave: ((value: unknown) => void) | undefined
  api.invoke.mockImplementation((command: string) => {
    if (command === 'save_batch') return new Promise(resolve => { resolveSave = resolve })
    if (command === 'discard_temp_assets') return Promise.resolve(undefined)
    throw new Error(`Unexpected command ${command}`)
  })
  const completed = vi.fn()
  const stop = onCloudBatchSaveComplete(completed)
  await enqueueCloudBatchSave({ id: 'batch-1', savedAt: 'now', assets: [{ id: 'asset-1', storagePath: 'temp-assets/asset-1.svg' }] })
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith('save_batch', expect.objectContaining({ preserveTempAssets: true })))
  expect(completed).not.toHaveBeenCalled()

  resolveSave?.({ batchId: 'batch-1', assets: [{ id: 'asset-1', storagePath: 'printflow:asset-1' }] })
  await flushCloudSyncQueue()

  expect(completed).toHaveBeenCalledWith(expect.objectContaining({
    id: 'batch-1',
    result: expect.objectContaining({ batchId: 'batch-1' }),
  }))
  expect(api.invoke).toHaveBeenCalledWith('discard_temp_assets', { assets: [{ id: 'asset-1', storagePath: 'temp-assets/asset-1.svg' }] })
  stop()
})

test('does not publish an obsolete save result while newer QT edits are waiting', async () => {
  const saves: Array<{ resolve: (value: unknown) => void; args: { assets: unknown[] } }> = []
  api.invoke.mockImplementation((command: string, args: { assets: unknown[] }) => {
    if (command === 'save_batch') return new Promise(resolve => { saves.push({ resolve, args }) })
    if (command === 'discard_temp_assets') return Promise.resolve(undefined)
    throw new Error(`Unexpected command ${command}`)
  })
  const completed = vi.fn()
  const stop = onCloudBatchSaveComplete(completed)
  const initial = [{ id: 'a', attributes: { QT: '10' } }, { id: 'b', attributes: { QT: '' } }]
  const latest = [{ id: 'a', attributes: { QT: '10' } }, { id: 'b', attributes: { QT: '20' } }]
  try {
    await enqueueCloudBatchSave({ id: 'batch-qt', savedAt: 'first', assets: initial })
    await vi.waitFor(() => expect(saves).toHaveLength(1))
    await enqueueCloudBatchSave({ id: 'batch-qt', savedAt: 'second', assets: latest })
    saves[0].resolve({ batchId: 'batch-qt', assets: initial })
    await vi.waitFor(() => expect(saves).toHaveLength(2))
    expect(completed).not.toHaveBeenCalled()
    expect(api.invoke).not.toHaveBeenCalledWith('discard_temp_assets', expect.anything())
    expect(saves[1].args.assets).toEqual(latest)
  } finally {
    saves[1]?.resolve({ batchId: 'batch-qt', assets: latest })
    await flushCloudSyncQueue()
    stop()
  }
  expect(completed).toHaveBeenCalledTimes(1)
  expect(completed).toHaveBeenLastCalledWith(expect.objectContaining({ result: { batchId: 'batch-qt', assets: latest } }))
})

test('a failed obsolete revision does not delay the newer save or mark it failed', async () => {
  vi.useFakeTimers()
  let rejectSave!: (reason: unknown) => void
  let attempts = 0
  api.invoke.mockImplementation((command: string) => {
    if (command !== 'save_batch') return Promise.resolve()
    if (++attempts === 1) return new Promise((_, reject) => { rejectSave = reject })
    return Promise.resolve({ batchId: 'batch-newer', assets: [] })
  })
  const status = vi.fn()
  const stop = onCloudSyncStatus(status)
  try {
    await enqueueCloudBatchSave({ id: 'batch-newer', savedAt: 'old', assets: ['old'] })
    await vi.waitFor(() => expect(rejectSave).toBeTypeOf('function'))
    await enqueueCloudBatchSave({ id: 'batch-newer', savedAt: 'new', assets: ['new'] })
    rejectSave(new Error('old request failed'))
    await flushCloudSyncQueue()
    expect(attempts).toBe(2)
    expect(status.mock.calls.some(([value]) => value.state === 'error')).toBe(false)
    expect(JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1') ?? '[]')).toEqual([])
  } finally {
    stop()
    await clearCloudBatchSave('batch-newer')
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

test('explicit flush reports a failed pending save and retries it immediately on the next attempt', async () => {
  vi.useFakeTimers()
  let offline = true
  api.invoke.mockImplementation((command: string) => command === 'save_batch' && offline
    ? Promise.reject(new Error('offline')) : Promise.resolve({ batchId: 'batch-retry', assets: [] }))
  try {
    await enqueueCloudBatchSave({ id: 'batch-retry', savedAt: 'now', assets: [] })
    await expect(flushCloudSyncQueue()).rejects.toThrow('offline')
    expect(JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1') ?? '[]')).toHaveLength(1)
    offline = false
    await flushCloudSyncQueue()
    expect(api.invoke.mock.calls.filter(([command]) => command === 'save_batch')).toHaveLength(2)
    expect(JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1') ?? '[]')).toEqual([])
  } finally {
    await clearCloudBatchSave('batch-retry')
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

test('deletion suspends later edits and suppresses late upload notifications and cleanup', async () => {
  let resolveSave!: (value: unknown) => void
  let finishDelete!: () => void
  api.invoke.mockImplementation((command: string) => {
    if (command === 'save_batch') return new Promise(resolve => { resolveSave = resolve })
    if (command === 'delete_batch') return new Promise<void>(resolve => { finishDelete = resolve })
    return Promise.resolve()
  })
  const completed = vi.fn()
  const stop = onCloudBatchSaveComplete(completed)
  try {
    await enqueueCloudBatchSave({ id: 'deleting', savedAt: 'old', assets: [{ storagePath: 'temp-assets/old.svg' }] })
    await vi.waitFor(() => expect(resolveSave).toBeTypeOf('function'))
    const deleting = deleteBatchWithPendingSync('deleting')
    expect(deleteBatchWithPendingSync('deleting')).toBe(deleting)
    await enqueueCloudBatchSave({ id: 'deleting', savedAt: 'new', assets: [{ storagePath: 'temp-assets/new.svg', attributes: { QT: '25' } }] })
    expect(api.invoke).not.toHaveBeenCalledWith('delete_batch', expect.anything())
    resolveSave({ batchId: 'deleting', assets: [] })
    await vi.waitFor(() => expect(finishDelete).toBeTypeOf('function'))
    expect(api.invoke.mock.calls.filter(([command]) => command === 'save_batch')).toHaveLength(1)
    expect(completed).not.toHaveBeenCalled()
    expect(api.invoke).not.toHaveBeenCalledWith('discard_temp_assets', expect.anything())
    expect(pendingCloudAssetPaths()).toContain('temp-assets/new.svg')
    finishDelete()
    await deleting
    await flushCloudSyncQueue()
    expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toBe('[]')
  } finally { stop(); await clearCloudBatchSave('deleting') }
})

test('a failed delete keeps recovery data paused until deletion is retried', async () => {
  let rejectSave!: (value: unknown) => void
  api.invoke.mockImplementation((command: string) => {
    if (command === 'save_batch') return new Promise((_, reject) => { rejectSave = reject })
    if (command === 'delete_batch') return Promise.reject(new Error('删除连接中断'))
    return Promise.resolve()
  })
  try {
    await enqueueCloudBatchSave({ id: 'delete-retry', savedAt: 'now', assets: [{ storagePath: 'temp-assets/recovery.svg', attributes: { QT: '25' } }] })
    await vi.waitFor(() => expect(rejectSave).toBeTypeOf('function'))
    const deleting = deleteBatchWithPendingSync('delete-retry')
    rejectSave(new Error('源文件不可访问'))
    await expect(deleting).rejects.toThrow('删除连接中断')
    const queued = JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1') ?? '[]')
    expect(queued[0].deletionRequested).toBe(true)
    expect(queued[0].args.assets[0].attributes.QT).toBe('25')
    expect(pendingCloudAssetPaths()).toContain('temp-assets/recovery.svg')
    // A committed delete may have lost its response. Never resurrect the
    // record by resuming its old save automatically, including on startup.
    await expect(flushCloudSyncQueue()).rejects.toThrow('请重试删除')
    expect(api.invoke.mock.calls.filter(([command]) => command === 'save_batch')).toHaveLength(1)
    api.invoke.mockResolvedValue(undefined)
    await deleteBatchWithPendingSync('delete-retry')
    expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toBe('[]')
  } finally { await clearCloudBatchSave('delete-retry') }
})

test('a missing source does not stop later background saves and its error stays visible', async () => {
  vi.useFakeTimers()
  let rejectBroken!: (reason: unknown) => void
  api.invoke.mockImplementation((command: string, args: { id: string }) => {
    if (command !== 'save_batch') return Promise.resolve()
    if (args.id === 'broken') return new Promise((_, reject) => { rejectBroken = reject })
    return Promise.resolve({ batchId: args.id, assets: [] })
  })
  const status = vi.fn()
  const stop = onCloudSyncStatus(status)
  try {
    await enqueueCloudBatchSave({ id: 'broken', savedAt: 'now', assets: [{ storagePath: 'temp-assets/missing.svg' }] })
    await Promise.resolve()
    await enqueueCloudBatchSave({ id: 'healthy', savedAt: 'now', assets: [] })
    const flushed = expect(flushCloudSyncQueue()).rejects.toThrow('源文件不可访问')
    rejectBroken(new Error('源文件不可访问'))
    await flushed
    expect(api.invoke).toHaveBeenCalledWith('save_batch', expect.objectContaining({ id: 'healthy' }))
    const entries = JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1') ?? '[]')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ args: { id: 'broken' }, error: 'Error: 源文件不可访问' })
    expect(status).toHaveBeenLastCalledWith({ state: 'error', pending: 1, error: 'Error: 源文件不可访问' })
    expect(pendingCloudAssetPaths()).toContain('temp-assets/missing.svg')
  } finally {
    await clearCloudBatchSave('broken'); await clearCloudBatchSave('healthy'); stop()
    vi.clearAllTimers(); vi.useRealTimers()
  }
})

test('a batch barrier resolves as soon as that batch saves, without waiting for the next upload', async () => {
  const saves = new Map<string, (result: unknown) => void>()
  api.invoke.mockImplementation((command: string, args: { id: string }) => command === 'save_batch'
    ? new Promise(resolve => { saves.set(args.id, resolve) }) : Promise.resolve())
  try {
    await enqueueCloudBatchSave({ id: 'first', savedAt: 'now', assets: [] })
    await vi.waitFor(() => expect(saves.has('first')).toBe(true))
    await enqueueCloudBatchSave({ id: 'second', savedAt: 'now', assets: [] })
    const completed = vi.fn()
    const flushing = flushCloudSyncQueue('first').then(completed)
    saves.get('first')?.({ batchId: 'first', assets: [] })
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce())
    await flushing
    expect(saves.has('second')).toBe(true)
    expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('second')
  } finally {
    await clearCloudBatchSave('first'); await clearCloudBatchSave('second')
    saves.get('second')?.({ batchId: 'second', assets: [] })
    await flushCloudSyncQueue()
  }
})

test('a batch barrier reports its own failure instead of an unrelated saved error', async () => {
  vi.useFakeTimers()
  api.invoke.mockImplementation((command: string, args: { id: string }) => command === 'save_batch'
    ? Promise.reject(new Error(`${args.id} source missing`)) : Promise.resolve())
  try {
    await enqueueCloudBatchSave({ id: 'one', savedAt: 'now', assets: [] })
    await expect(flushCloudSyncQueue('one')).rejects.toThrow('one source missing')
    await enqueueCloudBatchSave({ id: 'two', savedAt: 'now', assets: [] })
    await expect(flushCloudSyncQueue('two')).rejects.toThrow('two source missing')
  } finally {
    await clearCloudBatchSave('one'); await clearCloudBatchSave('two')
    await flushCloudSyncQueue()
    vi.clearAllTimers(); vi.useRealTimers()
  }
})

test('a version conflict keeps the snapshot but stops futile automatic retries', async () => {
  vi.useFakeTimers()
  api.invoke.mockRejectedValue(new Error('记录已被其他用户修改，请重新打开后再保存；本次修改未覆盖云端内容'))
  const status = vi.fn()
  const stop = onCloudSyncStatus(status)
  try {
    await enqueueCloudBatchSave({ id: 'conflict', savedAt: 'now', assets: [{ attributes: { QT: '30' } }] })
    await expect(flushCloudSyncQueue('conflict')).rejects.toThrow('记录已被其他用户修改')
    await vi.advanceTimersByTimeAsync(180_000)
    expect(api.invoke.mock.calls.filter(([command]) => command === 'save_batch')).toHaveLength(1)
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'blocked', pending: 1 }))
    expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('30')
  } finally { stop(); await clearCloudBatchSave('conflict'); vi.clearAllTimers(); vi.useRealTimers() }
})

test('a temporary connection failure retries automatically and retains its source until success', async () => {
  vi.useFakeTimers()
  let offline = true
  api.invoke.mockImplementation((command: string) => command === 'save_batch' && offline
    ? Promise.reject(new Error('云数据库连接或请求失败')) : Promise.resolve({ batchId: 'automatic', assets: [] }))
  try {
    await enqueueCloudBatchSave({ id: 'automatic', savedAt: 'now', assets: [{ storagePath: 'temp-assets/a.svg' }] })
    await expect(flushCloudSyncQueue('automatic')).rejects.toThrow('连接')
    expect(pendingCloudAssetPaths()).toContain('temp-assets/a.svg')
    offline = false
    await vi.advanceTimersByTimeAsync(2_500)
    expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toBe('[]')
    expect(api.invoke).toHaveBeenCalledWith('discard_temp_assets', expect.anything())
  } finally { await clearCloudBatchSave('automatic'); vi.clearAllTimers(); vi.useRealTimers() }
})

test('queue storage failure is reported instead of claiming the save was queued', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
  try {
    await expect(enqueueCloudBatchSave({ id: 'quota', savedAt: 'now', metadata: { customerName: '未落盘客户' }, assets: [{ storagePath: 'temp-assets/quota.svg' }] })).rejects.toThrow('同步队列')
    expect(api.invoke).not.toHaveBeenCalled()
    expect(cloudSyncTasks()).toEqual([expect.objectContaining({ id: 'quota', customerName: '未落盘客户', state: 'blocked', assetCount: 1 })])
    expect(pendingCloudAssetPaths()).toContain('temp-assets/quota.svg')
  } finally { storage.mockRestore(); await clearCloudBatchSave('quota') }
})

test('concurrent enqueues retain both batches while the first upload is acknowledged', async () => {
  const saves = new Map<string, () => void>()
  api.invoke.mockImplementation((command: string, args: { id: string }) => command === 'save_batch'
    ? new Promise(resolve => { saves.set(args.id, () => resolve({ batchId: args.id, assets: [] })) }) : Promise.resolve())
  try {
    await Promise.all([
      enqueueCloudBatchSave({ id: 'parallel-one', savedAt: 'now', assets: [] }),
      enqueueCloudBatchSave({ id: 'parallel-two', savedAt: 'now', assets: [] }),
    ])
    expect(cloudSyncTasks().map(task => task.id)).toEqual(['parallel-one', 'parallel-two'])
    await vi.waitFor(() => expect(saves.has('parallel-one')).toBe(true))
    saves.get('parallel-one')?.()
    await vi.waitFor(() => expect(saves.has('parallel-two')).toBe(true))
    expect(cloudSyncTasks().map(task => task.id)).toEqual(['parallel-two'])
    saves.get('parallel-two')?.()
    await flushCloudSyncQueue()
    expect(cloudSyncTasks()).toEqual([])
  } finally {
    await clearCloudBatchSave('parallel-one'); await clearCloudBatchSave('parallel-two')
    for (const finish of saves.values()) finish()
    await flushCloudSyncQueue()
  }
})

test('leased originals are cleaned after the last reader and any new queued use finish', async () => {
  const asset = { storagePath: 'temp-assets/leased.svg' }
  let finishSecond!: () => void
  api.invoke.mockImplementation((command: string, args: { id: string }) => command === 'save_batch' && args.id === 'lease-two'
    ? new Promise(resolve => { finishSecond = () => resolve({ batchId: args.id, assets: [] }) })
    : Promise.resolve({ batchId: args?.id, assets: [] }))
  const releaseFirstReader = retainCloudAssetPaths([asset.storagePath])
  const releaseLastReader = retainCloudAssetPaths([asset.storagePath])
  try {
    await enqueueCloudBatchSave({ id: 'lease-one', savedAt: 'now', assets: [asset] })
    await flushCloudSyncQueue('lease-one')
    releaseFirstReader()
    expect(pendingCloudAssetPaths()).toContain(asset.storagePath)
    expect(api.invoke).not.toHaveBeenCalledWith('discard_temp_assets', expect.anything())
    // A new enqueue owns its sources before the first await/disk commit.
    const savingAgain = enqueueCloudBatchSave({ id: 'lease-two', savedAt: 'now', assets: [asset] })
    releaseLastReader()
    expect(api.invoke).not.toHaveBeenCalledWith('discard_temp_assets', expect.anything())
    await savingAgain
    await vi.waitFor(() => expect(finishSecond).toBeTypeOf('function'))
    finishSecond()
    await flushCloudSyncQueue('lease-two')
    expect(api.invoke).toHaveBeenCalledWith('discard_temp_assets', { assets: [asset] })
    expect(pendingCloudAssetPaths()).not.toContain(asset.storagePath)
  } finally {
    releaseFirstReader(); releaseLastReader()
    await clearCloudBatchSave('lease-one'); await clearCloudBatchSave('lease-two')
    finishSecond?.()
    await flushCloudSyncQueue()
  }
})

test('native initialization failure retains the new batch identity and a detached recovery snapshot', async () => {
  vi.resetModules()
  const nativeInvoke = vi.fn().mockRejectedValue(new Error('无法读取本地同步存储'))
  vi.doMock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: nativeInvoke }))
  try {
    const queue = await import('../src/services/cloudSyncQueue')
    const assets = [{ storagePath: 'temp-assets/native.svg' }]
    const saving = queue.enqueueCloudBatchSave({ id: 'native-failed', savedAt: 'now', metadata: { customerName: '本地文件客户' }, assets })
    assets[0].storagePath = 'changed-after-enqueue.svg'
    await expect(saving).rejects.toThrow('无法读取本地同步存储')
    expect(queue.cloudSyncTasks()).toEqual([expect.objectContaining({ id: 'native-failed', name: '本地文件客户', state: 'blocked', assetCount: 1 })])
    expect(queue.pendingCloudAssetPaths()).toContain('temp-assets/native.svg')
    expect(queue.pendingCloudAssetPaths()).not.toContain('changed-after-enqueue.svg')
    expect(api.invoke).not.toHaveBeenCalled()
  } finally { vi.doUnmock('@tauri-apps/api/core'); vi.resetModules() }
})

test('migration resumes old local storage failures while retaining version conflicts and delete intent', async () => {
  vi.resetModules()
  const { nativeSyncMock } = await import('./helpers/localSyncStateMock')
  const native = nativeSyncMock()
  vi.doMock('@tauri-apps/api/core', () => ({ isTauri: () => true,
    invoke: async (command: string, args: Record<string, string>) => native.handle(command, args).value }))
  const fixture = (id: string, error: string, deletionRequested = false) => ({ key: `save_batch:${id}`, command: 'save_batch', revision: id,
    args: { id, savedAt: 'now', assets: [] }, attempts: 1, nextAttemptAt: 0, blocked: true, error, deletionRequested })
  localStorage.setItem('printflow-cloud-sync-queue-v1', JSON.stringify([
    fixture('migrate-retry', '无法保存本地云端同步日志'),
    fixture('migrate-conflict', '记录已被其他用户修改'),
    fixture('migrate-delete', '无法保存本地云端同步日志', true),
  ]))
  api.invoke.mockImplementation(async (_command: string, args: { id: string }) => ({ batchId: args.id, assets: [] }))
  let stop = () => {}
  try {
    const queue = await import('../src/services/cloudSyncQueue')
    stop = queue.startCloudSyncRecovery()
    await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith('save_batch', expect.objectContaining({ id: 'migrate-retry' })))
    await queue.flushCloudSyncQueue('migrate-retry')
    expect(queue.cloudSyncTasks().map(task => [task.id, task.state])).toEqual([['migrate-conflict', 'blocked'], ['migrate-delete', 'blocked']])
    expect(api.invoke.mock.calls.filter(([command]) => command === 'save_batch')).toHaveLength(1)
    expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toBeNull()
    expect(native.disk.get('cloud-sync-queue:batches')).toContain('migrate-conflict')
    await queue.clearCloudBatchSave('migrate-conflict'); await queue.clearCloudBatchSave('migrate-delete')
  } finally { stop(); vi.doUnmock('@tauri-apps/api/core'); vi.resetModules() }
})

test('reconnect wakes a transient retry immediately without resuming a failed deletion or conflict', async () => {
  vi.useFakeTimers()
  let offline = true
  api.invoke.mockImplementation((command: string) => command === 'save_batch' && offline
    ? Promise.reject(new Error('offline')) : Promise.resolve({ batchId: 'wake', assets: [] }))
  let stop = () => {}
  try {
    await enqueueCloudBatchSave({ id: 'wake', savedAt: 'now', assets: [] })
    await expect(flushCloudSyncQueue('wake')).rejects.toThrow('offline')
    const entries = JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1')!)
    entries.push({ ...entries[0], key: 'save_batch:conflict', args: { id: 'conflict', savedAt: 'now', assets: [] }, error: '记录已被其他用户修改' })
    entries.push({ ...entries[0], key: 'save_batch:deleted', args: { id: 'deleted', savedAt: 'now', assets: [] }, deletionRequested: true })
    localStorage.setItem('printflow-cloud-sync-queue-v1', JSON.stringify(entries))
    stop = startCloudSyncRecovery()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    offline = false
    const attemptsBefore = api.invoke.mock.calls.length
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(api.invoke.mock.calls.length - attemptsBefore).toBe(1)
    expect(JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1')!).map((entry: { args: { id: string } }) => entry.args.id)).toEqual(['conflict', 'deleted'])
  } finally { stop(); for (const id of ['wake', 'conflict', 'deleted']) await clearCloudBatchSave(id); vi.clearAllTimers(); vi.useRealTimers() }
})
