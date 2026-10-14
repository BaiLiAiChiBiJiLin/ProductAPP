import { beforeEach, expect, test, vi } from 'vitest'
import type { Asset } from '../src/model'

const mocks = vi.hoisted(() => ({ importAssets: vi.fn(), discardTemporaryAssets: vi.fn() }))
vi.mock('../src/modules/schematic/services/uploadService', () => ({ importAssets: mocks.importAssets }))
vi.mock('../src/modules/schematic/services/batchHistoryService', () => ({ discardTemporaryAssets: mocks.discardTemporaryAssets }))
import { importReplacementAsset, replaceAssetArtwork, replaceSelectedAssetId } from '../src/modules/schematic/services/assetReplacementService'

const asset = (id: string, fields: Partial<Asset> = {}): Asset => ({
  id, name: `${id}.svg`, productId: 'a', width: 96, height: 192,
  svg: `<svg id="${id}"/>`, previewUrl: '', thumbnailUrl: '',
  storagePath: `D:/printflow-data/temp-assets/${id}.svg`, ...fields,
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.discardTemporaryAssets.mockResolvedValue(undefined)
})

test('cancelling the SVG picker returns no replacement and performs no file cleanup', async () => {
  mocks.importAssets.mockResolvedValue([])
  expect(await importReplacementAsset()).toBeNull()
  expect(mocks.discardTemporaryAssets).not.toHaveBeenCalled()
})

test('one parsed asset uses the normal importer, forwards its progress, and retains its temporary original', async () => {
  const replacement = asset('new')
  const progress = vi.fn()
  const phase = { phase: 'generate', completed: 1, total: 1 }
  mocks.importAssets.mockImplementation(async (onProgress, onAssets) => {
    onProgress(phase)
    onAssets([replacement])
    return [replacement]
  })
  expect(await importReplacementAsset(progress)).toBe(replacement)
  expect(mocks.importAssets).toHaveBeenCalledWith(progress, expect.any(Function))
  expect(progress).toHaveBeenCalledWith(phase)
  expect(mocks.discardTemporaryAssets).not.toHaveBeenCalled()
})

test('a multi-artwork SVG is rejected and all parsed temporary resources are discarded once', async () => {
  const first = asset('one'), second = asset('two')
  mocks.importAssets.mockImplementation(async (_progress, onAssets) => {
    onAssets([first])
    return [first, second]
  })
  await expect(importReplacementAsset()).rejects.toThrow('解析出了 2 张图片')
  expect(mocks.discardTemporaryAssets).toHaveBeenCalledExactlyOnceWith([first, second])
})

test('an import error discards already streamed resources without masking the original error', async () => {
  const first = asset('partial')
  const failure = new Error('SVG 解析失败')
  mocks.importAssets.mockImplementation(async (_progress, onAssets) => {
    onAssets([first])
    onAssets([first])
    throw failure
  })
  mocks.discardTemporaryAssets.mockRejectedValue(new Error('清理失败'))
  await expect(importReplacementAsset()).rejects.toBe(failure)
  expect(mocks.discardTemporaryAssets).toHaveBeenCalledExactlyOnceWith([first])
})

test('replacement updates artwork metadata and keeps business attributes, group order and other assets intact', () => {
  const before = asset('before')
  const original = asset('old', {
    productId: 'custom:7', productName: 'Shaker',
    attributes: { QT: '0', Size: '50mm', 'Print Option': 'Double Sided' },
    attributeImages: { 'Accessories Color': 'https://example.test/red.png' },
    note: '保留备注', noteImage: 'data:image/png;base64,old-note',
    attributesConfirmed: true, finishMatchDisabled: true,
    productGroupId: 'group', productGroupColor: '#abcdff', productGroupMode: 'free',
    productGroupLeaderId: 'before', productGroupPosition: 3,
  })
  const after = asset('after')
  const replacement = asset('new', {
    name: '新图 · layer-2', sourceFileName: '新图.svg', svg: '<svg width="5mm"/>',
    previewUrl: 'new-preview', thumbnailUrl: 'new-thumbnail',
    width: 20, height: 40, sourceGroupWidthMm: 5.123, sourceGroupHeightMm: 10.246,
    sourceGroupBounds: [10, 30, 20, 40],
    sourceImages: [{ nodeId: 'image1', widthPx: 200, heightPx: 400, widthMm: 5.123, heightMm: 10.246, format: 'png' }],
    modeUsed: 'groups', mergeStatus: 'merged', sourceGroupId: 'layer-2',
  })
  const input = [before, original, after]
  const output = replaceAssetArtwork(input, original.id, replacement)
  expect(output.map(item => item.id)).toEqual(['before', 'new', 'after'])
  expect(output[0]).toBe(before)
  expect(output[2]).toBe(after)
  expect(output[1]).toEqual({
    ...replacement,
    productId: original.productId, productName: original.productName,
    attributes: original.attributes, attributeImages: original.attributeImages,
    note: original.note, noteImage: original.noteImage,
    attributesConfirmed: true, finishMatchDisabled: true,
    productGroupId: 'group', productGroupColor: '#abcdff', productGroupMode: 'free',
    productGroupLeaderId: 'before', productGroupPosition: 3,
  })
  expect(input[1]).toBe(original)
  expect(original.id).toBe('old')
  expect(original.svg).toBe('<svg id="old"/>')
})

test('replacing a group leader remaps every follower while leaving other groups unchanged', () => {
  const leader = asset('old', { productGroupId: 'g', productGroupLeaderId: 'old', productGroupPosition: 1 })
  const follower = asset('follower', { productGroupId: 'g', productGroupLeaderId: 'old', productGroupPosition: 2 })
  const unrelated = asset('other', { productGroupId: 'h', productGroupLeaderId: 'other', productGroupPosition: 1 })
  const output = replaceAssetArtwork([leader, follower, unrelated], 'old', asset('new'))
  expect(output.map(item => item.productGroupLeaderId)).toEqual(['new', 'new', 'other'])
  expect(output.map(item => item.productGroupPosition)).toEqual([1, 2, 1])
  expect(output[2]).toBe(unrelated)
  expect(follower.productGroupLeaderId).toBe('old')
})

test('absent measurement and source fields in new artwork clear stale metadata from the old image', () => {
  const original = asset('old', {
    sourceFileName: 'old.svg', sourceGroupWidthMm: 500, sourceGroupHeightMm: 600,
    sourceGroupBounds: [1, 2, 500, 600],
    sourceImages: [{ nodeId: 'stale', widthPx: 5000, heightPx: 6000, format: 'png' }],
    sourceGroupId: 'old-layer', mergeStatus: 'merged', modeUsed: 'groups',
  })
  const output = replaceAssetArtwork([original], 'old', asset('new'))[0]
  for (const key of ['sourceFileName', 'sourceGroupWidthMm', 'sourceGroupHeightMm', 'sourceGroupBounds', 'sourceImages', 'sourceGroupId', 'mergeStatus', 'modeUsed']) {
    expect(output[key as keyof Asset]).toBeUndefined()
  }
})

test('a missing target or duplicate replacement ID cannot modify the batch', () => {
  const original = asset('original'), other = asset('other')
  const input = [original, other]
  expect(() => replaceAssetArtwork(input, 'removed', asset('new'))).toThrow('已不在当前批次')
  for (const id of ['', 'original', 'other']) {
    expect(() => replaceAssetArtwork(input, 'original', asset(id))).toThrow('资源 ID 与当前批次冲突')
  }
  expect(input).toEqual([original, other])
})

test('selected replacement keeps selection order and does not select an unselected image', () => {
  const selected = new Set(['before', 'old', 'after'])
  expect([...replaceSelectedAssetId(selected, 'old', 'new')]).toEqual(['before', 'new', 'after'])
  expect([...selected]).toEqual(['before', 'old', 'after'])
  expect(replaceSelectedAssetId(selected, 'unselected', 'new')).toBe(selected)
})
