import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Progress, Select, Tag } from 'antd'
import { Download } from 'lucide-react'
import Loading from '../../components/Loading'
import ImpositionThumbnail from './ImpositionThumbnail'
import { loadImpositionImage } from './impositionRecords'
import type { PackedItem } from './packingAlgorithms'
import { applySourceAssignmentsToSameName, buildImpositionTemplatePreview, buildSourceLayerPreview, createImpositionExportModel, enumerateImpositionPdfExports, parseImpositionSvgSource, renderImpositionSvgExport } from './impositionSvgExport'
import type { ExportSvgSource } from './impositionSvgExport'
import { chooseImpositionPdfDirectory, exportImpositionPdfs, type ImpositionPdfExportProgress } from './impositionPdfExportService'
import './impositionPdfExport.css'

type ExportModel = ReturnType<typeof createImpositionExportModel>
type Props = { pages: PackedItem[][]; imageSources: Record<string, string>; widthMm: number; heightMm: number; holes?: { count: number; sizeMm: number; gapMm: number; leftMm: number }; onClose: () => void }
const OMIT = '__omit__'
const CATEGORIES = { paths: '轮廓 / 路径', images: '图片', fills: '彩窗', white: '白墨', unknown: '待确认' }
const TYPE_OPTIONS = [{ value: 'paths', label: '轮廓 / 路径' }, { value: 'images', label: '图片' }, { value: 'fills', label: '彩窗' }, { value: 'white', label: '白墨' }, { value: OMIT, label: '不导出' }]
const PHASES: Record<ImpositionPdfExportProgress['phase'], string> = { prepare: '组合图层', transfer: '传输 SVG', queue: '等待 CPU / 内存额度', resources: '读取图片资源', flatten: '处理渐变和透明度', fonts: '加载字体', parse: '解析 SVG', convert: '生成 PDF', merge: '按图层顺序合并', write: '写入文件', complete: '已完成' }

function layerDisplayName(name: string) {
  const normalized = name.toLowerCase()
  if (normalized.includes('h_xbxb')) return `轮廓 ${name}`
  if (normalized.includes('circle')) return `孔 ${name}`
  if (normalized.includes('path')) return `路径 ${name}`
  return name
}

// Give the modal and its common loading animation a frame before parsing each
// original SVG. QT instances reuse these originals instead of parsing again.
function yieldToPaint() {
  return new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0))
    else setTimeout(resolve, 0)
  })
}

function useSvgUrl(svg: string) {
  const [resource, setResource] = useState({ svg: '', url: '' })
  useEffect(() => {
    if (!svg) { setResource({ svg: '', url: '' }); return }
    const next = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    setResource({ svg, url: next })
    return () => URL.revokeObjectURL(next)
  }, [svg])
  // A new input must never display the previous type/source while its URL is
  // being prepared, even for the frame before this effect has run.
  return resource.svg === svg ? resource.url : ''
}

/** Build only after the loading state has painted, and discard obsolete work. */
function useDeferredSvg(build: (() => string) | undefined) {
  const [result, setResult] = useState<{ build: typeof build; svg: string; error: string }>()
  useEffect(() => {
    if (!build) { setResult(undefined); return }
    let cancelled = false
    void (async () => {
      await yieldToPaint()
      if (cancelled) return
      try {
        const svg = build()
        if (!cancelled) setResult({ build, svg, error: '' })
      } catch (reason) {
        if (!cancelled) setResult({ build, svg: '', error: reason instanceof Error ? reason.message : String(reason) })
      }
    })()
    return () => { cancelled = true }
  }, [build])
  const current = result?.build === build
  return { svg: current ? result?.svg ?? '' : '', error: current ? result?.error ?? '' : '', loading: !!build && !current }
}

/** Only in-memory sources without a file can require a full SVG thumbnail. */
function SourceBlobThumbnail({ source }: { source: ExportSvgSource }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!anchor.current) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)))
    observer.observe(anchor.current)
    return () => observer.disconnect()
  }, [])
  const url = useSvgUrl(visible ? source.svgText : '')
  return <span className="imposition-export-source-thumbnail" ref={anchor}>{url && <img src={url} alt="" loading="lazy" decoding="async"/>}</span>
}

function assignmentsFor(model: ExportModel, templateId: string, sourceId: string) {
  return { ...model.assignments[sourceId], ...model.templateAssignments?.[templateId]?.[sourceId] }
}

/** Opened with a snapshot of the committed canvas, including manual edits. */
export default function ImpositionPdfExportModal({ pages, imageSources, widthMm, heightMm, holes, onClose }: Props) {
  const [model, setModel] = useState<ExportModel>()
  const [preparing, setPreparing] = useState({ completed: 0, total: 0, fileName: '' })
  const [activeTemplateId, setActiveTemplateId] = useState('')
  const [activeSourceId, setActiveSourceId] = useState('')
  const [templateIds, setTemplateIds] = useState<string[]>([])
  const [layerIds, setLayerIds] = useState<string[]>([])
  const [previewType, setPreviewType] = useState('all')
  const [error, setError] = useState('')
  const [appliedMessage, setAppliedMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImpositionPdfExportProgress>()
  const [completedFiles, setCompletedFiles] = useState<string[]>([])
  const [cleanupWarnings, setCleanupWarnings] = useState<string[]>([])
  const [date, setDate] = useState(() => new Date())
  const operationLock = useRef(false)
  const holeCount = holes?.count ?? 0
  const holeSize = holes?.sizeMm ?? 0
  const holeGap = holes?.gapMm ?? 0
  const holeLeft = holes?.leftMm ?? 0
  const sourcePaths = useMemo(() => new Map(pages.flatMap(page => page.map(item => [item.image.sourceImageId ?? item.image.id.split('#qt-')[0], item.image.filePath] as const))), [pages])

  useEffect(() => {
    let cancelled = false
    setModel(undefined)
    setError('')
    void (async () => {
      const sources: ExportModel['sources'] = {}
      const unique = new Map(pages.flatMap(page => page.map(item => [item.image.sourceImageId ?? item.image.id.split('#qt-')[0], item.image] as const)))
      setPreparing({ completed: 0, total: unique.size, fileName: '' })
      await yieldToPaint()
      let completed = 0
      for (const [sourceId, image] of unique) {
        if (cancelled) return
        const fileName = image.filePath.split(/[\\/]/).pop() || image.sourceFileName || image.name
        setPreparing({ completed, total: unique.size, fileName })
        await yieldToPaint()
        if (cancelled) return
        const svgText = imageSources[sourceId] ?? await loadImpositionImage(image.filePath)
        if (cancelled) return
        sources[sourceId] = parseImpositionSvgSource({ sourceId, fileName, svgText, widthMm: image.widthMm, heightMm: image.heightMm })
        completed++
        setPreparing({ completed, total: unique.size, fileName })
      }
      await yieldToPaint()
      if (cancelled) return
      const next = createImpositionExportModel({ pages, sources, plateWidthMm: widthMm, plateHeightMm: heightMm, holes: { count: holeCount, sizeMm: holeSize, gapMm: holeGap, leftMm: holeLeft } })
      setModel(next)
      setTemplateIds(next.templates.map(value => value.id))
      setActiveTemplateId(next.templates[0]?.id ?? '')
      setActiveSourceId(next.templates[0]?.sourceIds[0] ?? '')
    })().catch(reason => { if (!cancelled) setError(`读取 SVG 图层失败：${String(reason)}`) })
    return () => { cancelled = true }
  }, [pages, imageSources, widthMm, heightMm, holeCount, holeSize, holeGap, holeLeft])

  const template = model?.templates.find(value => value.id === activeTemplateId)
  const source = model?.sources[activeSourceId]
  const assignments = model && template && source ? assignmentsFor(model, template.id, source.sourceId) : {}
  const sourceImageChannels = new Map(source?.layers.filter(layer => assignments[layer.id] === 'images').map((layer, index) => [layer.id, index + 1]))
  const imageChannelCount = model && template ? Math.max(0, ...template.sourceIds.map(id => {
    const current = assignmentsFor(model, template.id, id)
    return model.sources[id].layers.filter(layer => current[layer.id] === 'images').length
  })) : 0
  const imageChannelIndex = previewType.startsWith('image-channel-') ? Number(previewType.slice('image-channel-'.length)) : undefined
  useEffect(() => {
    if (imageChannelIndex !== undefined && imageChannelIndex >= imageChannelCount) setPreviewType('images')
  }, [imageChannelIndex, imageChannelCount])
  const selectedModel = model
  const exportPlan = useMemo(() => {
    if (!selectedModel || !templateIds.length) return { entries: [], issue: '' }
    try { return { entries: enumerateImpositionPdfExports(selectedModel, { date, templateIds }), issue: '' } }
    catch (reason) { return { entries: [], issue: String(reason instanceof Error ? reason.message : reason) } }
  }, [selectedModel, date, templateIds])
  const pendingCount = model ? model.templates.filter(board => templateIds.includes(board.id)).reduce((count, board) => count + board.sourceIds.reduce((n, id) => n + model.sources[id].layers.filter(layer => assignmentsFor(model, board.id, id)[layer.id] === undefined).length, 0), 0) : 0
  const previewBuilder = useMemo(() => model && template ? () => buildImpositionTemplatePreview(model, template.id, imageChannelIndex === undefined ? previewType : 'images', imageChannelIndex) : undefined, [model, template, previewType, imageChannelIndex])
  const preview = useDeferredSvg(previewBuilder)
  const previewUrl = useSvgUrl(preview.svg)
  const layerPreviewBuilder = useMemo(() => source ? () => layerIds.length ? buildSourceLayerPreview(source, layerIds) : source.svgText : undefined, [source, layerIds])
  const layerPreview = useDeferredSvg(layerPreviewBuilder)
  const layerPreviewUrl = useSvgUrl(layerPreview.svg)

  function assignLayer(id: string, type: string) {
    if (!template || !source) return
    setAppliedMessage('')
    const value = type === OMIT ? null : type
    setModel(current => current ? { ...current, templateAssignments: { ...current.templateAssignments, [template.id]: { ...current.templateAssignments?.[template.id], [source.sourceId]: { ...assignmentsFor(current, template.id, source.sourceId), [id]: value } } } } : current)
  }
  function applyToSameName() {
    if (!model || !template || !source) return
    const result = applySourceAssignmentsToSameName(model, template.id, source.sourceId)
    setModel(result.model)
    setAppliedMessage(`已应用到 ${result.appliedSources} 处同名 SVG${result.skippedSources ? `；${result.skippedSources} 处图层结构不同，请单独确认` : ''}`)
  }
  async function exportPdf() {
    if (operationLock.current || !selectedModel || !exportPlan.entries.length) return
    operationLock.current = true
    setBusy(true); setProgress(undefined); setError(''); setCompletedFiles([]); setCleanupWarnings([])
    try {
      const directory = await chooseImpositionPdfDirectory()
      if (!directory) return
      const exportedAt = new Date()
      setDate(exportedAt)
      const entries = enumerateImpositionPdfExports(selectedModel, { date: exportedAt, templateIds })
      const result = await exportImpositionPdfs(directory, entries.map(entry => ({ ...entry, pages: entry.pages.map(page => ({ label: page.groupName, renderSvg: () => renderImpositionSvgExport(selectedModel, page) })) })), setProgress)
      setCompletedFiles(result.completedFiles)
      setCleanupWarnings(result.cleanupWarnings)
      if (result.error) setError(`${result.failedFile ? `导出 ${result.failedFile} 失败：` : ''}${result.error}`)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false); operationLock.current = false }
  }

  return <Modal open title="导出 PDF · 图层管理" className="imposition-export-modal" width="min(1480px, 96vw)" style={{ top: 24 }} maskClosable={!busy} keyboard={!busy} closable={!busy} onCancel={() => { if (!busy) onClose() }} footer={<div className="imposition-export-footer"><span>{templateIds.length} 种版式 · {exportPlan.entries.length} 个 PDF · F 表示生产板材数量</span><Button disabled={busy} onClick={onClose}>关闭</Button><Button type="primary" icon={<Download size={15}/>} loading={busy} disabled={!exportPlan.entries.length || !!exportPlan.issue || pendingCount > 0} onClick={() => void exportPdf()}>选择文件夹并导出</Button></div>}>
    {error && <Alert type="error" showIcon message={error}/>}
    {!model ? (!error && <div className="imposition-export-preparing" aria-busy="true"><Loading size="large" text="读取已拼版的 SVG 图层…"/><Progress percent={preparing.total ? Math.round(preparing.completed / preparing.total * 100) : 0}/><span>已解析 {preparing.completed}/{preparing.total} 个原始 SVG</span><small>{preparing.fileName || '准备板材与图层信息…'}</small></div>) : <>
      <div className="imposition-export-summary"><span>板材 {widthMm} × {heightMm} mm、版面孔与图片当前位置；相同版式只导出一份。</span></div>
      <div className="imposition-export-grid" aria-busy={busy}>
        <section className="imposition-export-boards"><strong>选择版式</strong><Checkbox disabled={busy} checked={templateIds.length === model.templates.length} indeterminate={!!templateIds.length && templateIds.length !== model.templates.length} onChange={event => setTemplateIds(event.target.checked ? model.templates.map(board => board.id) : [])}>全部版式</Checkbox>
          <div className="imposition-export-board-list">{model.templates.map((board, index) => <div className={`imposition-export-board ${board.id === activeTemplateId ? 'active' : ''}`} key={board.id}><Checkbox aria-label={`导出版式 ${index + 1}`} checked={templateIds.includes(board.id)} disabled={busy} onChange={event => setTemplateIds(current => event.target.checked ? [...current, board.id] : current.filter(id => id !== board.id))}/><button disabled={busy} onClick={() => { setActiveTemplateId(board.id); setActiveSourceId(board.sourceIds[0] ?? ''); setLayerIds([]); setAppliedMessage('') }}><strong>版式 {index + 1}</strong><small>{board.placements.length} 张图片 · {board.productionCopies}F</small></button></div>)}</div>

        </section>
        <section className="imposition-export-preview"><div className="imposition-export-section-title"><strong>板材预览</strong><Select aria-label="预览类型" disabled={busy} value={previewType} onChange={setPreviewType} options={[{ value: 'all', label: '完整原图' }, { value: 'images', label: '全部图片图层' }, ...Array.from({ length: imageChannelCount }, (_, index) => ({ value: `image-channel-${index}`, label: `图片 ${index + 1}（全板）` })), ...TYPE_OPTIONS.filter(value => value.value !== OMIT && value.value !== 'images')]}/></div><div className="imposition-export-sheet" aria-busy={preview.loading}>{preview.loading ? <Loading text="生成板材预览…"/> : preview.error ? <span role="alert">板材预览失败：{preview.error}</span> : previewUrl ? <img src={previewUrl} alt="当前版式的导出位置预览"/> : <span>该类型没有图层</span>}</div>
          <details className="imposition-export-file-list"><summary>待导出文件（{exportPlan.entries.length}）</summary>{exportPlan.entries.map(entry => <div key={entry.fileName}><strong>版式 {entry.templateNumber} · {entry.pages.length} 页</strong><span>{entry.fileName}</span><span>{entry.pages.map(page => page.groupName).join(' → ')}</span></div>)}</details>
        </section>
        <section className="imposition-export-layers"><strong>SVG 图层</strong><Select aria-label="选择 SVG" showSearch optionFilterProp="label" value={activeSourceId || undefined} disabled={busy} virtual listHeight={280} listItemHeight={56} options={template?.sourceIds.map(id => ({ value: id, label: model.sources[id].fileName }))} optionRender={option => <div className="imposition-export-source-option">{sourcePaths.get(String(option.value)) ? <ImpositionThumbnail path={sourcePaths.get(String(option.value))!} name={model.sources[String(option.value)].fileName}/> : <SourceBlobThumbnail source={model.sources[String(option.value)]}/>}<span>{option.label}</span></div>} onChange={id => { setActiveSourceId(id); setLayerIds([]); setAppliedMessage('') }}/>
          {source && <><div className="imposition-export-source-preview" aria-busy={layerPreview.loading}>
            <div className="imposition-export-source-artwork">{layerPreview.loading ? <Loading size="small" text="生成图层预览…"/> : layerPreviewUrl && <img src={layerPreviewUrl} alt={layerIds.length ? '选中图层预览' : '当前 SVG 原图'}/>}</div>
            <div className="imposition-export-source-caption"><span>{layerIds.length ? `选中 ${layerIds.length} 个图层` : '勾选图层可单独预览'}</span><span>同一 SVG 在本版式中的所有副本同步修改</span>{layerPreview.error && <small role="alert">图层预览失败：{layerPreview.error}</small>}</div>
          </div>
            <div className="imposition-export-layer-actions"><Checkbox aria-label="选择全部图层" checked={layerIds.length === source.layers.length} indeterminate={!!layerIds.length && layerIds.length !== source.layers.length} disabled={busy} onChange={event => setLayerIds(event.target.checked ? source.layers.map(layer => layer.id) : [])}>全选</Checkbox></div>
            <div className="imposition-export-layer-list">{source.layers.map(layer => {
              const displayName = layerDisplayName(layer.label)
              return <div key={layer.id} className={`imposition-export-layer ${assignments[layer.id] === undefined ? 'unassigned' : ''}`}><Checkbox aria-label={`选择图层 ${displayName}`} checked={layerIds.includes(layer.id)} disabled={busy} onChange={event => setLayerIds(current => event.target.checked ? [...current, layer.id] : current.filter(id => id !== layer.id))}/><div title={displayName}><span>{displayName}</span><small>{layer.tagName} · {CATEGORIES[layer.category]}{sourceImageChannels.has(layer.id) ? ` · 全板图片 ${sourceImageChannels.get(layer.id)}` : ''}</small></div><Select aria-label={`图层 ${displayName} 类型`} placeholder="待确认" value={assignments[layer.id] === null ? OMIT : assignments[layer.id]} disabled={busy} options={TYPE_OPTIONS} onChange={value => assignLayer(layer.id, value)}/></div>
            })}</div>
            <Button type="primary" disabled={busy} onClick={applyToSameName}>应用到同名svg</Button>
            {appliedMessage && <small className="imposition-export-apply-message" role="status">{appliedMessage}</small>}
            {source.warnings?.map((warning, index) => <small className="imposition-export-warning" key={index}>{warning}</small>)}
          </>}
        </section>
      </div>
      {pendingCount > 0 && <Alert type="warning" showIcon message={`所选版式还有 ${pendingCount} 个待确认图层，请指定类型或选择“不导出”。`}/>}
      {exportPlan.issue && pendingCount === 0 && <Alert type="warning" showIcon message={exportPlan.issue}/>}
      {busy && <div className="imposition-export-progress" role="status"><Loading size="small" inline text={progress ? `${PHASES[progress.phase]}：${progress.fileName}${progress.pageNumber ? ` · 第 ${progress.pageNumber}/${progress.pageCount} 页${progress.pageName ? ` ${progress.pageName}` : ''}` : ''}` : '请选择导出文件夹…'}/><Progress percent={progress ? Math.round(progress.completed / Math.max(1, progress.total) * 100) : 0}/><small>已完成 {progress?.completed ?? 0}/{progress?.total ?? exportPlan.entries.length} 个文件</small></div>}
      {completedFiles.length > 0 && <Alert type={error ? 'warning' : 'success'} showIcon message={`已导出 ${completedFiles.length} 个 PDF`} description={<details><summary>查看保存路径</summary>{completedFiles.map(path => <div key={path}>{path}</div>)}</details>}/>}
      {cleanupWarnings.map(warning => <Tag color="warning" key={warning}>{warning}</Tag>)}
    </>}
  </Modal>
}
