import { invoke as nativeInvoke, isTauri } from '@tauri-apps/api/core'

const chunkSize = 64 * 1024

async function saveNative(scope: string, key: string, payload: string) {
  if (payload.length <= chunkSize) {
    await nativeInvoke('save_local_sync_state', { scope, key, payload })
    return
  }
  const writeId = await nativeInvoke<string>('begin_local_sync_write', { scope, key })
  try {
    for (let start = 0; start < payload.length;) {
      let end = Math.min(start + chunkSize, payload.length)
      const last = payload.charCodeAt(end - 1)
      if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end--
      await nativeInvoke('append_local_sync_write', { writeId, chunk: payload.slice(start, end) })
      start = end
    }
    await nativeInvoke('commit_local_sync_write', { writeId })
  } catch (error) {
    await nativeInvoke('abort_local_sync_write', { writeId }).catch(() => {})
    throw error
  }
}

/** Desktop recovery data lives in Rust's local SQLite, not the WebView quota.
 * Mutations are serialized and published to readers only after a durable commit.
 * Browser previews retain their localStorage implementation.
 */
export class LocalSyncState<T> {
  private value: T
  private loading?: Promise<void>
  private tail: Promise<unknown> = Promise.resolve()
  private readonly scope: string
  private readonly key: string
  private readonly legacyKey: string
  private readonly initial: () => T
  private readonly validate: (value: unknown) => value is T
  private readonly desktop: boolean

  constructor(scope: string, key: string, legacyKey: string, initial: () => T,
    validate: (value: unknown) => value is T, desktop = isTauri()) {
    this.scope = scope; this.key = key; this.legacyKey = legacyKey
    this.initial = initial; this.validate = validate; this.desktop = desktop
    this.value = initial()
    // Let diagnostics and temporary-file protection see old queued work even
    // while native migration is pending. Invalid data is reported by ready().
    try {
      const saved = localStorage.getItem(legacyKey)
      if (saved !== null) this.value = this.parse(saved)
    } catch { /* Never delete unreadable recovery data. */ }
  }

  snapshot(): T {
    if (!this.desktop) {
      const saved = localStorage.getItem(this.legacyKey)
      this.value = saved === null ? this.initial() : this.parse(saved)
    }
    return this.value
  }

  ready(): Promise<void> {
    this.loading ??= this.load().catch(error => { this.loading = undefined; throw error })
    return this.loading
  }

  update(change: (current: T) => T): Promise<T> {
    const operation = this.tail.catch(() => {}).then(async () => {
      await this.ready()
      const next = change(this.snapshot())
      const payload = JSON.stringify(next)
      // Validate and detach caller references before asynchronous IPC.
      const detached = this.parse(payload)
      if (this.desktop) await saveNative(this.scope, this.key, payload)
      else {
        try { localStorage.setItem(this.legacyKey, payload) }
        catch (error) { throw new Error(`本地同步存储写入失败（浏览器存储）：${error instanceof Error ? error.message : String(error)}`) }
      }
      this.value = detached
      return detached
    })
    this.tail = operation
    return operation
  }

  async flush() { await this.ready(); await this.tail }

  private parse(saved: string): T {
    let parsed: unknown
    try { parsed = JSON.parse(saved) } catch { /* Keep the original for recovery. */ }
    if (!this.validate(parsed)) throw new Error('本地同步记录格式无效，原数据已保留，请联系管理员恢复')
    return parsed
  }

  private async load() {
    if (!this.desktop) { this.snapshot(); return }
    const saved = await nativeInvoke<string | null>('load_local_sync_state', { scope: this.scope, key: this.key })
    if (saved !== null && typeof saved !== 'string') throw new Error('本地同步存储读取响应无效，请重启软件后重试')
    const legacy = localStorage.getItem(this.legacyKey)
    if (saved !== null) {
      this.value = this.parse(saved)
      if (legacy !== null) {
        // A crash between migration commit and removing the WebView copy is
        // harmless. Archive a differing old copy before reclaiming its quota.
        if (legacy !== saved) await saveNative(this.scope, `legacy-backup:${this.key}:${crypto.randomUUID()}`, legacy)
        localStorage.removeItem(this.legacyKey)
      }
      return
    }
    if (legacy === null) { this.value = this.initial(); return }
    const migrated = this.parse(legacy)
    await saveNative(this.scope, this.key, legacy)
    this.value = migrated
    localStorage.removeItem(this.legacyKey)
  }
}
