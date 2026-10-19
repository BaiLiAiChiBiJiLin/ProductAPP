import type { NestRequest, NestResult, ProductionImage } from './impositionRecords'
import { summarizePackingResult } from './packingAlgorithms'

/** Cross-template changes have their own native strategy. Never derive demand
 * from the edited preview: every request still contains the original base QT.
 * Commit only after the returned identities and anchor pass this boundary.
 * The worker validates actual polygons, spacing and board bounds before return.
 */
export async function repackTemplatePlan(
  request: NestRequest,
  images: ProductionImage[],
  polygons: Record<string, Array<[number, number]>>,
  solve: (request: NestRequest) => Promise<NestResult>,
) {
  if (!request.templateRepack) throw new Error('缺少跨方案移动记录')
  const expected = new Map<string, NestRequest['items'][number]>()
  for (const item of request.items) {
    for (let index = 0; index < (item.quantity ?? 1); index++) expected.set(index ? `${item.id}#qt-${index + 1}` : item.id, item)
  }
  const result = await solve(request)
  if (!result || !Array.isArray(result.placements) || !Array.isArray(result.unplaced)) throw new Error('跨方案重算未返回有效结果')
  const seen = new Set<string>()
  for (const placement of result.placements) {
    const source = expected.get(placement.id)
    if (!source || seen.has(placement.id)) throw new Error('跨方案重算返回重复或未知的 QT，已保留原方案')
    if (![placement.xMm, placement.yMm, placement.rotationDeg, placement.widthMm, placement.heightMm].every(Number.isFinite)
      || !Number.isSafeInteger(placement.sheetIndex) || placement.sheetIndex < 0
      || Math.abs(placement.widthMm - source.widthMm) > 1e-6 || Math.abs(placement.heightMm - source.heightMm) > 1e-6) {
      throw new Error('跨方案重算返回无效的位置或尺寸，已保留原方案')
    }
    seen.add(placement.id)
  }
  for (const id of result.unplaced) {
    if (!expected.has(id) || seen.has(id)) throw new Error('跨方案重算的未放置数量不一致，已保留原方案')
    seen.add(id)
  }
  if (seen.size !== expected.size) throw new Error('跨方案重算缺少 QT，已保留原方案')
  // Valid sources cannot disappear into unplaced on a cross-plan edit.
  const excluded = new Set((result.excludedItems ?? []).map(item => item.id))
  if (result.unplaced.some(id => !excluded.has(expected.get(id)!.id))) throw new Error('跨方案重算未排完全部有效 QT，已保留原方案')
  const anchor = request.templateRepack.targetPlacement
  const rotation = (value: number) => (value % 360 + 360) % 360
  if (!result.placements.some(placement => expected.get(placement.id)?.id === anchor.sourceId
    && Math.abs(placement.xMm - anchor.xMm) < 1e-5 && Math.abs(placement.yMm - anchor.yMm) < 1e-5
    && Math.abs(rotation(placement.rotationDeg) - rotation(anchor.rotationDeg)) < 1e-5)) {
    throw new Error('跨方案重算未保留目标落点，已保留原方案')
  }
  return summarizePackingResult(result, images, polygons)
}
