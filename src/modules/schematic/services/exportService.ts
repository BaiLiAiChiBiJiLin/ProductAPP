import { prepareAccessoryFrames } from './accessoryFrameService.ts'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { pageRasterSvg, pageSvg, type Asset, type Page } from '../../../model'
import type { BatchMetadata } from '../types'
export async function exportPage(page: Page, assets: Asset[], output: string, format = 'svg', metadata: Partial<BatchMetadata> = {}, totalPages = 1) { if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中导出'); await prepareAccessoryFrames([page]); const map = new Map(assets.map(a => [a.id, a])); const svg = format === 'svg' ? pageSvg(page, map, metadata, totalPages) : pageRasterSvg(page, map, metadata, totalPages); return invoke('export_artwork', { output, format, svg }) }
export type PdfExportProgress = { phase: 'accessories' | 'prepare' | 'transfer' | 'rendering' | 'resources' | 'flatten' | 'fonts' | 'parse' | 'convert' | 'write' | 'page'; completed: number; total: number }
export function pdfProgressText(progress: PdfExportProgress) {
  const labels: Record<PdfExportProgress['phase'], string> = { accessories: '正在准备配件图片', prepare: '正在生成页面', transfer: '正在传输页面到导出服务', rendering: '正在初始化 PDF', resources: '正在加载配件和备注资源', flatten: '正在展开 SVG 图层', fonts: '正在准备字体', parse: '正在解析 SVG', convert: '正在转换矢量 PDF', write: '正在写入 PDF 文件', page: '已完成页面' }
  return `${labels[progress.phase]}（${progress.completed} / ${progress.total}）`
}
export async function exportPdf(pages: Page[], assets: Asset[], output: string, metadata: Partial<BatchMetadata> = {}, onProgress?: (progress: PdfExportProgress) => void) {
  if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中导出')
  await prepareAccessoryFrames(pages, (completed, total) => onProgress?.({ phase: 'accessories', completed, total }))
  const map = new Map(assets.map(asset => [asset.id, asset]))
  const ids: string[] = []
  const unlisten = await listen<PdfExportProgress>('pdf-export-progress', event => onProgress?.(event.payload))
  try {
    for (const [index, page] of pages.entries()) {
      onProgress?.({ phase: 'prepare', completed: index, total: pages.length })
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      const id = crypto.randomUUID()
      ids.push(id)
      // Await each transfer before generating the next page. Never retain an
      // array of base64-heavy page strings in the WebView.
      const svg = pageRasterSvg(page, map, metadata, pages.length)
      onProgress?.({ phase: 'transfer', completed: index, total: pages.length })
      await invoke('stage_pdf_page', { id, svg })
    }
    await invoke('export_staged_pdf', { output, ids })
  } finally {
    unlisten()
    await invoke('clear_pdf_pages', { ids }).catch(error => console.warn('PDF 临时页清理失败', error))
  }
}
