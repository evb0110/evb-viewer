use rayon::prelude::*;
use std::borrow::Cow;

/// Owned tightly packed 8-bit RGB image.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RgbImage {
    width: usize,
    height: usize,
    data: Vec<u8>,
}

impl RgbImage {
    pub fn new(width: usize, height: usize, fill: [u8; 3]) -> Self {
        let mut data = vec![0; width.saturating_mul(height).saturating_mul(3)];
        for pixel in data.chunks_exact_mut(3) {
            pixel.copy_from_slice(&fill);
        }
        Self {
            width,
            height,
            data,
        }
    }

    pub fn from_vec(width: usize, height: usize, data: Vec<u8>) -> Option<Self> {
        (data.len() == width.checked_mul(height)?.checked_mul(3)?).then_some(Self {
            width,
            height,
            data,
        })
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }

    pub fn into_data(self) -> Vec<u8> {
        self.data
    }

    pub fn data_mut(&mut self) -> &mut [u8] {
        &mut self.data
    }

    pub fn row(&self, y: usize) -> &[u8] {
        &self.data[y * self.width * 3..(y + 1) * self.width * 3]
    }

    pub fn get(&self, x: usize, y: usize) -> [u8; 3] {
        self.data[(y * self.width + x) * 3..(y * self.width + x + 1) * 3]
            .try_into()
            .unwrap()
    }

    pub fn set(&mut self, x: usize, y: usize, value: [u8; 3]) {
        self.data[(y * self.width + x) * 3..(y * self.width + x + 1) * 3].copy_from_slice(&value);
    }

    /// Resamples to the exact requested dimensions: area averaging where the
    /// image shrinks, bilinear interpolation where it grows.
    pub fn resample_to_dimensions(&self, out_width: usize, out_height: usize) -> Self {
        assert!(out_width > 0);
        assert!(out_height > 0);
        if self.width == out_width && self.height == out_height {
            return self.clone();
        }
        if out_width <= self.width && out_height <= self.height {
            return self.area_average_to_dimensions(out_width, out_height);
        }
        let intermediate = if out_width < self.width {
            Cow::Owned(self.area_average_to_dimensions(out_width, self.height))
        } else if out_height < self.height {
            Cow::Owned(self.area_average_to_dimensions(self.width, out_height))
        } else {
            Cow::Borrowed(self)
        };
        let x_map = crate::gray::axis_samples(intermediate.width, out_width);
        let y_map = crate::gray::axis_samples(intermediate.height, out_height);
        let mut output = Self::new(out_width, out_height, [255; 3]);
        output
            .data_mut()
            .par_chunks_mut(out_width * 3)
            .enumerate()
            .for_each(|(output_y, row)| {
                let (y0, y1, wy) = y_map[output_y];
                let top_row = intermediate.row(y0);
                let bottom_row = intermediate.row(y1);
                for (target, &(x0, x1, wx)) in row.chunks_exact_mut(3).zip(&x_map) {
                    let top_left = &top_row[x0 * 3..x0 * 3 + 3];
                    let top_right = &top_row[x1 * 3..x1 * 3 + 3];
                    let bottom_left = &bottom_row[x0 * 3..x0 * 3 + 3];
                    let bottom_right = &bottom_row[x1 * 3..x1 * 3 + 3];
                    for (channel, value) in target.iter_mut().enumerate() {
                        let top = f64::from(top_left[channel]) * (1.0 - wx)
                            + f64::from(top_right[channel]) * wx;
                        let bottom = f64::from(bottom_left[channel]) * (1.0 - wx)
                            + f64::from(bottom_right[channel]) * wx;
                        *value = (top * (1.0 - wy) + bottom * wy).round().clamp(0.0, 255.0) as u8;
                    }
                }
            });
        output
    }

    fn area_average_to_dimensions(&self, out_width: usize, out_height: usize) -> Self {
        let x_taps = crate::gray::AreaTaps::new(self.width, out_width);
        let y_taps = crate::gray::AreaTaps::new(self.height, out_height);
        let area = self.width as u64 * self.height as u64;
        let mut output = Self::new(out_width, out_height, [255; 3]);
        output
            .data_mut()
            .par_chunks_mut(out_width * 3)
            .enumerate()
            .for_each_init(
                || vec![0u64; self.width * 3],
                |columns, (output_y, row)| {
                    columns.fill(0);
                    crate::gray::accumulate_rows(columns, y_taps.get(output_y), |y| self.row(y));
                    for (ox, target) in row.chunks_exact_mut(3).enumerate() {
                        let (first, weights) = x_taps.get(ox);
                        let mut sums = [0u64; 3];
                        for (offset, &weight) in weights.iter().enumerate() {
                            let base = (first + offset) * 3;
                            sums[0] += weight * columns[base];
                            sums[1] += weight * columns[base + 1];
                            sums[2] += weight * columns[base + 2];
                        }
                        target[0] = (sums[0] / area) as u8;
                        target[1] = (sums[1] / area) as u8;
                        target[2] = (sums[2] / area) as u8;
                    }
                },
            );
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractional_horizontal_reduction_integrates_partial_pixel_coverage() {
        let source = RgbImage::from_vec(3, 1, vec![0, 0, 0, 255, 255, 255, 255, 255, 255]).unwrap();
        assert_eq!(
            source.resample_to_dimensions(2, 1).data(),
            &[85, 85, 85, 255, 255, 255],
            "RGB reduction must integrate the half-covered white pixel"
        );
    }

    #[test]
    fn fractional_vertical_reduction_preserves_symmetric_tones() {
        let source = RgbImage::from_vec(1, 3, vec![255, 255, 255, 0, 0, 0, 255, 255, 255]).unwrap();
        assert_eq!(
            source.resample_to_dimensions(1, 2).data(),
            &[170; 6],
            "RGB reduction must preserve the symmetry of a white-black-white column"
        );
    }

    #[test]
    fn construction_rows_and_mutation_match_the_scan_cleanup_type() {
        let mut image = RgbImage::new(2, 2, [17, 34, 51]);

        assert_eq!(image.width(), 2);
        assert_eq!(image.height(), 2);
        assert_eq!(
            image.data(),
            &[17, 34, 51, 17, 34, 51, 17, 34, 51, 17, 34, 51]
        );
        assert_eq!(image.row(1), &[17, 34, 51, 17, 34, 51]);
        assert_eq!(image.get(1, 0), [17, 34, 51]);
        image.set(1, 0, [7, 8, 9]);
        image.data_mut()[0..3].copy_from_slice(&[1, 2, 3]);
        assert_eq!(image.row(0), &[1, 2, 3, 7, 8, 9]);
    }

    #[test]
    fn from_vec_requires_an_exact_packed_rgb_buffer() {
        let pixels = vec![1, 2, 3, 4, 5, 6];

        assert_eq!(
            RgbImage::from_vec(2, 1, pixels.clone()).unwrap().data(),
            pixels
        );
        assert!(RgbImage::from_vec(2, 1, vec![1, 2, 3, 4, 5]).is_none());
        assert!(RgbImage::from_vec(usize::MAX, 2, Vec::new()).is_none());
    }
}
