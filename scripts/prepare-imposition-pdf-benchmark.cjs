// Generate the actual export SVGs from a read-only job and nesting-result snapshot.
// node scripts/prepare-imposition-pdf-benchmark.cjs job.json result.json output-dir
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { JSDOM } = require('jsdom')

const [jobFile, resultFile, outputDirectory] = process.argv.slice(2)
if (!jobFile || !resultFile || !outputDirectory) throw new Error('Expected job.json result.json output-directory')
const output = path.resolve(outputDirectory)
if (fs.existsSync(output)) throw new Error('Use a new benchmark directory; existing files are never overwritten')
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, file)
const { window } = new JSDOM('<!doctype html><body></body>')
for (const key of ['DOMParser', 'XMLSerializer', 'document', 'Element', 'Node']) global[key] = window[key]
const api = require('../src/modules/imposition/impositionSvgExport.ts')
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
const assets = new Map(job.images.map(asset => [asset.id, asset]))
const sources = Object.fromEntries(job.images.map(asset => [asset.id, api.parseImpositionSvgSource({
  sourceId: asset.id, fileName: asset.sourceFileName,
  svgText: fs.readFileSync(asset.filePath, 'utf8'),
})]))
const pages = []
for (const placement of result.placements) {
  const asset = assets.get(placement.id.split('#qt-')[0])
  if (!asset) throw new Error(`Missing source: ${placement.id}`)
  ;(pages[placement.sheetIndex] ??= []).push({ image: { ...asset, id: placement.id, sourceImageId: asset.id },
    x: placement.xMm, y: placement.yMm, width: placement.widthMm, height: placement.heightMm, rotation: placement.rotationDeg })
}
const model = api.createImpositionExportModel({ pages, sources, plateWidthMm: 300, plateHeightMm: 464,
  holes: { count: 5, sizeMm: 3, gapMm: 80, leftMm: 3 } })
fs.mkdirSync(output, { recursive: true })
const files = [], plan = []
for (const [boardIndex, entry] of api.enumerateImpositionPdfExports(model).entries()) {
  for (const [pageIndex, page] of entry.pages.entries()) {
    const file = path.join(output, `board-${boardIndex + 1}-page-${pageIndex + 1}.svg`)
    fs.writeFileSync(file, api.renderImpositionSvgExport(model, page), { flag: 'wx' })
    files.push(file)
    plan.push({ template: boardIndex + 1, page: pageIndex + 1, type: page.groupName, copies: entry.productionCopies, file })
  }
}
fs.writeFileSync(path.join(output, 'pages.json'), JSON.stringify(files), { flag: 'wx' })
fs.writeFileSync(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ output, templates: model.templates.length, pages: files.length,
  svgBytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0) }))
