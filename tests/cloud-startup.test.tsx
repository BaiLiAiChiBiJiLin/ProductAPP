import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const api = vi.hoisted(() => ({ register: vi.fn(), mode: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('../src/services/backend', () => ({ storageMode: api.mode }))
vi.mock('../src/modules/schematic/services/sharedTransferService', () => ({ initializeSharedUser: api.register, validSharedUserName: (name: string) => Boolean(name) }))
vi.mock('../src/modules', () => ({
  orderModule: { id: 'order' }, imageEditModule: { id: 'edit' }, schematicModule: { id: 'schematic' },
  schematicReviewModule: { id: 'schematic-review' }, impositionModule: { id: 'imposition' }, progressModule: { id: 'progress' },
  SchematicReviewPage: () => null, ImpositionPage: () => null,
}))
vi.mock('../src/modules/schematic/SchematicPage', () => ({ default: () => <div>业务页面已加载</div> }))
vi.mock('../src/modules/settings/SettingsModal', () => ({ default: () => null }))
vi.mock('../src/modules/update/UpdateButton', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/services/productConfigService', () => ({ refreshProductConfigs: async () => {} }))
vi.mock('../src/modules/schematic/services/finishService', () => ({ invalidateFinishNames: () => {} }))
import App from '../src/App'

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear()
  localStorage.setItem('printflow-account-name', '旧用户名')
  api.mode.mockResolvedValue({ shared: true, environment: 'production', configPath: 'production/config.toml' })
  api.register.mockResolvedValue('shared-root')
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) })
})
afterEach(cleanup)

test('upgraded user must confirm before registration and business pages load; next launch remembers it', async () => {
  const view = render(<App />)
  await screen.findByRole('button', { name: '保存用户名' })
  expect(api.register).not.toHaveBeenCalled()
  expect(screen.queryByText('业务页面已加载')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '保存用户名' }))
  await screen.findByText('业务页面已加载')
  expect(api.register).toHaveBeenCalledWith('旧用户名')
  view.unmount()
  render(<App />)
  await screen.findByText('业务页面已加载')
  expect(screen.queryByRole('button', { name: '保存用户名' })).toBeNull()
})

test('failed registration keeps business pages blocked and does not remember confirmation', async () => {
  api.register.mockRejectedValue(new Error('连接失败'))
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: '保存用户名' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('连接失败'))
  expect(screen.queryByText('业务页面已加载')).toBeNull()
  expect(localStorage.getItem('printflow-cloud-registration-v2:production:production/config.toml')).toBeNull()
})
