import test from 'node:test'
import assert from 'node:assert/strict'
import { finishLabel } from '../src/modules/schematic/services/finishLabelService.ts'

test('long Finish stays one line anchored inside the bottom of the unchanged group', () => {
  const group = { x: 10, y: 20, width: 60, height: 80, details: { finish: 'A very long finish\nwith another process' } }
  const label = finishLabel(group)
  assert.equal(label.text, 'A very long finish with another process')
  assert.equal(label.y, 86)
  assert.equal(label.x + label.width, 66)
  assert.equal(group.height, 80)
  assert.equal(label.height, undefined)
})
