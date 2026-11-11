import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePublicProductOptions } from '../src/modules/schematic/services/publicProductOptionService.ts'

test('public product options flatten categories and keep the public id namespace', () => {
  const products = normalizePublicProductOptions({
    success: true,
    categories: [{
      name: 'standees',
      products: [{
        productId: 'P23',
        title: 'Broken Glass Acrylic Standees',
        titleZh: '全息玻璃碎立牌',
        options: [{
          name: 'Standee Quantity',
          labelZh: '立牌数量',
          values: [{ name: '2', labelZh: '2件', image: 'quantity.png' }],
        }],
      }],
    }],
    uncategorizedProducts: [{
      productId: 'P99',
      title: 'English Product',
      options: [{ name: 'Size', values: [{ valueId: 'small', labelZh: '小号' }] }],
    }],
  })

  assert.deepEqual(products.map(product => product.id), ['public:P23', 'public:P99'])
  assert.equal(products[0].title, '全息玻璃碎立牌')
  assert.equal(products[0].options[0].label, '立牌数量')
  assert.deepEqual(products[0].options[0].values[0], {
    name: '2', label: '2件', image: 'quantity.png', hidden: false, deleted: false, parentValues: [],
  })
  assert.equal(products[1].title, 'English Product')
  assert.equal(products[1].options[0].values[0].name, 'small')
})

test('public products remain selectable even when they have no configurable options', () => {
  const products = normalizePublicProductOptions({
    categories: [{ products: [
      { productId: 'empty', title: 'Empty', options: [] },
      { productId: 'hidden', title: 'Hidden', hidden: true, options: [{ name: 'Size', values: [{ name: 'S' }] }] },
      { productId: 'usable', title: 'Usable', options: [{ name: 'Size', values: [{ name: 'S' }] }] },
    ] }],
  })
  assert.deepEqual(products.map(product => product.id), ['public:empty', 'public:usable'])
})
