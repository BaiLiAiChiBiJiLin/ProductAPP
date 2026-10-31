import { useRef, useState } from 'react'
import { Button, ColorPicker, Image, Input, InputNumber } from 'antd'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import type { Asset, NoteImage } from '../../../model'
import Loading from '../../../components/Loading'
import type { ProductAttributePatch } from '../services/productOptionRules'
import { DEFAULT_NOTE_COLOR, DEFAULT_NOTE_FONT_SIZE, getNoteImages, MAX_NOTE_IMAGES, noteImagesPatch, sameNoteImages } from '../services/assetNotesService'

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
  const noteFontSize = assets.length && assets.every(asset => (asset.noteFontSize ?? DEFAULT_NOTE_FONT_SIZE) === (assets[0].noteFontSize ?? DEFAULT_NOTE_FONT_SIZE))
    ? assets[0].noteFontSize ?? DEFAULT_NOTE_FONT_SIZE : DEFAULT_NOTE_FONT_SIZE
  const noteColor = assets.length && assets.every(asset => (asset.noteColor ?? DEFAULT_NOTE_COLOR) === (assets[0].noteColor ?? DEFAULT_NOTE_COLOR))
    ? assets[0].noteColor ?? DEFAULT_NOTE_COLOR : DEFAULT_NOTE_COLOR
  const firstImages = assets.length ? getNoteImages(assets[0]) : []
  const images = assets.every(asset => sameNoteImages(getNoteImages(asset), firstImages)) ? firstImages : []
  const assignImages = (next: NoteImage[]) => onAssign(noteImagesPatch(next))
  const finishClipboardRead = (version: number, next: NoteImage[], error?: string) => {
    if (!error && current.current.version === version) current.current.onAssign(noteImagesPatch(next))
    if (error) setError(error)
    uploadLock.current = false
    setUploading(false)
    onUploadingChange?.(false)
  }
  const pasteImage = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const item = Array.from(event.clipboardData.items).find(value => value.kind === 'file' && value.type.startsWith('image/'))
    if (!item) return
    event.preventDefault()
    if (uploadLock.current || !assets.length) return
    if (images.length >= MAX_NOTE_IMAGES) { setError(`备注图片最多 ${MAX_NOTE_IMAGES} 张，请先删除一张再粘贴。`); return }
    const file = item.getAsFile()
    if (!file) return
    uploadLock.current = true
    const version = current.current.version
    setUploading(true)
    onUploadingChange?.(true)
    setError('')
    const reader = new FileReader()
    reader.onload = () => {
      const src = typeof reader.result === 'string' ? reader.result : ''
      finishClipboardRead(version, src ? [...images, { src, name: '' }] : images, src ? undefined : '剪贴板图片读取失败')
    }
    reader.onerror = () => finishClipboardRead(version, images, '剪贴板图片读取失败')
    reader.readAsDataURL(file)
  }
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
      autoSize={{ minRows: 2, maxRows: 5 }} placeholder="请输入备注，可上传或 Ctrl+V 粘贴图片" onPaste={pasteImage} onChange={event => onAssign({ note: event.target.value })} /></label>
    <div style={{ display: 'flex', alignItems: 'end', gap: 16, flexWrap: 'wrap' }}>
      <label className="product-config-field" style={{ width: 120 }}><span>备注字号</span><InputNumber aria-label="备注字号" min={6} max={72} precision={0} addonAfter="px" value={noteFontSize} disabled={!assets.length || uploading} onChange={value => onAssign({ noteFontSize: value ?? DEFAULT_NOTE_FONT_SIZE })}/></label>
      <label className="product-config-field"><span>备注文字颜色</span><ColorPicker aria-label="备注文字颜色" value={noteColor} disabledAlpha disabled={!assets.length || uploading} onChangeComplete={color => onAssign({ noteColor: color.toHexString() })}/></label>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><Button disabled={!assets.length || uploading || images.length >= MAX_NOTE_IMAGES} icon={uploading ? <Loading size="small" inline /> : undefined} onClick={() => void upload()}>{uploading ? '正在读取备注图片…' : '上传备注图片'}</Button><span style={{ color: '#64748b', fontSize: 12 }}>{images.length} / {MAX_NOTE_IMAGES} 张</span></div>
    {images.map((image, index) => <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <Image src={image.src} alt={image.name || `备注图片 ${index + 1}`} width={72} height={72} style={{ objectFit: 'contain' }} />
      <Input aria-label={`备注图片 ${index + 1} 名称`} placeholder="图片名称（可留空）" value={image.name} disabled={uploading} allowClear onChange={event => assignImages(images.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}/>
      <Button type="text" danger disabled={uploading} aria-label={`删除备注图片 ${index + 1}`} onClick={() => assignImages(images.filter((_, i) => i !== index))}>删除</Button>
    </div>)}
    {error && <div role="alert" className="product-config-error">{error}</div>}
  </section>
}
