import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import type { ComponentProps } from 'react'
import OptionImageEditor from '../src/modules/settings/product-options/OptionImageEditor'
import ProductOptionsSettings from '../src/modules/settings/product-options/ProductOptionsSettings'
import { initialBundle } from '../src/modules/settings/product-options/service'
import { allProducts, clone, optionFor } from '../src/modules/settings/product-options/model'
import { OptionImageUploadError } from '../src/modules/settings/product-options/imageUpload'
import { MAX_OPTION_IMAGE_BYTES } from '../src/modules/settings/product-options/imageUploadPolicy'

const mocks = vi.hoisted(() => ({ upload: vi.fn(), invoke: vi.fn(), native: false }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => mocks.native, invoke: mocks.invoke }))
vi.mock('../src/modules/settings/product-options/imageUpload', async importOriginal => ({ ...await importOriginal<typeof import('../src/modules/settings/product-options/imageUpload')>(), uploadProductOptionImage: mocks.upload }))

const uploaded = { url: 'https://images.example.test/uploads/product-options/materialId/C1/new.png', objectKey: 'uploads/product-options/materialId/C1/new.png' }
const oldImage = 'https://images.example.test/old.png'
const png = () => new File(['image bytes'], 'test.png', { type: 'image/png' })
const select = (file: File, id = 'C1') => fireEvent.change(screen.getByLabelText(`${id}选择图片`), { target: { files: [file] } })
const renderEditor = (onChange = vi.fn(), props: Partial<ComponentProps<typeof OptionImageEditor>> = {}) => render(<ConfigProvider theme={{ token: { motion: false } }}><OptionImageEditor entityKey="materialId" valueId="C1" label="材质" image={oldImage} onChange={onChange} {...props}/></ConfigProvider>)
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  const original = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => original(element))
})
beforeEach(() => { mocks.upload.mockReset(); mocks.invoke.mockReset(); mocks.native = false })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('uploads directly, preserves the old image while pending, and blocks duplicate uploads', async () => {
  const task = deferred<typeof uploaded>(); mocks.upload.mockReturnValue(task.promise)
  const changed = vi.fn(); const busy = vi.fn()
  renderEditor(changed, { onUploadStateChange: busy })
  select(png()); select(png())
  expect(mocks.upload).toHaveBeenCalledTimes(1)
  expect(mocks.upload).toHaveBeenCalledWith(expect.any(File), { entityKey: 'materialId', valueId: 'C1' })
  expect(screen.getByRole('img', { name: '材质图片' }).getAttribute('src')).toBe(oldImage)
  expect((screen.getByRole('button', { name: 'C1替换图片' }) as HTMLButtonElement).disabled).toBe(true)
  expect(changed).not.toHaveBeenCalled()
  await act(async () => task.resolve(uploaded))
  expect(changed).toHaveBeenCalledWith(uploaded.url)
  expect(screen.getByRole('status').textContent).toBe('已上传，请保存配置')
  expect(busy.mock.calls).toEqual([[true], [false]])
})

test('failed uploads keep the previous URL and allow choosing the same file again', async () => {
  const changed = vi.fn()
  mocks.upload.mockRejectedValueOnce(new OptionImageUploadError('OSS 拒绝上传，请检查密钥和上传权限。')).mockResolvedValueOnce(uploaded)
  renderEditor(changed)
  const file = png(); select(file)
  await screen.findByRole('alert')
  expect(changed).not.toHaveBeenCalled()
  expect(screen.getByRole('img', { name: '材质图片' }).getAttribute('src')).toBe(oldImage)
  select(file)
  await waitFor(() => expect(changed).toHaveBeenCalledWith(uploaded.url))
  expect(screen.queryByRole('alert')).toBeNull()
})

test('invalid image types, empty files and oversized images are rejected before upload', () => {
  renderEditor()
  select(new File(['<svg/>'], 'unsafe.svg', { type: 'image/svg+xml' }))
  expect(screen.getByRole('alert').textContent).toMatch(/PNG/)
  select(new File([], 'empty.png', { type: 'image/png' }))
  expect(screen.getByRole('alert').textContent).toMatch(/为空/)
  const oversized = png(); Object.defineProperty(oversized, 'size', { value: MAX_OPTION_IMAGE_BYTES + 1 })
  select(oversized)
  expect(screen.getByRole('alert').textContent).toMatch(/4 MB/)
  expect(mocks.upload).not.toHaveBeenCalled()
})

test('late upload results never update a different option or an unmounted card', async () => {
  const task = deferred<typeof uploaded>(); mocks.upload.mockReturnValue(task.promise)
  const first = vi.fn(); const second = vi.fn(); const busy = vi.fn()
  const view = renderEditor(first, { onUploadStateChange: busy })
  select(png())
  view.rerender(<OptionImageEditor entityKey="holoFilmId" valueId="M1" label="膜" image={oldImage} onChange={second}/>)
  await act(async () => task.resolve(uploaded))
  expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled()
  expect(busy.mock.calls).toEqual([[true], [false]])
  const another = deferred<typeof uploaded>(); mocks.upload.mockReturnValue(another.promise)
  select(png(), 'M1'); view.unmount()
  await act(async () => another.resolve(uploaded))
  expect(second).not.toHaveBeenCalled()
})

test('removing an image only clears its configured reference', () => {
  const changed = vi.fn(); renderEditor(changed)
  fireEvent.click(screen.getByRole('button', { name: 'C1移除图片' }))
  expect(changed).toHaveBeenCalledWith('')
  expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled()
})

test('settings block save and refresh during upload then save the new URL under the original explicit entity', async () => {
  mocks.native = true
  const data = clone(initialBundle)
  optionFor(allProducts(data.main)[0], 'Material')!.deleted = false
  mocks.invoke.mockImplementation(async (command, args) => command === 'load_product_option_settings' ? { bundle: data, version: 'v1', directory: 'fixture' } : { bundle: args.bundle, version: 'v2', directory: 'fixture' })
  const task = deferred<typeof uploaded>(); mocks.upload.mockReturnValue(task.promise)
  const busy = vi.fn()
  render(<ConfigProvider theme={{ token: { motion: false } }}><ProductOptionsSettings onBusyChange={busy}/></ConfigProvider>)
  fireEvent.click(await screen.findByRole('button', { name: /^贴纸材质/ }))
  select(png())
  expect((screen.getByRole('button', { name: '保 存' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '刷 新' }) as HTMLButtonElement).disabled).toBe(true)
  expect((document.querySelector('.po-fields') as HTMLFieldSetElement).disabled).toBe(true)
  await act(async () => task.resolve(uploaded))
  fireEvent.click(screen.getByRole('button', { name: '保 存' }))
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('save_product_option_settings', expect.anything()))
  const saved = mocks.invoke.mock.calls.find(call => call[0] === 'save_product_option_settings')![1].bundle
  expect(saved.catalogs['materials.json'].values.find((value: { materialId: string }) => value.materialId === 'C1').image).toBe(uploaded.url)
  expect(busy.mock.calls).toEqual([[true], [false], [true], [false]])
})

describe('upload transport', () => {
  const actual = () => vi.importActual<typeof import('../src/modules/settings/product-options/imageUpload')>('../src/modules/settings/product-options/imageUpload')

  test('desktop forwards bytes and explicit identity without exposing configuration', async () => {
    mocks.native = true; mocks.invoke.mockResolvedValue(uploaded)
    const service = await actual()
    await expect(service.uploadProductOptionImage(png(), { entityKey: 'materialId', valueId: 'C1' })).resolves.toEqual(uploaded)
    expect(mocks.invoke).toHaveBeenCalledWith('upload_product_option_image', { input: { entityKey: 'materialId', valueId: 'C1', contentType: 'image/png', contentBase64: btoa('image bytes') } })
  })

  test('browser sends the binary file to the same-origin authenticated endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(uploaded), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const service = await actual(); const file = png()
    await expect(service.uploadProductOptionImage(file, { entityKey: 'materialId', valueId: 'C1' })).resolves.toEqual(uploaded)
    expect(fetcher).toHaveBeenCalledWith('/api/product-options/images?entityKey=materialId&valueId=C1', expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: file, headers: { 'Content-Type': 'image/png' } }))
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  test('transport validates server URLs and keeps server HTML and native error details out of the UI', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...uploaded, url: 'javascript:alert(1)' }), { status: 200 })).mockResolvedValueOnce(new Response('<html>private server error</html>', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const service = await actual(); const reference = { entityKey: 'materialId', valueId: 'C1' }
    await expect(service.uploadProductOptionImage(png(), reference)).rejects.toThrow('图片地址无效')
    await expect(service.uploadProductOptionImage(png(), reference)).rejects.toThrow('图片上传失败，请稍后重试')
    mocks.native = true; mocks.invoke.mockRejectedValue('private storage diagnostics')
    await expect(service.uploadProductOptionImage(png(), reference)).rejects.toThrow('图片上传失败，请检查网络后重试')
  })
})
