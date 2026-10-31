import { DETAIL_ACCESSORY_SIZE_RATIO, DETAIL_AREA_RATIO, DETAIL_LABEL_FONT_SIZE, DETAIL_LINE_HEIGHT, type NoteImage } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { accessoryTopGap } from './accessoryFrameService.ts'
import { DEFAULT_NOTE_COLOR, DEFAULT_NOTE_FONT_SIZE, getNoteImages } from './assetNotesService.ts'

/** Stack complete title/image blocks vertically in the available note column. */
function noteImageBoxes(images: NoteImage[], x: number, y: number, width: number, height: number) {
  if (!images.length || height <= 0) return []
  const gap = Math.min(4, height / (images.length * 8))
  const cellHeight = Math.max(0, (height - gap * (images.length - 1)) / images.length)
  return images.map((image, index) => {
    const captionHeight = image.name ? Math.min(10, cellHeight / 4) : 0
    const size = Math.max(0, Math.min(width, cellHeight - captionHeight))
    return { ...image, x: x + (width - size) / 2,
      y: y + index * (cellHeight + gap) + (cellHeight - captionHeight - size) / 2 + captionHeight, size, captionHeight,
      captionFontSize: image.name ? Math.min(8, captionHeight / 1.25, size / Math.max(1, [...image.name].reduce((total, char) => total + (/[^\u0000-\u00ff]/.test(char) ? 1 : .6), 0))) : 0,
    }
  })
}

/** Conservative normal Arial advances, including font fallback slack. */
function detailLabelWidth(text: string, fontSize: number) {
  const advances: Record<string, number> = { S: .667, i: .222, z: .5, e: .556, ':': .278, ' ': .278, '.': .278, m: .833, c: .5, n: .556, Q: .778, T: .611 }
  return [...text].reduce((sum, char) => sum + (advances[char] ?? (/[^\u0000-\u00ff]/.test(char) ? 1 : .611)), 0) * fontSize + 3
}

export function sizeLabelWidth(label: string, fontSize = DETAIL_LABEL_FONT_SIZE) {
  return detailLabelWidth(`Size: ${label}`, fontSize)
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

/** One geometry calculation for Konva and exported SVG, contained in the details panel. */
export function imageDetailsLayout(group: ImageGroup, visualScale = 1) {
  const displayScale = Number.isFinite(visualScale) && visualScale > 0 ? visualScale : 1
  const details = group.details
  const images = getNoteImages(details ?? {})
  const fields: { key: string; text: string; fontSize?: number; color?: string; editKey?: string }[] = []
  if (details) {
    if (details.heading) fields.push({ key: 'heading', text: details.heading })
    const size = details.size?.trim()
    if (details.sizes?.length) details.sizes.forEach((value, index) => fields.push({ key: `size-${index}`, editKey: `size:${value.itemId}`, text: `Size: ${value.label}` }))
    else if (size) fields.push({ key: 'size', editKey: 'size', text: `Size: ${size}` })
    fields.push({ key: 'qt', editKey: 'qt', text: quantityLabel(details.qt) })
    if (details.fields) fields.push(...details.fields)
    const edited = fields.flatMap(field => {
      const override = field.editKey ? details.textOverrides?.[field.editKey] : undefined
      if (override?.hidden) return []
      return [{ ...field, text: override?.text ?? field.text, color: override?.color,
        fontSize: Number.isFinite(override?.fontSize) ? Math.max(6, Math.min(72, override!.fontSize!)) : field.fontSize }]
    })
    fields.splice(0, fields.length, ...edited)
  }
  // The details panel belongs to the group's right edge. Older/reflowed
  // groups may retain a stale detailsX or an oversized detailWidth, so clamp
  // both values before laying out text and accessory images.
  const groupRight = group.x + group.width
  const requestedWidth = group.detailWidth ?? group.width * DETAIL_AREA_RATIO
  const detailPanelWidth = Math.min(Math.max(1, requestedWidth), Math.max(1, group.width - 1))
  const requestedX = group.detailsX ?? groupRight - detailPanelWidth
  const detailsX = Math.max(group.x, Math.min(requestedX, groupRight - detailPanelWidth))
  const x = Math.min(groupRight - 1, detailsX + 4)
  const y = group.y + 4
  const width = Math.max(1, detailPanelWidth - 8)
  // Standee bases and holder role rows reserve the rest of the group. A
  // background extended to the row bottom must not enlarge that details slot.
  const contentHeight = group.detailsHeight === undefined
    ? Math.max(group.height, group.backgroundHeight ?? group.height)
    : Math.min(group.height, group.detailsHeight)
  // Product groups may contain longer product names/individual option lists.
  // Wrap those fields instead of truncating them in Canvas or overflowing SVG.
  if (details) {
    const wrapped = fields.flatMap(field => field.key.startsWith('size') || field.key === 'qt'
      ? [field]
      : wrapNote(field.text, width, DETAIL_LABEL_FONT_SIZE).map((text, index) => ({ key: `${field.key}-${index}`, text })))
    fields.splice(0, fields.length, ...wrapped)
  }
  const maximumLine = Math.max(1, Math.min(DETAIL_LINE_HEIGHT, (contentHeight - 8) / Math.max(6, fields.length + 2)))
  const maximumFont = Math.max(1, Math.min(DETAIL_LABEL_FONT_SIZE, maximumLine - 1))
  const widestLabel = Math.max(0, ...fields.filter(field => field.fontSize === undefined && (field.key.startsWith('size') || field.key === 'qt')).map(field => detailLabelWidth(field.text, maximumFont)))
  // Size and QT share a font size, stay complete on one line, and retain their
  // stable edit keys even in a narrow column or with many decimal places.
  const fontSize = Math.max(0.5, maximumFont * Math.min(1, Math.max(0, width - 3.01) / Math.max(1, widestLabel - 3)))
  const line = Math.min(maximumLine, fontSize + Math.max(1, DETAIL_LINE_HEIGHT - DETAIL_LABEL_FONT_SIZE))
  let fieldHeight = 0
  const displayFields = fields.map(field => {
    const requestedFont = field.fontSize ?? fontSize
    const lines = field.text.replace(/\r\n/g, '\n').split('\n')
    const widest = Math.max(1, ...lines.map(value => detailLabelWidth(value, requestedFont) - 3))
    const effectiveFont = Math.max(.5, requestedFont * Math.min(1, Math.max(1, width - 3) / widest))
    const lineHeight = field.fontSize === undefined ? line : Math.max(line, effectiveFont * 1.2)
    const height = lineHeight * lines.length
    const result = { ...field, fontSize: effectiveFont, color: field.color ?? (field.editKey ? '#000' : '#475569'), y: fieldHeight, height, lineHeight, lines }
    fieldHeight += height
    return result
  })
  const bodyY = y + fieldHeight
  // Finish/process is painted along the bottom edge of the group. Reserve a
  // line for it so wrapped notes always remain above that label.
  const hasFinish = Boolean(group.details?.finish?.trim()) || Boolean(group.detailGroups?.some(panel => panel.details.finish?.trim()))
  const finishReserve = hasFinish ? 18 : 0
  const bodyHeight = Math.max(0, contentHeight - 8 - fieldHeight - finishReserve)
  const accessoryExtra = details?.accessoryImage ? (details.accessoryCode ? 17 : 4) + accessoryTopGap(details.accessoryImage) : 0
  const desiredAccessorySize = details?.accessoryImage ? Math.min(Math.max(1, width - 4), group.height * DETAIL_ACCESSORY_SIZE_RATIO * displayScale) : 0
  const noteOverride = details?.textOverrides?.note
  const noteText = noteOverride?.text ?? details?.note ?? ''
  const noteColor = noteOverride?.color ?? DEFAULT_NOTE_COLOR
  let noteFontSize = Number.isFinite(noteOverride?.fontSize)
    ? Math.max(6, Math.min(72, noteOverride!.fontSize!)) : DEFAULT_NOTE_FONT_SIZE
  let noteLine = noteFontSize * 1.25
  let noteLines = !noteOverride?.hidden && noteText.trim() ? wrapNote(noteText, width, noteFontSize) : []
  const minimumMedia = images.length ? Math.min(bodyHeight * 0.65, images.length * 24)
    : details?.accessoryImage ? Math.min(bodyHeight * 0.55, desiredAccessorySize + accessoryExtra) : 0
  const textRoom = Math.max(1, bodyHeight - minimumMedia - 2)
  while (noteLines.length * noteLine > textRoom && noteFontSize > 0.5) {
    noteFontSize = Math.max(0.5, noteFontSize - 0.25)
    noteLine = noteFontSize * 1.25
    noteLines = wrapNote(noteText, width, noteFontSize)
  }
  // Long unbroken codes also stay intact: shrink the note itself rather than
  // clipping or truncating any characters in the canvas or exported SVG.
  const longestNote = Math.max(1, ...noteLines.map(value => [...value].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : .6), 0) * noteFontSize))
  const noteFit = Math.min(1, width / longestNote, textRoom / Math.max(1, noteLines.length * noteLine))
  noteFontSize *= noteFit
  noteLine *= noteFit
  const noteY = bodyY + Math.max(0, bodyHeight - noteLines.length * noteLine)
  const mediaHeight = Math.max(0, noteY - bodyY - (noteLines.length ? 2 : 0))
  const mediaGap = details?.accessoryImage && images.length ? Math.min(6, width / 10) : 0
  const accessoryColumnWidth = details?.accessoryImage && images.length
    ? Math.min(width / 2, Math.max(width * .32, (details.accessoryCode?.length ?? 0) * 5 + 4)) : width
  const imageSize = Math.max(0, Math.min(desiredAccessorySize, mediaHeight - accessoryExtra,
    images.length ? Math.max(0, accessoryColumnWidth - 4) / .4 : Infinity))
  const accessoryHeight = imageSize + accessoryExtra
  const accessoryX = images.length ? x + (accessoryColumnWidth - imageSize) / 2 : x
  const pictureX = details?.accessoryImage ? x + accessoryColumnWidth + mediaGap : x
  const pictureWidth = details?.accessoryImage ? Math.max(0, width - accessoryColumnWidth - mediaGap) : width
  const noteImages = noteImageBoxes(images, pictureX, bodyY, pictureWidth, mediaHeight)
  return { x, y, width, line, fontSize, fields: displayFields, bodyY, imageSize, accessoryHeight, accessoryX,
    noteX: x, noteWidth: width, noteY, noteText, noteColor, noteLines, noteFontSize, noteLine,
    noteImageSize: noteImages[0]?.size ?? 0, noteImageY: noteImages[0]?.y ?? bodyY, noteImages }
}

