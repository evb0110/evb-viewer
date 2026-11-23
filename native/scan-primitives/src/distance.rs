use crate::BinaryImage;
use rayon::prelude::*;
use std::collections::VecDeque;

const INF: i64 = i64::MAX / 8;
const PARALLEL_PIXELS: usize = 65_536;
const PARALLEL_BAND_ROWS: usize = 64;

/// Exact squared Euclidean distance to the nearest black pixel.
///
/// The vertical pass keeps unsquared column distances in the narrowest
/// unsigned lane that can index every row (`u16` up to 65,535 rows), and
/// only for one band of rows at a time. A per-band summary of each column's
/// first and last black row carries seeds across bands, so no full-page
/// vertical plane or transpose is allocated. Each row then runs the exact
/// `i64` Felzenszwalb-Huttenlocher lower envelope.
pub fn squared_euclidean_distance(image: &BinaryImage) -> Vec<u32> {
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let parallel = width.saturating_mul(height) >= PARALLEL_PIXELS;
    let band_rows = if parallel { PARALLEL_BAND_ROWS } else { height };
    squared_euclidean_distance_banded(image, band_rows, parallel)
}

fn squared_euclidean_distance_banded(
    image: &BinaryImage,
    band_rows: usize,
    parallel: bool,
) -> Vec<u32> {
    if image.height() == 1 {
        return single_row_transform(image);
    }
    // A lane can hold every row index and distance below `height`, with its
    // maximum left free as the "no seed" sentinel.
    if u16::try_from(image.height()).is_ok() {
        banded_transform::<u16>(image, band_rows, parallel)
    } else if u32::try_from(image.height()).is_ok() {
        banded_transform::<u32>(image, band_rows, parallel)
    } else {
        banded_transform::<usize>(image, band_rows, parallel)
    }
}

fn single_row_transform(image: &BinaryImage) -> Vec<u32> {
    let width = image.width();
    let mut values = vec![INF; width];
    for_each_black(image, 0, |x| values[x] = 0);
    let mut transform = TransformScratch::new(width);
    transform_1d(&values, &mut transform);
    transform
        .output
        .into_iter()
        .map(|distance| distance.min(u32::MAX as i64) as u32)
        .collect()
}

/// Unsigned storage for row indices and unsquared vertical distances.
trait Lane: Copy + Ord + Send + Sync {
    const NONE: Self;
    fn from_index(index: usize) -> Self;
    fn index(self) -> usize;
}

macro_rules! lane {
    ($($lane:ty),*) => {$(
        impl Lane for $lane {
            const NONE: Self = <$lane>::MAX;
            fn from_index(index: usize) -> Self {
                index as $lane
            }
            fn index(self) -> usize {
                self as usize
            }
        }
    )*};
}
lane!(u16, u32, usize);

fn banded_transform<T: Lane>(image: &BinaryImage, band_rows: usize, parallel: bool) -> Vec<u32> {
    let width = image.width();
    let height = image.height();
    let band_rows = band_rows.clamp(1, height);
    let (above, below) = band_seed_carries::<T>(image, band_rows, parallel);
    let mut output = vec![u32::MAX; width * height];
    let band = |scratch: &mut BandScratch<T>, (band, rows): (usize, &mut [u32])| {
        let carries = band * width..(band + 1) * width;
        transform_band(
            image,
            band * band_rows,
            rows,
            &above[carries.clone()],
            &below[carries],
            scratch,
        );
    };
    let band_len = width * band_rows;
    if parallel {
        output
            .par_chunks_mut(band_len)
            .enumerate()
            .for_each_init(|| BandScratch::new(width, band_rows), band);
    } else {
        let mut scratch = BandScratch::new(width, band_rows);
        output
            .chunks_mut(band_len)
            .enumerate()
            .for_each(|item| band(&mut scratch, item));
    }
    output
}

/// Returns, for every band and column, the nearest black row strictly above
/// and strictly below the band.
fn band_seed_carries<T: Lane>(
    image: &BinaryImage,
    band_rows: usize,
    parallel: bool,
) -> (Vec<T>, Vec<T>) {
    let width = image.width();
    let height = image.height();
    let bands = height.div_ceil(band_rows);
    let mut first = vec![T::NONE; bands * width];
    let mut last = vec![T::NONE; bands * width];
    if bands == 1 {
        return (first, last);
    }
    let summarize = |(band, (first, last)): (usize, (&mut [T], &mut [T]))| {
        for y in band * band_rows..((band + 1) * band_rows).min(height) {
            for_each_black(image, y, |x| {
                if first[x] == T::NONE {
                    first[x] = T::from_index(y);
                }
                last[x] = T::from_index(y);
            });
        }
    };
    if parallel {
        first
            .par_chunks_mut(width)
            .zip(last.par_chunks_mut(width))
            .enumerate()
            .for_each(summarize);
    } else {
        first
            .chunks_mut(width)
            .zip(last.chunks_mut(width))
            .enumerate()
            .for_each(summarize);
    }
    // Turn per-band extremes into carries in place: a band's `above` is the
    // last seed of the nearest earlier band that has one, and symmetrically
    // for `below`.
    let mut running = vec![T::NONE; width];
    for band in last.chunks_mut(width) {
        for (carry, seed) in band.iter_mut().zip(&mut running) {
            let band_last = *carry;
            *carry = *seed;
            if band_last != T::NONE {
                *seed = band_last;
            }
        }
    }
    running.fill(T::NONE);
    for band in first.chunks_mut(width).rev() {
        for (carry, seed) in band.iter_mut().zip(&mut running) {
            let band_first = *carry;
            *carry = *seed;
            if band_first != T::NONE {
                *seed = band_first;
            }
        }
    }
    (last, first)
}

fn for_each_black(image: &BinaryImage, y: usize, mut visit: impl FnMut(usize)) {
    let words_per_line = image.words_per_line();
    let row = &image.words()[y * words_per_line..(y + 1) * words_per_line];
    for (word_index, &word) in row.iter().enumerate() {
        let mut bits = word;
        while bits != 0 {
            let offset = bits.leading_zeros() as usize;
            let x = word_index * 32 + offset;
            if x < image.width() {
                visit(x);
            }
            bits &= !(1u32 << (31 - offset));
        }
    }
}

struct BandScratch<T> {
    vertical: Vec<T>,
    nearest: Vec<T>,
    values: Vec<i64>,
    transform: TransformScratch,
}

impl<T: Lane> BandScratch<T> {
    fn new(width: usize, band_rows: usize) -> Self {
        Self {
            vertical: vec![T::NONE; width * band_rows],
            nearest: vec![T::NONE; width],
            values: vec![INF; width],
            transform: TransformScratch::new(width),
        }
    }
}

fn transform_band<T: Lane>(
    image: &BinaryImage,
    first_y: usize,
    output: &mut [u32],
    above: &[T],
    below: &[T],
    scratch: &mut BandScratch<T>,
) {
    let width = image.width();
    let rows = output.len() / width;
    let vertical = &mut scratch.vertical[..rows * width];
    vertical.fill(T::NONE);
    scratch.nearest.copy_from_slice(above);
    for (local_y, row) in vertical.chunks_mut(width).enumerate() {
        let y = first_y + local_y;
        for_each_black(image, y, |x| scratch.nearest[x] = T::from_index(y));
        for (distance, &seed) in row.iter_mut().zip(&scratch.nearest) {
            if seed != T::NONE {
                *distance = T::from_index(y - seed.index());
            }
        }
    }
    scratch.nearest.copy_from_slice(below);
    for (local_y, row) in vertical.chunks_mut(width).enumerate().rev() {
        let y = first_y + local_y;
        for_each_black(image, y, |x| scratch.nearest[x] = T::from_index(y));
        for (distance, &seed) in row.iter_mut().zip(&scratch.nearest) {
            if seed != T::NONE {
                *distance = (*distance).min(T::from_index(seed.index() - y));
            }
        }
    }
    for (row, output_row) in vertical.chunks(width).zip(output.chunks_mut(width)) {
        for (value, &distance) in scratch.values.iter_mut().zip(row) {
            *value = if distance == T::NONE {
                INF
            } else {
                square(distance.index())
            };
        }
        transform_1d(&scratch.values, &mut scratch.transform);
        for (target, &distance) in output_row.iter_mut().zip(&scratch.transform.output) {
            *target = distance.min(u32::MAX as i64) as u32;
        }
    }
}

/// Finds positive 3x3 local maxima in a squared-distance field.
///
/// Flat maxima are collapsed to one deterministic representative per
/// 4-connected plateau. Infinite values are not peaks.
pub fn find_peaks(distances: &[u32], width: usize, height: usize) -> Vec<(usize, usize)> {
    assert_eq!(distances.len(), width.saturating_mul(height));
    let mut maxima = vec![false; distances.len()];
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let value = distances[index];
            if value == 0 || value == u32::MAX {
                continue;
            }
            maxima[index] = (y.saturating_sub(1)..=(y + 1).min(height - 1)).all(|neighbor_y| {
                (x.saturating_sub(1)..=(x + 1).min(width - 1))
                    .all(|neighbor_x| distances[neighbor_y * width + neighbor_x] <= value)
            });
        }
    }

    let mut visited = vec![false; distances.len()];
    let mut peaks = Vec::new();
    let mut queue = VecDeque::new();
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if !maxima[index] || visited[index] {
                continue;
            }
            let value = distances[index];
            visited[index] = true;
            queue.push_back((x, y));
            let mut representative = (x, y);
            while let Some((current_x, current_y)) = queue.pop_front() {
                representative = representative.min((current_x, current_y));
                for (neighbor_x, neighbor_y) in neighbors4(current_x, current_y, width, height) {
                    let neighbor_index = neighbor_y * width + neighbor_x;
                    if maxima[neighbor_index]
                        && !visited[neighbor_index]
                        && distances[neighbor_index] == value
                    {
                        visited[neighbor_index] = true;
                        queue.push_back((neighbor_x, neighbor_y));
                    }
                }
            }
            peaks.push(representative);
        }
    }
    peaks
}

fn neighbors4(
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> impl Iterator<Item = (usize, usize)> {
    let mut neighbors = [(0, 0); 4];
    let mut count = 0;
    if x > 0 {
        neighbors[count] = (x - 1, y);
        count += 1;
    }
    if x + 1 < width {
        neighbors[count] = (x + 1, y);
        count += 1;
    }
    if y > 0 {
        neighbors[count] = (x, y - 1);
        count += 1;
    }
    if y + 1 < height {
        neighbors[count] = (x, y + 1);
        count += 1;
    }
    neighbors.into_iter().take(count)
}

/// Squares an index or distance in `i64`. Squaring in `usize` first would
/// overflow on 32-bit targets once a page is 65,536 pixels long.
fn square(value: usize) -> i64 {
    let value = value as i64;
    value * value
}

struct TransformScratch {
    seeds: Vec<usize>,
    envelope: Vec<usize>,
    boundaries: Vec<f64>,
    output: Vec<i64>,
}

impl TransformScratch {
    fn new(len: usize) -> Self {
        Self {
            seeds: Vec::with_capacity(len),
            envelope: vec![0; len],
            boundaries: vec![0.0; len.saturating_add(1)],
            output: vec![0; len],
        }
    }
}

fn transform_1d(values: &[i64], scratch: &mut TransformScratch) {
    scratch.envelope.resize(values.len(), 0);
    scratch
        .boundaries
        .resize(values.len().saturating_add(1), 0.0);
    scratch.output.resize(values.len(), 0);
    scratch.seeds.clear();
    scratch.seeds.extend(
        values
            .iter()
            .enumerate()
            .filter_map(|(index, &value)| (value < INF).then_some(index)),
    );
    if scratch.seeds.is_empty() {
        scratch.output.fill(INF);
        return;
    }
    scratch.boundaries[0] = f64::NEG_INFINITY;
    let mut top = 0usize;
    scratch.envelope[0] = scratch.seeds[0];
    scratch.boundaries[1] = f64::INFINITY;
    for &seed in &scratch.seeds[1..] {
        let mut intersection;
        loop {
            let previous = scratch.envelope[top];
            intersection = ((values[seed] + square(seed)) - (values[previous] + square(previous)))
                as f64
                / (2.0 * (seed as f64 - previous as f64));
            if intersection > scratch.boundaries[top] || top == 0 {
                break;
            }
            top -= 1;
        }
        top += 1;
        scratch.envelope[top] = seed;
        scratch.boundaries[top] = intersection;
        scratch.boundaries[top + 1] = f64::INFINITY;
    }
    let mut candidate = 0usize;
    for (x, target) in scratch.output.iter_mut().enumerate() {
        while scratch.boundaries[candidate + 1] < x as f64 {
            candidate += 1;
        }
        let seed = scratch.envelope[candidate];
        let d = x.abs_diff(seed) as i64;
        *target = d * d + values[seed];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference_transform_1d(values: &[i64]) -> Vec<i64> {
        let seeds: Vec<usize> = values
            .iter()
            .enumerate()
            .filter_map(|(index, &value)| (value < INF).then_some(index))
            .collect();
        if seeds.is_empty() {
            return vec![INF; values.len()];
        }
        let mut envelope = vec![0usize; seeds.len()];
        let mut boundaries = vec![f64::NEG_INFINITY; seeds.len() + 1];
        let mut top = 0usize;
        envelope[0] = seeds[0];
        boundaries[1] = f64::INFINITY;
        for &seed in &seeds[1..] {
            let mut intersection;
            loop {
                let previous = envelope[top];
                intersection = ((values[seed] + square(seed))
                    - (values[previous] + square(previous))) as f64
                    / (2.0 * (seed as f64 - previous as f64));
                if intersection > boundaries[top] || top == 0 {
                    break;
                }
                top -= 1;
            }
            top += 1;
            envelope[top] = seed;
            boundaries[top] = intersection;
            boundaries[top + 1] = f64::INFINITY;
        }
        let mut output = vec![0; values.len()];
        let mut candidate = 0usize;
        for (x, target) in output.iter_mut().enumerate() {
            while boundaries[candidate + 1] < x as f64 {
                candidate += 1;
            }
            let seed = envelope[candidate];
            let d = x.abs_diff(seed) as i64;
            *target = d * d + values[seed];
        }
        output
    }

    #[test]
    fn reused_transform_scratch_is_bit_identical_to_allocating_reference() {
        let mut state = 0x4544_545f_5034_4153_u64;
        let mut scratch = TransformScratch::new(97);
        for case in 0..200 {
            let len = 1 + case % 97;
            let mut values = vec![INF; len];
            for (index, value) in values.iter_mut().enumerate() {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                if state >> 61 != 0 || index == case % len {
                    *value = ((state >> 32) % 10_000) as i64;
                }
            }
            transform_1d(&values, &mut scratch);
            assert_eq!(scratch.output, reference_transform_1d(&values));
        }
    }

    #[test]
    fn matches_brute_force_for_deterministic_small_patterns() {
        for salt in 0..13 {
            let mut image = BinaryImage::new(9, 7);
            for y in 0usize..7 {
                for x in 0usize..9 {
                    image.set(x, y, (x * 17 + y * 11 + salt) % 19 == 0);
                }
            }
            image.set(salt % 9, salt % 7, true);
            let actual = squared_euclidean_distance(&image);
            for y in 0usize..7 {
                for x in 0usize..9 {
                    let expected = (0..7)
                        .flat_map(|sy| (0..9).map(move |sx| (sx, sy)))
                        .filter(|&(sx, sy)| image.get(sx, sy))
                        .map(|(sx, sy)| {
                            let dx = x.abs_diff(sx);
                            let dy = y.abs_diff(sy);
                            (dx * dx + dy * dy) as u32
                        })
                        .min()
                        .unwrap();
                    assert_eq!(actual[y * 9 + x], expected);
                }
            }
        }
    }

    /// The previous implementation: a full-page `i64` vertical plane of
    /// squared column distances followed by the row envelope.
    fn reference_squared_euclidean_distance(image: &BinaryImage) -> Vec<u32> {
        let width = image.width();
        let height = image.height();
        let mut vertical = vec![INF; width * height];
        for x in 0..width {
            let mut last = None;
            for y in 0..height {
                if image.get(x, y) {
                    last = Some(y);
                    vertical[y * width + x] = 0;
                } else if let Some(seed) = last {
                    let d = y - seed;
                    vertical[y * width + x] = square(d);
                }
            }
            last = None;
            for y in (0..height).rev() {
                if image.get(x, y) {
                    last = Some(y);
                } else if let Some(seed) = last {
                    let d = seed - y;
                    vertical[y * width + x] = vertical[y * width + x].min(square(d));
                }
            }
        }
        let mut output = vec![u32::MAX; width * height];
        for y in 0..height {
            let row = &vertical[y * width..(y + 1) * width];
            let transformed = reference_transform_1d(row);
            for (target, distance) in output[y * width..(y + 1) * width]
                .iter_mut()
                .zip(transformed)
            {
                *target = distance.min(u32::MAX as i64) as u32;
            }
        }
        output
    }

    fn random_binary(
        width: usize,
        height: usize,
        density_shift: u32,
        state: &mut u64,
    ) -> BinaryImage {
        let mut image = BinaryImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                *state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                image.set(x, y, *state >> (64 - density_shift) == 0);
            }
        }
        image
    }

    fn assert_all_lanes_match_reference(image: &BinaryImage) {
        let expected = reference_squared_euclidean_distance(image);
        assert_eq!(squared_euclidean_distance(image), expected);
        if image.width() == 0 || image.height() == 0 {
            return;
        }
        for band_rows in [1, 3, 64, image.height()] {
            for parallel in [false, true] {
                if u16::try_from(image.height()).is_ok() {
                    assert_eq!(
                        banded_transform::<u16>(image, band_rows, parallel),
                        expected
                    );
                }
                assert_eq!(
                    banded_transform::<u32>(image, band_rows, parallel),
                    expected
                );
                assert_eq!(
                    banded_transform::<usize>(image, band_rows, parallel),
                    expected
                );
            }
        }
    }

    #[test]
    fn banded_lanes_are_bit_exact_to_the_full_plane_reference() {
        let mut state = 0x5045_4454_5f4d_3350_u64;
        for (width, height, density_shift) in [
            (1, 1, 1),
            (9, 7, 3),
            (33, 65, 4),
            (31, 129, 7),
            (257, 257, 4),
            (255, 257, 9),
            (300, 300, 14),
        ] {
            let image = random_binary(width, height, density_shift, &mut state);
            assert_all_lanes_match_reference(&image);
        }
    }

    #[test]
    fn distance_edge_cases_match_the_reference() {
        for (width, height) in [(0, 0), (0, 5), (5, 0)] {
            assert!(squared_euclidean_distance(&BinaryImage::new(width, height)).is_empty());
        }
        let mut single = BinaryImage::new(1, 1);
        assert_eq!(squared_euclidean_distance(&single), vec![u32::MAX]);
        single.set(0, 0, true);
        assert_eq!(squared_euclidean_distance(&single), vec![0]);

        for (width, height) in [(1, 1), (17, 5), (300, 300)] {
            let white = BinaryImage::new(width, height);
            assert_all_lanes_match_reference(&white);
            assert!(squared_euclidean_distance(&white)
                .iter()
                .all(|&distance| distance == u32::MAX));
            let black = white.invert();
            assert_all_lanes_match_reference(&black);
            assert!(squared_euclidean_distance(&black)
                .iter()
                .all(|&distance| distance == 0));
        }

        // A lone seed in one column leaves other columns to the horizontal
        // envelope, and a wide row exercises the parallel row path.
        let mut wide = BinaryImage::new(70_001, 1);
        wide.set(35_000, 0, true);
        assert_all_lanes_match_reference(&wide);
        let mut lone = BinaryImage::new(300, 300);
        lone.set(299, 0, true);
        assert_all_lanes_match_reference(&lone);
    }

    #[test]
    fn tall_columns_cross_the_u16_lane_limit_exactly() {
        // 65,535 rows is the tallest page a `u16` lane holds; one more row
        // falls back to `u32`. Both distances must reach the far end exactly.
        for height in [usize::from(u16::MAX), usize::from(u16::MAX) + 1] {
            let mut image = BinaryImage::new(2, height);
            image.set(0, 0, true);
            image.set(1, height / 2, true);
            let expected = reference_squared_euclidean_distance(&image);
            let actual = squared_euclidean_distance(&image);
            assert_eq!(actual, expected, "height {height}");
            // The bottom of column 0 is nearest to column 1's midpoint seed.
            let rise = (height - 1 - height / 2) as u64;
            assert_eq!(u64::from(actual[(height - 1) * 2]), 1 + rise * rise);
            // Column 1's top pixel is nearest to column 0's top seed.
            assert_eq!(actual[1], 1);
            for band_rows in [64, 4_099] {
                assert_eq!(banded_transform::<u32>(&image, band_rows, true), expected);
            }
        }
    }

    #[test]
    fn distances_past_65_535_pixels_square_in_64_bits() {
        // A 32-bit `usize` overflows on 65,536 squared; the transform must
        // widen before squaring in both the vertical and horizontal pass.
        let mut column = BinaryImage::new(1, 65_537);
        column.set(0, 0, true);
        let distances = squared_euclidean_distance(&column);
        for (y, &distance) in distances.iter().enumerate() {
            let expected = (y as u64 * y as u64).min(u64::from(u32::MAX));
            assert_eq!(u64::from(distance), expected, "row {y}");
        }
        assert_eq!(distances[65_535], 65_535 * 65_535);
        assert_eq!(distances[65_536], u32::MAX);

        let mut row = BinaryImage::new(65_537, 1);
        row.set(0, 0, true);
        row.set(65_536, 0, true);
        let distances = squared_euclidean_distance(&row);
        for (x, &distance) in distances.iter().enumerate() {
            let nearest = x.min(65_536 - x) as u64;
            assert_eq!(u64::from(distance), nearest * nearest, "column {x}");
        }
        assert_eq!(distances[32_768], 1 << 30);
    }

    #[test]
    fn peak_finder_collapses_four_connected_plateaus() {
        let distances = [
            0, 0, 0, 0, 0, //
            0, 4, 4, 0, 3, //
            0, 4, 4, 0, 0, //
            0, 0, 0, 0, 0,
        ];
        assert_eq!(find_peaks(&distances, 5, 4), vec![(1, 1), (4, 1)]);
    }
}
