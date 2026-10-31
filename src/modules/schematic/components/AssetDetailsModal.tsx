import { Descriptions, Modal, Tag } from 'antd'
import type { Asset } from '../../../model'
import type { ProductConfig } from '../services/productConfigService'
import './asset-details.css'
import { getNoteImages } from '../services/assetNotesService'

type Props = { asset: Asset | null; products: ProductConfig[]; onClose: () => void }
type LayerRole = 'front' | 'window' | 'back'

const layerRoleLabels: Record<LayerRole, string> = { front: '正面', window: '彩窗', back: '背面' }
const layerRoleColors: Record<LayerRole, string> = { front: 'blue', window: 'cyan', back: 'purple' }
const isLayerRole = (value: string | undefined): value is LayerRole => value === 'front' || value === 'window' || value === 'back'
const inferredSourceImageRole = (value: string | undefined, index: number, count: number): LayerRole | undefined => {
  if (isLayerRole(value)) return value
  if (count === 1) return 'front'
  if (count === 2) return index === 0 ? 'back' : index === 1 ? 'front' : undefined
  if (count === 3) return index === 0 ? 'back' : index === 1 ? 'window' : index === 2 ? 'front' : undefined
  return undefined
}

/** Read only: never parse the SVG or serialize its embedded image data. */
export default function AssetDetailsModal({ asset, products, onClose }: Props) {
  if (!asset) return null
  const product = products.find(item => item.id === asset.productId)
  const width = asset.sourceGroupWidthMm
  const height = asset.sourceGroupHeightMm
  const physicalSize = width && height && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? `${width.toFixed(3)} × ${height.toFixed(3)} mm` : '未记录'
  const attributeLabel = (key: string) => product?.options.find(option => option.name === key)?.label || key
  const attributes = Object.entries(asset.attributes ?? {})
  const attributeImages = Object.entries(asset.attributeImages ?? {}).filter(([, url]) => url)
  const noteImages = getNoteImages(asset)
  const sourceImages = asset.sourceImages ?? []
  const roleKeys = [asset.sourceLayerRole, ...sourceImages.map((image, index) => inferredSourceImageRole(image.layerRole, index, sourceImages.length))]
    .filter((value, index, values): value is LayerRole => isLayerRole(value) && values.indexOf(value) === index)
  const roleTags = roleKeys.length ? roleKeys.map(role => <Tag key={role} color={layerRoleColors[role]}>{layerRoleLabels[role]}</Tag>) : '未标记'

  return <Modal open title="图片资产详情" onCancel={onClose} footer={null} centered width={760} className="asset-details-modal">
    <Descriptions bordered size="small" column={1} items={[
      { key: 'name', label: '图片名称', children: asset.name },
      { key: 'id', label: '资产 ID', children: asset.id },
      { key: 'source', label: '来源文件', children: asset.sourceFileName || '未记录' },
      { key: 'path', label: 'SVG 保存位置', children: asset.storagePath || '尚未写入文件' },
      { key: 'size', label: '真实尺寸（宽 × 高）', children: physicalSize },
      { key: 'layer-role', label: '图层标记', children: roleTags },
      { key: 'product', label: '产品', children: product?.title || asset.productName || '未选择产品' },
      { key: 'status', label: '产品状态', children: <Tag color={asset.attributesConfirmed ? 'blue' : undefined}>{asset.attributesConfirmed ? '已选产品' : '未选产品'}</Tag> },
      ...(asset.productGroupId ? [
        { key: 'group', label: '产品组 ID', children: asset.productGroupId },
        { key: 'position', label: '组内顺序', children: String(asset.productGroupPosition || '未记录') },
      ] : []),
    ]}/>
    <section aria-label="图片尺寸（SVG 内）">
      <h3>图片尺寸（SVG 内）</h3>
      <p>按每张图片在原始 SVG 中的缩放和父级变换计算，单位为 mm；表示完整图片的宽高，不是裁剪后的可见范围。</p>
      {asset.sourceImages == null ? <p>此资产未记录图片尺寸，重新导入后会记录。</p>
        : asset.sourceImages.length === 0 ? <p>此资产未发现位图，无独立图片尺寸。</p>
        : <div className="asset-details-table-scroll"><table className="asset-details-image-table">
          <thead><tr><th>序号</th><th>图片图层 ID</th><th>格式</th><th>图层标记</th><th>宽 × 高（mm）</th></tr></thead>
          <tbody>{sourceImages.map((image, index) => <tr key={index}>
            <td>{index + 1}</td><td>{image.nodeId || '无 ID'}</td><td>{image.format}</td><td>{inferredSourceImageRole(image.layerRole, index, sourceImages.length) ? <Tag color={layerRoleColors[inferredSourceImageRole(image.layerRole, index, sourceImages.length)!]}>{layerRoleLabels[inferredSourceImageRole(image.layerRole, index, sourceImages.length)!]}</Tag> : '未标记'}</td><td>{image.widthMm && image.heightMm && Number.isFinite(image.widthMm) && Number.isFinite(image.heightMm) && image.widthMm > 0 && image.heightMm > 0
              ? `${image.widthMm.toFixed(3)} × ${image.heightMm.toFixed(3)} mm`
              : '未记录毫米尺寸，请重新导入'}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    <section aria-label="已保存产品属性"><h3>已保存产品属性</h3>
      {attributes.length ? <Descriptions bordered size="small" column={1} items={attributes.map(([key, value]) => ({ key, label: attributeLabel(key), children: value || '未填写' }))}/> : <p>暂无产品属性</p>}
      {attributeImages.length > 0 && <div className="asset-details-attachments">{attributeImages.map(([key, url]) => <figure key={key}><img src={url} alt={attributeLabel(key)} loading="lazy"/><figcaption>{attributeLabel(key)}</figcaption></figure>)}</div>}
    </section>
    {(asset.note || noteImages.length > 0) && <section aria-label="资产备注"><h3>备注</h3><p className="asset-details-note">{asset.note}</p><div className="asset-details-note-images">{noteImages.map((image, index) => <figure key={index}><img className="asset-details-note-image" src={image.src} alt={image.name || `备注图片 ${index + 1}`} loading="lazy"/>{image.name && <figcaption>{image.name}</figcaption>}</figure>)}</div></section>}
  </Modal>
}
