import { beforeEach, expect, test, vi } from 'vitest'
import type { Asset, Page } from '../src/model'
import { exportPdf, exportPage } from '../src/modules/schematic/services/exportService'
import type { DimensionDisplayOverride } from '../src/modules/schematic/services/imageDimensionService'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), unlisten: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => mocks.unlisten }))
beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(undefined); mocks.unlisten.mockReset() })

const asset: Asset = { id: 'art', name: 'art', productId: 'holder', width: 100, height: 200,
  attributes: { Size: '59.7 mm' }, svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', previewUrl: '', thumbnailUrl: '' }
function page(id: number): Page {
  const itemId = `image-${id}`
  return { id, name: `Page ${id}`, items: [{ id: itemId, assetId: asset.id, x: 70, y: 170, w: 50, h: 100, rotation: 0 }],
    imageGroups: [{ id: `group-${id}`, itemIds: [itemId], x: 20, y: 110, width: 240, height: 140,
      details: { size: '59.7 mm', qt: '', finish: '' } }] }
}
function exportedLabels(svg: string) {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  return {
    sizes: [...document.querySelectorAll('text')].map(node => node.textContent).filter(value => value?.startsWith('Size:')),
    rulers: [...document.querySelectorAll('[data-printflow-dimension] text')].map(node => node.textContent),
  }
}

test('PDF transfer uses each page\'s display precision, including zero, without changing source values', async () => {
  const pages = [page(1), page(2), page(3), page(4)]
  const overrides = new Map<string, DimensionDisplayOverride>([
    ['image-1', { decimalPlaces: 0, precision: 'default' }],
    ['image-2', { decimalPlaces: 2, precision: 'default' }],
    ['image-3', { decimalPlaces: 0, precision: 'round' }],
  ])
  const before = JSON.stringify({ pages, asset })
  await exportPdf(pages, [asset], 'test.pdf', {}, undefined, overrides)
  const staged = mocks.invoke.mock.calls.filter(([command]) => command === 'stage_pdf_page')
  expect(staged.map(([, payload]) => exportedLabels(payload.svg))).toEqual([
    { sizes: ['Size: 59 mm'], rulers: ['59 mm'] },
    { sizes: ['Size: 59.70 mm'], rulers: ['59.70 mm'] },
    { sizes: ['Size: 60 mm'], rulers: ['60 mm'] },
    { sizes: ['Size: 59.7 mm'], rulers: ['59.7 mm'] },
  ])
  expect(JSON.stringify({ pages, asset })).toBe(before)
})

test.each(['svg', 'png'])('%s export keeps zero decimals for chain sizes and combined detail panels', async format => {
  const current = page(1)
  const group = current.imageGroups![0]
  group.details!.sizes = [{ itemId: 'image-1', label: '59.7 mm' }]
  group.detailGroups = [{ itemIds: ['image-1'], details: group.details! }]
  const overrides = new Map<string, DimensionDisplayOverride>([['image-1', { decimalPlaces: 0, precision: 'truncate' }]])
  await exportPage(current, [asset], `test.${format}`, format, {}, 1, overrides)
  const [, payload] = mocks.invoke.mock.calls.find(([command]) => command === 'export_artwork')!
  expect(exportedLabels(payload.svg)).toEqual({ sizes: ['Size: 59 mm'], rulers: ['59 mm'] })
  expect(group.details!.sizes[0].label).toBe('59.7 mm')
})

test('PDF display settings are applied after unit conversion and width selection', async () => {
  const pages = [page(1), page(2)]
  pages[0].items[0].rulerUnit = 'cm'
  Object.assign(pages[1].items[0], { rulerUnit: 'in', rulerWidth: true, rulerHeight: false })
  const overrides = new Map<string, DimensionDisplayOverride>([
    ['image-1', { decimalPlaces: 0, precision: 'default' }],
    ['image-2', { decimalPlaces: 3, precision: 'truncate' }],
  ])
  await exportPdf(pages, [asset], 'test.pdf', {}, undefined, overrides)
  const staged = mocks.invoke.mock.calls.filter(([command]) => command === 'stage_pdf_page')
  expect(staged.map(([, payload]) => exportedLabels(payload.svg))).toEqual([
    { sizes: ['Size: 5 cm'], rulers: ['5 cm'] },
    { sizes: ['Size: 1.175 in'], rulers: ['1.175 in'] },
  ])
})
