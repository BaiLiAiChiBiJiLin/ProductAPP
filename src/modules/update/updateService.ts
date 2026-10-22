import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'

export type UpdateProgress = {
  downloaded: number
  total?: number
  phase?: 'connecting' | 'downloading' | 'retrying' | 'installing'
  attempt?: number
  maxAttempts?: number
}

const MAX_DOWNLOAD_ATTEMPTS = 3
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

// Tauri serializes reqwest errors as strings. Match transport failures only;
// signature, HTTP permission/not-found and installer errors need intervention.
function isNetworkFailure(error: unknown): boolean {
  return /error sending request|error decoding response body|request or response body error|connection (?:reset|closed)|timed out|timeout was reached/i.test(String(error))
}

export async function checkForUpdate(): Promise<Update | null> {
  return check({ timeout: 15_000 })
}

export async function downloadAndInstallUpdate(update: Update, onProgress: (progress: UpdateProgress) => void): Promise<void> {
  let downloaded = 0
  let total: number | undefined
  let attempt = 1
  for (; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    downloaded = 0
    total = undefined
    onProgress({ phase: 'connecting', downloaded, total, attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS })
    try {
      // download() includes the updater's signature verification. Only bytes
      // from a successful, verified attempt can proceed to install().
      await update.download((event: DownloadEvent) => {
        if (event.event === 'Started') {
          downloaded = 0
          total = event.data.contentLength
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength
        }
        onProgress({ phase: 'downloading', downloaded, total, attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS })
      }, { timeout: DOWNLOAD_TIMEOUT_MS })
      break
    } catch (error) {
      if (!isNetworkFailure(error)) throw error
      if (attempt === MAX_DOWNLOAD_ATTEMPTS) {
        throw new Error(`无法连接更新下载服务器，已尝试 ${MAX_DOWNLOAD_ATTEMPTS} 次。请检查网络或系统代理后重试，也可从 GitHub 发布页下载安装包。`, { cause: error })
      }
      onProgress({ phase: 'retrying', downloaded: 0, total: undefined, attempt: attempt + 1, maxAttempts: MAX_DOWNLOAD_ATTEMPTS })
      await new Promise(resolve => setTimeout(resolve, attempt * 1000))
    }
  }
  onProgress({ phase: 'installing', downloaded, total, attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS })
  // Keep installation outside the retry loop: it must never run twice.
  await update.install({ restartAfterInstall: true })
}
