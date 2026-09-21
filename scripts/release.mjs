import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const versionFiles = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']

export function parseReleaseArgs(args) {
  const options = { increment: args[0], dryRun: false }
  const seen = new Set()
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]
    if (!['--dry-run', '--message', '--notes-file'].includes(flag)) throw new Error(`未知参数：${flag}`)
    if (seen.has(flag)) throw new Error(`参数重复：${flag}`)
    seen.add(flag)
    if (flag === '--dry-run') { options.dryRun = true; continue }
    const value = args[++i]
    if (!value?.trim() || value.startsWith('--')) throw new Error(`${flag} 需要非空参数值`)
    options[flag === '--message' ? 'message' : 'notesFile'] = value
  }
  return options
}

export function nextVersion(version, increment) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`不支持的版本号：${version}`)
  const parts = version.split('.').map(Number)
  const index = ['major', 'minor', 'patch'].indexOf(increment)
  if (index < 0) throw new Error('用法：npm run release -- patch|minor|major [--dry-run]')
  parts[index] += 1
  for (let i = index + 1; i < 3; i++) parts[i] = 0
  return parts.join('.')
}

export function updateVersions(files, version) {
  const result = { ...files }
  for (const name of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const data = JSON.parse(files[name])
    data.version = version
    if (name === 'package-lock.json' && data.packages?.['']) data.packages[''].version = version
    result[name] = `${JSON.stringify(data, null, 2)}\n`
  }
  for (const [name, pattern] of [
    ['src-tauri/Cargo.toml', /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+("[^\n]*)/],
    ['src-tauri/Cargo.lock', /(\[\[package\]\]\r?\nname = "app"\r?\nversion = ")[^"]+("[^\n]*)/],
  ]) {
    if (!pattern.test(files[name])) throw new Error(`${name} 中未找到应用版本号`)
    result[name] = files[name].replace(pattern, (_, before, after) => `${before}${version}${after}`)
  }
  return result
}

function run(command, args, cwd = root, capture = false) {
  const child = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true })
  if (child.error || child.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败：${child.error?.message ?? child.stderr ?? child.status}`)
  return child.stdout?.trim() ?? ''
}

export function release(args, projectRoot = root, execute = run) {
  const options = parseReleaseArgs(args)
  const increment = options.increment
  const git = (...args) => execute('git', args, projectRoot, true)
  const original = Object.fromEntries(versionFiles.map(name => [name, readFileSync(join(projectRoot, name), 'utf8')]))
  const current = JSON.parse(original['src-tauri/tauri.conf.json']).version
  const version = nextVersion(current, increment)
  const updated = updateVersions(original, version)
  const tag = `v${version}`
  const commitMessage = options.message ?? `release: ${tag}`
  const notes = options.notesFile
    ? readFileSync(resolve(projectRoot, options.notesFile), 'utf8').replace(/^\uFEFF/, '')
    : '自动构建并发布 PrintFlow 更新包。'
  if (!notes.trim()) throw new Error('更新说明文件不能为空')
  const metadataPath = join(projectRoot, '.github/release.json')
  const previousMetadata = existsSync(metadataPath) ? readFileSync(metadataPath) : null
  if (git('branch', '--show-current') !== 'main') throw new Error('请在 main 分支执行发布')
  git('var', 'GIT_AUTHOR_IDENT')
  if (git('diff', '--name-only', '--diff-filter=U')) throw new Error('请先解决 Git 冲突')
  if (git('tag', '--list', tag) || git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) throw new Error(`${tag} 已存在，请勿重复发布`)
  const remote = git('ls-remote', '--heads', 'origin', 'refs/heads/main').split(/\s/)[0]
  if (!remote) throw new Error('远程 main 不存在')
  // Refuse to publish over commits made by another checkout. Never force-push.
  git('merge-base', '--is-ancestor', remote, 'HEAD')
  console.log(`发布 ${current} → ${version}；将提交当前所有未忽略的项目更改。`)
  console.log(git('status', '--short') || '工作区干净')
  console.log(`提交信息：${commitMessage}\n更新说明：\n${notes}`)
  if (options.dryRun) {
    console.log(`预览完成：将同步 5 个版本文件，构建前端、检查 Rust，提交并原子推送 main 和 ${tag}。未修改文件或发布。`)
    return
  }
  let committed = false
  try {
    for (const name of versionFiles) writeFileSync(join(projectRoot, name), updated[name])
    // Snapshot the notes into the tagged commit so CI never reads a stale or
    // machine-local file. JSON preserves literal Markdown and multiline text.
    mkdirSync(dirname(metadataPath), { recursive: true })
    writeFileSync(metadataPath, `${JSON.stringify({ version, notes }, null, 2)}\n`)
    // Running npm through Node avoids Windows .cmd spawn EINVAL and shell quoting.
    const npmCli = process.env.npm_execpath
    if (!npmCli) throw new Error('请通过 npm run release 调用此脚本')
    execute(process.execPath, [npmCli, 'run', 'build'], projectRoot)
    execute('cargo', ['check', '--no-default-features', '--locked'], join(projectRoot, 'src-tauri'))
    git('add', '--all')
    git('add', '--', '.github/release.json')
    git('commit', '-m', commitMessage)
    committed = true
    git('tag', tag)
    execute('git', ['push', '--atomic', 'origin', 'main', `refs/tags/${tag}`], projectRoot)
    console.log(`已推送 ${tag}，GitHub Actions 正在构建发布：https://github.com/BaiLiAiChiBiJiLin/ProductAPP/actions`)
  } catch (error) {
    if (!committed) {
      for (const name of versionFiles) writeFileSync(join(projectRoot, name), original[name])
      if (previousMetadata) writeFileSync(metadataPath, previousMetadata)
      else rmSync(metadataPath, { force: true })
      throw new Error(`发布未完成，版本文件已恢复，业务代码保留。${error.message}`)
    }
    throw new Error(`本地发布提交已保留，请勿再次递增版本。检查 git tag --list ${tag}，若缺失先执行 git tag ${tag}，再重试 git push --atomic origin main refs/tags/${tag}。${error.message}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { release(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
