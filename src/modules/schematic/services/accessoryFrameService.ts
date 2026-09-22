import type { Page } from '../../../model.ts'
import { resolveRemoteImage } from './remoteImageService.ts'

const sizes = new Map<string, { width: number; height: number }>()
type Crop = { x: number; y: number; width: number; height: number }
const crops = new Map<string, Crop>()
export function visibleAccessoryBounds(data: Uint8ClampedArray, width: number, height: number): Crop {
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    if (data[i + 3] <= 8 || (data[i] >= 248 && data[i + 1] >= 248 && data[i + 2] >= 248)) continue
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  return right < left ? { x: 0, y: 0, width, height } : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}
export function rememberAccessoryImage(src: string, image: HTMLImageElement) {
  rememberAccessorySize(src, image.naturalWidth, image.naturalHeight)
  if (crops.has(src)) return
  try {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight))
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const crop = visibleAccessoryBounds(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
    const sx = image.naturalWidth / canvas.width, sy = image.naturalHeight / canvas.height
    crops.set(src, { x: crop.x * sx, y: crop.y * sy, width: crop.width * sx, height: crop.height * sy })
  } catch { /* Cross-origin unreadable images retain their original frame. */ }
}
export function rememberAccessorySize(src: string, width: number, height: number) {
  if (width > 0 && height > 0) sizes.set(src, { width, height })
}

export function accessoryTopGap(src: string) {
  const natural = sizes.get(src)
  if (!natural) return 0
  const crop = crops.get(src) ?? natural
  return crop.width / Math.max(natural.width, natural.height) <= 0.4 ? 4 : 0
}

/** Two units of white padding on each side of the fitted image and its code. */
export function accessoryFrame(src: string, x: number, y: number, size: number, code = '') {
  const natural = sizes.get(src) ?? { width: 1, height: 1 }
  const crop = crops.get(src) ?? { x: 0, y: 0, ...natural }
  // Use a relative width limit so wide accessories shrink consistently at
  // every canvas zoom; thin accessories keep their existing scale.
  const fittedScale = size / Math.max(natural.width, natural.height)
  const scale = Math.min(fittedScale, size * 0.4 / crop.width)
  const width = crop.width * scale, height = crop.height * scale
  const imageX = x + (size - width) / 2, imageY = y + accessoryTopGap(src) + (size - height) / 2
  const frameWidth = Math.max(width, code.length * 5) + 4
  return { imageX, imageY, width, height, crop, natural, x: x + size / 2 - frameWidth / 2,
    y: imageY - 2, frameWidth, frameHeight: height + (code ? 13 : 0) + 4,
    codeY: imageY + height + 1 }
}

/** Load dimensions for offscreen pages too; keep network/decode concurrency bounded. */
export async function prepareAccessoryFrames(pages: Page[], onProgress?: (completed: number, total: number) => void) {
  const sources = [...new Set(pages.flatMap(page => (page.imageGroups ?? []).flatMap(group =>
    [group.details, ...(group.detailGroups ?? []).map(panel => panel.details)].flatMap(details => details?.accessoryImage ? [details.accessoryImage] : []))))]
    .filter(src => !crops.has(src))
  let index = 0
  let completed = 0
  onProgress?.(0, sources.length)
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
    while (index < sources.length) {
      const src = sources[index++]
      const resolved = await resolveRemoteImage(src)
      await new Promise<void>((resolve, reject) => {
        const image = new Image()
        const done = () => { clearTimeout(timer); image.onload = null; image.onerror = null; resolve() }
        const timer = setTimeout(() => { image.onload = null; image.onerror = null; reject(new Error('配件图片加载超时，请重试导出')) }, 10000)
        image.crossOrigin = 'anonymous'
        image.onload = () => { rememberAccessoryImage(src, image); done() }
        image.onerror = () => { clearTimeout(timer); image.onload = null; image.onerror = null; reject(new Error('配件图片加载失败，无法确认导出裁剪尺寸')) }
        image.src = resolved
      })
      onProgress?.(++completed, sources.length)
    }
  }))
}
