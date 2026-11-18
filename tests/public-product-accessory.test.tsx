import { ConfigProvider } from 'antd'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Asset } from '../src/model'
import ProductAttributesPanel from '../src/modules/schematic/components/ProductAttributesPanel'
import { normalizePublicProductOptions } from '../src/modules/schematic/services/publicProductOptionService'
import { applyProductAttributePatch, type ProductAttributePatch } from '../src/modules/schematic/services/productOptionRules'

vi.mock('../src/modules/schematic/hooks/useProductConfigs', () => ({
  default: () => ({ products: [], loading: false, error: '', refreshing: false, refresh: vi.fn() }),
}))
vi.mock('../src/modules/schematic/hooks/usePublicProductConfigs', () => ({
  default: () => ({ products: publicProducts, loading: false, error: '', refreshing: false, refresh: vi.fn() }),
}))
vi.mock('../src/modules/schematic/components/CustomProductForm', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/AssetNotesEditor', () => ({ default: () => null }))

// The public endpoint nests colors under each style instead of providing a
// separate linked option. Exercise the actual adapter and editor together.
const publicProducts = normalizePublicProductOptions({
  success: true,
  categories: [{ name: 'keychains', titleZh: '钥匙扣', products: [{
    productId: 'P31', title: 'Clear Acrylic Keychains', titleZh: '透明亚克力钥匙扣',
    options: [{ name: 'Accessories Style', labelZh: '配件样式', values: [
      { valueId: 'P8', name: 'U style', labelZh: 'U形扣', image: 'u-style.jpg', colors: [
        { valueId: 'P-C1', name: 'U style-24', labelZh: 'U形扣-24', image: 'u-24.png' },
        { valueId: 'P-C2', name: 'U style-25', labelZh: 'U形扣-25', image: 'u-25.png' },
      ] },
      { valueId: 'P9', name: 'Star Hook Clasp', labelZh: '星形扣', image: 'star-style.jpg', colors: [
        { valueId: 'P-C29', name: 'Star Hook Clasp-41', labelZh: '星形扣-41', image: 'star-41.png' },
      ] },
    ] }],
  }] }, { name: 'stickers', titleZh: '贴纸', products: [{ productId: 'P1', titleZh: '透明贴纸', options: [] }] }],
  uncategorizedProducts: [{ productId: 'P99', titleZh: '其他产品', options: [] }],
})

const asset: Asset = { id: 'one', name: 'one.svg', productId: '', width: 40, height: 60,
  svg: '<svg/>', previewUrl: '', thumbnailUrl: '', attributes: {}, attributeImages: {} }

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: false, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  const getComputedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount(source = asset) {
  const confirm = vi.fn(async (_patch: ProductAttributePatch) => {})
  const rendered = render(<ConfigProvider theme={{ token: { motion: false } }}><ProductAttributesPanel
    allowGrouping={false} assets={[source]} selectedAssetIds={new Set([source.id])} onConfirmAttributes={confirm}/></ConfigProvider>)
  return { ...rendered, confirm }
}

const input = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement
async function choose(name: string, label: string) {
  if (input(name).getAttribute('aria-expanded') !== 'true') fireEvent.mouseDown(input(name))
  const option = await waitFor(() => {
    const node = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option'))
      .find(element => element.getAttribute('title') === label)
    expect(node).toBeTruthy()
    return node!
  })
  fireEvent.click(option)
}
async function selectPublicProduct() {
  fireEvent.click(screen.getByRole('tab', { name: '公共产品' }))
  await choose('具体产品', '透明亚克力钥匙扣')
}
async function confirmSelection(confirm: ReturnType<typeof mount>['confirm'], count: number) {
  fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(count))
  await waitFor(() => expect(screen.queryByRole('button', { name: '正在保存…' })).toBeNull())
  return confirm.mock.calls[count - 1][0]
}

test('public product categories default to all and filter specific products including uncategorized artwork', async () => {
  const { confirm } = mount()
  fireEvent.click(screen.getByRole('tab', { name: '公共产品' }))
  expect(input('产品大类').closest('.ant-select')?.textContent).toContain('全部产品')
  fireEvent.mouseDown(input('具体产品'))
  let dropdown = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!
  expect(dropdown.textContent).toContain('透明亚克力钥匙扣')
  expect(dropdown.textContent).toContain('透明贴纸')
  expect(dropdown.textContent).toContain('其他产品')
  fireEvent.keyDown(input('具体产品'), { key: 'Escape', code: 'Escape', keyCode: 27 })
  await choose('产品大类', '贴纸')
  fireEvent.mouseDown(input('具体产品'))
  dropdown = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!
  expect(dropdown.textContent).toContain('透明贴纸')
  expect(dropdown.textContent).not.toContain('透明亚克力钥匙扣')
  expect(dropdown.textContent).not.toContain('其他产品')
  await choose('具体产品', '透明贴纸')
  expect((await confirmSelection(confirm, 1)).productId).toBe('public:P1')
  await choose('产品大类', '全部产品')
  expect(input('具体产品').closest('.ant-select')?.textContent).toContain('透明贴纸')
  await choose('产品大类', '未分类产品')
  expect(input('具体产品').closest('.ant-select')?.textContent).toContain('请选择产品')
  await choose('具体产品', '其他产品')
  expect((await confirmSelection(confirm, 2)).productId).toBe('public:P99')
})

test('changing the category clears the previous product options and image selection restores all categories', async () => {
  const initial = mount()
  await selectPublicProduct()
  await choose('配件样式', 'U形扣')
  await choose('配件颜色', 'U形扣-24')
  await choose('产品大类', '贴纸')
  expect(screen.queryByRole('combobox', { name: '配件样式' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '配件颜色' })).toBeNull()
  await choose('具体产品', '透明贴纸')
  const patch = await confirmSelection(initial.confirm, 1)
  expect(patch.attributes).toEqual({})
  expect(patch.attributeImages).toEqual({})

  const other: Asset = { ...asset, id: 'other', productId: 'public:P99', productName: '其他产品' }
  initial.rerender(<ConfigProvider theme={{ token: { motion: false } }}><ProductAttributesPanel
    allowGrouping={false} assets={[other]} selectedAssetIds={new Set([other.id])} onConfirmAttributes={initial.confirm}/></ConfigProvider>)
  expect(input('产品大类').closest('.ant-select')?.textContent).toContain('全部产品')
  expect(input('具体产品').closest('.ant-select')?.textContent).toContain('其他产品')
})

test('public style selection exposes only its colors and changing the style clears the previous color and image', async () => {
  const { confirm } = mount()
  await selectPublicProduct()
  expect(screen.queryByRole('combobox', { name: '配件颜色' })).toBeNull()
  await choose('配件样式', 'U形扣')
  expect(input('配件颜色')).toBeTruthy()
  fireEvent.mouseDown(input('配件颜色'))
  const dropdown = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!
  expect(dropdown.textContent).toContain('U形扣-24')
  expect(dropdown.textContent).not.toContain('星形扣-41')
  await choose('配件颜色', 'U形扣-24')
  expect(within(screen.getByRole('group', { name: '配件颜色' })).getByRole('img', { name: '配件颜色：U形扣-24' }).getAttribute('src')).toBe('u-24.png')
  fireEvent.change(screen.getByRole('spinbutton', { name: 'QT（数量）' }), { target: { value: '7' } })
  expect(await confirmSelection(confirm, 1)).toMatchObject({ productId: 'public:P31',
    attributes: { 'Accessories Style': 'U style', 'Accessories Color': 'U style-24', QT: '7' },
    attributeImages: { 'Accessories Style': 'u-style.jpg', 'Accessories Color': 'u-24.png' } })

  await choose('配件样式', '星形扣')
  const colors = screen.getByRole('group', { name: '配件颜色' })
  expect(colors.textContent).not.toContain('U形扣-24')
  expect(within(colors).queryByRole('img')).toBeNull()
  const changed = await confirmSelection(confirm, 2)
  expect(changed.attributes).toEqual({ 'Accessories Style': 'Star Hook Clasp', QT: '7' })
  expect(changed.attributeImages).toEqual({ 'Accessories Style': 'star-style.jpg' })
  await choose('配件颜色', '星形扣-41')
  expect((await confirmSelection(confirm, 3)).attributeImages?.['Accessories Color']).toBe('star-41.png')
})

test('public accessory values and selected color image restore from the confirmed asset and clear with the style', async () => {
  const initial = mount()
  await selectPublicProduct()
  await choose('配件样式', '星形扣')
  await choose('配件颜色', '星形扣-41')
  const patch = await confirmSelection(initial.confirm, 1)
  const saved = JSON.parse(JSON.stringify(applyProductAttributePatch(asset, patch))) as Asset
  initial.unmount()

  const restored = mount(saved)
  expect(screen.getByRole('tab', { name: '公共产品' }).getAttribute('aria-selected')).toBe('true')
  expect(input('配件样式').closest('.ant-select')?.textContent).toContain('星形扣')
  expect(input('配件颜色').closest('.ant-select')?.textContent).toContain('星形扣-41')
  expect(screen.getByRole('img', { name: '配件颜色：星形扣-41' }).getAttribute('src')).toBe('star-41.png')
  const clear = input('配件样式').closest('.ant-select')!.querySelector('.ant-select-clear')!
  fireEvent.mouseDown(clear)
  expect(screen.queryByRole('combobox', { name: '配件颜色' })).toBeNull()
  const cleared = await confirmSelection(restored.confirm, 1)
  expect(cleared.attributes).toEqual({})
  expect(cleared.attributeImages).toEqual({})
  expect(saved.attributes?.['Accessories Color']).toBe('Star Hook Clasp-41')
})
