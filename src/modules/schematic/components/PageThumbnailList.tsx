import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
import type { Asset, Page } from '../../../model'
import PageThumbnail from './PageThumbnail'

export default function PageThumbnailList({ pages, assets, activePage, onSelect, onReorder, disabled, visualScales }: {
  pages: Page[]; assets: Map<string, Asset>; activePage: number; onSelect: (id: number) => void
  onReorder?: (source: number, target: number) => void; disabled: boolean; visualScales?: ReadonlyMap<string, number>
}) {
  const [source, setSource] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const pointer = useRef<{ id: number; pageId: number; x: number; y: number; dragging: boolean } | null>(null)
  const suppressClick = useRef(false)
  const pageAt = (x: number, y: number) => {
    const value = document.elementFromPoint(x, y)?.closest('[data-sort-page-id]')?.getAttribute('data-sort-page-id')
    return value === null || value === undefined ? null : Number(value)
  }
  return <div className="pages-list">{pages.map((page, index) => <div key={page.id} data-sort-page-id={page.id} className={`page-sort-item ${over === page.id && source !== page.id ? 'is-drag-over' : ''}`}
    onPointerDown={event => {
      suppressClick.current = false
      if (disabled || !onReorder || event.button !== 0 || (event.target as Element).closest('.page-sort-controls button')) return
      pointer.current = { id: event.pointerId, pageId: page.id, x: event.clientX, y: event.clientY, dragging: false }
    }}
    onPointerMove={event => {
      const drag = pointer.current
      if (!drag || drag.id !== event.pointerId) return
      if (!drag.dragging && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return
      drag.dragging = true; suppressClick.current = true
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
      setSource(drag.pageId); setOver(pageAt(event.clientX, event.clientY))
    }}
    onPointerUp={event => {
      const drag = pointer.current
      if (!drag || drag.id !== event.pointerId) return
      pointer.current = null
      if (drag?.dragging && !disabled) { const target = pageAt(event.clientX, event.clientY); if (target !== null) onReorder?.(drag.pageId, target) }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      setSource(null); setOver(null)
    }}
    onPointerCancel={event => { if (pointer.current?.id !== event.pointerId) return; pointer.current = null; setSource(null); setOver(null) }}
    draggable={!disabled && Boolean(onReorder)} onDragStart={event => { if (pointer.current) { event.preventDefault(); return }; event.dataTransfer.setData('application/x-printflow-page', String(page.id)); event.dataTransfer.effectAllowed = 'move'; setSource(page.id) }}
    onDragOver={event => { if (disabled || !event.dataTransfer.types.includes('application/x-printflow-page')) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(page.id) }}
    onDragEnd={() => { setSource(null); setOver(null) }}
    onDrop={event => { event.preventDefault(); const id = Number(event.dataTransfer.getData('application/x-printflow-page')); if (!disabled && pages.some(value => value.id === id)) onReorder?.(id, page.id); setSource(null); setOver(null) }}>
    <PageThumbnail page={page} pageNumber={index + 1} assets={assets} active={activePage === page.id} onClick={() => !disabled && !suppressClick.current && onSelect(page.id)} visualScales={visualScales}/>
    <div className="page-sort-controls"><GripVertical size={14} aria-label="拖动排序"/><button aria-label={`上移第 ${index + 1} 页`} disabled={disabled || index === 0 || !onReorder} onClick={() => onReorder?.(page.id, pages[index - 1].id)}><ArrowUp size={14}/></button><button aria-label={`下移第 ${index + 1} 页`} disabled={disabled || index === pages.length - 1 || !onReorder} onClick={() => onReorder?.(page.id, pages[index + 1].id)}><ArrowDown size={14}/></button></div>
  </div>)}</div>
}
