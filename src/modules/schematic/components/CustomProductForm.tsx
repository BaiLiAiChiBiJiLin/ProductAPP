import { Fragment, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { AutoComplete, Button, InputNumber } from 'antd'
import Loading from '../../../components/Loading'
import { customAttributes, customImages, listCustomProducts, loadCustomProductConfig, addCustomProductName, type CustomProductName, type CustomProduct } from '../services/customProductService'
import type { ProductConfig } from '../services/productConfigService'
import ProductOptionField from './ProductOptionField'
import { applyAttributeImages, applyAttributeValues, availableOptionValues, dependentOptionNames } from '../services/productOptionRules'

type Props = { draft: CustomProduct; onDraftChange: Dispatch<SetStateAction<CustomProduct>>; productLocked?: boolean }
export default function CustomProductForm({ draft, onDraftChange: setDraft, productLocked = false }: Props) {
  const [presets, setPresets] = useState<CustomProductName[]>([])
  const [catalog, setCatalog] = useState<ProductConfig>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([listCustomProducts(), loadCustomProductConfig()]).then(([items, config]) => {
      if (!cancelled) { setPresets(items); setCatalog(config); setError('') }
    }).catch(reason => { if (!cancelled) setError(`读取本地产品失败：${String(reason)}`) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reload])
  const nameExists = presets.some(item => item.name.trim() === draft.name.trim())
  const save = async () => {
    if (saving) return
    if (nameExists) { setError('该产品名称已存在，请直接选择'); return }
    if (!draft.name.trim()) { setError('请填写产品名称'); return }
    setSaving(true); setError(''); setNotice('')
    try {
      const saved = await addCustomProductName(draft.name)
      setDraft(current => ({ ...current, id: saved.id, name: saved.name }))
      setPresets(current => [saved, ...current.filter(item => item.id !== saved.id)])
      setNotice('已保存到本地，下次可直接选用')
    } catch (reason) { setError(`保存失败：${String(reason)}`) }
    finally { setSaving(false) }
  }
  const attributes = customAttributes(draft)
  const images = customImages(draft)
  const changeOption = (name: string, value: string, image?: string) => {
    const patch = { attribute: { key: name, value }, attributeImage: { key: name, url: image ?? '' }, clearAttributeKeys: dependentOptionNames(catalog?.options ?? [], name) }
    setDraft(current => ({ ...current, attributes: applyAttributeValues(customAttributes(current), patch), attributeImages: applyAttributeImages(customImages(current), patch) }))
  }
  const quantityField = <label className="product-config-field"><span>QT（数量）</span><InputNumber aria-label="自定义QT（数量）" min={0} max={2147483647} precision={0} value={draft.qt} disabled={saving}
          onChange={value => setDraft(current => ({ ...current, qt: value }))}/></label>
  const accessoryIndex = catalog?.options.findIndex(option => option.name === 'Accessories Style') ?? -1
  return <div className="custom-product-editor" aria-label="自定义产品设置">
    {loading ? <Loading size="small" text="正在加载自定义产品…"/> : <>
      <p className="custom-product-hint">下拉可选择本地产品，输入后点击新增可保存到本地</p>
      <div className="custom-product-presets">
        <label className="product-config-field"><span>产品</span><AutoComplete aria-label="自定义产品" placeholder="选择或输入产品名称" disabled={saving || productLocked}
          value={draft.name} options={presets.map(item => ({ value: item.name }))}
          filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
          onChange={name => { setDraft(current => ({ ...current, name, id: name === current.name ? current.id : null })); setNotice('') }}
          onSelect={name => { const item = presets.find(preset => preset.name === name); if (item) { setDraft(current => ({ ...current, id: item.id, name: item.name })); setError(''); setNotice('') } }}/></label>
        <Button loading={saving} disabled={loading || saving || productLocked || nameExists || !draft.name.trim()} onClick={() => void save()}>新增</Button>
      </div>
      <div className="product-config-form custom-product-fields">
        {accessoryIndex < 0 && quantityField}
        {catalog?.options.map((option, index) => {
          const values = availableOptionValues(option, attributes)
          return <Fragment key={option.name}>{index === accessoryIndex && quantityField}{values.length ? <ProductOptionField option={option} values={values} value={attributes[option.name]} imageOverride={images[option.name]} disabled={saving}
            onChange={(value, image) => changeOption(option.name, value, image)}/> : null}</Fragment>
        })}

      </div>
    </>}
    {error && <div className="product-config-error" role="alert">{error}<Button type="link" disabled={saving || loading} onClick={() => setReload(value => value + 1)}>重新读取</Button></div>}
    {notice && <p className="custom-product-notice" role="status">{notice}</p>}
  </div>
}
