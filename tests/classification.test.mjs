import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyAssetsByProductAndPrint } from '../src/modules/schematic/services/classificationService.ts'

const asset = (id, productId, print) => ({ id, name: id, productId, width: 1, height: 1, svg: '', previewUrl: '', thumbnailUrl: '', attributes: { 'Print Option': print } })

test('classification sorts products and then print options by descending count', () => {
  const input = [
    asset('a-y-1', 'A', 'Y'), asset('b-z-1', 'B', 'Z'), asset('a-x-1', 'A', 'X'),
    asset('b-z-2', 'B', 'Z'), asset('a-y-2', 'A', 'Y'), asset('b-q-1', 'B', 'Q'),
    asset('b-z-3', 'B', 'Z'), asset('a-x-2', 'A', 'X'), asset('a-y-3', 'A', 'Y'),
  ]
  assert.deepEqual(classifyAssetsByProductAndPrint(input).map(item => item.id), [
    'a-y-1', 'a-y-2', 'a-y-3', 'a-x-1', 'a-x-2',
    'b-z-1', 'b-z-2', 'b-z-3', 'b-q-1',
  ])
})

test('missing print option is stable and localized key aliases are recognized', () => {
  const input = [
    { ...asset('a-empty-1', 'A', ''), attributes: {} }, asset('b-1', 'B', '双面同图'),
    { ...asset('a-empty-2', 'A', ''), attributes: { 印刷选项: '双面同图' } }, asset('a-empty-3', 'A', ''),
  ]
  assert.deepEqual(classifyAssetsByProductAndPrint(input).map(item => item.id), ['a-empty-1', 'a-empty-3', 'a-empty-2', 'b-1'])
})

test('saved product groups stay adjacent while print sorting still applies to other units', () => {
  const input = [
    { ...asset('group-front', 'A', 'Front'), productGroupId: 'group-a' },
    asset('other-front', 'A', 'Front'),
    { ...asset('group-back', 'A', 'Back'), productGroupId: 'group-a' },
    asset('other-back', 'A', 'Back'),
  ]
  assert.deepEqual(classifyAssetsByProductAndPrint(input).map(item => item.id), [
    'group-front', 'group-back', 'other-front', 'other-back',
  ])
})

test('unassigned images are placed after assigned products in the default order', () => {
  const input = [
    asset('unassigned-1', '', 'Front'),
    asset('product-b', 'B', 'Front'),
    asset('unassigned-2', 'a', 'Back'),
    asset('product-a', 'A', 'Front'),
  ]
  assert.deepEqual(classifyAssetsByProductAndPrint(input).map(item => item.id), [
    'product-b', 'product-a', 'unassigned-1', 'unassigned-2',
  ])
})

test('Stickers products are first in the default product order', () => {
  const input = [asset('keychain', 'Keychains', 'Front'), asset('sticker', 'Stickers', 'Front'), asset('贴纸-2', '贴纸', 'Back')]
  assert.deepEqual(classifyAssetsByProductAndPrint(input).map(item => item.id), ['sticker', '贴纸-2', 'keychain'])
})

test('same product keeps equal technique and film combinations adjacent before print tie breaking', () => {
  const make = (id, print, technique, film) => ({ ...asset(id, 'A', print), attributes: { 'Print Option': print, Technique: technique, 'Holo Film': film } })
  const input = [
    make('epoxy-star-1', 'Front', 'Epoxy', 'Star'),
    make('plain-clear', 'Front', 'Glossy', 'Clear'),
    make('epoxy-star-2', 'Back', 'Epoxy', 'Star'),
    make('plain-clear-2', 'Back', 'Glossy', 'Clear'),
  ]
  assert.deepEqual(classifyAssetsByProductAndPrint(input).map(item => item.id), [
    'epoxy-star-1', 'epoxy-star-2', 'plain-clear', 'plain-clear-2',
  ])
})

test('technique and film aliases are compared case-insensitively with whitespace normalized', () => {
  const input = [
    { ...asset('one', 'A', 'Front'), attributes: { Finish: '  Epoxy  ', Film: 'Star  Holo' } },
    { ...asset('two', 'A', 'Front'), attributes: { 工艺: 'epoxy', 膜: 'star holo' } },
    { ...asset('three', 'A', 'Front'), attributes: { Finish: 'Glossy', Film: 'Clear' } },
  ]
  assert.deepEqual(classifyAssetsByProductAndPrint(input).map(item => item.id), ['one', 'two', 'three'])
})
