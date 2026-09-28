import test from 'node:test'
import assert from 'node:assert/strict'
import { finishLabel } from '../src/modules/schematic/services/finishLabelService.ts'
import { detailsForAsset } from '../src/modules/schematic/services/assetDetailsService.ts'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { refreshPageAssetDetails } from '../src/modules/schematic/services/automaticArrangementService.ts'
import { pageSvg } from '../src/model.ts'

const stickerAsset = (productName, attributes) => ({
  id: 'sticker', name: 'artwork', productId: 'product-1', productName,
  width: 100, height: 120, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="120"><rect width="100" height="120"/></svg>',
  previewUrl: '', thumbnailUrl: '', attributes,
})

test('only sticker product names prefix the material to the finish', () => {
  for (const productName of ['Custom Stickers', '透明贴纸', 'clear stickers']) {
    const asset = stickerAsset(productName, { Material: ' Vinyl ', 工艺: '1 / Glossy' })
    const original = structuredClone(asset)
    assert.equal(detailsForAsset(asset).finish, 'Vinyl Glossy')
    assert.deepEqual(asset, original)
  }
  assert.equal(detailsForAsset(stickerAsset('Keychains', { Material: 'Acrylic', Finish: 'Epoxy' })).finish, 'Epoxy')
  assert.equal(detailsForAsset(stickerAsset('贴纸', { 材质: '透明', 工艺: '哑光' })).finish, '透明 哑光')
  assert.equal(detailsForAsset(stickerAsset('Stickers', { Material: 'Vinyl' })).finish, 'Vinyl')
  assert.equal(detailsForAsset(stickerAsset('Stickers', { Material: ' ', Finish: 'Glossy' })).finish, 'Glossy')
  assert.equal(detailsForAsset(stickerAsset('Stickers', {})).finish, '')
})

test('sticker material and finish stay combined through arrangement, edits and SVG export', () => {
  const asset = stickerAsset('Stickers', { Material: 'Vinyl', Finish: 'Glossy' })
  const [page] = paginateAssets([asset])
  assert.equal(finishLabel(page.imageGroups[0]).text, 'Vinyl Glossy')
  assert.ok(pageSvg(page, new Map([[asset.id, asset]])).includes('Vinyl Glossy'))
  const updated = { ...asset, attributes: { Material: 'Holographic', Finish: 'Matte' } }
  const refreshed = refreshPageAssetDetails(page, [updated])
  assert.equal(finishLabel(refreshed.imageGroups[0]).text, 'Holographic Matte')
  assert.ok(pageSvg(refreshed, new Map([[updated.id, updated]])).includes('Holographic Matte'))
})

test('long Finish stays one line anchored inside the bottom of the unchanged group', () => {
  const group = { x: 10, y: 20, width: 60, height: 80, details: { finish: 'A very long finish\nwith another process' } }
  const label = finishLabel(group)
  assert.equal(label.text, 'A very long finish with another process')
  assert.equal(label.y, 86)
  assert.equal(label.x + label.width, 66)
  assert.equal(group.height, 80)
  assert.equal(label.height, undefined)
})
