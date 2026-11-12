import test from 'node:test'
import assert from 'node:assert/strict'
import { finishLabel } from '../src/modules/schematic/services/finishLabelService.ts'
import { detailsForAsset, setFinishLookup } from '../src/modules/schematic/services/assetDetailsService.ts'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { refreshPageAssetDetails } from '../src/modules/schematic/services/automaticArrangementService.ts'
import { pageSvg, pageRasterSvg } from '../src/model.ts'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'

const stickerAsset = (productName, attributes) => ({
  id: 'sticker', name: 'artwork', productId: 'product-1', productName,
  width: 100, height: 120, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="120"><rect width="100" height="120"/></svg>',
  previewUrl: '', thumbnailUrl: '', attributes,
})

test('sticker material keeps the legacy footer spacing and other materials remain visible', () => {
  for (const productName of ['Custom Stickers', '透明贴纸', 'clear stickers']) {
    const asset = stickerAsset(productName, { Material: ' Vinyl ', 工艺: '1 / Glossy' })
    const original = structuredClone(asset)
    assert.equal(detailsForAsset(asset).finish, 'Vinyl Glossy')
    assert.deepEqual(asset, original)
  }
  assert.equal(detailsForAsset(stickerAsset('Keychains', { Material: 'Acrylic', Finish: 'Epoxy' })).finish, 'Acrylic\nEpoxy')
  assert.equal(detailsForAsset(stickerAsset('贴纸', { 材质: '透明', 工艺: '哑光' })).finish, '透明 哑光')
  assert.equal(detailsForAsset(stickerAsset('Stickers', { Material: 'Vinyl' })).finish, 'Vinyl')
  assert.equal(detailsForAsset(stickerAsset('Stickers', { Material: ' ', Finish: 'Glossy' })).finish, 'Glossy')
  assert.equal(detailsForAsset(stickerAsset('Stickers', {})).finish, '')
})

test('process, film and material attributes share the red lower-right label', () => {
  const asset = stickerAsset('Keychains', {
    Technique: 'Front side epoxy',
    'Holo Film': 'Star holographic',
    Material: 'Acrylic',
    Finish: 'Glossy',
  })
  const details = detailsForAsset(asset)
  assert.equal(details.finish, 'Front Side Epoxy\nStar Holographic\nAcrylic\nGlossy')
  const layout = imageDetailsLayout({ x: 0, y: 0, width: 120, height: 120, details })
  assert.equal(layout.fields.some(field => field.key.startsWith('attribute-')), false)
  const label = finishLabel({ x: 0, y: 0, width: 120, height: 120, details })
  assert.deepEqual(label.lines, ['Front Side Epoxy', 'Star Holographic', 'Acrylic', 'Glossy'])
  assert.equal(label.text, details.finish)
  const [page] = paginateAssets([asset])
  const svg = pageSvg(page, new Map([[asset.id, asset]]))
  for (const value of label.lines) assert.match(svg, new RegExp(`>${value}</text>`))
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
  assert.equal(label.text, 'A very long finish\nwith another process')
  assert.equal(label.y, 75)
  assert.equal(label.x + label.width, 66)
  assert.equal(group.height, 80)
  assert.equal(label.height, 21)
})

test('no additional technique is hidden without removing saved attributes or real sticker material', () => {
  for (const key of ['工艺', 'Finish', '表面']) {
    for (const value of ['No Additional Technique', ' no ADDITIONAL technique ', '1 / No Additional Technique']) {
      const asset = stickerAsset('Keychains', { [key]: value, QT: '2' })
      const original = structuredClone(asset)
      const [page] = paginateAssets([asset])
      assert.equal(detailsForAsset(asset).finish, '')
      assert.equal(finishLabel(page.imageGroups[0]).text, '')
      for (const source of [pageSvg(page, new Map([[asset.id, asset]])), pageRasterSvg(page, new Map([[asset.id, asset]]))]) {
        assert.doesNotMatch(source, /No Additional Technique/i)
        assert.match(source, /QT: 2/)
      }
      assert.deepEqual(asset, original)
    }
  }
  assert.equal(detailsForAsset(stickerAsset('Stickers', { Material: 'Vinyl', Finish: 'No Additional Technique' })).finish, 'Vinyl')
  assert.equal(detailsForAsset(stickerAsset('Keychains', { 工艺: 'No Additional Technique', Finish: 'Old Epoxy' })).finish, '')
  assert.equal(detailsForAsset(stickerAsset('Keychains', { Finish: 'No Additional Technique Plus' })).finish, 'No Additional Technique Plus')
})

test('canonical finish names from the cache and product options follow the same visibility rule', () => {
  const asset = stickerAsset('Keychains', { 工艺: '无附加工艺' })
  setFinishLookup(new Map([['无附加工艺', 'No Additional Technique']]))
  try { assert.equal(detailsForAsset(asset).finish, '') } finally { setFinishLookup(new Map()) }
  assert.equal(detailsForAsset(asset, [{ id: asset.productId, options: [{ name: 'Finish', values: [{ name: 'No Additional Technique', label: '无附加工艺' }] }] }]).finish, '')
})

test('saved review labels hide the default in preview and both exports without blank footer space', () => {
  const asset = stickerAsset('Keychains', {})
  const [page] = paginateAssets([asset])
  const group = page.imageGroups[0]
  const originalLayout = imageDetailsLayout(group)
  group.details.finish = 'No Additional Technique'
  assert.equal(finishLabel(group).text, '')
  assert.deepEqual(imageDetailsLayout(group), originalLayout)
  for (const source of [pageSvg(page, new Map([[asset.id, asset]])), pageRasterSvg(page, new Map([[asset.id, asset]]))]) {
    assert.doesNotMatch(source, /No Additional Technique/)
  }
  group.details.finish = 'Vinyl No Additional Technique'
  assert.equal(finishLabel(group).text, 'Vinyl')
  group.details.finish = 'No Additional Technique / Epoxy'
  assert.equal(finishLabel(group).text, 'Epoxy')
  group.detailGroups = [{ itemIds: ['one'], details: { finish: 'No Additional Technique' } }, { itemIds: ['two'], details: { finish: 'Epoxy' } }]
  assert.equal(finishLabel(group).text, 'Epoxy')
})
