import { useRef, useState } from 'react'
import { Button, Image, Input } from 'antd'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import type { Asset } from '../../../model'
import Loading from '../../../components/Loading'
import type { ProductAttributePatch } from '../services/productOptionRules'

export default function AssetNotesEditor({ assets, onAssign, onUploadingChange }: { assets: Asset[]; onAssign: (patch: ProductAttributePatch) => void; onUploadingChange?: (busy: boolean) => void }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const selection = assets.map(asset => asset.id).join('|')
  const currentSelection = useRef(selection)
  currentSelection.current = selection
  const shared = (key: 'note' | 'noteImage') => assets.length && assets.every(asset => (asset[key] ?? '') === (assets[0][key] ?? '')) ? assets[0][key] ?? '' : ''
  const image = shared('noteImage')
  const upload = async () => {
    if (uploading || !assets.length) return
    setUploading(true)
    onUploadingChange?.(true)
    setError('')
    try {
      const path = await open({ multiple: false, filters: [{ name: '备注图片', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'] }] })
      if (!path || Array.isArray(path)) return
      const noteImage = await invoke<string>('import_custom_product_image', { path })
      if (currentSelection.current === selection) onAssign({ noteImage })
    } catch (reason) { setError(`备注图片读取失败：${String(reason)}`) }
    finally { setUploading(false); onUploadingChange?.(false) }
  }
  return <section aria-label="图片备注" style={{ marginTop: 16, display: 'grid', gap: 8 }}>
    <label className="product-config-field"><span>备注</span><Input.TextArea aria-label="备注文字" value={shared('note')} disabled={!assets.length}
      autoSize={{ minRows: 2, maxRows: 5 }} placeholder="请输入备注，可同时添加图片" onChange={event => onAssign({ note: event.target.value })} /></label>
    <div><Button disabled={!assets.length || uploading} icon={uploading ? <Loading size="small" inline /> : undefined} onClick={() => void upload()}>{uploading ? '正在读取备注图片…' : image ? '替换备注图片' : '上传备注图片'}</Button>
      {image && <Button type="link" disabled={uploading} onClick={() => onAssign({ noteImage: '' })}>清除备注图片</Button>}</div>
    {image && <Image src={image} alt="备注图片" width={110} height={90} style={{ objectFit: 'contain' }} />}
    {error && <div role="alert" className="product-config-error">{error}</div>}
  </section>
}
