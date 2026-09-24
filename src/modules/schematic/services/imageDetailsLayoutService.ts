import { DETAIL_ACCESSORY_SIZE_RATIO, DETAIL_LABEL_FONT_SIZE, DETAIL_LINE_HEIGHT, DETAIL_NOTE_IMAGE_SIZE_RATIO } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { accessoryTopGap } from './accessoryFrameService.ts'

/** Arial bold advances for the numeric Size label, with a little font fallback slack. */
export function sizeLabelWidth(label: string, fontSize = DETAIL_LABEL_FONT_SIZE) {
  const advances: Record<string, number> = { S: .667, i: .278, z: .5, e: .556, ':': .333, ' ': .278, '.': .278, m: .889, c: .556, n: .611 }
  return [...`Size: ${label}`].reduce((sum, char) => sum + (advances[char] ?? .611), 0) * fontSize + 3
}

export function wrapNote(note: string, width: number, fontSize: number) {
  const measure = (character: string) => fontSize * (/[^\u0000-\u00ff]/.test(character) ? 1 : 0.6)
  const lines: string[] = []
  const pushLine = (value: string) => { if (value.trim()) lines.push(value.trim()) }
  for (const paragraph of note.replace(/\r\n/g, '\n').split('\n')) {
    let line = ''
    let used = 0
    // Keep Latin words intact while allowing Chinese text to wrap by
    // character. This avoids splitting product codes and finish names.
    const tokens = paragraph.match(/[\u4e00-\u9fff]|[^\s\u4e00-\u9fff]+|\s+/g) ?? []
    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        if (line) { line += ' '; used += measure(' ') }
        continue
      }
      const size = [...token].reduce((sum, character) => sum + measure(character), 0)
      if (line && used + size > width) { pushLine(line); line = ''; used = 0 }
      // Keep a long word intact even when it is wider than the column.
      line += token
      used += size
    }
    pushLine(line)
  }
  return lines
}
export function quantityLabel(value?: string) {
  const quantity = value?.trim() ?? ''
  return quantity && Number(quantity) !== 0 ? `QT: ${quantity}` : 'QT:'
}

/** One geometry calculation for Konva and exported SVG, contained in the details half. */
export function imageDetailsLayout(group: ImageGroup, visualScale = 1) {
  const displayScale = Number.isFinite(visualScale) && visualScale > 0 ? visualScale : 1
  const details = group.details
  const fields: { key: string; text: string; fontSize?: number }[] = []
  if (details) {
    if (details.heading) fields.push({ key: 'heading', text: details.heading })
    const size = details.size?.trim()
    if (details.sizes?.length) details.sizes.forEach((value, index) => fields.push({ key: `size-${index}`, text: `Size: ${value.label}` }))
    else if (size) fields.push({ key: 'size', text: `Size: ${size}` })
    fields.push({ key: 'qt', text: quantityLabel(details.qt) })
    if (details.fields) fields.push(...details.fields)
  }
  // The details panel belongs to the group's right edge. Older/reflowed
  // groups may retain a stale detailsX or an oversized detailWidth, so clamp
  // both values before laying out text and accessory images.
  const groupRight = group.x + group.width
  const requestedWidth = group.detailWidth ?? group.width / 2
  const detailPanelWidth = Math.min(Math.max(1, requestedWidth), Math.max(1, group.width - 1))
  const requestedX = group.detailsX ?? groupRight - detailPanelWidth
  const detailsX = Math.max(group.x, Math.min(requestedX, groupRight - detailPanelWidth))
  const x = Math.min(groupRight - 1, detailsX + 4)
  const y = group.y + 4
  const width = Math.max(1, detailPanelWidth - 8)
  // Product groups may contain longer product names/individual option lists.
  // Wrap those fields instead of truncating them in Canvas or overflowing SVG.
  if (details) {
    const wrapped = fields.flatMap(field => field.key.startsWith('size')
      ? [field]
      : wrapNote(field.text, width, DETAIL_LABEL_FONT_SIZE).map((text, index) => ({ key: `${field.key}-${index}`, text })))
    fields.splice(0, fields.length, ...wrapped)
  }
  const line = Math.max(1, Math.min(DETAIL_LINE_HEIGHT, (group.height - 8) / Math.max(6, fields.length + 2)))
  const fontSize = Math.max(1, Math.min(DETAIL_LABEL_FONT_SIZE, line - 1))
  const bodyY = y + fields.length * line
  // Finish/process is painted along the bottom edge of the group. Reserve a
  // line for it so wrapped notes always remain above that label.
  const hasFinish = Boolean(group.details?.finish?.trim()) || Boolean(group.detailGroups?.some(panel => panel.details.finish?.trim()))
  const finishReserve = hasFinish ? 18 : 0
  const contentHeight = Math.max(group.height, group.backgroundHeight ?? group.height)
  const bodyHeight = Math.max(0, contentHeight - 8 - fields.length * line - finishReserve)
  const hasNote = !!details?.note?.trim() || !!details?.noteImage
  const accessoryExtra = details?.accessoryImage ? (details.accessoryCode ? 14 : 4) + accessoryTopGap(details.accessoryImage) : 0
  const desiredAccessorySize = details?.accessoryImage ? Math.min(Math.max(1, width - 4), group.height * DETAIL_ACCESSORY_SIZE_RATIO * displayScale) : 0
  const besideImageSize = Math.max(0, Math.min(desiredAccessorySize, bodyHeight - accessoryExtra))
  // Leave 4 units between the accessory's white backing and the note column.
  const besideWidth = width - besideImageSize - 6
  if (details?.accessoryImage && hasNote && besideWidth >= 24) {
    const noteX = x + besideImageSize + 6
    let noteFontSize = Math.min(8, fontSize)
    let noteLine = Math.min(noteFontSize + 2, line)
    let noteLines = details.note?.trim() ? wrapNote(details.note, besideWidth, noteFontSize) : []
    const noteImageGap = details.noteImage && noteLines.length ? 2 : 0
    const desiredNoteImageSize = details.noteImage ? Math.min(besideWidth, contentHeight * DETAIL_NOTE_IMAGE_SIZE_RATIO * displayScale, bodyHeight) : 0
    const textRoom = Math.max(1, bodyHeight - desiredNoteImageSize - noteImageGap)
    while (noteLines.length * noteLine > textRoom && noteFontSize > 0.5) {
      noteFontSize = Math.max(0.5, noteFontSize - 0.25)
      noteLine = noteFontSize * 1.25
      noteLines = wrapNote(details.note!, besideWidth, noteFontSize)
    }
    const noteBlockHeight = noteLines.length * noteLine + noteImageGap + desiredNoteImageSize
    // Keep the note immediately above the process/finish label. This also
    // prevents a short note from floating at the top while the process sits
    // at the bottom of the group.
    const noteY = bodyY + Math.max(0, bodyHeight - noteBlockHeight)
    const noteImageY = noteY + noteLines.length * noteLine + noteImageGap
    const noteImageSize = Math.max(0, Math.min(desiredNoteImageSize, group.y + contentHeight - 4 - noteImageY))
    return { x, y, width, line, fontSize, fields, bodyY, imageSize: besideImageSize, accessoryHeight: besideImageSize + accessoryExtra,
      noteX, noteWidth: besideWidth, noteY, noteLines, noteFontSize, noteLine, noteImageSize, noteImageY }
  }
  let noteFontSize = Math.min(8, fontSize)
  let noteLine = Math.min(noteFontSize + 2, line)
  let noteLines = details?.note?.trim() ? wrapNote(details.note, width, noteFontSize) : []
  // Retain the full note. Long notes reduce their own type size to fit the
  // remaining area, without shrinking artwork or cutting off production text.
  const reservedImages = (details?.accessoryImage ? 8 + (details.accessoryCode ? 14 : 4) : 0) + (details?.noteImage ? 10 : 0)
  const textRoom = Math.max(1, bodyHeight - reservedImages - 2)
  while (noteLines.length * noteLine > textRoom && noteFontSize > 0.5) {
    noteFontSize = Math.max(0.5, noteFontSize - 0.25)
    noteLine = noteFontSize * 1.25
    noteLines = wrapNote(details!.note!, width, noteFontSize)
  }
  const desiredNoteImageSize = details?.noteImage ? Math.min(width, contentHeight * DETAIL_NOTE_IMAGE_SIZE_RATIO * displayScale) : 0
  const gap = hasNote ? 2 : 0
  const noteImageGap = details?.noteImage && noteLines.length ? 2 : 0
  const available = Math.max(0, bodyHeight - noteLines.length * noteLine - accessoryExtra - gap - noteImageGap)
  const scale = Math.min(1, available / Math.max(1, desiredAccessorySize + desiredNoteImageSize))
  const imageSize = desiredAccessorySize * scale
  const noteImageSize = desiredNoteImageSize * scale
  const accessoryHeight = imageSize + accessoryExtra
  const noteBlockHeight = noteLines.length * noteLine + noteImageGap + noteImageSize
  const noteY = bodyY + Math.max(0, bodyHeight - noteBlockHeight)
  return { x, y, width, line, fontSize, fields, bodyY, imageSize, accessoryHeight, noteX: x, noteWidth: width, noteY, noteLines, noteFontSize, noteLine, noteImageSize, noteImageY: noteY + noteLines.length * noteLine + noteImageGap }
}

