import type { Asset } from '../../../model'
import type { ProductConfig } from '../services/productConfigService'
import { applyGroupMembership, groupingTrigger, type ProductGroupSession } from './productGrouping.ts'

/** Remove membership and product data together; keep the artwork and independent notes. */
export function removeProductGroupMember(assets: Asset[], session: ProductGroupSession, id: string, products: ProductConfig[]) {
  if (!session.memberIds.includes(id)) return { assets, session }
  const memberIds = session.memberIds.filter(memberId => memberId !== id)
  const editors = Object.fromEntries(memberIds.map(memberId => [memberId, session.editors[memberId]]))
  const leaderId = session.leaderId === id ? memberIds[0] : session.leaderId
  const activeId = session.activeId === id ? memberIds[Math.min(session.memberIds.indexOf(id), memberIds.length - 1)] : session.activeId
  const next: ProductGroupSession | null = memberIds.length ? {
    ...session, memberIds, editors, leaderId, activeId,
    trigger: groupingTrigger(editors[leaderId], products) ?? session.trigger,
  } : null
  const cleared = assets.map(asset => asset.id === id ? {
    ...asset, productId: 'a', productName: '', attributes: {}, attributeImages: {},
    attributesConfirmed: false, productGroupId: '', productGroupColor: '', productGroupLeaderId: '', ...(asset.productGroupPosition !== undefined ? { productGroupPosition: 0 } : {}),
  } : asset)
  return { assets: next ? applyGroupMembership(cleared, next) : cleared, session: next }
}
