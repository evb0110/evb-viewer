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
        permissive_tone_mask: None,
        picture_mask: None,
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
fn identical_analysis_planes_share_one_allocation() {
    let page = GrayImage::from_vec(
        40,
        30,
        40,
        (0..30)
            .flat_map(|y| (0..40).map(move |x| if (x + y) % 7 == 0 { 30 } else { 230 }))
            .collect(),
    )
    .expect("synthetic raster dimensions must be valid");
    let analyze = |source: &GrayImage, dpi: f64, normalize_illumination: bool| {
        build_analysis_artifact(ArtifactInput {
            analysis_key: None,
            source,
            color_source: None,
            options: &CleanupOptions {
                dpi,
                normalize_illumination,
                ..CleanupOptions::default()
            },
            prepare_quality_raster: true,
            render_policy: PageRenderPolicy::COMPLETE,
            calibration_config: CalibrationConfig::default(),
            cache: None,
            trusted_mrc_background: None,
            timings: &mut PageStageTimings::default(),
        })
    };

    // At the analysis DPI with normalization off, all three planes are the
    // source itself.
    let identity = analyze(&page, 150.0, false);
    assert!(Arc::ptr_eq(
        &identity.normalized,
        &identity.layout_normalized
    ));
    assert!(Arc::ptr_eq(
        &identity.normalized,
        &identity.canonical_routing_source
    ));
    assert_eq!(identity.canonical_routing_source.data(), page.data());

    // Normalization changes the analysis planes but not the routing source.
    let normalized = analyze(&page, 150.0, true);
    assert!(!Arc::ptr_eq(
        &normalized.normalized,
        &normalized.canonical_routing_source
    ));
    assert_eq!(normalized.canonical_routing_source.data(), page.data());

    // A downscaled analysis keeps a full-resolution routing source of its own.
    let downscaled = analyze(&page, 600.0, false);
    assert_eq!(
        (
            downscaled.canonical_routing_source.width(),
            downscaled.canonical_routing_source.height()
        ),
        (40, 30)
    );
    assert_eq!(downscaled.canonical_routing_source.data(), page.data());
    assert!(downscaled.normalized.width() < 40);
}
