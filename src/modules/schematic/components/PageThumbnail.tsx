import { itemForCanvasDisplay } from '../services/canvasDisplayScaleService'
import { memo } from 'react'
import type { Asset, Page } from '../../../model'
import { HEADER_BACKGROUND, headerCells, HEADER_BLOCK_HEIGHT, PAPER_HEIGHT, PAPER_WIDTH } from '../../../model'
import LazySvgImage from './LazySvgImage'
import { GROUP_BACKGROUND, imageGroupsForPage } from '../services/groupBackgroundService'

function PageThumbnail({ page, pageNumber = page.id, assets, active, onClick, visualScales }: { page: Page; pageNumber?: number; visualScales?: ReadonlyMap<string, number>; assets: Map<string, Asset>; active: boolean; onClick: () => void }) {
  return <button className={`page-card ${active ? 'selected' : ''}`} onClick={onClick} aria-label={`页面 ${pageNumber}`}>
    <div className="page-number">{pageNumber}</div>
    <div className="thumb page-thumb-art">
      {imageGroupsForPage(page).map(group => <div key={group.id} className="page-thumb-group" style={{ position: 'absolute', left: `${group.x / PAPER_WIDTH * 100}%`, top: `${group.y / PAPER_HEIGHT * 100}%`, width: `${group.width / PAPER_WIDTH * 100}%`, height: `${(group.backgroundHeight ?? group.height) / PAPER_HEIGHT * 100}%`, background: group.backgroundColor ?? page.backgroundColor ?? GROUP_BACKGROUND, pointerEvents: 'none' }}/>)}
      {page.items.length ? page.items.map(original => {
        const item = itemForCanvasDisplay(original, visualScales?.get(original.id) ?? 1)
        const asset = assets.get(item.assetId)
        if (!asset) return null
        return <LazySvgImage key={item.id} svg={item.backSvg ?? asset.svg} alt="" draggable={false} style={{ left: `${(item.x - item.w / 2) / PAPER_WIDTH * 100}%`, top: `${(item.y - item.h / 2) / PAPER_HEIGHT * 100}%`, width: `${item.w / PAPER_WIDTH * 100}%`, height: `${item.h / PAPER_HEIGHT * 100}%`, transform: `rotate(${item.rotation}deg) scaleX(${item.mirrorX ? -1 : 1})` }} />
      }) : <span className="empty-thumb">空白页面</span>}
      {page.headerBlocks?.map(block => <div key={block.id} className="page-thumb-header" style={{ background: HEADER_BACKGROUND, left: `${block.x / PAPER_WIDTH * 100}%`, top: `${block.y / PAPER_HEIGHT * 100}%`, width: `${block.width / PAPER_WIDTH * 100}%`, height: `${HEADER_BLOCK_HEIGHT / PAPER_HEIGHT * 100}%` }}>{headerCells(block).map(cell => <span key={cell.id} style={{ width: `${cell.width / block.width * 100}%` }}/>)}</div>)}
    </div>
    <div className="page-meta"><span>页面 {pageNumber}</span><span className={`page-state ${page.items.length ? 'done' : ''}`}>{page.items.length ? '编辑中' : '未开始'}</span></div>
  </button>
}

export default memo(PageThumbnail, (previous, next) => previous.page === next.page && previous.assets === next.assets && previous.active === next.active && previous.pageNumber === next.pageNumber && previous.visualScales === next.visualScales && previous.onClick === next.onClick)

