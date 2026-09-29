import { expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), unlisten: vi.fn(), render: vi.fn(() => '<svg/>') }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => mocks.unlisten }))
vi.mock('../src/model', () => ({ pageRasterSvg: mocks.render, pageSvg: mocks.render }))
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
