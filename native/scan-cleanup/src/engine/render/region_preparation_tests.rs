use super::*;

#[test]
fn crops_analysis_plane_to_the_requested_region() {
    let source = GrayImage::new(20, 12, 255);
    let options = CleanupOptions::default();
    let output = prepare(Input {
        analysis_normalized: &source,
        analysis_scale_x: 1.0,
        analysis_scale_y: 1.0,
        analysis_picture_mask: None,
        faint_stroke_masks: [None, None],
        tone_picture_mask: None,
        text_mask: None,
        text_vicinity_mask: None,
        options: &options,
        half: PageHalf::Full,
        region: Rect::new(3.0, 2.0, 7.0, 5.0),
        working_width: 7,
        working_height: 5,
    });
    assert_eq!(
        (
            output.analysis_working.width(),
            output.analysis_working.height()
        ),
        (7, 5)
    );
    assert_eq!(output.local_scale_x, 1.0);
    assert_eq!(output.local_scale_y, 1.0);
    assert!(output.text_tone_diagnostics.is_none());
}

#[test]
fn propagates_non_unit_analysis_scales_into_crop_dimensions_and_local_scales() {
    let source = GrayImage::new(100, 80, 255);
    let options = CleanupOptions::default();
    let output = prepare(Input {
        analysis_normalized: &source,
        analysis_scale_x: 0.5,
        analysis_scale_y: 0.25,
        analysis_picture_mask: None,
        faint_stroke_masks: [None, None],
        tone_picture_mask: None,
        text_mask: None,
        text_vicinity_mask: None,
        options: &options,
        half: PageHalf::Full,
        region: Rect::new(10.0, 8.0, 20.0, 16.0),
        working_width: 20,
        working_height: 16,
    });

    assert_eq!(
        (
            output.analysis_working.width(),
            output.analysis_working.height()
        ),
        (10, 4)
    );
    assert_eq!(output.local_scale_x, 0.5);
    assert_eq!(output.local_scale_y, 0.25);
}

#[test]
fn derives_grayscale_text_tone_diagnostics_from_cropped_masks() {
    let mut source = GrayImage::new(96, 64, 240);
    let mut text_mask = BinaryImage::new(96, 64);
    let mut vicinity_mask = BinaryImage::new(96, 64);
    for y in (8..56).step_by(4) {
        for x in 12..84 {
            source.set(x, y, 80);
            text_mask.set(x, y, true);
            vicinity_mask.set(x, y, true);
        }
    }
    let options = CleanupOptions {
        output_mode: OutputMode::Grayscale,
        ..CleanupOptions::default()
    };
    let output = prepare(Input {
        analysis_normalized: &source,
        analysis_scale_x: 1.0,
        analysis_scale_y: 1.0,
        analysis_picture_mask: None,
        faint_stroke_masks: [None, None],
        tone_picture_mask: None,
        text_mask: Some(&text_mask),
        text_vicinity_mask: Some(&vicinity_mask),
        options: &options,
        half: PageHalf::Full,
        region: Rect::new(8.0, 4.0, 80.0, 56.0),
        working_width: 80,
        working_height: 56,
    });

    let diagnostics = output
        .text_tone_diagnostics
        .expect("Grayscale text masks should produce diagnostics");
    assert!(diagnostics.text_ink_pixels > 0);
    assert_eq!(diagnostics.text_line_count, 12);
}

#[test]
fn resolved_text_tone_diagnostics_take_precedence_over_derived_masks() {
    let source = GrayImage::new(40, 30, 220);
    let text_mask = BinaryImage::new(40, 30);
    let vicinity_mask = BinaryImage::new(40, 30);
    let resolved = TextToneDiagnostics::identity(
        crate::text_tone::TextToneRule::PictureEvidence,
        77,
        1234,
        0.25,
        0.0,
        0.0,
        0.0,
        0.0,
        Some(121),
    );
    let options = CleanupOptions {
        output_mode: OutputMode::Grayscale,
        resolved_text_tone_diagnostics: crate::domain::options::ResolvedTextToneDiagnostics {
            full: Some(resolved),
            ..Default::default()
        },
        ..CleanupOptions::default()
    };
    let output = prepare(Input {
        analysis_normalized: &source,
        analysis_scale_x: 1.0,
        analysis_scale_y: 1.0,
        analysis_picture_mask: None,
        faint_stroke_masks: [None, None],
        tone_picture_mask: None,
        text_mask: Some(&text_mask),
        text_vicinity_mask: Some(&vicinity_mask),
        options: &options,
        half: PageHalf::Full,
        region: Rect::new(0.0, 0.0, 40.0, 30.0),
        working_width: 40,
        working_height: 30,
    });

    assert_eq!(output.text_tone_diagnostics, Some(resolved));
}

#[test]
fn crops_all_region_evidence_and_derives_diagnostics_from_the_cropped_inputs() {
    let mut source = GrayImage::from_vec(12, 10, 12, (0..120).map(|value| value as u8).collect())
        .expect("synthetic raster dimensions must be valid");
    source.set(3, 2, 80);
    let mut picture_mask = BinaryImage::new(12, 10);
    picture_mask.set(4, 2, true);
    let mut tone_mask = BinaryImage::new(12, 10);
    tone_mask.set(5, 3, true);
    tone_mask.set(4, 3, true);
    let mut text_mask = BinaryImage::new(12, 10);
    text_mask.set(3, 2, true);
    let mut vicinity_mask = BinaryImage::new(12, 10);
    vicinity_mask.set(3, 2, true);
    let options = CleanupOptions {
        output_mode: OutputMode::Grayscale,
        ..CleanupOptions::default()
    };

    let output = prepare(Input {
        analysis_normalized: &source,
        analysis_scale_x: 0.5,
        analysis_scale_y: 0.5,
        analysis_picture_mask: Some(&picture_mask),
        faint_stroke_masks: [None, None],
        tone_picture_mask: Some(&tone_mask),
        text_mask: Some(&text_mask),
        text_vicinity_mask: Some(&vicinity_mask),
        options: &options,
        half: PageHalf::Full,
        region: Rect::new(4.0, 2.0, 8.0, 6.0),
        working_width: 8,
        working_height: 6,
    });

    assert_eq!(
        output.analysis_working.data(),
        &[14, 15, 16, 17, 26, 80, 28, 29, 38, 39, 40, 41]
    );
    assert_eq!(output.local_scale_x, 0.5);
    assert_eq!(output.local_scale_y, 0.5);
    assert_eq!(
        output
            .analysis_picture_working
            .as_ref()
            .unwrap()
            .count_black(),
        1
    );
    assert!(output.analysis_picture_working.as_ref().unwrap().get(2, 1));
    assert!(output.text_tone_diagnostics.is_some());
    let diagnostics = output.text_tone_diagnostics.unwrap();
    assert_eq!(diagnostics.text_line_count, 1);
    assert_eq!(diagnostics.text_ink_pixels, 1);
    assert_eq!(diagnostics.picture_fraction, 2.0 / 12.0);
}
