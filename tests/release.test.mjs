import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { nextVersion, parseReleaseArgs, release, updateVersions } from '../scripts/release.mjs'

const files = {
  'package.json': '{"version":"0.0.0"}',
  'package-lock.json': '{"version":"0.0.0","packages":{"":{"version":"0.0.0"},"node_modules/example":{"version":"1.2.3"}}}',
  'src-tauri/tauri.conf.json': '{"version":"0.1.9"}',
  'src-tauri/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.9"\n[dependencies]\nserde = "1"',
  'src-tauri/Cargo.lock': 'version = 3\n[[package]]\nname = "app"\nversion = "0.1.9"\n[[package]]\nname = "serde"\nversion = "1.0.0"',
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'printflow-release-'))
  for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), content) }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function runner(calls, fail) {
  return (command, args) => {
    calls.push([command, ...args])
    if (fail?.(command, args)) throw new Error('模拟失败')
    if (args[0] === 'branch') return 'main'
    if (args.includes('--heads')) return 'abc\trefs/heads/main'
    return ''
  }
}
test('release increments and synchronizes app versions without changing dependency versions', () => {
  assert.equal(nextVersion('0.1.9', 'patch'), '0.1.10')
  assert.equal(nextVersion('0.1.9', 'minor'), '0.2.0')
  assert.equal(nextVersion('0.1.9', 'major'), '1.0.0')
  assert.throws(() => nextVersion('0.1.9', 'invalid'))
  const result = updateVersions(files, '0.1.10')
  for (const name of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) assert.equal(JSON.parse(result[name]).version, '0.1.10')
  assert.equal(JSON.parse(result['package-lock.json']).packages['node_modules/example'].version, '1.2.3')
  assert.match(result['src-tauri/Cargo.lock'], /name = "serde"\nversion = "1.0.0"/)
})
test('dry run never writes versions or creates commits, tags or pushes', t => {
  const root = fixture(t), calls = []
  release(['patch', '--dry-run'], root, runner(calls))
  for (const [name, value] of Object.entries(files)) assert.equal(readFileSync(join(root, name), 'utf8'), value)
  assert.ok(!calls.some(([, verb, ...args]) => ['add', 'commit', 'push'].includes(verb) || (verb === 'tag' && !args.includes('--list'))))
})
test('failed checks restore versions and never publish', t => {
  const root = fixture(t), calls = []
  assert.throws(() => release(['patch'], root, runner(calls, command => command !== 'git')), /版本文件已恢复/)
  for (const [name, value] of Object.entries(files)) assert.equal(readFileSync(join(root, name), 'utf8'), value)
  assert.ok(!calls.some(([, verb]) => verb === 'push' || verb === 'commit'))
})
test('successful checks precede commit and atomic branch/tag push', t => {
  const root = fixture(t), calls = []
  const previous = process.env.npm_execpath
  process.env.npm_execpath = 'npm-cli.js'
  try { release(['patch'], root, runner(calls)) }
  finally { if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous }
  assert.ok(calls.findIndex(([cmd]) => cmd === 'cargo') < calls.findIndex(([, verb]) => verb === 'commit'))
  assert.deepEqual(calls.at(-1), ['git', 'push', '--atomic', 'origin', 'main', 'refs/tags/v0.1.10'])
})

test('custom message and multiline notes survive the release snapshot unchanged', t => {
  const root = fixture(t), calls = []
  const notes = '# 更新说明\r\n\r\n- 修复图片切换\r\n- 保留 `代码`、$() 和 "引号"\r\n'
  writeFileSync(join(root, '更新 说明.md'), `\uFEFF${notes}`)
  const previous = process.env.npm_execpath
  process.env.npm_execpath = 'npm-cli.js'
  try { release(['patch', '--message', '修复切换 "残留"', '--notes-file', '更新 说明.md'], root, runner(calls)) }
  finally { if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous }
  assert.deepEqual(calls.find(([, verb]) => verb === 'commit'), ['git', 'commit', '-m', '修复切换 "残留"'])
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.github/release.json'), 'utf8')), { version: '0.1.10', notes })
})

test('invalid parameters and unreadable or empty notes fail before any Git operation', t => {
  for (const args of [['patch', '--message'], ['patch', '--notes-file', ''], ['patch', '--message', '--dry-run'], ['patch', '--message', 'a', '--message', 'b'], ['patch', '--unknown']]) {
    assert.throws(() => parseReleaseArgs(args))
  }
  const root = fixture(t), calls = []
  assert.throws(() => release(['patch', '--notes-file', 'missing.md'], root, runner(calls)))
  writeFileSync(join(root, 'empty.md'), '  \n')
  assert.throws(() => release(['patch', '--notes-file', 'empty.md'], root, runner(calls)), /不能为空/)
  assert.equal(calls.length, 0)
})

test('dry run leaves release notes untouched; failed checks restore existing metadata', t => {
  const root = fixture(t), calls = []
  writeFileSync(join(root, 'notes.md'), '新说明')
  release(['patch', '--notes-file', 'notes.md', '--dry-run'], root, runner(calls))
  assert.equal(existsSync(join(root, '.github/release.json')), false)
  mkdirSync(join(root, '.github'))
  const old = '{"version":"0.1.9","notes":"旧说明"}\n'
  writeFileSync(join(root, '.github/release.json'), old)
  assert.throws(() => release(['patch', '--notes-file', 'notes.md'], root, runner([], command => command !== 'git')))
  assert.equal(readFileSync(join(root, '.github/release.json'), 'utf8'), old)
})
