import { useState } from 'react'
import { Button, Select } from 'antd'
import { catalogFor, isEnabled, ordered, valueLabel, type Bundle, type Product } from './model'

type Props = { bundle: Bundle; product: Product; source: string; valueId: string; onChange: (target: string, ids: string[]) => void }
export default function OptionRuleEditor({ bundle, product, source, valueId, onChange }: Props) {
  const [pending, setPending] = useState<string[]>([])
  const groups = product.optionRules?.find(rule => rule.when.option === source && rule.when.valueId === valueId)?.hide ?? []
  const targets = product.productOptions.filter(option => option.name !== source)
  const rows = [...new Set([...groups.map(group => group.option), ...pending])]
  if (!rows.length) rows.push('')
  return <div className="po-rule-editor">
    <strong>联动选项 <small>仅当前产品生效</small></strong>
    <p>已关闭的选项也可配置；重新开启后仍受联动选项约束。</p>
    {rows.map(target => {
      const option = targets.find(option => option.name === target)
      const catalog = option ? catalogFor(bundle, product, target) : undefined
      const selected = groups.find(group => group.option === target)?.valueIds ?? []
      const choices = ordered(catalog?.values ?? []).flatMap(value => [
        { value, label: valueLabel(value, catalog!.values), parentEnabled: true },
        ...ordered(value.colors ?? []).map(color => ({ value: color, label: `${valueLabel(value, catalog!.values)} / ${valueLabel(color, value.colors ?? [])}`, parentEnabled: isEnabled(option, value.id) })),
      ]).map(({ value, label, parentEnabled }) => {
        const closed = option?.deleted || !parentEnabled || !isEnabled(option, value.id)
        return { value: value.id, label: `${label}${closed ? '（已关闭）' : ''}` }
      })
      return <div className="po-rule-row" key={target}>
        <Select className="po-rule-attribute" aria-label={`${valueId}${target ? `目标属性${target}` : '添加联动属性'}`} placeholder="选择属性" value={target || null} options={targets.filter(option => option.name === target || !rows.includes(option.name)).map(option => ({ value: option.name, label: catalogFor(bundle, product, option.name).labelZh }))} onChange={name => { if (target) onChange(target, []); setPending(current => [...current.filter(item => item !== target), name]) }}/>
        <span className="po-rule-prompt">中隐藏后面这些选项</span>
        <Select className="po-rule-values" mode="multiple" aria-label={`${valueId}隐藏${catalog?.labelZh ?? '选项'}`} placeholder="选择需要隐藏的选项" disabled={!target} value={selected} options={choices} onChange={ids => onChange(target, ids)}/>
        {target && <Button size="small" danger onClick={() => { onChange(target, []); setPending(current => current.filter(name => name !== target)) }}>移除</Button>}
      </div>
    })}
    <Button size="small" disabled={rows.includes('') || rows.length >= targets.length} onClick={() => setPending(current => [...current, ''])}>＋添加联动规则</Button>
  </div>
}
