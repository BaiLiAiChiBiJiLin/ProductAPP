use std::{fs, io::Write, path::PathBuf};

pub const PREFIX: &str = "printflow-export:";

pub fn path(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err("无效的导出缓存标识".into());
    }
    Ok(std::env::temp_dir().join(format!("printflow-export-{id}.txt")))
}

pub fn read(reference: &str) -> Result<String, String> {
    let id = reference.strip_prefix(PREFIX).ok_or("无效的导出资源引用")?;
    fs::read_to_string(path(id)?).map_err(|error| format!("读取导出图片失败：{error}"))
}

#[tauri::command]
pub async fn write_export_resource_chunk(id: String, text: String, append: bool) -> Result<(), String> {
    if text.len() > 256 * 1024 { return Err("导出数据块超过大小限制".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = fs::OpenOptions::new().write(true).create(!append).truncate(!append).append(append)
            .open(path(&id)?).map_err(|error| error.to_string())?;
        file.write_all(text.as_bytes()).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}
