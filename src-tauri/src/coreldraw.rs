use std::{path::{Path, PathBuf}, process::Command};

fn executable() -> Result<PathBuf, String> {
    // Corel's default installations, including versioned suite directories.
    for root in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        let Some(root) = std::env::var_os(root) else { continue };
        let Ok(suites) = std::fs::read_dir(PathBuf::from(root).join("Corel")) else { continue };
        for suite in suites.flatten() {
            let mut installations = vec![suite.path()];
            // Recent suites put the executable under a major-version folder.
            if let Ok(versions) = std::fs::read_dir(suite.path()) {
                installations.extend(versions.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()));
            }
            for installation in installations {
                for directory in ["Programs64", "Programs"] {
                    let candidate = installation.join(directory).join("CorelDRW.exe");
                    if candidate.is_file() { return Ok(candidate); }
                }
            }
        }
    }
    // App Paths supports installations outside Program Files. No user input is
    // interpolated into the discovery script or executed through a shell.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let result = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", r#"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\CorelDRW.exe','HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\CorelDRW.exe','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\CorelDRW.exe')) { if (Test-Path -LiteralPath $key) { $value = (Get-Item -LiteralPath $key).GetValue(''); if ($value) { Write-Output $value; break } } }"#])
            .creation_flags(0x08000000).output();
        if let Ok(result) = result {
            let candidate = PathBuf::from(String::from_utf8_lossy(&result.stdout).trim().trim_matches('"'));
            if candidate.is_file() { return Ok(candidate); }
        }
    }
    Err("未找到 CorelDRAW，请安装 CorelDRAW 或修复其应用注册信息后重试".into())
}

fn launch(path: &Path) -> Result<(), String> {
    if !cfg!(windows) { return Err("CorelDRAW 本地联动仅支持 Windows".into()); }
    if !path.is_file() { return Err("所选图片不存在或无法访问，请重新选择".into()); }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["svg", "png", "jpg", "jpeg", "cdr"].contains(&extension.as_str()) {
        return Err("仅支持 SVG、PNG、JPG、JPEG 和 CDR 文件".into());
    }
    Command::new(executable()?).arg(path).spawn()
        .map_err(|error| format!("无法启动 CorelDRAW：{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn open_with_coreldraw(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || launch(Path::new(&path)))
        .await.map_err(|error| error.to_string())?
}
