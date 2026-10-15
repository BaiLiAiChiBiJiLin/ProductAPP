import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

test('development source changes invalidate cached modules on Windows', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'printflow-vite-refresh-'))
  const source = path.join(root, 'export-service.ts')
  let server
  try {
    await writeFile(source, 'export const render = entry => entry.renderSvg();\n')
    server = await createServer({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      root, cacheDir: path.join(root, '.vite'), logLevel: 'silent',
      server: { middlewareMode: true },
    })
    if (process.platform === 'win32') assert.equal(server.config.server.watch.usePolling, true, 'Windows must detect source changes even when native file notifications are lost')
    const before = await server.transformRequest('/export-service.ts')
    assert.ok(before.code.includes('entry.renderSvg()'))
    // Vite 8's delegated watcher does not forward Chokidar's ready event.
    // Allow its first polling cycle after the module has been registered.
    await new Promise(resolve => setTimeout(resolve, 600))
    await writeFile(source, 'export const render = entry => entry.pages.map(page => page.renderSvg());\n')
    let after
    const deadline = Date.now() + 5000
    do {
      await new Promise(resolve => setTimeout(resolve, 100))
      after = await server.transformRequest('/export-service.ts')
    } while (after.code.includes('entry.renderSvg()') && Date.now() < deadline)
    assert.ok(!after.code.includes('entry.renderSvg()'), 'cached single-page service was not invalidated')
    assert.ok(after.code.includes('entry.pages.map('), 'the updated multi-page service must be served from the same URL')
  } finally {
    await server?.close()
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith('printflow-vite-refresh-'))
    await rm(root, { recursive: true, force: true })
  }
})
