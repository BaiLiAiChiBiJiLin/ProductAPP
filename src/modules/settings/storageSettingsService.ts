import { invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export type StorageSettings = { historyDirectory: string; defaultHistoryDirectory: string }

function requireDesktop() {
  if (!isTauri()) throw new Error('请在桌面软件中设置历史记录保存目录')
}

export function loadStorageSettings(): Promise<StorageSettings> {
  requireDesktop()
  return invoke('load_storage_settings')
}

export function saveStorageSettings(directory: string): Promise<StorageSettings> {
  requireDesktop()
  return invoke('save_storage_settings', { directory })
}

export async function chooseHistoryDirectory(current: string): Promise<string | null> {
  requireDesktop()
  const selected = await open({ directory: true, multiple: false, title: '选择历史记录保存目录', defaultPath: current || undefined })
  return typeof selected === 'string' ? selected : null
}
