use super::*;

#[test]
fn analysis_stage_preserves_synthetic_page_dimensions() {
    let source = GrayImage::new(24, 16, 255);
    let options = CleanupOptions {
        layout: crate::LayoutMode::Single,
        ..CleanupOptions::default()
    };
    let prepared = run(Input {
        source: &source,
        color_source: None,
        options: &options,
        prepare_quality_raster: true,
        render_policy: PageRenderPolicy::COMPLETE,
        document_prior: None,
        calibration_config: CalibrationConfig::default(),
        cache: None,
        trusted_mrc_background: None,
        timings: &mut PageStageTimings::default(),
    })
    .expect("synthetic analysis should succeed");
    assert_eq!((prepared.full_width, prepared.full_height), (24, 16));
    assert_eq!(
        prepared.split.classification,
        LayoutClassification::SingleUncutPage
    );
}

#[test]
fn analysis_plane_stage_pins_rotation_dimensions_and_independent_scales() {
    let source = GrayImage::from_vec(
        20,
        12,
        20,
        (0..12)
            .flat_map(|y| (0..20).map(move |x| if x == y + 2 { 0 } else { 220 }))
            .collect(),
    )
    .expect("synthetic raster dimensions must be valid");
    let options = CleanupOptions {
        rotation: OrthogonalRotation::Clockwise90,
        dpi: 600.0,
        ..CleanupOptions::default()
    };
    let output = prepare_analysis_plane(AnalysisPlaneInput {
        source: &source,
        color_source: None,
        options: &options,
        timings: &mut PageStageTimings::default(),
    });

    assert_eq!((output.full_width, output.full_height), (12, 20));
    assert_eq!((output.rotated.width(), output.rotated.height()), (3, 5));
    assert_eq!(output.scale_x, 0.25);
    assert_eq!(output.scale_y, 0.25);
    assert!(!output.blank_scan_candidate);
}

#[test]
fn layout_picture_stage_returns_calibration_and_picture_evidence() {
    let image = GrayImage::new(32, 24, 255);
    let output = prepare_layout_picture_evidence(LayoutPictureEvidenceInput {
        rotated: &image,
        effective_dpi: 150.0,
        full_width: 32,
        full_height: 24,
        blank_scan_candidate: true,
        render_policy: PageRenderPolicy::COMPLETE,
        calibration_config: CalibrationConfig::default(),
        options: &CleanupOptions::default(),
        trusted_mrc_background: None,
        timings: &mut PageStageTimings::default(),
    });

    assert_eq!(
        (
            output.layout_normalized.width(),
            output.layout_normalized.height()
        ),
        (image.width(), image.height())
    );
    assert!(output.illumination_preparation.is_some());
    assert!(output.calibration.effective_dpi.is_finite());
    assert_eq!(
        output.continuous_tone_mask.as_ref().unwrap().count_black(),
        0
    );
    assert_eq!(
        output.detected_picture_mask.as_ref().unwrap().count_black(),
        0
    );
}

#[test]
fn text_evidence_stage_returns_threshold_and_abstains_for_contrasted_rows() {
    let image = GrayImage::from_vec(
        64,
        32,
        64,
        (0..32)
            .flat_map(|y| std::iter::repeat_n(if y % 4 < 2 { 40 } else { 220 }, 64))
            .collect(),
    )
    .expect("synthetic raster dimensions must be valid");
    let output = prepare_text_evidence(TextEvidenceInput {
        layout_normalized: &image,
        render_policy: PageRenderPolicy::COMPLETE,
        timings: &mut PageStageTimings::default(),
    });

    assert!(output.analysis_threshold.is_some());
    assert_eq!(output.text_axis, None);
}

#[test]
fn content_text_stage_exposes_masks_for_picture_backed_text_evidence() {
    let image = GrayImage::from_vec(
        96,
        64,
        96,
        (0..64)
            .flat_map(|y| {
                (0..96).map(move |x| {
                    if (12..84).contains(&x) && (20..44).contains(&y) {
                        30
                    } else {
                        240
                    }
                })
            })
            .collect(),
    )
    .expect("synthetic raster dimensions must be valid");
    let mut picture = BinaryImage::new(96, 64);
    for y in 16..48 {
        for x in 8..88 {
            picture.set(x, y, true);
        }
    }
    let output = prepare_content_text_evidence(ContentTextEvidenceInput {
        rotated: &image,
        layout_normalized: &image,
        picture_mask: Some(&picture),
        trusted_mrc_tone_mask: None,
        render_policy: PageRenderPolicy::COMPLETE,
        prepare_quality_raster: true,
        options: &CleanupOptions {
            output_mode: OutputMode::Mixed,
            ..CleanupOptions::default()
        },
        effective_dpi: 300.0,
        calibration: PageCalibration::estimate(&image, 300.0, CalibrationConfig::default()),
    });

    assert!(output.text_mask.is_some());
    assert!(output.text_vicinity_mask.is_some());
    assert_eq!(
        (
            output.text_mask.as_ref().unwrap().width(),
            output.text_mask.as_ref().unwrap().height(),
        ),
        (image.width(), image.height())
    );
}

#[test]
fn final_picture_ownership_applies_manual_zones_before_crop_extension() {
    let rotated = GrayImage::from_vec(
        128,
        128,
        128,
        (0..128)
            .flat_map(|y| {
                (0..128).map(move |x| {
                    if (40..88).contains(&x) && (40..88).contains(&y) {
                        0
                    } else {
                        255
                    }
                })
            })
            .collect(),
    )
    .expect("synthetic raster dimensions must be valid");
    let automatic = BinaryImage::from_fn_parallel(128, 128, |x, y| {
        (40..88).contains(&x) && (40..88).contains(&y)
    });
    let options = CleanupOptions {
        crop_content: true,
        manual_zones: crate::ManualZones {
            picture: vec![crate::PictureZone {
                polygon: crate::NormalizedZonePolygon {
                    points: vec![
                        crate::NormalizedZonePoint { x: 0.0, y: 0.0 },
                        crate::NormalizedZonePoint { x: 0.25, y: 0.0 },
                        crate::NormalizedZonePoint { x: 0.25, y: 0.25 },
                        crate::NormalizedZonePoint { x: 0.0, y: 0.25 },
                    ],
                    rotation: OrthogonalRotation::None,
                },
                layer: crate::PictureZoneLayer::Painter2,
            }],
            fill: vec![],
        },
        ..CleanupOptions::default()
    };
    let output = finalize_picture_ownership(FinalPictureOwnershipInput {
        rotated: &rotated,
        automatic_picture_mask: Some(&automatic),
        trusted_mrc_owned_tone_mask: None,
        text_mask: None,
        text_vicinity_mask: None,
        picture_mask: None,
        content_picture_mask: None,
        options: &options,
        effective_dpi: 300.0,
        calibration: PageCalibration::estimate(&rotated, 300.0, CalibrationConfig::default()),
        content_evidence_complete: false,
    });
    let picture = output.picture_mask.expect("manual owner must be returned");
    let content = output
        .content_picture_mask
        .expect("crop extension must return the updated mask");
    assert!(picture.get(2, 2));
    assert!(picture.get(60, 60));
    assert_eq!(picture, content);
}

#[test]
fn tonal_evidence_fallback_keeps_tone_separate_without_text_vicinity() {
    let image = GrayImage::new(16, 12, 255);
    let output = prepare_tonal_evidence(TonalEvidenceInput {
        rotated: &image,
        layout_normalized: &image,
        text_vicinity_mask: None,
        picture_mask: None,
        automatic_picture_mask: None,
        trusted_mrc_owned_tone_mask: None,
        continuous_tone_mask: None,
        options: &CleanupOptions::default(),
        effective_dpi: 300.0,
        calibration: PageCalibration::estimate(&image, 300.0, CalibrationConfig::default()),
        text_line_count: 0,
        blank_scan_candidate: false,
        content_evidence_complete: true,
        content_picture_mask: None,
    });
    assert_eq!(output.tonal_seed_mask.count_black(), 0);
    assert_eq!(output.outside_tone, OutsideTonalEvidence::default());
    assert!(output.tonal_protection_mask.is_none());
    assert!(output.semantic_preservation_alpha.is_none());
    assert!(output.text_soft_edge_ratio.is_none());
}

#[test]
fn mode_stage_pins_mixed_line_art_soft_foreground_override() {
    let image = GrayImage::new(128, 128, 255);
    let owner = Arc::new(BinaryImage::from_fn_parallel(128, 128, |x, y| {
        (32..96).contains(&x) && (32..96).contains(&y)
    }));
    let options = CleanupOptions {
        output_mode: crate::OutputMode::Mixed,
        prefer_soft_alpha_foreground: Some(true),
        ..CleanupOptions::default()
    };
    let output = resolve_mode_and_preservation(ModePreservationInput {
        rotated: &image,
        layout_normalized: &image,
        analysis_rgb: None,
        picture_mask: Some(Arc::clone(&owner)),
        outside_tone: OutsideTonalEvidence::default(),
        picture_tone_evidence: true,
        text_line_count: 2,
        protected_text_blocks: vec![],
        independent_picture_evidence: false,
        calibration: PageCalibration::estimate(&image, 300.0, CalibrationConfig::default()),
        options: &options,
        render_policy: PageRenderPolicy::DETAIL_TILE,
        tonal_protection_mask: None,
        tone_semantic_preservation_alpha: None,
        semantic_preservation_alpha: None,
        text_soft_edge_ratio: None,
    });
    assert_eq!(
        output.resolved_output_mode,
        crate::ResolvedOutputMode::Mixed
    );
    assert!(output.use_soft_alpha_foreground);
    assert_eq!(output.output_picture_mask, Some(owner));
}

#[test]
fn mode_stage_pins_coherent_photo_preservation_and_mask_replacement() {
    let image = GrayImage::new(128, 128, 160);
    let owner = Arc::new(BinaryImage::from_fn_parallel(128, 128, |x, y| {
        (16..112).contains(&x) && (16..112).contains(&y)
    }));
    let options = CleanupOptions {
        output_mode: crate::OutputMode::Mixed,
        ..CleanupOptions::default()
    };
    let output = resolve_mode_and_preservation(ModePreservationInput {
        rotated: &image,
        layout_normalized: &image,
        analysis_rgb: None,
        picture_mask: Some(Arc::clone(&owner)),
        outside_tone: OutsideTonalEvidence::default(),
        picture_tone_evidence: true,
        text_line_count: 0,
        protected_text_blocks: vec![],
        independent_picture_evidence: true,
        calibration: PageCalibration::estimate(&image, 300.0, CalibrationConfig::default()),
        options: &options,
        render_policy: PageRenderPolicy::COMPLETE,
        tonal_protection_mask: Some(Arc::clone(&owner)),
        tone_semantic_preservation_alpha: None,
        semantic_preservation_alpha: None,
        text_soft_edge_ratio: None,
    });
    assert!(output.preserve_confirmed_photo_tones);
    assert!(output.photographic_picture_mask.is_some());
    assert!(output.output_picture_mask.is_some());
}

#[test]
fn quality_stage_normalizes_with_semantic_exclusion_and_caches_complete_artifact() {
    let source = GrayImage::new(32, 24, 196);
    let layout_normalized = source.clone();
    let tonal_protection_mask = Arc::new(BinaryImage::from_fn_parallel(32, 24, |x, y| {
        x == 5 && y == 7
    }));
    let semantic_preservation_alpha = Arc::new(GrayImage::new(32, 24, 96));
    let options = CleanupOptions {
        output_mode: crate::OutputMode::Grayscale,
        normalize_illumination: true,
        ..CleanupOptions::default()
    };
    let fingerprint = crate::cache::SourceFingerprint::from_path(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
        0,
    )
    .expect("manifest directory must be stat-able");
    let cache = PageCache::new(
        Arc::new(std::sync::Mutex::new(crate::cache::ByteLru::new(1 << 20))),
        fingerprint.clone(),
    );
    let key = StageCacheKey::analysis(
        &fingerprint,
        &options,
        true,
        true,
        true,
        true,
        CalibrationConfig::default(),
    );
    let illumination_preparation = prepare_illumination(&source);
    let mut timings = PageStageTimings::default();
    let QualityNormalizationOutput { artifact } =
        normalize_and_assemble_analysis_artifact(QualityNormalizationInput {
            analysis_key: Some(key.clone()),
            source: &source,
            options: &options,
            prepare_quality_raster: true,
            cache: Some(&cache),
            timings: &mut timings,
            normalization_started: std::time::Instant::now(),
            evidence: NormalizationEvidence {
                illumination_preparation: Some(illumination_preparation),
                rotated: source.clone(),
                layout_normalized: layout_normalized.clone(),
                picture_mask: None,
                tonal_protection_mask: Some(Arc::clone(&tonal_protection_mask)),
                semantic_preservation_alpha: Some(Arc::clone(&semantic_preservation_alpha)),
                text_vicinity_mask: None,
            },
            artifact_evidence: ArtifactEvidence {
                continuous_tone_mask: None,
                spatial_tone_mask: None,
                text_mask: None,
                content_picture_mask: None,
                source_effectively_blank: false,
                analysis_threshold: Some(128),
                text_axis: None,
            },
            metadata: ArtifactAssemblyMetadata {
                scale_x: 1.0,
                scale_y: 1.0,
                full_width: 32,
                full_height: 24,
                calibration: PageCalibration::estimate(
                    &layout_normalized,
                    300.0,
                    CalibrationConfig::default(),
                ),
                effective_dpi: 150.0,
            },
            mode: ModePreservationOutput {
                output_mode_recommendation: None,
                resolved_output_mode: crate::ResolvedOutputMode::Grayscale,
                chroma_picture_mask: None,
                significant_picture: false,
                output_picture_mask: None,
                photographic_picture_mask: None,
                coherent_photo_mask: None,
                photo_preservation_alpha: None,
                tone_preservation_alpha: None,
                preserve_confirmed_photo_tones: false,
                use_soft_alpha_foreground: false,
                protect_tonal_text_vicinity: false,
            },
        });

    assert_eq!(
        (artifact.normalized.width(), artifact.normalized.height()),
        (32, 24)
    );
    assert_eq!(
        artifact.resolved_output_mode,
        crate::ResolvedOutputMode::Grayscale
    );
    assert_eq!(artifact.analysis_threshold, Some(128));
    assert!(timings.quality_normalization_ms >= 0.0);
    assert!(cache
        .shared
        .lock()
        .expect("synthetic cache lock must succeed")
        .get::<AnalysisArtifact>(&key)
        .is_some());
}
