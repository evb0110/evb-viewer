//! Typed handoff for final raster composition.

use super::*;

pub(crate) struct Input<'a> {
    pub gray: &'a GrayImage,
    pub raw_gray: Option<&'a GrayImage>,
    pub color: Option<&'a RgbImage>,
    pub binary: &'a BinaryImage,
    pub picture_mask: &'a BinaryImage,
    pub chroma_picture_mask: Option<&'a BinaryImage>,
    pub removed_edge_bands: Option<&'a BinaryImage>,
    pub text_mask: Option<&'a BinaryImage>,
    pub text_vicinity_mask: Option<&'a BinaryImage>,
    pub dpi: f64,
    pub preserve_confirmed_photo_tones: bool,
    pub use_soft_alpha_foreground: bool,
    pub create_layers: bool,
    pub create_composite: bool,
}

pub(crate) struct Output {
    pub gray: GrayImage,
    pub color: Option<RgbImage>,
    pub mixed_layers: Option<MixedLayers>,
}

pub(crate) fn run(input: Input<'_>) -> Output {
    let Input {
        gray,
        raw_gray,
        color,
        binary,
        picture_mask,
        chroma_picture_mask,
        removed_edge_bands,
        text_mask,
        text_vicinity_mask,
        dpi,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        create_layers,
        create_composite,
    } = input;
    debug_assert_eq!(
        (gray.width(), gray.height()),
        (binary.width(), binary.height())
    );
    debug_assert_eq!(
        (gray.width(), gray.height()),
        (picture_mask.width(), picture_mask.height())
    );
    debug_assert!(chroma_picture_mask
        .is_none_or(|mask| (mask.width(), mask.height()) == (gray.width(), gray.height())));
    debug_assert!(removed_edge_bands
        .is_none_or(|mask| (mask.width(), mask.height()) == (gray.width(), gray.height())));
    debug_assert!(
        text_mask.is_none_or(|mask| (mask.width(), mask.height()) == (gray.width(), gray.height()))
    );
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| (mask.width(), mask.height()) == (gray.width(), gray.height())));
    // Mixed has two mutually exclusive owners: the binary foreground owns
    // text, while the protected picture mask owns continuous-tone detail.
    // Binarization already excludes this area, but later text-recall and
    // source-ink-support passes can add pixels back. Enforce the ownership
    // boundary at the composition boundary so every Mixed path, including
    // soft-alpha composition, has the same protection against leaked ink.
    let protection_radius = picture_protection_radius(dpi);
    let protected_picture_mask = dilate(picture_mask, protection_radius, protection_radius);
    let owned_binary = binary.subtract(&protected_picture_mask);
    debug_assert_eq!(
        owned_binary.and(&protected_picture_mask).count_black(),
        0,
        "Mixed foreground must not overlap protected picture ownership"
    );
    let binary = &owned_binary;
    if use_soft_alpha_foreground {
        let (gray, color, mixed_layers) = compose_soft_alpha_mixed(
            gray,
            raw_gray,
            color,
            binary,
            picture_mask,
            chroma_picture_mask,
            removed_edge_bands,
            text_mask,
            text_vicinity_mask,
            dpi,
            preserve_confirmed_photo_tones,
            create_layers,
            create_composite,
        );
        return Output {
            gray,
            color,
            mixed_layers,
        };
    }
    // The final stencil and the calibrated picture mask are both rebuilt from
    // the cleaned raster. Start the background at neutral white so no
    // producer-authored composite or unclassified scanner tone can travel
    // into the output. The narrow picture ring may reclaim genuinely dark
    // boundary detail, but pale pixels outside the calibrated zone remain
    // white.
    let mut mixed_gray = GrayImage::new(gray.width(), gray.height(), 255);
    // A color plane is only produced when the page owns independent chroma.
    // Scanner noise keeps neutral pages from ever measuring exactly r=g=b,
    // so publishing RGB here forces every downstream encoder into a
    // three-channel JPEG at ~3x the bytes for tone the gray plane already
    // carries.
    let mut mixed_color = color
        .filter(|_| chroma_picture_mask.is_some())
        .map(|_| RgbImage::new(gray.width(), gray.height(), [255; 3]));
    let feather_radius = (dpi * 3.0 / 25.4).round().clamp(4.0, 48.0) as usize;
    let picture_exterior = picture_mask.invert();
    let (distance_to_picture_exterior, distance_to_stencil) = rayon::join(
        || squared_euclidean_distance(&picture_exterior),
        || squared_euclidean_distance(binary),
    );
    let stencil_adjacency_squared = (feather_radius * feather_radius) as u32;
    let alpha_at = |x: usize, y: usize, source_gray: u8| {
        let index = y * gray.width() + x;
        if preserve_confirmed_photo_tones {
            // Every pixel inside a corroborated owner is source appearance, including
            // the rectangular crop's paper-toned boundary. Any protective transition
            // belongs to the exterior ring below; fading owner pixels toward white
            // recreates the tile-shaped halo this path exists to remove.
            1.0
        } else if distance_to_stencil[index] <= stencil_adjacency_squared {
            let spatial_alpha = (f64::from(distance_to_picture_exterior[index]).sqrt()
                / feather_radius as f64)
                .clamp(0.0, 1.0);
            let dark_detail_alpha = ((245.0 - f64::from(source_gray)) / 96.0).clamp(0.0, 1.0);
            spatial_alpha.max(dark_detail_alpha)
        } else {
            1.0
        }
    };
    if let (Some(source_color), Some(output_color)) = (color, mixed_color.as_mut()) {
        mixed_gray
            .data_mut()
            .par_chunks_mut(gray.width())
            .zip(output_color.data_mut().par_chunks_mut(gray.width() * 3))
            .enumerate()
            .for_each(|(y, (gray_row, color_row))| {
                for (x, gray_target) in gray_row.iter_mut().enumerate() {
                    if removed_edge_bands.is_some_and(|mask| mask.get(x, y)) {
                        *gray_target = 255;
                        color_row[x * 3..x * 3 + 3].fill(255);
                        continue;
                    }
                    if binary.get(x, y) {
                        let value = if create_composite { 0 } else { 255 };
                        *gray_target = value;
                        color_row[x * 3..x * 3 + 3].fill(value);
                        continue;
                    }
                    if !protected_picture_mask.get(x, y) {
                        continue;
                    }
                    let source_gray = gray.get(x, y);
                    let inside_picture = picture_mask.get(x, y);
                    let alpha = if inside_picture {
                        alpha_at(x, y, source_gray)
                    } else {
                        ((200.0 - f64::from(source_gray)) / 80.0).clamp(0.0, 1.0)
                    };
                    let exact_owned_tone = preserve_confirmed_photo_tones && inside_picture;
                    let paper_ring = !inside_picture && alpha <= f64::EPSILON;
                    *gray_target = if exact_owned_tone {
                        source_gray
                    } else if paper_ring {
                        255
                    } else {
                        reserve_gray_endpoint(
                            (255.0 * (1.0 - alpha) + f64::from(source_gray) * alpha)
                                .round()
                                .clamp(0.0, 255.0) as u8,
                        )
                    };
                    let rgb = if exact_owned_tone {
                        source_color.get(x, y)
                    } else if paper_ring {
                        [255; 3]
                    } else {
                        reserve_rgb_endpoints(source_color.get(x, y).map(|channel| {
                            (255.0 * (1.0 - alpha) + f64::from(channel) * alpha)
                                .round()
                                .clamp(0.0, 255.0) as u8
                        }))
                    };
                    color_row[x * 3..x * 3 + 3].copy_from_slice(&rgb);
                }
            });
    } else {
        mixed_gray
            .data_mut()
            .par_chunks_mut(gray.width())
            .enumerate()
            .for_each(|(y, row)| {
                for (x, target) in row.iter_mut().enumerate() {
                    if removed_edge_bands.is_some_and(|mask| mask.get(x, y)) {
                        *target = 255;
                        continue;
                    }
                    if binary.get(x, y) {
                        *target = if create_composite { 0 } else { 255 };
                    } else if protected_picture_mask.get(x, y) {
                        let source_gray = gray.get(x, y);
                        let inside_picture = picture_mask.get(x, y);
                        let alpha = if inside_picture {
                            alpha_at(x, y, source_gray)
                        } else {
                            ((200.0 - f64::from(source_gray)) / 80.0).clamp(0.0, 1.0)
                        };
                        *target = if preserve_confirmed_photo_tones && inside_picture {
                            source_gray
                        } else if !inside_picture && alpha <= f64::EPSILON {
                            255
                        } else {
                            reserve_gray_endpoint(
                                (255.0 * (1.0 - alpha) + f64::from(source_gray) * alpha)
                                    .round()
                                    .clamp(0.0, 255.0) as u8,
                            )
                        };
                    }
                }
            });
    }
    let layers = create_layers.then(|| {
        let foreground_mask = binary.clone();
        let mut background = mixed_gray.clone();
        let mut color_background = mixed_color.clone();
        if !create_composite {
            fill_picture_stencil_knockouts(
                &mut background,
                color_background.as_mut(),
                binary,
                &protected_picture_mask,
                dpi,
            );
            return MixedLayers {
                foreground_mask,
                foreground_alpha: None,
                background,
                color_background,
                source_mrc: false,
            };
        }
        if let Some(color_background) = color_background.as_mut() {
            background
                .data_mut()
                .par_chunks_mut(gray.width())
                .zip(color_background.data_mut().par_chunks_mut(gray.width() * 3))
                .enumerate()
                .for_each(|(y, (gray_row, color_row))| {
                    for (x, target) in gray_row.iter_mut().enumerate() {
                        if binary.get(x, y) {
                            *target = 255;
                            color_row[x * 3..x * 3 + 3].fill(255);
                        }
                    }
                });
        } else {
            background
                .data_mut()
                .par_chunks_mut(gray.width())
                .enumerate()
                .for_each(|(y, row)| {
                    for (x, target) in row.iter_mut().enumerate() {
                        if binary.get(x, y) {
                            *target = 255;
                        }
                    }
                });
        }
        fill_picture_stencil_knockouts(
            &mut background,
            color_background.as_mut(),
            binary,
            &protected_picture_mask,
            dpi,
        );
        MixedLayers {
            foreground_mask,
            foreground_alpha: None,
            background,
            color_background,
            source_mrc: false,
        }
    });
    Output {
        gray: mixed_gray,
        color: mixed_color,
        mixed_layers: layers,
    }
}

fn fill_picture_stencil_knockouts(
    background: &mut GrayImage,
    mut color_background: Option<&mut RgbImage>,
    stencil: &BinaryImage,
    picture_ownership_mask: &BinaryImage,
    dpi: f64,
) {
    debug_assert_eq!(background.width(), stencil.width());
    debug_assert_eq!(background.height(), stencil.height());
    debug_assert_eq!(background.width(), picture_ownership_mask.width());
    debug_assert_eq!(background.height(), picture_ownership_mask.height());

    let width = background.width();
    let height = background.height();
    if width == 0 || height == 0 {
        return;
    }
    let max_radius = (dpi * 0.5 / 25.4).ceil().clamp(2.0, 16.0) as isize;
    let source_color = color_background.as_deref();
    let source_gray: &GrayImage = background;

    let fills: Vec<(usize, usize, u8, Option<[u8; 3]>)> = (0..height)
        .into_par_iter()
        .flat_map_iter(|y| {
            let mut row_fills = Vec::new();
            for x in 0..width {
                if !stencil.get(x, y) || !picture_ownership_mask.get(x, y) {
                    continue;
                }
                // Soft-alpha composition may deliberately put the original
                // plate pixel back after the foreground pass (notably for
                // chromatic plate detail). Only a white knockout is a hole
                // that needs reconstruction; never replace an already-
                // preserved source tone with the surrounding background
                // average.
                if source_gray.get(x, y) != 255
                    || source_color.is_some_and(|background| background.get(x, y) != [255; 3])
                {
                    continue;
                }

                let mut gray_sum = 0u64;
                let mut color_sum = [0u64; 3];
                let mut samples = 0u64;
                for radius in 1..=max_radius {
                    for dy in -radius..=radius {
                        for dx in -radius..=radius {
                            if dx.abs().max(dy.abs()) != radius {
                                continue;
                            }
                            let sample_x = x as isize + dx;
                            let sample_y = y as isize + dy;
                            if sample_x < 0
                                || sample_y < 0
                                || sample_x >= width as isize
                                || sample_y >= height as isize
                            {
                                continue;
                            }
                            let sample_x = sample_x as usize;
                            let sample_y = sample_y as usize;
                            if !picture_ownership_mask.get(sample_x, sample_y)
                                || stencil.get(sample_x, sample_y)
                            {
                                continue;
                            }
                            gray_sum += u64::from(source_gray.get(sample_x, sample_y));
                            if let Some(source_color) = source_color.as_ref() {
                                let pixel = source_color.get(sample_x, sample_y);
                                for (channel, value) in pixel.into_iter().enumerate() {
                                    color_sum[channel] += u64::from(value);
                                }
                            }
                            samples += 1;
                        }
                    }
                    if samples > 0 {
                        break;
                    }
                }
                if samples == 0 {
                    continue;
                }

                row_fills.push((
                    x,
                    y,
                    ((gray_sum + samples / 2) / samples) as u8,
                    source_color
                        .map(|_| color_sum.map(|sum| ((sum + samples / 2) / samples) as u8)),
                ));
            }
            row_fills
        })
        .collect();

    for (x, y, gray, color) in fills {
        background.set(x, y, gray);
        if let (Some(output_color), Some(color)) = (color_background.as_deref_mut(), color) {
            output_color.set(x, y, color);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn compose_soft_alpha_mixed(
    gray: &GrayImage,
    raw_gray: Option<&GrayImage>,
    color: Option<&RgbImage>,
    binary_fallback: &BinaryImage,
    picture_mask: &BinaryImage,
    chroma_picture_mask: Option<&BinaryImage>,
    removed_edge_bands: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
    preserve_confirmed_photo_tones: bool,
    create_layers: bool,
    create_composite: bool,
) -> (GrayImage, Option<RgbImage>, Option<MixedLayers>) {
    debug_assert_eq!(gray.width(), picture_mask.width());
    debug_assert_eq!(gray.height(), picture_mask.height());
    debug_assert!(
        raw_gray.is_none_or(|raw| raw.width() == gray.width() && raw.height() == gray.height())
    );
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| mask.width() == gray.width() && mask.height() == gray.height()));

    // The normalized raster already expresses the desired black-on-white
    // coverage. Preserve that coverage as opacity in a narrow physical halo
    // around actual binarized ink. Text-vicinity masks are deliberately much
    // broader than glyphs and must not own every faint paper variation inside
    // their rectangles: doing so creates visible block seams and dense alpha
    // planes. The binarized core itself remains authoritative even outside a
    // text rectangle so isolated rules, punctuation, and calibration-like
    // marks cannot disappear merely because the line detector missed them.
    // Conversely, a matching halo around the detected tonal plate remains
    // plate-owned so picture borders and scanner shadows cannot leak into the
    // foreground.
    const TEXT_ALPHA_FLOOR: u8 = 6;
    const MISSED_TEXT_LUMINANCE_CEILING: u8 = 112;
    let ownership_radius = (dpi * 0.18 / 25.4).round().clamp(1.0, 4.0) as usize;
    let ink_seed = text_mask.map_or_else(
        || binary_fallback.clone(),
        |text_mask| binary_fallback.or(text_mask),
    );
    let ink_ownership = dilate(&ink_seed, ownership_radius, ownership_radius);
    let plate_ownership = dilate(picture_mask, ownership_radius, ownership_radius);
    let raw_paper = raw_gray.map(paper_reference);
    let mut foreground_alpha = GrayImage::new(gray.width(), gray.height(), 0);
    foreground_alpha
        .data_mut()
        .par_chunks_mut(gray.width())
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                let owns_binary_core = binary_fallback.get(x, y);
                let trusted_text = text_mask.is_some_and(|mask| mask.get(x, y));
                let chromatic_plate_pixel = chroma_picture_mask.is_some_and(|mask| mask.get(x, y));
                if (plate_ownership.get(x, y)
                    && (chromatic_plate_pixel || (!trusted_text && !owns_binary_core)))
                    || removed_edge_bands.is_some_and(|mask| mask.get(x, y))
                {
                    continue;
                }
                let mut value = gray.get(x, y);
                if owns_binary_core {
                    if let (Some(raw), Some(paper)) = (raw_gray, raw_paper) {
                        value = value.min(normalize_tone_to_paper(raw.get(x, y), paper));
                    }
                }
                let in_text_vicinity = text_vicinity_mask.is_some_and(|mask| mask.get(x, y));
                let vicinity_allows_ink = text_vicinity_mask.is_none() || in_text_vicinity;
                let owns_antialias = ink_ownership.get(x, y) && vicinity_allows_ink;
                let owns_missed_dark_ink =
                    in_text_vicinity && value <= MISSED_TEXT_LUMINANCE_CEILING;
                if !owns_binary_core && !owns_antialias && !owns_missed_dark_ink {
                    continue;
                }
                let alpha = 255u8.saturating_sub(value);
                if alpha >= TEXT_ALPHA_FLOOR {
                    *target = alpha;
                }
            }
        });

    // Use the same plate construction as the bilevel Mixed representation.
    // The foreground encoding must not change which tonal or chromatic pixels
    // survive in the background layer.
    let bilevel_output = run(Input {
        gray,
        raw_gray,
        color,
        binary: binary_fallback,
        picture_mask,
        chroma_picture_mask,
        removed_edge_bands,
        text_mask,
        text_vicinity_mask,
        dpi,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground: false,
        create_layers: true,
        create_composite: false,
    });
    let bilevel_layers = bilevel_output
        .mixed_layers
        .expect("requested mixed background layers");
    let mut background = bilevel_layers.background;
    let mut color_background = bilevel_layers.color_background;
    background
        .data_mut()
        .par_chunks_mut(gray.width())
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                if foreground_alpha.get(x, y) > 0 {
                    *target = 255;
                } else if plate_ownership.get(x, y)
                    && chroma_picture_mask.is_some_and(|mask| mask.get(x, y))
                {
                    *target = gray.get(x, y);
                }
            }
        });
    if let (Some(source), Some(background)) = (color, color_background.as_mut()) {
        background
            .data_mut()
            .par_chunks_mut(gray.width() * 3)
            .enumerate()
            .for_each(|(y, row)| {
                for (x, target) in row.chunks_exact_mut(3).enumerate() {
                    if foreground_alpha.get(x, y) > 0 {
                        target.fill(255);
                    } else if plate_ownership.get(x, y)
                        && chroma_picture_mask.is_some_and(|mask| mask.get(x, y))
                    {
                        target.copy_from_slice(&source.get(x, y));
                    }
                }
            });
    }
    fill_picture_stencil_knockouts(
        &mut background,
        color_background.as_mut(),
        binary_fallback,
        &plate_ownership,
        dpi,
    );

    if create_composite {
        let mut composite = background.clone();
        composite
            .data_mut()
            .par_chunks_mut(gray.width())
            .enumerate()
            .for_each(|(y, row)| {
                for (x, target) in row.iter_mut().enumerate() {
                    let alpha = foreground_alpha.get(x, y);
                    if alpha > 0 {
                        *target = 255 - alpha;
                    }
                }
            });
        let composite_color = color_background.as_ref().map(|background| {
            let mut output = background.clone();
            output
                .data_mut()
                .par_chunks_mut(gray.width() * 3)
                .enumerate()
                .for_each(|(y, row)| {
                    for (x, target) in row.chunks_exact_mut(3).enumerate() {
                        let alpha = foreground_alpha.get(x, y);
                        let value = 255 - alpha;
                        if value < 255 {
                            target.fill(value);
                        }
                    }
                });
            output
        });
        let layers = create_layers.then(|| MixedLayers {
            foreground_mask: binary_fallback.clone(),
            foreground_alpha: Some(foreground_alpha),
            background,
            color_background,
            source_mrc: false,
        });
        (composite, composite_color, layers)
    } else {
        let layers = create_layers.then(|| MixedLayers {
            foreground_mask: binary_fallback.clone(),
            foreground_alpha: Some(foreground_alpha),
            background,
            color_background,
            source_mrc: false,
        });
        let layer_background = layers
            .as_ref()
            .map_or_else(|| gray.clone(), |layers| layers.background.clone());
        let layer_color = layers
            .as_ref()
            .and_then(|layers| layers.color_background.clone());
        (layer_background, layer_color, layers)
    }
}

#[cfg(test)]
#[path = "final_composition_tests.rs"]
mod tests;
