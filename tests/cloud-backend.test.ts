import { beforeEach, expect, test, vi } from 'vitest'
const api = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => true }))
beforeEach(() => { vi.resetModules(); api.invoke.mockReset(); localStorage.clear(); localStorage.setItem('printflow-account-name', 'Alice') })
function shared(handler: (command: string, args: Record<string, unknown>) => unknown) {
  api.invoke.mockImplementation(async (command, args) => {
    if (command === 'storage_mode') return { shared: true }
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
test('changed edits use a new idempotency request', async () => {
  shared(() => { throw new Error('reply lost') })
  const { invoke } = await import('../src/services/backend')
  await invoke('save_batch', { id: 'b', assets: ['one'] }).catch(() => {})
  const first = api.invoke.mock.calls.at(-1)?.[1].requestId
  await invoke('save_batch', { id: 'b', assets: ['two'] }).catch(() => {})
  expect(api.invoke.mock.calls.at(-1)?.[1].requestId).not.toBe(first)
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
