import { describe, expect, it } from 'vitest'
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

  it('leaves the canvas empty when the solver has no placements', () => {
    const images = expandImpositionImages([image('a', 20, 20, 1300)])
    const plan = summarizePackingResult(result([]), images, {})
    expect(plan.pages).toEqual([])
    expect(plan.sheetsUsed).toBe(0)
    expect(plan.unplacedCount).toBe(1300)
  })
})
