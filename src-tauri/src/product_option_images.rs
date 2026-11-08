//! Product option image uploads. Credentials stay outside the frontend and bundled catalogs.
use aws_lc_rs::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, io::Read, path::Path, time::Duration};

const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const ENTITY_KEYS: [&str; 13] = [
    "sizeBandId",
    "printOptionId",
    "techniqueId",
    "holoFilmId",
    "materialId",
    "accessoryStyleId",
    "accessoryColorId",
    "customOptionValueId",
    "standeeQuantityId",
    "tinplateMaterialId",
    "foilStampingId",
    "stickerHoloFilmId",
    "tinplateHoloFilmId",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageUploadInput {
    entity_key: String,
    value_id: String,
    content_base64: String,
    content_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageUploadResult {
    url: String,
    object_key: String,
}

struct OssConfig {
    access_key_id: String,
    access_key_secret: String,
    bucket: String,
    host: String,
    prefix: String,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn normalized_prefix(value: &str) -> Result<String, String> {
    let value = value.trim().trim_matches('/');
    if value.len() > 512
        || (!value.is_empty()
            && value.split('/').any(|part| {
                part.is_empty()
                    || part == "."
                    || part == ".."
                    || !part.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
            }))
    {
        return Err("OSS_OBJECT_PREFIX 只能包含字母、数字、下划线、短横线和目录分隔符。".into());
    }
    Ok(value.to_string())
}

fn endpoint_host(
    bucket: &str,
    region: &str,
    endpoint: &str,
    cname: bool,
) -> Result<String, String> {
    if !(3..=63).contains(&bucket.len())
        || !bucket
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || !bucket.as_bytes()[0].is_ascii_alphanumeric()
        || !bucket.as_bytes()[bucket.len() - 1].is_ascii_alphanumeric()
    {
        return Err("OSS_BUCKET 格式不正确。".into());
    }
    if !region.starts_with("oss-")
        || !region
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("OSS_REGION 格式不正确。".into());
    }
    let region_host = format!("{region}.aliyuncs.com");
    let bucket_host = format!("{bucket}.{region_host}");
    let raw = if endpoint.trim().is_empty() {
        &region_host
    } else {
        endpoint.trim()
    };
    let raw_url = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url = reqwest::Url::parse(&raw_url).map_err(|_| "OSS_ENDPOINT 格式不正确。")?;
    let host = url.host_str().ok_or("OSS_ENDPOINT 缺少域名。")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !host.contains('.')
        || host.split('.').any(|part| {
            part.is_empty()
                || part.starts_with('-')
                || part.ends_with('-')
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err("OSS_ENDPOINT 必须是无路径、无查询参数的 HTTPS 域名。".into());
    }
    if host == bucket_host || host == region_host {
        return Ok(bucket_host);
    }
    if !cname {
        return Err(
            "OSS_ENDPOINT 与 Bucket/Region 不匹配；自定义域名需启用 OSS_ENDPOINT_IS_CNAME。".into(),
        );
    }
    Ok(host.to_string())
}

fn config_from_values(
    values: &Value,
    environment: impl Fn(&str) -> Option<String>,
) -> Result<OssConfig, String> {
    let read = |name: &str| -> String {
        environment(name)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| match values.get(name) {
                Some(Value::String(value)) => value.clone(),
                Some(Value::Bool(value)) => value.to_string(),
                _ => String::new(),
            })
            .trim()
            .to_string()
    };
    let required = |name: &str| -> Result<String, String> {
        let value = read(name);
        if value.is_empty() {
            Err(format!(
                "未配置 {name}。请在产品配置目录的 oss.local.json 或服务端环境变量中设置。"
            ))
        } else {
            Ok(value)
        }
    };
    let access_key_id = required("OSS_ACCESS_KEY_ID")?;
    let access_key_secret = required("OSS_ACCESS_KEY_SECRET")?;
    // Header-safe validation also prevents accidentally returning a raw transport error containing a key.
    if !access_key_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric())
        || access_key_secret.chars().any(char::is_control)
    {
        return Err("OSS 访问密钥格式不正确。".into());
    }
    let bucket = required("OSS_BUCKET")?;
    let region = required("OSS_REGION")?;
    let cname = match read("OSS_ENDPOINT_IS_CNAME").to_ascii_lowercase().as_str() {
        "" | "false" => false,
        "true" => true,
        _ => return Err("OSS_ENDPOINT_IS_CNAME 只能为 true 或 false。".into()),
    };
    Ok(OssConfig {
        host: endpoint_host(&bucket, &region, &read("OSS_ENDPOINT"), cname)?,
        prefix: normalized_prefix(&read("OSS_OBJECT_PREFIX"))?,
        access_key_id,
        access_key_secret,
        bucket,
    })
}

fn load_config(path: &Path) -> Result<OssConfig, String> {
    let values = match fs::File::open(path) {
        Ok(file) => {
            let mut content = Vec::new();
            file.take(64 * 1024 + 1)
                .read_to_end(&mut content)
                .map_err(|_| "无法读取产品配置目录的 oss.local.json。")?;
            if content.len() > 64 * 1024 {
                return Err("oss.local.json 文件过大。".into());
            }
            serde_json::from_slice::<Value>(&content)
                .map_err(|_| "oss.local.json 不是有效的 JSON 配置。")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(_) => return Err("无法读取产品配置目录的 oss.local.json。".into()),
    };
    config_from_values(&values, |name| std::env::var(name).ok())
}

fn image_extension(content_type: &str, bytes: &[u8]) -> Result<&'static str, String> {
    let detected = if bytes.len() >= 24
        && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && &bytes[12..16] == b"IHDR"
    {
        Some(("image/png", "png"))
    } else if bytes.len() >= 4 && bytes.starts_with(b"\xff\xd8\xff") {
        Some(("image/jpeg", "jpg"))
    } else if bytes.len() >= 13 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        Some(("image/gif", "gif"))
    } else if bytes.len() >= 16
        && &bytes[..4] == b"RIFF"
        && &bytes[8..12] == b"WEBP"
        && [&b"VP8 "[..], &b"VP8L"[..], &b"VP8X"[..]].contains(&&bytes[12..16])
    {
        Some(("image/webp", "webp"))
    } else {
        None
    };
    match detected {
        Some((mime, extension)) if mime == content_type => Ok(extension),
        _ => Err("请选择有效的 PNG、JPEG、WebP 或 GIF 图片，文件内容须与图片类型一致。".into()),
    }
}

fn validate_upload(input: &ImageUploadInput) -> Result<(Vec<u8>, &'static str), String> {
    if !ENTITY_KEYS.contains(&input.entity_key.as_str()) || !valid_id(&input.value_id) {
        return Err("图片所属选项标识无效。".into());
    }
    if input.content_base64.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("图片不能超过 4 MiB。".into());
    }
    let bytes = STANDARD
        .decode(&input.content_base64)
        .map_err(|_| "图片数据无效，请重新选择图片。")?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片不能为空且不能超过 4 MiB。".into());
    }
    let extension = image_extension(&input.content_type, &bytes)?;
    Ok((bytes, extension))
}

fn object_key(
    config: &OssConfig,
    input: &ImageUploadInput,
    unique: &str,
    extension: &str,
) -> String {
    let prefix = if config.prefix.is_empty() {
        String::new()
    } else {
        format!("{}/", config.prefix)
    };
    format!(
        "{prefix}uploads/product-options/{}/{}/{unique}.{extension}",
        input.entity_key, input.value_id
    )
}

fn put_signature(config: &OssConfig, key: &str, content_type: &str, date: &str) -> String {
    let canonical = format!(
        "PUT\n\n{content_type}\n{date}\nx-oss-forbid-overwrite:true\n/{}/{key}",
        config.bucket
    );
    let secret = hmac::Key::new(
        hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
        config.access_key_secret.as_bytes(),
    );
    STANDARD.encode(hmac::sign(&secret, canonical.as_bytes()).as_ref())
}

fn oss_error(status: u16, bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let code = text
        .split_once("<Code>")
        .and_then(|(_, rest)| rest.split_once("</Code>"))
        .map(|(code, _)| code)
        .filter(|code| {
            !code.is_empty()
                && code.len() <= 80
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        });
    match code {
        Some(code) => format!("OSS 上传失败（HTTP {status}，{code}）。"),
        None => format!("OSS 上传失败（HTTP {status}）。"),
    }
}

fn upload(input: ImageUploadInput, config_path: &Path) -> Result<ImageUploadResult, String> {
    let (bytes, extension) = validate_upload(&input)?;
    let config = load_config(config_path)?;
    let mut random = [0u8; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "无法生成图片文件标识，请重试。")?;
    let unique = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let object_key = object_key(&config, &input, &unique, extension);
    let url = format!("https://{}/{}", config.host, object_key);
    let date = chrono::Utc::now()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let signature = put_signature(&config, &object_key, &input.content_type, &date);
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "无法初始化图片上传连接。")?;
    let response = client
        .put(&url)
        .header("Date", &date)
        .header("Content-Type", &input.content_type)
        .header("x-oss-forbid-overwrite", "true")
        .header(
            "Authorization",
            format!("OSS {}:{signature}", config.access_key_id),
        )
        .body(bytes)
        .send()
        .map_err(|error| {
            if error.is_timeout() {
                "图片上传超时，请重试。"
            } else {
                "图片上传连接失败，请检查网络和 OSS 配置。"
            }
        })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        let _ = response.take(8192).read_to_end(&mut bytes);
        return Err(oss_error(status, &bytes));
    }
    Ok(ImageUploadResult { url, object_key })
}

#[tauri::command]
pub async fn upload_product_option_image(
    input: ImageUploadInput,
) -> Result<ImageUploadResult, String> {
    let config_path = crate::project_data_dir().join("settings/product-options/oss.local.json");
    tokio::task::spawn_blocking(move || upload(input, &config_path))
        .await
        .map_err(|_| "图片上传任务中断，请重试。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> OssConfig {
        config_from_values(
            &serde_json::json!({
                "OSS_ACCESS_KEY_ID": "fixtureAccessKey",
                "OSS_ACCESS_KEY_SECRET": "fixture-secret",
                "OSS_BUCKET": "fixture-bucket",
                "OSS_REGION": "oss-us-west-1",
                "OSS_ENDPOINT": "fixture-bucket.oss-us-west-1.aliyuncs.com",
                "OSS_ENDPOINT_IS_CNAME": false
            }),
            |_| None,
        )
        .unwrap()
    }

    fn input(bytes: &[u8], content_type: &str) -> ImageUploadInput {
        ImageUploadInput {
            entity_key: "holoFilmId".into(),
            value_id: "M1".into(),
            content_base64: STANDARD.encode(bytes),
            content_type: content_type.into(),
        }
    }

    #[test]
    fn official_endpoints_do_not_duplicate_the_bucket() {
        for endpoint in [
            "",
            "oss-us-west-1.aliyuncs.com",
            "https://oss-us-west-1.aliyuncs.com/",
            "fixture-bucket.oss-us-west-1.aliyuncs.com",
        ] {
            assert_eq!(
                endpoint_host("fixture-bucket", "oss-us-west-1", endpoint, false).unwrap(),
                "fixture-bucket.oss-us-west-1.aliyuncs.com"
            );
        }
        assert_eq!(
            endpoint_host(
                "fixture-bucket",
                "oss-us-west-1",
                "https://images.example.com/",
                true
            )
            .unwrap(),
            "images.example.com"
        );
    }

    #[test]
    fn endpoints_require_https_and_explicit_cname_for_custom_hosts() {
        for endpoint in [
            "http://oss-us-west-1.aliyuncs.com",
            "https://user:password@oss-us-west-1.aliyuncs.com",
            "https://oss-us-west-1.aliyuncs.com/a",
            "https://oss-us-west-1.aliyuncs.com?key=foo",
            "https://oss-us-west-1.aliyuncs.com#foo",
            "https://oss-us-west-1.aliyuncs.com:444",
            "https://127.0.0.1",
            "images.example.com",
        ] {
            assert!(
                endpoint_host("fixture-bucket", "oss-us-west-1", endpoint, false).is_err(),
                "{endpoint}"
            );
        }
        assert!(endpoint_host("bad/bucket", "oss-us-west-1", "", false).is_err());
        assert!(endpoint_host("fixture-bucket", "wrong-region", "", false).is_err());
    }

    #[test]
    fn environment_overrides_only_nonempty_values() {
        let config = config_from_values(&serde_json::json!({
            "OSS_ACCESS_KEY_ID": "localKey", "OSS_ACCESS_KEY_SECRET": "localSecret", "OSS_BUCKET": "fixture-bucket", "OSS_REGION": "oss-us-west-1"
        }), |name| match name {
            "OSS_ACCESS_KEY_ID" => Some("overrideKey".into()),
            "OSS_ACCESS_KEY_SECRET" => Some("   ".into()),
            _ => None,
        }).unwrap();
        assert_eq!(config.access_key_id, "overrideKey");
        assert_eq!(config.access_key_secret, "localSecret");
    }

    #[test]
    fn missing_and_invalid_config_never_echoes_secret_values() {
        let error = config_from_values(
            &serde_json::json!({"OSS_ACCESS_KEY_SECRET":"never-print-me"}),
            |_| None,
        )
        .err()
        .unwrap();
        assert!(!error.contains("never-print-me"));
        assert!(error.contains("OSS_ACCESS_KEY_ID"));
    }

    #[test]
    fn configured_prefix_and_entity_id_form_the_object_path() {
        let mut config = config();
        let input = input(b"GIF89a", "image/gif");
        assert_eq!(
            object_key(&config, &input, "012345", "gif"),
            "uploads/product-options/holoFilmId/M1/012345.gif"
        );
        config.prefix = normalized_prefix(" /catalog/v2/ ").unwrap();
        assert_eq!(
            object_key(&config, &input, "012345", "gif"),
            "catalog/v2/uploads/product-options/holoFilmId/M1/012345.gif"
        );
        for prefix in [
            "../private",
            "folder//child",
            "folder/../child",
            "folder?query",
            "folder\\child",
            "%2fescape",
        ] {
            assert!(normalized_prefix(prefix).is_err());
        }
    }

    #[test]
    fn signature_matches_independent_hmac_sha1_fixture() {
        assert_eq!(
            put_signature(
                &config(),
                "uploads/product-options/holoFilmId/M1/example.png",
                "image/png",
                "Fri, 06 Nov 2026 00:00:00 GMT"
            ),
            "Omm7DDkNdW3BApOFGZXD17usGXc="
        );
    }

    #[test]
    fn validates_image_signature_and_declared_type() {
        for (bytes, mime, extension) in [
            (
                b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01".as_slice(),
                "image/png",
                "png",
            ),
            (b"\xff\xd8\xff\xe0".as_slice(), "image/jpeg", "jpg"),
            (b"GIF89a\x01\0\x01\0\0\0\0".as_slice(), "image/gif", "gif"),
            (b"GIF87a\x01\0\x01\0\0\0\0".as_slice(), "image/gif", "gif"),
            (b"RIFF1234WEBPVP8 ".as_slice(), "image/webp", "webp"),
            (b"RIFF1234WEBPVP8L".as_slice(), "image/webp", "webp"),
            (b"RIFF1234WEBPVP8X".as_slice(), "image/webp", "webp"),
        ] {
            assert_eq!(validate_upload(&input(bytes, mime)).unwrap().1, extension);
        }
        assert!(validate_upload(&input(b"GIF89a", "image/png")).is_err());
        assert!(validate_upload(&input(b"<svg></svg>", "image/svg+xml")).is_err());
        assert!(validate_upload(&input(b"<!doctype html>", "image/png")).is_err());
        for (bytes, mime) in [
            (b"\x89PNG\r\n\x1a\n".as_slice(), "image/png"),
            (
                b"\x89PNG\r\n\x1a\n\0\0\0\rFAKE\0\0\0\x01\0\0\0\x01".as_slice(),
                "image/png",
            ),
            (b"\xff\xd8\xff".as_slice(), "image/jpeg"),
            (b"GIF89a".as_slice(), "image/gif"),
            (b"RIFF1234WEBP".as_slice(), "image/webp"),
            (b"RIFF1234WEBPFAKE".as_slice(), "image/webp"),
        ] {
            assert!(validate_upload(&input(bytes, mime)).is_err());
        }
    }

    #[test]
    fn rejects_invalid_entities_and_oversized_or_empty_files() {
        let mut value = input(b"GIF89a", "image/gif");
        value.entity_key = "id".into();
        assert!(validate_upload(&value).is_err());
        value.entity_key = "accessoryColorId".into();
        for id in ["../M1", "M1/name", "", "M1%2F"] {
            value.value_id = id.into();
            assert!(validate_upload(&value).is_err());
        }
        assert!(validate_upload(&input(&[], "image/png")).is_err());
        let mut oversized = vec![0u8; MAX_IMAGE_BYTES + 1];
        oversized[..6].copy_from_slice(b"GIF89a");
        assert!(validate_upload(&input(&oversized, "image/gif")).is_err());
    }

    #[test]
    fn oss_failure_only_exposes_a_safe_code() {
        assert_eq!(
            oss_error(
                403,
                b"<Error><Code>AccessDenied</Code><Message>secret</Message></Error>"
            ),
            "OSS 上传失败（HTTP 403，AccessDenied）。"
        );
        assert_eq!(
            oss_error(403, b"<Code>unsafe secret</Code><Key>secret</Key>"),
            "OSS 上传失败（HTTP 403）。"
        );
    }
}
