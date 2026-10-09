import { Group, Line, Text } from 'react-konva'
import { useMemo, useRef, useState } from 'react'
import type { Node as KonvaNode } from 'konva/lib/Node'
import type { Asset, Item, Page, RulerRange } from '../../../model'
import { imageDimensionMarkerLayout, dimensionGroups, RULER_MIN_RANGE, type DimensionDisplayOverride, type DimensionDisplayPrecision, type ImageDimensionMarkerLayout } from '../services/imageDimensionService'

export type RulerChange = (itemId: string, patch: Pick<Item, 'rulerWidthRange' | 'rulerHeightRange'>) => void

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

/** Konva's drag bounds receive/return absolute coordinates, unlike marker layout. */
function boundInParent(node: KonvaNode, absolute: { x: number; y: number }, constrain: (local: { x: number; y: number }) => { x: number; y: number }) {
  const transform = node.getParent()?.getAbsoluteTransform()
  if (!transform) return absolute
  return transform.point(constrain(transform.copy().invert().point(absolute)))
}

function pointerInParent(node: KonvaNode) {
  const pointer = node.getStage()?.getPointerPosition()
  const transform = node.getParent()?.getAbsoluteTransform()
  if (!pointer || !transform) return node.position()
  return transform.copy().invert().point(pointer)
}

function rangeAfterEndpoint(marker: ImageDimensionMarkerLayout, endpoint: 'start' | 'end', coordinate: number): RulerRange {
  const length = Math.max(1, marker.imageEnd - marker.imageStart)
  const ratio = clamp((coordinate - marker.imageStart) / length, 0, marker.rangeMax)
  return endpoint === 'start'
    ? [Math.min(ratio, marker.range[1] - RULER_MIN_RANGE), marker.range[1]]
    : [marker.range[0], Math.max(ratio, marker.range[0] + RULER_MIN_RANGE)]
}

function rangeAfterShift(marker: ImageDimensionMarkerLayout, delta: number): RulerRange {
  const length = Math.max(1, marker.imageEnd - marker.imageStart)
  const shift = clamp(delta / length, -marker.range[0], marker.rangeMax - marker.range[1])
  return [marker.range[0] + shift, marker.range[1] + shift]
}

function markerWithRange(marker: ImageDimensionMarkerLayout, range: RulerRange): ImageDimensionMarkerLayout {
  const length = marker.imageEnd - marker.imageStart
  const start = marker.imageStart + length * range[0]
  const end = marker.imageStart + length * range[1]
  if (marker.horizontal) {
    const firstTarget = marker.extension[0]?.[3] ?? marker.y1
    const secondTarget = marker.extension[1]?.[3] ?? marker.y1
    return { ...marker, range, x1: start, x2: end, textX: (start + end) / 2, extension: [[start, marker.y1, start, firstTarget], [end, marker.y1, end, secondTarget]] }
  }
  const firstTarget = marker.extension[0]?.[2] ?? marker.x1
  const secondTarget = marker.extension[1]?.[2] ?? marker.x1
  return { ...marker, range, y1: start, y2: end, textY: (start + end) / 2, extension: [[marker.x1, start, firstTarget, start], [marker.x1, end, secondTarget, end]] }
}

function applyRange(marker: ImageDimensionMarkerLayout, range: RulerRange, onChangeRuler: RulerChange) {
  onChangeRuler(marker.itemId, marker.axis === 'width' ? { rulerWidthRange: range } : { rulerHeightRange: range })
}

type RulerHandleProps = {
  marker: ImageDimensionMarkerLayout
  endpoint: 'start' | 'end'
  onPreview: (range: RulerRange) => void
  onCommit: (range: RulerRange) => void
}

/** The visible arrow is itself the handle; no extra circle is rendered. */
function RulerArrow({ marker, endpoint, onPreview, onCommit }: RulerHandleProps) {
  const [pressed, setPressed] = useState(false)
  const horizontal = marker.axis === 'width'
  const coordinate = endpoint === 'start' ? (horizontal ? marker.x1 : marker.y1) : (horizontal ? marker.x2 : marker.y2)
  const fixed = horizontal ? marker.y1 : marker.x1
  const minSpan = Math.max(1, Math.abs(marker.imageEnd - marker.imageStart) * RULER_MIN_RANGE)
  const limitEnd = marker.imageStart + (marker.imageEnd - marker.imageStart) * marker.rangeMax
  const origin = useRef({ x: horizontal ? coordinate : fixed, y: horizontal ? fixed : coordinate })
  const baseMarker = useRef(marker)
  const pendingRange = useRef<RulerRange>(marker.range)
  const size = pressed ? 1.7 : 1
  const handle = horizontal
    ? [0, 0, (endpoint === 'start' ? 5 : -5) * size, -2 * size, (endpoint === 'start' ? 5 : -5) * size, 2 * size]
    : [0, 0, -2 * size, (endpoint === 'start' ? 5 : -5) * size, 2 * size, (endpoint === 'start' ? 5 : -5) * size]
  return <Group x={horizontal ? coordinate : fixed} y={horizontal ? fixed : coordinate} draggable name="ruler-arrow" onMouseDown={event => { event.cancelBubble = true; setPressed(true) }} onMouseUp={event => { event.cancelBubble = true; setPressed(false) }} onTouchStart={event => { event.cancelBubble = true; setPressed(true) }} onTouchEnd={event => { event.cancelBubble = true; setPressed(false) }} onDragStart={event => {
    event.cancelBubble = true
    setPressed(true)
    origin.current = event.currentTarget.position()
    baseMarker.current = marker
    pendingRange.current = marker.range
  }} dragBoundFunc={function (next) {
    return boundInParent(this, next, local => {
      if (horizontal) {
        const minimum = endpoint === 'start' ? marker.imageStart : marker.x1 + minSpan
        const maximum = endpoint === 'start' ? marker.x2 - minSpan : limitEnd
        return { x: clamp(local.x, minimum, maximum), y: fixed }
      }
      const minimum = endpoint === 'start' ? marker.imageStart : marker.y1 + minSpan
      const maximum = endpoint === 'start' ? marker.y2 - minSpan : limitEnd
      return { x: fixed, y: clamp(local.y, minimum, maximum) }
    })
  }} onDragMove={event => {
    event.cancelBubble = true
    const position = event.currentTarget.position()
    const delta = horizontal ? position.x - origin.current.x : position.y - origin.current.y
    const initial = endpoint === 'start' ? (horizontal ? baseMarker.current.x1 : baseMarker.current.y1) : (horizontal ? baseMarker.current.x2 : baseMarker.current.y2)
    const range = rangeAfterEndpoint(baseMarker.current, endpoint, initial + delta)
    pendingRange.current = range
    onPreview(range)
  }} onDragEnd={event => {
    event.cancelBubble = true
    onCommit(pendingRange.current)
    setPressed(false)
  }}>
    <Line points={handle} closed fill={pressed ? '#2563eb' : '#2f6fa3'} stroke={pressed ? '#1d4ed8' : '#2f6fa3'} strokeWidth={pressed ? 1.3 : 0.8} hitStrokeWidth={12}/>
  </Group>
}

function RulerLabel({ marker, onPreview, onCommit, movable }: { marker: ImageDimensionMarkerLayout; onPreview: (range: RulerRange) => void; onCommit: (range: RulerRange) => void; movable: boolean }) {
  const horizontal = marker.axis === 'width'
  const startPointer = useRef({ x: marker.textX, y: horizontal ? marker.textY - 4 : marker.textY })
  const baseMarker = useRef(marker)
  const pendingRange = useRef<RulerRange>(marker.range)
  return <Group x={marker.textX} y={horizontal ? marker.textY - 4 : marker.textY} draggable={movable} listening={movable} name="ruler-label" onMouseDown={event => { event.cancelBubble = true }} onTouchStart={event => { event.cancelBubble = true }} onDragStart={event => {
    event.cancelBubble = true
    startPointer.current = pointerInParent(event.currentTarget)
    baseMarker.current = marker
    pendingRange.current = marker.range
  }} onDragMove={event => {
    event.cancelBubble = true
    const pointer = pointerInParent(event.currentTarget)
    const delta = horizontal ? pointer.x - startPointer.current.x : pointer.y - startPointer.current.y
    const range = rangeAfterShift(baseMarker.current, delta)
    pendingRange.current = range
    onPreview(range)
    const centered = markerWithRange(baseMarker.current, range)
    event.currentTarget.position({ x: centered.textX, y: horizontal ? centered.textY - 4 : centered.textY })
  }} onDragEnd={event => {
    event.cancelBubble = true
    onCommit(pendingRange.current)
  }}>
    {horizontal
      ? <Text x={-marker.textWidth / 2} y={0} width={marker.textWidth} height={8} text={marker.label} align="center" fontSize={7} fill="#2f6fa3"/>
      : <Group rotation={-90}><Text x={-marker.textWidth / 2} y={-7} width={marker.textWidth} height={8} text={marker.label} align="center" fontSize={7} fill="#2f6fa3"/></Group>}
  </Group>
}

function Marker({ marker, onChangeRuler }: { marker: ImageDimensionMarkerLayout; onChangeRuler?: RulerChange }) {
  const [previewRange, setPreviewRange] = useState<RulerRange>()
  const displayMarker = previewRange ? markerWithRange(marker, previewRange) : marker
  const preview = (range: RulerRange) => setPreviewRange(range)
  const commit = (range: RulerRange) => {
    setPreviewRange(range)
    if (onChangeRuler) applyRange(marker, range, onChangeRuler)
  }
  const horizontal = displayMarker.axis === 'width'
  const defaultRange = displayMarker.range[0] < 0.0001 && Math.abs(displayMarker.range[1] - 1) < 0.0001
  const labelMovable = !defaultRange && displayMarker.range[1] - displayMarker.range[0] < displayMarker.rangeMax - 0.0001
  return <Group key={marker.itemId} name={`image-dimension-${marker.itemId}`} listening={Boolean(onChangeRuler)}>
    {displayMarker.extension.map(([x1, y1, x2, y2], index) => <Line key={`extension-${index}`} points={[x1, y1, x2, y2]} stroke="#2f6fa3" strokeWidth={0.8} listening={false}/>) }
    {horizontal
      ? <>
        <Line points={[displayMarker.x1, displayMarker.y1, displayMarker.textX - displayMarker.gap, displayMarker.y1]} stroke="#2f6fa3" strokeWidth={0.8} lineCap="round" listening={false}/>
        <Line points={[displayMarker.textX + displayMarker.gap, displayMarker.y1, displayMarker.x2, displayMarker.y1]} stroke="#2f6fa3" strokeWidth={0.8} lineCap="round" listening={false}/>
        {!onChangeRuler && <><Line points={[displayMarker.x1, displayMarker.y1, displayMarker.x1 + 5, displayMarker.y1 - 2, displayMarker.x1 + 5, displayMarker.y1 + 2]} closed fill="#2f6fa3" stroke="#2f6fa3" strokeWidth={0.8} listening={false}/>
        <Line points={[displayMarker.x2, displayMarker.y1, displayMarker.x2 - 5, displayMarker.y1 - 2, displayMarker.x2 - 5, displayMarker.y1 + 2]} closed fill="#2f6fa3" stroke="#2f6fa3" strokeWidth={0.8} listening={false}/></>}
      </>
      : <>
        <Line points={[displayMarker.x1, displayMarker.y1, displayMarker.x1, displayMarker.textY - displayMarker.gap]} stroke="#2f6fa3" strokeWidth={0.8} lineCap="round" listening={false}/>
        <Line points={[displayMarker.x1, displayMarker.textY + displayMarker.gap, displayMarker.x1, displayMarker.y2]} stroke="#2f6fa3" strokeWidth={0.8} lineCap="round" listening={false}/>
        {!onChangeRuler && <><Line points={[displayMarker.x1, displayMarker.y1, displayMarker.x1 - 2, displayMarker.y1 + 5, displayMarker.x1 + 2, displayMarker.y1 + 5]} closed fill="#2f6fa3" stroke="#2f6fa3" strokeWidth={0.8} listening={false}/>
        <Line points={[displayMarker.x1, displayMarker.y2, displayMarker.x1 - 2, displayMarker.y2 - 5, displayMarker.x1 + 2, displayMarker.y2 - 5]} closed fill="#2f6fa3" stroke="#2f6fa3" strokeWidth={0.8} listening={false}/></>}
      </>}
    {onChangeRuler && <>
      <RulerLabel marker={displayMarker} onPreview={preview} onCommit={commit} movable={labelMovable}/>
      <RulerArrow marker={displayMarker} endpoint="start" onPreview={preview} onCommit={commit}/>
      <RulerArrow marker={displayMarker} endpoint="end" onPreview={preview} onCommit={commit}/>
    </>}
    {!onChangeRuler && (horizontal
      ? <Text x={displayMarker.textX - displayMarker.textWidth / 2} y={displayMarker.textY - 4} width={displayMarker.textWidth} height={8} text={displayMarker.label} align="center" fontSize={7} fill="#2f6fa3" listening={false}/>
      : <Group x={displayMarker.textX} y={displayMarker.textY} rotation={-90} listening={false}><Text x={-displayMarker.textWidth / 2} y={-7} width={displayMarker.textWidth} height={8} text={displayMarker.label} align="center" fontSize={7} fill="#2f6fa3"/></Group>)}
  </Group>
}

export default function ImageDimensionMarkers({ page, assets, selectedItemIds = [], precision = 'default', decimalPlaces = 1, displayOverrides, visualScales, onChangeRuler }: { page: Page; assets: Map<string, Asset>; selectedItemIds?: string[]; precision?: DimensionDisplayPrecision; decimalPlaces?: number; displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>; visualScales?: ReadonlyMap<string, number>; onChangeRuler?: RulerChange }) {
  const displayPage = useMemo(() => {
    if (!visualScales?.size) return page
    return { ...page, items: page.items.map(item => {
      const scale = visualScales.get(item.id) ?? 1
      return scale === 1 ? item : { ...item, w: item.w * scale, h: item.h * scale }
    }) }
  }, [page, visualScales])
  return <Group listening={Boolean(onChangeRuler)} name="image-dimension-markers">
    {dimensionGroups(displayPage).map(group => {
      const override = group.itemIds.map(id => displayOverrides?.get(id)).find(Boolean)
      const isSelected = selectedItemIds.some(id => group.itemIds.includes(id))
      const markerPrecision = override?.precision ?? (isSelected ? precision : 'default')
      const markerDecimals = override?.decimalPlaces ?? (isSelected ? decimalPlaces : 1)
      const marker = imageDimensionMarkerLayout(group, displayPage, assets, markerPrecision, markerDecimals)
      return marker ? <Marker key={`${group.id}-${marker.range[0]}-${marker.range[1]}`} marker={marker} onChangeRuler={onChangeRuler}/> : null
    })}
  </Group>
}
