import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import ImpositionPage from '../src/modules/imposition/ImpositionPage'
import ImpositionThumbnail from '../src/modules/imposition/ImpositionThumbnail'
import { expandImpositionImages, getImpositionQuantity, type ImpositionJob, type ImpositionRecord } from '../src/modules/imposition/impositionRecords'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), canvas: vi.fn((_props: { pages: unknown[][]; collapseRepeatedLayouts?: boolean }) => null) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => false }))
vi.mock('../src/modules/imposition/ImpositionKonvaCanvas', () => ({ default: mocks.canvas }))
const jobs: ImpositionJob[] = Array.from({ length: 21 }, (_, index) => ({ id: `job-${index}`, sourceReviewId: `review-${index}`, customerName: `生产客户${index}`, output: `C:/proof-${index}.pdf`, submittedAt: '2026-10-08T01:00:00Z', paymentStatus: index % 2 ? 'unpaid' : 'paid', status: 'pending', imageCount: 1 }))
const detail: ImpositionRecord = { ...jobs[20], images: [{ id: 'asset', name: 'front.svg', sourceFileName: 'original.svg', filePath: 'D:/project/productionAPP/printflow-data/assets/asset.svg', widthMm: 42.756789, heightMm: 59.789123, productId: 'p', productName: '照片夹', attributes: { QT: '0', Finish: 'Front Side Epoxy' }, attributeImages: {}, note: '原始备注', noteImage: null, productGroupId: 'group', productGroupLeaderId: 'asset', productGroupPosition: 1 }] }

async function selectWholeJobAndCalculate(job: ImpositionJob) {
  const checkbox = await screen.findByRole('checkbox', { name: `选择任务 ${job.customerName}` }) as HTMLInputElement
  await waitFor(() => expect(checkbox.disabled).toBe(false))
  fireEvent.click(checkbox)
  await waitFor(() => expect(checkbox.checked).toBe(true))
  const calculate = screen.getByRole('button', { name: '重新计算' }) as HTMLButtonElement
  await waitFor(() => expect(calculate.disabled).toBe(false))
  fireEvent.click(calculate)
}

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
    if (command === 'load_imposition_polygon') return [[0, 0], [20, 0], [0, 20]]
    if (command === 'pack_imposition_irregular') {
      expect(args.request.irregularAlgorithm).toBe('local-tools')
      expect(args.request.objective).toBe('least-material')
      expect(args.request.items).toHaveLength(1)
      expect(args.request.items[0].quantity).toBe(3)
      throw new Error('worker 计算超时')
    }
    return undefined
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.click(await screen.findByText(job.customerName))
  await selectWholeJobAndCalculate(job)
  expect(screen.queryByRole('radio', { name: '矩形拼版' })).toBeNull()
  await screen.findByText(/异形拼版计算失败.*worker 计算超时/)
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'pack_imposition_rectangles')).toBe(false)
  expect(screen.getByText(/已放置/).textContent).toContain('0/3')
  expect(screen.getByText(/个版面/).textContent).toContain('0 个版面')
})

it('locks packing inputs during a job and unlocks them when the solver returns', async () => {
  let finish!: (value: unknown) => void
  const job = jobs[0]
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [{ ...detail.images[0], attributes: { QT: '3' } }] }
    if (command === 'load_imposition_polygon') return [[0, 0], [20, 0], [0, 20]]
    if (command === 'pack_imposition_irregular') return new Promise(resolve => { finish = resolve })
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.click(screen.getByRole('button', { name: '展开版面配置' }))
  fireEvent.click(await screen.findByText(job.customerName))
  await selectWholeJobAndCalculate(job)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(screen.queryByRole('combobox', { name: '异形算法' })).toBeNull()
  expect(screen.queryByText('本地拼版')).toBeNull()
  expect((screen.getByRole('combobox', { name: '拼版策略' }) as HTMLInputElement).disabled).toBe(true)
  expect(screen.getAllByRole('spinbutton').length).toBeGreaterThanOrEqual(10)
  for (const input of screen.getAllByRole('spinbutton')) expect((input as HTMLInputElement).disabled).toBe(true)
  await act(async () => finish({ placements: [], unplaced: [`${job.id}::asset`, `${job.id}::asset#qt-2`, `${job.id}::asset#qt-3`], sheetsUsed: 0, utilization: 0, algorithm: 'local-tools' }))
  await waitFor(() => expect((screen.getByRole('combobox', { name: '拼版策略' }) as HTMLInputElement).disabled).toBe(false))
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')).toHaveLength(1)
})

it('folds cutting-first templates, expands actual boards without solving again, and folds the next result', async () => {
  const job = jobs[0]
  const placements = Array.from({ length: 5 }, (_, index) => ({
    id: index === 0 ? `${job.id}::asset` : `${job.id}::asset#qt-${index + 1}`,
    sheetIndex: Math.floor(index / 2), xMm: 10 + index % 2 * 23, yMm: 12,
    widthMm: 20, heightMm: 20, rotationDeg: 0,
  }))
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [{ ...detail.images[0], widthMm: 20, heightMm: 20, attributes: { QT: '5' } }] }
    if (command === 'load_imposition_polygon') return [[0, 0], [20, 0], [20, 20], [0, 20]]
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular') return { placements, unplaced: [], sheetsUsed: 3, utilization: .1, algorithm: 'local-tools' }
  })
  const solverCalls = () => mocks.invoke.mock.calls.filter(call => call[0] === 'pack_imposition_irregular')
  const canvasProps = () => mocks.canvas.mock.calls.at(-1)![0]
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  await selectWholeJobAndCalculate(job)
  await screen.findByText(/3 个版面/)
  expect(canvasProps().collapseRepeatedLayouts).toBe(false)
  fireEvent.click(screen.getByText(job.customerName))
  const quantity = within(screen.getByText('front.svg').closest('.imposition-job-image') as HTMLElement).getByRole('spinbutton')
  fireEvent.focus(quantity)
  fireEvent.blur(quantity)
  fireEvent.focus(quantity)
  fireEvent.keyDown(quantity, { key: 'Enter', code: 'Enter', keyCode: 13 })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'update_imposition_image_quantity')).toBe(false)
  expect(solverCalls()).toHaveLength(1)
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '拼版策略' }))
  fireEvent.click(await screen.findByText('切割方案优先（重复统一版式）'))
  await waitFor(() => expect(canvasProps().pages).toHaveLength(0))
  expect(solverCalls()).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '重新计算' }))
  await screen.findByText(/2 种版式 · 共 3 块板材/)
  expect(solverCalls()).toHaveLength(2)
  expect(solverCalls().at(-1)![1].request).toMatchObject({ irregularAlgorithm: 'local-tools', objective: 'least-cutting', items: [expect.objectContaining({ id: `${job.id}::asset`, quantity: 5 })] })
  expect(canvasProps().collapseRepeatedLayouts).toBe(true)
  expect(canvasProps().pages).toHaveLength(3)
  expect(canvasProps().pages.flat()).toHaveLength(5)
  expect(screen.getByText(/已放置/).textContent).toContain('5/5')

  fireEvent.click(screen.getByRole('button', { name: '展开全部板材并编辑' }))
  await screen.findByText(/3 个版面/)
  expect(canvasProps().collapseRepeatedLayouts).toBe(false)
  expect(canvasProps().pages.flat()).toHaveLength(5)
  expect(solverCalls()).toHaveLength(2)
  expect(screen.queryByRole('button', { name: '展开全部板材并编辑' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '重新计算' }))
  await screen.findByText(/2 种版式 · 共 3 块板材/)
  expect(solverCalls()).toHaveLength(3)
  expect(canvasProps().collapseRepeatedLayouts).toBe(true)
  expect(canvasProps().pages.flat()).toHaveLength(5)
  expect(screen.getByRole('button', { name: '展开全部板材并编辑' })).toBeTruthy()
  expect(screen.getByText(/已放置/).textContent).toContain('5/5')
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
    if (command === 'load_imposition_polygon') {
      if (args.path === invalidImage.filePath) throw new Error('SVG 轮廓自交')
      return [[0, 0], [20, 0], [20, 20], [0, 20]]
    }
    if (command === 'pack_imposition_irregular') {
      expect(args.request.items.map((item: { id: string }) => item.id)).toEqual([`${job.id}::valid`])
      return { placements: [{ id: `${job.id}::valid`, sheetIndex: 0, xMm: 0, yMm: 0, widthMm: 20, heightMm: 20, rotationDeg: 0 }], unplaced: [], sheetsUsed: 1, utilization: .1, algorithm: 'tools/material · Rust 位图 · 2 线程' }
    }
    return undefined
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.click(await screen.findByText(job.customerName))
  await selectWholeJobAndCalculate(job)
  await screen.findByText('invalid.svg')
  await waitFor(() => expect(screen.getByText('invalid.svg').closest('.imposition-job-image')?.classList.contains('is-invalid-outline')).toBe(true))
  await waitFor(() => expect(screen.getByText('valid.svg').closest('.imposition-job-image')?.classList.contains('is-invalid-outline')).toBe(false))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('1/2'))
})

it('shows the rejected contour name and reason while keeping successful sheets', async () => {
  const skipped = { ...detail.images[0], id: 'complex-contour', name: '复杂花边.svg', filePath: 'D:/complex-contour.svg', attributes: { QT: '2' } }
  const placed = { ...detail.images[0], id: 'normal-contour', name: '普通挂件.svg', filePath: 'D:/normal-contour.svg', attributes: { QT: '1' } }
  const job = { ...jobs[0], imageCount: 2 }
  const reason = '单张轮廓复杂度 1440000 超过单批计算预算 1000000（1200 个轮廓点），已跳过此图片'
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [skipped, placed] }
    if (command === 'load_imposition_polygon') return [[0, 0], [20, 0], [0, 20]]
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular') return {
      placements: [{ id: `${job.id}::${placed.id}`, sheetIndex: 0, xMm: 0, yMm: 0, widthMm: 20, heightMm: 20, rotationDeg: 0 }],
      unplaced: [`${job.id}::${skipped.id}`, `${job.id}::${skipped.id}#qt-2`], sheetsUsed: 1, utilization: .1, algorithm: 'tools/material · Rust 位图 · 2 线程',
      excludedItems: [{ id: `${job.id}::${skipped.id}`, reason }], warnings: ['轮廓已分批处理'],
    }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.click(await screen.findByText(job.customerName))
  await selectWholeJobAndCalculate(job)
  // The affected job must open automatically so the named red row is visible.
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('1/3'))
  const row = (await screen.findByText(skipped.name)).closest('.imposition-job-image')!
  expect(row.classList.contains('is-invalid-outline')).toBe(true)
  expect(within(row as HTMLElement).getByText(reason)).toBeTruthy()
  expect(screen.getByText(placed.name).closest('.imposition-job-image')?.classList.contains('is-invalid-outline')).toBe(false)
  expect(screen.getByText(/个版面/).textContent).toContain('1 个版面')
  expect(screen.queryByText(/异形拼版计算失败/)).toBeNull()
})

it('marks the largest contour red after batching and still counts its placed QT copies', async () => {
  const complex = { ...detail.images[0], id: 'largest-contour', name: '最大轮廓挂件.svg', filePath: 'D:/largest-contour.svg', attributes: { QT: '2' } }
  const normal = { ...detail.images[0], id: 'normal-contour', name: '普通挂件.svg', filePath: 'D:/normal-contour.svg', attributes: { QT: '1' } }
  const job = { ...jobs[0], imageCount: 2 }
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_pending_impositions') return { records: [job], total: 1, page: 1, pageSize: 20 }
    if (command === 'load_imposition_job') return { ...job, images: [complex, normal] }
    if (command === 'load_imposition_polygon') return [[0, 0], [20, 0], [0, 20]]
    if (command === 'load_imposition_image') return 'data:image/svg+xml,<svg/>'
    if (command === 'pack_imposition_irregular') return {
      placements: [complex.id, `${complex.id}#qt-2`, normal.id].map((id, index) => ({ id: `${job.id}::${id}`, sheetIndex: 0, xMm: 10 + index * 23, yMm: 12, widthMm: 20, heightMm: 20, rotationDeg: 0 })),
      unplaced: [], sheetsUsed: 1, utilization: .1, algorithm: 'tools/material', excludedItems: [],
      warnings: [`轮廓总复杂度 25721744400 超过单批预算 1000000，已按轮廓类型分批；最大轮廓图片：${job.id}::${complex.id}`],
    }
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.click(await screen.findByText(job.customerName))
  await selectWholeJobAndCalculate(job)
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('3/3'))
  const row = screen.getByText(complex.name).closest('.imposition-job-image')!
  expect(row.classList.contains('is-invalid-outline')).toBe(true)
  expect(within(row as HTMLElement).getByText('轮廓总复杂度过高，已分批计算；图片仍会继续参与拼版')).toBeTruthy()
  expect(screen.getByText(normal.name).closest('.imposition-job-image')?.classList.contains('is-invalid-outline')).toBe(false)
  expect(screen.getByText(`轮廓复杂度过高，已分批计算：${complex.name}`)).toBeTruthy()
  expect(screen.getByText(/个版面/).textContent).toContain('1 个版面')
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
    if (command === 'load_imposition_polygon') return [[0, 0], [20, 0], [20, 20], [0, 20]]
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
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.click(await screen.findByText(record.customerName))
  await screen.findByText('首图.svg')
  expect(screen.getByText('勾选右侧图片，点击“重新计算”生成拼版')).toBeTruthy()
  expect(screen.queryByText(/导出：/)).toBeNull()
  expect(screen.queryByText('本地拼版')).toBeNull()
  expect((screen.getByRole('button', { name: '重新计算' }) as HTMLButtonElement).disabled).toBe(true)
  expect(mocks.invoke.mock.calls.filter(([command]) => ['pack_imposition_irregular', 'load_imposition_polygon', 'load_imposition_image'].includes(command))).toHaveLength(0)
  fireEvent.click(screen.getByRole('checkbox', { name: '参与拼版 首图.svg' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '参与拼版 零数量.svg' }))
  expect(screen.getByText('已选 2/3 张图片')).toBeTruthy()
  expect(mocks.invoke.mock.calls.filter(([command]) => ['pack_imposition_irregular', 'load_imposition_polygon', 'load_imposition_image'].includes(command))).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '重新计算' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('2/2'))
  const solver = mocks.invoke.mock.calls.filter(([command]) => command === 'pack_imposition_irregular')
  expect(solver).toHaveLength(1)
  expect(solver[0][1].request.items).toEqual([expect.objectContaining({ id: 'job-0::shared', quantity: 2 })])
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'load_imposition_polygon').map(([, args]) => args.path)).toEqual([record.images[0].filePath])
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'load_imposition_image').map(([, args]) => args.path)).toEqual([record.images[0].filePath]))
})

it('combines selected images across tasks, preserving independent QT counts when source asset IDs are identical', async () => {
  const records = selectionFixture('cross-job-selection')
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.click(await screen.findByText(records[0].customerName))
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 首图.svg' }))
  fireEvent.click(screen.getByText(records[1].customerName))
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 另一任务同图.svg' }))
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'pack_imposition_irregular')).toHaveLength(0)
  const calculate = screen.getByRole('button', { name: '重新计算' }) as HTMLButtonElement
  await waitFor(() => expect(calculate.disabled).toBe(false))
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
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.click(await screen.findByText(record.customerName))
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 首图.svg' }))
  fireEvent.click(screen.getByRole('button', { name: '重新计算' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('2/2'))
  fireEvent.click(screen.getByRole('checkbox', { name: '参与拼版 未选图.svg' }))
  await screen.findByText(/0 个版面/)
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(true)
  expect(solverCalls()).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '重新计算' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('5/5'))
  const quantity = screen.getByRole('spinbutton', { name: 'QT 首图.svg' })
  fireEvent.change(quantity, { target: { value: '1' } })
  fireEvent.blur(quantity)
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('update_imposition_image_quantity', { jobId: record.id, imageId: 'shared', quantity: 1 }))
  await screen.findByText(/0 个版面/)
  expect(solverCalls()).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: '重新计算' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('4/4'))
  fireEvent.click(screen.getByRole('button', { name: '展开版面配置' }))
  const gap = within(screen.getByText('图片间距').closest('label')!).getByRole('spinbutton')
  fireEvent.change(gap, { target: { value: '4' } })
  fireEvent.blur(gap)
  await screen.findByText(/0 个版面/)
  expect(solverCalls()).toHaveLength(3)
  fireEvent.click(screen.getByRole('button', { name: '重新计算' }))
  await waitFor(() => expect(solverCalls()).toHaveLength(4))
  expect(solverCalls().at(-1)![1].request.spacingMm).toBe(4)
})

it('starts with collapsed board settings and preserves configuration and packed results when toggling them', async () => {
  const [record] = selectionFixture('collapsible-board-settings')
  const solverCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === 'pack_imposition_irregular')
  const canvasPages = () => mocks.canvas.mock.calls.at(-1)![0].pages
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  const expand = screen.getByRole('button', { name: '展开版面配置' })
  expect(expand.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('图片间距')).toBeNull()
  expect(screen.getByRole('combobox', { name: '拼版策略' })).toBeTruthy()
  expect(screen.getByRole('button', { name: /^上传 SVG/ })).toBeTruthy()

  fireEvent.click(expand)
  expect(screen.getByRole('button', { name: '收起版面配置' }).getAttribute('aria-expanded')).toBe('true')
  const gap = within(screen.getByText('图片间距').closest('label')!).getByRole('spinbutton') as HTMLInputElement
  expect(gap.value).toBe('3.00')
  fireEvent.change(gap, { target: { value: '4' } })
  fireEvent.blur(gap)
  fireEvent.click(screen.getByRole('button', { name: '收起版面配置' }))
  expect(screen.queryByText('图片间距')).toBeNull()
  expect(solverCalls()).toHaveLength(0)

  fireEvent.click(await screen.findByText(record.customerName))
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 首图.svg' }))
  fireEvent.click(screen.getByRole('button', { name: '重新计算' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('2/2'))
  const pagesBeforeToggle = canvasPages()
  expect(pagesBeforeToggle.flat()).toHaveLength(2)
  expect(solverCalls()).toHaveLength(1)
  expect(solverCalls()[0][1].request.spacingMm).toBe(4)
  expect((screen.getByRole('button', { name: '导出 PDF' }) as HTMLButtonElement).disabled).toBe(false)

  for (let index = 0; index < 2; index++) {
    fireEvent.click(screen.getByRole('button', { name: '展开版面配置' }))
    expect((within(screen.getByText('图片间距').closest('label')!).getByRole('spinbutton') as HTMLInputElement).value).toBe('4.00')
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
  fireEvent.click(await screen.findByRole('button', { name: '开始拼版' }))
  fireEvent.click(await screen.findByText(record.customerName))
  fireEvent.click(await screen.findByRole('checkbox', { name: '参与拼版 首图.svg' }))
  fireEvent.click(screen.getByRole('button', { name: '重新计算' }))
  await waitFor(() => expect(screen.getByText(/已放置/).textContent).toContain('2/2'))
  const quantity = screen.getByRole('spinbutton', { name: 'QT 首图.svg' }) as HTMLInputElement
  fireEvent.change(quantity, { target: { value: '9' } })
  fireEvent.blur(quantity)
  await screen.findByText(/保存 QT 数量失败.*磁盘写入失败/)
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
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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
