import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

// Only small PNGs enter this bounded cache; original SVG strings never do.
const previews = new Map<string, string>()
const queue: Array<() => Promise<void>> = []
let running = 0
function drain() {
  while (running < 2 && queue.length) {
    const task = queue.shift()!
    running++
    void task().finally(() => { running--; drain() })
  }
}
function loadThumbnail(path: string, signal: AbortSignal): Promise<string | undefined> {
  const cached = previews.get(path)
  if (cached) { previews.delete(path); previews.set(path, cached); return Promise.resolve(cached) }
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      if (signal.aborted) { resolve(undefined); return }
      try {
        const url = await invoke<string>('load_imposition_thumbnail', { path })
        if (url) {
          previews.set(path, url)
          while (previews.size > 64) previews.delete(previews.keys().next().value!)
        }
        resolve(signal.aborted ? undefined : url)
      } catch (error) { reject(error) }
    })
    drain()
  })
}

export default function ImpositionThumbnail({ path, name }: { path: string; name: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let disposed = false
    let controller: AbortController | undefined
    setUrl(undefined); setFailed(false)
    const visible = (show: boolean) => {
      controller?.abort()
      if (!show) { setUrl(undefined); return }
      controller = new AbortController()
      const signal = controller.signal
      void loadThumbnail(path, signal).then(next => { if (!disposed && !signal.aborted) setUrl(next) }).catch(() => { if (!disposed && !signal.aborted) setFailed(true) })
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => visible(entries.some(entry => entry.isIntersecting)), { rootMargin: '80px' })
    if (observer && ref.current) observer.observe(ref.current)
    else visible(true)
    return () => { disposed = true; controller?.abort(); observer?.disconnect() }
  }, [path])
  return <span ref={ref} className="imposition-thumbnail">{url ? <img src={url} alt={name} loading="lazy" decoding="async"/> : <span aria-label={failed ? `${name} 缩略图无法读取` : `${name} 缩略图待加载`}>{failed ? '预览失败' : 'SVG'}</span>}</span>
}
