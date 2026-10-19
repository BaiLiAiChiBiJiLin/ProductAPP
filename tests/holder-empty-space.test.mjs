import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds, GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT } from '../src/model.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'
import { accessoryFrame, rememberAccessorySize } from '../src/modules/schematic/services/accessoryFrameService.ts'
import { detailPanelsForGroup } from '../src/modules/schematic/arrangement/productGroupDetails.ts'

const fullHeight = (PAPER_HEIGHT - defaultLayoutBounds.top - defaultLayoutBounds.bottom) / 2 - HEADER_BLOCK_HEIGHT - 2 * GROUP_GAP
const epsilon = 1e-7
const asset = (id, productName, groupId, position, extra = {}) => ({
  id, name: id, productId: productName, productName, productGroupId: groupId, productGroupPosition: position,
  width: 60, height: 120, sourceGroupWidthMm: 30, sourceGroupHeightMm: 60,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 120"><rect width="60" height="120" fill="red"/></svg>',
  previewUrl: '', thumbnailUrl: '', attributes: { QT: '2' }, ...extra,
})
function roles(productName, groupId = 'holder', emptyExample = false, extra = {}) {
  return (emptyExample ? ['Front', 'Inside', 'Back'] : ['Example', 'Front', 'Inside', 'Back'])
    .map((role, index) => asset(`${groupId}-${role}`, productName, groupId, index + (emptyExample ? 2 : 1), index ? {} : extra))
}
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} vs ${expected}`)

function assertDetailsInside(group) {
  for (const panel of detailPanelsForGroup(group)) {
    const layout = imageDetailsLayout(panel)
    const bottom = group.y + group.height - (group.details.finish ? 18 : 0)
    assert.ok(layout.y + layout.fields.length * layout.line <= bottom + epsilon)
    if (group.details.accessoryImage) {
      const frame = accessoryFrame(group.details.accessoryImage, layout.accessoryX, layout.bodyY, layout.imageSize, group.details.accessoryCode)
      assert.ok(frame.y + frame.frameHeight <= bottom + epsilon, 'accessory remains above group/finish bottom')
    }
    for (const image of layout.noteImages) {
      assert.ok(image.y - image.captionHeight >= layout.bodyY - epsilon)
      assert.ok(image.y + image.size <= bottom + epsilon, 'note image remains above group/finish bottom')
    }
    assert.ok(layout.noteY + layout.noteLines.length * layout.noteLine <= bottom + epsilon)
  }
}

test('shakers and photo holders compact an unused lower half without shrinking the role artwork', () => {
  for (const product of ['Shaker', '摇摇乐', 'Photocard Holders', '照片夹']) for (const emptyExample of [false, true]) {
    const sources = roles(product, 'holder', emptyExample, { attributes: { QT: '2', Finish: 'Front Side Epoxy' } })
    const [compact] = paginateAssets(sources)
    const group = compact.imageGroups[0]
    const [occupied] = paginateAssets([...sources, asset('extra', product, 'holder', 5)])
    assert.ok(group.height < fullHeight * .65, `${product} should release its unused lower half`)
    close(occupied.imageGroups[0].height, fullHeight, 'the comparison with a lower-row member retains its height')
    for (const item of compact.items) {
      const original = occupied.items.find(candidate => candidate.id === item.id)
      const cell = group.imageCells.find(candidate => candidate.itemId === item.id)
      const originalCell = occupied.imageGroups[0].imageCells.find(candidate => candidate.itemId === item.id)
      close(item.w, original.w, 'role width is preserved')
      close(item.h, original.h, 'role height is preserved')
      close(cell.width, originalCell.width, 'role cell width is preserved')
      close(cell.height, originalCell.height, 'role cell height is preserved')
      assert.ok(item.y + item.h / 2 <= group.y + group.height - 18)
    }
    assertDetailsInside(group)
    const [rearranged] = autoArrangePages([compact], 1, sources, defaultLayoutBounds)
    close(rearranged.imageGroups[0].height, group.height, 'rearranging retains the compact rule')
  }
})

test('released holder space moves later groups upward and avoids another page', () => {
  for (const product of ['Shaker', 'Photocard Holders']) {
    const sources = ['one', 'two', 'three'].flatMap(id => roles(product, id))
    const tail = asset('ordinary', 'Keychains', undefined, undefined)
    const pages = paginateAssets([...sources, tail])
    assert.equal(pages.length, 1)
    const groups = pages[0].imageGroups
    assert.equal(groups.length, 4)
    const first = groups.find(group => group.productGroupId === 'one')
    const second = groups.find(group => group.productGroupId === 'two')
    close(second.y, first.y + first.height + GROUP_GAP, 'following holder starts at the compact group bottom')
    assert.ok(second.y < first.y + fullHeight)
    for (const group of groups) assert.ok(group.y + group.height <= PAPER_HEIGHT - defaultLayoutBounds.bottom + epsilon)
    const fullSources = ['one', 'two', 'three'].flatMap(id => [...roles(product, id), asset(`${id}-extra`, product, id, 5)])
    assert.ok(paginateAssets([...fullSources, tail]).length > pages.length)
  }
})

test('holders keep their full allocation when a lower member or the separate Example row uses it', () => {
  for (const product of ['Shaker', '照片夹']) {
    const portrait = roles(product)
    const [withLowerRow] = paginateAssets([...portrait, asset('extra', product, 'holder', 5)])
    close(withLowerRow.imageGroups[0].height, fullHeight, 'a lower row remains allocated')
    const landscape = portrait.map(source => ({ ...source, width: 120, height: 60, sourceGroupWidthMm: 60, sourceGroupHeightMm: 30 }))
    const [separateExample] = paginateAssets(landscape)
    close(separateExample.imageGroups[0].height, fullHeight, 'Example plus Front/Inside/Back consumes more than half')
    assert.ok(separateExample.items[1].y > separateExample.items[0].y)
  }
})

test('a small accessory can remain inside a compact holder without forcing an unused lower half', () => {
  const src = 'holder-short-accessory.png'
  rememberAccessorySize(src, 200, 80)
  const [page] = paginateAssets(roles('Shaker', 'holder', false, { attributeImages: { 'Accessories Color': src } }))
  const group = page.imageGroups[0]
  assert.ok(group.height < fullHeight * .65)
  assert.equal(group.details.accessoryImage, src)
  assertDetailsInside(group)
})

test('three note images and long text that occupy the lower half remain complete and contained', () => {
  const noteImages = ['Front', 'Back', '孔位'].map(name => ({ name, src: `${name}.png` }))
  const note = '请保留备注文字以及需要检查的工艺信息。'.repeat(24)
  const src = 'holder-tall-accessory.png'
  rememberAccessorySize(src, 60, 200)
  for (const product of ['Shaker', 'Photocard Holders']) for (const extra of [
    { noteImages, attributeImages: { 'Accessories Color': src }, attributes: { QT: '2', 'Accessories Color': '02', Finish: 'Epoxy' } },
    { note, attributes: { QT: '2', Finish: 'Epoxy' } },
    { note, noteImages, attributeImages: { 'Accessories Color': src }, attributes: { QT: '2', 'Accessories Color': '02', Finish: 'Epoxy' } },
  ]) {
    const [page] = paginateAssets(roles(product, 'holder', false, extra))
    const group = page.imageGroups[0]
    close(group.height, fullHeight, 'occupied lower-half detail content prevents compaction')
    const layout = imageDetailsLayout(detailPanelsForGroup(group)[0])
    if (extra.noteImages) assert.equal(layout.noteImages.length, 3)
    if (extra.note) assert.equal(layout.noteLines.join('').replace(/\s/g, ''), note.replace(/\s/g, ''))
    assertDetailsInside(group)
  }
})
