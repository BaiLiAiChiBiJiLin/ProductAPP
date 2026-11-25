import type { Asset } from '../../../model'

const PRINT_OPTION_KEYS = ['Print Option', 'Print', '印刷选项', '印刷']
const TECHNIQUE_KEYS = ['工艺', 'Finish', '表面', 'Technique', 'Process', '滴胶工艺']
const FILM_KEYS = ['膜', 'Film', 'Holo Film', 'Holographic Type', '全息膜']

function printOption(asset: Asset) {
  const attributes = asset.attributes ?? {}
  return PRINT_OPTION_KEYS.map(key => attributes[key]).find(value => value !== undefined) ?? ''
}

const normalizeAttribute = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()

/**
 * Keep assets with the same process/film combination adjacent inside one
 * product. The canonical saved process is 工艺, while older and public
 * catalogs may use Finish/Technique and Holo Film/膜 aliases.
 */
function techniqueFilm(asset: Asset) {
  const attributes = asset.attributes ?? {}
  const read = (keys: string[]) => keys
    .map(key => attributes[key])
    .find(value => value !== undefined && String(value).trim() !== '')
  return [read(TECHNIQUE_KEYS), read(FILM_KEYS)].map(normalizeAttribute).join('\u0001')
}

type ClassificationUnit = {
  assets: Asset[]
  firstIndex: number
  productId: string
  print: string
  techniqueFilm: string
}

function hasAssignedProduct(productId: string) {
  const normalized = productId.trim()
  return Boolean(normalized && normalized !== 'a')
}

function isStickerUnit(unit: ClassificationUnit) {
  return unit.assets.some(asset => /stickers?|贴纸/i.test(`${asset.productName ?? ''} ${asset.productId ?? ''}`))
}

/**
 * Collapse saved product groups before sorting.
 *
 * A product group is an indivisible layout unit. Sorting its members as
 * independent assets (especially by print option) can put another image
 * between two members; the arrangement page would then have to move them
 * back together and could disturb the order of other groups. Keeping the
 * unit here makes the review pool and the generated pages use the same
 * stable order.
 */
function classificationUnits(assets: Asset[]): ClassificationUnit[] {
  const grouped = new Map<string, { assets: Asset[]; firstIndex: number }>()
  const units: ClassificationUnit[] = []
  assets.forEach((asset, index) => {
    if (!asset.productGroupId) {
      units.push({ assets: [asset], firstIndex: index, productId: asset.productId || '', print: printOption(asset), techniqueFilm: techniqueFilm(asset) })
      return
    }
    const existing = grouped.get(asset.productGroupId)
    if (existing) {
      existing.assets.push(asset)
      return
    }
    const entry = { assets: [asset], firstIndex: index }
    grouped.set(asset.productGroupId, entry)
    // Keep the placeholder in document order. It is replaced below after all
    // members have been collected, so an interleaved input remains stable.
    units.push({ assets: entry.assets, firstIndex: index, productId: asset.productId || '', print: printOption(asset), techniqueFilm: techniqueFilm(asset) })
  })
  const byGroup = new Map([...grouped].map(([id, entry]) => [id, entry]))
  return units.map(unit => {
    if (!unit.assets[0]?.productGroupId) return unit
    const complete = byGroup.get(unit.assets[0].productGroupId)
    if (!complete) return unit
    const representative = complete.assets[0]
    return { assets: complete.assets, firstIndex: complete.firstIndex, productId: representative.productId || '', print: printOption(representative), techniqueFilm: complete.assets.map(techniqueFilm).sort().join('\u0002') }
  })
}

/** Sort by product count, then keep matching process/film combinations together.
 * Print-option count remains the tie-breaker inside each process/film group. */
export function classifyAssetsByProductAndPrint(assets: Asset[]): Asset[] {
  const products = new Map<string, { firstIndex: number; units: ClassificationUnit[]; count: number }>()
  for (const unit of classificationUnits(assets)) {
    const product = products.get(unit.productId) ?? { firstIndex: unit.firstIndex, units: [], count: 0 }
    product.units.push(unit)
    product.count += unit.assets.length
    products.set(unit.productId, product)
  }
  return [...products.values()]
    .sort((left, right) => {
      const leftSticker = left.units.some(isStickerUnit)
      const rightSticker = right.units.some(isStickerUnit)
      if (leftSticker !== rightSticker) return leftSticker ? -1 : 1
      const leftAssigned = hasAssignedProduct(left.units[0]?.productId ?? '')
      const rightAssigned = hasAssignedProduct(right.units[0]?.productId ?? '')
      if (leftAssigned !== rightAssigned) return leftAssigned ? -1 : 1
      return right.count - left.count || left.firstIndex - right.firstIndex
    })
    .flatMap(product => {
      const finishGroups = new Map<string, { firstIndex: number; units: ClassificationUnit[]; count: number }>()
      for (const unit of product.units) {
        const group = finishGroups.get(unit.techniqueFilm) ?? { firstIndex: unit.firstIndex, units: [], count: 0 }
        group.units.push(unit)
        group.count += unit.assets.length
        finishGroups.set(unit.techniqueFilm, group)
      }
      return [...finishGroups.values()]
        .sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex)
        .flatMap(finishGroup => {
          const printGroups = new Map<string, { firstIndex: number; units: ClassificationUnit[]; count: number }>()
          for (const unit of finishGroup.units) {
            const group = printGroups.get(unit.print) ?? { firstIndex: unit.firstIndex, units: [], count: 0 }
            group.units.push(unit)
            group.count += unit.assets.length
            printGroups.set(unit.print, group)
          }
          return [...printGroups.values()]
            .sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex)
            .flatMap(group => group.units
              .sort((left, right) => left.firstIndex - right.firstIndex)
              .flatMap(unit => unit.assets))
        })
    })
}

export const classifyAssetsByProduct = classifyAssetsByProductAndPrint
