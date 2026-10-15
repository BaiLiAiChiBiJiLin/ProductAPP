import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TransferBatchModal from '../src/modules/schematic/components/TransferBatchModal'
import BatchHistoryPanel from '../src/modules/schematic/history/BatchHistoryPanel'

const api = vi.hoisted(() => ({ users: vi.fn(), preview: vi.fn(), refresh: vi.fn(), list: vi.fn(), send: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../src/modules/schematic/services/sharedTransferService', () => ({
  currentSharedUser: () => '接收用户', sharedTransferDirectory: async () => '测试共享目录',
  listTransferUsers: api.users, previewBatchTransfer: api.preview, refreshSharedTransfers: api.refresh, sendBatchTransfer: api.send,
}))
vi.mock('../src/modules/schematic/services/batchHistoryService', () => ({ listHistoryBatches: api.list, deleteHistoryBatch: vi.fn() }))
vi.mock('../src/modules/schematic/history/BatchHistoryPreview', () => ({ default: () => null }))

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(query => ({ matches: false, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const style = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => style(element))
})
beforeEach(() => {
  api.users.mockReset().mockResolvedValue(['接收用户'])
  api.preview.mockReset().mockResolvedValue({ assetCount: 2, reviewCount: 3, jobCount: 1 })
  api.refresh.mockReset().mockResolvedValue({ imported: 0, finalized: 0, errors: [] })
  api.send.mockReset()
  api.list.mockReset().mockResolvedValue({ records: [{ id: 'old', customerName: '本地批次', assetCount: 2, savedAt: '2026-10-14T01:00:00Z' }], total: 1, page: 1, pageSize: 12 })
})
afterEach(cleanup)

async function chooseRecipient() {
  fireEvent.mouseDown(await screen.findByRole('combobox', { name: '接收用户' }))
  fireEvent.click(await screen.findByTitle('接收用户'))
}
const modalProps = { open: true, userName: '发送用户', batchId: 'batch-a', batchName: '测试批次', assetCount: 2, onCancel: vi.fn() }
const historyProps = { active: true, openingId: null, progress: { completed: 0, total: 0 }, onOpen: vi.fn(), userName: '接收用户' }

test('history card right-click transfers its saved batch without opening artwork and reloads related lists', async () => {
  let finish!: (result: { recipient: string }) => void
  api.send.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const open = vi.fn(), changed = vi.fn(), busy = vi.fn()
  render(<BatchHistoryPanel {...historyProps} userName="发送用户" onOpen={open} onSharedRecordsChanged={changed} onTransferringChange={busy}/>)
  fireEvent.contextMenu(await screen.findByRole('button', { name: '打开批次 本地批次' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '转移' }))
  await chooseRecipient()
  expect(open).not.toHaveBeenCalled()
  expect(api.preview).toHaveBeenCalledWith('old')
  expect(screen.getByText('审核 3 条')).toBeTruthy()
  expect(screen.getByText('生产拼版 1 条')).toBeTruthy()
  expect(screen.queryByText(/确认后先保存当前批次/)).toBeNull()
  const confirm = screen.getByRole('button', { name: '确认转移' })
  fireEvent.click(confirm); fireEvent.click(confirm)
  expect(api.send).toHaveBeenCalledTimes(1)
  expect(api.send).toHaveBeenCalledWith('old', '发送用户', '接收用户')
  expect(busy).toHaveBeenLastCalledWith(true)
  api.list.mockResolvedValue({ records: [], total: 0, page: 1, pageSize: 12 })
  await act(async () => finish({ recipient: '接收用户' }))
  expect(await screen.findByText('暂无记录')).toBeTruthy()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(changed).toHaveBeenCalledTimes(1)
  expect(busy).toHaveBeenLastCalledWith(false)
  expect(open).not.toHaveBeenCalled()
})

test('history transfer failure keeps the dialog error and releases busy state before returning to history', async () => {
  api.send.mockRejectedValue('共享目录不可用')
  const open = vi.fn(), busy = vi.fn()
  render(<BatchHistoryPanel {...historyProps} onOpen={open} onTransferringChange={busy}/>)
  fireEvent.contextMenu(await screen.findByRole('button', { name: '打开批次 本地批次' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '转移' }))
  await chooseRecipient()
  fireEvent.click(screen.getByRole('button', { name: '确认转移' }))
  expect(await screen.findByText(/转移未完成.*共享目录不可用/)).toBeTruthy()
  expect(busy).toHaveBeenLastCalledWith(false)
  fireEvent.click(screen.getByRole('button', { name: /^取\s*消$/ }))
  expect(await screen.findByRole('button', { name: '打开批次 本地批次' })).toBeTruthy()
  expect(open).not.toHaveBeenCalled()
})

test('transfer previews linked records and a rapid double click sends only once', async () => {
  let finish!: () => void
  const transfer = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  render(<TransferBatchModal {...modalProps} onTransfer={transfer}/>)
  await chooseRecipient()
  expect(screen.getByText('审核 3 条')).toBeTruthy()
  expect(screen.getByText('生产拼版 1 条')).toBeTruthy()
  const confirm = screen.getByRole('button', { name: '确认转移' })
  fireEvent.click(confirm); fireEvent.click(confirm)
  expect(transfer).toHaveBeenCalledTimes(1)
  expect(transfer).toHaveBeenCalledWith('接收用户')
  expect((screen.getByRole('button', { name: /^取\s*消$/ }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => finish())
})

test('send failure stays in the dialog and allows refreshing before another attempt', async () => {
  const cancel = vi.fn()
  render(<TransferBatchModal {...modalProps} onCancel={cancel} onTransfer={vi.fn().mockRejectedValue('共享连接中断')}/>)
  await chooseRecipient()
  fireEvent.click(screen.getByRole('button', { name: '确认转移' }))
  expect(await screen.findByText(/转移未完成.*共享连接中断/)).toBeTruthy()
  expect(cancel).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '刷新用户列表' }))
  await waitFor(() => expect(api.users).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByText(/转移未完成/)).toBeNull())
})

test('refresh imports once, reloads local history and invalidates related module lists', async () => {
  let complete!: (value: { imported: number; finalized: number; errors: string[] }) => void
  api.refresh.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const changed = vi.fn()
  render(<BatchHistoryPanel {...historyProps} onSharedRecordsChanged={changed}/>)
  await screen.findByRole('button', { name: '打开批次 本地批次' })
  const refresh = screen.getByRole('button', { name: /^刷\s*新$/ })
  fireEvent.click(refresh); fireEvent.click(refresh)
  expect(api.refresh).toHaveBeenCalledTimes(1)
  api.list.mockResolvedValue({ records: [{ id: 'received', customerName: '接收批次', assetCount: 2, savedAt: '2026-10-14T01:00:00Z' }], total: 1, page: 1, pageSize: 12 })
  await act(async () => complete({ imported: 1, finalized: 0, errors: [] }))
  await screen.findByRole('button', { name: '打开批次 接收批次' })
  expect(changed).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: /^刷\s*新$/ }))
  await screen.findByText('刷新完成，暂无新的转移数据。')
  expect(changed).toHaveBeenCalledTimes(1)
  expect(screen.getAllByRole('button', { name: /^打开批次/ })).toHaveLength(1)
})

test('network failure keeps local batches available for opening', async () => {
  api.refresh.mockRejectedValue('无法访问共享目录')
  const open = vi.fn()
  render(<BatchHistoryPanel {...historyProps} onOpen={open}/>)
  await screen.findByRole('button', { name: '打开批次 本地批次' })
  fireEvent.click(screen.getByRole('button', { name: /^刷\s*新$/ }))
  expect(await screen.findByText(/共享数据接收失败.*本地历史记录仍可使用/)).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: '打开批次 本地批次' }))
  expect(open).toHaveBeenCalledTimes(1)
  expect(api.list).toHaveBeenCalledTimes(2)
})
