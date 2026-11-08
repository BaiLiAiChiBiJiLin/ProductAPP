import { describe, expect, test } from 'vitest'
import { allProducts, catalogFor, clone, getEntityId, optionFor, type EntityReference } from '../src/modules/settings/product-options/model'
import { initialBundle } from '../src/modules/settings/product-options/service'
import { displayPricingFormula, storePricingFormula } from '../src/modules/settings/product-pricing/formulaDisplay'
import type { QuantityPricingDocument } from '../src/modules/settings/quantity-pricing/model'
import {
  AREA_TOTAL_VARIABLES,
  areaSquareMm,
  convertAreaValue,
  convertLengthValue,
  createAreaPricing,
  createAdditionalPricePlan,
  additionalPlanMatchesTemplate,
  getAdditionalAttributePrices,
  resolveProductAdditionalPlan,
  createAreaCharge,
  createDefaultAreaTemplate,
  createPricedAreaTemplate,
  getTemplatePriceCharge,
  getAttributePlanCharge,
  createAttributePlanPrices,
  getDefaultTemplateFormula,
  getProductTotalVariables,
  getDefaultProductTotalFormula,
  resolveProductTotalFormula,
  getTemplateMatchBy,
  templateUnitLabel,
  getTemplateFormulaVariables,
  getAreaTierBounds,
  resolveProductBaseTemplate,
  resolveProductAttributePlan,
  DEFAULT_AREA_FORMULA,
  DEFAULT_TOTAL_FORMULA,
  getAreaCharges,
  getAreaPricingCategories,
  getProductPricingCategory,
  areaTierLabel,
  upgradeAreaPricing,
  evaluateAreaFormula,
  quoteAreaProduct,
  validateAreaFormula,
  validateAreaPricing,
  validateAreaReferences,
  type AreaCharge,
  type AreaQuoteInput,
  type AreaTemplate,
  type PricedAreaTemplate,
  type LegacyAreaPricingDocument,
  type LegacyIndependentAreaPricingDocument,
  type LegacyCategoryAreaPricingDocument,
  type LegacyPricedAreaPricingDocument,
  type LegacySchemeAreaPricingDocument,
} from '../src/modules/settings/product-pricing/areaPricing'

const noDiscount: QuantityPricingDocument = { schemaVersion: 1, categoryRules: [] }

test('renamed attribute formula labels preserve stored variables and custom arithmetic', () => {
  const stored = '(大类主体价 + 工艺价 * 2 + 全息膜价 + 材质价) * 数量'
  const visible = '(产品单价 + 滴胶工艺价 * 2 + 亚克力全息膜价 + 贴纸材质价) * 数量'
  expect(displayPricingFormula(stored)).toBe(visible)
  expect(storePricingFormula(visible)).toBe(stored)
  expect(displayPricingFormula(visible)).toBe(visible)
})

test('new attribute catalogs quote independently only after the product enables their values', () => {
  const { bundle, product, document: old, input, charge } = fixture()
  const added = [
    { name: 'Foil Stamping', reference: { foilStampingId: 'FS1' }, variable: '烫金工艺价', price: '0.4' },
    { name: 'Sticker Holo Film', reference: { stickerHoloFilmId: 'SHF1' }, variable: '贴纸全息膜价', price: '0.5' },
    { name: 'Tinplate Holo Film', reference: { tinplateHoloFilmId: 'THF1' }, variable: '马口铁全息膜价', price: '0.6' },
  ] as const
  for (const item of added) {
    catalogFor(bundle, product, item.name).values.push({ ...item.reference, name: item.name, labelZh: '测试值', sortOrder: 1 })
    expect(optionFor(product, item.name)?.deleted).toBe(true)
    expect(getProductTotalVariables(bundle, product.productId)).not.toContain(item.variable)
  }
  const document = upgradeAreaPricing(old, bundle)
  const plan = createAdditionalPricePlan(bundle, document.templates[0])
  document.additionalPricePlans.push(plan)
  document.categoryAdditionalPlanBindings.push({ categoryId: 'keychains', additionalPricePlanId: plan.additionalPricePlanId })
  input.quantity = 2
  const quote = () => quoteAreaProduct(document, bundle, noDiscount, input)
  expect(quote().totalPrice).toBe('6.00')
  for (const item of added) {
    const price = plan.prices.find(row => row.optionName === item.name)!
    expect(price.reference).toEqual(item.reference)
    expect(price.tierPrices.every(tier => tier.price === null)).toBe(true)
    Object.assign(optionFor(product, item.name)!, { deleted: false, disabledValues: [] })
    input.selections[item.name] = getEntityId(item.reference)
    expect(() => quote()).toThrow('未定价')
    charge(price, item.price, '0')
  }
  expect(() => validateAreaReferences(document, bundle)).not.toThrow()
  expect(quote()).toMatchObject({ totalPrice: '9.00', variables: { 烫金工艺价: '0.4', 贴纸全息膜价: '0.5', 马口铁全息膜价: '0.6', 属性价: '1.5' } })
  expect(quote().steps.filter(step => added.some(item => item.name === step.optionName))).toHaveLength(3)
  optionFor(product, 'Foil Stamping')!.deleted = true
  expect(() => quote()).toThrow('未启用烫金工艺')
  delete input.selections['Foil Stamping']
  expect(quote().totalPrice).toBe('8.20')
  expect(quote().variables).not.toHaveProperty('烫金工艺价')
  plan.prices.find(row => row.optionName === 'Sticker Holo Film')!.reference = { holoFilmId: 'M2' }
  expect(() => validateAreaReferences(document, bundle)).toThrow()
})

function standeeFixture() {
  const bundle = clone(initialBundle)
  const product = allProducts(bundle.main).find(row => row.productId === 'P24')!
  product.productOptions.forEach(option => { option.deleted = true })
  Object.assign(optionFor(product, 'Standee Quantity')!, { deleted: false, disabledValues: [] })
  const document = createAreaPricing(bundle)
  const template: PricedAreaTemplate = {
    areaTemplateId: 'standee-test', name: '逐片及底座模板', matchBy: 'longest-side', unit: 'mm',
    tiers: ['50', '100', null].map((maxArea, index) => ({ areaTierId: `piece-${index}`, maxArea })),
    basePrice: '0.5', formula: '基本价 + 档位价格',
    tierPrices: ['2', '3', '4'].map((price, index) => ({ areaTierId: `piece-${index}`, price })),
    standeeBase: {
      matchBy: 'longest-side', unit: 'mm',
      tiers: ['40', '80', null].map((maxArea, index) => ({ areaTierId: `base-${index}`, maxArea })),
      basePrice: '0.1', formula: '基本价 + 档位价格',
      tierPrices: ['0.7', '1.2', '1.8'].map((price, index) => ({ areaTierId: `base-${index}`, price })),
    },
  }
  document.templates = [template]
  const categoryId = getProductPricingCategory(bundle, product.productId)!.categoryId
  document.categories.forEach(category => { category.areaTemplateId = category.categoryId === categoryId ? template.areaTemplateId : null })
  const input: AreaQuoteInput = {
    productId: product.productId, width: '', height: '', unit: 'mm', selections: {}, quantity: 1, standeeQuantityId: 'SQ2',
    standee: { parts: [{ width: '30', height: '40', unit: 'mm' }, { width: '70', height: '30', unit: 'mm' }], base: { width: '60', height: '30', unit: 'mm' } },
  }
  const quote = (quantityPricing = noDiscount) => quoteAreaProduct(document, bundle, quantityPricing, input)
  return { bundle, product, document, template, input, quote, categoryId }
}
function fixture() {
  const bundle = clone(initialBundle)
  const product = allProducts(bundle.main).find(product => product.productId === 'P31')!
  for (const option of product.productOptions) option.deleted = true
  const { productAdjustments: _adjustments, additionalPricePlans: _plans, categoryAdditionalPlanBindings: _bindings, productAdditionalPlanOverrides: _overrides, schemaVersion: _version, ...shared } = createAreaPricing(bundle)
  const document: LegacyIndependentAreaPricingDocument = { ...shared, schemaVersion: 5, attributes: [], categoryAttributeBindings: [], productAttributeOverrides: [] }
  // Keep the historical template explicit so its boundary compatibility stays covered.
  const template = createPricedAreaTemplate({
    areaTemplateId: 'area-template-legacy-test', name: '历史面积档位', unit: 'in',
    tiers: [
      { areaTierId: 'area-tier-10', maxArea: '10' },
      { areaTierId: 'area-tier-20', maxArea: '20' },
      { areaTierId: 'area-tier-unlimited', maxArea: null },
    ],
  })
  document.templates = [template]
  for (const charge of getAreaCharges(document)) {
    Object.assign(charge, createAreaCharge(template))
  }
  document.categories.find(category => category.categoryId === 'keychains')!.areaTemplateId = template.areaTemplateId
  const pricing = { body: template }
  const charge = (value: Pick<AreaCharge, 'basePrice' | 'tierPrices'>, basePrice = '2', price = '0.005') => {
    value.basePrice = basePrice
    for (const tier of value.tierPrices) tier.price = price
  }
  charge(pricing.body)
  const input: AreaQuoteInput = { productId: 'P31', width: '20', height: '10', unit: 'mm', selections: {}, quantity: 1 }
  const quote = () => quoteAreaProduct(document, bundle, noDiscount, input)
  return { bundle, product, document, pricing, charge, input, quote }
}

function sTemplateFixture() {
  const state = fixture()
  const template = createPricedAreaTemplate({
    areaTemplateId: 'area-template-s', name: 'S 面积档位', unit: 'cm', boundaryMode: 'lower-inclusive',
    tiers: ['10', '20', '40', '100', null].map((maxArea, index) => ({ areaTierId: `s-tier-${index}`, maxArea })),
  })
  state.document.templates.push(template)
  state.document.categories.find(category => category.categoryId === 'keychains')!.areaTemplateId = template.areaTemplateId
  const pricing = { body: template }
  pricing.body.basePrice = '0.5'
  pricing.body.formula = '基本价 + 档位价格 * (面积平方毫米 / 100)'
  const coefficients = ['0.13', '0.08', '0.055', '0.04', '0.028']
  pricing.body.tierPrices.forEach((row, index) => { row.price = coefficients[index] })
  return { ...state, pricing, template }
}

function legacyFixture(state = fixture()) {
  const { categories: _categories, productOverrides: _overrides, categoryAttributeBindings: _bindings, productAttributeOverrides: _attributeOverrides, productTotalFormulas: _totalFormulas, attributes, schemaVersion: _schemaVersion, templates: pricedTemplates, ...shared } = state.document
  const templates = pricedTemplates.map(({ basePrice: _base, tierPrices: _prices, formula: _formula, ...template }) => template)
  const document: LegacyAreaPricingDocument = {
    ...shared,
    attributes: attributes.map(attribute => ({ areaAttributePriceId: attribute.areaAttributePriceId, optionName: attribute.optionName, reference: attribute.reference, charge: structuredClone(getAttributePlanCharge(attribute, pricedTemplates.find(row => row.areaTemplateId === attribute.areaTemplateId)!)) })),
    templates,
    schemaVersion: 1,
    products: allProducts(state.bundle.main).map(product => ({ productId: product.productId, body: createAreaCharge(templates[0]), totalFormula: '(主体价) * 折扣系数 * 数量' })),
  }
  const pricing = document.products.find(row => row.productId === 'P31')!
  pricing.body = structuredClone(getTemplatePriceCharge(state.pricing.body))
  return { ...state, document, pricing, quote: () => quoteAreaProduct(document, state.bundle, noDiscount, state.input) }
}

function categoryLegacyFixture(state = fixture()) {
  const { categories, productOverrides: _overrides, categoryAttributeBindings: _bindings, productAttributeOverrides: _attributeOverrides, productTotalFormulas: _totalFormulas, attributes, schemaVersion: _schemaVersion, templates: pricedTemplates, ...shared } = state.document
  const templates: AreaTemplate[] = pricedTemplates.map(({ basePrice: _base, tierPrices: _prices, formula: _formula, ...template }) => template)
  const document: LegacyCategoryAreaPricingDocument = {
    ...structuredClone(shared), schemaVersion: 2, templates,
    attributes: attributes.map(attribute => ({ areaAttributePriceId: attribute.areaAttributePriceId, optionName: attribute.optionName, reference: attribute.reference, charge: structuredClone(getAttributePlanCharge(attribute, pricedTemplates.find(row => row.areaTemplateId === attribute.areaTemplateId)!)) })),
    categories: categories.map(category => ({ categoryId: category.categoryId, body: category.areaTemplateId
      ? structuredClone(getTemplatePriceCharge(pricedTemplates.find(template => template.areaTemplateId === category.areaTemplateId)!))
      : createAreaCharge(templates[0]) })),
  }
  return { ...state, document }
}

function addPlan(document: LegacyIndependentAreaPricingDocument, id = 'plan-G11', reference: EntityReference = { techniqueId: 'G11' }, optionName = 'Technique') {
  const source = document.templates[0]
  const template = createPricedAreaTemplate({ ...source, areaTemplateId: `template-${id}`, name: `模板 ${id}`, tiers: source.tiers.map((tier, index) => ({ ...tier, areaTierId: `${id}-tier-${index}` })) })
  const plan = { areaAttributePriceId: id, name: `方案 ${id}`, optionName, reference, areaTemplateId: template.areaTemplateId, ...createAttributePlanPrices(template) }
  document.templates.push(template)
  document.attributes.push(plan)
  return { template, plan }
}

function pricedLegacyFixture() {
  const state = fixture()
  const { categoryAttributeBindings: _bindings, productAttributeOverrides: _overrides, productTotalFormulas: _totalFormulas, schemaVersion: _version, attributes: _attributes, ...shared } = state.document
  const document: LegacyPricedAreaPricingDocument = {
    ...shared, schemaVersion: 3,
    attributes: [{ areaAttributePriceId: 'old-G11', optionName: 'Technique', reference: { techniqueId: 'G11' }, charge: createAreaCharge(shared.templates[0]) }],
  }
  return { ...state, document }
}

function schemeLegacyFixture() {
  const state = fixture()
  const { productTotalFormulas: _formulas, attributes: _attributes, schemaVersion: _schema, ...shared } = state.document
  const document: LegacySchemeAreaPricingDocument = { ...shared, schemaVersion: 4, attributes: [] }
  const addLegacyPlan = (id: string, formula = DEFAULT_AREA_FORMULA) => {
    const source = document.templates[0]
    const template = createPricedAreaTemplate({ ...source, areaTemplateId: `template-${id}`, name: `工艺 · ${id}`, tiers: source.tiers.map((tier, index) => ({ ...tier, areaTierId: `${id}-tier-${index}` })) })
    template.formula = formula
    const plan = { areaAttributePriceId: id, name: `方案 ${id}`, optionName: 'Technique', reference: { techniqueId: 'G11' }, areaTemplateId: template.areaTemplateId }
    document.templates.push(template)
    document.attributes.push(plan)
    return { template, plan }
  }
  return { ...state, document, addLegacyPlan }
}

describe('area formula arithmetic', () => {
  test('supports precedence, parentheses, decimal constants, calculator symbols and an Excel-style equals sign', () => {
    expect(evaluateAreaFormula('=（基本价 + 档位价格 × 面积平方毫米）÷ 2', { 基本价: '2', 档位价格: '0.13', 面积平方毫米: '10' })).toBe('1.65')
    expect(evaluateAreaFormula('-.5 + 2 * 3 - 1 / 4', {})).toBe('5.25')
    expect(evaluateAreaFormula('(1 / 3) * 3', {})).toBe('1')
  })

  test('rejects scripts, unknown variables, malformed syntax, missing values and division by zero', () => {
    for (const formula of ['Math.max(1,2)', 'globalThis.process', '1; 2', '基本价 ** 2', '基本价(2)', '(1 + 2', '1 2', '1 +', '未知变量 + 1']) {
      expect(() => validateAreaFormula(formula), formula).toThrow()
    }
    expect(() => evaluateAreaFormula('基本价 + 档位价格', { 基本价: '1', 档位价格: null })).toThrow('未定价')
    expect(() => evaluateAreaFormula('基本价 / (1 - 1)', { 基本价: '1' })).toThrow('除以 0')
    expect(() => validateAreaFormula('('.repeat(40) + '1' + ')'.repeat(40))).toThrow('嵌套过深')
    expect(() => validateAreaFormula('大类主体价 * 数量', AREA_TOTAL_VARIABLES)).not.toThrow()
  })

  test('keeps intermediate division exact until the order total is rounded', () => {
    const { pricing, input, quote } = fixture()
    pricing.body.basePrice = '1'
    pricing.body.formula = '基本价 / 3'
    input.quantity = 3
    expect(quote().totalPrice).toBe('1.00')
    input.quantity = 21
    expect(quote().totalPrice).toBe('7.00')
    pricing.body.basePrice = '0.005'
    pricing.body.formula = '基本价'
    input.quantity = 1
    expect(quote().totalPrice).toBe('0.01')
    pricing.body.formula = '基本价 - 1'
    expect(() => quote()).toThrow('不能为负数')
  })
})

describe('v7 explicit interval bounds', () => {
  function rangeFixture(matchBy: 'area' | 'longest-side' = 'longest-side') {
    const state = fixture()
    const document = upgradeAreaPricing(state.document, state.bundle)
    const template = document.templates[0]
    Object.assign(template, {
      matchBy, unit: 'mm', boundaryMode: 'upper-inclusive', basePrice: '0',
      tiers: [
        { areaTierId: 'range-low', minArea: '0', minInclusive: false, maxArea: '49' },
        { areaTierId: 'range-high', minArea: '50', minInclusive: true, maxArea: '100' },
      ],
      tierPrices: [
        { areaTierId: 'range-low', price: '2', calculation: { kind: 'fixed' } },
        { areaTierId: 'range-high', price: '4', calculation: { kind: 'fixed' } },
      ],
    })
    const input = { ...state.input, width: '49', height: '1', unit: 'mm' as const }
    return { ...state, document, template, input, quote: () => quoteAreaProduct(document, state.bundle, noDiscount, input) }
  }

  test('implicit boundary helpers preserve legacy meaning without materializing configuration', () => {
    const { pricing } = fixture()
    const template = pricing.body
    const before = structuredClone(template)
    expect(getAreaTierBounds(template, template.tiers[0])).toEqual({ minArea: '0', minInclusive: false, maxArea: '10', maxInclusive: true })
    expect(getAreaTierBounds(template, template.tiers[1])).toEqual({ minArea: '10', minInclusive: false, maxArea: '20', maxInclusive: true })
    expect(template).toEqual(before)
    template.boundaryMode = 'lower-inclusive'
    expect(getAreaTierBounds(template, template.tiers[0]).minInclusive).toBe(false)
    expect(getAreaTierBounds(template, template.tiers[1])).toEqual({ minArea: '10', minInclusive: true, maxArea: '20', maxInclusive: false })
  })

  test('longest-side bounds include their chosen endpoints and leave gaps or oversized dimensions unpriced', () => {
    const state = rangeFixture()
    expect(state.quote().unitPrice).toBe('2')
    state.input.width = '49.5'
    expect(state.quote).toThrow('没有匹配')
    state.input.width = '50'
    expect(state.quote().unitPrice).toBe('4')
    expect(state.quote().steps[0].tierLabel).toBe('50 ≤ L ≤ 100 mm')
    state.input.width = '100'
    expect(state.quote().unitPrice).toBe('4')
    state.input.width = '100.001'
    expect(state.quote).toThrow('没有匹配')
    expect(() => validateAreaPricing(state.document)).not.toThrow()
  })

  test('lower-inclusive templates keep upper bounds excluded and explicit lower containment independent', () => {
    const state = rangeFixture()
    state.template.boundaryMode = 'lower-inclusive'
    state.template.tiers[0].maxArea = '50'
    state.input.width = '50'
    expect(state.quote().unitPrice).toBe('4')
    state.template.tiers[1].minInclusive = false
    expect(state.quote).toThrow('没有匹配')
    state.input.width = '50.01'
    expect(state.quote().unitPrice).toBe('4')
    state.input.width = '100'
    expect(state.quote).toThrow('没有匹配')
  })

  test('explicit longest-side endpoints match equivalent physical dimensions in all units', () => {
    const state = rangeFixture()
    state.template.unit = 'in'
    state.template.tiers = [{ areaTierId: 'range-low', minArea: '1', minInclusive: true, maxArea: '2' }]
    state.template.tierPrices = state.template.tierPrices.slice(0, 1)
    state.input.width = '50.8'
    expect(state.quote().unitPrice).toBe('2')
    state.input.width = '50.8000000000005'
    expect(state.quote().unitPrice).toBe('2')
    Object.assign(state.input, { width: '5.08', height: '0.1', unit: 'cm' })
    expect(state.quote().unitPrice).toBe('2')
    Object.assign(state.input, { width: '2', height: '0.1', unit: 'in' })
    expect(state.quote().unitPrice).toBe('2')
    state.input.width = '0.99'
    expect(state.quote).toThrow('没有匹配')
  })

  test('explicit area bounds use squared units and do not bridge gaps', () => {
    const state = rangeFixture('area')
    state.template.unit = 'cm'
    state.template.tiers[0].maxArea = '10'
    state.template.tiers[1].minArea = '20'
    state.template.tiers[1].maxArea = '40'
    Object.assign(state.input, { width: '50', height: '20' })
    expect(state.quote().unitPrice).toBe('2')
    Object.assign(state.input, { width: '3', height: '5', unit: 'cm' })
    expect(state.quote).toThrow('没有匹配')
    Object.assign(state.input, { width: '4', height: '5' })
    expect(state.quote().unitPrice).toBe('4')
    Object.assign(state.input, { width: '8', height: '5' })
    expect(state.quote().unitPrice).toBe('4')
  })

  test('overlap checks include repeated inclusive endpoints and unit conversion tolerance', () => {
    const state = rangeFixture()
    state.template.tiers[1].minArea = '48'
    expect(() => validateAreaPricing(state.document)).toThrow('重叠')
    state.template.tiers[1].minArea = '49'
    expect(() => validateAreaPricing(state.document)).toThrow('重叠')
    state.template.tiers[1].minArea = '49.0000000000005'
    expect(() => validateAreaPricing(state.document)).toThrow('重叠')
    state.template.tiers[1].minInclusive = false
    expect(() => validateAreaPricing(state.document)).not.toThrow()
    state.template.tiers[1].minArea = '48.9999999999995'
    expect(() => validateAreaPricing(state.document)).toThrow('重叠')
    state.template.tiers[1].minArea = '49.000000000002'
    state.template.tiers[1].minInclusive = true
    expect(() => validateAreaPricing(state.document)).not.toThrow()
  })

  test('explicit ranges reject reversed, negative, missing and mixed bounds', () => {
    const state = rangeFixture()
    state.template.tiers[1].minArea = '101'
    expect(() => validateAreaPricing(state.document)).toThrow('下限不能大于上限')
    state.template.tiers[1].minArea = '100.0000000000001'
    expect(() => validateAreaPricing(state.document)).toThrow('下限不能大于上限')
    state.template.tiers[1].minArea = '-1'
    expect(() => validateAreaPricing(state.document)).toThrow('非负')
    state.template.tiers[1].minArea = '50'
    delete state.template.tiers[1].minInclusive
    expect(() => validateAreaPricing(state.document)).toThrow('字段无效')
    delete state.template.tiers[1].minArea
    expect(() => validateAreaPricing(state.document)).toThrow('不能混用')
  })

  test('a single-point interval is valid only when both endpoints are included', () => {
    const state = rangeFixture()
    state.template.tiers = [{ areaTierId: 'range-high', minArea: '50', minInclusive: true, maxArea: '50' }]
    state.template.tierPrices = state.template.tierPrices.slice(1)
    state.input.width = '50'
    expect(state.quote().unitPrice).toBe('4')
    state.input.width = '49.999'
    expect(state.quote).toThrow('没有匹配')
    state.template.tiers[0].minInclusive = false
    expect(() => validateAreaPricing(state.document)).toThrow('区间不能为空')
    state.template.tiers[0].minInclusive = true
    state.template.boundaryMode = 'lower-inclusive'
    expect(() => validateAreaPricing(state.document)).toThrow('区间不能为空')
  })

  test('standee base intervals use their own explicit boundaries', () => {
    const state = standeeFixture()
    state.template.standeeBase!.tiers.forEach((tier, index) => Object.assign(tier, { minArea: index === 0 ? '0' : index === 1 ? '50' : '100', minInclusive: index !== 0 }))
    expect(state.quote().unitPrice).toBe('7.3')
    state.input.standee!.base.width = '45'
    expect(state.quote).toThrow(/底座.*没有匹配/)
  })

  test('legacy keychain boundary quotes and implicit unlimited validation remain unchanged after upgrade', () => {
    const state = sTemplateFixture()
    const next = upgradeAreaPricing(state.document, state.bundle)
    const before = structuredClone(next)
    for (const width of ['0.000000000000000001', '9.999', '10', '19.999', '20', '40', '100', '150']) {
      Object.assign(state.input, { width, height: '1', unit: 'cm' })
      const expected = quoteAreaProduct(state.document, state.bundle, noDiscount, state.input)
      expect(quoteAreaProduct(next, state.bundle, noDiscount, state.input)).toEqual(expected)
    }
    expect(upgradeAreaPricing(next, state.bundle)).toEqual(before)
    const template = next.templates.find(row => row.areaTemplateId === state.template.areaTemplateId)!
    expect(template.tiers.every(tier => !Object.hasOwn(tier, 'minArea'))).toBe(true)
    template.tiers.at(-1)!.maxArea = '200'
    expect(() => validateAreaPricing(next)).toThrow('最后一个档位须为不限')
  })
})

describe('category body pricing', () => {
  test('creates one body price per real category and preserves category IDs used by quantity tiers', () => {
    const { bundle, document } = fixture()
    expect(document.schemaVersion).toBe(5)
    expect(document).not.toHaveProperty('products')
    expect(document.categories.map(row => row.categoryId)).toEqual(bundle.main.categories.map(row => row.name))
    expect(getProductPricingCategory(bundle, 'P31')).toMatchObject({ categoryId: 'keychains', productCount: 14 })
    expect(getAreaPricingCategories(bundle).map(row => row.categoryId)).toEqual(document.categories.map(row => row.categoryId))
    expect(() => validateAreaPricing({ ...document, limits: { min: {}, max: {} } })).toThrow('面积定价字段无效')
  })

  test('products in the same category use the same current body price without copying prices', () => {
    const { bundle, document, pricing, input, quote } = fixture()
    const sibling = allProducts(bundle.main).find(row => row.productId === 'P32')!
    sibling.productOptions.forEach(option => { option.deleted = true })
    expect(quote().totalPrice).toBe('3.00')
    input.productId = sibling.productId
    expect(quote().totalPrice).toBe('3.00')
    pricing.body.basePrice = '0.5'
    expect(quote().totalPrice).toBe('1.50')
    input.productId = 'P31'
    expect(quote().totalPrice).toBe('1.50')
    expect(document.categories).toHaveLength(bundle.main.categories.length)
  })

  test('migrates P31 into its category, preserves body inputs and switches all products to the fixed total formula', () => {
    const { bundle, document, pricing, input } = legacyFixture()
    pricing.totalFormula = '主体价 * 99'
    const before = structuredClone(document)
    const upgraded = upgradeAreaPricing(document, bundle)
    expect(getTemplatePriceCharge(resolveProductBaseTemplate(upgraded, bundle, 'P31').template!)).toEqual(pricing.body)
    expect(upgraded).not.toHaveProperty('products')
    expect(upgraded.categories.filter(row => row.categoryId !== 'keychains').every(row => row.areaTemplateId === null)).toBe(true)
    expect(quoteAreaProduct(upgraded, bundle, noDiscount, input)).toMatchObject({ totalPrice: '3.00', formula: getDefaultProductTotalFormula(bundle, input.productId) })
    expect(upgradeAreaPricing(upgraded, bundle)).toEqual(upgraded)
    expect(document).toEqual(before)
  })

  test('refuses conflicting configured body prices including explicit zero and custom formulas', () => {
    const { bundle, document, pricing } = legacyFixture()
    const sibling = document.products.find(row => row.productId === 'P32')!
    sibling.body.basePrice = '0'
    expect(() => upgradeAreaPricing(document, bundle)).toThrow('P31、P32')
    sibling.body.basePrice = null
    sibling.body.formula = '0'
    expect(() => upgradeAreaPricing(document, bundle)).toThrow('不同的主体价格')
    sibling.body = structuredClone(pricing.body)
    sibling.body.basePrice = '2.00'
    sibling.body.tierPrices.reverse()
    expect(getTemplatePriceCharge(resolveProductBaseTemplate(upgradeAreaPricing(document, bundle), bundle, 'P31').template!)).toEqual(pricing.body)
  })

  test('does not create a synthetic category for uncategorized products or discard their configured prices', () => {
    const { bundle, document, input } = fixture()
    input.productId = bundle.main.uncategorizedProducts[0].productId
    expect(getProductPricingCategory(bundle, input.productId)).toBeUndefined()
    expect(() => quoteAreaProduct(document, bundle, noDiscount, input)).toThrow('尚未归属产品大类')
    const legacy = legacyFixture()
    legacy.document.products.find(row => row.productId === input.productId)!.body.basePrice = '0'
    expect(() => upgradeAreaPricing(legacy.document, legacy.bundle)).toThrow('未归属产品大类')
    document.categories.push({ categoryId: 'gone', areaTemplateId: null })
    expect(() => validateAreaReferences(document, bundle)).toThrow('大类 gone 已不存在')
    document.categories.push(structuredClone(document.categories[0]))
    expect(() => validateAreaPricing(document)).toThrow('重复')
  })

  test('uses only current product attributes and reports unsupported enabled options', () => {
    const { product, quote } = fixture()
    expect(quote().variables).toEqual({ 大类主体价: '3', 折扣系数: '1', 数量: '1' })
    expect(quote().variables).not.toHaveProperty('工艺价')
    product.productOptions.push({ ...product.productOptions[0], name: 'Unknown Attribute', labelZh: '未知属性', deleted: false })
    expect(() => quote()).toThrow('尚不支持属性“未知属性”')
  })
})

describe('priced templates and product bindings', () => {
  test('moves the configured category price into its existing template and leaves unpriced categories unbound', () => {
    const { bundle, document, input } = categoryLegacyFixture(sTemplateFixture())
    const before = structuredClone(document)
    const original = document.categories.find(category => category.categoryId === 'keychains')!.body
    const upgraded = upgradeAreaPricing(document, bundle)
    expect(upgraded.schemaVersion).toBe(7)
    expect(upgraded.productOverrides).toEqual([])
    const resolved = resolveProductBaseTemplate(upgraded, bundle, 'P31')
    expect(resolved.source).toBe('category')
    expect(getTemplatePriceCharge(resolved.template!)).toEqual(original)
    expect(upgraded.categories.filter(category => category.categoryId !== 'keychains').every(category => category.areaTemplateId === null)).toBe(true)
    expect(getAdditionalAttributePrices(upgraded)).toEqual(before.attributes)
    expect(upgraded.accessoryPrices).toEqual(before.accessoryPrices)
    expect(quoteAreaProduct(upgraded, bundle, noDiscount, input)).toEqual(quoteAreaProduct(document, bundle, noDiscount, input))
    expect(upgradeAreaPricing(upgraded, bundle)).toEqual(upgraded)
    expect(document).toEqual(before)
  })

  test('separates differing category prices into stable templates and shares identical prices without tier-ID collisions', () => {
    const { bundle, document, input } = categoryLegacyFixture()
    const keychains = document.categories.find(category => category.categoryId === 'keychains')!
    const stickers = document.categories.find(category => category.categoryId === 'stickers')!
    const acrylic = document.categories.find(category => category.categoryId === 'acrylic')!
    stickers.body = structuredClone(keychains.body)
    stickers.body.basePrice = '4'
    acrylic.body = structuredClone(keychains.body)
    acrylic.body.basePrice = '2.00'
    const upgraded = upgradeAreaPricing(document, bundle)
    expect(upgraded.templates).toHaveLength(2)
    expect(upgraded.categories.find(row => row.categoryId === 'acrylic')!.areaTemplateId).toBe(upgraded.categories.find(row => row.categoryId === 'keychains')!.areaTemplateId)
    const tierIds = upgraded.templates.flatMap(template => template.tiers.map(tier => tier.areaTierId))
    expect(new Set(tierIds).size).toBe(tierIds.length)
    expect(upgradeAreaPricing(document, bundle)).toEqual(upgraded)
    expect(() => validateAreaReferences(upgraded, bundle)).not.toThrow()
    for (const [productId, expected] of [['P1', '5.00'], ['P17', '3.00'], ['P31', '3.00']]) {
      allProducts(bundle.main).find(product => product.productId === productId)!.productOptions.forEach(option => { option.deleted = true })
      expect(quoteAreaProduct(upgraded, bundle, noDiscount, { ...input, productId }).totalPrice).toBe(expected)
    }
  })

  test('uses a child template override before the category default and restores inheritance when removed', () => {
    const { bundle, document, input, quote } = fixture()
    allProducts(bundle.main).find(product => product.productId === 'P32')!.productOptions.forEach(option => { option.deleted = true })
    const override = createPricedAreaTemplate({ areaTemplateId: 'child-template', name: '子类模板', unit: 'mm', tiers: [{ areaTierId: 'child-tier', maxArea: null }] })
    override.basePrice = '10'
    override.formula = '基本价'
    document.templates.push(override)
    document.productOverrides.push({ productId: 'P31', areaTemplateId: override.areaTemplateId })
    expect(resolveProductBaseTemplate(document, bundle, 'P31').source).toBe('product')
    expect(quote().totalPrice).toBe('10.00')
    input.productId = 'P32'
    expect(quote().totalPrice).toBe('3.00')
    override.basePrice = '12'
    input.productId = 'P31'
    expect(quote().totalPrice).toBe('12.00')
    document.productOverrides = []
    expect(resolveProductBaseTemplate(document, bundle, 'P31').source).toBe('category')
    expect(quote().totalPrice).toBe('3.00')
    document.categories.find(category => category.categoryId === 'keychains')!.areaTemplateId = null
    expect(resolveProductBaseTemplate(document, bundle, 'P31').source).toBe('none')
    expect(() => quote()).toThrow('尚未选择面积档位模板')
    document.productOverrides.push({ productId: 'P31', areaTemplateId: override.areaTemplateId })
    expect(quote().totalPrice).toBe('12.00')
  })

  test('rejects invalid template prices and dangling or duplicate product bindings', () => {
    const { bundle, document } = fixture()
    document.productOverrides.push({ productId: 'P31', areaTemplateId: 'missing' })
    expect(() => validateAreaPricing(document)).toThrow('面积模板引用无效')
    document.productOverrides[0].areaTemplateId = document.templates[0].areaTemplateId
    document.productOverrides.push({ ...document.productOverrides[0] })
    expect(() => validateAreaPricing(document)).toThrow('重复')
    document.productOverrides.pop()
    document.productOverrides[0].productId = 'missing'
    expect(() => validateAreaReferences(document, bundle)).toThrow('产品 missing 已不存在')
    document.productOverrides[0].productId = bundle.main.uncategorizedProducts[0].productId
    expect(() => validateAreaReferences(document, bundle)).toThrow('尚未归属产品大类')
    document.productOverrides = []
    document.templates[0].basePrice = '-1'
    expect(() => validateAreaPricing(document)).toThrow('非负十进制金额')
    document.templates[0].basePrice = '0'
    document.templates[0].formula = 'eval(1)'
    expect(() => validateAreaPricing(document)).toThrow()
    expect(() => validateAreaPricing({ ...createAreaPricing(bundle), productOverrides: null })).toThrow()
  })

  test('new configurations leave attribute schemes unassigned while preserving public accessories', () => {
    const bundle = clone(initialBundle)
    const original = createAreaPricing(bundle)
    bundle.main.categories.forEach(category => { category.products = [] })
    bundle.main.uncategorizedProducts = []
    const empty = createAreaPricing(bundle)
    expect(empty.additionalPricePlans).toEqual(original.additionalPricePlans)
    expect(empty.accessoryPrices).toEqual(original.accessoryPrices)
    expect(empty.additionalPricePlans).toEqual([])
    expect(empty.categoryAdditionalPlanBindings).toEqual([])
    expect(empty.productAdditionalPlanOverrides).toEqual([])
    expect(() => validateAreaReferences(empty, bundle)).not.toThrow()
  })
})

describe('area units and tiers', () => {
  test('matches the S cm² coefficients immediately below, at and above every lower-inclusive boundary', () => {
    const { input, quote } = sTemplateFixture()
    const cases = [
      ['9.999', '0.13', '1.79987'], ['10', '0.08', '1.3'], ['10.001', '0.08', '1.30008'],
      ['19.999', '0.08', '2.09992'], ['20', '0.055', '1.6'], ['20.001', '0.055', '1.600055'],
      ['39.999', '0.055', '2.699945'], ['40', '0.04', '2.1'], ['40.001', '0.04', '2.10004'],
      ['99.999', '0.04', '4.49996'], ['100', '0.028', '3.3'], ['100.001', '0.028', '3.300028'],
    ]
    for (const [width, tierPrice, amount] of cases) {
      Object.assign(input, { width, height: '1', unit: 'cm' })
      expect(quote().steps[0], `A = ${width} cm²`).toMatchObject({ tierPrice, amount })
    }
    Object.assign(input, { width: '39.999', height: '1', unit: 'cm', quantity: 3 })
    expect(quote().totalPrice).toBe('8.10')
  })

  test('matches the same S boundary and amount for cm, mm and in inputs despite conversion rounding', () => {
    const { input, quote } = sTemplateFixture()
    for (const [boundary, coefficient, total] of [[10, '0.08', '1.30'], [20, '0.055', '1.60'], [40, '0.04', '2.10'], [100, '0.028', '3.30']] as const) {
      const dimensions = [
        { width: String(boundary), height: '1', unit: 'cm' },
        { width: String(boundary * 10), height: '10', unit: 'mm' },
        { width: String(boundary / 2.54), height: String(1 / 2.54), unit: 'in' },
      ] as const
      for (const area of dimensions) {
        Object.assign(input, area)
        const result = quote()
        expect(result.steps[0].tierPrice, `${boundary} cm² entered in ${area.unit}`).toBe(coefficient)
        expect(result.totalPrice).toBe(total)
        expect(Number(result.areaMm2)).toBeCloseTo(boundary * 100, 8)
      }
    }
  })

  test('preserves old upper-inclusive templates and reflects both boundary conventions in the labels', () => {
    const { document, template, input, quote } = sTemplateFixture()
    Object.assign(input, { width: '10', height: '1', unit: 'cm' })
    expect(quote().steps[0]).toMatchObject({ tierPrice: '0.08', tierLabel: '10 ≤ A < 20 cm²' })
    expect(areaTierLabel(template, template.tiers[0], document.limits)).toBe('A < 10 cm²')
    expect(areaTierLabel(template, template.tiers.at(-1)!, document.limits)).toBe('A ≥ 100 cm²')
    delete template.boundaryMode
    expect(quote().steps[0]).toMatchObject({ tierPrice: '0.13', amount: '1.8' })
    expect(areaTierLabel(template, template.tiers[1], document.limits)).toBe('10 < A ≤ 20 cm²')
    template.boundaryMode = 'upper-inclusive'
    expect(quote().steps[0]).toMatchObject({ tierPrice: '0.13', amount: '1.8' })
    for (const invalid of ['left', '', null, undefined]) {
      expect(() => validateAreaPricing({ ...document, templates: document.templates.map(row => row === template ? { ...row, boundaryMode: invalid } : row) })).toThrow('面积模板边界模式无效')
    }
  })

  test('creates the five cm² default bands without prefilled prices or global limits', () => {
    const { bundle } = fixture()
    const document = createAreaPricing(bundle)
    const template = createDefaultAreaTemplate()
    expect(document.templates).toEqual([createPricedAreaTemplate(template)])
    expect(template).toMatchObject({ areaTemplateId: 'area-template-cm2-10-20-40-100', unit: 'cm', boundaryMode: 'lower-inclusive' })
    expect(template.tiers.map(tier => tier.maxArea)).toEqual(['10', '20', '40', '100', null])
    expect(document).not.toHaveProperty('limits')
    expect(getAreaCharges(document)).toEqual([])
    expect(getTemplatePriceCharge(document.templates[0])).toEqual(createAreaCharge(template))
    expect(document.templates[0].formula).toBe(DEFAULT_AREA_FORMULA)
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
    template.tiers[0].maxArea = '5'
    expect(createDefaultAreaTemplate().tiers[0].maxArea).toBe('10')
  })

  test('quotes arbitrarily small positive areas and an unbounded final tier without global limits', () => {
    const { document, input, quote } = sTemplateFixture()
    expect(document).not.toHaveProperty('limits')
    Object.assign(input, { width: '0.001', height: '0.001', unit: 'mm' })
    expect(quote().steps[0]).toMatchObject({ tierPrice: '0.13', tierLabel: 'A < 10 cm²', amount: '0.5000000013' })
    Object.assign(input, { width: '500', height: '1000', unit: 'mm' })
    expect(quote().steps[0]).toMatchObject({ tierPrice: '0.028', tierLabel: 'A ≥ 100 cm²', amount: '140.5' })
    expect(quote().totalPrice).toBe('140.50')
    for (const width of ['', '0', '-1']) {
      input.width = width
      expect(() => quote()).toThrow('宽度须为大于 0')
    }
  })

  test('ignores historical limits in validation, quotes and labels, then removes them on upgrade', () => {
    const { bundle, document, input, pricing, quote } = legacyFixture(sTemplateFixture())
    const originalPrices = structuredClone(pricing)
    document.limits = { min: { width: '100', height: '100', unit: 'in' }, max: { width: '1', height: '1', unit: 'mm' } }
    expect(() => validateAreaPricing(document)).not.toThrow()
    Object.assign(input, { width: '20', height: '10', unit: 'mm' })
    expect(quote().steps[0]).toMatchObject({ tierPrice: '0.13', tierLabel: 'A < 10 cm²' })
    Object.assign(input, { width: '1000', height: '1000', unit: 'mm' })
    expect(quote().steps[0]).toMatchObject({ tierPrice: '0.028', tierLabel: 'A ≥ 100 cm²' })
    document.limits.min.width = ''
    expect(() => quote()).not.toThrow()
    const upgraded = upgradeAreaPricing(document, bundle)
    expect(upgraded).not.toHaveProperty('limits')
    expect(getTemplatePriceCharge(resolveProductBaseTemplate(upgraded, bundle, 'P31').template!)).toEqual(originalPrices.body)
    expect(getAdditionalAttributePrices(upgraded)).toEqual(document.attributes)
    expect(upgraded.accessoryPrices).toEqual(document.accessoryPrices)
    expect(upgradeAreaPricing(upgraded, bundle)).toEqual(upgraded)
    expect(document).toHaveProperty('limits')
  })

  test('replaces the unused starter bands, reuses the configured cm² template and preserves P31 prices', () => {
    const { bundle, document, pricing } = legacyFixture()
    const oldTemplate = document.templates[0]
    oldTemplate.areaTemplateId = 'area-template-default'
    const defaultTemplate = createDefaultAreaTemplate()
    document.templates.push(defaultTemplate)
    for (const charge of getAreaCharges(document)) {
      charge.areaTemplateId = oldTemplate.areaTemplateId
      charge.tierPrices.forEach(tier => { tier.price = null })
    }
    const otherPrice = document.products.find(row => row.productId !== 'P31')!
    otherPrice.body.basePrice = '1.25'
    otherPrice.body.formula = '基本价 * 2 + 档位价格'
    pricing.body = createAreaCharge(defaultTemplate)
    pricing.body.formula = '基本价 + 档位价格 * (面积平方毫米 / 100)'
    pricing.body.tierPrices.forEach((row, index) => { row.price = ['0.13', '0.08', '0.055', '0.04', '0.028'][index] })
    pricing.totalFormula = '主体价 * 数量'
    const originalP31 = structuredClone(pricing)
    const upgraded = upgradeAreaPricing(document, bundle)
    expect(upgraded.templates).toHaveLength(2)
    expect(upgraded.templates[0]).toMatchObject(defaultTemplate)
    const migratedP31 = getTemplatePriceCharge(resolveProductBaseTemplate(upgraded, bundle, 'P31').template!)
    expect(migratedP31).toMatchObject({ basePrice: originalP31.body.basePrice, formula: originalP31.body.formula })
    expect(migratedP31.tierPrices.map(row => row.price)).toEqual(originalP31.body.tierPrices.map(row => row.price))
    expect(getTemplatePriceCharge(resolveProductBaseTemplate(upgraded, bundle, otherPrice.productId).template!)).toEqual({
      ...createAreaCharge(defaultTemplate), basePrice: '1.25', formula: '基本价 * 2 + 档位价格',
    })
    expect(getAdditionalAttributePrices(upgraded)).toEqual([])
    expect(() => validateAreaReferences(upgraded, bundle)).not.toThrow()
    expect(upgradeAreaPricing(upgraded, bundle)).toEqual(upgraded)
    expect(document.templates[0]).toBe(oldTemplate)
  })

  test('adds the cm² default when migrating the untouched starter and preserves any already-priced old template', () => {
    const { bundle, document, pricing } = legacyFixture()
    const oldId = document.templates[0].areaTemplateId
    document.templates[0].areaTemplateId = 'area-template-default'
    for (const charge of getAreaCharges(document)) {
      expect(charge.areaTemplateId).toBe(oldId)
      charge.areaTemplateId = 'area-template-default'
      charge.tierPrices.forEach(tier => { tier.price = null })
    }
    const upgradedEmpty = upgradeAreaPricing(document, bundle)
    expect(upgradedEmpty.templates).toHaveLength(1)
    expect(upgradedEmpty.templates[0]).toMatchObject(createDefaultAreaTemplate())
    pricing.body.tierPrices[0].price = '0'
    const upgradedPriced = upgradeAreaPricing(document, bundle)
    expect(upgradedPriced.templates.map(row => row.areaTemplateId)).toEqual([createDefaultAreaTemplate().areaTemplateId, 'area-template-default'])
    expect(getTemplatePriceCharge(resolveProductBaseTemplate(upgradedPriced, bundle, 'P31').template!)).toEqual(pricing.body)
    expect(upgradeAreaPricing(upgradedPriced, bundle)).toEqual(upgradedPriced)
    document.templates[0].tiers[0].maxArea = '9'
    expect(upgradeAreaPricing(document, bundle).templates.map(({basePrice: _base, tierPrices: _prices, formula: _formula, ...template}) => template)).toEqual(document.templates)
  })

  test('validates ascending positive template boundaries and preserves converted boundary matches without global range checks', () => {
    const { document, input, quote } = fixture()
    document.templates[0].tiers[0].maxArea = '0.000001'
    document.templates[0].tiers[1].maxArea = '999999999'
    expect(() => validateAreaPricing(document)).not.toThrow()
    document.templates[0].unit = 'mm'
    document.templates[0].tiers[0].maxArea = '1000'
    document.templates[0].tiers[1].maxArea = '2000'
    Object.assign(input, { width: '100', height: '10', unit: 'mm' })
    const first = quote()
    document.templates[0].tiers.forEach(tier => { if (tier.maxArea !== null) tier.maxArea = convertAreaValue(tier.maxArea, 'mm', 'in') })
    document.templates[0].unit = 'in'
    expect(quote().steps[0].areaTierId).toBe(first.steps[0].areaTierId)
    expect(quote().totalPrice).toBe(first.totalPrice)
  })
  test('uses equivalent in, cm and mm dimensions and converts squared template boundaries', () => {
    expect(areaSquareMm('2', '2', 'in')).toBe('2580.64')
    expect(areaSquareMm('5.08', '5.08', 'cm')).toBe('2580.64')
    expect(areaSquareMm('50.8', '50.8', 'mm')).toBe('2580.64')
    expect(convertAreaValue('10', 'in', 'cm')).toBe('64.516')
    expect(convertAreaValue('10', 'in', 'mm')).toBe('6451.6')
    expect(convertAreaValue('', 'in', 'mm')).toBe('')
    const { input, quote } = fixture()
    Object.assign(input, { width: '2', height: '2', unit: 'in' })
    const first = quote()
    Object.assign(input, { width: '5.08', height: '5.08', unit: 'cm' })
    expect(quote().totalPrice).toBe(first.totalPrice)
    expect(quote().steps[0].areaTierId).toBe(first.steps[0].areaTierId)
    for (const dimension of ['0', '-1', '', 'NaN', 'Infinity', '1e2']) expect(() => areaSquareMm(dimension, '1', 'in')).toThrow()
  })

  test('uses an inclusive upper bound and keeps per-charge prices linked by tier ID', () => {
    const { document, pricing, input, quote } = fixture()
    pricing.body.tierPrices[0].price = '0.13'
    pricing.body.tierPrices[1].price = '0.08'
    pricing.body.tierPrices[2].price = '0.05'
    Object.assign(input, { width: '10', height: '1', unit: 'in' })
    expect(quote().steps[0]).toMatchObject({ tierPrice: '0.13', areaTierId: 'area-tier-10', areaMm2: '6451.6', amount: '840.708' })
    input.width = '10.0001'
    expect(quote().steps[0].tierPrice).toBe('0.08')
    input.width = '20'
    expect(quote().steps[0].tierPrice).toBe('0.08')
    input.width = '20.01'
    expect(quote().steps[0].tierPrice).toBe('0.05')
    document.templates[0].tiers[0].maxArea = '15'
    input.width = '12'
    expect(quote().steps[0].tierPrice).toBe('0.13')
  })

  test('uses configured standard-size area across unit changes and requires enabled custom dimensions', () => {
    const { bundle, product, input, quote } = fixture()
    const option = optionFor(product, 'Size')!
    option.deleted = false
    option.disabledValues = []
    const values = catalogFor(bundle, product, 'Size').values
    const standard = values.find(value => !value.isCustom)!
    standard.area = { width: '3', height: '3', unit: 'cm' }
    Object.assign(input, { sizeBandId: getEntityId(standard), width: '1.181102362204724409', height: '1.181102362204724409', unit: 'in' })
    expect(quote()).toMatchObject({ areaMm2: '900', totalPrice: '6.50' })
    input.width = '2'
    expect(() => quote()).toThrow('标准尺寸宽高')
    const custom = values.find(value => value.isCustom)!
    input.sizeBandId = getEntityId(custom)
    expect(() => quote()).not.toThrow()
    option.disabledValues = [{ sizeBandId: input.sizeBandId }]
    expect(() => quote()).toThrow('尚未启用')
  })

  test('rejects invalid templates and mismatched price rows', () => {
    const { document, pricing } = fixture()
    document.templates[0].tiers[1].maxArea = '10'
    expect(() => validateAreaPricing(document)).toThrow('从小到大')
    document.templates[0].tiers[1].maxArea = '20'
    document.templates[0].tiers[2].maxArea = '30'
    expect(() => validateAreaPricing(document)).toThrow('不限面积')
    document.templates[0].tiers[2].maxArea = null
    pricing.body.tierPrices.push({ areaTierId: 'unknown-tier', price: '1' })
    expect(() => validateAreaPricing(document)).toThrow('不属于所选模板')
  })
})

describe('area product and attribute quotes', () => {
  test('an attribute with no enabled values does not require an impossible selection', () => {
    const { bundle, product, input, quote } = fixture()
    const option = optionFor(product, 'Technique')!
    option.deleted = false
    option.disabledValues = catalogFor(bundle, product, 'Technique').values.map(value => ({ techniqueId: getEntityId(value) }))
    expect(quote().totalPrice).toBe('3.00')
    expect(quote().variables).not.toHaveProperty('工艺价')
    input.selections.Technique = 'G11'
    expect(() => quote()).toThrow('有效的滴胶工艺选项')
  })
  test('printing remains free and disabled printing selections are rejected', () => {
    const { bundle, product, document, input, quote } = fixture()
    const option = optionFor(product, 'Print Option')!
    option.deleted = false
    option.disabledValues = []
    const printing = catalogFor(bundle, product, 'Print Option').values[0]
    input.selections['Print Option'] = getEntityId(printing)
    expect(document.attributes.some(row => row.optionName === 'Print Option')).toBe(false)
    expect(DEFAULT_TOTAL_FORMULA).not.toContain('印刷价')
    expect(quote().totalPrice).toBe('3.00')
    expect(quote().variables).not.toHaveProperty('印刷价')
    expect(quote().steps).toHaveLength(1)
    option.disabledValues = [{ printOptionId: getEntityId(printing) }]
    expect(() => quote()).toThrow('有效的印刷选项')
  })

  test('migrates legacy area accessories to fixed prices without applying a coefficient and preserves explicit zero', () => {
    const { bundle, document } = legacyFixture()
    delete document.accessoryPrices
    delete document.limits
    const styles = bundle.catalogs['accessory-styles.json'].values
    const first = styles[0]
    const second = styles[1]
    const firstCharge = createAreaCharge(document.templates[0])
    firstCharge.basePrice = '0'
    firstCharge.tierPrices[0].price = '123'
    document.attributes.push({ areaAttributePriceId: 'legacy-first', optionName: 'Accessories Style', reference: { accessoryStyleId: getEntityId(first) }, charge: firstCharge })
    document.attributes.push({ areaAttributePriceId: 'legacy-second', optionName: 'Accessories Style', reference: { accessoryStyleId: getEntityId(second) }, charge: createAreaCharge(document.templates[0]) })
    const printing = bundle.catalogs['print-options.json'].values[0]
    document.attributes.push({ areaAttributePriceId: 'legacy-print', optionName: 'Print Option', reference: { printOptionId: getEntityId(printing) }, charge: createAreaCharge(document.templates[0]) })
    expect(() => validateAreaPricing(document)).not.toThrow()
    const legacyFixed = [
      { accessoryPriceId: 'fixed-first', accessoryStyleId: getEntityId(first), accessoryColorId: null, unitPrice: '0.3' },
      { accessoryPriceId: 'fixed-second', accessoryStyleId: getEntityId(second), accessoryColorId: null, unitPrice: '0.2' },
    ]
    const upgraded = upgradeAreaPricing(document, bundle, legacyFixed)
    expect(getAdditionalAttributePrices(upgraded).some(row => ['Print Option', 'Accessories Style'].includes(row.optionName))).toBe(false)
    expect(upgraded.accessoryPrices!.find(row => row.accessoryStyleId === getEntityId(first) && row.accessoryColorId === null)?.unitPrice).toBe('0')
    expect(upgraded.accessoryPrices!.find(row => row.accessoryStyleId === getEntityId(second) && row.accessoryColorId === null)?.unitPrice).toBe('0.2')
    expect(upgraded).not.toHaveProperty('limits')
    expect(upgradeAreaPricing(upgraded, bundle, legacyFixed)).toEqual(upgraded)
    expect(() => validateAreaReferences(upgraded, bundle)).not.toThrow()
    expect(document.accessoryPrices).toBeUndefined()
  })

  test('fixed accessory storage rejects missing values, duplicate identities and foreign colors', () => {
    const { bundle, document } = fixture()
    const price = document.accessoryPrices![0]
    const invalidPrice = { ...price, unitPrice: undefined }
    expect(() => validateAreaPricing({ ...document, accessoryPrices: [invalidPrice] })).toThrow('非负十进制金额')
    expect(() => validateAreaPricing({ ...document, accessoryPrices: [price, { ...price, accessoryPriceId: 'duplicate-reference' }] })).toThrow('不能重复')
    price.accessoryColorId = 'foreign-color'
    expect(() => validateAreaReferences(document, bundle)).toThrow('颜色不属于')
  })
  test('new charges remain unpriced until explicitly filled and unrelated blank products do not block a quote', () => {
    const { document, pricing, quote } = fixture()
    expect(document.categories.filter(category => category.categoryId !== 'keychains').every(category => category.areaTemplateId === null)).toBe(true)
    expect(quote().totalPrice).toBe('3.00')
    pricing.body.basePrice = null
    expect(() => quote()).toThrow('基本价')
    pricing.body.basePrice = '0'
    pricing.body.tierPrices[0].price = null
    expect(() => quote()).toThrow('档位价格')
    pricing.body.tierPrices[0].price = '0'
    expect(quote().totalPrice).toBe('0.00')
    pricing.body.basePrice = null
    pricing.body.tierPrices[0].price = null
    pricing.body.formula = '0'
    expect(quote().totalPrice).toBe('0.00')
  })

  test('selected attributes have independent charges and aggregate exactly before the category discount', () => {
    const { bundle, product, document, input, charge } = fixture()
    const technique = optionFor(product, 'Technique')!
    technique.deleted = false
    technique.disabledValues = []
    input.selections.Technique = 'G11'
    const { plan: attribute, template: attributeTemplate } = addPlan(document)
    document.categoryAttributeBindings.push({ categoryId: 'keychains', optionName: attribute.optionName, reference: attribute.reference, areaAttributePriceId: attribute.areaAttributePriceId })
    expect(() => quoteAreaProduct(document, bundle, noDiscount, input)).toThrow('基本价')
    charge(attribute, '0.5', '0.001')
    const quantityPricing: QuantityPricingDocument = { schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers: [{ quantityTierId: 'test-discount', minQty: 1, maxQty: null, discountPercent: 20 }] }] }
    input.quantity = 3
    const result = quoteAreaProduct(document, bundle, quantityPricing, input)
    expect(result).toMatchObject({ unitPrice: '3.7', discountFactor: '0.8', totalPrice: '8.88', variables: { 大类主体价: '3', 工艺价: '0.7', 属性价: '0.7' } })
    expect(result.steps).toHaveLength(2)
    expect(result.steps[1].reference).toEqual({ techniqueId: 'G11' })
    expect(result.substitutedFormula).toContain('(0.7)')
    const accessory = optionFor(product, 'Accessories Style')!
    accessory.deleted = false
    accessory.disabledValues = []
    const style = catalogFor(bundle, product, 'Accessories Style').values[0]
    input.selections['Accessories Style'] = getEntityId(style)
    document.accessoryPrices!.find(row => row.accessoryStyleId === getEntityId(style) && row.accessoryColorId === null)!.unitPrice = '0.3'
    const withAccessory = quoteAreaProduct(document, bundle, quantityPricing, input)
    expect(withAccessory).toMatchObject({ unitPrice: '4', totalPrice: '9.60', variables: { 大类主体价: '3', 属性价: '0.7', 配件价: '0.3', 折扣系数: '0.8', 数量: '3' } })
    expect(withAccessory.steps.filter(step => step.pricingKind === 'fixed')).toHaveLength(1)
    const ownAttributePrice = structuredClone(attributeTemplate)
    document.templates[0].basePrice = '4'
    const changedTemplate = quoteAreaProduct(document, bundle, quantityPricing, input)
    expect(changedTemplate).toMatchObject({ totalPrice: '14.40', variables: { 大类主体价: '5', 属性价: '0.7', 配件价: '0.3' } })
    expect(attributeTemplate).toEqual(ownAttributePrice)
    technique.disabledValues = [{ techniqueId: 'G11' }]
    expect(() => quoteAreaProduct(document, bundle, noDiscount, input)).toThrow('有效的滴胶工艺')
  })

  test('accessory style and color modes each charge exactly the selected entity', () => {
    const { bundle, product, document, input, quote } = fixture()
    const option = optionFor(product, 'Accessories Style')!
    option.deleted = false
    option.disabledValues = []
    const style = catalogFor(bundle, product, 'Accessories Style').values.find(style => style.colors?.length)!
    const color = style.colors![0]
    input.selections['Accessories Style'] = getEntityId(style)
    input.accessoryColorId = getEntityId(color)
    document.accessoryPrices!.find(row => row.accessoryStyleId === getEntityId(style) && row.accessoryColorId === null)!.unitPrice = '0.3'
    expect(quote().variables['配件价']).toBe('0.3')
    expect(quote().steps.at(-1)).toMatchObject({ pricingKind: 'fixed', tierPrice: null, amount: '0.3' })
    input.width = '100'
    expect(quote().variables['配件价']).toBe('0.3')
    document.accessoryPricing = 'color'
    expect(() => quote()).toThrow('公共固定单价未定价')
    document.accessoryPrices!.find(row => row.accessoryColorId === getEntityId(color))!.unitPrice = '0.4'
    expect(quote().variables['配件价']).toBe('0.4')
    input.accessoryColorId = 'foreign-color'
    expect(() => quote()).toThrow('不属于该样式')
  })

  test('a product-level piece selection is validated without adding a multiplier to the fixed total formula', () => {
    const { bundle, product, input, quote } = fixture()
    const option = optionFor(product, 'Standee Quantity')!
    option.deleted = false
    option.disabledValues = []
    const second = catalogFor(bundle, product, 'Standee Quantity').values.find(value => value.pieceCount === 2)!
    second.standeeQuantityId = 'SQ99'
    second.name = '任意名称'
    input.standeeQuantityId = 'SQ99'
    expect(quote().totalPrice).toBe('3.00')
    input.standeeQuantityId = null
    expect(() => quote()).toThrow('主体片数')
  })

  test('references retain their entity type and removed attributes are reported', () => {
    const { bundle, document } = fixture()
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
    const { plan: attribute } = addPlan(document)
    attribute.reference = { materialId: 'G11' }
    expect(() => validateAreaPricing(document)).toThrow('实体字段')
    attribute.reference = { techniqueId: 'missing' }
    expect(() => validateAreaReferences(document, bundle)).toThrow('已不存在')
  })
})

describe('reusable attribute price plans', () => {
  test('the same attribute uses a category default and a different product template without copying prices', () => {
    const { bundle, product, document, input, charge } = fixture()
    const sibling = allProducts(bundle.main).find(row => row.productId === 'P32')!
    sibling.productOptions.forEach(option => { option.deleted = true })
    for (const row of [product, sibling]) Object.assign(optionFor(row, 'Technique')!, { deleted: false, disabledValues: [] })
    input.selections.Technique = 'G11'
    const normal = addPlan(document, 'normal')
    const special = addPlan(document, 'special')
    charge(normal.plan, '0.5', '0.001')
    special.template.unit = 'mm'
    special.template.tiers[0].maxArea = '150'
    special.template.tiers[1].maxArea = '300'
    charge(special.plan, '1', '0.01')
    const binding = { optionName: 'Technique', reference: { techniqueId: 'G11' }, areaAttributePriceId: normal.plan.areaAttributePriceId }
    document.categoryAttributeBindings.push({ ...binding, categoryId: 'keychains' })
    document.productAttributeOverrides.push({ ...binding, productId: 'P32', areaAttributePriceId: special.plan.areaAttributePriceId })
    const quote = (productId: string) => quoteAreaProduct(document, bundle, noDiscount, { ...input, productId })
    expect(quote('P31')).toMatchObject({ totalPrice: '3.70', variables: { 属性价: '0.7' } })
    expect(quote('P31').steps[1]).toMatchObject({ planName: '默认附加价格方案', templateName: normal.template.name, areaTierId: normal.template.tiers[0].areaTierId })
    expect(quote('P32')).toMatchObject({ totalPrice: '6.00', variables: { 属性价: '3' } })
    expect(quote('P32').steps[1]).toMatchObject({ planName: 'P32 附加价格方案', areaTierId: special.template.tiers[1].areaTierId })
    expect(resolveProductAttributePlan(upgradeAreaPricing(document, bundle), bundle, 'P31', 'Technique', binding.reference).source).toBe('category')
    expect(resolveProductAttributePlan(upgradeAreaPricing(document, bundle), bundle, 'P32', 'Technique', binding.reference).source).toBe('product')
    special.plan.basePrice = '2'
    expect(quote('P32').totalPrice).toBe('7.00')
    expect(quote('P31').totalPrice).toBe('3.70')
    document.productAttributeOverrides = []
    expect(quote('P32').totalPrice).toBe('3.70')
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
  })

  test('missing or explicit unpriced bindings never fall back to a global first plan or free price', () => {
    const { bundle, product, document, input, quote, charge } = fixture()
    Object.assign(optionFor(product, 'Technique')!, { deleted: false, disabledValues: [] })
    input.selections.Technique = 'G11'
    const { plan } = addPlan(document)
    charge(plan, '0', '0')
    expect(() => quote()).toThrow('未定价，请先关联附加价格方案')
    const binding = { optionName: plan.optionName, reference: plan.reference, areaAttributePriceId: plan.areaAttributePriceId }
    document.categoryAttributeBindings.push({ ...binding, categoryId: 'keychains' })
    expect(quote().totalPrice).toBe('3.00')
    document.productAttributeOverrides.push({ ...binding, productId: 'P31', areaAttributePriceId: null })
    expect(resolveProductAttributePlan(upgradeAreaPricing(document, bundle), bundle, 'P31', 'Technique', plan.reference)).toMatchObject({ source: 'product', plan: undefined, template: undefined })
    expect(() => quote()).toThrow('未定价')
    document.productAttributeOverrides = []
    document.categoryAttributeBindings[0].areaAttributePriceId = null
    expect(() => quote()).toThrow('未定价')
    optionFor(product, 'Technique')!.deleted = true
    input.selections = {}
    expect(quote().totalPrice).toBe('3.00')
  })

  test('rejects ambiguous, dangling, foreign-attribute and stale-owner bindings', () => {
    const { bundle, document } = fixture()
    const { plan } = addPlan(document)
    addPlan(document, 'second-same-attribute')
    const other = addPlan(document, 'other-attribute', { techniqueId: 'G12' })
    const binding = { categoryId: 'keychains', optionName: plan.optionName, reference: plan.reference, areaAttributePriceId: plan.areaAttributePriceId }
    document.categoryAttributeBindings.push(binding)
    expect(() => validateAreaPricing(document)).not.toThrow()
    document.categoryAttributeBindings.push({ ...binding })
    expect(() => validateAreaPricing(document)).toThrow('关联不能重复')
    document.categoryAttributeBindings.pop()
    binding.areaAttributePriceId = other.plan.areaAttributePriceId
    expect(() => validateAreaPricing(document)).toThrow('不属于当前属性')
    binding.areaAttributePriceId = 'missing'
    expect(() => validateAreaPricing(document)).toThrow('方案已不存在')
    binding.areaAttributePriceId = plan.areaAttributePriceId
    binding.categoryId = 'missing'
    expect(() => validateAreaReferences(document, bundle)).toThrow('大类 missing 已不存在')
    binding.categoryId = 'keychains'
    document.productAttributeOverrides.push({ productId: 'missing', optionName: plan.optionName, reference: plan.reference, areaAttributePriceId: null })
    expect(() => validateAreaReferences(document, bundle)).toThrow('产品 missing 已不存在')
    document.productAttributeOverrides[0].productId = bundle.main.uncategorizedProducts[0].productId
    expect(() => validateAreaReferences(document, bundle)).toThrow('尚未归属产品大类')
    document.productAttributeOverrides = []
    plan.areaTemplateId = 'missing'
    expect(() => validateAreaPricing(document)).toThrow('面积模板引用无效')
  })

  test('only typed billable attribute entities are allowed, including explicit unpriced bindings', () => {
    const { document } = fixture()
    const { plan } = addPlan(document)
    for (const [optionName, reference] of [['Print Option', { printOptionId: 'P1' }], ['Accessories Style', { accessoryStyleId: 'A1' }]] as const) {
      expect(() => validateAreaPricing({ ...document, attributes: [{ ...plan, optionName, reference }] })).toThrow()
    }
    for (const reference of [{ id: 'G11' }, { techniqueId: 'G11', materialId: 'G11' }, { materialId: 'G11' }, { techniqueId: '' }]) {
      expect(() => validateAreaPricing({ ...document, categoryAttributeBindings: [{ categoryId: 'keychains', optionName: 'Technique', reference, areaAttributePriceId: null }] })).toThrow('实体字段')
    }
    const sameId = structuredClone(plan)
    expect(() => validateAreaPricing({ ...document, attributes: [plan, sameId] })).toThrow('重复')
    expect(() => validateAreaPricing({ ...document, categoryAttributeBindings: undefined })).toThrow()
    expect(() => validateAreaPricing({ ...document, productAttributeOverrides: null })).toThrow()
    expect(() => validateAreaPricing({ ...document, attributes: [{ ...plan, charge: createAreaCharge(document.templates[0]) }] })).toThrow('字段无效')
  })

  test('migrates old charges into independently priced plans sharing equivalent reusable templates', () => {
    const { bundle, document } = pricedLegacyFixture()
    const first = document.attributes[0]
    first.charge.basePrice = '0'
    first.charge.tierPrices = [{ areaTierId: document.templates[0].tiers[0].areaTierId, price: '0' }, { areaTierId: document.templates[0].tiers[1].areaTierId, price: '0.123' }]
    first.charge.formula = '基本价 + 档位价格 * (面积平方毫米 / 100)'
    document.attributes.push({ ...structuredClone(first), areaAttributePriceId: 'old-G12', reference: { techniqueId: 'G12' } })
    const before = structuredClone(document)
    const next = upgradeAreaPricing(document, bundle)
    expect(getAdditionalAttributePrices(next).map(row => row.areaAttributePriceId)).toEqual(['old-G11', 'old-G12'])
    expect(getAdditionalAttributePrices(next).every(row => !Object.hasOwn(row, 'charge'))).toBe(true)
    expect(new Set(getAdditionalAttributePrices(next).map(row => row.areaTemplateId)).size).toBe(1)
    for (const plan of getAdditionalAttributePrices(next)) {
      const template = next.templates.find(row => row.areaTemplateId === plan.areaTemplateId)!
      expect(template.name).toMatch(/^面积档位/)
      expect(template).toMatchObject({ unit: before.templates[0].unit, basePrice: null, formula: first.charge.formula })
      expect(template.tiers.map(row => row.maxArea)).toEqual(before.templates[0].tiers.map(row => row.maxArea))
      expect(template.tierPrices.every(row => row.price === null)).toBe(true)
      expect(plan.basePrice).toBe('0')
      expect(plan.tierPrices.map(row => row.price)).toEqual(['0', '0.123', null])
      expect(next.categoryAdditionalPlanBindings.filter(row => row.additionalPricePlanId === next.additionalPricePlans[0].additionalPricePlanId)).toHaveLength(bundle.main.categories.length)
    }
    expect(next.templates[0]).toEqual(before.templates[0])
    const originalPlan = getAdditionalAttributePrices(next)[0]
    originalPlan.basePrice = '999'
    expect(next.templates[0]).toEqual(before.templates[0])
    expect(getAdditionalAttributePrices(next)[1].basePrice).toBe('0')
    expect(document).toEqual(before)
    expect(upgradeAreaPricing(document, bundle)).toEqual(upgradeAreaPricing(before, bundle))
    expect(upgradeAreaPricing(next, bundle)).toEqual(next)
    expect(() => validateAreaReferences(next, bundle)).not.toThrow()
  })

  test('migration preserves independently verified charge totals, boundaries, discount and fixed accessories', () => {
    const { bundle, product, document, input } = pricedLegacyFixture()
    Object.assign(optionFor(product, 'Technique')!, { deleted: false, disabledValues: [] })
    Object.assign(optionFor(product, 'Accessories Style')!, { deleted: false, disabledValues: [] })
    const style = catalogFor(bundle, product, 'Accessories Style').values[0]
    document.accessoryPrices!.find(row => row.accessoryStyleId === getEntityId(style) && row.accessoryColorId === null)!.unitPrice = '0.3'
    Object.assign(document.attributes[0].charge, { basePrice: '0.5', formula: '基本价 + 档位价格 * 面积平方毫米' })
    document.attributes[0].charge.tierPrices.forEach((tier, index) => { tier.price = ['0.001', '0.002', '0.003'][index] })
    Object.assign(input, { selections: { Technique: 'G11', 'Accessories Style': getEntityId(style) }, quantity: 3 })
    const discount: QuantityPricingDocument = { schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers: [{ quantityTierId: 'qty-20', minQty: 1, maxQty: null, discountPercent: 20 }] }] }
    const next = upgradeAreaPricing(document, bundle)
    const cases = [
      { width: '20', height: '10', unit: 'mm' as const, attribute: '0.7', total: '9.60' },
      { width: '10', height: '1', unit: 'in' as const, attribute: '6.9516', total: '99.62' },
      { width: '100', height: '100', unit: 'mm' as const, attribute: '20.5', total: '174.72' },
    ]
    for (const { attribute, total, ...dimensions } of cases) {
      const result = quoteAreaProduct(next, bundle, discount, { ...input, ...dimensions })
      expect(result.steps[1].amount).toBe(attribute)
      expect(result.variables['配件价']).toBe('0.3')
      expect(result.totalPrice).toBe(total)
    }
    const result = quoteAreaProduct(next, bundle, discount, { ...input, width: '2', height: '1', unit: 'cm' })
    expect(result.totalPrice).toBe('9.60')
  })

  test('migration uses stable collision-safe template and tier identifiers', () => {
    const { bundle, document } = pricedLegacyFixture()
    document.attributes[0].charge.formula = '基本价 + 档位价格'
    document.templates.push(createPricedAreaTemplate({ areaTemplateId: 'area-template-old-G11', name: '已有同名标识', unit: 'mm', tiers: [{ areaTierId: 'area-template-old-G11-1-tier-1', maxArea: null }] }))
    const next = upgradeAreaPricing(document, bundle)
    expect(getAdditionalAttributePrices(next)[0].areaTemplateId).toBe('area-template-old-G11-2')
    expect(new Set(next.templates.flatMap(row => row.tiers.map(tier => tier.areaTierId))).size).toBe(next.templates.reduce((count, row) => count + row.tiers.length, 0))
    expect(upgradeAreaPricing(document, bundle)).toEqual(next)
  })

  test('schema6 reloads do not create plans or assign new public attributes or categories', () => {
    const { bundle, document } = pricedLegacyFixture()
    const next = upgradeAreaPricing(document, bundle)
    next.categoryAdditionalPlanBindings = []
    bundle.main.categories.push({ ...structuredClone(bundle.main.categories[0]), name: 'new-category', products: [] })
    const reloaded = upgradeAreaPricing(next, bundle)
    expect(reloaded.categories.at(-1)).toEqual({ categoryId: 'new-category', areaTemplateId: null })
    expect(reloaded.categoryAdditionalPlanBindings).toEqual([])
    expect(reloaded.productAdditionalPlanOverrides).toEqual([])
    expect(getAdditionalAttributePrices(reloaded)).toEqual(getAdditionalAttributePrices(next))
    expect(reloaded.templates).toEqual(next.templates)
  })

  test('schema3 legacy printing stays free and accessory charges become fixed prices rather than plans', () => {
    const { bundle, document } = pricedLegacyFixture()
    delete document.accessoryPrices
    const style = bundle.catalogs['accessory-styles.json'].values[0]
    const print = bundle.catalogs['print-options.json'].values[0]
    const charge = createAreaCharge(document.templates[0])
    charge.basePrice = '0'
    charge.tierPrices[0].price = '999'
    document.attributes.push({ areaAttributePriceId: 'legacy-accessory', optionName: 'Accessories Style', reference: { accessoryStyleId: getEntityId(style) }, charge })
    document.attributes.push({ areaAttributePriceId: 'legacy-print', optionName: 'Print Option', reference: { printOptionId: getEntityId(print) }, charge: createAreaCharge(document.templates[0]) })
    const next = upgradeAreaPricing(document, bundle)
    expect(getAdditionalAttributePrices(next).map(row => row.areaAttributePriceId)).toEqual(['old-G11'])
    expect(next.accessoryPrices!.find(row => row.accessoryStyleId === getEntityId(style) && row.accessoryColorId === null)!.unitPrice).toBe('0')
    expect(() => validateAreaReferences(next, bundle)).not.toThrow()
  })
})


describe('longest-side pricing templates', () => {
  function longestFixture() {
    const state = fixture()
    const template = state.pricing.body
    template.matchBy = 'longest-side'
    template.unit = 'mm'
    template.tiers[0].maxArea = '50'
    template.tiers[1].maxArea = '100'
    template.basePrice = '0.5'
    template.tierPrices.forEach((tier, index) => { tier.price = ['1', '2', '3'][index] })
    template.formula = '基本价 + 档位价格'
    return { ...state, template }
  }

  test('matches the larger dimension, not area, and remains invariant under rotation', () => {
    const { input, quote, template } = longestFixture()
    Object.assign(input, { width: '20', height: '10', unit: 'mm' })
    expect(quote()).toMatchObject({ areaMm2: '200', longestSideMm: '20', totalPrice: '1.50' })
    expect(quote().steps[0]).toMatchObject({ matchBy: 'longest-side', longestSideMm: '20', tierLabel: 'L ≤ 50 mm' })
    Object.assign(input, { width: '10', height: '20' })
    expect(quote()).toMatchObject({ areaMm2: '200', longestSideMm: '20', totalPrice: '1.50' })
    Object.assign(input, { width: '100', height: '2' })
    expect(quote()).toMatchObject({ areaMm2: '200', longestSideMm: '100', totalPrice: '2.50' })
    expect(quote().steps[0].tierLabel).toBe('50 < L ≤ 100 mm')
    input.width = '101'
    expect(quote().steps[0].tierLabel).toBe('L > 100 mm')
    expect(templateUnitLabel(template)).toBe('mm')
  })

  test('matches exact inclusive and exclusive length boundaries without swallowing physical differences', () => {
    const { input, quote, template } = longestFixture()
    Object.assign(input, { width: '50', height: '10', unit: 'mm' })
    expect(quote().steps[0].tierPrice).toBe('1')
    input.width = '50.0000000001'
    expect(quote().steps[0].tierPrice).toBe('2')
    input.width = '49.9999999999'
    expect(quote().steps[0].tierPrice).toBe('1')
    template.boundaryMode = 'lower-inclusive'
    input.width = '50'
    expect(quote().steps[0]).toMatchObject({ tierPrice: '2', tierLabel: '50 ≤ L < 100 mm' })
    input.width = '100'
    expect(quote().steps[0]).toMatchObject({ tierPrice: '3', tierLabel: 'L ≥ 100 mm' })
  })

  test('converts longest-side template units linearly and keeps recurring-conversion boundary matches', () => {
    expect(convertLengthValue('2', 'in', 'cm')).toBe('5.08')
    expect(convertLengthValue('2', 'in', 'mm')).toBe('50.8')
    expect(convertLengthValue('50.8', 'mm', 'in')).toBe('2')
    expect(convertLengthValue('', 'mm', 'cm')).toBe('')
    for (const value of ['0', '-1', 'NaN', 'Infinity', '1e2']) expect(() => convertLengthValue(value, 'mm', 'cm')).toThrow()
    const { input, quote, template } = longestFixture()
    template.tiers[0].maxArea = '30'
    Object.assign(input, { width: '30', height: '10', unit: 'mm' })
    const initial = quote()
    template.tiers.forEach(tier => { if (tier.maxArea !== null) tier.maxArea = convertLengthValue(tier.maxArea, 'mm', 'in') })
    template.unit = 'in'
    expect(template.tiers[0].maxArea).toBe('1.181102362204724409')
    expect(quote()).toMatchObject({ totalPrice: initial.totalPrice, longestSideMm: '30' })
    expect(quote().steps[0].areaTierId).toBe(initial.steps[0].areaTierId)
    for (let repeat = 0; repeat < 5; repeat++) {
      for (const unit of ['cm', 'mm', 'in'] as const) {
        template.tiers.forEach(tier => { if (tier.maxArea !== null) tier.maxArea = convertLengthValue(tier.maxArea, template.unit, unit) })
        template.unit = unit
        expect(quote().steps[0].areaTierId).toBe(initial.steps[0].areaTierId)
        expect(quote().totalPrice).toBe(initial.totalPrice)
      }
    }
    template.boundaryMode = 'lower-inclusive'
    expect(quote().steps[0].tierPrice).toBe('2')
    for (const dimensions of [
      { width: '2', height: '1', unit: 'in' as const },
      { width: '5.08', height: '2.54', unit: 'cm' as const },
      { width: '50.8', height: '25.4', unit: 'mm' as const },
    ]) {
      Object.assign(input, dimensions)
      expect(quote()).toMatchObject({ areaMm2: '1290.32', longestSideMm: '50.8', totalPrice: '2.50' })
    }
  })

  test('longest-side matching leaves the price formula independent and supports area, length or fixed charging', () => {
    const { input, quote, template } = longestFixture()
    Object.assign(input, { width: '20', height: '10', unit: 'mm' })
    template.tierPrices[0].price = '0.01'
    template.formula = DEFAULT_AREA_FORMULA
    expect(quote().totalPrice).toBe('2.50')
    template.formula = '基本价 + 档位价格 * 最长边毫米'
    expect(quote().totalPrice).toBe('0.70')
    expect(quote().steps[0].substitutedFormula).toBe('(0.5) + (0.01) * (20)')
    expect(getTemplateFormulaVariables(template)).toContain('最长边毫米')
    template.formula = '基本价 + 档位价格'
    expect(quote().totalPrice).toBe('0.51')
    template.tierPrices[0].price = null
    expect(() => quote()).toThrow('档位价格')
    template.tierPrices[0].price = '0'
    expect(quote().totalPrice).toBe('0.50')
  })

  test('uses independent area and longest-side templates for body and selected attributes', () => {
    const { product, document, input, quote } = fixture()
    Object.assign(optionFor(product, 'Technique')!, { deleted: false, disabledValues: [] })
    input.selections.Technique = 'G11'
    const { plan, template } = addPlan(document)
    template.matchBy = 'longest-side'
    template.unit = 'cm'
    template.tiers[0].maxArea = '3'
    template.tiers[1].maxArea = '6'
    plan.basePrice = '0'
    template.formula = '基本价 + 档位价格'
    plan.tierPrices.forEach((tier, index) => { tier.price = ['0.1', '0.2', '0.3'][index] })
    document.categoryAttributeBindings.push({ categoryId: 'keychains', optionName: plan.optionName, reference: plan.reference, areaAttributePriceId: plan.areaAttributePriceId })
    Object.assign(input, { width: '20', height: '10', unit: 'mm' })
    expect(quote()).toMatchObject({ totalPrice: '3.10', variables: { 大类主体价: '3', 属性价: '0.1' } })
    expect(quote().steps.map(step => step.matchBy)).toEqual(['area', 'longest-side'])
    Object.assign(input, { width: '40', height: '5' })
    expect(quote()).toMatchObject({ totalPrice: '3.20', variables: { 大类主体价: '3', 属性价: '0.2' } })
    const body = document.templates[0]
    body.matchBy = 'longest-side'
    body.unit = 'mm'
    body.tiers[0].maxArea = '30'
    body.tiers[1].maxArea = '60'
    body.formula = '档位价格'
    body.tierPrices[0].price = '1'
    body.tierPrices[1].price = '2'
    template.matchBy = 'area'
    template.unit = 'mm'
    template.tiers[0].maxArea = '300'
    template.tiers[1].maxArea = '600'
    expect(quote()).toMatchObject({ totalPrice: '2.10', variables: { 大类主体价: '2', 属性价: '0.1' } })
    expect(quote().steps.map(step => step.matchBy)).toEqual(['longest-side', 'area'])
  })

  test('standard dimensions retain their exact configured longest side after displayed unit conversion', () => {
    const { bundle, product, input, quote, template } = longestFixture()
    const option = optionFor(product, 'Size')!
    option.deleted = false
    option.disabledValues = []
    const standard = catalogFor(bundle, product, 'Size').values.find(value => !value.isCustom)!
    standard.area = { width: '3', height: '1', unit: 'cm' }
    template.tiers[0].maxArea = '30'
    template.formula = '最长边毫米'
    Object.assign(input, { sizeBandId: getEntityId(standard), width: '1.181102362204724409', height: '0.393700787401574803', unit: 'in' })
    expect(quote()).toMatchObject({ areaMm2: '300', longestSideMm: '30', totalPrice: '30.00' })
    expect(quote().steps[0].tierPrice).toBe('1')
    ;[input.width, input.height] = [input.height, input.width]
    expect(quote()).toMatchObject({ areaMm2: '300', longestSideMm: '30', totalPrice: '30.00' })
    input.width = '1'
    expect(() => quote()).toThrow('标准尺寸宽高')
  })

  test('supports matchBy in schema4 and newer and preserves existing area documents without rewriting them', () => {
    const { bundle, document, quote } = fixture()
    const before = structuredClone(document)
    expect(getTemplateMatchBy(document.templates[0])).toBe('area')
    expect(templateUnitLabel(document.templates[0])).toBe('in²')
    expect(getTemplateFormulaVariables(document.templates[0])).not.toContain('最长边毫米')
    expect(quote().totalPrice).toBe('3.00')
    expect(upgradeAreaPricing(document, bundle).templates).toEqual(before.templates)
    document.templates[0].matchBy = 'area'
    expect(quote().totalPrice).toBe('3.00')
    for (const invalid of [null, 'width', 1]) {
      const malformed = structuredClone(document)
      Object.assign(malformed.templates[0], { matchBy: invalid })
      expect(() => validateAreaPricing(malformed)).toThrow('分档依据')
    }
    document.templates[0].formula = '最长边毫米'
    expect(() => validateAreaPricing(document)).toThrow('不可用')
    document.templates[0].matchBy = 'longest-side'
    expect(() => validateAreaPricing(document)).not.toThrow()
    for (const legacy of [legacyFixture().document, categoryLegacyFixture().document, pricedLegacyFixture().document]) {
      legacy.templates[0].matchBy = 'longest-side'
      expect(() => validateAreaPricing(legacy)).toThrow('字段无效')
    }
  })
})

describe('scheme-owned amounts and reusable template migration', () => {
  test('schema4 migration reuses a matching body template, preserves exact money and remaps tier IDs', () => {
    const { bundle, product, document, input, addLegacyPlan, charge } = schemeLegacyFixture()
    Object.assign(optionFor(product, 'Technique')!, { deleted: false, disabledValues: [] })
    input.selections.Technique = 'G11'
    const first = addLegacyPlan('normal')
    charge(first.template, '0', '0.123456789012345678')
    first.template.tierPrices[2].price = null
    first.template.tierPrices.reverse()
    const second = addLegacyPlan('special')
    charge(second.template, '0.50', '0')
    document.categoryAttributeBindings.push({ categoryId: 'keychains', optionName: first.plan.optionName, reference: first.plan.reference, areaAttributePriceId: first.plan.areaAttributePriceId })
    document.productAttributeOverrides.push({ productId: 'P32', optionName: second.plan.optionName, reference: second.plan.reference, areaAttributePriceId: second.plan.areaAttributePriceId })
    const before = structuredClone(document)
    const next = upgradeAreaPricing(document, bundle)
    expect(next.schemaVersion).toBe(7)
    expect(next.templates).toEqual([before.templates[0]])
    expect(getAdditionalAttributePrices(next).map(plan => [plan.areaAttributePriceId, plan.areaTemplateId, plan.basePrice])).toEqual([
      ['normal', before.templates[0].areaTemplateId, '0'], ['special', before.templates[0].areaTemplateId, '0.50'],
    ])
    expect(getAdditionalAttributePrices(next)[0].tierPrices).toEqual(before.templates[0].tiers.map((tier, index) => ({ areaTierId: tier.areaTierId, price: index === 2 ? null : '0.123456789012345678' })))
    expect(next.categoryAdditionalPlanBindings).toEqual([{ categoryId: 'keychains', additionalPricePlanId: next.additionalPricePlans[0].additionalPricePlanId }])
    expect(next.productAdditionalPlanOverrides).toEqual([{ productId: 'P32', additionalPricePlanId: next.additionalPricePlans[1].additionalPricePlanId }])
    expect(quoteAreaProduct(next, bundle, noDiscount, input)).toMatchObject({ totalPrice: '27.69', variables: { 工艺价: '24.6913578024691356' } })
    expect(next.productTotalFormulas).toEqual([])
    expect(document).toEqual(before)
    expect(upgradeAreaPricing(next, bundle)).toEqual(next)
  })

  test('preserves base-bound and unreferenced templates while consolidating only equivalent attribute definitions', () => {
    const { bundle, document, addLegacyPlan } = schemeLegacyFixture()
    const first = addLegacyPlan('first', '基本价 + 档位价格')
    const equivalent = addLegacyPlan('equivalent', '=基本价＋档位价格'.replace('＋', '+'))
    const longest = addLegacyPlan('longest', '基本价 + 档位价格')
    longest.template.matchBy = 'longest-side'
    const lower = addLegacyPlan('lower', '基本价 + 档位价格')
    lower.template.boundaryMode = 'lower-inclusive'
    const differentUnit = addLegacyPlan('centimeters', '基本价 + 档位价格')
    differentUnit.template.unit = 'cm'
    const overrideTemplate = structuredClone(first.template)
    overrideTemplate.areaTemplateId = 'base-override'
    overrideTemplate.name = '自定义子类主体'
    overrideTemplate.tiers.forEach((tier, index) => { tier.areaTierId = `override-${index}` })
    overrideTemplate.tierPrices = overrideTemplate.tiers.map(tier => ({ areaTierId: tier.areaTierId, price: '9' }))
    document.templates.push(overrideTemplate)
    document.productOverrides.push({ productId: 'P32', areaTemplateId: overrideTemplate.areaTemplateId })
    const unused = createPricedAreaTemplate({ areaTemplateId: 'user-unused', name: '用户新建未使用', unit: 'mm', tiers: [{ areaTierId: 'unused-tier', maxArea: null }] })
    document.templates.push(unused)
    const next = upgradeAreaPricing(document, bundle)
    expect(next.templates).toHaveLength(6)
    expect(next.templates.find(row => row.areaTemplateId === unused.areaTemplateId)).toEqual(unused)
    expect(next.templates.find(row => row.areaTemplateId === overrideTemplate.areaTemplateId)).toEqual(overrideTemplate)
    expect(getAdditionalAttributePrices(next).find(row => row.areaAttributePriceId === first.plan.areaAttributePriceId)!.areaTemplateId).toBe('base-override')
    expect(getAdditionalAttributePrices(next).find(row => row.areaAttributePriceId === equivalent.plan.areaAttributePriceId)!.areaTemplateId).toBe('base-override')
    expect(new Set(getAdditionalAttributePrices(next).map(row => row.areaTemplateId)).size).toBe(4)
    expect(next.templates.filter(row => ['longest', 'lower', 'centimeters'].some(id => row.areaTemplateId === `template-${id}`)).every(row => row.basePrice === null && row.tierPrices.every(tier => tier.price === null))).toBe(true)
    expect(() => validateAreaReferences(next, bundle)).not.toThrow()
  })

  test('two plans share a template formula and boundaries but never share its body amounts or each other’s prices', () => {
    const { bundle, product, document, input, charge, quote } = fixture()
    Object.assign(optionFor(product, 'Technique')!, { deleted: false, disabledValues: [] })
    input.selections.Technique = 'G11'
    const template = document.templates[0]
    const first = { areaAttributePriceId: 'shared-first', name: '普通工艺', optionName: 'Technique', reference: { techniqueId: 'G11' }, areaTemplateId: template.areaTemplateId, ...createAttributePlanPrices(template) }
    const second = { ...structuredClone(first), areaAttributePriceId: 'shared-second', name: '另一价格', ...createAttributePlanPrices(template) }
    document.attributes.push(first, second)
    charge(first, '0.5', '0.001')
    charge(second, '9', '0')
    document.categoryAttributeBindings.push({ categoryId: 'keychains', optionName: first.optionName, reference: first.reference, areaAttributePriceId: first.areaAttributePriceId })
    expect(quote().totalPrice).toBe('3.70')
    template.basePrice = '3'
    expect(quote().variables).toMatchObject({ 大类主体价: '4', 属性价: '0.7' })
    first.basePrice = '1'
    expect(quote().variables['属性价']).toBe('1.2')
    expect(second.basePrice).toBe('9')
    expect(second.tierPrices.map(row => row.price)).toEqual(['0', '0', '0'])
    template.formula = '基本价 + 档位价格'
    expect(quote().variables).toMatchObject({ 大类主体价: '3.005', 属性价: '1.001' })
    first.tierPrices[1].price = '0.002'
    template.unit = 'mm'
    template.tiers[0].maxArea = '100'
    template.tiers[1].maxArea = '300'
    expect(quote().variables['属性价']).toBe('1.002')
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
  })

  test('new default formulas follow the matching basis and existing formulas survive upgrade', () => {
    const { bundle, document, addLegacyPlan } = schemeLegacyFixture()
    expect(getDefaultTemplateFormula('area')).toBe(DEFAULT_AREA_FORMULA)
    expect(getDefaultTemplateFormula('longest-side')).toBe('基本价 + 档位价格')
    const longest = addLegacyPlan('length', '基本价 + 档位价格 * 最长边毫米')
    longest.template.matchBy = 'longest-side'
    expect(createAreaCharge(longest.template).formula).toBe('基本价 + 档位价格')
    const next = upgradeAreaPricing(document, bundle)
    expect(next.templates.find(row => row.areaTemplateId === getAdditionalAttributePrices(next)[0].areaTemplateId)!.formula).toBe('基本价 + 档位价格 * 最长边毫米')
  })
})

describe('product-specific final total formulas', () => {
  test('reports uncategorized formula owners through the repairable reference error before variable validation', () => {
    const { bundle, document } = fixture()
    const product = bundle.main.uncategorizedProducts[0]
    product.productOptions.forEach(option => { option.deleted = true })
    document.productTotalFormulas.push({ productId: product.productId, formula: '工艺价 + 大类主体价' })
    expect(() => validateAreaPricing(document)).not.toThrow()
    expect(() => validateAreaReferences(document, bundle)).toThrow(`总价公式引用的产品 ${product.productId} 尚未归属产品大类`)
    document.productTotalFormulas = []
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
  })

  test('only exposes enabled product variables and adapts its default formula', () => {
    const { bundle, product, document, input } = fixture()
    expect(getProductTotalVariables(bundle, product.productId)).toEqual(['大类主体价', '折扣系数', '数量'])
    expect(getDefaultProductTotalFormula(bundle, product.productId)).toBe('(大类主体价) * 折扣系数 * 数量')
    Object.assign(optionFor(product, 'Technique')!, { deleted: false, disabledValues: [] })
    Object.assign(optionFor(product, 'Size')!, { deleted: false, disabledValues: [] })
    Object.assign(optionFor(product, 'Standee Quantity')!, { deleted: false, disabledValues: [] })
    Object.assign(optionFor(product, 'Print Option')!, { deleted: false, disabledValues: [] })
    expect(getProductTotalVariables(bundle, product.productId)).toEqual(['大类主体价', '属性价', '工艺价', '面积平方毫米', '最长边毫米', '主体片数', '折扣系数', '数量'])
    expect(resolveProductTotalFormula(document, bundle, input.productId)).toBe('(大类主体价 + 工艺价) * 折扣系数 * 数量')
    Object.assign(optionFor(product, 'Holo Film')!, { deleted: false, disabledValues: [] })
    expect(getDefaultProductTotalFormula(bundle, product.productId)).toBe('(大类主体价 + 工艺价 + 全息膜价) * 折扣系数 * 数量')
    optionFor(product, 'Holo Film')!.deleted = true
    expect(getDefaultProductTotalFormula(bundle, product.productId)).toBe('(大类主体价 + 工艺价) * 折扣系数 * 数量')
    optionFor(product, 'Technique')!.disabledValues = catalogFor(bundle, product, 'Technique').values.map(value => ({ techniqueId: getEntityId(value) }))
    expect(getProductTotalVariables(bundle, product.productId)).not.toContain('属性价')
    expect(getProductTotalVariables(bundle, product.productId)).not.toContain('工艺价')
    expect(getProductTotalVariables(bundle, product.productId)).not.toContain('印刷价')
    expect(getDefaultProductTotalFormula(bundle, product.productId)).toBe('(大类主体价) * 折扣系数 * 数量')
    Object.assign(optionFor(product, 'Accessories Style')!, { deleted: false, disabledValues: [] })
    expect(getDefaultProductTotalFormula(bundle, product.productId)).toBe('(大类主体价 + 配件价) * 折扣系数 * 数量')
    expect(() => getProductTotalVariables(bundle, 'missing')).toThrow('已不存在')
  })

  test('persists separate formulas for products in the same category and keeps exact rational totals', () => {
    const { bundle, document, input, pricing, quote } = fixture()
    const sibling = allProducts(bundle.main).find(product => product.productId === 'P32')!
    sibling.productOptions.forEach(option => { option.deleted = true })
    document.productTotalFormulas.push({ productId: 'P31', formula: '=(大类主体价 / 3) * 数量 + 0.005' })
    pricing.body.formula = '基本价'
    pricing.body.basePrice = '1'
    input.quantity = 3
    expect(quote()).toMatchObject({ totalPrice: '1.01', formula: '=(大类主体价 / 3) * 数量 + 0.005' })
    expect(quote().substitutedFormula).toContain('(1)')
    expect(quoteAreaProduct(document, bundle, noDiscount, { ...input, productId: 'P32' }).totalPrice).toBe('3.00')
    document.productTotalFormulas.push({ productId: 'P32', formula: '大类主体价 * 数量 / 2' })
    expect(quoteAreaProduct(document, bundle, noDiscount, { ...input, productId: 'P32' }).totalPrice).toBe('1.50')
    expect(quote().totalPrice).toBe('1.01')
    expect(upgradeAreaPricing(document, bundle).productTotalFormulas).toEqual(document.productTotalFormulas)
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
  })

  test('custom totals can use actual dimensions, piece count and individually selected attributes', () => {
    const { bundle, product, document, input, charge, quote } = fixture()
    for (const name of ['Technique', 'Size', 'Standee Quantity']) Object.assign(optionFor(product, name)!, { deleted: false, disabledValues: [] })
    const pieces = catalogFor(bundle, product, 'Standee Quantity').values.find(value => value.pieceCount === 3)!
    input.standeeQuantityId = getEntityId(pieces)
    input.selections.Technique = 'G11'
    const { plan } = addPlan(document)
    charge(plan, '0.5', '0.001')
    document.categoryAttributeBindings.push({ categoryId: 'keychains', optionName: plan.optionName, reference: plan.reference, areaAttributePriceId: plan.areaAttributePriceId })
    document.productTotalFormulas.push({ productId: 'P31', formula: '(大类主体价 + 工艺价) * 主体片数 * 数量 + 面积平方毫米 / 100 + 最长边毫米 / 10' })
    input.quantity = 2
    expect(quote()).toMatchObject({ totalPrice: '26.20', variables: { 主体片数: '3', 面积平方毫米: '200', 最长边毫米: '20', 工艺价: '0.7', 属性价: '0.7' } })
    plan.basePrice = null
    document.productTotalFormulas[0].formula = '大类主体价'
    expect(() => quote()).toThrow('未定价')
  })

  test('rejects disabled or unknown variables, stale formula owners, duplicate owners and executable syntax', () => {
    const { bundle, document, quote } = fixture()
    const row = { productId: 'P31', formula: '工艺价 + 大类主体价' }
    document.productTotalFormulas.push(row)
    expect(() => validateAreaPricing(document)).not.toThrow()
    expect(() => validateAreaReferences(document, bundle)).toThrow('产品 P31 的总价公式无效')
    expect(() => quote()).toThrow('不可用')
    for (const formula of ['面积平方毫米', '最长边毫米', '主体片数', '配件价', '属性价']) {
      row.formula = formula
      expect(() => quote(), formula).toThrow('不可用')
    }
    for (const formula of ['印刷价', 'globalThis.process.exit()', '大类主体价 ** 2', '大类主体价; 1']) {
      row.formula = formula
      expect(() => validateAreaPricing(document), formula).toThrow()
    }
    row.formula = '大类主体价'
    row.productId = 'missing'
    expect(() => validateAreaReferences(document, bundle)).toThrow('总价公式引用的产品 missing 已不存在')
    row.productId = 'P31'
    document.productTotalFormulas.push({ ...row })
    expect(() => validateAreaPricing(document)).toThrow('重复')
    expect(() => validateAreaPricing({ ...document, productTotalFormulas: undefined })).toThrow()
  })

  test('rejects zero division and negative custom totals while permitting explicitly free totals', () => {
    const { document, quote } = fixture()
    const row = { productId: 'P31', formula: '大类主体价 / (数量 - 1)' }
    document.productTotalFormulas.push(row)
    expect(() => quote()).toThrow('除以 0')
    row.formula = '大类主体价 - 4'
    expect(() => quote()).toThrow('最终价格不能为负数')
    row.formula = '0'
    expect(quote().totalPrice).toBe('0.00')
  })
})


describe('standee pieces and independent base pricing', () => {
  test('each selected piece matches its own longest-side tier and the separately sized base is charged once', () => {
    const { document, bundle, input, quote } = standeeFixture()
    expect(optionFor(allProducts(bundle.main).find(row => row.productId === input.productId)!, 'Size')!.deleted).toBe(true)
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
    const result = quote()
    expect(result).toMatchObject({ totalPrice: '7.30', unitPrice: '7.3', variables: { 大类主体价: '7.3', 主体片数: '2' } })
    expect(result.steps[0].parts?.map(step => ({ tier: step.areaTierId, amount: step.amount }))).toEqual([
      { tier: 'piece-0', amount: '2.5' }, { tier: 'piece-1', amount: '3.5' }, { tier: 'base-1', amount: '1.3' },
    ])
    input.standee!.parts[1] = { width: '3', height: '7', unit: 'cm' }
    input.standee!.base = { width: '3', height: '6', unit: 'cm' }
    expect(quote().totalPrice).toBe('7.30')
    input.standee!.parts.pop()
    input.standeeQuantityId = 'SQ1'
    expect(quote().totalPrice).toBe('3.80')
  })

  test('selected attribute pieces and their own base prices are summed before one fixed accessory, discount and purchase quantity', () => {
    const { document, bundle, product, template, input, quote, categoryId } = standeeFixture()
    for (const name of ['Technique', 'Holo Film', 'Accessories Style']) Object.assign(optionFor(product, name)!, { deleted: false, disabledValues: [] })
    const plan = createAdditionalPricePlan(bundle, template, '立牌附加方案')
    const technique = plan.prices.find(price => price.reference.techniqueId === 'G11')!
    const film = plan.prices.find(price => price.reference.holoFilmId === 'M2')!
    technique.basePrice = '0.2'
    technique.tierPrices.forEach((price, index) => { price.price = ['0.1', '0.4', '0.6'][index] })
    technique.standeeBase!.basePrice = '0.05'
    technique.standeeBase!.tierPrices.forEach(price => { price.price = '0.15' })
    film.basePrice = '0.1'
    film.tierPrices.forEach((price, index) => { price.price = ['0.2', '0.3', '0.4'][index] })
    film.standeeBase!.basePrice = '0.02'
    film.standeeBase!.tierPrices.forEach(price => { price.price = '0.08' })
    document.additionalPricePlans.push(plan)
    document.categoryAdditionalPlanBindings.push({ categoryId, additionalPricePlanId: plan.additionalPricePlanId })
    const accessoryStyleId = getEntityId(catalogFor(bundle, product, 'Accessories Style').values[0])
    document.accessoryPrices!.find(price => price.accessoryStyleId === accessoryStyleId && price.accessoryColorId === null)!.unitPrice = '0.3'
    input.selections = { Technique: 'G11', 'Holo Film': 'M2', 'Accessories Style': accessoryStyleId }
    input.quantity = 3
    const discount: QuantityPricingDocument = { schemaVersion: 1, categoryRules: [{ categoryId, tiers: [{ quantityTierId: 'standee-qty', minQty: 3, maxQty: null, discountPercent: 20 }] }] }
    expect(quote(discount)).toMatchObject({ totalPrice: '22.80', unitPrice: '9.5', variables: { 大类主体价: '7.3', 工艺价: '1.1', 全息膜价: '0.8', 配件价: '0.3', 主体片数: '2', 数量: '3', 折扣系数: '0.8' } })
    expect(quote(discount).steps.map(step => step.parts?.length ?? 0)).toEqual([3, 3, 3, 0])
    technique.standeeBase!.tierPrices[1].price = null
    expect(() => quote(discount)).toThrow(/底座.*未定价|未定价.*底座/)
  })

  test('missing dimensions, wrong piece counts and missing base prices cannot fall back to a single-size or zero-base quote', () => {
    const { template, input, quote } = standeeFixture()
    const original = structuredClone(input.standee!)
    input.standee = undefined
    expect(() => quote()).toThrow(/主体.*宽高/)
    input.standee = structuredClone(original)
    input.standee.parts.pop()
    expect(() => quote()).toThrow(/片数|主体.*数量/)
    input.standee = structuredClone(original)
    input.standee.parts[1].width = ''
    expect(() => quote()).toThrow()
    input.standee = structuredClone(original)
    input.standee.base.height = ''
    expect(() => quote()).toThrow()
    input.standee = structuredClone(original)
    template.standeeBase!.tierPrices[1].price = null
    expect(() => quote()).toThrow(/底座.*未定价|未定价.*底座/)
    delete template.standeeBase
    expect(() => quote()).toThrow('底座')
  })

  test('base configuration survives reload, creates blank attribute amounts and rejects unrelated base tiers', () => {
    const { document, bundle, template, quote } = standeeFixture()
    const plan = createAdditionalPricePlan(bundle, template, '未定价立牌方案')
    document.additionalPricePlans.push(plan)
    expect(plan.prices.every(price => price.standeeBase?.basePrice === null && price.standeeBase.tierPrices.every(row => row.price === null))).toBe(true)
    const stored = JSON.parse(JSON.stringify(document))
    expect(upgradeAreaPricing(stored, bundle)).toEqual(document)
    expect(quote().totalPrice).toBe('7.30')
    plan.prices[0].standeeBase!.tierPrices[0].areaTierId = 'piece-0'
    expect(() => validateAreaPricing(document)).toThrow()
    plan.prices[0].standeeBase!.tierPrices[0].areaTierId = 'base-0'
    expect(() => validateAreaPricing(document)).not.toThrow()
    const invalid = structuredClone(document)
    delete invalid.templates[0].standeeBase
    expect(() => validateAreaPricing(invalid)).toThrow()
  })
})

describe('complete additional price plans', () => {
  function batchFixture() {
    const state = fixture()
    const document = upgradeAreaPricing(state.document, state.bundle)
    for (const productId of ['P31', 'P32']) {
      const product = allProducts(state.bundle.main).find(row => row.productId === productId)!
      product.productOptions.forEach(option => { option.deleted = true })
      for (const name of ['Technique', 'Holo Film']) Object.assign(optionFor(product, name)!, { deleted: false, disabledValues: [] })
    }
    state.input.selections = { Technique: 'G11', 'Holo Film': 'M2' }
    const plan = createAdditionalPricePlan(state.bundle, document.templates[0], '整套普通价格')
    const technique = plan.prices.find(row => row.reference.techniqueId === 'G11')!
    const film = plan.prices.find(row => row.reference.holoFilmId === 'M2')!
    state.charge(technique, '0.5', '0.001')
    state.charge(film, '1', '0.001')
    document.additionalPricePlans.push(plan)
    document.categoryAdditionalPlanBindings.push({ categoryId: 'keychains', additionalPricePlanId: plan.additionalPricePlanId })
    const quote = (productId = state.input.productId) => quoteAreaProduct(document, state.bundle, noDiscount, { ...state.input, productId })
    return { ...state, document, plan, technique, film, quote }
  }

  test('one new plan contains every billable public attribute with blank independent prices and no bindings', () => {
    const bundle = clone(initialBundle)
    const original = structuredClone(bundle)
    const document = createAreaPricing(bundle)
    const plan = createAdditionalPricePlan(bundle, document.templates[0])
    expect(document.schemaVersion).toBe(7)
    expect(document).not.toHaveProperty('attributes')
    expect(document).not.toHaveProperty('categoryAttributeBindings')
    expect(document.additionalPricePlans).toEqual([])
    expect(document.categoryAdditionalPlanBindings).toEqual([])
    expect(document.productAdditionalPlanOverrides).toEqual([])
    expect(plan.prices.some(row => row.optionName === 'Technique')).toBe(true)
    expect(plan.prices.some(row => row.optionName === 'Holo Film')).toBe(true)
    expect(plan.prices.some(row => ['Print Option', 'Accessories Style'].includes(row.optionName))).toBe(false)
    expect(plan.prices.every(row => row.basePrice === null && row.tierPrices.every(tier => tier.price === null) && !Object.hasOwn(row, 'name'))).toBe(true)
    document.additionalPricePlans.push(plan)
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
    expect(bundle).toEqual(original)
  })

  test('the explicit default adds each selected price once and preserves the former aggregate formula result', () => {
    const { bundle, product, document, input } = batchFixture()
    Object.assign(optionFor(product, 'Accessories Style')!, { deleted: false, disabledValues: [] })
    const accessoryStyleId = getEntityId(catalogFor(bundle, product, 'Accessories Style').values[0])
    input.selections['Accessories Style'] = accessoryStyleId
    document.accessoryPrices.find(row => row.accessoryStyleId === accessoryStyleId && row.accessoryColorId === null)!.unitPrice = '0.3'
    input.quantity = 3
    const quantityPricing: QuantityPricingDocument = { schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers: [{ quantityTierId: 'test-discount', minQty: 1, maxQty: null, discountPercent: 20 }] }] }
    const explicit = quoteAreaProduct(document, bundle, quantityPricing, input)
    expect(explicit).toMatchObject({
      formula: '(大类主体价 + 工艺价 + 全息膜价 + 配件价) * 折扣系数 * 数量',
      unitPrice: '5.2', totalPrice: '12.48',
      variables: { 大类主体价: '3', 工艺价: '0.7', 全息膜价: '1.2', 属性价: '1.9', 配件价: '0.3', 折扣系数: '0.8', 数量: '3' },
    })
    document.productTotalFormulas.push({ productId: product.productId, formula: '(大类主体价 + 属性价 + 配件价) * 折扣系数 * 数量' })
    const aggregate = quoteAreaProduct(document, bundle, quantityPricing, input)
    expect(aggregate.totalPrice).toBe(explicit.totalPrice)
    expect(aggregate.unitPrice).toBe(explicit.unitPrice)
    expect(aggregate.steps).toEqual(explicit.steps)
  })

  test('additional plan eligibility uses one exact template ID for the entire nonempty set', () => {
    const { document, plan } = batchFixture()
    const template = document.templates[0]
    expect(additionalPlanMatchesTemplate(plan, template.areaTemplateId)).toBe(true)
    plan.name = '名称与模板完全不同的方案'
    template.name = '重命名后的模板'
    expect(additionalPlanMatchesTemplate(plan, template.areaTemplateId)).toBe(true)
    expect(additionalPlanMatchesTemplate(plan, 'different-template-with-the-same-name')).toBe(false)
    expect(additionalPlanMatchesTemplate(plan, null)).toBe(false)
    expect(additionalPlanMatchesTemplate(plan, undefined)).toBe(false)
    expect(additionalPlanMatchesTemplate(undefined, template.areaTemplateId)).toBe(false)
    expect(additionalPlanMatchesTemplate({ ...plan, prices: [] }, template.areaTemplateId)).toBe(false)
    plan.prices.at(-1)!.areaTemplateId = 'other-template'
    expect(additionalPlanMatchesTemplate(plan, template.areaTemplateId)).toBe(false)
    expect(additionalPlanMatchesTemplate(plan, 'other-template')).toBe(false)
  })

  test('a child with another body template cannot inherit an incompatible category plan or fall back past its explicit override', () => {
    const { bundle, document, plan, film, charge, quote } = batchFixture()
    const originalTemplate = document.templates[0]
    const otherTemplate = createPricedAreaTemplate({ areaTemplateId: 'other-body-template', name: originalTemplate.name, unit: 'mm', tiers: [{ areaTierId: 'other-body-tier', maxArea: null }] })
    charge(otherTemplate)
    document.templates.push(otherTemplate)
    document.productOverrides.push({ productId: 'P32', areaTemplateId: otherTemplate.areaTemplateId })
    expect(resolveProductAdditionalPlan(document, bundle, 'P31')).toMatchObject({ plan, source: 'category' })
    expect(resolveProductAdditionalPlan(document, bundle, 'P32')).toEqual({ plan: undefined, source: 'category' })
    expect(resolveProductAttributePlan(document, bundle, 'P32', film.optionName, film.reference)).toEqual({ plan: undefined, price: undefined, template: undefined, source: 'category' })
    expect(() => quote('P32')).toThrow(`附加价格方案“${plan.name}”与当前档位模板不匹配`)
    expect(quote('P31').totalPrice).toBe('4.90')
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()

    const matchingPlan = createAdditionalPricePlan(bundle, otherTemplate, '另一模板对应方案')
    for (const price of matchingPlan.prices) charge(price, '0', '0')
    document.additionalPricePlans.push(matchingPlan)
    document.productAdditionalPlanOverrides.push({ productId: 'P32', additionalPricePlanId: matchingPlan.additionalPricePlanId })
    expect(quote('P32').totalPrice).toBe('3.00')
    document.productOverrides = []
    expect(resolveProductAdditionalPlan(document, bundle, 'P32')).toEqual({ plan: undefined, source: 'product' })
    expect(() => quote('P32')).toThrow(`附加价格方案“${matchingPlan.name}”与当前档位模板不匹配`)
    document.productAdditionalPlanOverrides = []
    expect(quote('P32').totalPrice).toBe('4.90')
  })

  test('editing an unselected attribute to another template blocks the whole mixed plan without deleting its prices', () => {
    const { bundle, document, plan, film, quote } = batchFixture()
    const otherTemplate = createPricedAreaTemplate({ areaTemplateId: 'mixed-plan-template', name: '另一档位模板', unit: 'mm', tiers: [{ areaTierId: 'mixed-plan-tier', maxArea: null }] })
    document.templates.push(otherTemplate)
    const unusedPrice = plan.prices.find(row => row.reference.techniqueId === 'G12')!
    unusedPrice.areaTemplateId = otherTemplate.areaTemplateId
    unusedPrice.tierPrices = [{ areaTierId: otherTemplate.tiers[0].areaTierId, price: null }]
    const before = structuredClone(document)
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
    expect(resolveProductAttributePlan(document, bundle, 'P31', film.optionName, film.reference).price).toBeUndefined()
    expect(() => quote()).toThrow(`附加价格方案“${plan.name}”与当前档位模板不匹配`)
    expect(document).toEqual(before)
  })

  test('choosing one product override switches all selected attributes together and preserves other products', () => {
    const { bundle, document, input, plan, charge, quote } = batchFixture()
    const special = structuredClone(plan)
    special.additionalPricePlanId = 'special-batch'
    special.name = '整套特殊价格'
    charge(special.prices.find(row => row.reference.techniqueId === 'G11')!, '2', '0.001')
    charge(special.prices.find(row => row.reference.holoFilmId === 'M2')!, '3', '0.001')
    document.additionalPricePlans.push(special)
    document.productAdditionalPlanOverrides.push({ productId: 'P32', additionalPricePlanId: special.additionalPricePlanId })
    expect(quote('P31')).toMatchObject({ totalPrice: '4.90', variables: { 工艺价: '0.7', 全息膜价: '1.2', 属性价: '1.9' } })
    expect(quote('P32')).toMatchObject({ totalPrice: '8.40', variables: { 工艺价: '2.2', 全息膜价: '3.2', 属性价: '5.4' } })
    expect(quote('P32').steps.slice(1).every(step => step.planName === special.name && step.key.startsWith('special-batch:'))).toBe(true)
    expect(resolveProductAdditionalPlan(document, bundle, 'P31')).toMatchObject({ plan, source: 'category' })
    expect(resolveProductAdditionalPlan(document, bundle, 'P32')).toMatchObject({ plan: special, source: 'product' })
    charge(special.prices.find(row => row.reference.techniqueId === 'G12')!, '4', '0')
    input.selections.Technique = 'G12'
    expect(quote('P32').totalPrice).toBe('10.20')
    expect(() => quote('P31')).toThrow('未定价')
    input.selections.Technique = 'G11'
    document.productAdditionalPlanOverrides = []
    expect(quote('P32').totalPrice).toBe('4.90')
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
  })

  test('an unpriced whole override or missing row cannot fall back to the category or another set', () => {
    const { bundle, document, plan, film, quote } = batchFixture()
    document.productAdditionalPlanOverrides.push({ productId: 'P31', additionalPricePlanId: null })
    expect(resolveProductAdditionalPlan(document, bundle, 'P31')).toEqual({ plan: undefined, source: 'product' })
    expect(() => quote()).toThrow('未定价')
    const incomplete = structuredClone(plan)
    incomplete.additionalPricePlanId = 'incomplete-batch'
    incomplete.prices = incomplete.prices.filter(row => row.areaAttributePriceId !== film.areaAttributePriceId)
    document.additionalPricePlans.push(incomplete)
    document.productAdditionalPlanOverrides[0].additionalPricePlanId = incomplete.additionalPricePlanId
    expect(resolveProductAttributePlan(document, bundle, 'P31', film.optionName, film.reference)).toMatchObject({ plan: incomplete, price: undefined, template: undefined, source: 'product' })
    expect(() => quote()).toThrow('全息膜')
    document.productAdditionalPlanOverrides = []
    film.basePrice = '0'
    film.tierPrices.forEach(row => { row.price = '0' })
    expect(quote().totalPrice).toBe('3.70')
    film.basePrice = null
    expect(() => quote()).toThrow('未定价')
  })

  test('validates plan-local identities, exact entity types, whole-plan bindings and legacy field exclusion', () => {
    const { bundle, document, plan, technique } = batchFixture()
    const duplicate = structuredClone(plan)
    duplicate.additionalPricePlanId = 'copy'
    document.additionalPricePlans.push(duplicate)
    expect(() => validateAreaReferences(document, bundle)).not.toThrow()
    duplicate.prices.push(structuredClone(technique))
    expect(() => validateAreaPricing(document)).toThrow('重复')
    duplicate.prices.at(-1)!.areaAttributePriceId = 'different-row-same-entity'
    expect(() => validateAreaPricing(document)).toThrow('属性实体不能重复')
    duplicate.prices.pop()
    duplicate.prices[0].reference = { id: 'G1' } as EntityReference
    expect(() => validateAreaPricing(document)).toThrow('所属实体')
    document.additionalPricePlans.pop()
    expect(() => validateAreaPricing({ ...document, attributes: [] })).toThrow('字段无效')
    expect(() => validateAreaPricing({ ...document, categoryAttributeBindings: [] })).toThrow('字段无效')
    expect(() => validateAreaPricing({ ...document, additionalPricePlans: [{ ...plan, prices: [{ ...technique, name: '不能单独命名方案' }] }] })).toThrow('字段无效')
    document.categoryAdditionalPlanBindings.push({ ...document.categoryAdditionalPlanBindings[0] })
    expect(() => validateAreaPricing(document)).toThrow('重复')
    document.categoryAdditionalPlanBindings.pop()
    document.categoryAdditionalPlanBindings[0].additionalPricePlanId = 'missing'
    expect(() => validateAreaPricing(document)).toThrow('方案已不存在')
    document.categoryAdditionalPlanBindings[0].additionalPricePlanId = plan.additionalPricePlanId
    document.productAdditionalPlanOverrides.push({ productId: 'missing', additionalPricePlanId: null })
    expect(() => validateAreaReferences(document, bundle)).toThrow('产品 missing 已不存在')
    document.productAdditionalPlanOverrides[0].productId = bundle.main.uncategorizedProducts[0].productId
    expect(() => validateAreaReferences(document, bundle)).toThrow('尚未归属产品大类')
  })

  test('schema5 migration overlays product selections over the full category set and preserves null exclusions and unused rows', () => {
    const { bundle, document, charge, input } = fixture()
    for (const productId of ['P31', 'P32', 'P33']) {
      const product = allProducts(bundle.main).find(row => row.productId === productId)!
      product.productOptions.forEach(option => { option.deleted = true })
      for (const name of ['Technique', 'Holo Film']) Object.assign(optionFor(product, name)!, { deleted: false, disabledValues: [] })
    }
    input.selections = { Technique: 'G11', 'Holo Film': 'M2' }
    const normal = addPlan(document, 'normal')
    const special = addPlan(document, 'special')
    const film = addPlan(document, 'film', { holoFilmId: 'M2' }, 'Holo Film')
    const unused = addPlan(document, 'unused')
    charge(normal.plan, '0.50', '0.001')
    charge(special.plan, '2', '0.001')
    charge(film.plan, '1', '0.001')
    film.template.matchBy = 'longest-side'
    film.template.unit = 'mm'
    film.template.formula = '基本价 + 档位价格'
    charge(unused.plan, '0.123456789012345678', '0')
    const binding = (price: typeof normal.plan) => ({ optionName: price.optionName, reference: price.reference, areaAttributePriceId: price.areaAttributePriceId })
    for (const categoryId of ['keychains', 'stickers']) for (const price of [normal.plan, film.plan]) document.categoryAttributeBindings.push({ categoryId, ...binding(price) })
    document.productAttributeOverrides.push({ productId: 'P32', ...binding(special.plan) }, { productId: 'P33', ...binding(film.plan), areaAttributePriceId: null })
    document.productTotalFormulas.push({ productId: 'P32', formula: '(大类主体价 + 工艺价 + 全息膜价) * 数量 + 1' })
    const before = structuredClone(document)
    const next = upgradeAreaPricing(document, bundle)
    expect(next.schemaVersion).toBe(7)
    expect(next.categoryAdditionalPlanBindings[0].additionalPricePlanId).toBe(next.categoryAdditionalPlanBindings[1].additionalPricePlanId)
    const storedPlan = (productId: string) => {
      const binding = next.productAdditionalPlanOverrides.find(row => row.productId === productId)
        ?? next.categoryAdditionalPlanBindings.find(row => row.categoryId === getProductPricingCategory(bundle, productId)?.categoryId)
      return next.additionalPricePlans.find(row => row.additionalPricePlanId === binding?.additionalPricePlanId)!
    }
    const normalSet = storedPlan('P31')
    const specialSet = storedPlan('P32')
    const nullSet = storedPlan('P33')
    expect(normalSet.prices.map(row => row.areaAttributePriceId)).toEqual(['normal', 'film'])
    expect(specialSet.prices.map(row => row.areaAttributePriceId)).toEqual(['special', 'film'])
    expect(nullSet.prices.map(row => row.areaAttributePriceId)).toEqual(['normal'])
    expect(specialSet.prices.find(row => row.reference.holoFilmId === 'M2')!.areaTemplateId).toBe(film.template.areaTemplateId)
    expect(next.additionalPricePlans.some(plan => plan.prices.some(row => row.areaAttributePriceId === 'unused' && row.basePrice === '0.123456789012345678'))).toBe(true)
    expect(next.templates).toEqual(before.templates)
    expect(next.productTotalFormulas).toEqual(before.productTotalFormulas)
    expect(next.accessoryPrices).toEqual(before.accessoryPrices)
    expect(quoteAreaProduct(document, bundle, noDiscount, input).totalPrice).toBe('4.70')
    expect(quoteAreaProduct(document, bundle, noDiscount, { ...input, productId: 'P32' }).totalPrice).toBe('7.20')
    expect(() => quoteAreaProduct(document, bundle, noDiscount, { ...input, productId: 'P33' })).toThrow('全息膜')
    for (const productId of ['P31', 'P32', 'P33']) {
      expect(resolveProductAdditionalPlan(next, bundle, productId).plan).toBeUndefined()
      expect(() => quoteAreaProduct(next, bundle, noDiscount, { ...input, productId })).toThrow('与当前档位模板不匹配')
    }
    specialSet.prices.find(row => row.areaAttributePriceId === 'film')!.basePrice = '9'
    expect(normalSet.prices.find(row => row.areaAttributePriceId === 'film')!.basePrice).toBe('1')
    expect(document).toEqual(before)
    expect(upgradeAreaPricing(document, bundle)).toEqual(upgradeAreaPricing(before, bundle))
    expect(upgradeAreaPricing(next, bundle)).toEqual(next)
    expect(() => validateAreaReferences(next, bundle)).not.toThrow()
  })

  test('schema6 reloads preserve blank sets and never auto-enroll new catalogs or categories', () => {
    const { bundle, document, plan } = batchFixture()
    const before = structuredClone(plan)
    bundle.catalogs['techniques.json'].values.push({ techniqueId: 'NEW', name: '新工艺' })
    bundle.main.categories.push({ ...structuredClone(bundle.main.categories[0]), name: 'new-category', products: [] })
    const upgraded = upgradeAreaPricing(document, bundle)
    expect(upgraded.additionalPricePlans[0]).toEqual(before)
    expect(upgraded.categoryAdditionalPlanBindings).toEqual(document.categoryAdditionalPlanBindings)
    expect(upgraded.productAdditionalPlanOverrides).toEqual([])
    expect(upgraded.categories.at(-1)).toEqual({ categoryId: 'new-category', areaTemplateId: null })
    expect(getAdditionalAttributePrices(upgraded).some(row => row.reference.techniqueId === 'NEW')).toBe(false)
    expect(() => validateAreaReferences(upgraded, bundle)).not.toThrow()
  })
})

describe('v7 matching and independent price rows', () => {
  function exactFixture() {
    const state = fixture()
    const document = upgradeAreaPricing(state.document, state.bundle)
    const template = document.templates[0]
    template.exactSizes = [{ areaTierId: 'exact-three', width: '3', height: '3', unit: 'in', allowRotation: true }]
    template.tierPrices.push({ areaTierId: 'exact-three', price: '7', calculation: { kind: 'fixed' } })
    const input = { ...state.input, width: '3', height: '3', unit: 'in' as const }
    return { ...state, document, template, input, quote: () => quoteAreaProduct(document, state.bundle, noDiscount, input) }
  }

  test('v6 structure upgrade changes only version and initializes disabled adjustments', () => {
    const { document, bundle } = standeeFixture()
    const { productAdjustments: _adjustments, ...shared } = document
    const original = { ...shared, schemaVersion: 6 as const }
    const next = upgradeAreaPricing(original, bundle)
    expect(next).toEqual({ ...original, schemaVersion: 7, productAdjustments: [] })
    expect(upgradeAreaPricing(JSON.parse(JSON.stringify(next)), bundle)).toEqual(next)
  })

  test('exact dimensions override area ranges across equivalent units without confusing equal areas', () => {
    const state = exactFixture()
    expect(state.quote().unitPrice).toBe('7')
    Object.assign(state.input, { width: '76.2', height: '76.2', unit: 'mm' })
    expect(state.quote().unitPrice).toBe('7')
    expect(state.quote().steps[0].matchBy).toBe('exact-size')
    Object.assign(state.input, { width: '1', height: '9', unit: 'in' })
    expect(state.quote().unitPrice).toBe('31.0322')
  })

  test('exact matching never silently falls back when the selected price is blank', () => {
    const state = exactFixture()
    state.template.tierPrices.find(row => row.areaTierId === 'exact-three')!.price = null
    expect(state.quote).toThrow(/未定价|未填写/)
  })

  test('named formulas require only their actual parameters but a blank fixed exact price stays unpriced', () => {
    const state = exactFixture()
    state.template.formulas = [{ formulaId: 'base-only', name: '只收基础费', formula: '基本价' }]
    const row = state.template.tierPrices.find(price => price.areaTierId === 'exact-three')!
    row.price = null
    row.calculation = { kind: 'formula', basePrice: '1.25', formulaId: 'base-only' }
    expect(state.quote().unitPrice).toBe('1.25')
    state.template.formulas[0].formula = '3'
    row.calculation.basePrice = null
    expect(state.quote().unitPrice).toBe('3')
    row.calculation = { kind: 'fixed' }
    expect(state.quote).toThrow(/未定价|未填写/)
  })

  test('a custom total formula cannot hide a negative sum of selected body and attribute prices', () => {
    const state = exactFixture()
    state.template.tierPrices.find(row => row.areaTierId === 'exact-three')!.price = '1'
    Object.assign(optionFor(state.product, 'Technique')!, { deleted: false, disabledValues: [] })
    state.input.selections.Technique = 'G11'
    const plan = createAdditionalPricePlan(state.bundle, state.template, '负数差价')
    state.document.additionalPricePlans.push(plan)
    state.document.productAdditionalPlanOverrides.push({ productId: state.product.productId, additionalPricePlanId: plan.additionalPricePlanId })
    const attribute = plan.prices.find(row => row.reference.techniqueId === 'G11')!
    const price = attribute.tierPrices.find(row => row.areaTierId === 'exact-three')!
    price.price = '-2'
    price.calculation = { kind: 'fixed' }
    state.document.productTotalFormulas = [{ productId: state.product.productId, formula: '大类主体价 * 数量' }]
    expect(state.quote).toThrow('合计单价不能为负数')
    price.price = '-1'
    expect(state.quote().unitPrice).toBe('0')
    expect(state.quote().totalPrice).toBe('1.00')
  })

  test('pure exact size supports no fallback and rotation is explicit', () => {
    const state = exactFixture()
    state.template.matchBy = 'exact-size'
    state.template.tiers = []
    state.template.exactSizes![0].width = '2'
    state.template.tierPrices = state.template.tierPrices.filter(row => row.areaTierId === 'exact-three')
    Object.assign(state.input, { width: '3', height: '2' })
    validateAreaPricing(state.document)
    expect(state.quote().unitPrice).toBe('7')
    state.template.exactSizes![0].allowRotation = false
    expect(state.quote).toThrow(/未匹配|未命中|未配置|没有匹配|匹配.*不到/)
    Object.assign(state.input, { width: '2', height: '3' })
    expect(state.quote().unitPrice).toBe('7')
  })

  test('physically duplicate or rotated exact conditions cannot save', () => {
    const state = exactFixture()
    state.template.exactSizes!.push({ areaTierId: 'duplicate', width: '76.2', height: '76.2', unit: 'mm', allowRotation: false })
    state.template.tierPrices.push({ areaTierId: 'duplicate', price: '1' })
    expect(() => validateAreaPricing(state.document)).toThrow(/重复|冲突/)
    Object.assign(state.template.exactSizes![0], { width: '2', height: '3' })
    Object.assign(state.template.exactSizes![1], { width: '76.2', height: '50.8' })
    expect(() => validateAreaPricing(state.document)).toThrow(/重复|冲突/)
    state.template.exactSizes![0].allowRotation = false
    expect(() => validateAreaPricing(state.document)).not.toThrow()
  })

  test('one template mixes inherited, fixed, area and named formula prices', () => {
    const state = exactFixture()
    state.template.formulas = [{ formulaId: 'double', name: '双倍档费', formula: '档位价格 * 2' }]
    const exact = state.template.tierPrices.find(row => row.areaTierId === 'exact-three')!
    exact.price = '0.1'
    exact.calculation = { kind: 'area', basePrice: '-0.2', areaUnit: 'in' }
    expect(state.quote().unitPrice).toBe('0.7')
    exact.price = '2'
    exact.calculation = { kind: 'formula', basePrice: null, formulaId: 'double' }
    expect(state.quote().unitPrice).toBe('4')
    exact.calculation = { kind: 'fixed' }
    expect(state.quote().unitPrice).toBe('2')
    delete exact.calculation
    expect(state.quote().unitPrice).toBe('11614.88')
  })

  test('referenced algorithms cannot be removed while still used', () => {
    const state = exactFixture()
    state.template.tierPrices.at(-1)!.calculation = { kind: 'formula', basePrice: null, formulaId: 'missing' }
    expect(() => validateAreaPricing(state.document)).toThrow(/公式|算法/)
  })

  test('area coefficients support cm² and mm² without changing physical amounts', () => {
    const state = exactFixture()
    const row = state.template.tierPrices.at(-1)!
    row.price = '0.1'
    row.calculation = { kind: 'area', basePrice: '0.5', areaUnit: 'cm' }
    const expected = state.quote().unitPrice
    row.price = '0.001'
    row.calculation.areaUnit = 'mm'
    expect(state.quote().unitPrice).toBe(expected)
    row.price = '0.64516'
    row.calculation.areaUnit = 'in'
    expect(state.quote().unitPrice).toBe(expected)
  })

  test('standee adjustment and each base count once for multiple differently sized pieces', () => {
    const state = standeeFixture()
    state.document.productAdjustments.push({ productId: 'P24', amount: '-0.27' })
    // Pieces: 2.5 + 3.5; base: 1.3; per-item adjustment: -0.27.
    expect(state.quote().unitPrice).toBe('7.03')
    const parts = state.quote().steps[0].parts!
    expect(parts.filter(row => row.calculationKind === 'adjustment')).toHaveLength(1)
    expect(parts.at(-1)?.amount).toBe('-0.27')
    state.input.quantity = 5
    expect(state.quote().totalPrice).toBe('35.15')
  })

  test('enabled but blank adjustment is unpriced and adjusted negative body is rejected', () => {
    const state = standeeFixture()
    const adjustment = { productId: 'P24', amount: null as string | null }
    state.document.productAdjustments.push(adjustment)
    expect(state.quote).toThrow(/未定价|未填写/)
    adjustment.amount = '-100'
    expect(state.quote).toThrow(/负数|不能.*负/)
  })

  test('attribute can use signed area calculation while body in that same range is fixed', () => {
    const state = standeeFixture()
    const option = optionFor(state.product, 'Technique')!
    Object.assign(option, { deleted: false, disabledValues: [] })
    state.input.selections.Technique = 'G11'
    const plan = createAdditionalPricePlan(state.bundle, state.template, '独立算法')
    state.document.additionalPricePlans.push(plan)
    state.document.productAdditionalPlanOverrides.push({ productId: 'P24', additionalPricePlanId: plan.additionalPricePlanId })
    const price = plan.prices.find(row => row.reference.techniqueId === 'G11')!
    price.basePrice = null
    for (const row of price.tierPrices) { row.price = '0.001'; row.calculation = { kind: 'area', basePrice: '-0.5', areaUnit: 'mm' } }
    for (const row of price.standeeBase!.tierPrices) { row.price = '-0.2'; row.calculation = { kind: 'fixed' } }
    // Body 7.3, attribute (1.2-.5)+(2.1-.5)-.2 = 2.1.
    expect(state.quote().unitPrice).toBe('9.4')
    expect(state.quote().steps.find(row => row.optionName === 'Technique')!.parts!.at(-1)!.amount).toBe('-0.2')
    state.document.productTotalFormulas = [{ productId: 'P24', formula: '大类主体价 * 数量' }]
    expect(state.quote().totalPrice).toBe('7.30')
    price.tierPrices[0].price = null
    expect(state.quote).toThrow(/未定价|未填写/)
  })
})
