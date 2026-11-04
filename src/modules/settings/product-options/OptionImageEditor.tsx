import { useState } from 'react'
import { Button, Input, Modal } from 'antd'

type Props = { valueId: string; label: string; image?: string; onChange: (image: string) => void }

function ImagePreview({ source, label }: { source: string; label: string }) {
  const [failed, setFailed] = useState(false)
  return <div className="po-option-image-preview">
    {source && !failed
      ? <img src={source} alt={`${label}图片`} loading="lazy" decoding="async" onError={() => setFailed(true)}/>
      : <span>{source ? '图片加载失败' : '暂无图片'}</span>}
  </div>
}

export default function OptionImageEditor({ valueId, label, image, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const source = image?.trim() ?? ''
  const apply = () => { onChange(draft.trim()); setOpen(false) }
  return <div className="po-option-image">
    <ImagePreview key={source} source={source} label={label}/>
    <Button type="link" size="small" aria-label={`${valueId}设置图片地址`} onClick={() => { setDraft(image ?? ''); setOpen(true) }}>
      {source ? '修改图片地址' : '设置图片地址'}
    </Button>
    <Modal title={`${label} · 图片地址`} open={open} width={480} okText="应用" cancelText="取消" destroyOnHidden onCancel={() => setOpen(false)} onOk={apply}>
      <label className="po-image-address-field">图片地址
        <Input aria-label={`${valueId}图片地址`} value={draft} placeholder="https://…" allowClear onChange={event => setDraft(event.target.value)} onPressEnter={apply}/>
      </label>
    </Modal>
  </div>
}
