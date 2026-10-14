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
  <output data-testid="canvas-state">{JSON.stringify({ assets: props.assets, pages: props.pages })}</output>
  <button disabled={props.replacingArtwork} onClick={() => props.onReplaceArtwork?.('front')}>更换 Front</button>
  <button disabled={props.replacingArtwork} onClick={() => props.onReplaceArtwork?.('back')}>更换 Back</button>
</> }))
vi.mock('../src/modules/schematic/components/LazySvgImage', () => ({ default: ({ alt }: { alt: string }) => <img alt={alt}/> }))
import SchematicPage from '../src/modules/schematic/SchematicPage'

const original: Asset = { id: 'old', name: '原图', productId: 'a', width: 10, height: 20, sourceGroupWidthMm: 10, sourceGroupHeightMm: 20, svg: '<svg>old</svg>', storagePath: 'temp-assets/old.svg', previewUrl: '', thumbnailUrl: '', attributes: { QT: '0' }, note: '保留备注' }
const replacement: Asset = { ...original, id: 'new', name: '新图', width: 30, height: 40, sourceGroupWidthMm: 30, sourceGroupHeightMm: 40, svg: '<svg>new</svg>', storagePath: 'temp-assets/new.svg', attributes: {}, note: '' }
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
  const front = { id: 'front', assetId: original.id, x: 60, y: 170, w: 50, h: 100, rotation: 0, caption: 'Front' }
  const page: Page = { id: 1, name: '页面 1', items: [front, { ...front, id: 'back', derivedFrom: front.id, caption: 'Back', x: 180, backSvg: '<svg>old-back</svg>' }], imageGroups: [{ id: 'group', itemIds: ['front', 'back'], x: 10, y: 110, width: 250, height: 150, details: { size: '20.0 mm', qt: '1', finish: '' } }] }
  const display = emptyArrangementDisplayState()
  display.dimensionDisplayOverrides.set('front', { decimalPlaces: 2, precision: 'round' })
  const record = createReviewRecord({ assets: [original], pages: [page], activePage: 1, metadata: defaultBatchMetadata, layoutBounds: defaultLayoutBounds, arrangementSort: 'default', defaultArrangementIds: [original.id] }, display, 'pdf', 'test.pdf')
  render(<SchematicPage initialRecord={record}/> )
  return { state: () => JSON.parse(screen.getByTestId('canvas-state').textContent!) as { assets: Asset[]; pages: Page[] }, page }
}

test.each(['front', 'back'])('canvas %s replacement reuses the importer, keeps the other instance and saved decimal precision', async id => {
  mocks.importAssets.mockReset().mockResolvedValueOnce([replacement])
  const current = mountArrangement()
  fireEvent.click(screen.getByRole('button', { name: id === 'front' ? '更换 Front' : '更换 Back' }))
  await waitFor(() => expect(current.state().pages[0].items.find(item => item.id === id)?.assetId).toBe('new'))
  const result = current.state()
  expect(result.assets).toHaveLength(2)
  expect(result.assets[1]).toMatchObject({ id: 'new', attributes: original.attributes, note: original.note })
  expect(result.pages[0].items.find(item => item.id !== id)).toEqual(current.page.items.find(item => item.id !== id))
  expect(result.pages[0].imageGroups?.[0].details?.size).toBe(id === 'front' ? '40.00 mm' : '20.0 mm')
  expect(mocks.discard).not.toHaveBeenCalled()
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
