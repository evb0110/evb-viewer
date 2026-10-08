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
/// lies beyond, and is many times taller than it is wide. Authored marks near
/// a side edge do not have that shape: a glyph or a rule cut by the edge meets
/// it end-on, and a frame rule sits inside the margin, not in the outer
/// twentieth of the sheet. A band touching the edge counts from a fortieth of
/// the page's height; one inset from it must run at least an eighth of it.
/// Head and tail bars are left to the trim loop, which owns those sides.
fn is_side_edge_rail(component: &Component, width: usize, height: usize) -> bool {
    let thickness = component.right - component.left + 1;
    let length = component.bottom - component.top + 1;
    let band = width.div_ceil(20);
    let touching = component.left <= RASTER_EDGE_SLIVER_PX
        || component.right + 1 + RASTER_EDGE_SLIVER_PX >= width;
    let inside_band = component.right < band || component.left + band >= width;
    thickness * 40 <= width
        && length >= thickness.saturating_mul(8)
        && if touching {
            length * 40 >= height
        } else {
            inside_band && length * 8 >= height
        }
}

/// Side edge rails, and whether the left and right edges carry one. Besides
/// single bands (`is_side_edge_rail`), edge shading breaks into dashes where it
/// crosses the threshold intermittently, each too short to judge alone. Dashes
/// count only as a run: pieces within a hundredth of the page of one side edge
/// and ending within a fortieth of it, each taller than wide and clear of all
/// other glyph-sized ink for a fiftieth of the page, that together with any
/// rail along that edge cover a fortieth of it. A glyph cut by the edge always
/// has the rest of its word closer than that.
pub(crate) fn side_edge_rails(binary: &BinaryImage) -> (BinaryImage, [bool; 2]) {
    let (width, height) = (binary.width(), binary.height());
    let components = ComponentMap::from_binary(binary);
    let mut rail = vec![false; components.components().len() + 1];
    for component in components.components() {
        rail[component.label as usize] = is_side_edge_rail(component, width, height);
    }
    let outer_limit = (width / 100).max(RASTER_EDGE_SLIVER_PX);
    let depth_limit = (width / 40).max(2);
    let clearance = (width / 50).max(4);
    // Shading also leaves specks beside its dashes. Only glyph-sized ink can
    // be the word a cut glyph belongs to.
    let owner_area = outer_limit * 2;
    let band = width.div_ceil(20);
    let mut sides = [false; 2];
    for (index, right_side) in [false, true].into_iter().enumerate() {
        // Distance from this edge to a component's outer and inner sides.
        let outer_gap = |component: &Component| {
            if right_side {
                width - 1 - component.right
            } else {
                component.left
            }
        };
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
                && outer_gap(component) <= outer_limit
                && depth(component) < depth_limit
                && component.bottom + 1 - component.top >= thickness * 2;
        }
        // A rail already found is not ink that could own a dash beside it.
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
                        binary.get(x, y)
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
