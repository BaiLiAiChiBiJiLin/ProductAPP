import test from 'node:test'
import assert from 'node:assert/strict'
import { dimensionForItem, dimensionGroups, imageDimensionMarkerLayout, imageDimensionMarkersSvg, rulerDimensionLabel, rulerDimensionValue } from '../src/modules/schematic/services/imageDimensionService.ts'
import { updateRulerDimensionValue } from '../src/modules/schematic/services/rulerValueEditService.ts'
import { groupForDimensionDisplay, pageForDimensionDisplay } from '../src/modules/schematic/services/dimensionDisplayService.ts'
import { updateSelectedRulers } from '../src/modules/schematic/services/canvasSelectionService.ts'
import { autoArrangePages, paginateAssets } from '../src/modules/schematic/services/paginationService.ts'

const source = { id: 'art', name: 'Art', productId: 'p', width: 100, height: 200, attributes: { Size: '80 mm' }, svg: '<svg/>', previewUrl: '', thumbnailUrl: '' }
const assets = new Map([[source.id, source]])
function fixture(patch = {}) {
  return { id: 1, name: 'Page 1', items: [{ id: 'one', assetId: source.id, x: 90, y: 100, w: 50, h: 100, rotation: 0, rulerWidth: true, rulerHeight: true, sizeAxis: 'height', ...patch }], imageGroups: [{ id: 'g', itemIds: ['one'], x: 20, y: 20, width: 300, height: 200, details: { size: '80.0 mm', qt: '5', finish: '' } }] }
}

test('editing width keeps the height ruler and selected height Size; switching Size uses the saved width', () => {
  const original = fixture()
  const before = JSON.stringify(original)
  const edited = updateRulerDimensionValue(original, 'one', 'width', 32.75, assets)
  assert.equal(edited.items[0].rulerWidthMm, 32.75)
  assert.equal(edited.items[0].rulerHeightMm, undefined)
  assert.equal(edited.imageGroups[0].details.size, '80.0 mm')
  assert.equal(dimensionForItem(source, edited.items[0], 'width', 'default', 2).label, '32.75 mm')
  assert.equal(dimensionForItem(source, edited.items[0], 'height').label, '80.0 mm')
  const switched = updateSelectedRulers(edited, ['one'], { sizeAxis: 'width' }, assets)
  assert.equal(switched.imageGroups[0].details.size, '32.7 mm')
  assert.equal(JSON.stringify(original), before)
})

for (const [unit, input, valueMm] of [['mm', 25.4, 25.4], ['cm', 2.54, 25.4], ['in', 1, 25.4]]) {
  test(`editing a ${unit} ruler synchronizes Size, persists millimetres and converts when units change`, () => {
    const overrides = new Map([['one', { precision: 'default', decimalPlaces: 2 }]])
    const edited = updateRulerDimensionValue(fixture({ rulerUnit: unit }), 'one', 'height', input, assets, overrides)
    assert.equal(edited.items[0].rulerHeightMm, valueMm)
    assert.equal(rulerDimensionValue(source, edited.items[0], 'height'), input)
    assert.equal(edited.imageGroups[0].details.size, `${input.toFixed(2)} ${unit}`)
    const displayed = pageForDimensionDisplay(edited, assets, overrides)
    assert.equal(displayed.imageGroups[0].details.size, `${input.toFixed(2)} ${unit}`)
    assert.match(imageDimensionMarkersSvg(edited, assets, overrides), new RegExp(`>${input.toFixed(2).replace('.', '\\.')} ${unit}</text>`))
    assert.equal(rulerDimensionLabel(source, { ...edited.items[0], rulerUnit: 'in' }, 'default', 3), '1.000 in')
  })
}

test('only the edited member changes in size lists and combined panels', () => {
  const original = fixture()
  original.items.push({ ...original.items[0], id: 'two' })
  original.imageGroups[0].itemIds.push('two')
  original.imageGroups[0].details.sizes = [{ itemId: 'one', label: '80.0 mm' }, { itemId: 'two', label: '80.0 mm' }]
  original.imageGroups[0].detailGroups = ['one', 'two'].map(id => ({ itemIds: [id], details: { size: '80.0 mm', qt: id, finish: '' } }))
  const edited = updateRulerDimensionValue(original, 'two', 'height', 61, assets)
  assert.deepEqual(edited.imageGroups[0].details.sizes.map(value => value.label), ['80.0 mm', '61.0 mm'])
  assert.equal(edited.imageGroups[0].details.size, '80.0 mm')
  assert.deepEqual(edited.imageGroups[0].detailGroups.map(panel => panel.details.size), ['80.0 mm', '61.0 mm'])
  assert.equal(edited.items[0].rulerHeightMm, undefined)
})

test('edited values do not inherit another selection\'s precision settings', () => {
  const edited = updateRulerDimensionValue(fixture(), 'one', 'height', 61.75, assets)
  const group = edited.imageGroups[0]
  assert.equal(groupForDimensionDisplay(group, edited, assets, ['elsewhere'], 'round', 0).details.size, '61.7 mm')
  assert.equal(groupForDimensionDisplay(group, edited, assets, ['one'], 'round', 0).details.size, '62 mm')
  const overrides = new Map([['one', { precision: 'truncate', decimalPlaces: 2 }]])
  assert.equal(groupForDimensionDisplay(group, edited, assets, ['elsewhere'], 'round', 0, overrides).details.size, '61.75 mm')
})

test('edited standee label is not deducted again and preserves manual endpoint geometry', () => {
  const standee = { ...source, productName: 'Standees' }
  const standeeAssets = new Map([[source.id, standee]])
  const original = fixture({ rulerHeightRange: [0.1, 0.9] })
  const region = dimensionGroups(original).find(group => group.id.endsWith('-height'))
  const before = imageDimensionMarkerLayout(region, original, standeeAssets)
  const edited = updateRulerDimensionValue(original, 'one', 'height', 70, standeeAssets)
  const after = imageDimensionMarkerLayout(region, edited, standeeAssets)
  assert.equal(before.label, '76.6 mm')
  assert.equal(after.label, '70.0 mm')
  for (const key of ['x1', 'x2', 'y1', 'y2', 'imageStart', 'imageEnd', 'rangeMax']) assert.equal(after[key], before[key])
  assert.deepEqual(after.range, before.range)
})

test('invalid measurements do not change the page', () => {
  const original = fixture()
  for (const value of [0, -1, NaN, Infinity, -Infinity]) assert.equal(updateRulerDimensionValue(original, 'one', 'height', value, assets), original)
  assert.equal(updateRulerDimensionValue(original, 'missing', 'height', 40, assets), original)
  assert.equal(updateRulerDimensionValue(original, 'one', 'height', 40, new Map()), original)
})

test('auto arrange preserves edited ruler dimensions and regenerated Size', () => {
  const pages = paginateAssets([source])
  const id = pages[0].items[0].id
  const edited = updateRulerDimensionValue(pages[0], id, 'height', 63.5, assets)
  const result = autoArrangePages([edited], edited.id, [source])
  assert.equal(result[0].items[0].rulerHeightMm, 63.5)
  assert.equal(result[0].imageGroups[0].details.size, '63.5 mm')
})
