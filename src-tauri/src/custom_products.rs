mod storage;
pub use storage::CustomProduct;
use storage::{connect, read, write};
use base64::Engine;

#[tauri::command]
pub async fn import_custom_product_image(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败：{e}"))?;
        if bytes.len() > 35 * 1024 * 1024 { return Err("图片不能超过 35MB".into()); }
        let mime = match std::path::Path::new(&path).extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
            "svg" => "image/svg+xml", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", _ => return Err("仅支持 SVG、PNG、JPG、WEBP 图片".into()),
        };
        Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_custom_products() -> Result<Vec<CustomProduct>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        read(&connect(&crate::project_data_dir().join("custom-products.sqlite"))?)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_custom_product(product: CustomProduct) -> Result<CustomProduct, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write(&mut connect(&crate::project_data_dir().join("custom-products.sqlite"))?, product)
    }).await.map_err(|e| e.to_string())?
}
