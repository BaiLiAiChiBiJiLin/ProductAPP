import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react'
import { Alert, Button, InputNumber, Modal, Select, Spin } from 'antd'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
import { cloneDocument, getTierIssues, matchQuantityTier, validateCategoryLinks, validateDocument, type PricingCategory, type QuantityPricingDocument, type QuantityTier } from './model'
import { loadQuantityPricing, saveQuantityPricing } from './service'
import './quantity-pricing.css'

type Props = { active?: boolean; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void }
type TierDropTarget = { quantityTierId: string; position: 'before' | 'after' }
const categoryLabel = (category: PricingCategory) => category.titleZh || category.title || category.categoryId
const percent = (value: number) => `${Number(value.toFixed(2))}%`
const rangeLabel = (tier: QuantityTier) => tier.maxQty === null ? `${tier.minQty} 件及以上` : `${tier.minQty}–${tier.maxQty} 件`

export default function QuantityPricingSettings({ active = true, onBusyChange, onDirtyChange }: Props) {
  const [document, setDocument] = useState<QuantityPricingDocument>()
  const [categories, setCategories] = useState<PricingCategory[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [version, setVersion] = useState('')
  const [directory, setDirectory] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<'refresh' | 'orphans'>()
  const [previewQuantity, setPreviewQuantity] = useState<number | null>(50)
  const [draggingId, setDraggingId] = useState<string>()
  const [dropTarget, setDropTarget] = useState<TierDropTarget>()
  const [moveNotice, setMoveNotice] = useState('')
  const dragSource = useRef<{ categoryId: string; quantityTierId: string } | undefined>(undefined)
  const pointerDrag = useRef<{ pointerId: number; x: number; y: number; dragging: boolean; handle: HTMLButtonElement } | undefined>(undefined)
  const sortHandles = useRef(new Map<string, HTMLButtonElement>())
  const mounted = useRef(true)
  const busy = useRef(false)
  const dirtyRef = useRef(false)
  const draft = useRef<QuantityPricingDocument | undefined>(undefined)
  const clearDrag = useCallback(() => {
    const pointer = pointerDrag.current
    pointerDrag.current = undefined; dragSource.current = undefined
    if (pointer?.handle.hasPointerCapture(pointer.pointerId)) pointer.handle.releasePointerCapture(pointer.pointerId)
    setDraggingId(undefined); setDropTarget(undefined)
  }, [])

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { clearDrag(); setMoveNotice('') }, [active, categoryId, loading, saving, confirm, clearDrag])
  const load = useCallback(async () => {
    if (busy.current) return
    busy.current = true; setLoading(true); setError('')
    try {
      const snapshot = await loadQuantityPricing()
      if (!mounted.current) return
      draft.current = snapshot.document; dirtyRef.current = false
      setDocument(snapshot.document); setCategories(snapshot.categories); setVersion(snapshot.version); setDirectory(snapshot.directory)
      setCategoryId(current => snapshot.categories.some(category => category.categoryId === current) ? current : snapshot.categories.find(category => category.categoryId === 'keychains')?.categoryId ?? snapshot.categories[0]?.categoryId ?? '')
      setDirty(false); setNotice('')
    } catch (failure) { if (mounted.current) setError(String(failure)) }
    finally { busy.current = false; if (mounted.current) setLoading(false) }
  }, [])

  // Revisit clean data to pick up saved category changes; keep unsaved tier drafts.
  useEffect(() => { if (active && !dirtyRef.current) void load() }, [active, load])

  const edit = (change: (next: QuantityPricingDocument) => void) => {
    if (busy.current || !draft.current) return
    clearDrag(); setMoveNotice('')
    const next = cloneDocument(draft.current)
    change(next)
    draft.current = next; dirtyRef.current = true
    setDocument(next); setDirty(true); setError(''); setNotice('')
  }
  const editTiers = (change: (tiers: QuantityTier[]) => void) => edit(next => {
    let rule = next.categoryRules.find(rule => rule.categoryId === categoryId)
    if (!rule) { rule = { categoryId, tiers: [] }; next.categoryRules.push(rule) }
    change(rule.tiers)
  })
  const save = async () => {
    if (busy.current || !draft.current) return
    const value = draft.current
    try { validateDocument(value); validateCategoryLinks(value, categories) }
    catch (failure) { setError(String(failure)); return }
    busy.current = true; setSaving(true); onBusyChange?.(true); setError(''); setNotice('')
    try {
      const snapshot = await saveQuantityPricing(value, version)
      if (!mounted.current) return
      draft.current = snapshot.document; dirtyRef.current = false
      setDocument(snapshot.document); setCategories(snapshot.categories); setVersion(snapshot.version); setDirectory(snapshot.directory)
      setDirty(false); setNotice('价格阶梯已保存')
    } catch (failure) { if (mounted.current) setError(String(failure)) }
    finally { busy.current = false; onBusyChange?.(false); if (mounted.current) setSaving(false) }
  }

  if (loading) return <div className="quantity-pricing-loading"><Spin/> 正在加载价格阶梯…</div>
  if (!document) return <Alert type="error" showIcon message={error || '价格阶梯加载失败'} action={<Button onClick={() => void load()}>重试</Button>}/>

  const category = categories.find(category => category.categoryId === categoryId)
  const tiers = document.categoryRules.find(rule => rule.categoryId === categoryId)?.tiers ?? []
  const issues = getTierIssues(tiers)
  const orphanIds = document.categoryRules.filter(rule => !categories.some(category => category.categoryId === rule.categoryId)).map(rule => rule.categoryId)
  let validationError = ''
  try { validateDocument(document); validateCategoryLinks(document, categories) } catch (failure) { validationError = String(failure).replace(/^Error: /, '') }
  const validQuantity = previewQuantity !== null && Number.isSafeInteger(previewQuantity) && previewQuantity >= 1
  const matched = !issues.length && validQuantity ? matchQuantityTier(tiers, previewQuantity!) : undefined
  const last = [...tiers].sort((a, b) => a.minQty - b.minQty).at(-1)
  const addTier = () => editTiers(rows => {
    const minimum = last?.maxQty != null && Number.isSafeInteger(last.maxQty) ? last.maxQty + 1 : 1
    rows.push({ quantityTierId: `qt-${crypto.randomUUID()}`, minQty: minimum, maxQty: null, discountPercent: 0 })
  })
  const updateTier = (quantityTierId: string, key: 'minQty' | 'maxQty' | 'discountPercent', value: number | null) => editTiers(rows => {
    const tier = rows.find(row => row.quantityTierId === quantityTierId)
    if (!tier) return
    if (key === 'maxQty') tier.maxQty = value
    else tier[key] = value ?? Number.NaN
  })
  const moveTier = (quantityTierId: string, targetId: string, position: 'before' | 'after') => {
    clearDrag()
    if (busy.current || !active || quantityTierId === targetId) return
    const rows = draft.current?.categoryRules.find(rule => rule.categoryId === categoryId)?.tiers
    if (!rows) return
    const sourceIndex = rows.findIndex(row => row.quantityTierId === quantityTierId)
    const targetIndex = rows.findIndex(row => row.quantityTierId === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const insertionIndex = targetIndex + (position === 'after' ? 1 : 0) - (sourceIndex < targetIndex ? 1 : 0)
    if (insertionIndex === sourceIndex) return
    editTiers(next => { const [moved] = next.splice(sourceIndex, 1); next.splice(insertionIndex, 0, moved) })
    setMoveNotice(`已移至第 ${insertionIndex + 1} 档，保存后生效。`)
    sortHandles.current.get(quantityTierId)?.focus()
  }
  const moveBy = (quantityTierId: string, offset: -1 | 1) => {
    const index = tiers.findIndex(tier => tier.quantityTierId === quantityTierId)
    const target = tiers[index + offset]
    if (target) moveTier(quantityTierId, target.quantityTierId, offset < 0 ? 'before' : 'after')
  }
  const getDropPosition = (event: DragEvent<HTMLTableRowElement>): TierDropTarget['position'] => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
  }
  const canDrop = () => !busy.current && active && dragSource.current?.categoryId === categoryId
  const pointerTarget = (event: PointerEvent<HTMLButtonElement>): TierDropTarget | undefined => {
    const row = event.currentTarget.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLTableRowElement>('[data-quantity-tier-id]')
    const quantityTierId = row?.dataset.quantityTierId
    if (!row || !quantityTierId || !tiers.some(tier => tier.quantityTierId === quantityTierId) || quantityTierId === dragSource.current?.quantityTierId) return undefined
    const bounds = row.getBoundingClientRect()
    return { quantityTierId, position: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' }
  }
  const dropIndex = dropTarget ? tiers.findIndex(tier => tier.quantityTierId === dropTarget.quantityTierId) : -1

  return <div className="quantity-pricing-settings" aria-busy={saving}>
    <div className="qp-header">
      <div><h3>价格阶梯</h3><p>按产品大类维护数量折扣，该大类下所有产品共用。</p></div>
      <div className="qp-actions">
        <Button disabled={saving} onClick={() => dirty ? setConfirm('refresh') : void load()}>刷新</Button>
        <Button type="primary" loading={saving} disabled={saving || !dirty || !!validationError} onClick={() => void save()}>保存</Button>
      </div>
    </div>
    {error && <Alert type="error" showIcon message={error}/>}
    {notice && <Alert type="success" showIcon message={notice}/>}
    <div className="qp-status"><span>{dirty ? '有未保存的修改。' : '配置已同步。'}</span><span title={directory}>{directory}</span></div>
    <div className="qp-scroll">
      {!!orphanIds.length && <Alert type="warning" showIcon message="部分阶梯关联的大类已被删除" description={`失效关联：${orphanIds.join('、')}。清理后可保存，其他大类的阶梯会保留。`} action={<Button disabled={saving} onClick={() => setConfirm('orphans')}>移除失效关联</Button>}/>}
      {validationError && <Alert type="error" showIcon message={validationError}/>}
      {!categories.length ? <div className="qp-empty">还没有产品大类。请先在“产品选项配置”中新增大类，再回来配置价格阶梯。</div> : <>
        <section className="qp-category">
          <label>关联产品大类<Select aria-label="关联产品大类" value={categoryId} disabled={saving} onChange={value => { clearDrag(); setCategoryId(value) }} options={categories.map(category => ({ value: category.categoryId, label: `${categoryLabel(category)}（${category.productCount} 个产品）` }))}/></label>
          <div className="qp-category-summary"><strong>{category ? categoryLabel(category) : '请选择大类'}</strong><span>{tiers.length ? `${tiers.length} 个阶梯` : '未配置阶梯'} · {category?.productCount ?? 0} 个产品共用</span></div>
        </section>
        <section className="qp-tier-section" aria-label="数量折扣阶梯">
          <div className="qp-section-heading"><h4>数量与折扣</h4><span>“减价 35%”表示实付 65%；结束数量留空表示无上限。</span></div>
          <div className="qp-sort-help" id="qp-sort-help">拖动手柄调整顺序，也可点击上下箭头，或聚焦手柄后按 ↑ / ↓。</div>
          <div className="qp-sort-status" role="status" aria-live="polite">{dropIndex >= 0 ? `松开后放到第 ${dropIndex + 1} 档${dropTarget?.position === 'before' ? '之前' : '之后'}。` : moveNotice}</div>
          {tiers.length ? <div className="qp-table-wrap" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined) }}><table className="qp-table">
            <thead><tr><th scope="col" className="qp-sort-column">排序</th><th scope="col">起始数量</th><th scope="col">结束数量</th><th scope="col">减价比例</th><th scope="col">实付比例</th><th scope="col">操作</th></tr></thead>
            <tbody>{tiers.map((tier, index) => {
              const rowIssues = issues.filter(issue => issue.quantityTierId === tier.quantityTierId)
              const problem = (field: string) => rowIssues.some(issue => issue.field === field || issue.field === 'range')
              const rowErrorId = `qp-error-${tier.quantityTierId}`
              const targetPosition = dropTarget?.quantityTierId === tier.quantityTierId ? dropTarget.position : undefined
              return <tr key={tier.quantityTierId} data-quantity-tier-id={tier.quantityTierId} className={[rowIssues.length ? 'qp-invalid-row' : '', draggingId === tier.quantityTierId ? 'qp-dragging-row' : '', targetPosition ? `qp-drop-${targetPosition}` : ''].filter(Boolean).join(' ')}
                onDragOver={event => {
                  if (!canDrop()) return
                  event.preventDefault(); event.dataTransfer.dropEffect = 'move'
                  if (dragSource.current?.quantityTierId === tier.quantityTierId) { setDropTarget(undefined); return }
                  const position = getDropPosition(event)
                  setDropTarget(current => current?.quantityTierId === tier.quantityTierId && current.position === position ? current : { quantityTierId: tier.quantityTierId, position })
                }}
                onDrop={event => {
                  const source = dragSource.current
                  if (!canDrop() || !source) { clearDrag(); return }
                  event.preventDefault()
                  moveTier(source.quantityTierId, tier.quantityTierId, getDropPosition(event))
                }}>
                <td><div className="qp-sort-controls">
                  <button type="button" className="qp-sort-button qp-drag-handle" aria-label={`拖动第${index + 1}档排序`} aria-describedby="qp-sort-help" title="拖动排序，或按 ↑ / ↓ 移动" disabled={saving || tiers.length < 2} draggable={!saving && tiers.length > 1}
                    ref={element => { if (element) sortHandles.current.set(tier.quantityTierId, element); else sortHandles.current.delete(tier.quantityTierId) }}
                    onPointerDown={event => {
                      if (busy.current || !active || tiers.length < 2 || event.button !== 0) return
                      event.preventDefault(); event.currentTarget.focus()
                      dragSource.current = { categoryId, quantityTierId: tier.quantityTierId }
                      pointerDrag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false, handle: event.currentTarget }
                      event.currentTarget.setPointerCapture(event.pointerId)
                    }}
                    onPointerMove={event => {
                      const pointer = pointerDrag.current
                      if (!pointer || pointer.pointerId !== event.pointerId || !canDrop()) return
                      if (!pointer.dragging && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 5) return
                      pointer.dragging = true; event.preventDefault()
                      setDraggingId(tier.quantityTierId); setMoveNotice('')
                      const target = pointerTarget(event)
                      setDropTarget(current => current?.quantityTierId === target?.quantityTierId && current?.position === target?.position ? current : target)
                    }}
                    onPointerUp={event => {
                      const pointer = pointerDrag.current
                      const source = dragSource.current
                      if (!pointer || pointer.pointerId !== event.pointerId) return
                      const target = pointer.dragging && canDrop() ? pointerTarget(event) : undefined
                      if (source && target) moveTier(source.quantityTierId, target.quantityTierId, target.position)
                      else clearDrag()
                    }}
                    onPointerCancel={event => { if (pointerDrag.current?.pointerId === event.pointerId) clearDrag() }}
                    onLostPointerCapture={event => { if (pointerDrag.current?.pointerId === event.pointerId) clearDrag() }}
                    onDragStart={event => {
                      if (busy.current || !active || pointerDrag.current) { event.preventDefault(); return }
                      dragSource.current = { categoryId, quantityTierId: tier.quantityTierId }
                      event.dataTransfer.setData('application/x-printflow-quantity-tier', tier.quantityTierId)
                      event.dataTransfer.effectAllowed = 'move'
                      setDraggingId(tier.quantityTierId); setDropTarget(undefined); setMoveNotice('')
                    }} onDragEnd={clearDrag}
                    onKeyDown={event => {
                      if (event.key === 'Escape' && dragSource.current) { event.preventDefault(); event.stopPropagation(); clearDrag() }
                      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); moveBy(tier.quantityTierId, event.key === 'ArrowUp' ? -1 : 1) }
                    }}><GripVertical size={16} aria-hidden="true"/></button>
                  <button type="button" className="qp-sort-button" aria-label={`上移第${index + 1}档`} title="上移" disabled={saving || index === 0} onClick={() => moveBy(tier.quantityTierId, -1)}><ArrowUp size={14} aria-hidden="true"/></button>
                  <button type="button" className="qp-sort-button" aria-label={`下移第${index + 1}档`} title="下移" disabled={saving || index === tiers.length - 1} onClick={() => moveBy(tier.quantityTierId, 1)}><ArrowDown size={14} aria-hidden="true"/></button>
                </div></td>
                <td><InputNumber aria-label={`第${index + 1}档起始数量`} aria-describedby={rowIssues.length ? rowErrorId : undefined} status={problem('minQty') ? 'error' : undefined} min={1} max={Number.MAX_SAFE_INTEGER} precision={0} value={Number.isFinite(tier.minQty) ? tier.minQty : null} disabled={saving} onChange={value => updateTier(tier.quantityTierId, 'minQty', value)}/>{!!rowIssues.length && <div className="qp-row-error" id={rowErrorId}>{rowIssues.map(issue => issue.message).join('；')}</div>}</td>
                <td><InputNumber aria-label={`第${index + 1}档结束数量`} aria-describedby={rowIssues.length ? rowErrorId : undefined} status={problem('maxQty') ? 'error' : undefined} min={1} max={Number.MAX_SAFE_INTEGER} precision={0} placeholder="无上限" value={tier.maxQty} disabled={saving} onChange={value => updateTier(tier.quantityTierId, 'maxQty', value)}/></td>
                <td><InputNumber aria-label={`第${index + 1}档减价比例`} aria-describedby={rowIssues.length ? rowErrorId : undefined} status={problem('discountPercent') ? 'error' : undefined} min={0} max={100} precision={2} suffix="%" value={Number.isFinite(tier.discountPercent) ? tier.discountPercent : null} disabled={saving} onChange={value => updateTier(tier.quantityTierId, 'discountPercent', value)}/></td>
                <td className="qp-pay-ratio">{Number.isFinite(tier.discountPercent) && tier.discountPercent >= 0 && tier.discountPercent <= 100 ? percent(100 - tier.discountPercent) : '—'}</td>
                <td><Button danger type="text" aria-label={`删除第${index + 1}档`} disabled={saving} onClick={() => editTiers(rows => { rows.splice(index, 1) })}>删除</Button></td>
              </tr>
            })}</tbody>
          </table></div> : <p className="qp-empty">该大类尚未配置阶梯，暂不提供数量折扣。</p>}
          <div className="qp-add-row"><Button disabled={saving || !category || last?.maxQty === null} onClick={addTier}>新增阶梯</Button>{last?.maxQty === null && <span>新增阶梯前，请先填写数量最大一档的结束数量。</span>}</div>
        </section>
        <section className="qp-preview" aria-label="阶梯试算">
          <label>试算数量<InputNumber aria-label="试算数量" min={1} max={Number.MAX_SAFE_INTEGER} precision={0} value={previewQuantity} onChange={setPreviewQuantity}/></label>
          <div aria-live="polite">{issues.length ? '请先修正阶梯配置，再查看试算结果。' : !validQuantity ? '请输入大于零的整数数量。' : matched ? <><strong>减价 {percent(matched.discountPercent)} · 实付 {percent(100 - matched.discountPercent)}</strong><span>匹配 {rangeLabel(matched)}</span></> : <><strong>未命中阶梯 · 按原价</strong><span>当前数量不享受数量折扣。</span></>}</div>
        </section>
      </>}
    </div>
    <Modal title={confirm === 'refresh' ? '刷新将放弃未保存修改，是否继续？' : '移除已删除大类的阶梯关联？'} open={!!confirm} maskClosable={false} keyboard={false} okText="确定" cancelText="取消" onCancel={() => setConfirm(undefined)} onOk={() => { const action = confirm; setConfirm(undefined); if (action === 'refresh') void load(); else edit(next => { next.categoryRules = next.categoryRules.filter(rule => categories.some(category => category.categoryId === rule.categoryId)) }) }}/>
  </div>
}
