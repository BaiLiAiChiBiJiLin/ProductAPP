import { Button, Checkbox, Input, Select } from 'antd'
import { convertLengthValue, EXACT_SIZE_REQUIRED_MESSAGE, EXACT_SIZE_DIMENSIONS_REQUIRED_MESSAGE, type AreaTierPrice, type AreaUnit, type ExactSizeRule } from './areaPricing'
import RulePriceEditor from './RulePriceEditor'
import { displayPricingMessage } from './formulaDisplay'

type Group = { exactSizes?: ExactSizeRule[]; tierPrices: AreaTierPrice[] }
type Props = { value: Group; prefix: string; disabled: boolean; onChange: (value: Group) => void; onlyExact?: boolean }

export default function ExactSizeRulesEditor({ value, prefix, disabled, onChange, onlyExact }: Props) {
  const edit = (change: (next: Group) => void) => { const next = structuredClone(value); change(next); onChange(next) }
  return <section className="rule-exact-section" aria-label={`${prefix}固定尺寸规则`}>
    <div className="pp-section-heading"><h5>固定尺寸{!onlyExact && '（优先匹配）'}</h5><Button size="small" disabled={disabled} onClick={() => edit(next => {
      const areaTierId = `exact-size-${crypto.randomUUID()}`
      next.exactSizes ??= []
      next.exactSizes.push({ areaTierId, width: '', height: '', unit: 'in', allowRotation: true })
      next.tierPrices.push({ areaTierId, price: null, calculation: { kind: 'fixed' } })
    })}>新增{prefix === '底座' ? '底座' : ''}固定尺寸</Button></div>
    {!!value.exactSizes?.length && <div className="area-table-scroll"><table className="area-table rule-exact-table" aria-label={`${prefix}固定尺寸价格表`}><thead><tr><th>宽×高</th><th>价格（USD）</th><th>操作</th></tr></thead><tbody>{value.exactSizes.map((rule, index) => <tr key={rule.areaTierId}>
      <td><div className="rule-exact-controls"><div className="rule-exact-dimensions"><Input aria-label={`${prefix}固定尺寸${index + 1}宽`} inputMode="decimal" placeholder="宽" value={rule.width} disabled={disabled} onChange={event => edit(next => { next.exactSizes![index].width = event.target.value })}/><span>×</span><Input aria-label={`${prefix}固定尺寸${index + 1}高`} inputMode="decimal" placeholder="高" value={rule.height} disabled={disabled} onChange={event => edit(next => { next.exactSizes![index].height = event.target.value })}/></div>
        <div className="rule-exact-options"><Select aria-label={`${prefix}固定尺寸${index + 1}单位`} value={rule.unit} disabled={disabled} options={['in', 'cm', 'mm'].map(unit => ({ value: unit, label: unit }))} onChange={(unit: AreaUnit) => edit(next => {
          const changed = next.exactSizes![index]
          for (const key of ['width', 'height'] as const) {
            if (changed[key].trim()) { try { changed[key] = convertLengthValue(changed[key], changed.unit, unit) } catch { /* Keep invalid input for field validation. */ } }
          }
          changed.unit = unit
        })}/><Checkbox checked={rule.allowRotation} disabled={disabled} onChange={event => edit(next => { next.exactSizes![index].allowRotation = event.target.checked })}>宽高互换</Checkbox></div></div>
      </td>
      <td><RulePriceEditor label={`${prefix}固定尺寸${index + 1}价格`} value={value.tierPrices.find(row => row.areaTierId === rule.areaTierId) ?? { areaTierId: rule.areaTierId, price: null, calculation: { kind: 'fixed' } }} disabled={disabled} onChange={price => edit(next => {
        const position = next.tierPrices.findIndex(row => row.areaTierId === rule.areaTierId)
        if (position < 0) next.tierPrices.push(price)
        else next.tierPrices[position] = price
      })}/></td>
      <td><Button type="text" danger aria-label={`删除${prefix}固定尺寸${index + 1}`} disabled={disabled} onClick={() => edit(next => { next.exactSizes = next.exactSizes!.filter(row => row.areaTierId !== rule.areaTierId); next.tierPrices = next.tierPrices.filter(row => row.areaTierId !== rule.areaTierId) })}>删除</Button></td>
    </tr>)}</tbody></table></div>}
    {value.exactSizes?.some(rule => !rule.width.trim() || !rule.height.trim()) && <p className="pp-help">{displayPricingMessage(EXACT_SIZE_DIMENSIONS_REQUIRED_MESSAGE)}；价格留空时显示未定价。</p>}
    <p className="pp-help">{onlyExact ? value.exactSizes?.length ? '按指定宽高直接使用对应固定价；未匹配时显示未定价。' : `${displayPricingMessage(EXACT_SIZE_REQUIRED_MESSAGE)}，再填写宽、高和价格。` : '先匹配指定宽高，未命中再查区间。命中但价格留空时，不回退区间。'}</p>
  </section>
}
