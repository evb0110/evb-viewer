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

    decoder.set_memory_limit(MAX_WEBP_ICC_PROFILE_BYTES);
    let icc_profile = match decoder.icc_profile() {
        Ok(profile) => profile.filter(|profile| !profile.is_empty()),
        Err(image_webp::DecodingError::MemoryLimitExceeded) => None,
        Err(error) => return Err(format!("Invalid WebP ICC profile: {error}").into()),
    };

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

    // Restore a decode budget covering internal frame buffers for admitted dimensions.
    decoder.set_memory_limit(
        output_size
            .saturating_mul(2)
            .max(MAX_WEBP_ICC_PROFILE_BYTES),
    );
    let mut raw = Vec::new();
    raw.try_reserve_exact(output_size)
        .map_err(|_| "WebP image exceeds available memory")?;
    raw.resize(output_size, 0);
    decoder
        .read_image(&mut raw)
        .map_err(|error| format!("WebP image is not decodable: {error}"))?;

    let rgb = if has_alpha {
        // Composite RGBA onto white in place (3*i <= 4*i) so peak decode memory
        // stays at 4 bytes/pixel instead of holding RGBA and RGB buffers at once.
        let pixel_count = (width as usize) * (height as usize);
        for i in 0..pixel_count {
            let src = i * 4;
            let dst = i * 3;
            let r = raw[src];
            let g = raw[src + 1];
            let b = raw[src + 2];
            let a = raw[src + 3];
            if a == 255 {
                raw[dst] = r;
                raw[dst + 1] = g;
                raw[dst + 2] = b;
            } else if a == 0 {
                raw[dst] = 255;
                raw[dst + 1] = 255;
                raw[dst + 2] = 255;
            } else {
                raw[dst] = composite_channel_over_white(r, a);
                raw[dst + 1] = composite_channel_over_white(g, a);
                raw[dst + 2] = composite_channel_over_white(b, a);
            }
        }
        raw.truncate(pixel_count * 3);
        raw.shrink_to_fit();
        raw
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
