import { invoke as nativeInvoke, isTauri } from '@tauri-apps/api/core'
import { storageMode } from '../../services/backend'
import { cloudSyncTasks } from '../../services/cloudSyncQueue'
import { classifyCloudSyncError } from '../../services/cloudSyncErrors'
import { diagnosticEventStatus, flushDiagnosticEvents } from '../../services/diagnosticEvents'

export type DiagnosticExportResult = { path: string; bytes: number; warnings: string[] }

function diagnosticFileName() {
  const now = new Date()
  const number = (value: number) => String(value).padStart(2, '0')
  return `PrintFlow-诊断-${now.getFullYear()}${number(now.getMonth() + 1)}${number(now.getDate())}-${number(now.getHours())}${number(now.getMinutes())}${number(now.getSeconds())}.zip`
}

/** Export local diagnostics independently of cloud reads, writes and retries. */
export async function exportDiagnosticBundle(): Promise<DiagnosticExportResult | null> {
  if (!isTauri()) throw new Error('请在桌面软件中导出诊断包')
  const { save } = await import('@tauri-apps/plugin-dialog')
  const path = await save({ title: '导出诊断包', defaultPath: diagnosticFileName(), filters: [{ name: 'ZIP 压缩文件', extensions: ['zip'] }] })
  if (!path) return null

  const warnings: string[] = []
  await flushDiagnosticEvents().catch(() => { warnings.push('部分近期事件暂不可用，已导出其他诊断信息。') })
  const events = diagnosticEventStatus()
  if (events.pending || events.failed || events.dropped) warnings.push('部分近期事件未能完整记录，已导出其他诊断信息。')
  let timeout: ReturnType<typeof setTimeout> | undefined
  const mode = await Promise.race([
    storageMode().catch(() => undefined),
    new Promise<undefined>(resolve => { timeout = setTimeout(resolve, 1_500) }),
  ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout) })
  if (!mode) warnings.push('存储模式暂不可用，已导出其他诊断信息。')
  const tasks = cloudSyncTasks().map(task => {
    const error = task.error ? classifyCloudSyncError(task.error) : undefined
    return {
      id: task.id, operation: task.operation, state: task.state, attempts: task.attempts,
      assetCount: task.assetCount, blocked: task.blocked, deletionRequested: !!task.deletionRequested,
      ...(error ? { errorKind: error.kind, retryable: error.retryable } : {}),
    }
  })
  return nativeInvoke<DiagnosticExportResult>('export_diagnostic_bundle', {
    path,
    context: {
      userName: localStorage.getItem('printflow-account-name')?.trim() ?? '',
      ...(mode ? { shared: mode.shared, environment: mode.environment } : {}),
      tasks, warnings, diagnosticEvents: events,
    },
  })
}
