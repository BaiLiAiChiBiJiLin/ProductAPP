import { invoke, isTauri } from '@tauri-apps/api/core'

export type FinishLookup = ReadonlyMap<string, string>

const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
let request: Promise<FinishLookup> | undefined

export function loadFinishNames(force = false): Promise<FinishLookup> {
  if (force) request = undefined
  if (!isTauri()) return Promise.resolve(new Map<string, string>())
  request ??= invoke<Record<string, string>>('load_finish_names')
    .then(values => {
      const entries: Array<[string, string]> = Object.entries(values ?? {})
        .map(([key, value]) => [normalize(key), String(value).trim()] as [string, string])
        .filter(([, value]) => Boolean(value))
      return new Map<string, string>(entries)
    })
    .catch(error => {
      request = undefined
      throw error
    })
  return request!
}

export function finishNameFromLookup(value: unknown, lookup: FinishLookup) {
  const raw = normalize(value)
  return raw ? lookup.get(raw) ?? '' : ''
}
