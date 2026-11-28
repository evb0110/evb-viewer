//! Small deterministic separable Gaussian blur helpers.

use crate::parallel::prelude::*;

const PARALLEL_BLUR_MIN_PIXELS: usize = 4_096;

/// Blurs a tightly-packed floating-point raster with a normalized Gaussian
/// kernel truncated at three standard deviations. Edges are extended by
/// clamping, which keeps a constant raster constant and avoids dark frames.
pub fn gaussian_blur_f32(source: &[f32], width: usize, height: usize, sigma: f64) -> Vec<f32> {
    assert_eq!(source.len(), width.saturating_mul(height));
    if source.is_empty() || sigma <= 0.0 {
        return source.to_vec();
    }
    let radius = (sigma * 3.0).ceil() as usize;
    let mut kernel = (0..=radius)
        .map(|offset| (-0.5 * (offset as f64 / sigma).powi(2)).exp())
        .collect::<Vec<_>>();
    let normalization = kernel[0] + 2.0 * kernel[1..].iter().sum::<f64>();
    for value in &mut kernel {
        *value /= normalization;
    }

    let center_weight = kernel[0];
    let tail_weights = &kernel[1..];
    let interior_start = radius.min(width);
    let interior_end = width.saturating_sub(radius);

    let blur_horizontal_row = |y: usize, row_out: &mut [f32]| {
        let row_in = &source[y * width..(y + 1) * width];
        let blur_clamped = |x: usize| -> f32 {
            let mut sum = f64::from(row_in[x]) * center_weight;
            for (offset, &weight) in tail_weights.iter().enumerate() {
                let offset = offset + 1;
                let left = x.saturating_sub(offset);
                let right = x.saturating_add(offset).min(width - 1);
                sum += f64::from(row_in[left]) * weight;
                sum += f64::from(row_in[right]) * weight;
            }
            sum as f32
        };

        for (x, pixel) in row_out[..interior_start].iter_mut().enumerate() {
            *pixel = blur_clamped(x);
        }
        if interior_start < interior_end {
            for x in interior_start..interior_end {
                let mut sum = f64::from(row_in[x]) * center_weight;
                for (offset, &weight) in tail_weights.iter().enumerate() {
                    let offset = offset + 1;
                    sum += f64::from(row_in[x - offset]) * weight;
                    sum += f64::from(row_in[x + offset]) * weight;
                }
                row_out[x] = sum as f32;
            }
        }
        let right_start = interior_end.max(interior_start);
        for (offset, pixel) in row_out[right_start..].iter_mut().enumerate() {
            *pixel = blur_clamped(right_start + offset);
        }
    };

    let mut horizontal = vec![0.0f32; source.len()];
    if source.len() >= PARALLEL_BLUR_MIN_PIXELS {
        horizontal
            .par_chunks_mut(width)
            .enumerate()
            .for_each(|(y, row_out)| blur_horizontal_row(y, row_out));
    } else {
        for (y, row_out) in horizontal.chunks_mut(width).enumerate() {
            blur_horizontal_row(y, row_out);
        }
    }

    let blur_vertical_row = |acc: &mut [f64], y: usize, row_out: &mut [f32]| {
        let center_row = &horizontal[y * width..(y + 1) * width];
        for (sum, &value) in acc.iter_mut().zip(center_row) {
            *sum = f64::from(value) * center_weight;
        }
        for (offset, &weight) in tail_weights.iter().enumerate() {
            let offset = offset + 1;
            let top = y.saturating_sub(offset);
            let bottom = y.saturating_add(offset).min(height - 1);
            let top_row = &horizontal[top * width..(top + 1) * width];
            let bottom_row = &horizontal[bottom * width..(bottom + 1) * width];
            for ((sum, &top_val), &bottom_val) in acc.iter_mut().zip(top_row).zip(bottom_row) {
                *sum += f64::from(top_val) * weight;
                *sum += f64::from(bottom_val) * weight;
            }
        }
        for (pixel, &sum) in row_out.iter_mut().zip(acc.iter()) {
            *pixel = sum as f32;
        }
    };

    let mut output = vec![0.0f32; source.len()];
    if source.len() >= PARALLEL_BLUR_MIN_PIXELS {
        output.par_chunks_mut(width).enumerate().for_each_init(
            || vec![0.0f64; width],
            |acc, (y, row_out)| blur_vertical_row(acc, y, row_out),
        );
    } else {
        let mut acc = vec![0.0f64; width];
        for (y, row_out) in output.chunks_mut(width).enumerate() {
            blur_vertical_row(&mut acc, y, row_out);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gaussian_blur_preserves_constants_and_symmetry() {
        let constant = gaussian_blur_f32(&[7.0; 35], 7, 5, 2.0);
        assert!(constant.iter().all(|value| (*value - 7.0).abs() < 1e-5));

        let mut impulse = vec![0.0; 49];
        impulse[24] = 1.0;
        let blurred = gaussian_blur_f32(&impulse, 7, 7, 1.0);
        assert!((blurred[23] - blurred[25]).abs() < 1e-6);
        assert!((blurred[17] - blurred[31]).abs() < 1e-6);
        assert!(blurred[24] > blurred[23]);
    }

    #[test]
    fn gaussian_blur_row_major_and_peeled_borders_are_bit_identical_to_direct_clamp() {
        fn reference_blur(source: &[f32], width: usize, height: usize, sigma: f64) -> Vec<f32> {
            let radius = (sigma * 3.0).ceil() as usize;
            let mut kernel = (0..=radius)
                .map(|offset| (-0.5 * (offset as f64 / sigma).powi(2)).exp())
                .collect::<Vec<_>>();
            let norm = kernel[0] + 2.0 * kernel[1..].iter().sum::<f64>();
            for v in &mut kernel {
                *v /= norm;
            }
            let mut h = vec![0.0f32; source.len()];
            for y in 0..height {
                for x in 0..width {
                    let mut sum = f64::from(source[y * width + x]) * kernel[0];
                    for (offset, &w) in kernel.iter().enumerate().skip(1) {
                        sum += f64::from(source[y * width + x.saturating_sub(offset)]) * w;
                        sum += f64::from(source[y * width + (x + offset).min(width - 1)]) * w;
                    }
                    h[y * width + x] = sum as f32;
                }
            }
            let mut out = vec![0.0f32; source.len()];
            for y in 0..height {
                for x in 0..width {
                    let mut sum = f64::from(h[y * width + x]) * kernel[0];
                    for (offset, &w) in kernel.iter().enumerate().skip(1) {
                        sum += f64::from(h[y.saturating_sub(offset) * width + x]) * w;
                        sum += f64::from(h[(y + offset).min(height - 1) * width + x]) * w;
                    }
                    out[y * width + x] = sum as f32;
                }
            }
            out
        }

        let mut state = 0x424c_5552_5f52_4546_u64;
        for (width, height, sigma) in [
            (1, 1, 1.5),
            (3, 9, 2.5),
            (17, 5, 1.2),
            (73, 61, 2.0), // >= PARALLEL_BLUR_MIN_PIXELS
        ] {
            let source: Vec<f32> = (0..width * height)
                .map(|_| {
                    state = state
                        .wrapping_mul(6_364_136_223_846_793_005)
                        .wrapping_add(1_442_695_040_888_963_407);
                    ((state >> 40) as f32) / 16_777_216.0 * 255.0
                })
                .collect();
            let actual = gaussian_blur_f32(&source, width, height, sigma);
            let expected = reference_blur(&source, width, height, sigma);
            assert_eq!(actual.len(), expected.len());
            for (i, (&a, &e)) in actual.iter().zip(&expected).enumerate() {
                assert_eq!(
                    a.to_bits(),
                    e.to_bits(),
                    "bit mismatch at {i} for {width}x{height} sigma={sigma}: {a} vs {e}"
                );
            }
        }
    }
}
