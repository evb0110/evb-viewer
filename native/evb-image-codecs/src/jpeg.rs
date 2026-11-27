use std::{borrow::Cow, io::Cursor};

use jpeg_encoder::{ColorType, Encoder as JpegEncoder, SamplingFactor};
use zune_jpeg::{
    zune_core::{colorspace::ColorSpace, options::DecoderOptions},
    JpegDecoder,
};

use crate::{assert_pixel_limit, is_rgb_data_grayscale, read_u16_be, Result, CM_PER_INCH};

const JPEG_APP0_MARKER: u8 = 0xE0;
const JPEG_APP2_MARKER: u8 = 0xE2;
const JPEG_START_OF_SCAN_MARKER: u8 = 0xDA;

#[derive(Debug)]
pub struct JpegMetadata {
    pub width: u32,
    pub height: u32,
    pub components: u8,
    /// Horizontal and vertical density, each from its own JFIF axis.
    pub dpi: Option<(u32, u32)>,
    pub icc_profile: Option<Vec<u8>>,
}

/// Largest ICC profile `assemble_icc_profile` keeps; larger profiles are
/// rejected after their chunks are collected.
const MAX_JPEG_ICC_PROFILE_BYTES: usize = 16 * 1024 * 1024;

/// Frame facts and the total APP2 ICC chunk payload length, read without
/// copying any ICC bytes, so admission can reserve profile assembly before
/// the full metadata parse runs.
#[cfg(not(target_family = "wasm"))]
#[derive(Debug)]
pub struct JpegPreflight {
    pub width: u32,
    pub height: u32,
    pub components: u8,
    pub icc_chunk_bytes: u64,
}

#[cfg(not(target_family = "wasm"))]
impl JpegPreflight {
    /// Heap `parse_jpeg_metadata` allocates for the ICC profile: one copy of
    /// every chunk, plus the assembled profile when it is within the limit.
    pub fn icc_profile_working_bytes(&self) -> u64 {
        let assembled = if self.icc_chunk_bytes <= MAX_JPEG_ICC_PROFILE_BYTES as u64 {
            self.icc_chunk_bytes
        } else {
            0
        };
        self.icc_chunk_bytes.saturating_add(assembled)
    }
}

#[cfg(not(target_family = "wasm"))]
pub fn preflight_jpeg_metadata(bytes: &[u8]) -> Result<JpegPreflight> {
    let mut icc_chunk_bytes = 0u64;
    let frame = walk_jpeg_metadata(bytes, |_, _, chunk| {
        icc_chunk_bytes = icc_chunk_bytes.saturating_add(chunk.len() as u64);
    })?;
    Ok(JpegPreflight {
        width: frame.width,
        height: frame.height,
        components: frame.components,
        icc_chunk_bytes,
    })
}

pub fn parse_jpeg_metadata(bytes: &[u8]) -> Result<JpegMetadata> {
    let mut icc_chunks: Vec<(u8, u8, Vec<u8>)> = Vec::new();
    let frame = walk_jpeg_metadata(bytes, |sequence, total, chunk| {
        icc_chunks.push((sequence, total, chunk.to_vec()));
    })?;
    let icc_profile = assemble_icc_profile(icc_chunks)?;
    Ok(JpegMetadata {
        width: frame.width,
        height: frame.height,
        components: frame.components,
        dpi: frame.dpi,
        icc_profile,
    })
}

struct JpegFrame {
    width: u32,
    height: u32,
    components: u8,
    dpi: Option<(u32, u32)>,
}

/// Validates the JPEG marker structure and hands each well-formed APP2 ICC
/// chunk (`sequence`, `total`, payload) to `on_icc_chunk` without copying it.
fn walk_jpeg_metadata(
    bytes: &[u8],
    mut on_icc_chunk: impl FnMut(u8, u8, &[u8]),
) -> Result<JpegFrame> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err("Invalid JPEG payload".into());
    }

    let mut offset = 2usize;
    let mut dpi = None;
    let mut dimensions = None;
    let mut frame_component_ids = None;
    let mut saw_scan = false;
    let mut pending_marker = None;

    loop {
        let marker = match pending_marker.take() {
            Some(marker) => marker,
            None => read_jpeg_marker(bytes, &mut offset)?,
        };

        if marker == 0xD9 {
            if !saw_scan {
                return Err("JPEG ended before its first scan".into());
            }
            break;
        }
        if marker == 0xD8 {
            return Err("Unexpected JPEG SOI marker".into());
        }
        if marker == 0x01 {
            continue;
        }
        if (0xD0..=0xD7).contains(&marker) {
            return Err("JPEG restart marker appeared outside scan data".into());
        }

        let segment_length = read_u16_be(bytes, offset).ok_or("Truncated JPEG segment")? as usize;
        let segment_end = offset
            .checked_add(segment_length)
            .ok_or("Invalid JPEG segment length")?;
        if segment_length < 2 || segment_end > bytes.len() {
            return Err("Invalid JPEG segment length".into());
        }

        if marker == JPEG_START_OF_SCAN_MARKER {
            validate_start_of_scan(
                bytes,
                offset,
                segment_length,
                dimensions,
                frame_component_ids.as_deref(),
            )?;
            offset = segment_end;
            saw_scan = true;
            pending_marker = Some(read_marker_after_scan(bytes, &mut offset)?);
            continue;
        }

        if marker == JPEG_APP0_MARKER {
            dpi = dpi.or_else(|| read_jfif_dpi(bytes, offset, segment_length));
        }
        if marker == JPEG_APP2_MARKER && segment_length >= 16 {
            let payload = &bytes[offset + 2..segment_end];
            if payload.starts_with(b"ICC_PROFILE\0") {
                let sequence = payload[12];
                let total = payload[13];
                if sequence > 0 && total > 0 && sequence <= total {
                    on_icc_chunk(sequence, total, &payload[14..]);
                }
            }
        }

        if is_jpeg_sof_marker(marker) {
            if dimensions.is_some() {
                return Err("JPEG contains multiple frame headers".into());
            }
            if segment_length < 8 {
                return Err("Invalid JPEG SOF segment".into());
            }
            let precision = *bytes.get(offset + 2).ok_or("Missing JPEG precision")?;
            if precision != 8 {
                return Err(format!(
                    "Unsupported JPEG SOF precision: {precision} (only 8-bit supported)"
                )
                .into());
            }
            let height = read_u16_be(bytes, offset + 3).ok_or("Missing JPEG height")? as u32;
            let width = read_u16_be(bytes, offset + 5).ok_or("Missing JPEG width")? as u32;
            let components = *bytes
                .get(offset + 7)
                .ok_or("Missing JPEG component count")?;
            let expected_length = 8usize
                .checked_add(
                    (components as usize)
                        .checked_mul(3)
                        .ok_or("Invalid JPEG component count")?,
                )
                .ok_or("Invalid JPEG SOF segment")?;
            if components == 0 || segment_length != expected_length {
                return Err("Invalid JPEG SOF component table".into());
            }
            let mut component_ids = Vec::new();
            component_ids
                .try_reserve_exact(components as usize)
                .map_err(|_| "Unable to reserve JPEG component table")?;
            for component_index in 0..components as usize {
                let component_id = bytes[offset + 8 + component_index * 3];
                if component_ids.contains(&component_id) {
                    return Err("JPEG frame contains duplicate component identifiers".into());
                }
                component_ids.push(component_id);
            }
            dimensions = Some((width, height, components));
            frame_component_ids = Some(component_ids);
        }

        offset = segment_end;
    }

    let (width, height, components) = dimensions.ok_or("Missing JPEG dimensions")?;
    if !matches!(components, 1 | 3) {
        return Err(format!("Unsupported JPEG component count: {components}").into());
    }
    Ok(JpegFrame {
        width,
        height,
        components,
        dpi,
    })
}

pub fn validate_jpeg_decodable(bytes: &[u8], width: u32, height: u32) -> Result<()> {
    let options = DecoderOptions::default()
        .set_strict_mode(true)
        .set_max_width(width as usize)
        .set_max_height(height as usize)
        .jpeg_set_out_colorspace(ColorSpace::Luma);
    let mut decoder = JpegDecoder::new_with_options(Cursor::new(bytes), options);
    decoder
        .decode()
        .map(|_| ())
        .map_err(|error| format!("JPEG scan data is not decodable: {error}").into())
}

/// A JPEG decoded and encoded again by [`recompress_jpeg`].
pub struct RecompressedJpeg {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// The encoder stored one gray channel: the source was gray, or color
    /// with every pixel neutral.
    pub grayscale: bool,
}

/// Encodes 8-bit gray (`channels == 1`) or RGB (`channels == 3`) pixels as a
/// JPEG stream and returns `(bytes, pdf_color_space)`. Neutral RGB images are
/// stored as 1-channel `DeviceGray`.
pub fn encode_pixels_as_jpeg(
    pixels: &[u8],
    width: u32,
    height: u32,
    channels: u8,
    quality: u8,
) -> Result<(Vec<u8>, &'static str)> {
    if width == 0 || height == 0 {
        return Err("JPEG dimensions must be non-zero".into());
    }
    if !matches!(channels, 1 | 3) {
        return Err(format!("Unsupported JPEG channel count: {channels}").into());
    }
    let width_u16 =
        u16::try_from(width).map_err(|_| format!("JPEG width is too large to encode: {width}"))?;
    let height_u16 = u16::try_from(height)
        .map_err(|_| format!("JPEG height is too large to encode: {height}"))?;
    let total_pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or("JPEG pixel count overflow")?;
    let expected_len = total_pixels
        .checked_mul(usize::from(channels))
        .ok_or("JPEG pixel payload size overflow")?;
    if pixels.len() != expected_len {
        return Err(format!(
            "JPEG pixel payload length {} does not match {}x{}x{}",
            pixels.len(),
            width,
            height,
            channels
        )
        .into());
    }
    let (encoded_pixels, color_type, color_space): (Cow<'_, [u8]>, ColorType, &'static str) =
        if channels == 1 {
            (Cow::Borrowed(pixels), ColorType::Luma, "DeviceGray")
        } else if is_rgb_data_grayscale(pixels, total_pixels) {
            let mut grayscale = Vec::with_capacity(total_pixels);
            for pixel in pixels.chunks_exact(3).take(total_pixels) {
                grayscale.push(pixel[0]);
            }
            (Cow::Owned(grayscale), ColorType::Luma, "DeviceGray")
        } else {
            (Cow::Borrowed(pixels), ColorType::Rgb, "DeviceRGB")
        };

    let mut data = Vec::new();
    let mut encoder = JpegEncoder::new(&mut data, quality);
    if matches!(color_type, ColorType::Rgb) {
        encoder.set_sampling_factor(SamplingFactor::R_4_2_0);
    }
    encoder.encode(&encoded_pixels, width_u16, height_u16, color_type)?;
    Ok((data, color_space))
}

/// Resizes interleaved 8-bit gray or RGB pixels using area averaging when
/// downscaling. Rejects upscaling or malformed source buffers.
pub fn resize_pixels(
    pixels: &[u8],
    source_width: u32,
    source_height: u32,
    channels: u8,
    next_width: u32,
    next_height: u32,
    max_pixels: u64,
) -> Result<Vec<u8>> {
    if source_width == 0 || source_height == 0 {
        return Err("Source dimensions must be non-zero".into());
    }
    if !matches!(channels, 1 | 3) {
        return Err(format!("Unsupported channel count for resize: {channels}").into());
    }
    let sw = source_width as usize;
    let sh = source_height as usize;
    let ch = usize::from(channels);
    let expected_source_len = sw
        .checked_mul(sh)
        .and_then(|value| value.checked_mul(ch))
        .ok_or("Source pixel payload size overflow")?;
    if pixels.len() != expected_source_len {
        return Err(format!(
            "Source pixel payload length {} does not match {}x{}x{}",
            pixels.len(),
            source_width,
            source_height,
            channels
        )
        .into());
    }
    assert_pixel_limit(next_width, next_height, max_pixels)?;
    if next_width > source_width || next_height > source_height {
        return Err("Resized image dimensions cannot exceed source dimensions".into());
    }
    if source_width == next_width && source_height == next_height {
        return Ok(pixels.to_vec());
    }
    let nw = next_width as usize;
    let nh = next_height as usize;
    let output_len = nw
        .checked_mul(nh)
        .and_then(|value| value.checked_mul(ch))
        .ok_or("Resized pixel payload size overflow")?;
    let mut output = vec![0u8; output_len];
    let x_taps = AxisTaps::new(sw, nw);
    let y_taps = AxisTaps::new(sh, nh);
    let source_row_len = sw * ch;
    let mut row_accum = vec![0.0f64; source_row_len];

    for y in 0..nh {
        row_accum.fill(0.0);
        let (sy_first, y_weights, span_y) = y_taps.get(y);
        for (offset, &wy) in y_weights.iter().enumerate() {
            let row_start = (sy_first + offset) * source_row_len;
            let src_row = &pixels[row_start..row_start + source_row_len];
            for (acc, &px) in row_accum.iter_mut().zip(src_row) {
                *acc += f64::from(px) * wy;
            }
        }
        let out_row = &mut output[y * nw * ch..(y + 1) * nw * ch];
        if ch == 1 {
            for (x, target) in out_row.iter_mut().enumerate() {
                let (sx_first, x_weights, span_x) = x_taps.get(x);
                let mut sum = 0.0f64;
                for (offset, &wx) in x_weights.iter().enumerate() {
                    sum += row_accum[sx_first + offset] * wx;
                }
                *target = (sum / (span_x * span_y)).round().clamp(0.0, 255.0) as u8;
            }
        } else {
            for (x, target) in out_row.chunks_exact_mut(3).enumerate() {
                let (sx_first, x_weights, span_x) = x_taps.get(x);
                let mut sums = [0.0f64; 3];
                for (offset, &wx) in x_weights.iter().enumerate() {
                    let base = (sx_first + offset) * 3;
                    sums[0] += row_accum[base] * wx;
                    sums[1] += row_accum[base + 1] * wx;
                    sums[2] += row_accum[base + 2] * wx;
                }
                let area = span_x * span_y;
                target[0] = (sums[0] / area).round().clamp(0.0, 255.0) as u8;
                target[1] = (sums[1] / area).round().clamp(0.0, 255.0) as u8;
                target[2] = (sums[2] / area).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Ok(output)
}

struct AxisTaps {
    entries: Vec<(usize, usize, usize, f64)>,
    weights: Vec<f64>,
}

impl AxisTaps {
    fn new(source_len: usize, out_len: usize) -> Self {
        let scale = source_len as f64 / out_len as f64;
        let mut entries = Vec::with_capacity(out_len);
        let mut weights = Vec::with_capacity(source_len.saturating_add(out_len));
        for index in 0..out_len {
            let p0 = index as f64 * scale;
            let p1 = (index + 1) as f64 * scale;
            let start_idx = p0.floor() as usize;
            let end_idx = p1.ceil().min(source_len as f64) as usize;
            let weight_start = weights.len();
            let mut first_src = start_idx;
            let mut started = false;
            for src in start_idx..end_idx {
                let overlap = ((src + 1) as f64).min(p1) - (src as f64).max(p0);
                if overlap <= 0.0 {
                    continue;
                }
                if !started {
                    first_src = src;
                    started = true;
                }
                weights.push(overlap);
            }
            entries.push((first_src, weight_start, weights.len(), p1 - p0));
        }
        Self { entries, weights }
    }

    #[inline]
    fn get(&self, index: usize) -> (usize, &[f64], f64) {
        let (first, start, end, span) = self.entries[index];
        (first, &self.weights[start..end], span)
    }
}

/// Decodes an 8-bit gray or RGB JPEG, shrinks it to `width` x `height` by
/// area averaging, and encodes it again at `quality`. The new size may not
/// exceed the source's; the same size keeps every pixel.
pub fn recompress_jpeg(
    bytes: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    max_pixels: u64,
) -> Result<RecompressedJpeg> {
    let metadata = parse_jpeg_metadata(bytes)?;
    if width == 0 || height == 0 || width > metadata.width || height > metadata.height {
        return Err("A recompressed JPEG cannot be larger than its source".into());
    }
    assert_pixel_limit(metadata.width, metadata.height, max_pixels)?;
    let (channels, color_space) = match metadata.components {
        1 => (1u8, ColorSpace::Luma),
        3 => (3u8, ColorSpace::RGB),
        components => {
            return Err(format!("Unsupported JPEG component count: {components}").into());
        }
    };
    let options = DecoderOptions::default()
        .set_strict_mode(true)
        .set_max_width(metadata.width as usize)
        .set_max_height(metadata.height as usize)
        .jpeg_set_out_colorspace(color_space);
    let pixels = JpegDecoder::new_with_options(Cursor::new(bytes), options)
        .decode()
        .map_err(|error| format!("JPEG scan data is not decodable: {error}"))?;
    if pixels.len() != metadata.width as usize * metadata.height as usize * channels as usize {
        return Err("Decoded JPEG does not match its frame size".into());
    }
    let resized = if width == metadata.width && height == metadata.height {
        pixels
    } else {
        resize_pixels(
            &pixels,
            metadata.width,
            metadata.height,
            channels,
            width,
            height,
            max_pixels,
        )?
    };
    let (data, color_space) = encode_pixels_as_jpeg(&resized, width, height, channels, quality)?;
    Ok(RecompressedJpeg {
        data,
        width,
        height,
        grayscale: color_space == "DeviceGray",
    })
}

fn assemble_icc_profile(mut chunks: Vec<(u8, u8, Vec<u8>)>) -> Result<Option<Vec<u8>>> {
    if chunks.is_empty() {
        return Ok(None);
    }
    let expected = chunks[0].1;
    if chunks.len() != expected as usize || chunks.iter().any(|chunk| chunk.1 != expected) {
        return Err("Incomplete JPEG ICC profile".into());
    }
    chunks.sort_by_key(|chunk| chunk.0);
    if chunks
        .iter()
        .enumerate()
        .any(|(index, chunk)| chunk.0 as usize != index + 1)
    {
        return Err("Invalid JPEG ICC profile sequence".into());
    }
    let total_len = chunks
        .iter()
        .try_fold(0usize, |total, chunk| total.checked_add(chunk.2.len()))
        .ok_or("JPEG ICC profile is too large")?;
    if total_len > MAX_JPEG_ICC_PROFILE_BYTES {
        return Err("JPEG ICC profile exceeds the 16 MiB safety limit".into());
    }
    let mut profile = Vec::with_capacity(total_len);
    for (_, _, chunk) in chunks {
        profile.extend_from_slice(&chunk);
    }
    Ok(Some(profile))
}

fn read_jpeg_marker(bytes: &[u8], offset: &mut usize) -> Result<u8> {
    if bytes.get(*offset) != Some(&0xFF) {
        return Err("Invalid JPEG marker prefix".into());
    }
    while bytes.get(*offset) == Some(&0xFF) {
        *offset += 1;
    }
    let marker = *bytes.get(*offset).ok_or("Truncated JPEG marker")?;
    *offset += 1;
    if marker == 0x00 || marker == 0xFF {
        return Err("Invalid JPEG marker".into());
    }
    Ok(marker)
}

fn validate_start_of_scan(
    bytes: &[u8],
    offset: usize,
    segment_length: usize,
    dimensions: Option<(u32, u32, u8)>,
    frame_component_ids: Option<&[u8]>,
) -> Result<()> {
    let (_, _, frame_components) = dimensions.ok_or("JPEG scan appeared before dimensions")?;
    let scan_components = *bytes.get(offset + 2).ok_or("Invalid JPEG SOS segment")?;
    let expected_length = 6usize
        .checked_add(
            (scan_components as usize)
                .checked_mul(2)
                .ok_or("Invalid JPEG SOS component count")?,
        )
        .ok_or("Invalid JPEG SOS segment")?;
    if scan_components == 0
        || scan_components > frame_components
        || segment_length != expected_length
    {
        return Err("Invalid JPEG SOS component table".into());
    }
    let frame_component_ids = frame_component_ids.ok_or("Missing JPEG frame component table")?;
    let mut scan_component_ids = Vec::new();
    scan_component_ids
        .try_reserve_exact(scan_components as usize)
        .map_err(|_| "Unable to reserve JPEG scan component table")?;
    for component_index in 0..scan_components as usize {
        let component_id = bytes[offset + 3 + component_index * 2];
        if !frame_component_ids.contains(&component_id) {
            return Err("JPEG scan references an unknown frame component".into());
        }
        if scan_component_ids.contains(&component_id) {
            return Err("JPEG scan contains duplicate component identifiers".into());
        }
        scan_component_ids.push(component_id);
    }
    Ok(())
}

fn read_marker_after_scan(bytes: &[u8], offset: &mut usize) -> Result<u8> {
    loop {
        while bytes.get(*offset).is_some_and(|byte| *byte != 0xFF) {
            *offset += 1;
        }
        if *offset >= bytes.len() {
            return Err("JPEG scan is missing an EOI marker".into());
        }
        while bytes.get(*offset) == Some(&0xFF) {
            *offset += 1;
        }
        let marker = *bytes.get(*offset).ok_or("Truncated JPEG scan marker")?;
        *offset += 1;
        match marker {
            0x00 | 0xD0..=0xD7 => continue,
            0xFF => continue,
            _ => return Ok(marker),
        }
    }
}

fn is_jpeg_sof_marker(marker: u8) -> bool {
    matches!(
        marker,
        0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5 | 0xC6 | 0xC7 | 0xC9 | 0xCA | 0xCB | 0xCD | 0xCE | 0xCF
    )
}

fn read_jfif_dpi(bytes: &[u8], offset: usize, segment_length: usize) -> Option<(u32, u32)> {
    if segment_length < 16 {
        return None;
    }
    if bytes.get(offset + 2..offset + 7)? != b"JFIF\0" {
        return None;
    }

    let units = *bytes.get(offset + 9)?;
    let x_density = read_u16_be(bytes, offset + 10)? as u32;
    let y_density = read_u16_be(bytes, offset + 12)? as u32;
    // A zero axis takes the other's density; with neither there is none.
    let (x_density, y_density) = match (x_density, y_density) {
        (0, 0) => return None,
        (0, y) => (y, y),
        (x, 0) => (x, x),
        axes => axes,
    };
    let per_inch = |density: u32| match units {
        1 => Some(density),
        2 => Some((density as f64 * CM_PER_INCH).round() as u32),
        _ => None,
    };
    Some((per_inch(x_density)?, per_inch(y_density)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_eight_bit_jpeg_sof_precision() {
        let metadata = parse_jpeg_metadata(&jpeg_with_sof_precision(8)).unwrap();

        assert_eq!(metadata.width, 2);
        assert_eq!(metadata.height, 1);
        assert_eq!(metadata.components, 1);
    }

    #[test]
    fn keeps_each_jfif_density_axis() {
        let mut bytes = jpeg_with_sof_precision(8);
        // APP0 JFIF 1.1 in dots per inch: 300 across, 150 down.
        let app0 = [
            0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01, 0x01, 0x01, 0x01, 0x2C,
            0x00, 0x96, 0x00, 0x00,
        ];
        bytes.splice(2..2, app0);
        assert_eq!(parse_jpeg_metadata(&bytes).unwrap().dpi, Some((300, 150)));
        // Dots per centimeter convert each axis on its own.
        bytes[13] = 0x02;
        assert_eq!(parse_jpeg_metadata(&bytes).unwrap().dpi, Some((762, 381)));
        // A zero axis takes the other's density.
        bytes[13] = 0x01;
        bytes[16] = 0x00;
        bytes[17] = 0x00;
        assert_eq!(parse_jpeg_metadata(&bytes).unwrap().dpi, Some((300, 300)));
    }

    #[test]
    fn rejects_non_eight_bit_jpeg_sof_precision() {
        let result = parse_jpeg_metadata(&jpeg_with_sof_precision(12));

        assert!(result.is_err());
    }

    #[test]
    fn rejects_jpeg_truncated_after_sof() {
        let mut jpeg = jpeg_with_sof_precision(8);
        jpeg.truncate(jpeg.len() - 2);

        let error = parse_jpeg_metadata(&jpeg).unwrap_err();

        assert!(error.to_string().contains("EOI") || error.to_string().contains("Truncated"));
    }

    #[test]
    fn rejects_jpeg_with_truncated_scan_marker() {
        let mut jpeg = jpeg_with_sof_precision(8);
        jpeg.truncate(jpeg.len() - 2);
        jpeg.push(0xff);

        let error = parse_jpeg_metadata(&jpeg).unwrap_err();

        assert!(error.to_string().contains("Truncated JPEG scan marker"));
    }

    #[test]
    fn accepts_structurally_complete_progressive_jpeg_scans() {
        let jpeg = jpeg_with_scans(0xc2, 8, true);

        let metadata = parse_jpeg_metadata(&jpeg).unwrap();

        assert_eq!((metadata.width, metadata.height), (2, 1));
    }

    #[test]
    fn rejects_scan_that_references_unknown_frame_component() {
        let mut jpeg = jpeg_with_sof_precision(8);
        let scan_component_id = jpeg
            .windows(2)
            .position(|window| window == [0xff, 0xda])
            .unwrap()
            + 5;
        jpeg[scan_component_id] = 2;

        let error = parse_jpeg_metadata(&jpeg).unwrap_err();

        assert!(error.to_string().contains("unknown frame component"));
    }

    fn jpeg_with_sof_precision(precision: u8) -> Vec<u8> {
        jpeg_with_scans(0xc0, precision, false)
    }

    fn jpeg_with_scans(sof_marker: u8, precision: u8, progressive: bool) -> Vec<u8> {
        let mut jpeg = vec![
            0xff, 0xd8, 0xff, sof_marker, 0x00, 0x0b, precision, 0x00, 0x01, 0x00, 0x02, 0x01,
            0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00,
        ];
        jpeg.extend_from_slice(if progressive {
            &[
                0x00, 0x00, 0x11, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x3f, 0x00, 0x22,
                0xff, 0xd9,
            ]
        } else {
            &[0x3f, 0x00, 0x11, 0xff, 0xd9]
        });
        jpeg
    }

    #[test]
    fn separable_resize_matches_2d_area_average() {
        fn ref_2d(pixels: &[u8], sw: usize, sh: usize, ch: usize, nw: usize, nh: usize) -> Vec<u8> {
            let mut out = vec![0u8; nw * nh * ch];
            let sx_scale = sw as f64 / nw as f64;
            let sy_scale = sh as f64 / nh as f64;
            for y in 0..nh {
                let y0 = y as f64 * sy_scale;
                let y1 = (y + 1) as f64 * sy_scale;
                for x in 0..nw {
                    let x0 = x as f64 * sx_scale;
                    let x1 = (x + 1) as f64 * sx_scale;
                    let area = (x1 - x0) * (y1 - y0);
                    for c in 0..ch {
                        let mut sum = 0.0;
                        for sy in (y0.floor() as usize)..(y1.ceil().min(sh as f64) as usize) {
                            let oy = ((sy + 1) as f64).min(y1) - (sy as f64).max(y0);
                            if oy <= 0.0 {
                                continue;
                            }
                            for sx in (x0.floor() as usize)..(x1.ceil().min(sw as f64) as usize) {
                                let ox = ((sx + 1) as f64).min(x1) - (sx as f64).max(x0);
                                if ox <= 0.0 {
                                    continue;
                                }
                                sum += f64::from(pixels[(sy * sw + sx) * ch + c]) * ox * oy;
                            }
                        }
                        out[(y * nw + x) * ch + c] = (sum / area).round().clamp(0.0, 255.0) as u8;
                    }
                }
            }
            out
        }

        // Exact legacy f64 boundary case: 4x1 -> 3x1 with [0, 2, 0, 0] produces
        // 0.4999999999999999 for the first pixel, which rounds to 0.
        let boundary = [0u8, 2, 0, 0];
        assert_eq!(
            resize_pixels(&boundary, 4, 1, 1, 3, 1, 1_000_000).unwrap(),
            ref_2d(&boundary, 4, 1, 1, 3, 1)
        );
        assert_eq!(
            resize_pixels(&boundary, 4, 1, 1, 3, 1, 1_000_000).unwrap(),
            vec![0, 1, 0]
        );

        let mut state = 0x4a50_4547_5253_5a31_u64;
        for (sw, sh, nw, nh, ch) in [
            (17, 13, 7, 5, 1),
            (17, 13, 7, 5, 3),
            (20, 12, 10, 12, 3),
            (12, 20, 12, 7, 1),
            (31, 29, 13, 11, 3),
        ] {
            let pixels: Vec<u8> = (0..sw * sh * ch)
                .map(|_| {
                    state = state
                        .wrapping_mul(6_364_136_223_846_793_005)
                        .wrapping_add(1_442_695_040_888_963_407);
                    (state >> 56) as u8
                })
                .collect();
            let actual = resize_pixels(
                &pixels, sw as u32, sh as u32, ch as u8, nw as u32, nh as u32, 1_000_000,
            )
            .unwrap();
            let expected = ref_2d(&pixels, sw, sh, ch, nw, nh);
            assert_eq!(
                actual, expected,
                "mismatch for {sw}x{sh}->{nw}x{nh} ch={ch}"
            );
        }
    }
}
