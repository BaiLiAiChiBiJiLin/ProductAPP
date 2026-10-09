import { useEffect, useRef, useState } from 'react'
import { Alert, Button, ConfigProvider, DatePicker, Input, Pagination } from 'antd'
import zhCN from 'antd/es/locale/zh_CN'
import 'dayjs/locale/zh-cn'
import { Trash2 } from 'lucide-react'
import Loading from '../../../components/Loading'
import { deleteHistoryBatch, listHistoryBatches, type BatchListResult, type BatchLoadProgress, type BatchSummary } from '../services/batchHistoryService'
import BatchHistoryPreview from './BatchHistoryPreview'
import { useBatchHistoryFilters } from './useBatchHistoryFilters'
import './batch-history.css'

type Props = { active: boolean; openingId: string | null; progress: BatchLoadProgress; onOpen: (record: BatchSummary) => void }
const emptyResult: BatchListResult = { records: [], total: 0, page: 1, pageSize: 12 }

export default function BatchHistoryPanel({ active, openingId, progress, onOpen }: Props) {
  const [result, setResult] = useState(emptyResult)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const deleteLock = useRef(false)
  const scrollArea = useRef<HTMLDivElement>(null)
  const disabled = Boolean(openingId || deletingId)
  const filters = useBatchHistoryFilters(active && !disabled)
  const { query, setQuery } = filters

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    setError('')
    void listHistoryBatches(query).then(value => {
      if (cancelled) return
      setResult(value)
      scrollArea.current?.scrollTo?.({ top: 0 })
    }).catch(failure => { if (!cancelled) setError(`历史记录读取失败：${String(failure)}`) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active, query, revision])

  const remove = async (id: string) => {
    if (deleteLock.current || openingId) return
    deleteLock.current = true; setDeletingId(id); setError('')
    try { await deleteHistoryBatch(id); setRevision(current => current + 1) }
    catch (failure) { setError(`删除失败：${String(failure)}`) }
    finally { deleteLock.current = false; setDeletingId(null) }
  }
  const filtering = Boolean(query.search || query.dateFrom || query.dateTo)

  if (openingId) return <div className="batch-history" hidden={!active}>
    <div className="history-loading"><Loading size="large" text={`正在加载批次图片（${progress.completed}/${progress.total}）…`}/></div>
  </div>

  return <ConfigProvider locale={zhCN}><div className="batch-history" hidden={!active}>
    <div className="batch-history-filters" role="search" aria-label="筛选历史批次">
      <Input aria-label="搜索批次名" placeholder="搜索批次名" allowClear value={filters.name} disabled={disabled}
        onChange={event => filters.setName(event.target.value)}
        onCompositionStart={filters.compositionStart} onCompositionEnd={event => filters.compositionEnd(event.currentTarget.value)}
        onPressEnter={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault(); filters.searchNow()
        }}/>
      <DatePicker aria-label="保存日期" placeholder="保存日期" value={filters.savedDate} onChange={filters.changeDate} disabled={disabled}/>
      <Button onClick={filters.clear} disabled={disabled}>重置</Button>
    </div>
    {error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => setRevision(value => value + 1)} disabled={disabled}>重试</Button>}/>}
    <div className="batch-history-results" ref={scrollArea} aria-busy={loading}>
      {loading ? <div className="history-loading"><Loading size="large" text="正在加载历史记录…"/></div> : error ? null : result.records.length ? <div className="batch-history-grid">
        {result.records.map(record => <article className="recent-batch-card" key={record.id}>
          <button className="batch-history-open" type="button" aria-label={`打开批次 ${record.customerName}`} disabled={disabled} onClick={() => onOpen(record)}>
            <BatchHistoryPreview batchId={record.id} savedAt={record.savedAt} assetCount={record.assetCount} active={active}/>
            <strong>{record.customerName}</strong>
            <span>{new Date(record.savedAt).toLocaleString()}</span>
            <em>共 {record.assetCount} 张</em>
          </button>
          <button type="button" className="recent-batch-delete" aria-label={`删除批次 ${record.customerName}`} title="删除历史批次" disabled={disabled} onClick={() => void remove(record.id)}>
            {deletingId === record.id ? <Loading size="small" inline/> : <Trash2 size={12}/>}
          </button>
        </article>)}
      </div> : <div className="batch-history-empty">{filtering ? '没有符合条件的记录' : '暂无记录'}</div>}
    </div>
    <div className="batch-history-pagination"><Pagination current={result.page} pageSize={result.pageSize} total={result.total} showSizeChanger pageSizeOptions={[12, 24, 48]} showTotal={total => `共 ${total} 个批次`} disabled={disabled || loading}
      onChange={(page, pageSize) => setQuery(current => ({ ...current, page: pageSize === current.pageSize ? page : 1, pageSize }))}/></div>
  </div></ConfigProvider>
}
