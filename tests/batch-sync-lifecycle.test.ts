import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Asset } from '../src/model'

const api = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/services/backend', () => ({ invoke: api.invoke, storageMode: async () => ({ shared: true }) }))
import { enqueueCloudBatchSave, clearCloudBatchSave, flushCloudSyncQueue } from '../src/services/cloudSyncQueue'
import { discardTemporaryAssets, loadHistoryBatch } from '../src/modules/schematic/services/batchHistoryService'

const asset: Asset = { id: 'image', name: 'image', productId: 'a', width: 10, height: 10, svg: '', previewUrl: '', thumbnailUrl: '', storagePath: 'temp-assets/image.svg', attributes: { QT: '25' } }
let finishSave: (() => void) | undefined
let saved = false
beforeEach(() => {
  localStorage.clear()
  api.invoke.mockReset()
  finishSave = undefined
  saved = false
  api.invoke.mockImplementation((command: string) => {
    if (command === 'save_batch') return new Promise(resolve => { finishSave = () => { saved = true; resolve({ batchId: 'batch', assets: [{ ...asset, storagePath: 'printflow:image' }] }) } })
    if (command === 'load_batch') return Promise.resolve({ id: 'batch', assets: [{ ...asset, attributes: { QT: saved ? '25' : '1' } }] })
    if (command === 'load_batch_asset_svg') return Promise.resolve(new TextEncoder().encode('<svg/>').buffer)
    return Promise.resolve()
  })
})
afterEach(async () => { clearCloudBatchSave('batch'); finishSave?.(); await flushCloudSyncQueue(); localStorage.clear() })

async function startSave() {
  enqueueCloudBatchSave({ id: 'batch', savedAt: 'now', assets: [asset] })
  await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'))
}

test('returning to history keeps temporary artwork that the background save still needs', async () => {
  await startSave()
  const abandoned = { ...asset, id: 'abandoned', storagePath: 'temp-assets/abandoned.svg' }
  await discardTemporaryAssets([asset, abandoned])
  const cleanup = api.invoke.mock.calls.find(([command]) => command === 'discard_temp_assets')
  expect(cleanup?.[1].assets.map((item: Asset) => item.id)).toEqual(['abandoned'])
})

test('reopening history waits for pending QT edits instead of restoring an older cloud snapshot', async () => {
  await startSave()
  const loading = loadHistoryBatch('batch')
  await Promise.resolve()
  const calledBeforeSave = api.invoke.mock.calls.some(([command]) => command === 'load_batch')
  finishSave?.()
  const loaded = await loading
  expect(calledBeforeSave).toBe(false)
  expect(loaded.assets[0].attributes?.QT).toBe('25')
})
