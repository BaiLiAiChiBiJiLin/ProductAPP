import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from 'antd'
import { Download, Hand, MousePointer2, Plus, WandSparkles, ZoomIn, ZoomOut, ArrowLeft, Combine } from 'lucide-react'
import type { Asset, HeaderBlock, Item, LayoutBounds, Page, PageHeader } from '../../model'
import { rulerAxes, type RulerPatch } from './services/canvasSelectionService'
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
  const [boxSelection, setBoxSelection] = useState<string[]>([])
  useEffect(() => { setBoxSelection([]) }, [activePage])
  const selectOne = (id: string | null) => { setBoxSelection([]); onSelectItem(id) }
  const selectGroup = (id: string, ctrlKey: boolean) => { setBoxSelection([]); onSelectGroup(id, ctrlKey) }
  const page = pages.find(item => item.id === activePage) ?? pages[0]
  const assetMap = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets])
  const selectedAssetId = useMemo(() => {
    const selected = page?.items.find(item => item.id === selectedItem)
    return selected && assetMap.has(selected.assetId) ? selected.assetId : undefined
  }, [assetMap, page, selectedItem])
  const rulerItems = page?.items.filter(item => (boxSelection.length ? boxSelection.includes(item.id) : item.id === selectedItem) && !item.suppressRuler && assetMap.has(item.assetId)) ?? []
  const units = new Set(rulerItems.map(item => item.rulerUnit ?? 'mm'))
  const axes = rulerItems.map(item => rulerAxes(item, assetMap.get(item.assetId)!))
  const widthChecked = axes.length > 0 && axes.every(axis => axis.rulerWidth)
  const heightChecked = axes.length > 0 && axes.every(axis => axis.rulerHeight)
  const setRuler = (patch: RulerPatch) => onChangeRulers(rulerItems.map(item => item.id), patch)
  const selectedAssetIds = useMemo(() => selectedAssetId ? new Set([selectedAssetId]) : new Set<string>(), [selectedAssetId])
  useEffect(() => { setSidePanel(selectedAssetId ? 'attributes' : 'pool') }, [selectedAssetId])
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
  const progressPercent = exportProgress.total > 0 ? Math.min(100, Math.round(exportProgress.completed / exportProgress.total * 100)) : 0
  return <main className="workspace arrange-page-enter">{context}{exporting && <div className="pdf-export-overlay" role="status" aria-live="polite"><div className="pdf-export-dialog"><Loading size="large"/><strong>正在导出 PDF</strong><div className="pdf-export-progress-track"><div className={`pdf-export-progress-value ${progressPercent === 0 ? 'is-preparing' : ''}`} style={{ width: `${progressPercent}%` }}/></div><span>{pdfProgressText(exportProgress)} {progressPercent}%</span><small>请稍候，导出期间不能重复操作</small></div></div>}
    <aside className="pages-panel">
      <div className="panel-title"><span>示意图缩略图 <em>{pages.length}</em></span><button className="icon-btn" onClick={onAddPage} title="新建页面"><Plus size={17}/></button></div>
      <div className="pages-list">{pages.map(item => <PageThumbnail key={item.id} page={item} assets={assetMap} active={item.id === activePage} onClick={() => onSelectPage(item.id)} />)}</div>
      <button className="new-page" onClick={onAddPage}><Plus size={15}/>新建页面</button>
    </aside>
    <section className="canvas-area">
      <div className="canvas-head"><Button type="primary" icon={<ArrowLeft size={16}/>} onClick={onBack} disabled={exporting}>返回图片列表</Button><div className="canvas-title-center"><h1>示意图打印预览</h1><span className="muted">页面 {page?.id ?? 1} / {pages.length} · {page?.items.filter(item => !item.derivedFrom).length ?? 0} 张图片</span></div><div className="canvas-actions"><select className="export-format" value={exportFormat} disabled={exporting} onChange={event => setExportFormat(event.target.value as typeof exportFormat)}><option value="jpg">JPG</option><option value="png">PNG</option><option value="svg">SVG</option><option value="pdf">PDF（普通多页）</option></select><Button type="primary" icon={exporting ? <Loading size="small" inline /> : <Download size={16}/>} disabled={exporting} onClick={() => onExport(exportFormat)}>{exporting ? '导出中…' : '导出'}</Button></div></div>
      <div className="toolbar">
        <Button type="text" className={canvasMode === 'select' ? 'toolbar-mode-active' : ''} icon={<MousePointer2 size={15}/>} onClick={() => setCanvasMode('select')}>选择</Button>
        <Button type="text" className={canvasMode === 'pan' ? 'toolbar-mode-active' : ''} icon={<Hand size={15}/>} onClick={() => setCanvasMode('pan')}>平移</Button>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        <Button type="text" icon={<WandSparkles size={15}/>} title={`点击后按${sortMode === 'default' ? '上传顺序' : '产品排序'}重新排列当前画布`} onClick={() => { setBoxSelection([]); onAutoArrange(sortMode === 'default' ? 'upload' : 'default') }}>自动排列 · 切换为{sortMode === 'default' ? '上传顺序' : '产品排序'}</Button>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        <Button type="text" icon={<Combine size={15}/>} disabled={selectedGroupIds.length !== 2} onClick={() => { setBoxSelection([]); onCombine() }}>组合</Button>
        {selectedGroupIds.length > 0 && <span className="muted">已选 {selectedGroupIds.length}/2 组（按住 Ctrl 选择）</span>}
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        {boxSelection.length > 0 && <span className="muted">框选 {boxSelection.length} 张</span>}
        <select aria-label="标尺单位" disabled={!rulerItems.length} value={units.size > 1 ? '' : rulerItems[0]?.rulerUnit ?? 'mm'} onChange={event => setRuler({ rulerUnit: event.target.value as 'mm' | 'cm' | 'in' })}>
          {units.size > 1 && <option value="" disabled>混合单位</option>}<option value="mm">mm</option><option value="cm">cm</option><option value="in">in</option>
        </select>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/>
        <label><input type="checkbox" disabled={!rulerItems.length} checked={widthChecked} ref={node => { if (node) node.indeterminate = !widthChecked && axes.some(axis => axis.rulerWidth) }} onChange={event => setRuler({ rulerWidth: event.target.checked })}/>宽标尺</label>
        <label><input type="checkbox" disabled={!rulerItems.length} checked={heightChecked} ref={node => { if (node) node.indeterminate = !heightChecked && axes.some(axis => axis.rulerHeight) }} onChange={event => setRuler({ rulerHeight: event.target.checked })}/>高标尺</label>
        <span className="toolbar-divider" role="separator" aria-orientation="vertical"/><span className="toolbar-spacer"/>
        <button className="zoom-btn" title="缩小画布" onClick={() => setZoom(value => Math.max(0.5, Number((value - 0.1).toFixed(2))))}><ZoomOut size={16}/></button><span className="zoom-value">{Math.round(zoom * 100)}%</span><button className="zoom-btn" title="放大画布" onClick={() => setZoom(value => Math.min(2.5, Number((value + 0.1).toFixed(2))))}><ZoomIn size={16}/></button>
      </div>
      {page && <ArtworkCanvas page={page} assets={assetMap} selected={selectedItem} selectedIds={boxSelection} onBoxSelect={ids => { onSelectItem(null); setBoxSelection(ids) }} selectedGroupIds={selectedGroupIds} onSelect={selectOne} onSelectGroup={selectGroup} onChange={onChangeItem} onDropAsset={onDropAsset} metadata={metadata} totalPages={pages.length} mode={canvasMode} zoom={zoom} onZoomChange={setZoom} layoutBounds={layoutBounds} onHeaderBlockChange={onChangeHeaderBlock}/>}<div className="canvas-footer"><span>画布尺寸：A4 · 210 × 297 mm</span><span>当前页面 {page?.items.filter(item => !item.derivedFrom).length ?? 0} 张 · 全部页面 {pages.reduce((total, item) => total + item.items.filter(image => !image.derivedFrom).length, 0)} 张</span><span className="saved"><i/>已自动保存</span></div>
    </section>
    <aside className="assets-panel"><PageConfigPanel metadata={metadata} onMetadataChange={onMetadataChange} bounds={layoutBounds} onBoundsChange={onBoundsChange} pageId={page?.id ?? activePage} headerBlocks={page?.headerBlocks ?? []} selectedHeaderBlock={selectedItem} onSelectHeaderBlock={selectOne} onAddHeaderBlock={onAddHeaderBlock} onChangeHeaderBlock={onChangeHeaderBlock} onRemoveHeaderBlock={onRemoveHeaderBlock}/><div className="asset-section arrange-pool-section"><div className="arrange-pool-shell"><div className="arrange-side-tabs" role="tablist" aria-label="排列页图片面板"><button type="button" role="tab" aria-selected={sidePanel === 'pool'} className={sidePanel === 'pool' ? 'active' : ''} onClick={() => setSidePanel('pool')}>图片池</button><button type="button" role="tab" aria-selected={sidePanel === 'attributes'} className={sidePanel === 'attributes' ? 'active' : ''} disabled={!selectedAssetId} title={selectedAssetId ? '编辑当前选中的图片属性' : '请先在画布中选择一张图片'} onClick={() => selectedAssetId && setSidePanel('attributes')}>图片属性</button></div>{sidePanel === 'attributes' && selectedAssetId ? <div className="arrange-attributes-content"><ProductAttributesPanel allowGrouping={false} assets={assets} selectedAssetIds={selectedAssetIds} onConfirmAttributes={patch => onConfirmAssetAttributes(selectedAssetId, patch)} selectionHint="已选中画布中的图片，可直接修改产品属性。" disabled={exporting}/></div> : <div className="arrange-pool-content"><AssetPool assets={assets} pages={pages} mode="arrange" onAddAsset={onDropAsset}/></div>}</div></div></aside>
  </main>
}



