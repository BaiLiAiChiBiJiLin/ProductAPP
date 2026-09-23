import type { Asset } from '../../../model'

export const UNASSIGNED_PRODUCT_CATEGORY = '__unassigned-product__'

export function matchesProductCategory(asset: Asset, category: string): boolean {
  if (!category) return true
  if (category === UNASSIGNED_PRODUCT_CATEGORY) {
    return !asset.productGroupId && (!asset.productId || asset.productId === 'a') && !asset.productName?.trim()
  }
  return asset.productId === category
}
