import { useState } from 'react'
import { Select } from 'antd'
import { display, getEntityId, ordered, type Bundle } from '../product-options/model'
import type { ProductPricingDocument } from './model'
import type { ConfirmAction } from './BodyPriceEditor'
import PriceInput from './PriceInput'

export default function SharedAccessoryEditor({ document, bundle, saving, edit, confirm }: { document: ProductPricingDocument; bundle: Bundle; saving: boolean; edit: (change: (document: ProductPricingDocument) => void) => void; confirm: (action: ConfirmAction) => void }) {
  const styles = ordered(bundle.catalogs['accessory-styles.json'].values)
  const [styleId, setStyleId] = useState(styles[0] ? getEntityId(styles[0]) : '')
  const selected = styles.find(style => getEntityId(style) === styleId) ?? styles[0]
  const rows = document.accessoryPricing === 'style' ? styles.map(style => ({ styleId: getEntityId(style), colorId: null, label: display(style) })) : ordered(selected?.colors ?? []).map(color => ({ styleId: getEntityId(selected!), colorId: getEntityId(color), label: display(color) }))
  const changePrice = (styleId: string, colorId: string | null, unitPrice: string) => edit(next => {
    const row = next.accessoryPrices.find(row => row.accessoryStyleId === styleId && row.accessoryColorId === colorId)
    if (!unitPrice.trim()) next.accessoryPrices = next.accessoryPrices.filter(price => price !== row)
    else if (row) row.unitPrice = unitPrice
    else next.accessoryPrices.push({ accessoryPriceId: `accessory-${crypto.randomUUID()}`, accessoryStyleId: styleId, accessoryColorId: colorId, unitPrice })
  })
  return <section className="pp-card" aria-label="配件公共价格表"><div className="pp-section-heading"><h4>全产品共用配件价格（USD / 件）</h4><Select aria-label="配件计价方式" value={document.accessoryPricing} disabled={saving} options={[{ value: 'style', label: '按配件样式' }, { value: 'color', label: '按样式及颜色' }]} onChange={(mode: ProductPricingDocument['accessoryPricing']) => confirm({ title: '切换公共配件计价方式？', description: '所有产品共用的配件价格将清空，请填写新的价表。主体价格不受影响。', apply: () => edit(next => { next.accessoryPricing = mode; next.accessoryPrices = [] }) })}/></div>
    <p className="pp-help">这里设置一次，所有启用配件的产品共同使用。按样式计价时颜色不重复收费；空白为未定价，0 为免费。</p>
    {document.accessoryPricing === 'color' && <label className="pp-color-picker">配件样式<Select aria-label="配件价表样式" value={selected && getEntityId(selected)} disabled={saving} onChange={setStyleId} options={styles.map(style => ({ value: getEntityId(style), label: display(style) }))}/></label>}
    <div className="pp-table-wrap pp-price-table-scroll"><table className="pp-accessory-table"><thead><tr><th scope="col">{document.accessoryPricing === 'style' ? '配件样式' : '配件颜色'}</th><th scope="col">公共单件附加价</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.styleId}:${row.colorId ?? ''}`}><th scope="row">{row.label}<small>{row.colorId ?? row.styleId}</small></th><td><PriceInput label={`${row.label} 配件价`} value={document.accessoryPrices.find(price => price.accessoryStyleId === row.styleId && price.accessoryColorId === row.colorId)?.unitPrice ?? ''} disabled={saving} onChange={value => changePrice(row.styleId, row.colorId, value)}/></td></tr>)}</tbody></table>{!rows.length && <p className="pp-empty">此样式没有配置颜色。</p>}</div>
    <p className="pp-help">共有 {document.accessoryPrices.length} 项公共配件价格，统一用于所有启用对应配件的产品。</p>
  </section>
}
