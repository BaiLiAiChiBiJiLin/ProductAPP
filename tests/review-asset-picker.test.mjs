import test from 'node:test'
import assert from 'node:assert/strict'
import { toggleReviewAssetSelection } from '../src/modules/schematic/services/reviewAssetSelection.ts'

const assets = [
  { id: 'a', productGroupId: 'group-1' },
  { id: 'b', productGroupId: 'group-1' },
  { id: 'c', productGroupId: '' },
]

test('selecting a grouped image selects the complete group', () => {
  assert.deepEqual([...toggleReviewAssetSelection(assets, new Set(), 'a')].sort(), ['a', 'b'])
  assert.deepEqual([...toggleReviewAssetSelection(assets, new Set(['a']), 'a')].sort(), ['a', 'b'])
})

test('clicking a fully selected group removes the complete group', () => {
  assert.deepEqual([...toggleReviewAssetSelection(assets, new Set(['a', 'b']), 'b')], [])
})

test('un-grouped images remain individually selectable', () => {
  assert.deepEqual([...toggleReviewAssetSelection(assets, new Set(), 'c')], ['c'])
})
