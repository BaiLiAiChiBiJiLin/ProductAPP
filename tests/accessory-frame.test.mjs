import test from 'node:test'
import assert from 'node:assert/strict'
import { accessoryFrame, rememberAccessorySize, visibleAccessoryBounds } from '../src/modules/schematic/services/accessoryFrameService.ts'

test('embedded white and transparent margins do not count as accessory artwork', () => {
  const pixels = new Uint8ClampedArray(100 * 100 * 4).fill(255)
  for (let y = 20; y < 80; y++) for (let x = 40; x < 60; x++) {
    const i = (y * 100 + x) * 4
    pixels[i] = 180; pixels[i + 1] = 0; pixels[i + 2] = 30
  }
  assert.deepEqual(visibleAccessoryBounds(pixels, 100, 100), { x: 40, y: 20, width: 20, height: 60 })
  pixels.fill(0)
  assert.deepEqual(visibleAccessoryBounds(pixels, 100, 100), { x: 0, y: 0, width: 100, height: 100 })
})

test('portrait accessory white backing follows fitted width with four units total padding', () => {
  rememberAccessorySize('portrait', 20, 100)
  const frame = accessoryFrame('portrait', 10, 20, 50, '43')
  assert.equal(frame.width, 10)
  assert.equal(frame.frameWidth, 14)
  assert.equal(frame.x, frame.imageX - 2)
  assert.equal(frame.y, frame.imageY - 2)
  assert.equal(frame.y + frame.frameHeight, frame.codeY + 12 + 2)
})
test('landscape accessory with no code has exactly four extra units on each dimension', () => {
  rememberAccessorySize('landscape', 100, 20)
  const frame = accessoryFrame('landscape', 0, 0, 50)
  assert.equal(frame.frameWidth, frame.width + 4)
  assert.equal(frame.frameHeight, frame.height + 4)
})
