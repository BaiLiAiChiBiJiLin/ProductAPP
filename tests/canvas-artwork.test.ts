import { expect, test } from 'vitest'
import type { Asset, Item, Page } from '../src/model'
import { defaultLayoutBounds, pageRasterSvg, pageSvg } from '../src/model'
import { replaceCanvasItemArtwork, replaceCanvasItemWithAsset } from '../src/modules/schematic/services/canvasArtworkService'
import { autoArrangePages, paginateAssets } from '../src/modules/schematic/services/paginationService'
import { groupForDimensionDisplay } from '../src/modules/schematic/services/dimensionDisplayService'
import type { DimensionDisplayOverride } from '../src/modules/schematic/services/imageDimensionService'
import { backLayerSvg } from '../src/modules/schematic/services/svgBackLayerService'

const asset = (id: string, fields: Partial<Asset> = {}): Asset => ({
  id, name: `${id}.svg`, productId: 'standee', width: 40, height: 80,
  svg: `<svg id="${id}"/>`, previewUrl: `${id}-preview`, thumbnailUrl: `${id}-thumbnail`,
  storagePath: `temp-assets/${id}.svg`, ...fields,
})
const item = (id: string, fields: Partial<Item> = {}): Item => ({
  id, assetId: 'old', x: 125, y: 180, w: 50, h: 100, rotation: 0, ...fields,
})

test('pool replacement changes only the dropped placement and keeps the previous asset available', () => {
  const original = asset('old')
  const replacement = asset('new', { width: 20, height: 40 })
  const target = item('target', { caption: 'Front' })
  const page: Page = { id: 1, name: 'page', items: [target], imageGroups: [{ id: 'group', itemIds: [target.id], x: 90, y: 120, width: 80, height: 140 }] }
  const result = replaceCanvasItemWithAsset([page], target.id, replacement)
  expect(result[0].items[0]).toMatchObject({ ...target, assetId: 'new', w: 50, h: 100, arrangementSourceAssetId: undefined, backSvg: undefined, svgLayerId: undefined, svgLayerIds: undefined })
  expect(result[0].imageGroups).toEqual(page.imageGroups)
  expect(page.items[0]).toEqual(target)
  expect(original.id).toBe('old')
})

test('replacing Back replaces the list entry and all shared Front/Back references across pages', () => {
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
    backSvg: '<svg>old back layer</svg>', svgLayerId: 'old-layer', svgLayerIds: ['old-layer', 'second-old-layer'], mirrorX: true, rotation: 25, note: '画布备注',
    rulerUnit: 'cm', rulerWidth: true, rulerHeight: true, sizeAxis: 'height',
    rulerWidthRange: [0.1, 0.9], rulerHeightRange: [0.2, 0.8], suppressRuler: false,
  })
  const page: Page = {
    id: 1, name: '页面 1', items: [front, back],
    imageGroups: [{ id: 'group', itemIds: [front.id, back.id], x: 10, y: 120, width: 300, height: 150 }],
    headerBlocks: [{ id: 'header', x: 10, y: 95, width: 300, columns: [{ id: 'column', imageMode: 'separate', detailLabel: 'Size/QT/Finish/Accessory' }], assetIds: [source.id] }],
  }
  const otherPage: Page = { id: 2, name: '页面 2', items: [item('copy', { w: 60, h: 80 })] }
  const unrelated = asset('unrelated')
  const unrelatedPage: Page = { id: 3, name: '页面 3', items: [item('unrelated-item', { assetId: unrelated.id })] }
  const follower = asset('follower', { productGroupId: 'product-group', productGroupLeaderId: source.id, productGroupPosition: 2 })
  const replacement = asset('new', {
    width: 200, height: 100, sourceGroupWidthMm: 60, sourceGroupHeightMm: 30,
    sourceFileName: 'new.svg', sourceGroupId: 'artwork-layer', sourceGroupBounds: [0, 0, 200, 100],
    sourceImages: [{ nodeId: 'image', widthPx: 200, heightPx: 100, format: 'png' }],
    attributes: { QT: '99' }, note: '不采用新资源业务属性',
  })
  const output = replaceCanvasItemArtwork([unrelated, source, follower], [page, otherPage, unrelatedPage], back.id, replacement)

  expect(output.assets.map(value => value.id)).toEqual(['unrelated', 'new', 'follower'])
  expect(output.assets[0]).toBe(unrelated)
  expect(output.assets[1]).toMatchObject({
    id: 'new', width: 200, height: 100, productId: source.productId, productName: source.productName,
    attributes: source.attributes, note: source.note, attributeImages: source.attributeImages,
    noteImages: source.noteImages, productGroupLeaderId: 'new', productGroupId: 'product-group', productGroupPosition: 1,
  })
  expect(output.assets[2]).toMatchObject({ productGroupLeaderId: 'new', productGroupPosition: 2 })
  expect(output.pages[2]).toBe(unrelatedPage)
  expect(output.pages[1].items[0]).toEqual({ ...otherPage.items[0], assetId: 'new', arrangementSourceAssetId: undefined, w: 60, h: 30, backSvg: undefined, svgLayerId: undefined, svgLayerIds: undefined })
  expect(output.pages[0].items[0]).toEqual({ ...front, assetId: 'new', arrangementSourceAssetId: undefined, w: 50, h: 25, backSvg: undefined, svgLayerId: undefined, svgLayerIds: undefined })
  expect(output.pages[0].items[1]).toEqual({ ...back, assetId: 'new', arrangementSourceAssetId: undefined, w: 50, h: 25, backSvg: backLayerSvg(replacement.svg, true), svgLayerId: undefined, svgLayerIds: undefined })
  expect(output.pages[0].imageGroups).toBe(page.imageGroups)
  expect(output.pages[0].headerBlocks![0].assetIds).toEqual(['new'])
  expect(page.headerBlocks![0].assetIds).toEqual(['old'])
  expect(page.items[1]).toBe(back)
  expect(back.backSvg).toBe('<svg>old back layer</svg>')
  expect(back.svgLayerIds).toEqual(['old-layer', 'second-old-layer'])
})

test('replacing Front contains the new art in each original frame and regenerates derived Back', () => {
  const source = asset('old')
  const front = item('front', { caption: 'Front', backSvg: '<svg>selected layer</svg>' })
  const back = item('back', { caption: 'Back', derivedFrom: 'front', backSvg: '<svg>back</svg>' })
  const page: Page = { id: 1, name: 'page', items: [front, back] }
  const output = replaceCanvasItemArtwork([source], [page], front.id, asset('new', { width: 10, height: 100 }))
  expect(output.pages[0].items[0]).toEqual({ ...front, assetId: 'new', arrangementSourceAssetId: undefined, w: 10, h: 100, backSvg: undefined, svgLayerId: undefined, svgLayerIds: undefined })
  expect(output.pages[0].items[1]).toEqual({ ...back, assetId: 'new', arrangementSourceAssetId: undefined, w: 10, h: 100, backSvg: '<svg id="new"/>', svgLayerId: undefined, svgLayerIds: undefined })
  expect(output.assets).toHaveLength(1)
  expect(output.assets[0].id).toBe('new')
})

test('legacy arrangement sources are remapped without overwriting independently replaced artwork', () => {
  const original = asset('old')
  const independent = asset('independent')
  const previousSource = asset('legacy-source')
  const target = item('target', { arrangementSourceAssetId: 'old', svgLayerIds: ['layer'] })
  const retainedSource = item('retained-source', { arrangementSourceAssetId: 'legacy-source' })
  const independentItem = item('independent', {
    assetId: independent.id, arrangementSourceAssetId: 'old', svgLayerIds: ['selected'], backSvg: '<svg>independent artwork</svg>',
  })
  const sourceOnlyPage: Page = { id: 2, name: 'source-only', items: [independentItem] }
  const output = replaceCanvasItemArtwork([original, independent, previousSource], [
    { id: 1, name: 'page', items: [target, retainedSource] }, sourceOnlyPage,
  ], target.id, asset('new'))
  expect(output.assets.map(value => value.id)).toEqual(['new', 'independent', 'legacy-source'])
  expect(output.pages[0].items[0].arrangementSourceAssetId).toBeUndefined()
  expect(output.pages[0].items[1]).toMatchObject({ assetId: 'new', arrangementSourceAssetId: 'legacy-source' })
  expect(output.pages[1].items[0]).toEqual({ ...independentItem, arrangementSourceAssetId: 'new' })
  expect(independentItem.arrangementSourceAssetId).toBe('old')
  expect(output.assets[1]).toBe(independent)
})

test.each([
  { productName: 'Keychains', productId: 'keychain', fit: false },
  { productName: undefined, productId: 'clear-acrylic-standees', fit: true },
])('derived Back is rebuilt from the new SVG using the product layout rule $productId', ({ productName, productId, fit }) => {
  const source = asset('old', { productName, productId })
  const front = item('front', { svgLayerId: 'selected', backSvg: '<svg>old front layer</svg>' })
  const back = item('back', { derivedFrom: front.id, mirrorX: true, svgLayerIds: ['old-layer'], backSvg: '<svg>old back layer</svg>' })
  const artwork = asset('new', {
    svg: '<svg viewBox="0 0 200 100"><image id="first" x="10" y="20" width="40" height="60" href="first.png"/><image id="second" x="80" y="20" width="40" height="60" href="second.png"/></svg>',
  })
  const result = replaceCanvasItemArtwork([source], [{ id: 1, name: 'page', items: [front, back] }], back.id, artwork)
  expect(result.pages[0].items[0].backSvg).toBeUndefined()
  expect(result.pages[0].items[1]).toMatchObject({ derivedFrom: front.id, mirrorX: true, backSvg: backLayerSvg(artwork.svg, fit) })
  expect(result.pages[0].items[1].backSvg).not.toContain('id="second"')
  expect(result.pages[0].items[1].backSvg).toContain(fit ? 'viewBox="10 20 40 60"' : 'viewBox="0 0 200 100"')
  for (const changed of result.pages[0].items) {
    expect(changed.svgLayerId).toBeUndefined()
    expect(changed.svgLayerIds).toBeUndefined()
  }
})

test('new artwork clears stale source measurement metadata while retaining business properties', () => {
  const source = asset('old', {
    sourceGroupWidthMm: 100, sourceGroupHeightMm: 200, sourceGroupBounds: [1, 2, 100, 200],
    sourceImages: [{ nodeId: 'old-layer', widthPx: 100, heightPx: 200, format: 'png' }],
    sourceGroupId: 'old-layer', sourceFileName: 'old.svg', attributes: { QT: '3' },
  })
  const page: Page = { id: 1, name: 'page', items: [item('target')] }
  const result = replaceCanvasItemArtwork([source], [page], 'target', asset('new'))
  expect(result.assets[0].attributes).toBe(source.attributes)
  for (const field of ['sourceGroupWidthMm', 'sourceGroupHeightMm', 'sourceGroupBounds', 'sourceImages', 'sourceGroupId', 'sourceFileName'] as const) {
    expect(result.assets[0][field]).toBeUndefined()
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

test('repeated replacement and rearrangement retain stable Front/Back identities and ruler settings', () => {
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
    expect(state.assets.map(value => value.id)).toEqual(['newer-back'])
    expect(arrangedFront).toMatchObject({ assetId: 'newer-back', rulerUnit: 'cm', rulerWidth: true, rulerHeight: false, rulerWidthRange: [0.1, 0.9] })
    expect(arrangedBack).toMatchObject({ assetId: 'newer-back', derivedFrom: front.id, rulerUnit: 'in', rulerHeightRange: [0.2, 0.8] })
    expect(arrangedFront.arrangementSourceAssetId).toBeUndefined()
    expect(arrangedBack.arrangementSourceAssetId).toBeUndefined()
    expect(arrangedFront.w / arrangedFront.h).toBeCloseTo(3)
    expect(arrangedBack.w / arrangedBack.h).toBeCloseTo(3)
    expect(arrangedFront.backSvg).toBeUndefined()
    expect(arrangedBack.backSvg).toBe(backLayerSvg(state.assets[0].svg))
    const ids = new Set(items.map(value => value.id))
    expect(state.pages.flatMap(page => page.imageGroups ?? []).flatMap(group => group.itemIds).every(id => ids.has(id))).toBe(true)
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

test('rearrangement and both export paths retain multiple layers independently for Front and Back', () => {
  const source = pairedSource()
  const pages = paginateAssets([source])
  const front = pages[0].items.find(value => !value.derivedFrom)!
  const back = pages[0].items.find(value => value.derivedFrom)!
  Object.assign(front, { svgLayerIds: ['svg-layer-0', 'svg-layer-1'], backSvg: '<svg><rect fill="red"/><circle fill="blue"/></svg>' })
  Object.assign(back, { svgLayerIds: ['svg-layer-2', 'svg-layer-3'], backSvg: '<svg><rect fill="green"/><circle fill="yellow"/></svg>' })
  expect(front.arrangementSourceAssetId).toBeUndefined()
  expect(back.arrangementSourceAssetId).toBeUndefined()
  expect(front.svgLayerId).toBeUndefined()
  expect(back.svgLayerId).toBeUndefined()

  let arranged = pages
  for (let iteration = 0; iteration < 2; iteration++) {
    arranged = autoArrangePages(arranged, 1, [source], defaultLayoutBounds)
    for (const original of [front, back]) {
      expect(arranged[0].items.find(value => value.id === original.id)).toMatchObject({
        svgLayerIds: original.svgLayerIds, backSvg: original.backSvg,
      })
    }
  }
  const assets = new Map([[source.id, source]])
  for (const svg of [pageSvg(arranged[0], assets), pageRasterSvg(arranged[0], assets)]) {
    const images = new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('image')
    const artworks = [...images].map(image => atob(image.getAttribute('href')!.split(',')[1]))
    expect(artworks).toEqual([front.backSvg, back.backSvg])
  }
})

test('adding a pool image after replacement preserves separate Front/Back layers without duplicating products', () => {
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
  const pages = autoArrangePages(state.pages, 1, assets, defaultLayoutBounds, [], [extra.id, extra.id, 'new-back'])
  const items = pages.flatMap(page => page.items)
  expect(items).toHaveLength(3)
  expect(items.filter(value => !value.derivedFrom).map(value => value.arrangementSourceAssetId ?? value.assetId)).toEqual(['new-back', extra.id])
  expect(items.find(value => value.id === front.id)).toMatchObject({ assetId: 'new-back', svgLayerId: 'front-layer', backSvg: '<svg>chosen Front</svg>', rulerHeightRange: [0.2, 0.8] })
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

test('replacing Back refreshes its shared main Size while a standee base replacement keeps main Size unchanged', () => {
  const source = pairedSource()
  const paired = paginateAssets([source])
  const back = paired[0].items.find(value => value.derivedFrom)!
  const initialDetails = paired[0].imageGroups![0].details!
  const next = replaceCanvasItemArtwork([source], paired, back.id, asset('new-back', { width: 100, height: 300 }))
  expect(next.pages[0].imageGroups![0].details!.size).toBe('79.3 mm')
  expect(next.pages[0].imageGroups![0].details!.size).not.toBe(initialDetails.size)
  expect(exportedSizes(pageSvg(next.pages[0], new Map(next.assets.map(value => [value.id, value]))))).toEqual(['Size: 79.3 mm'])

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
  const other = item('other', { assetId: 'unrelated' })
  const page: Page = { id: 1, name: 'page', items: [target, other], imageGroups: [{
    id: 'group', itemIds: [target.id, other.id], x: 10, y: 100, width: 300, height: 200,
    details: { size: 'old-main', sizes: [{ itemId: target.id, label: 'old-target' }, { itemId: other.id, label: 'keep-other' }], qt: '2', finish: 'Epoxy' },
    detailGroups: [
      { itemIds: [target.id], details: { size: 'old-target', qt: '2', finish: 'Epoxy', note: '保留备注' } },
      { itemIds: [other.id], details: { size: 'keep-other', qt: '3', finish: '' } },
    ],
  }] }
  const overrides = new Map<string, DimensionDisplayOverride>([[target.id, { precision: 'truncate', decimalPlaces: 2 }]])
  const next = replaceCanvasItemArtwork([source, asset('unrelated')], [page], target.id,
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

test('all shared main Size labels and panels use their own precision and ruler axis across pages', () => {
  const source = asset('old', { productId: 'keychain', productName: 'Keychains' })
  const front = item('front', { rulerHeight: true, rulerWidth: false })
  const copy = item('copy', { rulerHeight: true, rulerWidth: false })
  const widthCopy = item('width-copy', { rulerWidth: true, rulerHeight: false })
  const first: Page = { id: 1, name: 'page1', items: [front, copy], imageGroups: [{
    id: 'g1', itemIds: [front.id, copy.id], x: 10, y: 100, width: 300, height: 200,
    details: { size: 'unused', sizes: [{ itemId: front.id, label: 'old-front' }, { itemId: copy.id, label: 'old-copy' }], qt: '2', finish: '' },
    detailGroups: [front, copy].map(value => ({ itemIds: [value.id], details: { size: 'old', qt: '2', finish: '' } })),
  }] }
  const second: Page = { id: 2, name: 'page2', items: [widthCopy], imageGroups: [{
    id: 'g2', itemIds: [widthCopy.id], x: 10, y: 100, width: 300, height: 200,
    details: { size: 'old-width', qt: '3', finish: '' },
  }] }
  const overrides = new Map<string, DimensionDisplayOverride>([
    [front.id, { precision: 'truncate', decimalPlaces: 2 }],
    [copy.id, { precision: 'round', decimalPlaces: 0 }],
    [widthCopy.id, { precision: 'default', decimalPlaces: 2 }],
  ])
  const next = replaceCanvasItemArtwork([source], [first, second], front.id, asset('new', {
    width: 100, height: 200, sourceGroupWidthMm: 12.348, sourceGroupHeightMm: 24.696,
  }), overrides)
  expect(next.pages[0].imageGroups![0].details!.sizes).toEqual([
    { itemId: front.id, label: '24.69 mm' }, { itemId: copy.id, label: '25 mm' },
  ])
  expect(next.pages[0].imageGroups![0].detailGroups!.map(panel => panel.details.size)).toEqual(['24.69 mm', '25 mm'])
  expect(next.pages[1].imageGroups![0].details!.size).toBe('12.34 mm')
  expect(first.imageGroups![0].details!.sizes![0].label).toBe('old-front')
  expect(second.imageGroups![0].details!.size).toBe('old-width')
})

test('a header-only reference is updated while unrelated headers and pages retain their identity', () => {
  const source = asset('old')
  const header = { id: 'header', x: 10, y: 80, width: 300, columns: [], assetIds: ['old', 'unrelated'] }
  const unrelatedHeader = { ...header, id: 'unrelated-header', assetIds: ['unrelated'] }
  const headerPage: Page = { id: 2, name: 'headers', items: [], headerBlocks: [header, unrelatedHeader] }
  const unrelatedPage: Page = { id: 3, name: 'unrelated', items: [] }
  const result = replaceCanvasItemArtwork([source], [{ id: 1, name: 'page', items: [item('target')] }, headerPage, unrelatedPage], 'target', asset('new'))
  expect(result.pages[1].items).toBe(headerPage.items)
  expect(result.pages[1].headerBlocks![0].assetIds).toEqual(['new', 'unrelated'])
  expect(result.pages[1].headerBlocks![1]).toBe(unrelatedHeader)
  expect(result.pages[2]).toBe(unrelatedPage)
})
