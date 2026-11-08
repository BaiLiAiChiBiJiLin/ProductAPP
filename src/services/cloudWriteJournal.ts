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
const storageError = '无法保存本地云端同步日志，请释放磁盘空间并检查本地存储后重试'

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
  private readonly storageKey: string
  private data: JournalData
  private readonly volatilePending = new Map<string, PendingCloudWrite>()

  constructor(scope: string) {
    this.storageKey = `${storagePrefix}${encodeURIComponent(scope)}`
    let saved: string | null
    try { saved = localStorage.getItem(this.storageKey) }
    catch { throw new Error('无法读取本地云端同步日志，请检查本地存储后重试') }
    if (saved === null) {
      this.data = { schemaVersion: 1, versions: {}, pending: {} }
      return
    }
    let parsed: unknown
    try { parsed = JSON.parse(saved) } catch { /* Preserve damaged data for recovery. */ }
    if (!validJournal(parsed)) throw new Error('本地云端同步日志格式无效，请保留本地数据并联系管理员恢复')
    this.data = parsed
  }

  version(key: string): number | undefined { return this.data.versions[key] }
  pending(key: string): PendingCloudWrite | undefined { return this.volatilePending.get(key) ?? this.data.pending[key] }

  remember(entries: Array<[string, number]>) {
    const versions = { ...this.data.versions }
    let changed = false
    for (const [key, version] of entries) {
      if (revision(version) && (versions[key] === undefined || version > versions[key])) {
        versions[key] = version
        changed = true
      }
    }
    if (changed) this.persist({ ...this.data, versions })
  }

  begin(key: string, request: PendingCloudWrite, durable: boolean): PendingCloudWrite {
    if (this.pending(key)) throw new Error('该记录还有待确认的云端保存请求')
    // Snapshot the exact JSON payload, including the first savedAt value.
    const snapshot = JSON.parse(JSON.stringify(request)) as PendingCloudWrite
    if (durable) this.persist({ ...this.data, pending: { ...this.data.pending, [key]: snapshot } })
    else this.volatilePending.set(key, snapshot)
    return snapshot
  }

  finish(key: string, requestId: string, version?: number, removeVersion = false) {
    if (this.pending(key)?.requestId !== requestId) return
    const pending = { ...this.data.pending }
    const versions = { ...this.data.versions }
    delete pending[key]
    if (removeVersion) delete versions[key]
    else if (revision(version)) versions[key] = Math.max(versions[key] ?? 0, version)
    this.persist({ ...this.data, pending, versions })
    this.volatilePending.delete(key)
  }

  private persist(data: JournalData) {
    try { localStorage.setItem(this.storageKey, JSON.stringify(data)) }
    catch { throw new Error(storageError) }
    this.data = data
  }
}
