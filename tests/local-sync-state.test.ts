import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { nativeSyncMock } from './helpers/localSyncStateMock'

const api = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => true }))
const native = nativeSyncMock()
let cloud: (args: Record<string, any>) => unknown
beforeEach(() => {
  vi.resetModules(); localStorage.clear(); native.clear(); api.invoke.mockReset()
  localStorage.setItem('printflow-account-name', 'Alice')
  cloud = args => ({ result: { batchId: args.args.id, version: 1 } })
  api.invoke.mockImplementation(async (command, args) => {
    const storage = native.handle(command, args)
    if (storage.handled) return storage.value
    if (command === 'storage_mode') return { shared: true }
    if (command === 'cloud_operation') return args.command === 'initialize_shared_user' ? 'shared-root' : cloud(args)
    if (command === 'discard_temp_assets') return
    throw new Error(`unexpected native command ${command}`)
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers() })
const journalKey = 'printflow-cloud-write-journal-v1:' + encodeURIComponent(JSON.stringify(['', '', '', 'Alice']))

test('desktop save persists its journal outside WebView quota before sending to cloud', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('WebView quota exhausted', 'QuotaExceededError') })
  const { invoke } = await import('../src/services/backend')
  await expect(invoke('save_batch', { id: 'quota-batch', assets: [], metadata: { customerName: '配额测试批次' } })).resolves.toMatchObject({ batchId: 'quota-batch' })
  expect(native.disk.size).toBe(1)
  const commands = api.invoke.mock.calls.map(([command]) => command)
  const saveIndex = api.invoke.mock.calls.findIndex(([command, args]) => command === 'cloud_operation' && args.command === 'save_batch')
  expect(commands.indexOf('save_local_sync_state')).toBeLessThan(saveIndex)
})

test('desktop queue persists and uploads while WebView storage is full', async () => {
  vi.useFakeTimers()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('WebView quota exhausted', 'QuotaExceededError') })
  const queue = await import('../src/services/cloudSyncQueue')
  await queue.enqueueCloudBatchSave({ id: 'queue-quota', savedAt: 'now', assets: [], metadata: { customerName: '本地保存批次' } })
  expect(native.disk.get('cloud-sync-queue:batches')).toContain('queue-quota')
  await queue.flushCloudSyncQueue('queue-quota')
  expect(queue.cloudSyncTasks()).toEqual([])
  expect(api.invoke.mock.calls.some(([command, args]) => command === 'cloud_operation' && args.command === 'save_batch' && args.args.id === 'queue-quota')).toBe(true)
})

test('migrates three legacy quota-blocked batches and resumes each exact batch', async () => {
  vi.useFakeTimers()
  const ids = ['batch-a', 'batch-b', 'batch-c']
  localStorage.setItem('printflow-cloud-sync-queue-v1', JSON.stringify(ids.map((id, index) => ({
    key: `save_batch:${id}`, command: 'save_batch', revision: `old-${id}`,
    args: { id, savedAt: 'original', assets: [], metadata: { customerName: `客户 ${index}` }, preserveTempAssets: true },
    attempts: 3, nextAttemptAt: Date.now() + 60_000, blocked: true,
    error: 'Error: 无法保存本地云端同步日志，请释放磁盘空间并检查本地存储后重试',
  }))))
  const queue = await import('../src/services/cloudSyncQueue')
  expect(queue.cloudSyncTasks().map(task => task.id)).toEqual(ids)
  const stop = queue.startCloudSyncRecovery()
  try {
    await vi.waitFor(() => expect(queue.cloudSyncTasks()).toEqual([]))
    expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toBeNull()
    expect(JSON.parse(native.disk.get('cloud-sync-queue:batches')!)).toEqual([])
    const uploaded = api.invoke.mock.calls.filter(([command, args]) => command === 'cloud_operation' && args.command === 'save_batch').map(([, args]) => args.args.id)
    expect(uploaded).toEqual(ids)
  } finally { stop() }
})

test('native queue failure identifies the unsaved batch and retries only after durable recovery', async () => {
  vi.useFakeTimers()
  native.fail('写入本地同步状态失败：disk full')
  const queue = await import('../src/services/cloudSyncQueue')
  await expect(queue.enqueueCloudBatchSave({ id: 'disk-failed', savedAt: 'original', assets: [], metadata: { customerName: '待恢复客户' } })).rejects.toThrow('disk full')
  expect(queue.cloudSyncTasks()).toMatchObject([{ id: 'disk-failed', customerName: '待恢复客户', state: 'blocked', error: expect.stringContaining('disk full') }])
  expect(api.invoke.mock.calls.some(([command]) => command === 'cloud_operation')).toBe(false)
  native.fail('')
  await queue.flushCloudSyncQueue('disk-failed')
  expect(queue.cloudSyncTasks()).toEqual([])
  expect(api.invoke.mock.calls.findLast(([command]) => command === 'cloud_operation')![1]).toMatchObject({ command: 'save_batch', args: { id: 'disk-failed', savedAt: 'original' } })
})

test('large Unicode requests use bounded chunks and preserve the exact retry after restart', async () => {
  cloud = () => { throw new Error('reply lost') }
  const args = { id: 'large', savedAt: 'first', assets: [{ notes: 'x'.repeat(65_300) + '😀中文'.repeat(60_000) }] }
  const first = await import('../src/services/backend')
  await expect(first.invoke('save_batch', args)).rejects.toThrow('reply lost')
  const originalRequest = api.invoke.mock.calls.findLast(([command]) => command === 'cloud_operation')![1]
  const chunks = api.invoke.mock.calls.filter(([command]) => command === 'append_local_sync_write').map(([, args]) => args.chunk as string)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every(chunk => new TextEncoder().encode(chunk).length <= 256 * 1024 && chunk.isWellFormed())).toBe(true)
  expect(localStorage.getItem(journalKey)).toBeNull()
  vi.resetModules()
  cloud = () => ({ result: { version: 1 } })
  const restarted = await import('../src/services/backend')
  await restarted.invoke('save_batch', { ...args, savedAt: 'second' })
  expect(api.invoke.mock.calls.findLast(([command]) => command === 'cloud_operation')![1]).toEqual(originalRequest)
})

test('migrates an old pending request before removing the quota-consuming copy', async () => {
  const args = { id: 'old', savedAt: 'first', assets: [] }
  const pending = { command: 'save_batch', args, expectedVersion: 3, requestId: 'retained-id', fingerprint: JSON.stringify(['save_batch', { ...args, savedAt: undefined }]) }
  const legacy = JSON.stringify({ schemaVersion: 1, versions: { 'batch:old': 3 }, pending: { 'batch:old': pending } })
  localStorage.setItem(journalKey, legacy)
  cloud = request => { expect(localStorage.getItem(journalKey)).toBeNull(); expect(native.disk.size).toBe(1); expect(request).toMatchObject({ requestId: 'retained-id', expectedVersion: 3, args }); return { result: { version: 4 } } }
  await (await import('../src/services/backend')).invoke('save_batch', { ...args, savedAt: 'new' })
  expect([...native.disk.values()][0]).toContain('"batch:old":4')
})

test('failed migration preserves the legacy data and never sends an unjournaled write', async () => {
  const legacy = JSON.stringify({ schemaVersion: 1, versions: {}, pending: {} })
  localStorage.setItem(journalKey, legacy)
  const handle = api.invoke.getMockImplementation()!
  api.invoke.mockImplementation(async (command, args) => { if (command === 'save_local_sync_state') throw new Error('写入本地同步状态失败：disk full'); return handle(command, args) })
  await expect((await import('../src/services/backend')).invoke('save_batch', { id: 'migration-failed', assets: [] })).rejects.toThrow('disk full')
  expect(localStorage.getItem(journalKey)).toBe(legacy)
  expect(api.invoke.mock.calls.some(([command, args]) => command === 'cloud_operation' && args.command === 'save_batch')).toBe(false)
})

test('failed native acknowledgement keeps the exact request durable for the next session', async () => {
  cloud = () => { native.fail('提交本地同步状态失败：disk full'); return { result: { version: 1 } } }
  const first = await import('../src/services/backend')
  await expect(first.invoke('save_batch', { id: 'ack', savedAt: 'first', assets: [] })).rejects.toThrow('disk full')
  const request = api.invoke.mock.calls.findLast(([command]) => command === 'cloud_operation')![1]
  native.fail(''); vi.resetModules()
  cloud = () => ({ result: { version: 1 } })
  await (await import('../src/services/backend')).invoke('save_batch', { id: 'ack', savedAt: 'second', assets: [] })
  expect(api.invoke.mock.calls.findLast(([command]) => command === 'cloud_operation')![1]).toEqual(request)
})

test('simultaneous batches retain both pending requests in native storage', async () => {
  cloud = () => { throw new Error('offline') }
  const { invoke } = await import('../src/services/backend')
  await Promise.allSettled(['a', 'b', 'c'].map(id => invoke('save_batch', { id, assets: [] })))
  const saved = JSON.parse([...native.disk.values()][0])
  expect(Object.keys(saved.pending).sort()).toEqual(['batch:a', 'batch:b', 'batch:c'])
})

test('invalid native data is not replaced and damaged legacy data remains available', async () => {
  const { LocalSyncState } = await import('../src/services/localSyncState')
  native.disk.set('scope:key', '{broken')
  localStorage.setItem('legacy', '["old"]')
  const store = new LocalSyncState('scope', 'key', 'legacy', () => [] as string[], (v): v is string[] => Array.isArray(v))
  await expect(store.ready()).rejects.toThrow('格式无效')
  expect(native.disk.get('scope:key')).toBe('{broken')
  expect(localStorage.getItem('legacy')).toBe('["old"]')
})

test('a failed chunk never replaces the previous native snapshot and aborts staging', async () => {
  const { LocalSyncState } = await import('../src/services/localSyncState')
  native.disk.set('scope:key', '["old"]')
  const store = new LocalSyncState('scope', 'key', 'legacy', () => [] as string[], (v): v is string[] => Array.isArray(v))
  const handle = api.invoke.getMockImplementation()!
  api.invoke.mockImplementation(async (command, args) => { if (command === 'append_local_sync_write') throw new Error('disk full'); return handle(command, args) })
  await expect(store.update(() => ['x'.repeat(100_000)])).rejects.toThrow('disk full')
  expect(store.snapshot()).toEqual(['old'])
  expect(native.disk.get('scope:key')).toBe('["old"]')
  expect(native.chunks.size).toBe(0)
})

test('a read overlapping acknowledgement persistence cannot return an older record', async () => {
  let reads = 0
  cloud = args => args.command === 'load_batch'
    ? { id: 'stale-read', version: ++reads === 1 ? 1 : 2 }
    : { result: { version: 3 } }
  let releaseAcknowledgement!: () => void
  let acknowledgementHeld = false
  const handle = api.invoke.getMockImplementation()!
  api.invoke.mockImplementation(async (command, args) => {
    if (command === 'save_local_sync_state') {
      const document = JSON.parse(args.payload)
      if (!acknowledgementHeld && document.versions?.['batch:stale-read'] === 3 && !document.pending?.['batch:stale-read']) {
        acknowledgementHeld = true
        await new Promise<void>(resolve => { releaseAcknowledgement = resolve })
      }
    }
    return handle(command, args)
  })
  const { invoke } = await import('../src/services/backend')
  await invoke('load_batch', { id: 'stale-read' })
  const saving = invoke('save_batch', { id: 'stale-read', assets: [] })
  await vi.waitFor(() => expect(releaseAcknowledgement).toBeTypeOf('function'))
  const reading = invoke('load_batch', { id: 'stale-read' })
  const rejectedRead = expect(reading).rejects.toThrow('读取的云端记录已过期')
  await vi.waitFor(() => expect(reads).toBe(2))
  releaseAcknowledgement()
  await saving
  await rejectedRead
  expect(JSON.parse([...native.disk.values()][0]).versions['batch:stale-read']).toBe(3)
})
