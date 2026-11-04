import { useState } from 'react'
import { Input } from 'antd'
import { isUnitPrice } from './model'

export function displayPrice(value: string): string {
  const negative = value.startsWith('-')
  const raw = negative ? value.slice(1) : value
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return value
  const [whole, fraction = ''] = raw.split('.')
  const digits = BigInt(whole + fraction.padEnd(4, '0').slice(0, 4)) + (Number(fraction[4] ?? '0') >= 5 ? 1n : 0n)
  const text = digits.toString().padStart(5, '0')
  return `${negative && digits ? '-' : ''}${text.slice(0, -4)}.${text.slice(-4)}`
}

export default function PriceInput({ label, value, disabled, signed = false, onChange }: { label: string; value: string; disabled?: boolean; signed?: boolean; onChange: (value: string) => void }) {
  const [focused, setFocused] = useState(false)
  const candidate = signed && value.startsWith('-') ? value.slice(1) : value
  const valid = isUnitPrice(candidate)
  return <Input aria-label={label} inputMode="decimal" placeholder="未定价" value={focused ? value : displayPrice(value)} title={value ? `完整金额：${value} USD` : '尚未配置价格'} disabled={disabled} status={value && !valid ? 'error' : undefined} aria-invalid={!!value && !valid} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={event => onChange(event.target.value)}/>
}
