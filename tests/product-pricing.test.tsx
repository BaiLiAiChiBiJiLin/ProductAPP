import { beforeEach, expect, test, vi } from 'vitest'
import { allProducts, catalogFor, clone, getEntityId, getProductSizes, isEnabled, optionFor, type Bundle } from '../src/modules/settings/product-options/model'
import { initialBundle } from '../src/modules/settings/product-options/service'
import { initialDocument as quantityDocument } from '../src/modules/settings/quantity-pricing/service'
import { cloneDocument, getReferenceIssues, isAttributePrice, isUnitPrice, pruneInvalidReferences, quoteProduct, upgradeSharedAttributePrices, upgradePricingDocument, upgradeV1, upgradeV2, upgradeV3, validateDocument, validateReferences, type AttributePrice, type DimensionPanel, type Dimensions, type PanelInput, type ProductPricingDocument, type QuoteInput } from '../src/modules/settings/product-pricing/model'
import { initialDocument, loadProductPricing, saveProductPricing, type Snapshot } from '../src/modules/settings/product-pricing/service'
import { createAreaPricing } from '../src/modules/settings/product-pricing/areaPricing'

const api = vi.hoisted(() => ({ native: true, invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => api.native, invoke: api.invoke }))
const attribute = (field: 'techniqueId' | 'holoFilmId' | 'materialId', id: string, unitPrice = '0', sizeBandId: string | null = 'keychain-2-in'): AttributePrice => ({ attributePriceId: `attribute-${field}-${id}`, techniqueId: null, holoFilmId: null, materialId: null, [field]: id, sizeBandId, unitPrice })
const fixture = (basePrice = '2.52', accessoryPrice = '0.3'): ProductPricingDocument => ({
  schemaVersion: 4, currency: 'USD',
  accessoryPricing: 'style', accessoryPrices: [{ accessoryPriceId: 'accessory-1', accessoryStyleId: 'P1', accessoryColorId: null, unitPrice: accessoryPrice }],
  products: [{ productId: 'P31', printPricing: 'included', pricingMode: 'table', fixedUnitPrice: null, basePrices: [{ basePriceId: 'base-1', sizeBandId: 'keychain-2-in', unitPrice: basePrice }], attributePrices: [attribute('techniqueId', 'G11')], legacyBodyPrices: [], dimensionPrices: [] }],
})
const request = (overrides: Partial<QuoteInput> = {}): QuoteInput => ({ productId: 'P31', techniqueId: 'G11', sizeBandId: 'keychain-2-in', accessoryStyleId: 'P1', accessoryColorId: null, quantity: 6, ...overrides })
const fixtureBundle = () => { const bundle = clone(initialBundle); optionFor(allProducts(bundle.main).find(product => product.productId === 'P31')!, 'Holo Film')!.deleted = true; return bundle }
const quote = (document = fixture(), input = request(), bundle = fixtureBundle(), tiers = quantityDocument) => quoteProduct(document, bundle, tiers, input)
const snapshot = (document = upgradeSharedAttributePrices(fixture()), bundle = fixtureBundle()): Snapshot => ({ document, bundle, quantityPricing: structuredClone(quantityDocument), version: 'v1', directory: 'D:/PrintFlow/settings/product-pricing' })
const productIn = (bundle: Bundle) => allProducts(bundle.main).find(product => product.productId === 'P31')!
const panel = (id: string): DimensionPanel => ({ panelId: id, label: '立牌', baseAdjustment: '-2.68', pieceBands: [
  { rangeId: `${id}-small`, minMm: '35', maxMm: '49', kind: 'fixed', amount: '1.85', coefficient: '0' },
  { rangeId: `${id}-medium`, minMm: '50', maxMm: '100', kind: 'fixed', amount: '2.41', coefficient: '0' },
  { rangeId: `${id}-area`, minMm: '101', maxMm: '380', kind: 'area', amount: '0.4638', coefficient: '0.000279155' },
], baseBands: [{ rangeId: `${id}-base`, minMm: '35', maxMm: '380', kind: 'fixed', amount: '2.41', coefficient: '0' }] })
const standee = (panels = [panel('panel-1')]) => { const doc = fixture(); Object.assign(doc.products[0], { pricingMode: 'standee', basePrices: [], attributePrices: [], dimensionPrices: [{ productPriceId: 'recipe-1', techniqueId: 'G11', holoFilmId: null, materialId: null, baseUnitPrice: '2.41', panels }] }); return doc }
const fifty = { widthMm: '50', heightMm: '50' }
const panelInput = (panelId = 'panel-1', standeeQuantityId: string | null = 'SQ1', pieceCount = 1): PanelInput => ({ panelId, standeeQuantityId, parts: Array.from({ length: pieceCount }, () => ({ ...fifty })), base: { ...fifty } })
const standeeBundle = () => {
  const bundle = fixtureBundle()
  const product = productIn(bundle)
  const option = optionFor(product, 'Standee Quantity')
  if (option) { option.deleted = false; option.disabledValues = [] }
  else product.productOptions.push({ name: 'Standee Quantity', deleted: false })
  return bundle
}
const oldV2 = (sizeBandId = 'keychain-2-in', productId = 'P31') => ({ schemaVersion: 2, currency: 'USD', sizeBands: [{ sizeBandId, label: '2 英寸' }], accessoryPricing: 'style', accessoryPrices: [], products: [{ productId, printPricing: 'included', pricingMode: 'table', fixedUnitPrice: null, sizeBandIds: [sizeBandId], bodyPrices: [{ productPriceId: 'old-row', techniqueId: 'G11', holoFilmId: null as string | null, materialId: null as string | null, sizeBandId, unitPrice: '3.020408163265306' }], dimensionPrices: [] }] })

beforeEach(() => { api.native = true; api.invoke.mockReset() })

test('historical prices remain archived while area pricing references the normalized product catalog', () => {
  validateDocument(initialDocument)
  validateReferences({ ...initialDocument, areaPricing: createAreaPricing(initialBundle) }, initialBundle)
  expect(initialDocument.schemaVersion).toBe(5)
  expect(initialDocument.products).toHaveLength(allProducts(initialBundle.main).length)
  expect(initialDocument.products.reduce((n, p) => n + p.basePrices.length, 0)).toBe(168)
  expect(initialDocument).not.toHaveProperty('sizeBands')
  expect(initialDocument.products.every(product => !('sizeBandIds' in product))).toBe(true)
  expect(initialDocument.products.every(p => p.legacyBodyPrices.length === 0)).toBe(true)
  const clear = quote(initialDocument, request({ sizeBandId: 'keychain-2-in', quantity: 1, holoFilmId: 'M1' }), initialBundle)
  expect(clear.bodyUnitPrice).toBe('2.816326530612245')
  expect(clear.techniqueUnitPrice).toBe('0.204081632653061')
  expect(clear.unitPrice).toBe('3.020408163265306')
  expect(initialDocument.products.flatMap(p => p.attributePrices).every(row => !['G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10'].includes(row.techniqueId ?? ''))).toBe(true)
  expect(initialDocument.products.filter(p => /^P(?:[1-4]|[6-9]|1[0-46])$/.test(p.productId)).flatMap(p => p.attributePrices).every(row => row.materialId && row.unitPrice === '0')).toBe(true)
})

test('base, three attribute additions and accessory charge once before the unchanged discount and final rounding', () => {
  expect(quote()).toEqual({ bodyUnitPrice: '2.52', techniqueUnitPrice: '0', holoFilmUnitPrice: '0', materialUnitPrice: '0', attributeUnitPrice: '0', accessoryUnitPrice: '0.3', unitPrice: '2.82', discountPercent: 35, discountedUnitPrice: '1.833', totalPrice: '11.00', quantityTierId: 'qt-keychains-2' })
  const bundle = fixtureBundle()
  for (const name of ['Holo Film', 'Material']) { const option = optionFor(productIn(bundle), name)!; option.deleted = false; option.disabledValues = [] }
  const doc = fixture('2', '0.3'); doc.products[0].attributePrices[0].unitPrice = '0.2'; doc.products[0].attributePrices.push(attribute('holoFilmId', 'M1', '0.4'), attribute('materialId', 'C1', '0.1'))
  expect(quote(doc, request({ holoFilmId: 'M1', materialId: 'C1' }), bundle)).toMatchObject({ bodyUnitPrice: '2', techniqueUnitPrice: '0.2', holoFilmUnitPrice: '0.4', materialUnitPrice: '0.1', attributeUnitPrice: '0.7', unitPrice: '3', totalPrice: '11.70' })
  expect(quote(fixture('0.005', '0'), request({ quantity: 1 })).totalPrice).toBe('0.01')
  expect(quote(fixture('3.020408163265306', '0'), request({ quantity: 50 })).totalPrice).toBe('67.96')
  expect(quote(fixture('999999999.999999999999999999', '0'), request({ quantity: 1 })).unitPrice).toBe('999999999.999999999999999999')
})

test('missing base or selected attribute never becomes free, while explicit zero is valid', () => {
  expect(() => quote({ ...fixture(), products: [] })).toThrow('尚未配置价格')
  expect(() => quote(fixture(), request({ techniqueId: 'G12' }))).toThrow('工艺未配置属性价格')
  const noBase = fixture(); noBase.products[0].basePrices = []; expect(() => quote(noBase)).toThrow('未配置主体基本价')
  expect(() => quote(fixture(), request({ techniqueId: null }))).toThrow('请选择工艺')
  expect(() => quote(fixture(), request({ sizeBandId: 'other-size' }))).toThrow('有效尺寸档')
  expect(quote(fixture('0', '0')).totalPrice).toBe('0.00')
  for (const quantity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => quote(fixture(), request({ quantity }))).toThrow('购买数量')
  expect(initialDocument.products.every(product => product.attributePrices.every(row => row.materialId !== null))).toBe(true)
  expect(initialDocument.sharedAttributePrices!.some(row => row.techniqueId === 'G16')).toBe(true)
})

test('signed attribute adjustments preserve edited low prices but reject a negative combined body', () => {
  const doc = fixture('2', '0'); doc.products[0].attributePrices[0].unitPrice = '-1.25'
  expect(quote(doc, request({ quantity: 1 }))).toMatchObject({ bodyUnitPrice: '2', techniqueUnitPrice: '-1.25', unitPrice: '0.75' })
  doc.products[0].attributePrices[0].unitPrice = '-2'; expect(quote(doc).totalPrice).toBe('0.00')
  doc.products[0].attributePrices[0].unitPrice = '-2.01'; expect(() => quote(doc)).toThrow('合计不能为负数')
})

test('quantity tiers follow category ID and boundaries after splitting', () => {
  const tiers = structuredClone(quantityDocument); tiers.categoryRules.find(rule => rule.categoryId === 'keychains')!.tiers.reverse()
  expect([5, 6, 15, 16, 49, 50].map(quantity => quote(fixture(), request({ quantity }), fixtureBundle(), tiers).discountPercent)).toEqual([0, 35, 35, 45, 45, 55])
  const moved = fixtureBundle(); const category = moved.main.categories.find(c => c.name === 'keychains')!; const product = productIn(moved)
  category.products = category.products.filter(p => p !== product); moved.main.uncategorizedProducts.push(product)
  expect(quote(fixture(), request(), moved).discountPercent).toBe(0)
})

test('enabled attributes require their own selections and ignore deprecated cross-option rules', () => {
  const bundle = fixtureBundle(); const product = productIn(bundle); const film = optionFor(product, 'Holo Film')!; film.deleted = false
  film.disabledValues = bundle.catalogs['holo-films.json'].values.filter(v => !['M1', 'M2'].includes(getEntityId(v))).map(v => ({ holoFilmId: getEntityId(v) }))
  Object.assign(product, { optionRules: [{ when: { option: 'Technique', value: { techniqueId: 'G11' } }, hide: [{ option: 'Holo Film', values: [{ holoFilmId: 'M1' }, { holoFilmId: 'M2' }] }] }] })
  const doc = fixture(); doc.products[0].attributePrices.push(attribute('holoFilmId', 'M1', '10'), attribute('holoFilmId', 'M2', '0.2'))
  validateReferences(doc, bundle)
  expect(() => quote(doc, request(), bundle)).toThrow('请选择全息膜')
  expect(quote(doc, request({ holoFilmId: 'M1' }), bundle).unitPrice).toBe('12.82')
  expect(quote(doc, request({ holoFilmId: 'M2' }), bundle).unitPrice).toBe('3.02')
  doc.products[0].attributePrices = doc.products[0].attributePrices.filter(row => row.holoFilmId !== 'M2')
  validateReferences(doc, bundle); expect(() => quote(doc, request({ holoFilmId: 'M2' }), bundle)).toThrow('全息膜未配置属性价格')
})

test('reference repair removes broken base, attribute and legacy references without affecting shared accessories', () => {
  const doc = fixture(); doc.products[0].attributePrices.push(attribute('techniqueId', 'G999')); doc.products[0].basePrices.push({ basePriceId: 'missing-size', sizeBandId: 'missing', unitPrice: '1' }); doc.accessoryPrices.push({ accessoryPriceId: 'stale', accessoryStyleId: 'P999', accessoryColorId: null, unitPrice: '9' })
  const before = cloneDocument(doc); expect(getReferenceIssues(doc, initialBundle)).toHaveLength(3)
  expect(pruneInvalidReferences(doc, initialBundle)).toEqual(fixture()); expect(doc).toEqual(before)
  const bundle = fixtureBundle(); optionFor(productIn(bundle), 'Technique')!.deleted = true
  const pruned = pruneInvalidReferences(fixture(), bundle); expect(pruned.products[0].attributePrices).toEqual([]); expect(pruned.products[0].basePrices).toEqual(fixture().products[0].basePrices)
  expect(quote(pruned, request({ techniqueId: null }), bundle).bodyUnitPrice).toBe('2.52')
})

test('shared accessories and parent-specific color IDs still respect product switches', () => {
  const bundle = fixtureBundle(); const style = bundle.catalogs['accessory-styles.json'].values.find(v => (v.colors?.length ?? 0) > 0)!; const color = style.colors![0]
  const doc = fixture('2', '0.45'); doc.accessoryPricing = 'color'; Object.assign(doc.accessoryPrices[0], { accessoryStyleId: getEntityId(style), accessoryColorId: getEntityId(color) })
  const input = request({ accessoryStyleId: getEntityId(style), accessoryColorId: getEntityId(color), quantity: 1 })
  expect(quote(doc, input, bundle).unitPrice).toBe('2.45')
  expect(() => quote(doc, { ...input, accessoryColorId: null }, bundle)).toThrow('请选择配件颜色')
  optionFor(productIn(bundle), 'Accessories Style')!.disabledValues = [{ accessoryColorId: getEntityId(color) }]
  validateReferences(doc, bundle); expect(() => quote(doc, input, bundle)).toThrow('禁用')
  expect(pruneInvalidReferences(doc, bundle).accessoryPrices).toEqual(doc.accessoryPrices)
})

test('standee calculation charges every selected part and each base exactly once', () => {
  const bundle = standeeBundle()
  const input = request({ quantity: 1, panelInputs: [{ ...panelInput('panel-1', 'SQ2', 2), parts: [fifty, { widthMm: '120', heightMm: '80' }] }] })
  expect(quote(standee(), input, bundle)).toMatchObject({ bodyUnitPrice: '7.693688', attributeUnitPrice: '0' })
  const multi = standee([panel('panel-1'), panel('panel-2')]); input.panelInputs!.push(panelInput('panel-2'))
  expect(quote(multi, input, bundle)).toMatchObject({ bodyUnitPrice: '9.833688', unitPrice: '10.133688', totalPrice: '10.13' })
  for (const panelInputs of [[panelInput()], [panelInput(), panelInput()], [panelInput(), panelInput('unexpected')]]) expect(() => quote(multi, request({ panelInputs }), bundle)).toThrow('所有尺寸面板')
  for (const heightMm of ['49.5', '381']) expect(() => quote(standee(), request({ panelInputs: [{ ...panelInput(), parts: [{ widthMm: '40', heightMm }] }] }), bundle)).toThrow('尺寸未配置价格')
  const negative = standee(); negative.products[0].dimensionPrices[0].panels[0].baseAdjustment = '-100'; expect(() => quote(negative, request({ panelInputs: [panelInput()] }), bundle)).toThrow('负主体价格')
})

test('standee quantity selects one to four parts while retaining one base per panel', () => {
  const bundle = standeeBundle()
  const doc = standee()
  const counts = [['SQ1', 1], ['SQ2', 2], ['SQ3', 3], ['SQ4', 4]] as const
  expect(counts.map(([id, count]) => quote(doc, request({ quantity: 1, panelInputs: [panelInput('panel-1', id, count)] }), bundle).bodyUnitPrice)).toEqual(['4.55', '6.96', '9.37', '11.78'])
  const multi = standee([panel('panel-1'), panel('panel-2')])
  expect(quote(multi, request({ quantity: 1, panelInputs: [panelInput('panel-1', 'SQ2', 2), panelInput('panel-2', 'SQ4', 4)] }), bundle).bodyUnitPrice).toBe('16.33')
})

test('standee quantity requires an allowed explicit selection and matching part count; disabled attributes allow one part', () => {
  const bundle = standeeBundle()
  const doc = standee()
  const input = (selected: PanelInput) => request({ quantity: 1, panelInputs: [selected] })
  expect(() => quote(doc, input(panelInput('panel-1', null)), bundle)).toThrow(/片|数量/)
  expect(() => quote(doc, input(panelInput('panel-1', 'SQ2', 1)), bundle)).toThrow(/片|数量/)
  expect(() => quote(doc, input(panelInput('panel-1', 'missing')), bundle)).toThrow(/片|数量/)
  const option = optionFor(productIn(bundle), 'Standee Quantity')!
  option.disabledValues = [{ standeeQuantityId: 'SQ2' }]
  expect(() => quote(doc, input(panelInput('panel-1', 'SQ2', 2)), bundle)).toThrow(/禁用|数量|片/)
  option.disabledValues = []
  Object.assign(productIn(bundle), { optionRules: [{ when: { option: 'Technique', value: { techniqueId: 'G11' } }, hide: [{ option: 'Standee Quantity', values: [{ standeeQuantityId: 'SQ3' }] }] }] })
  expect(quote(doc, input(panelInput('panel-1', 'SQ3', 3)), bundle).bodyUnitPrice).toBe('9.37')
  option.deleted = true
  expect(quote(doc, input(panelInput('panel-1', null)), bundle).bodyUnitPrice).toBe('4.55')
  expect(() => quote(doc, input(panelInput()), bundle)).toThrow(/未启用|片|数量/)
  expect(() => quote(doc, input(panelInput('panel-1', null, 2)), bundle)).toThrow(/片|数量/)
  option.deleted = false
  Object.assign(productIn(bundle), { optionRules: [{ when: { option: 'Standee Quantity', value: { standeeQuantityId: 'SQ2' } }, hide: [{ option: 'Technique', values: [{ techniqueId: 'G11' }] }] }] })
  expect(quote(doc, input(panelInput('panel-1', 'SQ2', 2)), bundle).bodyUnitPrice).toBe('6.96')
})

test('flat standee components quote one product-level size and preserve legacy one- and two-panel totals', () => {
  const quoteInput = (productId: string, techniqueId: string, holoFilmId: string, size: Dimensions = fifty): QuoteInput => ({ productId, techniqueId, holoFilmId, materialId: null, sizeBandId: '', accessoryStyleId: null, accessoryColorId: null, quantity: 1, standee: { standeeQuantityId: 'SQ1', parts: [{ ...size }], base: { ...size } } })
  const p23 = initialDocument.products.find(product => product.productId === 'P23')!
  expect(p23.standeePricing?.compositions.length).toBe(p23.dimensionPrices.length)
  const p23Legacy = p23.dimensionPrices.find(recipe => recipe.techniqueId === 'G1' && recipe.holoFilmId === 'M12')!
  const flat = quoteProduct(initialDocument, initialBundle, quantityDocument, quoteInput('P23', 'G1', 'M12'))
  const legacy = quoteProduct(initialDocument, initialBundle, quantityDocument, { ...quoteInput('P23', 'G1', 'M12'), standee: undefined, panelInputs: [panelInput(p23Legacy.panels[0].panelId)] })
  expect(flat.bodyUnitPrice).toBe(legacy.bodyUnitPrice)
  const p27 = initialDocument.products.find(product => product.productId === 'P27')!
  const p27Legacy = p27.dimensionPrices.find(recipe => recipe.techniqueId === 'G1' && recipe.holoFilmId === 'M12')!
  const p27Flat = quoteProduct(initialDocument, initialBundle, quantityDocument, quoteInput('P27', 'G1', 'M12'))
  const p27Old = quoteProduct(initialDocument, initialBundle, quantityDocument, { ...quoteInput('P27', 'G1', 'M12'), standee: undefined, panelInputs: p27Legacy.panels.map(panel => panelInput(panel.panelId)) })
  expect(p27Flat.bodyUnitPrice).toBe('8.34')
  expect(p27Flat.bodyUnitPrice).toBe(p27Old.bodyUnitPrice)
})

test('every migrated standee composition matches its legacy recipe at fixed and area sizes', () => {
  let checked = 0
  for (const pricing of initialDocument.products.filter(product => product.pricingMode === 'standee')) {
    for (const recipe of pricing.dimensionPrices) {
      const common = { productId: pricing.productId, techniqueId: recipe.techniqueId, holoFilmId: recipe.holoFilmId, materialId: recipe.materialId, sizeBandId: '', accessoryStyleId: null, accessoryColorId: null, quantity: 1 }
      for (const size of [fifty, { widthMm: '110', heightMm: '110' }]) {
        const flat = quoteProduct(initialDocument, initialBundle, quantityDocument, { ...common, standee: { standeeQuantityId: 'SQ1', parts: [{ ...size }], base: { ...size } } })
        const legacy = quoteProduct(initialDocument, initialBundle, quantityDocument, { ...common, panelInputs: recipe.panels.map(panel => ({ ...panelInput(panel.panelId), parts: [{ ...size }], base: { ...size } })) })
        expect(flat.bodyUnitPrice, `${pricing.productId}/${recipe.productPriceId}/${size.widthMm}`).toBe(legacy.bodyUnitPrice)
      }
      checked++
    }
  }
  expect(checked).toBe(87)
})

test('standee piece count comes from the catalog value independently of its name and ID digits', () => {
  const bundle = standeeBundle()
  const value = catalogFor(bundle, productIn(bundle), 'Standee Quantity').values.find(value => getEntityId(value) === 'SQ2')!
  Object.assign(value, { name: 'Four Pieces', labelZh: '四片，仅改名称', standeeQuantityId: 'SQ99' })
  const input = request({ quantity: 1, panelInputs: [panelInput('panel-1', 'SQ99', 2)] })
  expect(quote(standee(), input, bundle).bodyUnitPrice).toBe('6.96')
  expect(() => quote(standee(), request({ panelInputs: [panelInput('panel-1', 'SQ99', 4)] }), bundle)).toThrow(/片|数量/)
})

test('deprecated print-option rules do not affect standee quantity pricing', () => {
  const bundle = standeeBundle()
  const product = productIn(bundle)
  optionFor(product, 'Print Option')!.deleted = false
  Object.assign(product, { optionRules: [{ when: { option: 'Print Option', value: { printOptionId: 'Y1' } }, hide: [{ option: 'Standee Quantity', values: [{ standeeQuantityId: 'SQ2' }] }] }] })
  const doc = standee()
  expect(quote(doc, request({ quantity: 1, panelInputs: [panelInput('panel-1', 'SQ2', 2)] }), bundle)).toMatchObject({ bodyUnitPrice: '6.96', totalPrice: '7.26' })
  optionFor(product, 'Standee Quantity')!.deleted = true
  expect(quote(doc, request({ quantity: 1, panelInputs: [panelInput('panel-1', null)] }), bundle)).toMatchObject({ bodyUnitPrice: '4.55', totalPrice: '4.85' })
})

test('fixed colored standee keeps the one-piece price and rejects unconfigured multi-piece recipes', () => {
  const input = request({ productId: 'P25', sizeBandId: '', techniqueId: null, accessoryStyleId: null, quantity: 1, standeeQuantityId: 'SQ1' })
  expect(quote(initialDocument, input)).toMatchObject({ bodyUnitPrice: '2.68', totalPrice: '2.68' })
  expect(() => quote(initialDocument, { ...input, standeeQuantityId: null })).toThrow(/片|数量/)
  for (const standeeQuantityId of ['SQ2', 'SQ3', 'SQ4']) expect(() => quote(initialDocument, { ...input, standeeQuantityId })).toThrow(/配方|未配置/)
})

test('every retained standee recipe remains reachable', () => {
  let checked = 0
  for (const pricing of initialDocument.products.filter(p => p.pricingMode === 'standee')) {
    const product = allProducts(initialBundle.main).find(p => p.productId === pricing.productId)!
    for (const recipe of pricing.dimensionPrices) {
      const option = optionFor(product, 'Accessories Style'); const accessory = option && !option.deleted ? initialBundle.catalogs['accessory-styles.json'].values.find(v => isEnabled(option, v)) : undefined
      expect(() => quote(initialDocument, request({ productId: pricing.productId, sizeBandId: '', techniqueId: recipe.techniqueId, holoFilmId: recipe.holoFilmId, materialId: recipe.materialId, accessoryStyleId: accessory ? getEntityId(accessory) : null, quantity: 1, panelInputs: recipe.panels.map(p => panelInput(p.panelId)) }))).not.toThrow()
      checked++
    }
  }
  expect(checked).toBe(87)
})

test('fixed products require explicit attribute prices when attributes are enabled; null stays unpriced', () => {
  const doc = fixture(); Object.assign(doc.products[0], { pricingMode: 'fixed', fixedUnitPrice: '4.12', basePrices: [], attributePrices: [attribute('techniqueId', 'G11', '0.2', null)] })
  expect(quote(doc, request({ quantity: 1 })).unitPrice).toBe('4.62')
  doc.products[0].attributePrices = []; expect(() => quote(doc)).toThrow('工艺未配置属性价格')
  doc.products[0].fixedUnitPrice = null; expect(() => quote(doc)).toThrow('尚未配置固定单价')
})

test('schema enforces explicit entity IDs, one attribute per row, unique base sizes and strict money', () => {
  for (const amount of ['', '-1', '+1', ' 1', '01', '1.', '.1', '1e2', 'NaN', 'Infinity', '1000000000', '0.1234567890123456789']) { expect(isUnitPrice(amount)).toBe(false); expect(() => validateDocument(fixture(amount))).toThrow('金额') }
  expect(isAttributePrice('-0.123456789012345678')).toBe(true); expect(isAttributePrice('-1e2')).toBe(false)
  const duplicate = fixture(); duplicate.products[0].basePrices.push({ ...duplicate.products[0].basePrices[0], basePriceId: 'base-2' }); expect(() => validateDocument(duplicate)).toThrow('不能重复')
  const dimensions = fixture(); dimensions.products[0].attributePrices[0].holoFilmId = 'M1'; expect(() => validateDocument(dimensions)).toThrow('只能关联一个')
  dimensions.products[0].attributePrices[0].holoFilmId = null; dimensions.products[0].attributePrices[0].techniqueId = null; expect(() => validateDocument(dimensions)).toThrow('只能关联一个')
  const generic = fixture(); Object.assign(generic.products[0].basePrices[0], { id: 'P1' }); expect(() => validateDocument(generic)).toThrow('字段')
  const formula = fixture(); Object.assign(formula.products[0].attributePrices[0], { formula: 'qty*2' }); expect(() => validateDocument(formula)).toThrow('字段')
  const wrongSize = fixture(); wrongSize.products[0].attributePrices[0].sizeBandId = null; expect(() => validateDocument(wrongSize)).toThrow('计价方式')
  const overlap = standee(); overlap.products[0].dimensionPrices[0].panels[0].pieceBands[1].minMm = '49'; expect(() => validateDocument(overlap)).toThrow('不能重叠')
})

test('v2 migration uses audited source bases and exact signed differences, never a minimum combination', () => {
  const old = oldV2(); const before = structuredClone(old); const migrated = upgradeV2(old, initialDocument)
  expect(old).toEqual(before); expect(migrated.products[0].basePrices[0].unitPrice).toBe('2.816326530612245')
  expect(migrated.products[0].attributePrices[0]).toMatchObject({ attributePriceId: 'old-row', unitPrice: '0.204081632653061' })
  old.products[0].bodyPrices[0].unitPrice = '1.123456789012345678'
  expect(upgradeV2(old, initialDocument).products[0].attributePrices[0].unitPrice).toBe('-1.692869741599899322')
  old.products[0].bodyPrices = []; const deleted = upgradeV2(old, initialDocument).products[0]; expect(deleted.basePrices).toEqual([]); expect(deleted.attributePrices).toEqual([])
  expect(upgradeV2(migrated, initialDocument)).toEqual(migrated)
})

test('unknown products, custom dimensions and coupled old rows remain inert migration evidence', () => {
  for (const old of [oldV2('new-size'), oldV2('keychain-2-in', 'new-product'), oldV2()]) {
    if (old.products[0].productId === 'P31' && old.sizeBands[0].sizeBandId === 'keychain-2-in') old.products[0].bodyPrices[0].holoFilmId = 'M1'
    const upgraded = upgradeV2(old, initialDocument); expect(upgraded.products[0].legacyBodyPrices).toEqual(old.products[0].bodyPrices); expect(upgraded.products[0].attributePrices).toEqual([])
  }
  const doc = fixture(); doc.products[0].legacyBodyPrices.push({ productPriceId: 'pending', techniqueId: 'G11', holoFilmId: null, materialId: null, sizeBandId: 'keychain-2-in', unitPrice: '100' })
  expect(() => quote(doc)).toThrow('待拆分的旧价格')
})

test('v1 preserves custom edited rows and only fills entirely absent products from defaults', () => {
  const old = { schemaVersion: 1, currency: 'USD', sizeBands: [{ sizeBandId: 'custom', label: '自定义' }], products: [{ productId: 'P31', printPricing: 'included', accessoryPricing: 'style', accessoryPrices: [], bodyPrices: [{ productPriceId: 'edited', techniqueId: 'G11', sizeBandId: 'custom', unitPrice: '7.123456789012345678' }] }] }
  const before = structuredClone(old); const upgraded = upgradeV1(old, initialDocument)
  expect(old).toEqual(before); expect(upgraded.products[0].legacyBodyPrices).toEqual([{ ...old.products[0].bodyPrices[0], holoFilmId: null, materialId: null }]); expect(upgraded.products[0]).not.toHaveProperty('sizeBandIds')
  expect(upgraded).not.toHaveProperty('sizeBands')
  const restored = upgraded.products.find(p => p.productId === 'P36')!
  const defaultProduct = initialDocument.products.find(p => p.productId === 'P36')!
  expect(restored.basePrices).toEqual(defaultProduct.basePrices)
  expect(restored.pricingMode).toBe(defaultProduct.pricingMode)
  const shared = upgradeSharedAttributePrices(upgraded)
  expect(quote(shared, request({ productId: 'P36', quantity: 1, holoFilmId: 'M1' }), initialBundle).unitPrice).toBe(quote(initialDocument, request({ productId: 'P36', quantity: 1, holoFilmId: 'M1' }), initialBundle).unitPrice)
  old.products[0].bodyPrices = []; expect(upgradeV1(old, initialDocument).products[0].attributePrices).toEqual([])
})

test('fixed migration creates explicit zero only for existing priced products and avoids ID collisions', () => {
  const old = oldV2(); Object.assign(old.products[0], { pricingMode: 'fixed', fixedUnitPrice: '2', sizeBandIds: [], bodyPrices: [] })
  const priced = upgradeV2(old, initialDocument, initialBundle); expect(priced.products[0].attributePrices.length).toBeGreaterThan(0); expect(priced.products[0].attributePrices.every(row => row.unitPrice === '0' && row.sizeBandId === null)).toBe(true)
  Object.assign(old.products[0], { fixedUnitPrice: null }); expect(upgradeV2(old, initialDocument, initialBundle).products[0].attributePrices).toEqual([])
  const collision = oldV2(); collision.products[0].bodyPrices[0].productPriceId = 'base-P31-keychain-2-in'; const migrated = upgradeV2(collision, initialDocument)
  expect(migrated.products[0].basePrices[0].basePriceId).toBe('migrated-base-P31-keychain-2-in-1'); expect(migrated.products[0].attributePrices[0].attributePriceId).toBe('base-P31-keychain-2-in')
})

test('desktop save preserves drafts and loading accepts stale references for explicit repair', async () => {
  const loaded = snapshot(); api.invoke.mockResolvedValueOnce(loaded); expect(await loadProductPricing()).toEqual(loaded)
  const draft = cloneDocument(loaded.document); draft.sharedAttributePrices![0].unitPrice = '-0.1'; api.invoke.mockResolvedValueOnce({ ...loaded, document: draft, version: 'v2' })
  expect((await saveProductPricing(draft, 'v1')).version).toBe('v2'); expect(api.invoke.mock.calls[1]).toEqual(['save_product_pricing_settings', { document: draft, expectedVersion: 'v1' }])
  const before = cloneDocument(draft); api.invoke.mockRejectedValueOnce('配置已被修改'); await expect(saveProductPricing(draft, 'stale')).rejects.toBe('配置已被修改'); expect(draft).toEqual(before)
  const stale = snapshot(); stale.document.sharedAttributePrices![0].techniqueId = 'G999'; api.invoke.mockResolvedValueOnce(stale); expect((await loadProductPricing()).document.sharedAttributePrices![0].techniqueId).toBe('G999')
  api.invoke.mockResolvedValueOnce({ ...snapshot(), version: '' }); await expect(loadProductPricing()).rejects.toThrow('存储版本')
})

test('desktop migration preserves legacy additional prices inside whole plans and saves product plan selections without duplication', async () => {
  const source = snapshot()
  const created = createAreaPricing(source.bundle)
  const template = created.templates[0]
  template.basePrice = '0.5'
  template.tierPrices.forEach(row => { row.price = '0' })
  const legacyArea = {
    schemaVersion: 3 as const,
    accessoryPricing: created.accessoryPricing,
    templates: created.templates,
    categories: created.categories.map(category => ({ ...category, areaTemplateId: category.categoryId === 'keychains' ? template.areaTemplateId : null })),
    productOverrides: [],
    attributes: [{ areaAttributePriceId: 'legacy-G11', optionName: 'Technique', reference: { techniqueId: 'G11' }, charge: {
      areaTemplateId: template.areaTemplateId, basePrice: '0.250000000000000001', formula: '基本价 + 档位价格 * 面积平方毫米',
      tierPrices: template.tiers.map(tier => ({ areaTierId: tier.areaTierId, price: '0.000100000000000001' })),
    } }],
    accessoryPrices: created.accessoryPrices,
  }
  const before = structuredClone(legacyArea)
  source.document.areaPricing = legacyArea
  api.invoke.mockResolvedValueOnce(structuredClone(source))
  const loaded = await loadProductPricing()
  const area = loaded.document.areaPricing!
  if (area.schemaVersion !== 7) throw new Error('Expected migrated grouped pricing')
  const ordinaryPlan = area.additionalPricePlans.find(plan => plan.prices.some(price => price.areaAttributePriceId === 'legacy-G11'))!
  const ordinary = ordinaryPlan.prices.find(price => price.areaAttributePriceId === 'legacy-G11')!
  const ordinaryTemplate = area.templates.find(row => row.areaTemplateId === ordinary.areaTemplateId)!
  expect(ordinary.basePrice).toBe('0.250000000000000001')
  expect(ordinary.tierPrices.map(row => row.price)).toEqual(template.tiers.map(() => '0.000100000000000001'))
  expect(ordinaryTemplate.areaTemplateId).toBe(template.areaTemplateId)
  expect(ordinaryTemplate.basePrice).toBe('0.5')
  expect(area.categoryAdditionalPlanBindings).toContainEqual({ categoryId: 'keychains', additionalPricePlanId: ordinaryPlan.additionalPricePlanId })
  expect(source.document.areaPricing).toEqual(before)
  const special = { ...structuredClone(ordinaryPlan), additionalPricePlanId: 'special-plan', name: '特殊附加价格方案' }
  special.prices.find(price => price.areaAttributePriceId === 'legacy-G11')!.basePrice = '0.75'
  area.additionalPricePlans.push(special)
  area.productAdditionalPlanOverrides.push({ productId: 'P36', additionalPricePlanId: special.additionalPricePlanId })
  api.invoke.mockResolvedValueOnce({ ...structuredClone(loaded), version: 'v2' })
  const saved = await saveProductPricing(loaded.document, loaded.version)
  expect(api.invoke.mock.calls.at(-1)).toEqual(['save_product_pricing_settings', { document: loaded.document, expectedVersion: 'v1' }])
  api.invoke.mockResolvedValueOnce(structuredClone(saved))
  const reloaded = await loadProductPricing()
  expect(reloaded.document.areaPricing).toEqual(area)
  const reloadedArea = reloaded.document.areaPricing!
  if (reloadedArea.schemaVersion !== 7) throw new Error('Expected grouped pricing')
  expect(reloadedArea.additionalPricePlans).toHaveLength(2)
  expect(reloadedArea.templates).toHaveLength(1)
  expect(reloadedArea.additionalPricePlans.map(plan => plan.prices.find(price => price.areaAttributePriceId === 'legacy-G11')?.basePrice)).toEqual(['0.250000000000000001', '0.75'])
  expect(reloadedArea.productAdditionalPlanOverrides).toEqual([{ productId: 'P36', additionalPricePlanId: special.additionalPricePlanId }])
  for (const key of ['attributes', 'categoryAttributeBindings', 'productAttributeOverrides']) expect(Object.hasOwn(reloadedArea, key)).toBe(false)
})

test('browser preview isolates mutable data and does not write desktop storage', async () => {
  const original = cloneDocument(initialDocument)
  api.native = false; const first = await loadProductPricing(); first.document.products.find(p => p.basePrices.length)!.basePrices[0].unitPrice = '999'; first.bundle.main.categories[0].title = 'Changed'
  first.document.areaPricing!.accessoryPrices![0].unitPrice = '999'
  const next = await loadProductPricing(); expect(next.document).toEqual({ ...initialDocument, areaPricing: createAreaPricing(initialBundle, initialDocument.accessoryPrices) }); expect(next.bundle).toEqual(initialBundle)
  expect(initialDocument).toEqual(original)
  for (const { accessoryStyleId, accessoryColorId, unitPrice } of original.accessoryPrices) {
    expect(next.document.areaPricing!.accessoryPrices).toContainEqual(expect.objectContaining({ accessoryStyleId, accessoryColorId, unitPrice }))
  }
  await expect(saveProductPricing(next.document, next.version)).rejects.toThrow('桌面软件'); expect(api.invoke).not.toHaveBeenCalled()
})



test('size membership and labels belong to product options and unavailable sizes never become free', () => {
  const bundle = fixtureBundle()
  const product = productIn(bundle)
  const before = fixture()
  const size = bundle.catalogs['sizes.json'].values.find(value => value.sizeBandId === 'keychain-2-in')!
  size.name = 'renamed'; size.labelZh = '新的尺寸名称'
  expect(quote(before, request(), bundle).bodyUnitPrice).toBe('2.52')
  optionFor(product, 'Size')!.disabledValues = [{ sizeBandId: 'keychain-2-in' }]
  expect(getReferenceIssues(before, bundle).join('；')).toContain('尺寸档')
  expect(() => quote(before, request(), bundle)).toThrow('尺寸档')
  expect(before.products[0].basePrices[0].unitPrice).toBe('2.52')
  const cleaned = pruneInvalidReferences(before, bundle)
  expect(cleaned.products[0].basePrices).toEqual([])
  expect(cleaned.products[0].attributePrices).toEqual([])
  optionFor(product, 'Size')!.deleted = true
  expect(() => quote(cleaned, request({ sizeBandId: '' }), bundle)).toThrow('开启尺寸')
  expect(before).toEqual(fixture())
})

test('deprecated size and print-option rules do not change enabled size or attribute selections', () => {
  const bundle = fixtureBundle()
  const product = productIn(bundle)
  Object.assign(product, { optionRules: [{ when: { option: 'Technique', value: { techniqueId: 'G11' } }, hide: [{ option: 'Size', values: [{ sizeBandId: 'keychain-2-in' }] }] }] })
  validateReferences(fixture(), bundle)
  expect(quote(fixture(), request(), bundle).unitPrice).toBe('2.82')
  Object.assign(product, { optionRules: [{ when: { option: 'Size', value: { sizeBandId: 'keychain-2-in' } }, hide: [{ option: 'Technique', values: [{ techniqueId: 'G11' }] }] }] })
  expect(quote(fixture(), request(), bundle).unitPrice).toBe('2.82')
  Object.assign(product, { optionRules: [{ when: { option: 'Print Option', value: { printOptionId: 'Y1' } }, hide: [{ option: 'Size', values: [{ sizeBandId: 'keychain-2-in' }] }] }] })
  expect(quote(fixture(), request(), bundle).unitPrice).toBe('2.82')
  optionFor(product, 'Size')!.disabledValues = [{ sizeBandId: 'keychain-2-in' }]
  expect(() => quote(fixture(), request(), bundle)).toThrow('关联的尺寸档不存在或不属于该产品')
})

test('v3 migration removes duplicate size ownership while retaining every monetary row and rejecting invalid legacy structure', () => {
  const current = fixture('7.123456789012345678')
  const legacy = { ...structuredClone(current), schemaVersion: 3, sizeBands: [{ sizeBandId: 'keychain-2-in', label: '旧名称' }], products: current.products.map(product => ({ ...structuredClone(product), sizeBandIds: ['keychain-2-in'] })) }
  const before = structuredClone(legacy)
  expect(upgradeV3(legacy)).toEqual(current)
  expect(legacy).toEqual(before)
  legacy.sizeBands.push({ sizeBandId: 'keychain-2-in', label: '重复' })
  expect(() => upgradeV3(legacy)).toThrow('旧尺寸档')
})


test('desktop v3 loading transfers custom size ownership before upgrading prices without altering saved amounts', async () => {
  const bundle = fixtureBundle()
  delete bundle.catalogs['sizes.json']
  for (const product of allProducts(bundle.main)) product.productOptions = product.productOptions.filter(option => option.name !== 'Size')
  const current = fixture('7.123456789012345678')
  for (const row of [...current.products[0].basePrices, ...current.products[0].attributePrices]) row.sizeBandId = 'custom-old-size'
  const legacy = { ...structuredClone(current), schemaVersion: 3, sizeBands: [{ sizeBandId: 'custom-old-size', label: '客户自定义尺寸' }], products: current.products.map(product => ({ ...structuredClone(product), sizeBandIds: ['custom-old-size'] })) }
  const before = structuredClone(legacy)
  api.invoke.mockResolvedValueOnce({ ...snapshot(current, bundle), document: legacy })
  const loaded = await loadProductPricing()
  expect(loaded.document).toEqual({ ...upgradeSharedAttributePrices(current), areaPricing: createAreaPricing(loaded.bundle, current.accessoryPrices) })
  expect(legacy).toEqual(before)
  expect(loaded.document.accessoryPrices).toEqual(current.accessoryPrices)
  expect(loaded.document.areaPricing!.accessoryPrices).toContainEqual(expect.objectContaining({ accessoryStyleId: 'P1', accessoryColorId: null, unitPrice: '0.3' }))
  expect(loaded.bundle.catalogs['sizes.json'].values).toContainEqual(expect.objectContaining({ sizeBandId: 'custom-old-size', labelZh: '客户自定义尺寸' }))
  expect(optionFor(productIn(loaded.bundle), 'Size')!.deleted).toBe(false)
  expect(getProductSizes(loaded.bundle, productIn(loaded.bundle)).map(getEntityId)).toEqual(['custom-old-size'])
  const otherProduct = allProducts(loaded.bundle.main).find(product => product.productId === 'P1')!
  const originalOtherProduct = allProducts(initialBundle.main).find(product => product.productId === 'P1')!
  expect(getProductSizes(loaded.bundle, otherProduct).map(getEntityId)).toEqual(getProductSizes(initialBundle, originalOtherProduct).map(getEntityId))
  expect(getProductSizes(loaded.bundle, otherProduct).map(getEntityId)).not.toContain('custom-old-size')
  expect(quote(loaded.document, request({ sizeBandId: 'custom-old-size' }), loaded.bundle).bodyUnitPrice).toBe('7.123456789012345678')
})


test('fixed and standee modes require enabled valid size selections whenever the product enables Size', () => {
  const bundle = standeeBundle()
  const product = productIn(bundle)
  const fixed = fixture()
  Object.assign(fixed.products[0], { pricingMode: 'fixed', fixedUnitPrice: '4', basePrices: [], attributePrices: [attribute('techniqueId', 'G11', '0.2', null)] })
  const sizedStandee = standee()
  for (const document of [fixed, sizedStandee]) {
    const input = request({ quantity: 1, standeeQuantityId: document.products[0].pricingMode === 'fixed' ? 'SQ1' : null, panelInputs: [panelInput()] })
    expect(() => quote(document, { ...input, sizeBandId: '' }, bundle)).toThrow('有效尺寸档')
    expect(() => quote(document, { ...input, sizeBandId: 'missing' }, bundle)).toThrow('有效尺寸档')
    expect(() => quote(document, input, bundle)).not.toThrow()
    Object.assign(product, { optionRules: [{ when: { option: 'Technique', value: { techniqueId: 'G11' } }, hide: [{ option: 'Size', values: [{ sizeBandId: 'keychain-2-in' }] }] }] })
    expect(() => quote(document, input, bundle)).not.toThrow()
    optionFor(product, 'Size')!.deleted = true
    expect(() => quote(document, input, bundle)).toThrow('清空尺寸选择')
    expect(() => quote(document, { ...input, sizeBandId: '' }, bundle)).not.toThrow()
    optionFor(product, 'Size')!.deleted = false
  }
})


test('shared technique and film prices apply across products while material and base prices remain product-specific', () => {
  const source = fixture('2', '0')
  source.products[0].attributePrices = [attribute('techniqueId', 'G11', '0.2'), attribute('holoFilmId', 'M1', '0.4'), attribute('materialId', 'C1', '0.1')]
  const second = structuredClone(source.products[0])
  second.productId = 'P36'; second.basePrices[0] = { ...second.basePrices[0], basePriceId: 'base-second', unitPrice: '4' }
  second.attributePrices = second.attributePrices.map(row => ({ ...row, attributePriceId: `${row.attributePriceId}-second`, unitPrice: row.materialId ? '0.7' : row.unitPrice }))
  source.products.push(second)
  const bundle = fixtureBundle()
  for (const product of allProducts(bundle.main).filter(product => ['P31', 'P36'].includes(product.productId))) for (const name of ['Technique', 'Holo Film', 'Material']) {
    const option = optionFor(product, name)!; option.deleted = false; option.disabledValues = []
  }
  const document = upgradeSharedAttributePrices(source)
  const input = request({ quantity: 1, holoFilmId: 'M1', materialId: 'C1' })
  expect(document.sharedAttributePrices).toHaveLength(2)
  expect(document.products.map(product => product.attributePrices.map(row => row.materialId))).toEqual([['C1'], ['C1']])
  expect(quote(document, input, bundle).unitPrice).toBe('2.7')
  expect(quote(document, { ...input, productId: 'P36' }, bundle).unitPrice).toBe('5.3')
  document.sharedAttributePrices!.find(row => row.techniqueId === 'G11')!.unitPrice = '0.6'
  document.sharedAttributePrices!.find(row => row.holoFilmId === 'M1')!.unitPrice = '-0.1'
  expect(quote(document, input, bundle)).toMatchObject({ bodyUnitPrice: '2', techniqueUnitPrice: '0.6', holoFilmUnitPrice: '-0.1', materialUnitPrice: '0.1', unitPrice: '2.6' })
  expect(quote(document, { ...input, productId: 'P36' }, bundle)).toMatchObject({ bodyUnitPrice: '4', techniqueUnitPrice: '0.6', holoFilmUnitPrice: '-0.1', materialUnitPrice: '0.7', unitPrice: '5.2' })
})

test('shared prices require an exact entity and size key and an explicit zero, with no fallback to size-independent prices', () => {
  const document = upgradeSharedAttributePrices(fixture('2', '0'))
  document.sharedAttributePrices![0].sizeBandId = null
  expect(() => quote(document)).toThrow('工艺未配置属性价格')
  document.sharedAttributePrices!.push({ sharedAttributePriceId: 'shared-table', techniqueId: 'G11', holoFilmId: null, sizeBandId: 'keychain-2-in', unitPrice: '0' })
  expect(quote(document).bodyUnitPrice).toBe('2')
  const fixed = cloneDocument(document)
  Object.assign(fixed.products[0], { pricingMode: 'fixed', fixedUnitPrice: '3', basePrices: [] })
  fixed.sharedAttributePrices = fixed.sharedAttributePrices!.filter(row => row.sizeBandId !== null)
  expect(() => quote(fixed)).toThrow('工艺未配置属性价格')
  fixed.sharedAttributePrices.push({ sharedAttributePriceId: 'shared-fixed', techniqueId: 'G11', holoFilmId: null, sizeBandId: null, unitPrice: '0' })
  expect(quote(fixed).unitPrice).toBe('3')
  const bundle = fixtureBundle(); optionFor(productIn(bundle), 'Technique')!.deleted = true
  expect(pruneInvalidReferences(document, bundle).sharedAttributePrices).toEqual(document.sharedAttributePrices)
  expect(quote(document, request({ techniqueId: null }), bundle).unitPrice).toBe('2')
})

test('shared attributes never add to standee recipes that already include the chosen combination', () => {
  const document = upgradeSharedAttributePrices(standee())
  const input = request({ quantity: 1, panelInputs: [panelInput()] })
  const baseline = quote(document, input, standeeBundle())
  document.sharedAttributePrices = [
    { sharedAttributePriceId: 'ignored-sized', techniqueId: 'G11', holoFilmId: null, sizeBandId: 'keychain-2-in', unitPrice: '999' },
    { sharedAttributePriceId: 'ignored-fixed', techniqueId: 'G11', holoFilmId: null, sizeBandId: null, unitPrice: '888' },
  ]
  expect(quote(document, input, standeeBundle())).toEqual(baseline)
  expect(baseline).toMatchObject({ techniqueUnitPrice: '0', holoFilmUnitPrice: '0', attributeUnitPrice: '0' })
})

test('schema-five migration preserves first exact source amounts within tolerance, rejects real conflicts, and keeps material local', () => {
  const source = fixture()
  source.products[0].attributePrices[0].unitPrice = '0.123456789012345678'
  source.products[0].attributePrices.push(attribute('materialId', 'C1', '-0.1'))
  const second = structuredClone(source.products[0]); second.productId = 'P36'
  second.basePrices[0].basePriceId += '-second'
  second.attributePrices = second.attributePrices.map(row => ({ ...row, attributePriceId: `${row.attributePriceId}-second`, unitPrice: row.materialId ? '3' : '0.123456789013345678' }))
  source.products.push(second)
  const before = cloneDocument(source)
  const migrated = upgradeSharedAttributePrices(source)
  expect(source).toEqual(before)
  expect(migrated.sharedAttributePrices).toEqual([{ sharedAttributePriceId: 'attribute-techniqueId-G11', techniqueId: 'G11', holoFilmId: null, sizeBandId: 'keychain-2-in', unitPrice: '0.123456789012345678' }])
  expect(migrated.products.map(product => product.attributePrices.map(row => row.unitPrice))).toEqual([['-0.1'], ['3']])
  expect(upgradePricingDocument(migrated, initialDocument)).toEqual(migrated)
  second.attributePrices[0].unitPrice = '0.123456789013345679'
  expect(() => upgradeSharedAttributePrices(source)).toThrow(/公共价格迁移冲突.*G11.*keychain-2-in.*P31.*P36/)
})

test('schema-five rejects duplicate shared keys, ambiguous identities, missing fields and product-local technique fees', () => {
  const document = upgradeSharedAttributePrices(fixture())
  const duplicate = cloneDocument(document)
  duplicate.sharedAttributePrices!.push({ ...duplicate.sharedAttributePrices![0], sharedAttributePriceId: 'other-row' })
  expect(() => validateDocument(duplicate)).toThrow('不能重复')
  for (const patch of [{ techniqueId: null }, { holoFilmId: 'M1' }, { id: 'ambiguous' }, { materialId: 'C1' }]) {
    const invalid = cloneDocument(document); Object.assign(invalid.sharedAttributePrices![0], patch)
    expect(() => validateDocument(invalid)).toThrow()
  }
  const missing = cloneDocument(document); delete missing.sharedAttributePrices
  expect(() => validateDocument(missing)).toThrow()
  const local = cloneDocument(document); local.products[0].attributePrices = [{ ...attribute('techniqueId', 'G11'), attributePriceId: 'invalid-local-technique' }]
  expect(() => validateDocument(local)).toThrow('公共价格')
})

test('longest-side templates and their product and attribute bindings survive service save and reload without changing area templates', async () => {
  const bundle = clone(initialBundle)
  const area = createAreaPricing(bundle)
  const ordinary = structuredClone(area.templates[0])
  const longest = structuredClone(ordinary)
  longest.areaTemplateId = 'longest-service-template'
  longest.name = '最长边服务往返'
  longest.matchBy = 'longest-side'
  longest.unit = 'mm'
  longest.boundaryMode = 'upper-inclusive'
  longest.basePrice = '0.4638'
  longest.formula = '基本价 + 档位价格 * 最长边毫米'
  longest.tiers = [{ areaTierId: 'longest-small', maxArea: '50.8' }, { areaTierId: 'longest-large', maxArea: null }]
  longest.tierPrices = [{ areaTierId: 'longest-small', price: '0.000279155123456789' }, { areaTierId: 'longest-large', price: null }]
  area.templates.push(longest)
  area.categories.find(category => category.categoryId === 'standees')!.areaTemplateId = longest.areaTemplateId
  area.productOverrides.push({ productId: 'P31', areaTemplateId: longest.areaTemplateId })
  area.additionalPricePlans.push({ additionalPricePlanId: 'longest-plan', name: '最长边附加方案', prices: [{ areaAttributePriceId: 'longest-technique', optionName: 'Technique', reference: { techniqueId: 'G11' }, areaTemplateId: longest.areaTemplateId, basePrice: '0.15', tierPrices: [{ areaTierId: 'longest-small', price: '0.001123456789012345' }, { areaTierId: 'longest-large', price: null }] }] })
  area.categoryAdditionalPlanBindings.push({ categoryId: 'keychains', additionalPricePlanId: 'longest-plan' })
  area.productTotalFormulas.push({ productId: 'P31', formula: '(大类主体价 + 属性价 + 配件价 + 0.25) * 折扣系数 * 数量' })
  let storage = snapshot({ ...cloneDocument(initialDocument), areaPricing: area }, bundle)
  api.invoke.mockImplementation(async (command, request) => {
    if (command === 'load_product_pricing_settings') return structuredClone(storage)
    if (command === 'save_product_pricing_settings') {
      storage = { ...storage, document: structuredClone(request.document), version: 'v2' }
      return structuredClone(storage)
    }
    throw new Error(`Unexpected command: ${command}`)
  })
  const first = await loadProductPricing()
  expect(first.document.areaPricing).toEqual(area)
  const saved = await saveProductPricing(first.document, first.version)
  const reloaded = await loadProductPricing()
  expect(reloaded.document.areaPricing).toEqual(saved.document.areaPricing)
  expect(reloaded.document.areaPricing).toEqual(area)
  expect(reloaded.document.areaPricing!.templates[0]).toEqual(ordinary)
  expect(reloaded.document.areaPricing!.templates[1]).toEqual(longest)
  expect(Object.hasOwn(reloaded.document.areaPricing!.templates[0], 'matchBy')).toBe(false)
})
