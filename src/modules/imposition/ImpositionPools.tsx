import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { Alert, Button, Checkbox, Drawer, Dropdown, Empty, Input, Modal, Pagination, Radio, Select, Spin, Table, Tabs, Tag } from 'antd'
import { ArrowLeft, Check, ChevronRight, Images, Layers, MoreHorizontal, Plus, RefreshCw, Search, Settings2, Trash2, Pencil, Inbox } from 'lucide-react'
import ImpositionThumbnail from './ImpositionThumbnail'
import PoolCustomerPie from './PoolCustomerPie'
import { loadPoolRecords, poolCustomers, poolImages, poolStorageKey, POOL_COLORS, POOL_COLOR_OPTIONS, readPools, recordsForPool, replacePoolImages, UNASSIGNED_POOL, type ImpositionPool, type PoolImage } from './impositionPoolStore'
import type { ImpositionRecord } from './impositionRecords'
import './impositionPools.css'

type Props = { active: boolean; revision: number; onBack: () => void; onStart: (records: ImpositionRecord[]) => void }
const EMPTY_POOL_IMAGES: PoolImage[] = []
const WIDE_POOL_QUERY = '(min-width: 1600px)'
function subscribePoolLayout(onChange: () => void) {
  const media = window.matchMedia(WIDE_POOL_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
const isWidePoolLayout = () => window.matchMedia(WIDE_POOL_QUERY).matches

type PoolEditor = { id?: string; name: string; color: ImpositionPool['color'] }

function CustomerAvatar({ name, index = 0 }: { name: string; index?: number }) {
  return <span className={`pool-customer-avatar pool-tone-${POOL_COLORS[index % 3]}`} aria-hidden="true">{Array.from(name)[0]}</span>
}

// The basin walls are UI surfaces; its contents are always live asset thumbnails.
function PoolBasin({ images }: { images: PoolImage[] }) {
  return <div className={`pool-basin ${images.length ? '' : 'is-empty'}`} aria-label={images.length ? '池内真实图片预览' : '空池子'}>
    <div className="pool-basin-floor"/>
    <div className="pool-basin-back"/>
    <div className="pool-basin-pictures">{images.slice(0, 9).map((item, index) => <div className="pool-basin-picture" key={item.key} style={{ '--picture-column': index % 3, '--picture-row': Math.floor(index / 3) } as CSSProperties}><ImpositionThumbnail path={item.image.filePath} name={item.image.name}/></div>)}</div>
    <div className="pool-basin-side pool-basin-left"/><div className="pool-basin-side pool-basin-right"/>
    <div className="pool-basin-front"/>
    {!images.length && <span className="pool-basin-empty"><Images size={22}/>等待图片入池</span>}
  </div>
}

export default function ImpositionPools({ active, revision, onBack, onStart }: Props) {
  const wideLayout = useSyncExternalStore(subscribePoolLayout, isWidePoolLayout, () => false)
  const poolPageSize = wideLayout ? 5 : 3
  const [saved] = useState(() => {
    try { return { pools: readPools(), storageKey: poolStorageKey(), error: '' } }
    catch (reason) { return { pools: [], storageKey: '', error: `读取拼版池配置失败：${String(reason)}。请检查本地存储后重新进入页面。` } }
  })
  const [records, setRecords] = useState<ImpositionRecord[]>([])
  const [pools, setPools] = useState<ImpositionPool[]>(saved.pools)
  const [selectedId, setSelectedId] = useState(saved.pools[0]?.id ?? UNASSIGNED_POOL)
  const [query, setQuery] = useState('')
  const [poolPage, setPoolPage] = useState(1)
  const [previewCustomer, setPreviewCustomer] = useState<string>()
  const [previewPage, setPreviewPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [storageError, setStorageError] = useState(saved.error)
  const configReady = !saved.error
  const [refresh, setRefresh] = useState(0)
  const [editor, setEditor] = useState<PoolEditor>()
  const [editorError, setEditorError] = useState('')
  const [deleting, setDeleting] = useState<ImpositionPool>()
  const [settingsId, setSettingsId] = useState<string>()
  const [tab, setTab] = useState('customers')
  const [customer, setCustomer] = useState<string>()
  const [imagePage, setImagePage] = useState(1)
  const [manageId, setManageId] = useState<string>()
  const [manageKeys, setManageKeys] = useState<string[]>([])
  const [manageQuery, setManageQuery] = useState('')
  const [manageFilter, setManageFilter] = useState('all')
  const [destination, setDestination] = useState<string>()
  const [checkedKeys, setCheckedKeys] = useState<string[]>([])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true); setLoadError('')
    void loadPoolRecords(controller.signal).then(next => { if (!controller.signal.aborted) setRecords(next) })
      .catch(reason => { if (!controller.signal.aborted) setLoadError(`加载图片失败：${String(reason)}`) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [active, revision, refresh])

  const allImages = useMemo(() => poolImages(records), [records])
  const byPool = useMemo(() => {
    const byKey = new Map(allImages.map(item => [item.key, item]))
    return new Map(pools.map(pool => [pool.id, pool.imageKeys.flatMap(key => { const item = byKey.get(key); return item ? [item] : [] })]))
  }, [allImages, pools])
  const owners = useMemo(() => new Map(pools.flatMap(pool => pool.imageKeys.map(key => [key, pool] as const))), [pools])
  const unassigned = useMemo(() => allImages.filter(item => !owners.has(item.key)), [allImages, owners])
  const selectedPool = pools.find(pool => pool.id === selectedId)
  const selectedImages = selectedPool ? byPool.get(selectedId) ?? EMPTY_POOL_IMAGES : unassigned
  const customers = useMemo(() => poolCustomers(selectedImages), [selectedImages])
  const visibleImages = selectedImages.filter(item => !customer || item.customer === customer)
  const currentImagePage = Math.min(imagePage, Math.max(1, Math.ceil(visibleImages.length / 6)))
  const selectedName = selectedPool?.name ?? '待分类图片'
  const ready = configReady && !loading && !loadError
  const search = query.trim().toLocaleLowerCase()
  const visiblePools = pools.filter(pool => `${pool.name} ${(byPool.get(pool.id) ?? []).map(item => item.customer).join(' ')}`.toLocaleLowerCase().includes(search))
  const currentPoolPage = Math.min(poolPage, Math.max(1, Math.ceil(visiblePools.length / poolPageSize)))
  const previewImages = selectedImages.filter(item => item.customer === previewCustomer)
  const currentPreviewPage = Math.min(previewPage, Math.max(1, Math.ceil(previewImages.length / 6)))
  const fields = useMemo(() => [...new Set(allImages.flatMap(item => Object.keys(item.image.attributes)))].sort(), [allImages])
  const manageable = allImages.filter(item => (manageFilter !== 'unassigned' || !owners.has(item.key) || owners.get(item.key)?.id === manageId)
    && `${item.customer} ${item.image.name} ${item.image.productName}`.toLowerCase().includes(manageQuery.trim().toLowerCase()))

  function commit(next: ImpositionPool[]): boolean {
    try { localStorage.setItem(saved.storageKey, JSON.stringify(next)); setPools(next); setStorageError(''); return true }
    catch (reason) { setStorageError(`保存拼版池失败：${String(reason)}。本次修改未保存，请重试。`); return false }
  }
  function select(id: string) { setSelectedId(id); setCustomer(undefined); setImagePage(1); setCheckedKeys([]); setPreviewCustomer(undefined); setPreviewPage(1); setTab('customers') }
  function openManager(pool: ImpositionPool) { setManageId(pool.id); setManageKeys((byPool.get(pool.id) ?? []).map(item => item.key)); setManageQuery(''); setManageFilter('all') }
  function saveEditor() {
    if (!editor) return
    const name = editor.name.trim()
    if (!name) { setEditorError('请填写池子名称'); return }
    if (pools.some(pool => pool.id !== editor.id && pool.name === name)) { setEditorError('已有同名池子，请换一个名称'); return }
    const id = editor.id ?? crypto.randomUUID()
    const next = editor.id ? pools.map(pool => pool.id === id ? { ...pool, name, color: editor.color } : pool) : [...pools, { id, name, color: editor.color, imageKeys: [] }]
    if (commit(next)) { setEditor(undefined); if (!editor.id) { setQuery(''); setPoolPage(Math.ceil(next.length / poolPageSize)); select(id) } }
  }
  function startPool() { if (selectedImages.length && ready) onStart(recordsForPool(records, selectedImages)) }

  return <section className="imposition-pools" aria-label="拼版池">
    <div className="pool-page-card">
    <header className="pool-page-header"><div><h1>拼版池</h1></div><div className="pool-page-actions"><Button icon={<ArrowLeft size={15}/>} onClick={onBack}>返回列表</Button><Button icon={<RefreshCw size={15}/>} loading={loading} onClick={() => setRefresh(value => value + 1)}>刷新</Button><Button type="primary" disabled={!configReady} icon={<Plus size={17}/>} onClick={() => { setEditorError(''); setEditor({ name: '', color: POOL_COLORS[pools.length % POOL_COLORS.length] }) }}>新建池子</Button></div></header>
    <div className="pool-totals"><span>订单数 <strong>{loading ? '—' : records.length}</strong></span><span>设计总数 <strong>{loading ? '—' : allImages.length}</strong></span></div>
    {(loadError || storageError) && <Alert type="error" showIcon message={loadError || storageError} action={loadError ? <Button size="small" onClick={() => setRefresh(value => value + 1)}>重试</Button> : undefined}/>}
    <Spin wrapperClassName="pool-loading-shell" spinning={loading} tip="正在读取待拼版图片…"><div className="pool-workbench">
      <section className="pool-overview"><div className="pool-overview-toolbar"><h2>池子总览</h2><Input prefix={<Search size={15}/>} placeholder="搜索池子或客户" aria-label="搜索池子或客户" value={query} allowClear onChange={event => { setQuery(event.target.value); setPoolPage(1) }}/></div>
        <div className="pool-card-grid">{visiblePools.slice((currentPoolPage - 1) * poolPageSize, currentPoolPage * poolPageSize).map(pool => {
          const images = byPool.get(pool.id) ?? []
          const clients = poolCustomers(images)
          return <article className={`pool-card pool-tone-${pool.color} ${selectedId === pool.id ? 'is-selected' : ''}`} key={pool.id}>
            <button className="pool-card-select" aria-label={`查看${pool.name}`} aria-pressed={selectedId === pool.id} onClick={() => select(pool.id)}><span className="pool-card-heading"><span className="pool-symbol"><Layers size={25}/></span><span><strong title={pool.name}>{pool.name}</strong><small>{images.length} 张设计 · {clients.length} 位客户</small></span>{selectedId === pool.id && <Check className="pool-selected-check" size={17}/>}</span><PoolBasin images={images}/><span className="pool-card-customers">{clients.slice(0, 3).map((client, index) => <span key={client.name} title={`${client.name} · ${client.count} 张`}><CustomerAvatar name={client.name} index={index}/><span>{client.name}</span></span>)}{clients.length > 3 && <span>+{clients.length - 3}</span>}{!clients.length && <span className="pool-muted">暂无客户，添加图片后显示</span>}</span></button>
            <Dropdown trigger={['click']} menu={{ items: [{ key: 'rename', label: '重命名', icon: <Pencil size={14}/> }, { key: 'delete', label: '删除池子', danger: true, icon: <Trash2 size={14}/> }], onClick: ({ key }) => { if (key === 'delete') setDeleting(pool); else { setEditorError(''); setEditor(pool) } } }}><Button className="pool-card-menu" type="text" size="small" aria-label={`${pool.name}更多操作`} icon={<MoreHorizontal size={19}/>} disabled={!configReady}/></Dropdown>
            <footer className="pool-card-footer"><span>分类依据：<span>待配置</span></span><Button type="link" size="small" icon={<Settings2 size={14}/>} onClick={() => setSettingsId(pool.id)}>设置分类</Button></footer>
          </article>
        })}<div className="pool-utility-card" aria-label="池子操作"><button className="pool-create-card" disabled={!configReady} onClick={() => { setEditorError(''); setEditor({ name: '', color: POOL_COLORS[pools.length % POOL_COLORS.length] }) }}><span><Plus size={30}/></span><strong>新建池子</strong><small>创建图片池，按图片属性分类</small></button>
        <button className={`pool-unassigned ${selectedId === UNASSIGNED_POOL ? 'is-selected' : ''}`} onClick={() => select(UNASSIGNED_POOL)}><Inbox size={24}/><span><strong>待分类 {unassigned.length} 张</strong><small>尚未归入任何池子的图片</small></span><span className="pool-unassigned-link">查看图片 <ChevronRight size={15}/></span></button></div></div>
        <footer className="pool-overview-pagination"><span>{search && !visiblePools.length ? '没有匹配的池子或客户' : `共 ${visiblePools.length} 个池子`}</span>{visiblePools.length > poolPageSize && <Pagination size="small" current={currentPoolPage} pageSize={poolPageSize} total={visiblePools.length} showSizeChanger={false} onChange={setPoolPage}/>}</footer>
      </section>
      <section className={`pool-detail pool-tone-${selectedPool?.color ?? 'blue'}`} aria-label={`${selectedName}明细`}>
        <header className="pool-detail-heading"><span className="pool-symbol"><Layers size={27}/></span><div><h2>{selectedName}</h2><p>{selectedImages.length} 张设计 · {customers.length} 位客户</p></div>{selectedPool && <Button type="link" icon={<Settings2 size={15}/>} onClick={() => setSettingsId(selectedPool.id)}>设置分类</Button>}</header>
        <Tabs className="pool-detail-tabs" activeKey={tab} onChange={value => { setTab(value); setImagePage(1) }} items={[{ key: 'customers', label: '客户分布' }, { key: 'images', label: '设计明细' }]}/>
        {!selectedImages.length ? <div className="pool-detail-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectedPool ? '池子里还没有图片' : '暂无待分类图片'}/>{selectedPool && <Button type="primary" disabled={!ready} icon={<Plus size={15}/>} onClick={() => openManager(selectedPool)}>添加图片</Button>}<p>实际图片入池后，将显示真实缩略图和客户分布。</p></div> : <>
          {tab === 'customers' ? <PoolCustomerPie key={selectedId} customers={customers} onSelect={name => { setPreviewCustomer(name); setPreviewPage(1) }}/> : <>
          <div className="pool-section-heading pool-images-heading"><h3>全部设计</h3><Select aria-label="按客户筛选图片" value={customer} placeholder="全部客户" allowClear onChange={value => { setCustomer(value); setImagePage(1); setCheckedKeys([]) }} options={customers.map(client => ({ value: client.name, label: client.name }))}/></div>
          <div className="pool-image-grid">{visibleImages.slice((currentImagePage - 1) * 6, currentImagePage * 6).map(item => <div className="pool-image-tile" key={item.key}><div className="pool-image-preview"><ImpositionThumbnail path={item.image.filePath} name={item.image.name}/>{!selectedPool && <Checkbox aria-label={`选择 ${item.customer} ${item.image.name}`} checked={checkedKeys.includes(item.key)} onChange={event => setCheckedKeys(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))}/>}</div><strong title={item.image.name}>{item.image.name}</strong><span title={item.customer}>{item.customer}</span><small>{item.image.productName || '未设置产品'} · {item.image.widthMm} × {item.image.heightMm} mm</small></div>)}</div>
          <Pagination size="small" current={currentImagePage} pageSize={6} total={visibleImages.length} showSizeChanger={false} onChange={setImagePage}/></>}
        </>}
        <footer className="pool-detail-actions">{selectedPool ? <><Button type="primary" disabled={!ready || !selectedImages.length} onClick={startPool}>开始拼版</Button><Button disabled={!ready} icon={<Plus size={15}/>} onClick={() => openManager(selectedPool)}>管理图片</Button></> : <><Select aria-label="选择目标池子" placeholder="选择目标池子" value={destination} onChange={setDestination} options={pools.map(pool => ({ value: pool.id, label: pool.name }))}/><Button type="primary" disabled={!ready || !checkedKeys.length || !pools.some(pool => pool.id === destination)} onClick={() => { const target = pools.find(pool => pool.id === destination); if (target && commit(replacePoolImages(pools, target.id, [...target.imageKeys, ...checkedKeys]))) { setCheckedKeys([]); select(target.id) } }}>移入池子{checkedKeys.length ? `（${checkedKeys.length}）` : ''}</Button></>}</footer>
      </section>
    </div></Spin>
    </div>
    <Modal title={`${previewCustomer ?? ''} · 图片缩略图（${previewImages.length} 张）`} open={Boolean(previewCustomer)} onCancel={() => setPreviewCustomer(undefined)} footer={null} width="min(1000px, calc(100vw - 48px))" centered destroyOnHidden className="pool-customer-preview-modal">
      <p className="pool-customer-preview-caption">{selectedName} · {previewImages.length} 张图片</p>
      <div className="pool-customer-preview-grid">{previewImages.slice((currentPreviewPage - 1) * 6, currentPreviewPage * 6).map(item => <div className="pool-image-tile" key={item.key}><div className="pool-image-preview"><ImpositionThumbnail path={item.image.filePath} name={item.image.name}/></div><strong title={item.image.name}>{item.image.name}</strong><span>{item.image.productName || '未设置产品'}</span></div>)}</div>
      <Pagination size="small" current={currentPreviewPage} pageSize={6} total={previewImages.length} showSizeChanger={false} onChange={setPreviewPage}/>
    </Modal>
    <Modal title={editor?.id ? '编辑池子' : '新建池子'} open={Boolean(editor)} onCancel={() => setEditor(undefined)} onOk={saveEditor} okText="保存" cancelText="取消" destroyOnHidden><div className="pool-editor">{editorError && <Alert type="error" message={editorError}/>}<label htmlFor="pool-name">池子名称</label><Input id="pool-name" maxLength={30} placeholder="例如：生产池 A" value={editor?.name ?? ''} onChange={event => setEditor(current => current && ({ ...current, name: event.target.value }))} onPressEnter={saveEditor}/><span>池子颜色</span><Radio.Group className="pool-color-options" value={editor?.color} onChange={event => setEditor(current => current && ({ ...current, color: event.target.value }))} options={POOL_COLOR_OPTIONS.map(option => ({ value: option.value, label: <span className={`pool-color-option pool-tone-${option.value}`}><span className="pool-color-dot"/>{option.label}</span> }))}/></div></Modal>
    <Modal title={`删除“${deleting?.name ?? ''}”？`} open={Boolean(deleting)} onCancel={() => setDeleting(undefined)} okText="删除池子" cancelText="取消" okButtonProps={{ danger: true }} onOk={() => { if (deleting && commit(pools.filter(pool => pool.id !== deleting.id))) { if (selectedId === deleting.id) select(UNASSIGNED_POOL); setDeleting(undefined) } }}><p>池内图片会回到待分类区域，原始图片和产品数据会保留。</p></Modal>
    <Drawer title={`${pools.find(pool => pool.id === settingsId)?.name ?? ''} · 分类设置`} open={Boolean(settingsId)} onClose={() => setSettingsId(undefined)} width={420}><Alert type="info" showIcon message="分类依据待配置" description="自动分类规则尚未确定。当前可以通过“管理图片”手动归集，确定规则后再接入自动分类。"/><h3>当前图片中的属性字段</h3><p className="pool-muted">以下仅展示现有字段，尚未启用匹配规则。</p><div className="pool-field-tags">{fields.length ? fields.map(field => <Tag key={field}>{field}</Tag>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无图片属性字段"/>}</div></Drawer>
    <Modal title={`${pools.find(pool => pool.id === manageId)?.name ?? ''} · 管理图片`} open={Boolean(manageId)} width={920} onCancel={() => setManageId(undefined)} okText={`保存所选图片（${manageKeys.length}）`} cancelText="取消" okButtonProps={{ disabled: !ready }} onOk={() => { if (manageId && commit(replacePoolImages(pools, manageId, manageKeys))) setManageId(undefined) }} destroyOnHidden>
      <Alert type="info" showIcon message="勾选图片加入当前池，取消勾选移回待分类。选择其他池的图片会将它移入当前池。"/>
      <div className="pool-manage-toolbar"><Input aria-label="搜索待归集图片" prefix={<Search size={15}/>} placeholder="搜索客户、图片或产品" value={manageQuery} onChange={event => setManageQuery(event.target.value)}/><Radio.Group value={manageFilter} onChange={event => setManageFilter(event.target.value)} options={[{ label: '全部图片', value: 'all' }, { label: '待分类及本池', value: 'unassigned' }]}/></div>
      <Table<PoolImage> rowKey="key" size="small" dataSource={manageable} scroll={{ x: 650, y: 380 }} pagination={{ pageSize: 10, showSizeChanger: false }} rowSelection={{ selectedRowKeys: manageKeys, preserveSelectedRowKeys: true, onChange: keys => setManageKeys(keys.map(String)) }} columns={[{ title: '图片', key: 'image', width: 72, render: (_, item) => <ImpositionThumbnail path={item.image.filePath} name={item.image.name}/> }, { title: '文件名', key: 'name', render: (_, item) => item.image.name }, { title: '客户', dataIndex: 'customer' }, { title: '产品', key: 'product', render: (_, item) => item.image.productName || '未设置产品' }, { title: '当前池子', key: 'pool', render: (_, item) => owners.get(item.key)?.name ?? <Tag color="orange">待分类</Tag> }]}/>
    </Modal>
  </section>
}
