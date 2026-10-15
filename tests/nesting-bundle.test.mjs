import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
test('Windows installer includes the local nesting adapter and its self-contained runtime', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const resources = config.bundle.resources
  assert.equal(resources['resources/imposition-runtime/'], 'imposition-runtime/', 'local-tools 适配器未找到：安装包缺少拼版运行资源映射')
  assert.match(config.build.beforeBuildCommand, /bundle-nesting-runtime/, '打包前必须准备并验证独立拼版运行时')
})
