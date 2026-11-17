import test from 'node:test'
import assert from 'node:assert/strict'
import { isEmptyArrangementPage, removeEmptyArrangementPage } from '../src/modules/schematic/services/emptyPageService.ts'

test('only an empty page can be removed and remaining page identities stay stable', () => {
  const filled = { id: 5, name: '已有页', items: [{ id: 'art' }] }
  const empty = { id: 8, name: '空页', items: [] }
  const pages = [filled, empty]
  assert.deepEqual(removeEmptyArrangementPage(pages, 8), [filled])
  assert.equal(removeEmptyArrangementPage(pages, 5), pages)
  assert.equal(pages.length, 2)
  assert.equal(removeEmptyArrangementPage([empty], 8).length, 1)
})

test('text, manual rulers and header blocks prevent a page being treated as empty', () => {
  for (const content of [{ annotations: [{ kind: 'text', text: '备注' }] }, { annotations: [{ kind: 'ruler' }] }, { headerBlocks: [{ id: 'header' }] }, { imageGroups: [{ id: 'group' }] }]) {
    const page = { id: 2, name: '编辑页', items: [], ...content }
    assert.equal(isEmptyArrangementPage(page), false)
    const pages = [{ id: 1, name: '空页', items: [] }, page]
    assert.equal(removeEmptyArrangementPage(pages, 2), pages)
  }
})
