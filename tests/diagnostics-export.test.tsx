import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({ nativeInvoke: vi.fn(), save: vi.fn(), flush: vi.fn(), mode: vi.fn(), tasks: vi.fn(), storage: vi.fn(), eventStatus: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: api.nativeInvoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: api.save, open: vi.fn() }))
vi.mock('../src/services/backend', () => ({ invoke: api.storage, storageMode: api.mode }))
vi.mock('../src/services/cloudSyncQueue', () => ({ cloudSyncTasks: api.tasks }))
vi.mock('../src/services/diagnosticEvents', () => ({ flushDiagnosticEvents: api.flush, diagnosticEventStatus: api.eventStatus }))
import SettingsModal from '../src/modules/settings/SettingsModal'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) })
})
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  api.storage.mockReset().mockResolvedValue({ historyDirectory: 'D:\\history', defaultHistoryDirectory: 'D:\\history' })
  api.save.mockReset().mockResolvedValue('D:\\support.zip')
  api.nativeInvoke.mockReset().mockResolvedValue({ path: 'D:\\support.zip', bytes: 1024, warnings: [] })
  api.mode.mockReset().mockResolvedValue({ shared: true, environment: 'production', configPath: 'private-config-path' })
  api.tasks.mockReset().mockReturnValue([])
  api.flush.mockReset().mockResolvedValue(undefined)
  api.eventStatus.mockReset().mockReturnValue({ pending: 0, failed: 0, dropped: 0 })
})
afterEach(() => { cleanup(); localStorage.clear() })

async function openDiagnostics(onClose = vi.fn()) {
  render(<SettingsModal open onClose={onClose}/>)
  fireEvent.click(screen.getByRole('button', { name: '诊断与反馈' }))
  return screen.getByRole('button', { name: '导出诊断包' })
}

test('exports a sanitized local diagnostic bundle even when cloud settings are unavailable', async () => {
  api.storage.mockRejectedValue(new Error('云数据库连接失败'))
  api.mode.mockRejectedValue(new Error('config password=do-not-export'))
  localStorage.setItem('printflow-account-name', '员工甲')
  api.tasks.mockReturnValue([{ id: 'batch-1', operation: 'save_batch', state: 'blocked', attempts: 843, assetCount: 28, blocked: true,
    error: '记录已被其他用户修改 password=do-not-export', customerName: '不导出的客户名', svg: '<svg>do-not-export</svg>' }])
  api.nativeInvoke.mockResolvedValue({ path: 'D:\\support.zip', bytes: 2048, warnings: ['部分本地记录暂不可用'] })
  fireEvent.click(await openDiagnostics())
  await screen.findByText('诊断包已导出')
  expect(screen.getByText('D:\\support.zip')).toBeTruthy()
  expect(screen.getByText('文件大小：2 KB')).toBeTruthy()
  expect(screen.getByText('部分本地记录暂不可用')).toBeTruthy()
  expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ filters: [{ name: 'ZIP 压缩文件', extensions: ['zip'] }] }))
  expect(api.flush).toHaveBeenCalledOnce()
  expect(api.nativeInvoke).toHaveBeenCalledExactlyOnceWith('export_diagnostic_bundle', {
    path: 'D:\\support.zip', context: {
      userName: '员工甲',
      tasks: [{ id: 'batch-1', operation: 'save_batch', state: 'blocked', attempts: 843, assetCount: 28, blocked: true, deletionRequested: false, errorKind: 'conflict', retryable: false }],
      warnings: ['存储模式暂不可用，已导出其他诊断信息。'], diagnosticEvents: { pending: 0, failed: 0, dropped: 0 },
    },
  })
  expect(JSON.stringify(api.nativeInvoke.mock.calls)).not.toContain('do-not-export')
  expect(JSON.stringify(api.nativeInvoke.mock.calls)).not.toContain('不导出的客户名')
  expect(api.flush.mock.invocationCallOrder[0]).toBeLessThan(api.nativeInvoke.mock.invocationCallOrder[0])
})

test('cancelling the save dialog leaves diagnostics unexported without a success message', async () => {
  api.save.mockResolvedValue(null)
  fireEvent.click(await openDiagnostics())
  await waitFor(() => expect((screen.getByRole('button', { name: '导出诊断包' }) as HTMLButtonElement).disabled).toBe(false))
  expect(api.nativeInvoke).not.toHaveBeenCalled()
  expect(api.flush).not.toHaveBeenCalled()
  expect(screen.queryByText('诊断包已导出')).toBeNull()
})

test('exporting prevents duplicate requests and locks settings navigation and closing', async () => {
  let finish!: (result: unknown) => void
  api.nativeInvoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const close = vi.fn()
  const button = await openDiagnostics(close)
  fireEvent.click(button); fireEvent.click(button)
  await waitFor(() => expect(api.nativeInvoke).toHaveBeenCalledOnce())
  expect(api.save).toHaveBeenCalledOnce()
  expect((screen.getByRole('button', { name: '历史记录保存目录' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  fireEvent.click(document.querySelector('.ant-modal-wrap')!)
  expect(close).not.toHaveBeenCalled()
  await act(async () => finish({ path: 'D:\\support.zip', bytes: 4096, warnings: [] }))
  await screen.findByText('诊断包已导出')
  expect((screen.getByRole('button', { name: '历史记录保存目录' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
})

test('a failed export stays open and can be retried', async () => {
  api.nativeInvoke.mockRejectedValueOnce(new Error('保存位置不可写'))
  const close = vi.fn()
  fireEvent.click(await openDiagnostics(close))
  expect((await screen.findByRole('alert')).textContent).toContain('保存位置不可写')
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '导出诊断包' }))
  await screen.findByText('诊断包已导出')
  expect(api.nativeInvoke).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('诊断包导出失败：保存位置不可写')).toBeNull()
})

test('missing recent events are reported while other local diagnostics still export', async () => {
  api.eventStatus.mockReturnValue({ pending: 0, failed: 2, dropped: 1 })
  fireEvent.click(await openDiagnostics())
  await screen.findByText('诊断包已导出')
  const context = api.nativeInvoke.mock.calls[0][1].context
  expect(context.diagnosticEvents).toEqual({ pending: 0, failed: 2, dropped: 1 })
  expect(context.warnings).toContain('部分近期事件未能完整记录，已导出其他诊断信息。')
  expect(context).not.toHaveProperty('configPath')
  expect(context).not.toHaveProperty('storageRoot')
})
