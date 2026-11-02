import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, pageRasterSvg } from '../src/model.ts'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState.ts'
import { showBackArtwork } from '../src/modules/schematic/services/showBackArtworkService.ts'
import { refreshArrangementPages } from '../src/modules/schematic/services/refreshArrangementService.ts'
import { removeCanvasItems } from '../src/modules/schematic/services/removeCanvasItems.ts'

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`)
const asset = {
  id: 'asset', name: 'faces', productId: 'p', width: 100, height: 100, previewUrl: '', thumbnailUrl: '',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g id="front"><image id="f" width="100" height="100" href="front.png"/></g><g id="back" style="display:none"><image id="b" width="100" height="100" href="back.png"/></g><g id="window"><image id="w" width="100" height="100" href="window.png"/></g></svg>',
  sourceImages: [{ nodeId: 'f', layerRole: 'front' }, { nodeId: 'b', layerRole: 'back' }, { nodeId: 'w', layerRole: 'window' }],
}
const front = { id: 'front', assetId: 'asset', x: 75, y: 200, w: 45, h: 60, rotation: 0, caption: 'Front', rulerHeight: true, rulerHeightRange: [.1, .8] }
function fixture(width = 300) {
  const page = { id: 1, name: 'test', items: [front], imageGroups: [{ id: 'group', itemIds: ['front'], x: 30, y: 140, width, height: 160,
    detailsX: 245, detailWidth: 85, backgroundColor: '#123456', details: { size: 'custom', qt: '3', finish: '', note: 'preserved' },
    imageCells: [{ itemId: 'front', x: 35, y: 145, width: 100, height: 150 }] }] }
  const display = emptyArrangementDisplayState()
  display.visualScales.set('front', 1.4)
  display.dimensionDisplayOverrides.set('front', { precision: 'truncate', decimalPlaces: 2 })
  return { page, display }
}

test('back uses the marked layer and window, preserving the source and its current visual size', () => {
  const { page, display } = fixture()
  const original = structuredClone(page)
  const result = showBackArtwork(page, front.id, asset, display)
  const back = result.page.items[1]
  assert.deepEqual(page, original)
  assert.equal(display.visualScales.size, 1)
  assert.equal(result.page.items[0], front)
  close(back.x, front.x + front.w * 1.4 + GROUP_GAP * 2)
  for (const key of ['y', 'w', 'h', 'rotation']) assert.equal(back[key], front[key])
  assert.equal(result.display.visualScales.get(back.id), 1.4)
  assert.equal(back.manualBack, true)
  assert.equal(back.derivedFrom, front.id)
  assert.equal(back.mirrorX, true)
  assert.equal(back.suppressRuler, true)
  assert.match(back.backSvg, /back.png/)
  assert.match(back.backSvg, /window.png/)
  assert.doesNotMatch(back.backSvg, /front.png/)
  assert.deepEqual(result.page.imageGroups[0].itemIds, [front.id, back.id])
  assert.deepEqual(result.page.imageGroups[0].details, page.imageGroups[0].details)
  const staged = []
  pageRasterSvg(result.page, new Map([[asset.id, asset]]), {}, 1, result.display.dimensionDisplayOverrides,
    svg => { staged.push(svg); return 'staged.svg' }, defaultLayoutBounds, undefined, result.display.visualScales)
  assert.ok(staged.includes(back.backSvg))
})

test('no marked back leaves artwork unchanged, and repeating show back selects the same placement', () => {
  const { page, display } = fixture()
  assert.equal(showBackArtwork(page, front.id, { ...asset, sourceImages: undefined }, display), undefined)
  const result = showBackArtwork(page, front.id, asset, display)
  for (const selected of [front.id, result.itemId]) {
    const repeated = showBackArtwork(result.page, selected, asset, result.display)
    assert.equal(repeated.itemId, result.itemId)
    assert.equal(repeated.page, result.page)
    assert.equal(repeated.display, result.display)
  }
  const removed = removeCanvasItems([result.page], [result.itemId])[0]
  assert.deepEqual(removed.items, [front])
  assert.equal(showBackArtwork(removed, front.id, asset, result.display).page.items.length, 2)
})

test('rotation and manual zoom determine the gap, and occupied columns/properties move clear of the new back', () => {
  const { page, display } = fixture()
  const source = { ...front, rotation: 90 }
  const other = { ...front, id: 'other', x: 155, w: 20 }
  page.items = [source, other]
  page.imageGroups[0].itemIds.push(other.id)
  page.imageGroups[0].imageCells.push({ itemId: other.id, x: 145, y: 145, width: 40, height: 150 })
  page.imageGroups[0].detailsX = 190
  page.annotations = [{ id: 'ruler', kind: 'ruler', sourceItemId: other.id, x: 140, y: 160, x2: 140, y2: 240, measuredMm: 25 }]
  const result = showBackArtwork(page, source.id, asset, display)
  const back = result.page.items[1]
  close(back.x, source.x + source.h * 1.4 + GROUP_GAP * 2)
  const shifted = result.page.items.find(item => item.id === other.id)
  assert.ok(shifted.x - other.w / 2 > back.x + source.h * 1.4 / 2)
  assert.ok(result.page.imageGroups[0].detailsX >= shifted.x + other.w / 2 + GROUP_GAP)
  assert.equal(shifted.w, other.w)
  close(result.page.annotations[0].x - page.annotations[0].x, shifted.x - other.x)
  close(result.page.annotations[0].x2 - page.annotations[0].x2, shifted.x - other.x)
})

test('a narrow block grows without resizing artwork, and refresh keeps the pair together', () => {
  const { page, display } = fixture(140)
  page.imageGroups[0].detailsX = 120
  page.imageGroups[0].detailWidth = 50
  page.headerBlocks = [{ id: 'header', x: 30, y: 140 - HEADER_BLOCK_HEIGHT - GROUP_GAP, width: 140,
    columns: [{ id: 'column', imageMode: 'photo', detailLabel: 'custom header' }] }]
  const result = showBackArtwork(page, front.id, asset, display)
  assert.equal(result.requiresReflow, true)
  assert.ok(result.page.imageGroups[0].width > page.imageGroups[0].width)
  const [refreshed] = refreshArrangementPages([result.page], 1, defaultLayoutBounds)
  close(refreshed.items[1].x - refreshed.items[0].x, result.page.items[1].x - front.x)
  assert.equal(refreshed.items[1].w, front.w)
  assert.equal(refreshed.imageGroups[0].backgroundColor, '#123456')
  assert.equal(refreshed.headerBlocks.length, 1)
  assert.equal(refreshed.headerBlocks[0].columns[0].detailLabel, 'custom header')
  close(refreshed.headerBlocks[0].width, refreshed.imageGroups[0].width)
})

test('adding a back in an upper role row leaves the full-width lower role row untouched', () => {
  const { page, display } = fixture()
  const upper = { ...front, y: 175, w: 20, h: 20 }
  const lower = { ...front, id: 'lower', x: 280, y: 260, w: 60, h: 30 }
  page.items = [upper, lower]
  const group = page.imageGroups[0]
  group.itemIds.push(lower.id)
  group.detailsHeight = 70
  const result = showBackArtwork(page, upper.id, asset, display)
  assert.equal(result.requiresReflow, false)
  assert.equal(result.page.items.find(item => item.id === lower.id), lower)
  assert.equal(result.page.imageGroups[0].detailsX, group.detailsX)
})

test('oversized pairs do not create clipped or overlapping artwork', () => {
  const { page, display } = fixture()
  page.items = [{ ...front, w: 400 }]
  assert.throws(() => showBackArtwork(page, front.id, asset, display), /缩小图片/)
  assert.equal(page.items.length, 1)
})
