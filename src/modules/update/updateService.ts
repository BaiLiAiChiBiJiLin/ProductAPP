import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'

export type UpdateProgress = { downloaded: number; total?: number }

export async function checkForUpdate(): Promise<Update | null> {
  return check({ timeout: 15_000 })
}

export async function downloadAndInstallUpdate(update: Update, onProgress: (progress: UpdateProgress) => void): Promise<void> {
  let downloaded = 0
  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === 'Started') {
      downloaded = 0
      onProgress({ downloaded, total: event.data.contentLength })
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      onProgress({ downloaded })
    } else {
      onProgress({ downloaded })
    }
  }, { restartAfterInstall: true })
}
