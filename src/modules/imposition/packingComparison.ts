import type { NestRequest, NestResult } from './impositionRecords'
import type { PackingObjective, PackingPlan } from './packingAlgorithms'

export const PACKING_STRATEGIES: Array<{ value: PackingObjective; label: string }> = [
  { value: 'least-material', label: '节省板材' },
  { value: 'least-cutting', label: '切割方案优先' },
  { value: 'combined', label: '综合最少' },
]
export type PackingChoice = {
  objective: PackingObjective
  status: 'waiting' | 'running' | 'ready' | 'failed'
  sheetsUsed?: number
  cuttingLines?: number
  unplacedCount?: number
  error?: string
}

/** Await each solver process before starting another. Keep only coordinates;
 * expanded canvas pages and geometry are temporary while comparing metrics. */
export async function comparePackingStrategies(request: NestRequest, options: {
  solve: (request: NestRequest) => Promise<NestResult>
  summarize: (result: NestResult) => Pick<PackingPlan, 'sheetsUsed' | 'cuttingLines' | 'unplacedCount'>
  active: () => boolean
  onStart: (objective: PackingObjective, index: number) => void
  onResult: (choice: PackingChoice, result?: NestResult) => void
}) {
  for (const [index, strategy] of PACKING_STRATEGIES.entries()) {
    if (!options.active()) return
    options.onStart(strategy.value, index)
    try {
      const result = request.items.length
        ? await options.solve({ ...request, objective: strategy.value })
        : { placements: [], unplaced: [], sheetsUsed: 0, utilization: 0, algorithm: '所选图片均无有效轮廓' }
      if (!options.active()) return
      if (!result) throw new Error('拼版未返回结果')
      const summary = options.summarize(result)
      options.onResult({ objective: strategy.value, status: 'ready', ...summary }, result)
    } catch (reason) {
      if (!options.active()) return
      options.onResult({ objective: strategy.value, status: 'failed', error: reason instanceof Error ? reason.message : String(reason) })
    }
    // Allow the metrics to paint and temporary plan allocations to be released.
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}
