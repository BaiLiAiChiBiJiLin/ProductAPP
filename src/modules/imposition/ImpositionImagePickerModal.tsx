import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { Alert, Button, Checkbox, Empty, Input, InputNumber, Modal, Pagination, Tag } from 'antd'
import { Search } from 'lucide-react'
import type { ProductionImage } from './impositionRecords'
import ImpositionThumbnail from './ImpositionThumbnail'
import Loading from '../../components/Loading'

const EMPTY_IMAGES: ProductionImage[] = []
const gridCapacity = (width: number, height: number) => ({ columns: Math.max(1, Math.floor((width - 6 + 12) / 182)), rows: Math.max(1, Math.floor((height - 6 + 12) / 218)) })

type Props = {
  open: boolean
  title: string
  record?: { images: ProductionImage[] }
  selectedIds: string[]
  disabled?: boolean
  loading?: boolean
  quantitySaving?: boolean
  error?: string
  onRetry: () => void
  issueReason: (image: ProductionImage) => string
  onClose: () => void
  onToggle: (imageId: string, checked: boolean) => void
  onToggleMany: (imageIds: string[], checked: boolean) => void
  onQuantityChange: (image: ProductionImage, value: number) => void
  onQuantityCommit: (image: ProductionImage) => void
  onBatchQuantityCommit: (imageIds: string[], quantity: number) => Promise<void>
  quantityValue: (image: ProductionImage) => number
}

/**
 * Bounded image picker for large production jobs. Pagination keeps the number
 * of mounted thumbnail observers and QT inputs predictable even for thousands
 * of source images; ImpositionThumbnail still lazy-loads each visible preview.
 */
export default function ImpositionImagePickerModal({
  open,
  title,
  record,
  selectedIds,
  disabled = false,
  loading = false,
  quantitySaving = false,
  error,
  onRetry,
  issueReason,
  onClose,
  onToggle,
  onToggleMany,
  onQuantityChange,
  onQuantityCommit,
  onBatchQuantityCommit,
  quantityValue,
}: Props) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [capacity, setCapacity] = useState(() => gridCapacity(Math.min(1180, window.innerWidth * .94) - 48, Math.min(860, window.innerHeight - 40) - 252))
  const [batchQuantity, setBatchQuantity] = useState<number | null>(null)
  const [batchSaving, setBatchSaving] = useState(false)
  const [batchMessage, setBatchMessage] = useState('')
  const [batchError, setBatchError] = useState('')
  const batchLock = useRef(false)
  const anchorId = useRef<string | undefined>(undefined)
  const gridRef = useRef<HTMLDivElement>(null)
  const changePage = (nextPage: number) => setPage(nextPage)
  const images = record?.images ?? EMPTY_IMAGES
  const filtered = useMemo(() => {
    const value = query.trim().toLocaleLowerCase()
    if (!value) return images
    return images.filter(image => `${image.name} ${image.sourceFileName}`.toLocaleLowerCase().includes(value))
  }, [images, query])
  const pageSize = capacity.columns * capacity.rows
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const selected = new Set(selectedIds)
  const selectedVisible = filtered.filter(image => selected.has(image.id)).length
  const allVisibleSelected = filtered.length > 0 && selectedVisible === filtered.length
  const locked = disabled || loading || quantitySaving || batchSaving
  useEffect(() => { anchorId.current = undefined }, [query])
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!open || !grid) return
    const measure = () => {
      const { width, height } = grid.getBoundingClientRect()
      if (!width || !height) return
      const next = gridCapacity(width, height)
      setCapacity(current => next.columns === current.columns && next.rows === current.rows ? current : next)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(grid)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [open, !!record, !!filtered.length])

  function selectImage(image: ProductionImage, modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, checkbox = false) {
    if (locked) return
    setBatchMessage(''); setBatchError('')
    const additive = modifiers.ctrlKey || modifiers.metaKey || checkbox
    const anchor = filtered.findIndex(candidate => candidate.id === anchorId.current)
    const index = filtered.findIndex(candidate => candidate.id === image.id)
    if (modifiers.shiftKey && anchor >= 0) {
      const ids = filtered.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map(candidate => candidate.id)
      if (!additive) onToggleMany(selectedIds.filter(id => !ids.includes(id)), false)
      onToggleMany(ids, true)
    } else {
      if (additive) onToggle(image.id, !selected.has(image.id))
      else {
        onToggleMany(selectedIds.filter(id => id !== image.id), false)
        onToggleMany([image.id], true)
      }
      anchorId.current = image.id
    }
  }
  function clickCard(event: MouseEvent, image: ProductionImage) {
    if ((event.target as HTMLElement).closest('input, button, label, .ant-input-number')) return
    selectImage(image, event)
  }
  async function applyQuantity() {
    if (locked || batchLock.current || batchQuantity === null || !selectedIds.length) return
    const ids = images.filter(image => selected.has(image.id)).map(image => image.id)
    batchLock.current = true; setBatchSaving(true); setBatchMessage(''); setBatchError('')
    try { await onBatchQuantityCommit(ids, batchQuantity); setBatchMessage(`已将 ${ids.length} 张图片的 QT 修改为 ${batchQuantity}`) }
    catch (reason) { setBatchError(`批量修改失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { batchLock.current = false; setBatchSaving(false) }
  }

  return <Modal
    open={open}
    title={<div className="imposition-image-picker-title"><strong>{title}</strong><span>{images.length} 张基础图片 · 已选 {selectedIds.length} 张</span></div>}
    width="min(1180px, 94vw)"
    centered
    destroyOnHidden
    maskClosable={!locked}
    keyboard={!locked}
    closable={!locked}
    onCancel={() => { if (!locked) onClose() }}
    footer={<div className="imposition-image-picker-footer"><span>当前筛选 {filtered.length} 张 · 已选 {selectedIds.length}/{images.length} 张图片</span><Button type="primary" disabled={locked} onClick={onClose}>完成</Button></div>}
    className="imposition-image-picker-modal"
  >
    <div className="imposition-image-picker-toolbar">
      <Input aria-label="搜索图片名称或文件名" allowClear prefix={<Search size={15}/>} placeholder="搜索图片名称或文件名" value={query} disabled={locked} onChange={event => { setQuery(event.target.value); changePage(1) }}/>
      <Checkbox checked={allVisibleSelected} indeterminate={selectedVisible > 0 && !allVisibleSelected} disabled={locked || !filtered.length} onChange={event => onToggleMany(filtered.map(image => image.id), event.target.checked)}>全选当前筛选</Checkbox>
      <Tag color="blue">已选 {selectedIds.length}</Tag>
    </div>
    <div className="imposition-image-picker-batch"><label>批量 QT<InputNumber aria-label="批量 QT" min={0} max={10000} precision={0} value={batchQuantity} disabled={locked} onChange={setBatchQuantity} onPressEnter={() => void applyQuantity()}/></label><Button type="primary" disabled={locked || !selectedIds.length || batchQuantity === null} loading={batchSaving} onClick={() => void applyQuantity()}>应用到已选 {selectedIds.length} 张</Button><span role="status">{batchMessage || '单击选择 · Ctrl 多选 · Shift 连选（支持跨页）'}</span></div>
    {batchError && <Alert type="error" showIcon message={batchError}/>}
    {error && record && <Alert type="error" showIcon message={error}/>}
    {loading && !record ? <div className="imposition-image-picker-loading"><Loading text="正在加载图片明细…"/></div> : error && !record ? <Alert type="error" showIcon message={error} action={<Button onClick={onRetry}>重试</Button>}/> : !filtered.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={images.length ? '没有匹配的图片' : '当前任务没有图片'}/> : <>
      <div className="imposition-image-picker-grid" ref={gridRef} style={{ gridTemplateColumns: `repeat(${capacity.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${capacity.rows}, minmax(0, 1fr))` }}>
        {visible.map(image => {
          const reason = issueReason(image)
          const checked = selected.has(image.id)
          const quantity = quantityValue(image)
          return <article key={image.id} className={`imposition-image-picker-card${checked ? ' is-selected' : ''}${reason ? ' is-invalid-outline' : ''}`} onClick={event => clickCard(event, image)}>
            <div className="imposition-image-picker-card-head">
              <Checkbox aria-label={`参与拼版 ${image.name}`} checked={checked} disabled={locked} onClick={event => { event.stopPropagation(); selectImage(image, event, true) }}/>
              <div className="imposition-image-picker-preview"><ImpositionThumbnail path={image.filePath} name={image.name}/></div>
            </div>
            <div className="imposition-image-picker-card-body"><strong title={image.name}>{image.name}</strong><small>{image.widthMm.toFixed(1)} × {image.heightMm.toFixed(1)} mm</small>{reason && <span className="imposition-image-picker-issue" title={reason}>{reason}</span>}</div>
            <label className="imposition-image-picker-quantity"><span>QT</span><InputNumber aria-label={`QT ${image.name}`} size="small" min={0} max={10000} precision={0} value={quantity} disabled={locked} onChange={value => onQuantityChange(image, Math.max(0, Math.min(10000, Math.floor(value ?? 0))))} onBlur={() => onQuantityCommit(image)} onPressEnter={() => onQuantityCommit(image)}/></label>
          </article>
        })}
      </div>
      <div className="imposition-image-picker-pagination"><span>每页 {pageSize} 张</span><Pagination current={currentPage} pageSize={pageSize} total={filtered.length} disabled={locked} showSizeChanger={false} showQuickJumper onChange={changePage}/></div>
    </>}
  </Modal>
}
