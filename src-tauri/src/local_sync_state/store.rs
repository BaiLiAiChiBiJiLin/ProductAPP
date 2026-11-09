use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    time::Duration,
};

const DATABASE_FILE: &str = "cloud-sync.sqlite";
const MAX_SCOPE_BYTES: usize = 16 * 1024;
const MAX_KEY_BYTES: usize = 1024;
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const MAX_PENDING_WRITES: usize = 64;

fn validate_identity(scope: &str, key: &str) -> Result<(), String> {
    if scope.is_empty() || scope.len() > MAX_SCOPE_BYTES {
        return Err("本地同步状态 scope 长度必须为 1 至 16384 字节".into());
    }
    if key.is_empty() || key.len() > MAX_KEY_BYTES {
        return Err("本地同步状态 key 长度必须为 1 至 1024 字节".into());
    }
    Ok(())
}

fn connect(root: &Path) -> Result<Connection, String> {
    fs::create_dir_all(root).map_err(|error| format!("创建本地同步状态目录失败：{error}"))?;
    let conn = Connection::open(root.join(DATABASE_FILE))
        .map_err(|error| format!("打开本地同步数据库失败：{error}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("设置本地同步数据库等待时间失败：{error}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS local_sync_state (
             scope TEXT NOT NULL,
             key TEXT NOT NULL,
             payload TEXT NOT NULL,
             PRIMARY KEY (scope, key)
         );",
    )
    .map_err(|error| format!("初始化本地同步数据库失败：{error}"))?;
    Ok(conn)
}

pub(super) fn load(root: &Path, scope: &str, key: &str) -> Result<Option<String>, String> {
    validate_identity(scope, key)?;
    connect(root)?
        .query_row(
            "SELECT payload FROM local_sync_state WHERE scope = ?1 AND key = ?2",
            params![scope, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取本地同步状态失败：{error}"))
}

pub(super) fn save(root: &Path, scope: &str, key: &str, payload: &str) -> Result<(), String> {
    validate_identity(scope, key)?;
    let mut conn = connect(root)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("开始本地同步状态写入失败：{error}"))?;
    tx.execute(
        "INSERT INTO local_sync_state(scope, key, payload) VALUES(?1, ?2, ?3)
         ON CONFLICT(scope, key) DO UPDATE SET payload = excluded.payload",
        params![scope, key, payload],
    )
    .map_err(|error| format!("写入本地同步状态失败：{error}"))?;
    tx.commit()
        .map_err(|error| format!("提交本地同步状态失败：{error}"))
}

pub(super) fn delete(root: &Path, scope: &str, key: &str) -> Result<(), String> {
    validate_identity(scope, key)?;
    connect(root)?
        .execute(
            "DELETE FROM local_sync_state WHERE scope = ?1 AND key = ?2",
            params![scope, key],
        )
        .map(|_| ())
        .map_err(|error| format!("删除本地同步状态失败：{error}"))
}

pub(super) struct PendingWrite {
    scope: String,
    key: String,
    file: File,
}

impl PendingWrite {
    pub(super) fn commit(mut self, root: &Path) -> Result<(), String> {
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("定位本地同步暂存数据失败：{error}"))?;
        let mut payload = String::new();
        self.file
            .read_to_string(&mut payload)
            .map_err(|error| format!("读取本地同步暂存数据失败：{error}"))?;
        // The old record remains intact until the SQLite transaction commits.
        // Dropping the file removes temporary bytes on success and failure.
        save(root, &self.scope, &self.key, &payload)
    }
}

#[derive(Default)]
pub(super) struct PendingWrites {
    next_id: u64,
    entries: HashMap<String, PendingWrite>,
}

impl PendingWrites {
    pub(super) fn begin(
        &mut self,
        root: &Path,
        scope: String,
        key: String,
    ) -> Result<String, String> {
        validate_identity(&scope, &key)?;
        if self.entries.len() >= MAX_PENDING_WRITES {
            return Err("本地同步分块写入任务过多，请等待现有保存完成".into());
        }
        let next_id = self
            .next_id
            .checked_add(1)
            .ok_or("本地同步分块写入标识已耗尽，请重启软件")?;
        let staging = root.join("sync-staging");
        fs::create_dir_all(&staging)
            .map_err(|error| format!("创建本地同步暂存目录失败：{error}"))?;
        // This unnamed temporary file is removed by the OS when its handle is
        // closed, including process exit. No stale-file sweep can delete another
        // running instance's upload, and callers never supply a filesystem path.
        let file = tempfile::tempfile_in(&staging)
            .map_err(|error| format!("创建本地同步暂存文件失败：{error}"))?;
        self.next_id = next_id;
        let write_id = format!("sync-{}-{next_id}", std::process::id());
        self.entries
            .insert(write_id.clone(), PendingWrite { scope, key, file });
        Ok(write_id)
    }

    pub(super) fn append(&mut self, write_id: &str, chunk: &str) -> Result<(), String> {
        let pending = self
            .entries
            .get_mut(write_id)
            .ok_or("本地同步分块写入任务不存在或已结束")?;
        let result = if chunk.len() > MAX_CHUNK_BYTES {
            Err("本地同步数据块超过 256 KiB 大小限制".to_string())
        } else {
            pending
                .file
                .write_all(chunk.as_bytes())
                .map_err(|error| format!("追加本地同步暂存数据失败：{error}"))
        };
        if result.is_err() {
            // A partially written chunk must never be committed as complete.
            self.entries.remove(write_id);
        }
        result
    }

    pub(super) fn take(&mut self, write_id: &str) -> Result<PendingWrite, String> {
        self.entries
            .remove(write_id)
            .ok_or_else(|| "本地同步分块写入任务不存在或已结束".into())
    }

    pub(super) fn abort(&mut self, write_id: &str) {
        self.entries.remove(write_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_utf8_payload_survives_reopen_and_scope_isolation() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let payload = format!(r#"{{"assets":"{}"}}"#, "图片😀".repeat(900_000));
        assert!(payload.len() > 8 * 1024 * 1024);
        assert_eq!(load(root, "user-a", "journal").unwrap(), None);
        save(root, "user-a", "journal", &payload).unwrap();
        save(root, "user-b", "journal", "other user").unwrap();
        save(root, "user-a", "queue", "other key").unwrap();
        assert_eq!(
            load(root, "user-a", "journal").unwrap().as_deref(),
            Some(payload.as_str())
        );
        delete(root, "user-a", "journal").unwrap();
        assert_eq!(load(root, "user-a", "journal").unwrap(), None);
        assert_eq!(
            load(root, "user-b", "journal").unwrap().as_deref(),
            Some("other user")
        );
        assert_eq!(
            load(root, "user-a", "queue").unwrap().as_deref(),
            Some("other key")
        );
    }

    #[test]
    fn parameterized_identity_cannot_select_or_delete_other_records() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        save(root, "safe", "journal", "original").unwrap();
        save(root, "' OR 1=1; --", "../journal", "literal").unwrap();
        assert_eq!(
            load(root, "' OR 1=1; --", "../journal").unwrap().as_deref(),
            Some("literal")
        );
        delete(root, "' OR 1=1; --", "../journal").unwrap();
        assert_eq!(
            load(root, "safe", "journal").unwrap().as_deref(),
            Some("original")
        );
        assert!(load(root, "", "journal").is_err());
        assert!(save(root, "safe", &"x".repeat(MAX_KEY_BYTES + 1), "invalid").is_err());
    }

    #[test]
    fn chunked_write_publishes_only_after_commit_and_cleans_on_abort() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        save(root, "user", "journal", "original").unwrap();
        let mut writes = PendingWrites::default();
        let id = writes.begin(root, "user".into(), "journal".into()).unwrap();
        let chunk = "图片😀".repeat(10_000);
        for _ in 0..90 {
            writes.append(&id, &chunk).unwrap();
        }
        assert_eq!(
            load(root, "user", "journal").unwrap().as_deref(),
            Some("original")
        );
        writes.take(&id).unwrap().commit(root).unwrap();
        assert_eq!(
            load(root, "user", "journal").unwrap().as_deref(),
            Some(chunk.repeat(90).as_str())
        );
        assert!(writes.take(&id).is_err());
        let id = writes.begin(root, "user".into(), "journal".into()).unwrap();
        writes.append(&id, "incomplete").unwrap();
        writes.abort(&id);
        writes.abort(&id);
        assert!(writes.take(&id).is_err());
        assert_eq!(fs::read_dir(root.join("sync-staging")).unwrap().count(), 0);
    }

    #[test]
    fn failed_commit_preserves_previous_record_and_reports_sqlite_reason() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        save(root, "user", "journal", "recoverable request").unwrap();
        connect(root)
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER refuse_write BEFORE UPDATE ON local_sync_state
             BEGIN SELECT RAISE(ABORT, 'forced storage failure'); END;",
            )
            .unwrap();
        let mut writes = PendingWrites::default();
        let id = writes.begin(root, "user".into(), "journal".into()).unwrap();
        writes.append(&id, "replacement").unwrap();
        let error = writes.take(&id).unwrap().commit(root).unwrap_err();
        assert!(error.contains("写入本地同步状态失败"), "{error}");
        assert!(error.contains("forced storage failure"), "{error}");
        assert_eq!(
            load(root, "user", "journal").unwrap().as_deref(),
            Some("recoverable request")
        );
        assert_eq!(fs::read_dir(root.join("sync-staging")).unwrap().count(), 0);
    }

    #[test]
    fn malformed_database_is_an_error_and_is_never_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let original = b"damaged database preserved for recovery";
        fs::write(root.join(DATABASE_FILE), original).unwrap();
        assert!(load(root, "user", "journal").is_err());
        assert!(save(root, "user", "journal", "replacement").is_err());
        assert!(delete(root, "user", "journal").is_err());
        assert_eq!(fs::read(root.join(DATABASE_FILE)).unwrap(), original);
    }

    #[test]
    fn failed_append_and_dropped_sessions_remove_temporary_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        save(root, "user", "journal", "original").unwrap();
        let mut writes = PendingWrites::default();
        let id = writes.begin(root, "user".into(), "journal".into()).unwrap();
        assert!(writes
            .append(&id, &"x".repeat(MAX_CHUNK_BYTES + 1))
            .is_err());
        assert!(writes.take(&id).is_err());
        assert!(writes.append("../../outside", "unexpected").is_err());
        let id = writes.begin(root, "user".into(), "journal".into()).unwrap();
        writes.append(&id, "interrupted").unwrap();
        drop(writes);
        assert_eq!(fs::read_dir(root.join("sync-staging")).unwrap().count(), 0);
        assert_eq!(
            load(root, "user", "journal").unwrap().as_deref(),
            Some("original")
        );
    }
}
