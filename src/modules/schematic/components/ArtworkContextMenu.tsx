import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Dropdown } from 'antd'
import { ImageUp, Layers } from 'lucide-react'
import type { Asset, Item } from '../../../model'
import { selectSvgLayer, svgLayers } from '../services/svgLayerService'

export type ArtworkMenuTarget = { itemId: string; x: number; y: number }

export default function ArtworkContextMenu({ target, item, asset, onClose, onChange, onReplace }: {
  target: ArtworkMenuTarget; item: Item; asset: Asset; onClose: () => void
  onChange: (item: Item) => void; onReplace?: (itemId: string) => Promise<void>
}) {
  // Enumerate only when the user opens the menu, always against the original
  // document so switching one layer never discards the other choices.
  const layers = useMemo(() => svgLayers(asset.svg), [asset.svg])
  // The workspace's entrance animation creates a transformed containing block.
  // Anchor to the document so client coordinates stay aligned with the pointer.
  return createPortal(<Dropdown open placement="bottomLeft" trigger={['contextMenu']} onOpenChange={open => { if (!open) onClose() }}
    menu={{
      triggerSubMenuAction: 'click',
      selectedKeys: item.svgLayerId ? [`layer:${item.svgLayerId}`] : [],
      items: [
        { key: 'layers', label: '切换图层', icon: <Layers size={14}/>, children: [
          { key: 'layer:all', label: '全部图层' },
          ...layers.map(layer => ({ key: `layer:${layer.id}`, label: layer.label })),
        ] },
        { key: 'replace', label: '更换图片', icon: <ImageUp size={14}/>, disabled: !onReplace },
      ],
      onClick: ({ key }) => {
        onClose()
        if (key === 'replace') { void onReplace?.(item.id); return }
        if (!key.startsWith('layer:')) return
        const layerId = key.slice('layer:'.length)
        onChange({ ...item, svgLayerId: layerId, backSvg: layerId === 'all' ? asset.svg : selectSvgLayer(asset.svg, layerId) })
      },
    }}>
    <span aria-hidden style={{ position: 'fixed', left: target.x, top: target.y, width: 1, height: 1, pointerEvents: 'none' }}/>
  </Dropdown>, document.body)
}
