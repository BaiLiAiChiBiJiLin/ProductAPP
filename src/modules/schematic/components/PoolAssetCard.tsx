import { useRef, useState } from 'react'
import { Search, Trash2 } from 'lucide-react'
import { Popconfirm } from 'antd'
import type { Asset } from '../../../model'
import LazySvgImage from './LazySvgImage'
import { POOL_DROP_EVENT, type PoolImageDrop } from '../services/poolDragService'
import './pool-asset-card.css'

/** Pointer drag avoids the desktop WebView's native file-drop interception. */
export default function PoolAssetCard({ asset, batchId, previewOrder, used, onAdd, onPreview, onDelete, disabled = false }: { asset: Asset; batchId?: string; previewOrder?: number; used: boolean; onAdd?: (id: string) => void; onPreview: () => void; onDelete?: (id: string) => Promise<void>; disabled?: boolean }) {
  const start = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null)
  const ignoreClick = useRef(false)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const canAdd = !used && Boolean(onAdd)
  return <div className={`asset pool-asset-card ${used ? 'is-used' : ''}`}>
    <button type="button" className="pool-asset-drag" aria-label={`${canAdd ? '加入画布' : '图片'} ${asset.name}`} title={canAdd ? '双击或拖动到画布；按 Enter 加入' : '已在画布中'}
      draggable={false} onDragStart={event => event.preventDefault()}
      onPointerDown={event => {
        ignoreClick.current = false
        if (!canAdd || event.button !== 0) return
        start.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const value = start.current
        if (!value || value.pointerId !== event.pointerId) return
        if (!value.moved && Math.hypot(event.clientX - value.x, event.clientY - value.y) < 5) return
        value.moved = true; ignoreClick.current = true
        setDrag({ x: event.clientX, y: event.clientY })
      }}
      onPointerUp={event => {
        const value = start.current
        start.current = null; setDrag(null)
        if (value?.moved && value.pointerId === event.pointerId) {
          window.dispatchEvent(new CustomEvent<PoolImageDrop>(POOL_DROP_EVENT, { detail: { assetId: asset.id, clientX: event.clientX, clientY: event.clientY } }))
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { start.current = null; setDrag(null) }}
      onLostPointerCapture={() => { start.current = null; setDrag(null) }}
      onDoubleClick={() => { if (canAdd && !ignoreClick.current) onAdd?.(asset.id) }}
      onKeyDown={event => { if (canAdd && !event.repeat && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onAdd?.(asset.id) } }}>
      <div className="asset-preview"><LazySvgImage svg={asset.svg} storagePath={asset.storagePath} assetId={asset.id} batchId={batchId} previewOrder={previewOrder} alt={asset.name} draggable={false}/>{used && <span className="asset-used-mark">已排版</span>}</div><span>{asset.name}</span>
    </button>
    <button type="button" className="pool-asset-preview-button" aria-label={`放大预览 ${asset.name}`} title="放大预览" onClick={onPreview}><Search size={14}/></button>
    {onDelete && <Popconfirm title="删除这张图片？" description="将从图片池及本次排列的全部页面中移除，无法在图片池中恢复。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => onDelete(asset.id)}><button type="button" className="pool-asset-delete-button" aria-label={`删除池中图片 ${asset.name}`} title="删除图片" disabled={disabled}><Trash2 size={13}/></button></Popconfirm>}
    {drag && <div className="pool-drag-feedback" style={{ left: drag.x + 12, top: drag.y + 12 }}>拖入画布：{asset.name}</div>}
  </div>
}
