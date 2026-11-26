//! Pure-Rust BMP decoder with upfront pixel-limit validation and white
//! compositing for alpha-bearing 32-bit bitmaps.

use crate::{assert_pixel_limit, composite_channel_over_white, DecodedRaster, Result};

const BMP_FILE_HEADER_LEN: usize = 14;
const BI_RGB: u32 = 0;
const BI_RLE8: u32 = 1;
const BI_RLE4: u32 = 2;
const BI_BITFIELDS: u32 = 3;
const BI_ALPHABITFIELDS: u32 = 6;
const METERS_PER_INCH: f64 = 0.0254;

struct BmpHeader {
    width: u32,
    height: u32,
    top_down: bool,
    bits_per_pixel: u16,
    compression: u32,
    pixel_offset: usize,
    dib_size: usize,
    palette_entry_size: usize,
    palette_count: usize,
    dpi: Option<(u32, u32)>,
    masks: [u32; 4],
    has_explicit_masks: bool,
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or("Truncated BMP header")?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or("Truncated BMP header")?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_i32_le(bytes: &[u8], offset: usize) -> Result<i32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or("Truncated BMP header")?;
    Ok(i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn parse_bmp_header(bytes: &[u8]) -> Result<BmpHeader> {
    if bytes.len() < BMP_FILE_HEADER_LEN + 12 || &bytes[0..2] != b"BM" {
        return Err("Invalid BMP signature".into());
    }
    let pixel_offset = read_u32_le(bytes, 10)? as usize;
    let dib_size = read_u32_le(bytes, BMP_FILE_HEADER_LEN)? as usize;
    if dib_size < 12 || BMP_FILE_HEADER_LEN.saturating_add(dib_size) > bytes.len() {
        return Err("Invalid BMP DIB header size".into());
    }

    if dib_size == 12 {
        // BITMAPCOREHEADER (OS/2 1.x)
        let width = u32::from(read_u16_le(bytes, 18)?);
        let height = u32::from(read_u16_le(bytes, 20)?);
        let planes = read_u16_le(bytes, 22)?;
        let bits_per_pixel = read_u16_le(bytes, 24)?;
        if planes != 1 {
            return Err(format!("Unsupported BMP plane count: {planes}").into());
        }
        let palette_count = if bits_per_pixel <= 8 {
            1usize << bits_per_pixel
        } else {
            0
        };
        return Ok(BmpHeader {
            width,
            height,
            top_down: false,
            bits_per_pixel,
            compression: BI_RGB,
            pixel_offset,
            dib_size,
            palette_entry_size: 3,
            palette_count,
            dpi: None,
            masks: [0; 4],
            has_explicit_masks: false,
        });
    }

    if dib_size < 40 {
        return Err(format!("Unsupported BMP DIB header size: {dib_size}").into());
    }

    let raw_width = read_i32_le(bytes, 18)?;
    let raw_height = read_i32_le(bytes, 22)?;
    if raw_width <= 0 || raw_height == 0 || raw_height == i32::MIN {
        return Err("Invalid BMP dimensions".into());
    }
    let width = raw_width as u32;
    let top_down = raw_height < 0;
    let height = raw_height.unsigned_abs();
    let planes = read_u16_le(bytes, 26)?;
    if planes != 1 {
        return Err(format!("Unsupported BMP plane count: {planes}").into());
    }
    let bits_per_pixel = read_u16_le(bytes, 28)?;
    let compression = read_u32_le(bytes, 30)?;
    let x_ppm = read_i32_le(bytes, 38)?;
    let y_ppm = read_i32_le(bytes, 42)?;
    let colors_used = read_u32_le(bytes, 46)? as usize;

    let dpi = if x_ppm > 0 && y_ppm > 0 {
        let dpi_x = (f64::from(x_ppm) * METERS_PER_INCH).round() as u32;
        let dpi_y = (f64::from(y_ppm) * METERS_PER_INCH).round() as u32;
        if dpi_x > 0 && dpi_y > 0 {
            Some((dpi_x, dpi_y))
        } else {
            None
        }
    } else {
        None
    };

    let mut masks = [0u32; 4];
    let mut has_explicit_masks = false;
    if dib_size >= 52 {
        masks[0] = read_u32_le(bytes, 54)?;
        masks[1] = read_u32_le(bytes, 58)?;
        masks[2] = read_u32_le(bytes, 62)?;
        if dib_size >= 56 {
            masks[3] = read_u32_le(bytes, 66)?;
        }
        has_explicit_masks =
            compression == BI_BITFIELDS || compression == BI_ALPHABITFIELDS || dib_size >= 56;
    } else if compression == BI_BITFIELDS || compression == BI_ALPHABITFIELDS {
        let mask_offset = BMP_FILE_HEADER_LEN + dib_size;
        masks[0] = read_u32_le(bytes, mask_offset)?;
        masks[1] = read_u32_le(bytes, mask_offset + 4)?;
        masks[2] = read_u32_le(bytes, mask_offset + 8)?;
        if compression == BI_ALPHABITFIELDS {
            masks[3] = read_u32_le(bytes, mask_offset + 12)?;
        }
        has_explicit_masks = true;
    }

    let palette_count = if colors_used > 0 {
        colors_used
    } else if bits_per_pixel <= 8 {
        1usize << bits_per_pixel
    } else {
        0
    };

    Ok(BmpHeader {
        width,
        height,
        top_down,
        bits_per_pixel,
        compression,
        pixel_offset,
        dib_size,
        palette_entry_size: 4,
        palette_count,
        dpi,
        masks,
        has_explicit_masks,
    })
}

/// Reads BMP dimensions without decoding pixel data.
pub fn read_bmp_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    let header = parse_bmp_header(bytes)?;
    Ok((header.width, header.height))
}

fn extract_masked_channel(word: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let max_val = mask >> shift;
    if max_val == 0 {
        return 0;
    }
    let value = (word & mask) >> shift;
    if max_val == 255 {
        value as u8
    } else {
        ((u64::from(value) * 255 + u64::from(max_val) / 2) / u64::from(max_val)) as u8
    }
}

/// Decodes a BMP image into opaque interleaved RGB8 pixels.
pub fn decode_bmp(bytes: &[u8], max_pixels: u64) -> Result<DecodedRaster> {
    let header = parse_bmp_header(bytes)?;
    assert_pixel_limit(header.width, header.height, max_pixels)?;
    if header.pixel_offset > bytes.len() {
        return Err("BMP pixel data offset exceeds file size".into());
    }

    let width = header.width as usize;
    let height = header.height as usize;
    let out_len = width
        .checked_mul(height)
        .and_then(|p| p.checked_mul(3))
        .ok_or("BMP output buffer size overflow")?;
    let mut rgb = vec![255u8; out_len];

    let pixel_data = &bytes[header.pixel_offset..];
    let row_index = |row: usize| -> usize {
        if header.top_down {
            row
        } else {
            height - 1 - row
        }
    };

    match header.compression {
        BI_RGB => match header.bits_per_pixel {
            1 | 4 | 8 => {
                let palette = read_palette(bytes, &header)?;
                let bpp = usize::from(header.bits_per_pixel);
                let row_stride = (width * bpp).div_ceil(8).div_ceil(4) * 4;
                let required = row_stride
                    .checked_mul(height)
                    .ok_or("BMP pixel data size overflow")?;
                if pixel_data.len() < required {
                    return Err("Truncated BMP indexed pixel data".into());
                }
                for src_y in 0..height {
                    let src_row = &pixel_data[src_y * row_stride..(src_y + 1) * row_stride];
                    let dst_y = row_index(src_y);
                    let dst_row = &mut rgb[dst_y * width * 3..(dst_y + 1) * width * 3];
                    for x in 0..width {
                        let idx = match bpp {
                            1 => ((src_row[x >> 3] >> (7 - (x & 7))) & 1) as usize,
                            4 => {
                                let b = src_row[x >> 1];
                                (if x & 1 == 0 { b >> 4 } else { b & 0x0f }) as usize
                            }
                            8 => usize::from(src_row[x]),
                            _ => unreachable!(),
                        };
                        let color = palette.get(idx).copied().unwrap_or([0, 0, 0]);
                        dst_row[x * 3..x * 3 + 3].copy_from_slice(&color);
                    }
                }
            }
            16 => {
                let row_stride = (width * 2).div_ceil(4) * 4;
                let required = row_stride
                    .checked_mul(height)
                    .ok_or("BMP pixel data size overflow")?;
                if pixel_data.len() < required {
                    return Err("Truncated BMP 16-bit pixel data".into());
                }
                for src_y in 0..height {
                    let src_row = &pixel_data[src_y * row_stride..(src_y + 1) * row_stride];
                    let dst_y = row_index(src_y);
                    let dst_row = &mut rgb[dst_y * width * 3..(dst_y + 1) * width * 3];
                    for x in 0..width {
                        let word =
                            u32::from(u16::from_le_bytes([src_row[x * 2], src_row[x * 2 + 1]]));
                        dst_row[x * 3] = extract_masked_channel(word, 0x7C00);
                        dst_row[x * 3 + 1] = extract_masked_channel(word, 0x03E0);
                        dst_row[x * 3 + 2] = extract_masked_channel(word, 0x001F);
                    }
                }
            }
            24 => {
                let row_stride = (width * 3).div_ceil(4) * 4;
                let required = row_stride
                    .checked_mul(height)
                    .ok_or("BMP pixel data size overflow")?;
                if pixel_data.len() < required {
                    return Err("Truncated BMP 24-bit pixel data".into());
                }
                for src_y in 0..height {
                    let src_row = &pixel_data[src_y * row_stride..(src_y + 1) * row_stride];
                    let dst_y = row_index(src_y);
                    let dst_row = &mut rgb[dst_y * width * 3..(dst_y + 1) * width * 3];
                    for x in 0..width {
                        dst_row[x * 3] = src_row[x * 3 + 2];
                        dst_row[x * 3 + 1] = src_row[x * 3 + 1];
                        dst_row[x * 3 + 2] = src_row[x * 3];
                    }
                }
            }
            32 => {
                let row_stride = width.checked_mul(4).ok_or("BMP 32-bit stride overflow")?;
                let required = row_stride
                    .checked_mul(height)
                    .ok_or("BMP pixel data size overflow")?;
                if pixel_data.len() < required {
                    return Err("Truncated BMP 32-bit pixel data".into());
                }
                // Check whether any pixel has non-zero alpha; legacy 32bpp BI_RGB BMPs
                // often leave the 4th byte as 0 (XRGB), whereas BGRA BMPs populate alpha.
                let has_alpha = (header.has_explicit_masks && header.masks[3] != 0)
                    || pixel_data[..required].chunks_exact(4).any(|p| p[3] != 0);
                for src_y in 0..height {
                    let src_row = &pixel_data[src_y * row_stride..(src_y + 1) * row_stride];
                    let dst_y = row_index(src_y);
                    let dst_row = &mut rgb[dst_y * width * 3..(dst_y + 1) * width * 3];
                    for x in 0..width {
                        let b = src_row[x * 4];
                        let g = src_row[x * 4 + 1];
                        let r = src_row[x * 4 + 2];
                        let a = src_row[x * 4 + 3];
                        if has_alpha && a != 255 {
                            dst_row[x * 3] = composite_channel_over_white(r, a);
                            dst_row[x * 3 + 1] = composite_channel_over_white(g, a);
                            dst_row[x * 3 + 2] = composite_channel_over_white(b, a);
                        } else {
                            dst_row[x * 3] = r;
                            dst_row[x * 3 + 1] = g;
                            dst_row[x * 3 + 2] = b;
                        }
                    }
                }
            }
            bpp => return Err(format!("Unsupported BMP bit depth: {bpp}").into()),
        },
        BI_BITFIELDS | BI_ALPHABITFIELDS => {
            if !matches!(header.bits_per_pixel, 16 | 32) {
                return Err(format!(
                    "Unsupported BMP BI_BITFIELDS bit depth: {}",
                    header.bits_per_pixel
                )
                .into());
            }
            let [rm, gm, bm, am] = header.masks;
            let bytes_per_pixel = usize::from(header.bits_per_pixel) / 8;
            let row_stride = (width * bytes_per_pixel).div_ceil(4) * 4;
            let required = row_stride
                .checked_mul(height)
                .ok_or("BMP pixel data size overflow")?;
            if pixel_data.len() < required {
                return Err("Truncated BMP bitfields pixel data".into());
            }
            for src_y in 0..height {
                let src_row = &pixel_data[src_y * row_stride..(src_y + 1) * row_stride];
                let dst_y = row_index(src_y);
                let dst_row = &mut rgb[dst_y * width * 3..(dst_y + 1) * width * 3];
                for x in 0..width {
                    let word = if bytes_per_pixel == 2 {
                        u32::from(u16::from_le_bytes([src_row[x * 2], src_row[x * 2 + 1]]))
                    } else {
                        u32::from_le_bytes([
                            src_row[x * 4],
                            src_row[x * 4 + 1],
                            src_row[x * 4 + 2],
                            src_row[x * 4 + 3],
                        ])
                    };
                    let r = extract_masked_channel(word, rm);
                    let g = extract_masked_channel(word, gm);
                    let b = extract_masked_channel(word, bm);
                    if am != 0 {
                        let a = extract_masked_channel(word, am);
                        dst_row[x * 3] = composite_channel_over_white(r, a);
                        dst_row[x * 3 + 1] = composite_channel_over_white(g, a);
                        dst_row[x * 3 + 2] = composite_channel_over_white(b, a);
                    } else {
                        dst_row[x * 3] = r;
                        dst_row[x * 3 + 1] = g;
                        dst_row[x * 3 + 2] = b;
                    }
                }
            }
        }
        BI_RLE8 if header.bits_per_pixel == 8 => {
            let palette = read_palette(bytes, &header)?;
            decode_rle(
                pixel_data,
                width,
                height,
                header.top_down,
                &palette,
                false,
                &mut rgb,
            )?;
        }
        BI_RLE4 if header.bits_per_pixel == 4 => {
            let palette = read_palette(bytes, &header)?;
            decode_rle(
                pixel_data,
                width,
                height,
                header.top_down,
                &palette,
                true,
                &mut rgb,
            )?;
        }
        compression => {
            return Err(format!("Unsupported BMP compression mode: {compression}").into());
        }
    }

    Ok(DecodedRaster {
        width: header.width,
        height: header.height,
        rgb,
        dpi: header.dpi,
        icc_profile: None,
    })
}

fn read_palette(bytes: &[u8], header: &BmpHeader) -> Result<Vec<[u8; 3]>> {
    let palette_start = BMP_FILE_HEADER_LEN + header.dib_size;
    let entry_size = header.palette_entry_size;
    let available = header.pixel_offset.saturating_sub(palette_start) / entry_size;
    let count = header.palette_count.min(available).min(256);
    if count == 0 {
        return Err("BMP indexed image has no color palette".into());
    }
    let mut palette = Vec::with_capacity(count);
    for i in 0..count {
        let base = palette_start + i * entry_size;
        palette.push([bytes[base + 2], bytes[base + 1], bytes[base]]);
    }
    Ok(palette)
}

fn decode_rle(
    data: &[u8],
    width: usize,
    height: usize,
    top_down: bool,
    palette: &[[u8; 3]],
    four_bit: bool,
    rgb: &mut [u8],
) -> Result<()> {
    let mut pos = 0usize;
    let mut x = 0usize;
    let mut y = 0usize;
    let mut set_px = |px: usize, py: usize, idx: usize| {
        if px < width && py < height {
            let dst_y = if top_down { py } else { height - 1 - py };
            let off = (dst_y * width + px) * 3;
            let color = palette.get(idx).copied().unwrap_or([0, 0, 0]);
            rgb[off..off + 3].copy_from_slice(&color);
        }
    };

    while pos + 1 < data.len() {
        let count = usize::from(data[pos]);
        let value = data[pos + 1];
        pos += 2;
        if count > 0 {
            if four_bit {
                let hi = usize::from(value >> 4);
                let lo = usize::from(value & 0x0f);
                for i in 0..count {
                    set_px(x, y, if i & 1 == 0 { hi } else { lo });
                    x += 1;
                }
            } else {
                let idx = usize::from(value);
                for _ in 0..count {
                    set_px(x, y, idx);
                    x += 1;
                }
            }
        } else {
            match value {
                0 => {
                    x = 0;
                    y += 1;
                }
                1 => break,
                2 => {
                    if pos + 1 >= data.len() {
                        return Err("Truncated BMP RLE delta".into());
                    }
                    x = x.saturating_add(usize::from(data[pos]));
                    y = y.saturating_add(usize::from(data[pos + 1]));
                    pos += 2;
                }
                literal => {
                    let lit = usize::from(literal);
                    let byte_len = if four_bit { lit.div_ceil(2) } else { lit };
                    let padded_len = byte_len + (byte_len & 1);
                    if pos + byte_len > data.len() {
                        return Err("Truncated BMP RLE literal run".into());
                    }
                    if four_bit {
                        for i in 0..lit {
                            let b = data[pos + (i >> 1)];
                            let idx = usize::from(if i & 1 == 0 { b >> 4 } else { b & 0x0f });
                            set_px(x, y, idx);
                            x += 1;
                        }
                    } else {
                        for i in 0..lit {
                            set_px(x, y, usize::from(data[pos + i]));
                            x += 1;
                        }
                    }
                    pos = (pos + padded_len).min(data.len());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_24bit_bmp(width: u32, height: i32, pixels_bgr: &[u8]) -> Vec<u8> {
        let row_stride = (width as usize * 3).div_ceil(4) * 4;
        let pixel_size = row_stride * height.unsigned_abs() as usize;
        let file_size = 54 + pixel_size;
        let mut out = Vec::with_capacity(file_size);
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&(file_size as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&54u32.to_le_bytes());
        out.extend_from_slice(&40u32.to_le_bytes());
        out.extend_from_slice(&(width as i32).to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&24u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(pixel_size as u32).to_le_bytes());
        // 300 DPI = 11811 pixels/meter
        out.extend_from_slice(&11811i32.to_le_bytes());
        out.extend_from_slice(&11811i32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(pixels_bgr);
        out
    }

    #[test]
    fn decodes_bottom_up_24bit_bmp_and_extracts_dpi() {
        // 2x2: bottom row is red/green, top row is blue/white (padded to 8 bytes/row)
        let pixels = [
            0, 0, 255, 0, 255, 0, 0, 0, // y=1 (bottom)
            255, 0, 0, 255, 255, 255, 0, 0, // y=0 (top)
        ];
        let bmp = make_24bit_bmp(2, 2, &pixels);
        assert_eq!(read_bmp_dimensions(&bmp).unwrap(), (2, 2));
        let decoded = decode_bmp(&bmp, 100).unwrap();
        assert_eq!((decoded.width, decoded.height), (2, 2));
        assert_eq!(decoded.dpi, Some((300, 300)));
        assert_eq!(
            decoded.rgb,
            vec![
                0, 0, 255, 255, 255, 255, // top row: blue, white
                255, 0, 0, 0, 255, 0, // bottom row: red, green
            ]
        );
    }

    #[test]
    fn rejects_bmp_exceeding_pixel_limit_before_decoding() {
        let bmp = make_24bit_bmp(2, 2, &[0u8; 16]);
        assert!(decode_bmp(&bmp, 3).is_err());
    }
}
