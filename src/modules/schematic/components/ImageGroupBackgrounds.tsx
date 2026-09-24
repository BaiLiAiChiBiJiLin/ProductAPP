import { Group, Rect } from 'react-konva'
import type { Asset, Page } from '../../../model'
import { GROUP_BACKGROUND, groupBackgroundRects, imageGroupsForPage } from '../services/groupBackgroundService'
import ImageGroupDetails from './ImageGroupDetails'
import type { AccessoryVisual } from './ImageGroupDetails'
import type { DimensionDisplayPrecision } from '../services/imageDimensionService'

export default function ImageGroupBackgrounds({ page, assets, selectedItemId, precision = 'default', selectedAccessoryKey, accessoryVisuals, onSelectAccessory, onChangeAccessory, selectedGroupIds = [], onSelectGroup }: { page: Page; assets: Map<string, Asset>; selectedItemId?: string; precision?: DimensionDisplayPrecision; selectedAccessoryKey?: string; accessoryVisuals?: ReadonlyMap<string, AccessoryVisual>; onSelectAccessory?: (key: string) => void; onChangeAccessory?: (key: string, patch: Partial<AccessoryVisual>) => void; selectedGroupIds?: string[]; onSelectGroup?: (id: string, ctrlKey: boolean) => void }) {
  return <Group name="image-group-backgrounds">
    {imageGroupsForPage(page).map(group => <Group key={group.id}>
      {groupBackgroundRects(group).map((rect, index) => <Rect key={`fill-${index}`} {...rect} fill={GROUP_BACKGROUND} listening={false}/>)}
      <Rect name="image-group-background" id={group.id} x={group.x} y={group.y} width={group.width} height={group.backgroundHeight ?? group.height} fill="rgba(0,0,0,0)" stroke={selectedGroupIds.includes(group.id) ? '#2563eb' : undefined} strokeWidth={selectedGroupIds.includes(group.id) ? 1.5 : 0} listening={Boolean(onSelectGroup)} onClick={event => onSelectGroup?.(group.id, Boolean(event.evt.ctrlKey || event.evt.metaKey))} onTap={event => onSelectGroup?.(group.id, Boolean(event.evt.ctrlKey || event.evt.metaKey))}/><ImageGroupDetails group={group} page={page} assets={assets} selectedItemId={selectedItemId} precision={precision} selectedAccessoryKey={selectedAccessoryKey} accessoryVisuals={accessoryVisuals} onSelectAccessory={onSelectAccessory} onChangeAccessory={onChangeAccessory}/></Group>)}
  </Group>
}
