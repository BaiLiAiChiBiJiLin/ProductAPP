import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as catalog from '../src/modules/feature-tour/featureTourCatalog'
import type { FeatureTourRelease } from '../src/modules/feature-tour/types'
import { FEATURE_TOUR_STORAGE_KEY, hasSeenFeatureTour, markFeatureTourSeen } from '../src/modules/feature-tour/featureTourService'

function release(version = '1.2.3'): FeatureTourRelease {
  return { version, id: `guide-${version}`, enabled: true, slides: [{
    id: 'demo', title: '功能演示', description: '操作说明', shortcuts: ['拖动'], animation: './demo.gif', poster: './demo.png', alt: '功能操作示意',
  }] }
}
const entry = (value: FeatureTourRelease) => [`./versions/${value.version}/index.ts`, value] as const

beforeEach(() => localStorage.removeItem(FEATURE_TOUR_STORAGE_KEY))
afterEach(() => vi.restoreAllMocks())

test('the version directory is the registry and listed versions use numeric descending order', () => {
  const versions = ['1.2.3', '1.10.0', '1.2.10'].map(release)
  const result = catalog.collectFeatureTours(Object.fromEntries(versions.map(entry)))
  expect(result.map(item => item.version)).toEqual(['1.10.0', '1.2.10', '1.2.3'])
  expect(result.find(item => item.version === '1.2.3')).toEqual(versions[0])
  expect(catalog.collectFeatureTours({})).toEqual([])
})

test('disabled, empty, incomplete or incorrectly named releases are not available for presentation', () => {
  const valid = release()
  const invalid = {
    './versions/1.0.0/index.ts': { ...release('1.0.0'), enabled: false },
    './versions/1.0.1/index.ts': { ...release('1.0.1'), slides: [] },
    './versions/1.0.2/index.ts': { ...release('1.0.2'), slides: [{ ...valid.slides[0], animation: '' }] },
    './versions/1.0.3/index.ts': release('1.0.4'),
    './versions/1.0.5/index.ts': { ...release('1.0.5'), slides: [valid.slides[0], valid.slides[0]] },
    './versions/1.0.6/index.ts': { ...release('1.0.6'), slides: [{ ...valid.slides[0], shortcuts: 'invalid' }] },
    './versions/1.0.7/index.ts': undefined,
  }
  expect(catalog.collectFeatureTours(invalid)).toEqual([])
  expect(catalog.collectFeatureTours({ ...invalid, [entry(valid)[0]]: valid })).toEqual([valid])
})

test('the packaged introduction uses its own version and no unregistered version falls back to it', () => {
  const versions = catalog.listFeatureTours()
  expect(versions.length).toBeGreaterThan(0)
  for (const introduction of versions) {
    expect(catalog.getFeatureTour(introduction.version)).toBe(introduction)
    expect(introduction.enabled).toBe(true)
    expect(introduction.slides.length).toBeGreaterThan(0)
  }
  expect(catalog.getFeatureTour('unregistered-release')).toBeUndefined()
})

test('seen records retain each version and guide identity independently', () => {
  markFeatureTourSeen('1.2.3', 'guide-a')
  markFeatureTourSeen('1.2.4', 'guide-b')
  expect(hasSeenFeatureTour('1.2.3', 'guide-a')).toBe(true)
  expect(hasSeenFeatureTour('1.2.4', 'guide-b')).toBe(true)
  expect(hasSeenFeatureTour('1.2.4', 'revised-guide')).toBe(false)
  expect(JSON.parse(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)!)).toEqual({ schema: 2, seen: { '1.2.3': 'guide-a', '1.2.4': 'guide-b' } })
})

test('legacy single-version records are recognized and merged when another introduction is dismissed', () => {
  localStorage.setItem(FEATURE_TOUR_STORAGE_KEY, JSON.stringify({ version: '1.2.3', guideId: 'legacy-guide' }))
  expect(hasSeenFeatureTour('1.2.3', 'legacy-guide')).toBe(true)
  markFeatureTourSeen('1.2.4', 'new-guide')
  expect(hasSeenFeatureTour('1.2.3', 'legacy-guide')).toBe(true)
  expect(JSON.parse(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)!)).toEqual({ schema: 2, seen: { '1.2.3': 'legacy-guide', '1.2.4': 'new-guide' } })
})

test('versions with no registered introduction are not marked seen by default', () => {
  expect(hasSeenFeatureTour('unregistered-release')).toBe(false)
  markFeatureTourSeen('unregistered-release')
  expect(localStorage.getItem(FEATURE_TOUR_STORAGE_KEY)).toBeNull()
})
