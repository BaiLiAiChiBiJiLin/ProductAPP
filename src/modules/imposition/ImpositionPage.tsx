import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, ConfigProvider, Drawer, Dropdown, Input, Pagination, Popconfirm, Popover, Select, Switch, Table, Tag, Tooltip, theme } from 'antd'
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import zhCN from 'antd/es/locale/zh_CN'
import { ArrowLeft, Download, ChevronDown, Hand, Layers, MousePointer2, RefreshCw, SlidersHorizontal, ZoomIn, ZoomOut } from 'lucide-react'
import { deleteImpositionImport, forgetImpositionGeometry, expandImpositionImages, getImpositionQuantity, impositionImageId, listPendingImpositions, loadImpositionGeometry, loadImpositionJob, packImpositionIrregular, returnImpositionToReview, updateImpositionImageQuantity, updateImpositionImageQuantities, type ImpositionJob, type ImpositionListResult, type ImpositionRecord, type ProductionImage } from './impositionRecords'
import ImpositionKonvaCanvas, { type PackedImpositionItem } from './ImpositionKonvaCanvas'
import ImpositionPdfExportModal from './ImpositionPdfExportModal'
import ImpositionUpload from './ImpositionUpload'
import ImpositionLayoutPresets from './ImpositionLayoutPresets'
import { useImpositionLayoutPresets } from './useImpositionLayoutPresets'
import ImpositionImagePickerModal from './ImpositionImagePickerModal'
import ImpositionPools from './ImpositionPools'
import { poolStorageKey } from './impositionPoolStore'
import { useImpositionThreads } from './useImpositionThreads'
import { zoomAtPointer } from './zoomAtPointer'
import { groupRepeatedPackingPages, summarizePackingResult, type PackingObjective, type PackingPlan } from './packingAlgorithms'
import type { PackingEdit } from './packingEdits'
import { repackTemplatePlan } from './templatePlanRepack'
import { comparePackingStrategies, PACKING_STRATEGIES, type PackingChoice } from './packingComparison'
import type { NestResult, NestTemplateRepack } from './impositionRecords'
import ModulePage from '../../components/ModulePage'
import Loading from '../../components/Loading'
import './imposition.css'

type WorkspaceProps = { jobs: ImpositionJob[]; initialPoolRecords?: ImpositionRecord[]; temporaryRecords: ImpositionRecord[]; onImported: (record: ImpositionRecord) => void; onRemoveImported: (id: string) => void; activeJobId?: string; onBack: () => void; onSelectJob: (id: string) => void; onReturn: (id: string) => void; returningId?: string; loading: boolean }
const EMPTY_IMPOSITION_IMAGES: ProductionImage[] = []
const EMPTY_PACKED_PAGES: PackingPlan['pages'] = []
type PackingProgressStage = 'outline' | 'prepare' | 'search' | 'validate' | 'render'
const PACKING_PROGRESS_COPY: Record<PackingProgressStage, { title: string; detail: string; progress: number }> = {
  outline: { title: '提取轮廓并识别线条 SVG', detail: '正在提取 SVG 轮廓，只有线条的 SVG 将单独开版拼版…', progress: 12 },
  prepare: { title: '准备异形排版数据', detail: '正在合并 QT 数量、间距和板材有效区域…', progress: 25 },
  search: { title: '搜索异形排版方案', detail: '正在尝试旋转、碰撞检测和空隙填充；复杂任务会继续计算，不会因固定时限停止…', progress: 46 },
  validate: { title: '校验排版结果', detail: '正在检查边界、图片间距和未放置图片…', progress: 88 },
  render: { title: '加载排版预览', detail: '正在加载已放置的原图并准备画布…', progress: 96 },
}
function ImpositionWorkspace({ jobs, initialPoolRecords, temporaryRecords, onImported, onRemoveImported, activeJobId, onBack, onSelectJob, onReturn, returningId, loading }: WorkspaceProps) {
  const isDevelopment = import.meta.env.DEV
  const [details, setDetails] = useState<Record<string, ImpositionRecord>>(() => Object.fromEntries((initialPoolRecords ?? []).map(record => [record.id, record])))
  const [imagePolygons, setImagePolygons] = useState<Record<string, Array<[number, number]>>>({})
  const [invalidOutlineIds, setInvalidOutlineIds] = useState<Set<string>>(() => new Set())
  const [selectedByJob, setSelectedByJob] = useState<Record<string, string[]>>(() => Object.fromEntries((initialPoolRecords ?? []).map(record => [record.id, record.images.map(image => image.id)])))
  const [imagePickerJobId, setImagePickerJobId] = useState<string>()
  const [loadingJobIds, setLoadingJobIds] = useState<Set<string>>(() => new Set())
  const [uploading, setUploading] = useState(false)
  const recordRequests = useRef(new Map<string, Promise<ImpositionRecord>>())
  const [deletingJobId, setDeletingJobId] = useState<string>()
  const deleteLock = useRef(false)
  const calculateLock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; comparisonResults.current.clear() } }, [])
  const [outlineErrorCount, setOutlineErrorCount] = useState(0)
  const [detailError, setDetailError] = useState('')
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, number>>({})
  const [quantitySavingId, setQuantitySavingId] = useState<string>()
  const quantityLock = useRef(false)
  const [zoom, setZoom] = useState(1)
  const [selectedImageId, setSelectedImageId] = useState<string>()
  const committedPages = useRef<PackedImpositionItem[][] | undefined>(undefined)
  const [interactionHint, setInteractionHint] = useState('')
  const [exportSnapshot, setExportSnapshot] = useState<{ pages: PackingPlan['pages']; sources: Record<string, string>; geometry: { polygons: typeof imagePolygons; region: { left: number; top: number; right: number; bottom: number }; spacing: number } }>()
  const [panMode, setPanMode] = useState(false)
  const [spacePressed, setSpacePressed] = useState(false)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [sortMode, setSortMode] = useState<'customer' | 'time'>('customer')
  const layoutPresets = useImpositionLayoutPresets()
  const layout = layoutPresets.layout
  const [allowBaseMixing, setAllowBaseMixing] = useState(true)
  const [debugSettingsOpen, setDebugSettingsOpen] = useState(false)
  const [packingObjective, setPackingObjective] = useState<PackingObjective | 'all'>('all')
  const [activeObjective, setActiveObjective] = useState<PackingObjective>('least-cutting')
  const [packingChoices, setPackingChoices] = useState<PackingChoice[]>([])
  // Unopened choices retain lightweight solver coordinates. Only a selected
  // choice expands into canvas pages; retain its edits when switching away.
  const comparisonResults = useRef(new Map<PackingObjective, NestResult | PackingPlan>())
  const comparisonBatch = useRef({ index: 0, total: 1 })
  const [comparisonStep, setComparisonStep] = useState('')
  const computeThreads = useImpositionThreads(!isDevelopment)
  const [allSheetsExpanded, setAllSheetsExpanded] = useState(false)
  const [packingLoading, setPackingLoading] = useState(false)
  const [packingProgressStage, setPackingProgressStage] = useState<PackingProgressStage>('outline')
  const [packingProgress, setPackingProgress] = useState(0)
  const [packingElapsedMs, setPackingElapsedMs] = useState(0)
  const [packingProgressDetail, setPackingProgressDetail] = useState('')
  const [packingProgressCounts, setPackingProgressCounts] = useState({ completed: 0, total: 0 })
  const progressEventAtRef = useRef(0)
  const packingProgressStageRef = useRef<PackingProgressStage>('outline')
  const panRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | undefined>(undefined)
  const canvasRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef<{ x: number; y: number } | undefined>(undefined)
  const displayJobs = useMemo(() => [...jobs].sort((left, right) => sortMode === 'customer' ? (left.customerName || '').localeCompare(right.customerName || '') : new Date(right.submittedAt).getTime() - new Date(left.submittedAt).getTime()), [jobs, sortMode])
  const activeJob = displayJobs.find(job => job.id === activeJobId) ?? displayJobs[0]
  const ensureRecord = (id: string): Promise<ImpositionRecord> => {
    const existing = details[id] ?? temporaryRecords.find(record => record.id === id)
    if (existing) return Promise.resolve(existing)
    const pending = recordRequests.current.get(id)
    if (pending) return pending
    setLoadingJobIds(current => new Set([...current, id]))
    const request = loadImpositionJob(id).then(record => {
      if (mounted.current) setDetails(current => ({ ...current, [record.id]: record }))
      return record
    }).finally(() => {
      recordRequests.current.delete(id)
      if (mounted.current) setLoadingJobIds(current => { const next = new Set(current); next.delete(id); return next })
    })
    recordRequests.current.set(id, request)
    return request
  }
  useEffect(() => {
    setDetails(current => ({ ...current, ...Object.fromEntries(temporaryRecords.map(record => [record.id, record])) }))
  }, [temporaryRecords])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.code === 'Space' && !event.repeat && !(event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable=true], [role=dialog]'))) { event.preventDefault(); setSpacePressed(true) } }
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpacePressed(false) }
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])
  const updateZoom = (delta: number, pointer = pointerRef.current) => {
    const nextZoom = Math.max(.6, Math.min(5, Number((zoom + delta).toFixed(1))))
    const canvas = canvasRef.current
    if (!canvas || nextZoom === zoom) return
    const viewport = { width: canvas.clientWidth, height: canvas.clientHeight }
    const scene = { width: 4 * boardWidth * boardScale + 3 * 24, height: Math.max(1, Math.ceil(displayedSheetCount / 4)) * (boardHeight * boardScale + 24) - 24 }
    setPanOffset(zoomAtPointer(pointer ?? { x: viewport.width / 2, y: viewport.height / 2 }, panOffset, zoom, nextZoom, viewport, scene))
    setZoom(nextZoom)
  }
  const onCanvasWheel = (event: ReactWheelEvent<HTMLDivElement>) => { if (!event.ctrlKey) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top }; pointerRef.current = pointer; updateZoom(event.deltaY > 0 ? -.1 : .1, pointer) }
  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => { if (!(panMode || spacePressed)) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); panRef.current = { x: event.clientX, y: event.clientY, offsetX: panOffset.x, offsetY: panOffset.y } }
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => { const rect = event.currentTarget.getBoundingClientRect(); pointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }; if (!panRef.current) return; event.preventDefault(); setPanOffset({ x: panRef.current.offsetX + event.clientX - panRef.current.x, y: panRef.current.offsetY + event.clientY - panRef.current.y }) }
  const onCanvasPointerUp = () => { panRef.current = undefined }

  useEffect(() => {
    if (!activeJob || details[activeJob.id]) return
    void ensureRecord(activeJob.id).catch(reason => { if (mounted.current) setDetailError(`加载拼版图片失败：${String(reason)}`) })
  }, [activeJob?.id])
  const toggleImage = (jobId: string, imageId: string, checked: boolean) => {
    if (packingLoading || uploading || deleteLock.current) return
    setSelectedByJob(current => ({
      ...current,
      [jobId]: checked
        ? [...new Set([...(current[jobId] ?? []), imageId])]
        : (current[jobId] ?? []).filter(id => id !== imageId),
    }))
  }
  const toggleImages = (jobId: string, imageIds: string[], checked: boolean) => {
    if (packingLoading || uploading || deleteLock.current) return
    setSelectedByJob(current => {
      const next = new Set(current[jobId] ?? [])
      imageIds.forEach(imageId => checked ? next.add(imageId) : next.delete(imageId))
      return { ...current, [jobId]: [...next] }
    })
  }
  const openImagePicker = (id: string) => {
    if (packingLoading || uploading || deleteLock.current) return
    setDetailError('')
    onSelectJob(id)
    setImagePickerJobId(id)
    void ensureRecord(id).catch(reason => setDetailError(`加载拼版图片失败：${String(reason)}`))
  }
  const selectJob = async (id: string, checked: boolean) => {
    if (packingLoading || uploading || deleteLock.current) return
    try {
      const record = await ensureRecord(id)
      if (!mounted.current) return
      setSelectedByJob(current => ({ ...current, [id]: checked ? record.images.map(image => image.id) : [] }))
    } catch (reason) { setDetailError(`加载拼版图片失败：${String(reason)}`) }
  }
  const qualifiedImages = useRef(new Map<string, { original: ProductionImage; qualified: ProductionImage }>())
  const selectedImagesRef = useRef<ProductionImage[]>(EMPTY_IMPOSITION_IMAGES)
  const images = useMemo(() => {
    const next = jobs.flatMap(job => (details[job.id]?.images ?? EMPTY_IMPOSITION_IMAGES)
      .filter(image => selectedByJob[job.id]?.includes(image.id))
      .map(image => {
        const id = impositionImageId(job.id, image.id)
        const cached = qualifiedImages.current.get(id)
        if (cached?.original === image) return cached.qualified
        const qualified = { ...image, id }
        qualifiedImages.current.set(id, { original: image, qualified })
        return qualified
      }))
    const previous = selectedImagesRef.current
    if (next.length === previous.length && next.every((image, index) => image === previous[index])) return previous
    selectedImagesRef.current = next
    return next
  }, [jobs, details, selectedByJob])
  const packingImages = useMemo(() => expandImpositionImages(images), [images])
  const [backendPlan, setBackendPlan] = useState<PackingPlan>()
  useEffect(() => {
    packingProgressStageRef.current = packingProgressStage
  }, [packingProgressStage])
  useEffect(() => {
    if (!packingLoading) return
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startedAt
      setPackingElapsedMs(elapsed)
      // Once the engine reports real work, keep that measured progress while
      // the next contour/template is computing instead of racing to 86%.
      if (progressEventAtRef.current > 0) return
      const stage = PACKING_PROGRESS_COPY[packingProgressStageRef.current]
      const dynamicProgress = packingProgressStageRef.current === 'search'
        ? Math.min(86, stage.progress + elapsed / 1000 * 1.4)
        : stage.progress
      const { index, total } = comparisonBatch.current
      setPackingProgress(total > 1 ? 25 + Math.round(75 * (index + Math.min(95, dynamicProgress) / 100) / total) : Math.max(1, Math.round(dynamicProgress)))
    }, 200)
    return () => window.clearInterval(timer)
  }, [packingLoading])
  useEffect(() => {
    if (!packingLoading) return
    let cancelled = false
    let unlisten = () => {}
    const stageForPhase: Record<string, PackingProgressStage> = {
      starting: 'prepare', validating: 'outline', nesting: 'search', finalizing: 'validate', completed: 'render', failed: 'validate',
      geometry: 'outline', search: 'search', validation: 'validate',
    }
    void listen<{ phase: string; detail: string; percent: number; completed: number; total: number; algorithm: string }>('imposition-progress', event => {
      if (cancelled) return
      const payload = event.payload
      if (payload.algorithm && payload.algorithm !== 'local-tools') return
      progressEventAtRef.current = Date.now()
      const stage = stageForPhase[payload.phase]
      if (stage) setPackingProgressStage(stage)
      if (payload.detail) setPackingProgressDetail(payload.detail)
      if (Number.isFinite(payload.completed) && Number.isFinite(payload.total)) setPackingProgressCounts({ completed: payload.completed, total: payload.total })
      const reported = Number(payload.percent)
      if (Number.isFinite(reported)) {
        const ranges: Record<PackingProgressStage, [number, number]> = { outline: [8, 25], prepare: [25, 34], search: [34, 82], validate: [82, 94], render: [94, 99] }
        const [start, end] = ranges[stage ?? packingProgressStageRef.current]
        setPackingProgress(payload.algorithm === 'local-tools'
          ? Math.round(Math.max(0, Math.min(100, reported)))
          : Math.round(start + (end - start) * Math.max(0, Math.min(100, reported)) / 100))
      }
      if (Number.isFinite(reported) && comparisonBatch.current.total > 1) { const { index, total } = comparisonBatch.current; setPackingProgress(25 + Math.round(75 * (index + Math.max(0, Math.min(100, reported)) / 100) / total)) }
      else if (payload.phase === 'completed') setPackingProgress(100)
    }).then(next => { if (cancelled) next(); else unlisten = next }).catch(() => {})
    return () => { cancelled = true; unlisten() }
  }, [packingLoading])
  useEffect(() => {
    // Editing selection, QT or settings invalidates the result, but never starts
    // a solver. The next explicit click captures the complete input snapshot.
    setBackendPlan(undefined)
    setPackingChoices([]); comparisonResults.current.clear()
    committedPages.current = undefined
    setInteractionHint('')
    setSelectedImageId(undefined)
    setImagePolygons({})
    setInvalidOutlineIds(new Set())
    setOutlineErrorCount(0)
  }, [images, layout, layoutPresets.selected?.id, allowBaseMixing])
  useEffect(() => {
    setBackendPlan(undefined)
    setPackingChoices([]); comparisonResults.current.clear()
    committedPages.current = undefined
    setSelectedImageId(undefined)
    setInteractionHint('')
  }, [packingObjective])
  async function calculate(templateRepack?: NestTemplateRepack) {
    if (quantityLock.current || !layoutPresets.ready) return
    if (calculateLock.current || deleteLock.current || uploading || quantitySavingId || loadingJobIds.size || !packingImages.length) return
    calculateLock.current = true
    setPackingLoading(true); setDetailError(''); setInteractionHint('')
    if (!templateRepack) { setBackendPlan(undefined); committedPages.current = undefined; setPackingChoices([]); comparisonResults.current.clear() }
    comparisonBatch.current = { index: 0, total: 1 }; setComparisonStep('')
    setInvalidOutlineIds(new Set()); setOutlineErrorCount(0)
    setPackingProgressStage('outline'); setPackingProgress(0); setPackingElapsedMs(0)
    setPackingProgressDetail(allowBaseMixing ? '正在提取 SVG 轮廓，底座将与其他图片共同搜索排版…' : PACKING_PROGRESS_COPY.outline.detail)
    setPackingProgressCounts({ completed: 0, total: images.length })
    progressEventAtRef.current = 0
    try {
      // Let the loading dialog paint before extracting any contours.
      await new Promise(resolve => window.setTimeout(resolve, 30))
      const candidates = images.filter(image => getImpositionQuantity(image) > 0)
      const polygons: Record<string, Array<[number, number]>> = {}
      const lineOnlyIds = new Set<string>()
      const invalid = new Set<string>()
      let cursor = 0; let completed = 0
      await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, async () => {
        while (cursor < candidates.length && mounted.current) {
          const image = candidates[cursor++]
          try {
            const geometry = await loadImpositionGeometry(image.filePath, image.widthMm, image.heightMm)
            polygons[image.id] = geometry.polygon
            if (geometry.lineOnly) lineOnlyIds.add(image.id)
          }
          catch { invalid.add(image.id) }
          completed++
          if (mounted.current) { setPackingProgressCounts({ completed, total: candidates.length }); setPackingProgress(Math.round(25 * completed / candidates.length)) }
        }
      }))
      if (!mounted.current) return
      setImagePolygons(polygons); setInvalidOutlineIds(invalid); setOutlineErrorCount(invalid.size)
      setPackingProgressStage('prepare'); setPackingProgress(25)
      const requestData = { plateWidthMm: layout.plateWidth, plateHeightMm: layout.plateHeight, effectiveWidthMm: layout.effectiveWidth, effectiveHeightMm: layout.effectiveHeight, effectiveRightMm: layout.effectiveRight, spacingMm: layout.spacing, allowBaseMixing, objective: templateRepack ? activeObjective : packingObjective === 'all' ? 'least-material' : packingObjective, irregularAlgorithm: 'local-tools' as const, threadCount: computeThreads.threadCount, items: candidates.filter(image => !invalid.has(image.id)).map(image => ({ id: image.id, widthMm: image.widthMm, heightMm: image.heightMm, quantity: getImpositionQuantity(image), polygon: polygons[image.id], lineOnly: lineOnlyIds.has(image.id) })) }
      setPackingProgressStage('search')
      if (!templateRepack && packingObjective === 'all') {
        setPackingChoices(PACKING_STRATEGIES.map(strategy => ({ objective: strategy.value, status: 'waiting' })))
        await comparePackingStrategies(requestData, {
          solve: packImpositionIrregular,
          summarize: result => {
            const { sheetsUsed, cuttingLines, unplacedCount } = summarizePackingResult(result, packingImages, polygons)
            return { sheetsUsed, cuttingLines, unplacedCount }
          },
          active: () => mounted.current,
          onStart: (objective, index) => {
            comparisonBatch.current = { index, total: PACKING_STRATEGIES.length }
            progressEventAtRef.current = 0
            const label = PACKING_STRATEGIES.find(strategy => strategy.value === objective)!.label
            setComparisonStep(`第 ${index + 1}/${PACKING_STRATEGIES.length} 项 · ${label}`)
            setPackingProgressStage('search'); setPackingProgressDetail(`正在计算${label}，其余方案依次等待…`)
            setPackingProgress(25 + Math.round(75 * index / PACKING_STRATEGIES.length))
            setPackingChoices(current => current.map(choice => choice.objective === objective ? { ...choice, status: 'running' } : choice))
          },
          onResult: (choice, result) => {
            if (result) comparisonResults.current.set(choice.objective, result)
            setPackingChoices(current => current.map(value => value.objective === choice.objective ? choice : value))
          },
        })
        if (mounted.current) { setPackingProgress(100); setComparisonStep('') }
        return
      }
      let next: PackingPlan
      if (templateRepack) {
        setPackingProgressDetail('正在重算来源与目标方案的生产份数，剩余图片将继续补入其他方案…')
        // Assets already excluded by the original run (for example, too large
        // at every angle) do not enter a valid template edit. Keep their red
        // rows and original unplaced demand, without blocking all other art.
        const priorExcluded = backendPlan?.excludedItems ?? []
        const excludedIds = new Set(priorExcluded.map(item => item.id))
        next = await repackTemplatePlan({ ...requestData, items: requestData.items.filter(item => !excludedIds.has(item.id)), templateRepack }, packingImages, polygons, packImpositionIrregular)
        next.excludedItems = [...priorExcluded, ...next.excludedItems]
      } else {
        const result = requestData.items.length ? await packImpositionIrregular(requestData) : { placements: [], unplaced: [], sheetsUsed: 0, utilization: 0, algorithm: '所选图片均无有效轮廓' }
        if (!result) throw new Error('拼版未返回结果')
        next = summarizePackingResult(result, packingImages, polygons)
      }
      if (!mounted.current) return
      setPackingProgressStage('validate')
      setActiveObjective(templateRepack ? activeObjective : packingObjective === 'all' ? 'least-cutting' : packingObjective)
      setBackendPlan(next)
      committedPages.current = next.pages
      setSelectedImageId(undefined)
      if (templateRepack) setInteractionHint(`跨方案重算完成：${next.sheetsUsed} 块板材、${groupRepeatedPackingPages(next.pages).length} 种版式；各图片 QT 数量不变`)
      setAllSheetsExpanded(false)
      setPackingProgressStage('render'); setPackingProgress(100)
    } catch (reason) { if (mounted.current) setDetailError(`${templateRepack ? '跨方案重算失败，已保留原方案' : '异形拼版计算失败'}：${String(reason)}`) }
    finally { calculateLock.current = false; if (mounted.current) setPackingLoading(false) }
  }
  const choosePackingPlan = (objective: PackingObjective) => {
    if (packingLoading) return
    if (backendPlan && activeObjective === objective) return
    const result = comparisonResults.current.get(objective)
    if (!result) return
    const next = 'pages' in result ? result : summarizePackingResult(result, packingImages, imagePolygons)
    comparisonResults.current.set(objective, next)
    setActiveObjective(objective)
    setBackendPlan(next); committedPages.current = next.pages
    setSelectedImageId(undefined); setAllSheetsExpanded(false); setInteractionHint('')
  }
  useEffect(() => {
    if (!backendPlan || !comparisonResults.current.has(activeObjective)) return
    comparisonResults.current.set(activeObjective, backendPlan)
    setPackingChoices(current => current.map(choice => choice.objective === activeObjective ? {
      ...choice, sheetsUsed: backendPlan.sheetsUsed, cuttingLines: backendPlan.cuttingLines, unplacedCount: backendPlan.unplacedCount,
    } : choice))
  }, [backendPlan, activeObjective])
  const activePlan: PackingPlan = backendPlan ?? { pages: EMPTY_PACKED_PAGES, sheetsUsed: 0, placedCount: 0, utilization: 0, cuttingLines: 0, unplacedCount: packingImages.length, unplacedIds: [], excludedItems: [], warnings: [], algorithm: '等待异形拼版结果' }
  const packedPages = activePlan.pages
  const recordEdit = (pages: PackedImpositionItem[][], edit: PackingEdit) => {
    if (edit.crossBoard) {
      if (!edit.templateRepack || calculateLock.current) return
      void calculate(edit.templateRepack)
      return
    }
    committedPages.current = pages
    setBackendPlan(current => {
      if (!current) return current
      const occupiedSheets = pages.filter(page => page.length).length
      const summary = summarizePackingResult({
        placements: pages.flatMap((page, sheetIndex) => page.map(item => ({ id: item.image.id, sheetIndex, xMm: item.x, yMm: item.y, widthMm: item.width, heightMm: item.height, rotationDeg: item.rotation ?? 0 }))),
        unplaced: [], sheetsUsed: occupiedSheets, utilization: current.utilization * current.sheetsUsed / Math.max(1, occupiedSheets), algorithm: current.algorithm, excludedItems: current.excludedItems, warnings: current.warnings,
      }, packingImages, imagePolygons)
      // Keep physical indices (including a newly empty board) until re-solving.
      return { ...summary, pages: pages.map(page => page.map(item => ({ ...item, rotation: item.rotation ?? 0 }))) }
    })
    setInteractionHint(edit.repeatedBoards > 1 ? `已应用到此方案的 ${edit.repeatedBoards} 块板材` : '已保存图片位置与角度')
  }
  const repeatedLayouts = useMemo(() => groupRepeatedPackingPages(packedPages), [packedPages])
  const collapseRepeatedLayouts = activeObjective !== 'least-material' && !allSheetsExpanded
  const displayedSheetCount = collapseRepeatedLayouts ? repeatedLayouts.length : packedPages.length
  useEffect(() => {
    setAllSheetsExpanded(false)
  }, [packingObjective])
  // Only file references reach the canvas. Visible artwork requests bounded
  // native previews; original SVGs are loaded separately by the PDF dialog.
  const imagePaths = useMemo(() => Object.fromEntries(images.map(image => [image.id, image.filePath])), [images])
  const boardWidth = Math.max(1, layout.plateWidth)
  const boardHeight = Math.max(1, layout.plateHeight)
  const boardScale = Math.min(1.6, Math.max(.7, 520 / boardHeight))
  const effectiveX = Math.max(0, boardWidth - layout.effectiveRight - layout.effectiveWidth)
  const effectiveY = Math.max(0, (boardHeight - layout.effectiveHeight) / 2)
  const effectiveDisplayWidth = Math.min(layout.effectiveWidth, boardWidth - layout.effectiveRight)
  const invalidOutlineLabels = images.filter(image => invalidOutlineIds.has(image.id)).map(image => image.name || image.id)
  const unplacedAssetIds = new Set(activePlan.unplacedIds.map(id => id.split('#qt-')[0]))
  const excludedReasons = new Map(activePlan.excludedItems.map(item => [item.id.split('#qt-')[0], item.reason]))
  // An aggregate contour warning identifies the largest source outline while
  // the solver continues with batches. Keep that source row visible in red;
  // it is a diagnostic marker, not an excluded placement.
  const complexityWarningIds = new Set(activePlan.warnings
    .filter(warning => warning.includes('最大轮廓图片：'))
    .flatMap(warning => (warning.split('最大轮廓图片：')[1] ?? '').split(/[，,]/).map(id => id.trim()).filter(Boolean)))
  const complexityWarningReasons = new Map([...complexityWarningIds].map(id => [id, '轮廓总复杂度过高，已分批计算；图片仍会继续参与拼版']))
  const complexityWarningLabels = images.filter(image => complexityWarningIds.has(image.id)).map(image => image.name || image.id)
  const excludedLabels = images.filter(image => excludedReasons.has(image.id)).map(image => image.name || image.id)
  const outlineStatus = outlineErrorCount ? `${outlineErrorCount} 张轮廓无效，已剔除：${invalidOutlineLabels.slice(0, 2).join('、')}${invalidOutlineLabels.length > 2 ? '…' : ''}`
    : excludedLabels.length ? `${excludedLabels.length} 张图片未参与异形拼版：${excludedLabels.slice(0, 2).join('、')}${excludedLabels.length > 2 ? '…' : ''}`
    : complexityWarningLabels.length ? `轮廓复杂度过高，已分批计算：${complexityWarningLabels.slice(0, 2).join('、')}${complexityWarningLabels.length > 2 ? '…' : ''}`
    : `已选 ${images.length} 张图片 · QT ${packingImages.length} 份 · 间距 ${layout.spacing} mm`
  const updateQuantity = async (jobId: string, imageId: string, rawQuantity: number) => {
    if (packingLoading || deleteLock.current || quantityLock.current) return
    const quantity = Math.max(0, Math.min(10_000, Math.floor(rawQuantity)))
    const key = `${jobId}:${imageId}`
    setQuantityDrafts(current => ({ ...current, [key]: quantity }))
    const savedImage = details[jobId]?.images.find(image => image.id === imageId)
    if (savedImage && getImpositionQuantity(savedImage) === quantity) return
    if (quantitySavingId === key) return
    quantityLock.current = true
    setQuantitySavingId(key)
    try {
      const currentRecord = details[jobId]
      const savedRecord = currentRecord?.temporary
        ? { ...currentRecord, images: currentRecord.images.map(image => image.id === imageId ? { ...image, attributes: { ...image.attributes, QT: String(quantity) } } : image) }
        : await updateImpositionImageQuantity(jobId, imageId, quantity)
      const poolRecord = initialPoolRecords?.find(item => item.id === jobId)
      const record = poolRecord ? { ...savedRecord, images: savedRecord.images.filter(image => poolRecord.images.some(item => item.id === image.id)), imageCount: poolRecord.images.length } : savedRecord
      if (record.temporary) onImported(record)
      setDetails(current => ({ ...current, [record.id]: record }))
      setDetailError('')
    } catch (reason) {
      setDetailError(`保存 QT 数量失败：${String(reason)}`)
    } finally {
      quantityLock.current = false
      setQuantityDrafts(current => { const next = { ...current }; delete next[key]; return next })
      setQuantitySavingId(current => current === key ? undefined : current)
    }
  }
  const updateBatchQuantity = async (jobId: string, imageIds: string[], quantity: number) => {
    if (packingLoading || deleteLock.current || quantityLock.current) throw new Error('正在处理其他任务，请稍后重试')
    const currentRecord = details[jobId]
    const ids = new Set(imageIds)
    if (!currentRecord || !ids.size || imageIds.some(id => !currentRecord.images.some(image => image.id === id))) throw new Error('请选择当前任务的图片')
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 10000) throw new Error('QT 数量必须在 0 至 10000 之间')
    quantityLock.current = true
    setQuantitySavingId(`${jobId}:batch`)
    try {
      const savedRecord = currentRecord.temporary
        ? { ...currentRecord, images: currentRecord.images.map(image => ids.has(image.id) ? { ...image, attributes: { ...image.attributes, QT: String(quantity) } } : image) }
        : await updateImpositionImageQuantities(jobId, [...ids], quantity)
      const poolRecord = initialPoolRecords?.find(item => item.id === jobId)
      const record = poolRecord ? { ...savedRecord, images: savedRecord.images.filter(image => poolRecord.images.some(item => item.id === image.id)), imageCount: poolRecord.images.length } : savedRecord
      if (record.temporary) onImported(record)
      setDetails(current => ({ ...current, [record.id]: record }))
      setQuantityDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => !imageIds.some(id => key === `${jobId}:${id}`))))
      setDetailError('')
    } finally { quantityLock.current = false; setQuantitySavingId(undefined) }
  }
  async function deleteTemporaryJob(job: ImpositionJob) {
    if (!job.temporary || deleteLock.current || calculateLock.current || uploading || quantitySavingId || loadingJobIds.size) return
    deleteLock.current = true
    setDeletingJobId(job.id); setDetailError('')
    try {
      await deleteImpositionImport(job.id)
      if (!mounted.current) return
      const record = details[job.id] ?? temporaryRecords.find(item => item.id === job.id)
      forgetImpositionGeometry(record?.images.map(image => image.filePath) ?? [])
      for (const id of qualifiedImages.current.keys()) {
        if (id.startsWith(`${job.id}::`)) qualifiedImages.current.delete(id)
      }
      setDetails(current => { const next = { ...current }; delete next[job.id]; return next })
      setSelectedByJob(current => { const next = { ...current }; delete next[job.id]; return next })
      setQuantityDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${job.id}:`))))
      if (imagePickerJobId === job.id) setImagePickerJobId(undefined)
      onRemoveImported(job.id)
    } catch (reason) {
      if (mounted.current) setDetailError(`删除临时文件失败：${String(reason)}`)
    } finally {
      deleteLock.current = false
      if (mounted.current) setDeletingJobId(undefined)
    }
  }
  const imagePickerJob = imagePickerJobId ? jobs.find(job => job.id === imagePickerJobId) : undefined
  const imagePickerRecord = imagePickerJobId ? details[imagePickerJobId] ?? temporaryRecords.find(record => record.id === imagePickerJobId) : undefined
  const imageIssueReason = (jobId: string, image: ProductionImage) => {
    const sourceId = impositionImageId(jobId, image.id)
    return excludedReasons.get(sourceId)
      ?? complexityWarningReasons.get(sourceId)
      ?? (invalidOutlineIds.has(sourceId)
        ? 'SVG 轮廓无效，已跳过此图片'
        : unplacedAssetIds.has(sourceId) ? '本次排版未放置此图片（有效区域不足或无可行位置）' : '')
  }
  return <div className={`imposition-workspace${isDevelopment ? "" : " is-production"}`}>
    <header className="imposition-workspace-header">
      <div className="imposition-header-tools">
        <Button aria-label={initialPoolRecords ? '返回拼版池' : '返回待拼版'} className="imposition-back-button" type="primary" icon={<ArrowLeft size={16}/>} disabled={packingLoading || Boolean(deletingJobId)} title={packingLoading ? '正在计算，完成后可返回' : initialPoolRecords ? '返回拼版池' : '返回待拼版'} onClick={onBack}>{initialPoolRecords ? '返回拼版池' : '返回待拼版'}</Button>
        <ImpositionLayoutPresets state={layoutPresets} disabled={packingLoading || !!deletingJobId || !!exportSnapshot}/>
        <section className="imposition-packing-settings" aria-label="拼版设置">
          <div className="imposition-packing-options">
            <Tooltip title={outlineStatus}><label className="imposition-base-mixing" title="开启后允许纯线条底座与其他图片同版拼排"><span>底座混排</span><Switch size="small" aria-label="底座混排" checked={allowBaseMixing} disabled={packingLoading} onChange={setAllowBaseMixing}/></label></Tooltip>
            {isDevelopment && <Popover trigger="click" open={debugSettingsOpen} onOpenChange={setDebugSettingsOpen} placement="bottomLeft" destroyOnHidden content={<section className="imposition-debug-settings" aria-label="开发拼版设置">
              <strong>调试设置</strong>
              <div className="imposition-dev-controls"><Select disabled={packingLoading} className="imposition-objective-select" aria-label="拼版策略" popupMatchSelectWidth={280} size="small" value={packingObjective} onChange={value => setPackingObjective(value)} options={[{ label: '全部', value: 'all' }, { label: '节省板材（单板尽量多放）', value: 'least-material' }, { label: '切割方案优先（重复统一版式）', value: 'least-cutting' }, { label: '综合最少（权重 60:40）', value: 'combined' }]}/><Select id="imposition-thread-count" aria-label="使用核心数" aria-describedby="imposition-thread-hint" className="imposition-thread-select" size="small" loading={!computeThreads.info && !computeThreads.failed} disabled={packingLoading || !computeThreads.info} value={computeThreads.preference} onChange={computeThreads.changePreference} options={[{ label: computeThreads.info ? `自动（全部 ${computeThreads.info.logicalCores} 核）` : computeThreads.failed ? '自动（计算时检测）' : '读取 CPU 核心数…', value: 'auto' }, ...Array.from({ length: computeThreads.info?.logicalCores ?? 0 }, (_, index) => ({ label: `${index + 1} 核`, value: index + 1 }))]}/></div>
              <p id="imposition-thread-hint" className="imposition-thread-hint" aria-live="polite">{computeThreads.info ? `检测到 ${computeThreads.info.logicalCores} 个逻辑核心，默认全部使用；内存不足时自动降低并行数。` : computeThreads.failed ? <>未能读取 CPU 核心数，计算时由系统自动分配。<Button type="link" size="small" disabled={packingLoading} onClick={computeThreads.retry}>重试</Button></> : '正在读取本机可用的逻辑核心数…'}</p>
            </section>}><Button type="text" size="small" className="imposition-debug-toggle" icon={<SlidersHorizontal size={13}/>} aria-label="打开调试设置" aria-expanded={debugSettingsOpen} disabled={packingLoading}>调试设置</Button></Popover>}
          </div>
          <div className="imposition-packing-plan">
            <div className="imposition-packing-actions">
              {!!packingChoices.length && <div className="imposition-packing-choices" aria-label="拼版方案比较">{packingChoices.map(choice => <button key={choice.objective} type="button" disabled={packingLoading || choice.status !== 'ready'} onClick={() => choosePackingPlan(choice.objective)} aria-pressed={!!backendPlan && activeObjective === choice.objective} title={choice.error} className={choice.status === 'failed' ? 'has-error' : ''}><strong>{PACKING_STRATEGIES.find(strategy => strategy.value === choice.objective)!.label}</strong>{choice.status === 'ready' ? <span>版面 <b>{choice.sheetsUsed}</b> · 切割线 <b>{choice.cuttingLines}</b>{!!choice.unplacedCount && <small>未放置 {choice.unplacedCount} 张</small>}</span> : <span>{choice.status === 'running' ? '正在计算…' : choice.status === 'failed' ? `计算失败：${choice.error}` : '等待计算'}</span>}</button>)}</div>}
              <Button className="imposition-smart-pack" type="primary" loading={packingLoading} disabled={!layoutPresets.ready || uploading || !!deletingJobId || !!quantitySavingId || !!loadingJobIds.size || !packingImages.length} onClick={() => void calculate()}>智能拼版</Button>
            </div>
            {backendPlan && <div className="imposition-packing-status">
              <div className="imposition-packing-results"><span>本次版面 <strong>{activePlan.sheetsUsed}</strong></span><span>切割线 <strong>{activePlan.cuttingLines}</strong></span></div>
              <small title={PACKING_STRATEGIES.find(strategy => strategy.value === activeObjective)!.label}>已放置 {activePlan.placedCount}/{packingImages.length} 张 · 未放置 {activePlan.unplacedCount} 张</small>
            </div>}
          </div>
        </section>
        <div className="imposition-header-export"><Button type="primary" icon={<Download size={15}/>} disabled={!layoutPresets.ready || packingLoading || !!deletingJobId || !activePlan.placedCount} onClick={() => setExportSnapshot({ pages: (committedPages.current ?? packedPages).map(page => page.map(item => ({ ...item, rotation: item.rotation ?? 0 }))), sources: {}, geometry: { polygons: imagePolygons, region: { left: effectiveX, top: effectiveY, right: effectiveX + effectiveDisplayWidth, bottom: effectiveY + layout.effectiveHeight }, spacing: layout.spacing } })}>导出 PDF</Button></div>
      </div>
      <div className="imposition-header-import"><ImpositionUpload disabled={packingLoading || !!deletingJobId} onBusyChange={setUploading} onError={setDetailError} onImported={record => { onImported(record); setDetails(current => ({ ...current, [record.id]: record })); onSelectJob(record.id) }}/></div>
    </header>
    <div className="imposition-workspace-body">
    <main className="imposition-canvas-region">{packingLoading && <div className="imposition-calculating-overlay" role="status" aria-live="polite"><div className="imposition-calculating-dialog"><Loading size="large"/><strong>{comparisonStep || PACKING_PROGRESS_COPY[packingProgressStage].title}</strong><span>{packingProgressDetail || PACKING_PROGRESS_COPY[packingProgressStage].detail}</span><div className="imposition-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={packingProgress} aria-label={PACKING_PROGRESS_COPY[packingProgressStage].title}><div className="imposition-progress-value" style={{ width: `${packingProgress}%` }}/></div><small>{packingProgress}% · 已运行 {Math.floor(packingElapsedMs / 1000)} 秒 · {packingProgressCounts.total ? `已处理 ${packingProgressCounts.completed}/${packingProgressCounts.total} 项 · ` : ''}{images.length} 个基础图片 / {packingImages.length} 个数量</small></div></div>}{detailError && <Alert type="error" message={detailError} showIcon/>}{interactionHint && <div className="imposition-interaction-hint" role="status">{interactionHint}</div>}<div ref={canvasRef} className={`imposition-canvas-scroll ${panMode || spacePressed ? 'is-pan-mode' : ''}`} onWheel={onCanvasWheel} onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp}>{!backendPlan && !packingLoading && <div className="imposition-empty-canvas">{packingChoices.length ? '选择上方方案以查看拼版结果' : '勾选右侧图片，点击“智能拼版”生成拼版'}</div>}<ImpositionKonvaCanvas collapseRepeatedLayouts={collapseRepeatedLayouts} onInteractionHint={setInteractionHint} onEdit={recordEdit} pages={packedPages} imagePaths={imagePaths} polygons={imagePolygons} boardWidth={boardWidth} boardHeight={boardHeight} boardScale={boardScale} effectiveX={effectiveX} effectiveY={effectiveY} effectiveWidth={effectiveDisplayWidth} effectiveHeight={layout.effectiveHeight} spacing={layout.spacing} holeCount={layout.holeCount} holeSize={layout.holeSize} holeLeft={layout.holeLeft} holeGap={layout.holeGap} zoom={zoom} panOffset={panOffset} panMode={panMode || spacePressed || packingLoading} selectedImageId={selectedImageId} onSelectImage={setSelectedImageId} onPagesChange={pages => { committedPages.current = pages }}/></div><footer className="imposition-canvas-footer"><div className="imposition-mode"><Button type="text" className={!panMode ? 'active' : ''} icon={<MousePointer2 size={14}/>} onClick={() => setPanMode(false)}>选择</Button><Button type="text" className={panMode ? 'active' : ''} icon={<Hand size={14}/>} onClick={() => setPanMode(value => !value)}>平移</Button><span className="imposition-shortcut">空格：平移 · Ctrl + 滚轮：缩放</span></div><div className="imposition-workspace-actions">{activeObjective !== 'least-material' && backendPlan && <Button onClick={() => { setAllSheetsExpanded(value => !value); setSelectedImageId(undefined) }}>{collapseRepeatedLayouts ? '展开全部板材' : '折叠重复方案'}</Button>}<Button aria-label="缩小" icon={<ZoomOut size={15}/>} onClick={() => updateZoom(-.1)} >缩小</Button><span>{Math.round(zoom * 100)}%</span><Button aria-label="放大" icon={<ZoomIn size={15}/>} onClick={() => updateZoom(.1)}>放大</Button><span>{collapseRepeatedLayouts ? `${displayedSheetCount} 种版式 · 共 ${activePlan.sheetsUsed} 块板材` : `${packedPages.length} 个版面`} · 选中 {selectedImageId ? 1 : 0} 张图片</span></div></footer></main>
      <aside className="imposition-job-sidebar">
        <div className="imposition-sidebar-heading"><div><strong>待拼版</strong><span>{jobs.length} 个任务 · 已选 {images.length} 张图片</span></div><Dropdown trigger={['click']} menu={{ items: [{ key: 'customer', label: '按客户' }, { key: 'time', label: '按时间' }], onClick: ({ key }) => setSortMode(key as 'customer' | 'time') }}><Button size="small" className="imposition-sort-button">{sortMode === 'customer' ? '按客户' : '按时间'} <ChevronDown size={13}/></Button></Dropdown></div>
        <div className="imposition-job-list">{displayJobs.map(job => {
          const record = details[job.id]
          const selected = selectedByJob[job.id] ?? []
          const selectedCount = record?.images.filter(image => selected.includes(image.id)).length ?? 0
          const count = record?.images.length ?? job.imageCount
          return <section className={`imposition-job-card ${activeJob?.id === job.id ? 'selected' : ''}`} key={job.id}>
            <button type="button" className="imposition-job-open" aria-label={`选择 ${job.customerName || '未填写客户'} 的拼版图片`} aria-haspopup="dialog" disabled={packingLoading || uploading || !!deletingJobId} onClick={() => openImagePicker(job.id)}/>
            <div className="imposition-job-summary"><span><strong>{job.customerName || '未填写客户'}</strong><small>{new Date(job.submittedAt).toLocaleString()} · {count} 张图片</small></span>{job.temporary ? <Tag>临时文件</Tag> : <Tag color={job.paymentStatus === 'paid' ? 'success' : 'orange'}>{job.paymentStatus === 'paid' ? '付款' : '未付款'}</Tag>}</div>
            <div className="imposition-job-card-footer"><Checkbox aria-label={`选择任务 ${job.customerName || '未填写客户'}`} checked={count > 0 && selectedCount === count} indeterminate={selectedCount > 0 && selectedCount < count} disabled={packingLoading || uploading || !!deletingJobId || loadingJobIds.has(job.id)} onChange={event => void selectJob(job.id, event.target.checked)}>已选 {selectedCount}/{count} 张图片</Checkbox>{job.temporary ? <span className="imposition-job-return-action"><Popconfirm title="删除此临时文件？" description="将移除此批图片及其暂存文件，原始 SVG 保留。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" disabled={packingLoading || uploading || !!deletingJobId || !!quantitySavingId || !!loadingJobIds.size} onConfirm={() => deleteTemporaryJob(job)}><Button type="link" danger aria-label={`删除临时文件 ${job.customerName}`} loading={deletingJobId === job.id} disabled={packingLoading || uploading || !!deletingJobId || !!quantitySavingId || !!loadingJobIds.size}>删除</Button></Popconfirm></span> : <span className="imposition-job-return-action"><Popconfirm title="回退到示意图审核？" description="回退后可重新发起拼版。" okText="回退" cancelText="取消" onConfirm={() => onReturn(job.id)}><Button type="link" danger loading={returningId === job.id} disabled={loading || packingLoading || Boolean(returningId)}>回退</Button></Popconfirm></span>}</div>
          </section>
        })}</div>
        <div className="imposition-sidebar-tip">点击任务卡片选择图片，再点击“智能拼版”。</div>
      </aside>
    </div>
    {exportSnapshot && <ImpositionPdfExportModal pages={exportSnapshot.pages} geometry={exportSnapshot.geometry} imageSources={exportSnapshot.sources} widthMm={boardWidth} heightMm={boardHeight} holes={{ count: layout.holeCount, sizeMm: layout.holeSize, gapMm: layout.holeGap, leftMm: layout.holeLeft }} onClose={() => setExportSnapshot(undefined)}/>}
    {imagePickerJobId && <ImpositionImagePickerModal
      key={imagePickerJobId}
      open={Boolean(imagePickerJobId)}
      title={`${imagePickerJob?.customerName || '未填写客户'} · 选择参与拼版图片`}
      record={imagePickerRecord}
      selectedIds={imagePickerJobId ? (selectedByJob[imagePickerJobId] ?? []) : []}
      disabled={packingLoading || uploading || !!deletingJobId}
      quantitySaving={Boolean(quantitySavingId)}
      error={detailError}
      onRetry={() => { if (imagePickerJobId) openImagePicker(imagePickerJobId) }}
      loading={Boolean(imagePickerJobId && loadingJobIds.has(imagePickerJobId))}
      issueReason={image => imagePickerJobId ? imageIssueReason(imagePickerJobId, image) : ''}
      onClose={() => setImagePickerJobId(undefined)}
      onToggle={(imageId, checked) => imagePickerJobId && toggleImage(imagePickerJobId, imageId, checked)}
      onToggleMany={(imageIds, checked) => imagePickerJobId && toggleImages(imagePickerJobId, imageIds, checked)}
      onQuantityChange={(image, value) => { if (!imagePickerJobId) return; const key = `${imagePickerJobId}:${image.id}`; setQuantityDrafts(current => ({ ...current, [key]: value })) }}
      onQuantityCommit={image => { if (!imagePickerJobId) return; const key = `${imagePickerJobId}:${image.id}`; void updateQuantity(imagePickerJobId, image.id, quantityDrafts[key] ?? getImpositionQuantity(image)) }}
      onBatchQuantityCommit={(imageIds, quantity) => imagePickerJobId ? updateBatchQuantity(imagePickerJobId, imageIds, quantity) : Promise.reject(new Error('拼版任务已关闭'))}
      quantityValue={image => imagePickerJobId ? quantityDrafts[`${imagePickerJobId}:${image.id}`] ?? getImpositionQuantity(image) : getImpositionQuantity(image)}
    />}
  </div>
}


export default function ImpositionPage({ active, revision, onReturned }: { active: boolean; revision: number; onReturned?: () => void }) {
  const [result, setResult] = useState<ImpositionListResult>({ records: [], total: 0, page: 1, pageSize: 20 })
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20 })
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [returningId, setReturningId] = useState<string>()
  const operationLock = useRef(false)
  const [detailId, setDetailId] = useState<string>()
  const [detail, setDetail] = useState<ImpositionRecord>()
  const [detailError, setDetailError] = useState('')
  const [screen, setScreen] = useState<'list' | 'workspace' | 'pools'>('list')
  const [poolRecords, setPoolRecords] = useState<ImpositionRecord[]>()
  const [temporaryRecords, setTemporaryRecords] = useState<ImpositionRecord[]>([])
  const [workspaceJobId, setWorkspaceJobId] = useState<string>()
  const workspaceJobs = useMemo(() => [...temporaryRecords, ...(poolRecords ?? result.records)], [temporaryRecords, result.records, poolRecords])
  const { token } = theme.useToken()
  const colors = { '--imposition-paid-bg': token.colorSuccessBg, '--imposition-unpaid-bg': token.orange1 } as CSSProperties
  const search = query.trim()
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    setError('')
    void listPendingImpositions({ ...pagination, search }).then(next => {
      if (cancelled) return
      setResult(next)
      if (next.page !== pagination.page || next.pageSize !== pagination.pageSize) setPagination({ page: next.page, pageSize: next.pageSize })
    }).catch(reason => { if (!cancelled) setError(`加载待拼版记录失败：${String(reason)}`) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active, revision, refresh, pagination, search])
  useEffect(() => {
    if (!active || !detailId) return
    let cancelled = false
    setDetail(undefined)
    setDetailError('')
    void loadImpositionJob(detailId).then(record => { if (!cancelled) setDetail(record) })
      .catch(reason => { if (!cancelled) setDetailError(`加载图片明细失败：${String(reason)}`) })
    return () => { cancelled = true }
  }, [active, detailId])
  const returnToReview = async (id: string) => {
    if (operationLock.current || loading) return
    operationLock.current = true
    setReturningId(id)
    setError('')
    // Remove the row immediately; the cloud transition remains authoritative
    // and is confirmed in the background so the workspace stays responsive.
    setPoolRecords(current => current?.filter(record => record.id !== id))
    setResult(current => ({ ...current, records: current.records.filter(record => record.id !== id), total: Math.max(0, current.total - 1) }))
    if (detailId === id) setDetailId(undefined)
    void returnImpositionToReview(id).then(() => {
      setRefresh(value => value + 1)
      onReturned?.()
    }).catch(reason => {
      setError(`回退到示意图审核失败：${String(reason)}`)
      setRefresh(value => value + 1)
    }).finally(() => {
      operationLock.current = false
      setReturningId(undefined)
    })
  }
  if (screen === 'pools') return <ConfigProvider locale={zhCN}><ImpositionPools key={poolStorageKey()} active={active} revision={revision + refresh} onBack={() => setScreen('list')} onStart={records => { setPoolRecords(records); setWorkspaceJobId(records[0]?.id); setScreen('workspace') }}/></ConfigProvider>
  if (screen === 'workspace') return <ConfigProvider locale={zhCN}><ImpositionWorkspace jobs={workspaceJobs} initialPoolRecords={poolRecords} temporaryRecords={temporaryRecords} onImported={record => setTemporaryRecords(current => [...current.filter(item => item.id !== record.id), record])} onRemoveImported={id => { setTemporaryRecords(current => current.filter(record => record.id !== id)); setWorkspaceJobId(current => current === id ? undefined : current) }} activeJobId={workspaceJobId} onBack={() => setScreen(poolRecords ? 'pools' : 'list')} onSelectJob={setWorkspaceJobId} onReturn={returnToReview} returningId={returningId} loading={loading}/></ConfigProvider>
  return <ConfigProvider locale={zhCN}>
    <ModulePage className="imposition-page" style={colors} title="生产拼版" description="示意图审核转入的记录在这里等待拼版。"
      actions={<div className="imposition-list-actions"><Button icon={<RefreshCw size={15}/>} loading={loading} onClick={() => setRefresh(value => value + 1)}>刷新</Button><Button type="primary" onClick={() => { setPoolRecords(undefined); setWorkspaceJobId(result.records[0]?.id); setScreen('workspace') }}>开始拼版</Button><Button icon={<Layers size={15}/>} onClick={() => setScreen('pools')}>拼版池</Button></div>}
      notice={error && <Alert type="error" message={error} showIcon/>}
      toolbar={<><h2>待拼版</h2><Input aria-label="搜索待拼版记录" placeholder="搜索客户或导出文件名" allowClear value={query} onChange={event => { setQuery(event.target.value); setPagination(current => ({ ...current, page: 1 })) }}/></>}
      footer={<><span>共 {result.total} 条待拼版记录</span><Pagination current={result.page} pageSize={result.pageSize} total={result.total} disabled={loading} showSizeChanger pageSizeOptions={[20, 50, 100]} showQuickJumper onChange={(page, pageSize) => setPagination({ page: pageSize === pagination.pageSize ? page : 1, pageSize })}/></>}>
      <div className="module-page-table imposition-table"><Table<ImpositionJob> rowKey="id" dataSource={result.records} loading={loading} pagination={false} scroll={{ x: 950 }} rowClassName={record => record.paymentStatus === 'paid' ? 'imposition-paid' : 'imposition-unpaid'} locale={{ emptyText: search ? '没有匹配的待拼版记录' : '暂无待拼版记录，请在示意图审核中选择拼版' }} columns={[
        { title: '客户', dataIndex: 'customerName', width: 180, render: value => value || '未填写客户' },
        { title: '导出文件', dataIndex: 'output', render: (value: string) => <span title={value}>{value.split(/[\\/]/).pop()}</span> },
        { title: '转入时间', dataIndex: 'submittedAt', width: 200, render: (value: string) => new Date(value).toLocaleString() },
        { title: '图片数', dataIndex: 'imageCount', width: 85 },
        { title: '付款状态', dataIndex: 'paymentStatus', width: 110, render: value => <Tag color={value === 'paid' ? 'success' : 'orange'}>{value === 'paid' ? '付款' : '未付款'}</Tag> },
        { title: '阶段', key: 'stage', width: 95, render: () => <Tag color="processing">待拼版</Tag> },
        { title: '操作', key: 'actions', width: 190, fixed: 'right', render: (_, record) => <div style={{ display: 'flex' }}><Button type="link" onClick={() => setDetailId(record.id)}>图片明细</Button><Popconfirm title="回退到示意图审核？" description="回退后状态为“被退回”，可在示意图审核中再次发起拼版。" okText="回退" cancelText="取消" disabled={loading || Boolean(returningId)} onConfirm={() => returnToReview(record.id)}><Button type="link" danger loading={returningId === record.id} disabled={loading || Boolean(returningId)}>回退</Button></Popconfirm></div> },
      ]}/></div>
    </ModulePage>
    <Drawer title={detail ? `${detail.customerName || '未填写客户'} · 图片明细` : '图片明细'} open={active && Boolean(detailId)} onClose={() => setDetailId(undefined)} width="min(1100px, 95vw)" destroyOnHidden>
      {detailError && <Alert type="error" message={detailError} showIcon/>}
      <Table<ProductionImage> rowKey="id" dataSource={detail?.images ?? []} loading={!detail && !detailError} pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }} scroll={{ x: 1000 }} columns={[
        { title: '图片', dataIndex: 'name', width: 160 },
        { title: '文件路径', dataIndex: 'filePath', width: 280, render: (value: string) => <span className="imposition-file-path" title={value}>{value}</span> },
        { title: '真实尺寸（mm）', key: 'dimensions', width: 230, render: (_, image) => `${image.widthMm} × ${image.heightMm}` },
        { title: '产品', dataIndex: 'productName', width: 150, render: (value, image) => value || image.productId || '未设置产品' },
        { title: '产品属性', key: 'attributes', width: 240, render: (_, image) => <div className="imposition-attributes">{Object.entries(image.attributes).map(([key, value]) => <div key={key}><strong>{key}：</strong>{value}</div>)}{image.note && <div><strong>备注：</strong>{image.note}</div>}</div> },
      ]}/>
    </Drawer>
  </ConfigProvider>
}
