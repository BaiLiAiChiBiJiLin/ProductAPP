import { vi } from 'vitest'
import type { LocalSyncState as State } from '../../src/services/localSyncState'

/** UI transport mocks exercise queue behavior with the real browser adapter.
 * Native migration/durability is covered separately by local-sync-state tests.
 */
export async function browserLocalSyncStateMock() {
  const actual = await vi.importActual<typeof import('../../src/services/localSyncState')>('../../src/services/localSyncState')
  return { ...actual, LocalSyncState: class<T> extends actual.LocalSyncState<T> {
    constructor(...args: ConstructorParameters<typeof State<T>>) { super(args[0], args[1], args[2], args[3], args[4], false) }
  } }
}

export function nativeSyncMock() {
  const disk = new Map<string, string>()
  const chunks = new Map<string, { scope: string; key: string; payload: string }>()
  let failure = ''
  const handle = (command: string, args: Record<string, string>) => {
    if (!/^(load_local_sync_state|save_local_sync_state|delete_local_sync_state|begin_local_sync_write|append_local_sync_write|commit_local_sync_write|abort_local_sync_write)$/.test(command)) return { handled: false }
    if (failure) throw new Error(failure)
    const key = `${args.scope}:${args.key}`
    if (command === 'load_local_sync_state') return { handled: true, value: disk.get(key) ?? null }
    if (command === 'save_local_sync_state') disk.set(key, args.payload)
    if (command === 'delete_local_sync_state') disk.delete(key)
    if (command === 'begin_local_sync_write') {
      const writeId = crypto.randomUUID()
      chunks.set(writeId, { scope: args.scope, key: args.key, payload: '' })
      return { handled: true, value: writeId }
    }
    if (command === 'append_local_sync_write') chunks.get(args.writeId)!.payload += args.chunk
    if (command === 'commit_local_sync_write') {
      const value = chunks.get(args.writeId)!
      disk.set(`${value.scope}:${value.key}`, value.payload)
      chunks.delete(args.writeId)
    }
    if (command === 'abort_local_sync_write') chunks.delete(args.writeId)
    return { handled: true, value: undefined }
  }
  return { disk, chunks, handle, fail: (message: string) => { failure = message }, clear: () => { disk.clear(); chunks.clear(); failure = '' } }
}
