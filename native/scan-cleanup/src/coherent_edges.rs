//! Dark-side edge structure that keeps a blank-looking leaf from being erased:
//! standalone glyphs and short aligned text.

use crate::edge_artifacts::side_edge_rails;
use crate::mode_select::BLANK_EDGE_DIFFERENCE;
use scan_primitives::{BinaryImage, ComponentMap, GrayImage};

/// Global coverage is intentionally not sufficient to erase a page: a short
/// word or page number can occupy less than the blank-coverage hysteresis. This
/// retains compact, connected dark-side edge structures while ignoring
/// isolated sensor noise. It is relative to neighbouring pixels, so changing
/// the paper from light gray to dark gray does not change the verdict.
pub(crate) fn has_coherent_edge_structure(image: &GrayImage) -> bool {
    let mut edges = BinaryImage::new(image.width(), image.height());
    for y in 0..image.height() {
        for x in 0..image.width() {
            let value = image.get(x, y);
            let neighbors = [(x > 0).then(|| (x - 1, y)), (y > 0).then(|| (x, y - 1))];
            for (neighbor_x, neighbor_y) in neighbors.into_iter().flatten() {
                let neighbor = image.get(neighbor_x, neighbor_y);
                if value.abs_diff(neighbor) >= BLANK_EDGE_DIFFERENCE {
                    if value <= neighbor {
                        edges.set(x, y, true);
                    } else {
                        edges.set(neighbor_x, neighbor_y, true);
                    }
                }
            }
        }
    }

    let minimum_height = ((image.height() as f64 * 0.003).round() as usize).clamp(2, 6);
    let minimum_area = minimum_height.saturating_mul(3);
    let maximum_width = (image.width() / 5).max(1);
    let maximum_height = (image.height() / 5).max(1);
    let (rails, _) = side_edge_rails(&edges, None);
    let components = ComponentMap::from_binary(&edges.subtract(&rails));
    let candidates = components
        .components()
        .iter()
        .filter(|component| {
            let width = component.right - component.left + 1;
            let height = component.bottom - component.top + 1;
            let border_attached = component.left == 0
                || component.top == 0
                || component.right + 1 == image.width()
                || component.bottom + 1 == image.height();
            !border_attached
                && width >= 2
                && height >= minimum_height
                && width <= maximum_width
                && height <= maximum_height
                && component.area >= minimum_area
        })
        .collect::<Vec<_>>();

    // Preserve larger standalone marks and short aligned text. Isolated
    // sensor noise still lacks their scale or neighbouring baseline.
    if candidates.iter().any(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        height >= minimum_height.saturating_mul(3)
            && component.area >= minimum_area.saturating_mul(2)
            && width.saturating_mul(8) >= height
            && height.saturating_mul(8) >= width
    }) {
        return true;
    }

    candidates.iter().enumerate().any(|(index, left)| {
        candidates.iter().skip(index + 1).any(|right| {
            let left_height = left.bottom - left.top + 1;
            let right_height = right.bottom - right.top + 1;
            let maximum_glyph_height = left_height.max(right_height);
            let minimum_glyph_height = left_height.min(right_height);
            let left_center = left.top + left_height / 2;
            let right_center = right.top + right_height / 2;
            let vertical_offset = left_center.abs_diff(right_center);
            let horizontal_gap = if left.right < right.left {
                right.left - left.right - 1
            } else if right.right < left.left {
                left.left - right.right - 1
            } else {
                return false;
            };
            maximum_glyph_height <= minimum_glyph_height.saturating_mul(2)
                && vertical_offset <= maximum_glyph_height / 2
                && horizontal_gap <= maximum_glyph_height.saturating_mul(4)
        })
    })
}
