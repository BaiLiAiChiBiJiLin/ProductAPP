import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { defaultLayoutBounds, type Asset } from '../src/model'
import { createReviewRecord } from '../src/modules/schematic-review/reviewRecords'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'
import { defaultBatchMetadata } from '../src/modules/schematic/types'
import type { ProductConfig } from '../src/modules/schematic/services/productConfigService'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), local: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
vi.mock('../src/modules/schematic/services/productConfigService', async original => ({ ...await original<object>(), loadProductConfigs: mocks.local }))
vi.mock('../src/modules/schematic/services/finishService', () => ({ loadFinishNames: async () => new Map() }))
vi.mock('../src/modules/schematic/components/UploadPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/ProductCategoryNav', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/history/BatchHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/UploadImageList', () => ({ default: ({ products }: { products: ProductConfig[] }) => <output data-testid="catalog">{JSON.stringify(products)}</output> }))
vi.mock('../src/modules/schematic/ArrangePage', () => ({ default: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>返回图片列表</button> }))

import SchematicPage from '../src/modules/schematic/SchematicPage'
import { loadPublicProductConfigs, refreshPublicProductConfigs } from '../src/modules/schematic/services/publicProductOptionService'

const source: Asset = { id: 'one', name: 'one.svg', productId: 'public:P31', productName: '公共产品', width: 20, height: 30, svg: '<svg/>', previewUrl: '', thumbnailUrl: '' }
let publicTitle = '公共产品'
beforeEach(async () => {
  vi.clearAllMocks()
  publicTitle = '公共产品'
  mocks.local.mockResolvedValue([{ id: 'local', title: '已有产品', options: [] }])
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'load_public_product_options') return JSON.stringify({ categories: [{ products: [{ productId: 'P31', titleZh: publicTitle, options: [] }] }] })
    if (command === 'refresh_public_product_options') return undefined
    throw new Error(`Unexpected command: ${command}`)
  })
  await loadPublicProductConfigs(true)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mountList() {
  const record = createReviewRecord({ assets: [source], pages: [], activePage: 1, metadata: defaultBatchMetadata, layoutBounds: defaultLayoutBounds, arrangementSort: 'default', defaultArrangementIds: [source.id] }, emptyArrangementDisplayState(), 'pdf', 'test.pdf')
  render(<SchematicPage initialRecord={record}/>)
  fireEvent.click(screen.getByRole('button', { name: '返回图片列表' }))
}
const catalog = () => JSON.parse(screen.getByTestId('catalog').textContent!) as ProductConfig[]

test('public catalog reaches schematic image attributes even when the existing catalog fails', async () => {
  mocks.local.mockRejectedValue(new Error('Local cache unavailable'))
  mountList()
  await waitFor(() => expect(catalog().map(product => product.id)).toEqual(['public:P31']))
})

test('refreshing public products updates the schematic catalog without recursively reloading', async () => {
  mountList()
  await waitFor(() => expect(catalog().map(product => product.title)).toEqual(['已有产品', '公共产品']))
  const priorReads = mocks.invoke.mock.calls.filter(([command]) => command === 'load_public_product_options').length
  publicTitle = '更新后的公共产品'
  await act(async () => { await refreshPublicProductConfigs() })
  await waitFor(() => expect(catalog().map(product => product.title)).toEqual(['已有产品', '更新后的公共产品']))
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'load_public_product_options')).toHaveLength(priorReads + 1)
})
