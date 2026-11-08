import { Input, Select } from 'antd'
import { convertSizeArea, type SizeArea } from '../product-options/sizeArea'

type Props = { parts: SizeArea[]; base: SizeArea; disabled: boolean; onPartChange: (index: number, value: SizeArea) => void; onBaseChange: (value: SizeArea) => void }

export default function StandeeDimensionsInput({ parts, base, disabled, onPartChange, onBaseChange }: Props) {
  const row = (label: string, value: SizeArea, change: (value: SizeArea) => void) => <tr key={label}>
    <th scope="row">{label}</th>
    <td><Input aria-label={`立牌${label}宽`} inputMode="decimal" placeholder="宽" disabled={disabled} value={value.width} onChange={event => change({ ...value, width: event.target.value })}/></td>
    <td><Input aria-label={`立牌${label}高`} inputMode="decimal" placeholder="高" disabled={disabled} value={value.height} onChange={event => change({ ...value, height: event.target.value })}/></td>
    <td><Select aria-label={`立牌${label}单位`} disabled={disabled} value={value.unit} options={['mm', 'cm', 'in'].map(unit => ({ value: unit, label: unit }))} onChange={unit => change(convertSizeArea(value, unit))}/></td>
  </tr>
  return <section className="area-standee-dimensions" aria-label="立牌尺寸">
    <h5>主体与底座尺寸</h5>
    <p className="pp-help">每片主体分别填写宽高，底座填写一次。主体和各项产品属性价格共用这些尺寸。</p>
    <div className="area-table-scroll"><table className="area-table"><thead><tr><th>组成</th><th>宽</th><th>高</th><th>单位</th></tr></thead><tbody>
      {parts.map((part, index) => row(`主体${index + 1}`, part, value => onPartChange(index, value)))}
      {row('底座', base, onBaseChange)}
    </tbody></table></div>
  </section>
}
