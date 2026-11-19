//! Turn snapshot artwork into immutable resource links before domain validation.
//! Existing shared originals must never be hydrated as a batch of SVG strings.
use super::{resources::{FILE,TEXT}, store::Result};
use serde_json::Value;

pub(super) enum Artwork<'a> { Reference(&'a str), Snapshot(&'a str), Svg(&'a str), File { path: &'a str, asset: &'a Value } }
pub(super) fn prepare(value: &mut Value, mut resolve: impl FnMut(Artwork<'_>)->Result<String>) -> Result<()> {
    fn snapshots(value: &mut Value, resolve: &mut impl FnMut(Artwork<'_>)->Result<String>) -> Result<()> {
        match value {
            Value::String(text) if text.starts_with(crate::artwork_source::SNAPSHOT_PREFIX) => {
                *text = format!("{TEXT}{}",resolve(Artwork::Snapshot(text))?);
            }
            Value::Array(values) => for value in values { snapshots(value,resolve)?; },
            Value::Object(values) => for value in values.values_mut() { snapshots(value,resolve)?; },
            _=>{}
        }
        Ok(())
    }
    snapshots(value,&mut resolve)?;
    let assets = value["assets"].as_array_mut().filter(|assets|!assets.is_empty()).ok_or("示意图记录缺少图片")?;
    for asset in assets {
        let svg = asset["svg"].as_str().unwrap_or("");
        let hash = if !svg.is_empty() {
            resolve(if svg.starts_with(FILE) || svg.starts_with(TEXT) { Artwork::Reference(svg) } else { Artwork::Svg(svg) })?
        } else {
            let path = asset["storagePath"].as_str().filter(|path|!path.is_empty()).ok_or("示意图记录缺少图片内容")?;
            resolve(if path.starts_with(FILE) || path.starts_with(TEXT) { Artwork::Reference(path) } else { Artwork::File { path, asset } })?
        };
        let object = asset.as_object_mut().ok_or("示意图图片数据无效")?;
        object.insert("svg".into(),Value::String(format!("{TEXT}{hash}")));
        object.insert("storagePath".into(),Value::String(format!("{FILE}{hash}")));
        object.insert("previewUrl".into(),Value::String(String::new()));
        object.insert("thumbnailUrl".into(),Value::String(String::new()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn sixty_one_shared_originals_are_linked_without_reading_or_copying_svg_contents() {
        let assets: Vec<_> = (0..61).map(|index|json!({"id":index.to_string(),"svg":"","storagePath":format!("{FILE}{index:064x}"),"attributes":{"QT":"10"}})).collect();
        let mut value = json!({"assets":assets,"pages":[{"id":1,"items":[{"x":123,"w":70,"svgLayerIds":["back"],"backSvg":crate::artwork_source::SNAPSHOT_PREFIX.to_owned()+"snapshot"}]}],"display":{"zoom":1.5}});
        let mut refs = 0;
        prepare(&mut value,|input|match input {
            Artwork::Reference(reference)=>{refs+=1;Ok(reference.strip_prefix(FILE).or_else(||reference.strip_prefix(TEXT)).unwrap().into())},
            Artwork::Snapshot(_)=>Ok("b".repeat(64)),
            Artwork::Svg(_)|Artwork::File {..}=>panic!("existing shared SVGs must not be read or copied"),
        }).unwrap();
        assert_eq!(refs,61);
        assert!(value.to_string().len()<32*1024);
        assert_eq!(value["assets"][0]["svg"],format!("{TEXT}{:064x}",0));
        assert_eq!(value["pages"][0]["items"][0]["backSvg"],format!("{TEXT}{}","b".repeat(64)));
        assert_eq!(value["pages"][0]["items"][0]["x"],123);
        assert_eq!(value["display"]["zoom"],1.5);
    }

    #[test]
    fn new_and_legacy_assets_keep_their_actual_source_and_edited_metadata() {
        let mut value = json!({"assets":[
            {"id":"raw","svg":"<svg/>","storagePath":"old.svg","attributes":{"QT":"12"}},
            {"id":"staged","svg":"printflow-export:abcd"},
            {"id":"legacy","svg":"","storagePath":"legacy.svg"}
        ]});
        let mut sources = Vec::new();
        prepare(&mut value,|artwork| {
            sources.push(match artwork {
                Artwork::Svg(source)=>format!("svg:{source}"),
                Artwork::File { path, .. }=>format!("file:{path}"),
                _=>panic!("unexpected resource reuse for a new source"),
            });
            Ok(format!("{:064x}",sources.len()))
        }).unwrap();
        assert_eq!(sources,vec!["svg:<svg/>","svg:printflow-export:abcd","file:legacy.svg"]);
        assert_eq!(value["assets"][0]["attributes"]["QT"],"12");
        assert_eq!(value["assets"][2]["storagePath"],format!("{FILE}{:064x}",3));

        let mut missing = json!({"assets":[{"id":"missing","svg":""}]});
        assert!(prepare(&mut missing,|_|panic!("must reject missing sources")).unwrap_err().contains("缺少图片内容"));
        let mut unreadable = json!({"assets":[{"id":"legacy","storagePath":"missing.svg"}]});
        assert_eq!(prepare(&mut unreadable,|_|Err("源文件不存在".into())).unwrap_err(),"源文件不存在");
    }
}
