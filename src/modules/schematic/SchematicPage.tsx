import { recolorBackground } from './services/canvasAnnotationService'
import { imageGroupsForPage } from './services/groupBackgroundService'
import { createHorizontalGroupReflowRequest, applyHorizontalGroupReflow } from './services/horizontalGroupReflowService'
import { resizeGroupPages, type GroupRect } from './services/groupResizeService'
import { calculateHorizontalReflow } from './services/horizontalReflowWorkerService'
import { exportFileName } from './services/exportFileName'
import { removeCanvasGroups } from './services/removeCanvasGroups'
import { removeCanvasItems } from './services/removeCanvasItems'
import { updateSelectedRulers } from './services/canvasSelectionService'
import { rulerDimensionLabel } from './services/imageDimensionService'
import type { RulerChange } from './components/ImageDimensionMarkers'
import type { EditImageGroupText } from './components/ImageGroupDetails'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { invoke, storageMode } from '../../services/backend'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { DragDropEvent } from '@tauri-apps/api/webview'
import { listen, type Event } from '@tauri-apps/api/event'
import { Button, Modal, Popconfirm, Tag, message } from 'antd'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { save } from '@tauri-apps/plugin-dialog'
import { constrainHeaderBlock, normalizeLayoutBounds, type Asset, type HeaderBlock, type Item, type LayoutBounds, type Page } from '../../model'
import { loadLayoutBounds, saveLayoutBounds } from './services/layoutBoundsPreferences'
import { importAssets, type ImportProgress } from './services/uploadService'
import { importReplacementAsset, replaceAssetArtwork, replaceSelectedAssetId } from './services/assetReplacementService'
import { replaceCanvasItemArtwork, replaceCanvasItemWithAsset } from './services/canvasArtworkService'
import UploadPanel, { type UploadPanelTab } from './components/UploadPanel'
import UploadImageList from './components/UploadImageList'
import { ProductGroupingContext, useProductGrouping } from './grouping/useProductGrouping'
import { applyGroupedAttributePatch, repairLegacyProductGroups } from './grouping/productGroupRestore'
import ProductCategoryNav from './components/ProductCategoryNav'
import { matchesProductCategory, UNASSIGNED_PRODUCT_CATEGORY } from './services/productCategoryService'
import './components/upload-workspace.css'
import { paginateAssets, autoArrangePages } from './services/paginationService'



import { exportPage, exportPdf, type PdfExportProgress } from './services/exportService'
import type { DimensionDisplayOverride } from './services/imageDimensionService'
import { emptyArrangementDisplayState, restoreArrangementDisplay, type ArrangementDisplayState } from './services/arrangementDisplayState'
import { createReviewRecord, exportAndRecord, saveReviewRecord, type ReviewRecordIdentity, type SchematicReviewRecord } from '../schematic-review/reviewRecords'
import { schematicCopy } from './copy'
import ArrangePage from './ArrangePage'
import BatchHistoryPanel from './history/BatchHistoryPanel'
import ReviewAssetPicker from './components/ReviewAssetPicker'
import { currentSharedUser } from './services/sharedTransferService'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { defaultBatchMetadata, type BatchMetadata } from './types'
import Loading from '../../components/Loading'
import { classifyAssetsByProductAndPrint } from './services/classificationService'
import { combineImageGroupsAcrossPages } from './services/groupCombinationService'
import { clearCloudBatchSave, enqueueCloudBatchSave, flushCloudSyncQueue, onCloudBatchSaveComplete } from '../../services/cloudSyncQueue'
import { itemForCanvasDisplay } from './services/canvasDisplayScaleService'

import { type ProductAttributePatch } from './services/productOptionRules'
import { loadProductConfigs, PRODUCT_CONFIGS_UPDATED_EVENT, type ProductConfig } from './services/productConfigService'
import { loadFinishNames } from './services/finishService'
import { setFinishLookup } from './services/assetDetailsService'

import { orderAssetsByProductGroup } from './services/productGroupOrdering'
import { discardTemporaryAssets, loadHistoryBatch, type BatchSummary, type BatchLoadProgress } from './services/batchHistoryService'
import { loadAssetSvg } from './services/assetSvgService'
type SaveBatchResult = { assets: Asset[]; duplicate: boolean; batchId: string; metadata?: BatchMetadata }
const assetForPersistence = (asset: Asset): Asset => asset.svg && asset.storagePath ? { ...asset, svg: '' } : asset
const mergePersistedAssetMetadata = (current: Asset[], persisted: Asset[]) => {
  const byId = new Map(persisted.map(asset => [asset.id, asset]))
  return current.map((asset, index) => {
    const saved = byId.get(asset.id) ?? persisted[index]
    return saved ? { ...asset, attributes: saved.attributes ?? asset.attributes, storagePath: saved.storagePath || asset.storagePath } : asset
  })
}
type ArrangementUndoSnapshot = {
  pages: Page[]
  displayState: ArrangementDisplayState
  layoutBounds: LayoutBounds
  arrangementSort: 'default' | 'upload'
  defaultArrangementIds: string[]
  activePage: number
  signature: string
}
const clonePages = (pages: Page[]) => typeof structuredClone === 'function' ? structuredClone(pages) : pages.map(page => ({
  ...page,
  items: page.items.map(item => ({ ...item })),
  annotations: page.annotations?.map(annotation => ({ ...annotation })),
  headerBlocks: page.headerBlocks?.map(block => ({ ...block, columns: block.columns.map(column => ({ ...column })) })),
  imageGroups: page.imageGroups?.map(group => ({ ...group,
    itemIds: [...group.itemIds],
    imageCells: group.imageCells?.map(cell => ({ ...cell })),
    details: group.details ? { ...group.details, sizes: group.details.sizes?.map(size => ({ ...size })), fields: group.details.fields?.map(field => ({ ...field })) } : group.details,
    detailGroups: group.detailGroups?.map(panel => ({ ...panel, itemIds: [...panel.itemIds], details: { ...panel.details, sizes: panel.details.sizes?.map(size => ({ ...size })), fields: panel.details.fields?.map(field => ({ ...field })) } })),
  })),
}))
const arrangementSignature = (pages: Page[], displayState: ArrangementDisplayState, layoutBounds: LayoutBounds, arrangementSort: 'default' | 'upload', defaultArrangementIds: string[]) => JSON.stringify({
  pages,
  displayState: {
    dimensionDisplayOverrides: [...displayState.dimensionDisplayOverrides],
    visualScales: [...displayState.visualScales],
    accessoryVisuals: [...displayState.accessoryVisuals],
    zoom: displayState.zoom,
  },
  layoutBounds,
  arrangementSort,
  defaultArrangementIds,
})
type Props = { initialRecord?: SchematicReviewRecord; onRecordSaved?: () => void; onWorkingChange?: (working: boolean) => void; userName?: string; onSharedRecordsChanged?: () => void }
export default function SchematicPage({ initialRecord, onRecordSaved, onWorkingChange, userName = currentSharedUser(), onSharedRecordsChanged }: Props = {}) { const [toast, context] = message.useMessage(); const [assets, setAssets] = useState<Asset[]>(initialRecord?.assets ?? []); const [batchOpen, setBatchOpen] = useState(Boolean(initialRecord)); const [loadingBatchId, setLoadingBatchId] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [dropActive, setDropActive] = useState(false); const [progress, setProgress] = useState<{ parse: ImportProgress; generate: ImportProgress }>({ parse: { phase: 'parse', completed: 0, total: 0 }, generate: { phase: 'generate', completed: 0, total: 0 } }); const [reviewOpen, setReviewOpen] = useState(false); const [confirmingReview, setConfirmingReview] = useState(false); const [externalImportPath, setExternalImportPath] = useState<string | null>(null); const [screen, setScreen] = useState<'upload' | 'arrange'>(initialRecord ? 'arrange' : 'upload'); const [uploadFromArrange, setUploadFromArrange] = useState(false); const [pages, setPages] = useState<Page[]>(initialRecord?.pages ?? []); const [activePage, setActivePage] = useState(initialRecord?.activePage ?? 1); const [selectedItem, setSelectedItem] = useState<string | null>(null); const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const assetsRef = useRef<Asset[]>(assets)
  const [arrangementSort, setArrangementSort] = useState<'default' | 'upload'>(initialRecord?.arrangementSort ?? 'default')
  const [defaultArrangementIds, setDefaultArrangementIds] = useState<string[]>(initialRecord?.defaultArrangementIds ?? [])
  const [displayState, setDisplayState] = useState(() => initialRecord ? restoreArrangementDisplay(initialRecord.display) : emptyArrangementDisplayState())
  const [sourceRecordId, setSourceRecordId] = useState(initialRecord?.id)
  const [reflowing, setReflowing] = useState(false)
  const reflowLock = useRef(false)
  const reviewIdentity = useRef<ReviewRecordIdentity | undefined>(initialRecord ? { id: initialRecord.id, sourceRecordId: initialRecord.sourceRecordId, paymentStatus: initialRecord.paymentStatus } : undefined)
  const reviewSaveNotice = useRef<(() => void) | null>(null)
  const closeReviewSaveNotice = () => { const notice = reviewSaveNotice.current; reviewSaveNotice.current = null; notice?.() }
  const exportGeneration = useRef(0)
  const exportLock = useRef(false)
  const resetArrangementDisplay = () => { setDisplayState(emptyArrangementDisplayState()); setSourceRecordId(undefined); reviewIdentity.current = undefined; exportGeneration.current++; closeReviewSaveNotice(); toast.destroy('review-save'); setLayoutBounds(loadLayoutBounds()) }
  const [category, setCategory] = useState(UNASSIGNED_PRODUCT_CATEGORY)
  const [scrollToAssetId, setScrollToAssetId] = useState<string | null>(null)
  const [arrangementPoolFocusId, setArrangementPoolFocusId] = useState<string | null>(null)
  const saveLock = useRef(false)
  const batchLoadLock = useRef(false)
  const replacementLock = useRef(false)
  const uploadLock = useRef(false)
  const [batchLoadProgress, setBatchLoadProgress] = useState<BatchLoadProgress>({ completed: 0, total: 0 })
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(initialRecord?.detachedFromBatch ? null : initialRecord?.sourceBatchId ?? null)
  const currentBatchIdRef = useRef<string | null>(currentBatchId)
  const [transferring, setTransferring] = useState(false)
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set())
  const [uploadPanelTab, setUploadPanelTab] = useState<UploadPanelTab>('upload')
  const [classifiedAssets, setClassifiedAssets] = useState<Asset[] | null>(null)
  const [reviewSelectedIds, setReviewSelectedIds] = useState<Set<string>>(new Set())
  const [classifying, setClassifying] = useState(false)
  const [batchMetadata, setBatchMetadata] = useState<BatchMetadata>(initialRecord?.metadata ?? defaultBatchMetadata)
  const [layoutBounds, setLayoutBounds] = useState<LayoutBounds>(() => initialRecord?.layoutBounds ?? loadLayoutBounds())
  const [historyTransition, setHistoryTransition] = useState<'' | 'forward' | 'back'>('')
  const [savingBatch, setSavingBatch] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<PdfExportProgress>({ phase: 'rendering', completed: 0, total: 1 })
  const [productConfigs, setProductConfigs] = useState<ProductConfig[]>([])
  const undoStack = useRef<ArrangementUndoSnapshot[]>([])
  const undoCursor = useRef<ArrangementUndoSnapshot | null>(null)
  const skipUndoCapture = useRef(false)
  const previousScreen = useRef(screen)
  const currentArrangementSnapshot = (): ArrangementUndoSnapshot => ({
    pages: clonePages(pages),
    displayState: {
      dimensionDisplayOverrides: new Map(displayState.dimensionDisplayOverrides),
      visualScales: new Map(displayState.visualScales),
      accessoryVisuals: new Map(displayState.accessoryVisuals),
      zoom: displayState.zoom,
    },
    layoutBounds: { ...layoutBounds },
    arrangementSort,
    defaultArrangementIds: [...defaultArrangementIds],
    activePage,
    signature: arrangementSignature(pages, displayState, layoutBounds, arrangementSort, defaultArrangementIds),
  })
  useEffect(() => {
    const snapshot = currentArrangementSnapshot()
    const enteringOrLeavingArrange = previousScreen.current !== screen
    previousScreen.current = screen
    if (screen !== 'arrange' || enteringOrLeavingArrange) {
      undoStack.current = []
      undoCursor.current = snapshot
      skipUndoCapture.current = false
      return
    }
    const previous = undoCursor.current
    if (!previous) {
      undoCursor.current = snapshot
      return
    }
    if (skipUndoCapture.current) {
      skipUndoCapture.current = false
      undoCursor.current = snapshot
      return
    }
    if (previous.signature !== snapshot.signature) {
      undoStack.current.push(previous)
      if (undoStack.current.length > 100) undoStack.current.shift()
    }
    // Page selection alone should not create an undo step, but the latest
    // active page must still be retained if the next edit changes content.
    undoCursor.current = snapshot
  // State setters are intentionally represented by their values here; the
  // snapshot function itself is recreated on each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, displayState, layoutBounds, arrangementSort, defaultArrangementIds, activePage, screen])
  const undoArrangement = useCallback(() => {
    const previous = undoStack.current.pop()
    if (!previous) return
    skipUndoCapture.current = true
    undoCursor.current = previous
    setPages(clonePages(previous.pages))
    setDisplayState({
      dimensionDisplayOverrides: new Map(previous.displayState.dimensionDisplayOverrides),
      visualScales: new Map(previous.displayState.visualScales),
      accessoryVisuals: new Map(previous.displayState.accessoryVisuals),
      zoom: previous.displayState.zoom,
    })
    setLayoutBounds({ ...previous.layoutBounds })
    setArrangementSort(previous.arrangementSort)
    setDefaultArrangementIds([...previous.defaultArrangementIds])
    setActivePage(previous.activePage)
    setSelectedItem(null)
    setSelectedGroupIds([])
  }, [])
  useEffect(() => {
    const undo = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || event.shiftKey || event.repeat || screen !== 'arrange') return
      if (exporting || reflowing || busy || savingBatch || transferring || confirmingReview || classifying) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="dialog"], .ant-modal, .ant-select'))) return
      if (document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) return
      if (!undoStack.current.length) return
      event.preventDefault()
      undoArrangement()
    }
    window.addEventListener('keydown', undo)
    return () => window.removeEventListener('keydown', undo)
  }, [screen, exporting, reflowing, busy, savingBatch, transferring, confirmingReview, classifying, undoArrangement])
  useEffect(() => { assetsRef.current = assets; setSelectedAssetIds(current => new Set([...current].filter(id => assets.some(asset => asset.id === id)))) }, [assets])
  useEffect(() => { currentBatchIdRef.current = currentBatchId }, [currentBatchId])
  useEffect(() => onCloudBatchSaveComplete(event => {
    if (event.id !== currentBatchIdRef.current || !Array.isArray(event.result.assets)) return
    const persisted = event.result.assets as Asset[]
    if (!persisted.length) return
    setAssets(current => { const next = mergePersistedAssetMetadata(current, persisted); assetsRef.current = next; return next })
    if (event.result.batchId) {
      currentBatchIdRef.current = event.result.batchId
      setCurrentBatchId(event.result.batchId)
    }
    if (event.result.metadata && typeof event.result.metadata === 'object') setBatchMetadata(event.result.metadata as BatchMetadata)
  }), [])
  useEffect(() => {
    let cancelled = false
    const read = () => { void loadProductConfigs().then(configs => { if (!cancelled) setProductConfigs(configs) }).catch(() => {}) }
    read()
    window.addEventListener(PRODUCT_CONFIGS_UPDATED_EVENT, read)
    return () => { cancelled = true; window.removeEventListener(PRODUCT_CONFIGS_UPDATED_EVENT, read) }
  }, [])
  useEffect(() => {
    let cancelled = false
    void loadFinishNames().then(lookup => { if (!cancelled) setFinishLookup(lookup) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  useEffect(() => { if (batchOpen && !sourceRecordId) setAssets(current => repairLegacyProductGroups(current, productConfigs)) }, [batchOpen, productConfigs, sourceRecordId])
  useEffect(() => { onWorkingChange?.(reflowing || busy || exporting || savingBatch || transferring || confirmingReview || classifying || Boolean(loadingBatchId)) }, [reflowing, busy, exporting, savingBatch, transferring, confirmingReview, classifying, loadingBatchId, onWorkingChange])
  const saveBatch = async (confirmedAssets?: Asset[], options: { background?: boolean } = {}) => {
    if (saveLock.current) throw new Error('批次正在保存，请稍候')
    const initialSavingAssets = repairLegacyProductGroups(confirmedAssets ?? assetsRef.current, productConfigs)
    if (!initialSavingAssets.length) return
    if (!isTauri()) { if (confirmedAssets) throw new Error('请在桌面软件中确认并保存'); return }
    const recordId = currentBatchId ?? crypto.randomUUID()
    if (options.background && currentBatchId) {
      const mode = await storageMode().catch(() => ({ shared: false }))
      if (mode.shared) {
        const next = { id: recordId, savedAt: new Date().toISOString(), assets: initialSavingAssets, metadata: batchMetadata }
        setAssets(initialSavingAssets)
        currentBatchIdRef.current = recordId; setCurrentBatchId(recordId)
        setBatchMetadata(batchMetadata)
        if (screen === 'arrange') setPages(current => autoArrangePages(current, activePage, assetsForArrangement(current, arrangementSort, initialSavingAssets), layoutBounds, productConfigs, [], displayState.visualScales))
        enqueueCloudBatchSave({ ...next, assets: initialSavingAssets.map(assetForPersistence) })
        return { assets: initialSavingAssets, duplicate: false, batchId: recordId, metadata: batchMetadata }
      }
    }
    saveLock.current = true
    setSavingBatch(true)
    try { await flushCloudSyncQueue() } catch (error) {
      saveLock.current = false; setSavingBatch(false)
      if (confirmedAssets) throw error
      toast.error(`同步等待失败：${String(error)}`)
      return
    }
    const savingAssets = repairLegacyProductGroups(confirmedAssets ?? assetsRef.current, productConfigs)
    if (!savingAssets.length) { saveLock.current = false; setSavingBatch(false); return }
    const record = { id: recordId, savedAt: new Date().toISOString(), assets: savingAssets, metadata: batchMetadata }
    try {
      const result = await invoke<SaveBatchResult>('save_batch', { ...record, assets: savingAssets.map(assetForPersistence) })
      clearCloudBatchSave(record.id)
      currentBatchIdRef.current = result.batchId; setCurrentBatchId(result.batchId)
      const persisted = mergePersistedAssetMetadata(savingAssets, result.assets)
      setAssets(persisted)
      if (screen === 'arrange') setPages(current => autoArrangePages(current, activePage, assetsForArrangement(current, arrangementSort, persisted), layoutBounds, productConfigs, [], displayState.visualScales))
      if (category) setSelectedAssetIds(current => new Set([...current].filter(id => persisted.some(asset => asset.id === id && matchesProductCategory(asset, category)))))
      if (category && category !== UNASSIGNED_PRODUCT_CATEGORY && !persisted.some(asset => asset.productId === category)) setCategory('')
      setBatchMetadata(result.metadata ?? batchMetadata)
      toast.success({ key: 'batch-save', content: confirmedAssets ? '图片信息已保存到历史记录' : '批次已保存到历史记录' })
      return result
    } catch (error) { if (confirmedAssets) throw error; toast.error(`保存失败：${String(error)}`) }
    finally { saveLock.current = false; setSavingBatch(false) }
  }
  const grouping = useProductGrouping({ assets, products: productConfigs, save: async next => { await saveBatch(next, { background: true }) },
    activate: (id, memberIds) => { setSelectedAssetIds(new Set(memberIds ?? (id ? [id] : []))); setScrollToAssetId(id); setUploadPanelTab('attributes') }, revealAll: (nextCategory) => setCategory(nextCategory || '') })
  const guideActive = Boolean(grouping.session)
  const confirmAttributes = async (patch: ProductAttributePatch) => {
    if (!selectedAssetIds.size || busy) return
    if (!patch.productId || patch.productId === 'a') throw new Error('请选择产品')
    const next = applyGroupedAttributePatch(assets, selectedAssetIds, patch, productConfigs)
    await saveBatch(next, { background: true })
  }
  const confirmArrangeAttributes = async (assetId: string, patch: ProductAttributePatch) => {
    if (busy || savingBatch) throw new Error('当前批次正在处理，请稍候再保存图片属性')
    if (!patch.productId || patch.productId === 'a') throw new Error('请选择产品')
    const selected = new Set([assetId])
    const before = assets.find(asset => asset.id === assetId)
    if (!before) throw new Error('未找到当前图片')
    const next = repairLegacyProductGroups(applyGroupedAttributePatch(assets, selected, patch, productConfigs), productConfigs)
    const after = next.find(asset => asset.id === assetId)
    await saveBatch(next, { background: true })
    if (!after) return
    const nextPages = autoArrangePages(pages, activePage, assetsForArrangement(pages, arrangementSort, next), layoutBounds, productConfigs, [], displayState.visualScales)
    setPages(nextPages)
    setActivePage(current => nextPages.some(page => page.id === current) ? current : nextPages[0]?.id ?? 1)
    setSelectedItem(null)
    setSelectedGroupIds([])
    toast.success('图片属性已保存并重新排列')
  }
  const showProductCategories = batchOpen && assets.length > 0
  const selectAssets = (ids: Set<string>) => {
    if (guideActive) { const id = [...ids].at(-1); if (id) grouping.selectMember(id); return }
    setSelectedAssetIds(ids)
    if (ids.size) {
      setUploadPanelTab('attributes')
      if (ids.size === 1) {
        const asset = assets.find(item => item.id === [...ids][0])
        if (asset?.productGroupId) grouping.resumeGroup(asset.id)
      }
    }
  }
  const visibleAssets = assets.filter(asset => matchesProductCategory(asset, category))
  useEffect(() => {
    if (!scrollToAssetId) return
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(scrollToAssetId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setScrollToAssetId(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [scrollToAssetId, category, visibleAssets.length])
  const changeCategory = (id: string) => { setCategory(id); setSelectedAssetIds(new Set()) }
  const discardBatch = () => { setScreen('upload'); setSelectedGroupIds([]); grouping.reset(); setUploadPanelTab('upload'); const pendingAssets = assets; setCategory(UNASSIGNED_PRODUCT_CATEGORY); setHistoryTransition('back'); setUploadFromArrange(false); setPages([]); resetArrangementDisplay(); setSelectedItem(null); setAssets([]); setSelectedAssetIds(new Set()); currentBatchIdRef.current = null; setCurrentBatchId(null); setBatchOpen(false); setBatchMetadata(defaultBatchMetadata); toast.success('已返回批次列表'); if (pendingAssets.length && isTauri()) void discardTemporaryAssets(pendingAssets).catch(e => toast.error(`临时文件清理失败：${String(e)}`)) }
  const deleteAssetsFromBatch = async (targets: Asset[]) => {
    const uniqueTargets = [...new Map(targets.map(asset => [asset.id, asset])).values()]
    if (!uniqueTargets.length || busy || savingBatch || saveLock.current || guideActive || transferring) return
    const deletedIds = new Set(uniqueTargets.map(asset => asset.id))
    const remainingAssets = assets.filter(asset => !deletedIds.has(asset.id))
    saveLock.current = true
    setBusy(true)
    let cloudQueued = false
    try {
      if (isTauri()) {
        const shared = (await storageMode()).shared
        if (shared && currentBatchId && remainingAssets.length) {
          enqueueCloudBatchSave({ id: currentBatchId, savedAt: new Date().toISOString(), assets: remainingAssets.map(assetForPersistence), metadata: batchMetadata })
          cloudQueued = true
        } else if (shared && currentBatchId) {
          clearCloudBatchSave(currentBatchId)
          await flushCloudSyncQueue()
          await invoke('delete_batch', { id: currentBatchId })
        } else if (shared) {
          await discardTemporaryAssets(uniqueTargets)
        } else {
          for (const asset of uniqueTargets) await invoke('delete_asset', { id: asset.id, batchId: currentBatchId })
        }
      }
      setAssets(current => current.filter(item => !deletedIds.has(item.id)))
      setSelectedAssetIds(current => new Set([...current].filter(id => !deletedIds.has(id))))
      setReviewSelectedIds(current => new Set([...current].filter(id => !deletedIds.has(id))))
      setClassifiedAssets(current => current ? current.filter(item => !deletedIds.has(item.id)) : current)
      if (category && !assets.some(item => !deletedIds.has(item.id) && matchesProductCategory(item, category))) setCategory('')
      toast.success(`${uniqueTargets.length === 1 ? '图片已删除' : `已删除 ${uniqueTargets.length} 张图片`}${cloudQueued ? '，云端同步中' : ''}`)
    } catch (error) { toast.error(`删除图片失败：${String(error)}`) }
    finally { saveLock.current = false; setBusy(false) }
  }
  const deleteAssetFromBatch = async (asset: Asset) => { await deleteAssetsFromBatch([asset]) }
  const deleteSelectedAssets = async () => { await deleteAssetsFromBatch(assets.filter(asset => selectedAssetIds.has(asset.id))) }
  const replaceImage = async (asset: Asset) => {
    if (replacementLock.current || busy || savingBatch || saveLock.current || guideActive || confirmingReview || classifying) return
    replacementLock.current = true
    setBusy(true)
    setDropActive(false)
    const previousTab = uploadPanelTab
    setUploadPanelTab('upload')
    setProgress({ parse: { phase: 'parse', completed: 0, total: 0 }, generate: { phase: 'generate', completed: 0, total: 0 } })
    let imported: Asset | null = null
    let replaced = false
    try {
      imported = await importReplacementAsset(next => setProgress(current => ({ ...current, [next.phase]: next })))
      if (!imported) return
      const nextAssets = replaceAssetArtwork(assets, asset.id, imported)
      const newId = imported.id
      setAssets(nextAssets)
      setSelectedAssetIds(current => replaceSelectedAssetId(current, asset.id, newId))
      setReviewSelectedIds(current => replaceSelectedAssetId(current, asset.id, newId))
      setDefaultArrangementIds(current => current.map(id => id === asset.id ? newId : id))
      setClassifiedAssets(null)
      setPages([])
      setSelectedItem(null)
      setSelectedGroupIds([])
      grouping.clearDrafts([asset.id])
      replaced = true
      await discardTemporaryAssets([asset]).catch(() => {})
      toast.success('图片已更换，尺寸和源图片信息已更新；保存批次后写入历史记录')
    } catch (error) {
      if (imported && !replaced) await discardTemporaryAssets([imported]).catch(() => {})
      toast.error(`更换图片失败：${String(error)}`)
    } finally {
      replacementLock.current = false
      setBusy(false)
      setUploadPanelTab(previousTab)
    }
  }
  const replaceCanvasImage = async (itemId: string) => {
    if (replacementLock.current || busy || savingBatch || exporting || saveLock.current) return
    replacementLock.current = true
    setBusy(true)
    let imported: Asset | null = null
    let replaced = false
    try {
      const item = pages.flatMap(page => page.items).find(value => value.id === itemId)
      const original = assets.find(asset => asset.id === item?.assetId)
      if (!original) throw new Error('需要更换的图片已不在当前示意图中')
      imported = await importReplacementAsset()
      if (!imported) return
      const next = replaceCanvasItemArtwork(assets, pages, itemId, imported, displayState.dimensionDisplayOverrides)
      const newId = imported.id
      setAssets(next.assets)
      setPages(next.pages)
      setSelectedAssetIds(current => replaceSelectedAssetId(current, original.id, newId))
      setReviewSelectedIds(current => replaceSelectedAssetId(current, original.id, newId))
      setDefaultArrangementIds(current => current.map(id => id === original.id ? newId : id))
      setClassifiedAssets(null)
      grouping.clearDrafts([original.id])
      setSelectedItem(itemId)
      setSelectedGroupIds([])
      replaced = true
      await discardTemporaryAssets([original]).catch(() => {})
      toast.success('图片已更换，图片列表已同步，排列位置已保留')
    } catch (error) {
      if (imported && !replaced) await discardTemporaryAssets([imported]).catch(() => {})
      toast.error(`更换图片失败：${String(error)}`)
    } finally {
      replacementLock.current = false
      setBusy(false)
    }
  }
  const openBatch = async (record: BatchSummary) => {
    if (batchLoadLock.current || busy || savingBatch) return
    batchLoadLock.current = true
    setBatchLoadProgress({ completed: 0, total: record.assetCount })
    grouping.reset(); setLoadingBatchId(record.id); setHistoryTransition('forward');
    try {
      const loaded = await loadHistoryBatch(record.id, setBatchLoadProgress)
      setUploadPanelTab('upload'); setCategory(UNASSIGNED_PRODUCT_CATEGORY); setUploadFromArrange(false); setPages([]); resetArrangementDisplay(); setSelectedItem(null); setAssets(repairLegacyProductGroups(loaded.assets, productConfigs)); setSelectedAssetIds(new Set()); currentBatchIdRef.current = loaded.id; setCurrentBatchId(loaded.id); setBatchMetadata(loaded.metadata ?? defaultBatchMetadata); setBatchOpen(true); toast.success('已打开历史批次')
    } catch (error) { toast.error(`历史批次加载失败：${String(error)}`) }
    finally { batchLoadLock.current = false; setLoadingBatchId(null) }
  }
  const upload = useCallback(async (droppedPath?: string, forceNewBatch = false) => {
    if (uploadLock.current || replacementLock.current || transferring || busy || savingBatch) return
    uploadLock.current = true
    const wasOpen = !forceNewBatch && batchOpen
    const importBatchId = wasOpen && currentBatchId ? currentBatchId : crypto.randomUUID()
    if (forceNewBatch) {
      grouping.reset(); setPages([]); resetArrangementDisplay(); setSelectedItem(null); setSelectedGroupIds([])
      setAssets([]); setSelectedAssetIds(new Set()); setBatchOpen(false); setBatchMetadata(defaultBatchMetadata)
      if (assets.length && isTauri()) void discardTemporaryAssets(assets).catch(() => {})
    }
    currentBatchIdRef.current = importBatchId; setCurrentBatchId(importBatchId); setBusy(true); setDropActive(false)
    setProgress({ parse: { phase: 'parse', completed: 0, total: 0 }, generate: { phase: 'generate', completed: 0, total: 0 } })
    const streamedIds = new Set<string>()
    let metadata = wasOpen ? batchMetadata : { ...defaultBatchMetadata }
    let initializedName = false
    const initializeBatchName = (imported: Asset[]) => {
      if (wasOpen || initializedName || !imported.length) return
      const fileName = (imported[0].sourceFileName || imported[0].name).split(/[\\/]/).pop() || ''
      metadata = { ...metadata, customerName: fileName.replace(/\.svg$/i, '') }
      initializedName = true; setBatchMetadata(metadata)
    }
    try {
      const imported = await importAssets(next => setProgress(current => ({ ...current, [next.phase]: next })), batch => {
        initializeBatchName(batch); batch.forEach(asset => streamedIds.add(asset.id))
        if (screen === 'arrange' && batch.length) setArrangementPoolFocusId(batch.at(-1)!.id)
        setAssets(current => { const existing = new Set(current.map(asset => asset.id)); return [...current, ...batch.filter(asset => !existing.has(asset.id))] })
        setBatchOpen(true)
      }, droppedPath)
      initializeBatchName(imported)
      if (imported.length && streamedIds.size === 0) { if (screen === 'arrange') setArrangementPoolFocusId(imported.at(-1)!.id); setAssets(current => [...current, ...imported]); setBatchOpen(true) }
      if (!imported.length) return
      try {
        if ((await storageMode()).shared) {
          const all = [...(wasOpen ? assets : []), ...imported]
          try {
            enqueueCloudBatchSave({ id: importBatchId, savedAt: new Date().toISOString(), assets: all.map(assetForPersistence), metadata })
            toast.success('图片已解析，正在后台保存到共享文件存储')
          } catch (error) { toast.error(`图片已解析，但共享保存任务未加入队列：${String(error)}`) }
        } else toast.success(wasOpen ? schematicCopy.adding : schematicCopy.creating)
      } catch (error) { toast.error(`图片已解析，但存储配置读取失败，图片已保留：${String(error)}`) }
    } catch (error) {
      if (streamedIds.size) {
        setAssets(current => current.filter(asset => !streamedIds.has(asset.id)))
        setSelectedAssetIds(current => new Set([...current].filter(id => !streamedIds.has(id))))
        if (!wasOpen) { setBatchOpen(false); currentBatchIdRef.current = null; setCurrentBatchId(null); setBatchMetadata(defaultBatchMetadata) }
      }
      toast.error(String(error))
    } finally { uploadLock.current = false; setBusy(false) }
  }, [assets, batchMetadata, batchOpen, currentBatchId, transferring, busy, savingBatch, screen, toast])
  useEffect(() => { if (!isTauri()) return; let cancelled = false; let unlisten = () => {}; const onDrop = (event: Event<DragDropEvent>) => { if ((screen !== 'upload' && screen !== 'arrange') || busy || savingBatch || transferring || guideActive) return; if (event.payload.type === 'enter' || event.payload.type === 'over') setDropActive(true); else if (event.payload.type === 'leave') setDropActive(false); else if (event.payload.type === 'drop') { setDropActive(false); const path = event.payload.paths.find(item => /\.svg$/i.test(item)); if (path) void upload(path); else toast.error('仅支持 SVG 文件') } }; void Promise.resolve().then(() => getCurrentWebview()).then(webview => webview.onDragDropEvent(onDrop)).then(stop => { if (cancelled) stop(); else unlisten = stop }).catch(() => {}); return () => { cancelled = true; unlisten() } }, [screen, busy, savingBatch, transferring, guideActive, upload, toast])
  useEffect(() => { if (!isTauri()) return; let cancelled = false; let unlisten = () => {}; void listen<{ path: string }>('external-svg-import', event => { if (cancelled) return; if (screen === 'upload') void upload(event.payload.path); else { setExternalImportPath(event.payload.path); void getCurrentWindow().setFocus().catch(() => {}) } }).then(stop => { if (cancelled) stop(); else unlisten = stop }).catch(() => {}); return () => { cancelled = true; unlisten() } }, [screen, upload])
  const externalImportDialog = <Modal open={Boolean(externalImportPath)} title="接受到新图片是否处理新批次" footer={<><Button onClick={() => setExternalImportPath(null)}>取消</Button><Button onClick={() => { const path = externalImportPath; if (!path) return; setExternalImportPath(null); setUploadFromArrange(true); setScreen('upload'); void upload(path) }}>追加当前批次</Button><Button type="primary" onClick={() => { const path = externalImportPath; if (!path) return; setExternalImportPath(null); setUploadFromArrange(true); setScreen('upload'); void upload(path, true) }}>新建批次</Button></>}><p>当前正在示意图排列页，请选择如何处理这张 SVG。</p></Modal>
  const openReview = async () => { if (!assets.length || busy || confirmingReview || classifying) return; setClassifying(true); await new Promise<void>(resolve => window.setTimeout(resolve, 120)); const classified = classifyAssetsByProductAndPrint(assets); setClassifiedAssets(classified); setReviewSelectedIds(new Set(classified.map(asset => asset.id))); setClassifying(false); setReviewOpen(true) }
  const confirmReview = async () => {
    if (confirmingReview) return
    const ordered = classifiedAssets ?? assetsRef.current
    const chosen = ordered.filter(asset => reviewSelectedIds.has(asset.id))
    if (!chosen.length) return
    if (!isTauri()) return
    setConfirmingReview(true)
    try {
      await flushCloudSyncQueue()
      const latestAssets = assetsRef.current
      const record = { id: currentBatchId ?? crypto.randomUUID(), savedAt: new Date().toISOString(), assets: latestAssets, metadata: batchMetadata }
      const result = await invoke<SaveBatchResult>('save_batch', { ...record, assets: latestAssets.map(assetForPersistence) })
      clearCloudBatchSave(record.id)
      const persisted = mergePersistedAssetMetadata(latestAssets, result.assets)
      const persistedById = new Map(persisted.map(asset => [asset.id, asset]))
      const chosenPersisted: Asset[] = []
      // Large imports arrive as metadata-only assets. Hydrate only the images
      // that are actually entering arrangement, one at a time, after the
      // batch has been safely persisted.
      for (const asset of chosen) {
        const saved = persistedById.get(asset.id) ?? asset
        const svg = saved.svg || await loadAssetSvg(saved, result.batchId)
        chosenPersisted.push({ ...saved, svg })
      }
      const chosenById = new Map(chosenPersisted.map(asset => [asset.id, asset]))
      const arrangementAssets = persisted.map(asset => chosenById.get(asset.id) ?? asset)
      const configs = productConfigs.length ? productConfigs : await loadProductConfigs().catch(() => [])
      setProductConfigs(configs); currentBatchIdRef.current = result.batchId; setCurrentBatchId(result.batchId); setAssets(arrangementAssets); setDefaultArrangementIds(chosenPersisted.map(asset => asset.id)); setArrangementSort('default'); setClassifiedAssets(null); setReviewSelectedIds(new Set()); setBatchMetadata(result.metadata ?? batchMetadata)
      const nextPages = paginateAssets(chosenPersisted, 1000, layoutBounds, configs)
      setPages(nextPages); setDisplayState(emptyArrangementDisplayState()); setSelectedItem(null); setSelectedGroupIds([]); setActivePage(1); setReviewOpen(false); setScreen('arrange')
      toast.success(result.duplicate ? `已确认 ${chosenPersisted.length} 张图片进入生产（历史批次已存在，未重复保存）` : `已确认 ${chosenPersisted.length} 张图片进入生产`)
    } catch (e) { toast.error(`保存图片失败：${String(e)}`) }
    finally { setConfirmingReview(false) }
  }
  const updatePageItem = useCallback((next: Item) => setPages(current => current.map(page => {
    if (page.id !== activePage) return page
    const previous = page.items.find(item => item.id === next.id)
    if (!previous) return page
    const updated = { ...previous, ...next }
    const items = page.items.map(item => item.id === next.id ? updated : item)
    const rulerChanged = (['rulerUnit', 'rulerWidth', 'rulerHeight', 'sizeAxis'] as const).some(key => previous[key] !== updated[key])
    // Moving, scaling or switching artwork must preserve manually edited Size.
    if (!rulerChanged || updated.suppressRuler || updated.derivedFrom) return { ...page, items }
    const asset = assets.find(asset => asset.id === updated.assetId)
    const override = displayState.dimensionDisplayOverrides.get(updated.id)
    const size = asset ? rulerDimensionLabel(asset, updated, override?.precision, override?.decimalPlaces) : undefined
    if (!size) return { ...page, items }
    const updateDetails = (details: NonNullable<Page['imageGroups']>[number]['details'], itemIds: string[]) => {
      if (!details || !itemIds.includes(updated.id)) return details
      const primary = itemIds.find(id => items.some(item => item.id === id && !item.derivedFrom))
      return { ...details, size: primary === updated.id ? size : details.size,
        sizes: details.sizes?.map(value => value.itemId === updated.id ? { ...value, label: size } : value) }
    }
    return { ...page, items, imageGroups: page.imageGroups?.map(group => ({ ...group,
      details: updateDetails(group.details, group.itemIds),
      detailGroups: group.detailGroups?.map(panel => ({ ...panel, details: updateDetails(panel.details, panel.itemIds)! })),
    })) }
  })), [activePage, assets, displayState.dimensionDisplayOverrides])
  const changeRuler: RulerChange = useCallback((itemId, patch) => setPages(current => current.map(page => page.id === activePage ? { ...page, items: page.items.map(item => item.id === itemId ? { ...item, ...patch } : item) } : page)), [activePage])
  const editCanvasText: EditImageGroupText = useCallback((itemIds, target, value) => setPages(current => current.map(page => page.id === activePage ? {
    ...page,
    imageGroups: page.imageGroups?.map(group => {
      const updateDetails = (details: NonNullable<typeof group.details>, ids: string[]) => {
        if (!ids.some(id => itemIds.includes(id))) return details
        if (target === 'size') return { ...details, size: value, sizes: details.sizes?.map(entry => itemIds.includes(entry.itemId) ? { ...entry, label: value } : entry) }
        if (target.startsWith('field:')) {
          const key = target.slice('field:'.length)
          return { ...details, fields: details.fields?.map(field => field.key === key ? { ...field, text: value } : field) }
        }
        if (target === 'heading' || target === 'qt' || target === 'finish' || target === 'note' || target === 'accessoryCode') return { ...details, [target]: value }
        return details
      }
      const details = group.details ? updateDetails(group.details, group.itemIds) : group.details
      const detailGroups = group.detailGroups?.map(panel => ({ ...panel, details: updateDetails(panel.details, panel.itemIds) }))
      return details === group.details && detailGroups === group.detailGroups ? group : { ...group, details, detailGroups }
    }),
  } : page)), [activePage])
  const changeLayoutBounds = (value: LayoutBounds) => {
    const next = normalizeLayoutBounds(value)
    try {
      const nextPages = autoArrangePages(pages, activePage, assetsForArrangement(pages, arrangementSort), next, productConfigs, [], displayState.visualScales)
      setLayoutBounds(next)
      setPages(nextPages)
      if (!nextPages.some(page => page.id === activePage)) setActivePage(nextPages.at(-1)?.id ?? 1)
      setSelectedItem(null)
      setSelectedGroupIds([])
      try { saveLayoutBounds(next) }
      catch (error) { toast.warning(`排列区域已应用，但未能保存到本机：${String(error)}`) }
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
  const usedIds = new Set(pages.flatMap(page => page.items.flatMap(item => [item.assetId, item.arrangementSourceAssetId ?? item.assetId])))
  const allAssetsSelected = visibleAssets.length > 0 && visibleAssets.every(asset => selectedAssetIds.has(asset.id))
  const itemAtDropPoint = (page: Page, x: number, y: number) => {
    const pointInItem = (item: Item) => {
      const display = itemForCanvasDisplay(item, displayState.visualScales.get(item.id) ?? 1)
      const angle = -(display.rotation ?? 0) * Math.PI / 180
      const dx = x - display.x, dy = y - display.y
      const localX = dx * Math.cos(angle) - dy * Math.sin(angle)
      const localY = dx * Math.sin(angle) + dy * Math.cos(angle)
      return Math.abs(localX) <= display.w / 2 && Math.abs(localY) <= display.h / 2
    }
    const direct = [...page.items].reverse().find(pointInItem)
    if (direct) return direct
    for (const group of [...imageGroupsForPage(page)].reverse()) {
      const cell = group.imageCells?.find(value => group.itemIds.includes(value.itemId)
        && x >= value.x && x <= value.x + value.width && y >= value.y && y <= value.y + value.height)
      const cellItem = cell && page.items.find(item => item.id === cell.itemId)
      if (cellItem) return cellItem
      if (x >= group.x && x <= group.x + group.width && y >= group.y && y <= group.y + (group.backgroundHeight ?? group.height)) {
        const groupItems = group.itemIds.map(id => page.items.find(item => item.id === id)).filter(Boolean) as Item[]
        const groupItem = groupItems.find(item => !item.derivedFrom) ?? groupItems.at(-1)
        if (groupItem) return groupItem
      }
    }
    return undefined
  }
  const addAssetToPage = (assetId: string, x?: number, y?: number) => {
    if (usedIds.has(assetId)) return
    const asset = assets.find(item => item.id === assetId)
    if (!asset) return
    const currentPage = pages.find(page => page.id === activePage)
    const target = currentPage && x !== undefined && y !== undefined ? itemAtDropPoint(currentPage, x, y) : undefined
    if (target) {
      try {
        setPages(current => replaceCanvasItemWithAsset(current, target.id, asset, displayState.dimensionDisplayOverrides))
        setSelectedItem(target.id)
        setSelectedGroupIds([])
        toast.success('图片已替换，原图片已回到图片池')
      } catch (error) { toast.error(String(error)) }
      return
    }
    try {
      const nextPages = autoArrangePages(pages, activePage, assetsForArrangement(pages, arrangementSort), layoutBounds, productConfigs, [assetId], displayState.visualScales)
      setPages(nextPages)
      setActivePage(nextPages.find(page => page.items.some(item => item.assetId === assetId))?.id ?? 1)
    } catch (error) { toast.error(String(error)) }
  }
  const deleteCanvasGroups = (ids: string[]) => {
    setPages(current => removeCanvasGroups(current, ids))
    setSelectedItem(null)
    setSelectedGroupIds([])
  }
  const deleteCanvasItems = (ids: string[]) => {
    setPages(current => removeCanvasItems(current, ids))
    setSelectedItem(null)
    setSelectedGroupIds([])
  }
  const reorderPages = (source: number, target: number) => setPages(current => {
    const from = current.findIndex(page => page.id === source), to = current.findIndex(page => page.id === target)
    if (from < 0 || to < 0 || from === to) return current
    const next = [...current]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); return next
  })
  const horizontalGroup = async (itemId: string) => {
    if (reflowLock.current || exportLock.current || busy) return
    const currentPage = pages.find(page => page.id === activePage)
    const group = currentPage && imageGroupsForPage(currentPage).find(group => group.itemIds.includes(itemId))
    if (!group) return
    reflowLock.current = true; setReflowing(true)
    try {
      const request = createHorizontalGroupReflowRequest(pages, activePage, group.id, layoutBounds, displayState.visualScales)
      const plan = await calculateHorizontalReflow(request)
      const next = applyHorizontalGroupReflow(pages, plan)
      setPages(current => current === pages ? next : current)
      setActivePage(plan.horizontal.pageId); setSelectedItem(itemId); setSelectedGroupIds([])
    } catch (error) { toast.error(`横排失败：${String(error)}`) }
    finally { reflowLock.current = false; setReflowing(false) }
  }
  const resizeGroup = async (groupId: string, rect: GroupRect) => {
    if (reflowLock.current || exportLock.current || busy) return
    reflowLock.current = true; setReflowing(true)
    try {
      await new Promise<void>(resolve => window.setTimeout(resolve, 0))
      const next = resizeGroupPages(pages, activePage, groupId, rect, layoutBounds, displayState.visualScales)
      setPages(current => current === pages ? next : current)
      const destination = next.find(page => page.imageGroups?.some(group => group.id === groupId))
      if (destination) { setActivePage(destination.id); setSelectedItem(null); setSelectedGroupIds([groupId]) }
    } catch (error) { toast.error(`调整块大小失败：${String(error)}`) }
    finally { reflowLock.current = false; setReflowing(false) }
  }
  const addPage = () => { const id = Math.max(0, ...pages.map(page => page.id)) + 1; setPages(current => [...current, { id, name: `页面 ${id}`, items: [] }]); setActivePage(id) }
  const selectGroup = (id: string, ctrlKey: boolean) => {
    setSelectedItem(null)
    if (!ctrlKey) { setSelectedGroupIds([id]); return }
    setSelectedGroupIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }
  const combineSelectedGroups = () => {
    if (selectedGroupIds.length < 2 || reflowLock.current || exportLock.current || busy) return
    try {
      const selections = selectedGroupIds.map(groupId => pages.flatMap(page => (page.imageGroups ?? []).map(group => ({ pageId: page.id, groupId: group.id }))).find(selection => selection.groupId === groupId)).filter(Boolean) as { pageId: number; groupId: string }[]
      const next = combineImageGroupsAcrossPages(pages, selections, assets)
      const combined = next.flatMap(page => page.imageGroups ?? []).find(group => !pages.some(page => page.imageGroups?.some(previous => previous.id === group.id)))
      const start = Math.min(...selections.map(selection => next.findIndex(page => page.id === selection.pageId)))
      const nextPages = autoArrangePages(next, start, assetsForArrangement(next, arrangementSort), layoutBounds, productConfigs, [], displayState.visualScales)
      setPages(nextPages)
      const destination = combined && nextPages.find(page => page.imageGroups?.some(group => group.id === combined.id))
      if (destination) setActivePage(destination.id)
      setSelectedGroupIds(destination && combined ? [combined.id] : [])
      setSelectedItem(null)
      toast.success(`已组合 ${selections.length} 组图片，可继续选择其他组进行组合`)
    } catch (error) { toast.error(String(error)) }
  }
  const assetsForArrangement = (sourcePages: Page[], mode: 'default' | 'upload', sourceAssets: Asset[] = assets) => {
    if (mode === 'upload') return sourceAssets
    const order = new Map<string, number>(defaultArrangementIds.map((id, index) => [id, index]))
    let index = 0
    for (const page of sourcePages) for (const item of page.items) {
      const sourceId = item.arrangementSourceAssetId ?? item.assetId
      if (!item.derivedFrom && !order.has(sourceId)) order.set(sourceId, defaultArrangementIds.length + index++)
    }
    if (!defaultArrangementIds.length) return classifyAssetsByProductAndPrint(sourceAssets)
    return [...sourceAssets].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }
  const autoArrange = (requestedMode: 'default' | 'upload' = arrangementSort) => {
    try {
      setArrangementSort(requestedMode)
      const orderedAssets = assetsForArrangement(pages, requestedMode)
      const nextPages = autoArrangePages(pages, activePage, orderedAssets, layoutBounds, productConfigs, [], displayState.visualScales)
      setPages(nextPages)
      if (!nextPages.some(page => page.id === activePage)) setActivePage(nextPages.at(-1)?.id ?? 1)
      setSelectedItem(null)
      setSelectedGroupIds([])
    }
    catch (error) { toast.error(String(error)) }
  }
  const exportCurrent = async (format: 'jpg' | 'png' | 'svg' | 'pdf', displayOverrides: ReadonlyMap<string, DimensionDisplayOverride>) => {
    if (exportLock.current || reflowLock.current) return
    const page = pages.find(item => item.id === activePage)
    if (!page) return
    exportLock.current = true
    setExportProgress({ phase: 'rendering', completed: 0, total: format === 'pdf' ? pages.length : 1 })
    setExporting(true)
    try {
      const output = await save({ defaultPath: exportFileName(assets, format), filters: [{ name: format.toUpperCase(), extensions: [format] }] })
      if (!output) return
      const generation = ++exportGeneration.current
      closeReviewSaveNotice()
      toast.destroy('review-save')
      const record = createReviewRecord({ assets, pages, activePage, metadata: batchMetadata, layoutBounds, arrangementSort, defaultArrangementIds, sourceBatchId: currentBatchId ?? undefined }, displayState, format, output, reviewIdentity.current)
      // Reserve one ID even when the file succeeds but persisting its review needs a retry.
      reviewIdentity.current = { id: record.id, sourceRecordId: record.sourceRecordId, paymentStatus: record.paymentStatus }
      const result = await exportAndRecord(record, () => format === 'pdf'
        ? exportPdf(pages, assets, output, batchMetadata, setExportProgress, displayOverrides, layoutBounds, displayState.accessoryVisuals, displayState.visualScales)
        : exportPage({ ...page, id: pages.findIndex(candidate => candidate.id === page.id) + 1 }, assets, output, format, batchMetadata, pages.length, displayOverrides, layoutBounds, displayState.accessoryVisuals, displayState.visualScales))
      if (result.saved) {
        // The failed-save notice can be created while the export is in flight.
        // Clear it after the persistence result is known so a successful retry
        // or subsequent export cannot leave a stale action in the UI.
        closeReviewSaveNotice()
        toast.destroy('review-save')
        onRecordSaved?.()
        toast.success({ key: 'review-save', content: '导出完成，已保存到示意图审核' })
      } else {
        const retry = async () => {
          if (exportLock.current || generation !== exportGeneration.current) return
          exportLock.current = true
          setExporting(true)
          try { await saveReviewRecord(record); onRecordSaved?.(); closeReviewSaveNotice(); toast.success({ key: 'review-save', content: '审核记录已保存' }) }
          catch (error) { toast.error(`审核记录保存失败：${String(error)}`) }
          finally { exportLock.current = false; setExporting(false) }
        }
        reviewSaveNotice.current = toast.error({ key: 'review-save', duration: 0, content: <span>文件已导出，审核记录保存失败：{String(result.error)} <Button size="small" onClick={() => void retry()}>重试保存记录</Button></span> })
      }
    } catch (error) { toast.error(String(error)) }
    finally { exportLock.current = false; setExporting(false) }
  }
  if (screen === 'arrange') return <ProductGroupingContext.Provider value={grouping}>{externalImportDialog}<ArrangePage onChangePage={next => setPages(current => current.map(page => page.id === next.id ? next : page))} onReorderPages={reorderPages} onBackgroundChange={(scope, color, ids) => setPages(current => recolorBackground(current, activePage, ids, scope, color))} onHorizontalGroup={itemId => void horizontalGroup(itemId)} onResizeGroup={(groupId, rect) => void resizeGroup(groupId, rect)} processingLabel={reflowing ? '正在调整块布局及后续页面…' : undefined} displayState={displayState} onDisplayStateChange={setDisplayState} context={context} assets={assets} pages={pages} activePage={activePage} selectedItem={selectedItem} selectedGroupIds={selectedGroupIds} sortMode={arrangementSort} onSelectPage={id => { setActivePage(id); setSelectedItem(null) }} onSelectItem={id => { setSelectedItem(id); setSelectedGroupIds([]) }} onSelectGroup={selectGroup} onChangeRulers={(ids, patch) => setPages(current => current.map(page => page.id === activePage ? updateSelectedRulers(page, ids, patch, new Map(assets.map(asset => [asset.id, asset]))) : page))} onChangeRuler={changeRuler} onEditText={editCanvasText} onChangeItem={updatePageItem} onReplaceArtwork={replaceCanvasImage} replacingArtwork={busy || reflowing} onDropAsset={addAssetToPage} onUpload={() => void upload()} uploadDropActive={dropActive} poolFocusAssetId={arrangementPoolFocusId} onDeleteGroups={deleteCanvasGroups} onDeleteItems={deleteCanvasItems} onConfirmAssetAttributes={confirmArrangeAttributes} onAddPage={addPage} onAutoArrange={autoArrange} onCombine={combineSelectedGroups} onBack={() => { setSelectedGroupIds([]); setUploadFromArrange(true); setScreen('upload') }} onBackToHistory={discardBatch} onExport={exportCurrent} exporting={exporting} exportProgress={exportProgress} metadata={batchMetadata} onMetadataChange={value => setBatchMetadata(current => ({ ...current, ...value }))} layoutBounds={layoutBounds} onBoundsChange={changeLayoutBounds} onAddHeaderBlock={addHeaderBlock} onChangeHeaderBlock={changeHeaderBlock} onRemoveHeaderBlock={removeHeaderBlock}/></ProductGroupingContext.Provider>
  return <ProductGroupingContext.Provider value={grouping}>{externalImportDialog}<main className={`product-upload-page ${showProductCategories ? 'has-product-categories' : ''} ${uploadFromArrange ? 'upload-page-enter-left' : ''} history-transition-${historyTransition}`}>{context}{showProductCategories && <ProductCategoryNav assets={assets} products={productConfigs} value={category} onChange={changeCategory} disabled={busy || savingBatch || guideActive}/>}<section className="uploaded-assets-panel" inert={savingBatch || transferring}><div className="upload-page-title">{batchOpen && <Button className="batch-back-button" type="text" icon={<ArrowLeft size={18}/>} aria-label="返回批次列表" title="返回批次列表并清除未保存内容" onClick={discardBatch} disabled={busy || savingBatch || confirmingReview || classifying || guideActive}/>}<div><h1>{batchOpen ? '当前批次图片' : schematicCopy.recent}</h1>{batchOpen ? <Tag color="blue">共 {assets.length} 张</Tag> : <p>默认不加载历史记录，请直接上传图片。</p>}</div>{batchOpen && <div className="batch-summary"><Button type="default" size="small" onClick={() => selectAssets(allAssetsSelected ? new Set() : new Set(visibleAssets.map(asset => asset.id)))} disabled={!assets.length || busy || savingBatch || confirmingReview || classifying || guideActive}>{allAssetsSelected ? '取消全选' : '全选'}</Button><Popconfirm title={`删除选中的 ${selectedAssetIds.size} 张图片？`} description="删除后将从当前批次中移除，无法在列表中恢复。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void deleteSelectedAssets()}><Button type="default" danger size="small" icon={<Trash2 size={14}/>} aria-label="删除选中图片" disabled={!selectedAssetIds.size || busy || savingBatch || transferring || confirmingReview || classifying || guideActive || grouping.saving}>删除</Button></Popconfirm><Button type="default" size="small" onClick={() => guideActive ? grouping.cancelGuide() : setSelectedAssetIds(new Set())} title={guideActive ? "退出引导并放弃未保存的修改，保留已保存内容" : undefined} disabled={!selectedAssetIds.size || busy || savingBatch || confirmingReview || classifying || grouping.saving}>取消选择</Button><Button type="primary" size="small" loading={savingBatch} onClick={() => void (guideActive ? grouping.persist(false) : saveBatch())} disabled={!assets.length || busy || savingBatch || confirmingReview || classifying || grouping.saving}>保存批次</Button></div>}</div>{batchOpen && <UploadImageList assets={visibleAssets} allAssets={assets} products={productConfigs} selectedIds={selectedAssetIds} onSelectionChange={selectAssets} disabled={busy || savingBatch || transferring} onDelete={deleteAssetFromBatch} onReplace={replaceImage} batchId={currentBatchId ?? undefined}/>}<BatchHistoryPanel active={!batchOpen} openingId={loadingBatchId} progress={batchLoadProgress} onOpen={record => void openBatch(record)} userName={userName} onSharedRecordsChanged={onSharedRecordsChanged} onTransferringChange={setTransferring}/></section><div className="upload-column"><UploadPanel busy={busy || savingBatch || transferring || Boolean(loadingBatchId)} dropActive={dropActive} progress={progress} metadata={batchMetadata} onMetadataChange={setBatchMetadata} onUpload={() => void upload()} batchOpen={batchOpen} activeTab={uploadPanelTab} onTabChange={setUploadPanelTab} selectedAssetIds={selectedAssetIds} onConfirmAttributes={confirmAttributes} assets={assets}/><Button className="generate-schematic-button" type="primary" size="large" icon={classifying ? <Loading size="small" inline /> : undefined} disabled={!assets.length || busy || savingBatch || confirmingReview || classifying || guideActive} onClick={() => void openReview()}>{classifying ? '正在分类…' : '生成示意图'}</Button></div><ReviewAssetPicker open={reviewOpen} assets={orderAssetsByProductGroup(assets)} batchId={currentBatchId ?? undefined} selectedIds={reviewSelectedIds} confirming={confirmingReview} onChange={setReviewSelectedIds} onCancel={() => { if (!confirmingReview) { setReviewOpen(false); setClassifiedAssets(null); setReviewSelectedIds(new Set()) } }} onConfirm={() => void confirmReview()} /></main></ProductGroupingContext.Provider> }




















