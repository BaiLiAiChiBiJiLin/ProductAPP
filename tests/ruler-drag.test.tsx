import React, { createRef, useState } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Konva from 'konva'
import { Stage, Layer, Group } from 'react-konva'
import ImageDimensionMarkers from '../src/modules/schematic/components/ImageDimensionMarkers'
import type { Item, Page } from '../src/model'

// Only raster painting is stubbed: these tests use real Konva nodes, transforms,
// native window drag events and react-konva reconciliation (no component mocks).
beforeEach(() => {
  Konva.autoDrawEnabled = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: (text: string) => ({ width: text.length * 4 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => {} }) as unknown as CanvasRenderingContext2D)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); Konva.autoDrawEnabled = true })

const asset = { id: 'a', name: 'a', productId: '', width: 80, height: 100, svg: '<svg/>', previewUrl: '', thumbnailUrl: '' }
const assets = new Map([['a', asset]])
const initial: Item = { id: 'i', assetId: 'a', x: 160, y: 130, w: 80, h: 100, rotation: 0 }

function mountRuler(axis: 'width' | 'height', zoom: number, range?: [number, number]) {
  const stage = createRef<Konva.Stage>()
  const commit = vi.fn()
  const current: { value?: Page } = {}
  function Harness() {
    const rulerPatch = range ? (axis === 'width' ? { rulerWidthRange: range } : { rulerHeightRange: range }) : {}
    const [page, setPage] = useState<Page>({ id: 1, name: 'test', items: [{ ...initial, rulerWidth: axis === 'width', rulerHeight: axis === 'height', ...rulerPatch }], imageGroups: [{ id: 'g', itemIds: ['i'], x: 90, y: 50, width: 180, height: 180 }] })
    current.value = page
    return <Stage ref={stage} width={1000} height={700}><Layer><Group x={80} y={40} scaleX={zoom} scaleY={zoom}>
      <ImageDimensionMarkers page={page} assets={assets} onChangeRuler={(id, patch) => {
        commit(id, patch)
        setPage(value => ({ ...value, items: value.items.map(item => item.id === id ? { ...item, ...patch } : item) }))
      }}/>
    </Group></Layer></Stage>
  }
  render(<Harness/> )
  return { stage: stage.current!, commit, page: () => current.value! }
}

function press(node: Konva.Node) {
  const pos = node.getAbsolutePosition()
  const evt = new MouseEvent('mousedown', { clientX: pos.x, clientY: pos.y, buttons: 1 })
  act(() => { node.getStage()!.setPointersPositions(evt); node.fire('mousedown', { evt }, true) })
  return pos
}
function move(x: number, y: number) { act(() => { fireEvent.mouseMove(window, { clientX: x, clientY: y, buttons: 1 }) }) }
function release(x: number, y: number) { act(() => { fireEvent.mouseUp(window, { clientX: x, clientY: y }) }) }

describe.each(['width', 'height'] as const)('%s ruler drag', axis => {
  it.each([0.7, 1.6, 2.5])('both arrows track the pointer at zoom %s without sideways jumps or snapping back', zoom => {
    const { stage, commit, page } = mountRuler(axis, zoom)
    const dimension = axis === 'width' ? 80 : 100
    for (const index of [0, 1]) {
      const arrow = stage.find('.ruler-arrow')[index]
      const local = arrow.position()
      const origin = press(arrow)
      expect(arrow.position()).toEqual(local)
      const direction = index === 0 ? 1 : -1
      for (const delta of [8, 16, 24, 16]) {
        const x = origin.x + (axis === 'width' ? delta * direction * zoom : 0)
        const y = origin.y + (axis === 'height' ? delta * direction * zoom : 0)
        move(x, y)
        expect(arrow.getAbsolutePosition().x).toBeCloseTo(x)
        expect(arrow.getAbsolutePosition().y).toBeCloseTo(y)
        expect(arrow.isDragging()).toBe(true)
        expect(commit).toHaveBeenCalledTimes(index)
      }
      const end = arrow.getAbsolutePosition()
      release(end.x, end.y)
      expect(commit).toHaveBeenCalledTimes(index + 1)
      const finalArrow = stage.find('.ruler-arrow')[index]
      expect(finalArrow.getAbsolutePosition().x).toBeCloseTo(end.x)
      expect(finalArrow.getAbsolutePosition().y).toBeCloseTo(end.y)
      const range = page().items[0][axis === 'width' ? 'rulerWidthRange' : 'rulerHeightRange']!
      expect(range[index]).toBeCloseTo(index === 0 ? 16 / dimension : 1 - 16 / dimension)
    }
  })
  it('draws exactly two arrowheads, so no ghost arrow stays at the old endpoint', () => {
    const { stage } = mountRuler(axis, 1.6)
    expect(stage.find('Line').filter(line => line.getAttr('closed'))).toHaveLength(2)
  })
  it('keeps a full-length ruler label static', () => {
    const { stage } = mountRuler(axis, 1)
    const label = stage.find('.ruler-label')[0]
    expect(label.draggable()).toBe(false)
    expect(label.isListening()).toBe(false)
  })
  it('keeps endpoint arrows above an overlapping shortened label', () => {
    const { stage } = mountRuler(axis, 1, [0.46, 0.54])
    const label = stage.find('.ruler-label')[0]
    const start = stage.find('.ruler-arrow')[0]
    expect(start.getZIndex()).toBeGreaterThan(label.getZIndex())
    expect(start.isListening()).toBe(true)
  })
  it('keeps a moved ruler label centered between its endpoints', () => {
    const { stage } = mountRuler(axis, 1, [0.2, 0.8])
    const label = stage.find('.ruler-label')[0]
    const arrows = stage.find('.ruler-arrow')
    const origin = press(label)
    const delta = 12
    move(origin.x + (axis === 'width' ? delta : 0), origin.y + (axis === 'height' ? delta : 0))
    const start = arrows[0].getAbsolutePosition()
    const end = arrows[1].getAbsolutePosition()
    const center = axis === 'width' ? (start.x + end.x) / 2 : (start.y + end.y) / 2
    const labelPosition = label.getAbsolutePosition()
    expect(axis === 'width' ? labelPosition.x : labelPosition.y).toBeCloseTo(center)
    expect(axis === 'width' ? labelPosition.x : labelPosition.y).not.toBeCloseTo(origin[axis === 'width' ? 'x' : 'y'] + delta)
  })
})
