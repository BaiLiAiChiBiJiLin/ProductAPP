import { filteredRoot, orderedImageLayers, type ImpositionExportModel } from './impositionSvgExport'
import { boardHoleLayout } from './impositionHoles'

export type CmykSettings = { dpi: 300 | 400; autoAlign: boolean }
export type CmykSource = {
  key: string; label: string; widthMm: number; heightMm: number
  front: () => string; back?: () => string; window?: () => string
  backOffset: { xMm: number; yMm: number }; windowOffset: { xMm: number; yMm: number }
}
export type CmykExportPlan = {
  widthMm: number; heightMm: number; dpi: number; differentBack: boolean; autoAlign: boolean
  sources: CmykSource[]
  placements: { sourceKey: string; x: number; y: number; width: number; height: number; rotation: number }[]
  holes: { x: number; y: number; radius: number }[]
}
export function cmykImageLayers(model: ImpositionExportModel, templateId: string, sourceId: string) {
  const assignments = { ...model.assignments[sourceId], ...model.templateAssignments?.[templateId]?.[sourceId] }
  return orderedImageLayers(model.sources[sourceId], assignments)
}

/** Keep physical frames, clipping and transforms; never render QT copies here. */
export function createCmykExportPlan(model: ImpositionExportModel, templateId: string, settings: CmykSettings): CmykExportPlan | undefined {
  const template = model.templates.find(t => t.id === templateId)
  if (!template) throw new Error('CMYK 版式已不存在')
  const sources = new Map<string, CmykSource>()
  const placements: CmykExportPlan['placements'] = []
  for (const item of template.placements) {
    const id = item.image.sourceImageId ?? item.image.id.replace(/#qt-\d+$/u, '')
    const source = model.sources[id]
    const images = cmykImageLayers(model, templateId, id)
    if (!images.length) continue // Line-only layouts still export ordinary PDF/DXF.
    const assigned = { ...model.assignments[id], ...model.templateAssignments?.[templateId]?.[id] }
    const frontIds = images.filter(layer => assigned[layer.id] === 'image-front').map(layer => layer.id)
    const backIds = images.filter(layer => assigned[layer.id] === 'image-back').map(layer => layer.id)
    if (!frontIds.length) throw new Error(`${source.fileName}：请在 SVG 图层类型中指定图片正`)
    const key = JSON.stringify([id, item.width, item.height])
    if (!sources.has(key)) {
      const windowIds = source.layers.filter(layer => assigned[layer.id] === 'fills').map(layer => layer.id)
      const render = (ids: string[]) => () => new XMLSerializer().serializeToString(filteredRoot(source, new Set(ids)))
      sources.set(key, { key, label: source.fileName, widthMm: item.width, heightMm: item.height,
        front: render(frontIds), ...(backIds.length ? { back: render(backIds) } : {}), ...(windowIds.length ? { window: render(windowIds) } : {}),
        backOffset: { xMm: 0, yMm: 0 }, windowOffset: { xMm: 0, yMm: 0 },
      })
    }
    placements.push({ sourceKey: key, x: item.x, y: item.y, width: item.width, height: item.height, rotation: item.rotation ?? 0 })
  }
  if (!sources.size) return undefined
  const holes: CmykExportPlan['holes'] = []
  if (model.holes && model.holes.count > 0 && model.holes.sizeMm > 0) {
    const { count, sizeMm, gapMm, leftMm } = model.holes
    const { startMm, pitchMm } = boardHoleLayout(model.plateHeightMm, count, sizeMm, gapMm)
    for (let i = 0; i < count; i++) holes.push({ x: leftMm + sizeMm / 2, y: startMm + i * pitchMm + sizeMm / 2, radius: sizeMm / 2 })
  }
  // A board with any distinct back uses the different-face channel pipeline.
  // Sources without a back reuse the native front raster at every placement,
  // avoiding duplicate SVG staging, rendering and QT artwork buffers.
  return { widthMm: model.plateWidthMm, heightMm: model.plateHeightMm, dpi: settings.dpi, differentBack: [...sources.values()].some(source => !!source.back), autoAlign: settings.autoAlign, sources: [...sources.values()], placements, holes }
}
