import { expect, test, vi } from 'vitest'
import type { Asset, Page } from '../src/model'
import { defaultLayoutBounds } from '../src/model'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), unlisten: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => mocks.unlisten }))
vi.mock('../src/modules/schematic/services/accessoryFrameService', async importOriginal => ({ ...await importOriginal<object>(), prepareAccessoryFrames: async () => {} }))
import { exportPdf } from '../src/modules/schematic/services/exportService'
import { createReviewRecord, exportAndRecord, loadReviewRecord } from '../src/modules/schematic-review/reviewRecords'
import { StagedArtwork, writeStagedText } from '../src/modules/schematic/services/stagedArtworkService'

test('chunk boundaries preserve Unicode and a failed transfer still cleans its resources', async () => {
  const source = 'x'.repeat(65535) + '🌸中文' + 'y'.repeat(65536)
  const chunks: string[] = []
  mocks.invoke.mockImplementation(async (command, args) => { if (command === 'write_export_resource_chunk') chunks.push(args.text) })
  await writeStagedText('abc', source)
  expect(chunks.join('')).toBe(source)
  for (const chunk of chunks) expect(new TextDecoder().decode(new TextEncoder().encode(chunk))).toBe(chunk)
  const resources = new StagedArtwork()
  const reference = resources.reference(source)
  expect(resources.reference(source)).toBe(reference)
  mocks.invoke.mockClear()
  mocks.invoke.mockRejectedValueOnce(new Error('磁盘已满'))
  await expect(resources.write()).rejects.toThrow('磁盘已满')
  await resources.dispose()
  expect(mocks.invoke).toHaveBeenLastCalledWith('clear_pdf_pages', { ids: [reference.slice('printflow-export:'.length)] })
})

test('review restore loads original and derived resources one at a time without losing display precision', async () => {
  const references = ['printflow-review:r1', 'printflow-review:r2']
  const manifest = { schemaVersion: 1, assets: [{ id: 'a', svg: references[0], width: 42.756 }], pages: [{ items: [{ id: 'i', backSvg: references[1], rulerHeightRange: [0.2, 0.8] }] }], metadata: {}, layoutBounds: {}, display: { dimensionDisplayOverrides: [['i', { decimalPlaces: 0 }]] } }
  let active = 0
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'load_schematic_review') return manifest
    if (command === 'load_schematic_review_resource') {
      expect(++active).toBe(1)
      await Promise.resolve()
      active--
      return new TextEncoder().encode(`<svg>${args.resourceId}原图🌸</svg>`).buffer
    }
  })
  const record = await loadReviewRecord('review')
  expect(record.assets[0].svg).toBe('<svg>r1原图🌸</svg>')
  expect(record.pages[0].items[0].backSvg).toBe('<svg>r2原图🌸</svg>')
  expect(record.display).toEqual(manifest.display)
  expect(record.assets[0].width).toBe(42.756)
})

test('large original and derived artwork never enter page or review IPC as giant JSON strings', async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200"><!--${'x'.repeat(2 * 1024 * 1024)}--></svg>`
  const asset: Asset = { id: 'a', name: 'a.svg', width: 100, height: 200, svg, previewUrl: '', thumbnailUrl: '' }
  const pages: Page[] = [{ id: 1, name: 'one', items: [{ id: 'i', assetId: 'a', x: 100, y: 200, w: 50, h: 100, rotation: 0, mirrorX: false, backSvg: svg.replace('200', '201') }] }]
  const record = createReviewRecord({ assets: [asset], pages, activePage: 1, metadata: { customerName: 'ds', drawingDate: '', estimatedShipDate: '', designer: '' }, layoutBounds: defaultLayoutBounds, arrangementSort: 'default', defaultArrangementIds: ['a'] }, emptyArrangementDisplayState(), 'pdf', 'test.pdf')
  mocks.invoke.mockImplementation(async (_command, args) => {
    expect(JSON.stringify(args).length, 'every IPC request must stay bounded, including review saving').toBeLessThan(1024 * 1024)
  })
  const result = await exportAndRecord(record, () => exportPdf(pages, [asset], 'test.pdf'))
  expect(result).toEqual({ saved: true })
  expect(mocks.invoke.mock.calls.some(([command]) => command === 'export_staged_pdf')).toBe(true)
  expect(mocks.invoke.mock.calls.some(([command]) => command === 'save_schematic_review')).toBe(true)
  expect(record.assets[0].svg).toBe(svg)
  expect(record.pages[0].items[0].backSvg).toBe(pages[0].items[0].backSvg)
})
