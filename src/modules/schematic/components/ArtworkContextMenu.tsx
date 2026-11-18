import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Dropdown } from 'antd'
import { Check, FlipHorizontal2, ImageUp, Layers } from 'lucide-react'
import type { Asset, Item } from '../../../model'
import { selectSvgLayer, selectSvgLayers, svgLayerPlan, svgLayers, withWindowLayerOverlay } from '../services/svgLayerService'
import { loadAssetPreview } from '../services/assetPreviewService'
import { artworkGeometrySvg, hasInlineArtwork } from '../services/artworkSourceService'
import { loadArtworkLayers, type ArtworkLayerDocument } from '../services/artworkLayerService'
import './artwork-context-menu.css'

export type ArtworkMenuTarget = { itemId: string; x: number; y: number }

function SvgLayerThumbnail({ svg, layerId, asset, batchId, version }: { svg: string; layerId: string; asset: Asset; batchId?: string; version?: string }) {
  const imageRef = useRef<HTMLImageElement>(null)
  const identity = version ?? svg
  const [preview, setPreview] = useState<{ identity: string; layerId: string; url: string }>()
  useEffect(() => {
    const image = imageRef.current
    if (!image) return
    const controller = new AbortController()
    let started = false
    const load = () => {
      if (started) return
      started = true
      const artwork = version ? { ...asset, layerIds: [layerId], artworkVariant: { layers: { version, ...svgLayerPlan(svg, layerId === 'all' ? [] : [layerId]) } } }
        : { id: '', svg: layerId === 'all' ? svg : selectSvgLayer(svg, layerId), sourceSvg: svg, layerIds: [layerId] }
      void loadAssetPreview(artwork, version ? batchId : undefined, 128, controller.signal,
        () => ({ visible: true, canvas: true, interactive: true }), true).then(url => {
        if (!controller.signal.aborted) setPreview({ identity, layerId, url })
      }).catch(error => { if (error?.name !== 'AbortError') console.warn('图层预览生成失败', error) })
    }
    // Generate only visible layers; the shared cache retains bounded PNGs.
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { load(); observer?.disconnect() }
    }, { rootMargin: '80px' })
    if (observer) observer.observe(image)
    else load()
    return () => { observer?.disconnect(); controller.abort() }
  }, [svg, identity, layerId, asset.id, asset.svg, asset.storagePath, batchId, version])
  const src = preview?.identity === identity && preview.layerId === layerId ? preview.url : undefined
  return <img ref={imageRef} className="artwork-layer-thumbnail" data-layer-id={layerId} src={src} alt="" draggable={false} decoding="async" />
}

export default function ArtworkContextMenu({ target, item, asset, batchId, onClose, onChange, onReplace, onHorizontal, onShowBack }: {
  target: ArtworkMenuTarget; item: Item; asset: Asset; onClose: () => void
  batchId?: string
  onHorizontal?: (itemId: string) => void; onChange: (item: Item) => void; onReplace?: (itemId: string) => Promise<void>
  onShowBack?: (itemId: string, svg?: string, version?: string) => void
}) {
  const [loaded, setLoaded] = useState<{ id: string; source: string; path?: string; batchId?: string; document: ArtworkLayerDocument }>()
  const [loadError, setLoadError] = useState(false)
  const [retry, setRetry] = useState(0)
  const inline = hasInlineArtwork(asset.svg) && asset.svg.length <= 256 * 1024
  const layerDocument = loaded?.id === asset.id && loaded.source === asset.svg && loaded.path === asset.storagePath && loaded.batchId === batchId ? loaded.document : undefined
  const originalSvg = inline ? asset.svg : layerDocument?.svg ?? ''
  const version = inline ? undefined : layerDocument?.version
  useEffect(() => {
    if (inline) return
    let cancelled = false
    setLoadError(false)
    void loadArtworkLayers(asset, batchId).then(document => {
      if (!cancelled) setLoaded({ id: asset.id, source: asset.svg, path: asset.storagePath, batchId, document })
    }).catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
  }, [asset.id, asset.svg, asset.storagePath, batchId, retry, inline])
  // Enumerate only when the user opens the menu, always against the original
  // document so switching one layer never discards the other choices.
  const layers = useMemo(() => svgLayers(originalSvg, asset.sourceImages), [originalSvg, asset.sourceImages])
  const [draft, setDraft] = useState<{ itemId: string; svg: string; ids: string[] }>()
  const savedIds = item.svgLayerIds ?? (item.svgLayerId ? [item.svgLayerId] : item.backSvg || item.artworkVariant ? [] : ['all'])
  const selectedIds = (draft?.itemId === item.id && draft.svg === originalSvg ? draft.ids : savedIds)
    .filter(id => id === 'all' || layers.some(layer => layer.id === id))
  const withWindow = (ids: readonly string[]) => withWindowLayerOverlay(layers, ids, asset.sourceImages)
  const confirm = () => {
    if (!originalSvg || !selectedIds.length) return
    const all = selectedIds.includes('all')
    // Keep source order regardless of the order in which layers were checked.
    const ids = withWindow(layers.filter(layer => selectedIds.includes(layer.id)).map(layer => layer.id))
    const selectedSvg = all ? originalSvg : selectSvgLayers(originalSvg, ids)
    onChange({
      ...item,
      artworkVariant: !all && version ? { layers: { version, ...svgLayerPlan(originalSvg, ids) } } : undefined,
      geometrySvg: artworkGeometrySvg(selectedSvg),
      svgLayerIds: all ? undefined : ids,
      svgLayerId: all ? 'all' : ids.length === 1 ? ids[0] : undefined,
      backSvg: version ? undefined : all ? hasInlineArtwork(asset.svg) ? originalSvg : undefined : selectedSvg,
    })
    onClose()
  }
  const layerOption = (id: string, label: string) => ({
    key: `layer:${id}`,
    label: <span className="artwork-layer-option" title={label}>
      <SvgLayerThumbnail svg={originalSvg} layerId={id} asset={asset} batchId={batchId} version={version}/>
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
          ...(!originalSvg ? [{ key: 'layer-retry', label: loadError ? '图层读取失败，点击重试' : '正在读取此图片图层…', disabled: !loadError }] : [layerOption('all', '全部图层')]),
          ...layers.map(layer => layerOption(layer.id, layer.label)),
          { type: 'group', key: 'layer-actions', className: 'artwork-layer-actions', label: <Button type="primary" aria-label="确认" disabled={!originalSvg || !selectedIds.length} onClick={confirm}>确认</Button> },
        ] },
        ...(layers.some(layer => layer.role === 'back') ? [{ key: 'show-back', label: '展示背面', icon: <FlipHorizontal2 size={14}/>, disabled: !onShowBack }] : []),
        { key: 'horizontal', label: '横排', disabled: !onHorizontal },
        { key: 'replace', label: '更换图片', icon: <ImageUp size={14}/>, disabled: !onReplace },
      ],
      onClick: ({ key }) => {
        if (key === 'show-back') { onClose(); if (version) onShowBack?.(item.id, originalSvg, version); else onShowBack?.(item.id); return }
        if (key === 'layer-retry') { setRetry(value => value + 1); return }
        if (key === 'horizontal') { onClose(); onHorizontal?.(item.id); return }
        if (key === 'replace') { onClose(); void onReplace?.(item.id); return }
        if (!key.startsWith('layer:')) return
        const layerId = key.slice('layer:'.length)
        const ids = layerId === 'all' ? ['all'] : selectedIds.includes(layerId)
          ? selectedIds.filter(id => id !== layerId)
          : [...selectedIds.filter(id => id !== 'all'), layerId]
        setDraft({ itemId: item.id, svg: originalSvg, ids: withWindow(ids) })
      },
    }}>
    <span aria-hidden style={{ position: 'fixed', left: target.x, top: target.y, width: 1, height: 1, pointerEvents: 'none' }}/>
  </Dropdown>, document.body)
}
