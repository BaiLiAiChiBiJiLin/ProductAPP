import type { StorageMode } from './backend'

function key(mode: StorageMode): string {
  return `printflow-cloud-registration-v2:${mode.environment}:${mode.configPath}`
}

export function needsCloudRegistration(mode: StorageMode, name: string): boolean {
  return mode.shared && (!name || localStorage.getItem(key(mode)) !== name)
}

export function confirmCloudRegistration(mode: StorageMode, name: string): void {
  if (mode.shared) localStorage.setItem(key(mode), name)
}
