use flate2::{write::ZlibEncoder, Compression};
use std::io::Write;

use crate::Result;

pub(crate) fn deflate_up_filtered_slices(
    pixels: &[u8],
    bytes_per_row: usize,
    height: usize,
) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    let mut filtered_row = Vec::with_capacity(bytes_per_row + 1);
    for y in 0..height {
        let src_row = y * bytes_per_row;
        let current = &pixels[src_row..src_row + bytes_per_row];
        encoder.write_all(&[2])?;

        if y == 0 {
            encoder.write_all(current)?;
        } else {
            let previous = &pixels[src_row - bytes_per_row..src_row];
            filtered_row.clear();
            filtered_row.extend(
                current
                    .iter()
                    .zip(previous)
                    .map(|(current, previous)| current.wrapping_sub(*previous)),
            );
            encoder.write_all(&filtered_row)?;
        }
    }
    let mut compressed = encoder.finish()?;
    compressed.shrink_to_fit();
    Ok(compressed)
}

pub(crate) fn deflate_up_filtered_rgb_grayscale(
    pixels: &[u8],
    width: usize,
    height: usize,
) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    let mut current_row = vec![0u8; width];
    let mut previous_row = vec![0u8; width];
    let mut filtered_row = Vec::with_capacity(width);

    for y in 0..height {
        let src_row = y * width * 3;
        for (index, gray) in current_row.iter_mut().enumerate() {
            *gray = pixels[src_row + index * 3];
        }

        encoder.write_all(&[2])?;
        if y == 0 {
            encoder.write_all(&current_row)?;
        } else {
            filtered_row.clear();
            filtered_row.extend(
                current_row
                    .iter()
                    .zip(&previous_row)
                    .map(|(current, previous)| current.wrapping_sub(*previous)),
            );
            encoder.write_all(&filtered_row)?;
        }

        std::mem::swap(&mut current_row, &mut previous_row);
    }

    let mut compressed = encoder.finish()?;
    compressed.shrink_to_fit();
    Ok(compressed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::ZlibDecoder;
    use std::io::Read;

    #[test]
    fn deflates_up_filtered_rows() {
        let compressed = deflate_up_filtered_slices(&[1, 2, 3, 4, 6, 8], 3, 2).unwrap();

        assert_eq!(inflate(&compressed), vec![2, 1, 2, 3, 2, 3, 4, 5]);
    }

    fn inflate(bytes: &[u8]) -> Vec<u8> {
        let mut decoder = ZlibDecoder::new(bytes);
        let mut inflated = Vec::new();
        decoder.read_to_end(&mut inflated).unwrap();
        inflated
    }
}
