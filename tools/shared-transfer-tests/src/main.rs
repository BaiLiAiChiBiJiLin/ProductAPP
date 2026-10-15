use shared_transfer_tests::validation;
use std::{fs, path::PathBuf};

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let shared = match args.next().as_deref() {
        None => None,
        Some("--shared-root") => {
            let path = PathBuf::from(args.next().ok_or("--shared-root requires a new directory path")?);
            if !path.is_absolute() || !path.file_name().and_then(|s| s.to_str()).is_some_and(|s| s.starts_with("probe-handoff-")) {
                return Err("shared root must be an absolute, fresh directory named probe-handoff-<unique>".into());
            }
            Some(path)
        }
        _ => return Err("usage: shared-transfer-tests [--shared-root <new absolute probe-handoff directory>]".into()),
    };
    if args.next().is_some() { return Err("unexpected extra argument".into()); }
    let local = validation::fresh_local_root()?;
    let shared = shared.unwrap_or_else(|| local.join("share"));
    let report = validation::run(&local, &shared)?;
    let report_path = local.join("verification-report.json");
    let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    fs::write(&report_path, &text).map_err(|e| e.to_string())?;
    fs::write(shared.join("verification-report.json"), &text).map_err(|e| e.to_string())?;
    println!("{text}");
    println!("report={}", report_path.display());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("validation failed: {error}");
        std::process::exit(1);
    }
}
