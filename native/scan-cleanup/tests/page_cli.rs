use evb_raster_io::{decode_ppm, DecodeLimits};
use evb_scan_cleanup::{
    io::pbm::decode_p4,
    png::{decode_gray, encode_gray, encode_rgb, RgbImage},
    BinarizationMode, CleanupOptions, LayoutMode, ManualContentBoxes, ManualZones, MarginsMm,
    NormalizedRect, NormalizedZonePoint, NormalizedZonePolygon, OrthogonalRotation, OutputMode,
    PictureZone, PictureZoneLayer,
};
use scan_primitives::GrayImage;
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new(test: &str) -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-page-cli-{test}-{}-{nonce}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Matched page size is on by default, and it now requires the document canvas
/// its owner measured. A test that is not about matching says so.
fn unmatched_options() -> CleanupOptions {
    CleanupOptions {
        match_page_size: false,
        ..CleanupOptions::default()
    }
}

fn assert_native_canvas_owns_image(metadata: &Value) {
    assert!(
        metadata["pdfImagePlacement"].is_null(),
        "native canvas materialization must clear the legacy placement record: {metadata}"
    );
    let canvas_width = metadata["canvasWidthPx"].as_u64().unwrap();
    let canvas_height = metadata["canvasHeightPx"].as_u64().unwrap();
    let content_width = metadata["matchedCanvasContentWidthPx"]
        .as_u64()
        .unwrap_or_else(|| metadata["outputWidthPx"].as_u64().unwrap());
    let content_height = metadata["matchedCanvasContentHeightPx"]
        .as_u64()
        .unwrap_or_else(|| metadata["outputHeightPx"].as_u64().unwrap());
    let offset_x = metadata["placementOffsetXPx"].as_u64().unwrap();
    let offset_y = metadata["placementOffsetYPx"].as_u64().unwrap();
    let recorded_overflow_left = metadata["matchedCanvasIntrinsicOverflowLeftPx"]
        .as_u64()
        .unwrap_or(0);
    let recorded_overflow_right = metadata["matchedCanvasIntrinsicOverflowRightPx"]
        .as_u64()
        .unwrap_or(0);
    let recorded_overflow_top = metadata["matchedCanvasIntrinsicOverflowTopPx"]
        .as_u64()
        .unwrap_or(0);
    assert!(
        recorded_overflow_left <= content_width,
        "native canvas source overhang exceeds its content width: {metadata}"
    );
    let effective_offset_x = offset_x as i64 - recorded_overflow_left as i64;
    let actual_overflow_right =
        (effective_offset_x + content_width as i64 - canvas_width as i64).max(0) as u64;
    assert_eq!(
        actual_overflow_right, recorded_overflow_right,
        "native canvas must record the complete raster overhang: {metadata}"
    );
    let effective_offset_y = offset_y as i64 - recorded_overflow_top as i64;
    assert_eq!(
        (-effective_offset_y).max(0) as u64,
        recorded_overflow_top,
        "native canvas must record the complete top overhang: {metadata}"
    );
    assert!(
        effective_offset_y < canvas_height as i64
            && effective_offset_y + content_height as i64 > 0
            && effective_offset_y + content_height as i64 <= canvas_height as i64,
        "native canvas vertical geometry must intersect and stay bounded by its canvas: {metadata}"
    );
    if metadata["matchedCanvasOpticalPlacement"] == Value::Bool(true) {
        let intrinsic_width = metadata["intrinsicRasterWidthPx"]
            .as_u64()
            .unwrap_or_else(|| metadata["outputWidthPx"].as_u64().unwrap());
        let optical_left = metadata["matchedCanvasOpticalContentLeftPx"]
            .as_f64()
            .unwrap();
        let optical_right = metadata["matchedCanvasOpticalContentRightPx"]
            .as_f64()
            .unwrap();
        let scale = content_width as f64 / intrinsic_width.max(1) as f64;
        let margins = metadata["softMarginsPx"].as_array().unwrap();
        let margin_left = margins[0].as_u64().unwrap();
        let margin_right = margins[2].as_u64().unwrap();
        assert!(
            effective_offset_x as f64 + optical_left * scale >= margin_left as f64 - 1e-6,
            "native optical left bound escaped its margin: {metadata}"
        );
        assert!(
            effective_offset_x as f64 + optical_right * scale
                <= canvas_width.saturating_sub(margin_right) as f64 + 1e-6,
            "native optical right bound escaped its margin: {metadata}"
        );
    } else {
        assert!(
            offset_x + content_width <= canvas_width + recorded_overflow_right,
            "native canvas content geometry exceeds its canvas: {metadata}"
        );
    }
}

#[test]
#[ignore = "real fixture corpus runs in the native CI corpus lane"]
fn real_gray_flyleaf_is_white_and_consistent_in_preview_and_final_cli_renders() {
    let scratch = Scratch::new("gray-flyleaf");
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/blank");
    let cases = [
        (
            1,
            "preview",
            150.0,
            "rome-flyleaf-p00002-150dpi.png",
            (884, 1335),
        ),
        (
            1,
            "final",
            360.0,
            "rome-flyleaf-p00002-360dpi.png",
            (2120, 3202),
        ),
        (
            2,
            "preview",
            150.0,
            "rome-flyleaf-p00003-150dpi.png",
            (884, 1335),
        ),
        (
            2,
            "final",
            360.0,
            "rome-flyleaf-p00003-360dpi.png",
            (2120, 3202),
        ),
        (
            3,
            "preview",
            150.0,
            "rome-flyleaf-p00004-150dpi.png",
            (884, 1335),
        ),
        (
            3,
            "final",
            360.0,
            "rome-flyleaf-p00004-360dpi.png",
            (2120, 3202),
        ),
    ];

    for (source_page_index, render_mode, dpi, fixture, expected_dimensions) in cases {
        let case_name = format!("p{}-{render_mode}", source_page_index + 1);
        let output = scratch.path(&format!("flyleaf-{case_name}.png"));
        let metadata = scratch.path(&format!("flyleaf-{case_name}.json"));
        let page_metadata = scratch.path(&format!("flyleaf-{case_name}-page.json"));
        let manifest = scratch.path(&format!("flyleaf-{case_name}-manifest.json"));
        let options = CleanupOptions {
            dpi,
            source_dpi: Some(360.0),
            requested_render_dpi: Some(dpi),
            output_mode: OutputMode::Bw,
            layout: LayoutMode::Single,
            normalize_illumination: true,
            crop_content: true,
            match_page_size: false,
            ..CleanupOptions::default()
        };
        let payload = serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": render_mode,
            "canvasScope": if render_mode == "preview" { "page" } else { "document" },
            "pages": [{
                "inputPath": fixtures.join(fixture),
                "sourcePageIndex": source_page_index,
                "pageMetadataPath": page_metadata,
                "options": options,
                "outputs": [{
                    "outputPath": output,
                    "metadataPath": metadata,
                }],
            }],
        });
        fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

        let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{render_mode} stdout={}\nstderr={}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        );
        let cleaned = decode_gray(&fs::read(&output).unwrap(), 8_000_000, 4_000).unwrap();
        assert_eq!(
            (cleaned.width(), cleaned.height()),
            expected_dimensions,
            "{render_mode} changed the intrinsic blank-page geometry",
        );
        assert!(
            cleaned.data().iter().all(|&value| value == 255),
            "{render_mode} amplified gray paper texture into artificial ink",
        );
        let cleanup_metadata: Value =
            serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
        assert_eq!(cleanup_metadata["sourcePageIndex"], source_page_index);
        assert_eq!(cleanup_metadata["outputMode"], "bw");
        assert!(cleanup_metadata["contentBox"].is_null());
        assert!(cleanup_metadata["binarizationMode"].is_null());
    }
}

#[test]
#[ignore = "real fixture corpus runs in the native CI corpus lane"]
fn real_gray_flyleaf_stays_white_when_auto_was_pre_resolved_to_grayscale() {
    let scratch = Scratch::new("gray-flyleaf-resolved-grayscale");
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/blank");
    let cases = [
        ("preview", 150.0, "rome-flyleaf-p00002-150dpi.png"),
        ("preview", 150.0, "rome-flyleaf-p00003-150dpi.png"),
        ("preview", 150.0, "rome-flyleaf-p00004-150dpi.png"),
        ("final", 360.0, "rome-flyleaf-p00002-360dpi.png"),
        ("final", 360.0, "rome-flyleaf-p00003-360dpi.png"),
        ("final", 360.0, "rome-flyleaf-p00004-360dpi.png"),
    ];

    for (index, (render_mode, dpi, fixture)) in cases.into_iter().enumerate() {
        let output = scratch.path(&format!("flyleaf-{index}.png"));
        let metadata = scratch.path(&format!("flyleaf-{index}.json"));
        let page_metadata = scratch.path(&format!("flyleaf-{index}-page.json"));
        let manifest = scratch.path(&format!("flyleaf-{index}-manifest.json"));
        let options = CleanupOptions {
            dpi,
            source_dpi: Some(360.0),
            requested_render_dpi: Some(dpi),
            // This reproduces the application path: detection may recommend
            // grayscale before the final renderer sees the page.
            output_mode: OutputMode::Grayscale,
            layout: LayoutMode::Single,
            normalize_illumination: true,
            crop_content: true,
            match_page_size: false,
            ..CleanupOptions::default()
        };
        let payload = serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": render_mode,
            "canvasScope": if render_mode == "preview" { "page" } else { "document" },
            "pages": [{
                "inputPath": fixtures.join(fixture),
                "sourcePageIndex": index % 3 + 1,
                "pageMetadataPath": page_metadata,
                "options": options,
                "outputs": [{
                    "outputPath": output,
                    "metadataPath": metadata,
                }],
            }],
        });
        fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

        let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{render_mode} stdout={}\nstderr={}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        );
        let cleaned = decode_gray(&fs::read(&output).unwrap(), 8_000_000, 4_000).unwrap();
        assert!(
            cleaned.data().iter().all(|&value| value == 255),
            "{render_mode} grayscale output amplified {fixture} into false content",
        );
        let cleanup_metadata: Value =
            serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
        assert_eq!(cleanup_metadata["outputMode"], "grayscale");
        assert!(cleanup_metadata["contentBox"].is_null());
    }
}

#[test]
fn manifest_v3_emits_typed_progress_and_terminal_result() {
    let scratch = Scratch::new("v3");
    let input = scratch.path("v3-input.png");
    let page_metadata = scratch.path("v3-page.json");
    let manifest = scratch.path("v3-manifest.json");
    fs::write(&input, encode_gray(&GrayImage::new(80, 60, 255)).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "analyze",
        "renderMode": "preview",
        "canvasScope": "page",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": CleanupOptions::default(),
            "outputs": [],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!String::from_utf8_lossy(&result.stderr).contains("DEPRECATED"));
    let envelopes = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(envelopes.first().unwrap()["type"], "progress");
    assert_eq!(envelopes.first().unwrap()["progress"]["stage"], "started");
    assert_eq!(envelopes.last().unwrap()["type"], "result");
    assert_eq!(envelopes.last().unwrap()["result"]["status"], "success");
    assert!(page_metadata.exists());

    #[cfg(unix)]
    {
        let mut closed_stdout = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        drop(closed_stdout.stdout.take());
        let output = closed_stdout.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(130));
        assert!(
            output.stderr.is_empty(),
            "closed stdout must not report a panic: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn multi_page_analysis_reports_progress_before_reconciliation_completes() {
    let scratch = Scratch::new("progress-order");
    let inputs = [
        scratch.path("analysis-progress-input-1.png"),
        scratch.path("analysis-progress-input-2.png"),
    ];
    let manifest = scratch.path("analysis-progress-manifest.json");
    let metadata_paths = [
        scratch.path("analysis-progress-page-1.json"),
        scratch.path("analysis-progress-page-2.json"),
    ];
    let encoded = encode_gray(&GrayImage::new(320, 240, 245)).unwrap();
    for input in &inputs {
        fs::write(input, &encoded).unwrap();
    }
    let payload = serde_json::json!({
        "version": 3,
        "operation": "analyze",
        "renderMode": "preview",
        "canvasScope": "page",
        "pages": inputs
            .iter()
            .enumerate()
            .map(|(index, input)| serde_json::json!({
                "inputPath": input,
                "sourcePageIndex": index,
                "pageMetadataPath": metadata_paths[index],
                "options": CleanupOptions::default(),
                "outputs": [],
            }))
            .collect::<Vec<_>>(),
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let events = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let analyzed_indices = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            (event["progress"]["stage"] == "page-analyzed").then_some(index)
        })
        .collect::<Vec<_>>();
    let complete_indices = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            (event["progress"]["stage"] == "page-complete").then_some(index)
        })
        .collect::<Vec<_>>();
    assert_eq!(analyzed_indices.len(), inputs.len());
    assert_eq!(complete_indices.len(), inputs.len());
    assert!(
        analyzed_indices
            .iter()
            .all(|index| *index < complete_indices[0]),
        "all provisional analysis events must precede reconciliation: {events:?}"
    );
    let first_analyzed = &events[analyzed_indices[0]]["progress"];
    assert_eq!(first_analyzed["completedPages"], 1);
    assert_eq!(first_analyzed["pageNumber"], 1);
    assert_eq!(first_analyzed["classification"], "single-uncut-page");
    assert!(first_analyzed["confidence"].is_number());
}

#[test]
fn final_manifest_writes_pbm_only_for_binary_outputs_and_marks_metadata() {
    let scratch = Scratch::new("bilevel");
    let input = scratch.path("bilevel-input.png");
    let manifest = scratch.path("bilevel-manifest.json");
    let bw_output = scratch.path("bilevel-bw.png");
    let bw_metadata = scratch.path("bilevel-bw.json");
    let bw_pbm = scratch.path("bilevel-bw.pbm");
    let gray_output = scratch.path("bilevel-gray.png");
    let gray_metadata = scratch.path("bilevel-gray.json");
    let gray_pbm = scratch.path("bilevel-gray.pbm");
    let bw_page_metadata = scratch.path("bilevel-bw-page.json");
    let gray_page_metadata = scratch.path("bilevel-gray-page.json");
    fs::write(&input, encode_gray(&GrayImage::new(80, 60, 255)).unwrap()).unwrap();
    let grayscale_options = CleanupOptions {
        output_mode: evb_scan_cleanup::OutputMode::Grayscale,
        ..unmatched_options()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [
            {
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": bw_page_metadata,
                "options": unmatched_options(),
                "outputs": [{
                    "outputPath": bw_output,
                    "metadataPath": bw_metadata,
                    "bilevelOutputPath": bw_pbm,
                }],
            },
            {
                "inputPath": input,
                "sourcePageIndex": 1,
                "pageMetadataPath": gray_page_metadata,
                "options": grayscale_options,
                "outputs": [{
                    "outputPath": gray_output,
                    "metadataPath": gray_metadata,
                    "bilevelOutputPath": gray_pbm,
                }],
            },
        ],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let progress = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(
        !progress
            .iter()
            .any(|event| event["progress"]["stage"] == "page-analyzed"),
        "a final render must not run a separate classification pass"
    );
    assert_eq!(
        progress
            .iter()
            .filter(|event| event["progress"]["stage"] == "page-complete")
            .count(),
        2
    );
    assert!(progress
        .iter()
        .filter(|event| event["progress"]["stage"] == "page-complete")
        .all(|event| event["progress"]["recommendedOutputMode"].is_null()));
    for page_metadata in [&bw_page_metadata, &gray_page_metadata] {
        let page: Value = serde_json::from_slice(&fs::read(page_metadata).unwrap()).unwrap();
        assert!(page["recommendedOutputMode"].is_null());
    }
    assert!(fs::read(&bw_pbm).unwrap().starts_with(b"P4\n"));
    assert!(
        !bw_output.exists(),
        "a published PBM must not be shadowed by a full-resolution composite"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&bw_metadata).unwrap()).unwrap()
            ["bilevelWritten"],
        true
    );
    assert!(gray_output.exists());
    assert!(!gray_pbm.exists());
    assert!(
        serde_json::from_slice::<Value>(&fs::read(&gray_metadata).unwrap())
            .unwrap()
            .get("bilevelWritten")
            .is_none()
    );
}

#[test]
fn final_mixed_manifest_writes_inpainted_background_and_native_resolution_foreground() {
    let scratch = Scratch::new("mixed-layers");
    let input = scratch.path("mixed-input.png");
    let output = scratch.path("mixed-output.png");
    let output_metadata = scratch.path("mixed-output.json");
    let page_metadata = scratch.path("mixed-page.json");
    let bilevel_output = scratch.path("mixed-bilevel.pbm");
    let background_output = scratch.path("mixed-background.ppm");
    let foreground_mask_output = scratch.path("mixed-mask.pbm");
    let foreground_alpha_output = scratch.path("mixed-alpha.pgm");
    let manifest = scratch.path("mixed-manifest.json");
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
    fs::write(&input, encode_rgb(&image).unwrap()).unwrap();
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        layout: LayoutMode::Single,
        normalize_illumination: false,
        crop_content: true,
        match_page_size: true,
        page_alignment: evb_scan_cleanup::PageAlignment::Center,
        margins_mm: Some(evb_scan_cleanup::MarginsMm {
            left_mm: 0.0,
            top_mm: 0.0,
            right_mm: 0.0,
            bottom_mm: 0.0,
        }),
        automatic_content_boxes: evb_scan_cleanup::ManualContentBoxes {
            full: Some(evb_scan_cleanup::NormalizedRect {
                x: 0.0,
                y: 10.0 / 120.0,
                width: 170.0 / 180.0,
                height: 100.0 / 120.0,
                rotation: OrthogonalRotation::None,
            }),
            ..evb_scan_cleanup::ManualContentBoxes::default()
        },
        dpi: 600.0,
        source_dpi: Some(300.0),
        manual_zones: ManualZones {
            picture: vec![PictureZone {
                polygon: NormalizedZonePolygon {
                    points: vec![
                        NormalizedZonePoint { x: 0.5, y: 0.15 },
                        NormalizedZonePoint { x: 0.96, y: 0.15 },
                        NormalizedZonePoint { x: 0.96, y: 0.85 },
                        NormalizedZonePoint { x: 0.5, y: 0.85 },
                    ],
                    rotation: OrthogonalRotation::None,
                },
                layer: PictureZoneLayer::Painter2,
            }],
            fill: vec![],
        },
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 21.6,
            "heightPoints": 14.4,
            "widthPx": 180,
            "heightPx": 120
        },
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": output,
                "metadataPath": output_metadata,
                "bilevelOutputPath": bilevel_output,
                "backgroundOutputPath": background_output,
                "foregroundMaskOutputPath": foreground_mask_output,
                "foregroundAlphaOutputPath": foreground_alpha_output,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let metadata: Value = serde_json::from_slice(&fs::read(&output_metadata).unwrap()).unwrap();
    assert_eq!(metadata["layeredWritten"], true);
    // Final layered handoffs publish a compact 1-bit stencil: an 8-bit
    // alpha plane would defeat the JBIG2 foreground representation. Soft
    // alpha remains a preview/composite feature.
    assert_eq!(metadata["layeredForegroundKind"], "stencil");
    assert_eq!(metadata["layeredBackgroundDpi"], 300.0);
    assert_eq!(metadata["matchedCanvasContentWidthPx"], 170);
    assert_eq!(metadata["matchedCanvasContentHeightPx"], 100);
    assert_eq!(metadata["placementOffsetXPx"], 5);
    assert_eq!(metadata["placementOffsetYPx"], 10);
    // A fresh stencil lives on the rendered page grid; it carries no
    // separate foreground DPI (that was soft-alpha metadata).
    assert!(metadata["layeredForegroundDpi"].is_null());
    assert!(
        !output.exists(),
        "a published layer pair must not be shadowed by a full-resolution composite"
    );
    assert!(!bilevel_output.exists());
    assert!(!foreground_alpha_output.exists());
    let mask = fs::read(&foreground_mask_output).unwrap();
    let mask_header = b"P4\n180 120\n";
    assert!(
        mask.starts_with(mask_header),
        "unexpected mask header: {:?}",
        String::from_utf8_lossy(&mask[..mask.len().min(16)])
    );
    let mask_bits = &mask[mask_header.len()..];
    let set_bits: u32 = mask_bits.iter().map(|byte| byte.count_ones()).sum();
    assert!(
        set_bits > 40,
        "dark text did not reach the published stencil, set bits = {set_bits}"
    );
    let background = decode_ppm(
        fs::read(&background_output).unwrap().as_slice(),
        DecodeLimits {
            max_pixels: 180 * 120,
            max_dimension: 200,
            max_compressed_bytes: 180 * 120 * 3 + 64,
        },
    )
    .unwrap();
    assert_eq!(
        (background.gray.width(), background.gray.height()),
        (90, 60)
    );
    assert!(
        background.gray.get(10, 7) >= 240,
        "foreground ink leaked into the downsampled JPEG background source"
    );
    let picture = background.rgb.get(64, 30);
    assert!(
        picture[0] != picture[1] || picture[1] != picture[2],
        "color plate chroma was lost from the mixed background: {picture:?}"
    );
}

#[test]
fn normalized_mixed_picture_does_not_pull_the_paper_surface_through_a_dark_photo() {
    let scratch = Scratch::new("normalized-picture-surface");
    let input = scratch.path("input.png");
    let output = scratch.path("output.png");
    let output_metadata = scratch.path("output.json");
    let page_metadata = scratch.path("page.json");
    let background_output = scratch.path("background.ppm");
    let foreground_mask_output = scratch.path("foreground.pbm");
    let manifest = scratch.path("manifest.json");
    let mut image = RgbImage::new(180, 120, [214; 3]);
    for y in 0..image.height() {
        for x in 0..image.width() {
            let paper = 214 + x * 16 / (image.width() - 1);
            image.set(x, y, [paper as u8, paper as u8, paper as u8]);
        }
    }
    for y in 30..90 {
        for x in 64..116 {
            let tone = if y < 60 {
                36 + ((x * 7 + y * 11) % 24) as u8
            } else {
                190 + ((x * 5 + y * 3) % 18) as u8
            };
            image.set(x, y, [tone, tone, tone]);
        }
    }
    fs::write(&input, encode_rgb(&image).unwrap()).unwrap();
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        layout: LayoutMode::Single,
        normalize_illumination: true,
        crop_content: false,
        match_page_size: false,
        dpi: 300.0,
        source_dpi: Some(300.0),
        manual_zones: ManualZones {
            picture: vec![PictureZone {
                polygon: NormalizedZonePolygon {
                    points: vec![
                        NormalizedZonePoint { x: 0.35, y: 0.25 },
                        NormalizedZonePoint { x: 0.65, y: 0.25 },
                        NormalizedZonePoint { x: 0.65, y: 0.75 },
                        NormalizedZonePoint { x: 0.35, y: 0.75 },
                    ],
                    rotation: OrthogonalRotation::None,
                },
                layer: PictureZoneLayer::Painter2,
            }],
            fill: vec![],
        },
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": output,
                "metadataPath": output_metadata,
                "backgroundOutputPath": background_output,
                "foregroundMaskOutputPath": foreground_mask_output,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let background = decode_ppm(
        fs::read(&background_output).unwrap().as_slice(),
        DecodeLimits {
            max_pixels: 180 * 120,
            max_dimension: 200,
            max_compressed_bytes: 180 * 120 * 3 + 64,
        },
    )
    .unwrap();
    let dark_photo = background.gray.get(80, 45);
    let light_photo = background.gray.get(80, 75);
    let paper = background.gray.get(20, 30);
    let outside_picture = background.gray.get(55, 60);
    assert!(
        dark_photo < 120,
        "dark photo tone was brightened: {dark_photo}"
    );
    assert!(
        light_photo <= 250,
        "light photo tone was driven to white: {light_photo}"
    );
    assert!(paper >= 245, "paper was not normalized: {paper}");
    assert!(
        outside_picture.abs_diff(paper) <= 8,
        "paper endpoint changed beside the picture: outside={outside_picture}, paper={paper}"
    );
}

#[test]
fn confirmed_mixed_photo_keeps_pale_interior_tone_near_a_caption() {
    let scratch = Scratch::new("confirmed-photo-tone");
    let input = scratch.path("input.png");
    let output = scratch.path("output.png");
    let output_metadata = scratch.path("output.json");
    let page_metadata = scratch.path("page.json");
    let background_output = scratch.path("background.ppm");
    let foreground_mask_output = scratch.path("foreground.pbm");
    let picture_mask_output = scratch.path("picture-mask.pbm");
    let manifest = scratch.path("manifest.json");
    let mut image = RgbImage::new(180, 120, [245; 3]);
    for y in 24..94 {
        for x in 96..168 {
            let tone = 150 + ((x * 7 + y * 11) % 40) as u8;
            image.set(
                x,
                y,
                [tone, tone.saturating_add(20), tone.saturating_add(40)],
            );
        }
    }
    // A nearby caption used to trigger the broad stencil-adjacency ramp and
    // wash pale picture pixels even though the caption is outside the photo.
    for y in 60..63 {
        for x in 20..56 {
            image.set(x, y, [18; 3]);
        }
    }
    fs::write(&input, encode_rgb(&image).unwrap()).unwrap();
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        layout: LayoutMode::Single,
        normalize_illumination: false,
        crop_content: false,
        match_page_size: false,
        dpi: 600.0,
        source_dpi: Some(300.0),
        manual_zones: ManualZones {
            picture: vec![PictureZone {
                polygon: NormalizedZonePolygon {
                    points: vec![
                        NormalizedZonePoint { x: 0.5, y: 0.15 },
                        NormalizedZonePoint { x: 0.96, y: 0.15 },
                        NormalizedZonePoint { x: 0.96, y: 0.85 },
                        NormalizedZonePoint { x: 0.5, y: 0.85 },
                    ],
                    rotation: OrthogonalRotation::None,
                },
                layer: PictureZoneLayer::Painter2,
            }],
            fill: vec![],
        },
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": output,
                "metadataPath": output_metadata,
                "backgroundOutputPath": background_output,
                "foregroundMaskOutputPath": foreground_mask_output,
                "pictureMaskOutputPath": picture_mask_output,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let picture_mask = decode_p4(&fs::read(&picture_mask_output).unwrap(), 180 * 120, 200)
        .expect("the confirmed photo test must publish its picture mask");
    let picture_pixels = picture_mask
        .data()
        .iter()
        .filter(|&&value| value == 0)
        .count();
    assert!(
        picture_pixels > 1_000,
        "manual confirmed photo zone was not retained: {picture_pixels} pixels"
    );
    let owned_photo_pixels = (24..94)
        .flat_map(|y| (96..168).map(move |x| (x, y)))
        .filter(|&(x, y)| picture_mask.get(x, y) == 0)
        .count();
    assert!(
        owned_photo_pixels > 1_000,
        "the sampled photo interior must be owned by the picture mask: {owned_photo_pixels}"
    );
    assert_eq!(
        picture_mask.get(132, 60),
        0,
        "the sampled photo interior must be owned by the picture mask"
    );
    assert!(
        background_output.exists(),
        "mixed layer background was not published; metadata={} page_metadata={}",
        String::from_utf8_lossy(&fs::read(&output_metadata).unwrap()),
        String::from_utf8_lossy(&fs::read(&page_metadata).unwrap())
    );
    let background = decode_ppm(
        fs::read(&background_output).unwrap().as_slice(),
        DecodeLimits {
            max_pixels: 180 * 120,
            max_dimension: 200,
            max_compressed_bytes: 180 * 120 * 3 + 64,
        },
    )
    .unwrap();
    assert_eq!(
        (background.gray.width(), background.gray.height()),
        (90, 60)
    );
    let photo_interior = background.gray.get(66, 30);
    let mut expected_photo_sum = 0u64;
    for y in 60..62 {
        for x in 132..134 {
            let pixel = image.get(x, y);
            expected_photo_sum += ((u32::from(pixel[0]) * 77
                + u32::from(pixel[1]) * 150
                + u32::from(pixel[2]) * 29
                + 128)
                >> 8) as u64;
        }
    }
    let expected_photo_interior = expected_photo_sum / 4;
    assert!(
        u64::from(photo_interior).abs_diff(expected_photo_interior) <= 1,
        "caption-adjacent photo interior was whitened: {photo_interior}, source average={expected_photo_interior}; page_metadata={}",
        String::from_utf8_lossy(&fs::read(&page_metadata).unwrap())
    );
}

#[test]
fn mixed_cli_preserves_dark_picture_tone_before_background_downscale() {
    let scratch = Scratch::new("picture-stencil-fill");
    let input = scratch.path("input.png");
    let output = scratch.path("output.png");
    let output_metadata = scratch.path("output.json");
    let page_metadata = scratch.path("page.json");
    let background_output = scratch.path("background.ppm");
    let foreground_mask_output = scratch.path("foreground.pbm");
    let picture_mask_output = scratch.path("picture-mask.pbm");
    let manifest = scratch.path("manifest.json");
    let mut image = RgbImage::new(180, 120, [245; 3]);
    for y in 20..100 {
        for x in 60..168 {
            image.set(x, y, [82, 126, 174]);
        }
    }
    // A deliberately broad dark mark makes picture ownership measurable
    // after the 600 -> 200 DPI background reduction.
    for y in 48..60 {
        for x in 100..112 {
            image.set(x, y, [18; 3]);
        }
    }
    fs::write(&input, encode_rgb(&image).unwrap()).unwrap();
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        binarization: BinarizationMode::Otsu,
        layout: LayoutMode::Single,
        normalize_illumination: false,
        crop_content: false,
        match_page_size: false,
        dpi: 600.0,
        source_dpi: Some(300.0),
        manual_zones: ManualZones {
            picture: vec![PictureZone {
                polygon: NormalizedZonePolygon {
                    points: vec![
                        NormalizedZonePoint { x: 0.33, y: 0.16 },
                        NormalizedZonePoint { x: 0.94, y: 0.16 },
                        NormalizedZonePoint { x: 0.94, y: 0.84 },
                        NormalizedZonePoint { x: 0.33, y: 0.84 },
                    ],
                    rotation: OrthogonalRotation::None,
                },
                layer: PictureZoneLayer::Painter2,
            }],
            fill: vec![],
        },
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": output,
                "metadataPath": output_metadata,
                "backgroundOutputPath": background_output,
                "foregroundMaskOutputPath": foreground_mask_output,
                "pictureMaskOutputPath": picture_mask_output,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let picture_mask = decode_p4(&fs::read(&picture_mask_output).unwrap(), 180 * 120, 200)
        .expect("the Mixed test must publish its picture mask");
    let foreground_mask = decode_p4(&fs::read(&foreground_mask_output).unwrap(), 180 * 120, 200)
        .expect("the Mixed test must publish its foreground mask");
    assert_eq!(
        (foreground_mask.width(), foreground_mask.height()),
        (picture_mask.width(), picture_mask.height())
    );
    let protection_radius = (options.dpi * 0.35 / 25.4).round().clamp(1.0, 12.0) as usize;
    let mut protected_foreground_pixels = 0usize;
    for y in 0..foreground_mask.height() {
        for x in 0..foreground_mask.width() {
            if foreground_mask.get(x, y) != 0 {
                continue;
            }
            let x_start = x.saturating_sub(protection_radius);
            let x_end = (x + protection_radius).min(picture_mask.width() - 1);
            let y_start = y.saturating_sub(protection_radius);
            let y_end = (y + protection_radius).min(picture_mask.height() - 1);
            if (y_start..=y_end).any(|picture_y| {
                (x_start..=x_end).any(|picture_x| picture_mask.get(picture_x, picture_y) == 0)
            }) {
                protected_foreground_pixels += 1;
            }
        }
    }
    assert_eq!(
        protected_foreground_pixels, 0,
        "published Mixed foreground overlaps the dilated picture mask"
    );
    let picture_stencil_pixels = (48..60)
        .flat_map(|y| (100..112).map(move |x| (x, y)))
        .filter(|&(x, y)| picture_mask.get(x, y) == 0)
        .count();
    assert!(
        picture_stencil_pixels > 20,
        "the synthetic dark mark was not retained in the confirmed picture: {picture_stencil_pixels}"
    );

    let background = decode_ppm(
        fs::read(&background_output).unwrap().as_slice(),
        DecodeLimits {
            max_pixels: 180 * 120,
            max_dimension: 200,
            max_compressed_bytes: 180 * 120 * 3 + 64,
        },
    )
    .unwrap();
    assert_eq!(
        (background.gray.width(), background.gray.height()),
        (90, 60)
    );
    assert!(
        background.gray.get(53, 27) < 180,
        "the downscaled plate retained a white stencil knockout: {}",
        background.gray.get(53, 27)
    );
}

#[test]
fn mixed_cli_reuses_source_mrc_layer_for_affine_confirmed_photo() {
    let scratch = Scratch::new("source-mrc-photo");
    let input = scratch.path("input.png");
    let source_background = scratch.path("source-background.png");
    let source_selection = scratch.path("source-selection.png");
    let output = scratch.path("output.png");
    let output_metadata = scratch.path("output.json");
    let page_metadata = scratch.path("page.json");
    let background_output = scratch.path("background.ppm");
    let foreground_mask_output = scratch.path("foreground.pbm");
    let picture_mask_output = scratch.path("picture-mask.pbm");
    let flat_source_background = scratch.path("flat-source-background.png");
    let flat_output = scratch.path("flat-output.png");
    let flat_output_metadata = scratch.path("flat-output.json");
    let flat_page_metadata = scratch.path("flat-page.json");
    let flat_background_output = scratch.path("flat-background.ppm");
    let flat_foreground_mask_output = scratch.path("flat-foreground.pbm");
    let flat_picture_mask_output = scratch.path("flat-picture-mask.pbm");
    let manifest = scratch.path("manifest.json");

    let mut image = RgbImage::new(260, 360, [245; 3]);
    for row in 0..8 {
        let top = 18 + row * 36;
        for column in 0..3 {
            let left = 18 + column * 22;
            for y in top..top + 11 {
                for x in left..left + 12 {
                    if x < left + 2 || y < top + 2 || y >= top + 10 {
                        image.set(x, y, [24; 3]);
                    }
                }
            }
        }
    }
    fs::write(&input, encode_rgb(&image).unwrap()).unwrap();
    let mut source_background_image = RgbImage::new(130, 180, [245; 3]);
    for y in 30..175 {
        for x in 45..129 {
            let tone = 32 + ((x * 17 + y * 29) % 181) as u8;
            source_background_image.set(
                x,
                y,
                [tone, tone.saturating_sub(20), tone.saturating_add(35)],
            );
        }
    }
    fs::write(
        &source_background,
        encode_rgb(&source_background_image).unwrap(),
    )
    .unwrap();
    fs::write(
        &flat_source_background,
        encode_rgb(&RgbImage::new(130, 180, [245; 3])).unwrap(),
    )
    .unwrap();

    // The extracted MRC smask is mostly white paper with black source-owned
    // detail. The native adapter normalizes either encoded polarity before it
    // hands the mask to the affine source-layer contract.
    let mut selection = GrayImage::new(260, 360, 255);
    for y in 60..350 {
        for x in 90..258 {
            selection.set(x, y, 0);
        }
    }
    for row in 0..8 {
        let top = 18 + row * 36;
        for column in 0..3 {
            let left = 18 + column * 22;
            for y in top..top + 11 {
                for x in left..left + 12 {
                    if x < left + 2 || y < top + 2 || y >= top + 10 {
                        selection.set(x, y, 0);
                    }
                }
            }
        }
    }
    fs::write(&source_selection, encode_gray(&selection).unwrap()).unwrap();

    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        layout: LayoutMode::Single,
        normalize_illumination: false,
        crop_content: false,
        match_page_size: false,
        dpi: 150.0,
        source_dpi: Some(150.0),
        source_has_bilevel_layer: true,
        source_background_dpi: Some(75.0),
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "trustedForegroundMaskPath": source_selection,
            "trustedMrcBackgroundPath": source_background,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": output,
                "metadataPath": output_metadata,
                "backgroundOutputPath": background_output,
                "foregroundMaskOutputPath": foreground_mask_output,
                "pictureMaskOutputPath": picture_mask_output,
            }],
        }, {
            "inputPath": input,
            "trustedForegroundMaskPath": source_selection,
            "trustedMrcBackgroundPath": flat_source_background,
            "sourcePageIndex": 1,
            "pageMetadataPath": flat_page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": flat_output,
                "metadataPath": flat_output_metadata,
                "backgroundOutputPath": flat_background_output,
                "foregroundMaskOutputPath": flat_foreground_mask_output,
                "pictureMaskOutputPath": flat_picture_mask_output,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let metadata: Value = serde_json::from_slice(&fs::read(&output_metadata).unwrap()).unwrap();
    assert_eq!(
        metadata["layeredForegroundKind"],
        "source-mrc",
        "output metadata={}; page metadata={}",
        metadata,
        String::from_utf8_lossy(&fs::read(&page_metadata).unwrap())
    );
    assert_eq!(metadata["layeredBackgroundDpi"], 75.0);
    assert_eq!(metadata["layeredForegroundDpi"], 150.0);
    let picture_mask = decode_p4(&fs::read(&picture_mask_output).unwrap(), 260 * 360, 400)
        .expect("trusted background tone publishes a picture owner");
    assert!(
        picture_mask
            .data()
            .iter()
            .filter(|&&value| value == 0)
            .count()
            > 20_000,
        "producer-authored background tone did not recover photo ownership"
    );
    assert!(background_output.exists());
    assert!(foreground_mask_output.exists());
    assert!(
        !output.exists(),
        "source-MRC affine layers must not be shadowed by a flattened composite"
    );

    let flat_metadata: Value =
        serde_json::from_slice(&fs::read(&flat_output_metadata).unwrap()).unwrap();
    assert_ne!(
        flat_metadata["layeredForegroundKind"], "source-mrc",
        "flat producer paper must not enable source-MRC photo reuse"
    );
    let flat_picture = decode_p4(
        &fs::read(&flat_picture_mask_output).unwrap(),
        260 * 360,
        400,
    )
    .expect("flat Mixed page publishes an empty ownership mask");
    assert_eq!(
        flat_picture
            .data()
            .iter()
            .filter(|&&value| value == 0)
            .count(),
        0
    );
}

#[test]
fn mixed_cli_rectangularizes_trusted_photo_tone_without_swallowing_a_caption() {
    fn source_page(with_caption: bool) -> RgbImage {
        let mut source = RgbImage::new(480, 600, [244; 3]);
        for line in 0..15 {
            let top = 28 + line * 30;
            for glyph in 0..7 {
                let left = 16 + glyph * 9;
                for y in top..top + 9 {
                    for x in left..left + 6 {
                        if x < left + 2 || y < top + 2 || y >= top + 7 {
                            source.set(x, y, [24; 3]);
                        }
                    }
                }
            }
        }
        for y in 48..552 {
            for x in 96..480 {
                let tone = 158 + ((x + y) % 7) as u8;
                source.set(x, y, [tone; 3]);
            }
        }
        if with_caption {
            for glyph in 0..11 {
                let left = 302 + glyph * 11;
                for y in 338..350 {
                    for x in left..left + 7 {
                        if x < left + 2 || !(340..348).contains(&y) {
                            source.set(x, y, [24; 3]);
                        }
                    }
                }
            }
        }
        source
    }

    fn selection_for(source: &RgbImage) -> GrayImage {
        let mut selection = GrayImage::new(source.width(), source.height(), 255);
        for y in 0..source.height() {
            for x in 0..source.width() {
                if source.get(x, y)[0] <= 40 {
                    selection.set(x, y, 0);
                }
            }
        }
        selection
    }

    let scratch = Scratch::new("rectangular-photo-owner");
    let plain_input = scratch.path("plain-input.png");
    let captioned_input = scratch.path("captioned-input.png");
    let plain_selection = scratch.path("plain-selection.png");
    let captioned_selection = scratch.path("captioned-selection.png");
    let trusted_background = scratch.path("trusted-background.png");
    let plain_picture = scratch.path("plain-picture.pbm");
    let captioned_picture = scratch.path("captioned-picture.pbm");
    let plain_output = scratch.path("plain-output.png");
    let captioned_output = scratch.path("captioned-output.png");
    let plain_foreground = scratch.path("plain-foreground.pbm");
    let captioned_foreground = scratch.path("captioned-foreground.pbm");
    let plain_background = scratch.path("plain-background.ppm");
    let captioned_background = scratch.path("captioned-background.ppm");
    let plain_metadata = scratch.path("plain-output.json");
    let captioned_metadata = scratch.path("captioned-output.json");
    let plain_page_metadata = scratch.path("plain-page.json");
    let captioned_page_metadata = scratch.path("captioned-page.json");
    let manifest = scratch.path("manifest.json");

    let plain = source_page(false);
    let captioned = source_page(true);
    fs::write(&plain_input, encode_rgb(&plain).unwrap()).unwrap();
    fs::write(&captioned_input, encode_rgb(&captioned).unwrap()).unwrap();
    fs::write(
        &plain_selection,
        encode_gray(&selection_for(&plain)).unwrap(),
    )
    .unwrap();
    fs::write(
        &captioned_selection,
        encode_gray(&selection_for(&captioned)).unwrap(),
    )
    .unwrap();
    let mut producer_tone = RgbImage::new(240, 300, [244; 3]);
    for y in 48..252 {
        for x in 72..216 {
            if x < 120 || y < 96 {
                let tone = 32 + ((x * 17 + y * 29) % 181) as u8;
                producer_tone.set(x, y, [tone; 3]);
            }
        }
    }
    fs::write(&trusted_background, encode_rgb(&producer_tone).unwrap()).unwrap();

    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        layout: LayoutMode::Single,
        normalize_illumination: false,
        crop_content: false,
        match_page_size: false,
        dpi: 240.0,
        source_dpi: Some(240.0),
        source_background_dpi: Some(120.0),
        source_has_bilevel_layer: true,
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": plain_input,
            "trustedForegroundMaskPath": plain_selection,
            "trustedMrcBackgroundPath": trusted_background,
            "sourcePageIndex": 0,
            "pageMetadataPath": plain_page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": plain_output,
                "metadataPath": plain_metadata,
                "backgroundOutputPath": plain_background,
                "foregroundMaskOutputPath": plain_foreground,
                "pictureMaskOutputPath": plain_picture,
            }],
        }, {
            "inputPath": captioned_input,
            "trustedForegroundMaskPath": captioned_selection,
            "trustedMrcBackgroundPath": trusted_background,
            "sourcePageIndex": 1,
            "pageMetadataPath": captioned_page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": captioned_output,
                "metadataPath": captioned_metadata,
                "backgroundOutputPath": captioned_background,
                "foregroundMaskOutputPath": captioned_foreground,
                "pictureMaskOutputPath": captioned_picture,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let plain_picture = decode_p4(&fs::read(&plain_picture).unwrap(), 480 * 600, 700).unwrap();
    let captioned_picture =
        decode_p4(&fs::read(&captioned_picture).unwrap(), 480 * 600, 700).unwrap();
    let captioned_foreground =
        decode_p4(&fs::read(&captioned_foreground).unwrap(), 480 * 600, 700).unwrap();
    assert_eq!(
        plain_picture.get(390, 430),
        0,
        "the tone-compatible missing corner must become picture-owned"
    );
    assert_ne!(
        captioned_picture.get(390, 430),
        0,
        "caption evidence must keep the irregular ownership boundary"
    );
    assert_eq!(
        captioned_foreground.get(336, 342),
        0,
        "caption ink must remain in the high-resolution foreground"
    );
    assert!(plain_background.exists());
    assert!(captioned_background.exists());
}

#[test]
fn matched_canvas_repads_the_published_pbm_without_a_composite() {
    let scratch = Scratch::new("matched");
    let small_input = scratch.path("matched-bilevel-small-input.png");
    let large_input = scratch.path("matched-bilevel-large-input.png");
    let small_output = scratch.path("matched-bilevel-small-output.png");
    let large_output = scratch.path("matched-bilevel-large-output.png");
    let small_metadata = scratch.path("matched-bilevel-small-output.json");
    let large_metadata = scratch.path("matched-bilevel-large-output.json");
    let small_pbm = scratch.path("matched-bilevel-small-output.pbm");
    let large_pbm = scratch.path("matched-bilevel-large-output.pbm");
    let small_page_metadata = scratch.path("matched-bilevel-small-page.json");
    let large_page_metadata = scratch.path("matched-bilevel-large-page.json");
    let manifest = scratch.path("matched-bilevel-manifest.json");
    let mut small = GrayImage::new(80, 60, 255);
    for y in [10, 24, 38] {
        for x in 12..58 {
            small.set(x, y, 0);
            small.set(x, y + 1, 0);
        }
    }
    let mut large = GrayImage::new(100, 90, 255);
    for y in [12, 30, 48, 66] {
        for x in 16..76 {
            large.set(x, y, 0);
            large.set(x, y + 1, 0);
        }
    }
    fs::write(&small_input, encode_gray(&small).unwrap()).unwrap();
    fs::write(&large_input, encode_gray(&large).unwrap()).unwrap();
    let cleanup_options = CleanupOptions {
        output_mode: OutputMode::Bw,
        layout: LayoutMode::Single,
        normalize_illumination: false,
        crop_content: false,
        match_page_size: true,
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 24.0,
            "heightPoints": 21.6,
            "widthPx": 100,
            "heightPx": 90
        },
        "pages": [
            {
                "inputPath": small_input,
                "sourcePageIndex": 0,
                "pageMetadataPath": small_page_metadata,
                "options": cleanup_options,
                "outputs": [{
                    "outputPath": small_output,
                    "metadataPath": small_metadata,
                    "bilevelOutputPath": small_pbm,
                }],
            },
            {
                "inputPath": large_input,
                "sourcePageIndex": 1,
                "pageMetadataPath": large_page_metadata,
                "options": cleanup_options,
                "outputs": [{
                    "outputPath": large_output,
                    "metadataPath": large_metadata,
                    "bilevelOutputPath": large_pbm,
                }],
            },
        ],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    for composite in [&small_output, &large_output] {
        assert!(
            !composite.exists(),
            "matched-canvas repadding must operate on the PBM the combiner reads"
        );
    }
    let small_padded = decode_p4(&fs::read(&small_pbm).unwrap(), 20_000, 200).unwrap();
    let large_padded = decode_p4(&fs::read(&large_pbm).unwrap(), 20_000, 200).unwrap();
    assert_eq!(
        (small_padded.width(), small_padded.height()),
        (large_padded.width(), large_padded.height()),
        "both pages must land on the same uniform canvas"
    );
    let metadata: Value = serde_json::from_slice(&fs::read(&small_metadata).unwrap()).unwrap();
    assert_eq!(metadata["uniformCanvas"], true);
    assert_eq!(
        metadata["canvasWidthPx"].as_u64().unwrap() as usize,
        small_padded.width()
    );
    assert_eq!(
        metadata["canvasHeightPx"].as_u64().unwrap() as usize,
        small_padded.height()
    );
    let offset_x = metadata["placementOffsetXPx"].as_u64().unwrap() as usize;
    let offset_y = metadata["placementOffsetYPx"].as_u64().unwrap() as usize;
    let intrinsic_width = metadata["matchedCanvasContentWidthPx"].as_u64().unwrap() as usize;
    let intrinsic_height = metadata["matchedCanvasContentHeightPx"].as_u64().unwrap() as usize;
    let overflow_left = metadata["matchedCanvasIntrinsicOverflowLeftPx"]
        .as_u64()
        .unwrap_or(0) as usize;
    let effective_offset_x = offset_x as isize - overflow_left as isize;
    assert_native_canvas_owns_image(&metadata);
    assert!(offset_y + intrinsic_height <= small_padded.height());
    let mut ink_inside_payload = 0usize;
    for y in 0..small_padded.height() {
        for x in 0..small_padded.width() {
            let inside = (x as isize) >= effective_offset_x
                && (x as isize) < effective_offset_x + intrinsic_width as isize
                && y >= offset_y
                && y < offset_y + intrinsic_height;
            if small_padded.get(x, y) == 0 {
                assert!(inside, "repadding must leave the added margin white");
                ink_inside_payload += 1;
            }
        }
    }
    assert!(
        ink_inside_payload > 0,
        "repadding must preserve the page's ink"
    );
}

#[test]
fn matched_canvas_places_an_automatic_crop_by_content_alignment() {
    let scratch = Scratch::new("matched-crop-alignment");
    let input = scratch.path("matched-crop-alignment-input.png");
    let output = scratch.path("matched-crop-alignment-output.png");
    let metadata = scratch.path("matched-crop-alignment-output.json");
    let page_metadata = scratch.path("matched-crop-alignment-page.json");
    let manifest = scratch.path("matched-crop-alignment-manifest.json");
    let mut image = GrayImage::new(100, 100, 255);
    for y in 20..70 {
        for x in 30..70 {
            if y % 9 < 3 {
                image.set(x, y, 20);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 72.0,
            "heightPoints": 72.0,
            "widthPx": 100,
            "heightPx": 100
        },
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": {
                "dpi": 100.0,
                "layout": "force-single",
                "normalizeIllumination": false,
                "cropContent": true,
                "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0},
                "outputMode": "grayscale",
                "matchPageSize": true,
                "pageAlignment": "top-left",
                "automaticContentBoxes": {
                    "full": {
                        "xNormalized": 0.2,
                        "yNormalized": 0.1,
                        "widthNormalized": 0.6,
                        "heightNormalized": 0.7,
                        "rotationDegrees": 0
                    }
                }
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata}]
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let metadata: Value = serde_json::from_slice(&fs::read(metadata).unwrap()).unwrap();
    assert_eq!(metadata["cropRect"]["xPx"], 20.0);
    assert_eq!(metadata["cropRect"]["yPx"], 10.0);
    assert_eq!(metadata["matchedCanvasContentWidthPx"], 60);
    assert_eq!(metadata["matchedCanvasContentHeightPx"], 70);
    assert_eq!(metadata["placementOffsetXPx"], 0);
    assert_eq!(metadata["placementOffsetYPx"], 0);
    assert_native_canvas_owns_image(&metadata);
}

#[test]
fn matched_canvas_places_a_crop_where_the_callers_ink_anchor_says_it_sat() {
    let scratch = Scratch::new("matched-ink-anchor");
    let input = scratch.path("matched-ink-anchor-input.png");
    let output = scratch.path("matched-ink-anchor-output.png");
    let metadata = scratch.path("matched-ink-anchor-output.json");
    let page_metadata = scratch.path("matched-ink-anchor-page.json");
    let manifest = scratch.path("matched-ink-anchor-manifest.json");
    let mut image = GrayImage::new(100, 100, 255);
    for y in 20..70 {
        for x in 30..70 {
            if y % 9 < 3 {
                image.set(x, y, 20);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 72.0,
            "heightPoints": 72.0,
            "widthPx": 100,
            "heightPx": 100
        },
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": {
                "dpi": 100.0,
                "layout": "force-single",
                "normalizeIllumination": false,
                "cropContent": true,
                "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0},
                "outputMode": "grayscale",
                "matchPageSize": true,
                "pageAlignment": "ink",
                "placementAnchors": {
                    "full": {"yNormalized": 0.2}
                },
                "automaticContentBoxes": {
                    "full": {
                        "xNormalized": 0.2,
                        "yNormalized": 0.1,
                        "widthNormalized": 0.6,
                        "heightNormalized": 0.7,
                        "rotationDegrees": 0
                    }
                }
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata}]
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let metadata: Value = serde_json::from_slice(&fs::read(metadata).unwrap()).unwrap();
    assert_eq!(metadata["matchedCanvasContentWidthPx"], 60);
    assert_eq!(metadata["matchedCanvasContentHeightPx"], 70);
    // The anchor is vertical only: the crop's top lands a fifth of the way
    // down the margin box, while horizontally the crop is centred exactly as
    // top-center would place it, both without shrinking the requested margins.
    assert_eq!(metadata["placementOffsetYPx"], 20);
    assert_eq!(metadata["placementOffsetXPx"], 20);
    assert_native_canvas_owns_image(&metadata);
}

#[test]
fn failed_bilevel_publication_falls_back_to_the_composite() {
    let scratch = Scratch::new("failed-bilevel");
    let input = scratch.path("failed-bilevel-input.png");
    let output = scratch.path("failed-bilevel-output.png");
    let metadata = scratch.path("failed-bilevel-output.json");
    let bilevel_output = scratch.path("failed-bilevel-output.pbm");
    let page_metadata = scratch.path("failed-bilevel-page.json");
    let manifest = scratch.path("failed-bilevel-manifest.json");
    fs::write(&input, encode_gray(&GrayImage::new(80, 60, 255)).unwrap()).unwrap();
    fs::create_dir(&bilevel_output).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": unmatched_options(),
            "outputs": [{
                "outputPath": output,
                "metadataPath": metadata,
                "bilevelOutputPath": bilevel_output,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        output.exists(),
        "the composite is the fallback an unpublishable PBM falls back to"
    );
    assert!(page_metadata.exists());
    assert!(bilevel_output.is_dir());
    let published: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert!(published
        .get("bilevelWritten")
        .is_none_or(|written| written == false));
    assert!(
        published["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning
                .as_str()
                .unwrap()
                .contains("the composite fallback was published instead")),
        "the fallback must be reported: {published}"
    );
}

#[test]
fn failed_second_page_rolls_back_every_manifest_destination() {
    let scratch = Scratch::new("transaction-rollback");
    let good_input = scratch.path("transaction-good.png");
    let bad_input = scratch.path("transaction-truncated.ppm");
    let manifest = scratch.path("transaction-manifest.json");
    fs::write(
        &good_input,
        encode_gray(&GrayImage::new(80, 60, 220)).unwrap(),
    )
    .unwrap();
    // The dimension probe accepts this header, so page one really enters and
    // completes processing before page two fails its bounded payload decode.
    fs::write(&bad_input, b"P6\n80 60\n255\n").unwrap();
    let page = |index: usize, input: &PathBuf| {
        let page_metadata = scratch.path(&format!("transaction-{index}-page.json"));
        let output = scratch.path(&format!("transaction-{index}.png"));
        let output_metadata = scratch.path(&format!("transaction-{index}-output.json"));
        let bilevel = scratch.path(&format!("transaction-{index}.pbm"));
        let background = scratch.path(&format!("transaction-{index}-background.png"));
        let foreground_mask = scratch.path(&format!("transaction-{index}-foreground.pbm"));
        let foreground_alpha = scratch.path(&format!("transaction-{index}-foreground.png"));
        let picture = scratch.path(&format!("transaction-{index}-picture.pbm"));
        let tone = scratch.path(&format!("transaction-{index}-tone.png"));
        let destinations = vec![
            page_metadata.clone(),
            output.clone(),
            output_metadata.clone(),
            bilevel.clone(),
            background.clone(),
            foreground_mask.clone(),
            foreground_alpha.clone(),
            picture.clone(),
            tone.clone(),
        ];
        (
            serde_json::json!({
                "inputPath": input,
                "sourcePageIndex": index,
                "pageMetadataPath": page_metadata,
                "options": CleanupOptions {
                    output_mode: OutputMode::Grayscale,
                    layout: LayoutMode::Single,
                    normalize_illumination: false,
                    crop_content: false,
                    match_page_size: false,
                    ..CleanupOptions::default()
                },
                "outputs": [{
                    "outputPath": output,
                    "metadataPath": output_metadata,
                    "bilevelOutputPath": bilevel,
                    "backgroundOutputPath": background,
                    "foregroundMaskOutputPath": foreground_mask,
                    "foregroundAlphaOutputPath": foreground_alpha,
                    "pictureMaskOutputPath": picture,
                    "tonePreservationAlphaOutputPath": tone,
                }],
            }),
            destinations,
        )
    };
    let (good_page, mut destinations) = page(0, &good_input);
    let (bad_page, bad_destinations) = page(1, &bad_input);
    destinations.extend(bad_destinations);
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "hostMemoryBytes": 4_u64 * 1024 * 1024 * 1024,
        "pages": [good_page, bad_page],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&result.stdout);

    assert!(!result.status.success(), "stdout={stdout}");
    assert!(
        stdout.contains("\"stage\":\"page-complete\"") && stdout.contains("\"pageNumber\":1"),
        "page one must really publish before page two fails: {stdout}"
    );
    assert!(good_input.exists());
    assert!(bad_input.exists());
    for destination in destinations {
        assert!(
            !destination.exists(),
            "failed batch left declared destination {}",
            destination.display()
        );
    }
}

#[test]
fn failed_batch_restores_a_preexisting_file_destination() {
    let scratch = Scratch::new("preexisting-destination-rollback");
    let good_input = scratch.path("preexisting-good.png");
    let bad_input = scratch.path("preexisting-truncated.ppm");
    let output = scratch.path("preexisting-output.png");
    let metadata = scratch.path("preexisting-output.json");
    let page_metadata = scratch.path("preexisting-page.json");
    let bad_output = scratch.path("preexisting-bad-output.png");
    let bad_metadata = scratch.path("preexisting-bad-output.json");
    let bad_page_metadata = scratch.path("preexisting-bad-page.json");
    let manifest = scratch.path("preexisting-manifest.json");
    fs::write(
        &good_input,
        encode_gray(&GrayImage::new(80, 60, 220)).unwrap(),
    )
    .unwrap();
    fs::write(&bad_input, b"P6\n80 60\n255\n").unwrap();
    let original = b"unrelated preexisting output\0with exact bytes";
    fs::write(&output, original).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [
            {
                "inputPath": good_input,
                "sourcePageIndex": 0,
                "pageMetadataPath": page_metadata,
                "options": CleanupOptions {
                    output_mode: OutputMode::Grayscale,
                    normalize_illumination: false,
                    crop_content: false,
                    match_page_size: false,
                    ..CleanupOptions::default()
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}],
            },
            {
                "inputPath": bad_input,
                "sourcePageIndex": 1,
                "pageMetadataPath": bad_page_metadata,
                "options": CleanupOptions {
                    output_mode: OutputMode::Grayscale,
                    normalize_illumination: false,
                    crop_content: false,
                    match_page_size: false,
                    ..CleanupOptions::default()
                },
                "outputs": [{"outputPath": bad_output, "metadataPath": bad_metadata}],
            }
        ],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&result.stdout);

    assert!(!result.status.success(), "stdout={stdout}");
    assert!(
        stdout.contains("\"stage\":\"page-complete\"") && stdout.contains("\"pageNumber\":1"),
        "the first page must overwrite the destination before rollback: {stdout}"
    );
    assert_eq!(fs::read(&output).unwrap(), original);
    assert!(good_input.exists());
    assert!(bad_input.exists());
    assert!(!metadata.exists());
    assert!(!page_metadata.exists());
    assert!(!bad_output.exists());
    assert!(!bad_metadata.exists());
    assert!(!bad_page_metadata.exists());
    assert!(fs::read_dir(&scratch.dir).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".evb-tmp-")));
}

#[test]
fn auto_resolved_bw_writes_bilevel_output_and_reports_recommendation() {
    let scratch = Scratch::new("auto-bw");
    let input = scratch.path("auto-bw-input.png");
    let manifest = scratch.path("auto-bw-manifest.json");
    let output = scratch.path("auto-bw-output.png");
    let output_metadata = scratch.path("auto-bw-output.json");
    let bilevel_output = scratch.path("auto-bw-output.pbm");
    let page_metadata = scratch.path("auto-bw-page.json");
    let mut image = GrayImage::new(360, 260, 245);
    for row in 0..8 {
        for column in 0..14 {
            let left = 18 + column * 22;
            let top = 18 + row * 28;
            for y in top..top + 14 {
                for x in left..left + 12 {
                    if x < left + 2 || y < top + 2 || y >= top + 12 {
                        image.set(x, y, 28);
                    }
                }
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let options = CleanupOptions {
        output_mode: OutputMode::Auto,
        dpi: 150.0,
        normalize_illumination: false,
        crop_content: false,
        layout: evb_scan_cleanup::LayoutMode::Single,
        ..unmatched_options()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": output,
                "metadataPath": output_metadata,
                "bilevelOutputPath": bilevel_output,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let envelopes = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let completed = envelopes
        .iter()
        .find(|envelope| envelope["progress"]["stage"] == "page-complete")
        .unwrap();
    assert_eq!(completed["progress"]["recommendedOutputMode"], "bw");
    assert!(completed["progress"]["recommendedOutputModeConfidence"]
        .as_f64()
        .is_some_and(|confidence| confidence >= 0.75));
    let page: Value = serde_json::from_slice(&fs::read(&page_metadata).unwrap()).unwrap();
    assert_eq!(page["recommendedOutputMode"], "bw");
    assert_eq!(page["recommendedOutputModeReason"], "bimodal-text");
    let metadata: Value = serde_json::from_slice(&fs::read(&output_metadata).unwrap()).unwrap();
    assert_eq!(metadata["outputMode"], "bw");
    assert_eq!(metadata["bilevelWritten"], true);
    assert!(fs::read(&bilevel_output).unwrap().starts_with(b"P4\n"));
}

#[test]
fn final_cli_pins_the_adjudicated_stroke_budget_and_rescue_counters() {
    let scratch = Scratch::new("stroke-budget-trace");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/rescue/luther-p5-diyarbakir-line.png");
    let output = scratch.path("diyarbakir-clean.png");
    let output_metadata = scratch.path("diyarbakir-clean.json");
    let page_metadata = scratch.path("diyarbakir-page.json");
    let manifest = scratch.path("stroke-budget-manifest.json");
    let options = CleanupOptions {
        dpi: 300.0,
        source_dpi: Some(300.0),
        requested_render_dpi: Some(300.0),
        binarization: BinarizationMode::Auto,
        output_mode: OutputMode::Bw,
        layout: LayoutMode::Single,
        normalize_illumination: true,
        crop_content: false,
        match_page_size: false,
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": fixture,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": output,
                "metadataPath": output_metadata,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .env("EVB_STROKE_BUDGET_TRACE", "1")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let stderr = String::from_utf8(result.stderr).unwrap();
    let traces = stderr
        .lines()
        .filter_map(|line| line.strip_prefix("EVB_STROKE_BUDGET "))
        .map(|trace| serde_json::from_str::<Value>(trace).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        traces,
        vec![serde_json::json!({
            "rasterWidth": 1830,
            "rasterHeight": 77,
            "sourceComponentsNormalized": 2,
            "sourcePixelsRemoved": 39,
            "sourceComponentsUnreachable": 0,
            "smoothingComponentsCapped": 2,
            "smoothingPixelsSuppressed": 4,
            "rescueComponentsCapped": 0,
            "rescueBridgeComponentsCapped": 0,
            "rescuePixelsSuppressed": 0,
        })],
        "the public final-render path changed its adjudicated stroke-budget interventions",
    );

    let cleaned = decode_gray(&fs::read(&output).unwrap(), 1_000_000, 2_000).unwrap();
    assert_eq!((cleaned.width(), cleaned.height()), (1830, 77));
    assert_eq!(
        cleaned.data().iter().filter(|&&value| value < 128).count(),
        20_973,
        "the public final-render path changed the adjudicated ink outcome",
    );
}

#[test]
#[ignore = "real fixture corpus runs in the native CI corpus lane"]
fn spread_preview_cli_pins_the_small_print_stroke_budget_outcome() {
    let scratch = Scratch::new("impressum-spread-trace");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/rescue/luther-p5-impressum-spread.png");
    let outputs = [
        (
            scratch.path("impressum-left.png"),
            scratch.path("impressum-left.json"),
        ),
        (
            scratch.path("impressum-right.png"),
            scratch.path("impressum-right.json"),
        ),
    ];
    let page_metadata = scratch.path("impressum-page.json");
    let manifest = scratch.path("impressum-spread-manifest.json");
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "preview",
        "canvasScope": "page",
        "documentCanvas": {
            "widthPoints": 528.72,
            "heightPoints": 780.48,
            "widthPx": 2196,
            "heightPx": 3241,
        },
        "pages": [{
            "inputPath": fixture,
            "sourcePageIndex": 1,
            "pageMetadataPath": page_metadata,
            "options": {
                "dpi": 299,
                "sourceDpi": 300,
                "requestedRenderDpi": 299,
                "binarization": "auto",
                "thickness": 0,
                "normalizeIllumination": true,
                "despeckle": true,
                "outputMode": "bw",
                "layout": "force-two-page",
                "automaticSplit": {
                    "xNormalized": 0.5755787562414889,
                    "rotationDegrees": 0,
                },
                "automaticContentBoxes": {
                    "left": {
                        "xNormalized": 0.06468452110758058,
                        "yNormalized": 0.19516846789574063,
                        "widthNormalized": 0.4026327734906945,
                        "heightNormalized": 0.8048315321042594,
                        "rotationDegrees": 0,
                    },
                    "right": {
                        "xNormalized": 0,
                        "yNormalized": 0.16815003178639543,
                        "widthNormalized": 0.4087607807535179,
                        "heightNormalized": 0.7797202797202797,
                        "rotationDegrees": 0,
                    },
                },
                "cropContent": true,
                "matchPageSize": true,
                "pageAlignment": "top-center",
                "margins": {"leftMm": 5, "topMm": 5, "rightMm": 5, "bottomMm": 5},
            },
            "outputs": [
                {"outputPath": outputs[0].0, "metadataPath": outputs[0].1},
                {"outputPath": outputs[1].0, "metadataPath": outputs[1].1},
            ],
            "documentPrior": {
                "dominantLayout": "two-page-spread",
                "cutterRatioMedian": 0.5406264185201998,
                "clusterDims": {"widthPx": 2203, "heightPx": 1586.5},
                "agreementStrength": 0.826631599246961,
                "strokeWidthMedianPx": 4.47213595499958,
                "xHeightMedianPx": 14,
            },
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .env("EVB_STROKE_BUDGET_TRACE", "1")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let stderr = String::from_utf8(result.stderr).unwrap();
    let traces = stderr
        .lines()
        .filter_map(|line| line.strip_prefix("EVB_STROKE_BUDGET "))
        .map(|trace| serde_json::from_str::<Value>(trace).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        traces,
        vec![
            serde_json::json!({
                "rasterWidth": 1773,
                "rasterHeight": 2528,
                "sourceComponentsNormalized": 3,
                "sourcePixelsRemoved": 91,
                "sourceComponentsUnreachable": 0,
                "smoothingComponentsCapped": 0,
                "smoothingPixelsSuppressed": 0,
                "rescueComponentsCapped": 0,
                "rescueBridgeComponentsCapped": 0,
                "rescuePixelsSuppressed": 0,
            }),
            serde_json::json!({
                "rasterWidth": 1803,
                "rasterHeight": 2451,
                "sourceComponentsNormalized": 3,
                "sourcePixelsRemoved": 100,
                "sourceComponentsUnreachable": 0,
                "smoothingComponentsCapped": 0,
                "smoothingPixelsSuppressed": 0,
                "rescueComponentsCapped": 0,
                "rescueBridgeComponentsCapped": 0,
                "rescuePixelsSuppressed": 0,
            }),
        ],
        "the spread preview path changed its adjudicated stroke-budget interventions \
         (an erosion storm on the impressum leaf shows up here first)",
    );

    // The spread drops 5_304 px on the left leaf and 264 px on the right that
    // the rule restore used to add on top of six ordinary text lines (33-45 px
    // tall) it had misread as horizontal rules -- among them the full-width
    // "au\u{df}erhalb der engen Grenzen" line and the "2. Timotheus 4,5:" run.
    // Those lines printed visibly bolder than their neighbours. Every changed
    // band is thicker than the 2 mm rule bound, so no genuine rule regressed.
    let expected = [(1773usize, 2528usize, 182_427usize), (1803, 2451, 581_428)];
    for ((output_path, _), (width, height, ink)) in outputs.iter().zip(expected) {
        let cleaned = decode_gray(&fs::read(output_path).unwrap(), 40_000_000, 40_000).unwrap();
        assert_eq!((cleaned.width(), cleaned.height()), (width, height));
        assert_eq!(
            cleaned.data().iter().filter(|&&value| value < 128).count(),
            ink,
            "the spread preview path changed the adjudicated ink outcome",
        );
    }
}

#[test]
fn page_plan_cli_keeps_a_discardable_speck_out_of_the_content_box() {
    let scratch = Scratch::new("content-box-speck");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/content-box/luther-p1-right-leaf-speck-top.png");
    let page_metadata = scratch.path("speck-page.json");
    let manifest = scratch.path("speck-manifest.json");
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "analyze",
            "analysisPurpose": "page-plan",
            "renderMode": "preview",
            "canvasScope": "page",
            "pages": [{
                "inputPath": fixture,
                "sourcePageIndex": 0,
                "pageMetadataPath": page_metadata,
                "options": {
                    "dpi": 150,
                    "sourceDpi": 300,
                    "requestedRenderDpi": 150,
                    "binarization": "auto",
                    "thickness": 0,
                    "normalizeIllumination": true,
                    "despeckle": true,
                    "outputMode": "auto",
                    "layout": "force-single",
                    "cropContent": true,
                    "matchPageSize": true,
                    "pageAlignment": "top-center",
                    "margins": {"leftMm": 5, "topMm": 5, "rightMm": 5, "bottomMm": 5},
                },
                "outputs": [],
                "documentPrior": {
                    "dominantLayout": "two-page-spread",
                    "cutterRatioMedian": 0.5406264185201998,
                    "clusterDims": {"widthPx": 2203, "heightPx": 1586.5},
                    "agreementStrength": 0.826631599246961,
                    "strokeWidthMedianPx": 4.47213595499958,
                    "xHeightMedianPx": 14,
                },
            }],
        }))
        .unwrap(),
    )
    .unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let metadata: Value = serde_json::from_slice(&fs::read(&page_metadata).unwrap()).unwrap();
    let content = &metadata["outputs"][0]["contentBox"];
    assert_eq!(
        (
            content["xPx"].as_f64().expect("content left"),
            content["yPx"].as_f64().expect("content top"),
            content["widthPx"].as_f64().expect("content width"),
            content["heightPx"].as_f64().expect("content height"),
        ),
        (202.5, 114.0, 565.0, 286.0),
        "the faint smudge at rows 21..23 must not set the crop top: {content}",
    );
}

/// Mean horizontal ink-run length inside a word box: the stroke-thickness
/// proxy the weight adjudications measure. Ink is the mid-gray crossing so
/// the same rule reads the grayscale source and the bilevel render.
fn word_stroke_runs(image: &GrayImage, left: usize, right: usize) -> f64 {
    let mut total = 0usize;
    let mut count = 0usize;
    for y in 0..image.height() {
        let mut run = 0usize;
        for x in left..=right {
            if image.data()[y * image.width() + x] < 128 {
                run += 1;
            } else if run > 0 {
                total += run;
                count += 1;
                run = 0;
            }
        }
        if run > 0 {
            total += run;
            count += 1;
        }
    }
    if count == 0 {
        0.0
    } else {
        total as f64 / count as f64
    }
}

/// Column-profile word segmentation on the source crop: an inter-word gap at
/// 300 DPI is wider than 14 blank columns, and anything narrower than 12
/// columns is punctuation noise rather than a word.
fn segment_words(image: &GrayImage) -> Vec<(usize, usize)> {
    let mut inked_columns = vec![false; image.width()];
    for y in 0..image.height() {
        for (x, inked) in inked_columns.iter_mut().enumerate() {
            *inked |= image.data()[y * image.width() + x] < 128;
        }
    }
    let mut words = Vec::new();
    let mut start = None;
    let mut gap = 0usize;
    for (x, &inked) in inked_columns.iter().enumerate() {
        if inked {
            start.get_or_insert(x);
            gap = 0;
        } else if let Some(word_start) = start {
            gap += 1;
            if gap > 14 {
                words.push((word_start, x - gap));
                start = None;
            }
        }
    }
    if let Some(word_start) = start {
        words.push((word_start, image.width() - 1));
    }
    words.retain(|(left, right)| right - left >= 12);
    words
}

/// The word-level stroke-neutrality oracle. Aggregate ink parity once hid a
/// per-word amplification of up to +34% on this line (the faint-ink rescue
/// re-absorbing the gray halo around already-complete strokes), so this pin
/// holds every individual word of the cleaned render within 5% of the source
/// scan's stroke thickness. Binarization must normalize, never embolden.
#[test]
fn final_cli_keeps_every_word_stroke_run_within_source_tolerance() {
    let scratch = Scratch::new("word-stroke-oracle");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/rescue/luther-p5-diyarbakir-line.png");
    let output = scratch.path("diyarbakir-oracle.png");
    let output_metadata = scratch.path("diyarbakir-oracle.json");
    let page_metadata = scratch.path("diyarbakir-oracle-page.json");
    let manifest = scratch.path("word-stroke-oracle-manifest.json");
    let options = CleanupOptions {
        dpi: 300.0,
        source_dpi: Some(300.0),
        requested_render_dpi: Some(300.0),
        binarization: BinarizationMode::Auto,
        output_mode: OutputMode::Bw,
        layout: LayoutMode::Single,
        normalize_illumination: true,
        crop_content: false,
        match_page_size: false,
        ..CleanupOptions::default()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": fixture,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": options,
            "outputs": [{
                "outputPath": output,
                "metadataPath": output_metadata,
            }],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let source = decode_gray(&fs::read(&fixture).unwrap(), 1_000_000, 2_000).unwrap();
    let cleaned = decode_gray(&fs::read(&output).unwrap(), 1_000_000, 2_000).unwrap();
    assert_eq!(
        (cleaned.width(), cleaned.height()),
        (source.width(), source.height())
    );

    let words = segment_words(&source);
    assert_eq!(
        words.len(),
        9,
        "word segmentation drifted; the oracle no longer measures the adjudicated words",
    );
    for &(left, right) in &words {
        let source_runs = word_stroke_runs(&source, left, right);
        let cleaned_runs = word_stroke_runs(&cleaned, left, right);
        let ratio = cleaned_runs / source_runs;
        assert!(
            (0.95..=1.05).contains(&ratio),
            "word at columns {left}-{right} changed stroke weight: \
             source runs {source_runs:.2}px, cleaned runs {cleaned_runs:.2}px, \
             ratio {ratio:.3} outside the stroke-neutral band 0.95..=1.05",
        );
    }
}

#[test]
fn canonical_cli_pins_the_calibrated_dark_border_routing_band() {
    let scratch = Scratch::new("canonical-routing-band");
    let cases = [
        ("below", 0.085, 0.08, 0.099, "wolf"),
        ("inside", 0.095, 0.099, 0.110_25, "otsu"),
        ("above", 0.105, 0.110_25, 0.14, "wolf"),
    ];
    let mut pages = Vec::new();
    let mut metadata_paths = Vec::new();

    for (source_page_index, (name, injected_coverage, _, _, _)) in cases.iter().enumerate() {
        let mut canonical = GrayImage::new(300, 400, 245);
        for row in 0..12 {
            let top = 62 + row * 23;
            for word in 0..9 {
                let left = 38 + word * 25;
                for y in top..top + 3 {
                    for x in left..left + 15 {
                        canonical.set(x, y, 24);
                    }
                }
            }
        }
        let band = canonical.width().min(canonical.height()).div_ceil(30);
        let border = (0..canonical.height())
            .flat_map(|y| (0..canonical.width()).map(move |x| (x, y)))
            .filter(|&(x, y)| {
                x < band
                    || y < band
                    || x + band >= canonical.width()
                    || y + band >= canonical.height()
            })
            .collect::<Vec<_>>();
        let dark_count = (*injected_coverage * border.len() as f64).round() as usize;
        for &(x, y) in border.iter().take(dark_count) {
            canonical.set(x, y, 24);
        }

        let source = canonical.resample_to_dimensions(600, 800);
        let canonical_path = scratch.path(&format!("{name}-canonical.png"));
        let source_path = scratch.path(&format!("{name}-source.png"));
        let output_path = scratch.path(&format!("{name}-output.png"));
        let metadata_path = scratch.path(&format!("{name}-output.json"));
        let page_metadata_path = scratch.path(&format!("{name}-page.json"));
        fs::write(&canonical_path, encode_gray(&canonical).unwrap()).unwrap();
        fs::write(&source_path, encode_gray(&source).unwrap()).unwrap();
        pages.push(serde_json::json!({
            "inputPath": source_path,
            "analysisInputPath": canonical_path,
            "analysisDpi": 150,
            "sourcePageIndex": source_page_index,
            "pageMetadataPath": page_metadata_path,
            "options": CleanupOptions {
                dpi: 300.0,
                source_dpi: Some(300.0),
                requested_render_dpi: Some(300.0),
                binarization: BinarizationMode::Auto,
                output_mode: OutputMode::Bw,
                layout: LayoutMode::Single,
                manual_skew_degrees: Some(0.0),
                normalize_illumination: false,
                crop_content: false,
                match_page_size: false,
                despeckle: false,
                ..CleanupOptions::default()
            },
            "outputs": [{
                "outputPath": output_path,
                "metadataPath": metadata_path,
            }],
        }));
        metadata_paths.push(metadata_path);
    }

    let manifest = scratch.path("canonical-routing-band-manifest.json");
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": pages,
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
    );

    let observations = cases
        .into_iter()
        .zip(metadata_paths)
        .map(
            |((name, _, coverage_floor, coverage_ceiling, expected_route), metadata_path)| {
                let metadata: Value =
                    serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
                let diagnostics = metadata["binarizationDiagnostics"].clone();
                let actual_coverage = diagnostics["darkBorderCoverage"].as_f64().unwrap();
                (
                    name,
                    coverage_floor,
                    coverage_ceiling,
                    expected_route,
                    actual_coverage,
                    diagnostics,
                )
            },
        )
        .collect::<Vec<_>>();
    assert!(
        observations.iter().all(
            |(_, floor, ceiling, expected_route, coverage, diagnostics)| {
                coverage >= floor && coverage < ceiling && diagnostics["route"] == *expected_route
            }
        ),
        "canonical CLI routing observations crossed their calibrated boundaries: {observations:#?}",
    );
}

/// The fallback analysis path (no canonical `analysisInputPath`) must measure
/// its spread-plan anchors on real leaf pixels. The split is produced in
/// analysis-full coordinates while the fallback analysis raster is DPI-capped
/// below full resolution, so leaf regions computed against the normalized
/// dimensions clamp the cutter to the raster edge: the right leaf degenerates
/// to a paper sliver, its intensity anchor saturates, and the executed
/// threshold turns the whole leaf to ink. Pin the fallback run to the
/// canonical-analysis reference instead of absolute numbers so the pin
/// survives calibration drift.
#[test]
fn fallback_spread_analysis_matches_canonical_leaf_ink_and_content() {
    let scratch = Scratch::new("fallback-spread-parity");
    // 1200x800 at 300 DPI: fallback analysis normalization caps its raster at
    // half size, which is the precondition that desynchronizes the full-space
    // split from the normalized dimensions. The scanner margin is brighter
    // than the leaf paper: a leaf anchor mistakenly measured on the margin
    // then sits above the paper level and binarizes the whole leaf as ink.
    let mut spread = GrayImage::new(1200, 800, 255);
    for y in 40..760 {
        for x in 40..1160 {
            spread.set(x, y, 225);
        }
    }
    for row in 0..18 {
        let top = 120 + row * 30;
        for word in 0..8 {
            for y in top..top + 6 {
                for x in 90 + word * 55..124 + word * 55 {
                    spread.set(x, y, 20);
                }
                for x in 690 + word * 55..724 + word * 55 {
                    spread.set(x, y, 20);
                }
            }
        }
    }
    let canonical = spread.resample_to_dimensions(600, 400);
    let spread_path = scratch.path("spread.png");
    let canonical_path = scratch.path("canonical.png");
    fs::write(&spread_path, encode_gray(&spread).unwrap()).unwrap();
    fs::write(&canonical_path, encode_gray(&canonical).unwrap()).unwrap();

    let run = |label: &str, with_canonical: bool| {
        let mut page = serde_json::json!({
            "inputPath": spread_path,
            "sourcePageIndex": 0,
            "pageMetadataPath": scratch.path(&format!("{label}-page.json")),
            "options": {
                "dpi": 300,
                "layout": "force-two-page",
                "normalizeIllumination": false,
                "cropContent": true,
                "matchPageSize": false,
                "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
            },
            "outputs": [
                {
                    "outputPath": scratch.path(&format!("{label}-left.png")),
                    "metadataPath": scratch.path(&format!("{label}-left.json"))
                },
                {
                    "outputPath": scratch.path(&format!("{label}-right.png")),
                    "metadataPath": scratch.path(&format!("{label}-right.json"))
                }
            ]
        });
        if with_canonical {
            page["analysisInputPath"] = serde_json::json!(canonical_path);
            page["analysisDpi"] = serde_json::json!(150);
        }
        let manifest = scratch.path(&format!("{label}-manifest.json"));
        fs::write(
            &manifest,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 3,
                "operation": "render",
                "renderMode": "final",
                "canvasScope": "document",
                "pages": [page],
            }))
            .unwrap(),
        )
        .unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{label}: stdout={}\nstderr={}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        );
        ["left", "right"].map(|half| {
            let output = decode_gray(
                &fs::read(scratch.path(&format!("{label}-{half}.png"))).unwrap(),
                4_000_000,
                2000,
            )
            .unwrap();
            let ink = output.data().iter().filter(|&&value| value < 128).count() as f64
                / (output.width() * output.height()) as f64;
            let metadata: Value = serde_json::from_slice(
                &fs::read(scratch.path(&format!("{label}-{half}.json"))).unwrap(),
            )
            .unwrap();
            (ink, metadata)
        })
    };

    let fallback = run("fallback", false);
    let reference = run("canonical", true);

    for (half, ((fallback_ink, fallback_metadata), (reference_ink, reference_metadata))) in
        ["left", "right"]
            .into_iter()
            .zip(fallback.into_iter().zip(reference))
    {
        assert!(
            fallback_ink > 0.005 && fallback_ink < 0.5,
            "{half} fallback leaf binarized outside plausible ink bounds: {fallback_ink}",
        );
        let ink_ratio = fallback_ink / reference_ink.max(f64::EPSILON);
        assert!(
            (0.85..=1.15).contains(&ink_ratio),
            "{half} fallback leaf ink diverged from the canonical reference: \
             fallback={fallback_ink} canonical={reference_ink} ratio={ink_ratio}",
        );
        for dimension in ["widthPx", "heightPx"] {
            let fallback_extent = fallback_metadata["contentBox"][dimension].as_f64().unwrap();
            let reference_extent = reference_metadata["contentBox"][dimension]
                .as_f64()
                .unwrap();
            assert!(
                (fallback_extent - reference_extent).abs() <= reference_extent * 0.05,
                "{half} fallback content box {dimension} diverged: \
                 fallback={fallback_extent} canonical={reference_extent}",
            );
        }
    }
}

/// The same fallback/canonical parity must hold when the source crosses the
/// analysis edge ceiling. This keeps the fixed-plane split invariant covered
/// on the path that actually downsamples to `MAX_ANALYSIS_EDGE`, not only on a
/// source that is merely below the ceiling.
#[test]
#[ignore = "full-raster CLI fixture runs in the native CI corpus lane"]
fn over_analysis_edge_spread_analysis_matches_canonical_leaf_ink_and_content() {
    let scratch = Scratch::new("fallback-spread-over-analysis-edge");
    let (width, height) = (2504, 1600);
    let mut spread = GrayImage::new(width, height, 255);
    for y in 80..height - 80 {
        for x in 80..width - 80 {
            spread.set(x, y, 225);
        }
    }
    for row in 0..18 {
        let top = 180 + row * 65;
        for word in 0..13 {
            for y in top..top + 8 {
                for x in 120 + word * 80..168 + word * 80 {
                    spread.set(x, y, 20);
                }
                for x in 1400 + word * 80..1448 + word * 80 {
                    spread.set(x, y, 20);
                }
            }
        }
    }
    let canonical = spread.resample_to_dimensions(1252, 800);
    let spread_path = scratch.path("spread.png");
    let canonical_path = scratch.path("canonical.png");
    fs::write(&spread_path, encode_gray(&spread).unwrap()).unwrap();
    fs::write(&canonical_path, encode_gray(&canonical).unwrap()).unwrap();

    let run = |label: &str, with_canonical: bool| {
        let mut page = serde_json::json!({
            "inputPath": spread_path,
            "sourcePageIndex": 0,
            "pageMetadataPath": scratch.path(&format!("{label}-page.json")),
            "options": {
                "dpi": 300,
                "layout": "force-two-page",
                "normalizeIllumination": false,
                "cropContent": true,
                "matchPageSize": false,
                "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
            },
            "outputs": [
                {
                    "outputPath": scratch.path(&format!("{label}-left.png")),
                    "metadataPath": scratch.path(&format!("{label}-left.json"))
                },
                {
                    "outputPath": scratch.path(&format!("{label}-right.png")),
                    "metadataPath": scratch.path(&format!("{label}-right.json"))
                }
            ]
        });
        if with_canonical {
            page["analysisInputPath"] = serde_json::json!(canonical_path);
            page["analysisDpi"] = serde_json::json!(150);
        }
        let manifest = scratch.path(&format!("{label}-manifest.json"));
        fs::write(
            &manifest,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 3,
                "operation": "render",
                "renderMode": "final",
                "canvasScope": "document",
                "pages": [page],
            }))
            .unwrap(),
        )
        .unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{label}: stdout={}\nstderr={}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        );
        ["left", "right"].map(|half| {
            let output = decode_gray(
                &fs::read(scratch.path(&format!("{label}-{half}.png"))).unwrap(),
                4_000_000,
                2000,
            )
            .unwrap();
            let ink = output.data().iter().filter(|&&value| value < 128).count() as f64
                / (output.width() * output.height()) as f64;
            let metadata: Value = serde_json::from_slice(
                &fs::read(scratch.path(&format!("{label}-{half}.json"))).unwrap(),
            )
            .unwrap();
            (ink, metadata)
        })
    };

    let fallback = run("fallback", false);
    let reference = run("canonical", true);
    for (half, ((fallback_ink, fallback_metadata), (reference_ink, reference_metadata))) in
        ["left", "right"]
            .into_iter()
            .zip(fallback.into_iter().zip(reference))
    {
        assert!(
            fallback_ink > 0.005 && fallback_ink < 0.5,
            "{half} fallback leaf crossed the analysis edge with implausible ink: {fallback_ink}",
        );
        let ink_ratio = fallback_ink / reference_ink.max(f64::EPSILON);
        assert!(
            (0.85..=1.15).contains(&ink_ratio),
            "{half} over-edge fallback leaf diverged from canonical reference: \
             fallback={fallback_ink} canonical={reference_ink} ratio={ink_ratio}",
        );
        for dimension in ["widthPx", "heightPx"] {
            let fallback_extent = fallback_metadata["contentBox"][dimension].as_f64().unwrap();
            let reference_extent = reference_metadata["contentBox"][dimension]
                .as_f64()
                .unwrap();
            assert!(
                (fallback_extent - reference_extent).abs() <= reference_extent * 0.05,
                "{half} over-edge fallback content box {dimension} diverged: \
                 fallback={fallback_extent} canonical={reference_extent}",
            );
        }
    }
}

#[test]
#[ignore = "full-raster CLI fixture runs in the native CI corpus lane"]
fn auto_small_picture_uses_mixed_but_explicit_bw_stays_bilevel() {
    let scratch = Scratch::new("auto-small-picture");
    let input = scratch.path("small-picture-input.png");
    let manifest = scratch.path("small-picture-manifest.json");
    let auto_output = scratch.path("small-picture-auto-output.png");
    let auto_metadata = scratch.path("small-picture-auto-output.json");
    let auto_page_metadata = scratch.path("small-picture-auto-page.json");
    let auto_background = scratch.path("small-picture-auto-background.ppm");
    let auto_foreground = scratch.path("small-picture-auto-foreground.pbm");
    let auto_picture = scratch.path("small-picture-auto-picture.pbm");
    let forced_output = scratch.path("small-picture-forced-output.png");
    let forced_metadata = scratch.path("small-picture-forced-output.json");
    let forced_page_metadata = scratch.path("small-picture-forced-page.json");
    let forced_bilevel = scratch.path("small-picture-forced-output.pbm");

    let mut image = GrayImage::new(1_000, 1_400, 245);
    for row in 0..18 {
        let top = 80 + row * 64;
        for column in 0..30 {
            let left = 70 + column * 29;
            for y in top..top + 18 {
                for x in left..left + 14 {
                    if x < left + 2 || y < top + 2 || y >= top + 16 {
                        image.set(x, y, 28);
                    }
                }
            }
        }
    }
    for y in 600..700 {
        for x in 780..880 {
            image.set(x, y, 80 + ((x * 17 + y * 29) % 130) as u8);
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();

    let picture_zone = PictureZone {
        polygon: NormalizedZonePolygon {
            points: vec![
                NormalizedZonePoint {
                    x: 0.78,
                    y: 600.0 / 1_400.0,
                },
                NormalizedZonePoint {
                    x: 0.88,
                    y: 600.0 / 1_400.0,
                },
                NormalizedZonePoint {
                    x: 0.88,
                    y: 700.0 / 1_400.0,
                },
                NormalizedZonePoint {
                    x: 0.78,
                    y: 700.0 / 1_400.0,
                },
            ],
            rotation: OrthogonalRotation::None,
        },
        layer: PictureZoneLayer::Painter2,
    };
    let auto_options = CleanupOptions {
        output_mode: OutputMode::Auto,
        dpi: 150.0,
        normalize_illumination: false,
        crop_content: false,
        layout: LayoutMode::Single,
        manual_zones: ManualZones {
            picture: vec![picture_zone.clone()],
            fill: Vec::new(),
        },
        ..unmatched_options()
    };
    let forced_options = CleanupOptions {
        output_mode: OutputMode::Bw,
        ..auto_options.clone()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [
            {
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": auto_page_metadata,
                "options": auto_options,
                "outputs": [{
                    "outputPath": auto_output,
                    "metadataPath": auto_metadata,
                    "backgroundOutputPath": auto_background,
                    "foregroundMaskOutputPath": auto_foreground,
                    "pictureMaskOutputPath": auto_picture,
                }],
            },
            {
                "inputPath": input,
                "sourcePageIndex": 1,
                "pageMetadataPath": forced_page_metadata,
                "options": forced_options,
                "outputs": [{
                    "outputPath": forced_output,
                    "metadataPath": forced_metadata,
                    "bilevelOutputPath": forced_bilevel,
                }],
            },
        ],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let auto_page: Value = serde_json::from_slice(&fs::read(&auto_page_metadata).unwrap()).unwrap();
    assert_eq!(auto_page["recommendedOutputMode"], "mixed");
    assert_eq!(
        auto_page["recommendedOutputModeReason"],
        "text-with-pictures"
    );
    let auto_output_metadata: Value =
        serde_json::from_slice(&fs::read(&auto_metadata).unwrap()).unwrap();
    assert_eq!(auto_output_metadata["outputMode"], "mixed");
    assert!(auto_background.exists());
    assert!(auto_foreground.exists());
    assert!(auto_picture.exists());

    let forced_page: Value =
        serde_json::from_slice(&fs::read(&forced_page_metadata).unwrap()).unwrap();
    assert!(
        forced_page["recommendedOutputMode"].is_null(),
        "explicit B&W must not run automatic mode selection: {forced_page}"
    );
    let forced_output_metadata: Value =
        serde_json::from_slice(&fs::read(&forced_metadata).unwrap()).unwrap();
    assert_eq!(forced_output_metadata["outputMode"], "bw");
    assert!(forced_bilevel.exists());
    assert!(!forced_output_metadata["pictureMaskWritten"]
        .as_bool()
        .unwrap_or(false));
}

#[test]
fn analyze_keeps_colored_recommendations_mode_independent() {
    let scratch = Scratch::new("auto-analyze");
    let input = scratch.path("auto-analyze-input.png");
    let auto_metadata = scratch.path("auto-analyze-page.json");
    let concrete_metadata = scratch.path("concrete-analyze-page.json");
    let manifest = scratch.path("auto-analyze-manifest.json");
    let mut image = RgbImage::new(360, 260, [28, 74, 132]);
    for y in 0..image.height() {
        for x in 0..image.width() {
            image.set(
                x,
                y,
                [
                    20 + ((x * 5 + y * 3) % 210) as u8,
                    35 + ((x * 7 + y * 11) % 180) as u8,
                    45 + ((x * 13 + y * 17) % 170) as u8,
                ],
            );
        }
    }
    fs::write(&input, encode_rgb(&image).unwrap()).unwrap();
    let auto = CleanupOptions {
        output_mode: OutputMode::Auto,
        dpi: 150.0,
        normalize_illumination: false,
        crop_content: false,
        ..CleanupOptions::default()
    };
    let concrete = CleanupOptions {
        output_mode: OutputMode::Grayscale,
        ..auto.clone()
    };
    let payload = serde_json::json!({
        "version": 3,
        "operation": "analyze",
        "renderMode": "preview",
        "canvasScope": "page",
        "pages": [
            {
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": auto_metadata,
                "options": auto,
                "outputs": [],
            },
            {
                "inputPath": input,
                "sourcePageIndex": 1,
                "pageMetadataPath": concrete_metadata,
                "options": concrete,
                "outputs": [],
            },
        ],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let progress = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|envelope| envelope["progress"]["stage"] == "page-complete")
        .collect::<Vec<_>>();
    assert!(progress[0]["progress"]["recommendedOutputMode"].is_string());
    assert!(progress[0]["progress"]["recommendedOutputModeConfidence"].is_number());
    assert!(progress[1]["progress"]["recommendedOutputMode"].is_string());
    assert!(progress[1]["progress"]["recommendedOutputModeConfidence"].is_number());
    let auto_page: Value = serde_json::from_slice(&fs::read(&auto_metadata).unwrap()).unwrap();
    let concrete_page: Value =
        serde_json::from_slice(&fs::read(&concrete_metadata).unwrap()).unwrap();
    assert!(auto_page["recommendedOutputMode"].is_string());
    assert!(concrete_page["recommendedOutputMode"].is_string());
    assert_eq!(auto_page["recommendedOutputMode"], "color");
    assert_eq!(
        concrete_page["recommendedOutputMode"],
        auto_page["recommendedOutputMode"]
    );
}

#[test]
fn per_page_ocr_mode_writes_atomic_png_and_metadata() {
    let scratch = Scratch::new("ocr");
    let input = scratch.path("input.png");
    let output = scratch.path("output.png");
    let metadata = scratch.path("metadata.json");
    let mut image = GrayImage::new(100, 80, 240);
    for y in (15..65).step_by(10) {
        for x in 12..88 {
            image.set(x, y, 20);
            image.set(x, y + 1, 20);
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args([
            "--input",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
            "--metadata",
            metadata.to_str().unwrap(),
            "--ocr-mode",
            "--options",
            r#"{"dpi":300,"normalizeIllumination":false}"#,
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    let cleaned = decode_gray(&fs::read(&output).unwrap(), 10_000, 200).unwrap();
    assert_eq!((cleaned.width(), cleaned.height()), (100, 80));
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert_eq!(metadata_json["inputWidthPx"], 100);
    assert_eq!(metadata_json["outputWidthPx"], 100);
    assert!(metadata_json["forwardTransform"]["matrix"].is_array());
}

#[test]
fn batch_spread_png_writes_two_output_images_and_per_half_metadata() {
    let scratch = Scratch::new("spread");
    let input = scratch.path("spread-input.png");
    let output_left = scratch.path("spread-left.png");
    let output_right = scratch.path("spread-right.png");
    let metadata_left = scratch.path("spread-left.json");
    let metadata_right = scratch.path("spread-right.json");
    let manifest = scratch.path("spread-manifest.json");
    let mut image = GrayImage::new(320, 200, 245);
    for y in (35..165).step_by(14) {
        for word in 0..7 {
            for x in 24 + word * 18..(36 + word * 18).min(142) {
                image.set(x, y, 18);
                image.set(x, y + 1, 18);
                image.set(x, y + 2, 18);
            }
            for x in 178 + word * 18..(190 + word * 18).min(296) {
                image.set(x, y, 22);
                image.set(x, y + 1, 22);
                image.set(x, y + 2, 22);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        // The document of this spread: each half is 100 x 320 of the rotated
        // sheet, which is the paper a reader ends up holding.
        "documentCanvas": {
            "widthPoints": 48.0,
            "heightPoints": 153.6,
            "widthPx": 100,
            "heightPx": 320
        },
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 7,
            "pageMetadataPath": scratch.path("spread-page.json"),
            "options": {
                "dpi": 150,
                "layout": "force-two-page",
                "rotationDegrees": 90,
                "normalizeIllumination": false,
                "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
            },
            "outputs": [
                {"outputPath": output_left, "metadataPath": metadata_left},
                {"outputPath": output_right, "metadataPath": metadata_right}
            ]
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&result.stderr), "");
    let mut content_sizes = Vec::new();
    let mut binarization_diagnostics = Vec::new();
    for (path, metadata_path, expected_half) in [
        (&output_left, &metadata_left, "left"),
        (&output_right, &metadata_right, "right"),
    ] {
        let output = decode_gray(&fs::read(path).unwrap(), 100_000, 400).unwrap();
        assert!(output.width() < image.width());
        let metadata_json: Value =
            serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
        assert_eq!(metadata_json["sourcePageIndex"], 7);
        assert_eq!(metadata_json["half"], expected_half);
        assert_eq!(metadata_json["layoutClassification"], "two-page-spread");
        assert_eq!(metadata_json["rotationDegrees"], 90);
        assert!(metadata_json["forwardTransform"]["matrix"].is_array());
        assert!(metadata_json["inverseTransform"]["matrix"].is_array());
        // Matched page size is on, as it is by default: both halves carry the
        // document's half-sheet canvas rather than the sheet they were cut from,
        // so neither is a page with an empty half beside it.
        assert_eq!(
            (output.width(), output.height()),
            (100, 320),
            "{expected_half} half is not the document canvas"
        );
        assert_eq!(metadata_json["canvasWidthPx"], 100);
        assert_eq!(metadata_json["canvasHeightPx"], 320);
        assert_eq!(metadata_json["canvasOverflow"], serde_json::json!(false));
        binarization_diagnostics.push(metadata_json["binarizationDiagnostics"].clone());
        content_sizes.push((
            metadata_json["matchedCanvasContentWidthPx"]
                .as_u64()
                .unwrap(),
            metadata_json["matchedCanvasContentHeightPx"]
                .as_u64()
                .unwrap(),
        ));
    }
    // Each half fills the sheet it was normalized onto rather than half of it.
    for (content_width, content_height) in content_sizes {
        assert!(
            content_width * 2 > 100 && content_height * 2 > 320,
            "a half was padded into the canvas instead of filling it ({content_width}x{content_height})"
        );
    }
    assert_eq!(binarization_diagnostics.len(), 2);
    for diagnostics in &binarization_diagnostics {
        assert_eq!(diagnostics["route"], "otsu");
        assert_eq!(diagnostics["spreadPlan"]["decision"], "sharedJoint");
        assert_eq!(diagnostics["spreadPlan"]["jointCandidateRoute"], "otsu");
        assert_eq!(diagnostics["spreadPlan"]["leftCandidateRoute"], "otsu");
        assert_eq!(diagnostics["spreadPlan"]["rightCandidateRoute"], "otsu");
    }
}

#[test]
fn classify_only_batch_writes_metadata_and_ndjson_but_no_output_images() {
    let scratch = Scratch::new("classify");
    let spread_input = scratch.path("classify-spread-input.png");
    let single_input = scratch.path("classify-single-input.png");
    let spread_output = scratch.path("classify-spread-output.png");
    let single_output = scratch.path("classify-single-output.png");
    let spread_output_metadata = scratch.path("classify-spread-output.json");
    let single_output_metadata = scratch.path("classify-single-output.json");
    let spread_page_metadata = scratch.path("classify-spread-page.json");
    let single_page_metadata = scratch.path("classify-single-page.json");
    let manifest = scratch.path("classify-manifest.json");

    let mut spread = GrayImage::new(320, 200, 245);
    for y in (35..165).step_by(14) {
        for x in 24..142 {
            spread.set(x, y, 18);
            spread.set(x, y + 1, 18);
        }
        for x in 178..296 {
            spread.set(x, y, 22);
            spread.set(x, y + 1, 22);
        }
    }
    for y in 4..196 {
        spread.set(159, y, 105);
        spread.set(160, y, 175);
    }
    let mut single = GrayImage::new(180, 280, 245);
    for y in (32..248).step_by(16) {
        for x in 22..158 {
            single.set(x, y, 20);
            single.set(x, y + 1, 20);
        }
    }
    fs::write(&spread_input, encode_gray(&spread).unwrap()).unwrap();
    fs::write(&single_input, encode_gray(&single).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "analyze",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [
            {
                "inputPath": spread_input,
                "sourcePageIndex": 0,
                "pageMetadataPath": spread_page_metadata,
                "options": {
                    "dpi": 150,
                    "normalizeIllumination": false
                },
                "outputs": [{
                    "outputPath": spread_output,
                    "metadataPath": spread_output_metadata
                }]
            },
            {
                "inputPath": single_input,
                "sourcePageIndex": 1,
                "pageMetadataPath": single_page_metadata,
                "options": {
                    "dpi": 150,
                    "layout": "force-single",
                    "normalizeIllumination": false
                },
                "outputs": [{
                    "outputPath": single_output,
                    "metadataPath": single_output_metadata
                }]
            }
        ]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    let progress = String::from_utf8(result.stdout).unwrap();
    let lines = progress
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|line| line["progress"]["stage"] == "page-complete")
        .collect::<Vec<_>>();
    assert_eq!(lines[0]["progress"]["classification"], "two-page-spread");
    assert!(lines[0]["progress"]["confidence"].as_f64().is_some());
    assert!(lines[0]["progress"]["cutterXPx"].as_f64().is_some());
    assert_eq!(lines[1]["progress"]["classification"], "single-uncut-page");
    assert_eq!(lines[1]["progress"]["confidence"], 1.0);
    assert!(lines[1]["progress"].get("cutterXPx").is_none());
    assert_eq!(lines[1]["progress"]["textAxis"]["sideways"], false);
    assert!(lines[1]["progress"]["textAxis"]["confidence"]
        .as_f64()
        .is_some_and(|confidence| (0.0..=1.0).contains(&confidence)));

    let spread_metadata: Value =
        serde_json::from_slice(&fs::read(&spread_page_metadata).unwrap()).unwrap();
    let single_metadata: Value =
        serde_json::from_slice(&fs::read(&single_page_metadata).unwrap()).unwrap();
    assert_eq!(spread_metadata["layoutClassification"], "two-page-spread");
    assert_eq!(single_metadata["layoutClassification"], "single-uncut-page");
    let split_diagnostics = &spread_metadata["splitDiagnostics"];
    assert!(split_diagnostics["aspectRatio"].as_f64().is_some());
    assert!(split_diagnostics["whitespaceScore"].as_f64().is_some());
    assert!(split_diagnostics["bilateralScore"].as_f64().is_some());
    assert!(split_diagnostics["outerMarginScore"].as_f64().is_some());
    assert!(split_diagnostics["foldScore"].as_f64().is_some());
    assert!(split_diagnostics["gutterDarknessScore"].as_f64().is_some());
    assert!(split_diagnostics["softGutterCoverage"].as_f64().is_some());
    assert!(split_diagnostics["softGutterContinuity"].as_f64().is_some());
    assert!(split_diagnostics["gutterGatePassed"].as_bool().is_some());
    assert!(split_diagnostics["evidenceAgreementGatePassed"]
        .as_bool()
        .is_some());
    assert!(split_diagnostics["sparseSpreadRecovered"]
        .as_bool()
        .is_some());
    assert_eq!(
        single_metadata["textAxis"],
        lines[1]["progress"]["textAxis"]
    );
    for output in [
        &spread_output,
        &single_output,
        &spread_output_metadata,
        &single_output_metadata,
    ] {
        assert!(!output.exists(), "classify-only wrote {}", output.display());
    }
}

#[test]
fn classify_only_inside_page_options_with_declared_outputs_writes_no_images() {
    let scratch = Scratch::new("nested-classify");
    let input = scratch.path("nested-classify-input.png");
    let output_first = scratch.path("nested-classify-first.png");
    let output_second = scratch.path("nested-classify-second.png");
    let metadata_first = scratch.path("nested-classify-first.json");
    let metadata_second = scratch.path("nested-classify-second.json");
    let manifest = scratch.path("nested-classify-manifest.json");

    let mut image = GrayImage::new(180, 280, 245);
    for y in (32..248).step_by(16) {
        for x in 22..158 {
            image.set(x, y, 20);
            image.set(x, y + 1, 20);
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "analyze",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 40,
            "pageMetadataPath": metadata_first,
            "options": {
                "dpi": 150.0,
                "layout": "auto",
                "normalizeIllumination": false
            },
            "outputs": [
                {"outputPath": output_first, "metadataPath": metadata_first},
                {"outputPath": output_second, "metadataPath": metadata_second}
            ]
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    let progress = String::from_utf8(result.stdout).unwrap();
    let lines = progress
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let completed = lines
        .iter()
        .find(|line| line["progress"]["stage"] == "page-complete")
        .unwrap();
    assert!(completed["progress"]["classification"].as_str().is_some());
    assert_eq!(completed["progress"]["outputPaths"], serde_json::json!([]));

    let metadata: Value = serde_json::from_slice(&fs::read(&metadata_first).unwrap()).unwrap();
    assert_eq!(metadata["sourcePageIndex"], 40);
    assert!(metadata["layoutClassification"].as_str().is_some());
    assert_eq!(metadata["outputCount"], 1);
    for output in [&output_first, &output_second] {
        assert!(!output.exists(), "classify-only wrote {}", output.display());
    }
    assert!(
        !metadata_second.exists(),
        "classify-only wrote per-output metadata instead of one page sidecar"
    );
}

#[test]
fn parallel_batch_outputs_and_progress_are_deterministic() {
    let scratch = Scratch::new("parallel-determinism");
    let input = scratch.path("parallel-determinism-input.png");
    let manifest = scratch.path("parallel-determinism-manifest.json");
    let mut image = GrayImage::new(620, 440, 242);
    let mut state = 0xd37e_4a91_u64;
    for y in 0..image.height() {
        for x in 0..image.width() {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            image.set(x, y, 232 + ((state >> 61) as u8));
        }
    }
    for y in (48..392).step_by(17) {
        for x in 52..568 {
            if x % 29 < 21 {
                image.set(x, y, 28);
                image.set(x, y + 1, 28);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let artifacts = (0..4)
        .map(|index| {
            (
                scratch.path(&format!("parallel-determinism-{index}.png")),
                scratch.path(&format!("parallel-determinism-{index}.json")),
            )
        })
        .collect::<Vec<_>>();
    let pages = artifacts
        .iter()
        .enumerate()
        .map(|(index, (output, metadata))| {
            serde_json::json!({
                "inputPath": input,
                "sourcePageIndex": index,
                "pageMetadataPath": scratch.path(&format!("parallel-determinism-page-{index}.json")),
                "options": {
                    "dpi": 150,
                    "layout": "force-single",
                    "cropContent": false,
                    "matchPageSize": false,
                    "outputMode": "bw"
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}]
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap()
    };
    let first = run();
    assert!(
        first.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first_artifacts = artifacts
        .iter()
        .map(|(output, metadata)| (fs::read(output).unwrap(), fs::read(metadata).unwrap()))
        .collect::<Vec<_>>();
    let second = run();
    assert!(
        second.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&second.stderr)
    );
    let stable_progress = |bytes: &[u8]| {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(|line| {
                let mut value = serde_json::from_str::<Value>(line).unwrap();
                value
                    .get_mut("progress")
                    .and_then(Value::as_object_mut)
                    .map(|progress| progress.remove("stageTimings"));
                value
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        stable_progress(&first.stdout),
        stable_progress(&second.stdout)
    );
    let progress = String::from_utf8(second.stdout).unwrap();
    let completed_pages = progress
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["progress"]["stage"] == "page-complete")
        .map(|event| event["progress"]["pageNumber"].as_u64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(completed_pages, vec![1, 2, 3, 4]);
    for ((output, metadata), (expected_output, expected_metadata)) in
        artifacts.iter().zip(first_artifacts)
    {
        assert_eq!(fs::read(output).unwrap(), expected_output);
        assert_eq!(fs::read(metadata).unwrap(), expected_metadata);
    }
}

#[cfg(unix)]
#[test]
fn sigterm_terminates_parallel_batch_promptly() {
    let scratch = Scratch::new("sigterm");
    let input = scratch.path("sigterm-input.png");
    let manifest = scratch.path("sigterm-manifest.json");
    let image = GrayImage::new(2_400, 1_800, 238);
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let metadata_paths = (0..12)
        .map(|index| scratch.path(&format!("sigterm-page-{index}.json")))
        .collect::<Vec<_>>();
    let pages = metadata_paths
        .iter()
        .enumerate()
        .map(|(index, metadata)| {
            serde_json::json!({
                "inputPath": input,
                "sourcePageIndex": index,
                "pageMetadataPath": metadata,
                "options": {
                    "dpi": 150,
                    "layout": "auto"
                },
                "outputs": []
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "analyze",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut started_line = String::new();
    stdout.read_line(&mut started_line).unwrap();
    let started_event: Value = serde_json::from_str(&started_line).unwrap();
    assert_eq!(started_event["progress"]["stage"], "started");
    assert!(
        child.try_wait().unwrap().is_none(),
        "fixture finished before SIGTERM"
    );
    let started = Instant::now();
    let status = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    let exit = loop {
        if let Some(exit) = child.try_wait().unwrap() {
            break exit;
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "SIGTERM was not prompt"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(!exit.success());
}

#[test]
fn batch_applies_per_output_placement_over_document_default() {
    let scratch = Scratch::new("uniform");
    let input_small = scratch.path("uniform-small-input.png");
    let input_large = scratch.path("uniform-large-input.png");
    let output_small = scratch.path("uniform-small-output.png");
    let output_large = scratch.path("uniform-large-output.png");
    let metadata_small = scratch.path("uniform-small-metadata.json");
    let metadata_large = scratch.path("uniform-large-metadata.json");
    let manifest = scratch.path("uniform-manifest.json");
    let mut small = GrayImage::new(80, 60, 255);
    for y in [7, 18, 29] {
        for x in 5..25 {
            small.set(x, y, 0);
            small.set(x, y + 1, 0);
            small.set(x, y + 2, 0);
        }
        for x in 31..51 {
            small.set(x, y, 0);
            small.set(x, y + 1, 0);
            small.set(x, y + 2, 0);
        }
    }
    let mut large = GrayImage::new(100, 90, 255);
    for y in [9, 22, 35, 48] {
        for x in 8..34 {
            large.set(x, y, 0);
            large.set(x, y + 1, 0);
            large.set(x, y + 2, 0);
        }
        for x in 42..68 {
            large.set(x, y, 0);
            large.set(x, y + 1, 0);
            large.set(x, y + 2, 0);
        }
    }
    fs::write(&input_small, encode_gray(&small).unwrap()).unwrap();
    fs::write(&input_large, encode_gray(&large).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 24.0,
            "heightPoints": 21.6,
            "widthPx": 100,
            "heightPx": 90
        },
        "pages": [
            {
                "inputPath": input_small,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("uniform-small-page.json"),
                "options": {
                    "dpi": 300,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": false,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "pageAlignment": "top-left",
                    "placementOverrides": {"full": "bottom-right"}
                },
                "outputs": [{"outputPath": output_small, "metadataPath": metadata_small}]
            },
            {
                "inputPath": input_large,
                "sourcePageIndex": 1,
                "pageMetadataPath": scratch.path("uniform-large-page.json"),
                "options": {
                    "dpi": 300,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": false,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "pageAlignment": "top-left"
                },
                "outputs": [{"outputPath": output_large, "metadataPath": metadata_large}]
            }
        ]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    let matched_small = decode_gray(&fs::read(&output_small).unwrap(), 20_000, 200).unwrap();
    let matched_large = decode_gray(&fs::read(&output_large).unwrap(), 20_000, 200).unwrap();
    assert_eq!((matched_small.width(), matched_small.height()), (100, 90));
    assert_eq!((matched_large.width(), matched_large.height()), (100, 90));
    assert!((15..90).any(|y| (0..100).any(|x| matched_small.get(x, y) < 200)));
    // Native final output owns the document canvas; metadata retains the
    // intrinsic content dimensions and the offset inside that canvas.

    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata_small).unwrap()).unwrap();
    assert_eq!(
        metadata_json["softMarginsPx"],
        serde_json::json!([0, 15, 0, 0])
    );
    assert_eq!(metadata_json["uniformCanvas"], true);
    assert_eq!(metadata_json["outputWidthPx"], 100);
    assert_eq!(metadata_json["outputHeightPx"], 75);
    assert_eq!(metadata_json["matchedCanvasContentWidthPx"], 100);
    assert_eq!(metadata_json["matchedCanvasContentHeightPx"], 75);
    assert_eq!(metadata_json["canvasWidthPx"], 100);
    assert_eq!(metadata_json["canvasHeightPx"], 90);
    assert_eq!(metadata_json["placementOffsetXPx"], 0);
    assert_eq!(metadata_json["placementOffsetYPx"], 15);
    assert_native_canvas_owns_image(&metadata_json);
    assert_eq!(metadata_json["forwardTransform"]["matrix"][0][2], 0.0);
    assert_eq!(metadata_json["forwardTransform"]["matrix"][1][2], 0.0);

    let mut preview_payload = payload;
    preview_payload["renderMode"] = Value::String("preview".into());
    preview_payload["canvasScope"] = Value::String("page".into());
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&preview_payload).unwrap(),
    )
    .unwrap();
    let preview_result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        preview_result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&preview_result.stderr)
    );
    let intrinsic_small = decode_gray(&fs::read(&output_small).unwrap(), 20_000, 200).unwrap();
    let intrinsic_large = decode_gray(&fs::read(&output_large).unwrap(), 20_000, 200).unwrap();
    assert_eq!(
        (intrinsic_small.width(), intrinsic_small.height()),
        (80, 60)
    );
    assert_eq!(
        (intrinsic_large.width(), intrinsic_large.height()),
        (100, 90)
    );
    let preview_metadata: Value =
        serde_json::from_slice(&fs::read(&metadata_small).unwrap()).unwrap();
    assert_eq!(preview_metadata["canvasWidthPx"], 100);
    assert_eq!(preview_metadata["canvasHeightPx"], 90);
    assert_eq!(preview_metadata["placementOffsetXPx"], 0);
    assert_eq!(preview_metadata["placementOffsetYPx"], 15);
    // A preview keeps the raster it rendered and reports the box it belongs
    // in, which is the box the final run resampled its own raster into.
    assert_eq!(preview_metadata["outputWidthPx"], 80);
    assert_eq!(preview_metadata["matchedCanvasContentWidthPx"], 100);
    assert_eq!(preview_metadata["matchedCanvasContentHeightPx"], 75);
    for metadata_path in [&metadata_small, &metadata_large] {
        let metadata: Value = serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
        let content_width = metadata["matchedCanvasContentWidthPx"].as_u64().unwrap();
        let content_height = metadata["matchedCanvasContentHeightPx"].as_u64().unwrap();
        let canvas_width = metadata["canvasWidthPx"].as_u64().unwrap();
        let canvas_height = metadata["canvasHeightPx"].as_u64().unwrap();
        let offset_x = metadata["placementOffsetXPx"].as_u64().unwrap();
        let offset_y = metadata["placementOffsetYPx"].as_u64().unwrap();
        assert!(canvas_width >= content_width);
        assert!(canvas_height >= content_height);
        assert!(offset_x + content_width <= canvas_width);
        assert!(offset_y + content_height <= canvas_height);
    }
}

#[test]
fn matched_canvas_real_binary_keeps_native_density_on_one_physical_rectangle() {
    let scratch = Scratch::new("matched-physical");
    let manifest = scratch.path("matched-physical-manifest.json");
    let mut pages = Vec::new();
    let mut outputs = Vec::new();
    let mut metadata_paths = Vec::new();
    // The same one-inch-square page scanned at 100 and at 200 DPI. Their PDF
    // rectangles agree; only the pixels the scanner produced differ.
    for (index, (dimension, dpi)) in [(100usize, 100), (200usize, 200)].into_iter().enumerate() {
        let input = scratch.path(&format!("matched-physical-input-{index}.png"));
        let output = scratch.path(&format!("matched-physical-output-{index}.png"));
        let metadata = scratch.path(&format!("matched-physical-metadata-{index}.json"));
        let mut image = GrayImage::new(dimension, dimension, 255);
        // A bar covering the middle fifth of the page, in page-relative terms,
        // so a normalized document puts it at the same place on every page.
        for y in (dimension * 2 / 5)..(dimension * 3 / 5) {
            for x in (dimension / 10)..(dimension * 9 / 10) {
                image.set(x, y, 0);
            }
        }
        fs::write(&input, encode_gray(&image).unwrap()).unwrap();
        pages.push(serde_json::json!({
            "inputPath": input,
            "sourcePageIndex": index,
            "pageMetadataPath": scratch.path(&format!("matched-physical-page-{index}.json")),
            "options": {
                "dpi": dpi,
                "layout": "force-single",
                "normalizeIllumination": false,
                "cropContent": false,
                "outputMode": "grayscale",
                "matchPageSize": true
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata}]
        }));
        outputs.push(output);
        metadata_paths.push(metadata);
    }
    let color_input = scratch.path("matched-physical-color-input.png");
    let color_output = scratch.path("matched-physical-color-output.png");
    let color_metadata = scratch.path("matched-physical-color-metadata.json");
    let mut color_image = RgbImage::new(80, 60, [248; 3]);
    for y in 10..50 {
        for x in 15..65 {
            color_image.set(x, y, [30, 90, 180]);
        }
    }
    fs::write(&color_input, encode_rgb(&color_image).unwrap()).unwrap();
    pages.push(serde_json::json!({
        "inputPath": color_input,
        "sourcePageIndex": 2,
        "pageMetadataPath": scratch.path("matched-physical-color-page.json"),
        "options": {
            "dpi": 100,
            "layout": "force-single",
            "normalizeIllumination": false,
            "cropContent": false,
            "outputMode": "color",
            "matchPageSize": true,
            "pageAlignment": "center"
        },
        "outputs": [{"outputPath": color_output, "metadataPath": color_metadata}]
    }));
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "documentCanvas": {
                "widthPoints": 72.0,
                "heightPoints": 72.0,
                "widthPx": 200,
                "heightPx": 200
            },
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    let mut normalized_ink_extents = Vec::new();
    for index in 0..2 {
        let image = decode_gray(&fs::read(&outputs[index]).unwrap(), 50_000, 300).unwrap();
        let metadata: Value =
            serde_json::from_slice(&fs::read(&metadata_paths[index]).unwrap()).unwrap();
        let expected_dimension = if index == 0 { 100 } else { 200 };
        assert_eq!(
            (image.width(), image.height()),
            (expected_dimension, expected_dimension),
            "continuous-tone pages must retain their source density"
        );
        assert_eq!(metadata["canvasPolicy"], "strict-maximum");
        assert_eq!(metadata["canvasOverflow"], false);
        assert_eq!(metadata["matchedCanvasContentWidthPx"], expected_dimension);
        assert_eq!(metadata["matchedCanvasContentHeightPx"], expected_dimension);
        assert_native_canvas_owns_image(&metadata);
        let ink_rows = (0..image.height())
            .filter(|&y| (0..image.width()).any(|x| image.get(x, y) < 128))
            .collect::<Vec<_>>();
        assert!(!ink_rows.is_empty(), "the bar was lost");
        normalized_ink_extents.push((
            *ink_rows.first().unwrap() as f64 / image.height() as f64,
            *ink_rows.last().unwrap() as f64 / image.height() as f64,
        ));
    }
    let first = normalized_ink_extents[0];
    let second = normalized_ink_extents[1];
    for (low, high) in [(first.0, second.0), (first.1, second.1)] {
        let difference = low - high;
        assert!(
            difference.abs() <= 0.02,
            "physical bar placement disagrees by {difference:.4}"
        );
    }
    let color_raster = decode_gray(&fs::read(color_output).unwrap(), 50_000, 300).unwrap();
    assert_eq!((color_raster.width(), color_raster.height()), (100, 100));
    let color_metadata: Value = serde_json::from_slice(&fs::read(color_metadata).unwrap()).unwrap();
    assert_eq!(color_metadata["outputMode"], "color");
    assert_eq!(color_metadata["outputWidthPx"], 100);
    assert_eq!(color_metadata["outputHeightPx"], 75);
    assert_native_canvas_owns_image(&color_metadata);
}

#[test]
fn matched_canvas_fits_an_oversized_page_instead_of_growing_the_document() {
    let scratch = Scratch::new("matched-oversized");
    let manifest = scratch.path("matched-oversized-manifest.json");
    let mut pages = Vec::new();
    let mut outputs = Vec::new();
    let mut metadata_paths = Vec::new();
    // A portrait canvas page and a landscape page half again as wide as the
    // canvas: neither may resize the document.
    for (index, (width, height)) in [(100usize, 140usize), (210usize, 100usize)]
        .into_iter()
        .enumerate()
    {
        let input = scratch.path(&format!("matched-oversized-input-{index}.png"));
        let output = scratch.path(&format!("matched-oversized-output-{index}.png"));
        let metadata = scratch.path(&format!("matched-oversized-metadata-{index}.json"));
        let mut image = GrayImage::new(width, height, 255);
        for y in (height / 4)..(height / 2) {
            for x in (width / 4)..(width / 2) {
                image.set(x, y, 0);
            }
        }
        fs::write(&input, encode_gray(&image).unwrap()).unwrap();
        pages.push(serde_json::json!({
            "inputPath": input,
            "sourcePageIndex": index,
            "pageMetadataPath": scratch.path(&format!("matched-oversized-page-{index}.json")),
            "options": {
                "dpi": 300,
                "layout": "force-single",
                "normalizeIllumination": false,
                "cropContent": false,
                "outputMode": "grayscale",
                "matchPageSize": true,
                "pageAlignment": "center"
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata}]
        }));
        outputs.push(output);
        metadata_paths.push(metadata);
    }
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "documentCanvas": {
                "widthPoints": 24.0,
                "heightPoints": 33.6,
                "widthPx": 100,
                "heightPx": 140
            },
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    for (index, metadata_path) in metadata_paths.iter().enumerate() {
        let image = decode_gray(&fs::read(&outputs[index]).unwrap(), 50_000, 300).unwrap();
        let metadata: Value = serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
        let expected_dimensions = (100, 140);
        assert_eq!((image.width(), image.height()), expected_dimensions);
        assert_eq!(metadata["canvasWidthPx"], 100);
        assert_eq!(metadata["canvasHeightPx"], 140);
        let content_width = metadata["matchedCanvasContentWidthPx"].as_f64().unwrap();
        let content_height = metadata["matchedCanvasContentHeightPx"].as_f64().unwrap();
        assert!(content_width <= 100.0 && content_height <= 140.0);
        if index == 1 {
            // The landscape page is fitted by its width and padded above and
            // below; its shape survives the fit.
            assert_eq!(content_width, 100.0);
            assert!(
                (content_width / content_height - 210.0 / 100.0).abs() < 0.05,
                "the oversized page lost its aspect ratio ({content_width}x{content_height})"
            );
            assert!(metadata["placementOffsetYPx"].as_f64().unwrap() > 0.0);
        }
        assert_native_canvas_owns_image(&metadata);
    }
}

#[test]
fn matched_canvas_keeps_rotation_and_margins_inside_the_document_rectangle() {
    let scratch = Scratch::new("matched-rotation");
    let manifest = scratch.path("matched-rotation-manifest.json");
    let mut pages = Vec::new();
    let mut outputs = Vec::new();
    let mut metadata_paths = Vec::new();
    for index in 0..2 {
        let input = scratch.path(&format!("matched-rotation-input-{index}.png"));
        let output = scratch.path(&format!("matched-rotation-output-{index}.png"));
        let metadata = scratch.path(&format!("matched-rotation-metadata-{index}.json"));
        let mut image = GrayImage::new(240, 320, 250);
        for y in (40..280).step_by(12) {
            for x in 30..210 {
                image.set(x, y, 12);
                image.set(x, y + 1, 12);
            }
        }
        fs::write(&input, encode_gray(&image).unwrap()).unwrap();
        pages.push(serde_json::json!({
            "inputPath": input,
            "sourcePageIndex": index,
            "pageMetadataPath": scratch.path(&format!("matched-rotation-page-{index}.json")),
            "options": {
                "dpi": 300,
                "layout": "force-single",
                "normalizeIllumination": false,
                // Cropping with the default 5 mm margins on every side. Any
                // part beyond the scan becomes white output paper, and the
                // complete padded raster is fitted inside this rectangle.
                "cropContent": true,
                "margins": {"leftMm": 5, "topMm": 5, "rightMm": 5, "bottomMm": 5},
                "outputMode": "grayscale",
                "matchPageSize": true,
                "pageAlignment": "center",
                "rotationDegrees": if index == 1 { 90 } else { 0 }
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata}]
        }));
        outputs.push(output);
        metadata_paths.push(metadata);
    }
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "documentCanvas": {
                "widthPoints": 57.6,
                "heightPoints": 76.8,
                "widthPx": 240,
                "heightPx": 320
            },
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    for (index, metadata_path) in metadata_paths.iter().enumerate() {
        let image = decode_gray(&fs::read(&outputs[index]).unwrap(), 300_000, 500).unwrap();
        let metadata: Value = serde_json::from_slice(&fs::read(metadata_path).unwrap()).unwrap();
        assert_eq!((image.width(), image.height()), (240, 320));
        assert_eq!(metadata["canvasWidthPx"], 240);
        assert_eq!(metadata["canvasHeightPx"], 320);
        assert!(metadata["matchedCanvasContentWidthPx"].as_f64().unwrap() <= 240.0);
        assert!(metadata["matchedCanvasContentHeightPx"].as_f64().unwrap() <= 320.0);
        assert_native_canvas_owns_image(&metadata);
    }
}

#[test]
fn matched_canvas_preview_places_a_page_exactly_where_the_final_run_does() {
    let scratch = Scratch::new("matched-preview");
    let manifest = scratch.path("matched-preview-manifest.json");
    let input = scratch.path("matched-preview-input.png");
    let output = scratch.path("matched-preview-output.png");
    let metadata_path = scratch.path("matched-preview-metadata.json");
    let mut image = GrayImage::new(80, 60, 255);
    for y in 12..40 {
        for x in 10..70 {
            if y % 6 < 2 {
                image.set(x, y, 15);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 33.6,
            "heightPoints": 24.0,
            "widthPx": 140,
            "heightPx": 100
        },
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": scratch.path("matched-preview-page.json"),
            "options": {
                "dpi": 300,
                "layout": "force-single",
                "normalizeIllumination": false,
                "cropContent": true,
                "outputMode": "grayscale",
                "matchPageSize": true,
                "pageAlignment": "center",
                "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0},
                "automaticContentBoxes": {
                    "full": {
                        "xNormalized": 0.125,
                        "yNormalized": 0.2,
                        "widthNormalized": 0.75,
                        "heightNormalized": 0.4666666666666667,
                        "rotationDegrees": 0
                    }
                }
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata_path}]
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let run = || {
        let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "stderr={}",
            String::from_utf8_lossy(&result.stderr)
        );
        let metadata: Value = serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        let image = decode_gray(&fs::read(&output).unwrap(), 50_000, 300).unwrap();
        (metadata, (image.width(), image.height()))
    };
    let (final_metadata, final_dimensions) = run();

    let mut preview_payload = payload;
    preview_payload["renderMode"] = Value::String("preview".into());
    preview_payload["canvasScope"] = Value::String("page".into());
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&preview_payload).unwrap(),
    )
    .unwrap();
    let (preview_metadata, preview_dimensions) = run();

    for field in [
        "canvasWidthPx",
        "canvasHeightPx",
        "matchedCanvasTargetWidthPoints",
        "matchedCanvasTargetHeightPoints",
        "matchedCanvasContentWidthPx",
        "matchedCanvasContentHeightPx",
        "placementOffsetXPx",
        "placementOffsetYPx",
    ] {
        assert_eq!(
            preview_metadata[field], final_metadata[field],
            "preview and final disagree about {field}"
        );
    }
    // Final native output owns the target canvas; preview retains its intrinsic
    // payload while reporting the same placement metadata.
    assert_eq!(final_dimensions, (140, 100));
    assert_eq!(preview_dimensions, (60, 28));
    assert_eq!(final_metadata["outputWidthPx"], 100);
    assert_eq!(preview_metadata["outputWidthPx"], 60);
    assert_eq!(final_metadata["placementOffsetXPx"], 20);
    assert_eq!(final_metadata["placementOffsetYPx"], 26);
    assert_native_canvas_owns_image(&final_metadata);
    assert!(preview_metadata["pdfImagePlacement"].is_null());
}

#[test]
fn matched_canvas_preview_matches_final_placement_for_a_sparse_wide_spread_leaf() {
    let scratch = Scratch::new("matched-sparse-spread-preview");
    let manifest = scratch.path("matched-sparse-spread-preview-manifest.json");
    let input = scratch.path("matched-sparse-spread-preview-input.png");
    let output_left = scratch.path("matched-sparse-spread-preview-left.png");
    let output_right = scratch.path("matched-sparse-spread-preview-right.png");
    let metadata_left = scratch.path("matched-sparse-spread-preview-left.json");
    let metadata_right = scratch.path("matched-sparse-spread-preview-right.json");
    let mut image = GrayImage::new(240, 200, 255);
    // The off-centre split makes the left intrinsic raster wider than its
    // 120 px paper frame. Its sparse title is biased toward the outer edge,
    // so centering needs the white fold tail to overhang the opposite edge.
    // This must exercise the in-memory `run_page` placement, not only the
    // deferred placement helper used after analysis.
    for y in (55..145).step_by(15) {
        for x in 10..60 {
            if (x / 8 + y / 5) % 3 != 0 {
                image.set(x, y, 20);
            }
        }
    }
    for y in (45..155).step_by(14) {
        for x in 155..225 {
            if (x / 7 + y / 4) % 3 != 0 {
                image.set(x, y, 25);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 86.4,
            "heightPoints": 144.0,
            "widthPx": 120,
            "heightPx": 200
        },
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": scratch.path("matched-sparse-spread-preview-page.json"),
            "options": {
                "dpi": 100,
                "layout": "force-two-page",
                "manualSplit": {
                    "xNormalized": 0.55,
                    "rotationDegrees": 0
                },
                "normalizeIllumination": false,
                "cropContent": true,
                "outputMode": "bw",
                "matchPageSize": true,
                "pageAlignment": "top-center",
                "margins": {
                    "leftMm": 1.27,
                    "topMm": 0,
                    "rightMm": 1.27,
                    "bottomMm": 0
                },
                "manualContentBoxes": {
                    "left": {
                        "xNormalized": 0,
                        "yNormalized": 0,
                        "widthNormalized": 0.55,
                        "heightNormalized": 1,
                        "rotationDegrees": 0
                    },
                    "right": {
                        "xNormalized": 0.55,
                        "yNormalized": 0,
                        "widthNormalized": 0.45,
                        "heightNormalized": 1,
                        "rotationDegrees": 0
                    }
                }
            },
            "outputs": [
                {"outputPath": output_left, "metadataPath": metadata_left},
                {"outputPath": output_right, "metadataPath": metadata_right}
            ]
        }]
    });
    let run = |payload: &Value| {
        fs::write(&manifest, serde_json::to_vec_pretty(payload).unwrap()).unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "stderr={}",
            String::from_utf8_lossy(&result.stderr)
        );
        [
            serde_json::from_slice::<Value>(&fs::read(&metadata_left).unwrap()).unwrap(),
            serde_json::from_slice::<Value>(&fs::read(&metadata_right).unwrap()).unwrap(),
        ]
    };
    let final_metadata = run(&payload);
    let mut preview_payload = payload;
    preview_payload["renderMode"] = Value::String("preview".into());
    preview_payload["canvasScope"] = Value::String("page".into());
    let preview_metadata = run(&preview_payload);

    for index in 0..2 {
        for field in [
            "matchedCanvasContentWidthPx",
            "placementOffsetXPx",
            "matchedCanvasIntrinsicOverflowLeftPx",
            "matchedCanvasIntrinsicOverflowRightPx",
            "matchedCanvasOpticalPlacement",
            "matchedCanvasOpticalContentLeftPx",
            "matchedCanvasOpticalContentRightPx",
        ] {
            assert_eq!(
                preview_metadata[index][field], final_metadata[index][field],
                "preview and final disagree about {field} for the {} leaf",
                final_metadata[index]["half"],
            );
        }
    }
    let left = &preview_metadata[0];
    assert_eq!(left["half"], "left");
    // The ink box this leaf's sparse title occupies is measured and published,
    // and it does not move the leaf: placement is the one physical policy the
    // lossless assembler and the preview fitter can also state — the retained
    // content rectangle aligned inside the requested margin box.
    assert!(
        left["matchedCanvasOpticalContentLeftPx"].is_number(),
        "{left}"
    );
    assert!(
        left["matchedCanvasOpticalContentRightPx"].is_number(),
        "{left}"
    );
    // The flag is omitted from the artifact when it is false, so both shapes
    // the protocol can emit for "not optically placed" are named here and
    // nothing else — a number or a string would pass a bare inequality.
    assert!(
        matches!(
            left.get("matchedCanvasOpticalPlacement"),
            None | Some(Value::Bool(false))
        ),
        "{left}"
    );
    assert_eq!(
        left["matchedCanvasIntrinsicOverflowLeftPx"]
            .as_u64()
            .unwrap_or(0),
        0,
    );
    assert!(
        left["matchedCanvasIntrinsicOverflowRightPx"]
            .as_u64()
            .unwrap_or(0)
            > 0,
        "fixture did not exercise the fold-side proof used by in-memory placement: {left}",
    );
    assert_native_canvas_owns_image(&final_metadata[0]);
}

#[test]
fn matched_canvas_preview_places_a_spread_at_the_final_shared_vertical_anchor() {
    let scratch = Scratch::new("matched-spread-preview");
    let manifest = scratch.path("matched-spread-preview-manifest.json");
    let input = scratch.path("matched-spread-preview-input.png");
    let output_left = scratch.path("matched-spread-preview-left.png");
    let output_right = scratch.path("matched-spread-preview-right.png");
    let metadata_left = scratch.path("matched-spread-preview-left.json");
    let metadata_right = scratch.path("matched-spread-preview-right.json");
    let mut image = GrayImage::new(160, 1_000, 255);
    for y in 300..700 {
        for x in 10..70 {
            if y % 6 < 2 {
                image.set(x, y, 15);
            }
        }
    }
    for y in 0..400 {
        for x in 90..150 {
            if y % 6 < 2 {
                image.set(x, y, 20);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 57.6,
            "heightPoints": 480.0,
            "widthPx": 120,
            "heightPx": 1000
        },
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": scratch.path("matched-spread-preview-page.json"),
            "options": {
                "dpi": 150,
                "layout": "force-two-page",
                "normalizeIllumination": false,
                "cropContent": false,
                "outputMode": "grayscale",
                "matchPageSize": true,
                "pageAlignment": "center",
                "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
            },
            "outputs": [
                {"outputPath": output_left, "metadataPath": metadata_left},
                {"outputPath": output_right, "metadataPath": metadata_right}
            ]
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let run = || {
        let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "stderr={}",
            String::from_utf8_lossy(&result.stderr)
        );
        (
            [
                serde_json::from_slice::<Value>(&fs::read(&metadata_left).unwrap()).unwrap(),
                serde_json::from_slice::<Value>(&fs::read(&metadata_right).unwrap()).unwrap(),
            ],
            [
                decode_gray(&fs::read(&output_left).unwrap(), 2_000_000, 2_000).unwrap(),
                decode_gray(&fs::read(&output_right).unwrap(), 2_000_000, 2_000).unwrap(),
            ],
        )
    };
    let (final_metadata, final_images) = run();

    let mut preview_payload = payload;
    preview_payload["renderMode"] = Value::String("preview".into());
    preview_payload["canvasScope"] = Value::String("page".into());
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&preview_payload).unwrap(),
    )
    .unwrap();
    let (preview_metadata, preview_images) = run();

    let first_content_row = |image: &GrayImage| {
        (0..image.height()).find(|&y| (0..image.width()).any(|x| image.get(x, y) < 245))
    };

    for index in 0..2 {
        for field in ["placementOffsetYPx", "matchedCanvasIntrinsicOverflowTopPx"] {
            assert_eq!(
                preview_metadata[index][field], final_metadata[index][field],
                "preview and final disagree about {field} for the {} leaf",
                final_metadata[index]["half"],
            );
        }
        assert!(preview_metadata[index]["placementOffsetYPx"]
            .as_u64()
            .is_some());
        let preview_source_row = first_content_row(&preview_images[index]).unwrap() as i64;
        let overflow_top = preview_metadata[index]["matchedCanvasIntrinsicOverflowTopPx"]
            .as_i64()
            .unwrap_or(0);
        let effective_preview_row = preview_source_row - overflow_top;
        assert_eq!(
            first_content_row(&final_images[index]).unwrap() as i64,
            effective_preview_row.max(0),
            "preview and final disagree about visible content rows for the {} leaf",
            final_metadata[index]["half"],
        );
    }
    assert!(
        final_metadata
            .iter()
            .any(|metadata| metadata["matchedCanvasIntrinsicOverflowTopPx"]
                .as_u64()
                .unwrap_or(0)
                > 0),
        "fixture did not exercise a negative spread anchor",
    );
}

/// `maxPixels` is a limit the matched canvas may reach and never pass. The
/// owner measures the grid in `resolveScanCleanupDocumentCanvas` and this
/// process is what enforces it, so the two have to agree on where the boundary
/// is: a grid whose area is exactly the budget renders, and one pixel more is
/// refused outright rather than trimmed. The budget is scaled down to a grid a
/// test can actually render; the comparison it exercises is the same one an A4
/// document at 1200 dpi lands on.
#[test]
fn matched_canvas_renders_at_exactly_the_pixel_budget_and_refuses_one_past_it() {
    let scratch = Scratch::new("matched-canvas-budget");
    let input = scratch.path("budget-input.png");
    let mut image = GrayImage::new(80, 60, 255);
    for y in 12..40 {
        for x in 10..70 {
            if y % 6 < 2 {
                image.set(x, y, 15);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    // 140 x 100 = 14_000 pixels, which is exactly the budget the accepting run
    // is given and one pixel more than the refusing one is.
    let run = |label: &str, max_pixels: u64| {
        let manifest = scratch.path(&format!("budget-{label}-manifest.json"));
        let output = scratch.path(&format!("budget-{label}-output.png"));
        let metadata_path = scratch.path(&format!("budget-{label}-metadata.json"));
        let page_metadata_path = scratch.path(&format!("budget-{label}-page.json"));
        fs::write(
            &manifest,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 3,
                "operation": "render",
                "renderMode": "final",
                "canvasScope": "document",
                "documentCanvas": {
                    "widthPoints": 33.6,
                    "heightPoints": 24.0,
                    "widthPx": 140,
                    "heightPx": 100
                },
                "pages": [{
                    "inputPath": input,
                    "sourcePageIndex": 0,
                    "pageMetadataPath": page_metadata_path,
                    "options": {
                        "dpi": 300,
                        "layout": "force-single",
                        "normalizeIllumination": false,
                        "cropContent": false,
                        "outputMode": "grayscale",
                        "matchPageSize": true,
                        "pageAlignment": "center",
                        "maxPixels": max_pixels
                    },
                    "outputs": [{"outputPath": output, "metadataPath": metadata_path}]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .output()
            .unwrap();
        (result, output, metadata_path, page_metadata_path)
    };

    let (accepted, accepted_output, accepted_metadata, accepted_page_metadata) =
        run("exact", 14_000);
    assert!(
        accepted.status.success(),
        "a canvas of exactly maxPixels has to render; stderr={}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    let rendered = decode_gray(&fs::read(&accepted_output).unwrap(), 14_000, 400).unwrap();
    assert_eq!((rendered.width(), rendered.height()), (140, 100));
    let metadata: Value = serde_json::from_slice(&fs::read(&accepted_metadata).unwrap()).unwrap();
    assert_eq!(metadata["canvasWidthPx"], 140);
    assert_eq!(metadata["canvasHeightPx"], 100);
    assert_native_canvas_owns_image(&metadata);
    assert!(accepted_page_metadata.exists());

    let (refused, refused_output, refused_metadata, refused_page_metadata) = run("over", 13_999);
    assert!(
        !refused.status.success(),
        "a canvas one pixel past maxPixels has to be refused"
    );
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert!(
        stderr.contains("140x100") && stderr.contains("exceeds cleanup guardrails"),
        "stderr={stderr}"
    );
    // A refused canvas leaves nothing half-written behind.
    assert!(!refused_output.exists());
    assert!(!refused_metadata.exists());
    assert!(!refused_page_metadata.exists());
}

#[test]
fn batch_preserves_asymmetric_margin_order_in_named_metadata() {
    let scratch = Scratch::new("asymmetric-margins");
    let input = scratch.path("asymmetric-margins-input.png");
    let output = scratch.path("asymmetric-margins-output.png");
    let metadata = scratch.path("asymmetric-margins-metadata.json");
    let manifest = scratch.path("asymmetric-margins-manifest.json");
    let mut image = GrayImage::new(180, 140, 255);
    for y in (35..105).step_by(12) {
        for word in 0..5 {
            for x in 42 + word * 20..58 + word * 20 {
                image.set(x, y, 20);
                image.set(x, y + 1, 20);
                image.set(x, y + 2, 20);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": scratch.path("asymmetric-margins-page.json"),
            "options": {
                "dpi": 150,
                "layout": "force-single",
                "normalizeIllumination": false,
                "outputMode": "grayscale",
                "cropContent": true,
                "matchPageSize": false,
                "margins": {
                    "leftMm": 7.0 * 25.4 / 150.0,
                    "topMm": 11.0 * 25.4 / 150.0,
                    "rightMm": 17.0 * 25.4 / 150.0,
                    "bottomMm": 23.0 * 25.4 / 150.0
                }
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata}]
        }]
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert_eq!(
        metadata_json["appliedMargins"],
        serde_json::json!({
            "leftPx": 7.0,
            "topPx": 11.0,
            "rightPx": 17.0,
            "bottomPx": 23.0
        })
    );
    let content = &metadata_json["contentBox"];
    let content_x = content["xPx"].as_f64().unwrap();
    let content_y = content["yPx"].as_f64().unwrap();
    let content_right = content_x + content["widthPx"].as_f64().unwrap();
    let content_bottom = content_y + content["heightPx"].as_f64().unwrap();
    assert_eq!(
        metadata_json["outputWidthPx"].as_f64().unwrap(),
        (content_right + 17.0).ceil() - (content_x - 7.0).floor()
    );
    assert_eq!(
        metadata_json["outputHeightPx"].as_f64().unwrap(),
        (content_bottom + 23.0).ceil() - (content_y - 11.0).floor()
    );
}

/// A manifest is data. Without a trusted root, a symlinked output directory
/// inside the run's scratch redirects publication anywhere the process can
/// write; with one, the escape is refused before the transaction stages a
/// single backup.
#[cfg(unix)]
#[test]
fn allowed_path_root_refuses_a_symlinked_output_escape_before_publication() {
    use std::os::unix::fs::symlink;

    let scratch = Scratch::new("allowed-root-escape");
    let root = scratch.path("root");
    let outside = scratch.path("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let input = root.join("escape-input.png");
    fs::write(&input, encode_gray(&GrayImage::new(80, 60, 235)).unwrap()).unwrap();
    let victim = outside.join("victim.png");
    let original = b"unrelated file outside the run root\0with exact bytes";
    fs::write(&victim, original).unwrap();
    symlink(&outside, root.join("escape-dir")).unwrap();

    let manifest = root.join("escape-manifest.json");
    let page_metadata = root.join("escape-page.json");
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": page_metadata,
                "options": CleanupOptions {
                    output_mode: OutputMode::Grayscale,
                    normalize_illumination: false,
                    crop_content: false,
                    match_page_size: false,
                    ..CleanupOptions::default()
                },
                "outputs": [{
                    "outputPath": root.join("escape-dir/victim.png"),
                    "metadataPath": root.join("escape-output.json"),
                }],
            }],
        }))
        .unwrap(),
    )
    .unwrap();

    let constrained = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .args(["--allowed-path-root", root.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(!constrained.status.success());
    let envelope: Value = serde_json::from_slice(&constrained.stderr).unwrap();
    assert_eq!(envelope["code"], "invalid-request");
    assert!(
        envelope["message"]
            .as_str()
            .unwrap()
            .contains("escapes the allowed path root"),
        "{envelope}"
    );
    assert_eq!(fs::read(&victim).unwrap(), original);
    assert!(!page_metadata.exists());
    assert!(fs::read_dir(&outside).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".evb-tmp-")));

    // The same manifest without a root is still accepted for external CLI
    // users, and it really does publish outside the run root. That is the
    // behavior the flag exists to stop.
    let unconstrained = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(
        unconstrained.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&unconstrained.stdout),
        String::from_utf8_lossy(&unconstrained.stderr)
    );
    assert_ne!(fs::read(&victim).unwrap(), original);
}

/// The root itself is validated before any manifest path is judged against it.
#[test]
fn allowed_path_root_must_be_an_existing_directory() {
    let scratch = Scratch::new("allowed-root-shape");
    let input = scratch.path("root-shape-input.png");
    fs::write(&input, encode_gray(&GrayImage::new(40, 30, 240)).unwrap()).unwrap();
    let manifest = scratch.path("root-shape-manifest.json");
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "analyze",
            "renderMode": "preview",
            "canvasScope": "page",
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("root-shape-page.json"),
                "options": unmatched_options(),
                "outputs": [],
            }],
        }))
        .unwrap(),
    )
    .unwrap();

    for (root, expected) in [
        (scratch.path("no-such-root"), "not an existing directory"),
        (input.clone(), "not a directory"),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
            .args(["--manifest", manifest.to_str().unwrap()])
            .args(["--allowed-path-root", root.to_str().unwrap()])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "root: {}", root.display());
        let envelope: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(envelope["code"], "invalid-request");
        assert!(
            envelope["message"].as_str().unwrap().contains(expected),
            "{envelope}"
        );
    }

    // The same manifest is accepted when the root really holds every path.
    let accepted = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .args(["--allowed-path-root", scratch.dir.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        accepted.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&accepted.stdout),
        String::from_utf8_lossy(&accepted.stderr)
    );
    assert!(scratch.path("root-shape-page.json").exists());
}

#[cfg(unix)]
#[test]
fn final_render_publishes_each_page_without_a_whole_document_analysis_pass() {
    let scratch = Scratch::new("incremental-final");
    let input = scratch.path("incremental-input.png");
    let gated_input = scratch.path("incremental-gate.fifo");
    let manifest = scratch.path("incremental-manifest.json");
    let encoded = encode_gray(&GrayImage::new(160, 120, 245)).unwrap();
    fs::write(&input, &encoded).unwrap();
    assert!(Command::new("mkfifo")
        .arg(&gated_input)
        .status()
        .unwrap()
        .success());
    let pages = [&input, &gated_input]
        .into_iter()
        .enumerate()
        .map(|(index, page_input)| {
            serde_json::json!({
                "inputPath": page_input,
                "sourcePageIndex": index,
                "pageMetadataPath": scratch.path(&format!("incremental-page-{index}.json")),
                "options": unmatched_options(),
                "outputs": [{
                    "outputPath": scratch.path(&format!("incremental-{index}.png")),
                    "metadataPath": scratch.path(&format!("incremental-{index}-output.json")),
                }],
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": pages,
        }))
        .unwrap(),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        // A FIFO input and outputs that do not exist yet stay valid under a
        // trusted root: containment judges where they resolve, not whether
        // they are ordinary files that already exist.
        .args(["--allowed-path-root", scratch.dir.to_str().unwrap()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            sender
                .send(serde_json::from_str::<Value>(&line.unwrap()).unwrap())
                .unwrap();
        }
    });

    let first_complete = loop {
        match receiver.recv_timeout(Duration::from_secs(60)) {
            Ok(event) if event["progress"]["stage"] == "page-complete" => break event,
            Ok(event) => assert_ne!(
                event["progress"]["stage"], "page-analyzed",
                "a final render must not classify pages in a separate pass"
            ),
            Err(error) => {
                let _ = child.kill();
                panic!("no page completed while the second page was still gated: {error}");
            }
        }
    };
    assert_eq!(first_complete["progress"]["pageNumber"], 1);
    assert_eq!(first_complete["progress"]["completedPages"], 1);
    assert!(scratch.path("incremental-0.png").exists());
    assert!(
        child.try_wait().unwrap().is_none(),
        "the gated second page should keep the batch running"
    );

    fs::write(&gated_input, encoded).unwrap();
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    assert!(scratch.path("incremental-1.png").exists());
}

/// Matched page size means one output page size *and* one scale. A book page
/// scanned on its own and the same page scanned as half of a spread have to
/// land at the same size, or the document carries a scale difference that came
/// from nothing but how the sheets were fed through the scanner.
#[test]
fn matched_canvas_places_a_spread_half_at_the_same_scale_as_an_unsplit_page() {
    let scratch = Scratch::new("matched-spread");
    let manifest = scratch.path("matched-spread-manifest.json");
    // One page-sized block of ink, drawn page-relative, so every output that
    // carries one book page has to show the same bar in the same place.
    let draw_page = |image: &mut GrayImage, left: usize, width: usize| {
        for y in (image.height() * 2 / 5)..(image.height() * 3 / 5) {
            for x in (left + width / 10)..(left + (width * 9 / 10)) {
                image.set(x, y, 0);
            }
        }
    };

    let single_input = scratch.path("matched-spread-single.png");
    let mut single = GrayImage::new(100, 100, 255);
    draw_page(&mut single, 0, 100);
    fs::write(&single_input, encode_gray(&single).unwrap()).unwrap();

    let spread_input = scratch.path("matched-spread-spread.png");
    let mut spread = GrayImage::new(200, 100, 255);
    draw_page(&mut spread, 0, 100);
    draw_page(&mut spread, 100, 100);
    // A gutter the splitter can find between the two book pages.
    for y in 0..spread.height() {
        for x in 96..104 {
            spread.set(x, y, 255);
        }
    }
    fs::write(&spread_input, encode_gray(&spread).unwrap()).unwrap();

    let single_output = scratch.path("matched-spread-single-out.png");
    let left_output = scratch.path("matched-spread-left.png");
    let right_output = scratch.path("matched-spread-right.png");
    let page_options = |layout: &str| {
        serde_json::json!({
            "dpi": 100,
            "layout": layout,
            "normalizeIllumination": false,
            "cropContent": false,
            "outputMode": "grayscale",
            "matchPageSize": true,
            "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
        })
    };
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "documentCanvas": {
                "widthPoints": 72.0,
                "heightPoints": 72.0,
                "widthPx": 100,
                "heightPx": 100
            },
            "pages": [
                {
                    "inputPath": single_input,
                    "sourcePageIndex": 0,
                    "pageMetadataPath": scratch.path("matched-spread-page-0.json"),
                    "options": page_options("force-single"),
                    "outputs": [{
                        "outputPath": single_output,
                        "metadataPath": scratch.path("matched-spread-single-out.json")
                    }]
                },
                {
                    "inputPath": spread_input,
                    "sourcePageIndex": 1,
                    "pageMetadataPath": scratch.path("matched-spread-page-1.json"),
                    "options": page_options("force-two-page"),
                    "outputs": [
                        {
                            "outputPath": left_output,
                            "metadataPath": scratch.path("matched-spread-left.json")
                        },
                        {
                            "outputPath": right_output,
                            "metadataPath": scratch.path("matched-spread-right.json")
                        }
                    ]
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    let mut ink_columns = Vec::new();
    for path in [&single_output, &left_output, &right_output] {
        let image = decode_gray(&fs::read(path).unwrap(), 50_000, 300).unwrap();
        assert_eq!(
            (image.width(), image.height()),
            (100, 100),
            "every matched output is the document grid"
        );
        let columns = (0..image.width())
            .filter(|&x| (0..image.height()).any(|y| image.get(x, y) < 128))
            .collect::<Vec<_>>();
        assert!(!columns.is_empty(), "the bar was lost");
        ink_columns.push((*columns.first().unwrap(), *columns.last().unwrap()));
    }
    // The unsplit page and both spread halves carry the bar at the same width:
    // the halves were scaled by their own share of the sheet, not by the whole
    // spread, so nothing shrank to half size.
    let (single_first, single_last) = ink_columns[0];
    for (first, last) in &ink_columns[1..] {
        assert!(
            (*first as i64 - single_first as i64).abs() <= 4
                && (*last as i64 - single_last as i64).abs() <= 4,
            "spread half ink {first}..{last} disagrees with the unsplit page {single_first}..{single_last}"
        );
    }
}

#[test]
fn matched_canvas_measures_a_kept_half_by_the_paper_it_kept() {
    // Keeping one side of a spread produces a single output that carries half a
    // sheet. Deriving its share from how many outputs the page produced would
    // call that half a whole sheet and scale it down to fit the document, which
    // is the same defect as padding a spread half onto its source sheet.
    let scratch = Scratch::new("matched-keep");
    let manifest = scratch.path("matched-keep-manifest.json");
    let draw_page = |image: &mut GrayImage, left: usize, width: usize| {
        for y in (image.height() * 2 / 5)..(image.height() * 3 / 5) {
            for x in (left + width / 10)..(left + (width * 9 / 10)) {
                image.set(x, y, 0);
            }
        }
    };

    let single_input = scratch.path("matched-keep-single.png");
    let mut single = GrayImage::new(100, 100, 255);
    draw_page(&mut single, 0, 100);
    fs::write(&single_input, encode_gray(&single).unwrap()).unwrap();

    let spread_input = scratch.path("matched-keep-spread.png");
    let mut spread = GrayImage::new(200, 100, 255);
    draw_page(&mut spread, 0, 100);
    draw_page(&mut spread, 100, 100);
    fs::write(&spread_input, encode_gray(&spread).unwrap()).unwrap();

    let single_output = scratch.path("matched-keep-single-out.png");
    let kept_output = scratch.path("matched-keep-left-out.png");
    let page_options = |layout: &str| {
        serde_json::json!({
            "dpi": 100,
            "layout": layout,
            "normalizeIllumination": false,
            "cropContent": false,
            "outputMode": "grayscale",
            "matchPageSize": true,
            "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
        })
    };
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "documentCanvas": {
                "widthPoints": 72.0,
                "heightPoints": 72.0,
                "widthPx": 100,
                "heightPx": 100
            },
            "pages": [
                {
                    "inputPath": single_input,
                    "sourcePageIndex": 0,
                    "pageMetadataPath": scratch.path("matched-keep-page-0.json"),
                    "options": page_options("force-single"),
                    "outputs": [{
                        "outputPath": single_output,
                        "metadataPath": scratch.path("matched-keep-single-out.json")
                    }]
                },
                {
                    "inputPath": spread_input,
                    "sourcePageIndex": 1,
                    "pageMetadataPath": scratch.path("matched-keep-page-1.json"),
                    "options": page_options("keep-left"),
                    "outputs": [{
                        "outputPath": kept_output,
                        "metadataPath": scratch.path("matched-keep-left-out.json")
                    }]
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );

    let mut ink_columns = Vec::new();
    for path in [&single_output, &kept_output] {
        let image = decode_gray(&fs::read(path).unwrap(), 50_000, 300).unwrap();
        assert_eq!(
            (image.width(), image.height()),
            (100, 100),
            "every matched output is the document grid"
        );
        let columns = (0..image.width())
            .filter(|&x| (0..image.height()).any(|y| image.get(x, y) < 128))
            .collect::<Vec<_>>();
        assert!(!columns.is_empty(), "the bar was lost");
        ink_columns.push((*columns.first().unwrap(), *columns.last().unwrap()));
    }
    let (single_first, single_last) = ink_columns[0];
    let (kept_first, kept_last) = ink_columns[1];
    assert!(
        (kept_first as i64 - single_first as i64).abs() <= 4
            && (kept_last as i64 - single_last as i64).abs() <= 4,
        "kept half ink {kept_first}..{kept_last} disagrees with the unsplit page {single_first}..{single_last}"
    );
}

#[test]
fn matched_canvas_keeps_a_page_that_already_fits_off_the_resampler() {
    // The canvas grid is rounded up from points the way Poppler rounds a page
    // into pixels. Native final output owns that target grid, so a source that
    // is one pixel wider is fitted onto the 100x100 canvas without overflow.
    let scratch = Scratch::new("matched-tolerance");
    let manifest = scratch.path("matched-tolerance-manifest.json");
    let input = scratch.path("matched-tolerance-input.png");
    let output = scratch.path("matched-tolerance-out.png");
    let metadata = scratch.path("matched-tolerance-out.json");
    let mut image = GrayImage::new(101, 100, 255);
    for y in 40..60 {
        for x in 10..90 {
            image.set(x, y, 0);
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            // A grid one pixel narrower than the raster of the page it was
            // measured from, which is what a fractional page rectangle leaves
            // behind: the renderer rounds 100.5 points up to 101 pixels.
            "documentCanvas": {
                "widthPoints": 72.0,
                "heightPoints": 72.0,
                "widthPx": 100,
                "heightPx": 100
            },
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("matched-tolerance-page.json"),
                "options": {
                    "dpi": 100,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": false,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert_eq!(metadata_json["canvasOverflow"], serde_json::json!(false));
    assert_eq!(
        metadata_json["warnings"],
        serde_json::json!([]),
        "a page within a pixel of the grid is not reported as fitted below it"
    );
    assert_eq!(
        metadata_json["warningEvents"],
        serde_json::json!([]),
        "a page within a pixel of the grid reports no placement condition"
    );
    let image = decode_gray(&fs::read(&output).unwrap(), 50_000, 300).unwrap();
    assert_eq!((image.width(), image.height()), (100, 100));
    assert_native_canvas_owns_image(&metadata_json);
}

#[test]
fn matched_canvas_reserves_requested_output_padding_inside_the_physical_page() {
    // Matched margins are physical insets in the document canvas. When the
    // detected content reaches the scan edge, the content is fitted into that
    // inset rather than expanding a padded raster and scaling the requested
    // margin back below its physical size.
    let scratch = Scratch::new("matched-overflow-warning");
    let manifest = scratch.path("matched-overflow-manifest.json");
    let input = scratch.path("matched-overflow-input.png");
    let output = scratch.path("matched-overflow-out.png");
    let metadata = scratch.path("matched-overflow-out.json");
    // A full-bleed cover: there are no source pixels from which the requested
    // margin could be retained, so placement has to reserve white PDF paper.
    let image = GrayImage::new(100, 100, 40);
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "documentCanvas": {
                "widthPoints": 72.0,
                "heightPoints": 72.0,
                "widthPx": 100,
                "heightPx": 100
            },
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("matched-overflow-page.json"),
                "options": {
                    "dpi": 100,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    // Cropping to this page's ink and then laying 6 mm of paper
                    // around it asks for more room than the page has.
                    "cropContent": true,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "margins": {"leftMm": 6, "topMm": 6, "rightMm": 6, "bottomMm": 6},
                    "manualContentBoxes": {
                        "full": {
                            "xNormalized": 0,
                            "yNormalized": 0,
                            "widthNormalized": 1,
                            "heightNormalized": 1,
                            "rotationDegrees": 0
                        }
                    }
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert_eq!(metadata_json["canvasOverflow"], serde_json::json!(true));
    let warning_events = metadata_json["warningEvents"].as_array().unwrap();
    assert!(
        warning_events.iter().any(|event| {
            event["code"] == "matched-canvas-content-fitted"
                && event["unit"] == "px"
                && event["documentCanvasWidth"] == 100.0
                && event["documentCanvasHeight"] == 100.0
        }),
        "warningEvents={warning_events:?}"
    );
    let image = decode_gray(&fs::read(&output).unwrap(), 50_000, 300).unwrap();
    assert_eq!((image.width(), image.height()), (100, 100));
    assert_native_canvas_owns_image(&metadata_json);
    assert_eq!(metadata_json["appliedMargins"]["leftPx"], 24.0);
    assert_eq!(metadata_json["appliedMargins"]["topPx"], 24.0);
    assert_eq!(metadata_json["appliedMargins"]["rightPx"], 24.0);
    assert_eq!(metadata_json["appliedMargins"]["bottomPx"], 24.0);
    // Six millimetres at 100 DPI rounds to 24 pixels on every edge. Native
    // canvas ownership makes the white inset part of the published raster.
    assert_eq!(image.get(0, 0), 255);
    assert!(image.get(24, 24) < 128);
}

#[test]
fn matched_canvas_reports_a_sheet_larger_than_the_rectangle_it_was_measured_for() {
    // The quiet way a page ends up below the document's scale: the canvas was
    // measured for half sheets — the run expected this page to be a spread —
    // and the page is then cut as one whole sheet. Nothing overflows and
    // nothing is clipped, the grid stays uniform, and the page is simply
    // letterboxed at half the scale of every page around it, which is only
    // visible if the run says so.
    let scratch = Scratch::new("matched-undersized-paper");
    let manifest = scratch.path("matched-undersized-manifest.json");
    let input = scratch.path("matched-undersized-input.png");
    let output = scratch.path("matched-undersized-out.png");
    let metadata = scratch.path("matched-undersized-out.json");
    let mut image = GrayImage::new(100, 100, 255);
    for y in 40..60 {
        for x in 10..90 {
            image.set(x, y, 0);
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            // Half of this page's sheet, at the same 100 DPI grid.
            "documentCanvas": {
                "widthPoints": 36.0,
                "heightPoints": 72.0,
                "widthPx": 50,
                "heightPx": 100
            },
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("matched-undersized-page.json"),
                "options": {
                    "dpi": 100,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": false,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    // The page fits the canvas it was placed on; it is the paper that did not.
    assert_eq!(metadata_json["canvasOverflow"], serde_json::json!(false));
    assert_eq!(metadata_json["matchedCanvasContentWidthPx"], 50);
    assert_eq!(metadata_json["matchedCanvasContentHeightPx"], 50);
    let warning_events = metadata_json["warningEvents"].as_array().unwrap();
    assert!(
        warning_events.iter().any(|event| {
            event["code"] == "matched-canvas-paper-downscaled"
                && event["unit"] == "px"
                && event["scalePercentTenths"] == 500
        }),
        "warningEvents={warning_events:?}"
    );
    let image = decode_gray(&fs::read(&output).unwrap(), 50_000, 300).unwrap();
    assert_eq!((image.width(), image.height()), (50, 100));
    assert_native_canvas_owns_image(&metadata_json);
}

/// The same overflow, previewed. Preview and final renders share the exact
/// final-grid inset: the intrinsic raster is the physical page and the
/// matched-content box describes where its full-bleed source is displayed.
#[test]
fn matched_canvas_preview_reserves_padding_inside_the_physical_page() {
    let scratch = Scratch::new("matched-overflow-preview");
    let manifest = scratch.path("matched-overflow-preview-manifest.json");
    let input = scratch.path("matched-overflow-preview-input.png");
    let output = scratch.path("matched-overflow-preview-out.png");
    let metadata = scratch.path("matched-overflow-preview-out.json");
    let image = GrayImage::new(200, 180, 40);
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "preview",
            "canvasScope": "page",
            // The page's own paper, which is the document's: 5 mm of margin
            // around content that already reaches the edge asks for more.
            "documentCanvas": {
                "widthPoints": 96.0,
                "heightPoints": 86.4,
                "widthPx": 200,
                "heightPx": 180
            },
            "pages": [{
                "inputPath": input,
                "sourcePageIndex": 0,
                "pageMetadataPath": scratch.path("matched-overflow-preview-page.json"),
                "options": {
                    "dpi": 150,
                    "layout": "force-single",
                    "normalizeIllumination": false,
                    "cropContent": true,
                    "outputMode": "grayscale",
                    "matchPageSize": true,
                    "pageAlignment": "top-center",
                    "margins": {"leftMm": 5, "topMm": 5, "rightMm": 5, "bottomMm": 5},
                    "manualContentBoxes": {
                        "full": {
                            "xNormalized": 0,
                            "yNormalized": 0,
                            "widthNormalized": 1,
                            "heightNormalized": 1,
                            "rotationDegrees": 0
                        }
                    }
                },
                "outputs": [{"outputPath": output, "metadataPath": metadata}]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    let metadata_json: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    let canvas_width = metadata_json["canvasWidthPx"].as_u64().unwrap();
    let canvas_height = metadata_json["canvasHeightPx"].as_u64().unwrap();
    let content_width = metadata_json["matchedCanvasContentWidthPx"]
        .as_u64()
        .unwrap();
    let content_height = metadata_json["matchedCanvasContentHeightPx"]
        .as_u64()
        .unwrap();
    let offset_x = metadata_json["placementOffsetXPx"].as_u64().unwrap();
    let offset_y = metadata_json["placementOffsetYPx"].as_u64().unwrap();
    assert_eq!((canvas_width, canvas_height), (200, 180));
    assert_eq!(metadata_json["canvasOverflow"], serde_json::json!(true));
    // The intrinsic page and its inset placement both remain on the canvas
    // after presentation scales the source raster into its content box.
    assert!(offset_x + content_width <= canvas_width);
    assert!(offset_y + content_height <= canvas_height);
    assert_eq!(
        metadata_json["outputWidthPx"].as_u64().unwrap(),
        canvas_width
    );
    assert_eq!(
        metadata_json["outputHeightPx"].as_u64().unwrap(),
        canvas_height
    );
    assert_eq!(metadata_json["appliedMargins"]["leftPx"], 30.0);
    assert_eq!(metadata_json["appliedMargins"]["topPx"], 30.0);
    assert_eq!(metadata_json["appliedMargins"]["rightPx"], 30.0);
    assert_eq!(metadata_json["appliedMargins"]["bottomPx"], 30.0);
    // Preserve the source aspect ratio inside the 140x120 inner rectangle;
    // the seven spare horizontal pixels follow the requested top-center
    // alignment.
    assert_eq!((content_width, content_height), (133, 120));
    assert_eq!((offset_x, offset_y), (33, 30));
    // Preview publishes the physical page unchanged; presentation applies
    // the content box and exposes the exact five-millimetre boundary.
    let published = decode_gray(&fs::read(&output).unwrap(), 200_000, 400).unwrap();
    assert_eq!(
        u64::try_from(published.width()).unwrap(),
        metadata_json["outputWidthPx"].as_u64().unwrap()
    );
    assert_eq!((published.width(), published.height()), (200, 180));
    assert!(
        (0..published.width()).all(|x| (0..published.height()).all(|y| published.get(x, y) < 128))
    );
}

#[test]
#[ignore = "full-raster CLI fixture runs in the native CI corpus lane"]
fn luther_style_fragmented_gutter_does_not_pin_crop_even_when_tone_marks_it_as_picture() {
    fn draw_glyph_line(
        image: &mut GrayImage,
        left: usize,
        top: usize,
        glyphs: usize,
        glyph_width: usize,
        glyph_height: usize,
        spacing: usize,
    ) {
        for glyph in 0..glyphs {
            let glyph_left = left + glyph * spacing;
            for y in top..top + glyph_height {
                for x in glyph_left..glyph_left + glyph_width {
                    if x < glyph_left + 4 || y < top + 4 || y + 4 >= top + glyph_height {
                        image.set(x, y, 22);
                    }
                }
            }
        }
    }

    let scratch = Scratch::new("luther-gutter-crop");
    let input = scratch.path("input.png");
    let selection_path = scratch.path("selection.png");
    let trusted_background_path = scratch.path("trusted-background.png");
    let output = scratch.path("output.png");
    let metadata_path = scratch.path("output.json");
    let page_metadata_path = scratch.path("page.json");
    let picture_mask_path = scratch.path("picture-mask.pbm");
    let control_output = scratch.path("control-output.png");
    let control_metadata_path = scratch.path("control-output.json");
    let control_page_metadata_path = scratch.path("control-page.json");
    let control_picture_mask_path = scratch.path("control-picture-mask.pbm");
    let manifest = scratch.path("manifest.json");

    let mut image = GrayImage::new(600, 800, 244);
    draw_glyph_line(&mut image, 150, 95, 15, 12, 38, 16);
    for row in 0..8 {
        draw_glyph_line(&mut image, 145, 165 + row * 55, 15, 12, 38, 16);
    }
    // A central library stamp and the low footer are sparse but authored. They
    // must survive even though neither is part of the dominant body block.
    for y in 510..590 {
        for x in 260..340 {
            if x == 260 || x == 339 || y == 510 || y == 589 {
                image.set(x, y, 22);
            }
        }
    }
    draw_glyph_line(&mut image, 205, 720, 10, 12, 38, 16);

    // A faint gutter becomes many thresholded fragments at the page-frame
    // ends. Twenty-five-pixel fragments are intentionally below the calibrated glyph
    // area, matching the broken shadow/dirt seen on the Luther title spread.
    for top in (0..215).step_by(8) {
        let left = 34 + (top / 8 % 7) * 4;
        for y in top..(top + 5).min(image.height()) {
            for x in left..left + 5 {
                image.set(x, y, 18);
            }
        }
    }
    for top in (742..800).step_by(8) {
        let left = 32 + (top / 8 % 7) * 4;
        for y in top..(top + 5).min(image.height()) {
            for x in left..left + 5 {
                image.set(x, y, 18);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();

    let mut selection = GrayImage::new(image.width(), image.height(), 255);
    for y in 0..image.height() {
        for x in 0..image.width() {
            if image.get(x, y) < 80 {
                selection.set(x, y, 0);
            }
        }
    }
    fs::write(&selection_path, encode_gray(&selection).unwrap()).unwrap();

    // Producer MRC tone suggests the gutter as a coherent picture owner. The
    // vetted owner must reject that rail before semantic ownership is
    // published, while the crop path still preserves the authored content.
    let mut trusted_background = GrayImage::new(image.width(), image.height(), 244);
    for y in 0..trusted_background.height() {
        for x in 14..68 {
            trusted_background.set(x, y, 32 + ((x * 17 + y * 29) % 181) as u8);
        }
    }
    fs::write(
        &trusted_background_path,
        encode_gray(&trusted_background).unwrap(),
    )
    .unwrap();

    let options = CleanupOptions {
        dpi: 150.0,
        source_dpi: Some(150.0),
        source_background_dpi: Some(150.0),
        source_has_bilevel_layer: true,
        output_mode: OutputMode::Mixed,
        layout: LayoutMode::Single,
        normalize_illumination: false,
        crop_content: true,
        match_page_size: false,
        manual_skew_degrees: Some(0.0),
        margins_mm: Some(MarginsMm {
            left_mm: 0.0,
            top_mm: 0.0,
            right_mm: 0.0,
            bottom_mm: 0.0,
        }),
        ..CleanupOptions::default()
    };
    let control_options = CleanupOptions {
        crop_content: false,
        ..options.clone()
    };
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": [{
                "inputPath": input,
                "trustedForegroundMaskPath": selection_path,
                "trustedMrcBackgroundPath": trusted_background_path,
                "sourcePageIndex": 0,
                "pageMetadataPath": control_page_metadata_path,
                "options": control_options,
                "outputs": [{
                    "outputPath": control_output,
                    "metadataPath": control_metadata_path,
                    "pictureMaskOutputPath": control_picture_mask_path,
                }],
            }, {
                "inputPath": input,
                "trustedForegroundMaskPath": selection_path,
                "trustedMrcBackgroundPath": trusted_background_path,
                "sourcePageIndex": 1,
                "pageMetadataPath": page_metadata_path,
                "options": options,
                "outputs": [{
                    "outputPath": output,
                    "metadataPath": metadata_path,
                    "pictureMaskOutputPath": picture_mask_path,
                }],
            }],
        }))
        .unwrap(),
    )
    .unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let picture_mask = decode_p4(
        &fs::read(&control_picture_mask_path).unwrap(),
        600 * 800,
        900,
    )
    .expect("Mixed output publishes its automatic picture owner");
    assert_eq!(
        picture_mask.get(40, 400),
        0,
        "fragmented gutter evidence must overrule false tonal ownership; ownerPixels={}",
        picture_mask
            .data()
            .iter()
            .filter(|&&sample| sample == 0)
            .count()
    );
    let metadata: Value = serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
    let content = &metadata["contentBox"];
    let left = content["xPx"].as_f64().expect("content left");
    let top = content["yPx"].as_f64().expect("content top");
    let right = left + content["widthPx"].as_f64().expect("content width");
    let bottom = top + content["heightPx"].as_f64().expect("content height");
    assert!(left >= 130.0, "false picture gutter pinned crop: {content}");
    assert!(top <= 100.0, "title line was cropped: {content}");
    assert!(bottom >= 730.0, "footer was cropped: {content}");
    assert!(
        left <= 260.0 && right >= 340.0,
        "central stamp was cropped: {content}"
    );

    // Pin the production pre-analysis lane too: a lower gutter owner at the
    // outer edge of the left spread half must not turn that half into a
    // full-sheet content box, while its sparse title, stamp, and footer remain.
    let spread_input = scratch.path("page-plan-spread.png");
    let spread_manifest = scratch.path("page-plan-spread-manifest.json");
    let spread_metadata = scratch.path("page-plan-spread-metadata.json");
    let mut spread = GrayImage::new(1_200, 800, 244);
    for y in 0..800 {
        for x in 0..600 {
            spread.set(x, y, image.get(x, y));
        }
    }
    draw_glyph_line(&mut spread, 750, 95, 15, 12, 38, 16);
    for row in 0..8 {
        draw_glyph_line(&mut spread, 745, 165 + row * 55, 15, 12, 38, 16);
    }
    draw_glyph_line(&mut spread, 805, 720, 10, 12, 38, 16);
    for y in 590..800 {
        for x in 564..600 {
            spread.set(x, y, 32 + ((x * 17 + y * 29) % 181) as u8);
        }
    }
    fs::write(&spread_input, encode_gray(&spread).unwrap()).unwrap();
    fs::write(
        &spread_manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "analyze",
            "analysisPurpose": "page-plan",
            "renderMode": "preview",
            "canvasScope": "page",
            "pages": [{
                "inputPath": spread_input,
                "sourcePageIndex": 0,
                "pageMetadataPath": spread_metadata,
                "outputs": [],
                "options": {
                    "dpi": 150,
                    "layout": "force-two-page",
                    "normalizeIllumination": false,
                    "cropContent": true,
                    "outputMode": "mixed",
                    "matchPageSize": false,
                    "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
                }
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", spread_manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let page_plan: Value = serde_json::from_slice(&fs::read(&spread_metadata).unwrap()).unwrap();
    assert_eq!(page_plan["layoutClassification"], "two-page-spread");
    assert_eq!(page_plan["outputs"].as_array().unwrap().len(), 2);
    let left_plan = &page_plan["outputs"][0]["contentBox"];
    let plan_left = left_plan["xPx"].as_f64().expect("left content x");
    let plan_top = left_plan["yPx"].as_f64().expect("left content y");
    let plan_right = plan_left + left_plan["widthPx"].as_f64().expect("left content width");
    let plan_bottom = plan_top + left_plan["heightPx"].as_f64().expect("left content height");
    assert!(plan_left >= 130.0, "page-plan kept gutter: {left_plan}");
    assert!(plan_top <= 100.0, "page-plan cropped title: {left_plan}");
    assert!(plan_right >= 340.0, "page-plan cropped stamp: {left_plan}");
    assert!(
        plan_right < 560.0,
        "page-plan kept lower gutter owner: {left_plan}"
    );
    assert!(
        plan_bottom >= 730.0,
        "page-plan cropped footer: {left_plan}"
    );
}

#[test]
#[ignore = "full-raster CLI fixture runs in the native CI corpus lane"]
fn cli_content_box_only_inherits_local_rejected_rail_authority() {
    fn draw_glyph_line(
        image: &mut GrayImage,
        left: usize,
        top: usize,
        glyphs: usize,
        glyph_width: usize,
        glyph_height: usize,
        spacing: usize,
    ) {
        for glyph in 0..glyphs {
            let glyph_left = left + glyph * spacing;
            for y in top..top + glyph_height {
                for x in glyph_left..glyph_left + glyph_width {
                    if x < glyph_left + 4 || y < top + 4 || y + 4 >= top + glyph_height {
                        image.set(x, y, 22);
                    }
                }
            }
        }
    }

    let scratch = Scratch::new("localized-rail-content-box");
    let manifest = scratch.path("manifest.json");
    let input = scratch.path("input.png");
    let selection_path = scratch.path("selection.png");
    let mut image = GrayImage::new(800, 800, 244);
    draw_glyph_line(&mut image, 150, 95, 15, 12, 38, 16);
    for row in 0..8 {
        draw_glyph_line(&mut image, 145, 165 + row * 55, 15, 12, 38, 16);
    }
    // Compact margin glyphs share rows with the body and sit just inside the
    // grown picture rail, satisfying the shipped structured-text rescue.
    draw_glyph_line(&mut image, 110, 165, 2, 12, 38, 16);
    draw_glyph_line(&mut image, 110, 220, 2, 12, 38, 16);
    // Fragmented frame evidence marks this corridor as scanner contamination
    // independently of where the tonal rail happens to lie vertically.
    for top in (0..215).step_by(8) {
        let left = 34 + (top / 8 % 7) * 4;
        for y in top..(top + 5).min(image.height()) {
            for x in left..left + 5 {
                image.set(x, y, 18);
            }
        }
    }
    for top in (742..800).step_by(8) {
        let left = 32 + (top / 8 % 7) * 4;
        for y in top..(top + 5).min(image.height()) {
            for x in left..left + 5 {
                image.set(x, y, 18);
            }
        }
    }
    fs::write(&input, encode_gray(&image).unwrap()).unwrap();
    let mut selection = GrayImage::new(image.width(), image.height(), 255);
    for y in 0..image.height() {
        for x in 0..image.width() {
            if image.get(x, y) < 80 {
                selection.set(x, y, 0);
            }
        }
    }
    fs::write(&selection_path, encode_gray(&selection).unwrap()).unwrap();

    let mut pages = Vec::new();
    let mut metadata_paths = Vec::new();
    for (index, (label, rail_top)) in [("adjacent", 130), ("distant", 700)]
        .into_iter()
        .enumerate()
    {
        let trusted_background_path = scratch.path(&format!("{label}-background.png"));
        let output = scratch.path(&format!("{label}-output.png"));
        let metadata_path = scratch.path(&format!("{label}-output.json"));
        let page_metadata_path = scratch.path(&format!("{label}-page.json"));
        let picture_mask_path = scratch.path(&format!("{label}-picture-mask.pbm"));
        let mut trusted_background = GrayImage::new(image.width(), image.height(), 244);
        for y in rail_top..image.height() {
            for x in 14..50 {
                trusted_background.set(x, y, 32 + ((x * 17 + y * 29) % 181) as u8);
            }
        }
        fs::write(
            &trusted_background_path,
            encode_gray(&trusted_background).unwrap(),
        )
        .unwrap();
        metadata_paths.push(metadata_path.clone());
        pages.push(serde_json::json!({
            "inputPath": input,
            "trustedForegroundMaskPath": selection_path,
            "trustedMrcBackgroundPath": trusted_background_path,
            "sourcePageIndex": index,
            "pageMetadataPath": page_metadata_path,
            "options": {
                "dpi": 150,
                "sourceDpi": 150,
                "sourceBackgroundDpi": 150,
                "sourceHasBilevelLayer": true,
                "layout": "force-single",
                "normalizeIllumination": false,
                "cropContent": true,
                "outputMode": "mixed",
                "matchPageSize": false,
                "manualSkewDegrees": 0,
                "margins": {"leftMm": 0, "topMm": 0, "rightMm": 0, "bottomMm": 0}
            },
            "outputs": [{
                "outputPath": output,
                "metadataPath": metadata_path,
                "pictureMaskOutputPath": picture_mask_path
            }]
        }));
    }
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": pages
        }))
        .unwrap(),
    )
    .unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let metadata = metadata_paths
        .iter()
        .map(|path| serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap())
        .collect::<Vec<_>>();
    let adjacent = &metadata[0]["contentBox"];
    let distant = &metadata[1]["contentBox"];
    assert_eq!(
        adjacent["xPx"].as_f64(),
        Some(0.0),
        "rail-adjacent text no longer expands shipped metadata to the physical edge: {adjacent}"
    );
    assert!(
        distant["xPx"].as_f64().is_some_and(|left| left >= 100.0),
        "perpendicularly distant text borrowed the rail's edge authority: {distant}"
    );
}

#[test]
fn batch_prior_stabilizes_a_cropped_thin_complete_source_mask_without_removing_ink() {
    fn text_page(glyph_width: usize, glyph_height: usize) -> (GrayImage, GrayImage) {
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
        (raw, selection)
    }

    let scratch = Scratch::new("document-ink-prior");
    let (thin_raw, thin_selection) = text_page(4, 20);
    let (median_raw, median_selection) = text_page(5, 16);
    let thin_input = scratch.path("thin-input.png");
    let thin_mask = scratch.path("thin-selection.png");
    let median_input = scratch.path("median-input.png");
    let median_mask = scratch.path("median-selection.png");
    let background = scratch.path("producer-background.png");
    fs::write(&thin_input, encode_gray(&thin_raw).unwrap()).unwrap();
    fs::write(&thin_mask, encode_gray(&thin_selection).unwrap()).unwrap();
    fs::write(&median_input, encode_gray(&median_raw).unwrap()).unwrap();
    fs::write(&median_mask, encode_gray(&median_selection).unwrap()).unwrap();
    fs::write(
        &background,
        encode_gray(&GrayImage::new(60, 50, 250)).unwrap(),
    )
    .unwrap();

    let options = CleanupOptions {
        dpi: 150.0,
        source_dpi: Some(150.0),
        source_has_bilevel_layer: true,
        source_background_dpi: Some(75.0),
        output_mode: OutputMode::Bw,
        layout: LayoutMode::Single,
        normalize_illumination: false,
        crop_content: true,
        match_page_size: false,
        margins_mm: Some(MarginsMm {
            left_mm: 0.0,
            top_mm: 0.0,
            right_mm: 0.0,
            bottom_mm: 0.0,
        }),
        automatic_content_boxes: ManualContentBoxes {
            full: Some(NormalizedRect {
                x: 0.04,
                y: 0.04,
                width: 0.90,
                height: 0.92,
                rotation: OrthogonalRotation::None,
            }),
            ..ManualContentBoxes::default()
        },
        ..CleanupOptions::default()
    };
    let pages = (0..12)
        .map(|index| {
            let thin = index == 0;
            serde_json::json!({
                "inputPath": if thin { &thin_input } else { &median_input },
                "trustedForegroundMaskPath": if thin { &thin_mask } else { &median_mask },
                "trustedMrcBackgroundPath": background,
                "sourcePageIndex": index,
                "pageMetadataPath": scratch.path(&format!("page-{index}.json")),
                "options": options,
                "outputs": [{
                    "outputPath": scratch.path(&format!("output-{index}.png")),
                    "metadataPath": scratch.path(&format!("output-{index}.json")),
                    "bilevelOutputPath": scratch.path(&format!("output-{index}.pbm")),
                }],
            })
        })
        .collect::<Vec<_>>();
    let manifest = scratch.path("manifest.json");
    fs::write(
        &manifest,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "document",
            "pages": pages,
        }))
        .unwrap(),
    )
    .unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );

    let metadata: Value =
        serde_json::from_slice(&fs::read(scratch.path("output-0.json")).unwrap()).unwrap();
    let diagnostics = &metadata["inkConsistencyDiagnostics"];
    assert_eq!(diagnostics["priorSampleCount"], 12);
    assert_eq!(diagnostics["applied"], true);
    assert!(
        diagnostics["survivalAfter"].as_f64().unwrap()
            > diagnostics["survivalBefore"].as_f64().unwrap()
    );
    assert!(diagnostics["addedInkPixels"].as_u64().unwrap() > 0);
    assert!(metadata["outputWidthPx"].as_u64().unwrap() < 120);

    let output = decode_p4(
        &fs::read(scratch.path("output-0.pbm")).unwrap(),
        120 * 100,
        200,
    )
    .unwrap();
    let output_ink = output.data().iter().filter(|&&sample| sample == 0).count();
    let source_ink = thin_selection
        .data()
        .iter()
        .filter(|&&sample| sample == 0)
        .count();
    assert!(output_ink > source_ink);
}

#[test]
#[ignore = "real fixture corpus runs in the native CI corpus lane"]
fn off_center_binding_fold_does_not_promote_the_spread_to_mixed() {
    let scratch = Scratch::new("toc-spread-fold-ownership");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/gutter/luther-p3-toc-spread.png");
    let page_metadata = scratch.path("toc-page.json");
    let manifest = scratch.path("toc-spread-manifest.json");
    let outputs = [
        (scratch.path("toc-left.png"), scratch.path("toc-left.json")),
        (
            scratch.path("toc-right.png"),
            scratch.path("toc-right.json"),
        ),
    ];
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": fixture,
            "sourcePageIndex": 2,
            "pageMetadataPath": page_metadata,
            "options": {
                "dpi": 150,
                "sourceDpi": 150,
                "requestedRenderDpi": 150,
                "binarization": "auto",
                "thickness": 0,
                "normalizeIllumination": true,
                "despeckle": true,
                "outputMode": "auto",
                "layout": "auto",
                "cropContent": true,
                "matchPageSize": false,
                "pageAlignment": "top-center",
            },
            "outputs": [
                {"outputPath": outputs[0].0, "metadataPath": outputs[0].1},
                {"outputPath": outputs[1].0, "metadataPath": outputs[1].1},
            ],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
    );

    let page: Value = serde_json::from_slice(&fs::read(&page_metadata).unwrap()).unwrap();
    // The only non-text component on this spread is the foot of the binding
    // shadow. Owning it costs the reader twice: Auto promotes the page to
    // Mixed, which publishes materially heavier glyphs than the bilevel text
    // route, and the crop planner follows the owned pixels back across the
    // fold and ships the shadow.
    assert_eq!(
        page["outputModeDiagnostics"]["pictureFraction"]
            .as_f64()
            .unwrap(),
        0.0,
        "a binding fold must not be a picture owner: {page}",
    );
    assert_eq!(
        page["recommendedOutputMode"], "bw",
        "a text spread with no illustration must stay on the bilevel route: {page}",
    );

    // The blank verso's bilevel rendition correctly removes the fold, but its
    // faint paper variation triggers the conservative grayscale fallback. The
    // fallback must not reintroduce the fold halo along the retained leaf
    // edge. This is the visible top-right remnant from the real page.
    let verso: Value = serde_json::from_slice(&fs::read(&outputs[0].1).unwrap()).unwrap();
    assert_eq!(
        verso["outputMode"], "grayscale",
        "the fixture must keep exercising the pale-structure fallback: {verso}",
    );
    let shipped_verso = decode_gray(&fs::read(&outputs[0].0).unwrap(), 8_000_000, 4_000).unwrap();
    let fold_margin = (shipped_verso.width() / 100).max(1);
    assert!(
        (shipped_verso.width() - fold_margin..shipped_verso.width())
            .all(|x| (0..shipped_verso.height()).all(|y| shipped_verso.get(x, y) == 255)),
        "the grayscale fallback restored tone inside the verso fold margin",
    );

    // The recto raster begins at the cutter, so its x=0 *is* the fold edge and
    // a crop starting there still ships the shadow. Assert the shipped result
    // rather than the coordinate: the shadow is a near-solid column, so if any
    // of it survived, some column in the inner margin would be almost entirely
    // ink. The fold fragment this fixture reproduces covers 16% of the page
    // height; the densest inner-margin text column measures 1%, so 5% cleanly
    // separates a surviving shadow from ordinary text.
    let recto: Value = serde_json::from_slice(&fs::read(&outputs[1].1).unwrap()).unwrap();
    assert!(
        recto["cropRect"]["xPx"].as_f64().unwrap() > 0.0,
        "the recto crop must start inside the leaf, not on the fold edge: {recto}",
    );
    let shipped = decode_gray(&fs::read(&outputs[1].0).unwrap(), 8_000_000, 4_000).unwrap();
    let inner_margin = (shipped.width() / 20).max(1);
    let densest_inner_column = (0..inner_margin)
        .map(|x| {
            (0..shipped.height())
                .filter(|&y| shipped.get(x, y) < 128)
                .count()
        })
        .max()
        .unwrap_or(0);
    assert!(
        densest_inner_column * 20 < shipped.height(),
        "a fold-shadow column survived into the recto: {densest_inner_column} of \
         {} rows inked within {inner_margin}px of the fold",
        shipped.height(),
    );
}

#[test]
#[ignore = "real fixture corpus runs in the native CI corpus lane"]
fn forced_bw_matched_canvas_routes_the_blank_verso_corner_rail_out_of_publication() {
    let scratch = Scratch::new("toc-spread-forced-bw-corner-rail");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/gutter/luther-p3-toc-spread.png");
    let page_metadata = scratch.path("toc-page.json");
    let left_output = scratch.path("toc-left.png");
    let left_metadata = scratch.path("toc-left.json");
    let left_bilevel = scratch.path("toc-left.pbm");
    let manifest = scratch.path("toc-spread-manifest.json");
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "documentCanvas": {
            "widthPoints": 528.72,
            "heightPoints": 780.48,
            "widthPx": 2203,
            "heightPx": 3252,
        },
        "pages": [{
            "inputPath": fixture,
            "sourcePageIndex": 2,
            "pageMetadataPath": page_metadata,
            "options": {
                "dpi": 299,
                "sourceDpi": 150,
                "requestedRenderDpi": 300,
                "binarization": "auto",
                "thickness": 0,
                "normalizeIllumination": true,
                "despeckle": true,
                "outputMode": "bw",
                "layout": "force-two-page",
                "automaticSplit": {
                    "xNormalized": 0.5528824330458466,
                    "rotationDegrees": 0,
                },
                "cropContent": true,
                "matchPageSize": true,
                "pageAlignment": "top-center",
                "margins": {
                    "leftMm": 5,
                    "topMm": 5,
                    "rightMm": 5,
                    "bottomMm": 5,
                },
            },
            "outputs": [
                {
                    "outputPath": left_output,
                    "metadataPath": left_metadata,
                    "bilevelOutputPath": left_bilevel,
                },
                {
                    "outputPath": scratch.path("toc-right.png"),
                    "metadataPath": scratch.path("toc-right.json"),
                    "bilevelOutputPath": scratch.path("toc-right.pbm"),
                },
            ],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
    );

    let metadata: Value = serde_json::from_slice(&fs::read(&left_metadata).unwrap()).unwrap();
    // The full book resolves Auto to B/W at spread scope. Once the top-corner
    // rail is removed, the blank leaf correctly collapses and uses the
    // conservative grayscale fallback instead of publishing the rail as its
    // only JBIG2 content.
    assert_eq!(
        metadata["outputMode"], "grayscale",
        "blank leaf did not use its conservative fallback: {metadata}"
    );
    assert_eq!(
        metadata["bilevelWritten"],
        Value::Null,
        "blank leaf still published a B/W representation: {metadata}",
    );
    assert!(
        !left_bilevel.exists(),
        "blank leaf left a stale B/W publication behind"
    );
    let shipped = decode_gray(&fs::read(&left_output).unwrap(), 8_000_000, 4_000).unwrap();
    let corner_width = (shipped.width() / 40).max(1);
    let corner_height = (shipped.height() / 8).max(1);
    assert!(
        (shipped.width() - corner_width..shipped.width())
            .all(|x| (0..corner_height).all(|y| shipped.get(x, y) >= 128)),
        "a fold-side scanner rail survived in the published blank-leaf corner",
    );
}

/// The crop planner's tone union is the only thing that keeps a flat-shaded
/// plate inside the shipped page when picture detection is empty, which is the
/// case for artwork printed as a fine line screen. The unit tests pin the
/// planner; this pins the published CLI result, so a future narrowing of the
/// union cannot trim authored artwork off the page while the crate tests stay
/// green.
#[test]
#[ignore = "full-raster CLI fixture runs in the native CI corpus lane"]
fn cli_crop_keeps_a_flat_shaded_plate_no_picture_detector_claims() {
    let scratch = Scratch::new("flat-shaded-plate-crop");
    let mut source = GrayImage::new(900, 1200, 244);
    for y in 0..source.height() {
        for x in 0..source.width() {
            source.set(x, y, 242 + ((x * 5 + y * 3) % 5) as u8);
        }
    }
    // A flat wash with a two-tone screen: tonal enough to be coherent tone,
    // too uniform to seed the picture detector.
    for y in 120..620 {
        for x in 180..720 {
            source.set(x, y, 170 + ((x + y) % 2) as u8 * 18);
        }
    }
    // Body text well below the plate, so the crop has an unambiguous reason to
    // stop short of it if the plate is not owned.
    for row in 0..20 {
        let top = 700 + row * 23;
        for glyph in 0..9 {
            let left = 300 + glyph * 19;
            for y in top..top + 14 {
                for x in left..left + 14 {
                    if x < left + 3 || x + 3 >= left + 14 || y < top + 3 || y + 3 >= top + 14 {
                        source.set(x, y, 24);
                    }
                }
            }
        }
    }

    let input = scratch.path("flat-shaded-plate.png");
    fs::write(&input, encode_gray(&source).unwrap()).unwrap();
    let output = scratch.path("flat-shaded-plate-clean.png");
    let metadata_path = scratch.path("flat-shaded-plate-clean.json");
    let page_metadata = scratch.path("flat-shaded-plate-page.json");
    let manifest = scratch.path("flat-shaded-plate-manifest.json");
    let payload = serde_json::json!({
        "version": 3,
        "operation": "render",
        "renderMode": "final",
        "canvasScope": "document",
        "pages": [{
            "inputPath": input,
            "sourcePageIndex": 0,
            "pageMetadataPath": page_metadata,
            "options": {
                "dpi": 150,
                "sourceDpi": 150,
                "requestedRenderDpi": 150,
                "binarization": "auto",
                "thickness": 0,
                "normalizeIllumination": true,
                "despeckle": true,
                "outputMode": "auto",
                "layout": "force-single",
                "cropContent": true,
                "matchPageSize": false,
                "pageAlignment": "top-center",
            },
            "outputs": [{"outputPath": output, "metadataPath": metadata_path}],
        }],
    });
    fs::write(&manifest, serde_json::to_vec_pretty(&payload).unwrap()).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-scan-cleanup"))
        .args(["--manifest", manifest.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
    );

    let metadata: Value = serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
    let crop = &metadata["cropRect"];
    let (x, y, width) = (
        crop["xPx"].as_f64().unwrap(),
        crop["yPx"].as_f64().unwrap(),
        crop["widthPx"].as_f64().unwrap(),
    );
    assert!(
        y <= 130.0 && x <= 190.0 && x + width >= 700.0,
        "the shipped crop trimmed the flat-shaded plate: {metadata}",
    );
}
