use crate::morphology::dilate_gray;
use crate::{BinaryImage, GrayImage};
use rayon::prelude::*;

const INTEGRAL_ROW_BLOCK_SIZE: usize = 64;
const DOCUMENTED_MAX_INTEGRAL_PIXELS: u64 = 1 << 32;
const _: () =
    assert!(DOCUMENTED_MAX_INTEGRAL_PIXELS <= u64::MAX / (u8::MAX as u64 * u8::MAX as u64));

/// Otsu threshold using dark `< threshold`; tied best-score plateaus use their midpoint.
pub fn otsu_threshold(image: &GrayImage) -> u8 {
    let mut histogram = [0u64; 256];
    for y in 0..image.height() {
        for &value in image.row(y) {
            histogram[value as usize] += 1;
        }
    }
    otsu_from_histogram(&histogram)
}

/// Otsu threshold with excluded pixels omitted from the histogram.
pub fn otsu_threshold_excluding(image: &GrayImage, excluded: &BinaryImage) -> u8 {
    assert_eq!(
        (image.width(), image.height()),
        (excluded.width(), excluded.height())
    );
    let mut histogram = [0u64; 256];
    for y in 0..image.height() {
        for x in 0..image.width() {
            if !excluded.get(x, y) {
                histogram[image.get(x, y) as usize] += 1;
            }
        }
    }
    otsu_from_histogram(&histogram)
}

fn otsu_from_histogram(histogram: &[u64; 256]) -> u8 {
    let total: u64 = histogram.iter().sum();
    if total == 0 {
        return 0;
    }
    let weighted_total: u64 = histogram
        .iter()
        .enumerate()
        .map(|(value, count)| value as u64 * count)
        .sum();
    let mut background_count = 0u64;
    let mut background_sum = 0u64;
    let mut best_score = -1.0f64;
    let mut first_best = 0u8;
    let mut last_best = 0u8;
    for threshold in 1..=255u16 {
        let value = threshold as usize - 1;
        background_count += histogram[value];
        background_sum += value as u64 * histogram[value];
        let foreground_count = total - background_count;
        if background_count == 0 || foreground_count == 0 {
            continue;
        }
        let mean_difference = background_sum as f64 / background_count as f64
            - (weighted_total - background_sum) as f64 / foreground_count as f64;
        let score =
            background_count as f64 * foreground_count as f64 * mean_difference * mean_difference;
        let tolerance = best_score.abs().max(1.0) * 1e-12;
        if score > best_score + tolerance {
            best_score = score;
            first_best = threshold as u8;
            last_best = threshold as u8;
        } else if (score - best_score).abs() <= tolerance {
            last_best = threshold as u8;
        }
    }
    ((u16::from(first_best) + u16::from(last_best)) / 2) as u8
}

pub const DEFAULT_MOKJI_MAX_EDGE_WIDTH: usize = 5;
pub const DEFAULT_MOKJI_MIN_EDGE_MAGNITUDE: u8 = 26;

/// Mokji's edge-co-occurrence threshold for dark foreground images.
///
/// The dilation uses a square of side `(max_edge_width + 1) * 2 - 1`.
/// Under the dark-foreground morphology convention this yields the darkest
/// neighbour. Eligible pairs differ by at least `min_edge_magnitude`, and the
/// result is the frequency-weighted mean of their midpoints.
pub fn mokji_threshold(image: &GrayImage, max_edge_width: usize, min_edge_magnitude: u8) -> u8 {
    assert!(max_edge_width >= 1, "Mokji max edge width must be positive");
    assert!(
        min_edge_magnitude >= 1,
        "Mokji minimum edge magnitude must be positive"
    );
    if image.width() <= max_edge_width.saturating_mul(2)
        || image.height() <= max_edge_width.saturating_mul(2)
    {
        return 128;
    }
    let darkest = dilate_gray(image, max_edge_width, max_edge_width);
    let mut midpoint_twice_sum = 0u64;
    let mut pair_count = 0u64;
    for y in max_edge_width..image.height() - max_edge_width {
        for x in max_edge_width..image.width() - max_edge_width {
            let low = darkest.get(x, y);
            let high = image.get(x, y);
            if high.saturating_sub(low) >= min_edge_magnitude {
                midpoint_twice_sum += u64::from(low) + u64::from(high);
                pair_count += 1;
            }
        }
    }
    if pair_count == 0 {
        128
    } else {
        ((midpoint_twice_sum as f64 * 0.5 / pair_count as f64).round() as u16).min(255) as u8
    }
}

pub fn threshold_global(image: &GrayImage, threshold: u8) -> BinaryImage {
    threshold_global_biased(image, threshold, 0)
}

pub fn threshold_global_biased(image: &GrayImage, threshold: u8, bias: i16) -> BinaryImage {
    let threshold = (i16::from(threshold) + bias).clamp(0, 255) as u8;
    let mut output = BinaryImage::new(image.width(), image.height());
    for y in 0..image.height() {
        for x in 0..image.width() {
            output.set(x, y, image.get(x, y) < threshold);
        }
    }
    output
}

#[derive(Clone, Copy, Debug)]
pub enum LocalThreshold {
    Sauvola {
        k: f64,
    },
    Wolf {
        k: f64,
        deviation_floor: f64,
        minimum_percentile: f64,
        hard_ink: u8,
        hard_paper: u8,
    },
}

/// Random-access summed-area tables for local grayscale statistics.
///
/// The tables cost 16 bytes per pixel. The convenience local-thresholding APIs
/// and `bw.rs` stream the same exact window sums through row strips in
/// `O(width)` memory per worker, while the legacy `_with_integrals` entry points
/// still read caller-supplied tables. Keep this type for those and random-access queries.
///
/// Both tables use `u64`. For the documented bound of 2^32 pixels, even the
/// sum-of-squares table is bounded by `2^32 * 255^2`, well below `u64::MAX`.
/// One instance can be queried with any radius, allowing multiscale local
/// thresholding to reuse the same input pass.
#[derive(Debug)]
pub struct IntegralImages {
    width: usize,
    height: usize,
    stride: usize,
    sums: Vec<u64>,
    squared_sums: Vec<u64>,
}

/// Random-access summed-area statistics that omit pixels selected by a
/// binary mask (24 bytes per pixel; masked thresholding streams instead).
#[derive(Debug)]
pub struct MaskedIntegralImages {
    width: usize,
    height: usize,
    stride: usize,
    sums: Vec<u64>,
    squared_sums: Vec<u64>,
    counts: Vec<u64>,
}

impl MaskedIntegralImages {
    pub fn new(image: &GrayImage, excluded: &BinaryImage) -> Self {
        assert_eq!(
            (image.width(), image.height()),
            (excluded.width(), excluded.height())
        );
        let width = image.width();
        let height = image.height();
        let stride = width
            .checked_add(1)
            .expect("masked integral stride overflow");
        let len = stride
            .checked_mul(
                height
                    .checked_add(1)
                    .expect("masked integral height overflow"),
            )
            .expect("masked integral dimensions overflow");
        let mut sums = vec![0u64; len];
        let mut squared_sums = vec![0u64; len];
        let mut counts = vec![0u64; len];
        if width == 0 || height == 0 {
            return Self {
                width,
                height,
                stride,
                sums,
                squared_sums,
                counts,
            };
        }
        let block_len = stride
            .checked_mul(INTEGRAL_ROW_BLOCK_SIZE)
            .expect("masked integral row block overflow");
        sums[stride..]
            .par_chunks_mut(block_len)
            .zip(squared_sums[stride..].par_chunks_mut(block_len))
            .zip(counts[stride..].par_chunks_mut(block_len))
            .enumerate()
            .for_each(
                |(block_index, ((sum_block, squared_sum_block), count_block))| {
                    let first_y = block_index * INTEGRAL_ROW_BLOCK_SIZE;
                    for local_y in 0..sum_block.len() / stride {
                        let source = image.row(first_y + local_y);
                        let mut row_sum = 0u64;
                        let mut row_squared_sum = 0u64;
                        let mut row_count = 0u64;
                        let row_start = local_y * stride;
                        let previous_row_start = local_y.saturating_sub(1) * stride;
                        for (x, &value) in source.iter().enumerate() {
                            if !excluded.get(x, first_y + local_y) {
                                let value = u64::from(value);
                                row_sum += value;
                                row_squared_sum += value * value;
                                row_count += 1;
                            }
                            let above = if local_y == 0 {
                                0
                            } else {
                                sum_block[previous_row_start + x + 1]
                            };
                            let squared_above = if local_y == 0 {
                                0
                            } else {
                                squared_sum_block[previous_row_start + x + 1]
                            };
                            let count_above = if local_y == 0 {
                                0
                            } else {
                                count_block[previous_row_start + x + 1]
                            };
                            sum_block[row_start + x + 1] = row_sum + above;
                            squared_sum_block[row_start + x + 1] = row_squared_sum + squared_above;
                            count_block[row_start + x + 1] = row_count + count_above;
                        }
                    }
                },
            );

        let block_count = height.div_ceil(INTEGRAL_ROW_BLOCK_SIZE);
        let offsets_len = block_count
            .checked_mul(stride)
            .expect("masked integral block offsets overflow");
        let mut sum_offsets = vec![0u64; offsets_len];
        let mut squared_sum_offsets = vec![0u64; offsets_len];
        let mut count_offsets = vec![0u64; offsets_len];
        for block_index in 1..block_count {
            let previous_end = block_index * INTEGRAL_ROW_BLOCK_SIZE * stride;
            let offset = block_index * stride;
            let prior_offset = (block_index - 1) * stride;
            for x in 1..stride {
                sum_offsets[offset + x] = sum_offsets[prior_offset + x] + sums[previous_end + x];
                squared_sum_offsets[offset + x] =
                    squared_sum_offsets[prior_offset + x] + squared_sums[previous_end + x];
                count_offsets[offset + x] =
                    count_offsets[prior_offset + x] + counts[previous_end + x];
            }
        }

        sums[stride..]
            .par_chunks_mut(block_len)
            .zip(squared_sums[stride..].par_chunks_mut(block_len))
            .zip(counts[stride..].par_chunks_mut(block_len))
            .enumerate()
            .for_each(
                |(block_index, ((sum_block, squared_sum_block), count_block))| {
                    if block_index == 0 {
                        return;
                    }
                    let offset = &sum_offsets[block_index * stride..(block_index + 1) * stride];
                    let squared_offset =
                        &squared_sum_offsets[block_index * stride..(block_index + 1) * stride];
                    let count_offset =
                        &count_offsets[block_index * stride..(block_index + 1) * stride];
                    for ((sum_row, squared_sum_row), count_row) in sum_block
                        .chunks_mut(stride)
                        .zip(squared_sum_block.chunks_mut(stride))
                        .zip(count_block.chunks_mut(stride))
                    {
                        for x in 1..stride {
                            sum_row[x] += offset[x];
                            squared_sum_row[x] += squared_offset[x];
                            count_row[x] += count_offset[x];
                        }
                    }
                },
            );
        Self {
            width,
            height,
            stride,
            sums,
            squared_sums,
            counts,
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// Returns the population mean and standard deviation of the included
    /// pixels in the clamped square window centered on `(x, y)`, or `None`
    /// when the window holds no included pixel.
    pub fn mean_and_deviation(&self, x: usize, y: usize, radius: usize) -> Option<(f64, f64)> {
        assert!(x < self.width && y < self.height);
        let x0 = x.saturating_sub(radius);
        let y0 = y.saturating_sub(radius);
        let x1 = x.saturating_add(radius).min(self.width - 1) + 1;
        let y1 = y.saturating_add(radius).min(self.height - 1) + 1;
        let count = self.rectangle_sum(&self.counts, x0, y0, x1, y1);
        if count == 0 {
            return None;
        }
        let sum = self.rectangle_sum(&self.sums, x0, y0, x1, y1);
        let squared_sum = self.rectangle_sum(&self.squared_sums, x0, y0, x1, y1);
        let count = count as f64;
        let mean = sum as f64 / count;
        let deviation = (squared_sum as f64 / count - mean * mean).max(0.0).sqrt();
        Some((mean, deviation))
    }

    fn rectangle_sum(&self, integral: &[u64], x0: usize, y0: usize, x1: usize, y1: usize) -> u64 {
        integral[y1 * self.stride + x1] + integral[y0 * self.stride + x0]
            - integral[y0 * self.stride + x1]
            - integral[y1 * self.stride + x0]
    }
}

impl IntegralImages {
    pub fn new(image: &GrayImage) -> Self {
        let width = image.width();
        let height = image.height();
        let pixel_count = width
            .checked_mul(height)
            .expect("image dimensions overflow usize");
        debug_assert!(
            pixel_count as u128 <= u128::from(DOCUMENTED_MAX_INTEGRAL_PIXELS),
            "integral images support at most 2^32 pixels"
        );

        let stride = width.checked_add(1).expect("integral stride overflow");
        let rows = height.checked_add(1).expect("integral height overflow");
        let len = stride
            .checked_mul(rows)
            .expect("integral image dimensions overflow usize");
        let mut sums = vec![0u64; len];
        let mut squared_sums = vec![0u64; len];

        if width == 0 || height == 0 {
            return Self {
                width,
                height,
                stride,
                sums,
                squared_sums,
            };
        }

        let block_len = stride
            .checked_mul(INTEGRAL_ROW_BLOCK_SIZE)
            .expect("integral row block overflow");
        sums[stride..]
            .par_chunks_mut(block_len)
            .zip(squared_sums[stride..].par_chunks_mut(block_len))
            .enumerate()
            .for_each(|(block_index, (sum_block, squared_sum_block))| {
                let first_y = block_index * INTEGRAL_ROW_BLOCK_SIZE;
                for local_y in 0..sum_block.len() / stride {
                    let source = image.row(first_y + local_y);
                    let mut row_sum = 0u64;
                    let mut row_squared_sum = 0u64;
                    let row_start = local_y * stride;
                    let previous_row_start = local_y.saturating_sub(1) * stride;
                    for (x, &value) in source.iter().enumerate() {
                        let value = u64::from(value);
                        row_sum += value;
                        row_squared_sum += value * value;
                        let above = if local_y == 0 {
                            0
                        } else {
                            sum_block[previous_row_start + x + 1]
                        };
                        let squared_above = if local_y == 0 {
                            0
                        } else {
                            squared_sum_block[previous_row_start + x + 1]
                        };
                        sum_block[row_start + x + 1] = row_sum + above;
                        squared_sum_block[row_start + x + 1] = row_squared_sum + squared_above;
                    }
                }
            });

        let block_count = height.div_ceil(INTEGRAL_ROW_BLOCK_SIZE);
        let offsets_len = block_count
            .checked_mul(stride)
            .expect("integral block offsets overflow");
        let mut sum_offsets = vec![0u64; offsets_len];
        let mut squared_sum_offsets = vec![0u64; offsets_len];
        for block_index in 1..block_count {
            let previous_end_y = block_index * INTEGRAL_ROW_BLOCK_SIZE;
            let previous_end = previous_end_y * stride;
            let offset = block_index * stride;
            let prior_offset = (block_index - 1) * stride;
            for x in 1..stride {
                sum_offsets[offset + x] = sum_offsets[prior_offset + x] + sums[previous_end + x];
                squared_sum_offsets[offset + x] =
                    squared_sum_offsets[prior_offset + x] + squared_sums[previous_end + x];
            }
        }

        sums[stride..]
            .par_chunks_mut(block_len)
            .zip(squared_sums[stride..].par_chunks_mut(block_len))
            .enumerate()
            .for_each(|(block_index, (sum_block, squared_sum_block))| {
                if block_index == 0 {
                    return;
                }
                let offset = &sum_offsets[block_index * stride..(block_index + 1) * stride];
                let squared_offset =
                    &squared_sum_offsets[block_index * stride..(block_index + 1) * stride];
                for (sum_row, squared_sum_row) in sum_block
                    .chunks_mut(stride)
                    .zip(squared_sum_block.chunks_mut(stride))
                {
                    for x in 1..stride {
                        sum_row[x] += offset[x];
                        squared_sum_row[x] += squared_offset[x];
                    }
                }
            });

        Self {
            width,
            height,
            stride,
            sums,
            squared_sums,
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// Returns the population mean and standard deviation for the clamped
    /// square window centered on `(x, y)`.
    pub fn mean_and_deviation(&self, x: usize, y: usize, radius: usize) -> (f64, f64) {
        assert!(x < self.width && y < self.height);
        let x0 = x.saturating_sub(radius);
        let y0 = y.saturating_sub(radius);
        let x1 = x.saturating_add(radius).min(self.width - 1) + 1;
        let y1 = y.saturating_add(radius).min(self.height - 1) + 1;
        let sum = self.rectangle_sum(&self.sums, x0, y0, x1, y1);
        let squared_sum = self.rectangle_sum(&self.squared_sums, x0, y0, x1, y1);
        let count = ((x1 - x0) * (y1 - y0)) as f64;
        let mean = sum as f64 / count;
        let deviation = (squared_sum as f64 / count - mean * mean).max(0.0).sqrt();
        (mean, deviation)
    }

    fn rectangle_sum(&self, integral: &[u64], x0: usize, y0: usize, x1: usize, y1: usize) -> u64 {
        integral[y1 * self.stride + x1] + integral[y0 * self.stride + x0]
            - integral[y0 * self.stride + x1]
            - integral[y1 * self.stride + x0]
    }
}

pub fn threshold_local(image: &GrayImage, radius: usize, method: LocalThreshold) -> BinaryImage {
    threshold_local_biased(image, radius, method, 0)
}

pub fn threshold_local_biased(
    image: &GrayImage,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
) -> BinaryImage {
    local_threshold(
        image,
        None,
        Statistics::Streamed,
        [radius],
        method,
        bias,
        true,
        |_, _, [black]| black,
    )
}

/// Applies local thresholding using caller-provided integral images.
///
/// Reuse `integrals` across calls with different radii to avoid rebuilding the
/// summed-area tables for multiscale thresholding.
pub fn threshold_local_with_integrals(
    image: &GrayImage,
    integrals: &IntegralImages,
    radius: usize,
    method: LocalThreshold,
) -> BinaryImage {
    threshold_local_biased_with_integrals(image, integrals, radius, method, 0)
}

/// Applies biased local thresholding with integral images built from `image`.
///
/// Panics when the image and integral dimensions differ. Callers are
/// responsible for ensuring equal-sized inputs also contain the same pixels.
pub fn threshold_local_biased_with_integrals(
    image: &GrayImage,
    integrals: &IntegralImages,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
) -> BinaryImage {
    assert_eq!(
        (integrals.width(), integrals.height()),
        (image.width(), image.height())
    );
    local_threshold(
        image,
        None,
        Statistics::Table(integrals),
        [radius],
        method,
        bias,
        true,
        |_, _, [black]| black,
    )
}

/// Applies one scale of a multiscale local threshold.
///
/// For Wolf, the deviation floor protects the per-window normalization
/// denominator but is not substituted for each local deviation. This faithful
/// low-variance behavior prevents flat paper windows from degenerating to a
/// mean threshold. The legacy single-window entry points retain their exact
/// historical numerator-floor behavior.
pub fn threshold_local_biased_with_integrals_for_consensus(
    image: &GrayImage,
    integrals: &IntegralImages,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
) -> BinaryImage {
    assert_eq!(
        (integrals.width(), integrals.height()),
        (image.width(), image.height())
    );
    local_threshold(
        image,
        None,
        Statistics::Table(integrals),
        [radius],
        method,
        bias,
        false,
        |_, _, [black]| black,
    )
}

/// Produces a three-scale local-threshold consensus in one traversal for an
/// unmasked image.
///
/// This is the unmasked counterpart of
/// [`threshold_local_multiscale_biased_excluding_for_consensus`]. It
/// preserves the exact per-radius consensus decisions of three calls to
/// [`threshold_local_biased_with_integrals_for_consensus`] while avoiding the
/// three temporary full-page masks and the separate combination pass. Window
/// statistics stream through row strips, so no full-page summed-area table
/// is allocated.
pub fn threshold_local_multiscale_biased_for_consensus(
    image: &GrayImage,
    radii: [usize; 3],
    method: LocalThreshold,
    bias: i16,
    supports_small_scale: impl Fn(usize, usize) -> bool + Sync,
) -> BinaryImage {
    local_threshold(
        image,
        None,
        Statistics::Streamed,
        radii,
        method,
        bias,
        false,
        |x, y, black| consensus(x, y, black, &supports_small_scale),
    )
}

/// [`threshold_local_multiscale_biased_for_consensus`] reading its windows
/// from caller-provided integral images.
pub fn threshold_local_multiscale_biased_with_integrals_for_consensus(
    image: &GrayImage,
    integrals: &IntegralImages,
    radii: [usize; 3],
    method: LocalThreshold,
    bias: i16,
    supports_small_scale: impl Fn(usize, usize) -> bool + Sync,
) -> BinaryImage {
    assert_eq!(
        (integrals.width(), integrals.height()),
        (image.width(), image.height())
    );
    local_threshold(
        image,
        None,
        Statistics::Table(integrals),
        radii,
        method,
        bias,
        false,
        |x, y, black| consensus(x, y, black, &supports_small_scale),
    )
}

pub fn threshold_local_biased_excluding(
    image: &GrayImage,
    excluded: &BinaryImage,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
) -> BinaryImage {
    local_threshold(
        image,
        Some(excluded),
        Statistics::Streamed,
        [radius],
        method,
        bias,
        true,
        |_, _, [black]| black,
    )
}

/// One masked consensus scale reading its windows from `integrals`;
/// `excluded` selects the pixels left white and the Wolf percentile.
pub fn threshold_local_biased_excluding_with_integrals_for_consensus(
    image: &GrayImage,
    excluded: &BinaryImage,
    integrals: &MaskedIntegralImages,
    radius: usize,
    method: LocalThreshold,
    bias: i16,
) -> BinaryImage {
    assert_eq!(
        (integrals.width(), integrals.height()),
        (image.width(), image.height())
    );
    local_threshold(
        image,
        Some(excluded),
        Statistics::MaskedTable(integrals),
        [radius],
        method,
        bias,
        false,
        |_, _, [black]| black,
    )
}

/// Produces a three-scale local-threshold consensus in one traversal.
///
/// The three independent entry points each scanned the excluded histogram,
/// searched the maximum deviation, and allocated/fed a packed output before a
/// fourth traversal combined them. Sharing those invariant passes and emitting
/// the consensus directly preserves every per-radius threshold decision while
/// avoiding the three temporary full-page masks. Window statistics stream
/// through row strips, so no full-page summed-area table is allocated.
pub fn threshold_local_multiscale_biased_excluding_for_consensus(
    image: &GrayImage,
    excluded: &BinaryImage,
    radii: [usize; 3],
    method: LocalThreshold,
    bias: i16,
    supports_small_scale: impl Fn(usize, usize) -> bool + Sync,
) -> BinaryImage {
    local_threshold(
        image,
        Some(excluded),
        Statistics::Streamed,
        radii,
        method,
        bias,
        false,
        |x, y, black| consensus(x, y, black, &supports_small_scale),
    )
}

/// [`threshold_local_multiscale_biased_excluding_for_consensus`] reading its
/// windows from caller-provided masked integral images.
pub fn threshold_local_multiscale_biased_excluding_with_integrals_for_consensus(
    image: &GrayImage,
    excluded: &BinaryImage,
    integrals: &MaskedIntegralImages,
    radii: [usize; 3],
    method: LocalThreshold,
    bias: i16,
    supports_small_scale: impl Fn(usize, usize) -> bool + Sync,
) -> BinaryImage {
    assert_eq!(
        (integrals.width(), integrals.height()),
        (image.width(), image.height())
    );
    local_threshold(
        image,
        Some(excluded),
        Statistics::MaskedTable(integrals),
        radii,
        method,
        bias,
        false,
        |x, y, black| consensus(x, y, black, &supports_small_scale),
    )
}

fn consensus(
    x: usize,
    y: usize,
    [small, medium, large]: [bool; 3],
    supports_small_scale: &(impl Fn(usize, usize) -> bool + Sync),
) -> bool {
    (medium && large) || (small && supports_small_scale(x, y))
}

/// Shared local-threshold pass for one or more window radii.
///
/// `floor_local_wolf_deviation` selects the legacy single-window Wolf
/// numerator floor; consensus scales leave local deviations unfloored and
/// abstain on low-variance pages instead.
#[allow(clippy::too_many_arguments)]
fn local_threshold<const N: usize>(
    image: &GrayImage,
    excluded: Option<&BinaryImage>,
    statistics: Statistics<'_>,
    radii: [usize; N],
    method: LocalThreshold,
    bias: i16,
    floor_local_wolf_deviation: bool,
    decide: impl Fn(usize, usize, [bool; N]) -> bool + Sync,
) -> BinaryImage {
    let max_halo_radius = if matches!(statistics, Statistics::Streamed) {
        radii
            .iter()
            .copied()
            .map(|radius| radius.min(image.height().saturating_sub(1)))
            .max()
            .unwrap_or(0)
    } else {
        0
    };
    let rows = default_strip_rows(image.height(), max_halo_radius);
    local_threshold_in_strips(
        image,
        excluded,
        statistics,
        radii,
        method,
        bias,
        floor_local_wolf_deviation,
        decide,
        rows,
    )
}

#[allow(clippy::too_many_arguments)]
fn local_threshold_in_strips<const N: usize>(
    image: &GrayImage,
    excluded: Option<&BinaryImage>,
    statistics: Statistics<'_>,
    radii: [usize; N],
    method: LocalThreshold,
    bias: i16,
    floor_local_wolf_deviation: bool,
    decide: impl Fn(usize, usize, [bool; N]) -> bool + Sync,
    strip_rows: usize,
) -> BinaryImage {
    let width = image.width();
    let height = image.height();
    if let Some(excluded) = excluded {
        assert_eq!((excluded.width(), excluded.height()), (width, height));
    }
    if width == 0 || height == 0 {
        return BinaryImage::new(width, height);
    }
    let strip_rows = strip_rows.clamp(1, height);
    let global_min = match method {
        LocalThreshold::Wolf {
            minimum_percentile, ..
        } => excluded.map_or_else(
            || grayscale_percentile(image, minimum_percentile),
            |excluded| grayscale_percentile_excluding(image, excluded, minimum_percentile),
        ),
        LocalThreshold::Sauvola { .. } => 0,
    };
    let max_deviations = match method {
        LocalThreshold::Wolf { .. } => (0..height.div_ceil(strip_rows))
            .into_par_iter()
            .map(|strip| {
                let mut windows = RowWindows::new(statistics, image, excluded, radii);
                let mut maxima = [1.0f64; N];
                for y in strip * strip_rows..((strip + 1) * strip_rows).min(height) {
                    windows.advance_to(y);
                    for x in 0..width {
                        for (index, maximum) in maxima.iter_mut().enumerate() {
                            *maximum = maximum.max(
                                windows
                                    .mean_and_deviation(index, x)
                                    .map_or(0.0, |statistics| statistics.1),
                            );
                        }
                    }
                }
                maxima
            })
            .reduce(
                || [1.0; N],
                |left, right| std::array::from_fn(|index| left[index].max(right[index])),
            ),
        LocalThreshold::Sauvola { .. } => [1.0; N],
    };
    let low_variance: [bool; N] = std::array::from_fn(|index| {
        matches!(
            method,
            LocalThreshold::Wolf {
                deviation_floor,
                ..
            } if !floor_local_wolf_deviation && max_deviations[index] <= deviation_floor
        )
    });
    let mut output = BinaryImage::new(width, height);
    let words_per_line = output.words_per_line();
    output
        .words_mut()
        .par_chunks_mut(words_per_line * strip_rows)
        .enumerate()
        .for_each(|(strip, output_rows)| {
            let mut windows = RowWindows::new(statistics, image, excluded, radii);
            for (local_y, output_row) in output_rows.chunks_mut(words_per_line).enumerate() {
                let y = strip * strip_rows + local_y;
                windows.advance_to(y);
                for x in 0..width {
                    if excluded.is_some_and(|excluded| excluded.get(x, y)) {
                        continue;
                    }
                    let value = image.get(x, y);
                    let mut black = [false; N];
                    for (index, black) in black.iter_mut().enumerate() {
                        let Some((mean, deviation)) = windows.mean_and_deviation(index, x) else {
                            continue;
                        };
                        let threshold = match method {
                            LocalThreshold::Sauvola { k } => {
                                mean * (1.0 + k * (deviation / 128.0 - 1.0))
                            }
                            LocalThreshold::Wolf {
                                k, deviation_floor, ..
                            } => {
                                let local_deviation = if floor_local_wolf_deviation {
                                    deviation.max(deviation_floor)
                                } else {
                                    deviation
                                };
                                let normalized =
                                    local_deviation / max_deviations[index].max(deviation_floor);
                                mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                            }
                        };
                        *black = match method {
                            LocalThreshold::Wolf { hard_ink, .. } if value <= hard_ink => true,
                            LocalThreshold::Wolf { hard_paper, .. } if value >= hard_paper => false,
                            LocalThreshold::Wolf { .. } if low_variance[index] => false,
                            _ => f64::from(value) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
                        };
                    }
                    if decide(x, y, black) {
                        output_row[x / 32] |= 1 << (31 - x % 32);
                    }
                }
            }
        });
    output
}

/// Where a threshold pass reads its window statistics.
#[derive(Clone, Copy)]
enum Statistics<'a> {
    /// Exact window sums streamed from the image and mask in row strips.
    Streamed,
    /// A caller-supplied full-page table, read as given.
    Table(&'a IntegralImages),
    MaskedTable(&'a MaskedIntegralImages),
}

/// One strip's view of the window statistics for the current row.
enum RowWindows<'a, const N: usize> {
    Streamed(Box<StreamingWindows<'a, N>>),
    Table {
        table: &'a IntegralImages,
        radii: [usize; N],
        y: usize,
    },
    MaskedTable {
        table: &'a MaskedIntegralImages,
        radii: [usize; N],
        y: usize,
    },
}

impl<'a, const N: usize> RowWindows<'a, N> {
    fn new(
        statistics: Statistics<'a>,
        image: &'a GrayImage,
        excluded: Option<&'a BinaryImage>,
        radii: [usize; N],
    ) -> Self {
        match statistics {
            Statistics::Streamed => {
                Self::Streamed(Box::new(StreamingWindows::new(image, excluded, radii)))
            }
            Statistics::Table(table) => Self::Table { table, radii, y: 0 },
            Statistics::MaskedTable(table) => Self::MaskedTable { table, radii, y: 0 },
        }
    }

    fn advance_to(&mut self, row: usize) {
        match self {
            Self::Streamed(windows) => windows.advance_to(row),
            Self::Table { y, .. } | Self::MaskedTable { y, .. } => *y = row,
        }
    }

    fn mean_and_deviation(&self, index: usize, x: usize) -> Option<(f64, f64)> {
        match self {
            Self::Streamed(windows) => windows.mean_and_deviation(index, x),
            Self::Table { table, radii, y } => Some(table.mean_and_deviation(x, *y, radii[index])),
            Self::MaskedTable { table, radii, y } => table.mean_and_deviation(x, *y, radii[index]),
        }
    }
}

/// Row strips per worker: enough strips to balance the pool, each long
/// enough that refilling a strip's leading window halo stays a small share
/// of its work.
fn default_strip_rows(height: usize, max_halo_radius: usize) -> usize {
    const MINIMUM_STRIP_ROWS: usize = 32;
    let minimum_rows = MINIMUM_STRIP_ROWS.max(max_halo_radius.saturating_mul(2));
    height
        .div_ceil(rayon::current_num_threads().saturating_mul(2).max(1))
        .max(minimum_rows)
}

/// Exact window sums for consecutive rows of one strip.
///
/// For each radius it keeps the column sums of the rows inside the current
/// vertical window, adding the entering row and subtracting the leaving row
/// (read back from the image), plus their horizontal prefix sums. A window
/// sum is then one prefix difference. Every quantity is the same integer the
/// full summed-area tables produce, so the `f64` statistics are
/// bit-identical, while the working set is `O(width)` per worker instead of
/// `O(width * height)`.
struct StreamingWindows<'a, const N: usize> {
    image: &'a GrayImage,
    excluded: Option<&'a BinaryImage>,
    windows: [ColumnWindow; N],
}

struct ColumnWindow {
    radius: usize,
    /// Rows `first..end` are summed into `columns`.
    first: usize,
    end: usize,
    columns: WindowSums,
    prefix: WindowSums,
}

#[derive(Clone)]
struct WindowSums {
    sums: Vec<u64>,
    squares: Vec<u64>,
    /// Included-pixel counts; empty when nothing is excluded.
    counts: Vec<u64>,
}

impl WindowSums {
    fn new(len: usize, masked: bool) -> Self {
        Self {
            sums: vec![0; len],
            squares: vec![0; len],
            counts: if masked { vec![0; len] } else { Vec::new() },
        }
    }
}

impl<'a, const N: usize> StreamingWindows<'a, N> {
    fn new(image: &'a GrayImage, excluded: Option<&'a BinaryImage>, radii: [usize; N]) -> Self {
        let width = image.width();
        let masked = excluded.is_some();
        Self {
            image,
            excluded,
            windows: radii.map(|radius| ColumnWindow {
                radius,
                first: 0,
                end: 0,
                columns: WindowSums::new(width, masked),
                prefix: WindowSums::new(width + 1, masked),
            }),
        }
    }

    /// Moves every window to the clamped rows around `y`. Rows must advance
    /// monotonically within a strip.
    fn advance_to(&mut self, y: usize) {
        let height = self.image.height();
        for window in &mut self.windows {
            let first = y.saturating_sub(window.radius);
            let end = y.saturating_add(window.radius).min(height - 1) + 1;
            if (first, end) == (window.first, window.end) {
                continue;
            }
            if first >= window.end {
                window.columns.sums.fill(0);
                window.columns.squares.fill(0);
                window.columns.counts.fill(0);
                window.first = first;
                window.end = first;
            }
            while window.first < first {
                accumulate_row(
                    &mut window.columns,
                    self.image,
                    self.excluded,
                    window.first,
                    false,
                );
                window.first += 1;
            }
            while window.end < end {
                accumulate_row(
                    &mut window.columns,
                    self.image,
                    self.excluded,
                    window.end,
                    true,
                );
                window.end += 1;
            }
            prefix_sums(&window.columns.sums, &mut window.prefix.sums);
            prefix_sums(&window.columns.squares, &mut window.prefix.squares);
            prefix_sums(&window.columns.counts, &mut window.prefix.counts);
        }
    }

    /// The statistics `IntegralImages` / `MaskedIntegralImages` return for
    /// `(x, y)`, where `y` is the row last passed to `advance_to`. Unmasked
    /// windows are never empty.
    fn mean_and_deviation(&self, index: usize, x: usize) -> Option<(f64, f64)> {
        let window = &self.windows[index];
        let x0 = x.saturating_sub(window.radius);
        let x1 = x.saturating_add(window.radius).min(self.image.width() - 1) + 1;
        let prefix = &window.prefix;
        let sum = prefix.sums[x1] - prefix.sums[x0];
        let squared_sum = prefix.squares[x1] - prefix.squares[x0];
        let count = if self.excluded.is_some() {
            let count = prefix.counts[x1] - prefix.counts[x0];
            if count == 0 {
                return None;
            }
            count as f64
        } else {
            ((x1 - x0) * (window.end - window.first)) as f64
        };
        let mean = sum as f64 / count;
        let deviation = (squared_sum as f64 / count - mean * mean).max(0.0).sqrt();
        Some((mean, deviation))
    }
}

fn accumulate_row(
    columns: &mut WindowSums,
    image: &GrayImage,
    excluded: Option<&BinaryImage>,
    y: usize,
    add: bool,
) {
    let row = image.row(y);
    match excluded {
        None => {
            for ((sum, square), &value) in
                columns.sums.iter_mut().zip(&mut columns.squares).zip(row)
            {
                let value = u64::from(value);
                if add {
                    *sum += value;
                    *square += value * value;
                } else {
                    *sum -= value;
                    *square -= value * value;
                }
            }
        }
        Some(excluded) => {
            for (x, &value) in row.iter().enumerate() {
                if excluded.get(x, y) {
                    continue;
                }
                let value = u64::from(value);
                if add {
                    columns.sums[x] += value;
                    columns.squares[x] += value * value;
                    columns.counts[x] += 1;
                } else {
                    columns.sums[x] -= value;
                    columns.squares[x] -= value * value;
                    columns.counts[x] -= 1;
                }
            }
        }
    }
}

fn prefix_sums(columns: &[u64], prefix: &mut [u64]) {
    let Some((_, prefix)) = prefix.split_first_mut() else {
        return;
    };
    let mut running = 0u64;
    for (target, &value) in prefix.iter_mut().zip(columns) {
        running += value;
        *target = running;
    }
}

fn grayscale_percentile(image: &GrayImage, fraction: f64) -> u8 {
    let mut histogram = [0usize; 256];
    for y in 0..image.height() {
        for &value in image.row(y) {
            histogram[value as usize] += 1;
        }
    }
    let count = image.width().saturating_mul(image.height());
    if count == 0 {
        return 255;
    }
    let target = ((count - 1) as f64 * fraction.clamp(0.0, 1.0)).round() as usize;
    let mut cumulative = 0usize;
    for (value, frequency) in histogram.into_iter().enumerate() {
        cumulative += frequency;
        if cumulative > target {
            return value as u8;
        }
    }
    255
}

fn grayscale_percentile_excluding(image: &GrayImage, excluded: &BinaryImage, fraction: f64) -> u8 {
    let mut histogram = [0usize; 256];
    let mut count = 0usize;
    for y in 0..image.height() {
        for x in 0..image.width() {
            if !excluded.get(x, y) {
                histogram[image.get(x, y) as usize] += 1;
                count += 1;
            }
        }
    }
    if count == 0 {
        return 255;
    }
    let target = ((count - 1) as f64 * fraction.clamp(0.0, 1.0)).round() as usize;
    let mut cumulative = 0usize;
    for (value, frequency) in histogram.into_iter().enumerate() {
        cumulative += frequency;
        if cumulative > target {
            return value as u8;
        }
    }
    255
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, time::Instant};

    fn reference_threshold_local_biased(
        image: &GrayImage,
        radius: usize,
        method: LocalThreshold,
        bias: i16,
    ) -> BinaryImage {
        let global_min = match method {
            LocalThreshold::Wolf {
                minimum_percentile, ..
            } => reference_grayscale_percentile(image, minimum_percentile),
            LocalThreshold::Sauvola { .. } => 0,
        };
        let mut max_deviation = 1.0f64;
        reference_for_each_local_stat(image, radius, |_x, _y, _mean, deviation| {
            max_deviation = max_deviation.max(deviation);
        });
        let mut output = BinaryImage::new(image.width(), image.height());
        reference_for_each_local_stat(image, radius, |x, y, mean, deviation| {
            let threshold = match method {
                LocalThreshold::Sauvola { k } => mean * (1.0 + k * (deviation / 128.0 - 1.0)),
                LocalThreshold::Wolf {
                    k, deviation_floor, ..
                } => {
                    let normalized =
                        deviation.max(deviation_floor) / max_deviation.max(deviation_floor);
                    mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                }
            };
            let value = image.get(x, y);
            let black = match method {
                LocalThreshold::Wolf { hard_ink, .. } if value <= hard_ink => true,
                LocalThreshold::Wolf { hard_paper, .. } if value >= hard_paper => false,
                _ => f64::from(value) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
            };
            output.set(x, y, black);
        });
        output
    }

    fn reference_threshold_local_for_consensus(
        image: &GrayImage,
        radius: usize,
        method: LocalThreshold,
        bias: i16,
    ) -> BinaryImage {
        if image.width() == 0 || image.height() == 0 {
            return BinaryImage::new(image.width(), image.height());
        }
        let global_min = match method {
            LocalThreshold::Wolf {
                minimum_percentile, ..
            } => reference_grayscale_percentile(image, minimum_percentile),
            LocalThreshold::Sauvola { .. } => 0,
        };
        let mut max_deviation = 1.0f64;
        reference_for_each_local_stat(image, radius, |_x, _y, _mean, deviation| {
            max_deviation = max_deviation.max(deviation);
        });
        let low_variance_wolf = matches!(
            method,
            LocalThreshold::Wolf {
                deviation_floor,
                ..
            } if max_deviation <= deviation_floor
        );
        let mut output = BinaryImage::new(image.width(), image.height());
        reference_for_each_local_stat(image, radius, |x, y, mean, deviation| {
            let threshold = match method {
                LocalThreshold::Sauvola { k } => mean * (1.0 + k * (deviation / 128.0 - 1.0)),
                LocalThreshold::Wolf {
                    k, deviation_floor, ..
                } => {
                    let normalized = deviation / max_deviation.max(deviation_floor);
                    mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                }
            };
            let value = image.get(x, y);
            let black = match method {
                LocalThreshold::Wolf { hard_ink, .. } if value <= hard_ink => true,
                LocalThreshold::Wolf { hard_paper, .. } if value >= hard_paper => false,
                LocalThreshold::Wolf { .. } if low_variance_wolf => false,
                _ => f64::from(value) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
            };
            output.set(x, y, black);
        });
        output
    }

    fn reference_multiscale_consensus(
        image: &GrayImage,
        radii: [usize; 3],
        method: LocalThreshold,
        bias: i16,
        supports_small_scale: impl Fn(usize, usize) -> bool + Sync,
    ) -> BinaryImage {
        let scales = radii
            .map(|radius| reference_threshold_local_for_consensus(image, radius, method, bias));
        BinaryImage::from_fn_parallel(image.width(), image.height(), |x, y| {
            (scales[1].get(x, y) && scales[2].get(x, y))
                || (scales[0].get(x, y) && supports_small_scale(x, y))
        })
    }

    fn reference_grayscale_percentile(image: &GrayImage, fraction: f64) -> u8 {
        let mut values = Vec::with_capacity(image.width() * image.height());
        for y in 0..image.height() {
            values.extend_from_slice(image.row(y));
        }
        if values.is_empty() {
            return 255;
        }
        values.sort_unstable();
        let target = ((values.len() - 1) as f64 * fraction.clamp(0.0, 1.0)).round() as usize;
        values[target]
    }

    fn reference_horizontal_window_stats(
        image: &GrayImage,
        y: usize,
        radius: usize,
    ) -> (Vec<u32>, Vec<u32>) {
        let mut sums = vec![0u32; image.width()];
        let mut squares = vec![0u32; image.width()];
        let mut sum = 0u32;
        let mut square = 0u32;
        for x in 0..image.width() {
            if x == 0 {
                for sx in 0..=radius.min(image.width().saturating_sub(1)) {
                    let value = u32::from(image.get(sx, y));
                    sum += value;
                    square += value * value;
                }
            } else {
                let entering = x
                    .saturating_add(radius)
                    .min(image.width().saturating_sub(1));
                if entering
                    > (x - 1)
                        .saturating_add(radius)
                        .min(image.width().saturating_sub(1))
                {
                    let value = u32::from(image.get(entering, y));
                    sum += value;
                    square += value * value;
                }
                if x > radius {
                    let leaving = x - radius - 1;
                    let value = u32::from(image.get(leaving, y));
                    sum -= value;
                    square -= value * value;
                }
            }
            sums[x] = sum;
            squares[x] = square;
        }
        (sums, squares)
    }

    fn reference_for_each_local_stat(
        image: &GrayImage,
        radius: usize,
        mut visit: impl FnMut(usize, usize, f64, f64),
    ) {
        if image.width() == 0 || image.height() == 0 {
            return;
        }
        let mut rows = VecDeque::<(usize, Vec<u32>, Vec<u32>)>::new();
        let mut vertical_sum = vec![0u64; image.width()];
        let mut vertical_square = vec![0u64; image.width()];
        let mut next_row = 0usize;
        for y in 0..image.height() {
            let first_row = y.saturating_sub(radius);
            let last_row = y.saturating_add(radius).min(image.height() - 1);
            while rows.front().is_some_and(|row| row.0 < first_row) {
                let (_, sums, squares) = rows.pop_front().unwrap();
                for x in 0..image.width() {
                    vertical_sum[x] -= u64::from(sums[x]);
                    vertical_square[x] -= u64::from(squares[x]);
                }
            }
            while next_row <= last_row {
                let (sums, squares) = reference_horizontal_window_stats(image, next_row, radius);
                for x in 0..image.width() {
                    vertical_sum[x] += u64::from(sums[x]);
                    vertical_square[x] += u64::from(squares[x]);
                }
                rows.push_back((next_row, sums, squares));
                next_row += 1;
            }
            let vertical_count = last_row - first_row + 1;
            for x in 0..image.width() {
                let horizontal_count =
                    x.saturating_add(radius).min(image.width() - 1) - x.saturating_sub(radius) + 1;
                let count = (horizontal_count * vertical_count) as f64;
                let mean = vertical_sum[x] as f64 / count;
                let deviation = (vertical_square[x] as f64 / count - mean * mean)
                    .max(0.0)
                    .sqrt();
                visit(x, y, mean, deviation);
            }
        }
    }

    fn random_image(width: usize, height: usize, padding: usize, state: &mut u64) -> GrayImage {
        let stride = width + padding;
        let mut data = vec![0u8; stride * height];
        for value in &mut data {
            *state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            *value = (*state >> 32) as u8;
        }
        GrayImage::from_vec(width, height, stride, data).unwrap()
    }

    fn naive_mean_and_deviation(
        image: &GrayImage,
        x: usize,
        y: usize,
        radius: usize,
    ) -> (f64, f64) {
        let x0 = x.saturating_sub(radius);
        let y0 = y.saturating_sub(radius);
        let x1 = x.saturating_add(radius).min(image.width() - 1);
        let y1 = y.saturating_add(radius).min(image.height() - 1);
        let mut sum = 0u64;
        let mut squared_sum = 0u64;
        for sy in y0..=y1 {
            for sx in x0..=x1 {
                let value = u64::from(image.get(sx, sy));
                sum += value;
                squared_sum += value * value;
            }
        }
        let count = ((x1 - x0 + 1) * (y1 - y0 + 1)) as f64;
        let mean = sum as f64 / count;
        let deviation = (squared_sum as f64 / count - mean * mean).max(0.0).sqrt();
        (mean, deviation)
    }

    #[test]
    fn otsu_uses_midpoint_of_empty_tied_plateau() {
        let image = GrayImage::from_vec(4, 1, 4, vec![10, 10, 200, 200]).unwrap();
        assert_eq!(otsu_threshold(&image), 105);
        assert_eq!(threshold_global(&image, 10).count_black(), 0);
    }

    #[test]
    fn mokji_uses_edge_midpoints_and_falls_back_without_edges() {
        let flat = GrayImage::new(31, 21, 190);
        assert_eq!(
            mokji_threshold(
                &flat,
                DEFAULT_MOKJI_MAX_EDGE_WIDTH,
                DEFAULT_MOKJI_MIN_EDGE_MAGNITUDE
            ),
            128
        );

        let mut edge = GrayImage::new(31, 21, 30);
        for y in 0..edge.height() {
            for x in 15..edge.width() {
                edge.set(x, y, 230);
            }
        }
        assert_eq!(mokji_threshold(&edge, 5, 26), 130);
    }
    #[test]
    fn local_methods_find_dark_center() {
        let mut image = GrayImage::new(9, 9, 220);
        image.set(4, 4, 20);
        assert!(threshold_local(&image, 2, LocalThreshold::Sauvola { k: 0.34 }).get(4, 4));
        assert!(threshold_local(
            &image,
            2,
            LocalThreshold::Wolf {
                k: 0.5,
                deviation_floor: 2.0,
                minimum_percentile: 0.01,
                hard_ink: 48,
                hard_paper: 248,
            }
        )
        .get(4, 4));
    }

    #[test]
    fn wolf_uses_a_robust_minimum_and_hard_ink_paper_bounds() {
        let mut image = GrayImage::new(20, 20, 220);
        image.set(0, 0, 0);
        image.set(1, 1, 40);
        image.set(2, 2, 252);
        assert_eq!(grayscale_percentile(&image, 0.01), 220);
        let binary = threshold_local(
            &image,
            3,
            LocalThreshold::Wolf {
                k: 0.3,
                deviation_floor: 2.0,
                minimum_percentile: 0.01,
                hard_ink: 48,
                hard_paper: 248,
            },
        );
        assert!(binary.get(1, 1));
        assert!(!binary.get(2, 2));
    }

    #[test]
    fn grayscale_percentile_ignores_stride_padding() {
        let image = GrayImage::from_vec(
            3,
            2,
            6,
            vec![10, 20, 30, 255, 255, 255, 40, 50, 60, 255, 255, 255],
        )
        .unwrap();
        assert_eq!(
            grayscale_percentile(&image, 0.5),
            reference_grayscale_percentile(&image, 0.5)
        );
        assert_eq!(grayscale_percentile(&image, 0.5), 40);
    }

    #[test]
    fn fused_unmasked_multiscale_consensus_is_bit_exact_to_independent_scales() {
        let mut state = 0x3c4a_1e92_776d_4f08;
        let method = LocalThreshold::Wolf {
            k: 0.2,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        };
        let radii = [2, 7, 19];
        let supports_small_scale = |x: usize, y: usize| (x * 7 + y * 13) % 19 < 8;
        for (width, height, padding) in
            [(1, 1, 0), (1, 7, 3), (7, 1, 2), (29, 17, 5), (137, 131, 3)]
        {
            let image = random_image(width, height, padding, &mut state);
            let integrals = IntegralImages::new(&image);
            let expected =
                reference_multiscale_consensus(&image, radii, method, -4, supports_small_scale);
            let actual = threshold_local_multiscale_biased_with_integrals_for_consensus(
                &image,
                &integrals,
                radii,
                method,
                -4,
                supports_small_scale,
            );
            assert_eq!(
                actual.words(),
                expected.words(),
                "{width}x{height} with {padding} padding"
            );
        }
    }

    #[test]
    fn fused_unmasked_multiscale_consensus_preserves_zero_dimensions() {
        let method = LocalThreshold::Sauvola { k: 0.34 };
        for (width, height) in [(0, 0), (0, 3), (3, 0)] {
            let mut state = 0x70d6_5f21_49bc_8a12;
            let image = random_image(width, height, 4, &mut state);
            let integrals = IntegralImages::new(&image);
            let actual = threshold_local_multiscale_biased_with_integrals_for_consensus(
                &image,
                &integrals,
                [0, 1, usize::MAX],
                method,
                0,
                |_, _| true,
            );
            assert_eq!((actual.width(), actual.height()), (width, height));
            assert_eq!(actual.count_black(), 0);
        }
    }

    #[test]
    fn consensus_wolf_abstains_on_low_variance_paper_but_keeps_hard_ink() {
        let mut image = GrayImage::new(31, 23, 220);
        for y in 0..image.height() {
            for x in 0..image.width() {
                image.set(x, y, 219 + ((x * 5 + y * 3) % 3) as u8);
            }
        }
        let integrals = IntegralImages::new(&image);
        let method = LocalThreshold::Wolf {
            k: 0.2,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        };
        let flat_consensus_scale =
            threshold_local_biased_with_integrals_for_consensus(&image, &integrals, 4, method, 0);
        assert_eq!(flat_consensus_scale.count_black(), 0);

        image.set(15, 11, 40);
        let hard_ink_integrals = IntegralImages::new(&image);
        let with_hard_ink = threshold_local_biased_with_integrals_for_consensus(
            &image,
            &hard_ink_integrals,
            4,
            method,
            0,
        );
        assert!(with_hard_ink.get(15, 11));
    }

    #[test]
    fn integral_images_reuse_exact_statistics_across_radii() {
        let mut state = 0x93d7_65a2_18cf_b401;
        let image = random_image(19, 11, 4, &mut state);
        let integrals = IntegralImages::new(&image);
        for radius in [0, 1, 4, 20, usize::MAX] {
            for y in 0..image.height() {
                for x in 0..image.width() {
                    let actual = integrals.mean_and_deviation(x, y, radius);
                    let expected = naive_mean_and_deviation(&image, x, y, radius);
                    assert_eq!(actual.0.to_bits(), expected.0.to_bits());
                    assert_eq!(actual.1.to_bits(), expected.1.to_bits());
                }
            }
        }
    }

    #[test]
    fn parallel_masked_integrals_and_fused_scales_are_bit_exact() {
        let mut state = 0x7b21_f05e_942d_1ac3;
        let image = random_image(137, 131, 3, &mut state);
        let mut excluded = BinaryImage::new(image.width(), image.height());
        for y in 0..image.height() {
            for x in 0..image.width() {
                excluded.set(x, y, (x * 11 + y * 17) % 37 < 7);
            }
        }
        let integrals = MaskedIntegralImages::new(&image, &excluded);
        let radii = [2, 7, 19];
        let method = LocalThreshold::Wolf {
            k: 0.2,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        };
        let expected = radii.map(|radius| {
            threshold_local_biased_excluding_with_integrals_for_consensus(
                &image, &excluded, &integrals, radius, method, -4,
            )
        });
        let supports_small_scale = |x: usize, y: usize| (x * 7 + y * 13) % 19 < 8;
        let expected_consensus =
            BinaryImage::from_fn_parallel(image.width(), image.height(), |x, y| {
                (expected[1].get(x, y) && expected[2].get(x, y))
                    || (expected[0].get(x, y) && supports_small_scale(x, y))
            });
        let actual = threshold_local_multiscale_biased_excluding_with_integrals_for_consensus(
            &image,
            &excluded,
            &integrals,
            radii,
            method,
            -4,
            supports_small_scale,
        );
        assert_eq!(actual, expected_consensus);

        for radius in [0, 4, 80] {
            for (x, y) in [(0usize, 0usize), (53, 63), (91, 64), (136, 130)] {
                let x0 = x.saturating_sub(radius);
                let y0 = y.saturating_sub(radius);
                let x1 = x.saturating_add(radius).min(image.width() - 1);
                let y1 = y.saturating_add(radius).min(image.height() - 1);
                let mut sum = 0u64;
                let mut squared_sum = 0u64;
                let mut count = 0u64;
                for sample_y in y0..=y1 {
                    for sample_x in x0..=x1 {
                        if !excluded.get(sample_x, sample_y) {
                            let value = u64::from(image.get(sample_x, sample_y));
                            sum += value;
                            squared_sum += value * value;
                            count += 1;
                        }
                    }
                }
                let expected = if count == 0 {
                    None
                } else {
                    let mean = sum as f64 / count as f64;
                    Some((
                        mean,
                        (squared_sum as f64 / count as f64 - mean * mean)
                            .max(0.0)
                            .sqrt(),
                    ))
                };
                let actual = integrals.mean_and_deviation(x, y, radius);
                assert_eq!(
                    actual.map(|value| (value.0.to_bits(), value.1.to_bits())),
                    expected.map(|value| (value.0.to_bits(), value.1.to_bits())),
                );
            }
        }
    }

    #[test]
    fn local_thresholds_are_byte_identical_to_sliding_window_reference() {
        let mut state = 0x4f1b_a923_d7e6_508c;
        let cases = [(1, 1, 0), (2, 7, 3), (17, 13, 0), (33, 19, 5), (64, 41, 1)];
        let methods = [
            LocalThreshold::Sauvola { k: 0.34 },
            LocalThreshold::Sauvola { k: 0.17 },
            LocalThreshold::Wolf {
                k: 0.2,
                deviation_floor: 2.0,
                minimum_percentile: 0.01,
                hard_ink: 48,
                hard_paper: 248,
            },
            LocalThreshold::Wolf {
                k: 0.57,
                deviation_floor: 5.5,
                minimum_percentile: 0.13,
                hard_ink: 31,
                hard_paper: 239,
            },
        ];
        for (width, height, padding) in cases {
            let image = random_image(width, height, padding, &mut state);
            for radius in [0, 1, 3, 16, usize::MAX] {
                for method in methods {
                    for bias in [-23, 0, 19] {
                        let expected =
                            reference_threshold_local_biased(&image, radius, method, bias);
                        let actual = threshold_local_biased(&image, radius, method, bias);
                        assert_eq!(
                            actual.words(),
                            expected.words(),
                            "{width}x{height}, radius {radius}, method {method:?}, bias {bias}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn caller_provided_integrals_match_convenience_api() {
        let mut state = 0xc01d_5eed_5ca1_ab1e;
        let image = random_image(47, 29, 2, &mut state);
        let integrals = IntegralImages::new(&image);
        let method = LocalThreshold::Wolf {
            k: 0.2,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        };
        for radius in [2, 7, 18] {
            assert_eq!(
                threshold_local_with_integrals(&image, &integrals, radius, method),
                threshold_local(&image, radius, method)
            );
        }
    }

    /// The previous table-driven thresholding, serial: every window is read
    /// from the supplied full-page `IntegralImages` or `MaskedIntegralImages`.
    fn table_reference<const N: usize>(
        image: &GrayImage,
        excluded: Option<&BinaryImage>,
        table: Statistics<'_>,
        radii: [usize; N],
        method: LocalThreshold,
        bias: i16,
        floor_local_wolf_deviation: bool,
        decide: impl Fn(usize, usize, [bool; N]) -> bool,
    ) -> BinaryImage {
        let (width, height) = (image.width(), image.height());
        if width == 0 || height == 0 {
            return BinaryImage::new(width, height);
        }
        let statistics = |x, y, radius| match table {
            Statistics::Table(full) => Some(full.mean_and_deviation(x, y, radius)),
            Statistics::MaskedTable(masked) => masked.mean_and_deviation(x, y, radius),
            Statistics::Streamed => unreachable!("table_reference requires a prebuilt table"),
        };
        let global_min = match method {
            LocalThreshold::Wolf {
                minimum_percentile, ..
            } => excluded.map_or_else(
                || grayscale_percentile(image, minimum_percentile),
                |excluded| grayscale_percentile_excluding(image, excluded, minimum_percentile),
            ),
            LocalThreshold::Sauvola { .. } => 0,
        };
        let mut max_deviations = [1.0f64; N];
        if matches!(method, LocalThreshold::Wolf { .. }) {
            for y in 0..height {
                for x in 0..width {
                    for (index, &radius) in radii.iter().enumerate() {
                        max_deviations[index] = max_deviations[index]
                            .max(statistics(x, y, radius).map_or(0.0, |value| value.1));
                    }
                }
            }
        }
        let mut output = BinaryImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                if excluded.is_some_and(|excluded| excluded.get(x, y)) {
                    continue;
                }
                let value = image.get(x, y);
                let mut black = [false; N];
                for (index, &radius) in radii.iter().enumerate() {
                    let Some((mean, deviation)) = statistics(x, y, radius) else {
                        continue;
                    };
                    let threshold = match method {
                        LocalThreshold::Sauvola { k } => {
                            mean * (1.0 + k * (deviation / 128.0 - 1.0))
                        }
                        LocalThreshold::Wolf {
                            k, deviation_floor, ..
                        } => {
                            let local = if floor_local_wolf_deviation {
                                deviation.max(deviation_floor)
                            } else {
                                deviation
                            };
                            let normalized = local / max_deviations[index].max(deviation_floor);
                            mean - k * (1.0 - normalized) * (mean - f64::from(global_min))
                        }
                    };
                    let low_variance = matches!(
                        method,
                        LocalThreshold::Wolf { deviation_floor, .. }
                            if !floor_local_wolf_deviation
                                && max_deviations[index] <= deviation_floor
                    );
                    black[index] = match method {
                        LocalThreshold::Wolf { hard_ink, .. } if value <= hard_ink => true,
                        LocalThreshold::Wolf { hard_paper, .. } if value >= hard_paper => false,
                        LocalThreshold::Wolf { .. } if low_variance => false,
                        _ => f64::from(value) < (threshold + f64::from(bias)).clamp(0.0, 255.0),
                    };
                }
                output.set(x, y, decide(x, y, black));
            }
        }
        output
    }

    fn patterned_mask(width: usize, height: usize, state: &mut u64) -> BinaryImage {
        let mut excluded = BinaryImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                *state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                // Blocks plus scattered pixels leave some windows fully excluded.
                excluded.set(x, y, (x / 5 + y / 4) % 3 == 0 || *state >> 61 == 0);
            }
        }
        excluded
    }

    const WOLF: LocalThreshold = LocalThreshold::Wolf {
        k: 0.2,
        deviation_floor: 2.0,
        minimum_percentile: 0.01,
        hard_ink: 48,
        hard_paper: 248,
    };

    #[test]
    fn streaming_windows_match_full_and_masked_tables_from_any_strip_start() {
        let mut state = 0x5354_5245_414d_5749;
        for (width, height, padding) in [(1, 1, 0), (1, 9, 2), (9, 1, 1), (23, 17, 3)] {
            let image = random_image(width, height, padding, &mut state);
            let excluded = patterned_mask(width, height, &mut state);
            let full = IntegralImages::new(&image);
            let masked = MaskedIntegralImages::new(&image, &excluded);
            let radii = [0, 1, 4, height.saturating_sub(1), usize::MAX];
            for strip_start in [0, height / 2, height - 1] {
                let mut unmasked_windows = StreamingWindows::new(&image, None, radii);
                let mut masked_windows = StreamingWindows::new(&image, Some(&excluded), radii);
                for y in strip_start..height {
                    unmasked_windows.advance_to(y);
                    masked_windows.advance_to(y);
                    for x in 0..width {
                        for (index, radius) in radii.into_iter().enumerate() {
                            let bits = |value: Option<(f64, f64)>| {
                                value.map(|value| (value.0.to_bits(), value.1.to_bits()))
                            };
                            assert_eq!(
                                bits(unmasked_windows.mean_and_deviation(index, x)),
                                bits(Some(full.mean_and_deviation(x, y, radius))),
                                "{width}x{height} ({x},{y}) radius {radius}"
                            );
                            assert_eq!(
                                bits(masked_windows.mean_and_deviation(index, x)),
                                bits(masked.mean_and_deviation(x, y, radius)),
                                "masked {width}x{height} ({x},{y}) radius {radius}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn streaming_strips_are_bit_exact_to_table_driven_thresholds() {
        let mut state = 0x5354_5249_5045_5845;
        let methods = [
            LocalThreshold::Sauvola { k: 0.34 },
            WOLF,
            LocalThreshold::Wolf {
                k: 0.57,
                deviation_floor: 5.5,
                minimum_percentile: 0.13,
                hard_ink: 31,
                hard_paper: 239,
            },
        ];
        let supports_small_scale = |x: usize, y: usize| (x * 7 + y * 13) % 19 < 8;
        for (width, height, padding) in [(1, 1, 0), (5, 1, 2), (1, 6, 0), (37, 29, 3), (70, 67, 1)]
        {
            let image = random_image(width, height, padding, &mut state);
            let excluded = patterned_mask(width, height, &mut state);
            let full = IntegralImages::new(&image);
            let masked = MaskedIntegralImages::new(&image, &excluded);
            for strip_rows in [1, 3, 7, 32, height] {
                for method in methods {
                    for bias in [-11, 0, 9] {
                        for mask in [None, Some(&excluded)] {
                            let table = match mask {
                                None => Statistics::Table(&full),
                                Some(_) => Statistics::MaskedTable(&masked),
                            };
                            for statistics in [Statistics::Streamed, table] {
                                for floor in [false, true] {
                                    for radius in [0, 2, 9, height, usize::MAX] {
                                        let single = |_: usize, _: usize, [black]: [bool; 1]| black;
                                        assert_eq!(
                                            local_threshold_in_strips(
                                                &image,
                                                mask,
                                                statistics,
                                                [radius],
                                                method,
                                                bias,
                                                floor,
                                                single,
                                                strip_rows,
                                            ),
                                            table_reference(
                                                &image,
                                                mask,
                                                table,
                                                [radius],
                                                method,
                                                bias,
                                                floor,
                                                single,
                                            ),
                                            "{width}x{height} strip {strip_rows} radius {radius} \
                                         {method:?} bias {bias} masked {} floor {floor}",
                                            mask.is_some()
                                        );
                                    }
                                }
                                let decide = |x: usize, y: usize, black: [bool; 3]| {
                                    consensus(x, y, black, &supports_small_scale)
                                };
                                for radii in [[2, 7, 19], [0, 1, usize::MAX], [8, 20, 40]] {
                                    assert_eq!(
                                        local_threshold_in_strips(
                                            &image, mask, statistics, radii, method, bias, false,
                                            decide, strip_rows,
                                        ),
                                        table_reference(
                                            &image, mask, table, radii, method, bias, false,
                                            decide,
                                        ),
                                        "{width}x{height} strip {strip_rows} radii {radii:?} \
                                     {method:?} bias {bias} masked {}",
                                        mask.is_some()
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn integral_entry_points_read_the_supplied_tables() {
        // The tables, not the image and mask, decide the window statistics:
        // a table built with the pixel excluded has no window to threshold.
        let image = GrayImage::new(1, 1, 100);
        let none_excluded = BinaryImage::new(1, 1);
        let mut all_excluded = BinaryImage::new(1, 1);
        all_excluded.set(0, 0, true);
        let sauvola = LocalThreshold::Sauvola { k: 0.0 };
        let empty_window = MaskedIntegralImages::new(&image, &all_excluded);
        let pixel_window = MaskedIntegralImages::new(&image, &none_excluded);
        let threshold = |integrals: &MaskedIntegralImages| {
            threshold_local_biased_excluding_with_integrals_for_consensus(
                &image,
                &none_excluded,
                integrals,
                0,
                sauvola,
                1,
            )
            .get(0, 0)
        };
        assert!(!threshold(&empty_window));
        assert!(threshold(&pixel_window));
        let multiscale = |integrals: &MaskedIntegralImages| {
            threshold_local_multiscale_biased_excluding_with_integrals_for_consensus(
                &image,
                &none_excluded,
                integrals,
                [0, 0, 0],
                sauvola,
                1,
                |_, _| true,
            )
            .get(0, 0)
        };
        assert!(!multiscale(&empty_window));
        assert!(multiscale(&pixel_window));

        // An unmasked table from other pixels of the same size is read too.
        let darker = IntegralImages::new(&GrayImage::new(1, 1, 50));
        assert!(!threshold_local_biased_with_integrals(&image, &darker, 0, sauvola, 1).get(0, 0));
        assert!(threshold_local_biased(&image, 0, sauvola, 1).get(0, 0));
    }

    #[test]
    fn public_threshold_entry_points_match_table_driven_thresholds() {
        let mut state = 0x5055_424c_4943_4150;
        let image = random_image(137, 131, 3, &mut state);
        let excluded = patterned_mask(137, 131, &mut state);
        let integrals = IntegralImages::new(&image);
        let masked = MaskedIntegralImages::new(&image, &excluded);
        let supports_small_scale = |x: usize, y: usize| (x * 7 + y * 13) % 19 < 8;
        let decide =
            |x: usize, y: usize, black: [bool; 3]| consensus(x, y, black, &supports_small_scale);
        let single = |_: usize, _: usize, [black]: [bool; 1]| black;
        let radii = [2, 7, 19];
        assert_eq!(
            threshold_local_multiscale_biased_for_consensus(
                &image,
                radii,
                WOLF,
                -4,
                supports_small_scale
            ),
            table_reference(
                &image,
                None,
                Statistics::Table(&integrals),
                radii,
                WOLF,
                -4,
                false,
                decide
            )
        );
        assert_eq!(
            threshold_local_multiscale_biased_with_integrals_for_consensus(
                &image,
                &integrals,
                radii,
                WOLF,
                -4,
                supports_small_scale
            ),
            table_reference(
                &image,
                None,
                Statistics::Table(&integrals),
                radii,
                WOLF,
                -4,
                false,
                decide
            )
        );
        assert_eq!(
            threshold_local_multiscale_biased_excluding_for_consensus(
                &image,
                &excluded,
                radii,
                WOLF,
                -4,
                supports_small_scale
            ),
            table_reference(
                &image,
                Some(&excluded),
                Statistics::MaskedTable(&masked),
                radii,
                WOLF,
                -4,
                false,
                decide
            )
        );
        assert_eq!(
            threshold_local_biased_excluding(&image, &excluded, 9, WOLF, 3),
            table_reference(
                &image,
                Some(&excluded),
                Statistics::MaskedTable(&masked),
                [9],
                WOLF,
                3,
                true,
                single
            )
        );
        assert_eq!(
            threshold_local_biased_excluding_with_integrals_for_consensus(
                &image, &excluded, &masked, 9, WOLF, 3
            ),
            table_reference(
                &image,
                Some(&excluded),
                Statistics::MaskedTable(&masked),
                [9],
                WOLF,
                3,
                false,
                single
            )
        );
        assert_eq!(
            threshold_local_biased_with_integrals_for_consensus(&image, &integrals, 9, WOLF, 3),
            table_reference(
                &image,
                None,
                Statistics::Table(&integrals),
                [9],
                WOLF,
                3,
                false,
                single
            )
        );
        assert_eq!(
            threshold_local_biased(&image, 9, WOLF, 3),
            table_reference(
                &image,
                None,
                Statistics::Table(&integrals),
                [9],
                WOLF,
                3,
                true,
                single
            )
        );
    }

    #[test]
    #[ignore = "manual release-mode timing for the P2 report"]
    fn benchmark_wolf_integral_images_against_sliding_window() {
        let width = 2_550;
        let height = 3_300;
        let mut data = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                let paper = 205 + ((x * 13 + y * 7 + x * y % 31) % 45) as u8;
                let text = (x % 83 < 4 && y % 29 < 21) || (y % 97 < 3 && x % 211 < 130);
                data.push(if text {
                    paper.saturating_sub(170)
                } else {
                    paper
                });
            }
        }
        let image = GrayImage::from_vec(width, height, width, data).unwrap();
        let method = LocalThreshold::Wolf {
            k: 0.2,
            deviation_floor: 2.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        };

        let before_started = Instant::now();
        let before = std::hint::black_box(reference_threshold_local_biased(&image, 32, method, 0));
        let before_elapsed = before_started.elapsed();
        let after_started = Instant::now();
        let after = std::hint::black_box(threshold_local(&image, 32, method));
        let after_elapsed = after_started.elapsed();

        assert_eq!(after, before);
        eprintln!(
            "P2 wolf 2550x3300 radius=32: before={before_elapsed:?} after={after_elapsed:?} speedup={:.2}x",
            before_elapsed.as_secs_f64() / after_elapsed.as_secs_f64()
        );
    }
}
