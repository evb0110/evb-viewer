//! Typed handoff for document analysis and priors.

use super::*;
use crate::background::IlluminationPreparation;
use crate::protocol::manifest_v3::ContentBlockEvidence;

pub(crate) struct PageAnalysisInput<'a, 'p> {
    pub source: &'a GrayImage,
    pub color_source: Option<&'a RgbImage>,
    pub options: &'a CleanupOptions,
    pub document_prior: Option<DocumentPrior>,
    pub recommend_output_mode: bool,
    pub plan_content: bool,
    pub cache: Option<&'a PageCache>,
    pub timings: &'a mut PageStageTimings,
    pub cancellation: Option<&'p AtomicBool>,
}

pub(crate) fn analyze_page(
    input: PageAnalysisInput<'_, '_>,
) -> Result<PageAnalysisResult, super::AnalysisError> {
    let PageAnalysisInput {
        source,
        color_source,
        options,
        document_prior,
        recommend_output_mode,
        plan_content,
        cache,
        timings,
        cancellation,
    } = input;
    options.validate()?;
    if options.excluded {
        return Ok(PageAnalysisResult {
            outputs: Vec::new(),
            classification: LayoutClassification::SingleUncutPage,
            confidence: 1.0,
            cutter_x: None,
            split_seam: None,
            excluded: true,
            rotation: options.rotation,
            reconciliation: ReconciliationMetadata {
                tier1_verdict: LayoutClassification::SingleUncutPage,
                reconciled: false,
                cluster_agreement: 0.0,
            },
            split_diagnostics: SplitDiagnostics::default(),
            rotated_width: source.width(),
            rotated_height: source.height(),
            calibration_stroke_width_px: None,
            calibration_x_height_px: None,
            candidate_cutter_ratio: None,
            whitespace_score: 0.0,
            text_axis: None,
            output_mode_recommendation: None,
        });
    }
    let prepared = document_analysis::run(document_analysis::Input {
        source,
        color_source,
        options,
        prepare_quality_raster: plan_content,
        render_policy: PageRenderPolicy {
            create_mixed_layers: false,
            create_mixed_composite: false,
            recommend_output_mode,
            analyze_layout: true,
            cancellation,
        },
        document_prior,
        calibration_config: CalibrationConfig::default(),
        cache,
        trusted_mrc_background: None,
        timings,
    })?;
    let mut split = prepared.split;
    let needs_raw_gutter_remeasurement = gutter_band_needs_raw_remeasurement(&split);
    if plan_content
        && split.classification == LayoutClassification::TwoPageSpread
        && needs_raw_gutter_remeasurement
    {
        // Analysis geometry is published before the final cleanup pass. Use
        // the rotated full-resolution source here as well, otherwise the
        // final renderer can discover the right edge only after the analyze
        // pass has already fixed both leaf origins at the cutter.
        let raw_source = rotate_orthogonal(source, options.rotation);
        split.remeasure_gutter_band_from_source(
            &raw_source,
            raw_source.width(),
            raw_source.height(),
        );
    }
    if !plan_content {
        return Ok(PageAnalysisResult {
            outputs: Vec::new(),
            classification: split.classification,
            confidence: split.confidence,
            cutter_x: split.cutter_x,
            split_seam: split.split_seam,
            excluded: false,
            rotation: options.rotation,
            reconciliation: split.reconciliation,
            split_diagnostics: split.diagnostics,
            rotated_width: prepared.full_width,
            rotated_height: prepared.full_height,
            calibration_stroke_width_px: prepared
                .calibration
                .valid
                .then_some(prepared.calibration.stroke_width_px),
            calibration_x_height_px: prepared
                .calibration
                .valid
                .then_some(prepared.calibration.x_height_px),
            candidate_cutter_ratio: prepared.candidate_cutter_ratio,
            whitespace_score: prepared.whitespace_score,
            text_axis: prepared.text_axis,
            output_mode_recommendation: prepared.output_mode_recommendation,
        });
    }
    let support_source = match options.rotation {
        OrthogonalRotation::None => Cow::Borrowed(source),
        rotation => Cow::Owned(rotate_orthogonal(source, rotation)),
    };
    let content_started = Instant::now();
    let manual_picture_crop_authority = manual_picture_crop_authority(
        options,
        prepared.normalized.width(),
        prepared.normalized.height(),
    );
    let outputs = output_regions(
        prepared.full_width,
        prepared.full_height,
        &split,
        options.layout,
    )
    .into_iter()
    .map(|(region, half)| {
        let analysis_region = Rect::new(
            region.x * prepared.scale_x,
            region.y * prepared.scale_y,
            region.width * prepared.scale_x,
            region.height * prepared.scale_y,
        );
        let working = crop_gray(&prepared.normalized, analysis_region);
        let text_tone_diagnostics =
            if prepared.resolved_output_mode == ResolvedOutputMode::Grayscale {
                prepared
                    .text_mask
                    .as_ref()
                    .zip(prepared.text_vicinity_mask.as_ref())
                    .map(|(text_mask, text_vicinity_mask)| {
                        let picture_mask = prepared
                            .picture_mask
                            .as_ref()
                            .map(|mask| crop_binary(mask, analysis_region))
                            .unwrap_or_else(|| BinaryImage::new(working.width(), working.height()));
                        derive_text_tone_diagnostics(
                            &working,
                            &crop_binary(text_mask, analysis_region),
                            &crop_binary(text_vicinity_mask, analysis_region),
                            &picture_mask,
                        )
                    })
            } else {
                None
            };
        let content_picture_mask = prepared
            .content_picture_mask
            .as_ref()
            .map(|mask| crop_binary(mask, analysis_region));
        let manual_picture_crop_authority = manual_picture_crop_authority
            .as_ref()
            .map(|mask| crop_binary(mask, analysis_region));
        let (detected_content, content_diagnostics) = if let Some(manual) =
            options.resolved_content_for(half, prepared.full_width, prepared.full_height)
        {
            let left = manual.x.clamp(0.0, region.width.max(1.0) - 1.0);
            let top = manual.y.clamp(0.0, region.height.max(1.0) - 1.0);
            let right = manual.right().clamp(left + 1.0, region.width);
            let bottom = manual.bottom().clamp(top + 1.0, region.height);
            (Some(Rect::new(left, top, right - left, bottom - top)), None)
        } else {
            let detected = detect_content_and_margins_calibrated_with_crop_authority(
                &working,
                content_picture_mask.as_ref(),
                manual_picture_crop_authority.as_ref(),
                prepared.calibration.effective_dpi,
                None,
                Some([0.0; 4]),
                prepared.calibration,
            );
            let content = detected.content.map(|content| {
                map_analysis_rect_to_source_support(
                    content,
                    prepared.scale_x,
                    prepared.scale_y,
                    region.width,
                    region.height,
                    SourceContentSupport::Rectilinear {
                        image: &support_source,
                        to_source: Affine::translation(region.x, region.y),
                    },
                )
            });
            (content, detected.diagnostics)
        };
        if options.match_page_size {
            // Matched margins are composed on the final document grid, but
            // their untrusted request geometry still has to pass the same
            // finite-arithmetic checks before the engine omits them here.
            content_result_for_dimensions(
                region.width.ceil().max(1.0) as usize,
                region.height.ceil().max(1.0) as usize,
                options.dpi,
                detected_content,
                options.margins_mm.map(crate::MarginsMm::values),
                options.margins_pixels,
            )?;
        }
        let content = content_result_for_dimensions(
            region.width.ceil().max(1.0) as usize,
            region.height.ceil().max(1.0) as usize,
            options.dpi,
            detected_content,
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
        options.validate_derived_raster_dimensions(
            content.output_rect.width,
            content.output_rect.height,
        )?;
        let crop_enabled = options.crop_content && content.content.is_some();
        let local_crop = if crop_enabled {
            content.output_rect
        } else {
            Rect::new(0.0, 0.0, region.width, region.height)
        };
        Ok(AnalysisOutputMetadata {
            half,
            source_region: region,
            content_box: content.content,
            content_diagnostics,
            text_tone_diagnostics,
            crop_rect: Rect::new(
                region.x + local_crop.x,
                region.y + local_crop.y,
                local_crop.width,
                local_crop.height,
            ),
            applied_margins: if crop_enabled {
                content.margins
            } else {
                [0.0; 4]
            }
            .into(),
            input_width: source.width(),
            input_height: source.height(),
            pdf_placement: None,
        })
    })
    .collect::<Result<Vec<_>, AnalysisError>>()?;
    timings.content_ms += content_started.elapsed().as_secs_f64() * 1_000.0;
    Ok(PageAnalysisResult {
        outputs,
        classification: split.classification,
        confidence: split.confidence,
        cutter_x: split.cutter_x,
        split_seam: split.split_seam,
        excluded: false,
        rotation: options.rotation,
        reconciliation: split.reconciliation,
        split_diagnostics: split.diagnostics,
        rotated_width: prepared.full_width,
        rotated_height: prepared.full_height,
        calibration_stroke_width_px: prepared
            .calibration
            .valid
            .then_some(prepared.calibration.stroke_width_px),
        calibration_x_height_px: prepared
            .calibration
            .valid
            .then_some(prepared.calibration.x_height_px),
        candidate_cutter_ratio: prepared.candidate_cutter_ratio,
        whitespace_score: prepared.whitespace_score,
        text_axis: prepared.text_axis,
        output_mode_recommendation: prepared.output_mode_recommendation,
    })
}

pub(crate) struct Input<'a, 'p> {
    pub source: &'a GrayImage,
    pub color_source: Option<&'a RgbImage>,
    pub options: &'a CleanupOptions,
    pub prepare_quality_raster: bool,
    pub render_policy: PageRenderPolicy<'p>,
    pub document_prior: Option<DocumentPrior>,
    pub calibration_config: CalibrationConfig,
    pub cache: Option<&'a PageCache>,
    pub trusted_mrc_background: Option<&'a GrayImage>,
    pub timings: &'a mut PageStageTimings,
}

#[allow(clippy::too_many_arguments)]
fn prepare_analysis_page_impl(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    prepare_quality_raster: bool,
    render_policy: PageRenderPolicy<'_>,
    document_prior: Option<DocumentPrior>,
    calibration_config: CalibrationConfig,
    cache: Option<&PageCache>,
    trusted_mrc_background: Option<&GrayImage>,
    timings: &mut PageStageTimings,
) -> Result<PreparedAnalysis, super::AnalysisError> {
    render_policy.check_canceled()?;
    debug_assert!(
        render_policy.analyze_layout
            || matches!(options.layout, crate::LayoutMode::Single) && !options.has_split_evidence(),
        "skipping layout analysis requires an already-resolved single-region layout",
    );
    let analysis_key = cache.map(|cache| {
        StageCacheKey::analysis(
            &cache.source,
            options,
            prepare_quality_raster,
            render_policy.recommend_output_mode,
            render_policy.analyze_layout,
            render_policy.create_mixed_layers,
            calibration_config,
        )
    });
    let cached_analysis = cache
        .zip(analysis_key.as_ref())
        .and_then(|(cache, key)| cache.shared.lock().ok()?.get::<AnalysisArtifact>(key));
    let analysis = cached_analysis.unwrap_or_else(|| {
        build_analysis_artifact(ArtifactInput {
            analysis_key: analysis_key.clone(),
            source,
            color_source,
            options,
            prepare_quality_raster,
            render_policy,
            calibration_config,
            cache,
            trusted_mrc_background,
            timings,
        })
    });
    render_policy.check_canceled()?;
    let applicable_prior = document_prior
        .filter(|prior| prior.applies_to_dimensions(analysis.full_width, analysis.full_height));
    let split_key = cache.map(|cache| {
        StageCacheKey::split(
            &cache.source,
            options,
            prepare_quality_raster,
            render_policy.recommend_output_mode,
            render_policy.analyze_layout,
            render_policy.create_mixed_layers,
            calibration_config,
            document_prior,
        )
    });
    render_policy.check_canceled()?;
    let cached_split = cache
        .zip(split_key.as_ref())
        .and_then(|(cache, key)| cache.shared.lock().ok()?.get::<SplitResult>(key));
    let split_started = Instant::now();
    let analysis_threshold = analysis.analysis_threshold;
    let text_axis = analysis.text_axis;
    let split = cached_split.as_deref().cloned().unwrap_or_else(|| {
        let mut split_is_full_resolution = false;
        let mut split = match analysis_threshold {
            None => crate::split::single_page(
                analysis.layout_normalized.width(),
                analysis.layout_normalized.height(),
            ),
            Some(analysis_threshold) if options.ocr_mode => {
                detect_split_at_analysis_level_with_threshold(
                    &analysis.layout_normalized,
                    analysis.effective_dpi,
                    crate::LayoutMode::Single,
                    None,
                    analysis_threshold,
                    None,
                )
            }
            Some(analysis_threshold) => detect_split_at_analysis_level_with_threshold(
                &analysis.layout_normalized,
                analysis.effective_dpi,
                options.layout,
                options.resolved_split_x(analysis.normalized.width()),
                analysis_threshold,
                applicable_prior,
            ),
        };
        if matches!(options.layout, crate::LayoutMode::Auto) && !options.has_split_evidence() {
            if let Some(prior) = applicable_prior {
                split.apply_document_prior(
                    analysis.normalized.width(),
                    analysis.normalized.height(),
                    prior.with_cluster_dimensions(
                        analysis.normalized.width(),
                        analysis.normalized.height(),
                    ),
                );
            }
        }
        if prepare_quality_raster && options.normalize_illumination {
            split.reusable_binary = None;
        }
        if (analysis.scale_x < 1.0
            || analysis.scale_y < 1.0
            || analysis.effective_dpi < SPLIT_ANALYSIS_DPI)
            && matches!(options.layout, crate::LayoutMode::Auto)
            && !options.has_split_evidence()
        {
            let resolution_limited_populated_offcut = split.classification
                == LayoutClassification::PageWithOffcut
                && split.diagnostics.offcut_empty_score < 0.95
                && split.diagnostics.offcut_populated_score >= 0.80;
            split.abstain_from_resolution_limited_offcut();
            // A populated strip cannot use the empty-strip bypass above. If
            // the bounded raster found one, confirm it independently on the
            // full source rather than either trusting or discarding a
            // resolution-limited decision. This path is intentionally cold:
            // ordinary single pages and strongly empty offcuts never allocate
            // or analyze the full-resolution layout plane here.
            if resolution_limited_populated_offcut
                && split.classification == LayoutClassification::SingleUncutPage
            {
                let full_layout = match options.rotation {
                    OrthogonalRotation::None => Cow::Borrowed(source),
                    rotation => Cow::Owned(rotate_orthogonal(source, rotation)),
                };
                let full_threshold = otsu_threshold(&full_layout);
                let confirmed = detect_split_at_analysis_level_with_threshold(
                    &full_layout,
                    options.dpi,
                    options.layout,
                    None,
                    full_threshold,
                    applicable_prior,
                );
                if confirmed.classification == LayoutClassification::PageWithOffcut {
                    split = confirmed;
                    split_is_full_resolution = true;
                }
            }
        }
        if !split_is_full_resolution {
            scale_split_result(
                &mut split,
                analysis.scale_x,
                analysis.scale_y,
                analysis.full_width,
                analysis.full_height,
            );
        }
        if let (Some(cache), Some(key)) = (cache, split_key.clone()) {
            let value = Arc::new(split.clone());
            let bytes = split_result_bytes(&value);
            if let Ok(mut shared) = cache.shared.lock() {
                shared.insert(key, value, bytes);
            }
        }
        split
    });
    timings.split_ms += split_started.elapsed().as_secs_f64() * 1_000.0;
    let candidate_cutter_ratio = (split.diagnostics.decision_x > 0.0)
        .then_some(split.diagnostics.decision_x / analysis.normalized.width().max(1) as f64);
    let whitespace_score = split.diagnostics.whitespace_score;
    Ok(PreparedAnalysis {
        normalized: Arc::clone(&analysis.normalized),
        canonical_routing_source: Arc::clone(&analysis.canonical_routing_source),
        split,
        scale_x: analysis.scale_x,
        scale_y: analysis.scale_y,
        full_width: analysis.full_width,
        full_height: analysis.full_height,
        calibration: analysis.calibration,
        canonical_routing_dpi: analysis.canonical_routing_dpi,
        candidate_cutter_ratio,
        whitespace_score,
        text_axis,
        content_picture_mask: analysis.content_picture_mask.clone(),
        picture_mask: analysis.picture_mask.clone(),
        halftone_zone_mask: analysis.halftone_zone_mask.clone(),
        spatial_tone_mask: analysis.spatial_tone_mask.clone(),
        chroma_picture_mask: analysis.chroma_picture_mask.clone(),
        tonal_protection_mask: analysis.tonal_protection_mask.clone(),
        semantic_preservation_alpha: analysis.semantic_preservation_alpha.clone(),
        photo_preservation_alpha: analysis.photo_preservation_alpha.clone(),
        tone_preservation_alpha: analysis.tone_preservation_alpha.clone(),
        text_mask: analysis.text_mask.clone(),
        text_vicinity_mask: analysis.text_vicinity_mask.clone(),
        split_cache_key: split_key,
        source_effectively_blank: analysis.source_effectively_blank,
        output_mode_recommendation: analysis.output_mode_recommendation,
        preserve_confirmed_photo_tones: analysis.preserve_confirmed_photo_tones,
        use_soft_alpha_foreground: analysis.use_soft_alpha_foreground,
        resolved_output_mode: analysis.resolved_output_mode,
    })
}

struct ArtifactInput<'a, 'p> {
    analysis_key: Option<StageCacheKey>,
    source: &'a GrayImage,
    color_source: Option<&'a RgbImage>,
    options: &'a CleanupOptions,
    prepare_quality_raster: bool,
    render_policy: PageRenderPolicy<'p>,
    calibration_config: CalibrationConfig,
    cache: Option<&'a PageCache>,
    trusted_mrc_background: Option<&'a GrayImage>,
    timings: &'a mut PageStageTimings,
}

struct AnalysisPlaneInput<'a> {
    source: &'a GrayImage,
    color_source: Option<&'a RgbImage>,
    options: &'a CleanupOptions,
    timings: &'a mut PageStageTimings,
}

struct AnalysisPlaneOutput {
    effective_dpi: f64,
    rotated: GrayImage,
    analysis_rgb: Option<RgbImage>,
    full_width: usize,
    full_height: usize,
    scale_x: f64,
    scale_y: f64,
    blank_scan_candidate: bool,
}

fn prepare_analysis_plane(input: AnalysisPlaneInput<'_>) -> AnalysisPlaneOutput {
    let AnalysisPlaneInput {
        source,
        color_source,
        options,
        timings,
    } = input;
    let analysis_started = Instant::now();
    // A compact MRC page has two independent sampling limits: its
    // high-resolution bilevel foreground and its much coarser
    // continuous-tone background. Running semantic tone detection above
    // the latter's native DPI only measures interpolation around the
    // foreground mask. The same page then acquires "new" coherent tone
    // when the PDF rasterizer is asked for a larger final image even
    // though the authored background contains no additional information.
    //
    // Keep every source at the same 150-DPI analysis ceiling. Producer
    // layers are evidence for optional hints, never a mode-resolution
    // override.
    let analysis_dpi_ceiling = 150.0;
    let AnalysisLevel {
        image,
        effective_dpi,
        scale_x: _,
        scale_y: _,
    } = build_analysis_level(source, options.dpi, analysis_dpi_ceiling);
    let rotated = rotate_orthogonal(&image, options.rotation);
    let analysis_rgb = color_source
        .map(|rgb| downscale_rgb_to_dimensions(rgb, image.width(), image.height()))
        .map(|rgb| rotate_rgb_orthogonal(&rgb, options.rotation));
    let (full_width, full_height) = match options.rotation {
        OrthogonalRotation::None | OrthogonalRotation::Clockwise180 => {
            (source.width(), source.height())
        }
        OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270 => {
            (source.height(), source.width())
        }
    };
    let scale_x = rotated.width() as f64 / full_width.max(1) as f64;
    let scale_y = rotated.height() as f64 / full_height.max(1) as f64;
    let blank_scan_candidate = options.manual_content_boxes.is_empty()
        && options.manual_zones.picture.is_empty()
        && options.manual_zones.fill.is_empty()
        && is_blank_scan_candidate(&rotated, analysis_rgb.as_ref());
    timings.analysis_level_ms += analysis_started.elapsed().as_secs_f64() * 1_000.0;
    AnalysisPlaneOutput {
        effective_dpi,
        rotated,
        analysis_rgb,
        full_width,
        full_height,
        scale_x,
        scale_y,
        blank_scan_candidate,
    }
}

struct LayoutPictureEvidenceInput<'a, 'p> {
    rotated: &'a GrayImage,
    effective_dpi: f64,
    full_width: usize,
    full_height: usize,
    blank_scan_candidate: bool,
    render_policy: PageRenderPolicy<'p>,
    calibration_config: CalibrationConfig,
    options: &'a CleanupOptions,
    trusted_mrc_background: Option<&'a GrayImage>,
    timings: &'a mut PageStageTimings,
}

struct LayoutPictureEvidenceOutput {
    illumination_preparation: Option<IlluminationPreparation>,
    layout_normalized: GrayImage,
    calibration: PageCalibration,
    continuous_tone_mask: Option<Arc<BinaryImage>>,
    detected_picture_mask: Option<Arc<BinaryImage>>,
    automatic_picture_mask: Option<Arc<BinaryImage>>,
    picture_mask: Option<Arc<BinaryImage>>,
    trusted_mrc_tone_mask: Option<Arc<BinaryImage>>,
    content_evidence_complete: bool,
    content_picture_mask: Option<Arc<BinaryImage>>,
}

fn prepare_layout_picture_evidence(
    input: LayoutPictureEvidenceInput<'_, '_>,
) -> LayoutPictureEvidenceOutput {
    let LayoutPictureEvidenceInput {
        rotated,
        effective_dpi,
        full_width,
        full_height,
        blank_scan_candidate,
        render_policy,
        calibration_config,
        options,
        trusted_mrc_background,
        timings,
    } = input;
    let illumination_preparation_started = Instant::now();
    let illumination_preparation = options.normalize_illumination.then(|| {
        let preparation = prepare_illumination(rotated);
        timings.illumination_preparation_ms +=
            illumination_preparation_started.elapsed().as_secs_f64() * 1_000.0;
        preparation
    });
    let layout_normalization_started = Instant::now();
    let layout_normalized = if let Some(preparation) = illumination_preparation.as_ref() {
        normalize_illumination_for_layout_prepared(rotated, preparation)
    } else {
        rotated.clone()
    };
    timings.layout_normalization_ms +=
        layout_normalization_started.elapsed().as_secs_f64() * 1_000.0;
    let calibration_started = Instant::now();
    let calibration =
        PageCalibration::estimate(&layout_normalized, effective_dpi, calibration_config);
    timings.calibration_ms += calibration_started.elapsed().as_secs_f64() * 1_000.0;
    let picture_mask_started = Instant::now();
    let continuous_tone_mask = render_policy.analyze_layout.then(|| {
        Arc::new(if blank_scan_candidate {
            BinaryImage::new(rotated.width(), rotated.height())
        } else {
            derive_halftone_zones(rotated, effective_dpi)
        })
    });
    let detected_picture_mask = render_policy.analyze_layout.then(|| {
        let candidate = if blank_scan_candidate {
            BinaryImage::new(rotated.width(), rotated.height())
        } else {
            detect_picture_mask_with_continuous_tone(
                rotated,
                effective_dpi,
                calibration,
                continuous_tone_mask
                    .as_deref()
                    .expect("layout analysis must prepare continuous-tone evidence"),
            )
        };
        // Tone evidence corroborates a candidate; it is not itself a
        // semantic owner. Apply artifact/size vetoes once here so every
        // downstream consumer sees exactly the same vetted owner.
        Arc::new(qualify_picture_owner(rotated, &candidate))
    });
    let automatic_picture_mask = detected_picture_mask.clone();
    let picture_mask = automatic_picture_mask.as_deref().map(|automatic| {
        let mut mask = automatic.clone();
        apply_manual_zones(&mut mask, options);
        Arc::new(mask)
    });
    // Keep producer evidence separate until real text-vicinity geometry is
    // available. A low-resolution MRC background can contain antialiased
    // text ghosts joined to a genuine photo; treating that whole joined
    // component as an owner either swallows text or makes the component
    // veto discard the photo with it.
    // The producer-authored continuous-tone layer is independent evidence
    // of photo ownership. Keep it separate until text geometry is known;
    // the existing flattened-page detector may cover only the darkest
    // lobe of the same photograph.
    let corroborated_picture_owner_pixels = detected_picture_mask
        .as_deref()
        .map_or(0, BinaryImage::count_black);
    let trusted_mrc_tone_mask = trusted_mrc_background
        .filter(|_| options.trusted_mrc_source_available)
        .map(|background| {
            let native_tone =
                detect_continuous_tone_mask(background, options.source_background_dpi());
            let rotated_tone = rotate_binary_orthogonal(&native_tone, options.rotation);
            Arc::new(resample_binary_mask_nearest(
                &rotated_tone,
                rotated.width(),
                rotated.height(),
            ))
        })
        .filter(|mask| mask.count_black() > 0)
        // Producer tone is a recall fallback, not a second classifier.
        // Once the flattened source already has a corroborated owner,
        // letting the lower-resolution background enlarge it changes
        // otherwise-correct photos and can join paper texture to them.
        .filter(|_| corroborated_picture_owner_pixels == 0);
    let content_evidence_complete = match options.layout {
        crate::LayoutMode::Single => options
            .resolved_content_for(PageHalf::Full, full_width, full_height)
            .is_some(),
        crate::LayoutMode::TwoPage => {
            options
                .resolved_content_for(PageHalf::Left, full_width, full_height)
                .is_some()
                && options
                    .resolved_content_for(PageHalf::Right, full_width, full_height)
                    .is_some()
        }
        crate::LayoutMode::KeepLeft => options
            .resolved_content_for(PageHalf::Left, full_width, full_height)
            .is_some(),
        crate::LayoutMode::KeepRight => options
            .resolved_content_for(PageHalf::Right, full_width, full_height)
            .is_some(),
        crate::LayoutMode::Auto | crate::LayoutMode::PageWithOffcut => {
            [PageHalf::Full, PageHalf::Left, PageHalf::Right]
                .into_iter()
                .all(|half| {
                    options
                        .resolved_content_for(half, full_width, full_height)
                        .is_some()
                })
        }
    };
    let content_picture_mask = if options.crop_content && !content_evidence_complete {
        picture_mask
            .as_deref()
            .map(|mask| Arc::new(extend_picture_mask_for_content(rotated, mask, calibration)))
    } else {
        None
    };
    timings.picture_mask_ms += picture_mask_started.elapsed().as_secs_f64() * 1_000.0;

    LayoutPictureEvidenceOutput {
        illumination_preparation,
        layout_normalized,
        calibration,
        continuous_tone_mask,
        detected_picture_mask,
        automatic_picture_mask,
        picture_mask: picture_mask.clone(),
        trusted_mrc_tone_mask,
        content_evidence_complete,
        content_picture_mask,
    }
}

struct TextEvidenceInput<'a, 'p> {
    layout_normalized: &'a GrayImage,
    render_policy: PageRenderPolicy<'p>,
    timings: &'a mut PageStageTimings,
}

struct TextEvidenceOutput {
    analysis_threshold: Option<u8>,
    text_axis: Option<TextAxisHint>,
}

fn prepare_text_evidence(input: TextEvidenceInput<'_, '_>) -> TextEvidenceOutput {
    let TextEvidenceInput {
        layout_normalized,
        render_policy,
        timings,
    } = input;
    let text_axis_started = Instant::now();
    let analysis_threshold = render_policy
        .analyze_layout
        .then(|| otsu_threshold(layout_normalized));
    let text_axis =
        analysis_threshold.and_then(|threshold| detect_text_axis(layout_normalized, threshold));
    timings.text_axis_ms += text_axis_started.elapsed().as_secs_f64() * 1_000.0;

    TextEvidenceOutput {
        analysis_threshold,
        text_axis,
    }
}

struct ContentTextEvidenceInput<'a, 'p> {
    rotated: &'a GrayImage,
    layout_normalized: &'a GrayImage,
    picture_mask: Option<&'a BinaryImage>,
    trusted_mrc_tone_mask: Option<&'a BinaryImage>,
    render_policy: PageRenderPolicy<'p>,
    prepare_quality_raster: bool,
    options: &'a CleanupOptions,
    effective_dpi: f64,
    calibration: PageCalibration,
}

struct ContentTextEvidenceOutput {
    text_line_count: usize,
    protected_text_blocks: Vec<ContentBlockEvidence>,
    text_mask: Option<Arc<BinaryImage>>,
    text_vicinity_mask: Option<Arc<BinaryImage>>,
    trusted_mrc_owned_tone_mask: Option<Arc<BinaryImage>>,
}

fn prepare_content_text_evidence(
    input: ContentTextEvidenceInput<'_, '_>,
) -> ContentTextEvidenceOutput {
    let ContentTextEvidenceInput {
        rotated,
        layout_normalized,
        picture_mask,
        trusted_mrc_tone_mask,
        render_policy,
        prepare_quality_raster,
        options,
        effective_dpi,
        calibration,
    } = input;
    let content_evidence = picture_mask.and_then(|picture_mask| {
        if render_policy.recommend_output_mode
            || (prepare_quality_raster && options.crop_content && options.normalize_illumination)
            || matches!(
                options.output_mode,
                OutputMode::Grayscale | OutputMode::Mixed
            )
        {
            Some(analyze_content_evidence_calibrated(
                layout_normalized,
                Some(picture_mask),
                calibration,
            ))
        } else {
            None
        }
    });
    let text_line_count = content_evidence
        .as_ref()
        .map_or(0, |evidence| evidence.diagnostics.text_mask.line_count);
    let protected_text_blocks = content_evidence.as_ref().map_or_else(Vec::new, |evidence| {
        evidence.diagnostics.protected_blocks.clone()
    });
    let (text_mask, text_vicinity_mask) = content_evidence.map_or((None, None), |evidence| {
        (
            Some(Arc::new(evidence.text_mask)),
            Some(Arc::new(evidence.text_vicinity_mask)),
        )
    });
    let mut trusted_mrc_owned_tone_mask = None;
    if let Some(trusted_tone) = trusted_mrc_tone_mask {
        let carved = carve_trusted_mrc_tone_owner(
            rotated,
            trusted_tone.clone(),
            text_vicinity_mask.as_deref(),
            effective_dpi,
            calibration,
        );
        if carved.count_black() > 0 {
            trusted_mrc_owned_tone_mask = Some(Arc::new(carved));
        }
    }

    ContentTextEvidenceOutput {
        text_line_count,
        protected_text_blocks,
        text_mask,
        text_vicinity_mask,
        trusted_mrc_owned_tone_mask,
    }
}

struct FinalPictureOwnershipInput<'a> {
    rotated: &'a GrayImage,
    automatic_picture_mask: Option<&'a BinaryImage>,
    trusted_mrc_owned_tone_mask: Option<&'a BinaryImage>,
    text_mask: Option<&'a BinaryImage>,
    text_vicinity_mask: Option<&'a BinaryImage>,
    picture_mask: Option<Arc<BinaryImage>>,
    content_picture_mask: Option<Arc<BinaryImage>>,
    options: &'a CleanupOptions,
    effective_dpi: f64,
    calibration: PageCalibration,
    content_evidence_complete: bool,
}

struct FinalPictureOwnershipOutput {
    picture_mask: Option<Arc<BinaryImage>>,
    content_picture_mask: Option<Arc<BinaryImage>>,
}

fn finalize_picture_ownership(
    input: FinalPictureOwnershipInput<'_>,
) -> FinalPictureOwnershipOutput {
    let FinalPictureOwnershipInput {
        rotated,
        automatic_picture_mask,
        trusted_mrc_owned_tone_mask,
        text_mask,
        text_vicinity_mask,
        mut picture_mask,
        mut content_picture_mask,
        options,
        effective_dpi,
        calibration,
        content_evidence_complete,
    } = input;
    // Rectangular photo ownership is inferred only from automatic,
    // corroborated evidence. Explicit painter/eraser zones stay outside
    // the inference and are applied once, last, so an operator override
    // cannot be enlarged and a final eraser cannot be silently undone.
    let automatic_picture_owner = {
        // Flattened-page candidates still pass the ordinary artifact
        // qualifier. Trusted MRC tone has already passed the independent
        // text-component veto and component/span gate above; qualifying
        // that owner a second time as a flattened edge artifact would
        // erase producer-authored ownership before it can reach Mixed
        // composition. Crop geometry remains independent below.
        let qualified_flattened = automatic_picture_mask
            .as_ref()
            .map(|candidate| qualify_picture_owner(rotated, candidate));
        let mut owner = qualified_flattened.as_ref().map_or_else(
            || BinaryImage::new(rotated.width(), rotated.height()),
            Clone::clone,
        );
        if let Some(trusted) = trusted_mrc_owned_tone_mask {
            owner = owner.or(trusted);
        }
        (owner.count_black() > 0).then(|| Arc::new(owner))
    };
    if let Some(automatic) = automatic_picture_owner.as_deref() {
        let empty_text = BinaryImage::new(rotated.width(), rotated.height());
        let rectangular = rectangularize_corroborated_photos(
            rotated,
            automatic,
            text_mask.unwrap_or(&empty_text),
            text_vicinity_mask.unwrap_or(&empty_text),
            effective_dpi,
        );
        let mut final_owner = rectangular;
        apply_manual_zones(&mut final_owner, options);
        // This final manual-zone result is the one semantic owner. Every
        // mode, label, normalization, and composition view below derives
        // from it; rectangularization declining to grow the component
        // cannot revoke source preservation inside the vetted pixels.
        picture_mask = Some(Arc::new(final_owner));
    }
    if options.crop_content && !content_evidence_complete {
        content_picture_mask = picture_mask
            .as_deref()
            .map(|mask| Arc::new(extend_picture_mask_for_content(rotated, mask, calibration)));
    }

    FinalPictureOwnershipOutput {
        picture_mask,
        content_picture_mask,
    }
}

struct TonalEvidenceInput<'a> {
    rotated: &'a GrayImage,
    layout_normalized: &'a GrayImage,
    text_vicinity_mask: Option<&'a BinaryImage>,
    picture_mask: Option<Arc<BinaryImage>>,
    automatic_picture_mask: Option<&'a BinaryImage>,
    trusted_mrc_owned_tone_mask: Option<Arc<BinaryImage>>,
    continuous_tone_mask: Option<Arc<BinaryImage>>,
    options: &'a CleanupOptions,
    effective_dpi: f64,
    calibration: PageCalibration,
    text_line_count: usize,
    blank_scan_candidate: bool,
    content_evidence_complete: bool,
    content_picture_mask: Option<Arc<BinaryImage>>,
}

struct TonalEvidenceOutput {
    outside_tone: OutsideTonalEvidence,
    tonal_seed_mask: BinaryImage,
    continuous_tone_mask: Option<Arc<BinaryImage>>,
    destructive_tone_mask: Option<Arc<BinaryImage>>,
    structural_tone_mask: Option<Arc<BinaryImage>>,
    spatial_tone_mask: Option<Arc<BinaryImage>>,
    picture_tone_evidence: bool,
    independent_picture_evidence: bool,
    ordinary_tonal_protection_mask: Option<Arc<BinaryImage>>,
    trusted_tonal_protection_mask: Option<Arc<BinaryImage>>,
    tonal_protection_mask: Option<Arc<BinaryImage>>,
    tone_semantic_preservation_alpha: Option<Arc<GrayImage>>,
    semantic_preservation_alpha: Option<Arc<GrayImage>>,
    source_effectively_blank: bool,
    text_soft_edge_ratio: Option<f64>,
    picture_mask: Option<Arc<BinaryImage>>,
    content_picture_mask: Option<Arc<BinaryImage>>,
}

struct TonalCandidateInput<'a> {
    rotated: &'a GrayImage,
    layout_normalized: &'a GrayImage,
    text_vicinity_mask: Option<&'a BinaryImage>,
    options: &'a CleanupOptions,
    calibration: PageCalibration,
    content_evidence_complete: bool,
    content_picture_mask: Option<Arc<BinaryImage>>,
}

struct TonalCandidateOutput {
    outside_tone: OutsideTonalEvidence,
    tonal_seed_mask: BinaryImage,
    flat_graphic_preservation_alpha: Option<Arc<GrayImage>>,
    destructive_tone_mask: Option<Arc<BinaryImage>>,
    structural_tone_mask: Option<Arc<BinaryImage>>,
    spatial_tone_mask: Option<Arc<BinaryImage>>,
    content_picture_mask: Option<Arc<BinaryImage>>,
}

fn prepare_tonal_candidates(input: TonalCandidateInput<'_>) -> TonalCandidateOutput {
    let TonalCandidateInput {
        rotated,
        layout_normalized,
        text_vicinity_mask,
        options,
        calibration,
        content_evidence_complete,
        mut content_picture_mask,
    } = input;
    let (outside_tone, tonal_seed_mask) = text_vicinity_mask
        .map(|mask| outside_tonal_evidence_with_mask(layout_normalized, mask))
        .unwrap_or_else(|| {
            (
                OutsideTonalEvidence::default(),
                BinaryImage::new(rotated.width(), rotated.height()),
            )
        });
    // Flat, sharply bounded diagram fills are semantic tone even when
    // the halftone classifier rejects their low-spread line-art texture.
    // Keep this narrow graphic geometry as a representation channel; it
    // is not the broad tonal-protection field used by normalization.
    let flat_graphic_preservation_alpha =
        flat_graphic_tone_preservation_alpha(layout_normalized).map(Arc::new);
    let flat_graphic_picture_mask = flat_graphic_preservation_alpha
        .as_deref()
        .and_then(|alpha| {
            let mask = BinaryImage::from_fn_parallel(alpha.width(), alpha.height(), |x, y| {
                alpha.get(x, y) >= 128
            });
            (mask.count_black() > 0).then(|| Arc::new(mask))
        });
    // Any tone strong and coherent enough to veto destructive B&W must
    // also own pixels in a Mixed result. Previously the mode selector
    // could choose Mixed while the renderer kept an empty picture mask,
    // silently publishing a bilevel page and destroying the very map fill
    // or shaded region that caused the veto.
    let destructive_tone_mask = outside_tone.vetoes_destructive_mode().then(|| {
        Arc::new(extend_tone_mask_for_content(
            layout_normalized,
            &tonal_seed_mask,
            calibration,
        ))
    });
    let structural_tone_mask = outside_tone
        .coherent()
        .then(|| destructive_tone_mask.as_ref().map(Arc::clone))
        .flatten();
    // A flat graphic is a separate representation channel, but its mask
    // still crosses the sole owner qualification gate before it can enter
    // a render partition. Raw outside-text tone is deliberately not
    // promoted here: without vetted geometry it must not become a Mixed
    // stencil owner or a second source of the UI's picture label.
    let spatial_tone_mask = flat_graphic_picture_mask.as_deref().and_then(|candidate| {
        let qualified = qualify_picture_owner(rotated, candidate);
        (qualified.count_black() > 0).then(|| Arc::new(qualified))
    });
    if options.crop_content && !content_evidence_complete {
        // The crop planner needs the same vetted map/illustration geometry
        // as the tone-preservation path. Picture detection can be empty on
        // flat-shaded line art; without this union, cleanup preserves the
        // tones but trims the outer frame or labels that establish their
        // true page extent.
        //
        // "Coherent tone" alone is not that geometry. It is also what a
        // rail, a binding fold, and a soft edge shadow look like to the
        // tile detector, and the crop box is shipped page geometry, so the
        // union carries only tone that clears the same artifact gate every
        // other automatic owner crosses. A flat-shaded plate is a dense,
        // page-interior component and clears it unchanged.
        let qualified_tone_mask = structural_tone_mask.as_deref().and_then(|tone| {
            let qualified = qualify_picture_owner(rotated, tone);
            (qualified.count_black() > 0).then(|| Arc::new(qualified))
        });
        content_picture_mask =
            union_optional_masks(content_picture_mask.as_ref(), qualified_tone_mask.as_ref());
    }
    TonalCandidateOutput {
        outside_tone,
        tonal_seed_mask,
        flat_graphic_preservation_alpha,
        destructive_tone_mask,
        structural_tone_mask,
        spatial_tone_mask,
        content_picture_mask,
    }
}

fn prepare_tonal_evidence(input: TonalEvidenceInput<'_>) -> TonalEvidenceOutput {
    let TonalEvidenceInput {
        rotated,
        layout_normalized,
        text_vicinity_mask,
        picture_mask,
        automatic_picture_mask,
        trusted_mrc_owned_tone_mask,
        continuous_tone_mask,
        options,
        effective_dpi,
        calibration,
        text_line_count,
        blank_scan_candidate,
        content_evidence_complete,
        content_picture_mask,
    } = input;
    let TonalCandidateOutput {
        outside_tone,
        tonal_seed_mask,
        flat_graphic_preservation_alpha,
        destructive_tone_mask,
        structural_tone_mask,
        spatial_tone_mask,
        content_picture_mask,
    } = prepare_tonal_candidates(TonalCandidateInput {
        rotated,
        layout_normalized,
        text_vicinity_mask,
        options,
        calibration,
        content_evidence_complete,
        content_picture_mask,
    });
    let continuous_tone_mask =
        continuous_tone_mask.and_then(|mask| (mask.count_black() > 0).then_some(mask));
    let picture_tone_evidence = automatic_picture_mask.is_some_and(|mask| mask.count_black() > 0)
        || trusted_mrc_owned_tone_mask
            .as_deref()
            .is_some_and(|mask| mask.count_black() > 0)
        || spatial_tone_mask
            .as_deref()
            .is_some_and(|mask| mask.count_black() > 0)
        || !options.manual_zones.picture.is_empty();
    let independent_picture_evidence = trusted_mrc_owned_tone_mask
        .as_deref()
        .is_some_and(|mask| mask.count_black() > 0)
        || spatial_tone_mask
            .as_deref()
            .is_some_and(|mask| mask.count_black() > 0)
        || !options.manual_zones.picture.is_empty()
        || qualifies_independent_outside_tone(outside_tone);
    // These masks are protection/normalization evidence, not picture
    // ownership. The semantic owner remains `picture_mask`; keeping the
    // channels separate prevents show-through and fold tone from being
    // republished as a photograph.
    let ordinary_tonal_protection_mask = union_optional_masks(
        destructive_tone_mask.as_ref(),
        continuous_tone_mask.as_ref(),
    );
    // The trusted fallback has already passed the component-level text
    // veto and the real text-vicinity carve above. Keep those surviving
    // pixels as an exact tone owner during the final Mixed partition;
    // applying the broader text-vicinity carve a second time otherwise
    // collapses the recovered photograph back to the same sparse
    // halftone islands that A7 is intended to replace.
    let trusted_tonal_protection_mask = union_optional_masks(
        ordinary_tonal_protection_mask.as_ref(),
        trusted_mrc_owned_tone_mask.as_ref(),
    );
    // The final picture owner is the authoritative illumination exclusion
    // too. Keep broader tone evidence as a separate fallback, but always
    // derive this protection view from the same owner that mode selection
    // and composition receive.
    let tonal_protection_mask = union_optional_masks(
        trusted_tonal_protection_mask.as_ref(),
        picture_mask.as_ref(),
    );
    // A textless illustration may legitimately use smooth tone across its
    // full vetted enclosure. On document-like pages, isolate semantic tone
    // from paper on the raw-source scale: deriving this alpha from the
    // already-whitened layout raster erased the very middle-gray map fills
    // it was meant to protect. The endpoint remains illumination-corrected,
    // so this alpha does not restore the page's scanner/paper shade.
    let tone_semantic_preservation_alpha = if text_line_count == 0 {
        tonal_protection_mask
            .as_deref()
            .and_then(semantic_tone_preservation_alpha)
    } else {
        refine_tone_preservation_alpha(rotated, rotated, None, tonal_protection_mask.as_deref())
    }
    .map(Arc::new);
    // Text remains on the monotonic paper-normalization path and is
    // darkened by the dedicated text-tone curve after geometry. A
    // detector-resolution binary text alpha changed antialiased stroke
    // coverage when resampled to the quality raster and made exact glyph
    // geometry depend on source DPI. Semantic ownership is therefore for
    // real tone only; text retention is verified separately against exact
    // synthetic ink coverage.
    let semantic_preservation_alpha = union_optional_gray_fields(
        tone_semantic_preservation_alpha.as_ref(),
        flat_graphic_preservation_alpha.as_ref(),
    );
    let source_effectively_blank = blank_scan_candidate;
    let text_soft_edge_ratio = text_vicinity_mask.and_then(|mask| {
        // Permissive tonal evidence serves strictly as an EXCLUSION for
        // glyph-topology measurement: a spread gutter shadow rightly
        // earns no output zone from the halftone classifier, yet its
        // soft tone must not read as antialiased glyph edges and veto
        // a crisp bilevel page.
        let permissive_tone = detect_continuous_tone_mask(rotated, effective_dpi);
        let exclusion = match picture_mask.as_deref() {
            Some(zones) => zones.or(&permissive_tone),
            None => permissive_tone,
        };
        text_soft_edge_to_ink_ratio(rotated, mask, Some(&exclusion))
    });

    TonalEvidenceOutput {
        outside_tone,
        tonal_seed_mask,
        continuous_tone_mask,
        destructive_tone_mask,
        structural_tone_mask,
        spatial_tone_mask,
        picture_tone_evidence,
        independent_picture_evidence,
        ordinary_tonal_protection_mask,
        trusted_tonal_protection_mask,
        tonal_protection_mask,
        tone_semantic_preservation_alpha,
        semantic_preservation_alpha,
        source_effectively_blank,
        text_soft_edge_ratio,
        picture_mask,
        content_picture_mask,
    }
}

struct ModePreservationInput<'a, 'p> {
    rotated: &'a GrayImage,
    layout_normalized: &'a GrayImage,
    analysis_rgb: Option<&'a RgbImage>,
    picture_mask: Option<Arc<BinaryImage>>,
    outside_tone: OutsideTonalEvidence,
    picture_tone_evidence: bool,
    text_line_count: usize,
    protected_text_blocks: Vec<ContentBlockEvidence>,
    independent_picture_evidence: bool,
    calibration: PageCalibration,
    options: &'a CleanupOptions,
    render_policy: PageRenderPolicy<'p>,
    tonal_protection_mask: Option<Arc<BinaryImage>>,
    tone_semantic_preservation_alpha: Option<Arc<GrayImage>>,
    semantic_preservation_alpha: Option<Arc<GrayImage>>,
    text_soft_edge_ratio: Option<f64>,
}

struct ModePreservationOutput {
    output_mode_recommendation: Option<OutputModeRecommendation>,
    resolved_output_mode: ResolvedOutputMode,
    chroma_picture_mask: Option<Arc<BinaryImage>>,
    significant_picture: bool,
    output_picture_mask: Option<Arc<BinaryImage>>,
    photographic_picture_mask: Option<Arc<BinaryImage>>,
    coherent_photo_mask: Option<Arc<BinaryImage>>,
    photo_preservation_alpha: Option<Arc<GrayImage>>,
    tone_preservation_alpha: Option<Arc<GrayImage>>,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    protect_tonal_text_vicinity: bool,
}

struct NormalizationEvidence {
    illumination_preparation: Option<IlluminationPreparation>,
    rotated: GrayImage,
    layout_normalized: GrayImage,
    picture_mask: Option<Arc<BinaryImage>>,
    tonal_protection_mask: Option<Arc<BinaryImage>>,
    semantic_preservation_alpha: Option<Arc<GrayImage>>,
    text_vicinity_mask: Option<Arc<BinaryImage>>,
}

struct ArtifactEvidence {
    continuous_tone_mask: Option<Arc<BinaryImage>>,
    spatial_tone_mask: Option<Arc<BinaryImage>>,
    text_mask: Option<Arc<BinaryImage>>,
    content_picture_mask: Option<Arc<BinaryImage>>,
    source_effectively_blank: bool,
    analysis_threshold: Option<u8>,
    text_axis: Option<TextAxisHint>,
}

struct ArtifactAssemblyMetadata {
    scale_x: f64,
    scale_y: f64,
    full_width: usize,
    full_height: usize,
    calibration: PageCalibration,
    effective_dpi: f64,
}

struct QualityNormalizationInput<'a> {
    analysis_key: Option<StageCacheKey>,
    source: &'a GrayImage,
    options: &'a CleanupOptions,
    prepare_quality_raster: bool,
    cache: Option<&'a PageCache>,
    timings: &'a mut PageStageTimings,
    normalization_started: Instant,
    evidence: NormalizationEvidence,
    artifact_evidence: ArtifactEvidence,
    metadata: ArtifactAssemblyMetadata,
    mode: ModePreservationOutput,
}

struct QualityNormalizationOutput {
    artifact: Arc<AnalysisArtifact>,
}

fn normalize_and_assemble_analysis_artifact(
    input: QualityNormalizationInput<'_>,
) -> QualityNormalizationOutput {
    let QualityNormalizationInput {
        analysis_key,
        source,
        options,
        prepare_quality_raster,
        cache,
        timings,
        normalization_started,
        evidence,
        artifact_evidence,
        metadata,
        mode,
    } = input;
    let NormalizationEvidence {
        illumination_preparation,
        rotated,
        layout_normalized,
        picture_mask,
        tonal_protection_mask,
        semantic_preservation_alpha,
        text_vicinity_mask,
    } = evidence;
    let ArtifactEvidence {
        continuous_tone_mask,
        spatial_tone_mask,
        text_mask,
        content_picture_mask,
        source_effectively_blank,
        analysis_threshold,
        text_axis,
    } = artifact_evidence;
    let ArtifactAssemblyMetadata {
        scale_x,
        scale_y,
        full_width,
        full_height,
        calibration,
        effective_dpi,
    } = metadata;
    let ModePreservationOutput {
        output_mode_recommendation,
        resolved_output_mode,
        chroma_picture_mask,
        output_picture_mask,
        photographic_picture_mask,
        coherent_photo_mask,
        photo_preservation_alpha,
        tone_preservation_alpha,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        protect_tonal_text_vicinity,
        significant_picture,
    } = mode;

    let quality_normalization_started = Instant::now();
    let canonical_routing_source = Arc::new(rotate_orthogonal(source, options.rotation));
    let normalized = if options.normalize_illumination {
        if prepare_quality_raster {
            let grayscale_normalization_exclusion = if resolved_output_mode
                == ResolvedOutputMode::Grayscale
                && coherent_photo_mask.is_some()
            {
                photographic_picture_mask.clone()
            } else {
                union_optional_masks(picture_mask.as_ref(), tonal_protection_mask.as_ref())
            };
            let normalization_model_exclusion = match resolved_output_mode {
                ResolvedOutputMode::Grayscale => grayscale_normalization_exclusion.as_deref(),
                ResolvedOutputMode::Mixed => photographic_picture_mask.as_deref(),
                ResolvedOutputMode::Color if significant_picture => {
                    grayscale_normalization_exclusion.as_deref()
                }
                ResolvedOutputMode::Color | ResolvedOutputMode::Bw => None,
            };
            let semantic_alpha = match resolved_output_mode {
                ResolvedOutputMode::Grayscale if protect_tonal_text_vicinity => None,
                ResolvedOutputMode::Grayscale => semantic_preservation_alpha.as_deref(),
                ResolvedOutputMode::Mixed if protect_tonal_text_vicinity => None,
                ResolvedOutputMode::Mixed => semantic_preservation_alpha.as_deref(),
                ResolvedOutputMode::Color if significant_picture => {
                    semantic_preservation_alpha.as_deref()
                }
                ResolvedOutputMode::Color | ResolvedOutputMode::Bw => None,
            };
            let photo_alpha = match resolved_output_mode {
                ResolvedOutputMode::Grayscale => photo_preservation_alpha.as_deref(),
                ResolvedOutputMode::Mixed => photo_preservation_alpha.as_deref(),
                ResolvedOutputMode::Color if significant_picture => {
                    photo_preservation_alpha.as_deref()
                }
                ResolvedOutputMode::Color | ResolvedOutputMode::Bw => None,
            };
            let preparation = illumination_preparation
                .expect("illumination preparation exists when normalization is enabled");
            normalize_illumination_prepared_with_masks(
                &rotated,
                normalization_model_exclusion,
                semantic_alpha,
                photo_alpha,
                text_vicinity_mask.as_deref(),
                preparation,
            )
        } else {
            layout_normalized.clone()
        }
    } else {
        rotated
    };
    timings.quality_normalization_ms +=
        quality_normalization_started.elapsed().as_secs_f64() * 1_000.0;
    let artifact = Arc::new(AnalysisArtifact {
        normalized: Arc::new(normalized),
        layout_normalized: Arc::new(layout_normalized),
        canonical_routing_source,
        scale_x,
        scale_y,
        full_width,
        full_height,
        calibration,
        effective_dpi,
        canonical_routing_dpi: options.dpi,
        picture_mask: output_picture_mask,
        halftone_zone_mask: continuous_tone_mask,
        spatial_tone_mask,
        chroma_picture_mask,
        tonal_protection_mask,
        semantic_preservation_alpha,
        photo_preservation_alpha,
        tone_preservation_alpha,
        text_mask,
        text_vicinity_mask,
        content_picture_mask,
        source_effectively_blank,
        output_mode_recommendation,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        resolved_output_mode,
        analysis_threshold,
        text_axis,
    });
    timings.normalization_ms += normalization_started.elapsed().as_secs_f64() * 1_000.0;
    if let (Some(cache), Some(key)) = (cache, analysis_key) {
        let bytes = analysis_artifact_bytes(&artifact);
        if let Ok(mut shared) = cache.shared.lock() {
            shared.insert(key, Arc::clone(&artifact), bytes);
        }
    }
    QualityNormalizationOutput { artifact }
}

fn resolve_mode_and_preservation(input: ModePreservationInput<'_, '_>) -> ModePreservationOutput {
    let ModePreservationInput {
        rotated,
        layout_normalized,
        analysis_rgb,
        picture_mask,
        outside_tone,
        picture_tone_evidence,
        text_line_count,
        protected_text_blocks,
        independent_picture_evidence,
        calibration,
        options,
        render_policy,
        tonal_protection_mask,
        tone_semantic_preservation_alpha,
        semantic_preservation_alpha,
        text_soft_edge_ratio,
    } = input;
    let mut output_mode_recommendation = picture_mask
        .as_deref()
        .filter(|_| render_policy.recommend_output_mode)
        .map(|picture_mask| {
            let recommendation = recommend_output_mode_with_tone(
                PreparedModeEvidence {
                    analysis: rotated,
                    analysis_rgb,
                    picture_mask,
                    picture_tone_evidence,
                    text_line_count,
                },
                outside_tone,
            );
            let recommendation = veto_contradictory_mixed_ownership(
                recommendation,
                options.output_mode == OutputMode::Auto,
                &protected_text_blocks,
                independent_picture_evidence,
            );
            protect_bilevel_text_fidelity(
                recommendation,
                calibration,
                options.source_dpi(),
                text_line_count,
                text_soft_edge_ratio,
            )
        });
    // Maps and dense line art often satisfy the generous picture detector
    // over almost the whole page. Restoring that full rectangle also
    // restores its gray paper. Use pixel-refined preservation when the
    // page-global evidence says "large, bimodal, low-midtone line art";
    // genuine continuous photographs keep their full mask so highlights
    // and smooth gradients cannot become contrast stencils.
    let picture_ownership_diagnostics = output_mode_recommendation
        .map(|recommendation| recommendation.diagnostics)
        .or_else(|| {
            picture_mask.as_deref().map(|picture_mask| {
                protect_bilevel_text_fidelity(
                    recommend_output_mode_with_tone(
                        PreparedModeEvidence {
                            analysis: rotated,
                            analysis_rgb,
                            picture_mask,
                            picture_tone_evidence,
                            text_line_count,
                        },
                        outside_tone,
                    ),
                    calibration,
                    options.source_dpi(),
                    text_line_count,
                    text_soft_edge_ratio,
                )
                .diagnostics
            })
        });
    let resolved_output_mode = if options.output_mode == OutputMode::Auto {
        output_mode_recommendation
            .map(|recommendation| recommendation.mode)
            .unwrap_or(OutputMode::Bw)
    } else {
        options.output_mode
    }
    .into();
    let chroma_picture_mask = (resolved_output_mode == ResolvedOutputMode::Mixed)
        .then(|| independent_chroma_mask(rotated, analysis_rgb, text_line_count).map(Arc::new))
        .flatten();
    let significant_picture =
        picture_ownership_diagnostics.is_some_and(|diagnostics| diagnostics.significant_picture);
    let refine_picture_ownership = picture_ownership_diagnostics
        .is_some_and(|diagnostics| should_refine_line_art_picture_ownership(&diagnostics));
    // Stencil legality is a property of the newly encoded foreground, not
    // of the semantic reason that selected Mixed. Spatial-tone pages can
    // have no detector-owned picture at all, so restricting this check to
    // photo-dominant Mixed output lets undersampled glyphs and map lines
    // bypass the same source-sampling boundary enforced for B&W.
    let mixed_foreground_fidelity_veto = resolved_output_mode == ResolvedOutputMode::Mixed
        && picture_ownership_diagnostics.is_some_and(|diagnostics| {
            !should_refine_line_art_picture_ownership(&diagnostics)
                && should_veto_bilevel_fidelity(
                    calibration.valid,
                    diagnostics.calibrated_source_stroke_width_px,
                    diagnostics.calibrated_source_x_height_px,
                    diagnostics.source_dpi,
                    diagnostics.soft_edge_to_ink_ratio,
                    text_line_count,
                )
        });
    let computed_soft_alpha_foreground = resolved_output_mode == ResolvedOutputMode::Mixed
        && text_line_count > 0
        && picture_ownership_diagnostics.is_some_and(|diagnostics| {
            mixed_foreground_fidelity_veto
                || diagnostics.bilevel_fidelity_veto
                || diagnostics.significant_color
                || (diagnostics.significant_picture && !refine_picture_ownership)
        });
    let use_soft_alpha_foreground = resolved_output_mode == ResolvedOutputMode::Mixed
            && options
                .prefer_soft_alpha_foreground
                .unwrap_or(computed_soft_alpha_foreground)
            // The final layered handoff is a fresh MRC composition. Its
            // high-resolution stencil owns ink, while the calibrated plate
            // owns continuous tone. Keeping the preview/library composite
            // soft preserves antialiasing there; publishing an 8-bit alpha
            // plane for final pages defeats the compact JBIG2 foreground
            // representation and carries no additional source ownership.
            && !render_policy.create_mixed_layers;
    if let Some(recommendation) = output_mode_recommendation.as_mut() {
        recommendation.prefer_soft_alpha_foreground = use_soft_alpha_foreground;
        recommendation.diagnostics.bilevel_fidelity_veto |= mixed_foreground_fidelity_veto;
    }
    let protect_tonal_text_vicinity = significant_picture && !refine_picture_ownership;
    // Exact preservation is a direct view of the sole vetted owner. Size
    // heuristics and line-art diagnostics may choose representation
    // details, but cannot revoke ownership once this mask is nonempty.
    let preserve_confirmed_photo_tones =
        confirmed_photo_preservation_policy(picture_mask.as_deref());
    let mut output_picture_mask = if resolved_output_mode == ResolvedOutputMode::Mixed {
        // Only the vetted owner may enter the Mixed partition. The
        // continuous-tone mask remains corroborating/protection evidence;
        // OR-ing it here recreated the non-monotonic ownership bug after
        // mode selection and let paper/show-through become "Text+pics".
        union_optional_masks(picture_mask.as_ref(), chroma_picture_mask.as_ref())
    } else {
        picture_mask.clone()
    };
    // Layer ownership and illumination ownership are deliberately
    // different. A coherent line-art/map field must stay out of the
    // bilevel foreground, but treating that entire field as a photograph
    // also restores its gray paper after normalization. A page with direct
    // significant-picture evidence extends that photographic treatment to
    // the coherent tone mask so detector fragments cannot create seams
    // through a real photo. Without that evidence, only detector-owned
    // pictures and independent chroma bypass the paper model.
    let mut photographic_picture_mask =
        if resolved_output_mode == ResolvedOutputMode::Mixed && significant_picture {
            output_picture_mask.clone()
        } else if resolved_output_mode == ResolvedOutputMode::Mixed {
            union_optional_masks(picture_mask.as_ref(), chroma_picture_mask.as_ref())
        } else {
            picture_mask.clone()
        };
    // A confirmed owner gets an exact, immutable source-preservation
    // alpha. Line-art refinement is still useful for the rest of a map or
    // diagram, but it is computed on geometry outside that owner so its
    // paper-model estimate cannot whiten an approved photo lobe.
    let detected_photo_preservation_alpha = picture_and_line_art_preservation_alpha(
        layout_normalized,
        rotated,
        tonal_protection_mask.as_deref(),
        photographic_picture_mask.as_deref(),
        refine_picture_ownership,
    );
    // On a genuine photograph the semantic tone detector can complete
    // smooth highlights that the texture-based picture mask omits. That
    // evidence must select the source-preservation branch, not merely the
    // semantic contrast curve; otherwise the two branches meet as a hard
    // horizontal seam through the image. Line-art pages keep semantic and
    // photo alphas separate so gray paper is still driven to white.
    let expanded_photo_preservation_alpha = if significant_picture && !refine_picture_ownership {
        union_optional_gray_fields(
            detected_photo_preservation_alpha.as_ref(),
            tone_semantic_preservation_alpha.as_ref(),
        )
    } else {
        detected_photo_preservation_alpha
    };
    let coherent_photo_mask = picture_mask
        .as_ref()
        .filter(|owner| owner.count_black() > 0 && !refine_picture_ownership)
        .map(Arc::clone)
        .or_else(|| {
            (matches!(
                resolved_output_mode,
                ResolvedOutputMode::Mixed | ResolvedOutputMode::Grayscale
            ) && significant_picture
                && !refine_picture_ownership)
                .then(|| {
                    expanded_photo_preservation_alpha
                        .as_deref()
                        .and_then(|alpha| coherent_photo_field(alpha, rotated))
                })
                .flatten()
        });
    let photo_preservation_alpha = if let Some(field) = coherent_photo_mask.as_ref() {
        // The high-confidence continuous field is the representation
        // boundary. Detector fragments attached to a scanner shadow or a
        // page rule remain outside it, so they can be whitened as paper;
        // the whole photographic enclosure stays on one source-preserved
        // low-DPI layer.
        if resolved_output_mode == ResolvedOutputMode::Mixed {
            let field_and_chroma = union_optional_masks(Some(field), chroma_picture_mask.as_ref());
            // A coherent-field replacement must not discard the exact
            // classifier zone that selected the layered owner. Keep the
            // zone in the normalization/photo owner as well as carrying
            // it separately into the final Mixed partition.
            output_picture_mask = field_and_chroma;
            photographic_picture_mask = output_picture_mask.clone();
        } else {
            photographic_picture_mask = Some(Arc::clone(field));
        }
        photo_tone_preservation_alpha(field).map(Arc::new)
    } else {
        expanded_photo_preservation_alpha
    };
    let tone_preservation_alpha = if protect_tonal_text_vicinity {
        photo_preservation_alpha.clone()
    } else {
        union_optional_gray_fields(
            semantic_preservation_alpha.as_ref(),
            photo_preservation_alpha.as_ref(),
        )
    };

    ModePreservationOutput {
        output_mode_recommendation,
        resolved_output_mode,
        chroma_picture_mask,
        significant_picture,
        output_picture_mask,
        photographic_picture_mask,
        coherent_photo_mask,
        photo_preservation_alpha,
        tone_preservation_alpha,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        protect_tonal_text_vicinity,
    }
}

fn build_analysis_artifact(input: ArtifactInput<'_, '_>) -> Arc<AnalysisArtifact> {
    let ArtifactInput {
        analysis_key,
        source,
        color_source,
        options,
        prepare_quality_raster,
        render_policy,
        calibration_config,
        cache,
        trusted_mrc_background,
        timings,
    } = input;
    let AnalysisPlaneOutput {
        effective_dpi,
        rotated,
        analysis_rgb,
        full_width,
        full_height,
        scale_x,
        scale_y,
        blank_scan_candidate,
    } = prepare_analysis_plane(AnalysisPlaneInput {
        source,
        color_source,
        options,
        timings,
    });
    let normalization_started = Instant::now();
    let LayoutPictureEvidenceOutput {
        illumination_preparation,
        layout_normalized,
        calibration,
        continuous_tone_mask,
        detected_picture_mask: _detected_picture_mask,
        automatic_picture_mask,
        picture_mask,
        trusted_mrc_tone_mask,
        content_evidence_complete,
        content_picture_mask,
    } = prepare_layout_picture_evidence(LayoutPictureEvidenceInput {
        rotated: &rotated,
        effective_dpi,
        full_width,
        full_height,
        blank_scan_candidate,
        render_policy,
        calibration_config,
        options,
        trusted_mrc_background,
        timings,
    });
    let TextEvidenceOutput {
        analysis_threshold,
        text_axis,
    } = prepare_text_evidence(TextEvidenceInput {
        layout_normalized: &layout_normalized,
        render_policy,
        timings,
    });
    let mode_recommendation_started = Instant::now();
    // Automatic mode reuses the normal line detector. A normalized crop
    // needs the same text-vicinity evidence even after Auto has resolved
    // to an explicit mode: quality normalization otherwise erases faint
    // running furniture before the crop detector sees it. Destructive
    // blank-page cleanup itself depends only on raw luminance, chroma and
    // coherent edge structure: normalized texture is exactly the unstable
    // evidence that caused preview/final disagreements here.
    let ContentTextEvidenceOutput {
        text_line_count,
        protected_text_blocks,
        text_mask,
        text_vicinity_mask,
        trusted_mrc_owned_tone_mask,
    } = prepare_content_text_evidence(ContentTextEvidenceInput {
        rotated: &rotated,
        layout_normalized: &layout_normalized,
        picture_mask: picture_mask.as_deref(),
        trusted_mrc_tone_mask: trusted_mrc_tone_mask.as_deref(),
        render_policy,
        prepare_quality_raster,
        options,
        effective_dpi,
        calibration,
    });
    let FinalPictureOwnershipOutput {
        picture_mask,
        content_picture_mask,
    } = finalize_picture_ownership(FinalPictureOwnershipInput {
        rotated: &rotated,
        automatic_picture_mask: automatic_picture_mask.as_deref(),
        trusted_mrc_owned_tone_mask: trusted_mrc_owned_tone_mask.as_deref(),
        text_mask: text_mask.as_deref(),
        text_vicinity_mask: text_vicinity_mask.as_deref(),
        picture_mask,
        content_picture_mask,
        options,
        effective_dpi,
        calibration,
        content_evidence_complete,
    });
    let TonalEvidenceOutput {
        outside_tone,
        tonal_seed_mask: _tonal_seed_mask,
        continuous_tone_mask,
        destructive_tone_mask: _destructive_tone_mask,
        structural_tone_mask: _structural_tone_mask,
        spatial_tone_mask,
        picture_tone_evidence,
        independent_picture_evidence,
        ordinary_tonal_protection_mask: _ordinary_tonal_protection_mask,
        trusted_tonal_protection_mask: _trusted_tonal_protection_mask,
        tonal_protection_mask,
        tone_semantic_preservation_alpha,
        semantic_preservation_alpha,
        source_effectively_blank,
        text_soft_edge_ratio,
        picture_mask,
        content_picture_mask,
    } = prepare_tonal_evidence(TonalEvidenceInput {
        rotated: &rotated,
        layout_normalized: &layout_normalized,
        text_vicinity_mask: text_vicinity_mask.as_deref(),
        picture_mask,
        automatic_picture_mask: automatic_picture_mask.as_deref(),
        trusted_mrc_owned_tone_mask,
        continuous_tone_mask,
        options,
        effective_dpi,
        calibration,
        text_line_count,
        blank_scan_candidate,
        content_evidence_complete,
        content_picture_mask,
    });
    let mode = resolve_mode_and_preservation(ModePreservationInput {
        rotated: &rotated,
        layout_normalized: &layout_normalized,
        analysis_rgb: analysis_rgb.as_ref(),
        picture_mask: picture_mask.clone(),
        outside_tone,
        picture_tone_evidence,
        text_line_count,
        protected_text_blocks,
        independent_picture_evidence,
        calibration,
        options,
        render_policy,
        tonal_protection_mask: tonal_protection_mask.clone(),
        tone_semantic_preservation_alpha,
        semantic_preservation_alpha: semantic_preservation_alpha.clone(),
        text_soft_edge_ratio,
    });
    timings.mode_recommendation_ms += mode_recommendation_started.elapsed().as_secs_f64() * 1_000.0;
    let QualityNormalizationOutput { artifact } =
        normalize_and_assemble_analysis_artifact(QualityNormalizationInput {
            analysis_key,
            source,
            options,
            prepare_quality_raster,
            cache,
            timings,
            normalization_started,
            evidence: NormalizationEvidence {
                illumination_preparation,
                rotated,
                layout_normalized,
                picture_mask,
                tonal_protection_mask,
                semantic_preservation_alpha,
                text_vicinity_mask,
            },
            artifact_evidence: ArtifactEvidence {
                continuous_tone_mask,
                spatial_tone_mask,
                text_mask,
                content_picture_mask,
                source_effectively_blank,
                analysis_threshold,
                text_axis,
            },
            metadata: ArtifactAssemblyMetadata {
                scale_x,
                scale_y,
                full_width,
                full_height,
                calibration,
                effective_dpi,
            },
            mode,
        });
    artifact
}
pub(crate) fn run(input: Input<'_, '_>) -> Result<PreparedAnalysis, super::AnalysisError> {
    let Input {
        source,
        color_source,
        options,
        prepare_quality_raster,
        render_policy,
        document_prior,
        calibration_config,
        cache,
        trusted_mrc_background,
        timings,
    } = input;
    prepare_analysis_page_impl(
        source,
        color_source,
        options,
        prepare_quality_raster,
        render_policy,
        document_prior,
        calibration_config,
        cache,
        trusted_mrc_background,
        timings,
    )
}

#[cfg(test)]
#[path = "document_analysis_tests.rs"]
mod tests;
