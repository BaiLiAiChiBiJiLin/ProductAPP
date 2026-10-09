import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SettingsModal from '../src/modules/settings/SettingsModal'

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
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(api.invoke).toHaveBeenLastCalledWith('save_storage_settings', { directory: 'E:\\客户批次' })
})

test('cancelled folder selection and cancelled modal do not change persisted settings', async () => {
  const close = vi.fn()
  render(<SettingsModal open onClose={close}/>)
  const input = await screen.findByLabelText('历史记录保存目录') as HTMLInputElement
  api.open.mockResolvedValue(null)
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
  await waitFor(() => expect((screen.getByRole('button', { name: /^保\s*存$/ }) as HTMLButtonElement).disabled).toBe(false))
  expect(input.value).toBe(defaults.historyDirectory)
  fireEvent.change(input, { target: { value: 'E:\\不保存' } })
  fireEvent.click(screen.getByRole('button', { name: /^取\s*消$/ }))
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
  expect((screen.getByRole('button', { name: /^取\s*消$/ }) as HTMLButtonElement).disabled).toBe(true)
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
