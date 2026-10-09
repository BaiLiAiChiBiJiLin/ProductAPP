import { useEffect, useRef, useState } from 'react'
import { Circle, Group, Image as KonvaImage, Layer, Rect, Stage, Transformer } from 'react-konva'
import type Konva from 'konva'
import type { ProductionImage } from './impositionRecords'

export type PackedImpositionItem = { image: ProductionImage; x: number; y: number; width: number; height: number }
type Props = { pages: PackedImpositionItem[][]; imageSources: Record<string, string>; boardWidth: number; boardHeight: number; boardScale: number; effectiveX: number; effectiveY: number; effectiveWidth: number; effectiveHeight: number; holeCount: number; holeSize: number; holeLeft: number; holeStart: number; holeGap: number; zoom: number; panOffset: { x: number; y: number }; panMode: boolean; selectedImageId?: string; onSelectImage: (id: string) => void }

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

function bounds(item: PackedImpositionItem, rotation: number) {
  const angle = rotation * Math.PI / 180
  const width = Math.abs(Math.cos(angle)) * item.width + Math.abs(Math.sin(angle)) * item.height
  const height = Math.abs(Math.sin(angle)) * item.width + Math.abs(Math.cos(angle)) * item.height
  return { left: item.x - (width - item.width) / 2, top: item.y - (height - item.height) / 2, right: item.x + item.width + (width - item.width) / 2, bottom: item.y + item.height + (height - item.height) / 2 }
}
function overlaps(left: PackedImpositionItem, leftRotation: number, right: PackedImpositionItem, rightRotation: number) {
  const a = bounds(left, leftRotation); const b = bounds(right, rightRotation)
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function CanvasImage({ item, source, scale, onSelect, onCommit, nodeRef }: { item: PackedImpositionItem; source?: string; scale: number; onSelect: () => void; onCommit: (x: number, y: number, rotation: number) => void; nodeRef: (node: Konva.Image | null) => void }) {
  const image = useSourceImage(source)
  return <KonvaImage ref={nodeRef} image={image} x={(item.x + item.width / 2) * scale} y={(item.y + item.height / 2) * scale} width={item.width * scale} height={item.height * scale} offsetX={item.width * scale / 2} offsetY={item.height * scale / 2} draggable onClick={event => { event.cancelBubble = true; onSelect() }} onDragEnd={event => onCommit(event.target.x() / scale - item.width / 2, event.target.y() / scale - item.height / 2, event.target.rotation())} onTransformEnd={event => onCommit(event.target.x() / scale - item.width / 2, event.target.y() / scale - item.height / 2, event.target.rotation())} opacity={image ? 1 : .35} />
}

export default function ImpositionKonvaCanvas(props: Props) {
  const { pages, imageSources, boardWidth, boardHeight, boardScale, effectiveX, effectiveY, effectiveWidth, effectiveHeight, holeCount, holeSize, holeLeft, holeStart, holeGap, zoom, panOffset, panMode, selectedImageId, onSelectImage } = props
  const [localPages, setLocalPages] = useState(pages)
  const nodeRefs = useRef<Record<string, Konva.Image | null>>({})
  const transformerRef = useRef<Konva.Transformer>(null)
  useEffect(() => setLocalPages(pages), [pages])
  useEffect(() => {
    const node = selectedImageId ? nodeRefs.current[selectedImageId] : null
    if (node && transformerRef.current) transformerRef.current.nodes([node])
    else transformerRef.current?.nodes([])
  }, [selectedImageId, localPages])
  const gap = 24
  const pageWidth = boardWidth * boardScale
  const pageHeight = boardHeight * boardScale
  const columns = 4
  const rows = Math.max(1, Math.ceil(localPages.length / columns))
  const stageWidth = columns * pageWidth + (columns - 1) * gap
  const stageHeight = rows * pageHeight + (rows - 1) * gap
  const handleCommit = (pageIndex: number, item: PackedImpositionItem, x: number, y: number, rotation: number) => {
    const next = { ...item, x: Math.max(0, x), y: Math.max(0, y) }
    const page = localPages[pageIndex] ?? []
    const collision = page.some(other => other.image.id !== item.image.id && overlaps(next, rotation, other, 0))
    if (collision) return
    setLocalPages(current => current.map((items, index) => index === pageIndex ? items.map(candidate => candidate.image.id === item.image.id ? next : candidate) : items))
  }
  const selectedNode = selectedImageId ? nodeRefs.current[selectedImageId] : null
  return <Stage width={stageWidth} height={stageHeight} scaleX={zoom} scaleY={zoom} x={panOffset.x} y={panOffset.y} listening={!panMode} className="imposition-konva-stage"><Layer>
    {localPages.map((page, pageIndex) => { const pageX = (pageIndex % columns) * (pageWidth + gap); const pageY = Math.floor(pageIndex / columns) * (pageHeight + gap); return <Group key={pageIndex} x={pageX} y={pageY}>
      <Rect width={pageWidth} height={pageHeight} fill="#fff" stroke="#cbd5e1" strokeWidth={1}/>
      <Rect x={effectiveX * boardScale} y={effectiveY * boardScale} width={effectiveWidth * boardScale} height={effectiveHeight * boardScale} stroke="#ef4444" dash={[2 * boardScale, 2 * boardScale]} strokeWidth={.8} listening={false}/>
      {Array.from({ length: Math.max(0, holeCount) }).map((_, index) => <Circle key={index} x={(holeLeft + holeSize / 2) * boardScale} y={(holeStart + index * holeGap + holeSize / 2) * boardScale} radius={holeSize * boardScale / 2} fill="#2563eb" listening={false}/>) }
      {page.map(item => <CanvasImage key={item.image.id} item={item} source={imageSources[item.image.id]} scale={boardScale} onSelect={() => onSelectImage(item.image.id)} onCommit={(x, y, rotation) => handleCommit(pageIndex, item, x, y, rotation)} nodeRef={node => { nodeRefs.current[item.image.id] = node }}/>) }
    </Group> })}
    <Transformer ref={transformerRef} resizeEnabled={false} rotateEnabled={!panMode} rotateAnchorOffset={22} borderStroke="#2563eb" visible={Boolean(selectedNode)} />
  </Layer></Stage>
}
