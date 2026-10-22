import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import ImpositionPdfExportModal from '../src/modules/imposition/ImpositionPdfExportModal'
import type { ProductionImage } from '../src/modules/imposition/impositionRecords'
import type { PackedItem } from '../src/modules/imposition/packingAlgorithms'
import type { ImpositionPdfExportEntry, ImpositionPdfExportProgress, ImpositionPdfExportResult } from '../src/modules/imposition/impositionPdfExportService'

const mocks = vi.hoisted(() => ({ loadImage: vi.fn(), chooseDirectory: vi.fn(), exportPdfs: vi.fn(), invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../src/modules/imposition/impositionRecords', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/imposition/impositionRecords')>(),
  loadImpositionImage: mocks.loadImage,
}))
vi.mock('../src/modules/imposition/impositionPdfExportService', () => ({
  chooseImpositionPdfDirectory: mocks.chooseDirectory, exportImpositionPdfs: mocks.exportPdfs,
}))

const knownSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 20 10">
  <path id="cut" d="M1 1H19V9H1Z" fill="none" stroke="magenta"/>
  <image id="artwork" width="20" height="10" href="data:image/png;base64,iVBORw0KGgo="/>
  <rect id="white" width="18" height="8" x="1" y="1" fill="white"/>
</svg>`
const unknownSvg = knownSvg.replace('</svg>', '<text id="note" x="2" y="5">订单备注</text></svg>')
const image: ProductionImage = {
  id: 'art', name: '挂件.svg', sourceFileName: '原始挂件.svg', filePath: 'D:/assets/原始挂件.svg',
  widthMm: 20, heightMm: 10, productId: '', productName: '', attributes: { QT: '5' }, attributeImages: {},
  note: '', noteImage: null, productGroupId: '', productGroupLeaderId: '', productGroupPosition: 0,
}
function piece(index = 0, x = 10): PackedItem {
  return { image: { ...image, id: index ? `art#qt-${index + 1}` : 'art', sourceImageId: 'art' }, x, y: 12, width: 20, height: 10, rotation: 90 }
}
function mount(pages: PackedItem[][], svg = knownSvg, options: { load?: boolean; onClose?: () => void; holes?: boolean; sources?: Record<string, string> } = {}) {
  mocks.loadImage.mockResolvedValue(svg)
  return render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPdfExportModal pages={pages} imageSources={options.load ? {} : options.sources ?? { art: svg }} widthMm={300} heightMm={464} holes={options.holes ? { count: 2, sizeMm: 3, gapMm: 203.468, leftMm: 4 } : undefined} onClose={options.onClose ?? vi.fn()}/></ConfigProvider>)
}
const exportButton = () => screen.getByRole('button', { name: /选择文件夹并导出/ }) as HTMLButtonElement
async function choose(name: string, label: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name }))
  const option = await waitFor(() => {
    const node = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')).find(element => element.getAttribute('title') === label)
    expect(node).toBeTruthy()
    return node!
  })
  fireEvent.click(option)
}
async function ready() { await screen.findByRole('checkbox', { name: '选择图层 cut' }) }
function entries() { return mocks.exportPdfs.mock.calls.at(-1)![1] as ImpositionPdfExportEntry[] }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const blobs = new Map<string, Blob>()
async function svgFromPreview() {
  const image = await screen.findByRole('img', { name: '当前版式的导出位置预览' }) as HTMLImageElement
  const blob = blobs.get(image.src)!
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob) })
}

beforeEach(() => {
  vi.clearAllMocks()
  blobs.clear()
  mocks.chooseDirectory.mockResolvedValue('D:/exports')
  mocks.exportPdfs.mockResolvedValue({ completedFiles: [], cancelled: false, cleanupWarnings: [] })
  mocks.invoke.mockResolvedValue('data:image/png;base64,dGlueQ==')
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn((blob: Blob) => { const url = `blob:svg-preview-${blobs.size}`; blobs.set(url, blob); return url }) })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element))
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('shows the common loading animation before parsing and exports repeated boards once with their real plate holes', async () => {
  mount(Array.from({ length: 5 }, (_, index) => [piece(index)]), knownSvg, { load: true, holes: true })
  expect(screen.getByText('读取已拼版的 SVG 图层…')).toBeTruthy()
  expect(screen.getByRole('progressbar')).toBeTruthy()
  expect(mocks.loadImage).not.toHaveBeenCalled()
  await ready()
  expect(mocks.loadImage).toHaveBeenCalledExactlyOnceWith(image.filePath)
  expect(screen.getByText('1 张图片 · 5F')).toBeTruthy()
  expect(screen.getByText(/1 种版式 · 1 个 PDF/)).toBeTruthy()
  expect(screen.queryByText('导出分组')).toBeNull()
  expect(screen.getByText('板材 300 × 464 mm、版面孔与图片当前位置；相同版式只导出一份。')).toBeTruthy()
  expect(screen.queryByText(/整块板材上的 SVG 按图片图层顺序合并/)).toBeNull()
  expect(screen.queryByRole('textbox', { name: '文件名前缀' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '批量归组' })).toBeNull()
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()).toHaveLength(1)
  expect(entries()[0].fileName).toMatch(/^\d{12}_1B-1B_1F-5F\.pdf$/)
  expect(entries()[0]).toMatchObject({ widthMm: 300, heightMm: 464 })
  expect(entries()[0].pages.map(page => page.label)).toEqual(['轮廓 / 路径', '图片 1（全板）', '彩窗'])
  const rendered = await Promise.all(entries()[0].pages.map(page => page.renderSvg()))
  for (const [index] of entries()[0].pages.entries()) {
    const root = new DOMParser().parseFromString(rendered[index], 'image/svg+xml').documentElement
    expect(root.getAttribute('width')).toBe('300mm')
    expect(root.getAttribute('height')).toBe('464mm')
    expect(root.querySelectorAll('g[data-placement-id]')).toHaveLength(1)
    expect(root.querySelector('g[data-placement-id]')?.getAttribute('transform')).toBe('translate(15 22) rotate(90) translate(-10 -5)')
    const holes = root.querySelector('[data-board-holes]')!
    expect(holes.getAttribute('fill')).toBe(index === 0 ? 'none' : '#000000')
    expect(holes.getAttribute('stroke')).toBe(index === 0 ? '#2563eb' : 'none')
    expect(holes.querySelectorAll('path')).toHaveLength(2)
    expect(Array.from(holes.querySelectorAll('path'), path => path.getAttribute('d'))).toEqual([
      'M 4 131.766 A 1.5 1.5 0 1 0 7 131.766 A 1.5 1.5 0 1 0 4 131.766 Z',
      'M 4 332.234 A 1.5 1.5 0 1 0 7 332.234 A 1.5 1.5 0 1 0 4 332.234 Z',
    ])
  }
  expect(rendered[0]).toContain('magenta')
  expect(rendered[0]).not.toContain('<image')
  expect(rendered[1]).toContain('<image')
  expect(rendered[2]).toContain('fill="white"')
})

it('applies layer types to same-name SVGs across distinct source IDs without changing other filenames', async () => {
  const sameName = { ...piece(1, 40), image: { ...image, id: 'other-source', sourceImageId: 'other-source', filePath: 'D:/other/原始挂件.svg' } }
  const differentName = { ...piece(2, 80), image: { ...image, id: 'different-source', sourceImageId: 'different-source', filePath: 'D:/other/其他挂件.svg' } }
  mount([[piece()], [sameName], [differentName]], unknownSvg, { load: true })
  await ready()
  expect(exportButton().disabled).toBe(true)
  expect(screen.getByText(/还有 3 个待确认图层/)).toBeTruthy()
  await choose('图层 note 类型', '轮廓 / 路径')
  expect(screen.getByText(/还有 2 个待确认图层/)).toBeTruthy()
  const apply = screen.getByRole('button', { name: '应用到同名svg' })
  expect(apply.classList.contains('ant-btn-primary')).toBe(true)
  fireEvent.click(apply)
  await screen.findByText(/还有 1 个待确认图层/)
  expect(exportButton().disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '导出版式 3' }))
  await waitFor(() => expect(exportButton().disabled).toBe(false))
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()).toHaveLength(2)
  for (const entry of entries()) expect(await entry.pages[0].renderSvg()).toContain('订单备注')
})

it('offers fixed layer types including white ink and omit, and merges layers with the same non-image type', async () => {
  mount([[piece()], [piece(1, 40)]])
  await ready()
  fireEvent.click(screen.getByRole('checkbox', { name: '导出版式 2' }))
  await choose('图层 artwork 类型', '不导出')
  await choose('图层 cut 类型', '白墨')
  await choose('图层 white 类型', '白墨')
  expect(screen.queryByRole('textbox', { name: '新分组名称' })).toBeNull()
  expect(screen.getByText(/1 种版式 · 1 个 PDF/)).toBeTruthy()
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()).toHaveLength(1)
  expect(entries()[0].pages).toHaveLength(1)
  const svg = await entries()[0].pages[0].renderSvg()
  expect(entries()[0].pages[0].label).toBe('白墨')
  expect(svg).toContain('magenta')
  expect(svg).toContain('fill="white"')
  expect(svg).not.toContain('<image')
})

it('combines corresponding image layers into separate pages of one whole-board PDF and previews each channel independently', async () => {
  const multipleImages = knownSvg.replace('</svg>', '<image id="back" width="20" height="10" href="data:image/png;base64,QkFDSw=="/></svg>')
  const otherSvg = knownSvg.replace('iVBORw0KGgo=', 'T1RIRVI=')
  const other = { ...piece(2, 70), image: { ...image, id: 'other', sourceImageId: 'other', filePath: 'D:/assets/other.svg' } }
  const otherCopy = { ...other, x: 100, image: { ...other.image, id: 'other#qt-2' } }
  mount([[piece(), piece(1, 40), other, otherCopy]], multipleImages, { sources: { art: multipleImages, other: otherSvg } })
  await ready()
  expect(screen.getByText(/1 种版式 · 1 个 PDF/)).toBeTruthy()
  expect(screen.getByText('版式 1 · 4 页')).toBeTruthy()
  await screen.findByRole('img', { name: '当前版式的导出位置预览' })
  await choose('预览类型', '全部图片图层')
  expect(screen.getByText('生成板材预览…')).toBeTruthy()
  expect(screen.queryByRole('img', { name: '当前版式的导出位置预览' })).toBeNull()
  const preview = await svgFromPreview()
  expect(preview).toContain('iVBORw0KGgo=')
  expect(preview).toContain('QkFDSw==')
  expect(preview).toContain('T1RIRVI=')
  await choose('预览类型', '图片 1（全板）')
  const firstChannel = await svgFromPreview()
  expect(firstChannel).toContain('iVBORw0KGgo=')
  expect(firstChannel).toContain('T1RIRVI=')
  expect(firstChannel).not.toContain('QkFDSw==')
  await choose('预览类型', '图片 2（全板）')
  const secondChannel = await svgFromPreview()
  expect(secondChannel).toContain('QkFDSw==')
  expect(secondChannel).not.toContain('iVBORw0KGgo=')
  expect(secondChannel).not.toContain('T1RIRVI=')
  expect(document.querySelector('.imposition-export-file-list')?.textContent).toContain('图片 1（全板）')
  expect(document.querySelector('.imposition-export-file-list')?.textContent).toContain('图片 2（全板）')
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()).toHaveLength(1)
  const imageEntries = entries()[0].pages.filter(value => value.label.startsWith('图片'))
  expect(imageEntries).toHaveLength(2)
  expect(imageEntries.map(value => value.label)).toEqual(['图片 1（全板）', '图片 2（全板）'])
  const outputs = await Promise.all(imageEntries.map(entry => entry.renderSvg()))
  for (const [index, svg] of outputs.entries()) {
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
    expect(root.querySelectorAll('image')).toHaveLength(index === 0 ? 2 : 1)
    expect(root.querySelectorAll('g[data-placement-id]')).toHaveLength(index === 0 ? 4 : 2)
  }
  expect(outputs.filter(svg => svg.includes('iVBORw0KGgo='))).toHaveLength(1)
  expect(outputs.filter(svg => svg.includes('QkFDSw=='))).toHaveLength(1)
  expect(outputs[0]).toContain('T1RIRVI=')
  expect(outputs[1]).not.toContain('T1RIRVI=')
})

it('loads small backend thumbnails only when visible without creating full SVG dropdown Blobs', async () => {
  const observers: { callback: IntersectionObserverCallback; target?: Element; disconnect: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('IntersectionObserver', class {
    state: typeof observers[number]
    constructor(callback: IntersectionObserverCallback) { this.state = { callback, disconnect: vi.fn() }; observers.push(this.state) }
    observe(target: Element) { this.state.target = target }
    disconnect() { this.state.disconnect() }
  })
  const thumbnailPath = 'D:/assets/dropdown-memory-test.svg'
  const item = { ...piece(), image: { ...piece().image, filePath: thumbnailPath } }
  const { unmount } = mount([[item]])
  await ready()
  await screen.findByRole('img', { name: '当前版式的导出位置预览' })
  await screen.findByRole('img', { name: '当前 SVG 原图' })
  expect(observers).toHaveLength(0)
  const count = vi.mocked(URL.createObjectURL).mock.calls.length
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '选择 SVG' }))
  await waitFor(() => expect(observers.length).toBeGreaterThan(0))
  expect(vi.mocked(URL.createObjectURL).mock.calls).toHaveLength(count)
  expect(mocks.invoke).not.toHaveBeenCalled()
  act(() => observers[0].callback([{ isIntersecting: true, target: observers[0].target! } as IntersectionObserverEntry], {} as IntersectionObserver))
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('load_imposition_thumbnail', { path: thumbnailPath }))
  await waitFor(() => expect(screen.getByRole('img', { name: 'dropdown-memory-test.svg' }).getAttribute('src')).toBe('data:image/png;base64,dGlueQ=='))
  expect(vi.mocked(URL.createObjectURL).mock.calls).toHaveLength(count)
  unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(count)
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
})

it('defers layer preview changes and never labels a previous SVG as the newly selected layer', async () => {
  mount([[piece()]])
  await ready()
  const original = await screen.findByRole('img', { name: '当前 SVG 原图' })
  const slot = original.closest('.imposition-export-source-artwork')!
  expect(slot).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: '选择图层 cut' }))
  expect(screen.getByText('生成图层预览…').closest('.imposition-export-source-artwork')).toBe(slot)
  expect(screen.queryByRole('img', { name: '选中图层预览' })).toBeNull()
  const image = await screen.findByRole('img', { name: '选中图层预览' }) as HTMLImageElement
  expect(image.closest('.imposition-export-source-artwork')).toBe(slot)
  const blob = blobs.get(image.src)!
  const svg = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob) })
  expect(svg).toContain('magenta')
  expect(svg).not.toContain('<image')
})

it('prefixes recognizable layer names in display and accessible controls while preserving SVG identifiers', async () => {
  const svg = knownSvg.replace('</svg>', `
    <path id="H_xBxB_Circle_Path_1" d="M1 1H2V2H1Z" fill="none" stroke="magenta"/>
    <circle id="Circle_Path_2" cx="5" cy="5" r="1" fill="none" stroke="magenta"/>
    <path id="Path_3" d="M7 1H8V2H7Z" fill="none" stroke="magenta"/>
  </svg>`)
  mount([[piece()]], svg)
  await ready()
  for (const name of ['轮廓 H_xBxB_Circle_Path_1', '孔 Circle_Path_2', '路径 Path_3', 'artwork']) {
    expect(screen.getByText(name)).toBeTruthy()
    expect(screen.getByTitle(name)).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: `选择图层 ${name}` })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: `图层 ${name} 类型` })).toBeTruthy()
  }
  fireEvent.click(screen.getByRole('checkbox', { name: '选择图层 轮廓 H_xBxB_Circle_Path_1' }))
  const preview = await screen.findByRole('img', { name: '选中图层预览' }) as HTMLImageElement
  const blob = blobs.get(preview.src)!
  const selectedSvg = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob) })
  const root = new DOMParser().parseFromString(selectedSvg, 'image/svg+xml').documentElement
  expect(root.querySelector('[id="H_xBxB_Circle_Path_1"]')).toBeTruthy()
  expect(root.querySelector('[id="Circle_Path_2"]')).toBeNull()
  expect(root.querySelector('[id="Path_3"]')).toBeNull()
})

it('uses the SVG Blob fallback only for an in-memory source without a file path', async () => {
  const item = { ...piece(), image: { ...piece().image, filePath: '' } }
  const { unmount } = mount([[item]])
  await ready()
  await screen.findByRole('img', { name: '当前版式的导出位置预览' })
  await screen.findByRole('img', { name: '当前 SVG 原图' })
  const count = vi.mocked(URL.createObjectURL).mock.calls.length
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '选择 SVG' }))
  await waitFor(() => expect(vi.mocked(URL.createObjectURL).mock.calls).toHaveLength(count + 1))
  expect(mocks.invoke).not.toHaveBeenCalled()
  unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(count + 1)
})

it('keeps the newest preview type after rapid changes cancel earlier queued previews', async () => {
  mount([[piece()]])
  await ready()
  await screen.findByRole('img', { name: '当前版式的导出位置预览' })
  await choose('预览类型', '全部图片图层')
  await choose('预览类型', '轮廓 / 路径')
  const svg = await svgFromPreview()
  expect(svg).toContain('magenta')
  expect(svg).not.toContain('<image')
})

it('cancels directory selection without exporting and restores the close button', async () => {
  const directory = deferred<string | null>()
  mocks.chooseDirectory.mockReturnValue(directory.promise)
  const onClose = vi.fn()
  mount([[piece()]], knownSvg, { onClose })
  await ready()
  fireEvent.click(exportButton())
  const close = screen.getByRole('button', { name: /关\s*闭/ }) as HTMLButtonElement
  expect(close.disabled).toBe(true)
  fireEvent.click(close)
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => directory.resolve(null))
  await waitFor(() => expect(close.disabled).toBe(false))
  expect(mocks.exportPdfs).not.toHaveBeenCalled()
  fireEvent.click(close)
  expect(onClose).toHaveBeenCalledOnce()
})

it('keeps the modal locked while exporting, reports progress and prevents a second export', async () => {
  const result = deferred<ImpositionPdfExportResult>()
  let updateProgress!: (progress: ImpositionPdfExportProgress) => void
  mocks.exportPdfs.mockImplementation((_directory, _entries, onProgress) => { updateProgress = onProgress; return result.promise })
  const onClose = vi.fn()
  mount([[piece()]], knownSvg, { onClose })
  await ready()
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  fireEvent.click(exportButton())
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape', keyCode: 27 })
  expect(onClose).not.toHaveBeenCalled()
  expect(mocks.chooseDirectory).toHaveBeenCalledOnce()
  expect((screen.getByRole('checkbox', { name: '导出版式 1' }) as HTMLInputElement).disabled).toBe(true)
  act(() => updateProgress({ phase: 'convert', completed: 1, total: 3, fileName: 'current.pdf', pageNumber: 2, pageCount: 4, pageName: '图片 1（全板）' }))
  expect(screen.getByText('生成 PDF：current.pdf · 第 2/4 页 图片 1（全板）')).toBeTruthy()
  expect(screen.getByText('已完成 1/3 个文件')).toBeTruthy()
  await act(async () => result.resolve({ completedFiles: ['D:/exports/done.pdf'], cancelled: false, cleanupWarnings: [] }))
  await screen.findByText('已导出 1 个 PDF')
  expect((screen.getByRole('checkbox', { name: '导出版式 1' }) as HTMLInputElement).disabled).toBe(false)
})

it('preserves completed paths and reports the failed file and cleanup warning after a partial failure', async () => {
  mocks.exportPdfs.mockResolvedValue({ completedFiles: ['D:/exports/first.pdf'], cancelled: false, failedFile: 'second.pdf', error: '磁盘空间不足', cleanupWarnings: ['第二份临时 SVG 清理失败'] })
  mount([[piece()]])
  await ready()
  fireEvent.click(exportButton())
  await screen.findByText('导出 second.pdf 失败：磁盘空间不足')
  expect(screen.getByText('已导出 1 个 PDF')).toBeTruthy()
  expect(screen.getByText('D:/exports/first.pdf')).toBeTruthy()
  expect(screen.getByText('第二份临时 SVG 清理失败')).toBeTruthy()
  expect(exportButton().disabled).toBe(false)
})


it('names files with the time of confirmed export rather than the older modal opening time', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 14, 9, 30))
  const directory = deferred<string | null>()
  mocks.chooseDirectory.mockReturnValue(directory.promise)
  mount([[piece()]])
  await ready()
  vi.setSystemTime(new Date(2026, 9, 14, 10, 0))
  fireEvent.click(exportButton())
  expect(mocks.exportPdfs).not.toHaveBeenCalled()
  vi.setSystemTime(new Date(2026, 9, 14, 10, 5))
  await act(async () => directory.resolve('D:/exports'))
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries().map(entry => entry.fileName)).toEqual(['202610141005_1B-1B_1F-1F.pdf'])
  expect(document.querySelector('.imposition-export-file-list')!.textContent).toContain('202610141005_1B-1B_1F-1F.pdf')
})
