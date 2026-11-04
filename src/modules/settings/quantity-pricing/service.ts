import { invoke, isTauri } from '@tauri-apps/api/core'
import seed from './data/quantity-pricing.json'
import { initialBundle } from '../product-options/service'
import { cloneDocument, validateDocument, type PricingCategory, type QuantityPricingDocument } from './model'

validateDocument(seed)
export const initialDocument: QuantityPricingDocument = seed
export type Snapshot = { document: QuantityPricingDocument; categories: PricingCategory[]; version: string; directory: string }

export async function loadQuantityPricing(): Promise<Snapshot> {
  const snapshot = isTauri() ? await invoke<Snapshot>('load_quantity_pricing_settings') : {
    document: cloneDocument(initialDocument),
    categories: initialBundle.main.categories.map(category => ({ categoryId: category.name, title: category.title, titleZh: category.titleZh, productCount: category.products.length })),
    version: 'preview',
    directory: '浏览器预览 · 保存请使用桌面软件',
  }
  validateDocument(snapshot.document)
  if (!Array.isArray(snapshot.categories) || snapshot.categories.some(category => !category || typeof category.categoryId !== 'string' || !category.categoryId || typeof category.title !== 'string' || typeof category.titleZh !== 'string' || !Number.isSafeInteger(category.productCount) || category.productCount < 0) || new Set(snapshot.categories.map(category => category.categoryId)).size !== snapshot.categories.length) {
    throw new Error('产品大类列表无效，请刷新后重试')
  }
  return snapshot
}

export async function saveQuantityPricing(document: QuantityPricingDocument, expectedVersion: string): Promise<Snapshot> {
  validateDocument(document)
  if (!isTauri()) throw new Error('请在桌面软件中保存价格阶梯')
  const snapshot = await invoke<Snapshot>('save_quantity_pricing_settings', { document, expectedVersion })
  validateDocument(snapshot.document)
  return snapshot
}
