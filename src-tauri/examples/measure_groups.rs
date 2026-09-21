//! Measure authored outline geometry in the original document BEFORE splitting.
//! This is an outline measurement, not a general clipped/alpha content bbox.
use std::{env, fs, path::PathBuf};
use usvg::{Node, Tree, Options};
type Bounds = [f64; 4];
fn union(a: Bounds, b: Bounds) -> Bounds {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}
fn outline(node: &Node) -> Option<Bounds> {
    match node {
        Node::Group(g) => {
            // Clipped artwork is NOT an authored outer outline. Do not pretend
            // intersecting bounding rectangles computes a path intersection.
            if g.clip_path().is_some() || g.mask().is_some() || !g.filters().is_empty() { return None; }
            g.children().iter().filter_map(outline).reduce(union)
        }
        Node::Path(p) if p.fill().is_none() && p.stroke().is_some() && p.is_visible() => {
            // Transform the curve itself before finding extrema; transforming
            // its old rectangle would overestimate rotated/skewed curves.
            let path = p.data().clone().transform(p.abs_transform())?;
            let b = path.compute_tight_bounds()?;
            Some([b.left() as f64, b.top() as f64, b.right() as f64, b.bottom() as f64])
        }
        _ => None,
    }
}
fn opening(s: &str) -> Result<&str, String> {
    let mut quote = None;
    for (i,c) in s.char_indices() {
        match (quote,c) {
            (None, '\'' | '"') => quote=Some(c), (Some(q), c) if q==c => quote=None,
            (None,'>') => return Ok(&s[..=i]), _=>()
        }
    }
    Err("Incomplete XML tag".into())
}
fn main() -> Result<(), String> {
    let path=env::args().nth(1).ok_or("Supply SVG path")?;
    let output=PathBuf::from(env::args().nth(2).unwrap_or_else(|| "measurement-output".into()));
    let source=fs::read_to_string(&path).map_err(|e|e.to_string())?;
    let doc=roxmltree::Document::parse_with_options(&source,roxmltree::ParsingOptions{allow_dtd:true,..Default::default()}).map_err(|e|e.to_string())?;
    let root=doc.root_element();
    let layer=root.descendants().find(|n|n.has_tag_name("g") && n.attribute("id").unwrap_or("").contains("图层")).ok_or("Layer not found")?;
    let groups:Vec<_>=layer.children().filter(|n|n.has_tag_name("g")).collect();
    // Preserve real IDs; add temporary IDs ONLY in memory for anonymous groups.
    let mut annotated=source.clone();
    let ids:Vec<String>=groups.iter().enumerate().map(|(i,g)|g.attribute("id").map(str::to_owned).unwrap_or_else(||format!("__measure_anonymous_{}",i+1))).collect();
    for (i,g) in groups.iter().enumerate().rev() {
        if g.attribute("id").is_none() {
            if doc.descendants().any(|n|n.attribute("id")==Some(ids[i].as_str())) {return Err("Temporary ID collision".into())}
            annotated.insert_str(g.range().start+2,&format!(" id=\"{}\"",ids[i]));
        }
    }
    let options=Options{dpi:96.0,..Options::default()};
    let tree=Tree::from_str(&annotated,&options).map_err(|e|e.to_string())?;
    // usvg absolute path transforms already include the root viewBox mapping.
    // CSS px -> mm happens ONCE. No division by the original viewBox again.
    let measurements:Vec<_>=ids.iter().map(|id|tree.node_by_id(id).and_then(outline)).collect();
    fs::create_dir_all(&output).map_err(|e|e.to_string())?;
    let mut records=Vec::new();
    let mut csv=String::from("index,g_id,source_locator,width_mm,height_mm,method\n");
    let shared:String=root.descendants().filter(|n|n.has_tag_name("defs") && !n.ancestors().skip(1).any(|p|p.has_tag_name("defs"))).map(|n|&source[n.range()]).collect();
    let mut wrappers:Vec<_>=layer.ancestors().filter(|n|n.has_tag_name("g")).collect(); wrappers.reverse();
    for (i,g) in groups.iter().enumerate() {
        let id=g.attribute("id");
        let locator=format!("/svg/g[@id='{}']/g[{}]",layer.attribute("id").unwrap_or(""),i+1);
        let label=id.map(str::to_owned).unwrap_or_else(||format!("无 id；{locator}"));
        let mm=measurements[i].map(|b|[(b[2]-b[0])*25.4/96.0,(b[3]-b[1])*25.4/96.0]);
        if let Some([w,h])=mm {
            println!("{} | {} | {:.6} mm x {:.6} mm",i+1,label,w,h);
            csv.push_str(&format!("{},{},{},{:.6},{:.6},outline_geometry_excluding_stroke\n",i+1,id.unwrap_or(""),locator,w,h));
        } else {
            println!("{} | {} | 无可测外轮廓，不能提供几何尺寸",i+1,label);
            csv.push_str(&format!("{},{},{},,,no_outline\n",i+1,id.unwrap_or(""),locator));
        }
        // Split only AFTER all measurements have been recorded. Original g IDs
        // and source content remain unchanged, with parent transforms retained.
        let mut split=String::from(opening(&source[root.range()])?);
        split.push_str(&shared);
        for w in &wrappers {split.push_str(opening(&source[w.range()])?)}
        split.push_str(&source[g.range()]);
        for _ in &wrappers {split.push_str("</g>")}
        split.push_str("</svg>");
        // Independently reparse each split to detect missing inherited context.
        // Report the ORIGINAL measurement; the reparse is validation only.
        let mut check_source = split.clone();
        if id.is_none() {
            let raw = &source[g.range()];
            let at = check_source.find(raw).ok_or("Split body missing")?;
            check_source.insert_str(at + 2, &format!(" id=\"{}\"", ids[i]));
        }
        let check_tree = Tree::from_str(&check_source, &options).map_err(|e|e.to_string())?;
        let check_bounds = check_tree.node_by_id(&ids[i]).and_then(outline);
        match (measurements[i], check_bounds) {
            (Some(a), Some(b)) if a.iter().zip(b).all(|(x,y)| (x-y).abs()*25.4/96.0 < 0.0001) => (),
            (None, None) => (),
            _ => return Err(format!("Split changed measurement: {locator}")),
        }
        let file=format!("group-{:03}.svg",i+1);
        fs::write(output.join(&file),split).map_err(|e|e.to_string())?;
        records.push(serde_json::json!({"index":i+1,"g_id":id,"source_locator":locator,"source_line":doc.text_pos_at(g.range().start).row,"file":file,"width_mm":mm.map(|v|v[0]),"height_mm":mm.map(|v|v[1]),"method":"outline_geometry_excluding_stroke","bounds_viewport_px":measurements[i]}));
    }
    fs::write(output.join("measurements.csv"),csv).map_err(|e|e.to_string())?;
    fs::write(output.join("measurements.json"),serde_json::to_string_pretty(&records).unwrap()).map_err(|e|e.to_string())?;
    println!("Output: {} ({} groups; split invariance verified)",output.display(),groups.len());
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translated_outline_excludes_stroke() {
        for x in [0, 1000] {
            let s=format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm" viewBox="0 0 2000 2000"><g id="a" transform="translate({x} 500)"><rect width="100" height="200" fill="none" stroke="red" stroke-width="5"/></g></svg>"#);
            let t=Tree::from_str(&s,&Options::default()).unwrap();
            let b=outline(t.node_by_id("a").unwrap()).unwrap();
            assert!(((b[2]-b[0])*25.4/96.0-10.0).abs()<0.0001);
            assert!(((b[3]-b[1])*25.4/96.0-20.0).abs()<0.0001);
        }
    }
    #[test]
    fn clipped_artwork_does_not_inflate_outline() {
        let s = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm" viewBox="0 0 2000 2000"><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><g id="a"><rect width="100" height="200" fill="none" stroke="red" stroke-width="5"/><g clip-path="url(#clip)"><rect x="-9000" y="-9000" width="20000" height="20000" fill="none" stroke="blue"/></g></g></svg>"##;
        let t = Tree::from_str(s, &Options::default()).unwrap();
        let b = outline(t.node_by_id("a").unwrap()).unwrap();
        assert!(((b[2]-b[0])*25.4/96.0-10.0).abs()<0.0001);
        assert!(((b[3]-b[1])*25.4/96.0-20.0).abs()<0.0001);
    }
}
