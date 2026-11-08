/// <reference types="node" />
// Server-only: never import this file from a React component or Vite client entry.
import { Buffer } from 'node:buffer'
import { createHmac, randomUUID } from 'node:crypto'

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const entityKeys = new Set(['sizeBandId', 'printOptionId', 'techniqueId', 'holoFilmId', 'materialId', 'accessoryStyleId', 'accessoryColorId', 'customOptionValueId', 'standeeQuantityId', 'tinplateMaterialId', 'foilStampingId', 'stickerHoloFilmId', 'tinplateHoloFilmId'])
export type ImageReference = { entityKey: string; valueId: string }
export type ImageUploadResult = { url: string; objectKey: string }
export type OssConfig = { accessKeyId: string; accessKeySecret: string; bucket: string; host: string; prefix: string }
export class ImageUploadError extends Error {
  readonly status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}

export function readOssConfig(values: Record<string, unknown>): OssConfig {
  const required = (name: string) => {
    const value = typeof values[name] === 'string' ? (values[name] as string).trim() : ''
    if (!value) throw new ImageUploadError(`未配置 ${name}。`, 503)
    return value
  }
  const accessKeyId = required('OSS_ACCESS_KEY_ID')
  const accessKeySecret = required('OSS_ACCESS_KEY_SECRET')
  if (!/^[A-Za-z0-9]+$/.test(accessKeyId) || [...accessKeySecret].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new ImageUploadError('OSS 访问密钥格式不正确。', 503)
  const bucket = required('OSS_BUCKET')
  const region = required('OSS_REGION')
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !/^oss-[a-z0-9-]+$/.test(region)) throw new ImageUploadError('OSS Bucket 或 Region 配置无效。', 503)
  const endpoint = String(values.OSS_ENDPOINT || `${region}.aliyuncs.com`).trim()
  let parsed: URL
  try { parsed = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`) } catch { throw new ImageUploadError('OSS Endpoint 配置无效。', 503) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new ImageUploadError('OSS Endpoint 必须是 HTTPS 域名。', 503)
  const cnameValue = values.OSS_ENDPOINT_IS_CNAME ?? false
  if (![true, false, 'true', 'false', ''].includes(cnameValue as boolean | string)) throw new ImageUploadError('OSS_ENDPOINT_IS_CNAME 应为 true 或 false。', 503)
  const cname = cnameValue === true || cnameValue === 'true'
  const regionHost = `${region}.aliyuncs.com`
  const bucketHost = `${bucket}.${regionHost}`
  if (!cname && parsed.hostname !== regionHost && parsed.hostname !== bucketHost) throw new ImageUploadError('OSS Endpoint 与 Bucket、Region 不匹配。', 503)
  const prefix = String(values.OSS_OBJECT_PREFIX || '').trim().replace(/^\/+|\/+$/g, '')
  if (prefix.length > 512 || prefix && (!/^[A-Za-z0-9_./-]+$/.test(prefix) || prefix.split('/').some(part => !part || part === '.' || part === '..'))) throw new ImageUploadError('OSS 对象前缀无效。', 503)
  return { accessKeyId, accessKeySecret, bucket, host: parsed.hostname === regionHost || parsed.hostname === bucketHost ? bucketHost : parsed.hostname, prefix }
}

export function validateImageReference(reference: ImageReference) {
  if (!entityKeys.has(reference.entityKey) || !/^[A-Za-z0-9_-]{1,128}$/.test(reference.valueId)) throw new ImageUploadError('图片所属选项无效。')
}

export function imageExtension(bytes: Uint8Array, contentType: string): string {
  if (!bytes.length) throw new ImageUploadError('请选择非空图片。')
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageUploadError('图片不能超过 4 MB。', 413)
  const data = Buffer.from(bytes)
  if (contentType === 'image/png' && data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString('ascii', 12, 16) === 'IHDR') return 'png'
  if (contentType === 'image/jpeg' && data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpg'
  if (contentType === 'image/gif' && data.length >= 13 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'gif'
  if (contentType === 'image/webp' && data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16))) return 'webp'
  throw new ImageUploadError('仅支持内容与格式一致的 PNG、JPEG、WebP、GIF 图片。', 415)
}

export function buildImageObjectKey(config: OssConfig, reference: ImageReference, extension: string, unique = randomUUID()) {
  validateImageReference(reference)
  return [config.prefix, 'uploads', 'product-options', reference.entityKey, reference.valueId, `${unique}.${extension}`].filter(Boolean).join('/')
}

export function signImagePut(config: OssConfig, objectKey: string, contentType: string, date: string) {
  const canonical = `PUT\n\n${contentType}\n${date}\nx-oss-forbid-overwrite:true\n/${config.bucket}/${objectKey}`
  return `OSS ${config.accessKeyId}:${createHmac('sha1', config.accessKeySecret).update(canonical).digest('base64')}`
}

export async function uploadOptionImage(config: OssConfig, reference: ImageReference, bytes: Uint8Array, contentType: string, request: typeof fetch = fetch): Promise<ImageUploadResult> {
  const extension = imageExtension(bytes, contentType)
  const objectKey = buildImageObjectKey(config, reference, extension)
  const url = `https://${config.host}/${objectKey}`
  const date = new Date().toUTCString()
  let response: Response
  try {
    response = await request(url, {
      method: 'PUT', body: new Uint8Array(bytes), redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': contentType, Date: date, 'x-oss-forbid-overwrite': 'true', Authorization: signImagePut(config, objectKey, contentType, date) },
    })
  } catch { throw new ImageUploadError('OSS 上传连接失败，请稍后重试。', 502) }
  if (!response.ok) throw new ImageUploadError(`OSS 上传失败（HTTP ${response.status}）。`, 502)
  return { url, objectKey }
}
