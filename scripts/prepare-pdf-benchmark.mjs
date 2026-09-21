// Run against a local, read-only batch snapshot; never changes the saved batch.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pageRasterSvg, defaultLayoutBounds } from '../src/model.ts'
import { paginateAssets } from '../src/modules/schematic/services/paginationService.ts'
import { arrangePage } from '../src/modules/schematic/services/pageLayoutService.ts'

const input = resolve(process.argv[2] ?? '.test-output/pdf-performance/batch.json')
const output = resolve(process.argv[3] ?? '.test-output/pdf-performance')
const { assets, metadata } = JSON.parse(await readFile(input, 'utf8'))
await mkdir(output, { recursive: true })
for (const asset of assets) asset.svg ||= await readFile(asset.storagePath, 'utf8')
const start = performance.now()
const pages = paginateAssets(assets, 1000, defaultLayoutBounds).map(page => arrangePage(page, defaultLayoutBounds))
const map = new Map(assets.map(asset => [asset.id, asset]))
const sources = pages.map(page => pageRasterSvg(page, map, metadata, pages.length))
await writeFile(resolve(output, 'pages.json'), JSON.stringify(sources))
await writeFile(resolve(output, 'layout.json'), JSON.stringify({ pages, assets: assets.map(({ svg, ...asset }) => asset), metadata }))
for (let i = 0; i < sources.length; i++) await writeFile(resolve(output, `page-${i + 1}.svg`), sources[i])
console.log(JSON.stringify({ assets: assets.length, pages: pages.length, imagesPerPage: pages.map(p => p.items.length), svgBytes: sources.map(s => Buffer.byteLength(s)), frontendMs: performance.now() - start, output: dirname(resolve(output, 'pages.json')) }, null, 2))
