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
  categories: [{ name: 'keychains', products: [{
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
  }] }],
  uncategorizedProducts: [],
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
  await choose('公共产品', '透明亚克力钥匙扣')
}
async function confirmSelection(confirm: ReturnType<typeof mount>['confirm'], count: number) {
  fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(count))
  await waitFor(() => expect(screen.queryByRole('button', { name: '正在保存…' })).toBeNull())
  return confirm.mock.calls[count - 1][0]
}

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
