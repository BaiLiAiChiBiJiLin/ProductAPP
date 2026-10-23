import type { PackedItem } from './packingAlgorithms'
import { BOARD_HOLE_COLOR, BOARD_HOLE_STROKE_MM, boardHoleLayout, boardHolePath } from './impositionHoles'

const SVG_NS = 'http://www.w3.org/2000/svg'
const RESOURCE_TAGS = new Set(['defs', 'clippath', 'mask', 'pattern', 'marker', 'symbol', 'lineargradient', 'radialgradient', 'filter'])
const CONTAINER_TAGS = new Set(['svg', 'g', 'a', 'switch'])
const NON_PAINT_TAGS = new Set(['style', 'title', 'desc', 'metadata', 'script', 'animate', 'animatetransform', 'animatemotion', 'set'])
const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line'])
export type SvgLayerCategory = 'paths' | 'images' | 'fills' | 'unknown'
export type SvgLayerAssignment = string | null | undefined
export const isImageAssignment = (value: SvgLayerAssignment) => value === 'images' || value === 'image-front' || value === 'image-back'
/** Preserve source paint order within a face; board page membership is
 * resolved separately so front/back can be selected by their assigned role. */
export function orderedImageLayers(source: ExportSvgSource, assigned: Record<string, SvgLayerAssignment>) {
  return source.layers.filter(layer => isImageAssignment(assigned[layer.id]))
}
export type ExportSvgLayer = { id: string; label: string; tagName: string; category: SvgLayerCategory; defaultGroupId: SvgLayerAssignment; nodePath: number[] }
export type ExportSvgSource = { sourceId: string; fileName: string; svgText: string; layers: ExportSvgLayer[]; warnings: string[]; contourWarnings?: string[] }
export type ExportGroup = { id: string; name: string }
export const IMPOSITION_EXPORT_TYPES: ExportGroup[] = [{ id: 'paths', name: '轮廓 / 路径' }, { id: 'images', name: '图片' }, { id: 'fills', name: '彩窗' }, { id: 'white', name: '白墨' }]
export type ImpositionExportHoles = { count: number; sizeMm: number; gapMm: number; leftMm: number }
export type SvgLayerAssignments = Record<string, Record<string, SvgLayerAssignment>>
export type ImpositionExportTemplate = { id: string; pageIndices: number[]; productionCopies: number; placements: PackedItem[]; sourceIds: string[] }
export type ImpositionExportModel = {
  sources: Record<string, ExportSvgSource>; templates: ImpositionExportTemplate[]; groups: ExportGroup[]
  assignments: SvgLayerAssignments; templateAssignments?: Record<string, SvgLayerAssignments>
  plateWidthMm: number; plateHeightMm: number; holes?: ImpositionExportHoles
}
export type ImpositionSvgExportMetadata = {
  fileName: string; widthMm: number; heightMm: number; templateId: string; templateNumber: number
  groupId: string; groupName: string; groupNumber: number; productionCopies: number
  /** Zero-based whole-board image page (front/back first on mixed-face boards). */
  imageLayerIndex?: number; imageLayerMembers?: Record<string, string | string[]>
}
export type ImpositionSvgExportPage = ImpositionSvgExportMetadata & { svg: string }
export type ImpositionPdfExportMetadata = {
  fileName: string; widthMm: number; heightMm: number; templateId: string; templateNumber: number
  productionCopies: number; pages: ImpositionSvgExportMetadata[]
}
type ExportOptions = { date?: Date; templateIds?: string[]; groupIds?: string[] }
type CssRule = { selectors: string[]; declarations: string; order: number }

const tag = (element: Element) => element.localName.toLowerCase()
const children = (element: Element) => Array.from(element.children)
const sourceIdOf = (item: PackedItem) => item.image.sourceImageId ?? item.image.id.replace(/#qt-\d+$/, '')
const number = (value: number) => String(Number(value.toFixed(9)))
function exportTimestamp(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new Error('导出日期无效')
  return `${date.getFullYear()}${[date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()].map(value => String(value).padStart(2, '0')).join('')}`
}
const parse = (text: string) => {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (doc.querySelector('parsererror') || tag(doc.documentElement) !== 'svg') throw new Error('SVG 文件无法解析，请检查原图')
  return doc.documentElement
}
const serialize = (element: Element) => new XMLSerializer().serializeToString(element)

function decodeSource(input: string, widthMm?: number, heightMm?: number) {
  if (!input.startsWith('data:')) return input
  const comma = input.indexOf(',')
  if (comma < 0) throw new Error('图片数据格式不正确')
  const header = input.slice(0, comma)
  if (/^data:image\/svg\+xml(?:;|$)/i.test(header)) {
    if (/;base64/i.test(header)) return new TextDecoder().decode(Uint8Array.from(atob(input.slice(comma + 1)), c => c.charCodeAt(0)))
    return decodeURIComponent(input.slice(comma + 1))
  }
  if (!/^data:image\/(png|jpe?g|webp|gif|bmp)(?:;|$)/i.test(header)) throw new Error('不支持的图片资源类型')
  if (!(widthMm && heightMm && widthMm > 0 && heightMm > 0)) throw new Error('栅格图片缺少真实毫米宽高')
  const root = document.createElementNS(SVG_NS, 'svg')
  root.setAttribute('viewBox', `0 0 ${number(widthMm)} ${number(heightMm)}`)
  const image = document.createElementNS(SVG_NS, 'image')
  image.setAttribute('width', number(widthMm)); image.setAttribute('height', number(heightMm))
  image.setAttribute('preserveAspectRatio', 'none'); image.setAttribute('href', input)
  root.append(image)
  return serialize(root)
}

/** Split outside quoted strings, attribute selectors and functional selectors. */
function splitCss(text: string, delimiter: string) {
  const values: string[] = []; let depth = 0; let quote = ''; let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (!depth && c === delimiter) { values.push(text.slice(start, i).trim()); start = i + 1 }
  }
  values.push(text.slice(start).trim())
  return values.filter(Boolean)
}

function cssRules(root: Element): CssRule[] {
  const rules: CssRule[] = []
  const read = (css: string) => {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '')
    let start = 0; let depth = 0; let quote = ''; let head = ''; let bodyStart = 0
    for (let i = 0; i < css.length; i++) {
      const c = css[i]
      if (quote) { if (c === quote && css[i - 1] !== '\\') quote = ''; continue }
      if (c === '"' || c === "'") { quote = c; continue }
      if (c === '{') { if (depth++ === 0) { head = css.slice(start, i).trim(); bodyStart = i + 1 } }
      else if (c === '}' && --depth === 0) {
        const body = css.slice(bodyStart, i)
        if (head.startsWith('@media') || head.startsWith('@supports') || head.startsWith('@layer')) read(body)
        else if (!head.startsWith('@')) rules.push({ selectors: splitCss(head, ','), declarations: body, order: rules.length })
        start = i + 1
      }
    }
  }
  root.querySelectorAll('style').forEach(element => read(element.textContent ?? ''))
  return rules
}

function declarations(text: string) {
  return splitCss(text, ';').flatMap(declaration => {
    const colon = declaration.indexOf(':'); if (colon < 0) return []
    const raw = declaration.slice(colon + 1).trim()
    return [{ property: declaration.slice(0, colon).trim().toLowerCase(), value: raw.replace(/\s*!important\s*$/i, '').trim(), important: /!important\s*$/i.test(raw) }]
  })
}
function matches(element: Element, selector: string) { try { return element.matches(selector) } catch { return false } }
function specificity(selector: string) {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0
  const classes = selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)?.length ?? 0
  const tags = selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?/g, '').match(/[a-zA-Z][\w-]*/g)?.length ?? 0
  return ids * 1_000_000 + classes * 1_000 + tags
}
function paintProperty(element: Element, property: 'fill' | 'stroke', rules: CssRule[]): string {
  let value = element.getAttribute(property); let weight = -1; let order = -1
  for (const rule of rules) for (const selector of rule.selectors) {
    if (!matches(element, selector)) continue
    for (const declaration of declarations(rule.declarations)) {
      if (declaration.property !== property) continue
      const score = specificity(selector) + (declaration.important ? 1e12 : 0)
      if (score > weight || score === weight && rule.order >= order) { value = declaration.value; weight = score; order = rule.order }
    }
  }
  for (const declaration of declarations(element.getAttribute('style') ?? '')) if (declaration.property === property) {
    const score = 1e9 + (declaration.important ? 1e12 : 0)
    if (score >= weight) { value = declaration.value; weight = score }
  }
  if (!value || value === 'inherit' || value === 'unset') return element.parentElement ? paintProperty(element.parentElement, property, rules) : property === 'fill' ? 'black' : 'none'
  return value === 'initial' ? property === 'fill' ? 'black' : 'none' : value.toLowerCase()
}

/** Resolve styles before deleting nodes: :nth-child and sibling selectors must
 * keep the same paint when only a subset of the original drawing is exported. */
function freezeStyles(root: Element) {
  const rules = cssRules(root)
  if (!rules.length) return
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const values = new Map<string, { value: string; weight: number; order: number }>()
    for (const rule of rules) for (const selector of rule.selectors) {
      if (!matches(element, selector)) continue
      for (const declaration of declarations(rule.declarations)) {
        const weight = specificity(selector) + (declaration.important ? 1e12 : 0)
        const old = values.get(declaration.property)
        if (!old || weight > old.weight || weight === old.weight && rule.order >= old.order) values.set(declaration.property, { value: declaration.value, weight, order: rule.order })
      }
    }
    for (const declaration of declarations(element.getAttribute('style') ?? '')) {
      const weight = 1e9 + (declaration.important ? 1e12 : 0)
      const old = values.get(declaration.property)
      if (!old || weight >= old.weight) values.set(declaration.property, { value: declaration.value, weight, order: Infinity })
    }
    if (values.size) element.setAttribute('style', [...values].map(([property, value]) => `${property}:${value.value}${value.weight >= 1e12 ? ' !important' : ''}`).join(';'))
  }
  root.querySelectorAll('style').forEach(element => {
    // Font declarations are resources rather than element selectors. Keep them
    // available for manually assigned text layers; all paint rules are frozen.
    const fonts = (element.textContent ?? '').match(/@font-face\s*\{[^}]*\}/gi) ?? []
    if (fonts.length) element.textContent = fonts.join('\n')
    else element.remove()
  })
}

function layerCategory(element: Element, rules: CssRule[], root: Element, visited = new Set<Element>()): SvgLayerCategory {
  if (tag(element) === 'image') return 'images'
  if (tag(element) === 'use') {
    const href = element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    const target = href?.startsWith('#') ? Array.from(root.querySelectorAll('[id]')).find(node => node.id === href.slice(1)) : undefined
    if (!target || visited.has(target)) return 'unknown'
    visited.add(target)
    // A use referencing a composite symbol is kept intact for manual grouping.
    if (SHAPE_TAGS.has(tag(target))) {
      const explicit = declarations(target.getAttribute('style') ?? '').findLast(declaration => declaration.property === 'fill')?.value ?? target.getAttribute('fill')
      const fill = !explicit || explicit === 'inherit' || explicit === 'unset' ? paintProperty(element, 'fill', rules) : explicit
      return tag(target) !== 'line' && fill !== 'none' ? 'fills' : 'paths'
    }
    return layerCategory(target, rules, root, visited)
  }
  if (!SHAPE_TAGS.has(tag(element))) return 'unknown'
  // Keep one paint operation in one output PDF. Filled-and-stroked objects are
  // assigned wholly to fills, so their outline is never exported a second time.
  if (tag(element) !== 'line' && paintProperty(element, 'fill', rules) !== 'none') return 'fills'
  return 'paths'
}

export function parseImpositionSvgSource(input: { sourceId: string; fileName: string; svgText: string; widthMm?: number; heightMm?: number }): ExportSvgSource {
  const root = parse(decodeSource(input.svgText, input.widthMm, input.heightMm))
  root.querySelectorAll('script').forEach(element => element.remove())
  freezeStyles(root)
  const rules = cssRules(root); const layers: ExportSvgLayer[] = []
  const walk = (element: Element, path: number[]) => {
    if (RESOURCE_TAGS.has(tag(element)) || NON_PAINT_TAGS.has(tag(element))) return
    if (CONTAINER_TAGS.has(tag(element))) { children(element).forEach((child, index) => walk(child, [...path, index])); return }
    const category = layerCategory(element, rules, root)
    const label = element.getAttribute('inkscape:label') || element.getAttribute('aria-label') || element.getAttribute('id') || `${element.localName} ${layers.length + 1}`
    layers.push({ id: `layer-${path.join('-')}`, label, tagName: element.localName, category, defaultGroupId: category === 'unknown' ? undefined : category, nodePath: path })
  }
  walk(root, [])
  const images = layers.filter(layer => layer.category === 'images')
  if (images[0]) images[0].defaultGroupId = 'image-front'
  if (images[1]) images[1].defaultGroupId = 'image-back'
  const warnings: string[] = []
  if (layers.some(layer => layer.category === 'unknown')) warnings.push('未知图层需要选择导出类型，或明确选择不导出。')
  if (root.querySelector('use')) warnings.push('引用图层 use 会作为一个完整图层处理，保留它引用的原始资源。')
  // Corel exports can retain an invisible clipping trace alongside a stroked
  // hanging hole. Calling both "paths" does not make the trace printable.
  // Diagnose the original paint; never invent a cutting stroke or replace the
  // customer's curve with the solver's simplified collision polygon.
  const closedPaths = layers.filter(layer => layer.tagName.toLowerCase() === 'path').map(layer => ({ layer, element: resolveNode(root, layer.nodePath) }))
    .filter(({ element }) => /z/i.test(element.getAttribute('d') ?? ''))
  const hasStrokedContour = closedPaths.some(({ element }) => paintProperty(element, 'stroke', rules) !== 'none')
  const contourWarnings = images.length && !hasStrokedContour ? closedPaths
    .filter(({ element }) => paintProperty(element, 'fill', rules) === 'none' && paintProperty(element, 'stroke', rules) === 'none')
    .map(({ layer }) => `图层“${layer.label}”的闭合路径没有填充和描边，原始 SVG 缺少可见外轮廓；PDF / DXF 不会输出该路径，挂孔不代表外轮廓完整。`) : []
  return { sourceId: input.sourceId, fileName: input.fileName, svgText: serialize(root), layers, warnings, contourWarnings }
}

function resolveNode(root: Element, path: number[]) { return path.reduce((node, index) => children(node)[index], root) }

function pruneUnusedDefinitions(root: Element) {
  const definitions = Array.from(root.querySelectorAll('defs'))
  if (!definitions.length) return
  const ids = new Map(Array.from(root.querySelectorAll('[id]')).map(node => [node.id, node]))
  const required = new Set<string>()
  const collect = (element: Element) => {
    const values = Array.from(element.attributes).map(attribute => attribute.value)
    if (tag(element) === 'style') values.push(element.textContent ?? '')
    for (const value of values) {
      const refs = [...value.matchAll(/url\(\s*['"]?#([^)'"\s]+)/g)].map(match => match[1])
      if (/^#[^\s]+$/.test(value) && (element.getAttribute('href') === value || element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') === value)) refs.push(value.slice(1))
      for (const id of refs) {
        if (required.has(id)) continue
        required.add(id)
        const resource = ids.get(id)
        if (resource) [resource, ...Array.from(resource.querySelectorAll('*'))].forEach(collect)
      }
    }
  }
  ;[root, ...Array.from(root.querySelectorAll('*'))].filter(element => !definitions.some(def => def.contains(element))).forEach(collect)
  for (const defs of definitions) for (const child of children(defs)) {
    const resourceNodes = [child, ...Array.from(child.querySelectorAll('*'))]
    if (!resourceNodes.some(node => required.has(node.id) || ['style', 'font', 'font-face'].includes(tag(node)))) child.remove()
  }
  definitions.filter(defs => !defs.childElementCount).forEach(defs => defs.remove())
}

export function filteredRoot(source: ExportSvgSource, selected: Set<string>) {
  const root = parse(source.svgText)
  const omitted = source.layers.filter(layer => !selected.has(layer.id)).map(layer => resolveNode(root, layer.nodePath))
  // References into the visible drawing must survive removal of that drawing.
  // A dedicated full source in defs preserves nested transforms/styles/ids for
  // use targets without causing an omitted original to paint on the board.
  const bodyTargets = new Set(Array.from(root.querySelectorAll('use')).flatMap(element => {
    const href = element.getAttribute('href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    const target = href?.startsWith('#') ? Array.from(root.querySelectorAll('[id]')).find(node => node.id === href.slice(1)) : undefined
    return target && !Array.from(root.querySelectorAll('defs')).some(def => def.contains(target)) ? [target.id] : []
  }))
  if (bodyTargets.size) {
    const copy = root.cloneNode(true) as Element
    const copyMap = new Map(Array.from(copy.querySelectorAll('[id]')).map(node => [node.id, `reference-${node.id}`]))
    if (copy.id) copyMap.set(copy.id, `reference-${copy.id}`)
    rewriteIds(copy, copyMap)
    const defs = root.ownerDocument.createElementNS(SVG_NS, 'defs'); defs.append(copy); root.append(defs)
    for (const use of Array.from(root.querySelectorAll('use'))) {
      const href = use.getAttribute('href') ?? use.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
      if (href?.startsWith('#') && bodyTargets.has(href.slice(1))) { use.setAttribute('href', `#reference-${href.slice(1)}`); use.removeAttributeNS('http://www.w3.org/1999/xlink', 'href') }
    }
  }
  omitted.forEach(element => element.remove())
  pruneUnusedDefinitions(root)
  return root
}

function escapeRegex(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function rewriteReferences(value: string, map: Map<string, string>) {
  return value.replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g, (match, _quote: string, id: string) => map.has(id) ? `url(#${map.get(id)})` : match)
}
function rewriteIds(root: Element, map: Map<string, string>) {
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      let value = rewriteReferences(attribute.value, map)
      if (attribute.localName === 'id') value = map.get(value) ?? value
      else if (attribute.localName === 'href' && value.startsWith('#')) value = `#${map.get(value.slice(1)) ?? value.slice(1)}`
      else if (['aria-labelledby', 'aria-describedby'].includes(attribute.localName)) value = value.split(/\s+/).map(id => map.get(id) ?? id).join(' ')
      if (value !== attribute.value) element.setAttributeNS(attribute.namespaceURI, attribute.name, value)
    }
    if (tag(element) === 'style') {
      let css = rewriteReferences(element.textContent ?? '', map)
      for (const [oldId, newId] of [...map].sort((a, b) => b[0].length - a[0].length)) css = css.replace(new RegExp(`#${escapeRegex(oldId)}(?![\\w-])`, 'g'), `#${newId}`)
      element.textContent = css
    }
  }
}

function firstSelectorCompound(selector: string) {
  let depth = 0; let quote = ''
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (quote) { if (c === quote && selector[i - 1] !== '\\') quote = ''; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '(') depth++
    else if (c === ']' || c === ')') depth--
    else if (!depth && /\s|>|\+|~/.test(c)) return [selector.slice(0, i), selector.slice(i)]
  }
  return [selector, '']
}
export function isolate(root: Element, prefix: string) {
  const map = new Map([root, ...Array.from(root.querySelectorAll('[id]'))].filter(node => node.id).map(node => [node.id, `${prefix}-${node.id}`]))
  rewriteIds(root, map)
  if (!root.id) root.id = `${prefix}-root`
  const rules = cssRules(root)
  if (rules.length) {
    root.querySelectorAll('style').forEach(node => node.remove())
    const style = root.ownerDocument.createElementNS(SVG_NS, 'style')
    style.textContent = rules.map(rule => {
      const selectors = rule.selectors.flatMap(selector => {
        const [head, tail] = firstSelectorCompound(selector)
        return [`#${root.id} ${selector}`, ...(matches(root, head) ? [`#${root.id}${tail}`] : [])]
      })
      return `${selectors.join(',')}{${rule.declarations}}`
    }).join('\n')
    root.prepend(style)
  }
}

export function buildSourceLayerPreview(source: ExportSvgSource, layerIds = source.layers.map(layer => layer.id)) {
  return serialize(filteredRoot(source, new Set(layerIds)))
}

export function createImpositionExportModel(input: { pages: PackedItem[][]; sources: Record<string, ExportSvgSource>; plateWidthMm: number; plateHeightMm: number; holes?: ImpositionExportHoles }): ImpositionExportModel {
  if (![input.plateWidthMm, input.plateHeightMm].every(value => Number.isFinite(value) && value > 0)) throw new Error('板材尺寸必须大于零')
  if (input.holes && (!Object.values(input.holes).every(value => Number.isFinite(value) && value >= 0) || !Number.isInteger(input.holes.count))) throw new Error('版面孔尺寸和数量无效')
  const grouped = new Map<string, ImpositionExportTemplate>()
  const contentIds = new Map<string, number>()
  const sourceIdentity = new Map(Object.values(input.sources).map(source => {
    let id = contentIds.get(source.svgText)
    if (id === undefined) { id = contentIds.size; contentIds.set(source.svgText, id) }
    return [source.sourceId, id]
  }))
  // Source ids, file contents and positions are part of the print identity.
  // Intern the source content once; never expand embedded bitmaps per QT copy.
  // This deliberately does not merge boards on silhouette similarity alone.
  input.pages.forEach((placements, pageIndex) => {
    if (!placements.length) return
    for (const item of placements) if (!input.sources[sourceIdOf(item)]) throw new Error(`图片 ${item.image.name || sourceIdOf(item)} 尚未读取原始 SVG`)
    const key = JSON.stringify(placements.map(item => JSON.stringify([sourceIdOf(item), item.image.filePath, sourceIdentity.get(sourceIdOf(item)), item.x, item.y, item.width, item.height, ((item.rotation ?? 0) % 360 + 360) % 360])).sort())
    const prior = grouped.get(key)
    if (prior) { prior.pageIndices.push(pageIndex); prior.productionCopies++ }
    else grouped.set(key, { id: `template-${grouped.size + 1}`, pageIndices: [pageIndex], productionCopies: 1, placements, sourceIds: [...new Set(placements.map(sourceIdOf))] })
  })
  const sources = input.sources
  return { sources, templates: [...grouped.values()], groups: IMPOSITION_EXPORT_TYPES.map(group => ({ ...group })), assignments: Object.fromEntries(Object.values(sources).map(source => [source.sourceId, Object.fromEntries(source.layers.map(layer => [layer.id, layer.defaultGroupId]))])), plateWidthMm: input.plateWidthMm, plateHeightMm: input.plateHeightMm, holes: input.holes && { ...input.holes } }
}

function assignment(model: ImpositionExportModel, templateId: string, sourceId: string, layerId: string) {
  const local = model.templateAssignments?.[templateId]?.[sourceId]
  return local && Object.hasOwn(local, layerId) ? local[layerId] : model.assignments[sourceId]?.[layerId]
}
const normalizedFileName = (fileName: string) => (fileName.split(/[\\/]/).pop() ?? fileName).normalize('NFC').trim().toLocaleLowerCase('en-US')

/** A filename alone is not enough: regenerated SVGs may have unrelated layers
 * at the same child indices. Match the complete named layer structure first. */
function layerMapping(from: ExportSvgSource, into: ExportSvgSource): Map<string, string> | undefined {
  if (from.layers.length !== into.layers.length) return undefined
  const signature = (layer: ExportSvgLayer) => JSON.stringify([layer.nodePath, layer.tagName, layer.label, layer.category])
  const targets = new Map(into.layers.map(layer => [signature(layer), layer.id]))
  if (targets.size !== into.layers.length) return undefined
  const pairs = from.layers.map(layer => [layer.id, targets.get(signature(layer))] as const)
  return pairs.every(([, id]) => id !== undefined) ? new Map(pairs as [string, string][]) : undefined
}

export function applySourceAssignmentsToSameName(model: ImpositionExportModel, templateId: string, sourceId: string) {
  const source = model.sources[sourceId]
  const template = model.templates.find(board => board.id === templateId)
  if (!source || !template?.sourceIds.includes(sourceId)) return { model, appliedSources: 0, skippedSources: 0 }
  const templateAssignments = { ...model.templateAssignments }
  const matches = new Map<string, Map<string, string>>()
  let skippedSources = 0
  for (const target of Object.values(model.sources)) {
    if (normalizedFileName(target.fileName) !== normalizedFileName(source.fileName)) continue
    const mapping = layerMapping(source, target)
    if (mapping) matches.set(target.sourceId, mapping)
    else skippedSources++
  }
  for (const board of model.templates) {
    const assignments = { ...templateAssignments[board.id] }
    for (const targetId of board.sourceIds) {
      const mapping = matches.get(targetId)
      if (!mapping) continue
      assignments[targetId] = Object.fromEntries([...mapping].map(([from, into]) => [into, assignment(model, templateId, sourceId, from)]))
    }
    templateAssignments[board.id] = assignments
  }
  return { model: { ...model, templateAssignments }, appliedSources: matches.size, skippedSources }
}

/** Ordinary PDF pages and their previews share the same face membership.
 * Use explicit faces when the board has valid front/back artwork. Unrelated
 * image layers keep separate numbered pages instead of entering either face. */
export function impositionImageChannels(model: ImpositionExportModel, templateId: string): Record<string, string | string[]>[] {
  const template = model.templates.find(board => board.id === templateId)
  if (!template) return []
  const sources = template.sourceIds.map(id => {
    const layers = model.sources[id].layers
    const assigned = Object.fromEntries(layers.map(layer => [layer.id, assignment(model, templateId, id, layer.id)]))
    return { id, images: orderedImageLayers(model.sources[id], assigned),
      front: layers.filter(layer => assigned[layer.id] === 'image-front'),
      back: layers.filter(layer => assigned[layer.id] === 'image-back'), assigned }
  })
  const faces = sources.some(source => source.back.length && source.front.length)
    && sources.every(source => !source.images.length || source.front.length)
  const channels: Record<string, string | string[]>[] = []
  const add = (index: number, id: string, ids: string[]) => {
    if (ids.length) (channels[index] ??= {})[id] = ids.length === 1 ? ids[0] : ids
  }
  for (const source of sources) {
    if (faces) {
      add(0, source.id, source.front.map(layer => layer.id))
      add(1, source.id, (source.back.length ? source.back : source.front).map(layer => layer.id))
      source.images.filter(layer => source.assigned[layer.id] === 'images').forEach((layer, index) => add(index + 2, source.id, [layer.id]))
    } else source.images.forEach((layer, index) => add(index, source.id, [layer.id]))
  }
  return channels
}

const imageChannelIncludes = (member: string | string[] | undefined, layerId: string) => Array.isArray(member) ? member.includes(layerId) : member === layerId

/** Metadata is small; render each SVG only immediately before its PDF write. */
export function enumerateImpositionSvgExports(model: ImpositionExportModel, options: ExportOptions = {}): ImpositionSvgExportMetadata[] {
  const timestamp = exportTimestamp(options.date ?? new Date())
  const result: Omit<ImpositionSvgExportMetadata, 'fileName'>[] = []
  const groupIds = new Set(IMPOSITION_EXPORT_TYPES.map(group => group.id))
  const channelsByTemplate = new Map(model.templates.map(template => [template.id, impositionImageChannels(model, template.id)]))
  const imageChannelCount = Math.max(0, ...[...channelsByTemplate.values()].map(channels => channels.length))
  model.templates.forEach((template, index) => {
    if (options.templateIds && !options.templateIds.includes(template.id)) return
    const present = new Set<string>()
    const imageChannels = channelsByTemplate.get(template.id)!
    for (const sourceId of template.sourceIds) {
      for (const layer of model.sources[sourceId].layers) {
        const value = assignment(model, template.id, sourceId, layer.id)
        const group = isImageAssignment(value) ? 'images' : value
        if (group === undefined) throw new Error(`方案 ${index + 1} 的 ${model.sources[sourceId].fileName}：图层“${layer.label}”尚未选择类型，请选择导出类型或不导出`)
        if (group === null) continue
        if (!groupIds.has(group)) throw new Error(`图层“${layer.label}”的导出类型无效，请重新选择`)
        present.add(group)
      }
    }
    const add = (groupId: string, groupName: string, groupNumber: number, imageLayerIndex?: number) => {
      if (!present.has(groupId) || options.groupIds && !options.groupIds.includes(groupId)) return
      result.push({ widthMm: model.plateWidthMm, heightMm: model.plateHeightMm, templateId: template.id, templateNumber: index + 1, groupId, groupName, groupNumber, productionCopies: template.productionCopies, ...(imageLayerIndex === undefined ? {} : { imageLayerIndex, imageLayerMembers: imageChannels[imageLayerIndex] }) })
    }
    add('paths', '轮廓 / 路径', 1)
    imageChannels.forEach((_members, imageIndex) => add('images', `图片 ${imageIndex + 1}（全板）`, imageIndex + 2, imageIndex))
    add('fills', '彩窗', imageChannelCount + 2)
    add('white', '白墨', imageChannelCount + 3)
  })
  // Only boards that actually produce files count toward B. Keep canvas order
  // even when checkbox selection order differs, and retain templateNumber for UI.
  const boardNumbers = new Map([...new Set(result.map(entry => entry.templateId))].map((id, index) => [id, index + 1]))
  const boardDigits = String(boardNumbers.size).length
  return result.map(entry => {
    const typeName = entry.groupId === 'images' ? `图片${entry.imageLayerIndex! + 1}` : entry.groupId === 'paths' ? '轮廓' : entry.groupName
    const boardNumber = String(boardNumbers.get(entry.templateId)).padStart(boardDigits, '0')
    // One exported set represents all production copies; image channels never
    // increment F, which always records 1 of the requested production quantity.
    return { ...entry, fileName: `${typeName}_${timestamp}_${boardNumber}B-${boardNumbers.size}B_1F-${entry.productionCopies}F.pdf` }
  })
}

/** One PDF per physical layout. Keep only the small page metadata in memory;
 * each full-board SVG is rendered when its page is transferred for conversion. */
export function enumerateImpositionPdfExports(model: ImpositionExportModel, options: ExportOptions = {}): ImpositionPdfExportMetadata[] {
  const date = options.date ?? new Date()
  const timestamp = exportTimestamp(date)
  const pages = enumerateImpositionSvgExports(model, { ...options, date })
  const boards = new Map<string, ImpositionSvgExportMetadata[]>()
  for (const page of pages) {
    const board = boards.get(page.templateId)
    if (board) board.push(page)
    else boards.set(page.templateId, [page])
  }
  const digits = String(boards.size).length
  return [...boards.values()].map((pages, index) => {
    const { widthMm, heightMm, templateId, templateNumber, productionCopies } = pages[0]
    const fileName = `${timestamp}_${String(index + 1).padStart(digits, '0')}B-${boards.size}B_1F-${productionCopies}F.pdf`
    return { fileName, widthMm, heightMm, templateId, templateNumber, productionCopies, pages: pages.map(page => ({ ...page, fileName })) }
  })
}

/** x/y denote the top-left of the rotated source frame, just like Konva. */
export function impositionPlacementTransform(item: Pick<PackedItem, 'x' | 'y' | 'width' | 'height'> & { rotation?: number }) {
  if (![item.x, item.y, item.width, item.height, item.rotation ?? 0].every(Number.isFinite) || item.width <= 0 || item.height <= 0) throw new Error('拼版图片位置或尺寸无效')
  const rotation = item.rotation ?? 0; const angle = rotation * Math.PI / 180
  const width = Math.abs(Math.cos(angle)) * item.width + Math.abs(Math.sin(angle)) * item.height
  const height = Math.abs(Math.sin(angle)) * item.width + Math.abs(Math.cos(angle)) * item.height
  return `translate(${number(item.x + width / 2)} ${number(item.y + height / 2)}) rotate(${number(rotation)}) translate(${number(-item.width / 2)} ${number(-item.height / 2)})`
}

export function sourceViewport(svg: Element) {
  const length = (raw: string | null) => {
    const match = /^\s*([\d.]+)\s*(mm|cm|in|pt|pc|px)?\s*$/.exec(raw ?? '')
    return match ? Number(match[1]) * ({ mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16, px: 1 }[match[2] || 'px'] ?? 1) : undefined
  }
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const ratio = viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0 ? viewBox[2] / viewBox[3] : 2
  const originalWidth = length(svg.getAttribute('width')); const originalHeight = length(svg.getAttribute('height'))
  const width = originalWidth || (originalHeight ? originalHeight * ratio : viewBox?.[2] || 300)
  const height = originalHeight || (originalWidth ? originalWidth / ratio : viewBox?.[3] || 150)
  return { width, height }
}

function renderBoardLayers(model: ImpositionExportModel, templateId: string, prefixId: string, include: (sourceId: string, layerId: string) => boolean, solidHoles = false) {
  const template = model.templates.find(item => item.id === templateId)
  if (!template) throw new Error('导出方案已不存在，请重新打开导出管理')
  const root = document.createElementNS(SVG_NS, 'svg')
  root.setAttribute('width', `${number(model.plateWidthMm)}mm`); root.setAttribute('height', `${number(model.plateHeightMm)}mm`)
  root.setAttribute('viewBox', `0 0 ${number(model.plateWidthMm)} ${number(model.plateHeightMm)}`)
  const definitions = root.ownerDocument.createElementNS(SVG_NS, 'defs')
  root.append(definitions)
  const filtered = new Map<string, Element>()
  const sharedFrames = new Map<string, string>()
  template.placements.forEach(item => {
    const sourceId = sourceIdOf(item); const source = model.sources[sourceId]
    const frameKey = JSON.stringify([sourceId, item.width, item.height])
    let frameId = sharedFrames.get(frameKey)
    if (!frameId) {
      let prototype = filtered.get(sourceId)
      if (!prototype) {
        const selected = source.layers.filter(layer => include(sourceId, layer.id)).map(layer => layer.id)
        if (!selected.length) return
        prototype = filteredRoot(source, new Set(selected)); filtered.set(sourceId, prototype)
      }
      const svg = prototype.cloneNode(true) as Element
      const prefix = `pf-${prefixId}-${sharedFrames.size}`
      isolate(svg, prefix)
      const intrinsic = sourceViewport(svg)
      svg.setAttribute('x', '0'); svg.setAttribute('y', '0')
      // Reproduce the original image viewport, then stretch its complete frame
      // into Konva millimeters. This also preserves original letterboxing.
      svg.setAttribute('width', number(intrinsic.width)); svg.setAttribute('height', number(intrinsic.height))
      const frame = root.ownerDocument.createElementNS(SVG_NS, 'svg')
      frame.setAttribute('data-source-frame', sourceId)
      frame.setAttribute('width', number(item.width)); frame.setAttribute('height', number(item.height))
      frame.setAttribute('viewBox', `0 0 ${number(intrinsic.width)} ${number(intrinsic.height)}`)
      frame.setAttribute('preserveAspectRatio', 'none'); frame.setAttribute('overflow', 'hidden')
      frame.append(root.ownerDocument.importNode(svg, true))
      frameId = `${prefix}-shared-frame`
      const resource = root.ownerDocument.createElementNS(SVG_NS, 'g')
      resource.id = frameId; resource.append(frame); definitions.append(resource)
      sharedFrames.set(frameKey, frameId)
    }
    const placed = root.ownerDocument.createElementNS(SVG_NS, 'g')
    placed.setAttribute('data-source-id', sourceId); placed.setAttribute('transform', impositionPlacementTransform(item))
    placed.setAttribute('data-placement-id', item.image.id)
    const use = root.ownerDocument.createElementNS(SVG_NS, 'use')
    use.setAttribute('href', `#${frameId}`)
    placed.append(use); root.append(placed)
  })
  const holes = model.holes
  if (holes && holes.count > 0 && holes.sizeMm > 0) {
    const holeGroup = root.ownerDocument.createElementNS(SVG_NS, 'g')
    holeGroup.setAttribute('data-board-holes', 'true')
    holeGroup.setAttribute('fill', solidHoles ? '#000000' : 'none')
    holeGroup.setAttribute('stroke', solidHoles ? 'none' : BOARD_HOLE_COLOR)
    holeGroup.setAttribute('stroke-width', number(BOARD_HOLE_STROKE_MM))
    const { startMm, pitchMm } = boardHoleLayout(model.plateHeightMm, holes.count, holes.sizeMm, holes.gapMm)
    for (let index = 0; index < holes.count; index++) {
      const hole = root.ownerDocument.createElementNS(SVG_NS, 'path')
      hole.setAttribute('data-hole-center-x-mm', number(holes.leftMm + holes.sizeMm / 2))
      hole.setAttribute('data-hole-center-y-mm', number(startMm + index * pitchMm + holes.sizeMm / 2))
      hole.setAttribute('data-hole-radius-mm', number(holes.sizeMm / 2))
      hole.setAttribute('d', boardHolePath(holes.leftMm, startMm + index * pitchMm, holes.sizeMm))
      holeGroup.append(hole)
    }
    root.append(holeGroup)
  }
  return serialize(root)
}

export function renderImpositionSvgExport(model: ImpositionExportModel, entry: ImpositionSvgExportMetadata) {
  return renderBoardLayers(model, entry.templateId, `${entry.templateNumber}-${entry.groupNumber}`, (sourceId, layerId) => {
    const value = assignment(model, entry.templateId, sourceId, layerId)
    if ((isImageAssignment(value) ? 'images' : value) !== entry.groupId) return false
    return entry.groupId !== 'images' || imageChannelIncludes(entry.imageLayerMembers?.[sourceId], layerId)
  }, entry.groupId !== 'paths')
}

/** A combined board preview is independent of the numbered image channels. */
export function buildImpositionTemplatePreview(model: ImpositionExportModel, templateId: string, type = 'all', imageLayerIndex?: number) {
  let imageMembers: Record<string, string | string[]> | undefined
  if (type === 'images' && imageLayerIndex !== undefined) {
    if (!Number.isInteger(imageLayerIndex) || imageLayerIndex < 0) throw new Error('图片图层序号无效')
    imageMembers = impositionImageChannels(model, templateId)[imageLayerIndex] ?? {}
  }
  const faces = type === 'image-front' ? 0 : type === 'image-back' ? 1 : undefined
  if (faces !== undefined && impositionImageChannels(model, templateId).length > 1) {
    const assignedSources = (model.templates.find(board => board.id === templateId)?.sourceIds ?? []).map(id => model.sources[id].layers.map(layer => assignment(model, templateId, id, layer.id)))
    if (assignedSources.some(values => values.includes('image-back')) && assignedSources.every(values => !values.some(isImageAssignment) || values.includes('image-front'))) imageMembers = impositionImageChannels(model, templateId)[faces]
  }
  return renderBoardLayers(model, templateId, 'preview', (sourceId, layerId) => imageMembers ? imageChannelIncludes(imageMembers[sourceId], layerId) : type === 'all' || (type === 'images' ? isImageAssignment(assignment(model, templateId, sourceId, layerId)) : assignment(model, templateId, sourceId, layerId) === type), type !== 'all' && type !== 'paths')
}

export function buildImpositionSvgExports(model: ImpositionExportModel, options: ExportOptions = {}): ImpositionSvgExportPage[] {
  return enumerateImpositionSvgExports(model, options).map(entry => ({ ...entry, svg: renderImpositionSvgExport(model, entry) }))
}
