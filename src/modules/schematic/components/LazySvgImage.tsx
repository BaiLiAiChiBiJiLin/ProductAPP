import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { svgObjectUrl } from '../../../model'
import { loadAssetSvg } from '../services/assetSvgService'

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { svg: string; storagePath?: string; assetId?: string; batchId?: string }

/**
 * Defer creating object URLs for large SVG strings until the card is
 * visible. This keeps a large upload batch from creating dozens of decoded
 * SVG documents in the WebView at the same time.
 */
export default function LazySvgImage({ svg, storagePath, assetId, batchId, alt, ...props }: Props) {
  const ref = useRef<HTMLImageElement>(null)
  const [src, setSrc] = useState<string>()

  useEffect(() => {
    const element = ref.current
    if (!element) return
    let cancelled = false
    const load = () => {
      if (svg) {
        setSrc(svgObjectUrl(svg))
        return
      }
      if (!storagePath && !(assetId && batchId)) return
      void loadAssetSvg({ svg, storagePath, id: assetId ?? '' }, batchId)
        .then(value => { if (!cancelled) setSrc(svgObjectUrl(value)) })
        .catch(() => {})
    }
    if (typeof IntersectionObserver === 'undefined') {
      load()
      return () => { cancelled = true }
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        load()
        observer.disconnect()
      }
    }, { rootMargin: '240px' })
    observer.observe(element)
    return () => { cancelled = true; observer.disconnect() }
  }, [assetId, batchId, storagePath, svg])

  return <img ref={ref} src={src} alt={alt} loading="lazy" decoding="async" {...props} />
}
