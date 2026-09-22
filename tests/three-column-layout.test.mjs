import test from 'node:test'
import assert from 'node:assert/strict'
import { paginateAssets, autoArrangePages } from '../src/modules/schematic/services/paginationService.ts'
import { dimensionGroups, imageDimensionMarkerLayout, dimensionForItem, physicalSourceSize } from '../src/modules/schematic/services/imageDimensionService.ts'

import { defaultLayoutBounds, GROUP_GAP, PAPER_HEIGHT, PAPER_WIDTH, pageSvg } from '../src/model.ts'
import { imageDetailsLayout } from '../src/modules/schematic/services/imageDetailsLayoutService.ts'
const asset = (id, productName = 'Keychains', attributes = {}, productGroupId = '') => ({ id, name: id, productId: productName, productName, width: 100, height: 120, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120"><rect width="100" height="120" fill="red"/></svg>', previewUrl: '', thumbnailUrl: '', attributes, productGroupId })

test('photo holder roles share a longest edge and no member is enlarged', () => {
 for (const name of ['Photocard Holders','照片夹']) {
  const sources=['Example','Front','Inside','Back','extra'].map((id,i)=>({...asset(id,name,{},'holder'),width:300-i*30,height:60,sourceGroupWidthMm:75-i*7.5,sourceGroupHeightMm:15}))
  const [page]=paginateAssets(sources)
  const roles=page.items.slice(0,4)
  const group=page.imageGroups[0]
  for(const [index,item] of roles.slice(1).entries()) {
   const cell=group.imageCells.find(c=>c.itemId===item.id)
   assert.equal(cell.width,group.width/3)
   assert.ok(Math.abs(item.x-(group.x+(index+0.5)*group.width/3))<1e-7)
   assert.ok(group.y+group.detailsHeight<=cell.y+1e-7)
  }
  for(const item of roles) assert.ok(Math.abs(Math.max(item.w,item.h)-Math.max(roles[0].w,roles[0].h))<1e-7)
  for(const item of page.items) {
   const source=sources.find(s=>s.id===item.assetId)
   assert.ok(item.w<=source.sourceGroupWidthMm*PAPER_WIDTH/210+1e-7)
   assert.ok(Math.abs(item.w/item.h-source.width/source.height)<1e-7)
  }
 }
})
test('vertical different-design pair with Finish uses identical front and back dimensions', () => {
 const source={...asset('pair','Keychains',{'Print Option':'Double Sided Different Design',Finish:'Epoxy'}),width:80,height:140}
 const [page]=paginateAssets([source])
 const [front,back]=page.items
 assert.equal(front.w,back.w);assert.equal(front.h,back.h)
 const group=page.imageGroups[0]
 assert.ok(back.y+back.h/2<=group.y+group.height-16+1e-7)
})

test('Finish overlays a single line without changing group height or pagination', () => {
 const assets = [asset('finish', 'Keychains', { Finish: 'Epoxy' })]
 const [page] = paginateAssets(assets, 1000)
 const group = page.imageGroups[0]
 const item = page.items[0]
 const [plain] = paginateAssets([asset('finish', 'Keychains')], 1000)
 assert.equal(group.height, plain.imageGroups[0].height)
 assert.ok(item.y < plain.items[0].y)
 assert.ok(item.y + item.h / 2 <= group.y + group.height - 16 + 1e-7)
 const svg = pageSvg(page, new Map(assets.map(asset => [asset.id, asset])))
 assert.match(svg, /text-anchor="end"[^>]*font-size="10"[^>]*fill="#ff4d4f">Epoxy/)
})
test('a group with one image centers the artwork vertically inside its image cell', () => {
 const source = { ...asset('single-center'), width: 100, height: 45 }
 const [page] = paginateAssets([source])
 const group = page.imageGroups[0], item = page.items[0], cell = group.imageCells[0]
 const top = 14, bottom = 14
 assert.ok(Math.abs(item.y - (cell.y + (cell.height + top - bottom) / 2)) < 1e-7)
 assert.ok(item.y - item.h / 2 >= cell.y + top - 1e-7)
 assert.ok(item.y + item.h / 2 <= cell.y + cell.height - bottom + 1e-7)
})
test('image properties clamp to the group right edge when an old layout has stale detail geometry', () => {
 const group={...asset('details'),x:100,y:20,width:180,height:120,detailsX:70,detailWidth:240,details:{size:'50 mm',qt:'1',finish:'',fields:[]}}
 const layout=imageDetailsLayout(group)
 assert.ok(layout.x >= group.x)
 assert.ok(layout.x + layout.width <= group.x + group.width + 1e-7)
 assert.equal(layout.width,Math.max(1,group.width-1-8))
})
test('v2 ordinary arrangement uses three columns and fits proportionally within each image cell', () => {
 const assets = Array.from({length: 20}, (_,i) => asset(String(i)))
 const pages = paginateAssets(assets, 1000)
 assert.equal(new Set(pages[0].imageGroups.slice(0,3).map(g=>g.x)).size,3)
 for(const page of pages) for(const item of page.items) { const original = physicalSourceSize(assets.find(a=>a.id===item.assetId)); const cell = page.imageGroups.flatMap(g=>g.imageCells).find(c=>c.itemId===item.id); assert.ok(Math.abs(item.w/item.h-original.width/original.height)<1e-8); assert.ok(item.x-item.w/2>=cell.x); assert.ok(item.x+item.w/2<=cell.x+cell.width); assert.ok(item.y+item.h/2<=cell.y+cell.height) }
 assert.equal(pages.flatMap(p=>p.items).length,20)
})

test('wide artwork fills available width while ruler and physical label stay inside the group', () => {
 const source = { ...asset('wide'), width: 20, height: 10, sourceGroupWidthMm: 5, sourceGroupHeightMm: 2.5 }
 const [page] = paginateAssets([source])
 const item = page.items[0], cell = page.imageGroups[0].imageCells[0]
 assert.ok(Math.abs(item.w - (cell.width - 4)) < 1e-7)
 assert.ok(Math.abs(item.x + item.w / 2 - page.imageGroups[0].detailsX) < 1e-7)
 assert.equal(item.w / item.h, 2)
 assert.ok(item.w > 5 * PAPER_WIDTH / 210)
 const marker = imageDimensionMarkerLayout(dimensionGroups(page)[0], page, new Map([[source.id, source]]))
 assert.equal(marker.label, '5 mm')
 assert.ok(marker.x1 >= cell.x && marker.x2 <= cell.x + cell.width)
 assert.equal(marker.x1,item.x-item.w/2)
 assert.equal(marker.x2,item.x+item.w/2)
 assert.equal(marker.extension[1][0],item.x+item.w/2)
 assert.ok(marker.textY - 7 >= cell.y)
 assert.equal(source.sourceGroupWidthMm, 5)
})
test('v2 holder reserves half area, explicit roles and third-row rulers', () => {
 const assets = ['Example','Front','Inside','Back','bead1','bead2'].map(id=>asset(id,'Photocard Holders',{},'group'))
 const [page] = paginateAssets(assets,1000)
 assert.equal(page.imageGroups[0].height,(PAPER_HEIGHT-defaultLayoutBounds.top-defaultLayoutBounds.bottom)/2)
 assert.deepEqual(page.items.slice(0,4).map(i=>i.caption),['Example','Front','Inside','Back'])
 assert.deepEqual(page.items.slice(0,4).map(i=>!!i.suppressRuler),[false,true,true,true])
 assert.equal(dimensionGroups(page).length,3)
})
test('v2 double sided ordinary products have a vertical mirrored back without ruler', () => {
 const [page] = paginateAssets([asset('a','Keychains',{'Print Option':'Double Sided Different Design'})])
 assert.equal(page.items.length,2); const [front,back]=page.items
 assert.equal(front.caption,'Front'); assert.equal(back.caption,'Back'); assert.ok(back.y>front.y); assert.equal(back.mirrorX,true); assert.equal(back.derivedFrom,front.id); assert.equal(dimensionGroups(page).length,1)
 assert.match(pageSvg(page,new Map([['a',asset('a')]])),/scale\(-1 1\)/)
})
test('v2 standees put last base in details and mirror only different-design members horizontally', () => {
 const assets = [asset('a','Acrylic Standees',{'Print Option':'Double Sided Different Design'},'g'),asset('b','Acrylic Standees',{},'g'),asset('base','Acrylic Standees',{},'g')]
 const [page]=paginateAssets(assets); const [front,back,other,base]=page.items
 assert.equal(back.y,front.y); assert.ok(back.x>front.x); assert.equal(back.caption,undefined); assert.ok(base.x>=page.imageGroups[0].detailsX); assert.equal(other.derivedFrom,undefined)
})
test('different-design standees span two of three base columns with a matching Front/Back header through reordering', () => {
 const assets=Array.from({length:12},(_,i)=>asset(`stand-${i}`,'Broken Glass Acrylic Standees',{'Print Option':'Double Sided Different Design'}))
 const columnWidth=(PAPER_WIDTH-defaultLayoutBounds.left-defaultLayoutBounds.right-2*GROUP_GAP)/3
 let pages=paginateAssets(assets)
 for(const order of [assets,[...assets].reverse(),assets]) {
  pages=autoArrangePages(pages,1,order,defaultLayoutBounds)
  assert.equal(pages.flatMap(p=>p.items).filter(i=>!i.derivedFrom).length,12)
  for(const page of pages) for(const group of page.imageGroups) {
   assert.ok(Math.abs(group.width-(2*columnWidth+GROUP_GAP))<1e-7)
   const header=page.headerBlocks.filter(h=>h.y<group.y).at(-1)
   assert.ok(header.columns.every(c=>c.imageMode==='front-back'))
   assert.equal(header.width,group.width)
   const [front,back]=page.items.filter(i=>group.itemIds.includes(i.id))
   assert.equal(front.y,back.y);assert.equal(front.w,back.w);assert.equal(front.h,back.h)
   assert.ok(back.x>front.x);assert.ok(back.suppressRuler)
   assert.ok(group.x+group.width<=PAPER_WIDTH-defaultLayoutBounds.right+1e-7)
   for(const other of page.imageGroups.filter(g=>g!==group)) assert.ok(group.x+group.width<=other.x || other.x+other.width<=group.x || group.y+group.height<=other.y || other.y+other.height<=group.y)
  }
 }
})
test('same-design standees keep three columns and Front/Back headers; a different-design base alone does not widen the group', () => {
 const assets=Array.from({length:3},(_,i)=>asset(`same-${i}`,'Acrylic Standees',{'Print Option':'Double Sided Same Design'}))
 const [page]=paginateAssets(assets)
 assert.equal(page.headerBlocks[0].columns.length,3)
 assert.ok(page.headerBlocks[0].columns.every(c=>c.imageMode==='front-back'))
 const [basePage]=paginateAssets([asset('front','Acrylic Standees',{},'g'),asset('base','Acrylic Standees',{'Print Option':'Double Sided Different Design'},'g')])
 assert.equal(basePage.imageGroups[0].width,page.imageGroups[0].width)
})
test('single-column products fill beside two-column standees from this page and later pages without resizing', async () => {
 const standees=Array.from({length:3},(_,i)=>asset(`wide-${i}`,'Acrylic Standees',{'Print Option':'Double Sided Different Design'}))
 const singles=Array.from({length:24},(_,i)=>asset(`single-${i}`))
 const assets=[...standees,...singles]
 const [reference]=paginateAssets([singles[0]])
 let pages=paginateAssets(assets)
 for(let run=0;run<2;run++) {
  const first=pages[0], wide=first.imageGroups.find(g=>g.id==='group-wide-0')
  const beside=first.imageGroups.filter(g=>g.x>wide.x+wide.width)
  assert.ok(beside.length>=3,'right-hand column should fill alongside all three standees')
  assert.equal(beside[0].y,wide.y)
  assert.equal(beside[0].itemIds[0],'item-single-0','prefer the earliest available following product')
  const sideHeader=first.headerBlocks.find(h=>Math.abs(h.x-beside[0].x)<1e-7)
  assert.equal(sideHeader.columns.length,1);assert.equal(sideHeader.columns[0].imageMode,'photo')
  assert.equal(sideHeader.width,beside[0].width)
  const {removeCanvasGroups}=await import('../src/modules/schematic/services/removeCanvasGroups.ts')
  const afterDelete=removeCanvasGroups(pages,beside.map(g=>g.id))[0]
  assert.ok(!afterDelete.headerBlocks.some(h=>h.id===sideHeader.id))
  assert.ok(afterDelete.headerBlocks.some(h=>h.columns[0].imageMode==='front-back'),'deleting side products must preserve the standee header')
  const {compactPageSections}=await import('../src/modules/schematic/arrangement/backfillPages.ts')
  const compacted=structuredClone(first)
  compactPageSections(compacted,defaultLayoutBounds)
  assert.deepEqual(compacted,first,'side-by-side sections must remain stable on a second compaction')
  const originals=pages.flatMap(p=>p.items).filter(i=>!i.derivedFrom)
  assert.equal(originals.length,assets.length);assert.equal(new Set(originals.map(i=>i.assetId)).size,assets.length)
  for(const page of pages) for(const group of page.imageGroups) {
   assert.ok(group.x+group.width<=PAPER_WIDTH-defaultLayoutBounds.right+1e-7)
   assert.ok(group.y+group.height<=PAPER_HEIGHT-defaultLayoutBounds.bottom+1e-7)
   for(const other of page.imageGroups.filter(g=>g!==group)) assert.ok(group.x+group.width<=other.x+1e-7 || other.x+other.width<=group.x+1e-7 || group.y+group.height<=other.y+1e-7 || other.y+other.height<=group.y+1e-7)
   for(const header of page.headerBlocks) assert.ok(group.x+group.width<=header.x+1e-7 || header.x+header.width<=group.x+1e-7 || group.y+group.height<=header.y+1e-7 || header.y+26<=group.y+1e-7)
   for(const item of page.items.filter(i=>group.itemIds.includes(i.id)&&i.assetId.startsWith('single-'))) {
    assert.equal(item.w,reference.items[0].w);assert.equal(item.h,reference.items[0].h)
   }
  }
  pages=autoArrangePages(pages,1,assets,defaultLayoutBounds)
 }
})
test('v2 chains keep details right and arrange horizontal front/back pairs',()=>{
 const assets=Array.from({length:6},(_,i)=>asset(String(i),'串串',{'Print Option':i%2?'Double Sided Same Design':'Double Sided Different Design'},'g'))
 const [page]=paginateAssets(assets); const g=page.imageGroups[0]
 assert.equal(g.width,(PAPER_WIDTH-defaultLayoutBounds.left-defaultLayoutBounds.right-GROUP_GAP)/2)
 for(const item of page.items) assert.ok(item.x+item.w/2<=g.detailsX)
 assert.equal(page.items.filter(i=>i.derivedFrom).length,3)
})
test('v2 chains keep each front/back pair equal while normalizing large source-size differences',()=>{
 const makeChain=(id,width,height,option)=>({...asset(id,'串串',{'Print Option':option},'g'),width,height})
 const assets=[makeChain('small',80,80,'Double Sided Different Design'),makeChain('large',300,300,'Double Sided Different Design'),makeChain('medium',150,110,'Double Sided Same Design')]
 const [page]=paginateAssets(assets); const pairs=page.items.filter(item=>item.derivedFrom)
 for(const back of pairs){const front=page.items.find(item=>item.id===back.derivedFrom);assert.ok(front);assert.equal(back.w,front.w);assert.equal(back.h,front.h)}
 const originals=page.items.filter(item=>!item.derivedFrom)
 assert.ok(originals[1].w / originals[0].w < 2, 'large source should remain visually close instead of dominating the row')
 assert.ok(originals.every(item=>item.w>0 && item.h>0))
})
test('v2 unit toggles use source dimensions, one decimal and independent width/height',()=>{
 const a=asset('a','Keychains',{Size:'1.5 in'}); const [page]=paginateAssets([a]); const item=page.items[0]
 assert.equal(dimensionForItem(a,{rulerUnit:'mm'}).label,'38.1 mm')
 assert.equal(dimensionForItem(a,{rulerUnit:'cm'}).label,'3.8 cm')
 assert.equal(dimensionForItem(a,{rulerUnit:'in'}).label,'1.5 in')
 item.rulerWidth=true; item.rulerHeight=true
 const groups=dimensionGroups(page); assert.equal(groups.length,2)
 const markers=groups.map(g=>imageDimensionMarkerLayout(g,page,new Map([['a',a]])))
 assert.deepEqual(markers.map(m=>m.horizontal),[true,false])
 item.rulerWidth=false;item.rulerHeight=false;assert.equal(dimensionGroups(page).length,0)
})

test('v2 repeated rearrangement preserves combination membership and ruler settings', async()=>{
 const {autoArrangePages}=await import('../src/modules/schematic/services/paginationService.ts')
 const {combineImageGroupsAcrossPages}=await import('../src/modules/schematic/services/groupCombinationService.ts')
 const assets=[asset('a'),asset('b'),asset('c')]
 let pages=paginateAssets(assets)
 pages[0].items[0].rulerUnit='in';pages[0].items[0].rulerWidth=true;pages[0].items[0].rulerHeight=false
 pages=combineImageGroupsAcrossPages(pages,pages[0].imageGroups.slice(0,2).map(g=>({pageId:1,groupId:g.id})),assets)
 for(let i=0;i<3;i++){
  pages=autoArrangePages(pages,1,assets,defaultLayoutBounds)
  const group=pages.flatMap(p=>p.imageGroups).find(g=>g.itemIds.length===2)
  assert.ok(group);const item=pages.flatMap(p=>p.items).find(i=>i.assetId==='a')
  assert.equal(item.rulerUnit,'in');assert.equal(item.rulerWidth,true);assert.equal(group.details.size,dimensionForItem(assets[0],item).label)
 }
})
test('v2 mixed pagination preserves every original exactly once, keeps groups inside page and separated',()=>{
 const assets=[...Array.from({length:7},(_,i)=>asset('o'+i,'Keychains',{'Print Option':'Double Sided Different Design'})),...Array.from({length:5},(_,i)=>asset('s'+i,'Shaker',{},'sh')), ...Array.from({length:16},(_,i)=>asset('x'+i))]
 const pages=paginateAssets(assets)
 assert.deepEqual(pages.flatMap(p=>p.items.filter(i=>!i.derivedFrom).map(i=>i.assetId)).sort(),assets.map(a=>a.id).sort())
 for(const page of pages)for(const g of page.imageGroups){
  assert.ok(g.y+g.height<=PAPER_HEIGHT-defaultLayoutBounds.bottom+1e-7)
  for(const other of page.imageGroups){if(g===other)continue;assert.ok(g.x+g.width<=other.x+1e-7 || other.x+other.width<=g.x+1e-7 || g.y+g.height<=other.y+1e-7 || other.y+other.height<=g.y+1e-7)}
  assert.ok(page.headerBlocks.some(h=>h.y<g.y))
 }
})


// Chain members form a vertical sequence; only derived backs sit beside fronts.
test('chain members stack vertically and retain every size through rearrangement', async () => {
 const { autoArrangePages } = await import('../src/modules/schematic/services/paginationService.ts')
 const assets = [asset('a','串串',{Size:'29.5 mm','Print Option':'Double Sided Different Design'},'g'),asset('b','串串',{Size:'25 mm'},'g'),asset('c','串串',{Size:'25 mm'},'g')]
 let pages = paginateAssets(assets)
 const front = pages[0].items.filter(item=>!item.derivedFrom)
 assert.equal(new Set(front.map(item=>item.y)).size,3)
 assert.ok(front.every((item,i)=>i===0 || item.y>front[i-1].y))
 assert.deepEqual(pages[0].imageGroups[0].details.sizes.map(value=>value.label),['29.5 mm','25 mm','25 mm'])
 pages[0].items.find(item=>item.assetId==='b').rulerUnit='cm'
 pages=autoArrangePages(pages,1,assets,defaultLayoutBounds)
 assert.deepEqual(pages[0].imageGroups[0].details.sizes.map(value=>value.label),['29.5 mm','2.5 cm','25 mm'])
})
test('size values keep units on one line and accessory title is omitted', async () => {
 const { imageDetailsLayout, sizeLabelWidth } = await import('../src/modules/schematic/services/imageDetailsLayoutService.ts')
 const [page]=paginateAssets([asset('a','Keychains',{Size:'50.7 mm'})])
 const layout=imageDetailsLayout(page.imageGroups[0])
 assert.deepEqual(layout.fields.filter(field=>field.key.startsWith('size')).map(field=>field.text),['Size: 50.7 mm'])
 assert.ok(!layout.fields.some(field=>field.text.includes('Accessory:')))
 assert.equal(layout.fields.find(field=>field.key==='size').fontSize,undefined,'Size uses the shared QT font size')
 assert.ok(sizeLabelWidth('50.7 mm',layout.fontSize) <= layout.width + 1e-8)
 const svg=pageSvg(page,new Map([['a',asset('a')]]))
 assert.ok(svg.includes('Size: 50.7 mm'))
 assert.ok(!svg.includes('Accessory:'))
})

test('chain with mixed print options keeps fixed front/back columns and one member per row', () => {
 const assets = ['Double Sided Different Design', 'Double Sided Same Design', 'Double Sided Different Design'].map((option, i) => ({...asset(`chain-${i}`, '串串', {'Print Option':option}, 'chain'), productGroupPosition:i}))
 const [page] = paginateAssets(assets)
 const group = page.imageGroups[0]
 const fronts = page.items.filter(item => !item.derivedFrom)
 assert.equal(new Set(fronts.map(item => item.x)).size, 1, 'all fronts must stay in the first column, including same-design members')
 const backs = page.items.filter(item => item.derivedFrom)
 assert.equal(new Set(backs.map(item => item.x)).size, 1)
 assert.equal(backs.length, 2)
 for (const [index, front] of fronts.entries()) {
  const cell = group.imageCells.find(cell => cell.itemId === front.id)
  assert.equal(cell.width, (group.detailsX - group.x) / 2)
  if (index) {
   const previous = group.imageCells.find(cell => cell.itemId === fronts[index-1].id)
   assert.ok(cell.y >= previous.y + previous.height - 1e-7)
  }
  const back = backs.find(item => item.derivedFrom === front.id)
  if (back) {
   assert.ok(back.x > front.x)
   assert.equal(back.y, front.y)
   assert.equal(back.w, front.w)
   assert.equal(back.h, front.h)
   assert.equal(back.mirrorX, true)
   assert.equal(back.suppressRuler, true)
  }
 }
 assert.equal(group.details.sizes.length, 3)
})

test('small chains reserve actual artwork height instead of 120 units per member', () => {
 const assets = [asset('c1','串串',{},'g'),asset('c2','串串',{},'g')].map(a=>({...a,width:90,height:100,sourceGroupWidthMm:22.5,sourceGroupHeightMm:25}))
 const [page]=paginateAssets(assets)
 assert.ok(page.imageGroups[0].height < 180)
 const [a,b]=page.items
 assert.ok(b.y-b.h/2 >= a.y+a.h/2)
 assert.ok(Math.abs(a.h-25*PAPER_WIDTH/210)<1e-7)
})

test('backfill reuses an empty ordinary column before adding page-tail sections', () => {
 const ordinary=Array.from({length:5},(_,i)=>asset('o'+i,'Keychains',{'Print Option':'Double Sided Different Design'}))
 const holder=['Example','Front','Inside','Back'].map(id=>asset(id,'Shaker',{},'h'))
 const pages=paginateAssets([...ordinary,...holder,asset('tail')])
 const first=pages[0]
 const moved=first.imageGroups.find(group=>group.itemIds.includes('item-tail'))
 assert.ok(moved)
 assert.equal(moved.y,first.imageGroups[3].y)
 assert.ok(moved.x>first.imageGroups[4].x)
 assert.equal(first.headerBlocks.length,1)
 for(const page of pages) for(const group of page.imageGroups) {
  assert.ok(group.y+group.height<=PAPER_HEIGHT-defaultLayoutBounds.bottom+1e-7)
  for(const other of page.imageGroups) if(group!==other) assert.ok(group.x+group.width<=other.x+1e-7 || other.x+other.width<=group.x+1e-7 || group.y+group.height<=other.y+1e-7 || other.y+other.height<=group.y+1e-7)
 }
})
test('later fitting groups backfill earlier pages without shrinking or losing headers', () => {
 const ordinary=Array.from({length:5},(_,i)=>asset('o'+i,'Keychains',{'Print Option':'Double Sided Different Design'}))
 const holder=['Example','Front','Inside','Back'].map(id=>asset(id,'Shaker',{},'h'))
 const chain=[{...asset('small','串串',{},'c'),width:80,height:80,sourceGroupWidthMm:20,sourceGroupHeightMm:20}]
 const pages=paginateAssets([...ordinary,...holder,...chain])
 assert.ok(pages[0].items.some(i=>i.assetId==='small'),'small chain should use the earlier page tail, skipping the oversized holder')
 const g=pages[0].imageGroups.find(g=>g.itemIds.includes('item-small'))
 assert.ok(pages[0].headerBlocks.some(h=>h.y<g.y && h.columns.length===3))
 assert.equal(pages.flatMap(p=>p.items).filter(i=>i.assetId==='small').length,1)
 assert.equal(pages[0].items.find(i=>i.assetId==='small').h,20*PAPER_WIDTH/210)
})

test('same-design chains use three group columns; different-design chains use two', () => {
 for(const [option,columns] of [['Double Sided Same Design',3],['Double Sided Different Design',2]]) {
  const assets=Array.from({length:columns+1},(_,g)=>Array.from({length:2},(_,i)=>({...asset(`${g}-${i}`,'串串',{'Print Option':option},`chain-${g}`),width:80,height:100,sourceGroupWidthMm:20,sourceGroupHeightMm:25,productGroupPosition:i}))).flat()
  const [page]=paginateAssets(assets)
  const groups=page.imageGroups
  assert.equal(page.headerBlocks[0].columns.length,columns)
  assert.equal(new Set(groups.slice(0,columns).map(g=>g.x)).size,columns)
  assert.equal(new Set(groups.slice(0,columns).map(g=>g.y)).size,1)
  assert.ok(groups[columns].y>groups[0].y)
  for(const group of groups) {
   const originals=page.items.filter(item=>group.itemIds.includes(item.id)&&!item.derivedFrom)
   assert.equal(originals[0].x,originals[1].x)
   assert.ok(originals[1].y-originals[1].h/2>=originals[0].y+originals[0].h/2)
   assert.equal(group.details.sizes.length,2)
   for(const front of originals) {
    const back=page.items.find(item=>item.derivedFrom===front.id)
    if(columns===2) { assert.ok(back.x>front.x);assert.equal(back.y,front.y);assert.equal(back.w,front.w);assert.equal(back.h,front.h) }
    else assert.equal(back,undefined)
   }
  }
 }
})

test('Size and QT export at the same font size with unbroken values in every unit', async () => {
 const { imageDetailsLayout, sizeLabelWidth }=await import('../src/modules/schematic/services/imageDetailsLayoutService.ts')
 const a=asset('long','Keychains',{Size:'123.4 mm'})
 const [page]=paginateAssets([a])
 const group=page.imageGroups[0]
 for(const rulerUnit of ['mm','cm','in']) {
  group.details.size=dimensionForItem(a,{rulerUnit}).label
  const layout=imageDetailsLayout(group)
  assert.equal(layout.fields.filter(field=>field.key.startsWith('size')).length,1)
  assert.ok(sizeLabelWidth(group.details.size,layout.fontSize)<=layout.width)
  const svg=pageSvg(page,new Map([[a.id,a]]))
  const sizeFont=svg.match(/font-size="([^"]+)"[^>]*>Size: [^<]+<\/text>/)?.[1]
  const qtFont=svg.match(/font-size="([^"]+)"[^>]*>QT: [^<]+<\/text>/)?.[1]
  assert.ok(sizeFont); assert.equal(sizeFont,qtFont)
 }
})

test('Shaker keeps original-size cap and default role layout for every member', () => {
 for (const name of ['Shaker','摇摇乐']) {
  const assets=['Example','Front','Inside','Back','extra'].map(id=>({...asset(id,name,{},'shaker'),width:40,height:20,sourceGroupWidthMm:10,sourceGroupHeightMm:5}))
  const [page]=paginateAssets(assets)
  assert.equal(page.imageGroups[0].height,(PAPER_HEIGHT-defaultLayoutBounds.top-defaultLayoutBounds.bottom)/2)
  assert.deepEqual(page.items.slice(0,4).map(i=>i.caption),['Example','Front','Inside','Back'])
  for(const item of page.items) {
   assert.ok(item.w<=10*PAPER_WIDTH/210+1e-7)
   assert.ok(item.h<=5*PAPER_WIDTH/210+1e-7)
   assert.ok(Math.abs(item.w/item.h-2)<1e-7)
  }
 }
})
