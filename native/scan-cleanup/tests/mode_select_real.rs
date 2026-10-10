use evb_scan_cleanup::{
    engine::render::analyze_page_with_color_and_document_prior, io::png::decode_image,
    CleanupOptions, OutputMode,
};
use std::{fs, path::Path};

#[test]
fn auto_renders_a_blank_sheet_with_a_fold_crease_as_black_and_white() {
    use evb_scan_cleanup::{engine::render::clean_page, LayoutMode};
    use scan_primitives::GrayImage;

    // Issue #1325: 1700 x 2400 at 300 DPI, paper 236, a five-pixel
    // vertical crease with depth 70 - 15 * distance from its centre.
    let mut page = GrayImage::new(1700, 2400, 236);
    for y in 300..=2100 {
        for x in 298usize..=302 {
            page.set(x, y, 236 - (70 - 15 * x.abs_diff(300)) as u8);
        }
    }
    for dpi in [150.0, 300.0] {
        let source = if dpi == 150.0 {
            page.resample_to_dimensions(850, 1200)
        } else {
            page.clone()
        };
        let cleaned = clean_page(
            &source,
            &CleanupOptions {
                dpi,
                output_mode: OutputMode::Auto,
                layout: LayoutMode::Single,
                crop_content: false,
                match_page_size: false,
                margins_mm: None,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        let output = &cleaned.outputs[0];
        assert!(
            output.image.bilevel().is_some(),
            "{dpi} DPI crease-only page stayed continuous-tone: {:?}",
            cleaned.output_mode_recommendation,
        );
        assert_eq!(output.image.get(500, 500), 255, "paper stayed gray");
    }
}

#[test]
fn auto_preserves_single_serifed_page_numbers_with_or_without_a_crease() {
    use evb_scan_cleanup::{engine::render::clean_page, LayoutMode};
    use scan_primitives::GrayImage;

    let options = CleanupOptions {
        dpi: 300.0,
        output_mode: OutputMode::Auto,
        layout: LayoutMode::Single,
        crop_content: false,
        match_page_size: false,
        margins_mm: None,
        ..CleanupOptions::default()
    };
    let mut fragment = GrayImage::new(1700, 2400, 236);
    for y in 900..940 {
        for x in 298usize..=302 {
            fragment.set(x, y, 236 - (70 - 15 * x.abs_diff(300)) as u8);
        }
    }
    for (width, stem, height, value, with_crease) in [
        (12, 2, 64, 32, true),
        (16, 2, 64, 32, true),
        (8, 4, 64, 32, false),
        (10, 6, 64, 32, false),
        (12, 4, 64, 32, false),
        (8, 4, 64, 185, false),
        (6, 4, 40, 32, false),
        (6, 4, 40, 80, false),
        (6, 4, 40, 185, false),
    ] {
        let mut numbered = if with_crease {
            fragment.clone()
        } else {
            GrayImage::new(1700, 2400, 236)
        };
        let left = 900 + (width - stem) / 2;
        for y in 1600..1600 + height {
            for x in 900..900 + width {
                if (left..left + stem).contains(&x) || !(1604..1600 + height - 4).contains(&y) {
                    numbered.set(x, y, value);
                }
            }
        }
        let cleaned = clean_page(&numbered, &options, 0).unwrap();
        let output = &cleaned.outputs[0].image;
        let ink = (1600..1600 + height)
            .flat_map(|y| (900..900 + width).map(move |x| (x, y)))
            .filter(|&(x, y)| output.get(x, y) < 250)
            .count();
        assert_eq!(
            ink,
            width * 8 + stem * (height - 8),
            "{width}x{height}, ink {value}, crease {with_crease}: numeral lost ink; {:?}",
            cleaned.output_mode_recommendation,
        );
    }
}

#[test]
fn auto_keeps_faint_connected_pencil_beside_dark_print_but_removes_verso_text() {
    use evb_scan_cleanup::{engine::render::clean_page, LayoutMode};
    use scan_primitives::{GrayImage, Point};

    // Issue #1338's full-size 300 DPI title page, including the scanner blur.
    let blur = |source: &GrayImage, kernel: &[u32]| {
        let divisor = kernel.iter().sum::<u32>().pow(2);
        let mut horizontal = vec![0u32; source.width() * source.height()];
        for y in 0..source.height() {
            for x in 0..source.width() {
                horizontal[y * source.width() + x] = kernel
                    .iter()
                    .enumerate()
                    .map(|(i, weight)| {
                        let column = (x + i)
                            .saturating_sub(kernel.len() / 2)
                            .min(source.width() - 1);
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
                        let row = (y + i)
                            .saturating_sub(kernel.len() / 2)
                            .min(source.height() - 1);
                        weight * horizontal[row * source.width() + x]
                    })
                    .sum();
                output.set(x, y, ((sum + divisor / 2) / divisor) as u8);
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
    // Issue #1345: small pencil rings must not depend on the surrounding page size.
    for dpi in [150.0, 300.0] {
        let scale = if dpi == 150.0 { 1 } else { 2 };
        let mut page = GrayImage::new(1240 * scale, 1754 * scale, 224);
        for (top, glyphs) in [(350, 7), (600, 6), (850, 8), (1100, 7)] {
            for glyph in 0..glyphs {
                let left = 160 + glyph * 65;
                for y in top * scale..(top + 60) * scale {
                    for x in left * scale..(left + 40) * scale {
                        if x < (left + 9) * scale
                            || x >= (left + 31) * scale
                            || y < (top + 8) * scale
                        {
                            page.set(x, y, 40);
                        }
                    }
                }
            }
        }
        let mut rings = Vec::new();
        for (radius, row) in [(10, 400), (20, 700), (40, 1000)] {
            for column in [900, 1050] {
                let (cx, cy) = (column * scale, row * scale);
                let mut pixels = Vec::new();
                for y in cy - radius - 2..=cy + radius + 2 {
                    for x in cx - radius - 2..=cx + radius + 2 {
                        let distance = (x as f64 - cx as f64).hypot(y as f64 - cy as f64);
                        if (distance - radius as f64).abs() <= 1.0 {
                            page.set(x, y, 194);
                            pixels.push((x, y));
                        }
                    }
                }
                rings.push((radius, cx, cy, pixels));
            }
        }
        let cleaned = clean_page(
            &blur(&page, &[1, 2, 1]),
            &CleanupOptions {
                dpi,
                ..options.clone()
            },
            0,
        )
        .unwrap();
        let output = &cleaned.outputs[0].image;
        assert!(
            output.bilevel().is_some(),
            "{dpi} DPI rings changed Auto to grayscale"
        );
        for (radius, cx, cy, pixels) in rings {
            let kept = pixels
                .iter()
                .filter(|&&(x, y)| output.get(x, y) < 200)
                .count();
            if dpi == 150.0 {
                assert_eq!(kept, pixels.len(), "radius {radius}: faint ring lost ink");
            }
            // The 300 DPI render maps the canonical 150 DPI contour. Pixel
            // counts may differ with sampling, but every arc must remain visible.
            let mut arcs = [false; 8];
            for (x, y) in pixels {
                if output.get(x, y) < 200 {
                    let arc = usize::from(x >= cx) * 4
                        + usize::from(y >= cy) * 2
                        + usize::from(x.abs_diff(cx) >= y.abs_diff(cy));
                    arcs[arc] = true;
                }
            }
            assert!(
                arcs.iter().all(|&kept| kept),
                "{dpi} DPI radius {radius}: ring lost an arc"
            );
            assert_eq!(output.get(cx, cy), 255, "radius {radius}: ring filled in");
        }
    }
    for value in [190, 175, 160] {
        let mut page = print.clone();
        for x in 1150..=1530 {
            let y = (940.0 + 40.0 * ((x - 1150) as f64 * 18.0 / 380.0).sin()).round() as usize;
            for row in y - 1..=y + 1 {
                page.set(x, row, value);
            }
        }
        let page = blur(&page, &[1, 4, 6, 4, 1]);
        let note_depth = (895..986)
            .flat_map(|y| (1150..=1530).map(move |x| (x, y)))
            .map(|(x, y)| 224 - page.get(x, y))
            .max()
            .unwrap();
        for crop_content in [false, true] {
            let options = CleanupOptions {
                crop_content,
                ..options.clone()
            };
            let cleaned = clean_page(&page, &options, 0).unwrap();
            let result = &cleaned.outputs[0];
            let output = &result.image;
            let transform = result.metadata.forward_transform.unwrap();
            let kept_columns = (1150..=1530)
                .filter(|&x| {
                    (895..986).any(|y| {
                        let point = transform.apply(Point::new(x as f64, y as f64));
                        point.x >= 0.0
                            && point.y >= 0.0
                            && point.x.round() < output.width() as f64
                            && point.y.round() < output.height() as f64
                            && output.get(point.x.round() as usize, point.y.round() as usize) < 250
                    })
                })
                .count();
            assert_eq!(kept_columns, 381,
                "pencil value {value}, crop {crop_content}: only {kept_columns} of 381 columns survived");
            let print = transform.apply(Point::new(306.0, 640.0));
            assert!(
                output.get(print.x.round() as usize, print.y.round() as usize) < 60,
                "dark print lost its tone"
            );
            if !crop_content {
                assert_eq!(output.get(1400, 1400), 255, "unmarked paper stayed gray");
            }
        }

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
        let verso = blur(&blur(&verso, &[1, 4, 6, 4, 1]), &[1, 4, 6, 4, 1]);
        let verso_depth = 224 - verso.data().iter().min().unwrap();
        let mut control = blur(&print, &[1, 4, 6, 4, 1]);
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
        let cropped = clean_page(
            &control,
            &CleanupOptions {
                crop_content: true,
                ..options.clone()
            },
            0,
        )
        .unwrap();
        let content = cropped.outputs[0].metadata.content_box.unwrap();
        assert!(
            content.right() < 1400.0 && content.bottom() < 1400.0,
            "verso value {value} expanded the print crop: {content:?}"
        );
    }
    // review6b: sparse rectilinear glyphs cannot borrow bounding-box extent;
    // a genuine note cannot republish unrelated verso ink or the physical rail.
    for (case, note, rail, large) in [
        ("large-verso", false, false, true),
        ("note-plus-rail", true, true, false),
        ("rail-control", false, true, false),
        ("note-plus-small-verso", true, false, false),
    ] {
        let mut page = print.clone();
        if note {
            for x in 1150..=1530 {
                let y = (940.0 + 40.0 * ((x - 1150) as f64 * 18.0 / 380.0).sin()).round() as usize;
                for row in y - 1..=y + 1 {
                    page.set(x, row, 190);
                }
            }
        }
        let mut page = blur(&page, &[1, 4, 6, 4, 1]);
        if rail {
            for y in 40..2360 {
                for x in 0..5 {
                    page.set(x, y, 132 + (x * 9) as u8);
                }
            }
        } else {
            let mut verso = GrayImage::new(1700, 2400, 224);
            let (width, height, stroke, pitch, count) = if large {
                (250, 180, 4, 300, 3)
            } else {
                (18, 30, 3, 38, 10)
            };
            for glyph in 0..count {
                let left = 150 + glyph * pitch;
                let top = 1500;
                for y in top..top + height {
                    for x in left..left + width {
                        if x < left + stroke
                            || y < top + stroke
                            || (top + height / 2..top + height / 2 + stroke).contains(&y)
                            || y >= top + height - stroke
                        {
                            verso.set(1699 - x, y, 190);
                        }
                    }
                }
            }
            let verso = blur(&blur(&verso, &[1, 4, 6, 4, 1]), &[1, 4, 6, 4, 1]);
            for (ink, &back) in page.data_mut().iter_mut().zip(verso.data()) {
                *ink = (*ink).min(back);
            }
        }
        let result = clean_page(&page, &options, 0).unwrap();
        let output = &result.outputs[0].image;
        assert!(
            output.bilevel().is_some(),
            "{case} changed Auto to grayscale"
        );
        assert_eq!(
            (1450..1700)
                .flat_map(|y| (750..1600).map(move |x| (x, y)))
                .filter(|&(x, y)| output.get(x, y) < 250)
                .count(),
            0,
            "{case} kept show-through"
        );
        assert_eq!(
            (0..5)
                .map(|x| (0..output.height())
                    .filter(|&y| output.get(x, y) < 250)
                    .count())
                .max()
                .unwrap(),
            0,
            "{case} kept the physical rail"
        );
        if note {
            assert_eq!(
                (1150..=1530)
                    .filter(|&x| (895..986).any(|y| output.get(x, y) < 250))
                    .count(),
                381,
                "{case} lost the note"
            );
        }
    }
    // The original 1915 title leaf has a looping word and a separate digit 5.
    let real = decode_image(
        include_bytes!("fixtures/pencil/prym-title-p00005-150dpi.png"),
        10_000_000,
        3_000,
    )
    .unwrap()
    .gray;
    for crop_content in [false, true] {
        let result = clean_page(
            &real,
            &CleanupOptions {
                dpi: 150.0,
                crop_content,
                ..options.clone()
            },
            0,
        )
        .unwrap();
        let output = &result.outputs[0].image;
        let transform = result.outputs[0].metadata.forward_transform.unwrap();
        let authored = (503..615).filter(|&x| (535..590).any(|y| real.get(x, y) < 200));
        for x in authored {
            assert!(
                (535..590).filter(|&y| real.get(x, y) < 200).any(|y| {
                    let p = transform.apply(Point::new(x as f64, y as f64));
                    output.get(p.x.round() as usize, p.y.round() as usize) < 128
                }),
                "real pencil column {x} vanished, crop {crop_content}"
            );
        }
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
