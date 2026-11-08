import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const api = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => true }))
beforeEach(() => { vi.resetModules(); api.invoke.mockReset(); localStorage.clear(); localStorage.setItem('printflow-account-name', 'Alice') })
afterEach(() => vi.restoreAllMocks())
function shared(handler: (command: string, args: Record<string, unknown>) => unknown, mode = { shared: true }) {
  api.invoke.mockImplementation(async (command, args) => {
    if (command === 'storage_mode') return mode
    if (command === 'cloud_operation' && args.command === 'initialize_shared_user') return 'shared-root'
    if (command === 'cloud_operation') return handler(args.command, args)
    throw new Error(`unexpected local command: ${command}`)
  })
}
test('shared failures never fall back to local business commands', async () => {
  shared(() => { throw new Error('offline') })
  const { invoke } = await import('../src/services/backend')
  await expect(invoke('list_batches', { query: {} })).rejects.toThrow('offline')
  expect(api.invoke.mock.calls.map(call => call[0])).toEqual(['storage_mode', 'cloud_operation', 'cloud_operation'])
})
test('invalid mode cannot silently select local storage', async () => {
  api.invoke.mockResolvedValue(undefined)
  const { invoke } = await import('../src/services/backend')
  await expect(invoke('save_batch', { id: 'b' })).rejects.toThrow('存储模式响应无效')
  expect(api.invoke).toHaveBeenCalledTimes(1)
})
test('list refresh updates action revision without advancing an open editor', async () => {
  let revision = 2
  shared(command => command === 'load_batch' ? { id: 'b', version: 1 } : command === 'list_batches' ? { records: [{ id: 'b', version: revision }] } : { result: { version: 2 } })
  const { invoke } = await import('../src/services/backend')
  await invoke('load_batch', { id: 'b' }); await invoke('list_batches')
  await invoke('save_batch', { id: 'b', assets: [] })
  expect(api.invoke.mock.calls.at(-1)?.[1].expectedVersion).toBe(1)
  revision = 3; await invoke('list_batches'); await invoke('delete_batch', { id: 'b' })
  expect(api.invoke.mock.calls.at(-1)?.[1].expectedVersion).toBe(3)
})
test('retry after lost reply retains request ID and original timestamp', async () => {
  let attempts = 0
  shared(() => { if (++attempts === 1) throw new Error('reply lost'); return { result: { version: 1 } } })
  const { invoke } = await import('../src/services/backend')
  await expect(invoke('save_batch', { id: 'b', savedAt: 'first', assets: [] })).rejects.toThrow('reply lost')
  const first = api.invoke.mock.calls.at(-1)?.[1]
  await invoke('save_batch', { id: 'b', savedAt: 'second', assets: [] })
  const second = api.invoke.mock.calls.at(-1)?.[1]
  expect(second.requestId).toBe(first.requestId); expect(second.args.savedAt).toBe('first')
})
test('changed edits confirm the previous request before saving a new snapshot', async () => {
  let attempts = 0
  shared(() => {
    if (++attempts === 1) throw new Error('reply lost')
    return { result: { version: attempts - 1 } }
  })
  const { invoke } = await import('../src/services/backend')
  await expect(invoke('save_batch', { id: 'b', assets: ['one'] })).rejects.toThrow('reply lost')
  const first = api.invoke.mock.calls.at(-1)?.[1]
  await expect(invoke('save_batch', { id: 'b', assets: ['two'] })).resolves.toEqual({ version: 2 })
  const saves = api.invoke.mock.calls.filter(([, args]) => args?.command === 'save_batch').map(([, args]) => args)
  expect(saves).toHaveLength(3)
  expect(saves[1]).toEqual(first)
  expect(saves[2].requestId).not.toBe(first.requestId)
  expect(saves[2]).toMatchObject({ expectedVersion: 1, args: { assets: ['two'] } })
})
test('local mode preserves the existing command transport', async () => {
  api.invoke.mockImplementation(async command => command === 'storage_mode' ? { shared: false } : { id: 'local' })
  const { invoke } = await import('../src/services/backend')
  expect(await invoke('load_batch', { id: 'local' })).toEqual({ id: 'local' })
  expect(api.invoke).toHaveBeenLastCalledWith('load_batch', { id: 'local' })
})

test('custom product catalog stays local even when shared storage is offline', async () => {
  api.invoke.mockImplementation(async (command, args) => {
    if (command === 'storage_mode' || command === 'cloud_operation') throw new Error('cloud offline')
    if (command === 'list_custom_products') return [{ id: 7, name: '我的产品' }]
    if (command === 'add_custom_product_name') return { id: 8, name: args.name }
    if (command === 'save_custom_product') return args.product
    throw new Error(`unexpected: ${command}`)
  })
  const { invoke } = await import('../src/services/backend')
  const { listCustomProducts, addCustomProductName, saveCustomProduct } = await import('../src/modules/schematic/services/customProductService')
  expect(await listCustomProducts()).toEqual([{ id: 7, name: '我的产品' }])
  expect(await addCustomProductName('新产品')).toEqual({ id: 8, name: '新产品' })
  const product = { id: 7, name: '我的产品', size: '', printOption: '', finish: '', accessoryColor: '', accessoryColorImage: '', qt: 0 }
  expect(await saveCustomProduct(product)).toEqual(product)
  expect(await invoke('list_custom_products')).toEqual([{ id: 7, name: '我的产品' }])
  expect(api.invoke.mock.calls.some(([command]) => command === 'storage_mode' || command === 'cloud_operation')).toBe(false)
})

test('a slow record read cannot roll the known save revision backwards', async () => {
  let resolveRead!: (value: unknown) => void
  shared(command => command === 'load_batch'
    ? new Promise(resolve => { resolveRead = resolve })
    : { result: { version: 3 } })
  const { invoke } = await import('../src/services/backend')
  const read = invoke('load_batch', { id: 'b' })
  await vi.waitFor(() => expect(resolveRead).toBeTypeOf('function'))
  await invoke('save_batch', { id: 'b', assets: [] })
  resolveRead({ id: 'b', version: 2 })
  await expect(read).rejects.toThrow('读取的云端记录已过期')
  await invoke('save_batch', { id: 'b', assets: [] })
  expect(api.invoke.mock.calls.at(-1)?.[1].expectedVersion).toBe(3)
})

test('a late list reply cannot roll back the revision for a newer list action', async () => {
  let resolveList!: (value: unknown) => void
  let reads = 0
  shared(command => command === 'list_batches'
    ? ++reads === 1 ? new Promise(resolve => { resolveList = resolve }) : { records: [{ id: 'b', version: 3 }] }
    : { result: {} })
  const { invoke } = await import('../src/services/backend')
  const oldRead = invoke('list_batches')
  await vi.waitFor(() => expect(resolveList).toBeTypeOf('function'))
  await invoke('list_batches')
  resolveList({ records: [{ id: 'b', version: 2 }] })
  await oldRead
  await invoke('delete_batch', { id: 'b' })
  expect(api.invoke.mock.calls.at(-1)?.[1].expectedVersion).toBe(3)
})

test('retry after restart retains the lost save request and its original timestamp', async () => {
  let attempts = 0
  shared(command => {
    if (command !== 'save_batch') throw new Error(`unexpected cloud command: ${command}`)
    if (++attempts === 1) throw new Error('reply lost')
    return { result: { version: 1 } }
  })
  const firstSession = await import('../src/services/backend')
  await expect(firstSession.invoke('save_batch', { id: 'restart-new', savedAt: 'first', assets: [] })).rejects.toThrow('reply lost')
  const firstRequest = api.invoke.mock.calls.at(-1)?.[1]
  expect(firstRequest).toMatchObject({ expectedVersion: 0, args: { savedAt: 'first' } })
  expect(firstRequest.requestId).toEqual(expect.any(String))

  // A restarted webview retains local storage but loses all module-level maps.
  vi.resetModules()
  const restartedSession = await import('../src/services/backend')
  await restartedSession.invoke('save_batch', { id: 'restart-new', savedAt: 'second', assets: [] })

  expect(api.invoke.mock.calls.at(-1)?.[1]).toMatchObject({
    requestId: firstRequest.requestId,
    expectedVersion: firstRequest.expectedVersion,
    args: firstRequest.args,
  })
})

test('retry after restart retains the loaded revision for an existing batch', async () => {
  let attempts = 0
  shared(command => {
    if (command === 'load_batch') return { id: 'restart-existing', version: 4 }
    if (command === 'save_batch') {
      if (++attempts === 1) throw new Error('reply lost')
      return { result: { version: 5 } }
    }
    throw new Error(`unexpected cloud command: ${command}`)
  })
  const firstSession = await import('../src/services/backend')
  await firstSession.invoke('load_batch', { id: 'restart-existing' })
  await expect(firstSession.invoke('save_batch', { id: 'restart-existing', savedAt: 'first', assets: [] })).rejects.toThrow('reply lost')
  const firstRequest = api.invoke.mock.calls.at(-1)?.[1]
  expect(firstRequest.expectedVersion).toBe(4)

  vi.resetModules()
  const restartedSession = await import('../src/services/backend')
  await restartedSession.invoke('save_batch', { id: 'restart-existing', savedAt: 'second', assets: [] })

  expect(api.invoke.mock.calls.at(-1)?.[1]).toMatchObject({
    requestId: firstRequest.requestId,
    expectedVersion: 4,
    args: firstRequest.args,
  })
})


test('an unsent queued batch retains its loaded base revision after restart', async () => {
  shared(command => command === 'load_batch' ? { id: 'queued', version: 4 } : { result: { version: 5 } })
  const firstSession = await import('../src/services/backend')
  await firstSession.invoke('load_batch', { id: 'queued' })
  vi.resetModules()
  const restartedSession = await import('../src/services/backend')
  await restartedSession.invoke('save_batch', { id: 'queued', assets: [] })
  expect(api.invoke.mock.calls.at(-1)?.[1].expectedVersion).toBe(4)
})

test('a newer snapshot after restart confirms the old request without returning its result', async () => {
  let attempts = 0
  shared(() => {
    if (++attempts === 1) throw new Error('reply lost')
    return { result: { version: attempts - 1, assets: attempts === 2 ? ['old'] : ['new'] } }
  })
  const firstSession = await import('../src/services/backend')
  await expect(firstSession.invoke('save_batch', { id: 'newer', savedAt: 'first', assets: ['old'] })).rejects.toThrow('reply lost')
  const oldRequest = api.invoke.mock.calls.at(-1)?.[1]
  vi.resetModules()
  const restartedSession = await import('../src/services/backend')
  await expect(restartedSession.invoke('save_batch', { id: 'newer', savedAt: 'second', assets: ['new'] })).resolves.toEqual({ version: 2, assets: ['new'] })
  const saves = api.invoke.mock.calls.filter(([, args]) => args?.command === 'save_batch').map(([, args]) => args)
  expect(saves[1]).toEqual(oldRequest)
  expect(saves[2]).toMatchObject({ expectedVersion: 1, args: { savedAt: 'second', assets: ['new'] } })
  expect(saves[2].requestId).not.toBe(oldRequest.requestId)
})

test('duplicate saves share the same in-flight request', async () => {
  let resolveSave!: (result: unknown) => void
  shared(() => new Promise(resolve => { resolveSave = resolve }))
  const { invoke } = await import('../src/services/backend')
  const first = invoke('save_batch', { id: 'duplicate', savedAt: 'first', assets: [] })
  await vi.waitFor(() => expect(resolveSave).toBeTypeOf('function'))
  const second = invoke('save_batch', { id: 'duplicate', savedAt: 'second', assets: [] })
  await vi.waitFor(() => expect(api.invoke.mock.calls.filter(([, args]) => args?.command === 'save_batch')).toHaveLength(1))
  resolveSave({ result: { version: 1 } })
  expect(await Promise.all([first, second])).toEqual([{ version: 1 }, { version: 1 }])
  expect(api.invoke.mock.calls.filter(([, args]) => args?.command === 'save_batch')).toHaveLength(1)
})

test('reverting to an in-flight snapshot preserves the order of intervening edits', async () => {
  let resolveFirst!: (result: unknown) => void
  let attempts = 0
  shared(() => ++attempts === 1 ? new Promise(resolve => { resolveFirst = resolve }) : { result: { version: attempts } })
  const { invoke } = await import('../src/services/backend')
  const first = invoke('save_batch', { id: 'revert', assets: ['a'] })
  await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'))
  const second = invoke('save_batch', { id: 'revert', assets: ['b'] })
  const third = invoke('save_batch', { id: 'revert', assets: ['a'] })
  resolveFirst({ result: { version: 1 } })
  expect(await Promise.all([first, second, third])).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }])
  const saves = api.invoke.mock.calls.filter(([, args]) => args?.command === 'save_batch').map(([, args]) => args)
  expect(saves.map(args => args.args.assets)).toEqual([['a'], ['b'], ['a']])
  expect(saves.map(args => args.expectedVersion)).toEqual([0, 1, 2])
})

test('registration reset preserves an uncertain save request', async () => {
  let attempts = 0
  shared(() => { if (++attempts === 1) throw new Error('reply lost'); return { result: { version: 1 } } })
  const { invoke, resetCloudSession } = await import('../src/services/backend')
  await expect(invoke('save_batch', { id: 'reset', savedAt: 'first', assets: [] })).rejects.toThrow('reply lost')
  const first = api.invoke.mock.calls.at(-1)?.[1]
  resetCloudSession()
  await invoke('save_batch', { id: 'reset', savedAt: 'second', assets: [] })
  expect(api.invoke.mock.calls.at(-1)?.[1]).toEqual(first)
})

test('a journal write failure prevents sending an unrecoverable save', async () => {
  shared(() => ({ result: { version: 1 } }))
  const original = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key.startsWith('printflow-cloud-write-journal-v1:')) throw new Error('quota exceeded')
    return original.call(this, key, value)
  })
  const { invoke } = await import('../src/services/backend')
  await expect(invoke('save_batch', { id: 'quota', assets: [] })).rejects.toThrow('无法保存本地云端同步日志')
  expect(api.invoke.mock.calls.filter(([, args]) => args?.command === 'save_batch')).toHaveLength(0)
})

test('an acknowledgement storage failure leaves the exact request recoverable after restart', async () => {
  let failAcknowledgement = false
  const original = Storage.prototype.setItem
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (failAcknowledgement && key.startsWith('printflow-cloud-write-journal-v1:')) throw new Error('quota exceeded')
    return original.call(this, key, value)
  })
  shared(() => { failAcknowledgement = true; return { result: { version: 1 } } })
  const firstSession = await import('../src/services/backend')
  await expect(firstSession.invoke('save_batch', { id: 'ack', savedAt: 'first', assets: [] })).rejects.toThrow('无法保存本地云端同步日志')
  const first = api.invoke.mock.calls.at(-1)?.[1]
  storage.mockRestore()
  vi.resetModules()
  const restartedSession = await import('../src/services/backend')
  await restartedSession.invoke('save_batch', { id: 'ack', savedAt: 'second', assets: [] })
  expect(api.invoke.mock.calls.at(-1)?.[1]).toEqual(first)
})

test('an incompatible journal is preserved and blocks writes', async () => {
  shared(() => { throw new Error('reply lost') })
  const firstSession = await import('../src/services/backend')
  await expect(firstSession.invoke('save_batch', { id: 'invalid', assets: [] })).rejects.toThrow('reply lost')
  const journalKey = Object.keys(localStorage).find(key => key.startsWith('printflow-cloud-write-journal-v1:'))!
  const incompatible = '{"schemaVersion":999,"pending":{}}'
  localStorage.setItem(journalKey, incompatible)
  vi.resetModules()
  const restartedSession = await import('../src/services/backend')
  await expect(restartedSession.invoke('save_batch', { id: 'invalid', assets: [] })).rejects.toThrow('本地云端同步日志格式无效')
  expect(localStorage.getItem(journalKey)).toBe(incompatible)
  expect(api.invoke.mock.calls.filter(([, args]) => args?.command === 'save_batch')).toHaveLength(1)
})

test('confirmed source rejection does not prevent deleting the batch', async () => {
  shared(command => {
    if (command === 'save_batch') throw new Error('图片 source 的源文件不可访问，未找到可恢复的共享副本')
    if (command === 'delete_batch') return { result: null }
    return { id: 'missing-source', version: 4 }
  })
  const { invoke } = await import('../src/services/backend')
  await invoke('load_batch', { id: 'missing-source' })
  await expect(invoke('save_batch', { id: 'missing-source', assets: [] })).rejects.toThrow('未找到可恢复的共享副本')
  await expect(invoke('delete_batch', { id: 'missing-source' })).resolves.toBeNull()
  expect(api.invoke.mock.calls.filter(([, args]) => args?.command === 'save_batch')).toHaveLength(1)
  expect(api.invoke.mock.calls.at(-1)?.[1].expectedVersion).toBe(4)
})

test('a true version conflict is never retried with a freshly fetched revision', async () => {
  shared(command => {
    if (command === 'load_batch') return { id: 'conflict', version: 4 }
    throw new Error('记录已被其他用户修改，请重新打开后再保存；本次修改未覆盖云端内容')
  })
  const { invoke } = await import('../src/services/backend')
  await invoke('load_batch', { id: 'conflict' })
  await expect(invoke('save_batch', { id: 'conflict', assets: ['old'] })).rejects.toThrow('记录已被其他用户修改')
  await expect(invoke('save_batch', { id: 'conflict', assets: ['new'] })).rejects.toThrow('记录已被其他用户修改')
  const saves = api.invoke.mock.calls.filter(([, args]) => args?.command === 'save_batch').map(([, args]) => args)
  expect(saves.map(args => args.expectedVersion)).toEqual([4, 4])
  expect(api.invoke.mock.calls.filter(([, args]) => args?.command === 'load_batch')).toHaveLength(1)
})

test('a post-commit resource verification failure retains the request for replay', async () => {
  let attempts = 0
  shared(() => { if (++attempts === 1) throw new Error('共享图片校验失败，文件可能被外部修改'); return { result: { version: 1 } } })
  const { invoke } = await import('../src/services/backend')
  await expect(invoke('save_batch', { id: 'hydrate', assets: [] })).rejects.toThrow('共享图片校验失败')
  const first = api.invoke.mock.calls.at(-1)?.[1]
  await invoke('save_batch', { id: 'hydrate', assets: [] })
  expect(api.invoke.mock.calls.at(-1)?.[1]).toEqual(first)
})

test.each(['environment', 'configPath', 'storageRoot', 'account'] as const)('pending saves and base revisions are isolated by %s', async field => {
  const mode = { shared: true, environment: 'production', configPath: 'config-a', storageRoot: 'share-a' }
  shared(command => {
    if (command === 'load_batch') return { id: 'isolated', version: 4 }
    throw new Error('reply lost')
  }, mode)
  const firstSession = await import('../src/services/backend')
  await firstSession.invoke('load_batch', { id: 'isolated' })
  await expect(firstSession.invoke('save_batch', { id: 'isolated', savedAt: 'first', assets: [] })).rejects.toThrow('reply lost')
  const first = api.invoke.mock.calls.at(-1)?.[1]

  vi.resetModules()
  if (field === 'account') localStorage.setItem('printflow-account-name', 'Bob')
  const otherMode = field === 'account' ? mode : { ...mode, [field]: 'different' }
  shared(() => ({ result: { version: 1 } }), otherMode)
  const otherSession = await import('../src/services/backend')
  await otherSession.invoke('save_batch', { id: 'isolated', savedAt: 'second', assets: [] })
  const other = api.invoke.mock.calls.at(-1)?.[1]
  expect(other.expectedVersion).toBe(0)
  expect(other.requestId).not.toBe(first.requestId)

  vi.resetModules()
  localStorage.setItem('printflow-account-name', 'Alice')
  shared(() => ({ result: { version: 5 } }), mode)
  const restoredSession = await import('../src/services/backend')
  await restoredSession.invoke('save_batch', { id: 'isolated', savedAt: 'third', assets: [] })
  expect(api.invoke.mock.calls.at(-1)?.[1]).toEqual(first)
})

test('large schematic payloads keep session retries without filling local storage', async () => {
  let attempts = 0
  shared(() => { if (++attempts === 1) throw new Error('reply lost'); return { result: { version: 1 } } })
  const { invoke } = await import('../src/services/backend')
  const record = { id: 'large-review', savedAt: 'first', svg: 'x'.repeat(6 * 1024 * 1024) }
  await expect(invoke('save_schematic_review', { record })).rejects.toThrow('reply lost')
  const first = api.invoke.mock.calls.at(-1)?.[1]
  expect(Object.values(localStorage).join('').length).toBeLessThan(1000)
  await invoke('save_schematic_review', { record: { ...record, savedAt: 'second' } })
  expect(api.invoke.mock.calls.at(-1)?.[1].requestId).toBe(first.requestId)
  expect(api.invoke.mock.calls.at(-1)?.[1].args.record.savedAt).toBe('first')
  expect(Object.values(localStorage).join('').length).toBeLessThan(1000)
})

test.each(['save_batch', 'delete_batch'])('a definite rejection while replaying permits a newer %s request', async nextCommand => {
  let saves = 0
  shared(command => {
    if (command === 'load_batch') return { id: 'rejected-replay', version: 4 }
    if (command === 'delete_batch') return { result: null }
    if (++saves === 1) throw new Error('connection lost')
    if (saves === 2) throw new Error('图片 old 的源文件不可访问，未找到可恢复的共享副本')
    return { result: { version: 5 } }
  })
  const { invoke } = await import('../src/services/backend')
  await invoke('load_batch', { id: 'rejected-replay' })
  await expect(invoke('save_batch', { id: 'rejected-replay', assets: ['old'] })).rejects.toThrow('connection lost')
  const first = api.invoke.mock.calls.at(-1)?.[1]
  await invoke(nextCommand, nextCommand === 'save_batch' ? { id: 'rejected-replay', assets: ['new'] } : { id: 'rejected-replay' })
  const requests = api.invoke.mock.calls.filter(([, args]) => ['save_batch', 'delete_batch'].includes(args?.command)).map(([, args]) => args)
  expect(requests).toHaveLength(3)
  expect(requests[1]).toEqual(first)
  expect(requests[2]).toMatchObject({ command: nextCommand, expectedVersion: 4 })
  expect(requests[2].requestId).not.toBe(first.requestId)
})

test.each([
  ['permission', '用户不存在或已停用'],
  ['configuration', '存储配置格式错误'],
  ['request identity', '保存请求内容不一致，请重新打开记录'],
])('an intervening %s failure preserves an uncertain committed save across restart', async (_kind, message) => {
  let saves = 0
  shared(command => {
    if (command === 'load_batch') return { id: 'preflight', version: 4 }
    if (++saves === 1) throw new Error('reply lost')
    if (saves === 2) throw new Error(message)
    return { result: { version: 5 } }
  })
  const firstSession = await import('../src/services/backend')
  await firstSession.invoke('load_batch', { id: 'preflight' })
  await expect(firstSession.invoke('save_batch', { id: 'preflight', savedAt: 'first', assets: [] })).rejects.toThrow('reply lost')
  const committedRequest = api.invoke.mock.calls.at(-1)?.[1]
  await expect(firstSession.invoke('save_batch', { id: 'preflight', savedAt: 'second', assets: [] })).rejects.toThrow(message)
  expect(api.invoke.mock.calls.at(-1)?.[1]).toEqual(committedRequest)

  vi.resetModules()
  const recoveredSession = await import('../src/services/backend')
  await expect(recoveredSession.invoke('save_batch', { id: 'preflight', savedAt: 'third', assets: [] })).resolves.toEqual({ version: 5 })
  expect(api.invoke.mock.calls.at(-1)?.[1]).toEqual(committedRequest)
})
