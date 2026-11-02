import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import ImpositionPools from '../src/modules/imposition/ImpositionPools'
import PoolCustomerPie from '../src/modules/imposition/PoolCustomerPie'
import ImpositionPage from '../src/modules/imposition/ImpositionPage'
import { loadPoolRecords, poolImages, poolCustomers, readPools, recordsForPool, replacePoolImages, poolStorageKey } from '../src/modules/imposition/impositionPoolStore'
import type { ImpositionRecord } from '../src/modules/imposition/impositionRecords'

const invoke = vi.hoisted(() => vi.fn())
const storageMode = vi.hoisted(() => vi.fn())
vi.mock('../src/services/backend', () => ({ invoke, storageMode }))
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => false }))
vi.mock('../src/modules/imposition/ImpositionKonvaCanvas', () => ({ default: () => null }))
const records: ImpositionRecord[] = ['one', 'two'].map((id, index) => ({ id, sourceReviewId: id, customerName: index ? '客户乙' : '客户甲', output: `${id}.pdf`, submittedAt: '2026-10-19T01:00:00Z', paymentStatus: 'paid', status: 'pending', imageCount: 2, images: ['same-asset', 'other'].map(asset => ({ id: asset, name: `${id}-${asset}.svg`, sourceFileName: `${asset}.svg`, filePath: `D:/assets/${id}-${asset}.svg`, widthMm: 30, heightMm: 40, productId: 'product', productName: '照片夹', attributes: { QT: '8', Finish: 'Epoxy' }, attributeImages: {}, note: '', noteImage: null, productGroupId: '', productGroupLeaderId: '', productGroupPosition: 0 })) }))

beforeEach(() => {
  localStorage.clear()
  storageMode.mockResolvedValue({ shared: false })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) })
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') return { records, total: 2, page: 1, pageSize: 100 }
    if (command === 'load_imposition_job') return records.find(record => record.id === args.id)
    if (command === 'load_imposition_thumbnail') return 'data:image/png;base64,aGVsbG8='
  })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('opens only the clicked customer images without an inline pool preview', async () => {
  localStorage.setItem(poolStorageKey(), JSON.stringify(replacePoolImages(readPools(), 'pool-blue', poolImages(records).map(item => item.key))))
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPools active revision={0} onBack={() => {}} onStart={() => {}}/></ConfigProvider>)
  await screen.findByRole('img', { name: '客户图片占比饼图，共 4 张图片，2 位客户' })
  expect(screen.queryByText('池内图片预览')).toBeNull()
  fireEvent.click(screen.getByTitle('查看客户甲的图片'))
  const dialog = await screen.findByRole('dialog', { name: '客户甲 · 图片缩略图（2 张）' })
  expect(within(dialog).getByText('one-same-asset.svg')).toBeTruthy()
  expect(within(dialog).getByText('one-other.svg')).toBeTruthy()
  expect(within(dialog).queryByText('two-same-asset.svg')).toBeNull()
})

it('maps pie sectors to customers and ignores clicks outside the circle', () => {
  const onSelect = vi.fn()
  render(<PoolCustomerPie customers={[{ name: '客户甲', count: 3 }, { name: '客户乙', count: 1 }]} onSelect={onSelect}/>)
  const canvas = screen.getByRole('img')
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 300))
  fireEvent.click(canvas, { clientX: 180, clientY: 150 })
  expect(onSelect).toHaveBeenLastCalledWith('客户甲')
  fireEvent.click(canvas, { clientX: 130, clientY: 130 })
  expect(onSelect).toHaveBeenLastCalledWith('客户乙')
  fireEvent.click(canvas, { clientX: 0, clientY: 0 })
  fireEvent.click(canvas, { clientX: 150, clientY: 150 })
  expect(onSelect).toHaveBeenCalledTimes(2)
})

it('keeps repeated asset ids in different orders distinct and only packs selected pool images', () => {
  const images = poolImages(records)
  expect(new Set(images.map(image => image.key)).size).toBe(4)
  const pools = replacePoolImages(readPools(), 'pool-blue', [images[0].key, images[2].key])
  const moved = replacePoolImages(pools, 'pool-teal', [images[0].key])
  expect(moved[0].imageKeys).toEqual([images[2].key])
  expect(moved[1].imageKeys).toEqual([images[0].key])
  expect(poolCustomers([images[0], images[2]])).toHaveLength(2)
  const selected = recordsForPool(records, [images[0]])
  expect(selected).toHaveLength(1)
  expect(selected[0].images).toHaveLength(1)
  expect(records[0].images).toHaveLength(2)
})

it('reads every page even when the production list only shows the first page', async () => {
  invoke.mockImplementation(async (command, args) => {
    if (command === 'list_pending_impositions') return { records: [records[args.query.page - 1]], total: 2, page: args.query.page, pageSize: 1 }
    if (command === 'load_imposition_job') return records.find(record => record.id === args.id)
  })
  expect(await loadPoolRecords(new AbortController().signal)).toHaveLength(2)
  expect(invoke.mock.calls.filter(call => call[0] === 'list_pending_impositions')).toHaveLength(2)
})

it('shows actual thumbnail paths and persists manual membership before launching the pool', async () => {
  const onStart = vi.fn()
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPools active revision={0} onBack={() => {}} onStart={onStart}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '管理图片' }))
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByText('one-same-asset.svg')
  fireEvent.click(within(dialog).getAllByRole('checkbox')[1])
  fireEvent.click(within(dialog).getByRole('button', { name: /保存所选图片/ }))
  await waitFor(() => expect(JSON.parse(localStorage.getItem(poolStorageKey())!)[0].imageKeys).toEqual(['one::same-asset']))
  await waitFor(() => expect(screen.getAllByRole('img', { name: 'one-same-asset.svg' }).some(image => image.getAttribute('src') === 'data:image/png;base64,aGVsbG8=')).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: '开始拼版' }))
  expect(onStart.mock.calls[0][0][0].images.map((image: { id: string }) => image.id)).toEqual(['same-asset'])
  expect(onStart.mock.calls[0][0]).toHaveLength(1)
})

it('does not overwrite unreadable saved configuration', async () => {
  localStorage.setItem(poolStorageKey(), '{broken')
  render(<ImpositionPools active revision={0} onBack={() => {}} onStart={() => {}}/>)
  await screen.findByText(/读取拼版池配置失败/)
  expect(localStorage.getItem(poolStorageKey())).toBe('{broken')
  expect((screen.getByRole('button', { name: /^新建池子/ }) as HTMLButtonElement).disabled).toBe(true)
})

it('retains the pool boundary when the workspace saves QT using a full job response', async () => {
  localStorage.setItem(poolStorageKey(), JSON.stringify(replacePoolImages(readPools(), 'pool-blue', ['one::same-asset'])))
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation(async (command, args) => {
    if (command === 'update_imposition_image_quantity') return { ...records[0], images: records[0].images.map(image => image.id === args.imageId ? { ...image, attributes: { ...image.attributes, QT: String(args.quantity) } } : image) }
    return original(command, args)
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><ImpositionPage active revision={0}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '拼版池' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '开始拼版' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '开始拼版' }))
  fireEvent.click(await screen.findByRole('button', { name: '选择 客户甲 的拼版图片' }))
  const quantity = await screen.findByRole('spinbutton', { name: 'QT one-same-asset.svg' })
  fireEvent.change(quantity, { target: { value: '9' } })
  fireEvent.blur(quantity)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_imposition_image_quantity', { jobId: 'one', imageId: 'same-asset', quantity: 9 }))
  fireEvent.mouseOver(screen.getByRole('switch', { name: '底座混排' }).closest('label')!)
  await screen.findByText('已选 1 张图片 · QT 9 份 · 间距 3 mm')
  expect(screen.queryByRole('spinbutton', { name: 'QT one-other.svg' })).toBeNull()
  expect(screen.queryByRole('spinbutton', { name: 'QT two-same-asset.svg' })).toBeNull()
})

it('keeps newly saved shared pool membership when an older refresh returns last', async () => {
  storageMode.mockResolvedValue({ shared: true })
  const pools = readPools()
  let finishSave!: () => void
  let finishRead!: (value: unknown) => void
  let reads = 0
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation(async (command, args) => {
    if (command === 'load_cloud_pools') {
      if (++reads === 1) return { pools }
      return new Promise(resolve => { finishRead = resolve })
    }
    if (command === 'save_cloud_pools') return new Promise<void>(resolve => { finishSave = resolve })
    return original(command, args)
  })
  const props = { active: true, revision: 0, onBack: () => {}, onStart: () => {} }
  const view = render(<ImpositionPools {...props}/>)
  await waitFor(() => expect((screen.getByRole('button', { name: /^新建池子/ }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: /^新建池子/ }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('池子名称'), { target: { value: '刚保存的池子' } })
  fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }))
  await waitFor(() => expect(finishSave).toBeTypeOf('function'))
  view.rerender(<ImpositionPools {...props} revision={1}/>)
  await waitFor(() => expect(finishRead).toBeTypeOf('function'))
  await act(async () => finishSave())
  await screen.findByRole('button', { name: '查看刚保存的池子' })
  await act(async () => finishRead({ pools }))
  expect(screen.queryByRole('button', { name: '查看刚保存的池子' })).not.toBeNull()
})
