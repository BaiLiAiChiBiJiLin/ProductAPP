import test from 'node:test'
import assert from 'node:assert/strict'
import { equalizeRowBackgrounds, groupBackgroundRects, groupBackgroundsSvg } from '../src/modules/schematic/services/groupBackgroundService.ts'
import { finishLabel } from '../src/modules/schematic/services/finishLabelService.ts'
const group = (id, x, y, height) => ({ id, itemIds: [id], x, y, width: 90, height, details: { finish: 'Epoxy' } })
test('same row backgrounds and finish baseline align without resizing content', () => {
  const input = [group('a', 0, 10, 80), group('b', 100, 10, 140), group('c', 200, 10, 120), group('d', 0, 160, 50)]
  const result = equalizeRowBackgrounds(input)
  assert.deepEqual(result.map(g => g.backgroundHeight), [140, 140, 140, 50])
  assert.deepEqual(result.map(g => g.height), [80, 140, 120, 50])
  assert.equal(finishLabel(result[0]).y, finishLabel(result[1]).y)
  assert.equal(input[0].backgroundHeight, undefined)
})
test('backfilled content below a short group is never covered', () => {
  const result = equalizeRowBackgrounds([group('a', 0, 10, 80), group('b', 100, 10, 140), group('c', 0, 100, 50)])
  assert.equal(result[0].backgroundHeight, 80)
})

test('the added row area is explicitly green through the finish baseline', () => {
  const groups = [group('a', 0, 10, 80), group('b', 100, 10, 140)]
  const [short] = equalizeRowBackgrounds(groups)
  assert.deepEqual(groupBackgroundRects(short), [
    { x: 0, y: 10, width: 90, height: 80 },
    { x: 0, y: 90, width: 90, height: 60 },
  ])
  const svg = groupBackgroundsSvg({ items: [{id:'a'}, {id:'b'}], imageGroups: groups })
  assert.match(svg, /x="0" y="90" width="90" height="60" fill="#D4E9D8"/)
  assert.equal(short.y + groupBackgroundRects(short).reduce((sum, rect) => sum + rect.height, 0), 150)
  assert.ok(finishLabel(short).y < 150)
})
