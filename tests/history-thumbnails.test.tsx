import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import BatchHistoryPreview from '../src/modules/schematic/history/BatchHistoryPreview'
import { loadBatchThumbnails } from '../src/modules/schematic/history/historyThumbnailService'

const api = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => true }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); api.invoke.mockReset() })

test('preview requests run serially, skip unmounted cards, and continue after a failed render', async () => {
  let finish!: (value: unknown) => void
  api.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockRejectedValueOnce('missing SVG').mockResolvedValueOnce([])
  const first = loadBatchThumbnails('first', new AbortController().signal)
  const cancelled = new AbortController()
  const skipped = loadBatchThumbnails('skipped', cancelled.signal)
  const failed = loadBatchThumbnails('failed', new AbortController().signal).catch(error => error)
  const last = loadBatchThumbnails('last', new AbortController().signal)
  cancelled.abort()
  await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
  finish([])
  expect(await first).toEqual([])
  expect(await skipped).toEqual([])
  expect(await failed).toBe('missing SVG')
  expect(await last).toEqual([])
  expect(api.invoke.mock.calls.map(call => call[1].id)).toEqual(['first', 'failed', 'last'])
})

test('offscreen cards wait until visible, and opening a batch cancels queued preview work', async () => {
  let visible!: (entries: { isIntersecting: boolean }[]) => void
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof visible) { visible = callback }
    observe() {} disconnect = disconnect
  })
  api.invoke.mockResolvedValue([{ assetId: 'one', name: '测试图片', url: 'data:image/png;base64,image' }])
  const view = render(<BatchHistoryPreview batchId="card" savedAt="time" assetCount={84} active/>)
  expect(api.invoke).not.toHaveBeenCalled()
  act(() => visible([{ isIntersecting: true }]))
  expect(await screen.findByAltText('测试图片')).toBeTruthy()
  expect(view.container.querySelectorAll('.batch-history-thumbnail')).toHaveLength(4)
  view.unmount()
  expect(disconnect).toHaveBeenCalled()

  // Hold the queue while a second visible card is unmounted.
  let release!: () => void
  api.invoke.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]) }))
  const blocker = loadBatchThumbnails('blocker', new AbortController().signal)
  await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2))
  const queued = render(<BatchHistoryPreview batchId="cancelled" savedAt="time" assetCount={4} active/>)
  act(() => visible([{ isIntersecting: true }]))
  queued.unmount()
  release()
  await blocker
  await loadBatchThumbnails('end', new AbortController().signal)
  expect(api.invoke.mock.calls.map(call => call[1].id)).toEqual(['card', 'blocker', 'end'])
})
