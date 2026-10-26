import { version } from '../../../package.json'
import type { FeatureTourRelease, FeatureTourSlide } from './types'

export const FEATURE_TOUR_VERSION = version

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isSlide = (value: unknown): value is FeatureTourSlide => isRecord(value)
  && ['id', 'title', 'description', 'animation', 'poster', 'alt'].every(key => isText(value[key]))
  && Array.isArray(value.shortcuts) && value.shortcuts.every(isText)

function newestFirst(a: FeatureTourRelease, b: FeatureTourRelease) {
  const [aCore, aPrerelease = ''] = a.version.split('+')[0].split(/-(.*)/s)
  const [bCore, bPrerelease = ''] = b.version.split('+')[0].split(/-(.*)/s)
  const core = bCore.localeCompare(aCore, 'en', { numeric: true })
  if (core) return core
  if (!aPrerelease || !bPrerelease) return aPrerelease ? 1 : bPrerelease ? -1 : 0
  return bPrerelease.localeCompare(aPrerelease, 'en', { numeric: true })
}

/** A version is available only through its own complete, explicitly enabled entry. */
export function collectFeatureTours(modules: Record<string, unknown>): FeatureTourRelease[] {
  const releases: FeatureTourRelease[] = []
  for (const [path, candidate] of Object.entries(modules)) {
    const directoryVersion = /^\.\/versions\/([^/]+)\/index\.ts$/.exec(path)?.[1]
    if (!directoryVersion || !isRecord(candidate) || candidate.version !== directoryVersion
      || candidate.enabled !== true || !isText(candidate.id) || !Array.isArray(candidate.slides)
      || !candidate.slides.length || !candidate.slides.every(isSlide)) continue
    const slides = candidate.slides
    if (new Set(slides.map(slide => slide.id)).size !== slides.length) continue
    releases.push({ version: directoryVersion, id: candidate.id, enabled: true, slides })
  }
  return releases.sort(newestFirst)
}

const releases = collectFeatureTours(import.meta.glob('./versions/*/index.ts', { eager: true, import: 'default' }))

export function getFeatureTour(appVersion = FEATURE_TOUR_VERSION): FeatureTourRelease | undefined {
  return releases.find(release => release.version === appVersion)
}

export function listFeatureTours(): FeatureTourRelease[] {
  return [...releases]
}
