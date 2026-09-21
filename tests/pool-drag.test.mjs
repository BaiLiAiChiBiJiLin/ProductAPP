import test from 'node:test'
import assert from 'node:assert/strict'
import { poolDropPoint } from '../src/modules/schematic/services/poolDragService.ts'
test('pool drop uses actual paper coordinates after canvas zoom and pan', () => {
 const bounds={left:200,top:100}, origin={x:30,y:40}, paper={width:500,height:707}
 assert.deepEqual(poolDropPoint({assetId:'a',clientX:430,clientY:540},bounds,origin,2,paper),{x:100,y:200})
 assert.equal(poolDropPoint({assetId:'a',clientX:229,clientY:540},bounds,origin,2,paper),undefined)
 assert.equal(poolDropPoint({assetId:'a',clientX:1231,clientY:540},bounds,origin,2,paper),undefined)
 assert.equal(poolDropPoint({assetId:'a',clientX:430,clientY:1600},bounds,origin,2,paper),undefined)
})
