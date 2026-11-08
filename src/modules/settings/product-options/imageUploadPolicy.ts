export const MAX_OPTION_IMAGE_BYTES = 4 * 1024 * 1024
export const OPTION_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const OPTION_IMAGE_ACCEPT = OPTION_IMAGE_MIME_TYPES.join(',')

export function validateOptionImageFile(file: Pick<File, 'size' | 'type'>): string | undefined {
  if (!(OPTION_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) return '请选择 PNG、JPG、WebP 或 GIF 图片。'
  if (file.size <= 0) return '图片文件为空，请重新选择。'
  if (file.size > MAX_OPTION_IMAGE_BYTES) return '图片不能超过 4 MB，请压缩后重试。'
}
