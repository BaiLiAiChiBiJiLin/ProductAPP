import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import LazySvgImage from '../src/modules/schematic/components/LazySvgImage'
import PoolAssetCard from '../src/modules/schematic/components/PoolAssetCard'
import ReviewAssetPicker from '../src/modules/schematic/components/ReviewAssetPicker'
import type { Asset } from '../src/model'
import { clearAssetPreviewCache, loadAssetPreview } from '../src/modules/schematic/services/assetPreviewService'

const api = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/services/backend', () => ({ invoke: api.invoke }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke }))
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOInXLnPwAF7ALNUXCMXgAAAABJRU5ErkJggg=='
const observers: { callback: IntersectionObserverCallback; element?: Element; disconnect: ReturnType<typeof vi.fn> }[] = []
function intersect(index: number, visible: boolean) {
  return act(async () => { observers[index].callback([{ isIntersecting: visible, target: observers[index].element } as IntersectionObserverEntry], {} as IntersectionObserver) })
}
beforeEach(() => {
  vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2)
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('several page thumbnails start loading before the first original finishes, with bounded concurrency', async () => {
  vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8)
  const finish = new Map<string, (value: string) => void>()
  let active = 0, peak = 0
  api.invoke.mockImplementation((_command, args) => new Promise(resolve => {
    active++; peak = Math.max(peak, active)
    finish.set(args.assetId, value => { active--; resolve(value) })
  }))
  const reads = Array.from({ length: 12 }, (_, index) => loadAssetPreview({ id: `parallel-${index}`, svg: '' }, 'parallel-pages'))
  try {
    await vi.waitFor(() => expect(finish.size).toBeGreaterThan(1), { timeout: 500 })
    expect(finish.size).toBeLessThanOrEqual(4)
    api.invoke.mockResolvedValue(PNG)
    for (const resolve of finish.values()) resolve(PNG)
    await Promise.all(reads)
    expect(peak).toBeLessThanOrEqual(4)
  } finally {
    api.invoke.mockResolvedValue(PNG)
    for (const resolve of finish.values()) resolve(PNG)
    await Promise.allSettled(reads)
  }
})

test('parallel loading keeps the layer popup and active canvas ahead of waiting page thumbnails', async () => {
  vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8)
  const finish = new Map<string,(value: string)=>void>()
  api.invoke.mockImplementation((_command,args)=>new Promise(resolve=>{ finish.set(args.assetId,resolve) }))
  const running = Array.from({length:4},(_,index)=>loadAssetPreview({ id:`parallel-busy-${index}`,svg:'' },'parallel-priority'))
  await vi.waitFor(()=>expect(finish.size).toBe(4))
  const queued = Array.from({length:8},(_,index)=>loadAssetPreview({ id:`parallel-thumb-${index}`,svg:'' },'parallel-priority',256,undefined,()=>({visible:true})))
  const canvas = loadAssetPreview({id:'parallel-canvas',svg:''},'parallel-priority',512,undefined,()=>({visible:true,canvas:true}))
  const menu = loadAssetPreview({id:'parallel-menu',svg:''},'parallel-priority',128,undefined,()=>({visible:true,canvas:true,interactive:true}))
  try {
    finish.get('parallel-busy-0')!(PNG)
    await vi.waitFor(()=>expect(finish.has('parallel-menu')).toBe(true))
    expect(finish.has('parallel-canvas')).toBe(false)
    finish.get('parallel-busy-1')!(PNG)
    await vi.waitFor(()=>expect(finish.has('parallel-canvas')).toBe(true))
    expect(api.invoke.mock.calls.slice(4).map(([,args])=>args.assetId)).toEqual(['parallel-menu','parallel-canvas'])
  } finally {
    api.invoke.mockResolvedValue(PNG)
    for (const resolve of finish.values()) resolve(PNG)
    await Promise.allSettled([...running,...queued,canvas,menu])
  }
})

test('confirming 64 pictures preserves loaded and queued previews while save paths and SVG hydration change', async () => {
  const assets: Asset[] = Array.from({ length: 64 }, (_, index) => ({ id: `confirm-${index}`, name: `确认图${index}`, productId: 'a', width: 10, height: 10, svg: '', storagePath: `temp-assets/confirm-${index}.svg`, previewUrl: '', thumbnailUrl: '' }))
  const props = { open: true, assets, batchId: 'before-save', selectedIds: new Set(assets.map(asset => asset.id)), confirming: false, onChange: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn() }
  let finishNinth!: (value: string) => void
  let reads = 0
  api.invoke.mockImplementation(() => ++reads === 9 ? new Promise(resolve => { finishNinth = resolve }) : Promise.resolve(PNG))
  const view = render(<ReviewAssetPicker {...props}/>)
  await waitFor(() => expect(reads).toBe(9))
  const images = () => [...document.querySelectorAll<HTMLImageElement>('.review-asset-picker-item img')]
  expect(images().filter(image => image.getAttribute('src') === PNG)).toHaveLength(8)
  fireEvent.click(screen.getByRole('button', { name: '确认并生成' }))
  const saved = assets.map(asset => ({ ...asset, storagePath: `printflow-file:${asset.id}`, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' }))
  try {
    view.rerender(<ReviewAssetPicker {...props} assets={saved} batchId="after-save" confirming/>)
    expect(images().filter(image => image.getAttribute('src') === PNG)).toHaveLength(8)
    await act(async () => finishNinth(PNG))
    await waitFor(() => expect(images().filter(image => image.getAttribute('src') === PNG)).toHaveLength(64), { timeout: 5000 })
    expect(api.invoke).toHaveBeenCalledTimes(64)
    expect(api.invoke.mock.calls.every(([command, args]) => command === 'load_temp_asset_preview' && args.path.startsWith('temp-assets/confirm-'))).toBe(true)
    expect(props.onConfirm).toHaveBeenCalledOnce()
  } finally { finishNinth?.(PNG) }
}, 15_000)

test('a failed confirmation releases its preview snapshot and subsequent image replacements still refresh', async () => {
  const asset: Asset = { id: 'failed-confirm', name: '失败重试', productId: 'a', width: 10, height: 10, svg: '', storagePath: 'temp-assets/failed-confirm.svg', previewUrl: '', thumbnailUrl: '' }
  const props = { open: true, assets: [asset], batchId: 'before-save', selectedIds: new Set([asset.id]), confirming: false, onChange: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn() }
  const view = render(<ReviewAssetPicker {...props}/>)
  const image = () => document.querySelector<HTMLImageElement>('.review-asset-picker-item img')!
  await waitFor(() => expect(image().getAttribute('src')).toBe(PNG))
  fireEvent.click(screen.getByRole('button', { name: '确认并生成' }))
  const saved = { ...asset, storagePath: 'printflow-file:failed-confirm' }
  view.rerender(<ReviewAssetPicker {...props} assets={[saved]} batchId="after-save" confirming/>)
  expect(image().getAttribute('src')).toBe(PNG)
  const updated = `${PNG}#updated`
  api.invoke.mockResolvedValue(updated)
  view.rerender(<ReviewAssetPicker {...props} assets={[saved]} batchId="after-save"/>)
  await waitFor(() => expect(image().getAttribute('src')).toBe(updated))
  expect(api.invoke).toHaveBeenCalledTimes(2)
  const replaced = `${PNG}#replaced`
  api.invoke.mockResolvedValue(replaced)
  view.rerender(<ReviewAssetPicker {...props} assets={[{ ...saved, svg: '<svg>new artwork</svg>' }]} batchId="after-save"/>)
  await waitFor(() => expect(image().getAttribute('src')).toBe(replaced))
  expect(api.invoke).toHaveBeenCalledTimes(3)
})

test('cache identity includes original source version, layer selection and resolution', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
  const source = { id: 'variant', svg, sourceSvg: `${svg}<!--v1-->`, layerIds: ['front'] }
  await loadAssetPreview(source, undefined, 128)
  await loadAssetPreview({ ...source }, undefined, 128)
  expect(api.invoke).toHaveBeenCalledTimes(1)
  await loadAssetPreview({ ...source, sourceSvg: `${svg}<!--v2-->` }, undefined, 128)
  await loadAssetPreview({ ...source, layerIds: ['back'] }, undefined, 128)
  await loadAssetPreview(source, undefined, 512)
  expect(api.invoke).toHaveBeenCalledTimes(4)
  await loadAssetPreview({ id: 'same-file', svg, storagePath: 'temp-assets/a.svg' })
  await loadAssetPreview({ id: 'same-file', svg: svg.replace('10', '11'), storagePath: 'temp-assets/a.svg' })
  expect(api.invoke).toHaveBeenCalledTimes(6)
})

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

test('edited canvas artwork is chunked for native preview and the temporary resource is cleared', async () => {
  const svg = `<svg><!--${'x'.repeat(300 * 1024)}--></svg>`
  const original = svg
  const url = await loadAssetPreview({ id: '', svg }, undefined, 512, undefined, () => ({ visible: true, canvas: true }), true)
  expect(url).toBe(PNG)
  const chunks = api.invoke.mock.calls.filter(([command]) => command === 'write_export_resource_chunk')
  expect(chunks.map(([, args]) => args.text).join('')).toBe(original)
  expect(chunks.every(([, args]) => args.text.length <= 64 * 1024)).toBe(true)
  expect(api.invoke).toHaveBeenCalledWith('load_inline_asset_preview', { svg: expect.stringMatching(/^printflow-export:/), maxEdgePx: 512 })
  expect(api.invoke).toHaveBeenLastCalledWith('clear_pdf_pages', { ids: [chunks[0][1].id] })
  expect(svg).toBe(original)
})

test('a restored review can preview its independent SVG when its old batch file is gone', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
  api.invoke.mockImplementation(command => command === 'load_inline_asset_preview' ? Promise.resolve(PNG) : Promise.reject(new Error('源批次已删除')))
  await expect(loadAssetPreview({ id: 'review-only', storagePath: 'D:/old-batch/artwork.svg', svg }, 'deleted-batch', 512, undefined, () => ({ visible: true, canvas: true }), true)).resolves.toBe(PNG)
  expect(api.invoke).toHaveBeenCalledWith('load_inline_asset_preview', { svg, maxEdgePx: 512 })
})

test('the active canvas goes ahead of 64 queued thumbnails and shares its result with its page thumbnail', async () => {
  let finish!: (value: string) => void
  api.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const running = loadAssetPreview({ id: 'running', svg: '' }, 'canvas-priority', 512)
  await vi.waitFor(() => expect(finish).toBeDefined())
  const background = Array.from({ length: 64 }, (_, index) => loadAssetPreview({ id: String(index), svg: '' }, 'canvas-priority', 512, undefined, () => ({ visible: false, order: index })))
  const canvas = loadAssetPreview({ id: '63', svg: '' }, 'canvas-priority', 512, undefined, () => ({ visible: true, canvas: true }), true)
  finish(PNG)
  await canvas
  expect(api.invoke.mock.calls[1]).toEqual(['load_batch_asset_preview', { batchId: 'canvas-priority', assetId: '63', maxEdgePx: 512 }])
  await Promise.all([running, ...background])
  const before = api.invoke.mock.calls.length
  await loadAssetPreview({ id: '63', svg: '' }, 'canvas-priority', 512)
  expect(api.invoke).toHaveBeenCalledTimes(before)
  expect(api.invoke.mock.calls.filter(([, args]) => args.assetId === '63')).toHaveLength(1)
})

test('an open layer menu goes ahead of queued canvas previews', async () => {
  let finish!: (value: string) => void
  api.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const running = loadAssetPreview({ id: 'busy', svg: '' }, 'interactive-priority', 512)
  await vi.waitFor(() => expect(finish).toBeDefined())
  const canvas = loadAssetPreview({ id: 'canvas', svg: '' }, 'interactive-priority', 512, undefined, () => ({ visible: true, canvas: true }))
  const menu = loadAssetPreview({ id: 'layer', svg: '' }, 'interactive-priority', 128, undefined, () => ({ visible: true, canvas: true, interactive: true }))
  finish(PNG)
  await Promise.all([running, canvas, menu])
  expect(api.invoke.mock.calls[1][1].assetId).toBe('layer')
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
}, 15000)

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
