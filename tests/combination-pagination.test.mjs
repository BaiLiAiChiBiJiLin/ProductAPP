import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds } from '../src/model.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { buildProductGroupDetails } from '../src/modules/schematic/arrangement/productGroupDetails.ts'
import { rulerDimensionLabel } from '../src/modules/schematic/services/imageDimensionService.ts'
import { combineImageGroupsAcrossPages } from '../src/modules/schematic/services/groupCombinationService.ts'

const source = (id, extra = {}) => ({ id, name: id, productId: 'p', productName: 'Keychains', width: 80, height: 100,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 100"/>', attributes: { Size: '40 mm', QT: '2' }, ...extra })
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`)

// This is the persisted contract of a manual combination: every original
// image cell and its artwork are translated together into one vertical block.
function combinedFixture(assets) {
  const pages = paginateAssets(assets)
  const groups = pages.flatMap(page => (page.imageGroups ?? []).map(group => ({ page, group })))
  const first = groups[0].group
  const items = [], cells = []
  let y = first.y
  for (const { page, group } of groups) {
    const dx = first.x - group.x, dy = y - group.y
    items.push(...group.itemIds.map(id => page.items.find(item => item.id === id)).map(item => ({ ...item, x: item.x + dx, y: item.y + dy })))
    cells.push(...group.imageCells.map(cell => ({ ...cell, x: cell.x + dx, y: cell.y + dy })))
    y += group.height + 4
  }
  const id = `group-combined-${items.map(item => item.id).join('-')}`
  const group = { ...first, id, productGroupId: id, stacked: 'vertical', itemIds: items.map(item => item.id),
    height: y - first.y - 4, imageCells: cells,
    detailGroups: buildProductGroupDetails(items, new Map(assets.map(asset => [asset.id, asset]))) }
  return [{ ...pages[0], items, imageGroups: [group] }]
}

test('manual combinations keep member order despite repeated source positions and reversed asset input', () => {
  const assets = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'].map((id, index) => source(id, { productGroupPosition: index % 2 + 1 }))
  let pages = combinedFixture(assets)
  const expected = pages[0].imageGroups[0].itemIds
  for (let pass = 0; pass < 3; pass++) {
    pages = autoArrangePages(pages, pages[0].id, [...assets].reverse(), defaultLayoutBounds)
    assert.equal(pages.flatMap(page => page.imageGroups).length, 1)
    assert.deepEqual(pages[0].imageGroups[0].itemIds, expected)
    assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)).sort(), [...expected].sort())
  }
})

test('rearranging combined standees preserves both original base cells and role geometry', () => {
  const assets = ['a', 'b'].flatMap(id => [
    source(`${id}-main`, { productName: 'Standees', productGroupId: id, productGroupPosition: 1 }),
    source(`${id}-base`, { productName: 'Standees', productGroupId: id, productGroupPosition: 2, width: 70, height: 20 }),
  ])
  let pages = combinedFixture(assets)
  const before = pages[0].imageGroups[0]
  for (let pass = 0; pass < 3; pass++) {
    pages = autoArrangePages(pages, pages[0].id, assets, defaultLayoutBounds)
    const group = pages[0].imageGroups[0]
    assert.equal(group.imageCells.length, before.imageCells.length)
    for (const id of ['item-a-base', 'item-b-base']) {
      const oldCell = before.imageCells.find(cell => cell.itemId === id)
      const cell = group.imageCells.find(cell => cell.itemId === id)
      close((cell.x - group.x) / group.width, (oldCell.x - before.x) / before.width)
      close((cell.y - group.y) / group.height, (oldCell.y - before.y) / before.height)
      close(cell.width / group.width, oldCell.width / before.width)
      close(cell.height / group.height, oldCell.height / before.height)
      const item = pages[0].items.find(item => item.id === id)
      assert.equal(item.caption, 'base')
      assert.equal(item.captionAlign, 'left')
      assert.equal(item.captionFontSize, 7)
    }
  }
})

test('combined detail panels retain quantities and notes while size follows each restored ruler', () => {
  const assets = [source('a', { attributes: { Size: '40 mm', QT: '2' }, note: 'first note' }),
    source('b', { attributes: { Size: '60 mm', QT: '8' }, note: 'second note' })]
  let pages = combinedFixture(assets)
  pages[0].items[0] = { ...pages[0].items[0], rulerHeight: true, rulerHeightMm: 37.5, rulerWidth: false, rulerUnit: 'mm' }
  const expected = pages[0].imageGroups[0].detailGroups.map(panel => ({ ids: panel.itemIds, qt: panel.details.qt, note: panel.details.note }))
  for (let pass = 0; pass < 3; pass++) {
    pages = autoArrangePages(pages, pages[0].id, assets, defaultLayoutBounds)
    const group = pages[0].imageGroups[0]
    assert.deepEqual(group.detailGroups?.map(panel => ({ ids: panel.itemIds, qt: panel.details.qt, note: panel.details.note })), expected)
    for (const panel of group.detailGroups) {
      const item = pages[0].items.find(item => panel.itemIds.includes(item.id))
      assert.equal(panel.details.size, rulerDimensionLabel(assets.find(asset => asset.id === item.assetId), item))
    }
  }
})

test('uncombined native product groups continue using their generated layout', () => {
  const assets = [source('main', { productName: 'Standees', productGroupId: 'native', productGroupPosition: 1 }),
    source('base', { productName: 'Standees', productGroupId: 'native', productGroupPosition: 2, width: 70, height: 20 })]
  const original = paginateAssets(assets)
  const rearranged = autoArrangePages(original, original[0].id, assets, defaultLayoutBounds)
  assert.deepEqual(rearranged[0].imageGroups[0].imageCells.map(({ itemId, x, y, width, height }) => ({ itemId, x, y, width, height })), original[0].imageGroups[0].imageCells)
  for (const item of original[0].items) {
    const after = rearranged[0].items.find(candidate => candidate.id === item.id)
    for (const key of ['x', 'y', 'w', 'h']) close(after[key], item[key])
  }
})

test('combining existing double-sided standees does not invent a Back for an earlier base', () => {
  const assets = ['a', 'b'].flatMap(id => ['main', 'base'].map((role, index) => source(`${id}-${role}`, {
    productName: 'Standees', productGroupId: id, productGroupPosition: index + 1,
    attributes: { Size: '40 mm', QT: '2', 'Print Option': 'Double Sided Different Design' },
  })))
  let pages = paginateAssets(assets)
  const expectedIds = pages.flatMap(page => page.items.map(item => item.id)).sort()
  const selections = pages.flatMap(page => page.imageGroups.map(group => ({ pageId: page.id, groupId: group.id })))
  pages = combineImageGroupsAcrossPages(pages, selections, assets)
  const id = pages[0].imageGroups[0].id
  for (let pass = 0; pass < 3; pass++) {
    pages = autoArrangePages(pages, pages[0].id, assets, defaultLayoutBounds)
    assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)).sort(), expectedIds)
    assert.equal(pages[0].imageGroups[0].id, id)
  }
})

test('recombining holder products preserves both sets of roles, captions and manual artwork edits', () => {
  const assets = ['a', 'b', 'c'].flatMap(id => ['Example', 'Front', 'Inside', 'Back'].map((role, index) => source(`${id}-${role}`, {
    name: role, productName: 'Shaker', productGroupId: id, productGroupPosition: index + 1,
  })))
  let pages = paginateAssets(assets)
  const edited = pages[0].items[0]
  Object.assign(edited, { rotation: 12, captionHidden: true, captionColor: '#123456', rulerHeightMm: 42.3, rulerHeight: true, rulerUnit: 'mm',
    svgLayerId: 'manual', svgLayerIds: ['manual'], backSvg: '<svg id="manual"/>' })
  const values = new Map(pages.flatMap(page => page.items.map(item => [item.id, item])))
  const selections = pages.flatMap(page => page.imageGroups.map(group => ({ pageId: page.id, groupId: group.id })))
  pages = combineImageGroupsAcrossPages(pages, selections.slice(0, 2), assets)
  pages = autoArrangePages(pages, pages[0].id, assets, defaultLayoutBounds)
  const all = pages.flatMap(page => page.imageGroups.map(group => ({ pageId: page.id, groupId: group.id })))
  pages = combineImageGroupsAcrossPages(pages, all, assets)
  const expected = pages[0].imageGroups[0]
  const scales = new Map([[edited.id, 1.2]])
  for (let pass = 0; pass < 3; pass++) {
    pages = autoArrangePages(pages, pages[0].id, [...assets].reverse(), defaultLayoutBounds, [], [], scales)
    const group = pages[0].imageGroups[0]
    assert.deepEqual(group.itemIds, expected.itemIds)
    for (const item of pages[0].items) {
      const before = values.get(item.id)
      for (const key of ['caption', 'rotation', 'captionHidden', 'captionColor', 'suppressRuler', 'rulerHeightMm', 'svgLayerIds', 'backSvg']) {
        assert.deepEqual(item[key], before[key], `${item.id}: ${key}`)
      }
    }
    for (const cell of group.imageCells) {
      const before = expected.imageCells.find(value => value.itemId === cell.itemId)
      close((cell.x - group.x) / group.width, (before.x - expected.x) / expected.width)
      close((cell.y - group.y) / group.height, (before.y - expected.y) / expected.height)
    }
  }
  assert.equal(scales.get(edited.id), 1.2)
})
