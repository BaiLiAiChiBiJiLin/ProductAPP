import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'

export type UpdateProgress = { downloaded: number; total?: number }

export async function checkForUpdate(): Promise<Update | null> {
  return check({ timeout: 15_000 })
}

export async function downloadAndInstallUpdate(update: Update, onProgress: (progress: UpdateProgress) => void): Promise<void> {
  let downloaded = 0
  let total: number | undefined
  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === 'Started') {
      downloaded = 0
      total = event.data.contentLength
      onProgress({ downloaded, total })
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      // Progress events only contain the chunk size. Keep the total from the
      // Started event so the UI can calculate a percentage for every update.
      onProgress({ downloaded, total })
    } else {
      onProgress({ downloaded, total })
    }
  }, { restartAfterInstall: true })
}
