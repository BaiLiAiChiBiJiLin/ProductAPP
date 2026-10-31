import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Dropdown } from 'antd'
import { Check, ImageUp, Layers } from 'lucide-react'
import type { Asset, Item } from '../../../model'
import { selectSvgLayer, selectSvgLayers, svgLayers, withWindowLayerOverlay } from '../services/svgLayerService'
import './artwork-context-menu.css'

export type ArtworkMenuTarget = { itemId: string; x: number; y: number }

function SvgLayerThumbnail({ svg, layerId }: { svg: string; layerId: string }) {
  const imageRef = useRef<HTMLImageElement>(null)
  const [preview, setPreview] = useState<{ svg: string; layerId: string; url: string }>()
  useEffect(() => {
    const image = imageRef.current
    if (!image) return
    let url: string | undefined
    const load = () => {
      if (url) return
      const artwork = layerId === 'all' ? svg : selectSvgLayer(svg, layerId)
      url = URL.createObjectURL(new Blob([artwork], { type: 'image/svg+xml' }))
      setPreview({ svg, layerId, url })
    }
    // Large SVGs can contain many embedded images. Build only visible previews
    // and release them with the menu instead of retaining them in the asset cache.
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { load(); observer?.disconnect() }
    }, { rootMargin: '80px' })
    if (observer) observer.observe(image)
    else load()
    return () => { observer?.disconnect(); if (url) URL.revokeObjectURL(url) }
  }, [svg, layerId])
  const src = preview?.svg === svg && preview.layerId === layerId ? preview.url : undefined
  return <img ref={imageRef} className="artwork-layer-thumbnail" data-layer-id={layerId} src={src} alt="" draggable={false} decoding="async" />
}

export default function ArtworkContextMenu({ target, item, asset, onClose, onChange, onReplace, onHorizontal }: {
  target: ArtworkMenuTarget; item: Item; asset: Asset; onClose: () => void
  onHorizontal?: (itemId: string) => void; onChange: (item: Item) => void; onReplace?: (itemId: string) => Promise<void>
}) {
  // Enumerate only when the user opens the menu, always against the original
  // document so switching one layer never discards the other choices.
  const layers = useMemo(() => svgLayers(asset.svg, asset.sourceImages), [asset.svg, asset.sourceImages])
  const [draft, setDraft] = useState<{ itemId: string; svg: string; ids: string[] }>()
  const savedIds = item.svgLayerIds ?? (item.svgLayerId ? [item.svgLayerId] : item.backSvg ? [] : ['all'])
  const selectedIds = (draft?.itemId === item.id && draft.svg === asset.svg ? draft.ids : savedIds)
    .filter(id => id === 'all' || layers.some(layer => layer.id === id))
  const withWindow = (ids: readonly string[]) => withWindowLayerOverlay(layers, ids, asset.sourceImages)
  const confirm = () => {
    if (!selectedIds.length) return
    const all = selectedIds.includes('all')
    // Keep source order regardless of the order in which layers were checked.
    const ids = withWindow(layers.filter(layer => selectedIds.includes(layer.id)).map(layer => layer.id))
    onChange({
      ...item,
      svgLayerIds: all ? undefined : ids,
      svgLayerId: all ? 'all' : ids.length === 1 ? ids[0] : undefined,
      backSvg: all ? asset.svg : selectSvgLayers(asset.svg, ids),
    })
    onClose()
  }
  const layerOption = (id: string, label: string) => ({
    key: `layer:${id}`,
    label: <span className="artwork-layer-option" title={label}>
      <SvgLayerThumbnail svg={asset.svg} layerId={id}/>
      <span className="artwork-layer-name">{label}</span>
      {selectedIds.includes(id) && <Check className="artwork-layer-selected" size={16} aria-hidden="true"/>}
    </span>,
  })
  // The workspace's entrance animation creates a transformed containing block.
  // Anchor to the document so client coordinates stay aligned with the pointer.
  return createPortal(<Dropdown open placement="bottomLeft" trigger={['contextMenu']} onOpenChange={(open, info) => { if (!open && info.source === 'trigger') onClose() }}
    menu={{
      triggerSubMenuAction: 'click',
      selectable: true,
      multiple: true,
      selectedKeys: selectedIds.map(id => `layer:${id}`),
      items: [
        { key: 'layers', label: '切换图层', icon: <Layers size={14}/>, popupClassName: 'artwork-layer-submenu', children: [
          layerOption('all', '全部图层'),
          ...layers.map(layer => layerOption(layer.id, layer.label)),
          { type: 'group', key: 'layer-actions', className: 'artwork-layer-actions', label: <Button type="primary" aria-label="确认" disabled={!selectedIds.length} onClick={confirm}>确认</Button> },
        ] },
        { key: 'horizontal', label: '横排', disabled: !onHorizontal },
        { key: 'replace', label: '更换图片', icon: <ImageUp size={14}/>, disabled: !onReplace },
      ],
      onClick: ({ key }) => {
        if (key === 'horizontal') { onClose(); onHorizontal?.(item.id); return }
        if (key === 'replace') { onClose(); void onReplace?.(item.id); return }
        if (!key.startsWith('layer:')) return
        const layerId = key.slice('layer:'.length)
        const ids = layerId === 'all' ? ['all'] : selectedIds.includes(layerId)
          ? selectedIds.filter(id => id !== layerId)
          : [...selectedIds.filter(id => id !== 'all'), layerId]
        setDraft({ itemId: item.id, svg: asset.svg, ids: withWindow(ids) })
      },
    }}>
    <span aria-hidden style={{ position: 'fixed', left: target.x, top: target.y, width: 1, height: 1, pointerEvents: 'none' }}/>
  </Dropdown>, document.body)
}
