import test from 'node:test'
import assert from 'node:assert/strict'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { defaultLayoutBounds, GROUP_GAP, PAPER_WIDTH, PAPER_HEIGHT, HEADER_BLOCK_HEIGHT } from '../src/model.ts'
import { arrangePage } from '../src/modules/schematic/services/pageLayoutService.ts'
import { imageDimensionMarkerLayout } from '../src/modules/schematic/services/imageDimensionService.ts'

const image = (id, group = '', mode = 'front-back') => ({ id, name: id, productId: mode === 'front-back' ? 'standees' : 'keychains', productName: mode === 'front-back' ? 'Acrylic Standees' : 'Keychains',
  width: 267, height: 267, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="267" height="267"><circle cx="133.5" cy="133.5" r="130" fill="pink"/></svg>',
  attributes: { QT: '1', 'Print Option': mode === 'photo' ? 'Double Sided Same Design' : 'Double Sided Different Design' },
  productGroupId: group, productGroupLeaderId: group ? 'g1' : undefined })

const compactAssets = () => [image('g1', 'g'), image('g2', 'g'), image('g3', 'g'), image('single1'), image('single2'), image('photo', '', 'photo'), image('different', '', 'separate')]

test('product groups use horizontal cells while short groups keep their own row height', () => {
  const pages = paginateAssets(compactAssets().slice(0, 5), 1000)
  const groupFor = id => pages.flatMap(page => page.imageGroups.map(group => ({ ...group, assets: group.itemIds.map(itemId => page.items.find(item => item.id === itemId).assetId) }))).find(group => group.assets.includes(id))
  const tall = groupFor('g1'), first = groupFor('single1'), second = groupFor('single2')
  assert.ok(tall.imageColumns > 1, 'product images should use a horizontal multi-column grid')
  assert.ok(tall.height <= 220, `product group should not reserve one full row per image: ${tall.height}`)
  assert.ok(first.height <= 120, `single artwork was stretched to ${first.height}`)
  assert.equal(first.x, second.x, 'backfilled ordinary groups stay within the product page column')
  assert.ok(second.y >= first.y + first.height + GROUP_GAP - 1e-7, 'backfilled groups retain their vertical spacing')
})

test('product group rulers hug the artwork and let artwork grow into the freed cell space', () => {
  const assets = compactAssets().slice(0, 3)
  const [page] = paginateAssets(assets, 1000)
  const source = page.items.filter(item => page.imageGroups[0].itemIds.includes(item.id))
  assert.ok(source.every(item => item.w >= 70), 'group artwork should retain the source size in each image cell')
  assert.ok(page.imageGroups[0].imageColumns > 1, 'group artwork should occupy multiple horizontal cells')
  const byAsset = new Map(assets.map(asset => [asset.id, asset]))
  for (const item of source) {
    const group = page.imageGroups.find(group => group.itemIds.includes(item.id))
    const marker = imageDimensionMarkerLayout({ ...group, itemIds: [item.id] }, page, byAsset)
    assert.ok(marker)
    assert.ok(item.x - item.w / 2 - marker.x1 <= 3.5, 'vertical ruler should stay close to artwork')
  }
})

test('compact product groups share a row and backfilled ordinary groups use both cells', () => {
  const assets = [image('group-a-1', 'group-a'), image('group-a-2', 'group-a'), image('group-b-1', 'group-b'), image('group-b-2', 'group-b'), image('ordinary-a'), image('ordinary-b')]
  const [page] = paginateAssets(assets, 1000)
  const groupFor = id => page.imageGroups.find(group => group.itemIds.some(itemId => page.items.find(item => item.id === itemId)?.assetId === id))
  const groupA = groupFor('group-a-1')
  const groupB = groupFor('group-b-1')
  const ordinaryA = groupFor('ordinary-a')
  const ordinaryB = groupFor('ordinary-b')
  assert.ok(groupA && groupB && ordinaryA && ordinaryB)
  assert.ok(groupA.x + groupA.width + GROUP_GAP <= groupB.x + 1e-7, 'two product groups should occupy separate horizontal cells')
  assert.ok(ordinaryA.x + ordinaryA.width + GROUP_GAP <= ordinaryB.x + 1e-7, 'backfilled ordinary groups should use both header cells')
  assert.ok(page.headerBlocks[0].columns.length >= 2, 'the shared header should expose both occupied cells')
})

test('portrait product-group rulers stay just outside the artwork after rightward placement', () => {
  const assets = ['portrait1', 'portrait2'].map(id => ({ ...image(id, 'portrait-group'), width: 70, height: 100 }))
  const [page] = paginateAssets(assets, 1000)
  const byAsset = new Map(assets.map(asset => [asset.id, asset]))
  for (const item of page.items) {
    const group = page.imageGroups.find(group => group.itemIds.includes(item.id))
    const marker = imageDimensionMarkerLayout({ ...group, itemIds: [item.id] }, page, byAsset)
    assert.ok(marker && !marker.horizontal)
    assert.ok(marker.x1 < item.x - item.w / 2)
    assert.ok(item.x - item.w / 2 - marker.x1 <= 2.1, 'vertical ruler should hug the portrait artwork')
  }
})

test('sparse ordinary sections keep compact headers beside the product-group page', () => {
  const pages = paginateAssets(compactAssets(), 1000)
  assert.ok(pages.length >= 2, 'different print modes remain on their own automatic pages')
  const page = pages.find(candidate => candidate.items.some(item => item.assetId === 'single1'))
  assert.ok(page)
  const ordinary = page.items.filter(item => item.assetId === 'single1' || item.assetId === 'single2')
  assert.equal(ordinary.length, 2)
  assert.ok(ordinary[1].y > ordinary[0].y, 'backfilled ordinary groups should occupy later free rows')
  assert.ok(page.headerBlocks[0].assetIds.includes('single1') && page.headerBlocks[0].assetIds.includes('single2'))
})

function assertPacked(pages, assets) {
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.assetId)).sort(), assets.map(asset => asset.id).sort())
  for (const page of pages) {
    const modes = page.headerBlocks.map(header => header.columns[0].imageMode)
    assert.equal(new Set(modes).size, modes.length)
    const rectangles = [...page.imageGroups, ...page.headerBlocks.map(header => ({ ...header, height: HEADER_BLOCK_HEIGHT }))]
    for (const [index, rect] of rectangles.entries()) {
      assert.ok(rect.x >= defaultLayoutBounds.left - 1e-7 && rect.y >= defaultLayoutBounds.top - 1e-7)
      assert.ok(rect.x + rect.width <= PAPER_WIDTH - defaultLayoutBounds.right + 1e-7)
      assert.ok(rect.y + rect.height <= PAPER_HEIGHT - defaultLayoutBounds.bottom + 1e-7)
      for (const other of rectangles.slice(index + 1)) assert.ok(
        rect.x + rect.width + GROUP_GAP <= other.x + 1e-7 || other.x + other.width + GROUP_GAP <= rect.x + 1e-7
        || rect.y + rect.height + GROUP_GAP <= other.y + 1e-7 || other.y + other.height + GROUP_GAP <= rect.y + 1e-7,
        'headers and groups retain their gutters without overlapping')
    }
  }
}

test('compact sections survive page refresh and repeated automatic layout at the same artwork size', () => {
  const assets = compactAssets()
  const pages = paginateAssets(assets, 1000)
  const refreshed = pages.map(page => arrangePage(page))
  const repeated = autoArrangePages(refreshed, 1, assets, defaultLayoutBounds)
  assertPacked(repeated, assets)
  for (const next of [refreshed, repeated]) {
    assert.equal(next.length, pages.length)
    for (const item of next.flatMap(page => page.items)) {
      const original = pages.flatMap(page => page.items).find(source => source.id === item.id)
      for (const key of ['w', 'h', 'rotation']) assert.ok(Math.abs(item[key] - original[key]) < 1e-7)
    }
  }
})

test('mixed product groups continue across pages without overlapping headers or losing members', () => {
  const assets = Array.from({ length: 72 }, (_, index) => image(`many-${index}`, index % 9 < 4 ? `group-${Math.floor(index / 9)}` : '',
    ['front-back', 'photo', 'separate'][Math.floor(index / 24)]))
  const pages = paginateAssets(assets, 1000)
  assert.ok(pages.length > 1)
  assertPacked(pages, assets)
  for (const groupId of new Set(assets.map(asset => asset.productGroupId).filter(Boolean))) {
    assert.equal(pages.flatMap(page => page.imageGroups).filter(group => group.productGroupId === groupId).length, 1)
  }
})
