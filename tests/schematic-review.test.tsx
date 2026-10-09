import type { ComponentProps } from 'react'
import { ConfigProvider } from 'antd'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { defaultLayoutBounds, type Asset } from '../src/model'
import { paginateAssets } from '../src/modules/schematic/services/paginationService'
import { emptyArrangementDisplayState, restoreArrangementDisplay } from '../src/modules/schematic/services/arrangementDisplayState'
import { createReviewRecord, exportAndRecord, loadReviewRecord, type SchematicReviewRecord } from '../src/modules/schematic-review/reviewRecords'
import type ArrangePage from '../src/modules/schematic/ArrangePage'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), exportPdf: vi.fn(), exportPage: vi.fn(), arrange: vi.fn(), autoArrange: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save, open: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
vi.mock('../src/modules/schematic/services/exportService', () => ({ exportPdf: mocks.exportPdf, exportPage: mocks.exportPage }))
vi.mock('../src/modules/schematic/services/productConfigService', () => ({ loadProductConfigs: async () => [], refreshProductConfigs: async () => {}, PRODUCT_CONFIGS_UPDATED_EVENT: 'configs' }))
vi.mock('../src/modules/schematic/services/finishService', () => ({ loadFinishNames: async () => ({}), invalidateFinishNames: () => {} }))
vi.mock('../src/modules/update/UpdateButton', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/UploadPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/services/paginationService', async importOriginal => ({ ...await importOriginal<object>(), autoArrangePages: mocks.autoArrange }))
vi.mock('../src/modules/schematic/ArrangePage', () => ({ default: (props: ComponentProps<typeof ArrangePage>) => {
  mocks.arrange(props)
  return <div>{props.context}<span>恢复的排列页</span><button onClick={() => props.onExport('pdf', props.displayState.dimensionDisplayOverrides)}>导出测试 PDF</button>
    <button onClick={() => props.onExport('png', props.displayState.dimensionDisplayOverrides)}>导出测试 PNG</button>
    <button onClick={() => props.onChangeItem({ ...props.pages[0].items[0], x: 123 })}>移动主图</button>
    <button onClick={() => props.onDisplayStateChange(previous => ({ ...previous, visualScales: new Map([[props.pages[0].items[0].id, 2]]) }))}>放大主图</button>
  </div>
} }))
import SchematicPage from '../src/modules/schematic/SchematicPage'
import SchematicReviewPage from '../src/modules/schematic-review/SchematicReviewPage'
import App from '../src/App'

const asset: Asset = { id: 'asset-1', name: 'proof.svg', productId: 'a', width: 42.756, height: 59.789, svg: '<svg/>', previewUrl: '', thumbnailUrl: '', note: '原始备注', attributes: { QT: '0' } }
function fixture() {
  const pages = paginateAssets([asset])
  const item = pages[0].items[0]
  item.x = 77; item.y = 203; item.rulerHeightRange = [0.2, 0.85]; item.rulerUnit = 'cm'
  if (pages[0].imageGroups?.[0].details) pages[0].imageGroups[0].details.note = '双击编辑后的备注'
  const display = emptyArrangementDisplayState()
  display.zoom = 1.4
  display.visualScales.set(item.id, 1.6)
  display.accessoryVisuals.set(`${pages[0].imageGroups![0].id}:accessory`, { scale: 1.2, x: 9, y: -4 })
  display.accessoryVisuals.set(`${pages[0].imageGroups![0].id}:note`, { scale: 0.8, x: -2, y: 7 })
  display.dimensionDisplayOverrides.set(item.id, { decimalPlaces: 0, precision: 'default' })
  return createReviewRecord({ assets: [asset], pages: [...pages, { id: 2, name: '保留空页', items: [] }], activePage: 1,
    metadata: { customerName: '审核客户', drawingDate: '2026-10-06', estimatedShipDate: '', designer: '设计师' },
    layoutBounds: { ...defaultLayoutBounds, left: 13 }, arrangementSort: 'upload', defaultArrangementIds: [asset.id] }, display, 'pdf', 'C:\\proof.pdf')
}
const summary = (record: SchematicReviewRecord) => ({ id: record.id, savedAt: record.savedAt, output: record.output, format: record.format, paymentStatus: record.paymentStatus, customerName: record.metadata.customerName, pageCount: record.pages.length, imageCount: 1 })
const latestArrange = () => mocks.arrange.mock.calls.at(-1)![0] as ComponentProps<typeof ArrangePage>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.save.mockResolvedValue('C:\\new-proof.pdf')
  mocks.exportPdf.mockResolvedValue(undefined)
  mocks.exportPage.mockResolvedValue(undefined)
  mocks.invoke.mockImplementation(async (command: string) => command === 'list_batches' ? [] : command === 'list_schematic_reviews' ? { records: [], total: 0, page: 1, pageSize: 20 } : undefined)
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  // jsdom does not support pseudo-element styles used by the table scrollbar probe.
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('freezes every page and map without changing source dimensions or sharing edits', () => {
  const record = fixture()
  const saved = JSON.parse(JSON.stringify(record)) as SchematicReviewRecord
  expect(saved.pages).toEqual(record.pages)
  expect(saved.assets[0].width).toBe(42.756)
  const display = restoreArrangementDisplay(saved.display)
  expect([...display.dimensionDisplayOverrides.values()][0].decimalPlaces).toBe(0)
  expect([...display.accessoryVisuals.values()]).toEqual([{ scale: 1.2, x: 9, y: -4 }, { scale: 0.8, x: -2, y: 7 }])
  saved.assets[0].note = '改动'
  expect(asset.note).toBe('原始备注')
})

it('restores exact arrangement, text, rulers and independent visuals without auto arrangement', async () => {
  const record = fixture()
  render(<SchematicPage initialRecord={record}/> )
  await screen.findByText('恢复的排列页')
  const props = latestArrange()
  expect(props.pages).toEqual(record.pages)
  expect(props.assets).toEqual(record.assets)
  expect(props.metadata).toEqual(record.metadata)
  expect(props.layoutBounds).toEqual(record.layoutBounds)
  expect(props.sortMode).toBe('upload')
  expect(props.displayState).toEqual(restoreArrangementDisplay(record.display))
  expect(mocks.autoArrange).not.toHaveBeenCalled()
})

it('records the exported revision only after successful export, and saves later edits as another revision', async () => {
  const record = fixture()
  const saved = vi.fn()
  let complete!: () => void
  mocks.exportPdf.mockReturnValue(new Promise<void>(resolve => { complete = resolve }))
  render(<SchematicPage initialRecord={record} onRecordSaved={saved}/> )
  fireEvent.click(await screen.findByText('导出测试 PDF'))
  await waitFor(() => expect(mocks.exportPdf).toHaveBeenCalledOnce())
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'save_schematic_review')).toHaveLength(0)
  await act(async () => complete())
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  const first = mocks.invoke.mock.calls.find(call => call[0] === 'save_schematic_review')![1].record as SchematicReviewRecord
  expect(first.pages).toEqual(record.pages)
  expect(first.display).toEqual(record.display)
  expect(first.sourceRecordId).toBe(record.id)
  expect(first.id).not.toBe(record.id)
  fireEvent.click(screen.getByText('移动主图'))
  fireEvent.click(screen.getByText('放大主图'))
  fireEvent.click(screen.getByText('导出测试 PNG'))
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(2))
  const second = mocks.invoke.mock.calls.filter(call => call[0] === 'save_schematic_review')[1][1].record as SchematicReviewRecord
  expect(second.pages[0].items[0].x).toBe(123)
  expect(second.display.visualScales[0][1]).toBe(2)
  expect(first.pages[0].items[0].x).toBe(77)
  expect(second.id).not.toBe(first.id)
  expect(second.assets[0].width).toBe(42.756)
})

it('cancel and export failure never create a review record', async () => {
  mocks.save.mockResolvedValueOnce(null)
  mocks.exportPdf.mockRejectedValueOnce(new Error('磁盘已满'))
  render(<SchematicPage initialRecord={fixture()}/> )
  fireEvent.click(await screen.findByText('导出测试 PDF'))
  await waitFor(() => expect(latestArrange().exporting).toBe(false))
  expect(mocks.exportPdf).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('导出测试 PDF'))
  await screen.findByText('Error: 磁盘已满')
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'save_schematic_review')).toHaveLength(0)
})

it('reports record failure independently from file export and permits retrying the same revision', async () => {
  const record = fixture()
  const exporter = vi.fn().mockResolvedValue(undefined)
  mocks.invoke.mockRejectedValueOnce(new Error('数据库不可写'))
  const result = await exportAndRecord(record, exporter)
  expect(exporter).toHaveBeenCalledOnce()
  expect(result.saved).toBe(false)
  expect(String(result.error)).toContain('数据库不可写')
})

it('retries record persistence without exporting the file again', async () => {
  let attempts = 0
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_batches') return []
    if (command === 'save_schematic_review' && attempts++ === 0) throw new Error('数据库暂时不可写')
  })
  const onRecordSaved = vi.fn()
  render(<SchematicPage initialRecord={fixture()} onRecordSaved={onRecordSaved}/> )
  fireEvent.click(await screen.findByText('导出测试 PDF'))
  fireEvent.click(await screen.findByRole('button', { name: '重试保存记录' }))
  await waitFor(() => expect(onRecordSaved).toHaveBeenCalledOnce())
  expect(mocks.exportPdf).toHaveBeenCalledOnce()
  const records = mocks.invoke.mock.calls.filter(call => call[0] === 'save_schematic_review')
  expect(records).toHaveLength(2)
  expect(records[1][1].record).toEqual(records[0][1].record)
})

it('review list loads lightweight summaries, searches and opens the selected record', async () => {
  const record = fixture()
  mocks.invoke.mockImplementation(async (command, args) => command === 'list_schematic_reviews' ? { records: args.query.search === '不存在' ? [] : [summary(record)], total: args.query.search === '不存在' ? 0 : 1, page: 1, pageSize: 20 } : record)
  const onEdit = vi.fn()
  const view = render(<SchematicReviewPage active revision={0} onEdit={onEdit}/> )
  await screen.findByText('审核客户')
  expect(mocks.invoke).not.toHaveBeenCalledWith('load_schematic_review', expect.anything())
  fireEvent.change(screen.getByLabelText('搜索审核记录'), { target: { value: '不存在' } })
  await screen.findByText('没有匹配的记录')
  fireEvent.change(screen.getByLabelText('搜索审核记录'), { target: { value: 'proof' } })
  fireEvent.click(await screen.findByRole('button', { name: /^编\s*辑$/ }))
  await waitFor(() => expect(onEdit).toHaveBeenCalledWith(record))
  view.rerender(<SchematicReviewPage active revision={1} onEdit={onEdit}/> )
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(call => call[0] === 'list_schematic_reviews')).toHaveLength(4))
})

it('App edit routing restores the record again after returning to the list', async () => {
  const record = fixture()
  mocks.invoke.mockImplementation(async command => command === 'list_schematic_reviews' ? { records: [summary(record)], total: 1, page: 1, pageSize: 20 } : command === 'load_schematic_review' ? structuredClone(record) : command === 'list_batches' ? [] : undefined)
  render(<App/> )
  fireEvent.click(screen.getByRole('button', { name: '示意图审核' }))
  fireEvent.click(await screen.findByRole('button', { name: /^编\s*辑$/ }))
  await screen.findByText('恢复的排列页')
  expect(latestArrange().pages).toEqual(record.pages)
  fireEvent.click(screen.getByText('移动主图'))
  expect(latestArrange().pages[0].items[0].x).toBe(123)
  fireEvent.click(screen.getByRole('button', { name: '示意图审核' }))
  await waitFor(() => expect(document.querySelector('.schematic-review-page')?.textContent).toContain('审核客户'))
  fireEvent.click(await screen.findByRole('button', { name: /^编\s*辑$/ }))
  await waitFor(() => expect(latestArrange().pages[0].items[0].x).toBe(77))
})

it('unsupported saved schema fails without opening the editor', async () => {
  mocks.invoke.mockResolvedValue({ ...fixture(), schemaVersion: 999 })
  await expect(loadReviewRecord('old')).rejects.toThrow('版本暂不支持')
})

it('requests only the selected page and requires confirmation before deleting the last row on it', async () => {
  let rows = Array.from({ length: 21 }, (_, index) => ({ ...summary(fixture()), id: `row-${index}`, customerName: `分页客户${index}` }))
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_schematic_reviews') {
      const page = Math.min(args.query.page, Math.max(1, Math.ceil(rows.length / args.query.pageSize)))
      return { records: rows.slice((page - 1) * args.query.pageSize, page * args.query.pageSize), total: rows.length, page, pageSize: args.query.pageSize }
    }
    if (command === 'delete_schematic_review') rows = rows.filter(row => row.id !== args.id)
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><SchematicReviewPage active revision={0} onEdit={vi.fn()}/></ConfigProvider>)
  await screen.findByText('分页客户0')
  expect(screen.queryByText('分页客户20')).toBeNull()
  expect(mocks.invoke).toHaveBeenCalledWith('list_schematic_reviews', { query: expect.objectContaining({ page: 1, pageSize: 20 }) })
  fireEvent.click(screen.getByTitle('2'))
  await screen.findByText('分页客户20')
  expect(screen.queryByText('分页客户0')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '删除' }))
  let dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('删除这条审核记录？')
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'delete_schematic_review')).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole('button', { name: /取\s*消/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByText('分页客户20')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '删除' }))
  dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: /删\s*除/ }))
  await screen.findByText('分页客户0')
  expect(mocks.invoke).toHaveBeenCalledWith('delete_schematic_review', { id: 'row-20' })
  expect(screen.getByText('共 20 条记录')).toBeTruthy()
  expect(document.querySelector('.ant-pagination-item-active')?.getAttribute('title')).toBe('1')
  await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith('list_schematic_reviews', { query: expect.objectContaining({ page: 1, pageSize: 20 }) }))
})

it('App stays in review after transfer and refreshes the pending table when explicitly opened', async () => {
  const record = fixture()
  let transferred = false
  const job = { id: 'new-job', sourceReviewId: record.id, customerName: '审核客户', output: record.output, submittedAt: record.savedAt, paymentStatus: 'unpaid', status: 'pending', imageCount: 1 }
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_batches') return []
    if (command === 'list_schematic_reviews') return { records: [{ ...summary(record), impositionJobId: transferred ? job.id : undefined }], total: 1, page: 1, pageSize: 20 }
    if (command === 'submit_schematic_review_to_imposition') { transferred = true; return job }
    if (command === 'list_pending_impositions') return { records: transferred ? [job] : [], total: transferred ? 1 : 0, page: 1, pageSize: 20 }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><App/></ConfigProvider>)
  fireEvent.click(screen.getByRole('button', { name: '生产拼版' }))
  await screen.findByText('共 0 条待拼版记录')
  fireEvent.click(screen.getByRole('button', { name: '示意图审核' }))
  fireEvent.click(await screen.findByRole('button', { name: '拼版' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '未付款拼版' }))
  await screen.findByRole('button', { name: '查看拼版' })
  expect(document.querySelector('.workflow button.active')?.textContent).toBe('示意图审核')
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'list_pending_impositions')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
  await waitFor(() => expect(screen.getByRole('button', { name: '查看拼版' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '查看拼版' }))
  await screen.findByRole('heading', { name: '待拼版' })
  await screen.findByText('共 1 条待拼版记录')
  expect(mocks.invoke).toHaveBeenCalledWith('list_pending_impositions', { query: { page: 1, pageSize: 20, search: '' } })
  fireEvent.click(screen.getByRole('button', { name: '示意图审核' }))
  await screen.findByRole('button', { name: '查看拼版' })
  expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
  expect(document.querySelector('.review-imposition-unpaid')).toBeTruthy()
})

it('transfers paid and unpaid rows, hides editing/deletion and preserves three distinct states after refresh', async () => {
  let rows = [{ ...summary(fixture()), id: 'first', customerName: '首条客户', impositionJobId: undefined as string | undefined }, { ...summary(fixture()), id: 'second', customerName: '第二客户', impositionJobId: undefined as string | undefined }, { ...summary(fixture()), id: 'third', customerName: '第三客户', impositionJobId: undefined as string | undefined }]
  const onImposition = vi.fn()
  const onImpositionSubmitted = vi.fn()
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_schematic_reviews') return { records: structuredClone(rows), total: 3, page: 1, pageSize: 20 }
    if (command === 'submit_schematic_review_to_imposition') {
      rows = rows.map(row => row.id === args.id ? { ...row, paymentStatus: args.paymentStatus, impositionJobId: `job-${args.id}` } : row)
      return { id: `job-${args.id}`, paymentStatus: args.paymentStatus }
    }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><SchematicReviewPage active revision={0} onEdit={vi.fn()} onImpositionSubmitted={onImpositionSubmitted} onImposition={onImposition}/></ConfigProvider>)
  const row = () => screen.getByText('首条客户').closest('tr')!
  await screen.findByText('首条客户')
  const headers = screen.getAllByRole('columnheader').map(header => header.textContent)
  expect(headers.slice(-2)).toEqual(['状态', '操作'])
  expect(within(row()).getByText('未付款')).toBeTruthy()
  expect(row().classList.contains('review-payment-unpaid')).toBe(true)
  expect(within(row()).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['编辑', '拼版', '删除'])
  fireEvent.click(within(row()).getByRole('button', { name: '拼版' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '已付款拼版' }))
  await waitFor(() => expect(within(row()).getByText('付款 · 待拼版')).toBeTruthy())
  expect(row().classList.contains('review-payment-paid')).toBe(true)
  expect(screen.getByText('第二客户').closest('tr')!.classList.contains('review-payment-unpaid')).toBe(true)
  expect(mocks.invoke).toHaveBeenCalledWith('submit_schematic_review_to_imposition', { id: 'first', paymentStatus: 'paid' })
  expect(onImpositionSubmitted).toHaveBeenCalledOnce()
  expect(onImposition).not.toHaveBeenCalled()
  expect(within(row()).queryByRole('button', { name: '编辑' })).toBeNull()
  expect(within(row()).queryByRole('button', { name: '删除' })).toBeNull()
  expect(within(row()).queryByRole('button', { name: '拼版' })).toBeNull()
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(call => call[0] === 'list_schematic_reviews')).toHaveLength(2))
  fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(call => call[0] === 'list_schematic_reviews')).toHaveLength(3))
  const second = () => screen.getByText('第二客户').closest('tr')!
  await waitFor(() => expect(within(second()).getByRole('button', { name: '拼版' }).hasAttribute('disabled')).toBe(false))
  expect(within(row()).getByText('付款 · 待拼版')).toBeTruthy()
  fireEvent.click(within(second()).getByRole('button', { name: '拼版' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '未付款拼版' }))
  await waitFor(() => expect(within(second()).getByText('未付款 · 待拼版')).toBeTruthy())
  expect(second().classList.contains('review-imposition-unpaid')).toBe(true)
  expect(within(second()).queryByRole('button', { name: '编辑' })).toBeNull()
  expect(within(second()).queryByRole('button', { name: '删除' })).toBeNull()
  expect(screen.getByText('第三客户').closest('tr')!.classList.contains('review-payment-unpaid')).toBe(true)
  expect(mocks.invoke).toHaveBeenCalledWith('submit_schematic_review_to_imposition', { id: 'second', paymentStatus: 'unpaid' })
  expect(onImpositionSubmitted).toHaveBeenCalledTimes(2)
  expect(onImposition).not.toHaveBeenCalled()
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'load_schematic_review')).toBe(false)
})

it('keeps the original status while saving or when persistence fails', async () => {
  let reject!: (reason: Error) => void
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_schematic_reviews') return { records: [summary(fixture())], total: 1, page: 1, pageSize: 20 }
    if (command === 'submit_schematic_review_to_imposition') return new Promise<void>((_, rejectSave) => { reject = rejectSave })
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><SchematicReviewPage active revision={0} onEdit={vi.fn()}/></ConfigProvider>)
  await screen.findByText('审核客户')
  fireEvent.click(screen.getByRole('button', { name: '拼版' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '已付款拼版' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '编辑' }).hasAttribute('disabled')).toBe(true))
  expect(screen.getByText('未付款')).toBeTruthy()
  await act(async () => reject(new Error('数据库不可写')))
  await screen.findByText('进入生产拼版失败：Error: 数据库不可写')
  expect(screen.getByText('未付款').closest('tr')!.classList.contains('review-payment-unpaid')).toBe(true)
  expect(screen.getByRole('button', { name: '拼版' }).hasAttribute('disabled')).toBe(false)
})


it('returns a pending order to review and allows paid or unpaid imposition again', async () => {
  const record = fixture()
  let pending = true
  let returned = false
  let paymentStatus = 'paid'
  const job = () => ({ id: 'return-job', sourceReviewId: record.id, customerName: '审核客户', output: record.output, submittedAt: record.savedAt, paymentStatus, status: 'pending', imageCount: 1 })
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_batches') return []
    if (command === 'list_schematic_reviews') return { records: [{ ...summary(record), paymentStatus, returned, impositionJobId: pending ? 'return-job' : undefined }], total: 1, page: 1, pageSize: 20 }
    if (command === 'list_pending_impositions') return { records: pending ? [job()] : [], total: pending ? 1 : 0, page: 1, pageSize: 20 }
    if (command === 'return_imposition_to_review') { pending = false; returned = true }
    if (command === 'submit_schematic_review_to_imposition') { pending = true; returned = false; paymentStatus = args.paymentStatus; return job() }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><App/></ConfigProvider>)
  fireEvent.click(screen.getByRole('button', { name: '示意图审核' }))
  await screen.findByRole('button', { name: '查看拼版' })
  fireEvent.click(screen.getByRole('button', { name: '生产拼版' }))
  fireEvent.click(await screen.findByRole('button', { name: '回退' }))
  fireEvent.click(within(await screen.findByRole('tooltip')).getByRole('button', { name: /回\s*退/ }))
  await screen.findByText('共 0 条待拼版记录')
  expect(mocks.invoke).toHaveBeenCalledWith('return_imposition_to_review', { id: 'return-job' })
  fireEvent.click(screen.getByRole('button', { name: '示意图审核' }))
  await screen.findByText('被退回')
  expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '拼版' }))
  expect(await screen.findByRole('menuitem', { name: '已付款拼版' })).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: '未付款拼版' }))
  await screen.findByText('未付款 · 待拼版')
  expect(screen.queryByText('被退回')).toBeNull()
  expect(mocks.invoke).toHaveBeenCalledWith('submit_schematic_review_to_imposition', { id: record.id, paymentStatus: 'unpaid' })
  fireEvent.click(screen.getByRole('button', { name: '生产拼版' }))
  await screen.findByText('共 1 条待拼版记录')
})
