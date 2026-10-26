import test from 'node:test'
import assert from 'node:assert/strict'
import { imageGroupsForDimension, imageDimensionForAsset, imageDimensionMarkerLayout, imageDimensionMarkersSvg, dimensionGroups } from '../src/modules/schematic/services/imageDimensionService.ts'

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
  assert.equal(first.label, '80.0 mm')
  assert.equal(first.extension[0][2], page.items[0].x)
  assert.equal(second.label, '120.0 mm')
  assert.equal(second.extension[0][3], page.items[1].y)
  assert.ok(second.x1 >= 110 && second.x2 <= 210)
  assert.equal(first.imageLabel, undefined)
  assert.equal(second.imageLabel, undefined)
  const svg = imageDimensionMarkersSvg(page, assets)
  assert.equal((svg.match(/data-printflow-dimension="true"/g) ?? []).length, 2)
  assert.match(svg, /data-item-id="one"/)
  assert.match(svg, /data-item-id="two"/)
  assert.match(svg, />80\.0 mm<\/text>/)
  assert.match(svg, />120\.0 mm<\/text>/)
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

test('custom ruler ranges stay attached to the image geometry', () => {
 const source = { ...assets.get('landscape'), id: 'custom' }
 const custom = item('custom-item', 'custom', 100, 80, 80, 40)
 custom.rulerWidth = true
 custom.rulerHeight = false
 custom.rulerWidthRange = [0.25, 0.75]
 const page = { items: [custom], imageGroups: [{ id: 'custom-group', itemIds: [custom.id], x: 20, y: 20, width: 180, height: 100 }] }
 const marker = imageDimensionMarkerLayout(imageGroupsForDimension(page)[0], page, new Map([['custom', source]]))
 assert.deepEqual(marker.range, [0.25, 0.75])
 assert.equal(marker.x1, custom.x - custom.w / 2 + custom.w * 0.25)
 assert.equal(marker.x2, custom.x - custom.w / 2 + custom.w * 0.75)
})

test('a height ruler follows an image moved outside its original cell but inside the product block', () => {
  const original = item('moving', 'portrait', 60, 50, 24, 48)
  const page = { items: [original, item('other', 'landscape', 170, 150, 60, 30)], imageGroups: [{
    id: 'product', itemIds: ['moving', 'other'], x: 10, y: 10, width: 400, height: 210,
    imageCells: [
      { itemId: 'moving', x: 10, y: 10, width: 100, height: 80 },
      { itemId: 'other', x: 110, y: 100, width: 100, height: 120 },
    ],
  }] }
  const before = imageDimensionMarkerLayout(imageGroupsForDimension(page)[0], page, assets)
  const moved = { ...original, y: original.y + 80 }
  const movedPage = { ...page, items: [moved, page.items[1]] }
  const after = imageDimensionMarkerLayout(imageGroupsForDimension(movedPage)[0], movedPage, assets)
  assert.equal(after.y1, before.y1 + 80)
  assert.equal(after.y2, before.y2 + 80)
  assert.equal(after.textY, before.textY + 80)
  assert.equal(after.label, before.label)
  assert.deepEqual(after.range, before.range)
  assert.deepEqual(movedPage.imageGroups, page.imageGroups)
})

for (const range of [undefined, [0.25, 0.75]]) {
  test(`${range ? 'adjusted' : 'full-length'} width and height rulers follow left/up cell crossings and keep their positions in SVG`, () => {
    const original = { ...item('moving', 'portrait', 160, 150, 24, 48), rulerWidth: true, rulerHeight: true,
      rulerWidthRange: range, rulerHeightRange: range }
    const other = item('other', 'landscape', 260, 150, 60, 30)
    const page = { items: [original, other], imageGroups: [{
      id: 'product', itemIds: ['moving', 'other'], x: 10, y: 10, width: 400, height: 290,
      imageCells: [
        { itemId: 'moving', x: 110, y: 100, width: 100, height: 100 },
        { itemId: 'other', x: 210, y: 100, width: 100, height: 100 },
      ],
    }] }
    const before = dimensionGroups(page).map(group => imageDimensionMarkerLayout(group, page, assets))
    const movedPage = { ...page, items: [{ ...original, x: 80, y: 70 }, other] }
    const after = dimensionGroups(movedPage).map(group => imageDimensionMarkerLayout(group, movedPage, assets))
    for (const [index, expected] of [
      { x1: range ? 74 : 68, y1: 44, x2: range ? 86 : 92, y2: 44, textX: 80, textY: 41 },
      { x1: 64, y1: range ? 58 : 46, x2: 64, y2: range ? 82 : 94, textX: 64, textY: 70 },
    ].entries()) {
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(after[index][key], value, `${after[index].axis} ${key}`)
        assert.equal(after[index][key], before[index][key] - 80, `${after[index].axis} ${key} follows image`)
      }
      assert.deepEqual(after[index].extension, before[index].extension.map(line => line.map(value => value - 80)))
      assert.deepEqual(after[index].range, before[index].range)
      assert.equal(after[index].label, before[index].label)
    }
    assert.deepEqual(after[2], before[2], 'the other image ruler does not move')

    const exported = [...imageDimensionMarkersSvg(movedPage, assets).matchAll(/<g\b[^>]*data-item-id="moving"[^>]*>(.*?)<\/g>/g)].map(match => match[1])
    assert.equal(exported.length, 2)
    assert.ok(exported[0].includes(`<path d="M${range ? 74 : 68} 44l5 -2v4Z"`))
    assert.ok(exported[0].includes(`<path d="M${range ? 86 : 92} 44l-5 -2v4Z"`))
    assert.ok(exported[0].includes('<text x="80" y="41"'))
    assert.ok(exported[1].includes(`<path d="M64 ${range ? 58 : 46}l-2 5h4Z"`))
    assert.ok(exported[1].includes(`<path d="M64 ${range ? 82 : 94}l-2 -5h4Z"`))
    assert.ok(exported[1].includes('<text x="64" y="70"'))
    assert.equal(page.items[0], original)
    assert.deepEqual(movedPage.imageGroups, page.imageGroups)
  })
}

test('enabling the second ruler preserves an implicit default axis from older item data', () => {
  const source = { ...assets.get('landscape'), id: 'implicit-axis' }
  const custom = item('implicit-axis-item', source.id, 100, 80, 80, 40)
  custom.rulerHeight = true
  const page = { items: [custom], imageGroups: [{ id: 'implicit-axis-group', itemIds: [custom.id], x: 20, y: 20, width: 180, height: 100 }] }
  const groups = dimensionGroups(page)
  assert.equal(groups.length, 2)
  const markers = groups.map(group => imageDimensionMarkerLayout(group, page, new Map([[source.id, source]])))
  assert.deepEqual(markers.map(marker => marker.horizontal), [true, false])
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

