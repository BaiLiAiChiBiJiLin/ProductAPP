import { DETAIL_ACCESSORY_SIZE_RATIO, DETAIL_LABEL_FONT_SIZE, DETAIL_LINE_HEIGHT, DETAIL_NOTE_IMAGE_SIZE_RATIO } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'

/** Arial bold advances for the numeric Size label, with a little font fallback slack. */
export function sizeLabelWidth(label: string, fontSize = DETAIL_LABEL_FONT_SIZE) {
  const advances: Record<string, number> = { S: .667, i: .278, z: .5, e: .556, ':': .333, ' ': .278, '.': .278, m: .889, c: .556, n: .611 }
  return [...`Size: ${label}`].reduce((sum, char) => sum + (advances[char] ?? .611), 0) * fontSize + 3
}

export function wrapNote(note: string, width: number, fontSize: number) {
  const measure = (character: string) => fontSize * (/[^\u0000-\u00ff]/.test(character) ? 1 : 0.6)
  const lines: string[] = []
  let line = ''
  let used = 0
  for (const character of note.replace(/\r\n/g, '\n')) {
    const size = measure(character)
    if (character === '\n' || (line && used + size > width)) {
      lines.push(line)
      line = ''
      used = 0
    }
    if (character !== '\n') { line += character; used += size }
  }
  if (line) lines.push(line)
  return lines
}

/** One geometry calculation for Konva and exported SVG, contained in the details half. */
export function imageDetailsLayout(group: ImageGroup) {
  const details = group.details
  const fields: { key: string; text: string; fontSize?: number }[] = []
  if (details) {
    if (details.heading) fields.push({ key: 'heading', text: details.heading })
    const size = details.size?.trim()
    if (details.sizes?.length) details.sizes.forEach((value, index) => fields.push({ key: `size-${index}`, text: `Size: ${value.label}` }))
    else if (size) fields.push({ key: 'size', text: `Size: ${size}` })
    fields.push({ key: 'qt', text: `QT: ${details.qt || '-'}` })
    if (details.fields) fields.push(...details.fields)
  }
  const detailsX = group.detailsX ?? group.x + group.width / 2
  const detailPanelWidth = group.detailWidth ?? group.width / 2
  const x = detailsX + 4
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
  const bodyHeight = Math.max(0, group.height - 8 - fields.length * line)
  const hasNote = !!details?.note?.trim() || !!details?.noteImage
  const accessoryExtra = details?.accessoryImage ? (details.accessoryCode ? 14 : 4) : 0
  const desiredAccessorySize = details?.accessoryImage ? Math.min(Math.max(1, width - 4), group.height * DETAIL_ACCESSORY_SIZE_RATIO) : 0
  const besideImageSize = Math.max(0, Math.min(desiredAccessorySize, bodyHeight - accessoryExtra))
  // Leave 4 units between the accessory's white backing and the note column.
  const besideWidth = width - besideImageSize - 6
  if (details?.accessoryImage && hasNote && besideWidth >= 24) {
    const noteX = x + besideImageSize + 6
    const noteY = bodyY
    let noteFontSize = Math.min(8, fontSize)
    let noteLine = Math.min(noteFontSize + 2, line)
    let noteLines = details.note?.trim() ? wrapNote(details.note, besideWidth, noteFontSize) : []
    const noteImageGap = details.noteImage && noteLines.length ? 2 : 0
    const desiredNoteImageSize = details.noteImage ? Math.min(besideWidth, group.height * DETAIL_NOTE_IMAGE_SIZE_RATIO, bodyHeight) : 0
    const textRoom = Math.max(1, bodyHeight - desiredNoteImageSize - noteImageGap)
    while (noteLines.length * noteLine > textRoom && noteFontSize > 0.5) {
      noteFontSize = Math.max(0.5, noteFontSize - 0.25)
      noteLine = noteFontSize * 1.25
      noteLines = wrapNote(details.note!, besideWidth, noteFontSize)
    }
    const noteImageY = noteY + noteLines.length * noteLine + noteImageGap
    const noteImageSize = Math.max(0, Math.min(desiredNoteImageSize, group.y + group.height - 4 - noteImageY))
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
  const desiredNoteImageSize = details?.noteImage ? Math.min(width, group.height * DETAIL_NOTE_IMAGE_SIZE_RATIO) : 0
  const gap = hasNote ? 2 : 0
  const noteImageGap = details?.noteImage && noteLines.length ? 2 : 0
  const available = Math.max(0, bodyHeight - noteLines.length * noteLine - accessoryExtra - gap - noteImageGap)
  const scale = Math.min(1, available / Math.max(1, desiredAccessorySize + desiredNoteImageSize))
  const imageSize = desiredAccessorySize * scale
  const noteImageSize = desiredNoteImageSize * scale
  const accessoryHeight = imageSize + accessoryExtra
  const noteY = bodyY + accessoryHeight + gap
  return { x, y, width, line, fontSize, fields, bodyY, imageSize, accessoryHeight, noteX: x, noteWidth: width, noteY, noteLines, noteFontSize, noteLine, noteImageSize, noteImageY: noteY + noteLines.length * noteLine + noteImageGap }
}

