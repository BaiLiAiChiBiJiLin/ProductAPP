import { Select } from 'antd'
import type { Bundle } from '../product-options/model'
import { additionalPlanMatchesTemplate, clearIncompatibleAdditionalPlanBindings, type AreaPricingDocument } from './areaPricing'

type Props = { document: AreaPricingDocument; bundle: Bundle; categoryId: string; productId?: string; disabled: boolean; onChange: (change: (document: AreaPricingDocument) => void) => void }
const FOLLOW_CATEGORY = '__follow_category__'
const UNPRICED = '__unpriced__'

export default function AttributePriceBindings({ document, bundle, categoryId, productId, disabled, onChange }: Props) {
  const templateId = (productId ? document.productOverrides.find(row => row.productId === productId)?.areaTemplateId : undefined)
    ?? document.categories.find(row => row.categoryId === categoryId)?.areaTemplateId
  const fallback = document.categoryAdditionalPlanBindings.find(row => row.categoryId === categoryId)
  const override = productId ? document.productAdditionalPlanOverrides.find(row => row.productId === productId) : undefined
  const binding = override ?? fallback
  const defaultPlan = document.additionalPricePlans.find(row => row.additionalPricePlanId === fallback?.additionalPricePlanId)
  const selectedPlan = document.additionalPricePlans.find(row => row.additionalPricePlanId === binding?.additionalPricePlanId)
  const canFollow = !fallback?.additionalPricePlanId || additionalPlanMatchesTemplate(defaultPlan, templateId)
  const incompatible = !!binding?.additionalPricePlanId && !additionalPlanMatchesTemplate(selectedPlan, templateId)
  const availablePlans = document.additionalPricePlans.filter(plan => additionalPlanMatchesTemplate(plan, templateId))
  const options = [
    ...(productId && canFollow ? [{ value: FOLLOW_CATEGORY, label: `跟随大类（${defaultPlan?.name ?? '未定价'}）` }] : []),
    { value: UNPRICED, label: '未定价' },
    ...availablePlans.map(row => ({ value: row.additionalPricePlanId, label: row.name })),
  ]
  const select = (id: string) => {
    if (disabled || !options.some(option => option.value === id)) return
    onChange(next => {
      const additionalPricePlanId = id === UNPRICED ? null : id
      if (productId) {
        next.productAdditionalPlanOverrides = next.productAdditionalPlanOverrides.filter(row => row.productId !== productId)
        if (id !== FOLLOW_CATEGORY) next.productAdditionalPlanOverrides.push({ productId, additionalPricePlanId })
      } else {
        next.categoryAdditionalPlanBindings = next.categoryAdditionalPlanBindings.filter(row => row.categoryId !== categoryId)
        next.categoryAdditionalPlanBindings.push({ categoryId, additionalPricePlanId })
      }
      clearIncompatibleAdditionalPlanBindings(next, bundle, categoryId, productId)
    })
  }
  return <><Select
    aria-label={productId ? `子类 ${productId} 附加方案` : '大类默认附加方案'} showSearch optionFilterProp="label" disabled={disabled}
    status={incompatible ? 'error' : undefined}
    placeholder={incompatible ? '请重新选择匹配的方案' : '请选择附加方案'}
    value={incompatible ? undefined : productId && !override ? FOLLOW_CATEGORY : binding?.additionalPricePlanId ?? UNPRICED}
    options={options} onChange={select}
  />
    {incompatible ? <small className="area-error">{selectedPlan?.name ?? '原附加方案'}与当前档位模板不匹配，请重新选择。</small>
      : !templateId ? <small>请先选择档位模板。</small>
        : !availablePlans.length ? <small>暂无匹配方案，请在产品属性价格中配置。</small> : null}
  </>
}
