use evb_scan_cleanup::{
    split::{detect_split, FoldBand, LayoutClassification},
    LayoutMode,
};
use scan_primitives::GrayImage;

fn measured_fold_edges(gray: &GrayImage, cutter_x: f64) -> (f64, f64) {
    let result = detect_split(gray, 150.0, LayoutMode::Auto, Some(cutter_x));
    assert_eq!(result.classification, LayoutClassification::TwoPageSpread);
    match result.diagnostics.fold_band {
        FoldBand::Measured {
            left_x_px,
            right_x_px,
        } => (left_x_px, right_x_px),
        other => panic!("expected a measured fold band, got {other:?}"),
    }
}

#[test]
fn carried_cutter_finds_a_distant_same_side_fold_shadow() {
    let mut page = GrayImage::new(2_200, 900, 255);
    for y in 0..page.height() {
        for x in 0..900 {
            page.set(x, y, 174);
        }
    }
    for y in (28..page.height() - 28).step_by(18) {
        for x in 1_240..2_100 {
            page.set(x, y, 20);
            page.set(x, y + 1, 20);
        }
    }
    for y in 45..855 {
        for x in 1_120..1_172 {
            page.set(x, y, 231);
        }
        for x in 1_130..1_150 {
            page.set(x, y, 184);
        }
    }

    let (left, right) = measured_fold_edges(&page, 1_003.0);
    assert_eq!(left, 1_003.0, "only the right leaf owns this shadow");
    assert!(
        (1_172.0..1_240.0).contains(&right),
        "offset shadow survived at {left}..{right}"
    );
}

#[test]
fn carried_cutter_preserves_a_legacy_one_column_fold_band() {
    let mut page = GrayImage::new(1_000, 600, 245);
    for y in 0..page.height() {
        page.set(500, y, 185);
    }

    assert_eq!(measured_fold_edges(&page, 500.0), (500.0, 501.0));
}
