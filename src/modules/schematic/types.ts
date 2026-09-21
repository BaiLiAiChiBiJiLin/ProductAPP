import type { Asset } from '../../model'
import { SOFTWARE_ACCOUNT_NAME } from '../../config/account'
export type Batch = { id: string; name: string; updatedAt: string; assets: Asset[] }
export type SchematicCopy = { recent: string; newBatch: string; upload: string; adding: string; creating: string }
export type BatchMetadata = { customerName: string; drawingDate: string; estimatedShipDate: string; designer: string }
export const defaultBatchMetadata: BatchMetadata = { customerName: '', drawingDate: '', estimatedShipDate: '', designer: SOFTWARE_ACCOUNT_NAME }
