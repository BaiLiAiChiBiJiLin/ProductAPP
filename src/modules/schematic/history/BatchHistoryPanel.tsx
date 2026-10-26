import { useEffect, useRef, useState } from 'react'
import { Alert, Button, ConfigProvider, DatePicker, Dropdown, Input, Pagination, message } from 'antd'
import zhCN from 'antd/es/locale/zh_CN'
import 'dayjs/locale/zh-cn'
import { Trash2, RefreshCw, Send } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@tauri-apps/api/core'
import Loading from '../../../components/Loading'
import { deleteHistoryBatch, listHistoryBatches, type BatchListResult, type BatchLoadProgress, type BatchSummary } from '../services/batchHistoryService'
import BatchHistoryPreview from './BatchHistoryPreview'
import { useBatchHistoryFilters } from './useBatchHistoryFilters'
import './batch-history.css'
import { currentSharedUser, refreshSharedTransfers, sendBatchTransfer, type SharedTransferProgress } from '../services/sharedTransferService'
import TransferBatchModal from '../components/TransferBatchModal'

type Props = { active: boolean; openingId: string | null; progress: BatchLoadProgress; onOpen: (record: BatchSummary) => void; userName?: string; onSharedRecordsChanged?: () => void; onTransferringChange?: (busy: boolean) => void }
const emptyResult: BatchListResult = { records: [], total: 0, page: 1, pageSize: 12 }

export default function BatchHistoryPanel({ active, openingId, progress, onOpen, userName = currentSharedUser(), onSharedRecordsChanged, onTransferringChange }: Props) {
  const [notice, noticeContext] = message.useMessage({ top: 72, duration: 3, maxCount: 1 })
  const [result, setResult] = useState(emptyResult)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [syncProgress, setSyncProgress] = useState<SharedTransferProgress>()
  const syncLock = useRef(false)
  const deleteLock = useRef(false)
  const transferLock = useRef(false)
  const [transferRecord, setTransferRecord] = useState<BatchSummary | null>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const disabled = Boolean(openingId || deletingId || syncing || transferRecord)
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
  }, [active, query, revision, userName])

  useEffect(() => {
    if (!active || !isTauri()) return
    let cancelled = false
    let stop = () => {}
    void listen<SharedTransferProgress>('shared-transfer-progress', event => { if (!cancelled && syncLock.current) setSyncProgress(event.payload) })
      .then(unlisten => { if (cancelled) unlisten(); else stop = unlisten }).catch(() => {})
    return () => { cancelled = true; stop() }
  }, [active])

  const refresh = async () => {
    if (syncLock.current || deleteLock.current || transferLock.current || disabled || !userName) return
    syncLock.current = true; setSyncing(true); setSyncError(''); notice.destroy(); setSyncProgress(undefined)
    try {
      const updated = await refreshSharedTransfers(userName)
      if (updated.errors.length) setSyncError(updated.errors.join('；'))
      else void notice.success(updated.shared ? '云端历史记录已刷新。' : updated.imported ? `已接收 ${updated.imported} 个批次，相关审核和生产拼版记录已写入本地。` : updated.finalized ? `已完成 ${updated.finalized} 个转移批次的发送端清理。` : '刷新完成，暂无新的转移数据。')
      if (updated.imported || updated.finalized) onSharedRecordsChanged?.()
      if (updated.imported) filters.clear()
    } catch (failure) { setSyncError(`刷新失败：${String(failure)}`) }
    finally { syncLock.current = false; setSyncing(false); setRevision(value => value + 1) }
  }

  const remove = async (id: string) => {
    if (deleteLock.current || syncLock.current || transferLock.current || disabled) return
    deleteLock.current = true; setDeletingId(id); setError('')
    try { await deleteHistoryBatch(id); setRevision(current => current + 1) }
    catch (failure) { setError(`删除失败：${String(failure)}`) }
    finally { deleteLock.current = false; setDeletingId(null) }
  }
  const transfer = async (recipient: string) => {
    if (!transferRecord || !userName || transferLock.current || syncLock.current || deleteLock.current || openingId) throw new Error('请等待当前操作完成后再转移')
    transferLock.current = true; onTransferringChange?.(true)
    setSyncError(''); notice.destroy()
    try {
      const sent = await sendBatchTransfer(transferRecord.id, userName, recipient)
      setTransferRecord(null)
      void notice.success(sent.shared ? `批次已转移给 ${sent.recipient}，对方刷新历史记录即可查看。` : `已向 ${sent.recipient} 发送批次，对方在历史记录页刷新即可接收。`)
    } finally {
      transferLock.current = false; onTransferringChange?.(false)
      // Publication can succeed before a network response fails. Reload all
      // affected lists even when the dialog needs to report an error.
      setRevision(value => value + 1); onSharedRecordsChanged?.()
    }
  }
  const filtering = Boolean(query.search || query.dateFrom || query.dateTo)

  if (openingId) return <div className="batch-history" hidden={!active}>
    <div className="history-loading"><Loading size="large" text={`正在加载批次图片（${progress.completed}/${progress.total}）…`}/></div>
  </div>

  return <ConfigProvider locale={zhCN}><div className="batch-history" hidden={!active}>
    {noticeContext}
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
      <Button icon={<RefreshCw size={14}/>} loading={syncing} disabled={disabled || !userName} onClick={() => void refresh()}>刷新</Button>
    </div>
    {syncError && <Alert type="warning" showIcon message={syncError} action={<Button size="small" disabled={disabled} onClick={() => void refresh()}>重试接收</Button>}/>}
    {error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => setRevision(value => value + 1)} disabled={disabled}>重试</Button>}/>}
    <div className="batch-history-results" ref={scrollArea} aria-busy={loading || syncing}>
      {loading || syncing ? <div className="history-loading"><Loading size="large" text={syncing ? syncProgress?.total ? `正在接收共享数据（${syncProgress.completed}/${syncProgress.total}）…` : '正在检查共享收件目录…' : '正在加载历史记录…'}/></div> : error ? null : result.records.length ? <div className="batch-history-grid">
        {result.records.map(record => <Dropdown key={record.id} trigger={['contextMenu']} disabled={disabled} menu={{
          items: [{ key: 'transfer', label: '转移', icon: <Send size={14}/>, disabled: disabled || !userName }],
          onClick: ({ key, domEvent }) => { domEvent.stopPropagation(); if (key === 'transfer' && !disabled && !deleteLock.current && !syncLock.current && !transferLock.current) setTransferRecord(record) },
        }}><article className="recent-batch-card">
          <button className="batch-history-open" type="button" aria-label={`打开批次 ${record.customerName}`} disabled={disabled} onClick={() => onOpen(record)}>
            <BatchHistoryPreview batchId={record.id} savedAt={record.savedAt} assetCount={record.assetCount} active={active}/>
            <strong>{record.customerName}</strong>
            <span>{new Date(record.savedAt).toLocaleString()}</span>
            <em>共 {record.assetCount} 张</em>
          </button>
          <button type="button" className="recent-batch-delete" aria-label={`删除批次 ${record.customerName}`} title="删除历史批次" disabled={disabled} onClick={() => void remove(record.id)}>
            {deletingId === record.id ? <Loading size="small" inline/> : <Trash2 size={12}/>}
          </button>
        </article></Dropdown>)}
      </div> : <div className="batch-history-empty">{filtering ? '没有符合条件的记录' : '暂无记录'}</div>}
    </div>
    <div className="batch-history-pagination"><Pagination current={result.page} pageSize={result.pageSize} total={result.total} showSizeChanger pageSizeOptions={[12, 24, 48]} showTotal={total => `共 ${total} 个批次`} disabled={disabled || loading}
      onChange={(page, pageSize) => setQuery(current => ({ ...current, page: pageSize === current.pageSize ? page : 1, pageSize }))}/></div>
    {transferRecord && <TransferBatchModal open userName={userName} batchId={transferRecord.id} batchName={transferRecord.customerName} assetCount={transferRecord.assetCount} saveBeforeTransfer={false} onCancel={() => { if (!transferLock.current) setTransferRecord(null) }} onTransfer={transfer}/>}
  </div></ConfigProvider>
}
