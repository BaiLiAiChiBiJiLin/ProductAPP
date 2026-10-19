import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayoutBounds, normalizeLayoutBounds, PAPER_WIDTH } from '../src/model.ts'
import { loadLayoutBounds, saveLayoutBounds } from '../src/modules/schematic/services/layoutBoundsPreferences.ts'

const key = 'printflow-schematic-layout-bounds'
let values
let originalStorage
beforeEach(() => {
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  values = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
  } })
})
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else delete globalThis.localStorage
})

test('first use defaults horizontal margins to eight millimetres and inner padding to three', () => {
  const bounds = loadLayoutBounds()
  assert.equal(bounds.left, 8 * PAPER_WIDTH / 210)
  assert.equal(bounds.right, 8 * PAPER_WIDTH / 210)
  assert.equal(bounds.paddingLeft, 3 * PAPER_WIDTH / 210)
  assert.equal(bounds.paddingRight, 3 * PAPER_WIDTH / 210)
  assert.deepEqual(bounds, defaultLayoutBounds)
  bounds.left = 123
  assert.deepEqual(loadLayoutBounds(), defaultLayoutBounds)
})

test('applied margins and padding survive a fresh module load without changing source values', async () => {
  const bounds = { top: 102, left: 21, right: 28, bottom: 33, paddingLeft: 0, paddingRight: 9 }
  saveLayoutBounds(bounds)
  assert.deepEqual(JSON.parse(values.get(key)), bounds)
  bounds.left = 90
  const reopened = await import('../src/modules/schematic/services/layoutBoundsPreferences.ts?reopened')
  assert.deepEqual(reopened.loadLayoutBounds(), { top: 102, left: 21, right: 28, bottom: 33, paddingLeft: 0, paddingRight: 9 })
})

test('applying legacy review bounds persists their effective zero padding', () => {
  const bounds = { top: 102, left: 21, right: 28, bottom: 33 }
  saveLayoutBounds(bounds)
  const expected = { ...bounds, paddingLeft: 0, paddingRight: 0 }
  assert.deepEqual(JSON.parse(values.get(key)), expected)
  assert.deepEqual(loadLayoutBounds(), expected)
  assert.deepEqual(bounds, { top: 102, left: 21, right: 28, bottom: 33 })
})

test('missing and invalid fields fall back independently while zero remains a valid preference', () => {
  values.set(key, JSON.stringify({ top: 115, left: '15', right: 0, bottom: null, unrelated: 17 }))
  assert.deepEqual(loadLayoutBounds(), { ...defaultLayoutBounds, top: 115, right: 0 })
  values.set(key, JSON.stringify({ left: 0, right: 0, top: 0, bottom: 0 }))
  assert.deepEqual(loadLayoutBounds(), { ...defaultLayoutBounds, left: 0, right: 0, top: 0, bottom: 0 })
})

test('malformed or non-object preferences use safe defaults', () => {
  for (const saved of ['not json', 'null', 'false', '12', '[]', '"value"', '{"left":1e999,"right":null}']) {
    values.set(key, saved)
    assert.deepEqual(loadLayoutBounds(), defaultLayoutBounds, saved)
  }
})

test('saved and loaded margins are normalized to a usable page area', () => {
  const bounds = { top: 10000, left: -8, right: 10000, bottom: -3 }
  values.set(key, JSON.stringify(bounds))
  assert.deepEqual(loadLayoutBounds(), normalizeLayoutBounds({ ...defaultLayoutBounds, ...bounds }))
  saveLayoutBounds(bounds)
  assert.deepEqual(JSON.parse(values.get(key)), normalizeLayoutBounds({ ...bounds, paddingLeft: 0, paddingRight: 0 }))
  assert.deepEqual(bounds, { top: 10000, left: -8, right: 10000, bottom: -3 })
})

test('unavailable local storage permits opening but reports write failure to its caller', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage unavailable') } })
  assert.deepEqual(loadLayoutBounds(), defaultLayoutBounds)
  assert.throws(() => saveLayoutBounds(defaultLayoutBounds), /storage unavailable/)
})

test('legacy margin preferences acquire default padding while explicit zero is preserved', () => {
  values.set(key, JSON.stringify({ left: 25, right: 30, paddingLeft: 0, paddingRight: 'invalid' }))
  assert.deepEqual(loadLayoutBounds(), { ...defaultLayoutBounds, left: 25, right: 30, paddingLeft: 0 })
})
