import { useEffect, useState } from 'react'
import { Group, Image as KonvaImage, Rect, Text } from 'react-konva'
import type { Asset, Page } from '../../../model'
import type { ImageGroup } from '../layoutTypes'
import { imageDetailsLayout } from '../services/imageDetailsLayoutService'
import { detailPanelsForGroup } from '../arrangement/productGroupDetails'
import { finishLabel } from '../services/finishLabelService'
import { accessoryFrame, rememberAccessoryImage } from '../services/accessoryFrameService'
import { resolveRemoteImage } from '../services/remoteImageService'
import { rulerDimensionLabel, type DimensionDisplayOverride, type DimensionDisplayPrecision } from '../services/imageDimensionService'
import type { Node as KonvaNode } from 'konva/lib/Node'

const imageCache = new Map<string, HTMLImageElement>()
export type AccessoryVisual = { scale: number; x: number; y: number }
type AccessoryBounds = { x: number; y: number; width: number; height: number }

/**
 * Konva passes dragBoundFunc positions in stage coordinates. The details
 * layout, however, is calculated in the details panel's local coordinates.
 * Convert the panel bounds before clamping so a dragged accessory stays in
 * the group instead of being sent to an invalid (usually invisible) position.
 */
function accessoryDragBound(node: KonvaNode, position: { x: number; y: number }, bounds: AccessoryBounds, width: number, height: number, scale: number) {
  const parent = node.getParent()
  const transform = parent?.getAbsoluteTransform()
  if (!transform) return position
  const matrix = transform.getMatrix()
  const topLeft = transform.point({ x: bounds.x, y: bounds.y })
  const bottomRight = transform.point({ x: bounds.x + bounds.width, y: bounds.y + bounds.height })
  const scaleX = Math.max(0.0001, Math.hypot(matrix[0], matrix[1]))
  const scaleY = Math.max(0.0001, Math.hypot(matrix[2], matrix[3]))
  const halfWidth = width * scale * scaleX / 2
  const halfHeight = height * scale * scaleY / 2
  const minX = Math.min(topLeft.x, bottomRight.x) + halfWidth
  const maxX = Math.max(topLeft.x, bottomRight.x) - halfWidth
  const minY = Math.min(topLeft.y, bottomRight.y) + halfHeight
  const maxY = Math.max(topLeft.y, bottomRight.y) - halfHeight
  return {
    x: minX > maxX ? (minX + maxX) / 2 : Math.max(minX, Math.min(maxX, position.x)),
    y: minY > maxY ? (minY + maxY) / 2 : Math.max(minY, Math.min(maxY, position.y)),
  }
}

function AccessoryImage({ src, x, y, width, height, code, framed = false, selectionKey, visual = { scale: 1, x: 0, y: 0 }, selected = false, bounds, onSelect, onChange }: { src: string; x: number; y: number; width: number; height: number; code?: string; framed?: boolean; selectionKey?: string; visual?: AccessoryVisual; selected?: boolean; bounds?: AccessoryBounds; onSelect?: (key: string) => void; onChange?: (key: string, patch: Partial<AccessoryVisual>) => void }) {
  const [image, setImage] = useState<HTMLImageElement>()
  useEffect(() => {
    let cancelled = false
    let element: HTMLImageElement | undefined
    setImage(undefined)
    const load = async () => {
      const resolved = await resolveRemoteImage(src)
      if (cancelled) return
      const cached = imageCache.get(resolved)
      if (cached) { rememberAccessoryImage(src, cached); setImage(cached); return }
      element = new window.Image()
      element.crossOrigin = 'anonymous'
      element.onload = () => {
        if (!cancelled && element) {
          rememberAccessoryImage(src, element)
          imageCache.set(resolved, element)
          setImage(element)
        }
      }
      element.onerror = () => { if (!cancelled) console.warn('配件或备注图片解码失败') }
      element.src = resolved
    }
    void load().catch(error => { if (!cancelled) console.warn('配件或备注图片加载失败', error) })
    return () => { cancelled = true; if (element) { element.onload = null; element.onerror = null } }
  }, [src])
  if (!image) return null
  if (framed) rememberAccessoryImage(src, image)
  const interactive = Boolean(selectionKey && onSelect && onChange)
  const safeScale = Number.isFinite(visual.scale) && visual.scale > 0 ? visual.scale : 1
  if (framed) {
    const frame = accessoryFrame(src, x, y, width, code)
    const centerX = frame.x + frame.frameWidth / 2, centerY = frame.y + frame.frameHeight / 2
    const dragBoundFunc = bounds ? function (this: KonvaNode, position: { x: number; y: number }) {
      return accessoryDragBound(this, position, bounds, frame.frameWidth, frame.frameHeight, safeScale)
    } : undefined
    return <Group name={selectionKey ? `accessory-${selectionKey}` : undefined} x={centerX + visual.x} y={centerY + visual.y} offsetX={centerX} offsetY={centerY} scaleX={safeScale} scaleY={safeScale} draggable={interactive} listening={interactive} dragBoundFunc={dragBoundFunc}
      onClick={event => { if (!selectionKey || !onSelect) return; event.cancelBubble = true; onSelect(selectionKey) }} onTap={event => { if (!selectionKey || !onSelect) return; event.cancelBubble = true; onSelect(selectionKey) }}
      onDragEnd={event => { if (selectionKey && onChange) onChange(selectionKey, { x: event.target.x() - centerX, y: event.target.y() - centerY }) }}>
      {selected && <Rect x={frame.x - 1} y={frame.y - 1} width={frame.frameWidth + 2} height={frame.frameHeight + 2} stroke="#2563eb" strokeWidth={1.5} listening={false}/>}<Rect x={frame.x} y={frame.y} width={frame.frameWidth} height={frame.frameHeight} fill="#fff" cornerRadius={1}/>
      <KonvaImage image={image} crop={frame.crop} x={frame.imageX} y={frame.imageY} width={frame.width} height={frame.height}/>
      {code && <Text x={frame.x} y={frame.codeY} width={frame.frameWidth} height={12} text={code} align="center" fontSize={8} fontStyle="bold" fill="#475569"/>}
    </Group>
  }
  const ratio = Math.min(width / image.naturalWidth, height / image.naturalHeight)
  const fittedWidth = image.naturalWidth * ratio
  const fittedHeight = image.naturalHeight * ratio
  const centerX = x + width / 2, centerY = y + height / 2
  const dragBoundFunc = bounds ? function (this: KonvaNode, position: { x: number; y: number }) {
    return accessoryDragBound(this, position, bounds, width, height, safeScale)
  } : undefined
  return <Group name={selectionKey ? `accessory-${selectionKey}` : undefined} x={centerX + visual.x} y={centerY + visual.y} offsetX={centerX} offsetY={centerY} scaleX={safeScale} scaleY={safeScale} draggable={interactive} listening={interactive} dragBoundFunc={dragBoundFunc}
    onClick={event => { if (!selectionKey || !onSelect) return; event.cancelBubble = true; onSelect(selectionKey) }} onTap={event => { if (!selectionKey || !onSelect) return; event.cancelBubble = true; onSelect(selectionKey) }}
    onDragEnd={event => { if (selectionKey && onChange) onChange(selectionKey, { x: event.target.x() - centerX, y: event.target.y() - centerY }) }}>
    {selected && <Rect x={x - 1} y={y - 1} width={width + 2} height={height + 2} stroke="#2563eb" strokeWidth={1.5} listening={false}/>}<KonvaImage image={image} x={x + (width - fittedWidth) / 2} y={y + (height - fittedHeight) / 2} width={fittedWidth} height={fittedHeight}/>
  </Group>
}

function detailsForDisplay(details: NonNullable<ImageGroup['details']>, page: Page, assets: Map<string, Asset>, itemIds: string[], selected: Set<string>, precision: DimensionDisplayPrecision, decimalPlaces: number, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>) {
  const labels = new Map<string, string>()
  for (const item of page.items) {
    if (!itemIds.includes(item.id) || (!selected.has(item.id) && !displayOverrides?.has(item.id))) continue
    const asset = assets.get(item.assetId)
    if (asset) {
      const override = displayOverrides?.get(item.id)
      const label = rulerDimensionLabel(asset, item, override?.precision ?? precision, override?.decimalPlaces ?? decimalPlaces)
      if (label) labels.set(item.id, label)
    }
  }
  if (!labels.size) return details
  const firstLabel = labels.values().next().value as string | undefined
  return { ...details,
    size: details.sizes?.length ? details.size : firstLabel ?? details.size,
    sizes: details.sizes?.map(value => labels.has(value.itemId) ? { ...value, label: labels.get(value.itemId)! } : value),
  }
}

function groupForDisplay(group: ImageGroup, page: Page | undefined, assets: Map<string, Asset> | undefined, selectedItemIds: string[], precision: DimensionDisplayPrecision, decimalPlaces: number, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>) {
  if (!page || !assets || (!selectedItemIds.length && !displayOverrides?.size)) return group
  const selected = new Set(selectedItemIds)
  const isDisplayed = (id: string) => selected.has(id) || Boolean(displayOverrides?.has(id))
  const details = group.details && group.itemIds.some(isDisplayed)
    ? detailsForDisplay(group.details, page, assets, group.itemIds, selected, precision, decimalPlaces, displayOverrides)
    : group.details
  const detailGroups = group.detailGroups?.map(panel => panel.itemIds.some(isDisplayed)
    ? { ...panel, details: detailsForDisplay(panel.details, page, assets, panel.itemIds, selected, precision, decimalPlaces, displayOverrides) }
    : panel)
  return details === group.details && detailGroups === group.detailGroups ? group : { ...group, details, detailGroups }
}

export default function ImageGroupDetails({ group, page, assets, selectedItemIds = [], precision = 'default', decimalPlaces = 1, displayOverrides, selectedAccessoryKey, accessoryVisuals, onSelectAccessory, onChangeAccessory }: { group: ImageGroup; page?: Page; assets?: Map<string, Asset>; selectedItemIds?: string[]; precision?: DimensionDisplayPrecision; decimalPlaces?: number; displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>; selectedAccessoryKey?: string; accessoryVisuals?: ReadonlyMap<string, AccessoryVisual>; onSelectAccessory?: (key: string) => void; onChangeAccessory?: (key: string, patch: Partial<AccessoryVisual>) => void }) {
  const displayGroup = groupForDisplay(group, page, assets, selectedItemIds, precision, decimalPlaces, displayOverrides)
  const label = finishLabel(displayGroup)
  return <Group listening={Boolean(onSelectAccessory)}>{detailPanelsForGroup(displayGroup).map(panel => <DetailsPanel key={panel.id} group={panel} selectedAccessoryKey={selectedAccessoryKey} accessoryVisuals={accessoryVisuals} onSelectAccessory={onSelectAccessory} onChangeAccessory={onChangeAccessory}/>)}{label.text && <Text x={label.x + label.width} y={label.y} text={label.text} fontSize={10} fill="#ff4d4f" wrap="none" ref={node => { if (node) node.offsetX(node.width()) }} listening={false}/>}</Group>
}

function DetailsPanel({ group, selectedAccessoryKey, accessoryVisuals, onSelectAccessory, onChangeAccessory }: { group: ImageGroup; selectedAccessoryKey?: string; accessoryVisuals?: ReadonlyMap<string, AccessoryVisual>; onSelectAccessory?: (key: string) => void; onChangeAccessory?: (key: string, patch: Partial<AccessoryVisual>) => void }) {
  const details = group.details
  if (!details) return null
  const { x, y, width, line, fontSize, fields, bodyY, imageSize, noteX, noteWidth, noteY, noteLines, noteLine, noteFontSize, noteImageSize, noteImageY } = imageDetailsLayout(group)
  const accessoryKey = `${group.id}:accessory`
  const noteKey = `${group.id}:note`
  const bounds = { x: group.x - x, y: group.y - y, width: group.width, height: Math.max(group.height, group.backgroundHeight ?? group.height) }
  return <Group x={x} y={y} listening={Boolean(onSelectAccessory)}>
    {fields.map((field, index) => <Text key={field.key} y={index * line} text={field.text} width={width} height={line} fontSize={Math.min(fontSize, field.fontSize ?? fontSize)} wrap="none" fontStyle="bold" fill="#475569" ellipsis listening={false}/>)}
    {details.accessoryImage && <AccessoryImage src={details.accessoryImage} x={0} y={bodyY - y} width={imageSize} height={imageSize} code={details.accessoryCode} framed selectionKey={accessoryKey} visual={accessoryVisuals?.get(accessoryKey)} selected={selectedAccessoryKey === accessoryKey} bounds={bounds} onSelect={onSelectAccessory} onChange={onChangeAccessory}/>}
    {noteLines.map((value, index) => <Text key={`note-${index}`} x={noteX - x} y={noteY - y + index * noteLine} text={value} width={noteWidth} align="center" height={noteLine} fontSize={noteFontSize} fill="#475569" ellipsis/>)}
    {details.noteImage && noteImageSize > 0 && <AccessoryImage src={details.noteImage} x={noteX - x + (noteWidth - noteImageSize) / 2} y={noteImageY - y} width={noteImageSize} height={noteImageSize} selectionKey={noteKey} visual={accessoryVisuals?.get(noteKey)} selected={selectedAccessoryKey === noteKey} bounds={bounds} onSelect={onSelectAccessory} onChange={onChangeAccessory}/>}
  </Group>
}
