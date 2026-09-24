import { POOL_DROP_EVENT, poolDropPoint, type PoolImageDrop } from './services/poolDragService'
import { itemsInSelection, selectionBounds, type CanvasPoint } from './services/canvasSelectionService'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Rect, Group, Image as KonvaImage, Transformer, Text, Line } from 'react-konva'
import type Konva from 'konva'
import { artworkBounds, constrain, defaultLayoutBounds, PAPER_HEIGHT, PAPER_WIDTH, svgObjectUrl, type Asset, type HeaderBlock, type Item, type LayoutBounds, type Page, type PageHeader } from '../../model'
import HeaderBlockCanvas from './components/HeaderBlockCanvas'
import ImageGroupBackgrounds from './components/ImageGroupBackgrounds'
import ImageDimensionMarkers from './components/ImageDimensionMarkers'
import type { AccessoryVisual } from './components/ImageGroupDetails'
import type { DimensionDisplayPrecision } from './services/imageDimensionService'

const svgImageCache = new Map<string, HTMLImageElement>()
function displayDate(value?: string) {
  if (!value) return '-'
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  return match ? `${Number(match[2])}月${Number(match[3])}日` : value
}

function constrainInsideGroup(item: Item, group?: { x: number; y: number; width: number; height: number }) {
  if (!group) return item
  const angle = item.rotation * Math.PI / 180
  const halfW = (Math.abs(Math.cos(angle)) * item.w + Math.abs(Math.sin(angle)) * item.h) / 2
  const halfH = (Math.abs(Math.sin(angle)) * item.w + Math.abs(Math.cos(angle)) * item.h) / 2
  return { ...item,
    x: Math.max(group.x + halfW, Math.min(group.x + group.width - halfW, item.x)),
    y: Math.max(group.y + halfH, Math.min(group.y + group.height - halfH, item.y)),
  }
}

function PageHeaderCanvas({ pageNumber, totalPages, metadata }: { pageNumber: number; totalPages: number; metadata: PageHeader }) {
  return <Group listening={false}>
    <Text x={15} y={12} text="ORDER PROOF" fontSize={18} fontStyle="bold" fill="#202124"/>
    <Text x={15} y={35} text={`Customer: ${metadata.customerName?.trim() || '-'}`} fontSize={15} fill="#202124"/>
    <Text x={15} y={57} text="Please review the details below and confirm." fontSize={10} fill="#5f6368"/>
    <Rect x={280} y={14} width={204} height={72} fill="white" stroke="#888" strokeWidth={0.9} cornerRadius={4}/>
    <Line points={[280, 38, 405, 38]} stroke="#888" strokeWidth={0.7}/><Line points={[280, 62, 405, 62]} stroke="#888" strokeWidth={0.7}/><Line points={[360, 14, 360, 86]} stroke="#888" strokeWidth={0.7}/>
    <Text x={285} y={21} text="Drawing Date" fontSize={7.5} fill="#202124"/>
    <Text x={365} y={21} text={displayDate(metadata.drawingDate)} fontSize={8} fill="#202124"/>
    <Text x={285} y={45} text="Estimated Ship Date" fontSize={6.3} fill="#202124"/>
    <Text x={365} y={45} text={displayDate(metadata.estimatedShipDate)} fontSize={8} fill="#202124"/>
    <Text x={285} y={69} text="Designer" fontSize={7.5} fill="#202124"/>
    <Text x={365} y={69} text={metadata.designer?.trim() || '-'} fontSize={7} fill="#202124" width={37} ellipsis/>
    <Line points={[405, 14, 405, 86]} stroke="#888" strokeWidth={0.7}/>
    <Text x={405} y={21} width={79} align="center" text="Page" fontSize={8} fill="#202124"/>
    <Text x={405} y={45} width={79} align="center" text={`${pageNumber} of ${totalPages}`} fontSize={12} fill="#202124"/>
  </Group>
}

const Artwork = memo(function Artwork({ item, asset, visualScale = 1, selected, interactive, bounds, groupBounds, onSelect, onChange }: {
  item: Item; asset: Asset; visualScale?: number; selected: boolean; interactive: boolean; bounds: LayoutBounds; groupBounds?: { x: number; y: number; width: number; height: number }; onSelect: (id: string | null) => void; onChange: (item: Item) => void
}) {
  const [image, setImage] = useState<HTMLImageElement>()
  const [failed, setFailed] = useState(false)
  const nodeRef = useRef<Konva.Image>(null)
  const transformerRef = useRef<Konva.Transformer>(null)
  useEffect(() => {
    const sourceSvg = item.backSvg ?? asset.svg
    const cached = svgImageCache.get(sourceSvg)
    if (cached) { setImage(cached); setFailed(false); return }
    const img = new window.Image()
    let cancelled = false
    img.decoding = 'async'
    img.onload = () => { svgImageCache.set(sourceSvg, img); if (!cancelled) { setImage(img); setFailed(false) } }
    img.onerror = () => { if (!cancelled) setFailed(true) }
    // Keep SVG as the source artwork; preview fields are compatibility URLs
    // and must not replace the editable/vector asset on the canvas.
    img.src = svgObjectUrl(sourceSvg)
    return () => { cancelled = true; img.onload = null; img.onerror = null }
  }, [asset.svg, item.backSvg])
  const displayItem = visualScale === 1 ? item : { ...item, w: item.w * visualScale, h: item.h * visualScale }
  useEffect(() => {
    if (selected && nodeRef.current) transformerRef.current?.nodes([nodeRef.current])
  }, [selected, image, interactive])
  if (!image) return <Text x={displayItem.x - displayItem.w / 2} y={displayItem.y} width={displayItem.w} text={failed ? '图片加载失败' : '加载图片…'} fontSize={12} fill="#64748b" />
  return <>{displayItem.caption && <Text listening={false} x={displayItem.captionAlign === 'left' ? displayItem.x - displayItem.w / 2 : displayItem.x - displayItem.w / 2 - 8} y={displayItem.y - displayItem.h / 2 - 20} width={displayItem.captionAlign === 'left' ? displayItem.w : displayItem.w + 16} text={displayItem.caption} align={displayItem.captionAlign ?? 'center'} fontSize={displayItem.captionFontSize ?? 10} fill="#e11d48"/>}
    <KonvaImage ref={nodeRef} image={image} x={displayItem.x} y={displayItem.y} width={displayItem.w} height={displayItem.h}
      scaleX={displayItem.mirrorX ? -1 : 1} offsetX={displayItem.w / 2} offsetY={displayItem.h / 2} rotation={displayItem.rotation} draggable={interactive}
      onClick={event => { if (!interactive) return; event.cancelBubble = true; onSelect(item.id) }} onTap={event => { if (!interactive) return; event.cancelBubble = true; onSelect(item.id) }} onDragStart={() => interactive && onSelect(item.id)}
      onDragMove={event => { const next = constrainInsideGroup(constrain({ ...item, ...event.target.position() }, bounds), groupBounds); event.target.position(next) }}
      onDragEnd={event => { const next = constrainInsideGroup(constrain({ ...item, ...event.target.position() }, bounds), groupBounds); event.target.position(next); onChange(next) }}
      onTransformEnd={() => {
        const node = nodeRef.current!
        const next = constrain({ ...item, x: node.x(), y: node.y(), rotation: node.rotation() }, bounds)
        node.position(next)
        onChange(next)
      }} />
    {displayItem.note && <Text listening={false} x={displayItem.x - displayItem.w / 2 - 8} y={displayItem.y + displayItem.h / 2 + 2} width={displayItem.w + 16} text={displayItem.note} align="center" fontSize={8} fill="#475569" wrap="none"/>}
    {selected && interactive && <Transformer ref={transformerRef} resizeEnabled={false} rotateEnabled={false} rotationSnaps={[0, 90, 180, 270]} borderStroke="#2563eb" />}
  </>
})

export default function ArtworkCanvas({ page, assets, selected, selectedIds = [], onBoxSelect, selectedGroupIds = [], onSelect, onSelectGroup, onSelectAccessory, selectedAccessoryKey, accessoryVisuals, onChangeAccessory, onChange, onDropAsset, metadata, totalPages, mode = 'select', zoom = 1, onZoomChange, layoutBounds = defaultLayoutBounds, onHeaderBlockChange, dimensionPrecision = 'default', dimensionItemId, visualScales }: {
  page: Page; assets: Map<string, Asset>; selected: string | null; onSelect: (id: string | null) => void
  selectedIds?: string[]; onBoxSelect?: (ids: string[]) => void
  selectedGroupIds?: string[]; onSelectGroup?: (id: string, ctrlKey: boolean) => void
  onChange: (item: Item) => void; onDropAsset: (assetId: string, x: number, y: number) => void; metadata?: PageHeader; totalPages?: number
  mode?: 'select' | 'pan'; zoom?: number; onZoomChange?: (zoom: number) => void
  layoutBounds?: LayoutBounds; onHeaderBlockChange: (block: HeaderBlock) => void
  dimensionPrecision?: DimensionDisplayPrecision; dimensionItemId?: string; visualScales?: ReadonlyMap<string, number>; selectedAccessoryKey?: string; accessoryVisuals?: ReadonlyMap<string, AccessoryVisual>; onSelectAccessory?: (key: string) => void; onChangeAccessory?: (key: string, patch: Partial<AccessoryVisual>) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [spacePressed, setSpacePressed] = useState(false)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const panStart = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | undefined>(undefined)
  const boxStart = useRef<{ pointerId: number; start: CanvasPoint; screenX: number; screenY: number; dragging: boolean } | undefined>(undefined)
  const suppressClick = useRef(false)
  const [marquee, setMarquee] = useState<ReturnType<typeof selectionBounds> | null>(null)
  const select = (id: string | null) => { if (!suppressClick.current) onSelect(id) }
  const selectGroup = (id: string, ctrlKey: boolean) => { if (!suppressClick.current && !panMode) onSelectGroup?.(id, ctrlKey) }
  const panMode = mode === 'pan' || spacePressed
  const zoomFactor = Math.max(0.5, Math.min(2.5, zoom ?? 1))
  const imageBounds = useMemo(() => artworkBounds(layoutBounds), [layoutBounds])
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, button, summary, [contenteditable="true"]')) return
      if (event.code === 'Space') { event.preventDefault(); setSpacePressed(true) }
    }
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') { event.preventDefault(); setSpacePressed(false) } }
    const blur = () => { setSpacePressed(false); panStart.current = undefined; boxStart.current = undefined; setMarquee(null) }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur) }
  }, [])
  useEffect(() => {
    const element = ref.current
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !onZoomChange || event.deltaY === 0) return
      event.preventDefault()
      onZoomChange(Math.max(0.5, Math.min(2.5, Number((zoom + (event.deltaY < 0 ? 0.1 : -0.1)).toFixed(2)))))
    }
    element?.addEventListener('wheel', wheel, { passive: false })
    return () => element?.removeEventListener('wheel', wheel)
  }, [zoom, onZoomChange])
  useEffect(() => { setPan({ x: 0, y: 0 }); boxStart.current = undefined; setMarquee(null) }, [page.id])
  useEffect(() => { if (panMode) { boxStart.current = undefined; setMarquee(null) } }, [panMode])
  const scale = Math.max(0.01, Math.min((size.width - 48) / PAPER_WIDTH, (size.height - 48) / PAPER_HEIGHT)) * zoomFactor
  const x = (size.width - PAPER_WIDTH * scale) / 2 + pan.x
  const y = (size.height - PAPER_HEIGHT * scale) / 2 + pan.y
  useEffect(() => {
    const receive = (event: Event) => {
      const drop = (event as CustomEvent<PoolImageDrop>).detail
      if (!ref.current || !drop || !assets.has(drop.assetId)) return
      const point = poolDropPoint(drop, ref.current.getBoundingClientRect(), { x, y }, scale, { width: PAPER_WIDTH, height: PAPER_HEIGHT })
      if (point) onDropAsset(drop.assetId, point.x, point.y)
    }
    window.addEventListener(POOL_DROP_EVENT, receive)
    return () => window.removeEventListener(POOL_DROP_EVENT, receive)
  }, [assets, x, y, scale, onDropAsset])
  const pointerToPaper = (clientX: number, clientY: number) => {
    const bounds = ref.current!.getBoundingClientRect()
    return { x: (clientX - bounds.left - x) / scale, y: (clientY - bounds.top - y) / scale }
  }
  return <div ref={ref} className={`stage-wrap ${panMode ? 'is-pan-mode' : 'is-select-mode'}`} aria-label="A4 排版画布"
    onPointerDownCapture={() => {
      suppressClick.current = false
    }}
    onPointerMoveCapture={event => {
      const start = boxStart.current
      if (!start || start.pointerId !== event.pointerId || panMode) return
      if (!start.dragging && Math.hypot(event.clientX - start.screenX, event.clientY - start.screenY) < 4) return
      start.dragging = true
      suppressClick.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      setMarquee(selectionBounds(start.start, pointerToPaper(event.clientX, event.clientY)))
    }}
    onPointerUpCapture={event => {
      const start = boxStart.current
      if (!start || start.pointerId !== event.pointerId) return
      boxStart.current = undefined
      if (start.dragging) {
        const end = pointerToPaper(event.clientX, event.clientY)
        const box = selectionBounds(start.start, end)
        const ids = new Set(itemsInSelection(page.items, start.start, end))
        // Notes and note images are rendered as part of a group rather than
        // as standalone Items. Include the complete group when the marquee
        // touches its background/details area, so it can be scaled together.
        for (const group of page.imageGroups ?? []) {
          const height = Math.max(group.height, group.backgroundHeight ?? 0)
          const overlaps = group.x < box.x + box.width && group.x + group.width > box.x
            && group.y < box.y + box.height && group.y + height > box.y
          if (overlaps) group.itemIds.forEach(id => ids.add(id))
        }
        onBoxSelect?.([...ids])
        setMarquee(null)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }
    }}
    onPointerDown={event => { if (!panMode || event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); panStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y } }}
    onPointerMove={event => { const start = panStart.current; if (!start || start.pointerId !== event.pointerId) return; setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y }) }}
    onPointerUp={event => { if (panStart.current?.pointerId === event.pointerId) panStart.current = undefined }}
    onPointerCancel={() => { panStart.current = undefined; boxStart.current = undefined; setMarquee(null) }}
    onDragOver={event => { if (event.dataTransfer.types.includes('application/x-printflow-asset')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
    onDrop={event => {
      event.preventDefault()
      const id = event.dataTransfer.getData('application/x-printflow-asset')
      const bounds = ref.current!.getBoundingClientRect()
      const px = (event.clientX - bounds.left - x) / scale
      const py = (event.clientY - bounds.top - y) / scale
      if (id && px >= 0 && py >= 0 && px <= PAPER_WIDTH && py <= PAPER_HEIGHT) onDropAsset(id, px, py)
    }}>
    {size.width > 0 && size.height > 0 && <Stage width={size.width} height={size.height}
      onPointerDown={event => {
        const nativeEvent = event.evt as PointerEvent
        // Marquee selection starts only on the empty stage. Konva artwork and
        // accessory groups handle their own drag interaction independently.
        if (panMode || nativeEvent.button !== 0 || nativeEvent.ctrlKey || nativeEvent.metaKey || !onBoxSelect) return
        const targetName = event.target.name()
        const isEmptyCanvas = event.target === event.target.getStage()
          || targetName === 'canvas-background'
          || targetName === 'image-group-background'
        if (!isEmptyCanvas) return
        boxStart.current = {
          pointerId: nativeEvent.pointerId,
          start: pointerToPaper(nativeEvent.clientX, nativeEvent.clientY),
          screenX: nativeEvent.clientX,
          screenY: nativeEvent.clientY,
          dragging: false,
        }
      }}
      onClick={event => { if (!panMode && event.target === event.target.getStage()) select(null) }}>
      <Layer><Group x={x} y={y} scaleX={scale} scaleY={scale}>
        <Rect name="canvas-background" width={PAPER_WIDTH} height={PAPER_HEIGHT} fill="white" cornerRadius={4} shadowBlur={22} shadowColor="#0f172a" shadowOpacity={0.18} shadowOffsetY={5} onClick={() => { if (!panMode) select(null) }} />
        {/* Fixed page information stays behind artwork and cannot intercept selection. */}
        <PageHeaderCanvas pageNumber={page.id} totalPages={totalPages ?? 1} metadata={metadata ?? {}} />
        <Group clipX={0} clipY={0} clipWidth={PAPER_WIDTH} clipHeight={PAPER_HEIGHT}>
          <ImageGroupBackgrounds page={page} assets={assets} selectedItemId={dimensionItemId} precision={dimensionPrecision} selectedAccessoryKey={selectedAccessoryKey} accessoryVisuals={accessoryVisuals} onSelectAccessory={panMode ? undefined : onSelectAccessory} onChangeAccessory={panMode ? undefined : onChangeAccessory} selectedGroupIds={selectedGroupIds} onSelectGroup={panMode ? undefined : selectGroup}/>
          {page.items.map(item => { const asset = assets.get(item.assetId); const group = page.imageGroups?.find(candidate => candidate.itemIds.includes(item.id)); return asset && <Artwork key={item.id} item={item} asset={asset} visualScale={visualScales?.get(item.id) ?? 1} selected={selected === item.id || selectedIds.includes(item.id)} interactive={!panMode} bounds={imageBounds} groupBounds={group ? { x: group.x, y: group.y, width: group.width, height: group.height } : undefined} onSelect={select} onChange={onChange} /> })}
          <ImageDimensionMarkers page={page} assets={assets} selectedItemId={dimensionItemId} precision={dimensionPrecision} visualScales={visualScales}/>
          {page.headerBlocks?.map(block => <HeaderBlockCanvas key={block.id} block={block} bounds={layoutBounds} selected={selected === block.id} interactive={!panMode} onSelect={select} onChange={onHeaderBlockChange}/>)}
        </Group>
        <Group listening={false}>
          <Rect x={layoutBounds.left} y={layoutBounds.top} width={PAPER_WIDTH - layoutBounds.left - layoutBounds.right} height={PAPER_HEIGHT - layoutBounds.top - layoutBounds.bottom} stroke="#D4D4D4" strokeWidth={1.2} cornerRadius={6} shadowColor="#2563eb" shadowBlur={8} shadowOpacity={0.18} shadowOffsetY={2}/>
        </Group>
        {marquee && <Rect {...marquee} fill="rgba(37,99,235,0.12)" stroke="#2563eb" strokeWidth={1 / scale} dash={[4 / scale, 3 / scale]} listening={false}/>}
      </Group></Layer>
    </Stage>}
  </div>
}




