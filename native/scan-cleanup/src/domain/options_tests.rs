use super::{
    CleanupOptions, DerivedRasterError, DespeckleLevel, ManualContentBoxes, ManualZones, MarginsMm,
    NormalizedRect, NormalizedSplit, NormalizedZonePoint, NormalizedZonePolygon,
    OrthogonalRotation, OutputMode, PageAlignment, PictureZoneLayer, PlacementAnchor,
    PlacementAnchors, PlacementOverrides,
};
use crate::domain::geometry::PageHalf;
use scan_primitives::Rect;

fn zone_polygon(points: &[(f64, f64)]) -> NormalizedZonePolygon {
    NormalizedZonePolygon {
        points: points
            .iter()
            .map(|&(x, y)| NormalizedZonePoint { x, y })
            .collect(),
        rotation: OrthogonalRotation::None,
    }
}

#[test]
fn manual_zone_polygons_must_be_simple_and_non_degenerate() {
    for points in [
        vec![(0.1, 0.1), (0.8, 0.1), (0.8, 0.1)],
        vec![(0.1, 0.1), (0.5, 0.5), (0.9, 0.9)],
        vec![(0.1, 0.1), (0.9, 0.9), (0.1, 0.9), (0.9, 0.1)],
    ] {
        let options = CleanupOptions {
            manual_zones: ManualZones {
                picture: vec![],
                fill: vec![zone_polygon(&points)],
            },
            ..CleanupOptions::default()
        };
        assert!(options.validate().is_err());
    }

    let concave = vec![(0.1, 0.1), (0.9, 0.1), (0.5, 0.5), (0.9, 0.9), (0.1, 0.9)];
    for points in [concave.clone(), concave.into_iter().rev().collect()] {
        let options = CleanupOptions {
            manual_zones: ManualZones {
                picture: vec![],
                fill: vec![zone_polygon(&points)],
            },
            ..CleanupOptions::default()
        };
        options.validate().unwrap();
    }
}

#[test]
fn page_alignment_covers_all_nine_anchor_positions() {
    let width = 20;
    let height = 30;
    assert_eq!(PageAlignment::TopLeft.offset(width, height), (0, 0));
    assert_eq!(PageAlignment::TopCenter.offset(width, height), (10, 0));
    assert_eq!(PageAlignment::TopRight.offset(width, height), (20, 0));
    assert_eq!(PageAlignment::CenterLeft.offset(width, height), (0, 15));
    assert_eq!(PageAlignment::Center.offset(width, height), (10, 15));
    assert_eq!(PageAlignment::CenterRight.offset(width, height), (20, 15));
    assert_eq!(PageAlignment::BottomLeft.offset(width, height), (0, 30));
    assert_eq!(PageAlignment::BottomCenter.offset(width, height), (10, 30));
    assert_eq!(PageAlignment::BottomRight.offset(width, height), (20, 30));
}

#[test]
fn manual_split_validation_uses_the_safe_cutter_interval() {
    for x in [0.0, 0.019, 0.981, 1.0] {
        let options = CleanupOptions {
            manual_split_x: Some(NormalizedSplit {
                x,
                rotation: OrthogonalRotation::None,
            }),
            ..CleanupOptions::default()
        };
        assert!(
            options.validate().is_err(),
            "manual split x={x} was accepted"
        );
    }
    for x in [0.02, 0.5, 0.98] {
        let options = CleanupOptions {
            manual_split_x: Some(NormalizedSplit {
                x,
                rotation: OrthogonalRotation::None,
            }),
            ..CleanupOptions::default()
        };
        options.validate().unwrap();
    }
}

#[test]
fn per_output_placement_overrides_the_document_default() {
    let options = CleanupOptions {
        page_alignment: PageAlignment::TopLeft,
        placement_overrides: PlacementOverrides {
            right: Some(PageAlignment::BottomRight),
            ..PlacementOverrides::default()
        },
        ..CleanupOptions::default()
    };
    assert_eq!(
        options.placement_for(PageHalf::Left),
        PageAlignment::TopLeft
    );
    assert_eq!(
        options.placement_for(PageHalf::Right),
        PageAlignment::BottomRight
    );
}

#[test]
fn ink_alignment_and_placement_anchors_round_trip_and_stay_additive() {
    let options: CleanupOptions = serde_json::from_str(
        r#"{
            "pageAlignment":"ink",
            "placementAnchors":{
                "left":{"yNormalized":0.13},
                "right":{"yNormalized":0.21}
            }
        }"#,
    )
    .unwrap();
    options.validate().unwrap();
    // The unanchored offset is the top-centre one: the anchor is the only
    // thing that moves an Ink page.
    assert_eq!(
        PageAlignment::Ink.offset(20, 30),
        PageAlignment::TopCenter.offset(20, 30)
    );
    assert_eq!(options.placement_for(PageHalf::Left), PageAlignment::Ink);
    assert_eq!(
        options.placement_anchor_for(PageHalf::Left),
        Some(PlacementAnchor { y_normalized: 0.13 })
    );
    assert_eq!(options.placement_anchor_for(PageHalf::Full), None);

    let encoded = serde_json::to_value(options).unwrap();
    assert_eq!(encoded["pageAlignment"], "ink");
    assert_eq!(encoded["placementAnchors"]["right"]["yNormalized"], 0.21);

    let defaults = CleanupOptions::default();
    assert_eq!(defaults.placement_anchor_for(PageHalf::Full), None);
    assert!(serde_json::to_value(defaults)
        .unwrap()
        .get("placementAnchors")
        .is_none());
}

#[test]
fn placement_anchors_reject_unbounded_non_finite_and_unknown_geometry() {
    for y_normalized in [1.5, -0.01, f64::NAN, f64::INFINITY] {
        let error = CleanupOptions {
            page_alignment: PageAlignment::Ink,
            placement_anchors: PlacementAnchors {
                right: Some(PlacementAnchor { y_normalized }),
                ..PlacementAnchors::default()
            },
            ..CleanupOptions::default()
        }
        .validate()
        .unwrap_err();
        assert!(error.contains("right placement anchor"), "{error}");
    }

    // Float noise around the unit interval stays acceptable, exactly as the
    // normalized rectangles do.
    for y_normalized in [1.0 + 1e-12, -1e-12] {
        CleanupOptions {
            placement_anchors: PlacementAnchors {
                full: Some(PlacementAnchor { y_normalized }),
                ..PlacementAnchors::default()
            },
            ..CleanupOptions::default()
        }
        .validate()
        .unwrap();
    }
    let error = CleanupOptions {
        placement_anchors: PlacementAnchors {
            full: Some(PlacementAnchor {
                y_normalized: 1.0 + 1e-6,
            }),
            ..PlacementAnchors::default()
        },
        ..CleanupOptions::default()
    }
    .validate()
    .unwrap_err();
    assert!(error.contains("full placement anchor"), "{error}");

    // The horizontal axis is not part of the contract: ink is centred there.
    assert!(serde_json::from_str::<CleanupOptions>(
        r#"{"placementAnchors":{"full":{"xNormalized":0.5,"yNormalized":0.5}}}"#,
    )
    .is_err());
    assert!(serde_json::from_str::<CleanupOptions>(r#"{"placementAnchors":{"full":{}}}"#).is_err());
}

#[test]
fn normalized_content_rect_round_trips_with_named_units() {
    let json = r#"{
        "manualContentBoxes": {
            "left": {
                "xNormalized": 0.1,
                "yNormalized": 0.2,
                "widthNormalized": 0.5,
                "heightNormalized": 0.6,
                "rotationDegrees": 90
            }
        },
        "rotationDegrees": 90
    }"#;
    let options: CleanupOptions = serde_json::from_str(json).unwrap();
    let encoded = serde_json::to_value(&options).unwrap();
    assert_eq!(encoded["manualContentBoxes"]["left"]["xNormalized"], 0.1);
    assert_eq!(
        options.resolved_manual_content_for(PageHalf::Left, 1000, 500),
        Some(Rect::new(100.0, 100.0, 500.0, 300.0))
    );
    assert_eq!(
        options.manual_content_boxes.left,
        Some(NormalizedRect {
            x: 0.1,
            y: 0.2,
            width: 0.5,
            height: 0.6,
            rotation: OrthogonalRotation::Clockwise90,
        })
    );
}

#[test]
fn invalid_content_geometry_names_the_exact_field_and_values() {
    let options = CleanupOptions {
        automatic_content_boxes: ManualContentBoxes {
            right: Some(NormalizedRect {
                x: 0.72,
                y: 0.1,
                width: 0.29,
                height: 0.8,
                rotation: OrthogonalRotation::None,
            }),
            ..ManualContentBoxes::default()
        },
        ..CleanupOptions::default()
    };

    let error = options.validate().unwrap_err();
    assert!(error.contains("automatic right content box"));
    assert!(error.contains("x=0.72"));
    assert!(error.contains("width=0.29"));
}

#[test]
fn automatic_page_plan_is_additive_and_distinct_from_manual_geometry() {
    let options: CleanupOptions = serde_json::from_str(
        r#"{
            "automaticSplit":{"xNormalized":0.48,"rotationDegrees":0},
            "automaticSkewDegrees":{"right":-0.25},
            "automaticContentBoxes":{"right":{
                "xNormalized":0.1,
                "yNormalized":0.2,
                "widthNormalized":0.5,
                "heightNormalized":0.6,
                "rotationDegrees":0
            }}
        }"#,
    )
    .unwrap();
    options.validate().unwrap();
    assert_eq!(options.resolved_split_x(1_000), Some(480.0),);
    assert!(options.manual_split_x.is_none());
    assert_eq!(options.automatic_skew_for(PageHalf::Right), Some(-0.25));
    assert_eq!(
        options.resolved_content_for(PageHalf::Right, 800, 1_000),
        Some(Rect::new(80.0, 200.0, 400.0, 600.0))
    );
    assert_eq!(
        options.resolved_manual_content_for(PageHalf::Right, 800, 1_000),
        None
    );
    let encoded = serde_json::to_value(options).unwrap();
    assert_eq!(encoded["automaticSkewDegrees"]["right"], -0.25);
    assert_eq!(
        encoded["automaticContentBoxes"]["right"]["widthNormalized"],
        0.5
    );
    assert_eq!(encoded["automaticSplit"]["xNormalized"], 0.48);
    let defaults = serde_json::to_value(CleanupOptions::default()).unwrap();
    assert!(defaults.get("automaticSplit").is_none());
    assert!(defaults.get("automaticSkewDegrees").is_none());
    assert!(defaults.get("automaticContentBoxes").is_none());
}

#[test]
fn normalized_render_crop_is_optional_bounded_and_resolves_outward() {
    let default_options = CleanupOptions::default();
    assert_eq!(default_options.render_crop, None);

    let options = CleanupOptions {
        render_crop: Some(NormalizedRect {
            x: 0.101,
            y: 0.202,
            width: 0.303,
            height: 0.404,
            rotation: OrthogonalRotation::Clockwise90,
        }),
        rotation: OrthogonalRotation::Clockwise90,
        ..CleanupOptions::default()
    };
    options.validate().unwrap();
    assert_eq!(
        options.resolved_render_crop(1_000, 500),
        Some(Rect::new(101.0, 101.0, 303.0, 203.0)),
    );

    for crop in [
        NormalizedRect {
            x: -0.01,
            y: 0.0,
            width: 0.5,
            height: 0.5,
            rotation: OrthogonalRotation::None,
        },
        NormalizedRect {
            x: 0.75,
            y: 0.0,
            width: 0.5,
            height: 0.5,
            rotation: OrthogonalRotation::None,
        },
        NormalizedRect {
            x: 0.0,
            y: 0.0,
            width: f64::NAN,
            height: 0.5,
            rotation: OrthogonalRotation::None,
        },
        NormalizedRect {
            x: 0.0,
            y: 0.0,
            width: 0.5,
            height: 0.5,
            rotation: OrthogonalRotation::Clockwise90,
        },
    ] {
        assert!(CleanupOptions {
            render_crop: Some(crop),
            ..CleanupOptions::default()
        }
        .validate()
        .is_err());
    }
}

#[test]
fn derived_raster_geometry_distinguishes_non_finite_from_guardrail_violations() {
    let options = CleanupOptions::default();
    assert!(matches!(
        options.validate_derived_raster_dimensions(f64::INFINITY, 100.0),
        Err(DerivedRasterError::Invalid(_)),
    ));
    assert!(matches!(
        options.validate_derived_raster_dimensions(options.max_dimension as f64 + 1.0, 100.0),
        Err(DerivedRasterError::TooLarge(_)),
    ));
}

#[test]
fn rotation_uses_the_numeric_contract_and_accepts_legacy_scalar_strings() {
    assert_eq!(
        serde_json::from_str::<OrthogonalRotation>("90").unwrap(),
        OrthogonalRotation::Clockwise90
    );
    assert_eq!(
        serde_json::from_str::<OrthogonalRotation>(r#""270""#).unwrap(),
        OrthogonalRotation::Clockwise270
    );
    assert_eq!(
        serde_json::to_string(&OrthogonalRotation::Clockwise180).unwrap(),
        "180"
    );
    assert!(serde_json::from_str::<OrthogonalRotation>("45").is_err());
}

#[test]
fn validation_rejects_nonfinite_dpi_and_margins() {
    for dpi in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -300.0] {
        assert!(CleanupOptions {
            dpi,
            ..CleanupOptions::default()
        }
        .validate()
        .is_err());
    }
    assert!(CleanupOptions {
        margins_mm: Some(MarginsMm {
            left_mm: -1.0,
            ..MarginsMm::default()
        }),
        ..CleanupOptions::default()
    }
    .validate()
    .is_err());
}

#[test]
fn advanced_control_ranges_are_validated_and_serialize_additively() {
    for angle in [f64::NEG_INFINITY, -15.1, 15.1, f64::INFINITY, f64::NAN] {
        assert!(CleanupOptions {
            manual_skew_degrees: Some(angle),
            ..CleanupOptions::default()
        }
        .validate()
        .is_err());
    }
    for depth in [f64::NEG_INFINITY, 0.49, 4.01, f64::INFINITY, f64::NAN] {
        assert!(CleanupOptions {
            experimental: super::ExperimentalOptions {
                auto_dewarp: true,
                auto_dewarp_depth: Some(depth),
            },
            ..CleanupOptions::default()
        }
        .validate()
        .is_err());
    }

    let defaults = serde_json::to_value(CleanupOptions::default()).unwrap();
    assert!(defaults.get("manualSkewDegrees").is_none());
    assert!(defaults["experimental"].get("autoDewarpDepth").is_none());

    let options = CleanupOptions {
        manual_skew_degrees: Some(-2.4),
        experimental: super::ExperimentalOptions {
            auto_dewarp: true,
            auto_dewarp_depth: Some(1.7),
        },
        ..CleanupOptions::default()
    };
    options.validate().unwrap();
    let encoded = serde_json::to_value(options).unwrap();
    assert_eq!(encoded["manualSkewDegrees"], -2.4);
    assert_eq!(encoded["experimental"]["autoDewarpDepth"], 1.7);
}

#[test]
fn option_objects_reject_unknown_fields() {
    assert!(serde_json::from_str::<CleanupOptions>(r#"{"unknown":true}"#).is_err());
    assert!(serde_json::from_str::<CleanupOptions>(r#"{"classifyOnly":true}"#).is_err());
    assert!(serde_json::from_str::<CleanupOptions>(
        r#"{"margins":{"leftMm":5,"topMm":5,"rightMm":5,"bottomMm":5,"unknown":true}}"#
    )
    .is_err());
}

#[test]
fn legacy_despeckle_boolean_maps_to_a_default_normal_level() {
    let enabled: CleanupOptions = serde_json::from_str(r#"{"despeckle":true}"#).unwrap();
    assert_eq!(enabled.despeckle_level, DespeckleLevel::Normal);
    assert_eq!(enabled.effective_despeckle_level(), DespeckleLevel::Normal);

    let disabled: CleanupOptions = serde_json::from_str(r#"{"despeckle":false}"#).unwrap();
    assert_eq!(disabled.effective_despeckle_level(), DespeckleLevel::Off);
}

#[test]
fn mixed_mode_and_zone_schema_are_additive_and_rotation_checked() {
    let json = r#"{
        "outputMode":"mixed",
        "manualZones":{
            "picture":[{
                "polygon":{
                    "points":[
                        {"xNormalized":0.1,"yNormalized":0.2},
                        {"xNormalized":0.8,"yNormalized":0.2},
                        {"xNormalized":0.8,"yNormalized":0.9}
                    ],
                    "rotationDegrees":90
                },
                "layer":"eraser3"
            }],
            "fill":[]
        },
        "rotationDegrees":90
    }"#;
    let options: CleanupOptions = serde_json::from_str(json).unwrap();
    assert_eq!(options.output_mode, OutputMode::Mixed);
    assert_eq!(
        options.manual_zones.picture[0].layer,
        PictureZoneLayer::Eraser3
    );
    options.validate().unwrap();

    let old: CleanupOptions = serde_json::from_str(r#"{"outputMode":"bw"}"#).unwrap();
    assert!(old.manual_zones.picture.is_empty());
    assert!(old.manual_zones.fill.is_empty());

    let wrong_rotation = json.replace(
        "\"rotationDegrees\":90\n    }",
        "\"rotationDegrees\":0\n    }",
    );
    let invalid: CleanupOptions = serde_json::from_str(&wrong_rotation).unwrap();
    assert!(invalid.validate().is_err());
}
