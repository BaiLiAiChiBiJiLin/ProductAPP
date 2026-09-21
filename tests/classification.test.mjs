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
