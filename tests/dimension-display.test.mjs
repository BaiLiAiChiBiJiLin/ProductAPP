import test from 'node:test'
import assert from 'node:assert/strict'
import { groupForDimensionDisplay, pageForDimensionDisplay } from '../src/modules/schematic/services/dimensionDisplayService.ts'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'
import { updateSelectedRulers } from '../src/modules/schematic/services/canvasSelectionService.ts'

const asset = { id: 'art', width: 30, height: 60, attributes: { Size: '60 mm' } }
const assets = new Map([[asset.id, asset]])
const item = id => ({ id, assetId: asset.id, x: 40, y: 80, w: 30, h: 60, rotation: 0 })
const group = itemIds => ({ id: 'group', itemIds, x: 0, y: 0, width: 160, height: 200,
  details: { size: '60.0 mm', qt: '2', finish: 'Epoxy', note: 'Keep note' } })
const sizeLabels = group => imageDetailsLayout(group).fields.filter(field => field.key.startsWith('size')).map(field => field.text)

test('saved pages with both rulers disabled hide Size in canvas and export without deleting saved text', () => {
  const current = { id: 1, name: 'page', items: [{ ...item('one'), rulerWidth: false, rulerHeight: false }], imageGroups: [group(['one'])] }
  const before = JSON.stringify(current)
  const displayed = groupForDimensionDisplay(current.imageGroups[0], current, assets, ['one'], 'round', 2)
  const exported = pageForDimensionDisplay(current, assets).imageGroups[0]
  assert.deepEqual(sizeLabels(displayed), [])
  assert.deepEqual(sizeLabels(exported), [])
  assert.equal(displayed.details.qt, '2')
  assert.equal(displayed.details.note, 'Keep note')
  assert.equal(JSON.stringify(current), before)
  const restored = updateSelectedRulers(current, ['one'], { rulerHeight: true }, assets)
  assert.deepEqual(sizeLabels(groupForDimensionDisplay(restored.imageGroups[0], restored, assets)), ['Size: 60.0 mm'])
})

test('mixed chain Size lists keep visible members and never fall back to a stale scalar Size', () => {
  const current = { id: 1, name: 'page', items: [item('one'), item('two')], imageGroups: [group(['one', 'two'])] }
  current.imageGroups[0].details.sizes = [{ itemId: 'one', label: '60.0 mm' }, { itemId: 'two', label: 'custom size' }]
  const partlyHidden = updateSelectedRulers(current, ['one'], { rulerWidth: false, rulerHeight: false }, assets)
  assert.deepEqual(sizeLabels(groupForDimensionDisplay(partlyHidden.imageGroups[0], partlyHidden, assets)), ['Size: custom size'])
  const fullyHidden = updateSelectedRulers(partlyHidden, ['two'], { rulerWidth: false, rulerHeight: false }, assets)
  assert.deepEqual(sizeLabels(pageForDimensionDisplay(fullyHidden, assets).imageGroups[0]), [])
  assert.deepEqual(fullyHidden.imageGroups[0].details.sizes.map(value => value.label), ['60.0 mm', 'custom size'])
})

test('combined detail panels independently hide disabled Size and keep the other panel', () => {
  const current = { id: 1, name: 'page', items: [{ ...item('one'), rulerWidth: false, rulerHeight: false }, item('two')], imageGroups: [group(['one', 'two'])] }
  current.imageGroups[0].detailGroups = ['one', 'two'].map(id => ({ itemIds: [id], details: { ...current.imageGroups[0].details } }))
  const displayed = groupForDimensionDisplay(current.imageGroups[0], current, assets)
  assert.equal(displayed.detailGroups[0].details.size, '')
  assert.equal(displayed.detailGroups[1].details.size, '60.0 mm')
})
