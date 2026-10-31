import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { writeStagedText } from '../schematic/services/stagedArtworkService'
import type { CmykExportPlan } from './impositionCmykExport'

/** SVG generation stays lazy: only the current page is generated/transferred. */
export interface ImpositionPdfExportPage {
  label: string
  /** Reuse this staged contour page for the layout's companion DXF. */
  exportDxf?: boolean
  renderSvg: () => string | Promise<string>
}

export interface ImpositionPdfExportEntry {
  fileName: string
  /** Ordinary PDF is enabled by default for existing callers. */
  exportPdf?: boolean
  widthMm: number
  heightMm: number
  pages: readonly ImpositionPdfExportPage[]
  cmyk?: CmykExportPlan
}

export interface ImpositionPdfExportProgress {
  phase: 'prepare' | 'transfer' | 'queue' | 'resources' | 'flatten' | 'fonts' | 'parse' | 'convert' | 'merge' | 'write' | 'dxf' | 'cmyk-align' | 'cmyk-color' | 'cmyk-zip' | 'cmyk-photoshop' | 'cmyk-window-skipped' | 'complete'
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
  warnings?: string[]
  cleanupWarnings: string[]
}

export async function chooseImpositionPdfDirectory(): Promise<string | null> {
  if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中导出 PDF')
  const directory = await open({ directory: true, multiple: false, title: '选择拼版 PDF 导出文件夹' })
  return typeof directory === 'string' ? directory : null
}

function outputPath(directory: string, fileName: string, extension = 'pdf'): string {
  if (!fileName || !fileName.toLowerCase().endsWith(`.${extension}`) || /[<>:"/\\|?*\u0000-\u001f]/u.test(fileName) || /[. ]$/u.test(fileName)) {
    throw new Error(`${extension.toUpperCase()} 文件名无效：${fileName}`)
  }
  return `${directory.replace(/[\\/]+$/u, '')}/${fileName}`
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

type StagedPdfEntry = {
  index: number
  entry: ImpositionPdfExportEntry
  output?: string
  id: string
  pageIds: string[]
  dxfPageId?: string
}

type PdfExportState = {
  staged: StagedPdfEntry
  fileName: string
  pageNumber: number
  cmyk?: boolean
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
  requestedEntries: readonly ImpositionPdfExportEntry[],
  onProgress?: (progress: ImpositionPdfExportProgress) => void,
): Promise<ImpositionPdfExportResult> {
  const result: ImpositionPdfExportResult = { completedFiles: [], cancelled: false, warnings: [], cleanupWarnings: [] }
  // A layout without content for any selected format produces no file/job.
  const entries = requestedEntries.filter(entry => entry.exportPdf !== false || entry.pages.some(page => page.exportDxf) || entry.cmyk)
  const states = new Map<string, PdfExportState>()
  const completed = new Set<number>()
  const completedDxfs = new Set<number>()
  const completedCmyks = new Set<number>()
  const finished = new Set<number>()
  let unlisten: (() => void) | undefined
  let failedFile = ''
  const report = (state: PdfExportState, phase: ImpositionPdfExportProgress['phase']) => onProgress?.({
    phase,
    completed: finished.size,
    total: entries.length,
    fileName: state.fileName,
    pageNumber: state.pageNumber,
    pageCount: state.cmyk ? state.staged.entry.cmyk?.sources.length : state.staged.entry.pages.length,
    pageName: state.cmyk ? state.staged.entry.cmyk?.sources[state.pageNumber - 1]?.label : state.staged.entry.pages[state.pageNumber - 1]?.label ?? '',
  })
  const cleanup = async (state: PdfExportState) => {
    if (!state.staged.pageIds.length) return
    await invoke('clear_pdf_pages', { ids: state.staged.pageIds }).catch(error => {
      result.cleanupWarnings.push(state.staged.entry.fileName + ' 的临时 SVG 清理失败：' + errorText(error))
    })
  }
  try {
    if (!isTauri()) throw new Error('请在 Tauri 桌面窗口中导出 PDF')
    if (!directory.trim() || entries.length === 0) throw new Error('请选择导出文件夹和至少一种有内容的导出文件类型')
    const outputs = entries.map(entry => {
      const path = outputPath(directory, entry.fileName)
      if (![entry.widthMm, entry.heightMm].every(n => Number.isFinite(n) && n > 0 && n <= 10_000)) throw new Error('板材毫米宽高无效')
      if (entry.exportPdf !== false && !entry.pages.length) throw new Error('版式没有可导出的页面：' + entry.fileName)
      return entry.exportPdf !== false ? path : undefined
    })
    const dxfOutputs = entries.map(entry => {
      const contours = entry.pages.filter(page => page.exportDxf)
      if (contours.length > 1) throw new Error('每种版式只能有一个轮廓 DXF 页面')
      return contours.length ? outputPath(directory, entry.fileName.replace(/\.pdf$/iu, '.dxf'), 'dxf') : undefined
    })
    const cmykOutputs = entries.map(entry => entry.cmyk ? outputPath(directory, `CMYK_${entry.fileName}`) : undefined)
    const selectedOutputs = outputs.flatMap((path, index) => [...(path ? [path] : []), ...(dxfOutputs[index] ? [dxfOutputs[index]!] : []), ...(cmykOutputs[index] ? [cmykOutputs[index]!] : [])])
    const names = new Set<string>()
    for (const path of selectedOutputs) {
      if (names.has(path.toLowerCase())) throw new Error('导出文件名重复：' + path)
      names.add(path.toLowerCase())
    }
    await invoke('check_imposition_pdf_outputs', { outputs: selectedOutputs })
    const nativeWorkers = await automaticExportWorkers()
    unlisten = await listen<{ id: string; phase: ImpositionPdfExportProgress['phase']; pageIndex?: number }>('imposition-pdf-export-progress', event => {
      const state = states.get(event.payload.id)
      if (!state) return
      if (event.payload.phase === 'queue') state.pageNumber = 0
      const index = event.payload.pageIndex
      const count = state.cmyk ? state.staged.entry.cmyk?.sources.length ?? 0 : state.staged.entry.pages.length
      if (index !== undefined && Number.isInteger(index) && index > 0 && index <= count) state.pageNumber = index
      if (event.payload.phase === 'cmyk-window-skipped') {
        const source = state.staged.entry.cmyk?.sources[state.pageNumber - 1]
        const warning = `${state.fileName}：${source?.label ?? '当前图片'} 的彩窗图层没有可见像素（可能完全在版面外或无法渲染），已跳过该图片的彩窗像素并继续导出；CMYK 与 White/C2/M2/Y2/K2 通道仍会生成。`
        const warnings = result.warnings ?? (result.warnings = [])
        if (!warnings.includes(warning)) warnings.push(warning)
      }
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
          if (!state.staged.output && !page.exportDxf) continue
          if (result.error) return false
          state.pageNumber = pageIndex + 1
          const pageId = crypto.randomUUID()
          state.staged.pageIds.push(pageId)
          if (page.exportDxf) state.staged.dxfPageId = pageId
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
          fileName: outputs[index] ? entries[index].fileName : dxfOutputs[index] ? entries[index].fileName.replace(/\.pdf$/iu, '.dxf') : `CMYK_${entries[index].fileName}`,
          pageNumber: 0,
        }
        try {
          if (!await stage(state)) return
          if (state.staged.output) {
            await invoke('export_imposition_pdf', {
              output: state.staged.output,
              id: state.staged.id,
              pageIds: [...state.staged.pageIds],
              widthMm: state.staged.entry.widthMm,
              heightMm: state.staged.entry.heightMm,
              workerCount: workersPerFile,
            })
            completed.add(state.staged.index)
          }
          const dxfOutput = dxfOutputs[index]
          if (dxfOutput) {
            state.fileName = state.staged.entry.fileName.replace(/\.pdf$/iu, '.dxf')
            state.pageNumber = state.staged.entry.pages.findIndex(page => page.exportDxf) + 1
            report(state, 'dxf')
            await invoke('export_imposition_dxf', {
              output: dxfOutput, pageId: state.staged.dxfPageId,
              widthMm: state.staged.entry.widthMm, heightMm: state.staged.entry.heightMm,
            })
            completedDxfs.add(index)
          }
          const cmykOutput = cmykOutputs[index]
          const cmyk = state.staged.entry.cmyk
          if (cmykOutput && cmyk) {
            state.fileName = `CMYK_${state.staged.entry.fileName}`
            state.cmyk = true
            const previous = stageTail
            let release!: () => void
            stageTail = new Promise<void>(resolve => { release = resolve })
            await previous
            let jobId = ''
            try {
              const { sources, ...metadata } = cmyk
              const stagedSources = []
              for (const [sourceIndex, source] of sources.entries()) {
                state.pageNumber = sourceIndex + 1
                const { front, back, window, ...details } = source
                const stageSource = async (render: () => string) => {
                  const id = crypto.randomUUID()
                  state.staged.pageIds.push(id)
                  report(state, 'prepare')
                  await new Promise<void>(resolve => setTimeout(resolve, 0))
                  await stagePage(id, { label: source.label, renderSvg: render }, () => report(state, 'transfer'))
                  return id
                }
                stagedSources.push({ ...details, frontId: await stageSource(front), backId: back ? await stageSource(back) : null, windowId: window ? await stageSource(window) : null })
              }
              jobId = crypto.randomUUID()
              state.staged.pageIds.push(jobId)
              await writeStagedText(jobId, JSON.stringify({ ...metadata, sources: stagedSources }))
            } finally { release() }
            await invoke('export_imposition_cmyk_pdf', { output: cmykOutput, id: state.staged.id, jobId })
            completedCmyks.add(index)
          }
          finished.add(index)
          report(state, 'complete')
        } catch (error) {
          if (!failedFile) failedFile = state.fileName
          result.error ??= errorText(error)
        } finally {
          await cleanup(state)
          states.delete(state.staged.id)
        }
      }
    }
    // Drain all in-flight jobs before cleanup/unlisten, even when one fails.
    await Promise.all(Array.from({ length: fileWorkers }, runNext))
    result.completedFiles = outputs.flatMap((path, index) => [...(completed.has(index) ? [path!] : []), ...(completedDxfs.has(index) ? [dxfOutputs[index]!] : []), ...(completedCmyks.has(index) ? [cmykOutputs[index]!] : [])])
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
