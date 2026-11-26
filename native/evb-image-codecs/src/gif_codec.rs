//! Pure-Rust GIF decoder using the `gif` crate, compositing the first frame
//! onto white with upfront pixel-limit validation.

use std::{io::Cursor, num::NonZeroU64};

use crate::{assert_pixel_limit, composite_channel_over_white, DecodedRaster, Result};

/// Reads the logical screen dimensions from a GIF header without decoding frames.
pub fn read_gif_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    if bytes.len() < 10 || (&bytes[0..6] != b"GIF87a" && &bytes[0..6] != b"GIF89a") {
        return Err("Invalid GIF signature".into());
    }
    let width = u32::from(u16::from_le_bytes([bytes[6], bytes[7]]));
    let height = u32::from(u16::from_le_bytes([bytes[8], bytes[9]]));
    if width == 0 || height == 0 {
        return Err("Invalid GIF dimensions".into());
    }
    Ok((width, height))
}

/// Decodes the first frame of a GIF onto a white canvas as opaque interleaved RGB8.
pub fn decode_gif(bytes: &[u8], max_pixels: u64) -> Result<DecodedRaster> {
    let (screen_width, screen_height) = read_gif_dimensions(bytes)?;
    assert_pixel_limit(screen_width, screen_height, max_pixels)?;

    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::RGBA);
    options.check_frame_consistency(true);
    // Bound internal gif decoder allocations to the admitted canvas size (4 Bpp + overhead).
    let max_bytes = (screen_width as usize)
        .checked_mul(screen_height as usize)
        .and_then(|p| p.checked_mul(4))
        .and_then(|b| b.checked_add(1024 * 1024))
        .ok_or("GIF buffer size overflow")?;
    let limit = NonZeroU64::new(max_bytes as u64).ok_or("GIF memory limit must be positive")?;
    options.set_memory_limit(gif::MemoryLimit::Bytes(limit));

    let mut decoder = options
        .read_info(Cursor::new(bytes))
        .map_err(|error| format!("Invalid GIF image: {error}"))?;
    let frame = decoder
        .read_next_frame()
        .map_err(|error| format!("GIF frame is not decodable: {error}"))?
        .ok_or("GIF contains no decodable frames")?;

    let canvas_w = screen_width as usize;
    let canvas_h = screen_height as usize;
    let out_len = canvas_w
        .checked_mul(canvas_h)
        .and_then(|p| p.checked_mul(3))
        .ok_or("GIF output buffer size overflow")?;
    let mut rgb = vec![255u8; out_len];

    let frame_left = usize::from(frame.left);
    let frame_top = usize::from(frame.top);
    let frame_w = usize::from(frame.width);
    let frame_h = usize::from(frame.height);
    let src = frame.buffer.as_ref();

    for fy in 0..frame_h {
        let dst_y = frame_top + fy;
        if dst_y >= canvas_h {
            break;
        }
        for fx in 0..frame_w {
            let dst_x = frame_left + fx;
            if dst_x >= canvas_w {
                break;
            }
            let s_off = (fy * frame_w + fx) * 4;
            if s_off + 3 >= src.len() {
                break;
            }
            let a = src[s_off + 3];
            if a == 0 {
                continue;
            }
            let d_off = (dst_y * canvas_w + dst_x) * 3;
            if a == 255 {
                rgb[d_off] = src[s_off];
                rgb[d_off + 1] = src[s_off + 1];
                rgb[d_off + 2] = src[s_off + 2];
            } else {
                rgb[d_off] = composite_channel_over_white(src[s_off], a);
                rgb[d_off + 1] = composite_channel_over_white(src[s_off + 1], a);
                rgb[d_off + 2] = composite_channel_over_white(src[s_off + 2], a);
            }
        }
    }

    Ok(DecodedRaster {
        width: screen_width,
        height: screen_height,
        rgb,
        dpi: None,
        icc_profile: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_transparent_gif_composited_over_white() {
        let mut bytes = Vec::new();
        {
            let palette = [255, 0, 0, 0, 0, 255];
            let mut encoder = gif::Encoder::new(&mut bytes, 2, 1, &palette).unwrap();
            let mut frame = gif::Frame::from_indexed_pixels(2, 1, vec![0, 1], Some(1));
            frame.palette = None;
            encoder.write_frame(&frame).unwrap();
        }
        assert_eq!(read_gif_dimensions(&bytes).unwrap(), (2, 1));
        let decoded = decode_gif(&bytes, 100).unwrap();
        assert_eq!((decoded.width, decoded.height), (2, 1));
        // Pixel 0 = red, Pixel 1 = transparent -> composited onto white
        assert_eq!(decoded.rgb, vec![255, 0, 0, 255, 255, 255]);
    }

    #[test]
    fn rejects_gif_over_pixel_limit() {
        let mut bytes = Vec::new();
        {
            let mut encoder = gif::Encoder::new(&mut bytes, 4, 4, &[0, 0, 0]).unwrap();
            let frame = gif::Frame::from_indexed_pixels(4, 4, vec![0; 16], None);
            encoder.write_frame(&frame).unwrap();
        }
        assert!(decode_gif(&bytes, 15).is_err());
    }
}
