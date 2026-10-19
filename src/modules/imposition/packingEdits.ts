import type { PackedImpositionItem } from './ImpositionKonvaCanvas'
import { groupRepeatedPackingPages } from './packingAlgorithms'
import type { NestTemplatePlacement, NestTemplateRepack } from './impositionRecords'

export type PackingEdit = {
  sourcePageIndex: number
  targetPageIndex: number
  affectedImageIds: string[]
  repeatedBoards: number
  crossBoard: boolean
  /** A cross-plan drop is an intent, not a balanced production result. */
  templateRepack?: NestTemplateRepack
}

const sourceId = (item: PackedImpositionItem) => item.image.sourceImageId ?? item.image.id.split('#qt-')[0]
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6
function sameSlot(a: PackedImpositionItem, b: PackedImpositionItem) {
  return sourceId(a) === sourceId(b) && close(a.x, b.x) && close(a.y, b.y)
    && close(a.width, b.width) && close(a.height, b.height)
    && close(((a.rotation ?? 0) % 360 + 360) % 360, ((b.rotation ?? 0) % 360 + 360) % 360)
}

const toTemplatePlacement = (item: PackedImpositionItem): NestTemplatePlacement => ({
  sourceId: sourceId(item), xMm: item.x, yMm: item.y, rotationDeg: item.rotation ?? 0,
})

/** Same-board edits update geometry. A cross-board drop records the template
 * change and leaves production pages intact until the solver balances all QT.
 */
export function applyPackingEdit(
  pages: PackedImpositionItem[][],
  sourcePageIndex: number,
  original: PackedImpositionItem,
  targetPageIndex: number,
  placement: PackedImpositionItem,
  collapsed: boolean,
): { pages: PackedImpositionItem[][]; edit: PackingEdit } {
  const crossBoard = sourcePageIndex !== targetPageIndex
  const group = collapsed && !crossBoard
    ? groupRepeatedPackingPages(pages).find(value => value.pageIndices.includes(sourcePageIndex))
    : undefined
  const affectedPages = group?.pageIndices ?? [sourcePageIndex]
  const affectedImageIds: string[] = []
  const next = pages.slice()
  if (crossBoard) {
    const moved = pages[sourcePageIndex]?.find(item => item.image.id === original.image.id)
    if (!moved || !pages[targetPageIndex]) throw new Error('移动的图片或目标板材已不存在')
    const groups = collapsed ? groupRepeatedPackingPages(pages)
      : pages.map((page, pageIndex) => ({ page, pageIndices: [pageIndex], repeatCount: 1 }))
    const sourceIndex = groups.findIndex(value => value.pageIndices.includes(sourcePageIndex))
    const targetIndex = groups.findIndex(value => value.pageIndices.includes(targetPageIndex))
    const sourceSlotIndex = groups[sourceIndex].page.findIndex(value => sameSlot(value, original))
    if (sourceIndex === targetIndex || sourceSlotIndex < 0) throw new Error('源方案或目标方案已发生变化，请重新选择')
    const templateRepack: NestTemplateRepack = {
      templates: groups.map((value, index) => ({ id: `template-${index}`, repeatCount: value.repeatCount, placements: value.page.map(toTemplatePlacement) })),
      sourceTemplateId: `template-${sourceIndex}`, targetTemplateId: `template-${targetIndex}`,
      sourceSlotIndex, targetPlacement: toTemplatePlacement({ ...placement, image: moved.image }),
    }
    const affected = groups[sourceIndex].pageIndices.flatMap(index => pages[index].filter(value => sameSlot(value, original)).map(value => value.image.id))
    return { pages, edit: { sourcePageIndex, targetPageIndex, affectedImageIds: affected, repeatedBoards: groups[sourceIndex].repeatCount, crossBoard, templateRepack } }
  } else {
    for (const pageIndex of affectedPages) {
      const slot = pages[pageIndex].findIndex(item => pageIndex === sourcePageIndex
        ? item.image.id === original.image.id : sameSlot(item, original))
      if (slot < 0) throw new Error('重复版式的图片位置不匹配，请重新选择')
      const item = pages[pageIndex][slot]
      affectedImageIds.push(item.image.id)
      next[pageIndex] = pages[pageIndex].map((value, index) => index === slot
        ? { ...value, x: placement.x, y: placement.y, rotation: placement.rotation ?? 0 }
        : value)
    }
  }
  return { pages: next, edit: { sourcePageIndex, targetPageIndex, affectedImageIds, repeatedBoards: affectedPages.length, crossBoard } }
}
