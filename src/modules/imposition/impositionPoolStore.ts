import { impositionImageId, listPendingImpositions, loadImpositionJob, type ImpositionRecord, type ProductionImage } from './impositionRecords'

export const POOL_COLOR_OPTIONS = [
  { value: 'blue', label: '浅蓝' }, { value: 'teal', label: '青绿' }, { value: 'violet', label: '淡紫' },
  { value: 'rose', label: '玫粉' }, { value: 'orange', label: '珊瑚橙' }, { value: 'amber', label: '琥珀' },
  { value: 'green', label: '草绿' }, { value: 'cyan', label: '天青' }, { value: 'slate', label: '雾灰' },
] as const
export type ImpositionPool = { id: string; name: string; color: typeof POOL_COLOR_OPTIONS[number]['value']; imageKeys: string[] }
export type PoolImage = { key: string; jobId: string; customer: string; image: ProductionImage }
export const POOL_COLORS = POOL_COLOR_OPTIONS.map(option => option.value)
export const UNASSIGNED_POOL = '__unassigned'
export const poolStorageKey = () => `printflow-imposition-pools-v1:${localStorage.getItem('printflow-account-name')?.trim() || 'local'}`

export function readPools(): ImpositionPool[] {
  const raw = localStorage.getItem(poolStorageKey())
  if (!raw) return POOL_COLORS.slice(0, 3).map((color, index) => ({ id: `pool-${color}`, name: `生产池 ${String.fromCharCode(65 + index)}`, color, imageKeys: [] }))
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value)) throw new Error('拼版池配置格式错误')
  const ids = new Set<string>()
  const assigned = new Set<string>()
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
      || !('name' in entry) || typeof entry.name !== 'string' || !entry.name.trim()
      || !('color' in entry) || !POOL_COLORS.includes(entry.color as ImpositionPool['color'])
      || !('imageKeys' in entry) || !Array.isArray(entry.imageKeys) || !entry.imageKeys.every(key => typeof key === 'string')) throw new Error('拼版池配置格式错误')
    ids.add(entry.id)
    const imageKeys = entry.imageKeys.filter(key => { if (assigned.has(key)) return false; assigned.add(key); return true })
    return { id: entry.id, name: entry.name, color: entry.color as ImpositionPool['color'], imageKeys }
  })
}

// A pool owns references, never copies of production assets. Moving/deleting a
// pool cannot delete a source image or change its product attributes.
export function replacePoolImages(pools: ImpositionPool[], poolId: string, imageKeys: string[]): ImpositionPool[] {
  const selected = new Set(imageKeys)
  return pools.map(pool => ({ ...pool, imageKeys: pool.id === poolId ? [...selected] : pool.imageKeys.filter(key => !selected.has(key)) }))
}

export function poolImages(records: ImpositionRecord[]): PoolImage[] {
  return records.flatMap(record => record.images.map(image => ({ key: impositionImageId(record.id, image.id), jobId: record.id, customer: record.customerName || '未填写客户', image })))
}

export function poolCustomers(images: PoolImage[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const item of images) counts.set(item.customer, (counts.get(item.customer) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
}

/** Pool totals span all pending jobs, independently of the list's search/page. */
export async function loadPoolRecords(signal: AbortSignal): Promise<ImpositionRecord[]> {
  const jobs = new Map<string, { id: string }>()
  let page = 1
  while (!signal.aborted) {
    const result = await listPendingImpositions({ page, pageSize: 100 })
    if (signal.aborted) return []
    for (const job of result.records) jobs.set(job.id, job)
    if (result.page * result.pageSize >= result.total) break
    if (result.page !== page || !result.records.length) throw new Error('待拼版记录已变化，请刷新后重试')
    page++
  }
  const pending = [...jobs.values()]
  const records: ImpositionRecord[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (!signal.aborted && cursor < pending.length) {
      const job = pending[cursor++]
      const record = await loadImpositionJob(job.id)
      if (!signal.aborted) records.push(record)
    }
  }))
  return records.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id))
}

export function recordsForPool(records: ImpositionRecord[], images: PoolImage[]): ImpositionRecord[] {
  const keys = new Set(images.map(item => item.key))
  return records.flatMap(record => {
    const selected = record.images.filter(image => keys.has(impositionImageId(record.id, image.id)))
    return selected.length ? [{ ...record, images: selected, imageCount: selected.length }] : []
  })
}
