import { Group, Rect } from 'react-konva'
import type { Page } from '../../../model'
import { GROUP_BACKGROUND, groupBackgroundRects, imageGroupsForPage } from '../services/groupBackgroundService'
import ImageGroupDetails from './ImageGroupDetails'

export default function ImageGroupBackgrounds({ page, selectedGroupIds = [], onSelectGroup }: { page: Page; selectedGroupIds?: string[]; onSelectGroup?: (id: string, ctrlKey: boolean) => void }) {
  return <Group name="image-group-backgrounds">
    {imageGroupsForPage(page).map(group => <Group key={group.id}>
      {groupBackgroundRects(group).map((rect, index) => <Rect key={`fill-${index}`} {...rect} fill={GROUP_BACKGROUND} listening={false}/>)}
      <Rect name="image-group-background" id={group.id} x={group.x} y={group.y} width={group.width} height={group.backgroundHeight ?? group.height} fill="rgba(0,0,0,0)" stroke={selectedGroupIds.includes(group.id) ? '#2563eb' : undefined} strokeWidth={selectedGroupIds.includes(group.id) ? 1.5 : 0} listening={Boolean(onSelectGroup)} onClick={event => onSelectGroup?.(group.id, Boolean(event.evt.ctrlKey || event.evt.metaKey))} onTap={event => onSelectGroup?.(group.id, Boolean(event.evt.ctrlKey || event.evt.metaKey))}/><ImageGroupDetails group={group}/></Group>)}
  </Group>
}
