//! Cached public product options used by the schematic product selector.
//!
//! The credential stays in the native process.  The WebView only receives the
//! validated JSON response from the local cache.

use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

const PUBLIC_PRODUCT_OPTIONS_URL: &str =
    "https://new-feystar.vercel.app/api/public/product-options";
const PUBLIC_PRODUCT_OPTIONS_API_KEY: &str =
    "f211f490c996f6d01c5770b2c814081cc720d809e4eba05f05b44641ff16ab54";
const MAX_PUBLIC_PRODUCT_OPTIONS_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn cache_path() -> PathBuf {
    crate::project_data_dir().join("cache/public-product-options.json")
}

fn validate(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_PUBLIC_PRODUCT_OPTIONS_BYTES {
        return Err(format!(
            "公共产品选项响应过大（上限 {} MB）",
            MAX_PUBLIC_PRODUCT_OPTIONS_BYTES / (1024 * 1024)
        ));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("公共产品选项 JSON 无效：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "公共产品选项响应格式无效".to_string())?;
    if object.get("success").and_then(Value::as_bool) == Some(false) {
        return Err("公共产品选项接口返回失败".into());
    }
    let has_category_products = object
        .get("categories")
        .and_then(Value::as_array)
        .is_some_and(|categories| {
            categories.iter().any(|category| {
                category
                    .get("products")
                    .and_then(Value::as_array)
                    .is_some_and(|products| !products.is_empty())
            })
        });
    let has_uncategorized_products = object
        .get("uncategorizedProducts")
        .and_then(Value::as_array)
        .is_some_and(|products| !products.is_empty());
    if !has_category_products && !has_uncategorized_products {
        return Err("公共产品选项响应缺少可用产品".into());
    }
    Ok(())
}

pub(crate) fn write_cache(path: &Path, bytes: &[u8]) -> Result<(), String> {
    validate(bytes)?;
    let parent = path
        .parent()
        .ok_or_else(|| "公共产品选项缓存目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let result = (|| -> std::io::Result<()> {
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("公共产品选项缓存写入失败：{error}"))
}

pub(crate) const UPDATED_EVENT: &str = "public-product-options-updated";

pub(crate) async fn refresh_public_product_options_inner() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(PUBLIC_PRODUCT_OPTIONS_URL)
        .header("Accept", "application/json")
        .header("X-API-Key", PUBLIC_PRODUCT_OPTIONS_API_KEY)
        .send()
        .await
        .map_err(|error| format!("公共产品选项请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("公共产品选项请求返回 HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PUBLIC_PRODUCT_OPTIONS_BYTES as u64)
    {
        return Err(format!(
            "公共产品选项响应过大（上限 {} MB）",
            MAX_PUBLIC_PRODUCT_OPTIONS_BYTES / (1024 * 1024)
        ));
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_PUBLIC_PRODUCT_OPTIONS_BYTES as u64) as usize,
    );
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("公共产品选项读取失败：{error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_PUBLIC_PRODUCT_OPTIONS_BYTES {
            return Err(format!(
                "公共产品选项响应过大（上限 {} MB）",
                MAX_PUBLIC_PRODUCT_OPTIONS_BYTES / (1024 * 1024)
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let path = cache_path();
    tokio::task::spawn_blocking(move || write_cache(&path, &bytes))
        .await
        .map_err(|error| error.to_string())??;
    Ok(())
}

#[tauri::command]
pub async fn refresh_public_product_options(app: tauri::AppHandle) -> Result<(), String> {
    let result = refresh_public_product_options_inner().await;
    if result.is_ok() {
        use tauri::Emitter;
        let _ = app.emit(UPDATED_EVENT, ());
    }
    result
}

#[tauri::command]
pub async fn load_public_product_options() -> Result<String, String> {
    let path = cache_path();
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("公共产品选项本地缓存不可用：{error}"))?;
    validate(&bytes)?;
    String::from_utf8(bytes).map_err(|error| format!("公共产品选项缓存不是 UTF-8：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &[u8] = br#"{"success":true,"categories":[{"products":[{"productId":"P1","title":"Product","options":[]}]}],"uncategorizedProducts":[]}"#;

    #[test]
    fn validates_public_response_shape_without_exposing_credentials() {
        assert!(validate(VALID).is_ok());
        assert!(validate(br#"{"success":false,"categories":[]}"#).is_err());
        assert!(validate(br#"{"success":true}"#).is_err());
        assert!(
            validate(br#"{"success":true,"categories":[],"uncategorizedProducts":[]}"#).is_err()
        );
        assert!(validate(br#"not-json"#).is_err());
    }

    #[test]
    fn cache_write_is_atomic_and_rejects_invalid_payload() {
        let directory =
            std::env::temp_dir().join(format!("printflow-public-options-{}", std::process::id()));
        let path = directory.join("public-product-options.json");
        let _ = fs::remove_dir_all(&directory);
        assert!(write_cache(&path, VALID).is_ok());
        assert_eq!(fs::read(&path).unwrap(), VALID);
        assert!(write_cache(&path, br#"{"success":false}"#).is_err());
        assert_eq!(fs::read(&path).unwrap(), VALID);
        assert!(!directory.join("public-product-options.json.tmp").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
