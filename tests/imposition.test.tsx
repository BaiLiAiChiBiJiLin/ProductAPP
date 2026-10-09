import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import ImpositionPage from '../src/modules/imposition/ImpositionPage'
import type { ImpositionJob, ImpositionRecord } from '../src/modules/imposition/impositionRecords'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
const jobs: ImpositionJob[] = Array.from({ length: 21 }, (_, index) => ({ id: `job-${index}`, sourceReviewId: `review-${index}`, customerName: `生产客户${index}`, output: `C:/proof-${index}.pdf`, submittedAt: '2026-10-08T01:00:00Z', paymentStatus: index % 2 ? 'unpaid' : 'paid', status: 'pending', imageCount: 1 }))
const detail: ImpositionRecord = { ...jobs[20], images: [{ id: 'asset', name: 'front.svg', sourceFileName: 'original.svg', filePath: 'D:/project/productionAPP/printflow-data/assets/asset.svg', widthMm: 42.756789, heightMm: 59.789123, productId: 'p', productName: '照片夹', attributes: { QT: '0', Finish: 'Front Side Epoxy' }, attributeImages: {}, note: '原始备注', noteImage: null, productGroupId: 'group', productGroupLeaderId: 'asset', productGroupPosition: 1 }] }
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

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
