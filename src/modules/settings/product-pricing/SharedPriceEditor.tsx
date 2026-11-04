import { useState } from 'react'
import { Button, Tabs } from 'antd'
import { display, getEntityId, ordered, type Bundle } from '../product-options/model'
import type { ProductPricingDocument } from './model'
import type { ConfirmAction } from './BodyPriceEditor'
import SharedAccessoryEditor from './SharedAccessoryEditor'
import SizePriceDialog from './SizePriceDialog'
import { displayPrice } from './PriceInput'
import { sharedAttributes, sharedAttributeSizes, setSharedAttributePrices, type SharedAttribute } from './sharedPrices'

type Props = { document: ProductPricingDocument; bundle: Bundle; saving: boolean; edit: (change: (document: ProductPricingDocument) => void) => void; confirm: (action: ConfirmAction) => void }
type Editing = { attribute: SharedAttribute; valueId: string; valueLabel: string }

export default function SharedPriceEditor({ document, bundle, saving, edit, confirm }: Props) {
  const [tab, setTab] = useState('techniqueId')
  const [editing, setEditing] = useState<Editing>()
  const sizes = editing ? sharedAttributeSizes(document, bundle, editing.attribute, editing.valueId) : []
  const prices = editing ? (document.sharedAttributePrices ?? []).filter(row => row[editing.attribute.field] === editing.valueId) : []
  return <section className="pp-card pp-shared-prices" aria-label="公共价格设置">
    <Tabs activeKey={tab} onChange={setTab} destroyOnHidden items={[
      ...sharedAttributes.map(attribute => ({ key: attribute.field, label: `${attribute.label}加价`, children: <section aria-label={`公共${attribute.label}加价设置`}>
        <div className="pp-shared-scope"><span>所有适用产品共用</span><small>金额单位：USD / 件</small></div>
        <div className="pp-attribute-price-scroll pp-shared-price-scroll" tabIndex={0} aria-label={`公共${attribute.label}加价表`}><table className="pp-attribute-price-table"><thead><tr><th scope="col">{attribute.label}选项</th><th scope="col">尺寸与加价</th><th scope="col">操作</th></tr></thead><tbody>
          {ordered(bundle.catalogs[attribute.file].values).map(value => {
            const valueId = getEntityId(value), valueLabel = display(value)
            const bands = sharedAttributeSizes(document, bundle, attribute, valueId)
            const rows = (document.sharedAttributePrices ?? []).filter(row => row[attribute.field] === valueId)
            const duplicateLabels = new Set(bands.filter((size, index) => bands.findIndex(other => other.label === size.label) !== index).map(size => size.label))
            return <tr key={valueId}><th scope="row">{valueLabel}<small>{attribute.field}: {valueId}</small></th><td>
              {bands.length ? <div className="pp-attribute-size-prices">{bands.map(size => {
                const price = rows.find(row => row.sizeBandId === size.sizeBandId)
                return <div key={size.sizeBandId ?? 'fixed'}><span className="pp-attribute-size-price"><span>{size.label}：</span><span className={price ? 'pp-size-amount' : 'pp-size-unpriced'}>{price ? `$${displayPrice(price.unitPrice)}` : '未定价'}</span></span>{duplicateLabels.has(size.label) && <small className="pp-shared-size-id">{size.sizeBandId}</small>}</div>
              })}</div> : <span className="pp-muted">尚无按属性加价的适用产品</span>}
            </td><td><Button type="link" disabled={saving || !bands.length} aria-label={`编辑公共${attribute.label}加价 ${valueLabel}`} onClick={() => setEditing({ attribute, valueId, valueLabel })}>编辑加价</Button></td></tr>
          })}
        </tbody></table></div>
        <p className="pp-help">尺寸来自产品选项配置。同一属性 ID、同一尺寸 ID 只维护一份价格；空白表示未定价，0 表示不加价。</p>
      </section> })),
      { key: 'accessory', label: '配件价格', children: <SharedAccessoryEditor document={document} bundle={bundle} saving={saving} edit={edit} confirm={confirm}/> },
    ]}/>
    {editing && <SizePriceDialog sizes={sizes} prices={prices} title={`${editing.valueLabel} · 加价`} priceLabel="加价" showSizeIds description={`${editing.attribute.field}: ${editing.valueId}。使用此属性及对应尺寸的产品共用以下加价；应用后加入草稿，页面保存后生效。`} signed onCancel={() => setEditing(undefined)} onApply={values => {
      const unchanged = values.length === prices.filter(price => sizes.some(size => size.sizeBandId === price.sizeBandId)).length && values.every(value => prices.some(price => price.sizeBandId === value.sizeBandId && price.unitPrice === value.unitPrice))
      if (!unchanged) edit(next => setSharedAttributePrices(next, editing.attribute.field, editing.valueId, sizes.map(size => size.sizeBandId), values))
      setEditing(undefined)
    }}/>}
  </section>
}
