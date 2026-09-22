import test from 'node:test'
import assert from 'node:assert/strict'
import { accessoryFrame, rememberAccessorySize, visibleAccessoryBounds, prepareAccessoryFrames, rememberAccessoryImage } from '../src/modules/schematic/services/accessoryFrameService.ts'

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
test('export preparation measures offscreen accessory pixels using the same original resource key as canvas', async (t) => {
  const pixels = new Uint8ClampedArray(100 * 100 * 4).fill(255)
  for(let y=10;y<90;y++) for(let x=45;x<55;x++) pixels[(y*100+x)*4]=0
  const oldImage=globalThis.Image, oldDocument=globalThis.document
  t.after(()=>{globalThis.Image=oldImage;globalThis.document=oldDocument})
  globalThis.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:pixels})})})}
  globalThis.Image=class { naturalWidth=100;naturalHeight=100;set src(value){queueMicrotask(()=>this.onload?.())} }
  const src='data:image/png;base64,offscreen-test'
  const pages=[{items:[],imageGroups:[{details:{accessoryImage:src}}]}]
  await prepareAccessoryFrames(pages)
  const exported=accessoryFrame(src,0,0,60,'68')
  rememberAccessoryImage(src,{naturalWidth:100,naturalHeight:100})
  assert.deepEqual(accessoryFrame(src,0,0,60,'68'),exported)
  assert.equal(exported.width,6)
  assert.equal(exported.height,48)
  assert.equal(exported.frameWidth,14)
})
test('only accessories that do not trigger wide scaling receive a four-unit top gap', () => {
  rememberAccessorySize('thin-gap',20,100)
  const thin=accessoryFrame('thin-gap',0,10,50,'98')
  assert.equal(thin.imageY,14)
  assert.equal(thin.height,50)
  rememberAccessorySize('wide-no-gap',60,100)
  const wide=accessoryFrame('wide-no-gap',0,10,50,'33')
  assert.equal(wide.imageY,10+(50-wide.height)/2)
})
test('wide accessories use a relative width cap while thin accessories retain their scale', () => {
  rememberAccessorySize('heart', 60, 100)
  for (const size of [30, 60, 90]) {
    const frame = accessoryFrame('heart', 0, 0, size, '33')
    assert.ok(Math.abs(frame.width - size * 0.4) < 1e-7)
    assert.ok(Math.abs(frame.width / frame.height - 0.6) < 1e-7)
    assert.equal(frame.frameWidth, frame.width + 4)
    rememberAccessorySize('thin', 10, 100)
    assert.equal(accessoryFrame('thin', 0, 0, size).height, size)
  }
})
