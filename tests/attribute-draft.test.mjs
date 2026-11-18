import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyAttributeDraft, readSelectionDraft, catalogConfirmationPatch } from '../src/modules/schematic/services/attributeDraftService.ts'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService.ts'
import { applyProductAttributePatch } from '../src/modules/schematic/services/productOptionRules.ts'

test('catalog Finish is stored once as the canonical process field', () => {
  const product = { id: 'standees', title: 'Clear Acrylic Standees', options: [{ name: 'Finish', values: [{ name: 'Front Side Epoxy' }] }] }
  const patch = catalogConfirmationPatch({ ...emptyAttributeDraft(), attributes: { Finish: 'Front Side Epoxy' } }, product)
  assert.deepEqual(patch.attributes, { '工艺': 'Front Side Epoxy' })
  assert.equal(patch.noteFontSize, 11)
  assert.equal(patch.noteColor, '#ff4d4f')
})

test('hidden catalog size selections and their images are never confirmed onto artwork', () => {
  for (const [name, label] of [['Size', '尺寸'], [' sizes ', 'Sizes'], ['尺寸', '尺寸'], ['尺寸选项', '尺寸选项'], ['大小', '大小'], ['dimension-choice', '尺寸']]) {
    const [product] = normalizeProductConfigs([{ productId: 'p', title: '产品', productOptions: [
      { name, label, defaultValue: 'small', image: 'size-option.png', values: [{ name: 'small', image: 'size-value.png' }] },
      { name: 'Finish', values: [{ name: 'Epoxy', image: 'epoxy.png' }] },
    ] }])
    const draft = { ...emptyAttributeDraft(), attributes: { [name]: 'small', Finish: 'Epoxy', QT: '0' }, images: { [name]: 'old-size.png' } }
    const patch = catalogConfirmationPatch(draft, product)
    assert.deepEqual(patch.attributes, { 工艺: 'Epoxy', QT: '0' }, name)
    assert.deepEqual(patch.attributeImages, { 工艺: 'epoxy.png' }, name)
    const updated = applyProductAttributePatch({ id: 'a', width: 140, height: 180, sourceGroupWidthMm: 40, sourceGroupHeightMm: 50, attributes: { Size: 'old', [name]: 'small' }, attributeImages: { Size: 'legacy.png', [name]: 'old-size.png' } }, patch)
    assert.deepEqual(updated.attributes, { 工艺: 'Epoxy', QT: '0' })
    assert.deepEqual(updated.attributeImages, { 工艺: 'epoxy.png' })
    assert.deepEqual([updated.width, updated.height, updated.sourceGroupWidthMm, updated.sourceGroupHeightMm], [140, 180, 40, 50])
  }
})

test('a hidden size can validate a dependent option without being persisted itself', () => {
  const [product] = normalizeProductConfigs([{ productId: 'p', title: '产品', productOptions: [
    { name: 'Technique', linkedParent: 'Size', values: [{ name: 'Epoxy', parentValues: ['small'] }] },
    { name: 'Size', label: '尺寸', defaultValue: 'small', values: ['small'] },
  ] }])
  const patch = catalogConfirmationPatch({ ...emptyAttributeDraft(), attributes: { Size: 'small', Technique: 'Epoxy', QT: '2' } }, product)
  assert.deepEqual(patch.attributes, { Technique: 'Epoxy', QT: '2' })
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
