import { beforeEach, expect, test, vi } from 'vitest'
import type { Asset } from '../src/model'
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
import { discardTemporaryAssets, loadHistoryBatch, type BatchRecord } from '../src/modules/schematic/services/batchHistoryService'

const fixture = (count: number): BatchRecord => ({ id: 'ds', savedAt: '2026-10-07', metadata: { customerName: 'ds', drawingDate: '', estimatedShipDate: '', designer: '设计师' }, assets: Array.from({ length: count }, (_, index): Asset => ({ id: `image-${index}`, name: `原图-${index}`, productId: 'a', width: 42.789, height: 59.789, svg: '', previewUrl: '', thumbnailUrl: '', note: '保留备注', productGroupId: '组1' })) })
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

test('84-image history loads one original at a time and keeps exact metadata and image order', async () => {
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
  expect(peak).toBe(1)
  expect(loaded.metadata).toEqual(original.metadata)
  expect(loaded.assets).toEqual(original.assets.map(asset => ({ ...asset, svg: `<svg>原图 Ω ${asset.id}</svg>` })))
  expect(original.assets.every(asset => asset.svg === '')).toBe(true)
  expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual(Array.from({ length: 85 }, (_, completed) => ({ completed, total: 84 })))
})

test('a missing image aborts the load instead of returning a partial editable batch', async () => {
  const onProgress = vi.fn()
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'load_batch') return fixture(3)
    if (args.assetId === 'image-1') throw new Error('原始文件不存在')
    return new TextEncoder().encode('<svg/>').buffer
  })
  await expect(loadHistoryBatch('ds', onProgress)).rejects.toThrow('无法加载 原图-1')
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'load_batch_asset_svg')).toHaveLength(2)
  expect(onProgress).toHaveBeenLastCalledWith({ completed: 1, total: 3 })
})

test('empty or invalid UTF-8 image content is reported as an image loading error', async () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([0xff])]) {
    mocks.invoke.mockImplementation(async command => command === 'load_batch' ? fixture(1) : bytes.buffer)
    await expect(loadHistoryBatch('ds')).rejects.toThrow('无法加载 原图-0')
  }
})
