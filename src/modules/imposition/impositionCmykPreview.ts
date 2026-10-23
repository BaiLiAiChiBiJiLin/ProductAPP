import type { CmykSource } from './impositionCmykExport'
import { isolate, sourceViewport } from './impositionSvgExport'

/** Match native registration against visible clipped alpha, rather than the
 * un-clipped bounds of large Corel image rectangles. This is not a color proof. */
async function visibleCenter(svg: string, width: number, height: number) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error('对齐预览图片解码失败'))
      image.src = url
    })
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('当前环境不能检查图片对齐')
    context.drawImage(image, 0, 0, width, height)
    const pixels = context.getImageData(0, 0, width, height).data
    let left = width, top = height, right = 0, bottom = 0
    for (let i = 3; i < pixels.length; i += 4) {
      if (!pixels[i]) continue
      const x = ((i - 3) / 4) % width, y = Math.floor((i - 3) / 4 / width)
      left = Math.min(left, x); top = Math.min(top, y)
      right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1)
    }
    if (!right || !bottom) throw new Error('所选图层为空，无法检查对齐')
    return { x: (left + right) / 2, y: (top + bottom) / 2 }
  } finally { URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0 }
}

export async function buildCmykAlignmentPreview(source: CmykSource, autoAlign: boolean, dpi = 400): Promise<string> {
  const ns = 'http://www.w3.org/2000/svg'
  const root = document.createElementNS(ns, 'svg')
  root.setAttribute('xmlns', ns)
  root.setAttribute('width', `${source.widthMm}mm`); root.setAttribute('height', `${source.heightMm}mm`)
  root.setAttribute('viewBox', `0 0 ${source.widthMm} ${source.heightMm}`)
  const width = Math.max(1, Math.round(source.widthMm / 25.4 * dpi))
  const height = Math.max(1, Math.round(source.heightMm / 25.4 * dpi))
  let reference: { x: number; y: number } | undefined
  const layers = [{ render: source.front, offset: { xMm: 0, yMm: 0 }, name: '图片正' },
    ...(source.back ? [{ render: source.back, offset: source.backOffset, name: '图片背' }] : []),
    ...(source.window ? [{ render: source.window, offset: source.windowOffset, name: '彩窗' }] : [])]
  for (const [index, { render, offset, name }] of layers.entries()) {
    const svg = new DOMParser().parseFromString(render(), 'image/svg+xml').documentElement
    const size = sourceViewport(svg)
    svg.setAttribute('width', String(size.width)); svg.setAttribute('height', String(size.height))
    const center = autoAlign ? await visibleCenter(new XMLSerializer().serializeToString(svg), width, height) : undefined
    let dx = offset.xMm, dy = offset.yMm
    if (index === 0) reference = center
    else if (center && reference) { dx += (reference.x - center.x) * source.widthMm / width; dy += (reference.y - center.y) * source.heightMm / height }
    isolate(svg, `align-${index}`)
    const frame = document.createElementNS(ns, 'svg')
    frame.setAttribute('width', String(source.widthMm)); frame.setAttribute('height', String(source.heightMm))
    frame.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`); frame.setAttribute('preserveAspectRatio', 'none')
    frame.append(document.importNode(svg, true))
    const group = document.createElementNS(ns, 'g')
    group.setAttribute('data-alignment-layer', name); group.setAttribute('transform', `translate(${dx} ${dy})`)
    group.append(frame); root.append(group)
    if (index > 0) group.setAttribute('opacity', '0.5')
  }
  return new XMLSerializer().serializeToString(root)
}
