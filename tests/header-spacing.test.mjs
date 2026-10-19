import test from 'node:test'
import assert from 'node:assert/strict'
import { artworkBounds, defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT } from '../src/model.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { paginateAutomaticAssets } from '../src/modules/schematic/services/automaticArrangementService.ts'
import { reflowAfterCombination } from '../src/modules/schematic/services/combinationReflowService.ts'
import { createHeaderBlock } from '../src/modules/schematic/services/headerBlockService.ts'
import { arrangePage } from '../src/modules/schematic/services/pageLayoutService.ts'
import { compactPageSections } from '../src/modules/schematic/arrangement/backfillPages.ts'
import { fillFreeRegions } from '../src/modules/schematic/arrangement/freeRegionPacking.ts'
import { headerFor } from '../src/modules/schematic/arrangement/pageSections.ts'

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`)
const bounds = { ...defaultLayoutBounds }
const area = artworkBounds(bounds)
const asset = (id, productName = 'Keychains', extra = {}) => ({
  id, name: id, productId: productName, productName, width: 60, height: 120,
  sourceGroupWidthMm: 30, sourceGroupHeightMm: 60,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 120"><rect width="60" height="120" fill="#4599d8"/></svg>',
  previewUrl: '', thumbnailUrl: '', attributes: { QT: '2' }, ...extra,
})
const sources = [
  ...['Example', 'Front', 'Inside', 'Back'].map((role, index) => asset(role, 'Shaker', {
    productGroupId: 'shaker', productGroupPosition: index + 1,
  })),
  ...Array.from({ length: 6 }, (_, index) => asset(`ordinary-${index}`)),
]

function assertHeaderBands(page) {
  const headers = [...page.headerBlocks].sort((a, b) => a.y - b.y)
  assert.ok(headers.length >= 2, 'fixture must contain full-width and three-column headers')
  let previousBottom = area.top
  for (const header of headers) {
    const groups = page.imageGroups.filter(group => headerFor(page, group) === header)
    assert.ok(groups.length)
    const firstRowTop = Math.min(...groups.map(group => group.y))
    close(header.y - previousBottom, GROUP_GAP)
    close(firstRowTop - header.y - HEADER_BLOCK_HEIGHT, GROUP_GAP)
    close(firstRowTop - previousBottom, HEADER_BLOCK_HEIGHT + 2 * GROUP_GAP)
    previousBottom = Math.max(...groups.map(group => group.y + (group.backgroundHeight ?? group.height)))
  }
}

test('first and later headers have equal white bands above and below the text area', () => {
  const [page] = paginateAssets(sources, 12, bounds)
  assertHeaderBands(page)
  close(page.headerBlocks[0].y, area.top + GROUP_GAP)
})

test('compaction and auto-arrangement preserve the first header top gap without adding it twice', () => {
  const pages = paginateAssets(sources, 12, bounds)
  compactPageSections(pages[0], bounds)
  assertHeaderBands(pages[0])
  const firstPass = structuredClone(pages[0])
  compactPageSections(pages[0], artworkBounds(bounds))
  assert.deepEqual(pages[0], firstPass)
  assertHeaderBands(autoArrangePages(pages, 1, sources, bounds)[0])
})

test('automatic and combination pagination reserve the first header top gap', () => {
  const ordinary = Array.from({ length: 8 }, (_, index) => asset(`auto-${index}`))
  const pages = paginateAutomaticAssets(ordinary, 12, bounds)
  const combined = reflowAfterCombination(pages, 0, ordinary, bounds, [])
  for (const page of [...pages, ...combined]) {
    close(Math.min(...page.headerBlocks.map(header => header.y)), area.top + GROUP_GAP)
    assert.ok(page.imageGroups.every(group => group.y + group.height <= PAPER_HEIGHT - area.bottom + 1e-7))
  }
})

test('manual header creation and arranging an old top-aligned header retain the same gap', () => {
  const header = createHeaderBlock(bounds, [])
  close(header.y, area.top + GROUP_GAP)
  const [page] = paginateAutomaticAssets([asset('manual')], 12, bounds)
  page.headerBlocks[0].y = area.top
  const arranged = arrangePage(page, bounds)
  close(arranged.headerBlocks[0].y, area.top + GROUP_GAP)
  close(arranged.imageGroups[0].y, area.top + HEADER_BLOCK_HEIGHT + 2 * GROUP_GAP)
})

test('free-region packing cannot consume the first header top gap', () => {
  const [source] = paginateAssets([asset('move')], 12, bounds)
  source.id = 2
  const empty = { id: 1, name: 'empty', items: [], headerBlocks: [], imageGroups: [] }
  const [page] = fillFreeRegions([empty, source], bounds)
  close(page.headerBlocks[0].y, area.top + GROUP_GAP)
  close(page.imageGroups[0].y, area.top + HEADER_BLOCK_HEIGHT + 2 * GROUP_GAP)
})

test('standee row height remains one third of the original arrangement area', () => {
  const [page] = paginateAssets([asset('standee', 'Clear Acrylic Standees')], 12, bounds)
  close(page.headerBlocks[0].y, area.top + GROUP_GAP)
  close(page.imageGroups[0].height, (PAPER_HEIGHT - area.top - area.bottom) / 3)
})
