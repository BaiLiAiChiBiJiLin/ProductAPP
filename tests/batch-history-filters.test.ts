import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import dayjs from 'dayjs'
import { useBatchHistoryFilters } from '../src/modules/schematic/history/useBatchHistoryFilters'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))

test('typing waits 400ms after the final change then starts from page one with the existing page size', () => {
  const { result } = renderHook(() => useBatchHistoryFilters(true))
  act(() => result.current.setQuery({ page: 3, pageSize: 24 }))
  act(() => result.current.setName('d'))
  advance(300)
  act(() => result.current.setName('ds'))
  advance(399)
  expect(result.current.query).toEqual({ page: 3, pageSize: 24 })
  advance(1)
  expect(result.current.query).toEqual({ page: 1, pageSize: 24, search: 'ds' })
})

test('IME composition cancels pending searches and Enter cannot submit unfinished Chinese input', () => {
  const { result } = renderHook(() => useBatchHistoryFilters(true))
  act(() => result.current.setName('k'))
  advance(200)
  act(() => { result.current.compositionStart(); result.current.setName('ke hu') })
  advance(1000)
  act(() => result.current.searchNow())
  expect(result.current.query.search).toBeUndefined()
  act(() => result.current.compositionEnd('客户'))
  advance(399)
  expect(result.current.query.search).toBeUndefined()
  advance(1)
  expect(result.current.query.search).toBe('客户')
})

test('Enter flushes immediately without a second query or subsequent pagination reset', () => {
  const { result } = renderHook(() => useBatchHistoryFilters(true))
  act(() => result.current.setName('订单'))
  act(() => result.current.searchNow())
  expect(result.current.query.search).toBe('订单')
  act(() => result.current.setQuery(current => ({ ...current, page: 2 })))
  const page = result.current.query
  advance(1000)
  expect(result.current.query).toBe(page)
})

test('date changes immediately apply the latest name and a full local day, and date clearing retains the name', () => {
  const { result } = renderHook(() => useBatchHistoryFilters(true))
  act(() => result.current.setName('未提交的客户名'))
  act(() => result.current.changeDate(dayjs('2026-10-09')))
  expect(result.current.query).toEqual({ page: 1, pageSize: 12, search: '未提交的客户名',
    dateFrom: dayjs('2026-10-09').startOf('day').toISOString(), dateTo: dayjs('2026-10-10').startOf('day').toISOString() })
  const applied = result.current.query
  advance(500)
  expect(result.current.query).toBe(applied)
  act(() => result.current.changeDate(null))
  expect(result.current.query).toEqual({ page: 1, pageSize: 12, search: '未提交的客户名' })
})

test('reset cancels stale input and restores the first page immediately', () => {
  const { result } = renderHook(() => useBatchHistoryFilters(true))
  act(() => result.current.changeDate(dayjs('2026-10-09')))
  act(() => result.current.setQuery(current => ({ ...current, page: 2 })))
  act(() => result.current.setName('旧搜索'))
  advance(200)
  act(() => result.current.clear())
  expect(result.current.name).toBe('')
  expect(result.current.savedDate).toBeNull()
  advance(1000)
  expect(result.current.query).toEqual({ page: 1, pageSize: 12 })
})

test('hiding history cancels the timer, and returning reconciles the draft without losing filters', () => {
  const { result, rerender } = renderHook(({ enabled }) => useBatchHistoryFilters(enabled), { initialProps: { enabled: true } })
  act(() => result.current.setName('待搜索'))
  rerender({ enabled: false })
  advance(1000)
  expect(result.current.query.search).toBeUndefined()
  rerender({ enabled: true })
  advance(400)
  expect(result.current.query.search).toBe('待搜索')
})
