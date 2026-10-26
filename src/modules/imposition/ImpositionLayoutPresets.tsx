import { useState } from 'react'
import { Alert, Button, Input, InputNumber, Modal, Popconfirm, Tooltip } from 'antd'
import { ChevronLeft, ChevronRight, Check } from 'lucide-react'
import { DEFAULT_LAYOUT, validateLayoutConfig, type LayoutConfig, type LayoutPresetInput } from './layoutPresetStore'
import type { ImpositionLayoutPresetState } from './useImpositionLayoutPresets'

const FIELDS: Array<{ key: keyof LayoutConfig; label: string; min: number; precision: number; hint?: string }> = [
  { key: 'plateHeight', label: '板材高', min: 1, precision: 3 },
  { key: 'plateWidth', label: '板材宽', min: 1, precision: 3 },
  { key: 'effectiveHeight', label: '有效高', min: 1, precision: 3 },
  { key: 'effectiveWidth', label: '有效宽', min: 1, precision: 3 },
  { key: 'effectiveRight', label: '有效区域右侧距', min: 0, precision: 3 },
  { key: 'spacing', label: '图片间距', min: 0, precision: 3 },
  { key: 'holeSize', label: '版面孔直径', min: 0, precision: 3 },
  { key: 'holeCount', label: '版面孔数量', min: 0, precision: 0 },
  { key: 'holeGap', label: '孔间距', min: 0, precision: 3, hint: '相邻上孔顶部至下孔底部的距离（含孔径）' },
  { key: 'holeLeft', label: '版孔左侧距', min: 0, precision: 3 },
]

function Details({ name, config }: { name: string; config: LayoutConfig }) {
  return <div className="imposition-preset-details"><strong>{name}</strong><dl>
    {FIELDS.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{config[field.key]}{field.key === 'holeCount' ? ' 个' : ' mm'}</dd></div>)}
  </dl><small>孔间距为上孔顶部至下孔底部。</small></div>
}

export default function ImpositionLayoutPresets({ state, disabled = false }: { state: ImpositionLayoutPresetState; disabled?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<LayoutPresetInput>()
  const [formError, setFormError] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const canManage = import.meta.env.DEV && state.canManage
  const locked = disabled || state.loading || state.saving || !!state.error
  const details = state.selected && <Details name={state.selected.name} config={state.selected.config}/>
  const edit = (create: boolean) => {
    setFormError('')
    setDraft(create ? { name: '', config: { ...(state.selected?.config ?? DEFAULT_LAYOUT) } } : state.selected ? { ...state.selected, config: { ...state.selected.config } } : undefined)
  }
  const save = async () => {
    if (!draft || locked) return
    const error = !draft.name.trim() ? '请填写版面名称。' : validateLayoutConfig(draft.config)
    if (error) { setFormError(error); return }
    setFormError('')
    try { await state.save({ ...draft, name: draft.name.trim() }); setDraft(undefined) }
    catch (reason) { setFormError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`) }
  }
  return <section className={`imposition-layout-config${expanded ? ' is-expanded' : ''}`} aria-label="拼版版面配置">
    <div className="imposition-layout-summary">
      <Tooltip title={details} trigger={['hover', 'focus']} styles={{ root: { pointerEvents: 'none' } }} placement="bottomLeft">
        <button type="button" className="imposition-layout-toggle" aria-label={expanded ? '收起版面配置' : '展开版面配置'} aria-expanded={expanded} aria-controls="imposition-layout-presets" onClick={() => setExpanded(value => !value)}>
          <span><strong>版面配置{state.selected ? ` · ${state.selected.name}` : ''}</strong><small>{state.loading ? '加载配置…' : state.selected ? `${state.layout.plateWidth} × ${state.layout.plateHeight} mm` : '配置未就绪'}</small></span>
          {expanded ? <ChevronLeft size={16} aria-hidden="true"/> : <ChevronRight size={16} aria-hidden="true"/>}
        </button>
      </Tooltip>
      {state.preview && <small className="imposition-layout-preview">浏览器预览 · 默认配置</small>}
      {state.error && <div className="imposition-layout-error" role="alert"><span>配置加载失败</span><Button type="link" size="small" title={state.error} onClick={state.retry}>重试</Button></div>}
    </div>
    {expanded && <div id="imposition-layout-presets" className="imposition-layout-options">
      <div className="imposition-preset-cards" aria-label="选择版面配置">
        {state.presets.map(preset => <Tooltip key={preset.id} title={<Details name={preset.name} config={preset.config}/>} trigger={['hover', 'focus']} styles={{ root: { pointerEvents: 'none' } }} placement="bottom">
          <button type="button" className="imposition-preset-card" aria-label={`选择${preset.name}`} aria-pressed={state.selected?.id === preset.id} disabled={locked} onClick={() => { setDeleteError(''); state.select(preset.id) }}>
            <strong>{preset.name}{state.selected?.id === preset.id && <Check size={13} aria-hidden="true"/>}</strong>
            <span>有效 {preset.config.effectiveWidth} × {preset.config.effectiveHeight}</span><small>间距 {preset.config.spacing} mm</small>
          </button>
        </Tooltip>)}
      </div>
      {canManage && <div className="imposition-preset-actions">
        <Button aria-label="新增版面配置" size="small" disabled={locked} onClick={() => edit(true)}>新增</Button>
        <Button aria-label="编辑版面配置" size="small" disabled={locked || !state.selected} onClick={() => edit(false)}>编辑</Button>
        <Popconfirm title={`删除“${state.selected?.name ?? ''}”版面配置？`} description="已生成的拼版将清空，需要重新计算。" okText="删除" okButtonProps={{ 'aria-label': '确认删除版面配置' }} cancelText="取消" disabled={locked || state.presets.length <= 1} onConfirm={async () => {
          setDeleteError('')
          try { await state.remove() } catch (reason) { setDeleteError(`删除失败：${reason instanceof Error ? reason.message : String(reason)}`) }
        }}><Button aria-label="删除版面配置" size="small" danger disabled={locked || state.presets.length <= 1}>删除</Button></Popconfirm>
      </div>}
      {deleteError && <span className="imposition-layout-error" role="alert">{deleteError}</span>}
    </div>}
    <Modal title={draft?.id ? '编辑版面配置' : '新增版面配置'} open={!!draft} onCancel={() => { if (!state.saving) setDraft(undefined) }} onOk={() => void save()} okText="保存" cancelText="取消" confirmLoading={state.saving} cancelButtonProps={{ disabled: state.saving }} okButtonProps={{ disabled: locked }} closable={!state.saving} maskClosable={!state.saving} keyboard={!state.saving} width={560} destroyOnHidden>
      {draft && <div className="imposition-preset-form">
        <label className="imposition-preset-name">版面名称<Input aria-label="版面名称" maxLength={40} value={draft.name} disabled={state.saving} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
        <div className="imposition-layout-fields">{FIELDS.map(field => <label key={field.key} title={field.hint}>{field.label}{field.key === 'holeCount' ? '' : ' (mm)'}<InputNumber aria-label={field.label} min={field.min} precision={field.precision} value={draft.config[field.key]} disabled={state.saving} onChange={value => setDraft({ ...draft, config: { ...draft.config, [field.key]: value ?? draft.config[field.key] } })}/></label>)}</div>
        <small>孔间距为相邻上孔顶部至下孔底部的距离。保存当前配置后需要重新拼版。</small>
        {formError && <Alert type="error" showIcon message={formError}/>}
      </div>}
    </Modal>
  </section>
}
