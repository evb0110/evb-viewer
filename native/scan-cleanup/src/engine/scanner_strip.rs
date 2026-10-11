//! The scanner strip: the dark shadow a scanner bed leaves down a leaf's side.
//! It is shading, not print, so the paper cleanup whitens it.

use crate::edge_artifacts::side_edge_rails;
use scan_primitives::{BinaryImage, Component, ComponentMap};

/// The scanner strip down a side edge: a side-edge rail more than two strokes
/// wide, on a side whose rails run the full raster height. A printed rule is
/// about one stroke wide, and an authored frame rule stops short of the page's
/// height, so neither is a strip.
pub(crate) fn scanner_strip(marks: &BinaryImage, stroke: f64) -> BinaryImage {
    let (width, height) = (marks.width(), marks.height());
    let rails = ComponentMap::from_binary(&side_edge_rails(marks, None).0);
    let right_side = |component: &Component| component.left > width - 1 - component.right;
    let mut covered = [vec![false; height], vec![false; height]];
    for component in rails.components() {
        covered[usize::from(right_side(component))][component.top..=component.bottom].fill(true);
    }
    let full_height =
        covered.map(|rows| rows.iter().filter(|&&row| row).count() * 10 >= height * 9);
    rails.retain(|component| {
        (component.right + 1 - component.left) as f64 > 2.0 * stroke
            && full_height[usize::from(right_side(component))]
    })
}
