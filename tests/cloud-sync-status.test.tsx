import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const queue = vi.hoisted(() => ({ cloudSyncTasks: vi.fn(), flushCloudSyncQueue: vi.fn() }))
vi.mock('../src/services/cloudSyncQueue', () => queue)
import CloudSyncStatusTag from '../src/components/CloudSyncStatusTag'

afterEach(() => { cleanup(); vi.resetAllMocks() })

test('opens the failed batch and offers one immediate retry while preventing duplicate clicks', async () => {
  let finish!: () => void
  queue.cloudSyncTasks.mockReturnValue([{ id: 'b', name: '测试批次', attempts: 1, blocked: false,
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
  queue.cloudSyncTasks.mockReturnValue([{ id: 'b', name: '冲突批次', attempts: 1, blocked: true,
    error: '记录已被其他用户修改', action: '请核对云端内容，本地修改已保留。' }])
  render(<CloudSyncStatusTag status={{ state: 'blocked', pending: 1, error: '记录已被其他用户修改' }}/>)
  expect(screen.getByRole('status').textContent).toBe('同步待处理 · 1 项')
  fireEvent.click(screen.getByRole('button', { name: '查看后台同步任务' }))
  expect(await screen.findByText('请核对云端内容，本地修改已保留。')).toBeTruthy()
  expect(screen.queryByText(/秒后自动重试/)).toBeNull()
})

test('a failed deletion directs the user to retry deletion instead of resurrecting the saved batch', async () => {
  queue.cloudSyncTasks.mockReturnValue([{ id: 'b', name: '待删除批次', attempts: 1, blocked: true, deletionRequested: true,
    action: '删除尚未完成，请在历史记录中重试删除。' }])
  render(<CloudSyncStatusTag status={{ state: 'blocked', pending: 1 }}/>)
  fireEvent.click(screen.getByRole('button', { name: '查看后台同步任务' }))
  expect(await screen.findByText('删除尚未完成，请在历史记录中重试删除。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '立即重试' })).toBeNull()
})

test('a queue persistence error remains visible even when it cannot be written to the task', async () => {
  queue.cloudSyncTasks.mockReturnValue([{ id: 'b', name: '待保存批次', attempts: 0, blocked: false }])
  render(<CloudSyncStatusTag status={{ state: 'blocked', pending: 1, error: '本地同步队列写入失败，请保留当前页面' }}/>)
  fireEvent.click(screen.getByRole('button', { name: '查看后台同步任务' }))
  expect(await screen.findByText('本地同步队列写入失败，请保留当前页面')).toBeTruthy()
})
