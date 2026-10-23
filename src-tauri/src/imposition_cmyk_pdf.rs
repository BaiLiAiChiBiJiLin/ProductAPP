//! Nine-channel PDF encoding and millimetre placement. No RGB print fallback.
use crate::imposition_cmyk::{Converted, Job, Placement, ICC, INKS};
use pdf_writer::{
    types::{OutputIntentSubtype, OverprintMode},
    Content, Filter, Finish, Name, Pdf, Rect, Ref, Str, TextStr,
};
use std::collections::HashMap;

const INK_SPACE: Ref = Ref::new(5);
pub(crate) struct Document {
    pdf: Pdf,
    next: i32,
    images: HashMap<String, (Ref, String)>,
    photoshop_sources: HashMap<String, crate::imposition_cmyk_photoshop::Source>,
}
impl Document {
    pub(crate) fn new() -> Result<Self, String> {
        let mut pdf = Pdf::new();
        pdf.set_version(1, 7);
        let mut catalog = pdf.catalog(Ref::new(1));
        catalog.pages(Ref::new(2));
        catalog
            .output_intents()
            .push()
            .subtype(OutputIntentSubtype::PDFX)
            .output_condition_identifier(TextStr("250.icm"))
            .info(TextStr("250.icm; CMYK + White C2 M2 Y2 K2"))
            .dest_output_profile(Ref::new(6));
        catalog.finish();
        pdf.icc_profile(Ref::new(6), ICC)
            .n(4)
            .alternate()
            .device_cmyk();
        // Standard viewers show the front CMYK. RIPs use the actual nine inks.
        // Sampled function: first input dimension varies fastest, White and
        // secondary colors don't alter this non-separation fallback preview.
        let mut samples = Vec::with_capacity(512 * 4);
        for n in 0..512 {
            for c in 0..4 {
                samples.push(if n & (1 << c) != 0 { 255 } else { 0 });
            }
        }
        pdf.sampled_function(Ref::new(7), &samples)
            .domain([0., 1.].repeat(9))
            .range([0., 1.].repeat(4))
            .size([2; 9])
            .bits_per_sample(8);
        for (index, ink) in INKS.iter().enumerate().skip(4) {
            let mut sep = pdf
                .color_space(Ref::new(8 + (index - 4) as i32))
                .separation(Name(ink));
            sep.alternate_color_space().device_cmyk();
            let mut end = [0.; 4];
            end[if index == 4 { 3 } else { index - 5 }] = 1.;
            sep.tint_exponential()
                .domain([0., 1.])
                .range([0., 1.].repeat(4))
                .c0([0.; 4])
                .c1(end)
                .n(1.);
        }
        {
            // pdf-writer 0.12's typed Colorants dictionary expects Dict values,
            // whereas PDF requires Separation arrays/references. Encode that
            // dictionary using the primitive writers instead.
            let mut space = pdf.indirect(INK_SPACE).array();
            space.item(Name(b"DeviceN"));
            space.push().array().items(INKS.iter().map(|n| Name(n)));
            space
                .push()
                .array()
                .item(Name(b"ICCBased"))
                .item(Ref::new(6));
            space.item(Ref::new(7));
            let mut attrs = space.push().dict();
            attrs.pair(Name(b"Subtype"), Name(b"NChannel"));
            {
                let mut colorants = attrs.insert(Name(b"Colorants")).dict();
                for (i, name) in INKS.iter().enumerate().skip(4) {
                    colorants.pair(Name(name), Ref::new(8 + (i - 4) as i32));
                }
            }
            {
                let mut process = attrs.insert(Name(b"Process")).dict();
                process.pair(Name(b"ColorSpace"), Name(b"DeviceCMYK"));
                process
                    .insert(Name(b"Components"))
                    .array()
                    .items(INKS[..4].iter().map(|n| Name(n)));
            }
            {
                let mut hints = attrs.insert(Name(b"MixingHints")).dict();
                let mut solidities = hints.insert(Name(b"Solidities")).dict();
                for name in &INKS[4..] {
                    solidities.pair(Name(name), 1.);
                }
            }
        }
        pdf.ext_graphics(Ref::new(13))
            .overprint(true)
            .overprint_fill(true)
            .overprint_mode(OverprintMode::IgnoreZeroChannel);
        Ok(Self {
            pdf,
            next: 20,
            images: HashMap::new(),
            photoshop_sources: HashMap::new(),
        })
    }
    pub(crate) fn add_source(&mut self, key: &str, data: Converted) -> Result<(), String> {
        self.photoshop_sources.insert(
            key.to_owned(),
            crate::imposition_cmyk_photoshop::Source::new(&data)?,
        );
        let image = Ref::new(self.next);
        let mask = Ref::new(self.next + 1);
        self.next += 2;
        {
            let mut m = self.pdf.image_xobject(mask, &data.mask);
            m.width(data.width as i32)
                .height(data.height as i32)
                .bits_per_component(8);
            m.color_space().device_gray();
            m.filter(Filter::FlateDecode);
        }
        let mut x = self.pdf.image_xobject(image, &data.inks);
        x.width(data.width as i32)
            .height(data.height as i32)
            .bits_per_component(8)
            .s_mask(mask)
            .interpolate(false);
        x.filter(Filter::FlateDecode);
        x.pair(Name(b"ColorSpace"), INK_SPACE);
        x.finish();
        let name = format!("Source{}", self.images.len());
        self.images.insert(key.to_owned(), (image, name));
        Ok(())
    }
    pub(crate) fn finish(mut self, job: &Job, report: impl Fn(usize)) -> Result<Vec<u8>, String> {
        let native = crate::imposition_cmyk_photoshop::write_roundtrip(
            &mut self.pdf,
            &mut self.next,
            job,
            &self.photoshop_sources,
            report,
        )?;
        self.photoshop_sources.clear();
        let (w, h) = (
            (job.width_mm * 72. / 25.4) as f32,
            (job.height_mm * 72. / 25.4) as f32,
        );
        let mut content = Content::new();
        content.set_parameters(Name(b"PrintOverprint"));
        for p in &job.placements {
            let (_, name) = self.images.get(&p.source_key).ok_or("CMYK 图片资源缺失")?;
            content
                .save_state()
                .transform(placement_matrix(p, job.height_mm))
                .x_object(Name(name.as_bytes()))
                .restore_state();
        }
        // Registration marks belong on both color sets, never on White.
        let black = [0., 0., 0., 1., 0., 0., 0., 0., 1.];
        content
            .set_fill_color_space(Name(b"PrintInks"))
            .set_fill_color(black);
        for hole in &job.holes {
            let x = (hole.x * 72. / 25.4) as f32;
            let y = h - (hole.y * 72. / 25.4) as f32;
            let r = (hole.radius * 72. / 25.4) as f32;
            let k = r * 0.5522848;
            content
                .move_to(x + r, y)
                .cubic_to(x + r, y + k, x + k, y + r, x, y + r)
                .cubic_to(x - k, y + r, x - r, y + k, x - r, y)
                .cubic_to(x - r, y - k, x - k, y - r, x, y - r)
                .cubic_to(x + k, y - r, x + r, y - k, x + r, y)
                .close_path()
                .fill_nonzero();
        }
        let stroke = 0.2 * 72. / 25.4;
        content
            .set_stroke_color_space(Name(b"PrintInks"))
            .set_stroke_color(black)
            .set_line_width(stroke)
            .rect(stroke / 2., stroke / 2., w - stroke, h - stroke)
            .stroke();
        self.pdf.stream(Ref::new(4), &content.finish());
        let mut page = self.pdf.page(Ref::new(3));
        let modified = chrono::Utc::now().format("D:%Y%m%d%H%M%SZ").to_string();
        page.parent(Ref::new(2))
            .media_box(Rect::new(0., 0., w, h))
            .contents(Ref::new(4));
        page.pair(Name(b"LastModified"), Str(modified.as_bytes()));
        page.insert(Name(b"PieceInfo"))
            .dict()
            .insert(Name(b"AdobePhotoshop"))
            .dict()
            .pair(Name(b"LastModified"), Str(modified.as_bytes()))
            .pair(Name(b"Private"), native);
        {
            let mut r = page.resources();
            {
                let mut images = r.x_objects();
                for (id, name) in self.images.values() {
                    images.pair(Name(name.as_bytes()), *id);
                }
            }
            r.color_spaces().pair(Name(b"PrintInks"), INK_SPACE);
            r.ext_g_states().pair(Name(b"PrintOverprint"), Ref::new(13));
        }
        page.finish();
        self.pdf.pages(Ref::new(2)).kids([Ref::new(3)]).count(1);
        Ok(self.pdf.finish())
    }
}
pub(crate) fn placement_matrix(p: &Placement, board_height: f64) -> [f32; 6] {
    let (sin, cos) = p.rotation.to_radians().sin_cos();
    let unit = 72. / 25.4;
    let cx = p.x + (cos.abs() * p.width + sin.abs() * p.height) / 2.;
    let cy = p.y + (sin.abs() * p.width + cos.abs() * p.height) / 2.;
    [
        cos * p.width,
        -sin * p.width,
        sin * p.height,
        cos * p.height,
        cx - cos * p.width / 2. - sin * p.height / 2.,
        board_height - cy + sin * p.width / 2. - cos * p.height / 2.,
    ]
    .map(|n| (n * unit) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn placement_matches_canvas_rotation_and_millimetres() {
        let p = Placement {
            source_key: "x".into(),
            x: 10.,
            y: 12.,
            width: 20.,
            height: 10.,
            rotation: 90.,
        };
        let m = placement_matrix(&p, 464.);
        let unit = 72. / 25.4;
        let expected = [0., -20., 10., 0., 10., 452.];
        for i in 0..6 {
            assert!((m[i] as f64 - expected[i] * unit).abs() < 0.0002);
        }
    }
}
