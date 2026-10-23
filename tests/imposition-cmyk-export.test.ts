import { expect, test } from 'vitest'
import { createImpositionExportModel, parseImpositionSvgSource } from '../src/modules/imposition/impositionSvgExport'
import { createCmykExportPlan, type CmykSettings } from '../src/modules/imposition/impositionCmykExport'
import type { PackedItem } from '../src/modules/imposition/packingAlgorithms'
import type { ProductionImage } from '../src/modules/imposition/impositionRecords'

const settings: CmykSettings = { dpi: 400, differentBack: false, includeWindow: false, autoAlign: true }
const image = { id: 'art', sourceImageId: 'art', name: 'art', filePath: 'art.svg', widthMm: 20, heightMm: 10 } as ProductionImage
const item = (n: number, width = 20): PackedItem => ({ image: { ...image, id: `art#qt-${n}` }, x: n * 22, y: 12, width, height: 10, rotation: 0 })
function model(svg: string, placements = [item(1), item(2)]) {
  const source = parseImpositionSvgSource({ sourceId: 'art', fileName: 'art.svg', svgText: `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 20 10">${svg}</svg>` })
  return createImpositionExportModel({ sources: { art: source }, pages: [placements], plateWidthMm: 300, plateHeightMm: 464, holes: { count: 2, sizeMm: 3, gapMm: 203.468, leftMm: 4 } })
}
const images = '<image id="front" width="20" height="10" href="data:image/png;base64,RlJPTlQ="/><image id="back" x="1" width="20" height="10" href="data:image/png;base64,QkFDSw=="/>'
test('QT copies reuse one source and preserve each canvas placement and millimetre holes', () => {
  const m = model(images)
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
  const p = createCmykExportPlan(m, m.templates[0].id, { ...settings, differentBack: true, includeWindow: true }, {})!
  expect(p.sources).toHaveLength(2)
  expect(p.sources[0].front()).not.toContain('id="window"')
  expect(p.sources[0].back!()).toContain('QkFDSw==')
  expect(p.sources[0].back!()).not.toContain('RlJPTlQ=')
  expect(p.sources[0].window!()).toContain('id="window"')
  expect(p.sources[0].window!()).not.toContain('<image')
})
test('different back cannot silently reuse the only front image', () => {
  const m = model(images.split('<image id="back"')[0])
  expect(() => createCmykExportPlan(m, m.templates[0].id, { ...settings, differentBack: true }, {})).toThrow('分别指定图片正、图片背')
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
  const p = createCmykExportPlan(m, m.templates[0].id, { ...settings, differentBack: true }, {})!
  expect(p.sources[0].front()).toContain('QkFDSw==')
  expect(p.sources[0].front()).toContain('RVhUUkE=')
  expect(p.sources[0].front()).not.toContain('RlJPTlQ=')
  expect(p.sources[0].back!()).toContain('RlJPTlQ=')
  expect(p.sources[0].back!()).not.toContain('QkFDSw==')
})
