import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { Button, Input, InputNumber, Select } from 'antd'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import Loading from '../../../components/Loading'
import { emptyCustomProduct, listCustomProducts, saveCustomProduct, type CustomProduct } from '../services/customProductService'

type Props = { draft: CustomProduct; onDraftChange: Dispatch<SetStateAction<CustomProduct>>; productLocked?: boolean }
const textFields = [
  ['name', '产品'], ['size', '尺寸'], ['printOption', '印刷选项'],
  ['finish', '样式'], ['accessoryColor', '配件颜色'],
] as const

export default function CustomProductForm({ draft, onDraftChange: setDraft, productLocked = false }: Props) {
  const [presets, setPresets] = useState<CustomProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    void listCustomProducts().then(value => {
      if (!cancelled) setPresets(value)
    }).catch(reason => {
      if (!cancelled) setError(`读取本地自定义产品失败：${String(reason)}`)
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reload])

  const save = async () => {
    if (saving) return
    if (!draft.name.trim()) { setError('请填写产品名称'); return }
    if (!Number.isInteger(draft.qt) || draft.qt < 1) { setError('QT 必须是大于 0 的整数'); return }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const saved = await saveCustomProduct(draft)
      setDraft(saved)
      setPresets(current => [saved, ...current.filter(item => item.id !== saved.id)])
      setNotice('已保存到本地，下次可直接选用')
    } catch (reason) { setError(`保存失败：${String(reason)}`) }
    finally { setSaving(false) }
  }

  return <div className="custom-product-editor" aria-label="自定义产品设置">
    {loading ? <Loading size="small" text="正在加载自定义产品…" /> : <>
      <div className="custom-product-presets">
        <label className="product-config-field"><span>已保存的自定义产品</span><Select aria-label="已保存的自定义产品" placeholder="选择本地产品，或新增" disabled={saving || productLocked}
          value={presets.some(item => item.id === draft.id) ? draft.id : undefined} showSearch optionFilterProp="label"
          options={presets.map(item => ({ value: item.id!, label: item.name }))}
          onChange={id => { const item = presets.find(preset => preset.id === id); if (item) { setDraft({ ...item }); setError(''); setNotice('') } }} />
        </label>
        <Button disabled={saving || productLocked} onClick={() => { setDraft(emptyCustomProduct()); setError(''); setNotice('') }}>新增</Button>
      </div>
      <div className="product-config-form custom-product-fields">
        {textFields.map(([key, label]) => <label key={key} className="product-config-field"><span>{label}</span><Input
          aria-label={`自定义${label}`} value={draft[key]} disabled={saving || (productLocked && key === 'name')} maxLength={200} placeholder={`请输入${label}`}
          onChange={event => { setDraft(current => ({ ...current, [key]: event.target.value })); setNotice('') }} /></label>)}
        <label className="product-config-field"><span>QT（数量）</span><InputNumber aria-label="自定义QT（数量）" min={1} max={2147483647} precision={0} step={1}
          value={draft.qt} disabled={saving} onChange={value => { setDraft(current => ({ ...current, qt: value ?? 1 })); setNotice('') }} /></label>
      </div>
      <div className="custom-product-image-field">
        <span>配件颜色图片</span>
        <Button disabled={saving} onClick={() => void (async () => {
          const path = await open({ multiple: false, filters: [{ name: '图片', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'] }] })
          if (!path || Array.isArray(path)) return
          try {
            const image = await invoke<string>('import_custom_product_image', { path })
            setDraft(current => ({ ...current, accessoryColorImage: image }))
            setError('')
            setNotice('图片已载入，保存后写入本地')
          } catch (reason) { setError(`图片读取失败：${String(reason)}`) }
        })()}>{draft.accessoryColorImage ? '重新选择图片' : '上传配件颜色图片'}</Button>
        {draft.accessoryColorImage && <Button type="link" size="small" disabled={saving} onClick={() => setDraft(current => ({ ...current, accessoryColorImage: '' }))}>清除图片</Button>}
        {draft.accessoryColorImage && <img src={draft.accessoryColorImage} alt="配件颜色图片预览" />}
      </div>
      <div className="custom-product-actions">
        <Button disabled={saving} onClick={() => void save()}>保存到本地</Button>
      </div>
      {saving && <Loading size="small" text="正在保存自定义产品…" />}
    </>}
    {error && <div className="product-config-error" role="alert">{error}<Button type="link" size="small" disabled={saving || loading} onClick={() => { setLoading(true); setError(''); setReload(value => value + 1) }}>重新读取</Button></div>}
    {notice && <p className="custom-product-notice" role="status">{notice}</p>}
  </div>
}
