import { useEffect, useState } from 'react'
import { Button, Popover, Tag, theme } from 'antd'
import { cloudSyncTasks, flushCloudSyncQueue, type CloudSyncStatus } from '../services/cloudSyncQueue'
import './cloud-sync-status.css'

const taskStateLabels = { queued: '等待同步', syncing: '正在同步', error: '等待重试', blocked: '需要处理' }
const errorMessage = (error: string) => error.replace(/^(?:Error:\s*)+/, '')

export default function CloudSyncStatusTag({ status }: { status: CloudSyncStatus }) {
  const [open, setOpen] = useState(false)
  const [retryingId, setRetryingId] = useState<string>()
  const [retryError, setRetryError] = useState<{ id: string; message: string }>()
  const [now, setNow] = useState(Date.now)
  const { token } = theme.useToken()
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [open])
  if (status.pending <= 0 && !status.error) return null
  const blocked = status.state === 'blocked'
  const retrying = status.state === 'error'
  const syncing = status.state === 'syncing'
  const label = status.pending <= 0 ? '同步存储待处理' : blocked ? '同步待处理' : retrying ? '同步稍后重试' : syncing ? '正在同步' : '待同步'
  const countHint = status.pending <= 0 ? '本地同步存储暂不可用，任务信息待恢复。' : `共 ${status.pending} 项批次同步任务（包含正在处理的任务），同一批次的连续修改合并为一项。`
  const title = (retrying || blocked) && status.error ? `${countHint}\n失败原因：${status.error}` : countHint
  const retry = async (id: string) => {
    if (retryingId) return
    setRetryingId(id); setRetryError(undefined)
    try { await flushCloudSyncQueue(id) }
    catch (error) { setRetryError({ id, message: String(error) }) }
    finally { setRetryingId(undefined) }
  }
  const tasks = open ? cloudSyncTasks() : []
  const details = <div className="cloud-sync-details">
    <p>{countHint}</p>
    {status.error && !tasks.some(task => task.error === status.error) && <p role="alert" style={{ color: token.colorErrorText }}>{errorMessage(status.error)}</p>}
    {tasks.map(task => {
      const localError = retryError?.id === task.id ? retryError.message : undefined
      const error = localError || task.error
      return <section key={task.id} className="cloud-sync-task" aria-label={`批次 ${task.id} 的同步任务`} style={{ borderColor: token.colorBorderSecondary }}>
        <div className="cloud-sync-task-heading">
          <strong>{task.customerName || task.name}</strong>
          <Tag color={localError || task.state === 'blocked' ? 'error' : task.state === 'syncing' ? 'processing' : 'gold'}>
            {task.deletionRequested ? '删除待处理' : localError ? '重试失败' : taskStateLabels[task.state]}
          </Tag>
        </div>
        <dl className="cloud-sync-task-facts">
          <dt>批次 ID</dt><dd className="cloud-sync-task-id">{task.id}</dd>
          <dt>操作</dt><dd>{task.operation === 'delete_batch' ? '删除批次' : '保存批次'}</dd>
          <dt>图片数量</dt><dd>{task.assetCount} 张</dd>
        </dl>
        {error && <p role="alert" style={{ color: token.colorErrorText }}>失败原因：{errorMessage(error)}</p>}
        {task.action && <p>{task.action}</p>}
        {!localError && !task.blocked && task.nextAttemptAt && task.state !== 'syncing' && <p>预计 {Math.max(0, Math.ceil((task.nextAttemptAt - now) / 1_000))} 秒后自动重试</p>}
        <div className="cloud-sync-task-actions">
          {task.attempts > 0 && <span>已尝试 {task.attempts} 次</span>}
          {!task.deletionRequested && <Button size="small" loading={retryingId === task.id} disabled={syncing || !!retryingId} onClick={() => void retry(task.id)}>立即重试</Button>}
        </div>
      </section>
    })}
    {retryError && !tasks.some(task => task.id === retryError.id) && <p role="alert" style={{ color: token.colorErrorText }}>批次 {retryError.id}：{errorMessage(retryError.message)}</p>}
  </div>

  return <Popover title="后台同步任务" content={details} trigger="click" open={open} onOpenChange={value => { setOpen(value); setNow(Date.now()); setRetryError(undefined) }}>
    <Button type="text" size="small" aria-label="查看后台同步任务" aria-expanded={open} style={{ padding: 0, height: 'auto', flexShrink: 0 }}>
    <Tag color={blocked ? 'error' : syncing ? 'processing' : 'gold'}
    role="status" aria-live="polite" aria-atomic="true" title={title}
    style={{ flexShrink: 0, whiteSpace: 'nowrap', marginInlineEnd: 0 }}>
    {label}{status.pending > 0 && <> · {status.pending} 项</>}
    </Tag>
    </Button>
  </Popover>
}
