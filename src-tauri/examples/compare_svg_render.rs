// Diagnostic only: compare two SVGs with embedded resources using resvg.
use std::{fs, path::Path};
#[path = "support/svg_browser.rs"]
mod svg_browser;

fn render(path: &str) -> tiny_skia::Pixmap {
    let source = fs::read_to_string(path).unwrap();
    let tree = usvg::Tree::from_str(&source, &usvg::Options::default()).unwrap();
    let scale = 1000.0 / tree.size().width().max(tree.size().height());
    let mut pixels = tiny_skia::Pixmap::new(
        (tree.size().width() * scale).ceil() as u32,
        (tree.size().height() * scale).ceil() as u32,
    ).unwrap();
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixels.as_mut());
    pixels.save_png(Path::new(path).with_extension("png")).unwrap();
    pixels
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args[1] == "--normalize" {
        let source = fs::read_to_string(&args[2]).unwrap();
        let converted = svg_browser::localize_images(&source).unwrap();
        fs::write(&args[3], converted).unwrap();
        println!("Wrote standalone coordinate test copy: {}", args[3]);
        return;
    }
    let original = render(&args[1]);
    let converted = render(&args[2]);
    assert_eq!((original.width(), original.height()), (converted.width(), converted.height()));
    let max_difference = original.data().iter().zip(converted.data())
        .map(|(a,b)| a.abs_diff(*b)).max().unwrap();
    println!("{}x{}; maximum channel difference: {}", original.width(), original.height(), max_difference);
    assert!(max_difference <= 1, "coordinate conversion changed rendering");
}

