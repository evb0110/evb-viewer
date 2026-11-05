//! The browser entry against the CLI: every operation's bytes equal what the
//! CLI writes for the same rasters and options, run in this process.
use super::*;
use crate::io::png::{encode_gray, encode_rgb};
use scan_primitives::RgbImage;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const GLYPH_FIXTURE: &str = "tests/fixtures/glyphs/bedjan-p2-speckles-input.png";
const SPREAD_FIXTURES: [&str; 4] = [
    "tests/fixtures/split/spread-luther-soft-gutter-p00001.png",
    "tests/fixtures/split/spread-luther-soft-gutter-p00002.png",
    "tests/fixtures/split/spread-luther-soft-gutter-p00003.png",
    "tests/fixtures/split/spread-luther-soft-gutter-p00004.png",
];

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-wasm-{name}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.path(name);
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(path: &str) -> Vec<u8> {
    fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

/// A fixture at half size, so the spread and reconciliation cases stay quick.
fn half_size(path: &str) -> Vec<u8> {
    let decoded = raster::decode_image_bytes(&fixture(path), u64::MAX, u32::MAX).unwrap();
    let (width, height) = (decoded.rgb.width() / 2, decoded.rgb.height() / 2);
    encode_rgb(&decoded.rgb.resample_to_dimensions(width, height)).unwrap()
}

fn frame(
    operation: u32,
    plane_encoding: u32,
    json: &serde_json::Value,
    attachments: &[(u32, &[u8])],
) -> Vec<u8> {
    let json = serde_json::to_vec(json).unwrap();
    let mut bytes = REQUEST_MAGIC.to_vec();
    for value in [
        REQUEST_VERSION,
        operation,
        plane_encoding,
        json.len() as u32,
        attachments.len() as u32,
    ] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    for (role, data) in attachments {
        bytes.extend_from_slice(&role.to_le_bytes());
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
    }
    bytes.extend_from_slice(&json);
    for (_, data) in attachments {
        bytes.extend_from_slice(data);
    }
    assert_eq!(
        bytes.len(),
        REQUEST_HEADER_BYTES
            + attachments.len() * ATTACHMENT_HEADER_BYTES
            + json.len()
            + attachments
                .iter()
                .map(|(_, data)| data.len())
                .sum::<usize>()
    );
    bytes
}

struct DecodedPlane {
    role: u32,
    kind: u32,
    encoding: u32,
    width: u32,
    height: u32,
    data: Vec<u8>,
}

struct DecodedOutput {
    metadata: Vec<u8>,
    planes: Vec<DecodedPlane>,
}

impl DecodedOutput {
    fn plane(&self, role: u32) -> Option<&DecodedPlane> {
        self.planes.iter().find(|plane| plane.role == role)
    }
}

struct DecodedResult {
    page: Vec<u8>,
    details: Vec<u8>,
    outputs: Vec<DecodedOutput>,
}

fn decode_result(bytes: &[u8]) -> DecodedResult {
    let mut offset = 0;
    let page_len = read_len(bytes, &mut offset).unwrap();
    let details_len = read_len(bytes, &mut offset).unwrap();
    let count = read_len(bytes, &mut offset).unwrap();
    let page = take(bytes, &mut offset, page_len).unwrap().to_vec();
    let details = take(bytes, &mut offset, details_len).unwrap().to_vec();
    let mut outputs = Vec::new();
    for _ in 0..count {
        let metadata_len = read_len(bytes, &mut offset).unwrap();
        let plane_count = read_len(bytes, &mut offset).unwrap();
        let metadata = take(bytes, &mut offset, metadata_len).unwrap().to_vec();
        let mut planes = Vec::new();
        for _ in 0..plane_count {
            let role = read_u32(bytes, &mut offset).unwrap();
            let kind = read_u32(bytes, &mut offset).unwrap();
            let encoding = read_u32(bytes, &mut offset).unwrap();
            let width = read_u32(bytes, &mut offset).unwrap();
            let height = read_u32(bytes, &mut offset).unwrap();
            let data_len = read_len(bytes, &mut offset).unwrap();
            planes.push(DecodedPlane {
                role,
                kind,
                encoding,
                width,
                height,
                data: take(bytes, &mut offset, data_len).unwrap().to_vec(),
            });
        }
        outputs.push(DecodedOutput { metadata, planes });
    }
    assert_eq!(offset, bytes.len(), "result frame has trailing bytes");
    DecodedResult {
        page,
        details,
        outputs,
    }
}

fn run(frame: &[u8]) -> DecodedResult {
    decode_result(&run_request(frame).unwrap())
}

fn options(overrides: serde_json::Value) -> serde_json::Value {
    let mut options = serde_json::to_value(CleanupOptions::default()).unwrap();
    for (key, value) in overrides.as_object().unwrap() {
        options[key] = value.clone();
    }
    options
}

/// The pinned OCR preprocessing options desktop OCR passes to the CLI.
fn ocr_options(polarity_only: bool) -> serde_json::Value {
    let mut overrides = serde_json::json!({
        "dpi": 300, "sourceDpi": 300, "requestedRenderDpi": 300,
        "sourceHasBilevelLayer": false, "binarization": "auto", "thickness": 0,
        "normalizeIllumination": true, "despeckle": true, "despeckleLevel": "normal",
        "outputMode": "bw", "ocrMode": true, "layout": "auto", "manualSplit": null,
        "manualContentBoxes": {}, "manualZones": {"picture": [], "fill": []},
        "cropContent": true, "matchPageSize": true, "pageAlignment": "top-center",
        "placementOverrides": {},
        "margins": {"leftMm": 5, "topMm": 5, "rightMm": 5, "bottomMm": 5},
        "experimental": {"autoDewarp": false}, "rotationDegrees": 0, "excluded": false,
        "skipBlankPages": false, "maxPixels": 160_000_000, "maxDimensionPx": 40_000,
    });
    if polarity_only {
        for (key, value) in serde_json::json!({
            "normalizeIllumination": false, "despeckle": false, "layout": "force-single",
            "cropContent": false, "matchPageSize": false,
            "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0},
            "ocrPolarityOnly": true,
        })
        .as_object()
        .unwrap()
        {
            overrides[key] = value.clone();
        }
    }
    overrides
}

fn preview_request(options: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "options": options,
        "sourcePageIndex": 0,
        "canvasScope": "page",
        "renderMode": "preview",
    })
}

fn run_direct_cli(input: &[u8], options: &serde_json::Value, ocr_mode: bool) -> (Vec<u8>, Vec<u8>) {
    let scratch = Scratch::new("direct");
    let input_path = scratch.write("input.png", input);
    let output_path = scratch.path("output.png");
    let metadata_path = scratch.path("output.json");
    let mut args = vec![
        "--input".to_owned(),
        input_path.display().to_string(),
        "--output".to_owned(),
        output_path.display().to_string(),
        "--metadata".to_owned(),
        metadata_path.display().to_string(),
        "--options".to_owned(),
        options.to_string(),
    ];
    if ocr_mode {
        args.push("--ocr-mode".to_owned());
    }
    crate::adapters::batch_cli::run(args).unwrap();
    (
        fs::read(output_path).unwrap(),
        fs::read(metadata_path).unwrap(),
    )
}

fn run_manifest(scratch: &Scratch, manifest: serde_json::Value) {
    let path = scratch.write("manifest.json", &serde_json::to_vec(&manifest).unwrap());
    crate::adapters::batch_cli::run(["--manifest".to_owned(), path.display().to_string()]).unwrap();
}

/// One output's manifest destination with every plane it can take.
struct Destination {
    output: PathBuf,
    metadata: PathBuf,
    planes: [(u32, PathBuf); 6],
}

impl Destination {
    fn new(scratch: &Scratch, name: &str, background_extension: &str) -> Self {
        Self {
            output: scratch.path(&format!("{name}.png")),
            metadata: scratch.path(&format!("{name}.json")),
            planes: [
                (PLANE_ROLE_BILEVEL, scratch.path(&format!("{name}.pbm"))),
                (
                    PLANE_ROLE_BACKGROUND,
                    scratch.path(&format!("{name}-background.{background_extension}")),
                ),
                (
                    PLANE_ROLE_FOREGROUND_MASK,
                    scratch.path(&format!("{name}-mask.pbm")),
                ),
                (
                    PLANE_ROLE_FOREGROUND_ALPHA,
                    scratch.path(&format!("{name}-alpha.pgm")),
                ),
                (
                    PLANE_ROLE_PICTURE_MASK,
                    scratch.path(&format!("{name}-picture.pbm")),
                ),
                (
                    PLANE_ROLE_TONE_PRESERVATION_ALPHA,
                    scratch.path(&format!("{name}-tone.png")),
                ),
            ],
        }
    }

    fn manifest(&self) -> serde_json::Value {
        serde_json::json!({
            "outputPath": self.output,
            "metadataPath": self.metadata,
            "bilevelOutputPath": self.planes[0].1,
            "backgroundOutputPath": self.planes[1].1,
            "foregroundMaskOutputPath": self.planes[2].1,
            "foregroundAlphaOutputPath": self.planes[3].1,
            "pictureMaskOutputPath": self.planes[4].1,
            "tonePreservationAlphaOutputPath": self.planes[5].1,
        })
    }

    fn request(background_extension: &str) -> serde_json::Value {
        serde_json::json!({
            "bilevel": true,
            "background": background_extension,
            "foregroundMask": true,
            "foregroundAlpha": true,
            "pictureMask": true,
            "tonePreservationAlpha": true,
        })
    }

    /// The browser output carries exactly the planes the CLI published here,
    /// byte for byte, and the same metadata.
    fn assert_published(&self, label: &str, output: &DecodedOutput) {
        assert_eq!(
            String::from_utf8_lossy(&output.metadata),
            String::from_utf8_lossy(&fs::read(&self.metadata).unwrap()),
            "{label}: output metadata"
        );
        for (role, path) in std::iter::once((PLANE_ROLE_COMPOSITE, &self.output))
            .chain(self.planes.iter().map(|(role, path)| (*role, path)))
        {
            match (output.plane(role), path.exists()) {
                (Some(plane), true) => assert!(
                    plane.data == fs::read(path).unwrap(),
                    "{label}: plane {role} differs from {}",
                    path.display()
                ),
                (None, false) => {}
                (plane, exists) => panic!(
                    "{label}: plane {role} returned={} but the CLI wrote it={exists}",
                    plane.is_some()
                ),
            }
        }
    }
}

#[test]
fn render_preview_matches_the_direct_cli_bytes_and_metadata() {
    let input = fixture(GLYPH_FIXTURE);
    for (label, options, ocr_mode) in [
        ("ocr-clean", ocr_options(false), true),
        ("ocr-polarity-only", ocr_options(true), true),
        (
            "grayscale",
            options(
                serde_json::json!({"outputMode": "grayscale", "layout": "force-single", "matchPageSize": false}),
            ),
            false,
        ),
        (
            "auto",
            options(serde_json::json!({"outputMode": "auto", "matchPageSize": false})),
            false,
        ),
    ] {
        let (cli_png, cli_metadata) = run_direct_cli(&input, &options, ocr_mode);
        let mut wasm_options = options.clone();
        if ocr_mode {
            // `--ocr-mode` and the option are the same switch.
            wasm_options["ocrMode"] = serde_json::Value::Bool(true);
        }
        let result = run(&frame(
            OP_RENDER_PAGE,
            PLANES_ENCODED,
            &preview_request(wasm_options),
            &[(ATTACHMENT_INPUT, &input)],
        ));
        assert_eq!(result.outputs.len(), 1, "{label}");
        let output = &result.outputs[0];
        assert_eq!(
            output.planes.len(),
            1,
            "{label}: a preview takes its composite only"
        );
        let composite = output.plane(PLANE_ROLE_COMPOSITE).unwrap();
        assert_eq!(composite.encoding, PLANE_ENCODING_PNG, "{label}");
        assert!(
            composite.data == cli_png,
            "{label}: PNG bytes differ from the CLI"
        );
        assert_eq!(
            String::from_utf8(output.metadata.clone()).unwrap(),
            String::from_utf8(cli_metadata).unwrap(),
            "{label}: metadata differs from the CLI"
        );
        assert!(result.details.is_empty());
        let page: serde_json::Value = serde_json::from_slice(&result.page).unwrap();
        assert_eq!(page["outputCount"], 1, "{label}");
        assert_eq!(page["canvasScope"], "page", "{label}");
    }
}

fn glyph_canvas() -> serde_json::Value {
    // The glyph page at its 300 DPI: 880 x 600 pixels.
    serde_json::json!({"widthPoints": 211.2, "heightPoints": 144.0, "widthPx": 880, "heightPx": 600})
}

/// A colored photo beside four text rules: a mixed page with a picture zone,
/// which a final render publishes as separable layers.
fn mixed_page() -> (Vec<u8>, serde_json::Value, serde_json::Value) {
    let mut image = RgbImage::new(180, 120, [248; 3]);
    for y in 24..94 {
        for x in 96..168 {
            image.set(
                x,
                y,
                [
                    30 + ((x * 7 + y * 11) % 180) as u8,
                    45 + ((x * 13 + y * 3) % 150) as u8,
                    70 + ((x * 5 + y * 17) % 150) as u8,
                ],
            );
        }
    }
    for y in [22, 42, 62, 82] {
        for x in 16..78 {
            image.set(x, y, [18; 3]);
            image.set(x, y + 1, [18; 3]);
        }
    }
    let options = options(serde_json::json!({
        "outputMode": "mixed", "layout": "force-single", "normalizeIllumination": false,
        "cropContent": true, "matchPageSize": true, "pageAlignment": "center",
        "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0},
        "automaticContentBoxes": {"full": {"xNormalized": 0.0, "yNormalized": 10.0 / 120.0, "widthNormalized": 170.0 / 180.0,
            "heightNormalized": 100.0 / 120.0, "rotationDegrees": 0}},
        "dpi": 600, "sourceDpi": 300,
        "manualZones": {"picture": [{"polygon": {"points": [
            {"xNormalized": 0.5, "yNormalized": 0.15}, {"xNormalized": 0.96, "yNormalized": 0.15}, {"xNormalized": 0.96, "yNormalized": 0.85}, {"xNormalized": 0.5, "yNormalized": 0.85}
        ], "rotationDegrees": 0}, "layer": "painter2"}], "fill": []},
    }));
    let canvas = serde_json::json!({"widthPoints": 21.6, "heightPoints": 14.4, "widthPx": 180, "heightPx": 120});
    (encode_rgb(&image).unwrap(), options, canvas)
}

struct FinalCase {
    label: &'static str,
    input: Vec<u8>,
    options: serde_json::Value,
    canvas: serde_json::Value,
    background_extension: &'static str,
    outputs: usize,
}

fn final_cases() -> Vec<FinalCase> {
    let glyph = fixture(GLYPH_FIXTURE);
    let glyph_options = |overrides: serde_json::Value| {
        let mut options = ocr_options(false);
        options["ocrMode"] = false.into();
        for (key, value) in overrides.as_object().unwrap() {
            options[key] = value.clone();
        }
        options
    };
    let (mixed, mixed_options, mixed_canvas) = mixed_page();
    let spread = half_size(SPREAD_FIXTURES[0]);
    // The spread at half size is 600 x 435 pixels at 75 DPI; a leaf is half.
    let spread_canvas = serde_json::json!({"widthPoints": 288.0, "heightPoints": 417.6, "widthPx": 300, "heightPx": 435});
    let spread_options = |mode: &str| {
        let mut options = glyph_options(serde_json::json!({
            "dpi": 75, "sourceDpi": 75, "requestedRenderDpi": 75,
            "layout": "force-two-page", "outputMode": mode,
        }));
        options["margins"] =
            serde_json::json!({"leftMm": 2, "topMm": 2, "rightMm": 2, "bottomMm": 2});
        options
    };
    vec![
        FinalCase {
            label: "bw page on a matched canvas",
            input: glyph.clone(),
            options: glyph_options(serde_json::json!({})),
            canvas: glyph_canvas(),
            background_extension: "ppm",
            outputs: 1,
        },
        FinalCase {
            label: "grayscale page with a gray PGM background destination",
            input: glyph.clone(),
            options: glyph_options(serde_json::json!({"outputMode": "grayscale"})),
            canvas: glyph_canvas(),
            background_extension: "pgm",
            outputs: 1,
        },
        FinalCase {
            label: "color page, unmatched",
            input: glyph,
            options: glyph_options(
                serde_json::json!({"outputMode": "color", "matchPageSize": false}),
            ),
            canvas: glyph_canvas(),
            background_extension: "png",
            outputs: 1,
        },
        FinalCase {
            label: "mixed page with separable layers",
            input: mixed.clone(),
            options: mixed_options.clone(),
            canvas: mixed_canvas.clone(),
            background_extension: "ppm",
            outputs: 1,
        },
        FinalCase {
            label: "mixed page with a PNG background",
            input: mixed,
            options: mixed_options,
            canvas: mixed_canvas,
            background_extension: "png",
            outputs: 1,
        },
        FinalCase {
            label: "bw spread on a matched canvas",
            input: spread.clone(),
            options: spread_options("bw"),
            canvas: spread_canvas.clone(),
            background_extension: "ppm",
            outputs: 2,
        },
        FinalCase {
            label: "mixed spread materialized on the canvas",
            input: spread,
            options: spread_options("mixed"),
            canvas: spread_canvas,
            background_extension: "ppm",
            outputs: 2,
        },
    ]
}

#[test]
fn final_render_matches_a_one_page_final_manifest_plane_for_plane() {
    for case in final_cases() {
        let scratch = Scratch::new("final");
        let input = scratch.write("input.png", &case.input);
        let page_metadata = scratch.path("page.json");
        let destinations = (0..2)
            .map(|index| {
                Destination::new(&scratch, &format!("out-{index}"), case.background_extension)
            })
            .collect::<Vec<_>>();
        run_manifest(
            &scratch,
            serde_json::json!({
                "version": 3, "operation": "render", "renderMode": "final",
                "canvasScope": "document", "documentCanvas": case.canvas,
                "pages": [{
                    "inputPath": input, "sourcePageIndex": 0, "pageMetadataPath": page_metadata,
                    "options": case.options,
                    "outputs": destinations.iter().map(Destination::manifest).collect::<Vec<_>>(),
                }],
            }),
        );
        let request = serde_json::json!({
            "options": case.options, "sourcePageIndex": 0, "canvasScope": "document",
            "renderMode": "final", "documentCanvas": case.canvas,
            "outputs": [Destination::request(case.background_extension), Destination::request(case.background_extension)],
        });
        let result = run(&frame(
            OP_RENDER_PAGE,
            PLANES_ENCODED,
            &request,
            &[(ATTACHMENT_INPUT, &case.input)],
        ));
        assert_eq!(
            String::from_utf8_lossy(&result.page),
            String::from_utf8_lossy(&fs::read(&page_metadata).unwrap()),
            "{}: page metadata",
            case.label
        );
        assert_eq!(result.outputs.len(), case.outputs, "{}", case.label);
        for (output, destination) in result.outputs.iter().zip(&destinations) {
            destination.assert_published(case.label, output);
        }
        let published = result
            .outputs
            .iter()
            .flat_map(|output| output.planes.iter().map(|plane| plane.role))
            .collect::<Vec<_>>();
        eprintln!("{}: planes {published:?}", case.label);
    }
}

#[test]
fn final_layered_render_publishes_the_layers_instead_of_the_composite() {
    let (input, options, canvas) = mixed_page();
    let result = run(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &serde_json::json!({
            "options": options, "sourcePageIndex": 0, "canvasScope": "document",
            "renderMode": "final", "documentCanvas": canvas,
            "outputs": [Destination::request("ppm")],
        }),
        &[(ATTACHMENT_INPUT, &input)],
    ));
    let output = &result.outputs[0];
    let metadata: serde_json::Value = serde_json::from_slice(&output.metadata).unwrap();
    assert_eq!(metadata["layeredWritten"], true);
    assert!(output.plane(PLANE_ROLE_BACKGROUND).unwrap().encoding == PLANE_ENCODING_PPM);
    assert!(output.plane(PLANE_ROLE_FOREGROUND_MASK).unwrap().encoding == PLANE_ENCODING_PBM);
    assert!(output.plane(PLANE_ROLE_COMPOSITE).is_none());
}

#[test]
fn raw_planes_carry_the_encoded_planes_pixels() {
    let input = fixture(GLYPH_FIXTURE);
    let mut bw = ocr_options(false);
    bw["ocrMode"] = false.into();
    for (request, role) in [
        (
            preview_request(options(
                serde_json::json!({"outputMode": "color", "layout": "force-single", "matchPageSize": false}),
            )),
            PLANE_ROLE_COMPOSITE,
        ),
        (
            serde_json::json!({
                "options": bw, "sourcePageIndex": 0, "canvasScope": "document",
                "renderMode": "final", "documentCanvas": glyph_canvas(),
                "outputs": [{"bilevel": true}],
            }),
            PLANE_ROLE_BILEVEL,
        ),
    ] {
        let attachments = [(ATTACHMENT_INPUT, input.as_slice())];
        let encoded = run(&frame(
            OP_RENDER_PAGE,
            PLANES_ENCODED,
            &request,
            &attachments,
        ));
        let raw = run(&frame(OP_RENDER_PAGE, PLANES_RAW, &request, &attachments));
        let (encoded, raw) = (
            encoded.outputs[0].plane(role).unwrap(),
            raw.outputs[0].plane(role).unwrap(),
        );
        assert_eq!(raw.encoding, PLANE_ENCODING_RAW);
        assert_eq!(
            (raw.kind, raw.width, raw.height),
            (encoded.kind, encoded.width, encoded.height)
        );
        match raw.kind {
            PLANE_KIND_RGB8 => {
                let decoded =
                    raster::decode_image_bytes(&encoded.data, u64::MAX, u32::MAX).unwrap();
                assert_eq!(decoded.rgb.data(), raw.data.as_slice());
            }
            PLANE_KIND_BILEVEL1 => {
                let rows = (raw.width as usize).div_ceil(8) * raw.height as usize;
                assert_eq!(raw.data.len(), rows);
                assert_eq!(
                    &encoded.data[encoded.data.len() - rows..],
                    raw.data.as_slice()
                );
            }
            kind => panic!("unexpected plane kind {kind}"),
        }
    }
}

#[test]
fn preview_on_a_document_canvas_with_pdf_geometry_matches_a_preview_manifest() {
    let input = fixture(GLYPH_FIXTURE);
    let scratch = Scratch::new("preview-canvas");
    let input_path = scratch.write("input.png", &input);
    let page_metadata = scratch.path("page.json");
    let destination = Destination::new(&scratch, "out", "ppm");
    let mut options = ocr_options(false);
    options["ocrMode"] = false.into();
    let pdf_page = serde_json::json!({"xPoints": 0.0, "yPoints": 0.0, "widthPoints": 211.2,
        "heightPoints": 144.0, "rotation": 0, "sourceDpi": 300.0});
    run_manifest(
        &scratch,
        serde_json::json!({
            "version": 3, "operation": "render", "renderMode": "preview",
            "canvasScope": "page", "documentCanvas": glyph_canvas(),
            "pages": [{
                "inputPath": input_path, "sourcePageIndex": 0, "pageMetadataPath": page_metadata,
                "options": options, "pdfPage": pdf_page,
                "outputs": [{"outputPath": destination.output, "metadataPath": destination.metadata}],
            }],
        }),
    );
    let result = run(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &serde_json::json!({
            "options": options, "sourcePageIndex": 0, "canvasScope": "page",
            "renderMode": "preview", "documentCanvas": glyph_canvas(), "pdfPage": pdf_page,
            "outputs": [{}],
        }),
        &[(ATTACHMENT_INPUT, &input)],
    ));
    assert_eq!(
        String::from_utf8_lossy(&result.page),
        String::from_utf8_lossy(&fs::read(&page_metadata).unwrap())
    );
    destination.assert_published("preview on a canvas", &result.outputs[0]);
    let metadata: serde_json::Value = serde_json::from_slice(&result.outputs[0].metadata).unwrap();
    assert_eq!(
        metadata["uniformCanvas"], true,
        "the document canvas was applied"
    );
    assert!(
        metadata["sourcePdfPlacement"].is_object(),
        "source preservation was recorded"
    );
}

#[test]
fn detail_render_matches_a_detail_manifest() {
    let source = fixture(GLYPH_FIXTURE);
    let scratch = Scratch::new("detail");
    let source_path = scratch.write("source.png", &source);
    let options = options(serde_json::json!({
        "outputMode": "grayscale", "layout": "force-single", "matchPageSize": false,
        "dpi": 300, "sourceDpi": 300, "requestedRenderDpi": 300,
    }));
    // The base preview the detail refines, rendered by the CLI.
    let base = Destination::new(&scratch, "base", "ppm");
    run_manifest(
        &scratch,
        serde_json::json!({
            "version": 3, "operation": "render", "renderMode": "preview", "canvasScope": "page",
            "pages": [{
                "inputPath": source_path, "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("base-page.json"), "options": options,
                "outputs": [{"outputPath": base.output, "metadataPath": base.metadata}],
            }],
        }),
    );
    let decoded = raster::decode_image_bytes(&source, u64::MAX, u32::MAX).unwrap();
    let (x, y, width, height) = (100usize, 80usize, 300usize, 200usize);
    let mut crop = GrayImage::new(width, height, 255);
    for row in 0..height {
        for column in 0..width {
            crop.set(column, row, decoded.gray.get(x + column, y + row));
        }
    }
    let crop = encode_gray(&crop).unwrap();
    let crop_path = scratch.write("crop.png", &crop);
    let geometry = serde_json::json!({
        "sourceCrop": {"xPx": x, "yPx": y, "widthPx": width, "heightPx": height},
        "fullSourceWidthPx": decoded.gray.width(), "fullSourceHeightPx": decoded.gray.height(),
        "scale": 1.0,
        "renderRegion": {"xPx": 140, "yPx": 100, "widthPx": 200, "heightPx": 150},
        "sampledRegion": {"xPx": x, "yPx": y, "widthPx": width, "heightPx": height},
    });
    let mut plan = geometry.clone();
    plan["baseMetadataPath"] = serde_json::json!(base.metadata);
    plan["baseRasterPath"] = serde_json::json!(source_path);
    plan["baseCleanedRasterPath"] = serde_json::json!(base.output);
    let detail = Destination::new(&scratch, "detail", "ppm");
    let page_metadata = scratch.path("detail-page.json");
    run_manifest(
        &scratch,
        serde_json::json!({
            "version": 3, "operation": "render", "renderMode": "preview", "canvasScope": "page",
            "pages": [{
                "inputPath": crop_path, "sourcePageIndex": 0, "pageMetadataPath": page_metadata,
                "options": options, "detailRenderPlan": plan,
                "outputs": [{"outputPath": detail.output, "metadataPath": detail.metadata}],
            }],
        }),
    );
    let base_metadata = fs::read(&base.metadata).unwrap();
    let base_cleaned = fs::read(&base.output).unwrap();
    let mut request = preview_request(options);
    request["detailRenderPlan"] = geometry;
    let result = run(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &request,
        &[
            (ATTACHMENT_INPUT, &crop),
            (ATTACHMENT_DETAIL_BASE_METADATA, &base_metadata),
            (ATTACHMENT_DETAIL_BASE_SOURCE, &source),
            (ATTACHMENT_DETAIL_BASE_CLEANED, &base_cleaned),
        ],
    ));
    assert_eq!(
        String::from_utf8_lossy(&result.page),
        String::from_utf8_lossy(&fs::read(&page_metadata).unwrap())
    );
    detail.assert_published("detail render", &result.outputs[0]);
}

/// Twelve producer MRC pages: enough body text for a document ink prior. The
/// first page's selection is thinner than the rest, so the prior restores it.
fn mrc_pages() -> Vec<(Vec<u8>, Vec<u8>)> {
    fn text_page(glyph_width: usize, glyph_height: usize) -> (Vec<u8>, Vec<u8>) {
        let mut raw = GrayImage::new(120, 100, 250);
        let mut selection = GrayImage::new(120, 100, 255);
        for row in 0usize..4 {
            for column in 0usize..6 {
                let left = 5 + column * 18;
                let top = 5 + row * 23;
                for y in top.saturating_sub(1)..(top + glyph_height + 1).min(raw.height()) {
                    for x in left.saturating_sub(1)..(left + glyph_width + 1).min(raw.width()) {
                        raw.set(x, y, 180);
                    }
                }
                for y in top..top + glyph_height {
                    for x in left..left + glyph_width {
                        raw.set(x, y, 32);
                        selection.set(x, y, 0);
                    }
                }
            }
        }
        (encode_gray(&raw).unwrap(), encode_gray(&selection).unwrap())
    }
    (0..12)
        .map(|index| {
            if index == 0 {
                text_page(4, 20)
            } else {
                text_page(5, 16)
            }
        })
        .collect()
}

fn mrc_options() -> serde_json::Value {
    options(serde_json::json!({
        "dpi": 150, "sourceDpi": 150, "sourceHasBilevelLayer": true, "sourceBackgroundDpi": 75,
        "outputMode": "bw", "layout": "force-single", "normalizeIllumination": false,
        "cropContent": true, "matchPageSize": false,
        "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0},
        "automaticContentBoxes": {"full": {"xNormalized": 0.04, "yNormalized": 0.04, "widthNormalized": 0.90, "heightNormalized": 0.92, "rotationDegrees": 0}},
    }))
}

#[test]
fn producer_mrc_pages_render_with_the_document_ink_prior_a_render_manifest_derives() {
    let scratch = Scratch::new("ink-prior");
    let pages = mrc_pages();
    let background = encode_gray(&GrayImage::new(60, 50, 250)).unwrap();
    let background_path = scratch.write("background.png", &background);
    let options = mrc_options();
    let destinations = (0..pages.len())
        .map(|index| Destination::new(&scratch, &format!("out-{index}"), "ppm"))
        .collect::<Vec<_>>();
    run_manifest(
        &scratch,
        serde_json::json!({
            "version": 3, "operation": "render", "renderMode": "final", "canvasScope": "document",
            "pages": pages.iter().enumerate().map(|(index, (input, selection))| serde_json::json!({
                "inputPath": scratch.write(&format!("input-{index}.png"), input),
                "trustedForegroundMaskPath": scratch.write(&format!("selection-{index}.png"), selection),
                "trustedMrcBackgroundPath": background_path,
                "sourcePageIndex": index,
                "pageMetadataPath": scratch.path(&format!("page-{index}.json")),
                "options": options,
                "outputs": [destinations[index].manifest()],
            })).collect::<Vec<_>>(),
        }),
    );
    let samples = pages
        .iter()
        .enumerate()
        .map(|(index, (_, selection))| {
            let result = run(&frame(
                OP_SAMPLE_PAGE_INK,
                PLANES_RAW,
                &serde_json::json!({"options": options, "sourcePageIndex": index}),
                &[
                    (ATTACHMENT_TRUSTED_FOREGROUND_SELECTION, selection),
                    (ATTACHMENT_TRUSTED_MRC_BACKGROUND, &background),
                ],
            ));
            serde_json::from_slice::<serde_json::Value>(&result.details).unwrap()["sample"].clone()
        })
        .collect::<Vec<_>>();
    assert!(samples.iter().all(|sample| sample.is_object()));
    let contexts = run(&frame(
        OP_DERIVE_INK_CONTEXTS,
        PLANES_RAW,
        &serde_json::json!({"samples": samples}),
        &[],
    ));
    let contexts =
        serde_json::from_slice::<serde_json::Value>(&contexts.details).unwrap()["contexts"].clone();
    for (index, (input, selection)) in pages.iter().enumerate() {
        let result = run(&frame(
            OP_RENDER_PAGE,
            PLANES_ENCODED,
            &serde_json::json!({
                "options": options, "sourcePageIndex": index, "canvasScope": "document",
                "renderMode": "final", "pageInkConsistency": contexts[index],
                "outputs": [Destination::request("ppm")],
            }),
            &[
                (ATTACHMENT_INPUT, input),
                (ATTACHMENT_TRUSTED_FOREGROUND_SELECTION, selection),
                (ATTACHMENT_TRUSTED_MRC_BACKGROUND, &background),
            ],
        ));
        assert_eq!(
            String::from_utf8_lossy(&result.page),
            String::from_utf8_lossy(
                &fs::read(scratch.path(&format!("page-{index}.json"))).unwrap()
            ),
            "page {index}"
        );
        destinations[index].assert_published(&format!("MRC page {index}"), &result.outputs[0]);
    }
    let first: serde_json::Value =
        serde_json::from_slice(&fs::read(&destinations[0].metadata).unwrap()).unwrap();
    assert_eq!(first["inkConsistencyDiagnostics"]["applied"], true);
}

#[test]
fn analyze_matches_a_single_page_analyze_manifest() {
    let input = fixture(GLYPH_FIXTURE);
    let scratch = Scratch::new("analyze");
    let input_path = scratch.write("input.png", &input);
    let metadata_path = scratch.path("page.json");
    let options = options(serde_json::json!({"outputMode": "auto"}));
    run_manifest(
        &scratch,
        serde_json::json!({
            "version": 3, "operation": "analyze", "renderMode": "preview", "canvasScope": "page",
            "pages": [{
                "inputPath": input_path, "sourcePageIndex": 0, "pageMetadataPath": metadata_path,
                "options": options, "outputs": [],
            }],
        }),
    );
    let result = run(&frame(
        OP_ANALYZE_PAGE,
        PLANES_RAW,
        &serde_json::json!({"options": options, "sourcePageIndex": 0, "canvasScope": "page"}),
        &[(ATTACHMENT_INPUT, &input)],
    ));
    assert!(result.outputs.is_empty());
    assert_eq!(
        String::from_utf8(result.page).unwrap(),
        String::from_utf8(fs::read(metadata_path).unwrap()).unwrap()
    );
    let details: serde_json::Value = serde_json::from_slice(&result.details).unwrap();
    assert!(details["reconciliation"]["tier1Verdict"].is_string());
    assert!(details["reconciliation"]["rotatedWidth"].as_u64().unwrap() > 0);
}

/// Four soft-gutter spreads, and the first again shifted a twentieth of its
/// width. Its confident cutter must survive document reconciliation even
/// though it falls away from the document median.
fn reconciliation_pages() -> Vec<Vec<u8>> {
    let mut pages = SPREAD_FIXTURES.map(half_size).to_vec();
    let decoded = raster::decode_image_bytes(&pages[0], u64::MAX, u32::MAX).unwrap();
    let shift = decoded.rgb.width() / 20;
    let mut shifted = RgbImage::new(decoded.rgb.width(), decoded.rgb.height(), [255; 3]);
    for y in 0..decoded.rgb.height() {
        for x in shift..decoded.rgb.width() {
            shifted.set(x, y, decoded.rgb.get(x - shift, y));
        }
    }
    pages.push(encode_rgb(&shifted).unwrap());
    pages
}

#[test]
fn document_reconciliation_matches_a_multi_page_analyze_manifest() {
    let scratch = Scratch::new("reconcile");
    let pages = reconciliation_pages();
    let options = options(serde_json::json!({"dpi": 75, "sourceDpi": 75, "outputMode": "auto"}));
    let pdf_page = serde_json::json!({"xPoints": 0.0, "yPoints": 0.0, "widthPoints": 576.0,
        "heightPoints": 417.6, "rotation": 0, "sourceDpi": 75.0});
    let canvas = serde_json::json!({"widthPoints": 288.0, "heightPoints": 417.6, "widthPx": 300, "heightPx": 435});
    for (label, render_mode, lossless) in
        [("page plan", "preview", false), ("lossless", "final", true)]
    {
        let manifest_pages = pages
            .iter()
            .enumerate()
            .map(|(index, input)| {
                let mut page = serde_json::json!({
                    "inputPath": scratch.write(&format!("{label}-input-{index}.png"), input),
                    "sourcePageIndex": index,
                    "pageMetadataPath": scratch.path(&format!("{label}-page-{index}.json")),
                    "options": options, "outputs": [],
                });
                if lossless {
                    page["pdfPage"] = pdf_page.clone();
                }
                page
            })
            .collect::<Vec<_>>();
        let mut manifest = serde_json::json!({
            "version": 3, "operation": "analyze", "renderMode": render_mode,
            "canvasScope": if lossless { "document" } else { "page" }, "pages": manifest_pages,
        });
        if lossless {
            manifest["documentCanvas"] = canvas.clone();
        }
        run_manifest(&scratch, manifest);
        let canvas_scope = if lossless { "document" } else { "page" };
        let analyze = |index: usize, prior: Option<&serde_json::Value>| {
            let mut request = serde_json::json!({"options": options, "sourcePageIndex": index,
                "canvasScope": canvas_scope});
            if let Some(prior) = prior {
                request["documentPrior"] = prior.clone();
            }
            run(&frame(
                OP_ANALYZE_PAGE,
                PLANES_RAW,
                &request,
                &[(ATTACHMENT_INPUT, &pages[index])],
            ))
        };
        let first_pass = (0..pages.len())
            .map(|index| analyze(index, None))
            .collect::<Vec<_>>();
        let candidates = first_pass
            .iter()
            .map(|result| {
                serde_json::from_slice::<serde_json::Value>(&result.details).unwrap()
                    ["reconciliation"]
                    .clone()
            })
            .collect::<Vec<_>>();
        let reconciled = run(&frame(
            OP_RECONCILE_DOCUMENT,
            PLANES_RAW,
            &serde_json::json!({"candidates": candidates}),
            &[],
        ));
        let decisions = serde_json::from_slice::<serde_json::Value>(&reconciled.details).unwrap()
            ["pages"]
            .as_array()
            .unwrap()
            .clone();
        let kinds = decisions
            .iter()
            .map(|decision| decision["kind"].as_str().unwrap_or("none").to_owned())
            .collect::<Vec<_>>();
        assert_eq!(kinds, vec!["update"; pages.len()], "{label}");
        for (candidate, decision) in candidates.iter().zip(&decisions) {
            assert!(
                candidate["tier1Confidence"].as_f64().unwrap()
                    >= MANIFEST_RECONCILIATION_POLICY.minimum_confidence
            );
            assert_eq!(decision["classification"], candidate["tier1Verdict"]);
            assert_eq!(decision["cutterX"], candidate["cutterX"]);
        }
        for (index, decision) in decisions.iter().enumerate() {
            let analysis = if decision["kind"] == "rerun" {
                analyze(index, Some(&decision["prior"])).page
            } else {
                first_pass[index].page.clone()
            };
            let mut request = serde_json::json!({});
            if !decision.is_null() {
                request["reconciliation"] = decision.clone();
            }
            if lossless {
                request["pdfPlacement"] = serde_json::json!({"pdfPage": pdf_page, "options": options,
                    "renderMode": render_mode, "documentCanvas": canvas});
            }
            let finished = run(&frame(
                OP_FINISH_PAGE_ANALYSIS,
                PLANES_RAW,
                &request,
                &[(ATTACHMENT_PAGE_METADATA, &analysis)],
            ));
            assert_eq!(
                String::from_utf8_lossy(&finished.page),
                String::from_utf8_lossy(
                    &fs::read(scratch.path(&format!("{label}-page-{index}.json"))).unwrap()
                ),
                "{label} page {index} ({})",
                kinds[index]
            );
        }
    }
}

#[test]
fn a_finished_analysis_must_belong_to_its_reconciliation() {
    let input = fixture(GLYPH_FIXTURE);
    let analysis = run(&frame(
        OP_ANALYZE_PAGE,
        PLANES_RAW,
        &serde_json::json!({"options": options(serde_json::json!({})), "sourcePageIndex": 0, "canvasScope": "page"}),
        &[(ATTACHMENT_INPUT, &input)],
    ))
    .page;
    let prior = serde_json::json!({"dominantLayout": "two-page-spread", "cutterRatioMedian": 0.5,
        "clusterDims": {"widthPx": 880.0, "heightPx": 600.0}, "agreementStrength": 0.8});
    let request = serde_json::json!({"reconciliation": {"kind": "rerun", "prior": prior,
        "tier1": {"verdict": "single-uncut-page", "confidence": 0.4, "candidateCutterRatio": null, "whitespaceScore": 0.1}}});
    let message = error_of(&frame(
        OP_FINISH_PAGE_ANALYSIS,
        PLANES_RAW,
        &request,
        &[(ATTACHMENT_PAGE_METADATA, &analysis)],
    ))
    .message;
    assert!(message.contains("does not belong"), "{message}");
}

#[test]
fn the_input_can_be_its_own_analysis_plane() {
    let input = fixture(GLYPH_FIXTURE);
    let mut request = preview_request(options(serde_json::json!({"matchPageSize": false})));
    request["analysisDpi"] = serde_json::json!(300);
    let separate = run_request(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &request,
        &[(ATTACHMENT_INPUT, &input), (ATTACHMENT_ANALYSIS, &input)],
    ))
    .unwrap();
    request["analysisIsInput"] = serde_json::Value::Bool(true);
    let shared = run_request(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &request,
        &[(ATTACHMENT_INPUT, &input)],
    ))
    .unwrap();
    assert!(separate == shared);
}

fn error_of(request: &[u8]) -> NativeError {
    let error = run_request(request).unwrap_err();
    let error = error.downcast_ref::<NativeError>().expect("a native error");
    NativeError::new(error.code, error.message.clone())
}

#[test]
fn rejects_malformed_frames_and_requests() {
    let input = fixture(GLYPH_FIXTURE);
    let request = preview_request(options(serde_json::json!({"matchPageSize": false})));
    let attachments = [(ATTACHMENT_INPUT, input.as_slice())];
    let valid = frame(OP_RENDER_PAGE, PLANES_ENCODED, &request, &attachments);

    let mut bad_magic = valid.clone();
    bad_magic[0] = b'X';
    assert!(error_of(&bad_magic).message.contains("magic"));
    let mut bad_version = valid.clone();
    bad_version[4] = 9;
    assert!(error_of(&bad_version).message.contains("version"));
    let mut trailing = valid.clone();
    trailing.push(0);
    assert!(error_of(&trailing).message.contains("Trailing"));
    assert!(error_of(&valid[..valid.len() - 1])
        .message
        .contains("Truncated"));
    assert!(error_of(&frame(99, PLANES_ENCODED, &request, &attachments))
        .message
        .contains("operation"));
    assert!(error_of(&frame(OP_RENDER_PAGE, 7, &request, &attachments))
        .message
        .contains("plane encoding"));
    assert!(
        error_of(&frame(OP_RENDER_PAGE, PLANES_ENCODED, &request, &[]))
            .message
            .contains("no input raster")
    );
    assert!(error_of(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &request,
        &[(ATTACHMENT_INPUT, &input), (ATTACHMENT_ANALYSIS, &input)]
    ))
    .message
    .contains("analysisDpi"));
    assert!(error_of(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &request,
        &[(ATTACHMENT_INPUT, &input), (ATTACHMENT_INPUT, &input)]
    ))
    .message
    .contains("repeats"));
    assert!(error_of(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &request,
        &[
            (ATTACHMENT_INPUT, &input),
            (ATTACHMENT_PAGE_METADATA, b"{}")
        ]
    ))
    .message
    .contains("takes no attachment"));
    assert!(error_of(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &request,
        &[
            (ATTACHMENT_INPUT, &input),
            (ATTACHMENT_DETAIL_BASE_SOURCE, &input)
        ]
    ))
    .message
    .contains("detailRenderPlan"));
    assert!(error_of(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &request,
        &[(ATTACHMENT_INPUT, &input), (42, &input)]
    ))
    .message
    .contains("role"));
    assert!(error_of(&frame(
        OP_ANALYZE_PAGE,
        PLANES_ENCODED,
        &request,
        &attachments
    ))
    .message
    .contains("plane encoding"));

    let mut unknown_field = request.clone();
    unknown_field["outputPath"] = serde_json::json!("/tmp/out.png");
    assert_eq!(
        error_of(&frame(
            OP_RENDER_PAGE,
            PLANES_ENCODED,
            &unknown_field,
            &attachments
        ))
        .code,
        NativeErrorCode::InvalidRequest
    );
    let mut matched_without_canvas = request.clone();
    matched_without_canvas["options"]["matchPageSize"] = true.into();
    assert!(error_of(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &matched_without_canvas,
        &attachments
    ))
    .message
    .contains("documentCanvas"));
    let mut few_destinations = request.clone();
    few_destinations["options"]["layout"] = "force-two-page".into();
    few_destinations["outputs"] = serde_json::json!([{}]);
    assert!(error_of(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &few_destinations,
        &attachments
    ))
    .message
    .contains("output destinations"));
    let oversized = preview_request(options(serde_json::json!({"maxPixels": u64::MAX})));
    assert_eq!(
        error_of(&frame(
            OP_RENDER_PAGE,
            PLANES_ENCODED,
            &oversized,
            &attachments
        ))
        .code,
        NativeErrorCode::TooLarge
    );
    let mut long_json = REQUEST_MAGIC.to_vec();
    for value in [
        REQUEST_VERSION,
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        (MAX_REQUEST_JSON_BYTES + 1) as u32,
        0,
    ] {
        long_json.extend_from_slice(&value.to_le_bytes());
    }
    assert_eq!(error_of(&long_json).code, NativeErrorCode::TooLarge);
    assert!(error_of(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &request,
        &[(ATTACHMENT_INPUT, b"not an image")]
    ))
    .message
    .contains("Unable to read scan-cleanup raster for page 1"));
    let mut bad_context = request.clone();
    bad_context["pageInkConsistency"] = serde_json::json!({
        "prior": {"sampleCount": 12, "survivalP10": 0.2, "survivalMedian": 2.0, "survivalP90": 0.9,
            "referenceWidth": 10, "referenceHeight": 10},
        "sourceSample": {"metrics": {"inkFraction": 0.2, "erosionSurvival": 0.5}, "width": 10, "height": 10},
    });
    assert!(error_of(&frame(
        OP_RENDER_PAGE,
        PLANES_ENCODED,
        &bad_context,
        &attachments
    ))
    .message
    .contains("out of range"));
    assert!(error_of(&frame(
        OP_RECONCILE_DOCUMENT,
        PLANES_RAW,
        &serde_json::json!({"candidates": [{"cutterX": null, "tier1Verdict": "two-page-spread",
            "tier1Confidence": 0.9, "candidateCutterRatio": null, "whitespaceScore": 0.5,
            "rotatedWidth": 10, "rotatedHeight": 10, "calibrationStrokeWidthPx": null,
            "calibrationXHeightPx": null, "reconciliationEligible": true, "excluded": false,
            "documentPrior": {"dominantLayout": "two-page-spread", "cutterRatioMedian": 2.0,
                "clusterDims": {"widthPx": 10.0, "heightPx": 10.0}, "agreementStrength": 0.5}}]}),
        &[]
    ))
    .code
    .eq(&NativeErrorCode::InvalidRequest));
    assert!(error_of(&frame(
        OP_FINISH_PAGE_ANALYSIS,
        PLANES_RAW,
        &serde_json::json!({}),
        &[]
    ))
    .message
    .contains("page metadata"));
}

#[test]
fn exports_check_the_live_request_allocation() {
    let input = fixture(GLYPH_FIXTURE);
    let request = frame(
        OP_ANALYZE_PAGE,
        PLANES_RAW,
        &serde_json::json!({"options": options(serde_json::json!({})), "sourcePageIndex": 0, "canvasScope": "page"}),
        &[(ATTACHMENT_INPUT, &input)],
    );
    unsafe {
        assert_eq!(evb_scan_cleanup_run(request.as_ptr(), request.len()), -1);
        let error =
            std::slice::from_raw_parts(evb_scan_cleanup_error_ptr(), evb_scan_cleanup_error_len());
        assert!(String::from_utf8_lossy(error).contains("does not match the live allocation"));

        let pointer = evb_scan_cleanup_alloc(request.len());
        assert!(!pointer.is_null());
        std::ptr::copy_nonoverlapping(request.as_ptr(), pointer, request.len());
        assert_eq!(evb_scan_cleanup_run(pointer, request.len()), 0);
        assert_eq!(evb_scan_cleanup_error_len(), 0);
        let output = std::slice::from_raw_parts(
            evb_scan_cleanup_output_ptr(),
            evb_scan_cleanup_output_len(),
        );
        let result = decode_result(output);
        assert!(
            serde_json::from_slice::<serde_json::Value>(&result.page).unwrap()
                ["layoutClassification"]
                .is_string()
        );
        evb_scan_cleanup_free(pointer, request.len());
    }
}

fn generated() -> String {
    use std::fmt::Write;
    let mut output = String::from(
        "// Generated from the evb-scan-cleanup Rust WASM entry; do not edit.\n\
         // Regenerate with `EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup generated_wasm_typescript`.\n\
         // Numeric frame fields are little-endian u32 values.\n\n",
    );
    writeln!(
        output,
        "export const SCAN_CLEANUP_WASM_REQUEST_MAGIC = '{}';",
        std::str::from_utf8(REQUEST_MAGIC).unwrap()
    )
    .unwrap();
    for (name, value) in [
        ("REQUEST_VERSION", REQUEST_VERSION as usize),
        ("OP_RENDER_PAGE", OP_RENDER_PAGE as usize),
        ("OP_ANALYZE_PAGE", OP_ANALYZE_PAGE as usize),
        ("OP_RECONCILE_DOCUMENT", OP_RECONCILE_DOCUMENT as usize),
        ("OP_FINISH_PAGE_ANALYSIS", OP_FINISH_PAGE_ANALYSIS as usize),
        ("OP_SAMPLE_PAGE_INK", OP_SAMPLE_PAGE_INK as usize),
        ("OP_DERIVE_INK_CONTEXTS", OP_DERIVE_INK_CONTEXTS as usize),
        ("PLANES_RAW", PLANES_RAW as usize),
        ("PLANES_ENCODED", PLANES_ENCODED as usize),
        ("ATTACHMENT_INPUT", ATTACHMENT_INPUT as usize),
        ("ATTACHMENT_ANALYSIS", ATTACHMENT_ANALYSIS as usize),
        (
            "ATTACHMENT_TRUSTED_FOREGROUND_SELECTION",
            ATTACHMENT_TRUSTED_FOREGROUND_SELECTION as usize,
        ),
        (
            "ATTACHMENT_TRUSTED_MRC_BACKGROUND",
            ATTACHMENT_TRUSTED_MRC_BACKGROUND as usize,
        ),
        (
            "ATTACHMENT_DETAIL_BASE_METADATA",
            ATTACHMENT_DETAIL_BASE_METADATA as usize,
        ),
        (
            "ATTACHMENT_DETAIL_BASE_SOURCE",
            ATTACHMENT_DETAIL_BASE_SOURCE as usize,
        ),
        (
            "ATTACHMENT_DETAIL_BASE_CLEANED",
            ATTACHMENT_DETAIL_BASE_CLEANED as usize,
        ),
        (
            "ATTACHMENT_PAGE_METADATA",
            ATTACHMENT_PAGE_METADATA as usize,
        ),
        ("PLANE_ROLE_COMPOSITE", PLANE_ROLE_COMPOSITE as usize),
        ("PLANE_ROLE_BILEVEL", PLANE_ROLE_BILEVEL as usize),
        ("PLANE_ROLE_BACKGROUND", PLANE_ROLE_BACKGROUND as usize),
        (
            "PLANE_ROLE_FOREGROUND_MASK",
            PLANE_ROLE_FOREGROUND_MASK as usize,
        ),
        (
            "PLANE_ROLE_FOREGROUND_ALPHA",
            PLANE_ROLE_FOREGROUND_ALPHA as usize,
        ),
        ("PLANE_ROLE_PICTURE_MASK", PLANE_ROLE_PICTURE_MASK as usize),
        (
            "PLANE_ROLE_TONE_PRESERVATION_ALPHA",
            PLANE_ROLE_TONE_PRESERVATION_ALPHA as usize,
        ),
        ("PLANE_KIND_GRAY8", PLANE_KIND_GRAY8 as usize),
        ("PLANE_KIND_RGB8", PLANE_KIND_RGB8 as usize),
        ("PLANE_KIND_BILEVEL1", PLANE_KIND_BILEVEL1 as usize),
        ("PLANE_ENCODING_RAW", PLANE_ENCODING_RAW as usize),
        ("PLANE_ENCODING_PNG", PLANE_ENCODING_PNG as usize),
        ("PLANE_ENCODING_PBM", PLANE_ENCODING_PBM as usize),
        ("PLANE_ENCODING_PPM", PLANE_ENCODING_PPM as usize),
        ("PLANE_ENCODING_PGM", PLANE_ENCODING_PGM as usize),
        ("REQUEST_HEADER_BYTES", REQUEST_HEADER_BYTES),
        ("ATTACHMENT_HEADER_BYTES", ATTACHMENT_HEADER_BYTES),
        ("RESULT_HEADER_BYTES", RESULT_HEADER_BYTES),
        ("OUTPUT_HEADER_BYTES", OUTPUT_HEADER_BYTES),
        ("PLANE_HEADER_BYTES", PLANE_HEADER_BYTES),
        ("MAX_REQUEST_JSON_BYTES", MAX_REQUEST_JSON_BYTES),
        ("MAX_REQUEST_BYTES", MAX_REQUEST_BYTES),
        ("MAX_OUTPUT_BYTES", MAX_OUTPUT_BYTES),
        ("MAX_DETAIL_METADATA_BYTES", MAX_DETAIL_METADATA_BYTES),
    ] {
        writeln!(output, "export const SCAN_CLEANUP_WASM_{name} = {value};").unwrap();
    }
    output
}

#[test]
fn generated_wasm_typescript_is_current() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/scan-cleanup/browserScanCleanupWasm.generated.ts");
    let current = generated();
    if std::env::var_os("EVB_UPDATE_GENERATED").is_some() {
        fs::write(&path, current).unwrap();
        return;
    }
    let checked_in = fs::read_to_string(&path).unwrap_or_default();
    assert!(
        checked_in == current,
        "{} is stale; regenerate it with EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup generated_wasm_typescript",
        path.display()
    );
}
