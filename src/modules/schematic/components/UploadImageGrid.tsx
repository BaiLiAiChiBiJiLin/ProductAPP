import { useMemo, type ReactNode } from 'react'
import type { Asset } from '../../../model'

type Props = { assets: Asset[]; renderAsset: (asset: Asset) => ReactNode }

/** Separate row grids preserve product-group boundaries and selection order. */
export default function UploadImageGrid({ assets, renderAsset }: Props) {
  const sections = useMemo(() => {
    const groups = new Map<string, Asset[]>()
    const ordinary: Asset[] = []
    for (const asset of assets) {
      if (!asset.productGroupId) { ordinary.push(asset); continue }
      const members = groups.get(asset.productGroupId) ?? []
      members.push(asset)
      groups.set(asset.productGroupId, members)
    }
    return [
      ...[...groups].map(([id, members]) => ({ key: `group:${id}`, assets: members })),
      ...(ordinary.length ? [{ key: 'ordinary', assets: ordinary }] : []),
    ].map(section => ({ key: section.key, items: section.assets.map(asset => ({ key: asset.id, data: asset })) }))
  }, [assets])

  return <>{sections.map(section => <div key={section.key} className="upload-image-row-grid">
    {section.items.map(item => renderAsset(item.data))}
  </div>)}</>
}
