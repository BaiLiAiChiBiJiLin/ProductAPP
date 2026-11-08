import { areaTierLabel, getTemplateMatchBy, getTemplatePriceRules, templateUnitLabel, type AreaAttributePrice, type PricedAreaTemplate } from './areaPricing'

export default function AreaTemplatePriceSummary({ template, prices }: { template?: PricedAreaTemplate; prices: Pick<AreaAttributePrice, 'basePrice' | 'tierPrices'> }) {
  if (!template) return <span className="pp-muted">未选择模板</span>
  const exact = getTemplateMatchBy(template) === 'exact-size'
  return <div className="area-plan-price-summary">
    <small>{exact ? '固定尺寸价格' : `${getTemplateMatchBy(template) === 'longest-side' ? '最长边' : '面积'} · ${templateUnitLabel(template)}`}</small>
    {!exact && <span>基价：{prices.basePrice === null ? '未定价' : `$${prices.basePrice}`}</span>}
    {getTemplatePriceRules(template).map(tier => {
      const row = prices.tierPrices.find(row => row.areaTierId === tier.areaTierId)
      const method = row?.calculation
      const price = row?.price
      return <small key={tier.areaTierId}>{areaTierLabel(template, tier)}：{method?.kind === 'area' ? `${method.basePrice ?? '未定价'}＋${price ?? '未定价'}×面积（${method.areaUnit}²）` : method?.kind === 'formula' ? `${template.formulas?.find(formula => formula.formulaId === method.formulaId)?.name ?? '算法缺失'}（${method.basePrice ?? '—'}，${price ?? '—'}）` : price == null ? '未定价' : `$${price}${method?.kind === 'fixed' ? ' 固定' : ''}`}</small>
    })}
  </div>
}
