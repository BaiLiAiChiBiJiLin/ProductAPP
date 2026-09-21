export type { Asset } from '../../model'
import type { Asset } from '../../model'
export type Item = { id: string; assetId: string; x: number; y: number; w: number; h: number; rotation: number }
export type Page = { id: number; name: string; items: Item[] }
export const PAPER_WIDTH = 500
export const PAPER_HEIGHT = PAPER_WIDTH * 297 / 210
export const initialPages: Page[] = [{ id: 1, name: '页面 1', items: [] }]

export function constrain(item: Item): Item {
  const angle = item.rotation * Math.PI / 180
  const halfW = (Math.abs(Math.cos(angle)) * item.w + Math.abs(Math.sin(angle)) * item.h) / 2
  const halfH = (Math.abs(Math.sin(angle)) * item.w + Math.abs(Math.cos(angle)) * item.h) / 2
  const fit = Math.min(1, PAPER_WIDTH / (halfW * 2), PAPER_HEIGHT / (halfH * 2))
  return { ...item, w: item.w * fit, h: item.h * fit, x: Math.max(halfW * fit, Math.min(PAPER_WIDTH - halfW * fit, item.x)), y: Math.max(halfH * fit, Math.min(PAPER_HEIGHT - halfH * fit, item.y)) }
}

export function svgDataUrl(svg: string) {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

export function pageSvg(page: Page, assets: Map<string, Asset>) {
  const images = page.items.map(item => {
    const asset = assets.get(item.assetId)
    if (!asset) throw new Error('页面中有丢失的图片资源，无法导出')
    return `<image x="${-item.w / 2}" y="${-item.h / 2}" width="${item.w}" height="${item.h}" transform="translate(${item.x} ${item.y}) rotate(${item.rotation})" href="${svgDataUrl(asset.svg)}"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 ${PAPER_WIDTH} ${PAPER_HEIGHT}"><rect width="100%" height="100%" fill="white"/>${images}</svg>`
}
