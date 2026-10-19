import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds, DETAIL_AREA_RATIO, HOLDER_DETAIL_AREA_RATIO, headerCells, headerColumnBounds, pageSvg, pageRasterSvg } from '../src/model.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { productGroupFootprint, placeProductGroup } from '../src/modules/schematic/arrangement/productGroupLayout.ts'
import { rearrangeProductPage } from '../src/modules/schematic/arrangement/rearrangeProductPage.ts'
import { reflowAfterCombination } from '../src/modules/schematic/services/combinationReflowService.ts'
import { headerFor } from '../src/modules/schematic/arrangement/pageSections.ts'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'
import { detailPanelsForGroup } from '../src/modules/schematic/arrangement/productGroupDetails.ts'
import { accessoryFrame, rememberAccessorySize } from '../src/modules/schematic/services/accessoryFrameService.ts'
import { JSDOM } from 'jsdom'

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`)
const source = (id, productName = 'Keychains', group, position = 1, different = false) => ({
  id, name: id, productId: productName, productName, productGroupId: group, productGroupPosition: position,
  width: 40, height: 60, sourceGroupWidthMm: 40, sourceGroupHeightMm: 60,
  svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', previewUrl: '', thumbnailUrl: '',
  attributes: { Size: '60 mm', 'Print Option': different ? 'Double Sided Different Design' : 'Double Sided Same Design' },
})
const checkRatio = (group, detailRatio = DETAIL_AREA_RATIO) => {
  close(group.detailWidth, group.width * detailRatio)
  close(group.detailsX, group.x + group.width * (1 - detailRatio))
}
function checkHeaders(pages, ratioForGroup = () => DETAIL_AREA_RATIO) {
  for (const page of pages) for (const group of page.imageGroups) {
    checkRatio(group, ratioForGroup(group))
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

test('holders and shakers use eighty percent images while separate Front/Inside/Back rows remain full width', () => {
  for (const product of ['Shaker', '摇摇乐', 'Photocard Holders', '照片夹']) for (const emptyExample of [false, true]) {
    const sources = ['Example', 'Front', 'Inside', 'Back', 'extra'].slice(emptyExample ? 1 : 0)
      .map((id, index) => ({ ...source(id, product, 'holder', index + (emptyExample ? 2 : 1)), width: 70, height: 40,
        sourceGroupWidthMm: 70, sourceGroupHeightMm: 40 }))
    const [page] = paginateAssets(sources)
    checkHeaders([page], () => HOLDER_DETAIL_AREA_RATIO)
    const group = page.imageGroups[0]
    if (!emptyExample) close(group.imageCells.find(cell => cell.itemId === page.items.find(item => item.caption === 'Example').id).width, group.width * .8)
    for (const caption of ['Front', 'Inside', 'Back']) {
      const item = page.items.find(item => item.caption === caption)
      const cell = group.imageCells.find(cell => cell.itemId === item.id)
      close(cell.width, group.width * (emptyExample ? .8 : 1) / 3)
      if (!emptyExample) assert.ok(cell.y >= group.y + group.detailsHeight - 1e-7)
    }
    const extra = group.imageCells.find(cell => cell.itemId === page.items.find(item => item.assetId === 'extra').id)
    close(extra.width, group.width * .8)
  }
})

test('portrait holder roles share the enlarged image area and mixed headers survive repeated auto-arrangement', () => {
  for (const product of ['Shaker', 'Photocard Holders']) for (const holderFirst of [true, false]) {
    const roles = ['Example', 'Front', 'Inside', 'Back'].map((id, index) => source(id, product, 'holder', index + 1))
    const sources = holderFirst ? [...roles, source('ordinary')] : [source('ordinary'), ...roles]
    let pages = paginateAssets(sources)
    assert.equal(pages.length, 1)
    const expectedRatio = group => group.productGroupId === 'holder' ? HOLDER_DETAIL_AREA_RATIO : DETAIL_AREA_RATIO
    for (let attempt = 0; attempt < 3; attempt++) {
      checkHeaders(pages, expectedRatio)
      const page = pages[0]
      const holder = page.imageGroups.find(group => group.productGroupId === 'holder')
      const ordinary = page.imageGroups.find(group => group.productGroupId !== 'holder')
      assert.notEqual(headerFor(page, holder).id, headerFor(page, ordinary).id)
      const cells = holder.imageCells
      assert.equal(cells.length, 4)
      for (const cell of cells) {
        close(cell.width, holder.width * .8 / 4)
        close(cell.y, holder.y)
        assert.ok(cell.x + cell.width <= holder.detailsX + 1e-7)
      }
      pages = autoArrangePages(pages, 1, sources, defaultLayoutBounds)
    }
  }
})

test('a twenty-percent full-row property panel contains three named notes and keeps matching export positions', () => {
  const accessory = 'holder-ratio-accessory.png'
  rememberAccessorySize(accessory, 60, 200)
  for (const product of ['Shaker', '照片夹']) {
    const sources = ['Example', 'Front', 'Inside', 'Back'].map((id, index) => ({
      ...source(id, product, 'holder', index + 1),
      ...(index === 0 ? {
        noteImages: ['Front', 'Back', '孔位说明'].map(name => ({ name, src: `${name}.png` })),
        note: '完整显示的生产备注', attributeImages: { 'Accessories Color': accessory },
        attributes: { Size: '60 mm', QT: '123', 'Accessories Color': '02', Finish: 'Epoxy' },
      } : {}),
    }))
    const [page] = paginateAssets(sources)
    const group = page.imageGroups[0]
    checkRatio(group, HOLDER_DETAIL_AREA_RATIO)
    const layout = imageDetailsLayout(detailPanelsForGroup(group)[0])
    const frame = accessoryFrame(accessory, layout.accessoryX, layout.bodyY, layout.imageSize, '02')
    assert.equal(layout.noteImages.length, 3)
    close(layout.x, group.detailsX + 4)
    assert.ok(frame.x >= group.detailsX)
    assert.ok(frame.y + frame.frameHeight <= layout.noteY + 1e-7)
    for (const [index, image] of layout.noteImages.entries()) {
      assert.ok(image.size > 0)
      assert.ok(image.x > frame.x + frame.frameWidth)
      assert.ok(image.x + image.size <= group.x + group.width - 4 + 1e-7)
      assert.ok(image.y - image.captionHeight >= layout.bodyY - 1e-7)
      assert.ok(image.y + image.size <= layout.noteY - 2 + 1e-7)
      if (index) assert.ok(image.y - image.captionHeight > layout.noteImages[index - 1].y + layout.noteImages[index - 1].size)
    }
    const assets = new Map(sources.map(asset => [asset.id, asset]))
    for (const svg of [pageSvg(page, assets), pageRasterSvg(page, assets)]) {
      const document = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document
      const size = [...document.querySelectorAll('text')].find(node => node.textContent.startsWith('Size:'))
      close(Number(size.getAttribute('x')), layout.x)
      const notes = [...document.querySelectorAll('[data-printflow-note]')]
      assert.equal(notes.length, 3)
      notes.forEach((node, index) => {
        const image = layout.noteImages[index]
        close(Number(node.getAttribute('x')), image.x)
        close(Number(node.getAttribute('y')), image.y)
        close(Number(node.getAttribute('width')), image.size)
        assert.equal(node.parentNode.querySelector('[data-printflow-note-name]').textContent, image.name)
      })
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
