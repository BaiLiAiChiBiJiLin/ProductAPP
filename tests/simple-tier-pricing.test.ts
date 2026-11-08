import { expect, test } from 'vitest'
import {
  getAttributePlanCharge, getTemplatePriceCharge, previewAreaCharge, validateAreaPricing,
  type AreaPricingDocument, type PricedAreaTemplate,
} from '../src/modules/settings/product-pricing/areaPricing'
import { simplifyTierPricing } from '../src/modules/settings/product-pricing/simpleTierPricing'

function template(): PricedAreaTemplate {
  return {
    areaTemplateId: 'template', name: '测试档位', unit: 'mm', matchBy: 'longest-side',
    tiers: [{ areaTierId: 'tier', maxArea: null }], basePrice: '0',
    formula: '基本价 + 档位价格', tierPrices: [{ areaTierId: 'tier', price: '2.41' }],
  }
}
function document(value = template()): AreaPricingDocument {
  return {
    schemaVersion: 7, accessoryPricing: 'style', accessoryPrices: [], templates: [value],
    categories: [{ categoryId: 'standees', areaTemplateId: value.areaTemplateId }],
    productOverrides: [{ productId: 'P24', areaTemplateId: value.areaTemplateId }],
    productTotalFormulas: [{ productId: 'P24', formula: '大类主体价 * 数量' }],
    additionalPricePlans: [], categoryAdditionalPlanBindings: [], productAdditionalPlanOverrides: [],
    productAdjustments: [{ productId: 'P24', amount: '-0.27' }],
  }
}
const dimensions = { width: '50', height: '50', unit: 'mm' as const }
const preview = (value: PricedAreaTemplate) => previewAreaCharge(getTemplatePriceCharge(value), value, dimensions, '主体', 'body')

test('ordinary area pricing, identifiers, bindings, and user formulas remain unchanged without mutating the input', () => {
  const body = template()
  Object.assign(body, { matchBy: 'area', unit: 'cm', basePrice: '0.5', formula: '基本价 + 档位价格 * (面积平方毫米 / 100)' })
  body.tierPrices[0].price = '0.13'
  const input = document(body)
  input.accessoryPrices = [{ accessoryPriceId: 'shared-price', accessoryStyleId: 'A1', accessoryColorId: null, unitPrice: '0.3' }]
  const original = structuredClone(input)
  const before = preview(input.templates[0])
  const simplified = simplifyTierPricing(input)
  expect(simplified.document).toEqual(original)
  expect(input).toEqual(original)
  expect(simplified.document).not.toBe(input)
  expect(preview(simplified.document.templates[0]).amount).toBe(before.amount)
  expect(before.amount).toBe('3.75')
  expect(simplified.clearedPrices).toEqual([])
  expect(simplified.convertedFixedPrices).toEqual([])
})

test('variable area and custom formula rows become unpriced instead of treating their coefficients as fixed amounts', () => {
  const body = template()
  body.formulas = [{ formulaId: 'custom', name: '复杂算法', formula: '基本价 + 档位价格 * 面积平方毫米' }]
  body.tiers = [{ areaTierId: 'small', maxArea: '100' }, { areaTierId: 'large', maxArea: null }]
  body.tierPrices = [
    { areaTierId: 'small', price: '0.000279155', calculation: { kind: 'area', basePrice: '0.4638', areaUnit: 'mm' } },
    { areaTierId: 'large', price: '0.0005', calculation: { kind: 'formula', basePrice: '1', formulaId: 'custom' } },
  ]
  const input = document(body)
  const original = structuredClone(input)
  const result = simplifyTierPricing(input)
  expect(result.document.templates[0].tierPrices).toEqual([{ areaTierId: 'small', price: null }, { areaTierId: 'large', price: null }])
  expect(result.document.templates[0].formulas).toBeUndefined()
  expect(result.document.templates[0].formula).toBe(body.formula)
  expect(result.clearedPrices).toEqual([
    { areaTemplateId: 'template', component: 'body', areaTierId: 'small', previousPrice: '0.000279155', previousCalculation: body.tierPrices[0].calculation },
    { areaTemplateId: 'template', component: 'body', areaTierId: 'large', previousPrice: '0.0005', previousCalculation: body.tierPrices[1].calculation },
  ])
  expect(() => preview(result.document.templates[0])).toThrow(/未定价/)
  expect(input).toEqual(original)
  validateAreaPricing(result.document)
  const twice = simplifyTierPricing(result.document)
  expect(twice.document).toEqual(result.document)
  expect(twice.clearedPrices).toEqual([])
  expect(twice.convertedFixedPrices).toEqual([])
})

test('signed fixed attribute deltas use their own zero base fee when converting to the shared template formula', () => {
  const body = template()
  body.basePrice = '5'
  body.formula = ' 基本价 + 档位价格 '
  body.standeeBase = {
    unit: 'mm', matchBy: 'longest-side', basePrice: '4', formula: '基本价 + 档位价格',
    tiers: [{ areaTierId: 'base-tier', maxArea: null }], tierPrices: [{ areaTierId: 'base-tier', price: '1' }],
  }
  const input = document(body)
  input.additionalPricePlans = [{ additionalPricePlanId: 'plan', name: '附加方案', prices: [{
    areaAttributePriceId: 'attribute', optionName: 'Technique', reference: { techniqueId: 'G11' }, areaTemplateId: 'template', basePrice: '0.00',
    tierPrices: [{ areaTierId: 'tier', price: '-0.42', calculation: { kind: 'fixed' } }],
    standeeBase: { basePrice: '0', tierPrices: [{ areaTierId: 'base-tier', price: '-0.41', calculation: { kind: 'fixed' } }] },
  }] }]
  input.categoryAdditionalPlanBindings = [{ categoryId: 'standees', additionalPricePlanId: 'plan' }]
  input.productAdditionalPlanOverrides = [{ productId: 'P24', additionalPricePlanId: 'plan' }]
  const before = previewAreaCharge(getAttributePlanCharge(input.additionalPricePlans[0].prices[0], body), body, dimensions, '工艺', 'technique', { allowNegative: true })
  const result = simplifyTierPricing(input)
  const attribute = result.document.additionalPricePlans[0].prices[0]
  expect(attribute.tierPrices).toEqual([{ areaTierId: 'tier', price: '-0.42' }])
  expect(attribute.standeeBase?.tierPrices).toEqual([{ areaTierId: 'base-tier', price: '-0.41' }])
  expect(result.clearedPrices).toEqual([])
  expect(result.convertedFixedPrices.map(row => [row.component, row.areaTierId])).toEqual([['body', 'tier'], ['base', 'base-tier']])
  const after = previewAreaCharge(getAttributePlanCharge(attribute, result.document.templates[0]), result.document.templates[0], dimensions, '工艺', 'technique', { allowNegative: true })
  expect(after.amount).toBe(before.amount)
  expect(after.amount).toBe('-0.42')
  expect(result.document.categoryAdditionalPlanBindings).toEqual(input.categoryAdditionalPlanBindings)
  expect(result.document.productAdditionalPlanOverrides).toEqual(input.productAdditionalPlanOverrides)
  validateAreaPricing(result.document)
})

test('fixed intervals that cannot follow the template formula exactly are cleared, including a tiny nonzero base fee', () => {
  for (const [formula, basePrice] of [
    ['基本价 + 档位价格', '0.000000000000000001'],
    ['基本价 + 档位价格 * 面积平方毫米', '0'],
  ]) {
    const body = template()
    Object.assign(body, { formula, basePrice })
    body.tierPrices[0].calculation = { kind: 'fixed' }
    const result = simplifyTierPricing(document(body))
    expect(result.document.templates[0].tierPrices).toEqual([{ areaTierId: 'tier', price: null }])
    expect(result.clearedPrices).toHaveLength(1)
  }
  const body = template()
  body.formula = '档位价格'
  body.basePrice = '10'
  body.tierPrices[0].calculation = { kind: 'fixed' }
  const result = simplifyTierPricing(document(body))
  expect(preview(result.document.templates[0]).amount).toBe('2.41')
  expect(result.clearedPrices).toEqual([])
})

test('specified dimensions stay fixed under area templates and an unpriced exact match never falls through to a range', () => {
  const body = template()
  body.matchBy = 'area'
  body.basePrice = '2'
  body.formula = '基本价 + 档位价格 * 面积平方毫米'
  body.exactSizes = [{ areaTierId: 'exact', width: '50', height: '50', unit: 'mm', allowRotation: true }]
  body.tierPrices.push({ areaTierId: 'exact', price: '4.25', calculation: { kind: 'fixed' } })
  const fixed = simplifyTierPricing(document(body))
  expect(preview(fixed.document.templates[0]).amount).toBe('4.25')
  expect(fixed.clearedPrices).toEqual([])
  delete body.tierPrices[1].calculation
  const inherited = simplifyTierPricing(document(body))
  expect(inherited.document.templates[0].tierPrices[1]).toEqual({ areaTierId: 'exact', price: null, calculation: { kind: 'fixed' } })
  expect(() => preview(inherited.document.templates[0])).toThrow(/未定价/)
  expect(inherited.document.templates[0].tierPrices[0].price).toBe('2.41')
  body.basePrice = '0'
  body.formula = '基础费 + 档位价格'
  const identity = simplifyTierPricing(document(body))
  expect(preview(identity.document.templates[0]).amount).toBe('4.25')
  expect(identity.document.templates[0].tierPrices[1].calculation).toEqual({ kind: 'fixed' })
  expect(simplifyTierPricing(identity.document).document).toEqual(identity.document)
})

test('base template and additional plan formulas are cleared with explicit owner identifiers and no hidden calculation fields', () => {
  const body = template()
  body.standeeBase = {
    unit: 'mm', matchBy: 'longest-side', basePrice: '0', formula: '基本价 + 档位价格',
    tiers: [{ areaTierId: 'base', maxArea: null }],
    formulas: [{ formulaId: 'base-algorithm', name: '底座算法', formula: '档位价格 * 面积平方毫米' }],
    tierPrices: [{ areaTierId: 'base', price: '0.001', calculation: { kind: 'area', basePrice: '0.4', areaUnit: 'mm' } }],
  }
  const input = document(body)
  input.additionalPricePlans = [{ additionalPricePlanId: 'plan', name: '附加方案', prices: [{
    areaAttributePriceId: 'film', optionName: 'Holo Film', reference: { holoFilmId: 'M3' }, areaTemplateId: 'template', basePrice: '0',
    tierPrices: [{ areaTierId: 'tier', price: '0.2' }],
    standeeBase: { basePrice: '0', tierPrices: [{ areaTierId: 'base', price: '0.0001', calculation: { kind: 'formula', basePrice: '0', formulaId: 'base-algorithm' } }] },
  }] }]
  const result = simplifyTierPricing(input)
  expect(result.clearedPrices).toHaveLength(2)
  expect(result.clearedPrices[1]).toMatchObject({ areaTemplateId: 'template', additionalPricePlanId: 'plan', areaAttributePriceId: 'film', component: 'base', areaTierId: 'base' })
  expect(result.document.templates[0].standeeBase?.formulas).toBeUndefined()
  expect(JSON.stringify(result.document)).not.toContain('calculation')
  expect(JSON.stringify(result.document)).not.toContain('base-algorithm')
  validateAreaPricing(result.document)
})
