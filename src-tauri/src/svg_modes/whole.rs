//! Whole-artwork SVG import. This mode deliberately preserves the original
//! document as one asset and does not inspect or split drawable nodes.

pub(crate) fn sources(data: &str) -> Result<Vec<(String, String)>, String> {
    if !data.contains("<svg") { return Err("文件不是 SVG".into()); }
    Ok(vec![(String::new(), data.to_owned())])
}
