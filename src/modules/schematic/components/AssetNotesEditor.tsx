import { useRef, useState } from 'react'
import { Button, Image, Input } from 'antd'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import type { Asset, NoteImage } from '../../../model'
import Loading from '../../../components/Loading'
import type { ProductAttributePatch } from '../services/productOptionRules'
import { getNoteImages, MAX_NOTE_IMAGES, noteImagesPatch, sameNoteImages } from '../services/assetNotesService'

export default function AssetNotesEditor({ assets, onAssign, onUploadingChange }: { assets: Asset[]; onAssign: (patch: ProductAttributePatch) => void; onUploadingChange?: (busy: boolean) => void }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const selection = assets.map(asset => asset.id).join('|')
  const current = useRef({ selection, version: 0, onAssign })
  if (current.current.selection !== selection) current.current.version++
  current.current.selection = selection
  current.current.onAssign = onAssign
  const uploadLock = useRef(false)
  const note = assets.length && assets.every(asset => (asset.note ?? '') === (assets[0].note ?? '')) ? assets[0].note ?? '' : ''
  const firstImages = assets.length ? getNoteImages(assets[0]) : []
  const images = assets.every(asset => sameNoteImages(getNoteImages(asset), firstImages)) ? firstImages : []
  const assignImages = (next: NoteImage[]) => onAssign(noteImagesPatch(next))
  const upload = async () => {
    if (uploadLock.current || !assets.length || images.length >= MAX_NOTE_IMAGES) return
    uploadLock.current = true
    const version = current.current.version
    setUploading(true)
    onUploadingChange?.(true)
    setError('')
    try {
      const picked = await open({ multiple: true, filters: [{ name: '备注图片', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'] }] })
      if (!picked) return
      const paths = Array.isArray(picked) ? picked : [picked]
      if (paths.length > MAX_NOTE_IMAGES - images.length) { setError(`备注图片最多 ${MAX_NOTE_IMAGES} 张，还可以添加 ${MAX_NOTE_IMAGES - images.length} 张。`); return }
      const added: NoteImage[] = []
      for (const path of paths) {
        if (current.current.version !== version) return
        const src = await invoke<string>('import_custom_product_image', { path })
        added.push({ src, name: '' })
      }
      if (current.current.version === version) current.current.onAssign(noteImagesPatch([...images, ...added]))
    } catch (reason) { setError(`备注图片读取失败：${String(reason)}`) }
    finally { uploadLock.current = false; setUploading(false); onUploadingChange?.(false) }
  }
  return <section aria-label="图片备注" style={{ marginTop: 16, display: 'grid', gap: 8 }}>
    <label className="product-config-field"><span>备注</span><Input.TextArea aria-label="备注文字" value={note} disabled={!assets.length}
      autoSize={{ minRows: 2, maxRows: 5 }} placeholder="请输入备注，可同时添加图片" onChange={event => onAssign({ note: event.target.value })} /></label>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><Button disabled={!assets.length || uploading || images.length >= MAX_NOTE_IMAGES} icon={uploading ? <Loading size="small" inline /> : undefined} onClick={() => void upload()}>{uploading ? '正在读取备注图片…' : '上传备注图片'}</Button><span style={{ color: '#64748b', fontSize: 12 }}>{images.length} / {MAX_NOTE_IMAGES} 张</span></div>
    {images.map((image, index) => <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <Image src={image.src} alt={image.name || `备注图片 ${index + 1}`} width={72} height={72} style={{ objectFit: 'contain' }} />
      <Input aria-label={`备注图片 ${index + 1} 名称`} placeholder="图片名称（可留空）" value={image.name} disabled={uploading} allowClear onChange={event => assignImages(images.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}/>
      <Button type="text" danger disabled={uploading} aria-label={`删除备注图片 ${index + 1}`} onClick={() => assignImages(images.filter((_, i) => i !== index))}>删除</Button>
    </div>)}
    {error && <div role="alert" className="product-config-error">{error}</div>}
  </section>
}
