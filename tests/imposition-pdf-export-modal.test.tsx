import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import ImpositionPdfExportModal from '../src/modules/imposition/ImpositionPdfExportModal'
import type { ExportGeometryCheck } from '../src/modules/imposition/impositionExportDiagnostics'
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
function mount(pages: PackedItem[][], svg = knownSvg, options: { load?: boolean; onClose?: () => void; holes?: boolean; sources?: Record<string, string>; geometry?: ExportGeometryCheck } = {}) {
  mocks.loadImage.mockResolvedValue(svg)
  return render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPdfExportModal geometry={options.geometry} pages={pages} imageSources={options.load ? {} : options.sources ?? { art: svg }} widthMm={300} heightMm={464} holes={options.holes ? { count: 2, sizeMm: 3, gapMm: 203.468, leftMm: 4 } : undefined} onClose={options.onClose ?? vi.fn()}/></ConfigProvider>)
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
async function ready() {
  await screen.findByRole('checkbox', { name: '选择图层 cut' })
  await waitFor(() => expect(screen.queryByText('检查各版式的边界、轮廓和图片间距…')).toBeNull())
}
function entries() { return mocks.exportPdfs.mock.calls.at(-1)![1] as ImpositionPdfExportEntry[] }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const blobs = new Map<string, Blob>()
async function svgFromPreview() {
  const image = await screen.findByRole('img', { name: '当前版式的导出位置预览' }) as HTMLImageElement
  const blob = blobs.get(image.src)!
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob) })
}

beforeEach(() => {
  localStorage.clear()
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

it('marks the board and identifies an invisible source contour without silently creating a cutting line', async () => {
  mount([[piece()]], knownSvg.replace('fill="none" stroke="magenta"', 'fill="none"'))
  await ready()
  expect(await screen.findByText('版式 1 需要检查')).toBeTruthy()
  expect(screen.getByText(/原始挂件.svg：图层“cut”的闭合路径没有填充和描边/)).toBeTruthy()
  expect(screen.getByText(/需检查 · 1/)).toBeTruthy()
  expect(exportButton().disabled).toBe(false)
})

it('does not offer image roles for vector paths and removes window offset controls', async () => {
  mount([[piece()]])
  await ready()
  expect(screen.queryByRole('spinbutton', { name: '彩窗偏移 X' })).toBeNull()
  expect(screen.queryByRole('spinbutton', { name: '彩窗偏移 Y' })).toBeNull()
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '图层 cut 类型' }))
  const dropdown = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!
  expect(dropdown).toBeTruthy()
  for (const role of ['图片正', '图片背', '其他图片']) expect(within(dropdown as HTMLElement).queryByTitle(role)).toBeNull()
  expect(within(dropdown as HTMLElement).getByTitle('轮廓 / 路径')).toBeTruthy()
  expect(within(dropdown as HTMLElement).getByTitle('彩窗')).toBeTruthy()
})

it('defaults to PDF, DXF and CMYK, and each option actually controls the export plan', async () => {
  mount([[piece()]])
  await ready()
  expect((screen.getByRole('checkbox', { name: '导出 PDF' }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('checkbox', { name: '导出 DXF' }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('checkbox', { name: '导出 CMYK PDF' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()[0].exportPdf).toBe(true)
  expect(entries()[0].cmyk).toMatchObject({ dpi: 400, differentBack: false, autoAlign: false })
  expect(entries()[0].cmyk!.sources).toHaveLength(1)
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 DXF' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 CMYK PDF' }))
  expect(screen.queryByRole('combobox', { name: 'CMYK 分辨率' })).toBeNull()
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledTimes(2))
  expect(entries()[0].cmyk).toBeUndefined()
  expect(entries()[0].pages.some(page => page.exportDxf)).toBe(false)
})

it('restores the last file type selection when reopened and uses it for export', async () => {
  const first = mount([[piece()]])
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 PDF' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 CMYK PDF' }))
  first.unmount()

  const second = mount([[piece()]])
  await ready()
  expect((screen.getByRole('checkbox', { name: '导出 PDF' }) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('checkbox', { name: '导出 DXF' }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('checkbox', { name: '导出 CMYK PDF' }) as HTMLInputElement).checked).toBe(false)
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()[0].exportPdf).toBe(false)
  expect(entries()[0].pages.some(page => page.exportDxf)).toBe(true)
  expect(entries()[0].cmyk).toBeUndefined()
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '导出 DXF' }) as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 PDF' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 DXF' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 CMYK PDF' }))
  second.unmount()

  mount([[piece()]])
  expect((screen.getByRole('checkbox', { name: '导出 PDF' }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('checkbox', { name: '导出 DXF' }) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('checkbox', { name: '导出 CMYK PDF' }) as HTMLInputElement).checked).toBe(true)
})

it.each(['DXF', 'CMYK PDF'])('allows %s-only output with matching counts and filenames', async type => {
  const isDxf = type === 'DXF'
  mocks.exportPdfs.mockResolvedValue({ completedFiles: [isDxf ? 'D:/exports/layout.dxf' : 'D:/exports/CMYK_layout.pdf'], cancelled: false, cleanupWarnings: [] })
  mount([[piece()]])
  await ready()
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 PDF' }))
  fireEvent.click(screen.getByRole('checkbox', { name: isDxf ? '导出 CMYK PDF' : '导出 DXF' }))
  expect(screen.getByText(isDxf ? /0 个 PDF · 1 个轮廓 DXF · 0 个 CMYK PDF/ : /0 个 PDF · 0 个轮廓 DXF · 1 个 CMYK PDF/)).toBeTruthy()
  expect(screen.getByText('待导出文件（1）')).toBeTruthy()
  const fileList = document.querySelector('.imposition-export-file-list')!
  expect(fileList.querySelectorAll('span')).toHaveLength(1)
  expect(fileList.querySelector('span')!.textContent).toMatch(isDxf ? /\.dxf$/u : /^CMYK_.*\.pdf$/u)
  expect(exportButton().disabled).toBe(false)
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()[0].exportPdf).toBe(false)
  expect(entries()[0].pages.some(page => page.exportDxf)).toBe(isDxf)
  expect(!!entries()[0].cmyk).toBe(!isDxf)
  await screen.findByText(`已导出 1 个 ${type}`)
  expect(screen.queryByText(/已导出 0 个 PDF/)).toBeNull()
})

it('disables export when all file types are unchecked or the chosen type has no content', async () => {
  mount([[piece()]])
  await ready()
  for (const type of ['PDF', 'DXF', 'CMYK PDF']) fireEvent.click(screen.getByRole('checkbox', { name: `导出 ${type}` }))
  expect(exportButton().disabled).toBe(true)
  expect(screen.getByText('请选择至少一种导出文件类型。')).toBeTruthy()
  expect(screen.getByText('待导出文件（0）')).toBeTruthy()
  fireEvent.click(exportButton())
  expect(mocks.chooseDirectory).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 DXF' }))
  await choose('图层 cut 类型', '不导出')
  expect(exportButton().disabled).toBe(true)
  expect(screen.getByText('待导出文件（0）')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 PDF' }))
  expect(exportButton().disabled).toBe(false)
})

it('detects same-face printing and windows from SVG types without manual mode switches', async () => {
  mount([[piece()]])
  await ready()
  expect(screen.queryByRole('combobox', { name: 'CMYK 印刷模式' })).toBeNull()
  expect(screen.queryByRole('checkbox', { name: '包含彩窗' })).toBeNull()
  expect(screen.getByLabelText('CMYK 自动识别').textContent).toContain('双面同图 · 有彩窗')
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()[0].cmyk!.differentBack).toBe(false)
  expect(entries()[0].cmyk!.sources[0].window!()).toContain('id="white"')
  await waitFor(() => expect(exportButton().disabled).toBe(false))
  await choose('图层 white 类型', '白墨')
  expect(screen.getByLabelText('CMYK 自动识别').textContent).toContain('无彩窗')
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledTimes(2))
  expect(entries()[0].cmyk!.sources[0].window).toBeUndefined()
})

it('selects front and back in SVG layer types without duplicate face selectors', async () => {
  mount([[piece()]], knownSvg.replace('<path id="cut"', '<image id="reverse" width="20" height="10" href="data:image/png;base64,QkFDSw=="/><image id="window-image" width="20" height="10" href="data:image/png;base64,V0lORE9X"/><path id="cut"'))
  await ready()
  expect(screen.queryByRole('combobox', { name: 'CMYK 图片正' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: 'CMYK 图片背' })).toBeNull()
  expect(screen.getByRole('combobox', { name: '图层 artwork 类型' }).closest('.ant-select')!.textContent).toContain('图片正')
  expect(screen.getByRole('combobox', { name: '图层 reverse 类型' }).closest('.ant-select')!.textContent).toContain('图片背')
  await choose('图层 artwork 类型', '图片背')
  await choose('图层 reverse 类型', '图片正')
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()[0].cmyk!.sources[0].front()).toContain('QkFDSw==')
  expect(entries()[0].cmyk!.sources[0].back!()).toContain('iVBORw0KGgo=')
})

it('exports a mixed board in different-face mode while keeping same-face products at their original placements', async () => {
  const differentSvg = knownSvg.replace('<path id="cut"', '<image id="reverse" width="20" height="10" href="data:image/png;base64,QkFDSw=="/><image id="window-image" width="20" height="10" href="data:image/png;base64,V0lORE9X"/><path id="cut"')
  const different = { ...piece(1, 40), image: { ...image, id: 'different', sourceImageId: 'different', sourceFileName: '不同图.svg', filePath: 'D:/assets/不同图.svg' }, rotation: 180 }
  mount([[piece(), different]], knownSvg, { sources: { art: knownSvg, different: differentSvg } })
  await ready()
  expect(screen.getByLabelText('CMYK 自动识别').textContent).toContain('双面不同图 · 有彩窗 · 同图图片自动补入背面')
  expect(screen.queryByRole('spinbutton', { name: '背面偏移 X' })).toBeNull()
  await choose('选择 SVG', '不同图.svg')
  expect(screen.queryByRole('spinbutton', { name: '背面偏移 X' })).toBeNull()
  expect(screen.queryByRole('spinbutton', { name: '背面偏移 Y' })).toBeNull()
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  const plan = entries()[0].cmyk!
  expect(plan.differentBack).toBe(true)
  expect(plan.sources).toHaveLength(2)
  expect(plan.sources.filter(source => !!source.back)).toHaveLength(1)
  expect(plan.placements.map(p => [p.x, p.y, p.rotation])).toEqual([[10, 12, 90], [40, 12, 180]])
})

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
  expect(entries()[0].pages.map(page => page.exportDxf)).toEqual([true, false, false])
  expect(screen.getByText(/1 个轮廓 DXF/)).toBeTruthy()
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
  expect(entries()[0].pages[0].exportDxf).toBe(false)
  expect(screen.getByText(/0 个轮廓 DXF/)).toBeTruthy()
  const svg = await entries()[0].pages[0].renderSvg()
  expect(entries()[0].pages[0].label).toBe('白墨')
  expect(svg).toContain('magenta')
  expect(svg).toContain('fill="white"')
  expect(svg).not.toContain('<image')
})

it('combines corresponding image layers into separate pages of one whole-board PDF and previews each channel independently', async () => {
  const multipleImages = knownSvg.replace('<path id="cut"', '<image id="back" width="20" height="10" href="data:image/png;base64,QkFDSw=="/><image id="window-image" width="20" height="10" href="data:image/png;base64,V0lORE9X"/><path id="cut"')
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
  expect(secondChannel).toContain('T1RIRVI=')
  expect(document.querySelector('.imposition-export-file-list')?.textContent).toContain('图片 1（全板）')
  expect(document.querySelector('.imposition-export-file-list')?.textContent).toContain('图片 2（全板）')
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()).toHaveLength(1)
  const imageEntries = entries()[0].pages.filter(value => value.label.startsWith('图片'))
  expect(imageEntries).toHaveLength(2)
  expect(imageEntries.map(value => value.label)).toEqual(['图片 1（全板）', '图片 2（全板）'])
  const outputs = await Promise.all(imageEntries.map(entry => entry.renderSvg()))
  for (const svg of outputs) {
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
    expect(root.querySelectorAll('image')).toHaveLength(2)
    expect(root.querySelectorAll('g[data-placement-id]')).toHaveLength(4)
  }
  expect(outputs.filter(svg => svg.includes('iVBORw0KGgo='))).toHaveLength(1)
  expect(outputs.filter(svg => svg.includes('QkFDSw=='))).toHaveLength(1)
  expect(outputs[0]).toContain('T1RIRVI=')
  expect(outputs[1]).toContain('T1RIRVI=')
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
    expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    expect(screen.getAllByTitle(name).length).toBeGreaterThan(0)
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
  for (const type of ['PDF', 'DXF', 'CMYK PDF']) expect((screen.getByRole('checkbox', { name: `导出 ${type}` }) as HTMLInputElement).disabled).toBe(true)
  act(() => updateProgress({ phase: 'convert', completed: 1, total: 3, fileName: 'current.pdf', pageNumber: 2, pageCount: 4, pageName: '图片 1（全板）' }))
  expect(screen.getByText('生成 PDF：current.pdf · 第 2/4 页 图片 1（全板）')).toBeTruthy()
  expect(screen.getByText('已完成 1/3 种版式')).toBeTruthy()
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


it('marks only templates with unassigned layers and clears the marker after classification', async () => {
  const other = { ...piece(), image: { ...image, id: 'other', sourceImageId: 'other', name: '其他.svg' } }
  mount([[piece()], [other]], knownSvg, { sources: { art: knownSvg, other: unknownSvg } })
  await ready()
  const boards = document.querySelectorAll('.imposition-export-board')
  expect(boards[0].classList.contains('has-issues')).toBe(false)
  expect(boards[1].classList.contains('has-issues')).toBe(true)
  expect(exportButton().disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '导出版式 2' }))
  expect(exportButton().disabled).toBe(false)
  fireEvent.click(boards[1].querySelector('button')!)
  expect(screen.getByText('版式 2 需要检查')).toBeTruthy()
  await choose('图层 note 类型', '不导出')
  expect(boards[1].classList.contains('has-issues')).toBe(false)
  fireEvent.click(screen.getByRole('checkbox', { name: '导出版式 2' }))
  expect(exportButton().disabled).toBe(false)
})

it('identifies overlap and spacing on the affected template and allows exporting the other template', async () => {
  const polygon: Array<[number, number]> = [[0, 0], [20, 0], [20, 10], [0, 10]]
  mount([[piece()], [piece(1, 10), piece(2, 14)]], knownSvg, { geometry: { polygons: { art: polygon }, region: { left: 0, top: 0, right: 300, bottom: 464 }, spacing: 3 } })
  await ready()
  const boards = document.querySelectorAll('.imposition-export-board')
  expect(boards[0].classList.contains('has-issues')).toBe(false)
  expect(boards[1].classList.contains('has-issues')).toBe(true)
  fireEvent.click(boards[1].querySelector('button')!)
  expect(screen.getByText(/轮廓重叠或间距小于 3 mm/)).toBeTruthy()
  expect(exportButton().disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '导出版式 2' }))
  expect(exportButton().disabled).toBe(false)
  fireEvent.click(exportButton())
  await waitFor(() => expect(mocks.exportPdfs).toHaveBeenCalledOnce())
  expect(entries()).toHaveLength(1)
})

it('marks the concrete template when a CMYK export fails', async () => {
  mocks.exportPdfs.mockImplementation(async (_directory, entries) => ({ completedFiles: [], cancelled: false, cleanupWarnings: [], failedFile: `CMYK_${entries[1].fileName}`, error: 'CMYK 转换失败' }))
  mount([[piece()], [piece(1, 40)]])
  await ready()
  fireEvent.click(exportButton())
  await screen.findByText(/导出 CMYK_.*失败：CMYK 转换失败/)
  const boards = document.querySelectorAll('.imposition-export-board')
  expect(boards[0].classList.contains('has-issues')).toBe(false)
  expect(boards[1].classList.contains('has-issues')).toBe(true)
  fireEvent.click(boards[1].querySelector('button')!)
  expect(screen.getByText('版式 2 需要检查')).toBeTruthy()
})

it('keeps a failed SVG source visible on its template without blocking unrelated templates', async () => {
  const other = { ...piece(), image: { ...image, id: 'missing', sourceImageId: 'missing', filePath: 'D:/missing.svg' } }
  mount([[piece()], [other]])
  mocks.loadImage.mockRejectedValue(new Error('文件不存在'))
  await ready()
  const boards = document.querySelectorAll('.imposition-export-board')
  expect(boards[0].classList.contains('has-issues')).toBe(false)
  expect(boards[1].classList.contains('has-issues')).toBe(true)
  expect(exportButton().disabled).toBe(true)
  fireEvent.click(boards[1].querySelector('button')!)
  expect(screen.getByText(/missing.svg：读取 SVG 图层失败，文件不存在/)).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: '导出版式 2' }))
  expect(exportButton().disabled).toBe(false)
})
