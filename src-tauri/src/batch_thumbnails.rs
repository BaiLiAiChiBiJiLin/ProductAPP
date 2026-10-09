//! Small history-card previews, kept separate from the original SVG assets.
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Mutex, time::UNIX_EPOCH};

// Even independent WebView requests must never decode several SVGs at once.
static RENDER_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchThumbnail { pub asset_id: String, pub name: String, pub url: String }

pub fn load(conn: &Connection, batch_id: &str) -> Result<Vec<BatchThumbnail>, String> {
    let _guard = RENDER_LOCK.lock().map_err(|error| error.to_string())?;
    let saved_at: String = conn.query_row("SELECT saved_at FROM batches WHERE id=?1", [batch_id], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?.ok_or("历史批次不存在")?;
    // Only select references for the first four images, not a full batch payload.
    let sources: Vec<(String, String, String)> = {
        let mut statement = conn.prepare("SELECT json_extract(image.value,'$.id'), COALESCE(json_extract(image.value,'$.name'),''),
            COALESCE(json_extract(image.value,'$.storagePath'),'') FROM batches, json_each(batches.payload) image
            WHERE batches.id=?1 ORDER BY CAST(image.key AS INTEGER) LIMIT 4").map_err(|error| error.to_string())?;
        let rows = statement.query_map([batch_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|error| error.to_string())?
    };
    let versions: Vec<_> = sources.iter().map(|(id, name, path)| {
        let stat = fs::metadata(path).ok();
        let modified = stat.as_ref().and_then(|stat| stat.modified().ok()).and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|time| time.as_nanos().to_string());
        (id, name, path, stat.map(|stat| stat.len()), modified, if path.is_empty() { saved_at.as_str() } else { "" })
    }).collect();
    let signature = serde_json::to_string(&(1, versions)).map_err(|error| error.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS batch_thumbnail_cache(batch_id TEXT PRIMARY KEY, signature TEXT NOT NULL, payload TEXT NOT NULL)")
        .map_err(|error| error.to_string())?;
    let cached: Option<String> = conn.query_row("SELECT payload FROM batch_thumbnail_cache WHERE batch_id=?1 AND signature=?2", params![batch_id, signature], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    if let Some(cached) = cached {
        if let Ok(previews) = serde_json::from_str(&cached) { return Ok(previews); }
    }
    let mut previews = Vec::with_capacity(sources.len());
    let mut complete = true;
    for (id, name, path) in sources {
        let rendered = (|| {
            // Older batches may still contain inline artwork. Resolve just the
            // current image when needed; never hydrate the other batch images.
            let inline: String = conn.query_row("SELECT COALESCE(json_extract(image.value,'$.svg'),'') FROM batches, json_each(batches.payload) image
                WHERE batches.id=?1 AND json_extract(image.value,'$.id')=?2 LIMIT 1", params![batch_id, id], |row| row.get(0)).map_err(|error| error.to_string())?;
            let source = if inline.is_empty() { fs::read(&path).map_err(|error| error.to_string())? } else { inline.into_bytes() };
            render(&source, Path::new(&path))
        })();
        let url = match rendered {
            Ok(bytes) => format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
            Err(error) => { complete = false; log::warn!("批次缩略图生成失败 id={id}：{error}"); String::new() }
        };
        previews.push(BatchThumbnail { asset_id: id, name, url });
    }
    if complete {
        // Do not resurrect a cache entry if this batch was deleted during render.
        conn.execute("INSERT INTO batch_thumbnail_cache(batch_id,signature,payload)
            SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM batches WHERE id=?1)
            ON CONFLICT(batch_id) DO UPDATE SET signature=excluded.signature,payload=excluded.payload",
            params![batch_id, signature, serde_json::to_string(&previews).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
    }
    Ok(previews)
}

fn render(source: &[u8], path: &Path) -> Result<Vec<u8>, String> {
    let mut options = crate::assets::export_options()?;
    options.resources_dir = path.parent().map(Path::to_owned);
    let tree = usvg::Tree::from_data(source, &options).map_err(|error| error.to_string())?;
    let scale = 128.0 / tree.size().width().max(tree.size().height());
    let mut pixmap = tiny_skia::Pixmap::new((tree.size().width() * scale).ceil().max(1.0) as u32, (tree.size().height() * scale).ceil().max(1.0) as u32).ok_or("无法创建缩略图")?;
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    pixmap.encode_png().map_err(|error| error.to_string())
}

pub fn remove(conn: &Connection, batch_id: &str) -> Result<(), String> {
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_thumbnail_cache')", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if exists { conn.execute("DELETE FROM batch_thumbnail_cache WHERE batch_id=?1", [batch_id]).map_err(|error| error.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_first_four_are_rendered_and_cached_without_altering_originals() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE batches(id TEXT PRIMARY KEY,saved_at TEXT,payload TEXT)").unwrap();
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="200mm"><rect width="100%" height="100%" fill="#f00"/></svg>"##;
        let assets: Vec<_> = (0..84).map(|index| json!({"id":index.to_string(),"name":"图","svg":if index < 4 { svg } else { "not-svg" }})).collect();
        let payload = serde_json::to_string(&assets).unwrap();
        conn.execute("INSERT INTO batches VALUES('batch','time',?1)", [&payload]).unwrap();
        let previews = load(&conn, "batch").unwrap();
        assert_eq!(previews.len(), 4);
        for (index, preview) in previews.iter().enumerate() {
            assert_eq!(preview.asset_id, index.to_string());
            let png = STANDARD.decode(preview.url.strip_prefix("data:image/png;base64,").unwrap()).unwrap();
            let pixmap = tiny_skia::Pixmap::decode_png(&png).unwrap();
            assert_eq!((pixmap.width(),pixmap.height()),(64,128));
            assert_eq!(&pixmap.data()[0..4], &[255,0,0,255]);
        }
        assert_eq!(conn.query_row("SELECT payload FROM batches", [], |row| row.get::<_,String>(0)).unwrap(), payload);
        // A cache hit must not reparse SVG. References/order/version stay intact.
        let mut no_svg = assets; for asset in &mut no_svg { asset["svg"] = json!("invalid"); }
        conn.execute("UPDATE batches SET payload=?1", [serde_json::to_string(&no_svg).unwrap()]).unwrap();
        assert_eq!(load(&conn, "batch").unwrap()[0].url, previews[0].url);
        assert_eq!(conn.query_row("SELECT count(*) FROM batch_thumbnail_cache", [], |row| row.get::<_,usize>(0)).unwrap(), 1);
    }

    #[test]
    fn file_previews_preserve_svg_bytes_and_refresh_after_a_file_change() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE batches(id TEXT PRIMARY KEY,saved_at TEXT,payload TEXT)").unwrap();
        let path = std::env::temp_dir().join(format!("printflow-thumbnail-test-{}-{}.svg", std::process::id(), std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="44.477mm" height="192.807mm"><rect width="100%" height="100%" fill="red"/></svg>"#;
        fs::write(&path, svg).unwrap();
        let payload = json!([{"id":"source","name":"原图","storagePath":path.to_str().unwrap(),"svg":""}]).to_string();
        conn.execute("INSERT INTO batches VALUES('batch','time',?1)", [&payload]).unwrap();
        assert!(load(&conn, "batch").unwrap()[0].url.starts_with("data:image/png;base64,"));
        assert_eq!(fs::read(&path).unwrap(), svg.as_bytes());
        assert_eq!(conn.query_row("SELECT payload FROM batches", [], |row| row.get::<_,String>(0)).unwrap(), payload);
        // A changed/missing file must not leave a stale, misleading preview.
        fs::write(&path, "not an SVG").unwrap();
        assert!(load(&conn, "batch").unwrap()[0].url.is_empty());
        fs::remove_file(&path).unwrap();
        assert!(load(&conn, "batch").unwrap()[0].url.is_empty());
    }
}
