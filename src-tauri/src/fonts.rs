//! Separate font policies for generated pages and original SVG artwork.
pub(crate) mod artwork;
use std::sync::{Arc, OnceLock};
use usvg::fontdb::Database;

pub fn page_fonts() -> Result<Arc<Database>, String> {
    static FONTS: OnceLock<Result<Arc<Database>, String>> = OnceLock::new();
    FONTS.get_or_init(|| {
        let started = std::time::Instant::now();
        #[cfg(target_os = "windows")]
        let fonts = {
            let root = std::env::var_os("SYSTEMROOT").ok_or("无法确定 Windows 字体目录")?;
            load_windows_page_fonts(&std::path::PathBuf::from(root).join("Fonts"))?
        };
        // Keep existing platform font discovery outside the Windows application.
        #[cfg(not(target_os = "windows"))]
        let fonts = {
            let mut fonts = Database::new();
            fonts.load_system_fonts();
            fonts
        };
        log::info!(target: "printflow::fonts", "页面字体初始化完成：faces={}, elapsed_ms={}", fonts.len(), started.elapsed().as_millis());
        Ok(Arc::new(fonts))
    }).clone()
}

#[cfg(target_os = "windows")]
fn has_family(fonts: &Database, family: &str) -> bool {
    fonts.query(&usvg::fontdb::Query {
        families: &[usvg::fontdb::Family::Name(family)],
        ..Default::default()
    }).is_some()
}

#[cfg(target_os = "windows")]
fn load_files(fonts: &mut Database, directory: &std::path::Path, names: &[&str]) {
    for name in names {
        // Exact file lookups only: never enumerate the font directory.
        let path = directory.join(name);
        if path.is_file() {
            if let Err(error) = fonts.load_font_file(&path) {
                log::warn!(target: "printflow::fonts", "页面字体读取失败：{name} ({error})");
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn load_windows_page_fonts(directory: &std::path::Path) -> Result<Database, String> {
    let mut fonts = Database::new();
    // Cover regular, bold and italic English text, plus regular/bold Chinese.
    load_files(&mut fonts, directory, &["arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf", "msyh.ttc", "msyhbd.ttc"]);
    let english = if has_family(&fonts, "Arial") {
        "Arial"
    } else {
        load_files(&mut fonts, directory, &["segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf", "segoeuiz.ttf"]);
        if !has_family(&fonts, "Segoe UI") {
            return Err("导出缺少英文字体：请安装 Arial 或 Segoe UI".into());
        }
        "Segoe UI"
    };
    if !has_family(&fonts, "Microsoft YaHei") {
        load_files(&mut fonts, directory, &["simsun.ttc"]);
        if !has_family(&fonts, "SimSun") {
            return Err("导出缺少中文字体：请安装微软雅黑或宋体".into());
        }
    }
    // usvg also queries the generic families when an explicit family is absent.
    fonts.set_sans_serif_family(english);
    fonts.set_serif_family(english);
    fonts.set_cursive_family(english);
    fonts.set_fantasy_family(english);
    fonts.set_monospace_family(english);
    Ok(fonts)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use usvg::fontdb::{Family, Query, Style, Weight};

    #[test]
    fn page_fonts_cover_english_styles_and_chinese() {
        let mut fonts = page_fonts().unwrap();
        for (weight, style) in [(Weight::NORMAL, Style::Normal), (Weight::BOLD, Style::Normal), (Weight::NORMAL, Style::Italic), (Weight::BOLD, Style::Italic)] {
            let id = fonts.query(&Query { families: &[Family::Name("Arial")], weight, style, ..Default::default() }).unwrap();
            let face = fonts.face(id).unwrap();
            assert_eq!(face.weight, weight);
            assert_eq!(face.style, style);
        }
        let arial = fonts.query(&Query { families: &[Family::Name("Arial")], ..Default::default() }).unwrap();
        let fallback = usvg::FontResolver::default_fallback_selector();
        for character in "里斯张三客户订单页数".chars() {
            let id = fallback(character, &[arial], &mut fonts).expect("Chinese character must have a font");
            assert!(fonts.face(id).unwrap().families.iter().any(|(family, _)| family == "Microsoft YaHei"));
        }
    }

    #[test]
    fn missing_page_fonts_report_error_without_scanning_other_directories() {
        let missing = std::env::temp_dir().join(format!("printflow-missing-fonts-{}", std::process::id()));
        assert!(!missing.exists());
        assert!(load_windows_page_fonts(&missing).unwrap_err().contains("英文字体"));
    }
}
