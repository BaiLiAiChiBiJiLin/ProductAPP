import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import LazySvgImage from '../src/modules/schematic/components/LazySvgImage'

const mocks = vi.hoisted(() => ({ objectUrl: vi.fn((svg: string) => `blob:${svg}`) }))
vi.mock('../src/model', () => ({ svgObjectUrl: mocks.objectUrl }))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

test('a changed SVG replaces the loaded thumbnail when visible and preserves lazy loading', () => {
  const observers: { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn()
    constructor(callback: IntersectionObserverCallback) { observers.push({ callback, disconnect: this.disconnect }) }
    observe() {}
  })
  const view = render(<LazySvgImage svg="front" alt="图层缩略图"/>)
  const image = screen.getByAltText('图层缩略图')
  const intersect = (index: number, visible: boolean) => act(() => observers[index].callback(
    [{ isIntersecting: visible, target: image } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(image.hasAttribute('src')).toBe(false)
  intersect(0, false)
  expect(mocks.objectUrl).not.toHaveBeenCalled()
  intersect(0, true)
  expect(image.getAttribute('src')).toBe('blob:front')

  view.rerender(<LazySvgImage svg="back" alt="图层缩略图"/>)
  expect(observers[0].disconnect).toHaveBeenCalled()
  expect(mocks.objectUrl).toHaveBeenCalledTimes(1)
  intersect(1, false)
  expect(mocks.objectUrl).toHaveBeenCalledTimes(1)
  intersect(1, true)
  expect(image.getAttribute('src')).toBe('blob:back')
  expect(mocks.objectUrl.mock.calls.map(([svg]) => svg)).toEqual(['front', 'back'])
})

test('without IntersectionObserver rerender immediately loads the new SVG', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const view = render(<LazySvgImage svg="front" alt="图层缩略图"/>)
  expect(screen.getByAltText('图层缩略图').getAttribute('src')).toBe('blob:front')
  view.rerender(<LazySvgImage svg="back" alt="图层缩略图"/>)
  expect(screen.getByAltText('图层缩略图').getAttribute('src')).toBe('blob:back')
})
