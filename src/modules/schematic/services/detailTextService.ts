import type { Page } from '../../../model.ts'
import type { ImageDetails } from '../layoutTypes.ts'

export type DetailTextSelection = { kind: 'detail'; id: string; groupId: string; panelItemIds: string[]; fieldKey: string }
export type DetailTextDraft = DetailTextSelection & { text: string; fontSize: number; color: string }
export type DetailTextOverride = NonNullable<ImageDetails['textOverrides']>[string]

const sameMembers = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id))
export function detailTextSelection(groupId: string, panelItemIds: string[], fieldKey: string): DetailTextSelection {
  return { kind: 'detail', id: JSON.stringify([groupId, [...panelItemIds].sort(), fieldKey]), groupId, panelItemIds: [...panelItemIds], fieldKey }
}

/** Match the real panel by membership instead of its generated display index. */
export function updateDetailText(page: Page, selection: DetailTextSelection, patch: DetailTextOverride): Page {
  return { ...page, imageGroups: page.imageGroups?.map(group => {
    if (group.id !== selection.groupId) return group
    const update = (details: ImageDetails): ImageDetails => ({ ...details,
      textOverrides: { ...details.textOverrides, [selection.fieldKey]: { ...details.textOverrides?.[selection.fieldKey], ...patch } } })
    if (group.detailGroups?.length) return { ...group, detailGroups: group.detailGroups.map(panel => sameMembers(panel.itemIds, selection.panelItemIds) ? { ...panel, details: update(panel.details) } : panel) }
    return group.details && sameMembers(group.itemIds, selection.panelItemIds) ? { ...group, details: update(group.details) } : group
  }) }
}
