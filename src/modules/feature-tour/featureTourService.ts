import { FEATURE_TOUR_VERSION, getFeatureTour } from './featureTourCatalog'

export { FEATURE_TOUR_VERSION }
export const FEATURE_TOUR_STORAGE_KEY = 'printflow-feature-tour-seen'

type SeenVersions = Record<string, string>
const sessionSeen = new Set<string>()
const identity = (appVersion: string, guideId: string) => JSON.stringify([appVersion, guideId])

function readSeenVersions(): SeenVersions {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    if ('schema' in saved && saved.schema === 2 && 'seen' in saved && saved.seen
      && typeof saved.seen === 'object' && !Array.isArray(saved.seen)) {
      return Object.fromEntries(Object.entries(saved.seen).filter(([, id]) => typeof id === 'string' && id.length > 0))
    }
    // Keep dismissals saved by the original single-release introduction.
    if ('version' in saved && typeof saved.version === 'string'
      && 'guideId' in saved && typeof saved.guideId === 'string') return { [saved.version]: saved.guideId }
  } catch { /* A missing or corrupt local preference must never block the editor. */ }
  return {}
}

export function hasSeenFeatureTour(appVersion = FEATURE_TOUR_VERSION, guideId = getFeatureTour(appVersion)?.id) {
  if (!guideId) return false
  return sessionSeen.has(identity(appVersion, guideId)) || readSeenVersions()[appVersion] === guideId
}

export function markFeatureTourSeen(appVersion = FEATURE_TOUR_VERSION, guideId = getFeatureTour(appVersion)?.id) {
  if (!guideId) return
  const seen = { ...readSeenVersions(), [appVersion]: guideId }
  try {
    localStorage.setItem(FEATURE_TOUR_STORAGE_KEY, JSON.stringify({ schema: 2, seen }))
  } catch {
    // A blocked/full storage still remembers dismissal during this app session.
    sessionSeen.add(identity(appVersion, guideId))
  }
}
