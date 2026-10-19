import { describe, expect, it } from 'vitest'
import { applyPackingEdit } from '../src/modules/imposition/packingEdits'
import { groupRepeatedPackingPages } from '../src/modules/imposition/packingAlgorithms'
import type { PackedImpositionItem } from '../src/modules/imposition/ImpositionKonvaCanvas'
import type { ProductionImage } from '../src/modules/imposition/impositionRecords'

function item(id: string, x = 10): PackedImpositionItem {
  return { image: { id, sourceImageId: id.split('#qt-')[0] } as ProductionImage, x, y: 10, width: 20, height: 10, rotation: 0 }
}

describe('editing folded production plans', () => {
  it('updates just the matching slot on every copy, even when item order differs', () => {
    const a = item('art'); const b = item('art#qt-2', 40)
    const pages = [[a, b], [item('art#qt-4', 40), item('art#qt-3')]]
    const snapshot = JSON.stringify(pages)
    const result = applyPackingEdit(pages, 0, a, 0, { ...a, x: 12, rotation: 90 }, true)
    expect(result.pages[0][0]).toMatchObject({ x: 12, rotation: 90 })
    expect(result.pages[1][1]).toMatchObject({ x: 12, rotation: 90 })
    expect(result.pages[1][0]).toBe(pages[1][0])
    expect(result.edit.repeatedBoards).toBe(2)
    expect(groupRepeatedPackingPages(result.pages)).toHaveLength(1)
    expect(JSON.stringify(pages)).toBe(snapshot)
  })
  it('records a template change with full repeat counts and leaves committed QT intact', () => {
    const a = item('art')
    const pages = [[a], [item('art#qt-2')], [item('other', 50)], [item('other#qt-2', 50)], [item('other#qt-3', 50)]]
    const result = applyPackingEdit(pages, 0, a, 2, { ...a, x: 15 }, true)
    expect(result.pages).toBe(pages)
    expect(result.pages.flat().map(value => value.image.id).sort()).toEqual(pages.flat().map(value => value.image.id).sort())
    expect(result.edit.crossBoard).toBe(true)
    expect(result.edit.affectedImageIds).toEqual(['art', 'art#qt-2'])
    expect(result.edit.templateRepack).toEqual({
      templates: [
        { id: 'template-0', repeatCount: 2, placements: [{ sourceId: 'art', xMm: 10, yMm: 10, rotationDeg: 0 }] },
        { id: 'template-1', repeatCount: 3, placements: [{ sourceId: 'other', xMm: 50, yMm: 10, rotationDeg: 0 }] },
      ], sourceTemplateId: 'template-0', targetTemplateId: 'template-1', sourceSlotIndex: 0,
      targetPlacement: { sourceId: 'art', xMm: 15, yMm: 10, rotationDeg: 0 },
    })
  })
  it('identifies one slot when the source template contains two copies of the same artwork', () => {
    const a = item('art'); const b = item('art#qt-2', 40)
    const pages = [[a, b], [item('art#qt-4', 40), item('art#qt-3')], [item('other', 60)]]
    const result = applyPackingEdit(pages, 1, pages[1][0], 2, { ...b, x: 12 }, true)
    expect(result.edit.templateRepack?.sourceSlotIndex).toBe(1)
    expect(result.edit.affectedImageIds).toEqual(['art#qt-2', 'art#qt-4'])
    expect(result.pages).toBe(pages)
  })
  it('edits only one physical board when expanded', () => {
    const a = item('art'); const pages = [[a], [item('art#qt-2')]]
    const result = applyPackingEdit(pages, 0, a, 0, { ...a, x: 12 }, false)
    expect(result.pages[1]).toBe(pages[1])
    expect(result.edit.repeatedBoards).toBe(1)
  })
})
