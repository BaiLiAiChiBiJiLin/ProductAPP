//! Lazy font resolution for imported artwork, separate from generated page fonts.
//!
//! usvg invokes these callbacks only for text it actually lays out, after CSS,
//! inherited styles and <use> references have been resolved. Creating import
//! options, parsing paths/images, and unused/hidden text perform no font I/O.
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
use usvg::{
    fontdb::{Database, FaceInfo, Source, ID},
    FontFamily, FontResolver,
};

#[cfg(target_os = "windows")]
#[path = "windows_artwork.rs"]
mod platform;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct FontRequest {
    family: String,
    weight: u16,
    style: usvg::FontStyle,
    stretch: usvg::FontStretch,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct FontFile {
    path: PathBuf,
    index: u32,
}

fn family_name(family: &FontFamily) -> &str {
    match family {
        FontFamily::Named(name) => name,
        FontFamily::Serif => "Times New Roman",
        FontFamily::SansSerif => "Arial",
        FontFamily::Monospace => "Courier New",
        FontFamily::Cursive => "Comic Sans MS",
        FontFamily::Fantasy => "Impact",
    }
}

fn source_path(source: &Source) -> Option<&std::path::Path> {
    match source {
        Source::File(path) | Source::SharedFile(path, _) => Some(path),
        _ => None,
    }
}

fn load_face(file: FontFile, db: &mut Arc<Database>) -> Option<ID> {
    if let Some(face) = db.faces().find(|face| {
        face.index == file.index && source_path(&face.source) == Some(file.path.as_path())
    }) {
        return Some(face.id);
    }
    // Only metadata and file paths are cached, never every installed font's
    // bytes. A bounded cache is shared across split assets and later imports.
    static CACHE: OnceLock<Mutex<HashMap<FontFile, Option<FaceInfo>>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().ok()?;
    let info = if let Some(info) = cache.get(&file) {
        info.clone()
    } else {
        let mut single_file = Database::new();
        let info = match single_file.load_font_file(&file.path) {
            Ok(()) => single_file
                .faces()
                .find(|face| face.index == file.index)
                .cloned(),
            Err(error) => {
                log::warn!(target: "printflow::fonts", "SVG 字体读取失败：{} ({error})", file.path.display());
                None
            }
        };
        if info.is_some() {
            log::info!(target: "printflow::fonts", "SVG 按需加载字体：{}，face={}", file.path.display(), file.index);
        }
        if cache.len() >= 128 {
            cache.clear();
        }
        cache.insert(file, info.clone());
        info
    }?;
    drop(cache);
    let db = Arc::make_mut(db);
    db.push_face_info(info);
    db.faces().last().map(|face| face.id)
}

fn select(request: &FontRequest, character: Option<char>, db: &mut Arc<Database>) -> Option<ID> {
    let file = platform::find_font(request, character)?;
    load_face(file, db)
}

pub(crate) fn resolver() -> FontResolver<'static> {
    FontResolver {
        select_font: Box::new(|font, db| {
            let mut request = FontRequest {
                family: String::new(),
                weight: font.weight(),
                style: font.style(),
                stretch: font.stretch(),
            };
            // Respect the declared fallback list and do not load later
            // families when the first available family already matches.
            for family in font.families() {
                request.family = family_name(family).to_owned();
                if let Some(id) = select(&request, None, db) {
                    return Some(id);
                }
            }
            log::warn!(target: "printflow::fonts", "SVG 指定字体不可用，尝试替代字体：{:?}", font.families());
            for family in ["Times New Roman", "Arial", "Segoe UI"] {
                request.family = family.into();
                if let Some(id) = select(&request, None, db) {
                    return Some(id);
                }
            }
            None
        }),
        select_fallback: Box::new(|character, used, db| {
            let base = db.face(*used.first()?)?;
            let mut request = FontRequest {
                family: String::new(),
                weight: base.weight.0,
                style: base.style.into(),
                stretch: base.stretch.into(),
            };
            let existing = FontResolver::default_fallback_selector();
            if let Some(id) = existing(character, used, db) {
                return Some(id);
            }
            // DirectWrite checks glyph support before fontdb opens a file.
            // Only the first usable substitute is loaded, with matching style.
            let families: &[&str] = if matches!(character as u32, 0x2e80..=0x9fff | 0xac00..=0xd7ff | 0xf900..=0xfaff | 0xff00..=0xffef | 0x20000..=0x323af)
            {
                &[
                    "Microsoft YaHei",
                    "SimSun",
                    "Yu Gothic",
                    "Malgun Gothic",
                    "Segoe UI Symbol",
                ]
            } else {
                &[
                    "Segoe UI",
                    "Arial",
                    "Segoe UI Symbol",
                    "Segoe UI Emoji",
                    "Microsoft YaHei",
                ]
            };
            for family in families {
                request.family = (*family).into();
                if let Some(id) = select(&request, Some(character), db) {
                    if !used.contains(&id) {
                        return Some(id);
                    }
                }
            }
            None
        }),
    }
}

// This desktop app targets Windows. Other platforms must supply their own
// indexed lookup; never silently fall back to scanning the entire machine.
#[cfg(not(target_os = "windows"))]
mod platform {
    use super::{FontFile, FontRequest};
    pub(super) fn find_font(_request: &FontRequest, _character: Option<char>) -> Option<FontFile> {
        None
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    fn parse(source: &str) -> usvg::Tree {
        usvg::Tree::from_str(source, &crate::assets::options()).unwrap()
    }

    fn pixels(tree: &usvg::Tree) -> Vec<u8> {
        let mut pixmap = tiny_skia::Pixmap::new(320, 120).unwrap();
        resvg::render(tree, tiny_skia::Transform::identity(), &mut pixmap.as_mut());
        assert!(
            pixmap.pixels().iter().any(|pixel| pixel.alpha() > 0),
            "text must remain visible"
        );
        pixmap.data().to_vec()
    }

    #[test]
    fn artwork_css_inheritance_tspan_and_use_keep_exact_text_pixels() {
        let source = r##"<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120">
          <style>.label { font-family: Arial; font-size: 24px; font-weight: bold; font-style: italic; }</style>
          <defs><g id="caption" class="label"><text x="10" y="35">Hello <tspan font-weight="normal" font-style="normal">SVG</tspan></text></g></defs>
          <use href="#caption"/><use href="#caption" y="40"/>
        </svg>"##;
        let tree = parse(source);
        assert!(
            tree.fontdb().len() <= 3,
            "only used Arial styles may be loaded"
        );
        assert!(tree
            .fontdb()
            .faces()
            .all(|face| face.families.iter().any(|(name, _)| name == "Arial")));
        assert!(tree
            .fontdb()
            .faces()
            .any(|face| face.weight.0 == 700 && face.style == usvg::fontdb::Style::Italic));
        let mut baseline = usvg::Options::default();
        let directory = PathBuf::from(std::env::var_os("SYSTEMROOT").unwrap()).join("Fonts");
        for file in ["arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"] {
            baseline
                .fontdb_mut()
                .load_font_file(directory.join(file))
                .unwrap();
        }
        let reference = usvg::Tree::from_str(source, &baseline).unwrap();
        let actual = pixels(&tree);
        let expected = pixels(&reference);
        let different = actual.iter().zip(&expected).filter(|(a, b)| a != b).count();
        assert_eq!(different, 0, "lazy resolution must not change text geometry or pixels; actual fonts: {:?}; reference fonts: {:?}", tree.fontdb().faces().collect::<Vec<_>>(), reference.fontdb().faces().collect::<Vec<_>>());
    }

    #[test]
    fn artwork_specific_font_does_not_load_declared_unused_fallbacks() {
        let tree = parse(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><text x="10" y="35" font-family="Segoe UI, Arial, SimSun" font-size="24">Design</text></svg>"#,
        );
        assert_eq!(tree.fontdb().len(), 1);
        assert!(tree
            .fontdb()
            .faces()
            .next()
            .unwrap()
            .families
            .iter()
            .any(|(name, _)| name == "Segoe UI"));
        pixels(&tree);
    }

    #[test]
    fn artwork_missing_font_and_cjk_fallback_are_bounded() {
        let tree = parse(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><text x="10" y="35" font-family="PrintFlow-Missing-Font" font-size="24">Hello 客户订单</text></svg>"#,
        );
        assert!(tree.fontdb().len() >= 2 && tree.fontdb().len() <= 3);
        assert!(tree.fontdb().faces().any(|face| face
            .families
            .iter()
            .any(|(name, _)| name == "Microsoft YaHei" || name == "SimSun")));
        pixels(&tree);
        // An earlier text import must not attach its cache to path-only work.
        let paths = parse(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><path d="M0 0h10v10H0z"/></svg>"#,
        );
        assert_eq!(paths.fontdb().len(), 0);
    }

    #[test]
    fn artwork_embedded_svg_loads_fonts_only_for_its_own_text() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let embedded = r#"<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><text x="10" y="35" font-family="Arial" font-size="24">Nested SVG</text></svg>"#;
        let source = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><image width="320" height="120" href="data:image/svg+xml;base64,{}"/></svg>"#,
            STANDARD.encode(embedded)
        );
        let tree = parse(&source);
        assert_eq!(
            tree.fontdb().len(),
            0,
            "the outer image-only document needs no fonts"
        );
        fn embedded_svg(group: &usvg::Group) -> Option<&usvg::Tree> {
            group.children().iter().find_map(|node| match node {
                usvg::Node::Group(group) => embedded_svg(group),
                usvg::Node::Image(image) => match image.kind() {
                    usvg::ImageKind::SVG(tree) => Some(tree),
                    _ => None,
                },
                _ => None,
            })
        }
        let nested = embedded_svg(tree.root()).expect("expected an embedded SVG image");
        assert_eq!(nested.fontdb().len(), 1);
        assert_eq!(
            nested.fontdb().faces().next().unwrap().post_script_name,
            "ArialMT"
        );
        assert!(
            pixels(&tree) == pixels(&parse(embedded)),
            "nested text must render identically"
        );
    }
}
