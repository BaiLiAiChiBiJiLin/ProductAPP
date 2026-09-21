import { GROUP_GAP, HEADER_BLOCK_HEIGHT, normalizeLayoutBounds, PAPER_HEIGHT, PAPER_WIDTH, type Page, type LayoutBounds, type Item } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { imageGroupsForPage } from '../services/groupBackgroundService.ts'
import { placeProductGroup, productGroupFootprint } from './productGroupLayout.ts'
import { imageCenterWithDimensionGutter } from '../services/imageDimensionService.ts'
import { packGroupColumns } from './compactSectionPacking.ts'

/** Header editing keeps product groups atomic; pagination is handled by the batch arranger. */
export function rearrangeProductPage(page: Page, bounds: LayoutBounds): Page {
  const area = normalizeLayoutBounds(bounds)
  const blocks = [...page.headerBlocks ?? []].sort((a, b) => a.y - b.y)
  const byItem = new Map(page.items.map(item => [item.id, item]))
  const groups = imageGroupsForPage(page)
  const units = groups.map(group => ({ group, items: group.itemIds.map(id => byItem.get(id)).filter((item): item is Item => !!item) }))
  const sections = blocks.length ? blocks.map(block => ({ block,
    x: block.x, width: block.width, top: block.y + HEADER_BLOCK_HEIGHT + GROUP_GAP,
    bottom: Math.min(PAPER_HEIGHT - area.bottom, ...blocks.filter(other => other !== block && other.y > block.y
      && other.x < block.x + block.width - 1e-7 && other.x + other.width > block.x + 1e-7).map(other => other.y - GROUP_GAP)),
    columns: block.columns.length,
  })) : [{ block: undefined, x: area.left, width: PAPER_WIDTH - area.left - area.right, top: area.top, bottom: PAPER_HEIGHT - area.bottom, columns: 3 }]
  const used = new Set<string>()
  const items: Item[] = []
  const imageGroups: ImageGroup[] = []
  for (const section of sections) {
    const remaining = units.filter(unit => !used.has(unit.group.id) && (!section.block?.assetIds || unit.items.some(item => section.block!.assetIds!.includes(item.assetId))))
    if (!remaining.length) continue
    const plans = new Map(remaining.map(unit => [unit.group.id, unit.group.productGroupId
      ? productGroupFootprint(unit.items, section.bottom - section.top, unit.group, (section.width - GROUP_GAP * (section.columns - 1)) / section.columns, unit.group.imageColumns) : undefined]))
    const width = (section.width - GROUP_GAP * (section.columns - 1)) / section.columns
    const packed = packGroupColumns(remaining.map(unit => ({ value: unit,
      height: plans.get(unit.group.id)?.height ?? unit.group.height,
    })), section.columns, section.top, section.bottom, GROUP_GAP)
    if (packed.placements.length !== remaining.length) throw new Error('当前表头区域放不下完整产品组，请使用自动排列分页或扩大排列区域。')
    for (const { value: unit, column, y, height } of packed.placements) {
      const x = section.x + column * (width + GROUP_GAP)
      const plan = plans.get(unit.group.id)
      if (plan) {
        if (plan.imageWidth + plan.detailWidth > width + 1e-7) throw new Error('当前表头列宽不足以容纳产品组，请减少表头列数或使用自动排列。')
        const placed = placeProductGroup(unit.items, unit.group, x, y, width, height, plan.columns, plan.detailWidth)
        items.push(...placed.items); imageGroups.push(placed.group)
      } else {
        const vertical = unit.group.stacked === 'vertical'
        const imageAreaWidth = section.block?.detailWidth ? width - section.block.detailWidth : width / 2
        const slotWidth = imageAreaWidth / (vertical ? 1 : unit.items.length)
        const totalHeight = unit.items.reduce((sum, item) => sum + item.h, 0) + GROUP_GAP * (unit.items.length - 1)
        let itemY = y + (height - totalHeight) / 2
        for (const [itemIndex, item] of unit.items.entries()) {
          if (item.w + GROUP_GAP * 2 > slotWidth + 1e-7 || item.h + GROUP_GAP * 2 > height + 1e-7) throw new Error('当前表头列宽不足，请减少表头列数或使用自动排列。')
          const slot = { x: x + (vertical ? 0 : itemIndex) * slotWidth, width: slotWidth }
          items.push({ ...item, x: imageCenterWithDimensionGutter(slot, item.w, item.w < item.h), y: vertical ? itemY + item.h / 2 : y + height / 2 })
          itemY += item.h + GROUP_GAP
        }
        imageGroups.push({ ...unit.group, x, y, width, height,
          detailWidth: section.block?.detailWidth ?? unit.group.detailWidth,
          detailsX: section.block?.detailWidth ? x + imageAreaWidth : unit.group.detailsX })
      }
      used.add(unit.group.id)
    }
  }
  if (items.length !== page.items.length) throw new Error('部分图片没有对应的表头区域，请使用自动排列重新分页。')
  return { ...page, items, imageGroups }
}
