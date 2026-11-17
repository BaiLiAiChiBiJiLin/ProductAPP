import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import LazySvgImage from '../src/modules/schematic/components/LazySvgImage'
import PoolAssetCard from '../src/modules/schematic/components/PoolAssetCard'
import { clearAssetPreviewCache, loadAssetPreview } from '../src/modules/schematic/services/assetPreviewService'

const api = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/services/backend', () => ({ invoke: api.invoke }))
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOInXLnPwAF7ALNUXCMXgAAAABJRU5ErkJggg=='
const observers: { callback: IntersectionObserverCallback; element?: Element; disconnect: ReturnType<typeof vi.fn> }[] = []
function intersect(index: number, visible: boolean) {
  return act(async () => { observers[index].callback([{ isIntersecting: visible, target: observers[index].element } as IntersectionObserverEntry], {} as IntersectionObserver) })
}
beforeEach(() => {
  clearAssetPreviewCache()
  api.invoke.mockReset().mockResolvedValue(PNG)
  observers.length = 0
  vi.stubGlobal('IntersectionObserver', class {
    index: number
    disconnect = vi.fn()
    constructor(callback: IntersectionObserverCallback) { this.index = observers.length; observers.push({ callback, disconnect: this.disconnect }) }
    observe(element: Element) { observers[this.index].element = element }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('a visible card requests a bounded PNG instead of original SVG bytes', async () => {
  render(<LazySvgImage svg="" storagePath="printflow-file:a" assetId="a" batchId="batch" alt="图片"/>)
  expect(api.invoke).not.toHaveBeenCalled()
  await intersect(0, true)
  await waitFor(() => expect(screen.getByAltText('图片').getAttribute('src')).toBe(PNG))
  expect(api.invoke).toHaveBeenCalledExactlyOnceWith('load_batch_asset_preview', { batchId: 'batch', assetId: 'a', maxEdgePx: 256 })
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
})

test('all 64 thumbnails preload without scrolling, retain small PNGs and never reload when returning', async () => {
  const view = render(<>{Array.from({ length: 64 }, (_, index) => <LazySvgImage key={index} svg="" storagePath={`printflow-file:${index}`} assetId={`image-${index}`} batchId="batch" previewOrder={index} alt={`图片${index}`}/>)}</>)
  await waitFor(() => expect(view.container.querySelectorAll('img[src]')).toHaveLength(64), { timeout: 5000 })
  for (let index = 63; index >= 0; index--) {
    await intersect(index, true)
    expect(screen.getByAltText(`图片${index}`).getAttribute('src')).toBe(PNG)
    await intersect(index, false)
  }
  expect(api.invoke.mock.calls.map(([, args]) => args.assetId)).toEqual(Array.from({ length: 64 }, (_, index) => `image-${index}`))
  expect(api.invoke).toHaveBeenCalledTimes(64)
  expect(api.invoke.mock.calls.every(([command]) => command === 'load_batch_asset_preview')).toBe(true)
})

test('the same image can be previewed in two places and closing one does not invalidate the other', async () => {
  let finish!: (value: string) => void
  api.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = render(<><LazySvgImage key="list" svg="" assetId="shared" batchId="batch" alt="列表图"/><LazySvgImage key="picker" svg="" assetId="shared" batchId="batch" alt="选择图"/></>)
  await intersect(0, true); await intersect(1, true)
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
  view.rerender(<><LazySvgImage key="list" svg="" assetId="shared" batchId="batch" alt="列表图"/></>)
  await act(async () => finish(PNG))
  await waitFor(() => expect(screen.getByAltText('列表图').getAttribute('src')).toBe(PNG))
})

test('an already started preview can finish offscreen and is ready when scrolling back', async () => {
  let finish!: (value: string) => void
  api.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<LazySvgImage svg="" assetId="late" batchId="batch" alt="图片"/>)
  await intersect(0, true)
  await intersect(0, false)
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
  await act(async () => finish(PNG))
  expect(screen.getByAltText('图片').getAttribute('src')).toBe(PNG)
  await intersect(0, true)
  expect(api.invoke).toHaveBeenCalledTimes(1)
})

test('a preview error does not fall back to a large original and can be retried', async () => {
  api.invoke.mockRejectedValueOnce(new Error('preview unavailable'))
  render(<LazySvgImage svg="" assetId="retry" batchId="batch" alt="长文件名"/>)
  await intersect(0, true)
  const failed = await screen.findByAltText('预览不可用')
  expect(failed.getAttribute('title')).toContain('点击重试')
  fireEvent.click(failed)
  await waitFor(() => expect(screen.getByAltText('长文件名').getAttribute('src')).toBe(PNG))
  expect(api.invoke.mock.calls.every(([command]) => command === 'load_batch_asset_preview')).toBe(true)
})

test('a metadata-only pool card uses the saved preview after temporary upload cleanup', async () => {
  api.invoke.mockImplementation((command: string) => command === 'load_temp_asset_preview' ? Promise.reject(new Error('临时图片不可访问')) : Promise.resolve(PNG))
  const asset = { id: 'saved-pool', name: '待添加图片', productId: 'p', width: 10, height: 10, svg: '', previewUrl: '', thumbnailUrl: '', storagePath: 'temp-assets/saved-pool.svg' }
  render(<PoolAssetCard asset={asset} batchId="saved-batch" used={false} onPreview={vi.fn()}/>)
  await intersect(0, true)
  await waitFor(() => expect(screen.getByAltText(asset.name).getAttribute('src')).toBe(PNG))
  expect(api.invoke).toHaveBeenCalledWith('load_batch_asset_preview', { batchId: 'saved-batch', assetId: asset.id, maxEdgePx: 256 })
})

test('large inline originals are rejected before IPC instead of duplicating the SVG payload', async () => {
  await expect(loadAssetPreview({ id: 'huge', svg: 'x'.repeat(300 * 1024) })).rejects.toThrow('源文件路径')
  expect(api.invoke).not.toHaveBeenCalled()
})

test('preview work is serial and abandoning queued work never downloads its original', async () => {
  let finish!: (value: string) => void
  api.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const first = loadAssetPreview({ id: 'first', svg: '' }, 'batch')
  const controller = new AbortController()
  const second = expect(loadAssetPreview({ id: 'cancelled', svg: '' }, 'batch', 256, controller.signal)).rejects.toHaveProperty('name', 'AbortError')
  const third = loadAssetPreview({ id: 'third', svg: '' }, 'batch')
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
  controller.abort()
  finish(PNG)
  await Promise.all([first, second, third])
  expect(api.invoke.mock.calls.map(([, args]) => args.assetId)).toEqual(['first', 'third'])
})

test('a popup and a remounted category reuse the already loaded thumbnail without another request', async () => {
  const view = render(<LazySvgImage svg="" assetId="reused" batchId="batch" alt="列表"/>)
  await intersect(0, true)
  await screen.findByAltText('列表')
  view.rerender(<><LazySvgImage key="popup" svg="" assetId="reused" batchId="batch" alt="放大"/></>)
  await intersect(1, true)
  await waitFor(() => expect(screen.getByAltText('放大').getAttribute('src')).toBe(PNG))
  expect(api.invoke).toHaveBeenCalledTimes(1)
})

test('the thumbnail cache evicts old entries to bound accumulated memory across batches', async () => {
  for (let index = 0; index < 129; index++) await loadAssetPreview({ id: String(index), svg: '' }, 'batch')
  expect(api.invoke).toHaveBeenCalledTimes(129)
  await loadAssetPreview({ id: '128', svg: '' }, 'batch')
  expect(api.invoke).toHaveBeenCalledTimes(129)
  await loadAssetPreview({ id: '0', svg: '' }, 'batch')
  expect(api.invoke).toHaveBeenCalledTimes(130)
})

test('large thumbnail responses hit the byte budget before the entry limit', async () => {
  api.invoke.mockResolvedValue(PNG + 'A'.repeat(900 * 1024))
  for (let index = 0; index < 12; index++) await loadAssetPreview({ id: String(index), svg: '' }, 'batch')
  await loadAssetPreview({ id: '11', svg: '' }, 'batch')
  expect(api.invoke).toHaveBeenCalledTimes(12)
  await loadAssetPreview({ id: '0', svg: '' }, 'batch')
  expect(api.invoke).toHaveBeenCalledTimes(13)
})

test('reopening history invalidates its cached thumbnail and a pending older result cannot repopulate it', async () => {
  let finish!: (value: string) => void
  api.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const asset = { id: 'refresh', svg: '' }
  const older = loadAssetPreview(asset, 'batch')
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
  clearAssetPreviewCache('batch')
  const refreshed = loadAssetPreview(asset, 'batch')
  finish(PNG)
  await Promise.all([older, refreshed])
  expect(api.invoke).toHaveBeenCalledTimes(2)
  await loadAssetPreview(asset, 'batch')
  expect(api.invoke).toHaveBeenCalledTimes(2)
})

test('queued thumbnail priority follows the current viewport and demotes images that have scrolled away', async () => {
  const finish = new Map<string, (value: string) => void>()
  api.invoke.mockImplementation((_command, args) => new Promise(resolve => { finish.set(args.assetId, resolve) }))
  const blocker = loadAssetPreview({ id: 'running', svg: '' }, 'priority')
  await vi.waitFor(() => expect(finish.has('running')).toBe(true))
  const visible = new Set(['old-view'])
  const queued = ['background', 'old-view', 'new-view'].map((id, order) => loadAssetPreview({ id, svg: '' }, 'priority', 256, undefined, () => ({ visible: visible.has(id), order })))
  try {
    // Scroll before the running task finishes: old-view loses its priority.
    visible.delete('old-view')
    visible.add('new-view')
    finish.get('running')!(PNG)
    await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2))
    expect(api.invoke.mock.calls.map(([, args]) => args.assetId)).toEqual(['running', 'new-view'])
    // Scrolling again does not interrupt the native task already in progress.
    visible.clear()
    visible.add('old-view')
    finish.get('new-view')!(PNG)
    await vi.waitFor(() => expect(finish.has('old-view')).toBe(true))
    finish.get('old-view')!(PNG)
    await vi.waitFor(() => expect(finish.has('background')).toBe(true))
    finish.get('background')!(PNG)
    await Promise.all([blocker, ...queued])
    expect(api.invoke.mock.calls.map(([, args]) => args.assetId)).toEqual(['running', 'new-view', 'old-view', 'background'])
  } finally {
    api.invoke.mockResolvedValue(PNG)
    for (const resolve of finish.values()) resolve(PNG)
    await Promise.allSettled([blocker, ...queued])
  }
})

test('background thumbnails load in list order even if their requests were registered in a different order', async () => {
  let finish!: (value: string) => void
  api.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const blocker = loadAssetPreview({ id: 'running-order', svg: '' }, 'order')
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
  const later = loadAssetPreview({ id: 'later', svg: '' }, 'order', 256, undefined, () => ({ visible: false, order: 10 }))
  const earlier = loadAssetPreview({ id: 'earlier', svg: '' }, 'order', 256, undefined, () => ({ visible: false, order: 0 }))
  finish(PNG)
  await Promise.all([blocker, later, earlier])
  expect(api.invoke.mock.calls.map(([, args]) => args.assetId)).toEqual(['running-order', 'earlier', 'later'])
})

test('viewport observer updates promote the latest visible cards ahead of older background requests', async () => {
  let finish!: (value: string) => void
  api.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const blocker = loadAssetPreview({ id: 'running-observer', svg: '' }, 'observer')
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
  const view = render(<>{[0, 1, 2, 3].map(index => <LazySvgImage key={index} svg="" assetId={`observed-${index}`} batchId="observer" previewOrder={index} alt={`观察图${index}`}/>)}</>)
  await intersect(0, true)
  await intersect(1, true)
  await intersect(0, false)
  await intersect(1, false)
  await intersect(3, true)
  finish(PNG)
  await blocker
  await waitFor(() => expect(view.container.querySelectorAll('img[src]')).toHaveLength(4))
  expect(api.invoke.mock.calls.map(([, args]) => args.assetId)).toEqual(['running-observer', 'observed-3', 'observed-0', 'observed-1', 'observed-2'])
})

test('a second offscreen subscriber cannot demote an image still visible elsewhere', async () => {
  let finish!: (value: string) => void
  api.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const blocker = loadAssetPreview({ id: 'running-shared', svg: '' }, 'shared')
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
  const background = loadAssetPreview({ id: 'other', svg: '' }, 'shared', 256, undefined, () => ({ visible: false, order: 0 }))
  const first = loadAssetPreview({ id: 'shared-image', svg: '' }, 'shared', 256, undefined, () => ({ visible: true, order: 10 }))
  const second = loadAssetPreview({ id: 'shared-image', svg: '' }, 'shared', 256, undefined, () => ({ visible: false, order: 10 }))
  finish(PNG)
  await Promise.all([blocker, background, first, second])
  expect(api.invoke.mock.calls.map(([, args]) => args.assetId)).toEqual(['running-shared', 'shared-image', 'other'])
})

test('switching batches removes old queued requests while allowing the already running preview to finish', async () => {
  let finish!: (value: string) => void
  api.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const old = render(<>{[0, 1, 2].map(index => <LazySvgImage key={index} svg="" assetId={`old-${index}`} batchId="old-batch" previewOrder={index} alt={`旧图${index}`}/>)}</>)
  await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
  old.unmount()
  const current = render(<LazySvgImage svg="" assetId="new-image" batchId="new-batch" alt="新图"/>)
  await act(async () => finish(PNG))
  await waitFor(() => expect(current.container.querySelector('img')?.getAttribute('src')).toBe(PNG))
  expect(api.invoke.mock.calls.map(([, args]) => args.assetId)).toEqual(['old-0', 'new-image'])
})
