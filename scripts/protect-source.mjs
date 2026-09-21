import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const backupRoot = join(root, '.source-backups', 'latest')
const protectedFiles = ['src/App.tsx', 'src/model.ts', 'src/ArtworkCanvas.tsx', 'src/modules/index.ts', 'src/modules/schematic/SchematicPage.tsx']
await mkdir(backupRoot, { recursive: true })
for (const relative of protectedFiles) {
  const source = join(root, relative)
  try {
    const content = await readFile(source)
    const target = join(backupRoot, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  } catch { /* missing optional files are skipped */ }
}
console.log(`Source snapshot saved: ${protectedFiles.length} files`)
