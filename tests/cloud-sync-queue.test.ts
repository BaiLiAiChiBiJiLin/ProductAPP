import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const api = vi.hoisted(() => ({ invoke: vi.fn(), storageMode: vi.fn() }))
vi.mock('../src/services/backend', () => api)

import { enqueueCloudBatchSave, flushCloudSyncQueue, onCloudBatchSaveComplete } from '../src/services/cloudSyncQueue'

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
