import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from 'antd'
import { Download, Hand, MousePointer2, Plus, WandSparkles, ZoomIn, ZoomOut, ArrowLeft, Combine } from 'lucide-react'
import type { Asset, HeaderBlock, Item, LayoutBounds, Page, PageHeader } from '../../model'
import { rulerAxes, type RulerPatch } from './services/canvasSelectionService'
import type { DimensionDisplayPrecision } from './services/imageDimensionService'
import { CANVAS_DISPLAY_SCALE_STEP, clampCanvasDisplayScale } from './services/canvasDisplayScaleService'
import './arrange-toolbar.css'
import ArtworkCanvas from './ArtworkCanvas'
import AssetPool from './components/AssetPool'
import ProductAttributesPanel from './components/ProductAttributesPanel'
import PageThumbnail from './components/PageThumbnail'
import Loading from '../../components/Loading'
import PageConfigPanel from './components/PageConfigPanel'
import { pdfProgressText, type PdfExportProgress } from './services/exportService'
import type { ProductAttributePatch } from './services/productOptionRules'

type Props = {
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
  onChangeRulers: (ids: string[], patch: RulerPatch) => void
  onDropAsset: (assetId: string, x?: number, y?: number) => void
  onDeleteGroups: (ids: string[]) => void
  onConfirmAssetAttributes: (assetId: string, patch: ProductAttributePatch) => Promise<void>
  onAddPage: () => void
  onAutoArrange: (mode?: 'default' | 'upload') => void
  onCombine: () => void
  onSelectGroup: (id: string, ctrlKey: boolean) => void
  onBack: () => void
  onExport: (format: 'jpg' | 'png' | 'svg' | 'pdf') => void
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

export default function ArrangePage({ context, assets, pages, activePage, selectedItem, selectedGroupIds, sortMode, onSelectPage, onSelectItem, onSelectGroup, onChangeItem, onChangeRulers, onDropAsset, onDeleteGroups, onConfirmAssetAttributes, onAddPage, onAutoArrange, onCombine, onBack, onExport, exporting = false, exportProgress = { phase: 'rendering', completed: 0, total: 1 }, metadata = {}, onMetadataChange, layoutBounds, onBoundsChange, onAddHeaderBlock, onChangeHeaderBlock, onRemoveHeaderBlock }: Props) {
  const [exportFormat, setExportFormat] = useState<'jpg' | 'png' | 'svg' | 'pdf'>('pdf')
  const [canvasMode, setCanvasMode] = useState<'select' | 'pan'>('select')
  const [sidePanel, setSidePanel] = useState<'pool' | 'attributes'>('pool')
  const [zoom, setZoom] = useState(1)
  const [dimensionPrecision, setDimensionPrecision] = useState<DimensionDisplayPrecision>('default')
  const [boxSelection, setBoxSelection] = useState<string[]>([])
  const [visualScales, setVisualScales] = useState<Map<string, number>>(new Map())
  const [accessoryVisuals, setAccessoryVisuals] = useState<Map<string, { scale: number; x: number; y: number }>>(new Map())
  const [selectedAccessoryKey, setSelectedAccessoryKey] = useState<string | null>(null)
  const [visualScaleInput, setVisualScaleInput] = useState('100')
  useEffect(() => { setBoxSelection([]); setSelectedAccessoryKey(null) }, [activePage])
  const selectOne = (id: string | null) => { setSelectedAccessoryKey(null); setBoxSelection([]); onSelectItem(id) }
  const selectGroup = (id: string, ctrlKey: boolean) => { setSelectedAccessoryKey(null); setBoxSelection([]); onSelectGroup(id, ctrlKey) }
  const selectAccessory = (key: string) => { setSelectedAccessoryKey(key); setBoxSelection([]); onSelectItem(null) }
  const changeAccessory = (key: string, patch: Partial<{ scale: number; x: number; y: number }>) => {
    setAccessoryVisuals(previous => {
      const next = new Map(previous)
      next.set(key, { scale: 1, x: 0, y: 0, ...next.get(key), ...patch })
      return next
    })
  }
  const page = pages.find(item => item.id === activePage) ?? pages[0]
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
  const dimensionItemId = rulerItems.length === 1 ? rulerItems[0].id : undefined
  const units = new Set(rulerItems.map(item => item.rulerUnit ?? 'mm'))
  const axes = rulerItems.map(item => rulerAxes(item, assetMap.get(item.assetId)!))
  const widthChecked = axes.length > 0 && axes.every(axis => axis.rulerWidth)
  const heightChecked = axes.length > 0 && axes.every(axis => axis.rulerHeight)
  const setRuler = (patch: RulerPatch) => onChangeRulers(rulerItems.map(item => item.id), patch)
  const selectedAssetIds = useMemo(() => selectedAssetId ? new Set([selectedAssetId]) : new Set<string>(), [selectedAssetId])
  useEffect(() => { setDimensionPrecision('default') }, [dimensionItemId])
  useEffect(() => { setSidePanel(hasVisualSelection ? 'attributes' : 'pool') }, [hasVisualSelection, selectedAssetId, visualSelectionKey])
  useEffect(() => { setVisualScaleInput(String(Math.round(selectedVisualScale * 100))) }, [selectedVisualScale, visualSelectionKey])
  useEffect(() => {
    const remove = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' || event.repeat || exporting || canvasMode !== 'select') return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="dialog"], .ant-modal, .ant-select'))) return
      if (document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) return
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
  }, [page, boxSelection, selectedGroupIds, selectedItem, exporting, canvasMode, onDeleteGroups])
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
  const progressPercent = exportProgress.total > 0 ? Math.min(100, Math.round(exportProgress.completed / exportProgress.total * 100)) : 0
  return <main className="workspace arrange-page-enter">{context}{exporting && <div className="pdf-export-overlay" role="status" aria-live="polite"><div className="pdf-export-dialog"><Loading size="large"/><strong>正在导出 PDF</strong><div className="pdf-export-progress-track"><div className={`pdf-export-progress-value ${progressPercent === 0 ? 'is-preparing' : ''}`} style={{ width: `${progressPercent}%` }}/></div><span>{pdfProgressText(exportProgress)} {progressPercent}%</span><small>请稍候，导出期间不能重复操作</small></div></div>}
    <aside className="pages-panel">
      <div className="panel-title"><span>示意图缩略图 <em>{pages.length}</em></span><button className="icon-btn" onClick={onAddPage} title="新建页面"><Plus size={17}/></button></div>
      <div className="pages-list">{pages.map(item => <PageThumbnail key={item.id} page={item} assets={assetMap} active={item.id === activePage} onClick={() => onSelectPage(item.id)} />)}</div>
      <button className="new-page" onClick={onAddPage}><Plus size={15}/>新建页面</button>
    </aside>
    <section className="canvas-area">
      <div className="canvas-head"><Button type="primary" icon={<ArrowLeft size={16}/>} onClick={onBack} disabled={exporting}>返回图片列表</Button><div className="canvas-title-center"><h1>示意图打印预览</h1><span className="muted">页面 {page?.id ?? 1} / {pages.length} · {page?.items.filter(item => !item.derivedFrom).length ?? 0} 张图片</span></div><div className="canvas-actions"><select className="export-format" value={exportFormat} disabled={exporting} onChange={event => setExportFormat(event.target.value as typeof exportFormat)}><option value="jpg">JPG</option><option value="png">PNG</option><option value="svg">SVG</option><option value="pdf">PDF（每页文件＋合并文件）</option></select><Button type="primary" icon={exporting ? <Loading size="small" inline /> : <Download size={16}/>} disabled={exporting} onClick={() => onExport(exportFormat)}>{exporting ? '导出中…' : '导出'}</Button></div></div>
      <div className="toolbar">
        <Button type="text" className={canvasMode === 'select' ? 'toolbar-mode-active' : ''} icon={<MousePointer2 size={15}/>} onClick={() => setCanvasMode('select')}>选择</Button>
        <Button type="text" className={canvasMode === 'pan' ? 'toolbar-mode-active' : ''} icon={<Hand size={15}/>} onClick={() => setCanvasMode('pan')}>平移</Button>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        <Button type="text" icon={<WandSparkles size={15}/>} title={`点击后按${sortMode === 'default' ? '上传顺序' : '产品排序'}重新排列当前画布`} onClick={() => { setSelectedAccessoryKey(null); setBoxSelection([]); onAutoArrange(sortMode === 'default' ? 'upload' : 'default') }}>自动排列 · 切换为{sortMode === 'default' ? '上传顺序' : '产品排序'}</Button>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        <Button type="text" icon={<Combine size={15}/>} disabled={selectedGroupIds.length !== 2} onClick={() => { setBoxSelection([]); onCombine() }}>组合</Button>
        {selectedGroupIds.length > 0 && <span className="muted">已选 {selectedGroupIds.length}/2 组（按住 Ctrl 选择）</span>}
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        {boxSelection.length > 0 && <span className="muted">框选 {boxSelection.length} 张</span>}
        <select aria-label="标尺单位" disabled={!rulerItems.length} value={units.size > 1 ? '' : rulerItems[0]?.rulerUnit ?? 'mm'} onChange={event => setRuler({ rulerUnit: event.target.value as 'mm' | 'cm' | 'in' })}>
          {units.size > 1 && <option value="" disabled>混合单位</option>}<option value="mm">mm</option><option value="cm">cm</option><option value="in">in</option>
        </select>
        <select aria-label="尺寸显示精度" title="仅改变当前单个图片的尺寸显示，不修改原始尺寸" disabled={!dimensionItemId} value={dimensionItemId ? dimensionPrecision : 'default'} onChange={event => setDimensionPrecision(event.target.value as DimensionDisplayPrecision)}>
          <option value="default">默认值</option><option value="round">四舍五入</option><option value="truncate">舍弃小数</option>
        </select>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        <label><input type="checkbox" disabled={!rulerItems.length} checked={widthChecked} ref={node => { if (node) node.indeterminate = !widthChecked && axes.some(axis => axis.rulerWidth) }} onChange={event => setRuler({ rulerWidth: event.target.checked })}/>宽标尺</label>
        <label><input type="checkbox" disabled={!rulerItems.length} checked={heightChecked} ref={node => { if (node) node.indeterminate = !heightChecked && axes.some(axis => axis.rulerHeight) }} onChange={event => setRuler({ rulerHeight: event.target.checked })}/>高标尺</label>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/><span className="toolbar-spacer"/>
        <button className="zoom-btn" title="缩小画布" onClick={() => setZoom(value => Math.max(0.5, Number((value - 0.1).toFixed(2))))}><ZoomOut size={16}/></button><span className="zoom-value">{Math.round(zoom * 100)}%</span><button className="zoom-btn" title="放大画布" onClick={() => setZoom(value => Math.min(2.5, Number((value + 0.1).toFixed(2))))}><ZoomIn size={16}/></button>
      </div>
      {page && <ArtworkCanvas page={page} assets={assetMap} selected={selectedItem} selectedIds={boxSelection} onBoxSelect={ids => { setSelectedAccessoryKey(null); onSelectItem(null); setBoxSelection(ids) }} selectedGroupIds={selectedGroupIds} onSelect={selectOne} onSelectGroup={selectGroup} onSelectAccessory={selectAccessory} selectedAccessoryKey={selectedAccessoryKey ?? undefined} accessoryVisuals={accessoryVisuals} onChangeAccessory={changeAccessory} onChange={onChangeItem} onDropAsset={onDropAsset} metadata={metadata} totalPages={pages.length} mode={canvasMode} zoom={zoom} onZoomChange={setZoom} layoutBounds={layoutBounds} onHeaderBlockChange={onChangeHeaderBlock} dimensionItemId={dimensionItemId} dimensionPrecision={dimensionPrecision} visualScales={visualScales}/>}<div className="canvas-footer"><span>画布尺寸：A4 · 210 × 297 mm</span><span>当前页面 {page?.items.filter(item => !item.derivedFrom).length ?? 0} 张 · 全部页面 {pages.reduce((total, item) => total + item.items.filter(image => !image.derivedFrom).length, 0)} 张</span><span className="saved"><i/>已自动保存</span></div>
    </section>
    <aside className="assets-panel"><PageConfigPanel metadata={metadata} onMetadataChange={onMetadataChange} bounds={layoutBounds} onBoundsChange={onBoundsChange} pageId={page?.id ?? activePage} headerBlocks={page?.headerBlocks ?? []} selectedHeaderBlock={selectedItem} onSelectHeaderBlock={selectOne} onAddHeaderBlock={onAddHeaderBlock} onChangeHeaderBlock={onChangeHeaderBlock} onRemoveHeaderBlock={onRemoveHeaderBlock}/><div className="asset-section arrange-pool-section"><div className="arrange-pool-shell"><div className="arrange-side-tabs" role="tablist" aria-label="排列页图片面板"><button type="button" role="tab" aria-selected={sidePanel === 'pool'} className={sidePanel === 'pool' ? 'active' : ''} onClick={() => setSidePanel('pool')}>图片池</button><button type="button" role="tab" aria-selected={sidePanel === 'attributes'} className={sidePanel === 'attributes' ? 'active' : ''} disabled={!hasVisualSelection} title={hasVisualSelection ? '调整选中图片的画布显示大小' : '请先在画布中选择图片或图片组'} onClick={() => hasVisualSelection && setSidePanel('attributes')}>图片属性</button></div>{sidePanel === 'attributes' && hasVisualSelection ? <div className="arrange-attributes-content"><div className="visual-scale-controls" aria-label="图片视觉缩放"><span>图片显示</span><button type="button" className="zoom-btn" title="缩小图片" disabled={exporting} onClick={() => updateVisualScale(selectedVisualScale - CANVAS_DISPLAY_SCALE_STEP)}><ZoomOut size={15}/></button><input aria-label="图片显示百分比" type="number" min={25} max={300} step={1} value={visualScaleInput} disabled={exporting} onChange={event => setVisualScaleInput(event.target.value)} onBlur={commitVisualScale} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitVisualScale() } }}/><span>%</span><button type="button" className="zoom-btn" title="放大图片" disabled={exporting} onClick={() => updateVisualScale(selectedVisualScale + CANVAS_DISPLAY_SCALE_STEP)}><ZoomIn size={15}/></button><small>仅改变画布显示，不修改真实尺寸；标尺随显示大小调整</small></div>{singleAssetSelection && selectedAssetId ? <ProductAttributesPanel allowGrouping={false} assets={assets} selectedAssetIds={selectedAssetIds} onConfirmAttributes={patch => onConfirmAssetAttributes(selectedAssetId, patch)} showSelectionSummary={false} disabled={exporting}/> : null}</div> : <div className="arrange-pool-content"><AssetPool assets={assets} pages={pages} mode="arrange" onAddAsset={onDropAsset}/></div>}</div></div></aside>
  </main>
}



