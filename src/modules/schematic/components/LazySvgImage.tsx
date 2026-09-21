import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { svgObjectUrl } from '../../../model'

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { svg: string }

/**
 * Defer converting large SVG strings to base64 data URLs until the card is
 * visible. This keeps a large upload batch from creating dozens of decoded
 * SVG documents in the WebView at the same time.
 */
export default function LazySvgImage({ svg, alt, ...props }: Props) {
  const ref = useRef<HTMLImageElement>(null)
  const [src, setSrc] = useState<string>()

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const load = () => setSrc(current => current ?? svgObjectUrl(svg))
    if (typeof IntersectionObserver === 'undefined') {
      load()
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        load()
        observer.disconnect()
      }
    }, { rootMargin: '240px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [svg])

  return <img ref={ref} src={src} alt={alt} loading="lazy" decoding="async" {...props} />
}
