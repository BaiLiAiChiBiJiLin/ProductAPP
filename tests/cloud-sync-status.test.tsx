import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
const queue = vi.hoisted(() => ({ cloudSyncTasks: vi.fn(), flushCloudSyncQueue: vi.fn() }))
vi.mock('../src/services/cloudSyncQueue', () => queue)
import CloudSyncStatusTag from '../src/components/CloudSyncStatusTag'

afterEach(() => { cleanup(); vi.resetAllMocks() })

test('opens the failed batch and offers one immediate retry while preventing duplicate clicks', async () => {
  let finish!: () => void
  queue.cloudSyncTasks.mockReturnValue([{ id: 'b', name: '测试批次', operation: 'save_batch', assetCount: 2, state: 'error', attempts: 1, blocked: false,
    error: '连接暂不可用', action: '连接恢复后自动重试', nextAttemptAt: Date.now() + 5_000 }])
  queue.flushCloudSyncQueue.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  render(<CloudSyncStatusTag status={{ state: 'error', pending: 1, error: '连接暂不可用' }}/>)
  fireEvent.click(screen.getByRole('button', { name: '查看后台同步任务' }))
  expect(await screen.findByText('测试批次')).toBeTruthy()
  expect(screen.getByText(/秒后自动重试/)).toBeTruthy()
  const retry = screen.getByRole('button', { name: '立即重试' })
  fireEvent.click(retry); fireEvent.click(retry)
  expect(queue.flushCloudSyncQueue).toHaveBeenCalledTimes(1)
  expect(queue.flushCloudSyncQueue).toHaveBeenCalledWith('b')
  finish()
  await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false))
})

test('blocked conflicts explain the required action rather than promising automatic recovery', async () => {
  queue.cloudSyncTasks.mockReturnValue([{ id: 'b', name: '冲突批次', operation: 'save_batch', assetCount: 1, state: 'blocked', attempts: 1, blocked: true,
    error: '记录已被其他用户修改', action: '请核对云端内容，本地修改已保留。' }])
  render(<CloudSyncStatusTag status={{ state: 'blocked', pending: 1, error: '记录已被其他用户修改' }}/>)
  expect(screen.getByRole('status').textContent).toBe('同步待处理 · 1 项')
  fireEvent.click(screen.getByRole('button', { name: '查看后台同步任务' }))
  expect(await screen.findByText('请核对云端内容，本地修改已保留。')).toBeTruthy()
  expect(screen.queryByText(/秒后自动重试/)).toBeNull()
})

test('a failed deletion directs the user to retry deletion instead of resurrecting the saved batch', async () => {
  queue.cloudSyncTasks.mockReturnValue([{ id: 'b', name: '待删除批次', operation: 'delete_batch', assetCount: 1, state: 'blocked', attempts: 1, blocked: true, deletionRequested: true,
    action: '删除尚未完成，请在历史记录中重试删除。' }])
  render(<CloudSyncStatusTag status={{ state: 'blocked', pending: 1 }}/>)
  fireEvent.click(screen.getByRole('button', { name: '查看后台同步任务' }))
  expect(await screen.findByText('删除尚未完成，请在历史记录中重试删除。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '立即重试' })).toBeNull()
})

test('a queue persistence error remains visible even when it cannot be written to the task', async () => {
  queue.cloudSyncTasks.mockReturnValue([{ id: 'b', name: '待保存批次', operation: 'save_batch', assetCount: 1, state: 'queued', attempts: 0, blocked: false }])
  render(<CloudSyncStatusTag status={{ state: 'blocked', pending: 1, error: '本地同步队列写入失败，请保留当前页面' }}/>)
  fireEvent.click(screen.getByRole('button', { name: '查看后台同步任务' }))
  expect(await screen.findByText('本地同步队列写入失败，请保留当前页面')).toBeTruthy()
})

test('a storage initialization failure is visible before the task count can be loaded', async () => {
  queue.cloudSyncTasks.mockReturnValue([])
  render(<CloudSyncStatusTag status={{ state: 'blocked', pending: 0, error: '本地同步记录格式无效，原数据已保留' }}/>)
  expect(screen.getByRole('status').textContent).toBe('同步存储待处理')
  fireEvent.click(screen.getByRole('button', { name: '查看后台同步任务' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '本地同步记录格式无效，原数据已保留')
})

test('identifies each task by full batch ID, operation, image count and its own status', async () => {
  const failedId = 'batch-12345678-1111-2222-3333-444444444444'
  const syncingId = 'batch-12345678-1111-2222-3333-555555555555'
  const deletingId = 'batch-12345678-1111-2222-3333-666666666666'
  queue.cloudSyncTasks.mockReturnValue([
    { id: failedId, name: '同名客户', customerName: '同名客户', operation: 'save_batch', assetCount: 12,
      state: 'blocked', attempts: 2, blocked: true, error: '无法保存本地云端同步日志' },
    { id: syncingId, name: '同名客户', customerName: '同名客户', operation: 'save_batch', assetCount: 3,
      state: 'syncing', attempts: 0, blocked: false },
    { id: deletingId, name: '待删除客户', customerName: '待删除客户', operation: 'delete_batch', assetCount: 1,
      state: 'blocked', attempts: 0, blocked: true, deletionRequested: true, error: '删除未完成' },
  ])
  render(<CloudSyncStatusTag status={{ state: 'syncing', pending: 3, error: '无法保存本地云端同步日志' }}/>)
  fireEvent.click(screen.getByRole('button', { name: '查看后台同步任务' }))
  const failed = within(await screen.findByRole('region', { name: `批次 ${failedId} 的同步任务` }))
  expect(failed.getByText(failedId)).toBeTruthy()
  expect(failed.getByText('同名客户')).toBeTruthy()
  expect(failed.getByText('保存批次')).toBeTruthy()
  expect(failed.getByText('12 张')).toBeTruthy()
  expect(failed.getByText('需要处理')).toBeTruthy()
  expect(failed.getByRole('alert').textContent).toContain('无法保存本地云端同步日志')
  const syncing = within(screen.getByRole('region', { name: `批次 ${syncingId} 的同步任务` }))
  expect(syncing.getByText(syncingId)).toBeTruthy()
  expect(syncing.getByText('正在同步')).toBeTruthy()
  expect(syncing.getByText('3 张')).toBeTruthy()
  expect(syncing.queryByRole('alert')).toBeNull()
  const deleting = within(screen.getByRole('region', { name: `批次 ${deletingId} 的同步任务` }))
  expect(deleting.getByText('删除批次')).toBeTruthy()
  expect(deleting.getByText('删除待处理')).toBeTruthy()
  expect(deleting.queryByRole('button', { name: '立即重试' })).toBeNull()
})

test('keeps a manual retry failure inside the selected batch when persistence fails', async () => {
  queue.cloudSyncTasks.mockReturnValue([
    { id: 'first', name: '客户甲', operation: 'save_batch', assetCount: 2, state: 'queued', attempts: 0, blocked: false },
    { id: 'second', name: '客户乙', operation: 'save_batch', assetCount: 5, state: 'queued', attempts: 0, blocked: false },
  ])
  queue.flushCloudSyncQueue.mockRejectedValue(new Error('本地同步队列写入失败'))
  render(<CloudSyncStatusTag status={{ state: 'queued', pending: 2 }}/>)
  fireEvent.click(screen.getByRole('button', { name: '查看后台同步任务' }))
  const first = within(await screen.findByRole('region', { name: '批次 first 的同步任务' }))
  const second = within(screen.getByRole('region', { name: '批次 second 的同步任务' }))
  fireEvent.click(second.getByRole('button', { name: '立即重试' }))
  expect(queue.flushCloudSyncQueue).toHaveBeenCalledWith('second')
  expect(await second.findByRole('alert')).toHaveProperty('textContent', '失败原因：本地同步队列写入失败')
  expect(second.getByText('重试失败')).toBeTruthy()
  expect(first.queryByRole('alert')).toBeNull()
})
