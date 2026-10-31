import React, { useState } from 'react'
import Konva from 'konva'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { defaultLayoutBounds, pageRasterSvg, type Asset, type Item, type Page } from '../src/model'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'
import ArrangePage from '../src/modules/schematic/ArrangePage'
import ArtworkContextMenu from '../src/modules/schematic/components/ArtworkContextMenu'
import { selectSvgLayer, selectSvgLayers, svgLayers } from '../src/modules/schematic/services/svgLayerService'

vi.mock('../src/modules/schematic/components/ProductAttributesPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/AssetPool', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/PageThumbnail', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/PageConfigPanel', () => ({ default: () => null }))

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g id="front-layer"><rect width="80" height="80" fill="red"/></g><g id="back-layer" style="display:none"><circle cx="50" cy="50" r="40" fill="blue"/></g></svg>'
const asset: Asset = { id: 'asset', name: 'test', productId: 'a', width: 100, height: 100, svg, previewUrl: '', thumbnailUrl: '' }
const front: Item = { id: 'front', assetId: asset.id, x: 120, y: 200, w: 80, h: 80, rotation: 0, caption: 'Front' }
const back: Item = { ...front, id: 'back', x: 250, derivedFrom: 'front', caption: 'Back', mirrorX: true }
const noop = () => {}
const previewBlobs = new Map<string, Blob>()
const createObjectURL = vi.fn((blob: Blob) => {
  const url = `blob:test-${previewBlobs.size}`
  previewBlobs.set(url, blob)
  return url
})
const revokeObjectURL = vi.fn()

beforeEach(() => {
  previewBlobs.clear()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  Konva.autoDrawEnabled = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    measureText: (text: string) => ({ width: text.length * 4 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => {} }) as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe() { this.callback([{ contentRect: { width: 1000, height: 900 } }] as ResizeObserverEntry[], this as unknown as ResizeObserver) } disconnect() {} })
  vi.stubGlobal('Image', class { onload?: () => void; onerror?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()) } })
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL })
  const computed = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computed(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Konva.autoDrawEnabled = true })

function mount(onReplace = vi.fn().mockResolvedValue(undefined), replacingArtwork = false, items: Item[] = [front, back], singleDelete = false) {
  const current: { page?: Page } = {}
  const onDelete = vi.fn()
  const onDeleteItems = vi.fn()
  function Harness() {
    const [page, setPage] = useState<Page>({ id: 1, name: 'test', items, imageGroups: [{ id: 'group', itemIds: ['front', 'back'], x: 20, y: 150, width: 300, height: 150 }] })
    const [selected, setSelected] = useState<string | null>('front')
    const [display, setDisplay] = useState(emptyArrangementDisplayState)
    current.page = page
    return <ArrangePage displayState={display} onDisplayStateChange={setDisplay} context={null} assets={[asset]} pages={[page]} activePage={1} selectedItem={selected} selectedGroupIds={[]} sortMode="default"
      onSelectPage={noop} onSelectItem={setSelected} onChangeItem={item => setPage(previous => ({ ...previous, items: previous.items.map(value => value.id === item.id ? item : value) }))}
      onReplaceArtwork={onReplace} replacingArtwork={replacingArtwork} onDropAsset={noop} onDeleteGroups={onDelete} onDeleteItems={singleDelete ? onDeleteItems : undefined} onConfirmAssetAttributes={async () => {}} onAddPage={noop} onAutoArrange={noop} onCombine={noop} onSelectGroup={noop}
      onBack={noop} onBackToHistory={noop} onExport={noop} onMetadataChange={noop} layoutBounds={defaultLayoutBounds} onBoundsChange={noop} onAddHeaderBlock={noop} onChangeHeaderBlock={noop} onRemoveHeaderBlock={noop}/>
  }
  render(<Harness/> )
  return { page: () => current.page!, onReplace, onDelete, onDeleteItems }
}

async function rightClick(id: string) {
  await waitFor(() => expect(Konva.stages.at(-1)?.findOne(`#${id}`)).toBeTruthy())
  const evt = new MouseEvent('contextmenu', { clientX: 240, clientY: 220, button: 2, cancelable: true })
  act(() => { Konva.stages.at(-1)!.findOne(`#${id}`)!.fire('contextmenu', { evt }, true) })
  expect(evt.defaultPrevented).toBe(true)
  return screen.findByRole('menuitem', { name: /^切换图层/ })
}

async function thumbnailSvg(option: HTMLElement) {
  const thumbnail = option.querySelector<HTMLImageElement>('img.artwork-layer-thumbnail')!
  await waitFor(() => expect(thumbnail.getAttribute('src')).toMatch(/^blob:test-/))
  const blob = previewBlobs.get(thumbnail.getAttribute('src')!)!
  expect(blob.type).toBe('image/svg+xml')
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsText(blob)
  })
}

async function confirmLayers() {
  fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
}

test.each(['front', 'back'])('right-click %s switches only that instance and keeps all original layer choices and export content', async id => {
  const current = mount()
  fireEvent.click(await rightClick(id))
  const backOption = await screen.findByRole('menuitem', { name: 'back-layer' })
  const previewSvg = await thumbnailSvg(backOption)
  expect(previewSvg).toContain('id="back-layer"')
  expect(previewSvg).toContain('display:inline!important;visibility:visible!important')
  expect(previewSvg).not.toContain('id="front-layer"')
  fireEvent.click(backOption.querySelector('img')!)
  expect(current.page().items).toEqual([front, back])
  expect(screen.getByRole('menuitem', { name: 'back-layer' })).toBeTruthy()
  await confirmLayers()
  await waitFor(() => expect(current.page().items.find(item => item.id === id)?.svgLayerId).toBeTruthy())
  const changed = current.page().items.find(item => item.id === id)!
  expect(changed.svgLayerIds).toEqual([changed.svgLayerId])
  expect(changed.backSvg).toBe(previewSvg)
  expect(changed.backSvg).toContain('id="back-layer"')
  expect(changed.backSvg).not.toContain('id="front-layer"')
  expect(changed).toMatchObject(id === 'back' ? back : front)
  expect(current.page().items.find(item => item.id !== id)?.backSvg).toBeUndefined()
  const exported: string[] = []
  pageRasterSvg(current.page(), new Map([[asset.id, asset]]), {}, 1, undefined, source => { exported.push(source); return 'staged.svg' })
  expect(exported).toContain(changed.backSvg)
  // Reopening enumerates the source, not the filtered image.
  fireEvent.click(await rightClick(id))
  const selectedOption = await screen.findByRole('menuitem', { name: 'back-layer' })
  expect(selectedOption.classList.contains('ant-dropdown-menu-item-selected')).toBe(true)
  expect(selectedOption.querySelector('.artwork-layer-selected')).toBeTruthy()
  fireEvent.click(await screen.findByRole('menuitem', { name: 'front-layer' }))
  fireEvent.click(selectedOption)
  expect(current.page().items.find(item => item.id === id)?.backSvg).toBe(previewSvg)
  await confirmLayers()
  expect(current.page().items.find(item => item.id === id)?.backSvg).toContain('id="front-layer"')
  expect(current.page().items.find(item => item.id === id)?.backSvg).not.toContain('id="back-layer"')
})

test('all layers and individual layers each show their own thumbnail, and closing the menu releases every preview', async () => {
  const current = mount()
  fireEvent.click(await rightClick('front'))
  const allOption = await screen.findByRole('menuitem', { name: '全部图层' })
  expect(allOption.classList.contains('ant-dropdown-menu-item-selected')).toBe(true)
  expect(await thumbnailSvg(allOption)).toBe(svg)
  const sourceLayers = svgLayers(svg)
  for (const layer of sourceLayers) {
    const option = await screen.findByRole('menuitem', { name: layer.label })
    expect(await thumbnailSvg(option)).toBe(selectSvgLayer(svg, layer.id))
    const thumbnail = option.querySelector<HTMLImageElement>('img')!
    expect(thumbnail.alt).toBe('')
    expect(thumbnail.draggable).toBe(false)
  }
  const urls = Array.from(document.querySelectorAll<HTMLImageElement>('img.artwork-layer-thumbnail'), image => image.getAttribute('src')!)
  expect(urls).toHaveLength(sourceLayers.length + 1)
  expect(new Set(urls).size).toBe(urls.length)
  fireEvent.click(await screen.findByRole('menuitem', { name: 'back-layer' }))
  expect(allOption.classList.contains('ant-dropdown-menu-item-selected')).toBe(false)
  fireEvent.click(allOption.querySelector('img')!)
  expect(screen.getByRole('menuitem', { name: 'back-layer' }).classList.contains('ant-dropdown-menu-item-selected')).toBe(false)
  expect(current.page().items).toEqual([front, back])
  await confirmLayers()
  await waitFor(() => expect(document.querySelector('img.artwork-layer-thumbnail')).toBeNull())
  for (const url of urls) expect(revokeObjectURL).toHaveBeenCalledWith(url)
  expect(current.page().items.find(item => item.id === 'front')).toMatchObject({ svgLayerId: 'all', backSvg: svg })
  expect(current.page().items.find(item => item.id === 'front')?.svgLayerIds).toBeUndefined()
  expect(current.page().items.find(item => item.id === 'back')).toEqual(back)
})

test.each(['front', 'back'])('multiple layers stay open until confirmation and restore their selection for only the %s instance', async id => {
  const current = mount()
  const layerIds = svgLayers(svg).map(layer => layer.id)
  fireEvent.click(await rightClick(id))
  for (const name of ['front-layer', 'back-layer']) {
    const option = await screen.findByRole('menuitem', { name })
    fireEvent.click(option.querySelector('img')!)
    expect(option.classList.contains('ant-dropdown-menu-item-selected')).toBe(true)
    expect(current.page().items).toEqual([front, back])
  }
  expect(screen.getByRole('menuitem', { name: '全部图层' }).classList.contains('ant-dropdown-menu-item-selected')).toBe(false)
  await confirmLayers()
  const changed = current.page().items.find(item => item.id === id)!
  expect(changed.svgLayerIds).toEqual(layerIds)
  expect(changed.svgLayerId).toBeUndefined()
  expect(changed.backSvg).toBe(selectSvgLayers(svg, layerIds))
  expect(changed.backSvg).toContain('id="front-layer"')
  expect(changed.backSvg).toContain('id="back-layer"')
  const selectedBack = new DOMParser().parseFromString(changed.backSvg!, 'image/svg+xml').getElementById('back-layer')!
  expect(selectedBack.getAttribute('style')).toContain('display:inline!important;visibility:visible!important')
  expect(current.page().items.find(item => item.id !== id)).toEqual(id === 'front' ? back : front)
  const exported: string[] = []
  pageRasterSvg(current.page(), new Map([[asset.id, asset]]), {}, 1, undefined, source => { exported.push(source); return 'staged.svg' })
  expect(exported).toContain(changed.backSvg)
  fireEvent.click(await rightClick(id))
  for (const name of ['front-layer', 'back-layer']) {
    const option = await screen.findByRole('menuitem', { name })
    expect(option.classList.contains('ant-dropdown-menu-item-selected')).toBe(true)
    expect(option.querySelector('.artwork-layer-selected')).toBeTruthy()
  }
  fireEvent.click(await screen.findByRole('menuitem', { name: '全部图层' }))
  await confirmLayers()
  expect(current.page().items.find(item => item.id === id)).toMatchObject({ svgLayerId: 'all', backSvg: svg })
  expect(current.page().items.find(item => item.id === id)?.svgLayerIds).toBeUndefined()
})

test('legacy single layer choices are restored and converted to a multi-layer selection after confirmation', async () => {
  const [frontLayer, backLayer] = svgLayers(svg)
  const legacy: Item = { ...back, svgLayerId: backLayer.id, backSvg: selectSvgLayer(svg, backLayer.id) }
  const current = mount(undefined, false, [front, legacy])
  fireEvent.click(await rightClick('back'))
  const oldOption = await screen.findByRole('menuitem', { name: 'back-layer' })
  expect(oldOption.classList.contains('ant-dropdown-menu-item-selected')).toBe(true)
  fireEvent.click(await screen.findByRole('menuitem', { name: 'front-layer' }))
  expect(current.page().items[1]).toEqual(legacy)
  await confirmLayers()
  expect(new Set(current.page().items[1].svgLayerIds)).toEqual(new Set([frontLayer.id, backLayer.id]))
  expect(current.page().items[1].svgLayerId).toBeUndefined()
})

test('closing outside the layer menu discards draft changes and reopening restores the saved selection', async () => {
  const [frontLayer] = svgLayers(svg)
  const saved: Item = { ...front, svgLayerIds: [frontLayer.id], svgLayerId: frontLayer.id, backSvg: selectSvgLayer(svg, frontLayer.id) }
  const current = mount(undefined, false, [saved, back])
  fireEvent.click(await rightClick('front'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'back-layer' }))
  expect(current.page().items).toEqual([saved, back])
  fireEvent.mouseDown(document.body)
  fireEvent.click(document.body)
  await waitFor(() => expect(screen.queryByRole('menuitem', { name: /^切换图层/ })).toBeNull())
  expect(current.page().items).toEqual([saved, back])
  fireEvent.click(await rightClick('front'))
  expect((await screen.findByRole('menuitem', { name: 'front-layer' })).classList.contains('ant-dropdown-menu-item-selected')).toBe(true)
  expect((await screen.findByRole('menuitem', { name: 'back-layer' })).classList.contains('ant-dropdown-menu-item-selected')).toBe(false)
})

test('deselecting every layer disables confirmation without changing artwork or allowing keyboard deletion', async () => {
  const current = mount()
  fireEvent.click(await rightClick('front'))
  const option = await screen.findByRole('menuitem', { name: 'front-layer' })
  fireEvent.click(option)
  fireEvent.click(option)
  expect(document.querySelector('.artwork-layer-selected')).toBeNull()
  const confirm = screen.getByRole('button', { name: '确认', exact: true }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.click(confirm)
  fireEvent.keyDown(window, { key: 'Delete' })
  expect(current.page().items).toEqual([front, back])
  expect(current.onDelete).not.toHaveBeenCalled()
  expect(screen.getByRole('menuitem', { name: 'front-layer' })).toBeTruthy()
})

test('thumbnail URLs are replaced when the original SVG changes and released on unmount', async () => {
  const props = { target: { itemId: front.id, x: 240, y: 220 }, item: front, asset, onClose: noop, onChange: noop }
  const view = render(<ArtworkContextMenu {...props}/>)
  fireEvent.click(await screen.findByRole('menuitem', { name: /^切换图层/ }))
  const option = await screen.findByRole('menuitem', { name: 'front-layer' })
  expect(await thumbnailSvg(option)).toContain('fill="red"')
  const oldUrls = Array.from(document.querySelectorAll<HTMLImageElement>('img.artwork-layer-thumbnail'), image => image.getAttribute('src')!)
  const updatedSvg = svg.replace('fill="red"', 'fill="green"')
  view.rerender(<ArtworkContextMenu {...props} asset={{ ...asset, svg: updatedSvg }}/>)
  await waitFor(() => { for (const url of oldUrls) expect(revokeObjectURL).toHaveBeenCalledWith(url) })
  expect(await thumbnailSvg(await screen.findByRole('menuitem', { name: 'front-layer' }))).toContain('fill="green"')
  const newUrls = Array.from(document.querySelectorAll<HTMLImageElement>('img.artwork-layer-thumbnail'), image => image.getAttribute('src')!)
  expect(newUrls.every(url => !oldUrls.includes(url))).toBe(true)
  view.unmount()
  for (const url of newUrls) expect(revokeObjectURL).toHaveBeenCalledWith(url)
})

test('only visible layer previews are generated and an existing derived image is not falsely selected as all layers', async () => {
  const observers: Array<{ callback: IntersectionObserverCallback; target?: Element; disconnect: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal('IntersectionObserver', class {
    record: typeof observers[number]
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback, disconnect: vi.fn() }
      observers.push(this.record)
    }
    observe(target: Element) { this.record.target = target }
    disconnect() { this.record.disconnect() }
  })
  const view = render(<ArtworkContextMenu target={{ itemId: back.id, x: 240, y: 220 }} item={{ ...back, backSvg: svg }} asset={asset} onClose={noop} onChange={noop}/>)
  fireEvent.click(await screen.findByRole('menuitem', { name: /^切换图层/ }))
  const backOption = await screen.findByRole('menuitem', { name: 'back-layer' })
  expect(document.querySelector('.ant-dropdown-menu-item-selected')).toBeNull()
  expect(document.querySelector('.artwork-layer-selected')).toBeNull()
  expect((screen.getByRole('button', { name: '确认', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  expect(createObjectURL).not.toHaveBeenCalled()
  const image = backOption.querySelector('img')!
  const observer = observers.find(value => value.target === image)!
  expect(observer).toBeTruthy()
  act(() => observer.callback([{ target: image, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(await thumbnailSvg(backOption)).toContain('id="back-layer"')
  expect(createObjectURL).toHaveBeenCalledTimes(1)
  expect(observer.disconnect).toHaveBeenCalled()
  view.unmount()
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(image.getAttribute('src'))
  for (const record of observers) expect(record.disconnect).toHaveBeenCalled()
})

test('right-click replacement passes the single Back instance to the existing import flow', async () => {
  const current = mount()
  await rightClick('back')
  fireEvent.click(await screen.findByRole('menuitem', { name: '更换图片' }))
  expect(current.onReplace).toHaveBeenCalledExactlyOnceWith('back')
  expect(current.page().items).toEqual([front, back])
})

test('switching a marked front layer keeps the color-window layer in the arrangement artwork', async () => {
  const windowSvg = '<svg xmlns="http://www.w3.org/2000/svg"><image id="back" href="back.png"/><image id="window" href="window.png"/><image id="front" href="front.png"/></svg>'
  const windowAsset: Asset = { ...asset, svg: windowSvg, sourceImages: [{ nodeId: 'back', widthPx: 10, heightPx: 10, format: 'PNG', layerRole: 'back' }, { nodeId: 'window', widthPx: 10, heightPx: 10, format: 'PNG', layerRole: 'window' }, { nodeId: 'front', widthPx: 10, heightPx: 10, format: 'PNG', layerRole: 'front' }] }
  const onChange = vi.fn()
  render(<ArtworkContextMenu target={{ itemId: 'front', x: 240, y: 220 }} item={front} asset={windowAsset} onClose={noop} onChange={onChange}/>)
  fireEvent.click(await screen.findByRole('menuitem', { name: /^切换图层/ }))
  expect(await screen.findByRole('menuitem', { name: 'back（背面）' })).toBeTruthy()
  expect(await screen.findByRole('menuitem', { name: 'window（彩窗）' })).toBeTruthy()
  fireEvent.click(await screen.findByRole('menuitem', { name: 'front（正面）' }))
  await confirmLayers()
  const changed = onChange.mock.calls[0][0] as Item
  expect(changed.backSvg).toContain('id="window"')
  expect(changed.backSvg).toContain('id="front"')
  expect(changed.backSvg).not.toContain('id="back"')
  expect(changed.svgLayerIds).toEqual(['svg-layer-1', 'svg-layer-2'])
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

test('keyboard deletion removes only the selected image when single-item deletion is enabled', () => {
  const current = mount(vi.fn().mockResolvedValue(undefined), false, [front, back], true)
  fireEvent.keyDown(window, { key: 'Delete' })
  expect(current.onDeleteItems).toHaveBeenCalledExactlyOnceWith(['front'])
  expect(current.onDelete).not.toHaveBeenCalled()
})
