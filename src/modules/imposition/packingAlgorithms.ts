import type { NestExcludedItem, ProductionImage, NestResult } from './impositionRecords'

export type PackingObjective = 'least-material' | 'least-cutting'
export type PackingLayout = {
  plateWidth: number
  plateHeight: number
  effectiveWidth: number
  effectiveHeight: number
  effectiveRight: number
  spacing: number
}
export type PackedItem = {
  image: ProductionImage
  x: number
  y: number
  width: number
  height: number
  rotation: number
}
export type PackingPlan = {
  pages: PackedItem[][]
  sheetsUsed: number
  placedCount: number
  utilization: number
  cuttingLines: number
  unplacedCount: number
  unplacedIds: string[]
  excludedItems: NestExcludedItem[]
  warnings: string[]
  algorithm: string
}

type LayoutIdentityItem = Omit<PackedItem, 'rotation'> & { rotation?: number }
export type PackingPageGroup<T> = { page: T[]; pageIndices: number[]; repeatCount: number }

/** Group display templates without removing any physical boards or QT copies. */
export function groupRepeatedPackingPages<T extends LayoutIdentityItem>(pages: T[][]): PackingPageGroup<T>[] {
  const groups = new Map<string, PackingPageGroup<T>>()
  const stable = (value: number) => Number(value.toFixed(6))
  pages.forEach((page, pageIndex) => {
    // Artwork identity is deliberately included: the same silhouette alone does
    // not make two printed boards interchangeable. Ignore only the QT suffix.
    const key = JSON.stringify(page.map(item => JSON.stringify([
      item.image.sourceImageId ?? item.image.id.split('#qt-')[0],
      stable(item.width), stable(item.height), stable(item.x), stable(item.y),
      stable(((item.rotation ?? 0) % 360 + 360) % 360),
    ])).sort())
    const group = groups.get(key)
    if (group) { group.pageIndices.push(pageIndex); group.repeatCount += 1 }
    else groups.set(key, { page, pageIndices: [pageIndex], repeatCount: 1 })
  })
  return [...groups.values()]
}

/** Summarize only placements returned by the selected irregular solver. */
export function summarizePackingResult(result: NestResult, images: ProductionImage[], polygons: Record<string, Array<[number, number]>>): PackingPlan {
  const byId = new Map(images.map(image => [image.id, image]))
  const bySheet = new Map<number, PackedItem[]>()
  const seen = new Set<string>()
  for (const placement of result.placements) {
    const image = byId.get(placement.id)
    if (!image || seen.has(image.id)) continue
    seen.add(image.id)
    const page = bySheet.get(placement.sheetIndex) ?? []
    page.push({ image, x: placement.xMm, y: placement.yMm, width: placement.widthMm, height: placement.heightMm, rotation: placement.rotationDeg })
    bySheet.set(placement.sheetIndex, page)
  }
  const pages = [...bySheet.entries()].sort(([left], [right]) => left - right).map(([, page]) => page)
  const round = (value: number) => Math.round(value * 100) / 100
  const patterns = pages.map(page => page.map(item => {
    const sourceId = item.image.sourceImageId ?? item.image.id
    const polygon = polygons[sourceId]
    // Different silhouettes of the same dimensions cannot share a cutting program.
    const shape = polygon ? JSON.stringify(polygon.map(([x, y]) => [round(x), round(y)])) : sourceId
    return `${shape}@${round(item.x)},${round(item.y)},${round(item.rotation % 360)}`
  }).sort().join('|'))
  const unplacedIds = images.filter(image => !seen.has(image.id)).map(image => image.id)
  const excludedById = new Map<string, NestExcludedItem>()
  for (const item of result.excludedItems ?? []) {
    const id = item.id.split('#qt-')[0]
    if (!excludedById.has(id)) excludedById.set(id, { id, reason: item.reason })
  }
  return {
    pages,
    sheetsUsed: pages.length,
    placedCount: seen.size,
    utilization: result.utilization,
    cuttingLines: new Set(patterns).size,
    unplacedCount: unplacedIds.length,
    unplacedIds,
    excludedItems: [...excludedById.values()],
    warnings: result.warnings ?? [],
    algorithm: result.algorithm,
  }
}
