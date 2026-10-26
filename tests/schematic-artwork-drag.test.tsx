import { useState } from 'react'
import Konva from 'konva'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ArtworkCanvas from '../src/modules/schematic/ArtworkCanvas'
import { type Asset, type Item, type Page } from '../src/model'

const source: Asset = { id: 'a', name: 'Art', productId: 'a', width: 60, height: 80, sourceGroupWidthMm: 60, sourceGroupHeightMm: 80,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80"><rect width="60" height="80"/></svg>', previewUrl: '', thumbnailUrl: '' }
const assets = new Map([[source.id, source]])
const original: Item = { id: 'front', assetId: source.id, x: 120, y: 230, w: 60, h: 80, rotation: 0, rulerWidth: true, rulerHeight: true, rulerWidthRange: [.1, .85], rulerHeightRange: [.15, .9] }
const other: Item = { ...original, id: 'back', x: 280, y: 230, derivedFrom: 'front', caption: 'Back', mirrorX: true }

beforeEach(() => {
  Konva.autoDrawEnabled = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: (text: string) => ({ width: text.length * 4 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }),
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
function move(point: { x: number; y: number }, buttons = 1) {
  act(() => { fireEvent.mouseMove(window, { clientX: point.x, clientY: point.y, buttons }) })
}
function release(point: { x: number; y: number }) {
  act(() => { fireEvent.mouseUp(window, { clientX: point.x, clientY: point.y }) })
}
const position = (node: Konva.Node) => node.getAbsolutePosition()
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
