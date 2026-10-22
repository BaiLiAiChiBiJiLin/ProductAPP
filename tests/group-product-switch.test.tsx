import { useState } from 'react'
import { ConfigProvider } from 'antd'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Asset } from '../src/model'
import ProductAttributesPanel from '../src/modules/schematic/components/ProductAttributesPanel'
import { ProductGroupingContext, useProductGrouping } from '../src/modules/schematic/grouping/useProductGrouping'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService'
import type { CustomProduct } from '../src/modules/schematic/services/customProductService'

vi.mock('../src/modules/schematic/hooks/useProductConfigs', () => ({
  default: () => ({ products, loading: false, error: '', refreshing: false, refresh: vi.fn() }),
}))
vi.mock('../src/modules/schematic/services/customProductService', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/schematic/services/customProductService')>(),
  listCustomProducts: async () => [{ id: 7, name: 'Custom Shaker' }, { id: 9, name: 'Custom Shaker Deluxe' }],
  loadCustomProductConfig: async () => ({ id: 'custom', title: '自定义产品', options: [] }),
  saveCustomProduct: async (product: CustomProduct) => ({ ...product, id: product.id ?? 8 }),
}))
vi.mock('../src/modules/schematic/components/AssetNotesEditor', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/LazySvgImage', () => ({ default: ({ alt }: { alt: string }) => <img alt={alt}/> }))

const products = normalizeProductConfigs([
  { productId: 'keychain', title: 'Clear Acrylic Keychains', productOptions: [{ name: 'Size', labelZh: '尺寸', values: ['small', 'large'] }] },
  { productId: 'standees', title: 'Clear Acrylic Standees', productOptions: [
    { name: 'Count', labelZh: '立牌数量', values: ['1', '2'] },
    { name: 'Size', labelZh: '尺寸', values: ['small', 'large'] },
  ] },
])

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: false, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function savedAssets(): Asset[] {
  return ['a', 'b', 'c'].map((id, index) => ({
    id, name: `${id}.svg`, svg: '<svg/>', width: 20, height: 30, previewUrl: '', thumbnailUrl: '',
    productId: 'custom:7', productName: 'Custom Shaker', attributesConfirmed: true,
    attributes: { Size: 'old-size', 'Accessories Color': 'old-color', QT: ['3', '0', ''][index] },
    attributeImages: { 'Accessories Color': `${id}-accessory.png` },
    note: `${id}-note`, noteImages: [{ src: `${id}-note.png`, name: id }],
    productGroupId: 'saved-group', productGroupLeaderId: 'a', productGroupColor: '#d9f7be',
    productGroupPosition: [2, 1, 3][index],
  }))
}

function mount(initial: Asset[], selectedIds = ['b']) {
  const save = vi.fn<(assets: Asset[]) => void>()
  const confirmAttributes = vi.fn(async () => {})
  function Harness() {
    const [assets, setAssets] = useState(initial)
    const [selectedAssetIds, setSelectedAssetIds] = useState(new Set(selectedIds))
    const grouping = useProductGrouping({
      assets, products, revealAll: () => {},
      activate: id => setSelectedAssetIds(new Set(id ? [id] : [])),
      save: async next => {
        const saved = JSON.parse(JSON.stringify(next)) as Asset[]
        save(saved)
        setAssets(saved)
      },
    })
    return <ProductGroupingContext.Provider value={grouping}>
      <ProductAttributesPanel assets={assets} selectedAssetIds={selectedAssetIds} onConfirmAttributes={confirmAttributes}/>
    </ProductGroupingContext.Provider>
  }
  render(<ConfigProvider theme={{ token: { motion: false } }}><Harness/></ConfigProvider>)
  return { save, confirmAttributes }
}

async function ready() {
  await waitFor(() => expect(screen.queryByText('正在加载自定义产品…')).toBeNull())
}
const input = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement
const groupOrder = () => screen.getAllByRole('button', { name: /^编辑组内图片 / }).map(button => button.getAttribute('aria-label'))
async function choose(name: string, label: string) {
  fireEvent.mouseDown(input(name))
  const option = await waitFor(() => {
    const node = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option'))
      .find(element => element.getAttribute('title') === label)
    expect(node).toBeTruthy()
    return node!
  })
  fireEvent.click(option)
}
async function chooseCatalogProduct() {
  fireEvent.click(screen.getByRole('tab', { name: '已有产品' }))
  await choose('产品', 'Clear Acrylic Keychains')
}

test('reopening a saved Shaker on a follower lets its product switch update the whole group', async () => {
  const original = savedAssets()
  const { save, confirmAttributes } = mount(original)
  await ready()
  expect(input('自定义产品').disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '编辑组合' }))

  expect(screen.getByRole('button', { name: '编辑组内图片 b.svg' }).getAttribute('aria-pressed')).toBe('true')
  expect(input('自定义产品').value).toBe('Custom Shaker')
  expect(input('自定义产品').disabled).toBe(false)
  expect(screen.getByRole('tab', { name: '已有产品' }).getAttribute('aria-disabled')).not.toBe('true')
  const order = groupOrder()
  expect(order).toEqual(['编辑组内图片 b.svg', '编辑组内图片 a.svg', '编辑组内图片 c.svg'])

  await chooseCatalogProduct()
  expect(input('产品').disabled).toBe(false)
  expect(groupOrder()).toEqual(order)
  expect(screen.queryByText('Example', { exact: true })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  const saved = save.mock.calls[0][0]
  expect(confirmAttributes).not.toHaveBeenCalled()
  expect(saved.map(asset => asset.productId)).toEqual(['keychain', 'keychain', 'keychain'])
  expect(saved.map(asset => asset.productName)).toEqual(Array(3).fill('Clear Acrylic Keychains'))
  expect(saved.map(asset => asset.attributes?.QT ?? '')).toEqual(['3', '0', ''])
  for (const [index, asset] of saved.entries()) {
    expect(asset.attributes?.Size).toBeUndefined()
    expect(asset.attributes?.['Accessories Color']).toBeUndefined()
    expect(asset.attributeImages).toEqual({})
    expect(asset.note).toBe(original[index].note)
    expect(asset.noteImages).toEqual(original[index].noteImages)
    expect(asset.productGroupId).toBe(original[index].productGroupId)
    expect(asset.productGroupLeaderId).toBe(original[index].productGroupLeaderId)
    expect(asset.productGroupColor).toBe(original[index].productGroupColor)
    expect(asset.productGroupPosition).toBe(original[index].productGroupPosition)
  }
  fireEvent.click(screen.getByRole('button', { name: '编辑组合' }))
  expect(groupOrder()).toEqual(order)
  expect(input('产品').closest('.ant-select')?.textContent).toContain('Clear Acrylic Keychains')
})

test('a saved standee follower can switch product while shared count stays locked and QT stays independent', async () => {
  mount(savedAssets().map(asset => ({ ...asset, productId: 'standees', productName: 'Clear Acrylic Standees', attributes: { Count: '2', Size: 'small', QT: asset.attributes!.QT } })))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '编辑组合' }))
  expect(input('产品').disabled).toBe(false)
  expect(screen.getByRole('tab', { name: '自定义' }).getAttribute('aria-disabled')).not.toBe('true')
  expect(input('立牌数量').disabled).toBe(true)
  expect(input('尺寸').disabled).toBe(false)
  expect((screen.getByRole('spinbutton', { name: 'QT（数量）' }) as HTMLInputElement).disabled).toBe(false)
  expect((screen.getByRole('spinbutton', { name: 'QT（数量）' }) as HTMLInputElement).value).toBe('0')

  fireEvent.click(screen.getByRole('button', { name: '编辑组内图片 a.svg' }))
  expect(input('立牌数量').disabled).toBe(false)
})

test('a newly started Shaker guide still locks the follower product and tabs', async () => {
  const initial = savedAssets().map(asset => ({ ...asset, productGroupId: '', productGroupLeaderId: '', attributesConfirmed: false }))
  mount(initial, ['a', 'b', 'c'])
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '图片组合' }))
  fireEvent.click(screen.getByRole('button', { name: '编辑组内图片 b.svg' }))
  expect(input('自定义产品').disabled).toBe(true)
  expect(screen.getByRole('tab', { name: '已有产品' }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('tab', { name: '自定义' }).getAttribute('aria-disabled')).toBe('true')
  expect((screen.getByRole('spinbutton', { name: '自定义QT（数量）' }) as HTMLInputElement).disabled).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: '编辑组内图片 a.svg' }))
  expect(input('自定义产品').disabled).toBe(false)
})

test('selecting another custom preset from a saved follower clears the previous product attributes', async () => {
  const original = savedAssets()
  const { save } = mount(original)
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '编辑组合' }))
  // Select directly so both AutoComplete callbacks see the same original draft.
  // Typing first would clear the stale attributes before the preset is selected.
  await choose('自定义产品', 'Custom Shaker Deluxe')
  expect(input('自定义产品').value).toBe('Custom Shaker Deluxe')
  fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  const saved = save.mock.calls[0][0]
  expect(saved.map(asset => asset.productId)).toEqual(['custom:9', 'custom:9', 'custom:9'])
  expect(saved.map(asset => asset.productName)).toEqual(Array(3).fill('Custom Shaker Deluxe'))
  expect(saved.map(asset => asset.attributes?.QT ?? '')).toEqual(['3', '0', ''])
  for (const [index, asset] of saved.entries()) {
    expect(asset.attributes?.Size).toBeUndefined()
    expect(asset.attributes?.['Accessories Color']).toBeUndefined()
    expect(asset.attributeImages).toEqual({})
    expect(asset.note).toBe(original[index].note)
    expect(asset.noteImages).toEqual(original[index].noteImages)
    expect(asset.productGroupPosition).toBe(original[index].productGroupPosition)
    expect(asset.productGroupColor).toBe(original[index].productGroupColor)
  }
})

test('switching a restored free group follower changes only that member product', async () => {
  const original = savedAssets().map(asset => ({ ...asset, productGroupMode: 'free' as const }))
  const { save } = mount(original)
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '编辑组合' }))
  await chooseCatalogProduct()
  fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))

  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  const saved = save.mock.calls[0][0]
  expect(saved.map(asset => asset.productId)).toEqual(['custom:7', 'keychain', 'custom:7'])
  expect(saved.map(asset => asset.productName)).toEqual(['Custom Shaker', 'Clear Acrylic Keychains', 'Custom Shaker'])
  expect(saved.map(asset => asset.productGroupMode)).toEqual(['free', 'free', 'free'])
  expect(saved.map(asset => asset.productGroupPosition)).toEqual(original.map(asset => asset.productGroupPosition))
  expect(saved.map(asset => asset.note)).toEqual(original.map(asset => asset.note))
})

test('confirming one image does not carry its product or options into the next blank image', async () => {
  const first = { ...savedAssets()[0], productGroupId: '', productId: 'keychain', attributes: { Size: 'small', QT: '7' } }
  const blank = { ...first, id: 'blank', productId: 'a', attributes: {}, attributeImages: {} }
  const saved = { ...first, id: 'saved', attributes: { Size: 'large', QT: '2' } }
  const assets = [first, blank, saved]
  const confirm = vi.fn(async () => {})
  const panel = (id: string) => <ConfigProvider theme={{ token: { motion: false } }}><ProductAttributesPanel allowGrouping={false} assets={assets} selectedAssetIds={new Set([id])} onConfirmAttributes={confirm}/></ConfigProvider>
  const { rerender } = render(panel(first.id))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
  rerender(panel(blank.id))
  expect(input('产品').closest('.ant-select')?.textContent).not.toContain('Clear Acrylic Keychains')
  expect(screen.queryByRole('combobox', { name: '尺寸' })).toBeNull()
  expect((screen.getByRole('spinbutton', { name: 'QT（数量）' }) as HTMLInputElement).value).toBe('')
  await choose('产品', 'Clear Acrylic Keychains')
  expect(input('尺寸').closest('.ant-select')?.textContent).not.toContain('small')
  rerender(panel(saved.id))
  expect(input('尺寸').closest('.ant-select')?.textContent).toContain('large')
  expect((screen.getByRole('spinbutton', { name: 'QT（数量）' }) as HTMLInputElement).value).toBe('2')
})

test('moving from a custom product to a blank image clears the inactive custom editor too', async () => {
  const first = { ...savedAssets()[0], productGroupId: '' }
  const blank = { ...first, id: 'blank', productId: '', attributes: {}, attributeImages: {} }
  const assets = [first, blank]
  const panel = (id: string) => <ProductAttributesPanel allowGrouping={false} assets={assets} selectedAssetIds={new Set([id])} onConfirmAttributes={async () => {}}/>
  const { rerender } = render(panel(first.id))
  await ready()
  expect(input('自定义产品').value).toBe('Custom Shaker')
  rerender(panel(blank.id))
  fireEvent.click(screen.getByRole('tab', { name: '自定义' }))
  expect(input('自定义产品').value).toBe('')
  expect((screen.getByRole('spinbutton', { name: '自定义QT（数量）' }) as HTMLInputElement).value).toBe('1')
})

test('switching an ungrouped custom product clears the previous product options on confirmation', async () => {
  const first = { ...savedAssets()[0], productGroupId: '' }
  const confirm = vi.fn(async (_patch: unknown) => {})
  render(<ProductAttributesPanel allowGrouping={false} assets={[first]} selectedAssetIds={new Set([first.id])} onConfirmAttributes={confirm}/>)
  await ready()
  await choose('自定义产品', 'Custom Shaker Deluxe')
  fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
  expect(confirm.mock.calls[0][0]).toMatchObject({ productId: 'custom:9', attributes: { QT: '1' }, attributeImages: {}, note: first.note })
  expect((confirm.mock.calls[0][0] as { attributes: object }).attributes).toEqual({ QT: '1' })
})
