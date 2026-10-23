import { invoke } from '@tauri-apps/api/core'
import type { PaymentStatus } from '../schematic-review/reviewRecords'
import type { NoteImage } from '../../model'

export type ProductionImage = {
  id: string; name: string; sourceFileName: string; filePath: string
  widthMm: number; heightMm: number; productId: string; productName: string
  attributes: Record<string, string>; attributeImages: Record<string, string>
  note: string; noteImage: string | null
  noteImages?: NoteImage[]
  productGroupId: string; productGroupLeaderId: string; productGroupPosition: number
  /** Set only on client-side copies expanded from QT for canvas rendering. */
  sourceImageId?: string; quantityIndex?: number
}
export type ImpositionJob = {
  id: string; sourceReviewId: string; customerName: string; output: string
  submittedAt: string; paymentStatus: PaymentStatus; status: 'pending'; imageCount: number; temporary?: boolean
}
export type ImpositionRecord = ImpositionJob & { images: ProductionImage[] }
export type ImpositionListResult = { records: ImpositionJob[]; total: number; page: number; pageSize: number }
/** Orders may reference the same asset; solver/canvas identities must remain distinct. */
export const impositionImageId = (jobId: string, imageId: string) => `${jobId}::${imageId}`
export type NestTemplatePlacement = { sourceId: string; xMm: number; yMm: number; rotationDeg: number }
export type NestTemplateRepack = {
  templates: Array<{ id: string; repeatCount: number; placements: NestTemplatePlacement[] }>
  sourceTemplateId: string
  targetTemplateId: string
  sourceSlotIndex: number
  targetPlacement: NestTemplatePlacement
}
export type NestRequest = { plateWidthMm: number; plateHeightMm: number; effectiveWidthMm: number; effectiveHeightMm: number; effectiveRightMm: number; spacingMm: number; objective: string; irregularAlgorithm?: 'local-tools'; threadCount?: number; templateRepack?: NestTemplateRepack; items: Array<{ id: string; widthMm: number; heightMm: number; quantity?: number; polygon?: Array<[number, number]>; lineOnly?: boolean }> }
export type ImpositionGeometry = { polygon: Array<[number, number]>; lineOnly: boolean }
export type NestExcludedItem = { id: string; reason: string }
export type NestResult = { placements: Array<{ id: string; sheetIndex: number; xMm: number; yMm: number; widthMm: number; heightMm: number; rotationDeg: number }>; unplaced: string[]; sheetsUsed: number; utilization: number; algorithm: string; excludedItems?: NestExcludedItem[]; warnings?: string[] }
export const submitReviewToImposition = (id: string, paymentStatus: PaymentStatus) => invoke<ImpositionJob>('submit_schematic_review_to_imposition', { id, paymentStatus })
export const listPendingImpositions = (query: { page: number; pageSize: number; search?: string }) => invoke<ImpositionListResult>('list_pending_impositions', { query })
export const loadImpositionJob = (id: string) => invoke<ImpositionRecord>('load_imposition_job', { id })
export const updateImpositionImageQuantity = (jobId: string, imageId: string, quantity: number) => invoke<ImpositionRecord>('update_imposition_image_quantity', { jobId, imageId, quantity })
export const updateImpositionImageQuantities = (jobId: string, imageIds: string[], quantity: number) => invoke<ImpositionRecord>('update_imposition_image_quantities', { jobId, imageIds, quantity })
export const loadImpositionImage = (path: string) => invoke<string>('load_imposition_image', { path })
export const packImpositionIrregular = (request: NestRequest) => invoke<NestResult>('pack_imposition_irregular', { request })
export type ImpositionComputeInfo = { logicalCores: number; defaultThreads: number }
export const getImpositionComputeInfo = () => invoke<ImpositionComputeInfo>('get_imposition_compute_info')

// Extract the outline and classify visible SVG content in the same native
// parse, independently from the raster preview. QT copies share this result.
const impositionGeometryCache = new Map<string, Promise<ImpositionGeometry>>()
export const loadImpositionGeometry = (path: string, widthMm: number, heightMm: number) => {
  const key = `${path}\u0000${widthMm}\u0000${heightMm}`
  const cached = impositionGeometryCache.get(key)
  if (cached) return cached
  const pending = invoke<ImpositionGeometry>('load_imposition_geometry', { path, widthMm, heightMm })
  impositionGeometryCache.set(key, pending)
  // A transient read/parse failure should be retryable after the asset is
  // repaired. Successful contours remain cached for the lifetime of the UI.
  void pending.catch(() => {
    if (impositionGeometryCache.get(key) === pending) impositionGeometryCache.delete(key)
  })
  return pending
}

export const returnImpositionToReview = (id: string) => invoke<void>('return_imposition_to_review', { id })
export const deleteImpositionImport = (jobId: string) => invoke<void>('delete_imposition_import', { jobId })

export function forgetImpositionGeometry(paths: string[]) {
  const removed = new Set(paths)
  for (const key of impositionGeometryCache.keys()) {
    if (removed.has(key.split('\u0000')[0])) impositionGeometryCache.delete(key)
  }
}

const MAX_IMPOSITION_QUANTITY = 10_000

/** Reads the production asset's QT attribute. Missing/invalid QT keeps one copy. */
export function getImpositionQuantity(image: ProductionImage): number {
  const raw = image.attributes.QT ?? image.attributes.qt ?? image.attributes['数量'] ?? image.attributes.Quantity
  if (raw == null || raw.trim() === '') return 1
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_IMPOSITION_QUANTITY) : 1
}

/** Expands QT copies into unique client-side items while retaining the source asset id. */
export function expandImpositionImages(images: ProductionImage[]): ProductionImage[] {
  return images.flatMap(image => Array.from({ length: getImpositionQuantity(image) }, (_, index) => index === 0
    ? image
    : { ...image, id: `${image.id}#qt-${index + 1}`, name: `${image.name} · ${index + 1}`, sourceImageId: image.id, quantityIndex: index + 1 }))
}
