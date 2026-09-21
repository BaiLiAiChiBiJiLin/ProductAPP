import type { Page } from '../../../model'
export default function PaginationPanel({ pages }: { pages: Page[] }) { return pages.length ? <div aria-label="分页排版">共 {pages.length} 页</div> : null }
