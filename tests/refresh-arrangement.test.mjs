import test from 'node:test'
import assert from 'node:assert/strict'
import { artworkBounds, defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_WIDTH, PAPER_HEIGHT } from '../src/model.ts'
import { refreshArrangementPages } from '../src/modules/schematic/services/refreshArrangementService.ts'
import { imageGroupsForPage } from '../src/modules/schematic/services/groupBackgroundService.ts'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { removeCanvasGroups } from '../src/modules/schematic/services/removeCanvasGroups.ts'

const bounds = defaultLayoutBounds
const area = artworkBounds(bounds)
const width = PAPER_WIDTH - area.left - area.right
const slotWidth = (width - GROUP_GAP * 2) / 3
const headerTop = area.top + GROUP_GAP
const contentTop = headerTop + HEADER_BLOCK_HEIGHT + GROUP_GAP
function group(id, x = area.left, y = contentTop, w = slotWidth, height = 120, extra = {}) {
  return { id: `group-${id}`, itemIds: [id], x, y, width: w, height, productKey: 'keychain',
    detailsX: x + w * .6, detailWidth: w * .4,
    details: { size: '42.000 mm', qt: '5', finish: 'Epoxy', note: 'Do not change my note.', noteImages: [{ src: 'data:image/png;base64,AA==', name: 'proof' }], textOverrides: { qt: { text: 'QT: manual', color: '#223344', fontSize: 13 } } },
    imageCells: [{ itemId: id, x, y, width: w * .6, height, label: 'manual front', labelColor: '#654321' }], ...extra }
}
function page(id, groups, extra = {}) {
  return { id, name: `页面 ${id}`, headerBlocks: [{ id: `header-${id}`, auto: true, x: area.left, y: headerTop, width,
    columns: Array.from({ length: 3 }, (_, i) => ({ id: `col-${id}-${i}`, imageMode: 'photo', detailLabel: 'My Size/QT' })) }],
    imageGroups: groups, items: groups.map(g => ({ id: g.itemIds[0], assetId: `asset-${g.itemIds[0]}`, x: g.x + 40, y: g.y + 52,
      w: 49, h: 71, rotation: 13, svgLayerIds: ['front', 'window'], backSvg: '<svg>custom</svg>', captionHidden: true,
      rulerWidth: true, rulerHeight: true, rulerHeightRange: [.12, .88], rulerWidthMm: 40.125, sizeAxis: 'height' })), ...extra }
}
function findGroup(pages, id) { return pages.flatMap(p => p.imageGroups ?? []).find(g => g.id === `group-${id}`) }
function findItem(pages, id) { return pages.flatMap(p => p.items).find(i => i.id === id) }
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`)
function checkTranslation(originalPage, result, id) {
  const before = findGroup([originalPage], id), after = findGroup(result, id)
  const dx = after.x - before.x, dy = after.y - before.y
  const oldItem = findItem([originalPage], id), item = findItem(result, id)
  assert.deepEqual(item, { ...oldItem, x: oldItem.x + dx, y: oldItem.y + dy })
  assert.equal(after.width, before.width); assert.equal(after.height, before.height)
  assert.deepEqual(after.details, before.details)
  close(after.detailsX, before.detailsX + dx)
  assert.deepEqual(after.imageCells, before.imageCells.map(cell => ({ ...cell, x: cell.x + dx, y: cell.y + dy })))
}
function assertNoOverlap(pages) {
  for (const p of pages) for (const [index, g] of imageGroupsForPage(p).entries()) {
    assert.ok(g.x >= area.left - 1e-6 && g.x + g.width <= PAPER_WIDTH - area.right + 1e-6)
    const height = Math.max(g.height, g.backgroundHeight ?? 0)
    assert.ok(g.y + height <= PAPER_HEIGHT - area.bottom + 1e-6)
    for (const h of imageGroupsForPage(p).slice(index + 1)) assert.ok(g.x + g.width <= h.x + 1e-6 || h.x + h.width <= g.x + 1e-6
      || g.y + height <= h.y + 1e-6 || h.y + Math.max(h.height, h.backgroundHeight ?? 0) <= g.y + 1e-6, 'overlapping blocks')
  }
}

test('refresh fills top and left holes, pulls later pages forward, and keeps block contents identical', () => {
  const before = page(7, [group('a', area.left + slotWidth + GROUP_GAP, contentTop + 250), group('b', area.left, contentTop + 380)])
  const later = page(3, [group('c')])
  const pages = [before, later], snapshot = structuredClone(pages)
  const result = refreshArrangementPages(pages, 7, bounds)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].items.map(item => item.id), ['a', 'b', 'c'])
  close(findGroup(result, 'a').x, area.left); close(findGroup(result, 'a').y, contentTop)
  close(findGroup(result, 'c').x, area.left + (slotWidth + GROUP_GAP) * 2)
  for (const id of ['a', 'b']) checkTranslation(before, result, id)
  checkTranslation(later, result, 'c')
  assert.deepEqual(pages, snapshot)
  assert.deepEqual(refreshArrangementPages(result, 7, bounds), result)
  assertNoOverlap(result)
})

test('owned text and rulers follow blocks across pages while page-level text stays on its original page', () => {
  const first = page(1, [group('a', area.left, contentTop + 200)])
  const later = page(5, [group('b')])
  later.annotations = [
    { id: 'inside', kind: 'text', x: area.left + 15, y: contentTop + 20, text: 'inside block', color: '#123', fontSize: 12 },
    { id: 'linked', kind: 'ruler', x: area.left - 8, y: contentTop + 10, x2: area.left - 8, y2: contentTop + 60, extensionOffset: -25, measuredMm: 21.7, color: '#2f6fa3', sourceItemId: 'b' },
    { id: 'page', kind: 'text', x: 10, y: 10, text: 'page comment', color: '#345', fontSize: 9 },
  ]
  const result = refreshArrangementPages([first, later], 1, bounds)
  const moved = findGroup(result, 'b'), dx = moved.x - later.imageGroups[0].x, dy = moved.y - later.imageGroups[0].y
  assert.equal(result.length, 2)
  assert.deepEqual(result[1].annotations, [later.annotations[2]])
  assert.equal(result[1].items.length, 0)
  assert.deepEqual(result[0].annotations.find(a => a.id === 'inside'), { ...later.annotations[0], x: later.annotations[0].x + dx, y: later.annotations[0].y + dy })
  assert.deepEqual(result[0].annotations.find(a => a.id === 'linked'), { ...later.annotations[1], x: later.annotations[1].x + dx, y: later.annotations[1].y + dy, x2: later.annotations[1].x2 + dx, y2: later.annotations[1].y2 + dy })
  assert.deepEqual(refreshArrangementPages(result, 1, bounds), result)
})

test('earlier pages and sticker pages are untouched and a sticker refresh only compacts that page', () => {
  const earlier = page(8, [group('earlier')]), current = page(4, [group('current', area.left, contentTop + 200)])
  const sticker = page(2, [group('sticker', area.left, contentTop + 200, slotWidth, 100, { protectPageFill: true, productKey: 'stickers' })])
  const last = page(1, [group('last')])
  const result = refreshArrangementPages([earlier, current, sticker, last], 4, bounds)
  assert.equal(result[0], earlier); assert.equal(result[2], sticker)
  assert.deepEqual(result[1].items.map(i => i.id), ['current', 'last'])
  const local = refreshArrangementPages([sticker, last], 2, bounds)
  assert.equal(local[1], last); close(local[0].imageGroups[0].y, contentTop)
})

test('unlinked rulers follow their measured baseline even when arrows extend into another block', () => {
  const left = group('left', area.left, contentTop + 160)
  const right = group('right', area.left + slotWidth + GROUP_GAP, contentTop + 160)
  const p = page(1, [left, right])
  const ruler = { id: 'unlinked-ruler', kind: 'ruler', x: right.x + 10, y: right.y + 20, x2: right.x + 10, y2: right.y + 80,
    extensionOffset: -(slotWidth + GROUP_GAP), measuredMm: 30, color: '#2f6fa3' }
  p.annotations = [ruler]
  // Force the blocks into separate rows so choosing the wrong owner changes the translation.
  right.productKey = 'other'
  const result = refreshArrangementPages([p], 1, bounds)
  const moved = findGroup(result, 'left')
  const annotation = result[0].annotations[0]
  close(annotation.y - ruler.y, moved.y - left.y)
  close(annotation.x - ruler.x, moved.x - left.x)
})

test('one-column and two-column blocks share a row without resizing; a partial row reuses its header', () => {
  const p = page(1, [group('one', area.left, contentTop + 250), group('two', area.left, contentTop + 380, slotWidth * 2 + GROUP_GAP), group('next', area.left, contentTop + 500)])
  p.headerBlocks[0].columns = [p.headerBlocks[0].columns[0], { ...p.headerBlocks[0].columns[1], span: 2 }]
  const result = refreshArrangementPages([p], 1, bounds)
  close(findGroup(result, 'two').x, area.left + slotWidth + GROUP_GAP)
  close(findGroup(result, 'two').y, contentTop)
  close(findGroup(result, 'next').y, contentTop + 120 + GROUP_GAP)
  assert.equal(result[0].headerBlocks.length, 1)
  assert.equal(result[0].headerBlocks[0].columns[1].span, 2)
  assert.equal(findGroup(result, 'two').width, p.imageGroups[1].width)
  assert.deepEqual(refreshArrangementPages(result, 1, bounds), result)
})

test('different products keep row boundaries and edited columns are selected by geometry after a deletion', () => {
  const p = page(1, [group('right', area.left + 2 * (slotWidth + GROUP_GAP), contentTop + 120), group('other', area.left, contentTop + 260, slotWidth, 90, { productKey: 'standee' })])
  p.headerBlocks[0].columns[2].detailLabel = 'Right-hand custom label'
  p.headerBlocks[0].columns[2].imageMode = 'separate'
  const result = refreshArrangementPages([p], 1, bounds)
  assert.equal(result[0].headerBlocks[0].columns[0].detailLabel, 'Right-hand custom label')
  assert.equal(result[0].headerBlocks[0].columns[0].imageMode, 'separate')
  assert.ok(findGroup(result, 'other').y > findGroup(result, 'right').y + 120)
  assertNoOverlap(result)
})

test('visible details and notes retain their geometry when packed beside a taller block', () => {
  const short = group('short', area.left, contentTop + 80, slotWidth, 100)
  const tall = group('tall', area.left, contentTop + 300, slotWidth, 220)
  const p = page(1, [short, tall])
  const before = imageDetailsLayout(imageGroupsForPage(p)[0])
  const result = refreshArrangementPages([p], 1, bounds)
  const g = imageGroupsForPage(result[0]).find(g => g.id === short.id)
  const after = imageDetailsLayout(g)
  close(after.noteY - g.y, before.noteY - short.y)
  assert.equal(after.noteFontSize, before.noteFontSize)
  assert.deepEqual(after.noteLines, before.noteLines)
  assert.equal(after.noteImageSize, before.noteImageSize)
  assert.equal(g.backgroundHeight, 100)
})

test('cross-page moves preserve inherited and default backgrounds and ungrouped legacy items', () => {
  const p = page(1, [group('first')], { backgroundColor: '#ff0000' })
  const second = page(2, [group('second')])
  const third = page(3, [group('third')], { backgroundColor: '#123456' })
  const legacy = { id: 4, name: 'legacy', items: [{ id: 'legacy', assetId: 'legacy-asset', x: 100, y: 300, w: 40, h: 70, rotation: 0 }] }
  const result = refreshArrangementPages([p, second, third, legacy], 1, bounds)
  assert.equal(findGroup(result, 'second').backgroundColor, '#D4E9D8')
  assert.equal(findGroup(result, 'third').backgroundColor, '#123456')
  assert.ok(result.flatMap(p => p.items).some(i => i.id === 'legacy'))
  assert.deepEqual(refreshArrangementPages(result, 1, bounds), result)
})

test('independent custom table headers survive and oversized blocks fail without mutation', () => {
  const p = page(1, [group('first', area.left, contentTop + 200)])
  p.headerBlocks.push({ id: 'independent', x: area.left, y: PAPER_HEIGHT - 55, width: 100, columns: [{ id: 'free', imageMode: 'photo', detailLabel: 'Keep me' }] })
  const result = refreshArrangementPages([p], 1, bounds)
  assert.ok(result[0].headerBlocks.some(h => h.id === 'independent' && h.columns[0].detailLabel === 'Keep me'))
  const large = page(2, [group('too-wide', area.left, contentTop, width + 1)])
  const snapshot = structuredClone(large)
  assert.throws(() => refreshArrangementPages([large], 2, bounds), /刷新不会缩放/)
  assert.deepEqual(large, snapshot)
})

test('a free table header remains independent after a block is moved underneath it', () => {
  const p = page(1, [group('headerless', 250, 400, 100, 150)], { headerBlocks: [{ id: 'free-header', x: area.left, y: headerTop + 40,
    width: 100, columns: [{ id: 'free-column', imageMode: 'photo', detailLabel: 'Keep this header' }] }] })
  const first = refreshArrangementPages([p], 1, bounds)
  assert.equal(first[0].headerBlocks[0].id, 'free-header')
  close(first[0].headerBlocks[0].y, headerTop + 40)
  assert.deepEqual(refreshArrangementPages(first, 1, bounds), first)
})

test('actual generated keychains, standees and shaker batches compact after deletion and remain stable after saved-record restoration', () => {
  const asset = (id, productName, extra = {}) => ({ id, name: id, productId: productName, productName, width: 80, height: 100,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 100"/>', attributes: { Size: '40 mm', QT: '2' },
    note: 'Production note', noteImages: [{ src: 'data:image/png;base64,AQ==', name: 'Reference' }], ...extra })
  const assets = [
    ...Array.from({ length: 24 }, (_, i) => asset(`key-${i}`, 'Keychains', { width: 30 + i * 2, height: 50 + i * 3 })),
    ...Array.from({ length: 5 }, (_, i) => ['main', 'base'].map((role, j) => asset(`standee-${i}-${role}`, 'Standees', { productGroupId: `standee-${i}`, productGroupPosition: j + 1, ...(j ? { width: 70, height: 20 } : {}) }))).flat(),
    ...Array.from({ length: 5 }, (_, i) => ['Example', 'Front', 'Inside', 'Back'].map((role, j) => asset(`shaker-${i}-${role}`, 'Shaker', { name: role, productGroupId: `shaker-${i}`, productGroupPosition: j + 1 }))).flat(),
  ]
  const generated = paginateAssets(assets)
  assert.ok(generated.length > 3)
  const firstY = Math.min(...generated[0].imageGroups.map(group => group.y))
  const remaining = removeCanvasGroups(generated, generated[0].imageGroups.filter(group => Math.abs(group.y - firstY) < 1e-6).map(group => group.id))
  const beforeByGroup = new Map(remaining.flatMap(p => imageGroupsForPage(p).map(g => [g.id, { g, p }])))
  const refreshed = refreshArrangementPages(remaining, remaining[0].id, bounds)
  assertNoOverlap(refreshed)
  assert.deepEqual(refreshed.flatMap(p => p.items.map(i => i.id)).sort(), remaining.flatMap(p => p.items.map(i => i.id)).sort())
  for (const p of refreshed) for (const g of p.imageGroups) {
    const before = beforeByGroup.get(g.id)
    const dx = g.x - before.g.x, dy = g.y - before.g.y
    assert.equal(g.width, before.g.width); assert.equal(g.height, before.g.height)
    assert.deepEqual(g.details, before.g.details); assert.deepEqual(g.detailGroups, before.g.detailGroups)
    assert.deepEqual(g.imageCells, before.g.imageCells?.map(cell => ({ ...cell, x: cell.x + dx, y: cell.y + dy })))
    for (const item of p.items.filter(item => g.itemIds.includes(item.id))) {
      const old = before.p.items.find(i => i.id === item.id)
      assert.deepEqual(item, { ...old, x: old.x + dx, y: old.y + dy })
    }
  }
  const restored = JSON.parse(JSON.stringify(refreshed))
  assert.deepEqual(JSON.parse(JSON.stringify(refreshArrangementPages(restored, restored[0].id, bounds))), restored)
})

test('a block retains the expanded background and note layout from its original mixed-height row', () => {
  const short = group('short', area.left, contentTop + 100, slotWidth, 100)
  const tall = group('tall', area.left + slotWidth + GROUP_GAP, contentTop + 100, slotWidth, 220)
  const other = group('other', area.left, contentTop + 350, slotWidth, 80)
  const p = page(1, [short, tall, other])
  const source = imageGroupsForPage(p).find(g => g.id === short.id)
  assert.equal(source.backgroundHeight, 220)
  const before = imageDetailsLayout(source)
  const result = refreshArrangementPages([p], 1, bounds)
  const afterGroup = imageGroupsForPage(result[0]).find(g => g.id === short.id)
  const after = imageDetailsLayout(afterGroup)
  assert.equal(afterGroup.backgroundHeight, 220)
  close(after.noteY - afterGroup.y, before.noteY - source.y)
  assert.equal(after.noteFontSize, before.noteFontSize)
  assert.deepEqual(after.noteLines, before.noteLines)
  assert.deepEqual(JSON.parse(JSON.stringify(refreshArrangementPages(result, 1, bounds))), JSON.parse(JSON.stringify(result)))
})
