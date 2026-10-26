import { invoke, isTauri } from '@tauri-apps/api/core'

export type LayoutConfig = {
  plateHeight: number
  plateWidth: number
  effectiveHeight: number
  effectiveWidth: number
  effectiveRight: number
  spacing: number
  holeSize: number
  holeCount: number
  holeGap: number
  holeLeft: number
}

export type LayoutPresetConfig = Omit<LayoutConfig, 'spacing'>
export type LayoutPreset = { id: string; name: string; config: LayoutPresetConfig; version: number }
export type LayoutPresetInput = { id?: string; name: string; config: LayoutPresetConfig; version?: number }
export type LayoutPresetSnapshot = { presets: LayoutPreset[]; canManage: boolean; preview?: boolean }
export const LAYOUT_PRESET_STORAGE_KEY = 'printflow.imposition.layout-preset.v1'
export const IMPOSITION_SPACING_STORAGE_KEY = 'printflow.imposition.spacing.v1'
export const DEFAULT_IMPOSITION_SPACING = 3
export const DEFAULT_PRESET_LAYOUT: LayoutPresetConfig = { plateHeight: 464, plateWidth: 300, effectiveHeight: 440, effectiveWidth: 285, effectiveRight: 5, holeSize: 3, holeCount: 2, holeGap: 203.468, holeLeft: 4 }
export const DEFAULT_LAYOUT: LayoutConfig = { ...DEFAULT_PRESET_LAYOUT, spacing: DEFAULT_IMPOSITION_SPACING }
export const DEFAULT_LAYOUT_PRESETS: LayoutPreset[] = [
  { id: 'large', name: '大版', config: DEFAULT_PRESET_LAYOUT, version: 1 },
  { id: 'small', name: '小版', config: { ...DEFAULT_PRESET_LAYOUT, effectiveHeight: 380, effectiveWidth: 285 }, version: 1 },
]

export function validateLayoutConfig(config: LayoutPresetConfig): string | undefined {
  if (Object.values(config).some(value => !Number.isFinite(value))) return '版面参数必须是有效数字。'
  if (config.plateHeight <= 0 || config.plateWidth <= 0 || config.effectiveHeight <= 0 || config.effectiveWidth <= 0) return '板材和有效区域的宽高必须大于 0。'
  if ([config.effectiveRight, config.holeSize, config.holeCount, config.holeGap, config.holeLeft].some(value => value < 0)) return '孔间距、孔径和边距不能小于 0。'
  if (config.effectiveHeight > config.plateHeight || config.effectiveWidth + config.effectiveRight > config.plateWidth) return '有效区域不能超出板材范围。'
  if (!Number.isInteger(config.holeCount)) return '版面孔数量必须为整数。'
  return undefined
}

function presetOnly(config: LayoutPresetConfig): LayoutPresetConfig {
  const normalized: Partial<LayoutConfig> = { ...config }
  // Old persisted presets may still contain spacing. It must never override
  // the current workspace spacing or be sent back when editing a preset.
  delete normalized.spacing
  return normalized as LayoutPresetConfig
}

function validateSnapshot(snapshot: LayoutPresetSnapshot): LayoutPresetSnapshot {
  if (!snapshot?.presets?.length || snapshot.presets.some(preset => !preset.id || !preset.name || !preset.config)) throw new Error('版面配置数据无效，请重试或联系管理员。')
  const presets = snapshot.presets.map(preset => ({ ...preset, config: presetOnly(preset.config) }))
  if (presets.some(preset => validateLayoutConfig(preset.config))) throw new Error('版面配置数据无效，请重试或联系管理员。')
  return { ...snapshot, presets }
}

export async function listLayoutPresets(): Promise<LayoutPresetSnapshot> {
  if (!isTauri()) return { presets: DEFAULT_LAYOUT_PRESETS, canManage: false, preview: true }
  return validateSnapshot(await invoke<LayoutPresetSnapshot>('list_imposition_layout_presets'))
}

export async function saveLayoutPreset(preset: LayoutPresetInput): Promise<LayoutPresetSnapshot> {
  if (!isTauri()) throw new Error('浏览器预览无法保存版面配置，请在桌面程序中操作。')
  return validateSnapshot(await invoke<LayoutPresetSnapshot>('save_imposition_layout_preset', { preset: { ...preset, config: presetOnly(preset.config) } }))
}

export async function deleteLayoutPreset(id: string, version: number): Promise<LayoutPresetSnapshot> {
  if (!isTauri()) throw new Error('浏览器预览无法删除版面配置，请在桌面程序中操作。')
  return validateSnapshot(await invoke<LayoutPresetSnapshot>('delete_imposition_layout_preset', { id, version }))
}
