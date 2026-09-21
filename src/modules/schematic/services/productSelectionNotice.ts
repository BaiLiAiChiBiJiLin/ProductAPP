import type { ProductConfig } from './productConfigService'
import { availableOptionValues } from './productOptionRules.ts'

export function standeeQuantityNotice(product: ProductConfig | undefined, name: string, value: string, attributes: Record<string, string>): string | null {
  if (!product || !/standees/i.test(product.title) || !value) return null
  const option = product.options.find(item => item.name === name)
  if (!option || ![option.name, option.label].some(label => label.includes('立牌数量'))) return null
  const selected = availableOptionValues(option, attributes).find(item => item.name === value)
  if (!selected) return null
  return `立牌数量提示：已选择“${option.label}：${selected.label}”，请核对立牌图片与数量。`
}
