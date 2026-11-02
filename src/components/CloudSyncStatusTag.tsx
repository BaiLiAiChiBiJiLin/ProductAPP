import { Tag } from 'antd'
import type { CloudSyncStatus } from '../services/cloudSyncQueue'

export default function CloudSyncStatusTag({ status }: { status: CloudSyncStatus }) {
  if (status.pending <= 0) return null
  const retrying = status.state === 'error'
  const syncing = status.state === 'syncing'
  const label = retrying ? '同步稍后重试' : syncing ? '正在同步' : '待同步'
  const countHint = `共 ${status.pending} 项批次同步任务（包含正在处理的任务），同一批次的连续修改合并为一项。`
  const title = retrying && status.error ? `${countHint}\n失败原因：${status.error}` : countHint

  return <Tag color={retrying ? 'error' : syncing ? 'processing' : 'gold'}
    role="status" aria-live="polite" aria-atomic="true" title={title}
    style={{ flexShrink: 0, whiteSpace: 'nowrap', marginInlineEnd: 0 }}>
    {label} · {status.pending} 项
  </Tag>
}
