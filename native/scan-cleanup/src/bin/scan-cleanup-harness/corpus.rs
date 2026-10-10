use evb_scan_cleanup::{
    io::png::decode_gray, split::LayoutClassification, BinarizationMode, CleanupOptions,
    LayoutMode, OutputMode,
};
use scan_primitives::{BinaryImage, ComponentMap, GrayImage, Rect};
use serde::Deserialize;
use std::{collections::BTreeMap, fs, path::PathBuf};

const SYNTHETIC_WIDTH: usize = 720;
const SYNTHETIC_HEIGHT: usize = 960;

pub struct CorpusEntry {
    pub id: String,
    pub identity: String,
    pub origin: Origin,
    pub categories: Vec<String>,
    pub image: GrayImage,
    pub dpi: f64,
    pub options: CleanupOptions,
    pub truth: GroundTruth,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Origin {
    Real,
    Synthetic,
}

pub struct GroundTruth {
    pub layout: Option<LayoutClassification>,
    pub cutter_x: Option<f64>,
    pub skew_degrees: Option<f64>,
    pub content_box: Option<Rect>,
    pub content_mask: Option<BinaryImage>,
    pub expected_components: Option<usize>,
    pub punctuation: Vec<InkMarker>,
    pub blank_regions: Vec<PixelRect>,
    pub warp: Option<CylindricalWarpTruth>,
}

impl Default for GroundTruth {
    fn default() -> Self {
        Self {
            layout: Some(LayoutClassification::SingleUncutPage),
            cutter_x: None,
            skew_degrees: None,
            content_box: None,
            content_mask: None,
            expected_components: None,
            punctuation: Vec::new(),
            blank_regions: Vec::new(),
            warp: None,
        }
    }
}

#[derive(Clone, Copy)]
pub struct InkMarker {
    pub x: usize,
    pub y: usize,
    pub radius: usize,
}

#[derive(Clone, Copy)]
pub struct PixelRect {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

pub struct CylindricalWarpTruth {
    pub amplitude_px: f64,
    pub baseline_rows: Vec<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitFixture {
    id: String,
    file: String,
    expected: LayoutClassification,
    family: String,
    effective_dpi: f64,
    max_dimension: usize,
    #[serde(default)]
    expected_cutter_ratio: Option<f64>,
}

pub fn build_corpus() -> Result<Vec<CorpusEntry>, String> {
    let mut entries = load_split_fixtures()?;
    entries.extend(load_glyph_fixtures()?);
    entries.extend(synthetic_fixtures());
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(entries)
}

pub fn inventory(entries: &[CorpusEntry]) -> (BTreeMap<String, usize>, BTreeMap<String, usize>) {
    let mut real = BTreeMap::new();
    let mut synthetic = BTreeMap::new();
    for entry in entries {
        let target = match entry.origin {
            Origin::Real => &mut real,
            Origin::Synthetic => &mut synthetic,
        };
        for category in &entry.categories {
            *target.entry(category.clone()).or_default() += 1;
        }
    }
    (real, synthetic)
}

fn load_split_fixtures() -> Result<Vec<CorpusEntry>, String> {
    let root = fixture_root().join("split");
    let fixtures: Vec<SplitFixture> = serde_json::from_slice(
        &fs::read(root.join("fixtures.json"))
            .map_err(|error| format!("failed to read split fixture manifest: {error}"))?,
    )
    .map_err(|error| format!("failed to decode split fixture manifest: {error}"))?;
    fixtures
        .into_iter()
        .map(|fixture| {
            let image = decode_gray(
                &fs::read(root.join(&fixture.file))
                    .map_err(|error| format!("failed to read {}: {error}", fixture.file))?,
                (fixture.max_dimension * fixture.max_dimension) as u64,
                fixture.max_dimension as u32,
            )?;
            let cutter_x = fixture
                .expected_cutter_ratio
                .map(|ratio| ratio * image.width() as f64);
            let mut options = pipeline_options(fixture.effective_dpi);
            options.layout = LayoutMode::Auto;
            Ok(CorpusEntry {
                id: fixture.id,
                identity: format!("split/{}", fixture.file),
                origin: Origin::Real,
                categories: vec!["split".into(), format!("split/{}", fixture.family)],
                image,
                dpi: fixture.effective_dpi,
                options,
                truth: GroundTruth {
                    layout: Some(fixture.expected),
                    cutter_x,
                    ..GroundTruth::default()
                },
            })
        })
        .collect()
}

fn load_glyph_fixtures() -> Result<Vec<CorpusEntry>, String> {
    let root = fixture_root().join("glyphs");
    let cases = [
        (
            "real-glyph-arabic-wright-p82-dots",
            "arabic-wright-p82-dots-input.png",
            150.0,
            vec![
                marker(189, 75, 5),
                marker(457, 75, 5),
                marker(757, 216, 5),
                marker(634, 248, 5),
                marker(1246, 74, 5),
            ],
            vec!["glyph".into(), "glyph/punctuation".into()],
        ),
        (
            "real-glyph-bedjan-p2-speckles",
            "bedjan-p2-speckles-input.png",
            150.0,
            Vec::new(),
            vec!["glyph".into(), "glyph/speckle".into()],
        ),
        (
            "real-glyph-hebrew-bhs-p126-niqqud",
            "hebrew-bhs-p126-niqqud-input.png",
            300.0,
            vec![
                marker(380, 44, 3),
                marker(676, 29, 3),
                marker(763, 29, 3),
                marker(928, 43, 3),
                marker(971, 225, 3),
            ],
            vec!["glyph".into(), "glyph/punctuation".into()],
        ),
    ];
    cases
        .into_iter()
        .map(|(id, file, dpi, punctuation, categories)| {
            let image = decode_gray(
                &fs::read(root.join(file))
                    .map_err(|error| format!("failed to read {file}: {error}"))?,
                4_000_000,
                4_000,
            )?;
            let mask = dark_mask(&image, 128);
            let expected_components = ComponentMap::from_binary(&mask).components().len();
            Ok(CorpusEntry {
                id: id.into(),
                identity: format!("glyphs/{file}"),
                origin: Origin::Real,
                categories,
                dpi,
                options: pipeline_options(dpi),
                truth: GroundTruth {
                    content_box: mask_bounds(&mask),
                    content_mask: Some(mask),
                    expected_components: Some(expected_components),
                    punctuation,
                    ..GroundTruth::default()
                },
                image,
            })
        })
        .collect()
}

fn synthetic_fixtures() -> Vec<CorpusEntry> {
    let mut entries = vec![
        synthetic_text("synthetic-skew-minus-7", "skew", -7.0, 65, 238),
        synthetic_text("synthetic-skew-minus-2", "skew", -2.0, 65, 238),
        synthetic_text("synthetic-skew-plus-2", "skew", 2.0, 65, 238),
        synthetic_text("synthetic-skew-plus-7", "skew", 7.0, 65, 238),
        synthetic_faint(),
        synthetic_page_number(),
        synthetic_blank(),
        synthetic_halftone(),
        synthetic_stained(),
        synthetic_marginalia(),
        synthetic_border_noise(),
        synthetic_curled(),
        synthetic_offcut(),
        synthetic_spread(),
    ];
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    entries
}

fn synthetic_text(id: &str, category: &str, angle_degrees: f64, ink: u8, paper: u8) -> CorpusEntry {
    let mut canvas = SyntheticCanvas::new(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, paper);
    draw_text_block(&mut canvas, 105, 175, 510, 560, ink, angle_degrees, 8);
    finish_synthetic(
        id,
        vec![category.into()],
        canvas,
        GroundTruth {
            skew_degrees: Some(angle_degrees),
            blank_regions: standard_blank_regions(),
            ..GroundTruth::default()
        },
    )
}

fn synthetic_faint() -> CorpusEntry {
    let mut canvas = SyntheticCanvas::gradient(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, 232, 249, 11);
    draw_text_block(&mut canvas, 110, 190, 500, 500, 190, 0.0, 7);
    add_punctuation(&mut canvas, &[(196, 360), (403, 502), (540, 642)], 184);
    finish_synthetic(
        "synthetic-faint-pencil",
        vec!["faint-text".into(), "sparse-text".into()],
        canvas,
        GroundTruth {
            punctuation: vec![
                marker(196, 360, 5),
                marker(403, 502, 5),
                marker(540, 642, 5),
            ],
            blank_regions: standard_blank_regions(),
            ..GroundTruth::default()
        },
    )
}

fn synthetic_page_number() -> CorpusEntry {
    let mut canvas = SyntheticCanvas::new(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, 246);
    draw_glyph(&mut canvas, 341, 891, 8, 13, 80);
    draw_glyph(&mut canvas, 354, 891, 8, 13, 80);
    finish_synthetic(
        "synthetic-page-number-only",
        vec!["page-number-only".into(), "sparse-text".into()],
        canvas,
        GroundTruth {
            punctuation: vec![marker(345, 897, 8), marker(358, 897, 8)],
            blank_regions: vec![pixel_rect(32, 32, 656, 760)],
            ..GroundTruth::default()
        },
    )
}

fn synthetic_blank() -> CorpusEntry {
    let canvas = SyntheticCanvas::gradient(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, 242, 250, 17);
    finish_synthetic(
        "synthetic-blank-page",
        vec!["blank".into()],
        canvas,
        GroundTruth {
            blank_regions: vec![pixel_rect(24, 24, 672, 912)],
            ..GroundTruth::default()
        },
    )
}

fn synthetic_halftone() -> CorpusEntry {
    let mut canvas = SyntheticCanvas::new(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, 242);
    draw_text_block(&mut canvas, 100, 130, 520, 240, 68, 0.0, 5);
    for y in 430..720 {
        for x in 160..560 {
            // A photographic plate the halftone classifier accepts: dark
            // frame and wide shadow bands sealing midtone strips (a fine
            // dot screen deliberately binarizes as printed facsimile).
            let frame = !(176..544).contains(&x) || !(446..704).contains(&y);
            let band = (490..540).contains(&y) || (590..640).contains(&y);
            let value = if frame || band {
                32 + ((x * 37 + y * 61) % 24) as u8
            } else {
                122 + ((x * 13 + y * 41) % 48) as u8
            };
            canvas.draw_visual_rect(x, y, 1, 1, value);
        }
    }
    let mut entry = finish_synthetic(
        "synthetic-halftone-photo",
        vec!["halftone-photo".into()],
        canvas,
        GroundTruth {
            blank_regions: vec![pixel_rect(30, 770, 660, 150)],
            ..GroundTruth::default()
        },
    );
    entry.truth.expected_components = None;
    entry
}

fn synthetic_stained() -> CorpusEntry {
    let mut canvas = SyntheticCanvas::gradient(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, 204, 250, 29);
    canvas.add_stains();
    draw_text_block(&mut canvas, 105, 175, 510, 570, 72, 0.0, 8);
    finish_synthetic(
        "synthetic-stained-aged-gradient",
        vec!["stained-aged".into()],
        canvas,
        GroundTruth {
            blank_regions: standard_blank_regions(),
            ..GroundTruth::default()
        },
    )
}

fn synthetic_marginalia() -> CorpusEntry {
    let mut canvas = SyntheticCanvas::new(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, 244);
    draw_text_block(&mut canvas, 120, 180, 480, 540, 65, 0.0, 7);
    for index in 0..9 {
        draw_glyph(
            &mut canvas,
            8 + (index % 2) * 12,
            250 + index * 28,
            8,
            13,
            80,
        );
    }
    finish_synthetic(
        "synthetic-marginalia-edge",
        vec!["marginalia".into(), "edge-content".into()],
        canvas,
        GroundTruth {
            blank_regions: vec![pixel_rect(630, 40, 60, 850)],
            ..GroundTruth::default()
        },
    )
}

fn synthetic_border_noise() -> CorpusEntry {
    let mut canvas = SyntheticCanvas::new(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, 242);
    draw_text_block(&mut canvas, 115, 185, 490, 540, 72, 0.0, 7);
    canvas.draw_visual_rect(0, 0, 14, SYNTHETIC_HEIGHT, 12);
    canvas.draw_visual_rect(SYNTHETIC_WIDTH - 9, 0, 9, SYNTHETIC_HEIGHT, 25);
    canvas.draw_visual_rect(0, 0, SYNTHETIC_WIDTH, 7, 18);
    for y in (80..900).step_by(73) {
        canvas.draw_visual_rect(18 + (y % 19), y, 3, 4, 30);
    }
    let mut entry = finish_synthetic(
        "synthetic-border-noise-black-edges",
        vec!["border-noise".into(), "black-scan-edge".into()],
        canvas,
        GroundTruth {
            blank_regions: vec![pixel_rect(35, 780, 640, 130)],
            ..GroundTruth::default()
        },
    );
    entry.truth.expected_components = None;
    entry
}

fn synthetic_curled() -> CorpusEntry {
    let amplitude = 34.0;
    let baselines = vec![190.0, 260.0, 330.0, 400.0, 470.0, 540.0, 610.0, 680.0];
    let mut canvas = SyntheticCanvas::new(SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, 241);
    for (line, baseline) in baselines.iter().copied().enumerate() {
        for column in 0..18 {
            let x = 105 + column * 29;
            let normalized =
                (x as f64 - SYNTHETIC_WIDTH as f64 * 0.5) / (SYNTHETIC_WIDTH as f64 * 0.5);
            let y = baseline + amplitude * normalized * normalized;
            draw_glyph(
                &mut canvas,
                x,
                y.round() as usize,
                10,
                15,
                65 + (line % 2) as u8 * 8,
            );
        }
    }
    finish_synthetic(
        "synthetic-curled-cylindrical",
        vec!["curled-baseline".into()],
        canvas,
        GroundTruth {
            blank_regions: standard_blank_regions(),
            warp: Some(CylindricalWarpTruth {
                amplitude_px: amplitude,
                baseline_rows: baselines,
            }),
            ..GroundTruth::default()
        },
    )
}

fn synthetic_offcut() -> CorpusEntry {
    let width = 900;
    let height = 760;
    let mut canvas = SyntheticCanvas::new(width, height, 245);
    draw_text_block(&mut canvas, 90, 125, 560, 510, 65, 0.0, 7);
    canvas.draw_visual_rect(678, 0, 15, height, 96);
    for line in 0..5 {
        for column in 0..4 {
            draw_glyph(&mut canvas, 735 + column * 25, 220 + line * 55, 9, 14, 90);
        }
    }
    finish_synthetic(
        "synthetic-page-with-offcut",
        vec!["page-offcut".into(), "split".into()],
        canvas,
        GroundTruth {
            layout: Some(LayoutClassification::PageWithOffcut),
            cutter_x: Some(686.0),
            ..GroundTruth::default()
        },
    )
}

fn synthetic_spread() -> CorpusEntry {
    let width = 960;
    let height = 720;
    let mut canvas = SyntheticCanvas::new(width, height, 244);
    draw_text_block(&mut canvas, 55, 115, 385, 500, 62, 0.0, 7);
    draw_text_block(&mut canvas, 520, 115, 385, 500, 62, 0.0, 7);
    for y in 0..height {
        let distance = (y as f64 - height as f64 * 0.52).abs() / height as f64;
        let shade = (210.0 + distance * 25.0).round().clamp(190.0, 235.0) as u8;
        canvas.draw_visual_rect(473, y, 14, 1, shade);
    }
    finish_synthetic(
        "synthetic-two-page-dark-gutter",
        vec![
            "two-page-spread".into(),
            "dark-gutter".into(),
            "split".into(),
        ],
        canvas,
        GroundTruth {
            layout: Some(LayoutClassification::TwoPageSpread),
            cutter_x: Some(480.0),
            ..GroundTruth::default()
        },
    )
}

fn finish_synthetic(
    id: &str,
    mut categories: Vec<String>,
    canvas: SyntheticCanvas,
    mut truth: GroundTruth,
) -> CorpusEntry {
    categories.push("synthetic".into());
    categories.sort();
    let content_box = mask_bounds(&canvas.truth);
    let expected_components = ComponentMap::from_binary(&canvas.truth).components().len();
    truth.content_box = truth.content_box.or(content_box);
    truth.content_mask = Some(canvas.truth);
    truth.expected_components = truth.expected_components.or(Some(expected_components));
    CorpusEntry {
        id: id.into(),
        identity: format!("synthetic/{id}"),
        origin: Origin::Synthetic,
        categories,
        dpi: 300.0,
        options: pipeline_options(300.0),
        image: canvas.image,
        truth,
    }
}

fn pipeline_options(dpi: f64) -> CleanupOptions {
    CleanupOptions {
        dpi,
        layout: LayoutMode::Auto,
        output_mode: OutputMode::Bw,
        crop_content: false,
        match_page_size: false,
        margins_mm: None,
        margins_pixels: Some([0.0; 4]),
        skip_blank_pages: false,
        binarization: BinarizationMode::Auto,
        ..CleanupOptions::default()
    }
}

struct SyntheticCanvas {
    image: GrayImage,
    truth: BinaryImage,
    rng: FixedRng,
}

impl SyntheticCanvas {
    fn new(width: usize, height: usize, paper: u8) -> Self {
        Self {
            image: GrayImage::new(width, height, paper),
            truth: BinaryImage::new(width, height),
            rng: FixedRng::new(0x5eed_2f01),
        }
    }

    fn gradient(width: usize, height: usize, dark: u8, light: u8, seed: u64) -> Self {
        let mut canvas = Self::new(width, height, light);
        canvas.rng = FixedRng::new(0x5eed_2f01 ^ seed);
        for y in 0..height {
            for x in 0..width {
                let horizontal = x as f64 / width.max(1) as f64;
                let vertical = y as f64 / height.max(1) as f64;
                let blend = (horizontal * 0.65 + vertical * 0.35).clamp(0.0, 1.0);
                let base = f64::from(dark) + f64::from(light - dark) * blend;
                let noise = canvas.rng.range_i16(-2, 2);
                canvas
                    .image
                    .set(x, y, (base.round() as i16 + noise).clamp(0, 255) as u8);
            }
        }
        canvas
    }

    fn draw_ink_rect(&mut self, x: usize, y: usize, width: usize, height: usize, value: u8) {
        for sample_y in y..(y + height).min(self.image.height()) {
            for sample_x in x..(x + width).min(self.image.width()) {
                self.image.set(sample_x, sample_y, value);
                self.truth.set(sample_x, sample_y, true);
            }
        }
    }

    fn draw_visual_rect(&mut self, x: usize, y: usize, width: usize, height: usize, value: u8) {
        for sample_y in y..(y + height).min(self.image.height()) {
            for sample_x in x..(x + width).min(self.image.width()) {
                self.image.set(sample_x, sample_y, value);
            }
        }
    }

    fn add_stains(&mut self) {
        let width = self.image.width();
        let height = self.image.height();
        for y in 0..height {
            for x in 0..width {
                let first = radial_falloff(x, y, 125, 230, 145.0);
                let second = radial_falloff(x, y, 610, 720, 190.0);
                let stain = (first * 31.0 + second * 23.0).round() as i16;
                let value = i16::from(self.image.get(x, y));
                self.image.set(x, y, value.saturating_sub(stain) as u8);
            }
        }
    }
}

fn draw_text_block(
    canvas: &mut SyntheticCanvas,
    left: usize,
    top: usize,
    width: usize,
    height: usize,
    ink: u8,
    angle_degrees: f64,
    line_count: usize,
) {
    let tangent = angle_degrees.to_radians().tan();
    let line_gap = height / line_count.max(1);
    let columns = width / 28;
    let center = canvas.image.width() as f64 * 0.5;
    for line in 0..line_count {
        for column in 0..columns {
            if (line * 17 + column * 11) % 13 == 0 {
                continue;
            }
            let x = left + column * 28;
            let baseline = top as f64 + (line * line_gap) as f64;
            let y = baseline + tangent * (x as f64 - center);
            if y >= 1.0 {
                draw_glyph(canvas, x, y.round() as usize, 10 + column % 3, 15, ink);
            }
        }
    }
}

fn draw_glyph(
    canvas: &mut SyntheticCanvas,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    ink: u8,
) {
    let stem = 3.min(width);
    canvas.draw_ink_rect(x, y, stem, height, ink);
    canvas.draw_ink_rect(x, y, width, 3.min(height), ink);
    if height > 7 {
        canvas.draw_ink_rect(x, y + height / 2, width.saturating_sub(2), 2, ink);
    }
}

fn add_punctuation(canvas: &mut SyntheticCanvas, points: &[(usize, usize)], ink: u8) {
    for &(x, y) in points {
        canvas.draw_ink_rect(x.saturating_sub(1), y.saturating_sub(1), 3, 3, ink);
    }
}

fn dark_mask(image: &GrayImage, threshold: u8) -> BinaryImage {
    let mut mask = BinaryImage::new(image.width(), image.height());
    for y in 0..image.height() {
        for x in 0..image.width() {
            mask.set(x, y, image.get(x, y) < threshold);
        }
    }
    mask
}

fn mask_bounds(mask: &BinaryImage) -> Option<Rect> {
    let mut left = mask.width();
    let mut top = mask.height();
    let mut right = 0usize;
    let mut bottom = 0usize;
    let mut found = false;
    for y in 0..mask.height() {
        for x in 0..mask.width() {
            if mask.get(x, y) {
                found = true;
                left = left.min(x);
                top = top.min(y);
                right = right.max(x + 1);
                bottom = bottom.max(y + 1);
            }
        }
    }
    found.then(|| {
        Rect::new(
            left as f64,
            top as f64,
            (right - left) as f64,
            (bottom - top) as f64,
        )
    })
}

fn standard_blank_regions() -> Vec<PixelRect> {
    vec![pixel_rect(28, 28, 50, 820), pixel_rect(642, 28, 50, 820)]
}

fn marker(x: usize, y: usize, radius: usize) -> InkMarker {
    InkMarker { x, y, radius }
}

fn pixel_rect(x: usize, y: usize, width: usize, height: usize) -> PixelRect {
    PixelRect {
        x,
        y,
        width,
        height,
    }
}

fn radial_falloff(x: usize, y: usize, center_x: usize, center_y: usize, radius: f64) -> f64 {
    let dx = x as f64 - center_x as f64;
    let dy = y as f64 - center_y as f64;
    (1.0 - (dx * dx + dy * dy).sqrt() / radius).clamp(0.0, 1.0)
}

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

struct FixedRng(u64);

impl FixedRng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u32(&mut self) -> u32 {
        let mut value = self.0;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.0 = value;
        (value >> 16) as u32
    }

    fn range_i16(&mut self, minimum: i16, maximum: i16) -> i16 {
        let width = (maximum - minimum + 1) as u32;
        minimum + (self.next_u32() % width) as i16
    }
}
