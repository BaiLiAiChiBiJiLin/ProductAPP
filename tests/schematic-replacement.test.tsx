import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { defaultLayoutBounds, type Asset, type Page } from '../src/model'
import { createReviewRecord } from '../src/modules/schematic-review/reviewRecords'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'
import { defaultBatchMetadata } from '../src/modules/schematic/types'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), importAssets: vi.fn(), discard: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
vi.mock('../src/modules/schematic/services/uploadService', () => ({ importAssets: mocks.importAssets }))
vi.mock('../src/modules/schematic/services/batchHistoryService', () => ({ discardTemporaryAssets: mocks.discard, loadHistoryBatch: vi.fn() }))
vi.mock('../src/modules/schematic/services/productConfigService', async original => ({ ...await original<typeof import('../src/modules/schematic/services/productConfigService')>(), loadProductConfigs: async () => [] }))
vi.mock('../src/modules/schematic/services/finishService', () => ({ loadFinishNames: async () => new Map() }))
vi.mock('../src/modules/schematic/hooks/useProductConfigs', () => ({ default: () => ({ products: [], loading: false, refreshing: false, refresh: vi.fn() }) }))
vi.mock('../src/modules/schematic/components/CustomProductForm', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/CorelDrawTool', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/history/BatchHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/ArrangePage', () => ({ default: (props: React.ComponentProps<typeof import('../src/modules/schematic/ArrangePage').default>) => <>
  {props.context}
  <output data-testid="canvas-state">{JSON.stringify({ assets: props.assets, pages: props.pages, selectedItem: props.selectedItem, sortMode: props.sortMode, dimensionDisplayOverrides: [...props.displayState.dimensionDisplayOverrides] })}</output>
  <button disabled={props.replacingArtwork} onClick={() => props.onReplaceArtwork?.('front')}>更换 Front</button>
  <button disabled={props.replacingArtwork} onClick={() => props.onReplaceArtwork?.('back')}>更换 Back</button>
  <button onClick={props.onBack}>返回图片列表</button>
  <button onClick={() => props.onAutoArrange('default')}>按产品顺序排列</button>
  <button onClick={() => props.onAutoArrange('upload')}>按上传顺序排列</button>
</> }))
vi.mock('../src/modules/schematic/components/LazySvgImage', () => ({ default: ({ alt }: { alt: string }) => <img alt={alt}/> }))
import SchematicPage from '../src/modules/schematic/SchematicPage'

const original: Asset = { id: 'old', name: '原图', productId: 'a', width: 10, height: 20, sourceGroupWidthMm: 10, sourceGroupHeightMm: 20, svg: '<svg>old</svg>', storagePath: 'temp-assets/old.svg', previewUrl: '', thumbnailUrl: '', attributes: { QT: '0' }, note: '保留备注' }
const replacement: Asset = { ...original, id: 'new', name: '新图', width: 30, height: 40, sourceGroupWidthMm: 30, sourceGroupHeightMm: 40, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 40"><image id="new-back-artwork" x="0" y="0" width="30" height="40" href="data:image/png;base64,AA=="/><image id="new-front-artwork" x="0" y="0" width="30" height="40" href="data:image/png;base64,AQ=="/></svg>', storagePath: 'temp-assets/new.svg', attributes: {}, note: '' }
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) })
  const computed = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element))
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.discard.mockResolvedValue(undefined)
  mocks.importAssets.mockResolvedValueOnce([original])
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'save_batch') return { batchId: args.id, assets: args.assets.map((asset: Asset) => ({ ...asset, storagePath: `assets/${asset.id}.svg` })) }
    throw new Error(`Unexpected command ${command}`)
  })
})
afterEach(cleanup)

async function openReplacement() {
  render(<SchematicPage/>)
  fireEvent.click(screen.getByRole('button', { name: /上传 SVG/ }))
  await screen.findByText('原图')
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存批次' }).disabled).toBe(false))
  fireEvent.contextMenu(screen.getByRole('button', { name: '预览 原图' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '更换图片' }))
}

test('replace updates the list and later batch persistence uses the new artwork with previous properties', async () => {
  mocks.importAssets.mockResolvedValueOnce([replacement])
  await openReplacement()
  await screen.findByText('新图')
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存批次' }).disabled).toBe(false))
  expect(screen.queryByText('原图')).toBeNull()
  expect(screen.getByText('真实尺寸：30.000 × 40.000 mm')).toBeTruthy()
  expect(screen.getByText('QT：0')).toBeTruthy()
  expect(screen.getByText('备注：保留备注')).toBeTruthy()
  expect(mocks.discard).toHaveBeenCalledExactlyOnceWith([original])
  expect(mocks.invoke).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '保存批次' }))
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('save_batch', expect.objectContaining({ assets: [expect.objectContaining({ id: 'new', storagePath: 'temp-assets/new.svg', svg: '', width: 30, height: 40, attributes: { QT: '0' }, note: '保留备注' })] })))
})

test('cancel or an SVG containing multiple imported pictures never replaces the existing card', async () => {
  mocks.importAssets.mockResolvedValueOnce([]).mockResolvedValueOnce([replacement, { ...replacement, id: 'extra' }])
  await openReplacement()
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存批次' }).disabled).toBe(false))
  expect(screen.getByText('原图')).toBeTruthy()
  expect(mocks.discard).not.toHaveBeenCalled()
  fireEvent.contextMenu(screen.getByRole('button', { name: '预览 原图' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '更换图片' }))
  await screen.findByText(/该 SVG 解析出了 2 张图片/)
  expect(screen.getByText('原图')).toBeTruthy()
  expect(screen.queryByText('新图')).toBeNull()
  expect(mocks.discard).toHaveBeenCalledWith([replacement, expect.objectContaining({ id: 'extra' })])
})

function mountArrangement() {
  const source: Asset = { ...original, productId: 'keychains', productName: 'Keychains', attributes: { ...original.attributes, 'Print Option': 'Double Sided Different Design' } }
  const front: Page['items'][number] = { id: 'front', assetId: source.id, x: 60, y: 170, w: 50, h: 100, rotation: 7, caption: 'Front', rulerWidth: true, rulerHeight: true, sizeAxis: 'height', rulerUnit: 'mm', rulerWidthRange: [0.15, 0.85], rulerHeightRange: [0.1, 0.9] }
  const page: Page = { id: 1, name: '页面 1', items: [front, { ...front, id: 'back', derivedFrom: front.id, caption: 'Back', x: 180, mirrorX: true, rulerWidth: false, backSvg: '<svg>old-back</svg>' }], imageGroups: [{ id: 'group', itemIds: ['front', 'back'], x: 10, y: 110, width: 250, height: 150, details: { size: '20.0 mm', qt: '0', finish: '' } }] }
  const display = emptyArrangementDisplayState()
  display.dimensionDisplayOverrides.set('front', { decimalPlaces: 2, precision: 'round' })
  display.dimensionDisplayOverrides.set('back', { decimalPlaces: 3, precision: 'truncate' })
  const record = createReviewRecord({ assets: [source], pages: [page], activePage: 1, metadata: defaultBatchMetadata, layoutBounds: defaultLayoutBounds, arrangementSort: 'default', defaultArrangementIds: [source.id] }, display, 'pdf', 'test.pdf')
  render(<SchematicPage initialRecord={record}/> )
  return { state: () => JSON.parse(screen.getByTestId('canvas-state').textContent!) as { assets: Asset[]; pages: Page[]; selectedItem: string | null; sortMode: 'default' | 'upload'; dimensionDisplayOverrides: typeof record.display.dimensionDisplayOverrides }, page, source }
}

test.each(['front', 'back'])('canvas %s replacement updates the one batch asset and both faces while preserving placement, rulers and precision', async id => {
  mocks.importAssets.mockReset().mockResolvedValueOnce([replacement])
  const current = mountArrangement()
  fireEvent.click(screen.getByRole('button', { name: id === 'front' ? '更换 Front' : '更换 Back' }))
  await waitFor(() => expect(current.state().pages[0].items.map(item => item.assetId)).toEqual(['new', 'new']))
  const result = current.state()
  expect(result.assets).toHaveLength(1)
  expect(result.assets[0]).toMatchObject({ id: 'new', svg: replacement.svg, productId: current.source.productId, productName: current.source.productName, attributes: current.source.attributes, note: original.note })
  for (const previous of current.page.items) {
    const next = result.pages[0].items.find(item => item.id === previous.id)!
    expect(next).toMatchObject({ id: previous.id, x: previous.x, y: previous.y, rotation: previous.rotation, caption: previous.caption, rulerUnit: previous.rulerUnit, rulerWidth: previous.rulerWidth, rulerHeight: previous.rulerHeight, sizeAxis: previous.sizeAxis, rulerWidthRange: previous.rulerWidthRange, rulerHeightRange: previous.rulerHeightRange })
    expect(next.w / next.h).toBeCloseTo(replacement.width / replacement.height)
    expect(next.arrangementSourceAssetId).not.toBe('old')
  }
  const back = result.pages[0].items.find(item => item.id === 'back')!
  expect(back).toMatchObject({ derivedFrom: 'front', mirrorX: true })
  expect(back.backSvg).toContain('new-back-artwork')
  expect(back.backSvg).not.toContain('new-front-artwork')
  expect(back.backSvg).not.toContain('old-back')
  expect(result.pages[0].imageGroups?.[0].details?.size).toBe('40.00 mm')
  expect(result.dimensionDisplayOverrides).toEqual([['front', { decimalPlaces: 2, precision: 'round' }], ['back', { decimalPlaces: 3, precision: 'truncate' }]])
  expect(result.selectedItem).toBe(id)
  await waitFor(() => expect(mocks.discard).toHaveBeenCalledExactlyOnceWith([current.source]))
  expect(mocks.invoke).not.toHaveBeenCalled()
})

test('returning to the image list after a canvas replacement shows and saves only the replacement with its previous business properties', async () => {
  mocks.importAssets.mockReset().mockResolvedValueOnce([replacement])
  const current = mountArrangement()
  fireEvent.click(screen.getByRole('button', { name: '更换 Back' }))
  await waitFor(() => expect(current.state().assets.map(asset => asset.id)).toEqual(['new']))
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '更换 Back' }).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '返回图片列表' }))
  fireEvent.click(screen.getByRole('button', { name: /^Keychains/ }))
  expect(await screen.findByRole('button', { name: '预览 新图' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '预览 原图' })).toBeNull()
  expect(screen.getByText('共 1 张')).toBeTruthy()
  expect(screen.getByText('真实尺寸：30.000 × 40.000 mm')).toBeTruthy()
  expect(screen.getByText('QT：0')).toBeTruthy()
  expect(screen.getByText('备注：保留备注')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '保存批次' }))
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('save_batch', expect.objectContaining({ assets: [expect.objectContaining({ id: 'new', storagePath: 'temp-assets/new.svg', svg: '', width: 30, height: 40, productId: current.source.productId, productName: current.source.productName, attributes: current.source.attributes, note: original.note })] })))
})

test('switching arrangement order repeatedly keeps both replacement faces without restoring or duplicating the old source', async () => {
  mocks.importAssets.mockReset().mockResolvedValueOnce([replacement])
  const current = mountArrangement()
  fireEvent.click(screen.getByRole('button', { name: '更换 Back' }))
  await waitFor(() => expect(current.state().assets.map(asset => asset.id)).toEqual(['new']))
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '更换 Back' }).disabled).toBe(false))
  for (const mode of ['upload', 'default', 'upload', 'default'] as const) {
    fireEvent.click(screen.getByRole('button', { name: mode === 'upload' ? '按上传顺序排列' : '按产品顺序排列' }))
    await waitFor(() => expect(current.state().sortMode).toBe(mode))
    const result = current.state()
    expect(result.assets.map(asset => asset.id)).toEqual(['new'])
    const items = result.pages.flatMap(page => page.items)
    expect(items).toHaveLength(2)
    expect(items.map(item => item.assetId)).toEqual(['new', 'new'])
    expect(items.every(item => item.arrangementSourceAssetId !== 'old')).toBe(true)
    const front = items.find(item => item.caption === 'Front')!
    const back = items.find(item => item.caption === 'Back')!
    expect(front).toBeTruthy()
    expect(back.derivedFrom).toBe(front.id)
    expect(back.backSvg).toContain('new-back-artwork')
    expect(back.backSvg).not.toContain('new-front-artwork')
  }
})

test('cancelling a canvas replacement leaves the complete arrangement untouched', async () => {
  mocks.importAssets.mockReset().mockResolvedValueOnce([])
  const current = mountArrangement()
  const before = current.state()
  fireEvent.click(screen.getByRole('button', { name: '更换 Back' }))
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '更换 Back' }).disabled).toBe(false))
  expect(current.state()).toEqual(before)
  expect(mocks.discard).not.toHaveBeenCalled()
})
