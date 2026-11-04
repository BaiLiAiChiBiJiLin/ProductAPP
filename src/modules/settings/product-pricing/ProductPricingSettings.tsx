import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal, Select, Spin } from 'antd'
import { allProducts, display, getEntityId, getProductSizes } from '../product-options/model'
import { cloneDocument, getReferenceIssues, pruneInvalidReferences, validateDocument, validateReferences, type ProductPricingDocument } from './model'
import BodyPriceEditor, { priceChoices, type ConfirmAction } from './BodyPriceEditor'
import SharedPriceEditor from './SharedPriceEditor'
import ProductPricePreview from './ProductPricePreview'
import { loadProductPricing, saveProductPricing, type Snapshot } from './service'
import './product-pricing.css'

type Props = { active?: boolean; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void }
const priceFingerprint = (document: ProductPricingDocument) => JSON.stringify(document, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
/** Save the selected product's base price without committing other open drafts. */
function basePriceDocument(saved: ProductPricingDocument, current: ProductPricingDocument, productId: string): ProductPricingDocument {
  const next = cloneDocument(saved)
  const currentProduct = current.products.find(product => product.productId === productId)
  if (!currentProduct || currentProduct.pricingMode === 'standee') throw new Error('当前产品不使用主体基本价表')
  const savedProduct = next.products.find(product => product.productId === productId)
  if (savedProduct && savedProduct.pricingMode === currentProduct.pricingMode) {
    savedProduct.basePrices = structuredClone(currentProduct.basePrices)
    savedProduct.fixedUnitPrice = currentProduct.fixedUnitPrice
  } else {
    const replacement = { ...structuredClone(currentProduct), attributePrices: [], legacyBodyPrices: [], dimensionPrices: [] }
    if (savedProduct) next.products[next.products.indexOf(savedProduct)] = replacement
    else next.products.push(replacement)
  }
  return next
}

export default function ProductPricingSettings({ active = true, onBusyChange, onDirtyChange }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [document, setDocument] = useState<ProductPricingDocument>()
  const [productId, setProductId] = useState('P31')
  const [tab, setTab] = useState('body')
  const [sharedPricesOpen, setSharedPricesOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dependencyError, setDependencyError] = useState('')
  const [confirmation, setConfirmation] = useState<ConfirmAction>()
  const busy = useRef(false)
  const dirtyRef = useRef(false)
  const mounted = useRef(true)
  const draft = useRef<ProductPricingDocument | undefined>(undefined)
  const baseline = useRef<Snapshot | undefined>(undefined)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  const load = useCallback(async (preserveDraft = false) => {
    if (busy.current) return
    busy.current = true; setLoading(true); setError('')
    try {
      const value = await loadProductPricing()
      if (!mounted.current) return
      if (preserveDraft && draft.current && baseline.current) {
        if (priceFingerprint(value.document) === priceFingerprint(baseline.current.document)) {
          baseline.current = value; setSnapshot(value); setDependencyError('')
        } else {
          setSnapshot({ ...value, version: baseline.current.version })
          setDependencyError('产品价表已在其他窗口修改。当前草稿已保留，请先保留需要的价格，再刷新价表。')
        }
      } else {
        baseline.current = value; setSnapshot(value); setDocument(value.document); draft.current = value.document
        setDirty(false); dirtyRef.current = false; setDependencyError(''); setNotice('')
        const products = allProducts(value.bundle.main)
        setProductId(current => products.some(product => product.productId === current) ? current : products[0]?.productId ?? '')
      }
    } catch (failure) {
      if (mounted.current) {
        setError(String(failure))
        if (baseline.current) setDependencyError('未能读取最新产品和价格阶梯，已暂停保存及试算。草稿仍保留，请重新核对。')
      }
    }
    finally { busy.current = false; if (mounted.current) setLoading(false) }
  }, [])
  useEffect(() => { if (active) void load(dirtyRef.current) }, [active, load])
  const edit = (change: (document: ProductPricingDocument) => void) => {
    if (busy.current || !draft.current) return
    const next = cloneDocument(draft.current); change(next)
    draft.current = next; dirtyRef.current = true; setDocument(next); setDirty(true); setError(''); setNotice('')
  }
  const save = async (baseProductId?: string) => {
    if (busy.current || !draft.current || !snapshot || !baseline.current || dependencyError) return
    let candidate: ProductPricingDocument
    try {
      candidate = baseProductId ? basePriceDocument(baseline.current.document, draft.current, baseProductId) : draft.current
      validateDocument(candidate); validateReferences(candidate, snapshot.bundle)
    }
    catch (failure) { setError(String(failure)); return }
    busy.current = true; setSaving(true); onBusyChange?.(true); setError(''); setNotice('')
    try {
      const value = await saveProductPricing(candidate, snapshot.version)
      if (!mounted.current) return
      let remaining = value.document
      if (baseProductId) {
        remaining = cloneDocument(draft.current)
        const savedProduct = value.document.products.find(product => product.productId === baseProductId)
        const draftProduct = remaining.products.find(product => product.productId === baseProductId)
        if (!savedProduct || !draftProduct) throw new Error('保存结果中缺少当前产品，草稿已保留，请刷新核对')
        Object.assign(draftProduct, { pricingMode: savedProduct.pricingMode, basePrices: structuredClone(savedProduct.basePrices), fixedUnitPrice: savedProduct.fixedUnitPrice })
      }
      const stillDirty = priceFingerprint(remaining) !== priceFingerprint(value.document)
      baseline.current = value; setSnapshot(value); setDocument(remaining); draft.current = remaining
      setDirty(stillDirty); dirtyRef.current = stillDirty; setNotice(baseProductId ? `基本价已保存${stillDirty ? '，其他修改仍未保存' : ''}` : '产品定价已保存')
    } catch (failure) { if (mounted.current) setError(String(failure)) }
    finally { busy.current = false; onBusyChange?.(false); if (mounted.current) setSaving(false) }
  }
  if (loading) return <div className="pp-loading"><Spin/> 正在加载产品定价…</div>
  if (!document || !snapshot) return <Alert type="error" showIcon message={error || '产品定价加载失败'} action={<Button onClick={() => void load()}>重试</Button>}/>

  const { bundle } = snapshot
  const products = allProducts(bundle.main)
  const product = products.find(product => product.productId === productId)
  const pricing = document.products.find(product => product.productId === productId)
  const issues = getReferenceIssues(document, bundle)
  let validationError = ''
  try { validateDocument(document); validateReferences(document, bundle) } catch (failure) { validationError = String(failure).replace(/^Error: /, '') }
  let canSaveBase = false
  if (baseline.current && !dependencyError && pricing?.pricingMode !== 'standee') {
    try {
      const candidate = basePriceDocument(baseline.current.document, document, productId)
      validateReferences(candidate, bundle)
      canSaveBase = priceFingerprint(candidate) !== priceFingerprint(baseline.current.document)
    } catch { /* Keep invalid prices in the draft for correction. */ }
  }
  const sizeIds = product ? new Set(getProductSizes(bundle, product, Object.fromEntries(product.productOptions.map(option => [option.name, '']))).map(getEntityId)) : new Set<string>()
  const sharedPriceCount = product ? (document.sharedAttributePrices ?? []).filter(row => row.sizeBandId !== null && sizeIds.has(row.sizeBandId) && (row.techniqueId !== null ? priceChoices(bundle, product, 'Technique').some(value => getEntityId(value) === row.techniqueId) : priceChoices(bundle, product, 'Holo Film').some(value => getEntityId(value) === row.holoFilmId))).length : 0
  const priceCount = pricing?.pricingMode === 'fixed' ? (pricing.fixedUnitPrice === null ? '固定单价待填写' : '固定单价') : pricing?.pricingMode === 'standee' ? `${pricing.dimensionPrices.length} 组尺寸计价` : `${pricing?.basePrices.length ?? 0} 个尺寸基本价 · ${(pricing?.attributePrices.length ?? 0) + sharedPriceCount} 条属性加价`

  return <div className="product-pricing-settings" aria-busy={saving}>
    <div className="pp-header"><div><h3>产品定价</h3><p>主体基本价与材质加价按产品配置，工艺、膜和配件价格统一维护。金额单位：USD。</p></div><div className="pp-actions">
      <Button disabled={saving} onClick={() => dirty ? setConfirmation({ title: '刷新并放弃未保存的定价修改？', description: '重新读取产品、价格和大类阶梯。', apply: () => void load() }) : void load()}>刷新</Button>
      <Button type="primary" loading={saving} disabled={saving || !dirty || !!validationError || !!dependencyError} onClick={() => void save()}>保存</Button>
    </div></div>
    {error && <Alert type="error" showIcon message={error}/>}{notice && <Alert type="success" showIcon message={notice}/>}
    {dependencyError && <Alert type="warning" showIcon message={dependencyError} action={<Button disabled={saving} onClick={() => void load(dirtyRef.current)}>重新核对</Button>}/>}
    <div className="pp-status"><span>{dirty ? '有未保存的修改。' : '配置已同步。'}</span><span title={snapshot.directory}>{snapshot.directory}</span></div>
    <div className="pp-scroll">
      {!!issues.length && <Alert type="warning" showIcon message="部分价格引用已失效" description={issues.slice(0, 8).join('；') + (issues.length > 8 ? `；共 ${issues.length} 项` : '')} action={<Button disabled={saving} onClick={() => setConfirmation({ title: '清理失效的价格引用？', description: '删除失效的产品、选项、尺寸或配件价格记录，保留有效价格。', apply: () => edit(next => Object.assign(next, pruneInvalidReferences(next, bundle))) })}>清理失效引用</Button>}/>}
      {validationError && !issues.length && <Alert type="error" showIcon message={validationError}/>}
      {sharedPricesOpen && <>
        <div className="pp-section-heading"><Button disabled={saving} onClick={() => setSharedPricesOpen(false)}>返回产品定价</Button><span className="pp-muted">公共价格</span></div>
        <SharedPriceEditor document={document} bundle={bundle} saving={saving} edit={edit} confirm={setConfirmation}/>
      </>}
      <div className="pp-product-content" hidden={sharedPricesOpen}>
      <section className="pp-product"><label>选择产品（全部 {products.length} 个）<Select aria-label="定价产品" showSearch optionFilterProp="label" value={productId || undefined} disabled={saving} onChange={setProductId} options={products.map(product => ({ value: product.productId, label: `${display(product)} · ${product.productId}` }))}/></label>
        <div><strong>{product ? display(product) : '暂无产品'}</strong><span>{pricing ? priceCount : '尚未建立价表'}</span></div>
      </section>
      <div className="pp-tabs">
        <Button disabled={saving} onClick={() => setSharedPricesOpen(true)}>公共价格</Button>
        <div className="pp-tabs" role="tablist" aria-label="产品定价内容">{[{ id: 'body', label: '主体价格' }, { id: 'preview', label: '价格试算' }].map(item => <Button key={item.id} role="tab" aria-selected={tab === item.id} type={tab === item.id ? 'primary' : 'default'} disabled={saving} onClick={() => setTab(item.id)}>{item.label}</Button>)}</div>
      </div>
      {(!pricing || !product) && <div className="pp-empty"><p>为这个产品建立主体价表。配件使用公共价格，空白代表未定价。</p><Button type="primary" disabled={saving || !product} onClick={() => edit(next => { next.products.push({ productId, printPricing: 'included', pricingMode: 'table', fixedUnitPrice: null, basePrices: [], attributePrices: [], legacyBodyPrices: [], dimensionPrices: [] }) })}>建立价表</Button></div>}
      {pricing && product && <div hidden={tab !== 'body'}><BodyPriceEditor key={productId} pricing={pricing} product={product} bundle={bundle} saving={saving} canSaveBase={canSaveBase} saveBase={() => void save(productId)} edit={edit} confirm={setConfirmation}/></div>}
      {tab === 'preview' && pricing && product && <ProductPricePreview key={productId} document={document} pricing={pricing} product={product} bundle={bundle} quantityPricing={snapshot.quantityPricing} dependencyError={dependencyError}/>}
      </div>
    </div>
    <Modal title={confirmation?.title} open={!!confirmation} closable={false} maskClosable={false} keyboard={false} okText="确定" cancelText="取消" onCancel={() => setConfirmation(undefined)} onOk={() => { const action = confirmation?.apply; setConfirmation(undefined); action?.() }}><p>{confirmation?.description}</p></Modal>
  </div>
}
