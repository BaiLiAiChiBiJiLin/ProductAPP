import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService.ts'
import { availableOptionValues, commonSelectionValues, dependentOptionNames, applyAttributeValues, applyProductAttributePatch } from '../src/modules/schematic/services/productOptionRules.ts'

const [product] = normalizeProductConfigs({ products: [{
  productId: 'keychain', title: 'Clear Acrylic Keychains', productOptions: [
    { name: 'Accessories Style', labelZh: '配件样式', values: [
      { name: 'U style', labelZh: 'U形扣', image: 'https://example.test/u.jpg' },
      { name: 'Star Hook Clasp', labelZh: '星形扣', image: 'https://example.test/star.jpg' },
    ] },
    { name: 'Accessories Color', labelZh: '配件颜色', linkedParent: 'Accessories Style', values: [
      { name: 'Star Hook Clasp-9', labelZh: '星形扣-9', parentValues: ['Star Hook Clasp'], image: 'https://example.test/star-9.png' },
      { name: 'Star Hook Clasp-9', labelZh: '星形扣-9', parentValues: ['Star Hook Clasp'], image: 'https://example.test/star-9.png' },
      { name: 'U style-78', labelZh: 'U形扣-78', parentValues: ['U style'], image: 'https://example.test/u-78.png' },
      { name: 'hidden', parentValues: ['U style'], hidden: true },
      { name: 'deleted', parentValues: ['U style'], deleted: true },
    ] },
    { name: 'Finish', linkedParent: 'Accessories Color', values: [{ name: 'matte', parentValues: ['Star Hook Clasp-9'] }] },
    { name: 'Size', image: 'https://example.test/size.png', values: ['1', '2'] },
  ],
}] })
const color = product.options.find(option => option.name === 'Accessories Color')

test('colors follow the selected accessory style and duplicate values appear once', () => {
  assert.deepEqual(availableOptionValues(color, {}), [])
  const u = availableOptionValues(color, { 'Accessories Style': '  U STYLE ' })
  assert.deepEqual(u.map(value => value.label), ['U形扣-78'])
  assert.equal(u[0].image, 'https://example.test/u-78.png')
  const star = availableOptionValues(color, { 'Accessories Style': 'Star Hook Clasp' })
  assert.deepEqual(star.map(value => value.name), ['Star Hook Clasp-9'])
  assert.equal(product.options.find(option => option.name === 'Size').image, 'https://example.test/size.png')
})

test('isHidden flags remove hidden products options and values from existing-product dropdowns', () => {
  const [visibleProduct] = normalizeProductConfigs({ products: [{
    productId: 'hidden-product', title: 'Hidden product', isHidden: true, productOptions: [{ name: 'Hidden', values: [{ name: 'hidden' }] }],
  }, {
    productId: 'visibility', title: 'Visibility test', productOptions: [
      { name: 'Hidden option', isHidden: 'true', values: [{ name: 'should-not-render' }] },
      { name: 'Hidden numeric option', hidden: 1, values: [{ name: 'should-not-render' }] },
      { name: 'Visible option', values: [
        { name: 'keep', isHidden: 'false' },
        { name: 'remove-string', isHidden: '1' },
        { name: 'remove-number', hidden: 1 },
        { name: 'remove-editor', showInEditor: 'false' },
      ] },
    ],
  }] })
  assert.equal(visibleProduct.id, 'visibility')
  assert.deepEqual(visibleProduct.options.map(option => option.name), ['Visible option'])
  assert.deepEqual(visibleProduct.options[0].values.map(value => value.name), ['keep'])
})

test('deduplication respects parent context instead of discarding other styles', () => {
  const option = { ...color, values: [
    { name: 'gold', label: '金色', parentValues: ['Star Hook Clasp'], image: 'star-gold.png' },
    { name: 'gold', label: '金色', parentValues: ['U style'], image: 'u-gold.png' },
  ] }
  assert.equal(availableOptionValues(option, { 'Accessories Style': 'U style' })[0].image, 'u-gold.png')
})

test('switching a style clears colors and grandchildren from every edited asset', () => {
  const patch = { attribute: { key: 'Accessories Style', value: 'U style' }, clearAttributeKeys: dependentOptionNames(product.options, 'Accessories Style') }
  assert.deepEqual(patch.clearAttributeKeys, ['Accessories Color', 'Finish'])
  const attributes = { 'Accessories Style': 'Star Hook Clasp', 'Accessories Color': 'Star Hook Clasp-9', Finish: 'matte', Size: '2' }
  for (const id of ['image-1', 'image-2']) {
    const asset = { id, productId: 'keychain', attributes }
    const updated = applyProductAttributePatch(asset, patch)
    assert.deepEqual(updated.attributes, { 'Accessories Style': 'U style', Size: '2' })
    assert.equal(asset.attributes['Accessories Color'], 'Star Hook Clasp-9')
  }
  assert.deepEqual(applyAttributeValues(attributes, { ...patch, attribute: { key: 'Accessories Style', value: '' } }), { Size: '2' })
})

test('changing product clears old attributes and dependency traversal terminates on cycles', () => {
  const asset = { id: 'image', productId: 'old', attributes: { Size: '2', 'Accessories Color': 'old-color' } }
  assert.deepEqual(applyProductAttributePatch(asset, { productId: 'new', clearAttributes: true }).attributes, {})
  assert.deepEqual(dependentOptionNames([
    { name: 'a', linkedParent: 'b' }, { name: 'b', linkedParent: 'a' },
  ], 'a'), ['b'])
})

test('selection readback returns only shared product attributes', () => {
  const assets = [
    { id: '1', productId: 'keychain', attributes: { Size: '2', 'Accessories Style': 'U style', 'Accessories Color': 'U style-24' }, attributeImages: { 'Accessories Color': 'color.png' } },
    { id: '2', productId: 'keychain', attributes: { Size: '2', 'Accessories Style': 'U style', 'Accessories Color': 'U style-24' }, attributeImages: { 'Accessories Color': 'color.png' } },
    { id: '3', productId: 'keychain', attributes: { Size: '1', 'Accessories Style': 'U style', 'Accessories Color': 'U style-25' } },
  ]
  assert.deepEqual(commonSelectionValues(assets, new Set(['1', '2']), ['Size', 'Accessories Style', 'Accessories Color']), {
    productId: 'keychain', attributes: { Size: '2', 'Accessories Style': 'U style', 'Accessories Color': 'U style-24' }, attributeImages: { 'Accessories Color': 'color.png' },
  })
  assert.deepEqual(commonSelectionValues(assets, new Set(['1', '3']), ['Size', 'Accessories Style', 'Accessories Color']), {
    productId: 'keychain', attributes: { 'Accessories Style': 'U style' }, attributeImages: {},
  })
  assert.deepEqual(commonSelectionValues([...assets, { ...assets[0], id: '4', productId: 'other' }], new Set(['1', '4']), ['Size']), { attributes: {}, attributeImages: {} })
})

test('QT is treated as a shared persisted integer attribute', () => {
  const assets = [
    { id: '1', productId: 'keychain', attributes: { QT: '3' } },
    { id: '2', productId: 'keychain', attributes: { QT: '3' } },
    { id: '3', productId: 'keychain', attributes: { QT: '4' } },
  ]
  assert.equal(commonSelectionValues(assets, new Set(['1', '2']), ['QT']).attributes.QT, '3')
  assert.equal(Object.hasOwn(commonSelectionValues(assets, new Set(['1', '3']), ['QT']).attributes, 'QT'), false)
  assert.deepEqual(applyProductAttributePatch(assets[0], { attribute: { key: 'QT', value: '7' } }).attributes, { QT: '7' })
})

test('QT patch is isolated from product and dependent attributes', () => {
  const asset = { id: '1', productId: 'old-product', productName: 'Old product', attributes: { Size: '2.5"', Finish: 'Glossy', QT: '2' } }
  const updated = applyProductAttributePatch(asset, { attribute: { key: 'QT', value: '8' } })
  assert.equal(updated.productId, 'old-product')
  assert.equal(updated.productName, 'Old product')
  assert.deepEqual(updated.attributes, { Size: '2.5"', Finish: 'Glossy', QT: '8' })
})

test('notes are independent of product, QT and accessory images', () => {
  const original = { id: '1', productId: 'custom:1', attributes: { QT: '3', Size: '10cm' }, attributeImages: { 'Accessories Color': 'gold.png' }, note: 'old', noteImage: 'old.png' }
  const updated = applyProductAttributePatch(original, { note: '新备注', noteImage: 'data:image/png;base64,AA==' })
  assert.equal(updated.productId, original.productId)
  assert.deepEqual(updated.attributes, original.attributes)
  assert.deepEqual(updated.attributeImages, original.attributeImages)
  const changedProduct = applyProductAttributePatch(updated, { productId: 'catalog', clearAttributes: true })
  assert.equal(changedProduct.note, '新备注')
  assert.equal(changedProduct.noteImage, updated.noteImage)
  const cleared = applyProductAttributePatch(updated, { note: '', noteImage: '' })
  assert.equal(cleared.note, '')
  assert.equal(cleared.noteImage, '')
})

test('selected option image is persisted per asset and cleared with the option', () => {
  const asset = { id: '1', attributes: { 'Accessories Color': 'old' }, attributeImages: { 'Accessories Color': 'old.png' } }
  const selected = applyProductAttributePatch(asset, { attribute: { key: 'Accessories Color', value: 'gold' }, attributeImage: { key: 'Accessories Color', url: 'gold.png' } })
  assert.deepEqual(selected.attributeImages, { 'Accessories Color': 'gold.png' })
  const cleared = applyProductAttributePatch(selected, { attribute: { key: 'Accessories Color', value: '' }, attributeImage: { key: 'Accessories Color', url: '' } })
  assert.deepEqual(cleared.attributeImages, {})
})
