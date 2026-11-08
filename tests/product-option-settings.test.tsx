import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render as renderView, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import type { ReactNode } from 'react'
import ProductOptionsSettings from '../src/modules/settings/product-options/ProductOptionsSettings'
import { initialBundle, loadProductOptions, saveProductOptions } from '../src/modules/settings/product-options/service'
import { areaToMm2, convertSizeArea, migrateSizeAreas } from '../src/modules/settings/product-options/sizeArea'
import { addValue, allProducts, applyMembership, changeOrder, clone, definitions, deleteCategory, deleteValue, display, entityReference, getEntityId, getEntityKey, getProduct, getProductSizes, getStandeePieceCount, isEnabled, locations, makeProduct, moveOptionValue, optionFor, ordered, parseImport, resolvePreview, stripDeprecatedOptionRules, setDefault, setStandeeQuantityDefault, setEnabled, upgradeAdditionalAttributeBundle, upgradeProductSizeBundle, upgradeStandeeQuantityBundle, validateBundle } from '../src/modules/settings/product-options/model'

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
  expect(allProducts(data.main).map(product => product.productId)).toEqual(Array.from({ length: 65 }, (_, i) => `P${i + 1}`))
  const first = allProducts(data.main)[0]; first.title = 'Renamed'
  applyMembership(data.main, 0, [], [])
  expect(first.productId).toBe('P1')
  expect(makeProduct(data.main).productId).toBe('P66')
  const next = makeProduct(data.main); expect(next.productId).toBe('P67')
  data.main.uncategorizedProducts.push(next); validateBundle(data)
  next.productId = 'P1'; expect(() => validateBundle(data)).toThrow(/productId/)
})

test('product P1 and accessory P1 keep separate identities in persisted selections', () => {
  const data = clone(initialBundle)
  const product = allProducts(data.main)[0]
  const accessory = data.catalogs['accessory-styles.json'].values.find(value => getEntityId(value) === 'P1')!
  expect(product).toMatchObject({ productId: 'P1' })
  expect(product).not.toHaveProperty('id')
  expect(entityReference(accessory)).toEqual({ accessoryStyleId: 'P1' })
  expect(getEntityKey(accessory)).toBe('accessoryStyleId')
  const option = optionFor(product, 'Accessories Style')!
  option.deleted = false
  delete option.disabledValues
  const preview = resolvePreview(data, product, { 'Accessories Style': 'P1' })
  expect(preview.selectedValues['Accessories Style']).toEqual({ accessoryStyleId: 'P1' })
  setEnabled(option, { accessoryStyleId: 'P1' }, false)
  expect(option.disabledValues).toEqual([{ accessoryStyleId: 'P1' }])
  expect(product.productId).toBe('P1')
  expect(parseImport(JSON.stringify(data), data)).toEqual(data)
})

test('new values expose their entity field instead of a generic id', () => {
  const data = clone(initialBundle)
  const cases = [
    { file: 'sizes.json', key: 'sizeBandId' },
    { file: 'print-options.json', key: 'printOptionId' },
    { file: 'techniques.json', key: 'techniqueId' },
    { file: 'foil-stamping.json', key: 'foilStampingId' },
    { file: 'holo-films.json', key: 'holoFilmId' },
    { file: 'sticker-holo-films.json', key: 'stickerHoloFilmId' },
    { file: 'tinplate-holo-films.json', key: 'tinplateHoloFilmId' },
    { file: 'materials.json', key: 'materialId' },
    { file: 'tinplate-materials.json', key: 'tinplateMaterialId' },
    { file: 'accessory-styles.json', key: 'accessoryStyleId' },
  ]
  for (const { file, key } of cases) {
    const value = addValue(data.catalogs[file])
    expect(Object.keys(entityReference(value))).toEqual([key])
    expect(value).not.toHaveProperty('id')
  }
  const styles = data.catalogs['accessory-styles.json']
  const color = addValue(styles, styles.values[0])
  expect(entityReference(color)).toEqual({ accessoryColorId: 'P-C138' })
  validateBundle(data)
})

test('additional shared attributes start empty and closed and new products keep explicit independent identities', () => {
  const data = clone(initialBundle)
  const names = definitions.map(definition => definition.name)
  expect(names).toEqual(['Size', 'Print Option', 'Technique', 'Foil Stamping', 'Holo Film', 'Sticker Holo Film', 'Tinplate Holo Film', 'Material', 'Tinplate Material', 'Accessories Style', 'Standee Quantity'])
  expect(names[names.indexOf('Sticker Holo Film') + 1]).toBe('Tinplate Holo Film')
  expect(names[names.indexOf('Material') + 1]).toBe('Tinplate Material')
  for (const [file, name] of [['foil-stamping.json', 'Foil Stamping'], ['sticker-holo-films.json', 'Sticker Holo Film'], ['tinplate-holo-films.json', 'Tinplate Holo Film'], ['tinplate-materials.json', 'Tinplate Material']]) {
    expect(data.catalogs[file]).toMatchObject({ name, values: [], nextId: 1 })
    for (const product of allProducts(data.main)) expect(optionFor(product, name)).toEqual({ name, deleted: true })
    expect(optionFor(makeProduct(data.main), name)).toEqual({ name, deleted: true })
  }
  const film = addValue(data.catalogs['tinplate-holo-films.json'])
  const material = addValue(data.catalogs['tinplate-materials.json'])
  expect(entityReference(film)).toEqual({ tinplateHoloFilmId: 'THF1' })
  expect(entityReference(material)).toEqual({ tinplateMaterialId: 'TM1' })
  const product = allProducts(data.main)[0]
  optionFor(product, 'Tinplate Holo Film')!.deleted = false
  optionFor(product, 'Tinplate Material')!.deleted = false
  const selected = resolvePreview(data, product, { 'Tinplate Holo Film': 'THF1', 'Tinplate Material': 'TM1' })
  expect(selected.selectedValues['Tinplate Holo Film']).toEqual({ tinplateHoloFilmId: 'THF1' })
  expect(selected.selectedValues['Tinplate Material']).toEqual({ tinplateMaterialId: 'TM1' })
  validateBundle(data)
  setEnabled(optionFor(product, 'Tinplate Holo Film')!, { tinplateMaterialId: 'TM1' }, false)
  expect(() => validateBundle(data)).toThrow('禁用实体引用')
})

test('older bundles gain only missing additional catalogs and closed switches on load import and save', async () => {
  const legacy = clone(initialBundle)
  const newDefinitions = definitions.filter(definition => ['Foil Stamping', 'Sticker Holo Film', 'Tinplate Holo Film', 'Tinplate Material'].includes(definition.name))
  const newNames: string[] = newDefinitions.map(definition => definition.name)
  for (const definition of newDefinitions) delete legacy.catalogs[definition.file]
  for (const product of allProducts(legacy.main)) product.productOptions = product.productOptions.filter(option => !newNames.includes(option.name))
  const original = clone(legacy)
  Object.assign(allProducts(legacy.main)[0], { optionRules: 'retired malformed rules' })
  const before = clone(legacy)
  const expected = upgradeAdditionalAttributeBundle(legacy)
  validateBundle(expected)
  expect(upgradeProductSizeBundle(legacy)).toEqual(expected)
  expect(upgradeAdditionalAttributeBundle(expected)).toEqual(expected)
  expect(allProducts(expected.main).map(product => product.productId)).toEqual(allProducts(original.main).map(product => product.productId))
  for (const [index, product] of allProducts(expected.main).entries()) {
    expect(product.productOptions.slice(0, -newNames.length)).toEqual(allProducts(original.main)[index].productOptions)
    expect(product.productOptions.slice(-newNames.length)).toEqual(newNames.map(name => ({ name, deleted: true })))
    expect(product).not.toHaveProperty('optionRules')
  }
  for (const [file, catalog] of Object.entries(original.catalogs)) expect(expected.catalogs[file]).toEqual(catalog)
  expect(parseImport(JSON.stringify(legacy), initialBundle)).toEqual(expected)
  expect(parseImport(JSON.stringify(legacy.main), legacy)).toEqual(expected)
  api.invoke.mockResolvedValueOnce({ bundle: clone(legacy), version: 'legacy-additional', directory: 'test' })
  expect((await loadProductOptions()).bundle).toEqual(expected)
  await saveProductOptions(legacy, 'legacy-additional')
  expect(api.invoke).toHaveBeenLastCalledWith('save_product_option_settings', { bundle: expected, expectedVersion: 'legacy-additional' })
  expect(legacy).toEqual(before)
})

test('additional attribute upgrade preserves edited values defaults switches and exclusions while filling missing switches', () => {
  const data = clone(initialBundle)
  const filmCatalog = data.catalogs['tinplate-holo-films.json']; const materialCatalog = data.catalogs['tinplate-materials.json']
  const film = addValue(filmCatalog); const material = addValue(materialCatalog)
  film.labelZh = '已有膜'; material.labelZh = '已有材质'
  filmCatalog.labelZh = '客户的膜属性'; filmCatalog.nextId = 10
  setDefault(filmCatalog, entityReference(film)); setDefault(materialCatalog, entityReference(material))
  const [first, second] = allProducts(data.main)
  optionFor(first, 'Tinplate Holo Film')!.deleted = false
  setEnabled(optionFor(first, 'Tinplate Holo Film')!, entityReference(film), false)
  optionFor(second, 'Tinplate Material')!.deleted = false
  first.productOptions = first.productOptions.filter(option => option.name !== 'Tinplate Material')
  const before = clone(data)
  const upgraded = upgradeAdditionalAttributeBundle(data)
  const expected = clone(data)
  allProducts(expected.main)[0].productOptions.push({ name: 'Tinplate Material', deleted: true, disabledValues: [{ tinplateMaterialId: 'TM1' }] })
  expect(upgraded).toEqual(expected); expect(data).toEqual(before)
  expect(parseImport(JSON.stringify(data), initialBundle)).toEqual(expected)
  expect(parseImport(JSON.stringify(data.main), data)).toEqual(expected)
  expect(entityReference(addValue(upgraded.catalogs['tinplate-holo-films.json']))).toEqual({ tinplateHoloFilmId: 'THF10' })
  validateBundle(upgraded)
  const malformed = clone(data)
  Object.assign(malformed.catalogs['tinplate-holo-films.json'].values[0], { holoFilmId: 'M1' })
  expect(() => parseImport(JSON.stringify(malformed), initialBundle)).toThrow('一个所属实体 ID')
})

test('attribute taxonomy retires empty legacy films and renames labels without changing existing entity values', async () => {
  const legacy = clone(initialBundle)
  const labels = [
    ['techniques.json', '工艺', '滴胶工艺'],
    ['holo-films.json', '全息膜', '亚克力全息膜'],
    ['materials.json', '材质', '贴纸材质'],
  ]
  for (const [file, label] of labels) legacy.catalogs[file].labelZh = label
  legacy.catalogs['tinplate-sticker-films.json'] = { name: 'Tinplate Sticker Film', labelZh: '马口铁/贴纸膜', values: [], nextId: 1 }
  for (const product of allProducts(legacy.main)) product.productOptions.push({ name: 'Tinplate Sticker Film', deleted: true })
  const before = clone(legacy)
  const upgraded = upgradeAdditionalAttributeBundle(legacy)
  validateBundle(upgraded)
  expect(upgraded.catalogs).not.toHaveProperty('tinplate-sticker-films.json')
  for (const product of allProducts(upgraded.main)) expect(optionFor(product, 'Tinplate Sticker Film')).toBeUndefined()
  for (const [file, , label] of labels) {
    expect(upgraded.catalogs[file].labelZh).toBe(label)
    expect(upgraded.catalogs[file].values).toEqual(before.catalogs[file].values)
    expect(upgraded.catalogs[file].defaultValue).toEqual(before.catalogs[file].defaultValue)
  }
  for (const [index, product] of allProducts(upgraded.main).entries()) expect(product.productOptions).toEqual(allProducts(before.main)[index].productOptions.filter(option => option.name !== 'Tinplate Sticker Film'))
  expect(upgradeAdditionalAttributeBundle(upgraded)).toEqual(upgraded)
  expect(parseImport(JSON.stringify(legacy), initialBundle)).toEqual(upgraded)
  await saveProductOptions(legacy, 'legacy-taxonomy')
  expect(api.invoke).toHaveBeenLastCalledWith('save_product_option_settings', { bundle: upgraded, expectedVersion: 'legacy-taxonomy' })
  expect(legacy).toEqual(before)

  legacy.catalogs['materials.json'].labelZh = '客户的贴纸材料'
  expect(upgradeAdditionalAttributeBundle(legacy).catalogs['materials.json'].labelZh).toBe('客户的贴纸材料')
})

test('nonempty retired film data cannot be silently discarded during migration', () => {
  const legacy = clone(initialBundle)
  Object.assign(legacy.catalogs, { 'tinplate-sticker-films.json': { name: 'Tinplate Sticker Film', labelZh: '马口铁/贴纸膜', values: [{ tinplateStickerFilmId: 'TF1', name: 'Existing film', sortOrder: 1 }], nextId: 2 } })
  const before = clone(legacy)
  expect(() => upgradeAdditionalAttributeBundle(legacy)).toThrow('请先迁移到对应的全息膜属性')
  expect(() => parseImport(JSON.stringify(legacy), initialBundle)).toThrow('请先迁移到对应的全息膜属性')
  expect(legacy).toEqual(before)
  legacy.catalogs['tinplate-sticker-films.json'].values = []
  Object.assign(allProducts(legacy.main)[0], { productOptions: [...allProducts(legacy.main)[0].productOptions, { name: 'Tinplate Sticker Film', deleted: true, disabledValues: [{ tinplateStickerFilmId: 'TF1' }] }] })
  expect(() => upgradeAdditionalAttributeBundle(legacy)).toThrow('请先迁移到对应的全息膜属性')
})

test('size migration keeps price IDs and product membership while preserving configured sizes', async () => {
  const legacy = clone(initialBundle)
  delete legacy.catalogs['sizes.json']
  for (const product of allProducts(legacy.main)) product.productOptions = product.productOptions.filter(option => option.name !== 'Size')
  const source = { sizeBands: [{ sizeBandId: 'board-1-in', label: '1 英寸' }, { sizeBandId: 'S7', label: '新增编号尺寸' }], products: [{ productId: 'P1', sizeBandIds: ['board-1-in'] }] }
  const upgraded = upgradeProductSizeBundle(legacy, source)
  validateBundle(upgraded)
  expect(definitions[0].name).toBe('Size')
  expect(upgraded.catalogs['sizes.json'].values.map(entityReference)).toEqual([...initialBundle.catalogs['sizes.json'].values.filter(value => !value.isCustom).map(entityReference), { sizeBandId: 'S7' }, { sizeBandId: 'size-custom' }])
  expect(upgraded.catalogs['sizes.json'].nextId).toBe(8)
  const [first, second] = allProducts(upgraded.main)
  expect(optionFor(first, 'Size')).toEqual({ name: 'Size', deleted: false, disabledValues: upgraded.catalogs['sizes.json'].values.filter(value => value.sizeBandId !== 'keychain-1-in').map(entityReference) })
  expect(getProductSizes(upgraded, first).map(getEntityId)).toEqual(['keychain-1-in'])
  expect(getProductSizes(upgraded, second)).toEqual(getProductSizes(initialBundle, allProducts(initialBundle.main)[1]))
  optionFor(first, 'Size')!.deleted = true
  upgraded.catalogs['sizes.json'].values[0].labelZh = '自定义尺寸名'
  expect(upgradeProductSizeBundle(upgraded, { sizeBands: [], products: [] })).toEqual(upgraded)
  expect(getEntityId(addValue(upgraded.catalogs['sizes.json']))).toBe('S8')
  expect(legacy.catalogs['sizes.json']).toBeUndefined()
  expect(parseImport(JSON.stringify(legacy), initialBundle).catalogs['sizes.json']).toEqual(initialBundle.catalogs['sizes.json'])
  api.invoke.mockResolvedValueOnce({ bundle: legacy, version: 'old-size', directory: 'test' })
  expect((await loadProductOptions()).bundle).toEqual(upgradeProductSizeBundle(legacy))
  expect(upgradeProductSizeBundle(legacy, { products: [{ productId: 'P1' }] })).toEqual(upgradeProductSizeBundle(legacy))
})

test('v1 size migration restores global membership and manifest products without overriding configured sizes', async () => {
  const legacy = clone(initialBundle)
  delete legacy.catalogs['sizes.json']
  for (const product of allProducts(legacy.main)) product.productOptions = product.productOptions.filter(option => option.name !== 'Size')
  const source = { schemaVersion: 1, sizeBands: [{ sizeBandId: 'v1-custom', label: '客户自定义尺寸' }, { sizeBandId: 'keychain-2-in', label: '旧版改名尺寸' }], products: [{ productId: 'P31' }] }
  const upgraded = upgradeProductSizeBundle(legacy, source)
  validateBundle(upgraded)
  const product = allProducts(upgraded.main).find(product => product.productId === 'P31')!
  expect(optionFor(product, 'Size')!.deleted).toBe(false)
  expect(getProductSizes(upgraded, product).map(getEntityId)).toEqual(['keychain-2-in', 'v1-custom'])
  expect(upgraded.catalogs['sizes.json'].values.find(value => value.sizeBandId === 'keychain-2-in')!.labelZh).toBe('旧版改名尺寸')
  const fallbackProduct = allProducts(upgraded.main).find(product => product.productId === 'P1')!
  expect(getProductSizes(upgraded, fallbackProduct).map(getEntityId)).toEqual(getProductSizes(initialBundle, allProducts(initialBundle.main)[0]).map(getEntityId))
  expect(getProductSizes(upgraded, fallbackProduct).map(getEntityId)).not.toContain('v1-custom')
  const disabledProduct = allProducts(upgraded.main).find(product => product.productId === 'P25')!
  expect(optionFor(disabledProduct, 'Size')!.deleted).toBe(true)
  expect(getProductSizes(upgraded, disabledProduct)).toEqual([])
  const existing = clone(initialBundle)
  const existingProduct = allProducts(existing.main).find(product => product.productId === 'P31')!
  optionFor(existingProduct, 'Size')!.deleted = true
  expect(upgradeProductSizeBundle(existing, source)).toEqual(existing)
  api.invoke.mockResolvedValueOnce({ bundle: upgraded, version: 'v1-migrated-size', directory: 'test' })
  expect((await loadProductOptions()).bundle).toEqual(upgraded)
  expect(legacy.catalogs['sizes.json']).toBeUndefined()
})

test('size availability respects the product switch, disabled values and explicit identity without option links', () => {
  const data = clone(initialBundle); const product = allProducts(data.main)[0]
  const catalog = data.catalogs['sizes.json']; const size = catalog.values[0]; const reference = entityReference(size)
  const option = optionFor(product, 'Size')!; option.deleted = false; option.disabledValues = catalog.values.slice(1).map(entityReference)
  expect(getProductSizes(data, product).map(entityReference)).toEqual([reference])
  optionFor(product, 'Technique')!.deleted = false; delete optionFor(product, 'Technique')!.disabledValues
  Object.assign(product, { optionRules: [{ when: { option: 'Technique', value: { techniqueId: 'G11' } }, hide: [{ option: 'Size', values: [reference] }] }] })
  expect(getProductSizes(data, product, { Technique: 'G11' }).map(entityReference)).toEqual([reference])
  expect(getProductSizes(data, product, { Technique: '' }).map(entityReference)).toEqual([reference])
  setEnabled(option, reference, false); expect(getProductSizes(data, product)).toEqual([])
  setEnabled(option, reference, true); option.deleted = true; expect(getProductSizes(data, product)).toEqual([])
  validateBundle(data)
  const malformed = clone(data); malformed.catalogs['sizes.json'].values[0].sizeBandId = ' invalid '
  expect(() => validateBundle(malformed)).toThrow('尺寸选项值')
  const newProduct = makeProduct(data.main, undefined, data.catalogs['standee-quantities.json'], catalog)
  expect(optionFor(newProduct, 'Size')).toEqual({ name: 'Size', deleted: true, disabledValues: catalog.values.map(entityReference) })
})

test('imports reject ambiguous identities, wrong entity references, and missing targets', () => {
  const mutations = [
    (data: ReturnType<typeof JSON.parse>) => { data.main.categories[0].products[0].id = 'P1' },
    (data: ReturnType<typeof JSON.parse>) => { delete data.main.categories[0].products[0].productId },
    (data: ReturnType<typeof JSON.parse>) => { data.catalogs['print-options.json'].values[0].id = 'Y1' },
    (data: ReturnType<typeof JSON.parse>) => { delete data.catalogs['print-options.json'].values[0].printOptionId },
    (data: ReturnType<typeof JSON.parse>) => { data.catalogs['print-options.json'].values[0].materialId = 'Y1' },
    (data: ReturnType<typeof JSON.parse>) => { data.catalogs['print-options.json'].defaultValue = { techniqueId: 'Y1' } },
    (data: ReturnType<typeof JSON.parse>) => { data.catalogs['print-options.json'].defaultValue = { printOptionId: 'Y999' } },
    (data: ReturnType<typeof JSON.parse>) => { data.main.categories[0].products[0].productOptions[0].disabledValues = ['Y1'] },
    (data: ReturnType<typeof JSON.parse>) => { data.main.categories[0].products[0].productOptions[0].disabledValues = [{ techniqueId: 'Y1' }] },
    (data: ReturnType<typeof JSON.parse>) => { data.main.categories[0].products[0].productOptions[0].disabledValues = [{ printOptionId: 'Y1', materialId: 'Y1' }] },
  ]
  const original = clone(initialBundle)
  for (const mutate of mutations) {
    const malformed = JSON.parse(JSON.stringify(original))
    mutate(malformed)
    expect(() => parseImport(JSON.stringify(malformed), original)).toThrow()
  }
  expect(initialBundle).toEqual(original)
})

test('default references survive duplicate names, renames, and a save payload round trip', () => {
  const data = clone(initialBundle)
  const product = allProducts(data.main)[0]
  optionFor(product, 'Print Option')!.deleted = false
  const catalog = data.catalogs['print-options.json']
  setDefault(catalog, { printOptionId: 'Y1' })
  catalog.values[0].name = catalog.values[1].name
  const saved = parseImport(JSON.stringify(data), data)
  expect(saved.catalogs['print-options.json'].defaultValue).toEqual({ printOptionId: 'Y1' })
  expect(resolvePreview(saved, allProducts(saved.main)[0], {}).selectedValues['Print Option']).toEqual({ printOptionId: 'Y1' })
  expect(saved.catalogs['print-options.json'].values[1].isDefault).toBe(false)
})

test('colors from another style cannot remain selected while unrelated choices stay intact', () => {
  const data = clone(initialBundle)
  const product = allProducts(data.main)[0]
  product.productOptions.forEach(option => { option.deleted = false; delete option.disabledValues })
  const [firstStyle, secondStyle] = data.catalogs['accessory-styles.json'].values.filter(value => value.colors?.length)
  const foreignColor = secondStyle.colors![0]
  const preview = resolvePreview(data, product, {
    'Accessories Style': getEntityId(firstStyle),
    'Accessories Style:color': getEntityId(foreignColor),
    Material: 'C1',
  })
  expect(preview.selections['Accessories Style:color']).toBe('')
  expect(preview.selectedValues['Accessories Style:color']).toBeUndefined()
  expect(preview.selectedValues.Material).toEqual({ materialId: 'C1' })
  validateBundle(data)
})

test('custom values remain scoped to their option even when both groups use X1', () => {
  const data = clone(initialBundle)
  const product = allProducts(data.main)[0]
  product.productOptions.push(
    { name: 'Custom Size', labelZh: '自定义尺寸', deleted: false, values: [], nextId: 1 },
    { name: 'Packaging', labelZh: '包装', deleted: false, values: [], nextId: 1 },
  )
  const size = optionFor(product, 'Custom Size')!
  const packaging = optionFor(product, 'Packaging')!
  size.values!.push({ customOptionValueId: 'X1', name: 'Small', sortOrder: 1 }); size.nextId = 2
  packaging.values!.push({ customOptionValueId: 'X1', name: 'Bag', sortOrder: 1 }); packaging.nextId = 2
  setEnabled(size, { customOptionValueId: 'X1' }, false)
  const preview = resolvePreview(data, product, { 'Custom Size': 'X1', Packaging: 'X1' })
  expect(preview.selections['Custom Size']).toBe('')
  expect(preview.selectedValues.Packaging).toEqual({ customOptionValueId: 'X1' })
  expect(isEnabled(packaging, { customOptionValueId: 'X1' })).toBe(true)
  validateBundle(data)
})

test('retired rules never hide film values or clear a selection when another attribute changes', () => {
  const data = clone(initialBundle); const product = allProducts(data.main)[0]
  product.productOptions.forEach(option => { option.deleted = false; delete option.disabledValues })
  Object.assign(product, { optionRules: [{ when: { option: 'Technique', value: { techniqueId: 'G1' } }, hide: [{ option: 'Holo Film', values: ['M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13'].map(holoFilmId => ({ holoFilmId })) }] }] })
  for (const holoFilmId of ['M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13']) {
    const first = resolvePreview(data, product, { Technique: 'G1', 'Holo Film': holoFilmId })
    expect(first.selectedValues['Holo Film']).toEqual({ holoFilmId })
    expect(first.selectedValues.Technique).toEqual({ techniqueId: 'G1' })
    expect(resolvePreview(data, product, { ...first.selections, Technique: 'G11' }).selectedValues['Holo Film']).toEqual({ holoFilmId })
    expect(first).not.toHaveProperty('hidden')
  }
})

test('independent selections still enforce product switches, disabled values, defaults and deleted references', () => {
  const data = clone(initialBundle); const product = allProducts(data.main)[0]
  product.productOptions.forEach(option => { option.deleted = false; delete option.disabledValues })
  const film = data.catalogs['holo-films.json']; const filmOption = optionFor(product, 'Holo Film')!
  setDefault(film, { holoFilmId: 'M7' })
  expect(resolvePreview(data, product, {}).selectedValues['Holo Film']).toEqual({ holoFilmId: 'M7' })
  setEnabled(filmOption, { holoFilmId: 'M7' }, false)
  expect(resolvePreview(data, product, {}).selections['Holo Film']).toBe('')
  expect(resolvePreview(data, product, { 'Holo Film': 'M7' }).selections['Holo Film']).toBe('')
  expect(resolvePreview(data, product, { 'Holo Film': 'M999' }).selections['Holo Film']).toBe('')
  const accessory = data.catalogs['accessory-styles.json']; const style = accessory.values.find(value => value.colors?.length)!
  const color = style.colors![0]; const accessoryOption = optionFor(product, 'Accessories Style')!
  setEnabled(accessoryOption, entityReference(color), false)
  const selected = { 'Accessories Style': getEntityId(style), 'Accessories Style:color': getEntityId(color) }
  expect(resolvePreview(data, product, selected).selectedValues['Accessories Style']).toEqual(entityReference(style))
  expect(resolvePreview(data, product, selected).selections['Accessories Style:color']).toBe('')
  setEnabled(accessoryOption, entityReference(color), true); accessoryOption.deleted = true
  expect(resolvePreview(data, product, selected).selections['Accessories Style']).toBe('')
  expect(resolvePreview(data, product, selected).selections['Accessories Style:color']).toBe('')
  filmOption.deleted = true
  expect(resolvePreview(data, product, { 'Holo Film': 'M8' }).selections['Holo Film']).toBe('')
  deleteValue(data, film, film.values.find(value => getEntityId(value) === 'M7')!)
  expect(film.defaultValue).toBeUndefined(); expect(filmOption.disabledValues).toBeUndefined()
  validateBundle(data)
})

test('loading importing and saving discard valid or malformed retired rules without changing other configuration', async () => {
  const data = clone(initialBundle)
  data.main.uncategorizedProducts.push(data.main.categories[0].products.pop()!)
  const first = allProducts(data.main)[0]
  optionFor(first, 'Technique')!.deleted = true
  setEnabled(optionFor(first, 'Holo Film')!, { holoFilmId: 'M2' }, false)
  setDefault(data.catalogs['holo-films.json'], { holoFilmId: 'M7' })
  const expected = clone(data)
  const payloads: unknown[] = [
    [{ when: { option: 'Technique', value: { techniqueId: 'G1' } }, hide: [{ option: 'Holo Film', values: [{ holoFilmId: 'M7' }] }] }],
    [{ when: { option: 'Missing', value: { productId: 'P999' } }, hide: [{ option: 'Holo Film', values: [{ holoFilmId: 'M999' }] }] }],
    { invalid: true }, null, 'obsolete',
  ]
  for (const optionRules of payloads) {
    Object.assign(first, { optionRules })
    Object.assign(data.main.uncategorizedProducts[0], { optionRules })
    const before = clone(data)
    expect(stripDeprecatedOptionRules(data)).toEqual(expected)
    expect(parseImport(JSON.stringify(data), initialBundle)).toEqual(expected)
    expect(parseImport(JSON.stringify(data.main), data)).toEqual(expected)
    api.invoke.mockResolvedValueOnce({ bundle: clone(data), version: 'legacy-version', directory: 'test' })
    expect(await loadProductOptions()).toEqual({ bundle: expected, version: 'legacy-version', directory: 'test' })
    await saveProductOptions(data, 'legacy-version')
    expect(api.invoke).toHaveBeenLastCalledWith('save_product_option_settings', { bundle: expected, expectedVersion: 'legacy-version' })
    expect(data).toEqual(before)
  }
})

test('product options expose no rule editor and preview allows technique and film together', async () => {
  const data = clone(initialBundle); const product = allProducts(data.main)[0]
  product.productOptions.forEach(option => { option.deleted = false; delete option.disabledValues })
  Object.assign(product, { optionRules: [{ when: { option: 'Technique', value: { techniqueId: 'G1' } }, hide: [{ option: 'Holo Film', values: [{ holoFilmId: 'M7' }] }] }] })
  api.invoke.mockImplementation(async command => command === 'load_product_option_settings' ? { bundle: clone(data), version: 'v1', directory: 'test' } : { version: 'v2', directory: 'test' })
  render(<ProductOptionsSettings/>); await screen.findByLabelText('产品中文名')
  fireEvent.click(screen.getByRole('button', { name: /^滴胶工艺已/ }))
  expect(screen.queryByText('联动选项')).toBeNull()
  expect(screen.queryByRole('combobox', { name: /添加联动|隐藏全息膜/ })).toBeNull()
  await select('预览亚克力全息膜', '双面彩虹镭射')
  await select('预览滴胶工艺', '无附加工艺')
  const previewPanel = document.querySelector('.po-preview') as HTMLElement
  expect(previewPanel.textContent).toContain('双面彩虹镭射')
  await select('预览滴胶工艺', '正面滴胶')
  expect(previewPanel.textContent).toContain('双面彩虹镭射')
  fireEvent.change(screen.getByLabelText('产品中文名'), { target: { value: '无联动测试产品' } })
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const saved = api.invoke.mock.calls.at(-1)![1].bundle
  expect(allProducts(saved.main)[0]).not.toHaveProperty('optionRules')
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
  setEnabled(a, { printOptionId: 'Y1' }, false)
  expect(a.disabledValues).toContainEqual({ printOptionId: 'Y1' }); expect(isEnabled(b, { printOptionId: 'Y1' })).toBe(true)
  expect(data.catalogs).toEqual(original)
  setEnabled(a, { printOptionId: 'Y1' }, true); expect(a.disabledValues).toBeUndefined()
  validateBundle(data)
})
test('ordering allows duplicate ranks, inserts after current peers, preserves gaps through serialization', () => {
  const data = clone(initialBundle); const root = data.catalogs['techniques.json']
  changeOrder(root.values, { techniqueId: 'G12' }, 1)
  expect(ordered(root.values).slice(0, 3).map(value => getEntityId(value))).toEqual(['G1', 'G12', 'G11'])
  changeOrder(root.values, { techniqueId: 'G11' }, 1)
  expect(ordered(root.values).slice(0, 3).map(value => getEntityId(value))).toEqual(['G1', 'G12', 'G11'])
  changeOrder(root.values, { techniqueId: 'G11' }, 40)
  expect(parseImport(JSON.stringify(data), data).catalogs['techniques.json'].values.at(-1)?.sortOrder).toBe(40)
})

test('moving option cards follows the displayed order despite unsorted storage and duplicate ranks', () => {
  const values = clone(initialBundle.catalogs['sizes.json'].values.slice(0, 4))
  values.forEach((value, index) => { value.sortOrder = [40, 2, 2, 9][index] })
  const before = clone(values)
  expect(ordered(values).map(getEntityId)).toEqual(['keychain-3-in', 'keychain-4-in', 'sticker-5x5-in', 'keychain-2-in'])
  expect(moveOptionValue(values, { sizeBandId: 'keychain-2-in' }, { sizeBandId: 'keychain-4-in' }, 'before')).toBe(true)
  expect(values.map(getEntityId)).toEqual(['keychain-3-in', 'keychain-2-in', 'keychain-4-in', 'sticker-5x5-in'])
  expect(values.map(value => value.sortOrder)).toEqual([1, 2, 3, 4])
  for (const original of before) {
    const value = values.find(value => getEntityId(value) === getEntityId(original))!
    expect({ ...value, sortOrder: original.sortOrder }).toEqual(original)
  }
  expect(moveOptionValue(values, { sizeBandId: 'keychain-2-in' }, { sizeBandId: 'sticker-5x5-in' }, 'after')).toBe(true)
  expect(values.map(getEntityId)).toEqual(['keychain-3-in', 'keychain-4-in', 'sticker-5x5-in', 'keychain-2-in'])
  expect(values.map(value => value.sortOrder)).toEqual([1, 2, 3, 4])
})

test('invalid or unchanged card moves preserve stored ranks and reject foreign entity references', () => {
  const values = clone(initialBundle.catalogs['sizes.json'].values.slice(0, 3))
  values.forEach((value, index) => { value.sortOrder = [2, 2, 40][index] })
  const before = clone(values)
  const first = entityReference(values[0]); const second = entityReference(values[1])
  expect(moveOptionValue([], first, second, 'before')).toBe(false)
  expect(moveOptionValue(values, first, first, 'after')).toBe(false)
  expect(moveOptionValue(values, first, second, 'before')).toBe(false)
  expect(moveOptionValue(values, second, first, 'after')).toBe(false)
  expect(moveOptionValue(values, { sizeBandId: 'missing' }, second, 'before')).toBe(false)
  expect(moveOptionValue(values, first, { sizeBandId: 'missing' }, 'after')).toBe(false)
  expect(moveOptionValue(values, { techniqueId: getEntityId(values[0]) }, second, 'before')).toBe(false)
  expect(moveOptionValue(values, first, { materialId: getEntityId(values[1]) }, 'after')).toBe(false)
  expect(values).toEqual(before)
})

test('moving accessory colors only changes their own order and retains defaults and product exclusions', () => {
  const data = clone(initialBundle)
  const catalog = data.catalogs['accessory-styles.json']
  const style = catalog.values.find(value => value.accessoryStyleId === 'P8')!
  const option = optionFor(allProducts(data.main)[0], 'Accessories Style')!
  setDefault(catalog, { accessoryColorId: 'P-C3' }, style)
  setEnabled(option, { accessoryColorId: 'P-C2' }, false)
  const before = clone(data)
  expect(moveOptionValue(style.colors!, { accessoryColorId: 'P-C1' }, { accessoryColorId: 'P-C3' }, 'after')).toBe(true)
  expect(style.colors!.slice(0, 3).map(getEntityId)).toEqual(['P-C2', 'P-C3', 'P-C1'])
  expect(style.colors!.map(value => value.sortOrder)).toEqual(Array.from({ length: style.colors!.length }, (_, index) => index + 1))
  expect(style.colors!.find(value => value.accessoryColorId === 'P-C3')!.isDefault).toBe(true)
  expect(data.main).toEqual(before.main)
  expect(catalog.values.filter(value => value.accessoryStyleId !== 'P8')).toEqual(before.catalogs['accessory-styles.json'].values.filter(value => value.accessoryStyleId !== 'P8'))
  const reordered = clone(style.colors)
  expect(moveOptionValue(style.colors!, { accessoryColorId: 'P-C27' }, { accessoryColorId: 'P-C1' }, 'after')).toBe(false)
  expect(style.colors).toEqual(reordered)
  validateBundle(data)
})
test('add/delete/defaults use monotonic short IDs and remove deleted disabled IDs from every product', () => {
  const data = clone(initialBundle); const root = data.catalogs['accessory-styles.json']
  const style = addValue(root); expect(getEntityId(style)).toBe('P28')
  const color = addValue(root, style); expect(getEntityId(color)).toBe('P-C138')
  const product = allProducts(data.main)[0]; const option = optionFor(product, root.name)!
  setEnabled(option, entityReference(style), false); setEnabled(option, entityReference(color), false)
  setDefault(root, entityReference(style)); setDefault(root, entityReference(color), style)
  expect(root.defaultValue).toEqual(entityReference(style)); expect(color.isDefault).toBe(true)
  deleteValue(data, root, style)
  expect(option.disabledValues).toBeUndefined(); expect(root.defaultValue).toBeUndefined()
  expect(getEntityId(addValue(root))).toBe('P29')
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
  const invalid = clone(data); invalid.catalogs['print-options.json'].values[1] = { ...invalid.catalogs['print-options.json'].values[0], name: 'Duplicate print option' }
  expect(() => parseImport(JSON.stringify(invalid), data)).toThrow(/ID/)
  expect(() => parseImport('{}', data)).toThrow()
  expect(data).toEqual(original)
})
test('native UI edits product and public data; save stays in settings and sends all shared catalogs', async () => {
  const busy = vi.fn()
  render(<ProductOptionsSettings onBusyChange={busy}/> )
  const title = await screen.findByLabelText('产品中文名')
  expect(screen.getByLabelText('产品 ID').textContent).toBe('productId: P1')
  expect(screen.queryByLabelText('产品类别英文名称')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /^印刷选项已/ }))
  fireEvent.click(screen.getByRole('switch', { name: '启用印刷选项' }))
  fireEvent.change(title, { target: { value: '测试产品' } })
  const row = document.querySelector('[data-value-id="Y1"]')!
  expect(row.getAttribute('data-entity-key')).toBe('printOptionId')
  expect(row.textContent).toContain('printOptionId: Y1')
  fireEvent.click(within(row as HTMLElement).getByRole('switch', { name: 'Y1启用' }))
  fireEvent.change(screen.getByLabelText('Y1值标识'), { target: { value: 'Updated Print Option' } })
  expect(within(row as HTMLElement).getByText('Updated Print Option', { selector: 'strong' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Y1中文名称'), { target: { value: '双面同图测试' } })
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const [command, request] = api.invoke.mock.calls.at(-1)!
  expect(command).toBe('save_product_option_settings'); expect(request.expectedVersion).toBe('v1')
  expect(request.bundle.main.categories[0].products[0].titleZh).toBe('测试产品')
  expect(request.bundle.main.categories[0].products[0].productId).toBe('P1')
  expect(request.bundle.main.categories[0].products[0]).not.toHaveProperty('id')
  expect(optionFor(request.bundle.main.categories[0].products[0], 'Print Option')!.disabledValues).toContainEqual({ printOptionId: 'Y1' })
  expect(request.bundle.catalogs['print-options.json'].values[0].labelZh).toBe('双面同图测试')
  expect(request.bundle.catalogs['print-options.json'].values[0].name).toBe('Updated Print Option')
  expect(request.bundle.catalogs['print-options.json'].values[0].printOptionId).toBe('Y1')
  expect(request.bundle.catalogs['print-options.json'].values[0]).not.toHaveProperty('id')
  expect(Object.keys(request.bundle.catalogs)).toHaveLength(definitions.length)
  expect(busy.mock.calls).toEqual([[true], [false]])
})

test('additional attribute editors add typed values and save independent product switches', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  const attributes = screen.getByRole('navigation', { name: '产品属性' })
  const buttons = within(attributes).getAllByRole('button')
  const labels = buttons.map(button => button.textContent!)
  expect(labels.findIndex(label => label.startsWith('马口铁全息膜'))).toBe(labels.findIndex(label => label.startsWith('贴纸全息膜')) + 1)
  expect(labels.findIndex(label => label.startsWith('马口铁材质'))).toBe(labels.findIndex(label => label.startsWith('贴纸材质')) + 1)
  for (const { label, id, key } of [
    { label: '马口铁全息膜', id: 'THF1', key: 'tinplateHoloFilmId' },
    { label: '马口铁材质', id: 'TM1', key: 'tinplateMaterialId' },
  ]) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}已`) }))
    expect(screen.getByRole('switch', { name: `启用${label}` }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('switch', { name: `启用${label}` }))
    fireEvent.click(screen.getByRole('button', { name: '新增值' }))
    fireEvent.change(screen.getByLabelText(`${id}中文名称`), { target: { value: `测试${label}` } })
    const row = document.querySelector(`[data-value-id="${id}"]`)!
    expect(row.getAttribute('data-entity-key')).toBe(key)
    expect(within(row as HTMLElement).getByRole('switch', { name: `${id}启用` }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(within(row as HTMLElement).getByRole('switch', { name: `${id}启用` }))
    await select(`预览${label}`, `测试${label}`)
  }
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const saved = api.invoke.mock.calls.at(-1)![1].bundle as typeof initialBundle
  const [first, second] = allProducts(saved.main)
  expect(saved.catalogs['tinplate-holo-films.json'].values[0]).toMatchObject({ tinplateHoloFilmId: 'THF1', labelZh: '测试马口铁全息膜' })
  expect(saved.catalogs['tinplate-materials.json'].values[0]).toMatchObject({ tinplateMaterialId: 'TM1', labelZh: '测试马口铁材质' })
  for (const name of ['Tinplate Holo Film', 'Tinplate Material']) {
    expect(optionFor(first, name)!.deleted).toBe(false)
    expect(optionFor(second, name)!.deleted).toBe(true)
  }
  validateBundle(saved)
}, 15000)

test('sizes appear first and new shared size values are closed until enabled for a product', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  const attributes = screen.getByRole('navigation', { name: '产品属性' })
  expect(attributes.querySelector(':scope > div > button')!.textContent).toMatch(/^尺寸/)
  const toggle = screen.getByRole('switch', { name: '启用尺寸' })
  if (toggle.getAttribute('aria-checked') !== 'true') fireEvent.click(toggle)
  expect(screen.getByRole('combobox', { name: '预览尺寸' })).toBeTruthy()
  expect(screen.getByRole('region', { name: '选项编辑区' }).textContent).toContain('名称、默认值和排序由所有产品共用')
  const sizeId = `S${initialBundle.catalogs['sizes.json'].nextId}`
  fireEvent.click(screen.getByRole('button', { name: '新增值' }))
  fireEvent.change(screen.getByLabelText(`${sizeId}中文名称`), { target: { value: '当前产品的新尺寸' } })
  const addedSize = document.querySelector(`[data-value-id="${sizeId}"]`)!
  expect(within(addedSize as HTMLElement).getByRole('switch', { name: `${sizeId}启用` }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(within(addedSize as HTMLElement).getByRole('switch', { name: `${sizeId}启用` }))
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const saved = api.invoke.mock.calls.at(-1)![1].bundle as typeof initialBundle
  const [first, ...others] = allProducts(saved.main)
  const size = saved.catalogs['sizes.json'].values.find(value => getEntityId(value) === sizeId)!
  expect(entityReference(size)).toEqual({ sizeBandId: sizeId })
  expect(getProductSizes(saved, first).map(getEntityId)).toContain(sizeId)
  expect(others.every(product => !isEnabled(optionFor(product, 'Size'), size))).toBe(true)
  validateBundle(saved)
})

test('size area fields convert populated dimensions and keep blank dimensions blank', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  const toggle = screen.getByRole('switch', { name: '启用尺寸' })
  if (toggle.getAttribute('aria-checked') !== 'true') fireEvent.click(toggle)
  expect((screen.getByLabelText('keychain-2-in面积宽') as HTMLInputElement).value).toBe('2')
  await select('keychain-2-in面积单位', 'mm')
  expect((screen.getByLabelText('keychain-2-in面积宽') as HTMLInputElement).value).toBe('50.8')
  expect((screen.getByLabelText('keychain-2-in面积高') as HTMLInputElement).value).toBe('50.8')
  const addedId = `S${initialBundle.catalogs['sizes.json'].nextId}`
  fireEvent.click(screen.getByRole('button', { name: '新增值' }))
  await select(`${addedId}面积单位`, 'cm')
  expect((screen.getByLabelText(`${addedId}面积宽`) as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText(`${addedId}面积高`) as HTMLInputElement).value).toBe('')
  expect(screen.getByRole('switch', { name: 'size-custom启用' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('switch', { name: 'size-custom启用' }))
  await select('预览尺寸', '自定义')
  expect(screen.getByRole('group', { name: '预览自定义面积' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('预览自定义面积宽'), { target: { value: '2' } })
  fireEvent.change(screen.getByLabelText('预览自定义面积高'), { target: { value: '3' } })
  await select('预览自定义面积单位', 'cm')
  expect((screen.getByLabelText('预览自定义面积宽') as HTMLInputElement).value).toBe('5.08')
  expect((screen.getByLabelText('预览自定义面积高') as HTMLInputElement).value).toBe('7.62')
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
  fireEvent.click(within(popup).getByText(text, { exact: true, selector: '.ant-select-item-option-content' }))
}
function optionCard(id: string) { return document.querySelector(`[data-value-id="${id}"]`) as HTMLElement }
function displayedOptionIds() { return [...document.querySelectorAll('.po-value[data-value-id]')].map(element => element.getAttribute('data-value-id')) }
function setCardBounds(id: string, x: number, y: number) { vi.spyOn(optionCard(id), 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, 280, 160)) }
function dragEvent(type: 'dragStart' | 'dragOver' | 'drop' | 'dragEnd', element: HTMLElement, x = 0, y = 0) {
  const event = createEvent[type](element)
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } })
  fireEvent(element, event)
  return event
}

test('size card drag and keyboard sorting save order without changing dimensions defaults or product switches', async () => {
  const data = clone(initialBundle)
  setDefault(data.catalogs['sizes.json'], { sizeBandId: 'keychain-2-in' })
  setEnabled(optionFor(allProducts(data.main)[0], 'Size')!, { sizeBandId: 'keychain-4-in' }, false)
  api.invoke.mockImplementation(async command => command === 'load_product_option_settings' ? { bundle: clone(data), version: 'drag-v1', directory: 'test' } : { version: 'drag-v2', directory: 'test' })
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  expect(screen.queryByRole('spinbutton', { name: /序号/ })).toBeNull()
  setCardBounds('keychain-2-in', 0, 0)
  setCardBounds('keychain-3-in', 0, 180)
  dragEvent('dragStart', optionCard('keychain-3-in'))
  dragEvent('dragOver', optionCard('keychain-2-in'), 100, 10)
  dragEvent('drop', optionCard('keychain-2-in'), 100, 10)
  dragEvent('dragEnd', optionCard('keychain-3-in'))
  expect(displayedOptionIds().slice(0, 3)).toEqual(['keychain-3-in', 'keychain-2-in', 'keychain-4-in'])
  expect(screen.getByRole('button', { name: 'keychain-3-in排序' }).textContent).toBe('1:')
  fireEvent.keyDown(screen.getByRole('button', { name: 'keychain-4-in排序' }), { key: 'ArrowUp' })
  expect(displayedOptionIds().slice(0, 3)).toEqual(['keychain-3-in', 'keychain-4-in', 'keychain-2-in'])
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const saved = api.invoke.mock.calls.at(-1)![1].bundle as typeof initialBundle
  const sizes = saved.catalogs['sizes.json']
  expect(sizes.values.slice(0, 3).map(getEntityId)).toEqual(['keychain-3-in', 'keychain-4-in', 'keychain-2-in'])
  expect(sizes.values.map(value => value.sortOrder)).toEqual(Array.from({ length: sizes.values.length }, (_, index) => index + 1))
  expect(sizes.defaultValue).toEqual(data.catalogs['sizes.json'].defaultValue)
  for (const original of data.catalogs['sizes.json'].values) {
    const value = sizes.values.find(value => getEntityId(value) === getEntityId(original))!
    expect({ ...value, sortOrder: original.sortOrder }).toEqual(original)
  }
  const savedMain = clone(saved.main); const expectedMain = clone(data.main)
  for (const main of [savedMain, expectedMain]) for (const product of allProducts(main)) for (const option of product.productOptions) {
    option.disabledValues?.sort((left, right) => `${getEntityKey(left)}:${getEntityId(left)}`.localeCompare(`${getEntityKey(right)}:${getEntityId(right)}`))
  }
  expect(savedMain).toEqual(expectedMain)
  expect(parseImport(JSON.stringify(saved), saved)).toEqual(saved)
  validateBundle(saved)
})

test('external drops form controls and cancelled drags do not reorder cards while a same-row drop uses its horizontal position', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  const first = optionCard('keychain-2-in'); const second = optionCard('keychain-3-in')
  setCardBounds('keychain-2-in', 0, 0); setCardBounds('keychain-3-in', 300, 0)
  const initialOrder = displayedOptionIds()
  const expectUnchanged = () => {
    expect(displayedOptionIds()).toEqual(initialOrder)
    expect(screen.getByRole('button', { name: /保\s*存$/ }).hasAttribute('disabled')).toBe(true)
  }
  dragEvent('dragOver', second, 560, 20)
  dragEvent('drop', second, 560, 20)
  expectUnchanged()
  for (const control of [screen.getByLabelText('keychain-2-in中文名称'), screen.getByRole('switch', { name: 'keychain-2-in启用' }), within(first).getByRole('button', { name: /^删\s*除$/ })]) {
    dragEvent('dragStart', control)
    dragEvent('dragOver', second, 560, 20)
    dragEvent('drop', second, 560, 20)
    dragEvent('dragEnd', control)
    expectUnchanged()
  }
  dragEvent('dragStart', first.querySelector('strong')!)
  fireEvent.keyDown(first, { key: 'Escape' })
  dragEvent('drop', second, 560, 20)
  expectUnchanged()
  dragEvent('dragStart', first)
  dragEvent('dragOver', second, 560, 20)
  dragEvent('dragEnd', first)
  dragEvent('drop', second, 560, 20)
  expectUnchanged()
  dragEvent('dragStart', first.querySelector('strong')!)
  dragEvent('dragOver', second, 560, 20)
  dragEvent('drop', second, 560, 20)
  dragEvent('dragEnd', first)
  expect(displayedOptionIds().slice(0, 2)).toEqual(['keychain-3-in', 'keychain-2-in'])
  expect(screen.getByRole('button', { name: /保\s*存$/ }).hasAttribute('disabled')).toBe(false)
})

test('accessory dragging rejects style-to-color and stale parent-group drops but saves moves within one color group', async () => {
  const data = clone(initialBundle)
  optionFor(allProducts(data.main)[0], 'Accessories Style')!.deleted = false
  api.invoke.mockImplementation(async command => command === 'load_product_option_settings' ? { bundle: clone(data), version: 'colors-v1', directory: 'test' } : { version: 'colors-v2', directory: 'test' })
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  fireEvent.click(screen.getByRole('button', { name: /^配件样式已/ }))
  const styles = data.catalogs['accessory-styles.json'].values
  const firstStyle = styles.find(value => value.accessoryStyleId === 'P8')!
  const secondStyle = styles.find(value => value.accessoryStyleId === 'P9')!
  await select('编辑配件样式', `${firstStyle.sortOrder} · ${display(firstStyle)}`)
  const firstOrder = displayedOptionIds()
  dragEvent('dragStart', optionCard('P8'))
  dragEvent('dragOver', optionCard('P-C2'), 100, 150)
  dragEvent('drop', optionCard('P-C2'), 100, 150)
  dragEvent('dragEnd', optionCard('P8'))
  expect(displayedOptionIds()).toEqual(firstOrder)
  expect(screen.getByRole('button', { name: /保\s*存$/ }).hasAttribute('disabled')).toBe(true)
  dragEvent('dragStart', optionCard('P-C1'))
  await select('编辑配件样式', `${secondStyle.sortOrder} · ${display(secondStyle)}`)
  const secondOrder = displayedOptionIds()
  setCardBounds('P-C27', 0, 0); setCardBounds('P-C28', 0, 180)
  dragEvent('drop', optionCard('P-C28'), 100, 330)
  expect(displayedOptionIds()).toEqual(secondOrder)
  expect(screen.getByRole('button', { name: /保\s*存$/ }).hasAttribute('disabled')).toBe(true)
  dragEvent('dragStart', optionCard('P-C27'))
  dragEvent('dragOver', optionCard('P-C28'), 100, 330)
  dragEvent('drop', optionCard('P-C28'), 100, 330)
  dragEvent('dragEnd', optionCard('P-C27'))
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const saved = api.invoke.mock.calls.at(-1)![1].bundle as typeof initialBundle
  expect(saved.catalogs['accessory-styles.json'].values.find(value => value.accessoryStyleId === 'P8')).toEqual(firstStyle)
  const savedStyle = saved.catalogs['accessory-styles.json'].values.find(value => value.accessoryStyleId === 'P9')!
  expect(savedStyle.colors!.slice(0, 3).map(getEntityId)).toEqual(['P-C28', 'P-C27', 'P-C29'])
  expect(savedStyle.colors!.map(value => value.sortOrder)).toEqual(Array.from({ length: savedStyle.colors!.length }, (_, index) => index + 1))
  expect(saved.main).toEqual(data.main)
  validateBundle(saved)
}, 20000)

test('native controls add and edit nested colors, set defaults, reorder, disable and delete values', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  fireEvent.click(screen.getByRole('button', { name: /^配件样式已/ }))
  fireEvent.click(screen.getByRole('switch', { name: '启用配件样式' }))
  const existingStyle = initialBundle.catalogs['accessory-styles.json'].values.find(value => value.accessoryStyleId === 'P8')!
  await select('编辑配件样式', `${existingStyle.sortOrder} · ${display(existingStyle)}`)
  fireEvent.click(screen.getByRole('button', { name: '新增颜色' }))
  fireEvent.change(screen.getByLabelText('P-C138中文名称'), { target: { value: '测试蓝色' } })
  const addedColor = document.querySelector('[data-value-id="P-C138"]') as HTMLElement
  expect(within(addedColor).getByRole('switch', { name: 'P-C138启用' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(within(addedColor).getByRole('switch', { name: 'P-C138启用' }))
  fireEvent.click(screen.getByRole('switch', { name: 'P-C138默认选中' }))
  setCardBounds('P-C138', 0, 1000); setCardBounds('P-C2', 0, 180)
  dragEvent('dragStart', optionCard('P-C138'))
  dragEvent('dragOver', optionCard('P-C2'), 100, 190)
  dragEvent('drop', optionCard('P-C2'), 100, 190)
  dragEvent('dragEnd', optionCard('P-C138'))
  fireEvent.click(screen.getByRole('switch', { name: 'P-C138启用' }))
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await screen.findByText('配置已保存')
  const data = api.invoke.mock.calls.at(-1)![1].bundle
  const style = data.catalogs['accessory-styles.json'].values.find((value: { accessoryStyleId: string }) => value.accessoryStyleId === 'P8')!
  expect(style.colors.slice(0, 3).map(getEntityId)).toEqual(['P-C1', 'P-C138', 'P-C2'])
  expect(style.colors[1]).toMatchObject({ accessoryColorId: 'P-C138', labelZh: '测试蓝色', sortOrder: 2, isDefault: true })
  expect(optionFor(data.main.categories[0].products[0], 'Accessories Style')!.disabledValues).toContainEqual({ accessoryColorId: 'P-C138' })
  const row = document.querySelector('[data-value-id="P-C138"]') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: /^删\s*除$/ }))
  fireEvent.click(screen.getByRole('button', { name: /^确\s*定$/ }))
  expect(screen.queryByLabelText('P-C138中文名称')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(3))
  expect(optionFor(api.invoke.mock.calls.at(-1)![1].bundle.main.categories[0].products[0], 'Accessories Style')!.disabledValues).toBeUndefined()
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
  expect(screen.getByRole('switch', { name: '启用新选项' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('switch', { name: '启用新选项' }))
  fireEvent.click(screen.getByRole('button', { name: '新增值' }))
  expect(screen.getByLabelText('X1中文名称')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(3))
  validateBundle(api.invoke.mock.calls.at(-1)![1].bundle)
})
test('deleting and recreating a category never reuses its identity or changes existing category identities', async () => {
  render(<ProductOptionsSettings/> )
  await screen.findByLabelText('产品中文名')
  const originalIds = initialBundle.main.categories.map(category => category.name)
  const saveCategories = async () => {
    fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
    await screen.findByText('配置已保存')
    const saved = api.invoke.mock.calls.at(-1)![1].bundle
    validateBundle(saved)
    return saved.main.categories as typeof initialBundle.main.categories
  }

  fireEvent.click(screen.getByRole('button', { name: '新增产品类别' }))
  const first = await saveCategories()
  const deletedId = first.at(-1)!.name
  expect(first.slice(0, -1).map(category => category.name)).toEqual(originalIds)
  expect(originalIds).not.toContain(deletedId)

  fireEvent.click(screen.getByRole('button', { name: '删除产品类别' }))
  fireEvent.click(await screen.findByRole('button', { name: /^确\s*定$/ }))
  expect((await saveCategories()).map(category => category.name)).toEqual(originalIds)

  fireEvent.click(screen.getByRole('button', { name: '新增产品类别' }))
  const recreated = await saveCategories()
  expect(recreated.at(-1)!.name).not.toBe(deletedId)
  expect(originalIds).not.toContain(recreated.at(-1)!.name)
  expect(recreated.slice(0, -1).map(category => category.name)).toEqual(originalIds)
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
  fireEvent.click(screen.getByRole('button', { name: /^印刷选项已/ }))
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
  expect(screen.getByRole('switch', { name: 'P-C138启用' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('switch', { name: 'P-C138启用' }))
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
  fireEvent.click(screen.getByRole('button', { name: /^印刷选项已/ }))
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

test('standee quantity uses explicit IDs and physical counts independent of labels, with category defaults', () => {
  const data = clone(initialBundle); validateBundle(data)
  const catalog = data.catalogs['standee-quantities.json']
  expect(catalog.values.map(value => [getEntityId(value), value.pieceCount, value.labelZh])).toEqual([['SQ1', 1, '1片'], ['SQ2', 2, '2片'], ['SQ3', 3, '3片'], ['SQ4', 4, '4片']])
  expect(catalog.defaultValue).toEqual({ standeeQuantityId: 'SQ1' })
  for (const category of data.main.categories) for (const product of category.products) expect(optionFor(product, 'Standee Quantity')).toEqual({ name: 'Standee Quantity', deleted: category.name !== 'standees', defaultValue: { standeeQuantityId: 'SQ1' } })
  expect(data.main.uncategorizedProducts.every(product => optionFor(product, 'Standee Quantity')!.deleted)).toBe(true)
  const value = catalog.values[1]; value.name = '999'; value.labelZh = '不是数量'
  expect(getStandeePieceCount(data, { standeeQuantityId: 'SQ2' })).toBe(2)
  expect(getStandeePieceCount(data, { techniqueId: 'SQ2' })).toBeUndefined()
  expect(getStandeePieceCount(data, { standeeQuantityId: 'SQ99' })).toBeUndefined()
  validateBundle(data)
})

test('standee quantity validation rejects missing, duplicate and out-of-range counts and other-entity count fields', () => {
  for (const pieceCount of [undefined, 0, 5, 1.5, '2', NaN]) {
    const data = clone(initialBundle); Object.assign(data.catalogs['standee-quantities.json'].values[0], { pieceCount })
    expect(() => validateBundle(data)).toThrow('主体片数')
  }
  const duplicate = clone(initialBundle); duplicate.catalogs['standee-quantities.json'].values[1].pieceCount = 1
  expect(() => validateBundle(duplicate)).toThrow('数量不能重复')
  const wrongEntity = clone(initialBundle); wrongEntity.catalogs['techniques.json'].values[0].pieceCount = 2
  expect(() => validateBundle(wrongEntity)).toThrow('只能用于主体片数')
  const wrongColor = clone(initialBundle); wrongColor.catalogs['accessory-styles.json'].values.find(value => value.colors?.length)!.colors![0].pieceCount = 1
  expect(() => validateBundle(wrongColor)).toThrow('只能用于主体片数')
  const custom = clone(initialBundle); allProducts(custom.main)[0].productOptions.push({ name: 'Custom', deleted: false, labelZh: '测试', nextId: 2, values: [{ customOptionValueId: 'X1', name: 'One', sortOrder: 1, pieceCount: 1 }] })
  expect(() => validateBundle(custom)).toThrow('自定义选项值')
  const ambiguous = clone(initialBundle); Object.assign(ambiguous.catalogs['standee-quantities.json'].values[0], { techniqueId: 'SQ1' })
  expect(() => validateBundle(ambiguous)).toThrow('一个所属实体 ID')
})

test('standee quantity creation only fills unused counts and preserves monotonic IDs', () => {
  const data = clone(initialBundle); const catalog = data.catalogs['standee-quantities.json']; const before = clone(catalog)
  expect(() => addValue(catalog)).toThrow('最多四个数量值'); expect(catalog).toEqual(before)
  deleteValue(data, catalog, catalog.values[1]); const added = addValue(catalog)
  expect(added).toMatchObject({ standeeQuantityId: 'SQ5', pieceCount: 2, name: '2 pieces', labelZh: '2片' })
  expect(getStandeePieceCount(data, entityReference(added))).toBe(2)
  expect(() => addValue(catalog)).toThrow('最多四个数量值')
  validateBundle(data)
})

test('standee quantity defaults and exclusions remain product-local and support explicitly no default', () => {
  const data = clone(initialBundle); const category = data.main.categories.find(c => c.name === 'standees')!; const [a, b] = category.products; const catalog = data.catalogs['standee-quantities.json']; const before = clone(catalog)
  setStandeeQuantityDefault(a, catalog, { standeeQuantityId: 'SQ3' })
  expect(resolvePreview(data, a, {}).selectedValues['Standee Quantity']).toEqual({ standeeQuantityId: 'SQ3' })
  expect(resolvePreview(data, b, {}).selectedValues['Standee Quantity']).toEqual({ standeeQuantityId: 'SQ1' })
  setStandeeQuantityDefault(a, catalog, undefined)
  expect(resolvePreview(data, a, {}).selectedValues['Standee Quantity']).toBeUndefined()
  expect(catalog).toEqual(before)
  setEnabled(optionFor(a, 'Standee Quantity')!, { standeeQuantityId: 'SQ4' }, false)
  expect(isEnabled(optionFor(b, 'Standee Quantity'), { standeeQuantityId: 'SQ4' })).toBe(true)
  const resolved = resolvePreview(data, a, { Technique: 'G11', 'Standee Quantity': 'SQ2' })
  expect(resolved.selectedValues['Standee Quantity']).toEqual({ standeeQuantityId: 'SQ2' })
  validateBundle(data)
  setStandeeQuantityDefault(a, catalog, { standeeQuantityId: 'SQ4' }); validateBundle(data)
  expect(resolvePreview(data, a, {}).selectedValues['Standee Quantity']).toBeUndefined()
  deleteValue(data, catalog, catalog.values.find(v => getEntityId(v) === 'SQ4')!)
  expect(optionFor(a, 'Standee Quantity')!.defaultValue).toBeUndefined(); expect(optionFor(a, 'Standee Quantity')!.disabledValues).toBeUndefined()
  deleteValue(data, catalog, catalog.values.find(v => getEntityId(v) === 'SQ2')!)
  expect(a).not.toHaveProperty('optionRules'); validateBundle(data)
})

test('old bundle loading fills only missing standee data and never reopens edited switches or defaults', async () => {
  const old = clone(initialBundle); delete old.catalogs['standee-quantities.json']
  for (const p of allProducts(old.main)) p.productOptions = p.productOptions.filter(o => o.name !== 'Standee Quantity')
  const before = clone(old); const upgraded = upgradeStandeeQuantityBundle(old)
  expect(old).toEqual(before); validateBundle(upgraded)
  expect(upgraded.catalogs).toEqual(initialBundle.catalogs)
  for (const [index, product] of allProducts(upgraded.main).entries()) {
    const expected = allProducts(initialBundle.main)[index]
    expect(product).toEqual({ ...expected, productOptions: expect.arrayContaining(expected.productOptions) })
    expect(product.productOptions).toHaveLength(expected.productOptions.length)
  }
  expect(parseImport(JSON.stringify(old), initialBundle)).toEqual(upgraded)
  api.invoke.mockResolvedValueOnce({ bundle: old, version: 'old-version', directory: 'old-directory' })
  expect(await loadProductOptions()).toEqual({ bundle: upgraded, version: 'old-version', directory: 'old-directory' })
  const edited = clone(initialBundle); const product = edited.main.categories.find(c => c.name === 'standees')!.products[0]
  optionFor(product, 'Standee Quantity')!.deleted = true; delete optionFor(product, 'Standee Quantity')!.defaultValue
  edited.catalogs['standee-quantities.json'].values[0].labelZh = '我的一片'
  expect(upgradeStandeeQuantityBundle(edited)).toEqual(edited)
  const catalog = edited.catalogs['standee-quantities.json']; deleteValue(edited, catalog, catalog.values[0])
  product.productOptions = product.productOptions.filter(o => o.name !== 'Standee Quantity')
  const missingDefault = upgradeStandeeQuantityBundle(edited); validateBundle(missingDefault)
  expect(optionFor(missingDefault.main.categories.find(c => c.name === 'standees')!.products[0], 'Standee Quantity')!.defaultValue).toBeUndefined()
})

test('new standee products enable quantity only; category moves do not override an existing switch', () => {
  const data = clone(initialBundle); const catalog = data.catalogs['standee-quantities.json']
  const standee = makeProduct(data.main, 'standees', catalog)
  expect(standee.productOptions.filter(o => !o.deleted).map(o => o.name)).toEqual(['Standee Quantity'])
  const other = makeProduct(data.main, 'keychains', catalog); expect(other.productOptions.every(o => o.deleted)).toBe(true)
  data.main.categories.find(c => c.name === 'standees')!.products.push(other)
  expect(optionFor(upgradeStandeeQuantityBundle(data).main.categories.find(c => c.name === 'standees')!.products.at(-1)!, 'Standee Quantity')!.deleted).toBe(true)
  deleteValue(data, catalog, catalog.values[0]); expect(optionFor(makeProduct(data.main, 'standees', catalog), 'Standee Quantity')!.defaultValue).toBeUndefined()
})

test('standee quantity UI shows physical counts, caps additions, and edits product-local defaults', async () => {
  render(<ProductOptionsSettings/>); await screen.findByLabelText('产品中文名')
  await select('产品类别', '立牌（8）')
  fireEvent.click(screen.getByRole('button', { name: /^主体片数已/ }))
  expect(screen.getByRole('switch', { name: '启用主体片数' }).getAttribute('aria-checked')).toBe('true')
  expect((screen.getByRole('button', { name: '新增值' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByLabelText('SQ2实际主体片数') as HTMLInputElement).value).toBe('2片')
  expect((screen.getByLabelText('SQ2实际主体片数') as HTMLInputElement).readOnly).toBe(true)
  fireEvent.change(screen.getByLabelText('SQ2中文名称'), { target: { value: '双主体' } })
  fireEvent.click(screen.getByRole('switch', { name: 'SQ2默认选中' }))
  expect(screen.getByRole('switch', { name: 'SQ1默认选中' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ })); await screen.findByText('配置已保存')
  const saved = api.invoke.mock.calls.at(-1)![1].bundle
  expect(optionFor(allProducts(saved.main).find(p => p.productId === 'P23')!, 'Standee Quantity')!.defaultValue).toEqual({ standeeQuantityId: 'SQ2' })
  expect(optionFor(allProducts(saved.main).find(p => p.productId === 'P24')!, 'Standee Quantity')!.defaultValue).toEqual({ standeeQuantityId: 'SQ1' })
  expect(saved.catalogs['standee-quantities.json'].values[1]).toMatchObject({ standeeQuantityId: 'SQ2', pieceCount: 2, labelZh: '双主体', isDefault: false })
  const row = document.querySelector('[data-value-id="SQ2"]') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: /^删\s*除$/ })); fireEvent.click(await screen.findByRole('button', { name: /^确\s*定$/ }))
  expect((screen.getByRole('button', { name: '新增值' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '新增值' }))
  expect((screen.getByLabelText('SQ5实际主体片数') as HTMLInputElement).value).toBe('2片')
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ })); await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(3))
  validateBundle(api.invoke.mock.calls.at(-1)![1].bundle)
}, 15000)

test('creating a product from the standee category enables the new attribute immediately', async () => {
  render(<ProductOptionsSettings/>); await screen.findByLabelText('产品中文名')
  await select('产品类别', '立牌（8）')
  fireEvent.click(screen.getByRole('button', { name: '新增立牌产品' }))
  expect(screen.getByRole('switch', { name: '启用主体片数' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('combobox', { name: '预览主体片数' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ })); await screen.findByText('配置已保存')
  const added = api.invoke.mock.calls.at(-1)![1].bundle.main.categories.find((c: { name: string }) => c.name === 'standees').products.at(-1)
  expect(added.productOptions.filter((o: { deleted: boolean }) => !o.deleted)).toEqual([{ name: 'Standee Quantity', deleted: false, defaultValue: { standeeQuantityId: 'SQ1' } }])
}, 15000)

test('size unit changes preserve physical dimensions and leave empty fields empty', () => {
  expect(convertSizeArea({ width: '', height: '', unit: 'in' }, 'mm')).toEqual({ width: '', height: '', unit: 'mm' })
  expect(convertSizeArea({ width: '2', height: '3', unit: 'in' }, 'mm')).toEqual({ width: '50.8', height: '76.2', unit: 'mm' })
  expect(convertSizeArea({ width: '50.8', height: '', unit: 'mm' }, 'cm')).toEqual({ width: '5.08', height: '', unit: 'cm' })
  expect(convertSizeArea({ width: '5.08', height: '7.62', unit: 'cm' }, 'in')).toEqual({ width: '2', height: '3', unit: 'in' })
  expect(areaToMm2({ width: '2', height: '3', unit: 'in' })).toBe('3870.96')
  expect(areaToMm2({ width: '5.08', height: '7.62', unit: 'cm' })).toBe('3870.96')
  expect(() => areaToMm2({ width: '', height: '3', unit: 'in' })).toThrow('完整填写')
})

test('equivalent sizes merge and preserve enabled membership and shared defaults', () => {
  const before = clone(initialBundle)
  const catalog = before.catalogs['sizes.json']
  const canonical = catalog.values.find(value => value.sizeBandId === 'keychain-2-in')!
  catalog.values.push({ sizeBandId: 'sticker-2x2-in', name: '2 × 2 英寸', labelZh: '2 × 2 英寸', isDefault: true, sortOrder: 50 })
  catalog.defaultValue = { sizeBandId: 'sticker-2x2-in' }
  const product = allProducts(before.main)[0]
  const option = optionFor(product, 'Size')!
  option.deleted = false
  option.disabledValues = catalog.values.filter(value => value.sizeBandId !== 'sticker-2x2-in').map(entityReference)
  const migrated = migrateSizeAreas(before)
  expect(migrated.aliases['sticker-2x2-in']).toBe('keychain-2-in')
  expect(migrated.bundle.catalogs['sizes.json'].values.filter(value => value.sizeBandId === 'sticker-2x2-in')).toEqual([])
  expect(migrated.bundle.catalogs['sizes.json'].defaultValue).toEqual({ sizeBandId: 'keychain-2-in' })
  expect(getProductSizes(migrated.bundle, allProducts(migrated.bundle.main)[0]).map(value => value.sizeBandId)).toEqual(['keychain-2-in'])
  expect(canonical.area).toEqual({ width: '2', height: '2', unit: 'in' })
  expect(migrateSizeAreas(migrated.bundle).bundle).toEqual(migrated.bundle)
  validateBundle(migrated.bundle)
})

test('the custom size starts disabled everywhere and a later product choice remains authoritative', () => {
  const source = clone(initialBundle)
  const custom = source.catalogs['sizes.json'].values.find(value => value.isCustom)!
  expect(custom).toMatchObject({ sizeBandId: 'size-custom', area: { width: '', height: '', unit: 'in' } })
  for (const product of allProducts(source.main)) expect(isEnabled(optionFor(product, 'Size'), custom)).toBe(false)
  const selectedProduct = allProducts(source.main)[0]
  const option = optionFor(selectedProduct, 'Size')!
  option.disabledValues = option.disabledValues!.filter(value => value.sizeBandId !== custom.sizeBandId)
  const migrated = migrateSizeAreas(source).bundle
  expect(isEnabled(optionFor(allProducts(migrated.main)[0], 'Size'), custom)).toBe(true)
  expect(isEnabled(optionFor(allProducts(migrated.main)[1], 'Size'), custom)).toBe(false)
})
