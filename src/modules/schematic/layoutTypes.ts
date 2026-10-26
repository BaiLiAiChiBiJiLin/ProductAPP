import type { NoteImage } from '../../model.ts'

export type ImageGroup = {
  layoutMode?: 'horizontal'
  backgroundColor?: string
  id: string
  itemIds: string[]
  x: number
  y: number
  width: number
  height: number
  /** A user-sized block keeps its own height instead of inheriting row whitespace. */
  manualSize?: boolean
  /** Visual row background only; does not resize artwork or packing bounds. */
  backgroundHeight?: number
  details?: ImageDetails
  productGroupId?: string
  /** Normalized product identity used to keep adjacent rows together. */
  productKey?: string
  /** A product boundary ended this row; later backfill must leave its empty slots open. */
  preventRowFill?: boolean
  /** Pages containing this group must keep their free regions out of cross-product packing. */
  protectPageFill?: boolean
  imageColumns?: number
  detailColumns?: number
  imageCells?: Array<{ itemId: string; x: number; y: number; width: number; height: number; label?: string; labelColor?: string }>
  /** The fixed Example slot can be intentionally left empty for holder/shaker groups. */
  emptyExample?: boolean
  /** Empty Example is merged into the Front/Inside/Back row instead of reserving a slot. */
  emptyExampleMerged?: boolean
  detailGroups?: Array<{ itemIds: string[]; details: ImageDetails }>
  /** Product groups may reserve a compact details panel instead of a 50/50 split. */
  detailWidth?: number
  detailsX?: number
  detailsHeight?: number
  /** A combined group keeps its source images stacked vertically. */
  stacked?: 'vertical'
}

export type CanvasAnnotation =
  | { id: string; kind: 'text'; x: number; y: number; text: string; color: string; fontSize: number }
  | { id: string; kind: 'ruler'; x: number; y: number; x2: number; y2: number; color: string; measuredMm: number; sourceItemId?: string; extensionOffset?: number }

export type ImageDetails = {
  /** Canvas-only text edits; source dimensions and quantities remain unchanged. */
  textOverrides?: Record<string, { text?: string; fontSize?: number; color?: string; hidden?: boolean }>
  sizes?: Array<{ itemId: string; label: string }>
  size: string
  qt: string
  finish: string
  accessoryImage?: string
  accessoryCode?: string
  note?: string
  noteImage?: string
  noteImages?: NoteImage[]
  heading?: string
  fields?: Array<{ key: string; text: string }>
}

