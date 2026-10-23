import { describe, expect, test } from 'vitest'
import { applySourceAssignmentsToSameName, buildImpositionSvgExports, buildImpositionTemplatePreview, buildSourceLayerPreview, createImpositionExportModel, enumerateImpositionPdfExports, enumerateImpositionSvgExports, impositionPlacementTransform, parseImpositionSvgSource, renderImpositionSvgExport } from '../src/modules/imposition/impositionSvgExport'
import type { PackedItem } from '../src/modules/imposition/packingAlgorithms'
import type { ProductionImage } from '../src/modules/imposition/impositionRecords'

const image = (id = 'art'): ProductionImage => ({ id, name: id, sourceFileName: '产品.svg', filePath: `assets/${id}.svg`, widthMm: 40, heightMm: 20, productId: '', productName: '', attributes: {}, attributeImages: {}, note: '', noteImage: null, productGroupId: '', productGroupLeaderId: '', productGroupPosition: 0 })
const item = (id = 'art', extra: Partial<PackedItem> = {}): PackedItem => ({ image: image(id), x: 10, y: 12, width: 40, height: 20, rotation: 0, ...extra })
const read = (svg: string) => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(doc.querySelector('parsererror')).toBeNull()
  return doc
}
const parseSource = (content: string, sourceId = 'art') => parseImpositionSvgSource({ sourceId, fileName: '产品.svg', svgText: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 400 200">${content}</svg>` })
const source = parseSource('<path id="cut" fill="none" stroke="magenta" d="M10 20h400v200H10z"/><image href="data:image/png;base64,AQ==" x="10" y="20" width="400" height="200"/><rect x="20" y="30" width="20" height="20" fill="red"/>')
const date = new Date(2026, 9, 14, 9, 30, 58)
const model = (pages = [[item()]], sources = { art: source }) => createImpositionExportModel({ pages, sources, plateWidthMm: 300, plateHeightMm: 464 })

describe('imposition export SVG layers', () => {
  test('reports an unpainted closed contour beside artwork even when a hanging hole is stroked', () => {
    const source = parseSource('<style>.fil0{fill:none}.str0{stroke:#EC2A90}</style><g><image width="400" height="200" href="data:image/png;base64,AQ=="/><path id="trace" class="fil0" d="M10 20h400v200H10z"/><circle class="fil0 str0" cx="210" cy="30" r="4"/></g>')
    expect(source.contourWarnings).toEqual(['图层“trace”的闭合路径没有填充和描边，原始 SVG 缺少可见外轮廓；PDF / DXF 不会输出该路径，挂孔不代表外轮廓完整。'])
    const staged = read(buildImpositionSvgExports(model([[item()]], { art: source }))[0].svg)
    expect(staged.querySelector('[id$="-trace"]')?.getAttribute('style')).toBe('fill:none')
  })

  test('does not confuse transparent image clipping traces with an existing visible cut outline', () => {
    const source = parseSource('<image width="400" height="200" href="data:image/png;base64,AQ=="/><path fill="none" d="M10 20h400v200H10z"/><g stroke="magenta" fill="none"><path id="outer" d="M10 20h400v200H10z"/></g>')
    expect(source.contourWarnings).toEqual([])
  })

  test('classifies inherited and CSS paint, gradients and combined fill/stroke without duplicating paint', () => {
    const source = parseSource('<style>.filled{fill:url(#gradient)} .stroke {fill:none;stroke:blue}</style><defs><linearGradient id="gradient"><stop offset="0" stop-color="red"/></linearGradient></defs><g fill="none"><path id="a" d="M0 0h1" stroke="red"/><g fill="green"><path id="b" d="M0 0h1" stroke="red"/></g><path id="c" class="filled" d="M0 0h1"/><path id="d" class="stroke" d="M0 0h1"/></g><text id="note">manual</text>')
    expect(source.layers.map(layer => [layer.label, layer.category, layer.defaultGroupId])).toEqual([['a', 'paths', 'paths'], ['b', 'fills', 'fills'], ['c', 'fills', 'fills'], ['d', 'paths', 'paths'], ['note', 'unknown', undefined]])
    const current = model([[item()]], { art: source })
    expect(() => enumerateImpositionSvgExports(current)).toThrow('尚未选择类型')
    current.assignments.art[source.layers[4].id] = 'paths'
    const pages = buildImpositionSvgExports(current, { date })
    expect(pages).toHaveLength(2)
    expect(read(pages.find(page => page.groupId === 'fills')!.svg).querySelectorAll('path')).toHaveLength(2)
    expect(read(pages.find(page => page.groupId === 'paths')!.svg).querySelectorAll('path')).toHaveLength(2)
  })

  test('unknown layers require an explicit type or omission; same types merge without custom groups', () => {
    const source = parseSource('<text id="unknown">Label</text><path fill="none" stroke="black" d="M0 0h1"/><rect fill="red" width="1" height="1"/>')
    const current = model([[item()]], { art: source })
    current.assignments.art[source.layers[0].id] = null
    current.assignments.art[source.layers[1].id] = 'white'
    current.assignments.art[source.layers[2].id] = 'white'
    const entries = enumerateImpositionSvgExports(current, { date })
    expect(entries).toHaveLength(1)
    expect(entries[0].groupId).toBe('white')
    expect(entries[0].groupName).toBe('白墨')
    const doc = read(renderImpositionSvgExport(current, entries[0]))
    expect(doc.querySelector('text')).toBeNull()
    expect(doc.querySelector('path')).not.toBeNull()
    expect(doc.querySelector('rect')).not.toBeNull()
    current.assignments.art[source.layers[1].id] = 'custom'
    expect(() => enumerateImpositionSvgExports(current)).toThrow('导出类型无效')
  })

  test('numbered image channels combine different SVGs, retain QT/rotation/holes, and reuse same-face sources on the back page', () => {
    const art = parseSource('<image id="print-front" href="data:image/png;base64,AQ==" width="400" height="200"/><image id="print-back" href="data:image/png;base64,Ag==" width="400" height="200"/><path id="cut" fill="none" stroke="red" d="M0 0h40v20z"/>')
    const other = parseSource('<g><path fill="none" stroke="blue" d="M0 0h40v20z"/><image id="other-image" href="data:image/png;base64,Aw==" width="400" height="200"/></g>', 'other')
    const placements = [item('art', { rotation: 90 }), item('art', { x: 80, rotation: 180, image: { ...image(), id: 'art#qt-2', sourceImageId: 'art' } }), item('other', { x: 140, rotation: 37 }), item('other', { x: 180, y: 100, image: { ...image('other'), id: 'other#qt-2', sourceImageId: 'other' } })]
    const current = createImpositionExportModel({ pages: [placements, placements], sources: { art, other }, plateWidthMm: 300, plateHeightMm: 464, holes: { count: 2, sizeMm: 3, gapMm: 203.468, leftMm: 4 } })
    const entries = buildImpositionSvgExports(current, { date })
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map(entry => entry.fileName)).size).toBe(3)
    expect(entries.map(entry => entry.fileName)).toEqual(['轮廓', '图片1', '图片2'].map(type => `${type}_202610140930_1B-1B_1F-2F.pdf`))
    const imageEntries = entries.filter(entry => entry.groupId === 'images')
    expect(imageEntries.map(entry => [entry.imageLayerIndex, entry.groupName, entry.productionCopies])).toEqual([[0, '图片 1（全板）', 2], [1, '图片 2（全板）', 2]])
    expect(imageEntries[0].imageLayerMembers).toEqual({ art: art.layers[0].id, other: other.layers[1].id })
    expect(imageEntries[1].imageLayerMembers).toEqual({ art: art.layers[1].id, other: other.layers[1].id })
    for (const entry of imageEntries) {
      const doc = read(entry.svg)
      expect(doc.querySelectorAll('image')).toHaveLength(2)
      expect(doc.querySelector('defs path')).toBeNull()
      expect(doc.querySelectorAll('[data-board-holes] path')).toHaveLength(2)
      const nodes = Array.from(doc.querySelectorAll('[data-placement-id]'))
      const expected = placements.filter(placement => Object.hasOwn(entry.imageLayerMembers!, placement.image.sourceImageId ?? placement.image.id))
      expect(nodes).toHaveLength(expected.length)
      nodes.forEach((node, index) => expect(node.getAttribute('transform')).toBe(impositionPlacementTransform(expected[index])))
    }
    expect(read(imageEntries[0].svg).querySelector('[id$="-print-back"]')).toBeNull()
    expect(read(imageEntries[1].svg).querySelectorAll('[data-source-id="other"]')).toHaveLength(2)
    expect(read(entries[0].svg).querySelectorAll('[data-placement-id]')).toHaveLength(4)
    const full = read(buildImpositionTemplatePreview(current, current.templates[0].id))
    expect(full.querySelectorAll('image')).toHaveLength(3)
    expect(full.querySelector('path')).not.toBeNull()
    const pictures = read(buildImpositionTemplatePreview(current, current.templates[0].id, 'images'))
    expect(pictures.querySelectorAll('image')).toHaveLength(3)
    expect(pictures.querySelector('defs path')).toBeNull()
    const secondChannel = read(buildImpositionTemplatePreview(current, current.templates[0].id, 'images', 1))
    expect(secondChannel.querySelectorAll('image')).toHaveLength(2)
    expect(secondChannel.querySelectorAll('[data-placement-id]')).toHaveLength(4)
    expect(secondChannel.querySelector('[id$="-print-back"]')).not.toBeNull()
    expect(secondChannel.querySelectorAll('[data-source-id="other"]')).toHaveLength(2)
  })

  test('mixed face pages follow assigned roles, merge face layers and leave extra images separate', () => {
    const art = parseSource('<image id="back" href="data:image/png;base64,AQ=="/><image id="front" href="data:image/png;base64,Ag=="/><image id="front-detail" href="data:image/png;base64,Aw=="/><image id="extra" href="data:image/png;base64,BA=="/>')
    const other = parseSource('<image id="same" href="data:image/png;base64,BQ=="/>', 'other')
    const current = model([[item(), item('other', { x: 80, rotation: 180 })], [item('other', { x: 90 })]], { art, other })
    current.assignments.art[art.layers[0].id] = 'image-back'
    current.assignments.art[art.layers[1].id] = 'image-front'
    current.assignments.art[art.layers[2].id] = 'image-front'
    const entries = enumerateImpositionPdfExports(current, { date })
    expect(entries[0].pages).toHaveLength(3)
    const [front, back, extra] = entries[0].pages.map(entry => read(renderImpositionSvgExport(current, entry)))
    expect(front.querySelector('[id$="-back"]')).toBeNull()
    expect(front.querySelector('[id$="-front"]')).not.toBeNull()
    expect(front.querySelector('[id$="-front-detail"]')).not.toBeNull()
    expect(back.querySelector('[id$="-back"]')).not.toBeNull()
    expect(back.querySelector('[id$="-front"]')).toBeNull()
    for (const doc of [front, back]) {
      expect(doc.querySelector('[id$="-extra"]')).toBeNull()
      expect(doc.querySelector('[data-source-id="other"]')?.getAttribute('transform')).toBe(impositionPlacementTransform(current.templates[0].placements[1]))
    }
    expect(extra.querySelector('[id$="-extra"]')).not.toBeNull()
    expect(extra.querySelector('[data-source-id="other"]')).toBeNull()
    expect(entries[1].pages).toHaveLength(1) // Same-face-only boards don't gain a redundant page.
    const preview = read(buildImpositionTemplatePreview(current, current.templates[0].id, 'image-back'))
    expect(preview.querySelector('[id$="-same"]')).not.toBeNull()
    expect(preview.querySelector('[id$="-back"]')).not.toBeNull()
    current.templateAssignments = { 'template-1': { other: { [other.layers[0].id]: null } } }
    const changed = enumerateImpositionPdfExports(current, { date })
    expect(read(renderImpositionSvgExport(current, changed[0].pages[1])).querySelector('[data-source-id="other"]')).toBeNull()
  })

  test('image channels follow current type assignments in document order and honor per-template overrides', () => {
    const art = parseSource('<image id="first" href="data:image/png;base64,AQ=="/><path id="cut" fill="none" d="M0 0h1"/><image id="second" href="data:image/png;base64,Ag=="/>')
    const other = parseSource('<g><image id="only" href="data:image/png;base64,Aw=="/></g>', 'other')
    const placements = [item(), item('other', { x: 80 })]
    const current = model([placements, [item('art', { x: 20 }), item('other', { x: 90 })]], { art, other })
    // The first image becomes a color window; the next remaining image is now
    // channel 1, despite its source id being different from the other SVG's id.
    current.assignments.art[art.layers[0].id] = 'fills'
    let entries = buildImpositionSvgExports(current, { date })
    expect(entries.filter(entry => entry.groupId === 'images').map(entry => entry.imageLayerMembers)).toEqual([{ art: art.layers[2].id, other: other.layers[0].id }, { art: art.layers[2].id, other: other.layers[0].id }])
    for (const entry of entries.filter(entry => entry.groupId === 'images')) {
      expect(entry.imageLayerIndex).toBe(0)
      const doc = read(entry.svg)
      expect(doc.querySelector('[id$="-first"]')).toBeNull()
      expect(doc.querySelector('[id$="-second"]')).not.toBeNull()
      expect(doc.querySelector('[id$="-only"]')).not.toBeNull()
    }
    current.templateAssignments = { 'template-2': { art: { [art.layers[0].id]: null, [art.layers[1].id]: 'paths', [art.layers[2].id]: 'white' } } }
    entries = buildImpositionSvgExports(current, { date })
    const secondImages = entries.find(entry => entry.templateId === 'template-2' && entry.groupId === 'images')!
    expect(secondImages.imageLayerMembers).toEqual({ other: other.layers[0].id })
    expect(read(secondImages.svg).querySelectorAll('[data-placement-id]')).toHaveLength(1)
    expect(entries.some(entry => entry.templateId === 'template-2' && entry.groupId === 'fills')).toBe(false)
    expect(read(entries.find(entry => entry.templateId === 'template-2' && entry.groupId === 'white')!.svg).querySelector('[id$="-second"]')).not.toBeNull()
    expect(entries.find(entry => entry.templateId === 'template-1' && entry.groupId === 'images')!.imageLayerMembers).toEqual({ art: art.layers[2].id, other: other.layers[0].id })
    // Assigning the path to images places it ahead of the existing second
    // image, according to document order rather than image tag name.
    current.assignments.art[art.layers[1].id] = 'images'
    entries = buildImpositionSvgExports(current, { templateIds: ['template-1'], date })
    const channels = entries.filter(entry => entry.groupId === 'images')
    expect(channels).toHaveLength(2)
    expect(channels[0].imageLayerMembers).toEqual({ art: art.layers[1].id, other: other.layers[0].id })
    expect(channels[1].imageLayerMembers).toEqual({ art: art.layers[2].id })
    expect(read(channels[0].svg).querySelector('path')).not.toBeNull()
    expect(read(channels[1].svg).querySelector('path')).toBeNull()
  })

  test('彩窗 and 白墨 merge across different SVGs; white paint alone is not automatically white ink', () => {
    const art = parseSource('<path id="color" fill="red" d="M0 0h20v10z"/><rect id="white" fill="white" width="20" height="10"/><text id="omit">unused</text>')
    const other = parseSource('<rect id="color" fill="blue" width="10" height="10"/><path id="white" fill="white" d="M0 0h20v10z"/>', 'other')
    expect(art.layers[1].category).toBe('fills')
    const current = model([[item(), item('other', { x: 60 })]], { art, other })
    current.assignments.art[art.layers[1].id] = 'white'
    current.assignments.other[other.layers[1].id] = 'white'
    current.assignments.art[art.layers[2].id] = null
    const entries = buildImpositionSvgExports(current)
    expect(entries.map(entry => entry.groupName)).toEqual(['彩窗', '白墨'])
    for (const entry of entries) {
      const doc = read(entry.svg)
      expect(doc.querySelectorAll('[data-placement-id]')).toHaveLength(2)
      expect(doc.querySelector('text')).toBeNull()
      expect(doc.querySelectorAll('path')).toHaveLength(1)
      expect(doc.querySelectorAll('rect')).toHaveLength(1)
    }
  })

  test('same-name assignment propagation matches layer structure and leaves unrelated names and incompatible SVGs alone', () => {
    const content = '<path id="cut" fill="none" stroke="red" d="M0 0h20"/><image id="print" href="data:image/png;base64,AQ=="/>'
    const art = parseSource(content)
    const matching = parseSource(content, 'matching')
    matching.fileName = 'C:\\assets\\产品.SVG'
    const incompatible = parseSource('<image id="different" href="data:image/png;base64,Ag=="/><path id="different-cut" fill="none" d="M0 0h10"/>', 'incompatible')
    const unrelated = parseSource(content, 'unrelated')
    unrelated.fileName = '其他产品.svg'
    const current = model([[item()], [item('art', { x: 20 })], [item('matching')], [item('incompatible')], [item('unrelated')]], { art, matching, incompatible, unrelated })
    current.templateAssignments = { 'template-1': { art: { [art.layers[0].id]: 'white', [art.layers[1].id]: null } } }
    const applied = applySourceAssignmentsToSameName(current, 'template-1', 'art')
    expect(applied.appliedSources).toBe(2)
    expect(applied.skippedSources).toBe(1)
    expect(applied.model.templateAssignments?.['template-2'].art[art.layers[0].id]).toBe('white')
    expect(applied.model.templateAssignments?.['template-3'].matching).toEqual({ [matching.layers[0].id]: 'white', [matching.layers[1].id]: null })
    expect(applied.model.templateAssignments?.['template-4'].incompatible).toBeUndefined()
    expect(applied.model.templateAssignments?.['template-5'].unrelated).toBeUndefined()
    expect(current.templateAssignments?.['template-3']).toBeUndefined()
  })

  test('selected layer preview retains full source coordinates and nested transforms', () => {
    const source = parseSource('<g transform="translate(5 6)" opacity=".7"><path fill="none" d="M20 30h4"/><rect x="300" y="180" width="20" height="20" fill="red"/></g>')
    const doc = read(buildSourceLayerPreview(source, [source.layers[1].id]))
    expect(doc.documentElement.getAttribute('viewBox')).toBe('10 20 400 200')
    expect(doc.querySelector('path')).toBeNull()
    expect(doc.querySelector('g')!.getAttribute('transform')).toBe('translate(5 6)')
    expect(doc.querySelector('g')!.getAttribute('opacity')).toBe('.7')
    expect(doc.querySelector('rect')!.getAttribute('x')).toBe('300')
  })

  test('copies keep independent ids, CSS, clip/mask/gradient/use resources', () => {
    const source = parseSource('<style>svg{fill:none}.outline{stroke:magenta} #cut {stroke-width:2}</style><defs><linearGradient id="gradient"><stop offset="0" stop-color="red"/></linearGradient><clipPath id="clip"><rect width="400" height="200"/></clipPath><mask id="mask"><rect fill="white" width="400" height="200"/></mask><path id="shape" fill="none" stroke="red" d="M10 20h400"/></defs><g clip-path="url(#clip)" mask="url(#mask)" transform="translate(1 2)"><path id="cut" class="outline" d="M10 20h400"/><use href="#shape"/></g>')
    const current = model([[item(), item('art', { x: 80, image: { ...image(), id: 'art#qt-2', sourceImageId: 'art' } })]], { art: source })
    const entries = buildImpositionSvgExports(current)
    const doc = read(entries.find(entry => entry.groupId === 'paths')!.svg)
    const ids = Array.from(doc.querySelectorAll('[id]')).map(node => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const element of Array.from(doc.querySelectorAll('[clip-path], [mask]'))) for (const attr of ['clip-path', 'mask']) {
      const value = element.getAttribute(attr)
      if (value) expect(doc.getElementById(value.slice(5, -1))).not.toBeNull()
    }
    for (const use of Array.from(doc.querySelectorAll('use'))) expect(doc.getElementById(use.getAttribute('href')!.slice(1))).not.toBeNull()
    expect(doc.querySelectorAll('clipPath')).toHaveLength(1)
    expect(doc.querySelectorAll('mask')).toHaveLength(1)
    expect(doc.querySelectorAll('style')).toHaveLength(0)
    for (const path of doc.querySelectorAll('[class="outline"]')) expect(path.getAttribute('style')).toContain('stroke:magenta')
  })

  test('a use referencing a removed drawing retains that drawing as a nonpainting resource', () => {
    const source = parseSource('<path id="drawing" fill="none" stroke="red" d="M0 0h10"/><use href="#drawing" x="20"/>')
    const doc = read(buildSourceLayerPreview(source, [source.layers[1].id]))
    const visibleUse = Array.from(doc.querySelectorAll('use')).find(node => !node.closest('defs'))!
    expect(doc.getElementById(visibleUse.getAttribute('href')!.slice(1))).not.toBeNull()
    expect(Array.from(doc.querySelectorAll('path')).filter(node => !node.closest('defs'))).toHaveLength(0)
  })

  test('UTF-8 SVG data URLs and standalone bitmap sources become manageable layers', () => {
    const svgText = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><text>中文</text></svg>')
    expect(parseImpositionSvgSource({ sourceId: 'x', fileName: 'x.svg', svgText }).layers[0].tagName).toBe('text')
    const bitmap = parseImpositionSvgSource({ sourceId: 'bitmap', fileName: 'photo.png', svgText: 'data:image/png;base64,AQ==', widthMm: 40, heightMm: 20 })
    expect(bitmap.layers).toHaveLength(1)
    expect(bitmap.layers[0].category).toBe('images')
    expect(read(bitmap.svgText).documentElement.getAttribute('viewBox')).toBe('0 0 40 20')
  })

  test('CSS sibling position and ID names that resemble colors survive filtering', () => {
    const source = parseSource('<style>path:nth-child(2){fill:#fff}path:nth-child(3){fill:red} #fff{stroke:blue}</style><path id="fff" d="M0 0h1"/><path id="second" d="M0 0h2"/>')
    const preview = read(buildSourceLayerPreview(source, [source.layers[1].id]))
    expect(preview.querySelector('path')!.getAttribute('style')).toContain('fill:red')
    const current = model([[item()]], { art: source })
    const doc = read(buildImpositionSvgExports(current)[0].svg)
    expect(doc.querySelector('[id$="-fff"]')!.getAttribute('style')).toContain('fill:#fff')
    expect(doc.querySelector('[id$="-fff"]')!.getAttribute('style')).toContain('stroke:blue')
  })

  test('path export drops unused embedded bitmap resources but keeps chained gradient resources', () => {
    const source = parseSource('<defs><image id="bitmap" href="data:image/png;base64,AQ==" width="400" height="200"/><linearGradient id="base"><stop offset="0" stop-color="red"/></linearGradient><linearGradient id="gradient" href="#base"/></defs><use href="#bitmap"/><path fill="none" stroke="url(#gradient)" d="M0 0h2"/>')
    const current = model([[item()]], { art: source })
    const entries = buildImpositionSvgExports(current)
    const cuts = read(entries.find(entry => entry.groupId === 'paths')!.svg)
    expect(cuts.querySelector('image')).toBeNull()
    expect(cuts.querySelectorAll('linearGradient')).toHaveLength(2)
    const picture = read(entries.find(entry => entry.groupId === 'images')!.svg)
    expect(picture.querySelector('image')).not.toBeNull()
    expect(picture.querySelectorAll('linearGradient')).toHaveLength(0)
  })

  test('use instance fill inherits from the instance, not the definition tree', () => {
    const source = parseSource('<defs><path id="shape" d="M0 0h10v10z"/></defs><use href="#shape" fill="none" stroke="red"/><use href="#shape" fill="green"/>')
    expect(source.layers.map(layer => layer.category)).toEqual(['paths', 'fills'])
  })
})

describe('imposition export physical board identity and positioning', () => {
  test('holes use the configured outer-edge span and page-specific circular paint', () => {
    const current = createImpositionExportModel({ pages: [[item()]], sources: { art: source }, plateWidthMm: 300, plateHeightMm: 464, holes: { count: 2, sizeMm: 3, gapMm: 203.468, leftMm: 4 } })
    const entries = buildImpositionSvgExports(current)
    const preview = buildImpositionTemplatePreview(current, current.templates[0].id)
    for (const { svg, outline } of [...entries.map(entry => ({ svg: entry.svg, outline: entry.groupId === 'paths' })), { svg: preview, outline: true }]) {
      const group = read(svg).querySelector('[data-board-holes]')!
      expect(group.getAttribute('fill')).toBe(outline ? 'none' : '#000000')
      expect(group.getAttribute('stroke')).toBe(outline ? '#2563eb' : 'none')
      expect(Number(group.getAttribute('stroke-width'))).toBeGreaterThan(0)
      const paths = Array.from(group.querySelectorAll('path'))
      expect(paths).toHaveLength(2)
      expect(paths.map(path => [
        path.getAttribute('data-hole-center-x-mm'),
        path.getAttribute('data-hole-center-y-mm'),
        path.getAttribute('data-hole-radius-mm'),
      ])).toEqual([['5.5', '131.766', '1.5'], ['5.5', '332.234', '1.5']])
      expect(group.querySelector('circle')).toBeNull()
      expect(paths.map(path => path.getAttribute('d'))).toEqual([
        'M 4 131.766 A 1.5 1.5 0 1 0 7 131.766 A 1.5 1.5 0 1 0 4 131.766 Z',
        'M 4 332.234 A 1.5 1.5 0 1 0 7 332.234 A 1.5 1.5 0 1 0 4 332.234 Z',
      ])
    }
    for (const type of ['paths', 'images', 'fills', 'white']) {
      current.assignments.art = Object.fromEntries(source.layers.map(layer => [layer.id, type]))
      const entry = buildImpositionSvgExports(current)[0]
      const preview = buildImpositionTemplatePreview(current, current.templates[0].id, type)
      for (const svg of [entry.svg, preview]) {
        const group = read(svg).querySelector('[data-board-holes]')!
        expect(group.getAttribute('fill')).toBe(type === 'paths' ? 'none' : '#000000')
        expect(group.getAttribute('stroke')).toBe(type === 'paths' ? '#2563eb' : 'none')
      }
    }
    current.holes!.count = 1
    expect(read(buildImpositionSvgExports(current)[0].svg).querySelector('[data-board-holes] path')!.getAttribute('d')).toBe('M 4 232 A 1.5 1.5 0 1 0 7 232 A 1.5 1.5 0 1 0 4 232 Z')
    current.holes!.count = 0
    expect(read(buildImpositionSvgExports(current)[0].svg).querySelector('[data-board-holes]')).toBeNull()
  })

  test.each([0, 90, 180, 270, 37])('rotated %s degree placement matches the original full-image frame', rotation => {
    const placement = item('art', { x: 17, y: 25, width: 40, height: 20, rotation })
    const current = model([[placement]])
    const doc = read(buildImpositionSvgExports(current)[0].svg)
    expect(doc.documentElement.getAttribute('width')).toBe('300mm')
    expect(doc.documentElement.getAttribute('height')).toBe('464mm')
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 300 464')
    const group = doc.querySelector('[data-source-id]')!
    expect(group.getAttribute('transform')).toBe(impositionPlacementTransform(placement))
    const reference = group.querySelector('use')!.getAttribute('href')!.slice(1)
    const frame = doc.getElementById(reference)!.querySelector('svg')!
    expect(frame.getAttribute('width')).toBe('40')
    expect(frame.getAttribute('height')).toBe('20')
    expect(frame.getAttribute('viewBox')).toBe('0 0 400 200')
    expect(frame.querySelector('svg')!.getAttribute('viewBox')).toBe('10 20 400 200')
    const nums = group.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    const rad = rotation * Math.PI / 180
    const points = [[0, 0], [40, 0], [0, 20], [40, 20]].map(([x, y]) => [nums[0] + Math.cos(rad) * (x + nums[3]) - Math.sin(rad) * (y + nums[4]), nums[1] + Math.sin(rad) * (x + nums[3]) + Math.cos(rad) * (y + nums[4])])
    expect(Math.min(...points.map(point => point[0]))).toBeCloseTo(17, 7)
    expect(Math.min(...points.map(point => point[1]))).toBeCloseTo(25, 7)
    expect(doc.querySelector('text')).toBeNull()
  })

  test('source viewport letterboxing is preserved before its Konva frame stretch', () => {
    const source = parseImpositionSvgSource({ sourceId: 'art', fileName: 'letterbox.svg', svgText: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 400 200" preserveAspectRatio="xMaxYMin meet"><rect width="400" height="200" fill="red"/></svg>' })
    const doc = read(buildImpositionSvgExports(model([[item()]], { art: source }))[0].svg)
    const frame = doc.querySelector('[data-source-frame]')!
    expect(frame.getAttribute('viewBox')).toBe('0 0 100 100')
    expect(frame.getAttribute('preserveAspectRatio')).toBe('none')
    expect(frame.getAttribute('width')).toBe('40')
    expect(frame.getAttribute('height')).toBe('20')
    const original = frame.querySelector('svg')!
    expect(original.getAttribute('viewBox')).toBe('0 0 400 200')
    expect(original.getAttribute('width')).toBe('100')
    expect(original.getAttribute('height')).toBe('100')
    expect(original.getAttribute('preserveAspectRatio')).toBe('xMaxYMin meet')
  })

  test('100 QT copies share one embedded image payload while retaining independent transforms', () => {
    const payload = 'data:image/png;base64,' + 'A'.repeat(120_000)
    const source = parseSource(`<image href="${payload}" width="400" height="200"/>`)
    const one = model([[item()]], { art: source })
    const placements = Array.from({ length: 100 }, (_, index) => item('art', { image: { ...image(), id: `art#qt-${index + 1}`, sourceImageId: 'art' }, x: index % 10 * 25, y: Math.floor(index / 10) * 40, rotation: index % 4 * 90 }))
    const many = model([placements], { art: source })
    const small = buildImpositionSvgExports(one)[0].svg
    const large = buildImpositionSvgExports(many)[0].svg
    expect(large.split(payload)).toHaveLength(2)
    expect(large.length).toBeLessThan(small.length + 40_000)
    const doc = read(large)
    expect(doc.querySelectorAll('image')).toHaveLength(1)
    expect(doc.querySelectorAll('[data-source-frame]')).toHaveLength(1)
    const nodes = Array.from(doc.querySelectorAll('[data-placement-id]'))
    expect(nodes).toHaveLength(100)
    nodes.forEach((node, index) => {
      expect(node.getAttribute('transform')).toBe(impositionPlacementTransform(placements[index]))
      expect(doc.getElementById(node.querySelector('use')!.getAttribute('href')!.slice(1))).not.toBeNull()
    })
  })

  test('identical printed boards export once with F quantity; different artwork stays separate', () => {
    const copies = Array.from({ length: 5 }, (_, index) => [item('art', { image: { ...image(), id: `art#qt-${index + 1}`, sourceImageId: 'art' } })])
    const other = parseSource('<path fill="none" stroke="blue" d="M10 20h400v200H10z"/>', 'other')
    const current = model([...copies, [], [item('other')]], { art: source, other })
    expect(current.templates).toHaveLength(2)
    expect(current.templates[0].pageIndices).toEqual([0, 1, 2, 3, 4])
    expect(current.templates[0].productionCopies).toBe(5)
    const entries = enumerateImpositionSvgExports(current, { date })
    expect(entries[0].fileName).toBe('轮廓_202610140930_1B-2B_1F-5F.pdf')
    expect(entries.at(-1)!.fileName).toBe('轮廓_202610140930_2B-2B_1F-1F.pdf')
    expect(entries).toHaveLength(4)
  })

  test('per-template group overrides do not change another physical template', () => {
    const current = model([[item()], [item('art', { x: 20 })]])
    current.templateAssignments = { 'template-2': { art: Object.fromEntries(source.layers.map(layer => [layer.id, layer.category === 'images' ? 'paths' : null])) } }
    const entries = enumerateImpositionSvgExports(current, { date, templateIds: ['template-2'] })
    expect(entries).toHaveLength(1)
    expect(entries[0].fileName).toBe('轮廓_202610140930_1B-1B_1F-1F.pdf')
    expect(entries[0].templateNumber).toBe(2)
    const doc = read(renderImpositionSvgExport(current, entries[0]))
    expect(doc.querySelector('image')).not.toBeNull()
    expect(doc.querySelector('path')).toBeNull()
    expect(current.assignments.art[source.layers[1].id]).toBe('image-front')
  })

  test('writes every type of one board before the next, with one F set for all production copies', () => {
    const art = parseSource('<image href="data:image/png;base64,AQ=="/><rect id="color" fill="red" width="4" height="4"/><path fill="none" stroke="red" d="M0 0h40v20z"/><image href="data:image/png;base64,Ag=="/><rect id="ink" fill="white" width="4" height="4"/>')
    const first = [item()]; const second = [item('art', { x: 80 })]
    const current = model([...Array.from({ length: 5 }, () => first), second, second], { art })
    current.assignments.art[art.layers.find(layer => layer.label === 'ink')!.id] = 'white'
    const entries = enumerateImpositionSvgExports(current, { date, templateIds: ['template-2', 'template-1'] })
    expect(entries).toHaveLength(10)
    const types = ['轮廓', '图片1', '图片2', '彩窗', '白墨']
    expect(entries.map(entry => entry.fileName)).toEqual([
      ...types.map(type => `${type}_202610140930_1B-2B_1F-5F.pdf`),
      ...types.map(type => `${type}_202610140930_2B-2B_1F-2F.pdf`),
    ])
    expect(entries.map(entry => [entry.templateNumber, entry.groupId, entry.imageLayerIndex])).toEqual([1, 2].flatMap(board => [
      [board, 'paths', undefined], [board, 'images', 0], [board, 'images', 1], [board, 'fills', undefined], [board, 'white', undefined],
    ]))
    expect(entries.map(entry => entry.productionCopies)).toEqual([5, 5, 5, 5, 5, 2, 2, 2, 2, 2])
    expect(new Set(entries.map(entry => entry.fileName)).size).toBe(10)
  })

  test('combines each template into one PDF with ordered pages and keeps production quantity independent of page count', () => {
    const art = parseSource('<image href="data:image/png;base64,AQ=="/><rect id="color" fill="red" width="4" height="4"/><path fill="none" stroke="red" d="M0 0h40v20z"/><image href="data:image/png;base64,Ag=="/><rect id="ink" fill="white" width="4" height="4"/>')
    const first = [item()]; const second = [item('art', { x: 80 })]
    const current = model([...Array.from({ length: 7 }, () => first), second, second], { art })
    current.assignments.art[art.layers.find(layer => layer.label === 'ink')!.id] = 'white'
    const entries = enumerateImpositionPdfExports(current, { date, templateIds: ['template-2', 'template-1'] })
    expect(entries.map(entry => entry.fileName)).toEqual(['202610140930_1B-2B_1F-7F.pdf', '202610140930_2B-2B_1F-2F.pdf'])
    expect(entries.map(entry => entry.productionCopies)).toEqual([7, 2])
    expect(entries.map(entry => entry.templateNumber)).toEqual([1, 2])
    for (const entry of entries) {
      expect(entry).toMatchObject({ widthMm: 300, heightMm: 464 })
      expect(entry.pages.map(page => [page.groupId, page.imageLayerIndex])).toEqual([['paths', undefined], ['images', 0], ['images', 1], ['fills', undefined], ['white', undefined]])
      expect(entry.pages.every(page => page.fileName === entry.fileName)).toBe(true)
      expect(entry.pages.every(page => page.templateId === entry.templateId)).toBe(true)
    }
    const secondOnly = enumerateImpositionPdfExports(current, { date, templateIds: ['template-2'] })
    expect(secondOnly[0]).toMatchObject({ fileName: '202610140930_1B-1B_1F-2F.pdf', templateNumber: 2 })
  })

  test('does not add empty PDF pages or files for omitted types and retains selected-board numbering', () => {
    const current = model(Array.from({ length: 5 }, (_, index) => [item('art', { x: index * 20 })]))
    current.templateAssignments = {
      'template-2': { art: Object.fromEntries(source.layers.map(layer => [layer.id, null])) },
      'template-3': { art: Object.fromEntries(source.layers.map(layer => [layer.id, 'white'])) },
    }
    const entries = enumerateImpositionPdfExports(current, { date, templateIds: ['template-5', 'template-3', 'template-2'] })
    expect(entries.map(entry => [entry.templateNumber, entry.fileName])).toEqual([[3, '202610140930_1B-2B_1F-1F.pdf'], [5, '202610140930_2B-2B_1F-1F.pdf']])
    expect(entries.map(entry => entry.pages.map(page => page.groupId))).toEqual([['white'], ['paths', 'images', 'fills']])
    expect(enumerateImpositionPdfExports(current, { date, templateIds: ['template-2'] })).toEqual([])
    expect(enumerateImpositionPdfExports(current, { date, templateIds: [] })).toEqual([])
    expect(enumerateImpositionPdfExports(current, { date, groupIds: [] })).toEqual([])
    expect(() => enumerateImpositionPdfExports(current, { date: new Date(NaN) })).toThrow('导出日期无效')
  })

  test('B numbers count only selected boards that produce files, while metadata retains canvas numbers', () => {
    const current = model(Array.from({ length: 6 }, (_, index) => [item('art', { x: index * 20 })]))
    current.templateAssignments = {
      'template-2': { art: Object.fromEntries(source.layers.map(layer => [layer.id, null])) },
      'template-3': { art: Object.fromEntries(source.layers.map(layer => [layer.id, 'fills'])) },
    }
    const entries = enumerateImpositionSvgExports(current, { date, templateIds: ['template-5', 'template-3', 'template-4', 'template-2'], groupIds: ['paths'] })
    expect(entries.map(entry => [entry.templateNumber, entry.fileName])).toEqual([
      [4, '轮廓_202610140930_1B-2B_1F-1F.pdf'],
      [5, '轮廓_202610140930_2B-2B_1F-1F.pdf'],
    ])
    expect(enumerateImpositionSvgExports(current, { date, templateIds: ['template-2'] })).toEqual([])
    expect(enumerateImpositionSvgExports(current, { date, templateIds: [] })).toEqual([])
    expect(enumerateImpositionSvgExports(current, { date, groupIds: [] })).toEqual([])
  })

  test.each([9, 10, 100])('B numbering pads to the total digit count for %i boards', count => {
    const art = parseSource('<path fill="none" stroke="blue" d="M0 0h40v20z"/>')
    const current = model(Array.from({ length: count }, (_, index) => [item('art', { x: 10 + index / 10 })]), { art })
    const names = enumerateImpositionSvgExports(current, { date }).map(entry => entry.fileName)
    expect(names).toHaveLength(count)
    expect(names[0]).toBe(`轮廓_202610140930_${String(1).padStart(String(count).length, '0')}B-${count}B_1F-1F.pdf`)
    expect(names.at(-1)).toBe(`轮廓_202610140930_${count}B-${count}B_1F-1F.pdf`)
    expect([...names].sort()).toEqual(names)
  })

  test('names use local export time through minutes and reject an invalid export date', () => {
    const current = model()
    expect(enumerateImpositionSvgExports(current, { date: new Date(2027, 0, 2, 3, 4, 59) })[0].fileName).toBe('轮廓_202701020304_1B-1B_1F-1F.pdf')
    expect(() => enumerateImpositionSvgExports(current, { date: new Date(NaN) })).toThrow('导出日期无效')
  })
})
