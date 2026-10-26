import { createRef, useState, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ConfigProvider } from 'antd'
import Konva from 'konva'
import { Layer, Stage } from 'react-konva'
import { defaultLayoutBounds, pageSvg, pageRasterSvg, type Asset, type Page } from '../src/model'
import type ArtworkCanvas from '../src/modules/schematic/ArtworkCanvas'
import ImageGroupDetails from '../src/modules/schematic/components/ImageGroupDetails'
import { detailTextSelection, updateDetailText } from '../src/modules/schematic/services/detailTextService'
import { deleteEditorSelection } from '../src/modules/schematic/services/canvasAnnotationService'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService'
import { detailPanelsForGroup } from '../src/modules/schematic/arrangement/productGroupDetails'
import { emptyArrangementDisplayState } from '../src/modules/schematic/services/arrangementDisplayState'
import { autoArrangePages, paginateAssets } from '../src/modules/schematic/services/paginationService'
import { combineImageGroups } from '../src/modules/schematic/services/groupCombinationService'
import { createReviewRecord } from '../src/modules/schematic-review/reviewRecords'
import { defaultBatchMetadata } from '../src/modules/schematic/types'

const mocks = vi.hoisted(() => ({ canvas: vi.fn(), deleteGroups: vi.fn() }))
vi.mock('../src/modules/schematic/ArtworkCanvas', () => ({ default: (props: ComponentProps<typeof ArtworkCanvas>) => { mocks.canvas(props); return <div data-testid="canvas"/> } }))
vi.mock('../src/modules/schematic/components/PageThumbnailList', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/PageConfigPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/AssetPool', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/ProductAttributesPanel', () => ({ default: () => null }))
vi.mock('../src/services/backend', () => ({ invoke: vi.fn(), storageMode: async () => ({ shared: false }) }))
import ArrangePage from '../src/modules/schematic/ArrangePage'

const asset: Asset = { id: 'a', name: 'A', productId: 'keychain', width: 30, height: 60, sourceGroupWidthMm: 30, sourceGroupHeightMm: 60,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 60"><rect width="30" height="60"/></svg>', previewUrl: '', thumbnailUrl: '' }
const assets = new Map([[asset.id, asset]])
function fixture(): Page {
  return { id: 1, name: 'Page', items: [{ id: 'a', assetId: 'a', x: 70, y: 200, w: 30, h: 60, rotation: 0, rulerWidth: false, rulerHeight: true }],
    imageGroups: [{ id: 'g', itemIds: ['a'], x: 20, y: 120, width: 350, height: 250, detailWidth: 180, details: { size: '60.0 mm', qt: '2', finish: '' } }] }
}
const canvas = () => mocks.canvas.mock.calls.at(-1)![0] as ComponentProps<typeof ArtworkCanvas>
const noop = () => {}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })))
  Konva.autoDrawEnabled = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({ measureText: (text: string) => ({ width: text.length * 4 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }) }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => {} }) as unknown as CanvasRenderingContext2D)
  const getStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Konva.autoDrawEnabled = true })

function mount() {
  function Harness() {
    const [page, setPage] = useState(fixture)
    const [display, setDisplay] = useState(emptyArrangementDisplayState)
    return <ArrangePage displayState={display} onDisplayStateChange={setDisplay} context={null} assets={[asset]} pages={[page]} activePage={1}
      selectedItem={null} selectedGroupIds={[]} sortMode="default" onSelectPage={noop} onSelectItem={noop} onSelectGroup={noop} onChangeItem={noop}
      onChangePage={setPage} onDropAsset={noop} onDeleteGroups={mocks.deleteGroups} onConfirmAssetAttributes={async () => {}} onAddPage={noop}
      onAutoArrange={noop} onCombine={noop} onBack={noop} onBackToHistory={noop} onExport={noop} onMetadataChange={noop} layoutBounds={defaultLayoutBounds}
      onBoundsChange={noop} onAddHeaderBlock={noop} onChangeHeaderBlock={noop} onRemoveHeaderBlock={noop}/>
  }
  return render(<ConfigProvider theme={{ token: { motion: false } }}><Harness/></ConfigProvider>)
}

test('Size and QT canvas text both select on click and open the shared editor on double click', () => {
  const stage = createRef<Konva.Stage>(), select = vi.fn(), edit = vi.fn(), page = fixture()
  render(<Stage ref={stage} width={500} height={500}><Layer><ImageGroupDetails group={page.imageGroups![0]} page={page} assets={assets} onSelectEditor={select} onEditDetailText={edit}/></Layer></Stage>)
  const fields = stage.current!.find<Konva.Text>('.image-detail-text')
  expect(fields.map(field => field.text())).toEqual(['Size: 60.0 mm', 'QT: 2'])
  for (const [index, node] of fields.entries()) {
    act(() => node.fire('click', { evt: new MouseEvent('click') }, true))
    expect(select.mock.calls.at(-1)![0]).toMatchObject({ kind: 'detail', groupId: 'g', panelItemIds: ['a'], fieldKey: index ? 'qt' : 'size' })
    act(() => node.fire('dblclick', { evt: new MouseEvent('dblclick') }, true))
    expect(edit.mock.calls.at(-1)![0]).toMatchObject({ kind: 'detail', text: node.text(), fontSize: node.fontSize(), color: '#000' })
  }
})

test.each(['size', 'qt'])('Delete hides only selected %s text, leaving the image, physical value and ruler intact', fieldKey => {
  mount()
  act(() => canvas().onSelectEditor?.(detailTextSelection('g', ['a'], fieldKey)))
  fireEvent.keyDown(window, { key: 'Delete' })
  const page = canvas().page
  expect(page.items).toEqual(fixture().items)
  expect(page.imageGroups![0].details).toMatchObject({ size: '60.0 mm', qt: '2', textOverrides: { [fieldKey]: { hidden: true } } })
  expect(imageDetailsLayout(page.imageGroups![0]).fields.map(field => field.editKey)).toEqual([fieldKey === 'size' ? 'qt' : 'size'])
  expect(mocks.deleteGroups).not.toHaveBeenCalled()
  const svg = new DOMParser().parseFromString(pageSvg(page, assets), 'image/svg+xml')
  expect(svg.querySelector('[data-item-id="a"] text')?.textContent).toContain('60.0 mm')
  expect(svg.querySelector('[data-image-group-backgrounds]')?.textContent).not.toContain(fieldKey === 'size' ? 'Size:' : 'QT:')
})

test('details use the existing text modal, save custom text/font/color and do not create a free annotation', async () => {
  mount()
  const selection = detailTextSelection('g', ['a'], 'size')
  act(() => canvas().onEditDetailText?.({ ...selection, text: 'Size: 60.0 mm', fontSize: 16, color: '#e11d48' }))
  expect(await screen.findByRole('dialog', { name: '编辑文字' })).toBeTruthy()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  fireEvent.change(screen.getByLabelText('画布文字'), { target: { value: 'Custom size\nSee artwork' } })
  fireEvent.change(screen.getByRole('spinbutton', { name: '文字字号' }), { target: { value: '12' } })
  fireEvent.keyDown(screen.getByLabelText('画布文字'), { key: 'Delete' })
  expect(canvas().page.imageGroups![0].details?.textOverrides).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: /^确\s*认$/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const page = canvas().page
  expect(page.annotations).toBeUndefined()
  expect(page.imageGroups![0].details?.size).toBe('60.0 mm')
  expect(page.imageGroups![0].details?.textOverrides?.size).toEqual({ text: 'Custom size\nSee artwork', fontSize: 12, color: '#e11d48', hidden: false })
  expect(canvas().editorSelection).toMatchObject(selection)
  for (const svgText of [pageSvg(page, assets), pageRasterSvg(page, assets)]) {
    const svg = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    const field = [...svg.querySelectorAll('[data-image-group-backgrounds] text')].find(node => node.textContent === 'Custom sizeSee artwork')!
    expect(field.getAttribute('fill')).toBe('#e11d48')
    expect(Number(field.getAttribute('font-size'))).toBe(12)
    expect(field.querySelectorAll('tspan')).toHaveLength(2)
  }
})

test('combined panels and per-image Size lines keep independent stable editing identities', () => {
  const page = fixture()
  page.items.push({ ...page.items[0], id: 'b', x: 150 })
  const group = page.imageGroups![0]
  group.itemIds = ['a', 'b']
  group.detailGroups = [
    { itemIds: ['a'], details: { size: '60.0 mm', qt: '2', finish: '' } },
    { itemIds: ['b'], details: { size: '40.0 mm', qt: '8', finish: '', sizes: [{ itemId: 'b', label: '40.0 mm' }] } },
  ]
  const updated = updateDetailText(page, detailTextSelection('g', ['a'], 'qt'), { text: 'QT: custom', fontSize: 10, color: '#126abc' })
  const hidden = deleteEditorSelection(updated, detailTextSelection('g', ['b'], 'size:b'))
  const panels = detailPanelsForGroup(hidden.imageGroups![0]).map(panel => imageDetailsLayout(panel).fields)
  expect(panels[0].map(field => field.text)).toEqual(['Size: 60.0 mm', 'QT: custom'])
  expect(panels[1].map(field => field.text)).toEqual(['QT: 8'])
  expect(hidden.imageGroups![0].detailGroups![1].details.sizes).toEqual([{ itemId: 'b', label: '40.0 mm' }])
})

test('text overrides survive automatic rearrangement, combination and review snapshots', () => {
  const sources = [asset, { ...asset, id: 'b' }]
  let pages = paginateAssets(sources)
  const first = pages[0].imageGroups![0]
  pages[0] = updateDetailText(pages[0], detailTextSelection(first.id, first.itemIds, 'qt'), { text: 'Custom QT', color: '#126abc', fontSize: 11 })
  pages[0] = deleteEditorSelection(pages[0], detailTextSelection(first.id, first.itemIds, 'size'))
  pages = autoArrangePages(pages, pages[0].id, sources, defaultLayoutBounds)
  expect(pages[0].imageGroups![0].details?.textOverrides).toEqual({ qt: { text: 'Custom QT', color: '#126abc', fontSize: 11 }, size: { hidden: true } })
  pages[0] = combineImageGroups(pages[0], pages[0].imageGroups!.map(group => group.id), sources)
  pages = autoArrangePages(pages, pages[0].id, sources, defaultLayoutBounds)
  expect(pages[0].imageGroups![0].detailGroups![0].details.textOverrides?.qt.text).toBe('Custom QT')
  const record = createReviewRecord({ assets: sources, pages, activePage: pages[0].id, metadata: defaultBatchMetadata, layoutBounds: defaultLayoutBounds,
    arrangementSort: 'default', defaultArrangementIds: sources.map(source => source.id) }, emptyArrangementDisplayState(), 'pdf', 'details.pdf')
  expect(JSON.parse(JSON.stringify(record)).pages[0].imageGroups[0].detailGroups[0].details.textOverrides.size.hidden).toBe(true)
})
