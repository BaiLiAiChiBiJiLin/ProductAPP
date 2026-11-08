import { catalogFor, display, entityReference, getEntityId, isEnabled, optionFor, type Bundle, type Product } from '../product-options/model'
import { AREA_ATTRIBUTE_OPTIONS, getAttributePlanCharge, getTemplatePriceCharge, previewAreaProductCharge, resolveProductAttributePlan, resolveProductBaseTemplate, type AreaProductCharge, type AreaDimensions, type AreaPricingDocument, type AreaQuoteResult, type AreaQuoteStep, type AreaStandeeInput, type PricedAreaTemplate } from './areaPricing'
import { displayPricingMessage, displayPricingFormula } from './formulaDisplay'

type Props = {
  document: AreaPricingDocument
  bundle: Bundle
  product: Product
  dimensions: AreaDimensions
  selections: Record<string, string>
  result?: AreaQuoteResult
  dependencyError: string
  hasSize: boolean
  standee?: AreaStandeeInput
}
type PriceRow = { variable: string; label: string; step?: AreaQuoteStep; error?: string; template?: PricedAreaTemplate; charge?: AreaProductCharge; planName?: string }

const matchDescription = (step: AreaQuoteStep) => step.calculationKind === 'adjustment' ? '每套一次，已计入产品单价'
  : step.matchBy === 'exact-size' ? `固定尺寸 ${step.widthMm} × ${step.heightMm} mm`
    : step.matchBy === 'longest-side' ? `最长边 ${step.longestSideMm} mm` : `面积 ${step.areaMm2} mm²`
const calculationLabel = (step: AreaQuoteStep) => ({ fixed: '固定价', area: '面积计算', formula: '自定义算法', inherited: '单价公式', adjustment: '每套调整' }[step.calculationKind ?? 'inherited'])

function Calculation({ step }: { step: AreaQuoteStep }) {
  return <>
    <small>{calculationLabel(step)}{Number(step.amount) < 0 ? ' · 抵扣' : ''}</small>
    {step.calculationKind !== 'fixed' && step.calculationKind !== 'adjustment' && <div className="area-step-inputs">
      <span>基价：{step.basePrice === null ? '未使用或未填写' : `$${step.basePrice}`}</span>
      <span>档位价格：{step.tierPrice ?? '未使用或未填写'}</span>
    </div>}
    <div>{displayPricingFormula(step.formula)}</div><small className="area-step-substitution">{step.substitutedFormula} = {step.amount}</small>
  </>
}

export default function AreaPriceSteps({ document, bundle, product, dimensions, selections, result, dependencyError, hasSize, standee }: Props) {
  const rows: PriceRow[] = []
  const preview = (row: PriceRow) => {
    if (dependencyError) row.error = '配置尚未加载完整，暂无法计算'
    else if (!row.step && !row.error && row.charge && row.template) {
      try {
        if (!hasSize) throw new Error('请选择已启用的尺寸')
        row.step = previewAreaProductCharge(row.charge, row.template, dimensions, standee, row.label, row.variable,
          row.variable === '产品单价' ? { adjustment: document.productAdjustments.find(value => value.productId === product.productId)?.amount } : { allowNegative: true })
      } catch (error) { row.error = displayPricingMessage(String(error).replace(/^Error: /, '')) }
    }
    rows.push(row)
  }
  const base = resolveProductBaseTemplate(document, bundle, product.productId).template
  preview({ variable: '产品单价', label: '产品单价', step: result?.steps.find(step => step.key === 'body'), template: base,
    charge: base ? getTemplatePriceCharge(base) : undefined, error: base ? undefined : '未选择产品价格模板，请在产品基础单价中设置' })
  for (const definition of AREA_ATTRIBUTE_OPTIONS) {
    const option = optionFor(product, definition.name)
    if (!option || option.deleted) continue
    const available = catalogFor(bundle, product, definition.name).values.filter(value => isEnabled(option, value))
    if (!available.length) continue
    const selected = available.find(value => getEntityId(value) === selections[definition.name])
    const row: PriceRow = { variable: definition.variable, label: selected ? `${definition.label} · ${display(selected)}` : definition.label,
      step: result?.steps.find(step => step.optionName === definition.name) }
    if (!selected) row.error = `请选择${definition.label}`
    else if (definition.name === 'Accessories Style') {
      const color = selected.colors?.find(value => getEntityId(value) === selections['Accessories Style:color'] && isEnabled(option, value))
      const pricedValue = document.accessoryPricing === 'color' ? color : selected
      const price = document.accessoryPrices?.find(value => value.accessoryStyleId === getEntityId(selected) && value.accessoryColorId === (document.accessoryPricing === 'color' && color ? getEntityId(color) : null))?.unitPrice
      if (!pricedValue) row.error = '请选择配件颜色'
      else if (price == null) row.error = '配件公共固定单价未定价'
      else if (!row.step) row.step = { key: definition.variable, label: `配件 · ${display(pricedValue)}`, pricingKind: 'fixed', basePrice: price, tierPrice: null,
        areaTemplateId: '', templateName: '公共固定单价', areaTierId: '', tierLabel: '不按面积计价', areaMm2: '', formula: '配件固定单价', substitutedFormula: price, amount: price }
      if (pricedValue) row.label = `配件 · ${display(pricedValue)}`
    } else {
      const resolved = resolveProductAttributePlan(document, bundle, product.productId, definition.name, entityReference(selected))
      row.template = resolved.template
      row.planName = resolved.plan?.name
      if (resolved.price && resolved.template) row.charge = getAttributePlanCharge(resolved.price, resolved.template)
      else row.error = '未定价，请在产品基础单价中选择匹配的附加方案，并配置该选项价格'
    }
    preview(row)
  }
  return <section className="area-price-steps" aria-label="单价计算步骤">
    <h5>单价计算步骤</h5>
    <div className="area-table-scroll"><table className="area-table area-steps-table"><thead><tr><th>价格组成</th><th>取价依据</th><th>单价计算过程</th><th>单价（USD）</th></tr></thead><tbody>
      {rows.map(row => {
        const step = dependencyError ? undefined : row.step
        return <tr key={row.variable}>
          <th scope="row">{displayPricingFormula(row.variable)}{row.label !== row.variable && <small>{row.label}</small>}{row.planName && <small>方案：{row.planName}</small>}</th>
          <td>{step?.templateName ?? row.template?.name ?? '—'}
            {step && <><small>{step.tierLabel}</small>{step.areaTemplateId && !step.parts && <small>{matchDescription(step)}</small>}</>}
          </td>
          <td className="area-equation">{step ? !step.areaTemplateId && !step.parts ? <><span>配件固定单价</span><small>{step.substitutedFormula} USD / 件</small></> : step.parts ? <>
            {step.parts.map(part => <div className="area-step-part" key={part.key}>
              <strong>{displayPricingFormula(part.label)}</strong><small>{part.tierLabel} · {matchDescription(part)}</small>
              <Calculation step={part}/>
            </div>)}
            <strong>合计：{step.substitutedFormula} = {step.amount}</strong>
          </> : <>
            <Calculation step={step}/>
          </> : <span className="area-error">{row.error || '未定价'}</span>}</td>
          <td className="area-step-amount">{step ? step.amount : '待计算'}</td>
        </tr>
      })}
    </tbody></table></div>
  </section>
}
