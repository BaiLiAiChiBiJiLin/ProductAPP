import type { Bundle, EntityReference, OptionValue } from './model'
import legacySizes from './data/size-migration.json'

export type DimensionUnit = 'in' | 'cm' | 'mm'
export type SizeArea = { width: string; height: string; unit: DimensionUnit }
export const emptySizeArea = (): SizeArea => ({ width: '', height: '', unit: 'in' })

const factors: Record<DimensionUnit, bigint> = { in: 254n, cm: 100n, mm: 10n }
const decimalPattern = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,18})?$/
const decimal = (text: string) => {
  const [whole, fraction = ''] = text.split('.')
  return { value: BigInt(whole + fraction), scale: 10n ** BigInt(fraction.length) }
}
function formatFraction(numerator: bigint, denominator: bigint, precision = 18): string {
  const scale = 10n ** BigInt(precision)
  const rounded = (numerator * scale + denominator / 2n) / denominator
  const digits = rounded.toString().padStart(precision + 1, '0')
  const fraction = digits.slice(-precision).replace(/0+$/, '')
  return `${digits.slice(0, -precision)}${fraction ? `.${fraction}` : ''}`
}
export function validAreaDimension(value: unknown): value is string {
  return typeof value === 'string' && decimalPattern.test(value) && decimal(value).value > 0n
}
export function validateSizeArea(area: unknown): asserts area is SizeArea {
  if (!area || typeof area !== 'object' || Array.isArray(area)) throw new Error('尺寸面积格式无效')
  const candidate = area as Record<string, unknown>
  if (Object.keys(candidate).some(key => !['width', 'height', 'unit'].includes(key)) || !Object.hasOwn(factors, String(candidate.unit))) throw new Error('尺寸面积单位须为 in、cm 或 mm')
  if (![candidate.width, candidate.height].every(value => value === '' || validAreaDimension(value))) throw new Error('尺寸宽高须为空或大于零的十进制数，整数最多9位、小数最多18位')
}

/** Blank dimensions stay blank. Nonblank dimensions keep the same physical size. */
export function convertSizeArea(area: SizeArea, unit: DimensionUnit): SizeArea {
  if (area.unit === unit) return { ...area }
  const convert = (value: string) => {
    if (!validAreaDimension(value)) return value
    const parsed = decimal(value)
    return formatFraction(parsed.value * factors[area.unit], parsed.scale * factors[unit])
  }
  return { width: convert(area.width), height: convert(area.height), unit }
}

/** Returns square millimetres without binary floating-point rounding. */
export function areaToMm2(area: SizeArea): string {
  validateSizeArea(area)
  if (!area.width || !area.height) throw new Error('请完整填写面积的宽和高')
  const width = decimal(area.width)
  const height = decimal(area.height)
  const factor = factors[area.unit]
  return formatFraction(width.value * height.value * factor * factor, width.scale * height.scale * 100n, 38)
}

function inferredArea(value: OptionValue): SizeArea {
  if (value.area) return { ...value.area }
  const originalLabel = legacySizes.sizeBands.find(size => size.sizeBandId === value.sizeBandId)?.label
  for (const label of [value.labelZh, value.name, originalLabel]) {
    const match = label?.trim().match(/^(\d+(?:\.\d+)?)\s*(?:[×xX*]\s*(\d+(?:\.\d+)?))?\s*(英寸|in(?:ches)?|inch|厘米|cm|毫米|mm|\")$/i)
    if (!match) continue
    const unit = /^(英寸|in|inch|inches|\")$/i.test(match[3]) ? 'in' : /^(厘米|cm)$/i.test(match[3]) ? 'cm' : 'mm'
    return { width: match[1], height: match[2] ?? match[1], unit }
  }
  return emptySizeArea()
}

function physicalSizeKey(area: SizeArea): string | undefined {
  if (!validAreaDimension(area.width) || !validAreaDimension(area.height)) return undefined
  const millimetres = convertSizeArea(area, 'mm')
  return [millimetres.width, millimetres.height].sort().join('×')
}

/** Merge equivalent dimensions and keep per-product membership through explicit size IDs. */
export function migrateSizeAreas(source: Bundle): { bundle: Bundle; aliases: Record<string, string> } {
  const bundle = structuredClone(source)
  const catalog = bundle.catalogs['sizes.json']
  if (!catalog) return { bundle, aliases: {} }
  const aliases: Record<string, string> = {}
  const groups = new Map<string, OptionValue[]>()
  for (const value of catalog.values) {
    if (value.isCustom) continue
    value.area = inferredArea(value)
    const key = physicalSizeKey(value.area) ?? `unconfigured:${value.sizeBandId}`
    groups.set(key, [...(groups.get(key) ?? []), value])
  }
  const values: OptionValue[] = []
  for (const group of groups.values()) {
    const canonical = group.find(value => value.sizeBandId?.startsWith('keychain-')) ?? group.find(value => !/[×xX*]/.test(value.labelZh || value.name)) ?? group[0]
    canonical.sortOrder = Math.min(...group.map(value => value.sortOrder))
    canonical.isDefault = group.some(value => value.isDefault)
    const canonicalLabel = canonical.labelZh || canonical.name
    if ((group.length > 1 || /^\d[^a-z]*[×xX*]/i.test(canonicalLabel)) && canonical.area?.width === canonical.area?.height && canonical.area?.width && /^\d/.test(canonicalLabel)) {
      const label = `${canonical.area!.width} ${{ in: '英寸', cm: '厘米', mm: '毫米' }[canonical.area!.unit]}`
      canonical.name = label
      canonical.labelZh = label
    }
    values.push(canonical)
    for (const value of group) aliases[value.sizeBandId!] = canonical.sizeBandId!
  }
  const existingCustom = catalog.values.find(value => value.isCustom)
  const customId = existingCustom?.sizeBandId ?? 'size-custom'
  if (!existingCustom && catalog.values.some(value => value.sizeBandId === customId)) throw new Error('size-custom 已被普通尺寸使用，请先更换该尺寸标识')
  const custom: OptionValue = existingCustom ?? { sizeBandId: customId, name: 'Custom', labelZh: '自定义', isCustom: true, area: emptySizeArea(), isDefault: false, sortOrder: Math.max(0, ...values.map(value => value.sortOrder)) + 1 }
  custom.area ??= emptySizeArea()
  values.push(custom)
  aliases[customId!] = customId!
  for (const value of catalog.values.filter(value => value.isCustom)) aliases[value.sizeBandId!] = customId!

  const remap = (reference: EntityReference): EntityReference => reference.sizeBandId && aliases[reference.sizeBandId] ? { sizeBandId: aliases[reference.sizeBandId] } : reference
  if (catalog.defaultValue) catalog.defaultValue = remap(catalog.defaultValue)
  for (const product of [...bundle.main.categories.flatMap(category => category.products), ...bundle.main.uncategorizedProducts]) {
    const option = product.productOptions.find(option => option.name === 'Size')
    if (!option) continue
    const oldDisabled = new Set(option.disabledValues?.map(value => value.sizeBandId))
    const disabled: EntityReference[] = (option.disabledValues ?? []).filter(reference => !reference.sizeBandId || !aliases[reference.sizeBandId])
    for (const group of groups.values()) if (group.every(value => oldDisabled.has(value.sizeBandId))) disabled.push({ sizeBandId: aliases[group[0].sizeBandId!] })
    if (!existingCustom || catalog.values.filter(value => value.isCustom).every(value => oldDisabled.has(value.sizeBandId))) disabled.push({ sizeBandId: customId! })
    if (disabled.length) option.disabledValues = disabled
    else delete option.disabledValues
    if (option.defaultValue) option.defaultValue = remap(option.defaultValue)
  }
  catalog.values = values.sort((left, right) => left.sortOrder - right.sortOrder)
  return { bundle, aliases }
}
