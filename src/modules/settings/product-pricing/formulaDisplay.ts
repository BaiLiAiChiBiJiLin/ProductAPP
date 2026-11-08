const labels: Record<string, string> = {
  基本价: '基价', 大类主体价: '产品单价', 属性价: '属性合计',
  工艺价: '滴胶工艺价', 全息膜价: '亚克力全息膜价', 材质价: '贴纸材质价',
}
const storedNames: Record<string, string> = { ...Object.fromEntries(Object.entries(labels).map(([stored, label]) => [label, stored])), 基础费: '基本价' }
const variablePattern = /[\p{L}_][\p{L}\p{N}_]*/gu

export const displayPricingFormula = (formula: string): string => formula.replace(variablePattern, name => labels[name] ?? name)
export const storePricingFormula = (formula: string): string => formula.replace(variablePattern, name => storedNames[name] ?? name)

export const displayPricingMessage = (message: string): string => displayPricingFormula(message)
  .replaceAll('附加价格方案名称', '产品类别')
  .replaceAll('附加价格', '产品属性价格')
  .replaceAll('产品单价档位', '产品价格模板')
  .replaceAll('分档依据', '单价计算方式')
  .replaceAll('面积单位', '单位')
  .replaceAll('长度单位', '单位')
  .replaceAll('指定尺寸', '固定尺寸')
  .replaceAll('基础费', '基价')
  .replaceAll('基本价', '基价')
