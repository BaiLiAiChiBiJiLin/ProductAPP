import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), unlisten: vi.fn(), listener: undefined as undefined | ((event: { payload: { id: string; phase: string } }) => void) }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async (_name: string, listener: typeof mocks.listener) => { mocks.listener = listener; return mocks.unlisten } }))
import { chooseImpositionPdfDirectory, exportImpositionPdfs, type ImpositionPdfExportEntry } from '../src/modules/imposition/impositionPdfExportService'

beforeEach(() => { mocks.invoke.mockReset(); mocks.open.mockReset(); mocks.unlisten.mockClear(); mocks.listener = undefined })
const entry = (name = '图层_20261013_01_01_5F.pdf'): ImpositionPdfExportEntry => ({ fileName: name, widthMm: 300, heightMm: 464, renderSvg: vi.fn(() => '<svg width="300mm" height="464mm"/>') })

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
  expect(page.renderSvg).not.toHaveBeenCalled()
  expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['check_imposition_pdf_outputs'])
})

test('groups render one at a time, keep board mm, report current progress and clean every stage', async () => {
  const pages = [entry(), entry('第二组.pdf')]
  const progress = vi.fn()
  let count = 0
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'export_imposition_pdf') {
      expect(args).toMatchObject({ widthMm: 300, heightMm: 464 })
      expect(pages[1].renderSvg).toHaveBeenCalledTimes(count++)
      mocks.listener?.({ payload: { id: 'unrelated-export', phase: 'write' } })
      mocks.listener?.({ payload: { id: args.id, phase: 'convert' } })
    }
  })
  const result = await exportImpositionPdfs('D:\\导出', pages, progress)
  expect(result.completedFiles).toHaveLength(2)
  expect(result.error).toBeUndefined()
  expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['check_imposition_pdf_outputs', 'stage_pdf_page', 'export_imposition_pdf', 'clear_pdf_pages', 'stage_pdf_page', 'export_imposition_pdf', 'clear_pdf_pages'])
  expect(progress.mock.calls.map(call => call[0].phase)).not.toContain('write')
  expect(progress).toHaveBeenLastCalledWith({ phase: 'complete', completed: 2, total: 2, fileName: '第二组.pdf' })
  expect(mocks.unlisten).toHaveBeenCalledOnce()
})

test('later conversion failure preserves completed files, cleans current stage, and does not render later groups', async () => {
  const pages = [entry(), entry('二.pdf'), entry('三.pdf')]
  let count = 0
  mocks.invoke.mockImplementation(async command => { if (command === 'export_imposition_pdf' && ++count === 2) throw new Error('写入失败') })
  const result = await exportImpositionPdfs('D:/导出', pages)
  expect(result).toMatchObject({ completedFiles: [`D:/导出/${pages[0].fileName}`], failedFile: '二.pdf', error: '写入失败' })
  expect(pages[2].renderSvg).not.toHaveBeenCalled()
  expect(mocks.invoke.mock.calls.filter(call => call[0] === 'clear_pdf_pages')).toHaveLength(2)
})

test('large SVG transfers in bounded Unicode-safe chunks; failed transfer is cleaned', async () => {
  const svg = '<svg>' + 'x'.repeat(65_530) + '🌸中文' + 'x'.repeat(200_000) + '</svg>'
  const chunks: string[] = []
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'write_export_resource_chunk') { chunks.push(args.text); expect(args.text.length).toBeLessThanOrEqual(65_536) }
  })
  const result = await exportImpositionPdfs('D:/导出', [{ ...entry(), renderSvg: () => svg }])
  expect(result.error).toBeUndefined()
  expect(chunks.join('')).toBe(svg)
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'stage_pdf_page')).toBe(false)
  mocks.invoke.mockImplementation(async command => { if (command === 'write_export_resource_chunk') throw new Error('传输失败') })
  expect((await exportImpositionPdfs('D:/导出', [{ ...entry(), renderSvg: () => svg }])).error).toBe('传输失败')
  expect(mocks.invoke).toHaveBeenLastCalledWith('clear_pdf_pages', { ids: [expect.any(String)] })
})

test('rejects duplicate names, traversal, and invalid board dimensions before IPC', async () => {
  for (const entries of [[entry(), entry()], [entry('../unsafe.pdf')], [{ ...entry(), widthMm: Number.NaN }]]) {
    expect((await exportImpositionPdfs('D:/导出', entries)).error).toBeTruthy()
  }
  expect(mocks.invoke).not.toHaveBeenCalled()
})
