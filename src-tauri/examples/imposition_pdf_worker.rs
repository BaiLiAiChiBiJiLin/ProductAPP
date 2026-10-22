//! Headless entry for isolated-export verification while a dev desktop is open.
//! Uses precisely the same early entry as src/main.rs; no Tauri window starts.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    std::process::exit(app_lib::run_pdf_worker_if_requested().unwrap_or(2));
}
