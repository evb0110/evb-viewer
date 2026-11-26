use crate::io::png::RgbImage;
use scan_primitives::{BinaryImage, GrayImage};

pub use scan_primitives::background::{
    normalize_illumination, normalize_illumination_for_layout,
    normalize_illumination_for_layout_prepared, normalize_illumination_pair_with_masks,
    normalize_illumination_prepared_with_masks, normalize_illumination_rgb,
    normalize_illumination_rgb_with_masks, normalize_illumination_with_masks,
    normalize_region_with_reusable_model, normalize_rgb_region_with_reusable_model,
    prepare_illumination, reusable_illumination_model, smooth_for_binarization,
    IlluminationPreparation, ReusableIlluminationModel,
};

pub fn normalize_illumination_with_picture_mask(
    source: &GrayImage,
    dpi: f64,
    picture_mask: Option<&BinaryImage>,
) -> GrayImage {
    let photo_preservation_alpha = picture_mask.and_then(|mask| {
        let preparation = prepare_illumination(source);
        let layout = normalize_illumination_for_layout_prepared(source, &preparation);
        crate::picture::refine_tone_preservation_alpha(&layout, source, Some(mask), None)
    });
    normalize_illumination_with_masks(
        source,
        dpi,
        picture_mask,
        None,
        photo_preservation_alpha.as_ref(),
    )
}

#[cfg(test)]
pub(crate) fn normalize_illumination_preserving_tone(
    source: &GrayImage,
    dpi: f64,
    protected_tone_mask: &BinaryImage,
) -> GrayImage {
    normalize_illumination_with_picture_mask(source, dpi, Some(protected_tone_mask))
}

pub fn normalize_illumination_rgb_with_picture_mask(
    luminance: &GrayImage,
    source: &RgbImage,
    _dpi: f64,
    picture_mask: Option<&BinaryImage>,
) -> RgbImage {
    let photo_preservation_alpha = picture_mask.and_then(|mask| {
        let preparation = prepare_illumination(luminance);
        let layout = normalize_illumination_for_layout_prepared(luminance, &preparation);
        crate::picture::refine_tone_preservation_alpha(&layout, luminance, Some(mask), None)
    });
    normalize_illumination_rgb_with_masks(
        luminance,
        source,
        picture_mask,
        None,
        photo_preservation_alpha.as_ref(),
    )
}

#[cfg(test)]
pub(crate) fn normalize_illumination_pair_with_picture_mask(
    luminance: &GrayImage,
    source: &RgbImage,
    picture_mask: Option<&BinaryImage>,
) -> (GrayImage, RgbImage) {
    let photo_preservation_alpha = picture_mask.and_then(|mask| {
        let preparation = prepare_illumination(luminance);
        let layout = normalize_illumination_for_layout_prepared(luminance, &preparation);
        crate::picture::refine_tone_preservation_alpha(&layout, luminance, Some(mask), None)
    });
    normalize_illumination_pair_with_masks(
        luminance,
        source,
        picture_mask,
        None,
        photo_preservation_alpha.as_ref(),
    )
}

#[cfg(test)]
pub(crate) fn normalize_illumination_prepared(
    source: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    preparation: IlluminationPreparation,
) -> GrayImage {
    let photo_preservation_alpha = picture_mask.and_then(|mask| {
        let layout = normalize_illumination_for_layout_prepared(source, &preparation);
        crate::picture::refine_tone_preservation_alpha(&layout, source, Some(mask), None)
    });
    normalize_illumination_prepared_with_masks(
        source,
        picture_mask,
        None,
        photo_preservation_alpha.as_ref(),
        None,
        preparation,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use scan_primitives::background::{
        fit_masked_surface_for_test, fit_masked_surface_legacy_for_test,
        reconstructed_background_for_test,
    };

    #[test]
    fn degenerate_picture_mask_keeps_the_selected_background_bounded() {
        let mut source = GrayImage::new(140, 100, 225);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(x, y, (180 + 40 * x / (source.width() - 1)) as u8);
            }
        }
        let mut picture_mask = BinaryImage::new(source.width(), source.height());
        for y in 0..source.height() {
            for x in 0..source.width() {
                picture_mask.set(x, y, x >= 42 || y >= 34);
            }
        }
        let normalized =
            normalize_illumination_with_picture_mask(&source, 300.0, Some(&picture_mask));
        let minimum = normalized.data().iter().copied().min().unwrap_or(255);
        assert!(
            normalized.data().iter().all(|&value| value >= 254),
            "a smooth paper field remained visibly shaded: minimum={minimum}"
        );
    }

    #[test]
    fn mixed_normalization_whitens_uniform_tinted_paper_outside_protected_color() {
        let mut rgb = RgbImage::new(240, 180, [205, 225, 245]);
        for y in 60..68 {
            for x in 28..132 {
                rgb.set(x, y, [25, 29, 34]);
            }
        }
        for y in 42..128 {
            for x in 160..214 {
                rgb.set(x, y, [220, 48, 42]);
            }
        }
        let mut luminance = GrayImage::new(rgb.width(), rgb.height(), 0);
        for y in 0..rgb.height() {
            for x in 0..rgb.width() {
                let pixel = rgb.get(x, y);
                luminance.set(
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
        let mut picture_mask = BinaryImage::new(120, 90);
        for y in 21..64 {
            for x in 80..107 {
                picture_mask.set(x, y, true);
            }
        }

        let (normalized_gray, normalized_rgb) =
            normalize_illumination_pair_with_picture_mask(&luminance, &rgb, Some(&picture_mask));

        assert!(normalized_gray.get(20, 20) >= 250);
        assert!(normalized_rgb
            .get(20, 20)
            .iter()
            .all(|&channel| channel >= 250));
        let ink = normalized_rgb.get(60, 64);
        assert!(ink.iter().copied().max().unwrap_or(255) < 64);
        let protected_red = normalized_rgb.get(180, 80);
        assert!(
            protected_red[0] > protected_red[1].saturating_mul(2),
            "{protected_red:?}"
        );
        assert!(
            protected_red[0] > protected_red[2].saturating_mul(2),
            "{protected_red:?}"
        );
    }

    #[test]
    fn mixed_normalization_recovers_paper_like_pixels_inside_an_overbroad_picture_mask() {
        let mut source = GrayImage::new(240, 180, 220);
        for y in 24..156 {
            for x in 118..228 {
                let edge_distance = (x - 118).min(227 - x).min((y - 24).min(155 - y));
                source.set(x, y, 220_u8.saturating_sub(edge_distance.min(18) as u8));
            }
        }
        for y in 54..126 {
            for x in 146..208 {
                source.set(x, y, 45 + ((x * 7 + y * 11) % 105) as u8);
            }
        }
        let mut picture_mask = BinaryImage::new(120, 90);
        for y in 12..78 {
            for x in 59..114 {
                picture_mask.set(x, y, true);
            }
        }

        let normalized =
            normalize_illumination_with_picture_mask(&source, 300.0, Some(&picture_mask));

        assert!(
            normalized.get(128, 40) >= 250,
            "paper-like mask halo remained gray: {}",
            normalized.get(128, 40)
        );
        assert!(
            normalized.get(176, 90) < 200,
            "the protected photograph was mistaken for paper: {}",
            normalized.get(176, 90)
        );
        assert_eq!(
            normalized.get(176, 90),
            source.get(176, 90),
            "protected grayscale tone must not be flattened by the paper model"
        );
    }

    #[test]
    fn prepared_mixed_normalization_matches_the_final_paper_recovery_path() {
        let mut source = GrayImage::new(240, 180, 218);
        for y in 38..142 {
            for x in 124..220 {
                source.set(x, y, 48 + ((x * 5 + y * 9) % 150) as u8);
            }
        }
        let mut picture_mask = BinaryImage::new(120, 90);
        for y in 16..76 {
            for x in 57..114 {
                picture_mask.set(x, y, true);
            }
        }

        let direct = normalize_illumination_with_picture_mask(&source, 150.0, Some(&picture_mask));
        let prepared = normalize_illumination_prepared(
            &source,
            Some(&picture_mask),
            prepare_illumination(&source),
        );

        assert_eq!(prepared, direct);
        assert!(prepared.get(30, 30) >= 250);
    }

    #[test]
    fn corroborated_tonal_mask_preserves_picture_interior_and_feathers_boundaries() {
        let mut source = GrayImage::new(180, 120, 208);
        let mut protected = BinaryImage::new(180, 120);
        for y in 24..96 {
            for x in 42..138 {
                protected.set(x, y, true);
                source.set(x, y, 18 + ((x * 3 + y * 5) % 208) as u8);
            }
        }

        let normalized = normalize_illumination_preserving_tone(&source, 150.0, &protected);

        assert!(normalized.get(12, 12) >= 250);
        assert_eq!(normalized.get(80, 60), source.get(80, 60));
        for (x, y) in [(42, 24), (137, 95)] {
            assert!(normalized.get(x, y) >= source.get(x, y));
            assert!(normalized.get(x, y) < 200);
        }
    }

    #[test]
    fn mixed_normalization_handles_large_photos_on_varied_uniform_paper_tints() {
        for paper in [
            [176, 176, 176],
            [176, 202, 228],
            [228, 207, 176],
            [180, 222, 194],
        ] {
            let mut rgb = RgbImage::new(360, 240, paper);
            for line in 0..8 {
                let top = 24 + line * 24;
                for y in top..top + 7 {
                    for x in 20..146 {
                        rgb.set(x, y, [28, 31, 35]);
                    }
                }
            }
            for y in 18..222 {
                for x in 170..342 {
                    let horizontal = ((x - 170) * 150 / 171) as u8;
                    let vertical = ((y - 18) * 100 / 203) as u8;
                    rgb.set(
                        x,
                        y,
                        [
                            35_u8.saturating_add(horizontal),
                            26_u8.saturating_add(vertical),
                            112_u8.saturating_add(horizontal / 2),
                        ],
                    );
                }
            }
            let mut luminance = GrayImage::new(rgb.width(), rgb.height(), 0);
            for y in 0..rgb.height() {
                for x in 0..rgb.width() {
                    let pixel = rgb.get(x, y);
                    luminance.set(
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
            let mut picture_mask = BinaryImage::new(180, 120);
            for y in 9..111 {
                for x in 85..171 {
                    picture_mask.set(x, y, true);
                }
            }

            let (normalized_gray, normalized_rgb) = normalize_illumination_pair_with_picture_mask(
                &luminance,
                &rgb,
                Some(&picture_mask),
            );

            assert!(
                normalized_gray.get(154, 228) >= 248,
                "paper={paper:?}, gray={}",
                normalized_gray.get(154, 228)
            );
            assert!(
                normalized_rgb
                    .get(154, 228)
                    .iter()
                    .all(|&channel| channel >= 248),
                "paper={paper:?}, rgb={:?}",
                normalized_rgb.get(154, 228)
            );
            assert!(
                normalized_gray.get(80, 75) < 96,
                "paper={paper:?}, ink={}",
                normalized_gray.get(80, 75)
            );
            let protected = normalized_rgb.get(280, 120);
            assert!(
                protected[2] > protected[1] && protected[0] > protected[1],
                "paper={paper:?}, protected={protected:?}"
            );
        }
    }

    fn gutter_fixture() -> GrayImage {
        crate::io::png::decode_image(
            include_bytes!("../tests/fixtures/split/spread-luther-soft-gutter-p00001.png"),
            crate::DEFAULT_MAX_PIXELS,
            crate::DEFAULT_MAX_DIMENSION,
        )
        .expect("gutter fixture decodes")
        .gray
    }

    fn chebyshev_basis<const TERMS: usize>(value: f64) -> [f64; TERMS] {
        let mut result = [0.0; TERMS];
        if TERMS > 0 {
            result[0] = 1.0;
        }
        if TERMS > 1 {
            result[1] = value;
        }
        for index in 2..TERMS {
            result[index] = 2.0 * value * result[index - 1] - result[index - 2];
        }
        result
    }

    fn surface_at(coefficients: &[f64], u: f64, v: f64) -> f64 {
        let tx = chebyshev_basis::<8>(u * 2.0 - 1.0);
        let ty = chebyshev_basis::<5>(v * 2.0 - 1.0);
        let mut sum = 0.0;
        for (y_term, &yv) in ty.iter().enumerate() {
            for (x_term, &xv) in tx.iter().enumerate() {
                sum += coefficients[y_term * 8 + x_term] * xv * yv;
            }
        }
        sum
    }

    const SURFACE_PROBES: [(f64, f64); 5] = [
        (0.0, 0.0),
        (0.25, 0.5),
        (0.5, 0.5),
        (0.75, 0.25),
        (1.0, 1.0),
    ];

    #[test]
    fn both_surface_fits_reproduce_their_pre_flattening_models() {
        const CHOLESKY: [f64; 5] = [
            255.858782016274,
            258.676637944154,
            253.648001385545,
            250.035479730120,
            255.968139778069,
        ];
        const GAUSSIAN: [f64; 5] = [
            255.004815573390,
            253.729905722550,
            252.459927110234,
            252.873666952078,
            257.254882185427,
        ];
        let (small, candidate) = reconstructed_background_for_test(&gutter_fixture());
        let fit =
            fit_masked_surface_for_test(&small, &candidate, None).expect("gutter fixture must fit");
        let legacy = fit_masked_surface_legacy_for_test(&small, &candidate)
            .expect("legacy fit must converge");
        for (index, (u, v)) in SURFACE_PROBES.into_iter().enumerate() {
            let cholesky = surface_at(&fit.coefficients, u, v);
            let gaussian = surface_at(&legacy, u, v);
            assert!(
                (cholesky - CHOLESKY[index]).abs() < 1e-8,
                "cholesky probe {index}: {cholesky} vs {}",
                CHOLESKY[index]
            );
            assert!(
                (gaussian - GAUSSIAN[index]).abs() < 1e-8,
                "gaussian probe {index}: {gaussian} vs {}",
                GAUSSIAN[index]
            );
        }
    }

    #[test]
    fn surface_fit_does_not_depend_on_the_thread_count() {
        let (small, candidate) = reconstructed_background_for_test(&gutter_fixture());
        let single = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .expect("single-threaded pool")
            .install(|| fit_masked_surface_for_test(&small, &candidate, None))
            .expect("gutter fixture must fit");
        let parallel = rayon::ThreadPoolBuilder::new()
            .num_threads(8)
            .build()
            .expect("eight-threaded pool")
            .install(|| fit_masked_surface_for_test(&small, &candidate, None))
            .expect("gutter fixture must fit");
        assert_eq!(single.coefficients, parallel.coefficients);
        assert_eq!(
            fit_masked_surface_legacy_for_test(&small, &candidate),
            rayon::ThreadPoolBuilder::new()
                .num_threads(1)
                .build()
                .expect("single-threaded pool")
                .install(|| fit_masked_surface_legacy_for_test(&small, &candidate))
        );
    }
}
