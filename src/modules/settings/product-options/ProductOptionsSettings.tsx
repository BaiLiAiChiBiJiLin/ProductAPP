import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Input, Modal, Pagination, Select, Spin, Switch } from 'antd'
import { addValue, allProducts, applyMembership, clone, definitions as publicDefinitions, deleteCategory, deleteValue, display, entityReference, getEntityId, getEntityKey, getProduct, isEnabled, locations, makeProduct, moveOptionValue, optionFor, ordered, productList, resolvePreview, setDefault, setStandeeQuantityDefault, sameEntity, setEnabled, type Bundle, type Catalog, type EntityReference, type Location, valueLabel, type OptionValue } from './model'
import { loadProductOptions, saveProductOptions } from './service'
import EditableNameSelect from './EditableNameSelect'
import OptionImageEditor from './OptionImageEditor'
import SizeAreaInput from './SizeAreaInput'
import { emptySizeArea, type SizeArea } from './sizeArea'
import useOptionCardSorting, { type OptionSortGroup } from './useOptionCardSorting'
import './product-options.css'

type Props = { onBusyChange?: (busy: boolean) => void }
const contentInputSize = (value: string) => Math.max(1, [...value].reduce((size, char) => size + (char.codePointAt(0)! > 255 ? 2 : 1), 0))
type Confirmation = { title: string; run: (draft: Bundle) => void }
const selectionId = (value?: EntityReference) => value ? getEntityId(value) : undefined
export default function ProductOptionsSettings({ onBusyChange }: Props) {
  const [bundle, setBundle] = useState<Bundle>()
  const [version, setVersion] = useState('')
  const [directory, setDirectory] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [imageUploads, setImageUploads] = useState(0)
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
  const [customPreviewArea, setCustomPreviewArea] = useState<SizeArea>(emptySizeArea)
  const [confirm, setConfirm] = useState<Confirmation>()
  const [membership, setMembership] = useState<{ retained: number[]; included: number[] }>()
  const [memberSearch, setMemberSearch] = useState('')
  const busy = useRef(false)
  const imageUploadsRef = useRef(0)
  const bundleRef = useRef<Bundle>(undefined)
  const mounted = useRef(true)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const load = async () => {
    if (busy.current || imageUploadsRef.current) return
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
  const imageUploadStateChanged = (uploading: boolean) => {
    imageUploadsRef.current = Math.max(0, imageUploadsRef.current + (uploading ? 1 : -1))
    if (mounted.current) setImageUploads(imageUploadsRef.current)
    onBusyChange?.(busy.current || imageUploadsRef.current > 0)
  }
  const edit = (change: (draft: Bundle) => void) => {
    if (busy.current) return
    if (!bundleRef.current) return
    const draft = clone(bundleRef.current)
    change(draft)
    bundleRef.current = draft
    setBundle(draft)
    setDirty(true); setNotice(''); setError(''); setPreview({})
  }
  const sorting = useOptionCardSorting({
    disabled: loading || saving || imageUploads > 0 || !!confirm || !!membership,
    context: `${location?.category}:${location?.product}:${optionIndex}:${styleId}:${valueFilter}:${page}:${version}`,
    onMove: (group, source, target, position) => {
      if (busy.current || !bundleRef.current) return false
      const draft = clone(bundleRef.current)
      const product = allProducts(draft.main).find(item => item.productId === group.productId)
      const catalog = group.catalogFile ? draft.catalogs[group.catalogFile] : product && optionFor(product, group.optionName)
      const values = group.parentId ? catalog?.values?.find(item => getEntityId(item) === group.parentId)?.colors : catalog?.values
      if (!values || !moveOptionValue(values, source, target, position)) return false
      bundleRef.current = draft; setBundle(draft); setDirty(true); setNotice(''); setError(''); setPreview({})
      return true
    },
  })
  const save = async () => {
    if (!bundle || busy.current || imageUploadsRef.current) return
    busy.current = true; setSaving(true); onBusyChange?.(true); setError(''); setNotice('')
    try {
      const snapshot = await saveProductOptions(bundle, version)
      if (mounted.current) { bundleRef.current = snapshot.bundle; setBundle(snapshot.bundle); setVersion(snapshot.version); setDirectory(snapshot.directory); setDirty(false); setNotice('配置已保存') }
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
  const isStandeeQuantity = definition.name === 'Standee Quantity'
  const isSize = definition.name === 'Size'
  const category = filter >= 0 ? main.categories[filter] : undefined
  const productCategory = location && location.category >= 0 ? main.categories[location.category] : undefined
  const prefix = display(productCategory ?? { titleZh: '未归类' })
  const available = locations(main, filter)
  const chooseCategory = (next: number) => { if (imageUploadsRef.current) return; setFilter(next); setLocation(locations(main, next)[0]); setPreview({}) }
  const chooseProduct = (productId: string) => { if (imageUploadsRef.current) return; setLocation(locations(main, -2).find(item => getProduct(main, item)?.productId === productId)); setPreview({}); setCustomPreviewArea(emptySizeArea()) }
  const productKey = product?.productId
  const categoryOptions = [{ value: -2, label: `全部产品（${allProducts(main).length}）` }, ...main.categories.map((item, i) => ({ value: i, label: `${display(item)}（${item.products.length}）` })), { value: -1, label: `未归类产品（${main.uncategorizedProducts.length}）` }]
  const productOptions = available.map(item => ({ value: getProduct(main, item)!.productId, label: display(getProduct(main, item)!) }))
  const editProduct = (change: (target: NonNullable<typeof product>) => void) => { if (location) edit(draft => { const target = getProduct(draft.main, location); if (target) change(target) }) }
  const editCatalog = (change: (target: typeof catalog, draft: Bundle) => void) => edit(draft => change((definition.file ? draft.catalogs[definition.file] : optionFor(getProduct(draft.main, location!)!, definition.name)) as Catalog, draft))
  const toggleValue = (value: EntityReference, enabled: boolean) => editProduct(target => setEnabled(optionFor(target, definition.name)!, value, enabled))
  const styles = ordered(catalog.values)
  const selectedStyle = styles.find(item => getEntityId(item) === styleId) ?? styles[0]
  const visible = ordered(catalog.values).filter(value => valueFilter === 'all' || isEnabled(productOption, value) === (valueFilter === 'enabled'))

  const valueEditor = (value: OptionValue, parentId?: string) => {
    const valueId = getEntityId(value)
    const reference = entityReference(value)
    const enabled = isEnabled(productOption, reference)
    const sortGroup: OptionSortGroup = { id: JSON.stringify([definition.file || product?.productId, definition.name, parentId ?? '']), values: parentId ? catalog.values.find(item => getEntityId(item) === parentId)?.colors ?? [] : catalog.values, optionName: definition.name, catalogFile: definition.file, productId: product?.productId, parentId }
    const mutate = (change: (target: OptionValue, list: OptionValue[], targetCatalog: typeof catalog) => void) => editCatalog(target => {
      const list = parentId ? target.values.find(item => getEntityId(item) === parentId)!.colors! : target.values
      const item = list.find(item => getEntityId(item) === valueId)!
      change(item, list, target)
    })
    return <article className={`po-value ${enabled ? '' : 'po-value-disabled'}`} key={valueId} data-value-id={valueId} data-entity-key={getEntityKey(value)} {...sorting.getCardProps(value, sortGroup)}>
      <div className="po-value-heading">
        <div className="po-value-title"><button type="button" className="po-sort-handle" {...sorting.getHandleProps(value, sortGroup)}>{value.sortOrder}:</button><strong title={value.name}>{value.name || '未命名'}</strong><span className="po-id" title={`${getEntityKey(value)}: ${valueId}`}>{getEntityKey(value)}: {valueId}</span></div>
        <div className="po-actions po-value-actions"><label><Switch size="small" checked={enabled} disabled={!product} aria-label={`${valueId}启用`} onChange={checked => toggleValue(reference, checked)}/> 启用</label>
          <label><Switch size="small" checked={isStandeeQuantity ? sameEntity(productOption?.defaultValue, reference) : !!value.isDefault} aria-label={`${valueId}默认选中`} onChange={checked => isStandeeQuantity ? editProduct(target => setStandeeQuantityDefault(target, catalog, checked ? reference : undefined)) : mutate((_, __, target) => setDefault(target, checked ? reference : undefined, parentId ? target.values.find(item => getEntityId(item) === parentId) : undefined))}/> 默认选中</label>
          <Button danger size="small" onClick={() => setConfirm({ title: definition.file ? `删除“${display(value)}”？所有产品都会移除此公共${parentId ? '颜色' : '选项值'}。` : `删除“${display(value)}”？`, run: draft => { const target = (definition.file ? draft.catalogs[definition.file] : optionFor(getProduct(draft.main, location!)!, definition.name)) as Catalog; const parent = parentId ? target.values.find(item => getEntityId(item) === parentId) : undefined; const item = (parent ? parent.colors! : target.values).find(item => getEntityId(item) === valueId)!; if (definition.file) deleteValue(draft, target, item, parent); else { target.values.splice(target.values.indexOf(item), 1); setEnabled(target as unknown as NonNullable<typeof productOption>, reference, true); if (target.defaultValue && getEntityId(target.defaultValue) === valueId) delete target.defaultValue } } })}>删除</Button>
        </div>
      </div>
      <div className={isSize && !value.isCustom ? 'po-size-value-content' : !isSize && !isStandeeQuantity ? 'po-value-content' : ''}>
        <div className="po-grid po-value-fields">
        <label><span title="name">值标识</span><Input aria-label={`${valueId}值标识`} htmlSize={contentInputSize(value.name)} value={value.name} onChange={event => mutate(target => { target.name = event.target.value })}/></label>
        <label><span title="labelZh">中文名</span><Input aria-label={`${valueId}中文名称`} htmlSize={contentInputSize(value.labelZh ?? '')} value={value.labelZh ?? ''} onChange={event => mutate(target => { target.labelZh = event.target.value })}/></label>
        {isStandeeQuantity && <label className="po-piece-count"><span>主体片数</span><Input aria-label={`${valueId}实际主体片数`} value={`${value.pieceCount}片`} readOnly title="对应同数量插口；修改名称不改变实际片数。"/></label>}
        </div>
        {isSize && (value.isCustom ? <p className="po-custom-size-hint">自定义尺寸，启用后可在选择此项时填写宽、高和单位。</p> : <SizeAreaInput compact label={valueId} value={value.area ?? emptySizeArea()} onChange={area => mutate(target => { target.area = area })}/>)}
        {!isSize && !isStandeeQuantity && <OptionImageEditor key={`${productKey}:${definition.name}:${parentId ?? ''}:${valueId}`} entityKey={getEntityKey(value)} valueId={valueId} label={display(value)} image={value.image} onUploadStateChange={imageUploadStateChanged} onChange={image => edit(draft => {
          const owner = allProducts(draft.main).find(item => item.productId === sortGroup.productId)
          const target = sortGroup.catalogFile ? draft.catalogs[sortGroup.catalogFile] : owner && optionFor(owner, sortGroup.optionName)
          const values = sortGroup.parentId ? target?.values?.find(item => getEntityId(item) === sortGroup.parentId)?.colors : target?.values
          const item = values?.find(item => sameEntity(item, reference))
          if (item) item.image = image
        })}/>}
      </div>
    </article>
  }

  const resolved: ReturnType<typeof resolvePreview> = product ? resolvePreview(bundle, product, preview) : { selections: {}, selectedValues: {} }
  const changePreview = (name: string, id: string, color = false) => {
    if (!product) return
    const next = { ...resolved.selections, [color ? `${name}:color` : name]: id }
    if (!color) delete next[`${name}:color`]
    setPreview(resolvePreview(bundle, product, next).selections)
  }
  const previewFields = definitions.flatMap(item => {
    const root = (item.file ? bundle.catalogs[item.file] : optionFor(product!, item.name)) as Catalog; const option = product && optionFor(product, item.name)
    if (!option || option.deleted) return []
    const values = ordered(root.values).filter(value => isEnabled(option, value))
    const chosen = values.find(value => getEntityId(value) === resolved.selections[item.name])
    const fields = [<label key={item.name}>{root.labelZh}<Select aria-label={`预览${root.labelZh}`} placeholder={values.length ? '请选择' : '暂无启用的选项值'} allowClear value={selectionId(chosen)} options={values.map(value => ({ value: getEntityId(value), label: valueLabel(value, root.values) }))} onChange={id => changePreview(item.name, id ?? '')}/></label>]
    if (item.name === 'Size' && chosen?.isCustom) fields.push(<SizeAreaInput key="custom-size-area" label="预览自定义" value={customPreviewArea} onChange={setCustomPreviewArea}/> )
    if (item.prefix === 'P' && chosen) {
      const colors = ordered(chosen.colors ?? []).filter(color => isEnabled(option, color))
      if (colors.length) fields.push(<label key="colors">配件颜色<Select aria-label="预览配件颜色" placeholder="请选择" allowClear value={selectionId(colors.find(color => getEntityId(color) === resolved.selections[`${item.name}:color`]))} options={colors.map(color => ({ value: getEntityId(color), label: valueLabel(color, chosen.colors ?? []) }))} onChange={id => changePreview(item.name, id ?? '', true)}/></label>)
    }
    return fields
  })

  return <div className="product-options-settings" aria-busy={saving || imageUploads > 0}>
    <span className="po-sr-only" id={sorting.helpId}>拖动卡片排序；也可聚焦序号后按上、左方向键前移，下、右方向键后移。按 Escape 取消拖动，保存后生效。</span>
    <span className="po-sr-only" role="status" aria-live="polite">{sorting.announcement}</span>
    <div className="po-toolbar"><div><h3>产品选项配置</h3><span>公共选项统一维护，产品分别控制是否启用。</span></div><div className="po-actions">
      <Button disabled={saving || imageUploads > 0} onClick={() => { if (dirty) setConfirm({ title: '刷新将放弃未保存修改，是否继续？', run: () => { void load() } }); else void load() }}>刷新</Button>
      <Button type="primary" loading={saving} disabled={saving || imageUploads > 0 || !dirty} onClick={() => void save()}>保存</Button>
    </div></div>
    {error && <Alert showIcon type="error" message={error}/>}{notice && <Alert showIcon type="success" message={notice}/>}
    <div className="po-status">{imageUploads > 0 ? '正在上传图片，完成后请保存配置。' : dirty ? '有未保存的修改。点击“保存”应用修改。' : '配置已同步。'}<span title={directory}>{directory}</span></div>
    <fieldset disabled={saving || imageUploads > 0} className="po-fields">
      <div className="po-product-details" role="region" aria-label="产品类别和子类配置" tabIndex={0}>
      <section className="po-section"><div className="po-section-heading"><h3>步骤一：配置产品大类</h3><div className="po-actions">
        <Button onClick={() => edit(draft => { let n = 1; while (draft.main.categories.some(item => item.title === `Category ${n}`)) n++; draft.main.categories.push({ name: `category-${crypto.randomUUID()}`, title: `Category ${n}`, titleZh: '新产品类别', products: [] }); setFilter(draft.main.categories.length - 1); setLocation(undefined) })}>新增产品类别</Button>
        <Button disabled={!category} onClick={() => { setMembership({ retained: category!.products.map((_, i) => i), included: [] }); setMemberSearch('') }}>编辑</Button>
        <Button danger disabled={!category} onClick={() => setConfirm({ title: `删除“${display(category!)}”类别？子类将移至未归类产品。`, run: draft => { deleteCategory(draft.main, filter); setFilter(-1); setLocation(locations(draft.main, -1)[0]) } })}>删除产品类别</Button>
      </div></div><div className="po-grid po-grid-names">
        <label>产品类别<EditableNameSelect name={category ? '产品类别英文名称' : '产品类别'} selectionName="选择产品类别" text={category?.title ?? categoryOptions.find(item => item.value === filter)?.label ?? ''} selected={filter} options={categoryOptions} readOnly={!category} onSelect={chooseCategory} onTextChange={text => { if (category) edit(draft => { draft.main.categories[filter].title = text }) }}/></label>
        {category && <label>产品类别中文名称<Input value={category.titleZh} aria-label="产品类别中文名称" onChange={event => edit(draft => { draft.main.categories[filter].titleZh = event.target.value })}/></label>}
      </div></section>
      <section className="po-section"><div className="po-section-heading"><h3>步骤二：配置产品子类</h3>{product && <span className="po-id" aria-label="产品 ID">productId: {product.productId}</span>}<div className="po-actions">
        <Button onClick={() => edit(draft => { const target = filter >= 0 ? filter : -1; const list = productList(draft.main, target); list.push(makeProduct(draft.main, target >= 0 ? draft.main.categories[target]?.name : undefined, draft.catalogs['standee-quantities.json'], draft.catalogs['sizes.json'])); setLocation({ category: target, product: list.length - 1 }) })}>新增{category ? display(category) : ''}产品</Button>
        <Button danger disabled={!product} onClick={() => setConfirm({ title: `删除产品“${display(product!)}”？`, run: draft => { productList(draft.main, location!.category).splice(location!.product, 1); setLocation(locations(draft.main, filter)[0]) } })}>删除{category ? display(category) : ''}产品</Button>
      </div></div><div className="po-grid po-grid-names">
        <label>{prefix}产品<EditableNameSelect name={product ? '产品名称' : '产品子类'} selectionName="选择产品子类" text={product?.title ?? ''} placeholder="暂无产品，请新增" selected={productKey} options={productOptions} disabled={!product} onSelect={chooseProduct} onTextChange={text => editProduct(target => { target.title = text })}/></label>
        {product && <label>{prefix}产品中文名<Input aria-label="产品中文名" value={product.titleZh} onChange={event => editProduct(target => { target.titleZh = event.target.value })}/></label>}
      </div></section>
      </div>
      <section className="po-section po-options-section"><div className="po-section-heading"><h3>步骤三：产品选项配置</h3></div>
        <div className="po-workspace"><nav className="po-option-list" aria-label="产品属性">
          <header className="po-option-add"><strong>产品属性</strong><Button size="small" disabled={!product} onClick={() => editProduct(target => { let n = 1; while (target.productOptions.some(option => option.name === `Option ${n}`)) n++; target.productOptions.push({ name: `Option ${n}`, label: 'New Option', labelZh: '新选项', deleted: true, values: [], nextId: 1 }); setOptionIndex(target.productOptions.length - 1); setValueFilter('all'); setPage(1) })}>新增</Button></header>
          {definitions.map((item, index) => { const root = (item.file ? bundle.catalogs[item.file] : optionFor(product!, item.name)) as Catalog; const option = product && optionFor(product, item.name); return <div key={item.name} className={index === optionIndex ? 'po-option-active' : ''}>
            <button type="button" onClick={() => { setOptionIndex(index); setPage(1); setValueFilter('all'); setStyleId('') }}><strong>{root.labelZh}</strong><small>{option?.deleted ? '已关闭' : product ? '已启用' : '未选择产品'} · {root.values.length} 个值</small></button>
            <Switch aria-label={`启用${item.title}`} size="small" checked={!!option && !option.deleted} disabled={!product} onChange={checked => editProduct(target => { optionFor(target, item.name)!.deleted = !checked })}/>
          </div> })}
        </nav><div className={`po-editor${!productOption || productOption.deleted ? ' po-editor-empty' : ''}`} key={definition.name} role="region" aria-label="选项编辑区" tabIndex={productOption && !productOption.deleted ? 0 : undefined}>{productOption && !productOption.deleted && <><div className="po-editor-heading"><h3>{catalog.labelZh}</h3><span>已启用</span></div>
          <p className="po-scope-hint">{isSize ? '产品定价直接读取这里已启用的尺寸。新增尺寸默认对所有产品关闭，再按产品手动启用；名称、默认值和排序由所有产品共用。' : definition.file ? (isStandeeQuantity ? '主体片数决定每套立牌的片材数及对应插口数，购买套数另计。新增片数默认对所有产品关闭，再按产品手动启用；名称和排序由所有产品共用。' : '左侧产品属性开关只影响当前产品；新增选项值默认对所有产品关闭，再按产品手动启用；名称、图片、默认值与排序由所有产品共用。') : '左侧产品属性开关、启用值、默认值仅影响当前产品；新增属性和值默认关闭，再按产品手动启用。'}</p>
          <div className="po-grid po-grid-two"><label>选项标识（name）<Input value={catalog.name} readOnly/></label><label>中文名称（labelZh）<Input aria-label="属性中文名称" value={catalog.labelZh} onChange={event => editCatalog(target => { target.labelZh = event.target.value })}/></label><label>显示名称（label）<Input aria-label="属性显示名称" value={catalog.label ?? ''} onChange={event => editCatalog(target => { target.label = event.target.value })}/></label>
            <label>默认值<Select aria-label="属性默认值" value={(isStandeeQuantity ? selectionId(productOption?.defaultValue) : selectionId(catalog.values.find(value => value.isDefault))) ?? ''} options={[{ value: '', label: '不设置默认值' }, ...ordered(catalog.values).map(value => ({ value: getEntityId(value), label: display(value) }))]} onChange={id => isStandeeQuantity ? editProduct(target => setStandeeQuantityDefault(target, catalog, catalog.values.find(value => getEntityId(value) === id))) : editCatalog(target => setDefault(target, target.values.find(value => getEntityId(value) === id)))}/></label>
          </div>
          <div className="po-values-toolbar"><span>共 {catalog.values.length} 个值 · 已启用 {catalog.values.filter(value => isEnabled(productOption, value)).length} 个{isStandeeQuantity && ' · 仅支持1至4片'}</span><div className="po-actions"><Select aria-label="选项值筛选" value={valueFilter} options={[{ value: 'all', label: '全部值' }, { value: 'enabled', label: '已启用' }, { value: 'disabled', label: '已关闭' }]} onChange={value => { setValueFilter(value); setPage(1) }}/><Button disabled={isStandeeQuantity && catalog.values.length >= 4} title={isStandeeQuantity && catalog.values.length >= 4 ? '主体片数仅支持1至4片，已包含全部数量' : undefined} onClick={() => editCatalog((target, draft) => { const value = addValue(target); for (const item of allProducts(draft.main)) { const option = optionFor(item, definition.name); if (option) setEnabled(option, value, false) } setStyleId(getEntityId(value)); setValueFilter('all'); setPage(Math.ceil(target.values.length / 30)) })}>新增值</Button></div></div>
          {definition.prefix === 'P' ? <>
            <label className="po-style-select">选择配件样式<Select aria-label="编辑配件样式" value={visible.some(item => getEntityId(item) === selectionId(selectedStyle)) ? selectionId(selectedStyle) : selectionId(visible[0])} options={visible.map(value => ({ value: getEntityId(value), label: `${value.sortOrder} · ${display(value)}` }))} onChange={setStyleId}/></label>
            {(() => { const style = visible.find(item => getEntityId(item) === selectionId(selectedStyle)) ?? visible[0]; if (!style) return <p className="po-empty">暂无符合条件的配件样式</p>; return <><div className="po-values-grid">{valueEditor(style)}</div><div className="po-section-heading po-colors-heading"><h4>“{display(style)}”的配件颜色（{style.colors?.length ?? 0}）</h4><Button onClick={() => editCatalog((target, draft) => { const value = addValue(target, target.values.find(item => getEntityId(item) === getEntityId(style))); for (const item of allProducts(draft.main)) { const option = optionFor(item, definition.name); if (option) setEnabled(option, value, false) } })}>新增颜色</Button></div><div className="po-values-grid">{ordered(style.colors ?? []).map(color => valueEditor(color, getEntityId(style)))}</div>{!style.colors?.length && <p className="po-empty">此配件样式暂无颜色，可直接新增。</p>}</> })()}
          </> : <><div className="po-values-grid">{visible.slice((Math.min(page, Math.max(1, Math.ceil(visible.length / 30))) - 1) * 30, Math.min(page, Math.max(1, Math.ceil(visible.length / 30))) * 30).map(value => valueEditor(value))}</div>{!visible.length && <p className="po-empty">暂无符合条件的选项值</p>}{visible.length > 30 && <Pagination current={Math.min(page, Math.ceil(visible.length / 30))} pageSize={30} total={visible.length} onChange={setPage} showSizeChanger={false}/>}</>}
        </>}</div><aside className="po-preview"><h3>实时预览</h3><div><label>产品类别<Select aria-label="预览产品类别" value={location?.category} options={categoryOptions.filter(item => item.value !== -2)} onChange={chooseCategory}/></label><label>{prefix}产品<Select aria-label="预览产品" placeholder="暂无产品" value={productKey} options={locations(main, location?.category ?? filter).map(item => ({ value: getProduct(main, item)!.productId, label: display(getProduct(main, item)!) }))} onChange={chooseProduct}/></label>{previewFields}{product && !previewFields.length && <p className="po-empty">此产品尚未启用任何选项</p>}</div></aside>
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
