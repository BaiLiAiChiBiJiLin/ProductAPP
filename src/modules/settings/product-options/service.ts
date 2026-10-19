import { invoke, isTauri } from '@tauri-apps/api/core'
import main from './data/product-options.clean.json'
import print from './data/print-options.json'
import techniques from './data/techniques.json'
import films from './data/holo-films.json'
import materials from './data/materials.json'
import accessories from './data/accessory-styles.json'
import { clone, validateBundle, type Bundle } from './model'

export const initialBundle = { main, catalogs: { 'print-options.json': print, 'techniques.json': techniques, 'holo-films.json': films, 'materials.json': materials, 'accessory-styles.json': accessories } } as Bundle
export type Snapshot = { bundle: Bundle; version: string; directory: string }
export async function loadProductOptions(): Promise<Snapshot> {
  const snapshot = isTauri() ? await invoke<Snapshot>('load_product_option_settings') : { bundle: clone(initialBundle), version: 'preview', directory: '浏览器预览 · 保存请使用桌面软件' }
  validateBundle(snapshot.bundle)
  return snapshot
}
export async function saveProductOptions(bundle: Bundle, expectedVersion: string): Promise<Snapshot> {
  validateBundle(bundle)
  if (!isTauri()) throw new Error('请在桌面软件中保存配置。浏览器中可导出完整配置副本。')
  return invoke<Snapshot>('save_product_option_settings', { bundle, expectedVersion })
}
