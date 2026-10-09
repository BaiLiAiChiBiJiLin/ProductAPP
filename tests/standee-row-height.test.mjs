import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT, pageSvg } from '../src/model.ts'
import { autoArrangePages, paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { dimensionGroups, imageDimensionMarkerLayout } from '../src/modules/schematic/services/imageDimensionService.ts'
import { headerFor } from '../src/modules/schematic/arrangement/pageSections.ts'

const asset = (id, productName = 'Keychains', patch = {}) => ({ id, name: id, productId: productName, productName,
  width: 40, height: 100, sourceGroupWidthMm: 40, sourceGroupHeightMm: 100,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 100"><path d="M0 0H40V100H0Z" fill="pink"/></svg>',
  previewUrl: '', thumbnailUrl: '', attributes: { Finish: 'Front Side Epoxy' }, ...patch })
const standee = (id, different = false) => [
  asset(`${id}-main`, 'Clear Acrylic Standees', { productGroupId: id, productGroupPosition: 1,
    attributes: { Finish: 'Front Side Epoxy', 'Print Option': different ? 'Double Sided Different Design' : 'Double Sided Same Design' } }),
  asset(`${id}-base`, 'Clear Acrylic Standees', { productGroupId: id, productGroupPosition: 2,
    width: 80, height: 20, sourceGroupWidthMm: 80, sourceGroupHeightMm: 20 }),
]
const ordinary = count => Array.from({ length: count }, (_, index) => asset(`ordinary-${index}`))
const isStandee = group => /立牌|standees?/i.test(group.productKey ?? '')
const bottomOf = page => Math.max(...page.imageGroups.map(group => group.y + group.height))
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''}: ${actual} != ${expected}`)

function checkPage(page, bounds = defaultLayoutBounds) {
  for (const group of page.imageGroups) {
    if (isStandee(group)) {
      const expectedHeight = (PAPER_HEIGHT - bounds.bottom - bounds.top) / 3
      close(group.height, expectedHeight, 'standee height must stay exactly one third after pagination and backfill')
      close(group.backgroundHeight ?? group.height, expectedHeight, 'standee background must not absorb remaining page space')
    }
    assert.ok(group.y >= bounds.top + HEADER_BLOCK_HEIGHT + GROUP_GAP - 1e-6)
    assert.ok(group.y + group.height <= PAPER_HEIGHT - bounds.bottom + 1e-6)
    assert.ok(headerFor(page, group), `header missing for ${group.id}`)
    for (const header of page.headerBlocks) assert.ok(group.x + group.width <= header.x + 1e-6 || header.x + header.width <= group.x + 1e-6
      || group.y + group.height <= header.y + 1e-6 || header.y + HEADER_BLOCK_HEIGHT <= group.y + 1e-6, `header overlap: ${group.id}`)
    for (const other of page.imageGroups.filter(other => other !== group)) {
      assert.ok(group.x + group.width <= other.x + 1e-6 || other.x + other.width <= group.x + 1e-6
        || group.y + group.height <= other.y + 1e-6 || other.y + other.height <= group.y + 1e-6, `overlap: ${group.id}, ${other.id}`)
    }
    for (const item of page.items.filter(item => group.itemIds.includes(item.id))) {
      const cell = group.imageCells.find(cell => cell.itemId === item.id)
      assert.ok(item.y - item.h / 2 >= cell.y - 1e-6)
      assert.ok(item.y + item.h / 2 <= cell.y + cell.height + 1e-6)
      assert.ok(item.x - item.w / 2 >= cell.x - 1e-6)
      assert.ok(item.x + item.w / 2 <= cell.x + cell.width + 1e-6)
    }
  }
}

test('a mixed standee row reserves one third before pagination and moves excess ordinary products to the next page', () => {
  const sources = [...standee('one'), ...standee('two', true), ...ordinary(7)]
  const pages = paginateAssets(sources)
  assert.equal(pages.length, 2)
  assert.deepEqual(pages.flatMap(page => page.items.filter(item => !item.derivedFrom).map(item => item.assetId)).sort(), sources.map(asset => asset.id).sort())
  const [page] = pages
  const stands = page.imageGroups.filter(isStandee)
  assert.equal(stands.length, 2)
  close(stands[0].height, stands[1].height)
  close(stands[0].height, (PAPER_HEIGHT - defaultLayoutBounds.bottom - defaultLayoutBounds.top) / 3)
  close(stands[0].y, stands[1].y)
  assert.equal(page.imageGroups.filter(group => !isStandee(group)).length, 6)
  assert.ok(bottomOf(page) < PAPER_HEIGHT - defaultLayoutBounds.bottom - 1, 'unused height stays blank instead of stretching the standee row')
  assert.ok(page.imageGroups.filter(group => !isStandee(group)).every(group => group.height === 120))
  const nextHeader = page.headerBlocks.find(header => header.y > page.headerBlocks[0].y)
  close(nextHeader.y, stands[0].y + stands[0].height + GROUP_GAP)
  pages.forEach(page => checkPage(page))
})

test('sparse standee rows stay at one third with custom margins and repeated rearrangement', () => {
  const sources = Array.from({ length: 4 }, (_, index) => standee(`stand-${index}`)).flat()
  const original = JSON.stringify(sources)
  const bounds = { ...defaultLayoutBounds, top: 130, bottom: 45 }
  let pages = paginateAssets(sources, 1000, bounds)
  for (let attempt = 0; attempt < 3; attempt++) {
    const [page] = pages
    assert.equal(pages.length, 1)
    const rows = [...new Set(page.imageGroups.map(group => group.y))]
    assert.equal(rows.length, 2)
    const expectedHeight = (PAPER_HEIGHT - bounds.bottom - bounds.top) / 3
    page.imageGroups.forEach(group => close(group.height, expectedHeight))
    assert.ok(bottomOf(page) < PAPER_HEIGHT - bounds.bottom - 10)
    checkPage(page, bounds)
    pages = autoArrangePages(pages, 1, sources, bounds)
  }
  assert.equal(JSON.stringify(sources), original)
})

test('wide standee front/back, bases, rulers and export all follow the fixed row geometry on every page', () => {
  const sources = [...Array.from({ length: 7 }, (_, index) => standee(`wide-${index}`, true)).flat(), ...ordinary(7)]
  const pages = paginateAssets(sources)
  const assets = new Map(sources.map(asset => [asset.id, asset]))
  assert.ok(pages.length > 1)
  assert.equal(pages.flatMap(page => page.items).filter(item => !item.derivedFrom).length, sources.length)
  for (const page of pages) {
    checkPage(page)
    if (!page.imageGroups.some(isStandee)) continue
    for (const group of page.imageGroups.filter(isStandee)) {
      const [front, back, base] = page.items.filter(item => group.itemIds.includes(item.id))
      close(front.y, back.y); close(front.w, back.w); close(front.h, back.h)
      close(front.w / front.h, 0.4)
      assert.ok(base.y - base.h / 2 >= group.y + group.height * 0.48)
      close(group.detailsHeight, group.height * 0.48)
    }
    const svg = pageSvg(page, assets)
    for (const region of dimensionGroups(page)) {
      const marker = imageDimensionMarkerLayout(region, page, assets)
      assert.ok(Number.isFinite(marker.y2))
      assert.ok(svg.includes(`data-item-id="${marker.itemId}"`))
    }
    for (const group of page.imageGroups) assert.ok(svg.includes(`height="${group.height}"`))
  }
})

test('pages without standees retain the existing blank area and layout', () => {
  const [page] = paginateAssets(ordinary(4))
  assert.ok(bottomOf(page) < PAPER_HEIGHT - defaultLayoutBounds.bottom - 100)
  assert.ok(page.imageGroups.every(group => group.height === 120))
  checkPage(page)
})

test('standees before and after another product retain fixed one-third height through cross-page backfill', () => {
  const sources = [...standee('before'), ...ordinary(2), ...standee('after')]
  const [page] = paginateAssets(sources)
  const stands = page.imageGroups.filter(isStandee)
  assert.equal(stands.length, 2)
  close(stands[0].height, stands[1].height)
  close(stands[0].height, (PAPER_HEIGHT - defaultLayoutBounds.top - defaultLayoutBounds.bottom) / 3)
  assert.ok(bottomOf(page) < PAPER_HEIGHT - defaultLayoutBounds.bottom - 1)
  checkPage(page)
})

test('a lone Chinese standee keeps one-third height with or without sticker protection', () => {
  const sources = standee('chinese').map(asset => ({ ...asset, productName: '亚克力立牌' }))
  const [page] = paginateAssets(sources)
  close(page.imageGroups[0].height, (PAPER_HEIGHT - defaultLayoutBounds.top - defaultLayoutBounds.bottom) / 3)
  checkPage(page)
  sources[1].productName = '贴纸'
  const [protectedPage] = paginateAssets(sources)
  close(protectedPage.imageGroups[0].height, (PAPER_HEIGHT - defaultLayoutBounds.top - defaultLayoutBounds.bottom) / 3)
  assert.ok(bottomOf(protectedPage) < PAPER_HEIGHT - defaultLayoutBounds.bottom - 100)
  checkPage(protectedPage)
})

test('standee groups with several main pictures fit inside the same fixed one-third height', () => {
  const sources = [...standee('many').slice(0, 1), asset('extra-main', 'Clear Acrylic Standees', { productGroupId: 'many', productGroupPosition: 2 }),
    { ...standee('many')[1], productGroupPosition: 3 }]
  const [page] = paginateAssets(sources)
  close(page.imageGroups[0].height, (PAPER_HEIGHT - defaultLayoutBounds.top - defaultLayoutBounds.bottom) / 3)
  assert.equal(page.items.length, 3)
  checkPage(page)
})

test('mixed one- and two-slot groups reserve the same full row height when one has several main pictures', () => {
  const sources = [...standee('single'), ...standee('many', true).slice(0, 1),
    asset('extra-main', 'Clear Acrylic Standees', { productGroupId: 'many', productGroupPosition: 2 }),
    { ...standee('many', true)[1], productGroupPosition: 3 }, ...ordinary(7)]
  const pages = paginateAssets(sources)
  const stands = pages[0].imageGroups.filter(isStandee)
  assert.equal(stands.length, 2)
  close(stands[0].y, stands[1].y)
  close(stands[0].height, stands[1].height)
  pages.forEach(page => checkPage(page))
})
