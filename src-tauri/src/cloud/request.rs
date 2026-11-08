//! Keep the submitted request stable even if local enrichment changes later.
use super::{resources, store::Result};
use serde_json::Value;

pub fn digest(command: &str, args: &Value, expected: u64) -> String {
    resources::hash(format!("{command}:{expected}:{args}").as_bytes())
}

pub fn payload(
    command: &str,
    args: &Value,
    expected: u64,
    known_digest: &str,
    completed: bool,
    prepare: impl FnOnce(&Value) -> Result<Value>,
) -> Result<Option<Value>> {
    if known_digest == digest(command, args, expected) {
        // Replaying a committed result must not touch a mutable local catalog.
        return if completed {
            Ok(None)
        } else {
            prepare(args).map(Some)
        };
    }
    // Releases before raw request digests hashed their enriched assets. Keep
    // exact legacy replays working without weakening the digest comparison.
    let prepared = prepare(args)?;
    if known_digest != digest(command, &prepared, expected) {
        return Err("保存请求内容不一致，请重新打开记录".into());
    }
    Ok((!completed).then_some(prepared))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn completed_request_replays_without_reopening_the_finish_catalog() {
        let args = json!({"id":"batch", "assets":[]});
        let saved = digest("save_batch", &args, 3);
        let result = payload("save_batch", &args, 3, &saved, true, |_| {
            Err("工艺目录暂时不可访问".into())
        });
        assert_eq!(result.unwrap(), None);
    }

    #[test]
    fn first_request_enriches_only_after_raw_request_validation() {
        let args = json!({"id":"batch", "assets":[]});
        let saved = digest("save_batch", &args, 3);
        let enriched = json!({"id":"batch", "assets":[], "finish":"Epoxy"});
        assert_eq!(
            payload("save_batch", &args, 3, &saved, false, |_| Ok(
                enriched.clone()
            ))
            .unwrap(),
            Some(enriched)
        );
    }

    #[test]
    fn legacy_enriched_digests_still_replay_and_reject_changed_content() {
        let args = json!({"id":"batch", "assets":[]});
        let enriched = json!({"id":"batch", "assets":[], "finish":"Epoxy"});
        let saved = digest("save_batch", &enriched, 3);
        assert_eq!(
            payload("save_batch", &args, 3, &saved, true, |_| Ok(
                enriched.clone()
            ))
            .unwrap(),
            None
        );
        assert!(payload("save_batch", &args, 4, &saved, true, |_| Ok(enriched)).is_err());
    }
}
