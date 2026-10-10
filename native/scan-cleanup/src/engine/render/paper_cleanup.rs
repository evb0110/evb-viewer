//! Grayscale cleanup whitens unmarked paper and isolated dust, keeping marks'
//! tone and halo. The picture owner is never touched.

use super::*;
use scan_primitives::Component;

/// Ink contrast against nearby paper, excluding slow paper gradients.
const MARK_CONTRAST: u8 = 24;
/// Strong solid ink also survives without nearby paper.
const SOLID_MARK_CONTRAST: u8 = 64;
/// Dark pages have no light paper to clean.
const MIN_PAPER: u8 = 160;

pub(crate) fn whiten_unmarked_paper(
    gray: &mut GrayImage,
    picture: Option<&BinaryImage>,
    calibration: PageCalibration,
    dpi: f64,
) {
    let (width, height) = (gray.width(), gray.height());
    if width == 0 || height == 0 {
        return;
    }
    let scale = dpi.max(1.0) / calibration.effective_dpi.max(1.0);
    let (stroke, x_height) = if calibration.valid {
        (
            calibration.stroke_width_px * scale,
            calibration.x_height_px * scale,
        )
    } else {
        (dpi / 150.0, dpi / 18.0)
    };
    let page_paper = paper_reference(gray);
    if page_paper < MIN_PAPER {
        return;
    }
    let paper_radius = (stroke.round() as usize).max(4);
    let paper = erode_gray(gray, paper_radius, paper_radius);
    let marks = BinaryImage::from_fn_parallel(width, height, |x, y| {
        let value = gray.get(x, y);
        let depth = page_paper.saturating_sub(value);
        // Both sides of a soft core contribute stroke-scale contrast;
        // a one-sided paper gradient cannot seed it.
        let opposed_contrast = |dx, dy| {
            gray.get(x.saturating_sub(dx), y.saturating_sub(dy))
                .min(gray.get((x + dx).min(width - 1), (y + dy).min(height - 1)))
                .saturating_sub(value)
                .saturating_mul(2)
        };
        paper.get(x, y).saturating_sub(value) >= MARK_CONTRAST
            || depth >= SOLID_MARK_CONTRAST
            || (depth >= MARK_CONTRAST
                && opposed_contrast(paper_radius, 0).max(opposed_contrast(0, paper_radius))
                    >= MARK_CONTRAST)
    });
    let speck_area = (stroke * stroke).round().max(4.0) as usize;
    let reach = ((2.0 * x_height).round() as usize).max(4);
    let components = ComponentMap::from_binary(&marks);
    let specks = components.retain(|component| component.area <= speck_area);
    // A speck stays near a larger mark or in a group whose combined ink is
    // larger than a speck. Specks within reach meet after growing by half of it.
    let near_large = dilate(&marks.subtract(&specks), reach, reach);
    let groups = ComponentMap::from_binary(&dilate(&specks, reach.div_ceil(2), reach.div_ceil(2)));
    let mut speck_area_per_group = vec![0usize; groups.components().len() + 1];
    let group_of = |component: &Component| {
        (component.top..=component.bottom)
            .flat_map(|y| (component.left..=component.right).map(move |x| (x, y)))
            .find(|&(x, y)| components.label_at(x, y) == component.label)
            .map_or(0, |(x, y)| groups.label_at(x, y) as usize)
    };
    for component in components.components() {
        if component.area <= speck_area {
            speck_area_per_group[group_of(component)] += component.area;
        }
    }
    let kept = components.retain(|component| {
        component.area > speck_area
            || speck_area_per_group[group_of(component)] > speck_area
            || (component.top..=component.bottom).any(|y| {
                (component.left..=component.right)
                    .any(|x| components.label_at(x, y) == component.label && near_large.get(x, y))
            })
    });
    let cores = BinaryImage::from_fn_parallel(width, height, |x, y| {
        kept.get(x, y) || page_paper.saturating_sub(gray.get(x, y)) >= MARK_CONTRAST
    });
    let kept = dilate(&kept, paper_radius, paper_radius).and(&cores);
    let halo = ((x_height / 2.0).round() as usize).max(2);
    let keep = dilate(&kept, halo, halo);
    for y in 0..height {
        for x in 0..width {
            if !keep.get(x, y) && !picture.is_some_and(|mask| mask.get(x, y)) {
                gray.set(x, y, 255);
            }
        }
    }
}

#[cfg(test)]
#[path = "paper_cleanup_tests.rs"]
mod tests;
