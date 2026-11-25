import { beforeEach, expect, test, vi } from 'vitest'
import { defaultLayoutBounds, type Asset, type Page } from '../src/model'
import { exportPdf, exportPage } from '../src/modules/schematic/services/exportService'
import { snapshotArtwork } from '../src/modules/schematic/services/artworkSourceService'
import { createReviewRecord } from '../src/modules/schematic-review/reviewRecords'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'
import { ExportArtwork } from '../src/modules/schematic/services/exportArtworkService'

const api = vi.hoisted(() => ({ invoke: vi.fn(), unlisten: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: api.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => api.unlisten }))
vi.mock('../src/modules/schematic/services/accessoryFrameService.ts', async importOriginal => ({ ...await importOriginal<object>(), prepareAccessoryFrames: async () => {} }))
const original = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><g id="front"><rect width="80" height="100" fill="red"/></g><g id="back"><circle r="30" fill="blue"/></g></svg>'
const selected = original.replace('<g id="front"><rect width="80" height="100" fill="red"/></g>', '')
const asset: Asset = { id: 'a', name: 'a.svg', productId: 'p', width: 80, height: 100, svg: original, previewUrl: '', thumbnailUrl: '', storagePath: 'original.svg' }
const pages: Page[] = [{ id: 3, name: 'edited', items: [{ id: 'i', assetId: 'a', x: 150, y: 230, w: 80, h: 100, rotation: 25, mirrorX: true, backSvg: selected, svgLayerIds: ['back'] }], annotations: [{ id: 't', kind: 'text', x: 30, y: 500, text: 'Vector text', fontSize: 14, color: '#123456' }] }]
beforeEach(() => { api.invoke.mockReset().mockResolvedValue(undefined); api.unlisten.mockClear() })

test('export prepares several deferred PNGs concurrently and waits for running work before cleanup on failure', async () => {
  const cores = vi.spyOn(navigator,'hardwareConcurrency','get').mockReturnValue(8)
  const lazy = Array.from({ length: 8 }, (_, index) => ({ ...asset, id: `a-${index}`, svg: '', storagePath: `printflow-file:${index}` }))
  const page: Page = { ...pages[0], items: lazy.map((asset,index) => ({ ...pages[0].items[0], id: `i-${index}`, assetId: asset.id, backSvg: undefined })) }
  const finish = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  api.invoke.mockImplementation((command,args)=> command === 'stage_asset_artwork' ? new Promise<void>((resolve,reject)=> { finish.set(args.source.assetId,{resolve,reject}) }) : Promise.resolve())
  const resources = new ExportArtwork()
  let settled = false
  const prepared = resources.prepare([page],new Map(lazy.map(asset=>[asset.id,asset])),'standard','batch').then(()=>undefined,error=>error).finally(()=>{ settled = true })
  try {
    await vi.waitFor(()=>expect(finish.size).toBeGreaterThan(1),{timeout:500})
    expect(finish.size).toBeLessThanOrEqual(4)
    finish.get('a-0')!.reject(new Error('failed'))
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(settled).toBe(false)
    for (const task of finish.values()) task.resolve()
    expect(await prepared).toBeInstanceOf(Error)
    expect(finish.size).toBeLessThanOrEqual(4)
  } finally {
    api.invoke.mockResolvedValue(undefined)
    for (const task of finish.values()) task.resolve()
    await prepared
    await resources.dispose()
    cores.mockRestore()
  }
})

test.each(['standard', 'high', 'ultra', 'original'] as const)('%s PDF retains deferred manual layer selection and its independent review data', async quality => {
  const reference = snapshotArtwork({ id: 'old-review', resourceId: 'source-hash', savedAt: 'now' })
  const lazy = { ...asset, svg: reference }
  const variant = { layers: { version: 'source-hash', remove: [1], reveal: [3,0] } }
  const page: Page = { ...pages[0], items: [{ ...pages[0].items[0], backSvg: undefined, artworkVariant: variant, svgLayerIds: ['svg-layer-1'] }] }
  await exportPdf([page], [lazy], 'selected.pdf', {}, undefined, undefined, defaultLayoutBounds, undefined, undefined, quality)
  expect(api.invoke).toHaveBeenCalledWith('stage_asset_artwork', expect.objectContaining({ source: expect.objectContaining({ svg: reference, variant }) }))
  expect(api.invoke.mock.calls.some(([command]) => ['load_batch_asset_svg', 'load_schematic_review_resource', 'write_export_resource_chunk'].includes(command))).toBe(false)
  const review = createReviewRecord({ assets: [lazy], pages: [page], activePage: page.id, metadata: { customerName: '', drawingDate: '', estimatedShipDate: '', designer: '' }, layoutBounds: defaultLayoutBounds, arrangementSort: 'default', defaultArrangementIds: ['a'] }, emptyArrangementDisplayState(), 'pdf', 'selected.pdf')
  expect(JSON.parse(JSON.stringify(review)).pages[0].items[0].artworkVariant).toEqual(variant)
  expect(review.assets[0].svg).toBe(reference)
})

test.each(['standard', 'high', 'ultra', 'original'] as const)('%s PDF resolves metadata-only originals and automatic backs entirely on the backend', async quality => {
  const lazyAsset = { ...asset, svg: '', storagePath: 'printflow-file:source' }
  const page: Page = { ...pages[0], items: [{ ...pages[0].items[0], backSvg: undefined, svgLayerIds: undefined, artworkVariant: { back: true, fitFirstImage: true, roles: ['back', 'window', 'front'] } }] }
  await exportPdf([page], [lazyAsset], 'lazy.pdf', {}, undefined, undefined, defaultLayoutBounds, undefined, new Map([['i', 1.5]]), quality, 'batch')
  const staged = api.invoke.mock.calls.find(([command]) => command === 'stage_asset_artwork')![1]
  expect(staged.source).toEqual({ assetId: 'a', svg: '', path: 'printflow-file:source', batchId: 'batch', variant: page.items[0].artworkVariant })
  expect(staged.maxEdgePx).toBe(quality === 'original' ? null : Math.ceil(150 / 500 * 210 / 25.4 * ({ standard: 300, high: 400, ultra: 500 } as const)[quality]))
  expect(api.invoke.mock.calls.some(([command]) => ['load_batch_asset_svg', 'load_temp_asset_svg', 'write_export_resource_chunk'].includes(command))).toBe(false)
  const pageSvg = api.invoke.mock.calls.find(([command]) => command === 'stage_pdf_page')![1].svg
  expect(pageSvg).toContain(`${quality === 'original' ? 'printflow-export:' : 'printflow-png:'}${staged.id}`)
  expect(pageSvg).toContain('rotate(25) scale(-1 1)')
})

test.each(['svg', 'png', 'jpg'])('%s export resolves a restored snapshot without hydrating it into the WebView', async format => {
  const reference = snapshotArtwork({ id: 'review', resourceId: 'r1', savedAt: 'now' })
  const lazyAsset = { ...asset, svg: reference }
  const page: Page = { ...pages[0], items: [{ ...pages[0].items[0], backSvg: undefined, svgLayerIds: undefined }] }
  await exportPage(page, [lazyAsset], `lazy.${format}`, format)
  expect(api.invoke).toHaveBeenCalledWith('stage_asset_artwork', expect.objectContaining({ source: expect.objectContaining({ svg: reference }), maxEdgePx: format === 'svg' ? null : Math.ceil(100 / 500 * 210 / 25.4 * 300) }))
  expect(api.invoke).toHaveBeenCalledWith('export_artwork', expect.objectContaining({ format, staged: true, svg: expect.stringContaining(format === 'svg' ? 'printflow-export:' : 'printflow-png:') }))
  expect(api.invoke.mock.calls.some(([command]) => command === 'load_schematic_review_resource')).toBe(false)
})

test.each([['standard', 300], ['high', 400], ['ultra', 500]] as const)('%s PDF stages selected PNG at the displayed size and retains vector geometry', async (quality, dpi) => {
  const before = JSON.stringify({ pages, asset })
  await exportPdf(pages, [asset], 'test.pdf', {}, undefined, undefined, defaultLayoutBounds, undefined, new Map([['i', 1.5]]), quality)
  const raster = api.invoke.mock.calls.find(([command]) => command === 'stage_schematic_png')?.[1]
  expect(raster, 'product SVG must be rasterized before PDF page parsing').toBeTruthy()
  expect(raster.maxEdgePx).toBe(Math.ceil(150 / 500 * 210 / 25.4 * dpi))
  expect(raster.layerIds).toEqual(['back'])
  expect(raster.sourceVersion).toMatch(/^[a-f0-9]{64}$/)
  const artwork = api.invoke.mock.calls.filter(([command]) => command === 'write_export_resource_chunk').map(([, args]) => args.text).join('')
  expect(artwork).toBe(selected)
  const page = api.invoke.mock.calls.find(([command]) => command === 'stage_pdf_page')![1].svg
  expect(page).toContain(`href="printflow-png:${raster.id}"`)
  expect(page).not.toContain('printflow-export:')
  expect(page).toContain('width="120" height="150" transform="translate(150 230) rotate(25) scale(-1 1)"')
  expect(page).toContain('<text')
  expect(page).toContain('Vector text')
  expect(page).toContain('<line')
  expect(JSON.stringify({ pages, asset })).toBe(before)
  expect(api.invoke.mock.calls.filter(([command]) => command === 'clear_pdf_pages').flatMap(([, args]) => args.ids)).toContain(raster.id)
  const review = createReviewRecord({ assets: [asset], pages, activePage: 3, metadata: { customerName: '', drawingDate: '', estimatedShipDate: '', designer: '' }, layoutBounds: defaultLayoutBounds, arrangementSort: 'default', defaultArrangementIds: ['a'] }, emptyArrangementDisplayState(), 'pdf', 'test.pdf')
  expect(review.assets[0].svg).toBe(original)
  expect(review.assets[0].storagePath).toBe('original.svg')
  expect(review.pages[0].items[0]).toEqual(pages[0].items[0])
  expect(JSON.stringify(review)).not.toContain('printflow-png:')
})

test('original PDF retains the existing original SVG path', async () => {
  await exportPdf(pages, [asset], 'test.pdf', {}, undefined, undefined, defaultLayoutBounds, undefined, undefined, 'original')
  expect(api.invoke.mock.calls.some(([command]) => command === 'stage_schematic_png')).toBe(false)
  expect(api.invoke.mock.calls.find(([command]) => command === 'stage_pdf_page')![1].svg).toContain('href="printflow-export:')
})

test('repeated layer selections share the largest required PNG while distinct selections stay separate', async () => {
  const page: Page = { ...pages[0], items: [pages[0].items[0], { ...pages[0].items[0], id: 'large', w: 160, h: 200 }, { ...pages[0].items[0], id: 'other-selection', svgLayerIds: ['front', 'window'] }] }
  await exportPdf([page], [asset], 'test.pdf')
  const rasters = api.invoke.mock.calls.filter(([command]) => command === 'stage_schematic_png').map(([, args]) => args)
  expect(rasters).toHaveLength(2)
  expect(rasters.find(args => args.layerIds[0] === 'back').maxEdgePx).toBe(Math.ceil(200 / 500 * 210 / 25.4 * 300))
  const document = new DOMParser().parseFromString(api.invoke.mock.calls.find(([command]) => command === 'stage_pdf_page')![1].svg, 'image/svg+xml')
  const hrefs = [...document.querySelectorAll('image')].map(image => image.getAttribute('href'))
  expect(hrefs[0]).toBe(hrefs[1])
  expect(hrefs[0]).not.toBe(hrefs[2])
})

test('PNG preparation failure aborts export and cleans partial resources', async () => {
  api.invoke.mockImplementation(async command => { if (command === 'stage_schematic_png') throw new Error('raster failed') })
  await expect(exportPdf(pages, [asset], 'test.pdf')).rejects.toThrow('raster failed')
  expect(api.invoke.mock.calls.some(([command]) => command === 'export_staged_pdf')).toBe(false)
  const rasterId = api.invoke.mock.calls.find(([command]) => command === 'stage_schematic_png')![1].id
  expect(api.invoke.mock.calls.filter(([command]) => command === 'clear_pdf_pages').flatMap(([, args]) => args.ids)).toContain(rasterId)
  expect(api.unlisten).toHaveBeenCalledOnce()
})
