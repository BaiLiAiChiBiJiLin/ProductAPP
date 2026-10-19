import { useEffect, useMemo, useRef, useState } from 'react'
import { Group, Image as KonvaImage, Layer, Path, Rect, Stage, Text, Transformer } from 'react-konva'
import type Konva from 'konva'
import { bounds, isValidPlacement, polygonArea, SpatialIndex, type PackedImpositionItem, type Point } from './impositionGeometry'
export type { PackedImpositionItem } from './impositionGeometry'
import { groupRepeatedPackingPages } from './packingAlgorithms'
import { constrainRotation } from './impositionRotation'
import { applyPackingEdit, type PackingEdit } from './packingEdits'
import { BOARD_HOLE_COLOR, BOARD_HOLE_STROKE_MM, boardHolePath } from './impositionHoles'

type Polygon = Array<[number, number]>
type Props = { pages: PackedImpositionItem[][]; imageSources: Record<string, string>; polygons?: Record<string, Polygon>; collapseRepeatedLayouts?: boolean; boardWidth: number; boardHeight: number; boardScale: number; effectiveX: number; effectiveY: number; effectiveWidth: number; effectiveHeight: number; spacing: number; holeCount: number; holeSize: number; holeLeft: number; holeStart: number; holeGap: number; zoom: number; panOffset: { x: number; y: number }; panMode: boolean; selectedImageId?: string; onSelectImage: (id: string) => void; onPagesChange?: (pages: PackedImpositionItem[][]) => void; onEdit?: (pages: PackedImpositionItem[][], edit: PackingEdit) => void; onInteractionHint?: (hint: string) => void }

const imageCache = new Map<string, HTMLImageElement>()
function useSourceImage(source?: string) {
  const [image, setImage] = useState<HTMLImageElement>()
  useEffect(() => {
    if (!source) { setImage(undefined); return }
    const cached = imageCache.get(source)
    if (cached) { setImage(cached); return }
    const next = new window.Image()
    let cancelled = false
    next.onload = () => { imageCache.set(source, next); if (!cancelled) setImage(next) }
    next.src = source
    return () => { cancelled = true; next.onload = null }
  }, [source])
  return image
}

type ResolvedMove = { valid: boolean; pageIndex: number; item: PackedImpositionItem; stagePosition: Point }
type DragTransaction = { itemId: string; sourcePageIndex: number; original: PackedImpositionItem; lastValid: ResolvedMove; lastStagePosition: Point }

function CanvasImage({ item, source, scale, editable, onSelect, onDragStart, onDragMove, onDragEnd, onTransformStart, onTransform, onTransformEnd, nodeRef }: { item: PackedImpositionItem; source?: string; scale: number; editable: boolean; onSelect: () => void; onDragStart: (node: Konva.Image) => void; onDragMove: (node: Konva.Image) => ResolvedMove; onDragEnd: (node: Konva.Image) => void; onTransformStart: (node: Konva.Image) => void; onTransform: (node: Konva.Image) => void; onTransformEnd: (node: Konva.Image) => void; nodeRef: (node: Konva.Image | null) => void }) {
  const image = useSourceImage(source)
  const rotation = item.rotation ?? 0
  const visual = bounds(item, rotation, 0, 0)
  const lastValidPosition = useRef<Point>({ x: 0, y: 0 })
  const restore = (node: Konva.Image) => node.absolutePosition(lastValidPosition.current)
  return <KonvaImage ref={nodeRef} id={item.image.id} image={image} x={(item.x + (visual.right - visual.left) / 2) * scale} y={(item.y + (visual.bottom - visual.top) / 2) * scale} width={item.width * scale} height={item.height * scale} offsetX={item.width * scale / 2} offsetY={item.height * scale / 2} rotation={rotation} perfectDrawEnabled={false} draggable={editable}
    onClick={event => { event.cancelBubble = true; onSelect() }}
    onDragStart={editable ? event => { const node = event.target as Konva.Image; node.getParent()?.moveToTop(); lastValidPosition.current = node.absolutePosition(); onDragStart(node) } : undefined}
    onDragMove={editable ? event => { const node = event.target as Konva.Image; const result = onDragMove(node); if (result.valid) { node.absolutePosition(result.stagePosition); lastValidPosition.current = result.stagePosition } else restore(node) } : undefined}
    onDragEnd={editable ? event => onDragEnd(event.target as Konva.Image) : undefined}
    onTransformStart={editable ? event => onTransformStart(event.target as Konva.Image) : undefined}
    onTransform={editable ? event => onTransform(event.target as Konva.Image) : undefined}
    onTransformEnd={editable ? event => onTransformEnd(event.target as Konva.Image) : undefined} opacity={image ? 1 : .35} />
}

export default function ImpositionKonvaCanvas(props: Props) {
  const { pages, imageSources, polygons = {}, collapseRepeatedLayouts = false, boardWidth, boardHeight, boardScale, effectiveX, effectiveY, effectiveWidth, effectiveHeight, spacing, holeCount, holeSize, holeLeft, holeStart, holeGap, zoom, panOffset, panMode, selectedImageId, onSelectImage } = props
  const [localPages, setLocalPages] = useState(pages)
  const pagesChangedRef = useRef(props.onPagesChange)
  pagesChangedRef.current = props.onPagesChange
  useEffect(() => { pagesChangedRef.current?.(localPages) }, [localPages])
  const displayGroups = useMemo(() => collapseRepeatedLayouts ? groupRepeatedPackingPages(localPages) : localPages.map((page, pageIndex) => ({ page, pageIndices: [pageIndex], repeatCount: 1 })), [localPages, collapseRepeatedLayouts])
  const displayIndexByPage = useMemo(() => new Map(displayGroups.flatMap((group, displayIndex) => group.pageIndices.map(pageIndex => [pageIndex, displayIndex] as const))), [displayGroups])
  const pageUtilizations = useMemo(() => {
    // Each source outline is measured once even when QT produces many copies.
    const areas = new Map<Polygon, number>()
    return localPages.map(page => page.reduce((sum, item) => {
      const polygon = item.polygon ?? polygons[item.image.sourceImageId ?? item.image.id]
      if (!polygon || polygon.length < 3) return sum + item.width * item.height
      let area = areas.get(polygon)
      if (area === undefined) { area = polygonArea(polygon); areas.set(polygon, area) }
      return sum + area
    }, 0) / Math.max(1, effectiveWidth * effectiveHeight) * 100)
  }, [localPages, polygons, effectiveWidth, effectiveHeight])
  const [viewport, setViewport] = useState({ width: 1, height: 1 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef<Record<string, Konva.Image | null>>({})
  const transformerRef = useRef<Konva.Transformer>(null)
  const transactionRef = useRef<DragTransaction | undefined>(undefined)
  const rotationTransactionRef = useRef<DragTransaction | undefined>(undefined)
  const rotationLimitedRef = useRef(false)
  useEffect(() => { setLocalPages(pages); rotationTransactionRef.current = undefined; transactionRef.current = undefined }, [pages])
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => setViewport({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const node = selectedImageId ? nodeRefs.current[selectedImageId] : null
    if (node && transformerRef.current) transformerRef.current.nodes([node])
    else transformerRef.current?.nodes([])
  }, [selectedImageId, localPages, collapseRepeatedLayouts])
  const gap = 24
  const pageWidth = boardWidth * boardScale
  const pageHeight = boardHeight * boardScale
  const columns = 4
  const rows = Math.max(1, Math.ceil(displayGroups.length / columns))
  const stageWidth = columns * pageWidth + (columns - 1) * gap
  const stageHeight = rows * pageHeight + (rows - 1) * gap
  const pageGap = gap / boardScale
  const sceneX = panOffset.x + Math.max(0, (viewport.width - stageWidth * zoom) / 2)
  const sceneY = 24 * zoom + panOffset.y + Math.max(0, (viewport.height - stageHeight * zoom) / 2)
  const indices = useMemo(() => localPages.map(page => new SpatialIndex(page.map(item => ({ ...item, polygon: item.polygon ?? polygons[item.image.sourceImageId ?? item.image.id] })))), [localPages, polygons])
  const region = useMemo(() => ({ left: effectiveX, top: effectiveY, right: effectiveX + effectiveWidth, bottom: effectiveY + effectiveHeight }), [effectiveX, effectiveY, effectiveWidth, effectiveHeight])
  const pagePosition = (pageIndex: number) => { const displayIndex = displayIndexByPage.get(pageIndex) ?? pageIndex; return { column: displayIndex % columns, row: Math.floor(displayIndex / columns) } }
  const toGlobalMm = (stagePosition: Point) => ({ x: (stagePosition.x - sceneX) / (zoom * boardScale), y: (stagePosition.y - sceneY) / (zoom * boardScale) })
  const toStagePosition = (pageIndex: number, item: PackedImpositionItem) => {
    const page = pagePosition(pageIndex); const itemBounds = bounds(item, item.rotation ?? 0)
    const x = page.column * (boardWidth + pageGap) + item.x + (itemBounds.right - itemBounds.left) / 2
    const y = page.row * (boardHeight + pageGap) + item.y + (itemBounds.bottom - itemBounds.top) / 2
    return { x: sceneX + x * zoom * boardScale, y: sceneY + y * zoom * boardScale }
  }
  const resolveMove = (sourcePageIndex: number, original: PackedImpositionItem, node: Konva.Image): ResolvedMove => {
    const global = toGlobalMm(node.absolutePosition()); const visual = bounds(original, node.rotation(), 0, 0)
    const targetColumn = Math.max(0, Math.min(columns - 1, Math.floor(global.x / (boardWidth + pageGap))))
    const targetRow = Math.max(0, Math.floor(global.y / (boardHeight + pageGap)))
    const targetDisplayIndex = targetRow * columns + targetColumn
    const targetPageIndex = displayGroups[targetDisplayIndex]?.pageIndices[0]
    const fallback = { valid: false, pageIndex: sourcePageIndex, item: original, stagePosition: transactionRef.current?.lastStagePosition ?? node.absolutePosition() }
    if (targetPageIndex === undefined) return fallback
    const targetPageOrigin = { x: targetColumn * (boardWidth + pageGap), y: targetRow * (boardHeight + pageGap) }
    const value = { x: global.x - targetPageOrigin.x - (visual.right - visual.left) / 2, y: global.y - targetPageOrigin.y - (visual.bottom - visual.top) / 2 }
    const base = { ...original, x: value.x, y: value.y, rotation: node.rotation(), polygon: original.polygon ?? polygons[original.image.id] ?? polygons[original.image.sourceImageId ?? ''] }
    const valid = isValidPlacement(base, targetPageIndex, indices, region, Math.max(0, spacing))
    return { valid, pageIndex: targetPageIndex, item: base, stagePosition: toStagePosition(targetPageIndex, base) }
  }
  const commitTransaction = (transaction: DragTransaction) => {
    const preview = transaction.lastValid
    if (preview.pageIndex === transaction.sourcePageIndex
      && Math.abs(preview.item.x - transaction.original.x) < 1e-7
      && Math.abs(preview.item.y - transaction.original.y) < 1e-7
      && Math.abs((preview.item.rotation ?? 0) - (transaction.original.rotation ?? 0)) < 1e-7) return
    const result = applyPackingEdit(localPages, transaction.sourcePageIndex, transaction.original, preview.pageIndex, preview.item, collapseRepeatedLayouts)
    setLocalPages(result.pages)
    props.onEdit?.(result.pages, result.edit)
  }
  const beginTransaction = (pageIndex: number, item: PackedImpositionItem, node: Konva.Image) => {
    const initial = { valid: true, pageIndex, item, stagePosition: node.absolutePosition() }
    transactionRef.current = { itemId: item.image.id, sourcePageIndex: pageIndex, original: item, lastValid: initial, lastStagePosition: initial.stagePosition }
    transformerRef.current?.moveToTop()
    onSelectImage(item.image.id)
  }
  const moveTransaction = (pageIndex: number, item: PackedImpositionItem, node: Konva.Image) => {
    const transaction = transactionRef.current
    if (!transaction || transaction.itemId !== item.image.id) beginTransaction(pageIndex, item, node)
    const result = resolveMove(pageIndex, transactionRef.current?.original ?? item, node)
    if (result.valid && transactionRef.current) { transactionRef.current.lastValid = result; transactionRef.current.lastStagePosition = result.stagePosition }
    return result
  }
  const endTransaction = (node: Konva.Image) => {
    const transaction = transactionRef.current
    if (transaction) {
      if (transaction.lastValid.pageIndex !== transaction.sourcePageIndex) {
        // The preview is not a production quantity change. Keep the committed
        // plan visible beneath loading until the complete replan is validated.
        node.absolutePosition(toStagePosition(transaction.sourcePageIndex, transaction.original))
        transformerRef.current?.forceUpdate()
      }
      commitTransaction(transaction)
    }
    else node.absolutePosition(node.absolutePosition())
    transactionRef.current = undefined
  }
  const beginTransform = (pageIndex: number, item: PackedImpositionItem) => {
    const original = { ...item, polygon: item.polygon ?? polygons[item.image.id] ?? polygons[item.image.sourceImageId ?? ''] }
    const initial = { valid: true, pageIndex, item: original, stagePosition: toStagePosition(pageIndex, original) }
    rotationTransactionRef.current = { itemId: item.image.id, sourcePageIndex: pageIndex, original, lastValid: initial, lastStagePosition: initial.stagePosition }
    rotationLimitedRef.current = false
  }
  const previewTransform = (pageIndex: number, item: PackedImpositionItem, node: Konva.Image) => {
    if (rotationTransactionRef.current?.itemId !== item.image.id) beginTransform(pageIndex, item)
    const transaction = rotationTransactionRef.current!
    const result = constrainRotation(transaction.lastValid.item, node.rotation(), candidate => isValidPlacement(candidate, pageIndex, indices, region, Math.max(0, spacing)))
    const preview = { valid: true, pageIndex, item: result.item, stagePosition: toStagePosition(pageIndex, result.item) }
    transaction.lastValid = preview
    transaction.lastStagePosition = preview.stagePosition
    node.rotation(result.item.rotation ?? 0)
    node.absolutePosition(preview.stagePosition)
    // Transformer updates its own angle after firing the node's transform event.
    // Resync after that update so the handle follows the constrained artwork.
    queueMicrotask(() => {
      const transformer = transformerRef.current
      if (transformer?.nodes()[0] !== node) return
      transformer.rotation(node.getAbsoluteRotation())
      transformer.forceUpdate()
    })
    if (result.limited && !rotationLimitedRef.current) props.onInteractionHint?.(`旋转已到边界或图片间距限制（${Math.max(0, spacing)} mm）`)
    rotationLimitedRef.current = result.limited
  }
  const commitTransform = (pageIndex: number, item: PackedImpositionItem, node: Konva.Image) => {
    previewTransform(pageIndex, item, node)
    const transaction = rotationTransactionRef.current
    if (transaction) commitTransaction(transaction)
    rotationTransactionRef.current = undefined
    rotationLimitedRef.current = false
  }
  const selectedNode = selectedImageId ? nodeRefs.current[selectedImageId] : null
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
  const visiblePages = displayGroups.map(({ page, pageIndices, repeatCount }, displayIndex) => ({ page, pageIndex: pageIndices[0], displayIndex, repeatCount, x: (displayIndex % columns) * (pageWidth + gap), y: Math.floor(displayIndex / columns) * (pageHeight + gap) })).filter(({ x, y }) => x * zoom + sceneX < viewport.width && (x + pageWidth) * zoom + sceneX > 0 && y * zoom + sceneY < viewport.height && (y + pageHeight) * zoom + sceneY > 0)
  return <div ref={viewportRef} className="imposition-konva-viewport"><Stage width={viewport.width} height={viewport.height} pixelRatio={pixelRatio} listening={!panMode} className="imposition-konva-stage"><Layer><Group x={sceneX} y={sceneY} scaleX={zoom} scaleY={zoom}>
    {visiblePages.map(({ pageIndex, x: pageX, y: pageY }) => <Group key={pageIndex} x={pageX} y={pageY}>
      <Rect width={pageWidth} height={pageHeight} fill="#fff" stroke="#cbd5e1" strokeWidth={1}/>
      <Rect x={effectiveX * boardScale} y={effectiveY * boardScale} width={effectiveWidth * boardScale} height={effectiveHeight * boardScale} stroke="#ef4444" dash={[2 * boardScale, 2 * boardScale]} strokeWidth={.8} listening={false}/>
      {holeSize > 0 && Array.from({ length: Math.max(0, holeCount) }).map((_, index) => <Path key={index} data={boardHolePath(holeLeft, holeStart + index * holeGap, holeSize)} scaleX={boardScale} scaleY={boardScale} fillEnabled={false} stroke={BOARD_HOLE_COLOR} strokeWidth={BOARD_HOLE_STROKE_MM} listening={false}/>) }
    </Group>)}
    {visiblePages.map(({ pageIndex, displayIndex, repeatCount, x: pageX, y: pageY }) => <Text key={`utilization-${pageIndex}`} x={pageX + pageWidth / 2} y={pageY - 18} width={pageWidth} align="center" offsetX={pageWidth / 2} text={`${collapseRepeatedLayouts ? `方案 ${displayIndex + 1} · 需生产 ${repeatCount} 块 · ` : ''}利用率 ${Math.round(pageUtilizations[pageIndex] ?? 0)}%`} fontSize={11} fill="#dc2626" listening={false}/>) }
    {visiblePages.flatMap(({ page, pageIndex, x: pageX, y: pageY }) => page.map(item => <Group key={`page-${pageIndex}-image-${item.image.id}`} x={pageX} y={pageY}><CanvasImage item={{ ...item, polygon: item.polygon ?? polygons[item.image.id] ?? polygons[item.image.sourceImageId ?? ''] }} source={imageSources[item.image.sourceImageId ?? item.image.id]} scale={boardScale} editable={!panMode} onSelect={() => onSelectImage(item.image.id)} onDragStart={node => beginTransaction(pageIndex, item, node)} onDragMove={node => moveTransaction(pageIndex, item, node)} onDragEnd={endTransaction} onTransformStart={() => beginTransform(pageIndex, item)} onTransform={node => previewTransform(pageIndex, item, node)} onTransformEnd={node => commitTransform(pageIndex, item, node)} nodeRef={node => { nodeRefs.current[item.image.id] = node }}/></Group>))}
    <Transformer ref={transformerRef} resizeEnabled={false} rotateEnabled={!panMode} rotateAnchorOffset={22} borderStroke="#2563eb" visible={Boolean(selectedNode)} />
  </Group></Layer></Stage></div>
}
