import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds, GROUP_GAP, headerCellLines, headerCells, PAPER_HEIGHT, PAPER_WIDTH, pageSvg, proportionalAssetSize, proportionalAssetSizeForAsset } from '../src/model.ts'
import { AUTO_MIN_IMAGE_SCALE, refreshAutomaticHeaders } from '../src/modules/schematic/services/automaticArrangementService.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { arrangePage } from '../src/modules/schematic/services/pageLayoutService.ts'

const asset = (id, width = 176, height = 168, productId = 'keychains', printOption = 'Double Sided Same Design') => ({
  id: String(id), name: String(id), productId, productName: productId, width, height,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="red"/></svg>`,
  attributes: { 'Print Option': printOption, Size: '1"', QT: '3' },
})

test('twelve photo groups fit three columns and four rows without entering details or losing gutters', () => {
  const assets = Array.from({ length: 12 }, (_, i) => asset(i))
  const [page] = paginateAssets(assets)
  assert.equal(page.headerBlocks[0].columns.length, 3)
  assert.equal(page.imageGroups.length, 12)
  assert.equal(new Set(page.imageGroups.map(group => group.y)).size, 4)
  for (const item of page.items) {
    const group = page.imageGroups.find(group => group.itemIds.includes(item.id))
    const reference = proportionalAssetSize(176, 168)
    assert.ok(item.w / reference.w >= AUTO_MIN_IMAGE_SCALE)
    assert.ok(Math.abs(item.w / item.h - 176 / 168) < 1e-9)
    assert.ok(item.x - item.w / 2 >= group.x)
    assert.ok(item.x + item.w / 2 <= group.x + group.width / 2)
    assert.ok(group.y + group.height <= PAPER_HEIGHT - defaultLayoutBounds.bottom + 1e-9)
  }
  const [a, b, , below] = page.imageGroups
  assert.ok(Math.abs(b.x - a.x - a.width - GROUP_GAP) < 1e-9)
  assert.ok(Math.abs(below.y - a.y - a.height - GROUP_GAP) < 1e-9)
})

test('SVG coordinate magnification does not change column count, placement, or pagination', () => {
  const base = Array.from({ length: 25 }, (_, i) => asset(i))
  const original = paginateAssets(base)
  const magnified = paginateAssets(base.map(item => ({ ...item, width: item.width * 10, height: item.height * 10 })))
  assert.deepEqual(magnified.map(page => page.items.length), original.map(page => page.items.length))
  for (let i = 0; i < original.length; i++) {
    assert.equal(magnified[i].headerBlocks[0].columns.length, original[i].headerBlocks[0].columns.length)
    original[i].items.forEach((item, j) => {
      for (const key of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(item[key] - magnified[i].items[j][key]) < 1e-8)
    })
  }
})

test('polluted physical metadata cannot turn a normal source image into a razor-thin layout item', () => {
  const polluted = { ...asset('polluted', 155, 196), sourceGroupWidthMm: 98.48, sourceGroupHeightMm: 479.16 }
  const expected = proportionalAssetSize(155, 196)
  const actual = proportionalAssetSizeForAsset(polluted)
  assert.deepEqual(actual, expected)
  assert.ok(Math.abs(actual.w / actual.h - 155 / 196) < 1e-9)
})

test('narrow regions reduce columns and automatic refresh preserves manually chosen headers', () => {
  const assets = Array.from({ length: 12 }, (_, i) => asset(i))
  const narrow = { ...defaultLayoutBounds, left: 115, right: 115 }
  assert.equal(paginateAssets(assets, 12, narrow)[0].headerBlocks[0].columns.length, 1)
  const page = paginateAssets(assets)[0]
  const old = { ...page, headerBlocks: page.headerBlocks.map(block => ({ ...block, columns: block.columns.slice(0, 2) })) }
  const refreshed = arrangePage(refreshAutomaticHeaders(old, assets, defaultLayoutBounds))
  assert.equal(refreshed.headerBlocks[0].columns.length, 3)
  const manual = { ...old, headerBlocks: old.headerBlocks.map(block => ({ ...block, auto: false })) }
  assert.deepEqual(refreshAutomaticHeaders(manual, assets, defaultLayoutBounds).headerBlocks, manual.headerBlocks)
  assert.equal(refreshed.items.length, 12)
})

test('denser sections keep every product under its own header and preserve all exported captions', () => {
  const assets = [0, 1, 2].map(i => asset(i, 176, 168, 'a')).concat([3, 4, 5, 6, 7].map(i => asset(i, 176, 168, 'b')))
  const [page] = paginateAssets(assets)
  assert.equal(page.headerBlocks.length, 1)
  for (const [index, block] of page.headerBlocks.entries()) {
    const end = page.headerBlocks[index + 1]?.y ?? PAPER_HEIGHT
    for (const item of page.items.filter(item => block.assetIds.includes(item.assetId))) {
      assert.ok(item.y - item.h / 2 > block.y + 18)
      assert.ok(item.y + item.h / 2 < end)
    }
  }
  assert.equal(new Set(page.items.map(item => item.assetId)).size, assets.length)
  const details = headerCells(page.headerBlocks[0]).find(cell => cell.role === 'details')
  assert.deepEqual(headerCellLines(details), ['Size/QT/Finish/', 'Accessory'])
  const svg = pageSvg(page, new Map(assets.map(item => [item.id, item])))
  assert.ok(svg.includes('>Size/QT/Finish/</text>'))
  assert.ok(svg.includes('>Accessory</text>'))
  assert.equal(PAPER_WIDTH, 500)
})

test('a second product is added to the same page only when its section still fits', () => {
  const first = Array.from({ length: 6 }, (_, i) => asset(i, 176, 168, 'compact-product'))
  const second = Array.from({ length: 3 }, (_, i) => asset(i + 6, 500, 500, 'Large Standees'))
  const pages = paginateAssets(first.concat(second), 1000)
  assert.equal(pages.length, 1)
  assert.deepEqual(pages[0].headerBlocks.map(block => [block.productLabel, block.assetIds.length]), [['compact-product', 6], ['Large Standees', 3]])
  assert.equal(new Set(pages[0].items.map(item => item.assetId)).size, 9)
  const tooMany = paginateAssets(Array.from({ length: 24 }, (_, i) => asset(i, 176, 168, 'compact-product')).concat(second), 1000)
  assert.ok(tooMany.length > 1)
  assert.ok(tooMany.every(page => page.headerBlocks.length > 0))
})

test('the same header mode merges products and print options under one table', () => {
  const assets = [
    asset('same-a', 176, 168, 'Clear Acrylic Standees', 'Double Sided Same Design'),
    asset('same-b', 176, 168, 'Clear Acrylic Standees', 'Double Sided Different Design'),
    asset('other', 176, 168, 'Circle Stickers', ''),
  ]
  const [page] = paginateAssets(assets, 1000)
  assert.deepEqual(page.headerBlocks.map(block => [block.productLabel, block.columns[0].imageMode, block.assetIds.length]), [['多个产品', 'front-back', 3]])
})

test('one visual header is not repeated when one mode is split into chunks on the same page', () => {
  const assets = Array.from({ length: 6 }, (_, i) => asset(i, 176, 168, 'photo-product'))
    .concat([asset('middle', 176, 168, 'Clear Acrylic Standees')])
    .concat(Array.from({ length: 6 }, (_, i) => asset(i + 6, 176, 168, 'photo-product')))
  const pages = paginateAssets(assets, 1000)
  for (const page of pages) {
    const modes = page.headerBlocks.map(block => block.columns[0]?.imageMode)
    assert.equal(modes.length, new Set(modes).size, `duplicate header mode on page ${page.id}`)
  }
})

test('a trailing one-row product keeps a bounded automatic scale instead of filling all remaining paper', () => {
  const first = Array.from({ length: 15 }, (_, i) => asset(i, 176, 168, 'Clear Acrylic Standees'))
  const last = asset('last', 176, 168, 'photo-product', 'Double Sided Same Design')
  const pages = paginateAssets(first.concat(last), 1000)
  const page = pages.at(-1)
  const item = page.items.find(candidate => candidate.assetId === 'last')
  const reference = proportionalAssetSize(176, 168)
  assert.ok(item, 'trailing product was placed')
  assert.ok(item.w / reference.w <= 1.5, `trailing image scale ${item.w / reference.w} is too large`)
})

test('refresh repairs duplicate automatic blocks already stored on a page', () => {
  const assets = Array.from({ length: 4 }, (_, i) => asset(i))
  const page = paginateAssets(assets, 1000)[0]
  const original = page.headerBlocks[0]
  const duplicate = { ...original, id: 'duplicate-auto-header', y: original.y + 120, assetIds: original.assetIds.slice(0, 2) }
  const refreshed = refreshAutomaticHeaders({ ...page, headerBlocks: [original, duplicate] }, assets, defaultLayoutBounds)
  assert.equal(refreshed.headerBlocks.filter(block => block.auto && block.columns[0]?.imageMode === 'photo').length, 1)
  assert.deepEqual(new Set(refreshed.headerBlocks[0].assetIds), new Set(assets.map(item => item.id)))
})

test('pagination uses spare space for a partial following header section', () => {
  const first = Array.from({ length: 6 }, (_, i) => asset(i, 176, 168, 'photo-product'))
  const second = Array.from({ length: 20 }, (_, i) => asset(`front-${i}`, 176, 168, 'Clear Acrylic Standees'))
  const pages = paginateAssets(first.concat(second), 1000)
  assert.ok(pages.length >= 2)
  assert.ok(pages[0].items.length > 6, `first page only contains ${pages[0].items.length} items`)
  assert.deepEqual(pages[0].headerBlocks.map(block => block.columns[0].imageMode), ['photo', 'front-back'])
  assert.equal(new Set(pages.flatMap(page => page.items.map(item => item.assetId))).size, 26)
})

test('a section fills available cells before starting its next page', () => {
  const assets = Array.from({ length: 26 }, (_, i) => asset(i, 176, 168, 'Clear Acrylic Standees'))
  const pages = paginateAssets(assets, 1000)
  assert.deepEqual(pages.map(page => page.items.length), [15, 11])
  assert.equal(pages[0].imageGroups.length, pages[0].headerBlocks[0].columns.length * new Set(pages[0].imageGroups.map(group => group.y)).size)
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.assetId)), assets.map(item => item.id))
  assert.ok(pages.every(page => page.imageGroups.every(group => group.height === 110)))
})

test('the 84-image case fills same-mode pages without squeezing rows or mixing header modes', () => {
  const assets = Array.from({ length: 56 }, (_, i) => asset(`photo-${i}`))
    .concat(Array.from({ length: 28 }, (_, i) => asset(`front-${i}`, 176, 168, 'Clear Acrylic Standees')))
  const pages = paginateAssets(assets, 1000)
  assert.deepEqual(pages.map(page => page.items.length), [15, 15, 15, 11, 15, 13])
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.assetId)), assets.map(item => item.id))
  for (const page of pages) {
    assert.equal(page.headerBlocks.length, 1)
    assert.ok(page.imageGroups.every(group => group.height === 110))
  }
})

test('unused accessory style metadata cannot change page density and tail rows keep the same height', () => {
  const assets = Array.from({ length: 26 }, (_, i) => asset(i))
  const plain = paginateAssets(assets, 1000)
  const withStyle = paginateAssets(assets.map(item => ({ ...item, attributes: { ...item.attributes, 'Accessories Style': 'unused-style' } })), 1000)
  assert.deepEqual(plain.map(page => page.items.length), withStyle.map(page => page.items.length))
  const heights = plain.flatMap(page => page.imageGroups.map(group => group.height))
  assert.ok(Math.max(...heights) / Math.min(...heights) < 1.05)
  assert.ok(plain.every(page => new Set(page.imageGroups.map(group => group.y)).size <= 5))
})

test('auto arrangement repaginates an old crowded page without adding unused pool assets', () => {
  const assets = Array.from({ length: 30 }, (_, i) => asset(i))
  const pages = paginateAssets(assets, 1000)
  const oldPage = { ...pages[0], items: pages.flatMap(page => page.items), imageGroups: pages.flatMap(page => page.imageGroups),
    headerBlocks: [{ ...pages[0].headerBlocks[0], assetIds: assets.map(item => item.id) }] }
  const result = autoArrangePages([oldPage], 1, assets.concat(asset('unused')), defaultLayoutBounds)
  assert.deepEqual(result.map(page => page.items.length), [15, 15])
  assert.deepEqual(new Set(result.flatMap(page => page.items.map(item => item.assetId))), new Set(assets.map(item => item.id)))
  assert.ok(result.every(page => page.headerBlocks.length === 1))
})

test('a manual header keeps automatic arrangement scoped to the current page', () => {
  const assets = Array.from({ length: 20 }, (_, i) => asset(i))
  const pages = paginateAssets(assets, 1000)
  pages[0].headerBlocks[0].auto = false
  const result = autoArrangePages(pages, pages[0].id, assets, defaultLayoutBounds)
  assert.deepEqual(result[0].headerBlocks, pages[0].headerBlocks)
  assert.equal(result[1], pages[1])
})
