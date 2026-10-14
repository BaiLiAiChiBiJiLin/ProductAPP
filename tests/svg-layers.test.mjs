import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { svgLayers, selectSvgLayer } from '../src/modules/schematic/services/svgLayerService.ts'

const parse = svg => new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document
const source = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="200mm" height="100mm" viewBox="20 30 200 100">
  <defs><pattern id="texture"><image id="resource-image" href="texture.png"/></pattern><clipPath id="clip"><rect width="200" height="100"/></clipPath></defs>
  <g transform="translate(2 3)" clip-path="url(#clip)">
    <g id="front" inkscape:label="正面 &amp; 设计"><image id="front-image" x="25" y="40" width="80" height="90" href="front.png"/><path id="front-shape" d="M25 40h10"/></g>
    <g id="back" style="display:none" transform="scale(1.2)"><image id="back-image" x="50" y="60" width="100" height="70" href="back.png"/></g>
  </g>
  <g id="cutline"><path d="M20 30h200v100z"/></g>
</svg>`

test('enumerates named groups and individual images without offering resource layers', () => {
  const layers = svgLayers(source)
  assert.deepEqual(layers.map(layer => layer.label), ['正面 & 设计', 'front-image', 'back', 'back-image', 'cutline'])
  assert.equal(new Set(layers.map(layer => layer.id)).size, layers.length)
})

test('selecting an image keeps its coordinates, viewport, transforms, resources and vector outlines', () => {
  const layer = svgLayers(source).find(layer => layer.label === 'back-image')
  const document = parse(selectSvgLayer(source, layer.id))
  assert.equal(document.querySelectorAll('image').length, 2)
  assert.ok(document.querySelector('#resource-image'))
  assert.ok(document.querySelector('#clip'))
  assert.ok(document.querySelector('#cutline path'))
  assert.equal(document.querySelector('#front-image'), null)
  const image = document.querySelector('#back-image')
  assert.equal(image.getAttribute('x'), '50')
  assert.equal(image.getAttribute('y'), '60')
  assert.equal(image.getAttribute('width'), '100')
  assert.equal(image.getAttribute('height'), '70')
  assert.equal(image.parentElement.getAttribute('transform'), 'scale(1.2)')
  assert.equal(image.parentElement.parentElement.getAttribute('transform'), 'translate(2 3)')
  assert.equal(image.parentElement.parentElement.getAttribute('clip-path'), 'url(#clip)')
  assert.equal(document.documentElement.getAttribute('viewBox'), '20 30 200 100')
  assert.equal(document.documentElement.getAttribute('width'), '200mm')
  assert.match(image.parentElement.getAttribute('style'), /display:inline!important;visibility:visible!important$/)
})

test('selecting a named group keeps the whole layer and removes other artwork groups but retains cutline', () => {
  const layer = svgLayers(source).find(layer => layer.label === '正面 & 设计')
  const document = parse(selectSvgLayer(source, layer.id))
  assert.ok(document.querySelector('#front-image'))
  assert.ok(document.querySelector('#front-shape'))
  assert.equal(document.querySelector('#back'), null)
  assert.ok(document.querySelector('#cutline path'))
  assert.ok(document.querySelector('#texture image'))
})

test('anonymous images and duplicate authored IDs remain independently selectable', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><!-- <image id="fake"/> --><image id="duplicate" href="first.png"/><image id="duplicate" href="second.png"><title>Second</title></image><image href="third.png"/></svg>`
  const layers = svgLayers(svg)
  assert.equal(layers.length, 3)
  assert.deepEqual(parse(selectSvgLayer(svg, layers[1].id)).querySelectorAll('image').length, 1)
  assert.equal(parse(selectSvgLayer(svg, layers[1].id)).querySelector('image').getAttribute('href'), 'second.png')
  assert.equal(parse(selectSvgLayer(svg, layers[2].id)).querySelector('image').getAttribute('href'), 'third.png')
  assert.equal(selectSvgLayer(svg, 'unknown'), svg)
})

test('a nested group is selected without removing its ancestors or other images inside it', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g id="artwork" transform="rotate(15)"><g id="design"><image href="a.png"/><image href="b.png"/></g><g id="alternate"><path d="M0 0h10"/></g></g></svg>`
  const selected = svgLayers(svg).find(layer => layer.label === 'design')
  const document = parse(selectSvgLayer(svg, selected.id))
  assert.equal(document.querySelectorAll('image').length, 2)
  assert.equal(document.querySelector('#artwork').getAttribute('transform'), 'rotate(15)')
  assert.equal(document.querySelector('#alternate'), null)
})
