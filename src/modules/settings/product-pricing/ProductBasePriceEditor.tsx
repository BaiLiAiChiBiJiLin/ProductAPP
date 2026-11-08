import { Input, Select, Switch } from 'antd'
import { display, type Bundle } from '../product-options/model'
import { clearIncompatibleAdditionalPlanBindings, getAreaPricingCategories, type AreaPricingDocument } from './areaPricing'
import AttributePriceBindings from './AttributePriceBindings'

type Props = {
  document: AreaPricingDocument
  bundle: Bundle
  categoryId: string
  disabled: boolean
  onCategoryChange: (categoryId: string) => void
  onChange: (change: (document: AreaPricingDocument) => void) => void
}

const FOLLOW_CATEGORY = '__follow_category__'

export default function ProductBasePriceEditor({ document, bundle, categoryId, disabled, onCategoryChange, onChange }: Props) {
  const categories = getAreaPricingCategories(bundle)
  const category = categories.find(row => row.categoryId === categoryId) ?? categories[0]
  if (!category) return null
  const selectedCategoryId = category.categoryId
  const products = bundle.main.categories.find(row => row.name === selectedCategoryId)?.products ?? []
  const categoryPricing = document.categories.find(row => row.categoryId === selectedCategoryId)
  const categoryTemplate = document.templates.find(row => row.areaTemplateId === categoryPricing?.areaTemplateId)
  const templateOptions = document.templates.map(row => ({ value: row.areaTemplateId, label: row.name }))
  const selectTemplate = (areaTemplateId: string | undefined, productId?: string) => onChange(next => {
    if (productId) {
      next.productOverrides = next.productOverrides.filter(row => row.productId !== productId)
      if (areaTemplateId && areaTemplateId !== FOLLOW_CATEGORY) next.productOverrides.push({ productId, areaTemplateId })
    } else {
      const row = next.categories.find(row => row.categoryId === selectedCategoryId)
      if (row) row.areaTemplateId = areaTemplateId ?? null
      else next.categories.push({ categoryId: selectedCategoryId, areaTemplateId: areaTemplateId ?? null })
    }
    clearIncompatibleAdditionalPlanBindings(next, bundle, selectedCategoryId, productId)
  })
  const templateSelect = (productId?: string) => {
    const override = productId ? document.productOverrides.find(row => row.productId === productId) : undefined
    return <Select
      aria-label={productId ? `子类 ${productId} 档位模板` : '大类默认档位模板'}
      showSearch optionFilterProp="label" allowClear={!productId}
      value={productId ? override?.areaTemplateId ?? FOLLOW_CATEGORY : categoryPricing?.areaTemplateId ?? undefined}
      disabled={disabled} placeholder="请选择档位模板"
      options={productId ? [{ value: FOLLOW_CATEGORY, label: `跟随大类（${categoryTemplate?.name ?? '未选择模板'}）` }, ...templateOptions] : templateOptions}
      onChange={value => selectTemplate(value, productId)}
    />
  }
  return <section className="area-product-bindings" aria-label="产品基础单价">
    <nav className="pp-card area-category-nav" aria-label="产品大类列表">
      <h4>产品大类</h4>
      <div className="area-category-list">{categories.map(row => <button
        key={row.categoryId} type="button" className="area-category-button"
        aria-label={`选择大类 ${row.categoryId}`} aria-pressed={row.categoryId === selectedCategoryId}
        disabled={disabled} onClick={() => onCategoryChange(row.categoryId)}
      ><span>{row.title}</span><small>{row.productCount}</small></button>)}</div>
    </nav>
    <section className="pp-card area-product-binding-content" aria-label={`${category.title}子类定价`}>
      <div className="pp-section-heading"><h4>{category.title}</h4><span className="pp-muted">{products.length} 个子类</span></div>
      <p className="pp-help">附加方案只显示与当前档位模板匹配的方案。切换模板后，不匹配的方案会清空为未定价。</p>
      <div className="area-table-scroll area-product-binding-scroll" key={selectedCategoryId}>
        <table className="area-table area-product-binding-table" aria-label="产品基础单价关联表">
          <thead><tr><th scope="col">产品子类</th><th scope="col">档位模板</th><th scope="col">附加方案</th></tr></thead>
          <tbody>
            <tr className="area-category-default"><th scope="row">大类默认<small>供跟随大类的子类使用</small></th>
              <td>{templateSelect()}</td><td><AttributePriceBindings document={document} bundle={bundle} categoryId={selectedCategoryId} disabled={disabled} onChange={onChange}/></td>
            </tr>
            {products.map(product => <tr key={product.productId}>
              <th scope="row">{display(product)}<small>{product.productId}</small>
                <details className="area-product-adjustment"><summary>每套调整</summary>
                  <label><Switch size="small" aria-label={`${product.productId} 启用每套调整`} disabled={disabled}
                    checked={document.productAdjustments.some(row => row.productId === product.productId)}
                    onChange={enabled => onChange(next => {
                      next.productAdjustments = next.productAdjustments.filter(row => row.productId !== product.productId)
                      if (enabled) next.productAdjustments.push({ productId: product.productId, amount: null })
                    })}/>启用调整</label>
                  {document.productAdjustments.some(row => row.productId === product.productId) && <Input
                    aria-label={`${product.productId} 每套调整金额`} inputMode="decimal" placeholder="未定价" disabled={disabled}
                    value={document.productAdjustments.find(row => row.productId === product.productId)?.amount ?? ''}
                    onChange={event => onChange(next => { const row = next.productAdjustments.find(row => row.productId === product.productId); if (row) row.amount = event.target.value || null })}
                    suffix="USD"/>}
                  <small>可填正负数；每套计入产品单价一次。</small>
                </details>
              </th>
              <td>{templateSelect(product.productId)}</td>
              <td><AttributePriceBindings document={document} bundle={bundle} categoryId={selectedCategoryId} productId={product.productId} disabled={disabled} onChange={onChange}/></td>
            </tr>)}
          </tbody>
        </table>
      </div>
      {!products.length && <p className="pp-empty">本大类暂无子类，可先设置默认模板和附加方案。</p>}
    </section>
  </section>
}
