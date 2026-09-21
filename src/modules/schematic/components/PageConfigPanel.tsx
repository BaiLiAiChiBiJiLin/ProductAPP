import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { PAPER_WIDTH, type HeaderBlock, type PageHeader, type LayoutBounds } from '../../../model'
import HeaderBlocksEditor from './HeaderBlocksEditor'

type Props = {
  metadata: PageHeader
  onMetadataChange: (metadata: PageHeader) => void
  bounds: LayoutBounds
  onBoundsChange: (bounds: LayoutBounds) => void
  pageId: number
  headerBlocks: HeaderBlock[]
  selectedHeaderBlock: string | null
  onSelectHeaderBlock: (id: string) => void
  onAddHeaderBlock: () => void
  onChangeHeaderBlock: (block: HeaderBlock) => void
  onRemoveHeaderBlock: (id: string) => void
}

export default function PageConfigPanel({ metadata, onMetadataChange, bounds, onBoundsChange, pageId, headerBlocks, selectedHeaderBlock, onSelectHeaderBlock, onAddHeaderBlock, onChangeHeaderBlock, onRemoveHeaderBlock }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const updateHeader = (key: keyof PageHeader, value: string) => onMetadataChange({ ...metadata, [key]: value })
  const toMm = (value: number) => Number((value * 210 / PAPER_WIDTH).toFixed(1))
  const updateBound = (key: keyof LayoutBounds, value: string) => {
    if (value !== '' && Number.isFinite(Number(value))) onBoundsChange({ ...bounds, [key]: Number(value) * PAPER_WIDTH / 210 })
  }
  return <section className={`page-config-panel ${collapsed ? 'is-collapsed' : ''}`} aria-label="页面配置">
    <div className="section-heading"><span>页面配置</span><button type="button" className="page-config-toggle" aria-expanded={!collapsed} aria-label={collapsed ? '展开页面配置' : '收起页面配置'} title={collapsed ? '展开页面配置' : '收起页面配置'} onClick={() => setCollapsed(value => !value)}><ChevronDown size={16}/></button></div>
    <div className="page-config-body" aria-hidden={collapsed} inert={collapsed}><div className="page-config-inner">
    <p className="page-config-help">页眉和排列区域应用到所有页，表头仅应用到当前页。</p>
    <details className="page-config-section"><summary>页眉</summary><div className="page-config-fields">
      <label><span>客户</span><input value={metadata.customerName ?? ''} onChange={event => updateHeader('customerName', event.target.value)} placeholder="客户名称" /></label>
      <label><span>绘图日期</span><input type="date" value={metadata.drawingDate ?? ''} onChange={event => updateHeader('drawingDate', event.target.value)} /></label>
      <label><span>预计发货</span><input type="date" value={metadata.estimatedShipDate ?? ''} onChange={event => updateHeader('estimatedShipDate', event.target.value)} /></label>
      <label><span>设计者</span><input value={metadata.designer ?? ''} onChange={event => updateHeader('designer', event.target.value)} placeholder="设计者" /></label>
    </div></details>
    <details className="page-config-section"><summary>排列区域</summary><div className="page-config-fields page-config-bounds">
      <label><span>上边距 (mm)</span><input type="number" min="0" max="280" step="1" value={toMm(bounds.top)} onChange={event => updateBound('top', event.target.value)} /></label>
      <label><span>左边距 (mm)</span><input type="number" min="0" max="193" step="1" value={toMm(bounds.left)} onChange={event => updateBound('left', event.target.value)} /></label>
      <label><span>右边距 (mm)</span><input type="number" min="0" max="193" step="1" value={toMm(bounds.right)} onChange={event => updateBound('right', event.target.value)} /></label>
      <label><span>下边距 (mm)</span><input type="number" min="0" max="280" step="1" value={toMm(bounds.bottom)} onChange={event => updateBound('bottom', event.target.value)} /></label>
    </div><p className="page-config-help">圆角框为排列范围。图片与表头位置由自动排列确定，不能拖动。</p></details>
    <details className="page-config-section"><summary>表头</summary>
      <HeaderBlocksEditor pageId={pageId} blocks={headerBlocks} bounds={bounds} selected={selectedHeaderBlock} onSelect={onSelectHeaderBlock} onAdd={onAddHeaderBlock} onChange={onChangeHeaderBlock} onRemove={onRemoveHeaderBlock}/>
    </details>
    </div></div>
  </section>
}

