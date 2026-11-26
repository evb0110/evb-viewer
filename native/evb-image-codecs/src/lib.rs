//! Shared pure-Rust and browser-WASM image codecs for PDF page operations
//! and image-to-PDF assembly.

pub mod bmp;
pub mod ccitt;
pub mod gif_codec;
pub mod jpeg;
pub mod pdf_image_samples;
pub mod webp;

use std::error::Error;

use evb_native_support::{NativeError, NativeErrorCode};

pub use crate::jpeg::{recompress_jpeg, RecompressedJpeg};

pub const DEFAULT_MAX_IMAGE_PIXELS: u64 = 80_000_000;
pub const CM_PER_INCH: f64 = 2.54;
pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// A decoded 8-bit opaque raster (composited onto white when the source
/// carried alpha or transparency), ready for PDF image encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedRaster {
    pub width: u32,
    pub height: u32,
    /// Interleaved RGB8 bytes (`width * height * 3`).
    pub rgb: Vec<u8>,
    pub dpi: Option<(u32, u32)>,
    pub icc_profile: Option<Vec<u8>>,
}

pub fn too_large_error(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(NativeError::new(NativeErrorCode::TooLarge, message))
}

pub fn assert_pixel_limit(width: u32, height: u32, max_pixels: u64) -> Result<()> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || pixels > max_pixels {
        return Err(too_large_error(format!(
            "Image dimensions are too large to combine safely: {width}x{height}"
        )));
    }
    Ok(())
}

pub fn is_rgb_data_grayscale(pixels: &[u8], total_pixels: usize) -> bool {
    let Some(expected_len) = total_pixels.checked_mul(3) else {
        return false;
    };
    let Some(pixels) = pixels.get(..expected_len) else {
        return false;
    };

    pixels
        .chunks_exact(3)
        .all(|pixel| pixel[0] == pixel[1] && pixel[0] == pixel[2])
}

#[inline]
pub(crate) fn composite_channel_over_white(value: u8, alpha: u8) -> u8 {
    ((u32::from(value) * u32::from(alpha) + 255 * u32::from(255 - alpha) + 127) / 255) as u8
}

#[inline]
pub(crate) fn read_u16_be(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
    ]))
}
