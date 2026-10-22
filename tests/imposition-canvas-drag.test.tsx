import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Konva from 'konva'
import ImpositionKonvaCanvas, { type PackedImpositionItem } from '../src/modules/imposition/ImpositionKonvaCanvas'
import type { ProductionImage } from '../src/modules/imposition/impositionRecords'
import { ImpositionCanvasImages, canvasPreviewEdge } from '../src/modules/imposition/impositionCanvasImages'
import { transformedPolygon } from '../src/modules/imposition/impositionGeometry'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

// Exercise real Konva nodes and React commits; only canvas painting is stubbed.
beforeEach(() => {
  native.invoke.mockReset()
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
  const onEdit = vi.fn()
  const canvas = (collapsed: boolean) => <ImpositionKonvaCanvas pages={pages} imageSources={{}} polygons={polygons} collapseRepeatedLayouts={collapsed} boardWidth={100} boardHeight={100} boardScale={1} effectiveX={5} effectiveY={5} effectiveWidth={90} effectiveHeight={90} spacing={3} holeCount={0} holeSize={3} holeLeft={2} holeGap={20} zoom={1} panOffset={{ x: 0, y: 0 }} panMode={false} onSelectImage={onSelect} onPagesChange={onPagesChange} onEdit={onEdit}/>
  const view = render(canvas(collapseRepeatedLayouts))
  const stage = Konva.stages.at(-1)!
  const image = stage.find<Konva.Image>('Image')[0]
  const origin = { x: image.absolutePosition().x - image.x(), y: image.absolutePosition().y - image.y() }
  return { stage, image, origin, onSelect, onPagesChange, onEdit, setCollapsed: (collapsed: boolean) => view.rerender(canvas(collapsed)) }
}

function begin(node: Konva.Image) { act(() => { node.fire('dragstart') }) }
function move(node: Konva.Image, x: number, y: number) { act(() => { node.absolutePosition({ x, y }); node.fire('dragmove') }) }
function end(node: Konva.Image) { act(() => { node.fire('dragend') }) }

it.each(Array.from({ length: 24 }, (_, index) => index * 15))('matches rendered contour coordinates to collision coordinates at %s degrees', rotation => {
  const polygon: Array<[number, number]> = [[1, 2], [19, 3], [14, 27], [4, 22]]
  const packed = { ...item('rotated', 35, 40, 20, 30, polygon), rotation }
  const { image } = mount([[packed]])
  const transform = image.getTransform()
  const expected = transformedPolygon(packed, rotation)
  polygon.forEach(([x, y], index) => {
    const rendered = transform.point({ x, y })
    expect(rendered.x).toBeCloseTo(expected[index].x, 8)
    expect(rendered.y).toBeCloseTo(expected[index].y, 8)
  })
})

it('checks the committed sibling position when moving a second image after the first', () => {
  const { image, stage, origin, onPagesChange } = mount([[item('first', 10, 20), item('second', 50, 20)]])
  begin(image)
  move(image, origin.x + 35, origin.y + 25)
  end(image)
  const second = stage.find<Konva.Image>('Image').find(node => node.id() === 'second')!
  begin(second)
  move(second, origin.x + 48, origin.y + 25)
  move(second, origin.x + 40, origin.y + 25)
  end(second)
  const committed = onPagesChange.mock.calls.at(-1)![0] as PackedImpositionItem[][]
  expect(committed[0].map(value => value.x)).toEqual([30, 43])
  expect(image.x()).toBeCloseTo(35)
  expect(second.x()).toBeCloseTo(48)
})

it('draws centered unfilled holes with an outer-edge span independent of diameter and canvas scaling', () => {
  const canvas = (diameter: number) => <ImpositionKonvaCanvas pages={[[item('art', 20, 20)]]} imageSources={{}} boardWidth={100} boardHeight={100} boardScale={2} effectiveX={5} effectiveY={5} effectiveWidth={90} effectiveHeight={90} spacing={3} holeCount={2} holeSize={diameter} holeLeft={4} holeGap={20} zoom={1.5} panOffset={{ x: 0, y: 0 }} panMode={false} onSelectImage={() => {}}/>
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
      expect(bounds.y).toBeCloseTo((40 + index * (20 - diameter)) * 2, 3)
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

it('previews a cross-board move within bounds and requests reflow without committing one QT', () => {
  const { image, origin, stage, onPagesChange, onEdit } = mount([[item('moving', 10, 20)], [item('neighbor', 50, 20, 12)]])
  begin(image)
  move(image, origin.x + 124 + 15, origin.y + 25)
  move(image, origin.x + 124 + 15, origin.y + 99)
  expect(image.absolutePosition().y).toBeCloseTo(origin.y + 25)
  end(image)
  const moved = stage.find<Konva.Image>('Image').find(node => node.width() === 10)!
  expect(stage.find('Image')).toHaveLength(2)
  expect(moved.getParent()!.x()).toBe(0)
  expect(moved.absolutePosition()).toEqual({ x: origin.x + 15, y: origin.y + 25 })
  const committed = onPagesChange.mock.calls.at(-1)![0] as PackedImpositionItem[][]
  expect(committed[0][0].image.id).toBe('moving')
  expect(committed[1]).toHaveLength(1)
  expect(onEdit.mock.calls.at(-1)![1].templateRepack.targetPlacement).toEqual({ sourceId: 'moving', xMm: 10, yMm: 20, rotationDeg: 0 })
})

it('keeps valid rotations and stops at the effective-area angular boundary', () => {
  const { image, stage } = mount([[item('valid', 40, 40, 20, 10), item('edge', 60, 82, 20, 10)]])
  act(() => { image.rotation(90); image.fire('transformend') })
  expect(image.rotation()).toBe(90)
  const edge = stage.find<Konva.Image>('Image').find(node => node.y() > 80)!
  const originalPosition = edge.absolutePosition()
  act(() => { edge.rotation(90); edge.fire('transformend') })
  expect(edge.rotation()).toBeGreaterThan(19)
  expect(edge.rotation()).toBeLessThan(20)
  expect(edge.absolutePosition()).toEqual(originalPosition)
})

it('keeps rotation previews 3 mm from neighboring outlines and preserves that limit on release', () => {
  const { image, stage } = mount([[item('moving', 40, 40, 20, 10), item('neighbor', 64, 40, 10, 20)]])
  const neighbor = stage.find<Konva.Image>('Image')[1]
  act(() => { image.fire('transformstart'); image.rotation(30); image.fire('transform') })
  expect(image.rotation()).toBeGreaterThan(0)
  expect(image.rotation()).toBeLessThan(30)
  const clearance = neighbor.getClientRect().x - (image.getClientRect().x + image.getClientRect().width)
  expect(clearance).toBeGreaterThanOrEqual(3 - 1e-7)
  const accepted = image.rotation()
  act(() => { image.fire('transformend') })
  expect(image.rotation()).toBe(accepted)
})

it('constrains rotation while the pointer is held and commits the latest legal angle on release', () => {
  const { image, onPagesChange } = mount([[item('edge', 60, 82, 20, 10)]])
  act(() => { image.fire('transformstart'); image.rotation(10); image.fire('transform') })
  expect(image.rotation()).toBe(10)
  act(() => { image.rotation(90); image.fire('transform') })
  // The invalid preview must already be constrained before mouse release.
  expect(image.rotation()).toBeGreaterThanOrEqual(10)
  expect(image.rotation()).toBeLessThan(90)
  const acceptedAngle = image.rotation()
  const acceptedPosition = image.absolutePosition()
  act(() => { image.fire('transformend') })
  expect(image.rotation()).toBe(acceptedAngle)
  expect(image.absolutePosition()).toEqual(acceptedPosition)
  const committed = onPagesChange.mock.calls.at(-1)![0] as PackedImpositionItem[][]
  expect(committed[0][0].rotation).toBe(acceptedAngle)
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

it('draws one representative per repeated plan, with production count, selection and direct editing', () => {
  const pages = [[item('same', 10, 20)], [item('same#qt-2', 10, 20)], [item('different', 10, 20)]]
  const original = JSON.stringify(pages)
  const { stage, image, onSelect } = mount(pages, {}, true)
  expect(stage.find('Image')).toHaveLength(2)
  expect(stage.find<Konva.Text>('Text').map(node => node.text())).toEqual(['方案 1 · 需生产 2 块 · 利用率 1%', '方案 2 · 需生产 1 块 · 利用率 1%'])
  expect(stage.find<Konva.Image>('Image').every(node => node.draggable())).toBe(true)
  expect(stage.findOne<Konva.Transformer>('Transformer')!.rotateEnabled()).toBe(true)
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

it('moves and rotates the matching slot on all folded copies while keeping their unique QT ids', () => {
  const pages = [[item('same', 20, 20, 20)], [item('same#qt-2', 20, 20, 20)], [item('same#qt-3', 20, 20, 20)]]
  const { image, origin, stage, onPagesChange, onEdit } = mount(pages, {}, true)
  begin(image)
  move(image, origin.x + 40, origin.y + 35)
  end(image)
  let committed = onPagesChange.mock.calls.at(-1)![0] as PackedImpositionItem[][]
  expect(committed.map(page => page[0].x)).toEqual([30, 30, 30])
  expect(committed.map(page => page[0].y)).toEqual([30, 30, 30])
  act(() => { image.fire('transformstart'); image.rotation(90); image.fire('transform'); image.fire('transformend') })
  committed = onPagesChange.mock.calls.at(-1)![0]
  expect(committed.map(page => page[0].rotation)).toEqual([90, 90, 90])
  expect(committed.flat().map(value => value.image.id)).toEqual(['same', 'same#qt-2', 'same#qt-3'])
  expect(stage.find('Image')).toHaveLength(1)
  expect(onEdit.mock.calls.at(-1)![1]).toMatchObject({ crossBoard: false, repeatedBoards: 3 })
})

it('maps a folded destination to its template and keeps the previous plan until reflow finishes', () => {
  const pages = [[item('same', 10, 20)], [item('same#qt-2', 10, 20)], [item('other', 50, 20, 12)], [item('other#qt-2', 50, 20, 12)]]
  const { image, origin, stage, onPagesChange, onEdit } = mount(pages, {}, true)
  begin(image)
  // Folded destination is display index 1, but physical board index 2.
  move(image, origin.x + 124 + 15, origin.y + 25)
  end(image)
  const committed = onPagesChange.mock.calls.at(-1)![0] as PackedImpositionItem[][]
  expect(committed).toEqual(pages)
  expect(committed.flat()).toHaveLength(4)
  expect(onEdit.mock.calls.at(-1)![1]).toMatchObject({ crossBoard: true, targetPageIndex: 2 })
  expect(onEdit.mock.calls.at(-1)![1].templateRepack.templates.map((value: { repeatCount: number }) => value.repeatCount)).toEqual([2, 2])
  expect(stage.find('Image')).toHaveLength(2)
})

it('enforces the same 3 mm clearance on folded plans', () => {
  const pages = [[item('same', 10, 20), item('neighbor', 50, 20)], [item('same#qt-2', 10, 20), item('neighbor#qt-2', 50, 20)]]
  const { image, origin, onPagesChange } = mount(pages, {}, true)
  begin(image)
  move(image, origin.x + 42, origin.y + 25)
  move(image, origin.x + 43, origin.y + 25)
  expect(image.absolutePosition().x).toBeCloseTo(origin.x + 42)
  end(image)
  const committed = onPagesChange.mock.calls.at(-1)![0] as PackedImpositionItem[][]
  expect(committed.map(page => page.find(value => value.image.id.startsWith('same'))!.x)).toEqual([37, 37])
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

it('decodes one shared image for 200 QT copies while the source is still loading', () => {
  const decoded: HTMLImageElement[] = []
  vi.spyOn(window, 'Image').mockImplementation(function () {
    const image = document.createElement('img')
    decoded.push(image)
    return image
  })
  const pages = [Array.from({ length: 200 }, (_, index) => {
    const packed = item(`qt-memory-${index}`, 10 + index % 10 * 5, 10 + Math.floor(index / 10) * 3, 2, 2)
    packed.image.sourceImageId = 'shared-memory-source'
    return packed
  })]
  const view = render(<ImpositionKonvaCanvas pages={pages} imageSources={{ 'shared-memory-source': 'data:image/png;base64,c2hhcmVkLW1lbW9yeS1zb3VyY2U=' }} boardWidth={100} boardHeight={100} boardScale={1} effectiveX={5} effectiveY={5} effectiveWidth={90} effectiveHeight={90} spacing={3} holeCount={0} holeSize={3} holeLeft={2} holeGap={20} zoom={1} panOffset={{ x: 0, y: 0 }} panMode={false} onSelectImage={() => {}}/>)
  expect(decoded).toHaveLength(1)
  act(() => decoded[0].dispatchEvent(new Event('load')))
  const nodes = Konva.stages.at(-1)!.find<Konva.Image>('Image')
  expect(nodes).toHaveLength(200)
  expect(new Set(nodes.map(node => node.image())).size).toBe(1)
  view.unmount()
  expect(decoded[0].getAttribute('src')).toBeNull()
})

function previewDecoder() {
  const images: HTMLImageElement[] = []
  vi.spyOn(window, 'Image').mockImplementation(function () {
    const image = document.createElement('img')
    images.push(image)
    return image
  })
  return images
}
const settlePreviews = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }

it('queues unique native previews, skips abandoned offscreen work, and continues after a bad source', async () => {
  const decoded = previewDecoder()
  native.invoke.mockImplementation(async (_command, args) => {
    if (args.path === 'bad.svg') throw new Error('bad SVG')
    return 'data:image/png;base64,AQ=='
  })
  const store = new ImpositionCanvasImages()
  const first = vi.fn(), second = vi.fn()
  const releases = Array.from({ length: 1028 }, () => store.acquire('shared.svg', undefined, 256, image => first(image)))
  const releaseOffscreen = store.acquire('offscreen.svg', undefined, 256, vi.fn())
  store.acquire('bad.svg', undefined, 256, vi.fn())
  store.acquire('next.svg', undefined, 256, second)
  releaseOffscreen()
  await settlePreviews()
  expect(native.invoke.mock.calls.map(([, args]) => args.path)).toEqual(['shared.svg'])
  expect(decoded).toHaveLength(1)
  decoded[0].dispatchEvent(new Event('load'))
  await settlePreviews()
  expect(native.invoke.mock.calls.map(([, args]) => args.path)).toEqual(['shared.svg', 'bad.svg', 'next.svg'])
  expect(native.invoke).toHaveBeenCalledWith('load_imposition_thumbnail', { path: 'shared.svg', maxEdgePx: 256 })
  decoded[1].dispatchEvent(new Event('load'))
  await settlePreviews()
  expect(first).toHaveBeenLastCalledWith(decoded[0])
  expect(second).toHaveBeenLastCalledWith(decoded[1])
  releases.forEach(release => release())
  store.dispose()
  expect(decoded.every(image => image.getAttribute('src') === null)).toBe(true)
})

it('bounds idle decoded caches and releases all image URLs on canvas disposal', async () => {
  const decoded = previewDecoder()
  const store = new ImpositionCanvasImages()
  for (let index = 0; index < 45; index++) {
    const release = store.acquire(undefined, `data:image/png;base64,${index}`, 128, vi.fn())
    decoded[index].dispatchEvent(new Event('load'))
    await settlePreviews()
    release()
  }
  expect(decoded.filter(image => image.hasAttribute('src'))).toHaveLength(32)
  store.dispose()
  expect(decoded.filter(image => image.hasAttribute('src'))).toHaveLength(0)
})

it('keeps native image loading restricted to visible boards and survives StrictMode cleanup', async () => {
  const decoded = previewDecoder()
  native.invoke.mockResolvedValue('data:image/png;base64,AQ==')
  const pages = Array.from({ length: 80 }, (_, index) => [item(`visible-memory-${index}`, 10, 10)])
  const paths = Object.fromEntries(pages.map(([piece]) => [piece.image.id, piece.image.filePath]))
  const canvas = (panY: number) => <StrictMode><ImpositionKonvaCanvas pages={pages} imagePaths={paths} boardWidth={100} boardHeight={100} boardScale={1} effectiveX={5} effectiveY={5} effectiveWidth={90} effectiveHeight={90} spacing={3} holeCount={0} holeSize={3} holeLeft={2} holeGap={20} zoom={1} panOffset={{ x: 0, y: panY }} panMode={false} onSelectImage={() => {}}/></StrictMode>
  const view = render(canvas(0))
  await act(settlePreviews)
  for (let index = 0; index < 20; index++) {
    await act(async () => { decoded.at(-1)?.dispatchEvent(new Event('load')); await settlePreviews() })
  }
  const loadedPaths = native.invoke.mock.calls.map(([, args]) => args.path)
  expect(new Set(loadedPaths).size).toBeLessThan(20)
  expect(loadedPaths).not.toContain('visible-memory-79.svg')
  expect(Konva.stages.at(-1)!.find<Konva.Image>('Image').every(node => node.image())).toBe(true)
  view.rerender(canvas(-2200))
  await act(settlePreviews)
  expect(native.invoke.mock.calls.some(([, args]) => args.path === 'visible-memory-68.svg')).toBe(true)
  view.unmount()
  expect(decoded.every(image => !image.hasAttribute('src'))).toBe(true)
})

it('caps preview resolution independently of print dimensions and extreme zoom', () => {
  expect([40, 128, 129, 256, 257, 20000].map(canvasPreviewEdge)).toEqual([128, 128, 256, 256, 512, 512])
})
