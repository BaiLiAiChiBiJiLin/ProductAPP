import { expect, it } from 'vitest'
import { constrainRotation } from '../src/modules/imposition/impositionRotation'
import { polygonsConflict, transformedPolygon, type PackedImpositionItem } from '../src/modules/imposition/impositionGeometry'

it('stops optional angle refinement when the geometry checks consume the interaction budget', () => {
  const item = { x: 40, y: 40, width: 20, height: 10, rotation: 0 } as PackedImpositionItem
  let elapsed = 0
  const angles: number[] = []
  const result = constrainRotation(item, 90, candidate => {
    elapsed += 6
    angles.push(candidate.rotation!)
    return candidate.rotation! <= 45
  }, { budgetMs: 8, now: () => elapsed })
  expect(angles).toEqual([90, 45])
  expect(result.item.rotation).toBe(45)
  expect(result.limited).toBe(true)
})

it('retains the last legal angle if one requested-angle check already exhausts the budget', () => {
  const item = { x: 40, y: 40, width: 20, height: 10, rotation: 10 } as PackedImpositionItem
  let elapsed = 0
  let checks = 0
  const result = constrainRotation(item, 90, () => { checks++; elapsed += 10; return false }, { now: () => elapsed })
  expect(checks).toBe(1)
  expect(result.item).toBe(item)
})

it.each([15, 30, 37, 60, 90, 135])('accepts exactly 3 mm between contours rotated %s° despite rounding', rotation => {
  const left = { x: 20, y: 20, width: 20, height: 10, rotation } as PackedImpositionItem
  const angle = rotation * Math.PI / 180
  const neighbor = (distance: number) => ({ ...left, x: left.x + Math.cos(angle) * (20 + distance), y: left.y + Math.sin(angle) * (20 + distance) })
  expect(polygonsConflict(transformedPolygon(left, rotation), transformedPolygon(neighbor(3), rotation), 3)).toBe(false)
  expect(polygonsConflict(transformedPolygon(left, rotation), transformedPolygon(neighbor(2.999), rotation), 3)).toBe(true)
})
