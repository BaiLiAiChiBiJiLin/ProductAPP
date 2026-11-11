import type { ImageGroup } from '../layoutTypes'
import { isHiddenAttributeValue } from './attributeDisplayService.ts'

/** Older review snapshots already contain joined material/process labels. */
const visibleFinish = (value: string | undefined) => {
  const original = value?.trim() ?? ''
  let hidden = false
  const parts = original.replace(/^\s*\d+\s*\/\s*/, '').split('/').map(part => {
    const words = part.trim().split(/\s+/)
    if (!isHiddenAttributeValue(words.slice(-3).join(' '))) return part.trim()
    hidden = true
    return words.slice(0, -3).join(' ')
  })
  return hidden ? parts.filter(Boolean).join(' / ') : original
}

export function finishLabel(group: ImageGroup) {
  const values = [...new Set((group.detailGroups?.map(panel => panel.details.finish) ?? [group.details?.finish]).map(visibleFinish).filter(Boolean))]
  const text = values.join(' / ').replace(/[\r\n]+/g, ' ')
  const width = Math.max(1, group.width - 8)
  return { text, x: group.x + 4, y: group.y + (group.backgroundHeight ?? group.height) - 14, width }
}
