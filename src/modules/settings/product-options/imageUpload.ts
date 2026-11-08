import { invoke, isTauri } from '@tauri-apps/api/core'
import { validateOptionImageFile } from './imageUploadPolicy'

export type OptionImageReference = { entityKey: string; valueId: string }
export type UploadedOptionImage = { url: string; objectKey: string }

export class OptionImageUploadError extends Error {}

function uploadedImage(value: unknown): UploadedOptionImage {
  if (!value || typeof value !== 'object') throw new OptionImageUploadError('上传服务未返回有效图片地址，请重试。')
  const result = value as Partial<UploadedOptionImage>
  if (typeof result.url !== 'string' || typeof result.objectKey !== 'string' || !result.objectKey.trim()) throw new OptionImageUploadError('上传服务未返回有效图片地址，请重试。')
  let url: URL
  try { url = new URL(result.url) } catch { throw new OptionImageUploadError('上传服务返回的图片地址无效。') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new OptionImageUploadError('上传服务返回的图片地址无效。')
  return { url: url.toString(), objectKey: result.objectKey }
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const data = typeof reader.result === 'string' ? reader.result : ''
      const separator = data.indexOf(',')
      if (separator < 0) reject(new OptionImageUploadError('读取图片失败，请重新选择。'))
      else resolve(data.slice(separator + 1))
    }
    reader.onerror = () => reject(new OptionImageUploadError('读取图片失败，请重新选择。'))
    reader.onabort = () => reject(new OptionImageUploadError('读取图片已取消。'))
    reader.readAsDataURL(file)
  })
}

function nativeError(failure: unknown): OptionImageUploadError {
  if (failure instanceof OptionImageUploadError) return failure
  const message = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : ''
  if (/配置|Missing.*OSS|not configured/i.test(message)) return new OptionImageUploadError('OSS 未配置或配置无效，请检查上传服务配置。')
  if (/403|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(message)) return new OptionImageUploadError('OSS 拒绝上传，请检查密钥和上传权限。')
  if (/timeout|timed out|超时/i.test(message)) return new OptionImageUploadError('图片上传超时，请重试。')
  return new OptionImageUploadError('图片上传失败，请检查网络后重试。')
}

export async function uploadProductOptionImage(file: File, reference: OptionImageReference): Promise<UploadedOptionImage> {
  const invalid = validateOptionImageFile(file)
  if (invalid) throw new OptionImageUploadError(invalid)
  if (isTauri()) {
    try {
      const contentBase64 = await readBase64(file)
      return uploadedImage(await invoke('upload_product_option_image', { input: { ...reference, contentType: file.type, contentBase64 } }))
    } catch (failure) { throw nativeError(failure) }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 40_000)
  try {
    const query = new URLSearchParams(reference)
    const response = await fetch(`/api/product-options/images?${query}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file, signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new OptionImageUploadError('没有上传权限，请登录后重试。')
      if (response.status === 413) throw new OptionImageUploadError('图片不能超过 4 MB，请压缩后重试。')
      if (response.status === 400 || response.status === 415) throw new OptionImageUploadError('图片格式或内容无效，请重新选择 PNG、JPG、WebP 或 GIF 图片。')
      if (response.status === 404 || response.status === 503) throw new OptionImageUploadError('图片上传服务尚未配置。请配置服务端后重试。')
      throw new OptionImageUploadError('图片上传失败，请稍后重试。')
    }
    return uploadedImage(await response.json())
  } catch (failure) {
    if (failure instanceof OptionImageUploadError) throw failure
    throw new OptionImageUploadError(controller.signal.aborted ? '图片上传超时，请重试。' : '图片上传失败，请检查网络后重试。')
  } finally { clearTimeout(timer) }
}
