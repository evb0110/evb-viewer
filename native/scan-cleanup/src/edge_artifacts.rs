//! Acquisition artifacts along the raster edges: scanner beds and their
//! fringes, border rails, and the rails a book's fore-edge or binding shadow
//! leaves down a leaf's sides. Content crops, picture qualification and text
//! tone all exclude these; none of them is page content.

use scan_primitives::{
    morphology::{open, reconstruct_binary},
    threshold::{threshold_local, LocalThreshold},
    BinaryImage, Component, ComponentMap, GrayImage,
};
use std::ops::Range;

/// Rasterizing a page whose size is not a whole number of pixels leaves a
/// pixel of paper along its edges, so an object that close still touches one.
const RASTER_EDGE_SLIVER_PX: usize = 2;

pub(crate) fn touches_raster_edge(component: &Component, width: usize, height: usize) -> bool {
    component.left <= RASTER_EDGE_SLIVER_PX
        || component.top <= RASTER_EDGE_SLIVER_PX
        || component.right + 1 + RASTER_EDGE_SLIVER_PX >= width
        || component.bottom + 1 + RASTER_EDGE_SLIVER_PX >= height
}

/// A thin band running down the left or right page edge: a scanner rail, the
/// dark strip of a book's fore-edge, or the end of a binding shadow. It hugs
/// the edge, often a few pixels inside it where the page's own lighter edge
/// lies beyond, and is many times taller than it is thick. Authored marks near
/// a side edge do not have that shape: a glyph or a rule cut by the edge meets
/// it end-on, and a frame rule sits inside the margin, not in the outer
/// twentieth of the sheet. A band touching the edge counts from a fortieth of
/// the page's height; one inset from it must run at least an eighth of it.
/// Head and tail bars are left to the trim loop, which owns those sides.
///
/// A deskewed page tilts the band, which widens its bounding box. A box wider
/// than the band may be is still a band when every row of it is thin and the
/// row centres drift without jumping, as a straight tilted strip does; line
/// beginnings merged into one shape jump from line to line.
fn is_side_edge_rail(
    components: &ComponentMap,
    component: &Component,
    width: usize,
    height: usize,
) -> bool {
    let length = component.bottom - component.top + 1;
    let box_thickness = component.right - component.left + 1;
    let band = width.div_ceil(20);
    let touching = component.left <= RASTER_EDGE_SLIVER_PX
        || component.right + 1 + RASTER_EDGE_SLIVER_PX >= width;
    let inside_band = component.right < band || component.left + band >= width;
    let long_enough = length * if touching { 40 } else { 8 } >= height;
    if !inside_band || !long_enough {
        return false;
    }
    if box_thickness * 40 <= width {
        return length >= box_thickness.saturating_mul(8);
    }
    let mut widths = Vec::with_capacity(length);
    let mut previous_centre: Option<usize> = None;
    for y in component.top..=component.bottom {
        let mut first = None;
        let mut last = 0;
        for x in component.left..=component.right {
            if components.label_at(x, y) == component.label {
                first.get_or_insert(x);
                last = x;
            }
        }
        let Some(first) = first else {
            continue;
        };
        widths.push(last + 1 - first);
        let centre = (first + last) / 2;
        if previous_centre.is_some_and(|previous| previous.abs_diff(centre) > 2) {
            return false;
        }
        previous_centre = Some(centre);
    }
    widths.sort_unstable();
    let row_thickness = widths
        .get(widths.len() * 9 / 10)
        .copied()
        .unwrap_or(box_thickness);
    row_thickness * 40 <= width && length >= row_thickness.saturating_mul(8)
}

/// Side edge rails, and whether the left and right edges carry one. Besides
/// single bands (`is_side_edge_rail`), edge shading breaks into dashes where it
/// crosses the threshold intermittently, each too short to judge alone; a
/// fore-edge often leaves two parallel strands of them. Dashes count only as
/// a run: pieces ending within a fortieth of the page of one side edge, each
/// taller than wide and clear of all other glyph-sized ink for a fiftieth of
/// the page, that together with the bands along that edge cover a fortieth of
/// it. A glyph cut by the edge always has the rest of its word closer than
/// that.
pub(crate) fn side_edge_rails(binary: &BinaryImage) -> (BinaryImage, [bool; 2]) {
    let (width, height) = (binary.width(), binary.height());
    let components = ComponentMap::from_binary(binary);
    let mut rail = vec![false; components.components().len() + 1];
    for component in components.components() {
        rail[component.label as usize] = is_side_edge_rail(&components, component, width, height);
    }
    let depth_limit = (width / 40).max(2);
    let clearance = (width / 50).max(4);
    // Shading also leaves specks beside its dashes. Only glyph-sized ink can
    // be the word a cut glyph belongs to.
    let owner_area = (width / 50).max(4);
    let band = width.div_ceil(20);
    let mut sides = [false; 2];
    for (index, right_side) in [false, true].into_iter().enumerate() {
        // Distance from this edge to a component's inner side.
        let depth = |component: &Component| {
            if right_side {
                width - 1 - component.left
            } else {
                component.right
            }
        };
        let column = |cross: usize| if right_side { width - 1 - cross } else { cross };
        let mut piece = vec![false; rail.len()];
        for component in components.components() {
            let thickness = component.right - component.left + 1;
            piece[component.label as usize] = !rail[component.label as usize]
                && depth(component) < depth_limit
                && component.bottom + 1 - component.top >= thickness * 2;
        }
        // A band already found is not ink that could own a dash beside it.
        let isolated = components
            .components()
            .iter()
            .filter(|component| piece[component.label as usize])
            .filter(|component| {
                let rows = component.top.saturating_sub(clearance)
                    ..=(component.bottom + clearance).min(height - 1);
                let columns = depth(component) + 1..=(depth(component) + clearance).min(width - 1);
                !rows.clone().any(|y| {
                    columns.clone().any(|cross| {
                        let x = column(cross);
                        let label = components.label_at(x, y) as usize;
                        label != 0
                            && !piece[label]
                            && !rail[label]
                            && components.components()[label - 1].area >= owner_area
                    })
                })
            })
            .collect::<Vec<_>>();
        let side_rails = components
            .components()
            .iter()
            .filter(|component| rail[component.label as usize] && depth(component) < band)
            .collect::<Vec<_>>();
        let mut covered = vec![false; height];
        for component in side_rails.iter().chain(isolated.iter()) {
            covered[component.top..=component.bottom].fill(true);
        }
        if covered.iter().filter(|&&covered| covered).count() * 40 >= height {
            for component in isolated {
                rail[component.label as usize] = true;
            }
            sides[index] = true;
        } else {
            sides[index] = !side_rails.is_empty();
        }
    }
    (
        components.retain(|component| rail[component.label as usize]),
        sides,
    )
}

/// A scanner bed, border rail or edge shadow is one large component attached
/// to the raster edge. It is never page content or line art.
pub(crate) fn is_scanner_border_shadow(component: &Component, width: usize, height: usize) -> bool {
    touches_raster_edge(component, width, height) && component.area > width.max(height) / 3
}

/// Reconstructs the long, edge-attached objects used by content detection as
/// scanner-border evidence. The opening seeds require sustained horizontal or
/// vertical structure before reconstruction, so ordinary edge-touching content
/// is not enough to qualify.
pub(crate) fn border_artifact_mask(working: &GrayImage) -> BinaryImage {
    let binary = threshold_local(
        working,
        25,
        LocalThreshold::Wolf {
            k: 0.5,
            deviation_floor: 3.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        },
    );
    border_artifact_mask_from_binary(working, &binary)
}

pub(crate) fn border_artifact_mask_from_binary(
    working: &GrayImage,
    binary: &BinaryImage,
) -> BinaryImage {
    let horizontal_seed = open(binary, 40, 2);
    let vertical_seed = open(binary, 2, 40);
    let border_candidates = reconstruct_binary(&horizontal_seed, binary)
        .or(&reconstruct_binary(&vertical_seed, binary));
    let retained = ComponentMap::from_binary(&border_candidates).retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        touches_raster_edge(component, working.width(), working.height())
            && (width * 2 >= working.width() || height * 2 >= working.height())
    });
    // A scanner border is usually a thin band hugging the page edge. Threshold
    // bloom on a normalized raster can bridge such a band to the nearest
    // authored structure (observed: a top bar swallowing the running head and
    // its rule through geodesic reconstruction), so the artifact mask is
    // clipped to the same 1/40 edge zone the mode selector uses for border
    // shapes. A solid scanner bed is the exception: rows or columns it covers
    // edge to edge are no authored structure, so the mask follows the bed and
    // its stippled fringe instead of leaving the bed's inner part as content.
    let (width, height) = (working.width(), working.height());
    let row_coverage = |y: usize, span: Range<usize>| {
        let length = span.len().max(1);
        span.filter(|&x| retained.get(x, y)).count() as f64 / length as f64
    };
    let column_coverage = |x: usize, span: Range<usize>| {
        let length = span.len().max(1);
        span.filter(|&y| retained.get(x, y)).count() as f64 / length as f64
    };
    let from_end = |extent: usize, band: Range<usize>| extent - band.end..extent - band.start;
    let top = scanner_bed_depth(
        height,
        width,
        row_coverage,
        column_coverage,
        |depth, band| column_coverage(width - 1 - depth, band),
    );
    let bottom = scanner_bed_depth(
        height,
        width,
        |depth, span| row_coverage(height - 1 - depth, span),
        |depth, band| column_coverage(depth, from_end(height, band)),
        |depth, band| column_coverage(width - 1 - depth, from_end(height, band)),
    );
    let left = scanner_bed_depth(
        width,
        height,
        column_coverage,
        row_coverage,
        |depth, band| row_coverage(height - 1 - depth, band),
    );
    let right = scanner_bed_depth(
        width,
        height,
        |depth, span| column_coverage(width - 1 - depth, span),
        |depth, band| row_coverage(depth, from_end(width, band)),
        |depth, band| row_coverage(height - 1 - depth, from_end(width, band)),
    );
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        retained.get(x, y) && (x < left || x + right >= width || y < top || y + bottom >= height)
    })
}

/// The end of a solid scanner bed along one edge: lines at least 90% covered
/// by the border component, starting inside the 1/40 edge zone and never
/// deeper than a fifth of the page. Zero when the edge has no bed.
fn solid_bed_depth(extent: usize, coverage_at_depth: impl Fn(usize) -> f64) -> usize {
    let zone = extent.div_ceil(40).max(1);
    let limit = extent / 5;
    let Some(start) = (0..zone.min(limit)).find(|&depth| coverage_at_depth(depth) >= 0.9) else {
        return 0;
    };
    (start..limit)
        .find(|&depth| coverage_at_depth(depth) < 0.9)
        .unwrap_or(limit)
}

/// How far from one edge the border mask may reach: the 1/40 edge zone, or a
/// solid scanner bed and the stippled fringe after it, whichever is deeper.
/// A fringe is never deeper than the bed it frays from, and it is measured
/// between the beds the neighbouring edges (`near`, `far`) carry beside it.
fn scanner_bed_depth(
    extent: usize,
    cross_extent: usize,
    along: impl Fn(usize, Range<usize>) -> f64,
    near: impl Fn(usize, Range<usize>) -> f64,
    far: impl Fn(usize, Range<usize>) -> f64,
) -> usize {
    let zone = extent.div_ceil(40).max(1);
    let solid_end = solid_bed_depth(extent, |depth| along(depth, 0..cross_extent));
    if solid_end == 0 {
        return zone;
    }
    let limit = (extent / 5).min(solid_end * 2);
    let band = solid_end..limit.max(solid_end);
    let near_bed = solid_bed_depth(cross_extent, |depth| near(depth, band.clone()));
    let far_bed = solid_bed_depth(cross_extent, |depth| far(depth, band.clone()));
    let span = near_bed..cross_extent.saturating_sub(far_bed).max(near_bed);
    let fringe_end = (solid_end..limit)
        .find(|&depth| along(depth, span.clone()) < 0.2)
        .unwrap_or(limit);
    zone.max(fringe_end)
}
