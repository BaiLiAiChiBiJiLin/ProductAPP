import PoolAssetCard from './PoolAssetCard'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from 'antd'
import { svgDataUrl, type Asset, type Page } from '../../../model'
import LazySvgImage from './LazySvgImage'
import useProductConfigs from '../hooks/useProductConfigs'

type PoolTab = 'all' | 'unused'
type Props = { assets: Asset[]; pages?: Page[]; onAddAsset?: (assetId: string) => void; onRemoveAsset?: (assetId: string) => void; mode?: 'upload' | 'arrange'; selectedIds?: Set<string>; onSelectionChange?: (ids: Set<string>) => void }

export default function AssetPool({ assets, pages = [], onAddAsset, mode = 'upload', selectedIds: controlledSelectedIds, onSelectionChange }: Props) {
  const [preview, setPreview] = useState<Asset | null>(null)
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<string>>(new Set())
  const selectedIds = controlledSelectedIds ?? internalSelectedIds
  const lastSelectedIndex = useRef<number | null>(null)
  const [tab, setTab] = useState<PoolTab>('unused')
  const [product, setProduct] = useState('')
  const productStripRef = useRef<HTMLDivElement>(null)
  const usedIds = useMemo(() => new Set(pages.flatMap(page => page.items.map(item => item.assetId))), [pages])
  const products = useMemo(() => Array.from(new Set(assets.map(asset => asset.productId))), [assets])
  const { products: productConfigs, loading: productConfigsLoading } = useProductConfigs()
  const productNames = useMemo(() => new Map(productConfigs.map(config => [config.id, config.title])), [productConfigs])
  const activeProduct = products.includes(product) ? product : products[0]
  const productAssets = useMemo(() => assets.filter(asset => asset.productId === activeProduct), [assets, activeProduct])
  const visible = useMemo(() => productAssets.filter(asset => tab === 'all' || !usedIds.has(asset.id)), [productAssets, tab, usedIds])
  useEffect(() => {
    const element = productStripRef.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || element.scrollWidth <= element.clientWidth) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const atStart = element.scrollLeft <= 0 && delta < 0
      const atEnd = element.scrollLeft >= element.scrollWidth - element.clientWidth - 1 && delta > 0
      if (atStart || atEnd) return
      event.preventDefault()
      element.scrollLeft += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [mode])
  const productLabel = (asset: Asset) => productNames.get(asset.productId)
    || (asset.productName?.trim() && asset.productName !== asset.productId ? asset.productName : '')
    || (asset.productId === 'a' || !asset.productId ? '未选择产品' : productConfigsLoading ? '加载中…' : '产品配置不可用')
  const handleSelection = (index: number, event: React.MouseEvent<HTMLElement>) => {
    const id = assets[index]?.id
    if (!id) return
    const additive = event.ctrlKey || event.metaKey
    const next = new Set(event.shiftKey || additive ? selectedIds : [])
    if (event.shiftKey && lastSelectedIndex.current !== null) {
      const start = Math.min(lastSelectedIndex.current, index)
      const end = Math.max(lastSelectedIndex.current, index)
      assets.slice(start, end + 1).forEach(asset => next.add(asset.id))
    } else if (additive) {
      if (next.has(id)) next.delete(id); else next.add(id)
    } else {
      next.add(id)
    }
    onSelectionChange?.(next)
    if (!onSelectionChange) setInternalSelectedIds(next)
    lastSelectedIndex.current = index
  }
  if (mode === 'upload') return <><div className="uploaded-assets-list">{assets.map((asset, index) => <div className={`uploaded-asset ${selectedIds.has(asset.id) ? 'is-selected' : ''}`} key={asset.id} onClick={event => { if (!(event.target as HTMLElement).closest('input, img')) handleSelection(index, event) }}><span className="uploaded-asset-number">NO: {index + 1}</span><input type="checkbox" className="uploaded-asset-select" checked={selectedIds.has(asset.id)} aria-label={`选择 ${asset.name}`} onChange={() => undefined} onClick={event => { event.stopPropagation(); handleSelection(index, event) }} /><LazySvgImage svg={asset.svg} alt={asset.name} onClick={() => setPreview(asset)} title="点击预览"/><div className="uploaded-asset-info"><strong>{asset.name}</strong><span className="uploaded-asset-product" title={productLabel(asset)}>产品：{productLabel(asset)}</span>{asset.attributes && Object.entries(asset.attributes).filter(([, value]) => value).map(([key, value]) => <span key={key}>{key}：{value}</span>)}{asset.note && <span className="uploaded-asset-note" title={asset.note}>备注：{asset.note}</span>}{asset.noteImage && <img className="uploaded-asset-note-image" src={asset.noteImage} alt="备注图片" title="备注图片" onClick={event => { event.stopPropagation(); setPreview(asset) }} />}</div></div>)}</div><Modal open={Boolean(preview)} footer={null} title={preview?.name} onCancel={() => setPreview(null)} centered><img className="asset-full-preview" src={preview ? svgDataUrl(preview.svg) : undefined} alt={preview?.name ?? ''}/></Modal></>
  return <div className="pool">
    <div className="section-heading"><span>图片池</span><span className="pool-count">{assets.length}</span></div>
    <div ref={productStripRef} className="product-switch product-category-strip" aria-label="产品分类">{products.map(id => {
      const label = productNames.get(id) || assets.find(asset => asset.productId === id)?.productName || (id === 'a' || !id ? '未选择产品' : id)
      return <button key={id} type="button" aria-pressed={activeProduct === id} title={label} className={activeProduct === id ? 'active' : ''} onClick={() => setProduct(id)} onFocus={event => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}>{label}</button>
    })}</div>
    <div className="pool-tabs" role="tablist"><button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>全部 {productAssets.length}</button><button className={tab === 'unused' ? 'active' : ''} onClick={() => setTab('unused')}>未使用 {productAssets.filter(asset => !usedIds.has(asset.id)).length}</button></div>
    <p className="pool-help">未使用图片双击或拖入画布；右上角放大镜预览；画布选组按 Delete 移回图片池。</p>
    <div className="asset-grid">
      {visible.map(asset => <PoolAssetCard key={asset.id} asset={asset} used={usedIds.has(asset.id)} onAdd={onAddAsset} onPreview={() => setPreview(asset)}/>)}
      {!visible.length && <div className="pool-empty">当前筛选没有图片</div>}
    </div>
    <Modal open={Boolean(preview)} footer={null} title={preview?.name} onCancel={() => setPreview(null)} centered><img className="asset-full-preview" src={preview ? svgDataUrl(preview.svg) : undefined} alt={preview?.name ?? ''}/></Modal>
  </div>
}
