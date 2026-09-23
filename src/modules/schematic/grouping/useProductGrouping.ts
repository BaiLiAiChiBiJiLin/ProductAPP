import { createContext, useContext, useRef, useState } from 'react'
import type { Asset } from '../../../model'
import type { ProductConfig } from '../services/productConfigService'
import { emptyCustomProduct, saveCustomProduct } from '../services/customProductService'
import { emptyAttributeDraft } from '../services/attributeDraftService'
import { removeProductGroupMember } from './productGroupRemoval'
import { restoreProductGroup } from './productGroupRestore'
import { canSelectGroupAsset, initialGroupAssets } from './productGroupSelection'
import { applyProductGroup, copyEpoxy, groupSlotLabels, editorForGroupAsset, groupingTrigger, inheritGroupIdentity, newGroupColor, readGroupAssetEditor, updateGroupEditor, type GroupEditor, type ProductGroupSession } from './productGrouping'

type Props = { assets: Asset[]; products: ProductConfig[]; save: (assets: Asset[]) => Promise<void>; activate: (id: string | null, memberIds?: string[]) => void; revealAll: (category?: string) => void }
export function useProductGrouping({ assets, products, save, activate, revealAll }: Props) {
  const [session, setSession] = useState<ProductGroupSession | null>(null)
  const current = useRef(session)
  const [saving, setSaving] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const savingRef = useRef(false)
  const [error, setError] = useState('')
  const drafts = useRef<Record<string, GroupEditor>>({})
  const clearedEditors = useRef<Record<string, GroupEditor>>({})
  const dirty = useRef(new Set<string>())
  const commit = (next: ProductGroupSession | null) => { current.current = next; setSession(next) }
  const start = (editor: GroupEditor, selectedIds: string[], manual = false, allowConfirmed = false) => {
    if (current.current || savingRef.current || !selectedIds.length) return
    const trigger = manual ? { kind: 'free' as const, label: '自由图片组' } : groupingTrigger(editor, products)
    const members = initialGroupAssets(assets, selectedIds, manual || allowConfirmed)
    const leader = members.find(asset => selectedIds.includes(asset.id))
    if (!trigger || !leader) return
    const memberIds = members.map(asset => asset.id)
    const editors: Record<string, GroupEditor> = {}
    for (const id of memberIds) editors[id] = id === leader.id ? editor : manual
      ? readGroupAssetEditor(assets.find(asset => asset.id === id)!)
      : drafts.current[id] ? inheritGroupIdentity(drafts.current[id], editor, products) : editorForGroupAsset(assets.find(asset => asset.id === id)!, editor, products)
    for (const id of memberIds) editors[id] = copyEpoxy(editors[id], editors[leader.id])
    dirty.current = new Set(memberIds)
    const reuseGroup = leader.productGroupId && !assets.some(asset => asset.productGroupId === leader.productGroupId && !memberIds.includes(asset.id))
    commit({ id: reuseGroup ? leader.productGroupId! : crypto.randomUUID(), color: reuseGroup && leader.productGroupColor || newGroupColor(assets), leaderId: leader.id, activeId: leader.id, memberIds, editors, trigger })
    setError(''); revealAll(); activate(leader.id, memberIds)
  }
  const selectMember = (id: string, source: 'list' | 'thumbnail' = 'list') => {
    const group = current.current
    const asset = assets.find(item => item.id === id)
    if (!group || !asset || savingRef.current || !canSelectGroupAsset(asset, group.memberIds, source, group.trigger.kind === 'free')) return
    const exists = group.memberIds.includes(id)
    if (!exists) dirty.current.add(id)
    commit({ ...group, activeId: id, memberIds: exists ? group.memberIds : [...group.memberIds, id],
      editors: exists ? group.editors : { ...group.editors, [id]: copyEpoxy(group.trigger.kind === 'free' ? readGroupAssetEditor(asset) : editorForGroupAsset(asset, group.editors[group.leaderId], products), group.editors[group.leaderId]) } })
    setError(''); activate(id)
  }
  const reorderMembers = (fromId: string, toId: string) => {
    const group = current.current
    if (!group || savingRef.current || fromId === toId) return
    const from = group.memberIds.indexOf(fromId)
    const to = group.memberIds.indexOf(toId)
    if (from < 0 || to < 0) return
    const memberIds = [...group.memberIds]
    const [moved] = memberIds.splice(from, 1)
    memberIds.splice(to, 0, moved)
    commit({ ...group, memberIds, orderDirty: true })
  }
  const resumeGroup = (id: string) => {
    if (current.current || savingRef.current) return false
    const restored = restoreProductGroup(assets, id, products, drafts.current)
    if (!restored) return false
    dirty.current = new Set(restored.memberIds.filter(memberId => drafts.current[memberId] || !assets.find(asset => asset.id === memberId)?.attributesConfirmed))
    commit(restored); setError(''); revealAll(); activate(id, restored.memberIds)
    return true
  }
  const updateEditor = (editor: GroupEditor, assetId: string) => {
    const group = current.current
    if (group?.memberIds.includes(assetId) && !savingRef.current) {
      const next = { ...updateGroupEditor({ ...group, activeId: assetId }, editor, products), activeId: group.activeId }
      for (const id of group.memberIds) if (next.editors[id] !== group.editors[id]) dirty.current.add(id)
      commit(next)
    }
  }
  const persist = async (finish: boolean) => {
    const group = current.current
    if (!group || savingRef.current) return
    savingRef.current = true; setSaving(true); setError('')
    try {
      let prepared = group
      const active = group.editors[group.activeId]
      if (group.trigger.kind === 'free') {
        const editors = { ...group.editors }
        for (const id of group.memberIds) {
          const item = editors[id]
          if (item.mode !== 'custom' || !item.custom.name.trim()) continue
          const saved = await saveCustomProduct(item.custom)
          editors[id] = { ...item, custom: saved }
        }
        prepared = { ...group, editors }
        commit(prepared)
      } else if (active.mode === 'custom') {
        const saved = await saveCustomProduct(active.custom)
        prepared = { ...group, editors: Object.fromEntries(group.memberIds.map(id => [id, { ...group.editors[id], custom: { ...group.editors[id].custom, id: saved.id } }])) }
        commit(prepared)
      }
      const persisted = applyProductGroup(assets, prepared, products)
      await save(persisted)
      for (const id of prepared.memberIds) { dirty.current.delete(id); delete drafts.current[id]; delete clearedEditors.current[id] }
      commit(finish ? null : { ...prepared, editors: Object.fromEntries(prepared.memberIds.map(id => [id, readGroupAssetEditor(persisted.find(asset => asset.id === id)!)])) })
    } catch (reason) { setError(`保存失败：${String(reason)}`) }
    finally { savingRef.current = false; setSaving(false) }
  }
  // Leaving is not removal: keep the last saved group and abandon only unsaved guide edits.
  const cancelGuide = () => {
    if (savingRef.current) return
    for (const id of current.current?.memberIds ?? []) { delete drafts.current[id]; dirty.current.delete(id) }
    commit(null); setError(''); activate(null)
  }
  const removeMember = async (id: string) => {
    const group = current.current
    if (!group?.memberIds.includes(id) || savingRef.current) return
    savingRef.current = true; setSaving(true); setRemovingId(id); setError('')
    try {
      const next = removeProductGroupMember(assets, group, id, products)
      await save(next.assets)
      delete drafts.current[id]; dirty.current.delete(id)
      const asset = next.assets.find(item => item.id === id)
      // Explicitly cleared cards must not inherit the last edited form on reselect.
      clearedEditors.current[id] = { mode: 'existing', draft: { ...emptyAttributeDraft(), note: asset?.note ?? '', noteImage: asset?.noteImage ?? '' }, custom: emptyCustomProduct() }
      commit(next.session)
      activate(next.session?.activeId ?? null)
    } catch (reason) { setError(`移除失败：${String(reason)}`) }
    finally { savingRef.current = false; setSaving(false); setRemovingId(null) }
  }
  const reset = () => { commit(null); drafts.current = {}; clearedEditors.current = {}; dirty.current.clear(); setError('') }
  const readDraft = (id: string) => drafts.current[id] ?? clearedEditors.current[id]
  const rememberDraft = (id: string, editor: GroupEditor) => {
    if (drafts.current[id]) drafts.current[id] = editor
    if (clearedEditors.current[id]) clearedEditors.current[id] = editor
  }
  const isPending = (id: string) => Boolean(drafts.current[id]) || Boolean(current.current && dirty.current.has(id))
  const clearDrafts = (ids: string[]) => ids.forEach(id => { delete drafts.current[id]; delete clearedEditors.current[id] })
  return { session, slotLabels: session ? groupSlotLabels(session, products) : null, saving, removingId, error, start, resumeGroup, selectMember, reorderMembers, removeMember, updateEditor, persist, cancelGuide, reset, readDraft, rememberDraft, isPending, clearDrafts }
}

export type ProductGroupingController = ReturnType<typeof useProductGrouping>
export const ProductGroupingContext = createContext<ProductGroupingController | null>(null)
export const useProductGroup = () => useContext(ProductGroupingContext)
