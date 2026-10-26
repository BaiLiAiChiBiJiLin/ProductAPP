import { createRef, useState } from 'react'
import Konva from 'konva'
import { Group, Layer, Stage } from 'react-konva'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import GroupResizeHandles from '../src/modules/schematic/components/GroupResizeHandles'
import { artworkBounds, defaultLayoutBounds, GROUP_GAP, PAPER_WIDTH } from '../src/model'
import type { GroupRect, GroupResizeEdge } from '../src/modules/schematic/services/groupResizeService'

beforeEach(() => {
  Konva.autoDrawEnabled = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({ measureText: (text: string) => ({ width: text.length * 4 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => {} }) as unknown as CanvasRenderingContext2D)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); Konva.autoDrawEnabled = true })

const area = artworkBounds(defaultLayoutBounds)
const unit = (PAPER_WIDTH - area.left - area.right - GROUP_GAP * 2) / 3
const columnStep = unit + GROUP_GAP
function harness(edge: GroupResizeEdge, zoom = 1.6) {
  const original = { x: edge.includes('w') ? area.left + columnStep * 2 : area.left, y: 260, width: unit, height: 100 }
  const ref = createRef<Konva.Stage>()
  const preview = vi.fn(), commit = vi.fn()
  let saved = original
  function Harness() {
    const [group, setGroup] = useState<GroupRect>(original)
    saved = group
    return <Stage ref={ref} width={1000} height={1000}><Layer><Group x={80} y={40} scaleX={zoom} scaleY={zoom}>
      <GroupResizeHandles group={group} bounds={defaultLayoutBounds} scale={zoom} onPreview={preview} onCommit={rect => { commit(rect); setGroup(rect) }}/>
    </Group></Layer></Stage>
  }
  const view = render(<Harness/>)
  const node = ref.current!.findOne(`.group-resize-${edge}`)!
  const point = node.getAbsolutePosition()
  const event = new MouseEvent('mousedown', { clientX: point.x, clientY: point.y, buttons: 1 })
  act(() => { ref.current!.setPointersPositions(event); node.fire('mousedown', { evt: event }, true) })
  const move = (dx: number, dy: number) => {
    const destination = { x: point.x + dx * zoom, y: point.y + dy * zoom }
    act(() => { fireEvent.mouseMove(window, { clientX: destination.x, clientY: destination.y, buttons: 1 }) })
    return destination
  }
  const release = (point: { x: number; y: number }) => act(() => { fireEvent.mouseUp(window, { clientX: point.x, clientY: point.y }) })
  return { ...view, stage: ref.current!, node, original, preview, commit, saved: () => saved, move, release }
}

it.each(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const)('resizes edge %s using whole columns horizontally and continuous height vertically', edge => {
  const h = harness(edge)
  const horizontal = /[ew]/.test(edge), vertical = /[ns]/.test(edge)
  const dx = horizontal ? columnStep * (edge.includes('w') ? -1 : 1) : 0
  const dy = vertical ? 27.25 * (edge.includes('n') ? -1 : 1) : 0
  const destination = h.move(dx, dy)
  const expected = h.preview.mock.calls.at(-1)![0] as GroupRect
  expect(expected.width).toBeCloseTo(horizontal ? unit * 2 + GROUP_GAP : unit)
  expect(expected.height).toBeCloseTo(vertical ? 127.25 : 100)
  expect(expected.x).toBeCloseTo(edge.includes('w') ? h.original.x - columnStep : h.original.x)
  expect(expected.y).toBeCloseTo(edge.includes('n') ? h.original.y - 27.25 : h.original.y)
  expect(h.commit).not.toHaveBeenCalled()
  h.release(destination)
  expect(h.commit).toHaveBeenCalledExactlyOnceWith(expected)
  expect(h.saved()).toEqual(expected)
  const outline = h.stage.findOne('.group-resize-outline')!
  expect(outline.x()).toBeCloseTo(expected.x)
  expect(outline.y()).toBeCloseTo(expected.y)
  expect(outline.width()).toBeCloseTo(expected.width)
  expect(outline.height()).toBeCloseTo(expected.height)
})

it.each([.7, 2.5])('previews one, two and three columns during one drag without accumulating offsets at zoom %s', zoom => {
  const h = harness('e', zoom)
  h.move(columnStep * .2, 0)
  expect(h.preview.mock.calls.at(-1)![0]).toBeUndefined()
  expect(h.node.x()).toBeCloseTo(h.original.x + h.original.width)
  h.move(columnStep * 1.2, 0)
  expect(h.preview.mock.calls.at(-1)![0].width).toBeCloseTo(unit * 2 + GROUP_GAP)
  const destination = h.move(columnStep * 2, 0)
  expect(h.preview.mock.calls.at(-1)![0].width).toBeCloseTo(unit * 3 + GROUP_GAP * 2)
  h.release(destination)
  expect(h.commit).toHaveBeenCalledTimes(1)
  expect(h.saved().width).toBeCloseTo(unit * 3 + GROUP_GAP * 2)
  expect(h.node.x()).toBeCloseTo(h.saved().x + h.saved().width)
})

it('cancels a resize with Escape and never commits the cancelled drag on release', () => {
  const h = harness('se')
  const destination = h.move(columnStep, 33)
  expect(h.preview.mock.calls.at(-1)![0].height).toBeCloseTo(133)
  act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
  h.release(destination)
  expect(h.commit).not.toHaveBeenCalled()
  expect(h.saved()).toEqual(h.original)
  expect(h.preview.mock.calls.at(-1)![0]).toBeUndefined()
  expect(h.node.x()).toBeCloseTo(h.original.x + h.original.width)
  expect(h.node.y()).toBeCloseTo(h.original.y + h.original.height)
})

it('does not commit a drag that remains within the original column snap', () => {
  const h = harness('e')
  h.release(h.move(10, 0))
  expect(h.commit).not.toHaveBeenCalled()
  expect(h.node.x()).toBeCloseTo(h.original.x + h.original.width)
})

it('commits when mouseup is delivered on the canvas handle between Konva capture and dragend', () => {
  const h = harness('se')
  const destination = h.move(columnStep, 32)
  vi.spyOn(h.stage, 'getIntersection').mockReturnValue((h.node as Konva.Group).findOne('Rect') as Konva.Shape)
  act(() => { fireEvent.mouseUp(h.stage.container().querySelector('.konvajs-content')!, { clientX: destination.x, clientY: destination.y }) })
  expect(h.commit).toHaveBeenCalledTimes(1)
  expect(h.saved().height).toBeCloseTo(132)
})

it('clears the pending preview when changing pages or tools unmounts the handles', () => {
  const h = harness('se')
  const destination = h.move(columnStep, 30)
  expect(h.preview.mock.calls.at(-1)![0].height).toBeCloseTo(130)
  h.unmount()
  expect(h.preview.mock.calls.at(-1)![0]).toBeUndefined()
  h.release(destination)
  expect(h.commit).not.toHaveBeenCalled()
})
