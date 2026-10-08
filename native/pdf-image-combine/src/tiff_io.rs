use std::{
    fs::File,
    io::{BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use evb_native_support::output::{AtomicOutput, ValidatedInputFiles};
use tiff::{
    decoder::{ifd::Value as TiffIfdValue, Decoder, DecodingResult},
    encoder::{
        colortype::{self, ColorType},
        Compression, DeflateLevel, Predictor, Rational, TiffEncoder,
    },
    tags::{ResolutionUnit, Tag},
    ColorType as TiffColorType,
};

use crate::{
    flate::deflate_up_filtered_slices,
    image::assert_pixel_limit,
    netpbm::{is_rgb_data_grayscale, read_netpbm_file},
    pdf::{ImagePage, ImagePayload},
    Result, CM_PER_INCH, DEFAULT_DPI,
};

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
        let dpi = read_tiff_dpi(&mut decoder)
            .or(default_dpi)
            .unwrap_or(DEFAULT_DPI);
        let color_type = decoder.colortype()?;
        let decoded = decoder.read_image()?;
        on_page(build_tiff_pdf_page(
            width,
            height,
            dpi,
            color_type,
            orientation,
            decoded,
        )?)?;
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
    let swaps_axes = matches!(orientation, 5..=8);
    let oriented_width = if swaps_axes { height } else { width };
    let oriented_height = if swaps_axes { width } else { height };
    let output_len = (oriented_width as usize)
        .checked_mul(oriented_height as usize)
        .and_then(|value| value.checked_mul(channels))
        .ok_or("TIFF orientation output is too large")?;
    let mut oriented = vec![0; output_len];
    for y in 0..oriented_height as usize {
        for x in 0..oriented_width as usize {
            let (source_x, source_y) = match orientation {
                2 => (width as usize - 1 - x, y),
                3 => (width as usize - 1 - x, height as usize - 1 - y),
                4 => (x, height as usize - 1 - y),
                5 => (y, x),
                6 => (y, height as usize - 1 - x),
                7 => (width as usize - 1 - y, height as usize - 1 - x),
                8 => (width as usize - 1 - y, x),
                _ => (x, y),
            };
            let source_offset = (source_y * width as usize + source_x) * channels;
            let target_offset = (y * oriented_width as usize + x) * channels;
            oriented[target_offset..target_offset + channels]
                .copy_from_slice(&pixels[source_offset..source_offset + channels]);
        }
    }
    Ok((oriented_width, oriented_height, oriented))
}

fn read_tiff_dpi<R: Read + Seek>(decoder: &mut Decoder<R>) -> Option<u32> {
    let x_resolution = decoder
        .find_tag(Tag::XResolution)
        .ok()
        .flatten()
        .and_then(tiff_resolution_value_to_f64);
    let y_resolution = decoder
        .find_tag(Tag::YResolution)
        .ok()
        .flatten()
        .and_then(tiff_resolution_value_to_f64);
    let resolution = x_resolution.unwrap_or(0.0).max(y_resolution.unwrap_or(0.0));
    if resolution <= 0.0 {
        return None;
    }

    match decoder
        .find_tag_unsigned::<u16>(Tag::ResolutionUnit)
        .ok()
        .flatten()
        .unwrap_or(2)
    {
        2 => Some(resolution.round() as u32),
        3 => Some((resolution * CM_PER_INCH).round() as u32),
        _ => None,
    }
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
    combine_validated_tiff_pages(input_paths, output_path, max_pixels, dpi, &validated_inputs)
}

fn combine_validated_tiff_pages(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    dpi: Option<u32>,
    validated_inputs: &ValidatedInputFiles,
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
            for (index, _input_path) in input_paths.iter().enumerate() {
                let page =
                    read_first_tiff_export_page(validated_inputs.clone_file(index)?, max_pixels)?;
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
