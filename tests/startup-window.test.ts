import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const native = vi.hoisted(() => ({ show: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ show: native.show }) }))
vi.mock('../src/main.tsx', () => ({}))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  native.show.mockClear()
  document.body.innerHTML = '<div id="startup-screen"><span id="startup-message"></span><button id="startup-retry" hidden></button></div>'
  // A hidden WebView may receive no animation frames at all.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
})

afterEach(() => {
  window.dispatchEvent(new Event('printflow-ui-ready'))
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('creates a visible native window even when frontend modules have not loaded', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
  const main = config.app.windows.find((window: { label?: string }) => !window.label || window.label === 'main')
  expect(main.visible).not.toBe(false)
  expect(main.backgroundColor).toBe('#f5f7fb')
})

it('does not wait for hidden WebView paint callbacks to request visibility', async () => {
  await import('../src/startup')
  expect(native.show).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(1)
})

it('keeps the loading failure visible and removes the splash when the app is ready', async () => {
  await import('../src/startup')
  vi.advanceTimersByTime(30000)
  expect(document.getElementById('startup-retry')!.hidden).toBe(false)
  expect(document.getElementById('startup-message')!.textContent).toContain('启动未完成')
  expect(native.show).toHaveBeenCalled()
  window.dispatchEvent(new Event('printflow-ui-ready'))
  vi.advanceTimersByTime(200)
  expect(document.getElementById('startup-screen')).toBeNull()
})
