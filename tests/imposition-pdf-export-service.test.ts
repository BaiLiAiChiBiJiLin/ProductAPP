import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), unlisten: vi.fn(), listener: undefined as undefined | ((event: { payload: { id: string; phase: string; pageIndex?: number } }) => void) }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async (_name: string, listener: typeof mocks.listener) => { mocks.listener = listener; return mocks.unlisten } }))
import { chooseImpositionPdfDirectory, exportImpositionPdfs, type ImpositionPdfExportEntry } from '../src/modules/imposition/impositionPdfExportService'

beforeEach(() => { mocks.invoke.mockReset(); mocks.open.mockReset(); mocks.unlisten.mockClear(); mocks.listener = undefined })
const entry = (name = '202610141800_1B-2B_1F-5F.pdf', labels = ['轮廓']): ImpositionPdfExportEntry => ({ fileName: name, widthMm: 300, heightMm: 464, pages: labels.map(label => ({ label, renderSvg: vi.fn(() => `<svg width="300mm" height="464mm"><title>${label}</title></svg>`) })) })

test('directory cancellation makes no staging or export call', async () => {
  mocks.open.mockResolvedValue(null)
  expect(await chooseImpositionPdfDirectory()).toBeNull()
  expect(mocks.invoke).not.toHaveBeenCalled()
})

test('preflight collisions stop the whole batch before rendering or writing', async () => {
  mocks.invoke.mockRejectedValue(new Error('文件已存在'))
  const page = entry()
  const result = await exportImpositionPdfs('D:/导出', [page])
  expect(result).toMatchObject({ completedFiles: [], error: '文件已存在' })
  expect(page.pages[0].renderSvg).not.toHaveBeenCalled()
  expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['check_imposition_pdf_outputs'])
})

test('stages ordered layers and creates one PDF per board with page progress and complete cleanup', async () => {
  const layers = ['轮廓', '图片1', '图片2', '彩窗', '白墨']
  const boards = [entry(undefined, layers), entry('第二版.pdf')]
  const progress = vi.fn()
  let count = 0
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'export_imposition_pdf') {
      expect(args).toMatchObject({ widthMm: 300, heightMm: 464 })
      expect(boards[1].pages[0].renderSvg).toHaveBeenCalledTimes(count)
      expect(args.pageIds).toHaveLength(count === 0 ? 5 : 1)
      expect(new Set(args.pageIds).size).toBe(args.pageIds.length)
      expect(args.pageIds).not.toContain(args.id)
      count++
      mocks.listener?.({ payload: { id: 'unrelated-export', phase: 'write' } })
      args.pageIds.forEach((_id: string, index: number) => mocks.listener?.({ payload: { id: args.id, phase: 'convert', pageIndex: index + 1 } }))
    }
  })
  const result = await exportImpositionPdfs('D:\\导出', boards, progress)
  expect(result.completedFiles).toHaveLength(2)
  expect(result.error).toBeUndefined()
  expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['check_imposition_pdf_outputs', 'get_imposition_compute_info', ...layers.map(() => 'stage_pdf_page'), 'export_imposition_pdf', 'clear_pdf_pages', 'stage_pdf_page', 'export_imposition_pdf', 'clear_pdf_pages'])
  const transferred = mocks.invoke.mock.calls.filter(call => call[0] === 'stage_pdf_page').map(call => call[1])
  layers.forEach((label, index) => expect(transferred[index].svg).toContain(`<title>${label}</title>`))
  const exports = mocks.invoke.mock.calls.filter(call => call[0] === 'export_imposition_pdf').map(call => call[1])
  expect(exports[0].pageIds).toEqual(transferred.slice(0, 5).map(page => page.id))
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'clear_pdf_pages').map(call => call[1].ids)).toEqual(exports.map(file => file.pageIds))
  expect(progress.mock.calls.map(call => call[0].phase)).not.toContain('write')
  expect(progress).toHaveBeenCalledWith({ phase: 'convert', completed: 0, total: 2, fileName: boards[0].fileName, pageNumber: 3, pageCount: 5, pageName: '图片2' })
  expect(progress).toHaveBeenLastCalledWith({ phase: 'complete', completed: 2, total: 2, fileName: '第二版.pdf', pageNumber: 1, pageCount: 1, pageName: '轮廓' })
  expect(mocks.unlisten).toHaveBeenCalledOnce()
})

test('later conversion failure preserves completed files, cleans current stage, and does not render later groups', async () => {
  const pages = [entry(), entry('二.pdf'), entry('三.pdf')]
  let count = 0
  mocks.invoke.mockImplementation(async command => { if (command === 'export_imposition_pdf' && ++count === 2) throw new Error('写入失败') })
  const result = await exportImpositionPdfs('D:/导出', pages)
  expect(result).toMatchObject({ completedFiles: [`D:/导出/${pages[0].fileName}`], failedFile: '二.pdf', error: '写入失败' })
  expect(pages[2].pages[0].renderSvg).not.toHaveBeenCalled()
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'clear_pdf_pages')).toHaveLength(2)
})

test('large SVG transfers in bounded Unicode-safe chunks; failed transfer is cleaned', async () => {
  const svg = '<svg>' + 'x'.repeat(65_530) + '🌸中文' + 'x'.repeat(200_000) + '</svg>'
  const chunks: string[] = []
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'write_export_resource_chunk') { chunks.push(args.text); expect(args.text.length).toBeLessThanOrEqual(65_536) }
  })
  const large = { ...entry(), pages: [{ label: '图片1', renderSvg: () => svg }] }
  const result = await exportImpositionPdfs('D:/导出', [large])
  expect(result.error).toBeUndefined()
  expect(chunks.join('')).toBe(svg)
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'stage_pdf_page')).toBe(false)
  mocks.invoke.mockImplementation(async command => { if (command === 'write_export_resource_chunk') throw new Error('传输失败') })
  expect((await exportImpositionPdfs('D:/导出', [large])).error).toBe('传输失败')
  expect(mocks.invoke).toHaveBeenLastCalledWith('clear_pdf_pages', { ids: [expect.any(String)] })
})

test('rejects duplicate names, traversal, and invalid board dimensions before IPC', async () => {
  for (const entries of [[entry(), entry()], [entry('../unsafe.pdf')], [{ ...entry(), widthMm: Number.NaN }], [entry('无页面.pdf', [])]]) {
    expect((await exportImpositionPdfs('D:/导出', entries)).error).toBeTruthy()
  }
  expect(mocks.invoke).not.toHaveBeenCalled()
})

test('failed middle page cleans every attempted stage without exporting an incomplete board', async () => {
  const board = entry(undefined, ['轮廓', '图片1', '彩窗'])
  const later = entry('later.pdf')
  let transferred = 0
  mocks.invoke.mockImplementation(async command => {
    if (command === 'stage_pdf_page' && ++transferred === 2) throw new Error('第二页传输失败')
  })
  const result = await exportImpositionPdfs('D:/导出', [board, later])
  expect(result).toMatchObject({ completedFiles: [], failedFile: board.fileName, error: '第二页传输失败' })
  expect(board.pages[2].renderSvg).not.toHaveBeenCalled()
  expect(later.pages[0].renderSvg).not.toHaveBeenCalled()
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'export_imposition_pdf')).toBe(false)
  const ids = mocks.invoke.mock.calls.filter(call => call[0] === 'stage_pdf_page').map(call => call[1].id)
  expect(mocks.invoke).toHaveBeenLastCalledWith('clear_pdf_pages', { ids })
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('shares the automatic 80% CPU budget across two layouts and returns out-of-order completions in board order', async () => {
  const boards = [entry('一.pdf', ['轮廓', '图片1', '彩窗', '白墨']), entry('二.pdf'), entry('三.pdf')]
  const jobs = [deferred(), deferred(), deferred()]
  const args: Array<{ id: string; pageIds: string[]; workerCount: number }> = []
  const progress = vi.fn()
  mocks.invoke.mockImplementation(async (command, parameters) => {
    if (command === 'get_imposition_compute_info') return { logicalCores: 10 }
    if (command === 'export_imposition_pdf') {
      const index = args.length
      args.push(parameters)
      return jobs[index].promise
    }
  })
  const pending = exportImpositionPdfs('D:/导出', boards, progress)
  await vi.waitFor(() => expect(args).toHaveLength(2))
  expect(args.map(arg => arg.workerCount)).toEqual([4, 4])
  expect(boards[2].pages[0].renderSvg).not.toHaveBeenCalled()
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'clear_pdf_pages')).toHaveLength(0)
  mocks.listener?.({ payload: { id: args[0].id, phase: 'merge', pageIndex: 3 } })
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ fileName: '一.pdf', pageName: '彩窗', phase: 'merge' }))
  jobs[1].resolve()
  await vi.waitFor(() => expect(args).toHaveLength(3))
  jobs[2].resolve()
  jobs[0].resolve()
  expect(await pending).toMatchObject({ completedFiles: ['D:/导出/一.pdf', 'D:/导出/二.pdf', 'D:/导出/三.pdf'] })
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'clear_pdf_pages')).toHaveLength(3)
})

test('parallel failure stops queued layouts and drains the other native job before releasing resources', async () => {
  const boards = [entry('一.pdf'), entry('二.pdf'), entry('三.pdf')]
  const first = deferred(), second = deferred()
  let exports = 0
  mocks.invoke.mockImplementation(async command => {
    if (command === 'get_imposition_compute_info') return { logicalCores: 16 }
    if (command === 'export_imposition_pdf') return (++exports === 1 ? first : second).promise
  })
  const pending = exportImpositionPdfs('D:/导出', boards)
  await vi.waitFor(() => expect(exports).toBe(2))
  first.reject(new Error('PDF 后台进程退出'))
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(call => call[0] === 'clear_pdf_pages')).toHaveLength(1))
  expect(mocks.unlisten).not.toHaveBeenCalled()
  expect(boards[2].pages[0].renderSvg).not.toHaveBeenCalled()
  second.resolve()
  expect(await pending).toMatchObject({ completedFiles: ['D:/导出/二.pdf'], failedFile: '一.pdf', error: 'PDF 后台进程退出' })
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'clear_pdf_pages')).toHaveLength(2)
  expect(mocks.unlisten).toHaveBeenCalledOnce()
})

test('generates/transfers only one SVG at a time even when file conversion is parallel', async () => {
  const firstRender = deferred<string>()
  const first = { ...entry('一.pdf'), pages: [{ label: '轮廓', renderSvg: vi.fn(() => firstRender.promise) }] }
  const second = entry('二.pdf')
  mocks.invoke.mockImplementation(async command => command === 'get_imposition_compute_info' ? { logicalCores: 8 } : undefined)
  const pending = exportImpositionPdfs('D:/导出', [first, second])
  await vi.waitFor(() => expect(first.pages[0].renderSvg).toHaveBeenCalledOnce())
  expect(second.pages[0].renderSvg).not.toHaveBeenCalled()
  firstRender.resolve('<svg/>')
  expect((await pending).completedFiles).toHaveLength(2)
})
