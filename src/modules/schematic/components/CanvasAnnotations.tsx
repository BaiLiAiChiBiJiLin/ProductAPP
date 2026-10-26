import { useEffect, useState } from 'react'
import { Group, Line, Rect, Text } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { CanvasAnnotation } from '../layoutTypes'
import { manualRulerGeometry, manualRulerLabel } from '../services/canvasAnnotationService'
import { RULER_COLOR, RULER_STROKE_WIDTH } from '../services/imageDimensionService'

type Ruler = Extract<CanvasAnnotation, { kind: 'ruler' }>

function localArrow(points: [number, number, number, number, number, number], origin: { x: number; y: number }) {
  return [points[0] - origin.x, points[1] - origin.y, points[2] - origin.x, points[3] - origin.y, points[4] - origin.x, points[5] - origin.y]
}

function RulerAnnotation({ annotation, selected, interactive, onSelect, onChange, onEdit }: {
  annotation: Ruler; selected: boolean; interactive: boolean
  onSelect: () => void; onChange: (annotation: Ruler) => void; onEdit: () => void
}) {
  const [preview, setPreview] = useState<Ruler>(annotation)
  const [pressedEndpoint, setPressedEndpoint] = useState<'start' | 'end'>()
  useEffect(() => setPreview(annotation), [annotation])
  const display = preview
  const geometry = manualRulerGeometry(display)
  const start = { x: display.x - annotation.x, y: display.y - annotation.y }
  const end = { x: display.x2 - annotation.x, y: display.y2 - annotation.y }
  const lines = [...geometry.extension, ...geometry.segment]
  const xs = lines.flatMap(line => [line[0] - annotation.x, line[2] - annotation.x])
  const ys = lines.flatMap(line => [line[1] - annotation.y, line[3] - annotation.y])
  const boundsX = Math.min(...xs, start.x, end.x) - 4
  const boundsY = Math.min(...ys, start.y, end.y) - 15
  const boundsRight = Math.max(...xs, start.x, end.x) + 4
  const boundsBottom = Math.max(...ys, start.y, end.y) + 12
  const commitEndpoint = (endpoint: 'start' | 'end', point: { x: number; y: number }) => {
    const next = endpoint === 'start'
      ? { ...display, x: annotation.x + point.x, y: annotation.y + point.y }
      : { ...display, x2: annotation.x + point.x, y2: annotation.y + point.y }
    setPreview(next)
    onChange(next)
  }
  const handleDrag = (endpoint: 'start' | 'end', event: KonvaEventObject<DragEvent>) => {
    event.cancelBubble = true
    const point = event.currentTarget.position()
    const next = endpoint === 'start'
      ? { ...display, x: annotation.x + point.x, y: annotation.y + point.y }
      : { ...display, x2: annotation.x + point.x, y2: annotation.y + point.y }
    setPreview(next)
  }
  const handle = (endpoint: 'start' | 'end', point: { x: number; y: number }) => {
    const arrow = endpoint === 'start' ? geometry.arrowStart : geometry.arrowEnd
    const absolute = endpoint === 'start' ? { x: display.x, y: display.y } : { x: display.x2, y: display.y2 }
    const arrowScale = pressedEndpoint === endpoint ? 1.7 : 1
    const scaledArrow = arrow.map((value, index) => {
      if (index % 2 === 0) return absolute.x + (value - absolute.x) * arrowScale
      return absolute.y + (value - absolute.y) * arrowScale
    }) as [number, number, number, number, number, number]
    return <Group x={point.x} y={point.y} draggable={interactive} name="manual-ruler-arrow"
      onMouseDown={event => { event.cancelBubble = true; setPressedEndpoint(endpoint) }} onMouseUp={event => { event.cancelBubble = true; setPressedEndpoint(undefined) }}
      onTouchStart={event => { event.cancelBubble = true; setPressedEndpoint(endpoint) }} onTouchEnd={event => { event.cancelBubble = true; setPressedEndpoint(undefined) }}
      onClick={event => { event.cancelBubble = true; onSelect() }} onTap={event => { event.cancelBubble = true; onSelect() }}
      onDragStart={event => { event.cancelBubble = true; setPressedEndpoint(endpoint); onSelect() }} onDragMove={event => handleDrag(endpoint, event)}
      onDragEnd={event => { event.cancelBubble = true; setPressedEndpoint(undefined); commitEndpoint(endpoint, event.currentTarget.position()) }}>
      <Line points={[scaledArrow[0] - absolute.x, scaledArrow[1] - absolute.y, scaledArrow[2] - absolute.x, scaledArrow[3] - absolute.y, scaledArrow[4] - absolute.x, scaledArrow[5] - absolute.y]} closed fill={pressedEndpoint === endpoint ? '#2563eb' : RULER_COLOR} stroke={pressedEndpoint === endpoint ? '#1d4ed8' : RULER_COLOR} strokeWidth={pressedEndpoint === endpoint ? 1.3 : RULER_STROKE_WIDTH} hitStrokeWidth={12}/>
    </Group>
  }
  const rootDragEnd = (event: KonvaEventObject<DragEvent>) => {
    event.cancelBubble = true
    const point = event.currentTarget.position()
    // The group already sits at the ruler's page origin, so its position is
    // the new origin, not a translation to add to the existing endpoints.
    const dx = point.x - annotation.x, dy = point.y - annotation.y
    if (dx === 0 && dy === 0) return
    const next = { ...display, x: display.x + dx, y: display.y + dy, x2: display.x2 + dx, y2: display.y2 + dy }
    setPreview(next)
    onChange(next)
  }
  return <Group x={annotation.x} y={annotation.y} draggable={interactive} listening={interactive}
    onClick={event => { event.cancelBubble = true; onSelect() }} onTap={event => { event.cancelBubble = true; onSelect() }}
    onDblClick={event => { event.cancelBubble = true; onEdit() }} onDblTap={event => { event.cancelBubble = true; onEdit() }}
    onDragStart={event => { event.cancelBubble = true; onSelect() }} onDragEnd={rootDragEnd}>
    {geometry.extension.map((line, index) => <Line key={`extension-${index}`} name="manual-ruler-extension" points={[line[0] - annotation.x, line[1] - annotation.y, line[2] - annotation.x, line[3] - annotation.y]} stroke={RULER_COLOR} strokeWidth={RULER_STROKE_WIDTH} listening={false}/>) }
    {geometry.segment.map((line, index) => <Line key={`segment-${index}`} name="manual-ruler-segment" points={[line[0] - annotation.x, line[1] - annotation.y, line[2] - annotation.x, line[3] - annotation.y]} stroke={RULER_COLOR} strokeWidth={RULER_STROKE_WIDTH} lineCap="round" listening={false}/>) }
    <Text name="manual-ruler-label" x={geometry.textX - annotation.x} y={geometry.textY - annotation.y} offsetX={geometry.textWidth / 2} offsetY={4} width={geometry.textWidth} height={8} rotation={geometry.textRotation} text={manualRulerLabel(display.measuredMm)} fontSize={8} align="center" fill={RULER_COLOR}
      onClick={event => { event.cancelBubble = true; onSelect() }} onTap={event => { event.cancelBubble = true; onSelect() }}
      onDblClick={event => { event.cancelBubble = true; onEdit() }} onDblTap={event => { event.cancelBubble = true; onEdit() }}/>
    {!interactive && <>
      <Line name="manual-ruler-arrow" points={localArrow(geometry.arrowStart, annotation)} closed fill={RULER_COLOR} stroke={RULER_COLOR} strokeWidth={RULER_STROKE_WIDTH} listening={false}/>
      <Line name="manual-ruler-arrow" points={localArrow(geometry.arrowEnd, annotation)} closed fill={RULER_COLOR} stroke={RULER_COLOR} strokeWidth={RULER_STROKE_WIDTH} listening={false}/>
    </>}
    {interactive && <>{handle('start', start)}{handle('end', end)}</>}
    {selected && <Rect x={boundsX} y={boundsY} width={boundsRight - boundsX} height={boundsBottom - boundsY} stroke="#2563eb" strokeWidth={0.6} dash={[3, 2]} listening={false}/>} 
  </Group>
}

export default function CanvasAnnotations({ annotations = [], selectedId, interactive, onSelect, onChange, onEdit }: {
  annotations?: CanvasAnnotation[]; selectedId?: string; interactive: boolean
  onSelect: (id: string) => void; onChange: (annotation: CanvasAnnotation) => void; onEdit: (annotation: CanvasAnnotation) => void
}) {
  return <Group>{annotations.map(annotation => {
    const selected = selectedId === annotation.id
    if (annotation.kind === 'ruler') return <RulerAnnotation key={annotation.id} annotation={annotation} selected={selected} interactive={interactive} onSelect={() => onSelect(annotation.id)} onChange={onChange} onEdit={() => onEdit(annotation)}/>
    const textWidth = Math.max(annotation.fontSize, ...annotation.text.split('\n').map(line => [...line].length * annotation.fontSize))
    return <Group key={annotation.id} x={annotation.x} y={annotation.y} draggable={interactive} listening={interactive}
      onClick={event => { event.cancelBubble = true; onSelect(annotation.id) }} onTap={event => { event.cancelBubble = true; onSelect(annotation.id) }}
      onDblClick={event => { event.cancelBubble = true; onEdit(annotation) }} onDblTap={event => { event.cancelBubble = true; onEdit(annotation) }}
      onDragStart={() => onSelect(annotation.id)} onDragEnd={event => { const { x, y } = event.target.position(); onChange({ ...annotation, x, y }) }}>
      {selected && <Rect x={-2} y={-2} width={textWidth + 4} height={annotation.fontSize * 1.2 * annotation.text.split('\n').length + 4} stroke="#2563eb" strokeWidth={0.8} dash={[3, 2]} listening={false}/>}
      <Text text={annotation.text} fontSize={annotation.fontSize} fill={annotation.color} lineHeight={1.2}/>
    </Group>
  })}</Group>
}
