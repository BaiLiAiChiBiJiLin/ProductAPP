mod storage;
mod names;
pub use storage::CustomProduct;
use storage::connect;
use base64::Engine;
use tauri::Manager;

#[tauri::command]
pub async fn load_custom_product_config(app: tauri::AppHandle) -> Result<String, String> {
    let local = crate::project_data_dir().join("cache/custom-clear-acrylic.json");
    let path = if local.is_file() { local } else {
        app.path().resolve("presets/custom-clear-acrylic.json", tauri::path::BaseDirectory::Resource).map_err(|e| e.to_string())?
    };
    tokio::fs::read_to_string(path).await.map_err(|e| format!("自定义产品选项读取失败：{e}"))
}

fn product_connection(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let mut conn = connect(&crate::project_data_dir().join("custom-products.sqlite"))?;
    if !cfg!(debug_assertions) {
        let path = app.path().resource_dir().map_err(|e| e.to_string())?.join("presets/custom-products.json");
        let json = std::fs::read_to_string(path).map_err(|e| format!("读取内置自定义产品失败：{e}"))?;
        storage::seed(&mut conn, &json)?;
    }
    Ok(conn)
}

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
pub async fn list_custom_products(app: tauri::AppHandle) -> Result<Vec<names::ProductName>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        names::list(&product_connection(&app)?)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_custom_product(app: tauri::AppHandle, product: CustomProduct) -> Result<CustomProduct, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut product = product;
        let existing = names::list(&product_connection(&app)?)?.into_iter().find(|item| item.name == product.name.trim()).ok_or("请先点击新增保存产品名称")?;
        product.id = Some(existing.id);
        product.name = existing.name;
        Ok(product)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_custom_product_name(app: tauri::AppHandle, name: String) -> Result<names::ProductName, String> {
    tauri::async_runtime::spawn_blocking(move || names::add(&mut product_connection(&app)?, &name)).await.map_err(|e| e.to_string())?
}
