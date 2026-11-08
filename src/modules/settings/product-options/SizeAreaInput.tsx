import { Input, Select } from 'antd'
import { areaToMm2, convertSizeArea, type SizeArea } from './sizeArea'

type Props = { value: SizeArea; label: string; onChange: (value: SizeArea) => void; disabled?: boolean; compact?: boolean }

export default function SizeAreaInput({ value, label, onChange, disabled, compact = false }: Props) {
  let squareMillimetres = ''
  try { squareMillimetres = areaToMm2(value) } catch { /* Incomplete dimensions remain editable. */ }
  return <div className="po-size-area" role="group" aria-label={`${label}面积`}>
    {!compact && <span>面积（宽 × 高）</span>}
    <div className="po-size-area-inputs">
      <Input aria-label={`${label}面积宽`} placeholder="宽" inputMode="decimal" disabled={disabled} value={value.width} onChange={event => onChange({ ...value, width: event.target.value })}/>
      <span>×</span>
      <Input aria-label={`${label}面积高`} placeholder="高" inputMode="decimal" disabled={disabled} value={value.height} onChange={event => onChange({ ...value, height: event.target.value })}/>
      <Select aria-label={`${label}面积单位`} value={value.unit} disabled={disabled} options={['in', 'cm', 'mm'].map(unit => ({ value: unit, label: unit }))} onChange={unit => onChange(convertSizeArea(value, unit))}/>
    </div>
    {!compact && squareMillimetres && <small>{squareMillimetres} mm²</small>}
  </div>
}
