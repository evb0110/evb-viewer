//! The leaf's edge band: printed matter never sits in it, so text ink there is
//! scanner shadow or rail, not page content.

use crate::edge_artifacts::side_edge_rails;
use scan_primitives::{BinaryImage, Component, ComponentMap, GrayImage};

/// Width of the leaf edge band that carries the fold shadow and the scanner
/// rail rather than page content. Page margins are wider than this at any scan
/// resolution, so no printed matter falls inside the band.
pub(crate) const LEAF_EDGE_BAND_FRACTION: f64 = 0.04;

/// Whether column `x` lies outside the leaf's edge band. Printed matter never
/// sits in the band, so only interior evidence shows print.
pub(crate) fn in_leaf_interior(x: usize, width: usize) -> bool {
    let band = (width as f64 * LEAF_EDGE_BAND_FRACTION) as usize;
    x >= band && x + band < width
}

/// Printed matter never sits in the edge band, so a text line that reaches the
/// band owns only scanner shadow there. That ink is not owned page ink:
/// counting it would make the guard restore the shadow cleanup removed.
pub(crate) fn owned_ink_pixels(binary: &BinaryImage, ownership: &BinaryImage) -> usize {
    let width = binary.width();
    let interior =
        BinaryImage::from_fn_parallel(width, binary.height(), |x, _| in_leaf_interior(x, width));
    binary.and(ownership).and(&interior).count_black()
}

/// The scanner strip down a side edge: a side-edge rail more than two strokes
/// wide. A printed rule is about one stroke wide, so a rail that wide is the
/// scanner's shadow. A narrower rule along the raster edge is still print.
pub(crate) fn scanner_strip(marks: &BinaryImage, stroke: f64) -> BinaryImage {
    let rails = ComponentMap::from_binary(&side_edge_rails(marks, None).0);
    rails.retain(|component| (component.right + 1 - component.left) as f64 > 2.0 * stroke)
}

/// Whitens every pixel outside `keep`, except picture-owned pixels. A scanner
/// strip is whitened even under the picture owner: its shading reads as photo
/// tone, but it is shadow, not a picture.
pub(crate) fn whiten_unkept(
    gray: &mut GrayImage,
    keep: &BinaryImage,
    picture: Option<&BinaryImage>,
    strip: &BinaryImage,
) {
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            let picture_owned = picture.is_some_and(|mask| mask.get(x, y));
            if strip.get(x, y) || (!keep.get(x, y) && !picture_owned) {
                gray.set(x, y, 255);
            }
        }
    }
}

/// Whether a rail component carries print. Text and vicinity masks count only
/// inside the leaf's interior, because a text line's extent can run out to a
/// rail. A picture mask counts anywhere, so a rail beside a photograph stays.
pub(crate) fn touches_interior_print(
    components: &ComponentMap,
    component: &Component,
    masks: [Option<&BinaryImage>; 3],
    width: usize,
) -> bool {
    masks.into_iter().enumerate().any(|(index, mask)| {
        mask.is_some_and(|mask| {
            (component.top..=component.bottom).any(|y| {
                (component.left..=component.right).any(|x| {
                    components.label_at(x, y) == component.label
                        && mask.get(x, y)
                        && (index == 0 || in_leaf_interior(x, width))
                })
            })
        })
    })
}
