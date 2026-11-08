import { displayPricingMessage } from './formulaDisplay'
import { Alert, Button, Input, Modal, Select } from 'antd'
import { useState } from 'react'
import { EXACT_SIZE_REQUIRED_MESSAGE, EXACT_SIZE_DIMENSIONS_REQUIRED_MESSAGE, areaTierLabel, createStandeeBaseTemplate, getAdditionalAttributePrices, getDefaultTemplateFormula, getTemplateFormulaVariables, getTemplateMatchBy, getTemplatePriceRules, syncAttributeTemplatePrices, templateUnitLabel, validateAreaPricing, type AreaPricingDocument, type PricedAreaTemplate, type AreaUnit, type TemplateMatchBy } from './areaPricing'
import { displayAreaBoundary } from './AreaChargeEditor'
import AreaFormulaEditor from './AreaFormulaEditor'
import StandeeBaseTemplateEditor from './StandeeBaseTemplateEditor'
import RulePriceEditor from './RulePriceEditor'
import ExactSizeRulesEditor from './ExactSizeRulesEditor'
import TierRangeInputs from './TierRangeInputs'
import { convertTierBounds, insertTierRange, removeTierRange } from './tierRangeEditing'
import { isUnitPrice } from './model'

type Props = { document: AreaPricingDocument; disabled: boolean; onChange: (change: (document: AreaPricingDocument) => void) => void }
type TemplateDraft = { template: PricedAreaTemplate; isNew: boolean }

const templateUsed = (document: AreaPricingDocument, templateId: string) => [...document.categories, ...document.productOverrides, ...getAdditionalAttributePrices(document)].some(row => row.areaTemplateId === templateId)

export default function AreaTemplateEditor({ document, disabled, onChange }: Props) {
  const [draft, setDraft] = useState<TemplateDraft>()
  const [removing, setRemoving] = useState<string>()
  const [switching, setSwitching] = useState<TemplateMatchBy>()
  const [removingBase, setRemovingBase] = useState(false)
  const template = draft?.template
  const isExact = template && getTemplateMatchBy(template) === 'exact-size'
  const isLongestSide = template && getTemplateMatchBy(template) === 'longest-side'
  const measureLabel = isLongestSide ? '最长边' : '面积'
  const measureSymbol = isLongestSide ? 'L' : 'A'
  const unitLabel = template ? templateUnitLabel(template) : ''
  const used = template ? templateUsed(document, template.areaTemplateId) : false
  const close = () => { setDraft(undefined); setSwitching(undefined); setRemovingBase(false) }
  const edit = (change: (value: PricedAreaTemplate) => void) => setDraft(current => {
    if (!current) return current
    const next = structuredClone(current)
    change(next.template)
    return next
  })
  const open = (source: PricedAreaTemplate) => {
    setDraft({ template: structuredClone(source), isNew: false })
  }
  const add = (source?: PricedAreaTemplate) => {
    const value: PricedAreaTemplate = source ? structuredClone(source) : {
      areaTemplateId: '', name: '新产品价格模板', unit: 'cm', boundaryMode: 'lower-inclusive',
      tiers: [{ areaTierId: '', maxArea: null }], basePrice: null, tierPrices: [{ areaTierId: '', price: null }],
      formula: getDefaultTemplateFormula('area'),
    }
    value.areaTemplateId = `area-template-${crypto.randomUUID()}`
    if (source) value.name += ' 副本'
    for (const group of [value, ...(value.standeeBase ? [value.standeeBase] : [])]) {
      const ids = new Map(getTemplatePriceRules(group).map(rule => [rule.areaTierId, `price-rule-${crypto.randomUUID()}`]))
      group.tiers = group.tiers.map(rule => ({ ...rule, areaTierId: ids.get(rule.areaTierId)! }))
      if (group.exactSizes) group.exactSizes = group.exactSizes.map(rule => ({ ...rule, areaTierId: ids.get(rule.areaTierId)! }))
      group.tierPrices = group.tierPrices.map(price => ({ ...price, areaTierId: ids.get(price.areaTierId)! }))
    }
    setDraft({ template: value, isNew: true })
  }
  let validationError = ''
  if (template) {
    try {
      validateAreaPricing({ ...document, templates: [template], categories: [], productOverrides: [], additionalPricePlans: [], categoryAdditionalPlanBindings: [], productAdditionalPlanOverrides: [], productTotalFormulas: [], productAdjustments: [], accessoryPrices: [] })
    } catch (failure) { validationError = String(failure).replace(/^Error: /, '') }
  }
  const finish = () => {
    if (!draft || disabled || validationError) return
    const value = structuredClone(draft.template)
    onChange(next => {
      const index = next.templates.findIndex(row => row.areaTemplateId === value.areaTemplateId)
      if (draft.isNew) {
        if (index < 0) next.templates.push(value)
      } else if (index >= 0) {
        next.templates[index] = value
        // Existing tier identities keep each scheme's own amount; new tiers start unpriced.
        for (const price of getAdditionalAttributePrices(next).filter(row => row.areaTemplateId === value.areaTemplateId)) {
          syncAttributeTemplatePrices(price, value)
        }
      }
    })
    close()
  }
  const changeUnit = (unit: AreaUnit) => edit(value => {
    value.tiers = convertTierBounds(value, unit)
    value.unit = unit
  })
  const switchMatchBy = (matchBy: TemplateMatchBy) => edit(current => {
    const areaTierId = `area-tier-${crypto.randomUUID()}`
    current.matchBy = matchBy
    current.unit = matchBy === 'longest-side' ? 'mm' : 'cm'
    current.boundaryMode = matchBy === 'longest-side' ? 'upper-inclusive' : 'lower-inclusive'
    current.tiers = matchBy === 'exact-size' ? [] : [{ areaTierId, maxArea: null }]
    current.tierPrices = current.tierPrices.filter(row => current.exactSizes?.some(rule => rule.areaTierId === row.areaTierId))
    if (matchBy !== 'exact-size') current.tierPrices.unshift({ areaTierId, price: null })
    current.formula = getDefaultTemplateFormula(matchBy)
    // A discarded, invalid draft must not block saving behind a hidden field.
    if (matchBy === 'exact-size' && current.basePrice !== null && !isUnitPrice(current.basePrice)) current.basePrice = null
  })
  const requestMatchBy = (matchBy: TemplateMatchBy) => {
    if (!template || matchBy === getTemplateMatchBy(template)) return
    const empty = !used && template.basePrice === null && template.tiers.length === 1
      && template.tiers[0].maxArea === null && template.tierPrices.every(row => row.price === null)
      && template.formula === getDefaultTemplateFormula(getTemplateMatchBy(template))
    if (empty) switchMatchBy(matchBy)
    else setSwitching(matchBy)
  }
  const removeTier = (areaTierId: string) => edit(current => {
    current.tiers = removeTierRange(current, areaTierId)
    current.tierPrices = current.tierPrices.filter(tier => tier.areaTierId !== areaTierId)
  })
  const addTier = () => edit(current => {
    const areaTierId = `area-tier-${crypto.randomUUID()}`
    const added = insertTierRange(current, areaTierId)
    current.tiers = added.tiers
    current.tierPrices.splice(added.index, 0, { areaTierId, price: null })
  })
  return <section className="pp-card area-list-card" aria-label="产品价格模板">
    <div className="pp-section-heading"><h4>产品价格模板</h4><Button type="primary" disabled={disabled} onClick={() => add()}>新增模板</Button></div>
    <p className="pp-help">每行一套模板，点击“编辑”设置匹配条件和价格。产品使用的模板在“产品基础单价”中选择。</p>
    <div className="area-table-scroll area-list-scroll"><table className="area-table area-list-table area-template-list" aria-label="产品价格模板表"><thead><tr><th scope="col">模板名称</th><th scope="col">单价计算方式</th><th scope="col">档位</th><th scope="col">基价（USD）</th><th scope="col">单价计算公式</th><th scope="col">操作</th></tr></thead><tbody>
      {document.templates.map(row => {
        const inUse = templateUsed(document, row.areaTemplateId)
        const cannotDelete = disabled || inUse || document.templates.length === 1
        return <tr key={row.areaTemplateId}>
          <th scope="row">{row.name}</th>
          <td>{getTemplateMatchBy(row) === 'exact-size' ? '固定尺寸' : getTemplateMatchBy(row) === 'longest-side' ? '最长边' : '面积'}<small>{getTemplateMatchBy(row) === 'exact-size' ? '各尺寸独立单位' : templateUnitLabel(row)}{row.standeeBase && ' · 套'}</small></td>
          <td title={getTemplatePriceRules(row).map(tier => areaTierLabel(row, tier)).join('；')}>{getTemplatePriceRules(row).length} 条{row.standeeBase && <small>底座 {getTemplatePriceRules(row.standeeBase).length} 条</small>}</td>
          <td>{getTemplateMatchBy(row) === 'exact-size' ? '—' : row.basePrice === null ? '未定价' : `$${row.basePrice}`}</td>
          <td className="area-list-formula">{getTemplateMatchBy(row) === 'exact-size' ? '按固定尺寸价格' : row.formula.replaceAll('基本价', '基价')}</td>
          <td><div className="area-list-actions">
            <Button type="link" aria-label={`编辑模板 ${row.areaTemplateId}`} disabled={disabled} onClick={() => open(row)}>编辑</Button>
            <Button type="text" aria-label={`复制模板 ${row.areaTemplateId}`} disabled={disabled} onClick={() => add(row)}>复制</Button>
            <Button type="text" danger aria-label={`删除模板 ${row.areaTemplateId}`} disabled={cannotDelete} title={inUse ? '使用中的模板需先在产品基础单价或产品属性价格方案中更换' : document.templates.length === 1 ? '至少保留一个价格模板' : undefined} onClick={() => setRemoving(row.areaTemplateId)}>删除</Button>
          </div></td>
        </tr>
      })}
    </tbody></table></div>
    <Modal className="area-editor-modal area-template-modal" width={template?.standeeBase ? 1240 : 1000} styles={{ body: { maxHeight: '65vh', overflowY: 'auto' } }} open={!!draft} title={draft?.isNew ? '新增产品价格模板' : '编辑产品价格模板'} okText="完成编辑" cancelText="取消" okButtonProps={{ disabled: disabled || !!validationError }} cancelButtonProps={{ disabled }} onCancel={() => { if (!disabled) close() }} onOk={finish} destroyOnHidden maskClosable={false}>
      {template && <>
        <p className="pp-help">完成编辑后更新页面草稿，点击页面上方“保存”后生效。取消会放弃本次弹窗修改。</p>
        {validationError && validationError !== EXACT_SIZE_REQUIRED_MESSAGE && validationError !== EXACT_SIZE_DIMENSIONS_REQUIRED_MESSAGE && <Alert type="error" showIcon message={displayPricingMessage(validationError)}/>}
        <div className="area-config-fields">
          <label>模板名称<Input aria-label="产品价格模板名称" value={template.name} disabled={disabled} onChange={event => edit(value => { value.name = event.target.value })}/></label>
          <label>价格计算方式<Select aria-label="模板价格计算方式" value={template.standeeBase ? 'standee' : 'single'} disabled={disabled} options={[{ value: 'single', label: '件' }, { value: 'standee', label: '套' }]} onChange={mode => {
            if (mode === 'standee' && !template.standeeBase) edit(value => { value.standeeBase = createStandeeBaseTemplate() })
            else if (mode === 'single' && template.standeeBase) setRemovingBase(true)
          }}/></label>
        </div>
        {template.standeeBase && <p className="pp-help">每片主体分别计价，再加一次底座费用。产品属性价格方案共用对应区间。</p>}
        <div className={`area-template-sections${template.standeeBase ? ' area-template-sections-paired' : ''}`}>
        <section className="area-template-panel" aria-label="主体片材价格区间">
        {template.standeeBase && <h4>主体片材价格区间</h4>}
        <div className={`area-config-fields area-template-rule-fields${isExact ? ' area-template-rule-fields-exact' : ''}`}>
          <label>单价计算方式<Select aria-label="模板单价计算方式" value={getTemplateMatchBy(template)} disabled={disabled} onChange={requestMatchBy} options={[{ value: 'area', label: '面积' }, { value: 'longest-side', label: '最长边' }, { value: 'exact-size', label: '固定尺寸' }]}/></label>
          {!isExact && <label>单位<Select aria-label="模板单位" value={template.unit} disabled={disabled} onChange={changeUnit} options={['in', 'cm', 'mm'].map(unit => ({ value: unit, label: isLongestSide ? unit : `${unit}²` }))}/></label>}
          {!isExact && <label>基价（USD）<Input aria-label="模板基价" inputMode="decimal" placeholder="未定价" value={template.basePrice ?? ''} disabled={disabled} onChange={event => edit(value => { value.basePrice = event.target.value.trim() ? event.target.value : null })}/></label>}
        </div>
        {!isExact && <><p className="pp-help">{isLongestSide ? `L 表示最长边，取宽、高中的较大值（${unitLabel}）。` : `A 表示面积（${unitLabel}）。`}</p>
        <div className="area-table-scroll"><table className="area-table area-template-table" aria-label="模板档位价格表"><thead><tr><th>{measureLabel}区间{isLongestSide ? `（${unitLabel}）` : ''}</th><th>价格（USD）</th><th>操作</th></tr></thead><tbody>
          {template.tiers.map((tier, index) => <tr key={tier.areaTierId}>
            <td>{isLongestSide || tier.minArea !== undefined ? <TierRangeInputs template={template} tier={tier} index={index} prefix={measureLabel} unit={unitLabel} disabled={disabled} onChange={tiers => edit(value => { value.tiers = tiers })}/> : <div className="area-tier-interval">{tier.maxArea === null
              ? <span>{index ? `${measureSymbol} ${template.boundaryMode === 'lower-inclusive' ? '≥' : '>'} ${displayAreaBoundary(template.tiers[index - 1].maxArea ?? '') || '待填写'} ${unitLabel}` : isLongestSide ? '全部长度' : '全部面积'}</span>
              : <><span className="area-tier-prefix">{index ? `${displayAreaBoundary(template.tiers[index - 1].maxArea ?? '') || '待填写'} ${template.boundaryMode === 'lower-inclusive' ? '≤' : '<'} ` : ''}{measureSymbol} {template.boundaryMode === 'lower-inclusive' ? '<' : '≤'}</span><Input aria-label={`${measureLabel}第${index + 1}档上限`} inputMode="decimal" value={tier.maxArea} disabled={disabled} suffix={unitLabel} onChange={event => edit(value => { value.tiers[index].maxArea = event.target.value })}/></>}
            </div>}</td>
            <td><RulePriceEditor label={`模板第${index + 1}档价格`} value={template.tierPrices.find(row => row.areaTierId === tier.areaTierId) ?? { areaTierId: tier.areaTierId, price: null }} disabled={disabled} onChange={price => edit(value => {
              const position = value.tierPrices.findIndex(row => row.areaTierId === tier.areaTierId)
              if (position < 0) value.tierPrices.push(price)
              else value.tierPrices[position] = price
            })}/></td>
            <td><Button danger type="text" aria-label={`删除${measureLabel}第${index + 1}档`} disabled={disabled || template.tiers.length === 1 || !isLongestSide && tier.minArea === undefined && tier.maxArea === null} onClick={() => removeTier(tier.areaTierId)}>删除</Button></td>
          </tr>)}
        </tbody></table></div>
        <div className="area-toolbar"><Button disabled={disabled} onClick={addTier}>新增{measureLabel}档位</Button></div></>}
        <ExactSizeRulesEditor value={template} prefix="模板" disabled={disabled} onlyExact={!!isExact} onChange={group => edit(value => { value.exactSizes = group.exactSizes; value.tierPrices = group.tierPrices })}/>
        {isLongestSide && !template.standeeBase && <p className="pp-help">最长边决定命中哪一档，单价按下方公式计算。默认“基价 + 档位价格”，也可自行调整。</p>}
        {!isExact && <><p className="pp-help">区间价格统一代入以下公式；固定尺寸直接使用填写的价格。</p>
        <AreaFormulaEditor label="单价计算公式" value={template.formula} variables={getTemplateFormulaVariables(template)} defaultFormula={getDefaultTemplateFormula(getTemplateMatchBy(template))} disabled={disabled} onChange={formula => edit(value => { value.formula = formula })}/></>}
        </section>
        {template.standeeBase && <StandeeBaseTemplateEditor value={template.standeeBase} disabled={disabled} onChange={base => edit(value => { value.standeeBase = base })}/>}
        </div>
      </>}
    </Modal>
    <Modal title="改为按件计价？" open={removingBase} okText="移除底座配置" cancelText="取消" onCancel={() => setRemovingBase(false)} onOk={() => { edit(value => { delete value.standeeBase }); setRemovingBase(false) }}>完成编辑后将移除模板及关联产品属性价格方案的底座价格。主体片材价格保留；启用主体片数的立牌产品需要“套”模板才能试算。</Modal>
    <Modal open={!!removing} title="删除这个产品价格模板？" okText="删除" cancelText="取消" okButtonProps={{ disabled }} onCancel={() => setRemoving(undefined)} onOk={() => {
      if (disabled) return
      onChange(next => { if (removing && next.templates.length > 1 && !templateUsed(next, removing)) next.templates = next.templates.filter(item => item.areaTemplateId !== removing) })
      setRemoving(undefined)
    }}>确认后先从当前草稿移除，请点击页面上方“保存”完成删除。未保存就刷新并放弃修改，会重新显示原模板。</Modal>
    <Modal open={!!switching} title="切换单价计算方式并重设区间？" okText="切换并重设" cancelText="取消" okButtonProps={{ disabled }} onCancel={() => setSwitching(undefined)} onOk={() => { if (switching && !disabled) switchMatchBy(switching); setSwitching(undefined) }}>
      <p>面积与长度的区间不能直接互换。切换为{switching === 'exact-size' ? '固定尺寸' : switching === 'longest-side' ? '最长边' : '面积'}后，将清空原区间、模板及所关联方案的档位价格，并恢复对应的默认单价公式；基价、固定尺寸、模板名称和产品关联保留。</p>
      <p>完成编辑后同步更新所关联方案的档位。取消本次模板编辑会保留原配置。</p>
    </Modal>
  </section>
}
