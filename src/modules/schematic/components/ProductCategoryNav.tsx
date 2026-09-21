import { theme } from 'antd'
import type { CSSProperties } from 'react'
import type { Asset } from '../../../model'
import type { ProductConfig } from '../services/productConfigService'

export default function ProductCategoryNav({ assets, products, value, onChange, disabled }: {
  assets: Asset[]; products: ProductConfig[]; value: string; onChange: (id: string) => void; disabled: boolean
}) {
  const { token } = theme.useToken()
  const groups = new Map<string, { name: string; count: number }>()
  for (const asset of assets) {
    if (!asset.productId || asset.productId === 'a') continue
    const name = products.find(product => product.id === asset.productId)?.title || asset.productName || asset.productId
    const group = groups.get(asset.productId)
    groups.set(asset.productId, { name, count: (group?.count ?? 0) + 1 })
  }
  return <nav className="upload-product-nav" aria-label="图片产品分类" style={{ '--category-active': token.colorPrimary, '--category-hover': token.colorPrimaryBg, '--category-text': token.colorText } as CSSProperties}>
    <h2>产品分类</h2>
    <div className="upload-product-nav-list">
      <div className="upload-product-nav-items">
        <button disabled={disabled} type="button" aria-pressed={!value} onClick={() => onChange('')}><span>全部</span><small>{assets.length}</small></button>
        {[...groups].map(([id, group]) => <button disabled={disabled} type="button" key={id} aria-pressed={value === id} onClick={() => onChange(id)}><span>{group.name}</span><small>{group.count}</small></button>)}
      </div>
    </div>
  </nav>
}
