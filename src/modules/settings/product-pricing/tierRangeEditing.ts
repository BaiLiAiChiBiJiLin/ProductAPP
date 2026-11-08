import { convertAreaValue, convertLengthValue, getAreaTierBounds, getTemplateMatchBy, type AreaTemplate, type AreaUnit } from './areaPricing'

export function convertTierBounds(template: Pick<AreaTemplate, 'tiers' | 'unit' | 'matchBy'>, target: AreaUnit) {
  const convert = getTemplateMatchBy(template) === 'longest-side' ? convertLengthValue : convertAreaValue
  return template.tiers.map(tier => {
    const row = { ...tier }
    for (const key of ['minArea', 'maxArea'] as const) {
      const value = row[key]
      if (value == null || !value.trim()) continue
      try { row[key] = value === '0' ? '0' : convert(value, template.unit, target) } catch { /* Invalid drafts remain visible for validation. */ }
    }
    return row
  })
}

export function insertTierRange(template: Pick<AreaTemplate, 'tiers' | 'boundaryMode'>, areaTierId: string) {
  const rows = structuredClone(template.tiers)
  const index = rows.at(-1)?.maxArea === null ? rows.length - 1 : rows.length
  if (rows.some(row => row.minArea !== undefined)) {
    const preceding = rows[index - 1]
    const following = rows[index]
    const minArea = following?.minArea ?? preceding?.maxArea ?? '0'
    const minInclusive = following?.minInclusive ?? (preceding ? !getAreaTierBounds(template, preceding).maxInclusive : false)
    rows.splice(index, 0, { areaTierId, minArea, minInclusive, maxArea: '' })
    if (rows[index + 1]) { rows[index + 1].minArea = ''; rows[index + 1].minInclusive = template.boundaryMode === 'lower-inclusive' }
  } else rows.splice(index, 0, { areaTierId, maxArea: '' })
  return { tiers: rows, index }
}

export function removeTierRange(template: Pick<AreaTemplate, 'tiers' | 'boundaryMode' | 'matchBy'>, areaTierId: string) {
  const rows = template.tiers.map(tier => {
    if (getTemplateMatchBy(template) !== 'longest-side' || tier.minArea !== undefined) return { ...tier }
    const bounds = getAreaTierBounds(template, tier)
    return { ...tier, minArea: bounds.minArea, minInclusive: bounds.minInclusive }
  })
  const index = rows.findIndex(row => row.areaTierId === areaTierId)
  const removed = rows[index]
  const following = rows[index + 1]
  // Undo only an unfinished insertion. Deleting a completed range preserves the gap.
  if (removed && !removed.maxArea?.trim() && removed.minArea !== undefined && following?.minArea === '') {
    following.minArea = removed.minArea
    following.minInclusive = removed.minInclusive
  }
  return rows.filter(row => row.areaTierId !== areaTierId)
}
