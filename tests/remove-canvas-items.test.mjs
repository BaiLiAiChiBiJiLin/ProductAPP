import test from 'node:test'
import assert from 'node:assert/strict'
import { removeCanvasItems } from '../src/modules/schematic/services/removeCanvasItems.ts'

test('deleting one item keeps the other members of its image group', () => {
 const page = {
  id: 1,
  name: '页面 1',
  items: [
   { id: 'front', assetId: 'a', x: 10, y: 10, w: 10, h: 10, rotation: 0 },
   { id: 'back', assetId: 'b', x: 20, y: 10, w: 10, h: 10, rotation: 0, derivedFrom: 'front' },
   { id: 'other', assetId: 'c', x: 30, y: 10, w: 10, h: 10, rotation: 0 },
  ],
  imageGroups: [{ id: 'group-1', itemIds: ['front', 'back'], x: 0, y: 0, width: 40, height: 20,
   imageCells: [{ itemId: 'front', x: 0, y: 0, width: 20, height: 20 }, { itemId: 'back', x: 20, y: 0, width: 20, height: 20 }],
   details: { size: '10 mm', qt: '1', finish: '', sizes: [{ itemId: 'front', label: '10 mm' }, { itemId: 'back', label: '10 mm' }] },
  }],
 }
 const [next] = removeCanvasItems([page], ['front'])
 assert.deepEqual(next.items.map(item => item.id), ['back', 'other'])
 assert.equal(next.items.find(item => item.id === 'back').derivedFrom, undefined)
 assert.deepEqual(next.imageGroups[0].itemIds, ['back'])
 assert.deepEqual(next.imageGroups[0].imageCells.map(cell => cell.itemId), ['back'])
 assert.deepEqual(next.imageGroups[0].details.sizes.map(entry => entry.itemId), ['back'])
})
