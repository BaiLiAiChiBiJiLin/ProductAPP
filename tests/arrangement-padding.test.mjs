import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PAPER_WIDTH, defaultLayoutBounds, normalizeLayoutBounds, artworkBounds, arrangementFrameRect,
} from '../src/model.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { rearrangeProductPage } from '../src/modules/schematic/arrangement/rearrangeProductPage.ts'

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`)
const source = (id, productName = 'Keychains', group, position = 1, different = false) => ({
  id, name: id, productId: productName, productName, productGroupId: group, productGroupPosition: position,
  width: 40, height: 60, sourceGroupWidthMm: 40, sourceGroupHeightMm: 60,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60"/>', previewUrl: '', thumbnailUrl: '',
  attributes: { QT: '1', 'Print Option': different ? 'Double Sided Different Design' : 'Double Sided Same Design' },
})
const holder = (productName, group = 'holder') => ['Example', 'Front', 'Inside', 'Back'].map((role, index) => source(`${group}-${role}`, productName, group, index + 1))
const chain = (different = false) => ['one', 'two', 'three'].map((id, index) => source(`chain-${id}`, '串串', 'chain', index + 1, different))
const standee = (group, different = false) => [source(`${group}-main`, 'Standees', group, 1, different), {
  ...source(`${group}-base`, 'Standees', group, 2), width: 80, height: 25, sourceGroupWidthMm: 80, sourceGroupHeightMm: 25,
}]
const ordinary = (count = 3, different = false) => Array.from({ length: count }, (_, index) => source(`ordinary-${index}`, 'Keychains', undefined, 1, different))
const asymmetric = { top: 100, left: 18, right: 24, bottom: 22, paddingLeft: 11, paddingRight: 19 }

function assertInsidePadding(pages, bounds, assets) {
  const left = bounds.left + (bounds.paddingLeft ?? 0)
  const right = PAPER_WIDTH - bounds.right - (bounds.paddingRight ?? 0)
  const boxes = pages.flatMap(page => [...page.headerBlocks ?? [], ...page.imageGroups ?? []])
  assert.ok(boxes.length)
  for (const box of boxes) {
    assert.ok(box.x >= left - 1e-7, `${box.id} starts at ${box.x}, before content left ${left}`)
    assert.ok(box.x + box.width <= right + 1e-7, `${box.id} ends at ${box.x + box.width}, after content right ${right}`)
  }
  const presentIds = new Set(pages.flatMap(page => page.items.map(item => item.assetId)))
  assert.deepEqual([...presentIds].sort(), assets.map(asset => asset.id).sort())
}

test('new arrangements reserve three millimetres inside each side of the unchanged frame', () => {
  const unit = PAPER_WIDTH / 210
  close(defaultLayoutBounds.paddingLeft, 3 * unit)
  close(defaultLayoutBounds.paddingRight, 3 * unit)
  const assets = ordinary()
  const pages = paginateAssets(assets)
  const frame = arrangementFrameRect(defaultLayoutBounds)
  const header = pages[0].headerBlocks[0]
  close(header.x - frame.x, 3 * unit)
  close(frame.x + frame.width - (header.x + header.width), 3 * unit)
  close(pages[0].imageGroups[0].x - frame.x, 3 * unit)
  assertInsidePadding(pages, defaultLayoutBounds, assets)
})

for (const [name, assets] of [
  ['shaker and ordinary products', [...holder('Shaker'), ...ordinary()]],
  ['mixed one/two-column standees and chains', [...standee('standee-one'), ...standee('standee-two', true), ...chain()]],
  ['double-sided ordinary products, chains and photo holders', [...ordinary(4, true), ...chain(true), ...holder('Photocard Holders')]],
  ['protected stickers and ordinary products', [source('sticker-one', 'Stickers'), source('sticker-two', 'Stickers'), ...ordinary()]],
]) {
  test(`asymmetric inner padding contains all headers and groups for ${name}, including repeated re-arrangement`, () => {
    let pages = paginateAssets(assets, 12, asymmetric)
    for (let attempt = 0; attempt < 3; attempt++) {
      assertInsidePadding(pages, asymmetric, assets)
      pages = autoArrangePages(pages, 1, assets, asymmetric)
    }
    assertInsidePadding(pages, asymmetric, assets)
  })
}

test('inner padding changes the content area without moving or resizing the outer frame', () => {
  const outer = { top: 100, left: 18, right: 24, bottom: 22 }
  const originalFrame = arrangementFrameRect(outer)
  assert.deepEqual(arrangementFrameRect({ ...outer, paddingLeft: 11, paddingRight: 19 }), originalFrame)
  assert.deepEqual(arrangementFrameRect({ ...outer, paddingLeft: 1000, paddingRight: 1000 }), originalFrame)
  const content = artworkBounds({ ...outer, paddingLeft: 11, paddingRight: 19 })
  close(content.left, 29)
  close(content.right, 43)
  assert.equal(content.top, outer.top)
  assert.equal(content.bottom, outer.bottom)
})

test('content bounds consume padding exactly once across nested layout helpers', () => {
  for (const bounds of [defaultLayoutBounds, asymmetric, { ...asymmetric, paddingLeft: 0, paddingRight: 0 }]) {
    const once = artworkBounds(bounds)
    assert.equal(Object.hasOwn(once, 'paddingLeft'), false)
    assert.equal(Object.hasOwn(once, 'paddingRight'), false)
    assert.deepEqual(artworkBounds(once), once)
    assert.deepEqual(artworkBounds(artworkBounds(once)), once)
  }
})

test('legacy saved bounds without padding keep their original content edges and arrangement', () => {
  const legacy = { top: 100, left: 18, right: 24, bottom: 22 }
  assert.deepEqual(normalizeLayoutBounds(legacy), legacy)
  assert.deepEqual(artworkBounds(legacy), legacy)
  const assets = [...holder('照片夹'), ...ordinary()]
  const pages = paginateAssets(assets, 12, legacy)
  assertInsidePadding(pages, legacy, assets)
  close(pages[0].headerBlocks[0].x, legacy.left)
  close(pages[0].headerBlocks[0].width, PAPER_WIDTH - legacy.left - legacy.right)
  assert.deepEqual(paginateAssets(assets, 12, { ...legacy, paddingLeft: 0, paddingRight: 0 }), pages)
})

test('excessive inner padding is normalized to leave at least forty content units', () => {
  for (const bounds of [
    { ...asymmetric, paddingLeft: 1000, paddingRight: 1000 },
    { ...asymmetric, paddingLeft: 0, paddingRight: 1000 },
    { ...asymmetric, left: 460, right: 1000, paddingLeft: 1000, paddingRight: 1000 },
  ]) {
    const normalized = normalizeLayoutBounds(bounds)
    assert.ok(normalized.paddingLeft >= 0)
    assert.ok(normalized.paddingRight >= 0)
    const content = artworkBounds(normalized)
    close(PAPER_WIDTH - content.left - content.right, 40)
    assert.deepEqual(artworkBounds(content), content)
  }
})

test('rearranging an existing automatic header constrains it to newly added inner padding', () => {
  const bounds = { top: 100, left: 20, right: 20, bottom: 20, paddingLeft: 10, paddingRight: 18 }
  const page = { id: 1, name: 'saved page',
    items: [{ id: 'item-old', assetId: 'old', x: 60, y: 180, w: 30, h: 45, rotation: 0 }],
    imageGroups: [{ id: 'group-old', itemIds: ['item-old'], x: 20, y: 135, width: 150, height: 100 }],
    headerBlocks: [{ id: 'header-old', auto: true, x: 20, y: 100, width: 460,
      columns: Array.from({ length: 3 }, (_, index) => ({ id: `column-${index}`, imageMode: 'photo', detailLabel: 'Size/QT/Finish/Accessory' })) }],
  }
  const before = JSON.stringify(page)
  const result = rearrangeProductPage(page, bounds)
  assertInsidePadding([result], bounds, [{ id: 'old' }])
  assert.equal(result.headerBlocks[0].id, 'header-old')
  assert.equal(result.headerBlocks[0].auto, true)
  close(result.headerBlocks[0].x, 30)
  close(result.headerBlocks[0].width, 432)
  assert.equal(result.items[0].id, 'item-old')
  assert.equal(JSON.stringify(page), before)
})
