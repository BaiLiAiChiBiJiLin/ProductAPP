import { expect, test, vi } from 'vitest'
import type { Page } from '../src/model'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), unlisten: vi.fn(), render: vi.fn((_page: Page) => '<svg/>') }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => mocks.unlisten }))
vi.mock('../src/model', async importOriginal => ({ ...await importOriginal<object>(), pageRasterSvg: mocks.render, pageSvg: mocks.render }))
vi.mock('../src/modules/schematic/services/accessoryFrameService.ts', () => ({ prepareAccessoryFrames: async () => {} }))
import { exportPdf } from '../src/modules/schematic/services/exportService'

test('PDF pages transfer sequentially and temporary pages are cleaned on success and failure', async () => {
 for (const fail of [false,true]) {
  mocks.invoke.mockReset();mocks.render.mockClear();mocks.unlisten.mockClear()
  let transferred=0
  mocks.invoke.mockImplementation(async (command: string) => {
   if(command==='stage_pdf_page') { expect(mocks.render).toHaveBeenCalledTimes(++transferred); if(fail) throw new Error('write failed') }
  })
  const job=exportPdf([{id:1,name:'one',items:[]},{id:2,name:'two',items:[]}],[],'test.pdf')
  if(fail) await expect(job).rejects.toThrow('write failed'); else await job
  const commands=mocks.invoke.mock.calls.map(call=>call[0])
  expect(commands).toEqual(fail ? ['stage_pdf_page','clear_pdf_pages'] : ['stage_pdf_page','stage_pdf_page','export_staged_pdf','clear_pdf_pages'])
  expect(mocks.unlisten).toHaveBeenCalledOnce()
 }
})

test('PDF uses reordered thumbnail order with consecutive printed page numbers and unchanged page identities', async () => {
  mocks.invoke.mockReset().mockResolvedValue(undefined)
  mocks.render.mockReset().mockImplementation(page => `<svg><text>${page.id}:${page.name}</text></svg>`)
  const pages: Page[] = [
    { id: 8, name: 'Moved first', items: [], annotations: [{ id: 'text-eight', kind: 'text', x: 20, y: 30, text: '保留文字', color: '#112233', fontSize: 12 }] },
    { id: 2, name: 'Moved second', items: [], backgroundColor: '#abcdef' },
    { id: 4, name: 'Moved third', items: [] },
  ]
  const original = structuredClone(pages)
  await exportPdf(pages, [], 'ordered.pdf')

  expect(mocks.render.mock.calls.map(([page]) => [page.id, page.name])).toEqual([
    [1, 'Moved first'], [2, 'Moved second'], [3, 'Moved third'],
  ])
  expect(mocks.render.mock.calls[0][0].annotations).toEqual(pages[0].annotations)
  expect(mocks.render.mock.calls[1][0].backgroundColor).toBe('#abcdef')
  const staged = mocks.invoke.mock.calls.filter(([command]) => command === 'stage_pdf_page').map(([, args]) => args)
  expect(staged.map(args => args.svg)).toEqual([
    '<svg><text>1:Moved first</text></svg>',
    '<svg><text>2:Moved second</text></svg>',
    '<svg><text>3:Moved third</text></svg>',
  ])
  expect(mocks.invoke).toHaveBeenCalledWith('export_staged_pdf', { output: 'ordered.pdf', ids: staged.map(args => args.id) })
  expect(pages).toEqual(original)
})
