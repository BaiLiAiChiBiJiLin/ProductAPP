import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from 'react'
import { entityReference, getEntityId, getEntityKey, ordered, sameEntity, type EntityReference, type OptionValue } from './model'

export type OptionSortGroup = { id: string; values: OptionValue[]; optionName: string; catalogFile: string; productId?: string; parentId?: string }
type Position = 'before' | 'after'
type Source = { value: OptionValue; group: OptionSortGroup; context: string; card: HTMLElement; native: boolean }
type Drop = { value: OptionValue; position: Position; axis: 'x' | 'y' }
type Pointer = { id: number; x: number; y: number; source: Source }
type Props = { disabled: boolean; context: string; onMove: (group: OptionSortGroup, source: EntityReference, target: EntityReference, position: Position) => boolean }

const interactive = (target: EventTarget | null) => target instanceof Element && !target.closest('.po-sort-handle') && !!target.closest('input,textarea,button,select,a,label,[role="switch"],[role="combobox"],[contenteditable="true"],.po-option-image,.ant-select')
const release = (pointer?: Pointer) => {
  try { if (pointer?.source.card.hasPointerCapture?.(pointer.id)) pointer.source.card.releasePointerCapture(pointer.id) } catch { /* A removed card has already lost capture. */ }
}

export default function useOptionCardSorting({ disabled, context, onMove }: Props) {
  const owner = useId()
  const source = useRef<Source | undefined>(undefined)
  const pointer = useRef<Pointer | undefined>(undefined)
  const blockedStart = useRef(false)
  const [dragging, setDragging] = useState<Source>()
  const [drop, setDrop] = useState<Drop>()
  const [announcement, setAnnouncement] = useState('')
  const clear = useCallback(() => {
    const captured = pointer.current
    pointer.current = undefined; source.current = undefined; blockedStart.current = false
    release(captured); setDragging(undefined); setDrop(undefined)
  }, [])
  useEffect(() => { clear(); setAnnouncement('') }, [context, disabled, clear])
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !source.current && !pointer.current) return
      event.preventDefault(); clear(); setAnnouncement('已取消排序。')
    }
    window.addEventListener('keydown', cancel)
    window.addEventListener('blur', clear)
    return () => { window.removeEventListener('keydown', cancel); window.removeEventListener('blur', clear); release(pointer.current) }
  }, [clear])
  const valid = () => !disabled && source.current?.context === context
  const locate = (card: HTMLElement | null | undefined, x: number, y: number): Drop | undefined => {
    const current = source.current
    if (!valid() || !current || card?.dataset.sortOwner !== owner || card.dataset.sortGroup !== current.group.id) return
    const value = current.group.values.find(item => getEntityId(item) === card.dataset.valueId && getEntityKey(item) === card.dataset.entityKey)
    if (!value || sameEntity(value, current.value)) return
    const bounds = card.getBoundingClientRect()
    const horizontal = bounds.width > 0 && Array.from(card.parentElement?.children ?? []).some(sibling => {
      if (!(sibling instanceof HTMLElement) || sibling === card || sibling.dataset.sortGroup !== current.group.id) return false
      const other = sibling.getBoundingClientRect()
      return other.width > 0 && Math.abs(other.top - bounds.top) < 4 && Math.abs(other.left - bounds.left) > 4
    })
    return { value, axis: horizontal ? 'x' : 'y', position: (horizontal ? x < bounds.left + bounds.width / 2 : y < bounds.top + bounds.height / 2) ? 'before' : 'after' }
  }
  const highlight = (next?: Drop) => setDrop(next)
  const finish = (destination?: Drop) => {
    const current = source.current
    const permitted = valid()
    clear()
    if (!permitted || !current || !destination || !onMove(current.group, entityReference(current.value), entityReference(destination.value), destination.position)) return
    const values = ordered(current.group.values)
    const from = values.findIndex(value => sameEntity(value, current.value))
    const to = values.findIndex(value => sameEntity(value, destination.value)) + (destination.position === 'after' ? 1 : 0)
    setAnnouncement(`已将“${current.value.labelZh || current.value.name}”移至第 ${to - (from < to ? 1 : 0) + 1} 项，保存后生效。`)
    current.card.querySelector<HTMLButtonElement>('.po-sort-handle')?.focus({ preventScroll: true })
  }
  const pointerTarget = (event: PointerEvent<HTMLElement>) => locate(event.currentTarget.ownerDocument.elementFromPoint?.(event.clientX, event.clientY)?.closest<HTMLElement>('.po-value'), event.clientX, event.clientY)
  const getCardProps = (value: OptionValue, group: OptionSortGroup) => ({
    'data-sort-owner': owner,
    'data-sort-group': group.id,
    'data-dragging': dragging?.context === context && dragging.group.id === group.id && sameEntity(dragging.value, value) || undefined,
    'data-drop-position': dragging?.group.id === group.id && drop && sameEntity(drop.value, value) ? drop.position : undefined,
    'data-drop-axis': dragging?.group.id === group.id && drop && sameEntity(drop.value, value) ? drop.axis : undefined,
    draggable: !disabled && group.values.length > 1,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      blockedStart.current = interactive(event.target)
      if (disabled || group.values.length < 2 || event.button !== 0 || blockedStart.current || event.isPrimary === false) return
      event.preventDefault()
      event.currentTarget.querySelector<HTMLButtonElement>('.po-sort-handle')?.focus({ preventScroll: true })
      const next: Source = { value, group, context, card: event.currentTarget, native: false }
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, source: next }
      try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* Native drag remains available without pointer capture. */ }
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = pointer.current
      if (!current || current.id !== event.pointerId || disabled || current.source.context !== context) return
      if (!source.current) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return
        source.current = current.source; setDragging(current.source)
      }
      event.preventDefault(); highlight(pointerTarget(event))
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (pointer.current?.id !== event.pointerId) { blockedStart.current = false; return }
      finish(source.current ? pointerTarget(event) : undefined)
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => { if (pointer.current?.id === event.pointerId) clear() },
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => { if (pointer.current?.id === event.pointerId) clear() },
    onDragStart: (event: DragEvent<HTMLElement>) => {
      if (disabled || group.values.length < 2 || blockedStart.current || interactive(event.target)) { event.preventDefault(); clear(); return }
      // Keep pointer capture in desktop WebViews whose native file drag handler intercepts HTML dragging.
      if (pointer.current) { event.preventDefault(); return }
      const next: Source = { value, group, context, card: event.currentTarget, native: true }
      source.current = next; setDragging(next); highlight(undefined)
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-product-option-value', getEntityId(value)) }
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!source.current?.native || !valid()) return
      const next = locate(event.currentTarget, event.clientX, event.clientY)
      highlight(next)
      if (next) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move' }
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (source.current?.native && !event.currentTarget.contains(event.relatedTarget as Node | null)) highlight(undefined) },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!source.current?.native || !valid()) return
      event.preventDefault(); finish(locate(event.currentTarget, event.clientX, event.clientY))
    },
    onDragEnd: () => { if (source.current?.native) clear() },
  })
  const getHandleProps = (value: OptionValue, group: OptionSortGroup) => ({
    'aria-label': `${getEntityId(value)}排序`,
    'aria-describedby': `${owner}-help`,
    title: '拖动排序，或按 ↑ / ← 前移、↓ / → 后移',
    disabled: disabled || group.values.length < 2,
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : 0
      if (!direction || disabled) return
      event.preventDefault(); clear()
      const values = ordered(group.values)
      const next = values[values.findIndex(item => sameEntity(item, value)) + direction]
      if (!next) return
      source.current = { value, group, context, card: event.currentTarget.closest<HTMLElement>('.po-value')!, native: false }
      finish({ value: next, position: direction < 0 ? 'before' : 'after', axis: 'y' })
    },
  })
  return { getCardProps, getHandleProps, helpId: `${owner}-help`, announcement }
}
