import assert from 'node:assert/strict'
import test from 'node:test'
import { customProductPatch } from '../src/modules/schematic/services/customProductService.ts'
import { applyProductAttributePatch } from '../src/modules/schematic/services/productOptionRules.ts'

test('custom product replaces catalog-specific attributes using shared persistence keys', () => {
  const original = { id: 'image', productId: 'catalog', attributes: { 'Accessories Color': 'gold', QT: '99' }, attributeImages: { 'Accessories Color': 'old.png' } }
  const preset = { id: 7, name: '自定义立牌', size: '10cm', printOption: '双面同图', finish: '亮面', accessoryColor: '金色', accessoryColorImage: 'data:image/svg+xml;base64,PHN2Zy8+', qt: 3 }
  const updated = applyProductAttributePatch(original, customProductPatch(preset))
  assert.equal(updated.productId, 'custom:7')
  assert.equal(updated.productName, preset.name)
  assert.deepEqual(updated.attributes, { Size: '10cm', 'Print Option': '双面同图', Finish: '亮面', 'Accessories Color': '金色', QT: '3' })
  assert.deepEqual(updated.attributeImages, { 'Accessories Color': preset.accessoryColorImage })
  assert.equal(original.attributes.QT, '99')
  assert.throws(() => customProductPatch({ ...preset, id: null }), /请先保存/)
})
