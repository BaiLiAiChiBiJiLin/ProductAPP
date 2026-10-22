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
  phase: 'prepare' | 'transfer' | 'queue' | 'resources' | 'flatten' | 'fonts' | 'parse' | 'convert' | 'merge' | 'write' | 'complete'
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

type StagedPdfEntry = {
  index: number
  entry: ImpositionPdfExportEntry
  output: string
  id: string
  pageIds: string[]
}

type PdfExportState = {
  staged: StagedPdfEntry
  pageNumber: number
}

/** Export conversion uses 80% of native logical CPUs without another UI knob. */
async function automaticExportWorkers(): Promise<number> {
  try {
    const info = await invoke<{ logicalCores: number }>('get_imposition_compute_info')
    if (info && Number.isSafeInteger(info.logicalCores) && info.logicalCores > 0) {
      return Math.max(1, Math.floor(info.logicalCores * .8))
    }
  } catch {
    return 1
  }
  return 1
}

/**
 * Keep at most two layout jobs in flight, sharing one native CPU budget.
 * SVG generation/transfer stays serial and lazy; conversion overlaps in isolated
 * workers. Do not clean staged resources until their native job has exited.
 */
export async function exportImpositionPdfs(
  directory: string,
  entries: readonly ImpositionPdfExportEntry[],
  onProgress?: (progress: ImpositionPdfExportProgress) => void,
): Promise<ImpositionPdfExportResult> {
  const result: ImpositionPdfExportResult = { completedFiles: [], cancelled: false, cleanupWarnings: [] }
  const states = new Map<string, PdfExportState>()
  const completed = new Set<number>()
  let unlisten: (() => void) | undefined
  let failedFile = ''
  const report = (state: PdfExportState, phase: ImpositionPdfExportProgress['phase']) => onProgress?.({
    phase,
    completed: completed.size,
    total: entries.length,
    fileName: state.staged.entry.fileName,
    pageNumber: state.pageNumber,
    pageCount: state.staged.entry.pages.length,
    pageName: state.staged.entry.pages[state.pageNumber - 1]?.label ?? '',
  })
  const cleanup = async (state: PdfExportState) => {
    if (!state.staged.pageIds.length) return
    await invoke('clear_pdf_pages', { ids: state.staged.pageIds }).catch(error => {
      result.cleanupWarnings.push(state.staged.entry.fileName + ' 的临时 SVG 清理失败：' + errorText(error))
    })
  }
  try {
    if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中导出 PDF')
    if (!directory.trim() || entries.length === 0) throw new Error('请选择导出文件夹和至少一个导出图层')
    const names = new Set<string>()
    const outputs = entries.map(entry => {
      const path = outputPath(directory, entry.fileName)
      if (names.has(path.toLowerCase())) throw new Error('导出文件名重复：' + entry.fileName)
      names.add(path.toLowerCase())
      if (![entry.widthMm, entry.heightMm].every(n => Number.isFinite(n) && n > 0 && n <= 10_000)) throw new Error('板材毫米宽高无效')
      if (!entry.pages.length) throw new Error('版式没有可导出的页面：' + entry.fileName)
      return path
    })
    await invoke('check_imposition_pdf_outputs', { outputs })
    const nativeWorkers = await automaticExportWorkers()
    unlisten = await listen<{ id: string; phase: ImpositionPdfExportProgress['phase']; pageIndex?: number }>('imposition-pdf-export-progress', event => {
      const state = states.get(event.payload.id)
      if (!state) return
      if (event.payload.phase === 'queue') state.pageNumber = 0
      const index = event.payload.pageIndex
      if (index !== undefined && Number.isInteger(index) && index > 0 && index <= state.staged.entry.pages.length) state.pageNumber = index
      report(state, event.payload.phase)
    })

    const fileWorkers = Math.min(entries.length, nativeWorkers, 2)
    const workersPerFile = Math.max(1, Math.floor(nativeWorkers / fileWorkers))
    let cursor = 0
    let stageTail = Promise.resolve()
    const stage = async (state: PdfExportState) => {
      const previous = stageTail
      let release!: () => void
      stageTail = new Promise<void>(resolve => { release = resolve })
      await previous
      try {
        if (result.error) return false
        states.set(state.staged.id, state)
        for (const [pageIndex, page] of state.staged.entry.pages.entries()) {
          if (result.error) return false
          state.pageNumber = pageIndex + 1
          const pageId = crypto.randomUUID()
          state.staged.pageIds.push(pageId)
          report(state, 'prepare')
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          if (result.error) return false
          await stagePage(pageId, page, () => report(state, 'transfer'))
        }
        return !result.error
      } finally {
        release()
      }
    }
    const runNext = async () => {
      while (!result.error) {
        const index = cursor++
        if (index >= entries.length) return
        const state: PdfExportState = {
          staged: { index, entry: entries[index], output: outputs[index], id: crypto.randomUUID(), pageIds: [] },
          pageNumber: 0,
        }
        try {
          if (!await stage(state)) return
          await invoke('export_imposition_pdf', {
            output: state.staged.output,
            id: state.staged.id,
            pageIds: state.staged.pageIds,
            widthMm: state.staged.entry.widthMm,
            heightMm: state.staged.entry.heightMm,
            workerCount: workersPerFile,
          })
          completed.add(state.staged.index)
          report(state, 'complete')
        } catch (error) {
          if (!failedFile) failedFile = state.staged.entry.fileName
          result.error ??= errorText(error)
        } finally {
          await cleanup(state)
          states.delete(state.staged.id)
        }
      }
    }
    // Drain all in-flight jobs before cleanup/unlisten, even when one fails.
    await Promise.all(Array.from({ length: fileWorkers }, runNext))
    result.completedFiles = outputs.filter((_, index) => completed.has(index))
    if (failedFile) result.failedFile = failedFile
  } catch (error) {
    result.error ??= errorText(error)
    if (failedFile) result.failedFile = failedFile
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
