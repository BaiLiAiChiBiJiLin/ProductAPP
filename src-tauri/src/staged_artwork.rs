use std::{fs, io::Write, path::PathBuf};

pub const PREFIX: &str = "printflow-export:";

pub fn path(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err("无效的导出缓存标识".into());
    }
    Ok(std::env::temp_dir().join(format!("printflow-export-{id}.txt")))
}

pub fn read(reference: &str) -> Result<String, String> {
    let id = reference.strip_prefix(PREFIX).ok_or("无效的导出资源引用")?;
    fs::read_to_string(path(id)?).map_err(|error| format!("读取导出图片失败：{error}"))
}

/// SVG files keep authored XML/font/layer metadata rather than normalizing it
/// through the PDF flattener. Only resolve our temporary image hrefs.
pub fn embed_images(mut svg: String) -> Result<String, String> {
    use base64::Engine;
    let document = roxmltree::Document::parse(&svg).map_err(|e|e.to_string())?;
    let mut edits = Vec::new();
    for node in document.descendants().filter(|node| node.has_tag_name("image")) {
        for href in node.attributes().filter(|attribute| attribute.name()=="href" && attribute.value().starts_with(PREFIX)) {
            let original=read(href.value())?;
            edits.push((href.range_value(),format!("data:image/svg+xml;base64,{}",base64::engine::general_purpose::STANDARD.encode(original.as_bytes()))));
        }
    }
    for (range,value) in edits.into_iter().rev() { svg.replace_range(range,&value); }
    Ok(svg)
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn svg_export_embeds_authored_layers_without_rewriting_xml_or_text() {
        use base64::Engine;
        let id=format!("abc-{:x}",std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let original="<svg xmlns=\"http://www.w3.org/2000/svg\"><g id=\"front\"><text font-family=\"Authored Font\">custom</text></g></svg>";
        fs::write(path(&id).unwrap(),original).unwrap();
        let exported=embed_images(format!("<svg><image href=\"{PREFIX}{id}\"/><text>{PREFIX}not-an-image</text></svg>")).unwrap();
        fs::remove_file(path(&id).unwrap()).unwrap();
        let document=roxmltree::Document::parse(&exported).unwrap();
        let href=document.descendants().find(|node|node.has_tag_name("image")).unwrap().attribute("href").unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(href.strip_prefix("data:image/svg+xml;base64,").unwrap()).unwrap(),original.as_bytes());
        assert!(exported.contains("printflow-export:not-an-image"));
    }
}

#[tauri::command]
pub async fn write_export_resource_chunk(
    id: String,
    text: String,
    append: bool,
) -> Result<(), String> {
    if text.len() > 256 * 1024 {
        return Err("导出数据块超过大小限制".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(!append)
            .truncate(!append)
            .append(append)
            .open(path(&id)?)
            .map_err(|error| error.to_string())?;
        file.write_all(text.as_bytes())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
