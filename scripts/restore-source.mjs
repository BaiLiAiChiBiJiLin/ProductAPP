import { cp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
await cp(join(root, '.source-backups', 'latest'), root, { recursive: true, force: true })
console.log('Protected source snapshot restored.')
