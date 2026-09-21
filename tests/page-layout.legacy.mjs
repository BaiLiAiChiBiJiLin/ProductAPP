import test from 'node:test'
import assert from 'node:assert/strict'
import { artworkBounds, constrain, constrainHeaderBlock, defaultLayoutBounds, GROUP_GAP, headerCells, HEADER_BLOCK_HEIGHT, normalizeLayoutBounds, PAPER_WIDTH, PAPER_HEIGHT, pageSvg, pageRasterSvg } from '../src/model.ts'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { arrangeItems, arrangePage } from '../src/modules/schematic/services/pageLayoutService.ts'
import { createHeaderBlock, resizeHeaderColumns } from '../src/modules/schematic/services/headerBlockService.ts'
import { imageGroupsForPage } from '../src/modules/schematic/services/groupBackgroundService.ts'
import { detailsForAsset, headerModeForAsset } from '../src/modules/schematic/services/automaticArrangementService.ts'
import { combineImageGroups, combineImageGroupsAcrossPages } from '../src/modules/schematic/services/groupCombinationService.ts'
import { reflowAfterCombination } from '../src/modules/schematic/services/combinationReflowService.ts'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'
import { imageDimensionForAsset, imageDimensionMarkerLayout } from '../src/modules/schematic/services/imageDimensionService.ts'

const sample = { id: 'asset', name: '原图', productId: 'cards', width: 92, height: 100, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="92" height="100"><rect width="92" height="100" fill="red"/></svg>' }

test('automatic header modes and fixed detail fields follow product attributes', () => {
  assert.equal(headerModeForAsset({ ...sample, productName: 'Summer Standees', attributes: { 'Print Option': 'Double Sided Different Design' } }), 'front-back')
  assert.equal(headerModeForAsset({ ...sample, productName: 'Cards', attributes: { 'Print Option': 'Double Sided Same Design' } }), 'photo')
  assert.equal(headerModeForAsset({ ...sample, productName: 'Cards', attributes: { 'Print Option': 'Double Sided Different Design' } }), 'separate')
  assert.deepEqual(detailsForAsset({ ...sample, attributes: { Size: '105x150mm', QT: '2', 'Accessories Style': 'Gold' } }), { size: '105x150mm', qt: '2', finish: '', accessoryImage: undefined })
  assert.equal(detailsForAsset({ ...sample, attributes: { 'Accessories Style': 'Gold' } }, [{ id: 'cards', title: 'Cards', options: [{ name: 'Accessories Style', label: '配件样式', values: [{ name: 'Gold', label: 'Gold', image: 'https://cdn.example/style.png' }] }] }]).accessoryImage, undefined)
  assert.equal(detailsForAsset({ ...sample, attributeImages: { 'Accessories Color': 'https://cdn.example/color.png' }, attributes: { 'Accessories Color': 'Star Hook Clasp-9' } }).accessoryImage, 'https://cdn.example/color.png')
  assert.deepEqual(detailsForAsset({ ...sample, attributes: { 'Accessories Color': 'Star Hook Clasp-9' }, attributeImages: { 'Accessories Color': 'color.png' }, note: '贴纸备注', noteImage: 'note.png' }), { size: '', qt: '', finish: '', accessoryImage: 'color.png', accessoryCode: '9', note: '贴纸备注', noteImage: 'note.png' })
})

test('dimension markers use the longest source edge and ignore arranged scaling', () => {
  const explicit = { ...sample, id: 'dimension-explicit', width: 40, height: 80, attributes: { Size: '105x150mm' } }
  const original = { ...sample, id: 'dimension-original', width: 40, height: 80, attributes: {} }
  const inches = { ...sample, id: 'dimension-inches', attributes: { Size: '1 inch' } }
  assert.deepEqual(imageDimensionForAsset(explicit), { label: '150 mm', horizontal: false })
  assert.deepEqual(imageDimensionForAsset(original), { label: '21.17 mm', horizontal: false })
  assert.deepEqual(imageDimensionForAsset(inches), { label: '25.4 mm', horizontal: false })
  const page = paginateAssets([explicit])[0]
  const assets = new Map([[explicit.id, explicit]])
  const first = pageSvg(page, assets)
  assert.match(first, /data-printflow-dimension="true"/)
  assert.match(first, />150 mm<\/text>/)
  page.items[0] = { ...page.items[0], w: 12, h: 240 }
  const scaled = pageRasterSvg(page, assets)
  assert.match(scaled, />150 mm<\/text>/, 'the label stays tied to source dimensions after layout scaling')
  const verticalMarker = imageDimensionMarkerLayout(page.imageGroups[0], page, assets)
  assert.equal(verticalMarker?.extension[0][2], page.items[0].x, 'vertical marker reaches the image centre')
  const horizontal = { ...sample, id: 'dimension-horizontal', width: 160, height: 80, attributes: { Size: '1.5 in' } }
  const horizontalPage = paginateAssets([horizontal])[0]
  const horizontalMarker = imageDimensionMarkerLayout(horizontalPage.imageGroups[0], horizontalPage, new Map([[horizontal.id, horizontal]]))
  assert.equal(horizontalMarker?.extension[0][3], horizontalPage.items[0].y, 'horizontal marker reaches the image centre')
})

test('portrait artwork uses the right-hand space while dimensions stay inside three-column groups', () => {
  const assets = Array.from({ length: 15 }, (_, index) => ({ ...sample, id: `gutter-${index}`,
    width: index < 9 ? 92 : index < 12 ? 50 : 160, height: index < 12 ? 100 : 80,
    attributes: { Size: '1 inch', 'Print Option': 'Double Sided Same Design' } }))
  const pages = paginateAssets(assets, 1000)
  assert.equal(pages.length, 1)
  const page = pages[0]
  assert.equal(page.headerBlocks[0].columns.length, 3)
  const byAsset = new Map(assets.map(asset => [asset.id, asset]))
  for (const group of page.imageGroups) {
    const item = page.items.find(item => item.id === group.itemIds[0])
    const center = group.x + group.width / 4
    assert.ok(item.x + item.w / 2 < group.x + group.width / 2, 'artwork stays outside the details half')
    const asset = byAsset.get(item.assetId)
    assert.ok(Math.abs(item.w / item.h - asset.width / asset.height) < 1e-9)
    const marker = imageDimensionMarkerLayout(group, page, byAsset)
    if (asset.width < asset.height) {
      assert.ok(item.x > center, 'portrait artwork moves right within the available whitespace')
      assert.ok(marker.textX - 6 >= group.x, 'the rotated label fits inside the green group')
      assert.ok(marker.x1 <= item.x - item.w / 2, 'the ruler stays to the left of the artwork')
    } else {
      assert.equal(item.x, center, 'landscape artwork retains its horizontal centering')
    }
  }
  const repeated = arrangePage(page)
  repeated.items.forEach((item, index) => {
    for (const key of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(item[key] - page.items[index][key]) < 1e-9, 'repeated layout must not drift or shrink')
  })
  const combined = combineImageGroups(page, page.imageGroups.slice(0, 2).map(group => group.id), assets)
  const reflow = reflowAfterCombination([combined], 0, assets, defaultLayoutBounds, [])
  const sizes = new Map(page.items.map(item => [item.id, [item.w, item.h]]))
  for (const next of reflow) for (const group of next.imageGroups) for (const id of group.itemIds) {
    const item = next.items.find(item => item.id === id)
    assert.deepEqual([item.w, item.h], sizes.get(item.id), 'combination preserves the current artwork size')
    assert.ok(item.x + item.w / 2 < group.x + group.width / 2)
    if (byAsset.get(item.assetId).width < byAsset.get(item.assetId).height) assert.ok(item.x > group.x + group.width / 4)
  }
})

test('combining two same-product groups creates one vertical stack and keeps shared details', () => {
  const assets = [
    { ...sample, id: 'a', productId: 'same' },
    { ...sample, id: 'b', productId: 'same' },
  ]
  const page = {
    id: 1, name: '页面 1', items: [
      { id: 'ia', assetId: 'a', x: 80, y: 120, w: 40, h: 40, rotation: 0 },
      { id: 'ib', assetId: 'b', x: 180, y: 120, w: 40, h: 40, rotation: 0 },
    ],
    imageGroups: [
      { id: 'ga', itemIds: ['ia'], x: 60, y: 100, width: 80, height: 80, details: { size: '1"', qt: '3', finish: '' } },
      { id: 'gb', itemIds: ['ib'], x: 160, y: 100, width: 80, height: 80, details: { size: '1"', qt: '3', finish: '' } },
    ],
  }
  const result = combineImageGroups(page, ['ga', 'gb'], assets)
  assert.equal(result.imageGroups?.length, 1)
  assert.equal(result.imageGroups?.[0].stacked, 'vertical')
  assert.deepEqual(result.imageGroups?.[0].itemIds, ['ia', 'ib'])
  assert.equal(result.imageGroups?.[0].details?.qt, '3')
  assert.ok(result.items[1].y > result.items[0].y)
})

test('combining groups from different pages moves both groups to the first page before reflow', () => {
  const assets = ['a', 'b'].map(id => ({ ...sample, id, productId: 'same' }))
  const pages = [
    { id: 1, name: '页面 1', items: [{ id: 'ia', assetId: 'a', x: 80, y: 120, w: 40, h: 40, rotation: 0 }], imageGroups: [{ id: 'ga', itemIds: ['ia'], x: 60, y: 100, width: 80, height: 80, details: { size: '1', qt: '3', finish: '' } }] },
    { id: 2, name: '页面 2', items: [{ id: 'ib', assetId: 'b', x: 80, y: 120, w: 40, h: 40, rotation: 0 }], imageGroups: [{ id: 'gb', itemIds: ['ib'], x: 60, y: 100, width: 80, height: 80, details: { size: '1', qt: '3', finish: '' } }] },
  ]
  const result = combineImageGroupsAcrossPages(pages, [{ pageId: 1, groupId: 'ga' }, { pageId: 2, groupId: 'gb' }], assets)
  assert.equal(result[0].imageGroups.length, 1)
  assert.deepEqual(result[0].imageGroups[0].itemIds, ['ia', 'ib'])
  assert.equal(result[0].imageGroups[0].stacked, 'vertical')
  assert.equal(result[1].items.length, 0)
  assert.equal(result[1].imageGroups.length, 0)
})

test('combination reflow fills free space from following pages and regenerates headers', () => {
  const assets = ['a', 'b', 'c'].map(id => ({ ...sample, id, productId: 'same', attributes: { 'Print Option': 'Double Sided Same Design' } }))
  const page = {
    id: 1, name: '页面 1', items: [
      { id: 'ia', assetId: 'a', x: 80, y: 120, w: 30, h: 30, rotation: 0 },
      { id: 'ib', assetId: 'b', x: 180, y: 120, w: 30, h: 30, rotation: 0 },
    ],
    imageGroups: [
      { id: 'ga', itemIds: ['ia'], x: 60, y: 100, width: 80, height: 80 },
      { id: 'gb', itemIds: ['ib'], x: 160, y: 100, width: 80, height: 80 },
    ],
  }
  const following = { id: 2, name: '页面 2', items: [{ id: 'ic', assetId: 'c', x: 80, y: 120, w: 30, h: 30, rotation: 0 }], imageGroups: [{ id: 'gc', itemIds: ['ic'], x: 60, y: 100, width: 80, height: 80 }] }
  const combined = combineImageGroups(page, ['ga', 'gb'], assets)
  const pages = reflowAfterCombination([combined, following], 0, assets, defaultLayoutBounds, [])
  assert.equal(pages.length, 1, 'the following group fills the available current page')
  assert.equal(pages.flatMap(item => item.items).length, 3)
  assert.ok(pages.every(item => item.headerBlocks?.length))
})

test('combination reflow never shrinks existing artwork to make a larger page fit', () => {
  const assets = Array.from({ length: 24 }, (_, i) => ({ ...sample, id: `reflow-${i}`, productId: 'same', attributes: { 'Print Option': 'Double Sided Same Design' } }))
  const initialPages = paginateAssets(assets, 1000)
  const page = {
    ...initialPages[0],
    items: initialPages.flatMap(candidate => candidate.items),
    imageGroups: initialPages.flatMap(candidate => candidate.imageGroups),
    headerBlocks: [{ ...initialPages[0].headerBlocks[0], assetIds: assets.map(asset => asset.id) }],
  }
  const combined = combineImageGroups(page, [page.imageGroups[0].id, page.imageGroups[1].id], assets)
  const before = new Map(combined.items.map(item => [item.id, { w: item.w, h: item.h }]))
  const result = reflowAfterCombination([combined], 0, assets, defaultLayoutBounds, [])
  assert.deepEqual(result.flatMap(page => page.items.map(item => item.id)).sort(), [...before.keys()].sort())
  for (const item of result.flatMap(candidate => candidate.items)) {
    const source = before.get(item.id)
    assert.equal(item.w, source.w, `item ${item.id} width changed during reflow`)
    assert.equal(item.h, source.h, `item ${item.id} height changed during reflow`)
  }
})

test('combination reflow grows only the stack row and uses the remaining rows at current size', () => {
  const assets = Array.from({ length: 30 }, (_, i) => ({ ...sample, id: `row-${i}`, productId: 'same', attributes: { 'Print Option': 'Double Sided Same Design' } }))
  const initial = paginateAssets(assets, 1000)
  const combined = combineImageGroups(initial[0], initial[0].imageGroups.slice(0, 2).map(group => group.id), assets)
  const pages = reflowAfterCombination([combined, ...initial.slice(1)], 0, assets, defaultLayoutBounds, [])
  assert.equal(pages[0].items.length, 13, 'a taller first row still leaves room for three ordinary rows')
  const rows = new Map(pages[0].imageGroups.map(group => [group.y, group.height]))
  assert.equal(rows.size, 4)
  assert.ok([...rows.values()][0] > 110)
  assert.deepEqual([...rows.values()].slice(1), [110, 110, 110])
  for (const page of pages) {
    assert.equal(page.headerBlocks.length, 1)
    assert.equal(page.headerBlocks[0].columns[0].imageMode, 'photo')
    page.items.forEach(item => assertWithin(item, defaultLayoutBounds))
  }
})

test('combination reflow backfills short groups when the stack needs the next page', () => {
  const assets = Array.from({ length: 28 }, (_, i) => ({ ...sample, id: `backfill-${i}`, productId: 'same', attributes: { 'Print Option': 'Double Sided Same Design' } }))
  const initial = paginateAssets(assets, 1000)
  const selected = initial[0].imageGroups.slice(12, 14)
  const combined = combineImageGroups(initial[0], selected.map(group => group.id), assets)
  const pages = reflowAfterCombination([combined, ...initial.slice(1)], 0, assets, defaultLayoutBounds, [])
  assert.deepEqual(pages.map(page => page.items.length), [15, 13])
  assert.ok(pages[1].imageGroups.some(group => group.stacked === 'vertical'))
  assert.ok(pages[0].items.some(item => initial[1].items.some(source => source.id === item.id)))
})

test('combination reflow preserves earlier pages, shared details, and Front/Back pairs across repeated combinations', () => {
  const assets = Array.from({ length: 60 }, (_, i) => ({ ...sample, id: `repeat-${i}`, productId: 'same',
    attributes: { 'Print Option': i < 30 ? 'Double Sided Same Design' : 'Double Sided Different Design' } }))
  const initial = paginateAssets(assets, 1000)
  const original = structuredClone(initial)
  const sizes = new Map(initial.flatMap(page => page.items).map(item => [item.id, { w: item.w, h: item.h }]))
  let pages = initial
  for (let step = 0; step < 2; step++) {
    const active = pages[1]
    const selection = active.imageGroups.filter(group => !group.stacked).slice(0, 2)
    const combined = combineImageGroups(active, selection.map(group => group.id), assets)
    pages = reflowAfterCombination([pages[0], combined, ...pages.slice(2)], 1, assets, defaultLayoutBounds, [])
    assert.strictEqual(pages[0], initial[0])
    assert.equal(new Set(pages.map(page => page.id)).size, pages.length)
    assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)).sort(), [...sizes.keys()].sort())
    for (const page of pages) {
      const modes = page.headerBlocks.map(header => header.columns[0].imageMode)
      assert.equal(new Set(modes).size, modes.length)
      assert.deepEqual(page.headerBlocks.flatMap(header => header.assetIds).sort(), page.items.map(item => item.assetId).sort())
      for (const item of page.items) {
        assert.deepEqual({ w: item.w, h: item.h }, sizes.get(item.id))
        assertWithin(item, defaultLayoutBounds)
      }
      for (const group of page.imageGroups) {
        const source = original.flatMap(page => page.imageGroups).find(previous => previous.itemIds.includes(group.itemIds[0]))
        assert.deepEqual(group.details, source.details)
        if (!group.stacked && headerModeForAsset(assets.find(asset => asset.id === page.items.find(item => item.id === group.itemIds[0]).assetId)) === 'separate') {
          assert.deepEqual(group.itemIds, source.itemIds, 'Front and Back retain their shared group')
        }
      }
    }
  }
  assert.deepEqual(initial, original, 'reflow never mutates saved input pages')
})

test('an oversized combination reports capacity instead of shrinking the stack', () => {
  const assets = [{ ...sample, id: 'large' }]
  const page = { id: 1, name: '页面 1', items: [{ id: 'large-item', assetId: 'large', x: 250, y: 400, w: 60, h: 700, rotation: 0 }],
    imageGroups: [{ id: 'large-group', itemIds: ['large-item'], x: 10, y: 100, width: 200, height: 720, stacked: 'vertical' }] }
  const source = structuredClone(page)
  assert.throws(() => reflowAfterCombination([page], 0, assets, defaultLayoutBounds, []), /高度超出/)
  assert.deepEqual(page, source)
})
function assertWithin(item, area) {
  const angle = item.rotation * Math.PI / 180
  const halfW = (Math.abs(Math.cos(angle)) * item.w + Math.abs(Math.sin(angle)) * item.h) / 2
  const halfH = (Math.abs(Math.sin(angle)) * item.w + Math.abs(Math.cos(angle)) * item.h) / 2
  assert.ok(item.x - halfW >= area.left - 1e-6)
  assert.ok(item.y - halfH >= area.top - 1e-6)
  assert.ok(item.x + halfW <= PAPER_WIDTH - area.right + 1e-6)
  assert.ok(item.y + halfH <= PAPER_HEIGHT - area.bottom + 1e-6)
}

test('initial pagination inserts automatic headers and keeps every original image in bounds', () => {
  const assets = Array.from({ length: 25 }, (_, i) => ({ ...sample, id: `asset-${i}` }))
  const pages = paginateAssets(assets)
  assert.ok(pages.every(page => page.items.length <= 12))
  assert.equal(pages.reduce((total, page) => total + page.items.length, 0), 25)
  assert.equal(new Set(pages.flatMap(page => page.items.map(item => item.assetId))).size, 25)
  assert.ok(pages.every(page => page.headerBlocks.length > 0))
  const area = artworkBounds(defaultLayoutBounds)
  for (const page of pages) for (const item of page.items) assertWithin(item, area)
  assert.ok(pages[0].imageGroups[0].y >= area.top)
  assert.ok(pages[0].items[0].y - pages[0].items[0].h / 2 > area.top)
})

test('dragging and rotation remain inside a smaller configured area without distortion', () => {
  const area = artworkBounds({ top: 240, left: 75, right: 80, bottom: 100 })
  for (const rotation of [0, 45, 90, 180, 270]) {
    const next = constrain({ id: 'i', assetId: 'a', x: -200, y: 1000, w: 450, h: 650, rotation }, area)
    assertWithin(next, area)
    assert.ok(Math.abs(next.w / next.h - 450 / 650) < 1e-6)
  }
  const items = paginateAssets(Array.from({ length: 12 }, (_, i) => ({ ...sample, id: String(i) })))[0].items
  const arranged = arrangeItems(items, { top: 600, left: 175, right: 175, bottom: 10 })
  arranged.forEach(item => assertWithin(item, artworkBounds({ top: 600, left: 175, right: 175, bottom: 10 })))
  assert.ok(arranged[4].y - arranged[4].h / 2 > arranged[0].y + arranged[0].h / 2)
})

test('bounds remain valid for extreme inputs and reserve no automatic header band', () => {
  const area = normalizeLayoutBounds({ left: 10000, right: Infinity, top: -50, bottom: 10000 })
  assert.ok(PAPER_WIDTH - area.left - area.right >= 40)
  assert.ok(PAPER_HEIGHT - area.top - area.bottom >= 40)
  assert.equal(artworkBounds(defaultLayoutBounds).top, defaultLayoutBounds.top)
})

test('three image modes share a logical column with their own details cell', () => {
  const block = { ...createHeaderBlock(defaultLayoutBounds, []), width: 480, columns: [
    { id: 'merged', imageMode: 'front-back', detailLabel: 'Size/QT/Finish' },
    { id: 'photo', imageMode: 'photo', detailLabel: 'Accessory' },
    { id: 'split', imageMode: 'separate', detailLabel: '详情' },
  ] }
  const cells = headerCells(block)
  assert.deepEqual(cells.map(cell => cell.label), ['Front/Back', 'Size/QT/Finish', 'photo', 'Accessory', 'Front', 'Back', '详情'])
  assert.equal(cells[0].x, 0)
  assert.equal(cells[0].width, cells[1].width)
  assert.equal(cells[2].width, cells[3].width)
  assert.equal(cells[4].width + cells[5].width, cells[6].width)
  for (const [left, right] of [[cells[1], cells[2]], [cells[3], cells[4]]]) assert.ok(Math.abs((right.x - left.x - left.width) * 210 / PAPER_WIDTH - 1.8) < 1e-9)
  assert.ok(Math.abs(cells[6].x + cells[6].width - block.width) < 1e-9)
  const expanded = resizeHeaderColumns(block, 4)
  assert.deepEqual(expanded.columns.slice(0, 3), block.columns)
  assert.equal(expanded.columns.length, 4)
  assert.equal(resizeHeaderColumns(expanded, 2).columns.length, 2)
  assert.deepEqual(block.columns[2], { id: 'split', imageMode: 'separate', detailLabel: '详情' }, 'other blocks are not mutated')
})

test('image and details share a background with exactly 1.8 mm gutters in both directions', () => {
  const page = paginateAssets(Array.from({ length: 12 }, (_, i) => ({ ...sample, id: String(i) })))[0]
  const block = createHeaderBlock(defaultLayoutBounds, [])
  block.columns[0].imageMode = 'separate'
  block.columns[1].imageMode = 'photo'
  const arranged = arrangePage({ ...page, headerBlocks: [block] })
  assert.equal(new Set(arranged.imageGroups.flatMap(group => group.itemIds)).size, page.items.length)
  assert.ok(arranged.imageGroups.length >= 1)
  const [first, second, below] = arranged.imageGroups
  for (const gap of [second.x - first.x - first.width, below.y - first.y - first.height]) assert.ok(Math.abs(gap * 210 / PAPER_WIDTH - 1.8) < 1e-9)
  for (const group of arranged.imageGroups) {
    assert.ok(group.x >= defaultLayoutBounds.left)
    assert.ok(group.y >= block.y + HEADER_BLOCK_HEIGHT)
    assert.ok(group.x + group.width <= PAPER_WIDTH - defaultLayoutBounds.right + 1e-9)
    assert.ok(group.y + group.height <= PAPER_HEIGHT - defaultLayoutBounds.bottom + 1e-9)
    for (const id of group.itemIds) {
      const item = arranged.items.find(item => item.id === id)
      assert.ok(item.x - item.w / 2 >= group.x)
      assert.ok(item.y - item.h / 2 >= group.y)
      assert.ok(item.x + item.w / 2 <= group.x + group.width / 2, 'right half remains available for details')
      assert.ok(item.y + item.h / 2 <= group.y + group.height)
    }
  }
  const assets = new Map(page.items.map(item => [item.assetId, { ...sample, id: item.assetId }]))
  for (const render of [pageSvg, pageRasterSvg]) {
    const svg = render(arranged, assets)
    const backgrounds = svg.match(/<g data-image-group-backgrounds="true" fill="#D4E9D8">(.*?)<\/g>/)[1]
    assert.equal((backgrounds.match(/<rect /g) ?? []).length, arranged.imageGroups.length)
    assert.ok(!backgrounds.includes('stroke'))
    assert.ok(!backgrounds.includes('rx='))
    assert.ok(svg.indexOf('data-image-group-backgrounds') < svg.indexOf('transform="translate('))
  }
})

test('detail fields use the tighter bold style and accessory images have a white backing', () => {
  const page = paginateAssets([{ ...sample, id: 'detail' }])[0]
  page.imageGroups[0].details = { size: '1"', qt: '3', finish: '', accessoryImage: 'https://cdn.example/accessory.png' }
  const assets = new Map([['detail', { ...sample, id: 'detail' }]])
  const svg = pageSvg(page, assets)
  assert.match(svg, /font-size="10" font-weight="700"[^>]*>Size:/)
  assert.match(svg, /font-size="10" font-weight="700"[^>]*>Accessory:/)
  assert.match(svg, /<rect x="[\d.\-]+" y="[\d.\-]+" width="[\d.]+" height="[\d.]+" rx="2" fill="#fff"\/><image data-printflow-accessory="true"/)
  for (const [size, finish, expected] of [
    ['', '', ['QT: 3', 'Accessory:']],
    [' \t', '\n ', ['QT: 3', 'Accessory:']],
    [undefined, undefined, ['QT: 3', 'Accessory:']],
    ['1 inch', '', ['Size: 1 inch', 'QT: 3', 'Accessory:']],
    ['', 'Matte', ['QT: 3', 'Finish: Matte', 'Accessory:']],
    ['0', 'Glossy', ['Size: 0', 'QT: 3', 'Finish: Glossy', 'Accessory:']],
  ]) {
    const group = page.imageGroups[0]
    group.details = { ...group.details, size, finish }
    const layout = imageDetailsLayout(group)
    assert.deepEqual(layout.fields.map(field => field.text), expected, 'canvas rows hide only empty Size and Finish')
    for (const render of [pageSvg, pageRasterSvg]) {
      const output = render(page, assets)
      const fields = [...output.matchAll(/<text [^>]*y="([\d.]+)"[^>]*>(Size: [^<]*|QT: [^<]*|Finish: [^<]*|Accessory:)<\/text>/g)]
      assert.deepEqual(fields.map(field => field[2]), expected)
      assert.deepEqual(fields.map(field => Number(field[1])), expected.map((_, index) => group.y + 4 + 11 * (index + 1) - 2), 'hidden fields leave no blank rows')
      assert.ok(output.includes(`data-printflow-accessory="true" x="${layout.x}" y="${group.y + 4 + 11 * expected.length}"`), 'accessory moves up with the visible rows')
    }
  }
})

test('accessory code and image notes render together in exported SVG', () => {
  const asset = { ...sample, id: 'annotated', attributes: { 'Accessories Color': 'Star Hook Clasp-9' }, attributeImages: { 'Accessories Color': 'data:image/png;base64,AA==' }, note: '备注文字', noteImage: 'data:image/png;base64,BB==' }
  const page = paginateAssets([asset])[0]
  page.imageGroups[0].details = detailsForAsset(asset)
  const svg = pageSvg(page, new Map([[asset.id, asset]]))
  assert.match(svg, />9<\/text>/)
  assert.match(svg, />备注文字<\/text>/)
  assert.ok(!svg.includes('备注: '), 'show note content without a field label')
  assert.match(svg, /data-printflow-note="true"/)
  const layout = imageDetailsLayout(page.imageGroups[0])
  assert.ok(layout.noteX > layout.x + layout.imageSize + 2)
  assert.ok(svg.includes(`<text x="${layout.noteX}" y="${layout.noteY + layout.noteLine - 2}"`))
  assert.ok(svg.includes(`data-printflow-note="true" x="${layout.noteX}"`))
})

test('notes use the empty area beside accessories without reducing short text or either image', () => {
  const group = { id: 'beside', itemIds: [], x: 10, y: 120, width: 157, height: 110,
    details: { size: '', qt: '', finish: '', accessoryImage: 'accessory.png', accessoryCode: '24', note: '注意颜色', noteImage: 'note.png' } }
  const layout = imageDetailsLayout(group)
  assert.ok(layout.noteX >= layout.x + layout.imageSize + 6)
  assert.equal(layout.noteY, layout.y + layout.line * 2)
  assert.equal(layout.noteFontSize, 8)
  assert.equal(layout.imageSize, 39.6)
  assert.equal(layout.noteImageSize, 24.2)
  assert.equal(layout.noteLines.join(''), group.details.note)
})

test('narrow note areas fall back below the accessory and absent accessories leave full note width', () => {
  const group = { id: 'fallback', itemIds: [], x: 10, y: 120, width: 120, height: 110,
    details: { size: '', qt: '', finish: '', accessoryImage: 'accessory.png', accessoryCode: '24', note: '注意颜色', noteImage: 'note.png' } }
  const below = imageDetailsLayout(group)
  assert.equal(below.noteX, below.x)
  assert.equal(below.noteWidth, below.width)
  assert.ok(below.noteY > below.bodyY + below.accessoryHeight)
  assert.ok(below.noteImageY + below.noteImageSize <= group.y + group.height - 4 + 1e-7)
  const noAccessory = imageDetailsLayout({ ...group, details: { ...group.details, accessoryImage: undefined } })
  assert.equal(noAccessory.noteX, noAccessory.x)
  assert.equal(noAccessory.noteWidth, noAccessory.width)
  assert.equal(noAccessory.noteY, noAccessory.y + noAccessory.line * 2 + 2)
  assert.equal(noAccessory.noteLines.join(''), group.details.note)
})

test('notes and their images stay inside each group without overlapping the accessory', () => {
  for (const height of [110, 180, 250]) for (const note of ['注意', '第一行备注\n第二行备注', '这是一条很长的备注，需要在窄的详情区域中换行并保留原始备注']) {
    const group = { id: 'notes', itemIds: [], x: 10, y: 120, width: 157, height,
      details: { size: '', qt: '', finish: '', accessoryImage: 'accessory.png', accessoryCode: '24', note, noteImage: 'note.png' } }
    const layout = imageDetailsLayout(group)
    assert.ok(layout.noteY > layout.bodyY + layout.accessoryHeight || layout.noteX >= layout.x + layout.imageSize + 6)
    assert.ok(layout.noteImageY >= layout.noteY + layout.noteLines.length * layout.noteLine)
    assert.ok(layout.noteImageY + layout.noteImageSize <= group.y + group.height - 3.9)
    assert.ok(layout.noteX + layout.noteImageSize < group.x + group.width)
    assert.ok(layout.noteImageSize > 0 && layout.imageSize > 0)
    assert.equal(layout.noteLines.join(''), note.replace(/\n/g, ''), 'the full note is retained without a field label or truncation')
    assert.equal(group.details.note, note)
  }
})

test('auto layout enlarges small images to fit their image cells while reserving details', () => {
  const block = resizeHeaderColumns(createHeaderBlock(defaultLayoutBounds, []), 1)
  const original = { id: 'small', assetId: 'a', x: 0, y: 0, w: 46, h: 50, rotation: 0 }
  const result = arrangePage({ id: 1, name: 'test', items: [original], headerBlocks: [block] })
  const item = result.items[0]
  const group = result.imageGroups[0]
  assert.ok(item.w > original.w && item.h > original.h)
  assert.ok(item.h > 100, 'remaining page height is not capped at the old 100-unit size')
  assert.ok(Math.abs(item.w / item.h - original.w / original.h) < 1e-9)
  assert.ok(Math.abs(item.w - (group.width / 2 - GROUP_GAP * 2)) < 1e-9, 'width fills its image cell, leaving details clear')
  assertWithin(item, defaultLayoutBounds)
  assert.equal(original.w, 46, 'layout does not modify source dimensions')
})

test('enlarging the layout area restores a previously reduced image and repeated arrangement stays stable', () => {
  const original = { id: 'tall', assetId: 'a', x: 0, y: 0, w: 20, h: 100, rotation: 0 }
  const page = { id: 1, name: 'test', items: [original] }
  const smallBounds = { top: 610, bottom: 10, left: 170, right: 170 }
  const small = arrangePage(page, smallBounds)
  const expanded = arrangePage(small, defaultLayoutBounds)
  const fresh = arrangePage(page, defaultLayoutBounds)
  const repeated = arrangePage(expanded, defaultLayoutBounds)
  assert.ok(small.items[0].h < original.h)
  assert.ok(expanded.items[0].h > original.h)
  for (const key of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(expanded.items[0][key] - fresh.items[0][key]) < 1e-9)
    assert.ok(Math.abs(repeated.items[0][key] - fresh.items[0][key]) < 1e-9)
  }
  assertWithin(expanded.items[0], defaultLayoutBounds)
  assert.ok(Math.abs(expanded.items[0].w / expanded.items[0].h - 0.2) < 1e-9)
})

test('empty groups disappear after removal and an ungrouped dropped image receives a background', () => {
  const page = paginateAssets(Array.from({ length: 3 }, (_, i) => ({ ...sample, id: String(i) })))[0]
  const added = { ...page.items[0], id: 'dropped', assetId: 'new' }
  const changed = { ...page, items: [...page.items.slice(1), added] }
  const groups = imageGroupsForPage(changed)
  assert.equal(groups.length, 3)
  assert.ok(groups.every(group => !group.itemIds.includes(page.items[0].id)))
  assert.ok(groups.some(group => group.itemIds.includes('dropped')))
})

test('an impossibly small region reports capacity instead of losing images or reducing the gutter', () => {
  const page = paginateAssets(Array.from({ length: 12 }, (_, i) => ({ ...sample, id: String(i) })))[0]
  const bounds = { top: PAPER_HEIGHT - 40, bottom: 0, left: 0, right: 0 }
  const block = resizeHeaderColumns(createHeaderBlock(bounds, []), 1)
  assert.throws(() => arrangePage({ ...page, headerBlocks: [block] }, bounds), /1.8mm/)
  assert.ok(page.items.length <= 12)
  assert.ok(Math.abs(GROUP_GAP * 210 / PAPER_WIDTH - 1.8) < 1e-9)
})

test('new and dragged header blocks remain inside the configured area', () => {
  const first = createHeaderBlock(defaultLayoutBounds, [])
  const second = createHeaderBlock(defaultLayoutBounds, [first])
  assert.notEqual(first.id, second.id)
  assert.ok(second.y > first.y + HEADER_BLOCK_HEIGHT)
  const clamped = constrainHeaderBlock({ ...second, x: -100, y: 2000, width: 2000 }, defaultLayoutBounds)
  assert.equal(clamped.x, defaultLayoutBounds.left)
  assert.equal(clamped.y + HEADER_BLOCK_HEIGHT, PAPER_HEIGHT - defaultLayoutBounds.bottom)
  assert.equal(clamped.width, PAPER_WIDTH - defaultLayoutBounds.left - defaultLayoutBounds.right)
  assert.deepEqual(clamped.columns, second.columns)
})

test('multiple table sections reserve detail cells without losing any images', () => {
  const items = paginateAssets(Array.from({ length: 12 }, (_, i) => ({ ...sample, id: String(i) })))[0].items
  const first = createHeaderBlock(defaultLayoutBounds, [])
  first.columns[1].imageMode = 'separate'
  const second = createHeaderBlock(defaultLayoutBounds, [first])
  second.columns[0].imageMode = 'photo'
  const arranged = arrangeItems(items, defaultLayoutBounds, [first, second])
  assert.deepEqual(arranged.map(item => item.assetId), items.map(item => item.assetId))
  for (const item of arranged) {
    assertWithin(item, defaultLayoutBounds)
    assert.ok(Math.abs(item.w / item.h - sample.width / sample.height) < 1e-6)
    const block = item.y < second.y ? first : second
    assert.ok(item.y - item.h / 2 >= block.y + HEADER_BLOCK_HEIGHT)
    if (block === first) assert.ok(item.y + item.h / 2 < second.y)
    assert.ok(headerCells(block).filter(cell => cell.role === 'image').some(cell => item.x - item.w / 2 >= block.x + cell.x && item.x + item.w / 2 <= block.x + cell.x + cell.width))
  }
})

test('exports include only each page’s manual headers with the chosen modes and positions', () => {
  const pages = paginateAssets(Array.from({ length: 13 }, (_, i) => ({ ...sample, id: String(i) })))
  const assets = new Map(pages.flatMap(page => page.items.map(item => [item.assetId, { ...sample, id: item.assetId }])))
  const block = createHeaderBlock(defaultLayoutBounds, [])
  block.y = 155
  block.columns[0].imageMode = 'photo'
  block.columns[0].detailLabel = '工艺 & 尺寸 <说明>'
  pages[0].headerBlocks = [block, { ...createHeaderBlock(defaultLayoutBounds, [block]), columns: [{ id: 's', imageMode: 'separate', detailLabel: 'Accessory' }] }]
  const metadata = { customerName: '客户 & Co', designer: '设计师' }
  for (const render of [pageSvg, pageRasterSvg]) {
    const svg = render(pages[0], assets, metadata, pages.length)
    assert.ok(svg.includes('Customer: 客户 &amp; Co'))
    assert.ok(svg.includes('工艺 &amp; 尺寸 &lt;说明&gt;'))
    for (const caption of ['photo', 'Front', 'Back', 'Accessory']) assert.ok(svg.includes(`>${caption}</text>`))
    assert.ok(svg.includes('1 of 2'))
    assert.ok(svg.includes('translate(10 155)'))
    assert.ok(svg.indexOf('ORDER PROOF') < svg.indexOf('translate('))
    assert.ok(!svg.includes('stroke-dasharray'), 'editing guides must not be exported')
    const secondPageSvg = render(pages[1], assets, metadata, pages.length)
    assert.ok(!secondPageSvg.includes('工艺 &amp; 尺寸'))
    assert.ok(secondPageSvg.includes('Accessory'))
    assert.ok(secondPageSvg.includes('2 of 2'))
  }
})
