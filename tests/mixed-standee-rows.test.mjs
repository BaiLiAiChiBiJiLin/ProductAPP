import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT, PAPER_WIDTH, headerCells, headerColumnBounds, pageSvg } from '../src/model.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { headerFor } from '../src/modules/schematic/arrangement/pageSections.ts'
import { compactPageSections, backfillPages } from '../src/modules/schematic/arrangement/backfillPages.ts'
import { fillFreeRegions } from '../src/modules/schematic/arrangement/freeRegionPacking.ts'

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`)
const standee = (id, span, productName = 'Clear Acrylic Standees', pictures = 1) => Array.from({ length: pictures + 1 }, (_, index) => {
  const base = index === pictures
  const width = base ? 85 : 70, height = base ? 22 : 153
  return { id: `${id}-${index}`, name: `${id}-${index}`, productId: productName, productName,
    productGroupId: id, productGroupPosition: index + 1, width, height, sourceGroupWidthMm: width, sourceGroupHeightMm: height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ff8080"/></svg>`,
    previewUrl: '', thumbnailUrl: '', attributes: { Finish: 'Front Side Epoxy', 'Print Option': span === 2 && !base ? 'Double Sided Different Design' : 'Double Sided Same Design' } }
})
const groupsInOrder = page => [...page.imageGroups].sort((a, b) => a.y - b.y || a.x - b.x)

function checkPages(pages, sources, bounds = defaultLayoutBounds) {
  assert.deepEqual(pages.flatMap(page => page.items.filter(item => !item.derivedFrom).map(item => item.assetId)).sort(), sources.map(asset => asset.id).sort())
  for (const page of pages) for (const group of page.imageGroups) {
    assert.ok(group.x >= bounds.left - 1e-6 && group.x + group.width <= PAPER_WIDTH - bounds.right + 1e-6)
    assert.ok(group.y >= bounds.top + HEADER_BLOCK_HEIGHT + GROUP_GAP - 1e-6 && group.y + group.height <= PAPER_HEIGHT - bounds.bottom + 1e-6)
    const header = headerFor(page, group)
    assert.ok(header, `missing header for ${group.id}`)
    const slot = headerColumnBounds(header).find(slot => Math.abs(header.x + slot.x - group.x) < 1e-6)
    assert.ok(slot, `missing column for ${group.id}`)
    close(slot.width, group.width)
    const details = headerCells(header).find(cell => cell.id === `${slot.column.id}-details`)
    close(header.x + details.x, group.detailsX)
    for (const other of page.imageGroups.filter(other => other !== group)) {
      assert.ok(group.x + group.width + GROUP_GAP <= other.x + 1e-6 || other.x + other.width + GROUP_GAP <= group.x + 1e-6
        || group.y + group.height + GROUP_GAP <= other.y + 1e-6 || other.y + other.height + GROUP_GAP <= group.y + 1e-6, `${group.id} overlaps ${other.id}`)
    }
  }
}

test('same-product one- and two-slot standees share a row and matching header in either order', () => {
  for (const spans of [[1, 2], [2, 1]]) {
    const sources = spans.flatMap((span, index) => standee(`stand-${index}`, span))
    const original = JSON.stringify(sources)
    const [page] = paginateAssets(sources)
    const [first, second] = groupsInOrder(page)
    close(first.y, second.y)
    close(second.x, first.x + first.width + GROUP_GAP)
    assert.equal(page.headerBlocks.length, 1)
    assert.deepEqual(page.headerBlocks[0].columns.map(column => column.span), spans)
    close(first.width + second.width + GROUP_GAP, PAPER_WIDTH - defaultLayoutBounds.left - defaultLayoutBounds.right)
    const main = page.items.filter(item => !item.derivedFrom && item.caption !== 'base')
    close(main[0].w, main[1].w); close(main[0].h, main[1].h)
    const svg = pageSvg(page, new Map(sources.map(asset => [asset.id, asset])))
    assert.equal((svg.match(/>Front\/Back<\/text>/g) ?? []).length, 2)
    checkPages([page], sources)
    assert.equal(JSON.stringify(sources), original)
  }
})

test('standees wrap only when remaining slots cannot fit the next whole group', () => {
  for (const spans of [[1, 2, 1, 2], [2, 1, 2, 1], [1, 1, 2], [2, 2, 1]]) {
    const sources = spans.flatMap((span, index) => standee(`stand-${index}`, span))
    const pages = paginateAssets(sources)
    checkPages(pages, sources)
    const groups = pages.flatMap(groupsInOrder)
    assert.ok(groups[2].y > groups[0].y || pages.length > 1)
    if (spans[0] === 2 && spans[1] === 2) {
      assert.ok(groups[1].y > groups[0].y)
      close(groups[1].y, groups[2].y)
    } else close(groups[0].y, groups[1].y)
  }
})

test('different products and protected sticker combinations never share standee rows', () => {
  const sources = [...standee('clear', 1), ...standee('glitter', 2, 'Glitter Acrylic Standees')]
  const [page] = paginateAssets(sources)
  assert.ok(page.imageGroups[1].y > page.imageGroups[0].y)
  checkPages([page], sources)
  const protectedSources = [...standee('sticker', 1), ...standee('normal', 2)]
  protectedSources[1].productName = 'Stickers'
  const pages = paginateAssets(protectedSources)
  assert.equal(pages.length, 2)
  checkPages(pages, protectedSources)
})

test('a mixed standee row moves to the next page as a whole when its fixed height will not fit', () => {
  const preceding = ['Keychains A', 'Keychains B'].map((productName, index) => ({
    ...standee(`preceding-${index}`, index === 0 ? 2 : 1, productName)[0], productGroupId: undefined,
  }))
  const sources = [...preceding, ...standee('short', 1), ...standee('tall', 2, 'Clear Acrylic Standees', 2)]
  const bounds = { ...defaultLayoutBounds, top: 100, bottom: PAPER_HEIGHT - 600 }
  const pages = paginateAssets(sources, 1000, bounds)
  assert.equal(pages.length, 2)
  const mixed = pages[1].imageGroups
  assert.deepEqual(mixed.map(group => group.productGroupId), ['short', 'tall'])
  close(mixed[0].y, mixed[1].y)
  checkPages(pages, sources, bounds)
})

test('mixed standee headers and relative sizes survive repeated reordering across pages and custom margins', () => {
  const sources = Array.from({ length: 16 }, (_, index) => standee(`stand-${index}`, index % 2 + 1)).flat()
  const bounds = { ...defaultLayoutBounds, top: 130, left: 20, right: 25, bottom: 45 }
  let pages = paginateAssets(sources, 1000, bounds)
  assert.ok(pages.length > 1)
  for (const order of [sources, [...sources].reverse(), sources]) {
    pages = autoArrangePages(pages, 1, order, bounds)
    checkPages(pages, sources, bounds)
    for (const page of pages) {
      for (const y of new Set(page.imageGroups.map(group => group.y))) {
        const row = page.imageGroups.filter(group => group.y === y)
        assert.equal(row.length, 2)
        close(row[0].width + row[1].width + GROUP_GAP, PAPER_WIDTH - bounds.left - bounds.right)
      }
    }
  }
})

test('compaction and free-region packing respect the unequal widths of mixed header slots', () => {
  const sources = [...standee('narrow', 1), ...standee('wide', 2)]
  const [page] = paginateAssets(sources)
  const wide = page.imageGroups[1]
  const x = wide.x
  page.imageGroups = [wide]
  page.items = page.items.filter(item => wide.itemIds.includes(item.id))
  compactPageSections(page, defaultLayoutBounds)
  close(wide.x, x)
  close(wide.detailsX, wide.x + wide.width - wide.detailWidth)
  const [later] = paginateAssets(standee('replacement', 1))
  later.id = 2
  const result = fillFreeRegions(backfillPages([page, later], defaultLayoutBounds), defaultLayoutBounds)
  assert.equal(result.length, 1)
  const [narrow, movedWide] = groupsInOrder(result[0])
  close(narrow.y, movedWide.y)
  close(movedWide.x, x)
  checkPages(result, [...standee('wide', 2), ...standee('replacement', 1)])
})
