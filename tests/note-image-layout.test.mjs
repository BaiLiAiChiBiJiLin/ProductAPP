import test from 'node:test'
import assert from 'node:assert/strict'
import { detailsForAsset } from '../src/modules/schematic/services/assetDetailsService.ts'
import { imageDetailsLayout, sizeLabelWidth } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'
import { groupBackgroundsSvg } from '../src/modules/schematic/services/groupBackgroundService.ts'
import { buildProductGroupDetails, detailPanelsForGroup } from '../src/modules/schematic/arrangement/productGroupDetails.ts'
import { accessoryFrame, rememberAccessorySize } from '../src/modules/schematic/services/accessoryFrameService.ts'
import { DETAIL_LABEL_FONT_SIZE, defaultLayoutBounds, pageRasterSvg, pageSvg } from '../src/model.ts'
import { JSDOM } from 'jsdom'

const images = [{ src: 'front.png', name: '正面 <参考>' }, { src: 'back.png', name: '' }, { src: 'hole.png', name: '孔位' }]
const asset = { id: 'a', productId: 'p', width: 100, height: 100, attributes: { QT: '2' }, note: '生产备注', noteImage: 'front.png', noteImages: images }
const makeGroup = details => ({ id: 'group', itemIds: ['a'], x: 10, y: 20, width: 300, height: 160, details })

test('all note images and optional names reach the production details and exported SVG', () => {
  const details = detailsForAsset(asset)
  assert.deepEqual(details.noteImages, images)
  const group = makeGroup(details)
  const layout = imageDetailsLayout(group)
  assert.equal(layout.noteImages.length, 3)
  layout.noteImages.forEach((image, index) => {
    assert.ok(image.size > 0)
    assert.ok(image.x >= layout.noteX)
    assert.ok(image.x + image.size <= layout.noteX + layout.noteWidth)
    assert.ok(image.y - image.captionHeight >= layout.bodyY)
    assert.ok(image.y + image.size <= layout.noteY)
    if (index) assert.ok(image.y - image.captionHeight > layout.noteImages[index - 1].y + layout.noteImages[index - 1].size)
  })
  const svg = groupBackgroundsSvg({ items: [{ id: 'a' }], imageGroups: [group] })
  assert.equal((svg.match(/data-printflow-note="true"/g) ?? []).length, 3)
  assert.equal((svg.match(/data-printflow-note-name="true"/g) ?? []).length, 2)
  for (const image of images) assert.ok(svg.includes(`href="${image.src}"`))
  assert.ok(svg.includes('正面 &lt;参考&gt;'))
  const document = new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`, { contentType: 'image/svg+xml' }).window.document
  for (const picture of document.querySelectorAll('[data-printflow-note-group]')) {
    const image = picture.querySelector('image')
    const name = picture.querySelector('text')
    if (name) {
      assert.equal(name.getAttribute('fill'), '#ff4d4f')
      assert.ok(Number(name.getAttribute('y')) < Number(image.getAttribute('y')))
    }
  }
})

test('legacy single unnamed note maximizes its box without reserving a caption', () => {
  const group = makeGroup({ size: '40mm', qt: '1', finish: '', noteImage: 'old.png' })
  const layout = imageDetailsLayout(group)
  assert.deepEqual(layout.noteImages, [{ src: 'old.png', name: '', x: layout.noteX + (layout.noteWidth - layout.noteImageSize) / 2, y: layout.noteImageY, size: layout.noteImageSize, captionHeight: 0, captionFontSize: 0 }])
  const cleared = imageDetailsLayout(makeGroup({ ...group.details, noteImages: [] }))
  assert.equal(cleared.noteImages.length, 0)
})

test('accessory stays left of two or three vertically stacked note images inside the details area', () => {
  rememberAccessorySize('accessory.png', 100, 300)
  for (const width of [150, 300]) for (const count of [1, 2, 3]) {
    const group = { ...makeGroup({ size: '59.700 mm', qt: '123', finish: 'Front Side Epoxy', accessoryImage: 'accessory.png', accessoryCode: '02', noteImages: images.slice(0, count) }), width }
    const layout = imageDetailsLayout(group)
    const frame = accessoryFrame('accessory.png', layout.accessoryX, layout.bodyY, layout.imageSize, '02')
    assert.ok(frame.x >= layout.x - 1e-8)
    assert.ok(frame.y >= layout.bodyY - 1e-8)
    assert.ok(frame.y + frame.frameHeight <= layout.noteY)
    for (const image of layout.noteImages) {
      assert.ok(image.x > frame.x + frame.frameWidth)
      assert.ok(image.x + image.size <= layout.x + layout.width + 1e-8)
      assert.ok(image.y - image.captionHeight >= layout.bodyY)
      assert.ok(image.y + image.size <= group.y + group.height - 18)
    }
    assert.ok(layout.noteImages.every((image, i, list) => i === 0 || image.y - image.captionHeight > list[i - 1].y + list[i - 1].size))
  }
})

test('notes remain complete above Finish while every title and image stays above the text', () => {
  const note = '请保留所有长备注文字及工艺说明。'.repeat(25) + ' LongUnbrokenProductionCode'.repeat(12)
  const group = makeGroup({ size: '40 mm', qt: '2', finish: 'Epoxy', note, noteImages: images, accessoryImage: 'accessory.png', accessoryCode: '02' })
  const layout = imageDetailsLayout(group)
  assert.equal(layout.noteLines.join('').replace(/\s/g, ''), note.replace(/\s/g, ''))
  assert.ok(layout.noteY + layout.noteLines.length * layout.noteLine <= group.y + group.height - 18)
  for (const image of layout.noteImages) assert.ok(image.y + image.size <= layout.noteY - 2 + 1e-8)
  for (const value of layout.noteLines) {
    const measured = [...value].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : .6), 0) * layout.noteFontSize
    assert.ok(measured <= layout.noteWidth + 1e-8)
  }
})

test('short standee details stay above the base while the row background retains its full height', () => {
  const group = { ...makeGroup({ size: '153.0 mm', qt: '2', finish: 'Epoxy', noteImages: images.slice(0, 2) }), height: 240, backgroundHeight: 240, detailsHeight: 90 }
  const panel = detailPanelsForGroup(group)[0]
  const layout = imageDetailsLayout(panel)
  for (const picture of layout.noteImages) assert.ok(picture.y + picture.size <= group.y + group.detailsHeight)
  const svg = groupBackgroundsSvg({ items: [{ id: 'a' }], imageGroups: [group] })
  const document = new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`, { contentType: 'image/svg+xml' }).window.document
  assert.equal(document.querySelector('[data-group-background]').getAttribute('height'), '240')
  for (const picture of document.querySelectorAll('[data-printflow-note]')) assert.ok(Number(picture.getAttribute('y')) + Number(picture.getAttribute('height')) <= group.y + group.detailsHeight)
})

test('Size and QT keep stable edit keys and share normal single-line typography in narrow columns', () => {
  const group = { ...makeGroup({ size: '1234.567890 mm', qt: '123456789', finish: '', fields: [{ key: 'custom', text: 'Custom' }] }), width: 150 }
  const layout = imageDetailsLayout(group)
  assert.equal(layout.fields.filter(field => field.key === 'qt').length, 1)
  assert.ok(layout.fields.every(field => !field.key.startsWith('qt-')))
  assert.ok(layout.fontSize <= DETAIL_LABEL_FONT_SIZE)
  assert.ok(sizeLabelWidth(group.details.size, layout.fontSize) <= layout.width + 1e-8)
  const document = new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg">${groupBackgroundsSvg({ items: [{ id: 'a' }], imageGroups: [group] })}</svg>`, { contentType: 'image/svg+xml' }).window.document
  const fields = [...document.querySelectorAll('text')]
  const size = fields.find(node => node.textContent.startsWith('Size:'))
  const qt = fields.find(node => node.textContent.startsWith('QT:'))
  assert.equal(size.textContent, 'Size: 1234.567890 mm')
  assert.equal(qt.textContent, 'QT: 123456789')
  assert.equal(size.getAttribute('font-size'), qt.getAttribute('font-size'))
  assert.equal(size.getAttribute('font-weight'), '400')
  assert.equal(qt.getAttribute('font-weight'), '400')
  assert.equal(fields.find(node => node.textContent === 'Custom').getAttribute('font-weight'), '700')
})

test('saved note and accessory moves and scales export around the same full-block centers', () => {
  const group = makeGroup({ size: '40 mm', qt: '2', finish: '', noteImages: images.slice(0, 2), accessoryImage: 'accessory.png', accessoryCode: '02' })
  const layout = imageDetailsLayout(group)
  const visual = new Map([['group:note', { scale: 1.2, x: 3, y: -4 }], ['group:note:1', { scale: .8, x: -2, y: 5 }], ['group:accessory', { scale: 1.3, x: 4, y: 2 }]])
  const picture = { id: 'a', assetId: 'a', x: 20, y: 30, w: 10, h: 10, rotation: 0 }
  const page = { id: 1, name: 'Page', items: [picture], imageGroups: [group] }
  const map = new Map([['a', { ...asset, svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', previewUrl: '', thumbnailUrl: '' }]])
  for (const svg of [pageSvg(page, map, {}, 1, undefined, defaultLayoutBounds, visual), pageRasterSvg(page, map, {}, 1, undefined, undefined, defaultLayoutBounds, visual)]) {
    const document = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document
    layout.noteImages.forEach((image, index) => {
      const key = index === 0 ? 'group:note' : `group:note:${index}`
      const current = visual.get(key)
      const cx = image.x + image.size / 2, cy = image.y + (image.size - image.captionHeight) / 2
      const node = document.querySelector(`[data-printflow-note-group="${key}"]`)
      assert.equal(node.getAttribute('transform'), `translate(${cx + current.x} ${cy + current.y}) scale(${current.scale}) translate(${-cx} ${-cy})`)
      assert.ok(node.querySelector('image'))
      if (image.name) assert.ok(node.querySelector('text'))
    })
    const frame = accessoryFrame('accessory.png', layout.accessoryX, layout.bodyY, layout.imageSize, '02')
    const cx = frame.x + frame.frameWidth / 2, cy = frame.y + frame.frameHeight / 2
    const current = visual.get('group:accessory')
    assert.equal(document.querySelector('[data-printflow-accessory-group]').getAttribute('transform'), `translate(${cx + current.x} ${cy + current.y}) scale(${current.scale}) translate(${-cx} ${-cy})`)
  }
})

test('product group details only combine members when every note source and name matches', () => {
  const assets = [asset, { ...asset, id: 'b' }, { ...asset, id: 'c', noteImages: [images[0], { ...images[1], src: 'other.png' }, images[2]] }, { ...asset, id: 'd', noteImages: [images[0], images[1], { ...images[2], name: '另一说明' }] }]
  const panels = buildProductGroupDetails(assets.map(a => ({ id: a.id, assetId: a.id })), new Map(assets.map(a => [a.id, a])))
  assert.equal(panels.length, 3)
  assert.deepEqual(panels[0].itemIds, ['a', 'b'])
  assert.deepEqual(panels[1].itemIds, ['c'])
  assert.deepEqual(panels[2].itemIds, ['d'])
})
