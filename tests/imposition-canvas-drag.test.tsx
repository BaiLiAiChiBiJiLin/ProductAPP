import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Konva from 'konva'
import ImpositionKonvaCanvas, { type PackedImpositionItem } from '../src/modules/imposition/ImpositionKonvaCanvas'
import type { ProductionImage } from '../src/modules/imposition/impositionRecords'

// Exercise real Konva nodes and React commits; only canvas painting is stubbed.
beforeEach(() => {
  Konva.autoDrawEnabled = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: (text: string) => ({ width: text.length * 4 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => {} }) as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Konva.autoDrawEnabled = true })

function item(id: string, x: number, y: number, width = 10, height = 10, polygon?: Array<[number, number]>): PackedImpositionItem {
  const image: ProductionImage = { id, name: id, filePath: `${id}.svg`, sourceFileName: `${id}.svg`, widthMm: width, heightMm: height, productId: '', productName: '', attributes: {}, attributeImages: {}, note: '', noteImage: null, productGroupId: '', productGroupLeaderId: '', productGroupPosition: 0 }
  return { image, x, y, width, height, polygon }
}

function mount(pages: PackedImpositionItem[][], polygons: Record<string, Array<[number, number]>> = {}, collapseRepeatedLayouts = false) {
  const onSelect = vi.fn()
  const onPagesChange = vi.fn()
  const canvas = (collapsed: boolean) => <ImpositionKonvaCanvas pages={pages} imageSources={{}} polygons={polygons} collapseRepeatedLayouts={collapsed} boardWidth={100} boardHeight={100} boardScale={1} effectiveX={5} effectiveY={5} effectiveWidth={90} effectiveHeight={90} spacing={3} holeCount={0} holeSize={3} holeLeft={2} holeStart={10} holeGap={20} zoom={1} panOffset={{ x: 0, y: 0 }} panMode={false} onSelectImage={onSelect} onPagesChange={onPagesChange}/>
  const view = render(canvas(collapseRepeatedLayouts))
  const stage = Konva.stages.at(-1)!
  const image = stage.find<Konva.Image>('Image')[0]
  const origin = { x: image.absolutePosition().x - image.x(), y: image.absolutePosition().y - image.y() }
  return { stage, image, origin, onSelect, onPagesChange, setCollapsed: (collapsed: boolean) => view.rerender(canvas(collapsed)) }
}

function begin(node: Konva.Image) { act(() => { node.fire('dragstart') }) }
function move(node: Konva.Image, x: number, y: number) { act(() => { node.absolutePosition({ x, y }); node.fire('dragmove') }) }
function end(node: Konva.Image) { act(() => { node.fire('dragend') }) }

it('draws unfilled board hole paths at the configured millimetre size after canvas scaling', () => {
  const canvas = (diameter: number) => <ImpositionKonvaCanvas pages={[[item('art', 20, 20)]]} imageSources={{}} boardWidth={100} boardHeight={100} boardScale={2} effectiveX={5} effectiveY={5} effectiveWidth={90} effectiveHeight={90} spacing={3} holeCount={2} holeSize={diameter} holeLeft={4} holeStart={10} holeGap={20} zoom={1.5} panOffset={{ x: 0, y: 0 }} panMode={false} onSelectImage={() => {}}/>
  const view = render(canvas(3))
  const stage = Konva.stages.at(-1)!
  for (const diameter of [3, 5]) {
    view.rerender(canvas(diameter))
    const holes = stage.find<Konva.Path>('Path')
    expect(holes).toHaveLength(2)
    holes.forEach((hole, index) => {
      expect(hole.fillEnabled()).toBe(false)
      expect(hole.stroke()).toBe('#2563eb')
      const bounds = hole.getClientRect({ skipStroke: true, relativeTo: hole.getParent()! })
      expect(bounds.width).toBeCloseTo(diameter * 2, 3)
      expect(bounds.height).toBeCloseTo(diameter * 2, 3)
      expect(bounds.x).toBeCloseTo(8, 3)
      expect(bounds.y).toBeCloseTo((10 + index * 20) * 2, 3)
    })
  }
  view.rerender(canvas(0))
  expect(stage.find('Path')).toHaveLength(0)
})

it('follows the pointer near the effective edge and neighboring art without snapping', () => {
  const { image, origin } = mount([[item('moving', 10, 20), item('neighbor', 50, 20)]])
  begin(image)
  move(image, origin.x + 6 + 5, origin.y + 20 + 5)
  expect(image.absolutePosition().x).toBeCloseTo(origin.x + 11)
  move(image, origin.x + 36 + 5, origin.y + 20 + 5)
  expect(image.absolutePosition().x).toBeCloseTo(origin.x + 41)
  end(image)
  expect(image.x()).toBeCloseTo(41)
})

it('allows exactly 3 mm clearance and keeps the last valid position below that clearance', () => {
  const { image, origin } = mount([[item('moving', 10, 20), item('neighbor', 50, 20)]])
  begin(image)
  move(image, origin.x + 37 + 5, origin.y + 25)
  expect(image.absolutePosition().x).toBeCloseTo(origin.x + 42)
  move(image, origin.x + 37.1 + 5, origin.y + 25)
  expect(image.absolutePosition().x).toBeCloseTo(origin.x + 42)
  move(image, origin.x + 46 + 5, origin.y + 25)
  expect(image.absolutePosition().x).toBeCloseTo(origin.x + 42)
  end(image)
  expect(image.x()).toBeCloseTo(42)
})

it('commits a move to another board and still blocks leaving its effective area', () => {
  const { image, origin, stage, onPagesChange } = mount([[item('moving', 10, 20)], [item('neighbor', 50, 20, 12)]])
  begin(image)
  move(image, origin.x + 124 + 15, origin.y + 25)
  move(image, origin.x + 124 + 15, origin.y + 99)
  expect(image.absolutePosition().y).toBeCloseTo(origin.y + 25)
  end(image)
  const moved = stage.find<Konva.Image>('Image').find(node => node.width() === 10)!
  expect(stage.find('Image')).toHaveLength(2)
  expect(moved.getParent()!.x()).toBe(124)
  expect(moved.absolutePosition()).toEqual({ x: origin.x + 139, y: origin.y + 25 })
  const committed = onPagesChange.mock.calls.at(-1)![0] as PackedImpositionItem[][]
  expect(committed[0]).toEqual([])
  expect(committed[1].find(value => value.image.id === 'moving')).toMatchObject({ x: 10, y: 20 })
})

it('keeps valid rotations and restores both angle and position for an out-of-bounds rotation', () => {
  const { image, stage } = mount([[item('valid', 40, 40, 20, 10), item('edge', 60, 82, 20, 10)]])
  act(() => { image.rotation(90); image.fire('transformend') })
  expect(image.rotation()).toBe(90)
  const edge = stage.find<Konva.Image>('Image').find(node => node.y() > 80)!
  const originalPosition = edge.absolutePosition()
  act(() => { edge.rotation(90); edge.fire('transformend') })
  expect(edge.rotation()).toBe(0)
  expect(edge.absolutePosition()).toEqual(originalPosition)
})

it('checks every contour edge when adjacent outlines have different vertex counts', () => {
  const triangle: Array<[number, number]> = [[5, 0], [10, 10], [0, 10]]
  const longEdge: Array<[number, number]> = [[0, 0], [10, 0], [20, 0], [30, 0], [40, 0], [50, 0], [60, 0], [70, 0], [80, 0], [80, 10], [0, 10]]
  const { image, origin } = mount([[item('triangle', 35, 75, 10, 10, triangle), item('long-edge', 5, 50, 80, 10, longEdge)]])
  begin(image)
  move(image, origin.x + 40, origin.y + 63 + 5)
  expect(image.absolutePosition().y).toBeCloseTo(origin.y + 68)
  move(image, origin.x + 40, origin.y + 62 + 5)
  expect(image.absolutePosition().y).toBeCloseTo(origin.y + 68)
  end(image)
})

it.each([[90, 68, 45], [180, 58, 65], [270, 48, 55]])('uses the full image frame for the %s° contour transform', (rotation, neighborX, neighborY) => {
  const cornerContour: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const moving = { ...item('moving', 35, 45, 20, 30, cornerContour), rotation }
  const { image } = mount([[moving, item('neighbor', neighborX, neighborY)]])
  const initial = image.absolutePosition()
  begin(image)
  move(image, initial.x, initial.y)
  expect(image.absolutePosition()).toEqual(initial)
  move(image, initial.x + 1, initial.y)
  expect(image.absolutePosition().x).toBeCloseTo(initial.x)
  end(image)
})

it('uses the shared source contour for neighboring QT copies instead of their transparent frames', () => {
  const neighbor = { ...item('source#qt-2', 40, 40, 20, 30), rotation: 180 }
  neighbor.image.sourceImageId = 'source'
  const { image, origin } = mount([[item('moving', 10, 10), neighbor]], { source: [[0, 0], [10, 0], [10, 10], [0, 10]] })
  begin(image)
  move(image, origin.x + 45, origin.y + 50)
  expect(image.absolutePosition()).toEqual({ x: origin.x + 45, y: origin.y + 50 })
  end(image)
})

it('draws one representative per repeated plan, with production count and selection but no editing', () => {
  const pages = [[item('same', 10, 20)], [item('same#qt-2', 10, 20)], [item('different', 10, 20)]]
  const original = JSON.stringify(pages)
  const { stage, image, onSelect } = mount(pages, {}, true)
  expect(stage.find('Image')).toHaveLength(2)
  expect(stage.find<Konva.Text>('Text').map(node => node.text())).toEqual(['方案 1 · 需生产 2 块 · 利用率 1%', '方案 2 · 需生产 1 块 · 利用率 1%'])
  expect(stage.find<Konva.Image>('Image').every(node => !node.draggable())).toBe(true)
  expect(stage.findOne<Konva.Transformer>('Transformer')!.rotateEnabled()).toBe(false)
  act(() => { image.fire('click') })
  expect(onSelect).toHaveBeenCalledWith('same')
  expect(JSON.stringify(pages)).toBe(original)
})

it('expands every physical board before editing, preserving every repeated QT copy', () => {
  const pages = [[item('same', 10, 20)], [item('same#qt-2', 10, 20)], [item('same#qt-3', 10, 20)]]
  const original = JSON.stringify(pages)
  const { stage, setCollapsed } = mount(pages, {}, true)
  expect(stage.find('Image')).toHaveLength(1)
  setCollapsed(false)
  expect(stage.find<Konva.Image>('Image')).toHaveLength(3)
  expect(stage.find<Konva.Image>('Image').every(node => node.draggable())).toBe(true)
  expect(stage.findOne<Konva.Transformer>('Transformer')!.rotateEnabled()).toBe(true)
  const [first, second, third] = stage.find<Konva.Image>('Image')
  const start = first.absolutePosition()
  const untouched = [second.absolutePosition(), third.absolutePosition()]
  begin(first)
  move(first, start.x + 1, start.y)
  end(first)
  expect(first.absolutePosition().x).toBeCloseTo(start.x + 1)
  expect([second.absolutePosition(), third.absolutePosition()]).toEqual(untouched)
  expect(stage.find('Image')).toHaveLength(3)
  expect(JSON.stringify(pages)).toBe(original)
})

it('shows true outline area for QT copies in both folded and expanded board labels', () => {
  const copies = Array.from({ length: 4 }, (_, index) => {
    const copy = item(index === 0 ? 'triangle' : `triangle#qt-${index + 1}`, index % 2 === 0 ? 5 : 50, 10, 40, 20)
    copy.image.sourceImageId = 'triangle'
    return copy
  })
  const { stage, setCollapsed } = mount([copies.slice(0, 2), copies.slice(2)], { triangle: [[0, 0], [40, 0], [0, 20]] }, true)
  // Two 400 mm² outlines / 8100 mm² effective area = 9.876%, not 19.753% frame area.
  expect(stage.find<Konva.Text>('Text').map(node => node.text())).toEqual(['方案 1 · 需生产 2 块 · 利用率 10%'])
  setCollapsed(false)
  expect(stage.find<Konva.Text>('Text').map(node => node.text())).toEqual(['利用率 10%', '利用率 10%'])
})

it('does not hide invalid occupancy above 100 percent by clamping its displayed utilization', () => {
  const { stage } = mount([[item('overfull', 5, 5, 100, 100, [[0, 0], [100, 0], [100, 100], [0, 100]])]])
  expect(stage.findOne<Konva.Text>('Text')!.text()).toBe('利用率 123%')
})

it.each([0, 90, 180, 270])('keeps the complete image frame inside the effective area at %s°, including transparent margins', rotation => {
  const shape: Array<[number, number]> = [[5, 5], [15, 5], [15, 20], [5, 20]]
  const moving = { ...item('inset-art', 10, 20, 20, 30, shape), rotation }
  const { image, origin } = mount([[moving]])
  const width = rotation % 180 === 0 ? 20 : 30
  const height = rotation % 180 === 0 ? 30 : 20
  const atFrame = (x: number, y: number) => ({ x: origin.x + x + width / 2, y: origin.y + y + height / 2 })
  begin(image)
  const topLeft = atFrame(5, 5)
  move(image, topLeft.x, topLeft.y)
  move(image, topLeft.x - 1, topLeft.y)
  expect(image.absolutePosition()).toEqual(topLeft)
  move(image, topLeft.x, topLeft.y - 1)
  expect(image.absolutePosition()).toEqual(topLeft)
  const bottomRight = atFrame(95 - width, 95 - height)
  move(image, bottomRight.x, bottomRight.y)
  move(image, bottomRight.x + 1, bottomRight.y)
  expect(image.absolutePosition()).toEqual(bottomRight)
  move(image, bottomRight.x, bottomRight.y + 1)
  expect(image.absolutePosition()).toEqual(bottomRight)
  end(image)
})
