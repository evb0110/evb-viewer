use super::*;
use crate::auto_dewarp::AutoDewarpResult;
use crate::content::ContentResult;
use crate::DewarpOptions;

struct RegionAssemblyInput<'a> {
    image: CleanupRaster,
    color_image: Option<RgbImage>,
    picture_mask: Option<BinaryImage>,
    tone_alpha: Option<GrayImage>,
    mixed_layers: Option<MixedLayers>,
    effectively_blank: bool,
    timings: &'a mut PageStageTimings,
    output_processing_started: Instant,
    render_started: Instant,
    deskew: DeskewResult,
    effective_dewarp: Option<DewarpOptions>,
    automatic_dewarp: Option<AutoDewarpResult>,
    conservation_warnings: Vec<String>,
    options: &'a CleanupOptions,
    crop_enabled: bool,
    content: ContentResult,
    content_diagnostics: Option<ContentDiagnostics>,
    source_page_index: usize,
    half: PageHalf,
    split: &'a SplitResult,
    region: Rect,
    source_content_box: Option<Rect>,
    output_rect: Rect,
    render_region: Option<Rect>,
    text_tone_diagnostics: Option<TextToneDiagnostics>,
    binarization_mode: Option<crate::BinarizationMode>,
    binarization_diagnostics: Option<BinarizationDiagnostics>,
    ink_consistency_diagnostics: Option<InkConsistencyDiagnostics>,
    despeckle_fallback: bool,
    forward_transform: Option<Affine>,
    inverse_transform: Option<Affine>,
    dewarp_mapping: Option<DewarpMappingGrid>,
    output_width: usize,
    output_height: usize,
    source: &'a GrayImage,
    emitted_output_mode: OutputMode,
    trusted_mrc_background_preserved: bool,
    trusted_selection_applied: bool,
}

fn assemble_region_result(
    input: RegionAssemblyInput<'_>,
) -> Result<RegionSemanticOutput, super::AnalysisError> {
    let RegionAssemblyInput {
        image,
        color_image,
        picture_mask,
        tone_alpha,
        mixed_layers,
        effectively_blank,
        timings,
        output_processing_started,
        render_started,
        deskew,
        effective_dewarp,
        automatic_dewarp,
        mut conservation_warnings,
        options,
        crop_enabled,
        content,
        content_diagnostics,
        source_page_index,
        half,
        split,
        region,
        source_content_box,
        output_rect,
        render_region,
        text_tone_diagnostics,
        binarization_mode,
        binarization_diagnostics,
        ink_consistency_diagnostics,
        despeckle_fallback,
        forward_transform,
        inverse_transform,
        dewarp_mapping,
        output_width,
        output_height,
        source,
        emitted_output_mode,
        trusted_mrc_background_preserved,
        trusted_selection_applied,
    } = input;
    timings.output_processing_ms += output_processing_started.elapsed().as_secs_f64() * 1_000.0;
    timings.render_ms += render_started.elapsed().as_secs_f64() * 1_000.0;
    let mut warnings = if deskew.accepted || effective_dewarp.is_some() {
        Vec::new()
    } else {
        vec![format!(
            "Deskew confidence {:.3} was below the 2.0 acceptance threshold",
            deskew.confidence
        )]
    };
    warnings.append(&mut conservation_warnings);
    if options.crop_content && !crop_enabled && content.content.is_none() {
        warnings.push("Content crop was skipped because no content box was detected".into());
    }
    if let Some(auto) = &automatic_dewarp {
        if auto.model.is_none() && auto.confidence < 0.6 {
            warnings.push(format!(
                "Experimental automatic dewarp confidence {:.3} was below 0.6; no dewarp was applied",
                auto.confidence
            ));
        }
    }
    let source_dpi = options.source_dpi();
    let requested_render_dpi = options.requested_render_dpi();
    let raster_scale_limited = options.dpi + f64::EPSILON < requested_render_dpi;
    let mut warning_events = Vec::new();
    if raster_scale_limited {
        warning_events.push(CleanupWarningEvent::RenderDpiLimited {
            applied_dpi_thousandths: quantize_decimal(options.dpi, 3),
            requested_dpi_thousandths: quantize_decimal(requested_render_dpi, 3),
        });
    }
    Ok(RegionSemanticOutput {
        image,
        color_image,
        picture_mask,
        tone_preservation_alpha: tone_alpha,
        mixed_layers,
        effectively_blank,
        metadata: CleanupMetadata {
            source_page_index,
            half,
            detected_skew_degrees: deskew.angle_degrees,
            skew_confidence: deskew.confidence,
            skew_applied: deskew.accepted,
            manual_skew: options.manual_skew_degrees.is_some(),
            layout_classification: split.classification,
            layout_confidence: split.confidence,
            cutter_x: split.cutter_x,
            split_geometry: split.pages.clone(),
            split_seam: split.split_seam.as_ref().map(|seam| {
                crate::protocol::manifest_v3::SplitSeamPolyline {
                    points: seam.points.clone(),
                }
            }),
            source_region: region,
            content_box: source_content_box,
            crop_rect: output_rect,
            content_diagnostics,
            applied_margins: if crop_enabled {
                content.margins
            } else {
                [0.0; 4]
            }
            .into(),
            soft_margins_pixels: [0; 4],
            uniform_canvas: false,
            canvas_policy: MatchedCanvasPolicy::Intrinsic,
            canvas_overflow: false,
            matched_canvas_target_width: None,
            matched_canvas_target_height: None,
            matched_canvas_target_width_points: None,
            matched_canvas_target_height_points: None,
            matched_canvas_content_width: None,
            matched_canvas_content_height: None,
            matched_canvas_optical_placement: false,
            matched_canvas_optical_content_left: None,
            matched_canvas_optical_content_right: None,
            matched_canvas_intrinsic_overflow_left: 0,
            matched_canvas_intrinsic_overflow_right: 0,
            matched_canvas_intrinsic_overflow_top: 0,
            fold_clip_left: 0,
            fold_clip_right: 0,
            pdf_image_placement: None,
            output_mode: emitted_output_mode,
            bilevel_written: false,
            layered_written: false,
            layered_foreground_kind: None,
            layered_background_dpi: None,
            layered_foreground_dpi: None,
            trusted_mrc_background_preserved,
            trusted_selection_applied,
            illumination_normalized: options.normalize_illumination,
            text_tone_diagnostics,
            binarization_mode,
            binarization_diagnostics,
            ink_consistency_diagnostics,
            despeckle_fallback,
            forward_transform,
            inverse_transform,
            dewarp_model: effective_dewarp,
            dewarp_mapping,
            dewarp_confidence: automatic_dewarp.as_ref().map(|result| result.confidence),
            input_width: source.width(),
            input_height: source.height(),
            output_width,
            output_height,
            intrinsic_raster_width: Some(output_width),
            intrinsic_raster_height: Some(output_height),
            render_region,
            canvas_width: output_width,
            canvas_height: output_height,
            placement_offset_x: 0,
            placement_offset_y: 0,
            rotation: options.rotation,
            canvas_scope: crate::protocol::manifest_v3::CanvasScope::Page,
            resample_passes: 1,
            source_dpi,
            render_dpi: options.dpi,
            requested_render_dpi,
            raster_scale_limited,
            warnings,
            warning_events,
        },
    })
}

struct OutputProcessingInput<'a> {
    rendered_gray: GrayImage,
    rendered_source_gray: GrayImage,
    rendered_color: Option<RgbImage>,
    rendered_picture_mask: Option<BinaryImage>,
    rendered_chroma_picture_mask: Option<BinaryImage>,
    rendered_text_vicinity_mask: Option<BinaryImage>,
    rendered_text_mask: Option<BinaryImage>,
    rendered_trusted_foreground_mask: Option<BinaryImage>,
    rendered_tone_alpha: Option<GrayImage>,
    canonical_routing_sample: &'a GrayImage,
    options: &'a CleanupOptions,
    spread_plan: Option<&'a SpreadBinarizationPlan>,
    calibration: PageCalibration,
    source_page_index: usize,
    half: PageHalf,
    split: &'a SplitResult,
    region: Rect,
    render_plan: &'a ComposedRenderPlan,
    source_content_box: Option<Rect>,
    crop_enabled: bool,
    deskew: DeskewResult,
    effective_dewarp: Option<DewarpOptions>,
    automatic_dewarp: Option<AutoDewarpResult>,
    content: ContentResult,
    content_diagnostics: Option<ContentDiagnostics>,
    output_rect: Rect,
    render_region: Option<Rect>,
    sampled_region: Option<Rect>,
    text_tone_diagnostics: Option<TextToneDiagnostics>,
    forward_transform: Option<Affine>,
    inverse_transform: Option<Affine>,
    dewarp_mapping: Option<DewarpMappingGrid>,
    output_width: usize,
    output_height: usize,
    source: &'a GrayImage,
    render_started: Instant,
    timings: &'a mut PageStageTimings,
    create_mixed_layers: bool,
    create_mixed_composite: bool,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    canonical_leaf_source: &'a GrayImage,
    canonical_routing_dpi: f64,
    content_present: bool,
    force_clean_blank: bool,
    normalized_width: usize,
    normalized_height: usize,
}

fn process_region_output(
    input: OutputProcessingInput<'_>,
) -> Result<RegionSemanticOutput, super::AnalysisError> {
    let OutputProcessingInput {
        rendered_gray,
        rendered_source_gray,
        rendered_color,
        mut rendered_picture_mask,
        rendered_chroma_picture_mask,
        rendered_text_vicinity_mask,
        rendered_text_mask,
        rendered_trusted_foreground_mask,
        mut rendered_tone_alpha,
        canonical_routing_sample,
        options,
        spread_plan,
        calibration,
        source_page_index,
        half,
        split,
        region,
        render_plan,
        source_content_box,
        crop_enabled,
        deskew,
        effective_dewarp,
        automatic_dewarp,
        content,
        content_diagnostics,
        output_rect,
        render_region,
        sampled_region,
        text_tone_diagnostics,
        forward_transform,
        inverse_transform,
        dewarp_mapping,
        output_width,
        output_height,
        source,
        render_started,
        timings,
        create_mixed_layers,
        create_mixed_composite,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        canonical_leaf_source,
        canonical_routing_dpi,
        content_present,
        force_clean_blank,
        normalized_width,
        normalized_height,
    } = input;
    let output_processing_started = Instant::now();
    let BlanknessPolicyOutput {
        rendered_picture_mask: policy_picture_mask,
        rendered_text_mask: policy_text_mask,
        rendered_trusted_foreground_mask: policy_trusted_foreground_mask,
        ink_ownership_mask,
        pale_tonal_structure,
        effectively_blank,
        fail_closed_blank,
        fold_edge_blank_leaf,
        unowned_fold_edge_blank_leaf,
        trusted_selection_applied,
        trusted_mrc_background_preserved,
    } = resolve_blankness_policy(BlanknessPolicyInput {
        canonical_leaf_source,
        canonical_routing_dpi,
        force_clean_blank,
        content_present,
        rendered_picture_mask,
        rendered_text_mask,
        rendered_trusted_foreground_mask,
        preserve_confirmed_photo_tones,
        half,
    });
    rendered_picture_mask = policy_picture_mask;
    let rendered_text_mask = policy_text_mask;
    let rendered_trusted_foreground_mask = policy_trusted_foreground_mask;
    let mut ink_consistency_diagnostics = None;
    let mut conservation_warnings = Vec::new();
    let mut emitted_output_mode = options.output_mode;
    let (
        mut image,
        mut color_image,
        binarization_mode,
        binarization_diagnostics,
        despeckle_fallback,
        mut mixed_layers,
    ) = if fail_closed_blank {
        (
            if matches!(options.output_mode, OutputMode::Bw | OutputMode::Mixed) {
                CleanupRaster::Bilevel(BinaryImage::new(output_width, output_height))
            } else {
                CleanupRaster::Gray(GrayImage::new(output_width, output_height, 255))
            },
            if options.output_mode == OutputMode::Color && rendered_color.is_some() {
                Some(RgbImage::new(output_width, output_height, [255; 3]))
            } else {
                None
            },
            None,
            None,
            false,
            None,
        )
    } else {
        match options.output_mode {
            OutputMode::Bw => {
                let BilevelProcessingOutput {
                    image,
                    binarization_mode,
                    binarization_diagnostics,
                    despeckle_fallback,
                    mixed_layers,
                    emitted_output_mode: branch_output_mode,
                    ink_consistency_diagnostics: branch_ink_diagnostics,
                    conservation_warnings: branch_warnings,
                } = process_bilevel_output(BilevelProcessingInput {
                    rendered_gray,
                    rendered_source_gray,
                    canonical_routing_sample,
                    options,
                    spread_plan,
                    calibration,
                    rendered_picture_mask: rendered_picture_mask.as_ref(),
                    rendered_text_mask: rendered_text_mask.as_ref(),
                    rendered_text_vicinity_mask: rendered_text_vicinity_mask.as_ref(),
                    rendered_trusted_foreground_mask: rendered_trusted_foreground_mask.as_ref(),
                    ink_ownership_mask: ink_ownership_mask.as_ref(),
                    normalized_width,
                    normalized_height,
                    source_page_index,
                    half,
                    split,
                    region,
                    render_plan,
                    source_content_box,
                    fold_edge_blank_leaf,
                    unowned_fold_edge_blank_leaf,
                    effectively_blank,
                    pale_tonal_structure,
                    crop_enabled,
                    deskew_accepted: deskew.accepted,
                    effective_dewarp: effective_dewarp.is_some(),
                    create_mixed_layers,
                    timings,
                });
                ink_consistency_diagnostics = branch_ink_diagnostics;
                conservation_warnings = branch_warnings;
                emitted_output_mode = branch_output_mode;
                (
                    image,
                    None,
                    binarization_mode,
                    binarization_diagnostics,
                    despeckle_fallback,
                    mixed_layers,
                )
            }
            OutputMode::Mixed => {
                let MixedProcessingOutput {
                    image,
                    color_image,
                    binarization_mode,
                    binarization_diagnostics,
                    despeckle_fallback,
                    mixed_layers,
                    emitted_output_mode: branch_output_mode,
                    conservation_warnings: branch_warnings,
                } = process_mixed_output(MixedProcessingInput {
                    rendered_gray,
                    rendered_source_gray,
                    rendered_color: &rendered_color,
                    rendered_picture_mask: &rendered_picture_mask,
                    rendered_chroma_picture_mask: &rendered_chroma_picture_mask,
                    rendered_text_vicinity_mask: &rendered_text_vicinity_mask,
                    rendered_text_mask: &rendered_text_mask,
                    rendered_trusted_foreground_mask: &rendered_trusted_foreground_mask,
                    canonical_routing_sample,
                    options,
                    spread_plan,
                    calibration,
                    ink_ownership_mask: &ink_ownership_mask,
                    source_page_index,
                    half,
                    split,
                    region,
                    render_plan,
                    source_content_box,
                    fold_edge_blank_leaf,
                    unowned_fold_edge_blank_leaf,
                    effectively_blank,
                    pale_tonal_structure,
                    preserve_confirmed_photo_tones,
                    use_soft_alpha_foreground,
                    create_mixed_layers,
                    create_mixed_composite,
                    deskew,
                    effective_dewarp: effective_dewarp.is_some(),
                    timings,
                });
                emitted_output_mode = branch_output_mode;
                conservation_warnings = branch_warnings;
                (
                    image,
                    color_image,
                    binarization_mode,
                    binarization_diagnostics,
                    despeckle_fallback,
                    mixed_layers,
                )
            }
            OutputMode::Grayscale | OutputMode::Color => {
                let ContinuousOutputOutput {
                    image,
                    color_image,
                    mixed_layers,
                } = process_continuous_output(ContinuousOutputInput {
                    output_mode: options.output_mode,
                    rendered_gray,
                    rendered_color,
                    rendered_width: output_width,
                    rendered_height: output_height,
                    create_mixed_layers,
                });
                (image, color_image, None, None, false, mixed_layers)
            }
            OutputMode::Auto => unreachable!("automatic output mode is resolved before render"),
        }
    };
    let PayloadCropOutput {
        image: cropped_image,
        color_image: cropped_color_image,
        picture_mask: cropped_picture_mask,
        tone_alpha: cropped_tone_alpha,
        mixed_layers: cropped_mixed_layers,
    } = apply_payload_crop(PayloadCropInput {
        image,
        color_image,
        picture_mask: rendered_picture_mask,
        tone_alpha: rendered_tone_alpha,
        mixed_layers,
        render_region,
        sampled_region,
    });
    image = cropped_image;
    color_image = cropped_color_image;
    rendered_picture_mask = cropped_picture_mask;
    rendered_tone_alpha = cropped_tone_alpha;
    mixed_layers = cropped_mixed_layers;
    assemble_region_result(RegionAssemblyInput {
        image,
        color_image,
        picture_mask: rendered_picture_mask,
        tone_alpha: rendered_tone_alpha,
        mixed_layers,
        effectively_blank,
        timings,
        output_processing_started,
        render_started,
        deskew,
        effective_dewarp,
        automatic_dewarp,
        conservation_warnings,
        options,
        crop_enabled,
        content,
        content_diagnostics,
        source_page_index,
        half,
        split,
        region,
        source_content_box,
        output_rect,
        render_region,
        text_tone_diagnostics,
        binarization_mode,
        binarization_diagnostics,
        ink_consistency_diagnostics,
        despeckle_fallback,
        forward_transform,
        inverse_transform,
        dewarp_mapping,
        output_width,
        output_height,
        source,
        emitted_output_mode,
        trusted_mrc_background_preserved,
        trusted_selection_applied,
    })
}

pub(crate) struct TransformPreparationInput<'a> {
    pub analysis_working: GrayImage,
    pub analysis_picture_working: Option<BinaryImage>,
    pub manual_picture_crop_authority: Option<BinaryImage>,
    pub options: &'a CleanupOptions,
    pub half: PageHalf,
    pub region: Rect,
    pub working_width: usize,
    pub working_height: usize,
    pub local_scale_x: f64,
    pub local_scale_y: f64,
    pub calibration: PageCalibration,
    pub cache: Option<&'a PageCache>,
    pub split_cache_key: Option<&'a StageCacheKey>,
    pub timings: &'a mut PageStageTimings,
}

pub(crate) struct TransformPreparationOutput {
    pub deskew_key: Option<StageCacheKey>,
    pub deskew: DeskewResult,
    pub local_deskew_forward: Affine,
    pub local_deskew_inverse: Affine,
    pub automatic_dewarp: Option<AutoDewarpResult>,
    pub deskewed_analysis: GrayImage,
    pub deskewed_picture_mask: Option<BinaryImage>,
    pub deskewed_manual_picture_crop_authority: Option<BinaryImage>,
    pub dewarp_model: Option<DewarpModel>,
    pub effective_dewarp: Option<DewarpOptions>,
    pub dewarped_analysis: Option<GrayImage>,
    pub dewarped_picture_mask: Option<BinaryImage>,
    pub dewarped_manual_picture_crop_authority: Option<BinaryImage>,
}

fn prepare_region_transforms(
    input: TransformPreparationInput<'_>,
) -> Result<TransformPreparationOutput, super::AnalysisError> {
    let TransformPreparationInput {
        analysis_working,
        analysis_picture_working,
        manual_picture_crop_authority,
        options,
        half,
        region,
        working_width,
        working_height,
        local_scale_x,
        local_scale_y,
        calibration,
        cache,
        split_cache_key,
        timings,
    } = input;
    let deskew_key = cache
        .zip(split_cache_key)
        .map(|(cache, split_key)| StageCacheKey::deskew(&cache.source, options, split_key, region));
    let deskew_started = Instant::now();
    let deskew = if let Some(angle_degrees) = options
        .manual_skew_degrees
        .or_else(|| options.automatic_skew_for(half))
    {
        DeskewResult {
            angle_degrees,
            confidence: 1.0,
            accepted: true,
        }
    } else {
        cache
            .zip(deskew_key.as_ref())
            .and_then(|(cache, key)| cache.shared.lock().ok()?.get::<DeskewResult>(key))
            .map_or_else(
                || {
                    let result = detect_skew(&analysis_working, calibration.effective_dpi);
                    if let (Some(cache), Some(key)) = (cache, deskew_key.clone()) {
                        if let Ok(mut shared) = cache.shared.lock() {
                            shared.insert(
                                key,
                                Arc::new(result),
                                std::mem::size_of::<DeskewResult>(),
                            );
                        }
                    }
                    result
                },
                |cached| *cached,
            )
    };
    timings.deskew_ms += deskew_started.elapsed().as_secs_f64() * 1_000.0;
    let local_deskew_forward = deskew_transform(working_width, working_height, deskew);
    let local_deskew_inverse = local_deskew_forward
        .inverse()
        .ok_or("Deskew transform is not invertible")?;
    let analysis_deskew_forward =
        deskew_transform(analysis_working.width(), analysis_working.height(), deskew);
    let analysis_deskew_inverse = analysis_deskew_forward
        .inverse()
        .ok_or("Cleanup analysis deskew transform is not invertible")?;
    let automatic_dewarp = if options.dewarp.is_none() && options.experimental.auto_dewarp {
        // Curve detection is designed for the ~200-DPI working scale; handing
        // it the full-resolution crop together with the capped analysis DPI
        // made its internal downscale a no-op and ran thresholding, labeling
        // and snake tracing on the full raster. Detect on the analysis-scale
        // crop and map the curves back into region coordinates.
        let mut detected = detect_curves_at_dpi_with_depth(
            &analysis_working,
            calibration.effective_dpi,
            options.experimental.auto_dewarp_depth,
        );
        detected.model = detected.model.map(|model| {
            transform_dewarp_options(
                &model,
                Affine::scaling(
                    1.0 / local_scale_x.max(f64::EPSILON),
                    1.0 / local_scale_y.max(f64::EPSILON),
                )
                .then(Affine::translation(region.x, region.y)),
            )
        });
        Some(detected)
    } else {
        None
    };
    let deskewed_analysis = if deskew.accepted {
        render_affine_gray(
            &analysis_working,
            analysis_working.width(),
            analysis_working.height(),
            analysis_deskew_inverse,
        )
    } else {
        analysis_working
    };
    let deskewed_picture_mask = analysis_picture_working.map(|mask| {
        if deskew.accepted {
            render_binary_mask(&mask, mask.width(), mask.height(), |point| {
                Some(analysis_deskew_inverse.apply(point))
            })
        } else {
            mask
        }
    });
    let deskewed_manual_picture_crop_authority = manual_picture_crop_authority.map(|mask| {
        if deskew.accepted {
            render_binary_mask(&mask, mask.width(), mask.height(), |point| {
                Some(analysis_deskew_inverse.apply(point))
            })
        } else {
            mask
        }
    });
    let source_rotated_to_deskewed =
        Affine::translation(-region.x, -region.y).then(local_deskew_forward);
    let candidate_dewarp = options.dewarp.clone().or_else(|| {
        automatic_dewarp
            .as_ref()
            .and_then(|result| result.model.clone())
    });
    let transformed_dewarp = candidate_dewarp
        .as_ref()
        .map(|model| transform_dewarp_options(model, source_rotated_to_deskewed));
    let dewarp_model = if options.dewarp.is_some() {
        transformed_dewarp
            .as_ref()
            .map(DewarpModel::from_options)
            .transpose()
            .map_err(|error| error.to_string())?
    } else {
        transformed_dewarp
            .as_ref()
            .and_then(|model| DewarpModel::from_options(model).ok())
    };
    let effective_dewarp = dewarp_model.as_ref().and(candidate_dewarp);
    let dewarped_analysis = dewarp_model.as_ref().map(|model| {
        let width = deskewed_analysis.width();
        let height = deskewed_analysis.height();
        rasterize_inverse_area_with(&deskewed_analysis, width, height, |point| {
            model
                .map_unit_to_source(point.x / width as f64, point.y / height as f64)
                .map(|mapped| Point::new(mapped.x * local_scale_x, mapped.y * local_scale_y))
        })
    });
    let dewarped_picture_mask = dewarp_model.as_ref().and_then(|model| {
        deskewed_picture_mask.as_ref().map(|mask| {
            let width = mask.width();
            let height = mask.height();
            render_binary_mask(mask, width, height, |point| {
                model
                    .map_unit_to_source(point.x / width as f64, point.y / height as f64)
                    .map(|mapped| Point::new(mapped.x * local_scale_x, mapped.y * local_scale_y))
            })
        })
    });
    let dewarped_manual_picture_crop_authority = dewarp_model.as_ref().and_then(|model| {
        deskewed_manual_picture_crop_authority.as_ref().map(|mask| {
            let width = mask.width();
            let height = mask.height();
            render_binary_mask(mask, width, height, |point| {
                model
                    .map_unit_to_source(point.x / width as f64, point.y / height as f64)
                    .map(|mapped| Point::new(mapped.x * local_scale_x, mapped.y * local_scale_y))
            })
        })
    });

    Ok(TransformPreparationOutput {
        deskew_key,
        deskew,
        local_deskew_forward,
        local_deskew_inverse,
        automatic_dewarp,
        deskewed_analysis,
        deskewed_picture_mask,
        deskewed_manual_picture_crop_authority,
        dewarp_model,
        effective_dewarp,
        dewarped_analysis,
        dewarped_picture_mask,
        dewarped_manual_picture_crop_authority,
    })
}

struct ContentDetectionInput<'a> {
    content_analysis: &'a GrayImage,
    content_picture_mask: Option<&'a BinaryImage>,
    manual_picture_crop_authority: Option<&'a BinaryImage>,
    normalized: &'a GrayImage,
    options: &'a CleanupOptions,
    source_effectively_blank: bool,
    cache: Option<&'a PageCache>,
    deskew_key: Option<&'a StageCacheKey>,
    source_page_index: usize,
    calibration: PageCalibration,
    local_scale_x: f64,
    local_scale_y: f64,
    working_width: usize,
    working_height: usize,
    routing_source: &'a GrayImage,
    region: Rect,
    local_deskew_forward: Affine,
    local_deskew_inverse: Affine,
    dewarp_model: Option<&'a DewarpModel>,
    half: PageHalf,
    timings: &'a mut PageStageTimings,
}

fn detect_region_content(
    input: ContentDetectionInput<'_>,
) -> Result<CachedContentDetection, super::AnalysisError> {
    let ContentDetectionInput {
        content_analysis,
        content_picture_mask,
        manual_picture_crop_authority,
        normalized,
        options,
        source_effectively_blank,
        cache,
        deskew_key,
        source_page_index,
        calibration,
        local_scale_x,
        local_scale_y,
        working_width,
        working_height,
        routing_source,
        region,
        local_deskew_forward,
        local_deskew_inverse,
        dewarp_model,
        half,
        timings,
    } = input;
    let content_key = cache.zip(deskew_key.as_ref()).map(|(cache, deskew_key)| {
        StageCacheKey::content(&cache.source, options, deskew_key, half)
    });
    let content_started = Instant::now();
    let cached_content = cache
        .zip(content_key.as_ref())
        .and_then(|(cache, key)| cache.shared.lock().ok()?.get::<CachedContentDetection>(key));
    // A source-level blank verdict is deliberately independent of the
    // selected output encoding. Auto mode may already have been resolved by
    // document detection (for example to grayscale) before final rendering.
    // Letting continuous-tone modes run content detection again made the
    // 150-DPI preview white while a source-DPI final render promoted the same
    // paper texture into false content. Manual content/picture/fill zones have
    // already vetoed this verdict in prepare_analysis_page.
    let force_clean_blank = source_effectively_blank;
    let detected = if force_clean_blank {
        CachedContentDetection {
            detected_content: None,
            source_content_box: None,
            diagnostics: None,
        }
    } else if let Some(cached) = cached_content {
        cached.as_ref().clone()
    } else {
        let detected = if let Some(manual) =
            options.resolved_content_for(half, normalized.width(), normalized.height())
        {
            let left = manual.x.clamp(0.0, working_width.saturating_sub(1) as f64);
            let top = manual.y.clamp(0.0, working_height.saturating_sub(1) as f64);
            let right = manual.right().clamp(left + 1.0, working_width as f64);
            let bottom = manual.bottom().clamp(top + 1.0, working_height as f64);
            let source_content = Rect::new(left, top, right - left, bottom - top);
            let deskewed_content = transform_rect_bounds(source_content, local_deskew_forward);
            let output_content = if let Some(model) = &dewarp_model {
                map_rect_bounds(deskewed_content, |point| {
                    model.map_source_to_unit_approx(point).map(|unit| {
                        Point::new(
                            unit.x * working_width as f64,
                            unit.y * working_height as f64,
                        )
                    })
                })
                .ok_or("Manual content box cannot be mapped through the dewarp model")?
            } else {
                deskewed_content
            };
            CachedContentDetection {
                detected_content: Some(output_content),
                source_content_box: Some(source_content),
                diagnostics: None,
            }
        } else {
            if let Some(dir) = std::env::var_os("EVB_SCAN_CLEANUP_DUMP_CONTENT_INPUT") {
                let path = std::path::Path::new(&dir)
                    .join(format!("content-input-{source_page_index}.pgm"));
                let _ = crate::io::raster::write_gray_pgm_atomic(&path, content_analysis);
            }
            let detected_result = detect_content_and_margins_calibrated_with_crop_authority(
                content_analysis,
                content_picture_mask,
                manual_picture_crop_authority,
                calibration.effective_dpi,
                None,
                Some([0.0; 4]),
                calibration,
            );
            if std::env::var_os("EVB_SCAN_CLEANUP_TRACE_CONTENT").is_some() {
                eprintln!(
                    "{{\"event\":\"content-call\",\"page\":{source_page_index},\"dpi\":{},\"pictureMask\":{},\"detected\":{:?}}}",
                    calibration.effective_dpi,
                    content_picture_mask.is_some(),
                    detected_result.content,
                );
            }
            let detected_content = detected_result.content.map(|rect| {
                map_analysis_rect_to_source_support(
                    rect,
                    local_scale_x,
                    local_scale_y,
                    working_width as f64,
                    working_height as f64,
                    if dewarp_model.is_some() {
                        SourceContentSupport::DewarpWithoutRectilinearPlane
                    } else {
                        SourceContentSupport::Rectilinear {
                            image: routing_source,
                            to_source: local_deskew_inverse
                                .then(Affine::translation(region.x, region.y)),
                        }
                    },
                )
            });
            let source_content_box = detected_content.and_then(|rect| {
                let source = if let Some(model) = &dewarp_model {
                    map_rect_bounds(rect, |point| {
                        model
                            .map_unit_to_source(
                                point.x / working_width as f64,
                                point.y / working_height as f64,
                            )
                            .map(|deskewed| local_deskew_inverse.apply(deskewed))
                    })
                } else {
                    Some(transform_rect_bounds(rect, local_deskew_inverse))
                }?;
                let left = source.x.clamp(0.0, working_width.saturating_sub(1) as f64);
                let top = source.y.clamp(0.0, working_height.saturating_sub(1) as f64);
                let right = source.right().clamp(left + 1.0, working_width as f64);
                let bottom = source.bottom().clamp(top + 1.0, working_height as f64);
                Some(Rect::new(left, top, right - left, bottom - top))
            });
            let detected_content = match (dewarp_model.as_ref(), source_content_box) {
                (None, Some(source)) => Some(transform_rect_bounds(source, local_deskew_forward)),
                _ => detected_content,
            };
            CachedContentDetection {
                detected_content,
                source_content_box,
                diagnostics: detected_result.diagnostics,
            }
        };
        if let (Some(cache), Some(key)) = (cache, content_key) {
            if let Ok(mut shared) = cache.shared.lock() {
                shared.insert(
                    key,
                    Arc::new(detected.clone()),
                    std::mem::size_of::<CachedContentDetection>(),
                );
            }
        }
        detected
    };
    timings.content_ms += content_started.elapsed().as_secs_f64() * 1_000.0;

    Ok(detected)
}

pub(crate) struct Input<'a> {
    pub source: &'a GrayImage,
    pub routing_source: &'a GrayImage,
    pub normalized: &'a GrayImage,
    pub analysis_normalized: &'a GrayImage,
    pub analysis_scale_x: f64,
    pub analysis_scale_y: f64,
    pub canonical_routing_sample: &'a GrayImage,
    pub canonical_leaf_source: &'a GrayImage,
    pub canonical_routing_dpi: f64,
    pub calibration: PageCalibration,
    pub color_source: Option<&'a RgbImage>,
    pub analysis_picture_mask: Option<&'a BinaryImage>,
    pub source_picture_mask: Option<&'a BinaryImage>,
    pub halftone_zone_mask: Option<&'a BinaryImage>,
    pub spatial_tone_mask: Option<&'a BinaryImage>,
    pub chroma_picture_mask: Option<&'a BinaryImage>,
    pub tone_picture_mask: Option<&'a BinaryImage>,
    pub preserve_confirmed_photo_tones: bool,
    pub use_soft_alpha_foreground: bool,
    pub tone_preservation_alpha: Option<&'a GrayImage>,
    pub text_mask: Option<&'a BinaryImage>,
    pub text_vicinity_mask: Option<&'a BinaryImage>,
    pub trusted_foreground_mask: Option<&'a BinaryImage>,
    pub options: &'a CleanupOptions,
    pub source_page_index: usize,
    pub split: &'a SplitResult,
    pub spread_plan: Option<&'a SpreadBinarizationPlan>,
    pub region: Rect,
    pub half: PageHalf,
    pub cache: Option<&'a PageCache>,
    pub split_cache_key: Option<&'a StageCacheKey>,
    pub source_effectively_blank: bool,
    pub create_mixed_layers: bool,
    pub create_mixed_composite: bool,
    pub timings: &'a mut PageStageTimings,
}

struct RenderGeometryInput<'a> {
    detected: CachedContentDetection,
    options: &'a CleanupOptions,
    region: Rect,
    working_width: usize,
    working_height: usize,
    local_deskew_forward: Affine,
    local_deskew_inverse: Affine,
    dewarp_model: Option<DewarpModel>,
}

struct RenderGeometryOutput {
    content: ContentResult,
    source_content_box: Option<Rect>,
    content_diagnostics: Option<ContentDiagnostics>,
    crop_enabled: bool,
    output_rect: Rect,
    output_width: usize,
    output_height: usize,
    render_region: Option<Rect>,
    sampled_region: Option<Rect>,
    render_plan: ComposedRenderPlan,
    rendered_width: usize,
    rendered_height: usize,
}

fn plan_render_geometry(
    input: RenderGeometryInput<'_>,
) -> Result<RenderGeometryOutput, super::AnalysisError> {
    let RenderGeometryInput {
        detected,
        options,
        region,
        working_width,
        working_height,
        local_deskew_forward,
        local_deskew_inverse,
        dewarp_model,
    } = input;
    if options.match_page_size {
        // See the analysis path above: placement owns matched margins, while
        // the renderer still rejects arithmetic that could not be represented.
        content_result_for_dimensions(
            working_width,
            working_height,
            options.dpi,
            detected.detected_content,
            options.margins_mm.map(crate::MarginsMm::values),
            options.margins_pixels,
        )?;
    }
    let content = content_result_for_dimensions(
        working_width,
        working_height,
        options.dpi,
        detected.detected_content,
        if options.match_page_size {
            None
        } else {
            options.margins_mm.map(crate::MarginsMm::values)
        },
        if options.match_page_size {
            Some([0.0; 4])
        } else {
            options.margins_pixels
        },
    )?;
    let source_content_box = detected.source_content_box;
    let content_diagnostics = detected.diagnostics;
    let crop_enabled = options.crop_content && !options.ocr_mode && content.content.is_some();
    let output_rect = if crop_enabled {
        content.output_rect
    } else {
        Rect::new(0.0, 0.0, working_width as f64, working_height as f64)
    };
    let (output_width, output_height) =
        options.validate_derived_raster_dimensions(output_rect.width, output_rect.height)?;
    let render_region = options.resolved_render_crop(output_width, output_height);
    // Local threshold windows and connected-component cleanup need context
    // beyond the visible tile. Sample a bounded apron, process it, then trim
    // back to render_region so panning cannot change interior stroke weight.
    let sampled_region = render_region.map(|crop| {
        if matches!(options.output_mode, OutputMode::Bw | OutputMode::Mixed) {
            const PROCESSING_APRON_PX: f64 = 256.0;
            let left = (crop.x - PROCESSING_APRON_PX).max(0.0);
            let top = (crop.y - PROCESSING_APRON_PX).max(0.0);
            let right = (crop.right() + PROCESSING_APRON_PX).min(output_width as f64);
            let bottom = (crop.bottom() + PROCESSING_APRON_PX).min(output_height as f64);
            Rect::new(left, top, right - left, bottom - top)
        } else {
            crop
        }
    });
    let render_rect = sampled_region.map_or(output_rect, |crop| {
        Rect::new(
            output_rect.x + crop.x,
            output_rect.y + crop.y,
            crop.width,
            crop.height,
        )
    });
    let render_plan = ComposedRenderPlan::new(
        region,
        local_deskew_forward,
        local_deskew_inverse,
        dewarp_model,
        working_width,
        working_height,
        render_rect,
    );
    let rendered_width = render_plan.output_width();
    let rendered_height = render_plan.output_height();
    Ok(RenderGeometryOutput {
        content,
        source_content_box,
        content_diagnostics,
        crop_enabled,
        output_rect,
        output_width,
        output_height,
        render_region,
        sampled_region,
        render_plan,
        rendered_width,
        rendered_height,
    })
}

struct RasterPlaneInput<'a> {
    normalized: &'a GrayImage,
    routing_source: &'a GrayImage,
    color_source: Option<&'a RgbImage>,
    source_picture_mask: Option<&'a BinaryImage>,
    tone_preservation_alpha: Option<&'a GrayImage>,
    text_tone_diagnostics: Option<TextToneDiagnostics>,
    options: &'a CleanupOptions,
    preserve_confirmed_photo_tones: bool,
    working_width: usize,
    working_height: usize,
    render_region: Option<Rect>,
    sampled_region: Option<Rect>,
    output_rect: Rect,
    render_plan: &'a ComposedRenderPlan,
    rendered_width: usize,
    rendered_height: usize,
    region: Rect,
    local_deskew_forward: Affine,
    local_deskew_inverse: Affine,
    dewarp_model: Option<DewarpModel>,
    timings: &'a mut PageStageTimings,
}

struct RasterPlaneOutput {
    rendered_gray: GrayImage,
    rendered_color: Option<RgbImage>,
    rendered_source_gray: GrayImage,
    rendered_tone_alpha: Option<GrayImage>,
    forward_transform: Option<Affine>,
    inverse_transform: Option<Affine>,
    dewarp_mapping: Option<DewarpMappingGrid>,
}

fn prepare_render_planes(
    input: RasterPlaneInput<'_>,
) -> Result<RasterPlaneOutput, super::AnalysisError> {
    let RasterPlaneInput {
        normalized,
        routing_source,
        color_source,
        source_picture_mask,
        tone_preservation_alpha,
        text_tone_diagnostics,
        options,
        preserve_confirmed_photo_tones,
        working_width,
        working_height,
        render_region,
        sampled_region,
        output_rect,
        render_plan,
        rendered_width,
        rendered_height,
        region,
        local_deskew_forward,
        local_deskew_inverse,
        dewarp_model,
        timings,
    } = input;
    let rasterization_started = Instant::now();
    // Halftone plates can alias into horizontal bands when a confirmed photo
    // is reduced to a smaller tonal layer. Descreen only the owner, and only
    // when the render is genuinely downscaled; the routing raster and every
    // unowned paper/text pixel continue to use the original normalized image.
    let descreened_normalized = if should_prefilter_confirmed_photo_regions(
        preserve_confirmed_photo_tones,
        options.output_mode,
        rendered_width,
        rendered_height,
        working_width,
        working_height,
    ) {
        source_picture_mask
            .filter(|mask| mask.count_black() > 0)
            .map(|mask| {
                let normalized_owner =
                    resample_binary_mask_nearest(mask, normalized.width(), normalized.height());
                let mut filtered = normalized.clone();
                prefilter_confirmed_photo_regions(&mut filtered, &normalized_owner);
                filtered
            })
    } else {
        None
    };
    let tonal_render_source = descreened_normalized.as_ref().unwrap_or(normalized);
    // A colour page publishes its RGB raster; the gray twin is never encoded, so
    // the only question it answered — blankness — moves to the analysis level.
    let skips_gray_twin = options.output_mode == OutputMode::Color
        && color_source.is_some()
        && !render_plan.has_dewarp();
    let (mut rendered_gray, rendered_color, forward_transform, inverse_transform, dewarp_mapping) =
        if render_plan.has_dewarp() {
            let gray = rasterize_inverse_area_with(
                tonal_render_source,
                rendered_width,
                rendered_height,
                |point| render_plan.output_to_source(point),
            );
            let color = color_source.map(|source| {
                rasterize_inverse_area_rgb_with(source, rendered_width, rendered_height, |point| {
                    render_plan.output_to_source(point)
                })
            });
            let metadata_plan = render_region.map_or_else(
                || render_plan.clone(),
                |crop| {
                    ComposedRenderPlan::new(
                        region,
                        local_deskew_forward,
                        local_deskew_inverse,
                        dewarp_model,
                        working_width,
                        working_height,
                        Rect::new(
                            output_rect.x + crop.x,
                            output_rect.y + crop.y,
                            crop.width,
                            crop.height,
                        ),
                    )
                },
            );
            let grid = sampled_dewarp_grid(&metadata_plan, region);
            (gray, color, None, None, Some(grid))
        } else {
            let inverse = render_plan
                .affine_inverse()
                .ok_or("Cleanup affine render plan is unavailable")?;
            let forward = inverse
                .inverse()
                .ok_or("Cleanup transform is not invertible")?;
            (
                if skips_gray_twin {
                    GrayImage::new(rendered_width, rendered_height, 255)
                } else {
                    render_affine_gray(
                        tonal_render_source,
                        rendered_width,
                        rendered_height,
                        inverse,
                    )
                },
                color_source.map(|color| {
                    render_affine_rgb(color, rendered_width, rendered_height, inverse)
                }),
                Some(forward),
                Some(inverse),
                None,
            )
        };
    let rendered_source_gray = if render_plan.has_dewarp() {
        rasterize_inverse_area_with(routing_source, rendered_width, rendered_height, |point| {
            render_plan.output_to_source(point)
        })
    } else {
        render_affine_gray(
            routing_source,
            rendered_width,
            rendered_height,
            render_plan
                .affine_inverse()
                .expect("cleanup affine render plan is available"),
        )
    };
    timings.rasterization_ms += rasterization_started.elapsed().as_secs_f64() * 1_000.0;
    // Coarse tonal evidence is valid for deriving the global tone curve, but
    // only pixel-resolution picture geometry may form a boundary in the
    // rendered raster.
    let rendered_tone_alpha = tone_preservation_alpha.map(|alpha| {
        let (mask_scale_x, mask_scale_y) =
            auxiliary_mask_scales(alpha.width(), alpha.height(), normalized);
        render_gray_field(alpha, rendered_width, rendered_height, |point| {
            map_auxiliary_mask_point(render_plan, mask_scale_x, mask_scale_y, point)
        })
    });
    if let Some(diagnostics) = text_tone_diagnostics {
        apply_text_tone_excluding(
            &mut rendered_gray,
            diagnostics,
            rendered_tone_alpha.as_ref(),
        );
    }
    let (forward_transform, inverse_transform) =
        if let (Some(forward), Some(region)) = (forward_transform, sampled_region) {
            let intrinsic_forward = forward.then(Affine::translation(region.x, region.y));
            (Some(intrinsic_forward), intrinsic_forward.inverse())
        } else {
            (forward_transform, inverse_transform)
        };
    Ok(RasterPlaneOutput {
        rendered_gray,
        rendered_color,
        rendered_source_gray,
        rendered_tone_alpha,
        forward_transform,
        inverse_transform,
        dewarp_mapping,
    })
}

struct MaskPreparationInput<'a> {
    normalized: &'a GrayImage,
    render_plan: &'a ComposedRenderPlan,
    rendered_width: usize,
    rendered_height: usize,
    source_picture_mask: Option<&'a BinaryImage>,
    halftone_zone_mask: Option<&'a BinaryImage>,
    spatial_tone_mask: Option<&'a BinaryImage>,
    chroma_picture_mask: Option<&'a BinaryImage>,
    tone_picture_mask: Option<&'a BinaryImage>,
    text_vicinity_mask: Option<&'a BinaryImage>,
    text_mask: Option<&'a BinaryImage>,
    trusted_foreground_mask: Option<&'a BinaryImage>,
    options: &'a CleanupOptions,
    preserve_confirmed_photo_tones: bool,
    text_line_count: usize,
    timings: &'a mut PageStageTimings,
}

struct MaskPreparationOutput {
    rendered_picture_mask: Option<BinaryImage>,
    rendered_chroma_picture_mask: Option<BinaryImage>,
    rendered_text_vicinity_mask: Option<BinaryImage>,
    rendered_text_mask: Option<BinaryImage>,
    rendered_trusted_foreground_mask: Option<BinaryImage>,
}

fn render_auxiliary_mask(
    mask: &BinaryImage,
    normalized: &GrayImage,
    render_plan: &ComposedRenderPlan,
    rendered_width: usize,
    rendered_height: usize,
) -> BinaryImage {
    let (mask_scale_x, mask_scale_y) =
        auxiliary_mask_scales(mask.width(), mask.height(), normalized);
    render_binary_mask(mask, rendered_width, rendered_height, |point| {
        map_auxiliary_mask_point(render_plan, mask_scale_x, mask_scale_y, point)
    })
}

fn prepare_region_masks(input: MaskPreparationInput<'_>) -> MaskPreparationOutput {
    let MaskPreparationInput {
        normalized,
        render_plan,
        rendered_width,
        rendered_height,
        source_picture_mask,
        halftone_zone_mask,
        spatial_tone_mask,
        chroma_picture_mask,
        tone_picture_mask,
        text_vicinity_mask,
        text_mask,
        trusted_foreground_mask,
        options,
        preserve_confirmed_photo_tones,
        text_line_count,
        timings,
    } = input;
    let mask_rasterization_started = Instant::now();
    let mut rendered_picture_mask = source_picture_mask.map(|mask| {
        render_auxiliary_mask(
            mask,
            normalized,
            render_plan,
            rendered_width,
            rendered_height,
        )
    });
    let rendered_halftone_zone_mask = halftone_zone_mask.map(|mask| {
        render_auxiliary_mask(
            mask,
            normalized,
            render_plan,
            rendered_width,
            rendered_height,
        )
    });
    let rendered_spatial_tone_mask = (options.output_mode == OutputMode::Mixed)
        .then(|| {
            spatial_tone_mask.map(|mask| {
                render_auxiliary_mask(
                    mask,
                    normalized,
                    render_plan,
                    rendered_width,
                    rendered_height,
                )
            })
        })
        .flatten();
    let rendered_chroma_picture_mask = chroma_picture_mask.map(|mask| {
        render_auxiliary_mask(
            mask,
            normalized,
            render_plan,
            rendered_width,
            rendered_height,
        )
    });
    // Keep calibrated tone zones as geometry in render space. The alpha field
    // is useful for semantic protection, but it is not a complete layer
    // boundary: a bimodal photo or map can have low alpha over a valid
    // midtone region. Fresh Mixed composition must still own that region from
    // the cleaned raster rather than whitening it as unclassified paper.
    let rendered_tone_picture_mask = tone_picture_mask.map(|mask| {
        render_auxiliary_mask(
            mask,
            normalized,
            render_plan,
            rendered_width,
            rendered_height,
        )
    });
    let rendered_text_vicinity_mask = text_vicinity_mask.map(|mask| {
        render_auxiliary_mask(
            mask,
            normalized,
            render_plan,
            rendered_width,
            rendered_height,
        )
    });
    let rendered_text_mask = text_mask.map(|mask| {
        render_auxiliary_mask(
            mask,
            normalized,
            render_plan,
            rendered_width,
            rendered_height,
        )
    });
    let rendered_trusted_foreground_mask = trusted_foreground_mask.map(|mask| {
        let (mask_scale_x, mask_scale_y) =
            auxiliary_mask_scales(mask.width(), mask.height(), normalized);
        render_binary_mask_preserve_ink(
            mask,
            rendered_width,
            rendered_height,
            mask_scale_x,
            mask_scale_y,
            |point| map_auxiliary_mask_point(render_plan, mask_scale_x, mask_scale_y, point),
        )
    });
    if options.output_mode == OutputMode::Mixed {
        partition_mixed_picture_mask(
            &mut rendered_picture_mask,
            preserve_confirmed_photo_tones,
            rendered_spatial_tone_mask.as_ref(),
            rendered_chroma_picture_mask.as_ref(),
            rendered_tone_picture_mask.as_ref(),
            rendered_halftone_zone_mask.as_ref(),
            rendered_text_vicinity_mask.as_ref(),
            options.dpi,
            text_line_count,
        );
    }
    timings.mask_rasterization_ms += mask_rasterization_started.elapsed().as_secs_f64() * 1_000.0;
    MaskPreparationOutput {
        rendered_picture_mask,
        rendered_chroma_picture_mask,
        rendered_text_vicinity_mask,
        rendered_text_mask,
        rendered_trusted_foreground_mask,
    }
}

struct BlanknessPolicyInput<'a> {
    canonical_leaf_source: &'a GrayImage,
    canonical_routing_dpi: f64,
    force_clean_blank: bool,
    content_present: bool,
    rendered_picture_mask: Option<BinaryImage>,
    rendered_text_mask: Option<BinaryImage>,
    rendered_trusted_foreground_mask: Option<BinaryImage>,
    preserve_confirmed_photo_tones: bool,
    half: PageHalf,
}

struct BlanknessPolicyOutput {
    rendered_picture_mask: Option<BinaryImage>,
    rendered_text_mask: Option<BinaryImage>,
    rendered_trusted_foreground_mask: Option<BinaryImage>,
    ink_ownership_mask: Option<BinaryImage>,
    pale_tonal_structure: bool,
    effectively_blank: bool,
    fail_closed_blank: bool,
    fold_edge_blank_leaf: bool,
    unowned_fold_edge_blank_leaf: bool,
    trusted_selection_applied: bool,
    trusted_mrc_background_preserved: bool,
}

fn resolve_blankness_policy(input: BlanknessPolicyInput<'_>) -> BlanknessPolicyOutput {
    let BlanknessPolicyInput {
        canonical_leaf_source,
        canonical_routing_dpi,
        force_clean_blank,
        content_present,
        rendered_picture_mask,
        rendered_text_mask,
        rendered_trusted_foreground_mask,
        preserve_confirmed_photo_tones,
        half,
    } = input;
    let ink_ownership_mask =
        page_ink_ownership_mask(rendered_text_mask.as_ref(), rendered_picture_mask.as_ref());
    let pale_tonal_structure =
        !force_clean_blank && has_pale_tonal_structure(canonical_leaf_source);
    let effectively_blank = force_clean_blank
        || (!pale_tonal_structure
            && is_effectively_blank(canonical_leaf_source, canonical_routing_dpi));
    // A verso whose only survivor is the fold shadow along the leaf edge is a
    // blank page, and publishing the streak serves nobody. The leaf has to own
    // no text or picture ink and its inset interior must independently remain
    // blank. A pale plate therefore survives even when an edge shadow is also
    // present; only edge-confined unowned residue earns the white page.
    let unowned_edge_residue = !pale_tonal_structure
        && !effectively_blank
        && !content_present
        && ink_ownership_mask
            .as_ref()
            .is_none_or(|mask| mask.count_black() < owned_ink_minimum(mask.width(), mask.height()))
        && leaf_interior_is_blank(canonical_leaf_source, canonical_routing_dpi);
    // A pale reverse-side bleed-through can establish page-scale tonal
    // structure even when the leaf itself has no authored content. Treat that
    // combination as blank only when both ownership masks are below the same
    // minimum and the transformed interior is independently blank. A real
    // faint plate/text block either owns enough pixels or fails the interior
    // blank test, while the fold rail remains safely unowned.
    let pale_blank_leaf = pale_tonal_structure
        && !preserve_confirmed_photo_tones
        && half != PageHalf::Full
        && !content_present
        && ink_ownership_mask
            .as_ref()
            .is_none_or(|mask| mask.count_black() < owned_ink_minimum(mask.width(), mask.height()))
        && rendered_picture_mask
            .as_ref()
            .is_none_or(|mask| mask.count_black() < owned_ink_minimum(mask.width(), mask.height()))
        && leaf_interior_is_blank(canonical_leaf_source, canonical_routing_dpi);
    let fail_closed_blank = force_clean_blank
        || (!pale_tonal_structure
            && !content_present
            && (effectively_blank || unowned_edge_residue))
        || pale_blank_leaf;
    // A sparse false-positive picture mask is common on a blank verso beside
    // a fold shadow. Strict text evidence is the blank-page veto here; normal
    // picture ownership still pins components, while the helper's separate
    // blank-speck branch may remove only isolated sub-glyph marks in the
    // fold corridor.
    let fold_edge_blank_leaf = !content_present
        && rendered_text_mask
            .as_ref()
            .is_none_or(|mask| mask.count_black() < owned_ink_minimum(mask.width(), mask.height()));
    let unowned_fold_edge_blank_leaf = fold_edge_blank_leaf
        && rendered_picture_mask
            .as_ref()
            .is_none_or(|mask| mask.count_black() < owned_ink_minimum(mask.width(), mask.height()));
    // Whole-page abstention guarded against the old destructive whitening.
    // Picture zones now preserve continuous tone exactly while everything
    // else is smoothly normalized toward white, so cleanup is always safe and
    // every page keeps the white-paper contract. The flags and metadata fields
    // remain protocol-compatible markers; fresh output never sets them.
    let trusted_selection_applied = rendered_trusted_foreground_mask.is_some();
    let trusted_mrc_background_preserved = false;
    BlanknessPolicyOutput {
        rendered_picture_mask,
        rendered_text_mask,
        rendered_trusted_foreground_mask,
        ink_ownership_mask,
        pale_tonal_structure,
        effectively_blank,
        fail_closed_blank,
        fold_edge_blank_leaf,
        unowned_fold_edge_blank_leaf,
        trusted_selection_applied,
        trusted_mrc_background_preserved,
    }
}

struct BilevelProcessingInput<'a> {
    rendered_gray: GrayImage,
    rendered_source_gray: GrayImage,
    canonical_routing_sample: &'a GrayImage,
    options: &'a CleanupOptions,
    spread_plan: Option<&'a SpreadBinarizationPlan>,
    calibration: PageCalibration,
    rendered_picture_mask: Option<&'a BinaryImage>,
    rendered_text_mask: Option<&'a BinaryImage>,
    rendered_text_vicinity_mask: Option<&'a BinaryImage>,
    rendered_trusted_foreground_mask: Option<&'a BinaryImage>,
    ink_ownership_mask: Option<&'a BinaryImage>,
    normalized_width: usize,
    normalized_height: usize,
    source_page_index: usize,
    half: PageHalf,
    split: &'a SplitResult,
    region: Rect,
    render_plan: &'a ComposedRenderPlan,
    source_content_box: Option<Rect>,
    fold_edge_blank_leaf: bool,
    unowned_fold_edge_blank_leaf: bool,
    effectively_blank: bool,
    pale_tonal_structure: bool,
    crop_enabled: bool,
    deskew_accepted: bool,
    effective_dewarp: bool,
    create_mixed_layers: bool,
    timings: &'a mut PageStageTimings,
}

struct BilevelProcessingOutput {
    image: CleanupRaster,
    binarization_mode: Option<crate::BinarizationMode>,
    binarization_diagnostics: Option<BinarizationDiagnostics>,
    despeckle_fallback: bool,
    mixed_layers: Option<MixedLayers>,
    emitted_output_mode: OutputMode,
    ink_consistency_diagnostics: Option<InkConsistencyDiagnostics>,
    conservation_warnings: Vec<String>,
}

struct CollapsedGrayscaleInput<'a> {
    fallback: GrayImage,
    removed_edge_bands: &'a BinaryImage,
    half: PageHalf,
    split: &'a SplitResult,
    unowned_fold_edge_blank_leaf: bool,
    create_mixed_layers: bool,
}

struct CollapsedGrayscaleOutput {
    image: GrayImage,
    mixed_layers: Option<MixedLayers>,
}

fn collapsed_grayscale_output(input: CollapsedGrayscaleInput<'_>) -> CollapsedGrayscaleOutput {
    let CollapsedGrayscaleInput {
        fallback,
        removed_edge_bands,
        half,
        split,
        unowned_fold_edge_blank_leaf,
        create_mixed_layers,
    } = input;
    let image = whiten_collapsed_blank_fold_margin(
        fallback,
        removed_edge_bands,
        half,
        split,
        unowned_fold_edge_blank_leaf,
    );
    let mixed_layers = create_mixed_layers.then(|| MixedLayers {
        foreground_mask: BinaryImage::new(image.width(), image.height()),
        foreground_alpha: None,
        background: image.clone(),
        color_background: None,
        source_mrc: false,
    });
    CollapsedGrayscaleOutput {
        image,
        mixed_layers,
    }
}

fn process_bilevel_output(input: BilevelProcessingInput<'_>) -> BilevelProcessingOutput {
    let BilevelProcessingInput {
        rendered_gray,
        rendered_source_gray,
        canonical_routing_sample,
        options,
        spread_plan,
        calibration,
        rendered_picture_mask,
        rendered_text_mask,
        rendered_text_vicinity_mask,
        rendered_trusted_foreground_mask,
        ink_ownership_mask,
        normalized_width,
        normalized_height,
        source_page_index,
        half,
        split,
        region,
        render_plan,
        source_content_box,
        fold_edge_blank_leaf,
        unowned_fold_edge_blank_leaf,
        effectively_blank,
        pale_tonal_structure,
        crop_enabled,
        deskew_accepted,
        effective_dewarp,
        create_mixed_layers,
        timings,
    } = input;
    let mut ink_consistency_diagnostics = None;
    let mut conservation_warnings = Vec::new();
    let mut emitted_output_mode = options.output_mode;
    let routing_diagnostics = spread_plan.map_or_else(
        || resolve_binarization_diagnostics(canonical_routing_sample, options),
        |plan| plan.diagnostics(),
    );
    let mode = routing_diagnostics.route;
    let complete_trusted_foreground = rendered_trusted_foreground_mask
        .filter(|_| options.source_has_bilevel_layer && !options.trusted_selection_incomplete);
    let (image, binarization_mode, binarization_diagnostics, despeckle_fallback, mixed_layers) =
        if let Some(trusted_foreground) = complete_trusted_foreground {
            if !effectively_blank
                && pale_tonal_structure
                && pale_bilevel_collapse(trusted_foreground, pale_tonal_structure)
            {
                let fold_output = fold_edge_filtering::run(fold_edge_filtering::Input {
                    binary: trusted_foreground,
                    picture_mask: rendered_picture_mask,
                    text_mask: rendered_text_mask,
                    text_vicinity_mask: rendered_text_vicinity_mask,
                    half,
                    split,
                    region,
                    render_plan,
                    source_content_box,
                    blank_leaf: fold_edge_blank_leaf,
                    dpi: options.dpi,
                });
                let fold_removed_edge_bands = fold_output.removed;
                conservation_warnings.push(format!(
                    "Black-and-white rendering left source page {} ({}) empty although the leaf carries structure; the grayscale rendition was emitted instead",
                    source_page_index + 1,
                    page_half_label(half)
                ));
                emitted_output_mode = OutputMode::Grayscale;
                let CollapsedGrayscaleOutput {
                    image: grayscale_fallback,
                    mixed_layers: layers,
                } = collapsed_grayscale_output(CollapsedGrayscaleInput {
                    fallback: rendered_source_gray,
                    removed_edge_bands: &fold_removed_edge_bands,
                    half,
                    split,
                    unowned_fold_edge_blank_leaf,
                    create_mixed_layers,
                });
                (
                    CleanupRaster::Gray(grayscale_fallback),
                    Some(mode),
                    Some(routing_diagnostics),
                    false,
                    layers,
                )
            } else {
                let trusted_foreground = options.page_ink_consistency.map_or_else(
                    || trusted_foreground.clone(),
                    |context| {
                        let (stabilized, diagnostics) = stabilize_trusted_stroke_mass(
                            trusted_foreground,
                            &rendered_source_gray,
                            rendered_picture_mask,
                            context,
                            normalized_width,
                            normalized_height,
                            options.dpi,
                        );
                        ink_consistency_diagnostics = Some(diagnostics);
                        stabilized
                    },
                );
                let trusted_foreground = fold_edge_filtering::run(fold_edge_filtering::Input {
                    binary: &trusted_foreground,
                    picture_mask: rendered_picture_mask,
                    text_mask: rendered_text_mask,
                    text_vicinity_mask: rendered_text_vicinity_mask,
                    half,
                    split,
                    region,
                    render_plan,
                    source_content_box,
                    blank_leaf: fold_edge_blank_leaf,
                    dpi: options.dpi,
                })
                .kept;
                (
                    CleanupRaster::Bilevel(trusted_foreground),
                    Some(mode),
                    Some(routing_diagnostics),
                    false,
                    None,
                )
            }
        } else {
            let global_threshold_source =
                (mode == crate::BinarizationMode::Otsu).then_some(&rendered_source_gray);
            let binarization_started = Instant::now();
            let (fresh_binary, diagnostics, fresh_despeckle_fallback, stage_timings) =
                binarize_normalized_with_diagnostics(
                    &rendered_gray,
                    &rendered_source_gray,
                    routing_diagnostics,
                    global_threshold_source,
                    options,
                    calibration,
                    rendered_picture_mask,
                    rendered_text_vicinity_mask,
                    spread_plan,
                );
            timings.threshold_preparation_ms += stage_timings.preparation_ms;
            timings.thresholding_ms += stage_timings.thresholding_ms;
            timings.binary_postprocess_ms += stage_timings.postprocess_ms;
            timings.binarization_ms += binarization_started.elapsed().as_secs_f64() * 1_000.0;
            let reusable = split.reusable_binary.as_ref().filter(|binary| {
                mode == crate::BinarizationMode::Otsu
                    && options.thickness == 0
                    && !deskew_accepted
                    && !effective_dewarp
                    && !crop_enabled
                    && region.x == 0.0
                    && region.y == 0.0
                    && region.width == normalized_width as f64
                    && region.height == normalized_height as f64
                    && binary.width() == rendered_gray.width()
                    && binary.height() == rendered_gray.height()
            });
            let (binary, despeckle_fallback) = if let Some(binary) = reusable {
                postprocess_binary_with_diagnostics_and_raw(
                    binary,
                    Some(&rendered_gray),
                    Some(&rendered_source_gray),
                    options,
                    calibration,
                )
            } else {
                (fresh_binary, fresh_despeckle_fallback)
            };
            let binary = restore_genuine_horizontal_rules(
                &binary,
                &rendered_source_gray,
                rendered_picture_mask,
                rendered_text_mask,
                rendered_text_vicinity_mask,
                options.dpi,
            );
            let conservative = binary.clone();
            let binary = filter_soft_shallow_bleed_components(
                &binary,
                &rendered_source_gray,
                rendered_picture_mask,
                rendered_text_mask,
                rendered_text_vicinity_mask,
                options.dpi,
            );
            let binary = enforce_source_ink_support(
                binary,
                &rendered_source_gray,
                rendered_trusted_foreground_mask,
                options.source_has_bilevel_layer && !options.trusted_selection_incomplete,
                options.dpi,
            );
            let (binary, _) = conserve_page_ink(
                conservative,
                binary,
                ink_ownership_mask,
                source_page_index,
                half,
                &mut conservation_warnings,
            );
            let fold_output = fold_edge_filtering::run(fold_edge_filtering::Input {
                binary: &binary,
                picture_mask: rendered_picture_mask,
                text_mask: rendered_text_mask,
                text_vicinity_mask: rendered_text_vicinity_mask,
                half,
                split,
                region,
                render_plan,
                source_content_box,
                blank_leaf: fold_edge_blank_leaf,
                dpi: options.dpi,
            });
            let binary = fold_output.kept;
            let fold_removed_edge_bands = fold_output.removed;
            if !effectively_blank && pale_bilevel_collapse(&binary, pale_tonal_structure) {
                conservation_warnings.push(format!(
                    "Black-and-white rendering left source page {} ({}) empty although the leaf carries structure; the grayscale rendition was emitted instead",
                    source_page_index + 1,
                    page_half_label(half)
                ));
                emitted_output_mode = OutputMode::Grayscale;
                let grayscale_fallback = if pale_tonal_structure {
                    rendered_source_gray
                } else {
                    rendered_gray
                };
                let CollapsedGrayscaleOutput {
                    image: grayscale_fallback,
                    mixed_layers: layers,
                } = collapsed_grayscale_output(CollapsedGrayscaleInput {
                    fallback: grayscale_fallback,
                    removed_edge_bands: &fold_removed_edge_bands,
                    half,
                    split,
                    unowned_fold_edge_blank_leaf,
                    create_mixed_layers,
                });
                (
                    CleanupRaster::Gray(grayscale_fallback),
                    Some(mode),
                    Some(diagnostics),
                    despeckle_fallback,
                    layers,
                )
            } else {
                (
                    CleanupRaster::Bilevel(binary),
                    Some(mode),
                    Some(diagnostics),
                    despeckle_fallback,
                    None,
                )
            }
        };
    BilevelProcessingOutput {
        image,
        binarization_mode,
        binarization_diagnostics,
        despeckle_fallback,
        mixed_layers,
        emitted_output_mode,
        ink_consistency_diagnostics,
        conservation_warnings,
    }
}

struct MixedProcessingInput<'a> {
    rendered_gray: GrayImage,
    rendered_source_gray: GrayImage,
    rendered_color: &'a Option<RgbImage>,
    rendered_picture_mask: &'a Option<BinaryImage>,
    rendered_chroma_picture_mask: &'a Option<BinaryImage>,
    rendered_text_vicinity_mask: &'a Option<BinaryImage>,
    rendered_text_mask: &'a Option<BinaryImage>,
    rendered_trusted_foreground_mask: &'a Option<BinaryImage>,
    canonical_routing_sample: &'a GrayImage,
    options: &'a CleanupOptions,
    spread_plan: Option<&'a SpreadBinarizationPlan>,
    calibration: PageCalibration,
    ink_ownership_mask: &'a Option<BinaryImage>,
    source_page_index: usize,
    half: PageHalf,
    split: &'a SplitResult,
    region: Rect,
    render_plan: &'a ComposedRenderPlan,
    source_content_box: Option<Rect>,
    fold_edge_blank_leaf: bool,
    unowned_fold_edge_blank_leaf: bool,
    effectively_blank: bool,
    pale_tonal_structure: bool,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    create_mixed_layers: bool,
    create_mixed_composite: bool,
    deskew: DeskewResult,
    effective_dewarp: bool,
    timings: &'a mut PageStageTimings,
}

struct MixedProcessingOutput {
    image: CleanupRaster,
    color_image: Option<RgbImage>,
    binarization_mode: Option<crate::BinarizationMode>,
    binarization_diagnostics: Option<BinarizationDiagnostics>,
    despeckle_fallback: bool,
    mixed_layers: Option<MixedLayers>,
    emitted_output_mode: OutputMode,
    conservation_warnings: Vec<String>,
}

fn process_mixed_without_picture(input: MixedProcessingInput<'_>) -> MixedProcessingOutput {
    let MixedProcessingInput {
        rendered_gray,
        rendered_source_gray,
        rendered_picture_mask,
        rendered_text_vicinity_mask,
        rendered_text_mask,
        rendered_trusted_foreground_mask,
        canonical_routing_sample,
        options,
        spread_plan,
        calibration,
        ink_ownership_mask,
        source_page_index,
        half,
        split,
        region,
        render_plan,
        source_content_box,
        fold_edge_blank_leaf,
        unowned_fold_edge_blank_leaf,
        effectively_blank,
        pale_tonal_structure,
        create_mixed_layers,
        timings,
        ..
    } = input;
    let mut conservation_warnings = Vec::new();
    let routing_diagnostics = spread_plan.map_or_else(
        || resolve_binarization_diagnostics(canonical_routing_sample, options),
        |plan| plan.diagnostics(),
    );
    let route = routing_diagnostics.route;
    let global_threshold_source =
        (route == crate::BinarizationMode::Otsu).then_some(&rendered_source_gray);
    let binarization_started = Instant::now();
    let (binary, diagnostics, despeckle_fallback, stage_timings) =
        binarize_normalized_with_diagnostics(
            &rendered_gray,
            &rendered_source_gray,
            routing_diagnostics,
            global_threshold_source,
            options,
            calibration,
            rendered_picture_mask.as_ref(),
            rendered_text_vicinity_mask.as_ref(),
            spread_plan,
        );
    timings.threshold_preparation_ms += stage_timings.preparation_ms;
    timings.thresholding_ms += stage_timings.thresholding_ms;
    timings.binary_postprocess_ms += stage_timings.postprocess_ms;
    timings.binarization_ms += binarization_started.elapsed().as_secs_f64() * 1_000.0;
    let mode = diagnostics.route;
    let binary = restore_genuine_horizontal_rules(
        &binary,
        &rendered_source_gray,
        None,
        rendered_text_mask.as_ref(),
        rendered_text_vicinity_mask.as_ref(),
        options.dpi,
    );
    let conservative = binary.clone();
    let binary = filter_soft_shallow_bleed_components(
        &binary,
        &rendered_source_gray,
        None,
        rendered_text_mask.as_ref(),
        rendered_text_vicinity_mask.as_ref(),
        options.dpi,
    );
    let binary = enforce_source_ink_support(
        binary,
        &rendered_source_gray,
        rendered_trusted_foreground_mask.as_ref(),
        options.source_has_bilevel_layer && !options.trusted_selection_incomplete,
        options.dpi,
    );
    let (binary, _) = conserve_page_ink(
        conservative,
        binary,
        ink_ownership_mask.as_ref(),
        source_page_index,
        half,
        &mut conservation_warnings,
    );
    let fold_output = fold_edge_filtering::run(fold_edge_filtering::Input {
        binary: &binary,
        picture_mask: rendered_picture_mask.as_ref(),
        text_mask: rendered_text_mask.as_ref(),
        text_vicinity_mask: rendered_text_vicinity_mask.as_ref(),
        half,
        split,
        region,
        render_plan,
        source_content_box,
        blank_leaf: fold_edge_blank_leaf,
        dpi: options.dpi,
    });
    let binary = fold_output.kept;
    let fold_removed_edge_bands = fold_output.removed;
    let (image, mixed_layers, emitted_output_mode) = if !effectively_blank
        && pale_bilevel_collapse(&binary, pale_tonal_structure)
    {
        conservation_warnings.push(format!(
                "Black-and-white rendering left source page {} ({}) empty although the leaf carries structure; the grayscale rendition was emitted instead",
                source_page_index + 1,
                page_half_label(half)
            ));
        let fallback = if pale_tonal_structure {
            rendered_source_gray
        } else {
            rendered_gray
        };
        let CollapsedGrayscaleOutput {
            image,
            mixed_layers,
        } = collapsed_grayscale_output(CollapsedGrayscaleInput {
            fallback,
            removed_edge_bands: &fold_removed_edge_bands,
            half,
            split,
            unowned_fold_edge_blank_leaf,
            create_mixed_layers,
        });
        (
            CleanupRaster::Gray(image),
            mixed_layers,
            OutputMode::Grayscale,
        )
    } else {
        (CleanupRaster::Bilevel(binary), None, OutputMode::Mixed)
    };
    MixedProcessingOutput {
        image,
        color_image: None,
        binarization_mode: Some(mode),
        binarization_diagnostics: Some(diagnostics),
        despeckle_fallback,
        mixed_layers,
        emitted_output_mode,
        conservation_warnings,
    }
}

fn process_mixed_output(input: MixedProcessingInput<'_>) -> MixedProcessingOutput {
    if input
        .rendered_picture_mask
        .as_ref()
        .is_none_or(|picture_mask| picture_mask.count_black() == 0)
    {
        return process_mixed_without_picture(input);
    }
    let MixedProcessingInput {
        rendered_gray,
        rendered_source_gray,
        rendered_color,
        rendered_picture_mask,
        rendered_chroma_picture_mask,
        rendered_text_vicinity_mask,
        rendered_text_mask,
        rendered_trusted_foreground_mask,
        canonical_routing_sample,
        options,
        spread_plan,
        calibration,
        ink_ownership_mask,
        source_page_index,
        half,
        split,
        region,
        render_plan,
        source_content_box,
        fold_edge_blank_leaf,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        create_mixed_layers,
        create_mixed_composite,
        deskew,
        effective_dewarp,
        timings,
        ..
    } = input;
    let mut conservation_warnings = Vec::new();
    let emitted_output_mode = OutputMode::Mixed;
    let picture_mask = rendered_picture_mask
        .as_ref()
        .expect("mixed output prepares a picture mask");
    let (
        image,
        color_image,
        binarization_mode,
        binarization_diagnostics,
        despeckle_fallback,
        mixed_layers,
    ) = {
        // Mixed pages are uncommon and their picture-excluding route is
        // resolved inside the binarizer. Keep a geometry-matched raw
        // tone field available so a global route preserves the scan's
        // original glyph boundary. Adaptive routes ignore this field.
        let global_threshold_source = &rendered_source_gray;
        let routing_diagnostics = spread_plan.map_or_else(
            || resolve_binarization_diagnostics(canonical_routing_sample, options),
            |plan| plan.diagnostics(),
        );
        let binarization_started = Instant::now();
        let (binary, diagnostics, despeckle_fallback, stage_timings) =
            binarize_normalized_with_diagnostics_excluding(
                &rendered_gray,
                &rendered_source_gray,
                routing_diagnostics,
                Some(global_threshold_source),
                options,
                calibration,
                picture_mask,
                rendered_text_vicinity_mask.as_ref(),
                spread_plan,
            );
        timings.threshold_preparation_ms += stage_timings.preparation_ms;
        timings.thresholding_ms += stage_timings.thresholding_ms;
        timings.binary_postprocess_ms += stage_timings.postprocess_ms;
        timings.binarization_ms += binarization_started.elapsed().as_secs_f64() * 1_000.0;
        let mode = diagnostics.route;
        let composition_started = Instant::now();
        // Semantic text recall may not reclaim pixels that the
        // representation has already assigned to a picture or an
        // independent-chroma plate. Red seals and map fills can
        // look text-like; OR-ing the raw text mask here painted
        // them into the black stencil and then whitened them out
        // of the continuous-tone background.
        // One recall mask serves both representations. The stencil
        // unions it below; soft-alpha composition takes its text
        // ownership and per-pixel trust from the same mask. Handing
        // the raw evidence to either one puts the coarse-grid halo
        // back on the page by a different route.
        let text_recall = rendered_text_mask
            .as_ref()
            .map(|text_mask| unowned_text_recall(&text_mask.subtract(picture_mask), &binary));
        let mut binary = text_recall
            .as_ref()
            .map_or(binary.clone(), |recall| binary.or(recall));
        if matches!(
            options.binarization,
            crate::BinarizationMode::Auto | crate::BinarizationMode::Otsu
        ) {
            binary = binary.or(&rescue_isolated_raw_ink(
                &rendered_source_gray,
                picture_mask,
                options.dpi,
            ));
        }
        let conservative = binary.clone();
        let (binary, removed_edge_bands) = suppress_scanner_edge_bands(
            &binary,
            &rendered_gray,
            picture_mask,
            rendered_text_mask.as_ref(),
            options.dpi,
        );
        let binary = restore_genuine_horizontal_rules(
            &binary,
            &rendered_source_gray,
            Some(picture_mask),
            rendered_text_mask.as_ref(),
            rendered_text_vicinity_mask.as_ref(),
            options.dpi,
        );
        let binary = filter_soft_shallow_bleed_components(
            &binary,
            &rendered_source_gray,
            Some(picture_mask),
            rendered_text_mask.as_ref(),
            rendered_text_vicinity_mask.as_ref(),
            options.dpi,
        );
        // Producer MRC selections are excellent glyph evidence,
        // but they can also contain dark samples from photographs
        // and reliefs. The Mixed partition is authoritative: a
        // trusted selection may restore text only outside the
        // calibrated continuous-tone ownership mask.
        let trusted_text_foreground =
            trusted_mixed_foreground(rendered_trusted_foreground_mask.as_ref(), picture_mask);
        let binary = enforce_source_ink_support(
            binary,
            &rendered_source_gray,
            trusted_text_foreground.as_ref(),
            options.source_has_bilevel_layer && !options.trusted_selection_incomplete,
            options.dpi,
        );
        // Restoring the pre-suppression stencil also has to restore
        // the bands it removed: composition whitens them out of the
        // background layer, which would delete the very ink the
        // guard just decided to keep.
        let (binary, conserved) = conserve_page_ink(
            conservative,
            binary,
            ink_ownership_mask.as_ref(),
            source_page_index,
            half,
            &mut conservation_warnings,
        );
        let fold_output = fold_edge_filtering::run(fold_edge_filtering::Input {
            binary: &binary,
            picture_mask: Some(picture_mask),
            text_mask: rendered_text_mask.as_ref(),
            text_vicinity_mask: rendered_text_vicinity_mask.as_ref(),
            half,
            split,
            region,
            render_plan,
            source_content_box,
            blank_leaf: fold_edge_blank_leaf,
            dpi: options.dpi,
        });
        let binary = fold_output.kept;
        let fold_removed_edge_bands = fold_output.removed;
        let removed_edge_bands = if !conserved {
            Some(removed_edge_bands.or(&fold_removed_edge_bands))
        } else if fold_removed_edge_bands.count_black() > 0 {
            Some(fold_removed_edge_bands)
        } else {
            None
        };
        let reuse_source_mrc_foreground = can_reuse_source_mrc_foreground(
            options,
            rendered_trusted_foreground_mask.as_ref(),
            picture_mask,
            split,
            half,
            deskew.accepted && deskew.angle_degrees.abs() > f64::EPSILON,
            effective_dewarp,
            create_mixed_layers,
        );
        let final_output = final_composition::run(final_composition::Input {
            gray: &rendered_gray,
            raw_gray: Some(&rendered_source_gray),
            color: rendered_color.as_ref(),
            binary: &binary,
            picture_mask,
            chroma_picture_mask: rendered_chroma_picture_mask.as_ref(),
            removed_edge_bands: removed_edge_bands.as_ref(),
            text_mask: text_recall.as_ref(),
            text_vicinity_mask: rendered_text_vicinity_mask.as_ref(),
            dpi: options.dpi,
            preserve_confirmed_photo_tones,
            use_soft_alpha_foreground,
            create_layers: create_mixed_layers,
            create_composite: create_mixed_composite,
        });
        let mixed_gray = final_output.gray;
        let mixed_color = final_output.color;
        let layers = final_output.mixed_layers;
        let layers = layers.map(|mut layers| {
            layers.source_mrc = reuse_source_mrc_foreground;
            layers
        });
        timings.mixed_composition_ms += composition_started.elapsed().as_secs_f64() * 1_000.0;
        (
            CleanupRaster::Gray(mixed_gray),
            mixed_color,
            Some(mode),
            Some(diagnostics),
            despeckle_fallback,
            layers,
        )
    };
    MixedProcessingOutput {
        image,
        color_image,
        binarization_mode,
        binarization_diagnostics,
        despeckle_fallback,
        mixed_layers,
        emitted_output_mode,
        conservation_warnings,
    }
}
struct ContinuousOutputInput {
    output_mode: OutputMode,
    rendered_gray: GrayImage,
    rendered_color: Option<RgbImage>,
    rendered_width: usize,
    rendered_height: usize,
    create_mixed_layers: bool,
}

struct ContinuousOutputOutput {
    image: CleanupRaster,
    color_image: Option<RgbImage>,
    mixed_layers: Option<MixedLayers>,
}

fn process_continuous_output(input: ContinuousOutputInput) -> ContinuousOutputOutput {
    let ContinuousOutputInput {
        output_mode,
        rendered_gray,
        rendered_color,
        rendered_width,
        rendered_height,
        create_mixed_layers,
    } = input;
    let color_layers = if output_mode == OutputMode::Color && create_mixed_layers {
        rendered_color.as_ref().map(|color| MixedLayers {
            // A fresh Color page has no separate ink owner.
            // Publishing an empty stencil beside the fresh color raster lets
            // the assembler use its compact layered JPEG handoff without
            // implying source-layer identity.
            foreground_mask: BinaryImage::new(rendered_width, rendered_height),
            foreground_alpha: None,
            background: rendered_gray.clone(),
            color_background: Some(color.clone()),
            source_mrc: false,
        })
    } else {
        None
    };
    ContinuousOutputOutput {
        image: CleanupRaster::Gray(rendered_gray),
        color_image: if output_mode == OutputMode::Color {
            rendered_color
        } else {
            None
        },
        mixed_layers: color_layers,
    }
}

struct PayloadCropInput {
    image: CleanupRaster,
    color_image: Option<RgbImage>,
    picture_mask: Option<BinaryImage>,
    tone_alpha: Option<GrayImage>,
    mixed_layers: Option<MixedLayers>,
    render_region: Option<Rect>,
    sampled_region: Option<Rect>,
}

struct PayloadCropOutput {
    image: CleanupRaster,
    color_image: Option<RgbImage>,
    picture_mask: Option<BinaryImage>,
    tone_alpha: Option<GrayImage>,
    mixed_layers: Option<MixedLayers>,
}

fn apply_payload_crop(input: PayloadCropInput) -> PayloadCropOutput {
    let PayloadCropInput {
        mut image,
        mut color_image,
        mut picture_mask,
        mut tone_alpha,
        mut mixed_layers,
        render_region,
        sampled_region,
    } = input;
    if let (Some(requested), Some(sampled)) = (render_region, sampled_region) {
        let payload_rect = Rect::new(
            requested.x - sampled.x,
            requested.y - sampled.y,
            requested.width,
            requested.height,
        );
        image = image.cropped(payload_rect);
        color_image = color_image.map(|source| crop_rgb(&source, payload_rect));
        picture_mask = picture_mask.map(|mask| crop_binary(&mask, payload_rect));
        tone_alpha = tone_alpha.map(|alpha| crop_gray(&alpha, payload_rect));
        mixed_layers = mixed_layers.map(|layers| MixedLayers {
            foreground_mask: crop_binary(&layers.foreground_mask, payload_rect),
            foreground_alpha: layers
                .foreground_alpha
                .map(|alpha| crop_gray(&alpha, payload_rect)),
            background: crop_gray(&layers.background, payload_rect),
            color_background: layers
                .color_background
                .map(|source| crop_rgb(&source, payload_rect)),
            source_mrc: layers.source_mrc,
        });
    }
    PayloadCropOutput {
        image,
        color_image,
        picture_mask,
        tone_alpha,
        mixed_layers,
    }
}

pub(crate) struct RegionSemanticOutput {
    pub(crate) image: CleanupRaster,
    pub(crate) color_image: Option<RgbImage>,
    pub(crate) picture_mask: Option<BinaryImage>,
    pub(crate) tone_preservation_alpha: Option<GrayImage>,
    pub(crate) mixed_layers: Option<MixedLayers>,
    pub(crate) effectively_blank: bool,
    pub(crate) metadata: CleanupMetadata,
}

pub(crate) fn run(input: Input<'_>) -> Result<RegionSemanticOutput, super::AnalysisError> {
    let Input {
        source,
        routing_source,
        normalized,
        analysis_normalized,
        analysis_scale_x,
        analysis_scale_y,
        canonical_routing_sample,
        canonical_leaf_source,
        canonical_routing_dpi,
        calibration,
        color_source,
        analysis_picture_mask,
        source_picture_mask,
        halftone_zone_mask,
        spatial_tone_mask,
        chroma_picture_mask,
        tone_picture_mask,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        tone_preservation_alpha,
        text_mask,
        text_vicinity_mask,
        trusted_foreground_mask,
        options,
        source_page_index,
        split,
        spread_plan,
        region,
        half,
        cache,
        split_cache_key,
        source_effectively_blank,
        create_mixed_layers,
        create_mixed_composite,
        timings,
    } = input;
    let working_width = region.width.round().max(1.0) as usize;
    let working_height = region.height.round().max(1.0) as usize;
    let region_preparation = region_preparation::prepare(region_preparation::Input {
        analysis_normalized,
        analysis_scale_x,
        analysis_scale_y,
        analysis_picture_mask,
        tone_picture_mask,
        text_mask,
        text_vicinity_mask,
        options,
        half,
        region,
        working_width,
        working_height,
    });
    let region_preparation::Output {
        analysis_working,
        analysis_picture_working,
        manual_picture_crop_authority,
        text_tone_diagnostics,
        local_scale_x,
        local_scale_y,
    } = region_preparation;
    let TransformPreparationOutput {
        deskew_key,
        deskew,
        local_deskew_forward,
        local_deskew_inverse,
        automatic_dewarp,
        deskewed_analysis,
        deskewed_picture_mask,
        deskewed_manual_picture_crop_authority,
        dewarp_model,
        effective_dewarp,
        dewarped_analysis,
        dewarped_picture_mask,
        dewarped_manual_picture_crop_authority,
    } = prepare_region_transforms(TransformPreparationInput {
        analysis_working,
        analysis_picture_working,
        manual_picture_crop_authority,
        options,
        half,
        region,
        working_width,
        working_height,
        local_scale_x,
        local_scale_y,
        calibration,
        cache,
        split_cache_key,
        timings,
    })?;
    let content_analysis = dewarped_analysis.as_ref().unwrap_or(&deskewed_analysis);
    let content_picture_mask = dewarped_picture_mask
        .as_ref()
        .or(deskewed_picture_mask.as_ref());
    let manual_picture_crop_authority = dewarped_manual_picture_crop_authority
        .as_ref()
        .or(deskewed_manual_picture_crop_authority.as_ref());
    let detected = detect_region_content(ContentDetectionInput {
        content_analysis,
        content_picture_mask,
        manual_picture_crop_authority,
        normalized,
        options,
        source_effectively_blank,
        cache,
        deskew_key: deskew_key.as_ref(),
        source_page_index,
        calibration,
        local_scale_x,
        local_scale_y,
        working_width,
        working_height,
        routing_source,
        region,
        local_deskew_forward,
        local_deskew_inverse,
        dewarp_model: dewarp_model.as_ref(),
        half,
        timings,
    })?;
    let RenderGeometryOutput {
        content,
        source_content_box,
        content_diagnostics,
        crop_enabled,
        output_rect,
        output_width,
        output_height,
        render_region,
        sampled_region,
        render_plan,
        rendered_width,
        rendered_height,
    } = plan_render_geometry(RenderGeometryInput {
        detected,
        options,
        region,
        working_width,
        working_height,
        local_deskew_forward,
        local_deskew_inverse,
        dewarp_model: dewarp_model.clone(),
    })?;

    let render_started = Instant::now();
    let RasterPlaneOutput {
        rendered_gray,
        rendered_color,
        rendered_source_gray,
        rendered_tone_alpha,
        forward_transform,
        inverse_transform,
        dewarp_mapping,
    } = prepare_render_planes(RasterPlaneInput {
        normalized,
        routing_source,
        color_source,
        source_picture_mask,
        tone_preservation_alpha,
        text_tone_diagnostics,
        options,
        preserve_confirmed_photo_tones,
        working_width,
        working_height,
        render_region,
        sampled_region,
        output_rect,
        render_plan: &render_plan,
        rendered_width,
        rendered_height,
        region,
        local_deskew_forward,
        local_deskew_inverse,
        dewarp_model,
        timings,
    })?;
    let MaskPreparationOutput {
        rendered_picture_mask,
        rendered_chroma_picture_mask,
        rendered_text_vicinity_mask,
        rendered_text_mask,
        rendered_trusted_foreground_mask,
    } = prepare_region_masks(MaskPreparationInput {
        normalized,
        render_plan: &render_plan,
        rendered_width,
        rendered_height,
        source_picture_mask,
        halftone_zone_mask,
        spatial_tone_mask,
        chroma_picture_mask,
        tone_picture_mask,
        text_vicinity_mask,
        text_mask,
        trusted_foreground_mask,
        options,
        preserve_confirmed_photo_tones,
        text_line_count: text_tone_diagnostics.map_or(0, |diagnostics| diagnostics.text_line_count),
        timings,
    });
    let content_present = content.content.is_some();
    process_region_output(OutputProcessingInput {
        rendered_gray,
        rendered_source_gray,
        rendered_color,
        rendered_picture_mask,
        rendered_chroma_picture_mask,
        rendered_text_vicinity_mask,
        rendered_text_mask,
        rendered_trusted_foreground_mask,
        rendered_tone_alpha,
        canonical_routing_sample,
        options,
        spread_plan,
        calibration,
        source_page_index,
        half,
        split,
        region,
        render_plan: &render_plan,
        source_content_box,
        crop_enabled,
        deskew,
        effective_dewarp,
        automatic_dewarp,
        content,
        content_diagnostics,
        output_rect,
        render_region,
        sampled_region,
        text_tone_diagnostics,
        forward_transform,
        inverse_transform,
        dewarp_mapping,
        output_width,
        output_height,
        source,
        render_started,
        timings,
        create_mixed_layers,
        create_mixed_composite,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        canonical_leaf_source,
        canonical_routing_dpi,
        content_present,
        force_clean_blank: source_effectively_blank,
        normalized_width: normalized.width(),
        normalized_height: normalized.height(),
    })
}

#[cfg(test)]
#[path = "region_rendering_tests.rs"]
mod tests;
