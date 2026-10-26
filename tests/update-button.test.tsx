import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import UpdateButton from '../src/modules/update/UpdateButton'
import type { UpdateProgress } from '../src/modules/update/updateService'

const api = vi.hoisted(() => ({ checkForUpdate: vi.fn(), downloadAndInstallUpdate: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('../src/modules/update/updateService', () => api)

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}

async function openUpdate() {
  render(<ConfigProvider theme={{ token: { motion: false } }}><UpdateButton/></ConfigProvider>)
  fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
  return await screen.findByRole('button', { name: '下载并安装' }) as HTMLButtonElement
}

beforeEach(() => {
  api.checkForUpdate.mockReset().mockResolvedValue({ version: '0.1.30', currentVersion: '0.1.29', body: '修复更新下载' })
  api.downloadAndInstallUpdate.mockReset()
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element))
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('defers automatic update prompts while the feature tour is visible and ignores a stale check', async () => {
  vi.useFakeTimers()
  try {
    const onDialogOpenChange = vi.fn()
    let resolveCheck!: (value: { version: string; currentVersion: string }) => void
    api.checkForUpdate.mockReturnValueOnce(new Promise(resolve => { resolveCheck = resolve }))
    const view = render(<UpdateButton autoCheck showButton={false} enabled={false} onDialogOpenChange={onDialogOpenChange}/>)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(api.checkForUpdate).not.toHaveBeenCalled()
    view.rerender(<UpdateButton autoCheck showButton={false} enabled onDialogOpenChange={onDialogOpenChange}/>)
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(api.checkForUpdate).toHaveBeenCalledTimes(1)
    view.rerender(<UpdateButton autoCheck showButton={false} enabled={false} onDialogOpenChange={onDialogOpenChange}/>)
    await act(async () => { resolveCheck({ version: '0.1.33', currentVersion: '0.1.32' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<UpdateButton autoCheck showButton={false} enabled onDialogOpenChange={onDialogOpenChange}/>)
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(api.checkForUpdate).toHaveBeenCalledTimes(2)
    expect(onDialogOpenChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: '稍后更新' }))
    expect(onDialogOpenChange).toHaveBeenLastCalledWith(false)
    view.rerender(<UpdateButton autoCheck showButton={false} enabled={false} onDialogOpenChange={onDialogOpenChange}/>)
    view.rerender(<UpdateButton autoCheck showButton={false} enabled onDialogOpenChange={onDialogOpenChange}/>)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(api.checkForUpdate).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

test('shows connection, retry and installation stages without inventing unknown download progress', async () => {
  const download = deferred()
  let reportProgress!: (progress: UpdateProgress) => void
  api.downloadAndInstallUpdate.mockImplementation((_update, onProgress) => { reportProgress = onProgress; return download.promise })
  fireEvent.click(await openUpdate())
  expect(screen.getByRole('status').textContent).toContain('正在连接下载服务器…')
  act(() => reportProgress({ phase: 'downloading', downloaded: 1024, total: 4096 }))
  expect(screen.getByRole('status').textContent).toContain('25%')
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
  act(() => reportProgress({ phase: 'retrying', attempt: 2, maxAttempts: 3, downloaded: 0 }))
  expect(screen.getByRole('status').textContent).toContain('连接中断，正在重试（2/3）…')
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).not.toBe('100')
  act(() => reportProgress({ phase: 'connecting', attempt: 2, maxAttempts: 3, downloaded: 0 }))
  expect(screen.getByRole('status').textContent).toContain('正在连接下载服务器…')
  act(() => reportProgress({ phase: 'downloading', downloaded: 2048 }))
  expect(screen.getByRole('status').textContent).toContain('正在下载…')
  expect(screen.getByRole('status').textContent).not.toContain('%')
  act(() => reportProgress({ phase: 'installing', downloaded: 2048 }))
  expect(screen.getByRole('status').textContent).toContain('正在安装…')
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).not.toBe('100')
  expect((screen.getByRole('button', { name: /更新中…/ }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => download.resolve())
})

test('blocks same-turn duplicate clicks and unlocks the dialog after a failed download for retry', async () => {
  const first = deferred()
  const second = deferred()
  api.downloadAndInstallUpdate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const install = await openUpdate()
  act(() => {
    install.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    install.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(api.downloadAndInstallUpdate).toHaveBeenCalledOnce()
  expect((screen.getByRole('button', { name: '稍后更新' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  await act(async () => first.reject(new Error('连接下载服务器失败，请稍后重试。')))
  await screen.findByText('下载更新失败：连接下载服务器失败，请稍后重试。')
  expect((screen.getByRole('button', { name: '下载并安装' }) as HTMLButtonElement).disabled).toBe(false)
  expect((screen.getByRole('button', { name: '稍后更新' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '下载并安装' }))
  expect(api.downloadAndInstallUpdate).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('status').textContent).toContain('正在连接下载服务器…')
  await act(async () => second.resolve())
})

test('unlocks all controls when installation completes without exiting the app', async () => {
  const download = deferred()
  api.downloadAndInstallUpdate.mockReturnValue(download.promise)
  fireEvent.click(await openUpdate())
  await act(async () => download.resolve())
  await waitFor(() => expect((screen.getByRole('button', { name: '下载并安装' }) as HTMLButtonElement).disabled).toBe(false))
  expect((screen.getByRole('button', { name: '检查更新' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '稍后更新' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
