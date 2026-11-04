import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const api = vi.hoisted(() => ({ invoke: vi.fn(), storageMode: vi.fn() }))
vi.mock('../src/services/backend', () => api)

import { clearCloudBatchSave, deleteBatchWithPendingSync, enqueueCloudBatchSave, flushCloudSyncQueue, onCloudBatchSaveComplete, onCloudSyncStatus, pendingCloudAssetPaths } from '../src/services/cloudSyncQueue'

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
  enqueueCloudBatchSave({ id: 'batch-1', savedAt: 'now', assets: [{ id: 'asset-1', storagePath: 'temp-assets/asset-1.svg' }] })
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
    enqueueCloudBatchSave({ id: 'batch-qt', savedAt: 'first', assets: initial })
    await vi.waitFor(() => expect(saves).toHaveLength(1))
    enqueueCloudBatchSave({ id: 'batch-qt', savedAt: 'second', assets: latest })
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
    enqueueCloudBatchSave({ id: 'batch-newer', savedAt: 'old', assets: ['old'] })
    await Promise.resolve()
    enqueueCloudBatchSave({ id: 'batch-newer', savedAt: 'new', assets: ['new'] })
    rejectSave(new Error('old request failed'))
    await flushCloudSyncQueue()
    expect(attempts).toBe(2)
    expect(status.mock.calls.some(([value]) => value.state === 'error')).toBe(false)
    expect(JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1') ?? '[]')).toEqual([])
  } finally {
    stop()
    clearCloudBatchSave('batch-newer')
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
    enqueueCloudBatchSave({ id: 'batch-retry', savedAt: 'now', assets: [] })
    await expect(flushCloudSyncQueue()).rejects.toThrow('offline')
    expect(JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1') ?? '[]')).toHaveLength(1)
    offline = false
    await flushCloudSyncQueue()
    expect(api.invoke.mock.calls.filter(([command]) => command === 'save_batch')).toHaveLength(2)
    expect(JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1') ?? '[]')).toEqual([])
  } finally {
    clearCloudBatchSave('batch-retry')
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
    enqueueCloudBatchSave({ id: 'deleting', savedAt: 'old', assets: [{ storagePath: 'temp-assets/old.svg' }] })
    await vi.waitFor(() => expect(resolveSave).toBeTypeOf('function'))
    const deleting = deleteBatchWithPendingSync('deleting')
    expect(deleteBatchWithPendingSync('deleting')).toBe(deleting)
    enqueueCloudBatchSave({ id: 'deleting', savedAt: 'new', assets: [{ storagePath: 'temp-assets/new.svg', attributes: { QT: '25' } }] })
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
  } finally { stop(); clearCloudBatchSave('deleting') }
})

test('a failed delete keeps recovery data paused until deletion is retried', async () => {
  let rejectSave!: (value: unknown) => void
  api.invoke.mockImplementation((command: string) => {
    if (command === 'save_batch') return new Promise((_, reject) => { rejectSave = reject })
    if (command === 'delete_batch') return Promise.reject(new Error('删除连接中断'))
    return Promise.resolve()
  })
  try {
    enqueueCloudBatchSave({ id: 'delete-retry', savedAt: 'now', assets: [{ storagePath: 'temp-assets/recovery.svg', attributes: { QT: '25' } }] })
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
  } finally { clearCloudBatchSave('delete-retry') }
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
    enqueueCloudBatchSave({ id: 'broken', savedAt: 'now', assets: [{ storagePath: 'temp-assets/missing.svg' }] })
    await Promise.resolve()
    enqueueCloudBatchSave({ id: 'healthy', savedAt: 'now', assets: [] })
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
    clearCloudBatchSave('broken'); clearCloudBatchSave('healthy'); stop()
    vi.clearAllTimers(); vi.useRealTimers()
  }
})

test('a batch barrier resolves as soon as that batch saves, without waiting for the next upload', async () => {
  const saves = new Map<string, (result: unknown) => void>()
  api.invoke.mockImplementation((command: string, args: { id: string }) => command === 'save_batch'
    ? new Promise(resolve => { saves.set(args.id, resolve) }) : Promise.resolve())
  try {
    enqueueCloudBatchSave({ id: 'first', savedAt: 'now', assets: [] })
    await vi.waitFor(() => expect(saves.has('first')).toBe(true))
    enqueueCloudBatchSave({ id: 'second', savedAt: 'now', assets: [] })
    const completed = vi.fn()
    const flushing = flushCloudSyncQueue('first').then(completed)
    saves.get('first')?.({ batchId: 'first', assets: [] })
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce())
    await flushing
    expect(saves.has('second')).toBe(true)
    expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('second')
  } finally {
    clearCloudBatchSave('first'); clearCloudBatchSave('second')
    saves.get('second')?.({ batchId: 'second', assets: [] })
    await flushCloudSyncQueue()
  }
})

test('a batch barrier reports its own failure instead of an unrelated saved error', async () => {
  vi.useFakeTimers()
  api.invoke.mockImplementation((command: string, args: { id: string }) => command === 'save_batch'
    ? Promise.reject(new Error(`${args.id} source missing`)) : Promise.resolve())
  try {
    enqueueCloudBatchSave({ id: 'one', savedAt: 'now', assets: [] })
    await expect(flushCloudSyncQueue('one')).rejects.toThrow('one source missing')
    enqueueCloudBatchSave({ id: 'two', savedAt: 'now', assets: [] })
    await expect(flushCloudSyncQueue('two')).rejects.toThrow('two source missing')
  } finally {
    clearCloudBatchSave('one'); clearCloudBatchSave('two')
    await flushCloudSyncQueue()
    vi.clearAllTimers(); vi.useRealTimers()
  }
})
