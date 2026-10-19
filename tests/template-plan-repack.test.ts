import { describe, expect, it } from 'vitest'
import { repackTemplatePlan } from '../src/modules/imposition/templatePlanRepack'
import { expandImpositionImages, type NestRequest, type NestResult, type ProductionImage } from '../src/modules/imposition/impositionRecords'

const images = expandImpositionImages([{ id: 'art', widthMm: 20, heightMm: 10, attributes: { QT: '2' } } as ProductionImage])
const request: NestRequest = {
  plateWidthMm: 100, plateHeightMm: 100, effectiveWidthMm: 90, effectiveHeightMm: 90, effectiveRightMm: 5, spacingMm: 3, objective: 'least-cutting',
  items: [{ id: 'art', widthMm: 20, heightMm: 10, quantity: 2 }],
  templateRepack: { templates: [], sourceTemplateId: 'a', targetTemplateId: 'b', sourceSlotIndex: 0, targetPlacement: { sourceId: 'art', xMm: 40, yMm: 30, rotationDeg: 180 } },
}
const result = (): NestResult => ({ placements: [
  { id: 'art', sheetIndex: 0, xMm: 40, yMm: 30, widthMm: 20, heightMm: 10, rotationDeg: 180 },
  { id: 'art#qt-2', sheetIndex: 1, xMm: 40, yMm: 30, widthMm: 20, heightMm: 10, rotationDeg: 180 },
], unplaced: [], sheetsUsed: 2, utilization: .1, algorithm: 'tools/template-repack' })

describe('cross-template result commit boundary', () => {
  it('passes full demand unchanged and accepts every QT exactly once', async () => {
    const next = await repackTemplatePlan(request, images, {}, async received => { expect(received).toBe(request); return result() })
    expect(next.placedCount).toBe(2)
    expect(next.pages.flat().map(item => item.image.id)).toEqual(['art', 'art#qt-2'])
  })
  it.each(['duplicate', 'missing', 'unknown', 'unplaced', 'lost-anchor', 'nonfinite', 'size'] as const)('rejects %s instead of committing an inconsistent production plan', async kind => {
    const value = result()
    if (kind === 'duplicate') value.placements[1].id = 'art'
    if (kind === 'missing') value.placements.pop()
    if (kind === 'unknown') value.placements[1].id = 'other'
    if (kind === 'unplaced') { value.placements.pop(); value.unplaced = ['art#qt-2'] }
    if (kind === 'lost-anchor') value.placements.forEach(item => { item.xMm = 25 })
    if (kind === 'nonfinite') value.placements[1].rotationDeg = NaN
    if (kind === 'size') value.placements[1].widthMm = 21
    await expect(repackTemplatePlan(request, images, {}, async () => value)).rejects.toThrow('已保留原方案')
  })
})
