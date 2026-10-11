use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use evb_native_support::output::{AtomicOutput, ValidatedInputFiles};
use tiff::{
    decoder::{Decoder, DecodingResult},
    encoder::{
        colortype::{self, ColorType},
        Compression, DeflateLevel, Predictor, Rational, TiffEncoder,
    },
    tags::ResolutionUnit,
    ColorType as TiffColorType,
};

use super::read_tiff_dpi_axes;
use crate::{
    image::assert_pixel_limit,
    netpbm::{is_rgb_data_grayscale, read_netpbm_file},
    Result, DEFAULT_DPI,
};

struct TiffExportPage {
    width: u32,
    height: u32,
    dpi_x: u32,
    dpi_y: u32,
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
                let dpi = dpi.map_or((page.dpi_x, page.dpi_y), |dpi| (dpi, dpi));
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
    (dpi_x, dpi_y): (u32, u32),
    samples: &[u8],
) -> Result<()> {
    let mut image = encoder.new_image::<C>(page.width, page.height)?;
    image.resolution_unit(ResolutionUnit::Inch);
    image.x_resolution(Rational { n: dpi_x, d: 1 });
    image.y_resolution(Rational { n: dpi_y, d: 1 });
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
    let (dpi_x, dpi_y) = read_tiff_dpi_axes(&mut decoder).unwrap_or((DEFAULT_DPI, DEFAULT_DPI));
    let color_type = decoder.colortype()?;
    let decoded = decoder.read_image()?;
    let samples = build_tiff_export_samples(width, height, color_type, decoded)?;

    Ok(TiffExportPage {
        width,
        height,
        dpi_x,
        dpi_y,
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
        dpi_x: DEFAULT_DPI,
        dpi_y: DEFAULT_DPI,
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
