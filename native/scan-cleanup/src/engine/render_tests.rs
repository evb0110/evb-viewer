mod tests {
    use super::*;
    use crate::bw::{binarize_normalized, rescue_component_scoped_faint_strokes};
    use crate::protocol::manifest_v3::CanvasScope;
    use crate::split::{FoldBand, FoldBandUnmeasuredReason};
    use jpeg_encoder::{ColorType, Encoder as JpegEncoder, SamplingFactor};
    use std::io::Cursor;
    use zune_jpeg::{
        zune_core::{colorspace::ColorSpace, options::DecoderOptions},
        JpegDecoder,
    };

    fn jpeg_luma_roundtrip(source: &GrayImage, quality: u8) -> GrayImage {
        let width = u16::try_from(source.width()).unwrap();
        let height = u16::try_from(source.height()).unwrap();
        let mut encoded = Vec::new();
        let mut encoder = JpegEncoder::new(&mut encoded, quality);
        encoder.set_sampling_factor(SamplingFactor::F_1_1);
        encoder
            .encode(source.data(), width, height, ColorType::Luma)
            .unwrap();
        let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::Luma);
        let mut decoder = JpegDecoder::new_with_options(Cursor::new(encoded), options);
        let decoded = decoder.decode().unwrap();
        assert_eq!(decoded.len(), source.width() * source.height());
        GrayImage::from_vec(source.width(), source.height(), source.width(), decoded).unwrap()
    }

    #[test]
    fn semantic_region_output_maps_payload_and_metadata_once() {
        let mut color = RgbImage::new(2, 2, [0, 0, 0]);
        color.set(1, 0, [12, 34, 56]);
        let output = map_region_semantic_output(region_rendering::RegionSemanticOutput {
            image: CleanupRaster::Bilevel(BinaryImage::new(2, 2)),
            color_image: Some(color),
            picture_mask: Some(BinaryImage::from_fn_parallel(2, 2, |x, y| x == 1 && y == 0)),
            tone_preservation_alpha: Some(GrayImage::new(2, 2, 7)),
            mixed_layers: None,
            effectively_blank: true,
            metadata: CleanupMetadata {
                source_page_index: 4,
                half: PageHalf::Right,
                detected_skew_degrees: 1.5,
                skew_confidence: 0.8,
                skew_applied: true,
                manual_skew: false,
                layout_classification: LayoutClassification::SingleUncutPage,
                layout_confidence: 0.9,
                cutter_x: Some(10.0),
                split_geometry: Vec::new(),
                split_seam: Some(crate::protocol::manifest_v3::SplitSeamPolyline {
                    points: vec![Point::new(3.0, 4.0), Point::new(5.0, 6.0)],
                }),
                source_region: Rect::new(1.0, 2.0, 2.0, 2.0),
                content_box: None,
                crop_rect: Rect::new(0.0, 0.0, 2.0, 2.0),
                content_diagnostics: None,
                applied_margins: AppliedMargins::default(),
                soft_margins_pixels: [1, 2, 3, 4],
                uniform_canvas: true,
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
                output_mode: OutputMode::Color,
                bilevel_written: false,
                layered_written: false,
                layered_foreground_kind: None,
                layered_background_dpi: None,
                layered_foreground_dpi: None,
                trusted_mrc_background_preserved: false,
                trusted_selection_applied: true,
                illumination_normalized: true,
                text_tone_diagnostics: None,
                binarization_mode: None,
                binarization_diagnostics: None,
                ink_consistency_diagnostics: None,
                despeckle_fallback: false,
                forward_transform: None,
                inverse_transform: None,
                dewarp_model: None,
                dewarp_mapping: None,
                dewarp_confidence: None,
                input_width: 2,
                input_height: 2,
                output_width: 2,
                output_height: 2,
                intrinsic_raster_width: Some(2),
                intrinsic_raster_height: Some(2),
                render_region: None,
                canvas_width: 2,
                canvas_height: 2,
                placement_offset_x: 0,
                placement_offset_y: 0,
                rotation: OrthogonalRotation::None,
                canvas_scope: CanvasScope::Page,
                resample_passes: 1,
                source_dpi: 300.0,
                render_dpi: 300.0,
                requested_render_dpi: 300.0,
                raster_scale_limited: false,
                warnings: vec!["first warning".to_owned(), "second warning".to_owned()],
                warning_events: Vec::new(),
            },
        });

        assert!(output.effectively_blank);
        assert_eq!(output.metadata.canvas_scope, CanvasScope::Page);
        assert_eq!(output.metadata.warnings, ["first warning", "second warning"]);
        assert_eq!(output.metadata.source_page_index, 4);
        assert_eq!(output.metadata.half, PageHalf::Right);
        assert_eq!(output.metadata.split_seam.unwrap().points.len(), 2);
        assert_eq!(output.color_image.expect("mapped color plane").get(1, 0), [12, 34, 56]);
        assert_eq!(output.picture_mask.expect("mapped picture mask").count_black(), 1);
        assert_eq!(output.tone_preservation_alpha.expect("mapped alpha").get(0, 0), 7);
    }

    fn thin_stroke_fixture() -> (GrayImage, Vec<(usize, usize)>) {
        let mut source = GrayImage::new(420, 300, 240);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(
                    x,
                    y,
                    (226 + (x * 12 / source.width()) + (y * 2 / source.height())) as u8,
                );
            }
        }
        let mut path = Vec::new();
        for x in 28..252 {
            let y = (72.0 + 24.0 * (x as f64 / 24.0).sin()).round() as usize;
            path.push((x, y));
            source.set(x, y, 158);
            if x % 3 != 0 && y + 1 < source.height() {
                source.set(x, y + 1, 172);
            }
        }
        for degree in 0..360 {
            let angle = (degree as f64).to_radians();
            let x = (330.0 + 34.0 * angle.cos()).round() as usize;
            let y = (78.0 + 34.0 * angle.sin()).round() as usize;
            path.push((x, y));
            source.set(x, y, 158);
            if degree % 3 != 0 && x + 1 < source.width() {
                source.set(x + 1, y, 172);
            }
        }
        for line in 0..9 {
            let top = 142 + line * 14;
            for word in 0..10 {
                let left = 32 + word * 34;
                for y in top..top + 3 {
                    for x in left..(left + 22).min(source.width() - 20) {
                        source.set(x, y, 62);
                    }
                }
            }
        }
        (source, path)
    }

    fn cleaned_fixture(source: &GrayImage, thickness: i8) -> GrayImage {
        clean_page(
            source,
            &CleanupOptions {
                dpi: 300.0,
                binarization: crate::BinarizationMode::Wolf,
                thickness,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0)
        .image
        .into_gray()
    }

    #[test]
    fn enormous_finite_margins_fail_before_raster_allocation() {
        let source = GrayImage::new(10, 10, 255);
        let error = clean_page(
            &source,
            &CleanupOptions {
                crop_content: false,
                margins_mm: Some(crate::MarginsMm {
                    left_mm: 1e308,
                    top_mm: 1e308,
                    right_mm: 1e308,
                    bottom_mm: 1e308,
                }),
                ..CleanupOptions::default()
            },
            0,
        )
        .err()
        .expect("finite millimetre margins that overflow to pixels must fail");
        assert!(error.contains("finite"));
    }

    #[test]
    fn mixed_partition_does_not_carve_a_confirmed_owner() {
        let mut picture = BinaryImage::new(8, 1);
        picture.set(1, 0, true);
        picture.set(4, 0, true);
        picture.set(6, 0, true);
        let mut zone = BinaryImage::new(8, 1);
        zone.set(4, 0, true);
        zone.set(6, 0, true);
        let mut text_vicinity = BinaryImage::new(8, 1);
        text_vicinity.set(1, 0, true);
        text_vicinity.set(4, 0, true);
        text_vicinity.set(6, 0, true);
        let mut picture_mask = Some(picture);

        partition_mixed_picture_mask(
            &mut picture_mask,
            true,
            None,
            None,
            None,
            Some(&zone),
            Some(&text_vicinity),
            25.4,
            0,
        );

        let picture_mask = picture_mask.expect("vetted owner must survive the Mixed partition");
        assert!(
            picture_mask.get(1, 0),
            "text refinement must not revoke confirmed photo ownership"
        );
        assert!(picture_mask.get(4, 0), "zone pixel remains tone-owned");
        assert!(
            picture_mask.get(6, 0),
            "completed zone pixel remains tone-owned"
        );
        assert_eq!(picture_mask.count_black(), 3);
    }

    #[test]
    fn mixed_partition_zone_alone_does_not_create_picture_ownership() {
        let mut zone = BinaryImage::new(4, 1);
        zone.set(2, 0, true);
        let mut picture_mask = None;

        partition_mixed_picture_mask(
            &mut picture_mask,
            false,
            None,
            None,
            None,
            Some(&zone),
            None,
            25.4,
            0,
        );

        assert!(
            picture_mask.is_none(),
            "halftone evidence alone must not become a picture owner"
        );
    }

    #[test]
    fn mixed_partition_consumes_a_qualified_spatial_tone_owner() {
        let mut spatial = BinaryImage::new(4, 1);
        spatial.set(2, 0, true);
        let mut picture_mask = None;

        partition_mixed_picture_mask(
            &mut picture_mask,
            false,
            Some(&spatial),
            None,
            None,
            None,
            None,
            25.4,
            0,
        );

        assert!(
            picture_mask
                .as_ref()
                .is_some_and(|mask| mask.get(2, 0)),
            "a qualified flat-graphic tone field was discarded before Mixed composition"
        );
    }

    #[test]
    fn mixed_partition_joins_interline_paper_but_keeps_tone_owned() {
        let mut picture = BinaryImage::new(5, 5);
        for y in 0..5 {
            for x in 0..5 {
                picture.set(x, y, true);
            }
        }
        let mut text_vicinity = BinaryImage::new(5, 5);
        for x in 1..=3 {
            text_vicinity.set(x, 1, true);
            text_vicinity.set(x, 3, true);
        }
        let mut tone = BinaryImage::new(5, 5);
        tone.set(2, 2, true);
        let mut picture_mask = Some(picture);

        // 25.4 DPI makes the one-millimetre interline radius exactly one
        // pixel for this compact geometry fixture.
        partition_mixed_picture_mask(
            &mut picture_mask,
            false,
            None,
            None,
            Some(&tone),
            None,
            Some(&text_vicinity),
            25.4,
            0,
        );

        let picture_mask = picture_mask.expect("the surrounding picture field remains");
        assert!(
            !picture_mask.get(1, 2),
            "paper between aligned text lines becomes foreground-owned"
        );
        assert!(
            picture_mask.get(2, 2),
            "calibrated tone remains continuous-tone-owned"
        );
        assert!(
            picture_mask.get(4, 2),
            "vertical joining cannot grow sideways into a neighboring picture"
        );
        assert!(
            picture_mask.get(1, 0) && picture_mask.get(1, 4),
            "closing must not expand beyond the outer text-line boundaries"
        );
    }

    #[test]
    fn mixed_partition_scales_interline_joining_at_realistic_dpi() {
        let mut picture = BinaryImage::new(3, 36);
        for y in 0..36 {
            for x in 0..3 {
                picture.set(x, y, true);
            }
        }
        let mut text_vicinity = BinaryImage::new(3, 36);
        text_vicinity.set(1, 5, true);
        text_vicinity.set(1, 28, true);
        let mut picture_mask = Some(picture);

        partition_mixed_picture_mask(
            &mut picture_mask,
            false,
            None,
            None,
            None,
            None,
            Some(&text_vicinity),
            300.0,
            0,
        );

        let picture_mask = picture_mask.expect("the surrounding picture field remains");
        assert!(
            !picture_mask.get(1, 16),
            "a sub-two-millimetre interline gap joins at 300 DPI"
        );
        assert!(
            picture_mask.get(1, 4) && picture_mask.get(1, 29),
            "the physical close still preserves outer ownership boundaries"
        );
    }

    #[test]
    fn mixed_partition_bridges_only_the_global_intersection_of_a_row_chain() {
        let mut picture = BinaryImage::new(210, 18);
        for y in 0..18 {
            for x in 0..210 {
                picture.set(x, y, true);
            }
        }
        let mut text_vicinity = BinaryImage::new(210, 18);
        for x in 0..=100 {
            for y in 1..=2 {
                text_vicinity.set(x, y, true);
            }
        }
        for x in 0..=200 {
            for y in 8..=9 {
                text_vicinity.set(x, y, true);
            }
        }
        for x in 100..=200 {
            for y in 15..=16 {
                text_vicinity.set(x, y, true);
            }
        }
        let mut picture_mask = Some(picture);

        partition_mixed_picture_mask(
            &mut picture_mask,
            false,
            None,
            None,
            None,
            None,
            Some(&text_vicinity),
            25.4,
            0,
        );

        let picture_mask = picture_mask.expect("the surrounding picture field remains");
        assert!(
            picture_mask.get(50, 5) && picture_mask.get(150, 12),
            "a wide hub cannot bridge two columns without a shared thirty-millimetre intersection"
        );
    }

    #[test]
    fn mixed_partition_bridges_three_aligned_component_rows() {
        let mut picture = BinaryImage::new(50, 18);
        for y in 0..18 {
            for x in 0..50 {
                picture.set(x, y, true);
            }
        }
        let mut text_vicinity = BinaryImage::new(50, 18);
        for x in 5..45 {
            for y in 1..=2 {
                text_vicinity.set(x, y, true);
            }
            for y in 8..=9 {
                text_vicinity.set(x, y, true);
            }
            for y in 15..=16 {
                text_vicinity.set(x, y, true);
            }
        }
        let mut picture_mask = Some(picture);

        partition_mixed_picture_mask(
            &mut picture_mask,
            false,
            None,
            None,
            None,
            None,
            Some(&text_vicinity),
            25.4,
            0,
        );

        let picture_mask = picture_mask.expect("the surrounding picture field remains");
        assert!(
            !picture_mask.get(10, 5) && !picture_mask.get(10, 12),
            "three aligned wide rows own their shared interline paper"
        );
        assert!(
            picture_mask.get(4, 5) && picture_mask.get(45, 12),
            "the bridge cannot grow outside the chain-global intersection"
        );
    }

    #[test]
    fn mixed_partition_allows_larger_gaps_only_for_dense_extra_wide_chains() {
        fn partition(text_line_count: usize, field_right: usize) -> BinaryImage {
            let mut picture = BinaryImage::new(150, 34);
            for y in 0..34 {
                for x in 0..150 {
                    picture.set(x, y, true);
                }
            }
            let mut text_vicinity = BinaryImage::new(150, 34);
            for x in 5..field_right {
                for y in 1..=2 {
                    text_vicinity.set(x, y, true);
                }
                for y in 15..=16 {
                    text_vicinity.set(x, y, true);
                }
                for y in 29..=30 {
                    text_vicinity.set(x, y, true);
                }
            }
            for x in 80..145 {
                for y in 18..=20 {
                    text_vicinity.set(x, y, true);
                }
            }
            let mut zone = BinaryImage::new(150, 34);
            let mut chroma = BinaryImage::new(150, 34);
            for x in 10..16 {
                zone.set(x, 8, true);
            }
            for x in 16..21 {
                chroma.set(x, 8, true);
            }
            let mut picture_mask = Some(picture);
            partition_mixed_picture_mask(
                &mut picture_mask,
                false,
                None,
                Some(&chroma),
                None,
                Some(&zone),
                Some(&text_vicinity),
                25.4,
                text_line_count,
            );
            picture_mask.expect("the surrounding picture field remains")
        }

        let dense_extra_wide = partition(20, 70);
        assert!(
            dense_extra_wide.get(10, 8) && !dense_extra_wide.get(10, 23),
            "a dense 65 mm chain bridges measured gaps but preserves an exact halftone zone"
        );
        assert!(
            dense_extra_wide.get(18, 8),
            "chroma remains exact inside a scanline-bridged column"
        );
        assert!(
            dense_extra_wide.get(100, 23),
            "an intervening right-side run cannot widen the chain intersection into a portrait"
        );
        assert!(
            partition(19, 70).get(10, 23),
            "the dense bridge remains disabled below twenty detected lines"
        );
        assert!(
            partition(20, 34).get(10, 23),
            "sub-thirty-millimetre fields remain below both bridge tiers"
        );
    }

    #[test]
    fn mixed_partition_does_not_bridge_an_isolated_wide_pair() {
        let mut picture = BinaryImage::new(150, 16);
        for y in 0..16 {
            for x in 0..150 {
                picture.set(x, y, true);
            }
        }
        let mut text_vicinity = BinaryImage::new(150, 16);
        for x in 5..70 {
            for y in 2..=3 {
                text_vicinity.set(x, y, true);
            }
            for y in 12..=13 {
                text_vicinity.set(x, y, true);
            }
        }
        let mut picture_mask = Some(picture);

        partition_mixed_picture_mask(
            &mut picture_mask,
            false,
            None,
            None,
            None,
            None,
            Some(&text_vicinity),
            25.4,
            20,
        );

        assert!(
            picture_mask.unwrap().get(10, 8),
            "an isolated aligned pair is insufficient column evidence"
        );
    }

    #[test]
    fn mixed_partition_does_not_join_distant_text_lines() {
        let mut picture = BinaryImage::new(3, 7);
        for y in 0..7 {
            for x in 0..3 {
                picture.set(x, y, true);
            }
        }
        let mut text_vicinity = BinaryImage::new(3, 7);
        text_vicinity.set(1, 1, true);
        text_vicinity.set(1, 5, true);
        let mut picture_mask = Some(picture);

        partition_mixed_picture_mask(
            &mut picture_mask,
            false,
            None,
            None,
            None,
            None,
            Some(&text_vicinity),
            25.4,
            0,
        );

        let picture_mask = picture_mask.expect("the surrounding picture field remains");
        assert!(
            picture_mask.get(1, 3),
            "a gap wider than twice the interline radius remains picture-owned"
        );
    }

    #[test]
    fn affine_fast_paths_and_adaptive_resampler_match_supersampled_golden() {
        let (source, _) = thin_stroke_fixture();
        assert_eq!(
            render_affine_gray(&source, source.width(), source.height(), Affine::IDENTITY),
            source
        );

        let translated = render_affine_gray(
            &source,
            source.width() - 13,
            source.height() - 9,
            Affine::translation(13.0, 9.0),
        );
        for y in 0..translated.height() {
            for x in 0..translated.width() {
                assert_eq!(translated.get(x, y), source.get(x + 13, y + 9));
            }
        }

        let cx = source.width() as f64 * 0.5;
        let cy = source.height() as f64 * 0.5;
        let inverse = Affine::translation(-cx, -cy)
            .then(Affine::rotation_radians(2.7_f64.to_radians()))
            .then(Affine::translation(cx, cy));
        let actual = render_affine_gray(&source, source.width(), source.height(), inverse);
        let reference = render_affine_gray_supersampled_reference(
            &source,
            source.width(),
            source.height(),
            inverse,
        );
        let mut differences = actual
            .data()
            .iter()
            .zip(reference.data())
            .map(|(&left, &right)| left.abs_diff(right))
            .collect::<Vec<_>>();
        differences.sort_unstable();
        let mean = differences
            .iter()
            .map(|&value| f64::from(value))
            .sum::<f64>()
            / differences.len() as f64;
        let p99 = differences[differences.len() * 99 / 100];
        let threshold_mismatches = actual
            .data()
            .iter()
            .zip(reference.data())
            .filter(|(left, right)| (**left < 128) != (**right < 128))
            .count();
        assert!(mean <= 1.5, "mean absolute error={mean:.4}");
        assert!(p99 <= 12, "p99 absolute error={p99}");
        assert!(
            threshold_mismatches * 1_000 <= actual.data().len() * 5,
            "threshold mismatch ratio={:.4}",
            threshold_mismatches as f64 / actual.data().len() as f64
        );
    }

    #[test]
    fn full_cleanup_stays_within_stage_b_supersampling_golden_tolerance() {
        let (source, _) = thin_stroke_fixture();
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: crate::BinarizationMode::Wolf,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let normalized = normalize_illumination(&source, options.dpi);
        let deskew = detect_skew(&normalized, options.dpi);
        let inverse = deskew_transform(normalized.width(), normalized.height(), deskew)
            .inverse()
            .unwrap();
        let stage_b_render = render_affine_gray_supersampled_reference(
            &normalized,
            normalized.width(),
            normalized.height(),
            inverse,
        );
        let stage_b_golden = binary_to_gray(&binarize_normalized(&stage_b_render, &options).0);
        let actual = clean_page(&source, &options, 0)
            .unwrap()
            .outputs
            .remove(0)
            .image
            .into_gray();
        let mismatches = actual
            .data()
            .iter()
            .zip(stage_b_golden.data())
            .filter(|(left, right)| left != right)
            .count();
        let ratio = mismatches as f64 / actual.data().len() as f64;
        assert!(ratio <= 0.001, "binary mismatch ratio={ratio:.6}");
    }

    #[test]
    fn soft_shallow_horizontal_bleed_is_removed_without_losing_crisp_glyphs() {
        let mut raw = GrayImage::new(180, 100, 220);
        let mut binary = BinaryImage::new(180, 100);
        let mut glyph_pixels = 0;
        for left in [24, 70, 116] {
            for y in 22..44 {
                for x in left..left + 12 {
                    raw.set(x, y, 35);
                    binary.set(x, y, true);
                    glyph_pixels += 1;
                }
            }
        }
        for y in 43usize..64 {
            let distance = y.abs_diff(53).min(10);
            let value = 180 + (distance * 4) as u8;
            for x in 12..168 {
                raw.set(x, y, value);
            }
        }
        for y in 50..56 {
            for x in 12..168 {
                binary.set(x, y, true);
            }
        }

        let filtered = filter_soft_shallow_bleed_components(&binary, &raw, None, None, None, 360.0);

        assert_eq!(
            (12..168)
                .flat_map(|x| (50..56).map(move |y| (x, y)))
                .filter(|&(x, y)| filtered.get(x, y))
                .count(),
            0
        );
        assert_eq!(
            (24..36)
                .chain(70..82)
                .chain(116..128)
                .flat_map(|x| (22..44).map(move |y| (x, y)))
                .filter(|&(x, y)| filtered.get(x, y))
                .count(),
            glyph_pixels
        );
        assert_eq!(filtered.count_black(), glyph_pixels);
    }

    #[test]
    fn explicit_rescue_keeps_faint_text_but_final_bleed_filter_kills_showthrough() {
        let mut raw = GrayImage::new(180, 100, 220);
        let mut damaged = BinaryImage::new(180, 100);
        let mut text_vicinity = BinaryImage::new(180, 100);
        for left in [24, 70, 116] {
            for y in 22..44 {
                for x in left..left + 12 {
                    raw.set(x, y, 35);
                    text_vicinity.set(x, y, true);
                }
            }
        }
        for y in 43usize..64 {
            let distance = y.abs_diff(53).min(10);
            let value = 180 + (distance * 4) as u8;
            for x in 12..168 {
                raw.set(x, y, value);
                if (50..56).contains(&y) {
                    damaged.set(x, y, true);
                }
            }
        }

        let rescued = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            crate::BinarizationMode::Wolf,
            crate::BinarizationMode::Wolf,
            360.0,
            false,
        );
        let filtered =
            filter_soft_shallow_bleed_components(&rescued, &raw, None, None, None, 360.0);

        assert!((24..36).all(|x| filtered.get(x, 30)));
        assert_eq!(
            (12..168)
                .flat_map(|x| (50..56).map(move |y| (x, y)))
                .filter(|&(x, y)| filtered.get(x, y))
                .count(),
            0,
            "the final bleed authority must remove show-through even after rescue"
        );
    }

    #[test]
    fn soft_underline_below_text_row_is_preserved() {
        let mut raw = GrayImage::new(420, 160, 220);
        let mut binary = BinaryImage::new(420, 160);
        let mut text_mask = BinaryImage::new(420, 160);
        let mut text_vicinity = BinaryImage::new(420, 160);
        for left in [54, 112, 170, 228, 286] {
            for y in 36..58 {
                for x in left..left + 26 {
                    raw.set(x, y, 35);
                    binary.set(x, y, true);
                    text_mask.set(x, y, true);
                }
            }
        }
        for y in 32..62 {
            for x in 48..372 {
                text_vicinity.set(x, y, true);
            }
        }
        for y in 72..74 {
            for x in 48..372 {
                raw.set(x, y, 120);
                binary.set(x, y, true);
            }
        }
        for y in 74..80 {
            for x in 48..372 {
                raw.set(x, y, 180);
                binary.set(x, y, true);
            }
        }

        let filtered = filter_soft_shallow_bleed_components(
            &binary,
            &raw,
            None,
            Some(&text_mask),
            Some(&text_vicinity),
            360.0,
        );

        assert!((48..372).all(|x| (72..80).all(|y| filtered.get(x, y))));
        assert!([54, 112, 170, 228, 286]
            .into_iter()
            .all(|left| (left..left + 26).all(|x| (36..58).all(|y| filtered.get(x, y)))));
    }

    #[test]
    fn raw_rule_recovery_is_an_exact_source_support_subset() {
        let mut raw = GrayImage::new(420, 160, 220);
        let mut binary = BinaryImage::new(420, 160);
        let mut text_mask = BinaryImage::new(420, 160);
        let mut text_vicinity = BinaryImage::new(420, 160);
        for left in [54, 112, 170, 228, 286] {
            for y in 36..58 {
                for x in left..left + 26 {
                    raw.set(x, y, 35);
                    binary.set(x, y, true);
                    text_mask.set(x, y, true);
                }
            }
        }
        for y in 32..62 {
            for x in 48..372 {
                text_vicinity.set(x, y, true);
            }
        }
        for y in 72..74 {
            for x in 48..372 {
                raw.set(x, y, if y == 72 { 100 } else { 120 });
            }
        }
        for x in 8..12 {
            binary.set(x, 8, true);
        }

        let restored = restore_genuine_horizontal_rules(
            &binary,
            &raw,
            None,
            Some(&text_mask),
            Some(&text_vicinity),
            360.0,
        );

        let raw_dark_floor = paper_reference(&raw).saturating_sub(RULE_RAW_DEPTH);
        for y in 0..restored.height() {
            for x in 0..restored.width() {
                if restored.get(x, y) {
                    assert!(
                        binary.get(x, y) || raw.get(x, y) <= raw_dark_floor,
                        "restored pixel ({x}, {y}) lacks input or raw support"
                    );
                }
            }
        }
        assert!((48..372).all(|x| (72..74).all(|y| restored.get(x, y))));
        assert!(!(48..372).any(|x| restored.get(x, 74)));
        assert!([54, 112, 170, 228, 286]
            .into_iter()
            .all(|left| (left..left + 26).all(|x| (36..58).all(|y| restored.get(x, y)))));

        let clean_paper = GrayImage::new(420, 160, 220);
        let clean_output = restore_genuine_horizontal_rules(
            &BinaryImage::new(420, 160),
            &clean_paper,
            None,
            None,
            None,
            360.0,
        );
        assert_eq!(clean_output.count_black(), 0);
    }

    #[test]
    fn bridged_text_line_is_never_restored_as_a_rule() {
        // Candidacy is measured on a horizontally bridged map, which fuses the
        // glyphs of a text line into a single long blob. Admitting that blob
        // re-inks the whole line at the rule depth instead of the page's
        // binarization threshold, printing footnote and index lines visibly
        // bolder than their neighbours. Only thickness separates the two, so a
        // line of type must be rejected however long it is.
        let mut raw = GrayImage::new(420, 200, 220);
        let mut binary = BinaryImage::new(420, 200);
        let mut text_vicinity = BinaryImage::new(420, 200);

        for y in 20..48 {
            for x in 48..372 {
                text_vicinity.set(x, y, true);
            }
        }

        // Glyph-height marks: taller than a 2mm rule at 360 dpi, and gapped
        // closely enough that bridging fuses them into one wide component.
        // Odd columns are dark in `raw` but absent from `binary`, so any rule
        // restore over this line would be visible as added ink.
        for left in (60..360).step_by(40) {
            for y in 70..100 {
                for x in left..left + 30 {
                    raw.set(x, y, 60);
                    if x % 2 == 0 {
                        binary.set(x, y, true);
                    }
                }
            }
        }

        // A genuine thin rule on the same page must still be recovered.
        for y in 150..152 {
            for x in 48..372 {
                raw.set(x, y, 120);
            }
        }

        let restored =
            restore_genuine_horizontal_rules(&binary, &raw, None, None, Some(&text_vicinity), 360.0);

        assert!(
            (60..360)
                .step_by(40)
                .all(|left| (left..left + 30)
                    .filter(|x| x % 2 == 1)
                    .all(|x| (70..100).all(|y| !restored.get(x, y)))),
            "a bridged text line was re-inked as a horizontal rule"
        );
        assert!(
            (48..372).all(|x| (150..152).all(|y| restored.get(x, y))),
            "the genuine thin rule was no longer recovered"
        );
    }

    #[test]
    fn rule_admission_tracks_the_two_millimetre_thickness_bound() {
        // Thickness alone decides admission, so the boundary between a printed
        // rule and a line of type is a physical 2 mm that has to survive the
        // pixel rounding at whatever dpi a page renders at. 360 dpi rounds the
        // bound down to 28 px and the 299 dpi the spread CLI renders with
        // rounds it up to 24, so both sides are pinned at both densities.
        for (dpi, admitted, rejected) in [(360.0_f64, 28usize, 29usize), (299.0, 24, 25)] {
            let mut raw = GrayImage::new(640, 520, 220);
            let binary = BinaryImage::new(640, 520);
            let mut text_vicinity = BinaryImage::new(640, 520);

            // Each band needs a text row inside the 14 mm lookback above it,
            // so the two differ in thickness and in nothing else.
            for (top, thickness) in [(140usize, admitted), (380, rejected)] {
                for y in top - 80..top - 50 {
                    for x in 40..600 {
                        text_vicinity.set(x, y, true);
                    }
                }
                for y in top..top + thickness {
                    for x in 40..600 {
                        raw.set(x, y, 120);
                    }
                }
            }

            let restored = restore_genuine_horizontal_rules(
                &binary,
                &raw,
                None,
                None,
                Some(&text_vicinity),
                dpi,
            );

            assert!(
                (140..140 + admitted).all(|y| (40..600).all(|x| restored.get(x, y))),
                "a {admitted} px band exactly at the 2 mm bound was rejected at {dpi} dpi"
            );
            assert!(
                (380..380 + rejected).all(|y| (40..600).all(|x| !restored.get(x, y))),
                "a {rejected} px band one pixel over the 2 mm bound was admitted at {dpi} dpi"
            );
        }
    }

    #[test]
    fn thin_rule_below_text_survives_binarize_postprocess_and_bleed_chain() {
        let mut raw = GrayImage::new(420, 160, 220);
        let mut text_mask = BinaryImage::new(420, 160);
        let mut text_vicinity = BinaryImage::new(420, 160);
        for left in [54, 112, 170, 228, 286] {
            for y in 36..58 {
                for x in left..left + 26 {
                    raw.set(x, y, 35);
                    text_mask.set(x, y, true);
                }
            }
        }
        for y in 32..62 {
            for x in 48..372 {
                text_vicinity.set(x, y, true);
            }
        }
        for y in 72..74 {
            for x in 48..372 {
                raw.set(x, y, 120);
            }
        }
        let options = CleanupOptions {
            dpi: 360.0,
            binarization: crate::BinarizationMode::Wolf,
            normalize_illumination: false,
            despeckle: true,
            despeckle_level: crate::DespeckleLevel::Normal,
            ..CleanupOptions::default()
        };
        let calibration =
            PageCalibration::estimate(&raw, options.dpi, CalibrationConfig::default());
        let (binary, _, _, _) = binarize_normalized_with_diagnostics(
            &raw,
            &raw,
            resolve_binarization_diagnostics(&raw, &options),
            None,
            &options,
            calibration,
            None,
            Some(&text_vicinity),
            None,
        );
        let binary = restore_genuine_horizontal_rules(
            &binary,
            &raw,
            None,
            Some(&text_mask),
            Some(&text_vicinity),
            options.dpi,
        );
        let binary = filter_soft_shallow_bleed_components(
            &binary,
            &raw,
            None,
            Some(&text_mask),
            Some(&text_vicinity),
            options.dpi,
        );

        assert!((48..372).all(|x| (72..74).all(|y| binary.get(x, y))));
    }

    #[test]
    fn soft_strike_through_crossing_text_is_still_stripped() {
        let mut raw = GrayImage::new(420, 160, 220);
        let mut binary = BinaryImage::new(420, 160);
        let mut text_mask = BinaryImage::new(420, 160);
        for y in 50usize..64 {
            let distance = y.abs_diff(57).min(7);
            let value = 180 + (distance * 4) as u8;
            for x in 48..372 {
                raw.set(x, y, value);
            }
        }
        for left in [64, 132] {
            for y in 42..70 {
                for x in left..left + 34 {
                    raw.set(x, y, 35);
                    binary.set(x, y, true);
                    text_mask.set(x, y, true);
                }
            }
        }
        for y in 54..60 {
            for x in 48..372 {
                binary.set(x, y, true);
            }
        }

        let filtered =
            restore_genuine_horizontal_rules(&binary, &raw, None, Some(&text_mask), None, 360.0);
        let filtered = filter_soft_shallow_bleed_components(
            &filtered,
            &raw,
            None,
            Some(&text_mask),
            None,
            360.0,
        );

        assert!((200..260).all(|x| (54..60).all(|y| !filtered.get(x, y))));
        assert!((64..98).all(|x| (42..70).all(|y| filtered.get(x, y))));
        assert!((132..166).all(|x| (42..70).all(|y| filtered.get(x, y))));
    }

    #[test]
    fn soft_showthrough_below_text_row_is_still_removed() {
        let mut raw = GrayImage::new(420, 160, 220);
        let mut binary = BinaryImage::new(420, 160);
        let mut text_mask = BinaryImage::new(420, 160);
        let mut text_vicinity = BinaryImage::new(420, 160);
        for left in [64, 132, 200] {
            for y in 36..58 {
                for x in left..left + 30 {
                    raw.set(x, y, 35);
                    binary.set(x, y, true);
                    text_mask.set(x, y, true);
                }
            }
        }
        for y in 32..62 {
            for x in 48..372 {
                text_vicinity.set(x, y, true);
            }
        }
        for y in 64usize..88 {
            let distance = y.abs_diff(76).min(12);
            let value = 180 + (distance * 3) as u8;
            for x in 48..372 {
                raw.set(x, y, value);
            }
        }
        for y in 72..80 {
            for x in 48..372 {
                binary.set(x, y, true);
            }
        }

        let filtered = restore_genuine_horizontal_rules(
            &binary,
            &raw,
            None,
            Some(&text_mask),
            Some(&text_vicinity),
            360.0,
        );
        let filtered = filter_soft_shallow_bleed_components(
            &filtered,
            &raw,
            None,
            Some(&text_mask),
            Some(&text_vicinity),
            360.0,
        );

        assert!((48..372).all(|x| (72..80).all(|y| !filtered.get(x, y))));
        assert!((64..94).all(|x| (36..58).all(|y| filtered.get(x, y))));
    }

    #[test]
    fn reused_analysis_otsu_is_bit_exact_to_independent_final_binarization() {
        let mut source = GrayImage::new(513, 377, 242);
        let mut state = 0x84b5_13d9_u64;
        for y in 0..source.height() {
            for x in 0..source.width() {
                state = state
                    .wrapping_mul(2_862_933_555_777_941_757)
                    .wrapping_add(3_037_000_493);
                let noise = ((state >> 60) as i16 - 8).clamp(-8, 7);
                let value = (242_i16 + noise).clamp(0, 255) as u8;
                source.set(x, y, value);
            }
        }
        for y in (40..340).step_by(19) {
            for x in 38..475 {
                source.set(x, y, 24);
                source.set(x, y + 1, 24);
            }
        }
        let options = CleanupOptions {
            dpi: 150.0,
            normalize_illumination: false,
            binarization: crate::BinarizationMode::Otsu,
            thickness: 0,
            crop_content: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            layout: crate::LayoutMode::Auto,
            ..CleanupOptions::default()
        };
        let mut timings = PageStageTimings::default();
        let prepared = prepare_analysis_page(
            &source,
            None,
            &options,
            true,
            PageRenderPolicy::COMPLETE,
            None,
            CalibrationConfig::default(),
            None,
            None,
            &mut timings,
        );
        assert_eq!(
            prepared.split.classification,
            LayoutClassification::SingleUncutPage
        );
        assert!(prepared.split.reusable_binary.is_some());
        let expected = binary_to_gray(&binarize_normalized(&source, &options).0);
        let actual = clean_page(&source, &options, 0)
            .unwrap()
            .outputs
            .remove(0)
            .image
            .into_gray();
        assert_eq!(actual, expected);
    }

    fn spread_fixture() -> GrayImage {
        let mut source = GrayImage::new(320, 200, 245);
        for y in (35..165).step_by(14) {
            for word in 0..7 {
                for x in 24 + word * 18..(36 + word * 18).min(142) {
                    source.set(x, y, 18);
                    source.set(x, y + 1, 18);
                    source.set(x, y + 2, 18);
                }
            }
            for word in 0..7 {
                for x in 178 + word * 18..(190 + word * 18).min(296) {
                    source.set(x, y, 22);
                    source.set(x, y + 1, 22);
                    source.set(x, y + 2, 22);
                }
            }
        }
        for y in 4..196 {
            source.set(159, y, 105);
            source.set(160, y, 175);
        }
        source
    }

    fn draw_display_glyphs(
        image: &mut GrayImage,
        left: usize,
        top: usize,
        glyphs: usize,
        width: usize,
        height: usize,
        gap: usize,
    ) {
        for glyph in 0..glyphs {
            let glyph_left = left + glyph * (width + gap);
            for y in top..top + height {
                for x in glyph_left..glyph_left + width {
                    if x < glyph_left + 3
                        || x + 3 >= glyph_left + width
                        || y < top + 3
                        || y + 3 >= top + height
                    {
                        image.set(x, y, 24);
                    }
                }
            }
        }
    }

    fn page_seven_trim_twin() -> GrayImage {
        let mut source = GrayImage::new(620, 760, 245);
        for y in 28..38 {
            for x in 32..588 {
                source.set(x, y, 16);
            }
        }
        for y in 44..62 {
            for x in 286..304 {
                source.set(x, y, 20);
            }
        }
        for y in 132..280 {
            for x in 150..424 {
                // One photographic plate: a dark frame and wide shadow
                // bands sealing midtone strips. Every dark component is
                // far larger than a glyph, so page calibration keeps its
                // x-height from the body text, while the bands feed the
                // halftone classifier's rank cascade and the sealed
                // midtones carry the tonal spread.
                let frame = !(162..412).contains(&x) || !(144..268).contains(&y);
                let band = (170..206).contains(&y) || (226..262).contains(&y);
                let value = if frame || band {
                    30 + ((x * 37 + y * 61) % 24) as u8
                } else {
                    120 + ((x * 13 + y * 41) % 48) as u8
                };
                source.set(x, y, value);
            }
        }
        draw_display_glyphs(&mut source, 226, 342, 8, 11, 24, 6);
        for row in 0..13 {
            let top = 408 + row * 22;
            draw_display_glyphs(&mut source, 62, top, 9, 10, 14, 5);
            draw_display_glyphs(&mut source, 330, top, 9, 10, 14, 5);
        }
        source
    }

    fn faint_top_furniture_fixture() -> (GrayImage, BinaryImage) {
        let mut source = GrayImage::new(620, 760, 245);
        let mut trusted_foreground = BinaryImage::new(620, 760);
        // A real scanner bar is edge-attached and must remain outside the
        // content crop even when the running ornament below it is protected.
        for y in 0..9 {
            for x in 0..620 {
                source.set(x, y, 18);
            }
        }
        // A faint, repeated running ornament like the Rome fixture's Greek
        // key is visible to layout analysis but is vulnerable to quality
        // normalization unless its text vicinity is carried forward.
        for glyph in 0..25 {
            let left = 55 + glyph * 20;
            for y in 44..62 {
                for x in left..left + 12 {
                    if x < left + 3 || x + 3 >= left + 12 || !(47..59).contains(&y) {
                        source.set(x, y, 142);
                        trusted_foreground.set(x, y, true);
                    }
                }
            }
        }
        draw_display_glyphs(&mut source, 190, 150, 10, 11, 24, 6);
        for row in 0..23 {
            let top = 210 + row * 22;
            draw_display_glyphs(&mut source, 62, top, 9, 10, 14, 5);
            draw_display_glyphs(&mut source, 330, top, 9, 10, 14, 5);
        }
        (source, trusted_foreground)
    }

    fn dark_pixels_in_source_rect(output: &CleanupResult, source_rect: Rect) -> usize {
        let crop = output.metadata.crop_rect;
        let left = (source_rect.x - crop.x).floor().max(0.0) as usize;
        let top = (source_rect.y - crop.y).floor().max(0.0) as usize;
        let right = (source_rect.right() - crop.x)
            .ceil()
            .clamp(0.0, output.image.width() as f64) as usize;
        let bottom = (source_rect.bottom() - crop.y)
            .ceil()
            .clamp(0.0, output.image.height() as f64) as usize;
        (top..bottom)
            .flat_map(|y| (left..right).map(move |x| (x, y)))
            .filter(|&(x, y)| output.image.get(x, y) < 224)
            .count()
    }

    #[test]
    #[ignore = "full-raster mode matrix runs in the native CI corpus lane"]
    fn page_seven_twin_protects_picture_and_heading_in_every_output_mode() {
        let source = page_seven_trim_twin();
        for output_mode in [OutputMode::Auto, OutputMode::Mixed, OutputMode::Bw] {
            let output = clean_page(
                &source,
                &CleanupOptions {
                    dpi: 150.0,
                    output_mode,
                    crop_content: true,
                    normalize_illumination: false,
                    layout: crate::LayoutMode::Single,
                    margins_mm: None,
                    margins_pixels: Some([0.0; 4]),
                    ..CleanupOptions::default()
                },
                6,
            )
            .unwrap()
            .outputs
            .remove(0);
            let content = output.metadata.content_box.unwrap();
            assert!(
                content.y <= 132.0 && content.bottom() >= 686.0,
                "mode={output_mode:?} content={content:?} diagnostics={:?}",
                output.metadata.content_diagnostics
            );
            assert!(
                output.metadata.crop_rect.y <= 132.0,
                "mode={output_mode:?} crop={:?}",
                output.metadata.crop_rect
            );
            let diagnostics = output.metadata.content_diagnostics.as_ref().unwrap();
            assert!(
                diagnostics
                    .protected_blocks
                    .iter()
                    .any(|block| block.picture_mask_overlap_pixels > 0),
                "mode={output_mode:?} missing picture evidence: {diagnostics:?}"
            );
            assert!(
                diagnostics
                    .protected_blocks
                    .iter()
                    .any(|block| block.heading_evidence),
                "mode={output_mode:?} missing heading evidence: {diagnostics:?}"
            );
            assert!(
                dark_pixels_in_source_rect(&output, Rect::new(150.0, 132.0, 274.0, 148.0),) > 2_500,
                "mode={output_mode:?} illustration pixels were cropped"
            );
            assert!(
                dark_pixels_in_source_rect(&output, Rect::new(226.0, 342.0, 130.0, 24.0),) > 250,
                "mode={output_mode:?} heading pixels were cropped"
            );
        }
    }

    /// Paper with just enough grain to be a scan and far too little local
    /// spread to read as tone itself.
    fn grained_paper() -> GrayImage {
        let mut source = GrayImage::new(900, 1200, 244);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(x, y, 242 + ((x * 5 + y * 3) % 5) as u8);
            }
        }
        source
    }

    /// A lifted leaf corner whose shadow sweeps in from the outer edge across
    /// most of the page foot, far deeper than the 1/40 border zone and than
    /// the crop planner's own 1/8 frame corridor, with ordinary body text well
    /// above it. The band is coherent midtone, so the page's outside-text tone
    /// evidence claims it; it is also textbook `horizontal_shadow` geometry
    /// for the ownership gate.
    fn bottom_edge_shadow_band_fixture() -> GrayImage {
        let mut source = grained_paper();
        for y in 1000..1160 {
            for x in 0..700 {
                source.set(x, y, 150 + ((x * 7 + y * 13) % 46) as u8);
            }
        }
        for row in 0..30 {
            let top = 200 + row * 23;
            draw_display_glyphs(&mut source, 150, top, 9, 10, 14, 5);
            draw_display_glyphs(&mut source, 460, top, 9, 10, 14, 5);
        }
        source
    }

    /// A flat-shaded plate printed as a fine line screen, with a caption
    /// below it. The screen is too regular for the picture detector, which
    /// leaves the plate with no picture owner at all, so the page's coherent
    /// outside-text tone is the only evidence of its extent. This is the case
    /// the crop planner's tone union exists for: without it the crop keeps
    /// the caption and trims the plate off the page.
    fn flat_shaded_plate_fixture() -> GrayImage {
        let mut source = grained_paper();
        for y in 120..620 {
            for x in 180..720 {
                source.set(x, y, 170 + ((x + y) % 2) as u8 * 18);
            }
        }
        for row in 0..20 {
            let top = 700 + row * 23;
            draw_display_glyphs(&mut source, 300, top, 9, 10, 14, 5);
        }
        source
    }

    fn crop_planner_boxes(source: &GrayImage) -> (Rect, Rect) {
        let metadata = clean_page(
            source,
            &CleanupOptions {
                dpi: 150.0,
                output_mode: OutputMode::Auto,
                crop_content: true,
                normalize_illumination: true,
                layout: crate::LayoutMode::Single,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0)
        .metadata;
        // The shipped rectangle is what the reader receives, so both tests
        // assert on that. `content_box` is the planner's intermediate finding
        // and can agree with a crop that was later clamped or widened.
        (
            metadata
                .content_box
                .expect("body text must produce a content box"),
            metadata.crop_rect,
        )
    }

    #[test]
    fn coherent_tone_cannot_hand_the_crop_a_shadow_the_owner_gate_rejects() {
        let (content, crop) = crop_planner_boxes(&bottom_edge_shadow_band_fixture());
        assert!(
            (870.0..=950.0).contains(&content.bottom()),
            "the content box must end with the body text, not on the scanner shadow: {content:?}"
        );
        assert!(
            (870.0..=950.0).contains(&crop.bottom()),
            "the shipped crop must end with the body text, not on the scanner shadow: {crop:?}"
        );
    }

    #[test]
    fn coherent_tone_still_gives_the_crop_a_flat_shaded_plate() {
        let (content, crop) = crop_planner_boxes(&flat_shaded_plate_fixture());
        assert!(
            content.y <= 130.0 && content.x <= 190.0 && content.right() >= 700.0,
            "the flat-shaded plate was trimmed out of the content box: {content:?}"
        );
        assert!(
            crop.y <= 130.0 && crop.x <= 190.0 && crop.right() >= 700.0,
            "the flat-shaded plate was trimmed out of the shipped crop: {crop:?}"
        );
    }

    #[test]
    fn normalized_bw_crop_keeps_faint_top_furniture_but_rejects_scanner_band() {
        let (source, trusted_foreground) = faint_top_furniture_fixture();
        let options = CleanupOptions {
            dpi: 150.0,
            output_mode: OutputMode::Bw,
            normalize_illumination: true,
            crop_content: true,
            layout: crate::LayoutMode::Single,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            ..CleanupOptions::default()
        };
        let mut timings = PageStageTimings::default();
        let output = clean_page_with_color_and_calibration_config(
            &source,
            None,
            None,
            Some(&trusted_foreground),
            None,
            &options,
            0,
            CalibrationConfig::default(),
            None,
            None,
            PageRenderPolicy {
                recommend_output_mode: false,
                ..PageRenderPolicy::COMPLETE
            },
            &mut timings,
        )
        .unwrap()
        .outputs
        .remove(0);

        let content = output.metadata.content_box.unwrap();
        assert!(
            content.y > 9.0 && content.y <= 44.0,
            "content must reject the scanner band and include the ornament: {content:?}"
        );
        assert!(
            output.metadata.crop_rect.y > 9.0 && output.metadata.crop_rect.y <= 44.0,
            "crop must reject the scanner band and include the ornament: {:?}",
            output.metadata.crop_rect
        );
        assert!(output.metadata.trusted_selection_applied);
        assert!(
            dark_pixels_in_source_rect(&output, Rect::new(55.0, 44.0, 492.0, 18.0)) > 2_000,
            "trusted running ornament was cropped or erased"
        );
        let diagnostics = output.metadata.content_diagnostics.as_ref().unwrap();
        assert!(
            diagnostics.protected_blocks.iter().any(|block| {
                block.bounds.y_px <= 44 && (block.heading_evidence || block.text_evidence)
            }),
            "top furniture lacks content evidence: {diagnostics:?}"
        );
    }

    fn single_page_fixture() -> GrayImage {
        let mut source = GrayImage::new(180, 280, 245);
        for y in (32..248).step_by(16) {
            for word in 0..7 {
                for x in 22 + word * 19..(34 + word * 19).min(158) {
                    source.set(x, y, 20);
                    source.set(x, y + 1, 20);
                }
            }
        }
        source
    }

    fn iou(left: Rect, right: Rect) -> f64 {
        let x0 = left.x.max(right.x);
        let y0 = left.y.max(right.y);
        let x1 = left.right().min(right.right());
        let y1 = left.bottom().min(right.bottom());
        let intersection = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
        intersection / (left.width * left.height + right.width * right.height - intersection)
    }

    fn ink_bounds(image: &GrayImage, threshold: u8) -> Option<(usize, usize, usize, usize)> {
        let mut bounds: Option<(usize, usize, usize, usize)> = None;
        for y in 0..image.height() {
            for x in 0..image.width() {
                if image.get(x, y) >= threshold {
                    continue;
                }
                bounds = Some(match bounds {
                    None => (x, y, x, y),
                    Some((left, top, right, bottom)) => {
                        (left.min(x), top.min(y), right.max(x), bottom.max(y))
                    }
                });
            }
        }
        bounds
    }

    fn rotated_text_page(angle_degrees: f64) -> GrayImage {
        let mut source = GrayImage::new(360, 280, 255);
        for line in 0..11 {
            let top = 52 + line * 16;
            for word in 0..8 {
                let left = 62 + word * 30 + line % 3;
                for y in top..top + 4 {
                    for x in left..left + 21 {
                        source.set(x, y, 20);
                    }
                }
            }
        }
        let mut rotated = GrayImage::new(source.width(), source.height(), 255);
        let angle = angle_degrees.to_radians();
        let (sine, cosine) = angle.sin_cos();
        let cx = source.width() as f64 * 0.5;
        let cy = source.height() as f64 * 0.5;
        for y in 0..rotated.height() {
            for x in 0..rotated.width() {
                let dx = x as f64 - cx;
                let dy = y as f64 - cy;
                let source_x = cosine * dx + sine * dy + cx;
                let source_y = -sine * dx + cosine * dy + cy;
                if source_x >= 0.0
                    && source_y >= 0.0
                    && source_x < source.width() as f64
                    && source_y < source.height() as f64
                {
                    rotated.set(
                        x,
                        y,
                        source.get(
                            source_x.round().min((source.width() - 1) as f64) as usize,
                            source_y.round().min((source.height() - 1) as f64) as usize,
                        ),
                    );
                }
            }
        }
        rotated
    }

    #[test]
    fn ocr_pipeline_preserves_dimensions_and_invertible_transform() {
        let mut source = GrayImage::new(160, 100, 240);
        for y in (20..80).step_by(12) {
            for x in 20..140 {
                source.set(x, y, 20);
                source.set(x, y + 1, 20);
            }
        }
        let result = clean_page(
            &source,
            &CleanupOptions {
                ocr_mode: true,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert_eq!(result.outputs.len(), 1);
        let output = &result.outputs[0];
        assert_eq!((output.image.width(), output.image.height()), (160, 100));
        let point = Point::new(40.5, 50.5);
        let restored = output
            .metadata
            .inverse_transform
            .unwrap()
            .apply(output.metadata.forward_transform.unwrap().apply(point));
        assert!((restored.x - point.x).abs() < 1e-8);
    }

    #[test]
    fn default_bw_preserves_thin_curves_and_thickness_is_monotonic() {
        let (source, path) = thin_stroke_fixture();
        let thin = cleaned_fixture(&source, -5);
        let normal = cleaned_fixture(&source, 0);
        let thick = cleaned_fixture(&source, 5);
        let connected = path
            .iter()
            .filter(|&&(x, y)| {
                (y.saturating_sub(1)..=(y + 1).min(normal.height() - 1)).any(|ny| {
                    (x.saturating_sub(1)..=(x + 1).min(normal.width() - 1))
                        .any(|nx| normal.get(nx, ny) == 0)
                })
            })
            .count();
        let connectivity = connected as f64 / path.len() as f64;
        // The identity affine path now preserves source samples exactly instead of
        // receiving the old 4x4 resampler's incidental blur. The deliberately
        // sub-threshold curve still retains more than 95% local connectivity.
        assert!(
            connectivity >= 0.95,
            "thin-stroke connectivity was {connectivity:.4}"
        );
        let black = |image: &GrayImage| image.data().iter().filter(|&&value| value == 0).count();
        assert!(
            black(&thin) < black(&normal) && black(&normal) < black(&thick),
            "black counts were thin={}, normal={}, thick={}",
            black(&thin),
            black(&normal),
            black(&thick)
        );
    }

    #[test]
    fn grayscale_output_keeps_midtones() {
        let mut source = GrayImage::new(120, 80, 230);
        for y in 20..60 {
            for x in 20..100 {
                source.set(x, y, 70 + ((x + y) % 100) as u8);
            }
        }
        let result = clean_page(
            &source,
            &CleanupOptions {
                output_mode: OutputMode::Grayscale,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert!(result.outputs[0]
            .image
            .to_gray()
            .data()
            .iter()
            .any(|value| (1..255).contains(value)));
        assert_eq!(result.outputs[0].metadata.binarization_mode, None);
    }

    #[test]
    fn color_output_preserves_hue_and_uses_grayscale_geometry() {
        let mut gray = GrayImage::new(120, 90, 245);
        let mut color = RgbImage::new(120, 90, [245; 3]);
        for y in 24..66 {
            for x in 30..90 {
                gray.set(x, y, 90);
                color.set(x, y, [220, 35, 45]);
            }
        }
        let base = CleanupOptions {
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            match_page_size: false,
            ..CleanupOptions::default()
        };
        let grayscale = clean_page(
            &gray,
            &CleanupOptions {
                output_mode: OutputMode::Grayscale,
                ..base.clone()
            },
            0,
        )
        .unwrap();
        let colored = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                output_mode: OutputMode::Color,
                ..base
            },
            0,
        )
        .unwrap();
        assert_eq!(
            colored.outputs[0].metadata.forward_transform,
            grayscale.outputs[0].metadata.forward_transform
        );
        assert_eq!(colored.outputs[0].metadata.resample_passes, 1);
        assert!(!colored.outputs[0].metadata.illumination_normalized);
        let color_image = colored.outputs[0].color_image.as_ref().unwrap();
        assert_eq!(color_image, &color);
        let patch = color_image.get(60, 45);
        assert!(patch[0] > 180 && patch[0] > patch[1] * 3 && patch[0] > patch[2] * 3);
    }

    #[test]
    fn color_normalization_whitens_tinted_paper_and_preserves_independent_chroma() {
        let mut gray = GrayImage::new(180, 120, 240);
        let mut color = RgbImage::new(180, 120, [240, 168, 96]);
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                let background = 135 + x * 105 / (gray.width() - 1);
                gray.set(x, y, background as u8);
                color.set(
                    x,
                    y,
                    [
                        background as u8,
                        (background * 7 / 10) as u8,
                        (background * 2 / 5) as u8,
                    ],
                );
            }
        }
        for y in 46..74 {
            for x in 54..126 {
                gray.set(x, y, 67);
                color.set(x, y, [25, 70, 185]);
            }
        }
        let output = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                normalize_illumination: true,
                output_mode: OutputMode::Color,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                match_page_size: false,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        assert!(output.metadata.illumination_normalized);
        let output = output.color_image.unwrap();
        let shadow_paper = output.get(12, 20);
        let bright_paper = output.get(168, 20);

        for channel in 0..3 {
            assert!(
                shadow_paper[channel].abs_diff(bright_paper[channel]) <= 12,
                "channel={channel} shadow={shadow_paper:?} bright={bright_paper:?}"
            );
        }
        assert!(
            shadow_paper.iter().all(|&channel| channel >= 248),
            "tinted paper was not mapped to white: {shadow_paper:?}"
        );
        let colored_patch = output.get(90, 60);
        assert!(
            colored_patch[2] > colored_patch[1]
                && colored_patch[2] > colored_patch[0].saturating_mul(2),
            "independent blue content lost its hue: {colored_patch:?}"
        );
    }

    #[test]
    fn auto_color_abstention_keeps_continuous_tone_pixels_unnormalized() {
        let mut gray = GrayImage::new(320, 220, 0);
        let mut color = RgbImage::new(320, 220, [0; 3]);
        for y in 0..color.height() {
            for x in 0..color.width() {
                let pixel = [
                    ((x * 5 + y * 2) % 256) as u8,
                    ((x * 2 + y * 7 + 41) % 256) as u8,
                    ((x * 11 + y * 3 + 89) % 256) as u8,
                ];
                color.set(x, y, pixel);
                gray.set(
                    x,
                    y,
                    ((u32::from(pixel[0]) * 77
                        + u32::from(pixel[1]) * 150
                        + u32::from(pixel[2]) * 29
                        + 128)
                        >> 8) as u8,
                );
            }
        }
        let output = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                output_mode: OutputMode::Auto,
                normalize_illumination: true,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                match_page_size: false,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert_eq!(output.metadata.output_mode, OutputMode::Color);
        assert!(!output.metadata.illumination_normalized);
        assert_eq!(output.color_image.as_ref(), Some(&color));
    }

    #[test]
    fn color_dewarp_matches_grayscale_geometry_and_preserves_hue() {
        let mut gray = GrayImage::new(140, 100, 245);
        let mut color = RgbImage::new(140, 100, [245; 3]);
        for y in 24..76 {
            for x in 34..106 {
                gray.set(x, y, 91);
                color.set(x, y, [220, 35, 45]);
            }
        }
        let dewarp = crate::DewarpOptions {
            top_curve: vec![
                Point::new(0.0, 8.0),
                Point::new(70.0, 0.0),
                Point::new(140.0, 8.0),
            ],
            bottom_curve: vec![
                Point::new(0.0, 92.0),
                Point::new(70.0, 100.0),
                Point::new(140.0, 92.0),
            ],
            depth: 0.15,
        };
        let base = CleanupOptions {
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            match_page_size: false,
            dewarp: Some(dewarp),
            ..CleanupOptions::default()
        };
        let grayscale = clean_page(
            &gray,
            &CleanupOptions {
                output_mode: OutputMode::Grayscale,
                ..base.clone()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let colored = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                output_mode: OutputMode::Color,
                ..base
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let color_image = colored.color_image.unwrap();
        let mut color_luminance = GrayImage::new(color_image.width(), color_image.height(), 255);
        for y in 0..color_image.height() {
            for x in 0..color_image.width() {
                let pixel = color_image.get(x, y);
                color_luminance.set(
                    x,
                    y,
                    ((u32::from(pixel[0]) * 299
                        + u32::from(pixel[1]) * 587
                        + u32::from(pixel[2]) * 114)
                        / 1000) as u8,
                );
            }
        }
        assert_eq!(
            ink_bounds(&color_luminance, 220),
            ink_bounds(&grayscale.image.to_gray(), 220)
        );
        let patch = color_image.get(70, 50);
        assert!(patch[0] > 180 && patch[0] > patch[1] * 3 && patch[0] > patch[2] * 3);
        assert!(colored.metadata.dewarp_mapping.is_some());
        assert_eq!(
            colored.metadata.dewarp_mapping,
            grayscale.metadata.dewarp_mapping
        );
    }

    #[test]
    fn deskewed_content_crop_keeps_symmetric_margins_without_clipping_ink() {
        let source = rotated_text_page(3.0);
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Grayscale,
                crop_content: true,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([14.0; 4]),
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        assert!(
            output.metadata.skew_applied,
            "metadata={:?}",
            output.metadata.detected_skew_degrees
        );
        assert!((output.metadata.detected_skew_degrees - 3.0).abs() < 0.2);
        let image = output.image.to_gray();
        let (left, top, right, bottom) = ink_bounds(&image, 128).unwrap();
        let right_margin = image.width() - 1 - right;
        let bottom_margin = image.height() - 1 - bottom;
        assert!(left >= 12 && top >= 12 && right_margin >= 12 && bottom_margin >= 12);
        assert!(
            left.abs_diff(right_margin) <= 2,
            "left={left} right={right_margin}"
        );
        assert!(
            top.abs_diff(bottom_margin) <= 2,
            "top={top} bottom={bottom_margin}"
        );
        assert!(image.data()[..image.width()]
            .iter()
            .all(|&value| value == 255));
        assert!(image.data()[image.data().len() - image.width()..]
            .iter()
            .all(|&value| value == 255));
    }

    #[test]
    fn manual_skew_bypasses_detection_and_is_reported_additively() {
        let source = GrayImage::new(240, 180, 255);
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Grayscale,
                crop_content: false,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                layout: crate::LayoutMode::Single,
                manual_skew_degrees: Some(4.2),
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert_eq!(output.metadata.detected_skew_degrees, 4.2);
        assert!(output.metadata.skew_applied);
        assert!(output.metadata.manual_skew);
        assert_eq!(
            serde_json::to_value(&output.metadata).unwrap()["manualSkew"],
            true
        );
    }

    #[test]
    fn no_deskew_evidence_serializes_zeroes_and_omits_manual_skew() {
        let source = GrayImage::new(240, 180, 255);
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Grayscale,
                crop_content: false,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert_eq!(output.metadata.detected_skew_degrees, 0.0);
        assert_eq!(output.metadata.skew_confidence, 0.0);
        assert!(!output.metadata.skew_applied);
        assert!(!output.metadata.manual_skew);
        let serialized = serde_json::to_value(&output.metadata).unwrap();
        assert_eq!(serialized["detectedSkewDegrees"], 0.0);
        assert_eq!(serialized["skewConfidence"], 0.0);
        assert_eq!(serialized["skewApplied"], false);
        assert!(serialized.get("manualSkew").is_none());
    }

    #[test]
    fn deskew_dewarp_and_crop_share_one_composed_mapping() {
        let source = rotated_text_page(3.0);
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Grayscale,
                crop_content: true,
                margins_mm: None,
                margins_pixels: Some([14.0; 4]),
                match_page_size: false,
                layout: crate::LayoutMode::Single,
                dewarp: Some(crate::DewarpOptions {
                    top_curve: vec![
                        Point::new(0.0, 0.0),
                        Point::new(180.0, 14.0),
                        Point::new(360.0, 0.0),
                    ],
                    bottom_curve: vec![
                        Point::new(0.0, 280.0),
                        Point::new(180.0, 266.0),
                        Point::new(360.0, 280.0),
                    ],
                    depth: 0.08,
                }),
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert!(output.metadata.detected_skew_degrees.abs() > 2.5);
        assert!(output.metadata.skew_applied);
        assert!(output.metadata.content_box.is_some());
        assert_eq!(output.metadata.applied_margins, [14.0; 4].into());
        assert!(output.image.width() < 360 && output.image.height() < 280);
        assert_eq!(output.metadata.resample_passes, 1);

        let grid = output.metadata.dewarp_mapping.unwrap();
        assert_eq!((grid.columns, grid.rows), (17, 17));
        assert_eq!(
            (grid.output_width, grid.output_height),
            (output.image.width(), output.image.height())
        );
        assert!(grid.output_origin.x > 0.0 && grid.output_origin.y > 0.0);
        assert_eq!(grid.output_origin.x, output.metadata.crop_rect.x);
        assert_eq!(grid.output_origin.y, output.metadata.crop_rect.y);
        assert_eq!(
            grid.output_width,
            output.metadata.crop_rect.width.ceil() as usize
        );
        assert_eq!(
            grid.output_height,
            output.metadata.crop_rect.height.ceil() as usize
        );
        let first_source = grid.output_to_source[0];
        assert!(first_source.x > 0.0 && first_source.y > 0.0);
        let center_source = grid.output_to_source[8 * 17 + 8];
        let center_output = grid.source_to_output[8 * 17 + 8];
        assert!(center_source.x.is_finite() && center_source.y.is_finite());
        assert!(center_output.x.is_finite() && center_output.y.is_finite());
    }

    #[test]
    fn invalid_manual_dewarp_surfaces_a_stable_error_identifier() {
        let error = clean_page(
            &GrayImage::new(120, 100, 255),
            &CleanupOptions {
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                dewarp: Some(crate::DewarpOptions {
                    top_curve: vec![Point::new(0.0, 0.0), Point::new(120.0, 100.0)],
                    bottom_curve: vec![Point::new(0.0, 100.0), Point::new(120.0, 0.0)],
                    depth: 0.0,
                }),
                ..CleanupOptions::default()
            },
            0,
        )
        .err()
        .expect("crossing manual directrices must fail");

        assert!(
            error.starts_with("dewarp-model-endpoint-order:"),
            "error={error}"
        );
    }

    #[test]
    fn analyze_no_crop_reports_full_source_dimensions_above_analysis_caps() {
        let source = GrayImage::new(3_000, 2_000, 245);
        let analysis = analyze_page(
            &source,
            &CleanupOptions {
                dpi: 300.0,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
        )
        .unwrap();

        assert_eq!(analysis.outputs.len(), 1);
        assert_eq!(
            analysis.outputs[0].crop_rect,
            Rect::new(0.0, 0.0, 3_000.0, 2_000.0)
        );
    }

    #[test]
    fn reduced_analysis_bounds_retain_the_source_sample_footprint() {
        let mut source = GrayImage::new(720, 960, 246);
        source.set(115, 200, 80);
        source.set(200, 185, 80);
        let mapped = map_analysis_rect_to_source_support(
            Rect::new(58.0, 93.0, 229.0, 238.0),
            0.5,
            0.5,
            720.0,
            960.0,
            SourceContentSupport::Rectilinear {
                image: &source,
                to_source: Affine::IDENTITY,
            },
        );
        assert_eq!(mapped, Rect::new(115.0, 185.0, 459.0, 477.0));

        let identity = map_analysis_rect_to_source_support(
            Rect::new(58.0, 93.0, 229.0, 238.0),
            1.0,
            1.0,
            720.0,
            960.0,
            SourceContentSupport::Rectilinear {
                image: &source,
                to_source: Affine::IDENTITY,
            },
        );
        assert_eq!(identity, Rect::new(58.0, 93.0, 229.0, 238.0));
    }

    #[test]
    fn analysis_rect_mapping_expands_each_edge_by_at_most_half_a_sample() {
        let source = GrayImage::new(800, 1_000, 0);
        let rect = Rect::new(31.25, 47.75, 113.5, 207.25);
        let scale_x = 0.4;
        let scale_y = 0.625;
        let source_width = 800.0;
        let source_height = 1_000.0;
        let naive = Rect::new(
            rect.x / scale_x,
            rect.y / scale_y,
            rect.width / scale_x,
            rect.height / scale_y,
        );

        for support in [
            SourceContentSupport::Rectilinear {
                image: &source,
                to_source: Affine::IDENTITY,
            },
            SourceContentSupport::DewarpWithoutRectilinearPlane,
        ] {
            let mapped = map_analysis_rect_to_source_support(
                rect,
                scale_x,
                scale_y,
                source_width,
                source_height,
                support,
            );
            let expansions_in_analysis_samples = [
                (naive.x - mapped.x) * scale_x,
                (mapped.right() - naive.right()) * scale_x,
                (naive.y - mapped.y) * scale_y,
                (mapped.bottom() - naive.bottom()) * scale_y,
            ];
            for expansion in expansions_in_analysis_samples {
                assert!(expansion >= -1e-9, "mapping contracted an edge: {mapped:?}");
                assert!(
                    expansion <= 0.5 + 1e-9,
                    "mapping expanded an edge by {expansion} analysis samples: {mapped:?}"
                );
            }
        }
    }

    #[test]
    fn clean_region_publishes_the_rectilinear_crop_authority_without_crossing_the_cutter() {
        let angle_degrees = 6.5;
        let leaf = rotated_text_page(angle_degrees);
        let mut source = GrayImage::new(leaf.width() * 2, leaf.height(), 255);
        for y in 0..leaf.height() {
            for x in 0..leaf.width() {
                let value = leaf.get(x, y);
                source.set(x, y, value);
                source.set(x + leaf.width(), y, value);
            }
        }
        let result = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Grayscale,
                crop_content: true,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                layout: crate::LayoutMode::TwoPage,
                manual_split_x: Some(crate::NormalizedSplit {
                    x: 0.5,
                    rotation: OrthogonalRotation::None,
                }),
                manual_skew_degrees: Some(angle_degrees),
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();

        assert_eq!(result.outputs.len(), 2);
        for output in result.outputs {
            let region = output.metadata.source_region;
            let source = output
                .metadata
                .content_box
                .expect("each leaf fixture has detected content");
            let crop = output.metadata.crop_rect;
            let forward = deskew_transform(
                region.width.round() as usize,
                region.height.round() as usize,
                DeskewResult {
                    angle_degrees,
                    confidence: 1.0,
                    accepted: true,
                },
            );
            let projected = transform_rect_bounds(source, forward);

            assert!(crop.x <= projected.x + 1e-9, "crop={crop:?} projected={projected:?}");
            assert!(crop.y <= projected.y + 1e-9, "crop={crop:?} projected={projected:?}");
            assert!(
                crop.right() + 1e-9 >= projected.right(),
                "crop={crop:?} projected={projected:?}"
            );
            assert!(
                crop.bottom() + 1e-9 >= projected.bottom(),
                "crop={crop:?} projected={projected:?}"
            );
            assert!(source.x >= 0.0 && source.y >= 0.0, "source={source:?}");
            assert!(source.right() <= region.width, "source={source:?} region={region:?}");
            assert!(source.bottom() <= region.height, "source={source:?} region={region:?}");
            assert!(crop.x >= 0.0 && crop.y >= 0.0, "crop={crop:?}");
            assert!(crop.right() <= region.width, "crop={crop:?} region={region:?}");
            assert!(crop.bottom() <= region.height, "crop={crop:?} region={region:?}");
        }
    }

    #[test]
    #[ignore = "full-resolution synthetic analysis runs in the native CI corpus lane"]
    fn document_prior_is_gated_at_full_resolution_before_analysis_downscaling() {
        let mut source = GrayImage::new(3_000, 2_100, 245);
        let gutter_x = 1_410;
        for y in (240..1_860).step_by(92) {
            for word in 0..12 {
                let left = 180 + word * 92;
                for row in y..y + 8 {
                    for x in left..left + 58 {
                        source.set(x, row, 24);
                    }
                }
            }
            for word in 0..12 {
                let left = 1_650 + word * 92;
                for row in y..y + 8 {
                    for x in left..left + 58 {
                        source.set(x, row, 28);
                    }
                }
            }
        }
        for y in 30..2_070 {
            source.set(gutter_x, y, 55);
            source.set(gutter_x + 1, y, 150);
        }
        let options = CleanupOptions {
            dpi: 300.0,
            normalize_illumination: false,
            crop_content: false,
            ..CleanupOptions::default()
        };
        let no_prior = analyze_page(&source, &options).unwrap();
        let matching_prior = DocumentPrior {
            dominant_layout: LayoutClassification::TwoPageSpread,
            cutter_ratio_median: Some(gutter_x as f64 / source.width() as f64),
            cluster_dims: crate::split::ClusterDimensions {
                width: source.width() as f64,
                height: source.height() as f64,
            },
            agreement_strength: 0.9,
            stroke_width_median_px: None,
            x_height_median_px: None,
        };
        let with_prior =
            analyze_page_with_document_prior(&source, &options, Some(matching_prior)).unwrap();
        assert!(
            with_prior.reconciliation.cluster_agreement > 0.0,
            "{:?}",
            with_prior.reconciliation
        );

        let inapplicable_prior = DocumentPrior {
            cluster_dims: crate::split::ClusterDimensions {
                width: (source.width() * 2) as f64,
                height: (source.height() * 2) as f64,
            },
            cutter_ratio_median: Some(0.35),
            ..matching_prior
        };
        let inapplicable =
            analyze_page_with_document_prior(&source, &options, Some(inapplicable_prior)).unwrap();
        assert_eq!(inapplicable.classification, no_prior.classification);
        assert_eq!(inapplicable.reconciliation.cluster_agreement, 0.0);
    }

    #[test]
    fn cleanup_metadata_reports_despeckle_fallback_for_seedless_page() {
        let mut source = GrayImage::new(180, 120, 255);
        for index in 0..20 {
            let left = 8 + (index % 10) * 16;
            let top = 12 + (index / 10) * 55;
            for y in top..top + 2 + (index % 3) {
                for x in left..left + 2 + ((index + 1) % 3) {
                    source.set(x, y, 0);
                }
            }
        }
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 300.0,
                normalize_illumination: false,
                binarization: crate::BinarizationMode::Otsu,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert!(output.metadata.despeckle_fallback);
        assert!(serde_json::to_value(&output.metadata).unwrap()["despeckleFallback"] == true);
    }

    #[test]
    fn auto_spread_renders_two_independently_cropped_outputs() {
        let source = spread_fixture();
        let result = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                ..CleanupOptions::default()
            },
            4,
        )
        .unwrap();
        assert_eq!(result.classification, LayoutClassification::TwoPageSpread);
        assert!(
            (result.cutter_x.unwrap() - 160.0).abs() <= 3.0,
            "cutter={:?}",
            result.cutter_x
        );
        assert_eq!(result.outputs.len(), 2);
        for (index, output) in result.outputs.iter().enumerate() {
            let expected = Rect::new(if index == 0 { 24.0 } else { 18.0 }, 35.0, 118.0, 129.0);
            let content = output.metadata.content_box.unwrap();
            assert!(
                iou(content, expected) >= 0.8,
                "half={index} actual={content:?}"
            );
            assert_eq!(output.metadata.source_page_index, 4);
            assert!(output.metadata.forward_transform.is_some());
            assert!(output.metadata.inverse_transform.is_some());
        }
        assert_eq!(result.outputs[0].metadata.half, PageHalf::Left);
        assert_eq!(result.outputs[1].metadata.half, PageHalf::Right);
    }

    #[test]
    fn analysis_metadata_emits_per_side_content_confidence() {
        let result = analyze_page(
            &single_page_fixture(),
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
        )
        .unwrap();
        let metadata = serde_json::to_value(&result.outputs[0]).unwrap();
        let confidence = &metadata["contentDiagnostics"]["sideConfidence"];
        for side in ["left", "top", "right", "bottom"] {
            assert!(confidence[side].is_number(), "missing {side}: {metadata}");
        }
        assert!(metadata["contentDiagnostics"]["textMask"]["lineCount"].is_number());
    }

    #[test]
    fn classify_only_analysis_matches_full_pipeline_for_spread_and_single_fixtures() {
        let options = CleanupOptions {
            dpi: 150.0,
            normalize_illumination: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            ..CleanupOptions::default()
        };
        for source in [spread_fixture(), single_page_fixture()] {
            let classification = classify_page(&source, &options).unwrap();
            let cleaned = clean_page(&source, &options, 0).unwrap();
            assert_eq!(classification.classification, cleaned.classification);
            assert_eq!(classification.confidence, cleaned.layout_confidence);
            assert_eq!(classification.cutter_x, cleaned.cutter_x);
        }
    }

    #[test]
    fn manual_content_box_replaces_detection_for_the_selected_half() {
        let source = spread_fixture();
        let manual = Rect::new(30.0, 42.0, 90.0, 100.0);
        let result = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                manual_content_boxes: crate::ManualContentBoxes {
                    left: Some(crate::NormalizedRect {
                        x: manual.x / source.width() as f64,
                        y: manual.y / source.height() as f64,
                        width: manual.width / source.width() as f64,
                        height: manual.height / source.height() as f64,
                        rotation: OrthogonalRotation::None,
                    }),
                    ..crate::ManualContentBoxes::default()
                },
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert_eq!(result.outputs[0].metadata.content_box, Some(manual));
        assert_ne!(result.outputs[1].metadata.content_box, Some(manual));
        assert_eq!(
            (
                result.outputs[0].metadata.output_width,
                result.outputs[0].metadata.output_height
            ),
            (90, 100)
        );
    }

    #[test]
    fn manual_picture_corner_remains_crop_authoritative() {
        let mut source = GrayImage::new(400, 600, 245);
        for y in 440..600 {
            for x in 364..400 {
                source.set(x, y, 156);
            }
        }
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                output_mode: OutputMode::Mixed,
                normalize_illumination: false,
                crop_content: true,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                layout: crate::LayoutMode::Single,
                manual_zones: crate::ManualZones {
                    picture: vec![crate::PictureZone {
                        polygon: normalized_box_polygon(0.91, 440.0 / 600.0, 1.0, 1.0),
                        layer: crate::PictureZoneLayer::Painter2,
                    }],
                    fill: vec![],
                },
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let content = output
            .metadata
            .content_box
            .expect("manual corner photo is authored content");

        assert!(content.x <= 364.0, "manual photo left was cropped: {content:?}");
        assert!(content.y <= 440.0, "manual photo top was cropped: {content:?}");
        assert!(content.right() >= 400.0, "manual photo right was cropped: {content:?}");
        assert!(content.bottom() >= 600.0, "manual photo bottom was cropped: {content:?}");
    }

    #[test]
    fn normalized_manual_content_has_the_same_physical_rect_at_150_and_600_dpi() {
        let clean_at_dpi = |dpi: f64, width: usize, height: usize| {
            let source = GrayImage::new(width, height, 245);
            clean_page(
                &source,
                &CleanupOptions {
                    dpi,
                    normalize_illumination: false,
                    margins_mm: None,
                    margins_pixels: Some([0.0; 4]),
                    layout: crate::LayoutMode::Single,
                    manual_content_boxes: crate::ManualContentBoxes {
                        full: Some(crate::NormalizedRect {
                            x: 0.1,
                            y: 0.2,
                            width: 0.5,
                            height: 0.6,
                            rotation: OrthogonalRotation::None,
                        }),
                        ..crate::ManualContentBoxes::default()
                    },
                    ..CleanupOptions::default()
                },
                0,
            )
            .unwrap()
            .outputs
            .remove(0)
            .metadata
        };
        let low = clean_at_dpi(150.0, 300, 450);
        let high = clean_at_dpi(600.0, 1200, 1800);
        let physical = |metadata: &CleanupMetadata, dpi: f64| {
            let rect = metadata.content_box.unwrap();
            Rect::new(
                rect.x / dpi,
                rect.y / dpi,
                rect.width / dpi,
                rect.height / dpi,
            )
        };
        let low = physical(&low, 150.0);
        let high = physical(&high, 600.0);
        for delta in [
            low.x - high.x,
            low.y - high.y,
            low.width - high.width,
            low.height - high.height,
        ] {
            assert!(delta.abs() < 1e-9, "physical rectangle delta was {delta}");
        }
        let split_at_dpi = |dpi: f64, width: usize, height: usize| {
            classify_page(
                &GrayImage::new(width, height, 245),
                &CleanupOptions {
                    dpi,
                    layout: crate::LayoutMode::TwoPage,
                    normalize_illumination: false,
                    manual_split_x: Some(crate::NormalizedSplit {
                        x: 0.4,
                        rotation: OrthogonalRotation::None,
                    }),
                    ..CleanupOptions::default()
                },
            )
            .unwrap()
            .cutter_x
            .unwrap()
                / dpi
        };
        assert!((split_at_dpi(150.0, 300, 450) - split_at_dpi(600.0, 1200, 1800)).abs() < 1e-9);
    }

    #[test]
    fn automatic_preview_plan_replays_final_geometry_without_becoming_manual() {
        fn scaled(source: &GrayImage, factor: usize) -> GrayImage {
            let mut output = GrayImage::new(source.width() * factor, source.height() * factor, 255);
            for y in 0..output.height() {
                for x in 0..output.width() {
                    output.set(x, y, source.get(x / factor, y / factor));
                }
            }
            output
        }

        let preview_source = single_page_fixture();
        let base_options = CleanupOptions {
            dpi: 150.0,
            output_mode: OutputMode::Grayscale,
            normalize_illumination: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let preview = clean_page(&preview_source, &base_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let content = preview.metadata.content_box.unwrap();
        let normalized_content = crate::NormalizedRect {
            x: content.x / preview.metadata.source_region.width,
            y: content.y / preview.metadata.source_region.height,
            width: content.width / preview.metadata.source_region.width,
            height: content.height / preview.metadata.source_region.height,
            rotation: OrthogonalRotation::None,
        };

        let final_source = scaled(&preview_source, 2);
        let final_options = CleanupOptions {
            dpi: 300.0,
            ..base_options.clone()
        };
        let automatic = clean_page(&final_source, &final_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let replayed = clean_page(
            &final_source,
            &CleanupOptions {
                automatic_content_boxes: crate::ManualContentBoxes {
                    full: Some(normalized_content),
                    ..crate::ManualContentBoxes::default()
                },
                automatic_skew_degrees: crate::AutomaticSkewDegrees {
                    full: Some(preview.metadata.detected_skew_degrees),
                    ..crate::AutomaticSkewDegrees::default()
                },
                ..final_options
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert!(!replayed.metadata.manual_skew);
        assert_eq!(
            replayed.metadata.detected_skew_degrees,
            preview.metadata.detected_skew_degrees
        );
        let automatic_content = automatic.metadata.content_box.unwrap();
        let replayed_content = replayed.metadata.content_box.unwrap();
        for (axis, delta) in [
            ("x", automatic_content.x - replayed_content.x),
            ("y", automatic_content.y - replayed_content.y),
            ("width", automatic_content.width - replayed_content.width),
            (
                "height",
                automatic_content.height - replayed_content.height,
            ),
        ] {
            assert!(
                delta.abs() <= 1.0,
                "replayed cross-DPI content {axis} drifted by {delta}px: automatic={automatic_content:?}, replayed={replayed_content:?}"
            );
        }
        assert_eq!(
            (automatic.image.width(), automatic.image.height()),
            (replayed.image.width(), replayed.image.height())
        );
        let mean_absolute_error = automatic
            .image
            .to_gray()
            .data()
            .iter()
            .zip(replayed.image.to_gray().data())
            .map(|(&left, &right)| f64::from(left.abs_diff(right)))
            .sum::<f64>()
            / (automatic.image.width() * automatic.image.height()) as f64;
        assert!(
            mean_absolute_error <= 0.1,
            "automatic-plan replay changed the final raster: MAE={mean_absolute_error:.6}"
        );
    }

    #[test]
    fn forward_transform_uses_rotated_analysis_space_for_every_rotation() {
        let source = GrayImage::new(320, 200, 245);
        for rotation in [
            OrthogonalRotation::None,
            OrthogonalRotation::Clockwise90,
            OrthogonalRotation::Clockwise180,
            OrthogonalRotation::Clockwise270,
        ] {
            let output = clean_page(
                &source,
                &CleanupOptions {
                    rotation,
                    layout: crate::LayoutMode::Single,
                    normalize_illumination: false,
                    crop_content: false,
                    ..CleanupOptions::default()
                },
                0,
            )
            .unwrap()
            .outputs
            .remove(0);
            let metadata = output.metadata;
            let point = Point::new(
                metadata.source_region.width * 0.3,
                metadata.source_region.height * 0.7,
            );
            let transformed = metadata.forward_transform.unwrap().apply(point);
            let restored = metadata.inverse_transform.unwrap().apply(transformed);
            assert!(
                (transformed.x - point.x).abs() < 1e-8,
                "rotation={rotation:?}"
            );
            assert!(
                (transformed.y - point.y).abs() < 1e-8,
                "rotation={rotation:?}"
            );
            assert!((restored.x - point.x).abs() < 1e-8, "rotation={rotation:?}");
            assert!((restored.y - point.y).abs() < 1e-8, "rotation={rotation:?}");
        }
    }

    #[test]
    fn forced_layouts_and_offcut_discard_are_authoritative() {
        let source = spread_fixture();
        let base = CleanupOptions {
            normalize_illumination: false,
            crop_content: false,
            ..CleanupOptions::default()
        };
        let single = clean_page(
            &source,
            &CleanupOptions {
                layout: crate::LayoutMode::Single,
                ..base.clone()
            },
            0,
        )
        .unwrap();
        assert_eq!(single.outputs.len(), 1);
        let spread = clean_page(
            &source,
            &CleanupOptions {
                layout: crate::LayoutMode::TwoPage,
                ..base.clone()
            },
            0,
        )
        .unwrap();
        assert_eq!(spread.outputs.len(), 2);
        let offcut = clean_page(
            &source,
            &CleanupOptions {
                layout: crate::LayoutMode::PageWithOffcut,
                manual_split_x: Some(crate::NormalizedSplit {
                    x: 280.0 / source.width() as f64,
                    rotation: OrthogonalRotation::None,
                }),
                ..base
            },
            0,
        )
        .unwrap();
        assert_eq!(offcut.outputs.len(), 1);
        assert_eq!(offcut.outputs[0].metadata.half, PageHalf::Left);
        assert_eq!(offcut.outputs[0].metadata.source_region.width, 280.0);
    }

    #[test]
    fn exclusion_rotation_and_manual_cutter_are_authoritative() {
        let source = spread_fixture();
        let excluded = clean_page(
            &source,
            &CleanupOptions {
                excluded: true,
                ..CleanupOptions::default()
            },
            7,
        )
        .unwrap();
        assert!(excluded.outputs.is_empty());
        assert!(excluded.excluded);

        let rotated = clean_page(
            &source,
            &CleanupOptions {
                rotation: OrthogonalRotation::Clockwise90,
                layout: crate::LayoutMode::TwoPage,
                manual_split_x: Some(crate::NormalizedSplit {
                    x: 73.0 / source.height() as f64,
                    rotation: OrthogonalRotation::Clockwise90,
                }),
                normalize_illumination: false,
                crop_content: false,
                ..CleanupOptions::default()
            },
            7,
        )
        .unwrap();
        assert_eq!(rotated.cutter_x, Some(73.0));
        assert_eq!(rotated.outputs.len(), 2);
        let metadata = &rotated.outputs[0].metadata;
        assert_eq!(metadata.rotation, OrthogonalRotation::Clockwise90);
        assert_eq!(metadata.resample_passes, 1);
        assert_eq!((metadata.input_width, metadata.input_height), (320, 200));
        let source_point = Point::new(32.5, 44.5);
        let restored = metadata
            .inverse_transform
            .unwrap()
            .apply(metadata.forward_transform.unwrap().apply(source_point));
        assert!((restored.x - source_point.x).abs() < 1e-8);
        assert!((restored.y - source_point.y).abs() < 1e-8);
    }

    #[test]
    fn skip_blank_pages_filters_only_effectively_blank_outputs() {
        let blank = GrayImage::new(180, 120, 255);
        let skipped = clean_page(
            &blank,
            &CleanupOptions {
                skip_blank_pages: true,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert!(skipped.outputs.is_empty());
        assert_eq!(skipped.blank_outputs_skipped, 1);

        let mut inked = blank;
        for y in 45..55 {
            for x in 40..140 {
                inked.set(x, y, 0);
            }
        }
        let retained = clean_page(
            &inked,
            &CleanupOptions {
                skip_blank_pages: true,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert_eq!(retained.outputs.len(), 1);
        assert_eq!(retained.blank_outputs_skipped, 0);
    }

    #[test]
    fn blank_split_region_fails_closed_to_all_white_instead_of_all_black() {
        let mut source = GrayImage::new(320, 180, 255);
        for y in (30..150).step_by(14) {
            for x in 190..294 {
                source.set(x, y, 20);
                source.set(x, y + 1, 20);
                source.set(x, y + 2, 20);
            }
        }
        let result = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                output_mode: OutputMode::Bw,
                crop_content: true,
                match_page_size: false,
                layout: crate::LayoutMode::TwoPage,
                manual_split_x: Some(crate::NormalizedSplit {
                    x: 0.5,
                    rotation: OrthogonalRotation::None,
                }),
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        let blank = &result.outputs[0];
        assert_eq!(blank.metadata.half, PageHalf::Left);
        assert!(blank.metadata.content_box.is_none());
        assert!(blank.effectively_blank);
        let blank_image = blank.image.to_gray();
        assert!(blank_image.data().iter().all(|&value| value == 255));
        assert!(!blank_image.data().iter().all(|&value| value == 0));
    }

    #[test]
    fn near_blank_leaf_with_dust_keeps_its_full_pipeline_geometry() {
        let mut source = GrayImage::new(360, 480, 246);
        for &(left, top) in &[(8, 8), (170, 230), (338, 120), (338, 440)] {
            for y in top..top + 6 {
                for x in left..(left + 5).min(source.width()) {
                    source.set(x, y, 70);
                }
            }
        }
        let result = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                despeckle: false,
                crop_content: true,
                match_page_size: false,
                layout: crate::LayoutMode::Single,
                output_mode: OutputMode::Grayscale,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();

        assert_eq!(result.outputs.len(), 1);
        let output = &result.outputs[0];
        assert_eq!(output.metadata.content_box, None);
        assert_eq!(
            (output.image.width(), output.image.height()),
            (source.width(), source.height()),
            "dust cropped a near-blank pipeline leaf"
        );
    }

    fn pale_photo_plate_fixture() -> GrayImage {
        let mut source = GrayImage::new(1_116, 1_626, 240);
        for y in 160..1_460 {
            for x in 0..source.width() {
                source.set(x, y, 239);
            }
        }
        for y in 190..1_450 {
            for x in 120..1_000 {
                source.set(x, y, 232);
            }
        }
        for y in (0..source.height()).step_by(4) {
            for x in 0..4 {
                source.set(x, y, 0);
            }
        }
        source
    }

    #[test]
    fn pale_photo_plate_emits_source_gray_when_bw_collapses() {
        let output = clean_page(
            &pale_photo_plate_fixture(),
            &CleanupOptions {
                dpi: 150.0,
                output_mode: OutputMode::Bw,
                normalize_illumination: true,
                crop_content: false,
                match_page_size: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let gray = output.image.to_gray();
        let minimum = gray.data().iter().copied().min().unwrap_or(255);
        assert_eq!(output.metadata.output_mode, OutputMode::Grayscale);
        assert!(!output.effectively_blank);
        assert!(output.mixed_layers.is_some());
        assert!(minimum <= 232, "pale plate was whitened: minimum={minimum}");
        assert!(output
            .metadata
            .warnings
            .iter()
            .any(|warning| warning.contains("grayscale rendition was emitted instead")));
    }

    #[test]
    fn pale_photo_plate_bypasses_a_sparse_trusted_foreground() {
        let source = pale_photo_plate_fixture();
        assert!(has_pale_tonal_structure(&source));
        let mut trusted_foreground = BinaryImage::new(source.width(), source.height());
        for y in (0..source.height()).step_by(8) {
            trusted_foreground.set(source.width() - 1, y, true);
        }
        let mut timings = PageStageTimings::default();
        let output = clean_page_with_color_and_calibration_config(
            &source,
            None,
            None,
            Some(&trusted_foreground),
            None,
            &CleanupOptions {
                dpi: 150.0,
                source_dpi: Some(150.0),
                source_has_bilevel_layer: true,
                output_mode: OutputMode::Bw,
                normalize_illumination: true,
                crop_content: false,
                match_page_size: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
            CalibrationConfig::default(),
            None,
            None,
            PageRenderPolicy::COMPLETE,
            &mut timings,
        )
        .unwrap()
        .outputs
        .remove(0);
        assert_eq!(output.metadata.output_mode, OutputMode::Grayscale);
        assert!(output
            .metadata
            .warnings
            .iter()
            .any(|warning| warning.contains("grayscale rendition was emitted instead")));
        assert!(output.image.to_gray().data().iter().copied().min().unwrap_or(255) <= 232);
    }

    #[test]
    fn dense_trusted_foreground_on_a_pale_plate_stays_bilevel() {
        let source = pale_photo_plate_fixture();
        assert!(has_pale_tonal_structure(&source));
        let mut trusted_foreground = BinaryImage::new(source.width(), source.height());
        for y in 0..source.height() {
            for x in 0..source.width() {
                trusted_foreground.set(x, y, true);
            }
        }
        let mut timings = PageStageTimings::default();
        let output = clean_page_with_color_and_calibration_config(
            &source,
            None,
            None,
            Some(&trusted_foreground),
            None,
            &CleanupOptions {
                dpi: 150.0,
                source_dpi: Some(150.0),
                source_has_bilevel_layer: true,
                output_mode: OutputMode::Bw,
                normalize_illumination: true,
                crop_content: false,
                match_page_size: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
            CalibrationConfig::default(),
            None,
            None,
            PageRenderPolicy::COMPLETE,
            &mut timings,
        )
        .unwrap()
        .outputs
        .remove(0);

        let CleanupRaster::Bilevel(binary) = output.image else {
            panic!("a non-collapsed trusted foreground must stay bilevel");
        };
        assert_eq!(output.metadata.output_mode, OutputMode::Bw);
        assert_eq!(binary.count_black(), binary.width() * binary.height());
        assert!(!output
            .metadata
            .warnings
            .iter()
            .any(|warning| warning.contains("grayscale rendition was emitted instead")));
    }

    #[test]
    fn blank_verso_does_not_trigger_the_pale_plate_rescue() {
        let mut source = GrayImage::new(1_116, 1_626, 240);
        for y in 0..source.height() {
            for x in 0..22 {
                source.set(x, y, (26 + x * 9).min(240) as u8);
            }
        }
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                output_mode: OutputMode::Bw,
                normalize_illumination: true,
                crop_content: false,
                match_page_size: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        assert!(output.effectively_blank);
        assert!(output.image.to_gray().data().iter().all(|&value| value == 255));
        assert!(!output
            .metadata
            .warnings
            .iter()
            .any(|warning| warning.contains("grayscale rendition was emitted instead")));
    }

    #[test]
    fn small_text_on_gray_paper_is_never_erased_as_a_blank_page() {
        let background = 152u8;
        let mut source = GrayImage::new(360, 510, background);
        for y in 0..source.height() {
            for x in 0..source.width() {
                let shading = (x * 24 / source.width()) as i16 - 12;
                let texture = ((x * 7 + y * 11) % 5) as i16 - 2;
                source.set(
                    x,
                    y,
                    (i16::from(background) + shading + texture).clamp(0, 255) as u8,
                );
            }
        }
        let ink = background.saturating_sub(64);
        // Six compact glyph-like components form one very short line and
        // occupy far below one percent of the page.
        for glyph in 0..6 {
            let left = 140 + glyph * 11;
            for y in 246..256 {
                source.set(left, y, ink);
                source.set(left + 5, y, ink);
            }
            for x in left..=left + 5 {
                source.set(x, 246, ink);
                source.set(x, 251, ink);
            }
        }

        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 150.0,
                output_mode: OutputMode::Bw,
                layout: crate::LayoutMode::Single,
                crop_content: false,
                match_page_size: false,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let black_pixels = output
            .image
            .to_gray()
            .data()
            .iter()
            .filter(|&&value| value == 0)
            .count();
        assert!(
            !output.effectively_blank && black_pixels >= 36,
            "small text was erased: effectively_blank={}, black_pixels={black_pixels}",
            output.effectively_blank,
        );
    }

    #[test]
    #[ignore = "full-raster paper-tone sweep runs in the native CI corpus lane"]
    fn auto_mode_turns_dark_text_on_uniform_tinted_paper_into_black_on_white() {
        for paper in [
            [205, 225, 245],
            [225, 205, 215],
            [235, 220, 175],
            [190, 215, 195],
            [170, 170, 170],
        ] {
            let ink =
                paper.map(|channel| (f64::from(channel) * 0.18).round().clamp(8.0, 64.0) as u8);
            let mut color = RgbImage::new(420, 560, paper);
            for y in 0..color.height() {
                for x in 0..color.width() {
                    let shade = x as i16 * 12 / color.width() as i16 - 6;
                    let noise = ((x * 17 + y * 29 + x * y % 11) % 7) as i16 - 3;
                    color.set(
                        x,
                        y,
                        paper.map(|channel| {
                            (i16::from(channel) + shade + noise).clamp(0, 255) as u8
                        }),
                    );
                }
            }
            for line in 0..10 {
                let top = 55 + line * 42;
                for glyph in 0..22 {
                    let left = 46 + glyph * 15;
                    for y in top..top + 12 {
                        for x in left..left + 8 {
                            if x == left || y == top || y + 2 >= top + 12 {
                                color.set(x, y, ink);
                            }
                        }
                    }
                }
            }
            let mut gray = GrayImage::new(color.width(), color.height(), 255);
            for y in 0..color.height() {
                for x in 0..color.width() {
                    let pixel = color.get(x, y);
                    gray.set(
                        x,
                        y,
                        ((u32::from(pixel[0]) * 77
                            + u32::from(pixel[1]) * 150
                            + u32::from(pixel[2]) * 29
                            + 128)
                            >> 8) as u8,
                    );
                }
            }
            let mut result = clean_page_with_color(
                &gray,
                Some(&color),
                &CleanupOptions {
                    dpi: 150.0,
                    output_mode: OutputMode::Auto,
                    crop_content: false,
                    match_page_size: false,
                    margins_mm: None,
                    margins_pixels: Some([0.0; 4]),
                    layout: crate::LayoutMode::Single,
                    ..CleanupOptions::default()
                },
                0,
            )
            .unwrap();
            let recommendation = result.output_mode_recommendation;
            let output = result.outputs.remove(0);
            assert!(
                matches!(
                    output.metadata.output_mode,
                    OutputMode::Bw | OutputMode::Grayscale
                ),
                "paper={paper:?}, recommendation={recommendation:?}",
            );
            assert!(output.color_image.is_none(), "paper={paper:?}");
            let rendered = output.image.to_gray();
            assert!(
                rendered
                    .data()
                    .iter()
                    .filter(|&&value| value >= 248)
                    .count()
                    > rendered.data().len() * 9 / 10,
                "paper={paper:?}, mode={:?}",
                output.metadata.output_mode,
            );
            assert!(
                rendered.data().iter().filter(|&&value| value <= 64).count() >= 2_000,
                "paper={paper:?} ink={ink:?}"
            );
        }
    }

    #[test]
    fn auto_mode_retains_small_faint_text_on_tinted_paper() {
        let paper = [185, 205, 220];
        let ink = [126, 139, 150];
        let mut color = RgbImage::new(420, 560, paper);
        for line in 0..13 {
            let top = 34 + line * 37;
            for glyph in 0..30 {
                let left = 24 + glyph * 12;
                for y in top..top + 9 {
                    for x in left..left + 6 {
                        if x == left || y == top || y + 1 >= top + 9 {
                            color.set(x, y, ink);
                        }
                    }
                }
            }
        }
        let mut gray = GrayImage::new(color.width(), color.height(), 255);
        for y in 0..color.height() {
            for x in 0..color.width() {
                let pixel = color.get(x, y);
                gray.set(
                    x,
                    y,
                    ((u32::from(pixel[0]) * 77
                        + u32::from(pixel[1]) * 150
                        + u32::from(pixel[2]) * 29
                        + 128)
                        >> 8) as u8,
                );
            }
        }
        let output = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                dpi: 150.0,
                output_mode: OutputMode::Auto,
                crop_content: false,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let rendered = output.image.to_gray();

        assert!(matches!(
            output.metadata.output_mode,
            OutputMode::Bw | OutputMode::Grayscale
        ));
        assert!(output.color_image.is_none());
        assert!(
            rendered
                .data()
                .iter()
                .filter(|&&value| value >= 248)
                .count()
                > rendered.data().len() * 8 / 10
        );
        if output.metadata.output_mode == OutputMode::Grayscale {
            let diagnostics = output
                .metadata
                .text_tone_diagnostics
                .expect("grayscale text pages need an explicit tone decision");
            assert!(
                diagnostics.applied || diagnostics.ink_anchor.is_some(),
                "text tone must be derived even when no picture mask exists: {diagnostics:?}",
            );
        }
        let retained_strokes = rendered
            .data()
            .iter()
            // A preservation mask may keep faint glyphs from disappearing
            // during background normalization, but it must not exempt them
            // from the subsequent text-tone curve. Merely retaining the
            // original tinted-paper luminance (about 135 here) is not the
            // requested black-text-on-white result.
            .filter(|&&value| value <= 120)
            .count();
        assert!(
            retained_strokes >= 2_000,
            "small faint glyph strokes were lost: count={retained_strokes}, min={}, mode={:?}, tone={:?}",
            rendered.data().iter().copied().min().unwrap_or(255),
            output.metadata.output_mode,
            output.metadata.text_tone_diagnostics,
        );
    }

    #[test]
    fn mixed_mode_whitens_tinted_paper_but_preserves_independent_color() {
        let mut color = RgbImage::new(420, 560, [205, 225, 245]);
        for line in 0..10 {
            let top = 55 + line * 42;
            for glyph in 0..18 {
                let left = 42 + glyph * 15;
                for y in top..top + 12 {
                    for x in left..left + 8 {
                        if x == left || y == top || y + 2 >= top + 12 {
                            color.set(x, y, [26, 29, 34]);
                        }
                    }
                }
            }
        }
        for y in 210..350 {
            for x in 320..390 {
                color.set(x, y, [220, 45, 40]);
            }
        }
        let mut gray = GrayImage::new(color.width(), color.height(), 255);
        for y in 0..color.height() {
            for x in 0..color.width() {
                let pixel = color.get(x, y);
                gray.set(
                    x,
                    y,
                    ((u32::from(pixel[0]) * 77
                        + u32::from(pixel[1]) * 150
                        + u32::from(pixel[2]) * 29
                        + 128)
                        >> 8) as u8,
                );
            }
        }
        let output = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                dpi: 150.0,
                output_mode: OutputMode::Mixed,
                crop_content: false,
                match_page_size: false,
                margins_mm: None,
                margins_pixels: Some([0.0; 4]),
                layout: crate::LayoutMode::Single,
                manual_zones: crate::ManualZones {
                    picture: vec![crate::PictureZone {
                        polygon: normalized_box_polygon(0.74, 0.35, 0.96, 0.67),
                        layer: crate::PictureZoneLayer::Painter2,
                    }],
                    fill: vec![],
                },
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let output_gray = output.image.to_gray();
        let output_color = output
            .color_image
            .expect("independent color produces a Mixed color plane");

        assert!(output_color
            .get(20, 20)
            .iter()
            .all(|&channel| channel >= 250));
        assert!(
            output_gray
                .data()
                .iter()
                .enumerate()
                .filter(|(index, value)| index % output_gray.width() < 300 && **value == 0)
                .count()
                >= 1_500
        );
        let protected_red = output_color.get(350, 280);
        assert!(protected_red[0] > protected_red[1].saturating_mul(2));
        assert!(protected_red[0] > protected_red[2].saturating_mul(2));
    }

    fn normalized_box_polygon(
        left: f64,
        top: f64,
        right: f64,
        bottom: f64,
    ) -> crate::NormalizedZonePolygon {
        crate::NormalizedZonePolygon {
            points: vec![
                crate::NormalizedZonePoint { x: left, y: top },
                crate::NormalizedZonePoint { x: right, y: top },
                crate::NormalizedZonePoint {
                    x: right,
                    y: bottom,
                },
                crate::NormalizedZonePoint { x: left, y: bottom },
            ],
            rotation: OrthogonalRotation::None,
        }
    }

    /// Working raster of a text page whose right column carries a tonal plate,
    /// plus the half-resolution plane that owns every routing decision for it.
    /// Production always analyses at a fixed 150 DPI while rendering the leaf at
    /// its own higher DPI, so evidence masks reach the render grid through a
    /// nearest-neighbour upsample.
    fn text_page_beside_a_plate_fixture() -> (GrayImage, GrayImage) {
        let mut working = GrayImage::new(480, 640, 248);
        for line in 0..14 {
            let top = 40 + line * 40;
            for x in (30..260).step_by(11) {
                for glyph_x in x..x + 3 {
                    for glyph_y in top..top + 15 {
                        working.set(glyph_x, glyph_y, 38);
                    }
                }
            }
        }
        for y in 60..580 {
            for x in 300..460 {
                let value = 40 + ((x * 5 + y * 3) % 170) as u8;
                working.set(x, y, value);
            }
        }
        let canonical = working.downscale_to_dimensions(240, 320);
        (working, canonical)
    }

    fn ink_and_median_run(mask: &BinaryImage, left: usize, right: usize) -> (usize, usize) {
        let mut ink = 0usize;
        let mut runs = Vec::new();
        for y in 0..mask.height() {
            let mut run = 0usize;
            for x in left..right {
                if mask.get(x, y) {
                    ink += 1;
                    run += 1;
                } else if run > 0 {
                    runs.push(run);
                    run = 0;
                }
            }
            if run > 0 {
                runs.push(run);
            }
        }
        runs.sort_unstable();
        (ink, runs.get(runs.len() / 2).copied().unwrap_or(0))
    }

    #[test]
    fn text_recall_completes_missed_components_and_never_redraws_found_ones() {
        let mut text_mask = BinaryImage::new(40, 20);
        // A glyph the stencil found nothing of, and the same glyph one row
        // lower with a single captured pixel: the coarse evidence outlines both
        // identically, so only stencil contact may separate them.
        for shape_x in 4..10 {
            for shape_y in 4..10 {
                text_mask.set(shape_x, shape_y, true);
                text_mask.set(shape_x + 20, shape_y, true);
            }
        }
        let mut binary = BinaryImage::new(40, 20);
        binary.set(26, 6, true);

        let recalled = unowned_text_recall(&text_mask, &binary);
        assert_eq!(
            recalled.count_black(),
            36,
            "a component the stencil found nothing of must be recalled whole",
        );
        assert!(recalled.get(6, 6), "the missed component was not recalled");
        assert!(
            !recalled.get(24, 6),
            "a component the stencil already owns must not be redrawn from coarse evidence",
        );
        assert_eq!(
            recalled.and(&binary).count_black(),
            0,
            "recall may not restate pixels the stencil already published",
        );
    }

    #[test]
    fn mixed_keeps_bw_stroke_weight_for_text_beside_a_picture() {
        let (working, canonical) = text_page_beside_a_plate_fixture();
        let base = CleanupOptions {
            dpi: 300.0,
            crop_content: false,
            match_page_size: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let render = |options: &CleanupOptions| {
            let mut timings = PageStageTimings::default();
            clean_page_with_color_and_calibration_config(
                &working,
                None,
                Some(CanonicalAnalysisPlane {
                    gray: &canonical,
                    color: None,
                    dpi: 150.0,
                }),
                None,
                None,
                options,
                0,
                CalibrationConfig::default(),
                None,
                None,
                PageRenderPolicy::COMPLETE,
                &mut timings,
            )
            .unwrap()
            .outputs
            .remove(0)
        };
        let bw = render(&base);
        let CleanupRaster::Bilevel(bw_binary) = &bw.image else {
            panic!("a black-and-white render keeps the binarizer's packed bits");
        };
        let mixed = render(&CleanupOptions {
            output_mode: OutputMode::Mixed,
            manual_zones: crate::ManualZones {
                picture: vec![crate::PictureZone {
                    polygon: normalized_box_polygon(0.6, 0.05, 0.99, 0.95),
                    layer: crate::PictureZoneLayer::Painter2,
                }],
                fill: vec![],
            },
            ..base
        });
        let stencil = &mixed
            .mixed_layers
            .as_ref()
            .expect("a Mixed page with picture ownership publishes separable layers")
            .foreground_mask;

        // Only the text column, clear of the picture zone and its protection
        // ring, so this measures glyph weight rather than layer ownership.
        let (bw_ink, bw_run) = ink_and_median_run(bw_binary, 0, 270);
        let (mixed_ink, mixed_run) = ink_and_median_run(stencil, 0, 270);
        assert!(bw_ink > 5_000, "the fixture published no B&W text ink");
        assert!(bw_run > 0, "the fixture published no measurable strokes");
        assert_eq!(
            mixed_run, bw_run,
            "Mixed changed the published stroke width of text that no picture owns \
             (B&W {bw_run} px, Mixed {mixed_run} px)",
        );
        assert!(
            mixed_ink * 100 <= bw_ink * 110,
            "Mixed published materially heavier text ink than B&W for the same page \
             (B&W {bw_ink} px, Mixed {mixed_ink} px)",
        );
    }

    #[test]
    fn mixed_text_only_output_is_pixel_identical_to_bw() {
        let (source, _) = thin_stroke_fixture();
        let base = CleanupOptions {
            dpi: 300.0,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let bw = clean_page(&source, &base, 0)
            .unwrap()
            .outputs
            .remove(0)
            .image;
        let mixed = clean_page(
            &source,
            &CleanupOptions {
                output_mode: OutputMode::Mixed,
                ..base
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        assert_eq!(mixed.image, bw);
        assert!(mixed.color_image.is_none());
        assert!(mixed.mixed_layers.is_none());
    }

    #[test]
    fn binarized_output_keeps_the_packed_bits_and_widens_losslessly() {
        let (source, _) = thin_stroke_fixture();
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 300.0,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let CleanupRaster::Bilevel(binary) = &output.image else {
            panic!("a black-and-white render must keep the binarizer's packed bits");
        };
        assert!(binary.count_black() > 0, "the fixture produced no ink");
        assert_eq!(
            (binary.width(), binary.height()),
            (output.image.width(), output.image.height())
        );
        let widened = output.image.to_gray();
        for y in 0..binary.height() {
            for x in 0..binary.width() {
                let expected = if binary.get(x, y) { 0 } else { 255 };
                assert_eq!(widened.get(x, y), expected, "widened sample at ({x}, {y})");
                assert_eq!(output.image.get(x, y), expected, "sample at ({x}, {y})");
            }
        }
    }

    #[test]
    fn mixed_picture_zone_preserves_exact_source_tones_including_endpoints() {
        let mut gray = GrayImage::new(180, 120, 255);
        let mut color = RgbImage::new(180, 120, [255; 3]);
        for y in 20..100 {
            for x in 85..165 {
                let value = if (x + y) % 17 == 0 {
                    0
                } else if (x + y) % 19 == 0 {
                    255
                } else {
                    30 + ((x * 7 + y * 11) % 190) as u8
                };
                gray.set(x, y, value);
                color.set(
                    x,
                    y,
                    if value == 0 {
                        [0; 3]
                    } else {
                        [value, value.saturating_add(13), value.saturating_add(29)]
                    },
                );
            }
        }
        let options = CleanupOptions {
            output_mode: OutputMode::Mixed,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            manual_zones: crate::ManualZones {
                picture: vec![crate::PictureZone {
                    polygon: normalized_box_polygon(0.45, 0.1, 0.95, 0.9),
                    layer: crate::PictureZoneLayer::Painter2,
                }],
                fill: vec![],
            },
            ..CleanupOptions::default()
        };
        let output = clean_page_with_color(&gray, Some(&color), &options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let mixed_color = output
            .color_image
            .as_ref()
            .expect("mixed color keeps source chroma");
        let layers = output
            .mixed_layers
            .as_ref()
            .expect("mixed picture output retains separable layers");
        let mut tonal_pixels = 0usize;
        for y in 20..100 {
            for x in 85..165 {
                let gray_value = output.image.get(x, y);
                let color_value = mixed_color.get(x, y);
                assert_eq!(gray_value, gray.get(x, y));
                assert_eq!(color_value, color.get(x, y));
                assert!(
                    !layers.foreground_mask.get(x, y),
                    "confirmed picture ownership was reclaimed by the foreground stencil"
                );
                if !matches!(gray_value, 1 | 254) {
                    tonal_pixels += 1;
                }
            }
        }
        assert!(tonal_pixels > 4_000, "picture tones were not retained");
        assert!(matches!(output.image.get(20, 20), 0 | 255));
        assert_eq!(
            layers.foreground_mask.get(20, 20),
            output.image.get(20, 20) == 0
        );
        assert_eq!(layers.background.get(20, 20), 255);
        assert!(layers.color_background.is_some());
    }

    #[test]
    fn auto_color_preserves_independent_color_when_picture_detection_is_empty() {
        let mut color = RgbImage::new(360, 260, [205, 225, 245]);
        for row in 0..8 {
            for column in 0..14 {
                let left = 18 + column * 22;
                let top = 18 + row * 28;
                for y in top..top + 14 {
                    for x in left..left + 12 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            color.set(x, y, [12, 32, 76]);
                        }
                    }
                }
            }
        }
        for y in 202..222 {
            for x in 244..326 {
                color.set(x, y, [150, 22, 35]);
            }
        }
        let mut gray = GrayImage::new(color.width(), color.height(), 255);
        for y in 0..color.height() {
            for x in 0..color.width() {
                let pixel = color.get(x, y);
                gray.set(
                    x,
                    y,
                    ((u32::from(pixel[0]) * 77
                        + u32::from(pixel[1]) * 150
                        + u32::from(pixel[2]) * 29
                        + 128)
                        >> 8) as u8,
                );
            }
        }

        let output = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                output_mode: OutputMode::Auto,
                dpi: 150.0,
                normalize_illumination: true,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert_eq!(output.metadata.output_mode, OutputMode::Color);
        let color_output = output
            .color_image
            .as_ref()
            .expect("unowned color must preserve the full source page");
        let retained_red = color_output.get(270, 210);
        assert!(
            retained_red[0] > retained_red[1].saturating_add(60)
                && retained_red[0] > retained_red[2].saturating_add(50),
            "red mark was lost: {retained_red:?}"
        );
        assert!(
            color_output.get(350, 250)[2] > color_output.get(350, 250)[0],
            "safe Color fallback unexpectedly whitened the source paper"
        );
    }

    #[test]
    fn mixed_automatic_detector_retains_synthetic_photo_tones() {
        let mut source = GrayImage::new(620, 560, 242);
        for row in 0..12 {
            for column in 0..12 {
                let left = 30 + column * 22;
                let top = 40 + row * 36;
                for y in top..top + 18 {
                    for x in left..left + 14 {
                        if x < left + 3 || y < top + 3 || y >= top + 15 {
                            source.set(x, y, 28);
                        }
                    }
                }
            }
        }
        for y in 100..420 {
            for x in 340..580 {
                // Shadow masses beside midtone fields at picture scale.
                let cell = (x / 48 + y / 48) % 2 == 0;
                let value = if cell {
                    30 + ((x * 37 + y * 61) % 24) as u8
                } else {
                    120 + ((x * 13 + y * 41) % 48) as u8
                };
                source.set(x, y, value);
            }
        }
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 300.0,
                output_mode: OutputMode::Mixed,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let output_image = &output.image;
        let retained_tones = (100..420)
            .flat_map(|y| (340..580).map(move |x| output_image.get(x, y)))
            .filter(|value| !matches!(value, 0 | 255))
            .count();
        assert!(
            retained_tones > 2_000,
            "retained only {retained_tones} photo tones"
        );
    }

    #[test]
    fn automatic_picture_owner_survives_rotated_halftone_and_normalization() {
        let mut source = GrayImage::new(620, 560, 242);
        for row in 0..12 {
            for column in 0..12 {
                let left = 30 + column * 22;
                let top = 40 + row * 36;
                for y in top..top + 18 {
                    for x in left..left + 14 {
                        if x < left + 3 || y < top + 3 || y >= top + 15 {
                            source.set(x, y, 28);
                        }
                    }
                }
            }
        }
        for y in 100..420 {
            for x in 340..580 {
                let value = if (x / 48 + y / 48) % 2 == 0 {
                    38 + ((x * 37 + y * 61) % 32) as u8
                } else {
                    116 + ((x * 13 + y * 41) % 56) as u8
                };
                source.set(x, y, value);
            }
        }
        // A caption is horizontal in source space and therefore vertical
        // after the 90-degree render rotation. It must not veto tonal owner
        // confirmation merely because no horizontal text rows remain.
        for x in 390..530 {
            for y in 270..274 {
                source.set(x, y, 24);
            }
        }
        let options = CleanupOptions {
            dpi: 300.0,
            source_dpi: Some(300.0),
            output_mode: OutputMode::Auto,
            normalize_illumination: true,
            crop_content: false,
            match_page_size: false,
            layout: crate::LayoutMode::Single,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            ..CleanupOptions::default()
        };
        let prepare = |options: &CleanupOptions| {
            prepare_analysis_page(
                &source,
                None,
                options,
                true,
                PageRenderPolicy::COMPLETE,
                None,
                CalibrationConfig::default(),
                None,
                None,
                &mut PageStageTimings::default(),
            )
        };
        let prepared = prepare(&options);
        let owner = prepared
            .picture_mask
            .as_deref()
            .expect("the halftone plate must publish a vetted owner");
        assert!(owner.count_black() > 2_000);
        assert_ne!(prepared.resolved_output_mode, OutputMode::Bw);
        assert!(
            prepared
                .tonal_protection_mask
                .as_deref()
                .is_some_and(|protection| owner.and(protection).count_black() == owner.count_black()),
            "the owner must also survive the illumination exclusion handoff"
        );

        let rotated_options = CleanupOptions {
            rotation: OrthogonalRotation::Clockwise90,
            ..options.clone()
        };
        let rotated = prepare(&rotated_options);
        let rotated_owner = rotated
            .picture_mask
            .as_deref()
            .expect("rotation must not erase the tonal owner");
        assert!(rotated_owner.count_black() > 2_000);
        assert_ne!(rotated.resolved_output_mode, OutputMode::Bw);
        let rotated_components = ComponentMap::from_binary(rotated_owner);
        let rotated_component = rotated_components
            .components()
            .iter()
            .max_by_key(|component| component.area)
            .expect("rotated owner must have a dominant plate component");
        assert!(
            (40..=90).contains(&rotated_component.left)
                && (210..=250).contains(&rotated_component.right)
                && (160..=190).contains(&rotated_component.top)
                && (270..=305).contains(&rotated_component.bottom),
            "rotated owner landed in the wrong bbox: {rotated_component:?}"
        );
        assert!(rotated_owner.get(150, 220), "rotated plate center lost ownership");
        assert!(!rotated_owner.get(25, 220), "owner was transposed into the margin");

        let output = clean_page(&source, &rotated_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        assert_ne!(output.metadata.output_mode, OutputMode::Bw);
        let rendered = output.image.to_gray();
        assert_eq!((rendered.width(), rendered.height()), (560, 620));
        let mut retained_tones = 0usize;
        for y in 350..580 {
            for x in 150..450 {
                if (8..=247).contains(&rendered.get(x, y)) {
                    retained_tones += 1;
                }
            }
        }
        assert!(
            retained_tones > 10_000,
            "illumination/background flattening collapsed the owned plate: {retained_tones} tones"
        );
    }

    #[test]
    fn photo_descreen_filter_is_scoped_to_the_confirmed_owner() {
        let mut image = GrayImage::new(9, 9, 242);
        let mut owner = BinaryImage::new(9, 9);
        for y in 2..7 {
            for x in 2..7 {
                owner.set(x, y, true);
                image.set(x, y, if (x + y) % 2 == 0 { 48 } else { 208 });
            }
        }
        let outside_before = image.get(1, 4);
        let center_before = image.get(4, 4);
        prefilter_confirmed_photo_regions(&mut image, &owner);
        assert_eq!(image.get(1, 4), outside_before);
        assert_ne!(image.get(4, 4), center_before);
        assert!((48..=208).contains(&image.get(4, 4)));
    }

    #[test]
    fn photo_descreen_gate_uses_the_region_source_extent() {
        assert!(
            !should_prefilter_confirmed_photo_regions(
                true,
                OutputMode::Mixed,
                600,
                800,
                600,
                800,
            ),
            "a 1:1 split-page region must not receive an unearned descreen pass"
        );
        assert!(should_prefilter_confirmed_photo_regions(
            true,
            OutputMode::Grayscale,
            300,
            400,
            600,
            800,
        ));
        assert!(!should_prefilter_confirmed_photo_regions(
            false,
            OutputMode::Mixed,
            300,
            400,
            600,
            800,
        ));
        assert!(!should_prefilter_confirmed_photo_regions(
            true,
            OutputMode::Bw,
            300,
            400,
            600,
            800,
        ));
    }

    #[test]
    fn mixed_composite_feathers_light_mask_blocks_without_losing_dark_picture_edges() {
        let mut gray = GrayImage::new(120, 80, 255);
        let mut mask = BinaryImage::new(120, 80);
        let mut binary = BinaryImage::new(120, 80);
        for y in 35..39 {
            for x in 8..24 {
                binary.set(x, y, true);
            }
        }
        for y in 15..65 {
            for x in 30..90 {
                mask.set(x, y, true);
                gray.set(x, y, if y < 23 { 235 } else { 112 });
            }
        }
        for x in 30..90 {
            gray.set(x, 24, 54);
        }

        let (mixed, _, layers) = compose_mixed(
            &gray, None, None, &binary, &mask, None, None, None, None, 300.0, false, false, true,
            true,
        );
        let layers = layers.expect("final mixed render retains separable layers");

        assert!(
            (30..45).all(|x| mixed.get(x, 15) >= 248),
            "light block boundary next to the stencil was not feathered"
        );
        assert!(
            (30..90).all(|x| mixed.get(x, 24) <= 60),
            "dark engraving edge was washed out"
        );
        assert_eq!(mixed.get(60, 40), 112);
        assert_eq!(mixed.get(29, 40), 255);
        assert_eq!(mixed.get(12, 36), 0);
        assert!(layers.foreground_mask.get(12, 36));
        assert_eq!(
            layers.background.get(12, 36),
            255,
            "text pixels are filled from the normalized background instead of leaking into JPEG"
        );
    }

    #[test]
    fn confirmed_photo_composition_preserves_every_owned_tone_through_the_boundary() {
        let mut gray = GrayImage::new(160, 100, 255);
        let mut picture_mask = BinaryImage::new(160, 100);
        for y in 20..80 {
            for x in 40..120 {
                picture_mask.set(x, y, true);
                gray.set(x, y, 170);
            }
        }
        gray.set(40, 50, 0);
        gray.set(119, 50, 255);
        // Keep stencil ink close enough to exercise the old luminance-based
        // whitening path without letting it own any picture pixel.
        let mut binary = BinaryImage::new(160, 100);
        for y in 50..53 {
            for x in 34..38 {
                binary.set(x, y, true);
            }
        }

        let (mixed, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &binary,
            &picture_mask,
            None,
            None,
            None,
            None,
            300.0,
            true,
            false,
            true,
            true,
        );
        assert_eq!(mixed.get(80, 50), 170);
        assert_eq!(
            mixed.get(46, 50),
            170,
            "confirmed photo interiors must not be whitened near stencil ink"
        );
        assert_eq!(
            mixed.get(40, 50),
            0,
            "the first owned boundary pixel must retain exact source tone"
        );
        assert_eq!(mixed.get(119, 50), 255);
        let layers = layers.unwrap();
        assert_eq!(layers.background.get(40, 50), 0);
        assert_eq!(layers.background.get(119, 50), 255);
        assert_eq!(layers.background.get(80, 50), 170);

        let (soft_composite, _, soft_layers) = compose_mixed(
            &gray,
            None,
            None,
            &binary,
            &picture_mask,
            None,
            None,
            None,
            None,
            300.0,
            true,
            true,
            true,
            true,
        );
        let soft_layers = soft_layers.expect("soft Mixed output retains its plate");
        assert_eq!(soft_layers.background.get(80, 50), 170);
        assert_eq!(soft_composite.get(80, 50), 170);
    }

    #[test]
    fn mixed_background_fills_stencil_holes_from_picture_neighbors() {
        let mut gray = GrayImage::new(48, 32, 245);
        let mut color = RgbImage::new(48, 32, [245; 3]);
        let mut picture_mask = BinaryImage::new(48, 32);
        for y in 6..26 {
            for x in 12..36 {
                picture_mask.set(x, y, true);
                gray.set(x, y, 132);
                color.set(x, y, [82, 126, 174]);
            }
        }
        let mut binary = BinaryImage::new(48, 32);
        for y in 13..20 {
            for x in 20..25 {
                binary.set(x, y, true);
            }
        }
        // An ordinary paper glyph must keep its white knockout.
        for y in 2..5 {
            for x in 3..8 {
                binary.set(x, y, true);
            }
        }

        let (composite, composite_color, layers) = compose_mixed(
            &gray,
            None,
            Some(&color),
            &binary,
            &picture_mask,
            Some(&picture_mask),
            None,
            None,
            None,
            600.0,
            false,
            false,
            true,
            true,
        );
        let layers = layers.expect("Mixed output retains its separable layers");
        assert_eq!(
            composite.get(22, 16),
            132,
            "a leaked binary blob inside a picture must remain picture-owned"
        );
        assert_eq!(layers.background.get(22, 16), 132);
        assert_eq!(
            layers
                .color_background
                .as_ref()
                .expect("picture chroma retains a color plate")
                .get(22, 16),
            [82, 126, 174]
        );
        assert_eq!(layers.background.get(5, 3), 255);
        assert_eq!(composite_color.unwrap().get(22, 16), [82, 126, 174]);

        let (_, _, soft_layers) = compose_mixed(
            &gray,
            None,
            Some(&color),
            &binary,
            &picture_mask,
            Some(&picture_mask),
            None,
            None,
            None,
            600.0,
            false,
            true,
            true,
            true,
        );
        assert_eq!(
            soft_layers
                .expect("soft Mixed output retains its separable layers")
                .background
                .get(22, 16),
            132
        );

        let downscaled = layers.background.downscale_to_dimensions(16, 11);
        assert_eq!(
            downscaled.get(7, 5),
            132,
            "box downscaling must not spread a white stencil knockout"
        );
    }

    #[test]
    fn soft_mixed_foreground_preserves_antialiased_coverage_and_leaves_photos_on_the_plate() {
        let mut gray = GrayImage::new(24, 12, 255);
        let mut picture_mask = BinaryImage::new(24, 12);
        let mut text_vicinity = BinaryImage::new(24, 12);
        let binary_fallback = BinaryImage::new(24, 12);
        let mut detected_text = BinaryImage::new(24, 12);
        for (x, value) in [0u8, 64, 128, 220].into_iter().enumerate() {
            gray.set(3 + x, 4, value);
            text_vicinity.set(3 + x, 4, true);
        }
        detected_text.set(3, 4, true);
        detected_text.set(4, 4, true);
        for y in 2..10 {
            for x in 14..22 {
                picture_mask.set(x, y, true);
                gray.set(x, y, 80 + ((x + y) % 40) as u8);
            }
        }

        let (composite, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &binary_fallback,
            &picture_mask,
            None,
            None,
            Some(&detected_text),
            Some(&text_vicinity),
            300.0,
            false,
            true,
            true,
            true,
        );
        let layers = layers.expect("soft mixed output retains separable layers");
        let alpha = layers
            .foreground_alpha
            .as_ref()
            .expect("soft mixed output publishes an alpha plane");

        assert_eq!(
            (3..7).map(|x| alpha.get(x, 4)).collect::<Vec<_>>(),
            vec![255, 191, 127, 35]
        );
        assert!((3..7).all(|x| layers.background.get(x, 4) == 255));
        assert_eq!(alpha.get(17, 5), 0);
        assert_eq!(layers.background.get(17, 5), gray.get(17, 5));
        assert_eq!(
            (3..7).map(|x| composite.get(x, 4)).collect::<Vec<_>>(),
            vec![0, 64, 128, 220]
        );
        assert_eq!(composite.get(17, 5), gray.get(17, 5));
    }

    #[test]
    fn soft_mixed_foreground_keeps_binary_core_outside_text_vicinity() {
        let mut gray = GrayImage::new(16, 10, 255);
        let picture_mask = BinaryImage::new(16, 10);
        let mut binary_fallback = BinaryImage::new(16, 10);
        let text_vicinity = BinaryImage::new(16, 10);
        gray.set(7, 5, 24);
        binary_fallback.set(7, 5, true);

        let (_, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &binary_fallback,
            &picture_mask,
            None,
            None,
            None,
            Some(&text_vicinity),
            300.0,
            false,
            true,
            true,
            true,
        );
        let alpha = layers
            .expect("soft mixed output retains separable layers")
            .foreground_alpha
            .expect("soft mixed output publishes an alpha plane");

        assert_eq!(alpha.get(7, 5), 231);
    }

    #[test]
    fn soft_mixed_foreground_recovers_raw_ink_absorbed_by_illumination_normalization() {
        let normalized = GrayImage::new(16, 10, 255);
        let mut raw = GrayImage::new(16, 10, 220);
        let picture_mask = BinaryImage::new(16, 10);
        let mut binary_fallback = BinaryImage::new(16, 10);
        raw.set(7, 5, 30);
        binary_fallback.set(7, 5, true);

        let (_, _, layers) = compose_mixed(
            &normalized,
            Some(&raw),
            None,
            &binary_fallback,
            &picture_mask,
            None,
            None,
            None,
            None,
            200.0,
            false,
            true,
            true,
            true,
        );
        let layers = layers.expect("soft mixed output retains separable layers");
        let alpha = layers
            .foreground_alpha
            .expect("soft mixed output publishes an alpha plane");

        assert!(alpha.get(7, 5) >= 200);
        assert_eq!(layers.background.get(7, 5), 255);
    }

    #[test]
    fn raw_ink_rescue_keeps_small_marks_but_rejects_broad_shadows() {
        let mut raw = GrayImage::new(200, 120, 220);
        let picture_mask = BinaryImage::new(200, 120);
        for y in 60..85 {
            for x in 0..200 {
                raw.set(x, y, 120);
            }
        }
        for x in 30..50 {
            raw.set(x, 20, 30);
            raw.set(x, 39, 30);
        }
        for y in 20..40 {
            raw.set(30, y, 30);
            raw.set(49, y, 30);
        }

        let rescued = rescue_isolated_raw_ink(&raw, &picture_mask, 200.0);

        assert!(rescued.get(30, 20));
        assert!(rescued.get(49, 39));
        assert!(!rescued.get(100, 72));
    }

    #[test]
    fn soft_mixed_foreground_keeps_trusted_text_even_when_picture_detection_overlaps_it() {
        let mut gray = GrayImage::new(16, 10, 220);
        let mut picture_mask = BinaryImage::new(16, 10);
        let mut text_mask = BinaryImage::new(16, 10);
        let binary_fallback = BinaryImage::new(16, 10);
        for y in 0..10 {
            for x in 0..16 {
                picture_mask.set(x, y, true);
            }
        }
        gray.set(7, 5, 48);
        text_mask.set(7, 5, true);

        let (_, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &binary_fallback,
            &picture_mask,
            None,
            None,
            Some(&text_mask),
            Some(&text_mask),
            300.0,
            false,
            true,
            true,
            true,
        );
        let layers = layers.expect("soft mixed output retains separable layers");
        let alpha = layers
            .foreground_alpha
            .expect("soft mixed output publishes an alpha plane");

        assert!(
            alpha.get(7, 5) >= 182,
            "trusted text must override an over-broad picture mask"
        );
        assert_eq!(layers.background.get(7, 5), 255);
    }

    #[test]
    fn soft_mixed_foreground_leaves_chromatic_picture_detail_on_the_plate() {
        let mut gray = GrayImage::new(16, 10, 220);
        let mut color = RgbImage::new(16, 10, [220; 3]);
        let mut picture_mask = BinaryImage::new(16, 10);
        let mut chroma_picture_mask = BinaryImage::new(16, 10);
        let mut text_mask = BinaryImage::new(16, 10);
        let mut binary_fallback = BinaryImage::new(16, 10);
        gray.set(7, 5, 60);
        color.set(7, 5, [140, 20, 30]);
        picture_mask.set(7, 5, true);
        chroma_picture_mask.set(7, 5, true);
        text_mask.set(7, 5, true);
        binary_fallback.set(7, 5, true);

        let (_, _, layers) = compose_mixed(
            &gray,
            None,
            Some(&color),
            &binary_fallback,
            &picture_mask,
            Some(&chroma_picture_mask),
            None,
            Some(&text_mask),
            Some(&text_mask),
            300.0,
            false,
            true,
            true,
            true,
        );
        let layers = layers.expect("soft mixed output retains separable layers");
        let alpha = layers
            .foreground_alpha
            .expect("soft mixed output publishes an alpha plane");

        assert_eq!(alpha.get(7, 5), 0);
        assert_eq!(layers.color_background.unwrap().get(7, 5), [140, 20, 30]);
    }

    #[test]
    fn mixed_composite_assigns_the_picture_protection_ring_to_paper_or_dark_edges() {
        let mut gray = GrayImage::new(120, 80, 255);
        let mut picture_mask = BinaryImage::new(120, 80);
        let stencil = BinaryImage::new(120, 80);
        for y in 15..65 {
            for x in 30..90 {
                picture_mask.set(x, y, true);
                gray.set(x, y, 120);
            }
        }
        for y in 25..55 {
            gray.set(28, y, 220);
            gray.set(29, y, 80);
        }

        let (mixed, _, _) = compose_mixed(
            &gray,
            None,
            None,
            &stencil,
            &picture_mask,
            None,
            None,
            None,
            None,
            300.0,
            false,
            false,
            false,
            true,
        );

        assert!(
            (25..55).all(|y| mixed.get(28, y) >= 254),
            "light paper in the protected annulus must not retain a gray halo"
        );
        assert!(
            (25..55).all(|y| mixed.get(29, y) == 80),
            "a dark photo edge in the protected annulus must remain owned by the picture"
        );
    }

    #[test]
    fn mixed_composite_whitens_dense_scanner_bands_without_removing_thin_rules() {
        let mut gray = GrayImage::new(400, 600, 255);
        let mut stencil = BinaryImage::new(400, 600);
        let picture_mask = BinaryImage::new(400, 600);
        for y in 5..21 {
            for x in 18..382 {
                stencil.set(x, y, true);
                gray.set(x, y, 36);
            }
        }
        for x in 24..376 {
            stencil.set(x, 36, true);
            gray.set(x, 36, 24);
        }

        let (stencil, removed) =
            suppress_scanner_edge_bands(&stencil, &gray, &picture_mask, None, 100.0);
        let (mixed, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &stencil,
            &picture_mask,
            None,
            Some(&removed),
            None,
            None,
            100.0,
            false,
            false,
            true,
            true,
        );
        let layers = layers.expect("mixed output keeps separable layers");

        assert!((18..382).all(|x| mixed.get(x, 12) == 255));
        assert!((18..382).all(|x| !layers.foreground_mask.get(x, 12)));
        assert!(
            (24..376).all(|x| layers.foreground_mask.get(x, 36)),
            "a one-pixel printed rule must not be classified as a scanner band"
        );
    }

    #[test]
    fn scanner_band_suppression_does_not_erase_picture_owned_edges() {
        let mut stencil = BinaryImage::new(400, 600);
        let gray = GrayImage::new(400, 600, 150);
        let mut picture_mask = BinaryImage::new(400, 600);
        for y in 5..21 {
            for x in 18..382 {
                stencil.set(x, y, true);
                picture_mask.set(x, y, true);
            }
        }

        let (cleaned, removed) =
            suppress_scanner_edge_bands(&stencil, &gray, &picture_mask, None, 100.0);

        assert_eq!(cleaned.count_black(), stencil.count_black());
        assert_eq!(removed.count_black(), 0);
    }

    #[test]
    fn scanner_boundary_components_require_picture_or_text_ownership() {
        let mut stencil = BinaryImage::new(400, 600);
        let gray = GrayImage::new(400, 600, 150);
        let mut picture_mask = BinaryImage::new(400, 600);
        let mut text_vicinity = BinaryImage::new(400, 600);

        for y in 100..500 {
            for x in 0..60 {
                stencil.set(x, y, true);
            }
        }
        for y in 550..590 {
            for x in 200..280 {
                stencil.set(x, y, true);
            }
        }
        for y in 150..450 {
            for x in 80..120 {
                stencil.set(x, y, true);
                picture_mask.set(x, y, true);
            }
        }
        for y in 10..16 {
            for x in 100..300 {
                stencil.set(x, y, true);
                text_vicinity.set(x, y, true);
            }
        }

        let (cleaned, removed) = suppress_scanner_edge_bands(
            &stencil,
            &gray,
            &picture_mask,
            Some(&text_vicinity),
            100.0,
        );

        assert!(removed.get(5, 120));
        assert!(removed.get(220, 570));
        assert!(!cleaned.get(5, 120));
        assert!(!cleaned.get(220, 570));
        assert!(
            cleaned.get(80, 300),
            "picture-owned boundary content was removed"
        );
        assert!(
            cleaned.get(180, 12),
            "text-owned boundary content was removed"
        );
    }

    #[test]
    fn scanner_boundary_tall_rail_uses_ten_mm_contact_but_owned_ornament_survives() {
        let mut stencil = BinaryImage::new(400, 600);
        let gray = GrayImage::new(400, 600, 30);
        let mut picture_mask = BinaryImage::new(400, 600);

        // A connected, broken rail begins 5 mm from the left edge at 100 DPI.
        // Its sparse rows avoid the dense-column fast path, exercising the
        // connected-component fallback widened by the 10 mm branch.
        for y in 100..340 {
            if y % 3 == 0 {
                for x in 20..33 {
                    stencil.set(x, y, true);
                }
            } else {
                stencil.set(20, y, true);
            }
        }

        // This 20 mm-tall marginal ornament starts at the same 5 mm inset,
        // but semantic picture ownership must protect it from the rail rule.
        for y in 400..480 {
            for x in 20..36 {
                stencil.set(x, y, true);
                picture_mask.set(x, y, true);
            }
        }

        let (cleaned, removed) =
            suppress_scanner_edge_bands(&stencil, &gray, &picture_mask, None, 100.0);

        let rail_remaining = (100..340)
            .flat_map(|y| (20..33).map(move |x| (x, y)))
            .filter(|&(x, y)| cleaned.get(x, y))
            .count();
        assert_eq!(rail_remaining, 0, "rail pixels remaining: {rail_remaining}");
        assert!((100..340)
            .flat_map(|y| (20..33).map(move |x| (x, y)))
            .filter(|&(x, y)| stencil.get(x, y))
            .all(|(x, y)| removed.get(x, y)));
        assert!((100..340)
            .flat_map(|y| (20..33).map(move |x| (x, y)))
            .filter(|&(x, y)| stencil.get(x, y))
            .all(|(x, y)| !cleaned.get(x, y)));
        assert!((400..480).all(|y| (20..36).all(|x| cleaned.get(x, y))));
        assert!((400..480).all(|y| (20..36).all(|x| !removed.get(x, y))));
    }

    #[test]
    fn scanner_boundary_pale_rail_overrides_false_text_ownership_but_keeps_dark_marginalia() {
        let mut stencil = BinaryImage::new(400, 700);
        let mut gray = GrayImage::new(400, 700, 255);
        let picture_mask = BinaryImage::new(400, 700);
        let mut text_vicinity = BinaryImage::new(400, 700);

        // The full-resolution p349 flow incorrectly claims most of this pale
        // broken scanner rail as text. Its tall/deep boundary-shadow geometry
        // is stronger evidence than that text-only ownership claim.
        for y in 100..340 {
            let right = if y % 3 == 0 { 33 } else { 21 };
            for x in 20..right {
                stencil.set(x, y, true);
                gray.set(x, y, 150);
                text_vicinity.set(x, y, true);
            }
        }

        // Genuine marginal writing can have the same inset and span. Its dark
        // tone keeps it outside the boundary-shadow override.
        for y in 400..560 {
            for x in 20..36 {
                stencil.set(x, y, true);
                gray.set(x, y, 30);
                text_vicinity.set(x, y, true);
            }
        }

        let (cleaned, removed) = suppress_scanner_edge_bands(
            &stencil,
            &gray,
            &picture_mask,
            Some(&text_vicinity),
            100.0,
        );

        assert!((100..340)
            .flat_map(|y| (20..33).map(move |x| (x, y)))
            .filter(|&(x, y)| stencil.get(x, y))
            .all(|(x, y)| removed.get(x, y) && !cleaned.get(x, y)));
        assert!((400..560).all(|y| (20..36).all(|x| cleaned.get(x, y))));
        assert!((400..560).all(|y| (20..36).all(|x| !removed.get(x, y))));
    }

    #[test]
    fn scanner_boundary_suppression_preserves_printable_line_art_inside_the_margin() {
        let mut stencil = BinaryImage::new(400, 600);
        let gray = GrayImage::new(400, 600, 150);
        let picture_mask = BinaryImage::new(400, 600);
        for x in 150..175 {
            stencil.set(x, 75, true);
            stencil.set(x, 99, true);
        }
        for y in 75..100 {
            stencil.set(150, y, true);
            stencil.set(174, y, true);
        }

        let (cleaned, removed) =
            suppress_scanner_edge_bands(&stencil, &gray, &picture_mask, None, 100.0);

        assert_eq!(cleaned.count_black(), stencil.count_black());
        assert_eq!(removed.count_black(), 0);
    }

    #[test]
    fn scanner_shadow_l_shape_is_removed_but_dark_printed_frame_survives() {
        let mut shadow = BinaryImage::new(400, 600);
        for y in 0..460 {
            for x in 0..145 {
                shadow.set(x, y, true);
            }
        }
        for y in 0..70 {
            for x in 0..400 {
                shadow.set(x, y, true);
            }
        }
        let picture_mask = BinaryImage::new(400, 600);
        let pale_shadow = GrayImage::new(400, 600, 150);
        let dark_print = GrayImage::new(400, 600, 30);

        let (cleaned_shadow, _) =
            suppress_scanner_edge_bands(&shadow, &pale_shadow, &picture_mask, None, 100.0);
        let (cleaned_print, _) =
            suppress_scanner_edge_bands(&shadow, &dark_print, &picture_mask, None, 100.0);

        assert_eq!(cleaned_shadow.count_black(), 0);
        assert_eq!(cleaned_print.count_black(), shadow.count_black());
    }

    #[test]
    fn mixed_composite_preserves_a_pale_vignette_away_from_the_stencil() {
        let mut gray = GrayImage::new(128, 96, 248);
        let mut picture_mask = BinaryImage::new(128, 96);
        let mut stencil = BinaryImage::new(128, 96);
        for y in 12..84 {
            for x in 24..112 {
                picture_mask.set(x, y, true);
                let edge_distance = (x - 24).min(111 - x).min((y - 12).min(83 - y));
                gray.set(x, y, 232 + edge_distance.min(14) as u8);
            }
        }
        for y in 40..56 {
            for x in 16..21 {
                gray.set(x, y, 20);
                stencil.set(x, y, true);
            }
        }
        let source_vignette = (12..27).map(|y| gray.get(80, y)).collect::<Vec<_>>();

        let (mixed, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &stencil,
            &picture_mask,
            None,
            None,
            None,
            None,
            300.0,
            false,
            false,
            true,
            true,
        );
        let rendered_vignette = (12..27).map(|y| mixed.get(80, y)).collect::<Vec<_>>();

        assert_eq!(
            rendered_vignette, source_vignette,
            "a pale border gradient far from stencil ink must retain its source tones"
        );
        assert!(
            mixed.get(24, 48) > gray.get(24, 48),
            "the light picture boundary next to stencil ink still needs separation"
        );
        assert_eq!(
            layers.unwrap().background.get(18, 48),
            255,
            "stencil ink must remain reclaimed from the JPEG background"
        );
    }

    #[test]
    fn mixed_jpeg_ringing_is_bounded_for_every_picture_edge_block_phase() {
        const DPI: f64 = 300.0;
        let text_gap = (DPI * 0.5 / 25.4).round() as usize;
        let phase_amplitudes = (25..=32)
            .map(|picture_right| {
                let text_left = picture_right + text_gap;
                let mut gray = GrayImage::new(96, 64, 246);
                let mut picture_mask = BinaryImage::new(96, 64);
                let mut stencil = BinaryImage::new(96, 64);
                for y in 8..56 {
                    for x in 8..picture_right {
                        picture_mask.set(x, y, true);
                        gray.set(x, y, if x + 8 >= picture_right { 12 } else { 156 });
                    }
                }
                for y in 20..44 {
                    for x in text_left..text_left + 3 {
                        gray.set(x, y, 18);
                        stencil.set(x, y, true);
                    }
                }

                let (_, _, layers) = compose_mixed(
                    &gray,
                    None,
                    None,
                    &stencil,
                    &picture_mask,
                    None,
                    None,
                    None,
                    None,
                    DPI,
                    false,
                    false,
                    true,
                    true,
                );
                let background = &layers.unwrap().background;
                assert!(
                    (20..44).all(|y| background.get(text_left, y) == 255),
                    "the layered background must reclaim the nearby stencil"
                );

                let decoded = jpeg_luma_roundtrip(background, 85);
                let decoded = &decoded;
                (20..44)
                    .flat_map(|y| {
                        (picture_right..text_left)
                            .map(move |x| background.get(x, y).abs_diff(decoded.get(x, y)))
                    })
                    .max()
                    .unwrap()
            })
            .collect::<Vec<_>>();

        assert!(
            phase_amplitudes.iter().all(|&amplitude| amplitude <= 3),
            "JPEG ringing by picture-edge block phase: {phase_amplitudes:?}"
        );
        assert!(
            phase_amplitudes.iter().any(|&amplitude| amplitude != 0),
            "fixture must exercise a lossy decoded reclaimed strip"
        );
        assert!(
            phase_amplitudes[7] <= 3,
            "the block-aligned edge exceeded the reclaimed-strip bound"
        );
    }

    #[test]
    fn mixed_caption_touching_picture_boundary_is_covered_by_at_least_one_layer() {
        let mut gray = GrayImage::new(96, 72, 242);
        let mut picture_mask = BinaryImage::new(96, 72);
        for y in 8..64 {
            for x in 48..88 {
                picture_mask.set(x, y, true);
                gray.set(x, y, 176);
            }
        }
        let caption_pixels = (42..53)
            .flat_map(|x| (38..41).map(move |y| (x, y)))
            .collect::<Vec<_>>();
        for &(x, y) in &caption_pixels {
            gray.set(x, y, 24);
        }
        let options = CleanupOptions {
            dpi: 300.0,
            output_mode: OutputMode::Mixed,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let calibration =
            PageCalibration::estimate(&gray, options.dpi, CalibrationConfig::default());
        let (stencil, _, _, _) = binarize_normalized_with_diagnostics_excluding(
            &gray,
            &gray,
            resolve_binarization_diagnostics(&gray, &options),
            None,
            &options,
            calibration,
            &picture_mask,
            None,
            None,
        );
        let (_, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &stencil,
            &picture_mask,
            None,
            None,
            None,
            None,
            options.dpi,
            false,
            false,
            true,
            true,
        );
        let layers = layers.expect("final mixed render retains separable layers");

        assert!(
            caption_pixels
                .iter()
                .all(|&(x, y)| { stencil.get(x, y) || layers.background.get(x, y) <= 64 }),
            "every source caption stroke must survive in the stencil/background union"
        );
        assert!(
            caption_pixels
                .iter()
                .any(|&(x, y)| !stencil.get(x, y) && layers.background.get(x, y) <= 64),
            "fixture must exercise caption pixels removed by picture-mask dilation"
        );
    }

    #[test]
    fn trusted_mrc_tone_recovers_missing_ownership_without_broadening_a_complete_owner() {
        let mut source = GrayImage::new(480, 600, 244);
        for line in 0..16 {
            let top = 28 + line * 28;
            for y in top..top + 7 {
                for x in 24..218 {
                    if (x + y) % 8 < 5 {
                        source.set(x, y, 24);
                    }
                }
            }
        }
        let mut tonal_background = GrayImage::new(240, 300, 244);
        for y in 60..252 {
            for x in 126..228 {
                tonal_background.set(x, y, 32 + ((x * 17 + y * 29) % 181) as u8);
            }
        }
        let flat_background = GrayImage::new(240, 300, 244);
        let options = CleanupOptions {
            dpi: 240.0,
            source_dpi: Some(240.0),
            source_background_dpi: Some(120.0),
            trusted_mrc_source_available: true,
            output_mode: OutputMode::Mixed,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let prepare = |background: &GrayImage| {
            prepare_analysis_page(
                &source,
                None,
                &options,
                true,
                PageRenderPolicy::COMPLETE,
                None,
                CalibrationConfig::default(),
                None,
                Some(background),
                &mut PageStageTimings::default(),
            )
        };

        let flat = prepare(&flat_background);
        assert_eq!(
            flat.picture_mask
                .as_deref()
                .map_or(0, BinaryImage::count_black),
            0,
            "flat producer paper must not create photo ownership"
        );

        let tonal = prepare(&tonal_background);
        let owner = tonal
            .picture_mask
            .as_deref()
            .expect("trusted producer tone creates a picture owner");
        assert!(
            owner.count_black() > 20_000,
            "trusted tonal evidence was not mapped onto the analysis grid"
        );
        assert!(owner.get(220, 195));
        assert!(!owner.get(60, 195), "text-side paper became photo-owned");
        let owned_tone = tonal
            .tonal_protection_mask
            .as_deref()
            .expect("trusted photo ownership remains authoritative after text carving");
        assert_eq!(
            owner.and(owned_tone).count_black(),
            owner.count_black(),
            "the final Mixed partition would carve the recovered photo a second time"
        );

        let mut source_with_photo = source.clone();
        // Cover the authored background's mapped 252..456 x 120..504
        // rectangle with a margin, so the ordinary detector already owns
        // the complete producer region.
        for y in 105..520 {
            for x in 240..468 {
                source_with_photo.set(x, y, 32 + ((x * 17 + y * 29) % 181) as u8);
            }
        }
        let prepare_existing = |background: Option<&GrayImage>| {
            prepare_analysis_page(
                &source_with_photo,
                None,
                &options,
                true,
                PageRenderPolicy::COMPLETE,
                None,
                CalibrationConfig::default(),
                None,
                background,
                &mut PageStageTimings::default(),
            )
        };
        assert_eq!(
            prepare_existing(None).picture_mask,
            prepare_existing(Some(&tonal_background)).picture_mask,
            "trusted fallback must not broaden an ordinary owner"
        );
    }

    #[test]
    fn trusted_mrc_owner_carves_caption_text_without_reviving_rejected_text_components() {
        let mut source = GrayImage::new(480, 600, 244);
        let draw_glyph_line = |source: &mut GrayImage, left: usize, top: usize, glyphs: usize| {
            for glyph in 0..glyphs {
                let glyph_left = left + glyph * 11;
                for y in top..top + 10 {
                    for x in glyph_left..glyph_left + 7 {
                        if x < glyph_left + 2 || y < top + 2 || y >= top + 8 {
                            source.set(x, y, 24);
                        }
                    }
                }
            }
        };
        // A text-only producer-tone component must be rejected as a whole.
        for line in 0..15 {
            draw_glyph_line(&mut source, 18, 28 + line * 30, 15);
        }
        // This caption lies inside a much larger photo owner. Non-glyph marks
        // model ordinary image texture so the component itself is not text-like;
        // the real text-vicinity carve still has to remove the caption pixels.
        draw_glyph_line(&mut source, 300, 338, 11);
        for mark in 0..30 {
            let left = 268 + (mark % 10) * 18;
            let top = 128 + (mark / 10) * 70;
            for y in top..top + 2 {
                for x in left..left + 2 {
                    source.set(x, y, 24);
                }
            }
        }

        let mut trusted_tone = BinaryImage::new(source.width(), source.height());
        for y in 10..500 {
            for x in 10..220 {
                trusted_tone.set(x, y, true);
            }
        }
        for y in 100..520 {
            for x in 250..470 {
                trusted_tone.set(x, y, true);
            }
        }
        let mut text_vicinity = BinaryImage::new(source.width(), source.height());
        for y in 330..358 {
            for x in 292..430 {
                text_vicinity.set(x, y, true);
            }
        }
        let calibration =
            PageCalibration::estimate(&source, 240.0, CalibrationConfig::default());
        assert!(calibration.valid, "caption fixture did not calibrate");

        let owner = carve_trusted_mrc_tone_owner(
            &source,
            trusted_tone,
            Some(&text_vicinity),
            240.0,
            calibration,
        );

        assert!(owner.get(275, 180), "the genuine photo owner was rejected");
        assert!(
            !owner.get(305, 342),
            "caption pixels inside the original owner were not carved"
        );
        assert!(
            !owner.get(80, 180),
            "the text-only component was revived after component rejection"
        );
    }

    #[test]
    fn trusted_irregular_photo_owner_rectangularizes_unless_a_caption_occupies_the_gap() {
        fn source_page(with_caption: bool) -> GrayImage {
            let mut source = GrayImage::new(480, 600, 244);
            for line in 0..15 {
                let top = 28 + line * 30;
                for glyph in 0..7 {
                    let left = 16 + glyph * 9;
                    for y in top..top + 9 {
                        for x in left..left + 6 {
                            if x < left + 2 || y < top + 2 || y >= top + 7 {
                                source.set(x, y, 24);
                            }
                        }
                    }
                }
            }
            for y in 48..552 {
                for x in 96..480 {
                    source.set(x, y, 158 + ((x + y) % 7) as u8);
                }
            }
            if with_caption {
                for glyph in 0..11 {
                    let left = 302 + glyph * 11;
                    for y in 338..350 {
                        for x in left..left + 7 {
                            if x < left + 2 || !(340..348).contains(&y) {
                                source.set(x, y, 24);
                            }
                        }
                    }
                }
            }
            source
        }

        let mut trusted_background = GrayImage::new(240, 300, 244);
        for y in 48..252 {
            for x in 72..216 {
                if x < 120 || y < 96 {
                    trusted_background.set(x, y, 32 + ((x * 17 + y * 29) % 181) as u8);
                }
            }
        }
        let options = CleanupOptions {
            dpi: 240.0,
            source_dpi: Some(240.0),
            source_background_dpi: Some(120.0),
            trusted_mrc_source_available: true,
            output_mode: OutputMode::Mixed,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let prepare = |source: &GrayImage| {
            prepare_analysis_page(
                source,
                None,
                &options,
                true,
                PageRenderPolicy::COMPLETE,
                None,
                CalibrationConfig::default(),
                None,
                Some(&trusted_background),
                &mut PageStageTimings::default(),
            )
        };

        let rectangular = prepare(&source_page(false));
        let rectangular_owner = rectangular
            .picture_mask
            .as_deref()
            .expect("trusted tone must publish ownership");
        let gap_x = 390 * rectangular_owner.width() / 480;
        let gap_y = 430 * rectangular_owner.height() / 600;
        assert!(
            rectangular_owner.get(gap_x, gap_y),
            "the tone-compatible missing corner was not rectangularized"
        );
        assert!(
            rectangular
                .tonal_protection_mask
                .as_deref()
                .is_some_and(|mask| mask.get(gap_x, gap_y)),
            "an approved rectangle must survive the final Mixed text partition"
        );

        let captioned = prepare(&source_page(true));
        let captioned_owner = captioned
            .picture_mask
            .as_deref()
            .expect("the original trusted owner remains after a rectangle veto");
        assert!(
            !captioned_owner.get(gap_x, gap_y),
            "a real caption line must veto whole-rectangle ownership"
        );
        assert!(
            captioned.text_mask.as_deref().is_some_and(|mask| {
                mask.get(336 * mask.width() / 480, 342 * mask.height() / 600)
            }),
            "the caption fixture did not produce real text evidence"
        );
    }

    #[test]
    fn approved_small_photo_owner_preserves_tone_near_stencil() {
        // Keep the approved owner between the corroborated (0.5%) and legacy
        // significant-picture (1.2%) floors. This is the interval in which an
        // exact rectangular owner used to reach composition with the generic
        // local-whitening policy.
        let mut source = GrayImage::new(2_000, 4_000, 244);
        for line in 0..18 {
            let top = 80 + line * 52;
            for y in top..top + 9 {
                for x in 90..950 {
                    if (x + y) % 10 < 6 {
                        source.set(x, y, 24);
                    }
                }
            }
        }
        for y in 3_000..3_240 {
            for x in 1_500..1_740 {
                source.set(x, y, 154 + ((x * 3 + y * 5) % 19) as u8);
            }
        }
        let mut trusted_background = GrayImage::new(1_000, 2_000, 244);
        for y in 1_500..1_620 {
            for x in 750..870 {
                trusted_background.set(x, y, 32 + ((x * 17 + y * 29) % 181) as u8);
            }
        }
        let options = CleanupOptions {
            dpi: 150.0,
            source_dpi: Some(150.0),
            source_background_dpi: Some(75.0),
            trusted_mrc_source_available: true,
            output_mode: OutputMode::Mixed,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let prepared = prepare_analysis_page(
            &source,
            None,
            &options,
            true,
            PageRenderPolicy::COMPLETE,
            None,
            CalibrationConfig::default(),
            None,
            Some(&trusted_background),
            &mut PageStageTimings::default(),
        );
        let owner = prepared
            .picture_mask
            .as_deref()
            .expect("trusted tone must publish the approved photo owner");
        let owner_fraction = owner.count_black() as f64
            / owner.width().saturating_mul(owner.height()).max(1) as f64;
        assert!(
            (0.005..0.012).contains(&owner_fraction),
            "fixture owner fraction escaped the regression band: {owner_fraction:.6}"
        );
        assert!(
            prepared.preserve_confirmed_photo_tones,
            "approved exact ownership was not propagated to composition"
        );
        let components = ComponentMap::from_binary(owner);
        let component = components
            .components()
            .iter()
            .max_by_key(|component| component.area)
            .expect("approved owner has a component");
        let sample_y = (component.top + component.bottom) / 2;
        let sample_x = component.left + 6;
        let mut plate = GrayImage::new(owner.width(), owner.height(), 255);
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if owner.get(x, y) {
                    plate.set(x, y, 170);
                }
            }
        }
        let mut stencil = BinaryImage::new(owner.width(), owner.height());
        for y in sample_y.saturating_sub(2)..=(sample_y + 2).min(owner.height() - 1) {
            for x in component.left.saturating_sub(5)..component.left {
                stencil.set(x, y, true);
            }
        }
        let (mixed, _, _) = compose_mixed(
            &plate,
            None,
            None,
            &stencil,
            owner,
            None,
            None,
            None,
            None,
            150.0,
            prepared.preserve_confirmed_photo_tones,
            false,
            true,
            true,
        );
        assert_eq!(
            mixed.get(sample_x, sample_y),
            170,
            "approved photo tone was locally whitened beside stencil ink"
        );
    }

    #[test]
    fn line_art_refinement_preserves_map_tone_outside_an_immutable_photo_owner() {
        let mut layout = GrayImage::new(120, 90, 244);
        let mut photo = BinaryImage::new(120, 90);
        for y in 25..65 {
            for x in 78..108 {
                photo.set(x, y, true);
                layout.set(x, y, 150);
            }
        }
        let mut protection = BinaryImage::new(120, 90);
        for y in 15..75 {
            for x in 15..65 {
                protection.set(x, y, true);
                layout.set(x, y, if (x + y) % 7 < 3 { 72 } else { 188 });
            }
        }

        let alpha = picture_and_line_art_preservation_alpha(
            &layout,
            &layout,
            Some(&protection),
            Some(&photo),
            true,
        )
        .expect("line-art refinement must publish an alpha outside the photo owner");
        assert!(
            alpha.get(90, 45) >= 240,
            "the immutable photo owner was weakened by line-art refinement"
        );
        assert!(
            alpha.get(35, 45) > 0,
            "line-art refinement was still unreachable outside a confirmed owner"
        );
        assert_eq!(alpha.get(4, 4), 0, "paper outside semantic geometry was preserved");
    }

    #[test]
    fn trusted_source_foreground_bounds_fresh_mixed_composition() {
        let mut gray = GrayImage::new(160, 100, 232);
        for y in 20..80 {
            for x in 70..135 {
                gray.set(x, y, 48 + ((x * 7 + y * 11) % 150) as u8);
            }
        }
        for y in 42..46 {
            for x in 12..56 {
                gray.set(x, y, 18);
            }
        }
        let mut trusted_foreground = BinaryImage::new(160, 100);
        gray.set(5, 5, 18);
        trusted_foreground.set(5, 5, true);
        let options = CleanupOptions {
            dpi: 300.0,
            source_has_bilevel_layer: true,
            trusted_selection_incomplete: true,
            output_mode: OutputMode::Mixed,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            manual_zones: crate::ManualZones {
                picture: vec![crate::PictureZone {
                    polygon: normalized_box_polygon(0.42, 0.12, 0.86, 0.88),
                    layer: crate::PictureZoneLayer::Painter2,
                }],
                fill: vec![],
            },
            ..CleanupOptions::default()
        };
        let mut timings = PageStageTimings::default();
        let output = clean_page_with_color_and_calibration_config(
            &gray,
            None,
            None,
            Some(&trusted_foreground),
            None,
            &options,
            0,
            CalibrationConfig::default(),
            None,
            None,
            PageRenderPolicy::COMPLETE,
            &mut timings,
        )
        .unwrap()
        .outputs
        .remove(0);
        let layers = output
            .mixed_layers
            .as_ref()
            .expect("fresh Mixed output retains separable layers");

        assert!(output.metadata.trusted_selection_applied);
        assert!(!output.metadata.trusted_mrc_background_preserved);
        assert!(!layers.source_mrc);
        assert_eq!(layers.background.get(5, 5), 255);
        assert!(layers.foreground_mask.count_black() > 1);
        assert!(layers.foreground_mask.get(5, 5));
        assert!(
            layers.foreground_mask.get(30, 43),
            "dark flattened source ink was not preserved"
        );
    }

    #[test]
    fn trusted_mixed_foreground_never_overpaints_picture_ownership() {
        let mut gray = GrayImage::new(24, 3, 255);
        gray.set(4, 1, 72);
        gray.set(12, 1, 18);
        gray.set(18, 1, 18);
        let mut trusted = BinaryImage::new(24, 3);
        trusted.set(12, 1, true);
        trusted.set(4, 1, true);
        let mut picture = BinaryImage::new(24, 3);
        picture.set(4, 1, true);
        let clipped = trusted_mixed_foreground(Some(&trusted), &picture)
            .expect("trusted source selection remains available");

        assert!(clipped.get(12, 1), "trusted text remains foreground-owned");
        assert!(
            !clipped.get(4, 1),
            "trusted picture detail is removed from the stencil candidate"
        );

        for trusted_selection_complete in [false, true] {
            let mut fresh = BinaryImage::new(24, 3);
            fresh.set(18, 1, true);
            let stencil = enforce_source_ink_support(
                fresh,
                &gray,
                Some(&clipped),
                trusted_selection_complete,
                300.0,
            );
            let (_, _, layers) = compose_mixed(
                &gray,
                Some(&gray),
                None,
                &stencil,
                &picture,
                None,
                None,
                None,
                None,
                300.0,
                false,
                false,
                true,
                true,
            );
            let layers = layers.expect("Mixed composition retains separate layers");

            assert!(layers.foreground_mask.get(12, 1));
            assert!(!layers.foreground_mask.get(4, 1));
            assert!(layers.background.get(4, 1) < 255);
            if !trusted_selection_complete {
                assert!(
                    layers.foreground_mask.get(18, 1),
                    "raw-supported fresh text survives an incomplete trusted mask"
                );
            } else {
                assert!(
                    !layers.foreground_mask.get(18, 1),
                    "a complete trusted selection remains the exact foreground authority"
                );
            }
        }
    }

    #[test]
    fn mixed_composition_removes_a_leaked_binary_blob_inside_picture_ownership() {
        let mut gray = GrayImage::new(64, 40, 255);
        let mut picture_mask = BinaryImage::new(64, 40);
        for y in 8..32 {
            for x in 18..46 {
                picture_mask.set(x, y, true);
                gray.set(x, y, 96);
            }
        }
        let mut leaked_binary = BinaryImage::new(64, 40);
        for y in 17..21 {
            for x in 29..34 {
                leaked_binary.set(x, y, true);
            }
        }
        leaked_binary.set(5, 20, true);

        let protection_radius = picture_protection_radius(300.0);
        let protected_picture = dilate(&picture_mask, protection_radius, protection_radius);
        let (mixed, _, layers) = compose_mixed(
            &gray,
            None,
            None,
            &leaked_binary,
            &picture_mask,
            None,
            None,
            None,
            None,
            300.0,
            false,
            false,
            true,
            true,
        );
        let layers = layers.expect("Mixed composition retains separate layers");

        assert_eq!(
            layers.foreground_mask.and(&protected_picture).count_black(),
            0,
            "the leaked binary blob must not own protected picture pixels"
        );
        assert!(
            layers.foreground_mask.get(5, 20),
            "ordinary foreground outside the picture remains owned by the stencil"
        );
        assert!(
            (0..150).contains(&mixed.get(31, 19)),
            "picture tone was replaced by a binary knockout: {}",
            mixed.get(31, 19)
        );

        let (_, _, soft_layers) = compose_mixed(
            &gray,
            None,
            None,
            &leaked_binary,
            &picture_mask,
            None,
            None,
            None,
            None,
            300.0,
            false,
            true,
            true,
            true,
        );
        let soft_layers = soft_layers.expect("soft Mixed composition retains separate layers");
        assert_eq!(
            soft_layers
                .foreground_mask
                .and(&protected_picture)
                .count_black(),
            0,
            "soft-alpha Mixed must share the binary/picture ownership boundary"
        );
    }

    #[test]
    fn trusted_source_foreground_blocks_pale_scanner_band_binarization() {
        let mut gray = GrayImage::new(160, 100, 245);
        for y in 0..100 {
            for x in 0..24 {
                gray.set(x, y, 150);
            }
        }
        let mut trusted_foreground = BinaryImage::new(160, 100);
        for y in 40..60 {
            for x in 80..84 {
                gray.set(x, y, 18);
                trusted_foreground.set(x, y, true);
            }
        }
        let options = CleanupOptions {
            dpi: 300.0,
            source_has_bilevel_layer: true,
            output_mode: OutputMode::Bw,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let mut timings = PageStageTimings::default();
        let output = clean_page_with_color_and_calibration_config(
            &gray,
            None,
            None,
            Some(&trusted_foreground),
            None,
            &options,
            0,
            CalibrationConfig::default(),
            None,
            None,
            PageRenderPolicy::COMPLETE,
            &mut timings,
        )
        .unwrap()
        .outputs
        .remove(0);
        let CleanupRaster::Bilevel(binary) = &output.image else {
            panic!("trusted BW source must stay bilevel");
        };

        assert!(output.metadata.trusted_selection_applied);
        assert!((0..100).all(|y| (0..24).all(|x| !binary.get(x, y))));
        assert!((40..60).all(|y| (80..84).all(|x| binary.get(x, y))));
        assert_eq!(
            (
                timings.threshold_preparation_ms,
                timings.thresholding_ms,
                timings.binary_postprocess_ms,
                timings.binarization_ms,
            ),
            (0.0, 0.0, 0.0, 0.0),
        );
    }

    #[test]
    fn mixed_preview_builds_only_the_composite() {
        let mut gray = GrayImage::new(120, 80, 242);
        for y in 15..65 {
            for x in 60..105 {
                gray.set(x, y, 72 + ((x + y) % 100) as u8);
            }
        }
        for y in 30..34 {
            for x in 12..48 {
                gray.set(x, y, 28);
            }
        }
        let options = CleanupOptions {
            dpi: 300.0,
            output_mode: OutputMode::Mixed,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            manual_zones: crate::ManualZones {
                picture: vec![crate::PictureZone {
                    polygon: normalized_box_polygon(0.5, 0.1, 0.9, 0.9),
                    layer: crate::PictureZoneLayer::Painter2,
                }],
                fill: vec![],
            },
            ..CleanupOptions::default()
        };
        let mut timings = PageStageTimings::default();
        let output = clean_page_with_color_and_calibration_config(
            &gray,
            None,
            None,
            None,
            None,
            &options,
            0,
            CalibrationConfig::default(),
            None,
            None,
            PageRenderPolicy {
                create_mixed_layers: false,
                create_mixed_composite: true,
                recommend_output_mode: true,
                analyze_layout: true,
            },
            &mut timings,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert!(output.mixed_layers.is_none());
        let composite = output.image.to_gray();
        assert!(
            composite.data().contains(&0)
                && composite
                    .data()
                    .iter()
                    .any(|&value| !matches!(value, 0 | 255)),
            "preview keeps the mixed composite without retaining layer buffers"
        );
    }

    #[test]
    fn metadata_records_a_guardrail_limited_bw_supersample() {
        let source = GrayImage::new(120, 90, 255);
        let output = clean_page(
            &source,
            &CleanupOptions {
                dpi: 875.0,
                source_dpi: Some(600.0),
                requested_render_dpi: Some(1_200.0),
                output_mode: OutputMode::Bw,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);

        assert_eq!(output.metadata.source_dpi, 600.0);
        assert_eq!(output.metadata.render_dpi, 875.0);
        assert_eq!(output.metadata.requested_render_dpi, 1_200.0);
        assert!(output.metadata.raster_scale_limited);
        assert_eq!(
            output.metadata.warning_events,
            vec![CleanupWarningEvent::RenderDpiLimited {
                applied_dpi_thousandths: 875_000,
                requested_dpi_thousandths: 1_200_000,
            }]
        );
    }

    /// The fixed-point units the formatter renders have to spell the number
    /// this sidecar used to print itself, including at an exact half, where
    /// Rust's `{:.N}` and JavaScript's `toFixed` disagree. `{:.N}` appears
    /// nowhere but here: it is the reference the quantizer is checked against.
    #[test]
    fn quantized_decimals_spell_the_text_the_sidecar_used_to_print() {
        fn rendered(units: i64, decimals: u32) -> String {
            let scale = 10i64.pow(decimals);
            format!(
                "{}.{:0width$}",
                units / scale,
                units % scale,
                width = decimals as usize
            )
        }

        for value in [
            // Exact halves at one decimal — only `m/4` with odd `m` can be one.
            0.25, 0.75, 12.25, 49.75, 99.25, 0.05, 33.35, 66.65, 50.0, 12.3, 99.9999,
        ] {
            assert_eq!(
                rendered(quantize_decimal(value, 1), 1),
                format!("{value:.1}"),
                "one decimal of {value}"
            );
        }
        for value in [
            // Exact halves at three decimals — only `m/16` with odd `m`.
            0.0625, 875.0625, 288.4375, 0.1875, 1199.9375, 875.0, 1_200.0, 288.5, 0.0005,
            600.123_456,
        ] {
            assert_eq!(
                rendered(quantize_decimal(value, 3), 3),
                format!("{value:.3}"),
                "three decimals of {value}"
            );
        }
        // The tie the two languages resolve in opposite directions: `{:.3}`
        // keeps the even digit, `toFixed` would round away from zero.
        assert_eq!(quantize_decimal(875.0625, 3), 875_062);
        assert_eq!(quantize_decimal(12.25, 1), 122);
        assert_eq!(quantize_decimal(0.0, 3), 0);
        assert_eq!(quantize_decimal(f64::NAN, 3), 0);
        assert_eq!(quantize_decimal(f64::INFINITY, 1), 0);
        assert_eq!(quantize_decimal(f64::MIN_POSITIVE, 3), 0);
        // A negative measurement quantizes by magnitude and carries the sign,
        // so its ties fall on the same even digit rather than away from zero.
        assert_eq!(quantize_decimal(-12.25, 1), -122);
        assert_eq!(quantize_decimal(-875.0625, 3), -875_062);
        assert_eq!(quantize_decimal(-12.3, 1), -123);
        assert_eq!(quantize_decimal(-600.123_456, 3), -600_123);
        assert_eq!(quantize_decimal(-0.0, 3), 0);
        assert_eq!(quantize_decimal(f64::NEG_INFINITY, 1), 0);
    }

    #[test]
    fn render_crop_samples_only_the_true_dpi_region_after_every_geometry_stage() {
        let source = rotated_text_page(3.0);
        for rotation in [
            OrthogonalRotation::None,
            OrthogonalRotation::Clockwise90,
            OrthogonalRotation::Clockwise180,
            OrthogonalRotation::Clockwise270,
        ] {
            let (rotated_width, rotated_height) = match rotation {
                OrthogonalRotation::None | OrthogonalRotation::Clockwise180 => {
                    (source.width(), source.height())
                }
                OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270 => {
                    (source.height(), source.width())
                }
            };
            let crop = crate::NormalizedRect {
                x: 0.2,
                y: 0.15,
                width: 0.45,
                height: 0.4,
                rotation,
            };
            let base = CleanupOptions {
                dpi: 1_200.0,
                source_dpi: Some(600.0),
                requested_render_dpi: Some(1_200.0),
                output_mode: OutputMode::Grayscale,
                normalize_illumination: false,
                crop_content: true,
                margins_mm: None,
                margins_pixels: Some([7.0, 9.0, 11.0, 13.0]),
                layout: crate::LayoutMode::Single,
                manual_skew_degrees: Some(2.0),
                dewarp: Some(crate::DewarpOptions {
                    top_curve: vec![
                        Point::new(0.0, 0.0),
                        Point::new(rotated_width as f64 / 2.0, 8.0),
                        Point::new(rotated_width as f64, 0.0),
                    ],
                    bottom_curve: vec![
                        Point::new(0.0, rotated_height as f64),
                        Point::new(rotated_width as f64 / 2.0, rotated_height as f64 - 8.0),
                        Point::new(rotated_width as f64, rotated_height as f64),
                    ],
                    depth: 0.08,
                }),
                rotation,
                match_page_size: false,
                ..CleanupOptions::default()
            };
            let full = clean_page(&source, &base, 0).unwrap().outputs.remove(0);
            let tile = clean_page(
                &source,
                &CleanupOptions {
                    render_crop: Some(crop),
                    ..base
                },
                0,
            )
            .unwrap()
            .outputs
            .remove(0);
            let region = tile.metadata.render_region.unwrap();

            assert_eq!(tile.metadata.output_width, full.metadata.output_width);
            assert_eq!(tile.metadata.output_height, full.metadata.output_height);
            assert_eq!(tile.metadata.crop_rect, full.metadata.crop_rect);
            assert_eq!(tile.metadata.render_dpi, 1_200.0);
            assert_eq!(tile.metadata.requested_render_dpi, 1_200.0);
            assert!(!tile.metadata.raster_scale_limited);
            assert_eq!(tile.image.width(), region.width as usize);
            assert_eq!(tile.image.height(), region.height as usize);
            assert!(tile.image.width() * tile.image.height() <= 4_000_000);
            let serialized_metadata = serde_json::to_value(&tile.metadata).unwrap();
            assert_eq!(
                serialized_metadata["renderRegion"]["xPx"],
                serde_json::json!(region.x),
            );
            assert!(serialized_metadata.get("render_region").is_none());

            for y in 0..tile.image.height() {
                for x in 0..tile.image.width() {
                    assert_eq!(
                        tile.image.get(x, y),
                        full.image.get(region.x as usize + x, region.y as usize + y),
                        "rotation={rotation:?}, x={x}, y={y}",
                    );
                }
            }
            let tile_grid = tile.metadata.dewarp_mapping.unwrap();
            assert_eq!(
                tile_grid.output_origin,
                Point::new(
                    full.metadata.crop_rect.x + region.x,
                    full.metadata.crop_rect.y + region.y,
                ),
            );
            assert_eq!(
                (tile_grid.output_width, tile_grid.output_height),
                (tile.image.width(), tile.image.height()),
            );
        }

        let crop = crate::NormalizedRect {
            x: 0.2,
            y: 0.15,
            width: 0.45,
            height: 0.4,
            rotation: OrthogonalRotation::None,
        };
        let bw_options = CleanupOptions {
            dpi: 600.0,
            source_dpi: Some(300.0),
            requested_render_dpi: Some(600.0),
            output_mode: OutputMode::Bw,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let full_bw = clean_page(&source, &bw_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let tile_bw = clean_page(
            &source,
            &CleanupOptions {
                render_crop: Some(crop),
                ..bw_options.clone()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let region = tile_bw.metadata.render_region.unwrap();
        for y in 0..tile_bw.image.height() {
            for x in 0..tile_bw.image.width() {
                assert_eq!(
                    tile_bw.image.get(x, y),
                    full_bw
                        .image
                        .get(region.x as usize + x, region.y as usize + y),
                    "BW processing apron must make crop and full-page interiors identical",
                );
            }
        }

        let affine_options = CleanupOptions {
            output_mode: OutputMode::Grayscale,
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let full_affine = clean_page(&source, &affine_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let tile_affine = clean_page(
            &source,
            &CleanupOptions {
                render_crop: Some(crop),
                ..affine_options
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let tile_forward = tile_affine.metadata.forward_transform.unwrap();
        let full_forward = full_affine.metadata.forward_transform.unwrap();
        for row in 0..3 {
            for column in 0..3 {
                assert!(
                    (tile_forward.matrix[row][column] - full_forward.matrix[row][column]).abs()
                        < 1e-9,
                    "crop metadata keeps the canonical intrinsic-output affine",
                );
            }
        }

        let blank = GrayImage::new(800, 1_000, 255);
        let blank_crop = clean_page(
            &blank,
            &CleanupOptions {
                render_crop: Some(crop),
                skip_blank_pages: true,
                normalize_illumination: false,
                crop_content: false,
                layout: crate::LayoutMode::Single,
                ..CleanupOptions::default()
            },
            0,
        )
        .unwrap();
        assert_eq!(blank_crop.outputs.len(), 1);
        assert_eq!(blank_crop.blank_outputs_skipped, 0);
    }

    #[test]
    fn detail_source_crop_replays_base_geometry_without_rendering_the_full_raster() {
        let mut base_source = GrayImage::new(120, 90, 245);
        for y in 0..base_source.height() {
            for x in 0..base_source.width() {
                base_source.set(x, y, ((x * 5 + y * 3) % 220 + 20) as u8);
            }
        }
        let mut detail_source = GrayImage::new(240, 180, 255);
        for y in 0..detail_source.height() {
            for x in 0..detail_source.width() {
                detail_source.set(x, y, base_source.get(x / 2, y / 2));
            }
        }
        let base_options = CleanupOptions {
            dpi: 150.0,
            source_dpi: Some(150.0),
            requested_render_dpi: Some(150.0),
            output_mode: OutputMode::Grayscale,
            normalize_illumination: true,
            manual_skew_degrees: Some(2.0),
            crop_content: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let base = clean_page(&base_source, &base_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let base_cleaned = base.image.to_gray().into_owned();
        let base_metadata = base.metadata;
        let detail_options = CleanupOptions {
            dpi: 300.0,
            source_dpi: Some(150.0),
            requested_render_dpi: Some(300.0),
            ..base_options.clone()
        };
        let source_crop = Rect::new(46.0, 24.0, 148.0, 120.0);
        let cropped_source = crop_gray(&detail_source, source_crop);
        let render_region = Rect::new(60.0, 40.0, 100.0, 70.0);
        let sampled_region = Rect::new(46.0, 24.0, 148.0, 120.0);
        let detail_plan = DetailRenderPlan {
            base_metadata_path: std::path::PathBuf::from("unused-in-engine-test.json"),
            base_raster_path: std::path::PathBuf::from("unused-in-engine-test.png"),
            base_cleaned_raster_path: None,
            source_crop: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: source_crop.x,
                y_px: source_crop.y,
                width_px: source_crop.width,
                height_px: source_crop.height,
            },
            full_source_width_px: detail_source.width(),
            full_source_height_px: detail_source.height(),
            scale: 2.0,
            render_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: render_region.x,
                y_px: render_region.y,
                width_px: render_region.width,
                height_px: render_region.height,
            },
            sampled_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: sampled_region.x,
                y_px: sampled_region.y,
                width_px: sampled_region.width,
                height_px: sampled_region.height,
            },
        };
        let detail = clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &cropped_source,
                color_source_crop: None,
                base_source: &base_source,
                base_color_source: None,
                base_cleaned: Some((&base_cleaned, None)),
            },
            &detail_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .unwrap()
        .outputs
        .remove(0);
        let full = clean_page(&detail_source, &detail_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let expected = crop_gray(&full.image.to_gray(), render_region);
        let detail_image = detail.image.to_gray();
        let mean_error = detail_image
            .data()
            .iter()
            .zip(expected.data())
            .map(|(&actual, &expected)| f64::from(actual.abs_diff(expected)))
            .sum::<f64>()
            / detail_image.data().len() as f64;
        assert!(
            mean_error <= 2.0,
            "detail source crop must preserve normalized non-identity geometry, mean error={mean_error:.3}",
        );
        assert_eq!(detail.metadata.render_region, Some(render_region));
        assert_eq!(detail.metadata.input_width, detail_source.width());
        assert_eq!(detail.metadata.input_height, detail_source.height());
        assert_eq!(detail.metadata.output_width, full.metadata.output_width);
        assert_eq!(detail.metadata.output_height, full.metadata.output_height);

        let manual_zone_options = CleanupOptions {
            manual_zones: crate::ManualZones {
                picture: vec![crate::PictureZone {
                    polygon: normalized_box_polygon(0.25, 0.25, 0.75, 0.75),
                    layer: crate::PictureZoneLayer::Painter2,
                }],
                fill: vec![],
            },
            ..detail_options.clone()
        };
        assert!(clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &cropped_source,
                color_source_crop: None,
                base_source: &base_source,
                base_color_source: None,
                base_cleaned: None,
            },
            &manual_zone_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .err()
        .expect("detail rendering with manual zones must fail closed")
        .contains("manual zones requires the full-page source"));
        let mixed_options = CleanupOptions {
            output_mode: OutputMode::Mixed,
            ..detail_options.clone()
        };
        assert!(clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &cropped_source,
                color_source_crop: None,
                base_source: &base_source,
                base_color_source: None,
                base_cleaned: None,
            },
            &mixed_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .err()
        .expect("mixed detail must fail closed")
        .contains("full-page picture mask"));
        let auto_options = CleanupOptions {
            output_mode: OutputMode::Auto,
            ..detail_options
        };
        assert!(clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &cropped_source,
                color_source_crop: None,
                base_source: &base_source,
                base_color_source: None,
                base_cleaned: None,
            },
            &auto_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .err()
        .expect("an unresolved output mode must fail closed rather than be chosen per tile")
        .contains("resolved from the full page"));
    }

    #[test]
    fn grayscale_detail_applies_pinned_text_tone_exactly_once() {
        let mut source = GrayImage::new(120, 90, 255);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(x, y, (115 + (x * 75 / source.width()) + (y % 9)) as u8);
            }
        }
        for y in 18..72 {
            for x in (12..108).step_by(13) {
                source.set(x, y, 96);
            }
        }
        let diagnostics = TextToneDiagnostics {
            applied: true,
            rule: crate::text_tone::TextToneRule::Applied,
            text_line_count: 12,
            text_ink_pixels: 2_000,
            picture_fraction: 0.0,
            outside_midtone_fraction: 0.0,
            outside_midtone_largest_component_fraction: 0.0,
            outside_midtone_largest_component_width_fraction: 0.0,
            outside_midtone_largest_component_height_fraction: 0.0,
            ink_anchor: Some(133),
            black_point: Some(96.052_631_578_947_37),
            slope: Some(1.623_931_623_931_624),
        };
        let base_options = CleanupOptions {
            dpi: 150.0,
            source_dpi: Some(150.0),
            requested_render_dpi: Some(150.0),
            output_mode: OutputMode::Grayscale,
            normalize_illumination: false,
            crop_content: false,
            match_page_size: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            manual_skew_degrees: Some(0.0),
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let mut base_metadata = clean_page(&source, &base_options, 0)
            .unwrap()
            .outputs
            .remove(0)
            .metadata;
        base_metadata.text_tone_diagnostics = Some(diagnostics);
        let detail_options = CleanupOptions {
            resolved_text_tone_diagnostics: crate::domain::options::ResolvedTextToneDiagnostics {
                full: Some(diagnostics),
                ..Default::default()
            },
            ..base_options.clone()
        };
        let full_rect = Rect::new(0.0, 0.0, source.width() as f64, source.height() as f64);
        let detail_plan = DetailRenderPlan {
            base_metadata_path: std::path::PathBuf::from("unused-in-engine-test.json"),
            base_raster_path: std::path::PathBuf::from("unused-in-engine-test.png"),
            base_cleaned_raster_path: None,
            source_crop: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: full_rect.x,
                y_px: full_rect.y,
                width_px: full_rect.width,
                height_px: full_rect.height,
            },
            full_source_width_px: source.width(),
            full_source_height_px: source.height(),
            scale: 1.0,
            render_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: full_rect.x,
                y_px: full_rect.y,
                width_px: full_rect.width,
                height_px: full_rect.height,
            },
            sampled_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: full_rect.x,
                y_px: full_rect.y,
                width_px: full_rect.width,
                height_px: full_rect.height,
            },
        };
        let mut expected = clean_page(&source, &base_options, 0)
            .unwrap()
            .outputs
            .remove(0)
            .image
            .to_gray()
            .into_owned();
        apply_text_tone(&mut expected, diagnostics);
        let detail = clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &source,
                color_source_crop: None,
                base_source: &source,
                base_color_source: None,
                base_cleaned: Some((&expected, None)),
            },
            &detail_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .unwrap()
        .outputs
        .remove(0);
        assert_eq!(detail.image.to_gray().as_ref(), &expected);
        assert_eq!(detail.metadata.text_tone_diagnostics, Some(diagnostics));
    }

    #[test]
    fn detail_tile_policy_skips_layout_analysis_and_keeps_calibration() {
        let source = illustrated_text_page();
        let options = CleanupOptions {
            dpi: 300.0,
            output_mode: OutputMode::Bw,
            normalize_illumination: false,
            crop_content: false,
            match_page_size: false,
            margins_mm: None,
            manual_skew_degrees: Some(0.0),
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let prepare = |policy| {
            let mut timings = PageStageTimings::default();
            let prepared = prepare_analysis_page(
                &source,
                None,
                &options,
                true,
                policy,
                None,
                CalibrationConfig::default(),
                None,
                None,
                &mut timings,
            );
            (prepared, timings)
        };
        let (complete, _) = prepare(PageRenderPolicy::COMPLETE);
        let (tile, _) = prepare(PageRenderPolicy::DETAIL_TILE);

        assert!(
            complete
                .picture_mask
                .as_deref()
                .expect("the complete policy detects a picture mask")
                .count_black()
                > 0,
            "the fixture must exercise the layout stack the tile policy skips",
        );
        assert!(
            complete.content_picture_mask.is_none(),
            "content-mask extension is unnecessary when content cropping is disabled",
        );
        assert!(complete.text_axis.is_some());

        assert!(tile.picture_mask.is_none());
        assert!(tile.content_picture_mask.is_none());
        assert!(tile.text_axis.is_none());
        assert!(tile.output_mode_recommendation.is_none());
        assert_eq!(
            tile.split.classification,
            LayoutClassification::SingleUncutPage
        );
        assert_eq!(tile.split.cutter_x, None);
        assert_eq!(tile.split.pages.len(), 1);

        // Calibration and the raster the tile binarizes are exactly what the
        // complete policy produced; only the discarded layout work is gone.
        assert_eq!(tile.normalized.data(), complete.normalized.data());
        assert_eq!(tile.full_width, complete.full_width);
        assert_eq!(tile.full_height, complete.full_height);
        assert_eq!(
            tile.calibration.stroke_width_px,
            complete.calibration.stroke_width_px
        );
        assert_eq!(
            tile.calibration.x_height_px,
            complete.calibration.x_height_px
        );
        assert_eq!(tile.calibration.valid, complete.calibration.valid);
        // The skipped work is pinned above by what the tile policy does not
        // produce: no picture mask, no text axis, no mode recommendation, an
        // uncut split. A wall-clock comparison of the two runs added nothing to
        // that and made the outcome depend on machine load, so it failed under
        // a parallel test run or a busy CI host while the behaviour was
        // correct. Stage timers cannot replace it either: they bracket the
        // skip check itself, so they stay non-zero when the work is skipped.
    }

    #[test]
    fn bw_detail_tile_reproduces_the_full_page_render_it_replaces() {
        let base_source = illustrated_text_page();
        let mut detail_source =
            GrayImage::new(base_source.width() * 2, base_source.height() * 2, 255);
        for y in 0..detail_source.height() {
            for x in 0..detail_source.width() {
                detail_source.set(x, y, base_source.get(x / 2, y / 2));
            }
        }
        let base_options = CleanupOptions {
            dpi: 150.0,
            source_dpi: Some(150.0),
            requested_render_dpi: Some(150.0),
            output_mode: OutputMode::Bw,
            normalize_illumination: false,
            crop_content: false,
            match_page_size: false,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            manual_skew_degrees: Some(0.0),
            layout: crate::LayoutMode::Single,
            ..CleanupOptions::default()
        };
        let base_metadata = clean_page(&base_source, &base_options, 0)
            .unwrap()
            .outputs
            .remove(0)
            .metadata;
        let detail_options = CleanupOptions {
            dpi: 300.0,
            requested_render_dpi: Some(300.0),
            ..base_options
        };
        // The apron the preview service samples around the visible viewport.
        let sampled_region = Rect::new(24.0, 40.0, 220.0, 200.0);
        let render_region = Rect::new(80.0, 96.0, 108.0, 88.0);
        let detail_plan = DetailRenderPlan {
            base_metadata_path: std::path::PathBuf::from("unused-in-engine-test.json"),
            base_raster_path: std::path::PathBuf::from("unused-in-engine-test.png"),
            base_cleaned_raster_path: None,
            source_crop: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: sampled_region.x,
                y_px: sampled_region.y,
                width_px: sampled_region.width,
                height_px: sampled_region.height,
            },
            full_source_width_px: detail_source.width(),
            full_source_height_px: detail_source.height(),
            scale: 2.0,
            render_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: render_region.x,
                y_px: render_region.y,
                width_px: render_region.width,
                height_px: render_region.height,
            },
            sampled_region: crate::protocol::manifest_v3::DetailPixelRect {
                x_px: sampled_region.x,
                y_px: sampled_region.y,
                width_px: sampled_region.width,
                height_px: sampled_region.height,
            },
        };
        let detail = clean_detail_page_with_color(
            DetailRenderSources {
                source_crop: &crop_gray(&detail_source, sampled_region),
                color_source_crop: None,
                base_source: &base_source,
                base_color_source: None,
                base_cleaned: None,
            },
            &detail_options,
            0,
            &detail_plan,
            &base_metadata,
            &mut PageStageTimings::default(),
        )
        .unwrap()
        .outputs
        .remove(0);
        let full = clean_page(&detail_source, &detail_options, 0)
            .unwrap()
            .outputs
            .remove(0);
        let expected = crop_gray(&full.image.to_gray(), render_region);
        assert_eq!(detail.image.width(), expected.width());
        assert_eq!(detail.image.height(), expected.height());
        assert!(
            expected.data().contains(&0) && expected.data().contains(&255),
            "the compared region must carry both ink and paper",
        );
        let detail_image = detail.image.to_gray();
        let mismatched = detail_image
            .data()
            .iter()
            .zip(expected.data())
            .filter(|(actual, expected)| actual != expected)
            .count();
        let mismatch_ratio = mismatched as f64 / expected.data().len() as f64;
        // A photo elsewhere on the page shifts full-page calibration and
        // routing context that the sampled crop cannot carry, so glyph-edge
        // pixels may differ slightly; structural identity (dimensions, ink
        // and paper presence) stays exact. S17's fresh composition revisits
        // detail parity wholesale.
        assert!(
            mismatch_ratio < 0.02,
            "a binarized detail tile must reproduce the full-page render, mismatch={mismatch_ratio:.4}",
        );
    }

    fn illustrated_text_page() -> GrayImage {
        let mut source = GrayImage::new(420, 560, 248);
        for y in 0..source.height() {
            for x in 0..source.width() {
                let shade = 248 - (x * 6 / source.width()) - (y * 4 / source.height());
                source.set(x, y, shade as u8);
            }
        }
        for line in 0..14 {
            let top = 40 + line * 18;
            for y in top..top + 8 {
                for x in 40..380 {
                    if (x / 34 + line) % 5 != 4 && (x * 5 + y * 3) % 7 > 1 {
                        source.set(x, y, 28);
                    }
                }
            }
        }
        for y in 330..520 {
            for x in 70..350 {
                // Shadow masses beside midtone fields — what a printed
                // photograph looks like to the halftone classifier.
                let cell = (x / 48 + y / 48) % 2 == 0;
                let value = if cell {
                    30 + ((x * 37 + y * 61) % 24) as u8
                } else {
                    120 + ((x * 13 + y * 41) % 48) as u8
                };
                source.set(x, y, value);
            }
        }
        source
    }

    fn gradient_page(width: usize, height: usize) -> GrayImage {
        let mut page = GrayImage::new(width, height, 255);
        for y in 0..height {
            for x in 0..width {
                page.set(x, y, ((x * 7 + y * 13) % 251) as u8);
            }
        }
        page
    }

    fn rotate_gray_reference(source: &GrayImage, rotation: OrthogonalRotation) -> GrayImage {
        let (width, height) = (source.width(), source.height());
        let (output_width, output_height) = match rotation {
            OrthogonalRotation::None | OrthogonalRotation::Clockwise180 => (width, height),
            OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270 => (height, width),
        };
        let mut output = GrayImage::new(output_width, output_height, 255);
        for y in 0..height {
            for x in 0..width {
                let (target_x, target_y) = match rotation {
                    OrthogonalRotation::None => (x, y),
                    OrthogonalRotation::Clockwise90 => (height - 1 - y, x),
                    OrthogonalRotation::Clockwise180 => (width - 1 - x, height - 1 - y),
                    OrthogonalRotation::Clockwise270 => (y, width - 1 - x),
                };
                output.set(target_x, target_y, source.get(x, y));
            }
        }
        output
    }

    #[test]
    fn orthogonal_rotation_places_every_pixel_where_the_quarter_turn_says() {
        let gray = gradient_page(37, 23);
        let mut color = RgbImage::new(37, 23, [0; 3]);
        for y in 0..color.height() {
            for x in 0..color.width() {
                let value = gray.get(x, y);
                color.set(x, y, [value, value.wrapping_add(61), value.wrapping_mul(3)]);
            }
        }

        for rotation in [
            OrthogonalRotation::None,
            OrthogonalRotation::Clockwise90,
            OrthogonalRotation::Clockwise180,
            OrthogonalRotation::Clockwise270,
        ] {
            let rotated_gray = rotate_orthogonal(&gray, rotation);
            assert_eq!(
                rotated_gray,
                rotate_gray_reference(&gray, rotation),
                "gray rotation {rotation:?}"
            );

            let rotated_color = rotate_rgb_orthogonal(&color, rotation);
            assert_eq!(
                (rotated_color.width(), rotated_color.height()),
                (rotated_gray.width(), rotated_gray.height()),
                "colour rotation {rotation:?} geometry"
            );
            for y in 0..rotated_color.height() {
                for x in 0..rotated_color.width() {
                    let value = rotated_gray.get(x, y);
                    assert_eq!(
                        rotated_color.get(x, y),
                        [value, value.wrapping_add(61), value.wrapping_mul(3)],
                        "colour rotation {rotation:?} at {x},{y}"
                    );
                }
            }
        }
    }

    #[test]
    fn crop_gray_keeps_the_requested_geometry_and_pads_past_the_source_edge() {
        let page = gradient_page(40, 30);

        let inside = crop_gray(&page, Rect::new(6.0, 4.0, 12.0, 9.0));
        assert_eq!((inside.width(), inside.height()), (12, 9));
        for y in 0..inside.height() {
            for x in 0..inside.width() {
                assert_eq!(inside.get(x, y), page.get(6 + x, 4 + y), "at {x},{y}");
            }
        }

        // clean_region derives its working geometry from the region alone, so a
        // region that runs past the source must still report the requested size
        // and pad the overhang with white.
        let overhanging = Rect::new(34.0, 26.0, 12.0, 9.0);
        let past_edge = crop_gray(&page, overhanging);
        assert_eq!(
            (past_edge.width(), past_edge.height()),
            (
                overhanging.width.round().max(1.0) as usize,
                overhanging.height.round().max(1.0) as usize
            )
        );
        assert_eq!(past_edge.get(0, 0), page.get(34, 26));
        assert_eq!(past_edge.get(11, 8), 255);
    }

    #[test]
    fn preparing_an_unrotated_page_borrows_the_source_instead_of_copying_it() {
        let source = gradient_page(320, 240);
        let options = CleanupOptions {
            dpi: 300.0,
            output_mode: OutputMode::Grayscale,
            ..CleanupOptions::default()
        };

        let prepared = prepare_page(
            &source,
            None,
            None,
            None,
            None,
            &options,
            CalibrationConfig::default(),
            None,
            None,
            PageRenderPolicy {
                create_mixed_layers: false,
                create_mixed_composite: true,
                recommend_output_mode: false,
                analyze_layout: true,
            },
            &mut PageStageTimings::default(),
        );

        match prepared.rotated_source {
            Some(Cow::Borrowed(borrowed)) => assert!(
                std::ptr::eq(borrowed, &source),
                "an unrotated page must borrow the caller's buffer"
            ),
            _ => panic!("an unrotated page must not allocate a rotated copy"),
        }
    }

    #[test]
    fn a_page_prepared_without_illumination_normalization_keeps_one_full_size_buffer() {
        let source = gradient_page(320, 240);
        for rotation in [OrthogonalRotation::None, OrthogonalRotation::Clockwise90] {
            let options = CleanupOptions {
                dpi: 300.0,
                output_mode: OutputMode::Grayscale,
                normalize_illumination: false,
                rotation,
                ..CleanupOptions::default()
            };

            let prepared = prepare_page(
                &source,
                None,
                None,
                None,
                None,
                &options,
                CalibrationConfig::default(),
                None,
                None,
                PageRenderPolicy {
                    create_mixed_layers: false,
                    create_mixed_composite: true,
                    recommend_output_mode: false,
                    analyze_layout: true,
                },
                &mut PageStageTimings::default(),
            );

            assert!(
                prepared.rotated_source.is_none(),
                "rotation {rotation:?}: the rotated page and the normalized page must be one buffer"
            );
            assert_eq!(
                *prepared.normalized,
                rotate_gray_reference(&source, rotation),
                "rotation {rotation:?}: the shared buffer must hold the rotated page"
            );
        }
    }

    #[test]
    fn colour_pages_publish_rgb_without_rendering_the_gray_twin_nobody_writes() {
        let mut gray = GrayImage::new(220, 160, 238);
        let mut color = RgbImage::new(220, 160, [238, 232, 224]);
        for y in 40..96 {
            for x in 36..184 {
                gray.set(x, y, 74);
                color.set(x, y, [196, 48, 52]);
            }
        }
        let base = CleanupOptions {
            dpi: 300.0,
            manual_skew_degrees: Some(1.6),
            normalize_illumination: false,
            crop_content: false,
            layout: crate::LayoutMode::Single,
            match_page_size: false,
            ..CleanupOptions::default()
        };
        let colored = clean_page_with_color(
            &gray,
            Some(&color),
            &CleanupOptions {
                output_mode: OutputMode::Color,
                ..base.clone()
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0);
        let published = colored
            .color_image
            .as_ref()
            .expect("a colour page publishes an RGB raster");
        assert!(
            published.data().iter().any(|&value| value < 160),
            "the published colour raster must carry the page"
        );
        let twin = colored.image.into_gray();
        assert_eq!(
            (twin.width(), twin.height()),
            (published.width(), published.height())
        );
        assert!(
            twin.data().iter().all(|&value| value == 255),
            "a colour page must not pay for a full-resolution gray render nobody encodes"
        );

        let grayscale = clean_page(
            &gray,
            &CleanupOptions {
                output_mode: OutputMode::Grayscale,
                ..base
            },
            0,
        )
        .unwrap()
        .outputs
        .remove(0)
        .image
        .into_gray();
        assert_eq!(
            (grayscale.width(), grayscale.height()),
            (twin.width(), twin.height())
        );
        assert!(
            grayscale.data().iter().any(|&value| value < 160),
            "the same page in grayscale mode still resamples its ink at full resolution"
        );
    }

    #[test]
    fn a_rotated_resample_keeps_the_per_sample_transform_result_on_every_pixel() {
        let (source, _) = thin_stroke_fixture();
        let width = source.width();
        let height = source.height();
        let cx = width as f64 * 0.5;
        let cy = height as f64 * 0.5;
        let inverse = Affine::translation(-cx, -cy)
            .then(Affine::rotation_radians(1.4_f64.to_radians()))
            .then(Affine::translation(cx, cy));
        let offsets = adaptive_sample_offsets(inverse);
        assert_eq!(
            offsets.len(),
            4,
            "a rotation mixes the axes, so it must still supersample 2x2"
        );

        let matrix = inverse.matrix;
        let row = height / 2;
        let starts = offsets
            .iter()
            .map(|&(offset_x, offset_y)| {
                let source_y = row as f64 + offset_y;
                (
                    matrix[0][0] * offset_x + matrix[0][1] * source_y + matrix[0][2],
                    matrix[1][0] * offset_x + matrix[1][1] * source_y + matrix[1][2],
                )
            })
            .collect::<Vec<_>>();
        let (interior_start, interior_end) = interior_column_span(
            &starts,
            matrix[0][0],
            matrix[1][0],
            width,
            source.width(),
            source.height(),
        );
        assert!(
            interior_end.saturating_sub(interior_start) * 10 >= width * 9,
            "the unchecked interior must carry the row, not a sliver: {interior_start}..{interior_end} of {width}"
        );
        assert!(
            interior_start > 0 && interior_end < width,
            "a rotated row must keep bounds-checked borders: {interior_start}..{interior_end} of {width}"
        );

        let color = {
            let mut image = RgbImage::new(width, height, [255; 3]);
            for y in 0..height {
                for x in 0..width {
                    let value = source.get(x, y);
                    image.set(
                        x,
                        y,
                        [value, value.saturating_sub(9), value.saturating_add(6)],
                    );
                }
            }
            image
        };
        let gray_actual = render_affine_gray(&source, width, height, inverse);
        let color_actual = render_affine_rgb(&color, width, height, inverse);

        let mut off_by_one = 0usize;
        for y in 0..height {
            for x in 0..width {
                let mapped = offsets
                    .iter()
                    .map(|&(offset_x, offset_y)| {
                        inverse.apply(Point::new(x as f64 + offset_x, y as f64 + offset_y))
                    })
                    .collect::<Vec<_>>();
                let gray_expected = (mapped
                    .iter()
                    .map(|point| u32::from(sample_bilinear_white(&source, point.x, point.y)))
                    .sum::<u32>()
                    / offsets.len() as u32) as u8;
                let difference = gray_actual.get(x, y).abs_diff(gray_expected);
                assert!(
                    difference <= 1,
                    "gray pixel ({x},{y}) drifted from the per-sample transform: {} vs {gray_expected}",
                    gray_actual.get(x, y)
                );
                off_by_one += usize::from(difference);

                let mut color_expected = [0u32; 3];
                for point in &mapped {
                    let sample = sample_bilinear_rgb_white(&color, point.x, point.y);
                    for (total, value) in color_expected.iter_mut().zip(sample) {
                        *total += u32::from(value);
                    }
                }
                let actual = color_actual.get(x, y);
                for (channel, total) in color_expected.iter().enumerate() {
                    let expected = (total / offsets.len() as u32) as u8;
                    assert!(
                        actual[channel].abs_diff(expected) <= 1,
                        "colour pixel ({x},{y}) channel {channel} drifted: {} vs {expected}",
                        actual[channel]
                    );
                }
            }
        }
        assert!(
            off_by_one * 1_000 <= width * height,
            "the f32 interior accumulation must round with the f64 sampler on all but a handful of pixels: {off_by_one} of {}",
            width * height
        );
    }

    #[test]
    fn routing_crop_area_averages_thin_strokes_instead_of_aliasing_them() {
        let mut source = GrayImage::new(1_024, 1_024, 255);
        for y in 0..source.height() {
            source.set(2, y, 0);
        }

        let sample = crop_gray_to_fit(
            &source,
            Rect::new(0.0, 0.0, source.width() as f64, source.height() as f64),
            256,
            256,
        );

        assert_eq!((sample.width(), sample.height()), (256, 256));
        assert!(
            sample
                .row(128)
                .iter()
                .any(|&value| (180..=200).contains(&value)),
            "a one-pixel stem must contribute its area to the routing sample: {:?}",
            &sample.row(128)[..4]
        );
        assert!(
            sample.row(128).iter().all(|&value| value > 0),
            "area sampling must not turn a narrow stem into an arbitrary full-black column"
        );
    }

    #[test]
    fn trusted_mask_downsampling_preserves_connected_hairlines() {
        let mut source = BinaryImage::new(9, 9);
        for y in 0..source.height() {
            source.set(3, y, true);
        }
        for x in 0..source.width() {
            source.set(x, 5, true);
        }

        let downsampled = render_binary_mask_preserve_ink(&source, 5, 5, 2.0, 2.0, |point| {
            Some(Point::new(point.x * 2.0, point.y * 2.0))
        });

        assert!((0..downsampled.width())
            .any(|x| (0..downsampled.height()).all(|y| downsampled.get(x, y))));
        assert!((0..downsampled.height())
            .any(|y| (0..downsampled.width()).all(|x| downsampled.get(x, y))));
    }

    #[test]
    fn coherent_photo_field_excludes_rules_scanner_bands_and_text() {
        let mut alpha = GrayImage::new(400, 600, 0);
        let mut source = GrayImage::new(400, 600, 210);
        for y in 100..430 {
            for x in 120..350 {
                alpha.set(x, y, 255);
                source.set(x, y, 70 + ((x + y) % 80) as u8);
            }
        }
        for y in 88..94 {
            for x in 0..400 {
                alpha.set(x, y, 255);
                source.set(x, y, 40);
            }
        }
        for band in 0..22 {
            let top = 105 + band * 12;
            for y in top..(top + 4) {
                for x in 0..100 {
                    alpha.set(x, y, 220);
                    source.set(x, y, 80);
                }
            }
        }
        for line in 0..8 {
            let top = 460 + line * 14;
            for y in top..(top + 3) {
                for x in 35..365 {
                    alpha.set(x, y, 255);
                    source.set(x, y, 30);
                }
            }
        }

        let field = coherent_photo_field(&alpha, &source).expect("photo field");
        assert!(field.get(200, 250));
        assert!(field.get(349, 429));
        assert!(!field.get(40, 250), "scanner bands are paper, not photo");
        assert!(!field.get(200, 90), "page rules are not photo");
        assert!(!field.get(200, 470), "text lines are not photo");
    }

    #[test]
    fn complete_trusted_foreground_is_the_output_ink_authority() {
        let mut binary = BinaryImage::new(64, 32);
        let mut trusted = BinaryImage::new(64, 32);
        for y in 10..15 {
            for x in 20..25 {
                trusted.set(x, y, true);
            }
            for x in 32..37 {
                trusted.set(x, y, true);
                binary.set(x, y, true);
            }
        }
        for x in 0..64 {
            trusted.set(x, 1, true);
        }
        binary.set(50, 25, true);

        let mut raw = GrayImage::new(64, 32, 255);
        raw.set(50, 25, 0);
        let enforced =
            enforce_source_ink_support(binary.clone(), &raw, Some(&trusted), true, 300.0);

        assert!(
            enforced.get(22, 12),
            "missing source glyph was not restored"
        );
        assert!(enforced.get(34, 12), "existing source glyph was changed");
        assert!(enforced.get(10, 1), "source-supported edge ink was removed");
        assert!(!enforced.get(50, 25), "unsupported output ink survived");
        assert_eq!(enforced.count_black(), trusted.count_black());

        let incomplete = enforce_source_ink_support(binary, &raw, Some(&trusted), false, 300.0);
        assert!(
            incomplete.get(50, 25),
            "an incomplete selection did not admit independently supported source ink"
        );
        assert!(incomplete.count_black() > trusted.count_black());
    }

    #[test]
    fn raw_source_support_rejects_a_uniform_tonal_band() {
        let mut raw = GrayImage::new(180, 100, 245);
        let mut binary = BinaryImage::new(180, 100);
        for y in 0..100 {
            for x in 0..80 {
                raw.set(x, y, 150);
                binary.set(x, y, true);
            }
        }
        for y in 40..60 {
            for x in 130..134 {
                raw.set(x, y, 18);
                binary.set(x, y, true);
            }
        }

        let enforced = enforce_source_ink_support(binary, &raw, None, false, 300.0);

        assert!((0..100).all(|y| (0..80).all(|x| !enforced.get(x, y))));
        assert!((40..60).all(|y| (130..134).all(|x| enforced.get(x, y))));
    }

    /// A text column with `rows` scanlines of ink inside the ownership mask,
    /// plus an unowned scanner rail down the left edge.
    fn owned_page_fixture(rows: std::ops::Range<usize>) -> (BinaryImage, BinaryImage) {
        let mut ownership = BinaryImage::new(400, 400);
        for y in 100..300 {
            for x in 100..300 {
                ownership.set(x, y, true);
            }
        }
        let mut ink = BinaryImage::new(400, 400);
        for y in rows {
            for x in 100..300 {
                ink.set(x, y, true);
            }
        }
        for y in 0..400 {
            for x in 0..12 {
                ink.set(x, y, true);
            }
        }
        (ownership, ink)
    }

    #[test]
    fn ink_conservation_restores_the_page_when_cleanup_deletes_its_content() {
        let (ownership, conservative) = owned_page_fixture(100..300);
        let (_, cleaned) = owned_page_fixture(100..150);
        let mut warnings = Vec::new();

        let (published, conserved) = conserve_page_ink(
            conservative.clone(),
            cleaned,
            Some(&ownership),
            115,
            PageHalf::Left,
            &mut warnings,
        );

        assert!(conserved);
        assert_eq!(published.count_black(), conservative.count_black());
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].contains("source page 116 (left half)"),
            "the warning does not name the page: {}",
            warnings[0]
        );
    }

    #[test]
    fn ink_conservation_leaves_a_normally_cleaned_page_alone() {
        let (ownership, conservative) = owned_page_fixture(100..300);
        let (_, cleaned) = owned_page_fixture(100..290);
        let cleaned_ink = cleaned.count_black();
        let mut warnings = Vec::new();

        let (published, conserved) = conserve_page_ink(
            conservative,
            cleaned,
            Some(&ownership),
            2,
            PageHalf::Right,
            &mut warnings,
        );

        assert!(!conserved);
        assert_eq!(published.count_black(), cleaned_ink);
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn ink_conservation_does_not_demand_that_a_scanner_rail_be_kept() {
        let (ownership, conservative) = owned_page_fixture(100..300);
        let mut cleaned = conservative.clone();
        for y in 0..400 {
            for x in 0..12 {
                cleaned.set(x, y, false);
            }
        }
        let mut warnings = Vec::new();

        let (published, conserved) = conserve_page_ink(
            conservative,
            cleaned,
            Some(&ownership),
            2,
            PageHalf::Left,
            &mut warnings,
        );

        assert!(!conserved);
        assert!((0..400).all(|y| !published.get(0, y)));
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn ink_conservation_ignores_a_leaf_that_owns_almost_no_ink() {
        let mut ownership = BinaryImage::new(400, 400);
        let mut conservative = BinaryImage::new(400, 400);
        for y in 200..203 {
            for x in 200..240 {
                ownership.set(x, y, true);
                conservative.set(x, y, true);
            }
        }
        let mut warnings = Vec::new();

        let (published, conserved) = conserve_page_ink(
            conservative,
            BinaryImage::new(400, 400),
            Some(&ownership),
            2,
            PageHalf::Left,
            &mut warnings,
        );

        assert!(!conserved);
        assert_eq!(published.count_black(), 0);
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn a_bilevel_rendition_that_lost_the_page_counts_as_collapsed() {
        let (_, page) = owned_page_fixture(100..300);
        assert!(!pale_bilevel_collapse(&page, false));
        let mut faint = BinaryImage::new(400, 400);
        for x in 100..104 {
            faint.set(x, 200, true);
        }
        assert!(pale_bilevel_collapse(&faint, false));
    }

    #[test]
    fn pale_bilevel_collapse_is_strict_at_one_tenth_percent_ink() {
        let with_ink = |ink: usize| {
            let mut binary = BinaryImage::new(1_000, 100);
            for index in 0..ink {
                binary.set(index % binary.width(), index / binary.width(), true);
            }
            binary
        };

        assert!(pale_bilevel_collapse(&with_ink(99), true));
        assert!(!pale_bilevel_collapse(&with_ink(100), true));
        assert!(!pale_bilevel_collapse(&with_ink(101), true));
    }

    fn fold_test_split(total_width: usize, height: usize) -> SplitResult {
        crate::split::detect_split(
            &GrayImage::new(total_width, height, 255),
            300.0,
            crate::LayoutMode::TwoPage,
            None,
        )
    }

    fn fold_test_plan(region: Rect) -> ComposedRenderPlan {
        ComposedRenderPlan::new(
            region,
            Affine::IDENTITY,
            Affine::IDENTITY,
            None,
            region.width.ceil().max(1.0) as usize,
            region.height.ceil().max(1.0) as usize,
            Rect::new(0.0, 0.0, region.width, region.height),
        )
    }

    #[test]
    fn fold_margin_fragments_are_removed_on_both_leaf_sides() {
        let height = 120;
        let split = fold_test_split(200, height);

        let left_region = Rect::new(0.0, 0.0, 100.0, height as f64);
        let left_plan = fold_test_plan(left_region);
        let mut left = BinaryImage::new(100, height);
        for y in 50..52 {
            for x in 98..100 {
                left.set(x, y, true);
            }
        }
        let left_filtered = filter_fold_edge_fragments(
            &left,
            None,
            None,
            None,
            PageHalf::Left,
            &split,
            left_region,
            &left_plan,
            None,
            false,
            300.0,
        );
        assert_eq!(left_filtered.count_black(), 0, "left fold fragment survived");

        let right_region = Rect::new(100.0, 0.0, 100.0, height as f64);
        let right_plan = fold_test_plan(right_region);
        let mut right = BinaryImage::new(100, height);
        for y in 50..52 {
            for x in 0..2 {
                right.set(x, y, true);
            }
        }
        let right_filtered = filter_fold_edge_fragments(
            &right,
            None,
            None,
            None,
            PageHalf::Right,
            &split,
            right_region,
            &right_plan,
            None,
            false,
            300.0,
        );
        assert_eq!(right_filtered.count_black(), 0, "right fold fragment survived");
    }

    #[test]
    fn fold_margin_text_is_pinned_in_a_tight_rebind_leaf() {
        let height = 120;
        let split = fold_test_split(800, height);
        let region = Rect::new(400.0, 0.0, 400.0, height as f64);
        let plan = fold_test_plan(region);
        let mut binary = BinaryImage::new(400, height);
        let mut text_vicinity = BinaryImage::new(400, height);
        for y in 50..53 {
            for x in 0..4 {
                binary.set(x, y, true);
            }
            for x in 0..16 {
                text_vicinity.set(x, y, true);
            }
        }
        let filtered = filter_fold_edge_fragments(
            &binary,
            None,
            None,
            Some(&text_vicinity),
            PageHalf::Right,
            &split,
            region,
            &plan,
            None,
            false,
            300.0,
        );
        assert_eq!(filtered.count_black(), binary.count_black());
    }

    #[test]
    fn facing_text_masks_that_terminate_at_the_fold_do_not_claim_a_fragment() {
        let height = 120;
        let split = fold_test_split(800, height);
        let region = Rect::new(400.0, 0.0, 400.0, height as f64);
        let plan = fold_test_plan(region);
        let mut binary = BinaryImage::new(400, height);
        let mut text = BinaryImage::new(400, height);
        let mut vicinity = BinaryImage::new(400, height);
        for y in 50..53 {
            for x in 0..4 {
                binary.set(x, y, true);
                text.set(x, y, true);
            }
            for x in 0..6 {
                vicinity.set(x, y, true);
            }
        }
        let filtered = filter_fold_edge_fragments(
            &binary,
            None,
            Some(&text),
            Some(&vicinity),
            PageHalf::Right,
            &split,
            region,
            &plan,
            Some(Rect::new(0.0, 0.0, region.width, region.height)),
            false,
            300.0,
        );
        assert_eq!(
            filtered.count_black(),
            0,
            "spread-wide masks and a contaminated crop must not own facing text"
        );
    }

    #[test]
    fn a_rule_touching_the_fold_is_not_treated_as_a_glyph_fragment() {
        let height = 160;
        let split = fold_test_split(800, height);
        let region = Rect::new(400.0, 0.0, 400.0, height as f64);
        let plan = fold_test_plan(region);
        let mut binary = BinaryImage::new(400, height);
        for y in 50..95 {
            for x in 0..3 {
                binary.set(x, y, true);
            }
        }
        let filtered = filter_fold_edge_fragments(
            &binary,
            None,
            None,
            None,
            PageHalf::Right,
            &split,
            region,
            &plan,
            None,
            false,
            300.0,
        );
        assert_eq!(filtered.count_black(), binary.count_black());
    }

    #[test]
    fn a_measured_fold_can_drop_a_ragged_scanner_rail_but_not_a_solid_rule() {
        let height = 180;
        let mut split = fold_test_split(800, height);
        split.cutter_x = Some(400.0);
        split.diagnostics.fold_band = FoldBand::measured(390.0, 410.0);
        let region = Rect::new(400.0, 0.0, 400.0, height as f64);
        let plan = fold_test_plan(region);

        let mut ragged = BinaryImage::new(400, height);
        for y in 25..145 {
            ragged.set(0, y, true);
            ragged.set(1, y, true);
            if y % 4 != 0 {
                for x in 2..6 {
                    ragged.set(x, y, true);
                }
            }
        }
        let filtered = filter_fold_edge_fragments(
            &ragged,
            None,
            None,
            None,
            PageHalf::Right,
            &split,
            region,
            &plan,
            None,
            false,
            300.0,
        );
        assert_eq!(filtered.count_black(), 0, "ragged scanner rail survived");

        let mut solid = BinaryImage::new(400, height);
        for y in 25..145 {
            for x in 0..3 {
                solid.set(x, y, true);
            }
        }
        let filtered = filter_fold_edge_fragments(
            &solid,
            None,
            None,
            None,
            PageHalf::Right,
            &split,
            region,
            &plan,
            None,
            false,
            300.0,
        );
        assert_eq!(filtered.count_black(), solid.count_black());
    }

    #[test]
    fn a_measured_fold_drops_a_blank_leaf_corner_rail_but_keeps_nonblank_edge_ink() {
        let height = 240;
        let mut split = fold_test_split(800, height);
        split.cutter_x = Some(400.0);
        split.diagnostics.fold_band = FoldBand::measured(390.0, 410.0);
        let region = Rect::new(400.0, 0.0, 400.0, height as f64);
        let plan = fold_test_plan(region);
        let mut corner_rail = BinaryImage::new(400, height);
        for y in 0..120 {
            corner_rail.set(0, y, true);
            corner_rail.set(1, y, true);
            if y % 4 != 0 {
                for x in 2..6 {
                    corner_rail.set(x, y, true);
                }
            }
        }

        let blank_filtered = filter_fold_edge_fragments(
            &corner_rail,
            None,
            None,
            None,
            PageHalf::Right,
            &split,
            region,
            &plan,
            None,
            true,
            300.0,
        );
        assert_eq!(
            blank_filtered.count_black(),
            0,
            "measured blank-leaf corner rail survived",
        );

        let nonblank_filtered = filter_fold_edge_fragments(
            &corner_rail,
            None,
            None,
            None,
            PageHalf::Right,
            &split,
            region,
            &plan,
            None,
            false,
            300.0,
        );
        assert_eq!(
            nonblank_filtered.count_black(),
            corner_rail.count_black(),
            "top-edge ink on a nonblank leaf was removed",
        );
    }

    #[test]
    fn aligned_broken_scanner_rail_segments_are_filtered_as_one_chain() {
        let height = 360;
        let mut split = fold_test_split(800, height);
        split.cutter_x = Some(400.0);
        split.diagnostics.fold_band = FoldBand::measured(390.0, 410.0);
        let region = Rect::new(400.0, 0.0, 400.0, height as f64);
        let plan = fold_test_plan(region);
        let mut binary = BinaryImage::new(400, height);
        for top in [25, 105, 185, 265] {
            for y in top..top + 20 {
                for x in 0..3 {
                    binary.set(x, y, true);
                }
            }
        }
        let filtered = filter_fold_edge_fragments(
            &binary,
            None,
            None,
            None,
            PageHalf::Right,
            &split,
            region,
            &plan,
            None,
            false,
            300.0,
        );
        assert_eq!(filtered.count_black(), 0, "broken rail chain survived");
    }

    #[test]
    fn fold_margin_picture_ownership_is_pinned_on_a_nonblank_leaf() {
        let height = 120;
        let split = fold_test_split(800, height);
        let region = Rect::new(400.0, 0.0, 400.0, height as f64);
        let plan = fold_test_plan(region);
        let mut binary = BinaryImage::new(400, height);
        let mut picture = BinaryImage::new(400, height);
        for y in 50..52 {
            for x in 0..2 {
                binary.set(x, y, true);
                picture.set(x, y, true);
            }
        }
        let filtered = filter_fold_edge_fragments(
            &binary,
            Some(&picture),
            None,
            None,
            PageHalf::Right,
            &split,
            region,
            &plan,
            None,
            false,
            300.0,
        );
        assert_eq!(filtered.count_black(), binary.count_black());
    }

    #[test]
    fn blank_leaf_speck_pass_removes_isolated_marks_inside_the_fold_corridor() {
        let height = 120;
        let split = fold_test_split(800, height);
        let region = Rect::new(400.0, 0.0, 400.0, height as f64);
        let plan = fold_test_plan(region);
        let mut binary = BinaryImage::new(400, height);
        for y in 50..52 {
            for x in 5..7 {
                binary.set(x, y, true);
            }
        }
        let mut picture = BinaryImage::new(400, height);
        for y in 50..52 {
            for x in 5..7 {
                picture.set(x, y, true);
            }
        }
        let filtered = filter_fold_edge_fragments(
            &binary,
            Some(&picture),
            None,
            None,
            PageHalf::Right,
            &split,
            region,
            &plan,
            None,
            true,
            300.0,
        );
        assert_eq!(filtered.count_black(), 0, "blank-leaf fold speck survived");
    }

    #[test]
    fn mixed_composition_whitens_pixels_removed_from_the_fold_foreground() {
        let height = 120;
        let split = fold_test_split(200, height);
        let region = Rect::new(100.0, 0.0, 100.0, height as f64);
        let plan = fold_test_plan(region);
        let mut binary = BinaryImage::new(100, height);
        for y in 50..52 {
            for x in 0..2 {
                binary.set(x, y, true);
            }
        }

        let (filtered, removed) = filter_fold_edge_fragments_with_removed(
            &binary,
            None,
            None,
            None,
            PageHalf::Right,
            &split,
            region,
            &plan,
            None,
            false,
            300.0,
        );
        assert_eq!(filtered.count_black(), 0);
        assert_eq!(removed.count_black(), binary.count_black());

        let gray = GrayImage::new(100, height, 182);
        let picture_mask = BinaryImage::new(100, height);
        let (mixed, _, _) = compose_mixed(
            &gray,
            None,
            None,
            &filtered,
            &picture_mask,
            None,
            Some(&removed),
            None,
            None,
            300.0,
            false,
            false,
            true,
            true,
        );
        assert_eq!(mixed.get(0, 50), 255);
        assert_eq!(mixed.get(2, 50), 255);
    }

    #[test]
    fn leaf_blankness_is_read_past_the_fold_shadow_but_not_past_the_text() {
        let mut shadowed = GrayImage::new(600, 800, 250);
        for y in 0..800 {
            for x in 0..20 {
                shadowed.set(x, y, (30 + x * 8) as u8);
            }
        }
        assert!(
            leaf_interior_is_blank(&shadowed, 150.0),
            "a blank verso was denied its clean page by the fold shadow",
        );

        let mut printed = shadowed.clone();
        for y in 300..340 {
            for x in 200..420 {
                printed.set(x, y, 40);
            }
        }
        assert!(
            !leaf_interior_is_blank(&printed, 150.0),
            "a printed leaf was treated as blank",
        );
    }

    #[test]
    fn collapsed_blank_fallback_whitens_only_the_proven_fold_margin() {
        let mut split = fold_test_split(200, 120);
        split.cutter_x = Some(100.0);
        split.diagnostics.fold_band = FoldBand::measured(90.0, 110.0);
        let mut removed = BinaryImage::new(100, 120);
        removed.set(99, 12, true);

        let left = whiten_collapsed_blank_fold_margin(
            GrayImage::new(100, 120, 218),
            &removed,
            PageHalf::Left,
            &split,
            true,
        );
        assert_eq!(left.get(97, 60), 218, "leaf interior was whitened");
        assert_eq!(left.get(98, 60), 255, "left fold margin survived");
        assert_eq!(left.get(99, 60), 255, "left fold edge survived");

        let right = whiten_collapsed_blank_fold_margin(
            GrayImage::new(100, 120, 218),
            &removed,
            PageHalf::Right,
            &split,
            true,
        );
        assert_eq!(right.get(0, 60), 255, "right fold edge survived");
        assert_eq!(right.get(1, 60), 255, "right fold margin survived");
        assert_eq!(right.get(2, 60), 218, "right leaf interior was whitened");

        let protected = whiten_collapsed_blank_fold_margin(
            GrayImage::new(100, 120, 218),
            &removed,
            PageHalf::Left,
            &split,
            false,
        );
        assert_eq!(protected.get(99, 60), 218, "owned content was whitened");
    }

    #[test]
    fn either_collapsed_gutter_side_requests_raw_remeasurement() {
        let mut split = fold_test_split(800, 120);
        split.cutter_x = Some(400.0);
        split.diagnostics.fold_band = FoldBand::measured(390.0, 410.0);
        assert!(!gutter_band_needs_raw_remeasurement(&split));

        split.diagnostics.fold_band = FoldBand::measured(400.0, 410.0);
        assert!(gutter_band_needs_raw_remeasurement(&split));

        split.diagnostics.fold_band = FoldBand::measured(390.0, 400.0);
        assert!(gutter_band_needs_raw_remeasurement(&split));

        split.diagnostics.fold_band =
            FoldBand::unmeasured(FoldBandUnmeasuredReason::MeasurementUnavailable);
        assert!(gutter_band_needs_raw_remeasurement(&split));
    }

    #[test]
    fn fixed_analysis_plane_owns_route_and_leaf_resolution_across_working_rasters() {
        let mut canonical = GrayImage::new(192, 256, 244);
        for y in 24..232 {
            for x in (24..168).step_by(18) {
                for stroke_x in x..x + 3 {
                    canonical.set(stroke_x, y, 48);
                }
            }
        }
        let clean_working = canonical.clone();
        let mut noisy_working = GrayImage::new(384, 512, 255);
        for y in 0..noisy_working.height() {
            for x in 0..noisy_working.width() {
                let canonical_value = canonical.get(x / 2, y / 2);
                noisy_working.set(
                    x,
                    y,
                    if x < 64 || x + 64 >= noisy_working.width() || (x + y) % 3 == 0 {
                        24
                    } else {
                        canonical_value
                    },
                );
            }
        }
        let direct_options = CleanupOptions {
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };
        let direct_routes = [
            resolve_binarization_diagnostics(&clean_working, &direct_options).route,
            resolve_binarization_diagnostics(&noisy_working, &direct_options).route,
        ];
        assert_ne!(
            direct_routes[0], direct_routes[1],
            "mutation control must fail when the fixed plane is bypassed",
        );

        let expected = resolve_binarization_diagnostics(&canonical, &direct_options).route;
        let mut identities = Vec::new();
        for (dpi, working) in [(150.0, &clean_working), (299.0, &noisy_working)] {
            let options = CleanupOptions {
                dpi,
                normalize_illumination: false,
                despeckle: false,
                output_mode: OutputMode::Bw,
                layout: crate::LayoutMode::Single,
                crop_content: false,
                match_page_size: false,
                skip_blank_pages: true,
                ..CleanupOptions::default()
            };
            let mut timings = PageStageTimings::default();
            let result = clean_page_with_color_and_calibration_config(
                working,
                None,
                Some(CanonicalAnalysisPlane {
                    gray: &canonical,
                    color: None,
                    dpi: 150.0,
                }),
                None,
                None,
                &options,
                0,
                CalibrationConfig::default(),
                None,
                None,
                PageRenderPolicy::COMPLETE,
                &mut timings,
            )
            .unwrap();
            identities.push((
                result.outputs[0].metadata.binarization_mode,
                result.blank_outputs_skipped,
                result.outputs.len(),
            ));
        }
        assert!(identities.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(identities[0], (Some(expected), 0, 1));
    }

    #[test]
    fn canonical_region_assertion_checks_geometry_in_common_coordinates() {
        let canonical = vec![
            (Rect::new(0.0, 0.0, 40.0, 100.0), PageHalf::Left),
            (Rect::new(60.0, 0.0, 40.0, 100.0), PageHalf::Right),
        ];
        let working = vec![
            (Rect::new(0.0, 0.0, 80.0, 200.0), PageHalf::Left),
            (Rect::new(120.0, 0.0, 80.0, 200.0), PageHalf::Right),
        ];
        assert!(regions_match_in_common_coordinates(
            &canonical, &working, 100, 100, 200, 200,
        ));

        let moved_right_edge = vec![
            (Rect::new(0.0, 0.0, 70.0, 200.0), PageHalf::Left),
            (Rect::new(120.0, 0.0, 80.0, 200.0), PageHalf::Right),
        ];
        assert!(!regions_match_in_common_coordinates(
            &canonical,
            &moved_right_edge,
            100,
            100,
            200,
            200,
        ));

        let anisotropic_canonical = vec![
            (Rect::new(0.0, 0.0, 400.0, 100.0), PageHalf::Left),
            (Rect::new(600.0, 0.0, 400.0, 100.0), PageHalf::Right),
        ];
        let anisotropic_working = vec![
            (Rect::new(0.0, 0.0, 820.0, 200.0), PageHalf::Left),
            (Rect::new(1200.0, 0.0, 800.0, 200.0), PageHalf::Right),
        ];
        assert!(!regions_match_in_common_coordinates(
            &anisotropic_canonical,
            &anisotropic_working,
            1_000,
            100,
            2_000,
            200,
        ));
    }
}
