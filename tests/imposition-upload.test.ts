import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importImpositionSvg, impositionImportLabel, impositionImportPercent } from '../src/modules/imposition/impositionUploadService'

const api = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), open: vi.fn(), stop: vi.fn(), isTauri: vi.fn(() => true) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: api.isTauri }))
vi.mock('@tauri-apps/api/event', () => ({ listen: api.listen }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: api.open }))

beforeEach(() => {
  vi.clearAllMocks()
  api.isTauri.mockReturnValue(true)
  api.listen.mockResolvedValue(api.stop)
  api.open.mockResolvedValue('C:/art/订单.svg')
})

describe('temporary imposition SVG upload', () => {
  it('returns an isolated metadata job and only forwards its own progress', async () => {
    const record = { id: 'temporary-job', temporary: true, images: [{ filePath: 'stage/a.svg', attributes: { QT: '1' } }] }
    const progress = vi.fn()
    api.invoke.mockImplementation(async (command: string, args: { requestId: string }) => {
      expect(command).toBe('import_imposition_svg')
      const callback = api.listen.mock.calls[0][1]
      callback({ payload: { requestId: 'other-request', phase: 'generate', completed: 99, total: 99 } })
      callback({ payload: { requestId: args.requestId, phase: 'generate', completed: 84, total: 84 } })
      return record
    })
    expect(await importImpositionSvg(progress)).toBe(record)
    expect(api.invoke).toHaveBeenCalledWith('import_imposition_svg', { path: 'C:/art/订单.svg', requestId: expect.any(String) })
    expect(api.listen).toHaveBeenCalledWith('imposition-import-progress', expect.any(Function))
    expect(progress.mock.calls).toEqual([[{ phase: 'parse', completed: 0, total: 1 }], [{ phase: 'generate', completed: 84, total: 84 }]])
    expect(api.stop).toHaveBeenCalledTimes(1)
  })

  it('does not import or allocate listeners when the file picker is cancelled', async () => {
    api.open.mockResolvedValue(null)
    expect(await importImpositionSvg()).toBeNull()
    expect(api.invoke).not.toHaveBeenCalled()
    expect(api.listen).not.toHaveBeenCalled()
  })

  it('supports a dropped SVG path and removes progress listeners after failure', async () => {
    api.invoke.mockRejectedValue(new Error('SVG 无法解析'))
    await expect(importImpositionSvg(undefined, 'D:/input/large.SVG')).rejects.toThrow('SVG 无法解析')
    expect(api.open).not.toHaveBeenCalled()
    expect(api.stop).toHaveBeenCalledTimes(1)
  })

  it('rejects other formats before invoking the backend', async () => {
    await expect(importImpositionSvg(undefined, 'D:/input/file.pdf')).rejects.toThrow('仅支持 SVG 文件')
    expect(api.invoke).not.toHaveBeenCalled()
  })

  it('reports the actual parsing or staging phase with bounded progress', () => {
    expect(impositionImportLabel({ phase: 'parse', completed: 4, total: 84 })).toContain('4/84')
    expect(impositionImportLabel({ phase: 'generate', completed: 10, total: 84 })).toContain('保存临时图片')
    expect(impositionImportPercent({ phase: 'parse', completed: 1, total: 1 })).toBe(35)
    expect(impositionImportPercent({ phase: 'generate', completed: 84, total: 84 })).toBe(100)
    expect(impositionImportPercent({ phase: 'generate', completed: 200, total: 84 })).toBe(100)
  })
})
