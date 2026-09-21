import test from 'node:test'
import assert from 'node:assert/strict'
import { initialGroupAssets, canSelectGroupAsset } from '../src/modules/schematic/grouping/productGroupSelection.ts'

test('initial guide follows click order for ordinary and manual confirmed selections', () => {
  const assets = [{ id: '1' }, { id: '2' }, { id: '3', attributesConfirmed: true }]
  assert.deepEqual(initialGroupAssets(assets, ['2', '1']).map(a => a.id), ['2', '1'])
  assert.deepEqual(initialGroupAssets(assets, ['3', '2', '1'], true).map(a => a.id), ['3', '2', '1'])
})

test('starting from a mixed bulk selection excludes confirmed assets, even previous group members', () => {
  const assets = [{ id: 'done', attributesConfirmed: true, productGroupId: 'old' },
    { id: 'new', productGroupId: 'old' }, { id: 'other', attributesConfirmed: false }, { id: 'untouched' }]
  assert.deepEqual(initialGroupAssets(assets, ['done', 'new', 'other']).map(a => a.id), ['other'])
  assert.deepEqual(initialGroupAssets(assets, ['done']), [])
  assert.deepEqual(initialGroupAssets(assets, ['new']), [])
})

test('confirmed cards cannot be selected from the list but existing member thumbnails remain editors', () => {
  const asset = { id: 'done', attributesConfirmed: true }
  assert.equal(canSelectGroupAsset(asset, []), false)
  assert.equal(canSelectGroupAsset(asset, ['done']), false)
  assert.equal(canSelectGroupAsset(asset, [], 'thumbnail'), false)
  assert.equal(canSelectGroupAsset(asset, ['done'], 'thumbnail'), true)
  assert.equal(canSelectGroupAsset({ id: 'new' }, []), true)
  assert.equal(canSelectGroupAsset({ id: 'new', attributesConfirmed: false }, []), true)
  assert.equal(canSelectGroupAsset({ id: 'old', productGroupId: 'old-group' }, []), false)
})
