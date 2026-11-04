import { useState } from 'react'
import { Alert, Modal } from 'antd'
import { isAttributePrice, isUnitPrice } from './model'
import PriceInput from './PriceInput'

export type SizePriceValue = { sizeBandId: string | null; unitPrice: string }
type Props = {
  sizes: { sizeBandId: string | null; label: string }[]; prices: SizePriceValue[]
  title: string; priceLabel: string; description: string; signed?: boolean; showSizeIds?: boolean
  onApply: (prices: SizePriceValue[]) => void; onCancel: () => void
}

export default function SizePriceDialog({ sizes, prices, title, priceLabel, description, signed = false, showSizeIds = false, onApply, onCancel }: Props) {
  const [values, setValues] = useState(() => sizes.map(size => ({ ...size, unitPrice: prices.find(price => price.sizeBandId === size.sizeBandId)?.unitPrice ?? '' })))
  const [error, setError] = useState('')
  const apply = () => {
    const invalid = values.find(value => value.unitPrice.trim() && !(signed ? isAttributePrice(value.unitPrice) : isUnitPrice(value.unitPrice)))
    if (invalid) { setError(`${invalid.label}的${priceLabel}无效，请填写${signed ? '有效' : '非负'}金额；空白表示未定价`); return }
    onApply(values.filter(value => value.unitPrice.trim()).map(({ sizeBandId, unitPrice }) => ({ sizeBandId, unitPrice })))
  }
  return <Modal title={title} open width={680} maskClosable={false} okText="应用" cancelText="取消" onOk={apply} onCancel={onCancel}>
    <p className="pp-help">{description}</p>
    <p className="pp-help">尺寸统一在“产品选项配置 → 产品属性 → 尺寸”中设置。空白表示未定价，0 表示不收费；应用后加入草稿，页面保存后生效。</p>
    {error && <Alert type="error" showIcon message={error}/>}
    <div className="pp-size-prices-scroll" aria-label={`各尺寸${priceLabel}`} tabIndex={0}><table className="pp-size-prices-table"><thead><tr><th scope="col">产品尺寸</th><th scope="col">{priceLabel}（USD / 件）</th></tr></thead><tbody>
      {values.map(size => <tr key={size.sizeBandId ?? 'fixed'}><th scope="row">{size.label}{showSizeIds && <small className="pp-shared-size-id">{size.sizeBandId ?? '不区分尺寸'}</small>}</th><td><PriceInput label={`${size.label}${showSizeIds && size.sizeBandId ? ` ${size.sizeBandId}` : ''} ${priceLabel}`} value={size.unitPrice} signed={signed} onChange={value => { setValues(current => current.map(item => item.sizeBandId === size.sizeBandId ? { ...item, unitPrice: value } : item)); setError('') }}/></td></tr>)}
    </tbody></table></div>
    <p className="pp-help">显示 4 位小数，点击输入框可编辑完整精度。{signed && '负数表示该属性减价。'}</p>
  </Modal>
}
