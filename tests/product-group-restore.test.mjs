import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreProductGroup } from '../src/modules/schematic/grouping/productGroupRestore.ts'
import { readGroupAssetEditor } from '../src/modules/schematic/grouping/productGrouping.ts'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService.ts'

const products = normalizeProductConfigs([{ productId: 'stand', title: 'Clear Acrylic Standees', productOptions: [
  { name: 'Count', labelZh: '立牌数量', values: [{ name: '2', labelZh: '2件' }] },
] }])
const asset = id => ({ id, name: id, productId: 'stand', productName: 'Clear Acrylic Standees', attributes: { Count: '2', Size: `${id}cm`, QT: id }, note: `note-${id}`, attributesConfirmed: true, productGroupId: 'saved', productGroupColor: '#d9f7be', productGroupLeaderId: '2' })

test('clicking a saved confirmed follower reopens its complete group and preserves the original leader', () => {
  const assets = [asset('1'), asset('2'), { ...asset('3'), productGroupId: 'other' }]
  const group = restoreProductGroup(assets, '1', products)
  assert.equal(group.id, 'saved')
  assert.equal(group.color, '#d9f7be')
  assert.equal(group.leaderId, '2')
  assert.equal(group.activeId, '1')
  assert.deepEqual(group.memberIds, ['2', '1'])
  assert.equal(group.editors['1'].draft.attributes.Size, '1cm')
  assert.equal(group.editors['2'].draft.attributes.Size, '2cm')
  assert.equal(group.editors['1'].draft.note, 'note-1')
  assert.equal(group.trigger.count, 2)
})

test('reopening after End preserves individual unconfirmed drafts', () => {
  const assets = [asset('1'), asset('2')]
  const draft = readGroupAssetEditor(assets[0])
  draft.draft.attributes.QT = '17'
  draft.draft.note = 'pending'
  const group = restoreProductGroup(assets, '1', products, { '1': draft })
  assert.equal(group.editors['1'].draft.attributes.QT, '17')
  assert.equal(group.editors['1'].draft.note, 'pending')
  assert.equal(group.editors['2'].draft.attributes.QT, '2')
})

test('legacy metadata-only member inherits the saved product from its peer', () => {
  const assets = [{ ...asset('1'), productId: 'a', attributes: {}, productGroupLeaderId: undefined }, { ...asset('2'), productGroupLeaderId: undefined }]
  const group = restoreProductGroup(assets, '1', products)
  assert.equal(group.leaderId, '2')
  assert.equal(group.editors['1'].draft.productId, 'stand')
  assert.equal(group.editors['1'].draft.attributes.Count, '2')
})

test('old groups with no saved product can reopen for repair; ordinary cards do not open guide', () => {
  const group = restoreProductGroup([{ ...asset('1'), productId: 'a', attributes: {}, productGroupLeaderId: undefined }], '1', products)
  assert.equal(group.trigger.kind, 'product')
  assert.equal(group.activeId, group.leaderId)
  assert.equal(restoreProductGroup([{ ...asset('1'), productGroupId: '' }], '1', products), null)
  assert.equal(restoreProductGroup([], 'missing', products), null)
})

test('custom group restoration preserves each member attributes and accessory image', () => {
  const assets = [asset('1'), asset('2')].map(a => ({ ...a, productId: 'custom:9', productName: '照片夹', attributeImages: { 'Accessories Color': `${a.id}.png` } }))
  const group = restoreProductGroup(assets, '1', [])
  assert.equal(group.trigger.kind, 'photo-holder')
  assert.equal(group.editors['1'].mode, 'custom')
  assert.equal(group.editors['1'].custom.accessoryColorImage, '1.png')
  assert.equal(group.editors['2'].custom.accessoryColorImage, '2.png')
  assert.equal(group.editors['1'].custom.size, '1cm')
})
