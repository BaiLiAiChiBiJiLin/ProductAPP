// @vitest-environment node
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { buildImageObjectKey, imageExtension, MAX_IMAGE_BYTES, readOssConfig, signImagePut, uploadOptionImage } from '../src/modules/settings/product-options/server/ossUpload.server'
import { createImageUploadHandler } from '../src/modules/settings/product-options/server/imageUploadHandler.server'

const settings = { OSS_ACCESS_KEY_ID: 'fixtureId', OSS_ACCESS_KEY_SECRET: 'fixture-secret', OSS_BUCKET: 'fakestar-oss', OSS_REGION: 'oss-us-west-1', OSS_ENDPOINT: 'fakestar-oss.oss-us-west-1.aliyuncs.com' }
const config = readOssConfig(settings)
const reference = { entityKey: 'techniqueId', valueId: 'G1' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrfkAAAAASUVORK5CYII=', 'base64')
const endpoint = 'https://config.example/api/product-options/images?entityKey=techniqueId&valueId=G1'
const request = (overrides: RequestInit = {}, url = endpoint) => new Request(url, { method: 'POST', headers: { origin: 'https://config.example', 'content-type': 'image/png' }, body: png, ...overrides })

describe('product option OSS uploads', () => {
  it('normalizes a region endpoint or bucket endpoint without duplicating the bucket', () => {
    expect(config.host).toBe('fakestar-oss.oss-us-west-1.aliyuncs.com')
    expect(readOssConfig({ ...settings, OSS_ENDPOINT: 'https://oss-us-west-1.aliyuncs.com/' }).host).toBe(config.host)
    expect(readOssConfig({ ...settings, OSS_ENDPOINT: 'cdn.example.com', OSS_ENDPOINT_IS_CNAME: 'true' }).host).toBe('cdn.example.com')
    expect(readOssConfig({ ...settings, OSS_ENDPOINT: 'oss-us-west-1.aliyuncs.com', OSS_ENDPOINT_IS_CNAME: true }).host).toBe(config.host)
  })
  it('rejects mismatched domains, URL credentials, plaintext endpoints and invalid prefixes', () => {
    for (const endpoint of ['http://oss-us-west-1.aliyuncs.com', 'https://user:password@oss-us-west-1.aliyuncs.com', 'https://oss-cn-beijing.aliyuncs.com', 'https://oss-us-west-1.aliyuncs.com/path']) expect(() => readOssConfig({ ...settings, OSS_ENDPOINT: endpoint })).toThrow()
    expect(() => readOssConfig({ ...settings, OSS_OBJECT_PREFIX: '../outside' })).toThrow()
    expect(() => readOssConfig({ ...settings, OSS_ACCESS_KEY_SECRET: '' })).toThrow('未配置 OSS_ACCESS_KEY_SECRET')
  })
  it('namespaces explicit entity ownership and produces unique object keys', () => {
    const a = buildImageObjectKey(config, { entityKey: 'accessoryStyleId', valueId: 'P1' }, 'png')
    const b = buildImageObjectKey(config, { entityKey: 'accessoryStyleId', valueId: 'P1' }, 'png')
    expect(a).toMatch(/^uploads\/product-options\/accessoryStyleId\/P1\/[a-f0-9-]+\.png$/)
    expect(a).not.toBe(b)
    expect(buildImageObjectKey(readOssConfig({ ...settings, OSS_OBJECT_PREFIX: '/store/config/' }), reference, 'png')).toMatch(/^store\/config\/uploads\/product-options\/techniqueId\/G1\//)
    expect(() => buildImageObjectKey(config, { entityKey: 'id', valueId: 'P1' }, 'png')).toThrow()
    expect(() => buildImageObjectKey(config, { entityKey: 'techniqueId', valueId: '../G1' }, 'png')).toThrow()
  })
  it('validates actual file signatures, declared type and maximum size', () => {
    expect(imageExtension(png, 'image/png')).toBe('png')
    expect(() => imageExtension(png, 'image/jpeg')).toThrow()
    expect(() => imageExtension(Buffer.from('<svg/>'), 'image/png')).toThrow()
    expect(() => imageExtension(Buffer.alloc(0), 'image/png')).toThrow()
    expect(() => imageExtension(Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/png')).toThrow('4 MB')
  })
  it('signs the non-overwrite header using a fixed independent HMAC fixture', () => {
    expect(signImagePut(config, 'uploads/product-options/techniqueId/G1/fixture.png', 'image/png', 'Fri, 06 Nov 2026 00:00:00 GMT')).toBe('OSS fixtureId:/vgO/Ss0C6RVHvXoh0tO3h39+Zc=')
  })
  it('uploads raw bytes with a timeout, non-overwrite protection and no redirects', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))
    const result = await uploadOptionImage(config, reference, png, 'image/png', transport)
    const [url, init] = transport.mock.calls[0]
    expect(result.url).toBe(url)
    expect(result.url).not.toMatch(/Signature|fixture-secret/)
    expect(result.objectKey).toContain('techniqueId/G1/')
    expect(init).toMatchObject({ method: 'PUT', redirect: 'error', headers: { 'Content-Type': 'image/png', 'x-oss-forbid-overwrite': 'true' } })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.body).toEqual(new Uint8Array(png))
  })
  it('does not expose OSS response bodies or network error details', async () => {
    const forbidden = vi.fn<typeof fetch>().mockResolvedValue(new Response('private diagnostics fixture-secret', { status: 403 }))
    await expect(uploadOptionImage(config, reference, png, 'image/png', forbidden)).rejects.toThrow('OSS 上传失败（HTTP 403）')
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new Error('private diagnostics fixture-secret'))
    await expect(uploadOptionImage(config, reference, png, 'image/png', failed)).rejects.toThrow('OSS 上传连接失败')
  })
})

describe('future web upload adapter', () => {
  it('requires administrator authorization before reading or uploading a file', async () => {
    const upload = vi.fn()
    const handler = createImageUploadHandler({ authorize: () => false, upload })
    expect((await handler(request())).status).toBe(401)
    expect(upload).not.toHaveBeenCalled()
  })
  it('rejects foreign or absent origins and unsupported methods', async () => {
    const authorize = vi.fn(() => true)
    const handler = createImageUploadHandler({ authorize })
    expect((await handler(request({ headers: { origin: 'https://other.example', 'content-type': 'image/png' } }))).status).toBe(403)
    expect((await handler(request({ headers: { 'content-type': 'image/png' } }))).status).toBe(403)
    expect((await handler(new Request(endpoint))).status).toBe(405)
    expect(authorize).not.toHaveBeenCalled()
  })
  it('returns the stable URL and object key for an authenticated same-origin upload', async () => {
    const result = { url: 'https://fakestar-oss.oss-us-west-1.aliyuncs.com/uploads/product-options/techniqueId/G1/a.png', objectKey: 'uploads/product-options/techniqueId/G1/a.png' }
    const upload = vi.fn().mockResolvedValue(result)
    const handler = createImageUploadHandler({ authorize: () => true, upload })
    const response = await handler(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(result)
    expect(upload).toHaveBeenCalledWith(reference, png, 'image/png')
  })
  it('rejects wrong ownership, unsupported types and oversized bodies without reaching OSS', async () => {
    const upload = vi.fn()
    const handler = createImageUploadHandler({ authorize: () => true, upload })
    expect((await handler(request({}, endpoint.replace('techniqueId', 'id')))).status).toBe(400)
    expect((await handler(request({ headers: { origin: 'https://config.example', 'content-type': 'image/svg+xml' } }))).status).toBe(415)
    expect((await handler(request({ body: Buffer.alloc(MAX_IMAGE_BYTES + 1) }))).status).toBe(413)
    expect(upload).not.toHaveBeenCalled()
  })
  it('does not expose unexpected application errors', async () => {
    const handler = createImageUploadHandler({ authorize: () => true, upload: vi.fn().mockRejectedValue(new Error('secret internal config')) })
    const response = await handler(request())
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('secret')
  })
})
