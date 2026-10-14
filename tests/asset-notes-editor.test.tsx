import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Asset } from '../src/model'
import AssetNotesEditor from '../src/modules/schematic/components/AssetNotesEditor'
import { applyProductAttributePatch } from '../src/modules/schematic/services/productOptionRules'

const native = vi.hoisted(() => ({ open: vi.fn(), invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: native.open }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
const original: Asset = { id: 'old', name: '图', productId: 'p', width: 10, height: 20, svg: '<svg/>', previewUrl: '', thumbnailUrl: '', attributes: { QT: '0' }, note: '文字备注', noteImage: 'legacy.png' }
function Editor() {
  const [asset, setAsset] = useState(original)
  return <><AssetNotesEditor assets={[asset]} onAssign={patch => setAsset(current => applyProductAttributePatch(current, patch))}/><output aria-label="已保存备注">{JSON.stringify(asset)}</output></>
}
beforeEach(() => { vi.clearAllMocks(); native.invoke.mockImplementation(async (_command, { path }) => `data:${path}`) })
afterEach(cleanup)
const saved = () => JSON.parse(screen.getByLabelText('已保存备注').textContent!) as Asset

test('upload up to three, name any image or leave blank, delete and add again', async () => {
  native.open.mockResolvedValueOnce(['two.png', 'three.svg']).mockResolvedValueOnce(['new.png'])
  render(<Editor/>)
  expect(screen.getByLabelText('备注图片 1 名称')).toHaveProperty('value', '')
  fireEvent.click(screen.getByRole('button', { name: '上传备注图片' }))
  await screen.findByLabelText('备注图片 3 名称')
  expect(native.invoke).toHaveBeenCalledTimes(2)
  fireEvent.change(screen.getByLabelText('备注图片 1 名称'), { target: { value: '正面示例' } })
  fireEvent.change(screen.getByLabelText('备注图片 3 名称'), { target: { value: '背面示例' } })
  expect(saved().noteImages?.map(image => image.name)).toEqual(['正面示例', '', '背面示例'])
  expect(screen.getByRole('button', { name: '上传备注图片' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: '删除备注图片 2' }))
  fireEvent.click(screen.getByRole('button', { name: '上传备注图片' }))
  await waitFor(() => expect(saved().noteImages?.map(image => image.src)).toEqual(['legacy.png', 'data:three.svg', 'data:new.png']))
  expect(saved().note).toBe('文字备注')
  expect(saved().attributes).toEqual({ QT: '0' })
  fireEvent.change(screen.getByLabelText('备注图片 1 名称'), { target: { value: '' } })
  expect(saved().noteImages?.[0].name).toBe('')
})

test('too many files, cancellation and read failure preserve the existing notes', async () => {
  native.open.mockResolvedValueOnce(['a.png', 'b.png', 'c.png']).mockResolvedValueOnce(null).mockResolvedValueOnce(['bad.png'])
  render(<Editor/>)
  fireEvent.click(screen.getByRole('button', { name: '上传备注图片' }))
  await screen.findByText('备注图片最多 3 张，还可以添加 2 张。')
  expect(native.invoke).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '上传备注图片' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '上传备注图片' })).toHaveProperty('disabled', false))
  native.invoke.mockRejectedValueOnce(new Error('文件无法读取'))
  fireEvent.click(screen.getByRole('button', { name: '上传备注图片' }))
  await screen.findByRole('alert')
  expect(saved()).toEqual(original)
})

test('deleting the last legacy note clears both representations', () => {
  render(<Editor/>)
  fireEvent.click(screen.getByRole('button', { name: '删除备注图片 1' }))
  expect(saved().noteImages).toEqual([])
  expect(saved().noteImage).toBe('')
  expect(screen.queryByLabelText('备注图片 1 名称')).toBeNull()
})

test('an in-flight upload cannot write into a different selected asset', async () => {
  let resolveImage!: (src: string) => void
  native.open.mockResolvedValue(['new.png'])
  native.invoke.mockImplementation(() => new Promise<string>(resolve => { resolveImage = resolve }))
  const assign = vi.fn()
  const { rerender } = render(<AssetNotesEditor assets={[original]} onAssign={assign}/>)
  fireEvent.click(screen.getByRole('button', { name: '上传备注图片' }))
  await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1))
  rerender(<AssetNotesEditor assets={[{ ...original, id: 'different' }]} onAssign={assign}/>)
  await act(async () => resolveImage('new-data'))
  expect(assign).not.toHaveBeenCalled()
})
