import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import ImpositionLayoutPresets from '../src/modules/imposition/ImpositionLayoutPresets'
import { useImpositionLayoutPresets } from '../src/modules/imposition/useImpositionLayoutPresets'
import { DEFAULT_LAYOUT_PRESETS, LAYOUT_PRESET_STORAGE_KEY, type LayoutPreset, type LayoutPresetSnapshot } from '../src/modules/imposition/layoutPresetStore'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => mocks.native }))

function Harness() {
  const state = useImpositionLayoutPresets()
  return <ConfigProvider theme={{ token: { motion: false } }}><ImpositionLayoutPresets state={state}/><button disabled={!state.ready}>计算测试</button><output data-testid="layout">{JSON.stringify(state.layout)}</output></ConfigProvider>
}
const layout = () => JSON.parse(screen.getByTestId('layout').textContent!)
async function expand() {
  fireEvent.click(screen.getByRole('button', { name: '展开版面配置' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '选择大版' }) as HTMLButtonElement).disabled).toBe(false))
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.native = true
  localStorage.removeItem(LAYOUT_PRESET_STORAGE_KEY)
  mocks.invoke.mockImplementation(async command => {
    if (command === 'list_imposition_layout_presets') return { presets: DEFAULT_LAYOUT_PRESETS, canManage: true }
  })
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('allows production selection and keyboard-focus details while hiding all management controls', async () => {
  vi.stubEnv('DEV', false)
  render(<Harness/>)
  await expand()
  expect(mocks.invoke).toHaveBeenCalledWith('list_imposition_layout_presets')
  expect(screen.queryByRole('button', { name: '新增版面配置' })).toBeNull()
  expect(screen.queryByRole('button', { name: '编辑版面配置' })).toBeNull()
  expect(screen.queryByRole('button', { name: '删除版面配置' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '选择小版' }))
  expect(layout()).toMatchObject({ effectiveHeight: 380, effectiveWidth: 285, spacing: 8, plateHeight: 464, plateWidth: 300, holeGap: 203.468 })
  expect(localStorage.getItem(LAYOUT_PRESET_STORAGE_KEY)).toBe('small')
  fireEvent.focus(screen.getByRole('button', { name: '选择小版' }))
  const tooltip = await screen.findByRole('tooltip')
  expect(within(tooltip).getByText('380 mm')).toBeTruthy()
  expect(within(tooltip).getByText('203.468 mm')).toBeTruthy()
  expect(within(tooltip).getByText('上孔', { exact: false })).toBeTruthy()
})

it('waits for loaded configurations, blocks calculation on failure and retries without using stale defaults', async () => {
  let finish!: (value: LayoutPresetSnapshot) => void
  mocks.invoke.mockRejectedValueOnce(new Error('数据库未连接'))
  render(<Harness/>)
  expect((screen.getByRole('button', { name: '计算测试' }) as HTMLButtonElement).disabled).toBe(true)
  await screen.findByText('配置加载失败')
  expect((screen.getByRole('button', { name: '计算测试' }) as HTMLButtonElement).disabled).toBe(true)
  mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect((screen.getByRole('button', { name: '计算测试' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => finish({ presets: DEFAULT_LAYOUT_PRESETS, canManage: false }))
  expect((screen.getByRole('button', { name: '计算测试' }) as HTMLButtonElement).disabled).toBe(false)
  await expand()
  expect(screen.queryByRole('button', { name: '编辑版面配置' })).toBeNull()
})

it('retains the selected configuration and editing draft on failed save, then applies only the saved response', async () => {
  render(<Harness/>)
  await expand()
  fireEvent.click(screen.getByRole('button', { name: '编辑版面配置' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByRole('spinbutton', { name: '图片间距' }), { target: { value: '6' } })
  mocks.invoke.mockRejectedValueOnce(new Error('版本已更新'))
  fireEvent.click(within(dialog).getByRole('button', { name: '保 存' }))
  await within(dialog).findByText('保存失败：版本已更新')
  expect(layout().spacing).toBe(3)
  expect((within(dialog).getByRole('spinbutton', { name: '图片间距' }) as HTMLInputElement).value).toBe('6.000')
  let finish!: (value: LayoutPresetSnapshot) => void
  mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(within(dialog).getByRole('button', { name: '保 存' }))
  expect((screen.getByRole('button', { name: '计算测试' }) as HTMLButtonElement).disabled).toBe(true)
  expect(mocks.invoke).toHaveBeenLastCalledWith('save_imposition_layout_preset', { preset: { ...DEFAULT_LAYOUT_PRESETS[0], config: { ...DEFAULT_LAYOUT_PRESETS[0].config, spacing: 6 } } })
  await act(async () => finish({ presets: DEFAULT_LAYOUT_PRESETS.map(preset => preset.id === 'large' ? { ...preset, config: { ...preset.config, spacing: 6 }, version: 2 } : preset), canManage: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(layout().spacing).toBe(6)
})

it('creates a preset with a separate draft and falls back to large after deleting the selected preset', async () => {
  let presets = DEFAULT_LAYOUT_PRESETS.map(preset => ({ ...preset }))
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'save_imposition_layout_preset') presets = [...presets, { ...args.preset, id: 'custom', version: 1 } as LayoutPreset]
    if (command === 'delete_imposition_layout_preset') presets = presets.filter(preset => preset.id !== args.id)
    return { presets, canManage: true }
  })
  render(<Harness/>)
  await expand()
  fireEvent.click(screen.getByRole('button', { name: '新增版面配置' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByRole('textbox', { name: '版面名称' }), { target: { value: '测试版' } })
  fireEvent.change(within(dialog).getByRole('spinbutton', { name: '有效高' }), { target: { value: '400' } })
  expect(layout().effectiveHeight).toBe(440)
  fireEvent.click(within(dialog).getByRole('button', { name: '保 存' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('button', { name: '选择测试版' }).getAttribute('aria-pressed')).toBe('true')
  expect(layout().effectiveHeight).toBe(400)
  fireEvent.click(screen.getByRole('button', { name: '删除版面配置' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认删除版面配置' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '选择测试版' })).toBeNull())
  expect(mocks.invoke).toHaveBeenCalledWith('delete_imposition_layout_preset', { id: 'custom', version: 1 })
  expect(layout().effectiveHeight).toBe(440)
})

it('restores a saved choice and clearly marks non-native mode as a read-only preview', async () => {
  mocks.native = false
  localStorage.setItem(LAYOUT_PRESET_STORAGE_KEY, 'small')
  render(<Harness/>)
  await screen.findByText('浏览器预览 · 默认配置')
  await expand()
  expect(layout().spacing).toBe(8)
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '编辑版面配置' })).toBeNull()
})
