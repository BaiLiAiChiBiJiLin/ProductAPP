import CanvasTools from './components/CanvasTools'
import PageThumbnailList from './components/PageThumbnailList'
import type { CanvasAnnotation } from './layoutTypes'
import { updateDetailText, type DetailTextDraft } from './services/detailTextService'
import { deleteEditorSelection, type BackgroundScope, type CanvasTool, type EditorSelection, type Point } from './services/canvasAnnotationService'
import { GROUP_BACKGROUND, imageGroupsForPage } from './services/groupBackgroundService'
import { rulerDimensionValue } from './services/imageDimensionService'
import { updateRulerDimensionValue } from './services/rulerValueEditService'
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react'
import { Button, ColorPicker, Input, InputNumber, Modal } from 'antd'
import { Download, Hand, MousePointer2, Plus, WandSparkles, ZoomIn, ZoomOut, ArrowLeft, Combine } from 'lucide-react'
import type { Asset, HeaderBlock, Item, LayoutBounds, Page, PageHeader } from '../../model'
import { rulerAxes, type RulerPatch } from './services/canvasSelectionService'
import { dimensionForItem, type DimensionDisplayOverride, type DimensionDisplayPrecision } from './services/imageDimensionService'
import type { RulerChange } from './components/ImageDimensionMarkers'
import type { EditImageGroupText } from './components/ImageGroupDetails'
import { CANVAS_DISPLAY_SCALE_STEP, clampCanvasDisplayScale } from './services/canvasDisplayScaleService'
import './arrange-toolbar.css'
import ArtworkCanvas from './ArtworkCanvas'
import ArtworkContextMenu, { type ArtworkMenuTarget } from './components/ArtworkContextMenu'
import AssetPool from './components/AssetPool'
import ProductAttributesPanel from './components/ProductAttributesPanel'
import Loading from '../../components/Loading'
import PageConfigPanel from './components/PageConfigPanel'
import { pdfProgressText, type PdfExportProgress } from './services/exportService'
import type { ProductAttributePatch } from './services/productOptionRules'
import type { ArrangementDisplayState } from './services/arrangementDisplayState'

type Props = {
  processingLabel?: string
  onChangePage?: (page: Page) => void
  onReorderPages?: (source: number, target: number) => void
  onBackgroundChange?: (scope: BackgroundScope, color: string, groupIds: string[]) => void
  onHorizontalGroup?: (itemId: string) => void
  onResizeGroup?: (groupId: string, rect: { x: number; y: number; width: number; height: number }) => void
  displayState: ArrangementDisplayState
  onDisplayStateChange: Dispatch<SetStateAction<ArrangementDisplayState>>
  sortMode: 'default' | 'upload'
  context: ReactNode
  assets: Asset[]
  pages: Page[]
  activePage: number
  selectedItem: string | null
  selectedGroupIds: string[]
  onSelectPage: (id: number) => void
  onSelectItem: (id: string | null) => void
  onChangeItem: (item: Item) => void
  onReplaceArtwork?: (itemId: string) => Promise<void>
  replacingArtwork?: boolean
  onChangeRulers?: (ids: string[], patch: RulerPatch) => void
  onChangeRuler?: RulerChange
  onEditText?: EditImageGroupText
  onDropAsset: (assetId: string, x?: number, y?: number) => void
  onDeleteGroups: (ids: string[]) => void
  onConfirmAssetAttributes: (assetId: string, patch: ProductAttributePatch) => Promise<void>
  onAddPage: () => void
  onAutoArrange: (mode?: 'default' | 'upload') => void
  onCombine: () => void
  onSelectGroup: (id: string, ctrlKey: boolean) => void
  onBack: () => void
  onBackToHistory: () => void
  onExport: (format: 'jpg' | 'png' | 'svg' | 'pdf', displayOverrides: ReadonlyMap<string, DimensionDisplayOverride>) => void
  exporting?: boolean
  exportProgress?: PdfExportProgress
  metadata?: PageHeader
  onMetadataChange: (metadata: PageHeader) => void
  layoutBounds: LayoutBounds
  onBoundsChange: (bounds: LayoutBounds) => void
  onAddHeaderBlock: () => void
  onChangeHeaderBlock: (block: HeaderBlock) => void
  onRemoveHeaderBlock: (id: string) => void
}

export default function ArrangePage({ processingLabel, onChangePage, onReorderPages, onBackgroundChange, onHorizontalGroup, onResizeGroup, displayState, onDisplayStateChange, context, assets, pages, activePage, selectedItem, selectedGroupIds, sortMode, onSelectPage, onSelectItem, onSelectGroup, onChangeItem, onReplaceArtwork, replacingArtwork = false, onChangeRulers, onChangeRuler = () => {}, onEditText = () => {}, onDropAsset, onDeleteGroups, onConfirmAssetAttributes, onAddPage, onAutoArrange, onCombine, onBack, onBackToHistory, onExport, exporting = false, exportProgress = { phase: 'rendering', completed: 0, total: 1 }, metadata = {}, onMetadataChange, layoutBounds, onBoundsChange, onAddHeaderBlock, onChangeHeaderBlock, onRemoveHeaderBlock }: Props) {
  const workspaceRef = useRef<HTMLElement>(null)
  const [artworkMenu, setArtworkMenu] = useState<ArtworkMenuTarget | null>(null)
  useEffect(() => { setArtworkMenu(null) }, [activePage, exporting, replacingArtwork])
  const [exportFormat, setExportFormat] = useState<'jpg' | 'png' | 'svg' | 'pdf'>('pdf')
  const [canvasMode, setCanvasMode] = useState<CanvasTool>('select')
  const [editorSelection, setEditorSelection] = useState<EditorSelection | null>(null)
  const [textColor, setTextColor] = useState('#000000')
  const [textEdit, setTextEdit] = useState<Extract<CanvasAnnotation, { kind: 'text' }> | DetailTextDraft | null>(null)
  const [rulerEdit, setRulerEdit] = useState<{ id: string; axis?: 'width' | 'height'; value: number | null; unit: string } | null>(null)
  const [sidePanel, setSidePanel] = useState<'pool' | 'attributes'>('pool')
  const { zoom, dimensionDisplayOverrides, visualScales, accessoryVisuals } = displayState
  const updateDisplay = <K extends keyof ArrangementDisplayState>(key: K, update: SetStateAction<ArrangementDisplayState[K]>) => {
    onDisplayStateChange(previous => ({ ...previous, [key]: typeof update === 'function' ? update(previous[key]) : update }))
  }
  const setZoom = (update: SetStateAction<number>) => updateDisplay('zoom', update)
  const setDimensionDisplayOverrides = (update: SetStateAction<ArrangementDisplayState['dimensionDisplayOverrides']>) => updateDisplay('dimensionDisplayOverrides', update)
  const setVisualScales = (update: SetStateAction<ArrangementDisplayState['visualScales']>) => updateDisplay('visualScales', update)
  const setAccessoryVisuals = (update: SetStateAction<ArrangementDisplayState['accessoryVisuals']>) => updateDisplay('accessoryVisuals', update)
  const [boxSelection, setBoxSelection] = useState<string[]>([])
  const [selectedAccessoryKey, setSelectedAccessoryKey] = useState<string | null>(null)
  const [visualScaleInput, setVisualScaleInput] = useState('100')
  useEffect(() => { setBoxSelection([]); setSelectedAccessoryKey(null); setEditorSelection(null); setTextEdit(null); setRulerEdit(null); setCanvasMode('select') }, [activePage])
  const selectOne = (id: string | null) => { setEditorSelection(null); setSelectedAccessoryKey(null); setBoxSelection([]); onSelectItem(id) }
  const selectGroup = (id: string, ctrlKey: boolean) => { setEditorSelection(null); setSelectedAccessoryKey(null); setBoxSelection([]); onSelectGroup(id, ctrlKey) }
  const selectAccessory = (key: string) => { setEditorSelection(null); setSelectedAccessoryKey(key); setBoxSelection([]); onSelectItem(null) }
  const changeAccessory = (key: string, patch: Partial<{ scale: number; x: number; y: number }>) => {
    setAccessoryVisuals(previous => {
      const next = new Map(previous)
      next.set(key, { scale: 1, x: 0, y: 0, ...next.get(key), ...patch })
      return next
    })
  }
  const page = pages.find(item => item.id === activePage) ?? pages[0]
  const pageNumber = Math.max(1, pages.findIndex(candidate => candidate.id === page?.id) + 1)
  const chooseEditor = (selection: EditorSelection) => {
    setEditorSelection(selection); setSelectedAccessoryKey(null); setBoxSelection([]); onSelectItem(null)
    const color = selection.kind === 'annotation' ? page?.annotations?.find(item => item.id === selection.id)?.color
      : selection.kind === 'caption' ? page?.items.find(item => item.id === selection.id)?.captionColor ?? '#e11d48' : selection.kind === 'detail' ? undefined : page?.imageGroups?.find(group => group.id === selection.groupId)?.imageCells?.find(cell => cell.itemId === selection.id)?.labelColor ?? '#e11d48'
    if (color) setTextColor(color)
  }
  const changeAnnotation = (annotation: CanvasAnnotation) => {
    if (!page) return
    const exists = page.annotations?.some(item => item.id === annotation.id)
    onChangePage?.({ ...page, annotations: exists ? page.annotations!.map(item => item.id === annotation.id ? annotation : item) : [...(page.annotations ?? []), annotation] })
  }
  const placeText = (point: Point) => {
    setTextEdit({ id: crypto.randomUUID(), kind: 'text', ...point, text: '', color: textColor, fontSize: 12 }); setCanvasMode('select')
  }
  const selectedBackgroundGroups = selectedGroupIds.length ? selectedGroupIds : imageGroupsForPage(page ?? { id: 0, name: '', items: [] }).filter(group => group.itemIds.includes(selectedItem ?? '') || group.itemIds.some(id => boxSelection.includes(id))).map(group => group.id)
  const backgroundColor = page?.imageGroups?.find(group => selectedBackgroundGroups.includes(group.id))?.backgroundColor ?? page?.backgroundColor ?? GROUP_BACKGROUND
  const editRuler = (id: string, axis: 'width' | 'height') => {
    const item = page?.items.find(item => item.id === id), asset = assets.find(asset => asset.id === item?.assetId)
    if (item && asset) setRulerEdit({ id, axis, value: rulerDimensionValue(asset, item, axis), unit: item.rulerUnit ?? 'mm' })
  }
  const confirmRulerEdit = () => {
    if (!page || !rulerEdit || !Number.isFinite(rulerEdit.value) || rulerEdit.value! <= 0) return
    if (rulerEdit.axis) onChangePage?.(updateRulerDimensionValue(page, rulerEdit.id, rulerEdit.axis, rulerEdit.value!, new Map(assets.map(asset => [asset.id, asset])), dimensionDisplayOverrides))
    else {
      const annotation = page.annotations?.find(item => item.id === rulerEdit.id)
      if (annotation?.kind === 'ruler') changeAnnotation({ ...annotation, measuredMm: rulerEdit.value! })
    }
    setRulerEdit(null)
  }
  const menuItem = page?.items.find(item => item.id === artworkMenu?.itemId)
  const menuAsset = assets.find(asset => asset.id === menuItem?.assetId)
  const assetMap = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets])
  const selectedAssetId = useMemo(() => {
    const selected = page?.items.find(item => item.id === selectedItem)
    return selected && assetMap.has(selected.assetId) ? selected.assetId : undefined
  }, [assetMap, page, selectedItem])
  const selectedVisualItemIds = useMemo(() => {
    if (!page) return []
    const selected = new Set<string>()
    const groups = page.imageGroups ?? []
    if (selectedGroupIds.length) {
      for (const group of groups) if (selectedGroupIds.includes(group.id)) group.itemIds.forEach(id => selected.add(id))
    }
    if (boxSelection.length) {
      const boxed = new Set(boxSelection)
      for (const group of groups) if (group.itemIds.some(id => boxed.has(id))) group.itemIds.forEach(id => selected.add(id))
      boxSelection.forEach(id => selected.add(id))
    } else if (!selectedGroupIds.length && selectedItem) {
      selected.add(selectedItem)
    }
    return page.items.filter(item => selected.has(item.id)).map(item => item.id)
  }, [boxSelection, page, selectedGroupIds, selectedItem])
  const visualSelectionKey = `${selectedVisualItemIds.join('|')}|accessory:${selectedAccessoryKey ?? ''}`
  const selectedVisualScale = selectedAccessoryKey
    ? accessoryVisuals.get(selectedAccessoryKey)?.scale ?? 1
    : selectedVisualItemIds.length ? visualScales.get(selectedVisualItemIds[0]) ?? 1 : 1
  const hasVisualSelection = selectedVisualItemIds.length > 0 || selectedAccessoryKey !== null
  const singleAssetSelection = Boolean(selectedAssetId && selectedVisualItemIds.length === 1 && !selectedGroupIds.length && !boxSelection.length)
  const rulerItems = page?.items.filter(item => (boxSelection.length ? boxSelection.includes(item.id) : item.id === selectedItem) && !item.suppressRuler && assetMap.has(item.assetId)) ?? []
  const dimensionItemIds = rulerItems.map(item => item.id)
  const dimensionOverride = dimensionItemIds.map(id => dimensionDisplayOverrides.get(id)).find(Boolean)
  const dimensionPrecision = dimensionOverride?.precision ?? 'default'
  const dimensionDecimalPlaces = dimensionOverride?.decimalPlaces ?? 1
  const units = new Set(rulerItems.map(item => item.rulerUnit ?? 'mm'))
  const axes = rulerItems.map(item => rulerAxes(item, assetMap.get(item.assetId)!))
  const widthChecked = axes.length > 0 && axes.every(axis => axis.rulerWidth)
  const heightChecked = axes.length > 0 && axes.every(axis => axis.rulerHeight)
  const bothRulersChecked = axes.length > 0 && axes.every(axis => axis.rulerWidth && axis.rulerHeight)
  const sizeAxisValues = rulerItems.map(item => {
    const asset = assetMap.get(item.assetId)
    return item.sizeAxis ?? (asset && dimensionForItem(asset, item).horizontal ? 'width' : 'height')
  }).filter((axis): axis is 'width' | 'height' => Boolean(axis))
  const sizeAxisValue = sizeAxisValues.length > 0 && sizeAxisValues.every(axis => axis === sizeAxisValues[0]) ? sizeAxisValues[0] : ''
  const setRuler = (patch: RulerPatch) => {
    if (!rulerItems.length) return
    if (onChangeRulers) onChangeRulers(rulerItems.map(item => item.id), patch)
    else rulerItems.forEach(item => {
      const asset = assetMap.get(item.assetId)
      onChangeItem({ ...item, ...(asset ? rulerAxes(item, asset) : {}), ...patch })
    })
  }
  const selectedAssetIds = useMemo(() => selectedAssetId ? new Set([selectedAssetId]) : new Set<string>(), [selectedAssetId])
  useEffect(() => { setSidePanel(hasVisualSelection ? 'attributes' : 'pool') }, [hasVisualSelection, selectedAssetId, visualSelectionKey])
  useEffect(() => { setVisualScaleInput(String(Math.round(selectedVisualScale * 100))) }, [selectedVisualScale, visualSelectionKey])
  useEffect(() => {
    const remove = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' || event.repeat || exporting || replacingArtwork || artworkMenu || canvasMode !== 'select') return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="dialog"], .ant-modal, .ant-select'))) return
      if (document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) return
      if (editorSelection && page) { event.preventDefault(); onChangePage?.(deleteEditorSelection(page, editorSelection)); setEditorSelection(null); return }
      const ids = boxSelection.length
        ? (page?.imageGroups ?? []).filter(group => group.itemIds.some(id => boxSelection.includes(id))).map(group => group.id)
        : selectedGroupIds.length ? selectedGroupIds : (page?.imageGroups ?? []).filter(group => group.itemIds.includes(selectedItem ?? '')).map(group => group.id)
      if (!ids.length) return
      event.preventDefault()
      onDeleteGroups(ids)
      setBoxSelection([])
      setSidePanel('pool')
    }
    window.addEventListener('keydown', remove)
    return () => window.removeEventListener('keydown', remove)
  }, [page, boxSelection, selectedGroupIds, selectedItem, exporting, replacingArtwork, artworkMenu, canvasMode, onDeleteGroups, editorSelection, onChangePage])
  const updateVisualScale = (value: number) => {
    const scale = clampCanvasDisplayScale(value)
    if (selectedAccessoryKey) {
      setAccessoryVisuals(previous => {
        const next = new Map(previous)
        const current = next.get(selectedAccessoryKey) ?? { scale: 1, x: 0, y: 0 }
        next.set(selectedAccessoryKey, { ...current, scale })
        return next
      })
      setVisualScaleInput(String(Math.round(scale * 100)))
      return
    }
    setVisualScales(previous => {
      const next = new Map(previous)
      for (const id of selectedVisualItemIds) {
        if (Math.abs(scale - 1) < 1e-6) next.delete(id)
        else next.set(id, scale)
      }
      return next
    })
    setVisualScaleInput(String(Math.round(scale * 100)))
  }
  const commitVisualScale = () => {
    const value = Number(visualScaleInput)
    if (!Number.isFinite(value)) {
      setVisualScaleInput(String(Math.round(selectedVisualScale * 100)))
      return
    }
    updateVisualScale(value / 100)
  }
  useEffect(() => {
    const workspace = workspaceRef.current
    const wheel = (event: WheelEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || !Number.isFinite(event.deltaY) || event.deltaY === 0
        || !hasVisualSelection || exporting || replacingArtwork || artworkMenu || canvasMode !== 'select' || textEdit || rulerEdit) return
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.stage-wrap, .visual-scale-controls')) return
      const editingText = (element: Element | null) => element instanceof HTMLElement
        && (element.isContentEditable || Boolean(element.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], .ant-modal')))
      if (editingText(target) || editingText(document.activeElement)
        || document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) return
      event.preventDefault()
      event.stopPropagation()
      const step = event.deltaY < 0 ? CANVAS_DISPLAY_SCALE_STEP : -CANVAS_DISPLAY_SCALE_STEP
      // Read the current scale inside the updater so rapid wheel events cannot
      // reuse a render's old percentage and lose increments.
      onDisplayStateChange(previous => {
        if (selectedAccessoryKey) {
          const accessoryVisuals = new Map(previous.accessoryVisuals)
          const current = accessoryVisuals.get(selectedAccessoryKey) ?? { scale: 1, x: 0, y: 0 }
          const scale = clampCanvasDisplayScale(Number((current.scale + step).toFixed(2)))
          accessoryVisuals.set(selectedAccessoryKey, { ...current, scale })
          return { ...previous, accessoryVisuals }
        }
        const visualScales = new Map(previous.visualScales)
        const current = visualScales.get(selectedVisualItemIds[0]) ?? 1
        const scale = clampCanvasDisplayScale(Number((current + step).toFixed(2)))
        for (const id of selectedVisualItemIds) {
          if (Math.abs(scale - 1) < 1e-6) visualScales.delete(id)
          else visualScales.set(id, scale)
        }
        return { ...previous, visualScales }
      })
    }
    workspace?.addEventListener('wheel', wheel, { passive: false, capture: true })
    return () => workspace?.removeEventListener('wheel', wheel, true)
  }, [hasVisualSelection, exporting, replacingArtwork, artworkMenu, canvasMode, textEdit, rulerEdit, selectedAccessoryKey, selectedVisualItemIds, onDisplayStateChange])
  const updateDimensionOverride = (patch: Partial<DimensionDisplayOverride>) => {
    if (!rulerItems.length) return
    setDimensionDisplayOverrides(previous => {
      const next = new Map(previous)
      for (const id of dimensionItemIds) {
        const current = next.get(id) ?? { precision: 'default' as const, decimalPlaces: 1 }
        next.set(id, { ...current, ...patch })
      }
      return next
    })
  }
  const changeDimensionPrecision = (value: DimensionDisplayPrecision) => {
    updateDimensionOverride({ precision: value })
  }
  const changeDimensionDecimalPlaces = (value: number) => {
    const decimalPlaces = Math.max(0, Math.min(6, Math.trunc(value)))
    updateDimensionOverride({ decimalPlaces })
  }
  const progressPercent = exportProgress.total > 0 ? Math.min(100, Math.round(exportProgress.completed / exportProgress.total * 100)) : 0
  return <main ref={workspaceRef} className="workspace arrange-page-enter">{context}{exporting && <div className="pdf-export-overlay" role="status" aria-live="polite"><div className="pdf-export-dialog"><Loading size="large"/><strong>正在导出 PDF</strong><div className="pdf-export-progress-track"><div className={`pdf-export-progress-value ${progressPercent === 0 ? 'is-preparing' : ''}`} style={{ width: `${progressPercent}%` }}/></div><span>{pdfProgressText(exportProgress)} {progressPercent}%</span><small>请稍候，导出期间不能重复操作</small></div></div>}
    {replacingArtwork && <div className="pdf-export-overlay" role="status" aria-live="polite"><div className="pdf-export-dialog"><Loading size="large"/><strong>{processingLabel ?? '正在更换图片'}</strong><span>{processingLabel ? '正在后台计算布局，请稍候' : '正在读取 SVG 图片…'}</span></div></div>}
    <aside className="pages-panel" inert={replacingArtwork}>
      <div className="panel-title"><span>示意图缩略图 <em>{pages.length}</em></span><button className="icon-btn" onClick={onAddPage} title="新建页面"><Plus size={17}/></button></div>
      <PageThumbnailList pages={pages} assets={assetMap} activePage={activePage} onSelect={onSelectPage} onReorder={onReorderPages} disabled={exporting || replacingArtwork} visualScales={visualScales}/>
      <button className="new-page" onClick={onAddPage}><Plus size={15}/>新建页面</button>
    </aside>
    <section className="canvas-area" inert={replacingArtwork}>
      <div className="canvas-head"><div className="canvas-back-actions"><Button type="primary" icon={<ArrowLeft size={16}/>} onClick={onBack} disabled={exporting}>返回图片列表</Button><Button onClick={onBackToHistory} disabled={exporting}>回到历史记录</Button></div><div className="canvas-title-center"><h1>示意图打印预览</h1><span className="muted">页面 {pageNumber} / {pages.length} · {page?.items.filter(item => !item.derivedFrom).length ?? 0} 张图片</span></div><div className="canvas-actions"><select className="export-format" value={exportFormat} disabled={exporting} onChange={event => setExportFormat(event.target.value as typeof exportFormat)}><option value="jpg">JPG</option><option value="png">PNG</option><option value="svg">SVG</option><option value="pdf">PDF</option></select><Button type="primary" icon={exporting ? <Loading size="small" inline /> : <Download size={16}/>} disabled={exporting} onClick={() => onExport(exportFormat, dimensionDisplayOverrides)}>{exporting ? '导出中…' : '导出'}</Button></div></div>
      <div className="toolbar">
        <Button type="text" className={canvasMode === 'select' ? 'toolbar-mode-active' : ''} icon={<MousePointer2 size={15}/>} onClick={() => setCanvasMode('select')}>选择</Button>
        <Button type="text" className={canvasMode === 'pan' ? 'toolbar-mode-active' : ''} icon={<Hand size={15}/>} onClick={() => setCanvasMode('pan')}>平移</Button>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        <Button type="text" icon={<WandSparkles size={15}/>} title={`点击后按${sortMode === 'default' ? '上传顺序' : '产品排序'}重新排列当前画布`} onClick={() => { setSelectedAccessoryKey(null); setBoxSelection([]); onAutoArrange(sortMode === 'default' ? 'upload' : 'default') }}>切换为{sortMode === 'default' ? '上传顺序' : '产品排序'}</Button>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        <Button type="text" icon={<Combine size={15}/>} disabled={selectedGroupIds.length < 2 || exporting || replacingArtwork} onClick={() => { setBoxSelection([]); onCombine() }}>组合</Button>
        {selectedGroupIds.length > 0 && <span className="muted">已选 {selectedGroupIds.length} 组（按住 Ctrl 多选）</span>}
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        {boxSelection.length > 0 && <span className="muted">框选 {boxSelection.length} 张</span>}
        <label className="toolbar-decimal-places"><span>小数位数</span><InputNumber aria-label="小数位数" min={0} max={6} precision={0} size="small" disabled={!rulerItems.length} value={dimensionDecimalPlaces} onChange={value => changeDimensionDecimalPlaces(value == null ? 1 : value)}/></label>
        <select aria-label="标尺单位" disabled={!rulerItems.length} value={units.size > 1 ? '' : rulerItems[0]?.rulerUnit ?? 'mm'} onChange={event => setRuler({ rulerUnit: event.target.value as 'mm' | 'cm' | 'in' })}>
          {units.size > 1 && <option value="" disabled>混合单位</option>}<option value="mm">mm</option><option value="cm">cm</option><option value="in">in</option>
        </select>
        <select aria-label="尺寸显示精度" title="仅改变当前选中图片的尺寸显示，不修改原始尺寸" disabled={!rulerItems.length} value={rulerItems.length ? dimensionPrecision : 'default'} onChange={event => changeDimensionPrecision(event.target.value as DimensionDisplayPrecision)}>
          <option value="default">默认值</option><option value="round">四舍五入</option><option value="truncate">舍弃小数</option>
        </select>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        <label><input type="checkbox" disabled={!rulerItems.length} checked={widthChecked} ref={node => { if (node) node.indeterminate = !widthChecked && axes.some(axis => axis.rulerWidth) }} onChange={event => setRuler({ rulerWidth: event.target.checked })}/>宽标尺</label>
        <label><input type="checkbox" disabled={!rulerItems.length} checked={heightChecked} ref={node => { if (node) node.indeterminate = !heightChecked && axes.some(axis => axis.rulerHeight) }} onChange={event => setRuler({ rulerHeight: event.target.checked })}/>高标尺</label>
        {bothRulersChecked && <select aria-label="Size使用方向" title="选择属性 Size 使用宽度或高度" value={sizeAxisValue} onChange={event => setRuler({ sizeAxis: event.target.value as 'width' | 'height' })}><option value="" disabled>Size 使用方向</option><option value="width">Size 使用宽</option><option value="height">Size 使用高</option></select>}
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/><span className="toolbar-spacer"/>
        <button className="zoom-btn" title="缩小画布" onClick={() => setZoom(value => Math.max(0.5, Number((value - 0.1).toFixed(2))))}><ZoomOut size={16}/></button><span className="zoom-value">{Math.round(zoom * 100)}%</span><button className="zoom-btn" title="放大画布" onClick={() => setZoom(value => Math.min(2.5, Number((value + 0.1).toFixed(2))))}><ZoomIn size={16}/></button>
      </div>
      <div className="canvas-editor-surface">
      <CanvasTools tool={canvasMode} onTool={tool => { setCanvasMode(tool); setArtworkMenu(null) }} background={backgroundColor} onBackground={color => onBackgroundChange?.('group', color, selectedBackgroundGroups)} hasGroup={selectedBackgroundGroups.length > 0} disabled={exporting || replacingArtwork}/>
      {page && <ArtworkCanvas onEditDetailText={draft => { chooseEditor(draft); setTextEdit(draft) }} page={page} pageNumber={pageNumber} editorSelection={editorSelection} onSelectEditor={chooseEditor} textColor={textColor} onPlaceText={placeText} onCancelTool={() => setCanvasMode('select')} onAddRuler={ruler => { changeAnnotation(ruler); chooseEditor({ kind: 'annotation', id: ruler.id }); setCanvasMode('select') }} onChangeAnnotation={changeAnnotation} onEditAnnotation={annotation => annotation.kind === 'text' ? setTextEdit(annotation) : setRulerEdit({ id: annotation.id, value: annotation.measuredMm, unit: 'mm' })} onEditRuler={editRuler} assets={assetMap} selected={selectedItem} selectedIds={boxSelection} onBoxSelect={ids => { setEditorSelection(null); setSelectedAccessoryKey(null); onSelectItem(null); setBoxSelection(ids) }} selectedGroupIds={selectedGroupIds} onSelect={selectOne} onSelectGroup={selectGroup} onResizeGroup={exporting || replacingArtwork ? undefined : onResizeGroup} onSelectAccessory={selectAccessory} selectedAccessoryKey={selectedAccessoryKey ?? undefined} accessoryVisuals={accessoryVisuals} onChangeAccessory={changeAccessory} onChange={onChangeItem} onDropAsset={onDropAsset} metadata={metadata} totalPages={pages.length} mode={canvasMode} zoom={zoom} onZoomChange={setZoom} layoutBounds={layoutBounds} onHeaderBlockChange={onChangeHeaderBlock} dimensionItemIds={dimensionItemIds} dimensionPrecision={dimensionPrecision} dimensionDecimalPlaces={dimensionDecimalPlaces} dimensionDisplayOverrides={dimensionDisplayOverrides} visualScales={visualScales} onChangeRuler={onChangeRuler} onEditText={onEditText} onArtworkContextMenu={exporting || replacingArtwork ? undefined : (itemId, point) => setArtworkMenu({ itemId, ...point })}/>}
      {(canvasMode === 'text' || canvasMode === 'ruler') && <div className="canvas-tool-hint"><span>{canvasMode === 'text' ? '点击画布放置文字 · Esc 取消' : '点击起点、终点，再移动鼠标确定标尺位置，第三次点击完成 · Esc 取消'}</span></div>}
      </div>
      <Modal title="编辑文字" open={Boolean(textEdit)} destroyOnHidden onCancel={() => setTextEdit(null)} okText="确认" cancelText="取消" okButtonProps={{ disabled: !textEdit?.text.trim() }} onOk={() => { if (!textEdit?.text.trim()) return; if (textEdit.kind === 'detail') { if (page) onChangePage?.(updateDetailText(page, textEdit, { text: textEdit.text, fontSize: textEdit.fontSize, color: textEdit.color, hidden: false })); chooseEditor(textEdit) } else { changeAnnotation(textEdit); chooseEditor({ kind: 'annotation', id: textEdit.id }) } setTextEdit(null) }}>
        <Input.TextArea aria-label="画布文字" autoFocus rows={3} value={textEdit?.text ?? ''} onChange={event => setTextEdit(previous => previous ? { ...previous, text: event.target.value } : previous)}/>
        <label>字号 <InputNumber aria-label="文字字号" min={6} max={72} precision={2} value={textEdit?.fontSize ?? 12} onChange={value => setTextEdit(previous => previous ? { ...previous, fontSize: value ?? 12 } : previous)}/></label>
        <label>文字颜色 <ColorPicker aria-label="文字颜色" value={textEdit?.color ?? '#000000'} disabledAlpha onChangeComplete={color => { const value = color.toHexString(); setTextColor(value); setTextEdit(previous => previous ? { ...previous, color: value } : previous) }}/></label>
      </Modal>
      <Modal title="修改标尺数值" open={Boolean(rulerEdit)} destroyOnHidden onCancel={() => setRulerEdit(null)} onOk={confirmRulerEdit} okText="确认" cancelText="取消" okButtonProps={{ disabled: !rulerEdit?.value || rulerEdit.value <= 0 }}>
        <InputNumber aria-label="标尺数值" autoFocus min={0.000001} value={rulerEdit?.value} onChange={value => setRulerEdit(previous => previous ? { ...previous, value } : previous)} onPressEnter={confirmRulerEdit} addonAfter={rulerEdit?.unit}/>
      </Modal>
      {artworkMenu && menuItem && menuAsset && <ArtworkContextMenu target={artworkMenu} item={menuItem} asset={menuAsset} onClose={() => setArtworkMenu(null)} onChange={onChangeItem} onReplace={onReplaceArtwork} onHorizontal={onHorizontalGroup}/>}
      <div className="canvas-footer"><span>画布尺寸：A4 · 210 × 297 mm</span><span>当前页面 {page?.items.filter(item => !item.derivedFrom).length ?? 0} 张 · 全部页面 {pages.reduce((total, item) => total + item.items.filter(image => !image.derivedFrom).length, 0)} 张</span><span className="saved" title="导出成功后保存当前排列与调整，可在示意图审核中恢复"><i/>导出后保存到审核</span></div>
    </section>
    <aside className="assets-panel" inert={replacingArtwork}><PageConfigPanel metadata={metadata} onMetadataChange={onMetadataChange} bounds={layoutBounds} onBoundsChange={onBoundsChange} pageId={pageNumber} headerBlocks={page?.headerBlocks ?? []} selectedHeaderBlock={selectedItem} onSelectHeaderBlock={selectOne} onAddHeaderBlock={onAddHeaderBlock} onChangeHeaderBlock={onChangeHeaderBlock} onRemoveHeaderBlock={onRemoveHeaderBlock}/><div className="asset-section arrange-pool-section"><div className="arrange-pool-shell"><div className="arrange-side-tabs" role="tablist" aria-label="排列页图片面板"><button type="button" role="tab" aria-selected={sidePanel === 'pool'} className={sidePanel === 'pool' ? 'active' : ''} onClick={() => setSidePanel('pool')}>图片池</button><button type="button" role="tab" aria-selected={sidePanel === 'attributes'} className={sidePanel === 'attributes' ? 'active' : ''} disabled={!hasVisualSelection} title={hasVisualSelection ? '调整选中图片的画布显示大小' : '请先在画布中选择图片或图片组'} onClick={() => hasVisualSelection && setSidePanel('attributes')}>图片属性</button></div>{sidePanel === 'attributes' && hasVisualSelection ? <div className="arrange-attributes-content"><div className="visual-scale-controls" aria-label="图片视觉缩放"><span>图片显示</span><button type="button" className="zoom-btn" title="缩小图片" disabled={exporting} onClick={() => updateVisualScale(selectedVisualScale - CANVAS_DISPLAY_SCALE_STEP)}><ZoomOut size={15}/></button><input aria-label="图片显示百分比" type="number" min={25} max={300} step={1} value={visualScaleInput} disabled={exporting} onChange={event => setVisualScaleInput(event.target.value)} onBlur={commitVisualScale} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitVisualScale() } }}/><span>%</span><button type="button" className="zoom-btn" title="放大图片" disabled={exporting} onClick={() => updateVisualScale(selectedVisualScale + CANVAS_DISPLAY_SCALE_STEP)}><ZoomIn size={15}/></button><small>Alt＋滚轮调整图片大小（每次 10%）；仅改变显示，标尺同步缩放</small></div>{singleAssetSelection && selectedAssetId ? <ProductAttributesPanel allowGrouping={false} assets={assets} selectedAssetIds={selectedAssetIds} onConfirmAttributes={patch => onConfirmAssetAttributes(selectedAssetId, patch)} showSelectionSummary={false} disabled={exporting}/> : null}</div> : <div className="arrange-pool-content"><AssetPool assets={assets} pages={pages} mode="arrange" onAddAsset={onDropAsset}/></div>}</div></div></aside>
  </main>
}



