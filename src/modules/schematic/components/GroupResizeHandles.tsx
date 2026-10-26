import { useLayoutEffect, useRef, useState } from 'react'
import { Group, Rect, Text } from 'react-konva'
import type { Node, KonvaEventObject } from 'konva/lib/Node'
import { GROUP_GAP, PAPER_WIDTH, artworkBounds, type LayoutBounds } from '../../../model'
import { snapGroupResizeRect, type GroupRect, type GroupResizeEdge } from '../services/groupResizeService'

const edges: GroupResizeEdge[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']
const cursors: Record<GroupResizeEdge, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }
function handlePosition(rect: GroupRect, edge: GroupResizeEdge) {
  return { x: edge.includes('w') ? rect.x : edge.includes('e') ? rect.x + rect.width : rect.x + rect.width / 2,
    y: edge.includes('n') ? rect.y : edge.includes('s') ? rect.y + rect.height : rect.y + rect.height / 2 }
}

function pointer(node: Node) {
  const point = node.getStage()?.getPointerPosition()
  const parent = node.getParent()
  return point && parent ? parent.getAbsoluteTransform().copy().invert().point(point) : undefined
}

export default function GroupResizeHandles({ group, bounds, scale, onPreview, onCommit }: {
  group: GroupRect; bounds: LayoutBounds; scale: number
  onPreview: (rect?: GroupRect) => void; onCommit: (rect: GroupRect) => void
}) {
  const [preview, setPreview] = useState<GroupRect>()
  const [hovered, setHovered] = useState<GroupResizeEdge>()
  const active = useRef<{ base: GroupRect; origin: { x: number; y: number }; edge: GroupResizeEdge; node: Node; started?: boolean; latest?: GroupRect }>(undefined)
  const callbacks = useRef({ onPreview, onCommit })
  callbacks.current = { onPreview, onCommit }
  const stage = useRef<ReturnType<Node['getStage']>>(null)
  const resetCursor = () => { const container = stage.current?.container(); if (container) container.style.cursor = '' }
  useLayoutEffect(() => {
    const cancel = (unmount = false) => {
      const drag = active.current
      active.current = undefined
      if (drag) drag.node.position(handlePosition(drag.base, drag.edge))
      if (drag?.node.isDragging()) drag.node.stopDrag()
      if (!unmount) { setPreview(undefined); setHovered(undefined) }
      resetCursor()
      callbacks.current.onPreview()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && active.current) { event.preventDefault(); cancel() } }
    const blur = () => cancel()
    window.addEventListener('keydown', escape)
    window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', blur); cancel(true) }
  }, [])
  const display = preview ?? group
  const hit = 10 / scale, knob = 7 / scale
  const area = artworkBounds(bounds)
  const column = (PAPER_WIDTH - area.left - area.right - GROUP_GAP * 2) / 3
  const columns = Math.max(1, Math.min(3, Math.round((display.width + GROUP_GAP) / (column + GROUP_GAP))))
  const move = (event: KonvaEventObject<DragEvent>) => {
    event.cancelBubble = true
    const drag = active.current, point = pointer(event.currentTarget)
    if (!drag || !point) return
    const dx = point.x - drag.origin.x, dy = point.y - drag.origin.y
    const { base, edge } = drag
    const desired = {
      x: base.x + (edge.includes('w') ? dx : 0), y: base.y + (edge.includes('n') ? dy : 0),
      width: base.width + (edge.includes('w') ? -dx : edge.includes('e') ? dx : 0),
      height: base.height + (edge.includes('n') ? -dy : edge.includes('s') ? dy : 0),
    }
    const next = snapGroupResizeRect(base, desired, bounds, edge)
    const changed = (['x', 'y', 'width', 'height'] as const).some(key => Math.abs(next[key] - base[key]) > 1e-6)
    drag.latest = changed ? next : undefined
    // Konva moves the dragged node imperatively, even if its snapped React props
    // have not changed. Keep the handle itself on the preview edge every frame.
    event.currentTarget.position(handlePosition(next, edge))
    setPreview(next); onPreview(drag.latest)
  }
  return <Group name="group-resize-controls">
    <Rect name="group-resize-outline" {...display} stroke="#1677ff" strokeWidth={1.5 / scale} dash={preview ? [5 / scale, 3 / scale] : undefined} listening={false}/>
    {(preview || hovered) && <Text x={display.x} y={display.y - 21 / scale} width={display.width} align="center"
      text={`${columns} 列 · 高 ${(display.height * 210 / PAPER_WIDTH).toFixed(1)} mm`} fontSize={12 / scale} fill="#1677ff" listening={false}/>}
    {edges.map(edge => {
      const corner = edge.length === 2
      const { x, y } = handlePosition(display, edge)
      const horizontal = edge === 'n' || edge === 's'
      const width = corner ? hit : horizontal ? Math.max(hit, display.width - hit * 2) : hit
      const height = corner ? hit : horizontal ? hit : Math.max(hit, display.height - hit * 2)
      return <Group key={edge} name={`group-resize-${edge}`} x={x} y={y} draggable
        onMouseEnter={event => { stage.current = event.currentTarget.getStage(); stage.current!.container().style.cursor = cursors[edge]; setHovered(edge) }}
        onMouseLeave={() => { if (!active.current) { setHovered(undefined); resetCursor() } }}
        onMouseDown={event => {
          event.cancelBubble = true
          if (event.evt.button !== 0) return
          const origin = pointer(event.currentTarget)
          if (origin) active.current = { base: { ...group }, origin, edge, node: event.currentTarget }
        }}
        onTouchStart={event => { event.cancelBubble = true; const origin = pointer(event.currentTarget); if (origin) active.current = { base: { ...group }, origin, edge, node: event.currentTarget } }}
        onMouseUp={event => { event.cancelBubble = true; if (!active.current?.started) active.current = undefined }}
        onTouchEnd={event => { event.cancelBubble = true; if (!active.current?.started) active.current = undefined }}
        onClick={event => { event.cancelBubble = true }} onTap={event => { event.cancelBubble = true }}
        onDragStart={event => { event.cancelBubble = true; if (active.current) active.current.started = true }} onDragMove={move}
        onDragEnd={event => {
          event.cancelBubble = true
          const drag = active.current, last = drag?.latest
          active.current = undefined
          if (drag) event.currentTarget.position(handlePosition(last ?? drag.base, drag.edge))
          setPreview(undefined); setHovered(undefined); resetCursor()
          // Removing a Konva node can emit a synthetic dragend without a release.
          if (last && event.evt) callbacks.current.onCommit(last)
          callbacks.current.onPreview()
        }}>
        <Rect x={-width / 2} y={-height / 2} width={width} height={height} fill="rgba(0,0,0,0)"/>
        <Rect x={-knob / 2} y={-knob / 2} width={knob} height={knob} fill={hovered === edge ? '#1677ff' : 'white'} stroke="#1677ff" strokeWidth={1 / scale} listening={false}/>
      </Group>
    })}
  </Group>
}
