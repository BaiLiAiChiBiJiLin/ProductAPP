import type { ComponentProps } from 'react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { defaultLayoutBounds, type Asset, type Page } from '../src/model'
import { createReviewRecord, type SchematicReviewRecord } from '../src/modules/schematic-review/reviewRecords'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'
import { defaultBatchMetadata } from '../src/modules/schematic/types'
import type ArtworkCanvas from '../src/modules/schematic/ArtworkCanvas'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), canvas: vi.fn(), recordSaved: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save, open: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
vi.mock('../src/modules/schematic/services/productConfigService', async original => ({ ...await original<typeof import('../src/modules/schematic/services/productConfigService')>(), loadProductConfigs: async () => [] }))
vi.mock('../src/modules/schematic/services/finishService', () => ({ loadFinishNames: async () => new Map() }))
vi.mock('../src/modules/schematic/components/UploadPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/ProductAttributesPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/PageConfigPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/AssetPool', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/history/BatchHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/PageThumbnail', () => ({ default: ({ page, onClick }: { page: Page; onClick: () => void }) => <button onClick={onClick}>选择页面 {page.id}</button> }))
// Only canvas rendering is replaced. Selection, percentage editing, exporting,
// SVG construction and review persistence all run through production code.
vi.mock('../src/modules/schematic/ArtworkCanvas', () => ({ default: (props: ComponentProps<typeof ArtworkCanvas>) => {
  mocks.canvas(props)
  return <button onClick={() => props.onSelect(props.page.items[0].id)}>选择主图</button>
} }))
import SchematicPage from '../src/modules/schematic/SchematicPage'

const asset: Asset = {
  id: 'source', name: '比例测试', productId: 'a', width: 30, height: 60,
  sourceGroupWidthMm: 30, sourceGroupHeightMm: 60,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="60" viewBox="0 0 30 60"><rect width="30" height="60" fill="#51a5b5"/></svg>',
  previewUrl: '', thumbnailUrl: '',
}
function fixture(pageCount = 1) {
  const pages: Page[] = Array.from({ length: pageCount }, (_, index) => {
    const id = index + 1, itemId = `main-${id}`
    return { id, name: `页面 ${id}`, items: [{ id: itemId, assetId: asset.id, x: 90, y: 220, w: 50, h: 100, rotation: 0, rulerWidth: false, rulerHeight: true }],
      imageGroups: [{ id: `group-${id}`, itemIds: [itemId], x: 20, y: 110, width: 240, height: 220, details: { size: '60.0 mm', qt: '1', finish: '' } }] }
  })
  return createReviewRecord({ assets: [asset], pages, activePage: 1, metadata: defaultBatchMetadata,
    layoutBounds: defaultLayoutBounds, arrangementSort: 'default', defaultArrangementIds: [asset.id] }, emptyArrangementDisplayState(), 'pdf', 'before.pdf')
}
const canvas = () => mocks.canvas.mock.calls.at(-1)![0] as ComponentProps<typeof ArtworkCanvas>
const stagedPages = () => mocks.invoke.mock.calls.filter(([command]) => command === 'stage_pdf_page').map(([, payload]) => payload.svg as string)
const savedRecord = () => mocks.invoke.mock.calls.filter(([command]) => command === 'save_schematic_review').at(-1)![1].record as SchematicReviewRecord

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) })
})
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem('printflow-schematic-layout-bounds')
  mocks.save.mockResolvedValue('C:/display-scale-proof.pdf')
  mocks.invoke.mockResolvedValue(undefined)
})
afterEach(cleanup)

async function setPercentage(percent: number) {
  fireEvent.click(screen.getByRole('button', { name: '选择主图' }))
  const input = await screen.findByRole('spinbutton', { name: '图片显示百分比' })
  fireEvent.change(input, { target: { value: String(percent) } })
  fireEvent.blur(input)
  await waitFor(() => expect(canvas().visualScales?.get(canvas().page.items[0].id)).toBe(percent / 100))
}
async function exportFormat(format: 'pdf' | 'svg' | 'png' | 'jpg') {
  fireEvent.change(screen.getByRole('option', { name: format.toUpperCase() }).closest('select')!, { target: { value: format } })
  const completed = mocks.recordSaved.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: '导出', exact: true }))
  await waitFor(() => expect(mocks.recordSaved).toHaveBeenCalledTimes(completed + 1))
}
function expectExportedScale(svg: string, scale: number, itemId: string) {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const image = document.querySelector('image')!
  expect(Number(image.getAttribute('width'))).toBeCloseTo(50 * scale)
  expect(Number(image.getAttribute('height'))).toBeCloseTo(100 * scale)
  expect(image.getAttribute('transform')).toContain('translate(90 220)')
  const marker = document.querySelector(`[data-item-id="${itemId}"]`)!
  const lines = marker.querySelectorAll('line')
  expect(Number(lines[0].getAttribute('y1'))).toBeCloseTo(220 - 50 * scale)
  expect(Number(lines[1].getAttribute('y1'))).toBeCloseTo(220 + 50 * scale)
  expect(marker.querySelector('text')?.textContent).toBe('60.0 mm')
  expect([...document.querySelectorAll('text')].some(text => text.textContent === 'Size: 60.0 mm')).toBe(true)
}

test.each(['pdf', 'svg', 'png', 'jpg'] as const)('%s exports the manually selected 120 percent image size and ruler length without changing real dimensions', async format => {
  const record = fixture()
  render(<SchematicPage initialRecord={record} onRecordSaved={mocks.recordSaved}/>)
  await setPercentage(120)
  expect(canvas().page.items[0]).toMatchObject({ w: 50, h: 100 })
  await exportFormat(format)
  const svg = format === 'pdf' ? stagedPages()[0] : mocks.invoke.mock.calls.find(([command]) => command === 'export_artwork')![1].svg
  expectExportedScale(svg, 1.2, 'main-1')
  expect(savedRecord().pages[0].items[0]).toMatchObject({ w: 50, h: 100 })
  expect(savedRecord().display.visualScales).toEqual([['main-1', 1.2]])
  expect(savedRecord().assets[0]).toMatchObject({ width: 30, height: 60, sourceGroupWidthMm: 30, sourceGroupHeightMm: 60 })
})

test('PDF exports each page with its own manual scale and repeated export never compounds it', async () => {
  render(<SchematicPage initialRecord={fixture(2)} onRecordSaved={mocks.recordSaved}/>)
  await setPercentage(120)
  fireEvent.click(screen.getByRole('button', { name: '选择页面 2' }))
  await setPercentage(75)
  await exportFormat('pdf')
  expect(stagedPages()).toHaveLength(2)
  expectExportedScale(stagedPages()[0], 1.2, 'main-1')
  expectExportedScale(stagedPages()[1], .75, 'main-2')
  await exportFormat('pdf')
  expect(stagedPages()).toHaveLength(4)
  expectExportedScale(stagedPages()[2], 1.2, 'main-1')
  expectExportedScale(stagedPages()[3], .75, 'main-2')
  expect(savedRecord().pages.map(page => [page.items[0].w, page.items[0].h])).toEqual([[50, 100], [50, 100]])
  expect(savedRecord().display.visualScales).toEqual([['main-1', 1.2], ['main-2', .75]])
  expect(canvas().page.items[0]).toMatchObject({ w: 50, h: 100 })
})
