//! Small image metadata collected from the already-parsed import tree.
//! Never decode, re-encode or clone the embedded raster bytes here.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceImage {
    pub node_id: String,
    pub width_px: u32,
    pub height_px: u32,
    /// Unclipped image edge lengths in the original SVG, including all transforms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_mm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_mm: Option<f64>,
    pub format: String,
}

pub fn collect(tree: &usvg::Tree, source: &roxmltree::Document<'_>) -> Vec<SourceImage> {
    // usvg moves an <image>'s ID to a generated parent group. Only use IDs
    // that actually belong to source image nodes, never a product group's ID.
    let image_ids: HashSet<_> = source.descendants().filter(|node| node.has_tag_name("image"))
        .filter_map(|node| node.attribute("id")).collect();
    fn visit(group: &usvg::Group, image_ids: &HashSet<&str>, parent_image_id: &str, images: &mut Vec<SourceImage>) {
        let image_id = if image_ids.contains(group.id()) { group.id() } else { parent_image_id };
        for node in group.children() {
            match node {
                usvg::Node::Group(group) => visit(group, image_ids, image_id, images),
                usvg::Node::Image(image) => {
                    let format = match image.kind() {
                        usvg::ImageKind::PNG(_) => Some("PNG"),
                        usvg::ImageKind::JPEG(_) => Some("JPEG"),
                        usvg::ImageKind::GIF(_) => Some("GIF"),
                        usvg::ImageKind::WEBP(_) => Some("WebP"),
                        // An embedded SVG has a viewport, not raster pixels.
                        usvg::ImageKind::SVG(_) => None,
                    };
                    if let Some(format) = format {
                        // usvg maps intrinsic pixels through preserveAspectRatio,
                        // the image/ancestor transforms and root viewBox to CSS px.
                        // Measure transformed edge vectors (not a rotated AABB)
                        // before converting to mm. Raster pixels alone have no
                        // physical size; treating them as 96-DPI pixels is wrong.
                        let transform = image.abs_transform();
                        let width_mm = image.size().width() as f64
                            * (transform.sx as f64).hypot(transform.ky as f64) * 25.4 / 96.0;
                        let height_mm = image.size().height() as f64
                            * (transform.kx as f64).hypot(transform.sy as f64) * 25.4 / 96.0;
                        images.push(SourceImage {
                            node_id: if image.id().is_empty() { image_id } else { image.id() }.to_owned(),
                            width_px: image.size().width() as u32,
                            height_px: image.size().height() as u32,
                            width_mm: (width_mm.is_finite() && width_mm > 0.0).then_some(width_mm),
                            height_mm: (height_mm.is_finite() && height_mm > 0.0).then_some(height_mm),
                            format: format.into(),
                        });
                    }
                }
                _ => (),
            }
            node.subroots(|root| visit(root, image_ids, image_id, images));
        }
    }
    let mut images = Vec::new();
    visit(tree.root(), &image_ids, "", &mut images);
    images
}
