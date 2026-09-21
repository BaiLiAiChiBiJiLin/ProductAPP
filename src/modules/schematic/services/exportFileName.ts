import type { Asset } from '../../../model.ts'

export function exportFileName(assets: Asset[], format: 'pdf' | 'svg' | 'png' | 'jpg') {
  const asset = assets[0]
  // Older batches stored the parent filename as the prefix of each split name.
  const name = asset?.sourceFileName || asset?.name.split(' · ')[0] || '示意图'
  const base = name.split(/[\\/]/).at(-1)!.replace(/\.svg$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
  return `${base || '示意图'}.${format}`
}
