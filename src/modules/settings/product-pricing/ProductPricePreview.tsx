import { useId, useState } from 'react'
import { Alert, Input, InputNumber, Select } from 'antd'
import { display, getEntityId, getProductSizes, isEnabled, optionFor, ordered, type Bundle, type Product } from '../product-options/model'
import type { QuantityPricingDocument } from '../quantity-pricing/model'
import { getPricingDimensions, getStandeeQuantityOptions, quoteProduct, type Dimensions, type PanelInput, type ProductPricing, type ProductPricingDocument } from './model'
import { optionActive, priceChoices } from './BodyPriceEditor'
import { displayPrice } from './PriceInput'

type Props = { document: ProductPricingDocument; pricing: ProductPricing; product: Product; bundle: Bundle; quantityPricing: QuantityPricingDocument; dependencyError: string }
const defaultSize = (): Dimensions => ({ widthMm: '50', heightMm: '50' })

export default function ProductPricePreview({ document, pricing, product, bundle, quantityPricing, dependencyError }: Props) {
  const first = pricing.dimensionPrices[0]
  const choices = (name: string) => priceChoices(bundle, product, name)
  const initial = (name: string, field: 'techniqueId' | 'holoFilmId' | 'materialId' | null = null) => (field ? pricing.attributePrices.find(price => price[field] && choices(name).some(value => getEntityId(value) === price[field]))?.[field] : null) ?? (choices(name)[0] ? getEntityId(choices(name)[0]) : null)
  const [techniqueId, setTechniqueId] = useState<string | null>(first?.techniqueId ?? initial('Technique', 'techniqueId'))
  const [filmId, setFilmId] = useState<string | null>(first?.holoFilmId ?? initial('Holo Film', 'holoFilmId'))
  const [materialId, setMaterialId] = useState<string | null>(first?.materialId ?? initial('Material', 'materialId'))
  const [styleId, setStyleId] = useState<string | null>(initial('Accessories Style'))
  const [colorId, setColorId] = useState<string | null>(null)
  const [sizeBandId, setSizeBandId] = useState(() => { if (pricing.pricingMode !== 'table') return ''; const sizes = getProductSizes(bundle, product); return sizes.find(size => getEntityId(size) === 'keychain-2-in')?.sizeBandId ?? sizes[0]?.sizeBandId ?? '' })
  const [quantity, setQuantity] = useState<number | null>(50)
  // InputNumber suppresses onChange for out-of-range text while it is being typed.
  const [quantityInput, setQuantityInput] = useState<string | null>(null)
  const quantityErrorId = useId()
  const quantityInvalid = quantity === null || !Number.isSafeInteger(quantity) || quantity < 1 || (quantityInput !== null && (!/^\d+$/.test(quantityInput.trim()) || Number(quantityInput) !== quantity))
  const [panelDrafts, setPanelDrafts] = useState<Record<string, PanelInput>>({})
  const [standeeDraft, setStandeeDraft] = useState<{ standeeQuantityId: string | null; parts: Dimensions[]; base: Dimensions }>(() => ({ standeeQuantityId: null, parts: [defaultSize()], base: defaultSize() }))
  const [standeeQuantityId, setStandeeQuantityId] = useState<string | null>(() => getStandeeQuantityOptions(bundle, product, { techniqueId, holoFilmId: filmId, materialId }).defaultId)
  const sizes = getProductSizes(bundle, product)
  const selectedSize = sizes.some(size => getEntityId(size) === sizeBandId) ? sizeBandId : ''
  const dimensions = getPricingDimensions(bundle, product, { techniqueId, holoFilmId: filmId, materialId })
  const available = (name: string) => dimensions.find(dimension => dimension.option === name)?.values ?? choices(name)
  const selection = (name: string, id: string | null) => optionActive(product, name) && available(name).some(value => getEntityId(value) === id) ? id : null
  const technique = selection('Technique', techniqueId)
  const film = selection('Holo Film', filmId)
  const material = selection('Material', materialId)
  const accessory = selection('Accessories Style', styleId)
  const style = available('Accessories Style').find(value => getEntityId(value) === accessory)
  const colors = ordered(style?.colors ?? []).filter(value => isEnabled(optionFor(product, 'Accessories Style'), value))
  const recipe = pricing.dimensionPrices.find(row => row.techniqueId === technique && row.holoFilmId === film && row.materialId === material)
  const composition = pricing.standeePricing?.compositions.find(row => row.techniqueId === technique && row.holoFilmId === film && row.materialId === material)
  const quantityOptions = getStandeeQuantityOptions(bundle, product, { techniqueId: technique, holoFilmId: film, materialId: material })
  const selectedCountId = (id: string | null | undefined) => quantityOptions.enabled && quantityOptions.values.some(value => getEntityId(value) === id) ? id! : null
  const panels = recipe?.panels.map(panel => {
    const draft = panelDrafts[panel.panelId]
    const id = selectedCountId(draft ? draft.standeeQuantityId : quantityOptions.defaultId)
    const count = quantityOptions.values.find(value => getEntityId(value) === id)?.pieceCount ?? 1
    return { panelId: panel.panelId, standeeQuantityId: id, parts: Array.from({ length: count }, (_, index) => draft?.parts[index] ?? defaultSize()), base: draft?.base ?? defaultSize() }
  }) ?? []
  const standeeCountId = selectedCountId(standeeDraft.standeeQuantityId ?? quantityOptions.defaultId)
  const standeeCount = quantityOptions.values.find(value => getEntityId(value) === standeeCountId)?.pieceCount ?? 1
  const standeeInput = composition ? { standeeQuantityId: standeeCountId, parts: Array.from({ length: standeeCount }, (_, index) => standeeDraft.parts[index] ?? defaultSize()), base: standeeDraft.base } : undefined
  const editPanel = (panel: PanelInput, change: (value: PanelInput) => void) => {
    setPanelDrafts(current => {
      const previous = current[panel.panelId]
      const next = structuredClone({ ...panel, ...previous, parts: Array.from({ length: Math.max(panel.parts.length, previous?.parts.length ?? 0) }, (_, index) => previous?.parts[index] ?? panel.parts[index] ?? defaultSize()) })
      change(next)
      return { ...current, [panel.panelId]: next }
    })
  }
  let quote: ReturnType<typeof quoteProduct> | undefined
  let error = ''
  try {
    if (quantityInvalid) throw new Error('购买数量必须是大于零的整数')
    if (dependencyError) throw new Error(dependencyError)
    if (pricing.pricingMode === 'standee' && !composition) throw new Error('当前属性组合尚未生成新的立牌价格组成')
    quote = quoteProduct(document, bundle, quantityPricing, { productId: product.productId, sizeBandId: selectedSize, techniqueId: technique, holoFilmId: film, materialId: material, accessoryStyleId: accessory, accessoryColorId: accessory ? colorId : null, quantity: quantity ?? 0, panelInputs: composition ? undefined : panels, standee: standeeInput, standeeQuantityId: pricing.pricingMode === 'standee' ? null : selectedCountId(standeeQuantityId) })
  } catch (failure) { error = String(failure).replace(/^Error: /, '') }
  const picker = (name: string, label: string, value: string | null, change: (value: string | null) => void) => optionActive(product, name) && available(name).length > 0 && <label>{label}<Select aria-label={`试算${label}`} placeholder={`请选择${label}`} allowClear value={value ?? undefined} onChange={value => change(value ?? null)} options={available(name).map(value => ({ value: getEntityId(value), label: display(value) }))}/></label>
  const countPicker = (label: string, value: string | null | undefined, change: (value: string) => void) => <label className="pp-piece-count">主体片数<Select aria-label={label} placeholder="请选择主体片数" value={selectedCountId(value) ?? undefined} onChange={change} options={quantityOptions.values.map(value => ({ value: getEntityId(value), label: display(value) }))}/></label>

  const priceParts = quote ? [
    { label: pricing.pricingMode === 'standee' ? '立牌组合单价' : '主体基本单价', value: quote.bodyUnitPrice },
    ...(pricing.pricingMode === 'standee' ? [] : [
      { name: 'Technique', label: '工艺加价', value: quote.techniqueUnitPrice },
      { name: 'Holo Film', label: '全息膜加价', value: quote.holoFilmUnitPrice },
      { name: 'Material', label: '材质加价', value: quote.materialUnitPrice },
    ].filter(part => optionActive(product, part.name))),
    { label: '配件单价', value: quote.accessoryUnitPrice },
  ] : []

  return <section className="pp-card" aria-label="产品价格试算"><h4>价格试算</h4><div className="pp-preview-fields">
    {(pricing.pricingMode === 'table' || optionActive(product, 'Size')) && <label>尺寸<Select aria-label="试算尺寸" placeholder={sizes.length ? '请选择尺寸' : '请先在产品选项配置中启用尺寸'} value={selectedSize || undefined} onChange={setSizeBandId} options={sizes.map(size => ({ value: getEntityId(size), label: display(size) }))}/></label>}
    {picker('Technique', '工艺', technique, setTechniqueId)}
    {picker('Holo Film', '全息膜', film, setFilmId)}
    {picker('Material', '材质', material, setMaterialId)}
    {picker('Accessories Style', '配件样式', accessory, value => { setStyleId(value); setColorId(null) })}
    {quantityOptions.enabled && pricing.pricingMode !== 'standee' && countPicker('试算主体片数', standeeQuantityId, setStandeeQuantityId)}
    {quantityOptions.enabled && pricing.pricingMode === 'standee' && composition && countPicker('试算主体片数', standeeDraft.standeeQuantityId ?? quantityOptions.defaultId, value => setStandeeDraft(current => ({ ...current, standeeQuantityId: value })))}
    {!!colors.length && <label>配件颜色<Select aria-label="试算配件颜色" placeholder={document.accessoryPricing === 'color' ? '请选择颜色' : '颜色不加价'} allowClear value={colorId ?? undefined} onChange={value => setColorId(value ?? null)} options={colors.map(value => ({ value: getEntityId(value), label: display(value) }))}/></label>}
    <label>购买数量<InputNumber aria-label="试算购买数量" aria-invalid={quantityInvalid} aria-describedby={quantityInvalid ? quantityErrorId : undefined} status={quantityInvalid ? 'error' : undefined} min={1} max={Number.MAX_SAFE_INTEGER} precision={0} value={quantity} onInput={setQuantityInput} onChange={value => { setQuantity(value); setQuantityInput(null) }} onBlur={() => setQuantityInput(null)} onPressEnter={() => setQuantityInput(null)}/></label>
  </div>
    {composition ? <div className="pp-preview-panels"><fieldset><legend>主体尺寸（mm）</legend>
      <p className="pp-help">主体、工艺、全息膜和材质组成使用同一组片材尺寸；底座只计算一次。</p>
      {standeeInput?.parts.map((part, partIndex) => <div className="pp-preview-part" key={partIndex}><span>片材 {partIndex + 1}</span><DimensionsInput label={`立牌片材${partIndex + 1}`} value={part} change={value => setStandeeDraft(current => ({ ...current, parts: current.parts.map((item, index) => index === partIndex ? value : item) }))}/></div>)}
      <div className="pp-preview-part"><span>底座</span><DimensionsInput label="立牌底座" value={standeeInput?.base ?? defaultSize()} change={value => setStandeeDraft(current => ({ ...current, base: value }))}/></div>
    </fieldset></div> : pricing.pricingMode === 'standee' ? <Alert type="info" showIcon message="当前属性组合尚未生成新的立牌价格组成" description="请先完成产品定价中的主体、工艺、全息膜、材质组成和组合映射。"/> : recipe && <div className="pp-preview-panels">{panels.map((panel, index) => <fieldset key={panel.panelId}><legend>{recipe.panels[index].label}（mm）</legend>
      {quantityOptions.enabled && countPicker(`${recipe.panels[index].label}主体片数`, panel.standeeQuantityId, value => editPanel(panel, next => { next.standeeQuantityId = value }))}
      <p className="pp-help">{quantityOptions.enabled ? `本组 ${panel.parts.length} 片主体，分别填写尺寸；底座只计算一次。片数选项在产品属性中设置。` : '主体片数属性未开启，按 1 片主体计算。'}</p>
      {panel.parts.map((part, partIndex) => <div className="pp-preview-part" key={partIndex}><span>片材 {partIndex + 1}</span><DimensionsInput label={`${recipe.panels[index].label}片材${partIndex + 1}`} value={part} change={value => editPanel(panel, next => { next.parts[partIndex] = value })}/></div>)}
      <div className="pp-preview-part"><span>底座</span><DimensionsInput label={`${recipe.panels[index].label}底座`} value={panel.base} change={value => editPanel(panel, next => { next.base = value })}/></div>
    </fieldset>)}</div>}
    {error ? <Alert id={quantityInvalid ? quantityErrorId : undefined} type="warning" showIcon message={error}/> : quote && <div className="pp-quote" aria-live="polite">
      <dl>{priceParts.map(part => <div key={part.label}><dt>{part.label}</dt><dd title={part.value}>${displayPrice(part.value)}</dd></div>)}<div><dt>折扣前单价</dt><dd title={quote.unitPrice}>${displayPrice(quote.unitPrice)}</dd></div><div><dt>大类数量折扣</dt><dd>减价 {quote.discountPercent}%{!quote.quantityTierId && '（未命中阶梯）'}</dd></div><div><dt>折后单价</dt><dd title={quote.discountedUnitPrice}>${displayPrice(quote.discountedUnitPrice)}</dd></div></dl>
      <section className="pp-formula" aria-label="总价计算公式">
        <h5>总价计算公式</h5>
        {composition && <p>{`立牌主体 = 基础金额 ${composition.groups.flatMap(group => group.componentIds).map(id => `+ ${id}`).join(' ')}`}</p>}
        <p>{`总额 =（${priceParts.map(part => part.label).join(' + ')}）×（1 − 减价比例）× 购买数量`}</p>
        <p className="pp-formula-values">{`（${priceParts.map(part => part.value.startsWith('-') ? `（${part.value}）` : part.value).join(' + ')}）×（1 − ${quote.discountPercent}%）× ${quantity} ≈ ${quote.totalPrice} USD`}</p>
        <small>公式代入完整单价，最终总额四舍五入到分；更改选项或数量后自动更新。</small>
      </section>
      <div className="pp-total"><span>试算总额</span><strong>${quote.totalPrice}</strong></div>
    </div>}
    <p className="pp-help">使用当前价表与公共价格草稿，以及已保存的大类阶梯。{pricing.pricingMode === 'standee' ? '立牌组合单价与配件合计后打折。' : '主体基本价、所选属性加价与配件合计后打折，每项只计入一次。'}再乘购买数量，总额四舍五入到分，计算保留完整单价精度。此处为配置试算。</p>
  </section>
}

function DimensionsInput({ label, value, change }: { label: string; value: Dimensions; change: (value: Dimensions) => void }) {
  return <><label>宽<Input aria-label={`${label}宽`} inputMode="decimal" value={value.widthMm} onChange={event => change({ ...value, widthMm: event.target.value })}/></label><span>×</span><label>高<Input aria-label={`${label}高`} inputMode="decimal" value={value.heightMm} onChange={event => change({ ...value, heightMm: event.target.value })}/></label></>
}
