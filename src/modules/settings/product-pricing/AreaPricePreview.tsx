import { useId, useState } from 'react'
import { Alert, Button, Input, Select } from 'antd'
import { catalogFor, display, getEntityId, getProductSizes, isEnabled, optionFor, ordered, resolvePreview, type Bundle, type Product } from '../product-options/model'
import SizeAreaInput from '../product-options/SizeAreaInput'
import { emptySizeArea, type SizeArea } from '../product-options/sizeArea'
import type { QuantityPricingDocument } from '../quantity-pricing/model'
import { AREA_ATTRIBUTE_OPTIONS, getDefaultProductTotalFormula, getProductTotalVariables, getTemplateMatchBy, quoteAreaProduct, resolveProductBaseTemplate, resolveProductTotalFormula, type AreaPricingDocument } from './areaPricing'
import AreaFormulaEditor from './AreaFormulaEditor'
import AreaPriceSteps from './AreaPriceSteps'
import StandeeDimensionsInput from './StandeeDimensionsInput'
import { displayPricingMessage, displayPricingFormula } from './formulaDisplay'

type Props = { document: AreaPricingDocument; product: Product; bundle: Bundle; quantityPricing: QuantityPricingDocument; disabled: boolean; dependencyError: string; onChange: (change: (document: AreaPricingDocument) => void) => void }

export default function AreaPricePreview({ document, product, bundle, quantityPricing, disabled, dependencyError, onChange }: Props) {
  const sizes = getProductSizes(bundle, product)
  const [sizeId, setSizeId] = useState(() => sizes[0] ? getEntityId(sizes[0]) : '')
  const [customArea, setCustomArea] = useState<SizeArea>(emptySizeArea)
  const [standeeParts, setStandeeParts] = useState<SizeArea[]>(() => Array.from({ length: 4 }, () => ({ width: '', height: '', unit: 'mm' })))
  const [standeeBase, setStandeeBase] = useState<SizeArea>(() => ({ width: '', height: '', unit: 'mm' }))
  const [quantity, setQuantity] = useState('1')
  const [showSteps, setShowSteps] = useState(false)
  const stepsId = useId()
  const [requested, setRequested] = useState<Record<string, string>>(() => {
    const values = resolvePreview(bundle, product, {}).selections
    for (const option of product.productOptions.filter(option => !option.deleted)) {
      if (!values[option.name]) {
        const value = ordered(catalogFor(bundle, product, option.name).values).find(value => isEnabled(option, value))
        if (value) values[option.name] = getEntityId(value)
      }
    }
    return values
  })
  const selections = resolvePreview(bundle, product, requested).selections
  const pieceOption = optionFor(product, 'Standee Quantity')
  const pieceValues = ordered(catalogFor(bundle, product, 'Standee Quantity').values).filter(value => isEnabled(pieceOption, value))
  const hasPieceCount = !!pieceOption && !pieceOption.deleted && !!pieceValues.length
  const baseTemplate = resolveProductBaseTemplate(document, bundle, product.productId).template
  const usesStandee = hasPieceCount || !!baseTemplate?.standeeBase
  const pieceCount = hasPieceCount ? pieceValues.find(value => getEntityId(value) === selections['Standee Quantity'])?.pieceCount ?? 0 : 1
  const standee = usesStandee ? { parts: standeeParts.slice(0, pieceCount), base: standeeBase } : undefined
  const size = sizes.find(value => getEntityId(value) === sizeId)
  const area = standee ? standee.parts[0] ?? emptySizeArea() : size?.isCustom ? customArea : size?.area ?? emptySizeArea()
  const totalFormula = resolveProductTotalFormula(document, bundle, product.productId)
  const allowedVariables = getProductTotalVariables(bundle, product.productId)
  const formulaTokens: string[] = totalFormula.match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? []
  const formulaUses = (name: string) => formulaTokens.includes(name)
  const templateUses = (name: string) => [baseTemplate, baseTemplate?.standeeBase].some(group => group && (
    group.formula.includes(name) || group.formulas?.some(definition => definition.formula.includes(name))
    || name === '面积平方毫米' && group.tierPrices.some(row => row.calculation?.kind === 'area')
  ))
  const formulaVariables = allowedVariables.filter(name => {
    if (name === '属性价') return formulaUses(name)
    if (name === '最长边毫米') return !!baseTemplate && (getTemplateMatchBy(baseTemplate) === 'longest-side' || !!baseTemplate.standeeBase && getTemplateMatchBy(baseTemplate.standeeBase) === 'longest-side') || templateUses(name) || formulaUses(name)
    if (name === '面积平方毫米') return !!baseTemplate && (getTemplateMatchBy(baseTemplate) === 'area' || !!baseTemplate.standeeBase && getTemplateMatchBy(baseTemplate.standeeBase) === 'area') || templateUses(name) || formulaUses(name)
    return true
  })
  const style = catalogFor(bundle, product, 'Accessories Style').values.find(value => getEntityId(value) === selections['Accessories Style'])
  const colors = ordered(style?.colors ?? []).filter(value => isEnabled(optionFor(product, 'Accessories Style'), value))
  const choose = (name: string, value?: string) => setRequested(current => ({ ...current, [name]: value ?? '' }))
  let result: ReturnType<typeof quoteAreaProduct> | undefined
  let error = ''
  try {
    if (dependencyError) throw new Error(dependencyError)
    if (!standee && !size) throw new Error('请先在产品选项配置中启用尺寸，再选择试算尺寸。自定义尺寸需要单独启用。')
    if (!/^\d+$/.test(quantity) || !Number.isSafeInteger(Number(quantity)) || Number(quantity) < 1) throw new Error('购买数量必须是大于零的整数')
    result = quoteAreaProduct(document, bundle, quantityPricing, {
      productId: product.productId, ...area, sizeBandId: standee ? undefined : sizeId, selections, standee,
      accessoryColorId: selections['Accessories Style:color'] || undefined,
      standeeQuantityId: selections['Standee Quantity'] || undefined,
      quantity: Number(quantity),
    })
  } catch (failure) { error = displayPricingMessage(String(failure).replace(/^Error: /, '')) }
  return <section className="pp-card area-preview" aria-label="产品价格试算">
    <div className="area-preview-layout">
      <div className="area-preview-inputs">
        <div className="area-preview-heading"><h4>试算条件</h4><span>修改选项或尺寸，结果实时更新</span></div>
        <div className="pp-preview-fields">
          {!usesStandee && <label>尺寸<Select aria-label="试算尺寸" value={size?.sizeBandId} placeholder="请在产品选项中启用尺寸" onChange={setSizeId} options={sizes.map(value => ({ value: getEntityId(value), label: display(value) }))}/></label>}
          {[{ name: 'Print Option', label: '印刷' }, ...AREA_ATTRIBUTE_OPTIONS].map(definition => {
            const option = optionFor(product, definition.name)
            if (!option || option.deleted) return null
            const values = ordered(catalogFor(bundle, product, definition.name).values).filter(value => isEnabled(option, value))
            if (!values.length) return null
            return <label key={definition.name}>{definition.label}<Select aria-label={`试算${definition.label}`} allowClear value={selections[definition.name] || undefined} placeholder="请选择" options={values.map(value => ({ value: getEntityId(value), label: display(value) }))} onChange={value => choose(definition.name, value)}/></label>
          })}
          {!!colors.length && <label>配件颜色<Select aria-label="试算配件颜色" allowClear value={selections['Accessories Style:color'] || undefined} onChange={value => choose('Accessories Style:color', value)} options={colors.map(value => ({ value: getEntityId(value), label: display(value) }))}/></label>}
          {hasPieceCount && <label>主体片数<Select aria-label="试算主体片数" value={selections['Standee Quantity'] || undefined} onChange={value => choose('Standee Quantity', value)} options={pieceValues.map(value => ({ value: getEntityId(value), label: display(value) }))}/></label>}
          <label>购买数量<Input aria-label="试算购买数量" inputMode="numeric" value={quantity} onChange={event => setQuantity(event.target.value)}/></label>
        </div>
        {standee ? <StandeeDimensionsInput parts={standee.parts} base={standee.base} disabled={disabled || !!dependencyError} onPartChange={(index, value) => setStandeeParts(current => current.map((part, partIndex) => partIndex === index ? value : part))} onBaseChange={setStandeeBase}/> : size && <div className="area-preview-size"><SizeAreaInput label="试算" value={area} disabled={disabled || !size.isCustom} onChange={setCustomArea}/>{!size.isCustom && <small className="pp-muted">尺寸宽高来自产品选项配置。</small>}</div>}
        <section className="area-preview-details" aria-label="计算明细">
          <Button type="text" className="area-preview-details-toggle" aria-expanded={showSteps} aria-controls={stepsId} onClick={() => setShowSteps(value => !value)}>
            <span aria-hidden="true">{showSteps ? '▾' : '▸'}</span>{showSteps ? '收起计算明细' : '展开计算明细'}<span className="pp-muted">查看单价、属性和底座的取价过程</span>
          </Button>
          <div id={stepsId} hidden={!showSteps}>{showSteps && <AreaPriceSteps document={document} bundle={bundle} product={product} dimensions={area} selections={selections} result={result} dependencyError={dependencyError} hasSize={!!size || !!standee} standee={standee}/>}</div>
        </section>
      </div>
      <aside className="area-preview-summary" aria-label="试算结果与公式" tabIndex={-1}>
        <div className="area-preview-result" aria-live="polite" aria-atomic="true">
          {result ? <div className="pp-total"><span>试算总额</span><strong>${result.totalPrice}</strong><small>USD</small></div> : <div className="area-total-pending"><span>试算结果</span><strong>待计算</strong></div>}
          {result && <div className="area-result-meta"><span>数量 {quantity}</span><span>折扣系数 {result.discountFactor}（优惠 {result.discountPercent}%）</span>{hasPieceCount && <span>主体 {result.variables['主体片数']} 片</span>}{formulaUses('属性价') && <span>属性合计 {result.variables['属性价']} USD</span>}</div>}
          {error && <Alert type="warning" showIcon message={error}/>}
        </div>
        <div className="area-preview-summary-content">
          {result && <section className="pp-formula area-final-substitution" aria-label="最终公式代入"><h5>最终公式代入</h5><p>{displayPricingFormula(result.formula)}</p><p className="pp-formula-values">{result.substitutedFormula} = {result.totalPrice} USD</p></section>}
          <section className="pp-formula area-total-formula" aria-label="最终总价公式">
            <AreaFormulaEditor label="总价计算公式" value={totalFormula} variables={formulaVariables} validationVariables={allowedVariables} defaultFormula={getDefaultProductTotalFormula(bundle, product.productId)} disabled={disabled || !!dependencyError} onChange={formula => onChange(next => {
              next.productTotalFormulas = next.productTotalFormulas.filter(row => row.productId !== product.productId)
              if (formula !== getDefaultProductTotalFormula(bundle, product.productId)) next.productTotalFormulas.push({ productId: product.productId, formula })
            })}/>
            <small>公式仅对当前产品生效，修改后点击页面上方“保存”。</small>
            <details className="area-formula-help"><summary>公式与计价说明</summary>
              <small>将各项单价按需要组合，再计算折扣和数量。每一步保留完整计算精度，总额四舍五入到分。{formulaUses('属性价') && '“属性合计”是各项附加属性价之和，不含配件；使用合计时无需重复相加各项属性价。'}</small>
              {standee && <small>产品单价和各项属性价已包含全部主体片材及一次底座费用，无需再乘主体片数。面积变量为所有主体片材与底座的总面积；最长边变量为这些尺寸中的最大边长。</small>}
            </details>
          </section>
        </div>
      </aside>
    </div>
  </section>
}
