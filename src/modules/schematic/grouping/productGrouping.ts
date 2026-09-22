import type { Asset } from '../../../model'
import type { AttributeDraft } from '../services/attributeDraftService'
import { catalogConfirmationPatch } from '../services/attributeDraftService.ts'
import type { CustomProduct } from '../services/customProductService'
import { customProductPatch } from '../services/customProductService.ts'
import type { ProductConfig, ProductOptionValue } from '../services/productConfigService'
import { applyProductAttributePatch, availableOptionValues } from '../services/productOptionRules.ts'

export type GroupEditor = { mode: 'existing' | 'custom'; draft: AttributeDraft; custom: CustomProduct }
export type GroupTrigger = { kind: 'standees' | 'shaker' | 'photo-holder' | 'product' | 'free'; label: string; count?: number; quantityName?: string }
export type ProductGroupSession = {
  id: string; color: string; leaderId: string; activeId: string; memberIds: string[]
  editors: Record<string, GroupEditor>; trigger: GroupTrigger; orderDirty?: boolean
}

export const quantityOptionName = (name: string, label: string) => `${name} ${label}`.includes('立牌数量')
const quantityCount = (value: ProductOptionValue | undefined) => Number(value?.name.match(/^\s*(\d+)(?:\s*件)?\s*$/)?.[1] ?? value?.label.match(/^\s*(\d+)\s*件/)?.[1])

function selectedQuantity(editor: GroupEditor, products: ProductConfig[]) {
  const product = products.find(item => item.id === editor.draft.productId)
  for (const option of product?.options ?? []) {
    if (!quantityOptionName(option.name, option.label)) continue
    const value = availableOptionValues(option, editor.draft.attributes).find(item => item.name === editor.draft.attributes[option.name])
    const count = quantityCount(value)
    if (Number.isInteger(count) && count > 0) return { option, value: value!, count }
  }
  return null
}

export function groupingTrigger(editor: GroupEditor, products: ProductConfig[]): GroupTrigger | null {
  const product = products.find(item => item.id === editor.draft.productId)
  const title = editor.mode === 'custom' ? editor.custom.name : product?.title ?? ''
  if (/摇摇乐|shaker/i.test(title)) return { kind: 'shaker', label: '摇摇乐' }
  if (/照片夹|photocard\s*holders?|photo\s*card\s*holders?|photo\s*holders?/i.test(title)) return { kind: 'photo-holder', label: '照片夹' }
  if (editor.mode !== 'existing' || !product || !/standees/i.test(`${product.id} ${title}`)) return null
  const quantity = selectedQuantity(editor, products)
  if (quantity && quantity.count > 1) return { kind: 'standees', label: quantity.option.label, count: quantity.count, quantityName: quantity.option.name }
  return null
}

/** Fixed captions used by the first four members of Shaker/Photocard Holder groups. */
export const fixedGroupSlotLabels = (kind: GroupTrigger['kind']): string[] | null =>
  kind === 'shaker' || kind === 'photo-holder' ? ['Example', 'Front', 'inside', 'Back'] : null

// Only quantity fields are shared. Technique and other parents remain per-image.
export function sharedOptionNames(leader: GroupEditor, products: ProductConfig[]): Set<string> {
  const options = products.find(item => item.id === leader.draft.productId)?.options ?? []
  return new Set(options.filter(option => quantityOptionName(option.name, option.label)).map(option => option.name))
}

export function inheritGroupIdentity(editor: GroupEditor, leader: GroupEditor, products: ProductConfig[]): GroupEditor {
  const sameProduct = editor.mode === leader.mode && (leader.mode === 'custom'
    ? editor.custom.name === leader.custom.name : editor.draft.productId === leader.draft.productId)
  const attributes = { ...(sameProduct ? editor.draft.attributes : leader.draft.attributes) }
  const images = { ...(sameProduct ? editor.draft.images : leader.draft.images) }
  for (const name of sharedOptionNames(leader, products)) {
    delete attributes[name]; delete images[name]
  }
  const quantity = leader.mode === 'existing' ? selectedQuantity(leader, products) : null
  if (quantity) {
    // A technique may expose a different quantity key. Carry the same piece
    // count into that branch without copying the leader's technique or extras.
    const options = products.find(item => item.id === leader.draft.productId)?.options ?? []
    let matched = false
    for (const option of options) {
      if (!quantityOptionName(option.name, option.label)) continue
      const value = availableOptionValues(option, attributes).find(item => quantityCount(item) === quantity.count)
      if (!value) continue
      attributes[option.name] = value.name
      const image = value.image || option.image
      if (image) images[option.name] = image
      matched = true
    }
    // Clearing a parent must not erase the group's fixed quantity. Keep its
    // original, valid catalog value until a matching branch is visible again.
    if (!matched) {
      attributes[quantity.option.name] = quantity.value.name
      const image = quantity.value.image || quantity.option.image
      if (image) images[quantity.option.name] = image
    }
  }
  if (!sameProduct && editor.draft.attributes.QT) attributes.QT = editor.draft.attributes.QT
  return {
    mode: leader.mode,
    draft: { ...editor.draft, productId: leader.draft.productId, attributes, images },
    custom: { ...(sameProduct ? editor.custom : leader.custom), qt: editor.custom.qt, id: leader.custom.id, name: leader.custom.name },
  }
}

export function readGroupAssetEditor(asset: Asset): GroupEditor {
  return {
    mode: asset.productId.startsWith('custom:') ? 'custom' : 'existing',
    draft: { productId: asset.productId, attributes: { ...asset.attributes }, images: { ...asset.attributeImages }, note: asset.note ?? '', noteImage: asset.noteImage ?? '' },
    custom: { id: Number(asset.productId.slice(7)) || null, name: asset.productName ?? '', size: asset.attributes?.Size ?? '', printOption: asset.attributes?.['Print Option'] ?? '', finish: asset.attributes?.Finish ?? '', accessoryColor: asset.attributes?.['Accessories Color'] ?? '', accessoryColorImage: asset.attributeImages?.['Accessories Color'] ?? '', qt: Number(asset.attributes?.QT) || 1, attributes: { ...asset.attributes }, attributeImages: { ...asset.attributeImages } },
  }
}

export function editorForGroupAsset(asset: Asset, leader: GroupEditor, products: ProductConfig[]): GroupEditor {
  return inheritGroupIdentity(readGroupAssetEditor(asset), leader, products)
}

export function updateGroupEditor(session: ProductGroupSession, editor: GroupEditor, products: ProductConfig[]): ProductGroupSession {
  const editors = { ...session.editors }
  if (session.trigger.kind === 'free') {
    editors[session.activeId] = editor
    return { ...session, editors }
  }
  if (session.activeId === session.leaderId) {
    const previous = editors[session.leaderId]
    if (editor.mode === 'existing' && previous.mode === editor.mode && previous.draft.productId === editor.draft.productId && !selectedQuantity(editor, products)) {
      editor = inheritGroupIdentity(editor, previous, products)
    }
    const keys = sharedOptionNames(editor, products)
    const identityChanged = previous.mode !== editor.mode || (editor.mode === 'custom'
      ? previous.custom.id !== editor.custom.id || previous.custom.name !== editor.custom.name
      : previous.draft.productId !== editor.draft.productId || [...keys].some(key => previous.draft.attributes[key] !== editor.draft.attributes[key] || previous.draft.images[key] !== editor.draft.images[key]))
    editors[session.leaderId] = editor
    if (identityChanged) for (const id of session.memberIds) if (id !== session.leaderId) editors[id] = inheritGroupIdentity(editors[id], editor, products)
  } else editors[session.activeId] = inheritGroupIdentity(editor, editors[session.leaderId], products)
  const quantity = selectedQuantity(editors[session.leaderId], products)
  const trigger = groupingTrigger(editors[session.leaderId], products)
    ?? (session.trigger.kind === 'standees' && quantity ? { ...session.trigger, count: quantity.count, label: quantity.option.label, quantityName: quantity.option.name } : session.trigger)
  return { ...session, editors, trigger }
}

const groupColors = ['#fff1b8', '#d9f7be', '#ffd6e7', '#efdbff', '#b5f5ec', '#ffe7ba', '#d6e4ff', '#ffccc7']
export function newGroupColor(assets: Asset[]): string {
  const used = new Set(assets.map(asset => asset.productGroupColor))
  const unused = groupColors.filter(color => !used.has(color))
  const palette = unused.length ? unused : groupColors
  return palette[Math.floor(Math.random() * palette.length)]
}

/** Confirm each member's own draft, enforcing only the shared product and piece count. */
export function confirmGroupEditor(asset: Asset, editor: GroupEditor, leader: GroupEditor, products: ProductConfig[], independent = false): Asset {
  const fixed = independent ? editor : inheritGroupIdentity(editor, leader, products)
  const product = products.find(item => item.id === fixed.draft.productId)
  // A free group is also useful for images whose attributes have not been
  // selected yet; keep their artwork/group membership and let them be edited
  // independently later instead of making a product up from the leader.
  if (fixed.mode === 'existing' && !product) return independent ? asset : (() => { throw new Error('请选择有效产品。') })()
  if (fixed.mode === 'custom' && !fixed.custom.name.trim()) return independent ? asset : (() => { throw new Error('请填写自定义产品名称。') })()
  const patch = fixed.mode === 'existing' ? catalogConfirmationPatch(fixed.draft, product!)
    : { ...customProductPatch(fixed.custom), note: fixed.draft.note, noteImage: fixed.draft.noteImage }
  if (fixed.mode === 'existing') for (const key of sharedOptionNames(leader, products)) {
    // Retain the fixed count even while this member's technique is temporarily empty.
    if (fixed.draft.attributes[key]) {
      patch.attributes![key] = fixed.draft.attributes[key]
      if (fixed.draft.images[key]) patch.attributeImages![key] = fixed.draft.images[key]
    }
  }
  return { ...applyProductAttributePatch(asset, patch), attributesConfirmed: true }
}

/** Confirm and end use the same complete snapshot; only leaving the guide differs. */
export function applyProductGroup(assets: Asset[], session: ProductGroupSession, products: ProductConfig[]): Asset[] {
  const next = assets.map(asset => {
    const editor = session.editors[asset.id]
    if (!editor || !session.memberIds.includes(asset.id)) return asset
    return confirmGroupEditor(asset, editor, session.editors[session.leaderId], products, session.trigger.kind === 'free')
  })
  return applyGroupMembership(next, session)
}

/** Membership-only writes also support removing members before custom product confirmation. */
export function applyGroupMembership(assets: Asset[], session: ProductGroupSession): Asset[] {
  const positions = new Map(session.memberIds.map((id, index) => [id, index + 1]))
  const next = assets.map(asset => session.memberIds.includes(asset.id) ? {
    ...asset, productGroupId: session.memberIds.length > 1 ? session.id : '',
    productGroupColor: session.memberIds.length > 1 ? session.color : '',
    productGroupLeaderId: session.memberIds.length > 1 ? session.leaderId : '',
    productGroupPosition: session.memberIds.length > 1 ? positions.get(asset.id) ?? 0 : 0,
    ...(session.memberIds.length > 1 && session.trigger.kind === 'free' ? { productGroupMode: 'free' as const } : {}),
  } : asset)
  const counts = new Map<string, number>()
  next.forEach(asset => { if (asset.productGroupId) counts.set(asset.productGroupId, (counts.get(asset.productGroupId) ?? 0) + 1) })
  return next.map(asset => asset.productGroupId && counts.get(asset.productGroupId) === 1
    ? { ...asset, productGroupId: '', productGroupColor: '', productGroupLeaderId: '', ...(asset.productGroupPosition !== undefined ? { productGroupPosition: 0 } : {}) } : asset)
}
