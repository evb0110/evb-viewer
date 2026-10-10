//! Printed weight of faint marks kept in Auto black and white.
//!
//! A preserved faint mark is admitted as a whole component, so its footprint
//! includes every pixel that is merely paper-tinted. Printing that footprint
//! as ink inflates a pencil line into a solid blob. Each mark prints the
//! pixels at least a third as deep below paper as its own deepest pixel, plus
//! the darkest footprint path that joins any core pieces the threshold split
//! apart, so every footprint component still prints as one component.

use crate::mode_select::grayscale_percentile;
use scan_primitives::{BinaryImage, ComponentMap, GrayImage};

/// Fraction of a mark's deepest pixel that a pixel must reach to print. Half
/// (the midpoint between paper and the darkest pixel) breaks handwriting into
/// fragments: on the owner's pencil note the darkest pixels are sparse and the
/// letters vanish. A third keeps the letter shapes, and the printed area stays
/// within the source's dark core (3,630 pixels against 3,963 pixels at
/// least 20 levels below paper). It is the threshold of the round-1 core; the
/// connecting path below restores the strokes it splits.
const CORE_DEPTH_FRACTION: f64 = 1.0 / 3.0;

/// Splits one census of faint-stroke candidates into the `preserved` footprint
/// and the `shallow` components that were not preserved. `shallow` is indexed
/// by component label minus one.
pub(crate) fn split(
    map: &ComponentMap,
    shallow: &[bool],
    preserved: BinaryImage,
) -> [Option<BinaryImage>; 2] {
    let rejected = map
        .retain(|component| shallow[component.label as usize - 1])
        .subtract(&preserved);
    [preserved, rejected].map(|mask| (mask.count_black() > 0).then_some(mask))
}

/// Keeps, within each component of an optional `strokes` mask on a page's
/// gray, the pixels whose depth below the page's paper reaches a third of that
/// component's deepest pixel, and joins the core pieces of each component
/// through the footprint.
pub(crate) fn printed_core(strokes: Option<&BinaryImage>, gray: &GrayImage) -> Option<BinaryImage> {
    let strokes = strokes?;
    let paper = grayscale_percentile(gray, 0.7);
    let width = gray.width();
    let depths: Vec<u32> = (0..gray.height())
        .flat_map(|y| (0..width).map(move |x| u32::from(paper.saturating_sub(gray.get(x, y)))))
        .collect();
    let map = ComponentMap::from_binary(strokes);
    let deepest = map.maximum_values_by_component(&depths);
    let core = BinaryImage::from_fn_parallel(width, gray.height(), |x, y| {
        strokes.get(x, y)
            && f64::from(depths[y * width + x])
                >= CORE_DEPTH_FRACTION * f64::from(deepest[map.label_at(x, y) as usize])
    });
    Some(join_core_pieces(strokes, &core, &depths))
}

/// Adds the footprint pixels that connect the pieces of `core` lying in one
/// footprint component. Footprint pixels are nodes with 8-connectivity, and an
/// edge is as deep as its shallower end. Kruskal's algorithm builds the maximum
/// spanning forest of the footprint, so the path between any two pixels in it
/// is the darkest path between them, one pixel wide. Repeatedly removing the
/// non-core leaves keeps only the paths between core pixels: a footprint
/// component whose core is connected loses nothing else, and a split core is
/// rejoined through its darkest connection.
fn join_core_pieces(footprint: &BinaryImage, core: &BinaryImage, depths: &[u32]) -> BinaryImage {
    let width = footprint.width();
    let mut pixels = Vec::new();
    for y in 0..footprint.height() {
        for x in 0..width {
            if footprint.get(x, y) {
                pixels.push(y * width + x);
            }
        }
    }
    let is_core = |node: usize| core.get(pixels[node] % width, pixels[node] / width);
    let mut edges = Vec::new();
    for (node, &pixel) in pixels.iter().enumerate() {
        let (x, y) = (pixel % width, pixel / width);
        for (dx, dy) in [(1, 0), (-1, 1), (0, 1), (1, 1)] {
            let (Some(nx), Some(ny)) = (x.checked_add_signed(dx), y.checked_add_signed(dy)) else {
                continue;
            };
            if nx >= width || ny >= footprint.height() {
                continue;
            }
            let neighbour = ny * width + nx;
            if let Ok(other) = pixels.binary_search(&neighbour) {
                let depth = depths[pixel].min(depths[neighbour]);
                edges.push((depth, node as u32, other as u32));
            }
        }
    }
    edges.sort_unstable_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then((left.1, left.2).cmp(&(right.1, right.2)))
    });
    let mut parents: Vec<u32> = (0..pixels.len() as u32).collect();
    let mut tree = vec![Vec::new(); pixels.len()];
    for &(_, left, right) in &edges {
        if find(&mut parents, left) != find(&mut parents, right) {
            union(&mut parents, left, right);
            tree[left as usize].push(right as usize);
            tree[right as usize].push(left as usize);
        }
    }
    let mut degree: Vec<usize> = tree.iter().map(Vec::len).collect();
    let mut pruned = vec![false; pixels.len()];
    let mut leaves: Vec<usize> = (0..pixels.len())
        .filter(|&node| !is_core(node) && degree[node] <= 1)
        .collect();
    while let Some(node) = leaves.pop() {
        if pruned[node] {
            continue;
        }
        pruned[node] = true;
        for &next in &tree[node] {
            if !pruned[next] {
                degree[next] -= 1;
                if !is_core(next) && degree[next] <= 1 {
                    leaves.push(next);
                }
            }
        }
    }
    let mut printed = core.clone();
    for (node, &pixel) in pixels.iter().enumerate() {
        if !pruned[node] {
            printed.set(pixel % width, pixel / width, true);
        }
    }
    printed
}

fn find(parents: &mut [u32], node: u32) -> u32 {
    let mut root = node;
    while parents[root as usize] != root {
        root = parents[root as usize];
    }
    let mut current = node;
    while parents[current as usize] != root {
        let next = parents[current as usize];
        parents[current as usize] = root;
        current = next;
    }
    root
}

fn union(parents: &mut [u32], left: u32, right: u32) {
    let (left_root, right_root) = (find(parents, left), find(parents, right));
    if left_root != right_root {
        parents[right_root.max(left_root) as usize] = right_root.min(left_root);
    }
}

#[cfg(test)]
mod tests {
    use super::printed_core;
    use crate::mode_select::{faint_stroke_masks, luminance_evidence};
    use scan_primitives::{BinaryImage, ComponentMap, GrayImage};

    /// Paper at 224 with a diagonal pencil line: its centre pixels reach 161 and
    /// the pixels one step off the centre sit at 205, paper-tinted but shallower
    /// than a third of the centre's depth. A 4x4 dark speck sits apart from the
    /// line. A dark printed bar sets the page's ink depth, so the pencil counts
    /// as faint.
    fn pencil_page() -> GrayImage {
        let mut image = GrayImage::new(120, 120, 224);
        for y in 5..10 {
            for x in 60..100 {
                image.set(x, y, 30);
            }
        }
        for i in 10..110 {
            image.set(i, i, 161);
            image.set(i + 1, i, 205);
            image.set(i, i + 1, 205);
        }
        for y in 20..24 {
            for x in 80..84 {
                image.set(x, y, 154);
            }
        }
        image
    }

    /// `pencil_page` with a lighter middle: along the diagonal, the centre
    /// pixels for i in 40..70 read 205 instead of 161. Their flanks are already
    /// paper-tinted, so the middle drops out of the core while the footprint
    /// still runs through it and joins the two darker ends.
    fn lighter_middle_page() -> GrayImage {
        let mut image = GrayImage::new(120, 120, 224);
        for y in 5..10 {
            for x in 60..100 {
                image.set(x, y, 30);
            }
        }
        for i in 10..110 {
            image.set(i, i, if (40..70).contains(&i) { 205 } else { 161 });
            image.set(i + 1, i, 205);
            image.set(i, i + 1, 205);
        }
        image
    }

    fn component_count(mask: &BinaryImage) -> usize {
        ComponentMap::from_binary(mask).components().len()
    }

    #[test]
    fn faint_stroke_prints_its_core_and_a_speck_is_not_preserved() {
        let image = pencil_page();
        let [preserved, _] = faint_stroke_masks(&image, luminance_evidence(&image));
        let preserved = preserved.expect("the pencil line is a preserved faint stroke");
        assert!((80..84).all(|x| (20..24).all(|y| !preserved.get(x, y))));

        let printed = printed_core(Some(&preserved), &image).expect("the line prints");
        let black: Vec<(usize, usize)> = (0..120)
            .flat_map(|y| (0..120).map(move |x| (x, y)))
            .filter(|&(x, y)| printed.get(x, y))
            .collect();
        // Only the line's darkest pixels print; the paper-tinted flanks do not.
        assert_eq!(black.len(), 100, "{black:?}");
        assert!(black.iter().all(|&(x, y)| x == y && (10..110).contains(&x)));
    }

    #[test]
    fn faint_stroke_with_a_lighter_middle_prints_one_thinner_component() {
        let image = lighter_middle_page();
        let [preserved, _] = faint_stroke_masks(&image, luminance_evidence(&image));
        let preserved = preserved.expect("the pencil line is a preserved faint stroke");
        assert_eq!(component_count(&preserved), 1);

        let printed = printed_core(Some(&preserved), &image).expect("the line prints");
        assert_eq!(component_count(&printed), 1, "the middle must stay joined");
        assert!(printed.count_black() < preserved.count_black());
        assert!(printed.get(20, 20) && printed.get(90, 90));
    }
}
