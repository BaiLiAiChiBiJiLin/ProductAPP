# 手动上传本地安装包到 GitHub Releases

适用项目：`BaiLiAiChiBiJiLin/ProductAPP`，Windows x64、NSIS 安装包。本文以 2026-10-26 的本地 `0.1.34` 包为例；只说明手动操作，不会替你上传。

## 1. 找到本次三个文件

本次输出目录：

```text
D:\project\productionAPP\.cargo-target\release\bundle\nsis
```

| 文件 | 用途 |
| --- | --- |
| `PrintFlow_0.1.34_x64-setup.exe` | 用户下载安装，或由软件更新器安装 |
| `PrintFlow_0.1.34_x64-setup.exe.sig` | 这一个安装包对应的更新签名 |
| `latest.json` | 更新版本、安装包下载地址和签名内容 |

本次会生成这三个文件。安装包和 `.sig` 必须来自同一次构建；重新打包后，旧签名不能继续配用。`latest.json` 中的 `signature` 是 `.sig` 的完整文本内容，不是文件路径或下载链接。[Tauri 更新清单规范](https://v2.tauri.app/plugin/updater/#static-json-file)

## 2. 确认是补包还是新版本

检查时，GitHub 已存在 `v0.1.34`，对应 Actions 已成功，因此本次手动操作应编辑已有 Release，替换附件，不必创建新标签。

本地包包含工作区未提交的修改；上传附件不会同步源码，也不会改变标签指向的提交。需要源码与安装包严格对应时，应先提交相应修改并发布一个新的应用版本。

**已安装 `0.1.34` 的用户不会自动升级到另一个 `0.1.34`。** 同版本补包只能让他们下载 `.exe` 后手动覆盖安装。要让这些用户收到自动更新，需要先递增应用版本、同步五个版本文件并重新打包；不能只改安装包名称或 JSON 的版本数字。

## 3. 手动上传三个附件

1. 打开 [ProductAPP 的 Releases](https://github.com/BaiLiAiChiBiJiLin/ProductAPP/releases)，进入 [v0.1.34](https://github.com/BaiLiAiChiBiJiLin/ProductAPP/releases/tag/v0.1.34)。
2. 点击编辑图标（Edit）。保留标签 `v0.1.34`，不要选 Create new tag。
3. 在附件区域删除同名的旧安装包和旧 `.sig`，上传本次生成的 `.exe`、`.sig`。更新公开 Release 时，将新的 `latest.json` 留到最后替换，尽量缩短清单与安装包不一致的时间。
4. 删除旧 `latest.json`，上传本次 `latest.json`。不要重命名这三个文件。
5. 填写更新说明，选择将该版本设为 Latest；用于正式更新时不要勾选 Pre-release。
6. 等待所有附件上传完成，点击 **Update release**。

GitHub 的编辑入口及 Latest 设置见 [官方发布管理说明](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。如果启用了不可变 Release，则不能替换已发布附件，需要发布更高版本。首次创建 Release 时可先存为草稿，上传齐全后再发布。

不要在同一版本的 Actions 仍运行时手动替换附件，否则后续自动上传可能覆盖你的文件。以后手动发布已有标签时同样先检查 [Actions](https://github.com/BaiLiAiChiBiJiLin/ProductAPP/actions)。本项目推送新版本标签会触发自动发布流程。

## 4. 上传后验证

本项目的软件读取固定入口：

```text
https://github.com/BaiLiAiChiBiJiLin/ProductAPP/releases/latest/download/latest.json
```

先在未登录 GitHub 的浏览器中打开该地址，检查：

- `version` 为本次安装包的真实版本，当前是 `0.1.34`。
- `platforms.windows-x86_64.url` 指向本次 Release 的安装包，能直接下载。
- `platforms.windows-x86_64.signature` 与本次 `.sig` 文件内容一致。

从较低版本的软件中点击“检查更新”，确认显示目标版本并能下载、通过签名校验。已是同版本时，没有新版本提示是正常现象。若需要分发给已安装同版本的用户，直接把 Release 中的 `.exe` 下载链接给他们。

签名私钥和密码文件只保存在本机或 GitHub Secrets，**不要作为 Release 附件上传**。本项目并未给客户端配置私有仓库下载凭据；若日后仓库改为私有，需要另外处理更新文件的可访问性。

## 5. 下次本地打包并生成清单

以下 PowerShell 命令在项目目录执行，只打包，不会提交、推送或递增版本。先确保当前代码的版本是你要分发的版本：

```powershell
Set-Location 'D:\project\productionAPP'
try {
  $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText('C:\Users\Admin\.tauri\printflow.key').Trim()
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [IO.File]::ReadAllText('C:\Users\Admin\.tauri\printflow.key.password').Trim()
  $env:CARGO_BUILD_JOBS = '1'
  npm run tauri -- build --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw '打包失败，请先解决终端错误。' }
} finally {
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:CARGO_BUILD_JOBS -ErrorAction SilentlyContinue
}
```

打包成功后运行下面代码。它会读取当前版本和 `release-notes.md`，使用新签名生成清单；安装包或签名缺失时停止：

```powershell
Set-Location 'D:\project\productionAPP'
$packageVersion = (Get-Content 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json).version
$packageDirectory = Join-Path (Get-Location).Path '.cargo-target\release\bundle\nsis'
$packageName = "PrintFlow_${packageVersion}_x64-setup.exe"
$packageFile = Join-Path $packageDirectory $packageName
$signatureFile = "$packageFile.sig"
if (!(Test-Path -LiteralPath $packageFile) -or !(Test-Path -LiteralPath $signatureFile)) {
  throw '本版本安装包或签名缺失，请先成功打包。'
}
$packageSignature = [IO.File]::ReadAllText($signatureFile).Trim()
if (!$packageSignature) { throw '签名文件为空。' }
$manifest = [ordered]@{
  version = $packageVersion
  notes = [IO.File]::ReadAllText((Join-Path (Get-Location).Path 'release-notes.md'))
  pub_date = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = @{
    'windows-x86_64' = @{
      signature = $packageSignature
      url = "https://github.com/BaiLiAiChiBiJiLin/ProductAPP/releases/download/v$packageVersion/$packageName"
    }
  }
}
$manifestPath = Join-Path $packageDirectory 'latest.json'
$manifestJson = $manifest | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($manifestPath, $manifestJson, [Text.UTF8Encoding]::new($false))
Write-Output "已生成：$manifestPath"
```

重新构建后必须重新执行清单生成，不能沿用上次的 `latest.json`。自动发布方式仍见 [GitHub Releases 更新发布](GITHUB_RELEASE_UPDATES.md)。
