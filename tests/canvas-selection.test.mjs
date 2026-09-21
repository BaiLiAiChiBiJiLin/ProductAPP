import test from 'node:test'
import assert from 'node:assert/strict'
import { itemsInSelection, selectionBounds, rulerAxes, updateSelectedRulers } from '../src/modules/schematic/services/canvasSelectionService.ts'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { dimensionGroups } from '../src/modules/schematic/services/imageDimensionService.ts'

const asset = (id, width, height) => ({ id, name:id, productId:'串串', productName:'串串', productGroupId:'g', width, height, svg:'<svg/>', previewUrl:'', thumbnailUrl:'', attributes:{Size:'25.4 mm'} })

test('marquee intersects images in either drag direction, including rotated images', () => {
 const items=[{id:'a',x:50,y:50,w:20,h:40,rotation:0},{id:'b',x:90,y:50,w:80,h:10,rotation:90},{id:'outside',x:150,y:150,w:10,h:10,rotation:0}]
 assert.deepEqual(itemsInSelection(items,{x:35,y:30},{x:100,y:60}),['a','b'])
 assert.deepEqual(itemsInSelection(items,{x:100,y:60},{x:35,y:30}),['a','b'])
 assert.deepEqual(itemsInSelection(items,{x:0,y:0},{x:10,y:10}),[])
 assert.deepEqual(selectionBounds({x:100,y:60},{x:35,y:30}),{x:35,y:30,width:65,height:30})
})

test('batch ruler toggles retain each images default other axis and skip suppressed backs', () => {
 const assets=[asset('wide',100,50),asset('tall',50,100),asset('other',100,100)]
 assets[0].attributes['Print Option']='Double Sided Different Design'
 const map=new Map(assets.map(a=>[a.id,a]))
 const [page]=paginateAssets(assets)
 const back=page.items.find(i=>i.derivedFrom)
 const selected=['item-wide','item-tall',back.id]
 const updated=updateSelectedRulers(page,selected,{rulerWidth:true},map)
 assert.deepEqual(rulerAxes(updated.items.find(i=>i.id==='item-wide'),assets[0]),{rulerWidth:true,rulerHeight:false})
 assert.deepEqual(rulerAxes(updated.items.find(i=>i.id==='item-tall'),assets[1]),{rulerWidth:true,rulerHeight:true})
 assert.equal(updated.items.find(i=>i.id===back.id),back)
 assert.equal(updated.items.find(i=>i.id==='item-other'),page.items.find(i=>i.id==='item-other'))
 const hidden=updateSelectedRulers(updated,selected,{rulerHeight:false,rulerWidth:false},map)
 assert.ok(!dimensionGroups(hidden).some(g=>selected.includes(g.itemIds[0])))
})

test('batch units update each selected member Size without overwriting unselected dimensions', () => {
 const assets=[asset('a',100,50),asset('b',50,100),asset('c',100,100)]
 const map=new Map(assets.map(a=>[a.id,a]))
 const [page]=paginateAssets(assets)
 const next=updateSelectedRulers(page,['item-a','item-b'],{rulerUnit:'in'},map)
 assert.deepEqual(next.imageGroups[0].details.sizes.map(s=>s.label),['1 in','1 in','25.4 mm'])
 assert.equal(next.imageGroups[0].details.size,'1 in')
 assert.deepEqual(page.imageGroups[0].details.sizes.map(s=>s.label),['25.4 mm','25.4 mm','25.4 mm'])
 assert.deepEqual(updateSelectedRulers(page,[],{rulerUnit:'cm'},map),page)
})
