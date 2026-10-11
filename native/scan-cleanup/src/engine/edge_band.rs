//! The leaf's edge band: printed matter never sits in it, so text ink there is
//! scanner shadow or rail, not page content.

use crate::edge_artifacts::side_edge_rails;
use scan_primitives::{BinaryImage, Component, ComponentMap, GrayImage, Rect};

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

/// Owned ink in the conservative and the cleaned rendition, minus the ink the
/// edge pass classifies as shadow or rail. Shadow is excluded by two tests: a
/// rail, and shadow the text mask claims in the band. Scanner shadow reaches
/// the text mask in the band, so that ink is not page content: counting it
/// would make the guard restore the shadow cleanup removed.
pub(crate) fn owned_ink_pixels(
    conservative: &BinaryImage,
    cleaned: &BinaryImage,
    ownership: &BinaryImage,
) -> (usize, usize) {
    let edge_removed = rail_removal(conservative, None, [None, Some(ownership), None])
        .or(&shadow_read_as_text(conservative, ownership));
    let count = |binary: &BinaryImage| binary.and(ownership).subtract(&edge_removed).count_black();
    (count(conservative), count(cleaned))
}

/// Band ink of a component that is mostly unowned dark ink. Scanner shadow the
/// text mask claims there is shadow read as text: its owned pixels sit inside
/// a component of shadow, while print in the band stands alone. Only band
/// pixels are marked, so owned print inside the interior still counts.
fn shadow_read_as_text(conservative: &BinaryImage, ownership: &BinaryImage) -> BinaryImage {
    let (width, height) = (conservative.width(), conservative.height());
    let components = ComponentMap::from_binary(conservative);
    let labels = components.components().len() + 1;
    let (mut owned, mut unowned) = (vec![0usize; labels], vec![0usize; labels]);
    for y in 0..height {
        for x in 0..width {
            let label = components.label_at(x, y) as usize;
            if label != 0 {
                if ownership.get(x, y) {
                    owned[label] += 1;
                } else {
                    unowned[label] += 1;
                }
            }
        }
    }
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        let label = components.label_at(x, y) as usize;
        label != 0 && !in_leaf_interior(x, width) && unowned[label] > owned[label]
    })
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

/// Clamps a mapped page rectangle to the raster on every side. A deskewed
/// page can map a few pixels past any raster edge.
fn clamp_to_raster(page: Rect, width: usize, height: usize) -> Rect {
    let (left, top) = (page.x.max(0.0), page.y.max(0.0));
    let right = page.right().min(width as f64);
    let bottom = page.bottom().min(height as f64);
    Rect::new(left, top, right - left, bottom - top)
}

/// The pixels the edge pass removes from `binary` within `page` (the whole
/// raster when `None`): each side-edge rail that carries no print inside the
/// interior. A rail's own columns go: in each row, the columns from the
/// raster-edge side as wide as the rail. Its other unowned pixels go too. Print
/// the masks own, stuck to the rail beyond its columns, stays.
pub(crate) fn rail_removal(
    binary: &BinaryImage,
    page: Option<Rect>,
    masks: [Option<&BinaryImage>; 3],
) -> BinaryImage {
    let (width, height) = (binary.width(), binary.height());
    let page = page.map(|page| clamp_to_raster(page, width, height));
    let rails = ComponentMap::from_binary(&side_edge_rails(binary, page).0);
    let owned = masks
        .into_iter()
        .flatten()
        .fold(BinaryImage::new(width, height), |owned, mask| {
            owned.or(mask)
        });
    let mut body = BinaryImage::new(width, height);
    let removable: Vec<bool> = std::iter::once(false)
        .chain(rails.components().iter().map(|component| {
            let removable = !touches_interior_print(&rails, component, masks, width);
            if removable {
                mark_rail_body(&rails, component, &mut body);
            }
            removable
        }))
        .collect();
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        let label = rails.label_at(x, y) as usize;
        label != 0 && removable[label] && (!owned.get(x, y) || body.get(x, y))
    })
}

/// The first and last column of `component` in row `y`.
fn row_extent(
    components: &ComponentMap,
    component: &Component,
    y: usize,
) -> Option<(usize, usize)> {
    let mut extent: Option<(usize, usize)> = None;
    for x in component.left..=component.right {
        if components.label_at(x, y) == component.label {
            extent = Some((extent.map_or(x, |(first, _)| first), x));
        }
    }
    extent
}

/// Marks `component`'s own columns in `removed`: in each row, the columns from
/// the raster-edge side, as wide as the rail's 90th-percentile row span. A stub
/// of print that meets the rail in a few rows is wider than the rail there and
/// is left standing.
fn mark_rail_body(components: &ComponentMap, component: &Component, removed: &mut BinaryImage) {
    let width = removed.width();
    let from_left = component.left <= width - 1 - component.right;
    let rows: Vec<(usize, (usize, usize))> = (component.top..=component.bottom)
        .filter_map(|y| row_extent(components, component, y).map(|extent| (y, extent)))
        .collect();
    let mut spans: Vec<usize> = rows
        .iter()
        .map(|(_, (first, last))| last + 1 - first)
        .collect();
    spans.sort_unstable();
    let Some(&thickness) = spans.get(spans.len() * 9 / 10) else {
        return;
    };
    for (y, (first, last)) in rows {
        let columns = if from_left {
            first..(first + thickness).min(last + 1)
        } else {
            (last + 1).saturating_sub(thickness).max(first)..last + 1
        };
        for x in columns.filter(|&x| components.label_at(x, y) == component.label) {
            removed.set(x, y, true);
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
