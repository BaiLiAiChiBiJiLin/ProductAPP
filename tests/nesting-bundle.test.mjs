import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
test('Windows installer includes the local nesting adapter and its self-contained runtime', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const resources = config.bundle.resources
  assert.equal(resources['resources/imposition-runtime/'], 'imposition-runtime/', 'local-tools 适配器未找到：安装包缺少拼版运行资源映射')
  assert.match(config.build.beforeBuildCommand, /bundle-nesting-runtime/, '打包前必须准备并验证独立拼版运行时')
  const bundler = readFileSync(new URL('../scripts/nesting/bundle_runtime.py', import.meta.url), 'utf8')
  assert.match(bundler, /MODULES\s*=\s*\[[^\]]*'nest_replan\.py'/, '跨方案特殊重排模块必须随安装包一同发布')
  assert.match(bundler, /MODULES\s*=\s*\[[^\]]*'nest_combined\.py'/, '综合最少模块必须随安装包一同发布')
  assert.match(bundler, /request\['templateRepack'\]/, '安装运行时验证必须真实执行已有版式补排')
  assert.match(bundler, /'template-repack-combined'/, '安装运行时必须验证综合最少的跨方案重排')
})
