use evb_scan_cleanup::{
    engine::render::analyze_page_with_color_and_document_prior, png::decode_image, CleanupOptions,
    OutputMode,
};
use std::{fs, path::Path};

#[test]
fn luther_low_resolution_scans_keep_soft_text_in_grayscale() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/split");
    let mut recommendations = Vec::new();
    for page in 1..=4 {
        let name = format!("spread-luther-soft-gutter-p{page:05}.png");
        let decoded =
            decode_image(&fs::read(root.join(&name)).unwrap(), 10_000_000, 3_000).unwrap();
        let result = analyze_page_with_color_and_document_prior(
            &decoded.gray,
            Some(&decoded.rgb),
            &CleanupOptions {
                dpi: 81.706_763_504_312_3,
                output_mode: OutputMode::Auto,
                normalize_illumination: false,
                crop_content: false,
                ..CleanupOptions::default()
            },
            None,
        )
        .unwrap();
        let recommendation = result
            .output_mode_recommendation
            .expect("automatic mode emits a recommendation");
        println!(
            "CLASSIFICATION_MATRIX\t{name}\t{:?}\t{:.6}\t{:?}",
            recommendation.mode, recommendation.confidence, recommendation.reason
        );
        recommendations.push((name, recommendation));
    }
    for (name, recommendation) in recommendations {
        assert_eq!(
            recommendation.mode,
            OutputMode::Grayscale,
            "{name}: {recommendation:?}"
        );
        assert!(
            recommendation.confidence >= 0.75,
            "{name}: {recommendation:?}"
        );
        assert!(
            recommendation.diagnostics.bilevel_fidelity_veto,
            "{name}: the low-resolution soft-edge guard was not recorded"
        );
        assert!(
            recommendation.diagnostics.soft_edge_to_ink_ratio >= 0.05,
            "{name}: the grayscale decision lacked measured soft-edge evidence"
        );
    }
}

#[test]
fn a_book_fore_edge_strip_does_not_make_a_text_page_color() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/leaf-edge/prym-p00063-fore-edge-150dpi.png");
    let decoded = decode_image(&fs::read(path).unwrap(), 10_000_000, 3_000).unwrap();
    let result = analyze_page_with_color_and_document_prior(
        &decoded.gray,
        Some(&decoded.rgb),
        &CleanupOptions {
            dpi: 150.0,
            output_mode: OutputMode::Auto,
            normalize_illumination: false,
            crop_content: false,
            ..CleanupOptions::default()
        },
        None,
    )
    .unwrap();
    let recommendation = result
        .output_mode_recommendation
        .expect("automatic mode emits a recommendation");
    assert_eq!(recommendation.mode, OutputMode::Bw, "{recommendation:?}");
    assert!(
        !recommendation.diagnostics.significant_color,
        "{recommendation:?}"
    );
}

#[test]
fn a_book_fore_edge_strip_stays_outside_the_content_crop() {
    // The strip runs along the recto's right border, a few pixels inside the
    // raster where the page's own lighter edge lies beyond it. Kept in the
    // crop, a B&W render published it as a black bar beside the text.
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/leaf-edge/prym-p00063-fore-edge-150dpi.png");
    let decoded = decode_image(&fs::read(path).unwrap(), 10_000_000, 3_000).unwrap();
    let result = analyze_page_with_color_and_document_prior(
        &decoded.gray,
        Some(&decoded.rgb),
        &CleanupOptions {
            dpi: 150.0,
            output_mode: OutputMode::Bw,
            crop_content: true,
            ..CleanupOptions::default()
        },
        None,
    )
    .unwrap();
    let content = result.outputs[0]
        .content_box
        .expect("a text page has a content box");
    // Text ink ends at x = 666; the strip occupies the last eight columns.
    assert!(content.right() >= 667.0, "the crop cut text: {content:?}");
    assert!(
        content.right() <= 700.0,
        "the crop kept the fore-edge strip: {content:?}"
    );
}
