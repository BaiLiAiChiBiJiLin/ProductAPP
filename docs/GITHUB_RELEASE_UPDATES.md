# GitHub Releases 更新发布

PrintFlow 使用 Tauri Updater 检查 GitHub Releases 的 `latest.json`。更新地址配置在 `src-tauri/tauri.conf.json`：

```text
https://github.com/BaiLiAiChiBiJiLin/ProductAPP/releases/latest/download/latest.json
```

## 首次配置 GitHub Secrets

不要把私钥提交到仓库。将本机 `C:\Users\Admin\.tauri\printflow.key` 的完整内容保存为仓库 Secret：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

密码保存在本机 `C:\Users\Admin\.tauri\printflow.key.password`，丢失私钥或密码后无法发布兼容更新的版本。

## 发布

在项目根目录执行下面命令，无需手动修改版本号：

```powershell
npm run release -- patch
```

自定义 Git 提交信息及用户看到的更新说明：

```powershell
npm run release -- patch --message "修复模块切换残留" --notes-file "release-notes.md"
```

`--message` 是 Git 提交信息，省略时使用 `release: v版本号`。`--notes-file` 指向 UTF-8 文本或 Markdown 文件（相对项目根目录，也支持绝对路径及带空格的路径），文件内容会完整用于 GitHub Release 正文和 updater 的 `latest.json` 更新说明。软件弹窗目前按纯文本显示说明。省略该参数时使用默认说明，不会沿用上一版。

例如先在 `release-notes.md` 中填写：

```markdown
本次更新
- 修复模块切换后的页面残留
- 优化用户信息面板布局
```

两个参数均可配合 `--dry-run`，预览版本、提交信息及更新说明。说明内容会生成到 `.github/release.json` 并随发布提交保存；CI 校验它与版本标签一致，再传给 Tauri 发布步骤。请勿把私钥或密码写入更新说明。文件不存在、内容为空、参数值缺失时会在修改版本前报错。

`patch` 递增修订号（0.1.0 → 0.1.1）；`minor` 递增次版本（0.1.0 → 0.2.0）；`major` 递增主版本（0.1.0 → 1.0.0）。版本以 `tauri.conf.json` 为准，自动同步 Cargo、npm 配置和锁文件。

命令必须在 main 分支运行，会提交当前所有未被 Git 忽略的更改。发布前会检查远程分支和标签，运行前端构建、Rust 检查，通过后提交并原子推送 main 与新标签。检查失败则恢复版本文件，保留业务代码修改。若提交后网络推送失败，按终端提示重试原标签推送，不要重新递增版本。

只预览、不修改文件或发布：

```powershell
npm run release -- patch --dry-run
```

GitHub Actions 会在 Windows runner 上生成 NSIS 安装包、签名文件和 `latest.json`，并上传到该 Release。本地命令推送成功仅表示构建已触发，应在 Actions 页面确认发布成功。软件启动时会自动检查；用户也可以从右上角用户菜单手动检查更新。
