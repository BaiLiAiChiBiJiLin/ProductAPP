import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render as renderView, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import type { ReactNode } from 'react'
import PriceInput from '../src/modules/settings/product-pricing/PriceInput'
import ProductPricingSettings from '../src/modules/settings/product-pricing/ProductPricingSettings'
import ProductPricePreview from '../src/modules/settings/product-pricing/ProductPricePreview'
import { allProducts, clone, getEntityId, optionFor } from '../src/modules/settings/product-options/model'
import { initialBundle } from '../src/modules/settings/product-options/service'
import { initialDocument as quantityPricing } from '../src/modules/settings/quantity-pricing/service'
import { cloneDocument, type ProductPricingDocument } from '../src/modules/settings/product-pricing/model'
import { initialDocument, type Snapshot } from '../src/modules/settings/product-pricing/service'

const api = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: api.invoke }))

function fixtureDocument(): ProductPricingDocument {
  const document = cloneDocument(initialDocument)
  document.products = document.products.filter(product => ['P31', 'P36'].includes(product.productId))
  document.accessoryPrices = document.accessoryPrices.filter(row => row.accessoryStyleId === 'P8')
  document.sharedAttributePrices = document.sharedAttributePrices!.filter(row => row.sizeBandId === 'keychain-2-in' && row.techniqueId === 'G11')
  for (const product of document.products) {
    product.basePrices = product.basePrices.filter(row => row.sizeBandId === 'keychain-2-in')
    product.attributePrices = product.attributePrices.filter(row => row.sizeBandId === 'keychain-2-in' && row.techniqueId === 'G11')
  }
  return document
}

function snapshot(document = fixtureDocument(), version = 'v1'): Snapshot {
  const bundle = clone(initialBundle)
  bundle.main.categories = bundle.main.categories.filter(category => category.name === 'keychains')
  bundle.main.categories[0].products = bundle.main.categories[0].products.filter(product => ['P31', 'P32', 'P36'].includes(product.productId))
  bundle.main.uncategorizedProducts = []
  for (const product of allProducts(bundle.main)) {
    optionFor(product, 'Holo Film')!.deleted = true
    optionFor(product, 'Size')!.deleted = false
    optionFor(product, 'Size')!.disabledValues = bundle.catalogs['sizes.json'].values.filter(value => getEntityId(value) !== 'keychain-2-in').map(value => ({ sizeBandId: getEntityId(value) }))
    optionFor(product, 'Technique')!.disabledValues = bundle.catalogs['techniques.json'].values.filter(value => !['G11', 'G12'].includes(getEntityId(value))).map(value => ({ techniqueId: getEntityId(value) }))
    optionFor(product, 'Accessories Style')!.disabledValues = bundle.catalogs['accessory-styles.json'].values.filter(value => !['P8', 'P11'].includes(getEntityId(value))).map(value => ({ accessoryStyleId: getEntityId(value) }))
  }
  return { document, bundle, quantityPricing: structuredClone(quantityPricing), version, directory: 'D:/PrintFlow/settings/product-pricing' }
}

function addSize(loaded: Snapshot, sizeBandId: string, labelZh: string) {
  api.invoke.mockImplementation(async (command, request) => command === 'save_product_pricing_settings' ? { ...snapshot(cloneDocument(request.document), 'v2'), bundle: clone(loaded.bundle) } : loaded)
  loaded.bundle.catalogs['sizes.json'].values.push({ sizeBandId, name: labelZh, labelZh, sortOrder: loaded.bundle.catalogs['sizes.json'].values.length + 1 })
  for (const product of allProducts(loaded.bundle.main)) if (product.productId !== 'P31') optionFor(product, 'Size')!.disabledValues!.push({ sizeBandId })
}

const wrap = (ui: ReactNode) => <ConfigProvider theme={{ token: { motion: false } }}>{ui}</ConfigProvider>
const render = (ui: ReactNode) => renderView(wrap(ui))
const saveButton = () => screen.getByRole('button', { name: /保\s*存$/ }) as HTMLButtonElement
const savedRequest = () => api.invoke.mock.calls.filter(call => call[0] === 'save_product_pricing_settings').at(-1)![1] as { document: ProductPricingDocument; expectedVersion: string }
const saveBaseButton = () => screen.getByRole('button', { name: /保存基本价$/ }) as HTMLButtonElement
const ready = () => screen.findByRole('button', { name: '保存基本价' })
const bodyInput = (size = '2 英寸') => screen.getByRole('textbox', { name: `${size} 主体基本价` }) as HTMLInputElement
const materialButton = (label = '乙烯基') => screen.getByRole('button', { name: `编辑材质加价 ${label}` }) as HTMLButtonElement
const materialInput = (size = '2 英寸') => screen.getByRole('textbox', { name: `${size} 材质加价` }) as HTMLInputElement
const accessoryInput = () => screen.getByRole('textbox', { name: 'U形扣 配件价' }) as HTMLInputElement
const setPrice = (input: HTMLElement, value: string) => { fireEvent.focus(input); fireEvent.change(input, { target: { value } }); fireEvent.blur(input) }
const switchTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
const openPublicPrices = () => fireEvent.click(screen.getByRole('button', { name: '公共价格' }))
const openAccessories = () => { openPublicPrices(); switchTab('配件价格') }
const publicAttributeButton = (label = '正面滴胶', kind = '工艺', id?: string) => {
  const matches = screen.getAllByRole('button', { name: `编辑公共${kind}加价 ${label}` })
  return id ? matches.find(button => button.closest('tr')!.textContent!.includes(`${kind === '工艺' ? 'techniqueId' : 'holoFilmId'}: ${id}`))! : matches[0]
}
const publicAttributeInput = (size = '2 英寸', sizeBandId = 'keychain-2-in') => screen.getByRole('textbox', { name: `${size}${sizeBandId ? ` ${sizeBandId}` : ''} 加价` }) as HTMLInputElement
const returnToProduct = () => fireEvent.click(screen.getByRole('button', { name: '返回产品定价' }))
const applyDialog = () => fireEvent.click(screen.getByRole('button', { name: /^应\s*用$/ }))
const cancelDialog = () => fireEvent.click(screen.getByRole('button', { name: /^取\s*消$/ }))
const editBodyPrice = (value: string, size = '2 英寸') => setPrice(bodyInput(size), value)
const readBodyPrice = (size = '2 英寸') => bodyInput(size).value
const editPublicPrice = (value: string, label = '正面滴胶', kind = '工艺', id?: string) => {
  openPublicPrices()
  switchTab(`${kind}加价`)
  fireEvent.click(publicAttributeButton(label, kind, id))
  setPrice(publicAttributeInput(), value)
  applyDialog()
  returnToProduct()
}
const readPublicPrice = (label = '正面滴胶', kind = '工艺', id?: string) => {
  openPublicPrices()
  switchTab(`${kind}加价`)
  fireEvent.click(publicAttributeButton(label, kind, id))
  const value = publicAttributeInput().value
  cancelDialog()
  returnToProduct()
  return value
}

async function select(label: string, text: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }).closest('.ant-select-selector')!)
  const popup = await waitFor(() => {
    const popup = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)') as HTMLElement
    expect(popup).toBeTruthy()
    return popup
  })
  const input = screen.getByRole('combobox', { name: label })
  if (!within(popup).queryByText(text, { exact: true })) {
    fireEvent.change(input, { target: { value: text } })
    await waitFor(() => expect(within(popup).getByText(text, { exact: true })).toBeTruthy())
  }
  fireEvent.click(within(popup).getByText(text, { exact: true }))
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getComputedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
})
beforeEach(() => {
  api.invoke.mockReset().mockImplementation(async (command, request) => {
    if (command === 'load_product_pricing_settings') return snapshot()
    if (command === 'save_product_pricing_settings') return snapshot(cloneDocument(request.document), 'v2')
    throw new Error(`Unexpected command: ${command}`)
  })
})
afterEach(cleanup)

test('product switches and revisiting settings retain drafts and save explicit product identities', async () => {
  const dirty = vi.fn()
  const view = render(<ProductPricingSettings active onDirtyChange={dirty}/>)
  await ready()
  expect(saveButton().disabled).toBe(true)
  editBodyPrice('4.25')
  await select('定价产品', 'Epoxy Acrylic Keychains · P36')
  expect(readBodyPrice()).toBe('2.8663')
  editBodyPrice('5.75')
  await select('定价产品', 'Clear Acrylic Keychains · P31')
  expect(readBodyPrice()).toBe('4.2500')
  view.rerender(wrap(<ProductPricingSettings active={false} onDirtyChange={dirty}/>))
  view.rerender(wrap(<ProductPricingSettings active onDirtyChange={dirty}/>))
  await ready()
  expect(readBodyPrice()).toBe('4.2500')
  expect(api.invoke).toHaveBeenCalledTimes(2)
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  const request = savedRequest()
  expect(Object.keys(request).sort()).toEqual(['document', 'expectedVersion'])
  expect(request.expectedVersion).toBe('v1')
  expect(request.document.products.map(product => [product.productId, product.basePrices[0].unitPrice])).toEqual([['P31', '4.25'], ['P36', '5.75']])
  for (const product of request.document.products) {
    expect(product).not.toHaveProperty('id')
    expect(product.basePrices[0]).toMatchObject({ sizeBandId: 'keychain-2-in' })
    expect(product.attributePrices).toEqual([])
    expect(request.document.sharedAttributePrices![0]).toMatchObject({ techniqueId: 'G11', sizeBandId: 'keychain-2-in' })
    expect(product.basePrices[0]).not.toHaveProperty('id')
    expect(product.basePrices[0]).not.toHaveProperty('techniqueId')
  }
  expect(dirty.mock.calls.map(call => call[0])).toEqual([false, true, false])
  expect(saveButton().disabled).toBe(true)
})

test('saving base prices persists only the current product base and keeps other product, material and public drafts', async () => {
  const loaded = snapshot()
  const material = optionFor(allProducts(loaded.bundle.main).find(product => product.productId === 'P31')!, 'Material')!
  material.deleted = false
  material.disabledValues = loaded.bundle.catalogs['materials.json'].values.filter(value => getEntityId(value) !== 'C1').map(value => ({ materialId: getEntityId(value) }))
  const original = cloneDocument(loaded.document)
  let persisted = structuredClone(loaded)
  let version = 1
  api.invoke.mockImplementation(async (command, request) => {
    if (command === 'save_product_pricing_settings') persisted = { ...persisted, document: cloneDocument(request.document), version: `v${++version}` }
    return structuredClone(persisted)
  })
  render(<ProductPricingSettings/>)
  await ready()
  expect(saveBaseButton().disabled).toBe(true)
  editBodyPrice('4.25')
  fireEvent.click(materialButton())
  setPrice(materialInput(), '0.8')
  applyDialog()
  editPublicPrice('0.6')
  openAccessories()
  setPrice(accessoryInput(), '-1')
  returnToProduct()
  await select('定价产品', 'Epoxy Acrylic Keychains · P36')
  editBodyPrice('5.75')
  await select('定价产品', 'Clear Acrylic Keychains · P31')
  expect(saveButton().disabled).toBe(true)
  expect(saveBaseButton().disabled).toBe(false)
  fireEvent.click(saveBaseButton())
  await screen.findByText('基本价已保存，其他修改仍未保存')
  const savedBase = savedRequest()
  const onlyBaseChanged = cloneDocument(original)
  onlyBaseChanged.products[0].basePrices[0].unitPrice = '4.25'
  expect(savedBase.expectedVersion).toBe('v1')
  expect(savedBase.document).toEqual(onlyBaseChanged)
  expect(saveBaseButton().disabled).toBe(true)
  expect(saveButton().disabled).toBe(true)
  expect(readBodyPrice()).toBe('4.2500')
  fireEvent.click(materialButton())
  expect(materialInput().value).toBe('0.8000')
  cancelDialog()
  expect(readPublicPrice()).toBe('0.6000')
  await select('定价产品', 'Epoxy Acrylic Keychains · P36')
  expect(readBodyPrice()).toBe('5.7500')
  expect(saveBaseButton().disabled).toBe(false)
  openAccessories()
  expect(accessoryInput().value).toBe('-1.0000')
  setPrice(accessoryInput(), '0.9')
  returnToProduct()
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().expectedVersion).toBe('v2')
  expect(savedRequest().document.products.map(product => product.basePrices[0].unitPrice)).toEqual(['4.25', '5.75'])
  expect(savedRequest().document.products[0].attributePrices).toEqual([expect.objectContaining({ materialId: 'C1', unitPrice: '0.8' })])
  expect(savedRequest().document.sharedAttributePrices![0].unitPrice).toBe('0.6')
  expect(savedRequest().document.accessoryPrices[0].unitPrice).toBe('0.9')
  expect(saveButton().disabled).toBe(true)
  expect(saveBaseButton().disabled).toBe(true)
})

test('epoxy quote adds the chosen accessory, applies the category tier, and rounds only the final total', async () => {
  render(<ProductPricingSettings/>)
  await ready()
  await select('定价产品', 'Epoxy Acrylic Keychains · P36')
  switchTab('价格试算')
  expect(await screen.findByText('$75.83')).toBeTruthy()
  expect(screen.getByText('减价 55%')).toBeTruthy()
  expect(screen.getByTitle(fixtureDocument().products.find(product => product.productId === 'P36')!.basePrices[0].unitPrice).textContent).toBe('$2.8663')
  expect(screen.getByTitle('0.3').textContent).toBe('$0.3000')
  const formula = screen.getByRole('region', { name: '总价计算公式' })
  expect(formula.textContent).toContain('主体基本单价 + 工艺加价 + 配件单价')
  expect(formula.textContent).toContain(fixtureDocument().products.find(product => product.productId === 'P36')!.basePrices[0].unitPrice)
  expect(formula.textContent).toContain(fixtureDocument().sharedAttributePrices![0].unitPrice)
  expect(screen.queryByText('$76.00')).toBeNull()
  openAccessories()
  expect(accessoryInput().value).toBe('0.3000')
  setPrice(accessoryInput(), '0.5')
  returnToProduct()
  expect(await screen.findByText('$80.33')).toBeTruthy()
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '5' } })
  expect(screen.getByText('减价 0%')).toBeTruthy()
  expect(screen.getByText('$17.85')).toBeTruthy()
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().document.accessoryPrices[0]).toMatchObject({ accessoryStyleId: 'P8', unitPrice: '0.5' })
  await select('定价产品', 'Clear Acrylic Keychains · P31')
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '5' } })
  expect(screen.getByText('$17.60')).toBeTruthy()
})

test('missing base and attribute prices both block quotes while explicit zero remains valid', async () => {
  render(<ProductPricingSettings/>)
  await ready()
  await select('定价产品', 'Epoxy Acrylic Keychains · P36')
  editBodyPrice('   ')
  expect(readBodyPrice()).toBe('')
  switchTab('价格试算')
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('基本价')
  expect(screen.queryByText('试算总额')).toBeNull()
  switchTab('主体价格')
  editBodyPrice('0')
  editPublicPrice('')
  expect(readPublicPrice()).toBe('')
  switchTab('价格试算')
  expect(screen.getByRole('alert').textContent).toContain('工艺')
  expect(screen.queryByText('试算总额')).toBeNull()
  switchTab('主体价格')
  editPublicPrice('0')
  openAccessories()
  setPrice(accessoryInput(), ' ')
  expect(accessoryInput().value).toBe('')
  returnToProduct()
  switchTab('价格试算')
  expect(await screen.findByText('所选配件尚未配置有效的公共价格')).toBeTruthy()
  openAccessories()
  setPrice(accessoryInput(), '0')
  returnToProduct()
  expect(await screen.findByText('$0.00')).toBeTruthy()
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  const price = savedRequest().document.products.find(product => product.productId === 'P36')!
  expect(price.basePrices).toHaveLength(1)
  expect(price.basePrices[0].unitPrice).toBe('0')
  expect(price.attributePrices).toEqual([])
  expect(savedRequest().document.sharedAttributePrices![0].unitPrice).toBe('0')
  expect(savedRequest().document.accessoryPrices[0].unitPrice).toBe('0')
})

test('invalid quantity drafts immediately clear the quote and retain selections through public price refresh and recovery', async () => {
  const loaded = snapshot()
  loaded.document.products[0].basePrices[0].unitPrice = '5'
  loaded.document.sharedAttributePrices!.push({ sharedAttributePriceId: 'quantity-test-technique', techniqueId: 'G12', holoFilmId: null, sizeBandId: 'keychain-2-in', unitPrice: '0.4' })
  const product = allProducts(loaded.bundle.main).find(product => product.productId === 'P31')!
  const preview = (document: ProductPricingDocument) => <ProductPricePreview document={document} pricing={document.products[0]} product={product} bundle={loaded.bundle} quantityPricing={loaded.quantityPricing} dependencyError=""/>
  const view = render(preview(loaded.document))
  await select('试算工艺', '正面闪粉滴胶')
  const quantity = screen.getByRole('spinbutton', { name: '试算购买数量' }) as HTMLInputElement
  const expectInvalid = () => {
    expect(quantity.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('购买数量必须是大于零的整数')
    expect(document.getElementById(quantity.getAttribute('aria-describedby')!)?.textContent).toBe('购买数量必须是大于零的整数')
    expect(screen.queryByText('试算总额')).toBeNull()
    expect(screen.queryByRole('region', { name: '总价计算公式' })).toBeNull()
  }
  for (const value of ['0', '-1', '', '1.5', '9007199254740992']) {
    fireEvent.change(quantity, { target: { value: '3' } })
    expect(screen.getByText('$17.10')).toBeTruthy()
    fireEvent.focus(quantity)
    fireEvent.keyDown(quantity, { key: value[0] || 'Backspace' })
    fireEvent.change(quantity, { target: { value } })
    expect(quantity.value).toBe(value)
    expectInvalid()
  }
  fireEvent.change(quantity, { target: { value: '0' } })
  const refreshed = cloneDocument(loaded.document)
  refreshed.sharedAttributePrices!.find(row => row.techniqueId === 'G12')!.unitPrice = '0.8'
  view.rerender(wrap(preview(refreshed)))
  expectInvalid()
  fireEvent.change(quantity, { target: { value: '3' } })
  expect(quantity.getAttribute('aria-invalid')).toBe('false')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText('$18.30')).toBeTruthy()
  expect(screen.getByRole('combobox', { name: '试算工艺' }).closest('.ant-select')!.textContent).toContain('正面闪粉滴胶')
  expect(screen.getByRole('combobox', { name: '试算尺寸' }).closest('.ant-select')!.textContent).toContain('2 英寸')
  fireEvent.change(quantity, { target: { value: '3.' } })
  expectInvalid()
  fireEvent.keyDown(quantity, { key: 'Enter' })
  expect(quantity.value).toBe('3')
  expect(quantity.getAttribute('aria-invalid')).toBe('false')
  expect(screen.getByText('$18.30')).toBeTruthy()
  fireEvent.change(quantity, { target: { value: '0' } })
  expectInvalid()
  fireEvent.keyDown(quantity, { key: 'Enter' })
  expect(quantity.value).toBe('1')
  expect(screen.getByText('$6.10')).toBeTruthy()
  fireEvent.change(quantity, { target: { value: '' } })
  fireEvent.keyDown(quantity, { key: 'Enter' })
  expect(quantity.value).toBe('')
  expectInvalid()
  fireEvent.change(quantity, { target: { value: '0' } })
  expectInvalid()
  fireEvent.blur(quantity)
  expect(quantity.value).toBe('1')
  expect(screen.getByText('$6.10')).toBeTruthy()
  fireEvent.change(quantity, { target: { value: '' } })
  fireEvent.blur(quantity)
  expectInvalid()
})

test.each(['all', 'base'] as const)('%s saves preserve edits on failure, release busy controls and retry the same version', async scope => {
  const busy = vi.fn()
  render(<ProductPricingSettings onBusyChange={busy}/>)
  await ready()
  editBodyPrice('4.125')
  let rejectSave!: (reason: string) => void
  api.invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject }))
  const submit = () => fireEvent.click(scope === 'base' ? saveBaseButton() : saveButton())
  submit()
  expect(busy.mock.calls).toEqual([[true]])
  expect(bodyInput().disabled).toBe(true)
  expect(saveBaseButton().disabled).toBe(true)
  expect((screen.getByRole('button', { name: /^刷\s*新$/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(document.querySelector('.product-pricing-settings')!.getAttribute('aria-busy')).toBe('true')
  await act(async () => { rejectSave('配置已被其他窗口修改') })
  expect((await screen.findByRole('alert')).textContent).toContain('配置已被其他窗口修改')
  expect(readBodyPrice()).toBe('4.1250')
  expect(bodyInput().disabled).toBe(false)
  expect(saveBaseButton().disabled).toBe(false)
  expect(saveButton().disabled).toBe(false)
  expect(busy.mock.calls).toEqual([[true], [false]])
  submit()
  await waitFor(() => expect(busy.mock.calls).toEqual([[true], [false], [true], [false]]))
  expect(savedRequest().expectedVersion).toBe('v1')
  expect(savedRequest().document.products[0].basePrices[0].unitPrice).toBe('4.125')
  expect(busy.mock.calls).toEqual([[true], [false], [true], [false]])
})

test('an unpriced product configures base and attribute prices independently with shared accessories', async () => {
  render(<ProductPricingSettings/>)
  await ready()
  await select('定价产品', 'Color Edge Acrylic Keychains · P32')
  expect(screen.getByText('尚未建立价表')).toBeTruthy()
  openAccessories()
  expect(accessoryInput().value).toBe('0.3000')
  returnToProduct()
  fireEvent.click(screen.getByRole('button', { name: '建立价表' }))
  editBodyPrice('6', '2 英寸')
  editPublicPrice('0.25')
  expect(readBodyPrice('2 英寸')).toBe('6.0000')
  expect(readPublicPrice()).toBe('0.2500')
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  const document = savedRequest().document
  expect(document.products.filter(product => product.productId !== 'P32')).toEqual(fixtureDocument().products)
  const created = document.products.find(product => product.productId === 'P32')!
  expect(created).toMatchObject({ productId: 'P32', printPricing: 'included', pricingMode: 'table' })
  expect(created.basePrices).toHaveLength(1)
  expect(created.attributePrices).toEqual([])
  expect(document.sharedAttributePrices).toHaveLength(1)
  expect(created.basePrices[0]).toMatchObject({ unitPrice: '6' })
  expect(created.basePrices[0]).not.toHaveProperty('techniqueId')
  expect(document.sharedAttributePrices![0]).toMatchObject({ techniqueId: 'G11', unitPrice: '0.25', holoFilmId: null })
  expect(created.basePrices[0].basePriceId).toBeTruthy()
  expect(document.sharedAttributePrices![0].sharedAttributePriceId).toBeTruthy()
  expect(document.accessoryPrices).toEqual(fixtureDocument().accessoryPrices)
})

test('reference cleanup requires confirmation and retains valid base and attribute prices', async () => {
  const loaded = snapshot()
  loaded.document.sharedAttributePrices!.push({ sharedAttributePriceId: 'obsolete-attribute', techniqueId: 'G999', holoFilmId: null, sizeBandId: 'keychain-2-in', unitPrice: '99' })
  loaded.document.accessoryPrices.push({ accessoryPriceId: 'obsolete-accessory', accessoryStyleId: 'P999', accessoryColorId: null, unitPrice: '99' })
  loaded.document.products.push({ productId: 'P999', printPricing: 'included', pricingMode: 'fixed', fixedUnitPrice: null, basePrices: [], attributePrices: [], legacyBodyPrices: [], dimensionPrices: [] })
  api.invoke.mockResolvedValueOnce(loaded)
  render(<ProductPricingSettings/>)
  await screen.findByText('部分价格引用已失效')
  expect(saveButton().disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '清理失效引用' }))
  await screen.findByText('清理失效的价格引用？')
  cancelDialog()
  expect(screen.getByText('部分价格引用已失效')).toBeTruthy()
  expect(api.invoke).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '清理失效引用' }))
  fireEvent.click(screen.getByRole('button', { name: /^确\s*定$/ }))
  expect(screen.queryByText('部分价格引用已失效')).toBeNull()
  expect(saveButton().disabled).toBe(false)
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().document).toEqual(fixtureDocument())
})

test('clearing a base price keeps input focus and preserves all attribute prices', async () => {
  const loaded = snapshot()
  loaded.document.sharedAttributePrices!.push({ sharedAttributePriceId: 'other-technique', techniqueId: 'G12', holoFilmId: null, sizeBandId: 'keychain-2-in', unitPrice: '0.4' })
  const originalAttributes = structuredClone(loaded.document.sharedAttributePrices!)
  api.invoke.mockResolvedValueOnce(loaded)
  render(<ProductPricingSettings/>)
  await ready()
  const editing = bodyInput()
  fireEvent.focus(editing)
  act(() => editing.focus())
  fireEvent.change(editing, { target: { value: '' } })
  expect(bodyInput()).toBe(editing)
  expect(document.activeElement).toBe(editing)
  expect(bodyInput().value).toBe('')
  setPrice(editing, '7.25')
  expect(readPublicPrice('正面闪粉滴胶')).toBe('0.4000')
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().document.products[0].basePrices[0].unitPrice).toBe('7.25')
  expect(savedRequest().document.sharedAttributePrices!).toEqual(originalAttributes)
})

test('revisiting a dirty price table refreshes saved tiers and version without losing the draft', async () => {
  const view = render(<ProductPricingSettings active/>)
  await ready()
  await select('定价产品', 'Epoxy Acrylic Keychains · P36')
  editBodyPrice('5')
  view.rerender(wrap(<ProductPricingSettings active={false}/>))
  const refreshed = snapshot(fixtureDocument(), 'v2')
  refreshed.quantityPricing.categoryRules.find(rule => rule.categoryId === 'keychains')!.tiers.find(tier => tier.minQty === 50)!.discountPercent = 10
  api.invoke.mockResolvedValueOnce(refreshed)
  view.rerender(wrap(<ProductPricingSettings active/>))
  await ready()
  expect(readBodyPrice()).toBe('5.0000')
  switchTab('价格试算')
  expect(screen.getByText('减价 10%')).toBeTruthy()
  expect(screen.getByText('$247.68')).toBeTruthy()
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().expectedVersion).toBe('v2')
  expect(savedRequest().document.products.find(product => product.productId === 'P36')!.basePrices[0].unitPrice).toBe('5')
})

test('external price changes block stale-draft save and quote until an explicit refresh', async () => {
  const view = render(<ProductPricingSettings active/>)
  await ready()
  editBodyPrice('5')
  view.rerender(wrap(<ProductPricingSettings active={false}/>))
  const refreshed = snapshot(fixtureDocument(), 'external-v2')
  refreshed.document.products[0].basePrices[0].unitPrice = '8'
  api.invoke.mockResolvedValueOnce(refreshed)
  view.rerender(wrap(<ProductPricingSettings active/>))
  await screen.findByText(/产品价表已在其他窗口修改/)
  expect(readBodyPrice()).toBe('5.0000')
  expect(saveButton().disabled).toBe(true)
  fireEvent.click(saveButton())
  expect(api.invoke.mock.calls.some(call => call[0] === 'save_product_pricing_settings')).toBe(false)
  switchTab('价格试算')
  expect(screen.queryByText('试算总额')).toBeNull()
  switchTab('主体价格')
  api.invoke.mockResolvedValueOnce(refreshed)
  fireEvent.click(screen.getByRole('button', { name: /^刷\s*新$/ }))
  fireEvent.click(await screen.findByRole('button', { name: /^确\s*定$/ }))
  await ready()
  expect(readBodyPrice()).toBe('8.0000')
  expect(screen.queryByText(/产品价表已在其他窗口修改/)).toBeNull()
  editBodyPrice('9')
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().expectedVersion).toBe('external-v2')
})

test('failed dependency reload pauses quotes and saves while retaining an editable draft for retry', async () => {
  const view = render(<ProductPricingSettings active/>)
  await ready()
  await select('定价产品', 'Epoxy Acrylic Keychains · P36')
  editBodyPrice('5')
  view.rerender(wrap(<ProductPricingSettings active={false}/>))
  api.invoke.mockRejectedValueOnce('读取价格阶梯失败')
  view.rerender(wrap(<ProductPricingSettings active/>))
  await screen.findByText('读取价格阶梯失败')
  expect(readBodyPrice()).toBe('5.0000')
  expect(saveButton().disabled).toBe(true)
  switchTab('价格试算')
  expect(screen.queryByText('试算总额')).toBeNull()
  const refreshed = snapshot(fixtureDocument(), 'v3')
  api.invoke.mockResolvedValueOnce(refreshed)
  fireEvent.click(screen.getByRole('button', { name: '重新核对' }))
  await screen.findByText('试算总额')
  expect(saveButton().disabled).toBe(false)
  switchTab('主体价格')
  expect(readBodyPrice()).toBe('5.0000')
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().expectedVersion).toBe('v3')
})


test('rounded price display never changes the complete amount when only focused and blurred', () => {
  const change = vi.fn()
  render(<PriceInput label="精确单价" value="3.0704081632653066" onChange={change}/>)
  const input = screen.getByLabelText('精确单价') as HTMLInputElement
  expect(input.value).toBe('3.0704')
  fireEvent.focus(input)
  expect(input.value).toBe('3.0704081632653066')
  fireEvent.blur(input)
  expect(input.value).toBe('3.0704')
  expect(change).not.toHaveBeenCalled()
})

test('all products are selectable and the body page exposes only enabled material prices without duplicate public editors', async () => {
  const bundle = clone(initialBundle)
  bundle.main.nextProductId = 100
  bundle.main.uncategorizedProducts.push({ ...structuredClone(allProducts(bundle.main)[0]), productId: 'P99', title: '未分类测试产品', titleZh: '' })
  api.invoke.mockResolvedValueOnce({ ...snapshot(), bundle, document: cloneDocument(initialDocument) })
  render(<ProductPricingSettings/>)
  await ready()
  expect(screen.queryByRole('region', { name: '属性加价设置' })).toBeNull()
  expect(screen.queryByRole('region', { name: '材质加价设置' })).toBeNull()
  expect(screen.queryByRole('button', { name: /^编辑工艺加价 / })).toBeNull()
  expect(screen.queryByRole('button', { name: /^编辑全息膜加价 / })).toBeNull()
  expect(screen.queryByRole('tab', { name: '产品尺寸' })).toBeNull()
  expect(screen.queryByRole('button', { name: '新增尺寸' })).toBeNull()
  const sticker = allProducts(initialBundle.main).find(product => product.productId === 'P1')!
  await select('定价产品', `${sticker.titleZh || sticker.title} · P1`)
  expect(screen.getByRole('heading', { name: '材质加价' })).toBeTruthy()
  expect(screen.queryByRole('tab', { name: '材质加价' })).toBeNull()
  expect(screen.queryByRole('tab', { name: '工艺加价' })).toBeNull()
  expect(screen.queryByRole('tab', { name: '全息膜加价' })).toBeNull()
  expect(materialButton()).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^编辑工艺加价 / })).toBeNull()
  expect(screen.queryByRole('button', { name: /^编辑全息膜加价 / })).toBeNull()
  expect(screen.queryByRole('button', { name: '新增价格组合' })).toBeNull()
  await select('定价产品', '未分类测试产品 · P99')
  expect(screen.getByText('尚未建立价表')).toBeTruthy()
})

test('inline base prices read every configured size, preserve precision and reject negative amounts without changing attributes', async () => {
  const loaded = snapshot()
  addSize(loaded, 'size-3', '3 英寸')
  addSize(loaded, 'size-4', '4 英寸')
  loaded.document.products[0].basePrices.push({
    basePriceId: 'larger-base', sizeBandId: 'size-3', unitPrice: '6.123456789012345678',
  })
  const original = cloneDocument(loaded.document)
  api.invoke.mockResolvedValueOnce(loaded)
  render(<ProductPricingSettings/>)
  await ready()
  expect(screen.queryByRole('dialog', { name: '主体基本价' })).toBeNull()
  expect(screen.queryByRole('button', { name: '编辑主体基本价' })).toBeNull()
  expect(screen.queryByRole('button', { name: '新增尺寸' })).toBeNull()
  expect(bodyInput('4 英寸').value).toBe('')
  expect(bodyInput('3 英寸').value).toBe('6.1235')
  fireEvent.focus(bodyInput('3 英寸'))
  expect(bodyInput('3 英寸').value).toBe('6.123456789012345678')
  fireEvent.blur(bodyInput('3 英寸'))
  expect(saveButton().disabled).toBe(true)
  expect(saveBaseButton().disabled).toBe(true)
  expect(readBodyPrice('3 英寸')).toBe('6.1235')
  setPrice(bodyInput('3 英寸'), '-1')
  expect(screen.getByRole('alert').textContent).toContain('非负')
  expect(saveButton().disabled).toBe(true)
  expect(saveBaseButton().disabled).toBe(true)
  fireEvent.click(saveBaseButton())
  expect(api.invoke.mock.calls.filter(call => call[0] === 'save_product_pricing_settings')).toHaveLength(0)
  setPrice(bodyInput(), '')
  setPrice(bodyInput('3 英寸'), '7.123456789012345678')
  setPrice(bodyInput('4 英寸'), '0')
  expect(readBodyPrice()).toBe('')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(saveBaseButton().disabled).toBe(false)
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  const saved = savedRequest().document
  expect(saved.products.find(product => product.productId === 'P36')).toEqual(original.products[1])
  expect(saved).not.toHaveProperty('sizeBands')
  expect(saved.sharedAttributePrices).toEqual(original.sharedAttributePrices)
  expect(saved.products[0].basePrices.map(row => [row.sizeBandId, row.unitPrice])).toEqual([
    ['size-3', '7.123456789012345678'], ['size-4', '0'],
  ])
})

test('public attribute editors cover every applicable size and retain missing options without changing base or other attributes', async () => {
  const loaded = snapshot()
  addSize(loaded, 'size-3', '3 英寸')
  addSize(loaded, 'size-4', '4 英寸')
  const original = cloneDocument(loaded.document)
  api.invoke.mockResolvedValueOnce(loaded)
  render(<ProductPricingSettings/>)
  await ready()
  openPublicPrices()
  const attributeRow = () => publicAttributeButton('正面闪粉滴胶').closest('tr')!
  for (const size of ['2 英寸', '3 英寸', '4 英寸']) expect(attributeRow().textContent).toMatch(new RegExp(`${size}[^英]*?未定价`))
  expect(attributeRow().textContent).not.toMatch(/另 \d+ 个尺寸/)
  fireEvent.click(publicAttributeButton('正面闪粉滴胶'))
  expect(screen.getByRole('dialog', { name: '正面闪粉滴胶 · 加价' })).toBeTruthy()
  expect(publicAttributeInput().value).toBe('')
  expect(publicAttributeInput('3 英寸', 'size-3').value).toBe('')
  setPrice(publicAttributeInput(), '0.123456789012345678')
  cancelDialog()
  expect(saveButton().disabled).toBe(true)
  fireEvent.click(publicAttributeButton('正面闪粉滴胶'))
  expect(publicAttributeInput().value).toBe('')
  setPrice(publicAttributeInput(), '0.123456789012345678')
  setPrice(publicAttributeInput('3 英寸', 'size-3'), '0')
  applyDialog()
  expect(attributeRow().textContent).toMatch(/2 英寸[^英]*?\$0\.1235/)
  expect(attributeRow().textContent).toMatch(/3 英寸[^英]*?\$0\.0000/)
  expect(attributeRow().textContent).toMatch(/4 英寸[^英]*?未定价/)
  fireEvent.click(publicAttributeButton('正面闪粉滴胶'))
  expect(publicAttributeInput().value).toBe('0.1235')
  fireEvent.focus(publicAttributeInput())
  expect(publicAttributeInput().value).toBe('0.123456789012345678')
  cancelDialog()
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  let saved = savedRequest().document
  expect(saved.products[0].basePrices).toEqual(original.products[0].basePrices)
  expect(saved.sharedAttributePrices!.filter(row => row.techniqueId === 'G11')).toEqual(original.sharedAttributePrices)
  expect(saved.sharedAttributePrices!.filter(row => row.techniqueId === 'G12').map(row => [row.sizeBandId, row.unitPrice])).toEqual([
    ['keychain-2-in', '0.123456789012345678'], ['size-3', '0'],
  ])
  fireEvent.click(publicAttributeButton('正面闪粉滴胶'))
  setPrice(publicAttributeInput(), '')
  setPrice(publicAttributeInput('3 英寸', 'size-3'), '')
  applyDialog()
  fireEvent.click(publicAttributeButton('正面闪粉滴胶'))
  expect(publicAttributeInput().value).toBe('')
  cancelDialog()
  fireEvent.click(saveButton())
  await waitFor(() => expect(savedRequest().document.sharedAttributePrices!).toHaveLength(1))
  saved = savedRequest().document
  expect(saved).toEqual(original)
})

test('quote adds base and the selected signed attribute fee exactly once', async () => {
  const loaded = snapshot()
  loaded.document.products[0].basePrices[0].unitPrice = '5'
  loaded.document.sharedAttributePrices![0].unitPrice = '0.25'
  loaded.document.sharedAttributePrices!.push({
    sharedAttributePriceId: 'discount-technique', techniqueId: 'G12', holoFilmId: null,
     sizeBandId: 'keychain-2-in', unitPrice: '-0.5',
  })
  api.invoke.mockResolvedValueOnce(loaded)
  render(<ProductPricingSettings/>)
  await ready()
  switchTab('价格试算')
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '1' } })
  expect(screen.getByText('$5.55')).toBeTruthy()
  await select('试算工艺', '正面闪粉滴胶')
  expect(screen.getByText('$4.80')).toBeTruthy()
  switchTab('主体价格')
  editPublicPrice('-0.75', '正面闪粉滴胶')
  expect(readBodyPrice()).toBe('5.0000')
  expect(readPublicPrice()).toBe('0.2500')
  expect(readPublicPrice('正面闪粉滴胶')).toBe('-0.7500')
  switchTab('价格试算')
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '1' } })
  await select('试算工艺', '正面闪粉滴胶')
  expect(screen.getByText('$4.55')).toBeTruthy()
  expect(screen.getByRole('region', { name: '总价计算公式' }).textContent).toContain('5 + （-0.75） + 0.3')
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().document.products[0].basePrices[0].unitPrice).toBe('5')
  expect(savedRequest().document.sharedAttributePrices!.find(row => row.techniqueId === 'G12')?.unitPrice).toBe('-0.75')
  expect(savedRequest().document.products[1]).toEqual(fixtureDocument().products[1])
})

test('material remains editable only for its product while public film and technique prices each enter the quote once', async () => {
  const loaded = snapshot()
  const product = allProducts(loaded.bundle.main).find(product => product.productId === 'P31')!
  const film = optionFor(product, 'Holo Film')!
  film.deleted = false
  film.disabledValues = loaded.bundle.catalogs['holo-films.json'].values.filter(value => getEntityId(value) !== 'M2').map(value => ({ holoFilmId: getEntityId(value) }))
  for (const item of allProducts(loaded.bundle.main)) {
    const material = optionFor(item, 'Material')!
    material.deleted = false
    material.disabledValues = loaded.bundle.catalogs['materials.json'].values.filter(value => getEntityId(value) !== 'C1').map(value => ({ materialId: getEntityId(value) }))
  }
  loaded.document.products[0].basePrices[0].unitPrice = '5'
  loaded.document.sharedAttributePrices![0].unitPrice = '0.25'
  api.invoke.mockResolvedValueOnce(loaded)
  render(<ProductPricingSettings/>)
  await ready()
  expect(screen.getByRole('heading', { name: '材质加价' })).toBeTruthy()
  expect(screen.queryByRole('tab', { name: '工艺加价' })).toBeNull()
  expect(screen.queryByRole('tab', { name: '全息膜加价' })).toBeNull()
  expect(screen.queryByRole('tab', { name: '材质加价' })).toBeNull()
  expect(screen.queryByRole('region', { name: '全息膜加价设置' })).toBeNull()
  expect(screen.queryByRole('region', { name: '工艺加价设置' })).toBeNull()
  expect(screen.queryByRole('button', { name: /^编辑工艺加价 / })).toBeNull()
  expect(screen.queryByRole('button', { name: /^编辑全息膜加价 / })).toBeNull()
  editPublicPrice('0.8', '爱心镭射', '全息膜', 'M2')
  fireEvent.click(materialButton())
  setPrice(materialInput(), '0.6')
  applyDialog()
  expect(readBodyPrice()).toBe('5.0000')
  expect(readPublicPrice()).toBe('0.2500')
  expect(readPublicPrice('爱心镭射', '全息膜', 'M2')).toBe('0.8000')
  await select('定价产品', 'Epoxy Acrylic Keychains · P36')
  fireEvent.click(materialButton())
  expect(materialInput().value).toBe('')
  cancelDialog()
  await select('定价产品', 'Clear Acrylic Keychains · P31')
  fireEvent.click(materialButton())
  expect(materialInput().value).toBe('0.6000')
  cancelDialog()
  switchTab('价格试算')
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '1' } })
  expect(screen.getByText('$6.95')).toBeTruthy()
  expect(screen.getByRole('region', { name: '总价计算公式' }).textContent).toContain('主体基本单价 + 工艺加价 + 全息膜加价 + 材质加价 + 配件单价')
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  const saved = savedRequest().document.products[0]
  expect(saved.basePrices[0].unitPrice).toBe('5')
  expect(saved.attributePrices).toHaveLength(1)
  expect(savedRequest().document.sharedAttributePrices!.find(row => row.holoFilmId === 'M2')).toMatchObject({ techniqueId: null, unitPrice: '0.8' })
  expect(saved.attributePrices.find(row => row.materialId === 'C1')).toMatchObject({ techniqueId: null, holoFilmId: null, unitPrice: '0.6' })
  expect(savedRequest().document.products[1]).toEqual(loaded.document.products[1])
})

test('pricing reads configured size labels and keeps disabled-size prices until explicit cleanup', async () => {
  const loaded = snapshot()
  addSize(loaded, 'size-3', '3 英寸')
  loaded.document.products[0].basePrices.push({ basePriceId: 'disabled-size-base', sizeBandId: 'size-3', unitPrice: '8.123456789012345678' })
  const product = allProducts(loaded.bundle.main).find(product => product.productId === 'P31')!
  optionFor(product, 'Size')!.disabledValues!.push({ sizeBandId: 'size-3' })
  loaded.bundle.catalogs['sizes.json'].values.find(value => value.sizeBandId === 'keychain-2-in')!.labelZh = '已改名尺寸'
  api.invoke.mockResolvedValueOnce(loaded)
  render(<ProductPricingSettings/>)
  await ready()
  expect(screen.getByText('部分价格引用已失效')).toBeTruthy()
  expect(screen.queryByRole('tab', { name: '产品尺寸' })).toBeNull()
  expect(bodyInput('已改名尺寸').value).toBe('2.8163')
  expect(screen.queryByLabelText('3 英寸 主体基本价')).toBeNull()
  setPrice(bodyInput('已改名尺寸'), '4.2')
  expect(screen.getByText('部分价格引用已失效')).toBeTruthy()
  expect(saveButton().disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '清理失效引用' }))
  cancelDialog()
  expect(screen.getByText('部分价格引用已失效')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '清理失效引用' }))
  fireEvent.click(screen.getByRole('button', { name: /^确\s*定$/ }))
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().document.products[0].basePrices).toEqual([{ ...fixtureDocument().products[0].basePrices[0], unitPrice: '4.2' }])
})

test('standee dimension dialog cancels locally, keeps invalid edits open and applies precise prices to quotes', async () => {
  const loaded = snapshot()
  loaded.bundle = clone(initialBundle)
  loaded.bundle.main.categories = loaded.bundle.main.categories.filter(category => category.products.some(product => product.productId === 'P27'))
  loaded.bundle.main.categories[0].products = loaded.bundle.main.categories[0].products.filter(product => product.productId === 'P27')
  loaded.bundle.main.uncategorizedProducts = []
  loaded.document = cloneDocument(initialDocument)
  loaded.document.products = loaded.document.products.filter(product => product.productId === 'P27')
  loaded.document.products[0].dimensionPrices = loaded.document.products[0].dimensionPrices.slice(0, 1)
  const recipe = loaded.document.products[0].dimensionPrices[0]
  recipe.baseUnitPrice = '3'
  recipe.panels = [{
    panelId: 'test-panel', label: '测试面板', baseAdjustment: '0',
    pieceBands: [{ rangeId: 'test-piece', minMm: '35', maxMm: '380', kind: 'fixed', amount: '2', coefficient: '0' }],
    baseBands: [{ rangeId: 'test-base', minMm: '35', maxMm: '380', kind: 'fixed', amount: '1', coefficient: '0' }],
  }]
  api.invoke.mockResolvedValueOnce(loaded)
  render(<ProductPricingSettings/>)
  const openDimensions = () => fireEvent.click(screen.getByRole('button', { name: '编辑长宽计价 1' }))
  await screen.findByRole('button', { name: '编辑长宽计价 1' })
  expect(screen.queryByText('立牌暂保留原组合计价')).toBeNull()
  expect(screen.queryByText(/尚未拆分为主体基本价和属性加价/)).toBeNull()
  expect(screen.queryByRole('button', { name: '编辑主体基本价' })).toBeNull()
  expect(screen.queryByRole('button', { name: '保存基本价' })).toBeNull()
  openDimensions()
  setPrice(screen.getByLabelText('主体固定金额'), '99')
  fireEvent.change(screen.getByLabelText('面板1名称'), { target: { value: '取消的名称' } })
  fireEvent.click(screen.getByRole('button', { name: /^取\s*消$/ }))
  expect(screen.getByRole('button', { name: '编辑长宽计价 1' }).closest('tr')!.textContent).toContain('测试面板')
  expect(screen.getByRole('button', { name: '编辑长宽计价 1' }).textContent).toContain('$3.0000')
  expect(saveButton().disabled).toBe(true)
  openDimensions()
  expect((screen.getByLabelText('主体固定金额') as HTMLInputElement).value).toBe('3.0000')
  fireEvent.change(screen.getByLabelText('面板1片材第1段起点'), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: /^应\s*用$/ }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('尺寸区间必须大于零')
  expect(saveButton().disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('面板1片材第1段起点'), { target: { value: '35' } })
  fireEvent.change(screen.getByLabelText('面板1名称'), { target: { value: '更新后的面板' } })
  setPrice(screen.getByLabelText('主体固定金额'), '4.123456789012345678')
  fireEvent.click(screen.getByRole('button', { name: /^应\s*用$/ }))
  expect(screen.getByRole('button', { name: '编辑长宽计价 1' }).closest('tr')!.textContent).toContain('更新后的面板')
  expect(screen.getByRole('button', { name: '编辑长宽计价 1' }).textContent).toContain('$4.1235')
  switchTab('价格试算')
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '1' } })
  expect(screen.getByText('$7.12')).toBeTruthy()
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().document.products[0].dimensionPrices[0]).toMatchObject({
    baseUnitPrice: '4.123456789012345678', panels: [expect.objectContaining({ label: '更新后的面板' })],
  })
})



test('standee preview selects each panel quantity, preserves hidden part dimensions and rejects uncovered dimensions', async () => {
  api.invoke.mockResolvedValueOnce({ ...snapshot(), bundle: clone(initialBundle), document: cloneDocument(initialDocument) })
  render(<ProductPricingSettings/>)
  await ready()
  await select('定价产品', 'Full Bleed Acrylic Standees · P27')
  switchTab('价格试算')
  expect(screen.queryByText('立牌暂保留原组合计价')).toBeNull()
  expect(screen.queryByText(/尚未拆分基本价与属性加价/)).toBeNull()
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '1' } })
  // 2.68 + (2.41 + 2.41 - 2.68) + (3.10 + 3.10 - 2.68)
  expect(screen.getByText('$8.34')).toBeTruthy()
  const recipe = initialDocument.products.find(product => product.productId === 'P27')!.dimensionPrices[0]
  const clearPanel = screen.getByRole('group', { name: `${recipe.panels[0].label}（mm）` })
  const secondPanel = screen.getByRole('group', { name: `${recipe.panels[1].label}（mm）` })
  const quantityLabel = `${recipe.panels[0].label}主体片数`
  expect(within(clearPanel).queryByLabelText(`${recipe.panels[0].label}片材2宽`)).toBeNull()
  await select(quantityLabel, '2片')
  expect(within(clearPanel).getByLabelText(`${recipe.panels[0].label}片材2宽`)).toBeTruthy()
  expect(within(secondPanel).queryByLabelText(`${recipe.panels[1].label}片材2宽`)).toBeNull()
  expect(screen.getByText('$10.75')).toBeTruthy()
  const secondWidth = `${recipe.panels[0].label}片材2宽`
  fireEvent.change(within(clearPanel).getByLabelText(secondWidth), { target: { value: '60' } })
  await select(quantityLabel, '4片')
  expect(within(clearPanel).getByLabelText(`${recipe.panels[0].label}片材4宽`)).toBeTruthy()
  expect(screen.getByText('$15.57')).toBeTruthy()
  await select(quantityLabel, '1片')
  expect(within(clearPanel).queryByLabelText(secondWidth)).toBeNull()
  expect(screen.getByText('$8.34')).toBeTruthy()
  await select(quantityLabel, '3片')
  expect((within(clearPanel).getByLabelText(secondWidth) as HTMLInputElement).value).toBe('60')
  expect(within(clearPanel).getByLabelText(`${recipe.panels[0].label}片材3宽`)).toBeTruthy()
  expect(within(clearPanel).queryByLabelText(`${recipe.panels[0].label}片材4宽`)).toBeNull()
  expect(screen.getByText('$13.16')).toBeTruthy()
  await select(`${recipe.panels[1].label}主体片数`, '2片')
  expect(screen.getByText('$16.26')).toBeTruthy()
  fireEvent.change(within(clearPanel).getByLabelText(`${recipe.panels[0].label}片材1宽`), { target: { value: '49.5' } })
  fireEvent.change(within(clearPanel).getByLabelText(`${recipe.panels[0].label}片材1高`), { target: { value: '49.5' } })
  expect(screen.queryByText('试算总额')).toBeNull()
  expect(screen.getByText(/未配置价格/).closest('[role="alert"]')).toBeTruthy()
})

test('fixed colored standee offers quantity choices without fabricating multi-piece prices', async () => {
  api.invoke.mockResolvedValueOnce({ ...snapshot(), bundle: clone(initialBundle), document: cloneDocument(initialDocument) })
  render(<ProductPricingSettings/>)
  await ready()
  await select('定价产品', 'Custom Colored Acrylic Standees · P25')
  switchTab('价格试算')
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '1' } })
  expect(screen.getByText('$2.68')).toBeTruthy()
  await select('试算主体片数', '2片')
  expect(screen.queryByText('试算总额')).toBeNull()
  expect(screen.getByRole('alert').textContent).toMatch(/配方|未配置/)
  await select('试算主体片数', '1片')
  expect(screen.getByText('$2.68')).toBeTruthy()
})


test('fixed and standee previews expose enabled Size and wait for an explicit selection before quoting', async () => {
  const loaded = snapshot()
  const product = allProducts(loaded.bundle.main).find(product => product.productId === 'P31')!
  const fixed = loaded.document.products[0]
  Object.assign(fixed, { pricingMode: 'fixed', fixedUnitPrice: '5', basePrices: [], attributePrices: [] })
  loaded.document.sharedAttributePrices = loaded.document.sharedAttributePrices!.map(row => ({ ...row, sizeBandId: null, unitPrice: '0.25' }))
  api.invoke.mockResolvedValueOnce(loaded)
  const view = render(<ProductPricingSettings/>)
  await screen.findByLabelText('固定主体基本价')
  switchTab('价格试算')
  expect(screen.getByRole('combobox', { name: '试算尺寸' })).toBeTruthy()
  expect(screen.queryByText('试算总额')).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('有效尺寸档')
  await select('试算尺寸', '2 英寸')
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '1' } })
  expect(screen.getByText('$5.55')).toBeTruthy()
  view.unmount()

  const standee = cloneDocument(initialDocument).products.find(product => product.productId === 'P27')!
  loaded.document.products = [{ ...standee, productId: product.productId }]
  const standeeProduct = allProducts(loaded.bundle.main).find(item => item.productId === product.productId)!
  standeeProduct.productOptions = clone(allProducts(initialBundle.main).find(product => product.productId === 'P27')!.productOptions)
  const size = optionFor(standeeProduct, 'Size')!
  size.deleted = false
  size.disabledValues = loaded.bundle.catalogs['sizes.json'].values.filter(value => value.sizeBandId !== 'keychain-2-in').map(value => ({ sizeBandId: getEntityId(value) }))
  api.invoke.mockResolvedValueOnce(loaded)
  render(<ProductPricingSettings/>)
  await screen.findByRole('button', { name: '编辑长宽计价 1' })
  switchTab('价格试算')
  expect(screen.getByRole('combobox', { name: '试算尺寸' })).toBeTruthy()
  expect(screen.queryByText('试算总额')).toBeNull()
  await select('试算尺寸', '2 英寸')
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '1' } })
  expect(screen.getByText('$8.34')).toBeTruthy()
})


test('public technique and film tabs share edits across products and preserve preview state through return, save and reload', async () => {
  const loaded = snapshot()
  loaded.document.products[0].basePrices[0].unitPrice = '5'
  loaded.document.products[1].basePrices[0].unitPrice = '7'
  loaded.document.sharedAttributePrices![0].unitPrice = '0.2'
  loaded.document.sharedAttributePrices!.push({ sharedAttributePriceId: 'shared-film', techniqueId: null, holoFilmId: 'M2', sizeBandId: 'keychain-2-in', unitPrice: '0.4' })
  for (const product of allProducts(loaded.bundle.main)) {
    const film = optionFor(product, 'Holo Film')!
    film.deleted = false
    film.disabledValues = loaded.bundle.catalogs['holo-films.json'].values.filter(value => getEntityId(value) !== 'M2').map(value => ({ holoFilmId: getEntityId(value) }))
  }
  let persisted = structuredClone(loaded)
  api.invoke.mockImplementation(async (command, request) => {
    if (command === 'save_product_pricing_settings') persisted = { ...persisted, document: cloneDocument(request.document), version: 'v2' }
    return structuredClone(persisted)
  })
  const view = render(<ProductPricingSettings/>)
  await ready()
  switchTab('价格试算')
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '5' } })
  expect(screen.getByText('$29.50')).toBeTruthy()
  openPublicPrices()
  expect(screen.queryByRole('textbox', { name: '2 英寸 主体基本价' })).toBeNull()
  expect(screen.queryByRole('button', { name: '保存基本价' })).toBeNull()
  expect(screen.getByRole('tab', { name: '工艺加价' }).getAttribute('aria-selected')).toBe('true')
  const techniqueRow = publicAttributeButton().closest('tr')!
  expect(techniqueRow.textContent).toMatch(/2 英寸[^英]*?\$0\.2000/)
  fireEvent.click(publicAttributeButton())
  expect(screen.getByRole('dialog', { name: '正面滴胶 · 加价' })).toBeTruthy()
  setPrice(publicAttributeInput(), '0.8'); applyDialog()
  switchTab('全息膜加价')
  fireEvent.click(publicAttributeButton('爱心镭射', '全息膜', 'M2'))
  setPrice(publicAttributeInput(), '0.6'); applyDialog()
  returnToProduct()
  expect(screen.getByRole('tab', { name: '价格试算' }).getAttribute('aria-selected')).toBe('true')
  expect((screen.getByRole('spinbutton', { name: '试算购买数量' }) as HTMLInputElement).value).toBe('5')
  expect(screen.getByText('$33.50')).toBeTruthy()
  await select('定价产品', 'Epoxy Acrylic Keychains · P36')
  fireEvent.change(screen.getByRole('spinbutton', { name: '试算购买数量' }), { target: { value: '1' } })
  expect(screen.getByText('$8.70')).toBeTruthy()
  switchTab('主体价格')
  expect(readPublicPrice()).toBe('0.8000')
  expect(readPublicPrice('爱心镭射', '全息膜', 'M2')).toBe('0.6000')
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().document.products.every(product => product.attributePrices.length === 0)).toBe(true)
  expect(savedRequest().document.sharedAttributePrices!.map(row => row.unitPrice)).toEqual(['0.8', '0.6'])
  view.unmount()
  render(<ProductPricingSettings/>)
  await ready()
  expect(readPublicPrice()).toBe('0.8000')
  expect(readPublicPrice('爱心镭射', '全息膜', 'M2')).toBe('0.6000')
  expect(saveButton().disabled).toBe(true)
})

test('clearing a public attribute blocks every affected product and an explicit zero restores quotes without changing base prices', async () => {
  render(<ProductPricingSettings/>)
  await ready()
  const original = fixtureDocument()
  openPublicPrices()
  fireEvent.click(publicAttributeButton())
  setPrice(publicAttributeInput(), '99'); cancelDialog()
  expect(saveButton().disabled).toBe(true)
  fireEvent.click(publicAttributeButton())
  setPrice(publicAttributeInput(), ''); applyDialog()
  expect(publicAttributeButton().closest('tr')!.textContent).toContain('未定价')
  returnToProduct()
  expect(screen.getByRole('tab', { name: '主体价格' }).getAttribute('aria-selected')).toBe('true')
  switchTab('价格试算')
  expect(screen.getByRole('alert').textContent).toContain('工艺未配置属性价格')
  await select('定价产品', 'Epoxy Acrylic Keychains · P36')
  expect(screen.getByRole('alert').textContent).toContain('工艺未配置属性价格')
  switchTab('主体价格')
  editPublicPrice('0')
  openPublicPrices()
  expect(publicAttributeButton().closest('tr')!.textContent).toContain('$0.0000')
  returnToProduct()
  switchTab('价格试算')
  expect(screen.queryByText('工艺未配置属性价格')).toBeNull()
  expect(screen.getByText('试算总额')).toBeTruthy()
  fireEvent.click(saveButton())
  await screen.findByText('产品定价已保存')
  expect(savedRequest().document.products.map(product => product.basePrices)).toEqual(original.products.map(product => product.basePrices))
  expect(savedRequest().document.sharedAttributePrices![0].unitPrice).toBe('0')
})
