import test from 'node:test'
import assert from 'node:assert/strict'
import { exportFileName } from '../src/modules/schematic/services/exportFileName.ts'
test('export keeps original SVG name and replaces only its extension', () => {
 for (const format of ['pdf','svg','png','jpg']) assert.equal(exportFileName([{sourceFileName:'订单 · 最终版.SVG',name:'拆图'}],format),`订单 · 最终版.${format}`)
 assert.equal(exportFileName([{name:'Lapitalii Klein马口铁 · _123'}],'pdf'),'Lapitalii Klein马口铁.pdf')
 assert.equal(exportFileName([],'pdf'),'示意图.pdf')
 assert.equal(exportFileName([{sourceFileName:'first.svg'},{sourceFileName:'second.svg'}],'png'),'first.png')
})
