import { DatabaseSync } from 'node:sqlite'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const source = fileURLToPath(new URL('../printflow-data/custom-products.sqlite', import.meta.url))
const destination = new URL('../src-tauri/resources/custom-products.json', import.meta.url)
try { await access(source) } catch {
  // CI uses the checked-in preset snapshot when the developer database is absent.
  await access(destination)
  console.log('Using bundled custom-product snapshot')
  process.exit(0)
}
const db = new DatabaseSync(source, { readOnly: true })
try {
  const products = db.prepare('SELECT payload FROM custom_products ORDER BY id').all().map(row => JSON.parse(row.payload))
  await mkdir(new URL('../src-tauri/resources/', import.meta.url), { recursive: true })
  await writeFile(destination, JSON.stringify(products))
  console.log(`Bundled ${products.length} custom-product presets (including embedded images)`)
} finally { db.close() }
