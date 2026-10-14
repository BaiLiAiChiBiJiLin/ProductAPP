import React, { useState } from 'react'
import Konva from 'konva'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { defaultLayoutBounds, pageRasterSvg, type Asset, type Item, type Page } from '../src/model'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'
import ArrangePage from '../src/modules/schematic/ArrangePage'

vi.mock('../src/modules/schematic/components/ProductAttributesPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/AssetPool', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/PageThumbnail', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/PageConfigPanel', () => ({ default: () => null }))

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g id="front-layer"><rect width="80" height="80" fill="red"/></g><g id="back-layer" style="display:none"><circle cx="50" cy="50" r="40" fill="blue"/></g></svg>'
const asset: Asset = { id: 'asset', name: 'test', productId: 'a', width: 100, height: 100, svg, previewUrl: '', thumbnailUrl: '' }
const front: Item = { id: 'front', assetId: asset.id, x: 120, y: 200, w: 80, h: 80, rotation: 0, caption: 'Front' }
const back: Item = { ...front, id: 'back', x: 250, derivedFrom: 'front', caption: 'Back', mirrorX: true }
const noop = () => {}

beforeEach(() => {
  Konva.autoDrawEnabled = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: (text: string) => ({ width: text.length * 4 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => {} }) as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe() { this.callback([{ contentRect: { width: 1000, height: 900 } }] as ResizeObserverEntry[], this as unknown as ResizeObserver) } disconnect() {} })
  vi.stubGlobal('Image', class { onload?: () => void; onerror?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()) } })
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:test' } })
  const computed = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Konva.autoDrawEnabled = true })

function mount(onReplace = vi.fn().mockResolvedValue(undefined), replacingArtwork = false) {
  const current: { page?: Page } = {}
  const onDelete = vi.fn()
  function Harness() {
    const [page, setPage] = useState<Page>({ id: 1, name: 'test', items: [front, back], imageGroups: [{ id: 'group', itemIds: ['front', 'back'], x: 20, y: 150, width: 300, height: 150 }] })
    const [selected, setSelected] = useState<string | null>('front')
    const [display, setDisplay] = useState(emptyArrangementDisplayState)
    current.page = page
    return <ArrangePage displayState={display} onDisplayStateChange={setDisplay} context={null} assets={[asset]} pages={[page]} activePage={1} selectedItem={selected} selectedGroupIds={[]} sortMode="default"
      onSelectPage={noop} onSelectItem={setSelected} onChangeItem={item => setPage(previous => ({ ...previous, items: previous.items.map(value => value.id === item.id ? item : value) }))}
      onReplaceArtwork={onReplace} replacingArtwork={replacingArtwork} onDropAsset={noop} onDeleteGroups={onDelete} onConfirmAssetAttributes={async () => {}} onAddPage={noop} onAutoArrange={noop} onCombine={noop} onSelectGroup={noop}
      onBack={noop} onBackToHistory={noop} onExport={noop} onMetadataChange={noop} layoutBounds={defaultLayoutBounds} onBoundsChange={noop} onAddHeaderBlock={noop} onChangeHeaderBlock={noop} onRemoveHeaderBlock={noop}/>
  }
  render(<Harness/> )
  return { page: () => current.page!, onReplace, onDelete }
}

async function rightClick(id: string) {
  await waitFor(() => expect(Konva.stages.at(-1)?.findOne(`#${id}`)).toBeTruthy())
  const evt = new MouseEvent('contextmenu', { clientX: 240, clientY: 220, button: 2, cancelable: true })
  act(() => { Konva.stages.at(-1)!.findOne(`#${id}`)!.fire('contextmenu', { evt }, true) })
  expect(evt.defaultPrevented).toBe(true)
  return screen.findByRole('menuitem', { name: /^切换图层/ })
}

test.each(['front', 'back'])('right-click %s switches only that instance and keeps all original layer choices and export content', async id => {
  const current = mount()
  fireEvent.click(await rightClick(id))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'back-layer' }))
  await waitFor(() => expect(current.page().items.find(item => item.id === id)?.svgLayerId).toBeTruthy())
  const changed = current.page().items.find(item => item.id === id)!
  expect(changed.backSvg).toContain('id="back-layer"')
  expect(changed.backSvg).not.toContain('id="front-layer"')
  expect(changed).toMatchObject(id === 'back' ? back : front)
  expect(current.page().items.find(item => item.id !== id)?.backSvg).toBeUndefined()
  const exported: string[] = []
  pageRasterSvg(current.page(), new Map([[asset.id, asset]]), {}, 1, undefined, source => { exported.push(source); return 'staged.svg' })
  expect(exported).toContain(changed.backSvg)
  // Reopening enumerates the source, not the filtered image.
  fireEvent.click(await rightClick(id))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'front-layer' }))
  expect(current.page().items.find(item => item.id === id)?.backSvg).toContain('id="front-layer"')
})

test('right-click replacement passes the single Back instance to the existing import flow', async () => {
  const current = mount()
  await rightClick('back')
  fireEvent.click(await screen.findByRole('menuitem', { name: '更换图片' }))
  expect(current.onReplace).toHaveBeenCalledExactlyOnceWith('back')
  expect(current.page().items).toEqual([front, back])
})

test('replacement blocks keyboard deletion and makes the editing panels inert', () => {
  const current = mount(vi.fn(), true)
  expect(screen.getByText('正在更换图片')).toBeTruthy()
  expect(document.querySelector('.canvas-area')?.hasAttribute('inert')).toBe(true)
  fireEvent.keyDown(window, { key: 'Delete' })
  expect(current.onDelete).not.toHaveBeenCalled()
})

test('keyboard deletion still works when no replacement or menu is open', () => {
  const current = mount()
  fireEvent.keyDown(window, { key: 'Delete' })
  expect(current.onDelete).toHaveBeenCalledExactlyOnceWith(['group'])
})
