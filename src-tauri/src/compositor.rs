use tiny_skia::Pixmap;

/// Returns the normalized RGBA pixel difference between two renders.
/// Different dimensions are always considered a mismatch.
pub fn pixel_difference(a: &Pixmap, b: &Pixmap) -> f32 {
    if a.width() != b.width() || a.height() != b.height() { return 1.0; }
    let lhs = a.data(); let rhs = b.data();
    if lhs.is_empty() { return 0.0; }
    let total: u64 = lhs.iter().zip(rhs).map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs() as u64).sum();
    total as f32 / (lhs.len() as f32 * 255.0)
}

pub fn within_threshold(a: &Pixmap, b: &Pixmap, threshold: f32) -> bool { pixel_difference(a, b) <= threshold }

#[cfg(test)]
mod tests { use super::*; #[test] fn identical_renders_match(){ let a=Pixmap::new(2,2).unwrap(); let b=Pixmap::new(2,2).unwrap(); assert!(within_threshold(&a,&b,0.0)); } }
