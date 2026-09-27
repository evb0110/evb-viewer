use scan_primitives::{
    morphology::{close, dilate, dilate_gray, erode_gray, open, reconstruct_binary},
    threshold::{threshold_local, LocalThreshold},
    BinaryImage, Component, ComponentMap, GrayImage,
};
use std::collections::VecDeque;

fn fill_enclosed_holes(mask: &BinaryImage) -> BinaryImage {
    if mask.width() == 0 || mask.height() == 0 {
        return mask.clone();
    }
    let mut exterior = vec![false; mask.width().saturating_mul(mask.height())];
    let mut queue = VecDeque::new();
    let enqueue =
        |x: usize, y: usize, exterior: &mut [bool], queue: &mut VecDeque<(usize, usize)>| {
            let index = y * mask.width() + x;
            if !mask.get(x, y) && !exterior[index] {
                exterior[index] = true;
                queue.push_back((x, y));
            }
        };
    for x in 0..mask.width() {
        enqueue(x, 0, &mut exterior, &mut queue);
        enqueue(x, mask.height() - 1, &mut exterior, &mut queue);
    }
    for y in 0..mask.height() {
        enqueue(0, y, &mut exterior, &mut queue);
        enqueue(mask.width() - 1, y, &mut exterior, &mut queue);
    }
    while let Some((x, y)) = queue.pop_front() {
        if x > 0 {
            enqueue(x - 1, y, &mut exterior, &mut queue);
        }
        if x + 1 < mask.width() {
            enqueue(x + 1, y, &mut exterior, &mut queue);
        }
        if y > 0 {
            enqueue(x, y - 1, &mut exterior, &mut queue);
        }
        if y + 1 < mask.height() {
            enqueue(x, y + 1, &mut exterior, &mut queue);
        }
    }
    BinaryImage::from_fn_parallel(mask.width(), mask.height(), |x, y| {
        mask.get(x, y) || !exterior[y * mask.width() + x]
    })
}

fn reduce_rank4(mask: &BinaryImage) -> BinaryImage {
    let width = mask.width().div_ceil(2);
    let height = mask.height().div_ceil(2);
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        let source_x = x * 2;
        let source_y = y * 2;
        source_x + 1 < mask.width()
            && source_y + 1 < mask.height()
            && mask.get(source_x, source_y)
            && mask.get(source_x + 1, source_y)
            && mask.get(source_x, source_y + 1)
            && mask.get(source_x + 1, source_y + 1)
    })
}

fn expand_replicate(mask: &BinaryImage, width: usize, height: usize, factor: usize) -> BinaryImage {
    if mask.width() == 0 || mask.height() == 0 {
        return BinaryImage::new(width, height);
    }
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        mask.get(
            (x / factor).min(mask.width() - 1),
            (y / factor).min(mask.height() - 1),
        )
    })
}

fn luminance_percentile(image: &GrayImage, numerator: usize, denominator: usize) -> u8 {
    debug_assert!(denominator > 0 && numerator <= denominator);
    let mut histogram = [0usize; 256];
    for &sample in image.data() {
        histogram[usize::from(sample)] += 1;
    }
    let target = image
        .data()
        .len()
        .saturating_sub(1)
        .saturating_mul(numerator)
        / denominator;
    let mut cumulative = 0usize;
    histogram
        .iter()
        .position(|count| {
            cumulative += count;
            cumulative > target
        })
        .unwrap_or(255) as u8
}

/// Completes an accepted photo zone across a dark glossy continuation.
///
/// Glossy black relief can be too edge-dense for the normal seed cascade even
/// when it is the lower part of a photograph that already earned a zone. Only
/// compact dark masses that are physically close to an accepted zone are
/// eligible here; thin rules and text never acquire the minimum two-dimensional
/// span or density. Reconstruction still uses the existing Wolf substrate and
/// its physical halo, so the completion adds the subject's recoverable tone
/// rather than changing the calibrated region verdict.
fn complete_adjacent_dark_zones(
    gray: &GrayImage,
    accepted: &BinaryImage,
    binary: &BinaryImage,
    closed: &BinaryImage,
    dpi: f64,
) -> BinaryImage {
    if accepted.count_black() == 0 {
        return accepted.clone();
    }

    // The producer's coarse background averages a glossy black base into the
    // lower midtones, so its near-black evidence is just below this ceiling.
    // This is still below the paper core; density, span, grouping, and the
    // accepted-zone corridor jointly narrow the completion rule.
    let dark_ceiling = luminance_percentile(gray, 3, 4).saturating_sub(8);
    let recovery_radius = (dpi * 3.0 / 25.4).round().clamp(4.0, 64.0) as usize;
    let completion_context = dilate(accepted, recovery_radius, recovery_radius);
    let dark_candidates = BinaryImage::from_fn_parallel(gray.width(), gray.height(), |x, y| {
        gray.get(x, y) <= dark_ceiling && completion_context.get(x, y)
    });
    let density_radius = (dpi * 2.0 / 25.4).round().clamp(2.0, 16.0) as usize;
    let dense_dark = filter_dense_regions(&dark_candidates, density_radius, 1, 3);
    if dense_dark.count_black() == 0 {
        return accepted.clone();
    }

    let grouping_radius = (dpi * 1.0 / 25.4).round().clamp(1.0, 16.0) as usize;
    // Group the complete dark footprint, not only its dense interior. The
    // lower rim of a glossy foot is often a sparse near-black contour; the
    // dense field remains the compactness guard while the raw footprint gives
    // reconstruction the width profile that continues below the plate.
    let grouped =
        ComponentMap::from_binary(&dilate(&dark_candidates, grouping_radius, grouping_radius));
    let minimum_span = (dpi * 3.0 / 25.4).round().max(8.0) as usize;
    let adjacency_radius = (dpi * 1.5 / 25.4).round().clamp(2.0, 32.0) as usize;
    let accepted_halo = dilate(accepted, adjacency_radius, adjacency_radius);
    let component_count = grouped.components().len();
    let mut dark_counts = vec![0usize; component_count + 1];
    let mut dense_counts = vec![0usize; component_count + 1];
    let mut dark_bounds = vec![None::<(usize, usize, usize, usize)>; component_count + 1];
    let mut touches_accepted = vec![false; component_count + 1];
    let mut profile_min_width = vec![usize::MAX; component_count + 1];
    let mut profile_max_width = vec![0usize; component_count + 1];
    let mut row_left = vec![usize::MAX; component_count + 1];
    let mut row_right = vec![0usize; component_count + 1];
    let mut row_labels = Vec::new();
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            if !dark_candidates.get(x, y) {
                continue;
            }
            let label = grouped.label_at(x, y) as usize;
            if label == 0 {
                continue;
            }
            dark_counts[label] += 1;
            dark_bounds[label] = Some(
                dark_bounds[label].map_or((x, y, x, y), |(left, top, right, bottom)| {
                    (left.min(x), top.min(y), right.max(x), bottom.max(y))
                }),
            );
            if dense_dark.get(x, y) {
                dense_counts[label] += 1;
            }
            if accepted_halo.get(x, y) {
                touches_accepted[label] = true;
            }
            if row_left[label] == usize::MAX {
                row_labels.push(label);
            }
            row_left[label] = row_left[label].min(x);
            row_right[label] = row_right[label].max(x);
        }
        for label in row_labels.drain(..) {
            let width = row_right[label] - row_left[label] + 1;
            profile_min_width[label] = profile_min_width[label].min(width);
            profile_max_width[label] = profile_max_width[label].max(width);
            row_left[label] = usize::MAX;
            row_right[label] = 0;
        }
    }

    let mut absorb = vec![false; component_count + 1];
    for component in grouped.components() {
        let label = component.label as usize;
        let Some((left, top, right, bottom)) = dark_bounds[label] else {
            continue;
        };
        let width = right - left + 1;
        let height = bottom - top + 1;
        let area = width.saturating_mul(height);
        // A component's grouped bbox includes the physical joining halo; use
        // the unexpanded dark bbox for compactness so a sparse line cannot
        // pass merely because its dilation is long.
        let compact = dense_counts[label].saturating_mul(10) >= area;
        // A dark rule can be both dense and adjacent to a photo. A real
        // three-dimensional foot changes width as it descends; requiring a
        // modest row-profile change keeps a constant-width rule out without
        // requiring texture or an absolute luminance value.
        let profile_varies = profile_min_width[label] != usize::MAX
            && profile_min_width[label].saturating_mul(5)
                <= profile_max_width[label].saturating_mul(4);
        if width >= minimum_span
            && height >= minimum_span
            && compact
            && profile_varies
            && touches_accepted[label]
        {
            absorb[label] = true;
        }
    }
    if !absorb.iter().any(|&value| value) {
        return accepted.clone();
    }

    let completion_seed = BinaryImage::from_fn_parallel(gray.width(), gray.height(), |x, y| {
        let label = grouped.label_at(x, y) as usize;
        label > 0 && absorb[label] && dark_candidates.get(x, y)
    });
    let recovery_zone = dilate(&completion_seed, recovery_radius, recovery_radius);
    let recovery_mask = binary.or(closed).or(&completion_seed).and(&recovery_zone);
    let recovered = fill_enclosed_holes(&reconstruct_binary(&completion_seed, &recovery_mask));
    accepted.or(&recovered)
}

pub(crate) fn derive_halftone_zones(gray: &GrayImage, dpi: f64) -> BinaryImage {
    if gray.width() == 0 || gray.height() == 0 {
        return BinaryImage::new(gray.width(), gray.height());
    }
    let binary = threshold_local(
        gray,
        25,
        LocalThreshold::Wolf {
            k: 0.5,
            deviation_floor: 3.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        },
    );
    let reduced = reduce_rank4(&reduce_rank4(&binary));
    let mass_seed = expand_replicate(&open(&reduced, 2, 2), gray.width(), gray.height(), 4);
    // A photograph at analysis scale offers one of two signals: dense dark
    // MASS (shadows, printed halftone) that survives the rank cascade, or
    // smooth MID-GRAY fields (skin, stone, sky) that binarize to nothing.
    // Text and line art offer neither — type is paper-and-ink, hatching is
    // edge, not field. Seed from both signals; the verdict below rejects
    // whatever line art sneaks through on mass alone. Bold type survives
    // the cascade only as isolated pellets, which the smoothness-free
    // 2 mm density test cannot turn into fields, and whose tight tonal
    // concentration the spread verdict rejects.
    // Both radii are physical, not pixel, quantities. The classifier runs on
    // the bounded analysis raster (currently at most 150 dpi), so the clamps
    // keep the calibrated 1 px blur / 3 px texture windows stable at that
    // ceiling and on lower-DPI inputs. The final render is not a second
    // halftone-classification scale.
    let texture_radius = (dpi * 0.45 / 25.4).round().clamp(1.0, 8.0) as usize;
    let blur_radius = (dpi * 0.12 / 25.4).round().clamp(1.0, 4.0) as usize;
    // Edge statistics run on a lightly blurred plane: halftone dots are
    // finer than pen strokes, so a one-stroke-width mean filter collapses a
    // printed photograph's dot micro-contrast while hatching and engraved
    // lines keep theirs.
    let blurred = box_mean_gray(gray, blur_radius);
    let local_max = erode_gray(&blurred, texture_radius, texture_radius);
    let local_min = dilate_gray(&blurred, texture_radius, texture_radius);
    let paper_reference = luminance_percentile(gray, 3, 4);
    // The ceiling sits at genuine-tone depth: verso show-through is
    // attenuated by the paper and stays within ~45 of the paper shade, so
    // it must never seed a smooth field, or its page-wide tiles chain
    // every cluster together.
    let smooth_ceiling = paper_reference.saturating_sub(45);
    // Depth below the show-through ceiling is itself the seed evidence; a
    // flatness test here would reject the very fields this seed exists for.
    // A photographic reproduction of a textured subject (stone, fabric,
    // relief) is mottled at stroke scale — never locally flat — while its
    // tone runs deeper than paper attenuation physically allows verso bleed
    // to reach. Type is also deep but never 1/3-dense over a 2 mm disc, and
    // whatever bold blocks pass the density test concentrate at the ink
    // core, which the spread verdict rejects.
    // Strong-edge pixels are excluded with the same threshold the edge
    // verdict uses: a glyph at analysis scale is nothing but strong edges,
    // and admitting glyph ink as depth evidence lets a photo's cluster
    // reconstruct across its caption into the text column, where typeset
    // labels then misclassify the merged region as a map. Photo mottle
    // stays below this gradient almost everywhere, so photos keep seeding.
    let smooth_candidates = BinaryImage::from_fn_parallel(gray.width(), gray.height(), |x, y| {
        let value = gray.get(x, y);
        value > 8
            && value < smooth_ceiling
            && local_max.get(x, y).saturating_sub(local_min.get(x, y)) < 48
    });
    let density_radius = (dpi * 2.0 / 25.4).round().clamp(2.0, 16.0) as usize;
    let smooth_seed = filter_dense_regions(&smooth_candidates, density_radius, 1, 3);
    let seed = mass_seed.or(&smooth_seed);
    // Reconstruction recovers the photo's bright remainder through the
    // closed binary, but each seed CLUSTER grows inside its own clipped
    // neighborhood and is judged alone: a photograph two text lines away
    // from a show-through field must not share a verdict with it, and a
    // chain of incidental bridges must never merge a picture with a text
    // column before the tonal tests run.
    // Depth seeds cover a photograph densely, so the recovery halo only
    // needs to bridge highlight gaps, not span the whole subject the way
    // the old sparse flat-field seeds required. A tight halo matters: body
    // text starts 3-4 mm below a plate, and a wider halo lets the closed
    // binary flood the region across that gap, after which the absorbed
    // words read as typeset labels and the map rule binarizes the photo.
    // Enclosed highlights are recovered by the hole fill below instead.
    let growth_radius = (dpi * 3.0 / 25.4).round().clamp(4.0, 64.0) as usize;
    let cluster_radius = (dpi * 2.0 / 25.4).round().clamp(2.0, 24.0) as usize;
    let closed = close(&binary, 4, 4);
    let clusters = ComponentMap::from_binary(&dilate(&seed, cluster_radius, cluster_radius));
    let cluster_count = clusters.components().len();
    let minimum_span = (dpi * 12.0 / 25.4).round().max(8.0) as usize;
    let mut candidates = BinaryImage::new(gray.width(), gray.height());
    for cluster_index in 0..cluster_count {
        let cluster = &clusters.components()[cluster_index];
        let span_x = cluster.right - cluster.left + 1;
        let span_y = cluster.bottom - cluster.top + 1;
        if span_x < minimum_span || span_y < minimum_span {
            continue;
        }
        let Some((left, top, region)) =
            reconstruct_cluster_region(&seed, &closed, &clusters, cluster, growth_radius)
        else {
            continue;
        };
        for y in 0..region.height() {
            for x in 0..region.width() {
                if region.get(x, y) {
                    candidates.set(left + x, top + y, true);
                }
            }
        }
    }
    let sized = ComponentMap::from_binary(&candidates).retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        width >= minimum_span && height >= minimum_span
    });
    let candidates = fill_enclosed_holes(&sized);
    // Two verdicts separate photographs from line art that also carries
    // mass or smooth fields. SPREAD: a photograph's tones scatter away
    // from both the ink core and the paper core; line art concentrates at
    // both. EDGE DENSITY: hatching, engraving and type are made of strokes
    // — a large share of their pixels sit on strong local gradients —
    // while photographic fields are smooth almost everywhere.
    let paper_core_floor = paper_reference.saturating_sub(20);
    let regions = ComponentMap::from_binary(&candidates);
    let mut histograms = vec![[0usize; 256]; regions.components().len() + 1];
    let mut edge_counts = vec![0usize; regions.components().len() + 1];
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            let label = regions.label_at(x, y) as usize;
            if label > 0 {
                histograms[label][usize::from(gray.get(x, y))] += 1;
                if local_max.get(x, y).saturating_sub(local_min.get(x, y)) >= 48 {
                    edge_counts[label] += 1;
                }
            }
        }
    }
    let accepted = regions.retain(|component| {
        let histogram = &histograms[component.label as usize];
        let total: usize = histogram.iter().sum();
        if total == 0 {
            return false;
        }
        let mut cumulative = 0usize;
        let ink_reference = histogram
            .iter()
            .position(|&count| {
                cumulative += count;
                cumulative * 10 > total
            })
            .unwrap_or(0) as u8;
        let ink_core_ceiling = ink_reference.saturating_add(20);
        let spread: usize = histogram
            .iter()
            .enumerate()
            .filter(|&(value, _)| {
                value > usize::from(ink_core_ceiling) && value < usize::from(paper_core_floor)
            })
            .map(|(_, &count)| count)
            .sum();
        let spread_fraction = spread as f64 / total as f64;
        let edge_fraction = edge_counts[component.label as usize] as f64 / total as f64;
        // Two-tier verdict: strong tonal spread tolerates stroke texture
        // (busy halftone prints), while marginal spread must be smooth —
        // that is what separates a dark relief photograph from a line
        // diagram whose spread is identical.
        if spread_fraction >= 0.30 {
            edge_fraction < 0.55
        } else {
            spread_fraction >= 0.18 && edge_fraction < 0.30
        }
    });
    complete_adjacent_dark_zones(gray, &accepted, &binary, &closed, dpi)
}

fn box_mean_gray(image: &GrayImage, radius: usize) -> GrayImage {
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return image.clone();
    }
    let mut integral = vec![0u64; (width + 1) * (height + 1)];
    for y in 0..height {
        let mut row_sum = 0u64;
        for x in 0..width {
            row_sum += u64::from(image.get(x, y));
            integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row_sum;
        }
    }
    // Every visible output sample is overwritten below. Avoid copying the
    // complete source raster (and any hidden stride padding) before doing so.
    let mut output = GrayImage::new(width, height, 0);
    for y in 0..height {
        for x in 0..width {
            let left = x.saturating_sub(radius);
            let top = y.saturating_sub(radius);
            let right = (x + radius + 1).min(width);
            let bottom = (y + radius + 1).min(height);
            let sum = integral[bottom * (width + 1) + right] + integral[top * (width + 1) + left]
                - integral[top * (width + 1) + right]
                - integral[bottom * (width + 1) + left];
            let window = ((right - left) * (bottom - top)) as u64;
            output.set(x, y, (sum / window.max(1)) as u8);
        }
    }
    output
}

/// Reconstruct one seed component inside the only area where its growth can
/// reach. `clusters` is the component map of a dilated seed, so every seed
/// pixel carrying `cluster.label` lies inside the component bounds. Expanding
/// those bounds by the growth radius is therefore sufficient to reproduce the
/// full-page dilation and reconstruction, including clipping at page edges.
fn reconstruct_cluster_region(
    seed: &BinaryImage,
    closed: &BinaryImage,
    clusters: &ComponentMap,
    cluster: &Component,
    growth_radius: usize,
) -> Option<(usize, usize, BinaryImage)> {
    let left = cluster.left.saturating_sub(growth_radius);
    let top = cluster.top.saturating_sub(growth_radius);
    let right = cluster
        .right
        .saturating_add(growth_radius)
        .saturating_add(1)
        .min(seed.width());
    let bottom = cluster
        .bottom
        .saturating_add(growth_radius)
        .saturating_add(1)
        .min(seed.height());
    let width = right.saturating_sub(left);
    let height = bottom.saturating_sub(top);
    if width == 0 || height == 0 {
        return None;
    }

    let cluster_seed = BinaryImage::from_fn_parallel(width, height, |x, y| {
        let source_x = left + x;
        let source_y = top + y;
        seed.get(source_x, source_y) && clusters.label_at(source_x, source_y) == cluster.label
    });
    let growth_zone = dilate(&cluster_seed, growth_radius, growth_radius);
    // Seed pixels are direct tone evidence and belong in the recovery
    // substrate: a low-contrast photograph barely registers under Wolf, so
    // reconstructing only through the binarized plane would shrink its region
    // to the few strokes Wolf happened to mark.
    let clipped_mask = BinaryImage::from_fn_parallel(width, height, |x, y| {
        let source_x = left + x;
        let source_y = top + y;
        (closed.get(source_x, source_y) || seed.get(source_x, source_y)) && growth_zone.get(x, y)
    });
    Some((left, top, reconstruct_binary(&cluster_seed, &clipped_mask)))
}

/// Keeps mask pixels whose 2-D neighborhood is at least a third occupied by
/// the mask; isolated marks and thin strokes fall below the ratio.
fn filter_dense_regions(
    mask: &BinaryImage,
    radius: usize,
    numerator: u64,
    denominator: u64,
) -> BinaryImage {
    let width = mask.width();
    let height = mask.height();
    if width == 0 || height == 0 {
        return mask.clone();
    }
    let mut integral = vec![0u64; (width + 1) * (height + 1)];
    for y in 0..height {
        let mut row_sum = 0u64;
        for x in 0..width {
            row_sum += u64::from(mask.get(x, y));
            integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row_sum;
        }
    }
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        if !mask.get(x, y) {
            return false;
        }
        let left = x.saturating_sub(radius);
        let top = y.saturating_sub(radius);
        let right = (x + radius + 1).min(width);
        let bottom = (y + radius + 1).min(height);
        let count = integral[bottom * (width + 1) + right] + integral[top * (width + 1) + left]
            - integral[top * (width + 1) + right]
            - integral[bottom * (width + 1) + left];
        let window = ((right - left) * (bottom - top)) as u64;
        count.saturating_mul(denominator) >= window.saturating_mul(numerator)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_dark_mass_adjacent_to_a_photo_zone_is_completed() {
        let mut gray = GrayImage::new(240, 240, 255);
        let mut accepted = BinaryImage::new(240, 240);
        let mut binary = BinaryImage::new(240, 240);
        for y in 32..112 {
            for x in 64..176 {
                accepted.set(x, y, true);
            }
        }
        for y in 112..130 {
            let inset = (y - 112).min(8);
            for x in 80 + inset..160 - inset {
                gray.set(x, y, 16 + ((x + y) % 20) as u8);
                binary.set(x, y, true);
            }
        }
        let completed = complete_adjacent_dark_zones(&gray, &accepted, &binary, &binary, 150.0);
        assert!(completed.get(120, 120));
        assert!(!completed.get(120, 144));
        assert!(!completed.get(32, 144));
    }

    #[test]
    fn thin_dark_rule_adjacent_to_a_photo_zone_is_not_completed() {
        let mut gray = GrayImage::new(240, 240, 255);
        let mut accepted = BinaryImage::new(240, 240);
        let mut binary = BinaryImage::new(240, 240);
        for y in 32..112 {
            for x in 64..176 {
                accepted.set(x, y, true);
            }
        }
        for x in 64..176 {
            gray.set(x, 112, 16);
            binary.set(x, 112, true);
        }
        let completed = complete_adjacent_dark_zones(&gray, &accepted, &binary, &binary, 150.0);
        assert_eq!(completed, accepted);
    }

    #[test]
    fn constant_width_dark_rule_adjacent_to_a_photo_is_not_completed() {
        let mut gray = GrayImage::new(240, 240, 255);
        let mut accepted = BinaryImage::new(240, 240);
        let mut binary = BinaryImage::new(240, 240);
        for y in 32..112 {
            for x in 64..176 {
                accepted.set(x, y, true);
            }
        }
        for y in 112..132 {
            for x in 64..176 {
                gray.set(x, y, 16);
                binary.set(x, y, true);
            }
        }
        let completed = complete_adjacent_dark_zones(&gray, &accepted, &binary, &binary, 150.0);
        assert_eq!(completed, accepted);
    }

    #[test]
    fn dense_random_photo_texture_survives_as_a_zone() {
        // A photograph at analysis scale: contiguous shadow masses beside
        // midtone fields, not a uniform ink slab and not per-pixel noise.
        let mut image = GrayImage::new(320, 320, 255);
        for y in 48..272 {
            for x in 48..272 {
                let cell = (x / 24 + y / 24) % 2 == 0;
                let value = if cell {
                    30 + ((x * 37 + y * 61) % 24) as u8
                } else {
                    120 + ((x * 13 + y * 41) % 48) as u8
                };
                image.set(x, y, value);
            }
        }
        let zones = derive_halftone_zones(&image, 150.0);
        assert!(zones.get(160, 160));
        assert!(!zones.get(20, 20));
    }

    #[test]
    fn one_pixel_hatching_does_not_seed_a_zone() {
        let mut image = GrayImage::new(320, 320, 255);
        for y in (48..272).step_by(4) {
            for x in 48..272 {
                image.set(x, y, 20);
            }
        }
        for x in (48..272).step_by(4) {
            for y in 48..272 {
                image.set(x, y, 20);
            }
        }
        assert_eq!(derive_halftone_zones(&image, 150.0).count_black(), 0);
    }

    #[test]
    fn text_lines_do_not_seed_a_zone() {
        let mut image = GrayImage::new(320, 320, 255);
        for y in (48..272).step_by(9) {
            for x in 48..272 {
                image.set(x, y, 20);
            }
        }
        assert_eq!(derive_halftone_zones(&image, 150.0).count_black(), 0);
    }

    #[test]
    fn hole_fill_keeps_a_bright_photo_interior() {
        let mut image = GrayImage::new(320, 320, 255);
        for y in 48..272 {
            for x in 48..272 {
                if !(112..208).contains(&x) || !(112..208).contains(&y) {
                    let cell = (x / 24 + y / 24) % 2 == 0;
                    let value = if cell {
                        30 + ((x * 37 + y * 61) % 24) as u8
                    } else {
                        120 + ((x * 13 + y * 41) % 48) as u8
                    };
                    image.set(x, y, value);
                }
            }
        }
        let zones = derive_halftone_zones(&image, 150.0);
        assert!(zones.get(160, 160));
        assert!(!zones.get(20, 20));
    }

    #[test]
    fn cluster_local_reconstruction_matches_full_page_reference_at_edges() {
        let width = 96;
        let height = 72;
        let growth_radius = 7;
        let cluster_radius = 2;
        let mut seed = BinaryImage::new(width, height);
        for y in 2..14 {
            for x in 3..18 {
                seed.set(x, y, (x + y) % 4 != 0);
            }
        }
        for y in 50..66 {
            for x in 76..94 {
                seed.set(x, y, (x * 3 + y) % 5 != 0);
            }
        }
        let clusters = ComponentMap::from_binary(&dilate(&seed, cluster_radius, cluster_radius));
        let mut closed = BinaryImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let near_first = x < 26 && y < 22;
                let near_second = x > 68 && y > 42;
                closed.set(x, y, near_first || near_second || (x + y) % 29 == 0);
            }
        }

        let mut expected = BinaryImage::new(width, height);
        let mut actual = BinaryImage::new(width, height);
        for cluster in clusters.components() {
            let label = cluster.label;
            let full_seed = BinaryImage::from_fn_parallel(width, height, |x, y| {
                seed.get(x, y) && clusters.label_at(x, y) == label
            });
            let full_growth = dilate(&full_seed, growth_radius, growth_radius);
            let full_mask = BinaryImage::from_fn_parallel(width, height, |x, y| {
                (closed.get(x, y) || seed.get(x, y)) && full_growth.get(x, y)
            });
            let full_region = reconstruct_binary(&full_seed, &full_mask);
            expected = expected.or(&full_region);

            let Some((left, top, local_region)) =
                reconstruct_cluster_region(&seed, &closed, &clusters, cluster, growth_radius)
            else {
                panic!("non-empty cluster produced no local region");
            };
            for y in 0..local_region.height() {
                for x in 0..local_region.width() {
                    if local_region.get(x, y) {
                        actual.set(left + x, top + y, true);
                    }
                }
            }
        }
        assert_eq!(actual, expected);
    }

    #[test]
    fn box_mean_gray_writes_a_tight_visible_output_for_padded_input() {
        let width = 9;
        let height = 7;
        let mut image = GrayImage::with_stride(width, height, width + 5, 3);
        for y in 0..height {
            for x in 0..width {
                image.set(x, y, (x * 11 + y * 17) as u8);
            }
        }
        let output = box_mean_gray(&image, 1);
        assert_eq!(output.stride(), width);
        for y in 0..height {
            for x in 0..width {
                let left = x.saturating_sub(1);
                let top = y.saturating_sub(1);
                let right = (x + 2).min(width);
                let bottom = (y + 2).min(height);
                let mut sum = 0u64;
                for sample_y in top..bottom {
                    for sample_x in left..right {
                        sum += u64::from(image.get(sample_x, sample_y));
                    }
                }
                let count = ((right - left) * (bottom - top)) as u64;
                assert_eq!(output.get(x, y), (sum / count) as u8);
            }
        }
    }

    /// Developer diagnostic: run the halftone classifier on an external image.
    /// `EVB_HALFTONE_IMAGE=/path.png
    /// cargo test -p evb-scan-cleanup dump_halftone_zones -- --ignored --nocapture`
    #[test]
    #[ignore = "requires EVB_HALFTONE_IMAGE"]
    fn dump_halftone_zones() {
        let path = std::env::var("EVB_HALFTONE_IMAGE").unwrap();
        let image =
            crate::io::raster::read_image(std::path::Path::new(&path), 40_000_000, 10_000).unwrap();
        let dpi = std::env::var("EVB_HALFTONE_DPI")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(150.0);
        let zones = derive_halftone_zones(&image.gray, dpi);
        eprintln!("halftone zone pixels: {}", zones.count_black());
    }
}
