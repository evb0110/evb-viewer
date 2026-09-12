use std::io::{self, Cursor, Read, Write};

use crc32fast::Hasher;
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use scan_primitives::{BinaryImage, GrayImage, RgbImage};
use thiserror::Error;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const METERS_PER_INCH: f64 = 0.0254;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PassthroughLimits {
    pub max_pixels: u64,
    pub max_dimension: u32,
    pub max_icc_profile_bytes: usize,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodeLimits {
    pub max_pixels: u64,
    pub max_dimension: u32,
    pub max_compressed_bytes: usize,
}
#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PngColorType {
    Gray8 = 0,
    Rgb8 = 2,
    Indexed = 3,
    GrayAlpha8 = 4,
    Rgba8 = 6,
}
impl PngColorType {
    fn channels(self) -> usize {
        match self {
            Self::Gray8 => 1,
            Self::Rgb8 => 3,
            Self::Indexed => 1,
            Self::GrayAlpha8 => 2,
            Self::Rgba8 => 4,
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompressedPng {
    pub width: u32,
    pub height: u32,
    pub color_type: PngColorType,
    pub density: Option<PngDensity>,
    /// Concatenated original IDAT bytes; never decoded or re-encoded.
    pub idat: Vec<u8>,
    pub icc_profile: Option<Vec<u8>>,
    pub transparency: Option<PngTransparencyKey>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PngDensity {
    pub x_dpi: u32,
    pub y_dpi: u32,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PngMetadata {
    pub width: u32,
    pub height: u32,
    pub color_type: PngColorType,
    pub density: Option<PngDensity>,
    pub icc_profile: Option<Vec<u8>>,
    pub transparency: Option<PngTransparencyKey>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PngTransparencyKey {
    Gray(u8),
    Rgb([u8; 3]),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedRaster {
    pub gray: GrayImage,
    pub rgb: RgbImage,
}
#[derive(Clone, Copy, Debug)]
pub enum PixelBuffer<'a> {
    Gray {
        width: usize,
        height: usize,
        stride: usize,
        data: &'a [u8],
    },
    Rgb {
        width: usize,
        height: usize,
        stride: usize,
        data: &'a [u8],
    },
}
#[derive(Debug, Error)]
pub enum RasterError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    TooLarge(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}
impl RasterError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    fn too_large(message: impl Into<String>) -> Self {
        Self::TooLarge(message.into())
    }
}
pub fn read_png_passthrough<R: Read>(
    reader: R,
    limits: PassthroughLimits,
) -> Result<CompressedPng, RasterError> {
    let parsed = walk_chunks(reader, WalkMode::Passthrough(limits))?;
    if parsed.header.bit_depth != 8
        || parsed.header.interlace_method != 0
        || matches!(parsed.header.color_type, PngColorType::Indexed)
    {
        return Err(RasterError::invalid(
            "PNG representation requires pixel normalization",
        ));
    }
    let row_bytes = (parsed.header.width as usize)
        .checked_mul(parsed.header.color_type.channels())
        .ok_or_else(|| RasterError::invalid("PNG row overflow"))?;
    validate_inflated_rows(
        &parsed.idat,
        parsed.header.expected_data_len()?,
        row_bytes,
        parsed.header.height as usize,
    )?;
    Ok(CompressedPng {
        width: parsed.header.width,
        height: parsed.header.height,
        color_type: parsed.header.color_type,
        density: parsed.density,
        idat: parsed.idat,
        icc_profile: parsed.icc_profile,
        transparency: parsed.transparency,
    })
}
pub fn read_png_metadata<R: Read>(
    reader: R,
    limits: PassthroughLimits,
) -> Result<PngMetadata, RasterError> {
    let parsed = walk_chunks(reader, WalkMode::Metadata(limits))?;
    Ok(PngMetadata {
        width: parsed.header.width,
        height: parsed.header.height,
        color_type: parsed.header.color_type,
        density: parsed.density,
        icc_profile: parsed.icc_profile,
        transparency: parsed.transparency,
    })
}
pub fn read_png_dimensions<R: Read>(
    reader: R,
    limits: DecodeLimits,
) -> Result<(usize, usize), RasterError> {
    let header = walk_chunks(reader, WalkMode::Dimensions(limits))?.header;
    Ok((header.width as usize, header.height as usize))
}
pub fn decode_png<R: Read>(reader: R, limits: DecodeLimits) -> Result<DecodedRaster, RasterError> {
    let pixels = PngPixels::read(reader, limits)?;
    let (width, height, color_type) = (pixels.width, pixels.height, pixels.color_type);
    let transparency = pixels.transparency;
    let mut gray = GrayImage::new(width, height, 255);
    let mut rgb = RgbImage::new(width, height, [255; 3]);
    pixels.for_each_row(|y, row| {
        let rgb_row = &mut rgb.data_mut()[y * width * 3..(y + 1) * width * 3];
        write_png_row(
            gray.row_mut(y),
            Some(rgb_row),
            row,
            color_type,
            transparency,
        );
    })?;
    Ok(DecodedRaster { gray, rgb })
}
/// Decodes the same gray plane as `decode_png(..).gray` without allocating the
/// colour plane the bilevel and grayscale lanes discard.
pub fn decode_png_gray<R: Read>(reader: R, limits: DecodeLimits) -> Result<GrayImage, RasterError> {
    let parsed = walk_chunks(reader, WalkMode::Decode(limits))?;
    let header = parsed.header;
    if header.bit_depth == 8
        && header.interlace_method == 0
        && !matches!(header.color_type, PngColorType::Indexed)
    {
        return decode_png_gray_ordinary(parsed);
    }
    validate_decoded_rows(&parsed.idat, header)?;
    let mut decoder = png::Decoder::new(Cursor::new(parsed.reconstruct_for_decode()?));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    decoder.set_limits(png::Limits {
        bytes: limits
            .max_compressed_bytes
            .saturating_add((limits.max_pixels as usize).saturating_mul(8)),
    });
    let mut reader = decoder
        .read_info()
        .map_err(|error| RasterError::invalid(format!("PNG decode failed: {error}")))?;
    let (output_color, _) = reader.output_color_type();
    let color_type = match output_color {
        png::ColorType::Grayscale => PngColorType::Gray8,
        png::ColorType::Rgb => PngColorType::Rgb8,
        png::ColorType::GrayscaleAlpha => PngColorType::GrayAlpha8,
        png::ColorType::Rgba => PngColorType::Rgba8,
        png::ColorType::Indexed => {
            return Err(RasterError::invalid("PNG decoder returned indexed pixels"));
        }
    };
    let mut gray = GrayImage::new(header.width as usize, header.height as usize, 255);
    if header.interlace_method == 0 {
        let mut y = 0;
        while let Some(row) = reader
            .next_row()
            .map_err(|error| RasterError::invalid(format!("PNG decode failed: {error}")))?
        {
            let gray_row = normalize_png_row_to_gray(row.data(), color_type);
            gray.row_mut(y).copy_from_slice(&gray_row);
            y += 1;
        }
    } else {
        while let Some(interlaced_row) = reader
            .next_interlaced_row()
            .map_err(|error| RasterError::invalid(format!("PNG decode failed: {error}")))?
        {
            let gray_row = normalize_png_row_to_gray(interlaced_row.data(), color_type);
            if let png::InterlaceInfo::Adam7(info) = interlaced_row.interlace() {
                png::expand_interlaced_row(
                    gray.data_mut(),
                    header.width as usize,
                    &gray_row,
                    info,
                    8,
                );
            }
        }
    }
    Ok(gray)
}

fn decode_png_gray_ordinary(parsed: WalkedPng) -> Result<GrayImage, RasterError> {
    let header = parsed.header;
    let transparency = parsed.transparency;
    validate_decoded_rows(&parsed.idat, header)?;
    let row_bytes = (header.width as usize)
        .checked_mul(header.color_type.channels())
        .ok_or_else(|| RasterError::invalid("PNG row overflow"))?;
    let expected = row_bytes
        .checked_add(1)
        .and_then(|value| value.checked_mul(header.height as usize))
        .ok_or_else(|| RasterError::invalid("Invalid PNG image data length"))?;
    let mut filtered = Vec::with_capacity(expected);
    ZlibDecoder::new(parsed.idat.as_slice())
        .take(expected.saturating_add(1) as u64)
        .read_to_end(&mut filtered)?;
    if filtered.len() != expected {
        return Err(RasterError::invalid(format!(
            "PNG decompressed payload length mismatch: expected {expected} bytes, got {}",
            filtered.len()
        )));
    }
    let mut gray = GrayImage::new(header.width as usize, header.height as usize, 255);
    let channels = header.color_type.channels();
    let mut current = vec![0; row_bytes];
    let mut previous = vec![0; row_bytes];
    let mut position = 0usize;
    for y in 0..header.height as usize {
        let filter = filtered[position];
        position += 1;
        current.copy_from_slice(&filtered[position..position + row_bytes]);
        position += row_bytes;
        unfilter(&mut current, &previous, channels, filter)?;
        write_png_row(
            gray.row_mut(y),
            None,
            &current,
            header.color_type,
            transparency,
        );
        std::mem::swap(&mut current, &mut previous);
    }
    Ok(gray)
}

fn normalize_png_row_to_gray(source: &[u8], color_type: PngColorType) -> Vec<u8> {
    let channels = color_type.channels();
    match color_type {
        PngColorType::Gray8 | PngColorType::GrayAlpha8 => source
            .chunks_exact(channels)
            .map(|pixel| pixel[0])
            .collect(),
        PngColorType::Rgb8 | PngColorType::Rgba8 => {
            source.chunks_exact(channels).map(luma).collect()
        }
        PngColorType::Indexed => {
            unreachable!("indexed PNG pixels are normalized before row conversion")
        }
    }
}

/// Decodes a PNG to opaque RGB pixels. Alpha-bearing input is composited onto
/// white so callers that write PDF/JPEG output never silently discard it.
pub fn decode_png_composited_rgb<R: Read>(
    reader: R,
    limits: DecodeLimits,
) -> Result<RgbImage, RasterError> {
    let pixels = PngPixels::read(reader, limits)?;
    let (width, height, color_type) = (pixels.width, pixels.height, pixels.color_type);
    let transparency = pixels.transparency;
    let mut rgb = RgbImage::new(width, height, [255; 3]);
    pixels.for_each_row(|y, row| {
        let rgb_row = &mut rgb.data_mut()[y * width * 3..(y + 1) * width * 3];
        write_composited_rgb_row(rgb_row, row, color_type, transparency);
    })?;
    Ok(rgb)
}

/// Inflated, still-filtered PNG samples: everything both decoders share before
/// they differ in which planes they materialize.
struct PngPixels {
    width: usize,
    height: usize,
    color_type: PngColorType,
    row_bytes: usize,
    filtered: Vec<u8>,
    needs_unfilter: bool,
    transparency: Option<PngTransparencyKey>,
}
impl PngPixels {
    fn read<R: Read>(reader: R, limits: DecodeLimits) -> Result<Self, RasterError> {
        let parsed = walk_chunks(reader, WalkMode::Decode(limits))?;
        let header = parsed.header;
        if header.bit_depth == 8
            && header.interlace_method == 0
            && !matches!(header.color_type, PngColorType::Indexed)
        {
            validate_decoded_rows(&parsed.idat, header)?;
            let row_bytes = (header.width as usize)
                .checked_mul(header.color_type.channels())
                .ok_or_else(|| RasterError::invalid("PNG row overflow"))?;
            let expected = row_bytes
                .checked_add(1)
                .and_then(|value| value.checked_mul(header.height as usize))
                .ok_or_else(|| RasterError::invalid("Invalid PNG image data length"))?;
            let mut filtered = Vec::with_capacity(expected);
            ZlibDecoder::new(parsed.idat.as_slice())
                .take(expected as u64)
                .read_to_end(&mut filtered)?;
            return Ok(Self {
                width: header.width as usize,
                height: header.height as usize,
                color_type: header.color_type,
                row_bytes,
                filtered,
                needs_unfilter: true,
                transparency: parsed.transparency,
            });
        }
        validate_decoded_rows(&parsed.idat, header)?;
        let mut decoder = png::Decoder::new(Cursor::new(parsed.reconstruct_for_decode()?));
        decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        decoder.set_limits(png::Limits {
            bytes: limits
                .max_compressed_bytes
                .saturating_add((limits.max_pixels as usize).saturating_mul(16)),
        });
        let mut reader = decoder
            .read_info()
            .map_err(|error| RasterError::invalid(format!("PNG decode failed: {error}")))?;
        let output_size = reader
            .output_buffer_size()
            .ok_or_else(|| RasterError::invalid("PNG decoded image size overflow"))?;
        let mut filtered = vec![0; output_size];
        let output = reader
            .next_frame(&mut filtered)
            .map_err(|error| RasterError::invalid(format!("PNG decode failed: {error}")))?;
        filtered.truncate(output.buffer_size());
        let color_type = match output.color_type {
            png::ColorType::Grayscale => PngColorType::Gray8,
            png::ColorType::Rgb => PngColorType::Rgb8,
            png::ColorType::GrayscaleAlpha => PngColorType::GrayAlpha8,
            png::ColorType::Rgba => PngColorType::Rgba8,
            png::ColorType::Indexed => {
                return Err(RasterError::invalid("PNG decoder returned indexed pixels"));
            }
        };
        let row_bytes = output.line_size;
        Ok(Self {
            width: header.width as usize,
            height: header.height as usize,
            color_type,
            row_bytes,
            filtered,
            needs_unfilter: false,
            transparency: None,
        })
    }

    fn for_each_row(self, mut row: impl FnMut(usize, &[u8])) -> Result<(), RasterError> {
        let row_bytes = self.row_bytes;
        if !self.needs_unfilter {
            for y in 0..self.height {
                row(y, &self.filtered[y * row_bytes..(y + 1) * row_bytes]);
            }
            return Ok(());
        }
        let channels = self.color_type.channels();
        let mut current = vec![0; row_bytes];
        let mut previous = vec![0; row_bytes];
        let mut position = 0usize;
        for y in 0..self.height {
            let filter = self.filtered[position];
            position += 1;
            current.copy_from_slice(&self.filtered[position..position + row_bytes]);
            position += row_bytes;
            unfilter(&mut current, &previous, channels, filter)?;
            row(y, &current);
            std::mem::swap(&mut current, &mut previous);
        }
        Ok(())
    }
}
fn write_png_row(
    gray_row: &mut [u8],
    rgb_row: Option<&mut [u8]>,
    source: &[u8],
    color_type: PngColorType,
    transparency: Option<PngTransparencyKey>,
) {
    let channels = color_type.channels();
    match color_type {
        PngColorType::Gray8 | PngColorType::GrayAlpha8 => {
            for (target, pixel) in gray_row.iter_mut().zip(source.chunks_exact(channels)) {
                *target = if transparency == Some(PngTransparencyKey::Gray(pixel[0])) {
                    255
                } else {
                    pixel[0]
                };
            }
            if let Some(rgb_row) = rgb_row {
                for (target, pixel) in rgb_row
                    .chunks_exact_mut(3)
                    .zip(source.chunks_exact(channels))
                {
                    target.fill(
                        if transparency == Some(PngTransparencyKey::Gray(pixel[0])) {
                            255
                        } else {
                            pixel[0]
                        },
                    );
                }
            }
        }
        PngColorType::Indexed => {
            unreachable!("indexed PNG pixels are normalized before row conversion")
        }
        PngColorType::Rgb8 | PngColorType::Rgba8 => {
            for (target, pixel) in gray_row.iter_mut().zip(source.chunks_exact(channels)) {
                *target = luma(pixel);
            }
            if let Some(rgb_row) = rgb_row {
                for (target, pixel) in rgb_row
                    .chunks_exact_mut(3)
                    .zip(source.chunks_exact(channels))
                {
                    if transparency == Some(PngTransparencyKey::Rgb([pixel[0], pixel[1], pixel[2]]))
                    {
                        target.fill(255);
                    } else {
                        target.copy_from_slice(&pixel[..3]);
                    }
                }
            }
        }
    }
}

fn composite_channel(value: u8, alpha: u8) -> u8 {
    ((u32::from(value) * u32::from(alpha) + 255 * u32::from(255 - alpha) + 127) / 255) as u8
}

fn write_composited_rgb_row(
    target: &mut [u8],
    source: &[u8],
    color_type: PngColorType,
    transparency: Option<PngTransparencyKey>,
) {
    match color_type {
        PngColorType::Gray8 => {
            for (pixel, value) in target.chunks_exact_mut(3).zip(source.iter().copied()) {
                pixel.fill(if transparency == Some(PngTransparencyKey::Gray(value)) {
                    255
                } else {
                    value
                });
            }
        }
        PngColorType::GrayAlpha8 => {
            for (pixel, source_pixel) in target.chunks_exact_mut(3).zip(source.chunks_exact(2)) {
                pixel.fill(composite_channel(source_pixel[0], source_pixel[1]));
            }
        }
        PngColorType::Rgb8 => {
            for (pixel, source_pixel) in target.chunks_exact_mut(3).zip(source.chunks_exact(3)) {
                if transparency
                    == Some(PngTransparencyKey::Rgb([
                        source_pixel[0],
                        source_pixel[1],
                        source_pixel[2],
                    ]))
                {
                    pixel.fill(255);
                } else {
                    pixel.copy_from_slice(source_pixel);
                }
            }
        }
        PngColorType::Rgba8 => {
            for (pixel, source_pixel) in target.chunks_exact_mut(3).zip(source.chunks_exact(4)) {
                pixel[0] = composite_channel(source_pixel[0], source_pixel[3]);
                pixel[1] = composite_channel(source_pixel[1], source_pixel[3]);
                pixel[2] = composite_channel(source_pixel[2], source_pixel[3]);
            }
        }
        PngColorType::Indexed => {
            unreachable!("indexed PNG pixels are normalized before row conversion")
        }
    }
}

fn luma(pixel: &[u8]) -> u8 {
    ((u32::from(pixel[0]) * 77 + u32::from(pixel[1]) * 150 + u32::from(pixel[2]) * 29 + 128) >> 8)
        as u8
}
pub fn write_png<W: Write>(writer: W, pixels: PixelBuffer<'_>) -> Result<W, RasterError> {
    write_png_impl(writer, pixels, Compression::default(), false, None)
}

pub fn write_png_with_dpi<W: Write>(
    writer: W,
    pixels: PixelBuffer<'_>,
    dpi: u32,
) -> Result<W, RasterError> {
    if dpi == 0 {
        return Err(RasterError::invalid("PNG DPI must be non-zero"));
    }
    write_png_impl(writer, pixels, Compression::default(), false, Some(dpi))
}

/// Encodes a lossless PNG for a managed intermediate raster.
///
/// Scan-cleanup layers are decoded again by the document assembler and do not
/// benefit from spending most of a page's latency on the default DEFLATE
/// search. The Up filter keeps scan rows compact while fast DEFLATE preserves
/// every sample exactly.
pub fn write_png_fast<W: Write>(writer: W, pixels: PixelBuffer<'_>) -> Result<W, RasterError> {
    write_png_impl(writer, pixels, Compression::fast(), true, None)
}

fn write_png_impl<W: Write>(
    mut writer: W,
    pixels: PixelBuffer<'_>,
    compression: Compression,
    filter_up: bool,
    dpi: Option<u32>,
) -> Result<W, RasterError> {
    let (width, height, stride, data, color_type) = match pixels {
        PixelBuffer::Gray {
            width,
            height,
            stride,
            data,
        } => (width, height, stride, data, PngColorType::Gray8),
        PixelBuffer::Rgb {
            width,
            height,
            stride,
            data,
        } => (width, height, stride, data, PngColorType::Rgb8),
    };
    let width_u32 = u32::try_from(width).map_err(|_| RasterError::invalid("Invalid PNG width"))?;
    let height_u32 =
        u32::try_from(height).map_err(|_| RasterError::invalid("Invalid PNG height"))?;
    if width == 0 || height == 0 {
        return Err(RasterError::invalid("PNG dimensions must be non-zero"));
    }
    let row_bytes = width
        .checked_mul(color_type.channels())
        .ok_or_else(|| RasterError::invalid("PNG row overflow"))?;
    if stride < row_bytes {
        return Err(RasterError::invalid("PNG stride is shorter than its row"));
    }
    let required = (height - 1)
        .checked_mul(stride)
        .and_then(|value| value.checked_add(row_bytes))
        .ok_or_else(|| RasterError::invalid("PNG pixel buffer length overflow"))?;
    if data.len() < required {
        return Err(RasterError::invalid("PNG pixel buffer is too short"));
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), compression);
    let mut filtered_row = Vec::with_capacity(row_bytes);
    for y in 0..height {
        let start = y * stride;
        let current = &data[start..start + row_bytes];
        if filter_up {
            encoder.write_all(&[2])?;
            if y == 0 {
                encoder.write_all(current)?;
            } else {
                let previous_start = (y - 1) * stride;
                let previous = &data[previous_start..previous_start + row_bytes];
                filtered_row.clear();
                filtered_row.extend(
                    current
                        .iter()
                        .zip(previous)
                        .map(|(current, previous)| current.wrapping_sub(*previous)),
                );
                encoder.write_all(&filtered_row)?;
            }
        } else {
            encoder.write_all(&[0])?;
            encoder.write_all(current)?;
        }
    }
    let compressed = encoder.finish()?;
    writer.write_all(PNG_SIGNATURE)?;
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width_u32.to_be_bytes());
    ihdr.extend_from_slice(&height_u32.to_be_bytes());
    ihdr.extend_from_slice(&[8, color_type as u8, 0, 0, 0]);
    write_chunk(&mut writer, b"IHDR", &ihdr)?;
    if let Some(dpi) = dpi {
        let pixels_per_meter = ((f64::from(dpi) / METERS_PER_INCH).round() as u32).max(1);
        let mut phys = [0u8; 9];
        phys[..4].copy_from_slice(&pixels_per_meter.to_be_bytes());
        phys[4..8].copy_from_slice(&pixels_per_meter.to_be_bytes());
        phys[8] = 1;
        write_chunk(&mut writer, b"pHYs", &phys)?;
    }
    write_chunk(&mut writer, b"IDAT", &compressed)?;
    write_chunk(&mut writer, b"IEND", &[])?;
    Ok(writer)
}
pub fn encode_png(pixels: PixelBuffer<'_>) -> Result<Vec<u8>, RasterError> {
    write_png(Vec::new(), pixels)
}
pub fn encode_png_fast(pixels: PixelBuffer<'_>) -> Result<Vec<u8>, RasterError> {
    write_png_fast(Vec::new(), pixels)
}
pub fn decode_p4(
    bytes: &[u8],
    max_pixels: u64,
    max_dimension: u32,
) -> Result<GrayImage, RasterError> {
    if bytes.get(..3) != Some(b"P4\n") {
        return Err(RasterError::invalid("Invalid PBM P4 signature"));
    }
    let dimensions_end = bytes[3..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|offset| offset + 3)
        .ok_or_else(|| RasterError::invalid("Truncated PBM P4 header"))?;
    let dimensions = std::str::from_utf8(&bytes[3..dimensions_end])
        .map_err(|_| RasterError::invalid("Invalid PBM P4 dimensions"))?
        .split_ascii_whitespace()
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| RasterError::invalid("Invalid PBM P4 dimensions"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if dimensions.len() != 2 {
        return Err(RasterError::invalid("Invalid PBM P4 dimensions"));
    }
    let (width, height) = (dimensions[0], dimensions[1]);
    if width == 0 || height == 0 {
        return Err(RasterError::invalid("Invalid PBM P4 dimensions"));
    }
    if width > max_dimension as usize
        || height > max_dimension as usize
        || (width as u64).saturating_mul(height as u64) > max_pixels
    {
        return Err(RasterError::too_large(format!(
            "PBM P4 dimensions exceed guardrails: {width}x{height}"
        )));
    }
    let row_stride = width.div_ceil(8);
    let bitmap = bytes
        .get(dimensions_end + 1..)
        .ok_or_else(|| RasterError::invalid("Truncated PBM P4 payload"))?;
    if bitmap.len() != row_stride.saturating_mul(height) {
        return Err(RasterError::invalid("PBM P4 payload length mismatch"));
    }
    let mut image = GrayImage::new(width, height, 255);
    for y in 0..height {
        for x in 0..width {
            if bitmap[y * row_stride + x / 8] & (1 << (7 - x % 8)) != 0 {
                image.set(x, y, 0);
            }
        }
    }
    Ok(image)
}
/// Writes packed bits straight out: `BinaryImage` and PBM P4 are both MSB-first
/// with one as black, so a row is a byte-order shuffle of its words rather than a
/// per-pixel decision.
pub fn encode_p4_bilevel(image: &BinaryImage) -> Result<Vec<u8>, RasterError> {
    let (mut bytes, row_stride) = start_p4(image.width(), image.height())?;
    let words_per_line = image.words_per_line();
    let tail_bits = image.width() % 8;
    for row in image.words().chunks_exact(words_per_line) {
        let row_start = bytes.len();
        for word in row {
            bytes.extend_from_slice(&word.to_be_bytes());
        }
        bytes.truncate(row_start + row_stride);
        if tail_bits != 0 {
            let last = bytes.len() - 1;
            bytes[last] &= u8::MAX << (8 - tail_bits);
        }
    }
    Ok(bytes)
}
pub fn encode_p4(image: &GrayImage) -> Result<Vec<u8>, RasterError> {
    let (mut bytes, row_stride) = start_p4(image.width(), image.height())?;
    for y in 0..image.height() {
        let row_start = bytes.len();
        bytes.resize(row_start + row_stride, 0);
        for (x, pixel) in image.row(y).iter().copied().enumerate() {
            match pixel {
                0 => bytes[row_start + x / 8] |= 1 << (7 - x % 8),
                255 => {}
                value => {
                    return Err(RasterError::invalid(format!(
                        "PBM P4 source contains non-binary sample {value} at ({x}, {y})"
                    )));
                }
            }
        }
    }
    Ok(bytes)
}
fn start_p4(width: usize, height: usize) -> Result<(Vec<u8>, usize), RasterError> {
    if width == 0 || height == 0 {
        return Err(RasterError::invalid("PBM P4 dimensions must be positive"));
    }
    let row_stride = width
        .checked_add(7)
        .ok_or_else(|| RasterError::invalid("PBM P4 row stride overflow"))?
        / 8;
    let bitmap_len = row_stride
        .checked_mul(height)
        .ok_or_else(|| RasterError::invalid("PBM P4 payload size overflow"))?;
    let header = format!("P4\n{width} {height}\n");
    let mut bytes = Vec::with_capacity(header.len().saturating_add(bitmap_len));
    bytes.extend_from_slice(header.as_bytes());
    Ok((bytes, row_stride))
}
const PPM_SIGNATURE: &[u8; 2] = b"P6";

struct PpmHeader {
    width: usize,
    height: usize,
    max_value: u32,
}

pub fn read_ppm_dimensions<R: Read>(
    mut reader: R,
    limits: DecodeLimits,
) -> Result<(usize, usize), RasterError> {
    let header = parse_ppm_header(&mut reader, limits)?;
    Ok((header.width, header.height))
}

pub fn decode_ppm<R: Read>(
    mut reader: R,
    limits: DecodeLimits,
) -> Result<DecodedRaster, RasterError> {
    let pixels = PpmPixels::read(&mut reader, limits)?;
    let (width, height) = (pixels.width, pixels.height);
    let mut gray = GrayImage::new(width, height, 255);
    let mut rgb = RgbImage::new(width, height, [255; 3]);
    pixels.for_each_row(|y, row, max_value| {
        let rgb_row = &mut rgb.data_mut()[y * width * 3..(y + 1) * width * 3];
        write_ppm_row(gray.row_mut(y), Some(rgb_row), row, max_value);
    });
    Ok(DecodedRaster { gray, rgb })
}
/// Decodes the same gray plane as `decode_ppm(..).gray` without allocating the
/// colour plane the bilevel and grayscale lanes discard.
pub fn decode_ppm_gray<R: Read>(
    mut reader: R,
    limits: DecodeLimits,
) -> Result<GrayImage, RasterError> {
    let pixels = PpmPixels::read(&mut reader, limits)?;
    let mut gray = GrayImage::new(pixels.width, pixels.height, 255);
    pixels.for_each_row(|y, row, max_value| write_ppm_row(gray.row_mut(y), None, row, max_value));
    Ok(gray)
}
/// The validated PPM P6 payload: everything both decoders share before they
/// differ in which planes they materialize.
struct PpmPixels {
    width: usize,
    height: usize,
    max_value: u32,
    row_bytes: usize,
    data: Vec<u8>,
}
impl PpmPixels {
    fn read<R: Read>(reader: &mut R, limits: DecodeLimits) -> Result<Self, RasterError> {
        let header = parse_ppm_header(reader, limits)?;
        let row_bytes = header
            .width
            .checked_mul(3)
            .ok_or_else(|| RasterError::invalid("PPM P6 row overflow"))?;
        let expected = row_bytes
            .checked_mul(header.height)
            .ok_or_else(|| RasterError::invalid("PPM P6 payload size overflow"))?;
        let mut data = Vec::new();
        data.try_reserve_exact(expected)
            .map_err(|_| RasterError::invalid("Unable to reserve PPM P6 image data"))?;
        data.resize(expected, 0);
        reader.read_exact(&mut data).map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                RasterError::invalid("Truncated PPM P6 payload")
            } else {
                error.into()
            }
        })?;
        if reader.read(&mut [0u8; 1])? != 0 {
            return Err(RasterError::invalid("PPM P6 payload has trailing bytes"));
        }
        Ok(Self {
            width: header.width,
            height: header.height,
            max_value: header.max_value,
            row_bytes,
            data,
        })
    }

    fn for_each_row(self, mut row: impl FnMut(usize, &[u8], u32)) {
        for y in 0..self.height {
            row(
                y,
                &self.data[y * self.row_bytes..(y + 1) * self.row_bytes],
                self.max_value,
            );
        }
    }
}
fn write_ppm_row(gray_row: &mut [u8], rgb_row: Option<&mut [u8]>, source: &[u8], max_value: u32) {
    match rgb_row {
        Some(rgb_row) => {
            for (target, pixel) in rgb_row.chunks_exact_mut(3).zip(source.chunks_exact(3)) {
                for (sample, source) in target.iter_mut().zip(pixel) {
                    *sample = scale_ppm_sample(*source, max_value);
                }
            }
            for (target, pixel) in gray_row.iter_mut().zip(rgb_row.chunks_exact(3)) {
                *target = luma(pixel);
            }
        }
        None => {
            for (target, pixel) in gray_row.iter_mut().zip(source.chunks_exact(3)) {
                *target = luma(&[
                    scale_ppm_sample(pixel[0], max_value),
                    scale_ppm_sample(pixel[1], max_value),
                    scale_ppm_sample(pixel[2], max_value),
                ]);
            }
        }
    }
}
fn scale_ppm_sample(sample: u8, max_value: u32) -> u8 {
    if max_value == 255 {
        sample
    } else {
        let clamped = u32::from(sample).min(max_value);
        ((clamped * 255 + max_value / 2) / max_value) as u8
    }
}

fn parse_ppm_header<R: Read>(
    reader: &mut R,
    limits: DecodeLimits,
) -> Result<PpmHeader, RasterError> {
    let mut magic = [0u8; 2];
    reader.read_exact(&mut magic).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            RasterError::invalid("Invalid PPM P6 signature")
        } else {
            error.into()
        }
    })?;
    if &magic != PPM_SIGNATURE {
        return Err(RasterError::invalid("Invalid PPM P6 signature"));
    }
    let width = read_ppm_number(reader, "width")?;
    let height = read_ppm_number(reader, "height")?;
    let max_value = read_ppm_number(reader, "max value")?;
    if width == 0 || height == 0 {
        return Err(RasterError::invalid("Invalid PPM P6 dimensions"));
    }
    if width > u64::from(limits.max_dimension)
        || height > u64::from(limits.max_dimension)
        || width.saturating_mul(height) > limits.max_pixels
    {
        return Err(RasterError::too_large(format!(
            "PPM P6 dimensions exceed guardrails: {width}x{height}"
        )));
    }
    if max_value == 0 || max_value > 255 {
        return Err(RasterError::invalid(format!(
            "Unsupported PPM P6 max value {max_value}: only 8-bit samples are supported"
        )));
    }
    Ok(PpmHeader {
        width: width as usize,
        height: height as usize,
        max_value: max_value as u32,
    })
}

/// Reads one whitespace-terminated decimal header token, skipping leading
/// whitespace and `#` comments. The terminating whitespace byte is consumed, so
/// after the max-value token the reader is positioned exactly at the payload.
fn read_ppm_number<R: Read>(reader: &mut R, label: &str) -> Result<u64, RasterError> {
    let truncated = || RasterError::invalid(format!("Truncated PPM P6 header before its {label}"));
    let mut byte = loop {
        match read_ppm_byte(reader)?.ok_or_else(truncated)? {
            b'#' => loop {
                match read_ppm_byte(reader)?.ok_or_else(truncated)? {
                    b'\n' => break,
                    _ => continue,
                }
            },
            candidate if candidate.is_ascii_whitespace() => continue,
            candidate => break candidate,
        }
    };
    let mut value = 0u64;
    let mut digits = 0usize;
    loop {
        if !byte.is_ascii_digit() || digits >= 9 {
            return Err(RasterError::invalid(format!("Invalid PPM P6 {label}")));
        }
        value = value * 10 + u64::from(byte - b'0');
        digits += 1;
        match read_ppm_byte(reader)?.ok_or_else(truncated)? {
            candidate if candidate.is_ascii_whitespace() => return Ok(value),
            candidate => byte = candidate,
        }
    }
}

fn read_ppm_byte<R: Read>(reader: &mut R) -> Result<Option<u8>, RasterError> {
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) => return Ok(None),
            Ok(_) => return Ok(Some(byte[0])),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
}

#[derive(Clone, Copy)]
enum WalkMode {
    Dimensions(DecodeLimits),
    Metadata(PassthroughLimits),
    Passthrough(PassthroughLimits),
    Decode(DecodeLimits),
}
#[derive(Clone, Copy)]
struct PngHeader {
    width: u32,
    height: u32,
    color_type: PngColorType,
    bit_depth: u8,
    interlace_method: u8,
    ihdr: [u8; 13],
}
impl PngHeader {
    fn expected_data_len(self) -> Result<usize, RasterError> {
        let bits_per_pixel = self
            .color_type
            .channels()
            .checked_mul(self.bit_depth as usize)
            .ok_or_else(|| RasterError::invalid("Invalid PNG bits per pixel"))?;
        let row_bytes = (self.width as usize)
            .checked_mul(bits_per_pixel)
            .and_then(|value| value.checked_add(7))
            .map(|value| value / 8)
            .ok_or_else(|| RasterError::invalid("Invalid PNG image row length"))?;
        row_bytes
            .checked_add(1)
            .and_then(|value| value.checked_mul(self.height as usize))
            .ok_or_else(|| RasterError::invalid("Invalid PNG image data length"))
    }
}
struct WalkedPng {
    header: PngHeader,
    density: Option<PngDensity>,
    idat: Vec<u8>,
    icc_profile: Option<Vec<u8>>,
    palette: Option<Vec<u8>>,
    indexed_transparency: Option<Vec<u8>>,
    transparency: Option<PngTransparencyKey>,
}
impl WalkedPng {
    fn reconstruct_for_decode(&self) -> Result<Vec<u8>, RasterError> {
        let mut png = PNG_SIGNATURE.to_vec();
        append_png_chunk(&mut png, b"IHDR", &self.header.ihdr)?;
        if let Some(palette) = &self.palette {
            append_png_chunk(&mut png, b"PLTE", palette)?;
        }
        if let Some(transparency) = &self.indexed_transparency {
            append_png_chunk(&mut png, b"tRNS", transparency)?;
        }
        append_png_chunk(&mut png, b"IDAT", &self.idat)?;
        append_png_chunk(&mut png, b"IEND", &[])?;
        Ok(png)
    }
}
fn walk_chunks<R: Read>(mut reader: R, mode: WalkMode) -> Result<WalkedPng, RasterError> {
    let mut signature = [0u8; 8];
    reader.read_exact(&mut signature)?;
    if &signature != PNG_SIGNATURE {
        return Err(RasterError::invalid("Invalid PNG signature"));
    }
    let mut header = None;
    let mut density = None;
    let mut idat = Vec::new();
    let mut idat_len = 0usize;
    let mut icc_profile = None;
    let mut palette = None;
    let mut indexed_transparency = None;
    let mut transparency = None;
    loop {
        let mut chunk_header = [0u8; 8];
        reader.read_exact(&mut chunk_header)?;
        let length = u32::from_be_bytes(chunk_header[..4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = chunk_header[4..].try_into().unwrap();
        let mut hasher = Hasher::new();
        hasher.update(&kind);

        match &kind {
            b"IHDR" => {
                if length != 13 || header.is_some() {
                    return Err(RasterError::invalid("Invalid PNG IHDR"));
                }
                let mut data = [0u8; 13];
                read_chunk_bytes(&mut reader, &mut data, &mut hasher)?;
                header = Some(parse_header(&data, mode)?);
            }
            b"pHYs" if length == 9 => {
                let mut data = [0u8; 9];
                read_chunk_bytes(&mut reader, &mut data, &mut hasher)?;
                if matches!(mode, WalkMode::Passthrough(_) | WalkMode::Metadata(_)) {
                    density = read_phys_density(&data);
                }
            }
            b"PLTE" if matches!(mode, WalkMode::Decode(_)) => {
                if palette.is_some() || length == 0 || length > 768 || length % 3 != 0 {
                    return Err(RasterError::invalid("Invalid PNG palette"));
                }
                let mut data = vec![0; length];
                read_chunk_bytes(&mut reader, &mut data, &mut hasher)?;
                palette = Some(data);
            }
            b"tRNS" if matches!(mode, WalkMode::Decode(_)) => {
                if transparency.is_some() || length > 256 {
                    return Err(RasterError::invalid("Invalid PNG transparency table"));
                }
                let mut data = vec![0; length];
                read_chunk_bytes(&mut reader, &mut data, &mut hasher)?;
                if header.is_some_and(|header| matches!(header.color_type, PngColorType::Indexed)) {
                    indexed_transparency = Some(data);
                } else {
                    let parsed_header = header
                        .ok_or_else(|| RasterError::invalid("PNG tRNS appeared before IHDR"))?;
                    transparency = Some(parse_transparency_key(parsed_header.color_type, &data)?);
                }
            }
            b"iCCP" if matches!(mode, WalkMode::Passthrough(_) | WalkMode::Metadata(_)) => {
                if icc_profile.is_some() {
                    return Err(RasterError::invalid("Duplicate PNG iCCP profile"));
                }
                let max_icc_profile_bytes = match mode {
                    WalkMode::Passthrough(limits) | WalkMode::Metadata(limits) => {
                        limits.max_icc_profile_bytes
                    }
                    _ => unreachable!(),
                };
                if length > max_icc_profile_bytes {
                    return Err(RasterError::invalid(format!(
                        "PNG compressed ICC profile exceeds the {}-byte safety limit",
                        max_icc_profile_bytes
                    )));
                }
                let mut data = vec![0; length];
                read_chunk_bytes(&mut reader, &mut data, &mut hasher)?;
                icc_profile = Some(decode_icc_profile(&data, max_icc_profile_bytes)?);
            }
            b"tRNS" => {
                let parsed_header =
                    header.ok_or_else(|| RasterError::invalid("PNG tRNS appeared before IHDR"))?;
                if idat_len != 0 {
                    return Err(RasterError::invalid("PNG tRNS appeared after IDAT"));
                }
                if matches!(parsed_header.color_type, PngColorType::Indexed) {
                    return Err(RasterError::invalid(
                        "Indexed PNG transparency requires decode mode",
                    ));
                }
                if transparency.is_some() {
                    return Err(RasterError::invalid("Duplicate PNG tRNS chunk"));
                }
                let expected_length = match parsed_header.color_type {
                    PngColorType::Gray8 => 2,
                    PngColorType::Rgb8 => 6,
                    PngColorType::GrayAlpha8 | PngColorType::Rgba8 => 0,
                    PngColorType::Indexed => unreachable!(),
                };
                if length != expected_length {
                    return Err(RasterError::invalid("Invalid PNG tRNS length"));
                }
                let mut data = vec![0; length];
                read_chunk_bytes(&mut reader, &mut data, &mut hasher)?;
                transparency = Some(parse_transparency_key(parsed_header.color_type, &data)?);
            }
            b"IDAT" => {
                let parsed_header =
                    header.ok_or_else(|| RasterError::invalid("PNG IDAT appeared before IHDR"))?;
                let compressed_limit = match mode {
                    WalkMode::Metadata(_) => {
                        max_png_compressed_length(parsed_header.expected_data_len()?)?
                    }
                    WalkMode::Passthrough(_) => {
                        max_png_compressed_length(parsed_header.expected_data_len()?)?
                    }
                    WalkMode::Decode(limits) => limits.max_compressed_bytes,
                    WalkMode::Dimensions(_) => {
                        return Err(RasterError::invalid(
                            "PNG IDAT appeared before IHDR admission",
                        ));
                    }
                };
                let end = idat_len
                    .checked_add(length)
                    .ok_or_else(|| RasterError::invalid("PNG compressed payload overflow"))?;
                if end > compressed_limit {
                    return Err(RasterError::invalid(format!(
                        "PNG compressed image data exceeds the {compressed_limit}-byte safety limit"
                    )));
                }
                if matches!(mode, WalkMode::Metadata(_)) {
                    skip_chunk_bytes(&mut reader, length, &mut hasher)?;
                } else {
                    idat.try_reserve_exact(length)
                        .map_err(|_| RasterError::invalid("Unable to reserve PNG image data"))?;
                    let start = idat.len();
                    idat.resize(end, 0);
                    read_chunk_bytes(&mut reader, &mut idat[start..], &mut hasher)?;
                }
                idat_len = end;
            }
            b"IEND" => {
                if length != 0 {
                    return Err(RasterError::invalid("Invalid PNG IEND length"));
                }
            }
            _ => skip_chunk_bytes(&mut reader, length, &mut hasher)?,
        }
        let mut expected_crc = [0u8; 4];
        reader.read_exact(&mut expected_crc)?;
        if hasher.finalize() != u32::from_be_bytes(expected_crc) {
            return Err(RasterError::invalid("PNG chunk CRC mismatch"));
        }
        let parsed_header = header;
        if matches!(mode, WalkMode::Dimensions(_)) {
            if let Some(header) = parsed_header {
                return Ok(WalkedPng {
                    header,
                    density: None,
                    idat,
                    icc_profile: None,
                    palette: None,
                    indexed_transparency: None,
                    transparency: None,
                });
            }
        }
        if &kind == b"IEND" {
            let header = parsed_header.ok_or_else(|| RasterError::invalid("Missing PNG IHDR"))?;
            if idat_len == 0 {
                return Err(RasterError::invalid("Missing PNG image data"));
            }
            return Ok(WalkedPng {
                header,
                density,
                idat,
                icc_profile,
                palette,
                indexed_transparency,
                transparency,
            });
        }
    }
}
fn parse_transparency_key(
    color_type: PngColorType,
    data: &[u8],
) -> Result<PngTransparencyKey, RasterError> {
    match color_type {
        PngColorType::Gray8 => {
            if data.len() != 2 || data[0] != 0 {
                return Err(RasterError::invalid("Invalid PNG grayscale tRNS key"));
            }
            Ok(PngTransparencyKey::Gray(data[1]))
        }
        PngColorType::Rgb8 => {
            if data.len() != 6 || data.chunks_exact(2).any(|sample| sample[0] != 0) {
                return Err(RasterError::invalid("Invalid PNG RGB tRNS key"));
            }
            Ok(PngTransparencyKey::Rgb([data[1], data[3], data[5]]))
        }
        PngColorType::GrayAlpha8 | PngColorType::Rgba8 | PngColorType::Indexed => Err(
            RasterError::invalid("PNG tRNS is not valid for this color type"),
        ),
    }
}
fn parse_header(data: &[u8; 13], mode: WalkMode) -> Result<PngHeader, RasterError> {
    let width = u32::from_be_bytes(data[..4].try_into().unwrap());
    let height = u32::from_be_bytes(data[4..8].try_into().unwrap());
    let color_type = match data[9] {
        0 => PngColorType::Gray8,
        2 => PngColorType::Rgb8,
        3 => PngColorType::Indexed,
        4 => PngColorType::GrayAlpha8,
        6 => PngColorType::Rgba8,
        value => {
            return Err(RasterError::invalid(format!(
                "Unsupported PNG color type: {value}"
            )));
        }
    };
    let (max_pixels, max_dimension) = match mode {
        WalkMode::Metadata(limits) | WalkMode::Passthrough(limits) => {
            (limits.max_pixels, limits.max_dimension)
        }
        WalkMode::Dimensions(limits) | WalkMode::Decode(limits) => {
            (limits.max_pixels, limits.max_dimension)
        }
    };
    if width == 0 || height == 0 {
        return Err(RasterError::invalid("PNG dimensions must be non-zero"));
    }
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(RasterError::too_large(format!(
            "PNG dimensions exceed pixel guardrails: {width}x{height}"
        )));
    }
    if width > max_dimension || height > max_dimension {
        return Err(RasterError::too_large(format!(
            "PNG dimensions exceed cleanup guardrails: {width}x{height}"
        )));
    }
    let legal_depth = match data[9] {
        0 => matches!(data[8], 1 | 2 | 4 | 8 | 16),
        3 => matches!(data[8], 1 | 2 | 4 | 8),
        2 | 4 | 6 => matches!(data[8], 8 | 16),
        _ => false,
    };
    if !legal_depth || data[10] != 0 || data[11] != 0 || data[12] > 1 {
        return Err(RasterError::invalid(
            "Invalid PNG bit depth, compression, filter, or interlace method",
        ));
    }
    Ok(PngHeader {
        width,
        height,
        color_type,
        bit_depth: data[8],
        interlace_method: data[12],
        ihdr: *data,
    })
}
fn read_chunk_bytes<R: Read>(
    reader: &mut R,
    data: &mut [u8],
    hasher: &mut Hasher,
) -> Result<(), RasterError> {
    reader.read_exact(data)?;
    hasher.update(data);
    Ok(())
}

fn append_png_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) -> Result<(), RasterError> {
    let length = u32::try_from(data.len())
        .map_err(|_| RasterError::too_large("PNG chunk exceeds u32 length"))?;
    png.extend_from_slice(&length.to_be_bytes());
    png.extend_from_slice(kind);
    png.extend_from_slice(data);
    let mut hasher = Hasher::new();
    hasher.update(kind);
    hasher.update(data);
    png.extend_from_slice(&hasher.finalize().to_be_bytes());
    Ok(())
}

fn validate_decoded_rows(idat: &[u8], header: PngHeader) -> Result<(), RasterError> {
    if header.interlace_method != 0 {
        return Ok(());
    }
    let bits_per_pixel = header
        .color_type
        .channels()
        .checked_mul(header.bit_depth as usize)
        .ok_or_else(|| RasterError::invalid("Invalid PNG bits per pixel"))?;
    let row_bytes = (header.width as usize)
        .checked_mul(bits_per_pixel)
        .and_then(|value| value.checked_add(7))
        .map(|value| value / 8)
        .ok_or_else(|| RasterError::invalid("Invalid PNG image row length"))?;
    let expected = row_bytes
        .checked_add(1)
        .and_then(|value| value.checked_mul(header.height as usize))
        .ok_or_else(|| RasterError::invalid("Invalid PNG image data length"))?;
    validate_inflated_rows(idat, expected, row_bytes, header.height as usize)
}
fn skip_chunk_bytes<R: Read>(
    reader: &mut R,
    mut length: usize,
    hasher: &mut Hasher,
) -> Result<(), RasterError> {
    let mut buffer = [0u8; 8192];
    while length > 0 {
        let count = length.min(buffer.len());
        read_chunk_bytes(reader, &mut buffer[..count], hasher)?;
        length -= count;
    }
    Ok(())
}
fn decode_icc_profile(data: &[u8], limit: usize) -> Result<Vec<u8>, RasterError> {
    let name_end = data
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| RasterError::invalid("Invalid PNG iCCP profile name"))?;
    if name_end == 0 || name_end > 79 || data.get(name_end + 1) != Some(&0) {
        return Err(RasterError::invalid("Invalid PNG iCCP profile header"));
    }
    let compressed = data
        .get(name_end + 2..)
        .ok_or_else(|| RasterError::invalid("Invalid PNG iCCP payload"))?;
    let mut profile = Vec::new();
    ZlibDecoder::new(compressed)
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut profile)?;
    if profile.len() > limit {
        return Err(RasterError::invalid(format!(
            "PNG ICC profile exceeds the {limit}-byte safety limit"
        )));
    }
    Ok(profile)
}
fn validate_inflated_rows(
    idat: &[u8],
    expected: usize,
    row_bytes: usize,
    height: usize,
) -> Result<(), RasterError> {
    let mut decoder = ZlibDecoder::new(idat);
    let mut buffer = [0u8; 8192];
    let mut decoded = 0usize;
    let row_length = row_bytes
        .checked_add(1)
        .ok_or_else(|| RasterError::invalid("PNG row length overflow"))?;
    let expected_rows = row_length
        .checked_mul(height)
        .ok_or_else(|| RasterError::invalid("PNG scanline length overflow"))?;
    let mut row_position = 0usize;
    loop {
        let count = expected
            .saturating_sub(decoded)
            .saturating_add(1)
            .min(buffer.len());
        let read = decoder.read(&mut buffer[..count])?;
        if read == 0 {
            break;
        }
        for &byte in &buffer[..read] {
            if row_position % row_length == 0 && byte > 4 {
                return Err(RasterError::invalid(format!(
                    "Unsupported PNG filter: {byte}"
                )));
            }
            row_position = row_position
                .checked_add(1)
                .ok_or_else(|| RasterError::invalid("PNG row position overflow"))?;
        }
        decoded = decoded
            .checked_add(read)
            .ok_or_else(|| RasterError::invalid("PNG image data length overflow"))?;
        if decoded > expected {
            return Err(RasterError::invalid(format!(
                "PNG image data is longer than expected: expected {expected} bytes"
            )));
        }
    }
    if decoded != expected {
        return Err(RasterError::invalid(format!(
            "PNG image data length mismatch: expected {expected} bytes, got {decoded}"
        )));
    }
    if row_position != expected_rows {
        return Err(RasterError::invalid("PNG scanline length mismatch"));
    }
    Ok(())
}
fn max_png_compressed_length(uncompressed: usize) -> Result<usize, RasterError> {
    uncompressed
        .checked_add(uncompressed >> 12)
        .and_then(|value| value.checked_add(uncompressed >> 14))
        .and_then(|value| value.checked_add(uncompressed >> 25))
        .and_then(|value| value.checked_add(64))
        .ok_or_else(|| RasterError::invalid("Invalid PNG compressed image data limit"))
}
fn read_phys_density(data: &[u8; 9]) -> Option<PngDensity> {
    let x = u32::from_be_bytes(data[..4].try_into().unwrap());
    let y = u32::from_be_bytes(data[4..8].try_into().unwrap());
    if data[8] == 1 && x > 0 && y > 0 {
        let x_dpi = (f64::from(x) * METERS_PER_INCH).round();
        let y_dpi = (f64::from(y) * METERS_PER_INCH).round();
        if x_dpi.is_finite() && y_dpi.is_finite() && x_dpi >= 1.0 && y_dpi >= 1.0 {
            Some(PngDensity {
                x_dpi: x_dpi as u32,
                y_dpi: y_dpi as u32,
            })
        } else {
            None
        }
    } else {
        None
    }
}
fn unfilter(
    row: &mut [u8],
    previous: &[u8],
    channels: usize,
    filter: u8,
) -> Result<(), RasterError> {
    for index in 0..row.len() {
        let prior = index.checked_sub(channels);
        let left = prior.map_or(0, |index| row[index]);
        let up = previous[index];
        let upper_left = prior.map_or(0, |index| previous[index]);
        row[index] = row[index].wrapping_add(match filter {
            0 => 0,
            1 => left,
            2 => up,
            3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
            4 => paeth(left, up, upper_left),
            _ => {
                return Err(RasterError::invalid(format!(
                    "Unsupported PNG filter: {filter}"
                )))
            }
        });
    }
    Ok(())
}

fn paeth(left: u8, up: u8, upper_left: u8) -> u8 {
    let prediction = i32::from(left) + i32::from(up) - i32::from(upper_left);
    let distances = (
        (prediction - i32::from(left)).abs(),
        (prediction - i32::from(up)).abs(),
        (prediction - i32::from(upper_left)).abs(),
    );
    if distances.0 <= distances.1 && distances.0 <= distances.2 {
        left
    } else if distances.1 <= distances.2 {
        up
    } else {
        upper_left
    }
}

fn write_chunk<W: Write>(writer: &mut W, kind: &[u8; 4], data: &[u8]) -> Result<(), RasterError> {
    let length =
        u32::try_from(data.len()).map_err(|_| RasterError::invalid("PNG chunk exceeds u32"))?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(kind)?;
    writer.write_all(data)?;
    let mut hasher = Hasher::new();
    hasher.update(kind);
    hasher.update(data);
    writer.write_all(&hasher.finalize().to_be_bytes())?;
    Ok(())
}
