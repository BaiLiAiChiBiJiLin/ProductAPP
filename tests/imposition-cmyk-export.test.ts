import { expect, test } from 'vitest'
import { createImpositionExportModel, parseImpositionSvgSource } from '../src/modules/imposition/impositionSvgExport'
import { createCmykExportPlan, type CmykSettings } from '../src/modules/imposition/impositionCmykExport'
import type { PackedItem } from '../src/modules/imposition/packingAlgorithms'
import type { ProductionImage } from '../src/modules/imposition/impositionRecords'

const settings: CmykSettings = { dpi: 400, autoAlign: true }
const image = { id: 'art', sourceImageId: 'art', name: 'art', filePath: 'art.svg', widthMm: 20, heightMm: 10 } as ProductionImage
const item = (n: number, width = 20): PackedItem => ({ image: { ...image, id: `art#qt-${n}` }, x: n * 22, y: 12, width, height: 10, rotation: 0 })
function model(svg: string, placements = [item(1), item(2)]) {
  const source = parseImpositionSvgSource({ sourceId: 'art', fileName: 'art.svg', svgText: `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 20 10">${svg}</svg>` })
  return createImpositionExportModel({ sources: { art: source }, pages: [placements], plateWidthMm: 300, plateHeightMm: 464, holes: { count: 2, sizeMm: 3, gapMm: 203.468, leftMm: 4 } })
}
const images = '<image id="front" width="20" height="10" href="data:image/png;base64,RlJPTlQ="/><image id="back" x="1" width="20" height="10" href="data:image/png;base64,QkFDSw=="/>'
test('QT copies reuse one source and preserve each canvas placement and millimetre holes', () => {
  const m = model(images.split('<image id="back"')[0])
  const p = createCmykExportPlan(m, m.templates[0].id, settings, {})!
  expect(p.sources).toHaveLength(1)
  expect(p.placements).toHaveLength(2)
  expect(p.placements.map(p => p.x)).toEqual([22, 44])
  expect(p.sources[0].front()).toContain('RlJPTlQ=')
  expect(p.sources[0].front()).not.toContain('QkFDSw==')
  expect(p.sources[0].back).toBeUndefined()
  expect(p.holes[1].y - p.holes[0].y + 2 * p.holes[0].radius).toBeCloseTo(203.468)
})
test('different sizes have separate render caches; front/back/window remain independent', () => {
  const m = model(images + '<rect id="window" fill="blue" width="20" height="10"/>', [item(1), item(2, 18)])
  const p = createCmykExportPlan(m, m.templates[0].id, settings, {})!
  expect(p.sources).toHaveLength(2)
  expect(p.sources[0].front()).not.toContain('id="window"')
  expect(p.sources[0].back!()).toContain('QkFDSw==')
  expect(p.sources[0].back!()).not.toContain('RlJPTlQ=')
  expect(p.sources[0].window!()).toContain('id="window"')
  expect(p.sources[0].window!()).not.toContain('<image')
})
test('a single front automatically uses same-face printing; back-only artwork needs a front assignment', () => {
  const m = model(images.split('<image id="back"')[0])
  const p = createCmykExportPlan(m, m.templates[0].id, settings, {})!
  expect(p.differentBack).toBe(false)
  expect(p.sources[0].back).toBeUndefined()
  m.assignments.art[m.sources.art.layers[0].id] = 'image-back'
  expect(() => createCmykExportPlan(m, m.templates[0].id, settings, {})).toThrow('指定图片正')
})

test('line-only layouts produce no CMYK file', () => {
  const m = model('<path d="M1 1H10" stroke="black" fill="none"/>')
  expect(createCmykExportPlan(m, m.templates[0].id, settings, {})).toBeUndefined()
})

test('SVG layer types select faces directly, including a reversed order and merged face layers', () => {
  const m = model(images + '<image id="extra" width="20" height="10" href="data:image/png;base64,RVhUUkE="/>')
  const [first, second, extra] = m.sources.art.layers
  expect(m.assignments.art[first.id]).toBe('image-front')
  expect(m.assignments.art[second.id]).toBe('image-back')
  m.assignments.art[first.id] = 'image-back'
  m.assignments.art[second.id] = 'image-front'
  m.assignments.art[extra.id] = 'image-front'
  const p = createCmykExportPlan(m, m.templates[0].id, settings, {})!
  expect(p.sources[0].front()).toContain('QkFDSw==')
  expect(p.sources[0].front()).toContain('RVhUUkE=')
  expect(p.sources[0].front()).not.toContain('RlJPTlQ=')
  expect(p.sources[0].back!()).toContain('RlJPTlQ=')
  expect(p.sources[0].back!()).not.toContain('QkFDSw==')
})

test('each board detects its own faces and windows, including same-face products mixed with different-face products', () => {
  const single = parseImpositionSvgSource({ sourceId: 'single', fileName: 'single.svg', svgText: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><image id="same" width="20" height="10" href="data:image/png;base64,U0FNRQ=="/></svg>' })
  const mixed = parseImpositionSvgSource({ sourceId: 'art', fileName: 'art.svg', svgText: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10">${images}<rect id="window" fill="blue" width="20" height="10"/></svg>` })
  const same = { ...item(3), image: { ...image, id: 'single#qt-1', sourceImageId: 'single' }, rotation: 180 }
  const m = createImpositionExportModel({ sources: { art: mixed, single }, pages: [[item(1), same], [same]], plateWidthMm: 300, plateHeightMm: 464 })
  const first = createCmykExportPlan(m, m.templates[0].id, settings, {})!
  const second = createCmykExportPlan(m, m.templates[1].id, settings, {})!
  expect(first.differentBack).toBe(true)
  expect(first.sources.find(source => source.label === 'art.svg')!.back!()).toContain('QkFDSw==')
  expect(first.sources.find(source => source.label === 'art.svg')!.window).toBeDefined()
  const reused = first.sources.find(source => source.label === 'single.svg')!
  expect(reused.front()).toContain('U0FNRQ==')
  expect(reused.back).toBeUndefined() // Native conversion reuses this front raster for back inks and White.
  expect(first.placements).toContainEqual({ sourceKey: reused.key, x: same.x, y: same.y, width: same.width, height: same.height, rotation: 180 })
  expect(second.differentBack).toBe(false)
  expect(second.sources.every(source => !source.back && !source.window)).toBe(true)
  // Per-board overrides must override automatic roles, without affecting other boards.
  const back = mixed.layers.find(layer => layer.label === 'back')!
  const window = mixed.layers.find(layer => layer.label === 'window')!
  m.templateAssignments = { [m.templates[0].id]: { art: { [back.id]: null, [window.id]: 'white' } } }
  const changed = createCmykExportPlan(m, m.templates[0].id, settings, {})!
  expect(changed.differentBack).toBe(false)
  expect(changed.sources.every(source => !source.back && !source.window)).toBe(true)
})
