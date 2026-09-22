import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Asset } from '../../../model'
import { Button, Tooltip } from 'antd'
import { Trash2 } from 'lucide-react'
import Loading from '../../../components/Loading'
import LazySvgImage from '../components/LazySvgImage'
import { useProductGroup } from './useProductGrouping'
import { orderAssetsByProductGroup } from '../services/productGroupOrdering'
import './product-grouping.css'

export default function ProductGroupGuide({ assets }: { assets: Asset[] }) {
  const grouping = useProductGroup()
  const session = grouping?.session
  const pointerRef = useRef<{ id: string; pointerId: number; x: number; y: number; active: boolean } | null>(null)
  const suppressClickRef = useRef(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  if (!session) return null
  const orderedAssets = orderAssetsByProductGroup(assets)
  const fixedSlots = grouping.slotLabels
  const targetAt = (event: ReactPointerEvent<HTMLElement>) => [...event.currentTarget.querySelectorAll<HTMLElement>('[data-group-member-id]')].find(element => {
    const rect = element.getBoundingClientRect()
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
  })?.dataset.groupMemberId ?? null
  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const pointer = pointerRef.current
    if (!fixedSlots || !pointer || pointer.pointerId !== event.pointerId) return
    const distance = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y)
    if (!pointer.active && distance < 5) return
    pointer.active = true
    setDraggingId(pointer.id)
    event.preventDefault()
    setDropTargetId(targetAt(event))
  }
  const finishPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const pointer = pointerRef.current
    if (!pointer || pointer.pointerId !== event.pointerId) return
    if (pointer.active) {
      const targetId = targetAt(event)
      if (targetId && targetId !== pointer.id) grouping.reorderMembers(pointer.id, targetId)
      suppressClickRef.current = true
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
    }
    pointerRef.current = null
    setDraggingId(null)
    setDropTargetId(null)
  }
  return <section className="product-group-guide" aria-label="产品分组引导" onPointerMove={handlePointerMove} onPointerUp={finishPointer} onPointerCancel={finishPointer}>
    <strong>{session.trigger.label} · 已加入 {session.memberIds.length} 张图片</strong>
    <p>{session.trigger.kind === 'free' ? '这是自由图片组，可点击暗色图片继续加入，产品和所有属性都可以分别设置。' : fixedSlots ? '点击暗色的未选产品卡片加入组，前四张按固定槽位排列，之后仍可继续添加图片。点击缩略图分别设置属性。' : '点击暗色的未选产品卡片加入组，点击缩略图分别设置属性。'}点击“确认”保存全组各自的属性并退出引导；“保存批次”保存后继续编辑。{session.trigger.kind !== 'free' && '已选产品显示红色，不能加入。'}</p>
    {fixedSlots && <p>拖动缩略图调整顺序，前四个位置固定为 Example、Front、inside、Back；之后仍可添加图片。</p>}
    <p>“退出引导”或“取消选择”保留已保存内容，放弃本次未保存的修改。</p>
    {session.trigger.count && <p>所选立牌数量：{session.trigger.count} 件，请核对组内图片。</p>}
    <div className="product-group-thumbnails">
      {session.memberIds.map((id, index) => { const asset = assets.find(item => item.id === id); return asset && <div key={id} data-group-member-id={id} className={`product-group-thumbnail ${fixedSlots ? 'is-reorderable' : ''} ${draggingId === id ? 'is-dragging' : ''} ${dropTargetId === id ? 'is-drop-target' : ''}`}>
        <button type="button" draggable={false} className="product-group-thumbnail-select" title={fixedSlots ? '按住拖动调整图片位置' : undefined} aria-label={`编辑组内图片 ${asset.name}`} aria-pressed={id === session.activeId} disabled={grouping.saving}
          onPointerDown={event => {
            if (!fixedSlots || grouping.saving || event.button !== 0) return
            event.preventDefault()
            pointerRef.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false }
          }}
          onClick={() => { if (suppressClickRef.current) { suppressClickRef.current = false; return }; grouping.selectMember(id, 'thumbnail') }}>
        <LazySvgImage svg={asset.svg} alt={asset.name} draggable={false} onDragStart={event => event.preventDefault()}/><span>NO: {orderedAssets.indexOf(asset) + 1}{id === session.leaderId ? ' · 主图' : ''}</span>{fixedSlots?.[index] && <span className="product-group-thumbnail-slot">{fixedSlots[index]}</span>}<span>{grouping.isPending(id) ? '待确认' : '已保存'}</span>
        </button>
        <Tooltip title="移出当前组并清空产品属性"><Button danger size="small" className="product-group-thumbnail-remove" aria-label={`移除组内图片 ${asset.name}`} disabled={grouping.saving || draggingId !== null} icon={grouping.removingId === id ? <Loading size="small" inline/> : <Trash2 size={14}/>} onClick={event => { event.stopPropagation(); void grouping.removeMember(id) }}/></Tooltip>
      </div> })}
    </div>
    {session.trigger.kind !== 'free' && session.activeId !== session.leaderId && <p>仅产品和立牌数量沿用主图，其他选项可独立修改。</p>}
    {grouping.error && <div role="alert">{grouping.error}</div>}
  </section>
}
