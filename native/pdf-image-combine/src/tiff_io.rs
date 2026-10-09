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
        let resolution = read_tiff_dpi_axes(&mut decoder);
        let color_type = decoder.colortype()?;
        let page = if color_type == TiffColorType::Gray(1) {
            let default_dpi = default_dpi.unwrap_or(DEFAULT_DPI);
            let (dpi_x, dpi_y) = resolution.unwrap_or((default_dpi, default_dpi));
            let image = orient_tiff_bilevel(
                read_tiff_bilevel_frame(&mut decoder, width, height)?,
                orientation,
            )?;
            let (dpi_x, dpi_y) = if swaps_tiff_axes(orientation) {
                (dpi_y, dpi_x)
            } else {
                (dpi_x, dpi_y)
            };
            bilevel_image_page(image, dpi_x, dpi_y)?
        } else {
            let dpi = resolution
                .map(|(dpi_x, dpi_y)| dpi_x.max(dpi_y))
                .or(default_dpi)
                .unwrap_or(DEFAULT_DPI);
            let decoded = decoder.read_image()?;
            build_tiff_pdf_page(width, height, dpi, color_type, orientation, decoded)?
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
    dpi: u32,
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
        dpi_x: dpi,
        dpi_y: dpi,
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
mod tests {
    use super::*;
    use std::{
        env, fs, process,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn applies_all_tiff_orientation_transforms() {
        let expected = [
            (1, 3, 2, vec![1, 2, 3, 4, 5, 6]),
            (2, 3, 2, vec![3, 2, 1, 6, 5, 4]),
            (3, 3, 2, vec![6, 5, 4, 3, 2, 1]),
            (4, 3, 2, vec![4, 5, 6, 1, 2, 3]),
            (5, 2, 3, vec![1, 4, 2, 5, 3, 6]),
            (6, 2, 3, vec![4, 1, 5, 2, 6, 3]),
            (7, 2, 3, vec![6, 3, 5, 2, 4, 1]),
            (8, 2, 3, vec![3, 6, 2, 5, 1, 4]),
        ];

        for (orientation, expected_width, expected_height, expected_pixels) in expected {
            let (oriented_width, oriented_height, pixels) =
                orient_tiff_pixels((1..=6).collect(), 3, 2, 1, orientation).unwrap();
            assert_eq!(
                (oriented_width, oriented_height),
                (expected_width, expected_height)
            );
            assert_eq!(pixels, expected_pixels, "orientation {orientation}");
        }
    }

    #[test]
    fn reads_tiff_pages_for_pdf_with_resolution() {
        let input_path = temp_tiff_path("pdf-input");
        write_tiff::<colortype::RGB8>(&input_path, 2, 1, &[255, 0, 0, 0, 255, 0], 300);

        let mut pages = Vec::new();
        visit_tiff_pdf_pages(&input_path, 1_000_000, None, 10, |page| {
            pages.push(page);
            Ok(())
        })
        .unwrap();

        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].width, 2);
        assert_eq!(pages[0].height, 1);
        assert_eq!(pages[0].dpi_x, 300);
        assert_eq!(pages[0].dpi_y, 300);
        assert_eq!(pages[0].color_space, "DeviceRGB");
        match &pages[0].payload {
            ImagePayload::RawFlate {
                data,
                decode_params,
            } => {
                assert!(!data.is_empty());
                assert!(decode_params.contains("/Colors 3"));
                assert!(decode_params.contains("/Columns 2"));
            }
            ImagePayload::Jpeg { .. } | ImagePayload::Jpx { .. } | ImagePayload::Bilevel { .. } => {
                panic!("expected flate payload")
            }
        }

        let _ = fs::remove_file(input_path);
    }

    #[test]
    fn applies_tiff_orientation_before_building_pdf_page() {
        let page = build_tiff_pdf_page(
            2,
            1,
            300,
            TiffColorType::RGB(8),
            6,
            DecodingResult::U8(vec![255, 0, 0, 0, 255, 0]),
        )
        .unwrap();

        assert_eq!((page.width, page.height), (1, 2));
        assert_eq!((page.dpi_x, page.dpi_y), (300, 300));
    }

    #[test]
    fn combines_tiff_pages_with_their_own_samples_and_resolution() {
        let color_path = temp_tiff_path("combine-color");
        let gray_path = temp_tiff_path("combine-gray-rgb");
        let alpha_path = temp_tiff_path("combine-alpha");
        let output_path = temp_tiff_path("combine-output");
        write_tiff::<colortype::RGB8>(&color_path, 2, 1, &[255, 0, 0, 0, 255, 0], 72);
        write_tiff::<colortype::RGB8>(&gray_path, 2, 1, &[16, 16, 16, 240, 240, 240], 144);
        write_tiff::<colortype::RGBA8>(&alpha_path, 1, 1, &[10, 20, 30, 40], 300);
        fs::write(&output_path, b"old-output").unwrap();

        combine_tiff_pages(
            &[color_path.clone(), gray_path.clone(), alpha_path.clone()],
            &output_path,
            1_000_000,
            10,
            None,
        )
        .unwrap();

        let file = File::open(&output_path).unwrap();
        let mut decoder = Decoder::new(BufReader::new(file)).unwrap();
        assert_next_page(
            &mut decoder,
            TiffColorType::RGB(8),
            &[255, 0, 0, 0, 255, 0],
            72.0,
        );
        decoder.next_image().unwrap();
        assert_next_page(&mut decoder, TiffColorType::Gray(8), &[16, 240], 144.0);
        decoder.next_image().unwrap();
        assert_next_page(
            &mut decoder,
            TiffColorType::RGBA(8),
            &[10, 20, 30, 40],
            300.0,
        );
        assert!(!decoder.more_images());

        let _ = fs::remove_file(color_path);
        let _ = fs::remove_file(gray_path);
        let _ = fs::remove_file(alpha_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn combines_netpbm_pages_with_their_own_samples() {
        let color_path = temp_tiff_path("combine-ppm-color");
        let gray_rgb_path = temp_tiff_path("combine-ppm-gray");
        let gray_path = temp_tiff_path("combine-pgm-gray");
        let output_path = temp_tiff_path("combine-netpbm-output");
        fs::write(&color_path, b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00").unwrap();
        fs::write(&gray_rgb_path, b"P6\n2 1\n255\n\x10\x10\x10\xf0\xf0\xf0").unwrap();
        fs::write(&gray_path, b"P5\n1 1\n255\n\x80").unwrap();

        combine_tiff_pages(
            &[color_path.clone(), gray_rgb_path.clone(), gray_path.clone()],
            &output_path,
            1_000_000,
            10,
            Some(300),
        )
        .unwrap();

        let file = File::open(&output_path).unwrap();
        let mut decoder = Decoder::new(BufReader::new(file)).unwrap();
        assert_next_page(
            &mut decoder,
            TiffColorType::RGB(8),
            &[255, 0, 0, 0, 255, 0],
            300.0,
        );
        decoder.next_image().unwrap();
        assert_next_page(&mut decoder, TiffColorType::Gray(8), &[16, 240], 300.0);
        decoder.next_image().unwrap();
        assert_next_page(&mut decoder, TiffColorType::Gray(8), &[128], 300.0);
        assert!(!decoder.more_images());

        let _ = fs::remove_file(color_path);
        let _ = fs::remove_file(gray_rgb_path);
        let _ = fs::remove_file(gray_path);
        let _ = fs::remove_file(output_path);
    }

    const BILEVEL_FIXTURES: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/bilevel-tiff");

    #[test]
    fn bilevel_tiff_frames_keep_their_pixels_polarity_and_orientation() {
        // Each fixture was written by libtiff or ImageMagick and decodes there
        // to the listed patterns; see the fixtures' README.
        for (fixture, expected) in [
            ("g4.tif", &["expected-1.pbm"][..]),
            ("g4-fillorder2.tif", &["expected-1.pbm"]),
            ("g4-minisblack.tif", &["expected-1.pbm"]),
            ("g3-1d.tif", &["expected-1.pbm"]),
            ("g3-2d.tif", &["expected-1.pbm"]),
            ("g3-2d-fax-dpi.tif", &["expected-1.pbm"]),
            ("modified-huffman.tif", &["expected-1.pbm"]),
            ("packbits.tif", &["expected-1.pbm"]),
            ("none-minisblack.tif", &["expected-1.pbm"]),
            ("g4-2frames.tif", &["expected-1.pbm", "expected-2.pbm"]),
            ("g4-orient6.tif", &["expected-1-orient6.pbm"]),
        ] {
            let bytes = fs::read(format!("{BILEVEL_FIXTURES}/{fixture}")).unwrap();
            let mut decoder = Decoder::new(Cursor::new(bytes)).unwrap();
            for (frame, expected) in expected.iter().enumerate() {
                if frame > 0 {
                    decoder.next_image().unwrap();
                }
                assert_eq!(decoder.colortype().unwrap(), TiffColorType::Gray(1));
                let (width, height) = decoder.dimensions().unwrap();
                let orientation = read_tiff_orientation(&mut decoder);
                let image = orient_tiff_bilevel(
                    read_tiff_bilevel_frame(&mut decoder, width, height).unwrap(),
                    orientation,
                )
                .unwrap();
                let expected = crate::netpbm::parse_pbm_p4(
                    &fs::read(format!("{BILEVEL_FIXTURES}/{expected}")).unwrap(),
                    1_000_000,
                )
                .unwrap();
                assert_eq!(
                    (image.width, image.height),
                    (expected.width, expected.height),
                    "{fixture} frame {frame}"
                );
                for y in 0..image.height as usize {
                    for x in 0..image.width as usize {
                        let black = |pbm: &PbmP4Image| {
                            pbm.bitmap[y * pbm.row_stride + x / 8] & (0x80 >> (x % 8)) != 0
                        };
                        assert_eq!(
                            black(&image),
                            black(&expected),
                            "{fixture} frame {frame} pixel ({x}, {y})"
                        );
                    }
                }
            }
            assert!(!decoder.more_images(), "{fixture} has extra frames");
        }
    }

    #[test]
    fn bilevel_tiff_frames_become_bilevel_pdf_pages_at_their_resolution() {
        let frames = fs::read(format!("{BILEVEL_FIXTURES}/g4-2frames.tif")).unwrap();
        let fax = fs::read(format!("{BILEVEL_FIXTURES}/g3-2d-fax-dpi.tif")).unwrap();
        let pdf = crate::write_pdf(
            Vec::new(),
            [&frames, &fax].map(|data| crate::PageSpec::Image {
                page_size: None,
                placement: None,
                rotation_degrees: 0,
                image: crate::ImageSpec {
                    source: crate::InputSource::Bytes {
                        file_name: "scan.tif",
                        data,
                    },
                    compression: crate::ImageCompression::Auto,
                    processing: crate::ImageProcessing::None,
                    size_guardrail: None,
                },
                frames: crate::FramePolicy::All,
            }),
            &crate::PdfBuildOptions::default(),
            |_| {},
        )
        .unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Count 3"));
        assert_eq!(text.matches("/BitsPerComponent 1").count(), 3);
        // 61x40 pixels at 300 dpi, then at 204 x 98 dpi.
        assert_eq!(text.matches("/MediaBox [0 0 14.6400 9.6000]").count(), 2);
        assert!(text.contains("/MediaBox [0 0 21.5294 29.3878]"));
    }

    #[test]
    fn corrupt_ccitt_strips_are_rejected() {
        let mut bytes = fs::read(format!("{BILEVEL_FIXTURES}/g3-2d.tif")).unwrap();
        let mut decoder = Decoder::new(Cursor::new(bytes.clone())).unwrap();
        let offset = decoder.get_tag_u64_vec(Tag::StripOffsets).unwrap()[0] as usize;
        let count = decoder.get_tag_u64_vec(Tag::StripByteCounts).unwrap()[0] as usize;
        bytes[offset..offset + count].fill(0xff);

        assert!(visit_tiff_pdf_pages_from_bytes(&bytes, 1_000_000, None, 10, |_| Ok(())).is_err());
    }

    #[test]
    fn keeps_existing_tiff_and_cleans_temporary_on_late_failure() {
        let valid_path = temp_tiff_path("atomic-valid");
        let invalid_path = temp_tiff_path("atomic-invalid");
        let output_path = temp_tiff_path("atomic-output");
        write_tiff::<colortype::RGB8>(&valid_path, 1, 1, &[255, 0, 0], 72);
        fs::write(&invalid_path, b"invalid tiff").unwrap();
        fs::write(&output_path, b"existing-tiff-output").unwrap();

        let result = combine_tiff_pages(
            &[valid_path.clone(), invalid_path.clone()],
            &output_path,
            1_000_000,
            10,
            None,
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&output_path).unwrap(), b"existing-tiff-output");
        assert_no_sibling_temporary(&output_path);
        let _ = fs::remove_file(valid_path);
        let _ = fs::remove_file(invalid_path);
        let _ = fs::remove_file(output_path);
    }

    fn temp_tiff_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!(
            "evb-pdf-image-combine-{label}-{}-{nanos}.tiff",
            process::id()
        ))
    }

    #[test]
    fn an_axis_resolution_below_one_dpi_takes_the_other_axis() {
        let dpi_axes = |x: Rational, y: Rational| {
            let mut bytes = std::io::Cursor::new(Vec::new());
            let mut encoder = TiffEncoder::new(&mut bytes).unwrap();
            let mut image = encoder.new_image::<colortype::Gray8>(1, 1).unwrap();
            image.resolution_unit(ResolutionUnit::Inch);
            image.x_resolution(x);
            image.y_resolution(y);
            image.write_data(&[0]).unwrap();
            let mut decoder = Decoder::new(std::io::Cursor::new(bytes.into_inner())).unwrap();
            read_tiff_dpi_axes(&mut decoder)
        };
        let below_one = || Rational { n: 2, d: 5 };

        assert_eq!(
            dpi_axes(Rational { n: 300, d: 1 }, below_one()),
            Some((300, 300))
        );
        assert_eq!(
            dpi_axes(below_one(), Rational { n: 200, d: 1 }),
            Some((200, 200))
        );
        assert_eq!(dpi_axes(below_one(), below_one()), None);
        assert_eq!(
            dpi_axes(Rational { n: 204, d: 1 }, Rational { n: 98, d: 1 }),
            Some((204, 98))
        );
    }

    fn write_tiff<C: ColorType<Inner = u8>>(
        path: &Path,
        width: u32,
        height: u32,
        pixels: &[u8],
        dpi: u32,
    ) {
        let file = File::create(path).unwrap();
        let mut encoder = TiffEncoder::new(BufWriter::new(file)).unwrap();
        let mut image = encoder.new_image::<C>(width, height).unwrap();
        image.resolution(ResolutionUnit::Inch, Rational { n: dpi, d: 1 });
        image.write_data(pixels).unwrap();
    }

    fn assert_next_page<R: Read + Seek>(
        decoder: &mut Decoder<R>,
        color_type: TiffColorType,
        pixels: &[u8],
        dpi: f64,
    ) {
        assert_eq!(decoder.colortype().unwrap(), color_type);
        assert_eq!(
            decoder.find_tag_unsigned::<u16>(Tag::Compression).unwrap(),
            Some(8),
            "exported pages are Adobe Deflate compressed"
        );
        assert_eq!(decode_u8(decoder.read_image().unwrap()), pixels);
        assert_eq!(
            decoder
                .find_tag_unsigned::<u16>(Tag::ResolutionUnit)
                .unwrap(),
            Some(2)
        );
        assert_eq!(
            tiff_resolution_value_to_f64(decoder.find_tag(Tag::XResolution).unwrap().unwrap()),
            Some(dpi)
        );
    }

    fn decode_u8(decoded: DecodingResult) -> Vec<u8> {
        match decoded {
            DecodingResult::U8(pixels) => pixels,
            _ => panic!("expected u8 pixels"),
        }
    }

    fn assert_no_sibling_temporary(output_path: &Path) {
        let marker = format!(
            ".{}.evb-tmp-",
            output_path.file_name().unwrap().to_string_lossy()
        );
        let leftovers: Vec<_> = fs::read_dir(output_path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(&marker))
            .collect();
        assert!(leftovers.is_empty(), "temporary output was not cleaned");
    }
}
