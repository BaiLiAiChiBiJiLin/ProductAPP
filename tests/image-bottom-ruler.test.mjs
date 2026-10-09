import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { dimensionForItem, dimensionGroups, imageDimensionMarkerLayout } from '../src/modules/schematic/services/imageDimensionService.ts'
import { pageRasterSvg } from '../src/model.ts'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { groupForDimensionDisplay, pageForDimensionDisplay } from '../src/modules/schematic/services/dimensionDisplayService.ts'

const dom = new JSDOM('')
globalThis.DOMParser = dom.window.DOMParser
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="160" viewBox="0 0 100 160"><image id="art" x="10" y="20" width="80" height="120" href="art.png"/><path d="M0 0H100V160H0Z" fill="none" stroke="red"/></svg>'
const source = { id: 'a', name: 'art', productId: 'p', productName: '串串挂件', width: 100, height: 160, sourceGroupWidthMm: 25, sourceGroupHeightMm: 40, svg, sourceImages: [{ nodeId: 'art', widthPx: 80, heightPx: 120, format: 'PNG' }] }
const image = { id: 'i', assetId: 'a', x: 150, y: 130, w: 100, h: 160, rotation: 0, rulerHeight: true, rulerWidth: false }
function markers(asset = source, patch = {}, withLastMember = true) {
  const item = { ...image, ...patch }
  const page = { id: 1, name: 'test', items: [item], imageGroups: [{ id: 'g', itemIds: ['i'], x: 50, y: 0, width: 250, height: 400 }] }
  const assets = new Map([['a', asset]])
  if (withLastMember) {
    page.items.push({ ...image, id: 'last', assetId: 'last', suppressRuler: true })
    page.imageGroups[0].itemIds.push('last')
    page.imageGroups[0].imageCells = page.items.map(item => ({ itemId: item.id, x: 50, y: 0, width: 125, height: 400 }))
    assets.set('last', { ...asset, id: 'last' })
  }
  return { page, assets, markers: dimensionGroups(page).map(group => imageDimensionMarkerLayout(group, page, assets)) }
}

test('nonlast chain height rulers retain the top and measured value but end at the embedded picture bottom', () => {
  for (const productName of ['串串挂件', 'Chained Charms']) {
    const { markers: [marker] } = markers({ ...source, productName })
    assert.equal(marker.y1, 50)
    assert.equal(marker.y2, 190)
    assert.equal(marker.imageEnd, 190)
    assert.equal(marker.label, '40.0 mm')
    assert.equal(marker.textY, 120)
    assert.equal(marker.extension[1][1], 190)
  }
})

test('ordinary products, image-free SVGs and width rulers keep their original endpoints', () => {
  for (const asset of [{ ...source, productName: 'Keychains' }, { ...source, svg: '<svg/>', sourceImages: [] }]) {
    assert.equal(markers(asset).markers[0].y2, 210)
  }
  const { markers: [width, height] } = markers(source, { rulerWidth: true })
  assert.equal(width.x1, 100)
  assert.equal(width.x2, 200)
  assert.equal(height.y2, 190)
})

test('every product shifts its left ruler two units on canvas and export without moving artwork', () => {
  let sharedX
  for (const productName of ['Standees', 'Keychains', '串串', 'Photocard Holders', 'Shaker', 'Stickers', '贴纸', '']) {
    const { page, assets, markers: [marker] } = markers({ ...source, productName }, { x: 100 })
    sharedX ??= marker.x1
    assert.equal(marker.x1, sharedX, `${productName}: left clearance must not depend on the product`)
    assert.equal(marker.textX, page.imageGroups[0].x + 8 - 2)
    assert.equal(marker.textX, marker.x1, 'label and arrows move together')
    const document = new dom.window.DOMParser().parseFromString(pageRasterSvg(page, assets), 'image/svg+xml')
    const exported = document.querySelector('[data-printflow-dimension] text')
    assert.equal(Number(exported.getAttribute('x')), marker.textX)
    assert.equal(exported.textContent, marker.label)
    assert.equal(page.items[0].x, 100, 'ruler clearance does not move the artwork')
  }
})

test('picture endpoint follows movement, display scale and custom ranges without changing source dimensions', () => {
  const before = JSON.stringify(source)
  const { markers: [marker] } = markers(source, { y: 180, w: 150, h: 240, rulerHeightRange: [0.1, 0.9] })
  assert.equal(marker.imageStart, 60)
  assert.equal(marker.imageEnd, 270)
  assert.equal(marker.y1, 81)
  assert.equal(marker.y2, 249)
  assert.equal(marker.label, '40.0 mm')
  assert.equal(JSON.stringify(source), before)
})

test('an extended picture-bottom ruler survives saved state, movement, scaling and SVG export', () => {
  const saved = JSON.parse(JSON.stringify({ rulerHeightRange: [0, 160 / 140] }))
  const { page, assets, markers: [marker] } = markers(source, { ...saved, y: 180, w: 150, h: 240 })
  assert.equal(marker.y1, 60)
  assert.equal(marker.y2, 300)
  assert.equal(marker.label, '40.0 mm')
  const document = new dom.window.DOMParser().parseFromString(pageRasterSvg(page, assets), 'image/svg+xml')
  assert.equal(document.querySelector('[data-printflow-dimension]').querySelectorAll('line')[1].getAttribute('y1'), '300')
})

test('export uses the same picture-bottom ruler geometry and unchanged size text', () => {
  const { page, assets } = markers()
  const document = new dom.window.DOMParser().parseFromString(pageRasterSvg(page, assets), 'image/svg+xml')
  const marker = document.querySelector('[data-printflow-dimension]')
  assert.equal(marker.querySelectorAll('line')[1].getAttribute('y1'), '190')
  assert.equal(marker.querySelector('text').textContent, '40.0 mm')
})

test('source position includes nonzero viewBox, ancestor transforms and fitted raster size', () => {
  const transformed = { ...source, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 200 100 160"><g transform="translate(100 200)"><g transform="translate(10 20) scale(2)"><image id="art" width="40" height="60" href="art.png"/></g></g></svg>' }
  assert.equal(markers(transformed).markers[0].y2, 190)
  // A square raster is letterboxed inside the image's 80 x 120 rectangle.
  const letterboxed = { ...source, sourceImages: [{ nodeId: 'art', widthPx: 80, heightPx: 80, format: 'PNG' }] }
  assert.equal(markers(letterboxed).markers[0].y2, 170)
  const rotated = { ...source, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 160"><g transform="translate(90 20) rotate(90)"><image width="110" height="60" preserveAspectRatio="none" href="art.png"/></g></svg>' }
  assert.equal(markers(rotated).markers[0].y2, 180)
})

test('front and derived back use their own lowest picture, ignoring definitions and hidden pictures', () => {
  const multi = { ...source, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 160"><defs><image width="100" height="160" href="unused.png"/></defs><image id="back" y="10" width="80" height="90" href="back.png"/><image id="front" y="20" width="80" height="120" href="front.png"/><g display="none"><image width="100" height="160" href="hidden.png"/></g></svg>' }
  assert.equal(markers(multi).markers[0].y2, 190)
  const backSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 160"><image id="back" y="10" width="80" height="90" href="back.png"/></svg>'
  assert.equal(markers(multi, { backSvg, mirrorX: true, derivedFrom: 'front' }).markers[0].y2, 150)
  // A derived back may have its own cropped viewBox.
  assert.equal(markers(multi, { backSvg: backSvg.replace('0 0 100 160', '0 10 80 90') }).markers[0].y2, 186.25)
})

test('legacy image rectangles still work without source-image metadata; malformed SVG safely retains the ruler', () => {
  assert.equal(markers({ ...source, sourceImages: undefined }).markers[0].y2, 190)
  assert.equal(markers({ ...source, svg: '<svg><image' }).markers[0].y2, 210)
  const mm = { ...source, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="160"><image width="20mm" height="30mm" preserveAspectRatio="none" href="a.png"/></svg>' }
  assert.ok(Math.abs(markers(mm).markers[0].y2 - (50 + 30 * 96 / 25.4)) < 0.0001)
})

test('each chain keeps its last source SVG full height, including derived backs, regardless of input order', () => {
  const make = (id, group, position) => ({ ...source, id, productName: '串串挂件', productGroupId: group,
    productGroupPosition: position, attributes: { 'Print Option': 'Double Sided Different Design' } })
  const entries = [make('last-a', 'chain-a', 3), make('first-a', 'chain-a', 1), make('only-b', 'chain-b', 1), make('middle-a', 'chain-a', 2)]
  const assets = new Map(entries.map(asset => [asset.id, asset]))
  const pages = paginateAssets(entries)
  for (const page of pages) {
    // Page item storage order must not determine which member is last.
    page.items.reverse()
    for (const item of page.items) { item.suppressRuler = false; item.rulerHeight = true; item.rulerWidth = false }
    const svgDocument = new dom.window.DOMParser().parseFromString(pageRasterSvg(page, assets), 'image/svg+xml')
    for (const group of dimensionGroups(page)) {
      const marker = imageDimensionMarkerLayout(group, page, assets)
      if (!marker) continue
      const item = page.items.find(item => item.id === marker.itemId)
      const top = item.y - item.h / 2, bottom = item.y + item.h / 2
      const isLast = ['last-a', 'only-b'].includes(item.assetId)
      assert.ok(Math.abs(marker.y1 - top) < 1e-6)
      assert.ok(Math.abs(marker.imageEnd - (isLast ? bottom : top + item.h * 140 / 160)) < 1e-6, item.id)
      assert.ok(Math.abs(marker.imageStart + (marker.imageEnd - marker.imageStart) * marker.rangeMax - bottom) < 1e-6)
      const exported = svgDocument.querySelector(`[data-item-id="${item.id}"]`)
      assert.equal(Number(exported.querySelectorAll('line')[1].getAttribute('y1')), marker.y2)
    }
  }
})

test('legacy chain order comes from the group rather than dragged positions; a lone chain SVG remains full height', () => {
  assert.equal(markers({ ...source, productName: '串串挂件' }, {}, false).markers[0].y2, 210)
  const entries = ['first', 'last'].map(id => ({ ...source, id, productName: '串串挂件', productGroupId: 'legacy' }))
  const assets = new Map(entries.map(asset => [asset.id, asset]).reverse())
  const items = entries.map(asset => ({ ...image, id: asset.id, assetId: asset.id }))
  items[0].y += 30
  const page = { id: 1, name: 'legacy', items: items.toReversed(), imageGroups: [{ id: 'legacy', itemIds: ['first', 'last'], x: 50, y: 0, width: 500, height: 400 }] }
  for (const group of dimensionGroups(page)) {
    const marker = imageDimensionMarkerLayout(group, page, assets)
    assert.equal(marker.imageEnd, marker.itemId === 'first' ? 220 : 210)
  }
})

test('standee main height subtracts 3.4 mm and maps to the ruler regardless of embedded picture bounds', () => {
  for (const productName of ['亚克力立牌', 'Clear Acrylic Standees', '串串立牌']) {
    for (const artwork of [svg, '<svg/>']) {
      const asset = { ...source, productName, svg: artwork }
      const before = JSON.stringify(asset)
      const { markers: [marker] } = markers(asset)
      assert.equal(marker.label, '36.6 mm')
      assert.equal(marker.y1, 50)
      assert.ok(Math.abs(marker.y2 - (50 + 160 * 36.6 / 40)) < 1e-7)
      assert.equal(JSON.stringify(asset), before)
    }
  }
})

test('standee subtraction applies before precision and unit conversion; width and base height stay original', () => {
  const asset = { ...source, productName: 'Standees', attributes: { Size: '4.019 cm' } }
  assert.equal(dimensionForItem(asset, {}, 'height', 'default', 2).label, '36.79 mm')
  assert.equal(dimensionForItem(asset, { rulerUnit: 'cm' }, 'height', 'default', 3).label, '3.679 cm')
  assert.equal(dimensionForItem(asset, { rulerUnit: 'in' }, 'height', 'round', 3).label, '1.448 in')
  assert.equal(dimensionForItem(asset, {}, 'height', 'default', 0).label, '36 mm')
  assert.equal(dimensionForItem(asset, {}, 'height', 'round', 0).label, '37 mm')
  const { markers: [width] } = markers(asset, { rulerWidth: true })
  assert.equal(width.label, '25.1 mm')
  assert.equal(width.x2, 200)
  const { markers: [base] } = markers(asset, { caption: 'base' })
  assert.equal(base.label, '40.1 mm')
  assert.equal(base.y2, 210)
})

test('standee adjusted default and extended ranges survive display scaling, saving and export', () => {
  const asset = { ...source, productName: 'Standees' }
  for (const range of [undefined, [0, 40 / 36.6]]) {
    const { page, assets, markers: [marker] } = markers(asset, { y: 180, w: 150, h: 240, rulerHeightRange: range })
    assert.equal(marker.y1, 60)
    assert.ok(Math.abs(marker.y2 - (range ? 300 : 60 + 240 * 36.6 / 40)) < 1e-7)
    const restored = JSON.parse(JSON.stringify(page))
    const document = new dom.window.DOMParser().parseFromString(pageRasterSvg(restored, assets), 'image/svg+xml')
    const exported = document.querySelector('[data-printflow-dimension]')
    assert.equal(exported.querySelector('text').textContent, '36.6 mm')
    assert.ok(Math.abs(Number(exported.querySelectorAll('line')[1].getAttribute('y1')) - marker.y2) < 1e-7)
  }
})

test('generated standee groups share the adjusted Size and ruler; even a portrait base is exempt', () => {
  const entries = ['main', 'base'].map((id, index) => ({ ...source, id, productName: '立牌', productGroupId: 'standee', productGroupPosition: index + 1 }))
  const before = JSON.stringify(entries)
  const assets = new Map(entries.map(asset => [asset.id, asset]))
  const [page] = paginateAssets(entries)
  assert.equal(page.imageGroups[0].details.size, '36.6 mm')
  const values = dimensionGroups(page).map(group => imageDimensionMarkerLayout(group, page, assets))
  const main = values.find(value => value.itemId === 'item-main')
  const base = values.find(value => value.itemId === 'item-base')
  assert.equal(main.label, '36.6 mm')
  assert.equal(base.label, '40.0 mm')
  const baseItem = page.items.find(item => item.id === 'item-base')
  assert.ok(Math.abs(base.imageEnd - (baseItem.y + baseItem.h / 2)) < 1e-7)
  assert.equal(JSON.stringify(entries), before)
})

test('saved standee default Size refreshes on canvas and export without repeatedly subtracting or replacing custom text', () => {
  const { page, assets } = markers({ ...source, productName: 'Standees' })
  const group = page.imageGroups[0]
  group.details = { size: '40.0 mm', qt: '', finish: '' }
  const display = groupForDimensionDisplay(group, page, assets)
  assert.equal(display.details.size, '36.6 mm')
  const updated = pageForDimensionDisplay(page, assets)
  assert.equal(updated.imageGroups[0].details.size, '36.6 mm')
  assert.equal(pageForDimensionDisplay(updated, assets).imageGroups[0].details.size, '36.6 mm')
  const document = new dom.window.DOMParser().parseFromString(pageRasterSvg(page, assets), 'image/svg+xml')
  assert.ok([...document.querySelectorAll('text')].some(node => node.textContent === 'Size: 36.6 mm'))
  assert.equal(group.details.size, '40.0 mm')
  page.items[1].caption = 'base'
  assert.equal(groupForDimensionDisplay(group, page, assets, ['last']).details.size, '40.0 mm')
  group.details.size = 'custom: 40 mm'
  assert.equal(groupForDimensionDisplay(group, page, assets).details.size, 'custom: 40 mm')
  assert.equal(pageForDimensionDisplay(page, assets).imageGroups[0].details.size, 'custom: 40 mm')
})
