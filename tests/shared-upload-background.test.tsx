import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Asset, Page } from '../src/model'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), importAssets: vi.fn() }))
vi.mock('../src/services/backend', () => ({ invoke: mocks.invoke, storageMode: async () => ({ shared: true }) }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
vi.mock('../src/modules/schematic/services/uploadService', () => ({ importAssets: mocks.importAssets }))
vi.mock('../src/modules/schematic/services/productConfigService', async importOriginal => ({ ...await importOriginal<object>(), loadProductConfigs: async () => [] }))
vi.mock('../src/modules/schematic/services/finishService', () => ({ loadFinishNames: async () => ({}) }))
vi.mock('../src/modules/schematic/history/BatchHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/CustomProductForm', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/components/CorelDrawTool', () => ({ default: () => null }))
vi.mock('../src/modules/schematic/ArrangePage', () => ({ default: ({ pages }: { pages: Page[] }) => <div data-testid="arrangement-pages">{pages.length}</div> }))
vi.mock('../src/modules/schematic/components/LazySvgImage', () => ({ default: ({ alt }: { alt: string }) => <img alt={alt}/> }))

import SchematicPage from '../src/modules/schematic/SchematicPage'

const asset: Asset = { id: 'shared-asset', name: '共享测试图', productId: 'a', width: 200, height: 100, svg: '', storagePath: 'temp-assets/shared-asset.svg', thumbnailUrl: '', previewUrl: '' }

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mocks.importAssets.mockResolvedValue([asset])
  mocks.invoke.mockImplementation((command: string) => {
    if (command === 'save_batch') return new Promise(() => {})
    if (command === 'discard_temp_assets') return Promise.resolve(undefined)
    return Promise.resolve(undefined)
  })
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
})
afterEach(() => { cleanup(); localStorage.clear() })

test('shows parsed assets before shared file storage finishes', async () => {
  render(<SchematicPage />)
  fireEvent.click(screen.getByRole('button', { name: /上传 SVG 文件/ }))
  await screen.findByText('当前批次图片')
  expect(screen.getByText('共享测试图')).toBeTruthy()
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('save_batch', expect.objectContaining({ preserveTempAssets: true })))
  expect((screen.getByRole('button', { name: '保存批次' }) as HTMLButtonElement).disabled).toBe(false)
})
