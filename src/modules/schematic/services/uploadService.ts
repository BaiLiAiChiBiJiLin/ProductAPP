import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import type { Asset } from '../../../model'
export type ImportPhase = 'parse' | 'generate'
export type ImportProgress = { phase: ImportPhase; completed: number; total: number }

export async function importAssets(onProgress?: (progress: ImportProgress) => void, onAssets?: (assets: Asset[]) => void, selectedPath?: string): Promise<Asset[]> {
  if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中导入文件')
  const path = selectedPath ?? await open({ multiple: false, filters: [{ name: 'SVG 图片', extensions: ['svg'] }] })
  if (!path || Array.isArray(path)) return []
  if (!/\.svg$/i.test(path)) throw new Error('仅支持 SVG 文件')
  const requestId = crypto.randomUUID()
  const received = new Map<string, Asset>()
  const unlistenProgress = await listen<ImportProgress & { requestId: string }>('import-progress', ({ payload }) => {
    if (payload.requestId === requestId) onProgress?.({ phase: payload.phase, completed: payload.completed, total: payload.total })
  })
  let unlistenAssets = () => {}
  try {
    unlistenAssets = await listen<{ requestId: string; assets: Asset[] }>('import-asset-batch', ({ payload }) => {
      if (payload.requestId !== requestId || !payload.assets.length) return
      payload.assets.forEach(asset => received.set(asset.id, asset))
      onAssets?.(payload.assets)
    })
    // Completion is metadata only: reuse streamed objects instead of receiving
    // and parsing all SVG strings a second time in one giant IPC response.
    const manifest = await invoke<Asset[]>('import_assets', { path, productId: 'a', mode: 'auto', requestId })
    const deadline = Date.now() + 15000
    while (manifest.some(asset => !received.has(asset.id)) && Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 25))
    }
    if (manifest.some(asset => !received.has(asset.id))) throw new Error('图片数据传输未完成，请重新导入')
    return manifest.map(asset => received.get(asset.id)!)
  } finally { unlistenProgress(); unlistenAssets() }
}
