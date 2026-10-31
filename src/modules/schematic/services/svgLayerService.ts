export type SvgLayer = { id: string; label: string; role?: SourceLayerRole; imageNodeIds?: string[]; tag?: string }
export type SourceLayerRole = 'front' | 'window' | 'back' | ''
export type SourceLayerRoleImage = { nodeId?: string; layerRole?: string }

type SvgNode = {
  start: number
  openEnd: number
  end: number
  tag: string
  attributes: Map<string, string>
  parent?: SvgNode
  children: SvgNode[]
  resource: boolean
}

// Resource images (patterns, masks and clipping paths) belong to the artwork,
// rather than the list of artwork layers a user can switch between.
const RESOURCE_TAGS = new Set(['defs', 'clippath', 'mask', 'pattern', 'marker', 'symbol', 'lineargradient', 'radialgradient', 'filter', 'metadata', 'style', 'script', 'title', 'desc'])
const PAINT_TAGS = new Set(['image', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use', 'foreignobject'])

function decodeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, name: string) => {
    const predefined: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }
    if (name in predefined) return predefined[name]
    const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}

function parseNodes(svg: string): SvgNode[] {
  // Preserve original XML instead of serializing a DOM: transforms, namespace
  // prefixes, authored coordinates and embedded resource bytes stay untouched.
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g
  const nodes: SvgNode[] = []
  const stack: SvgNode[] = []
  for (const match of svg.matchAll(tokens)) {
    const xml = match[0]
    const tagMatch = xml.match(/^<(\/?)([\w:.-]+)/)
    if (!tagMatch) continue
    const tag = tagMatch[2].split(':').at(-1)!.toLowerCase()
    if (tagMatch[1]) {
      const node = stack.at(-1)
      if (node?.tag === tag) {
        node.end = match.index + xml.length
        stack.pop()
      }
      continue
    }
    const attributes = new Map<string, string>()
    for (const attribute of xml.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes.set(attribute[1].toLowerCase(), decodeXml(attribute[2] ?? attribute[3]))
    }
    const parent = stack.at(-1)
    const node: SvgNode = { start: match.index, openEnd: match.index + xml.length, end: match.index + xml.length, tag, attributes, parent, children: [], resource: !!parent?.resource || RESOURCE_TAGS.has(tag) }
    parent?.children.push(node)
    nodes.push(node)
    if (!/\/\s*>$/.test(xml)) stack.push(node)
  }
  return nodes
}

function name(node: SvgNode): string | undefined {
  return node.attributes.get('inkscape:label') || node.attributes.get('data-name') || node.attributes.get('aria-label') || node.attributes.get('id')
}

function containsPaint(node: SvgNode): boolean {
  return !node.resource && (PAINT_TAGS.has(node.tag) || node.children.some(containsPaint))
}

function imageCount(node: SvgNode): number {
  if (node.resource) return 0
  return node.tag === 'image'
    ? 1
    : node.children.reduce((count, child) => count + imageCount(child), 0)
}

function imageBearingChildGroups(node: SvgNode): SvgNode[] {
  return node.children.filter(child => child.tag === 'g' && imageCount(child) > 0)
}

/**
 * CorelDRAW often places two faces inside anonymous sibling groups. They are
 * the selectable artwork boundaries even though their parent layer and the
 * faces themselves have no authored names. The old menu only surfaced the
 * named wrappers and the embedded bitmap nodes, which made both thumbnails
 * appear to be the same face.
 */
function isAnonymousArtworkBoundary(node: SvgNode): boolean {
  return node.tag === 'g'
    && !node.resource
    && !name(node)
    && containsPaint(node)
    && imageCount(node) > 0
    && Boolean(node.parent && imageBearingChildGroups(node.parent).length >= 2)
}

function hasAnonymousArtworkBoundaryAncestor(node: SvgNode, boundaries: Set<SvgNode>): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (boundaries.has(parent)) return true
  }
  return false
}

function hasMultiImageGroupDescendant(node: SvgNode): boolean {
  return node.children.some(child => child.tag === 'g'
    && (imageCount(child) > 1 || hasMultiImageGroupDescendant(child)))
}

/**
 * Named groups that only wrap several sibling faces are structural containers,
 * rather than a user-selectable face. Hiding them prevents duplicate "whole
 * design" entries while preserving named one-face groups in ordinary files.
 */
function isMultiFaceWrapper(node: SvgNode): boolean {
  return node.tag === 'g'
    && Boolean(name(node))
    && imageCount(node) > 1
    && (imageBearingChildGroups(node).length >= 2 || hasMultiImageGroupDescendant(node))
}

function layerNodes(nodes: SvgNode[]): SvgNode[] {
  const boundaries = new Set(nodes.filter(isAnonymousArtworkBoundary))
  return nodes.filter(node => {
    if (node.resource) return false
    if (node.tag === 'image') return !hasAnonymousArtworkBoundaryAncestor(node, boundaries)
    if (node.tag !== 'g' || !containsPaint(node) || isMultiFaceWrapper(node)) return false
    return Boolean(name(node) || node.attributes.get('inkscape:groupmode') === 'layer' || boundaries.has(node))
  })
}

function layerId(index: number): string { return `svg-layer-${index}` }

function imageNodeIds(node: SvgNode): string[] {
  if (node.tag === 'image') {
    const id = node.attributes.get('id')
    return id ? [id] : []
  }
  return [...new Set(node.children.flatMap(imageNodeIds))]
}

function inferredRole(value: string | undefined, index: number, count: number): SourceLayerRole {
  if (value === 'front' || value === 'window' || value === 'back') return value
  if (count === 1) return 'front'
  if (count === 2) return index === 0 ? 'back' : index === 1 ? 'front' : ''
  if (count === 3) return index === 0 ? 'back' : index === 1 ? 'window' : index === 2 ? 'front' : ''
  return ''
}

function rolesForLayers(layers: readonly SvgLayer[], sourceImages: readonly SourceLayerRoleImage[]): SourceLayerRole[] {
  const roles = sourceImages.map((image, index) => inferredRole(image.layerRole, index, sourceImages.length))
  const roleByNodeId = new Map(sourceImages.map((image, index) => [image.nodeId, roles[index]] as const).filter(([nodeId]) => Boolean(nodeId)) as [string, SourceLayerRole][])
  return layers.map((layer, index) => {
    const matched = [...new Set((layer.imageNodeIds ?? []).map(nodeId => roleByNodeId.get(nodeId)).filter((role): role is SourceLayerRole => Boolean(role)))]
    // Older callers/tests only provide parallel arrays. Keep that fallback for
    // flat SVGs whose layer and source-image counts still match.
    return matched.length === 1 ? matched[0] : sourceImages.length === layers.length ? roles[index] : ''
  })
}

/**
 * A color-window image is a shared overlay. When a user chooses either face
 * in the arrange-page layer menu, keep the window layer selected with it.
 * Source image order is the same paint order used by the SVG layer parser.
 */
export function withWindowLayerOverlay(layers: readonly SvgLayer[], selectedIds: readonly string[], sourceImages?: readonly SourceLayerRoleImage[]) {
  if (!sourceImages?.length) return [...selectedIds]
  const roles = sourceImages.map((image, index) => inferredRole(image.layerRole, index, sourceImages.length))
  if (!roles.includes('window')) return [...selectedIds]
  const resolvedLayerRoles = rolesForLayers(layers, sourceImages)
  const layerRoles = layers.map((layer, index) => layer.role || resolvedLayerRoles[index] || '')
  if (!selectedIds.some(id => {
    const index = layers.findIndex(layer => layer.id === id)
    return index >= 0 && (layerRoles[index] === 'front' || layerRoles[index] === 'back')
  })) return [...selectedIds]
  const windowLayers = layers.map((layer, index) => ({ layer, index }))
    .filter(({ index }) => layerRoles[index] === 'window')
  if (!windowLayers.length) return [...selectedIds]
  // A named group and its child image can both be selectable. Add the outer
  // window group when it covers the same image IDs, and skip the redundant
  // child layer so the stored selection remains stable and readable.
  const covered = new Set<string>()
  const windowIds = new Set<string>()
  for (const { layer } of windowLayers) {
    const ids = layer.imageNodeIds ?? []
    if (ids.length && ids.every(id => covered.has(id))) continue
    windowIds.add(layer.id)
    ids.forEach(id => covered.add(id))
    if (!ids.length) break
  }
  return layers.filter(layer => selectedIds.includes(layer.id) || windowIds.has(layer.id)).map(layer => layer.id)
}

/** Enumerate selectable artwork layers in source order, excluding SVG resources. */
const ROLE_LABELS: Record<Exclude<SourceLayerRole, ''>, string> = { front: '正面', window: '彩窗', back: '背面' }

export function svgLayers(svg: string, sourceImages?: readonly SourceLayerRoleImage[]): SvgLayer[] {
  const layers = layerNodes(parseNodes(svg)).map((node, index) => ({ id: layerId(index), label: name(node) || `${node.tag === 'image' ? '图片' : '图层'} ${index + 1}`, imageNodeIds: imageNodeIds(node), tag: node.tag }))
  if (!sourceImages?.length) return layers
  const roles = rolesForLayers(layers, sourceImages)
  return layers.map((layer, index) => {
    const role = roles[index]
    return role ? { ...layer, role, label: `${layer.label}（${ROLE_LABELS[role]}）` } : layer
  })
}

function contains(parent: SvgNode, child: SvgNode): boolean {
  return parent.start <= child.start && parent.end >= child.end
}

function isCutline(node: SvgNode): boolean {
  return /cut[\s_-]*line|die[\s_-]*cut|outline|轮廓|刀线|切割/i.test(name(node) ?? '')
}

function containsCutline(node: SvgNode): boolean {
  return isCutline(node) || node.children.some(containsCutline)
}

function revealTag(tag: string): string {
  const style = /\bstyle\s*=\s*(?:"[^"]*"|'[^']*')/i
  const visibility = 'display:inline!important;visibility:visible!important'
  const existing = tag.match(style)?.[0]
  if (!existing) return tag.replace(/\/?\s*>$/, ending => ` style="${visibility}"${ending}`)
  const quote = existing.match(/=\s*(["'])/)![1]
  const valueStart = existing.indexOf(quote) + 1
  const value = existing.slice(valueStart, -1)
  return tag.replace(style, `style=${quote}${value};${visibility}${quote}`)
}

/**
 * Select from the original SVG, not a previously filtered result. Its viewport
 * and ancestors are preserved so switching a layer never moves/resizes artwork.
 * Image selection retains vector cutlines, matching the existing Back behavior.
 */
export function selectSvgLayer(svg: string, id: string): string {
  return selectSvgLayers(svg, [id])
}

/** Select several layers from one source while preserving their original paint order. */
export function selectSvgLayers(svg: string, ids: readonly string[]): string {
  const nodes = parseNodes(svg)
  const layers = layerNodes(nodes)
  const requestedIds = new Set(ids)
  const selected = layers.filter((_node, index) => requestedIds.has(layerId(index)))
  if (!selected.length) return svg
  const hasSelectedGroup = selected.some(node => node.tag === 'g')
  const layerSet = new Set(layers)

  const omitted = nodes.filter(node => {
    if (node.resource || selected.some(layer => contains(node, layer) || contains(layer, node))) return false
    if (node.tag === 'image') return true
    return hasSelectedGroup && layerSet.has(node) && !containsCutline(node)
  })
  // Removing a complete sibling group also removes its image children. Avoid
  // overlapping replacements so offsets always refer to the unmodified source.
  const removals = omitted.filter(node => !omitted.some(parent => parent !== node && contains(parent, node)))
  const patches = removals.map(node => ({ start: node.start, end: node.end, text: '' }))
  // Several selected layers can share ancestors (or be nested in each other).
  // Rewrite each opening tag once so source offsets remain valid.
  const revealed = new Set<SvgNode>()
  for (const layer of selected) {
    for (let node: SvgNode | undefined = layer; node; node = node.parent) revealed.add(node)
  }
  for (const node of revealed) {
    patches.push({ start: node.start, end: node.openEnd, text: revealTag(svg.slice(node.start, node.openEnd)) })
  }
  let result = svg
  for (const patch of patches.sort((a, b) => b.start - a.start)) result = result.slice(0, patch.start) + patch.text + result.slice(patch.end)
  return result
}
