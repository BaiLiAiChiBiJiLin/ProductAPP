import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import BatchHistoryPanel from '../src/modules/schematic/history/BatchHistoryPanel'
import type { BatchListQuery, BatchSummary } from '../src/modules/schematic/services/batchHistoryService'
import dayjs from 'dayjs'

const api = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }))
vi.mock('../src/modules/schematic/services/batchHistoryService', () => ({ listHistoryBatches: api.list, deleteHistoryBatch: api.remove }))
vi.mock('../src/modules/schematic/history/historyThumbnailService', () => ({ loadBatchThumbnails: vi.fn(async () => [
  { assetId: 'image', name: '图片缩略图', url: 'data:image/png;base64,preview' },
]) }))
let records: BatchSummary[]
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getComputedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
})
beforeEach(() => {
  records = Array.from({ length: 37 }, (_, index) => ({ id: `batch-${index}`, customerName: `订单 ${index}`, savedAt: '2026-10-09T02:16:00.000Z', assetCount: 84 }))
  api.list.mockReset().mockImplementation(async (query: BatchListQuery) => {
    const matching = records.filter(record => !query.search || record.customerName.includes(query.search))
    const page = Math.max(1, Math.min(query.page, Math.ceil(matching.length / query.pageSize)))
    return { records: matching.slice((page - 1) * query.pageSize, page * query.pageSize), total: matching.length, page, pageSize: query.pageSize }
  })
  api.remove.mockReset().mockImplementation(async id => { records = records.filter(record => record.id !== id) })
})
afterEach(() => { cleanup(); vi.useRealTimers() })
const props = { active: true, openingId: null, progress: { completed: 0, total: 0 }, onOpen: vi.fn() }

test('paginates summaries, searches by name from page one, and resets the filter', async () => {
  render(<BatchHistoryPanel {...props}/>)
  expect(await screen.findByRole('button', { name: '打开批次 订单 0', exact: true })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: /^打开批次/ })).toHaveLength(12)
  fireEvent.click(screen.getByTitle('2'))
  expect(await screen.findByRole('button', { name: '打开批次 订单 12', exact: true })).toBeTruthy()
  expect(api.list).toHaveBeenLastCalledWith({ page: 2, pageSize: 12 })
  fireEvent.change(screen.getByRole('textbox', { name: '搜索批次名' }), { target: { value: '订单 31' } })
  expect(screen.queryByRole('button', { name: /^搜\s*索$/ })).toBeNull()
  expect(await screen.findByRole('button', { name: '打开批次 订单 31', exact: true })).toBeTruthy()
  expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: '订单 31', page: 1 }))
  expect(screen.getAllByRole('button', { name: /^打开批次/ })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /^重\s*置$/ }))
  expect(await screen.findByRole('button', { name: '打开批次 订单 0', exact: true })).toBeTruthy()
  expect(api.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 12 })
})

test('deleting the last record of the final page follows the server-clamped page without opening a batch', async () => {
  const open = vi.fn()
  render(<BatchHistoryPanel {...props} onOpen={open}/>)
  await screen.findByRole('button', { name: '打开批次 订单 0', exact: true })
  fireEvent.click(screen.getByTitle('4'))
  fireEvent.click(await screen.findByRole('button', { name: '删除批次 订单 36', exact: true }))
  expect(await screen.findByRole('button', { name: '打开批次 订单 24', exact: true })).toBeTruthy()
  expect(api.remove).toHaveBeenCalledWith('batch-36')
  expect(screen.queryByTitle('4')).toBeNull()
  expect(open).not.toHaveBeenCalled()
})

test('opening only shows image load progress, hides filters and pagination, and returning reloads history', async () => {
  const open = vi.fn()
  const { rerender } = render(<BatchHistoryPanel {...props} onOpen={open}/>)
  fireEvent.click(await screen.findByRole('button', { name: '打开批次 订单 0', exact: true }))
  expect(open).toHaveBeenCalledWith(records[0])
  rerender(<BatchHistoryPanel {...props} openingId="batch-0" progress={{ completed: 5, total: 84 }}/>)
  expect(screen.getByRole('status').textContent).toContain('5/84')
  expect(screen.queryByRole('button', { name: /^搜\s*索$/ })).toBeNull()
  expect(screen.queryByPlaceholderText('保存日期')).toBeNull()
  expect(screen.queryByText('共 37 个批次')).toBeNull()
  expect(screen.queryByRole('button', { name: /^打开批次/ })).toBeNull()
  rerender(<BatchHistoryPanel {...props} active={false}/>)
  expect(api.list).toHaveBeenCalledTimes(1)
  rerender(<BatchHistoryPanel {...props}/>)
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
})

test('cards show thumbnails without automatically opening a batch and search uses one local calendar day', async () => {
  const open = vi.fn()
  render(<BatchHistoryPanel {...props} onOpen={open}/>)
  expect((await screen.findAllByAltText('图片缩略图'))[0].getAttribute('src')).toBe('data:image/png;base64,preview')
  expect(open).not.toHaveBeenCalled()
  expect(screen.queryByText('最近使用批次')).toBeNull()
  expect(screen.queryByPlaceholderText('结束日期')).toBeNull()
  const date = screen.getByPlaceholderText('保存日期')
  fireEvent.change(date, { target: { value: '2026-10-09' } })
  fireEvent.keyDown(date, { key: 'Enter', code: 'Enter' })
  await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({
    page: 1, dateFrom: dayjs('2026-10-09').startOf('day').toISOString(), dateTo: dayjs('2026-10-10').startOf('day').toISOString(),
  })))
})

test('load failures can retry and a filtered empty result is distinguished from no history', async () => {
  api.list.mockRejectedValueOnce('数据库忙')
  render(<BatchHistoryPanel {...props}/>)
  expect((await screen.findByRole('alert')).textContent).toContain('数据库忙')
  fireEvent.click(screen.getByRole('button', { name: /^重\s*试$/ }))
  await screen.findByRole('button', { name: '打开批次 订单 0', exact: true })
  fireEvent.change(screen.getByRole('textbox', { name: '搜索批次名' }), { target: { value: '不存在的客户' } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索批次名' }), { key: 'Enter', code: 'Enter' })
  expect(await screen.findByText('没有符合条件的记录')).toBeTruthy()
  expect(screen.queryByText('暂无记录')).toBeNull()
})

test('the actual name input waits for Chinese composition and searches once after selection finishes', async () => {
  render(<BatchHistoryPanel {...props}/> )
  await screen.findByRole('button', { name: '打开批次 订单 0', exact: true })
  vi.useFakeTimers()
  const input = screen.getByRole('textbox', { name: '搜索批次名' })
  const initialCalls = api.list.mock.calls.length
  fireEvent.compositionStart(input)
  fireEvent.change(input, { target: { value: 'ding dan' } })
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 })
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(api.list).toHaveBeenCalledTimes(initialCalls)
  fireEvent.change(input, { target: { value: '订单 31' } })
  fireEvent.compositionEnd(input, { data: '订单 31' })
  await act(() => vi.advanceTimersByTimeAsync(399))
  expect(api.list).toHaveBeenCalledTimes(initialCalls)
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(api.list).toHaveBeenCalledTimes(initialCalls + 1)
  expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: '订单 31', page: 1 }))
  expect(screen.getByRole('button', { name: '打开批次 订单 31', exact: true })).toBeTruthy()
})
