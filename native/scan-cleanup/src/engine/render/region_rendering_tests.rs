use super::*;

#[test]
fn cropping_confirmed_photo_at_unit_scale_preserves_full_render_pixels() {
    let mut source = GrayImage::new(20, 20, 0);
    for y in 0..20 {
        for x in 0..20 {
            source.set(x, y, if (x + y) % 2 == 0 { 48 } else { 208 });
        }
    }
    let options = CleanupOptions {
        output_mode: OutputMode::Grayscale,
        ..CleanupOptions::default()
    };
    let region = Rect::new(0.0, 0.0, 20.0, 20.0);
    let render = |crop: Rect| {
        let plan = ComposedRenderPlan::new(
            region,
            Affine::scaling(1.0, 1.0),
            Affine::scaling(1.0, 1.0),
            None,
            20,
            20,
            crop,
        );
        prepare_render_planes(RasterPlaneInput {
            normalized: &source,
            routing_source: &source,
            color_source: None,
            tone_preservation_alpha: None,
            text_tone_diagnostics: None,
            options: &options,
            working_width: 20,
            working_height: 20,
            render_region: Some(crop),
            sampled_region: Some(crop),
            output_rect: region,
            render_plan: &plan,
            rendered_width: crop.width as usize,
            rendered_height: crop.height as usize,
            region,
            local_deskew_forward: Affine::scaling(1.0, 1.0),
            local_deskew_inverse: Affine::scaling(1.0, 1.0),
            dewarp_model: None,
            timings: &mut PageStageTimings::default(),
        })
        .unwrap()
        .rendered_gray
    };
    let full = render(region);
    assert_eq!(full.data(), source.data());
    let cropped = render(Rect::new(5.0, 5.0, 10.0, 10.0));
    for y in 0..10 {
        for x in 0..10 {
            assert_eq!(
                cropped.get(x, y),
                full.get(x + 5, y + 5),
                "a unit-scale photo crop must preserve the full render at ({x}, {y})"
            );
        }
    }
}

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
        faint_stroke_masks: [None, None],
        faint_core: None,
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
        resolved_output_mode: options.output_mode.into(),
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
        render_policy: PageRenderPolicy::COMPLETE,
        timings: &mut PageStageTimings::default(),
    })
    .expect("blank synthetic region should render");
    assert_eq!(result.metadata.output_width, source.width());
    assert_eq!(result.metadata.output_height, source.height());
    assert!(result.effectively_blank);
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
        faint_stroke_masks: [None, None],
        faint_core: None,
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
        resolved_output_mode: options.output_mode.into(),
        source_page_index: 0,
        split: &split,
        spread_plan: None,
        region: Rect::new(0.0, 0.0, source.width() as f64, source.height() as f64),
        half: PageHalf::Full,
        cache: None,
        split_cache_key: None,
        create_mixed_layers: true,
        create_mixed_composite: true,
        render_policy: PageRenderPolicy::COMPLETE,
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
fn raster_stage_preserves_grayscale_source_pixels_on_identity_plan() {
    let source = GrayImage::from_vec(4, 3, 4, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
        .expect("synthetic grayscale raster dimensions must be valid");
    let plan = ComposedRenderPlan::new(
        Rect::new(0.0, 0.0, 4.0, 3.0),
        Affine::scaling(1.0, 1.0),
        Affine::scaling(1.0, 1.0),
        None,
        4,
        3,
        Rect::new(0.0, 0.0, 4.0, 3.0),
    );
    let planes = |output_mode| {
        prepare_render_planes(RasterPlaneInput {
            normalized: &source,
            routing_source: &source,
            color_source: None,
            tone_preservation_alpha: None,
            text_tone_diagnostics: None,
            options: &CleanupOptions {
                output_mode,
                ..CleanupOptions::default()
            },
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
        .expect("identity raster plan should be valid")
    };
    let output = planes(OutputMode::Bw);

    assert_eq!(output.rendered_gray.data(), source.data());
    assert_eq!(
        output.rendered_source_gray.as_ref().map(GrayImage::data),
        Some(source.data())
    );
    assert!(output.rendered_color.is_none());
    assert!(output.rendered_tone_alpha.is_none());
    // Continuous output publishes the cleaned tonal plane alone.
    let grayscale = planes(OutputMode::Grayscale);
    assert_eq!(grayscale.rendered_gray.data(), source.data());
    assert!(grayscale.rendered_source_gray.is_none());
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
        tone_preservation_alpha: Some(&alpha),
        text_tone_diagnostics: None,
        options: &options,
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
    assert_eq!(
        rendered_alpha.data(),
        alpha.data(),
        "an identity render must preserve tone-protection alpha bytes"
    );
    assert_eq!(output.rendered_gray, GrayImage::new(3, 2, 255));
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
