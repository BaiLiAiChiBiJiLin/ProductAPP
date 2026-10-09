import { beforeEach, expect, test, vi } from 'vitest'
import { defaultLayoutBounds, PAPER_HEIGHT, pageRasterSvg, pageSvg, type Asset, type Page } from '../src/model'
import { exportPage, exportPdf } from '../src/modules/schematic/services/exportService'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), unlisten: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => mocks.unlisten }))
beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(undefined); mocks.unlisten.mockReset() })

const asset: Asset = { id: 'art', name: 'art', productId: 'keychain', width: 100, height: 120,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120"><rect width="100" height="120" fill="pink"/></svg>', previewUrl: '', thumbnailUrl: '' }
const page: Page = { id: 1, name: 'Page 1', items: [{ id: 'item-art', assetId: asset.id, x: 80, y: 190, w: 50, h: 60, rotation: 0 }] }
const bounds = { top: 120, left: 24, right: 36, bottom: 40 }

function frame(svg: string) {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(document.querySelector('parsererror')).toBeNull()
  const frames = document.querySelectorAll('[data-printflow-arrangement-frame]')
  expect(frames).toHaveLength(1)
  const border = frames[0]
  expect(border).toBe(document.documentElement.lastElementChild)
  expect(border.getAttribute('fill')).toBe('none')
  expect(Number(border.getAttribute('stroke-width'))).toBeGreaterThan(0)
  expect(Number(border.getAttribute('rx'))).toBeGreaterThan(0)
  const shadows = document.querySelectorAll('[data-printflow-arrangement-shadow]')
  expect(shadows).toHaveLength(1)
  const shadow = shadows[0]
  const backing = shadow.lastElementChild!
  expect(backing.getAttribute('fill')).toBe('white')
  for (const name of ['x', 'y', 'width', 'height', 'rx']) {
    expect(backing.getAttribute(name)).toBe(border.getAttribute(name))
  }
  const blurredRect = shadow.querySelector('rect[filter]')!
  expect(blurredRect).not.toBeNull()
  expect(Number(blurredRect.getAttribute('fill-opacity'))).toBeGreaterThan(0)
  const filterId = blurredRect.getAttribute('filter')!.slice(5, -1)
  const filter = document.getElementById(filterId)!
  expect(filter).not.toBeNull()
  expect(Number(filter.querySelector('feGaussianBlur')!.getAttribute('stdDeviation'))).toBeGreaterThan(0)
  // A filter region larger than the frame prevents the outer blur from being clipped.
  expect(Number(filter.getAttribute('x'))).toBeLessThan(Number(border.getAttribute('x')))
  expect(Number(filter.getAttribute('width'))).toBeGreaterThan(Number(border.getAttribute('width')))
  expect(shadow.getAttribute('filter')).toBeNull()
  for (const image of document.querySelectorAll('image')) {
    expect(shadow.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(image.closest('[filter]')).toBeNull()
  }
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(name => [name, Number(border.getAttribute(name))]))
}

test('direct SVG renderers retain the outer shadow and vector frame at the default arrangement bounds', () => {
  const assets = new Map([[asset.id, asset]])
  for (const svg of [pageSvg(page, assets), pageRasterSvg(page, assets)]) {
    expect(frame(svg)).toEqual({ x: defaultLayoutBounds.left, y: defaultLayoutBounds.top,
      width: 500 - defaultLayoutBounds.left - defaultLayoutBounds.right,
      height: PAPER_HEIGHT - defaultLayoutBounds.top - defaultLayoutBounds.bottom })
  }
})

test.each(['svg', 'png', 'jpg'])('%s export retains the shadow and full custom frame instead of inferring it from artwork extents', async format => {
  const original = JSON.stringify(page)
  await exportPage(page, [asset], `proof.${format}`, format, {}, 1, undefined, bounds)
  const [, args] = mocks.invoke.mock.calls.find(([command]) => command === 'export_artwork')!
  expect(frame(args.svg)).toEqual({ x: 24, y: 120, width: 440, height: PAPER_HEIGHT - 160 })
  expect(JSON.stringify(page)).toBe(original)
})

test('every merged PDF page retains the shadow and custom frame bounds, including an empty page', async () => {
  const pages = [page, { id: 2, name: 'Empty page', items: [] }]
  await exportPdf(pages, [asset], 'proof.pdf', {}, undefined, undefined, bounds)
  const staged = mocks.invoke.mock.calls.filter(([command]) => command === 'stage_pdf_page')
  expect(staged).toHaveLength(2)
  staged.forEach(([, args]) => expect(frame(args.svg)).toEqual({ x: 24, y: 120, width: 440, height: PAPER_HEIGHT - 160 }))
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'export_staged_pdf')).toHaveLength(1)
})
