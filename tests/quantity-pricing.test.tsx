import { beforeEach, expect, test, vi } from 'vitest'
import { initialBundle } from '../src/modules/settings/product-options/service'
import { cloneDocument, getTierIssues, matchQuantityTier, validateCategoryLinks, validateDocument, type PricingCategory, type QuantityPricingDocument, type QuantityTier } from '../src/modules/settings/quantity-pricing/model'
import { initialDocument, loadQuantityPricing, saveQuantityPricing, type Snapshot } from '../src/modules/settings/quantity-pricing/service'

const api = vi.hoisted(() => ({ native: true, invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => api.native, invoke: api.invoke }))

export const testCategories: PricingCategory[] = initialBundle.main.categories.map(category => ({ categoryId: category.name, title: category.title, titleZh: category.titleZh, productCount: category.products.length }))
export const makeSnapshot = (document = cloneDocument(initialDocument), version = 'v1'): Snapshot => ({ document, categories: structuredClone(testCategories), version, directory: 'D:/PrintFlow/settings/quantity-pricing' })
const tier = (quantityTierId = 'tier-1', minQty = 1, maxQty: number | null = 10, discountPercent = 0): QuantityTier => ({ quantityTierId, minQty, maxQty, discountPercent })
const documentWith = (tiers: QuantityTier[]): QuantityPricingDocument => ({ schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers }] })

beforeEach(() => {
  api.native = true
  api.invoke.mockReset()
})

test('imported category tables preserve all 56 tiers, finite limits and the sticker discount reversal', () => {
  validateDocument(initialDocument)
  validateCategoryLinks(initialDocument, testCategories)
  expect(initialDocument.categoryRules.map(rule => [rule.categoryId, rule.tiers.length])).toEqual([
    ['keychains', 11], ['standees', 13], ['stickers', 10], ['pins', 11], ['carabiners', 11],
  ])
  const keychains = initialDocument.categoryRules.find(rule => rule.categoryId === 'keychains')!.tiers
  expect([1, 5, 6, 15, 16, 49, 50, 99, 100, 99999].map(quantity => matchQuantityTier(keychains, quantity)?.discountPercent)).toEqual([0, 0, 35, 35, 45, 45, 55, 55, 63, 75])
  expect(matchQuantityTier(keychains, 100000)).toBeUndefined()
  const stickers = initialDocument.categoryRules.find(rule => rule.categoryId === 'stickers')!.tiers
  expect(matchQuantityTier(stickers, 9)).toBeUndefined()
  expect([10, 29, 30, 9999, 10000, 19999].map(quantity => matchQuantityTier(stickers, quantity)?.discountPercent)).toEqual([0, 0, 20, 55, 50, 50])
  expect(matchQuantityTier(stickers, 20000)).toBeUndefined()
})

test('matching is inclusive, independent of row order, and preserves zero and full discounts', () => {
  const rows = [tier('full', 20, null, 100), tier('free', 1, 5, 0), tier('fraction', 6, 10, 33.33)]
  validateDocument(documentWith(rows))
  const before = structuredClone(rows)
  expect(matchQuantityTier(rows, 5)?.quantityTierId).toBe('free')
  expect(matchQuantityTier(rows, 6)?.discountPercent).toBe(33.33)
  expect(matchQuantityTier(rows, 10)?.quantityTierId).toBe('fraction')
  expect(matchQuantityTier(rows, 11)).toBeUndefined()
  expect(matchQuantityTier(rows, 20)?.discountPercent).toBe(100)
  expect(matchQuantityTier(rows, Number.MAX_SAFE_INTEGER)?.discountPercent).toBe(100)
  for (const quantity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(matchQuantityTier(rows, quantity)).toBeUndefined()
  expect(rows).toEqual(before)
})

test('overlapping and nested ranges are rejected; errors identify all affected rows', () => {
  const rows = [tier('wide', 1, 100), tier('nested-a', 10, 20), tier('nested-b', 30, 40)]
  expect(() => validateDocument(documentWith(rows))).toThrow('重叠')
  expect(getTierIssues(rows).filter(issue => issue.field === 'range').map(issue => issue.quantityTierId)).toEqual(['wide', 'nested-a', 'nested-b'])
  expect(matchQuantityTier(rows, 15)).toBeUndefined()
  expect(() => validateDocument(documentWith([tier('a', 1, 10), tier('b', 10, 20)]))).toThrow('重叠')
  expect(() => validateDocument(documentWith([tier('a', 1, null), tier('b', 100, 200)]))).toThrow('重叠')
  expect(() => validateDocument(documentWith([tier('a', 1, 10), tier('b', 11, null)]))).not.toThrow()
})

test('quantity and discount inputs reject invalid values while retaining a useful field error', () => {
  for (const minQty of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const row = tier('bad', minQty)
    expect(getTierIssues([row]).some(issue => issue.field === 'minQty')).toBe(true)
    expect(() => validateDocument(documentWith([row]))).toThrow()
  }
  for (const maxQty of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const row = tier('bad', 1, maxQty)
    expect(getTierIssues([row]).some(issue => issue.field === 'maxQty')).toBe(true)
    expect(() => validateDocument(documentWith([row]))).toThrow()
  }
  expect(getTierIssues([tier('reversed', 10, 5)])[0].field).toBe('maxQty')
  for (const discount of [-1, 100.01, 10.001, NaN, Infinity]) {
    const row = tier('bad', 1, null, discount)
    expect(getTierIssues([row]).some(issue => issue.field === 'discountPercent')).toBe(true)
    expect(() => validateDocument(documentWith([row]))).toThrow()
  }
})

test('schema excludes product-level bindings, formulas, missing bounds and legacy identifiers', () => {
  const valid = documentWith([tier()])
  for (const invalid of [
    null,
    { ...valid, schemaVersion: 2 },
    { ...valid, productId: 'P31' },
    { schemaVersion: 1, categories: valid.categoryRules },
    { schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers: [tier()], productId: 'P31' }] },
    { schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers: [{ ...tier(), discountFormula: 'qty * 2' }] }] },
    { schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers: [{ quantityTierId: 't', minQty: 1, discountPercent: 35 }] }] },
    { schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers: [{ id: 't', minQty: 1, maxQty: null, discountPercent: 35 }] }] },
  ]) expect(() => validateDocument(invalid)).toThrow()
})

test('category and tier identities are explicit, unique and not silently normalized', () => {
  expect(() => validateDocument({ schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers: [] }, { categoryId: 'keychains', tiers: [] }] })).toThrow('重复')
  expect(() => validateDocument({ schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers: [tier('same')] }, { categoryId: 'pins', tiers: [tier('same')] }] })).toThrow('重复')
  for (const categoryId of ['', ' keychains', 'keychains ']) expect(() => validateDocument({ schemaVersion: 1, categoryRules: [{ categoryId, tiers: [] }] })).toThrow()
  for (const id of ['', ' tier', 'tier ']) expect(() => validateDocument(documentWith([tier(id)]))).toThrow()
  expect(() => validateDocument(documentWith([]))).not.toThrow()
  expect(() => validateDocument({ schemaVersion: 1, categoryRules: [] })).not.toThrow()
})

test('category references follow stable identifiers and deleted categories require explicit cleanup', () => {
  const document = cloneDocument(initialDocument)
  const renamed = testCategories.map(category => ({ ...category, title: 'Renamed', titleZh: '已改名' }))
  validateCategoryLinks(document, renamed)
  const withoutKeychains = renamed.filter(category => category.categoryId !== 'keychains')
  expect(() => validateCategoryLinks(document, withoutKeychains)).toThrow('keychains')
  document.categoryRules = document.categoryRules.filter(rule => rule.categoryId !== 'keychains')
  validateCategoryLinks(document, withoutKeychains)
})

test('editing a cloned category table leaves other categories and the source untouched', () => {
  const draft = cloneDocument(initialDocument)
  draft.categoryRules[0].tiers[0].discountPercent = 9
  expect(initialDocument.categoryRules[0].tiers[0].discountPercent).toBe(0)
  expect(draft.categoryRules[1]).toEqual(initialDocument.categoryRules[1])
  expect(draft.categoryRules[1]).not.toBe(initialDocument.categoryRules[1])
})

test('desktop service loads actual categories and forwards only the document and optimistic version on save', async () => {
  const loaded = makeSnapshot()
  api.invoke.mockResolvedValueOnce(loaded)
  expect(await loadQuantityPricing()).toEqual(loaded)
  const draft = cloneDocument(loaded.document)
  draft.categoryRules[0].tiers[0].discountPercent = 5
  const saved = makeSnapshot(draft, 'v2')
  api.invoke.mockResolvedValueOnce(saved)
  expect(await saveQuantityPricing(draft, loaded.version)).toEqual(saved)
  expect(api.invoke.mock.calls).toEqual([
    ['load_quantity_pricing_settings'],
    ['save_quantity_pricing_settings', { document: draft, expectedVersion: 'v1' }],
  ])
})

test('load preserves orphan rules for explicit cleanup and rejects malformed data before rendering', async () => {
  const orphan = makeSnapshot()
  orphan.categories = orphan.categories.filter(category => category.categoryId !== 'keychains')
  api.invoke.mockResolvedValueOnce(orphan)
  expect((await loadQuantityPricing()).document.categoryRules[0].categoryId).toBe('keychains')
  api.invoke.mockResolvedValueOnce({ ...makeSnapshot(), categories: [testCategories[0], testCategories[0]] })
  await expect(loadQuantityPricing()).rejects.toThrow('大类列表无效')
  api.invoke.mockResolvedValueOnce({ ...makeSnapshot(), document: { schemaVersion: 1, categoryRules: [{ categoryId: 'keychains', tiers: [tier('bad', 0)] }] } })
  await expect(loadQuantityPricing()).rejects.toThrow('起始数量')
})

test('invalid saves never reach persistence and failed saves leave the caller draft intact', async () => {
  await expect(saveQuantityPricing(documentWith([tier('a', 1, 10), tier('b', 5, null)]), 'v1')).rejects.toThrow('重叠')
  expect(api.invoke).not.toHaveBeenCalled()
  const draft = documentWith([tier('a', 1, null, 25)])
  const before = cloneDocument(draft)
  api.invoke.mockRejectedValueOnce('配置已被其他窗口修改')
  await expect(saveQuantityPricing(draft, 'stale')).rejects.toBe('配置已被其他窗口修改')
  expect(draft).toEqual(before)
})

test('browser preview uses independent seed data and cannot save desktop configuration', async () => {
  api.native = false
  const snapshot = await loadQuantityPricing()
  expect(snapshot.version).toBe('preview')
  expect(snapshot.categories).toEqual(testCategories)
  snapshot.document.categoryRules[0].tiers[0].discountPercent = 8
  expect((await loadQuantityPricing()).document.categoryRules[0].tiers[0].discountPercent).toBe(0)
  await expect(saveQuantityPricing(snapshot.document, snapshot.version)).rejects.toThrow('桌面软件')
  expect(api.invoke).not.toHaveBeenCalled()
})
