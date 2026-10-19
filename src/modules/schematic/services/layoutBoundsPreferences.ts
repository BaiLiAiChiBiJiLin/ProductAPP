import { defaultLayoutBounds, normalizeLayoutBounds, type LayoutBounds } from '../../../model.ts'

const STORAGE_KEY = 'printflow-schematic-layout-bounds'
const BOUND_KEYS = ['top', 'left', 'right', 'bottom', 'paddingLeft', 'paddingRight'] as const

export function loadLayoutBounds(): LayoutBounds {
  const bounds = { ...defaultLayoutBounds }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const key of BOUND_KEYS) {
        const value = (saved as Partial<LayoutBounds>)[key]
        if (typeof value === 'number' && Number.isFinite(value)) bounds[key] = value
      }
    }
  } catch { /* An unavailable or invalid preference must not prevent opening the page. */ }
  return normalizeLayoutBounds(bounds)
}

/** Save only user-applied changes, never a restored review record's geometry. */
export function saveLayoutBounds(bounds: LayoutBounds): void {
  // Legacy review records render missing padding as zero. Once a user applies
  // their configuration, persist that effective value instead of treating it as
  // an older preference that should acquire the new default on the next load.
  const applied = { ...bounds, paddingLeft: bounds.paddingLeft ?? 0, paddingRight: bounds.paddingRight ?? 0 }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeLayoutBounds(applied)))
}
