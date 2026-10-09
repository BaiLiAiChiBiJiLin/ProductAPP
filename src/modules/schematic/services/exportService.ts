import { prepareAccessoryFrames } from './accessoryFrameService.ts'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { defaultLayoutBounds, pageRasterSvg, pageSvg, type Asset, type LayoutBounds, type Page } from '../../../model'
import type { BatchMetadata } from '../types'
import type { DimensionDisplayOverride } from './imageDimensionService.ts'
import { StagedArtwork, writeStagedText } from './stagedArtworkService'
export async function exportPage(page: Page, assets: Asset[], output: string, format = 'svg', metadata: Partial<BatchMetadata> = {}, totalPages = 1, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>, layoutBounds: LayoutBounds = defaultLayoutBounds) {
  if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中导出')
  await prepareAccessoryFrames([page])
  const map = new Map(assets.map(a => [a.id, a]))
  const svg = format === 'svg' ? pageSvg(page, map, metadata, totalPages, displayOverrides, layoutBounds)
    : pageRasterSvg(page, map, metadata, totalPages, displayOverrides, undefined, layoutBounds)
  return invoke('export_artwork', { output, format, svg })
}
export type PdfExportProgress = { phase: 'artwork' | 'accessories' | 'prepare' | 'transfer' | 'rendering' | 'resources' | 'flatten' | 'fonts' | 'parse' | 'convert' | 'write' | 'page'; completed: number; total: number }
export function pdfProgressText(progress: PdfExportProgress) {
  const labels: Record<PdfExportProgress['phase'], string> = { artwork: '正在准备原始图片', accessories: '正在准备配件图片', prepare: '正在生成页面', transfer: '正在传输页面到导出服务', rendering: '正在初始化 PDF', resources: '正在加载配件和备注资源', flatten: '正在展开 SVG 图层', fonts: '正在准备字体', parse: '正在解析 SVG', convert: '正在转换矢量 PDF', write: '正在写入 PDF 文件', page: '已完成页面' }
  return `${labels[progress.phase]}（${progress.completed} / ${progress.total}）`
}
export async function exportPdf(pages: Page[], assets: Asset[], output: string, metadata: Partial<BatchMetadata> = {}, onProgress?: (progress: PdfExportProgress) => void, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>, layoutBounds: LayoutBounds = defaultLayoutBounds) {
  if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中导出')
  await prepareAccessoryFrames(pages, (completed, total) => onProgress?.({ phase: 'accessories', completed, total }))
  const map = new Map(assets.map(asset => [asset.id, asset]))
  const ids: string[] = []
  const resources = new StagedArtwork()
  const unlisten = await listen<PdfExportProgress>('pdf-export-progress', event => onProgress?.(event.payload))
  try {
    for (const page of pages) for (const item of page.items) {
      const svg = item.backSvg ?? map.get(item.assetId)?.svg
      if (!svg) throw new Error('页面中有丢失的图片资源，无法导出')
      resources.reference(svg)
    }
    await resources.write((completed, total) => onProgress?.({ phase: 'artwork', completed, total }))
    for (const [index, page] of pages.entries()) {
      onProgress?.({ phase: 'prepare', completed: index, total: pages.length })
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      const id = crypto.randomUUID()
      ids.push(id)
      // Only layout and resource references cross IPC, never base64 artwork.
      const svg = pageRasterSvg(page, map, metadata, pages.length, displayOverrides, resources.reference, layoutBounds)
      onProgress?.({ phase: 'transfer', completed: index, total: pages.length })
      if (svg.length <= 64 * 1024) await invoke('stage_pdf_page', { id, svg })
      else await writeStagedText(id, svg)
    }
    await invoke('export_staged_pdf', { output, ids })
  } finally {
    unlisten()
    await resources.dispose()
    await invoke('clear_pdf_pages', { ids }).catch(error => console.warn('PDF 临时页清理失败', error))
  }
}
