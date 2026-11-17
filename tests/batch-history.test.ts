vi.mock('../src/services/backend', async () => { const core = await import('@tauri-apps/api/core'); return { invoke: core.invoke, storageMode: async () => ({ shared: false }) } })
import { beforeEach, expect, test, vi } from 'vitest'
import type { Asset } from '../src/model'
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => false }))
import { discardTemporaryAssets, loadHistoryBatch, type BatchRecord } from '../src/modules/schematic/services/batchHistoryService'
import { loadAssetSvg } from '../src/modules/schematic/services/assetSvgService'

const fixture = (count: number): BatchRecord => ({ id: 'ds', savedAt: '2026-10-07', metadata: { customerName: 'ds', drawingDate: '', estimatedShipDate: '', designer: '设计师' }, assets: Array.from({ length: count }, (_, index): Asset => ({ id: `image-${index}`, name: `原图-${index}`, productId: 'a', width: 42.789, height: 59.789, svg: '', storagePath: `/assets/image-${index}.svg`, previewUrl: '', thumbnailUrl: '', note: '保留备注', productGroupId: '组1' })) })
beforeEach(() => { vi.clearAllMocks() })

test('returning to history sends cleanup references without uploading original SVGs again', async () => {
  const assets = fixture(84).assets.map(asset => ({ ...asset, svg: '<svg>original</svg>', storagePath: `/assets/${asset.id}.svg` }))
  mocks.invoke.mockResolvedValue(undefined)
  await discardTemporaryAssets(assets)
  const [command, args] = mocks.invoke.mock.calls[0]
  expect(command).toBe('discard_temp_assets')
  expect(args.assets.every((asset: Asset) => !asset.svg && !asset.previewUrl && !asset.thumbnailUrl)).toBe(true)
  expect(args.assets.map((asset: Asset) => asset.storagePath)).toEqual(assets.map(asset => asset.storagePath))
  expect(assets.every(asset => asset.svg === '<svg>original</svg>')).toBe(true)
})

test('84-image history opens from metadata without reading every original SVG', async () => {
  const original = fixture(84)
  let inFlight = 0
  let peak = 0
  const onProgress = vi.fn()
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'load_batch') return original
    expect(command).toBe('load_batch_asset_svg')
    expect(args.batchId).toBe('ds')
    peak = Math.max(peak, ++inFlight)
    await new Promise(resolve => setTimeout(resolve, 1))
    inFlight--
    return new TextEncoder().encode(`<svg>原图 Ω ${args.assetId}</svg>`).buffer
  })
  const loaded = await loadHistoryBatch('ds', onProgress)
  expect(peak).toBe(0)
  expect(loaded.metadata).toEqual(original.metadata)
  expect(loaded.assets).toEqual(original.assets)
  expect(original.assets.every(asset => asset.svg === '')).toBe(true)
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('load_batch', { id: 'ds' })
  expect(onProgress).toHaveBeenLastCalledWith({ completed: 84, total: 84 })
})

test('a missing original does not block the complete history manifest and reports when requested', async () => {
  const onProgress = vi.fn()
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'load_batch') return fixture(3)
    if (args.assetId === 'image-1') throw new Error('原始文件不存在')
    return new TextEncoder().encode('<svg/>').buffer
  })
  const loaded = await loadHistoryBatch('ds', onProgress)
  expect(loaded.assets).toHaveLength(3)
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'load_batch_asset_svg')).toHaveLength(0)
  await expect(loadAssetSvg(loaded.assets[1], loaded.id)).rejects.toThrow('原始文件不存在')
  expect(onProgress).toHaveBeenLastCalledWith({ completed: 3, total: 3 })
})

test('empty or invalid UTF-8 image content is reported as an image loading error', async () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([0xff])]) {
    mocks.invoke.mockImplementation(async command => command === 'load_batch' ? fixture(1) : bytes.buffer)
    const loaded = await loadHistoryBatch('ds')
    await expect(loadAssetSvg(loaded.assets[0], loaded.id)).rejects.toThrow()
  }
})

test('saved history artwork reads its batch resource without a failing temporary-file request', async () => {
  mocks.invoke.mockImplementation(async () => new TextEncoder().encode('<svg/>').buffer)
  const asset = { ...fixture(1).assets[0], storagePath: '\\\\server\\artwork\\source.svg' }
  await expect(loadAssetSvg(asset, 'ds')).resolves.toBe('<svg/>')
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('load_batch_asset_svg', { batchId: 'ds', assetId: asset.id })
})

test('visible artwork requests are bounded to two concurrent reads and preserve caller order', async () => {
  let active = 0
  let peak = 0
  mocks.invoke.mockImplementation(async (_command, args) => {
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    return new TextEncoder().encode(`<svg>${args.assetId}</svg>`).buffer
  })
  const assets = fixture(12).assets
  const loaded = await Promise.all(assets.map(asset => loadAssetSvg(asset, 'ds')))
  expect(peak).toBe(2)
  expect(loaded).toEqual(assets.map(asset => `<svg>${asset.id}</svg>`))
})

test('concurrent preview and arrangement reads share only the active request, never stale completed artwork', async () => {
  let content = '<svg>first</svg>'
  mocks.invoke.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 2))
    return new TextEncoder().encode(content).buffer
  })
  const asset = fixture(1).assets[0]
  expect(await Promise.all([loadAssetSvg(asset, 'ds'), loadAssetSvg(asset, 'ds'), loadAssetSvg(asset, 'ds')]))
    .toEqual([content, content, content])
  expect(mocks.invoke).toHaveBeenCalledTimes(1)
  content = '<svg>replacement</svg>'
  await expect(loadAssetSvg(asset, 'ds')).resolves.toBe(content)
  expect(mocks.invoke).toHaveBeenCalledTimes(2)
})

test('an appended temporary asset reads locally before its batch has synchronized', async () => {
  mocks.invoke.mockImplementation(async () => new TextEncoder().encode('<svg>unsaved addition</svg>').buffer)
  const asset = { ...fixture(1).assets[0], storagePath: 'temp-assets/new.svg' }
  await expect(loadAssetSvg(asset, 'ds')).resolves.toBe('<svg>unsaved addition</svg>')
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('load_temp_asset_svg', { path: asset.storagePath })
})

test('legacy local artwork without a saved file path is hydrated before it can be edited and saved', async () => {
  const record = fixture(3)
  record.assets[1].storagePath = ''
  mocks.invoke.mockImplementation(async (command, args) => command === 'load_batch'
    ? record : new TextEncoder().encode(`<svg>inline legacy ${args.assetId}</svg>`).buffer)
  const loaded = await loadHistoryBatch('ds')
  expect(loaded.assets[0].svg).toBe('')
  expect(loaded.assets[1].svg).toBe('<svg>inline legacy image-1</svg>')
  expect(loaded.assets[2].svg).toBe('')
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'load_batch_asset_svg'))
    .toEqual([['load_batch_asset_svg', { batchId: 'ds', assetId: 'image-1' }]])
})

test('cancelled queued thumbnails do not read old artwork after leaving the batch', async () => {
  const releases: Array<() => void> = []
  mocks.invoke.mockImplementation((_command, args) => new Promise(resolve => releases.push(() => resolve(new TextEncoder().encode(`<svg>${args.assetId}</svg>`).buffer))))
  const assets = fixture(3).assets
  const first = loadAssetSvg(assets[0], 'ds')
  const second = loadAssetSvg(assets[1], 'ds')
  const controller = new AbortController()
  const cancelled = loadAssetSvg(assets[2], 'ds', controller.signal)
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  await vi.waitFor(() => expect(releases).toHaveLength(2))
  releases.forEach(release => release())
  await Promise.all([first, second])
  await Promise.resolve()
  expect(mocks.invoke).toHaveBeenCalledTimes(2)
})

test('cancelling one preview does not cancel another consumer of the same original', async () => {
  let release!: () => void
  mocks.invoke.mockImplementation(() => new Promise(resolve => { release = () => resolve(new TextEncoder().encode('<svg>shared</svg>').buffer) }))
  const asset = fixture(1).assets[0]
  const controller = new AbortController()
  const preview = loadAssetSvg(asset, 'ds', controller.signal)
  const editor = loadAssetSvg(asset, 'ds')
  const rejected = expect(preview).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  release()
  await expect(editor).resolves.toBe('<svg>shared</svg>')
  expect(mocks.invoke).toHaveBeenCalledTimes(1)
})
