import { useState } from 'react'
import Konva from 'konva'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ArtworkCanvas from '../src/modules/schematic/ArtworkCanvas'
import { pageSvg, pageRasterSvg, type Asset, type Item, type Page } from '../src/model'
import { paginateAssets } from '../src/modules/schematic/services/paginationService'

const source: Asset = { id: 'a', name: 'Art', productId: 'a', width: 60, height: 80, sourceGroupWidthMm: 60, sourceGroupHeightMm: 80,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80"><rect width="60" height="80"/></svg>', previewUrl: '', thumbnailUrl: '' }
const assets = new Map([[source.id, source]])
const original: Item = { id: 'front', assetId: source.id, x: 120, y: 230, w: 60, h: 80, rotation: 0, rulerWidth: true, rulerHeight: true, rulerWidthRange: [.1, .85], rulerHeightRange: [.15, .9] }
const other: Item = { ...original, id: 'back', x: 280, y: 230, derivedFrom: 'front', caption: 'Back', mirrorX: true }
const previewApi = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/services/backend', () => ({ invoke: previewApi.invoke }))
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOInXLnPwAF7ALNUXCMXgAAAABJRU5ErkJggg=='

beforeEach(() => {
  previewApi.invoke.mockReset().mockResolvedValue(PNG)
  Konva.autoDrawEnabled = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    font: '11px Arial',
    measureText(text: string) {
      const fontSize = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 11)
      return { width: [...text].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : /[MW]/.test(char) ? .94 : .6), 0) * fontSize }
    }, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => {} }) as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() { this.callback([{ contentRect: { width: 1000, height: 900 } }] as ResizeObserverEntry[], this as unknown as ResizeObserver) }
    disconnect() {}
  })
  vi.stubGlobal('Image', class { onload?: () => void; onerror?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()) } })
  vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:artwork-drag'; static revokeObjectURL = () => {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Konva.autoDrawEnabled = true })

function press(node: Konva.Node) {
  const point = node.getAbsolutePosition()
  const event = new MouseEvent('mousedown', { clientX: point.x, clientY: point.y, buttons: 1 })
  act(() => { node.getStage()!.setPointersPositions(event); node.fire('mousedown', { evt: event }, true) })
  return point
}

it.each(['普通钥匙扣', '立牌', '摇摇乐', '串串'])('generated %s remarks and named note pictures are painted on the canvas as well as both export paths', async productName => {
  vi.stubGlobal('Image', class {
    naturalWidth = 100
    naturalHeight = 80
    onload?: () => void
    onerror?: () => void
    set src(_value: string) { queueMicrotask(() => this.onload?.()) }
  })
  const asset: Asset = { ...source, id: 'with-notes', productName, note: '请确认生产备注', noteImages: [{ src: PNG, name: '备注图片示例' }] }
  const map = new Map([[asset.id, asset]])
  const page = paginateAssets([asset])[0]
  render(<ArtworkCanvas page={page} assets={map} selected={null} onSelect={vi.fn()} onChange={vi.fn()} onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()}/>)
  const stage = Konva.stages.at(-1)!
  await waitFor(() => expect(stage.find<Konva.Image>('Image').filter(node => node.getParent()?.name().includes(':note'))).toHaveLength(1))
  const note = stage.find<Konva.Text>('.image-detail-note')
  expect(note.map(node => node.text()).join('')).toBe(asset.note)
  for (const text of [...note, ...stage.find<Konva.Text>('Text').filter(node => node.text() === '备注图片示例')]) {
    expect(text.isVisible()).toBe(true)
    expect(text.textArr.length).toBeGreaterThan(0)
    expect(text.getClientRect().width).toBeGreaterThan(0)
    expect(text.getClientRect().height).toBeGreaterThan(0)
  }
  for (const source of [pageSvg(page, map), pageRasterSvg(page, map)]) {
    const svg = new DOMParser().parseFromString(source, 'image/svg+xml')
    expect(svg.querySelector('[data-image-group-backgrounds]')?.textContent).toContain(asset.note)
    expect(svg.querySelector('[data-printflow-note]')?.getAttribute('href')).toBe(PNG)
  }
})

it('wide unbroken remarks remain drawable on the canvas when the same text is present in export', async () => {
  const asset: Asset = { ...source, id: 'wide-note', note: 'MMMMWWWWMMMMWWWW' }
  const map = new Map([[asset.id, asset]])
  const page = paginateAssets([asset])[0]
  render(<ArtworkCanvas page={page} assets={map} selected={null} onSelect={vi.fn()} onChange={vi.fn()} onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()}/>)
  const notes = Konva.stages.at(-1)!.find<Konva.Text>('.image-detail-note')
  expect(notes.map(node => node.text()).join('')).toBe(asset.note)
  for (const node of notes) expect(node.textArr.length).toBeGreaterThan(0)
  expect(new DOMParser().parseFromString(pageSvg(page, map), 'image/svg+xml').documentElement.textContent).toContain(asset.note)
})

it('retries a transient note-picture decode failure without needing to export or reopen the canvas', async () => {
  const noteSrc = `${PNG}#transient-note`
  let attempts = 0
  vi.stubGlobal('Image', class {
    naturalWidth = 100
    naturalHeight = 80
    onload?: () => void
    onerror?: () => void
    set src(value: string) {
      const fail = value === noteSrc && ++attempts < 3
      queueMicrotask(() => fail ? this.onerror?.() : this.onload?.())
    }
  })
  const asset: Asset = { ...source, id: 'transient-note', note: '备注文字保留', noteImages: [{ src: noteSrc, name: '备注图片' }] }
  const page = paginateAssets([asset])[0]
  render(<ArtworkCanvas page={page} assets={new Map([[asset.id, asset]])} selected={null} onSelect={vi.fn()} onChange={vi.fn()} onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()}/>)
  const stage = Konva.stages.at(-1)!
  await waitFor(() => expect(stage.find<Konva.Image>('Image').filter(node => node.getParent()?.name().includes(':note'))).toHaveLength(1), { timeout: 2500 })
  expect(attempts).toBe(3)
  expect(stage.find<Konva.Text>('.image-detail-note').map(node => node.text()).join('')).toBe(asset.note)
})

it.each(['decode-error', 'zero-size'])('shows a retry control after repeated %s note-picture failures and loads it when clicked', async failure => {
  const noteSrc = `${PNG}#manual-note-retry-${failure}`
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let attempts = 0
  let restored = false
  vi.stubGlobal('Image', class {
    naturalWidth = 100
    naturalHeight = 80
    onload?: () => void
    onerror?: () => void
    set src(value: string) {
      const fail = value === noteSrc && !restored && failure === 'decode-error'
      if (value === noteSrc && !restored && failure === 'zero-size') { this.naturalWidth = 0; this.naturalHeight = 0 }
      if (value === noteSrc) attempts++
      queueMicrotask(() => fail ? this.onerror?.() : this.onload?.())
    }
  })
  const asset: Asset = { ...source, id: 'manual-note-retry', note: '原来的备注文字', noteImages: [{ src: noteSrc, name: '原来的图片名称' }] }
  const page = paginateAssets([asset])[0]
  const before = JSON.stringify(page)
  render(<ArtworkCanvas page={page} assets={new Map([[asset.id, asset]])} selected={null} onSelect={vi.fn()} onChange={vi.fn()} onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()} onSelectAccessory={vi.fn()} onChangeAccessory={vi.fn()}/>)
  const stage = Konva.stages.at(-1)!
  await waitFor(() => expect(stage.find('.detail-image-retry')).toHaveLength(1), { timeout: 2500 })
  expect(attempts).toBe(3)
  expect(warn).toHaveBeenCalledExactlyOnceWith('配件或备注图片加载失败，可点击图片位置重试')
  expect(stage.find<Konva.Text>('.image-detail-note').map(node => node.text()).join('')).toBe(asset.note)
  restored = true
  act(() => stage.findOne('.detail-image-retry')!.fire('click', { evt: new MouseEvent('click') }, true))
  await waitFor(() => expect(stage.find<Konva.Image>('Image').filter(node => node.getParent()?.name().includes(':note'))).toHaveLength(1))
  expect(stage.find('.detail-image-retry')).toHaveLength(0)
  expect(attempts).toBe(4)
  expect(JSON.stringify(page)).toBe(before)
})

it('cancels an unfinished note-picture request when leaving the canvas without clearing successful cached images', async () => {
  const noteSrc = `${PNG}#unfinished-note`
  const finishedSrc = `${PNG}#finished-note`
  let started = 0
  let aborted = 0
  let successfulLoads = 0
  vi.stubGlobal('Image', class {
    naturalWidth = 100
    naturalHeight = 80
    onload?: () => void
    onerror?: () => void
    set src(value: string) {
      if (value === noteSrc) started++
      else if (!value) aborted++
      else { if (value === finishedSrc) successfulLoads++; queueMicrotask(() => this.onload?.()) }
    }
  })
  const asset: Asset = { ...source, id: 'unfinished-note', noteImages: [{ src: noteSrc, name: '' }, { src: finishedSrc, name: '' }] }
  const page = paginateAssets([asset])[0]
  const view = render(<ArtworkCanvas page={page} assets={new Map([[asset.id, asset]])} selected={null} onSelect={vi.fn()} onChange={vi.fn()} onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()}/>)
  await waitFor(() => expect(started).toBe(1))
  await waitFor(() => expect(Konva.stages.at(-1)!.find<Konva.Image>('Image').filter(node => node.getParent()?.name().includes(':note'))).toHaveLength(1))
  view.unmount()
  expect(aborted).toBe(1)
  const reopened = { ...asset, noteImages: [{ src: finishedSrc, name: '' }] }
  render(<ArtworkCanvas page={paginateAssets([reopened])[0]} assets={new Map([[asset.id, reopened]])} selected={null} onSelect={vi.fn()} onChange={vi.fn()} onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()}/>)
  await waitFor(() => expect(Konva.stages.at(-1)!.find<Konva.Image>('Image').filter(node => node.getParent()?.name().includes(':note'))).toHaveLength(1))
  expect(successfulLoads).toBe(1)
})
function move(point: { x: number; y: number }, buttons = 1) {
  act(() => { fireEvent.mouseMove(window, { clientX: point.x, clientY: point.y, buttons }) })
}
function release(point: { x: number; y: number }) {
  act(() => { fireEvent.mouseUp(window, { clientX: point.x, clientY: point.y }) })
}
const position = (node: Konva.Node) => node.getAbsolutePosition()

it('loads the current canvas from bounded PNGs without browser decoding the original SVG', async () => {
  const large = { ...source, id: 'large-canvas', storagePath: 'temp-assets/large-canvas.svg', svg: source.svg.replace('</svg>', `<!--${'x'.repeat(300 * 1024)}--></svg>`) }
  const page: Page = { id: 64, name: 'current', items: [{ ...original, assetId: large.id }] }
  const createUrl = vi.spyOn(URL, 'createObjectURL')
  render(<ArtworkCanvas page={page} assets={new Map([[large.id, large]])} selected={null} onSelect={vi.fn()} onChange={vi.fn()} onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()}/>)
  await waitFor(() => expect(Konva.stages.at(-1)!.find('.schematic-artwork')).toHaveLength(1))
  expect(previewApi.invoke).toHaveBeenCalledWith('load_temp_asset_preview', expect.objectContaining({ path: large.storagePath }))
  expect(createUrl).not.toHaveBeenCalled()
})

it('previews selected layers and a mirrored back from their edited SVG rather than the saved front', async () => {
  const editedSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="5" fill="blue"/></svg>'
  const asset = { ...source, id: 'edited-preview', storagePath: 'temp-assets/edited-preview.svg' }
  const back = { ...other, assetId: asset.id, backSvg: editedSvg }
  const page: Page = { id: 65, name: 'layers', items: [{ ...original, assetId: asset.id }, back] }
  const before = structuredClone(page)
  render(<ArtworkCanvas batchId="batch" page={page} assets={new Map([[asset.id, asset]])} selected={null} onSelect={vi.fn()} onChange={vi.fn()} onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()}/>)
  await waitFor(() => expect(Konva.stages.at(-1)!.find('.schematic-artwork')).toHaveLength(2))
  expect(previewApi.invoke).toHaveBeenCalledWith('load_inline_asset_preview', { svg: editedSvg, maxEdgePx: 512 })
  expect(Konva.stages.at(-1)!.findOne('#back')!.scaleX()).toBe(-1)
  expect(page).toEqual(before)
})
function expectOffset(actual: { x: number; y: number }, before: { x: number; y: number }, delta: { x: number; y: number }) {
  expect(actual.x).toBeCloseTo(before.x + delta.x)
  expect(actual.y).toBeCloseTo(before.y + delta.y)
}

it.each([.7, 1, 1.6, 2.5])('moves both rulers with their own image throughout a drag at canvas zoom %s', async zoom => {
  const commit = vi.fn()
  let saved: Page
  function Harness() {
    const [page, setPage] = useState<Page>({ id: 1, name: 'test', items: [original, other], imageGroups: [{ id: 'g', itemIds: ['front', 'back'], x: 30, y: 150, width: 400, height: 300,
      imageCells: [{ itemId: 'front', x: 30, y: 150, width: 180, height: 300 }, { itemId: 'back', x: 210, y: 150, width: 180, height: 300 }] }] })
    const [selected, setSelected] = useState<string | null>(null)
    saved = page
    return <ArtworkCanvas page={page} assets={assets} zoom={zoom} visualScales={new Map([['front', 1.2], ['back', .8]])} selected={selected} onSelect={setSelected}
      onChange={next => { commit(next); setPage(current => ({ ...current, items: current.items.map(item => item.id === next.id ? next : item) })) }}
      onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()} onChangeRuler={vi.fn()}/>
  }
  render(<Harness/>)
  await waitFor(() => expect(Konva.stages.at(-1)!.find('.schematic-artwork')).toHaveLength(2))
  const stage = Konva.stages.at(-1)!
  for (const id of ['front', 'back', 'front']) {
    const image = stage.findOne(`#${id}`)!
    const markers = stage.find(`.image-dimension-${id}`)
    expect(markers).toHaveLength(2)
    const arrows = markers.flatMap(marker => (marker as Konva.Group).find('.ruler-arrow'))
    const labels = markers.flatMap(marker => (marker as Konva.Group).find('.ruler-label'))
    const anchors = [...arrows, ...labels]
    const before = anchors.map(position)
    const otherId = id === 'front' ? 'back' : 'front'
    const otherAnchors = stage.find(`.image-dimension-${otherId}`).flatMap(marker => (marker as Konva.Group).find('.ruler-arrow'))
    const otherBefore = otherAnchors.map(position)
    const origin = press(image)
    const scale = Math.abs(image.getAbsoluteScale().y)
    const startItem = saved!.items.find(item => item.id === id)!
    const commits = commit.mock.calls.length
    for (const delta of [{ x: 12, y: 10 }, { x: 24, y: 20 }]) {
      const screenDelta = { x: delta.x * scale, y: delta.y * scale }
      move({ x: origin.x + screenDelta.x, y: origin.y + screenDelta.y })
      expectOffset(position(image), origin, screenDelta)
      anchors.forEach((anchor, index) => expectOffset(position(anchor), before[index], screenDelta))
      otherAnchors.forEach((anchor, index) => expectOffset(position(anchor), otherBefore[index], { x: 0, y: 0 }))
      expect(commit).toHaveBeenCalledTimes(commits)
    }
    const beforeRelease = anchors.map(position)
    const destination = { x: origin.x + 24 * scale, y: origin.y + 20 * scale }
    release(destination)
    expect(commit).toHaveBeenCalledTimes(commits + 1)
    const moved = saved!.items.find(item => item.id === id)!
    expect(moved.x).toBeCloseTo(startItem.x + 24)
    expect(moved.y).toBeCloseTo(startItem.y + 20)
    expect(moved).toMatchObject({ w: original.w, h: original.h, rulerWidthRange: original.rulerWidthRange, rulerHeightRange: original.rulerHeightRange })
    move({ x: destination.x + 80, y: destination.y + 60 }, 0)
    anchors.forEach((anchor, index) => expectOffset(position(anchor), beforeRelease[index], { x: 0, y: 0 }))
  }
})

it.each([{ x: -120, y: -100 }, { x: 1000, y: 1000 }])('keeps rulers on the actual constrained image when moving by %j across its original cell', async delta => {
  const imageItem = { ...other, y: 330 }
  const initial: Page = { id: 1, name: 'cross-cell', items: [original, imageItem], imageGroups: [{ id: 'g', itemIds: ['front', 'back'], x: 30, y: 150, width: 400, height: 300,
    imageCells: [{ itemId: 'front', x: 30, y: 150, width: 180, height: 300 }, { itemId: 'back', x: 220, y: 270, width: 180, height: 180 }] }] }
  let saved = initial
  const commit = vi.fn()
  function Harness() {
    const [page, setPage] = useState(initial)
    saved = page
    return <ArtworkCanvas page={page} assets={assets} zoom={1.6} selected={null} onSelect={vi.fn()}
      onChange={next => { commit(next); setPage(current => ({ ...current, items: current.items.map(item => item.id === next.id ? next : item) })) }}
      onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()} onChangeRuler={vi.fn()}/>
  }
  const view = render(<Harness/>)
  await waitFor(() => expect(Konva.stages.at(-1)!.find('.schematic-artwork')).toHaveLength(2))
  const stage = Konva.stages.at(-1)!
  const image = stage.findOne('#back')!
  const anchors = stage.find('.image-dimension-back').flatMap(marker => (marker as Konva.Group).find('.ruler-arrow'))
  const before = anchors.map(position)
  const origin = press(image)
  const scale = Math.abs(image.getAbsoluteScale().y)
  const cursor = { x: origin.x + delta.x * scale, y: origin.y + delta.y * scale }
  move(cursor)
  const actualDelta = { x: position(image).x - origin.x, y: position(image).y - origin.y }
  anchors.forEach((anchor, index) => expectOffset(position(anchor), before[index], actualDelta))
  expect(commit).not.toHaveBeenCalled()
  release(cursor)
  expect(commit).toHaveBeenCalledTimes(1)
  anchors.forEach((anchor, index) => expectOffset(position(anchor), before[index], actualDelta))
  const moved = saved.items[1]
  if (delta.x > 0) {
    expect(moved.x).toBeLessThan(imageItem.x + delta.x)
    expect(moved.y).toBeLessThan(imageItem.y + delta.y)
    expect(moved.x + moved.w / 2).toBeLessThanOrEqual(430)
    expect(moved.y + moved.h / 2).toBeLessThanOrEqual(450)
  } else {
    expect(moved.x).toBeCloseTo(160)
    expect(moved.y).toBeCloseTo(230)
  }
  const finalPositions = anchors.map(position)
  view.unmount()
  render(<ArtworkCanvas page={saved} assets={assets} zoom={1.6} selected={null} onSelect={vi.fn()} onChange={vi.fn()}
    onDropAsset={vi.fn()} onHeaderBlockChange={vi.fn()} onChangeRuler={vi.fn()}/>)
  const restored = Konva.stages.at(-1)!.find('.image-dimension-back').flatMap(marker => (marker as Konva.Group).find('.ruler-arrow'))
  restored.forEach((anchor, index) => expectOffset(position(anchor), finalPositions[index], { x: 0, y: 0 }))
})
