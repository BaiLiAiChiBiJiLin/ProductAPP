import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@tauri-apps/api/core'
import { loadPublicProductConfigs, publicProductOptionsError, PUBLIC_PRODUCT_OPTIONS_STATUS_EVENT, PUBLIC_PRODUCT_OPTIONS_UPDATED_EVENT, refreshPublicProductConfigs } from '../services/publicProductOptionService'
import type { ProductConfig } from '../services/productConfigService'

export default function usePublicProductConfigs(enabled = true) {
  const [products, setProducts] = useState<ProductConfig[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState(publicProductOptionsError)
  const [refreshing, setRefreshing] = useState(false)
  const refreshLock = useRef(false)
  const refresh = async () => {
    if (refreshLock.current) return
    refreshLock.current = true; setRefreshing(true)
    try { setProducts(await refreshPublicProductConfigs()); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { refreshLock.current = false; setRefreshing(false) }
  }
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    void loadPublicProductConfigs().then(items => { if (!cancelled) setProducts(items) })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    const status = () => setError(publicProductOptionsError())
    window.addEventListener(PUBLIC_PRODUCT_OPTIONS_STATUS_EVENT, status)
    let unlisten: (() => void) | undefined
    if (isTauri()) {
      void listen(PUBLIC_PRODUCT_OPTIONS_UPDATED_EVENT, () => {
        void loadPublicProductConfigs(true).then(items => { if (!cancelled) { setProducts(items); setError('') } }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
      }).then(stop => { if (cancelled) stop(); else unlisten = stop }).catch(() => {})
    }
    return () => { cancelled = true; unlisten?.(); window.removeEventListener(PUBLIC_PRODUCT_OPTIONS_STATUS_EVENT, status) }
  }, [enabled])
  return { products, loading, error, refreshing, refresh }
}
