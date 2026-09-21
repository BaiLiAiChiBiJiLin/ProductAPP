import test from 'node:test'
import assert from 'node:assert/strict'
import { compactPageSections } from '../src/modules/schematic/arrangement/backfillPages.ts'
import { defaultLayoutBounds, HEADER_BLOCK_HEIGHT, GROUP_GAP } from '../src/model.ts'

test('vacated page top, middle row and first column close without scaling images', () => {
 const header={id:'h',x:10,y:240,width:480,columns:[{},{},{}]}
 const groups=[{id:'a',itemIds:['a'],x:171.42857142857144,y:275,width:157.14285714285714,height:100,detailsX:240,imageCells:[{itemId:'a',x:180,y:280,width:60,height:80}]},{id:'b',itemIds:['b'],x:10,y:500,width:157.14285714285714,height:120}]
 const page={id:1,name:'page',headerBlocks:[header],imageGroups:groups,items:[{id:'a',assetId:'a',x:200,y:300,w:40,h:50,rotation:0},{id:'b',assetId:'b',x:50,y:530,w:30,h:60,rotation:0}]}
 const offset=page.items[0].x-groups[0].x
 compactPageSections(page,defaultLayoutBounds)
 assert.equal(header.y,defaultLayoutBounds.top)
 assert.equal(groups[0].x,10)
 assert.ok(Math.abs(groups[0].y-header.y-HEADER_BLOCK_HEIGHT-GROUP_GAP)<1e-7)
 assert.ok(Math.abs(groups[1].y-groups[0].y-100-GROUP_GAP)<1e-7)
 assert.ok(Math.abs(page.items[0].x-groups[0].x-offset)<1e-7)
 assert.deepEqual(page.items.map(i=>[i.w,i.h]),[[40,50],[30,60]])
 const snapshot=JSON.stringify(page)
 compactPageSections(page,defaultLayoutBounds)
 assert.equal(JSON.stringify(page),snapshot)
})
