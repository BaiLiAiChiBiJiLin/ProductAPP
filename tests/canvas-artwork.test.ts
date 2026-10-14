import { expect, test } from 'vitest'
import type { Asset, Item, Page } from '../src/model'
import { defaultLayoutBounds, pageRasterSvg, pageSvg } from '../src/model'
import { replaceCanvasItemArtwork } from '../src/modules/schematic/services/canvasArtworkService'
import { autoArrangePages, paginateAssets } from '../src/modules/schematic/services/paginationService'
import { groupForDimensionDisplay } from '../src/modules/schematic/services/dimensionDisplayService'
import type { DimensionDisplayOverride } from '../src/modules/schematic/services/imageDimensionService'

const asset = (id: string, fields: Partial<Asset> = {}): Asset => ({
  id, name: `${id}.svg`, productId: 'standee', width: 40, height: 80,
  svg: `<svg id="${id}"/>`, previewUrl: `${id}-preview`, thumbnailUrl: `${id}-thumbnail`,
  storagePath: `temp-assets/${id}.svg`, ...fields,
})
const item = (id: string, fields: Partial<Item> = {}): Item => ({
  id, assetId: 'old', x: 125, y: 180, w: 50, h: 100, rotation: 0, ...fields,
})

test('replacing Back keeps Front and shared source assets, groups and other pages untouched', () => {
  const source = asset('old', {
    productName: 'Clear Acrylic Standees', attributes: { QT: '2', Finish: 'Epoxy' },
    attributeImages: { Accessory: 'accessory.png' }, note: '保留备注', noteImage: 'note.png',
    noteImages: [{ src: 'note.png', name: '备注图' }], attributesConfirmed: true, finishMatchDisabled: true,
    productGroupId: 'product-group', productGroupLeaderId: 'old', productGroupMode: 'guided',
    productGroupColor: '#ABCDEF', productGroupPosition: 1,
    sourceGroupWidthMm: 40, sourceGroupHeightMm: 80,
  })
  const front = item('front', { caption: 'Front' })
  const back = item('back', {
    caption: 'Back', captionAlign: 'left', captionFontSize: 9, derivedFrom: front.id,
    backSvg: '<svg>old back layer</svg>', svgLayerId: 'old-layer', mirrorX: true, rotation: 25, note: '画布备注',
    rulerUnit: 'cm', rulerWidth: true, rulerHeight: true, sizeAxis: 'height',
    rulerWidthRange: [0.1, 0.9], rulerHeightRange: [0.2, 0.8], suppressRuler: false,
  })
  const page: Page = {
    id: 1, name: '页面 1', items: [front, back],
    imageGroups: [{ id: 'group', itemIds: [front.id, back.id], x: 10, y: 120, width: 300, height: 150 }],
    headerBlocks: [{ id: 'header', x: 10, y: 95, width: 300, columns: [{ id: 'column', imageMode: 'separate', detailLabel: 'Size/QT/Finish/Accessory' }], assetIds: [source.id] }],
  }
  const otherPage: Page = { id: 2, name: '页面 2', items: [item('copy')] }
  const replacement = asset('new', {
    width: 200, height: 100, sourceGroupWidthMm: 60, sourceGroupHeightMm: 30,
    sourceFileName: 'new.svg', sourceGroupId: 'artwork-layer', sourceGroupBounds: [0, 0, 200, 100],
    sourceImages: [{ nodeId: 'image', widthPx: 200, heightPx: 100, format: 'png' }],
    attributes: { QT: '99' }, note: '不采用新资源业务属性',
  })
  const output = replaceCanvasItemArtwork([source], [page, otherPage], back.id, replacement)

  expect(output.assets).toHaveLength(2)
  expect(output.assets[0]).toBe(source)
  expect(output.assets[1]).toEqual({
    ...source, ...replacement, productId: source.productId, productName: source.productName,
    attributes: source.attributes, note: source.note,
  })
  expect(output.pages[1]).toBe(otherPage)
  expect(output.pages[0].items[0]).toBe(front)
  expect(output.pages[0].items[1]).toEqual({ ...back, assetId: 'new', arrangementSourceAssetId: 'old', w: 50, h: 25, backSvg: undefined, svgLayerId: undefined })
  expect(output.pages[0].imageGroups).toBe(page.imageGroups)
  expect(output.pages[0].headerBlocks).toBe(page.headerBlocks)
  expect(page.items[1]).toBe(back)
  expect(back.backSvg).toBe('<svg>old back layer</svg>')
})

test('replacing Front affects only that item and contains a tall image in its original frame', () => {
  const source = asset('old')
  const front = item('front', { caption: 'Front', backSvg: '<svg>selected layer</svg>' })
  const back = item('back', { caption: 'Back', derivedFrom: 'front', backSvg: '<svg>back</svg>' })
  const page: Page = { id: 1, name: 'page', items: [front, back] }
  const output = replaceCanvasItemArtwork([source], [page], front.id, asset('new', { width: 10, height: 100 }))
  expect(output.pages[0].items[0]).toEqual({ ...front, assetId: 'new', arrangementSourceAssetId: 'old', w: 10, h: 100, backSvg: undefined, svgLayerId: undefined })
  expect(output.pages[0].items[1]).toBe(back)
  expect(output.assets[0]).toBe(source)
})

test('new artwork clears stale source measurement metadata while retaining business properties', () => {
  const source = asset('old', {
    sourceGroupWidthMm: 100, sourceGroupHeightMm: 200, sourceGroupBounds: [1, 2, 100, 200],
    sourceImages: [{ nodeId: 'old-layer', widthPx: 100, heightPx: 200, format: 'png' }],
    sourceGroupId: 'old-layer', sourceFileName: 'old.svg', attributes: { QT: '3' },
  })
  const page: Page = { id: 1, name: 'page', items: [item('target')] }
  const result = replaceCanvasItemArtwork([source], [page], 'target', asset('new'))
  expect(result.assets[1].attributes).toBe(source.attributes)
  for (const field of ['sourceGroupWidthMm', 'sourceGroupHeightMm', 'sourceGroupBounds', 'sourceImages', 'sourceGroupId', 'sourceFileName'] as const) {
    expect(result.assets[1][field]).toBeUndefined()
  }
})

test('a missing canvas item, missing asset, ID conflict or invalid dimensions leaves inputs unchanged', () => {
  const source = asset('old'), other = asset('other')
  const assets = [source, other]
  const target = item('target')
  const page: Page = { id: 1, name: 'page', items: [target] }
  const pages = [page]
  expect(() => replaceCanvasItemArtwork(assets, pages, 'removed', asset('new'))).toThrow('已不在当前示意图')
  expect(() => replaceCanvasItemArtwork([], pages, target.id, asset('new'))).toThrow('资源已不存在')
  for (const id of ['', 'old', 'other']) {
    expect(() => replaceCanvasItemArtwork(assets, pages, target.id, asset(id))).toThrow('资源 ID 与当前批次冲突')
  }
  for (const dimensions of [{ width: 0 }, { height: -2 }, { width: Number.NaN }, { height: Number.POSITIVE_INFINITY }]) {
    expect(() => replaceCanvasItemArtwork(assets, pages, target.id, asset('new', dimensions))).toThrow('新图片尺寸无效')
  }
  expect(assets).toEqual([source, other])
  expect(pages).toEqual([page])
  expect(page.items).toEqual([target])
})

const pairedSource = () => asset('old', { productId: 'keychain', productName: 'Keychains', attributes: { 'Print Option': 'Double Sided Different Design' } })

test('repeated rearrangement retains independent Front and Back replacements and their ruler settings', () => {
  const source = pairedSource()
  const initial = paginateAssets([source])
  const front = initial[0].items.find(value => !value.derivedFrom)!
  const back = initial[0].items.find(value => value.derivedFrom)!
  front.rulerUnit = 'cm'
  front.rulerWidth = true
  front.rulerHeight = false
  front.rulerWidthRange = [0.1, 0.9]
  back.rulerUnit = 'in'
  back.rulerHeightRange = [0.2, 0.8]
  let state = replaceCanvasItemArtwork([source], initial, back.id, asset('new-back', { width: 200, height: 100 }))
  state = replaceCanvasItemArtwork(state.assets, state.pages, front.id, asset('new-front', { width: 100, height: 200 }))
  state = replaceCanvasItemArtwork(state.assets, state.pages, back.id, asset('newer-back', { width: 300, height: 100 }))
  for (let iteration = 0; iteration < 3; iteration++) {
    state.pages = autoArrangePages(state.pages, 1, [...state.assets].reverse(), defaultLayoutBounds)
    const items = state.pages.flatMap(page => page.items)
    expect(items).toHaveLength(2)
    const arrangedFront = items.find(value => value.id === front.id)!
    const arrangedBack = items.find(value => value.id === back.id)!
    expect(arrangedFront).toMatchObject({ assetId: 'new-front', arrangementSourceAssetId: source.id, rulerUnit: 'cm', rulerWidth: true, rulerHeight: false, rulerWidthRange: [0.1, 0.9] })
    expect(arrangedBack).toMatchObject({ assetId: 'newer-back', arrangementSourceAssetId: source.id, derivedFrom: front.id, rulerUnit: 'in', rulerHeightRange: [0.2, 0.8] })
    expect(arrangedFront.w / arrangedFront.h).toBeCloseTo(0.5)
    expect(arrangedBack.w / arrangedBack.h).toBeCloseTo(3)
    expect(arrangedFront.backSvg).toBeUndefined()
    expect(arrangedBack.backSvg).toBeUndefined()
  }
})

test('rearrangement keeps a chosen layer on its own role while regenerating an unedited Back', () => {
  const source = pairedSource()
  const pages = paginateAssets([source])
  const front = pages[0].items.find(value => !value.derivedFrom)!
  const back = pages[0].items.find(value => value.derivedFrom)!
  const defaultBack = back.backSvg
  front.svgLayerId = 'selected-front-layer'
  front.backSvg = '<svg>chosen front layer</svg>'
  back.backSvg = '<svg>stale default back</svg>'
  const rearranged = autoArrangePages(pages, 1, [source], defaultLayoutBounds)
  const arrangedFront = rearranged[0].items.find(value => !value.derivedFrom)!
  const arrangedBack = rearranged[0].items.find(value => value.derivedFrom)!
  expect(arrangedFront.svgLayerId).toBe(front.svgLayerId)
  expect(arrangedFront.backSvg).toBe(front.backSvg)
  expect(arrangedBack.backSvg).toBe(defaultBack)
  expect(arrangedBack.svgLayerId).toBeUndefined()

  arrangedBack.svgLayerId = 'selected-back-layer'
  arrangedBack.backSvg = '<svg>chosen back layer</svg>'
  const again = autoArrangePages(rearranged, 1, [source], defaultLayoutBounds)
  expect(again[0].items.find(value => value.derivedFrom)).toMatchObject({ svgLayerId: 'selected-back-layer', backSvg: '<svg>chosen back layer</svg>' })
  expect(again[0].items.find(value => !value.derivedFrom)).toMatchObject({ svgLayerId: 'selected-front-layer', backSvg: '<svg>chosen front layer</svg>' })
})

test('adding a pool image preserves independent Front and Back replacements and layers without duplicate products', () => {
  const source = pairedSource()
  const initial = paginateAssets([source])
  const front = initial[0].items.find(value => !value.derivedFrom)!
  const back = initial[0].items.find(value => value.derivedFrom)!
  let state = replaceCanvasItemArtwork([source], initial, front.id, asset('new-front'))
  state = replaceCanvasItemArtwork(state.assets, state.pages, back.id, asset('new-back', { width: 120, height: 100 }))
  Object.assign(state.pages[0].items.find(value => value.id === front.id)!, { svgLayerId: 'front-layer', backSvg: '<svg>chosen Front</svg>', rulerHeightRange: [0.2, 0.8] })
  Object.assign(state.pages[0].items.find(value => value.id === back.id)!, { svgLayerId: 'back-layer', backSvg: '<svg>chosen Back</svg>' })
  const extra = asset('extra', { productId: 'keychain', productName: 'Keychains' })
  const assets = [...state.assets, extra]
  const pages = autoArrangePages(state.pages, 1, assets, defaultLayoutBounds, [], [extra.id, extra.id, source.id])
  const items = pages.flatMap(page => page.items)
  expect(items).toHaveLength(3)
  expect(items.filter(value => !value.derivedFrom).map(value => value.arrangementSourceAssetId ?? value.assetId)).toEqual([source.id, extra.id])
  expect(items.find(value => value.id === front.id)).toMatchObject({ assetId: 'new-front', svgLayerId: 'front-layer', backSvg: '<svg>chosen Front</svg>', rulerHeightRange: [0.2, 0.8] })
  expect(items.find(value => value.id === back.id)).toMatchObject({ assetId: 'new-back', svgLayerId: 'back-layer', backSvg: '<svg>chosen Back</svg>', derivedFrom: front.id })
  expect(items.filter(value => value.assetId === extra.id)).toHaveLength(1)
  expect(items.some(value => value.assetId === source.id)).toBe(false)
  expect(pages.flatMap(page => page.imageGroups ?? [])).toHaveLength(2)
})

function exportedSizes(svg: string) {
  return [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')]
    .map(node => node.textContent).filter(value => value?.startsWith('Size:'))
}

test.each([
  { override: undefined, expected: '24.6 mm' },
  { override: { precision: 'round', decimalPlaces: 0 }, expected: '25 mm' },
  { override: { precision: 'round', decimalPlaces: 2 }, expected: '24.70 mm' },
  { override: { precision: 'truncate', decimalPlaces: 2 }, expected: '24.69 mm' },
] satisfies Array<{ override: DimensionDisplayOverride | undefined; expected: string }>)('replacing Front keeps Size $expected after deselection and both export paths', ({ override, expected }) => {
  const source = pairedSource()
  const pages = paginateAssets([source])
  const front = pages[0].items.find(value => !value.derivedFrom)!
  const overrides = new Map<string, DimensionDisplayOverride>(override ? [[front.id, override]] : [])
  const next = replaceCanvasItemArtwork([source], pages, front.id,
    asset('new', { width: 100, height: 200, sourceGroupWidthMm: 12.348, sourceGroupHeightMm: 24.696 }), overrides)
  const current = next.pages[0]
  const byId = new Map(next.assets.map(value => [value.id, value]))
  const group = current.imageGroups![0]
  expect(group.details!.size).toBe(expected)
  expect(groupForDimensionDisplay(group, current, byId, [], 'default', 1, overrides).details!.size).toBe(expected)
  expect(exportedSizes(pageSvg(current, byId, {}, 1, overrides))).toEqual([`Size: ${expected}`])
  expect(exportedSizes(pageRasterSvg(current, byId, {}, 1, overrides))).toEqual([`Size: ${expected}`])
  expect(next.assets.at(-1)!.sourceGroupHeightMm).toBe(24.696)
  expect(overrides.get(front.id)).toEqual(override)
})

test('replacing Back or a standee base keeps the main Size and its saved text unchanged', () => {
  const source = pairedSource()
  const paired = paginateAssets([source])
  const back = paired[0].items.find(value => value.derivedFrom)!
  const initialDetails = paired[0].imageGroups![0].details!
  const next = replaceCanvasItemArtwork([source], paired, back.id, asset('new-back', { width: 100, height: 300 }))
  expect(next.pages[0].imageGroups![0].details).toBe(initialDetails)
  expect(exportedSizes(pageSvg(next.pages[0], new Map(next.assets.map(value => [value.id, value]))))).toEqual([`Size: ${initialDetails.size}`])

  const standee = [asset('main', { productGroupId: 'g', productName: 'Acrylic Standees' }),
    asset('base', { productGroupId: 'g', productName: 'Acrylic Standees' })]
  const standeePages = paginateAssets(standee)
  const base = standeePages[0].items.find(value => value.caption === 'base')!
  const standeeDetails = standeePages[0].imageGroups![0].details!
  const changedBase = replaceCanvasItemArtwork(standee, standeePages, base.id, asset('new-base', { width: 200, height: 50 }))
  expect(changedBase.pages[0].imageGroups![0].details).toBe(standeeDetails)
})

test('replacement refreshes only its own Size entries including combined panels and keeps hidden Size available', () => {
  const source = asset('old', { productId: 'keychain', productName: 'Keychains' })
  const target = item('target', { rulerWidth: false, rulerHeight: false, sizeAxis: 'height' })
  const other = item('other')
  const page: Page = { id: 1, name: 'page', items: [target, other], imageGroups: [{
    id: 'group', itemIds: [target.id, other.id], x: 10, y: 100, width: 300, height: 200,
    details: { size: 'old-main', sizes: [{ itemId: target.id, label: 'old-target' }, { itemId: other.id, label: 'keep-other' }], qt: '2', finish: 'Epoxy' },
    detailGroups: [
      { itemIds: [target.id], details: { size: 'old-target', qt: '2', finish: 'Epoxy', note: '保留备注' } },
      { itemIds: [other.id], details: { size: 'keep-other', qt: '3', finish: '' } },
    ],
  }] }
  const overrides = new Map<string, DimensionDisplayOverride>([[target.id, { precision: 'truncate', decimalPlaces: 2 }]])
  const next = replaceCanvasItemArtwork([source], [page], target.id,
    asset('new', { width: 100, height: 200, sourceGroupWidthMm: 15, sourceGroupHeightMm: 30 }), overrides)
  const updated = next.pages[0].imageGroups![0]
  expect(updated.details!.size).toBe('old-main')
  expect(updated.details!.sizes).toEqual([{ itemId: target.id, label: '30.00 mm' }, { itemId: other.id, label: 'keep-other' }])
  expect(updated.details!.sizes![1]).toBe(page.imageGroups![0].details!.sizes![1])
  expect(updated.detailGroups![0].details).toMatchObject({ size: '30.00 mm', qt: '2', finish: 'Epoxy', note: '保留备注' })
  expect(updated.detailGroups![1]).toBe(page.imageGroups![0].detailGroups![1])
  const byId = new Map(next.assets.map(value => [value.id, value]))
  expect(exportedSizes(pageSvg(next.pages[0], byId, {}, 1, overrides))).not.toContain('Size: 30.00 mm')
  next.pages[0].items[0] = { ...next.pages[0].items[0], rulerHeight: true }
  expect(exportedSizes(pageSvg(next.pages[0], byId, {}, 1, overrides))).toContain('Size: 30.00 mm')
  expect(page.imageGroups![0].detailGroups![0].details.size).toBe('old-target')
})
