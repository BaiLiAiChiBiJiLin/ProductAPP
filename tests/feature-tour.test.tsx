import { StrictMode } from 'react'
import { ConfigProvider } from 'antd'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import FeatureTour from '../src/modules/feature-tour/FeatureTour'
import * as catalog from '../src/modules/feature-tour/featureTourCatalog'
import type { FeatureTourRelease } from '../src/modules/feature-tour/types'
import { FEATURE_TOUR_STORAGE_KEY, hasSeenFeatureTour, markFeatureTourSeen } from '../src/modules/feature-tour/featureTourService'

const currentRelease = catalog.listFeatureTours()[0]
const lookupRelease = catalog.getFeatureTour

let reducedMotion = false
const mount = (props: { enabled: boolean; requestOpen?: number; onOpenChange?: (open: boolean) => void } = { enabled: true }) =>
  render(<ConfigProvider theme={{ token: { motion: false } }}><FeatureTour {...props}/></ConfigProvider>)
const next = () => fireEvent.click(screen.getByRole('button', { name: '下一项' }))
const currentImage = () => screen.getByRole('img') as HTMLImageElement
const slideAsset = (slide: FeatureTourRelease['slides'][number], prefer: 'animation' | 'poster' = 'animation') => {
  const src = currentImage().getAttribute('src') ?? ''
  const expected = prefer === 'animation' ? slide.animation : slide.poster
  expect(src).toContain(expected)
}

beforeEach(() => {
  localStorage.removeItem(FEATURE_TOUR_STORAGE_KEY)
  vi.spyOn(catalog, 'getFeatureTour').mockImplementation(version => version === undefined ? currentRelease : lookupRelease(version))
  reducedMotion = false
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(query => ({ matches: query.includes('prefers-reduced-motion') && reducedMotion,
    media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('shows each individual demonstration and only completes on the last page', async () => {
  const onOpenChange = vi.fn()
  mount({ enabled: true, onOpenChange })
  await screen.findByRole('heading', { name: currentRelease.slides[0].title })
  slideAsset(currentRelease.slides[0])
  expect(screen.getAllByRole('img')).toHaveLength(1)
  expect((screen.getByRole('button', { name: '上一项' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: '开始使用' })).toBeNull()
  expect(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)).toBeNull()
  for (let index = 1; index < currentRelease.slides.length; index += 1) {
    next()
    expect(screen.getByRole('heading', { name: currentRelease.slides[index].title })).toBeTruthy()
    slideAsset(currentRelease.slides[index])
  }
  expect(screen.getAllByRole('img')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: '下一项' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '开始使用' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(JSON.parse(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)!)).toEqual({ schema: 2, seen: { [currentRelease.version]: currentRelease.id } })
  expect(onOpenChange).toHaveBeenLastCalledWith(false)
})

test('supports direct slide selection, previous and keyboard arrows without auto-advancing', async () => {
  mount()
  await screen.findByRole('dialog')
  const targetIndex = Math.min(2, currentRelease.slides.length - 1)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^查看第 ${targetIndex + 1} 项`) }))
  slideAsset(currentRelease.slides[targetIndex])
  fireEvent.click(screen.getByRole('button', { name: '上一项' }))
  slideAsset(currentRelease.slides[targetIndex - 1])
  fireEvent.keyDown(screen.getByLabelText('新功能轮播'), { key: 'ArrowRight' })
  slideAsset(currentRelease.slides[targetIndex])
  fireEvent.keyDown(screen.getByLabelText('新功能轮播'), { key: 'ArrowLeft' })
  slideAsset(currentRelease.slides[targetIndex - 1])
  expect(screen.getByRole('button', { name: new RegExp(`^查看第 ${targetIndex} 项`) }).getAttribute('aria-current')).toBe('step')
  expect(hasSeenFeatureTour(currentRelease.version, currentRelease.id)).toBe(false)
})

test.each(['skip', 'close', 'escape'])('%s can dismiss before the last slide and keeps this version dismissed after remount', async action => {
  const view = mount()
  await screen.findByRole('dialog')
  if (action === 'skip') fireEvent.click(screen.getByRole('button', { name: '跳过介绍' }))
  else if (action === 'close') fireEvent.click(screen.getByLabelText('关闭新功能介绍'))
  else fireEvent.keyDown(document.querySelector('.feature-tour')!.closest('.ant-modal-wrap')!, { key: 'Escape', keyCode: 27, which: 27 })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(hasSeenFeatureTour(currentRelease.version, currentRelease.id)).toBe(true)
  view.unmount()
  mount()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('shows a different app version once and permits a manual replay of the current version', async () => {
  markFeatureTourSeen('0.0.0-before-update', 'previous-guide')
  const view = mount()
  await screen.findByRole('dialog')
  fireEvent.click(screen.getByRole('button', { name: '跳过介绍' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  view.rerender(<ConfigProvider theme={{ token: { motion: false } }}><FeatureTour enabled requestOpen={1}/></ConfigProvider>)
  await screen.findByRole('heading', { name: currentRelease.slides[0].title })
  expect(hasSeenFeatureTour(currentRelease.version, currentRelease.id)).toBe(true)
})

test('waits for other dialogs and resumes the same slide without recording a false dismissal', async () => {
  const onOpenChange = vi.fn()
  const view = mount({ enabled: false, onOpenChange })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(hasSeenFeatureTour(currentRelease.version, currentRelease.id)).toBe(false)
  view.rerender(<ConfigProvider theme={{ token: { motion: false } }}><FeatureTour enabled onOpenChange={onOpenChange}/></ConfigProvider>)
  await screen.findByRole('dialog')
  next()
  view.rerender(<ConfigProvider theme={{ token: { motion: false } }}><FeatureTour enabled={false} onOpenChange={onOpenChange}/></ConfigProvider>)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('img')).toBeNull()
  expect(hasSeenFeatureTour(currentRelease.version, currentRelease.id)).toBe(false)
  expect(onOpenChange).toHaveBeenLastCalledWith(false)
  view.rerender(<ConfigProvider theme={{ token: { motion: false } }}><FeatureTour enabled onOpenChange={onOpenChange}/></ConfigProvider>)
  await screen.findByRole('heading', { name: currentRelease.slides[1]?.title ?? currentRelease.slides[0].title })
  expect(onOpenChange).toHaveBeenLastCalledWith(true)
})

test('queues a manual replay request until enabled and remains stable in StrictMode', async () => {
  markFeatureTourSeen(currentRelease.version, currentRelease.id)
  const view = render(<StrictMode><ConfigProvider theme={{ token: { motion: false } }}><FeatureTour enabled={false} requestOpen={1}/></ConfigProvider></StrictMode>)
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(<StrictMode><ConfigProvider theme={{ token: { motion: false } }}><FeatureTour enabled requestOpen={1}/></ConfigProvider></StrictMode>)
  await screen.findByRole('dialog')
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '跳过介绍' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  view.rerender(<StrictMode><ConfigProvider theme={{ token: { motion: false } }}><FeatureTour enabled requestOpen={1}/></ConfigProvider></StrictMode>)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('reduced motion defaults to a static poster and preserves static-only introductions', async () => {
  reducedMotion = true
  mount()
  await screen.findByRole('dialog')
  slideAsset(currentRelease.slides[0], 'poster')
  if (currentRelease.slides[0].animation === currentRelease.slides[0].poster) {
    expect(screen.queryByRole('button', { name: '播放演示' })).toBeNull()
  } else {
    fireEvent.click(screen.getByRole('button', { name: '播放演示' }))
    slideAsset(currentRelease.slides[0], 'animation')
    fireEvent.click(screen.getByRole('button', { name: '停止播放' }))
    slideAsset(currentRelease.slides[0], 'poster')
  }
  next()
  slideAsset(currentRelease.slides[1], 'poster')
})

test('unavailable animation falls back to its poster while all navigation remains available', async () => {
  mount()
  await screen.findByRole('dialog')
  if (currentRelease.slides[0].animation !== currentRelease.slides[0].poster) {
    fireEvent.error(currentImage())
    slideAsset(currentRelease.slides[0], 'poster')
    expect((screen.getByRole('button', { name: '演示暂不可用' }) as HTMLButtonElement).disabled).toBe(true)
  } else {
    expect(screen.queryByRole('button', { name: '播放演示' })).toBeNull()
  }
  next()
  slideAsset(currentRelease.slides[1])
})

test('corrupt storage is ignored and unavailable storage still remembers a dismissal for the session', () => {
  localStorage.setItem(FEATURE_TOUR_STORAGE_KEY, '{invalid')
  expect(hasSeenFeatureTour(currentRelease.version, currentRelease.id)).toBe(false)
  const fail = () => { throw new DOMException('Storage unavailable', 'SecurityError') }
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(fail)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(fail)
  expect(hasSeenFeatureTour('session-fallback', 'fallback-guide')).toBe(false)
  expect(() => markFeatureTourSeen('session-fallback', 'fallback-guide')).not.toThrow()
  expect(hasSeenFeatureTour('session-fallback', 'fallback-guide')).toBe(true)
})

test('clicking the backdrop does not dismiss or record this introduction as seen', async () => {
  const onOpenChange = vi.fn()
  mount({ enabled: true, onOpenChange })
  await screen.findByRole('dialog')
  const wrap = document.querySelector('.feature-tour')!.closest('.ant-modal-wrap')!
  fireEvent.mouseDown(wrap)
  fireEvent.mouseUp(wrap)
  fireEvent.click(wrap)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('heading', { name: currentRelease.slides[0].title })).toBeTruthy()
  expect(hasSeenFeatureTour(currentRelease.version, currentRelease.id)).toBe(false)
  expect(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)).toBeNull()
  expect(onOpenChange).toHaveBeenLastCalledWith(true)
})

test('a release without an introduction does not automatically open an archived introduction', () => {
  vi.spyOn(catalog, 'getFeatureTour').mockReturnValue(undefined)
  const onOpenChange = vi.fn()
  mount({ enabled: true, onOpenChange })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('img')).toBeNull()
  expect(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)).toBeNull()
  expect(onOpenChange).toHaveBeenLastCalledWith(false)
})

test('an explicit menu request can open archived introductions when the current release has none', async () => {
  vi.spyOn(catalog, 'getFeatureTour').mockReturnValue(undefined)
  const view = mount()
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(<ConfigProvider theme={{ token: { motion: false } }}><FeatureTour enabled requestOpen={1}/></ConfigProvider>)
  await screen.findByRole('heading', { name: currentRelease.slides[0].title })
  expect((screen.getByRole('combobox', { name: '介绍版本' }) as HTMLSelectElement).value).toBe(currentRelease.version)
  fireEvent.click(screen.getByLabelText('关闭新功能介绍'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(hasSeenFeatureTour(currentRelease.version, currentRelease.id)).toBe(true)
  expect(hasSeenFeatureTour()).toBe(false)
})

test('switching archived versions resets slides and preserves independent seen records', async () => {
  const archived: FeatureTourRelease = { ...currentRelease, version: '0.0.1', id: 'archived-guide', slides: [
    { ...currentRelease.slides[0], id: 'archive-demo', title: '历史功能演示', animation: '/archive.gif', poster: '/archive.png' },
  ] }
  vi.spyOn(catalog, 'listFeatureTours').mockReturnValue([currentRelease, archived])
  mount()
  await screen.findByRole('dialog')
  next()
  fireEvent.change(screen.getByRole('combobox', { name: '介绍版本' }), { target: { value: archived.version } })
  expect(screen.getByRole('heading', { name: '历史功能演示' })).toBeTruthy()
  expect(currentImage().getAttribute('src')).toBe('/archive.gif')
  expect(screen.queryByRole('button', { name: '下一项' })).toBeNull()
  expect(screen.getByRole('button', { name: '开始使用' })).toBeTruthy()
  expect(hasSeenFeatureTour(currentRelease.version, currentRelease.id)).toBe(true)
  expect(hasSeenFeatureTour(archived.version, archived.id)).toBe(false)
  fireEvent.change(screen.getByRole('combobox', { name: '介绍版本' }), { target: { value: currentRelease.version } })
  expect(screen.getByRole('heading', { name: currentRelease.slides[0].title })).toBeTruthy()
  expect(hasSeenFeatureTour(archived.version, archived.id)).toBe(true)
  fireEvent.click(screen.getByLabelText('关闭新功能介绍'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(JSON.parse(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)!)).toEqual({ schema: 2, seen: {
    [currentRelease.version]: currentRelease.id, [archived.version]: archived.id,
  } })
})

test('an empty archive stays closed even for an explicit menu request', () => {
  vi.spyOn(catalog, 'getFeatureTour').mockReturnValue(undefined)
  vi.spyOn(catalog, 'listFeatureTours').mockReturnValue([])
  mount({ enabled: true, requestOpen: 1 })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)).toBeNull()
})
