import { accessoryFrame } from './accessoryFrameService.ts'
import { GROUP_GAP, type Item, type Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { imageDetailsLayout } from './imageDetailsLayoutService.ts'
import { detailPanelsForGroup } from '../arrangement/productGroupDetails.ts'
import { finishLabel } from './finishLabelService.ts'

export const GROUP_BACKGROUND = '#D4E9D8'

/** Explicit extension keeps row whitespace painted independently of content bounds. */
export function groupBackgroundRects(group: ImageGroup) {
  const height = Math.max(group.height, group.backgroundHeight ?? group.height)
  const rects = [{ x: group.x, y: group.y, width: group.width, height: group.height }]
  if (height > group.height) rects.push({ x: group.x, y: group.y + group.height, width: group.width, height: height - group.height })
  return rects
}

/** Legacy and freely dropped items still receive a background until rearranged. */
export function itemBackground(item: Item): ImageGroup {
  const angle = item.rotation * Math.PI / 180
  const width = Math.abs(Math.cos(angle)) * item.w + Math.abs(Math.sin(angle)) * item.h
  const height = Math.abs(Math.sin(angle)) * item.w + Math.abs(Math.cos(angle)) * item.h
  return { id: `group-${item.id}`, itemIds: [item.id], x: item.x - width / 2 - GROUP_GAP, y: item.y - height / 2 - GROUP_GAP, width: width + GROUP_GAP * 2, height: height + GROUP_GAP * 2 }
}

export function imageGroupsForPage(page: Page): ImageGroup[] {
  const ids = new Set(page.items.map(item => item.id))
  const groups = (page.imageGroups ?? []).filter(group => group.itemIds.some(id => ids.has(id)))
  const grouped = new Set(groups.flatMap(group => group.itemIds))
  return equalizeRowBackgrounds([...groups, ...page.items.filter(item => !grouped.has(item.id)).map(itemBackground)])
}

/** Equal top edges define a row. Never paint over another group's occupied area. */
export function equalizeRowBackgrounds(groups: ImageGroup[]): ImageGroup[] {
  const tolerance = 0.1
  return groups.map(group => {
    const row = groups.filter(other => Math.abs(other.y - group.y) <= tolerance)
    const bottom = Math.max(...row.map(other => other.y + other.height))
    const obstructed = row.some(member => groups.some(other => !row.includes(other)
      && other.x < member.x + member.width - tolerance && other.x + other.width > member.x + tolerance
      && other.y < bottom - tolerance && other.y + other.height > member.y + member.height + tolerance))
    return { ...group, backgroundHeight: obstructed ? group.height : bottom - group.y }
  })
}

export function groupBackgroundsSvg(page: Page): string {
  const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] ?? character))
  return `<g data-image-group-backgrounds="true" fill="${GROUP_BACKGROUND}">${imageGroupsForPage(page).map(group => {
    const multipleDetails = Boolean(group.detailGroups?.length)
    const label = finishLabel(group)
    const footer = label.text ? `<text x="${label.x + label.width}" y="${label.y + 10}" text-anchor="end" font-family="Arial, Microsoft YaHei, sans-serif" font-size="10" fill="#ff4d4f">${escape(label.text)}</text>` : ''
    const panels = detailPanelsForGroup(group).map(panel => {
    const group = panel
    const details = group.details
    const { x, y, line, fontSize, fields, bodyY, imageSize, noteX, noteY, noteLines, noteLine, noteFontSize, noteImageSize, noteImageY } = imageDetailsLayout(group)
    const fieldText = fields.map((field, index) => `<text x="${x}" y="${y + line * (index + 1) - 2}" font-family="Arial, Microsoft YaHei, sans-serif" font-size="${Math.min(fontSize, field.fontSize ?? fontSize)}" font-weight="700" fill="#475569">${escape(field.text)}</text>`).join('')
    const noteText = noteLines.map((value, index) => `<text x="${noteX}" y="${noteY + index * noteLine + noteLine - 2}" font-family="Arial, Microsoft YaHei, sans-serif" font-size="${noteFontSize}" fill="#475569">${escape(value)}</text>`).join('')
    const frame = accessoryFrame(details?.accessoryImage ?? '', x, bodyY, imageSize, details?.accessoryCode)
    const text = details ? `${fieldText}${details.accessoryImage ? `<rect x="${frame.x}" y="${frame.y}" width="${frame.frameWidth}" height="${frame.frameHeight}" rx="1" fill="#fff"/><svg x="${frame.imageX}" y="${frame.imageY}" width="${frame.width}" height="${frame.height}" viewBox="${frame.crop.x} ${frame.crop.y} ${frame.crop.width} ${frame.crop.height}" overflow="hidden"><image data-printflow-accessory="true" width="${frame.natural.width}" height="${frame.natural.height}" href="${escape(details.accessoryImage)}"/></svg>${details.accessoryCode ? `<text x="${x + imageSize / 2}" y="${frame.codeY + 9}" text-anchor="middle" font-family="Arial, Microsoft YaHei, sans-serif" font-size="8" font-weight="700" fill="#475569">${escape(details.accessoryCode)}</text>` : ''}` : ''}${noteText}${details.noteImage && noteImageSize > 0 ? `<image data-printflow-note="true" x="${noteX}" y="${noteImageY}" width="${noteImageSize}" height="${noteImageSize}" preserveAspectRatio="xMidYMid meet" href="${escape(details.noteImage)}"/>` : ''}` : ''
    return details ? multipleDetails ? `<g data-printflow-details="true">${text}</g>` : text : ''
    }).join('')
    const background = groupBackgroundRects(group).map(rect => `<rect data-group-background="${escape(group.id)}" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="${GROUP_BACKGROUND}"/>`).join('')
    return `${background}${panels}${footer}`
  }).join('')}</g>`
}
