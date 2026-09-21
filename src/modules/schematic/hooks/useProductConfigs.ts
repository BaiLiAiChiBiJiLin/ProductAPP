import { useEffect, useState } from 'react'
import { loadProductConfigs, PRODUCT_CONFIGS_UPDATED_EVENT, type ProductConfig } from '../services/productConfigService'

export default function useProductConfigs(enabled = true) {
  const [products, setProducts] = useState<ProductConfig[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState('')

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
    window.addEventListener(PRODUCT_CONFIGS_UPDATED_EVENT, read)
    return () => { cancelled = true; window.removeEventListener(PRODUCT_CONFIGS_UPDATED_EVENT, read) }
  }, [enabled])

  return { products, loading, error }
}
