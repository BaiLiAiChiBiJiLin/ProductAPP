import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installButtonKeyboardGuard } from '../src/buttonKeyboard.ts'

test('blocks native and explicit Space activation on action buttons, including dialog portals', () => {
  const dom = new JSDOM('<button><span>Action</span></button><div role="dialog"><input type="submit"></div><div role="button" tabindex="0">Custom</div>')
  const previous = { Element: globalThis.Element, HTMLInputElement: globalThis.HTMLInputElement }
  Object.assign(globalThis, { Element: dom.window.Element, HTMLInputElement: dom.window.HTMLInputElement })
  const remove = installButtonKeyboardGuard(dom.window.document)
  try {
    let explicitActivations = 0
    const span = dom.window.document.querySelector('span')
    span.parentElement.addEventListener('keydown', () => explicitActivations++)
    for (const target of [span, dom.window.document.querySelector('input'), dom.window.document.querySelector('[role="button"]')]) {
      for (const type of ['keydown', 'keyup']) {
        const event = new dom.window.KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true })
        target.dispatchEvent(event)
        assert.equal(event.defaultPrevented, true)
      }
    }
    assert.equal(explicitActivations, 0)
    const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
    span.dispatchEvent(enter)
    assert.equal(enter.defaultPrevented, false)
    assert.equal(explicitActivations, 1)
    remove()
    const space = new dom.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    span.dispatchEvent(space)
    assert.equal(space.defaultPrevented, false)
  } finally {
    remove()
    Object.assign(globalThis, previous)
    dom.window.close()
  }
})

test('preserves Space input, selection controls and canvas keyboard events', () => {
  const dom = new JSDOM('<input><textarea></textarea><select></select><input type="checkbox"><button role="switch"></button><button role="checkbox"></button><button role="radio"></button><div contenteditable="true"></div><div id="canvas" tabindex="0"></div>')
  const previous = { Element: globalThis.Element, HTMLInputElement: globalThis.HTMLInputElement }
  Object.assign(globalThis, { Element: dom.window.Element, HTMLInputElement: dom.window.HTMLInputElement })
  const remove = installButtonKeyboardGuard(dom.window.document)
  try {
    let canvasEvents = 0
    dom.window.addEventListener('keydown', () => canvasEvents++)
    for (const target of dom.window.document.body.children) {
      const event = new dom.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      assert.equal(event.defaultPrevented, false, target.outerHTML)
    }
    assert.equal(canvasEvents, dom.window.document.body.children.length)
  } finally {
    remove()
    Object.assign(globalThis, previous)
    dom.window.close()
  }
})
