import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Pagination, Select, Spin, Switch } from 'antd'
import { addValue, allProducts, applyMembership, changeOrder, clone, definitions as publicDefinitions, deleteCategory, deleteValue, display, getProduct, isEnabled, locations, makeProduct, optionFor, ordered, productList, pruneRules, resolvePreview, setRule, setDefault, setEnabled, type Bundle, type Catalog, type Location, valueLabel, type OptionValue } from './model'
import { loadProductOptions, saveProductOptions } from './service'
import EditableNameSelect from './EditableNameSelect'
import OptionRuleEditor from './OptionRuleEditor'
import './product-options.css'

type Props = { onBusyChange?: (busy: boolean) => void }
type Confirmation = { title: string; run: (draft: Bundle) => void }
export default function ProductOptionsSettings({ onBusyChange }: Props) {
  const [bundle, setBundle] = useState<Bundle>()
  const [version, setVersion] = useState('')
  const [directory, setDirectory] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dirty, setDirty] = useState(false)
  const [filter, setFilter] = useState(-2)
  const [location, setLocation] = useState<Location>()
  const [optionIndex, setOptionIndex] = useState(0)
  const [valueFilter, setValueFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [styleId, setStyleId] = useState('')
  const [preview, setPreview] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<Confirmation>()
  const [membership, setMembership] = useState<{ retained: number[]; included: number[] }>()
  const [memberSearch, setMemberSearch] = useState('')
  const busy = useRef(false)
  const bundleRef = useRef<Bundle>(undefined)
  const mounted = useRef(true)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const load = async () => {
    if (busy.current) return
    busy.current = true; setLoading(true); setError('')
    try {
      const snapshot = await loadProductOptions()
      if (!mounted.current) return
      bundleRef.current = snapshot.bundle
      setBundle(snapshot.bundle); setVersion(snapshot.version); setDirectory(snapshot.directory); setDirty(false)
      setFilter(-2); setLocation(locations(snapshot.bundle.main, -2)[0]); setPreview({}); setStyleId(''); setNotice('')
    } catch (failure) { if (mounted.current) setError(String(failure)) }
    finally { busy.current = false; if (mounted.current) setLoading(false) }
  }
  useEffect(() => { void load() }, []) // Load once per settings session; section switching keeps drafts mounted.
  const edit = (change: (draft: Bundle) => void) => {
    if (busy.current) return
    if (!bundleRef.current) return
    const draft = clone(bundleRef.current)
    change(draft)
    bundleRef.current = draft
    setBundle(draft)
    setDirty(true); setNotice(''); setError(''); setPreview({})
  }
  const save = async () => {
    if (!bundle || busy.current) return
    busy.current = true; setSaving(true); onBusyChange?.(true); setError(''); setNotice('')
    try {
      const snapshot = await saveProductOptions(bundle, version)
      if (mounted.current) { setVersion(snapshot.version); setDirectory(snapshot.directory); setDirty(false); setNotice('配置已保存') }
    } catch (failure) { if (mounted.current) setError(String(failure)) }
    finally { busy.current = false; if (mounted.current) setSaving(false); onBusyChange?.(false) }
  }
  if (loading) return <div className="product-options-loading"><Spin/> 正在加载产品配置…</div>
  if (!bundle) return <Alert type="error" message={error || '配置加载失败'} action={<Button onClick={() => void load()}>重试</Button>}/>
  const { main } = bundle
  const product = getProduct(main, location)
  const definitions = [...publicDefinitions, ...(product?.productOptions.filter(option => !publicDefinitions.some(item => item.name === option.name)).map(option => ({ name: option.name, title: option.labelZh || option.name, file: '', prefix: 'X' })) ?? [])]
  const definition = definitions[optionIndex] ?? definitions[0]
  const catalog = (definition.file ? bundle.catalogs[definition.file] : optionFor(product!, definition.name)) as Catalog
  const productOption = product && optionFor(product, definition.name)
  const category = filter >= 0 ? main.categories[filter] : undefined
  const productCategory = location && location.category >= 0 ? main.categories[location.category] : undefined
  const prefix = display(productCategory ?? { titleZh: '未归类' })
  const available = locations(main, filter)
  const chooseCategory = (next: number) => { setFilter(next); setLocation(locations(main, next)[0]); setPreview({}) }
  const chooseProduct = (key: string) => { const [category, product] = key.split(':').map(Number); setLocation({ category, product }); setPreview({}) }
  const productKey = location ? `${location.category}:${location.product}` : undefined
  const categoryOptions = [{ value: -2, label: `全部产品（${allProducts(main).length}）` }, ...main.categories.map((item, i) => ({ value: i, label: `${display(item)}（${item.products.length}）` })), { value: -1, label: `未归类产品（${main.uncategorizedProducts.length}）` }]
  const productOptions = available.map(item => ({ value: `${item.category}:${item.product}`, label: display(getProduct(main, item)!) }))
  const editProduct = (change: (target: NonNullable<typeof product>) => void) => { if (location) edit(draft => { const target = getProduct(draft.main, location); if (target) change(target) }) }
  const editCatalog = (change: (target: typeof catalog, draft: Bundle) => void) => edit(draft => change((definition.file ? draft.catalogs[definition.file] : optionFor(getProduct(draft.main, location!)!, definition.name)) as Catalog, draft))
  const toggleValue = (id: string, enabled: boolean) => editProduct(target => setEnabled(optionFor(target, definition.name)!, id, enabled))
  const styles = ordered(catalog.values)
  const selectedStyle = styles.find(item => item.id === styleId) ?? styles[0]
  const visible = ordered(catalog.values).filter(value => valueFilter === 'all' || isEnabled(productOption, value.id) === (valueFilter === 'enabled'))

  const valueEditor = (value: OptionValue, parentId?: string) => {
    const enabled = isEnabled(productOption, value.id)
    const mutate = (change: (target: OptionValue, list: OptionValue[], targetCatalog: typeof catalog) => void) => editCatalog(target => {
      const list = parentId ? target.values.find(item => item.id === parentId)!.colors! : target.values
      const item = list.find(item => item.id === value.id)!
      change(item, list, target)
    })
    return <article className={`po-value ${enabled ? '' : 'po-value-disabled'}`} key={value.id} data-value-id={value.id}>
      <div className="po-value-heading">
        <div className="po-value-title"><label>序号 <InputNumber aria-label={`${value.id}序号`} min={1} precision={0} value={value.sortOrder} onChange={rank => { if (rank != null) mutate((_, list) => changeOrder(list, value.id, rank)) }}/></label><strong>{display(value)}</strong><span className="po-id">{value.id}</span></div>
        <div className="po-actions"><label><Switch size="small" checked={enabled} disabled={!product} aria-label={`${value.id}启用`} onChange={checked => toggleValue(value.id, checked)}/> 启用</label>
          <label><Switch size="small" checked={!!value.isDefault} aria-label={`${value.id}默认选中`} onChange={checked => mutate((_, __, target) => setDefault(target, checked ? value.id : '', parentId ? target.values.find(item => item.id === parentId) : undefined))}/> 默认选中</label>
          <Button danger size="small" onClick={() => setConfirm({ title: definition.file ? `删除“${display(value)}”？所有产品都会移除此公共${parentId ? '颜色' : '选项值'}。` : `删除“${display(value)}”？`, run: draft => { const target = (definition.file ? draft.catalogs[definition.file] : optionFor(getProduct(draft.main, location!)!, definition.name)) as Catalog; const parent = parentId ? target.values.find(item => item.id === parentId) : undefined; const item = (parent ? parent.colors! : target.values).find(item => item.id === value.id)!; if (definition.file) deleteValue(draft, target, item, parent); else { pruneRules(getProduct(draft.main, location!)!, definition.name, new Set([item.id])); target.values.splice(target.values.indexOf(item), 1); setEnabled(target as unknown as NonNullable<typeof productOption>, item.id, true); if (target.defaultValue === item.name) delete target.defaultValue } } })}>删除</Button>
        </div>
      </div>
      <div className="po-grid po-grid-two">
        <label>值标识（name）<Input aria-label={`${value.id}值标识`} value={value.name} onChange={event => mutate((target, _, root) => { const old = target.name; target.name = event.target.value; if (!parentId && root.defaultValue === old) root.defaultValue = target.name })}/></label>
        <label>中文名称（labelZh）<Input aria-label={`${value.id}中文名称`} value={value.labelZh ?? ''} onChange={event => mutate(target => { target.labelZh = event.target.value })}/></label>
        <label className="po-wide">图片地址（image）<Input aria-label={`${value.id}图片地址`} value={value.image ?? ''} onChange={event => mutate(target => { target.image = event.target.value })}/></label>
      </div>
      {product && <OptionRuleEditor key={`${product.id}:${definition.name}:${value.id}`} bundle={bundle} product={product} source={definition.name} valueId={value.id} onChange={(target, ids) => editProduct(item => setRule(item, definition.name, value.id, target, ids))}/>}
    </article>
  }

  const resolved = product ? resolvePreview(bundle, product, preview) : { selections: {}, hidden: new Map<string, Set<string>>() }
  const changePreview = (name: string, id: string, color = false) => {
    if (!product) return
    const next = { ...resolved.selections, [color ? `${name}:color` : name]: id }
    if (!color) delete next[`${name}:color`]
    setPreview(resolvePreview(bundle, product, next).selections)
  }
  const previewFields = definitions.flatMap(item => {
    const root = (item.file ? bundle.catalogs[item.file] : optionFor(product!, item.name)) as Catalog; const option = product && optionFor(product, item.name)
    if (!option || option.deleted) return []
    const values = ordered(root.values).filter(value => isEnabled(option, value.id) && !resolved.hidden.get(item.name)?.has(value.id))
    const chosen = values.find(value => value.id === resolved.selections[item.name])
    const fields = [<label key={item.name}>{root.labelZh}<Select aria-label={`预览${root.labelZh}`} placeholder={values.length ? '请选择' : '暂无启用的选项值'} allowClear value={chosen?.id} options={values.map(value => ({ value: value.id, label: valueLabel(value, root.values) }))} onChange={id => changePreview(item.name, id ?? '')}/>{!!root.values.filter(value => resolved.hidden.get(item.name)?.has(value.id)).length && <small>联动已隐藏 {root.values.filter(value => resolved.hidden.get(item.name)?.has(value.id)).length} 项</small>}</label>]
    if (item.prefix === 'P' && chosen) {
      const colors = ordered(chosen.colors ?? []).filter(color => isEnabled(option, color.id) && !resolved.hidden.get(item.name)?.has(color.id))
      if (colors.length) fields.push(<label key="colors">配件颜色<Select aria-label="预览配件颜色" placeholder="请选择" allowClear value={colors.find(color => color.id === resolved.selections[`${item.name}:color`])?.id} options={colors.map(color => ({ value: color.id, label: valueLabel(color, chosen.colors ?? []) }))} onChange={id => changePreview(item.name, id ?? '', true)}/></label>)
    }
    return fields
  })

  return <div className="product-options-settings" aria-busy={saving}>
    <div className="po-toolbar"><div><h3>产品选项配置</h3><span>公共选项统一维护，产品分别控制是否启用。</span></div><div className="po-actions">
      <Button disabled={saving} onClick={() => { if (dirty) setConfirm({ title: '刷新将放弃未保存修改，是否继续？', run: () => { void load() } }); else void load() }}>刷新</Button>
      <Button type="primary" loading={saving} disabled={saving || !dirty} onClick={() => void save()}>保存</Button>
    </div></div>
    {error && <Alert showIcon type="error" message={error}/>}{notice && <Alert showIcon type="success" message={notice}/>}
    <div className="po-status">{dirty ? '有未保存的修改。点击“保存”应用修改。' : '配置已同步。'}<span title={directory}>{directory}</span></div>
    <fieldset disabled={saving} className="po-fields">
      <div className="po-product-details" role="region" aria-label="产品类别和子类配置" tabIndex={0}>
      <section className="po-section"><div className="po-section-heading"><h3>步骤一：配置产品大类</h3><div className="po-actions">
        <Button onClick={() => edit(draft => { let n = 1; while (draft.main.categories.some(item => item.name === `category-${n}`)) n++; draft.main.categories.push({ name: `category-${n}`, title: `Category ${n}`, titleZh: '新产品类别', products: [] }); setFilter(draft.main.categories.length - 1); setLocation(undefined) })}>新增产品类别</Button>
        <Button disabled={!category} onClick={() => { setMembership({ retained: category!.products.map((_, i) => i), included: [] }); setMemberSearch('') }}>编辑</Button>
        <Button danger disabled={!category} onClick={() => setConfirm({ title: `删除“${display(category!)}”类别？子类将移至未归类产品。`, run: draft => { deleteCategory(draft.main, filter); setFilter(-1); setLocation(locations(draft.main, -1)[0]) } })}>删除产品类别</Button>
      </div></div><div className="po-grid po-grid-names">
        <label>产品类别<EditableNameSelect name={category ? '产品类别英文名称' : '产品类别'} selectionName="选择产品类别" text={category?.title ?? categoryOptions.find(item => item.value === filter)?.label ?? ''} selected={filter} options={categoryOptions} readOnly={!category} onSelect={chooseCategory} onTextChange={text => { if (category) edit(draft => { draft.main.categories[filter].title = text }) }}/></label>
        {category && <label>产品类别中文名称<Input value={category.titleZh} aria-label="产品类别中文名称" onChange={event => edit(draft => { draft.main.categories[filter].titleZh = event.target.value })}/></label>}
      </div></section>
      <section className="po-section"><div className="po-section-heading"><h3>步骤二：配置产品子类</h3><div className="po-actions">
        <Button onClick={() => edit(draft => { const target = filter >= 0 ? filter : -1; const list = productList(draft.main, target); list.push(makeProduct(draft.main)); setLocation({ category: target, product: list.length - 1 }) })}>新增{category ? display(category) : ''}产品</Button>
        <Button danger disabled={!product} onClick={() => setConfirm({ title: `删除产品“${display(product!)}”？`, run: draft => { productList(draft.main, location!.category).splice(location!.product, 1); setLocation(locations(draft.main, filter)[0]) } })}>删除{category ? display(category) : ''}产品</Button>
      </div></div><div className="po-grid po-grid-names">
        <label>{prefix}产品<EditableNameSelect name={product ? '产品名称' : '产品子类'} selectionName="选择产品子类" text={product?.title ?? ''} placeholder="暂无产品，请新增" selected={productKey} options={productOptions} disabled={!product} onSelect={chooseProduct} onTextChange={text => editProduct(target => { target.title = text })}/></label>
        {product && <label>{prefix}产品中文名<Input aria-label="产品中文名" value={product.titleZh} onChange={event => editProduct(target => { target.titleZh = event.target.value })}/></label>}
      </div></section>
      </div>
      <section className="po-section po-options-section"><div className="po-section-heading"><h3>步骤三：产品选项配置</h3></div>
        <div className="po-workspace"><nav className="po-option-list" aria-label="产品属性">
          <header className="po-option-add"><strong>产品属性</strong><Button size="small" disabled={!product} onClick={() => editProduct(target => { let n = 1; while (target.productOptions.some(option => option.name === `Option ${n}`)) n++; target.productOptions.push({ name: `Option ${n}`, label: 'New Option', labelZh: '新选项', deleted: false, values: [], nextId: 1 }); setOptionIndex(target.productOptions.length - 1); setValueFilter('all'); setPage(1) })}>新增</Button></header>
          {definitions.map((item, index) => { const root = (item.file ? bundle.catalogs[item.file] : optionFor(product!, item.name)) as Catalog; const option = product && optionFor(product, item.name); return <div key={item.name} className={index === optionIndex ? 'po-option-active' : ''}>
            <button type="button" onClick={() => { setOptionIndex(index); setPage(1); setValueFilter('all'); setStyleId('') }}><strong>{root.labelZh}</strong><small>{option?.deleted ? '已关闭' : product ? '已启用' : '未选择产品'} · {root.values.length} 个值</small></button>
            <Switch aria-label={`启用${item.title}`} size="small" checked={!!option && !option.deleted} disabled={!product} onChange={checked => editProduct(target => { optionFor(target, item.name)!.deleted = !checked })}/>
          </div> })}
        </nav><div className={`po-editor${!productOption || productOption.deleted ? ' po-editor-empty' : ''}`} key={definition.name} role="region" aria-label="选项编辑区" tabIndex={productOption && !productOption.deleted ? 0 : undefined}>{productOption && !productOption.deleted && <><div className="po-editor-heading"><h3>{catalog.labelZh}</h3><span>已启用</span></div>
          {definition.file && <p className="po-scope-hint">左侧产品属性开关只影响当前产品；名称、图片、默认值与排序由所有产品共用。</p>}
          <div className="po-grid po-grid-two"><label>选项标识（name）<Input value={catalog.name} readOnly/></label><label>中文名称（labelZh）<Input aria-label="属性中文名称" value={catalog.labelZh} onChange={event => editCatalog(target => { target.labelZh = event.target.value })}/></label><label>显示名称（label）<Input aria-label="属性显示名称" value={catalog.label ?? ''} onChange={event => editCatalog(target => { target.label = event.target.value })}/></label>
            <label>默认值<Select aria-label="属性默认值" value={catalog.values.find(value => value.isDefault)?.id ?? ''} options={[{ value: '', label: '不设置默认值' }, ...ordered(catalog.values).map(value => ({ value: value.id, label: display(value) }))]} onChange={id => editCatalog(target => setDefault(target, id))}/></label>
          </div>
          <div className="po-values-toolbar"><span>共 {catalog.values.length} 个值 · 已启用 {catalog.values.filter(value => isEnabled(productOption, value.id)).length} 个</span><div className="po-actions"><Select aria-label="选项值筛选" value={valueFilter} options={[{ value: 'all', label: '全部值' }, { value: 'enabled', label: '已启用' }, { value: 'disabled', label: '已关闭' }]} onChange={value => { setValueFilter(value); setPage(1) }}/><Button onClick={() => editCatalog(target => { const value = addValue(target); setStyleId(value.id); setValueFilter('all'); setPage(Math.ceil(target.values.length / 30)) })}>新增值</Button></div></div>
          {definition.prefix === 'P' ? <>
            <label className="po-style-select">选择配件样式<Select aria-label="编辑配件样式" value={visible.some(item => item.id === selectedStyle?.id) ? selectedStyle?.id : visible[0]?.id} options={visible.map(value => ({ value: value.id, label: `${value.sortOrder} · ${display(value)}` }))} onChange={setStyleId}/></label>
            {(() => { const style = visible.find(item => item.id === selectedStyle?.id) ?? visible[0]; if (!style) return <p className="po-empty">暂无符合条件的配件样式</p>; return <>{valueEditor(style)}<div className="po-section-heading po-colors-heading"><h4>“{display(style)}”的配件颜色（{style.colors?.length ?? 0}）</h4><Button onClick={() => editCatalog(target => { addValue(target, target.values.find(item => item.id === style.id)) })}>新增颜色</Button></div>{ordered(style.colors ?? []).map(color => valueEditor(color, style.id))}{!style.colors?.length && <p className="po-empty">此配件样式暂无颜色，可直接新增。</p>}</> })()}
          </> : <>{visible.slice((Math.min(page, Math.max(1, Math.ceil(visible.length / 30))) - 1) * 30, Math.min(page, Math.max(1, Math.ceil(visible.length / 30))) * 30).map(value => valueEditor(value))}{!visible.length && <p className="po-empty">暂无符合条件的选项值</p>}{visible.length > 30 && <Pagination current={Math.min(page, Math.ceil(visible.length / 30))} pageSize={30} total={visible.length} onChange={setPage} showSizeChanger={false}/>}</>}
        </>}</div><aside className="po-preview"><h3>实时预览</h3><div><label>产品类别<Select aria-label="预览产品类别" value={location?.category} options={categoryOptions.filter(item => item.value !== -2)} onChange={chooseCategory}/></label><label>{prefix}产品<Select aria-label="预览产品" placeholder="暂无产品" value={productKey} options={locations(main, location?.category ?? filter).map(item => ({ value: `${item.category}:${item.product}`, label: display(getProduct(main, item)!) }))} onChange={chooseProduct}/></label>{previewFields}{product && !previewFields.length && <p className="po-empty">此产品尚未启用任何选项</p>}</div></aside>
      </div></section>
    </fieldset>
    <Modal title={confirm?.title} open={!!confirm} maskClosable={false} keyboard={false} okText="确定" cancelText="取消" onCancel={() => setConfirm(undefined)} onOk={() => { const action = confirm; setConfirm(undefined); if (action) edit(action.run) }}/>
    <Modal title={`编辑产品类别：${category ? display(category) : ''}`} open={!!membership} maskClosable={false} keyboard={false} okText="应用" cancelText="取消" width={680} onCancel={() => setMembership(undefined)} onOk={() => { if (membership) edit(draft => { applyMembership(draft.main, filter, membership.retained, membership.included); setLocation(locations(draft.main, filter)[0]) }); setMembership(undefined) }}>
      {membership && category && <div className="po-membership"><p>当前 {category.products.length} 个子类；调整后 {membership.retained.length + membership.included.length} 个。取消勾选的子类将回到未归类产品。</p><Input placeholder="搜索产品名称" aria-label="搜索类别成员" value={memberSearch} onChange={event => setMemberSearch(event.target.value)}/>
        <h4>已有子类</h4><div className="po-members">{category.products.map((item, i) => ({ item, i })).filter(({ item }) => `${item.title} ${item.titleZh}`.toLowerCase().includes(memberSearch.toLowerCase())).map(({ item, i }) => <Checkbox key={i} checked={membership.retained.includes(i)} onChange={event => setMembership(current => current && ({ ...current, retained: event.target.checked ? [...current.retained, i] : current.retained.filter(index => index !== i) }))}>{display(item)}</Checkbox>)}</div>
        <h4>未归类产品</h4><div className="po-members">{main.uncategorizedProducts.map((item, i) => ({ item, i })).filter(({ item }) => `${item.title} ${item.titleZh}`.toLowerCase().includes(memberSearch.toLowerCase())).map(({ item, i }) => <Checkbox key={i} checked={membership.included.includes(i)} onChange={event => setMembership(current => current && ({ ...current, included: event.target.checked ? [...current.included, i] : current.included.filter(index => index !== i) }))}>{display(item)}</Checkbox>)}</div>
      </div>}
    </Modal>
  </div>
}
