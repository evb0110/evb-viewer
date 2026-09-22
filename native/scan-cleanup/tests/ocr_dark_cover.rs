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
