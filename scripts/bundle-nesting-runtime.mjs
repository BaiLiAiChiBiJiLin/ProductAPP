import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
if (process.platform !== 'win32') throw new Error('拼版安装包运行时目前仅支持 Windows x64')
const localPython = path.join(root, '.tools/nesting/.venv/Scripts/python.exe')
const python = process.env.PRINTFLOW_NESTING_BUILD_PYTHON || (existsSync(localPython) ? localPython : 'python')
const child = spawnSync(python, ['-B', path.join(root, 'scripts/nesting/bundle_runtime.py')], {
  cwd: root, stdio: 'inherit', windowsHide: true,
})
if (child.error) throw new Error(`准备拼版安装包失败：${child.error.message}`)
process.exitCode = child.status ?? 1
