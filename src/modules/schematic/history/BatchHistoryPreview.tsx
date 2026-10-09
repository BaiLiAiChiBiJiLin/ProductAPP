import { useEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { loadBatchThumbnails, type BatchThumbnail } from './historyThumbnailService'

type Props = { batchId: string; savedAt: string; assetCount: number; active: boolean }

export default function BatchHistoryPreview({ batchId, savedAt, assetCount, active }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [previews, setPreviews] = useState<BatchThumbnail[] | null>(null)

  useEffect(() => {
    if (!active || !container.current) return
    const controller = new AbortController()
    let started = false
    setPreviews(null)
    const load = () => {
      if (started) return
      started = true
      void loadBatchThumbnails(batchId, controller.signal)
        .then(value => { if (!controller.signal.aborted) setPreviews(value) })
        .catch(() => { if (!controller.signal.aborted) setPreviews([]) })
    }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load() }
    })
    if (observer) observer.observe(container.current)
    else load()
    return () => { controller.abort(); observer?.disconnect() }
  }, [batchId, savedAt, active])

  return <div className="batch-history-cover" ref={container}>
    {Array.from({ length: Math.min(4, assetCount) }, (_, index) => {
      const preview = previews?.[index]
      return <div className={`batch-history-thumbnail${previews === null ? ' is-loading' : ''}`} key={index}>
        {preview?.url ? <img src={preview.url} alt={preview.name} draggable={false}/> : previews !== null ? <ImageOff size={16} aria-label="暂无预览"/> : null}
      </div>
    })}
  </div>
}
