import { Button, Checkbox, Modal } from 'antd'
import type { Asset } from '../../../model'
import LazySvgImage from './LazySvgImage'
import './review-asset-picker.css'
import { toggleReviewAssetSelection } from '../services/reviewAssetSelection'

type Props = {
  open: boolean
  assets: Asset[]
  selectedIds: Set<string>
  confirming: boolean
  onChange: (ids: Set<string>) => void
  onCancel: () => void
  onConfirm: () => void
}

/** A visual-only asset picker shown immediately before production layout. */
export default function ReviewAssetPicker({ open, assets, selectedIds, confirming, onChange, onCancel, onConfirm }: Props) {
  const groupNumbers = new Map<string, number>()
  for (const asset of assets) {
    if (asset.productGroupId && !groupNumbers.has(asset.productGroupId)) groupNumbers.set(asset.productGroupId, groupNumbers.size + 1)
  }
  const groupLabel = (asset: Asset) => asset.productGroupId ? `产品组 ${groupNumbers.get(asset.productGroupId) ?? ''}` : ''
  const allSelected = assets.length > 0 && assets.every(asset => selectedIds.has(asset.id))
  const toggleAll = () => onChange(allSelected ? new Set() : new Set(assets.map(asset => asset.id)))
  const toggle = (id: string) => onChange(toggleReviewAssetSelection(assets, selectedIds, id))
  return <Modal
    className="review-asset-picker-modal"
    title="图片池"
    open={open}
    onCancel={onCancel}
    footer={<div className="review-asset-picker-footer"><Button onClick={toggleAll} disabled={confirming}>{allSelected ? '取消全选' : '全选'}</Button><span>已选 {selectedIds.size} / {assets.length}</span><Button onClick={onCancel} disabled={confirming}>返回调整</Button><Button type="primary" loading={confirming} disabled={!selectedIds.size || confirming} onClick={onConfirm}>确认并生成</Button></div>}
    destroyOnHidden
  >
    <div className="review-asset-picker-toolbar"><span>请选择要进入示意图排列的图片</span><Button type="link" onClick={toggleAll} disabled={confirming}>{allSelected ? '取消全选' : '全选'}</Button></div>
    <div className="review-asset-picker-grid" role="list" aria-label="图片池">
      {assets.map(asset => <button key={asset.id} type="button" role="listitem" data-product-group={asset.productGroupId || undefined} className={`review-asset-picker-item ${selectedIds.has(asset.id) ? 'is-selected' : ''} ${asset.productGroupId ? 'has-product-group' : ''}`} aria-label={`选择 ${asset.name}${asset.productGroupId ? `（${groupLabel(asset)}）` : ''}`} aria-pressed={selectedIds.has(asset.id)} onClick={() => toggle(asset.id)} disabled={confirming} title={asset.productGroupId ? `${asset.name} · ${groupLabel(asset)}` : asset.name} style={asset.productGroupColor ? { backgroundColor: asset.productGroupColor } : undefined}>
        <LazySvgImage svg={asset.svg} alt={asset.name}/>
        <span className="review-asset-picker-check" aria-hidden="true"><Checkbox checked={selectedIds.has(asset.id)} tabIndex={-1}/></span>
        {asset.productGroupId && <span className="review-asset-picker-group-mark" aria-hidden="true">{groupLabel(asset)}</span>}
      </button>)}
    </div>
  </Modal>
}
