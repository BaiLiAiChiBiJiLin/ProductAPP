import type { ImageGroup } from '../layoutTypes'
export function finishLabel(group: ImageGroup) {
  const values = [...new Set((group.detailGroups?.map(panel => panel.details.finish) ?? [group.details?.finish]).map(value => value?.trim()).filter(Boolean))]
  const text = values.join(' / ').replace(/[\r\n]+/g, ' ')
  const width = Math.max(1, group.width - 8)
  return { text, x: group.x + 4, y: group.y + (group.backgroundHeight ?? group.height) - 14, width }
}
