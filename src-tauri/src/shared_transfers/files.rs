use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, String>;
pub const FILE_PREFIX: &str = "printflow-transfer-file:";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

pub fn safe_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 100
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        || name.starts_with('.')
        || name.contains("..")
    {
        return Err("数据包文件名无效".into());
    }
    Ok(())
}

pub fn task_id(id: &str) -> Result<()> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("转移任务 ID 无效".into());
    }
    Ok(())
}

pub fn checked_file(root: &Path, name: &str) -> Result<PathBuf> {
    safe_name(name)?;
    let path = root.join(name);
    let canonical_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canonical_file =
        fs::canonicalize(&path).map_err(|e| format!("转移文件不可访问 {name}：{e}"))?;
    if !canonical_file.starts_with(&canonical_root) || !canonical_file.is_file() {
        return Err("转移文件超出数据包目录".into());
    }
    Ok(canonical_file)
}

pub fn stream_to(mut source: impl Read, destination: &Path) -> Result<FileEntry> {
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let count = source.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > 512 * 1024 * 1024 {
            return Err("单个转移文件超过 512 MB".into());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
        hash.update(&buffer[..count]);
    }
    output.sync_all().map_err(|e| e.to_string())?;
    Ok(FileEntry {
        name: destination
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        bytes,
        sha256: format!("{:x}", hash.finalize()),
    })
}

pub fn verify(root: &Path, entry: &FileEntry) -> Result<PathBuf> {
    let path = checked_file(root, &entry.name)?;
    let actual = describe(&path)?;
    if actual.bytes != entry.bytes || actual.sha256 != entry.sha256 {
        return Err(format!("文件校验失败：{}", entry.name));
    }
    Ok(path)
}

pub fn describe(path: &Path) -> Result<FileEntry> {
    let mut source = File::open(path).map_err(|e| e.to_string())?;
    let bytes = source.metadata().map_err(|e| e.to_string())?.len();
    if bytes > 512 * 1024 * 1024 {
        return Err("单个转移文件超过 512 MB".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = source.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(FileEntry {
        name: path
            .file_name()
            .ok_or("资源路径无效")?
            .to_string_lossy()
            .into_owned(),
        bytes,
        sha256: format!("{:x}", hash.finalize()),
    })
}

pub fn copy_verified(source_root: &Path, destination_root: &Path, entry: &FileEntry) -> Result<()> {
    let source = checked_file(source_root, &entry.name)?;
    let destination = destination_root.join(&entry.name);
    if destination.exists() {
        verify(destination_root, entry)?;
        return Ok(());
    }
    let temporary = destination_root.join(format!("{}.part", entry.name));
    // Only our own uncommitted file, never a recursive directory cleanup.
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(|e| e.to_string())?;
    }
    let copied = stream_to(File::open(source).map_err(|e| e.to_string())?, &temporary)?;
    if copied.bytes != entry.bytes || copied.sha256 != entry.sha256 {
        return Err(format!("复制校验失败：{}", entry.name));
    }
    move_new(&temporary, &destination)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 4 * 1024 * 1024 {
        return Err("转移清单过大".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("转移清单无效：{e}"))
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_extension(format!("{}-{stamp}.pending", std::process::id()));
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    move_new(&temporary, path)
}

#[cfg(windows)]
pub fn move_new(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 8) } == 0 {
        return Err(format!(
            "发布转移数据失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn move_new(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        return Err("目标转移文件已存在".into());
    }
    fs::rename(source, destination).map_err(|e| e.to_string())
}

pub struct InboxLock(File);
impl InboxLock {
    pub fn check(&self) -> Result<()> {
        let mut file = &self.0;
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(b"PrintFlow receive lock"))
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("共享目录连接已中断：{e}"))
    }
}

pub fn inbox_lock(user_folder: &Path) -> Result<InboxLock> {
    let start = Instant::now();
    loop {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        match options.open(user_folder.join(".printflow-receive.lock")) {
            Ok(file) => return Ok(InboxLock(file)),
            Err(error)
                if matches!(error.raw_os_error(), Some(32 | 33))
                    && start.elapsed() < Duration::from_secs(5) =>
            {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(error) => return Err(format!("收件目录正在使用或不可访问：{error}")),
        }
    }
}
