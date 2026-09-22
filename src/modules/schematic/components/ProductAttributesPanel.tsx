import { useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { Alert, Button, InputNumber, Select, Tabs, Tooltip, message } from 'antd'
import AssetNotesEditor from './AssetNotesEditor'
import type { Asset } from '../../../model'
import Loading from '../../../components/Loading'
import useProductConfigs from '../hooks/useProductConfigs'
import ProductOptionField from './ProductOptionField'
import CustomProductForm from './CustomProductForm'
import { availableOptionValues, applyAttributeValues, applyAttributeImages, dependentOptionNames, type ProductAttributePatch } from '../services/productOptionRules'
import { catalogConfirmationPatch, emptyAttributeDraft, readSelectionDraft } from '../services/attributeDraftService'
import { customProductPatch, emptyCustomProduct, saveCustomProduct } from '../services/customProductService'
import { standeeQuantityNotice } from '../services/productSelectionNotice'
import { useProductGroup } from '../grouping/useProductGrouping'
import { groupingTrigger, sharedOptionNames, type GroupEditor } from '../grouping/productGrouping'
import ProductGroupGuide from '../grouping/ProductGroupGuide'
import { restoreProductGroup } from '../grouping/productGroupRestore'
import { orderAssetsByProductGroup } from '../services/productGroupOrdering'

type Props = { assets: Asset[]; selectedAssetIds: Set<string>; onConfirmAttributes: (patch: ProductAttributePatch) => Promise<void>; disabled?: boolean; selectionHint?: string; allowGrouping?: boolean }
export default function ProductAttributesPanel({ assets, selectedAssetIds, onConfirmAttributes, disabled = false, selectionHint, allowGrouping = true }: Props) {
  const { products, loading, error: configError, refreshing, refresh } = useProductConfigs()
  const grouping = useProductGroup()
  const session = allowGrouping ? grouping?.session : undefined
  const selected = useMemo(() => {
    const byId = new Map(assets.map(asset => [asset.id, asset]))
    return [...selectedAssetIds].flatMap(id => { const asset = byId.get(id); return asset ? [asset] : [] })
  }, [assets, selectedAssetIds])
  const savedGroup = !session && selected.some(asset => asset.productGroupId)
    ? restoreProductGroup(assets, selected.find(asset => asset.productGroupId)!.id, products) : null
  const locked = Boolean(session
    ? session.trigger.kind !== 'free' && session.activeId !== session.leaderId
    : savedGroup && savedGroup.trigger.kind !== 'free')
  const lockGroup = session ?? savedGroup
  const lockedOptions = lockGroup ? sharedOptionNames(lockGroup.editors[lockGroup.leaderId], products) : new Set<string>()
  const [notice, noticeContext] = message.useMessage()
  const [localMode, setMode] = useState<'existing' | 'custom'>('existing')
  const [localDraft, setDraft] = useState(emptyAttributeDraft)
  const [localCustom, setCustom] = useState(emptyCustomProduct)
  const editor = session?.editors[session.activeId] ?? { mode: localMode, draft: localDraft, custom: localCustom }
  const { mode, draft, custom } = editor
  const [confirming, setConfirming] = useState(false)
  const [uploadingNote, setUploadingNote] = useState(false)
  const confirmingRef = useRef(false)
  const [error, setError] = useState('')
  const groupEntryRef = useRef<HTMLDivElement>(null)
  const selectionKey = `${session?.id ?? ''}:${selected.map(asset => asset.id).join('|')}`
  const [previousSelection, setPreviousSelection] = useState<string | null>(null)
  if (selectionKey !== previousSelection) {
    setPreviousSelection(selectionKey)
    setError('')
    const cached = selected.length === 1 ? grouping?.readDraft(selected[0].id) : undefined
    const next = cached?.draft ?? readSelectionDraft(draft, selected)
    if (cached) { setMode(cached.mode); setDraft(cached.draft); setCustom(cached.custom) }
    else if (!session && next !== draft) {
      setDraft(next)
      const isCustom = next.productId.startsWith('custom:')
      setMode(isCustom ? 'custom' : 'existing')
      if (isCustom) setCustom({ id: Number(next.productId.slice(7)), name: selected[0]?.productName ?? '', size: next.attributes.Size ?? '', printOption: next.attributes['Print Option'] ?? '', finish: next.attributes.Finish ?? '', accessoryColor: next.attributes['Accessories Color'] ?? '', accessoryColorImage: next.images['Accessories Color'] ?? '', qt: Number(next.attributes.QT) || 1, attributes: { ...next.attributes }, attributeImages: { ...next.images } })
    } else if (!session && selected.length === 1 && (selected[0].note || selected[0].noteImage)) {
      // Notes remain independent when a product has been cleared from an image.
      setDraft({ ...draft, note: selected[0].note ?? '', noteImage: selected[0].noteImage ?? '' })
    }
  }
  useEffect(() => {
    if (session) { const panel = groupEntryRef.current?.closest('.upload-tab-content'); panel?.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' }) }
  }, [session?.id])
  const changeEditor = (next: GroupEditor, mayStart = false) => {
    setMode(next.mode); setDraft(next.draft); setCustom(next.custom)
    if (session) grouping!.updateEditor(next, session.activeId)
    else {
      if (selected.length === 1) grouping?.rememberDraft(selected[0].id, next)
      if (allowGrouping && mayStart) grouping?.start(next, selected.map(asset => asset.id))
    }
  }
  const changeCustom = (value: SetStateAction<typeof custom>) => {
    const next = typeof value === 'function' ? value(custom) : value
    // Check the complete custom editor on every change. A saved preset can
    // already be named 摇摇乐/照片夹, so comparing only the name change would
    // miss the first trigger after switching to the custom tab.
    const shouldStartGuide = Boolean(groupingTrigger({ ...editor, mode: 'custom', custom: next }, products))
    changeEditor({ ...editor, mode: 'custom', custom: next }, shouldStartGuide)
  }
  const product = products.find(item => item.id === draft.productId)
  const groupGuideTrigger = !session && !savedGroup && selected.length > 0 ? groupingTrigger(editor, products) : null
  const indexes = orderAssetsByProductGroup(assets).flatMap((asset, i) => selectedAssetIds.has(asset.id) ? [i + 1] : [])
  const contiguous = indexes.every((value, i) => i === 0 || value === indexes[i - 1] + 1)
  const selectionLabel = indexes.length === 0 ? '未选择图片' : indexes.length === 1 ? `选中了第 ${indexes[0]} 张图` : contiguous ? `选中了第 ${indexes[0]} 张图到第 ${indexes.at(-1)} 张图` : `选中了 ${indexes.map(i => `第 ${i} 张图`).join('，')}`
  const changeOption = (name: string, value: string, image?: string) => {
    const patch: ProductAttributePatch = { attribute: { key: name, value }, ...(name === 'QT' ? {} : { attributeImage: { key: name, url: image ?? '' }, clearAttributeKeys: dependentOptionNames(product?.options ?? [], name) }) }
    const next = { ...editor, draft: { ...draft, attributes: applyAttributeValues(draft.attributes, patch), images: applyAttributeImages(draft.images, patch) } }
    changeEditor(next, name !== 'QT')
    const content = standeeQuantityNotice(product, name, value, draft.attributes)
    if (content && !groupingTrigger(next, products)) void notice.info({ key: 'standee-quantity', content, duration: 5 })
  }
  const confirm = async () => {
    if (!selected.length || confirmingRef.current || disabled || uploadingNote) return
    if (mode === 'existing' && !product) { setError('请选择产品'); return }
    if (mode === 'custom' && !custom.name.trim()) { setError('请填写自定义产品名称'); return }
    if (session) { await grouping!.persist(true); return }
    confirmingRef.current = true
    setConfirming(true)
    setError('')
    try {
      let patch: ProductAttributePatch
      if (mode === 'custom') { const saved = await saveCustomProduct(custom); setCustom(saved); patch = { ...customProductPatch(saved), note: draft.note, noteImage: draft.noteImage } }
      else patch = catalogConfirmationPatch(draft, product!)
      await onConfirmAttributes(patch)
      grouping?.clearDrafts(selected.map(asset => asset.id))
    } catch (reason) { setError(`确认保存失败：${String(reason)}`) }
    finally { confirmingRef.current = false; setConfirming(false) }
  }
  return <div className="image-attributes-panel" role="tabpanel">
    {noticeContext}
    <div className="upload-panel-hint"><p>{selectionHint ?? '选择左侧图片修改属性，可多选可单选'}</p><p>{selectionHint ? '修改后点击确认保存。' : '点击单选，Ctrl 多选，Shift 连选；填写后点击确认保存。'}</p></div>
    <div className="product-config-selected-count">{selectionLabel}</div>
    {allowGrouping && savedGroup && <div className="product-group-edit-entry"><span>{savedGroup.trigger.kind === 'free' ? '已加入自由图片组，可单独修改这组中的任意图片。' : '已加入产品组，可单独修改此图属性。产品和立牌数量请在组内修改。'}</span><Button disabled={disabled || confirming || selected.length !== 1} onClick={() => grouping?.resumeGroup(selected[0].id)}>编辑组合</Button></div>}
    {allowGrouping && !savedGroup && !session && selected.length > 0 && <div className="product-group-edit-entry"><span>{groupGuideTrigger ? `当前${groupGuideTrigger.label}支持多图分组引导。` : '组合时先选完图片再选产品'}</span><Button disabled={disabled || confirming || grouping?.saving} onClick={() => grouping?.start(editor, selected.map(asset => asset.id), !groupGuideTrigger, selected.some(asset => asset.attributesConfirmed))}>图片组合</Button></div>}
    <fieldset className="attribute-edit-fields" disabled={disabled || confirming || grouping?.saving} inert={disabled || confirming || grouping?.saving}>
      <Tabs activeKey={mode} className="product-attribute-mode-tabs" onChange={key => { const nextMode = key as 'existing' | 'custom'; const nextEditor = { ...editor, mode: nextMode }; changeEditor(nextEditor, nextMode === 'custom' && Boolean(groupingTrigger(nextEditor, products))) }} items={[{ key: 'existing', label: '已有产品', disabled: locked }, { key: 'custom', label: '自定义', disabled: locked }]}/>
      <div hidden={mode !== 'existing'}>
        {loading && <Loading size="small" text="正在加载产品选项…"/>}
        {(configError || (!loading && !products.length)) && <Alert type="warning" showIcon
          message={products.length ? '产品配置更新失败，当前使用本地缓存' : '产品配置不可用'}
          description={<><div>{configError || '本地没有可用的产品配置，请刷新从接口重新获取。'}</div><Button style={{ marginTop: 8 }} disabled={refreshing || loading} icon={refreshing ? <Loading size="small" inline/> : undefined} onClick={() => void refresh()}>{refreshing ? '正在刷新…' : '刷新产品配置'}</Button></>}/>} 
        <div className="product-config-form">
          <label className="product-config-field"><span>产品</span><Select aria-label="产品" showSearch optionFilterProp="label" disabled={!selected.length || loading || locked} placeholder="请选择产品" value={product?.id} options={products.map(item => ({ value: item.id, label: item.title }))} onChange={id => changeEditor({ ...editor, draft: { ...draft, productId: id, attributes: {}, images: {} } }, true)}/></label>
          {product?.options.map(option => { const values = availableOptionValues(option, draft.attributes); return values.length ? <ProductOptionField key={`${product.id}:${option.name}`} option={option} values={values} value={draft.attributes[option.name]} imageOverride={draft.images[option.name]} disabled={!selected.length || (locked && lockedOptions.has(option.name))} onChange={(value, image) => changeOption(option.name, value, image)}/> : null })}
          <label className="product-config-field"><span>QT（数量）</span><InputNumber aria-label="QT（数量）" disabled={!selected.length} min={1} max={2147483647} precision={0} value={draft.attributes.QT ? Number(draft.attributes.QT) : undefined} onChange={value => changeOption('QT', value == null ? '' : String(value))}/></label>
        </div>
      </div>
      <div hidden={mode !== 'custom'}><CustomProductForm draft={custom} onDraftChange={changeCustom} productLocked={locked}/></div>
      <AssetNotesEditor assets={selected.map(asset => ({ ...asset, note: draft.note, noteImage: draft.noteImage }))} onUploadingChange={setUploadingNote} onAssign={patch => changeEditor({ ...editor, draft: { ...draft, ...(patch.note !== undefined ? { note: patch.note } : {}), ...(patch.noteImage !== undefined ? { noteImage: patch.noteImage } : {}) } })}/>
    </fieldset>
    {error && <div role="alert" className="product-config-error">{error}</div>}
    <ProductGroupGuide assets={assets}/>
    {!session && selected.length === 1 && grouping?.isPending(selected[0].id) && <p role="status" className="product-group-pending">这张图片的分组已保存，属性尚未确认，请点击“确认”保存。</p>}
    <div ref={groupEntryRef} className="attribute-confirm">{session && <Tooltip title="取消选择并退出引导，保留已保存内容，放弃尚未保存的修改"><Button disabled={disabled || confirming || uploadingNote || grouping?.saving} onClick={() => grouping!.cancelGuide()}>退出引导</Button></Tooltip>}<Button type="primary" disabled={!selected.length || disabled || confirming || uploadingNote || grouping?.saving} icon={confirming || grouping?.saving ? <Loading size="small" inline/> : undefined} onClick={() => void confirm()}>{confirming || grouping?.saving ? '正在保存…' : '确认'}</Button></div>
  </div>
}
