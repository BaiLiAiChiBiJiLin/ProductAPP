import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigProvider } from 'antd'

const api = vi.hoisted(() => ({ check: vi.fn(), register: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('../src/services/backend', () => ({ storageMode: async () => ({ shared: true, environment: 'production', configPath: 'tour-test' }) }))
vi.mock('../src/modules/schematic/services/sharedTransferService', () => ({ initializeSharedUser: api.register, validSharedUserName: (name: string) => Boolean(name) }))
vi.mock('../src/modules', () => ({
  orderModule: { id: 'order', label: '订单' }, imageEditModule: { id: 'edit', label: '图片编辑' }, schematicModule: { id: 'schematic', label: '示意图' },
  schematicReviewModule: { id: 'schematic-review', label: '审核' }, impositionModule: { id: 'imposition', label: '拼版' }, progressModule: { id: 'progress', label: '进度' },
  SchematicReviewPage: () => null, ImpositionPage: () => null,
}))
vi.mock('../src/modules/schematic/SchematicPage', () => ({ default: () => <div>编辑器已准备好</div> }))
vi.mock('../src/modules/settings/SettingsModal', () => ({ default: () => null }))
vi.mock('../src/modules/update/updateService', () => ({ checkForUpdate: api.check, downloadAndInstallUpdate: vi.fn() }))
vi.mock('../src/modules/schematic/services/productConfigService', () => ({ refreshProductConfigs: async () => {} }))
vi.mock('../src/modules/schematic/services/finishService', () => ({ invalidateFinishNames: () => {} }))
import App from '../src/App'
import { FEATURE_TOUR_STORAGE_KEY } from '../src/modules/feature-tour/featureTourService'
import * as catalog from '../src/modules/feature-tour/featureTourCatalog'

const introductionFixture = catalog.listFeatureTours()[0]
const lookupRelease = catalog.getFeatureTour

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear()
  vi.spyOn(catalog, 'getFeatureTour').mockImplementation(version => version === undefined ? introductionFixture : lookupRelease(version))
  localStorage.setItem('printflow-account-name', '演示用户')
  api.register.mockResolvedValue('shared-root')
  api.check.mockResolvedValue({ version: '0.1.99', currentVersion: '0.1.32', body: '测试更新' })
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) })
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('registration, introduction and updater appear in sequence, and the user menu can replay the introduction', async () => {
  render(<ConfigProvider theme={{ token: { motion: false } }}><App/></ConfigProvider>)
  await screen.findByRole('button', { name: '保存用户名' })
  expect(screen.queryByRole('heading', { name: '块缩放，让布局更合适' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '保存用户名' }))
  await screen.findByRole('heading', { name: '块缩放，让布局更合适' })
  await new Promise(resolve => setTimeout(resolve, 1400))
  expect(api.check).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '跳过介绍' }))
  await screen.findByRole('button', { name: '下载并安装' }, { timeout: 2500 })
  expect(api.check).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '块缩放，让布局更合适' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '稍后更新' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '下载并安装' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: /演示用户/ }))
  fireEvent.click(await screen.findByRole('button', { name: '新功能介绍', exact: true }))
  await screen.findByRole('heading', { name: '块缩放，让布局更合适' })
  fireEvent.click(screen.getByRole('button', { name: '跳过介绍' }))
  await waitFor(() => expect(screen.queryByRole('heading', { name: '块缩放，让布局更合适' })).toBeNull())
  expect(api.check).toHaveBeenCalledTimes(1)
}, 15000)

test('a release with no introductions skips the modal and hides the empty archive menu entry', async () => {
  vi.spyOn(catalog, 'getFeatureTour').mockReturnValue(undefined)
  vi.spyOn(catalog, 'listFeatureTours').mockReturnValue([])
  render(<ConfigProvider theme={{ token: { motion: false } }}><App/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '保存用户名' }))
  await screen.findByRole('button', { name: '下载并安装' }, { timeout: 2500 })
  expect(screen.queryByRole('heading', { name: '块缩放，让布局更合适' })).toBeNull()
  expect(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '稍后更新' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '下载并安装' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: /演示用户/ }))
  await screen.findByRole('button', { name: '设置', exact: true })
  expect(screen.queryByRole('button', { name: '新功能介绍', exact: true })).toBeNull()
}, 15000)
