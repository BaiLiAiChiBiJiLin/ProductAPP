import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)

function runCommand(command, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    const interrupt = () => child.kill('SIGINT')
    const terminate = () => child.kill('SIGTERM')
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    child.once('error', error => console.error(`无法启动 ${command}：${error.message}`))
    child.once('close', code => {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
      resolve(code ?? 1)
    })
  })
}

export async function runTauri(args, run = runCommand) {
  // Prebuild only the default desktop development command. Custom targets,
  // features and profiles must remain under the original CLI's control.
  if (args.length === 1 && args[0] === 'dev') {
    console.log('先编译 Rust，完成后再启动 Vite，降低开发启动时的内存峰值。')
    const code = await run('cargo', ['build', '--no-default-features', '-j', '1'], path.join(projectRoot, 'src-tauri'))
    if (code !== 0) {
      console.error('Rust 预编译失败，已停止启动；Vite 和桌面程序尚未启动。')
      return code
    }
  }
  return run(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...args], projectRoot)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runTauri(process.argv.slice(2))
}
