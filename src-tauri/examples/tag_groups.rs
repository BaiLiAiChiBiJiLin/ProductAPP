//! Add stable IDs to direct artwork groups in a CorelDRAW SVG without
//! reserializing the document or touching embedded base64 data.
use std::{env, fs};

fn main() -> Result<(), String> {
    let input = env::args().nth(1).ok_or("请传入原始 SVG 路径")?;
    let output = env::args().nth(2).ok_or("请传入输出 SVG 路径")?;
    let source = fs::read_to_string(&input).map_err(|e| e.to_string())?;
    let doc = roxmltree::Document::parse_with_options(&source, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).map_err(|e| e.to_string())?;
    let layer = doc.root().descendants().find(|node| node.is_element() && node.tag_name().name() == "g" && node.attribute("id").unwrap_or_default().contains("图层"))
        .ok_or("未找到 CorelDRAW 图层 g")?;
    let groups = layer.children().filter(|node| node.is_element() && node.tag_name().name() == "g").collect::<Vec<_>>();
    let mut tagged = source.clone();
    let mut changed = 0;
    for (index, group) in groups.iter().enumerate().rev() {
        if group.attribute("id").is_some() { continue; }
        let id = format!("generated-group-{:03}", index + 1);
        tagged.insert_str(group.range().start + 2, &format!(" id=\"{id}\""));
        changed += 1;
    }
    fs::write(&output, tagged).map_err(|e| e.to_string())?;
    println!("输入: {input}");
    println!("输出: {output}");
    println!("图层直接子 g: {}，新增 id: {}", groups.len(), changed);
    Ok(())
}
