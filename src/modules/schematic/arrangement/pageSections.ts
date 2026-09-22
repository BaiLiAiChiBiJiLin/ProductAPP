import { HEADER_BLOCK_HEIGHT, type HeaderBlock, type Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'

export const SECTION_EPS = 1e-7
export function horizontallyOverlaps(a: { x: number; width: number }, b: { x: number; width: number }) {
  return a.x < b.x + b.width - SECTION_EPS && b.x < a.x + a.width - SECTION_EPS
}

/** Side-by-side sections can share a Y coordinate; ownership needs both axes. */
export function headerFor(page: Page, group: ImageGroup): HeaderBlock | undefined {
  return page.headerBlocks?.filter(header => header.y + HEADER_BLOCK_HEIGHT <= group.y + SECTION_EPS
    && header.x <= group.x + SECTION_EPS && header.x + header.width >= group.x + group.width - SECTION_EPS)
    .sort((a, b) => a.y - b.y).at(-1)
}
