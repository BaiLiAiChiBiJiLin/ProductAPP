import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds, GROUP_GAP, PAPER_HEIGHT, PAPER_WIDTH, pageSvg, pageRasterSvg } from '../src/model.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { paginateAutomaticAssets } from '../src/modules/schematic/services/automaticArrangementService.ts'
import { arrangePage } from '../src/modules/schematic/services/pageLayoutService.ts'
import { buildProductGroupDetails, detailPanelsForGroup } from '../src/modules/schematic/arrangement/productGroupDetails.ts'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'
import { imageGroupsForDimension, imageDimensionMarkerLayout } from '../src/modules/schematic/services/imageDimensionService.ts'
import { removeArrangedAsset } from '../src/modules/schematic/arrangement/productGroupPageState.ts'

const asset = (id, group = '', attrs = {}) => ({ id, name: id, productId: 'standees', productName: 'Clear Acrylic Standees', width: 92, height: 100,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="92" height="100"><rect width="92" height="100" fill="tomato"/></svg>',
  attributes: { Size: '10cm', QT: '2', Technique: 'clear', ...attrs }, productGroupId: group, productGroupLeaderId: group === 'g' ? 'g2' : undefined })
const checkBounds = pages => {
  for (const page of pages) for (const group of page.imageGroups) {
    assert.ok(group.x >= defaultLayoutBounds.left && group.y >= defaultLayoutBounds.top)
    assert.ok(group.x + group.width <= PAPER_WIDTH - defaultLayoutBounds.right + 1e-7)
    assert.ok(group.y + group.height <= PAPER_HEIGHT - defaultLayoutBounds.bottom + 1e-7)
    for (const cell of group.imageCells ?? []) {
      const item = page.items.find(item => item.id === cell.itemId)
      assert.ok(item.x - item.w / 2 >= cell.x - 1e-7)
      assert.ok(item.x + item.w / 2 <= cell.x + cell.width + 1e-7)
      assert.ok(item.y - item.h / 2 >= cell.y + GROUP_GAP - 1e-7)
      assert.ok(item.y + item.h / 2 <= cell.y + cell.height - GROUP_GAP + 1e-7)
    }
  }
}

test('interleaved product members enter one atomic group, preserve leader order and source aspect ratio', () => {
  const assets = [asset('g1', 'g'), asset('other'), asset('g2', 'g'), asset('g3', 'g')]
  const original = new Map(paginateAutomaticAssets(assets, 1000).flatMap(page => page.items.map(item => [item.assetId, item])))
  const pages = paginateAssets(assets, 1000)
  const groups = pages.flatMap(page => page.imageGroups).filter(group => group.productGroupId === 'g')
  assert.equal(groups.length, 1)
  const page = pages.find(page => page.imageGroups.includes(groups[0]))
  assert.deepEqual(groups[0].itemIds.map(id => page.items.find(item => item.id === id).assetId), ['g2', 'g1', 'g3'])
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.assetId)).sort(), assets.map(asset => asset.id).sort())
  for (const item of page.items.filter(item => groups[0].itemIds.includes(item.id))) {
    assert.ok(item.w >= original.get(item.assetId).w)
    assert.ok(item.h >= original.get(item.assetId).h)
    assert.ok(Math.abs(item.w / item.h - 92 / 100) < 1e-9)
  }
  assert.ok(groups[0].height >= 110)
  assert.ok(groups[0].imageColumns > 1)
  checkBounds(pages)
})

test('product groups occupy adjacent item ranges without interleaving another group', () => {
  const assets = [asset('a1', 'a'), asset('b1', 'b'), asset('ordinary'), asset('a2', 'a'), asset('b2', 'b'), asset('a3', 'a')]
  const pages = paginateAssets(assets, 1000)
  const ordered = pages.flatMap(page => page.items.map(item => item.assetId))
  for (const [group, members] of [['a', ['a1', 'a2', 'a3']], ['b', ['b1', 'b2']]]) {
    const positions = members.map(member => ordered.indexOf(member))
    assert.equal(Math.max(...positions) - Math.min(...positions) + 1, members.length, `${group} members must be adjacent`)
  }
  const aStart = ordered.indexOf('a1')
  const bStart = ordered.indexOf('b1')
  assert.ok(aStart < bStart, 'the first group keeps its input order relative to the next group')
})

test('four-member product groups use multiple image rows and one shared detail panel', () => {
  const pages = paginateAssets([asset('g1', 'g'), asset('g2', 'g'), asset('g3', 'g'), asset('g4', 'g')], 1000)
  const group = pages[0].imageGroups.find(candidate => candidate.productGroupId === 'g')
  assert.ok(group.imageColumns > 1)
  assert.ok(new Set(group.imageCells.map(cell => cell.y)).size > 1, 'four images should wrap into multiple rows')
  assert.equal(group.detailGroups.length, 1, 'matching product information should have one shared details area')
  assert.equal(group.itemIds.length, 4)
  checkBounds(pages)
})

test('matching production information renders once; differing fields and notes keep multiple complete panels', () => {
  const assets = [asset('g1', 'g'), asset('g2', 'g'), asset('g3', 'g', { QT: '9', Technique: 'epoxy' })]
  assets[1].attributes = { Technique: 'clear', QT: '2', Size: '10cm' }
  const pages = paginateAssets(assets, 1000)
  const group = pages[0].imageGroups[0]
  assert.equal(group.detailGroups.length, 2)
  assert.equal(group.detailGroups[0].itemIds.length, 2)
  assert.equal(group.detailGroups[1].details.qt, '9')
  const byAsset = new Map(assets.map(asset => [asset.id, asset]))
  for (const render of [pageSvg, pageRasterSvg]) {
    const svg = render(pages[0], byAsset)
    assert.equal((svg.match(/data-printflow-details="true"/g) ?? []).length, 2)
    assert.equal((svg.match(/data-printflow-dimension="true"/g) ?? []).length, 3)
    assert.equal((svg.match(/data-printflow-image-label="true"/g) ?? []).length, 0)
    const text = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]).join('')
    assert.doesNotMatch(text, /epoxy|Technique|Print Option|产品:/, 'merged group details only show the four production fields')
    assert.doesNotMatch(text, /图\s*\d/, 'merged group details do not show image numbering')
  }
  assert.deepEqual(group.detailGroups.map(panel => panel.details.fields ?? []), [[], []])
  for (const panel of detailPanelsForGroup(group)) {
    const layout = imageDetailsLayout(panel)
    assert.ok(layout.x >= group.x + group.width / 2)
    assert.ok(layout.x + layout.width <= group.x + group.width)
    assert.ok(layout.bodyY <= panel.y + panel.height)
  }
  assets[1].note = 'independent note'
  assert.equal(buildProductGroupDetails(pages[0].items, new Map(assets.map(a => [a.id, a]))).length, 3)
})

test('automatic/manual page refresh preserves membership, size, details and one ruler per image', () => {
  const assets = Array.from({ length: 12 }, (_, i) => asset(`a${i}`, `group-${Math.floor(i / 3)}`))
  const pages = paginateAssets(assets, 1000)
  const next = autoArrangePages(pages, 1, assets, defaultLayoutBounds)
  const sizes = new Map(pages.flatMap(page => page.items.map(item => [item.id, [item.w, item.h]])))
  for (const page of next) {
    const refreshed = arrangePage(page)
    assert.equal(refreshed.imageGroups.length, page.imageGroups.length)
    assert.equal(imageGroupsForDimension(refreshed).length, page.items.length)
    for (const item of refreshed.items) assert.deepEqual([item.w, item.h], sizes.get(item.id))
    for (const group of refreshed.imageGroups) assert.ok(group.productGroupId && group.detailGroups.length)
    for (const region of imageGroupsForDimension(refreshed)) assert.equal(imageDimensionMarkerLayout(region, refreshed, new Map(assets.map(a => [a.id,a]))).label, '100 mm')
  }
  checkBounds(next)
})

test('80 images paginate as whole groups without dropping or repeating members', () => {
  const assets = Array.from({ length: 80 }, (_, i) => asset(`a${i}`, `group-${Math.floor(i / 4)}`))
  const start = performance.now()
  const pages = paginateAssets(assets, 1000)
  assert.ok(performance.now() - start < 5000)
  assert.ok(pages.length > 1)
  const groups = pages.flatMap(page => page.imageGroups)
  assert.equal(groups.length, 20)
  assert.equal(new Set(groups.map(group => group.productGroupId)).size, 20)
  assert.ok(groups.every(group => group.itemIds.length === 4))
  assert.equal(pages.flatMap(page => page.items).length, 80)
  assert.equal(new Set(pages.flatMap(page => page.items.map(item => item.assetId))).size, 80)
  checkBounds(pages)
})

test('a tall product group uses a wider grid before shrinking or splitting its pictures', () => {
  const assets = Array.from({ length: 7 }, (_, i) => asset(`grid-${i}`, 'grid'))
  const pages = paginateAssets(assets, 1000)
  assert.equal(pages.length, 1)
  assert.equal(pages[0].imageGroups.length, 1)
  assert.ok(pages[0].imageGroups[0].imageColumns > 1)
  assert.equal(pages[0].imageGroups[0].imageCells.length, 7)
  checkBounds(pages)
})

test('members with different print modes stay together under the leader header', () => {
  const a = { ...asset('g1', 'g', { 'Print Option': 'Double Sided Same Design' }), productId: 'cards', productName: 'Cards' }
  const b = { ...asset('g2', 'g', { 'Print Option': 'Double Sided Different Design' }), productId: 'cards', productName: 'Cards' }
  const [page] = paginateAssets([a, asset('normal'), b], 1000)
  const group = page.imageGroups.find(group => group.productGroupId === 'g')
  assert.equal(group.itemIds.length, 2)
  assert.equal(group.detailGroups.length, 1, 'hidden product fields do not create a second panel')
  const header = page.headerBlocks.find(block => block.assetIds.includes('g2'))
  assert.equal(header.columns[0].imageMode, 'separate')
  assert.ok(header.assetIds.includes('g1'))
})

test('removing a member clears its details and ruler without changing the asset product group', () => {
  const assets = [asset('g1', 'g'), asset('g2', 'g'), asset('g3', 'g', { QT: '9' })]
  const [page] = paginateAssets(assets, 1000)
  const removed = removeArrangedAsset(page, 'g3', assets)
  assert.equal(removed.items.length, 2)
  assert.equal(removed.imageGroups[0].detailGroups.length, 1)
  assert.equal(removed.imageGroups[0].imageCells.length, 2)
  assert.equal(imageGroupsForDimension(removed).length, 2)
  assert.equal(assets[2].productGroupId, 'g')
})
