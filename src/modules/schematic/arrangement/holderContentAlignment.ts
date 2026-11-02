import type { Item } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { accessoryFrame } from '../services/accessoryFrameService.ts'
import { imageDetailsLayout } from '../services/imageDetailsLayoutService.ts'
import { detailPanelsForGroup } from './productGroupDetails.ts'

/** Center the occupied role layout as one unit after its final image sizes are known. */
export function centerHolderContents(group: ImageGroup, items: Item[]) {
  const ranges = items.map(item => ({
    top: item.y - item.h / 2 - (item.caption && !item.captionHidden ? 20 : !item.suppressRuler && item.w >= item.h ? 14 : 0),
    bottom: item.y + item.h / 2 + (item.note ? 10 : 0),
  }))
  const layout = imageDetailsLayout(detailPanelsForGroup(group)[0])
  for (const field of layout.fields) ranges.push({ top: layout.y + field.y, bottom: layout.y + field.y + field.height })
  if (group.details?.accessoryImage) {
    const frame = accessoryFrame(group.details.accessoryImage, layout.accessoryX, layout.bodyY, layout.imageSize, group.details.accessoryCode)
    ranges.push({ top: frame.y, bottom: frame.y + frame.frameHeight })
  }
  for (const image of layout.noteImages) ranges.push({ top: image.y - image.captionHeight, bottom: image.y + image.size })
  if (layout.noteLines.length) ranges.push({ top: layout.noteY, bottom: layout.noteY + layout.noteLines.length * layout.noteLine })
  if (!ranges.length) return
  const top = Math.min(...ranges.map(range => range.top)), bottom = Math.max(...ranges.map(range => range.bottom))
  // The finish remains a footer; center the role artwork and properties above it.
  const availableTop = group.y + 4
  const availableBottom = group.y + group.height - 4 - (group.details?.finish ? 18 : 0)
  if (bottom - top > availableBottom - availableTop + 1e-7) return
  const offset = (availableTop + availableBottom - top - bottom) / 2
  if (Math.abs(offset) < 1e-7) return
  for (const item of items) item.y += offset
  for (const cell of group.imageCells ?? []) {
    const bottom = Math.min(group.y + group.height, cell.y + cell.height + offset)
    cell.y = Math.max(group.y, cell.y + offset)
    cell.height = Math.max(1, bottom - cell.y)
  }
  group.detailsOffsetY = (group.detailsOffsetY ?? 0) + offset
}
