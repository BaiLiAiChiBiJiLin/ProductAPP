import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Asset } from '../src/model'
import UploadImageList from '../src/modules/schematic/components/UploadImageList'
import AssetDetailsModal from '../src/modules/schematic/components/AssetDetailsModal'

vi.mock('../src/modules/schematic/components/LazySvgImage', () => ({ default: ({ alt }: { alt: string }) => <img alt={alt}/> }))
vi.mock('../src/modules/schematic/grouping/useProductGrouping', () => ({ useProductGroup: () => null }))
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getComputedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
})
afterEach(cleanup)

const asset: Asset = {
  id: 'one', name: '多图资产', sourceFileName: '订单.svg', productId: 'custom:p', productName: '摇摇乐',
  width: 100, height: 100, svg: '<svg/>', previewUrl: '', thumbnailUrl: '',
  storagePath: 'D:/project/productionAPP/printflow-data/temp-assets/one.svg',
  sourceGroupWidthMm: 44.477, sourceGroupHeightMm: 192.807, attributes: { QT: '0' },
  sourceImages: [{ nodeId: 'front', format: 'PNG', widthPx: 2000, heightPx: 3000, widthMm: 40, heightMm: 60 }, { nodeId: 'back', format: 'JPEG', widthPx: 800, heightPx: 600, widthMm: 32, heightMm: 24 }],
}

test('card right click opens details for that asset without changing selection or opening preview', async () => {
  const select = vi.fn()
  const other = { ...asset, id: 'two', name: '另一张图', sourceImages: [] }
  render(<UploadImageList assets={[asset, other]} allAssets={[asset, other]} selectedIds={new Set(['two'])} onSelectionChange={select} products={[]} disabled={false} onDelete={vi.fn()}/>)
  fireEvent.contextMenu(screen.getByRole('button', { name: '预览 多图资产' }), { clientX: 200, clientY: 120 })
  fireEvent.click(await screen.findByRole('menuitem', { name: '详情' }))
  const dialog = await screen.findByRole('dialog', { name: '图片资产详情' })
  expect(within(dialog).getByText('40.000 × 60.000 mm')).toBeTruthy()
  expect(within(dialog).getByText('32.000 × 24.000 mm')).toBeTruthy()
  expect(within(dialog).queryByText(/2000.*3000/)).toBeNull()
  expect(within(dialog).getByText('44.477 × 192.807 mm')).toBeTruthy()
  expect(within(dialog).getByText(asset.storagePath!)).toBeTruthy()
  expect(within(dialog).getByText('0')).toBeTruthy()
  expect(select).not.toHaveBeenCalled()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect((screen.getByRole('checkbox', { name: '选择 另一张图' }) as HTMLInputElement).checked).toBe(true)
})

test('legacy assets and vector-only assets have different empty states', () => {
  const { rerender } = render(<AssetDetailsModal asset={{ ...asset, sourceImages: undefined }} products={[]} onClose={vi.fn()}/>)
  expect(screen.getByText('此资产未记录图片尺寸，重新导入后会记录。')).toBeTruthy()
  rerender(<AssetDetailsModal asset={{ ...asset, sourceImages: [] }} products={[]} onClose={vi.fn()}/>)
  expect(screen.getByText('此资产未发现位图，无独立图片尺寸。')).toBeTruthy()
})

test('old pixel-only metadata is not converted using an invented raster DPI', () => {
  render(<AssetDetailsModal asset={{ ...asset, sourceImages: [{nodeId:'old', format:'PNG', widthPx:2000, heightPx:3000}] }} products={[]} onClose={vi.fn()}/>)
  expect(screen.getByText('未记录毫米尺寸，请重新导入')).toBeTruthy()
  expect(screen.queryByText(/529\.167/)).toBeNull()
})

test('right-click replacement targets its own card without selecting it or opening details', async () => {
  const select = vi.fn()
  const replace = vi.fn().mockResolvedValue(undefined)
  const other = { ...asset, id: 'two', name: '另一张图' }
  render(<UploadImageList assets={[asset, other]} allAssets={[asset, other]} selectedIds={new Set(['two'])} onSelectionChange={select} products={[]} disabled={false} onDelete={vi.fn()} onReplace={replace}/>)
  fireEvent.contextMenu(screen.getByRole('button', { name: '预览 多图资产' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '更换图片' }))
  expect(replace).toHaveBeenCalledExactlyOnceWith(asset)
  expect(select).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('replacement cannot start while the batch is busy', async () => {
  const replace = vi.fn()
  render(<UploadImageList assets={[asset]} allAssets={[asset]} selectedIds={new Set()} onSelectionChange={vi.fn()} products={[]} disabled onDelete={vi.fn()} onReplace={replace}/>)
  fireEvent.contextMenu(screen.getByRole('button', { name: '预览 多图资产' }))
  const menu = await screen.findByRole('menuitem', { name: '更换图片' })
  expect(menu.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(menu)
  expect(replace).not.toHaveBeenCalled()
})

test('cards and asset details display every named or unnamed note image and preview the clicked one', async () => {
  const withNotes: Asset = { ...asset, noteImage: 'legacy.png', noteImages: [
    { src: 'front.png', name: '正面参考' }, { src: 'back.png', name: '' }, { src: 'detail.png', name: '孔位' },
  ] }
  const select = vi.fn()
  const { unmount } = render(<UploadImageList assets={[withNotes]} allAssets={[withNotes]} selectedIds={new Set()} onSelectionChange={select} products={[]} disabled={false} onDelete={vi.fn()}/>)
  expect(screen.getByRole('img', { name: '正面参考' }).getAttribute('src')).toBe('front.png')
  expect(screen.getByRole('img', { name: '备注图片 2' }).getAttribute('src')).toBe('back.png')
  expect(screen.getByRole('img', { name: '孔位' }).getAttribute('src')).toBe('detail.png')
  fireEvent.click(screen.getByRole('button', { name: `预览备注 ${asset.name} 2` }))
  const preview = await screen.findByRole('dialog')
  expect(within(preview).getByRole('img', { name: `${asset.name} · 备注` }).getAttribute('src')).toBe('back.png')
  expect(select).not.toHaveBeenCalled()
  unmount()
  render(<AssetDetailsModal asset={withNotes} products={[]} onClose={vi.fn()}/>)
  const notes = screen.getByRole('region', { name: '资产备注' })
  expect(within(notes).getAllByRole('img')).toHaveLength(3)
  expect(within(notes).getByText('正面参考')).toBeTruthy()
  expect(within(notes).getByText('孔位')).toBeTruthy()
})

test('details keep legacy single note images and respect an explicitly cleared image list', () => {
  const { rerender } = render(<AssetDetailsModal asset={{ ...asset, noteImage: 'old-note.png' }} products={[]} onClose={vi.fn()}/>)
  expect(screen.getByRole('img', { name: '备注图片 1' }).getAttribute('src')).toBe('old-note.png')
  rerender(<AssetDetailsModal asset={{ ...asset, noteImage: 'old-note.png', noteImages: [] }} products={[]} onClose={vi.fn()}/>)
  expect(screen.queryByRole('region', { name: '资产备注' })).toBeNull()
})
