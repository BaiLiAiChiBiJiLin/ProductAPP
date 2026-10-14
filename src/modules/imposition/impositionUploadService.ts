import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import type { ImpositionRecord } from './impositionRecords'

export type ImpositionImportProgress = { phase: 'parse' | 'generate'; completed: number; total: number }

/** Import directly into a temporary production job; schematic/order state is untouched. */
export async function importImpositionSvg(
  onProgress?: (progress: ImpositionImportProgress) => void,
  selectedPath?: string,
): Promise<ImpositionRecord | null> {
  if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中上传 SVG')
  const path = selectedPath ?? await open({ multiple: false, filters: [{ name: 'SVG 图片', extensions: ['svg'] }] })
  if (!path || Array.isArray(path)) return null
  if (!/\.svg$/i.test(path)) throw new Error('仅支持 SVG 文件')
  const requestId = crypto.randomUUID()
  onProgress?.({ phase: 'parse', completed: 0, total: 1 })
  const unlisten = await listen<ImpositionImportProgress & { requestId: string }>('imposition-import-progress', ({ payload }) => {
    if (payload.requestId === requestId) {
      onProgress?.({ phase: payload.phase, completed: payload.completed, total: payload.total })
    }
  })
  try {
    // All returned images reference staged files. Artwork is fetched lazily by
    // the image list/canvas rather than transferred twice during import.
    return await invoke<ImpositionRecord>('import_imposition_svg', { path, requestId })
  } finally {
    unlisten()
  }
}

export function impositionImportLabel(progress: ImpositionImportProgress): string {
  if (progress.phase === 'parse') return progress.total > 1
    ? `正在拆解 SVG：${progress.completed}/${progress.total}`
    : '正在读取 SVG 与真实尺寸…'
  return `正在保存临时图片：${progress.completed}/${progress.total}`
}

export function impositionImportPercent(progress: ImpositionImportProgress): number {
  const fraction = progress.total > 0 ? Math.max(0, Math.min(1, progress.completed / progress.total)) : 0
  return Math.round(progress.phase === 'parse' ? fraction * 35 : 35 + fraction * 65)
}
