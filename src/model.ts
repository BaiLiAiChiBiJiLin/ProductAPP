import type { ImageGroup } from './modules/schematic/layoutTypes.ts'
import { groupBackgroundsSvg } from './modules/schematic/services/groupBackgroundService.ts'
import { imageDimensionMarkersSvg } from './modules/schematic/services/imageDimensionService.ts'

export type Asset = { id: string; name: string; sourceFileName?: string; productId: string; productName?: string; width: number; height: number; sourceGroupWidthMm?: number; sourceGroupHeightMm?: number; sourceGroupBounds?: [number, number, number, number]; svg: string; previewUrl: string; thumbnailUrl: string; storagePath?: string; modeUsed?: 'whole' | 'groups'; mergeStatus?: 'merged' | 'kept-separate' | 'whole'; sourceGroupId?: string; attributes?: Record<string, string>; attributeImages?: Record<string, string>; note?: string; noteImage?: string; attributesConfirmed?: boolean; productGroupId?: string; productGroupColor?: string; productGroupLeaderId?: string; productGroupMode?: '' | 'guided' | 'free'; /** 1-based order inside a product group; absent/zero means legacy order. */ productGroupPosition?: number }
export type Item = { id: string; assetId: string; x: number; y: number; w: number; h: number; rotation: number; mirrorX?: boolean; backSvg?: string; derivedFrom?: string; caption?: string; captionAlign?: 'left' | 'center'; captionFontSize?: number; note?: string; rulerUnit?: 'mm' | 'cm' | 'in'; rulerWidth?: boolean; rulerHeight?: boolean; suppressRuler?: boolean }
export type HeaderImageMode = 'front-back' | 'photo' | 'separate'
export type HeaderColumn = { id: string; imageMode: HeaderImageMode; detailLabel: string }
export type HeaderBlock = { id: string; x: number; y: number; width: number; columns: HeaderColumn[]; auto?: boolean; productId?: string; productLabel?: string; printOption?: string; assetIds?: string[]; detailWidth?: number }
export type Page = { id: number; name: string; items: Item[]; headerBlocks?: HeaderBlock[]; imageGroups?: ImageGroup[] }
export type PageHeader = { customerName?: string; drawingDate?: string; estimatedShipDate?: string; designer?: string }
export type LayoutBounds = { top: number; left: number; right: number; bottom: number }
export const PAPER_WIDTH = 500
export const PAPER_HEIGHT = PAPER_WIDTH * 297 / 210
export const GROUP_GAP = 1.8 * PAPER_WIDTH / 210
export const PAGE_HEADER_HEIGHT = 90
export const defaultLayoutBounds: LayoutBounds = { top: 95.2381, left: 10, right: 10, bottom: 10 * PAPER_WIDTH / 210 }
export const HEADER_BLOCK_HEIGHT = 26
export const HEADER_BACKGROUND = '#B5D5BE'
export const DETAIL_LINE_HEIGHT = 11
export const DETAIL_LABEL_FONT_SIZE = 10
export const DETAIL_ACCESSORY_SIZE_RATIO = 0.36
export const DETAIL_NOTE_IMAGE_SIZE_RATIO = 0.22
export const initialPages: Page[] = [{ id: 1, name: '页面 1', items: [] }]

export function normalizeLayoutBounds(bounds: LayoutBounds): LayoutBounds {
  const valid = (value: number, limit: number) => Math.max(0, Math.min(limit, Number.isFinite(value) ? value : 0))
  const left = valid(bounds.left, PAPER_WIDTH - 40)
  const top = valid(bounds.top, PAPER_HEIGHT - 40)
  return { left, top, right: valid(bounds.right, PAPER_WIDTH - left - 40), bottom: valid(bounds.bottom, PAPER_HEIGHT - top - 40) }
}

export function constrainHeaderBlock(block: HeaderBlock, bounds: LayoutBounds): HeaderBlock {
  const area = normalizeLayoutBounds(bounds)
  const minimumWidth = block.columns.length + Math.max(0, block.columns.length - 1) * GROUP_GAP
  const width = Math.min(PAPER_WIDTH - area.left - area.right, Math.max(minimumWidth, block.width))
  return { ...block, width, x: Math.max(area.left, Math.min(block.x, PAPER_WIDTH - area.right - width)), y: Math.max(area.top, Math.min(block.y, PAPER_HEIGHT - area.bottom - HEADER_BLOCK_HEIGHT)) }
}

/** Each logical column contains an image section and a separate details section. */
export function headerCells(block: HeaderBlock) {
  const groupWidth = (block.width - GROUP_GAP * Math.max(0, block.columns.length - 1)) / Math.max(1, block.columns.length)
  return block.columns.flatMap((column, index) => {
    const images = column.imageMode === 'separate' ? ['Front', 'Back'] : [column.imageMode === 'photo' ? 'photo' : 'Front/Back']
    const detailsWidth = Math.min(Math.max(1, groupWidth - 1), block.detailWidth ?? groupWidth / 2)
    const imageWidth = (groupWidth - detailsWidth) / images.length
    return [
      ...images.map((label, imageIndex) => ({ id: `${column.id}-image-${imageIndex}`, role: 'image' as const, label, x: index * (groupWidth + GROUP_GAP) + imageIndex * imageWidth, width: imageWidth })),
      { id: `${column.id}-details`, role: 'details' as const, label: column.detailLabel, x: index * (groupWidth + GROUP_GAP) + groupWidth - detailsWidth, width: detailsWidth },
    ]
  })
}

/** Keep the fixed details caption readable when a page fits three logical columns. */
export function headerCellLines(cell: { label: string; width: number }): string[] {
  return cell.label === 'Size/QT/Finish/Accessory' && cell.width < 115
    ? ['Size/QT/Finish/', 'Accessory']
    : [cell.label]
}

export function artworkBounds(bounds: LayoutBounds): LayoutBounds {
  return normalizeLayoutBounds(bounds)
}

/** Fit an asset into a layout slot without ever changing its aspect ratio. */
export function proportionalAssetSize(width: number, height: number, maxWidth = 92, maxHeight = 100) {
  const sourceWidth = Number.isFinite(width) && width > 0 ? width : maxWidth
  const sourceHeight = Number.isFinite(height) && height > 0 ? height : maxHeight
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight)
  return { w: Math.max(1, sourceWidth * scale), h: Math.max(1, sourceHeight * scale) }
}

/** Return the visible source geometry used by the canvas and pagination. */
export function sourceAssetSize(asset: Pick<Asset, 'width' | 'height' | 'sourceGroupWidthMm' | 'sourceGroupHeightMm'>) {
  return { width: asset.width, height: asset.height }
}

/** Natural layout size. Physical millimetres belong to measurement labels, not canvas occupancy. */
export function proportionalAssetSizeForAsset(asset: Pick<Asset, 'width' | 'height' | 'sourceGroupWidthMm' | 'sourceGroupHeightMm'>) {
  return proportionalAssetSize(asset.width, asset.height)
}

export function constrain(item: Item, bounds: LayoutBounds = { top: 0, left: 0, right: 0, bottom: 0 }): Item {
  const angle = item.rotation * Math.PI / 180
  const halfW = (Math.abs(Math.cos(angle)) * item.w + Math.abs(Math.sin(angle)) * item.h) / 2
  const halfH = (Math.abs(Math.sin(angle)) * item.w + Math.abs(Math.cos(angle)) * item.h) / 2
  const width = Math.max(1, PAPER_WIDTH - bounds.left - bounds.right)
  const height = Math.max(1, PAPER_HEIGHT - bounds.top - bounds.bottom)
  const fit = Math.min(1, width / (halfW * 2), height / (halfH * 2))
  const nextHalfW = halfW * fit
  const nextHalfH = halfH * fit
  return { ...item, w: item.w * fit, h: item.h * fit, x: Math.max(bounds.left + nextHalfW, Math.min(PAPER_WIDTH - bounds.right - nextHalfW, item.x)), y: Math.max(bounds.top + nextHalfH, Math.min(PAPER_HEIGHT - bounds.bottom - nextHalfH, item.y)) }
}

export function svgDataUrl(svg: string) {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

// Blob URLs avoid expanding every SVG to a base64 string in the WebView. The
// same asset is often shown in the pool, page thumbnails and the Konva canvas;
// reusing one URL keeps large batches from duplicating their encoded payload.
const svgObjectUrls = new Map<string, string>()
export function svgObjectUrl(svg: string) {
  const cached = svgObjectUrls.get(svg)
  if (cached) return cached
  if (typeof URL.createObjectURL !== 'function') return svgDataUrl(svg)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  svgObjectUrls.set(svg, url)
  return url
}

function xmlText(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] ?? character))
}

function displayDate(value?: string) {
  if (!value) return '-'
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  return match ? `${Number(match[2])}月${Number(match[3])}日` : value
}

export function pageHeaderSvg(pageNumber: number, totalPages: number, metadata: PageHeader = {}) {
  const customer = metadata.customerName?.trim() || '-'
  const designer = metadata.designer?.trim() || '-'
  return `<g font-family="Arial, Microsoft YaHei, sans-serif" fill="#202124">
    <text x="15" y="27" font-size="18" font-weight="700">ORDER PROOF</text>
    <text x="15" y="49" font-size="15">Customer: ${xmlText(customer)}</text>
    <text x="15" y="70" font-size="10" fill="#5f6368">Please review the details below and confirm.</text>
    <rect x="280" y="14" width="204" height="72" rx="4" fill="#fff" stroke="#888" stroke-width="0.9"/>
    <path d="M280 38h125M280 62h125M360 14v72M405 14v72" fill="none" stroke="#888" stroke-width="0.7"/>
    <text x="285" y="30" font-size="7.5">Drawing Date</text><text x="365" y="30" font-size="8">${xmlText(displayDate(metadata.drawingDate))}</text>
    <text x="285" y="54" font-size="6.3">Estimated Ship Date</text><text x="365" y="54" font-size="8">${xmlText(displayDate(metadata.estimatedShipDate))}</text>
    <text x="285" y="78" font-size="7">Designer</text><text x="365" y="78" font-size="7">${xmlText(designer)}</text>
    <text x="444" y="31" text-anchor="middle" font-size="8">Page</text>
    <text x="444" y="58" text-anchor="middle" font-size="12">${pageNumber} of ${totalPages}</text>
  </g>`
}

function columnHeadersSvg(blocks: HeaderBlock[]) {
  return `<g font-family="Arial, Microsoft YaHei, sans-serif">${blocks.map(block => `<g transform="translate(${block.x} ${block.y})"><path d="M4 0H${Math.max(4, block.width - 4)}a4 4 0 0 1 4 4v${Math.max(0, HEADER_BLOCK_HEIGHT - 4)}H0V4a4 4 0 0 1 4-4Z" fill="${HEADER_BACKGROUND}"/>${headerCells(block).map(cell => {
    const lines = headerCellLines(cell)
    return `<svg x="${cell.x}" width="${cell.width}" height="${HEADER_BLOCK_HEIGHT}" overflow="hidden">${lines.map((line, index) => `<text x="${cell.width / 2}" y="${(index + 0.5) * HEADER_BLOCK_HEIGHT / lines.length + 3}" text-anchor="middle" font-size="8.5" fill="#475569">${xmlText(line)}</text>`).join('')}</svg>`
  }).join('')}</g>`).join('')}</g>`
}

export function pageSvg(page: Page, assets: Map<string, Asset>, metadata: PageHeader = {}, totalPages = 1) {
  const images = page.items.map(item => {
    const asset = assets.get(item.assetId)
    if (!asset) throw new Error('页面中有丢失的图片资源，无法导出')
    return `${item.caption ? `<text x="${item.captionAlign === 'left' ? item.x - item.w / 2 : item.x}" y="${item.y - item.h / 2 - 10}" text-anchor="${item.captionAlign === 'left' ? 'start' : 'middle'}" font-size="${item.captionFontSize ?? 10}" fill="#e11d48">${xmlText(item.caption)}</text>` : ''}<image x="${-item.w / 2}" y="${-item.h / 2}" width="${item.w}" height="${item.h}" transform="translate(${item.x} ${item.y}) rotate(${item.rotation}) scale(${item.mirrorX ? -1 : 1} 1)" href="${svgDataUrl(item.backSvg ?? asset.svg)}"/>${item.note ? `<text x="${item.x}" y="${item.y + item.h / 2 + 9}" text-anchor="middle" font-size="8" fill="#475569">${xmlText(item.note)}</text>` : ''}`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 ${PAPER_WIDTH} ${PAPER_HEIGHT}"><rect width="100%" height="100%" fill="white"/>${pageHeaderSvg(page.id, totalPages, metadata)}${groupBackgroundsSvg(page)}${images}${imageDimensionMarkersSvg(page, assets)}${columnHeadersSvg(page.headerBlocks ?? [])}</svg>`
}

/** Export-friendly SVG that keeps each asset's original root dimensions and viewBox. */
export function pageRasterSvg(page: Page, assets: Map<string, Asset>, metadata: PageHeader = {}, totalPages = 1) {
  const images = page.items.map(item => {
    const asset = assets.get(item.assetId)
    if (!asset) throw new Error('页面中有丢失的图片资源，无法导出')
    // Keep the complete SVG as an embedded image. Split assets retain their
    // authored width/height and use a tight viewBox; extracting only the
    // inner XML would discard that viewport and reintroduce size errors.
    return `${item.caption ? `<text x="${item.captionAlign === 'left' ? item.x - item.w / 2 : item.x}" y="${item.y - item.h / 2 - 10}" text-anchor="${item.captionAlign === 'left' ? 'start' : 'middle'}" font-size="${item.captionFontSize ?? 10}" fill="#e11d48">${xmlText(item.caption)}</text>` : ''}<image x="${-item.w / 2}" y="${-item.h / 2}" width="${item.w}" height="${item.h}" transform="translate(${item.x} ${item.y}) rotate(${item.rotation}) scale(${item.mirrorX ? -1 : 1} 1)" href="${svgDataUrl(item.backSvg ?? asset.svg)}"/>${item.note ? `<text x="${item.x}" y="${item.y + item.h / 2 + 9}" text-anchor="middle" font-size="8" fill="#475569">${xmlText(item.note)}</text>` : ''}`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 ${PAPER_WIDTH} ${PAPER_HEIGHT}"><rect width="100%" height="100%" fill="white"/>${pageHeaderSvg(page.id, totalPages, metadata)}${groupBackgroundsSvg(page)}${images}${imageDimensionMarkersSvg(page, assets)}${columnHeadersSvg(page.headerBlocks ?? [])}</svg>`
}


