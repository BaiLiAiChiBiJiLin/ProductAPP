import test from 'node:test'
import assert from 'node:assert/strict'
import { groupingTrigger, fixedGroupSlotLabels, editorForGroupAsset, updateGroupEditor, applyProductGroup, sharedOptionNames } from '../src/modules/schematic/grouping/productGrouping.ts'
import { applyGroupedAttributePatch } from '../src/modules/schematic/grouping/productGroupRestore.ts'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService.ts'
import { emptyCustomProduct } from '../src/modules/schematic/services/customProductService.ts'
import { restoreProductGroup } from '../src/modules/schematic/grouping/productGroupRestore.ts'
import { orderAssetsByProductGroup } from '../src/modules/schematic/services/productGroupOrdering.ts'

const products = normalizeProductConfigs([{ productId: 'stand', title: 'Clear Acrylic Standees', productOptions: [
  { name: 'Technique', labelZh: '工艺', values: ['clear', 'epoxy'] },
  { name: 'Count', labelZh: '透明立牌数量', linkedParent: 'Technique', values: [{ name: '1', labelZh: '1件', parentValues: ['clear'] }, { name: '2', labelZh: '2件', parentValues: ['clear'] }, { name: '3', labelZh: '3件', isHidden: true, parentValues: ['clear'] }] },
  { name: 'EpoxyCount', labelZh: '滴胶立牌数量', linkedParent: 'Technique', values: [{ name: '1', labelZh: '1件', parentValues: ['epoxy'] }, { name: '2', labelZh: '2件', parentValues: ['epoxy'] }] },
  { name: 'Size', labelZh: '尺寸', values: ['10cm', '20cm'] },
] }])
const asset = (id, attrs = {}) => ({ id, name: id, productId: 'stand', attributes: { Technique: 'clear', Count: '2', Size: '10cm', QT: '1', ...attrs }, note: `${id} note`, svg: '<svg/>', width: 20, height: 20, previewUrl: '', thumbnailUrl: '' })
const leader = { mode: 'existing', custom: emptyCustomProduct(), draft: { productId: 'stand', attributes: { Technique: 'clear', Count: '2', Size: '20cm', QT: '5' }, images: {}, note: 'leader draft', noteImage: 'leader.png' } }
const sessionFor = assets => ({ id: 'group-1', color: '#d9f7be', leaderId: '1', activeId: '1', memberIds: assets.map(a => a.id), trigger: groupingTrigger(leader, products), editors: Object.fromEntries(assets.map(a => [a.id, a.id === '1' ? leader : editorForGroupAsset(a, leader, products)])) })

test('every product group persists selection order across list display and history reopen', () => {
  for (const kind of ['free', 'standees', 'shaker', 'photo-holder', 'product']) {
    const assets = [asset('1'), asset('2'), asset('3')]
    const session = { ...sessionFor(assets), memberIds: ['3', '1', '2'], trigger: { kind, label: 'test' } }
    const saved = JSON.parse(JSON.stringify(applyProductGroup(assets, session, products)))
    assert.deepEqual(saved.map(a => a.productGroupPosition), [2, 3, 1])
    assert.deepEqual(orderAssetsByProductGroup(saved).map(a => a.id), ['3', '1', '2'])
    assert.deepEqual(restoreProductGroup(saved, '2', products).memberIds, ['3', '1', '2'])
  }
})

test('guide starts only for a visible multi-piece quantity or shaker/photo holder product', () => {
  assert.equal(groupingTrigger(leader, products)?.count, 2)
  for (const Count of ['1', '3', 'invalid']) assert.equal(groupingTrigger({ ...leader, draft: { ...leader.draft, attributes: { ...leader.draft.attributes, Count } } }, products), null)
  assert.equal(groupingTrigger({ ...leader, draft: { ...leader.draft, attributes: { Technique: 'epoxy', Count: '2' } } }, products), null)
  for (const name of ['摇摇乐', '照片夹']) assert.ok(groupingTrigger({ ...leader, mode: 'custom', custom: { ...leader.custom, name } }, products))
  assert.equal(groupingTrigger({ ...leader, mode: 'custom', custom: { ...leader.custom, name: '普通钥匙扣' } }, products), null)
})

test('Photocard Holders and Shaker use the same four fixed captions, with extra members allowed', () => {
  for (const name of ['Custom Photocard Holders', 'Custom Shaker']) {
    const trigger = groupingTrigger({ ...leader, mode: 'custom', custom: { ...leader.custom, name } }, products)
    assert.ok(trigger)
    assert.deepEqual(fixedGroupSlotLabels(trigger.kind), ['Example', 'Front', 'inside', 'Back'])
  }
  assert.equal(fixedGroupSlotLabels('free'), null)
})

test('dragged fixed slots are persisted on the corresponding image assets', () => {
  const assets = [asset('1'), asset('2'), asset('3'), asset('4')]
  const base = sessionFor(assets)
  const session = { ...base, trigger: { kind: 'shaker', label: '摇摇乐' }, memberIds: ['2', '1', '3', '4'], orderDirty: true }
  const saved = applyProductGroup(assets, session, products)
  assert.deepEqual(saved.map(item => item.productGroupPosition), [2, 1, 3, 4])
})

test('follower locks only product and quantity while technique, size, QT and notes remain independent', () => {
  const assets = [asset('1'), asset('2', { QT: '9' })]
  let session = { ...sessionFor(assets), activeId: '2' }
  assert.deepEqual([...sharedOptionNames(leader, products)].sort(), ['Count', 'EpoxyCount'])
  const follower = session.editors['2']
  session = updateGroupEditor(session, { ...follower, draft: { ...follower.draft, attributes: { ...follower.draft.attributes, Count: '1', Technique: 'epoxy', Size: '10cm', QT: '7' }, note: 'follower only', noteImage: 'follower.png' } }, products)
  assert.equal(session.editors['2'].draft.productId, 'stand')
  assert.equal(session.editors['2'].draft.attributes.Count, undefined)
  assert.equal(session.editors['2'].draft.attributes.EpoxyCount, '2')
  assert.equal(session.editors['2'].draft.attributes.Technique, 'epoxy')
  assert.equal(session.editors['2'].draft.attributes.Size, '10cm')
  assert.equal(session.editors['2'].draft.attributes.QT, '7')
  assert.equal(session.editors['2'].draft.note, 'follower only')
  assert.equal(session.editors['1'].draft.note, 'leader draft')
  const saved = applyProductGroup(assets, session, products)
  assert.equal(saved[1].attributes.Technique, 'epoxy')
  assert.equal(saved[1].attributes.EpoxyCount, '2')
  assert.equal(saved[1].attributes.Count, undefined)
  assert.equal(saved[0].attributes.Technique, 'clear')
})

test('leader note and QT changes keep follower drafts untouched without comparing image payloads', () => {
  const session = sessionFor([asset('1'), asset('2')])
  const next = updateGroupEditor(session, { ...leader, draft: { ...leader.draft, note: 'new note', attributes: { ...leader.draft.attributes, QT: '99' } } }, products)
  assert.equal(next.editors['2'], session.editors['2'])
})

test('changing the leader technique keeps each follower technique and maps the fixed quantity separately', () => {
  const session = sessionFor([asset('1'), asset('2')])
  const next = updateGroupEditor(session, { ...leader, draft: { ...leader.draft, attributes: { Technique: 'epoxy', Size: '20cm', QT: '5' } } }, products)
  assert.equal(next.editors['1'].draft.attributes.Technique, 'epoxy')
  assert.equal(next.editors['1'].draft.attributes.EpoxyCount, '2')
  assert.equal(next.editors['2'].draft.attributes.Technique, 'clear')
  assert.equal(next.editors['2'].draft.attributes.Count, '2')
  assert.equal(next.trigger.count, 2)
})

test('temporarily clearing a follower technique does not erase its fixed quantity on confirmation', () => {
  const assets = [asset('1'), asset('2')]
  const session = { ...sessionFor(assets), activeId: '2' }
  const follower = session.editors['2']
  const next = updateGroupEditor(session, { ...follower, draft: { ...follower.draft, attributes: { Size: '10cm', QT: '7' } } }, products)
  assert.equal(next.editors['2'].draft.attributes.Technique, undefined)
  assert.equal(next.editors['2'].draft.attributes.Count, '2')
  const saved = applyProductGroup(assets, next, products)
  assert.equal(saved[1].attributes.Technique, undefined)
  assert.equal(saved[1].attributes.Count, '2')
  assert.equal(saved[1].attributes.QT, '7')
})

test('confirm saves each member draft and status while independent properties survive serialization', () => {
  const assets = [asset('1'), asset('2', { QT: '9' }), asset('3')]
  const session = sessionFor(assets.slice(0, 2))
  let saved = applyProductGroup(assets, session, products)
  assert.equal(saved[0].attributes.Size, '20cm')
  assert.equal(saved[0].noteImage, 'leader.png')
  assert.equal(saved[0].attributesConfirmed, true)
  assert.equal(saved[1].attributes.QT, '9')
  assert.equal(saved[1].attributesConfirmed, true)
  assert.equal(saved[1].note, '2 note')
  assert.equal(saved[2], assets[2])
  assert.equal(saved[0].productGroupId, saved[1].productGroupId)
  const edited = { ...session, activeId: '2', editors: { ...session.editors, '2': { ...session.editors['2'], draft: { ...session.editors['2'].draft, note: 'second saved', attributes: { ...session.editors['2'].draft.attributes, QT: '12' } } } } }
  saved = applyProductGroup(saved, edited, products)
  const restored = JSON.parse(JSON.stringify(saved))
  assert.equal(restored[0].attributes.QT, '5')
  assert.equal(restored[1].attributes.QT, '12')
  assert.equal(restored[0].note, 'leader draft')
  assert.equal(restored[1].note, 'second saved')
  assert.equal(restored[0].productGroupColor, '#d9f7be')
  assert.equal(restored[1].productGroupColor, '#d9f7be')
})

test('ending commits member drafts and cleans up orphaned old groups; single-image end is allowed', () => {
  const assets = [asset('1'), { ...asset('2'), productGroupId: 'old', productGroupColor: '#ffccc7' }, { ...asset('3'), productGroupId: 'old', productGroupColor: '#ffccc7' }]
  const saved = applyProductGroup(assets, sessionFor(assets.slice(0, 2)), products)
  assert.equal(saved[0].attributes.Size, '20cm')
  assert.equal(saved[0].attributes.QT, '5')
  assert.equal(saved[0].attributesConfirmed, true)
  assert.equal(saved[1].attributes.Size, '10cm')
  assert.equal(saved[1].attributesConfirmed, true)
  assert.equal(saved[2].productGroupId, '')
  assert.equal(saved[2].productGroupColor, '')
  assert.doesNotThrow(() => applyProductGroup(assets, sessionFor(assets.slice(0, 1)), products))
})

test('custom members share product identity while each confirmation keeps independent attributes', () => {
  const customLeader = { ...leader, mode: 'custom', custom: { ...emptyCustomProduct(), id: 5, name: '照片夹', size: '12cm', qt: 3 } }
  const a = { ...asset('2'), productId: 'custom:5', productName: '照片夹', attributes: { Size: '8cm', QT: '7' } }
  const follower = editorForGroupAsset(a, customLeader, products)
  assert.equal(follower.custom.size, '8cm')
  assert.equal(follower.custom.qt, 7)
  const session = { ...sessionFor([asset('1'), a]), editors: { '1': customLeader, '2': follower }, activeId: '2' }
  const result = applyProductGroup([asset('1'), a], session, products)
  assert.equal(result[0].productId, 'custom:5')
  assert.equal(result[1].productId, 'custom:5')
  assert.equal(result[1].attributes.Size, '8cm')
  assert.equal(result[1].attributes.QT, '7')
})

test('free image groups can combine selected products without sharing product or quantity locks', () => {
  const first = asset('1', { attributes: { Technique: 'clear', Count: '2', Size: '20cm', QT: '5' }, attributesConfirmed: true, productName: 'Clear Acrylic Standees' })
  const second = asset('2', { attributes: { Technique: 'epoxy', EpoxyCount: '2', Size: '10cm', QT: '9' }, attributesConfirmed: true, productName: 'Clear Acrylic Standees' })
  const base = sessionFor([first, second])
  const free = { ...base, trigger: { kind: 'free', label: '自由图片组' }, editors: {
    '1': { ...base.editors['1'], draft: { ...base.editors['1'].draft, attributes: { Technique: 'clear', Count: '2', Size: '20cm', QT: '5' } } },
    '2': { ...base.editors['2'], draft: { ...base.editors['2'].draft, attributes: { Technique: 'epoxy', EpoxyCount: '2', Size: '10cm', QT: '9' } } },
  } }
  const saved = applyProductGroup([first, second], free, products)
  assert.equal(saved[0].attributes.Technique, 'clear')
  assert.equal(saved[0].attributes.Count, '2')
  assert.equal(saved[0].attributes.QT, '5')
  assert.equal(saved[1].attributes.Technique, 'epoxy')
  assert.equal(saved[1].attributes.EpoxyCount, '2')
  assert.equal(saved[1].attributes.QT, '9')
  assert.equal(saved[0].productGroupMode, 'free')
  assert.equal(saved[1].productGroupMode, 'free')
  const independent = applyGroupedAttributePatch(saved, new Set(['2']), { productId: 'stand', productName: 'Clear Acrylic Standees', clearAttributes: true, attributes: { Technique: 'clear', Count: '2', QT: '13' } }, products)
  assert.equal(independent[1].attributes.Technique, 'clear')
  assert.equal(independent[1].attributes.QT, '13')
  assert.equal(independent[0].attributes.Technique, 'clear')
  assert.equal(independent[0].attributes.QT, '5')
})

test('saving commits each member draft and maps quantity to its own updated technique', () => {
  const assets = [asset('1'), { ...asset('2', { Technique: 'epoxy', Count: undefined, EpoxyCount: '1', Size: '10cm', QT: '9' }), productName: 'outdated', attributeImages: { EpoxyCount: 'old.png', Size: 'size.png' } }, { ...asset('3'), productId: 'a', attributes: { QT: '8' } }]
  const session = sessionFor(assets)
  // This member has an unsaved technique change, so both its branch and status must commit.
  session.editors['2'].draft.attributes.Technique = 'clear'
  const saved = applyProductGroup(assets, session, products)
  for (const item of saved) {
    assert.equal(item.productId, 'stand')
    assert.equal(item.productName, 'Clear Acrylic Standees')
    assert.equal(item.productGroupLeaderId, '1')
  }
  assert.equal(saved[1].attributes.Technique, 'clear')
  assert.equal(saved[1].attributes.EpoxyCount, undefined)
  assert.equal(saved[1].attributes.Count, '2')
  assert.equal(saved[1].attributeImages.EpoxyCount, undefined)
  assert.equal(saved[1].attributeImages.Size, 'size.png')
  assert.equal(saved[1].attributes.Size, '10cm')
  assert.equal(saved[1].attributes.QT, '9')
  assert.equal(saved[1].note, '2 note')
  assert.equal(saved[1].attributesConfirmed, true)
  assert.equal(saved[2].attributes.Count, '2')
  assert.equal(saved[2].attributes.QT, '8')
})
