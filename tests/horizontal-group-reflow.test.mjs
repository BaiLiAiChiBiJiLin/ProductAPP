import test from 'node:test'
import assert from 'node:assert/strict'
import { artworkBounds, defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT, PAPER_WIDTH, pageSvg } from '../src/model.ts'
import { createHorizontalGroupReflowRequest, planHorizontalGroupReflow, applyHorizontalGroupReflow, horizontalGroupPages } from '../src/modules/schematic/services/horizontalGroupReflowService.ts'
import { detailPanelsForGroup } from '../src/modules/schematic/arrangement/productGroupDetails.ts'
import { autoArrangePages, paginateAssets } from '../src/modules/schematic/services/paginationService.ts'

const area = artworkBounds(defaultLayoutBounds)
const fullWidth = PAPER_WIDTH - area.left - area.right
const headerTop = area.top + GROUP_GAP
const contentTop = headerTop + HEADER_BLOCK_HEIGHT + GROUP_GAP
const base = (id, width = 70, height = 120) => ({ id, name: id, productId: 'Standees', productName: 'Standees', width, height,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}"/></svg>`, previewUrl: '', thumbnailUrl: '' })
function page(id, height, count = 1, opts = {}) {
  const width = count === 1 ? fullWidth : (fullWidth - (count - 1) * GROUP_GAP) / count
  const items = Array.from({ length: count }, (_, index) => ({ id: `item-${id}-${index}`, assetId: `asset-${id}-${index}`, x: area.left + index * (width + GROUP_GAP) + width / 2,
    y: contentTop + height / 2, w: Math.min(70, width / 2), h: Math.min(130, height - 40), rotation: 0, caption: 'Front', svgLayerIds: ['front'], rulerHeight: true }))
  return { id, name: `页面 ${id}`, items,
    headerBlocks: [{ id: `header-${id}`, x: area.left, y: headerTop, width: fullWidth, columns: items.map((_, index) => ({ id: `col-${id}-${index}`, imageMode: 'photo', detailLabel: 'Size/QT/Accessory' })) }],
    imageGroups: items.map((item, index) => ({ id: `group-${id}-${index}`, itemIds: [item.id], x: area.left + index * (width + GROUP_GAP), y: contentTop, width, height, productKey: 'standees',
      details: { size: '50mm', qt: '20', finish: '' }, backgroundColor: '#f8e0db', ...opts })) }
}
function allIds(pages) { return pages.flatMap(page => page.items.map(item => item.id)).sort() }
function noOverlap(pages) {
  for (const page of pages) for (const [index, group] of page.imageGroups.entries()) {
    assert.ok(group.x >= area.left - 1e-6 && group.x + group.width <= PAPER_WIDTH - area.right + 1e-6)
    assert.ok(group.y + group.height <= PAPER_HEIGHT - area.bottom + 1e-6)
    for (const other of page.imageGroups.slice(index + 1)) {
      assert.ok(group.x + group.width <= other.x + 1e-6 || other.x + other.width <= group.x + 1e-6
        || group.y + group.height <= other.y + 1e-6 || other.y + other.height <= group.y + 1e-6, 'group blocks overlap')
    }
  }
}

test('horizontal group spans full width, retains edits and exports images in one row', () => {
  const sources = [base('main'), base('base1', 70, 20), base('base2', 50, 15), base('base3', 30, 10)].map((asset, index) => ({ ...asset, productGroupId: 'standee-set', productGroupPosition: index + 1 }))
  const pages = paginateAssets(sources)
  const target = pages[0].imageGroups[0]
  target.backgroundColor = '#ffeeaa'
  target.imageCells[0].labelColor = '#cc00aa'
  pages[0].items[0].captionHidden = true
  pages[0].items[0].rulerHeightMm = 67.3
  const before = structuredClone(pages)
  const result = horizontalGroupPages(pages, pages[0].id, target.id, defaultLayoutBounds, new Map([[pages[0].items[0].id, 1.2]]))
  const converted = result[0].imageGroups.find(group => group.id === target.id)
  assert.equal(converted.width, fullWidth)
  assert.equal(converted.layoutMode, 'horizontal')
  assert.equal(converted.backgroundColor, '#ffeeaa')
  assert.equal(converted.detailColumns, 1)
  assert.equal(converted.imageCells.find(cell => cell.itemId === target.imageCells[0].itemId).labelColor, '#cc00aa')
  const items = converted.itemIds.map(id => result[0].items.find(item => item.id === id))
  assert.ok(items.every(item => Math.abs(item.y - items[0].y) < 1e-6))
  assert.ok(items.every((item, index) => index === 0 || item.x > items[index - 1].x))
  assert.equal(items[0].captionHidden, true)
  assert.equal(items[0].rulerHeightMm, 67.3)
  assert.deepEqual(allIds(result), allIds(pages))
  assert.deepEqual(pages, before, 'reflow does not mutate an undo snapshot')
  const svg = pageSvg(result[0], new Map(sources.map(asset => [asset.id, asset])))
  assert.ok(svg.includes('data-group-background'))
  noOverlap(result)
})

test('space released by horizontal layout pulls later pages forward while sticker page is untouched', () => {
  const first = page(9, 440)
  const sticker = page(2, 90, 1, { protectPageFill: true, productKey: 'stickers' })
  const later = page(6, 100)
  const originalSticker = structuredClone(sticker)
  const result = horizontalGroupPages([first, sticker, later], first.id, first.imageGroups[0].id, defaultLayoutBounds)
  assert.equal(result.length, 2)
  assert.equal(result[0].id, 9)
  assert.ok(result[0].items.some(item => item.id === later.items[0].id))
  assert.equal(result[1], sticker)
  assert.deepEqual(result[1], originalSticker)
  assert.deepEqual(allIds(result), allIds([first, sticker, later]))
  noOverlap(result)
})

test('rows sharing columns split safely around a selected horizontal group and preserve earlier pages', () => {
  const earlier = page(8, 100)
  const current = page(4, 180, 3)
  const later = page(1, 120, 3)
  const result = horizontalGroupPages([earlier, current, later], 4, current.imageGroups[1].id, defaultLayoutBounds)
  assert.equal(result[0], earlier)
  const groups = result.flatMap(page => page.imageGroups)
  const selected = groups.find(group => group.id === current.imageGroups[1].id)
  assert.equal(selected.width, fullWidth)
  assert.deepEqual(allIds(result), allIds([earlier, current, later]))
  noOverlap(result)
})

test('an emptied page retains custom annotations and their page identity', () => {
  const first = page(7, 420)
  const later = { ...page(3, 100), annotations: [{ id: 'note', kind: 'text', x: 20, y: 20, text: 'Do not lose', color: '#123456', fontSize: 12 }] }
  const result = horizontalGroupPages([first, later], 7, first.imageGroups[0].id, defaultLayoutBounds)
  assert.equal(result.length, 2)
  assert.equal(result[1].id, 3)
  assert.equal(result[1].items.length, 0)
  assert.deepEqual(result[1].annotations, later.annotations)
})

test('a selected sticker group can be horizontal without involving later product pages', () => {
  const sticker = page(1, 400, 1, { protectPageFill: true, productKey: 'stickers' })
  const later = page(2, 90)
  const result = horizontalGroupPages([sticker, later], 1, sticker.imageGroups[0].id, defaultLayoutBounds)
  assert.equal(result.length, 2)
  assert.equal(result[1], later)
  assert.equal(result[0].imageGroups[0].layoutMode, 'horizontal')
  assert.equal(result[0].imageGroups[0].protectPageFill, true)
})

test('worker request excludes SVG and media while applying a cloned plan retains all sources', () => {
  const first = page(1, 400)
  first.items[0].backSvg = '<svg>large artwork data</svg>'
  first.imageGroups[0].details.noteImage = 'data:image/png;base64,privateImage'
  first.imageGroups[0].imageCells = [{ itemId: 'empty-example', label: 'Example', labelColor: '#330099', x: area.left, y: contentTop, width: 40, height: 40 }]
  const request = createHorizontalGroupReflowRequest([first], 1, first.imageGroups[0].id, defaultLayoutBounds)
  const serialized = JSON.stringify(request)
  assert.ok(!serialized.includes('large artwork data'))
  assert.ok(!serialized.includes('privateImage'))
  const plan = planHorizontalGroupReflow(structuredClone(request))
  const [result] = applyHorizontalGroupReflow([first], structuredClone(plan))
  assert.equal(result.items[0].backSvg, first.items[0].backSvg)
  assert.equal(result.imageGroups[0].details.noteImage, first.imageGroups[0].details.noteImage)
  assert.equal(result.imageGroups[0].imageCells.find(cell => cell.itemId === 'empty-example').labelColor, '#330099')
})

test('horizontal image columns do not squeeze multiple property panels into tiny columns', () => {
  const first = page(1, 400)
  first.imageGroups[0].detailGroups = [1, 2].map(index => ({ itemIds: [first.items[0].id], details: { size: `${index}0mm`, qt: '20', finish: '' } }))
  const [result] = horizontalGroupPages([first], 1, first.imageGroups[0].id, defaultLayoutBounds)
  const group = result.imageGroups[0]
  const panels = detailPanelsForGroup({ ...group, imageColumns: 4 })
  assert.equal(panels.length, 2)
  assert.equal(panels[0].detailsX, panels[1].detailsX)
  assert.ok(panels[1].y >= panels[0].y + panels[0].height)
})

test('automatic arrangement preserves captions, colours and horizontal layout after bounds change', () => {
  const sources = [base('main'), base('base1', 70, 20), base('base2', 50, 15)].map((asset, index) => ({ ...asset, productGroupId: 'standee-set', productGroupPosition: index + 1 }))
  const initial = paginateAssets(sources)
  const groupId = initial[0].imageGroups[0].id
  const pages = horizontalGroupPages(initial, initial[0].id, groupId, defaultLayoutBounds)
  pages[0].backgroundColor = '#ffbbdd'
  pages[0].imageGroups[0].backgroundColor = '#f0bb00'
  pages[0].imageGroups[0].imageCells[0].labelColor = '#c0ffee'
  const item = pages[0].items[0]
  item.caption = 'Customer front'
  item.captionColor = '#123456'
  item.captionHidden = true
  pages[0].annotations = [{ id: 'text1', kind: 'text', x: 21, y: 25, text: 'Keep me', color: '#123456', fontSize: 12 }]
  const bounds = { ...defaultLayoutBounds, paddingLeft: 15, paddingRight: 15 }
  const result = autoArrangePages(pages, pages[0].id, sources, bounds)
  const changed = result.flatMap(page => page.imageGroups).find(group => group.id === groupId)
  const restoredItem = result.flatMap(page => page.items).find(candidate => candidate.id === item.id)
  assert.equal(changed.layoutMode, 'horizontal')
  assert.equal(changed.width, PAPER_WIDTH - artworkBounds(bounds).left - artworkBounds(bounds).right)
  assert.equal(changed.backgroundColor, '#f0bb00')
  assert.equal(changed.imageCells[0].labelColor, '#c0ffee')
  assert.equal(restoredItem.caption, 'Customer front')
  assert.equal(restoredItem.captionHidden, true)
  assert.equal(restoredItem.captionColor, '#123456')
  assert.deepEqual(result.flatMap(page => page.annotations ?? []), pages[0].annotations)
  assert.equal(result[0].backgroundColor, '#ffbbdd')
  assert.deepEqual(allIds(result), allIds(pages))
})

test('automatic arrangement matches group edits by member identity and keeps independent annotation pages', () => {
  const sources = ['red', 'blue'].map(id => ({ ...base(id), productId: 'Keychains', productName: 'Keychains' }))
  const initial = paginateAssets(sources)
  const original = initial[0]
  original.id = 9
  original.name = 'Chosen first page'
  const redId = original.items.find(item => item.assetId === 'red').id
  const redGroup = original.imageGroups.find(group => group.itemIds.includes(redId))
  redGroup.id = 'user-coloured-red'
  redGroup.backgroundColor = '#f00000'
  const blueGroup = original.imageGroups.find(group => !group.itemIds.includes(redId))
  blueGroup.backgroundColor = '#0000ff'
  const notes = { id: 1, name: 'Notes only', items: [], annotations: [{ id: 'manual-ruler', kind: 'ruler', x: 1, y: 2, x2: 3, y2: 4, measuredMm: 5, color: '#000' }] }
  const before = structuredClone([notes, original])
  const result = autoArrangePages([notes, original], 9, [...sources].reverse(), defaultLayoutBounds)
  assert.equal(result[0], notes)
  assert.equal(result[1].id, 9)
  assert.equal(result[1].name, 'Chosen first page')
  const restoredRed = result[1].imageGroups.find(group => group.itemIds.includes(redId))
  assert.equal(restoredRed.id, 'user-coloured-red')
  assert.equal(restoredRed.backgroundColor, '#f00000')
  assert.equal(result[1].imageGroups.find(group => !group.itemIds.includes(redId)).backgroundColor, '#0000ff')
  assert.equal(new Set(result.map(page => page.id)).size, result.length)
  assert.deepEqual([notes, original], before)
})

test('new groups do not inherit unrelated group overrides when another asset is added', () => {
  const sources = ['red', 'new'].map(id => ({ ...base(id), productId: 'Keychains', productName: 'Keychains' }))
  const previous = paginateAssets([sources[0]])
  previous[0].imageGroups[0].backgroundColor = '#dd0000'
  const result = autoArrangePages(previous, previous[0].id, sources, defaultLayoutBounds, [], ['new'])
  const added = result.flatMap(page => page.items).find(item => item.assetId === 'new')
  const newGroup = result.flatMap(page => page.imageGroups).find(group => group.itemIds.includes(added.id))
  assert.equal(newGroup.backgroundColor, undefined)
  assert.equal(newGroup.layoutMode, undefined)
  assert.equal(result.flatMap(page => page.imageGroups).find(group => !group.itemIds.includes(added.id)).backgroundColor, '#dd0000')
})
