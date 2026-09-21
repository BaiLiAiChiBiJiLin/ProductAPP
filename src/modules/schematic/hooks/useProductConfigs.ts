import { useEffect, useRef, useState } from 'react'
import { loadProductConfigs, refreshProductConfigs, productConfigRefreshError, PRODUCT_CONFIGS_STATUS_EVENT, PRODUCT_CONFIGS_UPDATED_EVENT, type ProductConfig } from '../services/productConfigService'

export default function useProductConfigs(enabled = true) {
  const [products, setProducts] = useState<ProductConfig[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState(productConfigRefreshError)
  const [refreshing, setRefreshing] = useState(false)
  const refreshLock = useRef(false)
  const refresh = async () => {
    if (refreshLock.current) return
    refreshLock.current = true
    setRefreshing(true)
    try { setProducts(await refreshProductConfigs()); setError('') }
    catch (reason) { setError(String(reason)) }
    finally { refreshLock.current = false; setRefreshing(false) }
  }

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const read = () => {
      setLoading(true)
      setError('')
      void loadProductConfigs().then(configs => {
        if (!cancelled) setProducts(configs)
      }).catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => {
        if (!cancelled) setLoading(false)
      })
    }
    read()
    const status = () => setRefreshError(productConfigRefreshError())
    window.addEventListener(PRODUCT_CONFIGS_STATUS_EVENT, status)
    window.addEventListener(PRODUCT_CONFIGS_UPDATED_EVENT, read)
    return () => { cancelled = true; window.removeEventListener(PRODUCT_CONFIGS_UPDATED_EVENT, read); window.removeEventListener(PRODUCT_CONFIGS_STATUS_EVENT, status) }
  }, [enabled])

  return { products, loading, error: error || refreshError, refreshing, refresh }
}
