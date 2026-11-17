import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { nativeSyncMock } from './helpers/localSyncStateMock'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }))

beforeEach(() => { vi.resetModules(); native.invoke.mockReset().mockResolvedValue(undefined); localStorage.clear() })
afterEach(() => { localStorage.clear(); vi.useRealTimers() })

test('only diagnostic metadata reaches IPC; payloads, fingerprints, images and credentials are omitted', async () => {
  const events = await import('../src/services/diagnosticEvents')
  const malicious = {
    event: 'sync_submit' as const, batchId: 'batch-1', requestId: 'request-1', command: 'save_batch', expectedVersion: 2,
    userName: '<svg>original image</svg>', recipient: 'data:image/png;base64,secret',
    args: { password: 'database-password', svg: '<svg>original image</svg>' },
    fingerprint: '[original-payload]', error: 'password=secret', noteImages: ['data:image/png;base64,secret'],
  }
  events.trackDiagnosticEvent(malicious)
  await events.flushDiagnosticEvents()
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith('append_diagnostic_event', { event: {
    event: 'sync_submit', batchId: 'batch-1', requestId: 'request-1', command: 'save_batch', expectedVersion: 2,
  } })
  expect(JSON.stringify(native.invoke.mock.calls)).not.toMatch(/secret|password|<svg|fingerprint|noteImages/)
})

test('the application sender preserves event order without blocking the caller', async () => {
  const events = await import('../src/services/diagnosticEvents')
  let release!: () => void
  native.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  events.trackDiagnosticEvent({ event: 'sync_submit', batchId: 'b' })
  events.trackDiagnosticEvent({ event: 'sync_ack', batchId: 'b', resultVersion: 3 })
  expect(native.invoke).not.toHaveBeenCalled()
  const stop = events.startDiagnosticTracking()
  try {
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1))
    const flushed = events.flushDiagnosticEvents()
    expect(native.invoke).toHaveBeenCalledTimes(1)
    release()
    await flushed
    expect(native.invoke.mock.calls.map(([, args]) => args.event.event)).toEqual(['sync_submit', 'sync_ack'])
  } finally { stop() }
})

test('a failed logger neither throws nor retries business work, and its queue stays bounded', async () => {
  const events = await import('../src/services/diagnosticEvents')
  native.invoke.mockRejectedValue(new Error('disk unavailable'))
  for (let index = 0; index < 300; index++) events.trackDiagnosticEvent({ event: 'sync_queued', batchId: `b-${index}` })
  expect(events.diagnosticEventStatus()).toMatchObject({ pending: 256, dropped: 44 })
  await expect(events.flushDiagnosticEvents()).resolves.toBeUndefined()
  expect(native.invoke).toHaveBeenCalledTimes(256)
  expect(events.diagnosticEventStatus()).toEqual({ pending: 0, dropped: 44, failed: 256 })
})

test('export follows a replacement sender started while the previous empty sender finishes', async () => {
  const events = await import('../src/services/diagnosticEvents')
  let release!: () => void
  native.invoke.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
  const stop = events.startDiagnosticTracking()
  events.trackDiagnosticEvent({ event: 'sync_submit', batchId: 'just-started' })
  const complete = vi.fn()
  const flushed = events.flushDiagnosticEvents().then(complete)
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(complete).not.toHaveBeenCalled()
    release()
    await flushed
    expect(complete).toHaveBeenCalledOnce()
  } finally { stop() }
})

test('export flushing is bounded when the native logger stalls', async () => {
  vi.useFakeTimers()
  const events = await import('../src/services/diagnosticEvents')
  native.invoke.mockImplementation(() => new Promise(() => {}))
  for (let index = 0; index < 20; index++) events.trackDiagnosticEvent({ event: 'sync_submit', batchId: `stalled-${index}` })
  const complete = vi.fn()
  const flushed = events.flushDiagnosticEvents().then(complete)
  await vi.advanceTimersByTimeAsync(5_001)
  await flushed
  expect(complete).toHaveBeenCalledOnce()
  expect(events.diagnosticEventStatus().failed).toBe(3)
  await vi.advanceTimersByTimeAsync(1_500)
})

test('cloud requests record a replay, server acknowledgement and durable confirmation without original artwork', async () => {
  const disk = nativeSyncMock()
  let attempts = 0
  native.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === 'append_diagnostic_event') return
    const stored = disk.handle(command, args)
    if (stored.handled) return stored.value
    if (command === 'storage_mode') return { shared: true, environment: 'dev', configPath: 'config', storageRoot: 'root' }
    if (command === 'cloud_operation' && args.command === 'initialize_shared_user') return 'root'
    if (command === 'cloud_operation') {
      if (++attempts === 1) throw new Error('reply lost password=must-not-log')
      return { result: { version: 1 } }
    }
    throw new Error(`Unexpected command ${command}`)
  })
  localStorage.setItem('printflow-account-name', '员工甲')
  const backend = await import('../src/services/backend')
  const events = await import('../src/services/diagnosticEvents')
  await expect(backend.invoke('save_batch', { id: 'batch', assets: [{ svg: '<svg>artwork</svg>' }] })).rejects.toThrow('reply lost')
  await backend.invoke('save_batch', { id: 'batch', assets: [{ svg: '<svg>artwork</svg>' }] })
  await events.flushDiagnosticEvents()
  const trace = native.invoke.mock.calls.filter(([command]) => command === 'append_diagnostic_event').map(([, args]) => args.event)
  expect(trace.map(event => event.event)).toEqual(['sync_submit', 'sync_error', 'sync_submit', 'sync_ack', 'sync_committed'])
  expect(trace[0]).toMatchObject({ batchId: 'batch', expectedVersion: 0, replayed: false })
  expect(trace[2]).toMatchObject({ requestId: trace[0].requestId, replayed: true })
  expect(trace[3]).toMatchObject({ resultVersion: 1 })
  expect(trace[4]).toMatchObject({ resultVersion: 1, stage: 'journal' })
  expect(JSON.stringify(trace)).not.toMatch(/password|must-not-log|artwork|<svg/)
})

test('a transfer trace records the intended recipient and the confirmed outcome', async () => {
  const disk = nativeSyncMock()
  native.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === 'append_diagnostic_event') return
    const stored = disk.handle(command, args)
    if (stored.handled) return stored.value
    if (command === 'storage_mode') return { shared: true, environment: 'dev', configPath: 'config', storageRoot: 'root' }
    if (command === 'cloud_operation' && args.command === 'initialize_shared_user') return 'root'
    return { result: { recipient: '员工乙' } }
  })
  localStorage.setItem('printflow-account-name', '员工甲')
  const backend = await import('../src/services/backend')
  const events = await import('../src/services/diagnosticEvents')
  await backend.invoke('send_shared_batch', { batchId: 'batch', recipient: '员工乙' })
  await events.flushDiagnosticEvents()
  const trace = native.invoke.mock.calls.filter(([command]) => command === 'append_diagnostic_event').map(([, args]) => args.event)
  expect(trace.map(event => event.event)).toEqual(['transfer_submit', 'transfer_ack', 'transfer_committed'])
  expect(trace.every(event => event.recipient === '员工乙' && event.userName === '员工甲' && event.batchId === 'batch')).toBe(true)
})
