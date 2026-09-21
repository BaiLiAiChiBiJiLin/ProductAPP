use std::{fs,path::Path};
fn png(s:&str,p:&Path){let t=usvg::Tree::from_str(s,&app_lib::assets::options()).unwrap();let scale=1000.0/t.size().width().max(t.size().height());let mut px=tiny_skia::Pixmap::new((t.size().width()*scale).ceil() as u32,(t.size().height()*scale).ceil() as u32).unwrap();resvg::render(&t,tiny_skia::Transform::from_scale(scale,scale),&mut px.as_mut());px.save_png(p).unwrap();}
fn main(){let p=std::env::args().nth(1).unwrap();let output=std::env::args().nth(2).unwrap_or_else(|| "artifacts/naomi-diagnosis".into());let out=Path::new(&output);fs::create_dir_all(out).unwrap();let s=fs::read_to_string(&p).unwrap();png(&s,&out.join("original.png"));let a=app_lib::assets::import(Path::new(&p),"a","auto","diag",|_,_|{}).unwrap();for (i,a) in a.iter().enumerate(){println!("{i} {} {}x{} {:?}",a.name,a.width,a.height,a.source_group_bounds);fs::write(out.join(format!("{i}.svg")),&a.svg).unwrap();png(&a.svg,&out.join(format!("{i}.png")));}}

#[cfg(test)]
mod tests {
    #[test]
    fn image_with_hanging_hole_must_not_be_cropped_to_hole() {
        use std::{fs,path::Path};
        let image=base64::Engine::encode(&base64::engine::general_purpose::STANDARD,br##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="pink"/></svg>"##);
        let s=format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 1000 1000"><g id="图层"><g id="pink"><circle cx="200" cy="90" r="10" fill="none" stroke="black"/><image x="100" y="110" width="200" height="200" href="data:image/svg+xml;base64,{image}"/></g></g></svg>"##);
        let dir=Path::new("artifacts/naomi-diagnosis");fs::create_dir_all(dir).unwrap();let p=dir.join("minimal-hole.svg");fs::write(&p,s).unwrap();
        let assets=app_lib::assets::import(&p,"a","groups","hole-regression",|_,_|{}).unwrap();
        let b=assets[0].source_group_bounds;
        assert!(b[2]>=199.0 && b[3]>=229.0,"full image crop required; actual bounds={b:?}");
    }
}

