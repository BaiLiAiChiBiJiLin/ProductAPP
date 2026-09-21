import test from 'node:test'
import assert from 'node:assert/strict'
import { removeCanvasGroups } from '../src/modules/schematic/services/removeCanvasGroups.ts'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { defaultLayoutBounds } from '../src/model.ts'

test('Delete removes a complete group and its backs, preserves source assets and unused pool membership', () => {
 const assets=['a','b','c'].map((id,i)=>({id,name:id,productId:'串串',productName:'串串',productGroupId:i<2?'g':'other',width:100,height:100,svg:'<svg/>',previewUrl:'',thumbnailUrl:'',attributes:{'Print Option':'Double Sided Different Design',QT:'2'}}))
 const before=JSON.stringify(assets)
 const pages=paginateAssets(assets)
 const target=pages[0].imageGroups.find(g=>g.itemIds.includes('item-a'))
 const next=removeCanvasGroups(pages,[target.id])
 assert.deepEqual(next.flatMap(p=>p.items.map(i=>i.assetId)),['c','c'])
 const used=new Set(next.flatMap(p=>p.items.map(i=>i.assetId)))
 assert.deepEqual(assets.filter(a=>!used.has(a.id)).map(a=>a.id),['a','b'])
 assert.equal(JSON.stringify(assets),before)
 assert.equal(pages[0].items.length,6)
 assert.ok(autoArrangePages(next,1,assets,defaultLayoutBounds).flatMap(p=>p.items).every(i=>i.assetId==='c'))
 const empty=removeCanvasGroups(next,next.flatMap(p=>p.imageGroups.map(g=>g.id)))
 assert.equal(empty[0].items.length,0)
 assert.equal(empty[0].headerBlocks.length,0)
 assert.equal(empty.length,next.length,'keep the empty page available for adding assets')
})
