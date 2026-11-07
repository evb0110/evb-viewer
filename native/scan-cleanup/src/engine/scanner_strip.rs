//! The scanner strip: the dark shadow a scanner bed leaves down a leaf's side.
//! It is shading, not print, so the paper cleanup whitens it.

use crate::edge_artifacts::side_edge_rails;
use scan_primitives::{BinaryImage, ComponentMap};

/// The scanner strip down a side edge: a side-edge rail more than two strokes
/// wide that runs nearly the full raster height. A printed rule is
/// about one stroke wide, and an authored frame rule stops short of the page's
/// height, so neither is a strip.
pub(crate) fn scanner_strip(marks: &BinaryImage, stroke: f64) -> BinaryImage {
    let height = marks.height();
    let rails = ComponentMap::from_binary(&side_edge_rails(marks, None).0);
    rails.retain(|component| {
        (component.right + 1 - component.left) as f64 > 2.0 * stroke
            && (component.bottom + 1 - component.top) * 10 >= height * 9
    })
}
