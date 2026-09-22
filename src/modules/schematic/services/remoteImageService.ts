import { invoke, isTauri } from '@tauri-apps/api/core'

const cache = new Map<string, string>()
const pending = new Map<string, Promise<string>>()

export async function resolveRemoteImage(src: string) {
  if (!/^https?:\/\//i.test(src)) return src
  // Vite's development proxy keeps browser-only development on the same
  // origin. The desktop build uses the Rust command below instead.
  if (!isTauri() && typeof window !== 'undefined' && /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)) {
    return `/__printflow_remote?url=${encodeURIComponent(src)}`
  }
  if (!isTauri()) return src
  const cached = cache.get(src)
  if (cached) return cached
  const existing = pending.get(src)
  if (existing) return existing
  const request = invoke<string>('fetch_remote_image', { url: src }).then(value => {
    cache.set(src, value)
    pending.delete(src)
    return value
  }).catch(error => {
    pending.delete(src)
    throw error
  })
  pending.set(src, request)
  return request
}
