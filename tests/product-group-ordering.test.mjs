import test from 'node:test'
import assert from 'node:assert/strict'
import { orderAssetsByProductGroup } from '../src/modules/schematic/services/productGroupOrdering.ts'

const asset = (id, productGroupId = '') => ({ id, productGroupId })

test('image list puts numbered groups first, keeping members and ordinary images stable', () => {
  const ordered = orderAssetsByProductGroup([
    asset('ordinary-0'), asset('group-a-1', 'a'), asset('ordinary-1'), asset('group-b-1', 'b'),
    asset('group-a-2', 'a'), asset('ordinary-2'), asset('group-b-2', 'b'),
  ])
  assert.deepEqual(ordered.map(item => item.id), [
    'group-a-1', 'group-a-2', 'group-b-1', 'group-b-2', 'ordinary-0', 'ordinary-1', 'ordinary-2',
  ])
})

test('repeated ordering and category filtering keep group numbers stable without changing source data', () => {
  const input = [asset('ordinary'), asset('b1', 'b'), asset('a1', 'a'), asset('b2', 'b')]
  const snapshot = structuredClone(input)
  const sorted = orderAssetsByProductGroup(input)
  assert.deepEqual(orderAssetsByProductGroup(sorted), sorted)
  assert.deepEqual(input, snapshot)
  assert.equal(new Set(sorted.map(item => item.id)).size, input.length)
  // Filter after sorting the full batch: first visible member alone must not renumber groups.
  assert.deepEqual(sorted.filter(item => item.id !== 'b1').map(item => item.id), ['b2', 'a1', 'ordinary'])
})

test('fixed product group order follows saved drag positions', () => {
  const ordered = orderAssetsByProductGroup([
    { ...asset('example', 'g'), productGroupPosition: 2 },
    { ...asset('front', 'g'), productGroupPosition: 1 },
    { ...asset('inside', 'g'), productGroupPosition: 3 },
    { ...asset('back', 'g'), productGroupPosition: 4 },
  ])
  assert.deepEqual(ordered.map(item => item.id), ['front', 'example', 'inside', 'back'])
})
