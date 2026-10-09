import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds } from '../src/model.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { dimensionGroups, imageDimensionMarkerLayout } from '../src/modules/schematic/services/imageDimensionService.ts'
import { applyPhysicalImageScale } from '../src/modules/schematic/arrangement/physicalImageSizing.ts'

const source = (id, width, height, productName = 'Keychains', patch = {}) => ({ id, name: id, productId: productName, productName,
  width, height, sourceGroupWidthMm: width, sourceGroupHeightMm: height, attributes: { Finish: 'Epoxy' },
  svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', previewUrl: '', thumbnailUrl: '', ...patch })
const standee = (id, width, height, different = false) => [
  source(id, width, height, 'Acrylic Standees', { productGroupId: id, productGroupPosition: 1,
    attributes: { Finish: 'Epoxy', 'Print Option': different ? 'Double Sided Different Design' : 'Double Sided Same Design' } }),
  source(`${id}-base`, 85, 20, 'Acrylic Standees', { productGroupId: id, productGroupPosition: 2 }),
]
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`)

test('standee main pictures use reclaimed side gutters for a 120 percent default while bases stay independent', () => {
  const layout = productKey => [{ id: 1, name: 'page', items: [
    { id: 'main', assetId: 'main', x: 48, y: 100, w: 50, h: 80, rotation: 0 },
    { id: 'base', assetId: 'base', x: 118, y: 140, w: 60, h: 15, rotation: 0, caption: 'base' },
  ], imageGroups: [{ id: 'group', productKey, itemIds: ['main', 'base'], x: 10, y: 10, width: 148, height: 190,
    detailsX: 78, detailWidth: 80, details: { size: '153.0 mm', qt: '', finish: 'Epoxy' }, imageCells: [
      { itemId: 'main', x: 10, y: 10, width: 68, height: 190 },
      { itemId: 'base', x: 78, y: 100, width: 80, height: 100 },
    ] }] }]
  const sizes = new Map([['main', { width: 95, height: 156.4 }], ['base', { width: 85, height: 20 }]])
  const [old] = applyPhysicalImageScale(layout('Keychains'), sizes)
  for (const productKey of ['Clear Acrylic Standees', '亚克力立牌']) {
    const [page] = applyPhysicalImageScale(layout(productKey), sizes)
    const [main, base] = page.items
    close(main.w, old.items[0].w * 1.2)
    close(main.h, old.items[0].h * 1.2)
    close(main.x - main.w / 2, 18)
    close(main.x + main.w / 2, page.imageGroups[0].detailsX)
    close(base.w, old.items[1].w); close(base.h, old.items[1].h)
    close(main.y, old.items[0].y)
    const asset = source('main', 95, 156.4, productKey)
    const marker = imageDimensionMarkerLayout(dimensionGroups(page)[0], page, new Map([['main', asset]]))
    close(marker.textX, page.imageGroups[0].x + 8 - 2)
    assert.ok(marker.x1 <= main.x - main.w / 2, 'the ruler does not cross into the artwork')
    assert.equal(marker.label, '153.0 mm')
  }
})

test('same-page groups of the same product share a size reference without shrinking unrelated products', () => {
  const assets = [...standee('same', 50, 155), ...standee('different', 50, 155, true), source('small', 40, 40), source('large', 80, 80)]
  const original = JSON.stringify(assets)
  const items = paginateAssets(assets).flatMap(page => page.items).filter(item => item.caption !== 'base')
  const different = items.filter(item => item.assetId === 'different')
  close(different[0].h, different[1].h)
  const ordinary = paginateAssets(assets.slice(-2)).flatMap(page => page.items)
  // Longer Size labels can reserve a slightly wider property column in a mixed batch.
  for (const reference of ordinary) assert.ok(items.find(item => item.id === reference.id).w >= reference.w * 0.85)
  assert.ok(items.find(item => item.assetId === 'small').w > 40, 'small charms must remain easy to see')
  close(items.find(item => item.assetId === 'large').w / items.find(item => item.assetId === 'small').w, Math.sqrt(2))
  assert.equal(JSON.stringify(assets), original)
})

test('a 151.7 mm wide standee cannot look larger than a 153 mm single-column standee on the same page', () => {
  const assets = [...standee('larger', 95, 156.4), ...standee('smaller', 72, 155.1, true)]
  const [page] = paginateAssets(assets)
  const larger = page.items.find(item => item.assetId === 'larger')
  const smaller = page.items.find(item => item.assetId === 'smaller' && !item.derivedFrom)
  const back = page.items.find(item => item.derivedFrom === smaller.id)
  assert.ok(smaller.h <= larger.h, 'the larger cell must not invert the physical size order')
  assert.ok(smaller.w < larger.w)
  assert.ok(smaller.h / larger.h > 0.98, 'nearly equal physical heights must look nearly equal')
  close(back.w, smaller.w); close(back.h, smaller.h)
  for (const group of page.imageGroups) {
    const base = page.items.find(item => group.itemIds.includes(item.id) && item.caption === 'base')
    const cell = group.imageCells.find(cell => cell.itemId === base.id)
    close(base.w, cell.width - 8)
  }
})

test('near sizes remain visually close and different sizes retain a visible difference inside one group', () => {
  const assets = [source('a', 42.6, 42.6), source('b', 43.1, 43.1), source('c', 86.2, 86.2)]
    .map(asset => ({ ...asset, productGroupId: 'group-combined-sizes' }))
  const [page] = paginateAssets(assets)
  const [a, b, c] = page.items
  close(b.w / a.w, Math.sqrt(43.1 / 42.6))
  close(c.w / b.w, Math.sqrt(2))
  assert.ok(c.w > 1.3 * b.w)
})

test('physical metadata controls comparison and a lone tiny image fills its available image column', () => {
  const a = source('millimetres', 40, 100)
  const b = { ...source('user-units', 400, 1000), sourceGroupWidthMm: 40, sourceGroupHeightMm: 100 }
  const [page] = paginateAssets([a, b])
  close(page.items[0].w, page.items[1].w)
  close(page.items[0].h, page.items[1].h)
  const [small] = paginateAssets([source('tiny', 5, 8)])
  const item = small.items[0]
  const cell = small.imageGroups[0].imageCells[0]
  close(item.w / item.h, 5 / 8)
  close(item.h, cell.height - 14 - 16)
  assert.ok(item.h > 80)
})

test('single portrait, square and landscape pictures use the right edge of their image column', () => {
  for (const [width, height] of [[50, 59.7], [60, 60], [80, 40]]) {
    const asset = source('main', width, height)
    const [page] = paginateAssets([asset])
    const item = page.items[0], group = page.imageGroups[0], cell = group.imageCells[0]
    close(item.x + item.w / 2, group.detailsX)
    close(item.x + item.w / 2, cell.x + cell.width)
    close(item.w / item.h, width / height)
    assert.ok(item.y - item.h / 2 >= cell.y + 14 - 1e-7)
    assert.ok(item.y + item.h / 2 <= cell.y + cell.height - 16 + 1e-7)
  }
  // Height, rather than width, limits very tall artwork; it must not stretch or spill.
  const [tall] = paginateAssets([source('tall', 10, 100)])
  const item = tall.items[0], group = tall.imageGroups[0], cell = group.imageCells[0]
  close(item.h, cell.height - 30)
  close(item.w / item.h, 0.1)
  assert.ok(item.x + item.w / 2 < group.detailsX)
})

test('extremely small images retain at least seventy percent of their own group reference size', () => {
  const [page] = paginateAssets([source('tiny', 1, 1), source('large', 100, 100)]
    .map(asset => ({ ...asset, productGroupId: 'group-combined-sizes' })))
  close(page.items[0].w / page.items[1].w, 0.7)
  assert.ok(page.items[0].w > 35)
})

test('each page independently maximizes its product reference and remains stable through rearrangement', () => {
  const assets = Array.from({ length: 15 }, (_, index) => source(`a-${index}`, 30 + index * 3, 50 + index * 3))
  let pages = paginateAssets(assets)
  assert.ok(pages.length > 1)
  const positions = JSON.stringify(pages)
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const page of pages) {
      const sourceHeight = item => assets.find(asset => asset.id === item.assetId).height
      const largest = Math.max(...page.items.map(sourceHeight))
      const reference = page.items[0].h / Math.max(0.7, Math.sqrt(sourceHeight(page.items[0]) / largest))
      let touchesLimit = false
      for (const item of page.items) {
        close(item.h / Math.max(0.7, Math.sqrt(sourceHeight(item) / largest)), reference)
        const cell = page.imageGroups.flatMap(group => group.imageCells).find(cell => cell.itemId === item.id)
        touchesLimit ||= Math.abs(item.w - (cell.width - 13)) < 1e-7 || Math.abs(item.h - (cell.height - 30)) < 1e-7
      }
      assert.ok(touchesLimit, 'another page must not reduce this page below its own fitting limit')
    }
    pages = autoArrangePages(pages, 1, assets, defaultLayoutBounds)
    // Rearrangement adds explicit optional ruler properties; compare geometry separately.
    for (const item of pages.flatMap(page => page.items)) {
      const previous = JSON.parse(positions).flatMap(page => page.items).find(before => before.id === item.id)
      close(item.x, previous.x); close(item.y, previous.y); close(item.w, previous.w); close(item.h, previous.h)
    }
  }
})

test('main pictures and their rulers are vertically centered within their own image cells', () => {
  const assets = [...standee('standing', 50, 155), source('ordinary', 43, 43),
    source('pair', 45, 70, 'Keychains', { attributes: { Finish: 'Epoxy', 'Print Option': 'Double Sided Different Design' } }),
    ...Array.from({ length: 3 }, (_, index) => source(`chain-${index}`, 30 + index * 15, 50 + index * 15, '串串', { productGroupId: 'chain' }))]
  const pages = paginateAssets(assets)
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  for (const page of pages) for (const group of page.imageGroups) {
    for (const item of page.items.filter(item => group.itemIds.includes(item.id))) {
      const cell = group.imageCells.find(cell => cell.itemId === item.id)
      assert.ok(Math.abs(item.y - (cell.y + cell.height / 2)) <= 12, `${item.id} is stuck at the top`)
      assert.ok(item.y + item.h / 2 <= cell.y + cell.height - 5 + 1e-7)
      assert.ok(item.y - item.h / 2 >= cell.y + 14 - 1e-7)
      const region = dimensionGroups(page).find(region => region.itemIds[0] === item.id)
      if (!region || item.w >= item.h) continue
      close(imageDimensionMarkerLayout(region, page, byId).y1, item.y - item.h / 2)
    }
  }
})
