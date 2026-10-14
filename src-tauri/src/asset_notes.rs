use serde::{Deserialize, Deserializer, Serialize};

pub const MAX_NOTE_IMAGES: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteImage {
    pub src: String,
    #[serde(default)]
    pub name: String,
}

fn validate(images: Option<Vec<NoteImage>>) -> Result<Option<Vec<NoteImage>>, String> {
    if images
        .as_ref()
        .is_some_and(|items| items.len() > MAX_NOTE_IMAGES)
    {
        return Err("备注图片最多上传 3 张".into());
    }
    Ok(images)
}

pub fn deserialize_note_images<'de, D>(deserializer: D) -> Result<Option<Vec<NoteImage>>, D::Error>
where
    D: Deserializer<'de>,
{
    validate(Option::<Vec<NoteImage>>::deserialize(deserializer)?).map_err(serde::de::Error::custom)
}

pub fn read_note_images(value: &serde_json::Value) -> Result<Option<Vec<NoteImage>>, String> {
    validate(serde_json::from_value(value.clone()).map_err(|error| error.to_string())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Notes {
        #[serde(default)]
        note_image: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_note_images"
        )]
        note_images: Option<Vec<NoteImage>>,
    }

    #[test]
    fn legacy_missing_list_stays_missing_and_keeps_old_image() {
        let notes: Notes = serde_json::from_value(json!({"noteImage":"legacy.png"})).unwrap();
        assert_eq!(notes.note_images, None);
        let stored = serde_json::to_value(notes).unwrap();
        assert_eq!(stored["noteImage"], "legacy.png");
        assert!(stored.get("noteImages").is_none());
    }

    #[test]
    fn three_named_or_unnamed_images_survive_json_roundtrip() {
        let value = json!({"noteImage":"one.png", "noteImages":[
            {"src":"one.png","name":"正面参考"},
            {"src":"two.png","name":""},
            {"src":"three.png","name":"背面"}
        ]});
        let notes: Notes = serde_json::from_value(value.clone()).unwrap();
        let stored = serde_json::to_string(&notes).unwrap();
        let restored: Notes = serde_json::from_str(&stored).unwrap();
        assert_eq!(restored.note_images, notes.note_images);
        assert_eq!(serde_json::to_value(restored).unwrap(), value);
    }

    #[test]
    fn explicit_empty_list_survives_and_does_not_become_legacy_missing() {
        let notes: Notes =
            serde_json::from_value(json!({"noteImage":"", "noteImages":[]})).unwrap();
        assert_eq!(notes.note_images, Some(Vec::new()));
        assert_eq!(
            serde_json::to_value(notes).unwrap()["noteImages"],
            json!([])
        );
        assert_eq!(read_note_images(&json!([])).unwrap(), Some(Vec::new()));
    }

    #[test]
    fn fourth_image_is_rejected_at_both_asset_and_review_boundaries() {
        let images = json!([{"src":"1"},{"src":"2"},{"src":"3"},{"src":"4"}]);
        let error = serde_json::from_value::<Notes>(json!({"noteImages": images}))
            .err()
            .unwrap();
        assert!(error.to_string().contains("最多上传 3 张"));
        assert!(read_note_images(&images)
            .unwrap_err()
            .contains("最多上传 3 张"));
    }
}
