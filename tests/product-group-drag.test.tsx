import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Asset } from '../src/model'
import ProductGroupGuide from '../src/modules/schematic/grouping/ProductGroupGuide'
import { ProductGroupingContext, useProductGrouping } from '../src/modules/schematic/grouping/useProductGrouping'
import { readGroupAssetEditor } from '../src/modules/schematic/grouping/productGrouping'
import { normalizeProductConfigs } from '../src/modules/schematic/services/productConfigService'

vi.mock('../src/modules/schematic/components/LazySvgImage', () => ({ default: ({ alt }: { alt: string }) => <img alt={alt}/> }))

beforeEach(() => {
  class Pointer extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1 }
  }
  vi.stubGlobal('PointerEvent', Pointer)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const siblings = [...this.parentElement?.querySelectorAll('[data-group-member-id]') ?? []]
    const x = siblings.indexOf(this) * 84
    return new DOMRect(x, 80, 76, 110)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount(title: string, manual = true) {
  const products = normalizeProductConfigs([{ productId: 'p', title, productOptions: [{ name: 'Count', labelZh: '立牌数量', values: ['1', '2'] }] }])
  const initial: Asset[] = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id, productId: title ? 'p' : '', attributes: { Count: '2' }, width: 20, height: 20, svg: '<svg/>', previewUrl: '', thumbnailUrl: '' }))
  const save = vi.fn()
  function Harness() {
    const [assets, setAssets] = useState(initial)
    const grouping = useProductGrouping({ assets, products, activate: () => {}, revealAll: () => {}, save: async next => {
      // Simulate the persistence boundary, then reopen the saved data through
      // the production restore hook, not through a separate test reorder.
      const saved = JSON.parse(JSON.stringify(next)) as Asset[]
      save(saved); setAssets(saved)
    } })
    return <ProductGroupingContext.Provider value={grouping}>
      <button onClick={() => grouping.start(readGroupAssetEditor(assets[0]), assets.map(asset => asset.id), manual)}>开始</button>
      <button onClick={() => void grouping.persist(true)}>确认</button>
      <button onClick={() => grouping.resumeGroup('a')}>重新编辑</button>
      <ProductGroupGuide assets={assets}/>
    </ProductGroupingContext.Provider>
  }
  render(<Harness/>); fireEvent.click(screen.getByText('开始'))
  return save
}

const buttons = () => screen.getAllByRole('button', { name: /^编辑组内图片 / })
const order = () => buttons().map(button => button.getAttribute('aria-label')!.replace('编辑组内图片 ', ''))
function drag(fromIndex: number, toIndex: number, cancel = false) {
  const source = buttons()[fromIndex]
  fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: fromIndex * 84 + 20, clientY: 100 })
  fireEvent.pointerMove(source, { pointerId: 1, clientX: toIndex * 84 + 20, clientY: 100 })
  if (cancel) fireEvent.pointerCancel(source, { pointerId: 1, clientX: toIndex * 84 + 20, clientY: 100 })
  else fireEvent.pointerUp(source, { pointerId: 1, clientX: toIndex * 84 + 20, clientY: 100 })
}

test.each(['', '普通钥匙扣'])('free group %s can drag, save and reopen its order without fixed slots', async title => {
  const save = mount(title)
  expect(screen.queryByText('Example', { exact: true })).toBeNull()
  expect(screen.queryByRole('button', { name: /^置\s*空$/ })).toBeNull()
  drag(0, 2)
  expect(order()).toEqual(['b', 'c', 'a', 'd', 'e'])
  fireEvent.click(screen.getByText('确认', { exact: true }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(save.mock.calls[0][0].map((asset: Asset) => asset.productGroupPosition)).toEqual([3, 1, 2, 4, 5])
  fireEvent.click(screen.getByText('重新编辑'))
  expect(order()).toEqual(['b', 'c', 'a', 'd', 'e'])
})

test.each(['Custom Shaker', 'Photocard Holders'])('%s keeps its fixed positions and optional empty Example while dragging', title => {
  mount(title)
  drag(0, 2)
  expect(order()).toEqual(['b', 'c', 'a', 'd', 'e'])
  for (const [index, label] of ['Example', 'Front', 'inside', 'Back'].entries()) expect(buttons()[index].textContent).toContain(label)
  expect(buttons()[4].textContent).not.toMatch(/Example|Front|inside|Back/)
  fireEvent.click(screen.getByRole('button', { name: /^置\s*空$/ }))
  expect(buttons()[0].textContent).toContain('Front')
  expect(screen.getByText('空占位')).toBeTruthy()
  drag(2, 0)
  expect(order()).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(buttons()[0].textContent).toContain('Front')
  fireEvent.click(screen.getByText('取消置空', { exact: true }))
  expect(buttons()[0].textContent).toContain('Example')
})

test('automatic standee combinations also allow simple reordering', () => {
  mount('Clear Acrylic Standees', false)
  expect(screen.queryByText('Example', { exact: true })).toBeNull()
  drag(3, 1)
  expect(order()).toEqual(['a', 'd', 'b', 'c', 'e'])
})

test('cancelled drag keeps order and a simple thumbnail click still selects an editor', async () => {
  mount('普通钥匙扣')
  drag(0, 2, true)
  expect(order()).toEqual(['a', 'b', 'c', 'd', 'e'])
  await new Promise(resolve => setTimeout(resolve, 5))
  fireEvent.click(buttons()[1])
  expect(buttons()[1].getAttribute('aria-pressed')).toBe('true')
  expect(order()).toEqual(['a', 'b', 'c', 'd', 'e'])
})
