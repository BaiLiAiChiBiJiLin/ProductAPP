import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Asset, Page } from '../src/model'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), importAssets: vi.fn(), storageMode: vi.fn(), arrange: vi.fn() }))
vi.mock('../src/services/localSyncState', async () => (await import('./helpers/localSyncStateMock')).browserLocalSyncStateMock())
vi.mock('../src/services/backend', () => ({ invoke: mocks.invoke, storageMode: mocks.storageMode }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
vi.mock('../src/modules/schematic/services/uploadService', () => ({ importAssets: mocks.importAssets }))
vi.mock('../src/modules/schematic/services/productConfigService', async importOriginal => ({ ...await importOriginal<object>(), loadProductConfigs: async () => [] }))
vi.mock('../src/modules/schematic/services/finishService', () => ({ loadFinishNames: async () => ({}) }))
vi.mock('../src/modules/schematic/history/BatchHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/CustomProductForm', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/CorelDrawTool', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/ArrangePage', () => ({ default: ({ pages, assets }: { pages: Page[]; assets: Asset[] }) => {
  mocks.arrange(assets)
  return <div data-testid="arrangement-pages">{pages.length}</div>
} }))
vi.mock('../src/modules/schematic/components/LazySvgImage', () => ({ default: ({ alt }: { alt: string }) => <img alt={alt}/> }))

import SchematicPage from '../src/modules/schematic/SchematicPage'
import { clearCloudBatchSave, cloudSyncTasks, enqueueCloudBatchSave, flushCloudSyncQueue } from '../src/services/cloudSyncQueue'

const asset: Asset = { id: 'shared-asset', name: '共享测试图', productId: 'a', width: 200, height: 100, svg: '', storagePath: 'temp-assets/shared-asset.svg', thumbnailUrl: '', previewUrl: '' }
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100"/></svg>'
type SaveArgs = { id: string; assets: Asset[]; metadata?: unknown }
let pending: Array<{ args: SaveArgs; resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
let saveFailure: Error | undefined

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  pending = []
  saveFailure = undefined
  mocks.storageMode.mockReset().mockResolvedValue({ shared: true })
  mocks.importAssets.mockResolvedValue([asset])
  mocks.invoke.mockImplementation((command: string, args: SaveArgs) => {
    if (command === 'save_batch') return saveFailure ? Promise.reject(saveFailure) : new Promise((resolve, reject) => pending.push({ args, resolve, reject }))
    if (command === 'load_temp_asset_svg') return Promise.resolve(new TextEncoder().encode(svg).buffer)
    if (command === 'discard_temp_assets') return Promise.resolve(undefined)
    return Promise.resolve(undefined)
  })
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
})
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  for (const task of cloudSyncTasks()) await clearCloudBatchSave(task.id)
  for (const save of pending) save.resolve({ batchId: save.args.id, assets: save.args.assets, metadata: save.args.metadata })
  await flushCloudSyncQueue().catch(() => {})
  localStorage.clear()
})

async function uploadBatch() {
  render(<SchematicPage />)
  fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
  await screen.findByText('当前批次图片')
  await waitFor(() => expect((screen.getByRole('button', { name: /上传 SVG 文件/ }) as HTMLButtonElement).disabled).toBe(false))
}

async function confirmArrangement() {
  fireEvent.click(screen.getByRole('button', { name: '生成示意图' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认并生成' }))
}

test('shows parsed assets before shared file storage finishes', async () => {
  await uploadBatch()
  expect(screen.getByText('共享测试图')).toBeTruthy()
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('save_batch', expect.objectContaining({ preserveTempAssets: true })))
  expect((screen.getByRole('button', { name: '保存批次' }) as HTMLButtonElement).disabled).toBe(false)
})

test('generates from local artwork while the current cloud upload is still in flight', async () => {
  await uploadBatch()
  await waitFor(() => expect(pending).toHaveLength(1))
  await confirmArrangement()
  expect((await screen.findByTestId('arrangement-pages')).textContent).toBe('1')
  expect(mocks.invoke).toHaveBeenCalledWith('load_temp_asset_svg', { path: asset.storagePath })
  expect(mocks.invoke.mock.calls.some(([command]) => command === 'load_batch_asset_svg')).toBe(false)
  expect(cloudSyncTasks()).toHaveLength(1)
})

test('saving and generating do not wait for an unrelated cloud upload', async () => {
  await enqueueCloudBatchSave({ id: 'unrelated-batch', savedAt: 'now', assets: [asset] })
  await waitFor(() => expect(pending).toHaveLength(1))
  await uploadBatch()
  fireEvent.change(screen.getByLabelText('客户名称'), { target: { value: '本机最新客户' } })
  fireEvent.click(screen.getByRole('button', { name: '保存批次' }))
  await screen.findByText('批次已保存到本机，正在后台同步')
  await confirmArrangement()
  expect((await screen.findByTestId('arrangement-pages')).textContent).toBe('1')
  expect(pending).toHaveLength(1)
  expect(cloudSyncTasks()).toHaveLength(2)
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('本机最新客户')
})

test('cloud journal failure keeps the queued batch while local arrangement remains available', async () => {
  await uploadBatch()
  await waitFor(() => expect(pending).toHaveLength(1))
  saveFailure = new Error('无法保存本地云端同步日志，请释放磁盘空间并检查本地存储后重试')
  await act(async () => { pending[0].reject(saveFailure!) })
  await waitFor(() => expect(cloudSyncTasks()[0]?.error).toContain('无法保存本地云端同步日志'))
  await confirmArrangement()
  expect((await screen.findByTestId('arrangement-pages')).textContent).toBe('1')
  expect(cloudSyncTasks()).toHaveLength(1)
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain(asset.storagePath)
  expect(screen.queryByText('批次已保存到历史记录')).toBeNull()
})

test('does not generate or announce a saved batch when persisting the latest local queue fails', async () => {
  await uploadBatch()
  await waitFor(() => expect(pending).toHaveLength(1))
  const savedQueue = localStorage.getItem('printflow-cloud-sync-queue-v1')
  fireEvent.change(screen.getByLabelText('客户名称'), { target: { value: '尚未持久化的客户' } })
  const setItem = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === 'printflow-cloud-sync-queue-v1') throw new Error('模拟本机磁盘写入失败')
    return setItem.call(this, key, value)
  })
  await confirmArrangement()
  await screen.findByText(/保存图片失败.*本地同步队列写入失败/)
  expect(screen.queryByTestId('arrangement-pages')).toBeNull()
  expect(screen.queryByText(/批次已保存到本机/)).toBeNull()
  expect((screen.getByLabelText('客户名称') as HTMLInputElement).value).toBe('尚未持久化的客户')
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toBe(savedQueue)
})

test('keeps local artwork available and uses current metadata when an acknowledgement arrives during confirmation', async () => {
  await uploadBatch()
  await waitFor(() => expect(pending).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: '生成示意图' }))
  const confirm = await screen.findByRole('button', { name: '确认并生成' })
  let releaseMode!: (value: { shared: boolean }) => void
  const mode = new Promise<{ shared: boolean }>(resolve => { releaseMode = resolve })
  mocks.storageMode.mockReturnValueOnce(mode)
  const modeCalls = mocks.storageMode.mock.calls.length
  fireEvent.click(confirm)
  try {
    await waitFor(() => expect(mocks.storageMode).toHaveBeenCalledTimes(modeCalls + 1))
    fireEvent.change(screen.getByLabelText('客户名称'), { target: { value: '确认期间更新的客户' } })
    await act(async () => {
      pending[0].resolve({ batchId: pending[0].args.id, assets: [{ ...asset, storagePath: 'printflow:shared-asset', attributes: { QT: '7' } }] })
    })
    await waitFor(() => expect(cloudSyncTasks()).toHaveLength(0))
    const cleanups = mocks.invoke.mock.calls.filter(([command]) => command === 'discard_temp_assets')
    expect(cleanups.flatMap(([, args]) => args.assets ?? []).some((value: Asset) => value.storagePath === asset.storagePath)).toBe(false)
  } finally {
    await act(async () => { releaseMode({ shared: true }); await mode })
  }
  expect((await screen.findByTestId('arrangement-pages')).textContent).toBe('1')
  expect(mocks.invoke).toHaveBeenCalledWith('load_temp_asset_svg', { path: asset.storagePath })
  expect(mocks.invoke.mock.calls.some(([command]) => command === 'load_batch_asset_svg')).toBe(false)
  expect(mocks.arrange.mock.lastCall?.[0]).toEqual([expect.objectContaining({ storagePath: 'printflow:shared-asset', attributes: { QT: '7' }, svg })])
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('确认期间更新的客户')
})
