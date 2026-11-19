import { invoke } from '../../services/backend'
import { copyWorkspaceValue, stageLargeWorkspaceValues, StagedArtwork, REVIEW_ARTWORK_PREFIX } from '../schematic/services/stagedArtworkService'
import type { Asset, LayoutBounds, Page } from '../../model'
import type { BatchMetadata } from '../schematic/types'
import { saveArrangementDisplay, type ArrangementDisplayState, type SavedArrangementDisplay } from '../schematic/services/arrangementDisplayState'
import { snapshotArtwork } from '../schematic/services/artworkSourceService'

export type ExportFormat = 'pdf' | 'svg' | 'png' | 'jpg'
/** A review can be saved before a file is exported. */
export type ReviewFormat = ExportFormat | 'layout'
export type PaymentStatus = 'unpaid' | 'paid'
export type ReviewWorkspace = {
  sourceBatchId?: string
  assets: Asset[]
  pages: Page[]
  activePage: number
  metadata: BatchMetadata
  layoutBounds: LayoutBounds
  arrangementSort: 'default' | 'upload'
  defaultArrangementIds: string[]
}
export type SchematicReviewRecord = ReviewWorkspace & {
  detachedFromBatch?: boolean
  schemaVersion: 1
  id: string
  savedAt: string
  output: string
  format: ReviewFormat
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
export type ReviewRecordIdentity = Pick<SchematicReviewRecord, 'id' | 'sourceRecordId' | 'paymentStatus'>
export type ReviewRestoreRequest = { token: string; record: SchematicReviewRecord }
export type ReviewListQuery = { page: number; pageSize: number; search?: string; dateFrom?: string; dateTo?: string }
export type ReviewListResult = { records: SchematicReviewSummary[]; total: number; page: number; pageSize: number }

/** Freeze the current layout while retaining the current review's identity. */
export function createReviewRecord(workspace: ReviewWorkspace, display: ArrangementDisplayState, format: ReviewFormat, output: string, previous?: ReviewRecordIdentity): SchematicReviewRecord {
  return copyWorkspaceValue({
    ...workspace, schemaVersion: 1, id: previous?.id ?? crypto.randomUUID(), savedAt: new Date().toISOString(),
    format, output, sourceRecordId: previous?.sourceRecordId, paymentStatus: previous?.paymentStatus ?? 'unpaid', display: saveArrangementDisplay(display),
    // Blob preview URLs do not survive an app restart. The SVG is canonical.
    assets: workspace.assets.map(asset => ({ ...asset, previewUrl: '', thumbnailUrl: '' })),
  })
}

export const listReviewRecords = (query: ReviewListQuery = { page: 1, pageSize: 20 }) => invoke<ReviewListResult>('list_schematic_reviews', { query })
const reviewResourceCache = new Map<string, Promise<string>>()
function invalidateReviewResources(id: string) {
  const prefix = `${id}\u0000`
  for (const key of reviewResourceCache.keys()) if (key.startsWith(prefix)) reviewResourceCache.delete(key)
}
export async function deleteReviewRecord(id: string): Promise<void> {
  await invoke<void>('delete_schematic_review', { id })
  invalidateReviewResources(id)
}
function loadReviewResource(id: string, savedAt: string, resourceId: string, decoder: TextDecoder) {
  // Local re-exports reuse r1/r2 resource IDs. A refreshed manifest must not
  // share artwork with a previous revision of the same review.
  const key = `${id}\u0000${savedAt}\u0000${resourceId}`
  const cached = reviewResourceCache.get(key)
  if (cached) return cached
  const pending = invoke<ArrayBuffer>('load_schematic_review_resource', { id, resourceId }).then(bytes => decoder.decode(bytes))
  reviewResourceCache.set(key, pending)
  void pending.catch(() => { if (reviewResourceCache.get(key) === pending) reviewResourceCache.delete(key) })
  return pending
}
type ReviewSaveAttempt = { resources: StagedArtwork; manifest: SchematicReviewRecord; written: boolean; running?: Promise<void> }
const reviewSaveAttempts = new WeakMap<SchematicReviewRecord, ReviewSaveAttempt>()
export async function saveReviewRecord(record: SchematicReviewRecord): Promise<void> {
  let attempt = reviewSaveAttempts.get(record)
  if (!attempt) {
    const resources = new StagedArtwork()
    attempt = { resources, manifest: stageLargeWorkspaceValues(record, resources), written: false }
    reviewSaveAttempts.set(record, attempt)
  }
  if (attempt.running) return attempt.running
  const current = attempt
  current.running = (async () => {
    if (!current.written) { await current.resources.write(); current.written = true }
    await invoke<void>('save_schematic_review', { record: current.manifest })
    invalidateReviewResources(record.id)
    reviewSaveAttempts.delete(record)
    await current.resources.dispose()
  })()
  try { await current.running }
  finally { current.running = undefined }
  // Keep staging files and the identical manifest after a failed/uncertain
  // save. The cloud journal must be able to replay that exact request safely.
}
export async function loadReviewRecord(id: string): Promise<SchematicReviewRecord> {
  const record = copyWorkspaceValue(await invoke<SchematicReviewRecord>('load_schematic_review', { id }))
  if (record.schemaVersion !== 1) throw new Error('该示意图记录版本暂不支持，请更新软件')
  if (!record.pages?.length || !record.assets?.length || !record.display || !record.metadata || !record.layoutBounds) {
    throw new Error('示意图记录不完整，无法恢复')
  }
  // Keep canonical and selected artwork in its owning snapshot. Only small
  // non-artwork resources (for example notes) are hydrated during restoration.
  const lazy = (svg: string) => svg.startsWith(REVIEW_ARTWORK_PREFIX)
    ? snapshotArtwork({ id, resourceId: svg.slice(REVIEW_ARTWORK_PREFIX.length), savedAt: record.savedAt }) : svg
  record.assets = record.assets.map(asset => ({ ...asset, svg: lazy(asset.svg ?? '') }))
  record.pages = record.pages.map(page => ({ ...page, items: page.items.map(item => item.backSvg ? { ...item, backSvg: lazy(item.backSvg) } : item) }))
  const references = new Map<string, string>()
  copyWorkspaceValue(record, text => { if (text.startsWith(REVIEW_ARTWORK_PREFIX)) references.set(text, ''); return text })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries = [...references.keys()]
  let cursor = 0
  const worker = async () => { while (cursor < entries.length) { const reference = entries[cursor++]; references.set(reference, await loadReviewResource(id, record.savedAt, reference.slice(REVIEW_ARTWORK_PREFIX.length), decoder)) } }
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()))
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
