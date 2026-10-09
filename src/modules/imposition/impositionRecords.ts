import { invoke } from '@tauri-apps/api/core'
import type { PaymentStatus } from '../schematic-review/reviewRecords'

export type ProductionImage = {
  id: string; name: string; sourceFileName: string; filePath: string
  widthMm: number; heightMm: number; productId: string; productName: string
  attributes: Record<string, string>; attributeImages: Record<string, string>
  note: string; noteImage: string | null
  productGroupId: string; productGroupLeaderId: string; productGroupPosition: number
}
export type ImpositionJob = {
  id: string; sourceReviewId: string; customerName: string; output: string
  submittedAt: string; paymentStatus: PaymentStatus; status: 'pending'; imageCount: number
}
export type ImpositionRecord = ImpositionJob & { images: ProductionImage[] }
export type ImpositionListResult = { records: ImpositionJob[]; total: number; page: number; pageSize: number }
export const submitReviewToImposition = (id: string, paymentStatus: PaymentStatus) => invoke<ImpositionJob>('submit_schematic_review_to_imposition', { id, paymentStatus })
export const listPendingImpositions = (query: { page: number; pageSize: number; search?: string }) => invoke<ImpositionListResult>('list_pending_impositions', { query })
export const loadImpositionJob = (id: string) => invoke<ImpositionRecord>('load_imposition_job', { id })
export const loadImpositionImage = (path: string) => invoke<string>('load_imposition_image', { path })

export const returnImpositionToReview = (id: string) => invoke<void>('return_imposition_to_review', { id })
