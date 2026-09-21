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

先把 `src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 的版本改成同一个新版本，然后提交并创建版本标签：

```powershell
git add .
git commit -m "release: v0.1.1"
git tag v0.1.1
git push origin main --tags
```

GitHub Actions 会在 Windows runner 上生成 NSIS 安装包、签名文件和 `latest.json`，并上传到该 Release。软件启动时会自动检查；用户也可以从右上角用户菜单手动检查更新。
