//! Small deterministic separable Gaussian blur helpers.

use rayon::prelude::*;

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

    let blur_horizontal_row = |y: usize, row_out: &mut [f32]| {
        let row_in = &source[y * width..(y + 1) * width];
        for (x, pixel) in row_out.iter_mut().enumerate() {
            let mut sum = f64::from(row_in[x]) * kernel[0];
            for (offset, &weight) in kernel.iter().enumerate().skip(1) {
                let left = x.saturating_sub(offset);
                let right = x.saturating_add(offset).min(width - 1);
                sum += f64::from(row_in[left]) * weight;
                sum += f64::from(row_in[right]) * weight;
            }
            *pixel = sum as f32;
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

    let blur_vertical_row = |y: usize, row_out: &mut [f32]| {
        let center_row = &horizontal[y * width..(y + 1) * width];
        for (x, pixel) in row_out.iter_mut().enumerate() {
            let mut sum = f64::from(center_row[x]) * kernel[0];
            for (offset, &weight) in kernel.iter().enumerate().skip(1) {
                let top = y.saturating_sub(offset);
                let bottom = y.saturating_add(offset).min(height - 1);
                sum += f64::from(horizontal[top * width + x]) * weight;
                sum += f64::from(horizontal[bottom * width + x]) * weight;
            }
            *pixel = sum as f32;
        }
    };

    let mut output = vec![0.0f32; source.len()];
    if source.len() >= PARALLEL_BLUR_MIN_PIXELS {
        output
            .par_chunks_mut(width)
            .enumerate()
            .for_each(|(y, row_out)| blur_vertical_row(y, row_out));
    } else {
        for (y, row_out) in output.chunks_mut(width).enumerate() {
            blur_vertical_row(y, row_out);
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
}
