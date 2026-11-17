import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { loadAssetPreview } from '../services/assetPreviewService'

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  svg: string; storagePath?: string; assetId?: string; batchId?: string; maxEdgePx?: number; previewOrder?: number
}

/** Queue every thumbnail, prioritize the live viewport and retain completed PNGs. */
export default function LazySvgImage({ svg, storagePath, assetId, batchId, maxEdgePx = 256, previewOrder, alt, style, onClick, onError, title, ...props }: Props) {
  const ref = useRef<HTMLImageElement>(null)
  const retry = useRef<() => void>(() => {})
  const [src, setSrc] = useState<string>()
  const [failed, setFailed] = useState(false)
  const order = useRef(previewOrder)
  useEffect(() => { order.current = previewOrder }, [previewOrder])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    let disposed = false
    let visible = typeof IntersectionObserver === 'undefined'
    let generation = 0
    let controller: AbortController | undefined
    setSrc(undefined)
    setFailed(false)
    const load = () => {
      if (disposed || controller || (!assetId && !svg && !storagePath)) return
      const current = ++generation
      controller = new AbortController()
      void loadAssetPreview({ id: assetId ?? '', svg, storagePath }, batchId, maxEdgePx, controller.signal, () => ({ visible, order: order.current }))
        .then(value => {
          if (disposed || current !== generation) return
          setSrc(value)
          setFailed(false)
          observer?.disconnect()
        })
        .catch(error => { if (!disposed && current === generation && error?.name !== 'AbortError') setFailed(true) })
    }
    retry.current = () => { generation++; controller?.abort(); controller = undefined; setSrc(undefined); setFailed(false); load() }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      const entry = entries.find(entry => entry.target === element) ?? entries[0]
      if (!entry || disposed) return
      visible = entry.isIntersecting
    }, { rootMargin: '0px' })
    if (observer) observer.observe(element)
    load()
    return () => { disposed = true; generation++; controller?.abort(); observer?.disconnect(); retry.current = () => {} }
  }, [assetId, batchId, maxEdgePx, storagePath, svg])

  return <img ref={ref} src={src} alt={failed ? '预览不可用' : src ? alt : ''} aria-label={alt} aria-busy={!src && !failed}
    title={failed ? '预览不可用，点击重试' : title} loading="lazy" decoding="async"
    style={{ ...style, fontSize: failed ? 12 : 0, color: failed ? '#64748b' : 'transparent' }}
    onClick={event => { if (failed) { event.stopPropagation(); retry.current() } else onClick?.(event) }}
    onError={event => { setSrc(undefined); setFailed(true); onError?.(event) }} {...props}/>
}
