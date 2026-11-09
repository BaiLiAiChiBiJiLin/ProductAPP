vi.mock('../src/services/backend', async () => { const core = await import('@tauri-apps/api/core'); return { invoke: core.invoke, storageMode: async () => ({ shared: false }) } })
vi.mock('../src/services/localSyncState', async () => (await import('./helpers/localSyncStateMock')).browserLocalSyncStateMock())
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DragDropEvent } from '@tauri-apps/api/webview'
import type { Event } from '@tauri-apps/api/event'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import type { Asset, Page } from '../src/model'
import type { BatchMetadata } from '../src/modules/schematic/types'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), importAssets: vi.fn(), arrange: vi.fn(), dropHandlers: new Set<(event: Event<DragDropEvent>) => void>() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async (handler: (event: Event<DragDropEvent>) => void) => { mocks.dropHandlers.add(handler); return () => { mocks.dropHandlers.delete(handler) } } }) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }))
vi.mock('../src/modules/schematic/services/uploadService', () => ({ importAssets: mocks.importAssets }))
vi.mock('../src/modules/schematic/services/productConfigService', async importOriginal => ({ ...await importOriginal<object>(), loadProductConfigs: async () => [] }))
vi.mock('../src/modules/schematic/services/finishService', () => ({ loadFinishNames: async () => ({}) }))
vi.mock('../src/modules/schematic/ArrangePage', () => ({ default: ({ pages }: { pages: Page[] }) => {
  mocks.arrange(pages)
  return <div>示意图排列页</div>
} }))
import SchematicPage from '../src/modules/schematic/SchematicPage'
import ImpositionUpload from '../src/modules/imposition/ImpositionUpload'

const asset: Asset = { id: 'real-asset-1', name: '测试图', productId: 'a', width: 200, height: 100,
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="200" height="100" fill="red"/></svg>',
  thumbnailUrl: '', previewUrl: '' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.dropHandlers.clear()
  mocks.invoke.mockImplementation(async (command: string, args?: { assets?: Asset[]; id?: string; metadata?: unknown }) => {
    if (command === 'list_batches') return { records: [], total: 0, page: 1, pageSize: 12 }
    if (command === 'save_batch') return { assets: args?.assets ?? [], batchId: args?.id, metadata: args?.metadata, duplicate: false }
    return undefined
  })
  mocks.importAssets.mockResolvedValue([asset, { ...asset, id: 'real-asset-2', name: '测试图2' }])
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.removeItem('printflow-account-name')
})

function mockHistoryBatch(metadata: BatchMetadata, savedAt: string) {
  const previous = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_batches') return { records: [{ id: 'metadata-history', savedAt, customerName: metadata.customerName, assetCount: 1 }], total: 1, page: 1, pageSize: 12 }
    if (command === 'load_batch') return { id: 'metadata-history', savedAt, metadata, assets: [asset] }
    if (command === 'load_batch_asset_svg') return new TextEncoder().encode(asset.svg).buffer
    return previous(command, args)
  })
}

describe('product upload workflow', () => {
  it('routes window SVG drops only to the visible module while retaining the schematic batch', async () => {
    const imported = vi.fn()
    const workspace = (schematicActive: boolean) => <><SchematicPage active={schematicActive}/><ImpositionUpload disabled={schematicActive} onImported={imported}/></>
    const view = render(workspace(true))
    fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
    await screen.findByText('共 2 张')
    await waitFor(() => expect((screen.getByRole('button', { name: /上传 SVG 文件/ }) as HTMLButtonElement).disabled).toBe(false))
    await waitFor(() => expect(mocks.dropHandlers.size).toBe(1))
    const staleSchematicHandlers = [...mocks.dropHandlers]
    const baseInvoke = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (command, args) => command === 'import_imposition_svg'
      ? { id: 'imposition-import-only', images: [], temporary: true } : baseInvoke(command, args))
    const zone = screen.getByRole('button', { name: /^上传 SVG.*点击或拖入/ })
    const bounds = vi.spyOn(zone, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 50, 200, 100))
    const drop: Event<DragDropEvent> = { event: 'tauri://drag-drop', id: 1, payload: { type: 'drop', paths: ['C:/art/拼版专用.svg'], position: new PhysicalPosition(100, 100) } }
    view.rerender(workspace(false))
    await act(async () => { for (const handler of [...mocks.dropHandlers]) handler(drop) })
    await waitFor(() => expect(imported).toHaveBeenCalledOnce())
    expect(mocks.importAssets).toHaveBeenCalledTimes(1)
    expect(screen.getByText('共 2 张')).toBeTruthy()
    // A queued native event must also be ignored after its listener was disposed.
    await act(async () => { for (const handler of staleSchematicHandlers) handler(drop) })
    expect(mocks.importAssets).toHaveBeenCalledTimes(1)
    mocks.importAssets.mockResolvedValueOnce([{ ...asset, id: 'schematic-drop-only', name: '示意图新增图片' }])
    view.rerender(workspace(true))
    await waitFor(() => expect(mocks.dropHandlers.size).toBe(1))
    await act(async () => { for (const handler of [...mocks.dropHandlers]) handler(drop) })
    await waitFor(() => expect(mocks.importAssets).toHaveBeenCalledTimes(2))
    await screen.findByText('共 3 张')
    expect(imported).toHaveBeenCalledOnce()
    bounds.mockRestore()
  })

  it('defaults a new batch to the local date, eight days later and the saved username, then persists those values', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 11, 27, 23, 45))
    localStorage.setItem('printflow-account-name', '本机设计师')
    render(<SchematicPage />)

    vi.setSystemTime(new Date(2026, 11, 28, 0, 15))
    fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
    await screen.findByText('当前批次图片')
    expect((screen.getByLabelText('Drawing Date / 绘图日期') as HTMLInputElement).value).toBe('2026-12-28')
    expect((screen.getByLabelText('Estimated Ship Date / 预计发货日期') as HTMLInputElement).value).toBe('2027-01-05')
    expect((screen.getByLabelText('Designer / 来源') as HTMLInputElement).value).toBe('本机设计师')

    fireEvent.click(screen.getByRole('button', { name: '保存批次' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('save_batch', expect.objectContaining({
      metadata: { customerName: '测试图', drawingDate: '2026-12-28', estimatedShipDate: '2027-01-05', designer: '本机设计师' },
    })))
    await screen.findByText('批次已保存到历史记录')
  })

  it('fills blank historical dates from the saved record date and preserves its recorded designer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 2, 12))
    mockHistoryBatch({ customerName: '历史日期批次', drawingDate: '', estimatedShipDate: '', designer: '原设计者' }, new Date(2026, 9, 7, 23, 30).toISOString())
    render(<SchematicPage userName="当前用户" />)

    fireEvent.click(await screen.findByRole('button', { name: '打开批次 历史日期批次' }))
    await screen.findByText('当前批次图片')
    expect((screen.getByLabelText('Drawing Date / 绘图日期') as HTMLInputElement).value).toBe('2026-10-07')
    expect((screen.getByLabelText('Estimated Ship Date / 预计发货日期') as HTMLInputElement).value).toBe('2026-10-15')
    expect((screen.getByLabelText('Designer / 来源') as HTMLInputElement).value).toBe('原设计者')
  })

  it('restores explicitly saved batch fields and preserves manual edits when more images are appended', async () => {
    mockHistoryBatch({ customerName: '已填写批次', drawingDate: '2026-09-20', estimatedShipDate: '2026-10-12', designer: '保存的来源' }, new Date(2026, 9, 7, 12).toISOString())
    render(<SchematicPage userName="当前用户" />)
    fireEvent.click(await screen.findByRole('button', { name: '打开批次 已填写批次' }))
    await screen.findByText('当前批次图片')
    expect((screen.getByLabelText('Drawing Date / 绘图日期') as HTMLInputElement).value).toBe('2026-09-20')
    expect((screen.getByLabelText('Estimated Ship Date / 预计发货日期') as HTMLInputElement).value).toBe('2026-10-12')
    expect((screen.getByLabelText('Designer / 来源') as HTMLInputElement).value).toBe('保存的来源')

    fireEvent.change(screen.getByLabelText('Drawing Date / 绘图日期'), { target: { value: '2026-09-22' } })
    fireEvent.change(screen.getByLabelText('Estimated Ship Date / 预计发货日期'), { target: { value: '2026-11-01' } })
    fireEvent.change(screen.getByLabelText('Designer / 来源'), { target: { value: '手动来源' } })
    mocks.importAssets.mockResolvedValueOnce([{ ...asset, id: 'appended-asset', name: '追加图' }])
    fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
    await screen.findByRole('button', { name: '预览 追加图' })
    await waitFor(() => expect((screen.getByRole('button', { name: /上传 SVG 文件/ }) as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByLabelText('Drawing Date / 绘图日期') as HTMLInputElement).value).toBe('2026-09-22')
    expect((screen.getByLabelText('Estimated Ship Date / 预计发货日期') as HTMLInputElement).value).toBe('2026-11-01')
    expect((screen.getByLabelText('Designer / 来源') as HTMLInputElement).value).toBe('手动来源')

    fireEvent.click(screen.getByRole('button', { name: '保存批次' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('save_batch', expect.objectContaining({
      id: 'metadata-history', metadata: { customerName: '已填写批次', drawingDate: '2026-09-22', estimatedShipDate: '2026-11-01', designer: '手动来源' },
    })))
    await screen.findByText('批次已保存到历史记录')
  })

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

  it('deletes all selected images from the current batch after confirmation', async () => {
    render(<SchematicPage />)
    fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
    await screen.findByText('当前批次图片')

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 测试图' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 测试图2' }), { ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: '删除选中图片' }))

    await screen.findByText('删除选中的 2 张图片？')
    const popover = screen.getByRole('tooltip')
    fireEvent.click(popover.querySelector('button.ant-btn-primary')!)

    await waitFor(() => expect(screen.getByText('共 0 张')).toBeTruthy())
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'delete_asset')).toHaveLength(2)
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
