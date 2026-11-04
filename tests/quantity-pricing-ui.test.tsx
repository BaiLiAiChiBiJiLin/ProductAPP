import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render as renderView, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import type { ReactNode } from 'react'
import QuantityPricingSettings from '../src/modules/settings/quantity-pricing/QuantityPricingSettings'
import { cloneDocument, type QuantityPricingDocument } from '../src/modules/settings/quantity-pricing/model'
import type { Snapshot } from '../src/modules/settings/quantity-pricing/service'

const api = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: api.invoke }))

const initial: QuantityPricingDocument = {
  schemaVersion: 1,
  categoryRules: [
    { categoryId: 'keychains', tiers: [
      { quantityTierId: 'keychains-1', minQty: 1, maxQty: 5, discountPercent: 0 },
      { quantityTierId: 'keychains-2', minQty: 6, maxQty: 10, discountPercent: 35 },
    ] },
    { categoryId: 'standees', tiers: [{ quantityTierId: 'standees-1', minQty: 1, maxQty: 10, discountPercent: 10 }] },
  ],
}
const snapshot = (document = cloneDocument(initial), version = 'v1'): Snapshot => ({
  document,
  categories: [
    { categoryId: 'keychains', title: 'Keychains', titleZh: '钥匙扣', productCount: 14 },
    { categoryId: 'standees', title: 'Standees', titleZh: '立牌', productCount: 8 },
    { categoryId: 'acrylic', title: 'Acrylic', titleZh: '亚克力', productCount: 2 },
  ],
  version,
  directory: 'D:/PrintFlow/settings/quantity-pricing',
})
const wrap = (ui: ReactNode) => <ConfigProvider theme={{ token: { motion: false } }}>{ui}</ConfigProvider>
const render = (ui: ReactNode) => renderView(wrap(ui))
const input = (name: string) => screen.getByRole('spinbutton', { name }) as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: /保\s*存$/ }) as HTMLButtonElement
const change = (name: string, value: string) => fireEvent.change(input(name), { target: { value } })
const savedRequest = () => api.invoke.mock.calls.filter(call => call[0] === 'save_quantity_pricing_settings').at(-1)![1] as { document: QuantityPricingDocument; expectedVersion: string }
const displayedTierIds = () => Array.from(document.querySelectorAll('[data-quantity-tier-id]'), row => row.getAttribute('data-quantity-tier-id'))
const rowFor = (quantityTierId: string) => document.querySelector(`[data-quantity-tier-id="${quantityTierId}"]`) as HTMLTableRowElement
const dragTransfer = () => ({ setData: vi.fn(), effectAllowed: 'none', dropEffect: 'none' })
const dragAt = (kind: 'dragOver' | 'drop', row: HTMLTableRowElement, dataTransfer: ReturnType<typeof dragTransfer>, clientY: number) => {
  const event = createEvent[kind](row, { dataTransfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(row, event)
}
const pointerAt = (kind: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', handle: HTMLElement, clientY: number) => {
  const event = createEvent[kind](handle)
  Object.defineProperties(event, { pointerId: { value: 7 }, button: { value: 0 }, clientX: { value: 20 }, clientY: { value: clientY } })
  fireEvent(handle, event)
}

async function selectCategory(text: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '关联产品大类' }).closest('.ant-select-selector')!)
  const popup = await waitFor(() => {
    const popup = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)') as HTMLElement
    expect(popup).toBeTruthy()
    return popup
  })
  fireEvent.click(within(popup).getByText(text, { exact: true }))
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getComputedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
})
beforeEach(() => {
  api.invoke.mockReset().mockImplementation(async (command, request) => {
    if (command === 'load_quantity_pricing_settings') return snapshot()
    if (command === 'save_quantity_pricing_settings') return snapshot(cloneDocument(request.document), 'v2')
    throw new Error(`Unexpected command: ${command}`)
  })
})
afterEach(cleanup)

test('category switches and leaving settings retain independent unsaved drafts', async () => {
  const view = render(<QuantityPricingSettings active/>)
  await screen.findByLabelText('第1档起始数量')
  expect(saveButton().disabled).toBe(true)
  expect(screen.getByText('2 个阶梯 · 14 个产品共用')).toBeTruthy()
  change('第2档减价比例', '37')
  await selectCategory('立牌（8 个产品）')
  expect(Number(input('第1档减价比例').value)).toBe(10)
  change('第1档减价比例', '12')
  await selectCategory('亚克力（2 个产品）')
  expect(screen.getByText('该大类尚未配置阶梯，暂不提供数量折扣。')).toBeTruthy()
  await selectCategory('钥匙扣（14 个产品）')
  expect(Number(input('第2档减价比例').value)).toBe(37)
  view.rerender(wrap(<QuantityPricingSettings active={false}/>))
  view.rerender(wrap(<QuantityPricingSettings active/>))
  expect(Number(input('第2档减价比例').value)).toBe(37)
  await selectCategory('立牌（8 个产品）')
  expect(Number(input('第1档减价比例').value)).toBe(12)
  expect(api.invoke.mock.calls.map(call => call[0])).toEqual(['load_quantity_pricing_settings'])
})

test('save persists category identities and edited tiers without product bindings or formulas', async () => {
  render(<QuantityPricingSettings/>)
  await screen.findByLabelText('第1档起始数量')
  change('第2档减价比例', '33.33')
  fireEvent.click(saveButton())
  await screen.findByText('价格阶梯已保存')
  const request = savedRequest()
  expect(request.expectedVersion).toBe('v1')
  expect(Object.keys(request).sort()).toEqual(['document', 'expectedVersion'])
  expect(request.document.categoryRules[0]).toEqual({ categoryId: 'keychains', tiers: [initial.categoryRules[0].tiers[0], { ...initial.categoryRules[0].tiers[1], discountPercent: 33.33 }] })
  expect(request.document.categoryRules[1]).toEqual(initial.categoryRules[1])
  for (const rule of request.document.categoryRules) {
    expect(Object.keys(rule).sort()).toEqual(['categoryId', 'tiers'])
    for (const tier of rule.tiers) expect(Object.keys(tier).sort()).toEqual(['discountPercent', 'maxQty', 'minQty', 'quantityTierId'])
  }
  expect(saveButton().disabled).toBe(true)
  expect(screen.getByText('配置已同步。')).toBeTruthy()
  change('第2档减价比例', '34')
  fireEvent.click(saveButton())
  await waitFor(() => expect(savedRequest().expectedVersion).toBe('v2'))
})

test('overlapping ranges and cleared required inputs disable persistence until repaired', async () => {
  render(<QuantityPricingSettings/>)
  await screen.findByLabelText('第1档起始数量')
  change('第2档起始数量', '5')
  expect(saveButton().disabled).toBe(true)
  expect(screen.getAllByText('数量区间与其他阶梯重叠')).toHaveLength(2)
  expect(screen.getByText('请先修正阶梯配置，再查看试算结果。')).toBeTruthy()
  fireEvent.click(saveButton())
  expect(api.invoke).toHaveBeenCalledTimes(1)
  change('第2档起始数量', '6')
  change('第1档起始数量', '')
  expect(input('第1档起始数量').value).toBe('')
  expect(saveButton().disabled).toBe(true)
  expect(screen.getByText('起始数量必须是大于 0 的整数')).toBeTruthy()
  change('第1档起始数量', '1')
  change('第2档减价比例', '')
  expect(saveButton().disabled).toBe(true)
  expect(screen.getByText('减价比例须为 0–100，最多保留两位小数')).toBeTruthy()
  change('第2档减价比例', '35')
  expect(saveButton().disabled).toBe(false)
  expect(api.invoke).toHaveBeenCalledTimes(1)
})

test('preview respects finite bounds and clearing the final bound makes an unlimited tier', async () => {
  render(<QuantityPricingSettings/>)
  await screen.findByLabelText('第1档起始数量')
  change('试算数量', '5')
  expect(screen.getByText('减价 0% · 实付 100%')).toBeTruthy()
  change('试算数量', '6')
  expect(screen.getByText('匹配 6–10 件')).toBeTruthy()
  change('试算数量', '11')
  expect(screen.getByText('未命中阶梯 · 按原价')).toBeTruthy()
  change('第2档结束数量', '')
  expect(screen.getByText('减价 35% · 实付 65%')).toBeTruthy()
  expect(screen.getByText('匹配 6 件及以上')).toBeTruthy()
  expect((screen.getByRole('button', { name: '新增阶梯' }) as HTMLButtonElement).disabled).toBe(true)
  change('试算数量', '')
  expect(screen.getByText('请输入大于零的整数数量。')).toBeTruthy()
  fireEvent.click(saveButton())
  await screen.findByText('价格阶梯已保存')
  expect(savedRequest().document.categoryRules[0].tiers[1].maxQty).toBeNull()
})

test('pending and failed saves protect the draft, release busy state and allow retry', async () => {
  const busy = vi.fn()
  render(<QuantityPricingSettings onBusyChange={busy}/>)
  await screen.findByLabelText('第1档起始数量')
  change('第2档减价比例', '36')
  let rejectSave!: (reason: string) => void
  api.invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject }))
  fireEvent.click(saveButton())
  expect(busy.mock.calls).toEqual([[true]])
  expect(input('第2档减价比例').disabled).toBe(true)
  const handle = screen.getByRole('button', { name: '拖动第1档排序' }) as HTMLButtonElement
  expect(handle.disabled).toBe(true)
  expect(handle.draggable).toBe(false)
  expect((screen.getByRole('button', { name: '下移第1档' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  expect(displayedTierIds()).toEqual(['keychains-1', 'keychains-2'])
  expect((screen.getByRole('button', { name: /^刷\s*新$/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(document.querySelector('.quantity-pricing-settings')!.getAttribute('aria-busy')).toBe('true')
  await act(async () => { rejectSave('磁盘不可写') })
  expect((await screen.findByRole('alert')).textContent).toContain('磁盘不可写')
  expect(Number(input('第2档减价比例').value)).toBe(36)
  expect(input('第2档减价比例').disabled).toBe(false)
  expect(saveButton().disabled).toBe(false)
  expect(busy.mock.calls).toEqual([[true], [false]])
  fireEvent.click(saveButton())
  await screen.findByText('价格阶梯已保存')
  expect(savedRequest().document.categoryRules[0].tiers[1].discountPercent).toBe(36)
  expect(busy.mock.calls).toEqual([[true], [false], [true], [false]])
})

test('orphan associations require confirmation and cleanup preserves valid category tiers', async () => {
  const loaded = snapshot()
  loaded.document.categoryRules.push({ categoryId: 'deleted-category', tiers: [{ quantityTierId: 'deleted-1', minQty: 1, maxQty: null, discountPercent: 20 }] })
  api.invoke.mockResolvedValueOnce(loaded)
  render(<QuantityPricingSettings/>)
  await screen.findByText('部分阶梯关联的大类已被删除')
  expect(saveButton().disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '移除失效关联' }))
  await screen.findByText('移除已删除大类的阶梯关联？')
  fireEvent.click(screen.getByRole('button', { name: /^取\s*消$/ }))
  expect(screen.getByText('部分阶梯关联的大类已被删除')).toBeTruthy()
  expect(api.invoke).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '移除失效关联' }))
  fireEvent.click(screen.getByRole('button', { name: /^确\s*定$/ }))
  expect(screen.queryByText('部分阶梯关联的大类已被删除')).toBeNull()
  expect(saveButton().disabled).toBe(false)
  fireEvent.click(saveButton())
  await screen.findByText('价格阶梯已保存')
  expect(savedRequest().document).toEqual(initial)
})

test('refresh cancellation retains edits and confirmed refresh reloads the stored configuration', async () => {
  render(<QuantityPricingSettings/>)
  await screen.findByLabelText('第1档起始数量')
  change('第2档减价比例', '40')
  fireEvent.click(screen.getByRole('button', { name: /^刷\s*新$/ }))
  await screen.findByText('刷新将放弃未保存修改，是否继续？')
  fireEvent.click(screen.getByRole('button', { name: /^取\s*消$/ }))
  expect(Number(input('第2档减价比例').value)).toBe(40)
  expect(api.invoke).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: /^刷\s*新$/ }))
  fireEvent.click(screen.getByRole('button', { name: /^确\s*定$/ }))
  await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2))
  expect(Number((await screen.findByLabelText('第2档减价比例') as HTMLInputElement).value)).toBe(35)
  expect(saveButton().disabled).toBe(true)
  expect(api.invoke.mock.calls.map(call => call[0])).toEqual(['load_quantity_pricing_settings', 'load_quantity_pricing_settings'])
})

test('dragging a handle persists the displayed order and preserves quantity matching after reload', async () => {
  const loaded = snapshot()
  loaded.document.categoryRules[0].tiers.push({ quantityTierId: 'keychains-3', minQty: 11, maxQty: 20, discountPercent: 45 })
  api.invoke.mockResolvedValueOnce(loaded)
  render(<QuantityPricingSettings/>)
  await screen.findByLabelText('第1档起始数量')
  change('试算数量', '6')
  expect(screen.getByText('减价 35% · 实付 65%')).toBeTruthy()
  expect(input('第1档起始数量').closest('[draggable="true"]')).toBeNull()
  const handle = screen.getByRole('button', { name: '拖动第1档排序' })
  const target = rowFor('keychains-3')
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 700, 40))
  const dataTransfer = dragTransfer()
  fireEvent.dragStart(handle, { dataTransfer })
  expect(dataTransfer.setData).toHaveBeenCalledWith('application/x-printflow-quantity-tier', 'keychains-1')
  dragAt('dragOver', target, dataTransfer, 135)
  expect(target.classList.contains('qp-drop-after')).toBe(true)
  expect(screen.getByRole('status').textContent).toBe('松开后放到第 3 档之后。')
  dragAt('drop', target, dataTransfer, 135)
  expect(displayedTierIds()).toEqual(['keychains-2', 'keychains-3', 'keychains-1'])
  expect(screen.getByRole('status').textContent).toBe('已移至第 3 档，保存后生效。')
  expect(document.querySelector('.qp-dragging-row,.qp-drop-before,.qp-drop-after')).toBeNull()
  expect(screen.getByText('减价 35% · 实付 65%')).toBeTruthy()
  expect(screen.getByText('匹配 6–10 件')).toBeTruthy()
  fireEvent.click(saveButton())
  await screen.findByText('价格阶梯已保存')
  const saved = savedRequest().document
  expect(saved.categoryRules[0].tiers.map(tier => tier.quantityTierId)).toEqual(['keychains-2', 'keychains-3', 'keychains-1'])
  expect(saved.categoryRules[0].tiers).toEqual([loaded.document.categoryRules[0].tiers[1], loaded.document.categoryRules[0].tiers[2], loaded.document.categoryRules[0].tiers[0]])
  expect(saved.categoryRules[1]).toEqual(initial.categoryRules[1])
  api.invoke.mockResolvedValueOnce(snapshot(cloneDocument(saved), 'v2'))
  fireEvent.click(screen.getByRole('button', { name: /^刷\s*新$/ }))
  await screen.findByLabelText('第1档起始数量')
  expect(displayedTierIds()).toEqual(['keychains-2', 'keychains-3', 'keychains-1'])
  expect(screen.getByText('减价 35% · 实付 65%')).toBeTruthy()
})

test('keyboard and button alternatives move stable rows and respect the first and last boundaries', async () => {
  render(<QuantityPricingSettings/>)
  await screen.findByLabelText('第1档起始数量')
  expect((screen.getByRole('button', { name: '上移第1档' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '下移第2档' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(screen.getByRole('button', { name: '拖动第1档排序' }), { key: 'ArrowUp' })
  expect(saveButton().disabled).toBe(true)
  const handle = screen.getByRole('button', { name: '拖动第2档排序' })
  handle.focus()
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  expect(displayedTierIds()).toEqual(['keychains-2', 'keychains-1'])
  expect(document.activeElement).toBe(handle)
  expect(handle.getAttribute('aria-label')).toBe('拖动第1档排序')
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  expect(displayedTierIds()).toEqual(['keychains-1', 'keychains-2'])
  fireEvent.click(screen.getByRole('button', { name: '下移第1档' }))
  expect(displayedTierIds()).toEqual(['keychains-2', 'keychains-1'])
  fireEvent.click(screen.getByRole('button', { name: '上移第2档' }))
  expect(displayedTierIds()).toEqual(['keychains-1', 'keychains-2'])
  expect(input('第2档起始数量').value).toBe('6')
})

test('category switches, drag end and leaving the panel cancel a pending drag without moving unrelated rows', async () => {
  const view = render(<QuantityPricingSettings active/>)
  await screen.findByLabelText('第1档起始数量')
  const dataTransfer = dragTransfer()
  fireEvent.dragStart(screen.getByRole('button', { name: '拖动第2档排序' }), { dataTransfer })
  const first = rowFor('keychains-1')
  vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 700, 40))
  dragAt('dragOver', first, dataTransfer, 105)
  expect(first.classList.contains('qp-drop-before')).toBe(true)
  await selectCategory('立牌（8 个产品）')
  dragAt('drop', rowFor('standees-1'), dataTransfer, 0)
  expect(displayedTierIds()).toEqual(['standees-1'])
  await selectCategory('钥匙扣（14 个产品）')
  dragAt('drop', rowFor('keychains-1'), dataTransfer, 0)
  expect(displayedTierIds()).toEqual(['keychains-1', 'keychains-2'])
  expect(saveButton().disabled).toBe(true)
  const handle = screen.getByRole('button', { name: '拖动第2档排序' })
  fireEvent.dragStart(handle, { dataTransfer })
  dragAt('dragOver', rowFor('keychains-1'), dataTransfer, 0)
  fireEvent.dragEnd(handle, { dataTransfer })
  expect(document.querySelector('.qp-dragging-row,.qp-drop-before,.qp-drop-after')).toBeNull()
  fireEvent.dragStart(handle, { dataTransfer })
  expect(fireEvent.keyDown(handle, { key: 'Escape' })).toBe(false)
  dragAt('drop', rowFor('keychains-1'), dataTransfer, 0)
  expect(displayedTierIds()).toEqual(['keychains-1', 'keychains-2'])
  fireEvent.dragStart(handle, { dataTransfer })
  view.rerender(wrap(<QuantityPricingSettings active={false}/>))
  dragAt('drop', rowFor('keychains-1'), dataTransfer, 0)
  expect(displayedTierIds()).toEqual(['keychains-1', 'keychains-2'])
  expect(document.querySelector('.qp-dragging-row,.qp-drop-before,.qp-drop-after')).toBeNull()
})

test('pointer dragging works without native HTML5 drag events and cancels cleanly', async () => {
  render(<QuantityPricingSettings/>)
  await screen.findByLabelText('第1档起始数量')
  const handle = screen.getByRole('button', { name: '拖动第2档排序' })
  const target = rowFor('keychains-1')
  const capture = { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() }
  Object.assign(handle, capture)
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 700, 40))
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) })
  pointerAt('pointerDown', handle, 165)
  expect(capture.setPointerCapture).toHaveBeenCalledWith(7)
  pointerAt('pointerMove', handle, 163)
  expect(document.querySelector('.qp-dragging-row')).toBeNull()
  pointerAt('pointerMove', handle, 105)
  expect(target.classList.contains('qp-drop-before')).toBe(true)
  expect(screen.getByRole('status').textContent).toBe('松开后放到第 1 档之前。')
  pointerAt('pointerUp', handle, 105)
  expect(displayedTierIds()).toEqual(['keychains-2', 'keychains-1'])
  expect(capture.releasePointerCapture).toHaveBeenCalledWith(7)
  expect(document.querySelector('.qp-dragging-row,.qp-drop-before,.qp-drop-after')).toBeNull()
  pointerAt('pointerDown', handle, 105)
  pointerAt('pointerMove', handle, 135)
  expect(target.classList.contains('qp-drop-after')).toBe(true)
  pointerAt('pointerCancel', handle, 135)
  pointerAt('pointerUp', handle, 135)
  expect(displayedTierIds()).toEqual(['keychains-2', 'keychains-1'])
  expect(document.querySelector('.qp-dragging-row,.qp-drop-before,.qp-drop-after')).toBeNull()
  change('试算数量', '6')
  expect(screen.getByText('减价 35% · 实付 65%')).toBeTruthy()
  fireEvent.click(saveButton())
  await screen.findByText('价格阶梯已保存')
  expect(savedRequest().document.categoryRules[0].tiers.map(tier => tier.quantityTierId)).toEqual(['keychains-2', 'keychains-1'])
})
