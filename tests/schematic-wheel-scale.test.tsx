import { useState, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultLayoutBounds, type Asset, type Page } from '../src/model'
import type ArtworkCanvas from '../src/modules/schematic/ArtworkCanvas'
import { emptyArrangementDisplayState, type ArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'

const mocks = vi.hoisted(() => ({ canvas: vi.fn() }))
vi.mock('../src/modules/schematic/ArtworkCanvas', () => ({ default: (props: ComponentProps<typeof ArtworkCanvas>) => {
  mocks.canvas(props)
  return <div className="stage-wrap" data-testid="canvas"><canvas data-testid="canvas-image"/></div>
} }))
vi.mock('../src/modules/schematic/components/CanvasTools', () => ({ default: ({ onTool }: { onTool: (tool: string) => void }) => <button onClick={() => onTool('ruler')}>绘制标尺</button> }))
vi.mock('../src/modules/schematic/components/PageThumbnailList', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/PageConfigPanel', () => ({ default: () => <input aria-label="其他输入"/> }))
vi.mock('../src/modules/schematic/components/AssetPool', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/ProductAttributesPanel', () => ({ default: () => null }))
import ArrangePage from '../src/modules/schematic/ArrangePage'

const asset: Asset = { id: 'source', name: 'Art', productId: 'a', width: 30, height: 60, svg: '<svg/>', previewUrl: '', thumbnailUrl: '' }
const page: Page = { id: 1, name: 'Page', items: [
  { id: 'front', assetId: asset.id, x: 100, y: 200, w: 30, h: 60, rotation: 0 },
  { id: 'back', assetId: asset.id, x: 150, y: 200, w: 30, h: 60, rotation: 0, derivedFrom: 'front' },
  { id: 'other', assetId: asset.id, x: 250, y: 200, w: 30, h: 60, rotation: 0 },
], imageGroups: [{ id: 'group', itemIds: ['front', 'back'], x: 50, y: 150, width: 150, height: 150 }] }
const canvas = () => mocks.canvas.mock.calls.at(-1)![0] as ComponentProps<typeof ArtworkCanvas>
const noop = () => {}

beforeEach(() => {
  mocks.canvas.mockClear()
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })))
  const computedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount(options: { selected?: string | null; exporting?: boolean; busy?: boolean; scale?: number } = {}) {
  let state = emptyArrangementDisplayState()
  const changeItem = vi.fn(), resizeGroup = vi.fn()
  function Harness() {
    const [display, setDisplay] = useState<ArrangementDisplayState>(() => ({ ...emptyArrangementDisplayState(),
      visualScales: new Map(options.scale ? [['front', options.scale]] : []), accessoryVisuals: new Map([['note', { scale: 1.3, x: 12, y: -8 }]]) }))
    const [selected, setSelected] = useState<string | null>(options.selected === undefined ? 'front' : options.selected)
    const [groups, setGroups] = useState<string[]>([])
    state = display
    return <ArrangePage displayState={display} onDisplayStateChange={setDisplay} context={null} assets={[asset]} pages={[page]} activePage={1}
      selectedItem={selected} selectedGroupIds={groups} sortMode="default" onSelectPage={noop} onSelectItem={id => { setSelected(id); setGroups([]) }}
      onSelectGroup={id => { setGroups([id]); setSelected(null) }} onChangeItem={changeItem} onDropAsset={noop} onDeleteGroups={noop}
      onConfirmAssetAttributes={async () => {}} onAddPage={noop} onAutoArrange={noop} onCombine={noop} onBack={noop} onBackToHistory={noop}
      onExport={noop} exporting={options.exporting} replacingArtwork={options.busy} onMetadataChange={noop} layoutBounds={defaultLayoutBounds}
      onBoundsChange={noop} onAddHeaderBlock={noop} onChangeHeaderBlock={noop} onRemoveHeaderBlock={noop} onResizeGroup={resizeGroup}/>
  }
  const view = render(<Harness/>)
  return { ...view, state: () => state, changeItem, resizeGroup }
}

function wheel(target: Element, init: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, altKey: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}

it('Alt-wheel changes only the selected image by 10 percent, synchronizes controls and leaves source geometry intact', () => {
  const current = mount()
  const zoom = current.state().zoom
  expect(wheel(screen.getByTestId('canvas-image')).defaultPrevented).toBe(true)
  expect(current.state().visualScales.get('front')).toBe(1.1)
  expect(current.state().visualScales.has('back')).toBe(false)
  expect(current.state().visualScales.has('other')).toBe(false)
  expect((screen.getByRole('spinbutton', { name: '图片显示百分比' }) as HTMLInputElement).value).toBe('110')
  expect(current.state().zoom).toBe(zoom)
  expect(canvas().page).toBe(page)
  expect(current.changeItem).not.toHaveBeenCalled()
  const controls = screen.getByLabelText('图片视觉缩放')
  expect(wheel(controls, { deltaY: 100 }).defaultPrevented).toBe(true)
  expect(current.state().visualScales.has('front')).toBe(false)
  expect((screen.getByRole('spinbutton', { name: '图片显示百分比' }) as HTMLInputElement).value).toBe('100')
})

it('updates group and box selections using the same visual selection as the percentage controls', () => {
  const current = mount()
  act(() => canvas().onSelectGroup?.('group', false))
  wheel(screen.getByTestId('canvas-image'))
  expect([...current.state().visualScales]).toEqual([['front', 1.1], ['back', 1.1]])
  act(() => canvas().onBoxSelect?.(['front', 'other']))
  wheel(screen.getByTestId('canvas-image'))
  expect([...current.state().visualScales]).toEqual([['front', 1.2], ['back', 1.2], ['other', 1.2]])
})

it('scales selected note/accessory pictures without losing their moved positions or changing main pictures', () => {
  const current = mount()
  act(() => canvas().onSelectAccessory?.('note'))
  wheel(screen.getByTestId('canvas-image'))
  expect(current.state().accessoryVisuals.get('note')).toEqual({ scale: 1.4, x: 12, y: -8 })
  expect(current.state().visualScales.size).toBe(0)
})

it('accumulates rapid wheel events and clamps at the existing 25–300 percent limits', () => {
  const current = mount({ scale: 2.8 })
  const target = screen.getByTestId('canvas-image')
  act(() => {
    for (let index = 0; index < 4; index++) target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -1, altKey: true }))
  })
  expect(current.state().visualScales.get('front')).toBe(3)
  act(() => {
    for (let index = 0; index < 30; index++) target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 1, altKey: true }))
  })
  expect(current.state().visualScales.get('front')).toBe(.25)
})

it('leaves ordinary scrolling, Ctrl-wheel canvas zoom, outside controls and text editing untouched', () => {
  const current = mount()
  const target = screen.getByTestId('canvas-image')
  for (const init of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { deltaY: 0, deltaX: 10 }]) {
    expect(wheel(target, init).defaultPrevented).toBe(false)
  }
  expect(wheel(screen.getByText('示意图打印预览')).defaultPrevented).toBe(false)
  const scaleInput = screen.getByRole('spinbutton', { name: '图片显示百分比' })
  expect(wheel(scaleInput).defaultPrevented).toBe(false)
  screen.getByRole('textbox', { name: '其他输入' }).focus()
  expect(wheel(target).defaultPrevented).toBe(false)
  expect(current.state().visualScales.size).toBe(0)
})

it.each([{ selected: null }, { exporting: true }, { busy: true }])('does not scale with no editable selection: %j', options => {
  const current = mount(options)
  expect(wheel(screen.getByTestId('canvas-image')).defaultPrevented).toBe(false)
  expect(current.state().visualScales.size).toBe(0)
  if (options.exporting || options.busy) expect(canvas().onResizeGroup).toBeUndefined()
})

it('disables the shortcut while another drawing tool or modal is active', () => {
  const current = mount()
  fireEvent.click(screen.getByRole('button', { name: '绘制标尺' }))
  expect(wheel(screen.getByTestId('canvas-image')).defaultPrevented).toBe(false)
  expect(current.state().visualScales.size).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: '选择', exact: true }))
  act(() => canvas().onPlaceText?.({ x: 20, y: 20 }))
  expect(wheel(screen.getByTestId('canvas-image')).defaultPrevented).toBe(false)
  expect(current.state().visualScales.size).toBe(0)
})
