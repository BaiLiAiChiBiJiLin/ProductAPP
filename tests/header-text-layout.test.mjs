import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { HEADER_BLOCK_HEIGHT, headerCells, headerCellLines, pageSvg, pageRasterSvg } from '../src/model.ts'
import { HEADER_TEXT_FONT_SIZE, HEADER_TEXT_LINE_HEIGHT, headerTextLayout } from '../src/modules/schematic/services/headerTextLayoutService.ts'

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`)
const wide = { id: 'wide', x: 20, y: 110, width: 460, columns: [{ id: 'wide-column', imageMode: 'photo', detailLabel: 'Size/QT/Finish/Accessory' }] }
const narrow = { id: 'three-columns', x: 20, y: 210, width: 460, columns: Array.from({ length: 3 }, (_, index) => ({ id: `column-${index}`, imageMode: 'photo', detailLabel: 'Size/QT/Finish/Accessory' })) }

test('wide and three-column captions keep one common line height and center their whole text block', () => {
  assert.equal(HEADER_BLOCK_HEIGHT, 26)
  assert.equal(HEADER_TEXT_FONT_SIZE, 8.5)
  assert.equal(HEADER_TEXT_LINE_HEIGHT, 11)
  const detailLines = [wide, narrow].map(block => headerCellLines(headerCells(block).find(cell => cell.role === 'details')))
  assert.deepEqual(detailLines.map(lines => lines.length), [1, 2])
  for (const block of [wide, narrow]) for (const cell of headerCells(block)) {
    const layout = headerTextLayout(headerCellLines(cell), HEADER_BLOCK_HEIGHT)
    assert.ok(layout.every(line => line.height === 11))
    const top = layout[0].y
    const bottom = layout.at(-1).y + layout.at(-1).height
    close(top, HEADER_BLOCK_HEIGHT - bottom)
    close((top + bottom) / 2, 13)
    for (let index = 1; index < layout.length; index++) close(layout[index].y - layout[index - 1].y, 11)
  }
})

test('SVG and raster/PDF headers keep identical centered text spacing for full-width and three-column rows', () => {
  const page = { id: 1, name: 'header QA', items: [], headerBlocks: [wide, narrow] }
  for (const render of [pageSvg, pageRasterSvg]) {
    const document = new JSDOM(render(page, new Map()), { contentType: 'image/svg+xml' }).window.document
    for (const block of page.headerBlocks) {
      const group = document.querySelector(`g[transform="translate(${block.x} ${block.y})"]`)
      assert.ok(group)
      const cells = [...group.querySelectorAll(':scope > svg')]
      assert.equal(cells.length, headerCells(block).length)
      for (const cell of cells) {
        assert.equal(Number(cell.getAttribute('height')), 26)
        const lines = [...cell.querySelectorAll('text')]
        assert.ok(lines.every(line => Number(line.getAttribute('font-size')) === 8.5))
        const centers = lines.map(line => Number(line.getAttribute('y')) - 8.5 * .35)
        close((centers[0] + centers.at(-1)) / 2, 13)
        for (let index = 1; index < centers.length; index++) close(centers[index] - centers[index - 1], 11)
      }
    }
  }
})
