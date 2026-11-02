import test from 'node:test'
import assert from 'node:assert/strict'
import { artworkBounds, defaultLayoutBounds, GROUP_GAP, PAPER_WIDTH, pageRasterSvg } from '../src/model.ts'
import { autoArrangePages, paginateAssets } from '../src/modules/schematic/services/paginationService.ts'

const asset = (id, extra = {}) => ({ id, name: id, productId: 'keychains', productName: 'Keychains', width: 60, height: 80,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 80"><rect width="60" height="80" fill="red"/></svg>',
  previewUrl: '', thumbnailUrl: '', attributes: { QT: '8' }, ...extra })
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`)

function fixture(double = false) {
  const assets = [asset('a', double ? { attributes: { QT: '8', 'Print Option': 'Double Sided Different Design' } } : {}), asset('b')]
  const pages = paginateAssets(assets)
  const page = pages[0]
  const source = page.items.find(item => item.assetId === 'a' && !item.derivedFrom)
  const group = page.imageGroups.find(group => group.itemIds.includes(source.id))
  const original = page.items.find(item => item.derivedFrom === source.id)
  source.w = 27; source.h = 41; source.rotation = 12
  source.x = group.x + 32; source.y = group.y + 62
  const back = { ...source, id: original?.id ?? `${source.id}-manual-back`, derivedFrom: source.id, manualBack: true,
    x: source.x + 48, mirrorX: true, caption: 'Back', backSvg: '<svg><path fill="blue" d="M0,0 L40,80"/></svg>',
    svgLayerIds: ['back', 'window'], suppressRuler: true }
  page.items = [...page.items.filter(item => item.id !== back.id), back]
  if (!group.itemIds.includes(back.id)) group.itemIds.push(back.id)
  const area = artworkBounds(defaultLayoutBounds)
  const baseWidth = (PAPER_WIDTH - area.left - area.right - GROUP_GAP * 2) / 3
  group.width = baseWidth * 2 + GROUP_GAP
  group.height = 155; group.backgroundHeight = 155; group.manualSize = true
  group.detailsX = group.x + 110; group.detailWidth = group.width - 110
  group.backgroundColor = '#11223388'
  group.details = { ...group.details, size: 'edited Size', qt: 'edited QT', note: 'saved note', textOverrides: { size: { color: '#102030', fontSize: 16 } } }
  group.imageCells = [{ itemId: source.id, x: group.x + 8, y: group.y + 20, width: 45, height: 85 },
    { itemId: back.id, x: group.x + 56, y: group.y + 20, width: 45, height: 85, label: 'Back' }]
  page.annotations = [{ id: 'ruler', kind: 'ruler', sourceItemId: back.id, x: back.x - 15, y: back.y - 20,
    x2: back.x - 15, y2: back.y + 20, measuredMm: 72, extensionOffset: -5, color: '#2f6fa3' },
  { id: 'free', kind: 'text', x: 5, y: 5, text: 'page note', color: '#000', fontSize: 12 }]
  return { assets, pages, source, back, group }
}

test('regeneration retains a manually added back and its complete expanded block without changing either image size', () => {
  const { assets, pages, source, back, group } = fixture()
  const before = structuredClone(pages)
  const scales = new Map([[source.id, 1.6], [back.id, 1.6]])
  const next = autoArrangePages(pages, pages[0].id, assets, defaultLayoutBounds, [], [], scales)
  const destination = next.find(page => page.items.some(item => item.id === back.id))
  const restoredGroup = destination.imageGroups.find(value => value.id === group.id)
  const movedSource = destination.items.find(item => item.id === source.id)
  const movedBack = destination.items.find(item => item.id === back.id)
  assert.equal(next.flatMap(page => page.items).filter(item => item.manualBack).length, 1)
  for (const [old, moved] of [[source, movedSource], [back, movedBack]]) assert.deepEqual({ ...moved, x: old.x, y: old.y }, old)
  close(movedBack.x - movedSource.x, back.x - source.x)
  close(movedBack.y - movedSource.y, back.y - source.y)
  assert.equal(restoredGroup.width, group.width)
  assert.equal(restoredGroup.height, group.height)
  assert.equal(restoredGroup.backgroundColor, group.backgroundColor)
  assert.deepEqual(restoredGroup.details, group.details)
  assert.deepEqual(restoredGroup.itemIds, group.itemIds)
  const dx = restoredGroup.x - group.x, dy = restoredGroup.y - group.y
  assert.deepEqual(restoredGroup.imageCells, group.imageCells.map(cell => ({ ...cell, x: cell.x + dx, y: cell.y + dy })))
  assert.deepEqual(pages, before, 'source snapshots remain immutable for undo')
  assert.deepEqual([...scales], [[source.id, 1.6], [back.id, 1.6]])
  const art = []
  const exported = pageRasterSvg(destination, new Map(assets.map(asset => [asset.id, asset])), {}, next.length, undefined,
    svg => { art.push(svg); return 'artwork.svg' }, defaultLayoutBounds, undefined, scales)
  assert.ok(exported.includes('scale(-1 1)'))
  assert.ok(art.includes(back.backSvg))
})

test('manual backs do not duplicate when the product already generates a native back or regenerates repeatedly', () => {
  const { assets, pages, back, group } = fixture(true)
  let result = pages
  for (let pass = 0; pass < 3; pass++) {
    result = autoArrangePages(result, result[0].id, assets, defaultLayoutBounds)
    const members = result.flatMap(page => page.items).filter(item => item.assetId === 'a')
    assert.equal(members.length, group.itemIds.length)
    assert.equal(members.filter(item => item.id === back.id).length, 1)
    assert.equal(members.find(item => item.id === back.id).manualBack, true)
  }
})

test('expanded blocks repack without overlapping neighbors and associated rulers follow their content', () => {
  const { assets, pages, back, group } = fixture()
  const originalRuler = pages[0].annotations[0]
  const next = autoArrangePages(pages, pages[0].id, assets, defaultLayoutBounds)
  const page = next.find(page => page.items.some(item => item.id === back.id))
  const restored = page.imageGroups.find(value => value.id === group.id)
  for (const other of page.imageGroups.filter(value => value.id !== group.id)) {
    assert.ok(other.x >= restored.x + restored.width - 1e-7 || restored.x >= other.x + other.width - 1e-7
      || other.y >= restored.y + restored.height - 1e-7 || restored.y >= other.y + other.height - 1e-7)
  }
  const movedBack = page.items.find(item => item.id === back.id)
  const ruler = page.annotations.find(annotation => annotation.id === originalRuler.id)
  close(ruler.x - movedBack.x, originalRuler.x - back.x)
  close(ruler.y - movedBack.y, originalRuler.y - back.y)
  close(ruler.y2 - movedBack.y, originalRuler.y2 - back.y)
  assert.deepEqual(next.flatMap(page => page.annotations ?? []).find(annotation => annotation.id === 'free'), pages[0].annotations[1])
})

test('ordinary pages keep the existing regeneration path when there is no manually added back', () => {
  const assets = [asset('a'), asset('b')]
  const previous = paginateAssets(assets)
  const result = autoArrangePages(previous, previous[0].id, assets, defaultLayoutBounds)
  assert.ok(result.flatMap(page => page.headerBlocks ?? []).every(header => !header.id.startsWith('refresh-')))
  assert.equal(result.flatMap(page => page.items).length, 2)
})
