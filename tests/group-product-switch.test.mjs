import test from 'node:test'
import assert from 'node:assert/strict'
import { applyProductGroup, groupSlotLabels, updateGroupEditor } from '../src/modules/schematic/grouping/productGrouping.ts'
import { restoreProductGroup } from '../src/modules/schematic/grouping/productGroupRestore.ts'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService.ts'

const products = normalizeProductConfigs([
  { productId: 'keychain', title: 'Clear Acrylic Keychains', productOptions: [{ name: 'Size', labelZh: '尺寸', values: ['small', 'large'] }] },
  { productId: 'stand', title: 'Clear Acrylic Standees', productOptions: [{ name: 'Count', labelZh: '立牌数量', values: ['1', '2'] }] },
])
const assets = () => ['a', 'b', 'c'].map((id, index) => ({
  id, name: id, svg: '<svg/>', width: 20, height: 30, previewUrl: '', thumbnailUrl: '',
  productId: 'custom:7', productName: '摇摇乐', attributesConfirmed: true,
  attributes: { Size: 'old-size', 'Accessories Color': 'old-color', QT: ['3', '0', ''][index] },
  attributeImages: { 'Accessories Color': `${id}-accessory.png` }, note: `${id}-note`,
  noteImages: [{ src: `${id}-note.png`, name: id }],
  productGroupId: 'saved-group', productGroupLeaderId: 'a', productGroupColor: '#d9f7be',
  productGroupPosition: [3, 2, 4][index],
}))

test('a saved guided follower can replace the whole custom product without losing independent data or order', () => {
  const original = assets()
  const restored = restoreProductGroup(original, 'b', products)
  const active = restored.editors.b
  const next = updateGroupEditor(restored, { ...active, custom: { ...active.custom, id: 9, name: 'Photocard Holders' } }, products)
  assert.deepEqual(next.memberIds, ['b', 'a', 'c'])
  assert.equal(next.activeId, 'b')
  assert.equal(next.leaderId, 'a')
  assert.equal(next.emptyFirstSlot, true)
  assert.equal(next.trigger.kind, 'photo-holder')
  const saved = JSON.parse(JSON.stringify(applyProductGroup(original, next, products)))
  for (const [index, item] of saved.entries()) {
    assert.equal(item.productId, 'custom:9')
    assert.equal(item.productName, 'Photocard Holders')
    assert.equal(item.attributes.Size, undefined)
    assert.equal(item.attributes['Accessories Color'], undefined)
    assert.deepEqual(item.attributeImages, {})
    assert.equal(item.attributes.QT ?? '', ['3', '0', ''][index])
    assert.equal(item.note, original[index].note)
    assert.deepEqual(item.noteImages, original[index].noteImages)
    assert.equal(item.productGroupPosition, original[index].productGroupPosition)
    assert.equal(item.productGroupColor, original[index].productGroupColor)
  }
  const reopened = restoreProductGroup(saved, 'c', products)
  assert.equal(reopened.editors.a.custom.id, 9)
  assert.deepEqual(groupSlotLabels(reopened, products), ['Example', 'Front', 'inside', 'Back'])
})

test('switching a saved group between custom and catalog products clears stale slots and preserves zero or empty QT', () => {
  const original = assets()
  let session = restoreProductGroup(original, 'b', products)
  const active = session.editors.b
  session = updateGroupEditor(session, { ...active, mode: 'existing', draft: { ...active.draft, productId: 'keychain', attributes: {}, images: {} } }, products)
  assert.equal(session.trigger.kind, 'product')
  assert.equal(groupSlotLabels(session, products), null)
  assert.equal(session.emptyFirstSlot, false)
  session = updateGroupEditor(session, { ...session.editors.b, draft: { ...session.editors.b.draft, attributes: { ...session.editors.b.draft.attributes, Size: 'small' } } }, products)
  let saved = applyProductGroup(original, session, products)
  assert.deepEqual(saved.map(item => item.productId), ['keychain', 'keychain', 'keychain'])
  assert.deepEqual(saved.map(item => item.attributes.QT ?? ''), ['3', '0', ''])
  assert.deepEqual(saved.map(item => item.attributes.Size), [undefined, 'small', undefined])
  assert.deepEqual(saved.map(item => item.productGroupPosition), [2, 1, 3])
  session = restoreProductGroup(saved, 'c', products)
  session = updateGroupEditor(session, { ...session.editors.c, mode: 'custom', custom: { ...session.editors.c.custom, id: 7, name: 'Shaker' } }, products)
  saved = applyProductGroup(saved, session, products)
  assert.deepEqual(saved.map(item => item.productId), ['custom:7', 'custom:7', 'custom:7'])
  assert.deepEqual(saved.map(item => item.attributes.QT ?? ''), ['3', '0', ''])
  assert.deepEqual(saved.map(item => item.note), original.map(item => item.note))
  assert.deepEqual(groupSlotLabels(session, products), ['Example', 'Front', 'inside', 'Back'])
})

test('new guided followers still inherit the leader product and saved free groups remain independent', () => {
  const original = assets()
  const restored = restoreProductGroup(original, 'b', products)
  const changed = { ...restored.editors.b, custom: { ...restored.editors.b.custom, id: 9, name: '普通产品' } }
  const fresh = updateGroupEditor({ ...restored, editingSavedGroup: false }, changed, products)
  assert.equal(fresh.editors.b.custom.name, '摇摇乐')
  const free = restoreProductGroup(original.map(item => ({ ...item, productGroupMode: 'free' })), 'b', products)
  const next = updateGroupEditor(free, changed, products)
  const saved = applyProductGroup(original, next, products)
  assert.deepEqual(saved.map(item => item.productName), ['摇摇乐', '普通产品', '摇摇乐'])
  assert.equal(next.editors.a, free.editors.a)
  assert.equal(next.editors.c, free.editors.c)
})

test('the latest per-image quantity survives a mode switch even when the inactive draft is stale', () => {
  const original = assets()
  let session = restoreProductGroup(original, 'b', products)
  const leaderBefore = session.editors.a
  session = updateGroupEditor(session, { ...session.editors.b, custom: { ...session.editors.b.custom, qt: 11 } }, products)
  assert.equal(session.editors.a, leaderBefore)
  assert.equal(session.editors.b.draft.attributes.QT, '0')
  session = updateGroupEditor(session, { ...session.editors.b, mode: 'existing', draft: { ...session.editors.b.draft, productId: 'keychain', attributes: {}, images: {} } }, products)
  const saved = applyProductGroup(original, session, products)
  assert.deepEqual(saved.map(item => item.attributes.QT ?? ''), ['3', '11', ''])
})
