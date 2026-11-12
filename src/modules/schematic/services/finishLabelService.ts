import type { ImageGroup } from '../layoutTypes'
import { isHiddenAttributeValue } from './attributeDisplayService.ts'

export const FINISH_LABEL_FONT_SIZE = 10
export const FINISH_LABEL_LINE_HEIGHT = 11
export const FINISH_LABEL_BOTTOM_GAP = 4

/** Older review snapshots already contain joined material/process labels. */
const visibleFinishLines = (value: string | undefined) => {
  const original = value?.trim() ?? ''
  if (!original) return []
  const lines: string[] = []
  for (const sourceLine of original.replace(/\r\n/g, '\n').split('\n')) {
    const parts = sourceLine.replace(/^\s*\d+\s*\/\s*/, '').split('/')
    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const words = trimmed.split(/\s+/)
      if (isHiddenAttributeValue(words.slice(-3).join(' '))) {
        const visible = words.slice(0, -3).join(' ').trim()
        if (visible) lines.push(visible)
      } else lines.push(trimmed)
    }
  }
  return lines
}

export function finishLabelHeight(lines: number) {
  return lines > 0 ? FINISH_LABEL_FONT_SIZE + Math.max(0, lines - 1) * FINISH_LABEL_LINE_HEIGHT : 0
}

export function finishLabelReserve(lines: number) {
  const height = finishLabelHeight(lines)
  return height ? height + FINISH_LABEL_BOTTOM_GAP * 2 : 0
}

export function finishLabelValueReserve(value: string | undefined) {
  return finishLabelReserve(visibleFinishLines(value).length)
}

export function finishLabel(group: ImageGroup) {
  const lines: string[] = []
  for (const value of group.detailGroups?.map(panel => panel.details.finish) ?? [group.details?.finish]) {
    for (const line of visibleFinishLines(value)) {
      if (!lines.some(existing => existing.trim().toLowerCase() === line.trim().toLowerCase())) lines.push(line)
    }
  }
  const text = lines.join('\n')
  const height = finishLabelHeight(lines.length)
  const width = Math.max(1, group.width - 8)
  const bottom = group.y + (group.backgroundHeight ?? group.height)
  return { text, lines, lineHeight: FINISH_LABEL_LINE_HEIGHT, height, x: group.x + 4, y: bottom - FINISH_LABEL_BOTTOM_GAP - height, width }
}
