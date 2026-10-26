import { isTauri } from '@tauri-apps/api/core'
import { invoke, storageMode } from '../../../services/backend'
import { SOFTWARE_ACCOUNT_NAME } from '../../../config/account'

export const SHARED_HISTORY_ROOT = `\\\\192.168.0.66\\电商文件\\printFlow\\${import.meta.env.DEV ? 'dev' : 'production'}\\historyProduction`
export const sharedTransferDirectory = () => isTauri() ? invoke<string>('shared_transfer_directory') : Promise.resolve(SHARED_HISTORY_ROOT)
export type TransferPreview = { shared?: boolean; assetCount: number; reviewCount: number; jobCount: number }
export type TransferResult = TransferPreview & { taskId: string; recipient: string; batchName: string }
export type SharedRefreshResult = { imported: number; finalized: number; errors: string[]; shared?: boolean }
export type SharedTransferProgress = { phase: string; completed: number; total: number }

export const currentSharedUser = () => localStorage.getItem('printflow-account-name')?.trim() || SOFTWARE_ACCOUNT_NAME
const initializations = new Map<string, Promise<string>>()
export async function initializeSharedUser(userName: string): Promise<string> {
  if (!isTauri() || !userName.trim()) return Promise.resolve('')
  if ((await storageMode()).shared) return invoke<string>('initialize_shared_user', { userName })
  let request = initializations.get(userName)
  if (!request) {
    request = Promise.resolve(invoke<string>('initialize_shared_user', { userName })).catch(error => { initializations.delete(userName); throw error })
    initializations.set(userName, request)
  }
  return request
}

export const listTransferUsers = (userName: string) => isTauri()
  ? invoke<string[]>('list_shared_transfer_users', { userName }) : Promise.resolve([])
export const previewBatchTransfer = (batchId: string) => invoke<TransferPreview>('preview_shared_batch_transfer', { batchId })
export const sendBatchTransfer = (batchId: string, userName: string, recipient: string) => invoke<TransferResult>('send_shared_batch', { batchId, userName, recipient })
export const refreshSharedTransfers = (userName: string): Promise<SharedRefreshResult> => isTauri()
  ? invoke('refresh_shared_transfers', { userName }) : Promise.resolve({ imported: 0, finalized: 0, errors: [] })

export function validSharedUserName(name: string): boolean {
  const value = name.trim()
  return Boolean(value && value.length <= 30 && !/^[.]|[. ]$|[<>:"/\\|?*\x00-\x1f]/.test(value) && !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value))
}
