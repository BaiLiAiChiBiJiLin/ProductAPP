import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, ConfigProvider, Drawer, Dropdown, Input, InputNumber, Pagination, Popconfirm, Table, Tag, theme } from 'antd'
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import zhCN from 'antd/es/locale/zh_CN'
import { ArrowLeft, ChevronDown, ChevronRight, Hand, MousePointer2, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react'
import { listPendingImpositions, loadImpositionImage, loadImpositionJob, returnImpositionToReview, type ImpositionJob, type ImpositionListResult, type ImpositionRecord, type ProductionImage } from './impositionRecords'
import ImpositionKonvaCanvas from './ImpositionKonvaCanvas'
import ModulePage from '../../components/ModulePage'
import './imposition.css'

type LayoutConfig = { plateHeight: number; plateWidth: number; effectiveHeight: number; effectiveWidth: number; effectiveRight: number; holeSize: number; holeCount: number; holeGap: number; holeLeft: number }
type WorkspaceProps = { jobs: ImpositionJob[]; activeJobId?: string; onBack: () => void; onSelectJob: (id: string) => void; onReturn: (id: string) => void; returningId?: string; loading: boolean }

function ImpositionWorkspace({ jobs, activeJobId, onBack, onSelectJob, onReturn, returningId, loading }: WorkspaceProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [details, setDetails] = useState<Record<string, ImpositionRecord>>({})
  const [imageSources, setImageSources] = useState<Record<string, string>>({})
  const [detailError, setDetailError] = useState('')
  const [zoom, setZoom] = useState(1)
  const [selectedImageId, setSelectedImageId] = useState<string>()
  const [panMode, setPanMode] = useState(false)
  const [spacePressed, setSpacePressed] = useState(false)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [sortMode, setSortMode] = useState<'customer' | 'time'>('customer')
  const [layout, setLayout] = useState<LayoutConfig>({ plateHeight: 464, plateWidth: 300, effectiveHeight: 440, effectiveWidth: 285, effectiveRight: 5, holeSize: 3, holeCount: 2, holeGap: 203.468, holeLeft: 4 })
  const panRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | undefined>(undefined)
  const displayJobs = useMemo(() => [...jobs].sort((left, right) => sortMode === 'customer' ? (left.customerName || '').localeCompare(right.customerName || '') : new Date(right.submittedAt).getTime() - new Date(left.submittedAt).getTime()), [jobs, sortMode])
  const activeJob = displayJobs.find(job => job.id === activeJobId) ?? displayJobs[0]
  const activeDetail = activeJob ? details[activeJob.id] : undefined
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.code === 'Space' && !event.repeat) { event.preventDefault(); setSpacePressed(true) } }
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpacePressed(false) }
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])
  const updateZoom = (delta: number) => setZoom(value => Math.max(.6, Math.min(5, Number((value + delta).toFixed(1)))))
  const onCanvasWheel = (event: ReactWheelEvent<HTMLDivElement>) => { if (!event.ctrlKey) return; event.preventDefault(); updateZoom(event.deltaY > 0 ? -.1 : .1) }
  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => { if (!(panMode || spacePressed)) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); panRef.current = { x: event.clientX, y: event.clientY, offsetX: panOffset.x, offsetY: panOffset.y } }
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => { if (!panRef.current) return; event.preventDefault(); setPanOffset({ x: panRef.current.offsetX + event.clientX - panRef.current.x, y: panRef.current.offsetY + event.clientY - panRef.current.y }) }
  const onCanvasPointerUp = () => { panRef.current = undefined }

  useEffect(() => {
    if (!activeJob || details[activeJob.id]) return
    let cancelled = false
    setDetailError('')
    void loadImpositionJob(activeJob.id).then(record => { if (!cancelled) setDetails(current => ({ ...current, [record.id]: record })) }).catch(reason => { if (!cancelled) setDetailError(`加载拼版图片失败：${String(reason)}`) })
    return () => { cancelled = true }
  }, [activeJob, details])
  const toggle = (id: string) => {
    setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
    onSelectJob(id)
  }
  const images = activeDetail?.images ?? []
  useEffect(() => {
    if (!images.length) return
    let cancelled = false
    void Promise.all(images.map(async image => [image.id, await loadImpositionImage(image.filePath)] as const))
      .then(entries => { if (!cancelled) setImageSources(current => ({ ...current, ...Object.fromEntries(entries) })) })
      .catch(reason => { if (!cancelled) setDetailError(`加载拼版原图失败：${String(reason)}`) })
    return () => { cancelled = true }
  }, [images])
  const packedPages = useMemo(() => {
    const pages: Array<Array<{ image: ProductionImage; x: number; y: number; width: number; height: number }>> = [[]]
    const left = Math.max(layout.holeLeft + layout.holeSize + 4, 8)
    const right = Math.max(left + 1, Math.min(layout.effectiveWidth, layout.plateWidth - layout.effectiveRight))
    const bottom = Math.max(1, layout.effectiveHeight)
    let x = left
    let y = 8
    let rowHeight = 0
    for (const image of images) {
      const width = Math.max(1, Math.min(image.widthMm, right - left))
      const height = Math.max(1, Math.min(image.heightMm, bottom))
      if (x > left && x + width > right) { x = left; y += rowHeight + 4; rowHeight = 0 }
      if (y + height > bottom) { pages.push([]); x = left; y = 8; rowHeight = 0 }
      pages.at(-1)!.push({ image, x, y, width, height })
      x += width + 4
      rowHeight = Math.max(rowHeight, height)
    }
    return pages.filter(page => page.length)
  }, [images, layout])
  const boardWidth = Math.max(1, layout.plateWidth)
  const boardHeight = Math.max(1, layout.plateHeight)
  const boardScale = Math.min(1.6, Math.max(.7, 520 / boardHeight))
  const effectiveX = Math.max(0, boardWidth - layout.effectiveRight - layout.effectiveWidth)
  const effectiveY = Math.max(0, (boardHeight - layout.effectiveHeight) / 2)
  const effectiveDisplayWidth = Math.min(layout.effectiveWidth, boardWidth - layout.effectiveRight)
  const holeExtent = Math.max(0, (layout.holeCount - 1) * layout.holeGap + layout.holeSize)
  const holeStart = (boardHeight - holeExtent) / 2
  return <div className="imposition-workspace">
    <header className="imposition-workspace-header"><Button className="imposition-back-button" type="primary" icon={<ArrowLeft size={16}/>} onClick={onBack}>返回待拼版</Button><section className="imposition-layout-config" aria-label="拼版版面配置"><div className="imposition-layout-config-title"><strong>版面配置</strong><span>单位：mm</span></div><div className="imposition-layout-fields"><label>板材高<InputNumber size="small" min={1} value={layout.plateHeight} onChange={value => setLayout(current => ({ ...current, plateHeight: value ?? current.plateHeight }))}/></label><label>板材宽<InputNumber size="small" min={1} value={layout.plateWidth} onChange={value => setLayout(current => ({ ...current, plateWidth: value ?? current.plateWidth }))}/></label><label>有效高<InputNumber size="small" min={1} value={layout.effectiveHeight} onChange={value => setLayout(current => ({ ...current, effectiveHeight: value ?? current.effectiveHeight }))}/></label><label>有效宽<InputNumber size="small" min={1} value={layout.effectiveWidth} onChange={value => setLayout(current => ({ ...current, effectiveWidth: value ?? current.effectiveWidth }))}/></label><label>有效区域右侧距<InputNumber size="small" min={0} value={layout.effectiveRight} onChange={value => setLayout(current => ({ ...current, effectiveRight: value ?? current.effectiveRight }))}/></label><label>版面孔<InputNumber size="small" min={0} value={layout.holeSize} onChange={value => setLayout(current => ({ ...current, holeSize: value ?? current.holeSize }))}/></label><label>数量<InputNumber size="small" min={0} precision={0} value={layout.holeCount} onChange={value => setLayout(current => ({ ...current, holeCount: value ?? current.holeCount }))}/></label><label>孔间距<InputNumber size="small" min={0} precision={3} value={layout.holeGap} onChange={value => setLayout(current => ({ ...current, holeGap: value ?? current.holeGap }))}/></label><label>版孔左侧距<InputNumber size="small" min={0} precision={1} value={layout.holeLeft} onChange={value => setLayout(current => ({ ...current, holeLeft: value ?? current.holeLeft }))}/></label></div></section><span className="imposition-workspace-hint">{activeJob ? `${activeJob.customerName || '未填写客户'} · ${activeJob.imageCount} 张图片` : '请选择右侧任务'}</span></header>
    <div className="imposition-workspace-body">
      <main className="imposition-canvas-region">{detailError && <Alert type="error" message={detailError} showIcon/>}<div className={`imposition-canvas-scroll ${panMode || spacePressed ? 'is-pan-mode' : ''}`} onWheel={onCanvasWheel} onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp}><ImpositionKonvaCanvas pages={packedPages} imageSources={imageSources} boardWidth={boardWidth} boardHeight={boardHeight} boardScale={boardScale} effectiveX={effectiveX} effectiveY={effectiveY} effectiveWidth={effectiveDisplayWidth} effectiveHeight={layout.effectiveHeight} holeCount={layout.holeCount} holeSize={layout.holeSize} holeLeft={layout.holeLeft} holeStart={holeStart} holeGap={layout.holeGap} zoom={zoom} panOffset={panOffset} panMode={panMode || spacePressed} selectedImageId={selectedImageId} onSelectImage={setSelectedImageId}/></div><footer className="imposition-canvas-footer"><div className="imposition-mode"><Button type="text" className={!panMode ? 'active' : ''} icon={<MousePointer2 size={14}/>} onClick={() => setPanMode(false)}>选择</Button><Button type="text" className={panMode ? 'active' : ''} icon={<Hand size={14}/>} onClick={() => setPanMode(value => !value)}>平移</Button><span className="imposition-shortcut">空格：平移 · Ctrl + 滚轮：缩放</span></div><div className="imposition-workspace-actions"><Button aria-label="缩小" icon={<ZoomOut size={15}/>} onClick={() => updateZoom(-.1)}>缩小</Button><span>{Math.round(zoom * 100)}%</span><Button aria-label="放大" icon={<ZoomIn size={15}/>} onClick={() => updateZoom(.1)}>放大</Button><span>{packedPages.length} 个版面 · 选中 {selectedImageId ? 1 : 0} 张图片</span></div></footer></main>
      <aside className="imposition-job-sidebar"><div className="imposition-sidebar-heading"><div><strong>待拼版</strong><span>{jobs.length} 个任务</span></div><Dropdown trigger={['click']} menu={{ items: [{ key: 'customer', label: '按客户' }, { key: 'time', label: '按时间' }], onClick: ({ key }) => setSortMode(key as 'customer' | 'time') }}><Button size="small" className="imposition-sort-button">{sortMode === 'customer' ? '按客户' : '按时间'} <ChevronDown size={13}/></Button></Dropdown></div><div className="imposition-job-list">{displayJobs.map(job => { const open = expanded.has(job.id); const record = details[job.id]; return <section className={`imposition-job-card ${activeJob?.id === job.id ? 'selected' : ''}`} key={job.id}><button className="imposition-job-trigger" onClick={() => toggle(job.id)} aria-expanded={open}><span>{open ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}<span><strong>{job.customerName || '未填写客户'}</strong><small>{new Date(job.submittedAt).toLocaleString()} · {job.imageCount} 张图片</small></span></span><Tag color={job.paymentStatus === 'paid' ? 'success' : 'orange'}>{job.paymentStatus === 'paid' ? '付款' : '未付款'}</Tag></button>{open && <div className="imposition-job-images">{record?.images.map(image => <button key={image.id} className={selectedImageId === image.id && activeJob?.id === job.id ? 'active' : ''} onClick={() => { onSelectJob(job.id); setSelectedImageId(image.id) }}><span>{image.name}</span><small>{image.widthMm.toFixed(1)} × {image.heightMm.toFixed(1)} mm</small></button>)}{!record && <span className="imposition-job-loading">加载图片明细…</span>}</div>}<div className="imposition-job-card-footer"><span>导出：{job.output.split(/[\\/]/).pop()}</span><Popconfirm title="回退到示意图审核？" description="回退后可重新发起拼版。" okText="回退" cancelText="取消" onConfirm={() => onReturn(job.id)}><Button type="link" danger loading={returningId === job.id} disabled={loading || Boolean(returningId)}>回退</Button></Popconfirm></div></section>})}</div><div className="imposition-sidebar-tip">展开任务可查看它所拥有的图片，点击图片可在画布中定位。</div></aside>
    </div>
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
  const [screen, setScreen] = useState<'list' | 'workspace'>('list')
  const [workspaceJobId, setWorkspaceJobId] = useState<string>()
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
    try {
      await returnImpositionToReview(id)
      if (detailId === id) setDetailId(undefined)
      setRefresh(value => value + 1)
      onReturned?.()
    } catch (reason) { setError(`回退到示意图审核失败：${String(reason)}`) }
    finally { operationLock.current = false; setReturningId(undefined) }
  }
  if (screen === 'workspace') return <ConfigProvider locale={zhCN}><ImpositionWorkspace jobs={result.records} activeJobId={workspaceJobId} onBack={() => setScreen('list')} onSelectJob={setWorkspaceJobId} onReturn={returnToReview} returningId={returningId} loading={loading}/></ConfigProvider>
  return <ConfigProvider locale={zhCN}>
    <ModulePage className="imposition-page" style={colors} title="生产拼版" description="示意图审核转入的记录在这里等待拼版。"
      actions={<div className="imposition-list-actions"><Button icon={<RefreshCw size={15}/>} loading={loading} onClick={() => setRefresh(value => value + 1)}>刷新</Button><Button type="primary" onClick={() => { setWorkspaceJobId(result.records[0]?.id); setScreen('workspace') }}>开始拼版</Button></div>}
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
