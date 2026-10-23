import { describe, expect, it } from 'vitest'
import { checkExportTemplate } from '../src/modules/imposition/impositionExportDiagnostics'
import { groupRepeatedPackingPages, summarizePackingResult } from '../src/modules/imposition/packingAlgorithms'
import { expandImpositionImages, type ProductionImage, type NestResult } from '../src/modules/imposition/impositionRecords'

function image(id: string, widthMm: number, heightMm: number, quantity = 1): ProductionImage {
  return {
    id,
    name: id,
    sourceFileName: `${id}.svg`,
    filePath: `${id}.svg`,
    widthMm,
    heightMm,
    productId: id,
    productName: id,
    attributes: { QT: String(quantity) },
    attributeImages: {},
    note: '',
    noteImage: null,
    productGroupId: id,
    productGroupLeaderId: id,
    productGroupPosition: 1,
  }
}

const placement = (id: string, sheetIndex: number) => ({ id, sheetIndex, xMm: 10, yMm: 12, widthMm: 20, heightMm: 20, rotationDeg: 0 })
const result = (placements: NestResult['placements']): NestResult => ({ placements, unplaced: [], sheetsUsed: 9, utilization: .1, algorithm: 'tools/material' })

describe('irregular solver result display', () => {
  it('folds repeated production boards without removing any QT placements', () => {
    const images = expandImpositionImages([image('a', 20, 20, 3), image('b', 20, 20, 2)])
    const plan = summarizePackingResult(result([
      placement('a', 0), { ...placement('b', 0), xMm: 33 },
      { ...placement('b#qt-2', 1), xMm: 33 }, { ...placement('a#qt-2', 1), rotationDeg: 360 },
      placement('a#qt-3', 2),
    ]), images, {})
    const before = JSON.stringify(plan.pages)
    const groups = groupRepeatedPackingPages(plan.pages)
    expect(groups.map(group => group.pageIndices)).toEqual([[0, 1], [2]])
    expect(groups.map(group => group.repeatCount)).toEqual([2, 1])
    expect(groups[0].page).toBe(plan.pages[0])
    expect(groups.reduce((sum, group) => sum + group.page.length * group.repeatCount, 0)).toBe(5)
    expect(plan.placedCount).toBe(5)
    expect(plan.sheetsUsed).toBe(3)
    expect(JSON.stringify(plan.pages)).toBe(before)
  })

  it('keeps different artwork, frame sizes, positions and rotations in separate display plans', () => {
    const images = expandImpositionImages([image('a', 20, 20, 5), image('b', 20, 20)])
    const plan = summarizePackingResult(result([
      placement('a', 0), placement('b', 1),
      { ...placement('a#qt-2', 2), xMm: 10.001 },
      { ...placement('a#qt-3', 3), rotationDeg: 90 },
      { ...placement('a#qt-4', 4), widthMm: 21 },
      { ...placement('a#qt-5', 5), heightMm: 21 },
    ]), images, { a: [[0, 0], [20, 0], [0, 20]], b: [[0, 0], [20, 0], [0, 20]] })
    expect(groupRepeatedPackingPages(plan.pages)).toHaveLength(6)
  })

  it('renders only returned placements, compacts board indices, and retains missing QT ids', () => {
    const images = expandImpositionImages([image('a', 20, 20, 3)])
    const plan = summarizePackingResult(result([placement('a', 2), placement('a', 2), placement('unknown', 3), placement('a#qt-2', 8)]), images, {})
    expect(plan.pages).toHaveLength(2)
    expect(plan.placedCount).toBe(2)
    expect(plan.unplacedIds).toEqual(['a#qt-3'])
    expect(plan.cuttingLines).toBe(1)
  })

  it('does not mistake different contours of the same dimensions for one cutting layout', () => {
    const images = [image('a', 20, 20), image('b', 20, 20)]
    const plan = summarizePackingResult(result([placement('a', 0), placement('b', 1)]), images, { a: [[0, 0], [20, 0], [0, 20]], b: [[0, 0], [20, 0], [20, 20], [0, 20]] })
    expect(plan.cuttingLines).toBe(2)
  })

  it('shares cutting layouts across artwork and equivalent negative rotations, but preserves print groups', () => {
    const images = [image('a', 20, 20), image('b', 20, 20), image('c', 20, 20)]
    const triangle: Array<[number, number]> = [[0, 0], [20, 0], [0, 20]]
    const plan = summarizePackingResult(result([
      { ...placement('a', 0), rotationDeg: -90 },
      { ...placement('b', 1), rotationDeg: 270 },
      { ...placement('c', 2), rotationDeg: 630 },
    ]), images, { a: triangle, b: triangle, c: triangle })
    expect(plan.cuttingLines).toBe(1)
    expect(groupRepeatedPackingPages(plan.pages)).toHaveLength(3)
  })

  it('includes frame dimensions in the cutting-layout identity used by the combined objective', () => {
    const images = expandImpositionImages([image('a', 20, 20, 3)])
    const plan = summarizePackingResult(result([
      placement('a', 0),
      { ...placement('a#qt-2', 1), widthMm: 21 },
      { ...placement('a#qt-3', 2), heightMm: 21 },
    ]), images, { a: [[0, 0], [20, 0], [0, 20]] })
    expect(plan.cuttingLines).toBe(3)
  })

  it('leaves the canvas empty when the solver has no placements', () => {
    const images = expandImpositionImages([image('a', 20, 20, 1300)])
    const plan = summarizePackingResult(result([]), images, {})
    expect(plan.pages).toEqual([])
    expect(plan.sheetsUsed).toBe(0)
    expect(plan.unplacedCount).toBe(1300)
  })
})


it('export diagnostics accepts interlocked true contours and checks the actual spacing', () => {
  const a = image('a', 20, 20)
  const b = image('b', 20, 20)
  const makeBoard = (offset: number) => ({ id: 'board', pageIndices: [0], productionCopies: 1, sourceIds: ['a', 'b'], placements: [
    { image: a, x: 0, y: 0, width: 20, height: 20, rotation: 0 },
    { image: b, x: offset, y: offset, width: 20, height: 20, rotation: 0 },
  ] })
  const geometry = { polygons: { a: [[0, 0], [20, 0], [0, 20]] as Array<[number, number]>, b: [[20, 0], [20, 20], [0, 20]] as Array<[number, number]> }, region: { left: 0, top: 0, right: 100, bottom: 100 }, spacing: 3 }
  // Image frames overlap, but the two triangular contours are 4.24 mm apart.
  expect(checkExportTemplate(makeBoard(3), 100, 100, geometry)).toEqual([])
  expect(checkExportTemplate(makeBoard(2), 100, 100, geometry)).toEqual([expect.stringContaining('间距小于 3 mm')])
  expect(checkExportTemplate(makeBoard(90), 100, 100, geometry)).toEqual([expect.stringContaining('超出版面有效区域')])
})
