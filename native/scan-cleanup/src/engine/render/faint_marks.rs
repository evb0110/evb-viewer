//! Which shallow marks print in black and white.
//!
//! Show-through, the soft rim of a shadow and paper grain can cross the
//! black-and-white cut as shallow, soft components, and the bleed filter
//! removes them. A pencil note or a light rule is just as shallow and soft, but
//! it is a coherent stroke: one long, thin line whose core stands clear of the
//! paper. Such a stroke prints whole, cut at half its own depth, whatever the
//! threshold kept of it.

use super::*;
use crate::{background::smooth_for_binarization, bw::LOCAL_MIDPOINT_MIN_DEPTH};

/// A faint stroke's core lies at least this far below its paper. Paper grain,
/// show-through and the shading along a scan's edge stay shallower.
const FAINT_STROKE_CORE_DEPTH: u8 = 40;
/// Print is deeper: a core reaching this fraction of the page's ink depth is
/// left to the threshold.
const FAINT_STROKE_MAX_PAGE_DEPTH_FRACTION: f64 = 0.4;
/// A written stroke or a rule runs at least this far, along its length and
/// across the page; the letters of a blind stamp and stray fibres are shorter.
const FAINT_STROKE_MIN_LENGTH_MM: f64 = 6.0;
/// Pencil and hairline rules are narrower than this. Show-through, blurred by
/// the paper it shines through, is wider, and so are a smudge and a patch of
/// grain once the gaps between its specks are closed.
const FAINT_STROKE_MAX_WIDTH_MM: f64 = 0.45;
/// Where strokes meet, closing their gaps leaves a little width; a stroke may
/// be wider than the limit over at most this share of its closed area.
const FAINT_STROKE_MAX_WIDE_FRACTION: f64 = 0.1;
/// The shading along a scan's edge forms long faint lines too: a straight line
/// along an edge, this close to it, is left to the threshold.
const FAINT_STROKE_EDGE_BAND_FRACTION: f64 = 0.03;
/// The paper beside a stroke is the brightest smoothed pixel within this reach.
const FAINT_STROKE_PAPER_RADIUS_MM: f64 = 2.0;

/// Removes the shallow, soft components of `binary` that the source shows as
/// bleed, and prints the page's coherent faint strokes whole.
pub(super) fn filter_soft_shallow_bleed_components(
    binary: &BinaryImage,
    raw: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
    local_route: bool,
) -> BinaryImage {
    debug_assert_eq!(binary.width(), raw.width());
    debug_assert_eq!(binary.height(), raw.height());
    debug_assert!(picture_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    debug_assert!(text_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    if binary.count_black() == 0 {
        return binary.clone();
    }

    const LARGE_CRISPNESS_FLOOR: f64 = 24.0;
    const LARGE_SHALLOW_DEPTH: u8 = 72;
    let crispness_floor = f64::from(BLEED_CRISPNESS_FLOOR);
    let shallow_depth = BLEED_SHALLOW_DEPTH;

    let gradient_radius = (dpi * 0.12 / 25.4).round().clamp(1.0, 4.0) as usize;
    let boundary_radius = (dpi * 0.07 / 25.4).round().clamp(1.0, 3.0) as usize;
    let boundary = erode(binary, boundary_radius, boundary_radius);
    let (raw_max, raw_min) = rayon::join(
        || erode_gray(raw, gradient_radius, gradient_radius),
        || dilate_gray(raw, gradient_radius, gradient_radius),
    );
    let components = ComponentMap::from_binary(binary);
    let (raw_sums, raw_counts) = components.gray_sums_by_component(raw);
    let mut gradient_sums = vec![0u64; components.components().len() + 1];
    let mut gradient_counts = vec![0usize; components.components().len() + 1];
    let paper = paper_reference(raw);
    let shallow_floor = paper.saturating_sub(shallow_depth);
    let mut deep_pixels = vec![0usize; components.components().len() + 1];
    let mut text_overlap = vec![0usize; components.components().len() + 1];
    let mut protected = vec![false; components.components().len() + 1];
    let protected_picture = picture_mask.map(|mask| {
        let radius = picture_protection_radius(dpi);
        dilate(mask, radius, radius)
    });
    for y in 0..binary.height() {
        for x in 0..binary.width() {
            if !binary.get(x, y) {
                continue;
            }
            let label = components.label_at(x, y) as usize;
            if protected_picture
                .as_ref()
                .is_some_and(|mask| mask.get(x, y))
            {
                protected[label] = true;
            }
            if raw.get(x, y) < shallow_floor {
                deep_pixels[label] += 1;
            }
            if text_mask.is_some_and(|mask| mask.get(x, y)) {
                text_overlap[label] += 1;
            }
            if !boundary.get(x, y) {
                gradient_sums[label] +=
                    u64::from(raw_max.get(x, y).saturating_sub(raw_min.get(x, y)));
                gradient_counts[label] += 1;
            }
        }
    }
    let area_ceiling = ((dpi.max(1.0) * 2.0 / 25.4).powi(2)).round().max(16.0) as usize;
    let underline_major_extent = (dpi.max(1.0) * 15.0 / 25.4).round().max(24.0) as usize;
    let underline_max_thickness = (dpi.max(1.0) * 2.0 / 25.4).round().max(2.0) as usize;
    let underline_max_gap = (dpi.max(1.0) * 14.0 / 25.4).round().max(8.0) as usize;
    let underline_components = components.components().iter().fold(
        vec![false; components.components().len() + 1],
        |mut flags, component| {
            let label = component.label as usize;
            let width = component.right - component.left + 1;
            let height = component.bottom - component.top + 1;
            let text_row_above = {
                let left = component.left;
                let right = component.right.min(binary.width().saturating_sub(1));
                let top = component.top.saturating_sub(underline_max_gap);
                (top..component.top).any(|y| {
                    (left..=right).any(|x| {
                        text_mask.is_some_and(|mask| mask.get(x, y))
                            || text_vicinity_mask.is_some_and(|mask| mask.get(x, y))
                    })
                })
            };
            let horizontal_rule = width >= underline_major_extent
                && width >= height.saturating_mul(4)
                && height <= underline_max_thickness;
            let has_depth_or_crispness = deep_pixels[label].saturating_mul(4) >= component.area
                || (gradient_counts[label] > 0
                    && gradient_sums[label] as f64 / gradient_counts[label] as f64
                        >= LARGE_CRISPNESS_FLOOR);
            flags[label] = horizontal_rule
                && text_overlap[label] == 0
                && text_row_above
                && has_depth_or_crispness;
            flags
        },
    );
    let retained = components.retain(|component| {
        let label = component.label as usize;
        if protected[label]
            || underline_components[label]
            || gradient_counts[label] == 0
            || raw_counts[label] == 0
        {
            return true;
        }
        let mean = raw_sums[label] as f64 / raw_counts[label] as f64;
        let crispness = gradient_sums[label] as f64 / gradient_counts[label] as f64;
        if component.area <= area_ceiling {
            !(crispness < crispness_floor && mean >= f64::from(paper.saturating_sub(shallow_depth)))
        } else {
            !(crispness < LARGE_CRISPNESS_FLOOR
                && mean >= f64::from(paper.saturating_sub(LARGE_SHALLOW_DEPTH)))
        }
    });
    let strokes = coherent_faint_strokes(binary, raw, protected_picture.as_ref(), dpi);
    // A local threshold (Wolf, Sauvola) normalizes contrast per window, so
    // heavy show-through can cross it: a bleed rule that crosses a running
    // head then merges with the glyphs into one component that the verdict
    // above rightly keeps, and the merged strike must be removed pixelwise. A
    // bleed pixel is simultaneously shallow and locally soft, while a crisp
    // print's glyph pixel is either deep or crisp. The midpoint route cuts each
    // stroke relative to its own ink, so faint bleed never reaches its stencil;
    // there the same test would only erase the blurred hairlines of soft scans.
    if !local_route {
        return retained.or(&strokes);
    }
    BinaryImage::from_fn_parallel(retained.width(), retained.height(), |x, y| {
        let label = components.label_at(x, y) as usize;
        retained.get(x, y)
            && (underline_components[label]
                || raw.get(x, y) < shallow_floor
                || f64::from(raw_max.get(x, y).saturating_sub(raw_min.get(x, y)))
                    >= crispness_floor
                || protected_picture
                    .as_ref()
                    .is_some_and(|mask| mask.get(x, y)))
    })
    .or(&strokes)
}

#[derive(Clone, Copy, Default)]
struct FaintGroup {
    area: usize,
    boundary: usize,
    touches_picture: bool,
    closed: usize,
    wide: usize,
}

/// The coherent faint strokes on a page whose print is `binary`, each cut at
/// half its core depth. A pencil stroke's pressure varies, so its pieces are
/// grouped across gaps of a few pixels.
fn coherent_faint_strokes(
    binary: &BinaryImage,
    raw: &GrayImage,
    picture_owner: Option<&BinaryImage>,
    dpi: f64,
) -> BinaryImage {
    let (width, height) = (raw.width(), raw.height());
    let none = BinaryImage::new(width, height);
    let mut ink = [0usize; 256];
    for y in 0..height {
        for (x, &value) in raw.row(y).iter().enumerate() {
            if binary.get(x, y) {
                ink[usize::from(value)] += 1;
            }
        }
    }
    let ink_total = ink.iter().sum::<usize>();
    let mut cumulative = 0usize;
    let Some(ink_core) = ink.iter().position(|&count| {
        cumulative += count;
        cumulative * 10 > ink_total
    }) else {
        return none;
    };
    let page_paper = paper_reference(raw);
    let core_ceiling =
        f64::from(page_paper.saturating_sub(ink_core as u8)) * FAINT_STROKE_MAX_PAGE_DEPTH_FRACTION;
    if core_ceiling <= f64::from(FAINT_STROKE_CORE_DEPTH) {
        return none;
    }
    let px_per_mm = dpi.max(1.0) / 25.4;
    let paper_radius = (px_per_mm * FAINT_STROKE_PAPER_RADIUS_MM).round().max(1.0) as usize;
    let paper = erode_gray(
        &smooth_for_binarization(raw, dpi),
        paper_radius,
        paper_radius,
    );
    let depth = |x: usize, y: usize| i16::from(paper.get(x, y)) - i16::from(raw.get(x, y));
    let faint = BinaryImage::from_fn_parallel(width, height, |x, y| {
        depth(x, y) >= LOCAL_MIDPOINT_MIN_DEPTH
    });
    let grouped = dilate(&faint, 2, 2);
    let groups = ComponentMap::from_binary(&grouped);
    let max_width = px_per_mm * FAINT_STROKE_MAX_WIDTH_MM;
    let half_width = (max_width / 2.0).ceil().max(1.0) as usize;
    let closed = erode(&grouped, 2, 2);
    let wide = erode(&closed, half_width, half_width);
    let mut stats = vec![FaintGroup::default(); groups.components().len() + 1];
    for y in 0..height {
        for x in 0..width {
            let label = groups.label_at(x, y) as usize;
            if label == 0 {
                continue;
            }
            let group = &mut stats[label];
            group.touches_picture |= picture_owner.is_some_and(|owner| owner.get(x, y));
            group.closed += usize::from(closed.get(x, y));
            group.wide += usize::from(wide.get(x, y));
            if !faint.get(x, y) {
                continue;
            }
            group.area += 1;
            let edge = (y.saturating_sub(1)..=(y + 1).min(height - 1)).any(|ny| {
                (x.saturating_sub(1)..=(x + 1).min(width - 1)).any(|nx| !faint.get(nx, ny))
            });
            group.boundary +=
                usize::from(edge || x == 0 || y == 0 || x + 1 == width || y + 1 == height);
        }
    }
    let band_x = (width as f64 * FAINT_STROKE_EDGE_BAND_FRACTION) as usize;
    let band_y = (height as f64 * FAINT_STROKE_EDGE_BAND_FRACTION) as usize;
    let min_length = px_per_mm * FAINT_STROKE_MIN_LENGTH_MM;
    let mut strokes = none;
    for component in groups.components() {
        let group = stats[component.label as usize];
        let length = group.boundary as f64 / 2.0;
        let (extent_x, extent_y) = (
            component.right - component.left + 1,
            component.bottom - component.top + 1,
        );
        let edge_line = ((component.left < band_x || component.right + band_x >= width)
            && extent_y >= 4 * extent_x)
            || ((component.top < band_y || component.bottom + band_y >= height)
                && extent_x >= 4 * extent_y);
        let coherent = !group.touches_picture
            && (group.wide as f64) < group.closed as f64 * FAINT_STROKE_MAX_WIDE_FRACTION
            && !edge_line
            && extent_x.max(extent_y) as f64 >= min_length
            && length >= min_length;
        if !coherent {
            continue;
        }
        let in_group =
            |x: usize, y: usize| groups.label_at(x, y) == component.label && faint.get(x, y);
        let mut depths = [0usize; 256];
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if in_group(x, y) {
                    depths[depth(x, y).clamp(0, 255) as usize] += 1;
                }
            }
        }
        let mut below = 0usize;
        let core = depths
            .iter()
            .position(|&count| {
                below += count;
                below * 10 >= group.area * 9
            })
            .unwrap_or(0) as i16;
        if core < i16::from(FAINT_STROKE_CORE_DEPTH) || f64::from(core) >= core_ceiling {
            continue;
        }
        let cut = (core / 2).max(LOCAL_MIDPOINT_MIN_DEPTH);
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if in_group(x, y) && depth(x, y) >= cut {
                    strokes.set(x, y, true);
                }
            }
        }
    }
    strokes
}
