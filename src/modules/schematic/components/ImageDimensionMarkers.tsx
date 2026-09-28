import { Group, Line, Text } from 'react-konva'
import { useMemo } from 'react'
import type { Asset, Page } from '../../../model'
import { imageDimensionMarkerLayout, dimensionGroups, type DimensionDisplayOverride, type DimensionDisplayPrecision } from '../services/imageDimensionService'

export default function ImageDimensionMarkers({ page, assets, selectedItemIds = [], precision = 'default', decimalPlaces = 1, displayOverrides, visualScales }: { page: Page; assets: Map<string, Asset>; selectedItemIds?: string[]; precision?: DimensionDisplayPrecision; decimalPlaces?: number; displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>; visualScales?: ReadonlyMap<string, number> }) {
  const displayPage = useMemo(() => {
    if (!visualScales?.size) return page
    return { ...page, items: page.items.map(item => {
      const scale = visualScales.get(item.id) ?? 1
      return scale === 1 ? item : { ...item, w: item.w * scale, h: item.h * scale }
    }) }
  }, [page, visualScales])
  return <Group listening={false} name="image-dimension-markers">
    {dimensionGroups(displayPage).map(group => {
      const override = group.itemIds.map(id => displayOverrides?.get(id)).find(Boolean)
      const isSelected = selectedItemIds.some(id => group.itemIds.includes(id))
      const markerPrecision = override?.precision ?? (isSelected ? precision : 'default')
      const markerDecimals = override?.decimalPlaces ?? (isSelected ? decimalPlaces : 1)
      const marker = imageDimensionMarkerLayout(group, displayPage, assets, markerPrecision, markerDecimals)
      if (!marker) return null
      if (marker.horizontal) {
        return <Group key={group.id} name={`image-dimension-${group.itemIds[0]}`}>
          {marker.extension.map(([x1, y1, x2, y2], index) => <Line key={`extension-${index}`} points={[x1, y1, x2, y2]} stroke="#2f6fa3" strokeWidth={0.8}/>) }
          <Line points={[marker.x1, marker.y1, marker.textX - marker.gap, marker.y1]} stroke="#2f6fa3" strokeWidth={0.8} lineCap="round"/>
          <Line points={[marker.textX + marker.gap, marker.y1, marker.x2, marker.y1]} stroke="#2f6fa3" strokeWidth={0.8} lineCap="round"/>
          <Line points={[marker.x1, marker.y1, marker.x1 + 5, marker.y1 - 2, marker.x1 + 5, marker.y1 + 2]} closed fill="#2f6fa3" stroke="#2f6fa3" strokeWidth={0.8}/>
          <Line points={[marker.x2, marker.y1, marker.x2 - 5, marker.y1 - 2, marker.x2 - 5, marker.y1 + 2]} closed fill="#2f6fa3" stroke="#2f6fa3" strokeWidth={0.8}/>
          <Text x={marker.textX} y={marker.textY - 4} width={marker.textWidth} offsetX={marker.textWidth / 2} height={8} text={marker.label} align="center" fontSize={7} fill="#2f6fa3"/>
        </Group>
      }
      return <Group key={group.id} name={`image-dimension-${group.itemIds[0]}`}>
        {marker.extension.map(([x1, y1, x2, y2], index) => <Line key={`extension-${index}`} points={[x1, y1, x2, y2]} stroke="#2f6fa3" strokeWidth={0.8}/>) }
        <Line points={[marker.x1, marker.y1, marker.x1, marker.textY - marker.gap]} stroke="#2f6fa3" strokeWidth={0.8} lineCap="round"/>
        <Line points={[marker.x1, marker.textY + marker.gap, marker.x1, marker.y2]} stroke="#2f6fa3" strokeWidth={0.8} lineCap="round"/>
        <Line points={[marker.x1, marker.y1, marker.x1 - 2, marker.y1 + 5, marker.x1 + 2, marker.y1 + 5]} closed fill="#2f6fa3" stroke="#2f6fa3" strokeWidth={0.8}/>
        <Line points={[marker.x1, marker.y2, marker.x1 - 2, marker.y2 - 5, marker.x1 + 2, marker.y2 - 5]} closed fill="#2f6fa3" stroke="#2f6fa3" strokeWidth={0.8}/>
        <Group x={marker.textX} y={marker.textY} rotation={-90}><Text x={-marker.textWidth / 2} y={-7} width={marker.textWidth} height={8} text={marker.label} align="center" fontSize={7} fill="#2f6fa3"/></Group>
      </Group>
    })}
  </Group>
}

