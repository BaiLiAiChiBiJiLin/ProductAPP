import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Image, Modal, Progress, Select, Tag } from 'antd'
import { Download, ZoomIn, ZoomOut, Scan } from 'lucide-react'
import Loading from '../../components/Loading'
import ImpositionThumbnail from './ImpositionThumbnail'
import { loadImpositionImage } from './impositionRecords'
import type { PackedItem } from './packingAlgorithms'
import { applySourceAssignmentsToSameName, buildImpositionTemplatePreview, buildSourceLayerPreview, createImpositionExportModel, enumerateImpositionPdfExports, parseImpositionSvgSource, renderImpositionSvgExport, impositionImageChannels, canAssignSvgLayer } from './impositionSvgExport'
import type { ExportSvgSource } from './impositionSvgExport'
import { chooseImpositionPdfDirectory, exportImpositionPdfs, type ImpositionPdfExportProgress } from './impositionPdfExportService'
import './impositionPdfExport.css'
import { createCmykExportPlan, type CmykSettings, type CmykExportPlan } from './impositionCmykExport'
import { checkExportTemplate, type ExportGeometryCheck } from './impositionExportDiagnostics'

type ExportModel = ReturnType<typeof createImpositionExportModel>
type Props = { geometry?: ExportGeometryCheck; pages: PackedItem[][]; imageSources: Record<string, string>; widthMm: number; heightMm: number; holes?: { count: number; sizeMm: number; gapMm: number; leftMm: number }; onClose: () => void }
const OMIT = '__omit__'
const EXPORT_FORMATS_KEY = 'printflow.imposition.export-formats.v1'
const DEFAULT_EXPORT_FORMATS = { includePdf: true, includeDxf: true, includeCmyk: true }

function readExportFormats(): typeof DEFAULT_EXPORT_FORMATS {
  try {
    const saved = JSON.parse(localStorage.getItem(EXPORT_FORMATS_KEY) ?? '{}')
    return {
      includePdf: typeof saved?.includePdf === 'boolean' ? saved.includePdf : true,
      includeDxf: typeof saved?.includeDxf === 'boolean' ? saved.includeDxf : true,
      includeCmyk: typeof saved?.includeCmyk === 'boolean' ? saved.includeCmyk : true,
    }
  } catch { return { ...DEFAULT_EXPORT_FORMATS } }
}

const CATEGORIES = { paths: '轮廓 / 路径', images: '图片', fills: '彩窗', white: '白墨', unknown: '待确认' }
const TYPE_OPTIONS = [{ value: 'paths', label: '轮廓 / 路径' }, { value: 'image-front', label: '图片正' }, { value: 'image-back', label: '图片背' }, { value: 'images', label: '其他图片' }, { value: 'fills', label: '彩窗' }, { value: 'white', label: '白墨' }, { value: OMIT, label: '不导出' }]
const PHASES: Record<ImpositionPdfExportProgress['phase'], string> = { prepare: '组合图层', transfer: '传输 SVG', queue: '等待 CPU / 内存额度', resources: '读取图片资源', flatten: '处理渐变和透明度', fonts: '加载字体', parse: '解析 SVG', convert: '生成 PDF', merge: '合并版式资源', write: '写入文件', dxf: '生成轮廓 DXF', 'cmyk-align': '检查正背与彩窗对齐', 'cmyk-color': 'ICC 转色与生成白墨', 'cmyk-zip': '无损压缩专色通道', 'cmyk-photoshop': '生成 Photoshop 整板专色通道', complete: '已完成' }

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
function useDeferredSvg(build: (() => string | Promise<string>) | undefined) {
  const [result, setResult] = useState<{ build: typeof build; svg: string; error: string }>()
  useEffect(() => {
    if (!build) { setResult(undefined); return }
    let cancelled = false
    void (async () => {
      await yieldToPaint()
      if (cancelled) return
      try {
        const svg = await build()
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
export default function ImpositionPdfExportModal({ pages, imageSources, widthMm, heightMm, holes, geometry, onClose }: Props) {
  const [model, setModel] = useState<ExportModel>()
  const [preparing, setPreparing] = useState({ completed: 0, total: 0, fileName: '' })
  const [activeTemplateId, setActiveTemplateId] = useState('')
  const [activeSourceId, setActiveSourceId] = useState('')
  const [templateIds, setTemplateIds] = useState<string[]>([])
  const [layerIds, setLayerIds] = useState<string[]>([])
  const [previewType, setPreviewType] = useState('all')
  const [layerPreviewOpen, setLayerPreviewOpen] = useState(false)
  const [error, setError] = useState('')
  const [appliedMessage, setAppliedMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImpositionPdfExportProgress>()
  const [completedFiles, setCompletedFiles] = useState<string[]>([])
  const [cleanupWarnings, setCleanupWarnings] = useState<string[]>([])
  const [date, setDate] = useState(() => new Date())
  const [exportFormats, setExportFormats] = useState(readExportFormats)
  const { includePdf, includeDxf, includeCmyk } = exportFormats
  useEffect(() => {
    try { localStorage.setItem(EXPORT_FORMATS_KEY, JSON.stringify(exportFormats)) }
    catch { /* Unavailable preference storage must not prevent exporting. */ }
  }, [exportFormats])
  const [cmykSettings, setCmykSettings] = useState<CmykSettings>({ dpi: 400, autoAlign: false })
  const [runtimeIssues, setRuntimeIssues] = useState<Record<string, string>>({})
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({})
  const [geometryChecks, setGeometryChecks] = useState<{ templates: ExportModel['templates']; issues: Record<string, string[]> }>()
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
    setSourceErrors({}); setRuntimeIssues({})
    void (async () => {
      const sources: ExportModel['sources'] = {}
      const failures: Record<string, string> = {}
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
        try {
          const svgText = imageSources[sourceId] ?? await loadImpositionImage(image.filePath)
          if (cancelled) return
          sources[sourceId] = parseImpositionSvgSource({ sourceId, fileName, svgText, widthMm: image.widthMm, heightMm: image.heightMm })
        } catch (reason) {
          failures[sourceId] = `${fileName}：读取 SVG 图层失败，${reason instanceof Error ? reason.message : String(reason)}`
          // Retain the affected template in the list so it can be identified
          // and deselected without blocking unrelated templates.
          sources[sourceId] = parseImpositionSvgSource({ sourceId, fileName, svgText: '<svg xmlns="http://www.w3.org/2000/svg"/>', widthMm: image.widthMm, heightMm: image.heightMm })
        }
        completed++
        setPreparing({ completed, total: unique.size, fileName })
      }
      await yieldToPaint()
      if (cancelled) return
      const next = createImpositionExportModel({ pages, sources, plateWidthMm: widthMm, plateHeightMm: heightMm, holes: { count: holeCount, sizeMm: holeSize, gapMm: holeGap, leftMm: holeLeft } })
      setSourceErrors(failures)
      setModel(next)
      setTemplateIds(next.templates.map(value => value.id))
      setActiveTemplateId(next.templates[0]?.id ?? '')
      setActiveSourceId(next.templates[0]?.sourceIds[0] ?? '')
    })().catch(reason => { if (!cancelled) setError(`读取 SVG 图层失败：${String(reason)}`) })
    return () => { cancelled = true }
  }, [pages, imageSources, widthMm, heightMm, holeCount, holeSize, holeGap, holeLeft])

  const templates = model?.templates
  useEffect(() => {
    if (!templates) return
    let cancelled = false
    void (async () => {
      const issues: Record<string, string[]> = {}
      for (const board of templates) {
        await yieldToPaint()
        if (cancelled) return
        issues[board.id] = checkExportTemplate(board, widthMm, heightMm, geometry)
      }
      if (!cancelled) setGeometryChecks({ templates, issues })
    })()
    return () => { cancelled = true }
  }, [templates, widthMm, heightMm, geometry])
  const geometryChecking = !!templates && geometryChecks?.templates !== templates
  const template = model?.templates.find(value => value.id === activeTemplateId)
  const source = model?.sources[activeSourceId]
  const assignments = model && template && source ? assignmentsFor(model, template.id, source.sourceId) : {}
  const imageChannels = model && template ? impositionImageChannels(model, template.id) : []
  const sourceImageChannels = new Map<string, number>()
  imageChannels.forEach((members, index) => {
    const ids = source ? members[source.sourceId] : undefined
    for (const id of Array.isArray(ids) ? ids : ids ? [ids] : []) if (!sourceImageChannels.has(id)) sourceImageChannels.set(id, index + 1)
  })
  const imageChannelCount = imageChannels.length
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
  useEffect(() => { setLayerPreviewOpen(false) }, [layerPreviewUrl])

  function assignLayer(id: string, type: string) {
    if (!template || !source) return
    setAppliedMessage('')
    const value = type === OMIT ? null : type
    const layer = source.layers.find(candidate => candidate.id === id)
    if (!layer || !canAssignSvgLayer(layer, value)) return
    setModel(current => current ? { ...current, templateAssignments: { ...current.templateAssignments, [template.id]: { ...current.templateAssignments?.[template.id], [source.sourceId]: { ...assignmentsFor(current, template.id, source.sourceId), [id]: value } } } } : current)
  }
  function applyToSameName() {
    if (!model || !template || !source) return
    const result = applySourceAssignmentsToSameName(model, template.id, source.sourceId)
    setModel(result.model)
    setAppliedMessage(`已应用到 ${result.appliedSources} 处同名 SVG${result.skippedSources ? `；${result.skippedSources} 处图层结构不同，请单独确认` : ''}`)
  }
  const cmykPlan = useMemo(() => {
    const plans = new Map<string, CmykExportPlan | undefined>()
    const issues: Record<string, string> = {}
    if (includeCmyk && model) for (const board of model.templates) {
      try { plans.set(board.id, createCmykExportPlan(model, board.id, cmykSettings)) }
      catch (reason) { issues[board.id] = reason instanceof Error ? reason.message : String(reason) }
    }
    return { plans, issues, issue: templateIds.map(id => issues[id]).filter(Boolean).join('；') }
  }, [includeCmyk, model, templateIds, cmykSettings])
  const boardIssues = useMemo(() => Object.fromEntries((model?.templates ?? []).map(board => {
    const issues = [...(geometryChecks?.templates === model?.templates ? geometryChecks?.issues[board.id] ?? [] : [])]
    for (const sourceId of board.sourceIds) {
      if (sourceErrors[sourceId]) issues.push(sourceErrors[sourceId])
      for (const warning of model!.sources[sourceId].contourWarnings ?? []) issues.push(`${model!.sources[sourceId].fileName}：${warning}`)
      const assigned = assignmentsFor(model!, board.id, sourceId)
      const pending = model!.sources[sourceId].layers.filter(layer => assigned[layer.id] === undefined)
      if (pending.length) issues.push(`${model!.sources[sourceId].fileName}：${pending.length} 个待确认图层`)
    }
    if (cmykPlan.issues[board.id]) issues.push(cmykPlan.issues[board.id])
    if (runtimeIssues[board.id]) issues.push(runtimeIssues[board.id])
    return [board.id, issues]
  })), [model, geometryChecks, cmykPlan.issues, runtimeIssues, sourceErrors])
  const selectedSourceIssue = model?.templates.some(board => templateIds.includes(board.id) && board.sourceIds.some(id => !!sourceErrors[id]))
  const selectedGeometryIssue = templateIds.some(id => !!geometryChecks?.issues[id]?.length)
  const cmykCount = templateIds.filter(id => !!cmykPlan.plans.get(id)).length
  const dxfCount = includeDxf ? exportPlan.entries.filter(entry => entry.pages.some(page => page.groupId === 'paths')).length : 0
  const pdfCount = includePdf ? exportPlan.entries.length : 0
  const outputCount = pdfCount + dxfCount + cmykCount
  const outputEntries = exportPlan.entries.filter(entry => includePdf || (includeDxf && entry.pages.some(page => page.groupId === 'paths')) || cmykPlan.plans.get(entry.templateId))
  const exportedDxfCount = completedFiles.filter(path => /\.dxf$/iu.test(path)).length
  const exportedCmykCount = completedFiles.filter(path => /[/\\]CMYK_[^/\\]+\.pdf$/iu.test(path)).length
  const exportedPdfCount = completedFiles.filter(path => /\.pdf$/iu.test(path)).length - exportedCmykCount
  const completedSummary = [[exportedPdfCount, 'PDF'], [exportedDxfCount, 'DXF'], [exportedCmykCount, 'CMYK PDF']].filter(([count]) => count).map(([count, type]) => `${count} 个 ${type}`).join('、')
  const currentCmykPlan = template ? cmykPlan.plans.get(template.id) : undefined
  async function exportPdf() {
    if (operationLock.current || !selectedModel || !outputCount || exportPlan.issue || cmykPlan.issue || pendingCount > 0 || geometryChecking || selectedGeometryIssue || selectedSourceIssue) return
    operationLock.current = true
    setBusy(true); setProgress(undefined); setError(''); setCompletedFiles([]); setCleanupWarnings([]); setRuntimeIssues({})
    try {
      const directory = await chooseImpositionPdfDirectory()
      if (!directory) return
      const exportedAt = new Date()
      setDate(exportedAt)
      const entries = enumerateImpositionPdfExports(selectedModel, { date: exportedAt, templateIds })
      const result = await exportImpositionPdfs(directory, entries.map(entry => ({ ...entry,
        exportPdf: includePdf,
        cmyk: includeCmyk ? createCmykExportPlan(selectedModel, entry.templateId, cmykSettings) : undefined,
        pages: entry.pages.map(page => ({ label: page.groupName, exportDxf: includeDxf && page.groupId === 'paths', renderSvg: () => renderImpositionSvgExport(selectedModel, page) })) })), setProgress)
      setCompletedFiles(result.completedFiles)
      setCleanupWarnings(result.cleanupWarnings)
      if (result.error) {
        setError(`${result.failedFile ? `导出 ${result.failedFile} 失败：` : ''}${result.error}`)
        const basename = (path: string) => path.split(/[\\/]/).pop()!.replace(/^CMYK_/u, '').replace(/\.dxf$/iu, '.pdf')
        const failed = entries.find(entry => basename(entry.fileName) === basename(result.failedFile ?? ''))
        if (failed) setRuntimeIssues(current => ({ ...current, [failed.templateId]: result.error! }))
      }
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false); operationLock.current = false }
  }

  return <Modal open title={<div className="imposition-export-heading"><span>导出 PDF · 图层管理</span><div><Checkbox checked={includePdf} disabled={busy} onChange={e => { const checked = e.target.checked; setExportFormats(current => ({ ...current, includePdf: checked })) }}>导出 PDF</Checkbox><Checkbox checked={includeDxf} disabled={busy} onChange={e => { const checked = e.target.checked; setExportFormats(current => ({ ...current, includeDxf: checked })) }}>导出 DXF</Checkbox><Checkbox checked={includeCmyk} disabled={busy} onChange={e => { const checked = e.target.checked; setExportFormats(current => ({ ...current, includeCmyk: checked })) }}>导出 CMYK PDF</Checkbox></div></div>} className="imposition-export-modal" width="min(1480px, 96vw)" style={{ top: 24 }} maskClosable={!busy && !layerPreviewOpen} keyboard={!busy && !layerPreviewOpen} closable={!busy} onCancel={() => { if (!busy && !layerPreviewOpen) onClose() }} footer={<div className="imposition-export-footer"><span>{templateIds.length} 种版式 · {pdfCount} 个 PDF · {dxfCount} 个轮廓 DXF · {cmykCount} 个 CMYK PDF · F 表示生产板材数量</span><Button disabled={busy} onClick={onClose}>关闭</Button><Button type="primary" icon={<Download size={15}/>} loading={busy} disabled={!outputCount || !!exportPlan.issue || !!cmykPlan.issue || pendingCount > 0 || geometryChecking || selectedGeometryIssue || selectedSourceIssue} onClick={() => void exportPdf()}>选择文件夹并导出</Button></div>}>
    {error && <Alert type="error" showIcon message={error}/>}
    {!model ? (!error && <div className="imposition-export-preparing" aria-busy="true"><Loading size="large" text="读取已拼版的 SVG 图层…"/><Progress percent={preparing.total ? Math.round(preparing.completed / preparing.total * 100) : 0}/><span>已解析 {preparing.completed}/{preparing.total} 个原始 SVG</span><small>{preparing.fileName || '准备板材与图层信息…'}</small></div>) : <>
      <div className="imposition-export-summary"><span>板材 {widthMm} × {heightMm} mm、版面孔与图片当前位置；相同版式只导出一份。</span></div>
      {includeCmyk && <div className="imposition-export-cmyk-settings" aria-label="CMYK 导出设置">
        <label>分辨率<Select aria-label="CMYK 分辨率" disabled={busy} value={cmykSettings.dpi} options={[{ value: 400, label: '400 ppi' }, { value: 300, label: '300 ppi' }]} onChange={dpi => setCmykSettings(s => ({ ...s, dpi }))}/></label>
        <Checkbox disabled={busy} checked={cmykSettings.autoAlign} onChange={e => setCmykSettings(s => ({ ...s, autoAlign: e.target.checked }))}>按可见区域居中对齐</Checkbox>
        {currentCmykPlan && <span role="status" aria-label="CMYK 自动识别">本版：{currentCmykPlan.differentBack ? '双面不同图' : '双面同图'} · {currentCmykPlan.sources.some(item => !!item.window) ? '有彩窗' : '无彩窗'}{currentCmykPlan.differentBack && currentCmykPlan.sources.some(item => !item.back) ? ' · 同图图片自动补入背面' : ''}</span>}
        <small>250.icm · White 收缩 1 像素 · ZIP 无损</small>
      </div>}
      {geometryChecking && <Loading size="small" inline text="检查各版式的边界、轮廓和图片间距…"/>}
      {template && !!boardIssues[template.id]?.length && <Alert type="warning" showIcon message={`版式 ${model.templates.indexOf(template) + 1} 需要检查`} description={<ul>{boardIssues[template.id].map((issue, index) => <li key={index}>{issue}</li>)}</ul>}/>}
      <div className="imposition-export-grid" aria-busy={busy}>
        <section className="imposition-export-boards"><strong>选择版式</strong><Checkbox disabled={busy} checked={templateIds.length === model.templates.length} indeterminate={!!templateIds.length && templateIds.length !== model.templates.length} onChange={event => setTemplateIds(event.target.checked ? model.templates.map(board => board.id) : [])}>全部版式</Checkbox>
          <div className="imposition-export-board-list">{model.templates.map((board, index) => <div className={`imposition-export-board ${board.id === activeTemplateId ? 'active' : ''}${boardIssues[board.id]?.length ? ' has-issues' : ''}`} title={boardIssues[board.id]?.join('；')} key={board.id}><Checkbox aria-label={`导出版式 ${index + 1}`} checked={templateIds.includes(board.id)} disabled={busy} onChange={event => setTemplateIds(current => event.target.checked ? [...current, board.id] : current.filter(id => id !== board.id))}/><button disabled={busy} onClick={() => { setActiveTemplateId(board.id); setActiveSourceId(board.sourceIds[0] ?? ''); setLayerIds([]); setAppliedMessage('') }}><strong>版式 {index + 1}</strong>{!!boardIssues[board.id]?.length && <Tag color="error">需检查 · {boardIssues[board.id].length}</Tag>}<small>{board.placements.length} 张图片 · {board.productionCopies}F</small></button></div>)}</div>

        </section>
        <section className="imposition-export-preview"><div className="imposition-export-section-title"><strong>板材预览</strong><Select aria-label="预览类型" disabled={busy} value={previewType} onChange={setPreviewType} options={[{ value: 'all', label: '完整原图' }, { value: 'images', label: '全部图片图层' }, ...Array.from({ length: imageChannelCount }, (_, index) => ({ value: `image-channel-${index}`, label: `图片 ${index + 1}（全板）` })), ...TYPE_OPTIONS.filter(value => value.value !== OMIT && value.value !== 'images')]}/></div><div className="imposition-export-sheet" aria-busy={preview.loading}>{preview.loading ? <Loading text="生成板材预览…"/> : preview.error ? <span role="alert">板材预览失败：{preview.error}</span> : previewUrl ? <img src={previewUrl} alt="当前版式的导出位置预览"/> : <span>该类型没有图层</span>}</div>
          <details className="imposition-export-file-list"><summary>待导出文件（{outputCount}）</summary>{outputEntries.map(entry => <div key={entry.fileName}><strong>版式 {entry.templateNumber}{includePdf ? ` · ${entry.pages.length} 页` : ''}</strong>{includePdf && <span>{entry.fileName}</span>}{includeDxf && entry.pages.some(page => page.groupId === 'paths') && <span>{entry.fileName.replace(/\.pdf$/iu, '.dxf')}</span>}{cmykPlan.plans.get(entry.templateId) && <span>CMYK_{entry.fileName}</span>}{includePdf && <span>{entry.pages.map(page => page.groupName).join(' → ')}</span>}</div>)}</details>
        </section>
        <section className="imposition-export-layers"><strong>SVG 图层</strong><Select aria-label="选择 SVG" showSearch optionFilterProp="label" value={activeSourceId || undefined} disabled={busy} virtual listHeight={280} listItemHeight={56} options={template?.sourceIds.map(id => ({ value: id, label: model.sources[id].fileName }))} optionRender={option => <div className="imposition-export-source-option">{sourcePaths.get(String(option.value)) ? <ImpositionThumbnail path={sourcePaths.get(String(option.value))!} name={model.sources[String(option.value)].fileName}/> : <SourceBlobThumbnail source={model.sources[String(option.value)]}/>}<span>{option.label}</span></div>} onChange={id => { setActiveSourceId(id); setLayerIds([]); setAppliedMessage('') }}/>
          {source && <><div className="imposition-export-source-preview" aria-busy={layerPreview.loading}>
            <button type="button" className="imposition-export-source-artwork" aria-label="放大 SVG 图层预览" title="查看大图，可继续缩放" disabled={layerPreview.loading || !layerPreviewUrl} onClick={() => setLayerPreviewOpen(true)}>{layerPreview.loading ? <Loading size="small" text="生成图层预览…"/> : layerPreviewUrl && <><img src={layerPreviewUrl} alt={layerIds.length ? '选中图层预览' : '当前 SVG 原图'}/><span className="imposition-export-preview-magnifier" aria-hidden="true"><ZoomIn size={15}/></span></>}</button>
            <div className="imposition-export-source-caption"><span>{layerIds.length ? `选中 ${layerIds.length} 个图层` : '勾选图层可单独预览'}</span><span>同一 SVG 在本版式中的所有副本同步修改</span>{layerPreview.error && <small role="alert">图层预览失败：{layerPreview.error}</small>}</div>
          </div>
            {layerPreviewUrl && <Image src={layerPreviewUrl} alt={layerIds.length ? '选中 SVG 图层大图' : 'SVG 原图大图'} wrapperStyle={{ display: 'none' }} preview={{
              visible: layerPreviewOpen,
              onVisibleChange: setLayerPreviewOpen,
              rootClassName: 'imposition-export-layer-lightbox',
              minScale: 1, maxScale: 16, scaleStep: .5,
              closeIcon: null,
              toolbarRender: (_, { actions, transform }) => <div className="imposition-export-lightbox-toolbar" onKeyDown={event => {
                if (event.key === 'Escape') { event.stopPropagation(); actions.onClose() }
              }}>
                <div className="imposition-export-lightbox-caption"><strong title={source.fileName}>{source.fileName}</strong><span>{layerIds.length ? `选中 ${layerIds.length} 个图层` : '完整原图'} · 滚轮缩放，按住图片拖动</span></div>
                <div className="imposition-export-lightbox-actions">
                  <Button aria-label="缩小 SVG 预览" icon={<ZoomOut size={16}/>} disabled={transform.scale <= 1} onClick={actions.onZoomOut}/>
                  <span aria-label="SVG 预览缩放比例">{Math.round(transform.scale * 100)}%</span>
                  <Button aria-label="放大 SVG 预览" icon={<ZoomIn size={16}/>} disabled={transform.scale >= 16} onClick={actions.onZoomIn}/>
                  <Button icon={<Scan size={16}/>} onClick={actions.onReset}>适应窗口</Button>
                  <Button onClick={actions.onClose}>关闭大图</Button>
                </div>
              </div>,
            }}/>}
            <div className="imposition-export-layer-actions"><Checkbox aria-label="选择全部图层" checked={layerIds.length === source.layers.length} indeterminate={!!layerIds.length && layerIds.length !== source.layers.length} disabled={busy} onChange={event => setLayerIds(event.target.checked ? source.layers.map(layer => layer.id) : [])}>全选</Checkbox></div>
            <div className="imposition-export-layer-list">{source.layers.toReversed().map(layer => {
              const displayName = layerDisplayName(layer.label)
              return <div key={layer.id} className={`imposition-export-layer ${assignments[layer.id] === undefined ? 'unassigned' : ''}`}><Checkbox aria-label={`选择图层 ${displayName}`} checked={layerIds.includes(layer.id)} disabled={busy} onChange={event => setLayerIds(current => event.target.checked ? [...current, layer.id] : current.filter(id => id !== layer.id))}/><div title={displayName}><span>{displayName}</span><small>{layer.tagName} · {CATEGORIES[layer.category]}{sourceImageChannels.has(layer.id) ? ` · 全板图片 ${sourceImageChannels.get(layer.id)}` : ''}</small></div><Select aria-label={`图层 ${displayName} 类型`} placeholder="待确认" value={assignments[layer.id] === null ? OMIT : assignments[layer.id]} disabled={busy} options={TYPE_OPTIONS.filter(option => canAssignSvgLayer(layer, option.value))} onChange={value => assignLayer(layer.id, value)}/></div>
            })}</div>
            <Button type="primary" disabled={busy} onClick={applyToSameName}>应用到同名svg</Button>
            {appliedMessage && <small className="imposition-export-apply-message" role="status">{appliedMessage}</small>}
            {source.warnings?.map((warning, index) => <small className="imposition-export-warning" key={index}>{warning}</small>)}
          </>}
        </section>
      </div>
      {pendingCount > 0 && <Alert type="warning" showIcon message={`所选版式还有 ${pendingCount} 个待确认图层，请指定类型或选择“不导出”。`}/>}
      {exportPlan.issue && pendingCount === 0 && <Alert type="warning" showIcon message={exportPlan.issue}/>}
      {cmykPlan.issue && <Alert type="warning" showIcon message={cmykPlan.issue}/>}
      {!includePdf && !includeDxf && !includeCmyk && <Alert type="warning" showIcon message="请选择至少一种导出文件类型。"/>}
      {busy && <div className="imposition-export-progress" role="status"><Loading size="small" inline text={progress ? `${PHASES[progress.phase]}：${progress.fileName}${progress.pageNumber ? ` · 第 ${progress.pageNumber}/${progress.pageCount} ${progress.fileName.startsWith('CMYK_') ? '个原图' : '页'}${progress.pageName ? ` ${progress.pageName}` : ''}` : ''}` : '请选择导出文件夹…'}/><Progress percent={progress ? Math.round(progress.completed / Math.max(1, progress.total) * 100) : 0}/><small>已完成 {progress?.completed ?? 0}/{progress?.total ?? exportPlan.entries.length} 种版式</small></div>}
      {completedFiles.length > 0 && <Alert type={error ? 'warning' : 'success'} showIcon message={`已导出 ${completedSummary}`} description={<details><summary>查看保存路径</summary>{completedFiles.map(path => <div key={path}>{path}</div>)}</details>}/>}
      {cleanupWarnings.map(warning => <Tag color="warning" key={warning}>{warning}</Tag>)}
    </>}
  </Modal>
}
