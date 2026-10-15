use crate::{cleanup, database, validation};
use rusqlite::{params, Connection};
use serde_json::json;
use std::{fs, path::PathBuf};

struct Fixture { root: PathBuf, managed: PathBuf, production: PathBuf, conn: Connection }
impl Fixture {
    fn new() -> Self {
        let root = validation::fresh_local_root().unwrap();
        let managed = root.join("registered-batch");
        let production = root.join("production");
        fs::create_dir(&managed).unwrap();
        fs::create_dir(&production).unwrap();
        let conn = database();
        conn.execute("INSERT INTO batch_asset_directories VALUES('batch',?1)", [managed.to_string_lossy().as_ref()]).unwrap();
        Self { root, managed, production, conn }
    }
    fn file(&self, name: &str) -> PathBuf {
        let path = self.managed.join(name);
        fs::write(&path, b"synthetic shared file").unwrap();
        path
    }
    fn clean(&self, paths: &[PathBuf]) -> Result<usize, String> {
        cleanup::remove_unreferenced(&self.conn, &paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(), std::slice::from_ref(&self.production))
    }
}

#[test]
fn cleanup_preserves_svg_referenced_by_a_remaining_batch() {
    let f = Fixture::new();
    let svg = f.file("shared.svg");
    f.conn.execute("INSERT INTO batches VALUES('other','2026-10-14',?1,'{}')", [json!([{"storagePath":svg}]).to_string()]).unwrap();
    assert_eq!(f.clean(std::slice::from_ref(&svg)).unwrap(), 0);
    assert_eq!(fs::read(svg).unwrap(), b"synthetic shared file");
}

#[test]
fn cleanup_uses_canonical_paths_for_differently_spelled_references() {
    let f = Fixture::new();
    let svg = f.file("shared.svg");
    fs::create_dir(f.managed.join("alias")).unwrap();
    let spelling = f.managed.join("alias").join("..").join("shared.svg");
    f.conn.execute("INSERT INTO assets VALUES('other',?1)", [json!({"storagePath":spelling}).to_string()]).unwrap();
    assert_eq!(f.clean(std::slice::from_ref(&svg)).unwrap(), 0);
    assert!(svg.is_file());
}

#[test]
fn cleanup_leaves_unmanaged_desktop_export_untouched() {
    let f = Fixture::new();
    // Synthetic Desktop sibling under our isolated test root, never the user's Desktop.
    let desktop = f.root.join("Desktop");
    fs::create_dir(&desktop).unwrap();
    let pdf = desktop.join("customer.pdf");
    fs::write(&pdf, b"synthetic user export").unwrap();
    assert_eq!(f.clean(std::slice::from_ref(&pdf)).unwrap(), 0);
    assert_eq!(fs::read(pdf).unwrap(), b"synthetic user export");
}

#[test]
fn cleanup_removes_unreferenced_managed_svg_and_production_note_only() {
    let f = Fixture::new();
    let svg = f.file("original.svg");
    let job = f.production.join("job-1");
    fs::create_dir(&job).unwrap();
    let note = job.join("note.png");
    fs::write(&note, b"synthetic note").unwrap();
    let package = f.file("package.sqlite");
    let blob = f.file("snapshot.bin");
    assert_eq!(f.clean(&[svg.clone(), note.clone(), svg.clone()]).unwrap(), 2);
    assert!(!svg.exists() && !note.exists() && !job.exists());
    assert!(f.production.is_dir() && f.managed.is_dir());
    assert!(package.is_file() && blob.is_file(), "files absent from candidates must remain");
}

#[test]
fn cleanup_missing_candidates_are_harmless() {
    let f = Fixture::new();
    assert_eq!(f.clean(&[f.managed.join("missing.svg")]).unwrap(), 0);
}

#[test]
fn cleanup_protects_review_notes_accessories_and_production_paths() {
    let f = Fixture::new();
    let review_note = f.file("review-note.png");
    let accessory = f.file("accessory.png");
    let legacy_note = f.file("legacy-note.png");
    let job_svg = f.file("job.svg");
    let job_output = f.file("job-output.pdf");
    f.conn.execute("INSERT INTO schematic_reviews VALUES('review','now','{}',?1)", [json!({"assets":[{"noteImages":[{"src":review_note}],"attributeImages":{"Accessories Color":accessory}}]}).to_string()]).unwrap();
    let images = json!([{"filePath":job_svg,"noteImage":legacy_note}]);
    f.conn.execute("INSERT INTO production_imposition_jobs VALUES('job','review','customer',?1,'now','paid','pending',1,?2)", params![job_output.to_string_lossy().as_ref(), images.to_string()]).unwrap();
    let paths = [review_note, accessory, legacy_note, job_svg, job_output];
    assert_eq!(f.clean(&paths).unwrap(), 0);
    assert!(paths.iter().all(|p| p.is_file()));
}

#[test]
fn cleanup_invalid_remaining_record_fails_closed_before_deleting() {
    let f = Fixture::new();
    let svg = f.file("original.svg");
    f.conn.execute("INSERT INTO batches VALUES('old','now','{invalid','{}')", []).unwrap();
    assert!(f.clean(std::slice::from_ref(&svg)).is_err());
    assert!(svg.is_file());
}
