//! Named millimetre layout presets. The catalog row serializes edits/deletes so
//! concurrent clients cannot remove the last preset or overwrite a newer edit.
use mysql::{prelude::Queryable, PooledConn, TxOpts};
use rusqlite::{Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutConfig {
    plate_height: f64,
    plate_width: f64,
    effective_height: f64,
    effective_width: f64,
    effective_right: f64,
    // Older catalogs stored spacing per preset. Accept that field when reading
    // them, but never return or persist it: spacing is now a workspace setting.
    #[serde(default, rename = "spacing", skip_serializing)]
    _legacy_spacing: Option<f64>,
    hole_size: f64,
    hole_count: u32,
    hole_gap: f64,
    hole_left: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct LayoutPreset {
    id: String,
    name: String,
    config: LayoutConfig,
    version: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavePreset {
    id: Option<String>,
    name: String,
    config: LayoutConfig,
    version: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    presets: Vec<LayoutPreset>,
    can_manage: bool,
}

enum Operation {
    List,
    Save(SavePreset),
    Delete { id: String, version: u64 },
}

fn error(message: impl std::fmt::Display) -> String {
    format!("版面配置：{message}")
}

fn defaults() -> Vec<LayoutPreset> {
    let large = LayoutConfig {
        plate_height: 464.0,
        plate_width: 300.0,
        effective_height: 440.0,
        effective_width: 285.0,
        effective_right: 5.0,
        _legacy_spacing: None,
        hole_size: 3.0,
        hole_count: 2,
        hole_gap: 203.468,
        hole_left: 4.0,
    };
    let small = LayoutConfig {
        effective_height: 380.0,
        effective_width: 285.0,
        ..large.clone()
    };
    vec![
        LayoutPreset {
            id: "large".into(),
            name: "大版".into(),
            config: large,
            version: 1,
        },
        LayoutPreset {
            id: "small".into(),
            name: "小版".into(),
            config: small,
            version: 1,
        },
    ]
}

fn validate_config(config: &LayoutConfig) -> Result<()> {
    for (name, value) in [
        ("板材高", config.plate_height),
        ("板材宽", config.plate_width),
        ("有效高", config.effective_height),
        ("有效宽", config.effective_width),
    ] {
        if !value.is_finite() || value <= 0.0 {
            return Err(error(format!("{name}必须是大于 0 的有限毫米数")));
        }
    }
    for (name, value) in [
        ("有效区域右边距", config.effective_right),
        ("孔直径", config.hole_size),
        ("孔间距", config.hole_gap),
        ("孔左边距", config.hole_left),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(error(format!("{name}必须是非负的有限毫米数")));
        }
    }
    if config.effective_width + config.effective_right > config.plate_width
        || config.effective_height > config.plate_height
    {
        return Err(error("有效区域不能超出板材"));
    }
    if config.hole_count > 0 {
        if config.hole_size <= 0.0 || config.hole_left + config.hole_size > config.plate_width {
            return Err(error("孔直径必须大于 0，且圆孔不能超出板材宽度"));
        }
        // Gap is the upper hole's top to the next hole's bottom, not center pitch.
        if config.hole_count > 1 && config.hole_gap < config.hole_size * 2.0 {
            return Err(error("孔间距不能使相邻圆孔重叠"));
        }
        let extent = (config.hole_count - 1) as f64 * (config.hole_gap - config.hole_size).max(0.0)
            + config.hole_size;
        if extent > config.plate_height {
            return Err(error("圆孔总高度不能超出板材"));
        }
    }
    Ok(())
}

fn check_access(operation: &Operation, can_manage: bool) -> Result<()> {
    if !can_manage && !matches!(operation, Operation::List) {
        return Err(error("生产环境只允许选择版面配置，不能新增、编辑或删除"));
    }
    Ok(())
}

fn update_catalog(
    presets: &mut Vec<LayoutPreset>,
    operation: Operation,
    fresh_id: Option<String>,
) -> Result<bool> {
    match operation {
        Operation::List => Ok(false),
        Operation::Save(input) => {
            validate_config(&input.config)?;
            let name = input.name.trim();
            if name.is_empty() || name.chars().count() > 40 || name.chars().any(char::is_control) {
                return Err(error("名称需为 1–40 个字符，不能包含换行或控制字符"));
            }
            if presets.iter().any(|preset| {
                Some(&preset.id) != input.id.as_ref()
                    && preset.name.to_lowercase() == name.to_lowercase()
            }) {
                return Err(error("已有同名版面配置"));
            }
            if let Some(id) = input.id {
                let preset = presets
                    .iter_mut()
                    .find(|preset| preset.id == id)
                    .ok_or_else(|| error("该版面配置已被删除，请刷新后重试"))?;
                if input.version != Some(preset.version) {
                    return Err(error("该版面配置已被修改，请刷新后重试"));
                }
                let version = preset
                    .version
                    .checked_add(1)
                    .ok_or_else(|| error("版本号超出范围"))?;
                *preset = LayoutPreset {
                    id,
                    name: name.into(),
                    config: input.config,
                    version,
                };
            } else {
                if input.version.is_some() {
                    return Err(error("新建版面配置不能包含旧版本号"));
                }
                let id = fresh_id.ok_or_else(|| error("无法生成版面配置编号"))?;
                presets.push(LayoutPreset {
                    id,
                    name: name.into(),
                    config: input.config,
                    version: 1,
                });
            }
            Ok(true)
        }
        Operation::Delete { id, version } => {
            let index = presets
                .iter()
                .position(|preset| preset.id == id)
                .ok_or_else(|| error("该版面配置已被删除，请刷新后重试"))?;
            if presets[index].version != version {
                return Err(error("该版面配置已被修改，请刷新后重试"));
            }
            if presets.len() <= 1 {
                return Err(error("至少需要保留一个版面配置"));
            }
            presets.remove(index);
            Ok(true)
        }
    }
}

fn decode(payload: &str) -> Result<Vec<LayoutPreset>> {
    let presets: Vec<LayoutPreset> = serde_json::from_str(payload)
        .map_err(|_| error("保存的版面配置无法读取，请检查数据库；未覆盖已有数据"))?;
    if presets.is_empty() {
        return Err(error("保存的版面配置为空，请检查数据库；未重建默认值"));
    }
    Ok(presets)
}

fn execute_local(
    conn: &mut Connection,
    operation: Operation,
    can_manage: bool,
) -> Result<Snapshot> {
    check_access(&operation, can_manage)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS imposition_layout_presets (
        id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL
    )",
    )
    .map_err(error)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    // Seed the catalog row only. Deleting an individual built-in never restores it.
    tx.execute(
        "INSERT OR IGNORE INTO imposition_layout_presets(id,payload) VALUES(1,?1)",
        [serde_json::to_string(&defaults()).map_err(error)?],
    )
    .map_err(error)?;
    let payload: String = tx
        .query_row(
            "SELECT payload FROM imposition_layout_presets WHERE id=1",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    let fresh_id = if matches!(&operation, Operation::Save(input) if input.id.is_none()) {
        Some(
            tx.query_row("SELECT lower(hex(randomblob(16)))", [], |row| {
                row.get::<_, String>(0)
            })
            .map_err(error)?,
        )
    } else {
        None
    };
    let mut presets = decode(&payload)?;
    if update_catalog(&mut presets, operation, fresh_id)? {
        tx.execute(
            "UPDATE imposition_layout_presets SET payload=?1 WHERE id=1",
            [serde_json::to_string(&presets).map_err(error)?],
        )
        .map_err(error)?;
    }
    tx.commit().map_err(error)?;
    Ok(Snapshot {
        presets,
        can_manage,
    })
}

// Called from the normal cloud schema migration under its database-wide lock.
pub(crate) fn initialize_cloud_store(conn: &mut impl Queryable) -> Result<()> {
    conn.query_drop(
        "CREATE TABLE IF NOT EXISTS pf_imposition_layout_presets (
        id TINYINT UNSIGNED PRIMARY KEY, payload JSON NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin",
    )
    .map_err(crate::cloud::store::error)
}

fn execute_cloud(
    conn: &mut PooledConn,
    operation: Operation,
    can_manage: bool,
) -> Result<Snapshot> {
    check_access(&operation, can_manage)?;
    let mut tx = conn
        .start_transaction(TxOpts::default())
        .map_err(crate::cloud::store::error)?;
    // A no-op duplicate update takes an exclusive record lock directly. INSERT
    // IGNORE would take shared duplicate-key locks, then two simultaneous callers
    // could deadlock while both upgrade to SELECT ... FOR UPDATE.
    tx.exec_drop(
        "INSERT INTO pf_imposition_layout_presets(id,payload) VALUES(1,?) ON DUPLICATE KEY UPDATE id=id",
        (serde_json::to_string(&defaults()).map_err(error)?,),
    )
    .map_err(crate::cloud::store::error)?;
    let payload: String = tx
        .query_first(
            "SELECT CAST(payload AS CHAR) FROM pf_imposition_layout_presets WHERE id=1 FOR UPDATE",
        )
        .map_err(crate::cloud::store::error)?
        .ok_or_else(|| error("无法读取版面配置"))?;
    let fresh_id = if matches!(&operation, Operation::Save(input) if input.id.is_none()) {
        Some(crate::cloud::store::uuid(&mut tx)?)
    } else {
        None
    };
    let mut presets = decode(&payload)?;
    if update_catalog(&mut presets, operation, fresh_id)? {
        tx.exec_drop(
            "UPDATE pf_imposition_layout_presets SET payload=? WHERE id=1",
            (serde_json::to_string(&presets).map_err(error)?,),
        )
        .map_err(crate::cloud::store::error)?;
    }
    tx.commit().map_err(crate::cloud::store::error)?;
    Ok(Snapshot {
        presets,
        can_manage,
    })
}

async fn execute(app: tauri::AppHandle, operation: Operation) -> Result<Snapshot> {
    let can_manage = tauri::is_dev();
    check_access(&operation, can_manage)?;
    tauri::async_runtime::spawn_blocking(move || match crate::cloud::config::load()? {
        Some(environment) => execute_cloud(
            &mut crate::cloud::store::connect(&environment)?,
            operation,
            can_manage,
        ),
        None => execute_local(&mut crate::database(&app)?, operation, can_manage),
    })
    .await
    .map_err(|e| error(format!("读取任务失败：{e}")))?
}

#[tauri::command]
pub async fn list_imposition_layout_presets(app: tauri::AppHandle) -> Result<Snapshot> {
    execute(app, Operation::List).await
}

#[tauri::command]
pub async fn save_imposition_layout_preset(
    app: tauri::AppHandle,
    preset: SavePreset,
) -> Result<Snapshot> {
    execute(app, Operation::Save(preset)).await
}

#[tauri::command]
pub async fn delete_imposition_layout_preset(
    app: tauri::AppHandle,
    id: String,
    version: u64,
) -> Result<Snapshot> {
    execute(app, Operation::Delete { id, version }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save(preset: &LayoutPreset) -> Operation {
        Operation::Save(SavePreset {
            id: Some(preset.id.clone()),
            name: preset.name.clone(),
            config: preset.config.clone(),
            version: Some(preset.version),
        })
    }

    #[test]
    fn defaults_are_seeded_once_and_small_only_changes_requested_parameters() {
        let mut conn = Connection::open_in_memory().unwrap();
        let first = execute_local(&mut conn, Operation::List, false).unwrap();
        assert!(!first.can_manage);
        assert_eq!(first.presets, defaults());
        let mut expected_small = first.presets[0].config.clone();
        expected_small.effective_height = 380.0;
        assert_eq!(first.presets[1].config, expected_small);
        let remaining = execute_local(
            &mut conn,
            Operation::Delete {
                id: "small".into(),
                version: 1,
            },
            true,
        )
        .unwrap();
        assert_eq!(remaining.presets.len(), 1);
        assert_eq!(
            execute_local(&mut conn, Operation::List, true)
                .unwrap()
                .presets,
            remaining.presets
        );
        assert!(execute_local(
            &mut conn,
            Operation::Delete {
                id: "large".into(),
                version: 1
            },
            true
        )
        .unwrap_err()
        .contains("至少"));
    }

    #[test]
    fn editing_is_atomic_versioned_and_preserves_other_presets() {
        let mut conn = Connection::open_in_memory().unwrap();
        let original = execute_local(&mut conn, Operation::List, true)
            .unwrap()
            .presets;
        let mut edited = original[0].clone();
        edited.name = "定制大版".into();
        edited.config.effective_right = 6.0;
        let updated = execute_local(&mut conn, save(&edited), true)
            .unwrap()
            .presets;
        assert_eq!(updated[0].version, 2);
        assert_eq!(updated[0].config.effective_right, 6.0);
        assert_eq!(updated[1], original[1]);
        assert!(execute_local(&mut conn, save(&edited), true)
            .unwrap_err()
            .contains("已被修改"));
        assert!(execute_local(
            &mut conn,
            Operation::Delete {
                id: "large".into(),
                version: 1
            },
            true
        )
        .unwrap_err()
        .contains("已被修改"));
        let mut invalid = updated[0].clone();
        invalid.config.effective_width = 301.0;
        assert!(execute_local(&mut conn, save(&invalid), true)
            .unwrap_err()
            .contains("有效区域"));
        assert_eq!(
            execute_local(&mut conn, Operation::List, true)
                .unwrap()
                .presets,
            updated
        );
        let created = execute_local(
            &mut conn,
            Operation::Save(SavePreset {
                id: None,
                name: "  三号版  ".into(),
                config: updated[0].config.clone(),
                version: None,
            }),
            true,
        )
        .unwrap()
        .presets;
        assert_eq!(created.len(), 3);
        assert_eq!(created[2].name, "三号版");
        assert_eq!(created[2].version, 1);
        assert_eq!(created[2].id.len(), 32);
        assert_eq!(&created[..2], &updated);
        assert!(execute_local(
            &mut conn,
            Operation::Save(SavePreset {
                id: None,
                name: "三号版".into(),
                config: updated[0].config.clone(),
                version: None,
            }),
            true
        )
        .unwrap_err()
        .contains("同名"));
    }

    #[test]
    fn production_mutations_are_rejected_before_accessing_storage() {
        let mut conn = Connection::open_in_memory().unwrap();
        assert!(execute_local(&mut conn, save(&defaults()[0]), false)
            .unwrap_err()
            .contains("生产环境"));
        assert!(execute_local(
            &mut conn,
            Operation::Delete {
                id: "large".into(),
                version: 1
            },
            false
        )
        .unwrap_err()
        .contains("生产环境"));
        let table_count: u32 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='imposition_layout_presets'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 0);
        assert_eq!(
            execute_local(&mut conn, Operation::List, false)
                .unwrap()
                .presets
                .len(),
            2
        );
    }

    #[test]
    fn old_preset_spacing_is_readable_but_not_exposed_or_saved_again() {
        let mut conn = Connection::open_in_memory().unwrap();
        execute_local(&mut conn, Operation::List, true).unwrap();
        let mut legacy = serde_json::to_value(defaults()).unwrap();
        legacy[0]["config"]["spacing"] = serde_json::json!(3.0);
        legacy[1]["config"]["spacing"] = serde_json::json!(8.0);
        conn.execute(
            "UPDATE imposition_layout_presets SET payload=?1 WHERE id=1",
            [serde_json::to_string(&legacy).unwrap()],
        )
        .unwrap();

        let snapshot = execute_local(&mut conn, Operation::List, false).unwrap();
        assert_eq!(snapshot.presets[1].config.effective_height, 380.0);
        let response = serde_json::to_value(&snapshot).unwrap();
        for preset in response["presets"].as_array().unwrap() {
            assert!(preset["config"].get("spacing").is_none());
        }
        execute_local(&mut conn, save(&snapshot.presets[0]), true).unwrap();
        let payload: String = conn
            .query_row(
                "SELECT payload FROM imposition_layout_presets WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let saved: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert!(saved
            .as_array()
            .unwrap()
            .iter()
            .all(|preset| preset["config"].get("spacing").is_none()));
        // Unknown parameters remain errors; only the historical spacing field
        // receives compatibility treatment.
        legacy[0]["config"]["misspelledWidth"] = serde_json::json!(285.0);
        assert!(serde_json::from_value::<Vec<LayoutPreset>>(legacy).is_err());
    }

    #[test]
    fn geometry_validation_uses_outer_hole_span_and_checks_all_numbers() {
        let original = defaults()[0].config.clone();
        assert!(validate_config(&original).is_ok());
        let mut config = original.clone();
        config.plate_height = f64::NAN;
        assert!(validate_config(&config).is_err());
        config = original.clone();
        config.effective_right = -1.0;
        assert!(validate_config(&config).is_err());
        config = original.clone();
        config.hole_left = 298.0;
        assert!(validate_config(&config).is_err());
        config = original.clone();
        config.hole_gap = 464.0;
        assert!(validate_config(&config).is_ok());
        config.hole_gap = 464.1;
        assert!(validate_config(&config).is_err());
        config.hole_gap = 4.0;
        assert!(validate_config(&config).is_err());
        config.hole_count = 0;
        config.hole_size = 0.0;
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn concurrent_deletes_cannot_remove_the_last_preset() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("presets.sqlite");
        execute_local(&mut Connection::open(&path).unwrap(), Operation::List, true).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = ["large", "small"]
            .into_iter()
            .map(|id| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut conn = Connection::open(path).unwrap();
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    barrier.wait();
                    execute_local(
                        &mut conn,
                        Operation::Delete {
                            id: id.into(),
                            version: 1,
                        },
                        true,
                    )
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|message| message.contains("至少")));
        assert_eq!(
            execute_local(&mut Connection::open(path).unwrap(), Operation::List, true)
                .unwrap()
                .presets
                .len(),
            1
        );
    }

    #[test]
    fn corrupted_catalog_is_reported_without_reseeding() {
        let mut conn = Connection::open_in_memory().unwrap();
        execute_local(&mut conn, Operation::List, true).unwrap();
        conn.execute(
            "UPDATE imposition_layout_presets SET payload='broken' WHERE id=1",
            [],
        )
        .unwrap();
        assert!(execute_local(&mut conn, Operation::List, true)
            .unwrap_err()
            .contains("未覆盖"));
        let payload: String = conn
            .query_row(
                "SELECT payload FROM imposition_layout_presets WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payload, "broken");
    }
}
