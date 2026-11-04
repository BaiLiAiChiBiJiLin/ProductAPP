import { allProducts, catalogFor, display, getEntityId, isEnabled, optionFor, ordered, type Bundle } from '../product-options/model'
import type { ProductPricingDocument } from './model'
import type { SizePriceValue } from './SizePriceDialog'

export const sharedAttributes = [
  { name: 'Technique', field: 'techniqueId', file: 'techniques.json', label: '工艺' },
  { name: 'Holo Film', field: 'holoFilmId', file: 'holo-films.json', label: '全息膜' },
] as const
export type SharedAttribute = typeof sharedAttributes[number]

/** Keep size identities separate even when two catalogs display the same dimensions. */
export function sharedAttributeSizes(document: ProductPricingDocument, bundle: Bundle, attribute: SharedAttribute, valueId: string) {
  const ids = new Set<string | null>((document.sharedAttributePrices ?? []).filter(row => row[attribute.field] === valueId).map(row => row.sizeBandId))
  for (const product of allProducts(bundle.main)) {
    const pricing = document.products.find(row => row.productId === product.productId)
    if (!pricing || pricing.pricingMode === 'standee') continue
    const option = optionFor(product, attribute.name)
    const value = catalogFor(bundle, product, attribute.name).values.find(value => getEntityId(value) === valueId)
    if (!option || option.deleted || !value || !isEnabled(option, value)) continue
    if (pricing.pricingMode === 'fixed') ids.add(null)
    else {
      const sizeOption = optionFor(product, 'Size')
      if (sizeOption && !sizeOption.deleted) for (const size of bundle.catalogs['sizes.json'].values) if (isEnabled(sizeOption, size)) ids.add(getEntityId(size))
    }
  }
  return [
    ...ordered(bundle.catalogs['sizes.json'].values).filter(size => ids.has(getEntityId(size))).map(size => ({ sizeBandId: getEntityId(size), label: display(size) })),
    ...(ids.has(null) ? [{ sizeBandId: null, label: '尺寸不影响价格' }] : []),
  ]
}

export function setSharedAttributePrices(document: ProductPricingDocument, field: SharedAttribute['field'], valueId: string, sizeIds: (string | null)[], values: SizePriceValue[]) {
  const previous = document.sharedAttributePrices ?? []
  document.sharedAttributePrices = [
    ...previous.filter(row => row[field] !== valueId || !sizeIds.includes(row.sizeBandId)),
    ...values.map(value => ({
      sharedAttributePriceId: previous.find(row => row[field] === valueId && row.sizeBandId === value.sizeBandId)?.sharedAttributePriceId ?? `shared-attribute-${crypto.randomUUID()}`,
      techniqueId: null, holoFilmId: null, [field]: valueId, ...value,
    })),
  ]
}
