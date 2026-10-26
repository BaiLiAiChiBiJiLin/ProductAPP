use super::config::Environment;
use mysql::{
    prelude::Queryable, OptsBuilder, Pool, PoolConstraints, PoolOpts, PooledConn, SslOpts, TxOpts,
};
use serde_json::{json, Value};
use std::{
    sync::{Mutex, OnceLock},
    time::Duration,
};

pub type Result<T> = std::result::Result<T, String>;
pub fn error(error: mysql::Error) -> String {
    // Never log a connection URL, credentials, bound payloads or raw server messages.
    match error {
        mysql::Error::MySqlError(e) => format!(
            "云数据库操作失败（代码 {}），请检查权限、表结构或刷新后重试",
            e.code
        ),
        _ => "云数据库连接或请求失败，请检查网络、白名单、账号和 TLS 证书；未切换到本地保存".into(),
    }
}

pub fn connect(env: &Environment) -> Result<PooledConn> {
    // The updater enables ring while reqwest enables aws-lc. Choose a provider
    // explicitly; rustls cannot infer one when both features are present.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    if env.database.username.is_empty() || env.database.password.is_empty() {
        return Err("请先在 config.toml 填写当前环境的数据库账号和密码".into());
    }
    static POOL: OnceLock<Mutex<Option<Pool>>> = OnceLock::new();
    let mut saved = POOL
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "数据库连接池不可用")?;
    if saved.is_none() {
        let ssl = SslOpts::default().with_root_cert_path(env.database.ca_certificate.clone());
        let options = OptsBuilder::default()
            .ip_or_hostname(Some(env.database.host.clone()))
            .tcp_port(env.database.port)
            .db_name(Some(env.database.name.clone()))
            .user(Some(env.database.username.clone()))
            .pass(Some(env.database.password.clone()))
            .ssl_opts(Some(ssl))
            .tcp_connect_timeout(Some(Duration::from_secs(10)))
            .read_timeout(Some(Duration::from_secs(30)))
            .write_timeout(Some(Duration::from_secs(30)))
            .pool_opts(PoolOpts::default().with_constraints(PoolConstraints::new(0, 4).unwrap()));
        let pool = Pool::new(options).map_err(error)?;
        let mut conn = pool.get_conn().map_err(error)?;
        initialize(&mut conn)?;
        *saved = Some(pool);
    }
    saved.as_ref().unwrap().get_conn().map_err(error)
}

pub fn initialize(conn: &mut impl Queryable) -> Result<()> {
    super::schema_upgrade::initialize(conn)
}

pub fn uuid(conn: &mut impl Queryable) -> Result<String> {
    conn.query_first("SELECT UUID()")
        .map_err(error)?
        .ok_or_else(|| "无法生成记录 ID".into())
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    let s = text(v, key);
    if s.is_empty() || s.len() > 190 {
        Err(format!("缺少或无效字段：{key}"))
    } else {
        Ok(s)
    }
}
pub fn json_value(text: String) -> Result<Value> {
    serde_json::from_str(&text).map_err(|_| "云端记录格式错误".into())
}

#[derive(Clone)]
pub struct Record {
    pub value: Value,
    pub summary: Value,
    pub version: u64,
    pub owner: Option<String>,
}
pub fn read(conn: &mut impl Queryable, kind: &str, id: &str, lock: bool) -> Result<Option<Record>> {
    let sql = format!("SELECT CAST(payload AS CHAR),CAST(summary AS CHAR),version,CAST(owner_id AS CHAR) FROM pf_records WHERE kind=? AND record_key=?{}", if lock { " FOR UPDATE" } else { "" });
    let row: Option<(String, String, u64, Option<String>)> =
        conn.exec_first(sql, (kind, id)).map_err(error)?;
    row.map(|(payload, summary, version, owner)| {
        Ok(Record {
            value: json_value(payload)?,
            summary: json_value(summary)?,
            version,
            owner,
        })
    })
    .transpose()
}
pub fn owned(record: &Record, user: &str) -> Result<()> {
    if record.owner.as_deref() != Some(user) {
        return Err("该历史批次已转移或不属于当前用户，请刷新列表".into());
    }
    Ok(())
}
pub fn check_version(record: Option<&Record>, expected: u64) -> Result<()> {
    if record.map_or(0, |r| r.version) != expected {
        return Err("记录已被其他用户修改，请重新打开后再保存；本次修改未覆盖云端内容".into());
    }
    Ok(())
}
pub fn write(
    conn: &mut impl Queryable,
    kind: &str,
    id: &str,
    owner: Option<&str>,
    version: u64,
    value: &Value,
    summary: &Value,
) -> Result<()> {
    let source = if kind == "job" {
        Some(record_id(
            conn,
            "review",
            required(value, "sourceReviewId")?,
        )?)
    } else {
        None
    };
    let name = text(summary, "customerName");
    let time = if kind == "job" {
        text(summary, "submittedAt")
    } else {
        text(summary, "savedAt")
    };
    conn.exec_drop("INSERT INTO pf_records(kind,record_key,owner_id,version,name,saved_at,status,source_review_id,summary,payload) VALUES(?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE owner_id=VALUES(owner_id),version=VALUES(version),name=VALUES(name),saved_at=VALUES(saved_at),status=VALUES(status),summary=VALUES(summary),payload=VALUES(payload)",
        (kind,id,owner,version,name,time,text(summary,"status"),source,summary.to_string(),value.to_string())).map_err(error)?;
    super::resources::update_refs(conn, kind, id, value)
}
pub fn record_id(conn: &mut impl Queryable, kind: &str, key: &str) -> Result<u64> {
    conn.exec_first(
        "SELECT id FROM pf_records WHERE kind=? AND record_key=?",
        (kind, key),
    )
    .map_err(error)?
    .ok_or("关联业务记录不存在".into())
}
pub fn remove(conn: &mut impl Queryable, kind: &str, id: &str) -> Result<()> {
    let number = record_id(conn, kind, id)?;
    super::resources::release_refs(conn, kind, id)?;
    conn.exec_drop(
        "UPDATE pf_migrations SET cloud_id=NULL WHERE cloud_id=?",
        (number,),
    )
    .map_err(error)?;
    if kind == "batch" {
        conn.exec_drop(
            "UPDATE pf_transfers SET batch_id=NULL WHERE batch_id=?",
            (number,),
        )
        .map_err(error)?;
    }
    conn.exec_drop(
        "DELETE FROM pf_records WHERE kind=? AND record_key=?",
        (kind, id),
    )
    .map_err(error)
}

pub fn list(conn: &mut PooledConn, kind: &str, user: &str, args: &Value) -> Result<Value> {
    let q = &args["query"];
    let size = q["pageSize"].as_u64().unwrap_or(20).clamp(1, 100);
    let normalize = |key| -> Result<String> {
        let value = text(q, key);
        if value.is_empty() {
            return Ok(String::new());
        }
        chrono::DateTime::parse_from_rfc3339(value)
            .map(|v| {
                v.with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .map_err(|_| "日期格式错误".into())
    };
    let from = normalize("dateFrom")?;
    let to = normalize("dateTo")?;
    if !from.is_empty() && !to.is_empty() && from >= to {
        return Err("日期范围无效".into());
    }
    let owner = if kind == "batch" { user } else { "" };
    let search = text(q, "search").trim();
    let condition = "kind=? AND (?='' OR owner_id=?) AND (?='' OR LOCATE(LOWER(?),LOWER(CONCAT(name,' ',COALESCE(JSON_UNQUOTE(JSON_EXTRACT(summary,'$.output')),''))))>0) AND (?='' OR saved_at>=?) AND (?='' OR saved_at<?) AND (kind<>'job' OR status='pending')";
    let parameters = (kind, owner, owner, search, search, &from, &from, &to, &to);
    let mut tx = conn.start_transaction(TxOpts::default()).map_err(error)?;
    let total: u64 = tx
        .exec_first(
            format!("SELECT COUNT(*) FROM pf_records WHERE {condition}"),
            parameters.clone(),
        )
        .map_err(error)?
        .unwrap_or(0);
    let page = q["page"]
        .as_u64()
        .unwrap_or(1)
        .clamp(1, total.saturating_sub(1) / size + 1);
    let rows: Vec<(String,u64)> = tx.exec(format!("SELECT CAST(summary AS CHAR),version FROM pf_records WHERE {condition} ORDER BY saved_at DESC,id DESC LIMIT {size} OFFSET {}",(page-1)*size),parameters).map_err(error)?;
    let records = rows
        .into_iter()
        .map(|(s, version)| {
            let mut v = json_value(s)?;
            v["version"] = json!(version);
            Ok(v)
        })
        .collect::<Result<Vec<_>>>()?;
    tx.commit().map_err(error)?;
    Ok(json!({"records":records,"total":total,"page":page,"pageSize":size}))
}

// All writers sharing this schema use the same database lock. It also protects
// the filesystem publish/garbage-collection boundary, which cannot be a SQL transaction.
pub fn exclusive<T>(
    conn: &mut PooledConn,
    action: impl FnOnce(&mut PooledConn) -> Result<T>,
) -> Result<T> {
    let locked: Option<u8> = conn
        .query_first("SELECT GET_LOCK(CONCAT(DATABASE(), ':printflow-write'),10)")
        .map_err(error)?;
    if locked != Some(1) {
        return Err("其他电脑正在保存，请稍后重试".into());
    }
    let result = action(conn);
    let released = conn
        .query_drop("DO RELEASE_LOCK(CONCAT(DATABASE(), ':printflow-write'))")
        .map_err(error);
    match (result, released) {
        (Ok(v), Ok(())) => Ok(v),
        (Err(e), _) => Err(e),
        (_, Err(e)) => Err(e),
    }
}
