import { useEffect, useState, type RefObject } from 'react'

/** Observe content and viewport sizes so adding notes or resizing updates the footer. */
export function useAttributePanelOverflow(footerRef: RefObject<HTMLDivElement | null>) {
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    const footer = footerRef.current
    const panel = footer?.closest('.image-attributes-panel')
    const scroll = footer?.closest('.upload-tab-content, .arrange-attributes-content')
    if (!panel || !scroll) return
    const measure = () => setOverflowing(scroll.clientHeight > 0 && scroll.scrollHeight > scroll.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [footerRef])
  return overflowing
}
