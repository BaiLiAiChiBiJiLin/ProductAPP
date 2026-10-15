import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { writeStagedText } from '../schematic/services/stagedArtworkService'

/** SVG generation stays lazy: only the current page is generated/transferred. */
export interface ImpositionPdfExportPage {
  label: string
  renderSvg: () => string | Promise<string>
}

export interface ImpositionPdfExportEntry {
  fileName: string
  widthMm: number
  heightMm: number
  pages: readonly ImpositionPdfExportPage[]
}

export interface ImpositionPdfExportProgress {
  phase: 'prepare' | 'transfer' | 'resources' | 'flatten' | 'fonts' | 'parse' | 'convert' | 'write' | 'complete'
  completed: number
  total: number
  fileName: string
  pageNumber?: number
  pageCount?: number
  pageName?: string
}

export interface ImpositionPdfExportResult {
  completedFiles: string[]
  cancelled: false
  failedFile?: string
  error?: string
  cleanupWarnings: string[]
}

export async function chooseImpositionPdfDirectory(): Promise<string | null> {
  if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中导出 PDF')
  const directory = await open({ directory: true, multiple: false, title: '选择拼版 PDF 导出文件夹' })
  return typeof directory === 'string' ? directory : null
}

function outputPath(directory: string, fileName: string): string {
  if (!fileName || !fileName.toLowerCase().endsWith('.pdf') || /[<>:"/\\|?*\u0000-\u001f]/u.test(fileName) || /[. ]$/u.test(fileName)) {
    throw new Error(`PDF 文件名无效：${fileName}`)
  }
  return `${directory.replace(/[\\/]+$/u, '')}/${fileName}`
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/**
 * Preflight the entire batch before writing anything, then publish one complete
 * PDF at a time. A later failure returns already completed paths for the dialog.
 * The dialog is busy until this resolves; cancelling directory selection never
 * invokes this function and never writes a file.
 */
export async function exportImpositionPdfs(
  directory: string,
  entries: readonly ImpositionPdfExportEntry[],
  onProgress?: (progress: ImpositionPdfExportProgress) => void,
): Promise<ImpositionPdfExportResult> {
  const result: ImpositionPdfExportResult = { completedFiles: [], cancelled: false, cleanupWarnings: [] }
  let activeId = ''
  let currentFile = ''
  let currentEntry: ImpositionPdfExportEntry | undefined
  let pageNumber = 0
  let unlisten: (() => void) | undefined
  const report = (phase: ImpositionPdfExportProgress['phase']) => onProgress?.({
    phase, completed: result.completedFiles.length, total: entries.length, fileName: currentFile,
    pageNumber, pageCount: currentEntry?.pages.length ?? 0, pageName: currentEntry?.pages[pageNumber - 1]?.label ?? '',
  })
  try {
    if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中导出 PDF')
    if (!directory.trim() || entries.length === 0) throw new Error('请选择导出文件夹和至少一个导出图层')
    const names = new Set<string>()
    const outputs = entries.map(entry => {
      const path = outputPath(directory, entry.fileName)
      if (names.has(path.toLowerCase())) throw new Error(`导出文件名重复：${entry.fileName}`)
      names.add(path.toLowerCase())
      if (![entry.widthMm, entry.heightMm].every(n => Number.isFinite(n) && n > 0 && n <= 10_000)) throw new Error('板材毫米宽高无效')
      if (!entry.pages.length) throw new Error(`版式没有可导出的页面：${entry.fileName}`)
      return path
    })
    await invoke('check_imposition_pdf_outputs', { outputs })
    unlisten = await listen<{ id: string; phase: ImpositionPdfExportProgress['phase']; pageIndex?: number }>('imposition-pdf-export-progress', event => {
      if (event.payload.id !== activeId) return
      const index = event.payload.pageIndex
      if (index !== undefined && Number.isInteger(index) && index > 0 && index <= (currentEntry?.pages.length ?? 0)) pageNumber = index
      report(event.payload.phase)
    })
    for (const [index, entry] of entries.entries()) {
      currentFile = entry.fileName
      currentEntry = entry
      pageNumber = 0
      activeId = crypto.randomUUID()
      const pageIds: string[] = []
      try {
        for (const [pageIndex, page] of entry.pages.entries()) {
          pageNumber = pageIndex + 1
          const pageId = crypto.randomUUID()
          pageIds.push(pageId)
          report('prepare')
          // Yield before generating each large page; release its SVG string
          // after transfer instead of holding all board layers in a single IPC.
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          await stagePage(pageId, page, () => report('transfer'))
        }
        await invoke('export_imposition_pdf', { output: outputs[index], id: activeId, pageIds, widthMm: entry.widthMm, heightMm: entry.heightMm })
        result.completedFiles.push(outputs[index])
        report('complete')
      } finally {
        await invoke('clear_pdf_pages', { ids: pageIds }).catch(error => {
          result.cleanupWarnings.push(`${currentFile} 的临时 SVG 清理失败：${errorText(error)}`)
        })
        activeId = ''
        currentEntry = undefined
      }
    }
  } catch (error) {
    result.error = errorText(error)
    if (currentFile) result.failedFile = currentFile
  } finally {
    unlisten?.()
  }
  return result
}

async function stagePage(id: string, page: ImpositionPdfExportPage, onTransfer: () => void) {
  const svg = await page.renderSvg()
  if (!svg.trim()) throw new Error(`${page.label}没有可导出的 SVG 内容`)
  onTransfer()
  if (svg.length <= 64 * 1024) await invoke('stage_pdf_page', { id, svg })
  else await writeStagedText(id, svg)
}
