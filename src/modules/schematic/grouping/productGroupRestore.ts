import type { Asset } from '../../../model'
import type { ProductConfig } from '../services/productConfigService'
import { confirmGroupEditor, groupingTrigger, inheritGroupIdentity, newGroupColor, readGroupAssetEditor, type GroupEditor, type ProductGroupSession } from './productGrouping.ts'
import { applyProductAttributePatch, type ProductAttributePatch } from '../services/productOptionRules.ts'

/** Reopen saved membership, including confirmed images, without recruiting unrelated cards. */
export function restoreProductGroup(assets: Asset[], activeId: string, products: ProductConfig[], drafts: Record<string, GroupEditor> = {}): ProductGroupSession | null {
  const active = assets.find(asset => asset.id === activeId)
  if (!active?.productGroupId) return null
  const members = assets.filter(asset => asset.productGroupId === active.productGroupId)
    .sort((a, b) => {
      const ap = a.productGroupPosition ?? 0
      const bp = b.productGroupPosition ?? 0
      return ap > 0 && bp > 0 ? ap - bp : 0
    })
  const readEditor = (asset: Asset) => drafts[asset.id] ?? readGroupAssetEditor(asset)
  const savedLeader = members.find(asset => asset.id === active.productGroupLeaderId)
  // Legacy groups did not record a leader and sometimes saved identity on only one member.
  const leader = savedLeader ?? members.find(asset => groupingTrigger(readEditor(asset), products))
    ?? members.find(asset => asset.productId && asset.productId !== 'a') ?? members[0]
  const editor = readEditor(leader)
  const trigger = active.productGroupMode === 'free'
    ? { kind: 'free' as const, label: '自由图片组' }
    : groupingTrigger(editor, products) ?? { kind: 'product' as const, label: '产品组' }
  const free = trigger.kind === 'free'
  return {
    id: active.productGroupId, color: active.productGroupColor || leader.productGroupColor || newGroupColor(assets),
    leaderId: leader.id, activeId, memberIds: members.some(asset => (asset.productGroupPosition ?? 0) > 0)
      ? members.map(asset => asset.id)
      : [leader.id, ...members.filter(asset => asset.id !== leader.id).map(asset => asset.id)],
    editors: Object.fromEntries(members.map(asset => [asset.id, asset.id === leader.id ? editor : free ? readEditor(asset) : inheritGroupIdentity(readEditor(asset), editor, products)])),
    trigger,
  }
}

/** Repair old color-only members in memory. Rust writes them on the next explicit save. */
export function repairLegacyProductGroups(assets: Asset[], products: ProductConfig[]): Asset[] {
  const groups = new Map<string, Asset[]>()
  for (const asset of assets) if (asset.productGroupId) groups.set(asset.productGroupId, [...(groups.get(asset.productGroupId) ?? []), asset])
  const repaired = new Map<string, Asset>()
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const hasProduct = (asset: Asset) => asset.productId.startsWith('custom:')
      ? Boolean(asset.productName?.trim()) : products.some(product => product.id === asset.productId)
    const savedLeader = members.find(asset => asset.id === members[0].productGroupLeaderId && hasProduct(asset))
    const leader = savedLeader ?? members.find(asset => asset.attributesConfirmed && hasProduct(asset))
    if (!leader?.attributesConfirmed) continue
    const editor = readGroupAssetEditor(leader)
    const color = leader.productGroupColor || members.find(asset => asset.productGroupColor)?.productGroupColor || newGroupColor(assets)
    const mode = members.some(asset => asset.productGroupMode === 'free') ? 'free' as const : 'guided' as const
    for (const asset of members) {
      const missingProduct = !asset.productId || asset.productId === 'a'
      const next = missingProduct ? confirmGroupEditor(asset, readGroupAssetEditor(asset), editor, products) : asset
      if (next !== asset || asset.productGroupLeaderId !== leader.id || asset.productGroupColor !== color || asset.productGroupMode !== mode) repaired.set(asset.id, { ...next, productGroupLeaderId: leader.id, productGroupColor: color, productGroupMode: mode })
    }
  }
  return repaired.size ? assets.map(asset => repaired.get(asset.id) ?? asset) : assets
}

/** Ordinary selection edits per-image fields without reopening or changing group identity. */
export function applyGroupedAttributePatch(assets: Asset[], selectedIds: Set<string>, patch: ProductAttributePatch, products: ProductConfig[]): Asset[] {
  return assets.map(asset => {
    if (!selectedIds.has(asset.id)) return asset
    const next = { ...applyProductAttributePatch(asset, patch), attributesConfirmed: true }
    const group = asset.productGroupId ? restoreProductGroup(assets, asset.id, products) : null
    return group ? confirmGroupEditor(asset, readGroupAssetEditor(next), group.editors[group.leaderId], products, group.trigger.kind === 'free') : next
  })
}
