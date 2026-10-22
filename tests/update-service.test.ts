import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'

const native = { invoke: vi.fn() }

import { Update } from '@tauri-apps/plugin-updater'
import { downloadAndInstallUpdate } from '../src/modules/update/updateService'

const networkError = 'error sending request for url (https://github.com/example/releases/download/setup.exe)'
const update = () => new Update({ rid: 7, version: '0.1.29', currentVersion: '0.1.28', rawJson: {} })
const downloads = () => native.invoke.mock.calls.filter(([command]) => command === 'plugin:updater|download')
const installs = () => native.invoke.mock.calls.filter(([command]) => command === 'plugin:updater|install')

beforeEach(() => { vi.useFakeTimers(); native.invoke.mockReset(); mockIPC(native.invoke) })
afterEach(() => { clearMocks(); vi.useRealTimers() })

test('a reset connection retries the actual updater download and installs verified bytes only once', async () => {
  let attempts = 0
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'plugin:updater|install') return
    attempts++
    args.onEvent.onmessage({ event: 'Started', data: { contentLength: 100 } })
    args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: 40 } })
    if (attempts === 1) throw networkError
    args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: 60 } })
    args.onEvent.onmessage({ event: 'Finished' })
    return 23
  })
  const progress = vi.fn()
  const result = downloadAndInstallUpdate(update(), progress)
  const assertion = expect(result).resolves.toBeUndefined()
  await Promise.all([assertion, vi.runAllTimersAsync()])
  expect(downloads()).toHaveLength(2)
  expect(installs()).toHaveLength(1)
  expect(installs()[0][1]).toMatchObject({ updateRid: 7, bytesRid: 23, restartAfterInstall: true })
  expect(progress.mock.calls.map(([value]) => value)).toContainEqual(expect.objectContaining({ phase: 'retrying', attempt: 2, downloaded: 0 }))
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'installing', downloaded: 100, total: 100 }))
  expect(downloads()[0][1].timeout).toBe(600_000)
})

test('persistent network failure stops after three downloads and leaves installation untouched', async () => {
  native.invoke.mockRejectedValue(networkError)
  const result = downloadAndInstallUpdate(update(), vi.fn())
  const assertion = expect(result).rejects.toThrow('已尝试 3 次')
  await Promise.all([assertion, vi.runAllTimersAsync()])
  expect(downloads()).toHaveLength(3)
  expect(installs()).toHaveLength(0)
})

test.each(['signature verification failed', 'Download request failed with status: 404 Not Found', 'invalid updater binary format'])(
  'does not retry non-network failure: %s', async error => {
    native.invoke.mockRejectedValue(error)
    await expect(downloadAndInstallUpdate(update(), vi.fn())).rejects.toBe(error)
    expect(downloads()).toHaveLength(1)
    expect(installs()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  },
)

test('does not restart a download or repeat installation when installation fails', async () => {
  native.invoke.mockImplementation(async command => {
    if (command === 'plugin:updater|install') throw networkError
    return 23
  })
  await expect(downloadAndInstallUpdate(update(), vi.fn())).rejects.toBe(networkError)
  expect(downloads()).toHaveLength(1)
  expect(installs()).toHaveLength(1)
})

test('unknown content length stays unknown and partial-transfer retry starts counting from zero', async () => {
  let attempts = 0
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'plugin:updater|install') return
    attempts++
    args.onEvent.onmessage({ event: 'Started', data: {} })
    args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: 25 } })
    if (attempts === 1) throw 'error decoding response body'
    args.onEvent.onmessage({ event: 'Finished' })
    return 24
  })
  const progress = vi.fn()
  const result = downloadAndInstallUpdate(update(), progress)
  const assertion = expect(result).resolves.toBeUndefined()
  await Promise.all([assertion, vi.runAllTimersAsync()])
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'installing', downloaded: 25, total: undefined }))
})
