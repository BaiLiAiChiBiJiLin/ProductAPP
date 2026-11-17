import type { Page } from '../../../model.ts'

/** User text, rulers and headers count as content even without artwork. */
export function isEmptyArrangementPage(page: Page) {
  return !page.items.length && !page.annotations?.length && !page.headerBlocks?.length && !page.imageGroups?.length
}

export function removeEmptyArrangementPage(pages: Page[], id: number): Page[] {
  if (pages.length <= 1 || !pages.some(page => page.id === id && isEmptyArrangementPage(page))) return pages
  return pages.filter(page => page.id !== id)
}
