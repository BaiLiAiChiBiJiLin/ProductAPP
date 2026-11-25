import test from 'node:test'
import assert from 'node:assert/strict'
import { artworkBounds, defaultLayoutBounds, GROUP_GAP, headerColumnBounds, PAPER_WIDTH } from '../src/model.ts'
import { autoArrangePages, paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { headerFor } from '../src/modules/schematic/arrangement/pageSections.ts'

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`)
const parts = (id, count, different = false) => Array.from({ length: count + 1 }, (_, index) => {
  const base = index === count
  const width = base ? 65 : 40 + index * 15, height = base ? 15 : 80 + index * 30
  return { id: `${id}-${index}`, name: `${id}-${index}`, productId: 'standee', productName: 'Clear Acrylic Standees',
    productGroupId: id, productGroupPosition: index + 1, width, height, sourceGroupWidthMm: width, sourceGroupHeightMm: height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`, previewUrl: '', thumbnailUrl: '',
    attributes: { 'Standee Quantity': `${count} pieces`, QT: '50', 'Print Option': different && !base ? 'Double Sided Different Design' : 'Double Sided Same Design' } }
})
const contentWidth = bounds => PAPER_WIDTH - artworkBounds(bounds).left - artworkBounds(bounds).right

for (const count of [1, 2, 3, 4]) for (const different of [false, true]) {
  test(`${count}-piece ${different ? 'different' : 'same'}-design standee occupies the required base columns through rearrangement`, () => {
    const assets = parts('group', count, different)
    const bounds = { ...defaultLayoutBounds, paddingLeft: 12, paddingRight: 10 }
    let pages = paginateAssets(assets, 12, bounds)
    for (let pass = 0; pass < 3; pass++) {
      const page = pages[0], group = page.imageGroups[0], span = count > 2 ? 3 : count === 2 || different ? 2 : 1
      close(group.width, (contentWidth(bounds) - 2 * GROUP_GAP) / 3 * span + (span - 1) * GROUP_GAP)
      const column = headerColumnBounds(headerFor(page, group)).find(slot => Math.abs(slot.width - group.width) < 1e-6)
      assert.equal(column.column.span, span)
      assert.equal(new Set(page.items.filter(item => !item.derivedFrom).map(item => item.assetId)).size, count + 1)
      pages = autoArrangePages(pages, page.id, assets, bounds)
    }
  })
}

test('two-piece and one-piece same-product groups share one row while three-piece groups own the row', () => {
  const assets = [...parts('two', 2), ...parts('one', 1), ...parts('three', 3), ...parts('last', 1)]
  const pages = paginateAssets(assets)
  const groups = pages.flatMap(page => page.imageGroups)
  close(groups[0].y, groups[1].y)
  close(groups[0].width + GROUP_GAP + groups[1].width, contentWidth(defaultLayoutBounds))
  const full = groups.find(group => group.productGroupId === 'three')
  close(full.width, contentWidth(defaultLayoutBounds))
  const owner = pages.find(page => page.imageGroups.includes(full))
  assert.equal(owner.imageGroups.filter(group => Math.abs(group.y - full.y) < 1e-6).length, 1)
})

test('saved quantity works before every piece has been supplied and ignores order QT', () => {
  for (const [name, value, expected] of [['Standee Quantity', '2 pieces', 2], ['透明立牌数量', '3件', 3], ['Count', 'pair', 2]]) {
    const assets = parts('group', 1).map(asset => ({ ...asset, attributes: { [name]: value, QT: '500' } }))
    const configs = [{ id: 'standee', title: 'Clear Acrylic Standees', options: [{ name: 'Count', label: '立牌件数', values: [{ name: 'pair', label: '2片', hidden: false, deleted: false, parentValues: [] }] }] }]
    const [page] = paginateAssets(assets, 12, defaultLayoutBounds, configs)
    close(page.imageGroups[0].width, (contentWidth(defaultLayoutBounds) - 2 * GROUP_GAP) / 3 * expected + (expected - 1) * GROUP_GAP)
  }
})

test('standee main artwork shares a physical scale despite aspect ratios, viewports and different-design backs', () => {
  const assets = [...parts('multi', 2, true), ...parts('single', 1)]
  // A tiny physical base must never independently fill a larger property cell.
  assets[2] = { ...assets[2], width: 900, height: 300, sourceGroupWidthMm: 9, sourceGroupHeightMm: 3 }
  const snapshot = JSON.stringify(assets)
  let pages = paginateAssets(assets)
  for (let pass = 0; pass < 3; pass++) {
    for (const page of pages) {
      const reference = page.items[0].w / assets.find(asset => asset.id === page.items[0].assetId).sourceGroupWidthMm
      for (const item of page.items.filter(item => item.caption !== 'base')) {
        const asset = assets.find(asset => asset.id === item.assetId)
        close(item.w / asset.sourceGroupWidthMm, reference)
        close(item.h / asset.sourceGroupHeightMm, reference)
        const cell = page.imageGroups.flatMap(group => group.imageCells).find(cell => cell.itemId === item.id)
        assert.ok(item.x - item.w / 2 >= cell.x - 1e-6 && item.x + item.w / 2 <= cell.x + cell.width + 1e-6)
        assert.ok(item.y - item.h / 2 >= cell.y - 1e-6 && item.y + item.h / 2 <= cell.y + cell.height + 1e-6)
      }
    }
    pages = autoArrangePages(pages, 1, assets, defaultLayoutBounds)
  }
  assert.equal(JSON.stringify(assets), snapshot)
})
