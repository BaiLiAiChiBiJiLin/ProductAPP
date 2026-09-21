//! Resolve an installed Windows font by name/style through the OS index.
//! No font directory traversal and no downloading of remote font files.
use super::{FontFile, FontRequest};
use std::{
    collections::HashMap,
    os::windows::ffi::OsStringExt,
    sync::{Mutex, OnceLock},
};
use windows::{
    core::{Interface, BOOL, PCWSTR},
    Win32::Graphics::DirectWrite::*,
};

fn collection() -> Option<&'static IDWriteFontCollection> {
    static COLLECTION: OnceLock<Option<IDWriteFontCollection>> = OnceLock::new();
    COLLECTION
        .get_or_init(|| {
            // DirectWrite interfaces are free-threaded. The returned collection
            // owns its COM reference and is initialized only by a text callback.
            let result = unsafe {
                DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED).and_then(
                    |factory| {
                        let mut collection = None;
                        factory.GetSystemFontCollection(&mut collection, false)?;
                        Ok(collection)
                    },
                )
            };
            match result {
                Ok(collection) => collection,
                Err(error) => {
                    log::warn!(target: "printflow::fonts", "Windows 字体索引不可用：{error}");
                    None
                }
            }
        })
        .as_ref()
}

fn matching_font(request: &FontRequest) -> Option<IDWriteFont> {
    static MATCHES: OnceLock<Mutex<HashMap<FontRequest, Option<IDWriteFont>>>> = OnceLock::new();
    let mut matches = MATCHES.get_or_init(Default::default).lock().ok()?;
    if let Some(font) = matches.get(request) {
        return font.clone();
    }
    let fonts = collection()?;
    let family: Vec<u16> = request.family.encode_utf16().chain(Some(0)).collect();
    let font = unsafe {
        let mut index = 0;
        let mut exists = BOOL(0);
        fonts
            .FindFamilyName(PCWSTR(family.as_ptr()), &mut index, &mut exists)
            .ok()?;
        if exists.as_bool() {
            let style = match request.style {
                usvg::FontStyle::Normal => DWRITE_FONT_STYLE_NORMAL,
                usvg::FontStyle::Italic => DWRITE_FONT_STYLE_ITALIC,
                usvg::FontStyle::Oblique => DWRITE_FONT_STYLE_OBLIQUE,
            };
            // usvg/fontdb enum discriminants are not DirectWrite's 1..9 values.
            let stretch = match request.stretch {
                usvg::FontStretch::UltraCondensed => DWRITE_FONT_STRETCH_ULTRA_CONDENSED,
                usvg::FontStretch::ExtraCondensed => DWRITE_FONT_STRETCH_EXTRA_CONDENSED,
                usvg::FontStretch::Condensed => DWRITE_FONT_STRETCH_CONDENSED,
                usvg::FontStretch::SemiCondensed => DWRITE_FONT_STRETCH_SEMI_CONDENSED,
                usvg::FontStretch::Normal => DWRITE_FONT_STRETCH_NORMAL,
                usvg::FontStretch::SemiExpanded => DWRITE_FONT_STRETCH_SEMI_EXPANDED,
                usvg::FontStretch::Expanded => DWRITE_FONT_STRETCH_EXPANDED,
                usvg::FontStretch::ExtraExpanded => DWRITE_FONT_STRETCH_EXTRA_EXPANDED,
                usvg::FontStretch::UltraExpanded => DWRITE_FONT_STRETCH_ULTRA_EXPANDED,
            };
            fonts
                .GetFontFamily(index)
                .ok()?
                .GetFirstMatchingFont(
                    DWRITE_FONT_WEIGHT(i32::from(request.weight)),
                    stretch,
                    style,
                )
                .ok()
        } else {
            None
        }
    };
    if matches.len() >= 128 {
        matches.clear();
    }
    matches.insert(request.clone(), font.clone());
    font
}

pub(super) fn find_font(request: &FontRequest, character: Option<char>) -> Option<FontFile> {
    let font = matching_font(request)?;
    // Buffers below use lengths reported by DirectWrite and stay alive for
    // each call. The reference key is owned by `file`, which outlives its use.
    unsafe {
        if let Some(character) = character {
            if !font.HasCharacter(character as u32).ok()?.as_bool() {
                return None;
            }
        }
        let face = font.CreateFontFace().ok()?;
        let mut count = 0;
        face.GetFiles(&mut count, None).ok()?;
        // fontdb supports standalone OpenType/TrueType files and collections.
        if count != 1 {
            return None;
        }
        let mut file = None;
        face.GetFiles(&mut count, Some(&mut file)).ok()?;
        let file = file?;
        let loader: IDWriteLocalFontFileLoader = file.GetLoader().ok()?.cast().ok()?;
        let mut key = std::ptr::null_mut();
        let mut key_size = 0;
        file.GetReferenceKey(&mut key, &mut key_size).ok()?;
        let length = loader.GetFilePathLengthFromKey(key, key_size).ok()? as usize;
        let mut path = vec![0; length + 1];
        loader.GetFilePathFromKey(key, key_size, &mut path).ok()?;
        Some(FontFile {
            path: std::ffi::OsString::from_wide(&path[..length]).into(),
            index: face.GetIndex(),
        })
    }
}
