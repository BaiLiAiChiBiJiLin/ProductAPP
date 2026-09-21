import { Progress } from 'antd'
import { Upload } from 'lucide-react'
import CorelDrawTool from './CorelDrawTool'
import { schematicCopy } from '../copy'
import type { ImportProgress } from '../services/uploadService'
import ProductAttributesPanel from './ProductAttributesPanel'
import { useProductGroup } from '../grouping/useProductGrouping'
import type { BatchMetadata } from '../types'
import type { Asset } from '../../../model'
import './upload-panel.css'

import type { ProductAttributePatch } from '../services/productOptionRules'

type ProgressState = { parse: ImportProgress; generate: ImportProgress }
export type UploadPanelTab = 'upload' | 'attributes'
type UploadPanelProps = {
  busy: boolean
  dropActive: boolean
  progress: ProgressState
  metadata: BatchMetadata
  onMetadataChange: (metadata: BatchMetadata) => void
  onUpload: () => void
  batchOpen: boolean
  activeTab: UploadPanelTab
  onTabChange: (tab: UploadPanelTab) => void
  selectedAssetIds: Set<string>
  onConfirmAttributes: (patch: ProductAttributePatch) => Promise<void>
  assets: Asset[]
}

export default function UploadPanel({ busy, dropActive, progress, metadata, onMetadataChange, onUpload, batchOpen, activeTab, onTabChange, selectedAssetIds, onConfirmAttributes, assets }: UploadPanelProps) {
  const grouping = useProductGroup()
  const visibleTab = batchOpen ? activeTab : 'upload'
  const renderStage = (label: string, value: ImportProgress, active: boolean) => {
    const percent = value.total ? Math.round(value.completed / value.total * 100) : undefined
    const done = value.total > 0 && value.completed >= value.total
    return <div className={`import-stage ${active ? 'is-active' : ''} ${done ? 'is-done' : ''}`}><div className="import-stage-label"><span>{label}</span><span>{done ? '完成' : value.total ? `${value.completed} / ${value.total}` : active ? '准备中…' : '等待中'}</span></div><Progress percent={percent} status={done ? 'success' : active ? 'active' : 'normal'} showInfo={false} /></div>
  }
  const update = (key: keyof BatchMetadata, value: string) => onMetadataChange({ ...metadata, [key]: value })
  return <section className="product-upload-card">
    <div className="upload-panel-tabs" role="tablist" aria-label="图片上传内容切换">
      <button type="button" role="tab" aria-selected={visibleTab === 'upload'} className={visibleTab === 'upload' ? 'active' : ''} onClick={() => onTabChange('upload')}>图片上传</button>
      {batchOpen && <button type="button" role="tab" aria-selected={visibleTab === 'attributes'} className={visibleTab === 'attributes' ? 'active' : ''} onClick={() => onTabChange('attributes')}>图片属性</button>}
    </div>
    <div className={`upload-tab-content ${visibleTab === 'upload' ? 'tab-content-from-left' : 'tab-content-from-right'}`}>
    <div hidden={visibleTab !== 'upload'}>
      <div className="upload-panel-hint"><p>上传图片会加入当前打开的批次；未打开时自动新建。</p></div>
      <button className={`upload-zone large ${dropActive ? 'is-drop-active' : ''}`} disabled={busy || Boolean(grouping?.session)} onClick={onUpload}><Upload size={30} /><strong>{dropActive ? '松开鼠标开始上传' : busy ? '正在解析…' : schematicCopy.upload}</strong><span>{dropActive ? '仅支持 SVG 文件' : '点击选择或将 SVG 文件拖到这里'}</span></button>
      {busy && <div className="import-progress"><div className="import-progress-title">导入进度</div>{renderStage('解析 SVG 图层', progress.parse, progress.parse.completed < progress.parse.total || progress.generate.total === 0)}{renderStage('生成图片资源', progress.generate, progress.generate.total > 0 && progress.generate.completed < progress.generate.total)}</div>}
      <CorelDrawTool />
      {batchOpen && <div className="batch-metadata" aria-label="图片批次信息"><div className="batch-metadata-title">图片批次信息</div><label><span>客户名称</span><input value={metadata.customerName} disabled={busy} onChange={event => update('customerName', event.target.value)} placeholder="请输入客户名称" /></label><label><span>Drawing Date / 绘图日期</span><input type="date" value={metadata.drawingDate} disabled={busy} onChange={event => update('drawingDate', event.target.value)} /></label><label><span>Estimated Ship Date / 预计发货日期</span><input type="date" value={metadata.estimatedShipDate} disabled={busy} onChange={event => update('estimatedShipDate', event.target.value)} /></label><label><span>Designer / 来源</span><input value={metadata.designer} disabled={busy} onChange={event => update('designer', event.target.value)} placeholder="来源" /></label></div>}
    </div>{batchOpen && <div hidden={visibleTab !== 'attributes'}><ProductAttributesPanel assets={assets} selectedAssetIds={selectedAssetIds} onConfirmAttributes={onConfirmAttributes} disabled={busy}/></div>}
    </div>
  </section>
}
