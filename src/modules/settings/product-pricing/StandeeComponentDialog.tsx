import { useState } from 'react'
import { Alert, Button, Input, Modal, Select } from 'antd'
import type { SignedPriceRange, StandeePriceComponent } from './model'
import PriceInput from './PriceInput'

type Props = {
  component: StandeePriceComponent
  title: string
  onApply: (component: StandeePriceComponent) => void
  onCancel: () => void
}

export default function StandeeComponentDialog({ component, title, onApply, onCancel }: Props) {
  const [draft, setDraft] = useState(() => structuredClone(component))
  const [error, setError] = useState<string | null>(null)
  const edit = (change: (value: StandeePriceComponent) => void) => {
    setDraft(current => {
      const next = structuredClone(current)
      change(next)
      return next
    })
    setError(null)
  }
  const apply = () => {
    const message = validateDraft(draft)
    if (message) {
      setError(message)
      return
    }
    onApply(structuredClone(draft))
  }
  return <Modal open title={title} width={1100} okText="应用" cancelText="取消" maskClosable={false} onOk={apply} onCancel={onCancel} styles={{ body: { maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 } }}>
    <p className="pp-help">这个组成使用同一组主体片材尺寸和底座尺寸。金额可以为负数，表示从主体基准中抵扣，以保持旧价格完全一致。</p>
    {error && <Alert type="error" showIcon message={error} role="alert" />}
    <div className="pp-panel-toolbar">
      <label>组成标识<Input value={draft.componentId} disabled /></label>
      <label>面板模板<Input value={draft.panelTemplateId} disabled /></label>
      <label>底座调整<PriceInput label="组成底座调整" value={draft.baseAdjustment} signed onChange={value => edit(next => { next.baseAdjustment = value })} /></label>
    </div>
    <SignedRangeEditor title="片材价格区间" ranges={draft.pieceBands} onChange={ranges => edit(next => { next.pieceBands = ranges })} />
    <SignedRangeEditor title="底座价格区间" ranges={draft.baseBands} onChange={ranges => edit(next => { next.baseBands = ranges })} />
  </Modal>
}

function SignedRangeEditor({ title, ranges, onChange }: { title: string; ranges: SignedPriceRange[]; onChange: (ranges: SignedPriceRange[]) => void }) {
  const update = (change: (next: SignedPriceRange[]) => void) => {
    const next = structuredClone(ranges)
    change(next)
    onChange(next)
  }
  return <section className="pp-standee-range-editor" aria-label={title}>
    <h5>{title}</h5>
    <div className="pp-table-wrap" role="region" aria-label={`${title}表`} tabIndex={0}><table className="pp-range-table"><thead><tr><th>最长边起点（mm）</th><th>最长边终点（mm）</th><th>计价方式</th><th>金额</th><th>面积系数</th><th>操作</th></tr></thead><tbody>
      {ranges.map((range, index) => <tr key={range.rangeId}><td><Input aria-label={`${title}第${index + 1}段起点`} inputMode="decimal" value={range.minMm} onChange={event => update(next => { next[index].minMm = event.target.value })} /></td><td><Input aria-label={`${title}第${index + 1}段终点`} inputMode="decimal" value={range.maxMm} onChange={event => update(next => { next[index].maxMm = event.target.value })} /></td><td><Select aria-label={`${title}第${index + 1}段方式`} value={range.kind} options={[{ value: 'fixed', label: '固定金额' }, { value: 'area', label: '宽 × 高 × 系数 + 固定金额' }]} onChange={(kind: SignedPriceRange['kind']) => update(next => { next[index].kind = kind; if (kind === 'fixed') next[index].coefficient = '0' })} /></td><td><PriceInput label={`${title}第${index + 1}段金额`} value={range.amount} signed onChange={value => update(next => { next[index].amount = value })} /></td><td><Input aria-label={`${title}第${index + 1}段面积系数`} inputMode="decimal" value={range.coefficient} disabled={range.kind === 'fixed'} onChange={event => update(next => { next[index].coefficient = event.target.value })} /></td><td><Button type="text" danger aria-label={`删除${title}第${index + 1}段`} onClick={() => update(next => { next.splice(index, 1) })}>删除</Button></td></tr>)}
    </tbody></table></div>
    <Button aria-label={`新增${title}区间`} onClick={() => update(next => { next.push({ rangeId: `range-${crypto.randomUUID()}`, minMm: '', maxMm: '', kind: 'fixed', amount: '0', coefficient: '0' }) })}>新增区间</Button>
  </section>
}

function validateDraft(component: StandeePriceComponent): string | null {
  if (!component.componentId.trim() || !component.panelTemplateId.trim()) return '组成标识不能为空'
  if (!component.baseAdjustment.trim() || !/^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,18})?$/.test(component.baseAdjustment)) return '底座调整金额格式无效'
  for (const [label, ranges] of [['片材', component.pieceBands], ['底座', component.baseBands]] as const) {
    if (!ranges.length) return `${label}至少需要一个价格区间`
    for (const range of ranges) {
      if (!/^\d+(?:\.\d+)?$/.test(range.minMm) || !/^\d+(?:\.\d+)?$/.test(range.maxMm)) return `${label}区间尺寸必须是正数`
      if (Number(range.minMm) <= 0 || Number(range.maxMm) < Number(range.minMm)) return `${label}区间尺寸无效`
      if (!/^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,18})?$/.test(range.amount) || !/^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,18})?$/.test(range.coefficient)) return `${label}区间金额格式无效`
      if (range.kind === 'fixed' && range.coefficient !== '0') return '固定金额区间的面积系数必须为0'
    }
    const sorted = ranges.slice().sort((a, b) => Number(a.minMm) - Number(b.minMm))
    for (let index = 1; index < sorted.length; index++) if (Number(sorted[index].minMm) <= Number(sorted[index - 1].maxMm)) return `${label}区间不能重叠`
  }
  return null
}
