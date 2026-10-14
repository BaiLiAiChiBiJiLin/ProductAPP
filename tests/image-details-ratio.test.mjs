import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds, DETAIL_AREA_RATIO, IMAGE_AREA_RATIO, headerCells, headerColumnBounds } from '../src/model.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { productGroupFootprint, placeProductGroup } from '../src/modules/schematic/arrangement/productGroupLayout.ts'
import { rearrangeProductPage } from '../src/modules/schematic/arrangement/rearrangeProductPage.ts'
import { reflowAfterCombination } from '../src/modules/schematic/services/combinationReflowService.ts'
import { headerFor } from '../src/modules/schematic/arrangement/pageSections.ts'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'
import { detailPanelsForGroup } from '../src/modules/schematic/arrangement/productGroupDetails.ts'

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`)
const source = (id, productName = 'Keychains', group, position = 1, different = false) => ({
  id, name: id, productId: productName, productName, productGroupId: group, productGroupPosition: position,
  width: 40, height: 60, sourceGroupWidthMm: 40, sourceGroupHeightMm: 60,
  svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', previewUrl: '', thumbnailUrl: '',
  attributes: { Size: '60 mm', 'Print Option': different ? 'Double Sided Different Design' : 'Double Sided Same Design' },
})
const checkRatio = group => {
  close(group.detailWidth, group.width * DETAIL_AREA_RATIO)
  close(group.detailsX, group.x + group.width * IMAGE_AREA_RATIO)
}
function checkHeaders(pages) {
  for (const page of pages) for (const group of page.imageGroups) {
    checkRatio(group)
    const header = headerFor(page, group)
    const column = headerColumnBounds(header).find(column => Math.abs(header.x + column.x - group.x) < 1e-7)
    const details = headerCells(header).find(cell => cell.id === `${column.column.id}-details`)
    close(header.x + details.x, group.detailsX)
    close(details.width, group.detailWidth)
  }
}

test('ordinary, chains and mixed one/two-column standees give each group sixty percent images and forty percent details', () => {
  const sources = [source('ordinary'), source('chain-one', '串串', 'chain', 1), source('chain-two', '串串', 'chain', 2),
    source('single-main', 'Standees', 'single', 1), source('single-base', 'Standees', 'single', 2),
    source('double-main', 'Standees', 'double', 1, true), source('double-base', 'Standees', 'double', 2)]
  const pages = paginateAssets(sources)
  checkHeaders(pages)
  checkHeaders(autoArrangePages(pages, 1, sources, defaultLayoutBounds))
  const standees = pages.flatMap(page => page.imageGroups).filter(group => ['single', 'double'].includes(group.productGroupId))
  close(standees[0].y, standees[1].y)
  assert.ok(standees[1].detailWidth > standees[0].detailWidth)
})

test('holder fixed roles retain their layouts inside the new split including the full-width middle role row', () => {
  for (const emptyExample of [false, true]) {
    const sources = ['Example', 'Front', 'Inside', 'Back', 'extra'].slice(emptyExample ? 1 : 0)
      .map((id, index) => ({ ...source(id, 'Photocard Holders', 'holder', index + (emptyExample ? 2 : 1)), width: 70, height: 40 }))
    const [page] = paginateAssets(sources)
    checkHeaders([page])
    const group = page.imageGroups[0]
    for (const caption of ['Front', 'Inside', 'Back']) {
      const item = page.items.find(item => item.caption === caption)
      const cell = group.imageCells.find(cell => cell.itemId === item.id)
      close(cell.width, group.width * (emptyExample ? IMAGE_AREA_RATIO : 1) / 3)
      if (!emptyExample) assert.ok(cell.y >= group.y + group.detailsHeight - 1e-7)
    }
  }
})

test('product group footprint, placement and subsequent rearrangement keep the same sixty-forty split', () => {
  const items = ['one', 'two'].map((id, index) => ({ id, assetId: id, x: 30 + index * 40, y: 150, w: 30, h: 45, rotation: 0 }))
  const group = { id: 'combined', productGroupId: 'combined', itemIds: items.map(item => item.id), x: 10, y: 125, width: 300, height: 120,
    detailGroups: [{ itemIds: items.map(item => item.id), details: { size: '60 mm', qt: '', finish: '' } }] }
  const plan = productGroupFootprint(items, 400, group, 300)
  close(plan.detailWidth / (plan.imageWidth + plan.detailWidth), DETAIL_AREA_RATIO)
  const placed = placeProductGroup(items, group, 10, 125, 300, plan.height, plan.columns)
  checkRatio(placed.group)
  const page = { id: 1, name: 'one', items, imageGroups: [group], headerBlocks: [{
    id: 'header', x: 10, y: 95.2381, width: 480, detailWidth: 74,
    columns: [{ id: 'column', imageMode: 'photo', detailLabel: 'Size/QT/Finish' }],
  }] }
  const rearranged = rearrangeProductPage(page, defaultLayoutBounds)
  checkHeaders([rearranged])
  const reflowed = reflowAfterCombination([page], 0, items.map(item => source(item.id)), defaultLayoutBounds, [])
  checkHeaders(reflowed)
})

test('new header defaults use sixty-forty while saved explicit panel widths remain unchanged', () => {
  const header = { id: 'saved', x: 0, y: 0, width: 200, columns: [{ id: 'one', imageMode: 'photo', detailLabel: 'Size' }] }
  close(headerCells(header).find(cell => cell.role === 'details').width, 80)
  close(headerCells({ ...header, detailWidth: 74 }).find(cell => cell.role === 'details').width, 74)
})

test('compact chains reserve a vertical note stack while independent detail panels retain their own height', () => {
  const sources = [source('top', '串串', 'chain', 1), source('bottom', '串串', 'chain', 2)]
    .map(asset => ({ ...asset, width: 10, height: 10, sourceGroupWidthMm: 10, sourceGroupHeightMm: 10, attributes: { Size: '10 mm' } }))
  const [plain] = paginateAssets(sources)
  sources[0].noteImages = ['first', 'second', 'third'].map(name => ({ src: `${name}.png`, name }))
  const [withNotes] = paginateAssets(sources)
  const group = withNotes.imageGroups[0]
  assert.ok(group.height > plain.imageGroups[0].height)
  const layout = imageDetailsLayout(group)
  assert.equal(layout.noteImages.length, 3)
  layout.noteImages.forEach((image, index) => {
    assert.ok(image.y - image.captionHeight >= layout.bodyY - 1e-7)
    assert.ok(image.y + image.size <= group.y + group.height + 1e-7)
    if (index) assert.ok(image.y - image.captionHeight > layout.noteImages[index - 1].y + layout.noteImages[index - 1].size)
  })
  const panels = detailPanelsForGroup({ ...group, backgroundHeight: group.height * 2, imageColumns: 1,
    detailGroups: [{ itemIds: ['top'], details: group.details }, { itemIds: ['bottom'], details: group.details }] })
  for (const panel of panels) {
    close(panel.backgroundHeight, panel.height)
    const display = imageDetailsLayout(panel)
    assert.ok(display.noteImages.every(image => image.y + image.size <= panel.y + panel.height + 1e-7))
  }
})
