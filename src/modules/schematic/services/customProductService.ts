import { invoke } from '@tauri-apps/api/core'
import type { ProductAttributePatch } from './productOptionRules'

export type CustomProduct = {
  id: number | null
  name: string
  size: string
  printOption: string
  finish: string
  accessoryColor: string
  accessoryColorImage: string
  qt: number
}

export const emptyCustomProduct = (): CustomProduct => ({ id: null, name: '', size: '', printOption: '', finish: '', accessoryColor: '', accessoryColorImage: '', qt: 1 })
export const listCustomProducts = () => invoke<CustomProduct[]>('list_custom_products')
export const saveCustomProduct = (product: CustomProduct) => invoke<CustomProduct>('save_custom_product', { product })

/** Use the same keys as catalog products so classification and batch persistence work unchanged. */
export function customProductPatch(product: CustomProduct): ProductAttributePatch {
  if (product.id == null) throw new Error('请先保存自定义产品')
  return {
    productId: `custom:${product.id}`, productName: product.name,
    clearAttributes: true,
    attributes: { Size: product.size, 'Print Option': product.printOption, Finish: product.finish, 'Accessories Color': product.accessoryColor, QT: String(product.qt) },
    attributeImages: { 'Accessories Color': product.accessoryColorImage },
  }
}
