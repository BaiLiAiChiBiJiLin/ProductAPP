import test from 'node:test'
import assert from 'node:assert/strict'
import { runTauri } from '../scripts/tauri.mjs'

test('desktop startup waits for Rust to finish before starting Tauri and Vite', async () => {
  const calls = []
  let finishBuild
  const build = new Promise(resolve => { finishBuild = resolve })
  const running = runTauri(['dev'], async (command, args, cwd) => {
    calls.push({ command, args, cwd })
    return command === 'cargo' ? build : 0
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1, 'Tauri must not start while Rust is compiling')
  assert.equal(calls[0].command, 'cargo')
  assert.deepEqual(calls[0].args, ['build', '--no-default-features', '-j', '1'])
  assert.match(calls[0].cwd, /src-tauri$/)
  finishBuild(0)
  assert.equal(await running, 0)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].command, process.execPath)
  assert.equal(calls[1].args.at(-1), 'dev')
})

test('a failed Rust build prevents the frontend from starting and preserves the exit code', async () => {
  const calls = []
  const code = await runTauri(['dev'], async command => { calls.push(command); return 101 })
  assert.equal(code, 101)
  assert.deepEqual(calls, ['cargo'])
})

test('help, packaging and custom development options pass through without a default build', async () => {
  for (const args of [['--help'], ['build'], ['dev', '--help'], ['dev', '--features', 'custom', '--', '--test-argument']]) {
    const calls = []
    const code = await runTauri(args, async (command, received) => { calls.push({command,received}); return 7 })
    assert.equal(code, 7)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, process.execPath)
    assert.deepEqual(calls[0].received.slice(1), args)
  }
})
