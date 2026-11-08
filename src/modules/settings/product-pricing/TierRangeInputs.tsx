import { Button, Input } from 'antd'
import { getAreaTierBounds, type AreaTemplate, type AreaTier } from './areaPricing'

type Props = {
  template: Pick<AreaTemplate, 'tiers' | 'boundaryMode'>
  tier: AreaTier
  index: number
  prefix: string
  unit: string
  disabled: boolean
  onChange: (tiers: AreaTier[]) => void
}

/** Explicit endpoints are saved only when edited; opening a legacy template changes nothing. */
export default function TierRangeInputs({ template, tier, index, prefix, unit, disabled, onChange }: Props) {
  const bounds = getAreaTierBounds(template, tier)
  const edit = (change: (rows: AreaTier[]) => void) => {
    const rows = template.tiers.map(row => {
      const range = getAreaTierBounds(template, row)
      return { ...row, minArea: range.minArea, minInclusive: range.minInclusive }
    })
    change(rows)
    onChange(rows)
  }
  return <div className="rule-range-field">
    <div className="rule-range-inputs">
      <Input aria-label={`${prefix}第${index + 1}档下限`} inputMode="decimal" placeholder="起始值" disabled={disabled} value={bounds.minArea}
        onChange={event => edit(rows => { rows[index].minArea = event.target.value })}/>
      <span aria-hidden="true">—</span>
      <Input aria-label={`${prefix}第${index + 1}档上限`} inputMode="decimal" placeholder="不限" disabled={disabled} value={bounds.maxArea ?? ''}
        onChange={event => edit(rows => { rows[index].maxArea = event.target.value.trim() ? event.target.value : null })}
        onBlur={() => {
          // Wait for the complete value; copying the first typed digit would create an overlap.
          if (tier.maxArea && template.tiers[index + 1]?.minArea === '') edit(rows => { rows[index + 1].minArea = tier.maxArea! })
        }}/>
      <small>{unit}</small>
    </div>
    <div className="rule-range-caption">
      <Button type="text" size="small" disabled={disabled} aria-label={`${prefix}第${index + 1}档包含下限`} aria-pressed={bounds.minInclusive}
        title="点击切换是否包含起始值" onClick={() => edit(rows => { rows[index].minInclusive = !bounds.minInclusive })}>{bounds.minInclusive ? '含起点' : '不含起点'}</Button>
      {bounds.maxArea !== null && <small>· {bounds.maxInclusive ? '含终点' : '不含终点'}</small>}
    </div>
  </div>
}
