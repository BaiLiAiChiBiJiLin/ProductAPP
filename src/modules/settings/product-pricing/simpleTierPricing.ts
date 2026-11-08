import type { AreaPricingDocument, AreaTemplate, StandeeBasePrices, TierCalculation } from './areaPricing'

type PriceOwner = {
  areaTemplateId: string
  additionalPricePlanId?: string
  areaAttributePriceId?: string
  component: 'body' | 'base'
}

export type SimplifiedTierPriceChange = PriceOwner & {
  areaTierId: string
  previousPrice: string | null
  previousCalculation?: TierCalculation
}

export type SimplifiedTierPricing = {
  document: AreaPricingDocument
  clearedPrices: SimplifiedTierPriceChange[]
  convertedFixedPrices: SimplifiedTierPriceChange[]
}

function usesPriceDirectly(formula: string, basePrice: string | null): boolean {
  const normalized = formula.replace(/\s/g, '').replaceAll('基础费', '基本价')
  if (normalized === '档位价格') return true
  return normalized === '基本价+档位价格' && basePrice !== null && /^-?0(?:\.0+)?$/.test(basePrice.trim())
}

/** Editable intervals use one template formula; specified dimensions always store a fixed amount. */
export function simplifyTierPricing(source: AreaPricingDocument): SimplifiedTierPricing {
  const document = structuredClone(source)
  const clearedPrices: SimplifiedTierPriceChange[] = []
  const convertedFixedPrices: SimplifiedTierPriceChange[] = []
  const simplifyGroup = (
    charge: StandeeBasePrices,
    template: Pick<AreaTemplate, 'exactSizes'> & { formula: string },
    owner: PriceOwner,
  ) => {
    const exactIds = new Set(template.exactSizes?.map(rule => rule.areaTierId))
    const identity = usesPriceDirectly(template.formula, charge.basePrice)
    for (const row of charge.tierPrices) {
      const exact = exactIds.has(row.areaTierId)
      const kind = row.calculation?.kind
      const change = (): SimplifiedTierPriceChange => ({
        ...owner, areaTierId: row.areaTierId, previousPrice: row.price,
        ...(row.calculation ? { previousCalculation: structuredClone(row.calculation) } : {}),
      })
      const clear = kind === 'area' || kind === 'formula'
        || (exact ? kind !== 'fixed' && !identity : kind === 'fixed' && !identity)
      if (clear) {
        clearedPrices.push(change())
        row.price = null
      } else if (exact ? kind !== 'fixed' : kind === 'fixed') convertedFixedPrices.push(change())
      if (exact) row.calculation = { kind: 'fixed' }
      else delete row.calculation
    }
  }

  const templates = new Map(document.templates.map(template => [template.areaTemplateId, template]))
  for (const template of document.templates) {
    simplifyGroup(template, template, { areaTemplateId: template.areaTemplateId, component: 'body' })
    delete template.formulas
    if (template.standeeBase) {
      simplifyGroup(template.standeeBase, template.standeeBase, { areaTemplateId: template.areaTemplateId, component: 'base' })
      delete template.standeeBase.formulas
    }
  }
  for (const plan of document.additionalPricePlans) {
    for (const price of plan.prices) {
      const template = templates.get(price.areaTemplateId)
      if (!template) throw new Error(`附加价格 ${price.areaAttributePriceId} 引用的档位模板不存在`)
      const owner = { areaTemplateId: template.areaTemplateId, additionalPricePlanId: plan.additionalPricePlanId, areaAttributePriceId: price.areaAttributePriceId }
      simplifyGroup(price, template, { ...owner, component: 'body' })
      if (price.standeeBase) {
        if (!template.standeeBase) throw new Error(`附加价格 ${price.areaAttributePriceId} 引用的底座档位不存在`)
        simplifyGroup(price.standeeBase, template.standeeBase, { ...owner, component: 'base' })
      }
    }
  }
  return { document, clearedPrices, convertedFixedPrices }
}
