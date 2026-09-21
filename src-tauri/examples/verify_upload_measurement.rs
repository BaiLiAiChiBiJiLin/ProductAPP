//! Run the production measurement tests without starting/linking the desktop UI.
#[path = "../src/svg_measure.rs"]
mod svg_measure;

fn main() {
    println!("Run cargo test --example verify_upload_measurement");
}
