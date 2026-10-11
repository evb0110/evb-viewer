use std::{
    fs::File,
    io::{BufRead, BufReader, Cursor, Read, Seek, SeekFrom},
};

use tiff::{
    decoder::{ifd::Value as TiffIfdValue, ChunkType, Decoder, DecodingResult},
    tags::Tag,
    ColorType as TiffColorType,
};

use crate::{
    bilevel_image_page,
    ccitt::{decode_g3_rows, decode_g4_rows, decode_modified_huffman_rows},
    flate::deflate_up_filtered_slices,
    image::assert_pixel_limit,
    netpbm::PbmP4Image,
    pdf::{ImagePage, ImagePayload},
    Result, CM_PER_INCH, DEFAULT_DPI,
};

/// T4Options, which says whether Group 3 rows may be two-dimensional.
const T4_OPTIONS_TAG: u16 = 292;

pub(crate) fn read_tiff_pdf_pages_from_bytes(
    bytes: &[u8],
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
) -> Result<Vec<ImagePage>> {
    let mut pages = Vec::new();
    visit_tiff_pdf_pages_from_bytes(bytes, max_pixels, default_dpi, max_tiff_frames, |page| {
        pages.push(page);
        Ok(())
    })?;
    Ok(pages)
}

pub(crate) fn visit_tiff_pdf_pages_from_bytes(
    bytes: &[u8],
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    visit_tiff_pdf_pages_from_reader(
        Cursor::new(bytes),
        "in-memory TIFF",
        max_pixels,
        default_dpi,
        max_tiff_frames,
        on_page,
    )
}

#[cfg(test)]
pub(crate) fn visit_tiff_pdf_pages(
    path: &std::path::Path,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    visit_tiff_pdf_pages_from_file(
        File::open(path)?,
        &path.display().to_string(),
        max_pixels,
        default_dpi,
        max_tiff_frames,
        on_page,
    )
}

pub(crate) fn visit_tiff_pdf_pages_from_file(
    file: File,
    source_label: &str,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    visit_tiff_pdf_pages_from_reader(
        file,
        source_label,
        max_pixels,
        default_dpi,
        max_tiff_frames,
        on_page,
    )
}

fn visit_tiff_pdf_pages_from_reader<R: Read + Seek>(
    reader: R,
    source_label: &str,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    mut on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    let mut decoder = Decoder::new(BufReader::new(reader))?;
    let mut page_count = 0;

    loop {
        if page_count >= max_tiff_frames {
            return Err(format!(
                "TIFF frame count is capped at {max_tiff_frames}: {}",
                source_label,
            )
            .into());
        }

        let (width, height) = decoder.dimensions()?;
        assert_pixel_limit(width, height, max_pixels)?;
        let orientation = read_tiff_orientation(&mut decoder);
        let (dpi_x, dpi_y) = match read_tiff_dpi_axes(&mut decoder) {
            Some((dpi_x, dpi_y)) if swaps_tiff_axes(orientation) => (dpi_y, dpi_x), // rotated frame
            Some(axes) => axes,
            None => default_dpi.map_or((DEFAULT_DPI, DEFAULT_DPI), |dpi| (dpi, dpi)),
        };
        let color_type = decoder.colortype()?;
        let page = if color_type == TiffColorType::Gray(1) {
            let image = orient_tiff_bilevel(
                read_tiff_bilevel_frame(&mut decoder, width, height)?,
                orientation,
            )?;
            bilevel_image_page(image, dpi_x, dpi_y)?
        } else {
            let decoded = decoder.read_image()?;
            build_tiff_pdf_page(
                width,
                height,
                (dpi_x, dpi_y),
                color_type,
                orientation,
                decoded,
            )?
        };
        on_page(page)?;
        page_count += 1;

        if !decoder.more_images() {
            break;
        }
        decoder.next_image()?;
    }

    if page_count == 0 {
        return Err(format!("No decodable TIFF pages found in {source_label}").into());
    }

    Ok(page_count)
}

fn build_tiff_pdf_page(
    width: u32,
    height: u32,
    (dpi_x, dpi_y): (u32, u32),
    color_type: TiffColorType,
    orientation: u16,
    decoded: DecodingResult,
) -> Result<ImagePage> {
    let pixels = match decoded {
        DecodingResult::U8(pixels) => pixels,
        _ => {
            return Err("Only 8-bit TIFF samples are supported by the native PDF fast path".into())
        }
    };

    let (colors, color_space) = match color_type {
        TiffColorType::Gray(8) => (1, "DeviceGray"),
        TiffColorType::RGB(8) => (3, "DeviceRGB"),
        _ => {
            return Err(format!(
                "Unsupported TIFF color type for native PDF fast path: {color_type:?}"
            )
            .into());
        }
    };
    let expected_len = width as usize * height as usize * colors as usize;
    if pixels.len() != expected_len {
        return Err("Decoded TIFF payload length does not match image dimensions".into());
    }

    let (oriented_width, oriented_height, pixels) =
        orient_tiff_pixels(pixels, width, height, colors as usize, orientation)?;
    let bytes_per_row = oriented_width as usize * colors as usize;
    let compressed = deflate_up_filtered_slices(&pixels, bytes_per_row, oriented_height as usize)?;
    let decode_params = format!(
        "<< /Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns {oriented_width} >>"
    );

    Ok(ImagePage {
        width: oriented_width,
        height: oriented_height,
        dpi_x,
        dpi_y,
        color_space,
        icc_profile: None,
        payload: ImagePayload::RawFlate {
            data: compressed,
            decode_params,
        },
    })
}

fn read_tiff_orientation<R: Read + Seek>(decoder: &mut Decoder<R>) -> u16 {
    decoder
        .find_tag_unsigned::<u16>(Tag::Orientation)
        .ok()
        .flatten()
        .filter(|orientation| (1..=8).contains(orientation))
        .unwrap_or(1)
}

fn swaps_tiff_axes(orientation: u16) -> bool {
    matches!(orientation, 5..=8)
}

/// The source pixel shown at `(x, y)` of a frame displayed with `orientation`.
fn tiff_orientation_source(
    orientation: u16,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> (usize, usize) {
    match orientation {
        2 => (width - 1 - x, y),
        3 => (width - 1 - x, height - 1 - y),
        4 => (x, height - 1 - y),
        5 => (y, x),
        6 => (y, height - 1 - x),
        7 => (width - 1 - y, height - 1 - x),
        8 => (width - 1 - y, x),
        _ => (x, y),
    }
}

fn orient_tiff_pixels(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    channels: usize,
    orientation: u16,
) -> Result<(u32, u32, Vec<u8>)> {
    if orientation == 1 {
        return Ok((width, height, pixels));
    }
    let swaps_axes = swaps_tiff_axes(orientation);
    let oriented_width = if swaps_axes { height } else { width };
    let oriented_height = if swaps_axes { width } else { height };
    let output_len = (oriented_width as usize)
        .checked_mul(oriented_height as usize)
        .and_then(|value| value.checked_mul(channels))
        .ok_or("TIFF orientation output is too large")?;
    let mut oriented = vec![0; output_len];
    for y in 0..oriented_height as usize {
        for x in 0..oriented_width as usize {
            let (source_x, source_y) =
                tiff_orientation_source(orientation, x, y, width as usize, height as usize);
            let source_offset = (source_y * width as usize + source_x) * channels;
            let target_offset = (y * oriented_width as usize + x) * channels;
            oriented[target_offset..target_offset + channels]
                .copy_from_slice(&pixels[source_offset..source_offset + channels]);
        }
    }
    Ok((oriented_width, oriented_height, oriented))
}

/// Horizontal and vertical DPI; an axis without a resolution that rounds to
/// at least 1 DPI takes the other axis's value.
fn read_tiff_dpi_axes<R: Read + Seek>(decoder: &mut Decoder<R>) -> Option<(u32, u32)> {
    let mut resolution = |tag| {
        decoder
            .find_tag(tag)
            .ok()
            .flatten()
            .and_then(tiff_resolution_value_to_f64)
            .filter(|resolution| *resolution > 0.0)
    };
    let (x_resolution, y_resolution) =
        match (resolution(Tag::XResolution), resolution(Tag::YResolution)) {
            (Some(x), Some(y)) => (x, y),
            (Some(both), None) | (None, Some(both)) => (both, both),
            (None, None) => return None,
        };

    let scale = match decoder
        .find_tag_unsigned::<u16>(Tag::ResolutionUnit)
        .ok()
        .flatten()
        .unwrap_or(2)
    {
        2 => 1.0,
        3 => CM_PER_INCH,
        _ => return None,
    };
    match (
        (x_resolution * scale).round() as u32,
        (y_resolution * scale).round() as u32,
    ) {
        (0, 0) => None,
        (0, dpi) | (dpi, 0) => Some((dpi, dpi)),
        axes => Some(axes),
    }
}

/// Reads a 1-bit frame as PBM rows, in which a set bit is a black pixel.
fn read_tiff_bilevel_frame<R: BufRead + Seek>(
    decoder: &mut Decoder<R>,
    width: u32,
    height: u32,
) -> Result<PbmP4Image> {
    let row_stride = (width as usize).div_ceil(8);
    let bitmap_len = row_stride
        .checked_mul(height as usize)
        .ok_or("TIFF frame is too large")?;
    let compression = decoder
        .find_tag_unsigned::<u16>(Tag::Compression)?
        .unwrap_or(1);
    let bitmap = if matches!(compression, 2..=4) {
        // A CCITT-coded bit is set where the code says black. With
        // BlackIsZero a set sample is white, so those frames are inverted.
        let mut bitmap = read_tiff_ccitt_rows(decoder, width, height, compression, row_stride)?;
        if decoder.find_tag_unsigned::<u16>(Tag::PhotometricInterpretation)? == Some(1) {
            bitmap.iter_mut().for_each(|byte| *byte = !*byte);
        }
        bitmap
    } else {
        // The decoder hands 1-bit samples over as BlackIsZero for either
        // interpretation, so a clear bit is a black pixel.
        let DecodingResult::U8(mut samples) = decoder.read_image()? else {
            return Err("Decoded 1-bit TIFF samples are not bytes".into());
        };
        samples.iter_mut().for_each(|byte| *byte = !*byte);
        samples
    };
    if bitmap.len() != bitmap_len {
        return Err("Decoded 1-bit TIFF payload length does not match image dimensions".into());
    }
    Ok(PbmP4Image {
        width,
        height,
        row_stride,
        bitmap,
    })
}

/// Decodes the strips of a CCITT Modified Huffman, Group 3 (T4Options bit 0:
/// two-dimensional) or Group 4 frame. FillOrder 2 strips store each byte's
/// bits reversed.
fn read_tiff_ccitt_rows<R: BufRead + Seek>(
    decoder: &mut Decoder<R>,
    width: u32,
    height: u32,
    compression: u16,
    row_stride: usize,
) -> Result<Vec<u8>> {
    if decoder.get_chunk_type() != ChunkType::Strip {
        return Err("Tiled CCITT TIFF frames are not supported".into());
    }
    let offsets = decoder.get_tag_u64_vec(Tag::StripOffsets)?;
    let byte_counts = decoder.get_tag_u64_vec(Tag::StripByteCounts)?;
    let rows_per_strip = decoder
        .find_tag_unsigned::<u32>(Tag::RowsPerStrip)?
        .unwrap_or(u32::MAX)
        .clamp(1, height.max(1)) as usize;
    let reversed_bits = decoder.find_tag_unsigned::<u16>(Tag::FillOrder)? == Some(2);
    let two_dimensional = decoder
        .find_tag_unsigned::<u32>(Tag::Unknown(T4_OPTIONS_TAG))?
        .unwrap_or(0)
        & 1
        != 0;
    let strips = (height as usize).div_ceil(rows_per_strip);
    if offsets.len() < strips || byte_counts.len() < strips {
        return Err("CCITT TIFF frame is missing strip offsets".into());
    }

    let mut bitmap = vec![0u8; row_stride * height as usize];
    for (strip, rows) in bitmap.chunks_mut(rows_per_strip * row_stride).enumerate() {
        let reader = decoder.inner();
        reader.seek(SeekFrom::Start(offsets[strip]))?;
        let bytes = reader
            .by_ref()
            .take(byte_counts[strip])
            .bytes()
            .map(|byte| {
                byte.map(|byte| {
                    if reversed_bits {
                        byte.reverse_bits()
                    } else {
                        byte
                    }
                })
            });
        match compression {
            2 => decode_modified_huffman_rows(bytes, width, row_stride, rows)?,
            3 => decode_g3_rows(bytes, width, two_dimensional, row_stride, rows)?,
            _ => decode_g4_rows(bytes, width, row_stride, rows)?,
        }
    }
    Ok(bitmap)
}

fn orient_tiff_bilevel(image: PbmP4Image, orientation: u16) -> Result<PbmP4Image> {
    if orientation == 1 {
        return Ok(image);
    }
    let (width, height) = (image.width as usize, image.height as usize);
    let (oriented_width, oriented_height) = if swaps_tiff_axes(orientation) {
        (image.height, image.width)
    } else {
        (image.width, image.height)
    };
    let row_stride = (oriented_width as usize).div_ceil(8);
    let mut bitmap = vec![
        0u8;
        row_stride
            .checked_mul(oriented_height as usize)
            .ok_or("TIFF orientation output is too large")?
    ];
    for y in 0..oriented_height as usize {
        for x in 0..oriented_width as usize {
            let (source_x, source_y) = tiff_orientation_source(orientation, x, y, width, height);
            if image.bitmap[source_y * image.row_stride + source_x / 8] & (0x80 >> (source_x % 8))
                != 0
            {
                bitmap[y * row_stride + x / 8] |= 0x80 >> (x % 8);
            }
        }
    }
    Ok(PbmP4Image {
        width: oriented_width,
        height: oriented_height,
        row_stride,
        bitmap,
    })
}

fn tiff_resolution_value_to_f64(value: TiffIfdValue) -> Option<f64> {
    match value {
        TiffIfdValue::Byte(value) => Some(f64::from(value)),
        TiffIfdValue::Short(value) => Some(f64::from(value)),
        TiffIfdValue::Unsigned(value) => Some(f64::from(value)),
        TiffIfdValue::Float(value) => Some(f64::from(value)),
        TiffIfdValue::Double(value) => Some(value),
        TiffIfdValue::Rational(numerator, denominator) if denominator > 0 => {
            Some(f64::from(numerator) / f64::from(denominator))
        }
        TiffIfdValue::List(values) => values
            .into_iter()
            .next()
            .and_then(tiff_resolution_value_to_f64),
        _ => None,
    }
}

mod export;
pub(crate) use export::combine_tiff_pages;

#[cfg(test)]
mod tests;
