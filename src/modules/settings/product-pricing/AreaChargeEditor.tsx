import { Input, Select } from 'antd'
import { AREA_CHARGE_VARIABLES, DEFAULT_AREA_FORMULA, areaTierLabel as formatAreaTierLabel, getTemplatePriceRules, type AreaCharge, type AreaTemplate } from './areaPricing'
import AreaFormulaEditor from './AreaFormulaEditor'
import RulePriceEditor from './RulePriceEditor'

type Props = { title: string; charge: AreaCharge; templates: AreaTemplate[]; showFormula?: boolean; disabled?: boolean; onChange: (charge: AreaCharge) => void }

export function displayAreaBoundary(value: string): string {
  if (!value.trim()) return ''
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 6 }) : value
}

export default function AreaChargeEditor({ title, charge, templates, showFormula = true, disabled, onChange }: Props) {
  const template = templates.find(item => item.areaTemplateId === charge.areaTemplateId)
  return <section className="pp-card area-charge" aria-label={title}>
    <h4>{title}</h4>
    <div className="area-config-fields">
      <label>基价（USD）<Input aria-label={`${title}基价`} inputMode="decimal" placeholder="未定价" value={charge.basePrice ?? ''} disabled={disabled} onChange={event => onChange({ ...charge, basePrice: event.target.value.trim() ? event.target.value : null })}/></label>
      <label>产品价格模板<Select aria-label={`${title}面积模板`} value={charge.areaTemplateId} disabled={disabled} options={templates.map(item => ({ value: item.areaTemplateId, label: item.name }))} onChange={areaTemplateId => onChange({ ...charge, areaTemplateId, tierPrices: getTemplatePriceRules(templates.find(item => item.areaTemplateId === areaTemplateId)!).map(tier => structuredClone(charge.tierPrices.find(item => item.areaTierId === tier.areaTierId) ?? { areaTierId: tier.areaTierId, price: null })) })}/></label>
    </div>
    <div className="area-table-scroll"><table className="area-table"><thead><tr><th>匹配条件</th><th>价格（USD）</th></tr></thead><tbody>
      {template && getTemplatePriceRules(template).map((tier, index) => <tr key={tier.areaTierId}><td>{formatAreaTierLabel(template, tier)}</td><td><RulePriceEditor label={`${title}第${index + 1}档价格`} value={charge.tierPrices.find(row => row.areaTierId === tier.areaTierId) ?? { areaTierId: tier.areaTierId, price: null }} disabled={disabled} onChange={price => {
        const next = structuredClone(charge)
        const position = next.tierPrices.findIndex(row => row.areaTierId === tier.areaTierId)
        if (position < 0) next.tierPrices.push(price)
        else next.tierPrices[position] = price
        onChange(next)
      }}/></td></tr>)}
    </tbody></table></div>
    <p className="pp-help">模板共享匹配条件，这里单独设置价格。{showFormula && '命中一档后，将该档价格代入公式。'}空白为未定价，0 表示明确不收费。</p>
    {showFormula && <AreaFormulaEditor label={`${title}计算公式`} value={charge.formula} variables={AREA_CHARGE_VARIABLES} defaultFormula={DEFAULT_AREA_FORMULA} disabled={disabled} onChange={formula => onChange({ ...charge, formula })}/>}
  </section>
}
