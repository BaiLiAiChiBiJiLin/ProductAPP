import { useEffect, useState } from 'react'
import { Check, Copy, CircleAlert } from 'lucide-react'
import './asset-name.css'

export default function AssetName({ name }: { name: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (status === 'idle') return
    const timer = setTimeout(() => setStatus('idle'), 1800)
    return () => clearTimeout(timer)
  }, [status])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(name)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }
  const feedback = status === 'copied' ? '已复制完整图片名' : status === 'failed' ? '复制失败，请重试' : '复制完整图片名'
  return <div className="asset-name-row">
    <strong className="asset-name-text" title={name}>{name}</strong>
    <button type="button" className="asset-name-copy" data-copy-state={status} aria-label={`复制图片名 ${name}`} title={feedback}
      onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void copy() }}>
      {status === 'copied' ? <Check size={13} aria-hidden="true"/> : status === 'failed' ? <CircleAlert size={13} aria-hidden="true"/> : <Copy size={13} aria-hidden="true"/>}
    </button>
    <span className="asset-name-copy-status" role="status">{status === 'idle' ? '' : feedback}</span>
  </div>
}
