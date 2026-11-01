use super::*;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const GLYPH_FIXTURE: &str = "tests/fixtures/glyphs/bedjan-p2-speckles-input.png";

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
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(path: &str) -> Vec<u8> {
    fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

fn frame(
    operation: u32,
    plane_encoding: u32,
    json: &serde_json::Value,
    input: &[u8],
    analysis: &[u8],
) -> Vec<u8> {
    let json = serde_json::to_vec(json).unwrap();
    let mut bytes = REQUEST_MAGIC.to_vec();
    for value in [
        REQUEST_VERSION,
        operation,
        plane_encoding,
        json.len() as u32,
        input.len() as u32,
        analysis.len() as u32,
    ] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&json);
    bytes.extend_from_slice(input);
    bytes.extend_from_slice(analysis);
    assert_eq!(
        bytes.len(),
        REQUEST_HEADER_BYTES + json.len() + input.len() + analysis.len()
    );
    bytes
}

struct DecodedOutput {
    metadata: Vec<u8>,
    kind: u32,
    encoding: u32,
    width: u32,
    height: u32,
    data: Vec<u8>,
}

fn decode_result(bytes: &[u8]) -> (Vec<u8>, Vec<DecodedOutput>) {
    let mut offset = 0;
    let page_len = read_len(bytes, &mut offset).unwrap();
    let count = read_len(bytes, &mut offset).unwrap();
    let page = take(bytes, &mut offset, page_len).unwrap().to_vec();
    let mut outputs = Vec::new();
    for _ in 0..count {
        let metadata_len = read_len(bytes, &mut offset).unwrap();
        let kind = read_u32(bytes, &mut offset).unwrap();
        let encoding = read_u32(bytes, &mut offset).unwrap();
        let width = read_u32(bytes, &mut offset).unwrap();
        let height = read_u32(bytes, &mut offset).unwrap();
        let data_len = read_len(bytes, &mut offset).unwrap();
        outputs.push(DecodedOutput {
            metadata: take(bytes, &mut offset, metadata_len).unwrap().to_vec(),
            kind,
            encoding,
            width,
            height,
            data: take(bytes, &mut offset, data_len).unwrap().to_vec(),
        });
    }
    assert_eq!(offset, bytes.len(), "result frame has trailing bytes");
    (page, outputs)
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

fn render_request(options: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "options": options,
        "sourcePageIndex": 0,
        "canvasScope": "page",
    })
}

fn run_direct_cli(input: &[u8], options: &serde_json::Value, ocr_mode: bool) -> (Vec<u8>, Vec<u8>) {
    let scratch = Scratch::new("direct");
    let input_path = scratch.path("input.png");
    let output_path = scratch.path("output.png");
    let metadata_path = scratch.path("output.json");
    fs::write(&input_path, input).unwrap();
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
        let result = run_request(&frame(
            OP_RENDER_PREVIEW,
            PLANE_ENCODING_PNG,
            &render_request(wasm_options),
            &input,
            &[],
        ))
        .unwrap();
        let (page, outputs) = decode_result(&result);
        assert_eq!(outputs.len(), 1, "{label}");
        assert_eq!(outputs[0].encoding, PLANE_ENCODING_PNG, "{label}");
        assert!(
            outputs[0].data == cli_png,
            "{label}: PNG bytes differ from the CLI"
        );
        assert_eq!(
            String::from_utf8(outputs[0].metadata.clone()).unwrap(),
            String::from_utf8(cli_metadata).unwrap(),
            "{label}: metadata differs from the CLI"
        );
        let page: serde_json::Value = serde_json::from_slice(&page).unwrap();
        assert_eq!(page["outputCount"], 1, "{label}");
        assert_eq!(page["canvasScope"], "page", "{label}");
    }
}

#[test]
fn raw_planes_carry_the_png_planes_pixels() {
    let input = fixture(GLYPH_FIXTURE);
    let request = render_request(options(
        serde_json::json!({"outputMode": "color", "layout": "force-single", "matchPageSize": false}),
    ));
    let (_, png_outputs) = decode_result(
        &run_request(&frame(
            OP_RENDER_PREVIEW,
            PLANE_ENCODING_PNG,
            &request,
            &input,
            &[],
        ))
        .unwrap(),
    );
    let (_, raw_outputs) = decode_result(
        &run_request(&frame(
            OP_RENDER_PREVIEW,
            PLANE_ENCODING_RAW,
            &request,
            &input,
            &[],
        ))
        .unwrap(),
    );
    let (png, raw) = (&png_outputs[0], &raw_outputs[0]);
    assert_eq!(raw.kind, PLANE_KIND_RGB8);
    assert_eq!((raw.width, raw.height), (png.width, png.height));
    assert_eq!(raw.metadata, png.metadata);
    let decoded = raster::decode_image_bytes(&png.data, u64::MAX, u32::MAX).unwrap();
    assert_eq!(decoded.rgb.data(), raw.data.as_slice());
}

#[test]
fn analyze_matches_a_single_page_analyze_manifest() {
    let input = fixture(GLYPH_FIXTURE);
    let scratch = Scratch::new("analyze");
    let input_path = scratch.path("input.png");
    let metadata_path = scratch.path("page.json");
    let manifest_path = scratch.path("manifest.json");
    fs::write(&input_path, &input).unwrap();
    let options = options(serde_json::json!({"outputMode": "auto"}));
    fs::write(
        &manifest_path,
        serde_json::to_vec(&serde_json::json!({
            "version": 3,
            "operation": "analyze",
            "renderMode": "preview",
            "canvasScope": "page",
            "pages": [{
                "inputPath": input_path,
                "sourcePageIndex": 0,
                "pageMetadataPath": metadata_path,
                "options": options,
                "outputs": [],
            }],
        }))
        .unwrap(),
    )
    .unwrap();
    crate::adapters::batch_cli::run(["--manifest".to_owned(), manifest_path.display().to_string()])
        .unwrap();
    let result = run_request(&frame(
        OP_ANALYZE,
        PLANE_ENCODING_RAW,
        &serde_json::json!({"options": options, "sourcePageIndex": 0, "canvasScope": "page"}),
        &input,
        &[],
    ))
    .unwrap();
    let (page, outputs) = decode_result(&result);
    assert!(outputs.is_empty());
    assert_eq!(
        String::from_utf8(page).unwrap(),
        String::from_utf8(fs::read(metadata_path).unwrap()).unwrap()
    );
}

#[test]
fn the_input_can_be_its_own_analysis_plane() {
    let input = fixture(GLYPH_FIXTURE);
    let mut request = render_request(options(serde_json::json!({"matchPageSize": false})));
    request["analysisDpi"] = serde_json::json!(300);
    let separate = run_request(&frame(
        OP_RENDER_PREVIEW,
        PLANE_ENCODING_PNG,
        &request,
        &input,
        &input,
    ))
    .unwrap();
    request["analysisIsInput"] = serde_json::Value::Bool(true);
    let shared = run_request(&frame(
        OP_RENDER_PREVIEW,
        PLANE_ENCODING_PNG,
        &request,
        &input,
        &[],
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
    let request = render_request(options(serde_json::json!({"matchPageSize": false})));
    let valid = frame(OP_RENDER_PREVIEW, PLANE_ENCODING_PNG, &request, &input, &[]);

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
    assert!(
        error_of(&frame(99, PLANE_ENCODING_PNG, &request, &input, &[]))
            .message
            .contains("operation")
    );
    assert!(
        error_of(&frame(OP_RENDER_PREVIEW, 7, &request, &input, &[]))
            .message
            .contains("plane encoding")
    );
    assert!(error_of(&frame(
        OP_RENDER_PREVIEW,
        PLANE_ENCODING_PNG,
        &request,
        &[],
        &[]
    ))
    .message
    .contains("no input raster"));
    assert!(error_of(&frame(
        OP_RENDER_PREVIEW,
        PLANE_ENCODING_PNG,
        &request,
        &input,
        &input
    ))
    .message
    .contains("analysisDpi"));

    let mut unknown_field = request.clone();
    unknown_field["outputPath"] = serde_json::json!("/tmp/out.png");
    assert_eq!(
        error_of(&frame(
            OP_RENDER_PREVIEW,
            PLANE_ENCODING_PNG,
            &unknown_field,
            &input,
            &[]
        ))
        .code,
        NativeErrorCode::InvalidRequest
    );
    let oversized = render_request(options(serde_json::json!({"maxPixels": u64::MAX})));
    assert_eq!(
        error_of(&frame(
            OP_RENDER_PREVIEW,
            PLANE_ENCODING_PNG,
            &oversized,
            &input,
            &[]
        ))
        .code,
        NativeErrorCode::TooLarge
    );
    let mut long_json = REQUEST_MAGIC.to_vec();
    for value in [
        REQUEST_VERSION,
        OP_RENDER_PREVIEW,
        PLANE_ENCODING_PNG,
        (MAX_REQUEST_JSON_BYTES + 1) as u32,
        0,
        0,
    ] {
        long_json.extend_from_slice(&value.to_le_bytes());
    }
    assert_eq!(error_of(&long_json).code, NativeErrorCode::TooLarge);
    assert!(error_of(&frame(
        OP_RENDER_PREVIEW,
        PLANE_ENCODING_PNG,
        &request,
        b"not an image",
        &[]
    ))
    .message
    .contains("Unable to read scan-cleanup raster for page 1"));
}

#[test]
fn exports_check_the_live_request_allocation() {
    let input = fixture(GLYPH_FIXTURE);
    let request = frame(
        OP_ANALYZE,
        PLANE_ENCODING_RAW,
        &serde_json::json!({"options": options(serde_json::json!({})), "sourcePageIndex": 0, "canvasScope": "page"}),
        &input,
        &[],
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
        let (page, _) = decode_result(output);
        assert!(serde_json::from_slice::<serde_json::Value>(&page).unwrap()
            ["layoutClassification"]
            .is_string());
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
        (
            "SCAN_CLEANUP_WASM_REQUEST_VERSION",
            REQUEST_VERSION as usize,
        ),
        (
            "SCAN_CLEANUP_WASM_OP_RENDER_PREVIEW",
            OP_RENDER_PREVIEW as usize,
        ),
        ("SCAN_CLEANUP_WASM_OP_ANALYZE", OP_ANALYZE as usize),
        (
            "SCAN_CLEANUP_WASM_PLANE_ENCODING_RAW",
            PLANE_ENCODING_RAW as usize,
        ),
        (
            "SCAN_CLEANUP_WASM_PLANE_ENCODING_PNG",
            PLANE_ENCODING_PNG as usize,
        ),
        (
            "SCAN_CLEANUP_WASM_PLANE_KIND_GRAY8",
            PLANE_KIND_GRAY8 as usize,
        ),
        (
            "SCAN_CLEANUP_WASM_PLANE_KIND_RGB8",
            PLANE_KIND_RGB8 as usize,
        ),
        (
            "SCAN_CLEANUP_WASM_REQUEST_HEADER_BYTES",
            REQUEST_HEADER_BYTES,
        ),
        ("SCAN_CLEANUP_WASM_RESULT_HEADER_BYTES", RESULT_HEADER_BYTES),
        ("SCAN_CLEANUP_WASM_OUTPUT_HEADER_BYTES", OUTPUT_HEADER_BYTES),
        (
            "SCAN_CLEANUP_WASM_MAX_REQUEST_JSON_BYTES",
            MAX_REQUEST_JSON_BYTES,
        ),
        ("SCAN_CLEANUP_WASM_MAX_REQUEST_BYTES", MAX_REQUEST_BYTES),
        ("SCAN_CLEANUP_WASM_MAX_OUTPUT_BYTES", MAX_OUTPUT_BYTES),
    ] {
        writeln!(output, "export const {name} = {value};").unwrap();
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
