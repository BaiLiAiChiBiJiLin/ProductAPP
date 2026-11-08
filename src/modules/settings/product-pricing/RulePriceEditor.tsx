import { Input } from 'antd'
import { type AreaTierPrice } from './areaPricing'
import './rules-editors.css'

type Props = {
  value: AreaTierPrice
  label: string
  disabled?: boolean
  compact?: boolean
  onChange: (value: AreaTierPrice) => void
}

/** Interval amounts use the template formula; exact sizes keep their direct fixed price. */
export default function RulePriceEditor({ value, label, disabled, compact, onChange }: Props) {
  const price = value.calculation && value.calculation.kind !== 'fixed' ? null : value.price
  return <div className={`rule-price-editor${compact ? ' rule-price-compact' : ''}`}>
    <Input aria-label={label} inputMode="decimal" placeholder="未定价" value={price ?? ''} disabled={disabled} onChange={event => onChange({
      areaTierId: value.areaTierId,
      price: event.target.value.trim() ? event.target.value : null,
      ...(value.calculation?.kind === 'fixed' ? { calculation: { kind: 'fixed' as const } } : {}),
    })}/>
  </div>
}
