import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Asset, Page } from '../src/model'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), importAssets: vi.fn(), storageMode: vi.fn() }))
vi.mock('../src/services/backend', () => ({ invoke: mocks.invoke, storageMode: mocks.storageMode }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
vi.mock('../src/modules/schematic/services/uploadService', () => ({ importAssets: mocks.importAssets }))
vi.mock('../src/modules/schematic/services/productConfigService', async importOriginal => ({
  ...await importOriginal<object>(),
  loadProductConfigs: async () => [{ id: 'test-product', title: '测试产品', options: [] }],
}))
vi.mock('../src/modules/schematic/services/finishService', () => ({ loadFinishNames: async () => ({}) }))
vi.mock('../src/modules/schematic/history/BatchHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/CustomProductForm', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/CorelDrawTool', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/ArrangePage', () => ({ default: ({ pages }: { pages: Page[] }) => <div>{pages.length}</div> }))
vi.mock('../src/modules/schematic/components/LazySvgImage', () => ({ default: ({ alt }: { alt: string }) => <img alt={alt}/> }))

import SchematicPage from '../src/modules/schematic/SchematicPage'
import { flushCloudSyncQueue } from '../src/services/cloudSyncQueue'

type SaveArgs = { id: string; assets: Asset[]; metadata: unknown }
type PendingSave = { args: SaveArgs; resolve: (value: unknown) => void }
const assets: Asset[] = ['A', 'B', 'C'].map(id => ({
  id, name: `图片${id}`, productId: 'test-product', productName: '测试产品',
  attributes: {}, attributesConfirmed: true, width: 200, height: 100, svg: '',
  storagePath: `printflow:${id}`, thumbnailUrl: '', previewUrl: '',
}))
const savedResult = (args: SaveArgs) => ({ batchId: args.id, assets: args.assets, metadata: args.metadata, duplicate: false })
let delaySaves = false
let pending: PendingSave[] = []

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  delaySaves = false
  pending = []
  mocks.storageMode.mockReset().mockResolvedValue({ shared: true })
  mocks.importAssets.mockResolvedValue(assets)
  mocks.invoke.mockImplementation((command: string, args: SaveArgs) => {
    if (command === 'save_batch') {
      if (delaySaves) return new Promise(resolve => pending.push({ args, resolve }))
      return Promise.resolve(savedResult(args))
    }
    return Promise.resolve(undefined)
  })
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
})

afterEach(async () => {
  cleanup()
  delaySaves = false
  for (const save of pending.splice(0)) save.resolve(savedResult(save.args))
  await flushCloudSyncQueue()
  localStorage.clear()
})

test('keeps every confirmed QT visible when an earlier cloud save completes during consecutive edits', async () => {
  const { container } = render(<SchematicPage />)
  fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
  await screen.findByText('当前批次图片')
  await act(() => flushCloudSyncQueue())
  const categories = screen.getByRole('navigation', { name: '图片产品分类' })
  fireEvent.click(within(categories).getByRole('button', { name: /全部/ }))
  fireEvent.click(screen.getByRole('tab', { name: '图片属性' }))
  delaySaves = true

  for (const [id, quantity] of [['A', '11'], ['B', '22'], ['C', '33']]) {
    fireEvent.click(screen.getByRole('checkbox', { name: `选择 图片${id}` }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'QT（数量）' }), { target: { value: quantity } })
    fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))
    await waitFor(() => expect(container.querySelector(`[data-asset-id="${id}"]`)?.textContent).toContain(`QT：${quantity}`))
    await waitFor(() => expect((screen.getByRole('button', { name: /^确\s*认$/ }) as HTMLButtonElement).disabled).toBe(false))
  }
  expect(pending).toHaveLength(1)
  expect(pending[0].args.assets.map(asset => asset.attributes?.QT)).toEqual(['11', undefined, undefined])

  // Complete the first edit while the newer B/C snapshot is still queued.
  const firstSave = pending.shift()!
  await act(async () => { firstSave.resolve(savedResult(firstSave.args)) })
  await waitFor(() => expect(pending).toHaveLength(1))
  expect(pending[0].args.assets.map(asset => asset.attributes?.QT)).toEqual(['11', '22', '33'])
  for (const [id, quantity] of [['A', '11'], ['B', '22'], ['C', '33']]) {
    expect(container.querySelector(`[data-asset-id="${id}"]`)?.textContent).toContain(`QT：${quantity}`)
  }

  const latestSave = pending.shift()!
  await act(async () => { latestSave.resolve(savedResult(latestSave.args)); await flushCloudSyncQueue() })
  for (const [id, quantity] of [['A', '11'], ['B', '22'], ['C', '33']]) {
    expect(container.querySelector(`[data-asset-id="${id}"]`)?.textContent).toContain(`QT：${quantity}`)
  }
})

test('keeps batch metadata edited locally while the current QT save is in flight', async () => {
  const { container } = render(<SchematicPage />)
  fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
  await screen.findByText('当前批次图片')
  await act(() => flushCloudSyncQueue())
  fireEvent.click(within(screen.getByRole('navigation', { name: '图片产品分类' })).getByRole('button', { name: /全部/ }))
  fireEvent.click(screen.getByRole('tab', { name: '图片属性' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 图片A' }))
  delaySaves = true
  fireEvent.change(screen.getByRole('spinbutton', { name: 'QT（数量）' }), { target: { value: '11' } })
  fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))
  await waitFor(() => expect(container.querySelector('[data-asset-id="A"]')?.textContent).toContain('QT：11'))
  await waitFor(() => expect(pending).toHaveLength(1))
  fireEvent.click(screen.getByRole('tab', { name: '图片上传' }))
  const metadataEdits = [
    ['客户名称', '刚修改的客户'],
    ['Drawing Date / 绘图日期', '2026-11-03'],
    ['Estimated Ship Date / 预计发货日期', '2026-11-20'],
    ['Designer / 来源', '刚修改的来源'],
  ]
  for (const [label, value] of metadataEdits) fireEvent.change(screen.getByLabelText(label), { target: { value } })

  const currentSave = pending.shift()!
  await act(async () => { currentSave.resolve(savedResult(currentSave.args)); await flushCloudSyncQueue() })
  for (const [label, value] of metadataEdits) expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value)
  expect(container.querySelector('[data-asset-id="A"]')?.textContent).toContain('QT：11')
})

test('keeps finalized resource paths and newer metadata when upload sync finishes during a storage-mode lookup', async () => {
  delaySaves = true
  mocks.importAssets.mockResolvedValue(assets.map(asset => ({ ...asset, storagePath: `temp-assets/${asset.id}.svg` })))
  const { container } = render(<SchematicPage />)
  fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
  await screen.findByText('当前批次图片')
  await waitFor(() => expect(pending).toHaveLength(1))
  fireEvent.click(within(screen.getByRole('navigation', { name: '图片产品分类' })).getByRole('button', { name: /全部/ }))
  fireEvent.click(screen.getByRole('tab', { name: '图片属性' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 图片A' }))

  let releaseMode!: (value: { shared: boolean }) => void
  const lookup = new Promise<{ shared: boolean }>(resolve => { releaseMode = resolve })
  mocks.storageMode.mockReturnValueOnce(lookup)
  const callsBeforeConfirm = mocks.storageMode.mock.calls.length
  fireEvent.change(screen.getByRole('spinbutton', { name: 'QT（数量）' }), { target: { value: '11' } })
  fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))
  try {
    await waitFor(() => expect(mocks.storageMode).toHaveBeenCalledTimes(callsBeforeConfirm + 1))
    fireEvent.click(screen.getByRole('tab', { name: '图片上传' }))
    fireEvent.change(screen.getByLabelText('客户名称'), { target: { value: '等待期间修改的客户' } })

    const uploadSave = pending.shift()!
    await act(async () => {
      uploadSave.resolve({ ...savedResult(uploadSave.args), assets: uploadSave.args.assets.map(asset => ({ ...asset, storagePath: `printflow:${asset.id}` })) })
      await flushCloudSyncQueue()
    })
  } finally {
    await act(async () => { releaseMode({ shared: true }); await lookup })
  }

  await waitFor(() => expect(pending).toHaveLength(1))
  expect(container.querySelector('[data-asset-id="A"]')?.textContent).toContain('QT：11')
  expect.soft(pending[0].args.assets.map(asset => asset.storagePath)).toEqual(['printflow:A', 'printflow:B', 'printflow:C'])
  expect(pending[0].args.assets[0].attributes?.QT).toBe('11')
  expect.soft(pending[0].args.metadata).toEqual(expect.objectContaining({ customerName: '等待期间修改的客户' }))
  expect.soft((screen.getByLabelText('客户名称') as HTMLInputElement).value).toBe('等待期间修改的客户')
})

test('deleting an image keeps finalized resource paths when upload sync finishes during the deletion lookup', async () => {
  delaySaves = true
  mocks.importAssets.mockResolvedValue(assets.map(asset => ({ ...asset, storagePath: `temp-assets/${asset.id}.svg` })))
  const { container } = render(<SchematicPage />)
  fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
  await screen.findByText('当前批次图片')
  await waitFor(() => expect(pending).toHaveLength(1))
  fireEvent.click(within(screen.getByRole('navigation', { name: '图片产品分类' })).getByRole('button', { name: /全部/ }))
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 图片A' }))
  fireEvent.click(screen.getByRole('button', { name: '删除选中图片' }))
  await screen.findByText('删除选中的 1 张图片？')

  let releaseMode!: (value: { shared: boolean }) => void
  const lookup = new Promise<{ shared: boolean }>(resolve => { releaseMode = resolve })
  mocks.storageMode.mockReturnValueOnce(lookup)
  const callsBeforeDelete = mocks.storageMode.mock.calls.length
  fireEvent.click(screen.getByRole('tooltip').querySelector('button.ant-btn-primary')!)
  try {
    await waitFor(() => expect(mocks.storageMode).toHaveBeenCalledTimes(callsBeforeDelete + 1))
    const uploadSave = pending.shift()!
    await act(async () => {
      uploadSave.resolve({ ...savedResult(uploadSave.args), assets: uploadSave.args.assets.map(asset => ({ ...asset, storagePath: `printflow:${asset.id}` })) })
      await flushCloudSyncQueue()
    })
    expect(mocks.invoke).toHaveBeenCalledWith('discard_temp_assets', expect.objectContaining({ assets: expect.arrayContaining([expect.objectContaining({ storagePath: 'temp-assets/B.svg' })]) }))
  } finally {
    await act(async () => { releaseMode({ shared: true }); await lookup })
  }

  await waitFor(() => expect(pending).toHaveLength(1))
  expect(container.querySelector('[data-asset-id="A"]')).toBeNull()
  expect(pending[0].args.assets.map(asset => asset.id)).toEqual(['B', 'C'])
  expect(pending[0].args.assets.map(asset => asset.storagePath)).toEqual(['printflow:B', 'printflow:C'])
})
