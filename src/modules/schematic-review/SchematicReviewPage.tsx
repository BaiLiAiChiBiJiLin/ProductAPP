import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Alert, Button, ConfigProvider, DatePicker, Dropdown, Input, Modal, Pagination, Table, Tag, theme } from 'antd'
import zhCN from 'antd/es/locale/zh_CN'
import type { Dayjs } from 'dayjs'
import 'dayjs/locale/zh-cn'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { deleteReviewRecord, listReviewRecords, loadReviewRecord, type PaymentStatus, type ReviewListResult, type SchematicReviewRecord, type SchematicReviewSummary } from './reviewRecords'
import { submitReviewToImposition } from '../imposition/impositionRecords'
import ModulePage from '../../components/ModulePage'
import './schematic-review.css'

type Props = { active: boolean; revision: number; working?: boolean; onEdit: (record: SchematicReviewRecord) => void; onImpositionSubmitted?: () => void; onImposition?: () => void }

export default function SchematicReviewPage({ active, revision, working = false, onEdit, onImpositionSubmitted, onImposition }: Props) {
  const [result, setResult] = useState<ReviewListResult>({ records: [], total: 0, page: 1, pageSize: 20 })
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [savedDate, setSavedDate] = useState<Dayjs | null>(null)
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20 })
  const [refresh, setRefresh] = useState(0)
  const operationLock = useRef(false)
  const [modal, modalContext] = Modal.useModal()
  const { token } = theme.useToken()
  const paymentColors = {
    '--review-paid-bg': token.colorSuccessBg,
    '--review-paid-hover-bg': token.colorSuccessBgHover,
    '--review-unpaid-bg': token.colorErrorBg,
    '--review-unpaid-hover-bg': token.colorErrorBgHover,
    '--review-pending-bg': token.orange1,
    '--review-pending-hover-bg': token.orange2,
  } as CSSProperties
  // Include the entire selected local day; the following midnight is exclusive.
  const dateFrom = savedDate?.startOf('day').toISOString()
  const dateTo = savedDate?.add(1, 'day').startOf('day').toISOString()
  const search = query.trim()
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    setError('')
    void listReviewRecords({ ...pagination, search, dateFrom, dateTo }).then(next => {
      if (cancelled) return
      setResult(next)
      if (next.page !== pagination.page || next.pageSize !== pagination.pageSize) setPagination({ page: next.page, pageSize: next.pageSize })
    })
      .catch(reason => { if (!cancelled) setError(`加载审核记录失败：${String(reason)}`) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active, revision, refresh, pagination, search, dateFrom, dateTo])
  const edit = async (id: string) => {
    if (operationLock.current || working || loading || result.records.find(record => record.id === id)?.impositionJobId) return
    operationLock.current = true
    setEditingId(id)
    setError('')
    try { onEdit(await loadReviewRecord(id)) }
    catch (reason) { setError(`打开示意图失败：${String(reason)}`) }
    finally { operationLock.current = false; setEditingId(null) }
  }
  const remove = (record: SchematicReviewSummary) => {
    if (operationLock.current || working || loading || record.impositionJobId) return
    operationLock.current = true
    const release = () => { operationLock.current = false; setDeletingId(null) }
    modal.confirm({
      title: '删除这条审核记录？',
      content: <div className="schematic-review-delete-description"><strong>{record.output.split(/[\\/]/).pop()}</strong><p>删除后无法恢复此审核记录。已导出的文件和原始批次会保留。</p></div>,
      okText: '删除', cancelText: '取消', okButtonProps: { danger: true },
      onCancel: release,
      afterClose: release,
      onOk: async () => {
        setDeletingId(record.id)
        setError('')
        try {
          await deleteReviewRecord(record.id)
          // The backend clamps an emptied last page to the preceding page.
          setRefresh(value => value + 1)
        } catch (reason) {
          setDeletingId(null)
          setError(`删除审核记录失败：${String(reason)}`)
          throw reason
        }
      },
    })
  }
  const submit = async (id: string, paymentStatus: PaymentStatus) => {
    if (operationLock.current || working || loading || result.records.find(record => record.id === id)?.impositionJobId) return
    operationLock.current = true
    setUpdatingId(id)
    setError('')
    try {
      const job = await submitReviewToImposition(id, paymentStatus)
      setResult(current => ({ ...current, records: current.records.map(record => record.id === id ? { ...record, paymentStatus: job.paymentStatus, impositionJobId: job.id, returned: false } : record) }))
      // Invalidate list requests that started before the stage transition.
      setRefresh(value => value + 1)
      onImpositionSubmitted?.()
    } catch (reason) { setError(`进入生产拼版失败：${String(reason)}`) }
    finally { operationLock.current = false; setUpdatingId(null) }
  }
  const actionsDisabled = working || loading || Boolean(editingId || deletingId || updatingId)
  return <ConfigProvider locale={zhCN}>
    {modalContext}
    <ModulePage className="schematic-review-page" style={paymentColors} title="示意图审核" description="每次成功导出后保存一条记录。点击编辑可恢复当时的排列和调整。"
      actions={<Button icon={<RefreshCw size={15}/>} loading={loading} onClick={() => setRefresh(value => value + 1)}>刷新</Button>}
      notice={error && <Alert type="error" showIcon message={error}/>}
      toolbar={<>
        <Input aria-label="搜索审核记录" placeholder="搜索客户或导出文件名" allowClear value={query} onChange={event => { setQuery(event.target.value); setPagination(current => ({ ...current, page: 1 })) }}/>
        <div className="schematic-review-date-filter"><label htmlFor="review-saved-date">保存时间</label><DatePicker id="review-saved-date" placeholder="选择保存日期" format="YYYY-MM-DD" value={savedDate} allowClear onChange={value => { setSavedDate(value); setPagination(current => ({ ...current, page: 1 })) }}/></div>
      </>}
      footer={<><span>共 {result.total} 条记录</span><Pagination current={result.page} pageSize={result.pageSize} total={result.total} showSizeChanger pageSizeOptions={[20, 50, 100]} showQuickJumper disabled={loading} onChange={(page, pageSize) => setPagination({ page: pageSize === pagination.pageSize ? page : 1, pageSize })}/></>}>
      <div className="module-page-table schematic-review-table">
        <Table<SchematicReviewSummary> rowKey="id" rowClassName={record => record.impositionJobId ? record.paymentStatus === 'paid' ? 'review-payment-paid' : 'review-imposition-unpaid' : 'review-payment-unpaid'} dataSource={result.records} loading={loading} pagination={false} scroll={{ x: 1080 }} locale={{ emptyText: search || savedDate ? '没有匹配的记录' : '暂无审核记录，成功导出示意图后会自动保存到这里' }} columns={[
          { title: '客户', dataIndex: 'customerName', render: value => value || '未填写客户', width: 180 },
          { title: '导出文件', dataIndex: 'output', render: (value: string) => <span title={value}>{value.split(/[\\/]/).pop()}</span> },
          { title: '保存时间', dataIndex: 'savedAt', render: (value: string) => new Date(value).toLocaleString(), width: 200 },
          { title: '页数', dataIndex: 'pageCount', width: 70 },
          { title: '图片数', dataIndex: 'imageCount', width: 80 },
          { title: '格式', dataIndex: 'format', render: (value: string) => value.toUpperCase(), width: 75 },
          { title: '状态', dataIndex: 'paymentStatus', width: 130, render: (value: PaymentStatus, record) => <Tag color={record.returned ? 'error' : record.impositionJobId ? value === 'paid' ? 'success' : 'orange' : 'error'}>{record.returned ? '被退回' : <>{value === 'paid' ? '付款' : '未付款'}{record.impositionJobId ? ' · 待拼版' : ''}</>}</Tag> },
          { title: '操作', key: 'actions', width: 205, fixed: 'right', render: (_, record) => <div className="schematic-review-actions">{record.impositionJobId ? <Button type="link" disabled={actionsDisabled} onClick={onImposition}>查看拼版</Button> : <>
            <Button type="link" aria-label="编辑" loading={editingId === record.id} disabled={actionsDisabled} onClick={() => void edit(record.id)}>编辑</Button>
            <Dropdown trigger={['click']} disabled={actionsDisabled} menu={{
              items: [{ key: 'paid', label: '已付款拼版' }, { key: 'unpaid', label: '未付款拼版' }],
              onClick: ({ key }) => { if (key === 'paid' || key === 'unpaid') void submit(record.id, key) },
            }}><Button type="link" aria-label="拼版" loading={updatingId === record.id} disabled={actionsDisabled}>拼版<ChevronDown size={12}/></Button></Dropdown>
            <Button type="link" danger aria-label="删除" loading={deletingId === record.id} disabled={actionsDisabled} onClick={() => remove(record)}>删除</Button>
          </>}</div> },
        ]}/>
      </div>
    </ModulePage>
  </ConfigProvider>
}
