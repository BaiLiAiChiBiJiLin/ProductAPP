import test from 'node:test'
import assert from 'node:assert/strict'
import { constrain, initialPages, pageSvg, PAPER_WIDTH, PAPER_HEIGHT } from '../src/model.ts'

test('starts with exactly one empty A4 page', () => {
  assert.equal(initialPages.length, 1)
  assert.equal(initialPages[0].items.length, 0)
  assert.ok(Math.abs(PAPER_HEIGHT / PAPER_WIDTH - 297 / 210) < 1e-12)
})

test('rotated large artwork stays inside the paper', () => {
  const item = constrain({ id: 'i', assetId: 'a', x: -20, y: 1000, w: 450, h: 650, rotation: 90 })
  assert.ok(item.x - item.h / 2 >= -0.001)
  assert.ok(item.x + item.h / 2 <= PAPER_WIDTH + 0.001)
  assert.ok(item.y - item.w / 2 >= -0.001)
  assert.ok(item.y + item.w / 2 <= PAPER_HEIGHT + 0.001)
})

test('export embeds the real Unicode SVG and placement, never a colored substitute', () => {
  const asset = { id: 'asset', svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>订单图案</text></svg>' }
  const page = { id: 1, name: '页面 1', items: [{ id: 'item', assetId: 'asset', x: 120, y: 220, w: 160, h: 80, rotation: 90 }] }
  const exported = pageSvg(page, new Map([[asset.id, asset]]))
  assert.match(exported, /width="210mm" height="297mm"/)
  assert.match(exported, /translate\(120 220\) rotate\(90\)/)
  const base64 = exported.match(/base64,([^"]+)/)[1]
  assert.equal(Buffer.from(base64, 'base64').toString('utf8'), asset.svg)
  assert.throws(() => pageSvg(page, new Map()), /丢失/)
})
