//! The decoded samples of a PDF image stream, as a scan raster needs them:
//! the full-resolution plane, before the PDF Decode map, with the codec's own
//! polarity turned into PDF sample polarity.
//!
//! Each entry returns `Ok(None)` for a valid variant it does not decode (the
//! caller then draws the page with its general renderer) and an error for
//! data that is not decodable.

use std::io::Cursor;

use hayro_jpeg2000::{DecodeSettings, Image};
use zune_jpeg::{
    zune_core::{colorspace::ColorSpace, options::DecoderOptions},
    JpegDecoder,
};

use crate::Result;

/// A decoded plane: 8-bit interleaved gray or RGB, or MSB-first one-bit rows
/// padded to whole bytes, in PDF sample polarity (one is white for one-bit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedSamples {
    pub width: u32,
    pub height: u32,
    pub components: u8,
    pub bits_per_component: u8,
    pub data: Vec<u8>,
}

fn admit(width: u32, height: u32, components: u8, max_pixels: u64) -> Result<()> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > max_pixels {
        return Err(format!("image of {width}x{height} exceeds the decode budget").into());
    }
    if components == 0 {
        return Err("image has no components".into());
    }
    Ok(())
}

/// A baseline 8-bit gray or three-component JPEG, at full resolution.
pub fn decode_dct(
    bytes: &[u8],
    width: u32,
    height: u32,
    components: u8,
    max_pixels: u64,
) -> Result<Option<DecodedSamples>> {
    let color_space = match components {
        1 => ColorSpace::Luma,
        3 => ColorSpace::RGB,
        _ => return Ok(None),
    };
    admit(width, height, components, max_pixels)?;
    let options = DecoderOptions::default()
        .set_strict_mode(true)
        .set_max_width(width as usize)
        .set_max_height(height as usize)
        .jpeg_set_out_colorspace(color_space);
    let data = JpegDecoder::new_with_options(Cursor::new(bytes), options)
        .decode()
        .map_err(|error| format!("JPEG image is not decodable: {error}"))?;
    if data.len() != width as usize * height as usize * usize::from(components) {
        return Err("decoded JPEG does not match its image dictionary".into());
    }
    Ok(Some(DecodedSamples {
        width,
        height,
        components,
        bits_per_component: 8,
        data,
    }))
}

/// An 8-bit gray or RGB JPEG 2000 image without alpha.
pub fn decode_jpx(
    bytes: &[u8],
    width: u32,
    height: u32,
    max_pixels: u64,
) -> Result<Option<DecodedSamples>> {
    let image = Image::new(bytes, &DecodeSettings::default())
        .map_err(|error| format!("JPEG 2000 image is not decodable: {error}"))?;
    let components = image.color_space().num_channels();
    if image.has_alpha() || image.original_bit_depth() != 8 || !matches!(components, 1 | 3) {
        return Ok(None);
    }
    if (image.width(), image.height()) != (width, height) {
        return Err("JPEG 2000 image does not match its image dictionary".into());
    }
    admit(width, height, components, max_pixels)?;
    let data = image
        .decode()
        .map_err(|error| format!("JPEG 2000 image is not decodable: {error}"))?;
    Ok(Some(DecodedSamples {
        width,
        height,
        components,
        bits_per_component: 8,
        data,
    }))
}

/// A Group 4 (K < 0) fax image. The decoder marks black runs; PDF samples
/// are black zero unless `/BlackIs1` is true.
pub fn decode_ccitt_g4(
    bytes: &[u8],
    columns: u32,
    rows: u32,
    black_is_1: bool,
    max_pixels: u64,
) -> Result<DecodedSamples> {
    admit(columns, rows, 1, max_pixels)?;
    let stride = (columns as usize).div_ceil(8);
    let mut data = vec![0u8; stride * rows as usize];
    crate::ccitt::decode_g4_rows(
        bytes.iter().map(|&byte| Ok(byte)),
        columns,
        stride,
        &mut data,
    )?;
    if !black_is_1 {
        invert_rows(&mut data, columns, stride);
    }
    Ok(DecodedSamples {
        width: columns,
        height: rows,
        components: 1,
        bits_per_component: 1,
        data,
    })
}

/// A JBIG2 generic-region stream without globals. Its bitmap marks black
/// with one; PDF samples are black zero.
pub fn decode_jbig2_generic(
    bytes: &[u8],
    width: u32,
    height: u32,
    max_pixels: u64,
) -> Result<DecodedSamples> {
    admit(width, height, 1, max_pixels)?;
    let decoded =
        jbig2_codec::decode_pdf_generic_source(bytes, jbig2_codec::DecodeLimits::new(max_pixels))
            .map_err(|error| format!("JBIG2 image is not decodable: {error}"))?;
    if (decoded.width, decoded.height) != (width, height) {
        return Err("JBIG2 image does not match its image dictionary".into());
    }
    let stride = (width as usize).div_ceil(8);
    let mut data = decoded.rows;
    if data.len() != stride * height as usize {
        return Err("JBIG2 bitmap rows do not match its size".into());
    }
    invert_rows(&mut data, width, stride);
    Ok(DecodedSamples {
        width,
        height,
        components: 1,
        bits_per_component: 1,
        data,
    })
}

/// Inverts each row's pixel bits, leaving its padding bits zero.
fn invert_rows(data: &mut [u8], width: u32, stride: usize) {
    let tail_bits = (width % 8) as u8;
    let tail_mask = if tail_bits == 0 {
        0xFF
    } else {
        0xFFu8 << (8 - tail_bits)
    };
    for row in data.chunks_exact_mut(stride) {
        for byte in row.iter_mut() {
            *byte = !*byte;
        }
        if let Some(last) = row.last_mut() {
            *last &= tail_mask;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverts_pixel_bits_and_keeps_row_padding_clear() {
        // Two rows of 10 pixels: 2 bytes each, 6 padding bits per row.
        let mut rows = vec![0b1010_0000, 0b0100_0000, 0xFF, 0b1100_0000];
        invert_rows(&mut rows, 10, 2);
        assert_eq!(rows, vec![0b0101_1111, 0b1000_0000, 0x00, 0b0000_0000]);
    }
}
