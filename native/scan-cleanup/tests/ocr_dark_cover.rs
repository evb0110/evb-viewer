use evb_scan_cleanup::{
    engine::render::clean_page_with_color, CleanupOptions, LayoutMode, ManualZones,
    NormalizedZonePoint, NormalizedZonePolygon, OrthogonalRotation, OutputMode, PictureZone,
    PictureZoneLayer,
};
use scan_primitives::GrayImage;

#[test]
fn dark_cover_bilevel_render_keeps_picture_content_out_of_ocr_ink() {
    let mut source = GrayImage::new(512, 512, 24);
    for y in (40..176).step_by(24) {
        for stroke_y in y..y + 6 {
            for x in 32..224 {
                source.set(x, stroke_y, 220);
            }
        }
    }
    for y in 220..432 {
        for x in 280..480 {
            source.set(x, y, 50 + ((x * 37 + y * 61) % 200) as u8);
        }
    }

    let result = clean_page_with_color(
        &source,
        None,
        &CleanupOptions {
            output_mode: OutputMode::Bw,
            layout: LayoutMode::Single,
            normalize_illumination: false,
            crop_content: false,
            match_page_size: false,
            ocr_mode: true,
            dpi: 300.0,
            source_dpi: Some(300.0),
            manual_zones: ManualZones {
                picture: vec![PictureZone {
                    polygon: NormalizedZonePolygon {
                        points: vec![
                            NormalizedZonePoint { x: 0.54, y: 0.43 },
                            NormalizedZonePoint { x: 0.94, y: 0.43 },
                            NormalizedZonePoint { x: 0.94, y: 0.84 },
                            NormalizedZonePoint { x: 0.54, y: 0.84 },
                        ],
                        rotation: OrthogonalRotation::None,
                    },
                    layer: PictureZoneLayer::Painter2,
                }],
                fill: vec![],
            },
            ..CleanupOptions::default()
        },
        0,
    )
    .unwrap();
    let image = result.outputs[0]
        .image
        .bilevel()
        .expect("OCR black-and-white render should stay bilevel");

    assert!(
        image.get(48, 42),
        "bright printed strokes outside the picture must become OCR ink"
    );
    let picture_ink = (300..460)
        .flat_map(|x| (240..410).map(move |y| (x, y)))
        .filter(|&(x, y)| image.get(x, y))
        .count();
    assert!(
        picture_ink == 0,
        "picture-region pixels must remain excluded from OCR ink: {picture_ink}"
    );
}

#[test]
fn polarity_only_dark_cover_emits_only_light_print_as_ocr_ink() {
    let mut source = GrayImage::new(512, 512, 24);
    for y in (40..176).step_by(24) {
        for stroke_y in y..y + 6 {
            for x in 32..224 {
                source.set(x, stroke_y, 220);
            }
        }
    }

    let result = clean_page_with_color(
        &source,
        None,
        &CleanupOptions {
            output_mode: OutputMode::Bw,
            layout: LayoutMode::Single,
            normalize_illumination: false,
            crop_content: false,
            match_page_size: false,
            ocr_mode: true,
            ocr_polarity_only: true,
            dpi: 300.0,
            source_dpi: Some(300.0),
            ..CleanupOptions::default()
        },
        0,
    )
    .unwrap();
    let image = result.outputs[0]
        .image
        .bilevel()
        .expect("dark polarity-only OCR should emit a bilevel mask");

    assert!(image.get(48, 42), "bright cover print must become OCR ink");
    assert!(
        !image.get(0, 0),
        "dark cover background must not become OCR ink"
    );
}

#[test]
fn polarity_only_ordinary_page_preserves_the_source_as_grayscale() {
    let mut source = GrayImage::new(128, 128, 224);
    for y in 24..104 {
        for x in 20..108 {
            if (x + y) % 17 == 0 {
                source.set(x, y, 38);
            }
        }
    }
    let source_sample = source.get(20, 24);

    let result = clean_page_with_color(
        &source,
        None,
        &CleanupOptions {
            output_mode: OutputMode::Bw,
            layout: LayoutMode::Single,
            normalize_illumination: false,
            crop_content: false,
            match_page_size: false,
            ocr_mode: true,
            ocr_polarity_only: true,
            dpi: 300.0,
            source_dpi: Some(300.0),
            ..CleanupOptions::default()
        },
        0,
    )
    .unwrap();
    let image = &result.outputs[0].image;

    assert!(
        image.bilevel().is_none(),
        "ordinary OCR pages stay grayscale"
    );
    assert_eq!(image.get(20, 24), source_sample);
    assert_eq!(image.get(27, 24), source.get(27, 24));
}

#[test]
fn polarity_only_ignores_manual_skew_and_dewarp_geometry() {
    let mut source = GrayImage::new(512, 512, 24);
    for y in (40..176).step_by(24) {
        for stroke_y in y..y + 6 {
            for x in 32..224 {
                source.set(x, stroke_y, 220);
            }
        }
    }

    let output = clean_page_with_color(
        &source,
        None,
        &CleanupOptions {
            output_mode: OutputMode::Bw,
            layout: LayoutMode::Single,
            normalize_illumination: false,
            crop_content: false,
            match_page_size: false,
            ocr_mode: true,
            ocr_polarity_only: true,
            manual_skew_degrees: Some(12.0),
            dewarp: Some(evb_scan_cleanup::DewarpOptions {
                top_curve: vec![
                    scan_primitives::Point::new(0.0, 0.0),
                    scan_primitives::Point::new(256.0, 12.0),
                    scan_primitives::Point::new(512.0, 0.0),
                ],
                bottom_curve: vec![
                    scan_primitives::Point::new(0.0, 512.0),
                    scan_primitives::Point::new(256.0, 500.0),
                    scan_primitives::Point::new(512.0, 512.0),
                ],
                depth: 0.1,
            }),
            dpi: 300.0,
            source_dpi: Some(300.0),
            ..CleanupOptions::default()
        },
        0,
    )
    .unwrap()
    .outputs
    .remove(0);

    assert_eq!((output.image.width(), output.image.height()), (512, 512));
    assert!(!output.metadata.skew_applied);
    assert!(output.metadata.dewarp_mapping.is_none());
}
