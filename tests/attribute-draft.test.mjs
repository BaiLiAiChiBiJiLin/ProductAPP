import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyAttributeDraft, readSelectionDraft, catalogConfirmationPatch } from '../src/modules/schematic/services/attributeDraftService.ts'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService.ts'

test('blank images keep previous form while populated images hydrate their own values', () => {
  const previous = { ...emptyAttributeDraft(), productId: 'p', attributes: { Size: '10cm', QT: '3' }, note: '上一张备注' }
  assert.equal(readSelectionDraft(previous, [{ id: 'blank', productId: 'a' }]), previous)
  const next = readSelectionDraft(previous, [{ id: 'saved', productId: 'p', attributes: { Size: '20cm', QT: '2' }, note: '已存备注', noteImage: 'note.png' }])
  assert.deepEqual(next.attributes, { Size: '20cm', QT: '2' })
  assert.equal(next.note, '已存备注')
  assert.equal(next.noteImage, 'note.png')
  assert.equal(previous.attributes.Size, '10cm')
})

test('confirmation strips hidden fields and hidden or invalid dependent values', () => {
  const [product] = normalizeProductConfigs([{ productId: 'p', title: '产品', productOptions: [
    { name: 'Secret', isHidden: true, values: ['hidden'] },
    { name: 'Style', values: ['A', 'B'] },
    { name: 'Color', linkedParent: 'Style', values: [{ name: 'red', parentValues: ['A'] }, { name: 'black', parentValues: ['B'] }, { name: 'hidden', isHidden: true, parentValues: ['A'] }] },
  ] }])
  for (const invalid of ['black', 'hidden']) {
    const patch = catalogConfirmationPatch({ ...emptyAttributeDraft(), attributes: { Style: 'A', Color: invalid, Secret: 'hidden', QT: '5' }, note: '备注' }, product)
    assert.deepEqual(patch.attributes, { Style: 'A', QT: '5' })
    assert.equal(patch.note, '备注')
  }
})
