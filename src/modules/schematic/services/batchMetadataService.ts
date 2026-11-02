import dayjs from 'dayjs'
import { defaultBatchMetadata, type BatchMetadata } from '../types'

/** Resolve defaults when starting/opening a batch, without changing saved edits. */
export function initializeBatchMetadata(userName: string, options: {
  metadata?: Partial<BatchMetadata>
  savedAt?: string
  now?: Date
} = {}): BatchMetadata {
  const metadata = { ...defaultBatchMetadata, ...options.metadata }
  // Format in the user's local calendar, as in the history cards. Do not slice
  // a UTC timestamp: an upload shortly after midnight may still be yesterday UTC.
  const savedDate = options.savedAt ? dayjs(options.savedAt) : null
  const drawingDate = metadata.drawingDate?.trim()
    || (savedDate?.isValid() ? savedDate : dayjs(options.now)).format('YYYY-MM-DD')
  return {
    ...metadata,
    drawingDate,
    estimatedShipDate: metadata.estimatedShipDate?.trim() || dayjs(drawingDate).add(8, 'day').format('YYYY-MM-DD'),
    designer: metadata.designer?.trim() || userName.trim(),
  }
}
