import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>(), stop: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, handler: (event: { payload: unknown }) => void) => { mocks.handlers.set(name, handler); return mocks.stop } }))
import { importAssets } from '../src/modules/schematic/services/uploadService'
beforeEach(() => { vi.clearAllMocks(); mocks.handlers.clear(); vi.stubGlobal('window', { setTimeout }) })
test('compact completion waits for streamed SVG and keeps the original resources', async () => {
  const svg = '<svg width="20mm" height="30mm"/>'
  const onAssets = vi.fn()
  mocks.invoke.mockImplementation(async (_command, args) => {
    setTimeout(() => mocks.handlers.get('import-asset-batch')!({ payload: { requestId: args.requestId, assets: [{ id: 'one', svg }] } }), 10)
    return [{ id: 'one', svg: '' }]
  })
  const result = await importAssets(undefined, onAssets, 'ds.svg')
  expect(result).toEqual([{ id: 'one', svg }])
  expect(result[0]).toBe(onAssets.mock.calls[0][0][0])
  expect(mocks.stop).toHaveBeenCalledTimes(2)
})
