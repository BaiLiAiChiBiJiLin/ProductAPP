import { invoke } from '@tauri-apps/api/core'
import { copyWorkspaceValue, stageLargeWorkspaceValues, StagedArtwork, REVIEW_ARTWORK_PREFIX } from '../schematic/services/stagedArtworkService'
import type { Asset, LayoutBounds, Page } from '../../model'
import type { BatchMetadata } from '../schematic/types'
import { saveArrangementDisplay, type ArrangementDisplayState, type SavedArrangementDisplay } from '../schematic/services/arrangementDisplayState'

export type ExportFormat = 'pdf' | 'svg' | 'png' | 'jpg'
export type PaymentStatus = 'unpaid' | 'paid'
export type ReviewWorkspace = {
  assets: Asset[]
  pages: Page[]
  activePage: number
  metadata: BatchMetadata
  layoutBounds: LayoutBounds
  arrangementSort: 'default' | 'upload'
  defaultArrangementIds: string[]
}
export type SchematicReviewRecord = ReviewWorkspace & {
  schemaVersion: 1
  id: string
  savedAt: string
  output: string
  format: ExportFormat
  paymentStatus: PaymentStatus
  sourceRecordId?: string
  display: SavedArrangementDisplay
}
export type SchematicReviewSummary = Pick<SchematicReviewRecord, 'id' | 'savedAt' | 'output' | 'format' | 'paymentStatus'> & {
  customerName: string
  pageCount: number
  imageCount: number
  returned?: boolean
  impositionJobId?: string
}
export type ReviewRestoreRequest = { token: string; record: SchematicReviewRecord }
export type ReviewListQuery = { page: number; pageSize: number; search?: string; dateFrom?: string; dateTo?: string }
export type ReviewListResult = { records: SchematicReviewSummary[]; total: number; page: number; pageSize: number }

/** Freeze the exported revision, including edits held outside the page model. */
export function createReviewRecord(workspace: ReviewWorkspace, display: ArrangementDisplayState, format: ExportFormat, output: string, sourceRecordId?: string): SchematicReviewRecord {
  return copyWorkspaceValue({
    ...workspace, schemaVersion: 1, id: crypto.randomUUID(), savedAt: new Date().toISOString(),
    format, output, sourceRecordId, paymentStatus: 'unpaid', display: saveArrangementDisplay(display),
    // Blob preview URLs do not survive an app restart. The SVG is canonical.
    assets: workspace.assets.map(asset => ({ ...asset, previewUrl: '', thumbnailUrl: '' })),
  })
}

export const listReviewRecords = (query: ReviewListQuery = { page: 1, pageSize: 20 }) => invoke<ReviewListResult>('list_schematic_reviews', { query })
export const deleteReviewRecord = (id: string) => invoke<void>('delete_schematic_review', { id })
export async function saveReviewRecord(record: SchematicReviewRecord): Promise<void> {
  const resources = new StagedArtwork()
  try {
    const manifest = stageLargeWorkspaceValues(record, resources)
    await resources.write()
    await invoke<void>('save_schematic_review', { record: manifest })
  } finally { await resources.dispose() }
}
export async function loadReviewRecord(id: string): Promise<SchematicReviewRecord> {
  const record = await invoke<SchematicReviewRecord>('load_schematic_review', { id })
  if (record.schemaVersion !== 1) throw new Error('该示意图记录版本暂不支持，请更新软件')
  if (!record.pages?.length || !record.assets?.length || !record.display || !record.metadata || !record.layoutBounds) {
    throw new Error('示意图记录不完整，无法恢复')
  }
  const references = new Map<string, string>()
  copyWorkspaceValue(record, text => { if (text.startsWith(REVIEW_ARTWORK_PREFIX)) references.set(text, ''); return text })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (const reference of references.keys()) {
    const bytes = await invoke<ArrayBuffer>('load_schematic_review_resource', { id, resourceId: reference.slice(REVIEW_ARTWORK_PREFIX.length) })
    references.set(reference, decoder.decode(bytes))
  }
  return copyWorkspaceValue(record, text => references.get(text) ?? text)
}

/** Never save cancelled or failed exports. Report snapshot failures separately. */
export async function exportAndRecord(record: SchematicReviewRecord, exportFile: () => Promise<unknown>): Promise<{ saved: boolean; error?: unknown }> {
  await exportFile()
  try {
    await saveReviewRecord(record)
    return { saved: true }
  } catch (error) {
    return { saved: false, error }
  }
}
