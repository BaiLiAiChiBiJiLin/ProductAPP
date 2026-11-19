import { invoke } from '@tauri-apps/api/core'
import { PAPER_WIDTH, type Asset, type Item, type Page } from '../../../model'
import { artworkSource, hasInlineArtwork } from './artworkSourceService'
import { artworkVersion } from './artworkVersionService'
import { itemForCanvasDisplay } from './canvasDisplayScaleService'
import { StagedArtwork } from './stagedArtworkService'

/** Bounded native preparation; original SVG bytes never return to WebView. */
export class ExportArtwork {
  private staged = new StagedArtwork()
  private ids: string[] = []
  private hrefs = new Map<string, string>()
  href = (_svg: string, item: Item) => {
    const href = this.hrefs.get(item.id)
    if (!href) throw new Error('导出图片资源缺失')
    return href
  }
  async prepare(pages: Page[], assets: Map<string, Asset>, quality: 'standard' | 'high' | 'original', batchId?: string, scales?: ReadonlyMap<string, number>, progress?: (done: number, total: number) => void) {
    const versions = new Map<string, Promise<string>>()
    const versionOf = (svg: string) => {
      let version = versions.get(svg)
      if (!version) { version = artworkVersion(svg); versions.set(svg, version) }
      return version
    }
    const requests = new Map<string, { source: ReturnType<typeof artworkSource>; edge: number; sourceVersion: string; layerIds: string[]; itemIds: string[]; native: boolean }>()
    for (const page of pages) for (const item of page.items) {
      const asset = assets.get(item.assetId)
      if (!asset) throw new Error('页面中有丢失的图片资源，无法导出')
      const source = artworkSource(asset, item, batchId)
      const inline = hasInlineArtwork(source.svg)
      if (!inline && !source.svg && !source.path && !batchId) throw new Error('图片缺少原图引用')
      const version = inline ? await versionOf(source.svg) : source.svg || `${batchId ?? ''}:${asset.id}:${source.path ?? ''}`
      const sourceVersion = hasInlineArtwork(asset.svg) ? await versionOf(asset.svg) : version
      const layerIds = item.svgLayerIds ?? [item.svgLayerId ?? (item.backSvg ? 'derived' : 'all')]
      const key = JSON.stringify([sourceVersion, version, layerIds, source.variant])
      const display = itemForCanvasDisplay(item, scales?.get(item.id))
      const edge = Math.max(1, Math.min(4096, Math.ceil(Math.max(display.w, display.h) / PAPER_WIDTH * 210 / 25.4 * (quality === 'high' ? 300 : 200))))
      const existing = requests.get(key)
      if (existing) { existing.edge = Math.max(existing.edge, edge); existing.itemIds.push(item.id); continue }
      if (inline) source.svg = this.staged.reference(source.svg)
      requests.set(key, { source, edge, sourceVersion, layerIds, itemIds: [item.id], native: !inline || Boolean(source.variant) })
    }
    await this.staged.write(progress)
    let completed = 0
    let cursor = 0
    let failed = false
    let failure: unknown
    const queued = [...requests.values()]
    const prepare = async () => {
      while (!failed && cursor < queued.length) {
        const request = queued[cursor++]
        try {
          let href: string
          if (quality === 'original' && !request.native) href = request.source.svg
          else {
            const id = crypto.randomUUID(); this.ids.push(id)
            if (request.native) await invoke('stage_asset_artwork', { id, source: request.source, maxEdgePx: quality === 'original' ? null : request.edge })
            else await invoke('stage_schematic_png', { id, svg: request.source.svg, sourceVersion: request.sourceVersion, layerIds: request.layerIds, maxEdgePx: request.edge })
            href = `${quality === 'original' ? 'printflow-export:' : 'printflow-png:'}${id}`
          }
          for (const id of request.itemIds) this.hrefs.set(id, href)
          progress?.(++completed, requests.size)
        } catch (error) { if (!failed) { failed = true; failure = error } }
      }
    }
    // Native admission also checks available memory and source size. Wait for
    // every started task before disposing files if any one preparation fails.
    const cores = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4
    await Promise.all(Array.from({ length: Math.min(queued.length, Math.max(1, Math.min(4, Math.floor(cores/2)))) }, prepare))
    if (failed) throw failure
    if (quality !== 'original') await this.staged.dispose()
  }
  async dispose() {
    await this.staged.dispose()
    if (this.ids.length) await invoke('clear_pdf_pages', { ids: this.ids }).catch(error => console.warn('导出图片临时文件清理失败', error))
    this.ids = []; this.hrefs.clear()
  }
}
