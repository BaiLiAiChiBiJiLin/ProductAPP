import { invoke } from '@tauri-apps/api/core'

export const STAGED_ARTWORK_PREFIX = 'printflow-export:'
export const REVIEW_ARTWORK_PREFIX = 'printflow-review:'
const CHUNK_CHARACTERS = 64 * 1024

/** Copy editable containers while sharing immutable, potentially large SVG strings. */
export function copyWorkspaceValue<T>(value: T, text: (value: string) => string = value => value): T {
  if (typeof value === 'string') return text(value) as T
  if (Array.isArray(value)) return value.map(entry => copyWorkspaceValue(entry, text)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copyWorkspaceValue(entry, text)])) as T
  return value
}

/** Bounded, acknowledged chunks avoid WebView2's large JSON IPC allocations. */
export async function writeStagedText(id: string, text: string) {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + CHUNK_CHARACTERS)
    // Never cut a UTF-16 surrogate pair before Rust encodes the chunk as UTF-8.
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
    await invoke('write_export_resource_chunk', { id, text: text.slice(offset, end), append: offset > 0 })
    offset = end
  }
}

export class StagedArtwork {
  private readonly resources = new Map<string, string>()
  reference = (text: string) => {
    let id = this.resources.get(text)
    if (!id) { id = crypto.randomUUID(); this.resources.set(text, id) }
    return `${STAGED_ARTWORK_PREFIX}${id}`
  }
  async write(onProgress?: (completed: number, total: number) => void) {
    let completed = 0
    for (const [text, id] of this.resources) {
      await writeStagedText(id, text)
      onProgress?.(++completed, this.resources.size)
    }
  }
  async dispose() {
    const ids = [...this.resources.values()]
    this.resources.clear()
    if (ids.length) await invoke('clear_pdf_pages', { ids }).catch(error => console.warn('导出临时资源清理失败', error))
  }
}

export function stageLargeWorkspaceValues<T>(value: T, resources: StagedArtwork): T {
  return copyWorkspaceValue(value, text => text.length > CHUNK_CHARACTERS ? resources.reference(text) : text)
}
