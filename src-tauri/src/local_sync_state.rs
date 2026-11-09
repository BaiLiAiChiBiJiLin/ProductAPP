//! Device-local recovery state. These commands never use shared business storage.
mod store;

use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct SyncWrites(Arc<Mutex<store::PendingWrites>>);

#[tauri::command]
pub async fn load_local_sync_state(scope: String, key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        store::load(&crate::project_data_dir(), &scope, &key)
    })
    .await
    .map_err(|error| format!("读取本地同步状态任务失败：{error}"))?
}

#[tauri::command]
pub async fn save_local_sync_state(
    scope: String,
    key: String,
    payload: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        store::save(&crate::project_data_dir(), &scope, &key, &payload)
    })
    .await
    .map_err(|error| format!("保存本地同步状态任务失败：{error}"))?
}

#[tauri::command]
pub async fn delete_local_sync_state(scope: String, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        store::delete(&crate::project_data_dir(), &scope, &key)
    })
    .await
    .map_err(|error| format!("删除本地同步状态任务失败：{error}"))?
}

#[tauri::command]
pub async fn begin_local_sync_write(
    writes: tauri::State<'_, SyncWrites>,
    scope: String,
    key: String,
) -> Result<String, String> {
    let writes = writes.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        writes
            .lock()
            .map_err(|_| "本地同步分块写入状态锁不可用".to_string())?
            .begin(&crate::project_data_dir(), scope, key)
    })
    .await
    .map_err(|error| format!("创建本地同步分块写入任务失败：{error}"))?
}

#[tauri::command]
pub async fn append_local_sync_write(
    writes: tauri::State<'_, SyncWrites>,
    write_id: String,
    chunk: String,
) -> Result<(), String> {
    let writes = writes.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        writes
            .lock()
            .map_err(|_| "本地同步分块写入状态锁不可用".to_string())?
            .append(&write_id, &chunk)
    })
    .await
    .map_err(|error| format!("追加本地同步分块写入任务失败：{error}"))?
}

#[tauri::command]
pub async fn commit_local_sync_write(
    writes: tauri::State<'_, SyncWrites>,
    write_id: String,
) -> Result<(), String> {
    let writes = writes.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Release the registry lock before reading and committing a large payload.
        let pending = writes
            .lock()
            .map_err(|_| "本地同步分块写入状态锁不可用".to_string())?
            .take(&write_id)?;
        pending.commit(&crate::project_data_dir())
    })
    .await
    .map_err(|error| format!("提交本地同步分块写入任务失败：{error}"))?
}

#[tauri::command]
pub async fn abort_local_sync_write(
    writes: tauri::State<'_, SyncWrites>,
    write_id: String,
) -> Result<(), String> {
    let writes = writes.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        writes
            .lock()
            .map_err(|_| "本地同步分块写入状态锁不可用".to_string())?
            .abort(&write_id);
        Ok(())
    })
    .await
    .map_err(|error| format!("取消本地同步分块写入任务失败：{error}"))?
}
