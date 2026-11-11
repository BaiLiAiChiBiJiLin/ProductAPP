import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizePublicProductOptions } from '../src/modules/schematic/services/publicProductOptionService.ts'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService.ts'
import { catalogConfirmationPatch, emptyAttributeDraft, readSelectionDraft } from '../src/modules/schematic/services/attributeDraftService.ts'
import { applyProductAttributePatch } from '../src/modules/schematic/services/productOptionRules.ts'
import { detailsForAsset } from '../src/modules/schematic/services/assetDetailsService.ts'
import { dimensionForItem } from '../src/modules/schematic/services/imageDimensionService.ts'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { pageSvg, pageRasterSvg } from '../src/model.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/public-product-parity.json', import.meta.url)))
const artwork = {
  id: 'artwork', name: 'Test artwork', width: 80, height: 100,
  sourceGroupWidthMm: 40, sourceGroupHeightMm: 50,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect width="80" height="100" fill="#7ea4cc"/></svg>',
  previewUrl: '', thumbnailUrl: '',
}

for (const sample of fixture.cases) {
  test(`${sample.name}: public and existing selections preserve attributes and export equal dimensions/accessories`, () => {
    const [publicProduct] = normalizePublicProductOptions({ categories: [{ products: [sample.public] }] })
    const [existingProduct] = normalizeProductConfigs({ products: [sample.local] })
    const assets = [publicProduct, existingProduct].map((product, index) => {
      const selections = sample.selections[index === 0 ? 'public' : 'local']
      const patch = catalogConfirmationPatch({ ...emptyAttributeDraft(), productId: product.id, attributes: selections }, product)
      const confirmed = applyProductAttributePatch(artwork, patch)
      assert.deepEqual(confirmed.attributes, selections)
      assert.equal(confirmed.attributeImages['Accessories Color'], 'https://fakestar-oss.oss-us-west-1.aliyuncs.com/uploads/1778827283218-24.png')
      assert.deepEqual(readSelectionDraft([confirmed]).attributes, selections)
      // finish_matching's Rust regression verifies these persisted process
      // names. This stage consumes the asset returned by the save command.
      return { ...confirmed, attributes: { ...confirmed.attributes, Finish: sample.finish } }
    })
    assert.equal(dimensionForItem(assets[0], {}).label, '63.5 mm')
    assert.deepEqual(detailsForAsset(assets[0]), detailsForAsset(assets[1]))
    assert.equal(detailsForAsset(assets[0]).accessoryCode, '24')
    const pages = assets.map((asset, index) => paginateAssets([asset], 12, undefined, [[publicProduct], [existingProduct]][index])[0])
    assert.deepEqual(pages[0].items, pages[1].items)
    assert.deepEqual(pages[0].imageGroups.map(group => group.details), pages[1].imageGroups.map(group => group.details))
    for (const exporter of [pageSvg, pageRasterSvg]) {
      const exported = pages.map((page, index) => exporter(page, new Map([[assets[index].id, assets[index]]])))
      assert.equal(exported[0], exported[1])
      assert.match(exported[0], /Size: 63\.5 mm/)
      assert.match(exported[0], /QT: 12/)
      assert.ok(exported[0].includes(sample.finish))
      assert.ok(exported[0].includes(assets[0].attributeImages['Accessories Color']))
    }
  })
}

test('size units accept public inch typography without changing the source attribute', () => {
  for (const size of ['1.5 ”', '1.5“', '1.5″', '1.5"', '1.5 in', '1.5 英寸']) {
    const asset = { ...artwork, attributes: { Size: size } }
    assert.equal(dimensionForItem(asset, {}).label, '38.1 mm', size)
    assert.equal(asset.attributes.Size, size)
  }
})
