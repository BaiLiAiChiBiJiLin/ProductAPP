import { displayPricingMessage } from './formulaDisplay'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal, Select, Spin } from 'antd'
import { definitions, display, sameEntity, type EntityReference } from '../product-options/model'
import { cloneDocument, validateDocument, validateReferences, type ProductPricingDocument } from './model'
import { createAreaPricing, getAreaPricingCategories, type AreaPricingDocument } from './areaPricing'
import ProductBasePriceEditor from './ProductBasePriceEditor'
import AreaAttributeEditor from './AreaAttributeEditor'
import AreaTemplateEditor from './AreaTemplateEditor'
import AreaPricePreview from './AreaPricePreview'
import { loadProductPricing, saveProductPricing, type Snapshot } from './service'
import './product-pricing.css'
import './area-pricing.css'

type Props = { active?: boolean; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void }
const fingerprint = (document: ProductPricingDocument) => JSON.stringify(document, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
const message = (failure: unknown) => displayPricingMessage(String(failure).replace(/^Error: /, ''))

export default function ProductPricingSettings({ active = true, onBusyChange, onDirtyChange }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [document, setDocument] = useState<ProductPricingDocument>()
  const [productId, setProductId] = useState('P31')
  const [categoryId, setCategoryId] = useState('keychains')
  const [tab, setTab] = useState('templates')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dependencyError, setDependencyError] = useState('')
  const [refreshOpen, setRefreshOpen] = useState(false)
  const busy = useRef(false)
  const dirtyRef = useRef(false)
  const mounted = useRef(true)
  const draft = useRef<ProductPricingDocument | undefined>(undefined)
  const baseline = useRef<Snapshot | undefined>(undefined)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  const load = useCallback(async (preserveDraft = false) => {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    setError('')
    try {
      const value = await loadProductPricing()
      if (!mounted.current) return
      if (preserveDraft && draft.current && baseline.current) {
        if (fingerprint(value.document) === fingerprint(baseline.current.document)) {
          baseline.current = value
          setSnapshot(value)
          setDependencyError('')
        } else {
          setSnapshot({ ...value, version: baseline.current.version })
          setDependencyError('产品价表已在其他窗口修改。当前草稿已保留，请先保留需要的价格，再刷新价表。')
        }
      } else {
        baseline.current = value
        draft.current = value.document
        setSnapshot(value)
        setDocument(value.document)
        dirtyRef.current = false
        setDirty(false)
        setDependencyError('')
        setNotice('')
      }
    } catch (failure) {
      if (mounted.current) {
        setError(message(failure))
        if (baseline.current) setDependencyError('未能读取最新产品和价格阶梯，已暂停保存及试算。草稿仍保留，请重新核对。')
      }
    } finally {
      busy.current = false
      if (mounted.current) setLoading(false)
    }
  }, [])
  useEffect(() => { if (active) void load(dirtyRef.current) }, [active, load])

  const edit = (change: (area: AreaPricingDocument) => void) => {
    if (busy.current || draft.current?.areaPricing?.schemaVersion !== 7) return
    const next = cloneDocument(draft.current)
    if (next.areaPricing?.schemaVersion !== 7) return
    change(next.areaPricing)
    draft.current = next
    dirtyRef.current = true
    setDocument(next)
    setDirty(true)
    setError('')
    setNotice('')
  }
  const save = async () => {
    if (busy.current || !draft.current || !snapshot || dependencyError) return
    try { validateDocument(draft.current); validateReferences(draft.current, snapshot.bundle) }
    catch (failure) { setError(message(failure)); return }
    busy.current = true
    setSaving(true)
    onBusyChange?.(true)
    setError('')
    setNotice('')
    try {
      const value = await saveProductPricing(draft.current, snapshot.version)
      if (!mounted.current) return
      baseline.current = value
      draft.current = value.document
      setSnapshot(value)
      setDocument(value.document)
      dirtyRef.current = false
      setDirty(false)
      setNotice('产品定价已保存')
    } catch (failure) { if (mounted.current) setError(message(failure)) }
    finally { busy.current = false; onBusyChange?.(false); if (mounted.current) setSaving(false) }
  }
  if (loading) return <div className="pp-loading"><Spin/> 正在加载产品定价…</div>
  if (document?.areaPricing?.schemaVersion !== 7 || !snapshot) return <Alert type="error" showIcon message={error || '产品定价加载失败'} action={<Button onClick={() => void load()}>重试</Button>}/>
  const area = document.areaPricing
  const categories = getAreaPricingCategories(snapshot.bundle)
  const category = categories.find(item => item.categoryId === categoryId) ?? categories[0]
  const products = snapshot.bundle.main.categories.find(item => item.name === category?.categoryId)?.products ?? []
  const product = products.find(item => item.productId === productId) ?? products[0]
  const pricing = area.categories.find(item => item.categoryId === category?.categoryId)
  const chooseCategory = (id: string) => {
    setCategoryId(id)
    const nextProducts = snapshot.bundle.main.categories.find(item => item.name === id)?.products ?? []
    setProductId(current => nextProducts.some(item => item.productId === current) ? current : nextProducts[0]?.productId ?? '')
  }
  let validationError = ''
  try { validateDocument(document); validateReferences(document, snapshot.bundle) } catch (failure) { validationError = message(failure) }
  const cleanRemovedReferences = () => {
    const available = createAreaPricing(snapshot.bundle)
    edit(next => {
      next.categories = next.categories.filter(item => available.categories.some(valid => valid.categoryId === item.categoryId))
      next.productOverrides = next.productOverrides.filter(row => snapshot.bundle.main.categories.some(category => category.products.some(product => product.productId === row.productId)))
      next.productTotalFormulas = next.productTotalFormulas.filter(row => snapshot.bundle.main.categories.some(category => category.products.some(product => product.productId === row.productId)))
      const validAttribute = (item: { optionName: string; reference: EntityReference }) => {
        const file = definitions.find(definition => definition.name === item.optionName)?.file
        return file && snapshot.bundle.catalogs[file]?.values.some(value => sameEntity(value, item.reference))
      }
      for (const plan of next.additionalPricePlans) plan.prices = plan.prices.filter(validAttribute)
      const planExists = (id: string | null) => id === null || next.additionalPricePlans.some(plan => plan.additionalPricePlanId === id)
      next.categoryAdditionalPlanBindings = next.categoryAdditionalPlanBindings.filter(row => next.categories.some(category => category.categoryId === row.categoryId) && planExists(row.additionalPricePlanId))
      next.productAdditionalPlanOverrides = next.productAdditionalPlanOverrides.filter(row => snapshot.bundle.main.categories.some(category => category.products.some(product => product.productId === row.productId)) && planExists(row.additionalPricePlanId))
      if (next.accessoryPrices) next.accessoryPrices = next.accessoryPrices.filter(item => available.accessoryPrices?.some(valid => valid.accessoryStyleId === item.accessoryStyleId && valid.accessoryColorId === item.accessoryColorId))
    })
  }
  const tabs = [{ id: 'templates', label: '产品价格模板' }, { id: 'attributes', label: '产品属性价格' }, { id: 'body', label: '产品基础单价' }, { id: 'preview', label: '价格试算' }]
  return <div className="product-pricing-settings area-pricing-settings" aria-busy={saving}>
    <div className="pp-header"><div><h3>产品定价</h3><p>设置档位模板和独立产品属性价格方案，为产品选择后，在价格试算中配置总价公式。金额单位 USD。</p></div><div className="pp-actions">
      <Button disabled={saving} onClick={() => dirty ? setRefreshOpen(true) : void load()}>刷新</Button>
      <Button type="primary" loading={saving} disabled={saving || !dirty || !!validationError || !!dependencyError} onClick={() => void save()}>保存</Button>
    </div></div>
    {error && <Alert type="error" showIcon message={error}/>}
    {notice && <Alert type="success" showIcon message={notice}/>}
    {dependencyError && <Alert type="warning" showIcon message={dependencyError} action={<Button disabled={saving} onClick={() => void load(dirtyRef.current)}>重新核对</Button>}/>}
    <div className="pp-status"><span>{dirty ? '有未保存的修改。' : '配置已同步。'}</span><span title={snapshot.directory}>{snapshot.directory}</span></div>
    <div className={`pp-scroll${tab === 'preview' ? ' area-preview-scroll' : ''}`}>
      {validationError && <Alert type="error" showIcon message={validationError} action={validationError.includes('已不存在') || validationError.includes('尚未归属产品大类') ? <Button onClick={cleanRemovedReferences}>清理失效价格</Button> : undefined}/>}
      <div className="pp-tabs" role="tablist" aria-label="产品定价内容">{tabs.map(item => <Button key={item.id} role="tab" aria-selected={tab === item.id} type={tab === item.id ? 'primary' : 'default'} disabled={saving} onClick={() => setTab(item.id)}>{item.label}</Button>)}</div>
      {tab === 'preview' && <section className="pp-product area-category-context">
        <label>产品大类<Select aria-label="定价大类" showSearch optionFilterProp="label" value={category?.categoryId} disabled={saving} placeholder="请先配置产品大类" onChange={chooseCategory} options={categories.map(item => ({ value: item.categoryId, label: item.title }))}/></label>
        <label>选择产品（本大类 {products.length} 个）<Select aria-label="定价产品" showSearch optionFilterProp="label" value={product?.productId} disabled={saving || !products.length} placeholder="本大类暂无产品" onChange={setProductId} options={products.map(item => ({ value: item.productId, label: display(item) + ' · ' + item.productId }))}/></label>
        <div><strong>{category?.title ?? '暂无产品大类'}</strong><span>属性按当前产品启用项显示</span></div>
      </section>}
      {tab === 'templates' && <AreaTemplateEditor document={area} disabled={saving} onChange={edit}/>}
      {category && tab === 'body' && <ProductBasePriceEditor document={area} bundle={snapshot.bundle} categoryId={category.categoryId} onCategoryChange={chooseCategory} disabled={saving} onChange={edit}/>}
      {tab === 'attributes' && <AreaAttributeEditor document={area} bundle={snapshot.bundle} disabled={saving} onChange={edit}/>}
      {product && pricing && tab === 'preview' && <AreaPricePreview key={product.productId} document={area} product={product} bundle={snapshot.bundle} quantityPricing={snapshot.quantityPricing} disabled={saving} dependencyError={dependencyError} onChange={edit}/>}
      {(tab === 'body' || tab === 'preview') && !category && <p className="pp-empty">请先在产品选项配置中创建产品大类，再配置价格。</p>}
      {tab === 'preview' && category && !product && <p className="pp-empty">本大类暂无产品，请先在产品选项配置中归入产品。</p>}
    </div>
    <Modal title="刷新并放弃未保存的定价修改？" open={refreshOpen} okText="确定" cancelText="取消" onCancel={() => setRefreshOpen(false)} onOk={() => { setRefreshOpen(false); void load() }}>重新读取产品、面积价格和数量阶梯。</Modal>
  </div>
}
