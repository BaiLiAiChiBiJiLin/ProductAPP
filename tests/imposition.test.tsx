vi.mock('../src/services/backend', async () => { const core = await import('@tauri-apps/api/core'); return { invoke: core.invoke, storageMode: async () => ({ shared: false }) } })
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import ImpositionPage from '../src/modules/imposition/ImpositionPage'
import ImpositionThumbnail from '../src/modules/imposition/ImpositionThumbnail'
import { expandImpositionImages, getImpositionQuantity, type ImpositionJob, type ImpositionRecord, type ProductionImage } from '../src/modules/imposition/impositionRecords'
import type { PackedImpositionItem } from '../src/modules/imposition/ImpositionKonvaCanvas'
import { applyPackingEdit, type PackingEdit } from '../src/modules/imposition/packingEdits'
import { IMPOSITION_THREADS_STORAGE_KEY } from '../src/modules/imposition/useImpositionThreads'
import { DEFAULT_LAYOUT_PRESETS, LAYOUT_PRESET_STORAGE_KEY } from '../src/modules/imposition/layoutPresetStore'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), importSvg: vi.fn(), canvas: vi.fn((_props: { pages: PackedImpositionItem[][]; collapseRepeatedLayouts?: boolean; onEdit?: (pages: PackedImpositionItem[][], edit: PackingEdit) => void }) => null) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => false }))
vi.mock('../src/modules/imposition/layoutPresetStore', async importOriginal => ({ ...await importOriginal<typeof import('../src/modules/imposition/layoutPresetStore')>(), listLayoutPresets: async () => ({ presets: DEFAULT_LAYOUT_PRESETS, canManage: true }) }))
vi.mock('../src/modules/imposition/ImpositionKonvaCanvas', () => ({ default: mocks.canvas }))
vi.mock('../src/modules/imposition/impositionUploadService', async importOriginal => ({ ...await importOriginal<typeof import('../src/modules/imposition/impositionUploadService')>(), importImpositionSvg: mocks.importSvg }))
const jobs: ImpositionJob[] = Array.from({ length: 21 }, (_, index) => ({ id: `job-${index}`, sourceReviewId: `review-${index}`, customerName: `生产客户${index}`, output: `C:/proof-${index}.pdf`, submittedAt: '2026-10-08T01:00:00Z', paymentStatus: index % 2 ? 'unpaid' : 'paid', status: 'pending', imageCount: 1 }))
const detail: ImpositionRecord = { ...jobs[20], images: [{ id: 'asset', name: 'front.svg', sourceFileName: 'original.svg', filePath: 'D:/project/productionAPP/printflow-data/assets/asset.svg', widthMm: 42.756789, heightMm: 59.789123, productId: 'p', productName: '照片夹', attributes: { QT: '0', Finish: 'Front Side Epoxy' }, attributeImages: {}, note: '原始备注', noteImage: null, productGroupId: 'group', productGroupLeaderId: 'asset', productGroupPosition: 1 }] }

async function startSingleStrategyWorkspace() {
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '拼版策略' }))
  fireEvent.click(await screen.findByText('切割方案优先（重复统一版式）'))
}

async function closeImagePicker() {
  const dialog = screen.queryByRole('dialog')
  if (!dialog) return
  fireEvent.click(within(dialog).getByRole('button', { name: '完 成' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

async function openJobImages(job: ImpositionJob) {
  await closeImagePicker()
  fireEvent.click(await screen.findByRole('button', { name: `选择 ${job.customerName} 的拼版图片` }))
  await screen.findByRole('dialog')
}

async function selectWholeJobAndCalculate(job: ImpositionJob) {
  await closeImagePicker()
  const checkbox = await screen.findByRole('checkbox', { name: `选择任务 ${job.customerName}` }) as HTMLInputElement
  await waitFor(() => expect(checkbox.disabled).toBe(false))
  fireEvent.click(checkbox)
  await waitFor(() => expect(checkbox.checked).toBe(true))
  const calculate = screen.getByRole('button', { name: '智能拼版' }) as HTMLButtonElement
  await waitFor(() => expect(calculate.disabled).toBe(false))
  await closeImagePicker()
  fireEvent.click(calculate)
}

it('opens a bounded large-batch picker and keeps filtered selections, QT and solver input in sync', async () => {
  const job = { ...jobs[0], imageCount: 110 }
  let record = { ...job, images: Array.from({ length: 110 }, (_, i) => ({ ...detail.images[0], id: `asset-${i}`, name: `图-${String(i).padStart(3, '0')}.svg`, attributes: { QT: '1' } })) }
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return record
    if (command === 'update_imposition_image_quantity') {
      record = { ...record, images: record.images.map(image => image.id === args.imageId ? { ...image, attributes: { QT: String(args.quantity) } } : image) }
      return record
    }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: false }
    if (command === 'pack_imposition_irregular') return { placements: [], unplaced: [], sheetsUsed: 0, utilization: 0, algorithm: 'local-tools' }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(job)
  let dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('checkbox', { name: '参与拼版 图-000.svg' })
  const pageSize = dialog.querySelectorAll('.imposition-image-picker-card').length
  expect(pageSize).toBeGreaterThan(0)
  expect(pageSize).toBeLessThan(48)
  const nextName = `图-${String(pageSize).padStart(3, '0')}.svg`
  expect(document.querySelectorAll('.imposition-job-image')).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '参与拼版 图-000.svg' }))
  fireEvent.click(within(dialog).getByTitle('2'))
  fireEvent.click(await within(dialog).findByRole('checkbox', { name: `参与拼版 ${nextName}` }))
  const search = within(dialog).getByRole('textbox', { name: '搜索图片名称或文件名' })
  fireEvent.change(search, { target: { value: '图-10' } })
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '全选当前筛选' }))
  await within(dialog).findByText('当前筛选 10 张 · 已选 12/110 张图片')
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '全选当前筛选' }))
  fireEvent.change(search, { target: { value: nextName } })
  expect((within(dialog).getByRole('checkbox', { name: `参与拼版 ${nextName}` }) as HTMLInputElement).checked).toBe(true)
  const qt = within(dialog).getByRole('spinbutton', { name: `QT ${nextName}` })
  fireEvent.change(qt, { target: { value: '7' } })
  fireEvent.blur(qt)
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('update_imposition_image_quantity', { jobId: job.id, imageId: `asset-${pageSize}`, quantity: 7 }))
  fireEvent.click(within(dialog).getByRole('button', { name: '完 成' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await openJobImages(job)
  dialog = await screen.findByRole('dialog')
  expect((within(dialog).getByRole('checkbox', { name: '参与拼版 图-000.svg' }) as HTMLInputElement).checked).toBe(true)
  await within(dialog).findByText('当前筛选 110 张 · 已选 2/110 张图片')
  fireEvent.click(within(dialog).getByRole('button', { name: '完 成' }))
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(mocks.invoke.mock.calls.some(call => call[0] === 'pack_imposition_irregular')).toBe(true))
  const request = mocks.invoke.mock.calls.find(call => call[0] === 'pack_imposition_irregular')![1].request
  expect(request.items.map((item: { id: string }) => item.id).sort()).toEqual([`${job.id}::asset-0`, `${job.id}::asset-${pageSize}`])
}, 20000)

it.each([false, true])('selects cards with Ctrl and Shift across pages and saves selected QT in one operation (failure: %s)', async fail => {
  const job = { ...jobs[0], imageCount: 40 }
  let record = { ...job, images: Array.from({ length: 40 }, (_, i) => ({ ...detail.images[0], id: `asset-${i}`, name: `批量图-${i}.svg`, attributes: { QT: '1' } })) }
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return record
    if (command === 'update_imposition_image_quantities') {
      if (fail) throw new Error('写入失败')
      record = { ...record, images: record.images.map(image => args.imageIds.includes(image.id) ? { ...image, attributes: { QT: String(args.quantity) } } : image) }
      return record
    }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(job)
  const dialog = await screen.findByRole('dialog')
  const card = (i: number) => within(dialog).getByText(`批量图-${i}.svg`).closest('.imposition-image-picker-card')!
  const checked = (i: number) => (within(dialog).getByRole('checkbox', { name: `参与拼版 批量图-${i}.svg` }) as HTMLInputElement).checked
  await within(dialog).findByText('批量图-0.svg')
  const pageSize = dialog.querySelectorAll('.imposition-image-picker-card').length
  fireEvent.click(card(0))
  fireEvent.click(card(2), { ctrlKey: true })
  expect(checked(0)).toBe(true); expect(checked(1)).toBe(false); expect(checked(2)).toBe(true)
  fireEvent.click(within(dialog).getByTitle('2'))
  fireEvent.click(card(pageSize + 1), { shiftKey: true })
  // The most recent anchor is 2; Shift replaces selection across the page boundary.
  const ids = Array.from({ length: pageSize }, (_, i) => `asset-${i + 2}`)
  await within(dialog).findByText(`当前筛选 40 张 · 已选 ${ids.length}/40 张图片`)
  const qt = within(dialog).getByRole('spinbutton', { name: '批量 QT' })
  fireEvent.change(qt, { target: { value: '7' } })
  fireEvent.click(within(dialog).getByRole('button', { name: `应用到已选 ${ids.length} 张` }))
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('update_imposition_image_quantities', { jobId: job.id, imageIds: ids, quantity: 7 }))
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'update_imposition_image_quantity')).toHaveLength(0)
  if (fail) {
    await within(dialog).findByText('批量修改失败：写入失败')
    expect((within(dialog).getByRole('spinbutton', { name: `QT 批量图-${pageSize}.svg` }) as HTMLInputElement).value).toBe('1')
  } else {
    await within(dialog).findByText(`已将 ${ids.length} 张图片的 QT 修改为 7`)
    expect(record.images[0].attributes.QT).toBe('1')
    expect(record.images[2].attributes.QT).toBe('7')
    expect(record.images[pageSize + 2].attributes.QT).toBe('1')
    await waitFor(() => expect((within(dialog).getByRole('spinbutton', { name: `QT 批量图-${pageSize}.svg` }) as HTMLInputElement).value).toBe('7'))
  }
}, 20000)

it('detects native logical cores, preserves results when changing concurrency, and persists the manual choice', async () => {
  const job = jobs[0]
  vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2)
  let finish!: (value: unknown) => void
  const result = { placements: [{ id: `${job.id}::asset`, sheetIndex: 0, xMm: 15, yMm: 15, widthMm: 20, heightMm: 20, rotationDeg: 0 }], unplaced: [], sheetsUsed: 1, utilization: .1, algorithm: 'local-tools' }
  mocks.invoke.mockImplementation(async command => {
    if (command === 'get_imposition_compute_info') return { logicalCores: 13, defaultThreads: 13 }
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [{ ...detail.images[0], widthMm: 20, heightMm: 20, attributes: { QT: '1' } }] }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: false }
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular') return new Promise(resolve => { finish = resolve })
  })
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await screen.findByText('自动（全部 13 核）')
  expect(screen.getByText(/检测到 13 个逻辑核心/)).toBeTruthy()
  expect(mocks.invoke).toHaveBeenCalledWith('get_imposition_compute_info')
  await selectWholeJobAndCalculate(job)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect((screen.getByRole('combobox', { name: '使用核心数' }) as HTMLInputElement).disabled).toBe(true)
  const solverCalls = () => mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')
  expect(solverCalls().at(-1)![1].request.threadCount).toBeUndefined()
  await act(async () => finish(result))
  await screen.findByText(/1 种版式 · 共 1 块板材/)
  const previousPages = mocks.canvas.mock.calls.at(-1)![0].pages
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '使用核心数' }))
  fireEvent.click(await screen.findByText('4 核'))
  expect(localStorage.getItem(IMPOSITION_THREADS_STORAGE_KEY)).toBe('4')
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toBe(previousPages)
  expect(solverCalls()).toHaveLength(1)
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(false)
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(solverCalls()).toHaveLength(2))
  expect(solverCalls().at(-1)![1].request.threadCount).toBe(4)
  await act(async () => finish(result))
  await screen.findByText(/1 种版式 · 共 1 块板材/)
  view.unmount()
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await screen.findByText('4 核')
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '使用核心数' }))
  fireEvent.click(await screen.findByText('自动（全部 13 核）'))
  expect(localStorage.getItem(IMPOSITION_THREADS_STORAGE_KEY)).toBe('auto')
  await selectWholeJobAndCalculate(job)
  await waitFor(() => expect(solverCalls()).toHaveLength(3))
  expect(solverCalls().at(-1)![1].request.threadCount).toBeUndefined()
  await act(async () => finish(result))
})

it('reports CPU detection failure, keeps automatic packing available, and clamps a saved choice after retry on a smaller computer', async () => {
  const job = jobs[0]
  localStorage.setItem(IMPOSITION_THREADS_STORAGE_KEY, '64')
  let detectSucceeds = false
  mocks.invoke.mockImplementation(async command => {
    if (command === 'get_imposition_compute_info') {
      if (!detectSucceeds) throw new Error('native API unavailable')
      return { logicalCores: 4, defaultThreads: 2 }
    }
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [{ ...detail.images[0], attributes: { QT: '1' } }] }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [0, 20]], lineOnly: false }
    if (command === 'pack_imposition_irregular') return { placements: [], unplaced: [`${job.id}::asset`], sheetsUsed: 0, utilization: 0, algorithm: 'local-tools' }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await screen.findByText(/未能读取 CPU 核心数/)
  expect((screen.getByRole('combobox', { name: '使用核心数' }) as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText('自动（计算时检测）')).toBeTruthy()
  await selectWholeJobAndCalculate(job)
  await waitFor(() => expect(mocks.invoke.mock.calls.some(call => call[0] === 'pack_imposition_irregular')).toBe(true))
  expect(mocks.invoke.mock.calls.find(call => call[0] === 'pack_imposition_irregular')![1].request.threadCount).toBeUndefined()
  await waitFor(() => expect((screen.getByRole('button', { name: '重试' }) as HTMLButtonElement).disabled).toBe(false))
  detectSucceeds = true
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText(/检测到 4 个逻辑核心/)
  expect(localStorage.getItem(IMPOSITION_THREADS_STORAGE_KEY)).toBe('4')
  expect((screen.getByRole('combobox', { name: '使用核心数' }) as HTMLInputElement).disabled).toBe(false)
  expect(screen.getByText('4 核')).toBeTruthy()
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')).toHaveLength(2))
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular').at(-1)![1].request.threadCount).toBe(4)
})

it('reads QT from production attributes and expands the same real asset for packing', () => {
  const image = { ...detail.images[0], attributes: { QT: '3' } }
  expect(getImpositionQuantity(image)).toBe(3)
  const expanded = expandImpositionImages([image])
  expect(expanded).toHaveLength(3)
  expect(expanded.map(item => item.id)).toEqual(['asset', 'asset#qt-2', 'asset#qt-3'])
  expect(expanded.slice(1).every(item => item.sourceImageId === 'asset')).toBe(true)
})

it('uses only irregular packing and surfaces a solver failure without a rectangular preview', async () => {
  const job = jobs[0]
  const record = { ...job, images: [{ ...detail.images[0], attributes: { QT: '3' } }] }
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return record
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [0, 20]], lineOnly: false }
    if (command === 'pack_imposition_irregular') {
      expect(args.request.irregularAlgorithm).toBe('local-tools')
      expect(args.request.objective).toBe('least-cutting')
      expect(args.request.items).toHaveLength(1)
      expect(args.request.items[0].quantity).toBe(3)
      throw new Error('worker 计算超时')
    }
    return undefined
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(job)
  await selectWholeJobAndCalculate(job)
  expect(screen.queryByRole('radio', { name: '矩形拼版' })).toBeNull()
  await screen.findByText(/异形拼版计算失败.*worker 计算超时/)
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'pack_imposition_rectangles')).toBe(false)
  expect(screen.queryByText(/已放置/)).toBeNull()
  expect(screen.getByText(/种版式 · 共/).textContent).toContain('0 种版式')
})

it('locks packing inputs during a job and unlocks them when the solver returns', async () => {
  let finish!: (value: unknown) => void
  const job = jobs[0]
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [{ ...detail.images[0], attributes: { QT: '3' } }] }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [0, 20]], lineOnly: false }
    if (command === 'pack_imposition_irregular') return new Promise(resolve => { finish = resolve })
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  fireEvent.click(screen.getByRole('button', { name: '展开版面配置' }))
  await openJobImages(job)
  await selectWholeJobAndCalculate(job)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(screen.queryByRole('combobox', { name: '异形算法' })).toBeNull()
  expect(screen.queryByText('本地拼版')).toBeNull()
  expect((screen.getByRole('combobox', { name: '拼版策略' }) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '选择小版' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '编辑版面配置' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => finish({ placements: [], unplaced: [`${job.id}::asset`, `${job.id}::asset#qt-2`, `${job.id}::asset#qt-3`], sheetsUsed: 0, utilization: 0, algorithm: 'local-tools' }))
  await waitFor(() => expect((screen.getByRole('combobox', { name: '拼版策略' }) as HTMLInputElement).disabled).toBe(false))
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')).toHaveLength(1)
})

it.each([
  ['least-cutting', '切割方案优先（重复统一版式）'],
  ['combined', '综合最少（权重 60:40）'],
])('folds %s templates, expands actual boards without solving again, and folds the next result', async (objective, label) => {
  const job = jobs[0]
  const placements = Array.from({ length: 5 }, (_, index) => ({
    id: index === 0 ? `${job.id}::asset` : `${job.id}::asset#qt-${index + 1}`,
    sheetIndex: Math.floor(index / 2), xMm: 10 + index % 2 * 23, yMm: 12,
    widthMm: 20, heightMm: 20, rotationDeg: 0,
  }))
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [{ ...detail.images[0], widthMm: 20, heightMm: 20, attributes: { QT: '5' } }] }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: false }
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular') return { placements, unplaced: [], sheetsUsed: 3, utilization: .1, algorithm: 'local-tools' }
  })
  const solverCalls = () => mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')
  const canvasProps = () => mocks.canvas.mock.calls.at(-1)![0]
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '拼版策略' }))
  fireEvent.click(await screen.findByText('节省板材（单板尽量多放）'))
  await selectWholeJobAndCalculate(job)
  await screen.findByText(/3 个版面/)
  expect(canvasProps().collapseRepeatedLayouts).toBe(false)
  await openJobImages(job)
  const quantity = within(screen.getByText('front.svg').closest('.imposition-image-picker-card') as HTMLElement).getByRole('spinbutton')
  fireEvent.focus(quantity)
  fireEvent.blur(quantity)
  fireEvent.focus(quantity)
  fireEvent.keyDown(quantity, { key: 'Enter', code: 'Enter', keyCode: 13 })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'update_imposition_image_quantity')).toBe(false)
  expect(solverCalls()).toHaveLength(1)
  await closeImagePicker()
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '拼版策略' }))
  fireEvent.click(await screen.findByText(label))
  await waitFor(() => expect(canvasProps().pages).toHaveLength(0))
  expect(solverCalls()).toHaveLength(1)
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await screen.findByText(/2 种版式 · 共 3 块板材/)
  expect(solverCalls()).toHaveLength(2)
  expect(solverCalls().at(-1)![1].request).toMatchObject({ irregularAlgorithm: 'local-tools', objective, items: [expect.objectContaining({ id: `${job.id}::asset`, quantity: 5 })] })
  expect(solverCalls().at(-1)![1].request.templateRepack).toBeUndefined()
  expect(canvasProps().collapseRepeatedLayouts).toBe(true)
  expect(canvasProps().pages).toHaveLength(3)
  expect(canvasProps().pages.flat()).toHaveLength(5)
  expect(screen.getByText(/已放置/).textContent).toContain('5/5')

  fireEvent.click(screen.getByRole('button', { name: '展开全部板材' }))
  await screen.findByText(/3 个版面/)
  expect(canvasProps().collapseRepeatedLayouts).toBe(false)
  expect(canvasProps().pages.flat()).toHaveLength(5)
  expect(solverCalls()).toHaveLength(2)
  expect(screen.queryByRole('button', { name: '展开全部板材' })).toBeNull()

  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await screen.findByText(/2 种版式 · 共 3 块板材/)
  expect(solverCalls()).toHaveLength(3)
  expect(canvasProps().collapseRepeatedLayouts).toBe(true)
  expect(canvasProps().pages.flat()).toHaveLength(5)
  expect(screen.getByRole('button', { name: '展开全部板材' })).toBeTruthy()
  expect(screen.getByText(/已放置/).textContent).toContain('5/5')
})

it.each([false, true])('automatically replans full QT and atomically replaces the plan (already excluded artwork: %s)', async withExcluded => {
  const job = jobs[0]
  localStorage.setItem(IMPOSITION_THREADS_STORAGE_KEY, '3')
  let finishCrossPlan!: (value: unknown) => void
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'get_imposition_compute_info') return { logicalCores: 8, defaultThreads: 4 }
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [
      { ...detail.images[0], filePath: `D:/line-only-cross-plan-${withExcluded}.svg`, widthMm: 20, heightMm: 20, attributes: { QT: '2' } },
      ...(withExcluded ? [{ ...detail.images[0], id: 'oversized', name: 'oversized.svg', widthMm: 1000, heightMm: 1000, attributes: { QT: '1' } }] : []),
    ] }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: true }
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular' && args.request.templateRepack) return new Promise(resolve => { finishCrossPlan = resolve })
    if (command === 'pack_imposition_irregular') return {
      placements: [0, 1].map(index => ({ id: `${job.id}::asset${index ? '#qt-2' : ''}`, sheetIndex: index, xMm: 15, yMm: 15, widthMm: 20, heightMm: 20, rotationDeg: 0 })),
      unplaced: withExcluded ? [`${job.id}::oversized`] : [], sheetsUsed: 2, utilization: .1, algorithm: 'local-tools',
      excludedItems: withExcluded ? [{ id: `${job.id}::oversized`, reason: '图片放不进有效区域' }] : [],
    }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '拼版策略' }))
  fireEvent.click(await screen.findByText('节省板材（单板尽量多放）'))
  await selectWholeJobAndCalculate(job)
  await screen.findByText(/2 个版面/)
  const props = mocks.canvas.mock.calls.at(-1)![0]
  const moved = { ...props.pages[0][0], x: 45, y: 15, rotation: 180 }
  const intent = applyPackingEdit(props.pages, 0, props.pages[0][0], 1, moved, false)
  act(() => props.onEdit!(intent.pages, intent.edit))
  await waitFor(() => expect(finishCrossPlan).toBeTypeOf('function'))
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual(props.pages)
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(true)
  const request = mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular').at(-1)![1].request
  expect(request.items).toEqual([expect.objectContaining({ id: `${job.id}::asset`, quantity: 2, lineOnly: true })])
  expect(request.templateRepack).toEqual(intent.edit.templateRepack)
  expect(request.threadCount).toBe(3)
  expect(mocks.invoke.mock.calls.filter(([command, args]) => command === 'load_imposition_geometry' && args.path === `D:/line-only-cross-plan-${withExcluded}.svg`)).toHaveLength(1)
  await act(async () => finishCrossPlan({
    placements: [
      { id: `${job.id}::asset`, sheetIndex: 0, xMm: 45, yMm: 15, widthMm: 20, heightMm: 20, rotationDeg: 180 },
      { id: `${job.id}::asset#qt-2`, sheetIndex: 0, xMm: 15, yMm: 15, widthMm: 20, heightMm: 20, rotationDeg: 0 },
    ], unplaced: [], sheetsUsed: 1, utilization: .1, algorithm: 'tools/template-repack',
  }))
  await screen.findByText(/1 个版面/)
  const recalculateButton = screen.getByRole('button', { name: '智能拼版' })
  await waitFor(() => expect(recalculateButton.classList.contains('ant-btn-loading')).toBe(false))
  const result = mocks.canvas.mock.calls.at(-1)![0].pages
  expect(result).toHaveLength(1)
  expect(result.flat()).toHaveLength(2)
  expect(result[0].some(item => item.x === 45 && item.y === 15 && item.rotation === 180)).toBe(true)
  expect(screen.getByText(/已放置/).textContent).toContain(withExcluded ? '2/3' : '2/2')
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.queryByText('已记录手动方案 · 智能拼版将沿用当前版式')).toBeNull()
  expect(screen.queryByRole('button', { name: '重新自动排版' })).toBeNull()

  // Ordinary recalculation always submits all selected demand to the normal
  // solver, including artwork that an earlier result could not place.
  fireEvent.click(recalculateButton)
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')).toHaveLength(3))
  await screen.findByText(/2 个版面/)
  const normalRequest = mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular').at(-1)![1].request
  expect(normalRequest.templateRepack).toBeUndefined()
  expect(normalRequest.items).toEqual([
    expect.objectContaining({ id: `${job.id}::asset`, quantity: 2, lineOnly: true }),
    ...(withExcluded ? [expect.objectContaining({ id: `${job.id}::oversized`, quantity: 1 })] : []),
  ])
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual(props.pages)
  expect(screen.getByText(/已放置/).textContent).toContain(withExcluded ? '2/3' : '2/2')

  // Same-board edits immediately update the committed canvas/export input,
  // but do not create a separate mode for later recalculation.
  const sameBoardProps = mocks.canvas.mock.calls.at(-1)![0]
  const sameBoardEdit = applyPackingEdit(sameBoardProps.pages, 0, sameBoardProps.pages[0][0], 0, { ...sameBoardProps.pages[0][0], x: 75, rotation: 90 }, false)
  act(() => sameBoardProps.onEdit!(sameBoardEdit.pages, sameBoardEdit.edit))
  expect(mocks.canvas.mock.calls.at(-1)![0].pages[0][0]).toMatchObject({ x: 75, rotation: 90 })
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(recalculateButton)
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')).toHaveLength(4))
  await waitFor(() => expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual(props.pages))
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular').at(-1)![1].request.templateRepack).toBeUndefined()
  await closeImagePicker()
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '拼版策略' }))
  fireEvent.click(await screen.findByText('切割方案优先（重复统一版式）'))
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual([])
})

it('restores editing after cross-plan failure and only starts another special calculation on a new cross-board drag', async () => {
  const job = jobs[0]
  const placements = [0, 1].map(index => ({ id: `${job.id}::asset${index ? '#qt-2' : ''}`, sheetIndex: index, xMm: 15, yMm: 15, widthMm: 20, heightMm: 20, rotationDeg: 0 }))
  const intents: unknown[] = []
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [{ ...detail.images[0], widthMm: 20, heightMm: 20, attributes: { QT: '2' } }] }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: false }
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular') {
      if (args.request.templateRepack) { intents.push(args.request.templateRepack); throw new Error('worker failure') }
      return { placements, unplaced: [], sheetsUsed: 2, utilization: .1, algorithm: 'tools' }
    }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '拼版策略' }))
  fireEvent.click(await screen.findByText('节省板材（单板尽量多放）'))
  await selectWholeJobAndCalculate(job)
  await screen.findByText(/2 个版面/)
  const props = mocks.canvas.mock.calls.at(-1)![0]
  const intent = applyPackingEdit(props.pages, 0, props.pages[0][0], 1, { ...props.pages[0][0], x: 60 }, false)
  act(() => props.onEdit!(intent.pages, intent.edit))
  await screen.findByText(/跨方案重算失败.*worker failure/)
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual(props.pages)
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(false)
  const editableProps = mocks.canvas.mock.calls.at(-1)![0]
  const edit = applyPackingEdit(editableProps.pages, 0, editableProps.pages[0][0], 0, { ...editableProps.pages[0][0], x: 45 }, false)
  act(() => editableProps.onEdit!(edit.pages, edit.edit))
  expect(mocks.canvas.mock.calls.at(-1)![0].pages[0][0].x).toBe(45)
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')).toHaveLength(3))
  await waitFor(() => expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual(props.pages))
  expect(intents).toHaveLength(1)
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular').at(-1)![1].request.templateRepack).toBeUndefined()
  expect(screen.queryByText(/跨方案重算失败/)).toBeNull()

  const nextProps = mocks.canvas.mock.calls.at(-1)![0]
  const nextIntent = applyPackingEdit(nextProps.pages, 0, nextProps.pages[0][0], 1, { ...nextProps.pages[0][0], x: 85 }, false)
  act(() => nextProps.onEdit!(nextIntent.pages, nextIntent.edit))
  await waitFor(() => expect(intents).toHaveLength(2))
  expect(intents[1]).toEqual(nextIntent.edit.templateRepack)
  expect(intents[0]).not.toEqual(intents[1])
  await screen.findByText(/跨方案重算失败.*worker failure/)
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual(props.pages)
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(false)
})

it('skips one invalid outline, keeps valid placements, and marks only that asset red', async () => {
  const invalidImage = { ...detail.images[0], id: 'invalid', name: 'invalid.svg', filePath: 'D:/bad-outline.svg', attributes: { QT: '1' } }
  const validImage = { ...detail.images[0], id: 'valid', name: 'valid.svg', filePath: 'D:/valid-outline.svg', attributes: { QT: '1' } }
  const job = { ...jobs[0], imageCount: 2 }
  const record: ImpositionRecord = { ...job, images: [invalidImage, validImage] }
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return record
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'
    if (command === 'load_imposition_geometry') {
      if (args.path === invalidImage.filePath) throw new Error('SVG 轮廓自交')
      return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: false }
    }
    if (command === 'pack_imposition_irregular') {
      expect(args.request.items.map((item: { id: string }) => item.id)).toEqual([`${job.id}::valid`])
      return { placements: [{ id: `${job.id}::valid`, sheetIndex: 0, xMm: 0, yMm: 0, widthMm: 20, heightMm: 20, rotationDeg: 0 }], unplaced: [], sheetsUsed: 1, utilization: .1, algorithm: 'tools/material · Rust 位图 · 2 线程' }
    }
    return undefined
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(job)
  await selectWholeJobAndCalculate(job)
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('1/2'))
  await openJobImages(job)
  await screen.findByText('invalid.svg')
  await waitFor(() => expect(screen.getByText('invalid.svg').closest('.imposition-image-picker-card')?.classList.contains('is-invalid-outline')).toBe(true))
  await waitFor(() => expect(screen.getByText('valid.svg').closest('.imposition-image-picker-card')?.classList.contains('is-invalid-outline')).toBe(false))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('1/2'))
})

it('classifies selected base SVGs once before packing, preserving QT and excluding invalid contours', async () => {
  const job = { ...jobs[0], imageCount: 5 }
  const record: ImpositionRecord = { ...job, images: [
    ['line', '线条.svg', 3], ['art', '彩图.svg', 2], ['invalid', '无效轮廓.svg', 2], ['unused', '未选中.svg', 4], ['zero', '零份数.svg', 0],
  ].map(([id, name, quantity]) => ({
    ...detail.images[0], id: String(id), name: String(name), filePath: `D:/classify-selected/${id}.svg`,
    widthMm: 20, heightMm: 20, attributes: { QT: String(quantity) },
  })) }
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return record
    if (command === 'load_imposition_geometry') {
      if (args.path.endsWith('/invalid.svg')) throw new Error('SVG 轮廓无效')
      return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: args.path.endsWith('/line.svg') }
    }
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular') {
      // SVG contents are parsed in native code; embedded raster images are not
      // loaded into the frontend before the solver has returned placements.
      expect(mocks.invoke.mock.calls.some(([name]) => name === 'load_imposition_image')).toBe(false)
      expect(args.request.items).toEqual([
        expect.objectContaining({ id: 'job-0::line', quantity: 3, lineOnly: true }),
        expect.objectContaining({ id: 'job-0::art', quantity: 2, lineOnly: false }),
      ])
      const placements = args.request.items.flatMap((item: { id: string; quantity: number; lineOnly: boolean }) => Array.from({ length: item.quantity }, (_, index) => ({
        id: item.id + (index ? `#qt-${index + 1}` : ''), sheetIndex: item.lineOnly ? 1 : 0,
        xMm: 10 + index * 23, yMm: 12, widthMm: 20, heightMm: 20, rotationDeg: 0,
      })))
      return { placements, sheetsUsed: 2, utilization: .1, unplaced: [], algorithm: 'local-tools' }
    }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(job)
  for (const image of record.images.filter(image => image.id !== 'unused')) {
    fireEvent.click(await screen.findByRole('checkbox', { name: `参与拼版 ${image.name}` }))
  }
  expect(mocks.invoke.mock.calls.some(([command]) => command === 'load_imposition_geometry')).toBe(false)
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('5/7'))
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'load_imposition_geometry').map(([, args]) => args.path).sort()).toEqual([
    'D:/classify-selected/art.svg', 'D:/classify-selected/invalid.svg', 'D:/classify-selected/line.svg',
  ])
  await openJobImages(job)
  expect(screen.getByText('无效轮廓.svg').closest('.imposition-image-picker-card')?.classList.contains('is-invalid-outline')).toBe(true)
  const pages = mocks.canvas.mock.calls.at(-1)![0].pages
  expect(pages.map(page => page.map(item => item.image.sourceImageId ?? item.image.id))).toEqual([
    ['job-0::art', 'job-0::art'], ['job-0::line', 'job-0::line', 'job-0::line'],
  ])
})

it('shows the rejected contour name and reason while keeping successful sheets', async () => {
  const skipped = { ...detail.images[0], id: 'complex-contour', name: '复杂花边.svg', filePath: 'D:/complex-contour.svg', attributes: { QT: '2' } }
  const placed = { ...detail.images[0], id: 'normal-contour', name: '普通挂件.svg', filePath: 'D:/normal-contour.svg', attributes: { QT: '1' } }
  const job = { ...jobs[0], imageCount: 2 }
  const reason = '单张轮廓复杂度 1440000 超过单批计算预算 1000000（1200 个轮廓点），已跳过此图片'
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [skipped, placed] }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [0, 20]], lineOnly: false }
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular') return {
      placements: [{ id: `${job.id}::${placed.id}`, sheetIndex: 0, xMm: 0, yMm: 0, widthMm: 20, heightMm: 20, rotationDeg: 0 }],
      unplaced: [`${job.id}::${skipped.id}`, `${job.id}::${skipped.id}#qt-2`], sheetsUsed: 1, utilization: .1, algorithm: 'tools/material · Rust 位图 · 2 线程',
      excludedItems: [{ id: `${job.id}::${skipped.id}`, reason }], warnings: ['轮廓已分批处理'],
    }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(job)
  await selectWholeJobAndCalculate(job)
  // Reopen the picker to inspect the rejected image while preserving the result.
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('1/3'))
  await openJobImages(job)
  const row = (await screen.findByText(skipped.name)).closest('.imposition-image-picker-card')!
  expect(row.classList.contains('is-invalid-outline')).toBe(true)
  expect(within(row as HTMLElement).getByText(reason)).toBeTruthy()
  expect(screen.getByText(placed.name).closest('.imposition-image-picker-card')?.classList.contains('is-invalid-outline')).toBe(false)
  expect(screen.getByText(/种版式 · 共/).textContent).toContain('1 种版式 · 共 1 块板材')
  expect(screen.queryByText(/异形拼版计算失败/)).toBeNull()
})

it('marks the largest contour red after batching and still counts its placed QT copies', async () => {
  const complex = { ...detail.images[0], id: 'largest-contour', name: '最大轮廓挂件.svg', filePath: 'D:/largest-contour.svg', attributes: { QT: '2' } }
  const normal = { ...detail.images[0], id: 'normal-contour', name: '普通挂件.svg', filePath: 'D:/normal-contour.svg', attributes: { QT: '1' } }
  const job = { ...jobs[0], imageCount: 2 }
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [complex, normal] }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [0, 20]], lineOnly: false }
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular') return {
      placements: [complex.id, `${complex.id}#qt-2`, normal.id].map((id, index) => ({ id: `${job.id}::${id}`, sheetIndex: 0, xMm: 10 + index * 23, yMm: 12, widthMm: 20, heightMm: 20, rotationDeg: 0 })),
      unplaced: [], sheetsUsed: 1, utilization: .1, algorithm: 'tools/material', excludedItems: [],
      warnings: [`轮廓总复杂度 25721744400 超过单批预算 1000000，已按轮廓类型分批；最大轮廓图片：${job.id}::${complex.id}`],
    }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(job)
  await selectWholeJobAndCalculate(job)
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('3/3'))
  await openJobImages(job)
  const row = screen.getByText(complex.name).closest('.imposition-image-picker-card')!
  expect(row.classList.contains('is-invalid-outline')).toBe(true)
  expect(within(row as HTMLElement).getByText('轮廓总复杂度过高，已分批计算；图片仍会继续参与拼版')).toBeTruthy()
  expect(screen.getByText(normal.name).closest('.imposition-image-picker-card')?.classList.contains('is-invalid-outline')).toBe(false)
  expect(screen.getByText(`轮廓复杂度过高，已分批计算：${complex.name}`)).toBeTruthy()
  expect(screen.getByText(/种版式 · 共/).textContent).toContain('1 种版式 · 共 1 块板材')
  expect(screen.queryByText(/异形拼版计算失败/)).toBeNull()
})

function selectionFixture(prefix: string) {
  const records: ImpositionRecord[] = [0, 1].map(index => ({
    ...jobs[index], imageCount: index === 0 ? 3 : 1,
    images: (index === 0 ? [['shared', '首图.svg', 2], ['unused', '未选图.svg', 3], ['zero', '零数量.svg', 0]] : [['shared', '另一任务同图.svg', 4]]).map(([id, name, quantity]) => ({
      ...detail.images[0], id: String(id), name: String(name), widthMm: 20, heightMm: 20,
      filePath: `D:/${prefix}/${index}/${id}.svg`, attributes: { QT: String(quantity) },
    })),
  }))
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') return { records: records.map(({ images: _images, ...job }) => job), total: 2, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return records.find(record => record.id === args.id)
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'load_imposition_thumbnail') return 'data:image/png;base64,AQ=='
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: false }
    if (command === 'update_imposition_image_quantity') {
      const index = records.findIndex(record => record.id === args.jobId)
      records[index] = { ...records[index], images: records[index].images.map(image => image.id === args.imageId ? { ...image, attributes: { ...image.attributes, QT: String(args.quantity) } } : image) }
      return records[index]
    }
    if (command === 'pack_imposition_irregular') {
      let placed = 0
      const placements = args.request.items.flatMap((item: { id: string; quantity: number }) => Array.from({ length: item.quantity }, (_, index) => ({ id: item.id + (index ? `#qt-${index + 1}` : ''), sheetIndex: 0, xMm: 10 + placed++ * 23, yMm: 12, widthMm: 20, heightMm: 20, rotationDeg: 0 })))
      return { placements, sheetsUsed: 1, utilization: .1, unplaced: [], algorithm: 'local-tools' }
    }
  })
  return records
}

it('opens an empty canvas and loads neither original images nor outlines until selected images are explicitly calculated', async () => {
  const [record] = selectionFixture('explicit-selection')
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(record)
  await screen.findByText('首图.svg')
  expect(screen.getByText('勾选右侧图片，点击“智能拼版”生成拼版')).toBeTruthy()
  expect(screen.queryByText(/导出：/)).toBeNull()
  expect(screen.queryByText('本地拼版')).toBeNull()
  expect((screen.getByRole('button', { name: '智能拼版' }) as HTMLButtonElement).disabled).toBe(true)
  expect(mocks.invoke.mock.calls.filter(([command]) => ['pack_imposition_irregular', 'load_imposition_geometry', 'load_imposition_image'].includes(command))).toHaveLength(0)
  fireEvent.click(screen.getByRole('checkbox', { name: '参与拼版 首图.svg' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '参与拼版 零数量.svg' }))
  expect(screen.getByText('已选 2/3 张图片')).toBeTruthy()
  expect(mocks.invoke.mock.calls.filter(([command]) => ['pack_imposition_irregular', 'load_imposition_geometry', 'load_imposition_image'].includes(command))).toHaveLength(0)
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('2/2'))
  const solver = mocks.invoke.mock.calls.filter(([command]) => command === 'pack_imposition_irregular')
  expect(solver).toHaveLength(1)
  expect(solver[0][1].request.items).toEqual([expect.objectContaining({ id: 'job-0::shared', quantity: 2 })])
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'load_imposition_geometry').map(([, args]) => args.path)).toEqual([record.images[0].filePath])
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'load_imposition_image')).toHaveLength(0)
})

it('combines selected images across tasks, preserving independent QT counts when source asset IDs are identical', async () => {
  const records = selectionFixture('cross-job-selection')
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(records[0])
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 首图.svg' }))
  await openJobImages(records[1])
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 另一任务同图.svg' }))
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'pack_imposition_irregular')).toHaveLength(0)
  const calculate = screen.getByRole('button', { name: '智能拼版' }) as HTMLButtonElement
  await waitFor(() => expect(calculate.disabled).toBe(false))
  await closeImagePicker()
  fireEvent.click(calculate)
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('6/6'))
  const request = mocks.invoke.mock.calls.find(([command]) => command === 'pack_imposition_irregular')![1].request
  expect(request.items.map((item: { id: string; quantity: number }) => [item.id, item.quantity])).toEqual([['job-0::shared', 2], ['job-1::shared', 4]])
  expect(mocks.canvas.mock.calls.at(-1)![0].pages.flat()).toHaveLength(6)
  expect(screen.getByText('已选 1/3 张图片')).toBeTruthy()
  expect(screen.getByText('已选 1/1 张图片')).toBeTruthy()
})

it('invalidates results when selection, QT or settings change and waits for manual recalculation', async () => {
  const [record] = selectionFixture('invalidate-selection')
  const solverCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === 'pack_imposition_irregular')
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(record)
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 首图.svg' }))
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('2/2'))
  await openJobImages(record)
  fireEvent.click(screen.getByRole('checkbox', { name: '参与拼版 未选图.svg' }))
  await screen.findByText(/0 种版式 · 共 0 块板材/)
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(true)
  expect(solverCalls()).toHaveLength(1)
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('5/5'))
  await openJobImages(record)
  const quantity = screen.getByRole('spinbutton', { name: 'QT 首图.svg' })
  fireEvent.change(quantity, { target: { value: '1' } })
  fireEvent.blur(quantity)
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('update_imposition_image_quantity', { jobId: record.id, imageId: 'shared', quantity: 1 }))
  await screen.findByText(/0 种版式 · 共 0 块板材/)
  expect(solverCalls()).toHaveLength(2)
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('4/4'))
  fireEvent.click(screen.getByRole('button', { name: '展开版面配置' }))
  fireEvent.click(screen.getByRole('button', { name: '选择小版' }))
  await screen.findByText(/0 种版式 · 共 0 块板材/)
  expect(solverCalls()).toHaveLength(3)
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(solverCalls()).toHaveLength(4))
  expect(solverCalls().at(-1)![1].request).toMatchObject({ spacingMm: 8, effectiveWidthMm: 285, effectiveHeightMm: 380, plateWidthMm: 300, plateHeightMm: 464 })
  expect(mocks.canvas.mock.calls.at(-1)![0]).toMatchObject({ spacing: 8, effectiveHeight: 380, effectiveWidth: 285, boardWidth: 300, boardHeight: 464 })
})

it('starts with collapsed board settings and preserves configuration and packed results when toggling them', async () => {
  const [record] = selectionFixture('collapsible-board-settings')
  const solverCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === 'pack_imposition_irregular')
  const canvasPages = () => mocks.canvas.mock.calls.at(-1)![0].pages
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  const expand = screen.getByRole('button', { name: '展开版面配置' })
  expect(expand.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('图片间距')).toBeNull()
  expect(screen.getByRole('combobox', { name: '拼版策略' })).toBeTruthy()
  expect(screen.getByRole('button', { name: /^上传 SVG/ })).toBeTruthy()

  fireEvent.click(expand)
  expect(screen.getByRole('button', { name: '收起版面配置' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('button', { name: '选择大版' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '选择小版' }))
  fireEvent.click(screen.getByRole('button', { name: '收起版面配置' }))
  expect(screen.queryByText('图片间距')).toBeNull()
  expect(solverCalls()).toHaveLength(0)

  await openJobImages(record)
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 首图.svg' }))
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('2/2'))
  const pagesBeforeToggle = canvasPages()
  expect(pagesBeforeToggle.flat()).toHaveLength(2)
  expect(solverCalls()).toHaveLength(1)
  expect(solverCalls()[0][1].request.spacingMm).toBe(8)
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(false)

  for (let index = 0; index < 2; index++) {
    fireEvent.click(screen.getByRole('button', { name: '展开版面配置' }))
    expect(screen.getByRole('button', { name: '选择小版' }).getAttribute('aria-pressed')).toBe('true')
    expect(canvasPages()).toBe(pagesBeforeToggle)
    fireEvent.click(screen.getByRole('button', { name: '收起版面配置' }))
    expect(screen.getByRole('button', { name: '展开版面配置' }).getAttribute('aria-expanded')).toBe('false')
    expect(canvasPages()).toBe(pagesBeforeToggle)
    expect(screen.getByText(/已放置/).textContent).toContain('2/2')
    expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(false)
  }
  expect(solverCalls()).toHaveLength(1)
})

it('rolls back the displayed QT after a save failure and preserves the last valid selection and result', async () => {
  const [record] = selectionFixture('failed-qt-save')
  const original = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation((command, args) => command === 'update_imposition_image_quantity' ? Promise.reject(new Error('磁盘写入失败')) : original(command, args))
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  await openJobImages(record)
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 首图.svg' }))
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('2/2'))
  await openJobImages(record)
  const quantity = screen.getByRole('spinbutton', { name: 'QT 首图.svg' }) as HTMLInputElement
  fireEvent.change(quantity, { target: { value: '9' } })
  fireEvent.blur(quantity)
  await within(screen.getByRole('dialog')).findByText(/保存 QT 数量失败.*磁盘写入失败/)
  await waitFor(() => expect(quantity.value).toBe('2'))
  expect(screen.getByText(/已放置/).textContent).toContain('2/2')
  expect(mocks.canvas.mock.calls.at(-1)![0].pages.flat()).toHaveLength(2)
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'pack_imposition_irregular')).toHaveLength(1)
})

it('lazily requests small PNG thumbnails only on visibility and releases offscreen image elements', async () => {
  let changed!: IntersectionObserverCallback
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { changed = callback }
    observe() {}
    disconnect = disconnect
  })
  mocks.invoke.mockResolvedValue('data:image/png;base64,AQ==')
  const view = render(<ImpositionThumbnail path="D:/visibility-thumbnail.svg" name="缩略图测试.svg"/>)
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(screen.queryByRole('img')).toBeNull()
  await act(async () => changed([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('load_imposition_thumbnail', { path: 'D:/visibility-thumbnail.svg' })
  expect((await screen.findByRole('img', { name: '缩略图测试.svg' })).getAttribute('src')).toBe('data:image/png;base64,AQ==')
  await act(async () => changed([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(screen.queryByRole('img')).toBeNull()
  await act(async () => changed([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  await screen.findByRole('img', { name: '缩略图测试.svg' })
  expect(mocks.invoke).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(disconnect).toHaveBeenCalledOnce()
})

it('limits thumbnail loads to two concurrent requests and skips queued thumbnails that have left the viewport', async () => {
  const observers: IntersectionObserverCallback[] = []
  const finish: Array<(value: string) => void> = []
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observers.push(callback) }
    observe() {}
    disconnect() {}
  })
  mocks.invoke.mockImplementation(() => new Promise<string>(resolve => finish.push(resolve)))
  render(<>{Array.from({ length: 4 }, (_, index) => <ImpositionThumbnail key={index} path={`D:/concurrent-thumbnail-${index}.svg`} name={`thumb-${index}`}/>)}</>)
  await act(async () => { observers.forEach(callback => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)) })
  expect(mocks.invoke).toHaveBeenCalledTimes(2)
  await act(async () => observers[2]([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
  await act(async () => finish[0]('data:image/png;base64,AQ=='))
  expect(mocks.invoke).toHaveBeenCalledTimes(3)
  expect(mocks.invoke.mock.calls.at(-1)![1].path).toBe('D:/concurrent-thumbnail-3.svg')
  await act(async () => { finish[1]('data:image/png;base64,AQ=='); finish[2]('data:image/png;base64,AQ==') })
  expect(screen.queryByRole('img', { name: 'thumb-2' })).toBeNull()
  expect(screen.getAllByRole('img')).toHaveLength(3)
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem(IMPOSITION_THREADS_STORAGE_KEY)
  localStorage.removeItem(LAYOUT_PRESET_STORAGE_KEY)
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('paginates pending summaries and only loads original paths, exact dimensions and properties on demand', async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') {
      const filtered = jobs.filter(job => job.customerName.includes(args.query.search || ''))
      const page = Math.min(args.query.page, Math.max(1, Math.ceil(filtered.length / args.query.pageSize)))
      return { records: filtered.slice((page - 1) * args.query.pageSize, page * args.query.pageSize), total: filtered.length, page, pageSize: args.query.pageSize }
    }
    if (command === 'load_imposition_job') return detail
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await screen.findByText('生产客户0')
  expect(screen.queryByText('生产客户20')).toBeNull()
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'load_imposition_job')).toBe(false)
  fireEvent.click(screen.getByTitle('2'))
  fireEvent.click(within((await screen.findByText('生产客户20')).closest('tr')!).getByRole('button', { name: '图片明细' }))
  await screen.findByText('front.svg')
  expect(mocks.invoke).toHaveBeenCalledWith('load_imposition_job', { id: 'job-20' })
  expect(screen.getByText(detail.images[0].filePath)).toBeTruthy()
  expect(screen.getByText('42.756789 × 59.789123')).toBeTruthy()
  expect(screen.getByText('照片夹')).toBeTruthy()
  expect(screen.getByText('Front Side Epoxy')).toBeTruthy()
  expect(screen.getByText('0')).toBeTruthy()
  expect(mocks.invoke.mock.calls.some(call => call[0].includes('resource') || call[0] === 'load_schematic_review')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  fireEvent.change(screen.getByLabelText('搜索待拼版记录'), { target: { value: '生产客户20' } })
  await screen.findByText('共 1 条待拼版记录')
  expect(mocks.invoke).toHaveBeenLastCalledWith('list_pending_impositions', { query: { page: 1, pageSize: 20, search: '生产客户20' } })
})

it('does not query an inactive module and ignores a superseded detail response', async () => {
  let resolveFirst!: (value: ImpositionRecord) => void
  mocks.invoke.mockImplementation(async (command, args) => command === 'list_pending_impositions' ? { records: jobs.slice(0, 2), total: 2, page: 1, pageSize: 20 } : args.id === 'job-0' ? new Promise<ImpositionRecord>(resolve => { resolveFirst = resolve }) : { ...detail, customerName: '第二条明细' })
  const view = render(<ImpositionPage active={false} revision={0}/>)
  expect(mocks.invoke).not.toHaveBeenCalled()
  view.rerender(<ImpositionPage active revision={1}/>)
  await screen.findByText('生产客户0')
  fireEvent.click(within(screen.getByText('生产客户0').closest('tr')!).getByRole('button', { name: '图片明细' }))
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('load_imposition_job', { id: 'job-0' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  fireEvent.click(within(screen.getByText('生产客户1').closest('tr')!).getByRole('button', { name: '图片明细' }))
  await screen.findByText('第二条明细 · 图片明细')
  await act(async () => resolveFirst({ ...detail, customerName: '过期明细' }))
  expect(screen.queryByText('过期明细 · 图片明细')).toBeNull()
})


it('keeps the pending row on return failure and allows retry', async () => {
  const onReturned = vi.fn()
  let attempts = 0
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_pending_impositions') return { records: [jobs[0]], total: 1, page: 1, pageSize: 20 }
    if (command === 'return_imposition_to_review' && ++attempts === 1) throw new Error('保存失败')
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0} onReturned={onReturned}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '回退' }))
  fireEvent.click(within(await screen.findByRole('tooltip')).getByRole('button', { name: /回\s*退/ }))
  await screen.findByText(/回退到示意图审核失败/)
  expect(screen.getByText('生产客户0')).toBeTruthy()
  expect(onReturned).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '回退' }))
  fireEvent.click(within(await screen.findByRole('tooltip')).getByRole('button', { name: /回\s*退/ }))
  await waitFor(() => expect(onReturned).toHaveBeenCalledOnce())
})


import { zoomAtPointer } from '../src/modules/imposition/zoomAtPointer'

describe('imposition pointer zoom', () => {
  it.each([[1, 2], [2, .6], [.6, 1]])('keeps the same scene point under the pointer from %s to %s', (oldZoom, newZoom) => {
    const viewport = { width: 1000, height: 700 }
    const scene = { width: 1400, height: 520 }
    const pointer = { x: 230, y: 170 }
    const offset = { x: -80, y: 45 }
    const next = zoomAtPointer(pointer, offset, oldZoom, newZoom, viewport, scene)
    for (const [axis, size] of [['x', 'width'], ['y', 'height']] as const) {
      const before = (pointer[axis] - offset[axis] - Math.max(0, (viewport[size] - scene[size] * oldZoom) / 2)) / oldZoom
      const after = (pointer[axis] - next[axis] - Math.max(0, (viewport[size] - scene[size] * newZoom) / 2)) / newZoom
      expect(after).toBeCloseTo(before, 10)
    }
  })
})


function mockComparisonJob(solve: (request: { objective: string; threadCount?: number; allowBaseMixing?: boolean }) => unknown) {
  const job = jobs[0]
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'get_imposition_compute_info') return { logicalCores: 8, defaultThreads: 8 }
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [{ ...detail.images[0], filePath: 'D:/qa/comparison.svg', widthMm: 20, heightMm: 20, attributes: { QT: '3' } }] }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: false }
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular') return solve(args.request)
  })
  return job
}
function comparisonResult(sheetCount: number) {
  return { placements: Array.from({ length: 3 }, (_, index) => ({ id: `${jobs[0].id}::asset${index ? `#qt-${index + 1}` : ''}`, sheetIndex: index % sheetCount, xMm: 15 + Math.floor(index / sheetCount) * 23, yMm: 15, widthMm: 20, heightMm: 20, rotationDeg: 0 })), unplaced: [], sheetsUsed: sheetCount, utilization: .1, algorithm: 'local-tools' }
}

it('shows base mixing in production, defaults off, invalidates cached choices and forwards the setting to all strategies', async () => {
  vi.stubEnv('DEV', false)
  const job = mockComparisonJob(request => comparisonResult(request.allowBaseMixing ? 1 : 2))
  const original = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: true }
    const result = await original(command, args)
    if (command === 'load_imposition_job') return { ...result, images: result.images.map((image: ProductionImage) => ({ ...image, filePath: 'D:/qa/base-mixing-switch.svg' })) }
    return result
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  const mixing = screen.getByRole('switch', { name: '底座混排' })
  expect(mixing.getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByRole('combobox', { name: '拼版策略' })).toBeNull()
  await selectWholeJobAndCalculate(job)
  const calls = () => mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')
  const ready = async (sheets: number) => {
    const choice = await screen.findByRole('button', { name: new RegExp(`综合最少\\s*版面 ${sheets}`) }, { timeout: 5000 })
    await waitFor(() => expect((choice as HTMLButtonElement).disabled).toBe(false))
    return choice
  }
  fireEvent.click(await ready(2))
  expect(calls()).toHaveLength(3)
  expect(calls().every(call => call[1].request.allowBaseMixing === false)).toBe(true)
  fireEvent.click(mixing)
  expect(mixing.getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByLabelText('拼版方案比较')).toBeNull()
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual([])
  expect(calls()).toHaveLength(3) // Setting changes wait for explicit calculation.
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  fireEvent.click(await ready(1))
  expect(calls()).toHaveLength(6)
  expect(calls().slice(3).every(call => call[1].request.allowBaseMixing === true)).toBe(true)
  expect(calls().every(call => call[1].request.items[0].lineOnly === true)).toBe(true)
  fireEvent.click(mixing)
  expect(screen.queryByLabelText('拼版方案比较')).toBeNull()
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await ready(2)
  expect(calls()).toHaveLength(9)
  expect(calls().slice(6).every(call => call[1].request.allowBaseMixing === false)).toBe(true)
})

it('defaults to all, solves three strategies serially from one contour extraction, and renders only the selected plan', async () => {
  const finish: Array<(value: unknown) => void> = []
  const job = mockComparisonJob(() => new Promise(resolve => finish.push(resolve)))
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  expect(screen.getByRole('combobox', { name: '拼版策略' }).closest('.ant-select')!.textContent).toContain('全部')
  await selectWholeJobAndCalculate(job)
  const calls = () => mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')
  await waitFor(() => expect(finish).toHaveLength(1))
  expect(calls().map(call => call[1].request.objective)).toEqual(['least-material'])
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual([])
  await act(async () => finish[0](comparisonResult(1)))
  await waitFor(() => expect(finish).toHaveLength(2))
  expect((screen.getByRole('button', { name: /节省板材\s*版面 1/ }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => finish[1](comparisonResult(3)))
  await waitFor(() => expect(finish).toHaveLength(3))
  await act(async () => finish[2](comparisonResult(2)))
  const choices = screen.getByLabelText('拼版方案比较')
  await waitFor(() => expect((within(choices).getByRole('button', { name: /综合最少\s*版面 2/ }) as HTMLButtonElement).disabled).toBe(false))
  expect(calls().map(call => call[1].request.objective)).toEqual(['least-material', 'least-cutting', 'combined'])
  expect(calls().every(call => call[1].request.items === calls()[0][1].request.items)).toBe(true)
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'load_imposition_geometry')).toHaveLength(1)
  expect(document.querySelector('.imposition-packing-results')).toBeNull()
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual([])
  fireEvent.click(within(choices).getByRole('button', { name: /综合最少\s*版面 2/ }))
  await waitFor(() => expect(mocks.canvas.mock.calls.at(-1)![0].pages).toHaveLength(2))
  expect(mocks.canvas.mock.calls.at(-1)![0].pages.flat()).toHaveLength(3)
  expect(document.querySelector('.imposition-packing-results')!.textContent).toContain('本次版面 2')
  expect(screen.getByLabelText('拼版方案比较')).toBe(choices)
  const combinedPages = mocks.canvas.mock.calls.at(-1)![0].pages
  fireEvent.click(within(choices).getByRole('button', { name: /节省板材\s*版面 1/ }))
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toHaveLength(1)
  fireEvent.click(within(choices).getByRole('button', { name: /切割方案优先\s*版面 3/ }))
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toHaveLength(3)
  fireEvent.click(within(choices).getByRole('button', { name: /综合最少\s*版面 2/ }))
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toBe(combinedPages)
  expect(within(choices).getByRole('button', { name: /综合最少\s*版面 2/ }).getAttribute('aria-pressed')).toBe('true')
  expect(calls()).toHaveLength(3)
  const props = mocks.canvas.mock.calls.at(-1)![0]
  const original = props.pages[0][0]
  const edited = applyPackingEdit(props.pages, 0, original, 0, { ...original, x: original.x + 1, rotation: 180 }, false)
  act(() => props.onEdit!(edited.pages, edited.edit))
  const editedPages = mocks.canvas.mock.calls.at(-1)![0].pages
  fireEvent.click(within(choices).getByRole('button', { name: /节省板材\s*版面 1/ }))
  fireEvent.click(within(choices).getByRole('button', { name: /综合最少\s*版面 2/ }))
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toBe(editedPages)
  expect(editedPages[0][0]).toMatchObject({ x: original.x + 1, rotation: 180 })
  // Explicit recalculation replaces the previous three cached results.

  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await waitFor(() => expect(finish).toHaveLength(4))
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual([])
  for (const index of [3, 4, 5]) {
    await waitFor(() => expect(finish).toHaveLength(index + 1))
    await act(async () => finish[index](comparisonResult(1)))
  }
  await waitFor(() => expect((screen.getByRole('button', { name: /节省板材\s*版面 1/ }) as HTMLButtonElement).disabled).toBe(false))
})

it.each(['add-image', 'cancel-image', 'back'])('releases all comparison choices and canvas results when %s invalidates the workspace', async action => {
  const job = mockComparisonJob(request => comparisonResult(request.objective === 'combined' ? 2 : 1))
  const original = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation(async (command, args) => {
    const value = await original(command, args)
    if (command !== 'load_imposition_job') return value
    return { ...value, images: [...value.images, { ...value.images[0], id: 'extra', name: '额外.svg' }] }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  await openJobImages(job)
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 front.svg' }))
  await closeImagePicker()
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  const choice = await screen.findByRole('button', { name: /综合最少\s*版面 2/ }, { timeout: 5000 })
  await waitFor(() => expect((choice as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(choice)
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toHaveLength(2)
  if (action === 'back') {
    fireEvent.click(screen.getByRole('button', { name: '返回待拼版' }))
    fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  } else {
    await openJobImages(job)
    fireEvent.click(screen.getByRole('checkbox', { name: action === 'add-image' ? '参与拼版 额外.svg' : '参与拼版 front.svg' }))
    await closeImagePicker()
  }
  await waitFor(() => expect(screen.queryByLabelText('拼版方案比较')).toBeNull())
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual([])
  expect(document.querySelector('.imposition-packing-results')).toBeNull()
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('勾选右侧图片，点击“智能拼版”生成拼版')).toBeTruthy()
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')).toHaveLength(3)
})

it('production hides development controls, uses automatic cores, and keeps valid comparison choices when one solver fails', async () => {
  vi.stubEnv('DEV', false)
  localStorage.setItem(IMPOSITION_THREADS_STORAGE_KEY, '1')
  const job = mockComparisonJob(request => {
    if (request.objective === 'least-cutting') throw new Error('示例策略失败')
    return comparisonResult(request.objective === 'combined' ? 2 : 1)
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.click(screen.getByRole('button', { name: '展开版面配置' }))
  expect(await screen.findByRole('button', { name: '选择小版' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '编辑版面配置' })).toBeNull()
  expect(screen.queryByRole('button', { name: '新增版面配置' })).toBeNull()
  expect(screen.queryByRole('button', { name: '删除版面配置' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '拼版策略' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '使用核心数' })).toBeNull()
  await selectWholeJobAndCalculate(job)
  const choice = await screen.findByRole('button', { name: /综合最少\s*版面 2/ })
  await waitFor(() => expect((choice as HTMLButtonElement).disabled).toBe(false))
  const calls = mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')
  expect(calls).toHaveLength(3)
  expect(calls.every(call => call[1].request.threadCount === undefined)).toBe(true)
  expect(screen.getByRole('button', { name: /计算失败：示例策略失败/ })).toBeTruthy()
  fireEvent.click(choice)
  expect(mocks.canvas.mock.calls.at(-1)![0].pages).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: '选择小版' }))
  await screen.findByText('勾选右侧图片，点击“智能拼版”生成拼版')
  expect(screen.queryByRole('button', { name: /综合最少\s*版面 2/ })).toBeNull()
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '智能拼版' }))
  await screen.findByRole('button', { name: /综合最少\s*版面 2/ })
  const recalculated = mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular').slice(3)
  expect(recalculated).toHaveLength(3)
  expect(recalculated.every(call => call[1].request.spacingMm === 8 && call[1].request.effectiveHeightMm === 380)).toBe(true)
}, 15000)


it.each([false, true])('deletes only temporary imports, clears selected plans, and preserves the job on failure (%s)', async fail => {
  const temporary = { ...jobs[0], id: `imposition-import-delete-${fail}`, customerName: '导入测试 临时文件', temporary: true, images: [{ ...detail.images[0], filePath: `D:/qa/delete-${fail}.svg`, widthMm: 20, heightMm: 20, attributes: { QT: '2' } }] }
  let finishDelete!: () => void
  mocks.importSvg.mockResolvedValue(temporary)
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') return { records: [jobs[0]], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...jobs[0], images: [{ ...detail.images[0], attributes: { QT: '1' } }] }
    if (command === 'get_imposition_compute_info') return { logicalCores: 8, defaultThreads: 8 }
    if (command === 'load_imposition_geometry') return { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], lineOnly: false }
    if (command === 'pack_imposition_irregular') return { placements: [0, 1].map(index => ({ id: `${temporary.id}::asset${index ? '#qt-2' : ''}`, sheetIndex: 0, xMm: 15 + index * 23, yMm: 15, widthMm: 20, heightMm: 20, rotationDeg: 0 })), unplaced: [], sheetsUsed: 1, utilization: .1, algorithm: 'local-tools' }
    if (command === 'delete_imposition_import') {
      expect(args.jobId).toBe(temporary.id)
      if (fail) throw new Error('文件被占用')
      return new Promise<void>(resolve => { finishDelete = resolve })
    }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  await startSingleStrategyWorkspace()
  fireEvent.click(screen.getByRole('button', { name: /上传 SVG/ }))
  const remove = await screen.findByRole('button', { name: `删除临时文件 ${temporary.customerName}` })
  expect(screen.getAllByRole('button', { name: /^删除临时文件/ })).toHaveLength(1)
  await selectWholeJobAndCalculate(temporary)
  await screen.findByText(/已放置 2\/2 张/)
  fireEvent.click(remove)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'delete_imposition_import')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '取 消' }))
  expect(screen.getByRole('button', { name: `删除临时文件 ${temporary.customerName}` })).toBeTruthy()
  fireEvent.click(remove)
  fireEvent.click(screen.getByRole('button', { name: '删 除' }))
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(call => call[0] === 'delete_imposition_import')).toHaveLength(1))
  if (fail) {
    await screen.findByText(/删除临时文件失败.*文件被占用/)
    expect(mocks.canvas.mock.calls.at(-1)![0].pages.flat()).toHaveLength(2)
    expect(screen.getByRole('checkbox', { name: `选择任务 ${temporary.customerName}` })).toBeTruthy()
    return
  }
  expect((screen.getByRole('button', { name: '智能拼版' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => finishDelete())
  await waitFor(() => expect(screen.queryByRole('button', { name: `删除临时文件 ${temporary.customerName}` })).toBeNull())
  await waitFor(() => expect(mocks.canvas.mock.calls.at(-1)![0].pages).toEqual([]))
  expect(screen.getByRole('checkbox', { name: `选择任务 ${jobs[0].customerName}` })).toBeTruthy()
  expect(document.querySelector('.imposition-packing-results')).toBeNull()
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '返回待拼版' }))
  await startSingleStrategyWorkspace()
  expect(screen.queryByRole('button', { name: `删除临时文件 ${temporary.customerName}` })).toBeNull()
})
