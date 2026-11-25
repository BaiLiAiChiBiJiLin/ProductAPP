import { invoke as nativeInvoke, isTauri } from '@tauri-apps/api/core'
import type { CloudSyncFailure } from './cloudSyncErrors'

const eventNames = new Set([
  'sync_queued', 'sync_submit', 'sync_ack', 'sync_committed', 'sync_error',
  'transfer_submit', 'transfer_ack', 'transfer_committed', 'transfer_error', 'sync_recovered',
  'history_open', 'history_opened', 'history_error',
  'module_enter', 'module_leave', 'arrange_enter', 'arrange_ready', 'arrange_error', 'arrange_stall',
  'render_long_task', 'window_error', 'unhandled_rejection', 'app_heartbeat', 'unexpected_restart',
  'memory_sample', 'source_missing', 'app_shutdown', 'visibility_recovered',
])
const commands = new Set([
  'save_batch', 'delete_batch', 'delete_asset', 'send_shared_batch', 'save_schematic_review',
  'delete_schematic_review', 'update_schematic_review_payment_status', 'submit_schematic_review_to_imposition',
  'return_imposition_to_review', 'update_imposition_image_quantity', 'update_imposition_image_quantities', 'save_cloud_pools',
  'load_batch',
])
const errorKinds = new Set<CloudSyncFailure['kind']>(['connection', 'conflict', 'source', 'permission', 'configuration', 'data', 'unknown', 'local-storage'])
type EventName = 'sync_queued' | 'sync_submit' | 'sync_ack' | 'sync_committed' | 'sync_error'
  | 'transfer_submit' | 'transfer_ack' | 'transfer_committed' | 'transfer_error' | 'sync_recovered'
  | 'history_open' | 'history_opened' | 'history_error'
  | 'module_enter' | 'module_leave' | 'arrange_enter' | 'arrange_ready' | 'arrange_error' | 'arrange_stall'
  | 'render_long_task' | 'window_error' | 'unhandled_rejection' | 'app_heartbeat' | 'unexpected_restart'
  | 'memory_sample' | 'source_missing' | 'app_shutdown' | 'visibility_recovered'
export type DiagnosticEvent = {
  event: EventName
  batchId?: string
  requestId?: string
  command?: string
  expectedVersion?: number
  resultVersion?: number
  attempts?: number
  assetCount?: number
  elapsedMs?: number
  errorKind?: CloudSyncFailure['kind']
  retryable?: boolean
  replayed?: boolean
  recipient?: string
  userName?: string
  revision?: string
  recoveredBatchId?: string
  stage?: 'request' | 'acknowledgement' | 'journal' | 'queue' | 'enter' | 'ready' | 'render' | 'save' | 'export' | 'heartbeat' | 'watchdog' | 'startup' | 'shutdown' | 'source'
  module?: string
  exitReason?: 'user' | 'restart' | 'unexpected' | 'watchdog' | 'unknown'
  errorHash?: string
  operation?: string
  pageCount?: number
  groupCount?: number
  selectedCount?: number
  uptimeMs?: number
  rssBytes?: number
  heapUsedBytes?: number
  heapLimitBytes?: number
  wasHiddenMs?: number
  activeModule?: string
  sourceKind?: 'temporary' | 'shared-reference' | 'shared' | 'network' | 'unknown'
  missingCount?: number
  sourceCount?: number
  stallMs?: number
  heartbeatAgeMs?: number
  location?: 'temporary' | 'shared-reference' | 'network' | 'other'
}

const queue: DiagnosticEvent[] = []
const maxQueuedEvents = 256
let subscriptions = 0
let flushing = 0
let runner: Promise<void> | undefined
let failed = 0
let dropped = 0

/** Restrict metadata before IPC as well as in Rust. No payloads, image URLs,
 * credentials, free-form error messages or request fingerprints are accepted. */
function safeEvent(value: DiagnosticEvent): DiagnosticEvent | undefined {
  if (!eventNames.has(value.event)) return undefined
  const next: DiagnosticEvent = { event: value.event }
  for (const key of ['batchId', 'requestId', 'revision', 'recoveredBatchId'] as const) {
    const text = value[key]
    if (typeof text === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(text)) next[key] = text
  }
  for (const key of ['recipient', 'userName'] as const) {
    const text = value[key]
    if (typeof text === 'string' && text.length <= 30 && !/[<>\r\n\\]|data:|:\/\/|password\s*[:=]|token\s*[:=]/i.test(text)) next[key] = text
  }
  for (const key of ['expectedVersion', 'resultVersion', 'attempts', 'assetCount', 'elapsedMs'] as const) {
    const number = value[key]
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) next[key] = number
  }
  for (const key of ['retryable', 'replayed'] as const) if (typeof value[key] === 'boolean') next[key] = value[key]
  if (value.command && commands.has(value.command)) next.command = value.command
  if (value.errorKind && errorKinds.has(value.errorKind)) next.errorKind = value.errorKind
  if (value.stage && ['request', 'acknowledgement', 'journal', 'queue', 'enter', 'ready', 'render', 'save', 'export', 'heartbeat', 'watchdog', 'startup', 'shutdown', 'source'].includes(value.stage)) next.stage = value.stage
  for (const key of ['module', 'errorHash', 'operation', 'activeModule', 'sourceKind', 'location'] as const) {
    const text = value[key]
    if (typeof text === 'string' && text.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(text)) (next as Record<string, unknown>)[key] = text
  }
  if (value.exitReason && ['user', 'restart', 'unexpected', 'watchdog', 'unknown'].includes(value.exitReason)) next.exitReason = value.exitReason
  for (const key of ['pageCount', 'groupCount', 'selectedCount', 'uptimeMs', 'rssBytes', 'heapUsedBytes', 'heapLimitBytes', 'wasHiddenMs', 'missingCount', 'sourceCount', 'stallMs', 'heartbeatAgeMs'] as const) {
    const number = value[key]
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER) next[key] = Math.round(number)
  }
  return next
}

async function send(event: DiagnosticEvent) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      nativeInvoke('append_diagnostic_event', { event }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic timeout')), 1_500) }),
    ])
  } catch { failed += 1 } // Diagnostics must never make a business write fail.
  finally { if (timer !== undefined) clearTimeout(timer) }
}

function pump(): Promise<void> {
  if (runner) return runner
  runner = (async () => {
    while (queue.length && (subscriptions > 0 || flushing > 0)) await send(queue.shift()!)
  })().finally(() => {
    runner = undefined
    if (queue.length && (subscriptions > 0 || flushing > 0)) void pump()
  })
  return runner
}

export function trackDiagnosticEvent(event: DiagnosticEvent) {
  try { if (!isTauri()) return } catch { return }
  const safe = safeEvent(event)
  if (!safe) return
  if (queue.length >= maxQueuedEvents) { queue.shift(); dropped += 1 }
  queue.push(safe)
  if (subscriptions > 0 || flushing > 0) void pump()
}

/** The application owns the sender's lifetime; services can collect events
 * before startup finishes without creating a second transport or retry loop. */
export function startDiagnosticTracking() {
  if (!isTauri()) return () => {}
  subscriptions += 1
  void pump()
  let stopped = false
  return () => { if (!stopped) { stopped = true; subscriptions -= 1 } }
}

export function diagnosticEventStatus() { return { pending: queue.length + (runner ? 1 : 0), failed, dropped } }

/** Export remains available even when an event write stalls or disk access
 * fails. Rust also exports the durable queue/journal summaries independently. */
export async function flushDiagnosticEvents(): Promise<void> {
  if (!isTauri()) return
  flushing += 1
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const drain = async () => {
      // A sender that was just finishing an empty queue can hand work to a
      // replacement runner. Follow that runner before declaring the flush done.
      while (!expired && (queue.length > 0 || runner)) await pump()
    }
    await Promise.race([drain(), new Promise<void>(resolve => { timer = setTimeout(() => { expired = true; resolve() }, 5_000) })])
  } finally {
    expired = true
    flushing -= 1
    if (timer !== undefined) clearTimeout(timer)
  }
}
