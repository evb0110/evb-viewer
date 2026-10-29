use crate::BinaryImage;
use rayon::prelude::*;
use std::collections::VecDeque;

const INF: i64 = i64::MAX / 8;

/// Exact squared Euclidean distance to the nearest black pixel.
pub fn squared_euclidean_distance(image: &BinaryImage) -> Vec<u32> {
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Vec::new();
    }
    if width.saturating_mul(height) >= 65_536 {
        return squared_euclidean_distance_parallel(image);
    }
    squared_euclidean_distance_serial(image)
}

fn squared_euclidean_distance_serial(image: &BinaryImage) -> Vec<u32> {
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
                vertical[y * width + x] = (d * d) as i64;
            }
        }
        last = None;
        for y in (0..height).rev() {
            if image.get(x, y) {
                last = Some(y);
            } else if let Some(seed) = last {
                let d = seed - y;
                vertical[y * width + x] = vertical[y * width + x].min((d * d) as i64);
            }
        }
    }
    let mut output = vec![u32::MAX; width * height];
    let mut scratch = TransformScratch::new(width);
    for y in 0..height {
        let row = &vertical[y * width..(y + 1) * width];
        transform_1d(row, &mut scratch);
        for (target, &distance) in output[y * width..(y + 1) * width]
            .iter_mut()
            .zip(&scratch.output)
        {
            *target = distance.min(u32::MAX as i64) as u32;
        }
    }
    output
}

fn squared_euclidean_distance_parallel(image: &BinaryImage) -> Vec<u32> {
    let width = image.width();
    let height = image.height();
    let mut columns = vec![INF; width * height];
    columns
        .par_chunks_mut(height)
        .enumerate()
        .for_each(|(x, column)| {
            let mut last = None;
            for (y, target) in column.iter_mut().enumerate() {
                if image.get(x, y) {
                    last = Some(y);
                    *target = 0;
                } else if let Some(seed) = last {
                    let d = y - seed;
                    *target = (d * d) as i64;
                }
            }
            last = None;
            for y in (0..height).rev() {
                if image.get(x, y) {
                    last = Some(y);
                } else if let Some(seed) = last {
                    let d = seed - y;
                    column[y] = column[y].min((d * d) as i64);
                }
            }
        });
    let mut vertical = vec![INF; width * height];
    const TRANSPOSE_ROWS: usize = 32;
    vertical
        .par_chunks_mut(width * TRANSPOSE_ROWS)
        .enumerate()
        .for_each(|(row_block, rows)| {
            let first_y = row_block * TRANSPOSE_ROWS;
            let row_count = rows.len() / width;
            for first_x in (0..width).step_by(32) {
                let x_end = (first_x + 32).min(width);
                for local_y in 0..row_count {
                    let y = first_y + local_y;
                    for x in first_x..x_end {
                        rows[local_y * width + x] = columns[x * height + y];
                    }
                }
            }
        });
    // The column-major plane is read only by the transpose; free it before
    // the output plane exists rather than holding both through the row pass.
    drop(columns);
    let mut output = vec![u32::MAX; width * height];
    output
        .par_chunks_mut(width)
        .zip(vertical.par_chunks(width))
        .for_each_init(
            || TransformScratch::new(width),
            |scratch, (output_row, vertical_row)| {
                transform_1d(vertical_row, scratch);
                for (target, &distance) in output_row.iter_mut().zip(&scratch.output) {
                    *target = distance.min(u32::MAX as i64) as u32;
                }
            },
        );
    output
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
            intersection = ((values[seed] + (seed * seed) as i64)
                - (values[previous] + (previous * previous) as i64))
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
                intersection = ((values[seed] + (seed * seed) as i64)
                    - (values[previous] + (previous * previous) as i64))
                    as f64
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

    #[test]
    fn parallel_distance_transform_is_bit_exact() {
        let mut image = BinaryImage::new(257, 257);
        let mut state = 0x5045_4454_5f4d_3350_u64;
        for y in 0..image.height() {
            for x in 0..image.width() {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                image.set(x, y, state >> 60 == 0);
            }
        }
        assert_eq!(
            squared_euclidean_distance_parallel(&image),
            squared_euclidean_distance_serial(&image)
        );
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
