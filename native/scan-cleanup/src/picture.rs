use crate::{
    calibration::PageCalibration, content::is_scanner_border_shadow, CleanupOptions,
    NormalizedZonePolygon, PictureZoneLayer,
};
use rayon::prelude::*;
use scan_primitives::{
    distance::squared_euclidean_distance,
    morphology::{
        close, dilate, dilate_gray, erode_gray, fill_gray_holes, open, reconstruct_gray_by_erosion,
    },
    threshold::{
        mokji_threshold, otsu_threshold, threshold_global, DEFAULT_MOKJI_MAX_EDGE_WIDTH,
        DEFAULT_MOKJI_MIN_EDGE_MAGNITUDE,
    },
    BinaryImage, ComponentMap, GrayImage,
};

const DETECTOR_DPI: f64 = 300.0;
const CONTRAST_TAIL_FRACTION: f64 = 0.01;
const MIN_TEXT_COMPONENTS_FOR_VETO: usize = 8;
const DENSE_RECTANGLE_MINIMUM_OCCUPANCY: f64 = 0.82;
const DENSE_RECTANGLE_MINIMUM_PAGE_FRACTION: f64 = 0.02;
const DENSE_RECTANGLE_MINIMUM_SPAN_FRACTION: f64 = 0.12;
const CONTINUOUS_TONE_TILE_INCHES: f64 = 0.20;
const CONTINUOUS_TONE_MINIMUM_ROBUST_RANGE: u8 = 24;
const CONTINUOUS_TONE_MINIMUM_MIDDLE_FRACTION: f64 = 0.12;
const CONTINUOUS_TONE_MAXIMUM_NOISE_MODE_FRACTION: f64 = 0.55;
const CONTINUOUS_TONE_MAXIMUM_BILEVEL_VARIANCE_FRACTION: f64 = 0.90;
const CONTINUOUS_TONE_MINIMUM_COMPONENT_PAGE_FRACTION: f64 = 0.005;
const SCREENED_TONE_MINIMUM_TILE_COMPONENTS: usize = 8;
const SCREENED_TONE_MINIMUM_COMPONENT_TILES: usize = 4;
const TONE_PRESERVATION_MINIMUM_COMPONENT_PAGE_FRACTION: f64 = 0.0005;
const TONE_PRESERVATION_MINIMUM_COMPONENT_SPAN_FRACTION: f64 = 0.01;
const TONE_PRESERVATION_FEATHER_RADIUS: usize = 4;
const PHOTO_RECTANGLE_MINIMUM_TONE_MATCH_FRACTION: f64 = 0.85;
const PHOTO_RECTANGLE_MINIMUM_BOUNDARY_MATCH_FRACTION: f64 = 0.70;
const PICTURE_OWNER_MIN_COMPONENT_PIXELS: usize = 1_024;
const BORDER_INK_LUMINANCE_CUTOFF: u8 = 160;
// The raw darkness and texture fields are already normalized against the
// page's measured paper center and noise. Their shallow tail represents paper
// shoulders and fit residuals, not material picture evidence. Removing that
// tail prevents a generous detector rectangle from restoring gray paper while
// keeping fully supported photo/ink pixels at exact source weight.
const TONE_PRESERVATION_MATERIAL_ALPHA_FLOOR: u8 = 96;

/// Detects continuous-tone picture regions. `true` pixels belong to pictures.
#[cfg(test)]
pub(crate) fn detect_picture_mask(
    source: &GrayImage,
    raster_dpi: f64,
    calibration: PageCalibration,
) -> BinaryImage {
    let continuous_tone = detect_continuous_tone_mask(source, raster_dpi);
    detect_picture_mask_with_continuous_tone(source, raster_dpi, calibration, &continuous_tone)
}

/// Detects continuous-tone picture regions while reusing tone evidence that
/// the render pipeline also needs for semantic preservation.
pub(crate) fn detect_picture_mask_with_continuous_tone(
    source: &GrayImage,
    raster_dpi: f64,
    calibration: PageCalibration,
    continuous_tone: &BinaryImage,
) -> BinaryImage {
    if source.width() == 0 || source.height() == 0 {
        return BinaryImage::new(source.width(), source.height());
    }
    debug_assert_eq!(continuous_tone.width(), source.width());
    debug_assert_eq!(continuous_tone.height(), source.height());
    let scale = (raster_dpi / DETECTOR_DPI).clamp(0.25, 8.0);
    let small_radius = (1.0 * scale).round().max(1.0) as usize;
    let marker_radius = (17.0 * scale).round().max(1.0) as usize;
    let edge_width = (DEFAULT_MOKJI_MAX_EDGE_WIDTH as f64 * scale)
        .round()
        .max(1.0) as usize;

    let stretched = stretch_contrast(source, CONTRAST_TAIL_FRACTION);
    let eroded = erode_gray(&stretched, small_radius, small_radius);
    let dilated = dilate_gray(&stretched, small_radius, small_radius);
    let mut contrast = GrayImage::new(source.width(), source.height(), 255);
    contrast
        .data_mut()
        .par_iter_mut()
        .zip(eroded.data().par_iter())
        .zip(dilated.data().par_iter())
        .for_each(|((target, &erosion), &dilation)| {
            let erosion = u16::from(erosion);
            let dilation = u16::from(dilation);
            let value = 255 - (255 - dilation) * erosion / 255;
            *target = value as u8;
        });
    let marker = erode_gray(&contrast, marker_radius, marker_radius);
    let reconstructed = reconstruct_gray_by_erosion(&marker, &contrast);
    let mut inverted = reconstructed;
    inverted
        .data_mut()
        .par_iter_mut()
        .for_each(|value| *value = 255 - *value);
    let filled = fill_gray_holes(&inverted);
    let threshold = mokji_threshold(&filled, edge_width, DEFAULT_MOKJI_MIN_EDGE_MAGNITUDE);
    let candidate = threshold_global(&filled, threshold).invert();
    let candidate = complete_dense_picture_rectangles(candidate);
    let candidate = veto_text_like_regions(source, candidate, raster_dpi, calibration);
    // Morphological picture evidence alone is deliberately generous and can
    // turn repeated antialiased words on dark or shaded paper into a chain of
    // word-sized "photos". Raw-source restoration is only appropriate when a
    // candidate component is also backed by a distributed local tone
    // histogram. Maps and line art that lack such evidence are handled by the
    // separate semantic-tone field and therefore remain illumination
    // corrected instead of reintroducing the scan's paper shade.
    // Grow from a detector candidate into the continuous-tone field, then
    // apply the artifact/size gate to that union. Qualifying the raw tone
    // field by itself would promote fold shade and show-through; retaining
    // only the candidate would split a photograph at the detector boundary.
    let corroborated =
        corroborate_picture_components(candidate, continuous_tone, source, raster_dpi, calibration);
    qualify_picture_owner(source, &corroborated)
}

/// Finds source regions with a genuinely distributed local tone histogram.
///
/// This deliberately answers a narrower question than `detect_picture_mask`:
/// whether normalization or a global text curve could destroy continuous
/// tone. Uniform gray/tinted paper with sparse antialiased glyphs has a
/// dominant paper bin and is rejected even when its ink creates a wide range.
/// A photograph or halftone has many populated intermediate levels and is
/// retained independently of text-line segmentation.
pub(crate) fn detect_continuous_tone_mask(source: &GrayImage, raster_dpi: f64) -> BinaryImage {
    if source.width() == 0 || source.height() == 0 {
        return BinaryImage::new(source.width(), source.height());
    }
    let tile_edge = (raster_dpi * CONTINUOUS_TONE_TILE_INCHES).round().max(12.0) as usize;
    let columns = source.width().div_ceil(tile_edge);
    let rows = source.height().div_ceil(tile_edge);
    let noise_sigma = estimate_page_noise_sigma(source, tile_edge);
    let noise_mode_radius = (noise_sigma * 2.5).ceil().clamp(2.0, 30.0) as usize;
    let minimum_robust_range = usize::from(CONTINUOUS_TONE_MINIMUM_ROBUST_RANGE)
        .max((noise_sigma * 6.0).ceil() as usize) as u8;
    let mut continuous_candidates = BinaryImage::new(columns, rows);
    let mut screened_candidates = BinaryImage::new(columns, rows);
    for tile_y in 0..rows {
        for tile_x in 0..columns {
            let left = tile_x * tile_edge;
            let top = tile_y * tile_edge;
            let right = (left + tile_edge).min(source.width());
            let bottom = (top + tile_edge).min(source.height());
            let mut histogram = [0usize; 256];
            for y in top..bottom {
                for x in left..right {
                    histogram[source.get(x, y) as usize] += 1;
                }
            }
            let pixel_count = (right - left).saturating_mul(bottom - top).max(1);
            let p10 = percentile_from_histogram(&histogram, pixel_count / 10);
            let p90 = percentile_from_histogram(
                &histogram,
                pixel_count.saturating_mul(9).saturating_sub(1) / 10,
            );
            let robust_range = p90.saturating_sub(p10);
            let mode = histogram
                .iter()
                .enumerate()
                .max_by_key(|&(_level, count)| count)
                .map_or(255, |(level, _count)| level);
            if tile_has_screened_tone(source, left, top, right, bottom, mode as u8, noise_sigma) {
                screened_candidates.set(tile_x, tile_y, true);
            }
            if robust_range < minimum_robust_range || p10 >= 245 {
                continue;
            }
            let middle_start = p10.saturating_add(robust_range / 3) as usize;
            let middle_end = p90.saturating_sub(robust_range / 3) as usize;
            let middle_pixels = histogram[middle_start..=middle_end].iter().sum::<usize>();
            let mode_start = mode.saturating_sub(noise_mode_radius);
            let mode_end = (mode + noise_mode_radius).min(255);
            let noise_mode_fraction =
                histogram[mode_start..=mode_end].iter().sum::<usize>() as f64 / pixel_count as f64;
            let bilevel_variance_fraction =
                otsu_explained_variance_fraction(&histogram, pixel_count);
            if (middle_pixels as f64 / pixel_count as f64)
                >= CONTINUOUS_TONE_MINIMUM_MIDDLE_FRACTION
                && noise_mode_fraction < CONTINUOUS_TONE_MAXIMUM_NOISE_MODE_FRACTION
                && bilevel_variance_fraction < CONTINUOUS_TONE_MAXIMUM_BILEVEL_VARIANCE_FRACTION
            {
                continuous_candidates.set(tile_x, tile_y, true);
            }
        }
    }

    let page_pixels = source.width().saturating_mul(source.height()).max(1);
    let mut protected = BinaryImage::new(source.width(), source.height());
    protect_tone_candidate_components(
        &continuous_candidates,
        &mut protected,
        tile_edge,
        page_pixels,
        false,
    );
    protect_tone_candidate_components(
        &screened_candidates,
        &mut protected,
        tile_edge,
        page_pixels,
        true,
    );
    protected
}

fn protect_tone_candidate_components(
    candidates: &BinaryImage,
    protected: &mut BinaryImage,
    tile_edge: usize,
    page_pixels: usize,
    screened: bool,
) {
    let columns = candidates.width();
    let rows = candidates.height();
    let components = ComponentMap::from_binary(candidates);
    for component in components.components() {
        let component_width = component.right - component.left + 1;
        let component_height = component.bottom - component.top + 1;
        if screened
            && (component.area < SCREENED_TONE_MINIMUM_COMPONENT_TILES
                || component_width < 2
                || component_height < 2
                || component_width > component_height.saturating_mul(4)
                || component_height > component_width.saturating_mul(4))
        {
            continue;
        }
        let component_area = component
            .area
            .saturating_mul(tile_edge)
            .saturating_mul(tile_edge);
        if component_area as f64 / (page_pixels as f64)
            < CONTINUOUS_TONE_MINIMUM_COMPONENT_PAGE_FRACTION
        {
            continue;
        }
        // Protect actual evidence tiles plus one tile of local context. Filling
        // a component's bounding box turns a few noisy text tiles into a large
        // rectangular gray column.
        for tile_y in component.top..=component.bottom {
            for tile_x in component.left..=component.right {
                if !candidates.get(tile_x, tile_y) {
                    continue;
                }
                for context_y in tile_y.saturating_sub(1)..=(tile_y + 1).min(rows - 1) {
                    for context_x in tile_x.saturating_sub(1)..=(tile_x + 1).min(columns - 1) {
                        let left = context_x * tile_edge;
                        let top = context_y * tile_edge;
                        let right = (left + tile_edge).min(protected.width());
                        let bottom = (top + tile_edge).min(protected.height());
                        for y in top..bottom {
                            for x in left..right {
                                protected.set(x, y, true);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Recognizes a printed halftone screen without treating it as a photographic
/// histogram. Screened print is often intentionally bi- or tri-level: the
/// visual gray is encoded by a dense two-dimensional field of tiny isolated
/// dots. Requiring most dark pixels to belong to many tiny components rejects
/// ordinary glyphs, while the cross-tile shape check above rejects a single
/// punctuation/text tile.
fn tile_has_screened_tone(
    source: &GrayImage,
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
    paper_mode: u8,
    noise_sigma: f64,
) -> bool {
    let width = right.saturating_sub(left);
    let height = bottom.saturating_sub(top);
    let pixel_count = width.saturating_mul(height);
    if pixel_count == 0 {
        return false;
    }
    let separation = (noise_sigma * 5.0).ceil().clamp(12.0, 48.0) as u8;
    let ink_limit = paper_mode.saturating_sub(separation);
    let mut ink = BinaryImage::new(width, height);
    let mut ink_pixels = 0usize;
    let mut occupied_rows = vec![false; height];
    let mut occupied_columns = vec![false; width];
    for y in top..bottom {
        for x in left..right {
            if source.get(x, y) <= ink_limit {
                ink.set(x - left, y - top, true);
                ink_pixels += 1;
                occupied_rows[y - top] = true;
                occupied_columns[x - left] = true;
            }
        }
    }
    let ink_fraction = ink_pixels as f64 / pixel_count as f64;
    if !(0.02..=0.48).contains(&ink_fraction)
        || occupied_rows.iter().filter(|&&occupied| occupied).count() * 4 < height
        || occupied_columns
            .iter()
            .filter(|&&occupied| occupied)
            .count()
            * 4
            < width
    {
        return false;
    }

    let components = ComponentMap::from_binary(&ink);
    if components.components().len() < SCREENED_TONE_MINIMUM_TILE_COMPONENTS {
        return false;
    }
    let maximum_dot_area = pixel_count.div_ceil(225).clamp(4, 25);
    let tiny_ink_pixels = components
        .components()
        .iter()
        .filter(|component| component.area <= maximum_dot_area)
        .map(|component| component.area)
        .sum::<usize>();
    tiny_ink_pixels * 5 >= ink_pixels * 4
}

/// Converts generous tile/rectangle evidence into pixel-resolution output
/// geometry. The evidence mask is only a search area; normalized paper pixels
/// inside it remain unprotected and can still become white. Darker ink,
/// halftone and map pixels retain their source tone without inheriting the
/// evidence mask's rectangular boundaries.
pub(crate) fn refine_tone_preservation_alpha(
    layout_normalized: &GrayImage,
    texture_source: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    coarse_tone_evidence: Option<&BinaryImage>,
) -> Option<GrayImage> {
    refine_tone_preservation_alpha_with_texture(
        layout_normalized,
        texture_source,
        picture_mask,
        coarse_tone_evidence,
        true,
    )
}

/// Maps and screened line art need their fills and ink, not the scanner's
/// low-amplitude paper texture. Keeping texture across a near-page-sized map
/// restores the original gray rectangle after paper calibration.
pub(crate) fn refine_line_art_preservation_alpha(
    layout_normalized: &GrayImage,
    texture_source: &GrayImage,
    picture_mask: Option<&BinaryImage>,
) -> Option<GrayImage> {
    refine_tone_preservation_alpha_with_texture(
        layout_normalized,
        texture_source,
        picture_mask,
        None,
        false,
    )
}

fn refine_tone_preservation_alpha_with_texture(
    layout_normalized: &GrayImage,
    texture_source: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    coarse_tone_evidence: Option<&BinaryImage>,
    preserve_picture_texture: bool,
) -> Option<GrayImage> {
    if picture_mask.is_none() && coarse_tone_evidence.is_none() {
        return None;
    }
    let picture_geometry = picture_mask.map(|mask| {
        resample_binary_mask_nearest(mask, layout_normalized.width(), layout_normalized.height())
    });
    let coarse_geometry = coarse_tone_evidence.map(|mask| {
        resample_binary_mask_nearest(mask, layout_normalized.width(), layout_normalized.height())
    });
    let page_pixels = layout_normalized
        .width()
        .saturating_mul(layout_normalized.height())
        .max(1);
    let is_useful_paper_exclusion = |mask: &BinaryImage| {
        // A mask covering most of a page cannot define its own complement as
        // "paper": maps and framed line art commonly leave too few samples,
        // causing the fallback paper center of 255 to preserve the raw gray
        // rectangle. Estimate the dominant paper mode inside such geometry
        // and use the mask only as output ownership.
        mask.count_black() as f64 / (page_pixels as f64) < 0.60
    };
    let picture_paper_exclusion = picture_geometry
        .as_ref()
        .filter(|mask| is_useful_paper_exclusion(mask));
    let coarse_paper_exclusion = coarse_geometry
        .as_ref()
        .filter(|mask| is_useful_paper_exclusion(mask));
    let paper_exclusion = match (picture_paper_exclusion, coarse_paper_exclusion) {
        (Some(picture), Some(coarse)) => Some(picture.or(coarse)),
        (Some(mask), None) | (None, Some(mask)) => Some(mask.clone()),
        (None, None) => None,
    };
    let paper_center =
        dominant_paper_center(layout_normalized, paper_exclusion.as_ref()).unwrap_or(255) as f64;
    let tile_edge = layout_normalized
        .width()
        .min(layout_normalized.height())
        .div_ceil(24)
        .clamp(12, 64);
    let noise_sigma =
        estimate_page_noise_sigma_excluding(layout_normalized, tile_edge, paper_exclusion.as_ref());
    let high = paper_center - 2.0 * noise_sigma;
    let low = paper_center - (6.0 * noise_sigma).max(24.0);
    let span = (high - low).max(1.0);
    let mut raw_alpha = GrayImage::new(layout_normalized.width(), layout_normalized.height(), 0);
    for y in 0..layout_normalized.height() {
        for x in 0..layout_normalized.width() {
            let linear = ((high - f64::from(layout_normalized.get(x, y))) / span).clamp(0.0, 1.0);
            let smooth = linear * linear * (3.0 - 2.0 * linear);
            raw_alpha.set(x, y, (smooth * 255.0).round() as u8);
        }
    }
    let texture_source = if texture_source.width() == layout_normalized.width()
        && texture_source.height() == layout_normalized.height()
    {
        texture_source.clone()
    } else {
        texture_source
            .downscale_to_dimensions(layout_normalized.width(), layout_normalized.height())
    };
    let eroded = erode_gray(&texture_source, 2, 2);
    let dilated = dilate_gray(&texture_source, 2, 2);
    let texture_low = (3.0 * noise_sigma).max(8.0);
    let texture_high = (8.0 * noise_sigma).max(24.0);
    let texture_span = (texture_high - texture_low).max(1.0);
    let mut texture_alpha =
        GrayImage::new(layout_normalized.width(), layout_normalized.height(), 0);
    for y in 0..layout_normalized.height() {
        for x in 0..layout_normalized.width() {
            let local_range = f64::from(eroded.get(x, y).saturating_sub(dilated.get(x, y)));
            let linear = ((local_range - texture_low) / texture_span).clamp(0.0, 1.0);
            let smooth = linear * linear * (3.0 - 2.0 * linear);
            texture_alpha.set(x, y, (smooth * 255.0).round() as u8);
        }
    }
    let mut approved = BinaryImage::new(layout_normalized.width(), layout_normalized.height());
    if let Some(evidence) = coarse_geometry.as_ref() {
        let mut candidate = BinaryImage::new(layout_normalized.width(), layout_normalized.height());
        for y in 0..layout_normalized.height() {
            for x in 0..layout_normalized.width() {
                if raw_alpha.get(x, y) >= 128 {
                    candidate.set(x, y, true);
                }
            }
        }
        // Join nearby halftone dots before measuring components, then retain
        // the original candidate pixels rather than the dilated geometry.
        // Requiring two-dimensional extent rejects text-line/smear fragments
        // while keeping irregular map fills and illustrations.
        let clustered = dilate(&candidate, 2, 2);
        let components = ComponentMap::from_binary(&clustered);
        let minimum_width = (layout_normalized.width() as f64
            * TONE_PRESERVATION_MINIMUM_COMPONENT_SPAN_FRACTION)
            .round()
            .max(4.0) as usize;
        let minimum_height = (layout_normalized.height() as f64
            * TONE_PRESERVATION_MINIMUM_COMPONENT_SPAN_FRACTION)
            .round()
            .max(4.0) as usize;
        let retained_clusters = components.retain(|component| {
            let width = component.right - component.left + 1;
            let height = component.bottom - component.top + 1;
            if component.area as f64 / (page_pixels as f64)
                < TONE_PRESERVATION_MINIMUM_COMPONENT_PAGE_FRACTION
                || width < minimum_width
                || height < minimum_height
            {
                return false;
            }
            let mut evidence_overlap = 0usize;
            for y in component.top..=component.bottom {
                for x in component.left..=component.right {
                    if clustered.get(x, y) && evidence.get(x, y) {
                        evidence_overlap += 1;
                    }
                }
            }
            evidence_overlap >= component.area.div_ceil(100).max(4)
        });
        approved = approved.or(&retained_clusters);
    }
    let approved_weight = feather_binary_mask(&approved, TONE_PRESERVATION_FEATHER_RADIUS);
    let picture_weight = picture_geometry
        .as_ref()
        .map(|mask| feather_binary_mask(mask, TONE_PRESERVATION_FEATHER_RADIUS));
    let mut preservation_alpha =
        GrayImage::new(layout_normalized.width(), layout_normalized.height(), 0);
    let mut nonzero = false;
    for y in 0..layout_normalized.height() {
        for x in 0..layout_normalized.width() {
            let tonal = u16::from(raw_alpha.get(x, y)) * u16::from(approved_weight.get(x, y)) / 255;
            let picture = picture_weight.as_ref().map_or(0, |weight| {
                let evidence = if preserve_picture_texture {
                    raw_alpha.get(x, y).max(texture_alpha.get(x, y))
                } else {
                    raw_alpha.get(x, y)
                };
                u16::from(material_tone_alpha(evidence)) * u16::from(weight.get(x, y)) / 255
            });
            let alpha = tonal.max(picture) as u8;
            preservation_alpha.set(x, y, alpha);
            nonzero |= alpha != 0;
        }
    }
    nonzero.then_some(preservation_alpha)
}

fn material_tone_alpha(alpha: u8) -> u8 {
    if alpha <= TONE_PRESERVATION_MATERIAL_ALPHA_FLOOR {
        return 0;
    }
    let span = u16::from(255 - TONE_PRESERVATION_MATERIAL_ALPHA_FLOOR);
    let material = u16::from(alpha - TONE_PRESERVATION_MATERIAL_ALPHA_FLOOR);
    ((material * 255 + span / 2) / span) as u8
}

/// Turns already-vetted continuous-tone geometry into a semantic preservation
/// field. Unlike map/ink refinement, this must not weight pixels by darkness:
/// doing so keeps the dark center of a smooth gradient while whitening its
/// pale and middle tones. The caller blends this field toward the
/// illumination-corrected raster, never the raw scan, so paper shade and
/// scanner shadows are not restored.
pub(crate) fn semantic_tone_preservation_alpha(semantic_tone: &BinaryImage) -> Option<GrayImage> {
    if semantic_tone.count_black() == 0 {
        return None;
    }
    Some(feather_binary_mask(
        semantic_tone,
        TONE_PRESERVATION_FEATHER_RADIUS,
    ))
}

/// Finds large, sharply bounded flat fills that are semantic map/diagram tone
/// rather than paper shade. Continuous-tone detection intentionally rejects
/// flat regions, while a scanned map can contain large uniform gray fills.
/// Selecting a paper-relative middle band excludes black text/line work; the
/// component size and strong-boundary test reject glyphs and smooth scanner
/// clouds without relying on a particular paper shade.
pub(crate) fn flat_graphic_tone_preservation_alpha(
    layout_normalized: &GrayImage,
) -> Option<GrayImage> {
    if layout_normalized.width() < 8 || layout_normalized.height() < 8 {
        return None;
    }
    let paper = dominant_paper_center(layout_normalized, None)? as i16;
    let upper = paper.saturating_sub(20);
    let lower = paper.saturating_sub(150).max(0);
    if upper <= lower {
        return None;
    }
    let raw_candidate = BinaryImage::from_fn_parallel(
        layout_normalized.width(),
        layout_normalized.height(),
        |x, y| {
            let value = i16::from(layout_normalized.get(x, y));
            value >= lower && value <= upper
        },
    );
    let page_pixels = layout_normalized
        .width()
        .saturating_mul(layout_normalized.height())
        .max(1);
    let minimum_area = page_pixels.div_ceil(400); // 0.25% of the page.
    let minimum_width = layout_normalized.width().div_ceil(25).max(8);
    let minimum_height = layout_normalized.height().div_ceil(25).max(8);
    // Printed contour lines commonly cross a flat fill. Close those narrow
    // gaps before component analysis so the lines do not cut one semantic
    // region into a few large retained slices plus small slices that become
    // white holes.
    let candidate = close(&raw_candidate, 4, 4);
    let components = ComponentMap::from_binary(&candidate);
    let retained = components.retain(|component| {
        let component_width = component.right - component.left + 1;
        let component_height = component.bottom - component.top + 1;
        let component_bounds_area = component_width.saturating_mul(component_height).max(1);
        if component.area < minimum_area
            || component_width < minimum_width
            || component_height < minimum_height
            || component_width > component_height.saturating_mul(4)
            || component_height > component_width.saturating_mul(4)
        {
            return false;
        }
        let mut original_band_pixels = 0usize;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if components.label_at(x, y) == component.label && raw_candidate.get(x, y) {
                    original_band_pixels += 1;
                }
            }
        }
        if component.area.saturating_mul(4) < component_bounds_area {
            return false;
        }
        // Closing is allowed to bridge narrow contour lines through a solid
        // fill, but it must not turn sparse antialias fringes around headings,
        // calibration bars, or dense text into a fake flat graphic.
        let original_band_dense = original_band_pixels * 5 >= component.area * 3;
        if !original_band_dense {
            return false;
        }
        let mut boundary_pixels = 0usize;
        let mut strong_boundary_pixels = 0usize;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if !candidate.get(x, y) {
                    continue;
                }
                let value = layout_normalized.get(x, y);
                let mut boundary = false;
                let mut strongest = 0u8;
                for (neighbor_x, neighbor_y) in [
                    (x.saturating_sub(1), y),
                    ((x + 1).min(layout_normalized.width() - 1), y),
                    (x, y.saturating_sub(1)),
                    (x, (y + 1).min(layout_normalized.height() - 1)),
                ] {
                    if candidate.get(neighbor_x, neighbor_y) {
                        continue;
                    }
                    boundary = true;
                    strongest = strongest
                        .max(value.abs_diff(layout_normalized.get(neighbor_x, neighbor_y)));
                }
                if boundary {
                    boundary_pixels += 1;
                    strong_boundary_pixels += usize::from(strongest >= 12);
                }
            }
        }
        boundary_pixels >= 16 && strong_boundary_pixels * 5 >= boundary_pixels * 3
    });
    if retained.count_black() == 0 {
        return None;
    }
    Some(feather_binary_mask(
        &retained,
        TONE_PRESERVATION_FEATHER_RADIUS,
    ))
}

/// Turns a detector-corroborated photo region into a source-preservation
/// field. A photograph is continuous geometry: weighting its mask again by
/// darkness or local texture destroys smooth highlights and middle tones and
/// makes the detector's tile boundaries visible in the result.
///
/// This is intentionally separate from `refine_tone_preservation_alpha`.
/// Callers with a deliberately generous/manual mask may still use refinement
/// to recover paper-like pixels. The render engine calls this only after the
/// picture component has been corroborated by continuous-tone evidence.
pub(crate) fn photo_tone_preservation_alpha(picture: &BinaryImage) -> Option<GrayImage> {
    if picture.count_black() == 0 {
        return None;
    }
    Some(feather_binary_mask(
        picture,
        TONE_PRESERVATION_FEATHER_RADIUS,
    ))
}

/// Resamples producer-owned evidence onto the bounded analysis grid without
/// interpolation-generated ownership halos.
pub(crate) fn resample_binary_mask_nearest(
    mask: &BinaryImage,
    width: usize,
    height: usize,
) -> BinaryImage {
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        let source_x = x.saturating_mul(mask.width()) / width.max(1);
        let source_y = y.saturating_mul(mask.height()) / height.max(1);
        mask.get(
            source_x.min(mask.width().saturating_sub(1)),
            source_y.min(mask.height().saturating_sub(1)),
        )
    })
}

fn dominant_paper_center(
    normalized: &GrayImage,
    coarse_tone_evidence: Option<&BinaryImage>,
) -> Option<u8> {
    const CLUSTER_RADIUS: usize = 10;
    fn strongest_cluster(histogram: &[usize; 256]) -> (u8, usize) {
        (128usize..=255)
            .map(|center| {
                let count = histogram
                    [center.saturating_sub(CLUSTER_RADIUS)..=(center + CLUSTER_RADIUS).min(255)]
                    .iter()
                    .sum::<usize>();
                (center as u8, count)
            })
            .max_by_key(|&(_center, count)| count)
            .unwrap_or((255, 0))
    }

    let mut histogram = [0usize; 256];
    let mut count = 0usize;
    for y in 0..normalized.height() {
        for x in 0..normalized.width() {
            if coarse_tone_evidence.is_some_and(|mask| mask.get(x, y)) {
                continue;
            }
            histogram[usize::from(normalized.get(x, y))] += 1;
            count += 1;
        }
    }
    let (_outside_center, outside_cluster_count) = strongest_cluster(&histogram);
    // A broad semantic mask can leave thousands of border pixels outside it.
    // Their quantity alone does not make them paper evidence: black scan
    // borders previously pinned the "paper" center to 128 and caused almost
    // the entire gray map to receive full preservation weight. Fall back to
    // the whole page when the outside samples contain no coherent light
    // cluster.
    if count < 128 || outside_cluster_count < count.div_ceil(20).max(16) {
        histogram = [0usize; 256];
        for &value in normalized.data() {
            histogram[usize::from(value)] += 1;
        }
        count = normalized.data().len();
    }
    (count > 0).then(|| strongest_cluster(&histogram).0)
}

fn feather_binary_mask(mask: &BinaryImage, radius: usize) -> GrayImage {
    if radius == 0 {
        let mut output = GrayImage::new(mask.width(), mask.height(), 0);
        for y in 0..mask.height() {
            for x in 0..mask.width() {
                output.set(x, y, if mask.get(x, y) { 255 } else { 0 });
            }
        }
        return output;
    }
    let width = mask.width();
    let height = mask.height();
    let mut horizontal = vec![0u32; width.saturating_mul(height)];
    for y in 0..height {
        let mut prefix = vec![0u32; width + 1];
        for x in 0..width {
            prefix[x + 1] = prefix[x] + u32::from(mask.get(x, y));
        }
        for x in 0..width {
            let left = x.saturating_sub(radius);
            let right = (x + radius + 1).min(width);
            horizontal[y * width + x] = prefix[right] - prefix[left];
        }
    }
    let mut output = GrayImage::new(width, height, 0);
    for x in 0..width {
        let mut prefix = vec![0u32; height + 1];
        for y in 0..height {
            prefix[y + 1] = prefix[y] + horizontal[y * width + x];
        }
        for y in 0..height {
            let top = y.saturating_sub(radius);
            let bottom = (y + radius + 1).min(height);
            let left = x.saturating_sub(radius);
            let right = (x + radius + 1).min(width);
            let samples = (right - left).saturating_mul(bottom - top).max(1) as u32;
            output.set(
                x,
                y,
                (((prefix[bottom] - prefix[top]) * 255 + samples / 2) / samples) as u8,
            );
        }
    }
    output
}

fn estimate_page_noise_sigma(source: &GrayImage, tile_edge: usize) -> f64 {
    estimate_page_noise_sigma_excluding(source, tile_edge, None)
}

fn estimate_page_noise_sigma_excluding(
    source: &GrayImage,
    tile_edge: usize,
    exclusion: Option<&BinaryImage>,
) -> f64 {
    let mut estimates = Vec::new();
    for top in (0..source.height()).step_by(tile_edge) {
        for left in (0..source.width()).step_by(tile_edge) {
            let bottom = (top + tile_edge).min(source.height());
            let right = (left + tile_edge).min(source.width());
            let mut histogram = [0usize; 256];
            let mut count = 0usize;
            for y in top..bottom {
                for x in left..right {
                    if exclusion.is_some_and(|mask| mask.get(x, y)) {
                        continue;
                    }
                    histogram[source.get(x, y) as usize] += 1;
                    count += 1;
                }
            }
            let tile_pixels = (right - left).saturating_mul(bottom - top).max(1);
            if count < tile_pixels / 2 || count < 16 {
                continue;
            }
            let p25 = percentile_from_histogram(&histogram, count / 4);
            let p75 = percentile_from_histogram(&histogram, count.saturating_mul(3) / 4);
            estimates.push(f64::from(p75.saturating_sub(p25)) / 1.349);
        }
    }
    if estimates.is_empty() {
        return 1.0;
    }
    estimates.sort_by(f64::total_cmp);
    estimates[estimates.len() / 5].clamp(1.0, 12.0)
}

fn otsu_explained_variance_fraction(histogram: &[usize; 256], pixel_count: usize) -> f64 {
    if pixel_count <= 1 {
        return 0.0;
    }
    let total = pixel_count as f64;
    let sum = histogram
        .iter()
        .enumerate()
        .map(|(level, &count)| level as f64 * count as f64)
        .sum::<f64>();
    let mean = sum / total;
    let total_variance = histogram
        .iter()
        .enumerate()
        .map(|(level, &count)| {
            let delta = level as f64 - mean;
            delta * delta * count as f64
        })
        .sum::<f64>();
    if total_variance <= f64::EPSILON {
        return 0.0;
    }
    let mut lower_count = 0usize;
    let mut lower_sum = 0.0;
    let mut maximum_between = 0.0_f64;
    for (level, &count) in histogram.iter().enumerate().take(255) {
        lower_count += count;
        lower_sum += level as f64 * count as f64;
        if lower_count == 0 || lower_count == pixel_count {
            continue;
        }
        let upper_count = pixel_count - lower_count;
        let lower_mean = lower_sum / lower_count as f64;
        let upper_mean = (sum - lower_sum) / upper_count as f64;
        maximum_between = maximum_between.max(
            lower_count as f64 * upper_count as f64 / total * (lower_mean - upper_mean).powi(2),
        );
    }
    maximum_between / total_variance
}

fn complete_dense_picture_rectangles(candidate: BinaryImage) -> BinaryImage {
    let components = ComponentMap::from_binary(&candidate);
    let page_pixels = candidate.width().saturating_mul(candidate.height()).max(1);
    let minimum_area =
        (page_pixels as f64 * DENSE_RECTANGLE_MINIMUM_PAGE_FRACTION).round() as usize;
    let minimum_width =
        (candidate.width() as f64 * DENSE_RECTANGLE_MINIMUM_SPAN_FRACTION).round() as usize;
    let minimum_height =
        (candidate.height() as f64 * DENSE_RECTANGLE_MINIMUM_SPAN_FRACTION).round() as usize;
    let mut completed = candidate;
    for component in components.components() {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let bounds_area = width.saturating_mul(height).max(1);
        let occupancy = component.area as f64 / bounds_area as f64;
        if component.area < minimum_area
            || width < minimum_width
            || height < minimum_height
            || occupancy < DENSE_RECTANGLE_MINIMUM_OCCUPANCY
        {
            continue;
        }
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                completed.set(x, y, true);
            }
        }
    }
    completed
}

fn corroborate_picture_components(
    candidate: BinaryImage,
    continuous_tone: &BinaryImage,
    source: &GrayImage,
    raster_dpi: f64,
    calibration: PageCalibration,
) -> BinaryImage {
    debug_assert_eq!(
        (candidate.width(), candidate.height()),
        (continuous_tone.width(), continuous_tone.height())
    );
    if candidate.count_black() == 0 || continuous_tone.count_black() == 0 {
        return BinaryImage::new(candidate.width(), candidate.height());
    }
    let components = ComponentMap::from_binary(&candidate);
    let retained = components.retain(|component| {
        let minimum_overlap = component.area.div_ceil(100).max(4);
        let mut overlap = 0usize;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if candidate.get(x, y) && continuous_tone.get(x, y) {
                    overlap += 1;
                    if overlap >= minimum_overlap {
                        return true;
                    }
                }
            }
        }
        false
    });
    if retained.count_black() == 0 {
        return retained;
    }

    // A detector often sees only the darker lobe of a screened or shaded
    // plate. Use the retained candidate as the anchor and admit only
    // continuous-tone components touching that anchor. This is tone-driven
    // growth, but it never admits an unrelated tone component: the caller
    // still qualifies the resulting union against the same border, gutter,
    // shadow, and density vetoes as every other automatic owner.
    let anchors = dilate(&retained, 2, 2);
    let tone_components = ComponentMap::from_binary(continuous_tone);
    let tone_growth = tone_components.retain(|component| {
        let mut overlap = 0usize;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if tone_components.label_at(x, y) == component.label && anchors.get(x, y) {
                    overlap += 1;
                    if overlap >= component.area.div_ceil(100).max(4) {
                        return true;
                    }
                }
            }
        }
        false
    });
    // Apply the same text/artifact veto to growth alone. Applying it to the
    // entire union can revoke a genuine photo merely because a nearby body
    // text chain was admitted by the generous context field; the retained
    // candidate remains the seed, while the final caller still qualifies the
    // complete union.
    let tone_growth = veto_text_like_regions(source, tone_growth, raster_dpi, calibration);
    retained.or(&tone_growth)
}

/// Applies the last semantic ownership veto to a detector candidate.
///
/// Continuous-tone fields are corroborating evidence only; they are never an
/// owner by themselves. The candidate also has to be a sufficiently large
/// component that is not a scanner rail, fold shadow, gutter shadow, or edge
/// ghost. Keeping this gate here gives the render pipeline one automatic
/// picture owner to pass to content analysis, mode selection, and composition.
pub(crate) fn qualify_picture_owner(source: &GrayImage, candidate: &BinaryImage) -> BinaryImage {
    debug_assert_eq!(
        (source.width(), source.height()),
        (candidate.width(), candidate.height())
    );
    if candidate.count_black() == 0 {
        return BinaryImage::new(candidate.width(), candidate.height());
    }

    let border_artifacts = crate::content::border_artifact_mask(source);
    let measured_gutter = gutter_shadow(source);
    let picture_map = ComponentMap::from_binary(candidate);
    let mut owner = candidate.clone();
    for component in picture_map.components() {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let page_width = source.width();
        let page_height = source.height();
        let component_bounds_area = width.saturating_mul(height).max(1);
        let density = component.area as f64 / component_bounds_area as f64;
        // Edge overlap and shadow-shaped geometry are useful artifact signals
        // only for small/sparse fields. A dense plate can legitimately touch
        // both margins: this covers a 85% x 70% illustration, each half of a
        // two-up plate pair, and a full-width banner whose height is shorter
        // than the page. The non-edge content dominates those components.
        let dense_large_component = density >= 0.70
            && (component.area.saturating_mul(2) >= page_width.saturating_mul(page_height)
                || (width.saturating_mul(5) >= page_width.saturating_mul(4)
                    && height.saturating_mul(10) >= page_height)
                || (height.saturating_mul(5) >= page_height.saturating_mul(4)
                    && width.saturating_mul(10) >= page_width.saturating_mul(3)));
        let horizontal_edge_zone = page_width.div_ceil(40).max(1);
        let vertical_edge_zone = page_height.div_ceil(40).max(1);
        let vertical_shadow = (component.top < vertical_edge_zone
            || component.bottom.saturating_add(vertical_edge_zone) >= page_height)
            && height.saturating_mul(2) >= page_height
            && height >= width.saturating_mul(4)
            && width.saturating_mul(5) <= page_width
            && !dense_large_component;
        let horizontal_shadow = (component.left < horizontal_edge_zone
            || component.right.saturating_add(horizontal_edge_zone) >= page_width)
            && width.saturating_mul(2) >= page_width
            && width >= height.saturating_mul(4)
            && height.saturating_mul(5) <= page_height
            && !dense_large_component;
        let mut border_overlap = 0usize;
        let mut midtones = 0usize;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if picture_map.label_at(x, y) == component.label {
                    border_overlap += usize::from(border_artifacts.get(x, y));
                    midtones += usize::from((40..=224).contains(&source.get(x, y)));
                }
            }
        }
        let touches_vertical_edge = component.top < vertical_edge_zone
            || component.bottom.saturating_add(vertical_edge_zone) >= page_height;
        // Anchor on the column the fold evidence measured; fall back to the
        // geometric centre only when nothing measured one.
        let center = measured_gutter.map_or(page_width / 2, GutterShadow::center);
        let crosses_gutter = component.left <= center.saturating_add(horizontal_edge_zone)
            && component.right.saturating_add(horizontal_edge_zone) >= center;
        let page_filling = width.saturating_mul(5) >= page_width.saturating_mul(4)
            && height.saturating_mul(5) >= page_height.saturating_mul(4);
        // Border evidence can overlap the authored edge of a full-bleed scan.
        // It may veto a sparse edge ghost or frame, but not a dense component
        // that already owns most of both page axes. The Bar Zobi manuscript
        // candidate is 99.9% dense in its 91% x 95% enclosure; the old 1%
        // overlap rule revoked all 576k corroborated pixels because 2.6% also
        // touched the rough leaf/black-stage boundary.
        let edge_artifact = border_overlap >= 16
            && border_overlap.saturating_mul(100) >= component.area
            && !dense_large_component;
        let sparse_midtones = midtones.saturating_mul(100) <= component.area.saturating_mul(8);
        let gutter_artifact = measured_gutter.is_some()
            && touches_vertical_edge
            && crosses_gutter
            && !page_filling
            && sparse_midtones
            && !dense_large_component;
        // A fold can disappear at the crop boundary before ownership is
        // qualified, so requiring contact with the top/bottom edge is not
        // sufficient. A narrow, long component sitting on the gutter is
        // scanner geometry rather than a photographic plate; real plates need
        // a materially wider enclosure before they can own tone.
        //
        // "On the gutter" is the measured column, not a band of page-width
        // fractions around the centre. A spread whose leaves differ in width
        // puts its fold outside the 40%-62% band while remaining a fold, and
        // that is precisely the page whose shadow is worst.
        let overlaps_measured_gutter = measured_gutter.is_some_and(|gutter| {
            component.left <= gutter.right.saturating_add(horizontal_edge_zone)
                && component.right.saturating_add(horizontal_edge_zone) >= gutter.left
        });
        // A fold shadow only clears the binarization threshold where it is
        // darkest, so the component that reaches qualification is frequently a
        // fragment of the column rather than the column. The height rule below
        // was written for the column and abstains on the fragment. Positional
        // evidence replaces it: a narrow, taller-than-wide component whose own
        // centre sits on the measured fold is scanner geometry at any height,
        // because nothing a book prints is centred on its own binding.
        let component_center_x = component.left + width / 2;
        let fragment_on_measured_gutter = measured_gutter
            .is_some_and(|gutter| gutter.contains_within(component_center_x, horizontal_edge_zone))
            && height >= width;
        // A central narrow shape on a single portrait leaf is not enough to
        // identify a fold, and `overlaps_measured_gutter` already carries the
        // source-level gutter context: pages without a measured fold remain
        // eligible for narrow inset illustrations and portraits. A real gutter
        // shadow may itself be a solid dark column, so this rule deliberately
        // does not require sparse midtones.
        let central_narrow_shadow = overlaps_measured_gutter
            && width.saturating_mul(12) <= page_width
            && (height.saturating_mul(5) >= page_height || fragment_on_measured_gutter)
            && !dense_large_component;
        if component.area < PICTURE_OWNER_MIN_COMPONENT_PIXELS
            || vertical_shadow
            || horizontal_shadow
            || edge_artifact
            || gutter_artifact
            || central_narrow_shadow
        {
            for y in component.top..=component.bottom {
                for x in component.left..=component.right {
                    if picture_map.label_at(x, y) == component.label {
                        owner.set(x, y, false);
                    }
                }
            }
        }
    }
    owner
}

/// Where the binding-fold evidence actually found the shadow, in analysis
/// pixels.
///
/// Ownership vetoes used to compare a component against `page_width / 2`,
/// which only coincides with the fold when a scanner produced two leaves of
/// identical width. Scanned spreads routinely place the fold several percent
/// off centre, and a centre-relative test then stops vetoing exactly the
/// pages whose fold is worst.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GutterShadow {
    left: usize,
    right: usize,
}

impl GutterShadow {
    fn center(self) -> usize {
        self.left + (self.right - self.left) / 2
    }

    /// The measurement window is deliberately narrow so it locks onto the
    /// darkest core of the fold. The shadow itself is wider than its core, so
    /// membership tests admit the same edge zone the surrounding artifact
    /// rules use.
    fn contains_within(self, x: usize, tolerance: usize) -> bool {
        x.saturating_add(tolerance) >= self.left && x <= self.right.saturating_add(tolerance)
    }
}

/// Locates a binding-fold shadow on a spread, or reports its absence.
///
/// Two independent evidence paths qualify a fold, and both are retained. The
/// dark-density profile answers whether a fold exists but localizes poorly:
/// its window can win on a dense text column rather than on the shadow. The
/// tone profile measures the physical thing — a luminance depression that
/// persists down the page — so it owns the reported position whenever it
/// qualifies.
fn gutter_shadow(source: &GrayImage) -> Option<GutterShadow> {
    if source.width() <= source.height() || source.width() < 100 {
        return None;
    }
    let window_width = source.width().div_ceil(100).max(1);
    let column_ink = (0..source.width())
        .map(|x| {
            (0..source.height())
                .filter(|&y| source.get(x, y) <= BORDER_INK_LUMINANCE_CUTOFF)
                .count()
        })
        .collect::<Vec<_>>();
    let central_left = source.width() * 3 / 10;
    let central_right = source.width() * 7 / 10;
    let mut windows = (central_left..central_right.saturating_sub(window_width))
        .map(|left| {
            (
                column_ink[left..left + window_width].iter().sum::<usize>() as f64
                    / window_width.saturating_mul(source.height()).max(1) as f64,
                left,
            )
        })
        .collect::<Vec<_>>();
    if windows.is_empty() {
        return None;
    }
    windows.sort_unstable_by(|left, right| left.0.total_cmp(&right.0));
    let median = windows[windows.len() / 2].0;
    let (maximum, darkest_left) = windows[windows.len() - 1];
    let dark_profile = maximum >= 0.12 && maximum >= (median + 0.01) * 4.0;

    // Book folds are often pale at the analysis scale: the shadow is a broad
    // luminance depression, not enough <=160 ink to satisfy the dark-density
    // profile above. Measure the same central sliding windows in tone space,
    // then require the winning window to stay below its peers for a material
    // fraction of the page height. A title or text column can lower a few
    // rows, but it cannot produce a vertically persistent gutter profile.
    let tone_window_width = source.width().div_ceil(100).max(2);
    let mut column_sum = vec![0usize; source.width()];
    for y in 0..source.height() {
        for (x, sum) in column_sum.iter_mut().enumerate() {
            *sum += usize::from(source.get(x, y));
        }
    }
    let column_means = column_sum
        .into_iter()
        .map(|sum| sum as f64 / source.height().max(1) as f64)
        .collect::<Vec<_>>();
    let mut prefix = vec![0.0; column_means.len() + 1];
    for (index, mean) in column_means.iter().copied().enumerate() {
        prefix[index + 1] = prefix[index] + mean;
    }
    let tone_window_end = central_right.saturating_sub(tone_window_width);
    let mut tone_windows = (central_left..=tone_window_end)
        .map(|left| {
            let mean = (prefix[left + tone_window_width] - prefix[left]) / tone_window_width as f64;
            (mean, left)
        })
        .collect::<Vec<_>>();
    let tone_profile = (!tone_windows.is_empty())
        .then(|| {
            tone_windows.sort_unstable_by(|left, right| left.0.total_cmp(&right.0));
            let (minimum_tone, minimum_left) = tone_windows[0];
            let median_tone = tone_windows[tone_windows.len() / 2].0;
            if minimum_tone > 245.0 || median_tone - minimum_tone < 8.0 {
                return None;
            }
            let low_tone_rows = (0..source.height())
                .filter(|&y| {
                    let row_sum = (minimum_left..minimum_left + tone_window_width)
                        .map(|x| f64::from(source.get(x, y)))
                        .sum::<f64>();
                    let row_mean = row_sum / tone_window_width as f64;
                    median_tone - row_mean >= 8.0
                })
                .count();
            (low_tone_rows.saturating_mul(100) >= source.height().saturating_mul(35)).then_some(
                GutterShadow {
                    left: minimum_left,
                    right: minimum_left + tone_window_width - 1,
                },
            )
        })
        .flatten();

    tone_profile.or(dark_profile.then(|| GutterShadow {
        left: darkest_left,
        right: darkest_left + window_width - 1,
    }))
}

/// Expands an already-corroborated, irregular photo owner to the rectangular
/// crop that authored book photographs conventionally occupy.
///
/// This is deliberately downstream of picture corroboration: it must never
/// create a photo from tone alone. Expansion is all-or-nothing per connected
/// component so composition cannot expose a new patchwork boundary inside the
/// photograph. A component keeps its original geometry when the missing part
/// of its bounds looks unlike the owned source tone or contains a convincing
/// line of real text.
pub(crate) fn rectangularize_corroborated_photos(
    source: &GrayImage,
    automatic: &BinaryImage,
    text: &BinaryImage,
    text_vicinity: &BinaryImage,
    effective_dpi: f64,
) -> BinaryImage {
    debug_assert_eq!(
        (source.width(), source.height()),
        (automatic.width(), automatic.height())
    );
    debug_assert_eq!(
        (source.width(), source.height()),
        (text.width(), text.height())
    );
    debug_assert_eq!(
        (source.width(), source.height()),
        (text_vicinity.width(), text_vicinity.height())
    );
    if automatic.count_black() == 0 {
        return automatic.clone();
    }

    let components = ComponentMap::from_binary(automatic);
    let mut rectangular = automatic.clone();
    for component in components.components() {
        let bounds_area = (component.right - component.left + 1)
            .saturating_mul(component.bottom - component.top + 1);
        if component.area == bounds_area {
            continue;
        }
        if rectangle_addition_contains_text_line(
            automatic,
            text,
            text_vicinity,
            component.left,
            component.top,
            component.right,
            component.bottom,
            effective_dpi,
        ) || !rectangle_addition_matches_tone(
            source,
            &components,
            component.label,
            component.left,
            component.top,
            component.right,
            component.bottom,
        ) {
            continue;
        }
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                rectangular.set(x, y, true);
            }
        }
    }
    rectangular
}

#[allow(clippy::too_many_arguments)]
fn rectangle_addition_matches_tone(
    source: &GrayImage,
    components: &ComponentMap,
    label: u32,
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
) -> bool {
    let mut owned_histogram = [0usize; 256];
    let mut added_histogram = [0usize; 256];
    let mut owned_count = 0usize;
    let mut added_count = 0usize;
    for y in top..=bottom {
        for x in left..=right {
            let value = usize::from(source.get(x, y));
            if components.label_at(x, y) == label {
                owned_histogram[value] += 1;
                owned_count += 1;
            } else {
                added_histogram[value] += 1;
                added_count += 1;
            }
        }
    }
    if owned_count == 0 || added_count == 0 {
        return false;
    }

    let owned_p05 = percentile_from_histogram(&owned_histogram, owned_count / 20);
    let owned_p25 = percentile_from_histogram(&owned_histogram, owned_count / 4);
    let owned_p75 = percentile_from_histogram(
        &owned_histogram,
        owned_count.saturating_mul(3).saturating_sub(1) / 4,
    );
    let owned_p95 = percentile_from_histogram(
        &owned_histogram,
        owned_count.saturating_mul(19).saturating_sub(1) / 20,
    );
    let owned_iqr = owned_p75.saturating_sub(owned_p25);
    let tone_tolerance = (owned_iqr / 2).clamp(10, 36);
    let compatible_low = owned_p05.saturating_sub(tone_tolerance);
    let compatible_high = owned_p95.saturating_add(tone_tolerance);
    let compatible_added = added_histogram
        [usize::from(compatible_low)..=usize::from(compatible_high)]
        .iter()
        .sum::<usize>();
    if compatible_added as f64 / (added_count as f64) < PHOTO_RECTANGLE_MINIMUM_TONE_MATCH_FRACTION
    {
        return false;
    }

    // The ownership edge should disappear into the same source field. This
    // catches a detector component whose bounding box reaches across a sharp
    // photo-to-paper boundary even when a few photo highlights happen to make
    // the two global histograms overlap.
    let boundary_tolerance = tone_tolerance.saturating_add(12);
    let mut boundary_edges = 0usize;
    let mut matching_boundary_edges = 0usize;
    for y in top..=bottom {
        for x in left..=right {
            if components.label_at(x, y) != label {
                continue;
            }
            for (neighbor_x, neighbor_y) in [
                (x.saturating_sub(1), y),
                ((x + 1).min(source.width() - 1), y),
                (x, y.saturating_sub(1)),
                (x, (y + 1).min(source.height() - 1)),
            ] {
                if neighbor_x < left
                    || neighbor_x > right
                    || neighbor_y < top
                    || neighbor_y > bottom
                    || components.label_at(neighbor_x, neighbor_y) == label
                {
                    continue;
                }
                boundary_edges += 1;
                matching_boundary_edges += usize::from(
                    source
                        .get(x, y)
                        .abs_diff(source.get(neighbor_x, neighbor_y))
                        <= boundary_tolerance,
                );
            }
        }
    }
    boundary_edges > 0
        && matching_boundary_edges as f64 / boundary_edges as f64
            >= PHOTO_RECTANGLE_MINIMUM_BOUNDARY_MATCH_FRACTION
}

#[allow(clippy::too_many_arguments)]
fn rectangle_addition_contains_text_line(
    automatic: &BinaryImage,
    text: &BinaryImage,
    text_vicinity: &BinaryImage,
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
    effective_dpi: f64,
) -> bool {
    let width = right - left + 1;
    let height = bottom - top + 1;
    let mut added_text_vicinity = BinaryImage::new(width, height);
    for y in top..=bottom {
        for x in left..=right {
            if !automatic.get(x, y) && text_vicinity.get(x, y) {
                added_text_vicinity.set(x - left, y - top, true);
            }
        }
    }
    if added_text_vicinity.count_black() == 0 {
        return false;
    }

    let minimum_line_width = ((effective_dpi.max(1.0) * 0.18).round() as usize)
        .max(width.div_ceil(4))
        .min(width);
    let maximum_line_height = ((effective_dpi.max(1.0) * 0.35).round() as usize)
        .max(3)
        .min(height);
    let vicinity_components = ComponentMap::from_binary(&added_text_vicinity);
    vicinity_components.components().iter().any(|component| {
        let component_width = component.right - component.left + 1;
        let component_height = component.bottom - component.top + 1;
        if component_width < minimum_line_width
            || component_height > maximum_line_height
            || component_width < component_height.saturating_mul(2)
        {
            return false;
        }
        let mut actual_text = 0usize;
        let mut first_text_x = width;
        let mut last_text_x = 0usize;
        for local_y in component.top..=component.bottom {
            for local_x in component.left..=component.right {
                let x = left + local_x;
                let y = top + local_y;
                if !automatic.get(x, y) && text.get(x, y) {
                    actual_text += 1;
                    first_text_x = first_text_x.min(local_x);
                    last_text_x = last_text_x.max(local_x);
                }
            }
        }
        actual_text >= component_width.div_ceil(12).max(6)
            && first_text_x <= last_text_x
            && last_text_x - first_text_x + 1 >= minimum_line_width
    })
}

pub(crate) fn extend_picture_mask_for_content(
    source: &GrayImage,
    picture_mask: &BinaryImage,
    calibration: PageCalibration,
) -> BinaryImage {
    extend_mask_for_content(source, picture_mask, calibration, true)
}

/// Extends tonal seed pixels to the enclosing illustration/map structure
/// without adopting unrelated document structures elsewhere on the page.
///
/// When tonal evidence exists, both crop/layout and semantic-tone extension
/// stay local to the seed that caused the request. An empty automatic mask
/// keeps the established line-art recovery path; once there is a seed, it may
/// not adopt an unrelated gutter, frame, or text structure elsewhere.
pub(crate) fn extend_tone_mask_for_content(
    source: &GrayImage,
    tone_mask: &BinaryImage,
    calibration: PageCalibration,
) -> BinaryImage {
    extend_mask_for_content(source, tone_mask, calibration, true)
}

fn extend_mask_for_content(
    source: &GrayImage,
    seed_mask: &BinaryImage,
    calibration: PageCalibration,
    require_seed_overlap: bool,
) -> BinaryImage {
    let threshold = otsu_threshold(source);
    let binary = threshold_global(source, threshold);
    let component_map = ComponentMap::from_binary(&binary);
    let nominal_height = if calibration.valid {
        calibration.x_height_px.max(1.0)
    } else {
        (8.0 * calibration.effective_dpi / 150.0).max(4.0)
    };
    let long_span = (8.0 * nominal_height).round().max(24.0) as usize;
    // A scanner bed spans the raster, so its cluster would claim the whole
    // page. It is solid: most of its pixels sit where both their row and their
    // column cross at least a line of text's height of it. An authored frame
    // on the page edge is thin line art however far it runs, and stays an
    // anchor.
    let solid_radius = ((nominal_height - 1.0) / 2.0).ceil().max(1.0) as usize;
    let solid = open(&binary, solid_radius, 0).and(&open(&binary, 0, solid_radius));
    let solid_pixels = component_map.mask_counts_by_component(&solid);
    let anchors = component_map.retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let scanner_bed = is_scanner_border_shadow(component, source.width(), source.height())
            && solid_pixels[component.label as usize] * 2 >= component.area;
        (width >= long_span || height >= long_span) && !scanner_bed
    });
    let cluster_radius = (3.0 * nominal_height).round().max(8.0) as usize;
    let cluster_map = ComponentMap::from_binary(&dilate(&anchors, cluster_radius, cluster_radius));
    let minimum_width = (12.0 * nominal_height).round().max(48.0) as usize;
    let minimum_height = (8.0 * nominal_height).round().max(32.0) as usize;
    let has_seed = seed_mask.count_black() > 0;
    let mut structural = BinaryImage::new(source.width(), source.height());
    for cluster in cluster_map.components() {
        let width = cluster.right - cluster.left + 1;
        let height = cluster.bottom - cluster.top + 1;
        if width < minimum_width
            || height < minimum_height
            || width > height.saturating_mul(7)
            || height > width.saturating_mul(7)
        {
            continue;
        }
        let supporting_components = component_map
            .components()
            .iter()
            .filter(|component| {
                let center_x = (component.left + component.right) / 2;
                let center_y = (component.top + component.bottom) / 2;
                (cluster.left..=cluster.right).contains(&center_x)
                    && (cluster.top..=cluster.bottom).contains(&center_y)
            })
            .count();
        if supporting_components < 8 {
            continue;
        }
        if require_seed_overlap && has_seed {
            let mut overlap = 0usize;
            for y in cluster.top..=cluster.bottom {
                for x in cluster.left..=cluster.right {
                    if seed_mask.get(x, y) {
                        overlap += 1;
                    }
                }
            }
            let cluster_area = width.saturating_mul(height).max(1);
            if overlap < cluster_area.div_ceil(10_000).max(4) {
                continue;
            }
        }
        for y in cluster.top..=cluster.bottom {
            for x in cluster.left..=cluster.right {
                structural.set(x, y, true);
            }
        }
    }
    seed_mask.or(&structural)
}

pub(crate) fn apply_manual_zones(mask: &mut BinaryImage, options: &CleanupOptions) {
    for layer in [
        PictureZoneLayer::Eraser1,
        PictureZoneLayer::Painter2,
        PictureZoneLayer::Eraser3,
    ] {
        for zone in &options.manual_zones.picture {
            if zone.layer == layer {
                fill_normalized_polygon(mask, &zone.polygon, layer == PictureZoneLayer::Painter2);
            }
        }
    }
    // Fill zones are final binary painters, matching the last eraser pass.
    for polygon in &options.manual_zones.fill {
        fill_normalized_polygon(mask, polygon, false);
    }
}

fn fill_normalized_polygon(
    mask: &mut BinaryImage,
    normalized: &NormalizedZonePolygon,
    picture: bool,
) {
    let polygon = normalized.resolve(mask.width(), mask.height());
    if polygon.points.len() < 3 {
        return;
    }
    let min_x = polygon
        .points
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.0) as usize;
    let max_x = polygon
        .points
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(mask.width() as f64) as usize;
    let min_y = polygon
        .points
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min)
        .floor()
        .max(0.0) as usize;
    let max_y = polygon
        .points
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil()
        .min(mask.height() as f64) as usize;
    for y in min_y..max_y {
        for x in min_x..max_x {
            if point_in_polygon(x as f64 + 0.5, y as f64 + 0.5, &polygon.points) {
                mask.set(x, y, picture);
            }
        }
    }
}

fn point_in_polygon(x: f64, y: f64, points: &[scan_primitives::Point]) -> bool {
    let mut inside = false;
    let mut previous = points[points.len() - 1];
    for &current in points {
        let crosses = (current.y > y) != (previous.y > y)
            && x < (previous.x - current.x) * (y - current.y) / (previous.y - current.y)
                + current.x;
        if crosses {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

fn stretch_contrast(source: &GrayImage, tail_fraction: f64) -> GrayImage {
    let histogram = source
        .data()
        .par_chunks(65_536)
        .map(|chunk| {
            let mut histogram = [0usize; 256];
            for &value in chunk {
                histogram[value as usize] += 1;
            }
            histogram
        })
        .reduce(
            || [0usize; 256],
            |left, right| std::array::from_fn(|index| left[index] + right[index]),
        );
    let count = source.width().saturating_mul(source.height());
    if count == 0 {
        return source.clone();
    }
    let tail = (count as f64 * tail_fraction).round() as usize;
    let low = percentile_from_histogram(&histogram, tail.min(count - 1));
    let high = percentile_from_histogram(&histogram, count.saturating_sub(tail).saturating_sub(1));
    if low >= high {
        return source.clone();
    }
    let range = u16::from(high - low);
    let mut output = source.clone();
    output
        .data_mut()
        .par_iter_mut()
        .zip(source.data().par_iter())
        .for_each(|(target, &value)| {
            let stretched = if value <= low {
                0
            } else if value >= high {
                255
            } else {
                ((u16::from(value - low) * 255 + range / 2) / range) as u8
            };
            *target = stretched;
        });
    output
}

fn percentile_from_histogram(histogram: &[usize; 256], rank: usize) -> u8 {
    let mut cumulative = 0usize;
    for (value, &frequency) in histogram.iter().enumerate() {
        cumulative += frequency;
        if cumulative > rank {
            return value as u8;
        }
    }
    255
}

pub(crate) fn veto_text_like_regions(
    source: &GrayImage,
    candidate: BinaryImage,
    raster_dpi: f64,
    calibration: PageCalibration,
) -> BinaryImage {
    if !calibration.valid || candidate.count_black() == 0 {
        return candidate;
    }
    let candidate_components = ComponentMap::from_binary(&candidate);
    if candidate_components.components().is_empty() {
        return candidate;
    }
    let text = threshold_global(source, otsu_threshold(source));
    let text_components = ComponentMap::from_binary(&text);
    let distance_to_white = squared_euclidean_distance(&text.invert());
    let maxima = text_components.maximum_values_by_component(&distance_to_white);
    let scale = raster_dpi.max(1.0) / calibration.effective_dpi.max(1.0);
    let body_stroke = calibration.stroke_width_px * scale;
    let body_height = calibration.x_height_px * scale;
    let mut matched_strokes = vec![Vec::<f64>::new(); candidate_components.components().len() + 1];
    let mut contained_counts = vec![0usize; candidate_components.components().len() + 1];
    for component in text_components.components() {
        if component.area < 4 {
            continue;
        }
        let center_x = (component.left + component.right) / 2;
        let center_y = (component.top + component.bottom) / 2;
        let candidate_label = candidate_components.label_at(center_x, center_y) as usize;
        if candidate_label == 0 {
            continue;
        }
        contained_counts[candidate_label] += 1;
        let stroke = 2.0 * f64::from(maxima[component.label as usize]).sqrt();
        let height = (component.bottom - component.top + 1) as f64;
        if (body_stroke * 0.6..=body_stroke * 1.6).contains(&stroke)
            && (body_height * 0.55..=body_height * 1.8).contains(&height)
        {
            matched_strokes[candidate_label].push(stroke);
        }
    }

    let mut vetoed = vec![false; candidate_components.components().len() + 1];
    for component in candidate_components.components() {
        let label = component.label as usize;
        let strokes = &mut matched_strokes[label];
        if strokes.len() < MIN_TEXT_COMPONENTS_FOR_VETO
            || strokes.len() * 2 < contained_counts[label]
        {
            continue;
        }
        strokes.sort_unstable_by(f64::total_cmp);
        let median = strokes[strokes.len() / 2];
        if (body_stroke * 0.7..=body_stroke * 1.4).contains(&median) {
            vetoed[label] = true;
        }
    }
    if !vetoed.iter().any(|&value| value) {
        return candidate;
    }
    candidate_components.retain(|component| !vetoed[component.label as usize])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calibration::CalibrationConfig;
    use crate::{ManualZones, NormalizedZonePoint, OrthogonalRotation, PictureZone};
    use jpeg_encoder::{ColorType, Encoder as JpegEncoder, SamplingFactor};
    use std::io::Cursor;
    use zune_jpeg::{
        zune_core::{colorspace::ColorSpace, options::DecoderOptions},
        JpegDecoder,
    };

    fn jpeg_luma_roundtrip(source: &GrayImage, quality: u8) -> GrayImage {
        let mut encoded = Vec::new();
        let mut encoder = JpegEncoder::new(&mut encoded, quality);
        encoder.set_sampling_factor(SamplingFactor::F_1_1);
        encoder
            .encode(
                source.data(),
                u16::try_from(source.width()).unwrap(),
                u16::try_from(source.height()).unwrap(),
                ColorType::Luma,
            )
            .unwrap();
        let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::Luma);
        let mut decoder = JpegDecoder::new_with_options(Cursor::new(encoded), options);
        GrayImage::from_vec(
            source.width(),
            source.height(),
            source.width(),
            decoder.decode().unwrap(),
        )
        .unwrap()
    }

    fn noisy_text_page(paper: u8, noise_amplitude: i16) -> GrayImage {
        let mut image = GrayImage::new(600, 720, paper);
        let mut state = 0x7a1d_93c5_u32;
        for y in 0..image.height() {
            for x in 0..image.width() {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let span = noise_amplitude * 2 + 1;
                let noise = ((state >> 16) as i16).rem_euclid(span) - noise_amplitude;
                image.set(x, y, (i16::from(paper) + noise).clamp(0, 255) as u8);
            }
        }
        for line in 0..21 {
            let top = 28 + line * 31;
            for glyph in 0..47 {
                let left = 22 + glyph * 12;
                for y in top..top + 10 {
                    for x in left..left + 7 {
                        let edge = x == left || x + 1 == left + 7 || y == top || y + 1 == top + 10;
                        let core = x == left + 1 || y == top + 1 || y + 2 == top + 10;
                        if edge {
                            image.set(x, y, paper.saturating_sub(55));
                        } else if core {
                            image.set(x, y, 28);
                        }
                    }
                }
            }
        }
        image
    }

    fn glyph_page(with_photo: bool) -> GrayImage {
        let mut image = GrayImage::new(260, 180, 242);
        for row in 0..4 {
            for column in 0..9 {
                let left = 15 + column * 18;
                let top = 18 + row * 28;
                for y in top..top + 15 {
                    for x in left..left + 10 {
                        if x < left + 2 || y < top + 2 || y >= top + 13 {
                            image.set(x, y, 28);
                        }
                    }
                }
            }
        }
        if with_photo {
            for y in 35..155 {
                for x in 185..250 {
                    let value = 35 + ((x * 11 + y * 7 + x * y % 41) % 190) as u8;
                    image.set(x, y, value);
                }
            }
        }
        image
    }

    #[test]
    fn text_only_page_is_vetoed_but_continuous_tone_patch_survives() {
        let text = glyph_page(false);
        let calibration = PageCalibration::estimate(&text, 300.0, CalibrationConfig::default());
        assert!(calibration.valid);
        assert_eq!(
            detect_picture_mask(&text, 300.0, calibration).count_black(),
            0
        );

        let mixed = glyph_page(true);
        let calibration = PageCalibration::estimate(&mixed, 300.0, CalibrationConfig::default());
        let mask = detect_picture_mask(&mixed, 300.0, calibration);
        let photo_pixels = (35..155)
            .flat_map(|y| (185..250).map(move |x| (x, y)))
            .filter(|&(x, y)| mask.get(x, y))
            .count();
        assert!(
            photo_pixels > 2_000,
            "detected only {photo_pixels} photo pixels"
        );
        let text_pixels = (0..160)
            .flat_map(|x| (0..150).map(move |y| (x, y)))
            .filter(|&(x, y)| mask.get(x, y))
            .count();
        assert!(
            text_pixels < 200,
            "misclassified {text_pixels} text-area pixels"
        );
    }

    #[test]
    fn fold_shadow_and_showthrough_have_no_vetted_picture_owner() {
        let mut page = GrayImage::new(760, 300, 245);
        // A full-width fold/edge shadow is large enough to look like a tone
        // candidate but is not page content.
        let mut candidate = BinaryImage::new(page.width(), page.height());
        for y in 0..7 {
            for x in 0..page.width() {
                page.set(x, y, 82);
                candidate.set(x, y, true);
            }
        }
        // The central dark column models a gutter shadow. Offset gray copies
        // of text model show-through without introducing a plate.
        for y in 80..245 {
            for x in 370..390 {
                page.set(x, y, 48);
                candidate.set(x, y, true);
            }
        }
        for line in 0..8 {
            let top = 48 + line * 25;
            for glyph in 0..18 {
                let left = 42 + glyph * 32;
                for y in top..top + 3 {
                    page.set(left, y, 32);
                    page.set(left + 2, y, 32);
                    page.set(left + 7, y, 156);
                    page.set(left + 9, y, 156);
                }
            }
        }
        assert!(candidate.count_black() > 1_000);
        let owner = qualify_picture_owner(&page, &candidate);
        assert_eq!(
            owner.count_black(),
            0,
            "artifact-only tone must be rejected before mode/UI ownership"
        );
    }

    #[test]
    fn pale_spread_gutter_tone_profile_rejects_a_central_narrow_component() {
        let mut page = GrayImage::new(220, 160, 250);
        let mut candidate = BinaryImage::new(page.width(), page.height());
        for y in 0..page.height() {
            for x in 102..118 {
                page.set(x, y, 235);
                candidate.set(x, y, true);
            }
        }

        let owner = qualify_picture_owner(&page, &candidate);
        assert_eq!(
            owner.count_black(),
            0,
            "a pale, vertically persistent spread fold must not become a photo owner"
        );
    }

    /// Paints a landscape spread whose binding shadow sits at `fold_center_x`
    /// instead of on the geometric centre, with a soft full-height tone
    /// depression that only reaches candidate darkness near the foot.
    fn off_center_fold_spread(fold_center_x: usize) -> (GrayImage, BinaryImage) {
        let mut page = GrayImage::new(800, 600, 250);
        let mut candidate = BinaryImage::new(page.width(), page.height());
        for y in 0..page.height() {
            for offset in 0..21 {
                let x = fold_center_x - 10 + offset;
                let depth = 10 + (10 - (offset as i32 - 10).abs()) * 4;
                page.set(x, y, (250 - depth) as u8);
            }
        }
        // Only the darkest foot of the shadow clears binarization, so the
        // component that reaches qualification is 13% of the page height.
        for y in 520..page.height() {
            for x in fold_center_x - 10..fold_center_x + 11 {
                page.set(x, y, 96);
                candidate.set(x, y, true);
            }
        }
        (page, candidate)
    }

    #[test]
    fn off_center_fold_fragment_is_rejected_without_full_column_height() {
        // 540 sits outside the old 40%-62% page-width band (320..496) and
        // beyond the old page-centre tolerance, so both legacy gutter vetoes
        // abstained and the fragment became a "picture".
        for fold_center_x in [400, 500, 540, 300] {
            let (page, candidate) = off_center_fold_spread(fold_center_x);
            let component_height = 600 - 520;
            assert!(
                component_height * 5 < page.height(),
                "fixture must stay under the full-column height rule"
            );
            assert!(
                candidate.count_black() >= PICTURE_OWNER_MIN_COMPONENT_PIXELS,
                "fixture must be large enough to reach the shadow vetoes"
            );

            let owner = qualify_picture_owner(&page, &candidate);
            assert_eq!(
                owner.count_black(),
                0,
                "a fold fragment at x={fold_center_x} must not own tone",
            );
        }
    }

    #[test]
    fn gutter_shadow_reports_the_measured_column_not_the_page_centre() {
        let (page, _) = off_center_fold_spread(540);
        let measured = gutter_shadow(&page).expect("a full-height tone depression is a fold");
        assert!(
            measured.center().abs_diff(540) <= 12,
            "measured fold centre {} must track the painted fold, not {}",
            measured.center(),
            page.width() / 2,
        );
    }

    #[test]
    fn narrow_inset_illustration_clear_of_the_fold_keeps_its_ownership() {
        let (mut page, mut candidate) = off_center_fold_spread(540);
        // A narrow portrait plate in the outer margin of the left leaf: same
        // shape class as the fold fragment, but nowhere near the measured
        // fold column.
        for y in 120..430 {
            for x in 90..150 {
                page.set(x, y, 40 + ((x * 13 + y * 7) % 150) as u8);
                candidate.set(x, y, true);
            }
        }

        let owner = qualify_picture_owner(&page, &candidate);
        let surviving = ComponentMap::from_binary(&owner);
        let plate = surviving
            .components()
            .iter()
            .find(|component| component.left >= 80 && component.right <= 160)
            .expect("the inset plate must keep its ownership");
        assert!(
            plate.area >= 15_000,
            "the whole plate must survive, not a remnant: {}",
            plate.area,
        );
        assert!(
            surviving
                .components()
                .iter()
                .all(|component| component.left < 200),
            "the fold fragment must still be rejected",
        );
    }

    #[test]
    fn dense_full_bleed_photo_owner_survives_leaf_edge_overlap() {
        let mut page = GrayImage::new(500, 340, 8);
        let mut candidate = BinaryImage::new(page.width(), page.height());
        for y in 18..page.height() {
            for x in 18..482 {
                candidate.set(x, y, true);
                if y < 320 {
                    page.set(x, y, 72 + ((x * 17 + y * 29 + x * y % 71) % 164) as u8);
                }
            }
        }
        let border = crate::content::border_artifact_mask(&page);
        let border_overlap = border.and(&candidate).count_black();
        assert!(
            border_overlap >= 16 && border_overlap.saturating_mul(100) >= candidate.count_black(),
            "fixture must exercise the old one-percent edge veto"
        );

        let owner = qualify_picture_owner(&page, &candidate);
        assert_eq!(
            owner.count_black(),
            candidate.count_black(),
            "a dense full-bleed photo cannot be revoked by its authored leaf edge"
        );
    }

    #[test]
    fn partially_detected_photo_grows_into_its_smooth_tonal_lobe() {
        let mut source = GrayImage::new(320, 220, 245);
        let mut candidate = BinaryImage::new(source.width(), source.height());
        let mut continuous_tone = BinaryImage::new(source.width(), source.height());
        for y in 45..176 {
            for x in 60..261 {
                continuous_tone.set(x, y, true);
                source.set(
                    x,
                    y,
                    if x < 145 {
                        48 + ((x * 7 + y * 11) % 28) as u8
                    } else {
                        132 + ((x * 13 + y * 5) % 70) as u8
                    },
                );
            }
        }
        // The flattened detector found only the dark lobe. The smooth lobe
        // is still corroborated by the same distributed tone field.
        for y in 55..166 {
            for x in 70..141 {
                candidate.set(x, y, true);
            }
        }

        let calibration = PageCalibration::estimate(&source, 300.0, CalibrationConfig::default());
        let grown = corroborate_picture_components(
            candidate,
            &continuous_tone,
            &source,
            300.0,
            calibration,
        );
        assert!(
            grown.get(220, 110),
            "tone growth stopped at the dark-lobe detector boundary"
        );
        let owner = qualify_picture_owner(&source, &grown);
        assert!(
            owner.get(220, 110),
            "the vetted union still lost the smooth photo lobe"
        );
        assert!(
            owner.get(100, 110),
            "the original dark-lobe ownership was not retained"
        );
    }

    #[test]
    fn narrow_tall_inset_photo_on_a_single_leaf_is_not_a_central_shadow() {
        let mut page = GrayImage::new(300, 600, 244);
        let mut candidate = BinaryImage::new(page.width(), page.height());
        for y in 100..500 {
            for x in 140..160 {
                candidate.set(x, y, true);
                page.set(x, y, 72 + ((x * 17 + y * 13) % 132) as u8);
            }
        }

        let owner = qualify_picture_owner(&page, &candidate);
        assert_eq!(
            owner.count_black(),
            candidate.count_black(),
            "a narrow-tall inset illustration was mistaken for a fold without gutter evidence"
        );
    }

    #[test]
    fn dense_large_edge_touching_plates_survive_artifact_shaped_vetoes() {
        let mut page = GrayImage::new(500, 400, 244);
        let mut candidate = BinaryImage::new(page.width(), page.height());
        // A large plate with a caption band reaches two leaf edges.
        for y in 0..280 {
            for x in 0..426 {
                candidate.set(x, y, true);
                page.set(x, y, 72 + ((x * 17 + y * 29) % 132) as u8);
            }
        }
        // Two-up plates each occupy less than half the page area, but each
        // spans most of the height and is dense enough to dominate its edge.
        for &(left, right) in &[(0, 220), (280, 500)] {
            for y in 20..380 {
                for x in left..right {
                    candidate.set(x, y, true);
                    page.set(x, y, 84 + ((x * 7 + y * 19) % 112) as u8);
                }
            }
        }
        // A full-width banner is deliberately shorter than half the page but
        // still has authored illustration depth, not fold-strip thickness.
        for y in 340..400 {
            for x in 0..500 {
                candidate.set(x, y, true);
                page.set(x, y, 96);
            }
        }

        let owner = qualify_picture_owner(&page, &candidate);
        assert_eq!(
            owner.count_black(),
            candidate.count_black(),
            "dense large plates were still deleted by edge/shadow-shaped vetoes"
        );
    }

    #[test]
    fn picture_detector_rejects_repeated_text_on_dark_and_tinted_paper() {
        for paper in [72_u8, 112, 152, 192, 232] {
            let page = noisy_text_page(paper, 2);
            let calibration = PageCalibration::estimate(&page, 150.0, CalibrationConfig::default());
            let mask = detect_picture_mask(&page, 150.0, calibration);
            assert_eq!(
                mask.count_black(),
                0,
                "paper shade {paper} produced word-sized photo evidence"
            );
        }
    }

    #[test]
    fn continuous_tone_protection_rejects_uniform_tinted_paper_with_dark_text() {
        for paper in [72_u8, 112, 152, 192, 232] {
            let mut page = GrayImage::new(360, 480, paper);
            for line in 0..14 {
                let top = 38 + line * 27;
                for y in top..top + 7 {
                    for x in 32..328 {
                        if (x + y) % 9 < 5 {
                            page.set(x, y, 18);
                        }
                    }
                }
            }

            let protected = detect_continuous_tone_mask(&page, 150.0);

            assert_eq!(
                protected.count_black(),
                0,
                "uniform paper shade {paper} was mistaken for continuous tone"
            );
        }
    }

    #[test]
    fn continuous_tone_protection_rejects_noisy_and_jpeg_tinted_text_pages() {
        for noise in [2_i16, 6, 10] {
            let page = noisy_text_page(178, noise);
            let protected = detect_continuous_tone_mask(&page, 150.0);
            assert_eq!(
                protected.count_black(),
                0,
                "scanner noise amplitude {noise} became a picture mask"
            );

            let jpeg = jpeg_luma_roundtrip(&page, 42);
            let protected = detect_continuous_tone_mask(&jpeg, 150.0);
            assert_eq!(
                protected.count_black(),
                0,
                "JPEG ringing with noise amplitude {noise} became a picture mask"
            );
        }
    }

    #[test]
    fn continuous_tone_protection_keeps_a_halftone_inside_a_text_page() {
        let mut page = GrayImage::new(480, 600, 218);
        for line in 0..16 {
            let top = 30 + line * 28;
            for y in top..top + 7 {
                for x in 24..210 {
                    if (x + y) % 8 < 5 {
                        page.set(x, y, 24);
                    }
                }
            }
        }
        for y in 120..480 {
            for x in 250..450 {
                let screen = ((x * 17 + y * 29 + (x / 3) * (y / 5)) % 181) as u8;
                page.set(x, y, 32 + screen);
            }
        }

        let protected = detect_continuous_tone_mask(&page, 150.0);
        let protected_photo_pixels = (120..480)
            .flat_map(|y| (250..450).map(move |x| (x, y)))
            .filter(|&(x, y)| protected.get(x, y))
            .count();
        let protected_text_pixels = (0..220)
            .flat_map(|x| (0..520).map(move |y| (x, y)))
            .filter(|&(x, y)| protected.get(x, y))
            .count();

        assert!(
            protected_photo_pixels > 50_000,
            "only {protected_photo_pixels} halftone pixels were protected"
        );
        assert!(
            protected_text_pixels <= 4_500,
            "more than one local context tile leaked into the text area: {protected_text_pixels}"
        );
    }

    #[test]
    fn sparse_print_screen_survives_harness_downsampling() {
        let mut source = GrayImage::new(720, 960, 242);
        for y in (430..720).step_by(7) {
            for x in (160..560).step_by(7) {
                let value = if (x / 7 + y / 7) % 3 == 0 { 75 } else { 155 };
                for dot_y in y..y + 2 {
                    for dot_x in x..x + 2 {
                        source.set(dot_x, dot_y, value);
                    }
                }
            }
        }
        let page = source.downscale_to_fit(360, 480);
        let tile_edge = 30;
        let noise_sigma = estimate_page_noise_sigma(&page, tile_edge);
        let screened_tiles = (0..page.height().div_ceil(tile_edge))
            .flat_map(|tile_y| {
                (0..page.width().div_ceil(tile_edge)).map(move |tile_x| (tile_x, tile_y))
            })
            .filter(|&(tile_x, tile_y)| {
                let left = tile_x * tile_edge;
                let top = tile_y * tile_edge;
                let right = (left + tile_edge).min(page.width());
                let bottom = (top + tile_edge).min(page.height());
                let mut histogram = [0usize; 256];
                for y in top..bottom {
                    for x in left..right {
                        histogram[page.get(x, y) as usize] += 1;
                    }
                }
                let paper_mode = histogram
                    .iter()
                    .enumerate()
                    .max_by_key(|&(_level, count)| count)
                    .map_or(255, |(level, _count)| level) as u8;
                tile_has_screened_tone(&page, left, top, right, bottom, paper_mode, noise_sigma)
            })
            .count();
        assert!(
            screened_tiles >= 4,
            "expected a coherent screened region, found {screened_tiles} tiles"
        );

        let tone = detect_continuous_tone_mask(&page, 150.0);
        let tone_pixels = (215..360)
            .flat_map(|y| (80..280).map(move |x| (x, y)))
            .filter(|&(x, y)| tone.get(x, y))
            .count();
        assert!(
            tone_pixels > 10_000,
            "screen evidence protected only {tone_pixels} photo pixels"
        );

        let calibration = PageCalibration::estimate(&page, 150.0, CalibrationConfig::default());
        let picture = detect_picture_mask(&page, 150.0, calibration);
        let picture_pixels = (215..360)
            .flat_map(|y| (80..280).map(move |x| (x, y)))
            .filter(|&(x, y)| picture.get(x, y))
            .count();
        assert!(
            picture_pixels > 1_000,
            "picture geometry retained only {picture_pixels} screened pixels"
        );
    }

    #[test]
    fn continuous_tone_role_keeps_full_vetted_geometry() {
        let mut evidence = BinaryImage::new(480, 600);
        for y in 100..500 {
            for x in 210..450 {
                evidence.set(x, y, true);
            }
        }
        let alpha = semantic_tone_preservation_alpha(&evidence).unwrap();

        assert!(
            alpha.get(330, 300) >= 240,
            "center of tonal geometry was not retained"
        );
        assert!(
            alpha.get(330, 430) >= 240,
            "light or middle tone geometry was attenuated by darkness"
        );
        assert_eq!(
            alpha.get(30, 30),
            0,
            "uniform paper outside tonal evidence was protected"
        );
    }

    #[test]
    fn photo_role_keeps_smooth_highlights_and_middle_tones() {
        let mut picture = BinaryImage::new(320, 240);
        for y in 35..205 {
            for x in 70..270 {
                picture.set(x, y, true);
            }
        }

        let alpha = photo_tone_preservation_alpha(&picture).unwrap();

        assert!(alpha.get(170, 120) >= 240);
        assert!(
            alpha.get(260, 120) >= 240,
            "pale photo geometry must not be attenuated by pixel darkness"
        );
        assert_eq!(alpha.get(30, 30), 0);
    }

    #[test]
    fn tone_extension_does_not_adopt_an_unrelated_document_cluster() {
        let mut image = GrayImage::new(420, 300, 245);
        let mut tone_seed = BinaryImage::new(420, 300);
        for y in 30..135 {
            for x in 25..190 {
                if x % 12 < 2 || y % 12 < 2 {
                    image.set(x, y, 85);
                }
            }
        }
        for y in 165..270 {
            for x in 230..395 {
                if x % 12 < 2 || y % 12 < 2 {
                    image.set(x, y, 85);
                }
            }
        }
        for y in 60..105 {
            for x in 60..145 {
                tone_seed.set(x, y, true);
            }
        }
        let calibration = PageCalibration::estimate(&image, 150.0, CalibrationConfig::default());

        let extended = extend_tone_mask_for_content(&image, &tone_seed, calibration);

        assert!(extended.get(80, 80));
        assert!(
            !extended.get(300, 220),
            "an unrelated structural cluster became semantic tone"
        );
    }

    #[test]
    fn continuous_tone_context_does_not_fill_component_bounding_boxes() {
        let mut page = GrayImage::new(600, 600, 220);
        let tile = 30;
        for tile_y in 3..17 {
            for tile_x in 3..17 {
                if tile_y >= 6 && tile_x >= 6 {
                    continue;
                }
                for y in tile_y * tile..(tile_y + 1) * tile {
                    for x in tile_x * tile..(tile_x + 1) * tile {
                        page.set(x, y, 28 + ((x * 17 + y * 29) % 190) as u8);
                    }
                }
            }
        }

        let protected = detect_continuous_tone_mask(&page, 150.0);

        assert!(protected.get(4 * tile, 4 * tile));
        assert!(
            !protected.get(11 * tile, 11 * tile),
            "an L-shaped tone component filled its empty rectangular interior"
        );
    }

    #[test]
    fn tone_preservation_refines_coarse_evidence_to_map_and_ink_pixels() {
        let mut normalized = GrayImage::new(320, 240, 252);
        for y in 35..205 {
            for x in 70..270 {
                if (x + y) % 7 < 4 {
                    normalized.set(x, y, 168);
                }
            }
        }
        for y in 50..190 {
            normalized.set(160, y, 24);
        }
        let mut coarse = BinaryImage::new(320, 240);
        for y in 80..160 {
            for x in 100..180 {
                coarse.set(x, y, true);
            }
        }

        let preservation =
            refine_tone_preservation_alpha(&normalized, &normalized, None, Some(&coarse)).unwrap();

        assert!(preservation.get(160, 120) >= 240);
        assert!(
            preservation.get(72, 36) >= 200,
            "component was clipped to the coarse evidence boundary"
        );
        assert!(
            preservation.get(50, 50) == 0,
            "coarse evidence geometry leaked into white paper"
        );
        assert!(
            preservation.get(290, 210) == 0,
            "coarse rectangle edge became output geometry"
        );
    }

    #[test]
    fn tone_preservation_does_not_keep_uniform_noisy_paper_gray() {
        let mut normalized = GrayImage::new(300, 220, 250);
        for y in 0..normalized.height() {
            for x in 0..normalized.width() {
                normalized.set(x, y, 247 + ((x * 17 + y * 29) % 7) as u8);
            }
        }
        for y in 70..150 {
            for x in 40..260 {
                if (x + y) % 13 < 3 {
                    normalized.set(x, y, 45);
                }
            }
        }
        let mut coarse = BinaryImage::new(300, 220);
        for y in 0..coarse.height() {
            for x in 0..coarse.width() {
                coarse.set(x, y, true);
            }
        }

        let preservation =
            refine_tone_preservation_alpha(&normalized, &normalized, None, Some(&coarse)).unwrap();
        let preserved_pixels = preservation
            .data()
            .iter()
            .filter(|&&alpha| alpha >= 128)
            .count();

        assert!(preserved_pixels > 1_000);
        assert!(
            preserved_pixels < 5_000,
            "uniform noisy paper was retained by a coarse evidence mask"
        );
        assert_eq!(preservation.get(10, 10), 0);
    }

    #[test]
    fn paper_center_ignores_dark_borders_left_outside_a_broad_tone_mask() {
        let mut source = GrayImage::new(320, 240, 183);
        let mut coarse = BinaryImage::new(320, 240);
        for y in 12..228 {
            for x in 12..308 {
                coarse.set(x, y, true);
            }
        }
        for x in 0..source.width() {
            source.set(x, 0, 12);
            source.set(x, source.height() - 1, 12);
        }
        for y in 0..source.height() {
            source.set(0, y, 12);
            source.set(source.width() - 1, y, 12);
        }
        for y in 70..170 {
            for x in 85..235 {
                source.set(x, y, 96);
            }
        }

        assert!(
            (183..=193).contains(&dominant_paper_center(&source, Some(&coarse)).unwrap()),
            "dark border samples displaced the paper cluster"
        );
    }

    #[test]
    fn dense_rectangular_picture_component_completes_its_pale_interior() {
        let mut candidate = BinaryImage::new(200, 160);
        for y in 24..136 {
            for x in 30..170 {
                let pale_gap = y >= 105 && (55..145).contains(&x);
                if !pale_gap {
                    candidate.set(x, y, true);
                }
            }
        }

        let completed = complete_dense_picture_rectangles(candidate);

        assert!(completed.get(100, 120));
        assert!(!completed.get(20, 80));
        assert!(!completed.get(180, 80));
    }

    #[test]
    fn sparse_irregular_component_is_not_promoted_to_a_picture_rectangle() {
        let mut candidate = BinaryImage::new(200, 160);
        for y in 24..136 {
            for x in 30..170 {
                if x < 42 || y < 36 {
                    candidate.set(x, y, true);
                }
            }
        }
        let expected_pixels = candidate.count_black();

        let completed = complete_dense_picture_rectangles(candidate);

        assert!(!completed.get(100, 80));
        assert_eq!(completed.count_black(), expected_pixels);
    }

    fn irregular_photo_fixture(fill_missing_with_paper: bool) -> (GrayImage, BinaryImage) {
        let mut source = GrayImage::new(120, 100, 246);
        let mut automatic = BinaryImage::new(120, 100);
        for y in 20..80 {
            for x in 25..95 {
                let owned = x < 37 || y < 32;
                if owned {
                    automatic.set(x, y, true);
                }
                if owned || !fill_missing_with_paper {
                    source.set(x, y, 142 + ((x * 3 + y * 5) % 25) as u8);
                }
            }
        }
        (source, automatic)
    }

    #[test]
    fn irregular_gray_photo_owner_fills_its_tone_continuous_rectangle() {
        let (source, automatic) = irregular_photo_fixture(false);
        let empty_text = BinaryImage::new(source.width(), source.height());

        let rectangular = rectangularize_corroborated_photos(
            &source,
            &automatic,
            &empty_text,
            &empty_text,
            150.0,
        );

        assert!(
            rectangular.get(70, 55),
            "the photo's gray field stayed a hole"
        );
        assert_eq!(rectangular.count_black(), 70 * 60);
        assert!(!rectangular.get(20, 50));
    }

    #[test]
    fn photo_rectangle_does_not_overshoot_onto_clean_paper() {
        let (source, automatic) = irregular_photo_fixture(true);
        let expected_pixels = automatic.count_black();
        let empty_text = BinaryImage::new(source.width(), source.height());

        let rectangular = rectangularize_corroborated_photos(
            &source,
            &automatic,
            &empty_text,
            &empty_text,
            150.0,
        );

        assert!(!rectangular.get(70, 55));
        assert_eq!(rectangular.count_black(), expected_pixels);
    }

    #[test]
    fn photo_rectangle_does_not_swallow_a_caption_line() {
        let (mut source, automatic) = irregular_photo_fixture(false);
        let expected_pixels = automatic.count_black();
        let mut text = BinaryImage::new(source.width(), source.height());
        let mut text_vicinity = BinaryImage::new(source.width(), source.height());
        for y in 58..72 {
            for x in 43..89 {
                text_vicinity.set(x, y, true);
            }
        }
        for glyph in 0..8 {
            let left = 45 + glyph * 5;
            for y in 61..68 {
                for x in left..left + 3 {
                    text.set(x, y, true);
                    source.set(x, y, 28);
                }
            }
        }

        let rectangular =
            rectangularize_corroborated_photos(&source, &automatic, &text, &text_vicinity, 150.0);

        assert!(!rectangular.get(70, 55));
        assert_eq!(rectangular.count_black(), expected_pixels);
    }

    #[test]
    fn halftone_fixture_does_not_turn_body_text_into_picture() {
        let mut image = glyph_page(false);
        for y in 25..165 {
            for x in 180..250 {
                let cell = (x / 4 + y / 4) % 7;
                if x % 4 < 1 + cell % 2 && y % 4 < 1 + (cell / 2) % 2 {
                    image.set(x, y, 35 + (cell * 18) as u8);
                }
            }
        }
        let calibration = PageCalibration::estimate(&image, 300.0, CalibrationConfig::default());
        let mask = detect_picture_mask(&image, 300.0, calibration);
        let text_area_pictures = (0..170)
            .flat_map(|x| (0..150).map(move |y| (x, y)))
            .filter(|&(x, y)| mask.get(x, y))
            .count();
        assert!(
            text_area_pictures < 200,
            "halftone detector leaked into {text_area_pictures} body-text pixels"
        );
    }

    #[test]
    fn content_picture_mask_extends_across_large_line_art_structure() {
        let mut image = GrayImage::new(420, 260, 242);
        for row in 0..8 {
            for column in 0..10 {
                let left = 15 + column * 15;
                let top = 18 + row * 27;
                for y in top..top + 14 {
                    for x in left..left + 8 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            image.set(x, y, 28);
                        }
                    }
                }
            }
        }
        for x in 190..390 {
            image.set(x, 22, 24);
            image.set(x, 224, 24);
        }
        for y in 22..225 {
            image.set(190, y, 24);
            image.set(389, y, 24);
        }
        for row in 0..11 {
            let top = 42 + row * 14;
            for stroke in 0..7 {
                let left = 204 + stroke * 24 + row % 3;
                for offset in 0..14 {
                    image.set(left + offset, top + offset % 3, 28);
                    image.set(left + offset, top + 1 + offset % 3, 28);
                }
            }
        }
        let calibration = PageCalibration::estimate(&image, 300.0, CalibrationConfig::default());
        let base = detect_picture_mask(&image, 300.0, calibration);
        let content = extend_picture_mask_for_content(&image, &base, calibration);
        let line_art_pixels = (22..225)
            .flat_map(|y| (190..390).map(move |x| (x, y)))
            .filter(|&(x, y)| content.get(x, y))
            .count();
        assert!(
            line_art_pixels > 30_000,
            "line-art picture mask covered only {line_art_pixels} pixels"
        );
        assert!(!content.get(20, 20), "unrelated body text was protected");
    }

    #[test]
    fn content_picture_extension_does_not_adopt_the_scanner_bed() {
        let mut image = GrayImage::new(700, 1_000, 236);
        for y in 0..1_000 {
            for x in 0..700 {
                if y < 70 || x >= 610 {
                    image.set(x, y, 0);
                }
            }
        }
        for row in 0..22 {
            let y = 200 + row * 21;
            for x in (62..560).filter(|x| x % 10 < 6) {
                image.set(x, y, 24);
                image.set(x, y + 1, 24);
            }
        }
        let calibration = PageCalibration::estimate(&image, 150.0, CalibrationConfig::default());
        let empty = BinaryImage::new(image.width(), image.height());

        let content = extend_picture_mask_for_content(&image, &empty, calibration);

        assert!(
            !content.get(300, 400),
            "the scanner bed made the page body a picture"
        );

        // A rendered page leaves a pixel of paper along the raster edges.
        for x in 0..700 {
            image.set(x, 0, 236);
            image.set(x, 999, 236);
        }
        for y in 0..1_000 {
            image.set(0, y, 236);
            image.set(699, y, 236);
        }
        let content = extend_picture_mask_for_content(&image, &empty, calibration);

        assert!(
            !content.get(300, 400),
            "a scanner bed one pixel inside the raster made the page body a picture"
        );
    }

    #[test]
    fn content_picture_extension_keeps_an_authored_frame_on_the_page_edge() {
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 2.0,
            x_height_px: 6.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        // A frame's area grows with its perimeter, so from four pixels up it
        // outweighs a text line's height times the page's half-perimeter.
        for frame_width in [2, 4, 6] {
            let mut image = GrayImage::new(400, 300, 242);
            for y in 0..300 {
                for x in 0..400 {
                    if x < frame_width
                        || y < frame_width
                        || x >= 400 - frame_width
                        || y >= 300 - frame_width
                    {
                        image.set(x, y, 24);
                    }
                }
            }
            for row in 0..12 {
                let y = 40 + row * 18;
                for x in 40..360 {
                    image.set(x, y + (x / 7) % 3, 24);
                }
            }
            let empty = BinaryImage::new(image.width(), image.height());

            let content = extend_picture_mask_for_content(&image, &empty, calibration);

            assert!(
                content.get(frame_width / 2, 150) && content.get(200, 150),
                "an authored {frame_width}-pixel frame on the page edge lost its line-art anchor"
            );
        }
    }

    #[test]
    fn content_picture_extension_does_not_adopt_a_remote_frame_cluster() {
        let mut image = GrayImage::new(440, 280, 242);
        for row in 0..11 {
            let y = 45 + row * 16;
            for x in 36..176 {
                image.set(x, y, 24);
                image.set(x, y + 1, 24);
            }
            for x in 264..404 {
                image.set(x, y, 24);
                image.set(x, y + 1, 24);
            }
        }
        let mut seed = BinaryImage::new(image.width(), image.height());
        for y in 80..88 {
            for x in 72..80 {
                seed.set(x, y, true);
            }
        }
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 2.0,
            x_height_px: 6.0,
            valid: true,
            config: CalibrationConfig::default(),
        };

        let content = extend_picture_mask_for_content(&image, &seed, calibration);

        assert!(
            content.get(100, 120),
            "the structure surrounding the tonal seed was not extended"
        );
        assert!(
            !content.get(330, 120),
            "a remote frame cluster became picture-owned crop geometry"
        );
    }

    #[test]
    fn flat_graphic_tone_keeps_sharply_bounded_map_fill() {
        let mut image = GrayImage::new(240, 180, 240);
        for y in 42..142 {
            for x in 64..184 {
                image.set(x, y, 148);
            }
        }
        for y in [70, 96, 122] {
            for line_y in y..y + 3 {
                for x in 48..200 {
                    image.set(x, line_y, 28);
                }
            }
        }

        let alpha = flat_graphic_tone_preservation_alpha(&image)
            .expect("a large map fill needs semantic ownership");

        assert_eq!(alpha.get(120, 90), 255);
        assert_eq!(alpha.get(120, 96), 255);
        assert_eq!(alpha.get(20, 20), 0);
    }

    #[test]
    fn flat_graphic_tone_rejects_smooth_scanner_cloud() {
        let mut image = GrayImage::new(240, 180, 240);
        for y in 0..image.height() {
            for x in 0..image.width() {
                let dx = (x as f64 - 120.0) / 72.0;
                let dy = (y as f64 - 90.0) / 54.0;
                let shadow = 62.0 * (-(dx * dx + dy * dy)).exp();
                image.set(x, y, (240.0 - shadow).round() as u8);
            }
        }

        assert!(flat_graphic_tone_preservation_alpha(&image).is_none());
    }

    #[test]
    fn flat_graphic_tone_rejects_closed_text_and_calibration_strokes() {
        let mut image = GrayImage::new(320, 220, 240);
        for row in 0..5 {
            let top = 28 + row * 30;
            for glyph in 0..16 {
                let left = 24 + glyph * 17;
                for y in top..top + 11 {
                    image.set(left, y, 28);
                    image.set(left + 7, y, 28);
                }
                for x in left..left + 8 {
                    image.set(x, top, 28);
                    image.set(x, top + 10, 28);
                }
                // JPEG/antialias-like middle band around the dark stroke.
                for y in top.saturating_sub(1)..=(top + 11).min(image.height() - 1) {
                    for x in left.saturating_sub(1)..=(left + 8).min(image.width() - 1) {
                        if image.get(x, y) == 240 {
                            image.set(x, y, 156);
                        }
                    }
                }
            }
        }

        assert!(flat_graphic_tone_preservation_alpha(&image).is_none());
    }

    fn polygon(left: f64, top: f64, right: f64, bottom: f64) -> NormalizedZonePolygon {
        NormalizedZonePolygon {
            points: vec![
                NormalizedZonePoint { x: left, y: top },
                NormalizedZonePoint { x: right, y: top },
                NormalizedZonePoint {
                    x: right,
                    y: bottom,
                },
                NormalizedZonePoint { x: left, y: bottom },
            ],
            rotation: OrthogonalRotation::None,
        }
    }

    #[test]
    fn zones_apply_eraser_then_painter_then_eraser_and_fill() {
        let mut mask = BinaryImage::new(100, 100);
        let options = CleanupOptions {
            manual_zones: ManualZones {
                picture: vec![
                    PictureZone {
                        polygon: polygon(0.1, 0.1, 0.9, 0.9),
                        layer: PictureZoneLayer::Painter2,
                    },
                    PictureZone {
                        polygon: polygon(0.0, 0.0, 0.5, 0.5),
                        layer: PictureZoneLayer::Eraser1,
                    },
                    PictureZone {
                        polygon: polygon(0.7, 0.7, 1.0, 1.0),
                        layer: PictureZoneLayer::Eraser3,
                    },
                ],
                fill: vec![polygon(0.45, 0.45, 0.55, 0.55)],
            },
            ..CleanupOptions::default()
        };
        apply_manual_zones(&mut mask, &options);
        assert!(mask.get(20, 20), "painter must win over eraser1");
        assert!(!mask.get(80, 80), "eraser3 must win over painter");
        assert!(!mask.get(50, 50), "fill zones force the binary layer");
        assert!(!mask.get(5, 5));
    }
}
