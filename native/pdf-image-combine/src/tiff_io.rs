use std::{
    fs::File,
    io::{BufRead, BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use evb_native_support::output::{AtomicOutput, ValidatedInputFiles};
use tiff::{
    decoder::{ifd::Value as TiffIfdValue, ChunkType, Decoder, DecodingResult},
    encoder::{
        colortype::{self, ColorType},
        Compression, DeflateLevel, Predictor, Rational, TiffEncoder,
    },
    tags::{ResolutionUnit, Tag},
    ColorType as TiffColorType,
};

use crate::{
    bilevel_image_page,
    ccitt::{decode_g3_rows, decode_g4_rows, decode_modified_huffman_rows},
    flate::deflate_up_filtered_slices,
    image::assert_pixel_limit,
    netpbm::{is_rgb_data_grayscale, read_netpbm_file, PbmP4Image},
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
    path: &Path,
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

/// The larger axis, for pages that carry one resolution for both.
fn read_tiff_dpi<R: Read + Seek>(decoder: &mut Decoder<R>) -> Option<u32> {
    read_tiff_dpi_axes(decoder).map(|(dpi_x, dpi_y)| dpi_x.max(dpi_y))
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

struct TiffExportPage {
    width: u32,
    height: u32,
    dpi: u32,
    samples: TiffExportSamples,
}

/// Exported pages keep the narrowest representation that holds every source
/// sample: RGB pages whose channels are all equal are written as gray, and
/// four channels are written only for sources that carry alpha.
enum TiffExportSamples {
    Gray(Vec<u8>),
    Rgb(Vec<u8>),
    Rgba(Vec<u8>),
}

impl TiffExportSamples {
    fn from_rgb(mut rgb: Vec<u8>, pixel_count: usize) -> Self {
        if !is_rgb_data_grayscale(&rgb, pixel_count) {
            return Self::Rgb(rgb);
        }
        for index in 0..pixel_count {
            rgb[index] = rgb[index * 3];
        }
        rgb.truncate(pixel_count);
        Self::Gray(rgb)
    }
}

pub(crate) fn combine_tiff_pages(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    max_pages: usize,
    dpi: Option<u32>,
) -> Result<()> {
    if input_paths.is_empty() {
        return Err("No pages available for TIFF export".into());
    }
    if input_paths.len() > max_pages {
        return Err(format!("TIFF export is capped at {max_pages} pages").into());
    }

    let validated_inputs = ValidatedInputFiles::open(input_paths, output_path)?;
    combine_validated_tiff_pages(output_path, max_pixels, dpi, validated_inputs)
}

fn combine_validated_tiff_pages(
    output_path: &Path,
    max_pixels: u64,
    dpi: Option<u32>,
    validated_inputs: ValidatedInputFiles,
) -> Result<()> {
    let mut output = AtomicOutput::create(output_path)?;
    {
        let mut writer = BufWriter::new(output.file_mut()?);
        {
            // Adobe Deflate with horizontal differencing is lossless. The
            // fastest level keeps encoding cheap next to the page render that
            // produced each input.
            let mut encoder = TiffEncoder::new(&mut writer)?
                .with_compression(Compression::Deflate(DeflateLevel::Fast))
                .with_predictor(Predictor::Horizontal);
            for file in validated_inputs.into_files() {
                let page = read_first_tiff_export_page(file, max_pixels)?;
                let dpi = dpi.unwrap_or(page.dpi);
                match &page.samples {
                    TiffExportSamples::Gray(samples) => {
                        write_export_image::<_, colortype::Gray8>(&mut encoder, &page, dpi, samples)
                    }
                    TiffExportSamples::Rgb(samples) => {
                        write_export_image::<_, colortype::RGB8>(&mut encoder, &page, dpi, samples)
                    }
                    TiffExportSamples::Rgba(samples) => {
                        write_export_image::<_, colortype::RGBA8>(&mut encoder, &page, dpi, samples)
                    }
                }?;
            }
        }
        writer.flush()?;
    }
    output.publish()?;
    Ok(())
}

fn write_export_image<W: Write + Seek, C: ColorType<Inner = u8>>(
    encoder: &mut TiffEncoder<W>,
    page: &TiffExportPage,
    dpi: u32,
    samples: &[u8],
) -> Result<()> {
    let mut image = encoder.new_image::<C>(page.width, page.height)?;
    image.resolution(ResolutionUnit::Inch, Rational { n: dpi, d: 1 });
    image.write_data(samples)?;
    Ok(())
}

fn read_first_tiff_export_page(mut file: File, max_pixels: u64) -> Result<TiffExportPage> {
    let mut magic = [0u8; 2];
    let bytes_read = file.read(&mut magic)?;
    file.seek(SeekFrom::Start(0))?;
    if bytes_read == magic.len() && (magic == *b"P5" || magic == *b"P6") {
        return read_first_netpbm_export_page(file, max_pixels);
    }

    let mut decoder = Decoder::new(BufReader::new(file))?;
    let (width, height) = decoder.dimensions()?;
    assert_pixel_limit(width, height, max_pixels)?;
    let dpi = read_tiff_dpi(&mut decoder).unwrap_or(DEFAULT_DPI);
    let color_type = decoder.colortype()?;
    let decoded = decoder.read_image()?;
    let samples = build_tiff_export_samples(width, height, color_type, decoded)?;

    Ok(TiffExportPage {
        width,
        height,
        dpi,
        samples,
    })
}

fn read_first_netpbm_export_page(file: File, max_pixels: u64) -> Result<TiffExportPage> {
    let netpbm = read_netpbm_file(file, max_pixels)?;
    let pixel_count = usize::try_from(u64::from(netpbm.width) * u64::from(netpbm.height))
        .map_err(|_| "Netpbm dimensions exceed the native address space")?;

    let samples = match netpbm.channels {
        1 => {
            if netpbm.pixels.len() != pixel_count {
                return Err("Decoded grayscale Netpbm payload does not match dimensions".into());
            }
            TiffExportSamples::Gray(netpbm.pixels)
        }
        3 => {
            if netpbm.pixels.len() != pixel_count * 3 {
                return Err("Decoded RGB Netpbm payload does not match dimensions".into());
            }
            TiffExportSamples::from_rgb(netpbm.pixels, pixel_count)
        }
        _ => return Err("Unsupported Netpbm color type for native TIFF fast path".into()),
    };
    Ok(TiffExportPage {
        width: netpbm.width,
        height: netpbm.height,
        dpi: DEFAULT_DPI,
        samples,
    })
}

fn build_tiff_export_samples(
    width: u32,
    height: u32,
    color_type: TiffColorType,
    decoded: DecodingResult,
) -> Result<TiffExportSamples> {
    let pixels = match decoded {
        DecodingResult::U8(pixels) => pixels,
        _ => {
            return Err("Only 8-bit TIFF samples are supported by the native TIFF fast path".into())
        }
    };
    let pixel_count = width as usize * height as usize;

    match color_type {
        TiffColorType::Gray(8) => {
            if pixels.len() != pixel_count {
                return Err(
                    "Decoded grayscale TIFF payload length does not match dimensions".into(),
                );
            }
            Ok(TiffExportSamples::Gray(pixels))
        }
        TiffColorType::GrayA(8) => {
            if pixels.len() != pixel_count * 2 {
                return Err(
                    "Decoded grayscale-alpha TIFF payload length does not match dimensions".into(),
                );
            }
            let mut rgba = Vec::with_capacity(pixel_count * 4);
            for chunk in pixels.chunks_exact(2) {
                rgba.extend_from_slice(&[chunk[0], chunk[0], chunk[0], chunk[1]]);
            }
            Ok(TiffExportSamples::Rgba(rgba))
        }
        TiffColorType::RGB(8) => {
            if pixels.len() != pixel_count * 3 {
                return Err("Decoded RGB TIFF payload length does not match dimensions".into());
            }
            Ok(TiffExportSamples::from_rgb(pixels, pixel_count))
        }
        TiffColorType::RGBA(8) => {
            if pixels.len() != pixel_count * 4 {
                return Err("Decoded RGBA TIFF payload length does not match dimensions".into());
            }
            Ok(TiffExportSamples::Rgba(pixels))
        }
        _ => Err(
            format!("Unsupported TIFF color type for native TIFF fast path: {color_type:?}").into(),
        ),
    }
}

#[cfg(test)]
mod tests;
