import { exportFileName } from './services/exportFileName'
import { removeCanvasGroups } from './services/removeCanvasGroups'
import { updateSelectedRulers } from './services/canvasSelectionService'
import { dimensionForItem } from './services/imageDimensionService'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { DragDropEvent } from '@tauri-apps/api/webview'
import type { Event } from '@tauri-apps/api/event'
import { Button, Tag, message } from 'antd'
import { save } from '@tauri-apps/plugin-dialog'
import { constrainHeaderBlock, defaultLayoutBounds, normalizeLayoutBounds, type Asset, type HeaderBlock, type Item, type LayoutBounds, type Page } from '../../model'
import { importAssets, type ImportProgress } from './services/uploadService'
import UploadPanel, { type UploadPanelTab } from './components/UploadPanel'
import UploadImageList from './components/UploadImageList'
import { ProductGroupingContext, useProductGrouping } from './grouping/useProductGrouping'
import { applyGroupedAttributePatch, repairLegacyProductGroups } from './grouping/productGroupRestore'
import ProductCategoryNav from './components/ProductCategoryNav'
import './components/upload-workspace.css'
import { paginateAssets, autoArrangePages } from './services/paginationService'



import { exportPage, exportPdf, type PdfExportProgress } from './services/exportService'
import { schematicCopy } from './copy'
import ArrangePage from './ArrangePage'
import LazySvgImage from './components/LazySvgImage'
import ReviewAssetPicker from './components/ReviewAssetPicker'
import { ArrowLeft } from 'lucide-react'
import { defaultBatchMetadata, type BatchMetadata } from './types'
import Loading from '../../components/Loading'
import { classifyAssetsByProductAndPrint } from './services/classificationService'
import { combineImageGroupsAcrossPages } from './services/groupCombinationService'

import { type ProductAttributePatch } from './services/productOptionRules'
import { loadProductConfigs, PRODUCT_CONFIGS_UPDATED_EVENT, type ProductConfig } from './services/productConfigService'

import { orderAssetsByProductGroup } from './services/productGroupOrdering'
type SaveBatchResult = { assets: Asset[]; duplicate: boolean; batchId: string; metadata?: BatchMetadata }
type BatchRecord = { id: string; savedAt: string; assets: Asset[]; metadata?: BatchMetadata }
const assetForPersistence = (asset: Asset): Asset => asset.svg && asset.storagePath ? { ...asset, svg: '' } : asset
const mergePersistedAssetMetadata = (current: Asset[], persisted: Asset[]) => {
  const byId = new Map(persisted.map(asset => [asset.id, asset]))
  return current.map((asset, index) => {
    const saved = byId.get(asset.id) ?? persisted[index]
    return saved ? { ...asset, attributes: saved.attributes ?? asset.attributes, storagePath: saved.storagePath || asset.storagePath } : asset
  })
}
export default function SchematicPage() { const [toast, context] = message.useMessage(); const [assets, setAssets] = useState<Asset[]>([]); const [batchOpen, setBatchOpen] = useState(false); const [loadingBatchId, setLoadingBatchId] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [dropActive, setDropActive] = useState(false); const [progress, setProgress] = useState<{ parse: ImportProgress; generate: ImportProgress }>({ parse: { phase: 'parse', completed: 0, total: 0 }, generate: { phase: 'generate', completed: 0, total: 0 } }); const [reviewOpen, setReviewOpen] = useState(false); const [confirmingReview, setConfirmingReview] = useState(false); const [screen, setScreen] = useState<'upload' | 'arrange'>('upload'); const [uploadFromArrange, setUploadFromArrange] = useState(false); const [pages, setPages] = useState<Page[]>([]); const [activePage, setActivePage] = useState(1); const [selectedItem, setSelectedItem] = useState<string | null>(null); const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const [arrangementSort, setArrangementSort] = useState<'default' | 'upload'>('default')
  const [defaultArrangementIds, setDefaultArrangementIds] = useState<string[]>([])
  const [category, setCategory] = useState('')
  const saveLock = useRef(false)
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null)
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set())
  const [uploadPanelTab, setUploadPanelTab] = useState<UploadPanelTab>('upload')
  const [classifiedAssets, setClassifiedAssets] = useState<Asset[] | null>(null)
  const [reviewSelectedIds, setReviewSelectedIds] = useState<Set<string>>(new Set())
  const [classifying, setClassifying] = useState(false)
  const [batchMetadata, setBatchMetadata] = useState<BatchMetadata>(defaultBatchMetadata)
  const [layoutBounds, setLayoutBounds] = useState<LayoutBounds>(defaultLayoutBounds)
  const [historyTransition, setHistoryTransition] = useState<'' | 'forward' | 'back'>('')
  const [recentBatches, setRecentBatches] = useState<BatchRecord[]>([])
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null)
  const [savingBatch, setSavingBatch] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<PdfExportProgress>({ phase: 'rendering', completed: 0, total: 1 })
  const [historyLoading, setHistoryLoading] = useState(true)
  const [productConfigs, setProductConfigs] = useState<ProductConfig[]>([])
  useEffect(() => { setSelectedAssetIds(current => new Set([...current].filter(id => assets.some(asset => asset.id === id)))) }, [assets])
  useEffect(() => { if (!isTauri()) { setHistoryLoading(false); return } invoke<BatchRecord[]>('list_batches').then(records => setRecentBatches(records ?? [])).catch(() => {}).finally(() => setHistoryLoading(false)) }, [])
  useEffect(() => {
    let cancelled = false
    const read = () => { void loadProductConfigs().then(configs => { if (!cancelled) setProductConfigs(configs) }).catch(() => {}) }
    read()
    window.addEventListener(PRODUCT_CONFIGS_UPDATED_EVENT, read)
    return () => { cancelled = true; window.removeEventListener(PRODUCT_CONFIGS_UPDATED_EVENT, read) }
  }, [])
  useEffect(() => { if (batchOpen) setAssets(current => repairLegacyProductGroups(current, productConfigs)) }, [batchOpen, productConfigs])
  const saveBatch = async (confirmedAssets?: Asset[]) => {
    if (saveLock.current) throw new Error('批次正在保存，请稍候')
    const savingAssets = repairLegacyProductGroups(confirmedAssets ?? assets, productConfigs)
    if (!savingAssets.length) return
    if (!isTauri()) { if (confirmedAssets) throw new Error('请在桌面软件中确认并保存'); return }
    saveLock.current = true
    setSavingBatch(true)
    const record = { id: currentBatchId ?? crypto.randomUUID(), savedAt: new Date().toISOString(), assets: savingAssets, metadata: batchMetadata }
    try {
      const result = await invoke<SaveBatchResult>('save_batch', { ...record, assets: savingAssets.map(assetForPersistence) })
      setCurrentBatchId(result.batchId)
      const persisted = mergePersistedAssetMetadata(savingAssets, result.assets)
      setAssets(persisted)
      if (screen === 'arrange') setPages(current => autoArrangePages(current, activePage, persisted, layoutBounds, productConfigs))
      if (category) setSelectedAssetIds(current => new Set([...current].filter(id => persisted.some(asset => asset.id === id && asset.productId === category))))
      if (category && !persisted.some(asset => asset.productId === category)) setCategory('')
      setBatchMetadata(result.metadata ?? batchMetadata)
      setRecentBatches(current => [{ ...record, id: result.batchId, assets: persisted }, ...current.filter(item => item.id !== result.batchId)].slice(0, 20))
      toast.success({ key: 'batch-save', content: confirmedAssets ? '图片信息已保存到本地历史记录' : '批次已保存到本地历史记录' })
    } catch (error) { if (confirmedAssets) throw error; toast.error(`保存失败：${String(error)}`) }
    finally { saveLock.current = false; setSavingBatch(false) }
  }
  const grouping = useProductGrouping({ assets, products: productConfigs, save: saveBatch,
    activate: id => { setSelectedAssetIds(new Set(id ? [id] : [])); setUploadPanelTab('attributes') }, revealAll: () => setCategory('') })
  const guideActive = Boolean(grouping.session)
  const confirmAttributes = async (patch: ProductAttributePatch) => {
    if (!selectedAssetIds.size || busy) return
    if (!patch.productId || patch.productId === 'a') throw new Error('请选择产品')
    const next = applyGroupedAttributePatch(assets, selectedAssetIds, patch, productConfigs)
    await saveBatch(next)
  }
  const confirmArrangeAttributes = async (assetId: string, patch: ProductAttributePatch) => {
    if (busy || savingBatch) throw new Error('当前批次正在处理，请稍候再保存图片属性')
    if (!patch.productId || patch.productId === 'a') throw new Error('请选择产品')
    const selected = new Set([assetId])
    const before = assets.find(asset => asset.id === assetId)
    if (!before) throw new Error('未找到当前图片')
    const next = repairLegacyProductGroups(applyGroupedAttributePatch(assets, selected, patch, productConfigs), productConfigs)
    const after = next.find(asset => asset.id === assetId)
    await saveBatch(next)
    if (!after) return
    const nextPages = autoArrangePages(pages, activePage, next, layoutBounds, productConfigs)
    setPages(nextPages)
    setActivePage(current => Math.min(current, Math.max(1, nextPages.length)))
    setSelectedItem(null)
    setSelectedGroupIds([])
    toast.success('图片属性已保存并重新排列')
  }
  const showProductCategories = batchOpen && assets.length > 0
  const selectAssets = (ids: Set<string>) => {
    if (guideActive) { const id = [...ids].at(-1); if (id) grouping.selectMember(id); return }
    setSelectedAssetIds(ids)
    if (ids.size) setUploadPanelTab('attributes')
  }
  const visibleAssets = category ? assets.filter(asset => asset.productId === category) : assets
  const changeCategory = (id: string) => { setCategory(id); setSelectedAssetIds(new Set()) }
  const discardBatch = () => { grouping.reset(); setUploadPanelTab('upload'); const pendingAssets = assets; setCategory(''); setHistoryTransition('back'); setUploadFromArrange(false); setPages([]); setSelectedItem(null); setAssets([]); setSelectedAssetIds(new Set()); setCurrentBatchId(null); setBatchOpen(false); setBatchMetadata(defaultBatchMetadata); toast.success('已返回批次列表'); if (pendingAssets.length && isTauri()) void invoke('discard_temp_assets', { assets: pendingAssets }).catch(e => toast.error(`临时文件清理失败：${String(e)}`)) }
  const deleteBatch = async (id: string) => { setDeletingBatchId(id); try { if (isTauri()) { await invoke('delete_batch', { id }); const latest = await invoke<BatchRecord[]>('list_batches'); setRecentBatches(latest) } else { setRecentBatches(current => current.filter(record => record.id !== id)) } toast.success('历史批次已删除') } catch (e) { toast.error(`删除失败：${String(e)}`) } finally { setDeletingBatchId(current => current === id ? null : current) } }
  const deleteAssetFromBatch = async (asset: Asset) => {
    if (busy || savingBatch || saveLock.current || guideActive) return
    saveLock.current = true
    setBusy(true)
    try {
      if (isTauri()) await invoke('delete_asset', { id: asset.id, batchId: currentBatchId })
      setAssets(current => current.filter(item => item.id !== asset.id))
      setSelectedAssetIds(current => { const next = new Set(current); next.delete(asset.id); return next })
      setReviewSelectedIds(current => { const next = new Set(current); next.delete(asset.id); return next })
      setClassifiedAssets(current => current ? current.filter(item => item.id !== asset.id) : current)
      setRecentBatches(current => current.map(record => record.id === currentBatchId ? { ...record, assets: record.assets.filter(item => item.id !== asset.id) } : record))
      if (category && asset.productId === category && !assets.some(item => item.id !== asset.id && item.productId === category)) setCategory('')
      toast.success('图片已删除')
    } catch (error) { toast.error(`删除图片失败：${String(error)}`) }
    finally { saveLock.current = false; setBusy(false) }
  }
  const openBatch = async (record: BatchRecord) => {
    grouping.reset(); setLoadingBatchId(record.id); setHistoryTransition('forward');
    try {
      const loaded = isTauri() ? await invoke<BatchRecord>('load_batch', { id: record.id }) : record
      setUploadPanelTab('upload'); setCategory(''); setUploadFromArrange(false); setPages([]); setSelectedItem(null); setAssets(repairLegacyProductGroups(loaded.assets, productConfigs)); setSelectedAssetIds(new Set()); setCurrentBatchId(loaded.id); setBatchMetadata(loaded.metadata ?? defaultBatchMetadata); setBatchOpen(true); toast.success('已打开历史批次')
    } catch (error) { toast.error(`历史批次加载失败：${String(error)}`) }
    finally { setLoadingBatchId(null) }
  }
  const upload = useCallback(async (droppedPath?: string) => { setBusy(true); setDropActive(false); setProgress({ parse: { phase: 'parse', completed: 0, total: 0 }, generate: { phase: 'generate', completed: 0, total: 0 } }); const streamedIds = new Set<string>(); const wasOpen = batchOpen; let initializedName = false; const initializeBatchName = (imported: Asset[]) => {
      if (wasOpen || initializedName || !imported.length) return
      const fileName = (imported[0].sourceFileName || imported[0].name).split(/[\\/]/).pop() || ''
      const customerName = fileName.replace(/\.svg$/i, '')
      initializedName = true
      setBatchMetadata(current => current.customerName.trim() ? current : { ...current, customerName })
    }; if (!wasOpen && !currentBatchId) setCurrentBatchId(crypto.randomUUID()); try { const imported = await importAssets(next => setProgress(current => ({ ...current, [next.phase]: next })), batch => { initializeBatchName(batch); batch.forEach(asset => streamedIds.add(asset.id)); setAssets(current => { const existing = new Set(current.map(asset => asset.id)); return [...current, ...batch.filter(asset => !existing.has(asset.id))] }); setBatchOpen(true) }, droppedPath); initializeBatchName(imported); if (imported.length && streamedIds.size === 0) { setAssets(current => [...current, ...imported]); setBatchOpen(true) } if (imported.length) toast.success(wasOpen ? schematicCopy.adding : schematicCopy.creating) } catch (e) { if (streamedIds.size) { setAssets(current => current.filter(asset => !streamedIds.has(asset.id))); setSelectedAssetIds(current => new Set([...current].filter(id => !streamedIds.has(id)))); if (!wasOpen) { setBatchOpen(false); setCurrentBatchId(null); setBatchMetadata(defaultBatchMetadata) } } toast.error(String(e)) } finally { setBusy(false) } }, [batchOpen, currentBatchId, toast])
  useEffect(() => { if (!isTauri()) return; let cancelled = false; let unlisten = () => {}; const onDrop = (event: Event<DragDropEvent>) => { if (screen !== 'upload' || busy || savingBatch || guideActive) return; if (event.payload.type === 'enter' || event.payload.type === 'over') setDropActive(true); else if (event.payload.type === 'leave') setDropActive(false); else if (event.payload.type === 'drop') { setDropActive(false); const path = event.payload.paths.find(item => /\.svg$/i.test(item)); if (path) void upload(path); else toast.error('仅支持 SVG 文件') } }; void Promise.resolve().then(() => getCurrentWebview()).then(webview => webview.onDragDropEvent(onDrop)).then(stop => { if (cancelled) stop(); else unlisten = stop }).catch(() => {}); return () => { cancelled = true; unlisten() } }, [screen, busy, savingBatch, guideActive, upload, toast])
  const openReview = async () => { if (!assets.length || busy || confirmingReview || classifying) return; setClassifying(true); await new Promise<void>(resolve => window.setTimeout(resolve, 120)); const classified = classifyAssetsByProductAndPrint(assets); setClassifiedAssets(classified); setReviewSelectedIds(new Set(classified.map(asset => asset.id))); setClassifying(false); setReviewOpen(true) }
  const confirmReview = async () => { if (confirmingReview) return; const ordered = classifiedAssets ?? assets; const chosen = ordered.filter(asset => reviewSelectedIds.has(asset.id)); if (!chosen.length) return; if (!isTauri()) return; setConfirmingReview(true); try { const record = { id: currentBatchId ?? crypto.randomUUID(), savedAt: new Date().toISOString(), assets, metadata: batchMetadata }; const result = await invoke<SaveBatchResult>('save_batch', { ...record, assets: assets.map(assetForPersistence) }); const persisted = mergePersistedAssetMetadata(assets, result.assets); const persistedById = new Map(persisted.map(asset => [asset.id, asset])); const chosenPersisted = chosen.map(asset => persistedById.get(asset.id) ?? asset); const configs = productConfigs.length ? productConfigs : await loadProductConfigs().catch(() => []); setProductConfigs(configs); setCurrentBatchId(result.batchId); setAssets(persisted); setDefaultArrangementIds(chosenPersisted.map(asset => asset.id)); setArrangementSort('default'); setClassifiedAssets(null); setReviewSelectedIds(new Set()); setBatchMetadata(result.metadata ?? batchMetadata); if (!result.duplicate) setRecentBatches(current => [{ ...record, id: result.batchId, assets: persisted }, ...current.filter(item => item.id !== result.batchId)].slice(0, 20)); const nextPages = paginateAssets(chosenPersisted, 1000, layoutBounds, configs); setPages(nextPages); setSelectedItem(null); setSelectedGroupIds([]); setActivePage(1); setReviewOpen(false); setScreen('arrange'); toast.success(result.duplicate ? `已确认 ${chosenPersisted.length} 张图片进入生产（历史批次已存在，未重复保存）` : `已确认 ${chosenPersisted.length} 张图片进入生产`) } catch (e) { toast.error(`保存图片失败：${String(e)}`) } finally { setConfirmingReview(false) } }
  const updatePageItem = useCallback((next: Item) => setPages(current => current.map(page => {
    if (page.id !== activePage) return page
    const asset = assets.find(asset => asset.id === next.assetId)
    const size = asset ? dimensionForItem(asset, next).label : ''
    return { ...page, items: page.items.map(item => item.id === next.id ? { ...item, rulerUnit: next.rulerUnit, rulerWidth: next.rulerWidth, rulerHeight: next.rulerHeight } : item), imageGroups: page.imageGroups?.map(group => group.itemIds.includes(next.id) && group.details ? { ...group, details: { ...group.details, size, sizes: group.details.sizes?.map(value => value.itemId === next.id ? { ...value, label: size } : value) } } : group) }
  })), [activePage, assets])
  const changeLayoutBounds = (value: LayoutBounds) => {
    const next = normalizeLayoutBounds(value)
    try {
      const nextPages = autoArrangePages(pages, activePage, assets, next, productConfigs)
      setLayoutBounds(next)
      setPages(nextPages)
    } catch (error) { toast.error(String(error)) }
  }
  const addHeaderBlock = () => {} 
  const changeHeaderBlock = (block: HeaderBlock) => setPages(current => current.map(page => page.id === activePage ? {
    ...page, headerBlocks: page.headerBlocks?.map(item => item.id === block.id ? constrainHeaderBlock({ ...block, auto: false }, layoutBounds) : item),
  } : page))
  const removeHeaderBlock = (id: string) => {
    setPages(current => current.map(page => page.id === activePage ? { ...page, headerBlocks: page.headerBlocks?.filter(block => block.id !== id) } : page))
    setSelectedItem(current => current === id ? null : current)
  }
  const usedIds = new Set(pages.flatMap(page => page.items.map(item => item.assetId)))
  const allAssetsSelected = visibleAssets.length > 0 && visibleAssets.every(asset => selectedAssetIds.has(asset.id))
  const addAssetToPage = (assetId: string) => {
    if (usedIds.has(assetId)) return
    const asset = assets.find(item => item.id === assetId)
    if (!asset) return
    try {
      const nextPages = paginateAssets(assets.filter(candidate => usedIds.has(candidate.id) || candidate.id === assetId), 1000, layoutBounds, productConfigs)
      setPages(nextPages)
      setActivePage(nextPages.find(page => page.items.some(item => item.assetId === assetId))?.id ?? 1)
    } catch (error) { toast.error(String(error)) }
  }
  const deleteCanvasGroups = (ids: string[]) => {
    setPages(current => removeCanvasGroups(current, ids))
    setSelectedItem(null)
    setSelectedGroupIds([])
  }
  const addPage = () => { const id = Math.max(0, ...pages.map(page => page.id)) + 1; setPages(current => [...current, { id, name: `页面 ${id}`, items: [] }]); setActivePage(id) }
  const selectGroup = (id: string, ctrlKey: boolean) => {
    if (!ctrlKey) { setSelectedGroupIds([id]); return }
    setSelectedGroupIds(current => current.includes(id) ? current.filter(item => item !== id) : current.length < 2 ? [...current, id] : current)
  }
  const combineSelectedGroups = () => {
    if (selectedGroupIds.length !== 2) return
    try {
      const selections = selectedGroupIds.map(groupId => pages.flatMap(page => (page.imageGroups ?? []).map(group => ({ pageId: page.id, groupId: group.id }))).find(selection => selection.groupId === groupId)).filter(Boolean) as { pageId: number; groupId: string }[]
      const next = combineImageGroupsAcrossPages(pages, selections, assets)
      const start = Math.min(...selections.map(selection => next.findIndex(page => page.id === selection.pageId)))
      const nextPages = autoArrangePages(next, start, assetsForArrangement(next, arrangementSort), layoutBounds, productConfigs)
      setPages(nextPages)
      setSelectedGroupIds([])
      setSelectedItem(null)
      toast.success('已组合两组图片，图片保持原比例上下排列')
    } catch (error) { toast.error(String(error)) }
  }
  const assetsForArrangement = (sourcePages: Page[], mode: 'default' | 'upload') => {
    if (mode === 'upload') return assets
    const order = new Map<string, number>(defaultArrangementIds.map((id, index) => [id, index]))
    let index = 0
    for (const page of sourcePages) for (const item of page.items) if (!item.derivedFrom && !order.has(item.assetId)) order.set(item.assetId, defaultArrangementIds.length + index++)
    return [...assets].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }
  const autoArrange = (requestedMode: 'default' | 'upload' = arrangementSort) => {
    try {
      setArrangementSort(requestedMode)
      const orderedAssets = assetsForArrangement(pages, requestedMode)
      const nextPages = autoArrangePages(pages, activePage, orderedAssets, layoutBounds, productConfigs)
      setPages(nextPages)
      if (!nextPages.some(page => page.id === activePage)) setActivePage(nextPages.at(-1)?.id ?? 1)
      setSelectedItem(null)
      setSelectedGroupIds([])
    }
    catch (error) { toast.error(String(error)) }
  }
  const exportCurrent = async (format: 'jpg' | 'png' | 'svg' | 'pdf') => { if (exporting) return; const page = pages.find(item => item.id === activePage); if (!page) return; setExportProgress({ phase: 'rendering', completed: 0, total: format === 'pdf' ? pages.length : 1 }); setExporting(true); try { const output = await save({ defaultPath: exportFileName(assets, format), filters: [{ name: format.toUpperCase(), extensions: [format] }] }); if (output) { if (format === 'pdf') await exportPdf(pages, assets, output, batchMetadata, setExportProgress); else await exportPage(page, assets, output, format, batchMetadata, pages.length); toast.success('导出完成') } } catch (error) { toast.error(String(error)) } finally { setExporting(false) } }
  if (screen === 'arrange') return <ProductGroupingContext.Provider value={grouping}><ArrangePage context={context} assets={assets} pages={pages} activePage={activePage} selectedItem={selectedItem} selectedGroupIds={selectedGroupIds} sortMode={arrangementSort} onSelectPage={id => { setActivePage(id); setSelectedItem(null) }} onSelectItem={id => { setSelectedItem(id); setSelectedGroupIds([]) }} onSelectGroup={selectGroup} onChangeRulers={(ids, patch) => setPages(current => current.map(page => page.id === activePage ? updateSelectedRulers(page, ids, patch, new Map(assets.map(asset => [asset.id, asset]))) : page))} onChangeItem={updatePageItem} onDropAsset={addAssetToPage} onDeleteGroups={deleteCanvasGroups} onConfirmAssetAttributes={confirmArrangeAttributes} onAddPage={addPage} onAutoArrange={autoArrange} onCombine={combineSelectedGroups} onBack={() => { setSelectedGroupIds([]); setUploadFromArrange(true); setScreen('upload') }} onExport={exportCurrent} exporting={exporting} exportProgress={exportProgress} metadata={batchMetadata} onMetadataChange={value => setBatchMetadata(current => ({ ...current, ...value }))} layoutBounds={layoutBounds} onBoundsChange={changeLayoutBounds} onAddHeaderBlock={addHeaderBlock} onChangeHeaderBlock={changeHeaderBlock} onRemoveHeaderBlock={removeHeaderBlock}/></ProductGroupingContext.Provider>
  return <ProductGroupingContext.Provider value={grouping}><main className={`product-upload-page ${showProductCategories ? 'has-product-categories' : ''} ${uploadFromArrange ? 'upload-page-enter-left' : ''} history-transition-${historyTransition}`}>{context}{showProductCategories && <ProductCategoryNav assets={assets} products={productConfigs} value={category} onChange={changeCategory} disabled={busy || savingBatch || guideActive}/>}<section className="uploaded-assets-panel" inert={savingBatch}><div className="upload-page-title">{batchOpen && <Button className="batch-back-button" type="text" icon={<ArrowLeft size={18}/>} aria-label="返回批次列表" title="返回批次列表并清除未保存内容" onClick={discardBatch} disabled={busy || savingBatch || confirmingReview || classifying || guideActive}/>}<div><h1>{batchOpen ? '当前批次图片' : schematicCopy.recent}</h1>{batchOpen ? <Tag color="blue">共 {assets.length} 张</Tag> : <p>默认不加载历史记录，请直接上传图片。</p>}</div>{batchOpen && <div className="batch-summary"><Button type="default" size="small" onClick={() => selectAssets(allAssetsSelected ? new Set() : new Set(visibleAssets.map(asset => asset.id)))} disabled={!assets.length || busy || savingBatch || confirmingReview || classifying || guideActive}>{allAssetsSelected ? '取消全选' : '全选'}</Button><Button type="default" size="small" onClick={() => guideActive ? grouping.cancelGuide() : setSelectedAssetIds(new Set())} title={guideActive ? "退出引导并放弃未保存的修改，保留已保存内容" : undefined} disabled={!selectedAssetIds.size || busy || savingBatch || confirmingReview || classifying || grouping.saving}>取消选择</Button><Button type="primary" size="small" loading={savingBatch} onClick={() => void (guideActive ? grouping.persist(false) : saveBatch())} disabled={!assets.length || busy || savingBatch || confirmingReview || classifying || grouping.saving}>保存批次</Button></div>}</div>{batchOpen ? <UploadImageList assets={visibleAssets} allAssets={assets} products={productConfigs} selectedIds={selectedAssetIds} onSelectionChange={selectAssets} disabled={busy || savingBatch} onDelete={deleteAssetFromBatch}/> : <div className="batch-empty">{loadingBatchId || historyLoading ? <div className="history-loading"><Loading size="large" text={loadingBatchId ? '正在加载批次图片…' : '正在加载历史记录…'} /></div> : <><div className="recent-title">最近使用批次</div>{recentBatches.length ? <div className="recent-batch-grid">{recentBatches.map(record => <div role="button" tabIndex={0} key={record.id} className="recent-batch-card" aria-label={`打开批次 ${record.metadata?.customerName?.trim() || record.id}`} onClick={() => void openBatch(record)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') void openBatch(record) }}><button type="button" className="recent-batch-delete" aria-label="删除历史批次" title="删除历史批次" disabled={deletingBatchId === record.id} onPointerDown={event => event.stopPropagation()} onClick={event => { event.preventDefault(); event.stopPropagation(); deleteBatch(record.id) }}>×</button><div className="recent-batch-preview">{record.assets.slice(0, 4).map(asset => <LazySvgImage key={asset.id} svg={asset.svg} alt=""/>)}</div><strong>{record.metadata?.customerName?.trim() || '图片批次'}</strong><span>{new Date(record.savedAt).toLocaleString()}</span><em>共 {record.assets.length} 张</em></div>)}</div> : <div className="recent-empty">暂无记录</div>}</>}</div>}</section><div className="upload-column"><UploadPanel busy={busy || savingBatch} dropActive={dropActive} progress={progress} metadata={batchMetadata} onMetadataChange={setBatchMetadata} onUpload={() => void upload()} batchOpen={batchOpen} activeTab={uploadPanelTab} onTabChange={setUploadPanelTab} selectedAssetIds={selectedAssetIds} onConfirmAttributes={confirmAttributes} assets={assets}/><Button className="generate-schematic-button" type="primary" size="large" icon={classifying ? <Loading size="small" inline /> : undefined} disabled={!assets.length || busy || savingBatch || confirmingReview || classifying || guideActive} onClick={() => void openReview()}>{classifying ? '正在分类…' : '生成示意图'}</Button></div><ReviewAssetPicker open={reviewOpen} assets={orderAssetsByProductGroup(assets)} selectedIds={reviewSelectedIds} confirming={confirmingReview} onChange={setReviewSelectedIds} onCancel={() => { if (!confirmingReview) { setReviewOpen(false); setClassifiedAssets(null); setReviewSelectedIds(new Set()) } }} onConfirm={() => void confirmReview()} /></main></ProductGroupingContext.Provider> }




















