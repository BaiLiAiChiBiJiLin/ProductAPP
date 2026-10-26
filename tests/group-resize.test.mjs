import test from 'node:test'
import assert from 'node:assert/strict'
import { artworkBounds, defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT, PAPER_WIDTH, headerColumnBounds, pageSvg } from '../src/model.ts'
import { snapGroupResizeRect, resizeImageGroup, resizeGroupPages } from '../src/modules/schematic/services/groupResizeService.ts'
import { imageGroupsForPage } from '../src/modules/schematic/services/groupBackgroundService.ts'

const area = artworkBounds(defaultLayoutBounds)
const fullWidth = PAPER_WIDTH - area.left - area.right
const column = (fullWidth - GROUP_GAP * 2) / 3
const top = area.top + HEADER_BLOCK_HEIGHT + GROUP_GAP * 2
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`)
function fixture(id = 1, count = 8, height = 130, options = {}) {
  const groups = Array.from({ length: count }, (_, i) => ({ id: `g-${id}-${i}`, itemIds: [`i-${id}-${i}`], x: area.left + i % 3 * (column + GROUP_GAP), y: top + Math.floor(i / 3) * (height + GROUP_GAP),
    width: column, height, productKey: 'charms', backgroundColor: '#ff00aa80', details: { size: '60 mm', qt: '2', finish: '' },
    detailWidth: column * .4, detailsX: area.left + i % 3 * (column + GROUP_GAP) + column * .6,
    imageCells: [{ itemId: `i-${id}-${i}`, x: area.left + i % 3 * (column + GROUP_GAP), y: top + Math.floor(i / 3) * (height + GROUP_GAP), width: column * .6, height }], ...options }))
  return { id, name: `Page ${id}`, imageGroups: groups,
    items: groups.map(group => ({ id: group.itemIds[0], assetId: 'source', x: group.x + column * .3, y: group.y + height / 2, w: 40, h: 70,
      rotation: 0, rulerHeight: true, rulerHeightRange: [.1, .9], rulerHeightMm: 61.3, svgLayerIds: ['front'], backSvg: '<svg/>', captionColor: '#123456' })),
    headerBlocks: [{ id: `h-${id}`, x: area.left, y: top - HEADER_BLOCK_HEIGHT - GROUP_GAP, width: fullWidth,
      columns: [0, 1, 2].map(i => ({ id: `c-${i}`, imageMode: 'photo', detailLabel: 'Size/QT/Accessory' })) }] }
}
function assertLayout(pages) {
  for (const page of pages) {
    for (const [i, group] of page.imageGroups.entries()) {
      assert.ok(group.x >= area.left - 1e-6 && group.x + group.width <= PAPER_WIDTH - area.right + 1e-6)
      assert.ok(group.y >= top - 1e-6 && group.y + group.height <= PAPER_HEIGHT - area.bottom + 1e-6)
      for (const other of page.imageGroups.slice(i + 1)) assert.ok(group.x + group.width <= other.x + 1e-6 || other.x + other.width <= group.x + 1e-6
        || group.y + group.height <= other.y + 1e-6 || other.y + other.height <= group.y + 1e-6, 'blocks overlap')
    }
  }
}
const allIds = pages => pages.flatMap(page => page.items.map(item => item.id)).sort()

test('horizontal handles snap to one, two and three columns while vertical sizing stays continuous', () => {
  const group = fixture().imageGroups[0]
  for (const [width, expected] of [[column * 1.1, column], [column * 1.7, column * 2 + GROUP_GAP], [fullWidth - 10, fullWidth]]) {
    const rect = snapGroupResizeRect(group, { ...group, width }, defaultLayoutBounds, 'e')
    close(rect.width, expected); close(rect.x, group.x); close(rect.height, group.height)
  }
  const rect = snapGroupResizeRect(group, { ...group, height: 162.37 }, defaultLayoutBounds, 's')
  close(rect.height, 162.37); close(rect.width, group.width)
})

test('left and top handles preserve their opposite edge, corners apply both rules, bounds prevent page overflow', () => {
  const group = { ...fixture().imageGroups[2], y: top + 100 }
  const rect = snapGroupResizeRect(group, { ...group, x: group.x - column, y: group.y - 30, width: column * 2, height: 160 }, defaultLayoutBounds, 'nw')
  close(rect.x + rect.width, group.x + group.width)
  close(rect.y + rect.height, group.y + group.height)
  close(rect.width, column * 2 + GROUP_GAP); close(rect.height, 160)
  const oversized = snapGroupResizeRect(group, { ...group, width: 9999, height: 9999 }, defaultLayoutBounds, 'se')
  assert.ok(oversized.x + oversized.width <= PAPER_WIDTH - area.right + 1e-6)
  assert.ok(oversized.y + oversized.height <= PAPER_HEIGHT - area.bottom + 1e-6)
})

test('middle and right-column blocks can reach all three columns without exceeding the page', () => {
  const page = fixture()
  for (const index of [1, 2]) {
    const group = page.imageGroups[index]
    const rect = snapGroupResizeRect(group, { ...group, width: fullWidth }, defaultLayoutBounds, 'e')
    close(rect.width, fullWidth)
    close(rect.x, area.left)
    close(rect.x + rect.width, PAPER_WIDTH - area.right)
    close(rect.y, group.y)
  }
})

test('enlarging a block preserves image size and edits while expanding its image/details regions', () => {
  const page = fixture(), group = page.imageGroups[0], before = structuredClone(page)
  const resized = resizeImageGroup(page, group.id, { ...group, width: column * 2 + GROUP_GAP, height: 200 }, defaultLayoutBounds)
  assert.equal(resized.items[0].w, page.items[0].w); assert.equal(resized.items[0].h, page.items[0].h)
  assert.equal(resized.items[0].rulerHeightMm, 61.3)
  assert.deepEqual(resized.items[0].rulerHeightRange, [.1, .9])
  assert.deepEqual(resized.items[0].svgLayerIds, ['front'])
  assert.equal(resized.imageGroups[0].backgroundColor, group.backgroundColor)
  close(resized.imageGroups[0].detailWidth, resized.imageGroups[0].width * .4)
  close(resized.imageGroups[0].imageCells[0].height, 200)
  assert.equal(resized.items[1], page.items[1])
  assert.deepEqual(page, before)
})

test('unchanged geometry leaves full-cell artwork untouched and a manually shorter block keeps its own background height', () => {
  const page = fixture(1, 3), group = page.imageGroups[0]
  page.items[0].w = group.imageCells[0].width
  page.items[0].h = group.height
  assert.equal(resizeImageGroup(page, group.id, group, defaultLayoutBounds), page)
  const samePages = [page]
  assert.equal(resizeGroupPages(samePages, page.id, group.id, group, defaultLayoutBounds), samePages)
  const wider = resizeImageGroup(page, group.id, { ...group, width: column * 2 + GROUP_GAP }, defaultLayoutBounds)
  assert.equal(wider.items[0].w, page.items[0].w)
  assert.equal(wider.items[0].h, page.items[0].h)
  close(wider.items[0].y, page.items[0].y)
  const [resized] = resizeGroupPages([page], page.id, group.id, { ...group, height: 80 }, defaultLayoutBounds)
  const smaller = imageGroupsForPage(resized).find(group => group.id === page.imageGroups[0].id)
  assert.equal(smaller.height, 80)
  assert.equal(smaller.backgroundHeight, 80)
  assert.equal(smaller.manualSize, true)
  assert.equal(resized.imageGroups[1].height, 130)
})

test('shrinking preserves aspect ratio and fits the visual percentage without changing source metadata', () => {
  const page = fixture(), group = page.imageGroups[0]
  const resized = resizeImageGroup(page, group.id, { ...group, height: 40 }, defaultLayoutBounds, new Map([[page.items[0].id, 2]]))
  const item = resized.items[0], cell = resized.imageGroups[0].imageCells[0]
  close(item.w / item.h, 40 / 70)
  assert.ok(item.h * 2 <= cell.height - GROUP_GAP * 2 + 1e-6)
  assert.equal(item.assetId, page.items[0].assetId)
  assert.equal(item.rulerHeightMm, page.items[0].rulerHeightMm)
})

test('a two-column block reflows neighbors without overlap and exports adjusted backgrounds and headers', () => {
  const page = fixture(), group = page.imageGroups[0]
  const result = resizeGroupPages([page], page.id, group.id, { ...group, width: column * 2 + GROUP_GAP, height: 155 }, defaultLayoutBounds)
  assertLayout(result)
  assert.deepEqual(allIds(result), allIds([page]))
  const target = result[0].imageGroups[0]
  close(target.width, column * 2 + GROUP_GAP)
  close(result[0].imageGroups[1].x, target.x + target.width + GROUP_GAP)
  assert.ok(result[0].imageGroups[2].y >= target.y + target.height + GROUP_GAP - 1e-6)
  const columns = headerColumnBounds(result[0].headerBlocks[0])
  close(columns[0].width, target.width); close(columns[1].width, column)
  const svg = pageSvg(result[0], new Map([['source', { id: 'source', name: 'source', productId: '', width: 40, height: 70, svg: '<svg/>', thumbnailUrl: '', previewUrl: '' }]]))
  assert.ok(svg.includes(`data-group-background="${group.id}"`))
  assert.ok(svg.includes(`width="${target.width}"`))
})

test('large resized rows spill onto new pages, preserving preceding pages, later data and sticker isolation', () => {
  const before = fixture(9, 1), current = fixture(2, 8), sticker = fixture(7, 1, 130, { protectPageFill: true, productKey: 'stickers' }), later = fixture(3, 3)
  const group = current.imageGroups[0], pages = [before, current, sticker, later]
  const snapshot = structuredClone(pages)
  const result = resizeGroupPages(pages, current.id, group.id, { ...group, width: fullWidth, height: 400 }, defaultLayoutBounds)
  assertLayout(result)
  assert.equal(result[0], before)
  assert.equal(result.find(page => page.id === sticker.id), sticker)
  assert.deepEqual(allIds(result), allIds(pages))
  assert.ok(result.filter(page => page !== before && page !== sticker).length >= 2)
  assert.deepEqual(pages, snapshot)
})

test('a resized sticker block does not pull in other pages and annotations retain page identity', () => {
  const current = fixture(4, 1, 150, { protectPageFill: true, productKey: '贴纸' }), later = fixture(6, 1)
  current.annotations = [{ id: 'note', kind: 'text', x: 10, y: 20, color: '#000', fontSize: 12, text: 'saved' }]
  const group = current.imageGroups[0]
  const result = resizeGroupPages([current, later], current.id, group.id, { ...group, width: fullWidth, height: 220 }, defaultLayoutBounds)
  assert.equal(result[1], later)
  assert.deepEqual(result[0].annotations, current.annotations)
  assertLayout(result)
})

test('new overflow pages from a resized sticker stay immediately after that sticker page', () => {
  const current = fixture(4, 8, 150, { protectPageFill: true, productKey: '贴纸' })
  const later = fixture(6, 1), tail = fixture(8, 1)
  const group = current.imageGroups[0]
  const result = resizeGroupPages([current, later, tail], current.id, group.id, { ...group, width: fullWidth, height: 400 }, defaultLayoutBounds)
  assert.ok(result.length > 3, 'resize must create at least one real overflow page')
  const laterIndex = result.indexOf(later)
  assert.ok(laterIndex > 1, 'the overflow page must precede the following ordinary page')
  assert.equal(result.at(-2), later)
  assert.equal(result.at(-1), tail)
  assert.ok(result.slice(0, laterIndex).every(page => page.imageGroups.every(group => group.protectPageFill)))
  assert.deepEqual(allIds(result), allIds([current, later, tail]))
  assertLayout(result)
})
