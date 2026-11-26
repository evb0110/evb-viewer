use std::{
    fs::File,
    io::{BufRead, BufReader, Cursor, Read, Seek, SeekFrom},
};

use tiff::{
    decoder::{ifd::Value as TiffIfdValue, ChunkType, Decoder, DecodingResult},
    tags::Tag,
    ColorType as TiffColorType,
};

use evb_image_codecs::{
    ccitt::{decode_g3_rows, decode_g4_rows, decode_modified_huffman_rows},
    CM_PER_INCH,
};

use crate::{
    bilevel_image_page,
    flate::deflate_up_filtered_slices,
    image::assert_pixel_limit,
    netpbm::PbmP4Image,
    pdf::{ImagePage, ImagePayload},
    Result, DEFAULT_DPI,
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
    visit_tiff_pdf_pages_from_bytes_budgeted(
        bytes,
        max_pixels,
        default_dpi,
        max_tiff_frames,
        None,
        on_page,
    )
}

#[cfg(not(target_family = "wasm"))]
pub(crate) enum TiffBudget<'a, 'b> {
    Standalone(&'a crate::PipelineBudget, usize),
    /// Page-scoped reservation used by `FramePolicy::ExactlyOne`, which retains
    /// frame 0's encoded payload across subsequent frame counting.
    Page(&'b mut crate::PageBytesReservation<'a>),
    /// Page-scoped reservation used by streamed `InputSource::Bytes`
    /// (`FramePolicy::All`), which keeps source bytes reserved across frames
    /// and shrinks back to that base after every frame is written.
    StreamedPage(&'b mut crate::PageBytesReservation<'a>),
}

#[cfg(target_family = "wasm")]
pub(crate) enum TiffBudget<'a, 'b> {
    #[allow(dead_code)]
    _Wasm(std::marker::PhantomData<(&'a (), &'b ())>),
}

pub(crate) fn visit_tiff_pdf_pages_from_bytes_budgeted(
    bytes: &[u8],
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    budget: Option<TiffBudget<'_, '_>>,
    on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    visit_tiff_pdf_pages_from_reader(
        Cursor::new(bytes),
        "in-memory TIFF",
        max_pixels,
        default_dpi,
        max_tiff_frames,
        budget,
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

#[cfg(test)]
pub(crate) fn visit_tiff_pdf_pages_from_file(
    file: File,
    source_label: &str,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    visit_tiff_pdf_pages_from_file_budgeted(
        file,
        source_label,
        max_pixels,
        default_dpi,
        max_tiff_frames,
        None,
        on_page,
    )
}

pub(crate) fn visit_tiff_pdf_pages_from_file_budgeted(
    file: File,
    source_label: &str,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    budget: Option<TiffBudget<'_, '_>>,
    on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    visit_tiff_pdf_pages_from_reader(
        file,
        source_label,
        max_pixels,
        default_dpi,
        max_tiff_frames,
        budget,
        on_page,
    )
}

/// `flate2::zio::Writer::new` (`flate2 1.1.10`) allocates a dedicated 32 KiB
/// staging buffer alongside the output `Vec<u8>`.
#[cfg(not(target_family = "wasm"))]
const FLATE_WRITER_STAGING_BYTES: u64 = 32 * 1024;
/// Pinned `zlib-rs` deflate backend state allocated at `ZlibEncoder`
/// construction (~379,968 bytes across compression levels, rounded up with
/// headroom).
#[cfg(not(target_family = "wasm"))]
const FLATE_BACKEND_STATE_BYTES: u64 = 384 * 1024;
/// Combined fixed heap allocation of a live `flate2::write::ZlibEncoder`
/// (`32 KiB` staging buffer + `384 KiB` `zlib-rs` backend state = `416 KiB`).
#[cfg(not(target_family = "wasm"))]
const FLATE_ENCODER_FIXED_OVERHEAD_BYTES: u64 =
    FLATE_WRITER_STAGING_BYTES + FLATE_BACKEND_STATE_BYTES;

/// Peak heap `deflate_up_filtered_slices` holds beyond its source raster
/// while encoding `rows` rows of `bytes_per_row` bytes: the filter-row scratch
/// buffer (`bytes_per_row + 1`), the live `flate2` + `zlib-rs` encoder
/// (`FLATE_ENCODER_FIXED_OVERHEAD_BYTES`), and the output `Vec<u8>`, which
/// grows by doubling up to twice the worst-case stream before `finish()` and
/// `shrink_to_fit()`.
#[cfg(not(target_family = "wasm"))]
pub(crate) fn estimate_up_filtered_flate_working_set_bytes(bytes_per_row: u64, rows: u64) -> u64 {
    // Each row carries one predictor byte.
    let flate_input_bytes = bytes_per_row.saturating_mul(rows).saturating_add(rows);
    let encoded_upper =
        flate_input_bytes.saturating_add(flate_worst_case_overhead(flate_input_bytes));
    bytes_per_row
        .saturating_add(1)
        .saturating_add(FLATE_ENCODER_FIXED_OVERHEAD_BYTES)
        .saturating_add(encoded_upper.saturating_mul(2))
}

#[cfg(not(target_family = "wasm"))]
fn flate_worst_case_overhead(raw_bytes: u64) -> u64 {
    // RFC 1950 zlib header/trailer (6 bytes) + RFC 1951 stored-block framing
    // (5 bytes per 65,535-byte block; conservatively per 16 KiB) + margin.
    raw_bytes
        .div_ceil(16_384)
        .saturating_mul(5)
        .saturating_add(64)
}

#[cfg(not(target_family = "wasm"))]
fn estimate_tiff_frame_decode_bytes(
    width: u32,
    height: u32,
    color_type: TiffColorType,
    orientation: u16,
) -> u64 {
    if color_type == TiffColorType::Gray(1) {
        let src_bytes = u64::from(width)
            .div_ceil(8)
            .saturating_mul(u64::from(height));
        return if orientation != 1 {
            let (oriented_width, oriented_height) = if swaps_tiff_axes(orientation) {
                (height, width)
            } else {
                (width, height)
            };
            let dst_bytes = u64::from(oriented_width)
                .div_ceil(8)
                .saturating_mul(u64::from(oriented_height));
            src_bytes.saturating_add(dst_bytes)
        } else {
            src_bytes
        };
    }

    let base_bytes = match color_type {
        TiffColorType::Gray(8) => u64::from(width).saturating_mul(u64::from(height)),
        TiffColorType::GrayA(8) => u64::from(width)
            .saturating_mul(u64::from(height))
            .saturating_mul(2),
        TiffColorType::RGB(8) => u64::from(width)
            .saturating_mul(u64::from(height))
            .saturating_mul(3),
        TiffColorType::RGBA(8) => u64::from(width)
            .saturating_mul(u64::from(height))
            .saturating_mul(4),
        _ => u64::from(width)
            .saturating_mul(u64::from(height))
            .saturating_mul(4),
    };
    if orientation != 1 {
        base_bytes.saturating_mul(2)
    } else {
        base_bytes
    }
}

/// Independent upper bound on the retained PDF stream bytes emitted for one
/// TIFF frame (including 1 predictor byte per row plus worst-case Flate framing
/// for 8-bit rasters, and worst-case Flate framing for bilevel streams).
#[cfg(not(target_family = "wasm"))]
pub(crate) fn estimate_tiff_pdf_encoded_stream_upper_bound(
    width: u32,
    height: u32,
    color_type: TiffColorType,
    orientation: u16,
) -> u64 {
    let (oriented_width, oriented_height) = if swaps_tiff_axes(orientation) {
        (height, width)
    } else {
        (width, height)
    };
    match color_type {
        TiffColorType::Gray(1) => {
            let bitmap_bytes = u64::from(oriented_width)
                .div_ceil(8)
                .saturating_mul(u64::from(oriented_height));
            // `BilevelStream::encode` keeps the smallest of Flate, CCITT G4,
            // and JBIG2, so the retained stream is bounded by worst-case Flate.
            bitmap_bytes.saturating_add(flate_worst_case_overhead(bitmap_bytes))
        }
        TiffColorType::Gray(8) | TiffColorType::RGB(8) => {
            let colors = if color_type == TiffColorType::Gray(8) {
                1u64
            } else {
                3u64
            };
            let raw_bytes = u64::from(oriented_width)
                .saturating_mul(u64::from(oriented_height))
                .saturating_mul(colors);
            // `deflate_up_filtered_slices` prefixes each row with 1 predictor byte.
            let flate_input_bytes = raw_bytes.saturating_add(u64::from(oriented_height));
            flate_input_bytes.saturating_add(flate_worst_case_overhead(flate_input_bytes))
        }
        _ => estimate_tiff_frame_decode_bytes(width, height, color_type, orientation),
    }
}

/// Estimates the peak working memory while decoding, orienting, and encoding a
/// TIFF frame into its PDF image stream (where the decoded raster, filter-row
/// scratch buffer, and worst-case encoded Flate/CCITT/JBIG2 stream coexist
/// before the raster drops).
#[cfg(not(target_family = "wasm"))]
pub(crate) fn estimate_tiff_pdf_frame_peak_bytes(
    width: u32,
    height: u32,
    color_type: TiffColorType,
    orientation: u16,
) -> u64 {
    let decode_bytes = estimate_tiff_frame_decode_bytes(width, height, color_type, orientation);
    let encoded_upper =
        estimate_tiff_pdf_encoded_stream_upper_bound(width, height, color_type, orientation);
    let (oriented_width, oriented_height) = if swaps_tiff_axes(orientation) {
        (height, width)
    } else {
        (width, height)
    };
    match color_type {
        TiffColorType::Gray(1) => {
            let src_bitmap_bytes = u64::from(width)
                .div_ceil(8)
                .saturating_mul(u64::from(height));
            let dst_bitmap_bytes = u64::from(oriented_width)
                .div_ceil(8)
                .saturating_mul(u64::from(oriented_height));
            let orientation_phase_peak = if orientation != 1 {
                src_bitmap_bytes.saturating_add(dst_bitmap_bytes)
            } else {
                src_bitmap_bytes
            };

            // During `encode_mask_payload` (`pdf.rs`), the three candidate
            // encoders run sequentially while earlier candidates' outputs stay
            // live alongside `mask.bitmap` (`dst_bitmap_bytes`):
            // 1. JBIG2: `mask.bitmap` + encoded candidate + verification bitmap.
            // 2. Flate: `mask.bitmap` + retained JBIG2 +
            //    `FLATE_ENCODER_FIXED_OVERHEAD_BYTES` (32 KiB `flate2`
            //    staging buffer + 384 KiB `zlib-rs` backend state) +
            //    growing Flate output `Vec<u8>`.
            // 3. CCITT Group 4 (when `oriented_width <= u16::MAX`):
            //    `mask.bitmap` + retained JBIG2 + retained shrunk Flate +
            //    `fax::Encoder`'s two `Vec<u32>` transition buffers +
            //    `VecWriter` output `Vec<u8>` (including doubling capacity).
            let jbig2_retained_upper = dst_bitmap_bytes.saturating_mul(2).saturating_add(256);
            let jbig2_subphase_peak = dst_bitmap_bytes
                .saturating_mul(2)
                .saturating_add(jbig2_retained_upper);

            let flate_subphase_peak = dst_bitmap_bytes
                .saturating_add(jbig2_retained_upper)
                .saturating_add(FLATE_ENCODER_FIXED_OVERHEAD_BYTES)
                .saturating_add(encoded_upper.saturating_mul(2));

            let ccitt_subphase_peak = if oriented_width <= u32::from(u16::MAX) {
                let transition_vec_bytes = u64::from(oriented_width)
                    .max(1)
                    .next_power_of_two()
                    .max(4)
                    .saturating_mul(4)
                    .saturating_mul(2);
                let ccitt_initial_bytes = (dst_bitmap_bytes / 4).max(4_096).div_ceil(8);
                let ccitt_worst_len = dst_bitmap_bytes
                    .saturating_mul(7)
                    .saturating_add(u64::from(oriented_height).saturating_mul(2))
                    .saturating_add(4);
                let ccitt_output_cap = ccitt_worst_len.saturating_mul(2).max(ccitt_initial_bytes);
                dst_bitmap_bytes
                    .saturating_add(jbig2_retained_upper)
                    .saturating_add(encoded_upper)
                    .saturating_add(transition_vec_bytes)
                    .saturating_add(ccitt_output_cap)
            } else {
                0
            };

            let encoding_phase_peak = jbig2_subphase_peak
                .max(flate_subphase_peak)
                .max(ccitt_subphase_peak);

            orientation_phase_peak.max(encoding_phase_peak)
        }
        TiffColorType::Gray(8) | TiffColorType::RGB(8) => {
            let colors = if color_type == TiffColorType::Gray(8) {
                1u64
            } else {
                3u64
            };
            let bytes_per_row = u64::from(oriented_width).saturating_mul(colors);
            let raw_bytes = bytes_per_row.saturating_mul(u64::from(oriented_height));
            // The oriented raster stays live while it is Flate-encoded.
            let encode_peak =
                raw_bytes.saturating_add(estimate_up_filtered_flate_working_set_bytes(
                    bytes_per_row,
                    u64::from(oriented_height),
                ));
            decode_bytes.max(encode_peak)
        }
        _ => decode_bytes,
    }
}

/// Estimates peak working memory while encoding a bilevel bitmap (`PbmP4Image`)
/// through `BilevelStream::encode` (JBIG2, Flate, and CCITT Group 4 candidates).
#[cfg(not(target_family = "wasm"))]
pub(crate) fn estimate_bilevel_encode_peak_bytes(width: u32, height: u32) -> u64 {
    estimate_tiff_pdf_frame_peak_bytes(width, height, TiffColorType::Gray(1), 1)
}

/// Fast metadata-only IFD probe for byte-backed TIFFs so ordered admission can
/// reserve peak decode+encode memory and release the admission turn before
/// running raster decoding and Flate encoding in parallel.
#[cfg(not(target_family = "wasm"))]
pub(crate) fn probe_tiff_pdf_peak_bytes_from_bytes(
    bytes: &[u8],
    max_pixels: u64,
    max_tiff_frames: usize,
) -> u64 {
    let Ok(mut decoder) = Decoder::new(BufReader::new(Cursor::new(bytes))) else {
        return 0;
    };
    let mut peak = 0u64;
    let mut first_retained_upper = 0u64;
    let mut frame_count = 0usize;
    loop {
        if frame_count >= max_tiff_frames {
            break;
        }
        let Ok((width, height)) = decoder.dimensions() else {
            break;
        };
        if assert_pixel_limit(width, height, max_pixels).is_err() {
            break;
        }
        let orientation = read_tiff_orientation(&mut decoder);
        let Ok(color_type) = decoder.colortype() else {
            break;
        };
        let frame_peak = estimate_tiff_pdf_frame_peak_bytes(width, height, color_type, orientation);
        if frame_count == 0 {
            peak = frame_peak;
            first_retained_upper = estimate_tiff_pdf_encoded_stream_upper_bound(
                width,
                height,
                color_type,
                orientation,
            );
        } else {
            // While counting subsequent frames in ExactlyOne mode, frame 0's
            // compressed ImagePage remains retained alongside the next frame.
            peak = peak.max(first_retained_upper.saturating_add(frame_peak));
        }
        frame_count += 1;
        if !decoder.more_images() || decoder.next_image().is_err() {
            break;
        }
    }
    peak
}

fn visit_tiff_pdf_pages_from_reader<R: Read + Seek>(
    reader: R,
    source_label: &str,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
    #[cfg_attr(target_family = "wasm", allow(unused_variables, unused_mut))] mut budget: Option<
        TiffBudget<'_, '_>,
    >,
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
        let (dpi_x, dpi_y) = read_tiff_dpi_axes(&mut decoder)
            .unwrap_or_else(|| default_dpi.map_or((DEFAULT_DPI, DEFAULT_DPI), |dpi| (dpi, dpi)));
        let color_type = decoder.colortype()?;
        ensure_tiff_pdf_sample_type(&mut decoder, color_type)?;
        #[cfg(not(target_family = "wasm"))]
        let (mut standalone_reservation, page_base_bytes) = {
            let estimated =
                estimate_tiff_pdf_frame_peak_bytes(width, height, color_type, orientation);
            match budget.as_mut() {
                Some(TiffBudget::Standalone(pipeline_budget, seq)) => (
                    Some(pipeline_budget.reserve_standalone_bytes(*seq, estimated)?),
                    None,
                ),
                Some(TiffBudget::Page(reservation) | TiffBudget::StreamedPage(reservation)) => {
                    let base = reservation.held_bytes();
                    reservation.reserve_additional(estimated)?;
                    (None, Some(base))
                }
                None => (None, None),
            }
        };
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
        #[cfg(not(target_family = "wasm"))]
        let page_payload_bytes = page.payload_bytes();
        #[cfg(not(target_family = "wasm"))]
        if let Some(reservation) = standalone_reservation.as_mut() {
            reservation.shrink_to(page_payload_bytes);
        } else if let (
            Some(base),
            Some(TiffBudget::Page(reservation) | TiffBudget::StreamedPage(reservation)),
        ) = (page_base_bytes, budget.as_mut())
        {
            reservation.shrink_to(base.saturating_add(page_payload_bytes));
        }
        on_page(page)?;
        #[cfg(not(target_family = "wasm"))]
        drop(standalone_reservation);
        #[cfg(not(target_family = "wasm"))]
        match (page_base_bytes, budget.as_mut()) {
            (Some(base), Some(TiffBudget::Page(reservation))) => {
                // Keep only the first frame's payload accounted if caller retained
                // it; subsequent frames are immediately discarded after counting.
                if page_count > 0 {
                    reservation.shrink_to(base);
                }
            }
            (Some(base), Some(TiffBudget::StreamedPage(reservation))) => {
                // Every streamed frame is written and dropped inside `on_page`,
                // so shrink back to the base source-bytes reservation between frames.
                reservation.shrink_to(base);
            }
            _ => {}
        }
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

/// Rejects frames the PDF builder cannot write before their raster is decoded:
/// only 1-bit bilevel frames and unsigned 8-bit gray or RGB samples are
/// supported.
fn ensure_tiff_pdf_sample_type<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    color_type: TiffColorType,
) -> Result<()> {
    match color_type {
        TiffColorType::Gray(1) => Ok(()),
        TiffColorType::Gray(8) | TiffColorType::RGB(8) => {
            ensure_unsigned_tiff_samples(decoder, "native PDF fast path")
        }
        _ => Err(unsupported_tiff_sample_type(
            color_type,
            "native PDF fast path",
        )),
    }
}

pub(super) fn unsupported_tiff_sample_type(
    color_type: TiffColorType,
    consumer: &str,
) -> Box<dyn std::error::Error> {
    if color_type.bit_depth() != 8 {
        format!("Only 8-bit TIFF samples are supported by the {consumer}: {color_type:?}").into()
    } else {
        format!("Unsupported TIFF color type for {consumer}: {color_type:?}").into()
    }
}

/// SampleFormat 1 (unsigned integer) is the TIFF default; the 8-bit paths
/// need `DecodingResult::U8`, which signed or floating samples do not decode to.
pub(super) fn ensure_unsigned_tiff_samples<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    consumer: &str,
) -> Result<()> {
    let formats = decoder
        .find_tag_unsigned_vec::<u16>(Tag::SampleFormat)?
        .unwrap_or_default();
    if formats.iter().any(|format| *format != 1) {
        return Err(
            format!("Only unsigned 8-bit TIFF samples are supported by the {consumer}").into(),
        );
    }
    Ok(())
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

/// Horizontal and vertical DPI of the frame as displayed; an axis without a
/// resolution that rounds to at least 1 DPI takes the other axis's value.
fn read_tiff_dpi_axes<R: Read + Seek>(decoder: &mut Decoder<R>) -> Option<(u32, u32)> {
    let orientation = read_tiff_orientation(decoder);
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
        (dpi_x, dpi_y) if swaps_tiff_axes(orientation) => Some((dpi_y, dpi_x)), // rotated frame
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
pub(crate) use export::{combine_tiff_pages, combine_tiff_pages_with_limits};

#[cfg(test)]
mod tests;
