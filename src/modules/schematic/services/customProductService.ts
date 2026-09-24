import { invoke } from '@tauri-apps/api/core'
import { normalizeProductConfigs, type ProductConfig } from './productConfigService.ts'
import type { ProductAttributePatch } from './productOptionRules'

export type CustomProduct = {
  id: number | null
  name: string
  size: string
  printOption: string
  finish: string
  accessoryColor: string
  accessoryColorImage: string
  qt: number | null
  attributes?: Record<string, string>
  attributeImages?: Record<string, string>
}

export const emptyCustomProduct = (): CustomProduct => ({ id: null, name: '', size: '', printOption: '', finish: '', accessoryColor: '', accessoryColorImage: '', qt: 1, attributes: {} })
export type CustomProductName = { id: number; name: string }
export const listCustomProducts = () => invoke<CustomProductName[]>('list_custom_products')
export const addCustomProductName = (name: string) => invoke<CustomProductName>('add_custom_product_name', { name })
export const saveCustomProduct = (product: CustomProduct) => invoke<CustomProduct>('save_custom_product', { product })

let configRequest: Promise<ProductConfig> | undefined
export function loadCustomProductConfig(): Promise<ProductConfig> {
  configRequest ??= invoke<string>('load_custom_product_config').then(raw => {
    const product = normalizeProductConfigs([JSON.parse(raw)])[0]
    if (!product?.options.length) throw new Error('本地自定义产品配置没有可用选项')
    return product
  }).catch(error => { configRequest = undefined; throw error })
  return configRequest
}

export const customAttributes = (product: CustomProduct): Record<string, string> => product.attributes ?? {
  Size: product.size, 'Print Option': product.printOption, Finish: product.finish, 'Accessories Color': product.accessoryColor,
}
export const customImages = (product: CustomProduct): Record<string, string> => product.attributeImages ?? { 'Accessories Color': product.accessoryColorImage }

/** Catalog and custom products share attribute keys and independent QT/notes. */
export function customProductPatch(product: CustomProduct): ProductAttributePatch {
  if (product.id == null) throw new Error('请先保存自定义产品')
  return {
    productId: `custom:${product.id}`, productName: product.name,
    clearAttributes: true,
    attributes: { ...customAttributes(product), QT: product.qt == null ? '' : String(product.qt) },
    attributeImages: customImages(product),
  }
}
