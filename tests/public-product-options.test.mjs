import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePublicProductOptions } from '../src/modules/schematic/services/publicProductOptionService.ts'
import { availableOptionValues } from '../src/modules/schematic/services/productOptionRules.ts'

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

function productWithOptions(options) {
  return normalizePublicProductOptions({
    uncategorizedProducts: [{ productId: 'accessories', title: 'Keychains', options }],
  })[0]
}

test('nested accessory colors retain their style dependency, label and image', () => {
  const product = productWithOptions([{ name: 'Accessories Style', labelZh: '配件样式', values: [
    { name: 'U style', labelZh: 'U形扣', image: 'u-style.jpg', colors: [
      { name: 'Gold', labelZh: '金色', image: 'u-gold.png' },
    ] },
    { name: 'Star Hook', labelZh: '星形扣', image: 'star-style.jpg', colors: [
      { name: 'Gold', labelZh: '金色星形扣', image: 'star-gold.png' },
    ] },
    { name: 'No accessory', labelZh: '无配件', colors: [] },
  ] }])
  const [styles, colors] = product.options
  assert.equal(styles.values[0].label, 'U形扣')
  assert.equal(styles.values[0].image, 'u-style.jpg')
  assert.equal(colors.name, 'Accessories Color')
  assert.equal(colors.label, '配件颜色')
  assert.equal(colors.linkedParent, 'Accessories Style')
  assert.deepEqual(colors.values, [
    { name: 'Gold', label: '金色', image: 'u-gold.png', hidden: false, deleted: false, parentValues: ['U style'] },
    { name: 'Gold', label: '金色星形扣', image: 'star-gold.png', hidden: false, deleted: false, parentValues: ['Star Hook'] },
  ])
  assert.deepEqual(availableOptionValues(colors, { 'Accessories Style': 'U style' }), [colors.values[0]])
  assert.deepEqual(availableOptionValues(colors, { 'Accessories Style': 'Star Hook' }), [colors.values[1]])
  assert.deepEqual(availableOptionValues(colors, { 'Accessories Style': 'No accessory' }), [])
  assert.deepEqual(availableOptionValues(colors, {}), [])
})

test('hidden and deleted accessory styles and colors do not become selectable', () => {
  const flags = [{ hidden: true }, { deleted: 'true' }, { isHidden: 1 }, { isDeleted: '1' }]
  const product = productWithOptions([{ name: 'Accessories Style', values: [
    ...flags.map((flag, index) => ({ name: `Unavailable ${index}`, ...flag, colors: [{ name: `Color ${index}` }] })),
    { name: 'Visible', colors: [
      ...flags.map((flag, index) => ({ name: `Unavailable color ${index}`, ...flag })),
      { name: 'Silver', labelZh: '银色', image: 'silver.png' },
    ] },
  ] }])
  const [styles, colors] = product.options
  assert.deepEqual(styles.values.map(value => value.name), ['Visible'])
  assert.deepEqual(colors.values.map(value => value.name), ['Silver'])
  assert.deepEqual(availableOptionValues(colors, { 'Accessories Style': 'Visible' }).map(value => value.name), ['Silver'])
  for (const [index, flag] of flags.entries()) {
    assert.deepEqual(availableOptionValues(colors, { 'Accessories Style': `Unavailable ${index}` }), [])
    assert.deepEqual(productWithOptions([{ name: 'Accessories Style', ...flag, values: [
      { name: 'Hidden option style', colors: [{ name: 'Hidden option color' }] },
    ] }]).options, [])
  }
})

test('an explicit accessory color option takes precedence without adding a duplicate field', () => {
  const product = productWithOptions([
    { name: 'Accessories Style', values: [{ name: 'U style', colors: [{ name: 'Nested color' }] }] },
    { name: 'Accessories Color', labelZh: '自定义配件颜色', linkedParent: 'Accessories Style', values: [
      { name: 'Silver', labelZh: '银色', image: 'explicit-silver.png', parentValues: ['U style'] },
    ] },
  ])
  const colorOptions = product.options.filter(option => option.name === 'Accessories Color')
  assert.equal(colorOptions.length, 1)
  assert.equal(colorOptions[0].label, '自定义配件颜色')
  assert.deepEqual(availableOptionValues(colorOptions[0], { 'Accessories Style': 'U style' }), [
    { name: 'Silver', label: '银色', image: 'explicit-silver.png', hidden: false, deleted: false, parentValues: ['U style'] },
  ])
})
