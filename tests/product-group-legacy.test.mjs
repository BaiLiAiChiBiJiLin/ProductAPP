import test from 'node:test'
import assert from 'node:assert/strict'
import { repairLegacyProductGroups, restoreProductGroup, applyGroupedAttributePatch } from '../src/modules/schematic/grouping/productGroupRestore.ts'
import { applyProductGroup } from '../src/modules/schematic/grouping/productGrouping.ts'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService.ts'

// Metadata-only reproduction of Lapitalii Klein马口铁; no source artwork or database writes.
const products = normalizeProductConfigs([{ productId: '7940707221573', title: 'Broken Glass Acrylic Standees', productOptions: [
  { name: 'Technique', values: ['No additional technique', 'epoxy'] },
  { name: 'Standee Quantity-Clear', labelZh: '透明立牌数量', linkedParent: 'Technique', values: [{ name: '2', parentValues: ['No additional technique'] }] },
  { name: 'EpoxyCount', labelZh: '滴胶立牌数量', linkedParent: 'Technique', values: [{ name: '2', parentValues: ['epoxy'] }] },
  { name: 'Print Option', values: ['Double Sided Different Design'] },
  { name: 'Size', values: ['10cm', '20cm'] },
] }])
const fixture = () => [1, 2, 3].map(index => ({ id: String(index), name: `图片${index}`, svg: '<svg/>', productId: index === 3 ? '7940707221573' : 'a',
  productName: index === 3 ? 'Broken Glass Acrylic Standees' : '', attributesConfirmed: index === 3,
  attributes: index === 3 ? { Technique: 'No additional technique', 'Standee Quantity-Clear': '2', 'Print Option': 'Double Sided Different Design', QT: '1' } : {},
  productGroupId: 'legacy-group', productGroupColor: '#efdbff', attributeImages: {}, note: `${index} own note`, noteImage: `${index}.png`,
}))

test('legacy color-only members recover product, independent notes and confirmation from valid peer', () => {
  const source = fixture()
  source[0].attributes.QT = '9'
  const repaired = repairLegacyProductGroups(source, products)
  for (const member of repaired) {
    assert.equal(member.productId, '7940707221573')
    assert.equal(member.productName, 'Broken Glass Acrylic Standees')
    assert.equal(member.attributesConfirmed, true)
    assert.equal(member.attributes['Standee Quantity-Clear'], '2')
    assert.equal(member.productGroupLeaderId, '3')
    assert.equal(member.productGroupColor, '#efdbff')
    assert.equal(member.note, `${member.id} own note`)
    assert.equal(member.noteImage, `${member.id}.png`)
  }
  assert.equal(repaired[0].attributes.QT, '9')
  assert.equal(source[0].productId, 'a', 'repair is immutable')
  assert.equal(repairLegacyProductGroups(repaired, products), repaired, 'repeated repair is a no-op')
  const reloaded = JSON.parse(JSON.stringify(repaired))
  const session = restoreProductGroup(reloaded, '1', products)
  assert.equal(session.leaderId, '3')
  assert.deepEqual(applyProductGroup(reloaded, session, products), reloaded)
})

test('legacy repair preserves already configured members independent properties and status', () => {
  const source = fixture()
  Object.assign(source[1], { productId: '7940707221573', productName: 'Broken Glass Acrylic Standees', attributes: { Technique: 'epoxy', EpoxyCount: '2', QT: '8', Size: '10cm' }, attributeImages: { Size: 'own-size.png' } })
  const repaired = repairLegacyProductGroups(source, products)
  assert.equal(repaired[1].attributes, source[1].attributes)
  assert.equal(repaired[1].attributeImages, source[1].attributeImages)
  assert.equal(repaired[1].attributesConfirmed, false)
})

test('missing catalog or absence of a confirmed valid leader never invents a product or confirmation', () => {
  const source = fixture()
  assert.equal(repairLegacyProductGroups(source, []), source)
  source[2].attributesConfirmed = false
  assert.equal(repairLegacyProductGroups(source, products), source)
})

test('normal grouped image confirmation edits that image without changing group identity or sibling fields', () => {
  const source = repairLegacyProductGroups(fixture(), products)
  const saved = applyGroupedAttributePatch(source, new Set(['1']), { productId: '7940707221573', attributes: { Technique: 'epoxy', EpoxyCount: '1', QT: '17', Size: '20cm' }, clearAttributes: true, note: 'one only' }, products)
  assert.equal(saved[0].attributes.EpoxyCount, '2')
  assert.equal(saved[0].attributes.Technique, 'epoxy')
  assert.equal(saved[0].attributes.QT, '17')
  assert.equal(saved[0].note, 'one only')
  assert.equal(saved[1], source[1])
  assert.equal(saved[2], source[2])
})
