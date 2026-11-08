import { displayPricingMessage } from './formulaDisplay'
import { useState } from 'react'
import { Alert, Button, Input, Modal, Select, Tabs } from 'antd'
import { definitions, display, getEntityId, ordered, type Bundle } from '../product-options/model'
import { AREA_ATTRIBUTE_OPTIONS, areaTierLabel, getTemplateMatchBy, getTemplatePriceRules, createAdditionalPricePlan, createAttributePlanPrices, validateAreaPricing, type AdditionalPricePlan, type AreaAttributePrice, type AreaPricingDocument, type PricedAreaTemplate } from './areaPricing'
import { matchesAttribute } from './areaPlanUsage'
import RulePriceEditor from './RulePriceEditor'

type Props = { document: AreaPricingDocument; bundle: Bundle; disabled: boolean; onChange: (change: (document: AreaPricingDocument) => void) => void }
type Editor = { plan: AdditionalPricePlan; isNew: boolean }
const priceOptions = AREA_ATTRIBUTE_OPTIONS.filter(option => option.name !== 'Accessories Style')

export default function AreaAttributeEditor({ document, bundle, disabled, onChange }: Props) {
  const [page, setPage] = useState('plans')
  const [optionName, setOptionName] = useState('Technique')
  const [editor, setEditor] = useState<Editor>()
  const [removing, setRemoving] = useState<string>()
  const [switching, setSwitching] = useState<string>()
  const plan = editor?.plan
  const definition = definitions.find(item => item.name === optionName)!
  const values = ordered(bundle.catalogs[definition.file]?.values ?? [])
  const planTemplateIds = new Set(plan?.prices.map(row => row.areaTemplateId))
  const commonTemplateId = planTemplateIds.size === 1 ? [...planTemplateIds][0] : undefined
  const templateOptions = document.templates.map(template => ({ value: template.areaTemplateId, label: template.name }))
  const hasBindings = (planId: string) => [...document.categoryAdditionalPlanBindings, ...document.productAdditionalPlanOverrides].some(row => row.additionalPricePlanId === planId)
  const accessories = ordered(bundle.catalogs['accessory-styles.json']?.values ?? []).flatMap(style => {
    const colors = document.accessoryPricing === 'style' ? [null] : ordered(style.colors ?? [])
    return colors.flatMap(color => {
      const price = document.accessoryPrices?.find(row => row.accessoryStyleId === style.accessoryStyleId && row.accessoryColorId === (color?.accessoryColorId ?? null))
      return price ? [{ price, style, color }] : []
    })
  })
  let editorError = ''
  if (plan) {
    try { validateAreaPricing({ ...document, categories: [], productOverrides: [], accessoryPrices: [], additionalPricePlans: [plan], categoryAdditionalPlanBindings: [], productAdditionalPlanOverrides: [], productTotalFormulas: [], productAdjustments: [] }) }
    catch (error) { editorError = displayPricingMessage(String(error).replace(/^Error: /, '')) }
  }
  const editPlan = (change: (plan: AdditionalPricePlan) => void) => setEditor(current => {
    if (!current) return current
    const next = structuredClone(current)
    change(next.plan)
    return next
  })
  const editPrice = (rowId: string, change: (price: AreaAttributePrice) => void) => editPlan(current => {
    const price = current.prices.find(row => row.areaAttributePriceId === rowId)
    if (price) change(price)
  })
  const addMissingPrices = (current: AdditionalPricePlan, template: PricedAreaTemplate) => {
    for (const price of createAdditionalPricePlan(bundle, template).prices) {
      if (!current.prices.some(row => matchesAttribute(row, price.optionName, price.reference))) current.prices.push({ ...price, areaAttributePriceId: `area-price-${crypto.randomUUID()}` })
    }
  }
  const openEditor = (source?: AdditionalPricePlan, copy = false) => {
    const next = source ? structuredClone(source) : createAdditionalPricePlan(bundle, document.templates[0], '新产品属性价格方案')
    if (copy) { next.additionalPricePlanId = `additional-plan-${crypto.randomUUID()}`; next.name += ' 副本' }
    const templateIds = new Set(next.prices.map(row => row.areaTemplateId))
    const template = templateIds.size === 1 ? document.templates.find(row => row.areaTemplateId === [...templateIds][0]) : undefined
    if (template) addMissingPrices(next, template)
    setEditor({ plan: next, isNew: !source || copy })
    setOptionName('Technique')
  }
  const closeEditor = () => { setEditor(undefined); setSwitching(undefined) }
  const finishEditor = () => {
    if (!editor || editorError || disabled) return
    const saved = structuredClone(editor.plan)
    onChange(next => {
      const index = next.additionalPricePlans.findIndex(row => row.additionalPricePlanId === saved.additionalPricePlanId)
      if (editor.isNew) next.additionalPricePlans.push(saved)
      else if (index >= 0) next.additionalPricePlans[index] = saved
    })
    closeEditor()
  }
  const switchTemplate = (templateId: string) => editPlan(current => {
    const template = document.templates.find(row => row.areaTemplateId === templateId)
    if (!template) return
    for (const row of current.prices.filter(row => row.areaTemplateId !== templateId)) {
      row.areaTemplateId = templateId
      const prices = createAttributePlanPrices(template)
      row.tierPrices = prices.tierPrices
      if (prices.standeeBase) row.standeeBase = { ...prices.standeeBase, basePrice: row.standeeBase?.basePrice ?? null }
      else delete row.standeeBase
    }
    addMissingPrices(current, template)
  })
  const requestTemplate = (templateId: string) => {
    if (!plan) return
    const affected = plan.prices.filter(row => row.areaTemplateId !== templateId)
    if (affected.some(row => row.tierPrices.some(tier => tier.price !== null) || row.standeeBase?.tierPrices.some(tier => tier.price !== null))) setSwitching(templateId)
    else switchTemplate(templateId)
  }
  return <div className="area-attribute-editor">
    <Tabs activeKey={page} onChange={setPage} items={[{ key: 'plans', label: '附加方案' }, { key: 'accessories', label: '配件样式' }]}/>
    {page === 'plans' ? <section className="pp-card area-list-card" aria-label="整套产品属性价格方案">
      <div className="pp-section-heading"><h4>产品属性价格方案</h4><Button type="primary" disabled={disabled} onClick={() => openEditor()}>新增方案</Button></div>
      <p className="pp-help">每行是一整套产品属性价格。点击“编辑”修改其中的属性价格，产品使用哪一套方案在“产品基础单价”中设置。</p>
      {document.additionalPricePlans.length ? <div className="area-table-scroll area-list-scroll"><table className="area-table area-list-table area-scheme-list" aria-label="产品属性价格方案表"><thead><tr><th scope="col">产品类别</th><th scope="col">档位模板</th><th scope="col">属性价格</th><th scope="col">操作</th></tr></thead><tbody>{document.additionalPricePlans.map(item => {
        const templateIds = [...new Set(item.prices.map(row => row.areaTemplateId))]
        return <tr key={item.additionalPricePlanId}>
          <th scope="row">{item.name}</th>
          <td>{templateIds.length ? templateIds.map(id => <div key={id}>{document.templates.find(template => template.areaTemplateId === id)?.name ?? '模板已不存在'}</div>) : <span className="pp-muted">尚未配置</span>}</td>
          <td><div className="area-list-summary">{priceOptions.flatMap(option => { const count = item.prices.filter(row => row.optionName === option.name).length; return count ? [<span key={option.name}>{option.label} {count} 项</span>] : [] })}{!item.prices.length && <span className="pp-muted">尚未配置</span>}</div></td>
          <td><div className="area-list-actions"><Button type="link" aria-label={`编辑产品属性价格方案 ${item.additionalPricePlanId}`} disabled={disabled} onClick={() => openEditor(item)}>编辑</Button><Button type="text" aria-label={`复制产品属性价格方案 ${item.additionalPricePlanId}`} disabled={disabled} onClick={() => openEditor(item, true)}>复制</Button><Button type="text" danger aria-label={`删除产品属性价格方案 ${item.additionalPricePlanId}`} disabled={disabled || hasBindings(item.additionalPricePlanId)} title={hasBindings(item.additionalPricePlanId) ? '请先到“产品基础单价”更换或取消使用此方案' : undefined} onClick={() => setRemoving(item.additionalPricePlanId)}>删除</Button></div></td>
        </tr>
      })}</tbody></table></div> : <p className="pp-empty">暂无产品属性价格方案，点击“新增方案”开始配置。</p>}
    </section> : <>
      {accessories.length ? <section className="pp-card area-fixed-accessory" aria-label="配件公共价格"><h4>配件公共价格</h4><div className="area-table-scroll"><table className="area-table area-accessory-table" aria-label="配件公共价格表"><thead><tr><th scope="col">配件样式</th>{document.accessoryPricing === 'color' && <th scope="col">颜色</th>}<th scope="col">公共单价（USD / 件）</th></tr></thead><tbody>{accessories.map(({ price, style, color }) => <tr key={price.accessoryPriceId}>
        <th scope="row">{display(style)}<small>{style.accessoryStyleId}</small></th>
        {document.accessoryPricing === 'color' && <td>{color ? display(color) : ''}<small>{color?.accessoryColorId}</small></td>}
        <td><Input aria-label={`配件 ${price.accessoryColorId ?? price.accessoryStyleId} 公共单价`} inputMode="decimal" placeholder="未定价" value={price.unitPrice ?? ''} disabled={disabled} onChange={event => onChange(next => { next.accessoryPrices!.find(row => row.accessoryPriceId === price.accessoryPriceId)!.unitPrice = event.target.value.trim() ? event.target.value : null })}/></td>
      </tr>)}</tbody></table></div><p className="pp-help">所有产品共用固定单价。完成后点击页面上方“保存”，空白为未定价，0 表示不收费。</p></section> : <p className="pp-empty">暂无配件{document.accessoryPricing === 'color' ? '颜色' : '样式'}，请先在产品选项配置中添加。</p>}
    </>}
    <Modal title={editor?.isNew ? '新增产品属性价格方案' : '编辑产品属性价格方案'} open={!!editor} width={1120} className="area-editor-modal" styles={{ body: { maxHeight: '65vh', overflowY: 'auto' } }} destroyOnHidden maskClosable={false} okText="完成编辑" cancelText="取消" okButtonProps={{ disabled: disabled || !!editorError }} onCancel={closeEditor} onOk={finishEditor}>
      {plan && <>
        <div className="area-config-fields area-scheme-fields">
          <label>产品类别<Input aria-label="产品类别" value={plan.name} status={!plan.name.trim() ? 'error' : undefined} disabled={disabled} onChange={event => editPlan(row => { row.name = event.target.value })}/></label>
          <label>选择产品类别<Select aria-label="选择产品类别" showSearch optionFilterProp="label" placeholder={planTemplateIds.size > 1 ? '当前使用多种模板' : '选择模板应用到整套方案'} value={commonTemplateId} disabled={disabled} options={templateOptions} onChange={requestTemplate}/></label>
        </div>
        <Tabs activeKey={optionName} onChange={setOptionName} items={priceOptions.map(option => ({ key: option.name, label: definitions.find(item => item.name === option.name)?.title ?? option.label }))}/>
        {values.length ? <div className="area-table-scroll area-scheme-price-scroll"><table className="area-table area-scheme-price-table" aria-label="方案属性价格表"><thead><tr><th scope="col">属性选项</th><th scope="col">基价（USD）</th><th scope="col">各档价格（USD）</th></tr></thead><tbody>{values.map(value => {
          const price = plan.prices.find(row => matchesAttribute(row, optionName, value))
          const template = document.templates.find(row => row.areaTemplateId === price?.areaTemplateId)
          const bodyHasBaseFee = template && getTemplateMatchBy(template) !== 'exact-size'
          const baseHasBaseFee = template?.standeeBase && getTemplateMatchBy(template.standeeBase) !== 'exact-size'
          return <tr key={getEntityId(value)}>
            <th scope="row">{display(value)}<small>{getEntityId(value)}</small></th>
            <td>{price ? bodyHasBaseFee || baseHasBaseFee ? <div className="area-tier-price-inputs">{bodyHasBaseFee && <label>{template?.standeeBase && <span>每片主体</span>}<Input aria-label={`方案 ${price.areaAttributePriceId} 基价`} inputMode="decimal" placeholder="未定价" value={price.basePrice ?? ''} disabled={disabled} onChange={event => editPrice(price.areaAttributePriceId, row => { row.basePrice = event.target.value.trim() ? event.target.value : null })}/></label>}{baseHasBaseFee && <label><span>底座（每套一次）</span><Input aria-label={`方案 ${price.areaAttributePriceId} 底座基价`} inputMode="decimal" placeholder="未定价" value={price.standeeBase?.basePrice ?? ''} disabled={disabled} onChange={event => editPrice(price.areaAttributePriceId, row => {
              row.standeeBase ??= createAttributePlanPrices(template).standeeBase!
              row.standeeBase.basePrice = event.target.value.trim() ? event.target.value : null
            })}/></label>}</div> : <span className="pp-muted">—</span> : <span className="pp-muted">请先在上方选择产品类别</span>}</td>
            <td>{price && template ? <div className="area-tier-price-groups">
              <div className="area-tier-price-group">{template.standeeBase && <h5 className="rule-price-group-title">主体片材</h5>}<div className="rule-attribute-prices">{getTemplatePriceRules(template).map((tier, index) => <div className="rule-attribute-price" key={tier.areaTierId}><strong>{areaTierLabel(template, tier)}</strong><RulePriceEditor compact label={`方案 ${price.areaAttributePriceId} 第${index + 1}档价格`} value={price.tierPrices.find(row => row.areaTierId === tier.areaTierId) ?? { areaTierId: tier.areaTierId, price: null }} disabled={disabled} onChange={changed => editPrice(price.areaAttributePriceId, row => {
                const position = row.tierPrices.findIndex(item => item.areaTierId === tier.areaTierId)
                if (position < 0) row.tierPrices.push(changed)
                else row.tierPrices[position] = changed
              })}/></div>)}</div></div>
              {template.standeeBase && <div className="area-tier-price-group"><h5 className="rule-price-group-title">底座（每套一次）</h5><div className="rule-attribute-prices">{getTemplatePriceRules(template.standeeBase).map((tier, index) => <div className="rule-attribute-price" key={tier.areaTierId}><strong>{areaTierLabel({ ...template.standeeBase!, areaTemplateId: template.areaTemplateId, name: template.name }, tier)}</strong><RulePriceEditor compact label={`方案 ${price.areaAttributePriceId} 底座第${index + 1}档价格`} value={price.standeeBase?.tierPrices.find(row => row.areaTierId === tier.areaTierId) ?? { areaTierId: tier.areaTierId, price: null }} disabled={disabled} onChange={changed => editPrice(price.areaAttributePriceId, row => {
                row.standeeBase ??= createAttributePlanPrices(template).standeeBase!
                const position = row.standeeBase.tierPrices.findIndex(item => item.areaTierId === tier.areaTierId)
                if (position < 0) row.standeeBase.tierPrices.push(changed)
                else row.standeeBase.tierPrices[position] = changed
              })}/></div>)}</div></div>}
            </div> : <span className="pp-muted">未定价</span>}</td>
          </tr>
        })}</tbody></table></div> : <p className="pp-empty">暂无{definition.title}选项，请先在产品选项配置中添加。</p>}
        {editorError && <Alert type="error" showIcon message={editorError}/>}
        <p className="pp-help">每档填写一个价格，区间统一使用模板公式和本属性的基价，固定尺寸直接使用填写的价格。负数表示减价，空白为未定价，0 表示不收费。完成编辑后，点击页面上方“保存”生效；取消会放弃本次弹窗中的修改。</p>
      </>}
    </Modal>
    <Modal title="统一方案档位模板？" open={!!switching} okText="切换并清空档价" cancelText="取消" okButtonProps={{ disabled }} onCancel={() => setSwitching(undefined)} onOk={() => { if (switching) switchTemplate(switching); setSwitching(undefined) }}>将更新当前整套方案所有属性的模板，并清空其中改用新模板的档位价格，基价保留。请重新填写后完成编辑。</Modal>
    <Modal title="删除这套产品属性价格方案？" open={!!removing} okText="删除" cancelText="取消" okButtonProps={{ disabled }} onCancel={() => setRemoving(undefined)} onOk={() => { onChange(next => { if (![...next.categoryAdditionalPlanBindings, ...next.productAdditionalPlanOverrides].some(row => row.additionalPricePlanId === removing)) next.additionalPricePlans = next.additionalPricePlans.filter(row => row.additionalPricePlanId !== removing) }); setRemoving(undefined) }}>删除“{document.additionalPricePlans.find(row => row.additionalPricePlanId === removing)?.name}”及其属性价格。确认后请点击页面上方“保存”完成删除；未保存就刷新并放弃修改，会重新显示原方案。档位模板仍会保留。</Modal>
  </div>
}
