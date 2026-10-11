//! The scanner strip: the dark shadow a scanner bed leaves down a leaf's side.
//! It is shading, not print, so the paper cleanup whitens it.

use crate::edge_artifacts::side_edge_rails;
use scan_primitives::{BinaryImage, ComponentMap};

/// The scanner strip down a side edge: a side-edge rail more than two strokes
/// wide. A printed rule is about one stroke wide, so a rail that wide is the
/// scanner's shadow. A narrower rule along the raster edge is still print.
pub(crate) fn scanner_strip(marks: &BinaryImage, stroke: f64) -> BinaryImage {
    let rails = ComponentMap::from_binary(&side_edge_rails(marks, None).0);
    rails.retain(|component| (component.right + 1 - component.left) as f64 > 2.0 * stroke)
}
