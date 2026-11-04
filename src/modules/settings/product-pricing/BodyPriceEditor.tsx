import { useState } from 'react'
import { Alert, Button, Input, Modal, Radio } from 'antd'
import { catalogFor, display, getEntityId, getProductSizes, isEnabled, optionFor, ordered, type Bundle, type Product } from '../product-options/model'
import { getPricingDimensions, type AttributePrice, type DimensionPrice, type ProductPricing, type ProductPricingDocument, type PriceSelections } from './model'
import { priceGroupKey, priceSelections } from './priceGroups'
import PriceInput, { displayPrice } from './PriceInput'
import PriceCombinationDialog, { type CombinationDraft } from './PriceCombinationDialog'
import SizePriceDialog, { type SizePriceValue } from './SizePriceDialog'
import DimensionPriceDialog from './DimensionPriceDialog'

export type ConfirmAction = { title: string; description: string; apply: () => void }
export const priceChoices = (bundle: Bundle, product: Product, name: string) => {
  const option = optionFor(product, name)
  return option && !option.deleted ? ordered(catalogFor(bundle, product, name).values).filter(value => isEnabled(option, value)) : []
}
export const optionActive = (product: Product, name: string) => !!optionFor(product, name) && !optionFor(product, name)!.deleted
type Props = { pricing: ProductPricing; product: Product; bundle: Bundle; saving: boolean; canSaveBase: boolean; saveBase: () => void; edit: (change: (document: ProductPricingDocument) => void) => void; confirm: (action: ConfirmAction) => void }
const attributes = [
  { name: 'Technique', field: 'techniqueId', label: '工艺' },
  { name: 'Holo Film', field: 'holoFilmId', label: '全息膜' },
  { name: 'Material', field: 'materialId', label: '材质' },
] as const
type Attribute = typeof attributes[number]
type EditingPrices = { valueId: string; valueLabel: string }
const samePrices = (left: SizePriceValue[], right: SizePriceValue[]) => left.length === right.length && left.every(a => right.some(b => a.sizeBandId === b.sizeBandId && a.unitPrice === b.unitPrice))

export default function BodyPriceEditor({ pricing, product, bundle, saving, canSaveBase, saveBase, edit, confirm }: Props) {
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<EditingPrices>()
  const [combination, setCombination] = useState<{ row: CombinationDraft; mode: 'new' | 'attributes' }>()
  const [dimensionDraft, setDimensionDraft] = useState<DimensionPrice>()
  const [sizingMode, setSizingMode] = useState<ProductPricing['pricingMode']>()
  const columns = attributes.filter(attribute => optionActive(product, attribute.name))
  const sizes = pricing.pricingMode === 'fixed' ? [{ sizeBandId: null, label: '所有尺寸' }] : getProductSizes(bundle, product, Object.fromEntries(product.productOptions.map(option => [option.name, '']))).map(size => ({ sizeBandId: getEntityId(size), label: display(size) }))
  const editProduct = (change: (pricing: ProductPricing) => void) => edit(next => change(next.products.find(item => item.productId === product.productId)!))
  const materialPrices = (id: string) => pricing.attributePrices.filter(price => price.materialId === id)
  const editPrices = editing ? materialPrices(editing.valueId) : []
  const editBasePrice = (sizeBandId: string, unitPrice: string) => editProduct(next => {
    const row = next.basePrices.find(price => price.sizeBandId === sizeBandId)
    if (!unitPrice.trim()) next.basePrices = next.basePrices.filter(price => price.sizeBandId !== sizeBandId)
    else if (row) row.unitPrice = unitPrice
    else next.basePrices.push({ basePriceId: `base-${crypto.randomUUID()}`, sizeBandId, unitPrice })
  })
  const applyPrices = (values: SizePriceValue[]) => {
    if (!editing) return
    if (samePrices(editPrices.filter(price => sizes.some(size => size.sizeBandId === price.sizeBandId)), values)) { setEditing(undefined); return }
    const { valueId } = editing
    editProduct(next => {
      const previous = next.attributePrices.filter(price => price.materialId === valueId)
      const replacements: AttributePrice[] = values.map(value => ({ attributePriceId: previous.find(price => price.sizeBandId === value.sizeBandId)?.attributePriceId ?? `attribute-${crypto.randomUUID()}`, techniqueId: null, holoFilmId: null, materialId: valueId, ...value }))
      next.attributePrices = [...next.attributePrices.filter(price => price.materialId !== valueId || !sizes.some(size => size.sizeBandId === price.sizeBandId)), ...replacements]
    })
    setEditing(undefined)
  }
  const startCombination = () => {
    const row: CombinationDraft = { productPriceId: `price-${crypto.randomUUID()}`, techniqueId: null, holoFilmId: null, materialId: null, unitPrice: '' }
    for (const dimension of getPricingDimensions(bundle, product, row)) if (dimension.required) row[dimension.field] = ordered(dimension.values)[0] ? getEntityId(ordered(dimension.values)[0]) : null
    for (const dimension of getPricingDimensions(bundle, product, row)) if (!dimension.required || !dimension.values.some(value => getEntityId(value) === row[dimension.field])) row[dimension.field] = null
    setCombination({ row, mode: 'new' })
  }
  const applyCombination = (row: CombinationDraft) => {
    const old = pricing.dimensionPrices.find(price => price.productPriceId === row.productPriceId)
    if (old) {
      if (priceGroupKey(old) !== priceGroupKey(row)) editProduct(next => Object.assign(next.dimensionPrices.find(price => price.productPriceId === row.productPriceId)!, priceSelections(row)))
    } else setDimensionDraft({ productPriceId: row.productPriceId, ...priceSelections(row), baseUnitPrice: row.unitPrice, panels: [] })
    setCombination(undefined)
  }
  const applyDimensions = (recipe: DimensionPrice) => {
    editProduct(next => {
      const old = next.dimensionPrices.find(item => item.productPriceId === recipe.productPriceId)
      if (old) Object.assign(old, recipe)
      else next.dimensionPrices.push(recipe)
    })
    setDimensionDraft(undefined)
  }
  const attributeLabel = (row: PriceSelections, column: Attribute) => row[column.field] === null ? '不适用' : display(priceChoices(bundle, product, column.name).find(value => getEntityId(value) === row[column.field]) ?? { name: `已失效：${row[column.field]}` })
  const dimensionSummary = (row: DimensionPrice) => row.panels.map(panel => {
    const ranges = [...panel.pieceBands, ...panel.baseBands]
    return `${panel.label}：${ranges.length ? `${Math.min(...ranges.map(range => Number(range.minMm)))}–${Math.max(...ranges.map(range => Number(range.maxMm)))} mm` : '未设尺寸'}（片材 ${panel.pieceBands.length} 档 / 底座 ${panel.baseBands.length} 档）`
  }).join('；')
  const visibleDimensions = pricing.dimensionPrices.filter(row => [dimensionSummary(row), ...columns.map(column => attributeLabel(row, column))].join(' ').toLowerCase().includes(search.trim().toLowerCase()))
  const sizingButton = <Button disabled={saving} onClick={() => setSizingMode(pricing.pricingMode)}>尺寸计价设置</Button>

  return <div className="pp-price-sections">
    {pricing.pricingMode === 'standee' ? <section className="pp-card pp-body-editor" aria-label="立牌组合价格表">
      <div className="pp-section-heading"><h4>立牌组合计价</h4><div className="pp-actions">{sizingButton}<Button type="primary" disabled={saving} onClick={startCombination}>新增价格组合</Button></div></div>
      <div className="pp-row-toolbar"><Input aria-label="筛选价格组合" placeholder="搜索工艺、膜、材质或尺寸" allowClear value={search} onChange={event => setSearch(event.target.value)}/><span>{visibleDimensions.length} 个属性组合</span></div>
      <div className="pp-price-table-scroll" aria-label="可滚动主体价格表" tabIndex={0}><table className="pp-combination-table"><thead><tr><th scope="col">尺寸与组合价格（USD）</th>{columns.map(column => <th scope="col" key={column.field}>{column.label}</th>)}<th scope="col">操作</th></tr></thead><tbody>
        {visibleDimensions.map((row, index) => <tr key={row.productPriceId}><td><Button type="link" className="pp-size-link" aria-label={`编辑长宽计价 ${index + 1}`} disabled={saving} onClick={() => setDimensionDraft(row)}>${displayPrice(row.baseUnitPrice)} 固定金额＋尺寸费用</Button><small>{dimensionSummary(row)}</small></td>
          {columns.map(column => <td key={column.field}><span className="pp-attribute-value">{attributeLabel(row, column)}</span></td>)}<td><div className="pp-row-actions">{!!columns.length && <Button type="text" disabled={saving} aria-label={`编辑长宽属性 ${index + 1}`} onClick={() => setCombination({ row: { ...priceSelections(row), productPriceId: row.productPriceId, unitPrice: row.baseUnitPrice }, mode: 'attributes' })}>编辑属性</Button>}<Button type="text" danger disabled={saving} aria-label={`删除长宽组合 ${index + 1}`} onClick={() => confirm({ title: '删除这组主体价格？', description: '删除后该立牌属性组合将变为未定价。', apply: () => editProduct(next => { next.dimensionPrices = next.dimensionPrices.filter(price => price.productPriceId !== row.productPriceId) }) })}>删除</Button></div></td>
        </tr>)}
      </tbody></table>{!visibleDimensions.length && <p className="pp-empty">{search ? '没有匹配的价格组合' : '暂无尺寸计价配方。'}</p>}</div>
    </section> : <>
      <section className="pp-card pp-body-editor" aria-label="主体基本价格">
        <div className="pp-section-heading"><h4>主体基本价</h4>{sizingButton}</div>
        <p className="pp-help">这里只填写产品本身的基本价。工艺、全息膜和配件在“公共价格”中统一维护。{optionActive(product, 'Material') && '材质加价在下方单独填写。'}</p>
        {pricing.pricingMode === 'fixed' ? <div className="pp-fixed-price"><label>主体基本单价（USD / 件）<PriceInput label="固定主体基本价" value={pricing.fixedUnitPrice ?? ''} disabled={saving} onChange={value => editProduct(next => { next.fixedUnitPrice = value.trim() ? value : null })}/></label></div> : !sizes.length ? <div className="pp-empty"><p>请先在产品选项配置 → 产品属性 → 尺寸中启用尺寸，再填写主体基本价和属性加价。</p></div> : <>
          <p className="pp-muted">{sizes.length} 个尺寸 · {pricing.basePrices.filter(price => sizes.some(size => size.sizeBandId === price.sizeBandId)).length} 个已定基本价</p>
          <div className="pp-inline-base-prices"><table className="pp-size-prices-table" aria-label="主体基本价表"><thead><tr><th scope="col">产品尺寸</th><th scope="col">主体基本价（USD / 件）</th></tr></thead><tbody>
            {sizes.map(size => <tr key={size.sizeBandId}><th scope="row">{size.label}</th><td><PriceInput label={`${size.label} 主体基本价`} value={pricing.basePrices.find(price => price.sizeBandId === size.sizeBandId)?.unitPrice ?? ''} disabled={saving} onChange={value => { if (size.sizeBandId !== null) editBasePrice(size.sizeBandId, value) }}/></td></tr>)}
          </tbody></table></div>
        </>}
        {(pricing.pricingMode === 'fixed' || !!sizes.length) && <div className="pp-base-save"><p className="pp-help">显示 4 位小数，点击输入框可编辑完整精度。空白表示未定价，0 表示不收费。<br/>保存基本价仅保存当前产品的基本价；其他定价修改可通过页面上方“保存”提交。</p><Button type="primary" loading={saving} disabled={saving || !canSaveBase} onClick={saveBase}>保存基本价</Button></div>}
      </section>
      {optionActive(product, 'Material') && <section className="pp-card pp-attribute-prices" aria-label="材质加价设置">
        <h4>材质加价</h4>
        <p className="pp-help">各尺寸加价如下，仅对当前产品所选材质加价一次。0 表示不加价，“未定价”表示尚未填写。</p>
        <div className="pp-attribute-price-scroll" tabIndex={0} aria-label="材质加价表"><table className="pp-attribute-price-table"><thead><tr><th scope="col">材质选项</th><th scope="col">尺寸与加价（USD）</th><th scope="col">操作</th></tr></thead><tbody>
          {priceChoices(bundle, product, 'Material').map(value => {
            const valueId = getEntityId(value); const valueLabel = display(value); const prices = materialPrices(valueId)
            return <tr key={valueId}><th scope="row"><span className="pp-attribute-value">{valueLabel}</span></th><td><strong>{prices.filter(price => sizes.some(size => size.sizeBandId === price.sizeBandId)).length} / {sizes.length} 个尺寸已定价</strong><small className="pp-attribute-size-prices">{sizes.map(size => {
              const price = prices.find(row => row.sizeBandId === size.sizeBandId)
              return <span className="pp-attribute-size-price" key={size.sizeBandId ?? 'fixed'}><span>{size.label}：</span><span className={price ? 'pp-size-amount' : 'pp-size-unpriced'}>{price ? `$${displayPrice(price.unitPrice)}` : '未定价'}</span></span>
            })}</small></td><td><Button type="link" disabled={saving || !sizes.length} aria-label={`编辑材质加价 ${valueLabel}`} onClick={() => setEditing({ valueId, valueLabel })}>设置材质加价</Button></td></tr>
          })}
        </tbody></table></div>
      </section>}
      {!!pricing.legacyBodyPrices.length && <Alert type="warning" showIcon message={`有 ${pricing.legacyBodyPrices.length} 条旧组合价格尚待拆分`} description="这些记录已保留但不参与试算。请先填写对应的主体基本价与属性加价，再清理旧记录。" action={<Button disabled={saving} onClick={() => confirm({ title: '清理保留的旧组合价格？', description: '请确认已完成基本价与属性加价配置。旧组合记录将从当前草稿移除，原文件备份保留。', apply: () => editProduct(next => { next.legacyBodyPrices = [] }) })}>清理旧记录</Button>}/>}
      {optionActive(product, 'Print Option') && <p className="pp-help">印刷选项沿用原有同价设置，已包含在基本价中。</p>}
    </>}
    {editing && <SizePriceDialog sizes={sizes} prices={editPrices} title={`材质加价 · ${editing.valueLabel}`} priceLabel="材质加价" description={`仅填写当前产品“${editing.valueLabel}”的材质加价，报价时与主体基本价相加。`} signed onApply={applyPrices} onCancel={() => setEditing(undefined)}/>}
    {combination && <PriceCombinationDialog pricing={pricing} product={product} bundle={bundle} initial={combination.row} mode={combination.mode} onApply={applyCombination} onCancel={() => setCombination(undefined)}/>}
    {dimensionDraft && <DimensionPriceDialog recipe={dimensionDraft} onApply={applyDimensions} onCancel={() => setDimensionDraft(undefined)}/>}
    {sizingMode && <Modal title="尺寸计价设置" open okText={sizingMode === pricing.pricingMode ? '完成' : '确认更改并重新填写'} cancelText="取消" maskClosable={false} onCancel={() => setSizingMode(undefined)} onOk={() => {
      if (sizingMode !== pricing.pricingMode) editProduct(next => { next.pricingMode = sizingMode; next.fixedUnitPrice = null; next.basePrices = []; next.attributePrices = []; next.legacyBodyPrices = []; next.dimensionPrices = [] })
      setSizingMode(undefined)
    }}><p className="pp-help">选择产品的尺寸计价方式。固定尺寸产品分别维护基本价和属性加价。</p><Radio.Group aria-label="尺寸如何影响价格" className="pp-sizing-options" value={sizingMode} onChange={event => setSizingMode(event.target.value)}>
      <Radio value="fixed"><strong>尺寸不影响价格</strong><small>填写统一基本价，各属性另设统一加价。</small></Radio>
      <Radio value="table"><strong>不同尺寸分别填写价格</strong><small>基本价与各属性加价分别按产品尺寸填写。</small></Radio>
      <Radio value="standee"><strong>按片材和底座长宽计算</strong><small>根据主体片数逐片计算尺寸费用，每个尺寸组的底座计价一次。</small></Radio>
    </Radio.Group>{sizingMode !== pricing.pricingMode && <Alert type="warning" showIcon message="更改后需要重新填写该产品的价格" description="该产品的基本价、材质加价及尺寸配方会清空；工艺、全息膜和配件公共价格保留。"/>}</Modal>}
  </div>
}
