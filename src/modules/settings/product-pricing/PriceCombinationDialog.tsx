import { useState } from 'react'
import { Alert, Modal, Select } from 'antd'
import { display, getEntityId, ordered, type Bundle, type Product } from '../product-options/model'
import { getPricingDimensions, isUnitPrice, type PriceSelections, type ProductPricing } from './model'
import { priceGroupKey } from './priceGroups'
import PriceInput from './PriceInput'

export type CombinationDraft = PriceSelections & { productPriceId: string; unitPrice: string }
type Props = {
  pricing: ProductPricing; product: Product; bundle: Bundle
  initial: CombinationDraft; mode: 'new' | 'attributes'
  onApply: (row: CombinationDraft) => void; onCancel: () => void
}

export default function PriceCombinationDialog({ pricing, product, bundle, initial, mode, onApply, onCancel }: Props) {
  const [draft, setDraft] = useState(() => structuredClone(initial))
  const [error, setError] = useState('')
  const isDimensions = pricing.pricingMode === 'standee'
  const dimensions = getPricingDimensions(bundle, product, draft)
  const title = mode === 'attributes' ? '编辑价格属性' : '新增价格组合'
  const changeSelection = (field: keyof PriceSelections, value: string | null) => {
    setDraft(current => {
      const next = { ...current, [field]: value }
      for (const dimension of getPricingDimensions(bundle, product, next)) {
        if (!dimension.required || !dimension.values.some(item => getEntityId(item) === next[dimension.field])) next[dimension.field] = null
      }
      return next
    })
    setError('')
  }
  const apply = () => {
    const row = { ...draft }
    for (const dimension of getPricingDimensions(bundle, product, row)) {
      if (!dimension.required) row[dimension.field] = null
      else if (!dimension.values.some(value => getEntityId(value) === row[dimension.field]) || dimension.resolvedId !== row[dimension.field]) {
        setError(`请选择当前可用的${dimension.label}`); return
      }
    }
    if (mode === 'new' && isDimensions && !isUnitPrice(row.unitPrice)) { setError('请填写有效的主体价格，0 表示免费'); return }
    const duplicate = pricing.dimensionPrices.some(price => price.productPriceId !== row.productPriceId && priceGroupKey(price) === priceGroupKey(row))
    if (duplicate) { setError('这个属性组合已经存在，请编辑原价格组'); return }
    onApply(row)
  }
  const nextLabel = isDimensions ? '下一步：填写尺寸' : '下一步：填写尺寸价格'
  return <Modal title={title} open width={620} maskClosable={false} okText={mode === 'new' ? nextLabel : '应用'} cancelText="取消" onCancel={onCancel} onOk={apply}>
    <div className="pp-combination-form">
      <p className="pp-help">{mode === 'attributes' ? '修改属性将应用到这一组全部尺寸的价格，金额保持不变。' : '先选择这一组的属性，再填写对应的尺寸价格。'}应用后加入当前草稿，点击页面“保存”才会写入配置。</p>
      {error && <Alert type="error" showIcon message={error}/>}
      {mode === 'new' && isDimensions && <label>主体固定金额（USD / 套）<PriceInput label="新组合主体价格" value={draft.unitPrice} onChange={value => { setDraft(current => ({ ...current, unitPrice: value })); setError('') }}/></label>}
      {dimensions.filter(dimension => dimension.enabled).map(dimension => <label key={dimension.field}>{dimension.label}
        {dimension.required ? <Select aria-label={`组合${dimension.label}`} value={draft[dimension.field] ?? undefined} placeholder={`请选择${dimension.label}`} onChange={value => changeSelection(dimension.field, value)} options={ordered(dimension.values).map(value => ({ value: getEntityId(value), label: display(value) }))}/> : <span className="pp-muted">当前组合不使用此属性</span>}
      </label>)}
      {!dimensions.some(dimension => dimension.enabled) && <p className="pp-muted">当前产品没有需要区分价格的属性，使用基础主体价。</p>}
    </div>
  </Modal>
}
