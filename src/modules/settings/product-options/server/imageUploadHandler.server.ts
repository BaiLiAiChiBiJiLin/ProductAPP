/// <reference types="node" />
// Mount only on an authenticated server route; the browser sends the raw image body.
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { ImageUploadError, MAX_IMAGE_BYTES, readOssConfig, uploadOptionImage, validateImageReference, type ImageReference, type ImageUploadResult } from './ossUpload.server'

type Dependencies = {
  authorize: (request: Request) => Promise<boolean> | boolean
  upload?: (reference: ImageReference, bytes: Uint8Array, contentType: string) => Promise<ImageUploadResult>
}
const response = (data: unknown, status: number) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })

async function readImageBody(request: Request) {
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_IMAGE_BYTES)) throw new ImageUploadError('图片不能超过 4 MB。', 413)
  if (!request.body) throw new ImageUploadError('请选择图片。')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new ImageUploadError('图片不能超过 4 MB。', 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, size)
}

/** Vercel/Next.js: export const POST = createImageUploadHandler({ authorize: yourAdminSessionCheck }). */
export function createImageUploadHandler({ authorize, upload }: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return response({ error: '仅支持 POST。' }, 405)
    const url = new URL(request.url)
    // Cookie-authenticated uploads must originate from this application.
    if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return response({ error: '上传来源不匹配。' }, 403)
    try {
      if (typeof authorize !== 'function' || !await authorize(request)) return response({ error: '请先登录有配置权限的账号。' }, 401)
    } catch { return response({ error: '请先登录有配置权限的账号。' }, 401) }
    try {
      const reference = { entityKey: url.searchParams.get('entityKey') || '', valueId: url.searchParams.get('valueId') || '' }
      validateImageReference(reference)
      const contentType = request.headers.get('content-type') || ''
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType)) throw new ImageUploadError('不支持的图片格式。', 415)
      const bytes = await readImageBody(request)
      const result = await (upload ? upload(reference, bytes, contentType) : uploadOptionImage(readOssConfig(process.env), reference, bytes, contentType))
      return response(result, 200)
    } catch (error) {
      if (error instanceof ImageUploadError) return response({ error: error.message }, error.status)
      return response({ error: '图片上传失败，请稍后重试。' }, 502)
    }
  }
}
