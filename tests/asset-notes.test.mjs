import test from 'node:test'
import assert from 'node:assert/strict'
import { getNoteImages, noteImagesPatch } from '../src/modules/schematic/services/assetNotesService.ts'
import { applyProductAttributePatch } from '../src/modules/schematic/services/productOptionRules.ts'
import { readSelectionDraft, catalogConfirmationPatch } from '../src/modules/schematic/services/attributeDraftService.ts'
import { readGroupAssetEditor, confirmGroupEditor } from '../src/modules/schematic/grouping/productGrouping.ts'

const images = [{ src: 'one.png', name: '正面参考' }, { src: 'two.png', name: '' }, { src: 'three.svg', name: '背面参考' }]
const asset = { id: 'one', productId: 'p', attributes: { QT: '0', Size: 'small' }, note: '已有文字', noteImage: 'old.png', productGroupId: 'g', productGroupPosition: 2 }
const product = { id: 'p', title: '已有产品', options: [{ name: 'Size', values: [{ name: 'small' }] }] }

test('legacy single notes hydrate while explicit empty arrays stay cleared', () => {
  assert.deepEqual(getNoteImages(asset), [{ src: 'old.png', name: '' }])
  assert.deepEqual(getNoteImages({ ...asset, noteImages: [] }), [])
  assert.deepEqual(getNoteImages({ noteImages: [...images, { src: 'extra.png', name: '' }] }), images)
})

test('named note images survive confirmation and reload without changing QT or group metadata', () => {
  const patched = applyProductAttributePatch(asset, noteImagesPatch(images))
  assert.deepEqual(patched.attributes, asset.attributes)
  assert.equal(patched.productGroupPosition, 2)
  assert.equal(patched.note, '已有文字')
  const draft = readSelectionDraft([JSON.parse(JSON.stringify(patched))])
  const confirmed = applyProductAttributePatch(patched, catalogConfirmationPatch(draft, product))
  assert.deepEqual(confirmed.noteImages, images)
  assert.equal(confirmed.noteImage, 'one.png')
  assert.equal(confirmed.attributes.QT, '0')
})

test('deleting notes or clearing their names persists and does not restore legacy values', () => {
  const patched = applyProductAttributePatch(asset, noteImagesPatch(images))
  const renamed = applyProductAttributePatch(patched, noteImagesPatch(images.map(image => ({ ...image, name: '' }))))
  assert.ok(renamed.noteImages.every(image => image.name === ''))
  const cleared = applyProductAttributePatch(renamed, noteImagesPatch([]))
  assert.equal(cleared.noteImage, '')
  assert.deepEqual(getNoteImages(readSelectionDraft([cleared])), [])
  assert.deepEqual(cleared.attributes, asset.attributes)
})

test('selection hydration compares every image and its name, not only the first image', () => {
  const first = { ...asset, ...noteImagesPatch(images) }
  const different = { ...first, noteImages: images.map((image, i) => i === 2 ? { ...image, name: '不同名称' } : image) }
  assert.deepEqual(readSelectionDraft([first, different]).noteImages, [])
  assert.deepEqual(readSelectionDraft([first, first]).noteImages, images)
})

test('existing and custom group members keep their own three named notes through confirmation', () => {
  for (const custom of [false, true]) {
    const first = { ...asset, productId: custom ? 'custom:1' : 'p', productName: '产品', ...noteImagesPatch(images) }
    const second = { ...first, id: 'two', ...noteImagesPatch([{ src: 'follower.png', name: '独立备注' }]) }
    const leader = readGroupAssetEditor(first)
    const follower = readGroupAssetEditor(second)
    assert.deepEqual(confirmGroupEditor(first, leader, leader, [product], true).noteImages, images)
    const saved = confirmGroupEditor(second, follower, leader, [product], true)
    assert.deepEqual(readGroupAssetEditor(JSON.parse(JSON.stringify(saved))).draft.noteImages, second.noteImages)
  }
})
