import { invoke } from '@tauri-apps/api/core'

type Listener = (image: HTMLImageElement | undefined) => void
type Entry = {
  key: string; path?: string; source?: string; edge: number
  listeners: Set<Listener>; status: 'queued' | 'loading' | 'ready' | 'failed'
  image?: HTMLImageElement; bytes: number; cancelDecode?: () => void
}

/** One store per canvas: QT copies share both pending loads and decoded pixels. */
export class ImpositionCanvasImages {
  private entries = new Map<string, Entry>()
  private running = 0

  acquire(path: string | undefined, source: string | undefined, edge: number, listener: Listener) {
    if (!path && !source) { listener(undefined); return () => {} }
    const key = path ? `path:${edge}:${path}` : `inline:${source}`
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { key, path, source, edge, listeners: new Set(), status: 'queued', bytes: 0 }
      this.entries.set(key, entry)
    }
    const current = entry
    current.listeners.add(listener)
    listener(current.status === 'ready' ? current.image : undefined)
    this.drain()
    return () => {
      if (this.entries.get(key) !== current) return
      current.listeners.delete(listener)
      if (current.listeners.size) return
      if (current.status !== 'ready') this.remove(current)
      else {
        // Refresh idle LRU order. Active images are owned by visible Konva nodes.
        this.entries.delete(key); this.entries.set(key, current)
        this.trim()
      }
    }
  }

  dispose() {
    for (const entry of this.entries.values()) this.remove(entry)
    this.entries.clear()
  }

  private remove(entry: Entry) {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    entry.cancelDecode?.()
    if (entry.image) {
      entry.image.onload = null; entry.image.onerror = null
      entry.image.removeAttribute('src')
      entry.image = undefined
    }
    entry.listeners.clear()
  }

  private trim() {
    const idle = [...this.entries.values()].filter(entry => !entry.listeners.size && entry.status === 'ready')
    let bytes = idle.reduce((sum, entry) => sum + entry.bytes, 0)
    let count = idle.length
    for (const entry of idle) {
      if (count <= 32 && bytes <= 16 * 1024 * 1024) break
      count--; bytes -= entry.bytes; this.remove(entry)
    }
  }

  private drain() {
    if (this.running) return
    const entry = [...this.entries.values()].find(item => item.status === 'queued' && item.listeners.size)
    if (!entry) return
    entry.status = 'loading'; this.running++
    void this.load(entry).finally(() => { this.running--; this.drain() })
  }

  private async load(entry: Entry) {
    try {
      // Native code rasterizes one original at a time. Only a bounded PNG
      // crosses IPC; SVG text and embedded print-resolution images stay native.
      const source = entry.path
        ? await invoke<string>('load_imposition_thumbnail', { path: entry.path, maxEdgePx: entry.edge })
        : entry.source
      if (this.entries.get(entry.key) !== entry || !entry.listeners.size) return
      if (!source) { entry.status = 'failed'; return }
      const image = new window.Image()
      entry.image = image
      image.decoding = 'async'
      const loaded = await new Promise<boolean>(resolve => {
        const finish = (ok: boolean) => { image.onload = null; image.onerror = null; entry.cancelDecode = undefined; resolve(ok) }
        entry.cancelDecode = () => finish(false)
        image.onload = () => finish(true)
        image.onerror = () => finish(false)
        image.src = source
      })
      if (this.entries.get(entry.key) !== entry || !entry.listeners.size) return
      if (!loaded) { this.remove(entry); return }
      entry.status = 'ready'
      entry.bytes = Math.max(1, image.naturalWidth) * Math.max(1, image.naturalHeight) * 4 + source.length * 2
      entry.listeners.forEach(listener => listener(image))
    } catch {
      // Keep other artwork usable if one preview cannot be rendered.
      if (this.entries.get(entry.key) === entry) entry.status = 'failed'
    }
  }
}

/** Preview resolution follows screen size, with a firm 512 px upper bound. */
export function canvasPreviewEdge(screenPixels: number) {
  return screenPixels > 256 ? 512 : screenPixels > 128 ? 256 : 128
}
