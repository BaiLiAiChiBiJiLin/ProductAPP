import { LocalSyncState } from './localSyncState'

export type CloudWriteArgs = Record<string, unknown>
export type PendingCloudWrite = {
  command: string
  fingerprint: string
  requestId: string
  expectedVersion: number
  args: CloudWriteArgs
}
type JournalData = {
  schemaVersion: 1
  versions: Record<string, number>
  pending: Record<string, PendingCloudWrite>
}
const storagePrefix = 'printflow-cloud-write-journal-v1:'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function validJournal(value: unknown): value is JournalData {
  if (!object(value) || value.schemaVersion !== 1 || !object(value.versions) || !object(value.pending)) return false
  return Object.values(value.versions).every(revision) && Object.values(value.pending).every(item =>
    object(item) && typeof item.command === 'string' && typeof item.fingerprint === 'string'
    && typeof item.requestId === 'string' && item.requestId.length > 0
    && revision(item.expectedVersion) && object(item.args))
}

// The document contains only known base revisions and unacknowledged requests.
// Write the replacement first so a storage failure never discards a recoverable request.
export class CloudWriteJournal {
  private readonly store: LocalSyncState<JournalData>
  private readonly volatilePending = new Map<string, PendingCloudWrite>()

  constructor(scope: string) {
    this.store = new LocalSyncState(scope, 'write-journal', `${storagePrefix}${encodeURIComponent(scope)}`,
      () => ({ schemaVersion: 1, versions: {}, pending: {} }), validJournal)
  }

  ready() { return this.store.ready() }
  version(key: string): number | undefined { return this.store.snapshot().versions[key] }
  pending(key: string): PendingCloudWrite | undefined { return this.volatilePending.get(key) ?? this.store.snapshot().pending[key] }

  async remember(entries: Array<[string, number]>) {
    if (!entries.some(([key, version]) => revision(version) && (this.version(key) === undefined || version > this.version(key)!))) return
    await this.store.update(data => {
      const versions = { ...data.versions }
      for (const [key, version] of entries) {
        if (revision(version) && (versions[key] === undefined || version > versions[key])) versions[key] = version
      }
      return { ...data, versions }
    })
  }

  async begin(key: string, request: PendingCloudWrite, durable: boolean): Promise<PendingCloudWrite> {
    if (this.pending(key)) throw new Error('该记录还有待确认的云端保存请求')
    // Snapshot the exact JSON payload, including the first savedAt value.
    const snapshot = JSON.parse(JSON.stringify(request)) as PendingCloudWrite
    if (durable) await this.store.update(data => ({ ...data, pending: { ...data.pending, [key]: snapshot } }))
    else this.volatilePending.set(key, snapshot)
    return snapshot
  }

  async finish(key: string, requestId: string, version?: number, removeVersion = false) {
    if (this.pending(key)?.requestId !== requestId) return
    await this.store.update(data => {
      const pending = { ...data.pending }
      const versions = { ...data.versions }
      delete pending[key]
      if (removeVersion) delete versions[key]
      else if (revision(version)) versions[key] = Math.max(versions[key] ?? 0, version)
      return { ...data, pending, versions }
    })
    this.volatilePending.delete(key)
  }
}
