import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from 'antd'
import { OptionImageUploadError, uploadProductOptionImage } from './imageUpload'
import { OPTION_IMAGE_ACCEPT, validateOptionImageFile } from './imageUploadPolicy'

type Props = { entityKey: string; valueId: string; label: string; image?: string; onChange: (image: string) => void; onUploadStateChange?: (uploading: boolean) => void }

function ImagePreview({ source, label }: { source: string; label: string }) {
  const [failed, setFailed] = useState(false)
  return <div className="po-option-image-preview">
    {source && !failed
      ? <img src={source} alt={`${label}图片`} loading="lazy" decoding="async" onError={() => setFailed(true)}/>
      : <span>{source ? '图片加载失败' : '暂无图片'}</span>}
  </div>
}

export default function OptionImageEditor({ entityKey, valueId, label, image, onChange, onUploadStateChange }: Props) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef(false)
  const current = useRef({ entityKey, valueId, onChange })
  const mounted = useRef(true)
  useLayoutEffect(() => { current.current = { entityKey, valueId, onChange } }, [entityKey, valueId, onChange])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const source = image?.trim() ?? ''
  const upload = async (file: File) => {
    if (pending.current) return
    const invalid = validateOptionImageFile(file)
    setNotice(''); setError(invalid ?? '')
    if (invalid) return
    const origin = current.current
    const belongsHere = () => mounted.current && current.current.entityKey === origin.entityKey && current.current.valueId === origin.valueId
    pending.current = true; setUploading(true); onUploadStateChange?.(true)
    try {
      const result = await uploadProductOptionImage(file, { entityKey: origin.entityKey, valueId: origin.valueId })
      if (!belongsHere()) return
      current.current.onChange(result.url)
      setNotice('已上传，请保存配置')
    } catch (failure) {
      if (belongsHere()) setError(failure instanceof OptionImageUploadError ? failure.message : '上传失败，请重试。')
    } finally {
      pending.current = false
      if (mounted.current) setUploading(false)
      onUploadStateChange?.(false)
    }
  }
  return <div className="po-option-image" aria-busy={uploading}>
    <ImagePreview key={source} source={source} label={label}/>
    <input ref={input} type="file" accept={OPTION_IMAGE_ACCEPT} hidden aria-label={`${valueId}选择图片`} disabled={uploading} onChange={event => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (file) void upload(file)
    }}/>
    <Button type="link" size="small" loading={uploading} disabled={uploading} aria-label={`${valueId}${source ? '替换图片' : '上传图片'}`} title="PNG、JPG、WebP、GIF，最大 4 MB" onClick={() => input.current?.click()}>
      {uploading ? '上传中' : source ? '替换图片' : '上传图片'}
    </Button>
    {source && <Button type="text" size="small" disabled={uploading} className="po-image-remove" aria-label={`${valueId}移除图片`} onClick={() => { onChange(''); setNotice('已移除，请保存配置'); setError('') }}>移除</Button>}
    {error && <span className="po-image-feedback po-image-error" role="alert">{error}</span>}
    {notice && <span className="po-image-feedback" role="status">{notice}</span>}
  </div>
}
