use super::*;

#[test]
fn blank_single_region_has_pinned_raster_and_blankness() {
    let source = GrayImage::new(12, 10, 255);
    let options = CleanupOptions {
        layout: crate::LayoutMode::Single,
        output_mode: OutputMode::Bw,
        ..CleanupOptions::default()
    };
    let split = crate::split::single_page(source.width(), source.height());
    let result = run(Input {
        source: &source,
        routing_source: &source,
        normalized: &source,
        analysis_normalized: &source,
        analysis_scale_x: 1.0,
        analysis_scale_y: 1.0,
        canonical_routing_sample: &source,
        canonical_leaf_source: &source,
        canonical_routing_dpi: options.dpi,
        calibration: PageCalibration::estimate(&source, options.dpi, CalibrationConfig::default()),
        color_source: None,
        analysis_picture_mask: None,
        source_picture_mask: None,
        halftone_zone_mask: None,
        spatial_tone_mask: None,
        chroma_picture_mask: None,
        tone_picture_mask: None,
        preserve_confirmed_photo_tones: false,
        use_soft_alpha_foreground: false,
        tone_preservation_alpha: None,
        text_mask: None,
        text_vicinity_mask: None,
        trusted_foreground_mask: None,
        options: &options,
        source_page_index: 0,
        split: &split,
        spread_plan: None,
        region: Rect::new(0.0, 0.0, source.width() as f64, source.height() as f64),
        half: PageHalf::Full,
        cache: None,
        split_cache_key: None,
        source_effectively_blank: true,
        create_mixed_layers: false,
        create_mixed_composite: false,
        timings: &mut PageStageTimings::default(),
    })
    .expect("blank synthetic region should render");
    assert_eq!(result.metadata.output_width, source.width());
    assert_eq!(result.metadata.output_height, source.height());
    assert!(result.effectively_blank);
}

#[test]
fn nonblank_region_crosses_named_stages_and_keeps_semantic_planes() {
    let source = GrayImage::new(12, 10, 32);
    let options = CleanupOptions {
        layout: crate::LayoutMode::Single,
        output_mode: OutputMode::Grayscale,
        ..CleanupOptions::default()
    };
    let split = crate::split::single_page(source.width(), source.height());
    let result = run(Input {
        source: &source,
        routing_source: &source,
        normalized: &source,
        analysis_normalized: &source,
        analysis_scale_x: 1.0,
        analysis_scale_y: 1.0,
        canonical_routing_sample: &source,
        canonical_leaf_source: &source,
        canonical_routing_dpi: options.dpi,
        source_effectively_blank: false,
        calibration: PageCalibration::estimate(&source, options.dpi, CalibrationConfig::default()),
        color_source: None,
        analysis_picture_mask: None,
        source_picture_mask: None,
        halftone_zone_mask: None,
        spatial_tone_mask: None,
        chroma_picture_mask: None,
        tone_picture_mask: None,
        preserve_confirmed_photo_tones: false,
        use_soft_alpha_foreground: false,
        tone_preservation_alpha: None,
        text_mask: None,
        text_vicinity_mask: None,
        trusted_foreground_mask: None,
        options: &options,
        source_page_index: 0,
        split: &split,
        spread_plan: None,
        region: Rect::new(0.0, 0.0, source.width() as f64, source.height() as f64),
        half: PageHalf::Full,
        cache: None,
        split_cache_key: None,
        create_mixed_layers: false,
        create_mixed_composite: false,
        timings: &mut PageStageTimings::default(),
    })
    .expect("nonblank synthetic region should render");

    assert!(!result.effectively_blank);
    assert_eq!((result.image.width(), result.image.height()), (12, 10));
    assert_eq!(result.image.get(0, 0), 32);
    assert!(result.picture_mask.is_none());
}

#[test]
fn mixed_region_processes_an_explicit_empty_picture_mask() {
    let source = GrayImage::new(12, 10, 32);
    let empty_picture = BinaryImage::new(12, 10);
    let options = CleanupOptions {
        layout: crate::LayoutMode::Single,
        output_mode: OutputMode::Mixed,
        ..CleanupOptions::default()
    };
    let split = crate::split::single_page(source.width(), source.height());
    let result = run(Input {
        source: &source,
        routing_source: &source,
        normalized: &source,
        analysis_normalized: &source,
        analysis_scale_x: 1.0,
        analysis_scale_y: 1.0,
        canonical_routing_sample: &source,
        canonical_leaf_source: &source,
        canonical_routing_dpi: options.dpi,
        source_effectively_blank: false,
        calibration: PageCalibration::estimate(&source, options.dpi, CalibrationConfig::default()),
        color_source: None,
        analysis_picture_mask: None,
        source_picture_mask: Some(&empty_picture),
        halftone_zone_mask: None,
        spatial_tone_mask: None,
        chroma_picture_mask: None,
        tone_picture_mask: None,
        preserve_confirmed_photo_tones: false,
        use_soft_alpha_foreground: false,
        tone_preservation_alpha: None,
        text_mask: None,
        text_vicinity_mask: None,
        trusted_foreground_mask: None,
        options: &options,
        source_page_index: 0,
        split: &split,
        spread_plan: None,
        region: Rect::new(0.0, 0.0, source.width() as f64, source.height() as f64),
        half: PageHalf::Full,
        cache: None,
        split_cache_key: None,
        create_mixed_layers: true,
        create_mixed_composite: true,
        timings: &mut PageStageTimings::default(),
    })
    .expect("Mixed processing with an empty picture mask should succeed");

    assert!(!result.effectively_blank);
    assert_eq!(
        result
            .picture_mask
            .expect("empty mask is preserved")
            .count_black(),
        0
    );
    assert_eq!((result.image.width(), result.image.height()), (12, 10));
}

#[test]
fn transform_stage_returns_the_requested_masks_and_invertible_mapping() {
    let analysis = GrayImage::from_vec(8, 6, 8, (0..48).map(|value| value as u8).collect())
        .expect("synthetic analysis dimensions must be valid");
    let mut picture = BinaryImage::new(8, 6);
    picture.set(3, 2, true);
    let mut manual = BinaryImage::new(8, 6);
    manual.set(1, 1, true);
    let options = CleanupOptions {
        manual_skew_degrees: Some(0.0),
        ..CleanupOptions::default()
    };
    let output = prepare_region_transforms(TransformPreparationInput {
        analysis_working: analysis.clone(),
        analysis_picture_working: Some(picture.clone()),
        manual_picture_crop_authority: Some(manual.clone()),
        options: &options,
        half: PageHalf::Full,
        region: Rect::new(0.0, 0.0, 8.0, 6.0),
        working_width: 8,
        working_height: 6,
        local_scale_x: 1.0,
        local_scale_y: 1.0,
        calibration: PageCalibration::estimate(&analysis, 300.0, CalibrationConfig::default()),
        cache: None,
        split_cache_key: None,
        timings: &mut PageStageTimings::default(),
    })
    .expect("identity transform stage should succeed");

    assert!(output.deskew.accepted);
    assert_eq!(output.deskewed_analysis, analysis);
    assert_eq!(output.deskewed_picture_mask.expect("picture mask"), picture);
    assert_eq!(
        output
            .deskewed_manual_picture_crop_authority
            .expect("manual picture authority"),
        manual
    );
    assert!(output.dewarp_model.is_none());
}

#[test]
fn content_stage_maps_manual_content_to_source_and_preserves_diagnostics() {
    let source = GrayImage::new(20, 12, 210);
    let mut options = CleanupOptions::default();
    options.manual_content_boxes.full = Some(crate::NormalizedRect {
        x: 0.2,
        y: 0.25,
        width: 0.5,
        height: 0.5,
        rotation: OrthogonalRotation::None,
    });
    let output = detect_region_content(ContentDetectionInput {
        content_analysis: &source,
        content_picture_mask: None,
        manual_picture_crop_authority: None,
        normalized: &source,
        options: &options,
        source_effectively_blank: false,
        cache: None,
        deskew_key: None,
        source_page_index: 0,
        calibration: PageCalibration::estimate(&source, 300.0, CalibrationConfig::default()),
        local_scale_x: 1.0,
        local_scale_y: 1.0,
        working_width: source.width(),
        working_height: source.height(),
        routing_source: &source,
        region: Rect::new(0.0, 0.0, 20.0, 12.0),
        local_deskew_forward: Affine::IDENTITY,
        local_deskew_inverse: Affine::IDENTITY,
        dewarp_model: None,
        half: PageHalf::Full,
        timings: &mut PageStageTimings::default(),
    })
    .expect("manual content mapping should succeed");

    assert_eq!(output.diagnostics, None);
    assert_eq!(
        output.source_content_box,
        Some(Rect::new(4.0, 3.0, 10.0, 6.0))
    );
    assert_eq!(output.detected_content, output.source_content_box);
}

#[test]
fn geometry_stage_keeps_full_page_canvas_and_region_origin() {
    let options = CleanupOptions {
        output_mode: OutputMode::Color,
        ..CleanupOptions::default()
    };
    let output = plan_render_geometry(RenderGeometryInput {
        detected: CachedContentDetection {
            detected_content: None,
            source_content_box: None,
            diagnostics: None,
        },
        options: &options,
        region: Rect::new(0.0, 0.0, 32.0, 24.0),
        working_width: 32,
        working_height: 24,
        local_deskew_forward: Affine::scaling(1.0, 1.0),
        local_deskew_inverse: Affine::scaling(1.0, 1.0),
        dewarp_model: None,
    })
    .expect("full-page geometry should be valid");

    assert_eq!(output.output_rect, Rect::new(0.0, 0.0, 32.0, 24.0));
    assert_eq!((output.output_width, output.output_height), (32, 24));
    assert!(output.render_region.is_none());
    assert_eq!((output.rendered_width, output.rendered_height), (32, 24));
    assert_eq!(
        output.render_plan.output_to_source(Point::new(0.0, 0.0)),
        Some(Point::new(0.0, 0.0))
    );
}

#[test]
fn geometry_stage_pins_split_region_crop_coordinates_and_scale() {
    let options = CleanupOptions {
        output_mode: OutputMode::Color,
        render_crop: Some(crate::NormalizedRect {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
            rotation: OrthogonalRotation::None,
        }),
        ..CleanupOptions::default()
    };
    let output = plan_render_geometry(RenderGeometryInput {
        detected: CachedContentDetection {
            detected_content: None,
            source_content_box: None,
            diagnostics: None,
        },
        options: &options,
        region: Rect::new(10.0, 4.0, 20.0, 12.0),
        working_width: 20,
        working_height: 12,
        local_deskew_forward: Affine::scaling(1.0, 1.0),
        local_deskew_inverse: Affine::scaling(1.0, 1.0),
        dewarp_model: None,
    })
    .expect("split-page crop geometry should be valid");

    assert_eq!(output.render_region, Some(Rect::new(5.0, 3.0, 10.0, 6.0)));
    assert_eq!(output.sampled_region, output.render_region);
    assert_eq!(
        output.render_plan.output_rect(),
        Rect::new(5.0, 3.0, 10.0, 6.0)
    );
    assert_eq!((output.rendered_width, output.rendered_height), (10, 6));
    assert_eq!(
        output.render_plan.output_to_source(Point::new(0.0, 0.0)),
        Some(Point::new(15.0, 7.0))
    );
}

#[test]
fn raster_stage_preserves_grayscale_source_pixels_on_identity_plan() {
    let source = GrayImage::from_vec(4, 3, 4, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
        .expect("synthetic grayscale raster dimensions must be valid");
    let options = CleanupOptions {
        output_mode: OutputMode::Bw,
        ..CleanupOptions::default()
    };
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 4.0, 3.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        4,
        3,
        Rect::new(0.0, 0.0, 4.0, 3.0),
    );
    let output = prepare_render_planes(RasterPlaneInput {
        normalized: &source,
        routing_source: &source,
        color_source: None,
        source_picture_mask: None,
        tone_preservation_alpha: None,
        text_tone_diagnostics: None,
        options: &options,
        preserve_confirmed_photo_tones: false,
        working_width: 4,
        working_height: 3,
        render_region: None,
        sampled_region: None,
        output_rect: Rect::new(0.0, 0.0, 4.0, 3.0),
        render_plan: &plan,
        rendered_width: 4,
        rendered_height: 3,
        region: Rect::new(0.0, 0.0, 4.0, 3.0),
        local_deskew_forward: Affine::scaling(1.0, 1.0),
        local_deskew_inverse: Affine::scaling(1.0, 1.0),
        dewarp_model: None,
        timings: &mut PageStageTimings::default(),
    })
    .expect("identity raster plan should be valid");

    assert_eq!(output.rendered_gray.data(), source.data());
    assert_eq!(output.rendered_source_gray.data(), source.data());
    assert!(output.rendered_color.is_none());
    assert!(output.rendered_tone_alpha.is_none());
}

#[test]
fn raster_stage_keeps_optional_color_and_alpha_planes_aligned() {
    let source = GrayImage::new(3, 2, 80);
    let color = RgbImage::from_vec(
        3,
        2,
        vec![
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
        ],
    )
    .expect("synthetic RGB raster dimensions must be valid");
    let alpha = GrayImage::from_vec(3, 2, 3, vec![20, 40, 60, 80, 100, 120])
        .expect("synthetic alpha dimensions must be valid");
    let options = CleanupOptions {
        output_mode: OutputMode::Color,
        ..CleanupOptions::default()
    };
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 3.0, 2.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        3,
        2,
        Rect::new(0.0, 0.0, 3.0, 2.0),
    );
    let output = prepare_render_planes(RasterPlaneInput {
        normalized: &source,
        routing_source: &source,
        color_source: Some(&color),
        source_picture_mask: None,
        tone_preservation_alpha: Some(&alpha),
        text_tone_diagnostics: None,
        options: &options,
        preserve_confirmed_photo_tones: false,
        working_width: 3,
        working_height: 2,
        render_region: None,
        sampled_region: None,
        output_rect: Rect::new(0.0, 0.0, 3.0, 2.0),
        render_plan: &plan,
        rendered_width: 3,
        rendered_height: 2,
        region: Rect::new(0.0, 0.0, 3.0, 2.0),
        local_deskew_forward: Affine::scaling(1.0, 1.0),
        local_deskew_inverse: Affine::scaling(1.0, 1.0),
        dewarp_model: None,
        timings: &mut PageStageTimings::default(),
    })
    .expect("identity color plan should be valid");

    assert_eq!(
        output.rendered_color.expect("color plane is present"),
        color
    );
    let rendered_alpha = output.rendered_tone_alpha.expect("alpha plane is present");
    assert_eq!((rendered_alpha.width(), rendered_alpha.height()), (3, 2));
    assert_eq!(output.rendered_gray, GrayImage::new(3, 2, 255));
}

#[test]
fn mask_stage_keeps_absent_optional_masks_absent() {
    let normalized = GrayImage::new(4, 3, 255);
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 4.0, 3.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        4,
        3,
        Rect::new(0.0, 0.0, 4.0, 3.0),
    );
    let output = prepare_region_masks(MaskPreparationInput {
        normalized: &normalized,
        render_plan: &plan,
        rendered_width: 4,
        rendered_height: 3,
        source_picture_mask: None,
        halftone_zone_mask: None,
        spatial_tone_mask: None,
        chroma_picture_mask: None,
        tone_picture_mask: None,
        text_vicinity_mask: None,
        text_mask: None,
        trusted_foreground_mask: None,
        options: &CleanupOptions::default(),
        preserve_confirmed_photo_tones: false,
        text_line_count: 0,
        timings: &mut PageStageTimings::default(),
    });

    assert!(output.rendered_picture_mask.is_none());
    assert!(output.rendered_chroma_picture_mask.is_none());
    assert!(output.rendered_text_mask.is_none());
    assert!(output.rendered_trusted_foreground_mask.is_none());
}

#[test]
fn mask_stage_preserves_overlapping_confirmed_ownership_pixels() {
    let normalized = GrayImage::new(8, 4, 255);
    let mut picture = BinaryImage::new(8, 4);
    picture.set(2, 1, true);
    let mut spatial = BinaryImage::new(8, 4);
    spatial.set(5, 1, true);
    let mut text_vicinity = BinaryImage::new(8, 4);
    text_vicinity.set(2, 1, true);
    text_vicinity.set(5, 1, true);
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 8.0, 4.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        8,
        4,
        Rect::new(0.0, 0.0, 8.0, 4.0),
    );
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        ..CleanupOptions::default()
    };
    let output = prepare_region_masks(MaskPreparationInput {
        normalized: &normalized,
        render_plan: &plan,
        rendered_width: 8,
        rendered_height: 4,
        source_picture_mask: Some(&picture),
        halftone_zone_mask: None,
        spatial_tone_mask: Some(&spatial),
        chroma_picture_mask: None,
        tone_picture_mask: None,
        text_vicinity_mask: Some(&text_vicinity),
        text_mask: None,
        trusted_foreground_mask: None,
        options: &options,
        preserve_confirmed_photo_tones: true,
        text_line_count: 2,
        timings: &mut PageStageTimings::default(),
    });

    let picture = output
        .rendered_picture_mask
        .expect("confirmed ownership must produce a mask");
    assert_eq!(picture.count_black(), 2);
    assert!(picture.get(2, 1));
    assert!(picture.get(5, 1));
}

#[test]
fn blankness_policy_fails_closed_for_a_forced_blank_leaf() {
    let source = GrayImage::new(64, 64, 255);
    let output = resolve_blankness_policy(BlanknessPolicyInput {
        canonical_leaf_source: &source,
        canonical_routing_dpi: 300.0,
        force_clean_blank: true,
        content_present: false,
        rendered_picture_mask: None,
        rendered_text_mask: None,
        rendered_trusted_foreground_mask: None,
        preserve_confirmed_photo_tones: false,
        half: PageHalf::Full,
    });

    assert!(output.effectively_blank);
    assert!(output.fail_closed_blank);
    assert!(output.fold_edge_blank_leaf);
    assert!(output.unowned_fold_edge_blank_leaf);
    assert!(output.ink_ownership_mask.is_none());
    assert!(!output.trusted_selection_applied);
}

#[test]
fn blankness_policy_keeps_ownership_at_the_nonblank_threshold() {
    let source = GrayImage::from_vec(
        64,
        64,
        64,
        (0..64)
            .flat_map(|y| {
                (0..64).map(move |x| {
                    if (20..44).contains(&x) && (20..44).contains(&y) {
                        0
                    } else {
                        255
                    }
                })
            })
            .collect(),
    )
    .expect("synthetic threshold raster dimensions must be valid");
    let picture = BinaryImage::from_fn_parallel(64, 64, |x, y| {
        (20..44).contains(&x) && (20..44).contains(&y)
    });
    let output = resolve_blankness_policy(BlanknessPolicyInput {
        canonical_leaf_source: &source,
        canonical_routing_dpi: 300.0,
        force_clean_blank: false,
        content_present: false,
        rendered_picture_mask: Some(picture),
        rendered_text_mask: None,
        rendered_trusted_foreground_mask: None,
        preserve_confirmed_photo_tones: false,
        half: PageHalf::Full,
    });

    assert!(!output.effectively_blank);
    assert!(!output.fail_closed_blank);
    assert_eq!(
        output
            .ink_ownership_mask
            .as_ref()
            .expect("picture ownership must be retained")
            .count_black(),
        576
    );
    assert!(!output.unowned_fold_edge_blank_leaf);
}

#[test]
fn bilevel_stage_emits_a_standard_binary_raster() {
    let source = GrayImage::from_vec(
        8,
        8,
        8,
        (0..8)
            .flat_map(|y| (0..8).map(move |x| if x < 4 && y < 4 { 0 } else { 255 }))
            .collect(),
    )
    .expect("synthetic B&W raster dimensions must be valid");
    let options = CleanupOptions {
        output_mode: OutputMode::Bw,
        ..CleanupOptions::default()
    };
    let split = crate::split::single_page(8, 8);
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 8.0, 8.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        8,
        8,
        Rect::new(0.0, 0.0, 8.0, 8.0),
    );
    let output = process_bilevel_output(BilevelProcessingInput {
        rendered_gray: source.clone(),
        rendered_source_gray: source.clone(),
        canonical_routing_sample: &source,
        options: &options,
        spread_plan: None,
        calibration: PageCalibration::estimate(&source, 300.0, CalibrationConfig::default()),
        rendered_picture_mask: None,
        rendered_text_mask: None,
        rendered_text_vicinity_mask: None,
        rendered_trusted_foreground_mask: None,
        ink_ownership_mask: None,
        normalized_width: 8,
        normalized_height: 8,
        source_page_index: 0,
        half: PageHalf::Full,
        split: &split,
        region: Rect::new(0.0, 0.0, 8.0, 8.0),
        render_plan: &plan,
        source_content_box: None,
        fold_edge_blank_leaf: false,
        unowned_fold_edge_blank_leaf: false,
        effectively_blank: false,
        pale_tonal_structure: false,
        crop_enabled: false,
        deskew_accepted: false,
        effective_dewarp: false,
        create_mixed_layers: false,
        timings: &mut PageStageTimings::default(),
    });

    let CleanupRaster::Bilevel(image) = output.image else {
        panic!("B&W stage must emit a binary raster");
    };
    assert_eq!((image.width(), image.height()), (8, 8));
    assert!(image.count_black() > 0);
    assert_eq!(output.emitted_output_mode, OutputMode::Bw);
}

#[test]
fn bilevel_stage_keeps_owned_pixels_through_fold_filtering() {
    let source = GrayImage::new(8, 8, 0);
    let mut trusted = BinaryImage::new(8, 8);
    trusted.set(2, 2, true);
    trusted.set(5, 5, true);
    let split = crate::split::single_page(8, 8);
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 8.0, 8.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        8,
        8,
        Rect::new(0.0, 0.0, 8.0, 8.0),
    );
    let options = CleanupOptions {
        output_mode: OutputMode::Bw,
        source_has_bilevel_layer: true,
        ..CleanupOptions::default()
    };
    let output = process_bilevel_output(BilevelProcessingInput {
        rendered_gray: source.clone(),
        rendered_source_gray: source.clone(),
        canonical_routing_sample: &source,
        options: &options,
        spread_plan: None,
        calibration: PageCalibration::estimate(&source, 300.0, CalibrationConfig::default()),
        rendered_picture_mask: None,
        rendered_text_mask: None,
        rendered_text_vicinity_mask: None,
        rendered_trusted_foreground_mask: Some(&trusted),
        ink_ownership_mask: None,
        normalized_width: 8,
        normalized_height: 8,
        source_page_index: 0,
        half: PageHalf::Full,
        split: &split,
        region: Rect::new(0.0, 0.0, 8.0, 8.0),
        render_plan: &plan,
        source_content_box: None,
        fold_edge_blank_leaf: false,
        unowned_fold_edge_blank_leaf: false,
        effectively_blank: false,
        pale_tonal_structure: false,
        crop_enabled: false,
        deskew_accepted: false,
        effective_dewarp: false,
        create_mixed_layers: false,
        timings: &mut PageStageTimings::default(),
    });

    let CleanupRaster::Bilevel(image) = output.image else {
        panic!("trusted B&W stage must emit a binary raster");
    };
    assert_eq!(image.count_black(), 2);
    assert!(image.get(2, 2));
    assert!(image.get(5, 5));
}

#[test]
fn mixed_stage_preserves_picture_partition_and_builds_layers() {
    let source = GrayImage::new(8, 8, 96);
    let mut picture = BinaryImage::new(8, 8);
    for y in 1..7 {
        for x in 1..7 {
            picture.set(x, y, true);
        }
    }
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        ..CleanupOptions::default()
    };
    let split = crate::split::single_page(8, 8);
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 8.0, 8.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        8,
        8,
        Rect::new(0.0, 0.0, 8.0, 8.0),
    );
    let output = process_mixed_output(MixedProcessingInput {
        rendered_gray: source.clone(),
        rendered_source_gray: source.clone(),
        rendered_color: &None,
        rendered_picture_mask: &Some(picture),
        rendered_chroma_picture_mask: &None,
        rendered_text_vicinity_mask: &None,
        rendered_text_mask: &None,
        rendered_trusted_foreground_mask: &None,
        canonical_routing_sample: &source,
        options: &options,
        spread_plan: None,
        calibration: PageCalibration::estimate(&source, 300.0, CalibrationConfig::default()),
        ink_ownership_mask: &None,
        source_page_index: 0,
        half: PageHalf::Full,
        split: &split,
        region: Rect::new(0.0, 0.0, 8.0, 8.0),
        render_plan: &plan,
        source_content_box: None,
        fold_edge_blank_leaf: false,
        unowned_fold_edge_blank_leaf: false,
        effectively_blank: false,
        pale_tonal_structure: false,
        preserve_confirmed_photo_tones: false,
        use_soft_alpha_foreground: false,
        create_mixed_layers: true,
        create_mixed_composite: true,
        deskew: DeskewResult {
            angle_degrees: 0.0,
            confidence: 1.0,
            accepted: false,
        },
        effective_dewarp: false,
        timings: &mut PageStageTimings::default(),
    });

    let CleanupRaster::Gray(image) = output.image else {
        panic!("Mixed stage must emit its gray composite");
    };
    assert_eq!((image.width(), image.height()), (8, 8));
    let layers = output
        .mixed_layers
        .expect("Mixed stage should build layers");
    assert_eq!(
        (layers.background.width(), layers.background.height()),
        (8, 8)
    );
    assert!(layers.background.get(3, 3) < 255);
    assert!(layers.color_background.is_none());
}

#[test]
fn mixed_stage_accepts_absent_picture_mask_as_picture_free_output() {
    let source = GrayImage::new(8, 8, 96);
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        ..CleanupOptions::default()
    };
    let split = crate::split::single_page(8, 8);
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 8.0, 8.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        8,
        8,
        Rect::new(0.0, 0.0, 8.0, 8.0),
    );
    let output = process_mixed_output(MixedProcessingInput {
        rendered_gray: source.clone(),
        rendered_source_gray: source.clone(),
        rendered_color: &None,
        rendered_picture_mask: &None,
        rendered_chroma_picture_mask: &None,
        rendered_text_vicinity_mask: &None,
        rendered_text_mask: &None,
        rendered_trusted_foreground_mask: &None,
        canonical_routing_sample: &source,
        options: &options,
        spread_plan: None,
        calibration: PageCalibration::estimate(&source, 300.0, CalibrationConfig::default()),
        ink_ownership_mask: &None,
        source_page_index: 0,
        half: PageHalf::Full,
        split: &split,
        region: Rect::new(0.0, 0.0, 8.0, 8.0),
        render_plan: &plan,
        source_content_box: None,
        fold_edge_blank_leaf: false,
        unowned_fold_edge_blank_leaf: false,
        effectively_blank: false,
        pale_tonal_structure: false,
        preserve_confirmed_photo_tones: false,
        use_soft_alpha_foreground: false,
        create_mixed_layers: false,
        create_mixed_composite: false,
        deskew: DeskewResult {
            angle_degrees: 0.0,
            confidence: 1.0,
            accepted: false,
        },
        effective_dewarp: false,
        timings: &mut PageStageTimings::default(),
    });

    assert!(output.mixed_layers.is_none());
    assert_eq!(output.color_image, None);
    assert_eq!(output.emitted_output_mode, OutputMode::Grayscale);
    assert_eq!((output.image.width(), output.image.height()), (8, 8));
}

#[test]
fn mixed_stage_exposes_soft_alpha_for_picture_owned_foreground() {
    let source = GrayImage::new(8, 8, 96);
    let mut picture = BinaryImage::new(8, 8);
    for y in 1..7 {
        for x in 1..7 {
            picture.set(x, y, true);
        }
    }
    let options = CleanupOptions {
        output_mode: OutputMode::Mixed,
        ..CleanupOptions::default()
    };
    let split = crate::split::single_page(8, 8);
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 8.0, 8.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        8,
        8,
        Rect::new(0.0, 0.0, 8.0, 8.0),
    );
    let output = process_mixed_output(MixedProcessingInput {
        rendered_gray: source.clone(),
        rendered_source_gray: source.clone(),
        rendered_color: &None,
        rendered_picture_mask: &Some(picture),
        rendered_chroma_picture_mask: &None,
        rendered_text_vicinity_mask: &None,
        rendered_text_mask: &None,
        rendered_trusted_foreground_mask: &None,
        canonical_routing_sample: &source,
        options: &options,
        spread_plan: None,
        calibration: PageCalibration::estimate(&source, 300.0, CalibrationConfig::default()),
        ink_ownership_mask: &None,
        source_page_index: 0,
        half: PageHalf::Full,
        split: &split,
        region: Rect::new(0.0, 0.0, 8.0, 8.0),
        render_plan: &plan,
        source_content_box: None,
        fold_edge_blank_leaf: false,
        unowned_fold_edge_blank_leaf: false,
        effectively_blank: false,
        pale_tonal_structure: false,
        preserve_confirmed_photo_tones: true,
        use_soft_alpha_foreground: true,
        create_mixed_layers: true,
        create_mixed_composite: true,
        deskew: DeskewResult {
            angle_degrees: 0.0,
            confidence: 1.0,
            accepted: false,
        },
        effective_dewarp: false,
        timings: &mut PageStageTimings::default(),
    });

    let layers = output
        .mixed_layers
        .expect("soft-alpha Mixed output needs layers");
    assert!(layers.foreground_alpha.is_some());
    assert_eq!(
        (layers.background.width(), layers.background.height()),
        (8, 8)
    );
}

#[test]
fn continuous_stage_keeps_grayscale_pixels_and_omits_color() {
    let mut gray = GrayImage::new(5, 4, 255);
    gray.set(2, 1, 37);
    let output = process_continuous_output(ContinuousOutputInput {
        output_mode: OutputMode::Grayscale,
        rendered_gray: gray,
        rendered_color: None,
        rendered_width: 5,
        rendered_height: 4,
        create_mixed_layers: true,
    });

    let CleanupRaster::Gray(image) = output.image else {
        panic!("grayscale stage must emit a gray raster");
    };
    assert_eq!((image.width(), image.height()), (5, 4));
    assert_eq!(image.get(2, 1), 37);
    assert!(output.color_image.is_none());
    assert!(output.mixed_layers.is_none());
}

#[test]
fn continuous_stage_keeps_color_pixels_and_can_build_color_layers() {
    let gray = GrayImage::new(5, 4, 180);
    let mut color = RgbImage::new(5, 4, [255; 3]);
    color.set(2, 1, [18, 96, 210]);
    let output = process_continuous_output(ContinuousOutputInput {
        output_mode: OutputMode::Color,
        rendered_gray: gray,
        rendered_color: Some(color.clone()),
        rendered_width: 5,
        rendered_height: 4,
        create_mixed_layers: true,
    });

    let CleanupRaster::Gray(image) = output.image else {
        panic!("color stage must retain the gray geometry plane");
    };
    assert_eq!((image.width(), image.height()), (5, 4));
    assert_eq!(
        output.color_image.as_ref().unwrap().get(2, 1),
        [18, 96, 210]
    );
    let layers = output
        .mixed_layers
        .expect("color layers should be available");
    assert_eq!(layers.color_background.as_ref().unwrap(), &color);
    assert_eq!(
        (layers.background.width(), layers.background.height()),
        (5, 4)
    );
}

#[test]
fn payload_crop_keeps_all_planes_on_one_aligned_rectangle() {
    let mut image = GrayImage::new(4, 4, 0);
    image.set(1, 1, 11);
    let mut picture_mask = BinaryImage::new(4, 4);
    picture_mask.set(1, 1, true);
    let mut tone_alpha = GrayImage::new(4, 4, 0);
    tone_alpha.set(1, 1, 22);
    let mut foreground_mask = BinaryImage::new(4, 4);
    foreground_mask.set(1, 1, true);
    let mut foreground_alpha = GrayImage::new(4, 4, 0);
    foreground_alpha.set(1, 1, 33);
    let layers = MixedLayers {
        foreground_mask,
        foreground_alpha: Some(foreground_alpha),
        background: GrayImage::new(4, 4, 44),
        color_background: None,
        source_mrc: false,
    };
    let output = apply_payload_crop(PayloadCropInput {
        image: CleanupRaster::Gray(image),
        color_image: None,
        picture_mask: Some(picture_mask),
        tone_alpha: Some(tone_alpha),
        mixed_layers: Some(layers),
        render_region: Some(Rect::new(1.0, 1.0, 2.0, 2.0)),
        sampled_region: Some(Rect::new(0.0, 0.0, 4.0, 4.0)),
    });

    let CleanupRaster::Gray(image) = output.image else {
        panic!("payload crop must retain the gray plane");
    };
    assert_eq!((image.width(), image.height()), (2, 2));
    assert_eq!(image.get(0, 0), 11);
    assert!(output.picture_mask.unwrap().get(0, 0));
    assert_eq!(output.tone_alpha.unwrap().get(0, 0), 22);
    let layers = output.mixed_layers.unwrap();
    assert!(layers.foreground_mask.get(0, 0));
    assert_eq!(layers.foreground_alpha.unwrap().get(0, 0), 33);
    assert_eq!(
        (layers.background.width(), layers.background.height()),
        (2, 2)
    );
}
