import { memo, useEffect, useRef, useState } from 'react'
import { Stage, Layer, Rect, Group, Image as KonvaImage, Transformer, Text } from 'react-konva'
import type Konva from 'konva'
import { constrain, PAPER_HEIGHT, PAPER_WIDTH, type Asset, type Item, type Page } from './model'

const Artwork = memo(function Artwork({ item, asset, selected, onSelect, onChange }: {
  item: Item; asset: Asset; selected: boolean; onSelect: (id: string | null) => void; onChange: (item: Item) => void
}) {
  const [image, setImage] = useState<HTMLImageElement>()
  const [failed, setFailed] = useState(false)
  const nodeRef = useRef<Konva.Image>(null)
  const transformerRef = useRef<Konva.Transformer>(null)
  useEffect(() => {
    const img = new window.Image()
    let cancelled = false
    img.onload = () => { if (!cancelled) { setImage(img); setFailed(false) } }
    img.onerror = () => { if (!cancelled) setFailed(true) }
    img.src = asset.previewUrl
    return () => { cancelled = true; img.onload = null; img.onerror = null }
  }, [asset.previewUrl])
  useEffect(() => {
    if (selected && nodeRef.current) transformerRef.current?.nodes([nodeRef.current])
  }, [selected, image])
  if (!image) return <Text x={item.x - item.w / 2} y={item.y} width={item.w} text={failed ? '图片加载失败' : '加载图片…'} fontSize={12} fill="#64748b" />
  return <>
    <KonvaImage ref={nodeRef} image={image} x={item.x} y={item.y} width={item.w} height={item.h}
      offsetX={item.w / 2} offsetY={item.h / 2} rotation={item.rotation} draggable
      onClick={() => onSelect(item.id)} onTap={() => onSelect(item.id)} onDragStart={() => onSelect(item.id)}
      onDragEnd={event => { const next = constrain({ ...item, ...event.target.position() }); event.target.position(next); onChange(next) }}
      onTransformEnd={() => {
        const node = nodeRef.current!
        const next = constrain({ ...item, x: node.x(), y: node.y(), rotation: node.rotation() })
        node.position(next)
        onChange(next)
      }} />
    {selected && <Transformer ref={transformerRef} resizeEnabled={false} rotateEnabled rotationSnaps={[0, 90, 180, 270]} borderStroke="#2563eb" />}
  </>
})

export default function ArtworkCanvas({ page, assets, selected, onSelect, onChange, onDropAsset }: {
  page: Page; assets: Map<string, Asset>; selected: string | null; onSelect: (id: string | null) => void
  onChange: (item: Item) => void; onDropAsset: (assetId: string, x: number, y: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  const scale = Math.max(0.01, Math.min((size.width - 48) / PAPER_WIDTH, (size.height - 48) / PAPER_HEIGHT))
  const x = (size.width - PAPER_WIDTH * scale) / 2
  const y = (size.height - PAPER_HEIGHT * scale) / 2
  return <div ref={ref} className="stage-wrap" aria-label="A4 排版画布"
    onDragOver={event => { if (event.dataTransfer.types.includes('application/x-printflow-asset')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
    onDrop={event => {
      event.preventDefault()
      const id = event.dataTransfer.getData('application/x-printflow-asset')
      const bounds = ref.current!.getBoundingClientRect()
      const px = (event.clientX - bounds.left - x) / scale
      const py = (event.clientY - bounds.top - y) / scale
      if (id && px >= 0 && py >= 0 && px <= PAPER_WIDTH && py <= PAPER_HEIGHT) onDropAsset(id, px, py)
    }}>
    {size.width > 0 && size.height > 0 && <Stage width={size.width} height={size.height} onMouseDown={event => { if (event.target === event.target.getStage()) onSelect(null) }}>
      <Layer><Group x={x} y={y} scaleX={scale} scaleY={scale}>
        <Rect width={PAPER_WIDTH} height={PAPER_HEIGHT} fill="white" shadowBlur={12} shadowColor="#0f172a" shadowOpacity={0.1} onClick={() => onSelect(null)} />
        <Group clipX={0} clipY={0} clipWidth={PAPER_WIDTH} clipHeight={PAPER_HEIGHT}>
          {page.items.map(item => { const asset = assets.get(item.assetId); return asset && <Artwork key={item.id} item={item} asset={asset} selected={selected === item.id} onSelect={onSelect} onChange={onChange} /> })}
        </Group>
      </Group></Layer>
    </Stage>}
  </div>
}
