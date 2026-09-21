import test from 'node:test'
import assert from 'node:assert/strict'
import { imageGroupsForDimension, imageDimensionForAsset, imageDimensionMarkerLayout, imageDimensionMarkersSvg } from '../src/modules/schematic/services/imageDimensionService.ts'

const assets = new Map([
  ['portrait', { id: 'portrait', width: 30, height: 60, attributes: { Size: '8 cm' } }],
  ['landscape', { id: 'landscape', width: 80, height: 40, attributes: { Size: '120mm' } }],
])
const item = (id, assetId, x, y, w, h) => ({ id, assetId, x, y, w, h, rotation: 0 })

test('explicit product cells give every image its own ruler, helper lines and source-size label', () => {
  const page = { id: 1, name: '页面 1', items: [item('one', 'portrait', 60, 60, 24, 48), item('two', 'landscape', 160, 60, 60, 30)], imageGroups: [{
    id: 'product', itemIds: ['one', 'two'], x: 10, y: 10, width: 400, height: 100,
    imageCells: [
      { itemId: 'one', x: 10, y: 10, width: 100, height: 100, label: '图 1' },
      { itemId: 'two', x: 110, y: 10, width: 100, height: 100, label: '图 2' },
    ],
  }] }
  const regions = imageGroupsForDimension(page)
  assert.deepEqual(regions.map(group => group.itemIds), [['one'], ['two']])
  const first = imageDimensionMarkerLayout(regions[0], page, assets)
  const second = imageDimensionMarkerLayout(regions[1], page, assets)
  assert.equal(first.label, '80 mm')
  assert.equal(first.extension[0][2], page.items[0].x)
  assert.equal(second.label, '120 mm')
  assert.equal(second.extension[0][3], page.items[1].y)
  assert.ok(second.x1 >= 110 && second.x2 <= 210)
  assert.equal(first.imageLabel, undefined)
  assert.equal(second.imageLabel, undefined)
  const svg = imageDimensionMarkersSvg(page, assets)
  assert.equal((svg.match(/data-printflow-dimension="true"/g) ?? []).length, 2)
  assert.match(svg, /data-item-id="one"/)
  assert.match(svg, /data-item-id="two"/)
  assert.match(svg, />80 mm<\/text>/)
  assert.match(svg, />120 mm<\/text>/)
  assert.doesNotMatch(svg, /图\s*\d/) 
})

test('legacy vertical stacks derive separate regions from each image position and bounds', () => {
  const page = { items: [item('top', 'portrait', 80, 50, 24, 40), item('bottom', 'portrait', 80, 155, 30, 70)], imageGroups: [{ id: 'stack', itemIds: ['bottom', 'top'], x: 20, y: 10, width: 240, height: 200, stacked: 'vertical' }] }
  const regions = imageGroupsForDimension(page)
  const byItem = new Map(regions.map(group => [group.itemIds[0], group]))
  assert.equal(byItem.get('top').y, 10)
  assert.equal(byItem.get('top').height, 85)
  assert.equal(byItem.get('bottom').y, 95)
  assert.equal(byItem.get('bottom').height, 115)
  for (const region of regions) {
    const marker = imageDimensionMarkerLayout(region, page, assets)
    assert.ok(marker.y1 >= region.y && marker.y2 <= region.y + region.height)
    assert.equal(marker.extension.length, 2)
  }
})

test('legacy horizontal Front/Back groups give each image half its own dimension ruler', () => {
  const page = { items: [item('left', 'landscape', 50, 60, 50, 25), item('right', 'landscape', 150, 60, 50, 25)], imageGroups: [{ id: 'pair', itemIds: ['left', 'right'], x: 0, y: 0, width: 400, height: 120 }] }
  const regions = imageGroupsForDimension(page)
  assert.deepEqual(regions.map(group => [group.x, group.width]), [[0, 200], [100, 200]])
  const markers = regions.map(group => imageDimensionMarkerLayout(group, page, assets))
  assert.ok(markers[0].x2 < markers[1].x1)
  assert.equal((imageDimensionMarkersSvg(page, assets).match(/data-printflow-dimension/g) ?? []).length, 2)
})

test('stale group members do not suppress standalone images or duplicate markers', () => {
  const page = { items: [item('one', 'portrait', 50, 60, 24, 48), item('free', 'landscape', 150, 60, 60, 30)], imageGroups: [{ id: 'stale', itemIds: ['missing', 'one'], x: 0, y: 0, width: 200, height: 120 }, { id: 'duplicate', itemIds: ['one'], x: 0, y: 0, width: 200, height: 120 }] }
  const regions = imageGroupsForDimension(page)
  assert.deepEqual(regions.map(group => group.itemIds), [['one'], ['free']])
  assert.equal((imageDimensionMarkersSvg(page, assets).match(/data-printflow-dimension/g) ?? []).length, 2)
})

test('dimension markers use valid physical group metadata and append millimetres', () => {
  const asset = { id: 'physical', width: 267, height: 267, sourceGroupWidthMm: 70.1998, sourceGroupHeightMm: 70.2, attributes: {} }
  assert.deepEqual(imageDimensionForAsset(asset), { label: '70.2 mm', horizontal: true })
})

test('dimension markers reject polluted physical metadata when its aspect ratio disagrees with the source', () => {
  const asset = { id: 'polluted', width: 155.20595, height: 196.20375, sourceGroupWidthMm: 98.48291, sourceGroupHeightMm: 479.15912, attributes: {} }
  assert.deepEqual(imageDimensionForAsset(asset), { label: '51.9 mm', horizontal: false })
})

