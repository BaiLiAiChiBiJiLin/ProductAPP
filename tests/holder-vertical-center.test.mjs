import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { defaultLayoutBounds, pageSvg } from '../src/model.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { detailPanelsForGroup } from '../src/modules/schematic/arrangement/productGroupDetails.ts'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'
import { resizeImageGroup } from '../src/modules/schematic/services/groupResizeService.ts'
import { horizontalGroupPages } from '../src/modules/schematic/services/horizontalGroupReflowService.ts'

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-7, `${message}: ${a} != ${b}`)
const sources = (product, portrait = false, finish = '') => ['Example', 'Front', 'Inside', 'Back'].map((name, i) => ({
  id: name, name, productId: product, productName: product, productGroupId: 'holder', productGroupPosition: i + 1,
  width: portrait ? 40 : 100, height: portrait ? 100 : 40,
  sourceGroupWidthMm: portrait ? 40 : 100, sourceGroupHeightMm: portrait ? 100 : 40,
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="40" height="100"/></svg>',
  previewUrl: '', thumbnailUrl: '', attributes: { QT: '2', Finish: finish },
}))

test('holder and shaker layouts center all role rows together with their property panel', () => {
  for (const product of ['Shaker', '摇摇乐', 'Photocard Holders', '照片夹']) for (const portrait of [false, true]) for (const finish of ['', 'Epoxy']) {
    const assets = sources(product, portrait, finish)
    const [page] = paginateAssets(assets)
    const group = page.imageGroups[0]
    const layout = imageDetailsLayout(detailPanelsForGroup(group)[0])
    const top = Math.min(layout.y, ...page.items.map(item => item.y - item.h / 2 - 20))
    const bottom = Math.max(...layout.fields.map(field => layout.y + field.y + field.height), ...page.items.map(item => item.y + item.h / 2))
    close(top - group.y, group.y + group.height - (finish ? 18 : 0) - bottom, `${product} has equal upper and lower content whitespace`)
    assert.ok(group.detailsOffsetY > 0, 'the complete layout moves away from the top')
    for (const item of page.items) {
      const cell = group.imageCells.find(cell => cell.itemId === item.id)
      assert.ok(item.y - item.h / 2 - 20 >= group.y)
      assert.ok(item.y + item.h / 2 <= group.y + group.height - (finish ? 18 : 0))
      assert.ok(cell.y >= group.y && cell.y + cell.height <= group.y + group.height + 1e-7)
      close(item.w / item.h, assets[0].width / assets[0].height, 'centering preserves the image ratio')
    }
    const [again] = autoArrangePages([page], page.id, assets, defaultLayoutBounds)
    assert.deepEqual(again.items.map(item => [item.x, item.y, item.w, item.h]), page.items.map(item => [item.x, item.y, item.w, item.h]))
    close(again.imageGroups[0].detailsOffsetY, group.detailsOffsetY, 'regeneration does not accumulate a translation')
  }
})

test('centered property text uses identical vertical positions in the PDF SVG and canvas', () => {
  const assets = sources('Shaker')
  const [page] = paginateAssets(assets)
  const group = page.imageGroups[0]
  const layout = imageDetailsLayout(detailPanelsForGroup(group)[0])
  const document = new JSDOM(pageSvg(page, new Map(assets.map(asset => [asset.id, asset]))), { contentType: 'image/svg+xml' }).window.document
  const quantity = [...document.querySelectorAll('text')].find(element => element.textContent === 'QT: 2')
  const field = layout.fields.find(field => field.key === 'qt')
  close(Number(quantity.getAttribute('y')), layout.y + field.y + field.fontSize, 'export follows the centered QT')
})

test('manual block resizing scales the property offset and a new horizontal layout clears it', () => {
  const [page] = paginateAssets(sources('Photocard Holders'))
  const group = page.imageGroups[0]
  const resized = resizeImageGroup(page, group.id, { x: group.x, y: group.y, width: group.width, height: group.height * .8 }, defaultLayoutBounds)
  close(resized.imageGroups[0].detailsOffsetY, group.detailsOffsetY * .8, 'resizing retains relative property placement')
  const horizontal = horizontalGroupPages([page], page.id, group.id, defaultLayoutBounds)
  const rearranged = horizontal.flatMap(page => page.imageGroups).find(candidate => candidate.id === group.id)
  assert.equal(rearranged.detailsOffsetY, undefined, 'a new layout does not reuse an obsolete vertical offset')
})
