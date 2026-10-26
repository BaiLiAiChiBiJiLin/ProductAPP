vi.mock('../src/services/backend', async () => { const core = await import('@tauri-apps/api/core'); return { invoke: core.invoke, storageMode: async () => ({ shared: false }) } })
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Asset, Page } from '../src/model'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), importAssets: vi.fn(), arrange: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }))
vi.mock('../src/modules/schematic/services/uploadService', () => ({ importAssets: mocks.importAssets }))
vi.mock('../src/modules/schematic/services/productConfigService', async importOriginal => ({ ...await importOriginal<object>(), loadProductConfigs: async () => [] }))
vi.mock('../src/modules/schematic/services/finishService', () => ({ loadFinishNames: async () => ({}) }))
vi.mock('../src/modules/schematic/ArrangePage', () => ({ default: ({ pages }: { pages: Page[] }) => {
  mocks.arrange(pages)
  return <div>示意图排列页</div>
} }))
import SchematicPage from '../src/modules/schematic/SchematicPage'

const asset: Asset = { id: 'real-asset-1', name: '测试图', productId: 'a', width: 200, height: 100,
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="200" height="100" fill="red"/></svg>',
  thumbnailUrl: '', previewUrl: '' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.invoke.mockImplementation(async (command: string, args?: { assets?: Asset[]; id?: string; metadata?: unknown }) => {
    if (command === 'list_batches') return { records: [], total: 0, page: 1, pageSize: 12 }
    if (command === 'save_batch') return { assets: args?.assets ?? [], batchId: args?.id, metadata: args?.metadata, duplicate: false }
    return undefined
  })
  mocks.importAssets.mockResolvedValue([asset, { ...asset, id: 'real-asset-2', name: '测试图2' }])
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
})
afterEach(cleanup)

describe('product upload workflow', () => {
  it('imports images, reviews the pool, then opens the arranged preview', async () => {
    const { container } = render(<SchematicPage />)
    const upload = screen.getByRole('button', { name: /上传 SVG 文件/ })
    expect(container.querySelector('input[type=file]')).toBeNull()
    fireEvent.click(upload)
    await screen.findByText('当前批次图片')
    expect(mocks.importAssets).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '生成示意图' }))
    await screen.findByRole('list', { name: '图片池' })
    fireEvent.click(screen.getByRole('button', { name: '确认并生成' }))
    await screen.findByText('示意图排列页')
    expect(mocks.arrange.mock.lastCall?.[0]?.[0]?.items).toHaveLength(2)
  })

  it('canceling the picker leaves the upload page unchanged', async () => {
    mocks.importAssets.mockResolvedValue([])
    render(<SchematicPage />)
    fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
    await waitFor(() => expect(mocks.importAssets).toHaveBeenCalledOnce())
    expect((screen.getByRole('button', { name: '生成示意图' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('最近使用记录')).toBeTruthy()
  })

  it('shows an import failure without enabling the preview', async () => {
    mocks.importAssets.mockRejectedValue(new Error('SVG 解析失败'))
    render(<SchematicPage />)
    fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
    await waitFor(() => expect(screen.getAllByText(/SVG 解析失败/).length).toBeGreaterThan(0))
    expect((screen.getByRole('button', { name: '生成示意图' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
