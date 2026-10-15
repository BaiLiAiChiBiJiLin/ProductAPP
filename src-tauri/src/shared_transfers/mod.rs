mod cleanup;
mod files;
pub(crate) mod store;
mod transport;

use serde::Serialize;
use std::{collections::HashMap, path::Path};
use tauri::{Emitter, Manager};
use transport::{Manifest, Preview, SyncResult};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: String,
    completed: usize,
    total: usize,
}

fn connection(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let conn = crate::database(app)?;
    crate::schematic_review::ensure_store(&conn)?;
    let _ = crate::asset_storage::settings(&conn, &crate::project_data_dir().join("assets"))?;
    Ok(conn)
}

fn root() -> &'static Path {
    Path::new(transport::root_for_environment(tauri::is_dev()))
}

#[tauri::command]
pub fn shared_transfer_directory() -> String {
    root().to_string_lossy().into_owned()
}

fn cleanup_files(conn: &rusqlite::Connection, app: &tauri::AppHandle) -> Result<(), String> {
    let roots = vec![
        crate::project_data_dir().join("assets"),
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("production-imposition"),
    ];
    // Retain cleanup candidates until cleanup succeeds, so restart retries a
    // locked file instead of losing it when the business transaction commits.
    let mut stmt = conn.prepare("SELECT task_id,cleanup_paths FROM shared_transfer_outbox WHERE status='complete' AND cleanup_paths<>'[]'").map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (task, json) in rows {
        let paths: Vec<String> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        cleanup::remove_unreferenced(conn, &paths, &roots)?;
        conn.execute(
            "UPDATE shared_transfer_outbox SET cleanup_paths='[]' WHERE task_id=?1",
            [task],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn initialize_shared_user(
    app: tauri::AppHandle,
    user_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = transport::register(root(), &user_name)?;
        let conn = connection(&app)?;
        transport::recover_preparing(
            &conn,
            &crate::project_data_dir().join("shared-transfers/outgoing"),
        )?;
        let _ = transport::finalize(&conn, root())?;
        if let Err(error) = cleanup_files(&conn, &app) {
            log::warn!("转移后原文件清理失败，下次刷新重试：{error}");
        }
        Ok(folder.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_shared_transfer_users(user_name: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || transport::users(root(), &user_name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn preview_shared_batch_transfer(
    app: tauri::AppHandle,
    batch_id: String,
) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || transport::preview(&connection(&app)?, &batch_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn send_shared_batch(
    app: tauri::AppHandle,
    batch_id: String,
    user_name: String,
    recipient: String,
) -> Result<Manifest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = connection(&app)?;
        let mut progress = |phase: &str, completed, total| {
            let _ = app.emit(
                "shared-transfer-progress",
                Progress {
                    phase: phase.into(),
                    completed,
                    total,
                },
            );
        };
        transport::send(
            &conn,
            root(),
            &crate::project_data_dir().join("shared-transfers/outgoing"),
            &batch_id,
            &user_name,
            &recipient,
            &mut progress,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn refresh_shared_transfers(
    app: tauri::AppHandle,
    user_name: String,
) -> Result<SyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = connection(&app)?;
        let settings =
            crate::asset_storage::settings(&conn, &crate::project_data_dir().join("assets"))?;
        let (finalized, _) = transport::finalize(&conn, root())?;
        let cleanup_error = cleanup_files(&conn, &app).err();
        let mut custom_ids = |names: &[String]| -> Result<HashMap<String, String>, String> {
            crate::custom_products::register_transferred_names(names)
        };
        let mut progress = |phase: &str, completed, total| {
            let _ = app.emit(
                "shared-transfer-progress",
                Progress {
                    phase: phase.into(),
                    completed,
                    total,
                },
            );
        };
        let mut result = transport::receive(
            &conn,
            root(),
            Path::new(&settings.history_directory),
            &user_name,
            &mut custom_ids,
            &mut progress,
        )?;
        result.finalized = finalized;
        if let Some(error) = cleanup_error {
            result
                .errors
                .push(format!("转移已完成，原文件清理将在下次刷新重试：{error}"));
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
