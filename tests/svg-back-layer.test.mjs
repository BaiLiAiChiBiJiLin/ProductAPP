import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { backLayerSvg } from '../src/modules/schematic/services/svgBackLayerService.ts'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { pageSvg } from '../src/model.ts'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 30 100 120"><defs><clipPath id="clip"><rect x="20" y="30" width="100" height="120"/></clipPath></defs><g id="design" transform="translate(2 3)"><g clip-path="url(#clip)"><image id="first" href="back.png" width="100" height="120"/></g><g id="back"><image id="last" href="front.png"><title>front</title></image></g></g><path id="cutline" d="M20 30h100"/></svg>'
test('first image survives intact inside its original transforms and clip; later complete image elements are removed',()=>{
 const result=backLayerSvg(svg)
 const doc=new JSDOM(result,{contentType:'image/svg+xml'}).window.document
 assert.equal(doc.querySelectorAll('image').length,1)
 assert.equal(doc.querySelector('image').id,'first')
 assert.equal(doc.querySelector('#design').getAttribute('style'),null)
 assert.equal(doc.querySelector('image').parentElement.getAttribute('clip-path'),'url(#clip)')
 assert.ok(doc.querySelector('#cutline'));assert.ok(doc.querySelector('#clip'))
 assert.equal(doc.documentElement.getAttribute('viewBox'),'20 30 100 120')
 assert.doesNotMatch(result,/scale\(-1/)
 assert.equal(backLayerSvg(result),result)
})
test('actual export embeds only first image for Back and applies exactly one outside mirror',()=>{
 const a={id:'a',name:'a',productId:'key',width:100,height:120,svg,attributes:{'Print Option':'Double Sided Different Design'}}
 const [page]=paginateAssets([a]);const doc=new JSDOM(pageSvg(page,new Map([['a',a]])),{contentType:'image/svg+xml'}).window.document
 const back=[...doc.querySelectorAll('image')].find(image=>image.getAttribute('transform')?.includes('scale(-1 1)'))
 assert.ok(back)
 const nested=Buffer.from(back.getAttribute('href').split(',')[1],'base64').toString()
 const inner=new JSDOM(nested,{contentType:'image/svg+xml'}).window.document
 assert.equal(inner.querySelectorAll('image').length,1);assert.equal(inner.querySelector('image').id,'first')
 assert.doesNotMatch(nested,/scale\(-1/)
})
test('standee back can fit its first authored image viewport without changing default back extraction',()=>{
 const fitted=backLayerSvg(svg,true)
 const doc=new JSDOM(fitted,{contentType:'image/svg+xml'}).window.document
 assert.equal(doc.documentElement.getAttribute('viewBox'),'20 30 100 120')
 const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><image x="200" y="100" width="300" height="500" href="back.png"/><image x="0" y="0" width="1000" height="1000" href="front.png"/></svg>'
 const cropped=backLayerSvg(source,true)
 assert.match(cropped,/viewBox="200 100 300 500"/)
 assert.equal((cropped.match(/<image\b/g) ?? []).length,1)
})
