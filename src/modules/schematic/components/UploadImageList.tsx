import { useMemo, useRef, useState } from 'react'
import { Button, Modal, Popconfirm, Tag } from 'antd'
import type { Asset } from '../../../model'
import { svgDataUrl } from '../../../model'
import LazySvgImage from './LazySvgImage'
import type { ProductConfig } from '../services/productConfigService'
import { useProductGroup } from '../grouping/useProductGrouping'
import { canSelectGroupAsset } from '../grouping/productGroupSelection'
import { orderAssetsByProductGroup } from '../services/productGroupOrdering'
import UploadImageGrid from './UploadImageGrid'
import { Trash2 } from 'lucide-react'

export default function UploadImageList({ assets, allAssets, selectedIds, onSelectionChange, products, disabled, onDelete }: {
  assets: Asset[]; allAssets: Asset[]; selectedIds: Set<string>; onSelectionChange: (ids: Set<string>) => void; products: ProductConfig[]; disabled: boolean; onDelete: (asset: Asset) => Promise<void>
}) {
  const anchor = useRef<string | null>(null)
  const grouping = useProductGroup()
  const session = grouping?.session
  const orderedAllAssets = useMemo(() => orderAssetsByProductGroup(allAssets), [allAssets])
  const orderedAssets = useMemo(() => {
    const visibleIds = new Set(assets.map(asset => asset.id))
    return orderedAllAssets.filter(asset => visibleIds.has(asset.id))
  }, [assets, orderedAllAssets])
  const groups = [...new Set(orderedAllAssets.map(asset => asset.productGroupId).filter(Boolean))]
  const [preview, setPreview] = useState<{ name: string; src: string } | null>(null)
  const select = (asset: Asset, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (disabled) return
    if (session) { if (canSelectGroupAsset(asset, session.memberIds, 'list', session.trigger.kind === 'free')) grouping!.selectMember(asset.id); return }
    const next = new Set(event.ctrlKey || event.metaKey || event.shiftKey ? selectedIds : [])
    const anchorIndex = orderedAssets.findIndex(item => item.id === anchor.current)
    if (event.shiftKey && anchorIndex >= 0) {
      const index = orderedAssets.indexOf(asset)
      orderedAssets.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1).forEach(item => next.add(item.id))
    } else if ((event.ctrlKey || event.metaKey) && next.has(asset.id)) next.delete(asset.id)
    else next.add(asset.id)
    anchor.current = asset.id
    onSelectionChange(next)
  }
  return <><div className={`upload-image-grid ${session ? 'is-grouping' : ''}`} aria-label="图片卡片列表">
    <UploadImageGrid assets={orderedAssets} renderAsset={asset => {
      const accessoryImage = asset.attributeImages?.['Accessories Color']?.trim()
      const member = session?.memberIds.includes(asset.id)
      const blocked = Boolean(session && !canSelectGroupAsset(asset, session.memberIds, 'list', session.trigger.kind === 'free'))
      return <article key={asset.id} data-asset-id={asset.id} data-product-group={asset.productGroupId || undefined} style={{ backgroundColor: blocked ? undefined : asset.productGroupId ? asset.productGroupColor : undefined }} className={`upload-image-card ${selectedIds.has(asset.id) ? 'is-selected' : ''} ${session ? blocked ? 'is-guide-blocked' : member ? 'is-guide-member' : 'is-guide-dimmed' : ''}`} onMouseDown={event => { if (event.shiftKey) event.preventDefault() }} onClick={event => select(asset, event)}>
      <div className="upload-image-card-head"><label onClick={event => event.stopPropagation()}><input type="checkbox" checked={selectedIds.has(asset.id)} disabled={disabled || blocked} aria-label={`选择 ${asset.name}`} onChange={() => {}} onClick={event => select(asset, event)}/><span>NO: {orderedAllAssets.indexOf(asset) + 1}</span></label><span className="upload-image-card-actions" onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}><Tag color={asset.attributesConfirmed ? session ? 'red' : 'blue' : 'default'} title={blocked ? '已选产品，不能加入当前组' : undefined}>{asset.attributesConfirmed ? '已选产品' : '未选产品'}</Tag><Popconfirm title="删除这张图片？" description="删除后将从当前批次中移除，无法在列表中恢复。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => onDelete(asset)}><Button type="text" danger size="small" icon={<Trash2 size={14}/>} aria-label={`删除 ${asset.name}`} title="删除图片" disabled={disabled || Boolean(session)} onClick={event => event.stopPropagation()}/></Popconfirm></span></div>
      <div className="upload-image-card-media">
        <button type="button" className="upload-image-art" aria-label={`预览 ${asset.name}`} onClick={event => { event.stopPropagation(); setPreview({ name: asset.name, src: svgDataUrl(asset.svg) }) }}><LazySvgImage svg={asset.svg} alt={asset.name}/></button>
        {accessoryImage && <button type="button" className="card-accessory-preview" aria-label={`预览配件颜色 ${asset.name}`} onClick={event => { event.stopPropagation(); setPreview({ name: `${asset.name} · 配件颜色`, src: accessoryImage }) }}><img src={accessoryImage} alt={`${asset.name} · 配件颜色`} loading="lazy" decoding="async"/></button>}
      </div>
      <div className="upload-image-card-info"><strong>{asset.name}</strong>
        {asset.productGroupId && <Tag className="product-group-badge">产品组 {groups.indexOf(asset.productGroupId) + 1}</Tag>}
        <span>产品：{products.find(product => product.id === asset.productId)?.title || asset.productName || '未选择产品'}</span>
        <span className="card-physical-size">真实尺寸：{Number.isFinite(asset.sourceGroupWidthMm) && Number.isFinite(asset.sourceGroupHeightMm) && asset.sourceGroupWidthMm! > 0 && asset.sourceGroupHeightMm! > 0
          ? `${asset.sourceGroupWidthMm!.toFixed(3)} × ${asset.sourceGroupHeightMm!.toFixed(3)} mm`
          : '未记录'}</span>
        {Object.entries(asset.attributes ?? {}).filter(([, value]) => value).map(([key, value]) => <span key={key}>{products.find(product => product.id === asset.productId)?.options.find(option => option.name === key)?.label || key}：{value}</span>)}
        {asset.note && <span className="card-note">备注：{asset.note}</span>}
        {asset.noteImage && <button type="button" className="card-note-preview" aria-label={`预览备注 ${asset.name}`} onClick={event => { event.stopPropagation(); setPreview({ name: `${asset.name} · 备注`, src: asset.noteImage! }) }}><img src={asset.noteImage} alt="备注图片" loading="lazy"/></button>}
      </div>
    </article>}}/>
    {!assets.length && <p>该分类暂无图片</p>}
  </div><Modal open={Boolean(preview)} footer={null} title={preview?.name} onCancel={() => setPreview(null)} centered><img className="asset-full-preview" src={preview?.src} alt={preview?.name}/></Modal></>
}
