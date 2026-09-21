//! Measure an SVG in the same coordinate space used by usvg/resvg.
//! Run with:
//! cargo run --manifest-path src-tauri/Cargo.toml --example measure_svg -- "C:\\Users\\Admin\\Desktop\\Nasha Agustinus.svg"

use std::{env, fs, path::Path};
use usvg::{Options, Tree};

fn length_mm(value: Option<&str>, fallback_user_units: f64) -> f64 {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return fallback_user_units * 25.4 / 96.0;
    };
    let end = raw.find(|character: char| {
        !(character.is_ascii_digit() || matches!(character, '.' | '+' | '-' | 'e' | 'E'))
    }).unwrap_or(raw.len());
    let number = raw[..end].parse::<f64>().unwrap_or(fallback_user_units);
    match raw[end..].trim().to_ascii_lowercase().as_str() {
        "mm" => number,
        "cm" => number * 10.0,
        "in" => number * 25.4,
        "pt" => number * 25.4 / 72.0,
        "pc" => number * 25.4 / 6.0,
        "px" | "" => number * 25.4 / 96.0,
        _ => fallback_user_units * 25.4 / 96.0,
    }
}

fn view_box(source: &str) -> Result<[f64; 4], String> {
    let document = roxmltree::Document::parse_with_options(
        source,
        roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() },
    ).map_err(|error| format!("XML 解析失败：{error}"))?;
    let root = document.root_element();
    let values = root.attribute("viewBox").unwrap_or_default()
        .replace(',', " ").split_whitespace()
        .filter_map(|value| value.parse::<f64>().ok()).collect::<Vec<_>>();
    if values.len() != 4 || values[2] <= 0.0 || values[3] <= 0.0 {
        return Err("SVG 缺少有效 viewBox".into());
    }
    Ok([values[0], values[1], values[2], values[3]])
}

fn main() -> Result<(), String> {
    let path = env::args().nth(1).ok_or("请传入 SVG 文件路径")?;
    let source = fs::read_to_string(&path).map_err(|error| format!("读取失败：{error}"))?;
    let box_values = view_box(&source)?;
    let document = roxmltree::Document::parse_with_options(
        &source,
        roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() },
    ).map_err(|error| format!("XML 解析失败：{error}"))?;
    let root = document.root_element();
    let width_mm = length_mm(root.attribute("width"), box_values[2]);
    let height_mm = length_mm(root.attribute("height"), box_values[3]);
    let stroke_width = source.find("stroke-width:").and_then(|start| {
        source[start + "stroke-width:".len()..].split(|character: char| !character.is_ascii_digit() && character != '.').next()?.parse::<f64>().ok()
    });

    let mut options = Options::default();
    options.resources_dir = Path::new(&path).parent().map(Path::to_path_buf);
    let tree = Tree::from_str(&source, &options).map_err(|error| format!("SVG 解析失败：{error}"))?;
    let bounds = tree.root().abs_layer_bounding_box();
    let geometry = tree.root().abs_bounding_box();
    let stroke = tree.root().abs_stroke_bounding_box();
    let visible = rendered_bounds(&tree).ok_or("渲染后没有可见像素")?;
    // usvg normalizes the root viewport to CSS pixels. `abs_layer_bounding_box`
    // is therefore reported in the same pixel space as `tree.size()`, rather
    // than in the original viewBox user units.
    let sx = width_mm / tree.size().width() as f64;
    let sy = height_mm / tree.size().height() as f64;
    let measured_width_mm = bounds.width() as f64 * sx;
    let measured_height_mm = bounds.height() as f64 * sy;
    let measured_x_mm = (bounds.x() as f64 - box_values[0]) * sx;
    let measured_y_mm = (bounds.y() as f64 - box_values[1]) * sy;
    let visible_width_mm = visible[2] - visible[0];
    let visible_height_mm = visible[3] - visible[1];

    println!("文件: {path}");
    println!("根 SVG 尺寸: {width_mm:.6} mm × {height_mm:.6} mm");
    if let Some(stroke) = stroke_width {
        let corel_like_width = width_mm - stroke / box_values[2] * width_mm;
        let corel_like_height = height_mm - stroke / box_values[3] * height_mm;
        println!("CorelDRAW 近似几何尺寸(排除首个 stroke-width={stroke}): {corel_like_width:.6} mm × {corel_like_height:.6} mm");
    }
    println!("viewBox: [{:.6}, {:.6}, {:.6}, {:.6}]", box_values[0], box_values[1], box_values[2], box_values[3]);
    println!("usvg viewport(px): {:.6} × {:.6}", tree.size().width(), tree.size().height());
    println!("绝对包围盒(usvg viewport px): x={:.6}, y={:.6}, w={:.6}, h={:.6}", bounds.x(), bounds.y(), bounds.width(), bounds.height());
    println!("几何包围盒(usvg px): x={:.6}, y={:.6}, w={:.6}, h={:.6}", geometry.x(), geometry.y(), geometry.width(), geometry.height());
    println!("含描边包围盒(usvg px): x={:.6}, y={:.6}, w={:.6}, h={:.6}", stroke.x(), stroke.y(), stroke.width(), stroke.height());
    println!("换算结果(mm): x={measured_x_mm:.6}, y={measured_y_mm:.6}, w={measured_width_mm:.6}, h={measured_height_mm:.6}");
    println!("可见像素包围盒(viewport px): x={:.6}, y={:.6}, w={visible_width_mm:.6}, h={visible_height_mm:.6}", visible[0], visible[1]);
    println!("可见像素换算(mm): w={:.6}, h={:.6}", visible_width_mm * sx, visible_height_mm * sy);
    Ok(())
}

fn rendered_bounds(tree: &Tree) -> Option<[f64; 4]> {
    let max_side = 2048.0_f32;
    let scale = (max_side / tree.size().width().max(tree.size().height())).min(1.0);
    let width = (tree.size().width() * scale).ceil().max(1.0) as u32;
    let height = (tree.size().height() * scale).ceil().max(1.0) as u32;
    let mut pixmap = tiny_skia::Pixmap::new(width, height)?;
    resvg::render(tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let mut min_x = width; let mut min_y = height; let mut max_x = 0; let mut max_y = 0; let mut found = false;
    for (index, pixel) in pixmap.data().chunks_exact(4).enumerate() {
        if pixel[3] <= 2 { continue; }
        let x = (index as u32) % width; let y = (index as u32) / width;
        min_x = min_x.min(x); min_y = min_y.min(y); max_x = max_x.max(x); max_y = max_y.max(y); found = true;
    }
    found.then_some([min_x as f64 / scale as f64, min_y as f64 / scale as f64, (max_x + 1) as f64 / scale as f64, (max_y + 1) as f64 / scale as f64])
}
