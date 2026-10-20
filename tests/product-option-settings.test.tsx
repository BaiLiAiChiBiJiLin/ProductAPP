import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render as renderView, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import type { ReactNode } from 'react'
import ProductOptionsSettings from '../src/modules/settings/product-options/ProductOptionsSettings'
import { initialBundle } from '../src/modules/settings/product-options/service'
import { addValue, allProducts, applyMembership, changeOrder, clone, definitions, deleteCategory, deleteValue, getProduct, isEnabled, locations, makeProduct, optionFor, ordered, parseImport, resolvePreview, setRule, setDefault, setEnabled, validateBundle } from '../src/modules/settings/product-options/model'

const api = vi.hoisted(() => ({ invoke: vi.fn() }))
const render = (ui: ReactNode) => renderView(<ConfigProvider theme={{ token: { motion: false } }}>{ui}</ConfigProvider>)
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: api.invoke }))
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getComputedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
})
beforeEach(() => { api.invoke.mockReset().mockImplementation(async command => { if (command === 'load_product_option_settings') return { bundle: clone(initialBundle), version: 'v1', directory: 'D:\\PrintFlow\\settings\\product-options' }; return { version: 'v2', directory: 'D:\\PrintFlow\\settings\\product-options' } }) })
afterEach(cleanup)

test('product IDs are sequential, remain stable on moves and renames, and never reuse deleted IDs', () => {
  const data = clone(initialBundle)
  expect(allProducts(data.main).map(product => product.id)).toEqual(Array.from({ length: 65 }, (_, i) => `P${i + 1}`))
  const first = allProducts(data.main)[0]; first.title = 'Renamed'
  applyMembership(data.main, 0, [], [])
  expect(first.id).toBe('P1')
  expect(makeProduct(data.main).id).toBe('P66')
  const next = makeProduct(data.main); expect(next.id).toBe('P67')
  data.main.uncategorizedProducts.push(next); validateBundle(data)
  next.id = 'P1'; expect(() => validateBundle(data)).toThrow('产品 ID')
})

test('rules subtract from product availability, isolate products, and clear invalid selections without restoring them', () => {
  const data = clone(initialBundle); const [product, other] = allProducts(data.main)
  product.productOptions.forEach(option => { option.deleted = false; delete option.disabledValues })
  setEnabled(optionFor(product, 'Holo Film')!, 'M2', false)
  setRule(product, 'Technique', 'G2', 'Holo Film', ['M1', 'M2'])
  const result = resolvePreview(data, product, { Technique: 'G2', 'Holo Film': 'M1' })
  expect(result.selections['Holo Film']).toBe('')
  expect(result.hidden.get('Holo Film')?.has('M1')).toBe(true)
  const cleared = resolvePreview(data, product, { ...result.selections, Technique: '' })
  expect(cleared.selections['Holo Film']).toBe('')
  expect(isEnabled(optionFor(product, 'Holo Film'), 'M2')).toBe(false)
  expect(product.optionRules?.[0].hide[0].valueIds).toContain('M2')
  setEnabled(optionFor(product, 'Holo Film')!, 'M2', true)
  expect(resolvePreview(data, product, { Technique: 'G2', 'Holo Film': 'M2' }).selections['Holo Film']).toBe('')
  expect(other.optionRules).toBeUndefined()
  optionFor(product, 'Technique')!.deleted = true
  expect(resolvePreview(data, product, { Technique: 'G2' }).hidden.size).toBe(0)
  validateBundle(data)
})

test('G1 hides exactly M7 through M13 while different IDs with the same labels remain available', () => {
  const data = clone(initialBundle); const product = allProducts(data.main)[0]
  product.productOptions.forEach(option => { option.deleted = false; delete option.disabledValues })
  setRule(product, 'Technique', 'G1', 'Holo Film', ['M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13'])
  const result = resolvePreview(data, product, { Technique: 'G1' })
  const visible = data.catalogs['holo-films.json'].values.filter(value => !result.hidden.get('Holo Film')?.has(value.id))
  expect(visible.map(value => value.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M14'])
  expect(result.hidden.get('Holo Film')?.has('M9')).toBe(true)
  expect(visible.find(value => value.id === 'M2')?.labelZh).toBe(data.catalogs['holo-films.json'].values.find(value => value.id === 'M9')?.labelZh)
})

test('rules handle unions, cascading invalidation, cycles, accessory colors, and cleanup of deleted IDs', () => {
  const data = clone(initialBundle); const product = allProducts(data.main)[0]
  product.productOptions.forEach(option => { option.deleted = false; delete option.disabledValues })
  setRule(product, 'Technique', 'G2', 'Holo Film', ['M1'])
  setRule(product, 'Material', 'C1', 'Holo Film', ['M2'])
  expect([...resolvePreview(data, product, { Technique: 'G2', Material: 'C1' }).hidden.get('Holo Film')!]).toEqual(['M1', 'M2'])
  setRule(product, 'Holo Film', 'M1', 'Technique', ['G2'])
  const cycle = resolvePreview(data, product, { Technique: 'G2', 'Holo Film': 'M1' })
  expect(cycle.selections.Technique).toBe(''); expect(cycle.selections['Holo Film']).toBe('')
  const accessory = data.catalogs['accessory-styles.json']; const style = accessory.values.find(value => value.colors?.length)!
  const color = style.colors![0]
  setRule(product, 'Material', 'C2', 'Accessories Style', [color.id])
  expect(resolvePreview(data, product, { Material: 'C2', 'Accessories Style': style.id, 'Accessories Style:color': color.id }).selections['Accessories Style:color']).toBe('')
  setRule(product, 'Accessories Style', color.id, 'Material', ['C3'])
  setEnabled(optionFor(product, 'Accessories Style')!, style.id, false)
  expect(resolvePreview(data, product, { Material: 'C3', 'Accessories Style': style.id, 'Accessories Style:color': color.id }).selections.Material).toBe('C3')
  deleteValue(data, accessory, style)
  expect(product.optionRules?.some(rule => rule.when.valueId === 'C2')).toBe(false)
  const holo = data.catalogs['holo-films.json']
  deleteValue(data, holo, holo.values.find(value => value.id === 'M1')!)
  expect(product.optionRules?.some(rule => rule.when.option === 'Holo Film' || rule.when.option === 'Technique')).toBe(false)
  validateBundle(data)
  setRule(product, 'Technique', 'G2', 'Holo Film', ['M999'])
  expect(() => validateBundle(data)).toThrow('联动规则')
})

test('rule editor allows closed targets, saves their rules without enabling them, and preview applies them', async () => {
  const data = clone(initialBundle); const product = allProducts(data.main)[0]
  product.productOptions.forEach(option => { option.deleted = false; delete option.disabledValues })
  setEnabled(optionFor(product, 'Holo Film')!, 'M2', false)
  api.invoke.mockImplementation(async command => command === 'load_product_option_settings' ? { bundle: data, version: 'v1', directory: 'test' } : { version: 'v2', directory: 'test' })
  render(<ProductOptionsSettings/>); await screen.findByLabelText('产品中文名')
  fireEvent.click(screen.getByRole('button', { name: /^工艺已/ }))
  await select('G2添加联动属性', '全息膜')
  const target = screen.getByRole('combobox', { name: 'G2隐藏全息膜' })
  fireEvent.mouseDown(target.closest('.ant-select')!.querySelector('.ant-select-selector')!)
  const disabled = await screen.findByText('爱心镭射（已关闭）', { selector: '.ant-select-item-option-content' })
  expect(disabled.closest('.ant-select-item')?.classList.contains('ant-select-item-option-disabled')).toBe(false)
  fireEvent.click(disabled)
  fireEvent.click(await screen.findByText('无附加工艺', { selector: '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content' }))
  fireEvent.keyDown(target, { key: 'Escape' })
  await select('预览全息膜', '无附加工艺')
  await select('预览工艺', '单面星星镭射')
  const previewPanel = document.querySelector('.po-preview') as HTMLElement
  expect(previewPanel.textContent).not.toContain('无附加工艺')
  const craft = screen.getByRole('combobox', { name: '预览工艺' })
  fireEvent.mouseDown(craft.closest('.ant-select')!.querySelector('.ant-select-clear')!)
  const film = screen.getByRole('combobox', { name: '预览全息膜' })
  fireEvent.mouseDown(film.closest('.ant-select')!.querySelector('.ant-select-selector')!)
  expect(await screen.findByText('无附加工艺', { selector: '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content' })).toBeTruthy()
  expect(previewPanel.textContent).not.toContain('无附加工艺')
  fireEvent.keyDown(film, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const saved = api.invoke.mock.calls.at(-1)![1].bundle
  expect(allProducts(saved.main)[0].optionRules).toEqual([{ when: { option: 'Technique', valueId: 'G2' }, hide: [{ option: 'Holo Film', valueIds: ['M2', 'M1'] }] }])
  expect(optionFor(allProducts(saved.main)[0], 'Holo Film')!.disabledValues).toContain('M2')
  expect(saved.catalogs).toEqual(data.catalogs)
  validateBundle(saved)
}, 15000)

test('all migrated files validate, preserve 65 products and duplicate titles, and retain nested colors', () => {
  const data = clone(initialBundle); validateBundle(data)
  expect(allProducts(data.main)).toHaveLength(65)
  expect(allProducts(data.main).filter(product => product.title === 'Rounding Clear Acrylic Keychains')).toHaveLength(2)
  const styles = data.catalogs['accessory-styles.json'].values
  expect(styles).toHaveLength(27)
  expect(styles.flatMap(style => style.colors ?? [])).toHaveLength(137)
  expect(locations(data.main, -2).map(location => getProduct(data.main, location))).toEqual(allProducts(data.main))
  expect(parseImport(JSON.stringify(data), data)).toEqual(data)
  expect(parseImport(JSON.stringify(data.main), data)).toEqual(data)
})
test('product toggles are isolated; public values have no visibility or disabled flags', () => {
  const data = clone(initialBundle); const products = allProducts(data.main)
  const a = optionFor(products[0], 'Print Option')!; const b = optionFor(products[1], 'Print Option')!
  const original = clone(data.catalogs)
  setEnabled(a, 'Y1', false)
  expect(a.disabledValues).toContain('Y1'); expect(isEnabled(b, 'Y1')).toBe(true)
  expect(data.catalogs).toEqual(original)
  setEnabled(a, 'Y1', true); expect(a.disabledValues).toBeUndefined()
  validateBundle(data)
})
test('ordering allows duplicate ranks, inserts after current peers, preserves gaps through serialization', () => {
  const data = clone(initialBundle); const root = data.catalogs['techniques.json']
  changeOrder(root.values, 'G3', 1)
  expect(ordered(root.values).slice(0, 3).map(value => value.id)).toEqual(['G1', 'G3', 'G2'])
  changeOrder(root.values, 'G2', 1)
  expect(ordered(root.values).slice(0, 3).map(value => value.id)).toEqual(['G1', 'G3', 'G2'])
  changeOrder(root.values, 'G2', 40)
  expect(parseImport(JSON.stringify(data), data).catalogs['techniques.json'].values.at(-1)?.sortOrder).toBe(40)
})
test('add/delete/defaults use monotonic short IDs and remove deleted disabled IDs from every product', () => {
  const data = clone(initialBundle); const root = data.catalogs['accessory-styles.json']
  const style = addValue(root); expect(style.id).toBe('P28')
  const color = addValue(root, style); expect(color.id).toBe('P-C138')
  const product = allProducts(data.main)[0]; const option = optionFor(product, root.name)!
  setEnabled(option, style.id, false); setEnabled(option, color.id, false)
  setDefault(root, style.id); setDefault(root, color.id, style)
  expect(root.defaultValue).toBe(style.name); expect(color.isDefault).toBe(true)
  deleteValue(data, root, style)
  expect(option.disabledValues).toBeUndefined(); expect(root.defaultValue).toBeUndefined()
  expect(addValue(root).id).toBe('P29')
  validateBundle(data)
})
test('category membership moves instances without losing products, category deletion returns children to unclassified', () => {
  const data = clone(initialBundle); const first = data.main.categories[0].products[0]
  const included = data.main.uncategorizedProducts[0]
  applyMembership(data.main, 0, data.main.categories[0].products.map((_, i) => i).filter(i => i > 0), [0])
  expect(data.main.uncategorizedProducts).toContain(first)
  expect(data.main.categories[0].products).toContain(included)
  const count = allProducts(data.main).length
  deleteCategory(data.main, 0)
  expect(allProducts(data.main)).toHaveLength(count)
  expect(data.main.uncategorizedProducts).toContain(included)
  const product = makeProduct(data.main); expect(product.productOptions.map(option => option.deleted)).toEqual(definitions.map(() => true))
  validateBundle(data)
})
test('malformed imports fail without changing current data', () => {
  const data = clone(initialBundle); const original = clone(data)
  const invalid = clone(data); invalid.catalogs['print-options.json'].values[1].id = 'Y1'
  expect(() => parseImport(JSON.stringify(invalid), data)).toThrow(/ID/)
  expect(() => parseImport('{}', data)).toThrow()
  expect(data).toEqual(original)
})
test('native UI edits product and public data; save stays in settings and sends six-file bundle', async () => {
  const busy = vi.fn()
  render(<ProductOptionsSettings onBusyChange={busy}/> )
  const title = await screen.findByLabelText('产品中文名')
  expect(screen.queryByLabelText('产品类别英文名称')).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: '启用印刷选项' }))
  fireEvent.change(title, { target: { value: '测试产品' } })
  const row = document.querySelector('[data-value-id="Y1"]')!
  fireEvent.click(within(row as HTMLElement).getByRole('switch', { name: 'Y1启用' }))
  fireEvent.change(screen.getByLabelText('Y1中文名称'), { target: { value: '双面同图测试' } })
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const [command, request] = api.invoke.mock.calls.at(-1)!
  expect(command).toBe('save_product_option_settings'); expect(request.expectedVersion).toBe('v1')
  expect(request.bundle.main.categories[0].products[0].titleZh).toBe('测试产品')
  expect(request.bundle.main.categories[0].products[0].productOptions[0].disabledValues).toContain('Y1')
  expect(request.bundle.catalogs['print-options.json'].values[0].labelZh).toBe('双面同图测试')
  expect(Object.keys(request.bundle.catalogs)).toHaveLength(5)
  expect(busy.mock.calls).toEqual([[true], [false]])
})
test('failed save retains draft and offers retry; reloading dirty data requires explicit confirmation', async () => {
  render(<ProductOptionsSettings/> )
  fireEvent.change(await screen.findByLabelText('产品中文名'), { target: { value: '保留草稿' } })
  api.invoke.mockRejectedValueOnce('磁盘不可写')
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('磁盘不可写')
  expect((screen.getByLabelText('产品中文名') as HTMLInputElement).value).toBe('保留草稿')
  fireEvent.click(screen.getByRole('button', { name: /^刷\s*新$/ }))
  expect(await screen.findByText('刷新将放弃未保存修改，是否继续？')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /^取\s*消$/ }))
  expect((screen.getByLabelText('产品中文名') as HTMLInputElement).value).toBe('保留草稿')
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(3))
})

async function select(label: string, text: string) {
  if (label === '产品类别' || label === '产品子类') {
    fireEvent.click(screen.getByRole('button', { name: `选择${label}` }))
    fireEvent.click(await screen.findByRole('menuitem', { name: text }))
    await waitFor(() => expect(document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)')).toBeNull())
    return
  }
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }).closest('.ant-select-selector')!)
  const popup = await waitFor(() => {
    const popup = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)') as HTMLElement
    expect(popup).toBeTruthy(); return popup
  })
  fireEvent.click(within(popup).getByText(text, { exact: true }))
}
test('native controls add and edit nested colors, set defaults, reorder, disable and delete values', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  fireEvent.click(screen.getByRole('button', { name: /^配件样式已/ }))
  fireEvent.click(screen.getByRole('switch', { name: '启用配件样式' }))
  fireEvent.click(screen.getByRole('button', { name: '新增颜色' }))
  fireEvent.change(screen.getByLabelText('P-C138中文名称'), { target: { value: '测试蓝色' } })
  fireEvent.click(screen.getByRole('switch', { name: 'P-C138默认选中' }))
  fireEvent.change(screen.getByLabelText('P-C138序号'), { target: { value: '2' } })
  fireEvent.blur(screen.getByLabelText('P-C138序号'))
  fireEvent.click(screen.getByRole('switch', { name: 'P-C138启用' }))
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const data = api.invoke.mock.calls.at(-1)![1].bundle
  const style = data.catalogs['accessory-styles.json'].values[0]
  expect(style.colors.at(-1)).toMatchObject({ id: 'P-C138', labelZh: '测试蓝色', sortOrder: 2, isDefault: true })
  expect(data.main.categories[0].products[0].productOptions[4].disabledValues).toContain('P-C138')
  const row = document.querySelector('[data-value-id="P-C138"]') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: /^删\s*除$/ }))
  fireEvent.click(screen.getByRole('button', { name: /^确\s*定$/ }))
  expect(screen.queryByLabelText('P-C138中文名称')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(3))
  expect(api.invoke.mock.calls.at(-1)![1].bundle.main.categories[0].products[0].productOptions[4].disabledValues).toBeUndefined()
})
test('category editor adds unclassified children and releases existing children, new empty categories accept new products', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  await select('产品类别', '贴纸（16）')
  expect(await screen.findByLabelText('产品类别英文名称')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /^编\s*辑$/ }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Brushed Gold Stickers' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Custom Art Print Printing' }))
  fireEvent.click(screen.getByRole('button', { name: /^应\s*用$/ }))
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const data = api.invoke.mock.calls.at(-1)![1].bundle.main
  expect(data.categories[0].products.some((p: { title: string }) => p.title === 'Custom Art Print Printing')).toBe(true)
  expect(data.uncategorizedProducts.some((p: { title: string }) => p.title === 'Brushed Gold Stickers')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '新增产品类别' }))
  expect(screen.queryByLabelText('产品名称')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '新增新产品类别产品' }))
  expect((screen.getByLabelText('产品名称') as HTMLInputElement).value).toBe('New Product')
  fireEvent.click(screen.getByRole('button', { name: /^新\s*增$/ }))
  fireEvent.click(screen.getByRole('button', { name: '新增值' }))
  expect(screen.getByLabelText('X1中文名称')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(3))
  validateBundle(api.invoke.mock.calls.at(-1)![1].bundle)
})
test('only refresh and save remain in the toolbar; confirmed refresh discards drafts and reloads JSON', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  const toolbar = document.querySelector('.po-toolbar') as HTMLElement
  expect(within(toolbar).getAllByRole('button').map(button => button.textContent?.replace(/\s/g, ''))).toEqual(['刷新', '保存'])
  expect(screen.queryByLabelText('导入产品配置文件')).toBeNull()
  fireEvent.change(screen.getByLabelText('产品中文名'), { target: { value: '刷新前草稿' } })
  fireEvent.click(within(toolbar).getByRole('button', { name: /^刷\s*新$/ }))
  await screen.findByText('刷新将放弃未保存修改，是否继续？')
  expect(api.invoke).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: /^确\s*定$/ }))
  await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2))
  expect((await screen.findByLabelText('产品中文名') as HTMLInputElement).value).toBe(initialBundle.main.categories[0].products[0].titleZh)
  expect(api.invoke.mock.calls.map(call => call[0])).toEqual(['load_product_option_settings', 'load_product_option_settings'])
})

test('preview respects whole-attribute switches, product value exclusions, defaults and nested accessory colors', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  expect(screen.getByRole('region', { name: '选项编辑区' }).textContent).toBe('')
  expect(screen.queryByRole('combobox', { name: '预览印刷选项' })).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: '启用印刷选项' }))
  expect(screen.getByRole('combobox', { name: '预览印刷选项' })).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: 'Y1默认选中' }))
  expect(document.querySelector('.po-preview')!.textContent).toContain('双面同图')
  fireEvent.click(screen.getByRole('switch', { name: 'Y1启用' }))
  expect(document.querySelector('.po-preview')!.textContent).not.toContain('双面同图')
  fireEvent.click(screen.getByRole('button', { name: /^配件样式已/ }))
  fireEvent.click(screen.getByRole('switch', { name: '启用配件样式' }))
  fireEvent.click(screen.getByRole('button', { name: '新增颜色' }))
  fireEvent.click(screen.getByRole('switch', { name: 'P-C138默认选中' }))
  await select('预览配件样式', '爱心玫红')
  expect(document.querySelector('.po-preview')!.textContent).toContain('新颜色')
  fireEvent.click(screen.getByRole('switch', { name: 'P-C138启用' }))
  expect(screen.queryByRole('combobox', { name: '预览配件颜色' })).toBeNull()
})

test('merged name inputs edit in place; only arrow buttons open selection menus', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  await select('产品类别', '贴纸（16）')
  const categoryName = screen.getByRole('textbox', { name: '产品类别英文名称' }) as HTMLInputElement
  const productName = screen.getByRole('textbox', { name: '产品名称' }) as HTMLInputElement
  expect(categoryName.value).toBe('Stickers')
  fireEvent.click(categoryName)
  fireEvent.change(categoryName, { target: { value: 'Sticker Collection' } })
  fireEvent.click(productName)
  fireEvent.change(productName, { target: { value: 'Renamed Gold Stickers' } })
  expect(document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)')).toBeNull()
  expect(screen.getByRole('button', { name: '选择产品类别' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('button', { name: '选择产品子类' }).getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const main = api.invoke.mock.calls.at(-1)![1].bundle.main
  expect(main.categories[0].title).toBe('Sticker Collection')
  expect(main.categories[0].products[0].title).toBe('Renamed Gold Stickers')
  await select('产品子类', 'Brushed Silver Stickers')
  expect((screen.getByRole('textbox', { name: '产品名称' }) as HTMLInputElement).value).toBe('Brushed Silver Stickers')
  expect(document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)')).toBeNull()
})

test('disabled attributes leave editor empty and restore all data after enabling again', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  expect(screen.getByRole('region', { name: '选项编辑区' }).textContent).toBe('')
  expect(screen.queryByLabelText('Y1中文名称')).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: '启用印刷选项' }))
  fireEvent.change(screen.getByLabelText('Y1中文名称'), { target: { value: '保留的选项值' } })
  fireEvent.click(screen.getByRole('switch', { name: '启用印刷选项' }))
  expect(screen.getByRole('region', { name: '选项编辑区' }).textContent).toBe('')
  expect(screen.queryByLabelText('Y1中文名称')).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: '启用印刷选项' }))
  expect((screen.getByLabelText('Y1中文名称') as HTMLInputElement).value).toBe('保留的选项值')
})
