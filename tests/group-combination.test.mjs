import test from 'node:test'
import assert from 'node:assert/strict'
import { GROUP_GAP } from '../src/model.ts'
import { combineImageGroups, combineImageGroupsAcrossPages } from '../src/modules/schematic/services/groupCombinationService.ts'

const assets = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id, productId: 'keychain', width: 40, height: 60, svg: '<svg/>', attributes: { Size: `${id}-source` } }))
function group(id, x, y, itemIds = [id], options = {}) {
  return { id: `g-${id}`, itemIds, x, y, width: 100, height: 100, details: { size: `${id}-edited`, qt: id, finish: 'custom', note: `note-${id}` }, ...options }
}
function item(id, assetId, x, y, options = {}) {
  return { id, assetId, x, y, w: 20, h: 40, rotation: 0, rulerHeight: true, rulerHeightMm: 62.7, rulerHeightRange: [.2, .9], svgLayerIds: ['front'], ...options }
}
function fixture(id = 1) {
  return { id, name: `Page ${id}`, items: [item('a', 'a', 35, 160), item('b', 'b', 145, 160), item('c', 'c', 255, 160)],
    imageGroups: [group('a', 10, 110), group('b', 120, 110), group('c', 230, 110)],
    annotations: [{ id: `note-${id}`, kind: 'text', x: 10, y: 10, text: 'keep', color: '#000', fontSize: 12 }] }
}
const findCombined = page => page.imageGroups.find(group => group.id.startsWith('group-combined-'))

test('three groups combine in visual order with editable data and independent details intact', () => {
  const page = fixture(), before = structuredClone(page)
  const next = combineImageGroups(page, ['g-c', 'g-a', 'g-b'], assets)
  const result = findCombined(next)
  assert.deepEqual(result.itemIds, ['a', 'b', 'c'])
  assert.equal(result.productGroupId, result.id)
  assert.equal(result.height, 300 + GROUP_GAP * 2)
  assert.equal(next.imageGroups.length, 1)
  assert.deepEqual(result.detailGroups.map(panel => panel.details.size), ['a-edited', 'b-edited', 'c-edited'])
  for (const source of page.items) {
    const moved = next.items.find(item => item.id === source.id)
    assert.deepEqual({ ...moved, x: source.x, y: source.y }, source)
  }
  assert.deepEqual(next.annotations, page.annotations)
  assert.deepEqual(page, before)
})

test('existing combinations merge again with ordinary groups without duplicating or nesting items', () => {
  const first = combineImageGroups(fixture(), ['g-a', 'g-b'], assets)
  const old = findCombined(first)
  const next = combineImageGroups(first, [old.id, 'g-c'], assets)
  const merged = findCombined(next)
  assert.deepEqual(merged.itemIds, ['a', 'b', 'c'])
  assert.equal(merged.productGroupId, merged.id)
  assert.equal(next.items.length, 3)
  assert.deepEqual(merged.detailGroups.map(panel => panel.itemIds), [['a'], ['b'], ['c']])
  assert.deepEqual(merged.detailGroups.map(panel => panel.details.note), ['note-a', 'note-b', 'note-c'])
})

test('multi-item source groups retain internal offsets regardless of page item storage order', () => {
  const page = fixture()
  page.items = [item('a-back', 'a', 75, 175, { derivedFrom: 'a', mirrorX: true }), page.items[2], page.items[0], page.items[1]]
  page.imageGroups[0].itemIds = ['a', 'a-back']
  const next = combineImageGroups(page, ['g-a', 'g-b', 'g-c'], assets)
  const front = next.items.find(item => item.id === 'a'), back = next.items.find(item => item.id === 'a-back')
  assert.equal(back.x - front.x, 40)
  assert.equal(back.y - front.y, 15)
  const second = next.items.find(item => item.id === 'b')
  assert.ok(Math.abs(second.y - front.y - 100 - GROUP_GAP) < 1e-6)
  assert.deepEqual(findCombined(next).itemIds, ['a', 'a-back', 'b', 'c'])
})

test('two existing combinations flatten every saved details panel', () => {
  const left = combineImageGroups(fixture(), ['g-a', 'g-b'], assets)
  const leftGroup = findCombined(left)
  const rightPage = { id: 2, name: 'Page 2', items: [item('d', 'd', 40, 150), item('e', 'e', 150, 150)], imageGroups: [group('d', 10, 100), group('e', 120, 100)] }
  const right = combineImageGroups(rightPage, ['g-d', 'g-e'], assets)
  const rightGroup = findCombined(right)
  const next = combineImageGroupsAcrossPages([left, right], [{ pageId: 2, groupId: rightGroup.id }, { pageId: 1, groupId: leftGroup.id }], assets)
  assert.deepEqual(findCombined(next[0]).itemIds, ['a', 'b', 'd', 'e'])
  assert.deepEqual(findCombined(next[0]).detailGroups.map(panel => panel.details.size), ['a-edited', 'b-edited', 'd-edited', 'e-edited'])
  assert.deepEqual(next[0].items.map(item => item.id).sort(), ['a', 'b', 'c', 'd', 'e'])
  assert.equal(next[1].items.length, 0)
})

test('three-page selection anchors to the earliest page and leaves unrelated pages and items alone', () => {
  const first = fixture(9)
  const second = { id: 4, name: 'Page 4', items: [item('d', 'd', 40, 150)], imageGroups: [group('d', 10, 100)], annotations: [] }
  const third = { id: 7, name: 'Page 7', items: [item('e', 'e', 40, 150)], imageGroups: [group('e', 10, 100)], annotations: [] }
  const unaffected = { id: 10, name: 'empty', items: [] }
  const pages = [first, second, third, unaffected], before = structuredClone(pages)
  const result = combineImageGroupsAcrossPages(pages, [{ pageId: 7, groupId: 'g-e' }, { pageId: 9, groupId: 'g-b' }, { pageId: 4, groupId: 'g-d' }], assets)
  assert.deepEqual(findCombined(result[0]).itemIds, ['b', 'd', 'e'])
  assert.equal(result[0].items.length, 5)
  assert.equal(result[1].items.length, 0)
  assert.equal(result[2].items.length, 0)
  assert.equal(result[3], unaffected)
  assert.equal(result[0].items.find(item => item.id === 'a'), first.items[0])
  assert.deepEqual(pages, before)
})

test('repeated selections are deduplicated but fewer than two distinct valid groups are rejected', () => {
  const next = combineImageGroups(fixture(), ['g-a', 'g-a', 'g-b'], assets)
  assert.deepEqual(findCombined(next).itemIds, ['a', 'b'])
  assert.equal(next.items.length, 3)
  assert.throws(() => combineImageGroups(fixture(), ['g-a', 'g-a'], assets), /至少.*两|至少.*2/)
  assert.throws(() => combineImageGroups(fixture(), ['g-a', 'missing'], assets), /有效|不存在/)
  assert.throws(() => combineImageGroupsAcrossPages([fixture()], [{ pageId: 1, groupId: 'g-a' }, { pageId: 99, groupId: 'g-b' }], assets), /有效|不存在/)
})

test('invalid member references and different products cannot partially combine', () => {
  const page = fixture()
  page.imageGroups[0].itemIds.push('missing')
  assert.throws(() => combineImageGroups(page, ['g-a', 'g-b', 'g-c'], assets), /有效|不存在|图片/)
  assert.throws(() => combineImageGroups(fixture(), ['g-a', 'g-b', 'g-c'], assets.filter(asset => asset.id !== 'c')), /有效|不存在|图片/)
  assert.throws(() => combineImageGroups(fixture(), ['g-a', 'g-b', 'g-c'], assets.map(asset => asset.id === 'c' ? { ...asset, productId: 'standee' } : asset)), /相同产品/)
})

test('image cells including empty labels follow their source group translation', () => {
  const page = fixture()
  page.imageGroups[0].imageCells = [{ itemId: 'a', x: 10, y: 110, width: 60, height: 100, label: 'Front', labelColor: '#ff0000' }]
  page.imageGroups[1].imageCells = [{ itemId: 'b', x: 120, y: 110, width: 60, height: 100, label: 'Inside' },
    { itemId: 'empty-example-b', x: 180, y: 110, width: 40, height: 100, label: 'Example', labelColor: '#123abc' }]
  const result = combineImageGroups(page, ['g-a', 'g-b', 'g-c'], assets)
  const cells = findCombined(result).imageCells
  assert.deepEqual(cells[0], page.imageGroups[0].imageCells[0])
  const b = result.items.find(item => item.id === 'b'), oldB = page.items[1]
  for (const source of page.imageGroups[1].imageCells) {
    const shifted = cells.find(cell => cell.itemId === source.itemId)
    assert.deepEqual(shifted, { ...source, x: source.x + b.x - oldB.x, y: source.y + b.y - oldB.y })
  }
})

test('page-scoped group ids and repeated cross-page selections do not duplicate images', () => {
  const first = fixture(1)
  first.imageGroups[0].itemIds = ['a', 'a']
  const second = { id: 2, name: 'Page 2', items: [item('d', 'd', 30, 150)], imageGroups: [group('a', 10, 100, ['d'])] }
  const result = combineImageGroupsAcrossPages([first, second], [{ pageId: 2, groupId: 'g-a' }, { pageId: 1, groupId: 'g-a' }, { pageId: 2, groupId: 'g-a' }], assets)
  assert.deepEqual(findCombined(result[0]).itemIds, ['a', 'd'])
  assert.equal(result[0].items.length, 4)
  assert.equal(result[1].items.length, 0)
})

test('one-column and two-column groups center their image cells inside the combined image region', () => {
  const first = group('a', 10, 110, ['a'], { detailsX: 50, detailWidth: 60,
    imageCells: [{ itemId: 'a', x: 10, y: 110, width: 40, height: 100, label: 'Front' }] })
  const second = group('b', 120, 110, ['b', 'b-back'], { width: 200, detailsX: 200, detailWidth: 120,
    imageCells: [{ itemId: 'b', x: 120, y: 110, width: 40, height: 100, label: 'Front' }, { itemId: 'b-back', x: 160, y: 110, width: 40, height: 100, label: 'Back' }] })
  const page = { id: 1, name: 'mixed widths', imageGroups: [first, second],
    items: [item('a', 'a', 30, 160), item('b', 'b', 140, 160), item('b-back', 'b', 180, 160, { derivedFrom: 'b' })] }
  const result = combineImageGroups(page, [first.id, second.id], assets)
  const combined = findCombined(result)
  for (const cell of combined.imageCells) {
    assert.ok(cell.x >= combined.x)
    assert.ok(cell.x + cell.width <= combined.detailsX, `${cell.itemId} overlaps the details region`)
  }
  const front = result.items.find(item => item.id === 'b'), back = result.items.find(item => item.id === 'b-back')
  assert.equal(back.x - front.x, 40)
  assert.equal(back.y, front.y)
  assert.equal(result.items.find(item => item.id === 'a').x, combined.x + (combined.detailsX - combined.x) / 2)
})
