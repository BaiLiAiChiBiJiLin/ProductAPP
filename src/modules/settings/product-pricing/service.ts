import { invoke, isTauri } from '@tauri-apps/api/core'
import seed from './data/product-pricing.json'
import { initialBundle } from '../product-options/service'
import { upgradeProductSizeBundle, upgradeStandeeQuantityBundle, validateBundle, type Bundle } from '../product-options/model'
import { initialDocument as initialQuantityPricing } from '../quantity-pricing/service'
import { validateDocument as validateQuantityDocument, type QuantityPricingDocument } from '../quantity-pricing/model'
import { cloneDocument, upgradePricingDocument, upgradeSharedAttributePrices, validateDocument, type ProductPricingDocument } from './model'

validateDocument(seed)
const legacyDefaults: ProductPricingDocument = seed
export const initialDocument: ProductPricingDocument = upgradeSharedAttributePrices(seed)
export type Snapshot = { document: ProductPricingDocument; bundle: Bundle; quantityPricing: QuantityPricingDocument; version: string; directory: string }

function validateSnapshot(snapshot: Snapshot): void {
  validateDocument(snapshot.document)
  validateBundle(snapshot.bundle)
  validateQuantityDocument(snapshot.quantityPricing)
  if (typeof snapshot.version !== 'string' || !snapshot.version || typeof snapshot.directory !== 'string') throw new Error('产品定价存储版本或目录无效')
  // Stale option references remain available for explicit repair in the editor.
}

export async function loadProductPricing(): Promise<Snapshot> {
  const snapshot = isTauri() ? await invoke<Snapshot>('load_product_pricing_settings') : {
    document: cloneDocument(initialDocument),
    bundle: structuredClone(initialBundle),
    quantityPricing: structuredClone(initialQuantityPricing),
    version: 'preview', directory: '浏览器预览 · 保存请使用桌面软件',
  }
  snapshot.bundle = upgradeProductSizeBundle(upgradeStandeeQuantityBundle(snapshot.bundle), snapshot.document)
  snapshot.document = upgradePricingDocument(snapshot.document, legacyDefaults, snapshot.bundle)
  validateSnapshot(snapshot)
  return snapshot
}

export async function saveProductPricing(document: ProductPricingDocument, expectedVersion: string): Promise<Snapshot> {
  validateDocument(document)
  if (!isTauri()) throw new Error('请在桌面软件中保存产品定价')
  const snapshot = await invoke<Snapshot>('save_product_pricing_settings', { document, expectedVersion })
  snapshot.bundle = upgradeProductSizeBundle(upgradeStandeeQuantityBundle(snapshot.bundle), snapshot.document)
  validateSnapshot(snapshot)
  return snapshot
}
