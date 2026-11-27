use std::{
    borrow::Cow,
    env,
    fs::File,
    io::{BufReader, Cursor, Read},
    path::Path,
    sync::OnceLock,
};

#[cfg(not(target_family = "wasm"))]
use evb_image_codecs::jpeg::preflight_jpeg_metadata;
use evb_image_codecs::{
    bmp, gif_codec,
    jpeg::{encode_pixels_as_jpeg, parse_jpeg_metadata, resize_pixels, validate_jpeg_decodable},
    webp, DecodedRaster,
};
use evb_native_support::bounded_io::read_open_file_bounded;
#[cfg(test)]
use evb_native_support::{NativeError, NativeErrorCode};
use evb_raster_io::{
    decode_png, decode_png_composited_rgb, decode_png_gray, read_png_metadata,
    read_png_passthrough, CompressedPng, DecodeLimits, PassthroughLimits, PngColorType, PngDensity,
    PngMetadata,
};

use crate::{
    flate::{deflate_up_filtered_rgb_grayscale, deflate_up_filtered_slices},
    jpx::{parse_jpx_metadata, validate_jpx_codestream},
    netpbm::{is_rgb_data_grayscale, parse_netpbm, read_netpbm_file, NetpbmData, OwnedNetpbm},
    pdf::{ImagePage, ImagePayload},
    tiff_io::{
        visit_tiff_pdf_pages_from_bytes_budgeted, visit_tiff_pdf_pages_from_file_budgeted,
        TiffBudget,
    },
    too_large_error, ImageProcessing, PdfBuildOptions, PdfPageSize, Result, DEFAULT_DPI,
};
#[cfg(not(target_family = "wasm"))]
use crate::{
    netpbm::probe_pbm_p4_header,
    tiff_io::{estimate_bilevel_encode_peak_bytes, estimate_up_filtered_flate_working_set_bytes},
};

const JPEG_GUARDRAIL_QUALITY_FLOOR: u8 = 75;
const JPEG_GUARDRAIL_PPI_CAP: f64 = 300.0;
const JPEG_GUARDRAIL_GRAYSCALE_BPP: f64 = 1.5;
const JPEG_GUARDRAIL_COLOR_BPP: f64 = 2.25;
const MAX_PNG_ICC_PROFILE_BYTES: usize = 16 * 1024 * 1024;
#[cfg(not(target_family = "wasm"))]
const MAX_WEBP_ICC_PROFILE_BYTES: usize = 16 * 1024 * 1024;
/// Fixed heap scratch for `gif::Decoder` (`weezl` LZW tables + `BufReader`).
#[cfg(not(target_family = "wasm"))]
const GIF_FIXED_DECODER_STATE_BYTES: u64 = 64 * 1024;
const DEFAULT_MAX_IMAGE_INPUT_MB: usize = 512;
const MIN_IMAGE_INPUT_MB: usize = 16;
const MAX_IMAGE_INPUT_MB: usize = 4_096;

pub(crate) fn max_image_input_bytes() -> usize {
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

#[cfg(not(target_family = "wasm"))]
pub(crate) fn estimate_image_bytes_decode_bytes(
    extension: &str,
    bytes: &[u8],
    compression: PdfImageCompression,
    max_pixels: u64,
) -> u64 {
    match extension.to_ascii_lowercase().as_str() {
        // The preflight sums APP2 ICC chunk lengths without copying them, so
        // the reservation covers the chunk copies and assembled profile that
        // `parse_jpeg_metadata` allocates during preparation. JPEGs without
        // ICC data keep their decode-only estimate.
        "jpg" | "jpeg" => preflight_jpeg_metadata(bytes)
            .ok()
            .filter(|meta| {
                u64::from(meta.width).saturating_mul(u64::from(meta.height)) <= max_pixels
            })
            .map_or(0, |meta| {
                u64::from(meta.width)
                    .saturating_mul(u64::from(meta.height))
                    .saturating_mul(u64::from(meta.components))
                    .saturating_add(meta.icc_profile_working_bytes())
            }),
        "jp2" => parse_jpx_metadata(bytes)
            .ok()
            .filter(|meta| {
                u64::from(meta.width).saturating_mul(u64::from(meta.height)) <= max_pixels
            })
            .map_or(0, |meta| {
                u64::from(meta.width)
                    .saturating_mul(u64::from(meta.height))
                    .saturating_mul(u64::from(meta.components))
                    .saturating_mul(5)
            }),
        "png" => read_png_metadata(
            bytes,
            PassthroughLimits {
                max_pixels,
                max_dimension: u32::MAX,
                max_icc_profile_bytes: MAX_PNG_ICC_PROFILE_BYTES,
            },
        )
        .ok()
        .map_or(0, |meta| {
            let pixels = u64::from(meta.width).saturating_mul(u64::from(meta.height));
            match compression {
                PdfImageCompression::Auto => {
                    if meta.transparency.is_some()
                        || matches!(
                            meta.color_type,
                            PngColorType::Indexed | PngColorType::GrayAlpha8 | PngColorType::Rgba8
                        )
                    {
                        // Compositing onto white decodes into a 3 Bpp RGB buffer and may
                        // also allocate a 1 Bpp grayscale copy while RGB is still live.
                        pixels.saturating_mul(4)
                    } else {
                        // Fast IDAT passthrough allocates only the compressed IDAT bytes.
                        bytes.len() as u64
                    }
                }
                PdfImageCompression::Jpeg { .. }
                | PdfImageCompression::JpegWithFlateFallback { .. } => {
                    let factor = match meta.color_type {
                        PngColorType::Gray8 if meta.transparency.is_none() => 1u64,
                        PngColorType::Rgb8 | PngColorType::Indexed
                            if meta.transparency.is_none() =>
                        {
                            4u64
                        }
                        _ => 3u64,
                    };
                    pixels.saturating_mul(factor)
                }
            }
        }),
        // The raster is borrowed from the reserved source bytes.
        "pgm" | "ppm" => parse_netpbm(bytes, max_pixels).ok().map_or(0, |netpbm| {
            estimate_netpbm_page_encode_bytes(
                netpbm.width,
                netpbm.height,
                netpbm.channels,
                compression,
            )
        }),
        // `parse_pbm_p4` copies the bitmap before `BilevelStream::encode`.
        "pbm" => estimate_pbm_bytes_encode_bytes(bytes, max_pixels),
        "bmp" => bmp::read_bmp_dimensions(bytes)
            .ok()
            .filter(|&(w, h)| u64::from(w).saturating_mul(u64::from(h)) <= max_pixels)
            .map_or(0, |(w, h)| {
                let pixels = u64::from(w).saturating_mul(u64::from(h));
                let decode_peak = pixels.saturating_mul(3);
                let encode_peak = estimate_decoded_raster_encode_peak_bytes(w, h, 0, compression);
                decode_peak.max(encode_peak)
            }),
        "gif" => gif_codec::read_gif_dimensions(bytes)
            .ok()
            .filter(|&(w, h)| u64::from(w).saturating_mul(u64::from(h)) <= max_pixels)
            .map_or(0, |(w, h)| {
                let pixels = u64::from(w).saturating_mul(u64::from(h));
                // `decode_gif` holds the 1 Bpp indexed frame alongside the 3 Bpp RGB
                // canvas plus fixed LZW/BufReader state and any retained extension block.
                let ext_bytes = (bytes.len() as u64)
                    .min(pixels.saturating_add(gif_codec::GIF_DECODER_OVERHEAD_BYTES as u64));
                let decode_peak = pixels
                    .saturating_mul(4)
                    .saturating_add(ext_bytes)
                    .saturating_add(GIF_FIXED_DECODER_STATE_BYTES);
                let encode_peak = estimate_decoded_raster_encode_peak_bytes(w, h, 0, compression);
                decode_peak.max(encode_peak)
            }),
        "webp" => preflight_webp_metadata(bytes)
            .filter(|meta| {
                u64::from(meta.width).saturating_mul(u64::from(meta.height)) <= max_pixels
            })
            .map_or(0, |meta| {
                let decode_peak = estimate_webp_decode_peak_bytes(&meta);
                let encode_peak = estimate_decoded_raster_encode_peak_bytes(
                    meta.width,
                    meta.height,
                    meta.icc_profile_bytes,
                    compression,
                );
                decode_peak.max(encode_peak)
            }),
        _ => 0,
    }
}

#[cfg(not(target_family = "wasm"))]
struct WebpPreflight {
    width: u32,
    height: u32,
    has_alpha: bool,
    is_animated: bool,
    is_lossless: bool,
    has_lossless_alpha_chunk: bool,
    icc_profile_bytes: u64,
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_u24_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset.checked_add(3)?)?;
    Some(u32::from(slice[0]) | (u32::from(slice[1]) << 8) | (u32::from(slice[2]) << 16))
}

fn parse_vp8_keyframe_dimensions(payload: &[u8]) -> Option<(u32, u32)> {
    if payload.len() < 10 {
        return None;
    }
    // Bit 0 == 0 indicates a VP8 keyframe; bytes 3..6 are the VP8 magic bytes.
    if (payload[0] & 1) != 0 || payload[3..6] != [0x9d, 0x01, 0x2a] {
        return None;
    }
    let width = u32::from(u16::from_le_bytes([payload[6], payload[7]]) & 0x3FFF);
    let height = u32::from(u16::from_le_bytes([payload[8], payload[9]]) & 0x3FFF);
    Some((width, height))
}

/// Rejects `VP8X` WebP images whose embedded `VP8 ` bitstream header declares
/// dimensions inconsistent with the `VP8X` canvas (or first `ANMF` frame rect)
/// before `image-webp` allocates YUV planes sized to the mismatched frame.
fn validate_webp_vp8_frame_dimensions(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 30 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Ok(());
    }
    if &bytes[12..16] != b"VP8X" {
        return Ok(());
    }
    let Some(riff_size) = read_u32_le(bytes, 4).map(|v| v as usize) else {
        return Ok(());
    };
    let Some(vp8x_size) = read_u32_le(bytes, 16).map(|v| v as usize) else {
        return Ok(());
    };
    if vp8x_size < 10 {
        return Ok(());
    }
    let flags = bytes[20];
    let is_animated = (flags & 0b0000_0010) != 0;
    let Some(canvas_width) = read_u24_le(bytes, 24).and_then(|v| v.checked_add(1)) else {
        return Ok(());
    };
    let Some(canvas_height) = read_u24_le(bytes, 27).and_then(|v| v.checked_add(1)) else {
        return Ok(());
    };

    let vp8x_rounded = vp8x_size.saturating_add(vp8x_size & 1);
    let Some(mut pos) = 20usize.checked_add(vp8x_rounded) else {
        return Ok(());
    };
    let max_pos = bytes
        .len()
        .min(pos.saturating_add(riff_size.saturating_sub(12)));

    while pos.saturating_add(8) <= max_pos {
        let fourcc = &bytes[pos..pos + 4];
        let Some(chunk_size) = read_u32_le(bytes, pos + 4).map(|v| v as usize) else {
            break;
        };
        let payload_start = pos + 8;
        let payload_end = payload_start.saturating_add(chunk_size).min(bytes.len());
        let payload = &bytes[payload_start..payload_end];
        if !is_animated && fourcc == b"VP8 " {
            if let Some((vp8_w, vp8_h)) = parse_vp8_keyframe_dimensions(payload) {
                if vp8_w != canvas_width || vp8_h != canvas_height {
                    return Err(format!(
                        "WebP VP8 frame dimensions ({vp8_w}x{vp8_h}) do not match VP8X canvas ({canvas_width}x{canvas_height})"
                    )
                    .into());
                }
            }
            break;
        }
        if is_animated && fourcc == b"ANMF" {
            if payload.len() >= 24 {
                if let (Some(fx), Some(fy), Some(fw), Some(fh)) = (
                    read_u24_le(payload, 0).and_then(|v| v.checked_mul(2)),
                    read_u24_le(payload, 3).and_then(|v| v.checked_mul(2)),
                    read_u24_le(payload, 6).and_then(|v| v.checked_add(1)),
                    read_u24_le(payload, 9).and_then(|v| v.checked_add(1)),
                ) {
                    if fx.saturating_add(fw) > canvas_width || fy.saturating_add(fh) > canvas_height
                    {
                        return Err("WebP animated frame exceeds VP8X canvas".into());
                    }
                    let mut sub_pos = 16usize;
                    for _ in 0..2 {
                        if sub_pos.saturating_add(8) > payload.len() {
                            break;
                        }
                        let sub_fourcc = &payload[sub_pos..sub_pos + 4];
                        let Some(sub_size) = read_u32_le(payload, sub_pos + 4).map(|v| v as usize)
                        else {
                            break;
                        };
                        let sub_start = sub_pos + 8;
                        let sub_end = sub_start.saturating_add(sub_size).min(payload.len());
                        if sub_fourcc == b"VP8 " {
                            if let Some((vp8_w, vp8_h)) =
                                parse_vp8_keyframe_dimensions(&payload[sub_start..sub_end])
                            {
                                if vp8_w != fw || vp8_h != fh {
                                    return Err(format!(
                                        "WebP animated VP8 frame dimensions ({vp8_w}x{vp8_h}) do not match ANMF frame ({fw}x{fh})"
                                    )
                                    .into());
                                }
                            }
                            break;
                        }
                        let sub_rounded = sub_size.saturating_add(sub_size & 1);
                        let next_sub = sub_start.saturating_add(sub_rounded);
                        if next_sub <= sub_pos {
                            break;
                        }
                        sub_pos = next_sub;
                    }
                }
            }
            break;
        }
        let chunk_rounded = chunk_size.saturating_add(chunk_size & 1);
        let next_pos = payload_start.saturating_add(chunk_rounded);
        if next_pos <= pos {
            break;
        }
        pos = next_pos;
    }

    Ok(())
}

/// Zero-copy preflight of a WebP RIFF container so admission reserves the true
/// peak decoder buffers (including opaque VP8L's internal 4 Bpp RGBA buffer,
/// VP8 YUV/ALPH buffers, animated canvas/frame buffers, and retained ICC bytes).
#[cfg(not(target_family = "wasm"))]
fn preflight_webp_metadata(bytes: &[u8]) -> Option<WebpPreflight> {
    validate_webp_vp8_frame_dimensions(bytes).ok()?;
    let (width, height) = webp::read_webp_dimensions(bytes).ok()?;
    if bytes.len() < 20 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let riff_size = read_u32_le(bytes, 4)? as usize;
    let first_fourcc = &bytes[12..16];
    let first_chunk_size = read_u32_le(bytes, 16)? as usize;

    match first_fourcc {
        b"VP8 " => Some(WebpPreflight {
            width,
            height,
            has_alpha: false,
            is_animated: false,
            is_lossless: false,
            has_lossless_alpha_chunk: false,
            icc_profile_bytes: 0,
        }),
        b"VP8L" => {
            if bytes.get(20).copied()? != 0x2f {
                return None;
            }
            let header = read_u32_le(bytes, 21)?;
            let has_alpha = (header >> 28) & 1 != 0;
            Some(WebpPreflight {
                width,
                height,
                has_alpha,
                is_animated: false,
                is_lossless: true,
                has_lossless_alpha_chunk: false,
                icc_profile_bytes: 0,
            })
        }
        b"VP8X" => {
            if first_chunk_size < 10 || bytes.len() < 30 {
                return None;
            }
            let flags = bytes[20];
            let has_alpha = (flags & 0b0001_0000) != 0;
            let is_animated = (flags & 0b0000_0010) != 0;
            let first_chunk_rounded = first_chunk_size.saturating_add(first_chunk_size & 1);
            let mut pos = 20usize.checked_add(first_chunk_rounded)?;
            // Match `image-webp`'s RIFF scan bound (`start + chunk_size_rounded + riff_size - 12`).
            let max_pos = bytes
                .len()
                .min(pos.saturating_add(riff_size.saturating_sub(12)));

            let mut saw_iccp = false;
            let mut icc_profile_bytes = 0u64;
            let mut saw_vp8l = false;
            let mut saw_vp8 = false;
            let mut has_lossless_alpha_chunk = false;

            while pos.saturating_add(8) <= max_pos {
                let fourcc = &bytes[pos..pos + 4];
                let chunk_size = read_u32_le(bytes, pos + 4)? as usize;
                let payload_start = pos + 8;
                let chunk_rounded = chunk_size.saturating_add(chunk_size & 1);
                let next_pos = payload_start.saturating_add(chunk_rounded);
                if payload_start.saturating_add(chunk_size) > bytes.len() {
                    break;
                }
                match fourcc {
                    b"ICCP" if !saw_iccp => {
                        saw_iccp = true;
                        if chunk_size <= MAX_WEBP_ICC_PROFILE_BYTES {
                            icc_profile_bytes = chunk_size as u64;
                        }
                    }
                    b"VP8L" => saw_vp8l = true,
                    b"VP8 " => saw_vp8 = true,
                    b"ALPH" if !has_lossless_alpha_chunk => {
                        if let Some(&info) = bytes.get(payload_start) {
                            if (info & 0b0000_0011) == 1 {
                                has_lossless_alpha_chunk = true;
                            }
                        }
                    }
                    _ => {}
                }
                if next_pos <= pos {
                    break;
                }
                pos = next_pos;
            }

            Some(WebpPreflight {
                width,
                height,
                has_alpha,
                is_animated,
                is_lossless: saw_vp8l && !saw_vp8,
                has_lossless_alpha_chunk,
                icc_profile_bytes,
            })
        }
        _ => None,
    }
}

/// Peak live heap during `webp::decode_webp`, matching `image-webp`'s live
/// buffers plus any retained ICC profile.
#[cfg(not(target_family = "wasm"))]
fn estimate_webp_decode_peak_bytes(meta: &WebpPreflight) -> u64 {
    let pixels = u64::from(meta.width).saturating_mul(u64::from(meta.height));
    let decode_pixels = if meta.is_animated {
        // Output buffer (3 or 4 Bpp) + animation RGBA canvas (4 Bpp) + first
        // decoded frame buffer (up to 4 Bpp).
        let factor = if meta.has_alpha { 12u64 } else { 11u64 };
        pixels.saturating_mul(factor)
    } else if meta.is_lossless {
        if meta.has_alpha {
            // 4 Bpp RGBA output (composited in place) + up to 1 Bpp transform scratch.
            pixels.saturating_mul(5)
        } else {
            // Opaque VP8L holds a 3 Bpp RGB output buffer alongside `image-webp`'s
            // internal 4 Bpp RGBA decode buffer + up to 1 Bpp transform scratch.
            pixels.saturating_mul(8)
        }
    } else {
        // Lossy VP8 allocates macroblock-aligned Y/U/V planes (~1.5 Bpp).
        let mb_w = u64::from(meta.width).div_ceil(16).saturating_mul(16);
        let mb_h = u64::from(meta.height).div_ceil(16).saturating_mul(16);
        let vp8_yuv = mb_w.saturating_mul(mb_h).saturating_mul(3) / 2;
        if meta.has_alpha {
            // 4 Bpp RGBA output + VP8 YUV planes + ALPH buffer (1 Bpp raw, or
            // 4 Bpp RGBA + 1 Bpp green + 1 Bpp transform scratch if lossless ALPH).
            let alpha_peak = if meta.has_lossless_alpha_chunk {
                pixels.saturating_mul(6)
            } else {
                pixels
            };
            pixels
                .saturating_mul(4)
                .saturating_add(vp8_yuv)
                .saturating_add(alpha_peak)
        } else {
            pixels.saturating_mul(3).saturating_add(vp8_yuv)
        }
    };
    decode_pixels.saturating_add(meta.icc_profile_bytes)
}

/// Peak live heap while a decoded 3 Bpp RGB raster (plus optional ICC profile)
/// is encoded into its final PDF image stream.
#[cfg(not(target_family = "wasm"))]
fn estimate_decoded_raster_encode_peak_bytes(
    width: u32,
    height: u32,
    icc_profile_bytes: u64,
    compression: PdfImageCompression,
) -> u64 {
    let rgb_bytes = u64::from(width)
        .saturating_mul(u64::from(height))
        .saturating_mul(3);
    rgb_bytes
        .saturating_add(icc_profile_bytes)
        .saturating_add(estimate_netpbm_page_encode_bytes(
            width,
            height,
            3,
            compression,
        ))
}

/// Padded MCU-strip row buffers that `jpeg_encoder::Encoder` allocates while
/// encoding an image of `width` pixels (`1` component uses one 8-row buffer;
/// `3` components with 4:2:0 sampling use three 16-row buffers).
#[cfg(not(target_family = "wasm"))]
fn estimate_jpeg_row_buffer_bytes(width: u32, channels: u8) -> u64 {
    if channels == 1 {
        let buffer_width = u64::from(width).div_ceil(8).saturating_mul(8);
        buffer_width.saturating_mul(8)
    } else {
        let buffer_width = u64::from(width).div_ceil(16).saturating_mul(16);
        buffer_width.saturating_mul(16).saturating_mul(3)
    }
}

/// Peak heap, beyond the source raster, while one Netpbm raster becomes a PDF
/// image stream: the shared Flate working set for automatic pages, the JPEG
/// candidate plus encoder row buffers for JPEG pages, and the peak across both
/// phases when a Flate fallback is compared.
#[cfg(not(target_family = "wasm"))]
pub(crate) fn estimate_netpbm_page_encode_bytes(
    width: u32,
    height: u32,
    channels: u8,
    compression: PdfImageCompression,
) -> u64 {
    let bytes_per_row = u64::from(width).saturating_mul(u64::from(channels));
    let raster_bytes = bytes_per_row.saturating_mul(u64::from(height));
    let flate = estimate_up_filtered_flate_working_set_bytes(bytes_per_row, u64::from(height));
    let jpeg = raster_bytes.saturating_add(estimate_jpeg_row_buffer_bytes(width, channels));
    match compression {
        PdfImageCompression::Auto => flate,
        PdfImageCompression::Jpeg { .. } => jpeg,
        PdfImageCompression::JpegWithFlateFallback { .. } => {
            jpeg.max(raster_bytes.saturating_add(flate))
        }
    }
}

/// Heap for a byte-backed PBM P4 page or mask: the bitmap copy made by
/// `parse_pbm_p4` plus the shared bilevel encoding peak. Reads only the
/// header.
#[cfg(not(target_family = "wasm"))]
pub(crate) fn estimate_pbm_bytes_encode_bytes(bytes: &[u8], max_pixels: u64) -> u64 {
    probe_pbm_p4_header(bytes, max_pixels)
        .ok()
        .map_or(0, |header| {
            (header.data_size as u64).saturating_add(estimate_bilevel_encode_peak_bytes(
                header.width,
                header.height,
            ))
        })
}

pub(crate) fn visit_image_pages_from_file(
    path: &Path,
    file: File,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    budget: Option<TiffBudget<'_, '_>>,
    mut on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    let extension = image_extension(path);
    if is_tiff_extension(&extension) {
        return visit_tiff_pdf_pages_from_file_budgeted(
            file,
            &path.display().to_string(),
            max_pixels,
            default_dpi,
            max_tiff_frames,
            budget,
            on_page,
        );
    }

    let page = match extension.as_str() {
        "png" => read_png_page_from_reader(BufReader::new(file), max_pixels, default_dpi)?,
        "jpg" | "jpeg" => read_jpeg_page(read_file(file)?, max_pixels, default_dpi)?,
        "jp2" => read_jpx_page(read_file(file)?, max_pixels, default_dpi)?,
        "bmp" | "gif" | "webp" => {
            read_decoded_raster_page(&extension, &read_file(file)?, max_pixels, default_dpi)?
        }
        "pgm" | "ppm" => {
            read_netpbm_page_from_file(file, max_pixels, default_dpi.unwrap_or(DEFAULT_DPI))?
        }
        _ => return Err(format!("Unsupported image extension: {}", path.display()).into()),
    };

    on_page(page)?;
    Ok(1)
}

pub(crate) fn visit_image_pages_from_loaded_file_bytes(
    path: &Path,
    bytes: Vec<u8>,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    budget: Option<TiffBudget<'_, '_>>,
    mut on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    let extension = image_extension(path);
    if is_tiff_extension(&extension) {
        return visit_tiff_pdf_pages_from_bytes_budgeted(
            &bytes,
            max_pixels,
            default_dpi,
            max_tiff_frames,
            budget,
            on_page,
        );
    }

    let page = match extension.as_str() {
        "png" => read_png_page_from_bytes(&bytes, max_pixels, default_dpi)?,
        "jpg" | "jpeg" => read_jpeg_page(bytes, max_pixels, default_dpi)?,
        "jp2" => read_jpx_page(bytes, max_pixels, default_dpi)?,
        "bmp" | "gif" | "webp" => {
            read_decoded_raster_page(&extension, &bytes, max_pixels, default_dpi)?
        }
        "pgm" | "ppm" => read_netpbm_page(&bytes, max_pixels, default_dpi.unwrap_or(DEFAULT_DPI))?,
        _ => return Err(format!("Unsupported image extension: {}", path.display()).into()),
    };

    on_page(page)?;
    Ok(1)
}

pub(crate) fn read_image_page_from_loaded_file_bytes(
    path: &Path,
    bytes: Vec<u8>,
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
            read_netpbm_jpeg_page(
                &bytes,
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
                &bytes,
                options.max_pixels,
                options.default_dpi,
                quality,
                processing,
                page_size,
                size_guardrail,
                use_flate_fallback,
            )
        }
        (
            "bmp" | "gif" | "webp",
            PdfImageCompression::Jpeg { quality }
            | PdfImageCompression::JpegWithFlateFallback { quality },
        ) => {
            let use_flate_fallback = matches!(
                compression,
                PdfImageCompression::JpegWithFlateFallback { .. }
            );
            read_decoded_raster_jpeg_page(
                &extension,
                &bytes,
                options.max_pixels,
                options.default_dpi,
                quality,
                processing,
                page_size,
                size_guardrail,
                use_flate_fallback,
            )
        }
        ("jpg" | "jpeg", _) => read_jpeg_page(bytes, options.max_pixels, options.default_dpi),
        ("jp2", PdfImageCompression::Auto) => {
            read_jpx_page(bytes, options.max_pixels, options.default_dpi)
        }
        ("bmp" | "gif" | "webp", PdfImageCompression::Auto) => {
            read_decoded_raster_page(&extension, &bytes, options.max_pixels, options.default_dpi)
        }
        ("pgm" | "ppm", _) => read_netpbm_page(
            &bytes,
            options.max_pixels,
            options.default_dpi.unwrap_or(DEFAULT_DPI),
        ),
        ("png", PdfImageCompression::Auto) => {
            read_png_page_from_bytes(&bytes, options.max_pixels, options.default_dpi)
        }
        _ => Err(format!("Unsupported image extension: {}", path.display()).into()),
    }
}

pub(crate) fn read_owned_netpbm_page(
    owned: &OwnedNetpbm,
    options: &PdfBuildOptions,
    compression: PdfImageCompression,
    processing: ImageProcessing,
    page_size: Option<PdfPageSize>,
    size_guardrail: Option<JpegSizeGuardrail>,
) -> Result<ImagePage> {
    let netpbm = owned_netpbm_data(owned);
    match compression {
        PdfImageCompression::Jpeg { quality }
        | PdfImageCompression::JpegWithFlateFallback { quality } => read_netpbm_jpeg_page_data(
            &netpbm,
            options.max_pixels,
            options.default_dpi.unwrap_or(DEFAULT_DPI),
            quality,
            processing,
            page_size,
            size_guardrail,
            matches!(
                compression,
                PdfImageCompression::JpegWithFlateFallback { .. }
            ),
        ),
        PdfImageCompression::Auto => {
            read_netpbm_page_data(&netpbm, options.default_dpi.unwrap_or(DEFAULT_DPI))
        }
    }
}

pub(crate) fn visit_image_pages_from_bytes(
    file_name: &str,
    bytes: &[u8],
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    budget: Option<TiffBudget<'_, '_>>,
    mut on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("")
        .to_ascii_lowercase();
    if is_tiff_extension(&extension) {
        return visit_tiff_pdf_pages_from_bytes_budgeted(
            bytes,
            max_pixels,
            default_dpi,
            max_tiff_frames,
            budget,
            on_page,
        );
    }

    let page = match extension.as_str() {
        "png" => read_png_page_from_reader(Cursor::new(bytes), max_pixels, default_dpi)?,
        "jpg" | "jpeg" => read_jpeg_page(bytes.to_vec(), max_pixels, default_dpi)?,
        "jp2" => read_jpx_page(bytes.to_vec(), max_pixels, default_dpi)?,
        "bmp" | "gif" | "webp" => {
            read_decoded_raster_page(&extension, bytes, max_pixels, default_dpi)?
        }
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
        (
            "bmp" | "gif" | "webp",
            PdfImageCompression::Jpeg { quality }
            | PdfImageCompression::JpegWithFlateFallback { quality },
        ) => {
            let use_flate_fallback = matches!(
                compression,
                PdfImageCompression::JpegWithFlateFallback { .. }
            );
            read_decoded_raster_jpeg_page(
                &extension,
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
        ("bmp" | "gif" | "webp", PdfImageCompression::Auto) => {
            read_decoded_raster_page(&extension, bytes, options.max_pixels, options.default_dpi)
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

pub(crate) fn read_file(file: File) -> Result<Vec<u8>> {
    read_open_file_bounded(file, max_image_input_bytes(), "image input").map_err(Into::into)
}

fn read_png_page_from_reader<R: std::io::Read>(
    reader: R,
    max_pixels: u64,
    default_dpi: Option<u32>,
) -> Result<ImagePage> {
    let bytes = read_bounded_reader(reader)?;
    read_png_page_from_bytes(&bytes, max_pixels, default_dpi)
}

fn read_png_page_from_bytes(
    bytes: &[u8],
    max_pixels: u64,
    default_dpi: Option<u32>,
) -> Result<ImagePage> {
    let metadata = read_png_metadata(
        bytes,
        PassthroughLimits {
            max_pixels,
            max_dimension: u32::MAX,
            max_icc_profile_bytes: MAX_PNG_ICC_PROFILE_BYTES,
        },
    )?;
    let color_type = metadata.color_type;

    if metadata.transparency.is_some()
        || matches!(
            color_type,
            PngColorType::Indexed | PngColorType::GrayAlpha8 | PngColorType::Rgba8
        )
    {
        return png_composited_flate_page(bytes, metadata, max_pixels, default_dpi);
    }

    match read_png_passthrough(
        bytes,
        PassthroughLimits {
            max_pixels,
            max_dimension: u32::MAX,
            max_icc_profile_bytes: MAX_PNG_ICC_PROFILE_BYTES,
        },
    ) {
        Ok(png) => Ok(png_flate_page(png, default_dpi)),
        Err(_) => png_normalized_flate_page(bytes, metadata, max_pixels, default_dpi),
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
    let gray = matches!(
        png.color_type,
        PngColorType::Gray8 | PngColorType::GrayAlpha8
    );
    let pixels = decoded.into_data();
    let pixels = if gray {
        pixels.iter().step_by(3).copied().collect()
    } else {
        pixels
    };
    let colors = if gray { 1 } else { 3 };
    let compressed =
        deflate_up_filtered_slices(&pixels, png.width as usize * colors, png.height as usize)?;
    let (dpi_x, dpi_y) = png_dpi(png.density, default_dpi);
    Ok(ImagePage {
        width: png.width,
        height: png.height,
        dpi_x,
        dpi_y,
        color_space: if gray { "DeviceGray" } else { "DeviceRGB" },
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
    validate_jpeg_decodable(&bytes, metadata.width, metadata.height)?;
    let color_space = match metadata.components {
        1 => "DeviceGray",
        3 => "DeviceRGB",
        _ => {
            return Err(
                format!("Unsupported JPEG component count: {}", metadata.components).into(),
            );
        }
    };

    let (dpi_x, dpi_y) = metadata
        .dpi
        .or_else(|| default_dpi.map(|dpi| (dpi, dpi)))
        .unwrap_or((DEFAULT_DPI, DEFAULT_DPI));
    Ok(ImagePage {
        width: metadata.width,
        height: metadata.height,
        dpi_x,
        dpi_y,
        color_space,
        icc_profile: metadata.icc_profile,
        payload: ImagePayload::Jpeg { data: bytes },
    })
}

fn read_jpx_page(bytes: Vec<u8>, max_pixels: u64, default_dpi: Option<u32>) -> Result<ImagePage> {
    let metadata = parse_jpx_metadata(&bytes)?;
    assert_pixel_limit(metadata.width, metadata.height, max_pixels)?;
    validate_jpx_codestream(&bytes, metadata)?;
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

fn decode_raster_by_extension(
    extension: &str,
    bytes: &[u8],
    max_pixels: u64,
) -> Result<DecodedRaster> {
    match extension {
        "bmp" => bmp::decode_bmp(bytes, max_pixels),
        "gif" => gif_codec::decode_gif(bytes, max_pixels),
        "webp" => {
            validate_webp_vp8_frame_dimensions(bytes)?;
            webp::decode_webp(bytes, max_pixels)
        }
        _ => Err(format!("Unsupported raster extension: {extension}").into()),
    }
}

fn color_space_channels(color_space: &str) -> usize {
    if color_space == "DeviceGray" {
        1
    } else {
        3
    }
}

fn icc_profile_matches_channels(profile: &[u8], channels: usize) -> bool {
    if profile.len() < 128 || profile.get(36..40) != Some(b"acsp") {
        return false;
    }
    let declared_len =
        u32::from_be_bytes([profile[0], profile[1], profile[2], profile[3]]) as usize;
    if declared_len < 128 || declared_len > profile.len() {
        return false;
    }
    match profile.get(16..20) {
        Some(b"GRAY") => channels == 1,
        Some(b"RGB ") => channels == 3,
        _ => false,
    }
}

fn read_decoded_raster_page(
    extension: &str,
    bytes: &[u8],
    max_pixels: u64,
    default_dpi: Option<u32>,
) -> Result<ImagePage> {
    let decoded = decode_raster_by_extension(extension, bytes, max_pixels)?;
    let (dpi_x, dpi_y) = decoded
        .dpi
        .or_else(|| default_dpi.map(|dpi| (dpi, dpi)))
        .unwrap_or((DEFAULT_DPI, DEFAULT_DPI));
    let total_pixels = decoded.width as usize * decoded.height as usize;
    let has_rgb_icc = decoded
        .icc_profile
        .as_deref()
        .is_some_and(|profile| icc_profile_matches_channels(profile, 3));
    let (colors, color_space, compressed) =
        if !has_rgb_icc && is_rgb_data_grayscale(&decoded.rgb, total_pixels) {
            (
                1usize,
                "DeviceGray",
                deflate_up_filtered_rgb_grayscale(
                    &decoded.rgb,
                    decoded.width as usize,
                    decoded.height as usize,
                )?,
            )
        } else {
            (
                3usize,
                "DeviceRGB",
                deflate_up_filtered_slices(
                    &decoded.rgb,
                    decoded.width as usize * 3,
                    decoded.height as usize,
                )?,
            )
        };
    let icc_profile = decoded
        .icc_profile
        .filter(|profile| icc_profile_matches_channels(profile, colors));
    Ok(ImagePage {
        width: decoded.width,
        height: decoded.height,
        dpi_x,
        dpi_y,
        color_space,
        icc_profile,
        payload: ImagePayload::RawFlate {
            data: compressed,
            decode_params: format!(
                "<< /Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns {} >>",
                decoded.width
            ),
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn read_decoded_raster_jpeg_page(
    extension: &str,
    bytes: &[u8],
    max_pixels: u64,
    default_dpi: Option<u32>,
    quality: u8,
    processing: ImageProcessing,
    page_size: Option<PdfPageSize>,
    size_guardrail: Option<JpegSizeGuardrail>,
    use_flate_fallback: bool,
) -> Result<ImagePage> {
    let decoded = decode_raster_by_extension(extension, bytes, max_pixels)?;
    let (dpi_x, dpi_y) = decoded
        .dpi
        .or_else(|| default_dpi.map(|dpi| (dpi, dpi)))
        .unwrap_or((DEFAULT_DPI, DEFAULT_DPI));
    // Keep 3-channel RGB encoding whenever we are retaining an RGB ICC profile
    // so equal-channel RGB pixels never collapse to 1-channel DeviceGray with a
    // 3-channel RGB ICC profile.
    let preserve_rgb = decoded
        .icc_profile
        .as_deref()
        .is_some_and(|profile| icc_profile_matches_channels(profile, 3));
    let prepared = apply_jpeg_processing(
        PreparedNetpbmPixels {
            width: decoded.width,
            height: decoded.height,
            channels: 3,
            pixels: Cow::Owned(decoded.rgb),
        },
        max_pixels,
        processing,
        page_size,
    )?;
    let (prepared, _, (jpeg_data, jpeg_color_space)) = encode_with_size_guardrail(
        prepared,
        max_pixels,
        quality,
        page_size,
        size_guardrail,
        preserve_rgb,
    )?;
    if use_flate_fallback {
        let flate = encode_prepared_netpbm_as_flate(&prepared, preserve_rgb)?;
        if flate.data.len() < jpeg_data.len() {
            let icc_profile = decoded.icc_profile.filter(|profile| {
                icc_profile_matches_channels(profile, color_space_channels(flate.color_space))
            });
            return Ok(ImagePage {
                width: prepared.width,
                height: prepared.height,
                dpi_x,
                dpi_y,
                color_space: flate.color_space,
                icc_profile,
                payload: ImagePayload::RawFlate {
                    data: flate.data,
                    decode_params: flate.decode_params,
                },
            });
        }
    }
    let icc_profile = decoded.icc_profile.filter(|profile| {
        icc_profile_matches_channels(profile, color_space_channels(jpeg_color_space))
    });
    Ok(ImagePage {
        width: prepared.width,
        height: prepared.height,
        dpi_x,
        dpi_y,
        color_space: jpeg_color_space,
        icc_profile,
        payload: ImagePayload::Jpeg { data: jpeg_data },
    })
}

#[allow(clippy::too_many_arguments)]
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
            let decoded = decode_png_gray(
                bytes,
                DecodeLimits {
                    max_pixels,
                    max_dimension: png.width.max(png.height),
                    max_compressed_bytes: bytes.len(),
                },
            )?;
            (1, Cow::Owned(decoded.into_data()))
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
            let pixels = decoded.into_data();
            if matches!(
                png.color_type,
                PngColorType::Gray8 | PngColorType::GrayAlpha8
            ) {
                (1, Cow::Owned(pixels.into_iter().step_by(3).collect()))
            } else {
                (3, Cow::Owned(pixels))
            }
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
    let preserve_rgb = channels == 3
        && png
            .icc_profile
            .as_deref()
            .is_some_and(|profile| icc_profile_matches_channels(profile, 3));
    let (prepared, _, (data, color_space)) = encode_with_size_guardrail(
        prepared,
        max_pixels,
        quality,
        page_size,
        size_guardrail,
        false,
    )?;
    if use_flate_fallback {
        let flate = encode_prepared_netpbm_as_flate(&prepared, preserve_rgb)?;
        if flate.data.len() < data.len() {
            let (dpi_x, dpi_y) = png_dpi(png.density, default_dpi);
            let icc_profile = png.icc_profile.filter(|profile| {
                icc_profile_matches_channels(profile, color_space_channels(flate.color_space))
            });
            return Ok(ImagePage {
                width: prepared.width,
                height: prepared.height,
                dpi_x,
                dpi_y,
                color_space: flate.color_space,
                icc_profile,
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
        icc_profile: if color_space == "DeviceGray"
            && matches!(
                png.color_type,
                PngColorType::Gray8 | PngColorType::GrayAlpha8
            ) {
            png.icc_profile
                .filter(|profile| icc_profile_matches_channels(profile, 1))
        } else {
            None
        },
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

fn encode_prepared_netpbm_as_flate(
    prepared: &PreparedNetpbmPixels<'_>,
    preserve_rgb: bool,
) -> Result<FlateCandidate> {
    let total_pixels = prepared.width as usize * prepared.height as usize;
    let height = prepared.height as usize;
    let (colors, color_space, data) = if prepared.channels == 1 {
        (
            1,
            "DeviceGray",
            deflate_up_filtered_slices(prepared.pixels.as_ref(), prepared.width as usize, height)?,
        )
    } else if !preserve_rgb && is_rgb_data_grayscale(prepared.pixels.as_ref(), total_pixels) {
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

#[allow(clippy::too_many_arguments)]
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

fn owned_netpbm_data(owned: &OwnedNetpbm) -> NetpbmData<'_> {
    NetpbmData {
        width: owned.width,
        height: owned.height,
        channels: owned.channels,
        pixels: &owned.pixels,
    }
}

#[allow(clippy::too_many_arguments)]
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
    let (prepared, _, (jpeg_data, jpeg_color_space)) = encode_with_size_guardrail(
        prepared,
        max_pixels,
        quality,
        page_size,
        size_guardrail,
        false,
    )?;
    if use_flate_fallback {
        let flate = encode_prepared_netpbm_as_flate(&prepared, false)?;
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

/// JPEG bytes and the PDF colour space they decode to.
type EncodedJpeg = (Vec<u8>, &'static str);

fn encode_rgb_pixels_as_jpeg(
    pixels: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Result<EncodedJpeg> {
    if width == 0 || height == 0 {
        return Err("JPEG dimensions must be non-zero".into());
    }
    let width_u16 =
        u16::try_from(width).map_err(|_| format!("JPEG width is too large to encode: {width}"))?;
    let height_u16 = u16::try_from(height)
        .map_err(|_| format!("JPEG height is too large to encode: {height}"))?;
    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|total_pixels| total_pixels.checked_mul(3))
        .ok_or("JPEG pixel payload size overflow")?;
    if pixels.len() != expected_len {
        return Err(format!(
            "JPEG pixel payload length {} does not match {width}x{height}x3",
            pixels.len()
        )
        .into());
    }
    let mut data = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut data, quality);
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_2_0);
    encoder.encode(pixels, width_u16, height_u16, jpeg_encoder::ColorType::Rgb)?;
    Ok((data, "DeviceRGB"))
}

fn encode_prepared_netpbm_as_jpeg(
    prepared: &PreparedNetpbmPixels<'_>,
    quality: u8,
    preserve_rgb: bool,
) -> Result<EncodedJpeg> {
    if preserve_rgb && prepared.channels == 3 {
        return encode_rgb_pixels_as_jpeg(
            prepared.pixels.as_ref(),
            prepared.width,
            prepared.height,
            quality,
        );
    }
    encode_pixels_as_jpeg(
        prepared.pixels.as_ref(),
        prepared.width,
        prepared.height,
        prepared.channels,
        quality,
    )
}

/// Encodes `prepared` as JPEG. With a guardrail, a page over its size
/// ceiling is encoded again at a lower quality and then downscaled. Returns
/// the pixels and quality of the accepted encoding together with it, so the
/// caller never encodes the same pixels a second time.
fn encode_with_size_guardrail<'a>(
    prepared: PreparedNetpbmPixels<'a>,
    max_pixels: u64,
    quality: u8,
    page_size: Option<PdfPageSize>,
    guardrail: Option<JpegSizeGuardrail>,
    preserve_rgb: bool,
) -> Result<(PreparedNetpbmPixels<'a>, u8, EncodedJpeg)> {
    let encoded = encode_prepared_netpbm_as_jpeg(&prepared, quality, preserve_rgb)?;
    let Some(guardrail) = guardrail else {
        return Ok((prepared, quality, encoded));
    };
    let size_ceiling = jpeg_size_ceiling_bytes(&prepared, encoded.1, page_size);
    if encoded.0.len() <= size_ceiling {
        return Ok((prepared, quality, encoded));
    }

    let mut current_prepared = prepared;
    let mut current_quality = quality;
    let mut current = encoded;

    // Each replacement drops the encoding it replaces before it is made.
    let lower_quality = quality.saturating_sub(10).max(JPEG_GUARDRAIL_QUALITY_FLOOR);
    if lower_quality < quality {
        let replaced_bytes = current.0.len();
        drop(current);
        let lower = encode_prepared_netpbm_as_jpeg(&current_prepared, lower_quality, preserve_rgb)?;
        emit_guardrail_action(
            guardrail,
            "quality",
            &quality.to_string(),
            &lower_quality.to_string(),
            replaced_bytes,
            lower.0.len(),
        );
        current_quality = lower_quality;
        current = lower;
    }

    if current.0.len() > size_ceiling {
        if let Some((next_width, next_height)) = downscale_dimensions_to_effective_ppi(
            &current_prepared,
            page_size,
            JPEG_GUARDRAIL_PPI_CAP,
        ) {
            let from = format!("{}x{}", current_prepared.width, current_prepared.height);
            let replaced_bytes = current.0.len();
            drop(current);
            current_prepared =
                resize_prepared_netpbm(current_prepared, next_width, next_height, max_pixels)?;
            let downscaled =
                encode_prepared_netpbm_as_jpeg(&current_prepared, current_quality, preserve_rgb)?;
            emit_guardrail_action(
                guardrail,
                "downscale",
                &from,
                &format!("{}x{}", current_prepared.width, current_prepared.height),
                replaced_bytes,
                downscaled.0.len(),
            );
            current = downscaled;
        }
    }

    Ok((current_prepared, current_quality, current))
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
        ImageProcessing::BlackAndWhite => {
            Err("Black-and-white processing does not produce JPEG pages".into())
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
    let output = resize_pixels(
        prepared.pixels.as_ref(),
        prepared.width,
        prepared.height,
        prepared.channels,
        next_width,
        next_height,
        max_pixels,
    )?;
    Ok(PreparedNetpbmPixels {
        width: next_width,
        height: next_height,
        channels: prepared.channels,
        pixels: Cow::Owned(output),
    })
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
    use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
    use std::{
        io::{Read, Write},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier, Condvar, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn decode_budget_allows_parallel_decodes_within_byte_limit_and_caps_oversized_concurrency() {
        let budget = crate::PipelineBudget::new(8, 2_048);
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let sync = Arc::new((Mutex::new((0usize, false)), Condvar::new()));

        // Four 512-byte decodes fit inside 2_048 bytes and must all execute concurrently.
        thread::scope(|scope| {
            for seq in 0..4 {
                let budget = &budget;
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                let sync = Arc::clone(&sync);
                scope.spawn(move || {
                    let _guard = budget.reserve_standalone_bytes(seq, 512).unwrap();
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(now, Ordering::SeqCst);
                    {
                        let (lock, cv) = &*sync;
                        let mut state = lock.lock().unwrap();
                        state.0 += 1;
                        if state.0 == 4 {
                            state.1 = true;
                            cv.notify_all();
                        } else {
                            let deadline = Instant::now() + Duration::from_secs(5);
                            while !state.1 {
                                let remaining = deadline.saturating_duration_since(Instant::now());
                                if remaining.is_zero() {
                                    state.1 = true;
                                    cv.notify_all();
                                    break;
                                }
                                let (next_state, wait_res) =
                                    cv.wait_timeout(state, remaining).unwrap();
                                state = next_state;
                                if wait_res.timed_out() && !state.1 {
                                    state.1 = true;
                                    cv.notify_all();
                                    break;
                                }
                            }
                        }
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        assert_eq!(maximum.load(Ordering::SeqCst), 4);

        // Two 1_536-byte decodes exceed 2_048 bytes combined, so at most one runs at a time.
        let capped_budget = crate::PipelineBudget::new(8, 2_048);
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(2));
        thread::scope(|scope| {
            for seq in 0..2 {
                let capped_budget = &capped_budget;
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                let start = Arc::clone(&start);
                scope.spawn(move || {
                    start.wait();
                    let _guard = capped_budget.reserve_standalone_bytes(seq, 1_536).unwrap();
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(now, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(10));
                    active.fetch_sub(1, Ordering::SeqCst);
                    drop(_guard);
                });
            }
        });
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
                vec![255, 42],
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
            assert_eq!(
                page.color_space,
                if expected.len() == 2 {
                    "DeviceGray"
                } else {
                    "DeviceRGB"
                }
            );
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

    #[test]
    fn gray_icc_with_transparency_is_saved_with_one_component() {
        let encoded = encode_png(PixelBuffer::Gray {
            width: 2,
            height: 1,
            stride: 2,
            data: &[0, 42],
        })
        .unwrap();
        let profile = include_bytes!("../tests/fixtures/gray-gamma18.icc");
        let mut compressed = ZlibEncoder::new(Vec::new(), Compression::default());
        compressed.write_all(profile).unwrap();
        let mut iccp = b"Gray\0\0".to_vec();
        iccp.extend(compressed.finish().unwrap());
        let mut png = encoded[..33].to_vec();
        append_test_chunk(&mut png, b"iCCP", &iccp);
        append_test_chunk(&mut png, b"tRNS", b"\0\0");
        png.extend_from_slice(&encoded[33..]);
        let page = read_image_page_from_bytes(
            "gray.png",
            &png,
            &PdfBuildOptions::default(),
            PdfImageCompression::Auto,
            ImageProcessing::None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(page.color_space, "DeviceGray");
        assert_eq!(page.icc_profile.as_deref(), Some(profile.as_slice()));
        let pdf = crate::pdf::build_pdf(&[page]).unwrap();
        assert!(pdf.windows(4).any(|part| part == b"/N 1"));
        assert!(pdf.windows(profile.len()).any(|part| part == profile));
    }

    #[test]
    fn indexed_png_color_key_pixels_composite_to_white_in_the_pdf_writer() {
        let mut scanlines = ZlibEncoder::new(Vec::new(), Compression::default());
        scanlines.write_all(&[0, 0, 1]).unwrap();
        let idat = scanlines.finish().unwrap();
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&2u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 3, 0, 0, 0]);
        append_test_chunk(&mut png, b"IHDR", &ihdr);
        append_test_chunk(&mut png, b"PLTE", &[0, 0, 0, 7, 8, 9]);
        append_test_chunk(&mut png, b"tRNS", &[0, 255]);
        append_test_chunk(&mut png, b"IDAT", &idat);
        append_test_chunk(&mut png, b"IEND", &[]);

        let page = read_image_page_from_bytes(
            "keyed-indexed.png",
            &png,
            &PdfBuildOptions::default(),
            PdfImageCompression::Auto,
            ImageProcessing::None,
            None,
            None,
        )
        .unwrap();
        let ImagePayload::RawFlate { data, .. } = page.payload else {
            panic!("expected composited flate payload")
        };
        let mut decoded = Vec::new();
        ZlibDecoder::new(data.as_slice())
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, [2, 255, 255, 255, 7, 8, 9]);
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

        let (prepared, quality, _) = encode_with_size_guardrail(
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
            false,
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
            encode_prepared_netpbm_as_jpeg(&prepared_100_ppi, 85, false).unwrap();
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

        let (prepared, quality, _) = encode_with_size_guardrail(
            prepared_100_ppi,
            1_000_000,
            85,
            page_size,
            Some(JpegSizeGuardrail {
                page: 1,
                log_json_progress: false,
            }),
            false,
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

        let (prepared, quality, _) = encode_with_size_guardrail(
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
            false,
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

    #[test]
    fn combines_bmp_gif_and_webp_inputs_into_valid_pdf_auto_and_jpeg() {
        use crate::{
            write_pdf, FramePolicy, ImageCompression, ImageSpec, InputSource, PageSpec,
            PdfBuildOptions, PdfPageSpec,
        };
        use image_webp::{ColorType as WebpColorType, WebPEncoder};

        let make_24bit_bmp = |width: u32, height: i32, pixels_bgr: &[u8]| -> Vec<u8> {
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
            out.extend_from_slice(&11811i32.to_le_bytes());
            out.extend_from_slice(&11811i32.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(pixels_bgr);
            out
        };

        let bmp = make_24bit_bmp(
            2,
            2,
            &[
                0, 0, 255, 0, 255, 0, 0, 0, // bottom
                255, 0, 0, 255, 255, 255, 0, 0, // top
            ],
        );
        let mut gif_bytes = Vec::new();
        {
            let palette = [255, 0, 0, 0, 255, 0];
            let mut encoder = gif::Encoder::new(&mut gif_bytes, 2, 2, &palette).unwrap();
            let mut frame = gif::Frame::from_indexed_pixels(2, 2, vec![0, 1, 1, 0], Some(1));
            frame.palette = None;
            encoder.write_frame(&frame).unwrap();
        }
        let mut webp_bytes = Vec::new();
        let rgba = [
            255, 0, 0, 255, 0, 255, 0, 255, // row 0
            0, 0, 255, 128, 255, 255, 255, 0, // row 1
        ];
        WebPEncoder::new(&mut webp_bytes)
            .encode(&rgba, 2, 2, WebpColorType::Rgba8)
            .unwrap();

        for compression in [
            ImageCompression::Auto,
            ImageCompression::Jpeg { quality: 85 },
        ] {
            let specs: Vec<PdfPageSpec<'_>> = vec![
                PageSpec::Image {
                    page_size: None,
                    placement: None,
                    rotation_degrees: 0,
                    image: ImageSpec {
                        source: InputSource::Bytes {
                            file_name: "page1.bmp",
                            data: &bmp,
                        },
                        compression,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    frames: FramePolicy::All,
                },
                PageSpec::Image {
                    page_size: None,
                    placement: None,
                    rotation_degrees: 0,
                    image: ImageSpec {
                        source: InputSource::Bytes {
                            file_name: "page2.gif",
                            data: &gif_bytes,
                        },
                        compression,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    frames: FramePolicy::All,
                },
                PageSpec::Image {
                    page_size: None,
                    placement: None,
                    rotation_degrees: 0,
                    image: ImageSpec {
                        source: InputSource::Bytes {
                            file_name: "page3.webp",
                            data: &webp_bytes,
                        },
                        compression,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    frames: FramePolicy::All,
                },
            ];

            let pdf = write_pdf(Vec::new(), specs, &PdfBuildOptions::default(), |_| {}).unwrap();
            let text = String::from_utf8_lossy(&pdf);
            assert!(pdf.starts_with(b"%PDF-"), "missing PDF header");
            assert!(text.contains("/Count 3"), "expected 3 pages in PDF");
            match compression {
                ImageCompression::Auto => assert!(text.contains("/Filter /FlateDecode")),
                ImageCompression::Jpeg { .. } => assert!(text.contains("/Filter /DCTDecode")),
                ImageCompression::JpegWithFlateFallback { .. } => {}
            }
        }
    }

    fn synthetic_icc_profile(color_space: &[u8; 4], total_len: usize) -> Vec<u8> {
        let len = total_len.max(128);
        let mut profile = vec![0u8; len];
        profile[0..4].copy_from_slice(&(len as u32).to_be_bytes());
        profile[16..20].copy_from_slice(color_space);
        profile[36..40].copy_from_slice(b"acsp");
        profile
    }

    fn wrap_vp8l_webp_with_icc(
        vp8l_webp: &[u8],
        width: u32,
        height: u32,
        has_alpha: bool,
        icc_profile: &[u8],
    ) -> Vec<u8> {
        assert_eq!(&vp8l_webp[0..4], b"RIFF");
        assert_eq!(&vp8l_webp[8..12], b"WEBP");
        assert_eq!(&vp8l_webp[12..16], b"VP8L");
        let vp8l_chunk = &vp8l_webp[12..];

        let mut body = Vec::new();
        body.extend_from_slice(b"WEBP");

        // VP8X chunk (10 bytes payload)
        body.extend_from_slice(b"VP8X");
        body.extend_from_slice(&10u32.to_le_bytes());
        let mut flags = 0b0010_0000u8; // ICC profile flag
        if has_alpha {
            flags |= 0b0001_0000;
        }
        body.push(flags);
        body.extend_from_slice(&[0u8; 3]);
        let w_minus_1 = width - 1;
        let h_minus_1 = height - 1;
        body.extend_from_slice(&[
            (w_minus_1 & 0xff) as u8,
            ((w_minus_1 >> 8) & 0xff) as u8,
            ((w_minus_1 >> 16) & 0xff) as u8,
        ]);
        body.extend_from_slice(&[
            (h_minus_1 & 0xff) as u8,
            ((h_minus_1 >> 8) & 0xff) as u8,
            ((h_minus_1 >> 16) & 0xff) as u8,
        ]);

        // ICCP chunk
        body.extend_from_slice(b"ICCP");
        body.extend_from_slice(&(icc_profile.len() as u32).to_le_bytes());
        body.extend_from_slice(icc_profile);
        if icc_profile.len() % 2 == 1 {
            body.push(0);
        }

        // Original VP8L chunk
        body.extend_from_slice(vp8l_chunk);
        if vp8l_chunk.len() % 2 == 1 {
            body.push(0);
        }

        let mut out = Vec::with_capacity(8 + body.len());
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn equal_channel_rgb_webp_with_rgb_icc_preserves_rgb_across_jpeg_flate_and_auto() {
        use image_webp::{ColorType as WebpColorType, WebPEncoder};

        let width = 32u32;
        let height = 32u32;
        let equal_channel_rgb = vec![128u8; (width * height * 3) as usize];
        let mut plain_webp = Vec::new();
        WebPEncoder::new(&mut plain_webp)
            .encode(&equal_channel_rgb, width, height, WebpColorType::Rgb8)
            .unwrap();

        let rgb_icc = synthetic_icc_profile(b"RGB ", 256);
        let icc_webp = wrap_vp8l_webp_with_icc(&plain_webp, width, height, false, &rgb_icc);

        // 1. JPEG recompression must keep 3-channel RGB and emit /N 3.
        let jpeg_page = read_image_page_from_bytes(
            "gray-rgb-icc.webp",
            &icc_webp,
            &PdfBuildOptions::default(),
            PdfImageCompression::Jpeg { quality: 85 },
            ImageProcessing::None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(jpeg_page.color_space, "DeviceRGB");
        assert_eq!(jpeg_page.icc_profile.as_deref(), Some(rgb_icc.as_slice()));
        let ImagePayload::Jpeg { ref data } = jpeg_page.payload else {
            panic!("expected JPEG payload");
        };
        assert_eq!(parse_jpeg_metadata(data).unwrap().components, 3);
        let jpeg_pdf = crate::pdf::build_pdf(&[jpeg_page]).unwrap();
        let jpeg_pdf_text = String::from_utf8_lossy(&jpeg_pdf);
        assert!(jpeg_pdf_text.contains("/N 3 /Alternate /DeviceRGB"));
        assert!(!jpeg_pdf_text.contains("/N 1"));

        // 2. JpegWithFlateFallback picks Flate for uniform gray pixels; must also keep 3-channel RGB.
        let flate_page = read_image_page_from_bytes(
            "gray-rgb-icc.webp",
            &icc_webp,
            &PdfBuildOptions::default(),
            PdfImageCompression::JpegWithFlateFallback { quality: 85 },
            ImageProcessing::None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(flate_page.color_space, "DeviceRGB");
        assert_eq!(flate_page.icc_profile.as_deref(), Some(rgb_icc.as_slice()));
        let ImagePayload::RawFlate {
            ref decode_params, ..
        } = flate_page.payload
        else {
            panic!("expected Flate fallback payload for uniform image");
        };
        assert!(decode_params.contains("/Colors 3"));
        let flate_pdf = crate::pdf::build_pdf(&[flate_page]).unwrap();
        let flate_pdf_text = String::from_utf8_lossy(&flate_pdf);
        assert!(flate_pdf_text.contains("/N 3 /Alternate /DeviceRGB"));
        assert!(!flate_pdf_text.contains("/N 1"));

        // 3. Incompatible (CMYK) or truncated ICC payloads must be stripped instead of written.
        let cmyk_icc = synthetic_icc_profile(b"CMYK", 256);
        let mut truncated_20_icc = vec![0u8; 20];
        truncated_20_icc[16..20].copy_from_slice(b"RGB ");
        let mut truncated_declared_icc = synthetic_icc_profile(b"RGB ", 128);
        truncated_declared_icc[0..4].copy_from_slice(&512u32.to_be_bytes());
        for bad_icc in [cmyk_icc, truncated_20_icc, truncated_declared_icc] {
            let bad_icc_webp = wrap_vp8l_webp_with_icc(&plain_webp, width, height, false, &bad_icc);
            for compression in [
                PdfImageCompression::Auto,
                PdfImageCompression::Jpeg { quality: 85 },
                PdfImageCompression::JpegWithFlateFallback { quality: 85 },
            ] {
                let page = read_image_page_from_bytes(
                    "gray-bad-icc.webp",
                    &bad_icc_webp,
                    &PdfBuildOptions::default(),
                    compression,
                    ImageProcessing::None,
                    None,
                    None,
                )
                .unwrap();
                assert!(
                    page.icc_profile.is_none(),
                    "invalid or incompatible ICC profile should be stripped"
                );
                let pdf = crate::pdf::build_pdf(&[page]).unwrap();
                assert!(!String::from_utf8_lossy(&pdf).contains("/ICCBased"));
            }
        }
    }

    #[test]
    fn rejects_vp8x_webp_whose_vp8_frame_dimensions_exceed_canvas_before_decoding() {
        // Construct a VP8X still claiming a 1x1 canvas whose VP8 keyframe header claims 16383x16383.
        let mut body = Vec::new();
        body.extend_from_slice(b"WEBP");
        body.extend_from_slice(b"VP8X");
        body.extend_from_slice(&10u32.to_le_bytes());
        body.push(0); // flags
        body.extend_from_slice(&[0u8; 3]); // reserved
        body.extend_from_slice(&[0, 0, 0]); // canvas width - 1 = 0 => 1
        body.extend_from_slice(&[0, 0, 0]); // canvas height - 1 = 0 => 1
        body.extend_from_slice(b"VP8 ");
        let vp8_payload: [u8; 10] = [
            0x10, 0x00, 0x00, // keyframe tag (bit 0 == 0)
            0x9d, 0x01, 0x2a, // VP8 start code
            0xff, 0x3f, // width = 16383
            0xff, 0x3f, // height = 16383
        ];
        body.extend_from_slice(&(vp8_payload.len() as u32).to_le_bytes());
        body.extend_from_slice(&vp8_payload);
        let mut webp_bomb = Vec::with_capacity(8 + body.len());
        webp_bomb.extend_from_slice(b"RIFF");
        webp_bomb.extend_from_slice(&(body.len() as u32).to_le_bytes());
        webp_bomb.extend_from_slice(&body);

        let err = read_image_page_from_bytes(
            "mismatch.webp",
            &webp_bomb,
            &PdfBuildOptions::default(),
            PdfImageCompression::Auto,
            ImageProcessing::None,
            None,
            None,
        )
        .err()
        .expect("mismatched VP8X/VP8 dimensions must be rejected before decoding");
        assert!(
            err.to_string().contains("do not match VP8X canvas"),
            "unexpected error: {err}"
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn wide_gif_jpeg_and_commented_gif_reservations_cover_row_buffers_and_extensions() {
        let max_pixels = 10_000_000u64;

        // 16383x1 red GIF in JPEG mode: 3 Bpp RGB raster + JPEG output + 3 padded 16-row buffers.
        let width = 16_383u16;
        let mut wide_gif = Vec::new();
        {
            let palette = [255, 0, 0];
            let mut encoder = gif::Encoder::new(&mut wide_gif, width, 1, &palette).unwrap();
            let frame = gif::Frame::from_indexed_pixels(width, 1, vec![0u8; width as usize], None);
            encoder.write_frame(&frame).unwrap();
        }
        let wide_jpeg = estimate_image_bytes_decode_bytes(
            "gif",
            &wide_gif,
            PdfImageCompression::Jpeg { quality: 85 },
            max_pixels,
        );
        let rgb_bytes = u64::from(width) * 3;
        let row_buffers = 16_384u64 * 16 * 3;
        assert!(
            wide_jpeg >= rgb_bytes + row_buffers + rgb_bytes,
            "wide_jpeg={wide_jpeg} must cover RGB raster + padded row buffers + JPEG output"
        );

        // 1x1 GIF with a 300 KiB comment extension before frame 0 is admitted and decoded.
        let mut commented_gif = Vec::new();
        {
            let palette = [10, 20, 30];
            let mut encoder = gif::Encoder::new(&mut commented_gif, 1, 1, &palette).unwrap();
            let comment = vec![b'A'; 300 * 1024];
            encoder
                .write_raw_extension(
                    gif::AnyExtension(gif::Extension::Comment as u8),
                    &[&comment],
                )
                .unwrap();
            let frame = gif::Frame::from_indexed_pixels(1, 1, vec![0], None);
            encoder.write_frame(&frame).unwrap();
        }
        let comment_est = estimate_image_bytes_decode_bytes(
            "gif",
            &commented_gif,
            PdfImageCompression::Jpeg { quality: 85 },
            max_pixels,
        );
        assert!(
            comment_est >= 300 * 1024,
            "comment_est={comment_est} must cover 300 KiB buffered GIF comment"
        );
        let page = read_image_page_from_bytes(
            "commented.gif",
            &commented_gif,
            &PdfBuildOptions::default(),
            PdfImageCompression::Auto,
            ImageProcessing::None,
            None,
            None,
        )
        .unwrap();
        assert_eq!((page.width, page.height), (1, 1));
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn gif_and_webp_memory_reservations_cover_decode_icc_and_encoder_buffers() {
        use image_webp::{ColorType as WebpColorType, WebPEncoder};

        let width = 64u32;
        let height = 64u32;
        let pixels = u64::from(width) * u64::from(height);
        let max_pixels = 10_000_000u64;

        let mut gif_bytes = Vec::new();
        {
            let palette = [255, 0, 0, 0, 255, 0];
            let mut encoder =
                gif::Encoder::new(&mut gif_bytes, width as u16, height as u16, &palette).unwrap();
            let mut frame = gif::Frame::from_indexed_pixels(
                width as u16,
                height as u16,
                vec![0u8; pixels as usize],
                Some(1),
            );
            frame.palette = None;
            encoder.write_frame(&frame).unwrap();
        }

        let mut opaque_webp = Vec::new();
        WebPEncoder::new(&mut opaque_webp)
            .encode(
                &vec![120u8; (pixels * 3) as usize],
                width,
                height,
                WebpColorType::Rgb8,
            )
            .unwrap();

        let icc_len = 64 * 1024usize;
        let rgb_icc = synthetic_icc_profile(b"RGB ", icc_len);
        let icc_webp = wrap_vp8l_webp_with_icc(&opaque_webp, width, height, false, &rgb_icc);

        let flate_work =
            estimate_up_filtered_flate_working_set_bytes(u64::from(width) * 3, u64::from(height));

        // GIF: Auto covers RGB canvas + Flate working set; Jpeg covers RGB canvas + encoder output.
        let gif_auto = estimate_image_bytes_decode_bytes(
            "gif",
            &gif_bytes,
            PdfImageCompression::Auto,
            max_pixels,
        );
        let gif_jpeg = estimate_image_bytes_decode_bytes(
            "gif",
            &gif_bytes,
            PdfImageCompression::Jpeg { quality: 85 },
            max_pixels,
        );
        let gif_fallback = estimate_image_bytes_decode_bytes(
            "gif",
            &gif_bytes,
            PdfImageCompression::JpegWithFlateFallback { quality: 85 },
            max_pixels,
        );
        assert!(gif_auto >= pixels * 3 + flate_work, "gif_auto={gif_auto}");
        assert!(gif_jpeg >= pixels * 6, "gif_jpeg={gif_jpeg}");
        assert!(
            gif_fallback >= pixels * 6 + flate_work,
            "gif_fallback={gif_fallback}"
        );

        // Opaque lossless WebP: holds 3 B/px output + 4 B/px RGBA decoder buffer (7+ B/px).
        let webp_jpeg = estimate_image_bytes_decode_bytes(
            "webp",
            &opaque_webp,
            PdfImageCompression::Jpeg { quality: 85 },
            max_pixels,
        );
        assert!(
            webp_jpeg >= pixels * 7,
            "opaque lossless WebP must reserve >= 7 B/px, got {webp_jpeg}"
        );

        // WebP with ICC profile must include the retained ICC bytes on every compression mode.
        let icc_webp_jpeg = estimate_image_bytes_decode_bytes(
            "webp",
            &icc_webp,
            PdfImageCompression::Jpeg { quality: 85 },
            max_pixels,
        );
        let icc_webp_auto = estimate_image_bytes_decode_bytes(
            "webp",
            &icc_webp,
            PdfImageCompression::Auto,
            max_pixels,
        );
        let icc_webp_fallback = estimate_image_bytes_decode_bytes(
            "webp",
            &icc_webp,
            PdfImageCompression::JpegWithFlateFallback { quality: 85 },
            max_pixels,
        );
        assert_eq!(
            icc_webp_jpeg,
            webp_jpeg + icc_len as u64,
            "WebP ICC bytes must be added to JPEG reservation"
        );
        assert!(
            icc_webp_auto >= pixels * 3 + icc_len as u64 + flate_work,
            "icc_webp_auto={icc_webp_auto}"
        );
        assert!(
            icc_webp_fallback >= pixels * 6 + icc_len as u64 + flate_work,
            "icc_webp_fallback={icc_webp_fallback}"
        );

        // Alpha lossless WebP reserves 4 B/px RGBA + transform scratch (and >= 6 B/px for JPEG encode).
        let mut alpha_webp = Vec::new();
        WebPEncoder::new(&mut alpha_webp)
            .encode(
                &vec![120u8; (pixels * 4) as usize],
                width,
                height,
                WebpColorType::Rgba8,
            )
            .unwrap();
        let alpha_webp_jpeg = estimate_image_bytes_decode_bytes(
            "webp",
            &alpha_webp,
            PdfImageCompression::Jpeg { quality: 85 },
            max_pixels,
        );
        assert!(
            alpha_webp_jpeg >= pixels * 6,
            "alpha lossless WebP must cover RGB + JPEG encode, got {alpha_webp_jpeg}"
        );
        assert!(
            webp_jpeg > alpha_webp_jpeg,
            "opaque lossless WebP ({webp_jpeg}) must reserve more than alpha lossless WebP ({alpha_webp_jpeg}) due to internal 4 B/px RGBA buffer"
        );

        // Oversized WebP ICC (>16 MiB) is ignored by `decode_webp` and must not inflate reservation.
        let mut oversized_icc_webp = Vec::new();
        {
            let vp8l_chunk = &opaque_webp[12..];
            let mut body = Vec::new();
            body.extend_from_slice(b"WEBP");
            body.extend_from_slice(b"VP8X");
            body.extend_from_slice(&10u32.to_le_bytes());
            body.push(0b0010_0000);
            body.extend_from_slice(&[0u8; 3]);
            let w_minus_1 = width - 1;
            let h_minus_1 = height - 1;
            body.extend_from_slice(&[
                (w_minus_1 & 0xff) as u8,
                ((w_minus_1 >> 8) & 0xff) as u8,
                ((w_minus_1 >> 16) & 0xff) as u8,
                (h_minus_1 & 0xff) as u8,
                ((h_minus_1 >> 8) & 0xff) as u8,
                ((h_minus_1 >> 16) & 0xff) as u8,
            ]);
            body.extend_from_slice(b"ICCP");
            let oversized = (MAX_WEBP_ICC_PROFILE_BYTES + 2) as u32;
            body.extend_from_slice(&oversized.to_le_bytes());
            body.resize(body.len() + oversized as usize, 0);
            body.extend_from_slice(vp8l_chunk);
            if vp8l_chunk.len() % 2 == 1 {
                body.push(0);
            }
            oversized_icc_webp.extend_from_slice(b"RIFF");
            oversized_icc_webp.extend_from_slice(&(body.len() as u32).to_le_bytes());
            oversized_icc_webp.extend_from_slice(&body);
        }
        assert_eq!(
            estimate_image_bytes_decode_bytes(
                "webp",
                &oversized_icc_webp,
                PdfImageCompression::Jpeg { quality: 85 },
                max_pixels,
            ),
            webp_jpeg
        );

        // Budget enforcement: both GIF and opaque lossless WebP serialize under a cap below
        // 2x their true peak (even though the old 4 B/px estimate would have admitted both).
        for reservation in [gif_auto, icc_webp_jpeg] {
            let two_old_estimates = pixels * 4 * 2;
            let tight_cap = (reservation + 1024).max(two_old_estimates + 1024);
            assert!(
                tight_cap < reservation * 2,
                "tight_cap={tight_cap} must be < 2 * reservation ({})",
                reservation * 2
            );
            let budget = crate::PipelineBudget::new(4, tight_cap);
            let active = Arc::new(AtomicUsize::new(0));
            let max_active = Arc::new(AtomicUsize::new(0));
            let start = Arc::new(Barrier::new(2));
            thread::scope(|scope| {
                for seq in 0..2 {
                    let budget = &budget;
                    let active = Arc::clone(&active);
                    let max_active = Arc::clone(&max_active);
                    let start = Arc::clone(&start);
                    scope.spawn(move || {
                        start.wait();
                        let _guard = budget.reserve_standalone_bytes(seq, reservation).unwrap();
                        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                        max_active.fetch_max(now, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(10));
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            });
            assert_eq!(max_active.load(Ordering::SeqCst), 1);
        }
    }
}
