import type { BodyPrice, PriceSelections } from './model'

export const priceGroupKey = (value: PriceSelections) => JSON.stringify([value.techniqueId, value.holoFilmId, value.materialId])
export const priceSelections = (value: PriceSelections): PriceSelections => ({ techniqueId: value.techniqueId, holoFilmId: value.holoFilmId, materialId: value.materialId })
export type PriceGroup = { key: string; selection: PriceSelections; prices: BodyPrice[] }

export function groupBodyPrices(prices: BodyPrice[], retained: PriceSelections[] = []): PriceGroup[] {
  const groups = new Map<string, PriceGroup>()
  for (const row of prices) {
    const key = priceGroupKey(row)
    if (!groups.has(key)) groups.set(key, { key, selection: priceSelections(row), prices: [] })
    groups.get(key)!.prices.push(row)
  }
  for (const selection of retained) {
    const key = priceGroupKey(selection)
    if (!groups.has(key)) groups.set(key, { key, selection, prices: [] })
  }
  return [...groups.values()]
}
