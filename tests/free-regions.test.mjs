import test from 'node:test'
import assert from 'node:assert/strict'
import { findFreeRegions, intersects } from '../src/modules/schematic/arrangement/freeRegions.ts'
import { fillFreeRegions } from '../src/modules/schematic/arrangement/freeRegionPacking.ts'
import { GROUP_GAP, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT, PAPER_WIDTH, defaultLayoutBounds } from '../src/model.ts'

const bounds={...defaultLayoutBounds,top:100}
const column={id:'c',imageMode:'photo',detailLabel:'Size/QT/Finish/Accessory'}
const header=(id,x=10,y=100,width=150)=>({id,x,y,width,auto:true,detailWidth:74,columns:[{...column}]})
const group=(id,x,y,width,height)=>({id,itemIds:[id],x,y,width,height,detailsX:x+width-74,detailWidth:74,imageCells:[{itemId:id,x,y,width:width-74,height}]})
const page=(id,headers,groups)=>({id,name:`page ${id}`,headerBlocks:headers,imageGroups:groups,items:groups.map(g=>({id:g.id,assetId:g.id,x:g.x+20,y:g.y+20,w:20,h:20,rotation:0}))})

test('empty-region detector honors bounds, rotated standalone art, headers, group backgrounds and spacing without mutations',()=>{
 const p=page(1,[header('h')],[{...group('a',10,135,150,100),backgroundHeight:140}])
 p.items.push({id:'loose',assetId:'loose',x:350,y:210,w:80,h:40,rotation:90})
 const before=JSON.stringify(p), free=findFreeRegions(p,bounds)
 assert.ok(free.length)
 const obstacles=[{x:10,y:100,width:150,height:HEADER_BLOCK_HEIGHT},{x:10,y:135,width:150,height:140},{x:330,y:170,width:40,height:80}]
 for(const r of free){
  assert.ok(r.x>=bounds.left && r.y>=bounds.top && r.x+r.width<=PAPER_WIDTH-bounds.right+1e-7 && r.y+r.height<=PAPER_HEIGHT-bounds.bottom+1e-7)
  for(const b of obstacles) assert.ok(!intersects(r,{x:b.x-GROUP_GAP,y:b.y-GROUP_GAP,width:b.width+2*GROUP_GAP,height:b.height+2*GROUP_GAP}))
 }
 assert.equal(JSON.stringify(p),before)
})

test('generic fill uses non-standee side gaps, skips oversized candidates, moves complete groups and removes emptied pages',()=>{
 const a=page(1,[header('left',10,100,270)],[group('left',10,100+HEADER_BLOCK_HEIGHT+GROUP_GAP,270,500)])
 const big=group('big',10,140,300,540)
 const b=page(2,[header('big-head',10,100,300)],[big])
 const c=page(3,[header('small-head')],[group('s1',10,140,150,100),group('s2',10,250,150,100)])
 const dimensions=[...a.items,...b.items,...c.items].map(i=>[i.id,i.w,i.h])
 const result=fillFreeRegions([a,b,c],bounds)
 assert.ok(result[0].imageGroups.some(g=>g.id==='s1' && g.x>=280+GROUP_GAP))
 assert.ok(result[0].imageGroups.some(g=>g.id==='s2'))
 assert.equal(result.length,2)
 assert.deepEqual(result.flatMap(p=>p.items).map(i=>[i.id,i.w,i.h]).sort(),dimensions.sort())
 const snapshot=JSON.stringify(result)
 assert.equal(JSON.stringify(fillFreeRegions(result,bounds)),snapshot,'a completed fill must be stable')
})

test('a matching header is reused for a middle gap and a sole group retains its header when shifted upward',()=>{
 const h=header('h',10,100,480)
 const a=page(1,[h],[group('top',10,100+HEADER_BLOCK_HEIGHT+GROUP_GAP,480,100),group('bottom',10,480,480,120)])
 const b=page(2,[header('later',10,100,480)],[group('middle',10,140,480,120)])
 const result=fillFreeRegions([a,b],bounds)
 assert.equal(result.length,1)
 assert.equal(result[0].headerBlocks.length,1)
 assert.equal(result[0].headerBlocks[0].id,'h')
 const g=result[0].imageGroups.find(g=>g.id==='bottom')
 assert.ok(g.y<480)
 const alone=page(1,[header('alone',10,100,480)],[group('only',10,350,480,100)])
 const shifted=fillFreeRegions([alone],bounds)[0]
 assert.equal(shifted.headerBlocks[0].id,'alone')
 assert.equal(shifted.imageGroups[0].y,100+HEADER_BLOCK_HEIGHT+GROUP_GAP)
})

test('a group fitting the raw gap is rejected when its required new header will not fit',()=>{
 const a=page(1,[header('left',10,100,270),header('lower',10,245,480)],
  [group('left',10,135,270,100),group('lower',10,276,480,400)])
 const b=page(2,[header('source',10,100,150)],[group('tall',10,135,150,125)])
 const result=fillFreeRegions([a,b],bounds)
 assert.ok(!result[0].imageGroups.some(g=>g.id==='tall'))
 assert.equal(result.flatMap(p=>p.items).filter(i=>i.id==='tall').length,1)
})
