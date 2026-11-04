import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import BatchHistoryPanel from '../src/modules/schematic/history/BatchHistoryPanel'
import { loadHistoryBatch } from '../src/modules/schematic/services/batchHistoryService'
import { clearCloudBatchSave, enqueueCloudBatchSave, flushCloudSyncQueue } from '../src/services/cloudSyncQueue'

const api = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/services/backend', () => ({ invoke: api.invoke, storageMode: async () => ({ shared: true }) }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../src/modules/schematic/history/BatchHistoryPreview', () => ({ default: () => null }))

const record = { id: 'pending-batch', customerName: '待同步客户', assetCount: 1, savedAt: '2026-11-02T01:00:00Z' }
let finishSave: (() => void) | undefined
let rejectSave: ((reason: string) => void) | undefined
let exists = true

beforeEach(() => {
  localStorage.clear()
  api.invoke.mockReset()
  exists = true
  finishSave = undefined
  rejectSave = undefined
  api.invoke.mockImplementation((command: string, args?: { id: string }) => {
    if (command === 'save_batch') return new Promise((resolve, reject) => {
      finishSave = () => { if (args?.id === record.id) exists = true; resolve({ batchId: args?.id, assets: [] }) }
      rejectSave = reject
    })
    if (command === 'list_batches') return Promise.resolve({ records: exists ? [record] : [], total: exists ? 1 : 0, page: 1, pageSize: 12 })
    if (command === 'delete_batch') { exists = false; return Promise.resolve(undefined) }
    if (command === 'list_shared_transfer_users') return Promise.resolve(['接收用户'])
    if (command === 'preview_shared_batch_transfer') return Promise.resolve({ shared: true, assetCount: 1, reviewCount: 0, jobCount: 0 })
    if (command === 'send_shared_batch') { exists = false; return Promise.resolve({ shared: true, recipient: '接收用户' }) }
    return Promise.resolve(undefined)
  })
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) })
})

afterEach(async () => {
  cleanup()
  clearCloudBatchSave(record.id)
  clearCloudBatchSave('other-batch')
  finishSave?.()
  await flushCloudSyncQueue().catch(() => {})
  localStorage.clear()
})

async function beginOperation(operation: 'delete' | 'transfer', queuedId = record.id) {
  enqueueCloudBatchSave({ id: queuedId, savedAt: 'now', assets: [{ id: 'asset', attributes: { QT: '25' } }] })
  await waitFor(() => expect(finishSave).toBeDefined())
  render(<BatchHistoryPanel active openingId={null} progress={{ completed: 0, total: 0 }} onOpen={vi.fn()} userName="发送用户"/>)
  const open = await screen.findByRole('button', { name: '打开批次 待同步客户' })
  if (operation === 'delete') fireEvent.click(screen.getByRole('button', { name: '删除批次 待同步客户' }))
  else {
    fireEvent.contextMenu(open)
    fireEvent.click(await screen.findByRole('menuitem', { name: '转移' }))
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: '接收用户' }))
    fireEvent.click(await screen.findByTitle('接收用户'))
    fireEvent.click(screen.getByRole('button', { name: '确认转移' }))
  }
}

test.each(['delete', 'transfer'] as const)('%s waits for pending saves so a late upload cannot restore the old batch', async operation => {
  await beginOperation(operation)
  const command = operation === 'delete' ? 'delete_batch' : 'send_shared_batch'
  expect(api.invoke.mock.calls.some(call => call[0] === command)).toBe(false)
  await act(async () => { finishSave?.(); await flushCloudSyncQueue() })
  await waitFor(() => expect(api.invoke.mock.calls.some(call => call[0] === command)).toBe(true))
  expect(exists).toBe(false)
  expect(await screen.findByText('暂无记录')).toBeTruthy()
})

test.each(['transfer'] as const)('%s preserves the batch and pending edits when synchronization fails', async operation => {
  await beginOperation(operation)
  await act(async () => { rejectSave?.('共享连接中断') })
  await screen.findByText(/转移未完成.*共享连接中断/)
  expect(api.invoke.mock.calls.some(call => call[0] === 'send_shared_batch')).toBe(false)
  expect(exists).toBe(true)
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('"QT":"25"')
})

test('deletes a batch even when its pending upload has a missing SVG source', async () => {
  await beginOperation('delete')
  await act(async () => { rejectSave?.('图片 测试对象 · _2879494436960 的源文件不可访问') })
  await waitFor(() => expect(api.invoke).toHaveBeenCalledWith('delete_batch', { id: record.id }))
  expect(exists).toBe(false)
  expect(await screen.findByText('暂无记录')).toBeTruthy()
  expect(JSON.parse(localStorage.getItem('printflow-cloud-sync-queue-v1') ?? '[]')).toEqual([])
})

test('deletion does not wait for an unrelated batch upload', async () => {
  await beginOperation('delete', 'other-batch')
  await waitFor(() => expect(api.invoke).toHaveBeenCalledWith('delete_batch', { id: record.id }))
  expect(exists).toBe(false)
  expect(await screen.findByText('暂无记录')).toBeTruthy()
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('other-batch')
  await act(async () => { rejectSave?.('图片 其他批次 的源文件不可访问') })
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('other-batch')
})

test('keeps the pending edits and history card when deletion itself fails', async () => {
  const original = api.invoke.getMockImplementation()!
  api.invoke.mockImplementation((command: string, args?: { id: string }) => command === 'delete_batch'
    ? Promise.reject(new Error('没有删除权限')) : original(command, args))
  await beginOperation('delete')
  await act(async () => { rejectSave?.('图片 测试对象 · _2879494436960 的源文件不可访问') })
  await screen.findByText(/删除失败.*没有删除权限/)
  expect(exists).toBe(true)
  expect(screen.getByRole('button', { name: '删除批次 待同步客户' })).toBeTruthy()
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('"QT":"25"')
})

test('opening a healthy history batch is not blocked by another batch with a missing pending SVG source', async () => {
  const original = api.invoke.getMockImplementation()!
  const saved = { id: 'healthy-batch', savedAt: '2026-11-04', assets: [{ id: 'healthy-asset', name: '正常图片', svg: '', storagePath: 'printflow:healthy-asset' }] }
  api.invoke.mockImplementation((command: string, args?: { id: string }) => {
    if (command === 'load_batch') return Promise.resolve(saved)
    if (command === 'load_batch_asset_svg') return Promise.resolve(new TextEncoder().encode('<svg/>').buffer)
    return original(command, args)
  })
  enqueueCloudBatchSave({ id: record.id, savedAt: 'now', assets: [{ id: 'missing-asset', name: '尺寸 · __printflow_measure_0', storagePath: 'temp-assets/missing.svg', attributes: { QT: '25' } }] })
  await waitFor(() => expect(rejectSave).toBeDefined())
  const loading = loadHistoryBatch(saved.id)
  const loaded = expect(loading).resolves.toEqual({ ...saved, assets: [{ ...saved.assets[0], svg: '<svg/>' }] })
  rejectSave?.('图片 尺寸 · __printflow_measure_0 的源文件不可访问')
  await loaded
  expect(api.invoke).toHaveBeenCalledWith('load_batch', { id: saved.id })
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('missing-asset')
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('"QT":"25"')
})

test('opening a different history batch does not wait for an unrelated upload still in flight', async () => {
  const original = api.invoke.getMockImplementation()!
  const saved = { id: 'healthy-batch', savedAt: '2026-11-04', assets: [] }
  api.invoke.mockImplementation((command: string, args?: { id: string }) => command === 'load_batch' ? Promise.resolve(saved) : original(command, args))
  enqueueCloudBatchSave({ id: record.id, savedAt: 'now', assets: [{ id: 'asset', storagePath: 'temp-assets/asset.svg' }] })
  await waitFor(() => expect(finishSave).toBeDefined())
  const received = vi.fn()
  const loading = loadHistoryBatch(saved.id).then(received, received)
  try {
    await waitFor(() => expect(received).toHaveBeenCalledWith(saved))
    expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain(record.id)
  } finally {
    finishSave?.()
    await loading
  }
})

test('transfer is not blocked by an unrelated pending upload with a missing SVG source', async () => {
  await beginOperation('transfer', 'other-batch')
  await act(async () => { rejectSave?.('图片 其他批次 的源文件不可访问') })
  await waitFor(() => expect(api.invoke.mock.calls.some(call => call[0] === 'send_shared_batch')).toBe(true))
  expect(exists).toBe(false)
  expect(await screen.findByText('暂无记录')).toBeTruthy()
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('other-batch')
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('"QT":"25"')
})

test('opening the same batch preserves failed pending changes instead of loading stale cloud data', async () => {
  enqueueCloudBatchSave({ id: record.id, savedAt: 'now', assets: [{ id: 'asset', storagePath: 'temp-assets/missing.svg', attributes: { QT: '25' } }] })
  await waitFor(() => expect(rejectSave).toBeDefined())
  const loading = expect(loadHistoryBatch(record.id)).rejects.toThrow('源文件不可访问')
  rejectSave?.('图片 当前批次 的源文件不可访问')
  await loading
  expect(api.invoke.mock.calls.some(call => call[0] === 'load_batch')).toBe(false)
  expect(localStorage.getItem('printflow-cloud-sync-queue-v1')).toContain('"QT":"25"')
})
