use crate::{asset_storage::{self, StorageSettings}, database, project_data_dir};

#[tauri::command]
pub async fn load_storage_settings(app: tauri::AppHandle) -> Result<StorageSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        asset_storage::settings(&database(&app)?, &project_data_dir().join("assets"))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_storage_settings(app: tauri::AppHandle, directory: String) -> Result<StorageSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = project_data_dir();
        asset_storage::save_settings(&database(&app)?, &root.join("assets"), &directory, &root.join("temp-assets"))
    }).await.map_err(|error| error.to_string())?
}
