vi.mock('../src/services/backend', async () => { const core = await import('@tauri-apps/api/core'); return { invoke: core.invoke, storageMode: async () => ({ shared: false }) } })
import { createRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Konva from 'konva'
import { Group, Layer, Stage } from 'react-konva'
import { defaultLayoutBounds, pageRasterSvg, pageSvg, type Asset, type Page } from '../src/model'
import type { CanvasAnnotation } from '../src/modules/schematic/layoutTypes'
import { annotationsSvg, deleteEditorSelection, manualRulerGeometry, measuredDistance, recolorBackground, rulerCalibration } from '../src/modules/schematic/services/canvasAnnotationService'
import { groupBackgroundsSvg } from '../src/modules/schematic/services/groupBackgroundService'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'
import { createReviewRecord, loadReviewRecord, saveReviewRecord, type SchematicReviewRecord } from '../src/modules/schematic-review/reviewRecords'
import PageThumbnailList from '../src/modules/schematic/components/PageThumbnailList'
import CanvasDrawingSurface from '../src/modules/schematic/components/CanvasDrawingSurface'
import CanvasAnnotations from '../src/modules/schematic/components/CanvasAnnotations'
import { exportPdf } from '../src/modules/schematic/services/exportService'
import { RULER_COLOR } from '../src/modules/schematic/services/imageDimensionService'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(undefined)
  Konva.autoDrawEnabled = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: (text: string) => ({ width: text.length * 4 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => {} }) as unknown as CanvasRenderingContext2D)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); Konva.autoDrawEnabled = true })

const asset: Asset = { id: 'art', name: 'Art', productId: 'product', width: 200, height: 100, sourceGroupWidthMm: 80, sourceGroupHeightMm: 40,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>', previewUrl: '', thumbnailUrl: '' }
const assets = new Map([[asset.id, asset]])
const page = (id = 1): Page => ({ id, name: `Page ${id}`, items: [{ id: `item-${id}`, assetId: asset.id, x: 100, y: 200, w: 100, h: 50, rotation: 0, caption: 'Front' }], imageGroups: [{ id: `group-${id}`, itemIds: [`item-${id}`], x: 20, y: 150, width: 200, height: 100 }] })
const parseSvg = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml')

function pressCanvasNode(node: Konva.Node) {
  const origin = node.getAbsolutePosition()
  const down = new MouseEvent('mousedown', { clientX: origin.x, clientY: origin.y, buttons: 1 })
  act(() => { node.getStage()!.setPointersPositions(down); node.fire('mousedown', { evt: down }, true) })
  return origin
}

function moveCanvasPointer(point: { x: number; y: number }, buttons = 1) {
  act(() => { fireEvent.mouseMove(window, { clientX: point.x, clientY: point.y, buttons }) })
}

function releaseCanvasPointer(point: { x: number; y: number }) {
  act(() => { fireEvent.mouseUp(window, { clientX: point.x, clientY: point.y }) })
}

describe('canvas editor measurements', () => {
  it('measures the displayed image after rotation and manual scale, independent of canvas zoom', () => {
    const current = page()
    current.items[0].rotation = 90
    const calibration = rulerCalibration(current, assets, { x: 100, y: 290 }, new Map([['item-1', 2]]))
    expect(calibration.sourceItemId).toBe('item-1')
    expect(measuredDistance({ x: 100, y: 100 }, { x: 100, y: 300 }, calibration)).toBeCloseTo(80)
    expect(measuredDistance({ x: 50, y: 200 }, { x: 150, y: 200 }, calibration)).toBeCloseTo(40)
    expect(rulerCalibration(current, assets, { x: 160, y: 200 }, new Map([['item-1', 2]])).sourceItemId).toBeUndefined()
  })

  it('supports different horizontal and vertical scales in a rotated image', () => {
    const current = page()
    current.items[0].h = 20
    current.items[0].rotation = 37
    const start = { x: 100, y: 200 }
    const calibration = rulerCalibration(current, assets, start, new Map([['item-1', 1.5]]))
    const angle = 37 * Math.PI / 180
    const end = { x: start.x + 60 * Math.cos(angle) - 15 * Math.sin(angle), y: start.y + 60 * Math.sin(angle) + 15 * Math.cos(angle) }
    expect(measuredDistance(start, end, calibration)).toBeCloseTo(Math.hypot(32, 20))
  })

  it('uses the topmost image at the first point and A4 dimensions for empty canvas', () => {
    const current = page()
    current.items.push({ ...current.items[0], id: 'top', w: 200, h: 100 })
    const onImage = rulerCalibration(current, assets, { x: 100, y: 200 })
    expect(onImage.sourceItemId).toBe('top')
    expect(measuredDistance({ x: 100, y: 200 }, { x: 200, y: 200 }, onImage)).toBe(40)
    const empty = rulerCalibration(current, assets, { x: 400, y: 600 })
    expect(empty.sourceItemId).toBeUndefined()
    expect(measuredDistance({ x: 0, y: 0 }, { x: 500, y: 0 }, empty)).toBe(210)
  })
})

describe('editable captions and annotations', () => {
  it('deleting a generated caption preserves the image and suppresses the text in both export formats', () => {
    const original = page()
    const edited = deleteEditorSelection(original, { kind: 'caption', id: 'item-1' })
    expect(edited.items).toHaveLength(1)
    expect(edited.items[0]).toEqual({ ...original.items[0], captionHidden: true })
    expect(original.items[0].captionHidden).toBeUndefined()
    for (const svg of [pageSvg(edited, assets), pageRasterSvg(edited, assets)]) {
      const document = parseSvg(svg)
      expect(document.querySelectorAll('image')).toHaveLength(1)
      expect([...document.querySelectorAll('text')].some(node => node.textContent === 'Front')).toBe(false)
    }
  })

  it('deleting the empty Example caption leaves its slot and the group artwork in place', () => {
    const original = page()
    original.imageGroups![0].imageCells = [{ itemId: 'empty-example', x: 20, y: 150, width: 40, height: 80, label: 'Example' }]
    const edited = deleteEditorSelection(original, { kind: 'empty-caption', id: 'empty-example', groupId: 'group-1' })
    expect(edited.items).toEqual(original.items)
    expect(edited.imageGroups![0].imageCells).toEqual([{ ...original.imageGroups![0].imageCells[0], label: undefined }])
    expect(groupBackgroundsSvg(edited)).not.toContain('>Example</text>')
  })

  it('removes only the selected custom annotation', () => {
    const original = page()
    original.annotations = [
      { id: 'text', kind: 'text', x: 10, y: 20, text: 'note', color: '#000', fontSize: 10 },
      { id: 'ruler', kind: 'ruler', x: 10, y: 30, x2: 100, y2: 30, measuredMm: 40, color: '#123456' },
    ]
    const edited = deleteEditorSelection(original, { kind: 'annotation', id: 'text' })
    expect(edited.annotations?.map(annotation => annotation.id)).toEqual(['ruler'])
    expect(edited.items).toEqual(original.items)
    expect(original.annotations).toHaveLength(2)
  })

  it('exports multiline text and manual rulers while escaping text and attribute content', () => {
    const annotations: CanvasAnnotation[] = [
      { id: 'text', kind: 'text', x: 12, y: 18, text: 'A & <B>\n"quote" <script>bad</script>', color: '#123456" onload="bad', fontSize: 11 },
      { id: 'ruler', kind: 'ruler', x: 10, y: 40, x2: 110, y2: 80, measuredMm: 42.126, color: '#126abc' },
    ]
    const document = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg">${annotationsSvg(annotations)}</svg>`)
    expect(document.querySelector('parsererror')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('[onload]')).toBeNull()
    expect([...document.querySelectorAll('tspan')].map(node => node.textContent)).toEqual(['A & <B>', '"quote" <script>bad</script>'])
    expect(document.querySelector('text')?.getAttribute('fill')).toBe(annotations[0].color)
    expect([...document.querySelectorAll('text')].at(-1)?.textContent).toBe('42.13 mm')

    // A manual ruler keeps the same visual grammar as a generated ruler:
    // two short extension lines, two measurement segments around the label,
    // and two filled triangular arrowheads.
    const ruler = document.querySelector('g[data-canvas-annotations] > g:last-child')
    expect(ruler).not.toBeNull()
    const paths = [...ruler!.querySelectorAll('path')]
    expect(paths).toHaveLength(6)
    const geometry = manualRulerGeometry(annotations[1])
    const pathLine = ([x1, y1, x2, y2]: [number, number, number, number]) => `M${x1} ${y1}L${x2} ${y2}`
    expect(paths.slice(0, 2).map(path => path.getAttribute('d'))).toEqual(geometry.extension.map(pathLine))
    expect(paths.slice(2, 4).map(path => path.getAttribute('d'))).toEqual(geometry.segment.map(pathLine))
    expect(paths[4].getAttribute('d')).toContain(`M${geometry.arrowStart[0]} ${geometry.arrowStart[1]}`)
    expect(paths[5].getAttribute('d')).toContain(`M${geometry.arrowEnd[0]} ${geometry.arrowEnd[1]}`)
    paths.forEach(path => expect(path.getAttribute('stroke')).toBe(RULER_COLOR))
    paths.slice(4).forEach(path => expect(path.getAttribute('fill')).toBe(RULER_COLOR))
    expect(ruler!.querySelector('text')?.getAttribute('fill')).toBe(RULER_COLOR)
    for (const svg of [pageSvg({ ...page(), annotations }, assets), pageRasterSvg({ ...page(), annotations }, assets)]) {
      const output = parseSvg(svg).querySelector('[data-canvas-annotations]')!
      expect(output.querySelector('text')?.getAttribute('fill')).toBe(annotations[0].color)
      expect(output.querySelector('g')?.querySelector('text')?.getAttribute('fill')).toBe(RULER_COLOR)
      output.querySelectorAll('path').forEach(path => expect(path.getAttribute('stroke')).toBe(RULER_COLOR))
    }
  })

  it.each([true, false])('renders legacy manual rulers in generated-ruler blue with interactive=%s', interactive => {
    const annotations: CanvasAnnotation[] = [
      { id: 'ruler', kind: 'ruler', x: 40, y: 50, x2: 140, y2: 70, measuredMm: 40, color: '#000' },
      { id: 'text', kind: 'text', x: 40, y: 80, text: 'note', color: '#c000aa', fontSize: 12 },
    ]
    const stageRef = createRef<Konva.Stage>()
    render(<Stage ref={stageRef} width={400} height={300}><Layer>
      <CanvasAnnotations annotations={annotations} interactive={interactive} onSelect={vi.fn()} onChange={vi.fn()} onEdit={vi.fn()}/>
    </Layer></Stage>)
    const lines = stageRef.current!.find<Konva.Line>('Line')
    expect(lines).toHaveLength(6)
    lines.forEach(line => {
      expect(line.stroke()).toBe(RULER_COLOR)
      if (line.closed()) expect(line.fill()).toBe(RULER_COLOR)
    })
    expect(stageRef.current!.find<Konva.Text>('Text').map(text => text.fill())).toEqual([RULER_COLOR, '#c000aa'])
  })

  it.each([
    { end: { x: 140, y: 50 }, rotation: 0 },
    { end: { x: 40, y: 150 }, rotation: -90 },
    { end: { x: 40, y: -50 }, rotation: -90 },
    { end: { x: 140, y: 150 }, rotation: 45 },
    { end: { x: -60, y: -50 }, rotation: 45 },
  ])('rotates manual ruler text with its line at $rotation degrees in canvas and exports', ({ end, rotation }) => {
    const annotation: Extract<CanvasAnnotation, { kind: 'ruler' }> = { id: 'angle', kind: 'ruler', x: 40, y: 50, x2: end.x, y2: end.y, measuredMm: 40, color: '#000', extensionOffset: -30 }
    const stageRef = createRef<Konva.Stage>()
    render(<Stage ref={stageRef} width={400} height={300}><Layer>
      <CanvasAnnotations annotations={[annotation]} interactive onSelect={vi.fn()} onChange={vi.fn()} onEdit={vi.fn()}/>
    </Layer></Stage>)
    const label = stageRef.current!.findOne<Konva.Text>('.manual-ruler-label')!
    const geometry = manualRulerGeometry(annotation)
    expect(label.rotation()).toBeCloseTo(rotation)
    expect(label.x() + annotation.x).toBeCloseTo(geometry.textX)
    expect(label.y() + annotation.y).toBeCloseTo(geometry.textY)
    const current = { ...page(), annotations: [annotation] }
    for (const svg of [pageSvg(current, assets), pageRasterSvg(current, assets)]) {
      const text = parseSvg(svg).querySelector('[data-canvas-annotations] text')!
      expect(text.getAttribute('transform')).toBe(`rotate(${rotation} ${geometry.textX} ${geometry.textY})`)
      expect(text.textContent).toBe('40 mm')
    }
  })

  it.each([1, 0.7, 1.6, 2.5])('keeps a manual ruler at its release position after repeated whole-ruler drags at zoom %s', zoom => {
    const original = { id: 'ruler', kind: 'ruler' as const, x: 40, y: 50, x2: 140, y2: 70, measuredMm: 40, color: '#000', extensionOffset: -25 }
    const stageRef = createRef<Konva.Stage>()
    const changes: CanvasAnnotation[] = []
    let expected = original
    function Harness() {
      const [annotation, setAnnotation] = useState<CanvasAnnotation>(original)
      const [selectedId, setSelectedId] = useState<string>()
      return <Stage ref={stageRef} width={800} height={600}><Layer><Group x={80} y={40} scaleX={zoom} scaleY={zoom}>
        <CanvasAnnotations annotations={[annotation]} selectedId={selectedId} interactive onSelect={setSelectedId} onChange={next => { changes.push(next); setAnnotation(next) }} onEdit={vi.fn()}/>
      </Group></Layer></Stage>
    }
    render(<Harness/>)
    for (const delta of [{ x: 30, y: 20 }, { x: -15, y: 12 }]) {
      const handles = stageRef.current!.find('.manual-ruler-arrow')
      const positions = handles.map(handle => handle.getAbsolutePosition())
      const label = stageRef.current!.findOne('.manual-ruler-label')!
      const origin = pressCanvasNode(label)
      const destination = { x: origin.x + delta.x * zoom, y: origin.y + delta.y * zoom }
      moveCanvasPointer(destination)
      const beforeRelease = handles.map(handle => handle.getAbsolutePosition())
      beforeRelease.forEach((point, index) => {
        expect(point.x).toBeCloseTo(positions[index].x + delta.x * zoom)
        expect(point.y).toBeCloseTo(positions[index].y + delta.y * zoom)
      })
      releaseCanvasPointer(destination)
      expected = { ...expected, x: expected.x + delta.x, y: expected.y + delta.y, x2: expected.x2 + delta.x, y2: expected.y2 + delta.y }
      const saved = changes.at(-1)!
      expect(saved.kind).toBe('ruler')
      expect(saved.x).toBeCloseTo(expected.x)
      expect(saved.y).toBeCloseTo(expected.y)
      if (saved.kind !== 'ruler') throw new Error('Expected a ruler')
      expect(saved.x2).toBeCloseTo(expected.x2)
      expect(saved.y2).toBeCloseTo(expected.y2)
      expect(saved.measuredMm).toBe(original.measuredMm)
      expect(saved.extensionOffset).toBe(-25)
      moveCanvasPointer({ x: destination.x + 50, y: destination.y + 30 }, 0)
      handles.forEach((handle, index) => {
        expect(handle.getAbsolutePosition().x).toBeCloseTo(beforeRelease[index].x)
        expect(handle.getAbsolutePosition().y).toBeCloseTo(beforeRelease[index].y)
      })
    }
    for (const endpoint of [0, 1]) {
      const handles = stageRef.current!.find('.manual-ruler-arrow')
      const opposite = handles[1 - endpoint].getAbsolutePosition()
      const origin = pressCanvasNode(handles[endpoint])
      const destination = { x: origin.x + 18 * zoom, y: origin.y - 10 * zoom }
      moveCanvasPointer(destination)
      const beforeRelease = handles[endpoint].getAbsolutePosition()
      releaseCanvasPointer(destination)
      expected = endpoint === 0
        ? { ...expected, x: expected.x + 18, y: expected.y - 10 }
        : { ...expected, x2: expected.x2 + 18, y2: expected.y2 - 10 }
      const saved = changes.at(-1)!
      if (saved.kind !== 'ruler') throw new Error('Expected a ruler')
      expect(saved.x).toBeCloseTo(expected.x)
      expect(saved.y).toBeCloseTo(expected.y)
      expect(saved.x2).toBeCloseTo(expected.x2)
      expect(saved.y2).toBeCloseTo(expected.y2)
      expect(saved.measuredMm).toBe(original.measuredMm)
      expect(saved.extensionOffset).toBe(-25)
      expect(handles[1 - endpoint].getAbsolutePosition().x).toBeCloseTo(opposite.x)
      expect(handles[1 - endpoint].getAbsolutePosition().y).toBeCloseTo(opposite.y)
      expect(handles[endpoint].getAbsolutePosition().x).toBeCloseTo(beforeRelease.x)
      expect(handles[endpoint].getAbsolutePosition().y).toBeCloseTo(beforeRelease.y)
    }
    expect(changes).toHaveLength(4)
  })

  it('drags either manual ruler endpoint while keeping the opposite endpoint fixed', () => {
    const original: Extract<CanvasAnnotation, { kind: 'ruler' }> = { id: 'ruler', kind: 'ruler', x: 40, y: 50, x2: 140, y2: 50, measuredMm: 40, color: '#126abc' }
    const stageRef = createRef<Konva.Stage>()
    const changes: CanvasAnnotation[] = []
    function Harness() {
      const [annotation, setAnnotation] = useState<CanvasAnnotation>(original)
      return <Stage ref={stageRef} width={400} height={300}><Layer><CanvasAnnotations annotations={[annotation]} selectedId="ruler" interactive onSelect={vi.fn()} onChange={next => { changes.push(next); setAnnotation(next) }} onEdit={vi.fn()}/></Layer></Stage>
    }
    render(<Harness/>)
    const handles = stageRef.current!.find('.manual-ruler-arrow')
    expect(handles).toHaveLength(2)
    const end = handles[1]
    const opposite = handles[0].getAbsolutePosition()
    const origin = end.getAbsolutePosition()
    const down = new MouseEvent('mousedown', { clientX: origin.x, clientY: origin.y, buttons: 1 })
    act(() => { stageRef.current!.setPointersPositions(down); end.fire('mousedown', { evt: down }, true) })
    act(() => { fireEvent.mouseMove(window, { clientX: origin.x + 20, clientY: origin.y + 10, buttons: 1 }) })
    act(() => { fireEvent.mouseUp(window, { clientX: origin.x + 20, clientY: origin.y + 10 }) })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'ruler', x: original.x, y: original.y, x2: original.x2 + 20, y2: original.y2 + 10 })
    expect(handles[0].getAbsolutePosition()).toEqual(opposite)
  })
})

describe('background color scope', () => {
  const fixture = () => [page(1), page(2), page(3)]
  it('changes only selected groups on the active page', () => {
    const original = fixture()
    original[1].items.push({ ...original[1].items[0], id: 'extra-2' })
    original[1].imageGroups!.push({ ...original[1].imageGroups![0], id: 'other-2', itemIds: ['extra-2'] })
    const changed = recolorBackground(original, 2, ['group-2'], 'group', '#ffcc00')
    expect(changed[0]).toBe(original[0])
    expect(changed[2]).toBe(original[2])
    expect(changed[1].backgroundColor).toBeUndefined()
    expect(changed[1].imageGroups?.map(group => group.backgroundColor)).toEqual(['#ffcc00', undefined])
    expect(original[1].imageGroups![0].backgroundColor).toBeUndefined()
  })

  it('changes all groups on one page, or all pages in the batch, including legacy free images', () => {
    const original = fixture()
    original[1].imageGroups = undefined
    const changedPage = recolorBackground(original, 2, [], 'page', '#abcdef')
    expect(changedPage[0]).toBe(original[0])
    expect(changedPage[2]).toBe(original[2])
    expect(changedPage[1].backgroundColor).toBe('#abcdef')
    expect(changedPage[1].imageGroups?.map(group => group.backgroundColor)).toEqual(['#abcdef'])
    const changedBatch = recolorBackground(changedPage, 2, [], 'batch', '#fedcba')
    expect(changedBatch.map(current => current.backgroundColor)).toEqual(['#fedcba', '#fedcba', '#fedcba'])
    for (const current of changedBatch) {
      expect(current.imageGroups?.every(group => group.backgroundColor === '#fedcba')).toBe(true)
      expect(parseSvg(`<svg>${groupBackgroundsSvg(current)}</svg>`).querySelector('[data-group-background]')?.getAttribute('fill')).toBe('#fedcba')
    }
  })
})

it('review snapshots roundtrip page ordering, colors, deleted captions, annotations and edited ruler values independently', async () => {
  const pages = [page(9), page(4)]
  pages[0].backgroundColor = '#ffccaa'
  pages[0].imageGroups![0].backgroundColor = '#abcdef'
  pages[0].items[0].captionHidden = true
  pages[0].items[0].captionColor = '#654321'
  pages[0].items[0].rulerHeightMm = 71.25
  pages[0].annotations = [
    { id: 'text', kind: 'text', x: 10, y: 20, text: 'saved', color: '#000', fontSize: 12 },
    { id: 'ruler', kind: 'ruler', x: 10, y: 30, x2: 100, y2: 30, measuredMm: 40, color: '#123456', sourceItemId: 'item-9', extensionOffset: -24 },
  ]
  const record = createReviewRecord({ assets: [asset], pages, activePage: 9, metadata: { customerName: 'client', drawingDate: '', estimatedShipDate: '', designer: '' },
    layoutBounds: defaultLayoutBounds, arrangementSort: 'default', defaultArrangementIds: [asset.id] }, emptyArrangementDisplayState(), 'pdf', 'proof.pdf')
  expect(record.pages).toEqual(pages)
  pages[0].annotations[0].color = '#fff'
  pages[0].items[0].rulerHeightMm = 42
  pages[0].imageGroups![0].backgroundColor = '#ffffff'
  pages.reverse()
  expect(record.pages.map(current => current.id)).toEqual([9, 4])
  expect(record.pages[0].annotations![0].color).toBe('#000')
  expect(record.pages[0].items[0].rulerHeightMm).toBe(71.25)
  expect(record.pages[0].imageGroups![0].backgroundColor).toBe('#abcdef')
  let stored: SchematicReviewRecord | undefined
  native.invoke.mockImplementation(async (command, payload) => {
    if (command === 'save_schematic_review') stored = JSON.parse(JSON.stringify(payload.record))
    if (command === 'load_schematic_review') return stored
    return undefined
  })
  await saveReviewRecord(record)
  const restored = await loadReviewRecord(record.id)
  expect(restored.pages).toEqual(record.pages)
  expect(restored.pages[0].items[0].captionHidden).toBe(true)
  expect(restored.pages[0].items[0].captionColor).toBe('#654321')
  expect(restored.pages[0].annotations?.[1]).toMatchObject({ kind: 'ruler', measuredMm: 40, sourceItemId: 'item-9', extensionOffset: -24 })
})

describe('drawing surface', () => {
  function drawing(tool: 'text' | 'ruler' = 'ruler') {
    const onText = vi.fn(), onRuler = vi.fn(), onCancel = vi.fn()
    const rendered = render(<CanvasDrawingSurface tool={tool} page={page()} assets={assets} x={50} y={50} scale={2} color="#456abc"
      toPaper={(x, y) => ({ x: (x - 50) / 2, y: (y - 50) / 2 })} onText={onText} onRuler={onRuler} onCancel={onCancel}/>)
    return { ...rendered, onText, onRuler, onCancel, surface: screen.getByLabelText(tool === 'ruler' ? '点击画布绘制标尺' : '点击画布添加文字') }
  }

  it('fixes two measured points then previews a parallel offset until the third click commits', () => {
    const { surface, container, onRuler } = drawing()
    fireEvent.click(surface, { clientX: 250, clientY: 450 })
    expect(onRuler).not.toHaveBeenCalled()
    fireEvent(surface, new MouseEvent('pointermove', { bubbles: true, clientX: 350, clientY: 450 }))
    const segment = container.querySelector('[data-ruler-segment]')
    expect(segment?.getAttribute('x1')).toBe('100')
    expect(segment?.getAttribute('x2')).toBe('110')
    expect(container.querySelector('text')?.textContent).toBe('40 mm')
    container.querySelectorAll('[stroke]').forEach(node => expect(node.getAttribute('stroke')).toBe(RULER_COLOR))
    container.querySelectorAll('[fill]').forEach(node => expect(node.getAttribute('fill')).toBe(RULER_COLOR))
    fireEvent.click(surface, { clientX: 350, clientY: 450 })
    expect(onRuler).not.toHaveBeenCalled()
    fireEvent(surface, new MouseEvent('pointermove', { bubbles: true, clientX: 330, clientY: 510 }))
    expect(container.querySelector('[data-ruler-segment]')?.getAttribute('y1')).toBe('230')
    const extension = container.querySelector('[data-ruler-extension]')!
    expect(['x1', 'y1', 'x2', 'y2'].map(name => extension.getAttribute(name))).toEqual(['100', '200', '100', '230'])
    expect(container.querySelector('text')?.textContent).toBe('40 mm')
    fireEvent.click(surface, { clientX: 330, clientY: 510 })
    expect(onRuler).toHaveBeenCalledOnce()
    expect(onRuler.mock.calls[0][0]).toMatchObject({ kind: 'ruler', x: 100, y: 230, x2: 150, y2: 230, color: RULER_COLOR, measuredMm: 40, sourceItemId: 'item-1', extensionOffset: 30 })
    expect(container.querySelector('svg')).toBeNull()
  })

  it.each([50, 150])('lets the user put vertical extensions on either side at x=%s', x => {
    const { surface, container, onRuler } = drawing()
    fireEvent.click(surface, { clientX: 250, clientY: 450 })
    fireEvent.click(surface, { clientX: 250, clientY: 650 })
    expect(onRuler).not.toHaveBeenCalled()
    fireEvent(surface, new MouseEvent('pointermove', { bubbles: true, clientX: x * 2 + 50, clientY: 550 }))
    const extension = container.querySelector('[data-ruler-extension]')!
    expect(['x1', 'y1', 'x2', 'y2'].map(name => Number(extension.getAttribute(name)))).toEqual([100, 200, x, 200])
    expect(container.querySelector('text')?.getAttribute('transform')).toMatch(/^rotate\(-90 /)
    expect(container.querySelector('text')?.textContent).toBe('80 mm')
    fireEvent.click(surface, { clientX: x * 2 + 50, clientY: 550 })
    expect(onRuler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ x, y: 200, x2: x, y2: 300, extensionOffset: 100 - x, measuredMm: 80 }))
  })

  it('projects the third click perpendicular to a diagonal ruler without changing the measured length', () => {
    const { surface, container, onRuler } = drawing()
    fireEvent.click(surface, { clientX: 250, clientY: 450 })
    fireEvent.click(surface, { clientX: 350, clientY: 550 })
    fireEvent(surface, new MouseEvent('pointermove', { bubbles: true, clientX: 350, clientY: 450 }))
    expect(container.querySelector('text')?.getAttribute('transform')).toMatch(/^rotate\(45 /)
    fireEvent.click(surface, { clientX: 350, clientY: 450 })
    const ruler = onRuler.mock.calls[0][0]
    expect(ruler.x).toBeCloseTo(125)
    expect(ruler.y).toBeCloseTo(175)
    expect(ruler.x2).toBeCloseTo(175)
    expect(ruler.y2).toBeCloseTo(225)
    expect(ruler.extensionOffset).toBeCloseTo(-Math.sqrt(1250))
    expect(ruler.measuredMm).toBeCloseTo(Math.sqrt(5000) * .8)
    const geometry = manualRulerGeometry(ruler)
    expect(geometry.extension[0][0]).toBeCloseTo(100)
    expect(geometry.extension[0][1]).toBeCloseTo(200)
    expect(geometry.extension[1][0]).toBeCloseTo(150)
    expect(geometry.extension[1][1]).toBeCloseTo(250)
  })

  it('cancels offset placement without saving a partial ruler and permits a zero extension', () => {
    const { surface, container, onRuler, onCancel } = drawing()
    fireEvent.click(surface, { clientX: 250, clientY: 450 })
    fireEvent.click(surface, { clientX: 350, clientY: 450 })
    fireEvent(surface, new MouseEvent('pointermove', { bubbles: true, clientX: 350, clientY: 550 }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onRuler).not.toHaveBeenCalled()
    expect(container.querySelector('svg')).toBeNull()
    fireEvent.click(surface, { clientX: 250, clientY: 450 })
    fireEvent.click(surface, { clientX: 350, clientY: 450 })
    fireEvent.click(surface, { clientX: 350, clientY: 450 })
    expect(onRuler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ x: 100, y: 200, x2: 150, y2: 200, extensionOffset: 0, measuredMm: 40 }))
  })

  it('ignores off-paper clicks and zero-length rulers; Escape cancels before committing', () => {
    const { surface, container, onRuler, onCancel } = drawing()
    fireEvent.click(surface, { clientX: 0, clientY: 0 })
    expect(container.querySelector('svg')).toBeNull()
    fireEvent.click(surface, { clientX: 250, clientY: 450 })
    fireEvent.click(surface, { clientX: 250, clientY: 450 })
    expect(onRuler).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
    expect(container.querySelector('svg')).toBeNull()
    expect(onRuler).not.toHaveBeenCalled()
  })

  it('places new text in page coordinates without starting a ruler', () => {
    const { surface, container, onText, onRuler } = drawing('text')
    fireEvent.click(surface, { clientX: 250, clientY: 450 })
    expect(onText).toHaveBeenCalledWith({ x: 100, y: 200 })
    expect(onRuler).not.toHaveBeenCalled()
    expect(container.querySelector('svg')).toBeNull()
  })
})

function thumbnailHarness(disabled = false) {
  const reorder = vi.fn()
  const select = vi.fn()
  function Harness() {
    const [pages, setPages] = useState<Page[]>([31, 11, 21].map(id => ({ id, name: `Page ${id}`, items: [] })))
    const [activePage, setActivePage] = useState(11)
    return <><output data-testid="order">{pages.map(current => current.id).join(',')}</output><output data-testid="active">{activePage}</output>
      <PageThumbnailList pages={pages} assets={assets} activePage={activePage} disabled={disabled} onSelect={id => { select(id); setActivePage(id) }} onReorder={(source, target) => {
        reorder(source, target)
        setPages(current => {
          const next = [...current], from = next.findIndex(value => value.id === source), to = next.findIndex(value => value.id === target)
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          return next
        })
      }}/></>
  }
  const rendered = render(<Harness/>)
  return { ...rendered, reorder, select }
}

function dataTransfer() {
  const values = new Map<string, string>()
  return { get types() { return [...values.keys()] }, setData: (type: string, value: string) => values.set(type, value), getData: (type: string) => values.get(type) ?? '', effectAllowed: '', dropEffect: '' }
}

function pointerEvent(target: Element, type: string, x: number, y: number, pointerId = 1, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  fireEvent(target, event)
}

function pointerTargets(container: HTMLElement) {
  const cards = [...container.querySelectorAll<HTMLElement>('.page-sort-item')]
  const captures = cards.map(card => {
    const active = new Set<number>()
    const capture = vi.fn((id: number) => { active.add(id) })
    const release = vi.fn((id: number) => { active.delete(id) })
    Object.assign(card, { setPointerCapture: capture, hasPointerCapture: (id: number) => active.has(id), releasePointerCapture: release })
    return { capture, release }
  })
  const at = vi.fn<(x: number, y: number) => Element | null>().mockReturnValue(null)
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: at })
  return { cards, captures, at }
}

describe('page thumbnails ordering', () => {
  const originalPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
  afterEach(() => { if (originalPoint) Object.defineProperty(document, 'elementFromPoint', originalPoint); else Reflect.deleteProperty(document, 'elementFromPoint') })

  it('keeps a small pointer movement as a page click instead of starting a reorder', () => {
    const { container, reorder, select } = thumbnailHarness()
    const { cards, captures, at } = pointerTargets(container)
    at.mockReturnValue(cards[2])
    pointerEvent(cards[0], 'pointerdown', 20, 20)
    pointerEvent(cards[0], 'pointermove', 22, 23)
    pointerEvent(cards[0], 'pointerup', 22, 23)
    fireEvent.click(cards[0].querySelector('.page-card')!)
    expect(captures[0].capture).not.toHaveBeenCalled()
    expect(reorder).not.toHaveBeenCalled()
    expect(select).toHaveBeenCalledWith(31)
    expect(screen.getByTestId('active').textContent).toBe('31')
  })

  it('reorders at the pointer-up target after capture without accidentally navigating to the dragged page', () => {
    const { container, reorder, select } = thumbnailHarness()
    const { cards, captures, at } = pointerTargets(container)
    at.mockReturnValue(cards[1].querySelector('.page-number'))
    pointerEvent(cards[0], 'pointerdown', 20, 20, 7)
    pointerEvent(cards[0], 'pointermove', 24, 24, 7)
    expect(captures[0].capture).toHaveBeenCalledWith(7)
    expect(cards[1].className).toContain('is-drag-over')
    at.mockReturnValue(cards[2].querySelector('.page-number'))
    pointerEvent(cards[0], 'pointerup', 20, 200, 7)
    fireEvent.click(cards[0].querySelector('.page-card')!)
    expect(reorder).toHaveBeenCalledExactlyOnceWith(31, 21)
    expect(captures[0].release).toHaveBeenCalledWith(7)
    expect(select).not.toHaveBeenCalled()
    expect(screen.getByTestId('order').textContent).toBe('11,21,31')
    expect(screen.getByTestId('active').textContent).toBe('11')
    expect(container.querySelector('.is-drag-over')).toBeNull()
    pointerEvent(cards[0], 'pointerdown', 20, 200, 8)
    pointerEvent(cards[0], 'pointerup', 20, 200, 8)
    fireEvent.click(cards[0].querySelector('.page-card')!)
    expect(select).toHaveBeenCalledExactlyOnceWith(31)
  })

  it('cancels a pointer reorder or a drop outside the thumbnail list without moving pages', () => {
    const { container, reorder } = thumbnailHarness()
    const { cards, at } = pointerTargets(container)
    at.mockReturnValue(cards[2])
    pointerEvent(cards[0], 'pointerdown', 20, 20)
    pointerEvent(cards[0], 'pointermove', 20, 100)
    pointerEvent(cards[0], 'pointercancel', 20, 100)
    expect(container.querySelector('.is-drag-over')).toBeNull()
    pointerEvent(cards[0], 'pointerup', 20, 100)
    expect(reorder).not.toHaveBeenCalled()
    pointerEvent(cards[0], 'pointerdown', 20, 20)
    pointerEvent(cards[0], 'pointermove', 20, 100)
    at.mockReturnValue(null)
    pointerEvent(cards[0], 'pointerup', 800, 100)
    expect(reorder).not.toHaveBeenCalled()
    expect(screen.getByTestId('order').textContent).toBe('31,11,21')
  })

  it('does not start pointer reordering when disabled, from a secondary button, or from sort controls', () => {
    const disabled = thumbnailHarness(true)
    const disabledTargets = pointerTargets(disabled.container)
    disabledTargets.at.mockReturnValue(disabledTargets.cards[2])
    pointerEvent(disabledTargets.cards[0], 'pointerdown', 20, 20)
    pointerEvent(disabledTargets.cards[0], 'pointermove', 20, 100)
    pointerEvent(disabledTargets.cards[0], 'pointerup', 20, 100)
    expect(disabled.reorder).not.toHaveBeenCalled()
    expect(disabledTargets.captures[0].capture).not.toHaveBeenCalled()
    disabled.unmount()
    const enabled = thumbnailHarness()
    const { cards, captures, at } = pointerTargets(enabled.container)
    at.mockReturnValue(cards[2])
    pointerEvent(cards[0], 'pointerdown', 20, 20, 1, 2)
    pointerEvent(cards[0], 'pointermove', 20, 100, 1, 2)
    pointerEvent(cards[0], 'pointerup', 20, 100, 1, 2)
    const downButton = screen.getByRole('button', { name: '下移第 1 页' })
    pointerEvent(downButton, 'pointerdown', 20, 20)
    pointerEvent(cards[0], 'pointermove', 20, 100)
    pointerEvent(cards[0], 'pointerup', 20, 100)
    expect(enabled.reorder).not.toHaveBeenCalled()
    expect(captures[0].capture).not.toHaveBeenCalled()
    fireEvent.click(downButton)
    expect(enabled.reorder).toHaveBeenCalledExactlyOnceWith(31, 11)
  })

  it('drag-sorts pages and keeps selection by page identity while renumbering thumbnails', () => {
    const { container, reorder } = thumbnailHarness()
    const cards = container.querySelectorAll('.page-sort-item')
    const transfer = dataTransfer()
    fireEvent.dragStart(cards[0], { dataTransfer: transfer })
    fireEvent.dragOver(cards[2], { dataTransfer: transfer })
    expect(cards[2].className).toContain('is-drag-over')
    fireEvent.drop(cards[2], { dataTransfer: transfer })
    expect(reorder).toHaveBeenCalledWith(31, 21)
    expect(screen.getByTestId('order').textContent).toBe('11,21,31')
    expect(screen.getByTestId('active').textContent).toBe('11')
    expect(container.querySelector('.page-card.selected')?.getAttribute('aria-label')).toBe('页面 1')
    expect(container.querySelector('.is-drag-over')).toBeNull()
  })

  it('supports up/down buttons and disables unavailable directions', () => {
    const { container } = thumbnailHarness()
    expect((screen.getByRole('button', { name: '上移第 1 页' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '下移第 3 页' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '上移第 2 页' }))
    expect(screen.getByTestId('order').textContent).toBe('11,31,21')
    fireEvent.click(screen.getByRole('button', { name: '下移第 1 页' }))
    expect(screen.getByTestId('order').textContent).toBe('31,11,21')
    fireEvent.click(screen.getByRole('button', { name: '页面 3' }))
    expect(screen.getByTestId('active').textContent).toBe('21')
    expect(container.querySelector('.page-card.selected')?.getAttribute('aria-label')).toBe('页面 3')
  })

  it('prevents sorting and switching pages while export disables editing', () => {
    const { container, reorder, select } = thumbnailHarness(true)
    expect(container.querySelector('.page-sort-item')?.getAttribute('draggable')).toBe('false')
    const transfer = dataTransfer()
    transfer.setData('application/x-printflow-page', '31')
    fireEvent.drop(container.querySelectorAll('.page-sort-item')[2], { dataTransfer: transfer })
    fireEvent.click(screen.getByRole('button', { name: '页面 1' }))
    fireEvent.click(screen.getByRole('button', { name: '上移第 2 页' }))
    expect(reorder).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })
})

it('PDF export follows reordered pages and uses consecutive page numbers while retaining their own annotations', async () => {
  const pages = [9, 4, 7].map(id => ({ ...page(id), annotations: [{ id: `text-${id}`, kind: 'text' as const, x: 20, y: 20, text: `content-${id}`, color: '#000', fontSize: 12 }] }))
  await exportPdf(pages, [asset], 'ordered.pdf')
  const staged = native.invoke.mock.calls.filter(([command]) => command === 'stage_pdf_page')
  expect(staged).toHaveLength(3)
  expect(staged.map(([, value]) => parseSvg(value.svg).querySelector('[data-canvas-annotations] text')?.textContent)).toEqual(['content-9', 'content-4', 'content-7'])
  expect(staged.map(([, value]) => [...parseSvg(value.svg).querySelectorAll('text')].map(node => node.textContent).find(text => /^\d+ of \d+$/.test(text ?? '')))).toEqual(['1 of 3', '2 of 3', '3 of 3'])
  expect(pages.map(current => current.id)).toEqual([9, 4, 7])
})
