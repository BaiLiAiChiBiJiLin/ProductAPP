export type ImageGroup = {
  id: string
  itemIds: string[]
  x: number
  y: number
  width: number
  height: number
  /** Visual row background only; does not resize artwork or packing bounds. */
  backgroundHeight?: number
  details?: ImageDetails
  productGroupId?: string
  imageColumns?: number
  imageCells?: Array<{ itemId: string; x: number; y: number; width: number; height: number; label?: string }>
  detailGroups?: Array<{ itemIds: string[]; details: ImageDetails }>
  /** Product groups may reserve a compact details panel instead of a 50/50 split. */
  detailWidth?: number
  detailsX?: number
  detailsHeight?: number
  /** A combined group keeps its source images stacked vertically. */
  stacked?: 'vertical'
}

export type ImageDetails = {
  sizes?: Array<{ itemId: string; label: string }>
  size: string
  qt: string
  finish: string
  accessoryImage?: string
  accessoryCode?: string
  note?: string
  noteImage?: string
  heading?: string
  fields?: Array<{ key: string; text: string }>
}

