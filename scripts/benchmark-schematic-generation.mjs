// Read-only generation benchmark. Input is a local metadata snapshot whose
// storagePath values resolve to existing SVGs; no batch or artwork is modified.
import { readFile, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { classifyAssetsByProductAndPrint } from '../src/modules/schematic/services/classificationService.ts'
import { defaultLayoutBounds } from '../src/model.ts'

const input = process.argv[2] ?? '.test-output/schematic-generation/batch.json'
const record = JSON.parse(await readFile(input, 'utf8'))
const assets = record.assets
const metadataOnly = process.argv.includes('--metadata-only')
let bytes = 0
const reads = []
const started = performance.now()
for (const [index, asset] of assets.entries()) {
  const start = performance.now()
  if (!asset.svg && !metadataOnly) asset.svg = await readFile(asset.storagePath, 'utf8')
  const size = (await stat(asset.storagePath)).size
  bytes += size
  reads.push({ index, bytes: size, ms: performance.now() - start })
  if ((index + 1) % 10 === 0) process.stdout.write(JSON.stringify({ read: index + 1, total: assets.length, elapsedMs: Math.round(performance.now() - started) }) + '\n')
}
const readMs = performance.now() - started
const classifyStart = performance.now()
const classified = classifyAssetsByProductAndPrint(assets)
const classifyMs = performance.now() - classifyStart
const layoutStart = performance.now()
const pages = paginateAssets(classified, 1000, defaultLayoutBounds)
const layoutMs = performance.now() - layoutStart
console.log(JSON.stringify({ assets: assets.length, metadataOnly, bytes, readMs, classifyMs, layoutMs, pages: pages.length,
  slowestReads: reads.toSorted((a, b) => b.ms - a.ms).slice(0, 5), heapBytes: process.memoryUsage().heapUsed }, null, 2))
