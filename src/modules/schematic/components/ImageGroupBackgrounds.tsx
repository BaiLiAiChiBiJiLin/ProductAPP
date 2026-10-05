import { Group, Rect, Text } from 'react-konva'
import type { Asset, Page } from '../../../model'
import { GROUP_BACKGROUND, groupBackgroundRects, imageGroupsForPage } from '../services/groupBackgroundService'
import ImageGroupDetails from './ImageGroupDetails'
import type { AccessoryVisual, EditImageGroupText } from './ImageGroupDetails'
import type { DimensionDisplayOverride, DimensionDisplayPrecision } from '../services/imageDimensionService'

export default function ImageGroupBackgrounds({ page, assets, selectedItemIds = [], precision = 'default', decimalPlaces = 1, displayOverrides, selectedAccessoryKey, accessoryVisuals, onSelectAccessory, onChangeAccessory, selectedGroupIds = [], onSelectGroup, onEditText }: { page: Page; assets: Map<string, Asset>; selectedItemIds?: string[]; precision?: DimensionDisplayPrecision; decimalPlaces?: number; displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>; selectedAccessoryKey?: string; accessoryVisuals?: ReadonlyMap<string, AccessoryVisual>; onSelectAccessory?: (key: string) => void; onChangeAccessory?: (key: string, patch: Partial<AccessoryVisual>) => void; selectedGroupIds?: string[]; onSelectGroup?: (id: string, ctrlKey: boolean) => void; onEditText?: EditImageGroupText }) {
  return <Group name="image-group-backgrounds">
    {imageGroupsForPage(page).map(group => <Group key={group.id}>
    {groupBackgroundRects(group).map((rect, index) => <Rect key={`fill-${index}`} {...rect} fill={GROUP_BACKGROUND} listening={false}/>)}
      {(group.imageCells ?? []).filter(cell => cell.label && !group.itemIds.includes(cell.itemId)).map(cell => <Text key={`empty-${cell.itemId}`} listening={false} x={cell.x} y={cell.y + 6} width={cell.width} text={cell.label} align="center" fontSize={10} fill="#e11d48"/>) }
      <Rect name="image-group-background" id={group.id} x={group.x} y={group.y} width={group.width} height={group.backgroundHeight ?? group.height} fill="rgba(0,0,0,0)" stroke={selectedGroupIds.includes(group.id) ? '#2563eb' : undefined} strokeWidth={selectedGroupIds.includes(group.id) ? 1.5 : 0} listening={Boolean(onSelectGroup)} onClick={event => onSelectGroup?.(group.id, Boolean(event.evt.ctrlKey || event.evt.metaKey))} onTap={event => onSelectGroup?.(group.id, Boolean(event.evt.ctrlKey || event.evt.metaKey))}/><ImageGroupDetails group={group} page={page} assets={assets} selectedItemIds={selectedItemIds} precision={precision} decimalPlaces={decimalPlaces} displayOverrides={displayOverrides} selectedAccessoryKey={selectedAccessoryKey} accessoryVisuals={accessoryVisuals} onSelectAccessory={onSelectAccessory} onChangeAccessory={onChangeAccessory} onEditText={onEditText}/></Group>)}
  </Group>
}
