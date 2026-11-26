//! Pure-Rust WebP decoder using `image-webp`, supporting VP8, VP8L, extended
//! VP8X, alpha compositing onto white, and ICC profile passthrough.

use std::io::Cursor;

use image_webp::WebPDecoder;

use crate::{assert_pixel_limit, composite_channel_over_white, DecodedRaster, Result};

const MAX_WEBP_ICC_PROFILE_BYTES: usize = 16 * 1024 * 1024;

/// Reads WebP dimensions without decoding pixel data.
pub fn read_webp_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    let decoder = WebPDecoder::new(Cursor::new(bytes))
        .map_err(|error| format!("Invalid WebP image: {error}"))?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 {
        return Err("Invalid WebP dimensions".into());
    }
    Ok((width, height))
}

/// Decodes a WebP image into opaque interleaved RGB8 pixels (compositing alpha
/// onto white) and preserves any embedded ICC profile within the safety limit.
pub fn decode_webp(bytes: &[u8], max_pixels: u64) -> Result<DecodedRaster> {
    let mut decoder = WebPDecoder::new(Cursor::new(bytes))
        .map_err(|error| format!("Invalid WebP image: {error}"))?;
    let (width, height) = decoder.dimensions();
    assert_pixel_limit(width, height, max_pixels)?;

    let icc_profile = decoder
        .icc_profile()
        .map_err(|error| format!("Invalid WebP ICC profile: {error}"))?
        .filter(|profile| !profile.is_empty() && profile.len() <= MAX_WEBP_ICC_PROFILE_BYTES);

    let has_alpha = decoder.has_alpha();
    let output_size = decoder
        .output_buffer_size()
        .ok_or("WebP decoded buffer size overflow")?;
    let expected_channels = if has_alpha { 4usize } else { 3usize };
    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(expected_channels))
        .ok_or("WebP decoded buffer size overflow")?;
    if output_size != expected_len {
        return Err("WebP decoded buffer size does not match image dimensions".into());
    }

    let mut raw = Vec::new();
    raw.try_reserve_exact(output_size)
        .map_err(|_| "WebP image exceeds available memory")?;
    raw.resize(output_size, 0);
    decoder
        .read_image(&mut raw)
        .map_err(|error| format!("WebP image is not decodable: {error}"))?;

    let rgb = if has_alpha {
        let mut composited = Vec::with_capacity((width as usize) * (height as usize) * 3);
        for pixel in raw.chunks_exact(4) {
            let a = pixel[3];
            if a == 255 {
                composited.extend_from_slice(&pixel[0..3]);
            } else if a == 0 {
                composited.extend_from_slice(&[255, 255, 255]);
            } else {
                composited.push(composite_channel_over_white(pixel[0], a));
                composited.push(composite_channel_over_white(pixel[1], a));
                composited.push(composite_channel_over_white(pixel[2], a));
            }
        }
        composited
    } else {
        raw
    };

    Ok(DecodedRaster {
        width,
        height,
        rgb,
        dpi: None,
        icc_profile,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image_webp::{ColorType, WebPEncoder};

    #[test]
    fn decodes_lossless_rgba_webp_composited_over_white() {
        let mut bytes = Vec::new();
        let encoder = WebPEncoder::new(&mut bytes);
        // 2x1: opaque red, 50% blue over white
        let rgba = [255, 0, 0, 255, 0, 0, 255, 0];
        encoder.encode(&rgba, 2, 1, ColorType::Rgba8).unwrap();

        assert_eq!(read_webp_dimensions(&bytes).unwrap(), (2, 1));
        let decoded = decode_webp(&bytes, 100).unwrap();
        assert_eq!((decoded.width, decoded.height), (2, 1));
        assert_eq!(decoded.rgb, vec![255, 0, 0, 255, 255, 255]);
    }

    #[test]
    fn rejects_webp_over_pixel_limit() {
        let mut bytes = Vec::new();
        let encoder = WebPEncoder::new(&mut bytes);
        encoder
            .encode(&[128u8; 4 * 4 * 3], 4, 4, ColorType::Rgb8)
            .unwrap();
        assert!(decode_webp(&bytes, 15).is_err());
    }
}
