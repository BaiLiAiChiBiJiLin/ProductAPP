use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Clone, Deserialize)]
pub struct Database {
    pub host: String,
    #[serde(default = "port")]
    pub port: u16,
    pub name: String,
    pub username: String,
    pub password: String,
    pub ca_certificate: Option<PathBuf>,
}
fn port() -> u16 {
    3306
}

#[derive(Clone, Deserialize)]
pub struct Environment {
    pub database: Database,
    pub storage_root: PathBuf,
}

#[derive(Deserialize)]
struct FileConfig {
    #[serde(default = "local")]
    mode: String,
    development: Option<Environment>,
    production: Option<Environment>,
}
fn local() -> String {
    "local".into()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    pub shared: bool,
    pub environment: &'static str,
    pub config_path: String,
    pub storage_root: Option<String>,
}

const PRODUCTION_CONFIG: &str = r"\\192.168.0.66\电商文件\printFlow\production\config.toml";

fn select_path(local: PathBuf, development: bool) -> Result<PathBuf, String> {
    if development || local.try_exists().map_err(|_| "无法检查本机存储配置文件")? {
        Ok(local)
    } else {
        Ok(PathBuf::from(PRODUCTION_CONFIG))
    }
}

pub fn path() -> Result<PathBuf, String> {
    select_path(crate::project_data_dir().join("config.toml"), tauri::is_dev())
}

pub fn load() -> Result<Option<Environment>, String> {
    static CONFIG: std::sync::OnceLock<Result<Option<Environment>, String>> =
        std::sync::OnceLock::new();
    CONFIG.get_or_init(load_file).clone()
}

fn load_file() -> Result<Option<Environment>, String> {
    let path = path()?;
    if tauri::is_dev() && !path.try_exists().map_err(|_| "无法检查开发存储配置")? {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|_| "无法读取存储配置文件，请检查本机配置或公司共享目录连接；未切换到本地保存")?;
    // Do not include TOML source/parser diagnostics: they can contain a password.
    parse(&raw, tauri::is_dev())
}

fn parse(raw: &str, development: bool) -> Result<Option<Environment>, String> {
    let config: FileConfig =
        toml::from_str(raw).map_err(|_| "存储配置格式错误，请检查 config.toml")?;
    if config.mode == "local" {
        return Ok(None);
    }
    if config.mode != "shared" {
        return Err("存储模式只能是 local 或 shared".into());
    }
    let env = if development {
        config.development
    } else {
        config.production
    }
    .ok_or("缺少当前环境的云端配置")?;
    if env.database.host.trim().is_empty() || env.database.name.trim().is_empty() {
        return Err("请填写云数据库地址和数据库名称".into());
    }
    if !env.storage_root.is_absolute() {
        return Err("共享文件目录必须是绝对路径".into());
    }
    // Fail closed if a development build points to production files or schema.
    if development {
        let root = env
            .storage_root
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase();
        if root.split('/').any(|part| part == "production") || !env.database.name.ends_with("_dev")
        {
            return Err("开发环境必须使用 *_dev 数据库及开发共享目录".into());
        }
    }
    Ok(Some(env))
}

pub fn mode() -> Result<Mode, String> {
    let env = load()?;
    Ok(Mode {
        shared: env.is_some(),
        environment: if tauri::is_dev() {
            "development"
        } else {
            "production"
        },
        config_path: path()?.to_string_lossy().into_owned(),
        storage_root: env.map(|env| env.storage_root.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installed_build_uses_shared_config_unless_local_override_exists() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("config.toml");
        assert_eq!(select_path(local.clone(), false).unwrap(), PathBuf::from(PRODUCTION_CONFIG));
        assert_eq!(select_path(local.clone(), true).unwrap(), local);
        fs::write(&local, "mode='local'").unwrap();
        assert_eq!(select_path(local.clone(), false).unwrap(), local);
    }
    #[test]
    fn local_mode_needs_no_credentials_and_parse_errors_do_not_echo_secrets() {
        assert!(parse("mode='local'", true).unwrap().is_none());
        assert!(!parse("password='VERY_SECRET", true)
            .err()
            .unwrap()
            .contains("VERY_SECRET"));
    }
    #[test]
    fn development_cannot_select_production() {
        let source = "mode='shared'\n[development]\nstorage_root='C:/production/SVGhistory'\n[development.database]\nhost='example'\nname='print_flow'\nusername=''\npassword=''\n";
        assert!(parse(source, true).is_err());
        assert!(parse(
            &source
                .replace("C:/production", "C:/dev")
                .replace("name='print_flow'", "name='print_flow_dev'"),
            true
        )
        .unwrap()
        .is_some());
    }
}
