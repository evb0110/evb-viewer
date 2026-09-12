use jpeg_encoder::{ColorType, Encoder as JpegEncoder, SamplingFactor};
use std::{
    borrow::Cow,
    env,
    fs::File,
    io::{BufReader, Cursor, Read},
    path::Path,
    sync::{Mutex, OnceLock},
};

use evb_native_support::bounded_io::read_open_file_bounded;
#[cfg(test)]
use evb_native_support::{NativeError, NativeErrorCode};
use evb_raster_io::{
    decode_png, decode_png_composited_rgb, read_png_metadata, read_png_passthrough, CompressedPng,
    DecodeLimits, PassthroughLimits, PngColorType, PngDensity, PngMetadata,
};

use crate::{
    flate::{deflate_up_filtered_rgb_grayscale, deflate_up_filtered_slices},
    jpeg::{parse_jpeg_metadata, validate_jpeg_decodable},
    jpx::{parse_jpx_metadata, validate_jpx_codestream},
    netpbm::{is_rgb_data_grayscale, parse_netpbm, read_netpbm_file, NetpbmData, OwnedNetpbm},
    pdf::{ImagePage, ImagePayload},
    tiff_io::{visit_tiff_pdf_pages_from_bytes, visit_tiff_pdf_pages_from_file},
    too_large_error, ImageProcessing, PdfBuildOptions, PdfPageSize, Result, DEFAULT_DPI,
};

const JPEG_GUARDRAIL_QUALITY_FLOOR: u8 = 75;
const JPEG_GUARDRAIL_PPI_CAP: f64 = 300.0;
const JPEG_GUARDRAIL_GRAYSCALE_BPP: f64 = 1.5;
const JPEG_GUARDRAIL_COLOR_BPP: f64 = 2.25;
const MAX_PNG_ICC_PROFILE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_INPUT_MB: usize = 512;
const MIN_IMAGE_INPUT_MB: usize = 16;
const MAX_IMAGE_INPUT_MB: usize = 4_096;

static IMAGE_DECODE_ADMISSION: Mutex<()> = Mutex::new(());

fn with_image_decode_admission<T>(decode: impl FnOnce() -> Result<T>) -> Result<T> {
    // PageEncoders can prepare eight pages in parallel. Full JPEG 2000 validation
    // needs several image-sized buffers, so admit one decoder at a time instead of
    // multiplying that peak across the worker pool.
    let _admission = IMAGE_DECODE_ADMISSION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    decode()
}

fn max_image_input_bytes() -> usize {
    static LIMIT: OnceLock<usize> = OnceLock::new();
    *LIMIT.get_or_init(|| {
        env::var("EVB_PDF_COMBINE_MAX_INPUT_MB")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| (MIN_IMAGE_INPUT_MB..=MAX_IMAGE_INPUT_MB).contains(value))
            .unwrap_or(DEFAULT_MAX_IMAGE_INPUT_MB)
            * 1024
            * 1024
    })
}

#[derive(Clone, Copy)]
pub struct JpegSizeGuardrail {
    pub page: usize,
    pub log_json_progress: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum PdfImageCompression {
    Auto,
    Jpeg { quality: u8 },
    JpegWithFlateFallback { quality: u8 },
}

fn image_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_tiff_extension(extension: &str) -> bool {
    extension == "tif" || extension == "tiff"
}

pub(crate) fn visit_image_pages_from_file(
    path: &Path,
    file: File,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    mut on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    let extension = image_extension(path);
    if is_tiff_extension(&extension) {
        return visit_tiff_pdf_pages_from_file(
            file,
            &path.display().to_string(),
            max_pixels,
            default_dpi,
            max_tiff_frames,
            on_page,
        );
    }

    let page = match extension.as_str() {
        "png" => read_png_page_from_reader(BufReader::new(file), max_pixels, default_dpi)?,
        "jpg" | "jpeg" => read_jpeg_page(read_file(file)?, max_pixels, default_dpi)?,
        "jp2" => read_jpx_page(read_file(file)?, max_pixels, default_dpi)?,
        "pgm" | "ppm" => {
            read_netpbm_page_from_file(file, max_pixels, default_dpi.unwrap_or(DEFAULT_DPI))?
        }
        _ => return Err(format!("Unsupported image extension: {}", path.display()).into()),
    };

    on_page(page)?;
    Ok(1)
}

pub(crate) fn read_image_page_from_file(
    path: &Path,
    file: File,
    options: &PdfBuildOptions,
    compression: PdfImageCompression,
    processing: ImageProcessing,
    page_size: Option<PdfPageSize>,
    size_guardrail: Option<JpegSizeGuardrail>,
) -> Result<ImagePage> {
    let extension = image_extension(path);
    match (extension.as_str(), compression) {
        (
            "pgm" | "ppm",
            PdfImageCompression::Jpeg { quality }
            | PdfImageCompression::JpegWithFlateFallback { quality },
        ) => {
            let use_flate_fallback = matches!(
                compression,
                PdfImageCompression::JpegWithFlateFallback { .. }
            );
            read_netpbm_jpeg_page_from_file(
                file,
                options.max_pixels,
                options.default_dpi.unwrap_or(DEFAULT_DPI),
                quality,
                processing,
                page_size,
                size_guardrail,
                use_flate_fallback,
            )
        }
        (
            "png",
            PdfImageCompression::Jpeg { quality }
            | PdfImageCompression::JpegWithFlateFallback { quality },
        ) => {
            let use_flate_fallback = matches!(
                compression,
                PdfImageCompression::JpegWithFlateFallback { .. }
            );
            read_png_jpeg_page(
                &read_file(file)?,
                options.max_pixels,
                options.default_dpi,
                quality,
                processing,
                page_size,
                size_guardrail,
                use_flate_fallback,
            )
        }
        ("jpg" | "jpeg", _) => {
            read_jpeg_page(read_file(file)?, options.max_pixels, options.default_dpi)
        }
        ("jp2", PdfImageCompression::Auto) => {
            read_jpx_page(read_file(file)?, options.max_pixels, options.default_dpi)
        }
        ("pgm" | "ppm", _) => read_netpbm_page_from_file(
            file,
            options.max_pixels,
            options.default_dpi.unwrap_or(DEFAULT_DPI),
        ),
        ("png", PdfImageCompression::Auto) => read_png_page_from_reader(
            BufReader::new(file),
            options.max_pixels,
            options.default_dpi,
        ),
        _ => Err(format!("Unsupported image extension: {}", path.display()).into()),
    }
}

pub(crate) fn visit_image_pages_from_bytes(
    file_name: &str,
    bytes: &[u8],
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    mut on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("")
        .to_ascii_lowercase();
    if is_tiff_extension(&extension) {
        return visit_tiff_pdf_pages_from_bytes(
            bytes,
            max_pixels,
            default_dpi,
            max_tiff_frames,
            on_page,
        );
    }

    let page = match extension.as_str() {
        "png" => read_png_page_from_reader(Cursor::new(bytes), max_pixels, default_dpi)?,
        "jpg" | "jpeg" => read_jpeg_page(bytes.to_vec(), max_pixels, default_dpi)?,
        "jp2" => read_jpx_page(bytes.to_vec(), max_pixels, default_dpi)?,
        "pgm" | "ppm" => read_netpbm_page(bytes, max_pixels, default_dpi.unwrap_or(DEFAULT_DPI))?,
        _ => return Err(format!("Unsupported image extension: {file_name}").into()),
    };
    on_page(page)?;
    Ok(1)
}

pub(crate) fn read_image_page_from_bytes(
    file_name: &str,
    bytes: &[u8],
    options: &PdfBuildOptions,
    compression: PdfImageCompression,
    processing: ImageProcessing,
    page_size: Option<PdfPageSize>,
    size_guardrail: Option<JpegSizeGuardrail>,
) -> Result<ImagePage> {
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("")
        .to_ascii_lowercase();
    match (extension.as_str(), compression) {
        (
            "pgm" | "ppm",
            PdfImageCompression::Jpeg { quality }
            | PdfImageCompression::JpegWithFlateFallback { quality },
        ) => {
            let use_flate_fallback = matches!(
                compression,
                PdfImageCompression::JpegWithFlateFallback { .. }
            );
            read_netpbm_jpeg_page(
                bytes,
                options.max_pixels,
                options.default_dpi.unwrap_or(DEFAULT_DPI),
                quality,
                processing,
                page_size,
                size_guardrail,
                use_flate_fallback,
            )
        }
        (
            "png",
            PdfImageCompression::Jpeg { quality }
            | PdfImageCompression::JpegWithFlateFallback { quality },
        ) => {
            let use_flate_fallback = matches!(
                compression,
                PdfImageCompression::JpegWithFlateFallback { .. }
            );
            read_png_jpeg_page(
                bytes,
                options.max_pixels,
                options.default_dpi,
                quality,
                processing,
                page_size,
                size_guardrail,
                use_flate_fallback,
            )
        }
        ("pgm" | "ppm", PdfImageCompression::Auto)
            if matches!(processing, ImageProcessing::None) =>
        {
            read_netpbm_page(
                bytes,
                options.max_pixels,
                options.default_dpi.unwrap_or(DEFAULT_DPI),
            )
        }
        ("pgm" | "ppm", PdfImageCompression::Auto) => {
            Err("Netpbm byte-input processing requires JPEG compression".into())
        }
        (_, _) if !matches!(processing, ImageProcessing::None) => {
            Err("WASM byte-input processing currently supports PGM/PPM Netpbm inputs only".into())
        }
        ("png", PdfImageCompression::Auto) => {
            read_png_page_from_reader(Cursor::new(bytes), options.max_pixels, options.default_dpi)
        }
        ("jpg" | "jpeg", _) => {
            read_jpeg_page(bytes.to_vec(), options.max_pixels, options.default_dpi)
        }
        ("jp2", PdfImageCompression::Auto) => {
            read_jpx_page(bytes.to_vec(), options.max_pixels, options.default_dpi)
        }
        _ => Err(format!("Unsupported image extension: {file_name}").into()),
    }
}

fn read_file(file: File) -> Result<Vec<u8>> {
    read_open_file_bounded(file, max_image_input_bytes(), "image input").map_err(Into::into)
}

fn read_png_page_from_reader<R: std::io::Read>(
    reader: R,
    max_pixels: u64,
    default_dpi: Option<u32>,
) -> Result<ImagePage> {
    let bytes = read_bounded_reader(reader)?;
    let metadata = read_png_metadata(
        bytes.as_slice(),
        PassthroughLimits {
            max_pixels,
            max_dimension: u32::MAX,
            max_icc_profile_bytes: MAX_PNG_ICC_PROFILE_BYTES,
        },
    )?;
    let color_type = metadata.color_type;

    if metadata.transparency.is_some()
        || matches!(color_type, PngColorType::GrayAlpha8 | PngColorType::Rgba8)
    {
        return png_composited_flate_page(&bytes, metadata, max_pixels, default_dpi);
    }

    match read_png_passthrough(
        bytes.as_slice(),
        PassthroughLimits {
            max_pixels,
            max_dimension: u32::MAX,
            max_icc_profile_bytes: MAX_PNG_ICC_PROFILE_BYTES,
        },
    ) {
        Ok(png) => Ok(png_flate_page(png, default_dpi)),
        Err(_) => png_normalized_flate_page(&bytes, metadata, max_pixels, default_dpi),
    }
}

fn read_bounded_reader<R: Read>(reader: R) -> Result<Vec<u8>> {
    let max_bytes = max_image_input_bytes();
    let mut bytes = Vec::new();
    reader.take(max_bytes as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(format!("Image input exceeds the {max_bytes}-byte safety limit").into());
    }
    Ok(bytes)
}

fn png_dpi(density: Option<PngDensity>, default_dpi: Option<u32>) -> (u32, u32) {
    density
        .map(|density| (density.x_dpi, density.y_dpi))
        .or_else(|| default_dpi.map(|dpi| (dpi, dpi)))
        .unwrap_or((DEFAULT_DPI, DEFAULT_DPI))
}

fn png_flate_page(png: CompressedPng, default_dpi: Option<u32>) -> ImagePage {
    let (colors, color_space) = match png.color_type {
        PngColorType::Gray8 => (1, "DeviceGray"),
        PngColorType::Rgb8 => (3, "DeviceRGB"),
        PngColorType::Indexed => unreachable!("indexed PNGs are normalized before passthrough"),
        PngColorType::GrayAlpha8 | PngColorType::Rgba8 => {
            unreachable!("the passthrough reader rejects alpha-bearing PNG color types")
        }
    };

    let decode_params = format!(
        "<< /Predictor 15 /Colors {colors} /BitsPerComponent 8 /Columns {} >>",
        png.width
    );

    let (dpi_x, dpi_y) = png_dpi(png.density, default_dpi);
    ImagePage {
        width: png.width,
        height: png.height,
        dpi_x,
        dpi_y,
        color_space,
        icc_profile: png.icc_profile,
        payload: ImagePayload::RawFlate {
            data: png.idat,
            decode_params,
        },
    }
}

fn png_composited_flate_page(
    bytes: &[u8],
    png: PngMetadata,
    max_pixels: u64,
    default_dpi: Option<u32>,
) -> Result<ImagePage> {
    let decoded = decode_png_composited_rgb(
        bytes,
        DecodeLimits {
            max_pixels,
            max_dimension: png.width.max(png.height),
            max_compressed_bytes: bytes.len(),
        },
    )?;
    let compressed =
        deflate_up_filtered_slices(decoded.data(), png.width as usize * 3, png.height as usize)?;
    let (dpi_x, dpi_y) = png_dpi(png.density, default_dpi);
    Ok(ImagePage {
        width: png.width,
        height: png.height,
        dpi_x,
        dpi_y,
        color_space: "DeviceRGB",
        icc_profile: png.icc_profile,
        payload: ImagePayload::RawFlate {
            data: compressed,
            decode_params: format!(
                "<< /Predictor 12 /Colors 3 /BitsPerComponent 8 /Columns {} >>",
                png.width
            ),
        },
    })
}

fn png_normalized_flate_page(
    bytes: &[u8],
    png: PngMetadata,
    max_pixels: u64,
    default_dpi: Option<u32>,
) -> Result<ImagePage> {
    let decoded = decode_png(
        bytes,
        DecodeLimits {
            max_pixels,
            max_dimension: png.width.max(png.height),
            max_compressed_bytes: bytes.len(),
        },
    )?;
    let (pixels, colors, color_space, columns) = if matches!(png.color_type, PngColorType::Gray8) {
        (decoded.gray.into_data(), 1, "DeviceGray", png.width)
    } else {
        (decoded.rgb.into_data(), 3, "DeviceRGB", png.width)
    };
    let compressed =
        deflate_up_filtered_slices(&pixels, columns as usize * colors, png.height as usize)?;
    let (dpi_x, dpi_y) = png_dpi(png.density, default_dpi);
    Ok(ImagePage {
        width: png.width,
        height: png.height,
        dpi_x,
        dpi_y,
        color_space,
        icc_profile: png.icc_profile,
        payload: ImagePayload::RawFlate {
            data: compressed,
            decode_params: format!(
                "<< /Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns {} >>",
                png.width
            ),
        },
    })
}

fn read_jpeg_page(bytes: Vec<u8>, max_pixels: u64, default_dpi: Option<u32>) -> Result<ImagePage> {
    let metadata = parse_jpeg_metadata(&bytes)?;
    assert_pixel_limit(metadata.width, metadata.height, max_pixels)?;
    with_image_decode_admission(|| {
        validate_jpeg_decodable(&bytes, metadata.width, metadata.height)
    })?;
    let color_space = match metadata.components {
        1 => "DeviceGray",
        3 => "DeviceRGB",
        _ => {
            return Err(
                format!("Unsupported JPEG component count: {}", metadata.components).into(),
            );
        }
    };

    let dpi = metadata.dpi.or(default_dpi).unwrap_or(DEFAULT_DPI);
    Ok(ImagePage {
        width: metadata.width,
        height: metadata.height,
        dpi_x: dpi,
        dpi_y: dpi,
        color_space,
        icc_profile: metadata.icc_profile,
        payload: ImagePayload::Jpeg { data: bytes },
    })
}

fn read_jpx_page(bytes: Vec<u8>, max_pixels: u64, default_dpi: Option<u32>) -> Result<ImagePage> {
    let metadata = parse_jpx_metadata(&bytes)?;
    assert_pixel_limit(metadata.width, metadata.height, max_pixels)?;
    with_image_decode_admission(|| validate_jpx_codestream(&bytes, metadata))?;
    let dpi = default_dpi.unwrap_or(DEFAULT_DPI);
    Ok(ImagePage {
        width: metadata.width,
        height: metadata.height,
        dpi_x: dpi,
        dpi_y: dpi,
        color_space: if metadata.components == 1 {
            "DeviceGray"
        } else {
            "DeviceRGB"
        },
        icc_profile: None,
        payload: ImagePayload::Jpx { data: bytes },
    })
}

fn read_png_jpeg_page(
    bytes: &[u8],
    max_pixels: u64,
    default_dpi: Option<u32>,
    quality: u8,
    processing: ImageProcessing,
    page_size: Option<PdfPageSize>,
    size_guardrail: Option<JpegSizeGuardrail>,
    use_flate_fallback: bool,
) -> Result<ImagePage> {
    let png = read_png_metadata(
        bytes,
        PassthroughLimits {
            max_pixels,
            max_dimension: u32::MAX,
            max_icc_profile_bytes: MAX_PNG_ICC_PROFILE_BYTES,
        },
    )?;
    let (channels, pixels) = match png.color_type {
        PngColorType::Gray8 if png.transparency.is_none() => {
            let decoded = decode_png(
                bytes,
                DecodeLimits {
                    max_pixels,
                    max_dimension: png.width.max(png.height),
                    max_compressed_bytes: bytes.len(),
                },
            )?;
            (1, Cow::Owned(decoded.gray.into_data()))
        }
        PngColorType::Rgb8 if png.transparency.is_none() => {
            let decoded = decode_png(
                bytes,
                DecodeLimits {
                    max_pixels,
                    max_dimension: png.width.max(png.height),
                    max_compressed_bytes: bytes.len(),
                },
            )?;
            (3, Cow::Owned(decoded.rgb.into_data()))
        }
        PngColorType::Indexed => {
            let decoded = decode_png(
                bytes,
                DecodeLimits {
                    max_pixels,
                    max_dimension: png.width.max(png.height),
                    max_compressed_bytes: bytes.len(),
                },
            )?;
            (3, Cow::Owned(decoded.rgb.into_data()))
        }
        PngColorType::Gray8
        | PngColorType::Rgb8
        | PngColorType::GrayAlpha8
        | PngColorType::Rgba8 => {
            let decoded = decode_png_composited_rgb(
                bytes,
                DecodeLimits {
                    max_pixels,
                    max_dimension: png.width.max(png.height),
                    max_compressed_bytes: bytes.len(),
                },
            )?;
            (3, Cow::Owned(decoded.into_data()))
        }
    };
    let prepared = apply_jpeg_processing(
        PreparedNetpbmPixels {
            width: png.width,
            height: png.height,
            channels,
            pixels,
        },
        max_pixels,
        processing,
        page_size,
    )?;
    let (prepared, quality) =
        encode_with_size_guardrail(prepared, max_pixels, quality, page_size, size_guardrail)?;
    let (data, color_space) = encode_prepared_netpbm_as_jpeg(&prepared, quality)?;
    if use_flate_fallback {
        let flate = encode_prepared_netpbm_as_flate(&prepared)?;
        if flate.data.len() < data.len() {
            let (dpi_x, dpi_y) = png_dpi(png.density, default_dpi);
            return Ok(ImagePage {
                width: prepared.width,
                height: prepared.height,
                dpi_x,
                dpi_y,
                color_space: flate.color_space,
                icc_profile: png.icc_profile,
                payload: ImagePayload::RawFlate {
                    data: flate.data,
                    decode_params: flate.decode_params,
                },
            });
        }
    }
    let (dpi_x, dpi_y) = png_dpi(png.density, default_dpi);
    Ok(ImagePage {
        width: prepared.width,
        height: prepared.height,
        dpi_x,
        dpi_y,
        color_space,
        icc_profile: None,
        payload: ImagePayload::Jpeg { data },
    })
}

fn read_netpbm_page_from_file(file: File, max_pixels: u64, dpi: u32) -> Result<ImagePage> {
    let owned = read_netpbm_file(file, max_pixels)?;
    read_netpbm_page_data(&owned_netpbm_data(&owned), dpi)
}

fn read_netpbm_page(bytes: &[u8], max_pixels: u64, dpi: u32) -> Result<ImagePage> {
    let netpbm = parse_netpbm(bytes, max_pixels)?;
    read_netpbm_page_data(&netpbm, dpi)
}

fn read_netpbm_page_data(netpbm: &NetpbmData<'_>, dpi: u32) -> Result<ImagePage> {
    let total_pixels = netpbm.width as usize * netpbm.height as usize;
    let height = netpbm.height as usize;
    let (colors, color_space, compressed): (u32, &'static str, Vec<u8>) = if netpbm.channels == 1 {
        (
            1,
            "DeviceGray",
            deflate_up_filtered_slices(netpbm.pixels, netpbm.width as usize, height)?,
        )
    } else if is_rgb_data_grayscale(netpbm.pixels, total_pixels) {
        (
            1,
            "DeviceGray",
            deflate_up_filtered_rgb_grayscale(netpbm.pixels, netpbm.width as usize, height)?,
        )
    } else {
        (
            3,
            "DeviceRGB",
            deflate_up_filtered_slices(netpbm.pixels, netpbm.width as usize * 3, height)?,
        )
    };

    let decode_params = format!(
        "<< /Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns {} >>",
        netpbm.width
    );

    Ok(ImagePage {
        width: netpbm.width,
        height: netpbm.height,
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

struct FlateCandidate {
    data: Vec<u8>,
    decode_params: String,
    color_space: &'static str,
}

fn encode_prepared_netpbm_as_flate(prepared: &PreparedNetpbmPixels<'_>) -> Result<FlateCandidate> {
    let total_pixels = prepared.width as usize * prepared.height as usize;
    let height = prepared.height as usize;
    let (colors, color_space, data) = if prepared.channels == 1 {
        (
            1,
            "DeviceGray",
            deflate_up_filtered_slices(prepared.pixels.as_ref(), prepared.width as usize, height)?,
        )
    } else if is_rgb_data_grayscale(prepared.pixels.as_ref(), total_pixels) {
        (
            1,
            "DeviceGray",
            deflate_up_filtered_rgb_grayscale(
                prepared.pixels.as_ref(),
                prepared.width as usize,
                height,
            )?,
        )
    } else {
        (
            3,
            "DeviceRGB",
            deflate_up_filtered_slices(
                prepared.pixels.as_ref(),
                prepared.width as usize * 3,
                height,
            )?,
        )
    };
    Ok(FlateCandidate {
        data,
        decode_params: format!(
            "<< /Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns {} >>",
            prepared.width
        ),
        color_space,
    })
}

fn read_netpbm_jpeg_page(
    bytes: &[u8],
    max_pixels: u64,
    dpi: u32,
    quality: u8,
    processing: ImageProcessing,
    page_size: Option<PdfPageSize>,
    size_guardrail: Option<JpegSizeGuardrail>,
    use_flate_fallback: bool,
) -> Result<ImagePage> {
    let netpbm = parse_netpbm(bytes, max_pixels)?;
    read_netpbm_jpeg_page_data(
        &netpbm,
        max_pixels,
        dpi,
        quality,
        processing,
        page_size,
        size_guardrail,
        use_flate_fallback,
    )
}

fn read_netpbm_jpeg_page_from_file(
    file: File,
    max_pixels: u64,
    dpi: u32,
    quality: u8,
    processing: ImageProcessing,
    page_size: Option<PdfPageSize>,
    size_guardrail: Option<JpegSizeGuardrail>,
    use_flate_fallback: bool,
) -> Result<ImagePage> {
    let owned = read_netpbm_file(file, max_pixels)?;
    read_netpbm_jpeg_page_data(
        &owned_netpbm_data(&owned),
        max_pixels,
        dpi,
        quality,
        processing,
        page_size,
        size_guardrail,
        use_flate_fallback,
    )
}

fn owned_netpbm_data(owned: &OwnedNetpbm) -> NetpbmData<'_> {
    NetpbmData {
        width: owned.width,
        height: owned.height,
        channels: owned.channels,
        pixels: &owned.pixels,
    }
}

fn read_netpbm_jpeg_page_data(
    netpbm: &NetpbmData<'_>,
    max_pixels: u64,
    dpi: u32,
    quality: u8,
    processing: ImageProcessing,
    page_size: Option<PdfPageSize>,
    size_guardrail: Option<JpegSizeGuardrail>,
    use_flate_fallback: bool,
) -> Result<ImagePage> {
    let prepared = prepare_netpbm_for_jpeg(netpbm, max_pixels, processing, page_size)?;
    let (prepared, quality) =
        encode_with_size_guardrail(prepared, max_pixels, quality, page_size, size_guardrail)?;

    let (jpeg_data, jpeg_color_space) = encode_prepared_netpbm_as_jpeg(&prepared, quality)?;
    if use_flate_fallback {
        let flate = encode_prepared_netpbm_as_flate(&prepared)?;
        if flate.data.len() < jpeg_data.len() {
            return Ok(ImagePage {
                width: prepared.width,
                height: prepared.height,
                dpi_x: dpi,
                dpi_y: dpi,
                color_space: flate.color_space,
                icc_profile: None,
                payload: ImagePayload::RawFlate {
                    data: flate.data,
                    decode_params: flate.decode_params,
                },
            });
        }
    }
    Ok(ImagePage {
        width: prepared.width,
        height: prepared.height,
        dpi_x: dpi,
        dpi_y: dpi,
        color_space: jpeg_color_space,
        icc_profile: None,
        payload: ImagePayload::Jpeg { data: jpeg_data },
    })
}

fn encode_prepared_netpbm_as_jpeg(
    prepared: &PreparedNetpbmPixels<'_>,
    quality: u8,
) -> Result<(Vec<u8>, &'static str)> {
    let width = u16::try_from(prepared.width)
        .map_err(|_| format!("JPEG width is too large to encode: {}", prepared.width))?;
    let height = u16::try_from(prepared.height)
        .map_err(|_| format!("JPEG height is too large to encode: {}", prepared.height))?;
    let total_pixels = prepared.width as usize * prepared.height as usize;
    let (pixels, color_type, color_space): (Cow<'_, [u8]>, ColorType, &'static str) =
        if prepared.channels == 1 {
            (
                Cow::Borrowed(prepared.pixels.as_ref()),
                ColorType::Luma,
                "DeviceGray",
            )
        } else if is_rgb_data_grayscale(&prepared.pixels, total_pixels) {
            let mut grayscale = Vec::with_capacity(total_pixels);
            for pixel in prepared.pixels.chunks_exact(3).take(total_pixels) {
                grayscale.push(pixel[0]);
            }
            (Cow::Owned(grayscale), ColorType::Luma, "DeviceGray")
        } else {
            (
                Cow::Borrowed(prepared.pixels.as_ref()),
                ColorType::Rgb,
                "DeviceRGB",
            )
        };

    let mut data = Vec::new();
    let mut encoder = JpegEncoder::new(&mut data, quality);
    if matches!(color_type, ColorType::Rgb) {
        encoder.set_sampling_factor(SamplingFactor::R_4_2_0);
    }
    encoder.encode(&pixels, width, height, color_type)?;
    Ok((data, color_space))
}

fn encode_with_size_guardrail<'a>(
    prepared: PreparedNetpbmPixels<'a>,
    max_pixels: u64,
    quality: u8,
    page_size: Option<PdfPageSize>,
    guardrail: Option<JpegSizeGuardrail>,
) -> Result<(PreparedNetpbmPixels<'a>, u8)> {
    let Some(guardrail) = guardrail else {
        return Ok((prepared, quality));
    };
    let (data, color_space) = encode_prepared_netpbm_as_jpeg(&prepared, quality)?;
    let size_ceiling = jpeg_size_ceiling_bytes(&prepared, color_space, page_size);
    if data.len() <= size_ceiling {
        return Ok((prepared, quality));
    }

    let mut current_prepared = prepared;
    let mut current_quality = quality;
    let mut current_bytes = data.len();

    let lower_quality = quality.saturating_sub(10).max(JPEG_GUARDRAIL_QUALITY_FLOOR);
    if lower_quality < quality {
        let (quality_data, _) = encode_prepared_netpbm_as_jpeg(&current_prepared, lower_quality)?;
        emit_guardrail_action(
            guardrail,
            "quality",
            &quality.to_string(),
            &lower_quality.to_string(),
            current_bytes,
            quality_data.len(),
        );
        current_quality = lower_quality;
        current_bytes = quality_data.len();
    }

    if current_bytes > size_ceiling {
        if let Some((next_width, next_height)) = downscale_dimensions_to_effective_ppi(
            &current_prepared,
            page_size,
            JPEG_GUARDRAIL_PPI_CAP,
        ) {
            let from = format!("{}x{}", current_prepared.width, current_prepared.height);
            current_prepared =
                resize_prepared_netpbm(current_prepared, next_width, next_height, max_pixels)?;
            let (downscaled_data, _) =
                encode_prepared_netpbm_as_jpeg(&current_prepared, current_quality)?;
            emit_guardrail_action(
                guardrail,
                "downscale",
                &from,
                &format!("{}x{}", current_prepared.width, current_prepared.height),
                current_bytes,
                downscaled_data.len(),
            );
        }
    }

    Ok((current_prepared, current_quality))
}

struct PreparedNetpbmPixels<'a> {
    width: u32,
    height: u32,
    channels: u8,
    pixels: Cow<'a, [u8]>,
}

fn prepare_netpbm_for_jpeg<'a>(
    netpbm: &crate::netpbm::NetpbmData<'a>,
    max_pixels: u64,
    processing: ImageProcessing,
    page_size: Option<PdfPageSize>,
) -> Result<PreparedNetpbmPixels<'a>> {
    apply_jpeg_processing(
        PreparedNetpbmPixels {
            width: netpbm.width,
            height: netpbm.height,
            channels: netpbm.channels,
            pixels: Cow::Borrowed(netpbm.pixels),
        },
        max_pixels,
        processing,
        page_size,
    )
}

fn apply_jpeg_processing<'a>(
    prepared: PreparedNetpbmPixels<'a>,
    max_pixels: u64,
    processing: ImageProcessing,
    page_size: Option<PdfPageSize>,
) -> Result<PreparedNetpbmPixels<'a>> {
    match processing {
        ImageProcessing::None => Ok(prepared),
        ImageProcessing::DownscaleToPpi { ppi_cap } => {
            downscale_prepared_netpbm_to_ppi_cap(prepared, max_pixels, page_size, ppi_cap)
        }
    }
}

fn downscale_prepared_netpbm_to_ppi_cap<'a>(
    prepared: PreparedNetpbmPixels<'a>,
    max_pixels: u64,
    page_size: Option<PdfPageSize>,
    ppi_cap: u16,
) -> Result<PreparedNetpbmPixels<'a>> {
    if ppi_cap == 0 {
        return Ok(prepared);
    }
    let Some(page_size) = page_size else {
        return Ok(prepared);
    };
    let width_inches = page_size.width_points / 72.0;
    let height_inches = page_size.height_points / 72.0;
    if width_inches <= 0.0 || height_inches <= 0.0 {
        return Ok(prepared);
    }
    let max_width = (width_inches * f64::from(ppi_cap)).ceil().max(1.0) as u32;
    let max_height = (height_inches * f64::from(ppi_cap)).ceil().max(1.0) as u32;
    if prepared.width <= max_width && prepared.height <= max_height {
        return Ok(prepared);
    }
    let scale =
        (prepared.width as f64 / max_width as f64).max(prepared.height as f64 / max_height as f64);
    let next_width = ((prepared.width as f64) / scale).round().max(1.0) as u32;
    let next_height = ((prepared.height as f64) / scale).round().max(1.0) as u32;
    resize_prepared_netpbm(prepared, next_width, next_height, max_pixels)
}

fn resize_prepared_netpbm<'a>(
    prepared: PreparedNetpbmPixels<'a>,
    next_width: u32,
    next_height: u32,
    max_pixels: u64,
) -> Result<PreparedNetpbmPixels<'a>> {
    if prepared.width == next_width && prepared.height == next_height {
        return Ok(prepared);
    }
    assert_pixel_limit(next_width, next_height, max_pixels)?;
    let source_width = prepared.width as usize;
    let source_height = prepared.height as usize;
    let next_width_usize = next_width as usize;
    let next_height_usize = next_height as usize;
    let channels = prepared.channels as usize;
    let output_len = next_width_usize
        .checked_mul(next_height_usize)
        .and_then(|value| value.checked_mul(channels))
        .ok_or("Resized Netpbm payload size overflow")?;
    let mut output = vec![0u8; output_len];
    if next_width < prepared.width || next_height < prepared.height {
        resize_prepared_netpbm_area_average(
            &prepared,
            &mut output,
            source_width,
            source_height,
            next_width_usize,
            next_height_usize,
            channels,
        );
    } else {
        resize_prepared_netpbm_point_sample(
            &prepared,
            &mut output,
            source_width,
            source_height,
            next_width_usize,
            next_height_usize,
            channels,
        );
    }
    Ok(PreparedNetpbmPixels {
        width: next_width,
        height: next_height,
        channels: prepared.channels,
        pixels: Cow::Owned(output),
    })
}

fn resize_prepared_netpbm_point_sample(
    prepared: &PreparedNetpbmPixels<'_>,
    output: &mut [u8],
    source_width: usize,
    source_height: usize,
    next_width: usize,
    next_height: usize,
    channels: usize,
) {
    for y in 0..next_height {
        let source_y = ((y as f64 + 0.5) * source_height as f64 / next_height as f64)
            .floor()
            .min((source_height - 1) as f64) as usize;
        for x in 0..next_width {
            let source_x = ((x as f64 + 0.5) * source_width as f64 / next_width as f64)
                .floor()
                .min((source_width - 1) as f64) as usize;
            let source_offset = (source_y * source_width + source_x) * channels;
            let output_offset = (y * next_width + x) * channels;
            for channel in 0..channels {
                output[output_offset + channel] = prepared.pixels[source_offset + channel];
            }
        }
    }
}

fn resize_prepared_netpbm_area_average(
    prepared: &PreparedNetpbmPixels<'_>,
    output: &mut [u8],
    source_width: usize,
    source_height: usize,
    next_width: usize,
    next_height: usize,
    channels: usize,
) {
    let scale_x = source_width as f64 / next_width as f64;
    let scale_y = source_height as f64 / next_height as f64;
    for y in 0..next_height {
        let y0 = y as f64 * scale_y;
        let y1 = (y + 1) as f64 * scale_y;
        let source_y_start = y0.floor() as usize;
        let source_y_end = y1.ceil().min(source_height as f64) as usize;
        for x in 0..next_width {
            let x0 = x as f64 * scale_x;
            let x1 = (x + 1) as f64 * scale_x;
            let source_x_start = x0.floor() as usize;
            let source_x_end = x1.ceil().min(source_width as f64) as usize;
            let output_offset = (y * next_width + x) * channels;
            let area = (x1 - x0) * (y1 - y0);
            for channel in 0..channels {
                let mut weighted_sum = 0.0;
                for source_y in source_y_start..source_y_end {
                    let overlap_y = ((source_y + 1) as f64).min(y1) - (source_y as f64).max(y0);
                    if overlap_y <= 0.0 {
                        continue;
                    }
                    for source_x in source_x_start..source_x_end {
                        let overlap_x = ((source_x + 1) as f64).min(x1) - (source_x as f64).max(x0);
                        if overlap_x <= 0.0 {
                            continue;
                        }
                        let source_offset = (source_y * source_width + source_x) * channels;
                        weighted_sum += f64::from(prepared.pixels[source_offset + channel])
                            * overlap_x
                            * overlap_y;
                    }
                }
                output[output_offset + channel] =
                    (weighted_sum / area).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

fn jpeg_size_ceiling_bytes(
    prepared: &PreparedNetpbmPixels<'_>,
    color_space: &str,
    page_size: Option<PdfPageSize>,
) -> usize {
    let base_bpp = if color_space == "DeviceGray" {
        JPEG_GUARDRAIL_GRAYSCALE_BPP
    } else {
        JPEG_GUARDRAIL_COLOR_BPP
    };
    let ppi_multiplier = effective_ppi(prepared, page_size)
        .map(|ppi| (JPEG_GUARDRAIL_PPI_CAP / ppi).clamp(1.0, 3.0))
        .unwrap_or(1.0);
    let bpp = base_bpp * ppi_multiplier;
    ((prepared.width as f64 * prepared.height as f64 * bpp) / 8.0).ceil() as usize
}

fn effective_ppi(
    prepared: &PreparedNetpbmPixels<'_>,
    page_size: Option<PdfPageSize>,
) -> Option<f64> {
    let page_size = page_size?;
    let width_inches = page_size.width_points / 72.0;
    let height_inches = page_size.height_points / 72.0;
    if width_inches <= 0.0 || height_inches <= 0.0 {
        return None;
    }
    Some((prepared.width as f64 / width_inches).max(prepared.height as f64 / height_inches))
}

fn downscale_dimensions_to_effective_ppi(
    prepared: &PreparedNetpbmPixels<'_>,
    page_size: Option<PdfPageSize>,
    ppi_cap: f64,
) -> Option<(u32, u32)> {
    let page_size = page_size?;
    if effective_ppi(prepared, Some(page_size))? <= ppi_cap {
        return None;
    }
    let width_inches = page_size.width_points / 72.0;
    let height_inches = page_size.height_points / 72.0;
    let next_width = (width_inches * ppi_cap).round().max(1.0) as u32;
    let next_height = (height_inches * ppi_cap).round().max(1.0) as u32;
    if next_width >= prepared.width && next_height >= prepared.height {
        return None;
    }
    Some((
        next_width.min(prepared.width),
        next_height.min(prepared.height),
    ))
}

fn emit_guardrail_action(
    guardrail: JpegSizeGuardrail,
    action: &str,
    from: &str,
    to: &str,
    bytes_before: usize,
    bytes_after: usize,
) {
    if guardrail.log_json_progress {
        println!(
            "{{\"page\":{},\"action\":\"{}\",\"from\":\"{}\",\"to\":\"{}\",\"bytesBefore\":{},\"bytesAfter\":{}}}",
            guardrail.page, action, from, to, bytes_before, bytes_after
        );
    }
}

pub(crate) fn assert_pixel_limit(width: u32, height: u32, max_pixels: u64) -> Result<()> {
    let pixels = width as u64 * height as u64;
    if width == 0 || height == 0 || pixels > max_pixels {
        return Err(too_large_error(format!(
            "Image dimensions are too large to combine safely: {width}x{height}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crc32fast::Hasher;
    use evb_raster_io::{encode_png, PixelBuffer};
    use flate2::read::ZlibDecoder;
    use std::{
        io::Read,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        },
        thread,
        time::Duration,
    };

    #[test]
    fn full_image_decode_admission_is_single_slot() {
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(4));
        let threads = (0..4)
            .map(|_| {
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    with_image_decode_admission(|| {
                        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(now, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(10));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }

        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn pixel_ceiling_returns_a_typed_too_large_error() {
        let error = assert_pixel_limit(11, 10, 100).unwrap_err();
        let native_error = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::TooLarge);
    }

    #[test]
    fn builds_grayscale_netpbm_pdf_image_payload() {
        let data = b"P6\n2 1\n255\n\x07\x07\x07\x09\x09\x09";
        let page = read_netpbm_page(data, 1_000_000, 300).unwrap();

        assert_eq!(page.width, 2);
        assert_eq!(page.height, 1);
        assert_eq!(page.dpi_x, 300);
        assert_eq!(page.dpi_y, 300);
        assert_eq!(page.color_space, "DeviceGray");
        match page.payload {
            ImagePayload::RawFlate {
                data,
                decode_params,
            } => {
                assert!(!data.is_empty());
                assert!(decode_params.contains("/Colors 1"));
                assert!(decode_params.contains("/Columns 2"));
            }
            ImagePayload::Jpeg { .. } | ImagePayload::Jpx { .. } | ImagePayload::Bilevel { .. } => {
                panic!("expected flate payload")
            }
        }
    }

    #[test]
    fn png_page_keeps_horizontal_and_vertical_density_independent() {
        let pixels = vec![128u8; 300 * 600 * 3];
        let encoded = encode_png(PixelBuffer::Rgb {
            width: 300,
            height: 600,
            stride: 900,
            data: &pixels,
        })
        .unwrap();
        let mut png = encoded[..33].to_vec();
        let mut phys = Vec::new();
        phys.extend_from_slice(&11811u32.to_be_bytes());
        phys.extend_from_slice(&23622u32.to_be_bytes());
        phys.push(1);
        append_test_chunk(&mut png, b"pHYs", &phys);
        png.extend_from_slice(&encoded[33..]);

        let page = read_image_page_from_bytes(
            "asymmetric.png",
            &png,
            &PdfBuildOptions::default(),
            PdfImageCompression::Auto,
            ImageProcessing::None,
            None,
            None,
        )
        .unwrap();
        assert_eq!((page.dpi_x, page.dpi_y), (300, 600));
    }

    #[test]
    fn png_color_key_pixels_composite_to_white_for_gray_and_rgb_inputs() {
        let cases = [
            (
                PixelBuffer::Gray {
                    width: 2,
                    height: 1,
                    stride: 2,
                    data: &[0, 42],
                },
                b"\x00\x00".as_slice(),
                vec![255, 255, 255, 42, 42, 42],
            ),
            (
                PixelBuffer::Rgb {
                    width: 2,
                    height: 1,
                    stride: 6,
                    data: &[0, 0, 0, 7, 8, 9],
                },
                b"\x00\x00\x00\x00\x00\x00".as_slice(),
                vec![255, 255, 255, 7, 8, 9],
            ),
        ];

        for (pixels, key, expected) in cases {
            let encoded = encode_png(pixels).unwrap();
            let mut png = encoded[..33].to_vec();
            append_test_chunk(&mut png, b"tRNS", key);
            png.extend_from_slice(&encoded[33..]);

            let page = read_image_page_from_bytes(
                "keyed.png",
                &png,
                &PdfBuildOptions::default(),
                PdfImageCompression::Auto,
                ImageProcessing::None,
                None,
                None,
            )
            .unwrap();
            assert_eq!(page.color_space, "DeviceRGB");
            let ImagePayload::RawFlate { data, .. } = page.payload else {
                panic!("expected composited flate payload")
            };
            let mut decoded = Vec::new();
            ZlibDecoder::new(data.as_slice())
                .read_to_end(&mut decoded)
                .unwrap();
            assert_eq!(decoded, [2].into_iter().chain(expected).collect::<Vec<_>>());
        }
    }

    fn append_test_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        png.extend_from_slice(kind);
        png.extend_from_slice(data);
        let mut hasher = Hasher::new();
        hasher.update(kind);
        hasher.update(data);
        png.extend_from_slice(&hasher.finalize().to_be_bytes());
    }

    #[test]
    fn preserves_sparse_color_netpbm_pdf_image_payload() {
        let width = 20_000usize;
        let mut data = format!("P6\n{width} 1\n255\n").into_bytes();
        let mut pixels = vec![7u8; width * 3];
        pixels[4] = 8;
        data.extend_from_slice(&pixels);

        let page = read_netpbm_page(&data, 1_000_000, 300).unwrap();

        assert_eq!(page.color_space, "DeviceRGB");
        match page.payload {
            ImagePayload::RawFlate { decode_params, .. } => {
                assert!(decode_params.contains("/Colors 3"));
            }
            ImagePayload::Jpeg { .. } | ImagePayload::Jpx { .. } | ImagePayload::Bilevel { .. } => {
                panic!("expected flate payload")
            }
        }
    }

    #[test]
    fn encodes_grayscale_netpbm_as_jpeg_payload() {
        let data = b"P6\n2 1\n255\n\x07\x07\x07\x09\x09\x09";
        let page = read_netpbm_jpeg_page(
            data,
            1_000_000,
            300,
            75,
            ImageProcessing::None,
            None,
            None,
            false,
        )
        .unwrap();

        assert_eq!(page.width, 2);
        assert_eq!(page.height, 1);
        assert_eq!(page.color_space, "DeviceGray");
        match page.payload {
            ImagePayload::Jpeg { data } => {
                assert!(data.starts_with(&[0xff, 0xd8]));
            }
            ImagePayload::RawFlate { .. }
            | ImagePayload::Jpx { .. }
            | ImagePayload::Bilevel { .. } => {
                panic!("expected jpeg payload")
            }
        }
    }

    #[test]
    fn netpbm_jpeg_downscales_to_ppi_cap() {
        let data =
            b"P5\n4 4\n255\n\x20\xf0\xf0\xf0\x20\xf0\xf0\xf0\x20\xf0\xf0\xf0\x20\xf0\xf0\xf0";
        let page = read_netpbm_jpeg_page(
            data,
            1_000_000,
            300,
            75,
            ImageProcessing::DownscaleToPpi { ppi_cap: 2 },
            Some(PdfPageSize {
                width_points: 72.0,
                height_points: 72.0,
            }),
            None,
            false,
        )
        .unwrap();

        assert_eq!(page.width, 2);
        assert_eq!(page.height, 2);
        assert_eq!(page.color_space, "DeviceGray");
        match page.payload {
            ImagePayload::Jpeg { data } => {
                let metadata = parse_jpeg_metadata(&data).unwrap();
                assert_eq!(metadata.width, 2);
                assert_eq!(metadata.height, 2);
            }
            ImagePayload::RawFlate { .. }
            | ImagePayload::Jpx { .. }
            | ImagePayload::Bilevel { .. } => {
                panic!("expected jpeg payload")
            }
        }
    }

    #[test]
    fn netpbm_jpeg_size_guardrail_keeps_300_ppi_grayscale_page_at_safe_quality() {
        let prepared = PreparedNetpbmPixels {
            width: 300,
            height: 300,
            channels: 1,
            pixels: std::borrow::Cow::Owned(
                (0..90_000)
                    .map(|index| if index % 37 == 0 { 0u8 } else { 255u8 })
                    .collect(),
            ),
        };

        let (prepared, quality) = encode_with_size_guardrail(
            prepared,
            1_000_000,
            85,
            Some(PdfPageSize {
                width_points: 72.0,
                height_points: 72.0,
            }),
            Some(JpegSizeGuardrail {
                page: 1,
                log_json_progress: false,
            }),
        )
        .unwrap();

        assert_eq!(prepared.width, 300);
        assert_eq!(prepared.height, 300);
        assert!(quality >= 75);
    }

    #[test]
    fn jpeg_size_guardrail_scales_grayscale_budget_for_100_ppi_pages() {
        let page_size = Some(PdfPageSize {
            width_points: 72.0,
            height_points: 72.0,
        });
        let prepared_100_ppi = dense_gray_guardrail_fixture(100, 100);
        let (q85_data, color_space) =
            encode_prepared_netpbm_as_jpeg(&prepared_100_ppi, 85).unwrap();
        let q85_bpp =
            q85_data.len() as f64 * 8.0 / (prepared_100_ppi.width * prepared_100_ppi.height) as f64;

        assert!(
            (2.0..=3.2).contains(&q85_bpp),
            "expected a dense ~2.5 bpp fixture, got {q85_bpp:.2} bpp"
        );
        assert_eq!(color_space, "DeviceGray");
        assert_eq!(
            jpeg_size_ceiling_bytes(&prepared_100_ppi, color_space, page_size),
            5_625
        );

        let (prepared, quality) = encode_with_size_guardrail(
            prepared_100_ppi,
            1_000_000,
            85,
            page_size,
            Some(JpegSizeGuardrail {
                page: 1,
                log_json_progress: false,
            }),
        )
        .unwrap();

        assert_eq!(prepared.width, 100);
        assert_eq!(prepared.height, 100);
        assert_eq!(quality, 85);
    }

    #[test]
    fn jpeg_size_guardrail_keeps_300_ppi_grayscale_budget_unchanged() {
        let prepared_300_ppi = PreparedNetpbmPixels {
            width: 300,
            height: 300,
            channels: 1,
            pixels: std::borrow::Cow::Owned(vec![255; 90_000]),
        };

        assert_eq!(
            jpeg_size_ceiling_bytes(
                &prepared_300_ppi,
                "DeviceGray",
                Some(PdfPageSize {
                    width_points: 72.0,
                    height_points: 72.0,
                }),
            ),
            16_875
        );
    }

    #[test]
    fn netpbm_jpeg_size_guardrail_downscales_to_300_ppi_with_area_average() {
        let prepared = PreparedNetpbmPixels {
            width: 4,
            height: 4,
            channels: 1,
            pixels: std::borrow::Cow::Borrowed(&[
                0, 255, 0, 255, 255, 0, 255, 0, 0, 255, 0, 255, 255, 0, 255, 0,
            ]),
        };

        let (prepared, quality) = encode_with_size_guardrail(
            prepared,
            1_000_000,
            85,
            Some(PdfPageSize {
                width_points: 0.48,
                height_points: 0.48,
            }),
            Some(JpegSizeGuardrail {
                page: 1,
                log_json_progress: false,
            }),
        )
        .unwrap();

        assert_eq!(prepared.width, 2);
        assert_eq!(prepared.height, 2);
        assert!(quality >= 75);
        assert!(prepared
            .pixels
            .iter()
            .all(|value| (126..=129).contains(value)));
    }

    fn dense_gray_guardrail_fixture(width: u32, height: u32) -> PreparedNetpbmPixels<'static> {
        let mut pixels = Vec::with_capacity((width * height) as usize);
        for y in 0..height {
            for x in 0..width {
                let stroke = x % 12 == 0 || y % 29 == 0;
                let soft_edge = x % 12 == 1 || y % 29 == 1;
                pixels.push(if stroke {
                    0
                } else if soft_edge {
                    192
                } else {
                    255
                });
            }
        }
        PreparedNetpbmPixels {
            width,
            height,
            channels: 1,
            pixels: std::borrow::Cow::Owned(pixels),
        }
    }
}
