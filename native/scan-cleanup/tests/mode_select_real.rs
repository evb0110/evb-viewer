use evb_scan_cleanup::{
    engine::render::analyze_page_with_color_and_document_prior, io::png::decode_image,
    CleanupOptions, OutputMode,
};
use std::{fs, path::Path};

#[test]
fn auto_keeps_faint_connected_pencil_beside_dark_print_but_removes_verso_text() {
    use evb_scan_cleanup::{engine::render::clean_page, LayoutMode};
    use scan_primitives::GrayImage;

    // Issue #1338's full-size 300 DPI title page, including the scanner blur.
    let blur = |source: &GrayImage| {
        let kernel = [1u32, 4, 6, 4, 1];
        let mut horizontal = vec![0u32; source.width() * source.height()];
        for y in 0..source.height() {
            for x in 0..source.width() {
                horizontal[y * source.width() + x] = kernel
                    .iter()
                    .enumerate()
                    .map(|(i, weight)| {
                        let column = (x + i).saturating_sub(2).min(source.width() - 1);
                        weight * u32::from(source.get(column, y))
                    })
                    .sum();
            }
        }
        let mut output = source.clone();
        for y in 0..source.height() {
            for x in 0..source.width() {
                let sum: u32 = kernel
                    .iter()
                    .enumerate()
                    .map(|(i, weight)| {
                        let row = (y + i).saturating_sub(2).min(source.height() - 1);
                        weight * horizontal[row * source.width() + x]
                    })
                    .sum();
                output.set(x, y, ((sum + 128) / 256) as u8);
            }
        }
        output
    };
    let mut print = GrayImage::new(1700, 2400, 224);
    for (top, glyphs) in [(600, 8), (900, 6), (1200, 9)] {
        for glyph in 0..glyphs {
            let left = 300 + glyph * 120;
            for y in top..top + 90 {
                for x in left..left + 70 {
                    if x < left + 14 || x >= left + 56 || y < top + 12 {
                        print.set(x, y, 40);
                    }
                }
            }
        }
    }
    let options = CleanupOptions {
        dpi: 300.0,
        output_mode: OutputMode::Auto,
        layout: LayoutMode::Single,
        crop_content: false,
        match_page_size: false,
        margins_mm: None,
        ..CleanupOptions::default()
    };
    for value in [190, 175, 160] {
        let mut page = print.clone();
        for x in 1150..=1530 {
            let y = (940.0 + 40.0 * ((x - 1150) as f64 * 18.0 / 380.0).sin()).round() as usize;
            for row in y - 1..=y + 1 {
                page.set(x, row, value);
            }
        }
        let page = blur(&page);
        let note_depth = (895..986)
            .flat_map(|y| (1150..=1530).map(move |x| (x, y)))
            .map(|(x, y)| 224 - page.get(x, y))
            .max()
            .unwrap();
        let cleaned = clean_page(&page, &options, 0).unwrap();
        let output = &cleaned.outputs[0].image;
        let kept_columns = (1150..=1530)
            .filter(|&x| (895..986).any(|y| output.get(x, y) < 250))
            .count();
        assert_eq!(
            kept_columns, 381,
            "pencil value {value}: only {kept_columns} of 381 columns survived"
        );
        assert!(output.get(306, 640) < 60, "dark print lost its tone");
        assert_eq!(output.get(1400, 1400), 255, "unmarked paper stayed gray");

        // Disconnected reverse-side glyphs at the same depth, mirrored and
        // blurred twice, must not borrow continuity across their paper gaps.
        let mut verso = GrayImage::new(1700, 2400, 224);
        for row in 0..5 {
            for glyph in 0..10 {
                let left = 150 + glyph * 38;
                let top = 1450 + row * 55;
                for y in top..top + 30 {
                    for x in left..left + 18 {
                        if x < left + 3 || y < top + 3 || (top + 14..top + 17).contains(&y) {
                            verso.set(1699 - x, y, value);
                        }
                    }
                }
            }
        }
        let verso = blur(&blur(&verso));
        let verso_depth = 224 - verso.data().iter().min().unwrap();
        let mut control = blur(&print);
        for (ink, &back) in control.data_mut().iter_mut().zip(verso.data()) {
            let depth = (u32::from(224 - back) * u32::from(note_depth)
                + u32::from(verso_depth) / 2)
                / u32::from(verso_depth);
            *ink = (*ink).min(224 - depth as u8);
        }
        let cleaned = clean_page(&control, &options, 0).unwrap();
        let output = &cleaned.outputs[0].image;
        assert!(
            output.bilevel().is_some(),
            "verso value {value} made Auto grayscale"
        );
        let remaining = (1440..1710)
            .flat_map(|y| (1140..1555).map(move |x| (x, y)))
            .filter(|&(x, y)| output.get(x, y) < 250)
            .count();
        assert_eq!(remaining, 0, "verso value {value} left {remaining} pixels");
    }
}

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
