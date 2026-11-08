import { useEffect, useState } from 'react'
import { Button, Popover, Tag } from 'antd'
import { cloudSyncTasks, flushCloudSyncQueue, type CloudSyncStatus } from '../services/cloudSyncQueue'

export default function CloudSyncStatusTag({ status }: { status: CloudSyncStatus }) {
  const [open, setOpen] = useState(false)
  const [retryingId, setRetryingId] = useState<string>()
  const [retryError, setRetryError] = useState('')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [open])
  if (status.pending <= 0) return null
  const blocked = status.state === 'blocked'
  const retrying = status.state === 'error'
  const syncing = status.state === 'syncing'
  const label = blocked ? '同步待处理' : retrying ? '同步稍后重试' : syncing ? '正在同步' : '待同步'
  const countHint = `共 ${status.pending} 项批次同步任务（包含正在处理的任务），同一批次的连续修改合并为一项。`
  const title = (retrying || blocked) && status.error ? `${countHint}\n失败原因：${status.error}` : countHint
  const retry = async (id: string) => {
    if (retryingId) return
    setRetryingId(id); setRetryError('')
    try { await flushCloudSyncQueue(id) }
    catch (error) { setRetryError(String(error)) }
    finally { setRetryingId(undefined) }
  }
  const tasks = open ? cloudSyncTasks() : []
  const details = <div style={{ width: 'min(380px, calc(100vw - 64px))', maxHeight: 'min(420px, 65vh)', overflowY: 'auto', overflowWrap: 'anywhere' }}>
    <p>{countHint}</p>
    {status.error && !tasks.some(task => task.error === status.error) && <p role="alert">{status.error.replace(/^Error: /, '')}</p>}
    {tasks.map(task => <section key={task.id} style={{ borderTop: '1px solid #f0f0f0', paddingBlock: 12 }}>
      <strong>{task.name}</strong>
      {task.error && <p role="alert">{task.error.replace(/^Error: /, '')}</p>}
      {task.action && <p>{task.action}</p>}
      {!task.blocked && task.nextAttemptAt && !syncing && <p>预计 {Math.max(0, Math.ceil((task.nextAttemptAt - now) / 1_000))} 秒后自动重试</p>}
      {task.attempts > 0 && <p>已尝试 {task.attempts} 次</p>}
      {!task.deletionRequested && <Button size="small" loading={retryingId === task.id} disabled={syncing || !!retryingId} onClick={() => void retry(task.id)}>立即重试</Button>}
    </section>)}
    {retryError && <p role="alert">{retryError}</p>}
  </div>

  return <Popover title="后台同步任务" content={details} trigger="click" open={open} onOpenChange={value => { setOpen(value); setNow(Date.now()); setRetryError('') }}>
    <Button type="text" size="small" aria-label="查看后台同步任务" aria-expanded={open} style={{ padding: 0, height: 'auto', flexShrink: 0 }}>
    <Tag color={blocked ? 'error' : syncing ? 'processing' : 'gold'}
    role="status" aria-live="polite" aria-atomic="true" title={title}
    style={{ flexShrink: 0, whiteSpace: 'nowrap', marginInlineEnd: 0 }}>
    {label} · {status.pending} 项
    </Tag>
    </Button>
  </Popover>
}
