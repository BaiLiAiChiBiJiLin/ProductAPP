import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyAttributeDraft, readSelectionDraft, catalogConfirmationPatch } from '../src/modules/schematic/services/attributeDraftService.ts'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService.ts'

test('catalog Finish is stored once as the canonical process field', () => {
  const product = { id: 'standees', title: 'Clear Acrylic Standees', options: [{ name: 'Finish', values: [{ name: 'Front Side Epoxy' }] }] }
  const patch = catalogConfirmationPatch({ ...emptyAttributeDraft(), attributes: { Finish: 'Front Side Epoxy' } }, product)
  assert.deepEqual(patch.attributes, { '工艺': 'Front Side Epoxy' })
})

test('blank images start fresh while populated images hydrate only their own values', () => {
  const blank = readSelectionDraft([{ id: 'blank', productId: 'a', note: '当前图片备注' }])
  assert.equal(blank.productId, '')
  assert.deepEqual(blank.attributes, {})
  assert.deepEqual(blank.images, {})
  assert.equal(blank.note, '当前图片备注')
  assert.equal(blank.noteImage, '')
  const next = readSelectionDraft([{ id: 'saved', productId: 'p', attributes: { Size: '20cm', QT: '2' }, note: '已存备注', noteImage: 'note.png' }])
  assert.deepEqual(next.attributes, { Size: '20cm', QT: '2' })
  assert.equal(next.note, '已存备注')
  assert.equal(next.noteImage, 'note.png')
})

test('multiple selections use shared saved values without retaining conflicting previous options or notes', () => {
  const selected = [
    { id: 'one', productId: 'p', attributes: { Size: 'small', Color: 'red' }, attributeImages: { Color: 'red.png' }, note: 'one-note' },
    { id: 'two', productId: 'p', attributes: { Size: 'small', Color: 'blue' }, attributeImages: { Color: 'blue.png' }, note: 'two-note' },
  ]
  const next = readSelectionDraft(selected)
  assert.equal(next.productId, 'p')
  assert.deepEqual(next.attributes, { Size: 'small' })
  assert.deepEqual(next.images, {})
  assert.equal(next.note, '')
  assert.equal(next.noteImage, '')
  assert.equal(next.finishMatchDisabled, false)
  for (const assets of [[], [selected[0], { ...selected[1], productId: 'different' }]]) {
    const blank = readSelectionDraft(assets)
    assert.equal(blank.productId, '')
    assert.deepEqual(blank.attributes, {})
    assert.deepEqual(blank.images, {})
    assert.equal(blank.note, '')
    assert.equal(blank.noteImage, '')
  }
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

test('an explicitly cleared Finish remains suppressed from save-time matching', () => {
  const product = { id: 'standees', title: 'Clear Acrylic Standees', options: [{ name: 'Finish', values: [{ name: 'Front Side Epoxy' }] }] }
  const patch = catalogConfirmationPatch({ ...emptyAttributeDraft(), attributes: {}, finishMatchDisabled: true }, product)
  assert.deepEqual(patch.attributes, {})
  assert.equal(patch.suppressFinishMatch, true)
})

test('legacy canonical 工艺 is read as Finish and remains canonical on confirmation', () => {
  const product = { id: 'standees', title: 'Clear Acrylic Standees', options: [{ name: 'Finish', values: [{ name: 'Front Side Epoxy' }] }] }
  const patch = catalogConfirmationPatch({ ...emptyAttributeDraft(), attributes: { '工艺': 'Front Side Epoxy' } }, product)
  assert.deepEqual(patch.attributes, { '工艺': 'Front Side Epoxy' })
})
