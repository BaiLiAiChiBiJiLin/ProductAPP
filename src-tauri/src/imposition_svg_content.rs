//! Classify rendered SVG content, after usvg resolves CSS, inheritance and use.
//! Definitions and clipping/masking geometry are not printable artwork.

use usvg::{Group, Node, Paint};

#[derive(Default)]
struct Content {
    strokes: bool,
    other: bool,
}

fn visible_paint(paint: &Paint) -> bool {
    match paint {
        Paint::Color(_) => true,
        Paint::LinearGradient(gradient) => gradient.stops().iter().any(|s| s.opacity().get() > 0.0),
        Paint::RadialGradient(gradient) => gradient.stops().iter().any(|s| s.opacity().get() > 0.0),
        Paint::Pattern(pattern) => {
            let mut content = Content::default();
            visit(pattern.root(), &mut content);
            content.strokes || content.other
        }
    }
}

fn visit(group: &Group, content: &mut Content) {
    if group.opacity().get() == 0.0 || content.other {
        return;
    }
    // Filters can generate filled pixels (flood, image, blur). Keep these with
    // printed artwork rather than claiming that their output is pure strokes.
    if !group.filters().is_empty() {
        content.other = true;
        return;
    }
    for node in group.children() {
        match node {
            Node::Group(group) => visit(group, content),
            Node::Path(path) if path.is_visible() => {
                if path
                    .fill()
                    .is_some_and(|fill| fill.opacity().get() > 0.0 && visible_paint(fill.paint()))
                {
                    content.other = true;
                }
                if path.stroke().is_some_and(|stroke| {
                    stroke.opacity().get() > 0.0 && visible_paint(stroke.paint())
                }) {
                    content.strokes = true;
                }
            }
            Node::Image(image) if image.is_visible() => content.other = true,
            Node::Text(text) => visit(text.flattened(), content),
            _ => {}
        }
        if content.other {
            return;
        }
    }
}

pub fn is_line_only(tree: &usvg::Tree) -> bool {
    let mut content = Content::default();
    visit(tree.root(), &mut content);
    content.strokes && !content.other
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify(body: &str) -> bool {
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">{body}</svg>"#
        );
        is_line_only(&usvg::Tree::from_str(&svg, &usvg::Options::default()).unwrap())
    }

    const OUTLINE: &str = r#"<path d="M1 1H19V19H1Z" fill="none" stroke="black"/>"#;

    #[test]
    fn strokes_are_separate_but_default_white_and_gradient_fills_are_not() {
        assert!(classify(OUTLINE));
        assert!(classify(
            r#"<g fill="none" stroke="red"><rect x="1" y="1" width="18" height="18"/><circle cx="10" cy="10" r="2"/></g>"#
        ));
        for fill in ["", "fill=\"white\"", "fill=\"red\""] {
            assert!(!classify(&format!(
                r#"{OUTLINE}<rect width="5" height="5" {fill}/>"#
            )));
        }
        assert!(!classify(&format!(
            r##"{OUTLINE}<defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="white"/></linearGradient></defs><rect width="5" height="5" fill="url(#g)"/>"##
        )));
    }

    #[test]
    fn resolved_css_use_and_invisible_definitions_do_not_change_stroke_class() {
        assert!(classify(
            r##"<style>.outline { fill:none; stroke:red }</style><defs><path id="cut" class="outline" d="M1 1H19V19H1Z"/><rect width="20" height="20"/><clipPath id="clip"><rect width="20" height="20"/></clipPath></defs><g clip-path="url(#clip)"><use href="#cut"/></g>"##
        ));
        assert!(classify(&format!(
            r#"{OUTLINE}<rect width="5" height="5" fill-opacity="0"/><g opacity="0"><rect width="5" height="5"/></g><rect width="5" height="5" style="display:none"/><rect width="5" height="5" visibility="hidden"/>"#
        )));
        assert!(!classify(
            r#"<path d="M1 1H19V19H1Z" fill="none" stroke="black" stroke-opacity="0"/>"#
        ));
        assert!(!classify(
            "<defs><path d=\"M1 1H19V19H1Z\" fill=\"none\" stroke=\"black\"/></defs>"
        ));
    }

    #[test]
    fn embedded_images_and_pattern_fills_are_printed_artwork() {
        let image = r#"<image width="5" height="5" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rCkAAAAASUVORK5CYII="/>"#;
        assert!(!classify(&format!("{OUTLINE}{image}")));
        assert!(classify(&format!(r#"{OUTLINE}<g opacity="0">{image}</g>"#)));
        assert!(!classify(&format!(
            r##"{OUTLINE}<defs><pattern id="p" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="blue"/></pattern></defs><rect width="5" height="5" fill="url(#p)"/>"##
        )));
    }
}
