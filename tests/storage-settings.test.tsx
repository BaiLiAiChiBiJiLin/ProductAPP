vi.mock('../src/services/backend', async () => { const core = await import('@tauri-apps/api/core'); return { invoke: core.invoke, storageMode: async () => ({ shared: false }) } })
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SettingsModal from '../src/modules/settings/SettingsModal'
import { initialBundle } from '../src/modules/settings/product-options/service'
import { clone } from '../src/modules/settings/product-options/model'

const api = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: api.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: api.open }))
const defaults = { historyDirectory: 'D:\\PrintFlow\\printflow-data\\assets', defaultHistoryDirectory: 'D:\\PrintFlow\\printflow-data\\assets' }

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getComputedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
})
beforeEach(() => {
  api.invoke.mockReset().mockResolvedValue(defaults)
  api.open.mockReset()
})
afterEach(cleanup)

test('loads Rust settings, chooses a native folder, and only persists on save', async () => {
  const close = vi.fn()
  render(<SettingsModal open onClose={close}/>)
  const input = await screen.findByLabelText('历史记录保存目录') as HTMLInputElement
  expect(input.value).toBe(defaults.historyDirectory)
  api.open.mockResolvedValue('E:\\客户批次')
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
  await waitFor(() => expect(input.value).toBe('E:\\客户批次'))
  expect(api.open).toHaveBeenCalledWith({ directory: true, multiple: false, title: '选择历史记录保存目录', defaultPath: defaults.historyDirectory })
  expect(api.invoke).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))
  await screen.findByText('历史记录保存目录已保存')
  expect(close).not.toHaveBeenCalled()
  expect(api.invoke).toHaveBeenLastCalledWith('save_storage_settings', { directory: 'E:\\客户批次' })
})

test('backdrop and Escape do not close settings; X closes without saving a draft', async () => {
  const close = vi.fn()
  render(<SettingsModal open onClose={close}/>)
  const input = await screen.findByLabelText('历史记录保存目录') as HTMLInputElement
  api.open.mockResolvedValue(null)
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
  await waitFor(() => expect((screen.getByRole('button', { name: /^保\s*存$/ }) as HTMLButtonElement).disabled).toBe(false))
  expect(input.value).toBe(defaults.historyDirectory)
  fireEvent.change(input, { target: { value: 'E:\\不保存' } })
  fireEvent.click(document.querySelector('.ant-modal-wrap')!)
  fireEvent.keyDown(document.querySelector('.ant-modal-wrap')!, { key: 'Escape', keyCode: 27 })
  expect(close).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /^取\s*消$/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(close).toHaveBeenCalledOnce()
  expect(api.invoke).toHaveBeenCalledTimes(1)
})

test('restore default is a draft, failed save stays open, and saving blocks duplicate submissions', async () => {
  api.invoke.mockResolvedValue({ ...defaults, historyDirectory: 'E:\\当前目录' })
  const close = vi.fn()
  render(<SettingsModal open onClose={close}/>)
  const input = await screen.findByLabelText('历史记录保存目录') as HTMLInputElement
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
  expect(input.value).toBe(defaults.defaultHistoryDirectory)
  expect(api.invoke).toHaveBeenCalledTimes(1)
  let reject!: (reason: string) => void
  api.invoke.mockImplementationOnce(() => new Promise((_, failed) => { reject = failed }))
  const save = screen.getByRole('button', { name: /^保\s*存$/ })
  fireEvent.click(save)
  fireEvent.click(save)
  expect((screen.getByRole('button', { name: '正在保存…' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  expect(api.invoke).toHaveBeenCalledTimes(2)
  await act(async () => reject('保存目录不可写'))
  expect(screen.getByRole('alert').textContent).toContain('保存目录不可写')
  expect(close).not.toHaveBeenCalled()
  expect(input.value).toBe(defaults.defaultHistoryDirectory)
})

test('settings load failure offers retry without an enabled save button', async () => {
  api.invoke.mockRejectedValueOnce('数据库暂不可用')
  render(<SettingsModal open onClose={vi.fn()}/>)
  expect((await screen.findByRole('alert')).textContent).toContain('数据库暂不可用')
  expect((screen.getByRole('button', { name: /^保\s*存$/ }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /^重\s*试$/ }))
  expect((await screen.findByLabelText('历史记录保存目录') as HTMLInputElement).value).toBe(defaults.historyDirectory)
})

test('switching settings sections retains both drafts; product saving locks navigation and X', async () => {
  api.invoke.mockImplementation(async command => command === 'load_product_option_settings' ? { bundle: clone(initialBundle), version: 'v1', directory: 'D:\\settings' } : defaults)
  render(<SettingsModal open onClose={vi.fn()}/> )
  fireEvent.change(await screen.findByLabelText('历史记录保存目录'), { target: { value: 'E:\\目录草稿' } })
  const productTab = screen.getByRole('button', { name: '产品选项配置' })
  fireEvent.click(productTab)
  fireEvent.change(await screen.findByLabelText('产品中文名', {}, { timeout: 5000 }), { target: { value: '产品草稿' } })
  const storageTab = screen.getByRole('button', { name: '历史记录保存目录' })
  fireEvent.click(storageTab)
  expect((screen.getByLabelText('历史记录保存目录') as HTMLInputElement).value).toBe('E:\\目录草稿')
  fireEvent.click(productTab)
  expect((screen.getByLabelText('产品中文名') as HTMLInputElement).value).toBe('产品草稿')
  let reject!: (reason: string) => void
  api.invoke.mockImplementationOnce(() => new Promise((_, failed) => { reject = failed }))
  fireEvent.click(screen.getByRole('button', { name: /保\s*存$/ }))
  expect((storageTab as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  await act(async () => reject('产品配置保存失败'))
  expect(screen.getByRole('alert').textContent).toContain('产品配置保存失败')
  expect((storageTab as HTMLButtonElement).disabled).toBe(false)
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
})

test('shared storage is read only and migration is an explicit resumable action', async () => {
  api.invoke.mockImplementation(async command => {
    if (command === 'load_storage_settings') return { ...defaults, shared: true, configPath: 'D:/PrintFlow/printflow-data/config.toml' }
    if (command === 'preview_cloud_migration') return { batches: 2, reviews: 3, jobs: 1, pendingTransfers: 0 }
    if (command === 'migrate_local_data') return { imported: 4, skipped: 1, errors: ['review broken: source missing'] }
    throw new Error(command)
  })
  render(<SettingsModal open onClose={() => {}}/>)
  const input = await screen.findByLabelText('历史记录保存目录') as HTMLInputElement
  expect(input.disabled).toBe(true)
  expect(screen.queryByRole('button', { name: '选择文件夹' })).toBeNull()
  expect(screen.queryByRole('button', { name: /^保\s*存$/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '检查本机旧数据' }))
  const migrate = await screen.findByRole('button', { name: '迁移数据' })
  expect(api.invoke.mock.calls.some(([command]) => command === 'migrate_local_data')).toBe(false)
  fireEvent.click(migrate)
  expect(await screen.findByText(/已迁移 4 条/)).toBeTruthy()
  expect(await screen.findByText(/review broken: source missing/)).toBeTruthy()
  await waitFor(() => expect((screen.getByRole('button', { name: /迁移数据/ }) as HTMLButtonElement).disabled).toBe(false))
})
