import type { Asset, Item, Page } from '../../../model.ts'

type Matrix = [number, number, number, number, number, number]
const identity: Matrix = [1, 0, 0, 1, 0, 0]
const cache = new WeakMap<Asset, Array<{ svg: string; bottom: number }>>()

function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]
}

function transform(raw: string | null): Matrix | undefined {
  if (!raw?.trim()) return identity
  const pattern = /([a-z]+)\s*\(([^)]*)\)/gi
  if (raw.replace(pattern, '').replace(/[\s,]/g, '')) return undefined
  let result = identity
  for (const match of raw.matchAll(pattern)) {
    const args = match[2].match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)?.map(Number) ?? []
    if (!args.every(Number.isFinite)) return undefined
    let next: Matrix
    switch (match[1].toLowerCase()) {
      case 'matrix':
        if (args.length !== 6) return undefined
        next = args as Matrix
        break
      case 'translate':
        if (args.length < 1 || args.length > 2) return undefined
        next = [1, 0, 0, 1, args[0], args[1] ?? 0]
        break
      case 'scale':
        if (args.length < 1 || args.length > 2) return undefined
        next = [args[0], 0, 0, args[1] ?? args[0], 0, 0]
        break
      case 'rotate': {
        if (args.length !== 1 && args.length !== 3) return undefined
        const radians = args[0] * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians)
        const x = args[1] ?? 0, y = args[2] ?? 0
        next = [cosine, sine, -sine, cosine, x - cosine * x + sine * y, y - sine * x - cosine * y]
        break
      }
      case 'skewx':
      case 'skewy':
        if (args.length !== 1) return undefined
        next = [1, match[1].toLowerCase() === 'skewy' ? Math.tan(args[0] * Math.PI / 180) : 0,
          match[1].toLowerCase() === 'skewx' ? Math.tan(args[0] * Math.PI / 180) : 0, 1, 0, 0]
        break
      default: return undefined
    }
    result = multiply(result, next)
  }
  return result
}

function length(raw: string | null, reference: number, fallback = 0) {
  if (raw == null) return fallback
  const match = raw.trim().match(/^([-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?)\s*(px|mm|cm|in|pt|pc|%)?$/i)
  if (!match) return NaN
  const units: Record<string, number> = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16, '%': reference / 100 }
  return Number(match[1]) * (units[(match[2] ?? 'px').toLowerCase()] ?? 1)
}

function fittedBox(x: number, y: number, width: number, height: number, sourceWidth: number, sourceHeight: number, preserve: string | null) {
  const alignment = (preserve || 'xMidYMid meet').replace(/^defer\s+/, '')
  if (alignment === 'none') return { x, y, width, height }
  const scale = /\bslice\b/.test(alignment) ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight)
  const w = sourceWidth * scale, h = sourceHeight * scale
  return { x: x + (/xMin/.test(alignment) ? 0 : /xMax/.test(alignment) ? width - w : (width - w) / 2),
    y: y + (/YMin/.test(alignment) ? 0 : /YMax/.test(alignment) ? height - h : (height - h) / 2), width: w, height: h }
}

function pictureBottom(asset: Asset, svg: string): number {
  if (typeof DOMParser === 'undefined' || !(asset.width > 0 && asset.height > 0)) return 1
  // Geometry needs no raster bytes. Avoid constructing a DOM containing large
  // Base64 payloads, and never decode or modify the source artwork.
  const geometry = svg.replace(/(\b(?:[\w.-]+:)?href\s*=\s*)(["'])data:([^,]*),[\s\S]*?\2/gi, '$1$2data:$3,$2')
  const document = new DOMParser().parseFromString(geometry, 'image/svg+xml')
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') return 1
  let bottom = -Infinity
  let imageIndex = 0
  const visit = (element: Element, parent: Matrix, viewportWidth: number, viewportHeight: number, root = false) => {
    const tag = element.localName
    if (['defs', 'clipPath', 'mask', 'pattern', 'symbol', 'metadata'].includes(tag)) return
    if (element.getAttribute('display') === 'none' || element.getAttribute('visibility') === 'hidden'
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(element.getAttribute('style') ?? '')) return
    const local = transform(element.getAttribute('transform'))
    if (!local) return
    let matrix = multiply(parent, local)
    let childWidth = viewportWidth, childHeight = viewportHeight
    if (tag === 'svg') {
      const width = root ? asset.width : length(element.getAttribute('width'), viewportWidth, viewportWidth)
      const height = root ? asset.height : length(element.getAttribute('height'), viewportHeight, viewportHeight)
      const x = root ? 0 : length(element.getAttribute('x'), viewportWidth)
      const y = root ? 0 : length(element.getAttribute('y'), viewportHeight)
      const viewBox = element.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number) ?? [0, 0, width, height]
      if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || !(viewBox[2] > 0 && viewBox[3] > 0)) return
      const fit = fittedBox(x, y, width, height, viewBox[2], viewBox[3], element.getAttribute('preserveAspectRatio'))
      const sx = fit.width / viewBox[2], sy = fit.height / viewBox[3]
      matrix = multiply(matrix, [sx, 0, 0, sy, fit.x - viewBox[0] * sx, fit.y - viewBox[1] * sy])
      childWidth = viewBox[2]; childHeight = viewBox[3]
    }
    if (tag === 'image') {
      const source = asset.sourceImages?.find(image => image.nodeId && image.nodeId === element.id)
        ?? (element.id ? undefined : asset.sourceImages?.[imageIndex])
      imageIndex++
      const href = element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? ''
      if (/^data:image\/svg\+xml/i.test(href)) return
      const x = length(element.getAttribute('x'), viewportWidth), y = length(element.getAttribute('y'), viewportHeight)
      const width = length(element.getAttribute('width'), viewportWidth), height = length(element.getAttribute('height'), viewportHeight)
      if (!(width > 0 && height > 0)) return
      const box = source && source.widthPx > 0 && source.heightPx > 0
        ? fittedBox(x, y, width, height, source.widthPx, source.heightPx, element.getAttribute('preserveAspectRatio'))
        : { x, y, width, height }
      const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
        .map(([px, py]) => [matrix[0] * px + matrix[2] * py + matrix[4], matrix[1] * px + matrix[3] * py + matrix[5]])
      const xs = corners.map(point => point[0]), ys = corners.map(point => point[1])
      if (Math.max(...xs) > 0 && Math.min(...xs) < asset.width && Math.max(...ys) > 0 && Math.min(...ys) < asset.height) bottom = Math.max(bottom, ...ys)
      return
    }
    for (const child of element.children) visit(child, matrix, childWidth, childHeight)
  }
  visit(document.documentElement, identity, asset.width, asset.height, true)
  return Number.isFinite(bottom) && bottom > 0 ? Math.min(1, bottom / asset.height) : 1
}

function isLastChainMember(item: Item, asset: Asset, page: Page, assets: Map<string, Asset>) {
  const group = page.imageGroups?.find(group => group.itemIds.includes(item.id))
  if (!group) return true
  const byId = new Map(page.items.map(member => [member.id, member]))
  const members = new Map<string, Asset>()
  for (const id of group.itemIds) {
    const member = byId.get(id)
    const source = member && assets.get(member.assetId)
    if (!source || (asset.productGroupId && source.productGroupId !== asset.productGroupId)) continue
    // Front and derived Back are one source SVG, not two product members.
    if (!members.has(source.id)) members.set(source.id, source)
  }
  const ordered = [...members.values()].sort((a, b) => (a.productGroupPosition ?? 0) - (b.productGroupPosition ?? 0))
  return !ordered.length || ordered.at(-1)?.id === asset.id
}

/** The ruler's top and measurement stay unchanged; only its picture-end anchor moves. */
export function pictureRulerBottomRatio(item: Item, page: Page, assets: Map<string, Asset>): number {
  const asset = assets.get(item.assetId)
  if (!asset) return 1
  const name = asset.productName ?? ''
  const standee = /立牌|standees?/i.test(name)
  const chain = /串串|串联|串連|chained|linked charm|connecting charm/i.test(name)
  if (standee || !chain || isLastChainMember(item, asset, page, assets)) return 1
  const svg = item.backSvg ?? asset.svg
  if (!svg) return 1
  const entries = cache.get(asset) ?? []
  const cached = entries.find(entry => entry.svg === svg)
  if (cached) return cached.bottom
  const bottom = pictureBottom(asset, svg)
  // At most the front and derived back for this asset; discarded batches can GC.
  cache.set(asset, [...entries.slice(-1), { svg, bottom }])
  return bottom
}
