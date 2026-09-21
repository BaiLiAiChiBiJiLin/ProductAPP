import test from 'node:test'
import assert from 'node:assert/strict'
import { removeProductGroupMember } from '../src/modules/schematic/grouping/productGroupRemoval.ts'
import { emptyCustomProduct } from '../src/modules/schematic/services/customProductService.ts'

const assets = ['1', '2', '3'].map(id => ({ id, name: id, productId: 'custom:4', productName: '摇摇乐',
  svg: '<svg/>', width: 30, height: 40, storagePath: `${id}.svg`, previewUrl: '', thumbnailUrl: '',
  attributes: { Size: `${id}cm`, QT: id }, attributeImages: { 'Accessories Color': `${id}.png` },
  note: `备注${id}`, noteImage: `note${id}.png`, attributesConfirmed: true, productGroupId: 'group', productGroupColor: '#d9f7be', productGroupLeaderId: '1' }))
const session = { id: 'group', color: '#d9f7be', leaderId: '1', activeId: '2', memberIds: ['1', '2', '3'],
  trigger: { kind: 'shaker', label: '摇摇乐' }, editors: Object.fromEntries(assets.map(asset => [asset.id, {
    mode: 'custom', draft: { productId: asset.productId, attributes: { ...asset.attributes }, images: { ...asset.attributeImages }, note: asset.note, noteImage: asset.noteImage },
    custom: { ...emptyCustomProduct(), id: 4, name: '摇摇乐', size: asset.attributes.Size, qt: Number(asset.id) },
  }])) }

test('removal clears only the removed image product data and keeps the artwork and independent notes', () => {
  const next = removeProductGroupMember(assets, session, '2', [])
  const removed = next.assets[1]
  assert.equal(next.assets.length, 3)
  assert.equal(removed.productId, 'a')
  assert.equal(removed.productName, '')
  assert.deepEqual(removed.attributes, {})
  assert.deepEqual(removed.attributeImages, {})
  assert.equal(removed.attributesConfirmed, false)
  assert.equal(removed.productGroupId, '')
  assert.equal(removed.productGroupColor, '')
  assert.equal(removed.productGroupLeaderId, '')
  for (const key of ['svg', 'width', 'height', 'storagePath', 'note', 'noteImage']) assert.equal(removed[key], assets[1][key])
  assert.deepEqual(next.assets[0], assets[0])
  assert.deepEqual(next.assets[2], assets[2])
  assert.deepEqual(next.session.memberIds, ['1', '3'])
  assert.equal(next.session.activeId, '3')
  assert.equal(next.session.editors['2'], undefined)
  assert.equal(session.editors['2'].custom.size, '2cm')
  assert.equal(assets[1].productId, 'custom:4')
})

test('removing a nonactive leader promotes the first remaining image without replacing its draft', () => {
  const next = removeProductGroupMember(assets, session, '1', [])
  assert.equal(next.session.leaderId, '2')
  assert.equal(next.session.activeId, '2')
  assert.equal(next.session.editors['2'], session.editors['2'])
  assert.equal(next.session.editors['3'], session.editors['3'])
  assert.equal(next.assets[1].attributes.Size, '2cm')
  assert.equal(next.assets[2].attributes.Size, '3cm')
  assert.equal(next.assets[1].productGroupLeaderId, '2')
  assert.equal(next.assets[2].productGroupLeaderId, '2')
})

test('last member removal exits guidance; singleton membership loses its color without losing attributes', () => {
  let next = removeProductGroupMember(assets, session, '2', [])
  next = removeProductGroupMember(next.assets, next.session, '3', [])
  assert.equal(next.session.leaderId, '1')
  assert.equal(next.session.activeId, '1')
  assert.equal(next.assets[0].productGroupColor, '')
  assert.equal(next.assets[0].attributes.Size, '1cm')
  next = removeProductGroupMember(next.assets, next.session, '1', [])
  assert.equal(next.session, null)
  assert.equal(next.assets.length, 3)
  assert.ok(next.assets.every(asset => asset.productId === 'a' && !asset.productGroupId))
})

test('removing an image outside this guide is a no-op', () => {
  const next = removeProductGroupMember(assets, session, 'unknown', [])
  assert.equal(next.assets, assets)
  assert.equal(next.session, session)
})
