use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use evb_native_support::output::AtomicOutput;
use tiff::{
    decoder::{Decoder, DecodingResult},
    encoder::{
        colortype::{self, ColorType},
        Compression, DeflateLevel, Predictor, Rational, TiffEncoder,
    },
    tags::ResolutionUnit,
    ColorType as TiffColorType,
};

use super::{
    ensure_unsigned_tiff_samples, orient_tiff_pixels, read_tiff_dpi_axes, read_tiff_orientation,
    unsupported_tiff_sample_type,
};
#[cfg(not(target_family = "wasm"))]
use super::{estimate_tiff_frame_decode_bytes, FLATE_ENCODER_FIXED_OVERHEAD_BYTES};
use crate::{
    image::assert_pixel_limit,
    netpbm::{is_rgb_data_grayscale, read_netpbm_file_admitted},
    open_validated_input_file, validate_output_path_non_blocking, Result, DEFAULT_DPI,
    DEFAULT_MAX_IN_FLIGHT_BYTES, DEFAULT_MAX_OPEN_INPUT_FDS,
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
    #[cfg(not(target_family = "wasm"))]
    fn byte_len(&self) -> u64 {
        match self {
            Self::Gray(pixels) | Self::Rgb(pixels) | Self::Rgba(pixels) => pixels.len() as u64,
        }
    }

    #[cfg(not(target_family = "wasm"))]
    fn samples_per_pixel(&self) -> u64 {
        match self {
            Self::Gray(_) => 1,
            Self::Rgb(_) => 3,
            Self::Rgba(_) => 4,
        }
    }

    /// Actual heap allocation retained by the sample buffer (which may exceed
    /// `byte_len()` when a neutral RGB buffer is truncated in place to gray).
    #[cfg(not(target_family = "wasm"))]
    fn retained_bytes(&self) -> u64 {
        match self {
            Self::Gray(pixels) | Self::Rgb(pixels) | Self::Rgba(pixels) => {
                pixels.capacity().max(pixels.len()) as u64
            }
        }
    }

    /// The samples as the frame is displayed with `orientation`, and the
    /// frame's displayed width and height.
    fn oriented(self, width: u32, height: u32, orientation: u16) -> Result<(u32, u32, Self)> {
        Ok(match self {
            Self::Gray(pixels) => {
                let (width, height, pixels) =
                    orient_tiff_pixels(pixels, width, height, 1, orientation)?;
                (width, height, Self::Gray(pixels))
            }
            Self::Rgb(pixels) => {
                let (width, height, pixels) =
                    orient_tiff_pixels(pixels, width, height, 3, orientation)?;
                (width, height, Self::Rgb(pixels))
            }
            Self::Rgba(pixels) => {
                let (width, height, pixels) =
                    orient_tiff_pixels(pixels, width, height, 4, orientation)?;
                (width, height, Self::Rgba(pixels))
            }
        })
    }

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
    let _metrics = combine_tiff_pages_with_limits(
        input_paths,
        output_path,
        max_pixels,
        max_pages,
        dpi,
        DEFAULT_MAX_OPEN_INPUT_FDS,
        DEFAULT_MAX_IN_FLIGHT_BYTES,
    )?;
    Ok(())
}

pub(crate) fn combine_tiff_pages_with_limits(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    max_pages: usize,
    dpi: Option<u32>,
    max_open_fds: usize,
    max_in_flight_bytes: u64,
) -> Result<crate::PipelineMetrics> {
    if input_paths.is_empty() {
        return Err("No pages available for TIFF export".into());
    }
    if input_paths.len() > max_pages {
        return Err(format!("TIFF export is capped at {max_pages} pages").into());
    }

    // Validate output path non-blocking before creating its unpublished sibling,
    // then open each input lazily under FD and byte admission.
    validate_output_path_non_blocking(output_path)?;
    combine_validated_tiff_pages(
        input_paths,
        output_path,
        max_pixels,
        dpi,
        max_open_fds,
        max_in_flight_bytes,
    )
}

fn combine_validated_tiff_pages(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    dpi: Option<u32>,
    #[allow(unused_variables)] max_open_fds: usize,
    #[allow(unused_variables)] max_in_flight_bytes: u64,
) -> Result<crate::PipelineMetrics> {
    #[cfg(not(target_family = "wasm"))]
    let budget = crate::PipelineBudget::new(max_open_fds, max_in_flight_bytes);
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
            for (seq, input_path) in input_paths.iter().enumerate() {
                #[cfg(not(target_family = "wasm"))]
                let mut fd_permit = budget.acquire_standalone_fd(seq)?;
                let file = open_validated_input_file(input_path, output_path)?;
                #[cfg(not(target_family = "wasm"))]
                fd_permit.release_transient_output_slot();
                #[cfg_attr(target_family = "wasm", allow(unused_mut))]
                let (page, mut reservation) = read_first_tiff_export_page(
                    file,
                    max_pixels,
                    #[cfg(not(target_family = "wasm"))]
                    Some((&budget, seq)),
                    #[cfg(target_family = "wasm")]
                    None,
                )?;
                #[cfg(not(target_family = "wasm"))]
                drop(fd_permit);
                // `write_data` encodes from the retained samples; reserve its
                // strip working set alongside them (oversized pages take
                // exclusive admission) and hold the reservation until the
                // write returns, including on error.
                #[cfg(not(target_family = "wasm"))]
                if let Some(reservation) = reservation.as_mut() {
                    reservation.reserve_additional(
                        estimate_tiff_export_encode_working_set_bytes(
                            page.width,
                            page.height,
                            page.samples.samples_per_pixel(),
                        ),
                    )?;
                }
                #[cfg(target_family = "wasm")]
                let _ = seq;
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
                drop(page);
                drop(reservation);
            }
        }
        writer.flush()?;
    }
    output.publish()?;
    #[cfg(not(target_family = "wasm"))]
    {
        Ok(budget.metrics())
    }
    #[cfg(target_family = "wasm")]
    {
        Ok(crate::PipelineMetrics::default())
    }
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

fn read_first_tiff_export_page<'a>(
    mut file: File,
    max_pixels: u64,
    #[allow(unused_variables)] budget: Option<(&'a crate::PipelineBudget, usize)>,
) -> Result<(TiffExportPage, Option<crate::PageBytesReservation<'a>>)> {
    #[cfg(not(target_family = "wasm"))]
    let file_len = file.metadata().map_or(0, |metadata| metadata.len());
    let mut magic = [0u8; 2];
    let bytes_read = file.read(&mut magic)?;
    file.seek(SeekFrom::Start(0))?;
    if bytes_read == magic.len() && (magic == *b"P5" || magic == *b"P6") {
        #[cfg(not(target_family = "wasm"))]
        let mut reservation = if let Some((pipeline_budget, seq)) = budget {
            Some(pipeline_budget.reserve_standalone_bytes(seq, file_len)?)
        } else {
            None
        };
        #[cfg(target_family = "wasm")]
        let mut reservation: Option<crate::PageBytesReservation<'a>> = None;
        let page = read_first_netpbm_export_page(file, max_pixels, |raster| {
            // The file may have grown since its length was reserved.
            #[cfg(not(target_family = "wasm"))]
            if let Some(guard) = reservation.as_mut() {
                guard.grow_to(raster)?;
            }
            #[cfg(target_family = "wasm")]
            let _ = (raster, &mut reservation);
            Ok(())
        })?;
        #[cfg(not(target_family = "wasm"))]
        if let Some(guard) = reservation.as_mut() {
            guard.shrink_to(page.samples.retained_bytes());
        }
        return Ok((page, reservation));
    }

    let mut decoder = Decoder::new(BufReader::new(file))?;
    let (width, height) = decoder.dimensions()?;
    assert_pixel_limit(width, height, max_pixels)?;
    let orientation = read_tiff_orientation(&mut decoder);
    let (dpi_x, dpi_y) = read_tiff_dpi_axes(&mut decoder).unwrap_or((DEFAULT_DPI, DEFAULT_DPI));
    let color_type = decoder.colortype()?;
    // Reject sample types the exporter cannot write before decoding a raster.
    match color_type {
        TiffColorType::Gray(8)
        | TiffColorType::GrayA(8)
        | TiffColorType::RGB(8)
        | TiffColorType::RGBA(8) => {
            ensure_unsigned_tiff_samples(&mut decoder, "native TIFF fast path")?
        }
        _ => {
            return Err(unsupported_tiff_sample_type(
                color_type,
                "native TIFF fast path",
            ))
        }
    }
    let (width, height, samples, reservation) = decode_tiff_export_samples_budgeted(
        width,
        height,
        color_type,
        orientation,
        budget,
        || decoder.read_image().map_err(Into::into),
    )?;

    Ok((
        TiffExportPage {
            width,
            height,
            dpi_x,
            dpi_y,
            samples,
        },
        reservation,
    ))
}

type BudgetedExportSamples<'a> = (
    u32,
    u32,
    TiffExportSamples,
    Option<crate::PageBytesReservation<'a>>,
);

fn decode_tiff_export_samples_budgeted<'a, F>(
    width: u32,
    height: u32,
    color_type: TiffColorType,
    orientation: u16,
    #[allow(unused_variables)] budget: Option<(&'a crate::PipelineBudget, usize)>,
    read_image: F,
) -> Result<BudgetedExportSamples<'a>>
where
    F: FnOnce() -> Result<DecodingResult>,
{
    #[cfg(not(target_family = "wasm"))]
    let mut reservation = if let Some((pipeline_budget, seq)) = budget {
        let estimated = estimate_tiff_export_decode_bytes(width, height, color_type, orientation);
        Some(pipeline_budget.reserve_standalone_bytes(seq, estimated)?)
    } else {
        None
    };
    #[cfg(target_family = "wasm")]
    let reservation = None;
    let decoded = read_image()?;
    let samples = build_tiff_export_samples(width, height, color_type, decoded)?;
    // Once `build_tiff_export_samples` drops the source buffer (for example the
    // 2 Bpp gray+alpha buffer after expanding to 4 Bpp RGBA), release its
    // temporary reservation immediately while keeping any retained capacity
    // (such as a neutral RGB buffer truncated in place to 1 Bpp gray) plus the
    // orientation destination buffer accounted until orientation drops it.
    #[cfg(not(target_family = "wasm"))]
    if let Some(guard) = reservation.as_mut() {
        let post_convert_target = if orientation != 1 {
            samples.retained_bytes().saturating_add(samples.byte_len())
        } else {
            samples.retained_bytes()
        };
        guard.shrink_to(post_convert_target);
    }
    let (width, height, samples) = samples.oriented(width, height, orientation)?;
    #[cfg(not(target_family = "wasm"))]
    if let Some(guard) = reservation.as_mut() {
        guard.shrink_to(samples.retained_bytes());
    }
    Ok((width, height, samples, reservation))
}

/// Rows per strip `tiff 0.11`'s `ImageEncoder` uses for non-PackBits
/// compression: `ceil(1,000,000 / row_bytes)`.
#[cfg(not(target_family = "wasm"))]
const TIFF_ENCODER_TARGET_STRIP_BYTES: u64 = 1_000_000;

/// Heap `ImageEncoder::write_data` holds beyond the retained samples while
/// writing Deflate strips with the horizontal predictor: one strip-sized
/// predictor buffer and a live `flate2` + `zlib-rs` encoder that streams its
/// output straight to the file writer.
#[cfg(not(target_family = "wasm"))]
fn estimate_tiff_export_encode_working_set_bytes(
    width: u32,
    height: u32,
    samples_per_pixel: u64,
) -> u64 {
    let row_bytes = u64::from(width).saturating_mul(samples_per_pixel).max(1);
    let rows_per_strip = TIFF_ENCODER_TARGET_STRIP_BYTES.div_ceil(row_bytes);
    let strip_bytes = rows_per_strip
        .min(u64::from(height))
        .saturating_mul(row_bytes);
    strip_bytes.saturating_add(FLATE_ENCODER_FIXED_OVERHEAD_BYTES)
}

#[cfg(not(target_family = "wasm"))]
fn estimate_tiff_export_decode_bytes(
    width: u32,
    height: u32,
    color_type: TiffColorType,
    orientation: u16,
) -> u64 {
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    match color_type {
        // GrayA(8) decodes to 2 Bpp and expands to 4 Bpp RGBA while both
        // buffers coexist (6 Bpp peak); non-identity orientation then copies
        // the 4 Bpp RGBA buffer (8 Bpp peak).
        TiffColorType::GrayA(8) => {
            let conversion_peak = pixels.saturating_mul(6);
            if orientation != 1 {
                conversion_peak.max(pixels.saturating_mul(8))
            } else {
                conversion_peak
            }
        }
        _ => estimate_tiff_frame_decode_bytes(width, height, color_type, orientation),
    }
}

fn read_first_netpbm_export_page(
    file: File,
    max_pixels: u64,
    admit_raster: impl FnOnce(u64) -> Result<()>,
) -> Result<TiffExportPage> {
    let netpbm = read_netpbm_file_admitted(file, max_pixels, admit_raster)?;
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

#[cfg(all(test, not(target_family = "wasm")))]
mod tests {
    use super::*;

    #[test]
    fn tiff_export_reserves_six_bytes_per_pixel_peak_for_gray_alpha_and_shrinks_after_drop() {
        const WIDTH: u32 = 32;
        const HEIGHT: u32 = 32;
        let pixels_count = u64::from(WIDTH) * u64::from(HEIGHT);
        let gray_alpha = vec![0x80u8; (pixels_count * 2) as usize];

        let identity_budget = crate::PipelineBudget::new(2, 64 * 1024);
        let (out_w, out_h, samples, reservation) = decode_tiff_export_samples_budgeted(
            WIDTH,
            HEIGHT,
            TiffColorType::GrayA(8),
            1,
            Some((&identity_budget, 0)),
            || Ok(DecodingResult::U8(gray_alpha.clone())),
        )
        .unwrap();
        assert_eq!((out_w, out_h), (WIDTH, HEIGHT));
        assert!(matches!(samples, TiffExportSamples::Rgba(_)));
        assert_eq!(samples.byte_len(), pixels_count * 4);
        assert_eq!(
            identity_budget.metrics().peak_in_flight_bytes,
            pixels_count * 6,
            "GrayA(8) conversion must reserve 6 Bpp (2 Bpp source + 4 Bpp RGBA coexisting)"
        );
        assert_eq!(
            reservation.as_ref().unwrap().held_bytes(),
            pixels_count * 4,
            "temporary 2 Bpp reservation must shrink to 4 Bpp RGBA once source buffer drops"
        );
        drop(samples);
        drop(reservation);

        let rotated_budget = crate::PipelineBudget::new(2, 64 * 1024);
        let (rot_w, rot_h, rot_samples, rot_reservation) = decode_tiff_export_samples_budgeted(
            WIDTH,
            HEIGHT,
            TiffColorType::GrayA(8),
            6,
            Some((&rotated_budget, 0)),
            || Ok(DecodingResult::U8(gray_alpha)),
        )
        .unwrap();
        assert_eq!((rot_w, rot_h), (HEIGHT, WIDTH));
        assert_eq!(
            rotated_budget.metrics().peak_in_flight_bytes,
            pixels_count * 8,
            "rotated GrayA(8) must reserve 8 Bpp for the RGBA orientation copy"
        );
        assert_eq!(
            rot_reservation.as_ref().unwrap().held_bytes(),
            pixels_count * 4
        );
        drop(rot_samples);
        drop(rot_reservation);
    }

    fn temp_path(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "evb-tiff-export-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn tiff_export_rejects_unsupported_sample_types_before_decoding() {
        let path = temp_path("gray64.tiff");
        {
            let mut encoder = TiffEncoder::new(File::create(&path).unwrap()).unwrap();
            encoder
                .write_image::<colortype::Gray64>(4, 4, &[7u64; 16])
                .unwrap();
        }
        let budget = crate::PipelineBudget::new(2, 16 * 1024 * 1024);
        let result =
            read_first_tiff_export_page(File::open(&path).unwrap(), u64::MAX, Some((&budget, 0)));
        std::fs::remove_file(&path).unwrap();
        let error = match result {
            Ok(_) => panic!("Gray64 TIFF was accepted for export"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("Only 8-bit TIFF samples"),
            "unexpected error: {error}"
        );
        assert_eq!(budget.metrics().peak_in_flight_bytes, 0);
    }

    #[test]
    fn tiff_export_reserves_the_strip_encoder_next_to_retained_samples() {
        const SIDE: u32 = 64;
        let samples = u64::from(SIDE) * u64::from(SIDE);
        let input = temp_path("page.pgm");
        let output = temp_path("export.tiff");
        let mut pgm = format!("P5\n{SIDE} {SIDE}\n255\n").into_bytes();
        pgm.extend((0..samples).map(|index| (index * 7) as u8));
        std::fs::write(&input, pgm).unwrap();

        // The 64 KiB cap is below the ~420 KiB encoder working set, so the
        // page proceeds through exclusive oversized admission.
        let metrics = combine_tiff_pages_with_limits(
            std::slice::from_ref(&input),
            &output,
            u64::MAX,
            4,
            None,
            2,
            64 * 1024,
        );
        std::fs::remove_file(&input).unwrap();
        let _ = std::fs::remove_file(&output);
        let metrics = metrics.unwrap();
        let working_set = estimate_tiff_export_encode_working_set_bytes(SIDE, SIDE, 1);
        // One 64-row strip of predictor output plus the live Deflate encoder.
        assert_eq!(working_set, samples + FLATE_ENCODER_FIXED_OVERHEAD_BYTES);
        assert_eq!(metrics.peak_in_flight_bytes, samples + working_set);
    }

    #[test]
    fn tiff_export_accounts_for_rotated_neutral_rgb_retained_capacity_until_oriented() {
        const WIDTH: u32 = 32;
        const HEIGHT: u32 = 32;
        let pixels_count = u64::from(WIDTH) * u64::from(HEIGHT);
        let neutral_rgb = vec![0x66u8; (pixels_count * 3) as usize];

        let budget = crate::PipelineBudget::new(2, 64 * 1024);
        let (rot_w, rot_h, samples, reservation) = decode_tiff_export_samples_budgeted(
            WIDTH,
            HEIGHT,
            TiffColorType::RGB(8),
            6,
            Some((&budget, 0)),
            || Ok(DecodingResult::U8(neutral_rgb)),
        )
        .unwrap();
        assert_eq!((rot_w, rot_h), (HEIGHT, WIDTH));
        assert!(matches!(samples, TiffExportSamples::Gray(_)));
        // Peak covers full decode+orientation (6 Bpp), and after rotation drops
        // the truncated 3 Bpp RGB buffer, held reservation shrinks to 1 Bpp gray.
        assert_eq!(budget.metrics().peak_in_flight_bytes, pixels_count * 6);
        assert_eq!(reservation.as_ref().unwrap().held_bytes(), pixels_count);
        assert_eq!(samples.retained_bytes(), pixels_count);
        drop(samples);
        drop(reservation);

        // Directly verify that a truncated neutral RGB retains its 3 Bpp
        // capacity so `retained_bytes + byte_len == 4 Bpp` before rotation.
        let truncated = TiffExportSamples::from_rgb(
            vec![0x66u8; (pixels_count * 3) as usize],
            pixels_count as usize,
        );
        assert_eq!(truncated.byte_len(), pixels_count);
        assert!(
            truncated.retained_bytes() >= pixels_count * 3,
            "expected truncated neutral RGB to retain >= 3 Bpp capacity, got {}",
            truncated.retained_bytes()
        );
        assert!(
            truncated
                .retained_bytes()
                .saturating_add(truncated.byte_len())
                >= pixels_count * 4
        );
    }
}
