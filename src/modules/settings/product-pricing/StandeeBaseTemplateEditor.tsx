import { useState } from 'react'
import { Button, Input, Modal, Select } from 'antd'
import { getDefaultTemplateFormula, getTemplateFormulaVariables, getTemplateMatchBy, templateUnitLabel, type AreaUnit, type StandeeBaseTemplate, type TemplateMatchBy } from './areaPricing'
import { displayAreaBoundary } from './AreaChargeEditor'
import AreaFormulaEditor from './AreaFormulaEditor'
import RulePriceEditor from './RulePriceEditor'
import ExactSizeRulesEditor from './ExactSizeRulesEditor'
import TierRangeInputs from './TierRangeInputs'
import { convertTierBounds, insertTierRange, removeTierRange } from './tierRangeEditing'
import { isUnitPrice } from './model'

type Props = { value: StandeeBaseTemplate; disabled: boolean; onChange: (value: StandeeBaseTemplate) => void }

export default function StandeeBaseTemplateEditor({ value, disabled, onChange }: Props) {
  const [switching, setSwitching] = useState<TemplateMatchBy>()
  const exact = getTemplateMatchBy(value) === 'exact-size'
  const longest = getTemplateMatchBy(value) === 'longest-side'
  const measure = longest ? '最长边' : '面积'
  const symbol = longest ? 'L' : 'A'
  const unit = templateUnitLabel(value)
  const edit = (change: (next: StandeeBaseTemplate) => void) => { const next = structuredClone(value); change(next); onChange(next) }
  const changeMode = (matchBy: TemplateMatchBy) => edit(next => {
    const areaTierId = `base-tier-${crypto.randomUUID()}`
    next.matchBy = matchBy
    next.unit = matchBy === 'longest-side' ? 'mm' : 'cm'
    next.boundaryMode = matchBy === 'longest-side' ? 'upper-inclusive' : 'lower-inclusive'
    next.tiers = matchBy === 'exact-size' ? [] : [{ areaTierId, maxArea: null }]
    next.tierPrices = next.tierPrices.filter(row => next.exactSizes?.some(rule => rule.areaTierId === row.areaTierId))
    if (matchBy !== 'exact-size') next.tierPrices.unshift({ areaTierId, price: null })
    next.formula = getDefaultTemplateFormula(matchBy)
    if (matchBy === 'exact-size' && next.basePrice !== null && !isUnitPrice(next.basePrice)) next.basePrice = null
  })
  return <section className="area-template-panel area-standee-base-editor" aria-label="底座价格区间">
    <h4>底座价格区间</h4>
    <div className={`area-config-fields area-template-rule-fields${exact ? ' area-template-rule-fields-exact' : ''}`}>
      <label>单价计算方式<Select aria-label="底座单价计算方式" value={getTemplateMatchBy(value)} disabled={disabled} options={[{ value: 'area', label: '面积' }, { value: 'longest-side', label: '最长边' }, { value: 'exact-size', label: '固定尺寸' }]} onChange={mode => {
        if (mode === getTemplateMatchBy(value)) return
        if (value.tiers.length === 1 && value.tiers[0].maxArea === null && value.tierPrices.every(row => row.price === null)) changeMode(mode)
        else setSwitching(mode)
      }}/></label>
      {!exact && <label>单位<Select aria-label="底座单位" value={value.unit} disabled={disabled} options={['in', 'cm', 'mm'].map(item => ({ value: item, label: longest ? item : `${item}²` }))} onChange={(target: AreaUnit) => edit(next => {
        next.tiers = convertTierBounds(next, target)
        next.unit = target
      })}/></label>}
      {!exact && <label>基价（USD）<Input aria-label="底座基价" placeholder="未定价" inputMode="decimal" value={value.basePrice ?? ''} disabled={disabled} onChange={event => edit(next => { next.basePrice = event.target.value.trim() ? event.target.value : null })}/></label>}
    </div>
    <p className="pp-help">{exact ? '使用底座宽高匹配固定尺寸，每套产品只计算一次。' : '使用底座宽高匹配区间，每套产品只计算一次。'}</p>
    {!exact && <><div className="area-table-scroll"><table className="area-table area-template-table" aria-label="底座档位价格表"><thead><tr><th>{measure}区间{longest ? `（${unit}）` : ''}</th><th>价格（USD）</th><th>操作</th></tr></thead><tbody>{value.tiers.map((tier, index) => <tr key={tier.areaTierId}>
      <td>{longest || tier.minArea !== undefined ? <TierRangeInputs template={value} tier={tier} index={index} prefix="底座" unit={unit} disabled={disabled} onChange={tiers => edit(next => { next.tiers = tiers })}/> : <div className="area-tier-interval">{tier.maxArea === null ? <span>{index ? `${symbol} ${value.boundaryMode === 'lower-inclusive' ? '≥' : '>'} ${displayAreaBoundary(value.tiers[index - 1].maxArea ?? '') || '待填写'} ${unit}` : longest ? '全部长度' : '全部面积'}</span> : <><span className="area-tier-prefix">{index ? `${displayAreaBoundary(value.tiers[index - 1].maxArea ?? '') || '待填写'} ${value.boundaryMode === 'lower-inclusive' ? '≤' : '<'} ` : ''}{symbol} {value.boundaryMode === 'lower-inclusive' ? '<' : '≤'}</span><Input aria-label={`底座第${index + 1}档上限`} inputMode="decimal" suffix={unit} value={tier.maxArea} disabled={disabled} onChange={event => edit(next => { next.tiers[index].maxArea = event.target.value })}/></>}</div>}</td>
      <td><RulePriceEditor label={`底座第${index + 1}档价格`} value={value.tierPrices.find(row => row.areaTierId === tier.areaTierId) ?? { areaTierId: tier.areaTierId, price: null }} disabled={disabled} onChange={price => edit(next => {
        const position = next.tierPrices.findIndex(row => row.areaTierId === tier.areaTierId)
        if (position < 0) next.tierPrices.push(price)
        else next.tierPrices[position] = price
      })}/></td>
      <td><Button type="text" danger aria-label={`删除底座第${index + 1}档`} disabled={disabled || value.tiers.length === 1 || !longest && tier.minArea === undefined && tier.maxArea === null} onClick={() => edit(next => {
        next.tiers = removeTierRange(next, tier.areaTierId)
        next.tierPrices = next.tierPrices.filter(row => row.areaTierId !== tier.areaTierId)
      })}>删除</Button></td>
    </tr>)}</tbody></table></div>
    <div className="area-toolbar"><Button disabled={disabled} onClick={() => edit(next => {
      const areaTierId = `base-tier-${crypto.randomUUID()}`
      const added = insertTierRange(next, areaTierId)
      next.tiers = added.tiers
      next.tierPrices.splice(added.index, 0, { areaTierId, price: null })
    })}>新增底座档位</Button></div></>}
    <ExactSizeRulesEditor value={value} prefix="底座" disabled={disabled} onlyExact={exact} onChange={group => edit(next => { next.exactSizes = group.exactSizes; next.tierPrices = group.tierPrices })}/>
    {!exact && <><p className="pp-help">底座区间价格统一代入以下公式；固定尺寸直接使用填写的价格。</p>
    <AreaFormulaEditor label="底座单价计算公式" value={value.formula} variables={getTemplateFormulaVariables(value)} defaultFormula={getDefaultTemplateFormula(getTemplateMatchBy(value))} disabled={disabled} onChange={formula => edit(next => { next.formula = formula })}/></>}
    <Modal title="切换底座单价计算方式？" open={!!switching} okText="切换并重设" cancelText="取消" onCancel={() => setSwitching(undefined)} onOk={() => { if (switching) changeMode(switching); setSwitching(undefined) }}>底座区间、区间档价和默认公式将重设，固定尺寸保留；主体片材区间保持当前配置。取消整个模板编辑可以放弃本次修改。</Modal>
  </section>
}
