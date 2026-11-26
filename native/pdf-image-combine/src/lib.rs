//! Image-to-PDF combination used by the native CLI and browser WASM build.
//!
//! Set `EVB_PDF_COMBINE_TIMING=1` when running the native CLI to emit one
//! `jbig2-encode-timing` JSON object on stderr for every bilevel base image or
//! image mask. `elapsedMs` is the verified JBIG2 candidate's encode-and-decode
//! wall time for that page; records appear in page-encoding order, which is not
//! page order once more than one encoder runs. `EVB_PDF_COMBINE_THREADS` caps
//! that fan-out; the written PDF is byte-identical at every setting.

pub mod compact_manifest_line;
mod flate;
mod image;
mod jpx;
mod netpbm;
mod pdf;
mod tiff_io;

#[cfg(any(
    test,
    all(
        target_family = "wasm",
        target_os = "unknown",
        feature = "wasm-exports"
    )
))]
mod wasm;

use jpeg_encoder::{
    ColorType as JpegColorType, Encoder as JpegEncoder, PixelDensity, SamplingFactor,
};
use std::{
    borrow::Cow,
    error::Error,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
};
#[cfg(not(target_family = "wasm"))]
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Condvar, Mutex},
};

#[cfg(not(unix))]
use evb_native_support::output::ValidatedInputFiles;
use evb_native_support::{output::AtomicOutput, NativeError, NativeErrorCode};
use evb_raster_io::{decode_png_gray, write_png, write_png_with_dpi, DecodeLimits, PixelBuffer};

use crate::{
    image::{
        assert_pixel_limit, read_file, read_image_page_from_bytes,
        read_image_page_from_loaded_file_bytes, read_owned_netpbm_page,
        visit_image_pages_from_bytes, visit_image_pages_from_file,
        visit_image_pages_from_loaded_file_bytes, PdfImageCompression,
    },
    netpbm::{
        is_rgb_data_grayscale, parse_netpbm, parse_pbm_p4, read_netpbm_file,
        read_netpbm_file_admitted, read_pbm_p4_file_admitted, OwnedNetpbm, PbmP4Image,
    },
    pdf::{
        write_pdf_to_writer, AffineMaskedLayeredPdfPage, BilevelStream, ImagePage, ImagePayload,
        LayeredImagePayload, LayeredPdfImage, LayeredPdfPage, MaskPdfPage, PdfWriter,
        SoftLayeredPdfPage, SoftMaskStream,
    },
    tiff_io::{
        combine_tiff_pages, combine_tiff_pages_with_limits,
        visit_tiff_pdf_pages_from_file_budgeted, TiffBudget,
    },
};
#[cfg(not(target_family = "wasm"))]
use crate::{
    image::{
        estimate_image_bytes_decode_bytes, estimate_netpbm_page_encode_bytes,
        estimate_pbm_bytes_encode_bytes,
    },
    tiff_io::{
        estimate_bilevel_encode_peak_bytes, estimate_up_filtered_flate_working_set_bytes,
        probe_tiff_pdf_peak_bytes_from_bytes,
    },
};

pub use crate::{
    image::JpegSizeGuardrail,
    netpbm::{probe_netpbm_path, NetpbmProbe},
    pdf::{PdfImagePlacement, PdfPageSize},
};
pub use evb_image_codecs::{
    pdf_image_samples, recompress_jpeg, RecompressedJpeg, DEFAULT_MAX_IMAGE_PIXELS,
};

pub const DEFAULT_DPI: u32 = 72;
pub const DEFAULT_MAX_BILEVEL_PIXELS: u64 = 160_000_000;
/// Output cap for byte-returning native IPC adapters.
pub const PDF_COMBINE_MAX_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
/// Default cap on simultaneously open input file descriptors during streaming
/// PDF assembly. Kept well below macOS's default `RLIMIT_NOFILE` (256) while
/// saturating parallel workers.
pub const DEFAULT_MAX_OPEN_INPUT_FDS: usize = 32;
/// Default cap on in-flight decoded and buffered page bytes across concurrent
/// workers and the ordered PDF write queue.
pub const DEFAULT_MAX_IN_FLIGHT_BYTES: u64 = 256 * 1024 * 1024;
pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn too_large_error(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(NativeError::new(NativeErrorCode::TooLarge, message))
}

#[doc(hidden)]
pub fn fuzz_parse_jpeg(data: &[u8]) {
    let _ = evb_image_codecs::jpeg::parse_jpeg_metadata(data);
}
#[doc(hidden)]
pub fn fuzz_parse_tiff(data: &[u8]) {
    let _ = tiff_io::read_tiff_pdf_pages_from_bytes(data, 80_000_000, None, 64);
}

#[doc(hidden)]
pub fn fuzz_parse_netpbm(data: &[u8]) {
    let _ = netpbm::parse_pbm_p4(data, 80_000_000);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageCompression {
    Auto,
    Jpeg { quality: u8 },
    JpegWithFlateFallback { quality: u8 },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ImageProcessing {
    #[default]
    None,
    DownscaleToPpi {
        ppi_cap: u16,
    },
    /// Binarizes a grayscale (PGM) render with scan cleanup's illumination
    /// normalization and Sauvola threshold and stores the page as a lossless
    /// 1-bit image. Needs a page size,
    /// which gives the render's resolution.
    BlackAndWhite,
}

pub struct ImageSpec<S> {
    pub source: S,
    pub compression: ImageCompression,
    pub processing: ImageProcessing,
    pub size_guardrail: Option<JpegSizeGuardrail>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FramePolicy {
    /// Legacy plain-image behavior: all TIFF frames become PDF pages.
    All,
    /// Mixed and layered behavior: the source must resolve to exactly one page.
    ExactlyOne,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum PdfBilevelDecode {
    #[default]
    Default,
    Inverted,
}

pub enum PageSpec<S> {
    Image {
        page_size: Option<PdfPageSize>,
        placement: Option<PdfImagePlacement>,
        rotation_degrees: u16,
        image: ImageSpec<S>,
        frames: FramePolicy,
    },
    Layered {
        page_size: PdfPageSize,
        background: ImageSpec<S>,
        foreground_mask: S,
        foreground_color: Option<[u8; 3]>,
    },
    SoftLayered {
        page_size: PdfPageSize,
        background: ImageSpec<S>,
        foreground_alpha: S,
        foreground_color: Option<[u8; 3]>,
    },
    AffineMaskedLayered {
        page_size: PdfPageSize,
        background: ImageSpec<S>,
        foreground: ImageSpec<S>,
        foreground_mask: S,
        foreground_mask_decode: PdfBilevelDecode,
        foreground_matrix: [f64; 6],
    },
    Mask {
        page_size: PdfPageSize,
        foreground_mask: S,
    },
}

impl<S> PageSpec<S> {
    #[doc(hidden)]
    pub fn map_sources<T, E>(
        self,
        mapper: &mut impl FnMut(S) -> std::result::Result<T, E>,
    ) -> std::result::Result<PageSpec<T>, E> {
        Ok(match self {
            Self::Image {
                page_size,
                placement,
                rotation_degrees,
                image,
                frames,
            } => PageSpec::Image {
                page_size,
                placement,
                rotation_degrees,
                image: image.map_source(mapper)?,
                frames,
            },
            Self::Layered {
                page_size,
                background,
                foreground_mask,
                foreground_color,
            } => PageSpec::Layered {
                page_size,
                background: background.map_source(mapper)?,
                foreground_mask: mapper(foreground_mask)?,
                foreground_color,
            },
            Self::SoftLayered {
                page_size,
                background,
                foreground_alpha,
                foreground_color,
            } => PageSpec::SoftLayered {
                page_size,
                background: background.map_source(mapper)?,
                foreground_alpha: mapper(foreground_alpha)?,
                foreground_color,
            },
            Self::AffineMaskedLayered {
                page_size,
                background,
                foreground,
                foreground_mask,
                foreground_mask_decode,
                foreground_matrix,
            } => PageSpec::AffineMaskedLayered {
                page_size,
                background: background.map_source(mapper)?,
                foreground: foreground.map_source(mapper)?,
                foreground_mask: mapper(foreground_mask)?,
                foreground_mask_decode,
                foreground_matrix,
            },
            Self::Mask {
                page_size,
                foreground_mask,
            } => PageSpec::Mask {
                page_size,
                foreground_mask: mapper(foreground_mask)?,
            },
        })
    }
}
impl<S> ImageSpec<S> {
    /// Automatic, unprocessed images are read through the frame visitor, so a
    /// multi-page TIFF yields one PDF page per frame.
    fn visits_every_frame(&self) -> bool {
        self.compression == ImageCompression::Auto && self.processing == ImageProcessing::None
    }

    fn map_source<T, E>(
        self,
        mapper: &mut impl FnMut(S) -> std::result::Result<T, E>,
    ) -> std::result::Result<ImageSpec<T>, E> {
        Ok(ImageSpec {
            source: mapper(self.source)?,
            compression: self.compression,
            processing: self.processing,
            size_guardrail: self.size_guardrail,
        })
    }
}

pub enum InputSource<'a> {
    File { label: PathBuf, file: File },
    Bytes { file_name: &'a str, data: &'a [u8] },
}

pub type PdfPageSpec<'a> = PageSpec<InputSource<'a>>;

impl PdfPageSpec<'_> {
    /// Whether the spec may yield several pages: an automatic image read from
    /// a TIFF, whose frames each become a page.
    fn streams_frames(&self) -> bool {
        matches!(
            self,
            PageSpec::Image {
                image,
                frames: FramePolicy::All,
                ..
            } if image.visits_every_frame() && image.source.is_tiff()
        )
    }

    #[cfg(not(target_family = "wasm"))]
    fn open_file_count(&self) -> usize {
        let count =
            |source: &InputSource<'_>| usize::from(matches!(source, InputSource::File { .. }));
        match self {
            PageSpec::Image { image, .. } => count(&image.source),
            PageSpec::Layered {
                background,
                foreground_mask,
                ..
            } => count(&background.source) + count(foreground_mask),
            PageSpec::SoftLayered {
                background,
                foreground_alpha,
                ..
            } => count(&background.source) + count(foreground_alpha),
            PageSpec::AffineMaskedLayered {
                background,
                foreground,
                foreground_mask,
                ..
            } => count(&background.source) + count(&foreground.source) + count(foreground_mask),
            PageSpec::Mask {
                foreground_mask, ..
            } => count(foreground_mask),
        }
    }
}

impl PageSpec<PathBuf> {
    fn streams_frames_path(&self) -> bool {
        matches!(
            self,
            PageSpec::Image {
                image,
                frames: FramePolicy::All,
                ..
            } if image.visits_every_frame() && path_has_extension(&image.source, &["tif", "tiff"])
        )
    }
}

fn path_has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

/// Case-insensitive extension check matching `visit_image_pages_from_bytes`,
/// including leading-dot names like `".tif"` or `".tiff"` where
/// `Path::extension()` returns `None`.
fn name_has_extension(name: &str, extensions: &[&str]) -> bool {
    name.rsplit_once('.').is_some_and(|(_, extension)| {
        extensions
            .iter()
            .any(|candidate| extension.eq_ignore_ascii_case(candidate))
    })
}

pub struct PdfBuildOptions {
    pub default_dpi: Option<u32>,
    pub max_pages: usize,
    pub max_pixels: u64,
    pub max_bilevel_pixels: u64,
    pub max_output_bytes: u64,
    /// Allows the file-backed CLI and in-process WASM to use their available
    /// resources. Byte-returning IPC adapters leave this disabled.
    pub allow_large_output: bool,
    pub max_tiff_frames: usize,
    /// Lowercase hex encoding of the canonical JSON provenance payload to
    /// publish in the PDF Info dictionary.
    pub provenance_stamp_hex: Option<String>,
    /// Pages whose payloads may be encoded concurrently. The written bytes are
    /// identical for every value; only wall-clock and peak memory change.
    pub worker_threads: usize,
    /// Upper bound on simultaneously open input file descriptors.
    ///
    /// [`write_pdf_paths`] enforces this limit across the entire batch by
    /// opening and closing input files lazily. [`write_pdf`] accepts
    /// caller-owned [`InputSource::File`] handles and can only account for
    /// descriptors after the caller's iterator yields them; an eager iterator
    /// (such as a pre-collected `Vec`) already holds its descriptors open
    /// before yielding.
    pub max_open_input_fds: usize,
    /// Upper bound on in-flight decoded and buffered page bytes across
    /// concurrent workers and the ordered write queue.
    pub max_in_flight_bytes: u64,
}

impl Default for PdfBuildOptions {
    fn default() -> Self {
        Self {
            default_dpi: None,
            max_pages: 500,
            max_pixels: DEFAULT_MAX_IMAGE_PIXELS,
            max_bilevel_pixels: DEFAULT_MAX_BILEVEL_PIXELS,
            max_output_bytes: PDF_COMBINE_MAX_OUTPUT_BYTES,
            allow_large_output: false,
            max_tiff_frames: 250,
            provenance_stamp_hex: None,
            worker_threads: 1,
            max_open_input_fds: DEFAULT_MAX_OPEN_INPUT_FDS,
            max_in_flight_bytes: DEFAULT_MAX_IN_FLIGHT_BYTES,
        }
    }
}

/// Combines pre-opened or in-memory page specs into a PDF under bounded
/// in-flight byte limits.
///
/// Because callers supply pre-opened [`InputSource::File`] handles, `write_pdf`
/// can only account for and bound descriptors after `page_specs` yields them
/// (and rejects any single spec whose open handle count exceeds
/// `options.max_open_input_fds`). An eager iterator such as a pre-collected
/// `Vec` already holds all of its descriptors open before yielding; use
/// [`write_pdf_paths`] to enforce `max_open_input_fds` across an entire
/// path-backed batch.
pub fn write_pdf<'a, W, I, P>(
    output: W,
    page_specs: I,
    options: &PdfBuildOptions,
    on_processed: P,
) -> Result<W>
where
    W: Write,
    I: IntoIterator<Item = PdfPageSpec<'a>>,
    P: FnMut(usize),
{
    let (writer, _metrics) = write_pdf_impl(output, page_specs, options, on_processed)?;
    Ok(writer)
}

/// Streams path-backed page specs into a PDF while lazily opening and closing
/// each page's input files under bounded file-descriptor and in-flight byte
/// limits. Each opened input is checked against `output_path` for same-file and
/// hard-link aliasing before reading.
pub fn write_pdf_paths<W, I, P>(
    output: W,
    output_path: &Path,
    page_specs: I,
    options: &PdfBuildOptions,
    on_processed: P,
) -> Result<W>
where
    W: Write,
    I: IntoIterator<Item = Result<PageSpec<PathBuf>>>,
    P: FnMut(usize),
{
    let (writer, _metrics) =
        write_pdf_paths_impl(output, output_path, page_specs, options, on_processed)?;
    Ok(writer)
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct PipelineMetrics {
    pub(crate) peak_open_fds: usize,
    pub(crate) peak_in_flight_bytes: u64,
    pub(crate) peak_concurrent_decodes: usize,
    pub(crate) peak_concurrent_prepares: usize,
}

#[cfg(not(target_family = "wasm"))]
fn reject_spec_if_fds_exceed_limit(spec: &PdfPageSpec<'_>, max_open_fds: usize) -> Result<()> {
    let open_fds = spec.open_file_count();
    if open_fds > max_open_fds {
        return Err(too_large_error(format!(
            "Page spec holds {open_fds} open input file descriptors, exceeding the {max_open_fds}-FD limit"
        )));
    }
    Ok(())
}

fn write_pdf_impl<'a, W, I, P>(
    output: W,
    page_specs: I,
    options: &PdfBuildOptions,
    mut on_processed: P,
) -> Result<(W, PipelineMetrics)>
where
    W: Write,
    I: IntoIterator<Item = PdfPageSpec<'a>>,
    P: FnMut(usize),
{
    let mut page_specs = page_specs.into_iter();
    let Some(first_spec) = page_specs.next() else {
        return Err("At least one image input is required".into());
    };
    #[cfg(not(target_family = "wasm"))]
    let max_open_fds = options.max_open_input_fds.max(1);
    #[cfg(not(target_family = "wasm"))]
    reject_spec_if_fds_exceed_limit(&first_spec, max_open_fds)?;

    let worker_threads = options
        .worker_threads
        .clamp(1, evb_native_support::MAX_WORKER_THREADS);
    let max_output_bytes = effective_max_output_bytes(options);
    let output = OutputLimitWriter::new(output, max_output_bytes);
    let mut page_count = 0usize;
    let mut processed = 0usize;
    #[cfg_attr(target_family = "wasm", allow(unused_mut))]
    let mut metrics = PipelineMetrics::default();
    let mut first_spec = Some(first_spec);
    let output = write_pdf_to_writer(output, options.provenance_stamp_hex.as_deref(), |pdf| {
        let first_spec = first_spec.take().expect("first page spec");
        #[cfg(not(target_family = "wasm"))]
        {
            if worker_threads > 1 {
                metrics = run_input_source_pipeline(
                    pdf,
                    first_spec,
                    &mut page_specs,
                    options,
                    worker_threads,
                    &mut page_count,
                    &mut processed,
                    &mut on_processed,
                )?;
                return Ok(());
            }

            let budget =
                PipelineBudget::new(options.max_open_input_fds, options.max_in_flight_bytes);
            for (seq, spec) in std::iter::once(first_spec)
                .chain(page_specs.by_ref())
                .enumerate()
            {
                reject_spec_if_fds_exceed_limit(&spec, max_open_fds)?;
                let fd_permit = budget.register_external_fds(spec.open_file_count());
                if spec.streams_frames() {
                    prepare_input_page_spec(
                        spec,
                        options,
                        Some(TiffBudget::Standalone(&budget, seq)),
                        |page| write_counted_page(pdf, page, &mut page_count, options),
                    )?;
                    drop(fd_permit);
                } else {
                    let mut reservation = budget.empty_reservation(seq);
                    let loaded =
                        load_input_page_spec_budgeted(spec, options, Some(&mut reservation))?;
                    drop(fd_permit);
                    let decode_bytes = estimate_loaded_spec_decode_bytes(&loaded, options);
                    reservation.reserve_additional(decode_bytes)?;
                    let mut pages = Vec::new();
                    prepare_loaded_page_spec(loaded, options, |page| {
                        pages.push(page);
                        Ok(())
                    })?;
                    let prepared_bytes = pages.iter().map(PreparedPage::payload_bytes).sum::<u64>();
                    reservation.shrink_to(prepared_bytes);
                    for page in pages {
                        write_counted_page(pdf, page, &mut page_count, options)?;
                    }
                    drop(reservation);
                }
                processed += 1;
                on_processed(processed);
            }
            metrics = budget.metrics();
            Ok(())
        }
        #[cfg(target_family = "wasm")]
        {
            let _ = worker_threads;
            for spec in std::iter::once(first_spec).chain(page_specs.by_ref()) {
                prepare_input_page_spec(spec, options, None, |page| {
                    write_counted_page(pdf, page, &mut page_count, options)
                })?;
                processed += 1;
                on_processed(processed);
            }
            Ok(())
        }
    })
    .map_err(map_output_limit_error)?;
    Ok((output.into_inner(), metrics))
}

fn write_pdf_paths_impl<W, I, P>(
    output: W,
    output_path: &Path,
    page_specs: I,
    options: &PdfBuildOptions,
    mut on_processed: P,
) -> Result<(W, PipelineMetrics)>
where
    W: Write,
    I: IntoIterator<Item = Result<PageSpec<PathBuf>>>,
    P: FnMut(usize),
{
    let mut page_specs = page_specs.into_iter().peekable();
    if page_specs.peek().is_none() {
        return Err("At least one image input is required".into());
    }

    let worker_threads = options
        .worker_threads
        .clamp(1, evb_native_support::MAX_WORKER_THREADS);
    let max_output_bytes = effective_max_output_bytes(options);
    let output = OutputLimitWriter::new(output, max_output_bytes);
    let mut page_count = 0usize;
    let mut processed = 0usize;
    #[cfg_attr(target_family = "wasm", allow(unused_mut))]
    let mut metrics = PipelineMetrics::default();
    let output = write_pdf_to_writer(output, options.provenance_stamp_hex.as_deref(), |pdf| {
        #[cfg(not(target_family = "wasm"))]
        {
            if worker_threads > 1 {
                metrics = run_path_pipeline(
                    pdf,
                    output_path,
                    &mut page_specs,
                    options,
                    worker_threads,
                    &mut page_count,
                    &mut processed,
                    &mut on_processed,
                )?;
                return Ok(());
            }

            let budget =
                PipelineBudget::new(options.max_open_input_fds, options.max_in_flight_bytes);
            for (seq, spec) in page_specs.by_ref().enumerate() {
                let spec = spec?;
                if spec.streams_frames_path() {
                    let mut fd_permit = budget.acquire_standalone_fd(seq)?;
                    let opened = open_single_page_spec_files(spec, output_path)?;
                    fd_permit.release_transient_output_slot();
                    prepare_input_page_spec(
                        opened,
                        options,
                        Some(TiffBudget::Standalone(&budget, seq)),
                        |page| write_counted_page(pdf, page, &mut page_count, options),
                    )?;
                    drop(fd_permit);
                } else {
                    let mut reservation = budget.empty_reservation(seq);
                    let loaded = load_path_page_spec(
                        spec,
                        output_path,
                        options,
                        Some((&budget, seq, &mut reservation)),
                    )?;
                    let decode_bytes = estimate_loaded_spec_decode_bytes(&loaded, options);
                    reservation.reserve_additional(decode_bytes)?;
                    let mut pages = Vec::new();
                    prepare_loaded_page_spec(loaded, options, |page| {
                        pages.push(page);
                        Ok(())
                    })?;
                    let prepared_bytes = pages.iter().map(PreparedPage::payload_bytes).sum::<u64>();
                    reservation.shrink_to(prepared_bytes);
                    for page in pages {
                        write_counted_page(pdf, page, &mut page_count, options)?;
                    }
                    drop(reservation);
                }
                processed += 1;
                on_processed(processed);
            }
            metrics = budget.metrics();
            Ok(())
        }
        #[cfg(target_family = "wasm")]
        {
            let _ = worker_threads;
            for spec in page_specs.by_ref() {
                let spec = spec?;
                if spec.streams_frames_path() {
                    let opened = open_single_page_spec_files(spec, output_path)?;
                    prepare_input_page_spec(opened, options, None, |page| {
                        write_counted_page(pdf, page, &mut page_count, options)
                    })?;
                } else {
                    let loaded = load_path_page_spec(spec, output_path, options, None)?;
                    prepare_loaded_page_spec(loaded, options, |page| {
                        write_counted_page(pdf, page, &mut page_count, options)
                    })?;
                }
                processed += 1;
                on_processed(processed);
            }
            Ok(())
        }
    })
    .map_err(map_output_limit_error)?;
    Ok((output.into_inner(), metrics))
}

fn effective_max_output_bytes(options: &PdfBuildOptions) -> u64 {
    if options.allow_large_output {
        options.max_output_bytes
    } else {
        options.max_output_bytes.min(PDF_COMBINE_MAX_OUTPUT_BYTES)
    }
}

fn map_output_limit_error(error: Box<dyn Error>) -> Box<dyn Error> {
    if is_output_limit_exceeded(error.as_ref()) {
        too_large_error(error.to_string())
    } else {
        error
    }
}

fn write_counted_page<W: Write>(
    pdf: &mut PdfWriter<W>,
    page: PreparedPage,
    page_count: &mut usize,
    options: &PdfBuildOptions,
) -> Result<()> {
    *page_count = next_page_count_with_limit(*page_count, options.max_pages)?;
    write_prepared_page(pdf, page)
}

enum PreparedPage {
    Image {
        page: ImagePage,
        page_size: Option<PdfPageSize>,
        placement: Option<PdfImagePlacement>,
        rotation_degrees: u16,
    },
    Layered(Box<LayeredPdfPage>),
    SoftLayered(Box<SoftLayeredPdfPage>),
    AffineMaskedLayered(Box<AffineMaskedLayeredPdfPage>),
    Mask(MaskPdfPage),
}

impl PreparedPage {
    #[cfg(not(target_family = "wasm"))]
    fn payload_bytes(&self) -> u64 {
        match self {
            Self::Image { page, .. } => page.payload_bytes(),
            Self::Layered(page) => page.payload_bytes(),
            Self::SoftLayered(page) => page.payload_bytes(),
            Self::AffineMaskedLayered(page) => page.payload_bytes(),
            Self::Mask(page) => page.payload_bytes(),
        }
    }
}

fn write_prepared_page<W: Write>(pdf: &mut PdfWriter<W>, page: PreparedPage) -> Result<()> {
    match page {
        PreparedPage::Image {
            page,
            page_size: Some(page_size),
            placement,
            rotation_degrees,
        } => pdf.add_page_with_size_and_rotation(
            &page,
            &page_size,
            placement.as_ref(),
            rotation_degrees,
        ),
        PreparedPage::Image {
            page,
            page_size: None,
            placement: None,
            rotation_degrees,
        } => pdf.add_page_with_rotation(&page, rotation_degrees),
        PreparedPage::Image {
            page_size: None,
            placement: Some(_),
            ..
        } => Err("Image placement requires an explicit page size".into()),
        PreparedPage::Layered(page) => pdf.add_layered_page(&page),
        PreparedPage::SoftLayered(page) => pdf.add_soft_layered_page(&page),
        PreparedPage::AffineMaskedLayered(page) => pdf.add_affine_masked_layered_page(&page),
        PreparedPage::Mask(page) => pdf.add_mask_page(&page),
    }
}

enum LoadedSource<'a> {
    FileBytes {
        label: PathBuf,
        data: Vec<u8>,
    },
    Bytes {
        file_name: &'a str,
        data: &'a [u8],
    },
    Netpbm {
        label: PathBuf,
        image: OwnedNetpbm,
    },
    Pbm {
        label: PathBuf,
        image: PbmP4Image,
    },
    /// Single-frame TIFF decoded directly from its seekable file handle so
    /// `FramePolicy::ExactlyOne` (compact manifest / layered) does not buffer
    /// the whole TIFF file through `EVB_PDF_COMBINE_MAX_INPUT_MB`.
    DecodedExactImage {
        label: PathBuf,
        page: Option<ImagePage>,
        page_count: usize,
    },
}

impl<'a> LoadedSource<'a> {
    fn label(&self) -> String {
        match self {
            Self::FileBytes { label, .. }
            | Self::Netpbm { label, .. }
            | Self::Pbm { label, .. }
            | Self::DecodedExactImage { label, .. } => label.display().to_string(),
            Self::Bytes { file_name, .. } => (*file_name).to_string(),
        }
    }

    #[cfg(not(target_family = "wasm"))]
    fn byte_len(&self) -> u64 {
        match self {
            Self::FileBytes { data, .. } => data.len() as u64,
            Self::Bytes { data, .. } => data.len() as u64,
            Self::Netpbm { image, .. } => image.pixels.len() as u64,
            Self::Pbm { image, .. } => image.bitmap.len() as u64,
            Self::DecodedExactImage { page, .. } => {
                page.as_ref().map_or(0, ImagePage::payload_bytes)
            }
        }
    }

    fn is_pbm(&self) -> bool {
        match self {
            Self::Pbm { .. } => true,
            Self::FileBytes { label, .. }
            | Self::Netpbm { label, .. }
            | Self::DecodedExactImage { label, .. } => path_has_extension(label, &["pbm"]),
            Self::Bytes { file_name, .. } => file_name
                .rsplit_once('.')
                .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("pbm")),
        }
    }
}

#[derive(Clone, Copy)]
enum LoadKind {
    Image {
        black_and_white: bool,
        auto_unprocessed: bool,
    },
    Mask {
        allow_jbig2: bool,
    },
    SoftAlpha,
}

impl LoadKind {
    fn is_seekable_exact_tiff(self, path: &Path) -> bool {
        matches!(
            self,
            Self::Image {
                black_and_white: false,
                auto_unprocessed: true,
            }
        ) && path_has_extension(path, &["tif", "tiff"])
    }
}

/// Receives a Netpbm raster's checked size before the raster is allocated.
type RasterAdmission<'r> = &'r mut dyn FnMut(u64) -> Result<()>;

fn load_open_file_source(
    label: PathBuf,
    file: File,
    kind: LoadKind,
    options: &PdfBuildOptions,
    tiff_budget: Option<TiffBudget<'_, '_>>,
    admit_raster: RasterAdmission<'_>,
) -> Result<LoadedSource<'static>> {
    #[cfg(test)]
    if label.file_name().and_then(|name| name.to_str()) == Some("__test_force_worker_panic__.pgm") {
        panic!("forced worker panic for test");
    }
    match kind {
        LoadKind::Image {
            black_and_white,
            auto_unprocessed,
        } => {
            if black_and_white {
                let image = read_netpbm_file_admitted(file, options.max_pixels, admit_raster)?;
                return Ok(LoadedSource::Netpbm { label, image });
            }
            if auto_unprocessed && path_has_extension(&label, &["tif", "tiff"]) {
                let source_label = label.display().to_string();
                let mut first = None;
                let page_count = visit_tiff_pdf_pages_from_file_budgeted(
                    file,
                    &source_label,
                    options.max_pixels,
                    options.default_dpi,
                    options.max_tiff_frames,
                    tiff_budget,
                    |page| {
                        if first.is_none() {
                            first = Some(page);
                        }
                        Ok(())
                    },
                )?;
                return Ok(LoadedSource::DecodedExactImage {
                    label,
                    page: first,
                    page_count,
                });
            }
            if path_has_extension(&label, &["pbm"]) {
                let image =
                    read_pbm_p4_file_admitted(file, options.max_bilevel_pixels, admit_raster)?;
                return Ok(LoadedSource::Pbm { label, image });
            }
            if path_has_extension(&label, &["pgm", "ppm"]) {
                let image = read_netpbm_file_admitted(file, options.max_pixels, admit_raster)?;
                return Ok(LoadedSource::Netpbm { label, image });
            }
            let data = read_file(file)?;
            Ok(LoadedSource::FileBytes { label, data })
        }
        LoadKind::Mask { allow_jbig2 } => {
            if path_has_extension(&label, &["png"])
                || (allow_jbig2 && name_has_extension(&label.to_string_lossy(), &["jb2e"]))
            {
                let data = read_file(file)?;
                return Ok(LoadedSource::FileBytes { label, data });
            }
            let image = read_pbm_p4_file_admitted(file, options.max_bilevel_pixels, admit_raster)?;
            Ok(LoadedSource::Pbm { label, image })
        }
        LoadKind::SoftAlpha => {
            let image = read_netpbm_file_admitted(file, options.max_pixels, admit_raster)?;
            Ok(LoadedSource::Netpbm { label, image })
        }
    }
}

fn validate_open_input_file_is_regular(label: &Path, file: &File) -> Result<()> {
    let metadata = file
        .metadata()
        .map_err(|error| NativeError::new(NativeErrorCode::Io, error.to_string()))?;
    if !metadata.is_file() {
        return Err(Box::new(NativeError::new(
            NativeErrorCode::NativeFailure,
            format!("Input is not a regular file: {}", label.display()),
        )));
    }
    Ok(())
}

fn load_input_source<'a>(
    source: InputSource<'a>,
    kind: LoadKind,
    options: &PdfBuildOptions,
    #[cfg_attr(target_family = "wasm", allow(unused_variables, unused_mut))]
    mut reservation: Option<&mut PageBytesReservation<'_>>,
) -> Result<LoadedSource<'a>> {
    match source {
        InputSource::File { label, file } => {
            validate_open_input_file_is_regular(&label, &file)?;
            if kind.is_seekable_exact_tiff(&label) {
                #[cfg(not(target_family = "wasm"))]
                let tiff_budget = reservation.map(TiffBudget::Page);
                #[cfg(target_family = "wasm")]
                let tiff_budget = None;
                return load_open_file_source(label, file, kind, options, tiff_budget, &mut |_| {
                    Ok(())
                });
            }
            #[cfg(not(target_family = "wasm"))]
            let base_held = if let Some(reservation) = reservation.as_deref_mut() {
                let base = reservation.held_bytes();
                let est = file.metadata().map_or(0, |metadata| metadata.len());
                reservation.reserve_additional(est)?;
                Some(base)
            } else {
                None
            };
            let loaded = load_open_file_source(label, file, kind, options, None, &mut |raster| {
                #[cfg(not(target_family = "wasm"))]
                if let (Some(base), Some(reservation)) = (base_held, reservation.as_deref_mut()) {
                    reservation.grow_to(base.saturating_add(raster))?;
                }
                #[cfg(target_family = "wasm")]
                let _ = raster;
                Ok(())
            })?;
            #[cfg(not(target_family = "wasm"))]
            if let (Some(base), Some(reservation)) = (base_held, reservation) {
                let target = base.saturating_add(loaded.byte_len());
                reservation.reconcile_to(target)?;
            }
            Ok(loaded)
        }
        InputSource::Bytes { file_name, data } => {
            #[cfg(not(target_family = "wasm"))]
            if let Some(reservation) = reservation {
                reservation.reserve_additional(data.len() as u64)?;
            }
            Ok(LoadedSource::Bytes { file_name, data })
        }
    }
}

fn map_page_spec_with_kind<S, T>(
    spec: PageSpec<S>,
    mut mapper: impl FnMut(S, LoadKind) -> Result<T>,
) -> Result<PageSpec<T>> {
    Ok(match spec {
        PageSpec::Image {
            page_size,
            placement,
            rotation_degrees,
            image,
            frames,
        } => {
            let black_and_white = image.processing == ImageProcessing::BlackAndWhite;
            let auto_unprocessed = image.visits_every_frame();
            PageSpec::Image {
                page_size,
                placement,
                rotation_degrees,
                image: ImageSpec {
                    source: mapper(
                        image.source,
                        LoadKind::Image {
                            black_and_white,
                            auto_unprocessed,
                        },
                    )?,
                    compression: image.compression,
                    processing: image.processing,
                    size_guardrail: image.size_guardrail,
                },
                frames,
            }
        }
        PageSpec::Layered {
            page_size,
            background,
            foreground_mask,
            foreground_color,
        } => {
            let black_and_white = background.processing == ImageProcessing::BlackAndWhite;
            let auto_unprocessed = background.visits_every_frame();
            PageSpec::Layered {
                page_size,
                background: ImageSpec {
                    source: mapper(
                        background.source,
                        LoadKind::Image {
                            black_and_white,
                            auto_unprocessed,
                        },
                    )?,
                    compression: background.compression,
                    processing: background.processing,
                    size_guardrail: background.size_guardrail,
                },
                foreground_mask: mapper(foreground_mask, LoadKind::Mask { allow_jbig2: false })?,
                foreground_color,
            }
        }
        PageSpec::SoftLayered {
            page_size,
            background,
            foreground_alpha,
            foreground_color,
        } => {
            let black_and_white = background.processing == ImageProcessing::BlackAndWhite;
            let auto_unprocessed = background.visits_every_frame();
            PageSpec::SoftLayered {
                page_size,
                background: ImageSpec {
                    source: mapper(
                        background.source,
                        LoadKind::Image {
                            black_and_white,
                            auto_unprocessed,
                        },
                    )?,
                    compression: background.compression,
                    processing: background.processing,
                    size_guardrail: background.size_guardrail,
                },
                foreground_alpha: mapper(foreground_alpha, LoadKind::SoftAlpha)?,
                foreground_color,
            }
        }
        PageSpec::AffineMaskedLayered {
            page_size,
            background,
            foreground,
            foreground_mask,
            foreground_mask_decode,
            foreground_matrix,
        } => {
            let bg_bw = background.processing == ImageProcessing::BlackAndWhite;
            let bg_auto = background.visits_every_frame();
            let fg_bw = foreground.processing == ImageProcessing::BlackAndWhite;
            let fg_auto = foreground.visits_every_frame();
            PageSpec::AffineMaskedLayered {
                page_size,
                background: ImageSpec {
                    source: mapper(
                        background.source,
                        LoadKind::Image {
                            black_and_white: bg_bw,
                            auto_unprocessed: bg_auto,
                        },
                    )?,
                    compression: background.compression,
                    processing: background.processing,
                    size_guardrail: background.size_guardrail,
                },
                foreground: ImageSpec {
                    source: mapper(
                        foreground.source,
                        LoadKind::Image {
                            black_and_white: fg_bw,
                            auto_unprocessed: fg_auto,
                        },
                    )?,
                    compression: foreground.compression,
                    processing: foreground.processing,
                    size_guardrail: foreground.size_guardrail,
                },
                foreground_mask: mapper(foreground_mask, LoadKind::Mask { allow_jbig2: true })?,
                foreground_mask_decode,
                foreground_matrix,
            }
        }
        PageSpec::Mask {
            page_size,
            foreground_mask,
        } => PageSpec::Mask {
            page_size,
            foreground_mask: mapper(foreground_mask, LoadKind::Mask { allow_jbig2: false })?,
        },
    })
}

fn load_input_page_spec_budgeted<'a>(
    spec: PdfPageSpec<'a>,
    options: &PdfBuildOptions,
    mut reservation: Option<&mut PageBytesReservation<'_>>,
) -> Result<PageSpec<LoadedSource<'a>>> {
    map_page_spec_with_kind(spec, |source, kind| {
        load_input_source(source, kind, options, reservation.as_deref_mut())
    })
}

fn open_single_page_spec_files(
    spec: PageSpec<PathBuf>,
    output_path: &Path,
) -> Result<PageSpec<InputSource<'static>>> {
    spec.map_sources(&mut |path| {
        let file = open_validated_input_file(&path, output_path)?;
        Ok::<InputSource<'static>, Box<dyn Error>>(InputSource::File { label: path, file })
    })
}

#[cfg(not(target_family = "wasm"))]
type PathLoadBudget<'a, 'b> = (&'a PipelineBudget, usize, &'b mut PageBytesReservation<'a>);

#[cfg(target_family = "wasm")]
type PathLoadBudget<'a, 'b> = (&'a PipelineBudget, usize, &'b mut PageBytesReservation<'a>);

fn load_single_path_source(
    path: PathBuf,
    output_path: &Path,
    kind: LoadKind,
    options: &PdfBuildOptions,
    #[cfg_attr(target_family = "wasm", allow(unused_variables, unused_mut))]
    mut load_budget: Option<PathLoadBudget<'_, '_>>,
) -> Result<LoadedSource<'static>> {
    #[cfg(not(target_family = "wasm"))]
    let mut fd_permit = if let Some((budget, seq, _)) = load_budget.as_ref() {
        Some(budget.acquire_standalone_fd(*seq)?)
    } else {
        None
    };

    let file = open_validated_input_file(&path, output_path)?;

    // Release the transient output-path check slot immediately once
    // `open_validated_input_file` returns, keeping only the single open input FD.
    #[cfg(not(target_family = "wasm"))]
    if let Some(permit) = fd_permit.as_mut() {
        permit.release_transient_output_slot();
    }

    let loaded = if kind.is_seekable_exact_tiff(&path) {
        #[cfg(not(target_family = "wasm"))]
        let tiff_budget = load_budget
            .as_mut()
            .map(|(_, _, reservation)| TiffBudget::Page(reservation));
        #[cfg(target_family = "wasm")]
        let tiff_budget = None;
        load_open_file_source(path, file, kind, options, tiff_budget, &mut |_| Ok(()))?
    } else {
        #[cfg(not(target_family = "wasm"))]
        let base_held = if let Some((_, _, reservation)) = load_budget.as_mut() {
            let base = reservation.held_bytes();
            let est = file.metadata().map_or(0, |metadata| metadata.len());
            reservation.reserve_additional(est)?;
            Some(base)
        } else {
            None
        };
        let loaded = load_open_file_source(path, file, kind, options, None, &mut |raster| {
            #[cfg(not(target_family = "wasm"))]
            if let (Some(base), Some((_, _, reservation))) = (base_held, load_budget.as_mut()) {
                reservation.grow_to(base.saturating_add(raster))?;
            }
            #[cfg(target_family = "wasm")]
            let _ = raster;
            Ok(())
        })?;
        #[cfg(not(target_family = "wasm"))]
        if let (Some(base), Some((_, _, reservation))) = (base_held, load_budget.as_mut()) {
            let target = base.saturating_add(loaded.byte_len());
            reservation.reconcile_to(target)?;
        }
        loaded
    };

    // Drop the open input FD permit immediately before any decode/encode work.
    #[cfg(not(target_family = "wasm"))]
    drop(fd_permit);

    Ok(loaded)
}

fn load_path_page_spec(
    spec: PageSpec<PathBuf>,
    output_path: &Path,
    options: &PdfBuildOptions,
    mut load_budget: Option<PathLoadBudget<'_, '_>>,
) -> Result<PageSpec<LoadedSource<'static>>> {
    map_page_spec_with_kind(spec, |path, kind| {
        let per_file = load_budget
            .as_mut()
            .map(|(budget, seq, reservation)| (*budget, *seq, &mut **reservation));
        load_single_path_source(path, output_path, kind, options, per_file)
    })
}

#[cfg(not(target_family = "wasm"))]
fn estimate_loaded_spec_decode_bytes(
    spec: &PageSpec<LoadedSource<'_>>,
    options: &PdfBuildOptions,
) -> u64 {
    match spec {
        PageSpec::Image { image, .. } => estimate_image_spec_decode_bytes(image, options),
        PageSpec::Layered {
            background,
            foreground_mask,
            ..
        } => estimate_image_spec_decode_bytes(background, options).saturating_add(
            estimate_mask_decode_bytes(foreground_mask, options.max_bilevel_pixels),
        ),
        PageSpec::SoftLayered {
            background,
            foreground_alpha,
            ..
        } => estimate_image_spec_decode_bytes(background, options).saturating_add(
            estimate_soft_mask_decode_bytes(foreground_alpha, options.max_pixels),
        ),
        PageSpec::AffineMaskedLayered {
            background,
            foreground,
            foreground_mask,
            ..
        } => estimate_image_spec_decode_bytes(background, options)
            .saturating_add(estimate_image_spec_decode_bytes(foreground, options))
            .saturating_add(estimate_mask_decode_bytes(
                foreground_mask,
                options.max_bilevel_pixels,
            )),
        PageSpec::Mask {
            foreground_mask, ..
        } => estimate_mask_decode_bytes(foreground_mask, options.max_bilevel_pixels),
    }
}

#[cfg(not(target_family = "wasm"))]
fn estimate_image_spec_decode_bytes(
    image: &ImageSpec<LoadedSource<'_>>,
    options: &PdfBuildOptions,
) -> u64 {
    if image.processing == ImageProcessing::BlackAndWhite {
        return match &image.source {
            LoadedSource::Netpbm { image, .. } => u64::from(image.width)
                .saturating_mul(u64::from(image.height))
                .saturating_mul(3),
            LoadedSource::FileBytes { data, .. } => {
                parse_netpbm(data, options.max_pixels).ok().map_or(0, |r| {
                    u64::from(r.width)
                        .saturating_mul(u64::from(r.height))
                        .saturating_mul(3)
                })
            }
            LoadedSource::Bytes { data, .. } => {
                parse_netpbm(data, options.max_pixels).ok().map_or(0, |r| {
                    u64::from(r.width)
                        .saturating_mul(u64::from(r.height))
                        .saturating_mul(3)
                })
            }
            LoadedSource::Pbm { .. } | LoadedSource::DecodedExactImage { .. } => 0,
        };
    }

    let compression = PdfImageCompression::from(image.compression);
    match &image.source {
        LoadedSource::DecodedExactImage { .. } => 0,
        LoadedSource::Pbm { image, .. } => {
            estimate_bilevel_encode_peak_bytes(image.width, image.height)
        }
        // The loaded raster is already reserved; admit the encoder that runs
        // while it is still live.
        LoadedSource::Netpbm { image: owned, .. } => estimate_netpbm_page_encode_bytes(
            owned.width,
            owned.height,
            owned.channels,
            compression,
        ),
        LoadedSource::FileBytes { label, data } => {
            let label_str = label.to_string_lossy();
            if image.visits_every_frame() && name_has_extension(&label_str, &["tif", "tiff"]) {
                return probe_tiff_pdf_peak_bytes_from_bytes(
                    data,
                    options.max_pixels,
                    options.max_tiff_frames,
                );
            }
            let ext = label
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            estimate_image_bytes_decode_bytes(ext, data, compression, options.max_pixels)
        }
        LoadedSource::Bytes { file_name, data } => {
            if image.visits_every_frame() && name_has_extension(file_name, &["tif", "tiff"]) {
                return probe_tiff_pdf_peak_bytes_from_bytes(
                    data,
                    options.max_pixels,
                    options.max_tiff_frames,
                );
            }
            let ext = file_name
                .rsplit_once('.')
                .map(|(_, extension)| extension)
                .unwrap_or("");
            // Borrowed JPEG and JPEG 2000 bytes, and PNG bytes read for the
            // automatic Flate path, are copied into an owned buffer first.
            let copies_source = ["jpg", "jpeg", "jp2"]
                .iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate))
                || (ext.eq_ignore_ascii_case("png")
                    && matches!(compression, PdfImageCompression::Auto));
            let source_copy_bytes = if copies_source { data.len() as u64 } else { 0 };
            estimate_image_bytes_decode_bytes(ext, data, compression, options.max_pixels)
                .saturating_add(source_copy_bytes)
        }
    }
}

#[cfg(not(target_family = "wasm"))]
fn estimate_mask_decode_bytes(source: &LoadedSource<'_>, max_pixels: u64) -> u64 {
    let (extension, data) = match source {
        LoadedSource::Pbm { image, .. } => {
            return estimate_bilevel_encode_peak_bytes(image.width, image.height);
        }
        LoadedSource::Netpbm { .. } | LoadedSource::DecodedExactImage { .. } => return 0,
        LoadedSource::FileBytes { label, data } => (
            label
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or(""),
            data.as_slice(),
        ),
        LoadedSource::Bytes { file_name, data } => (
            file_name
                .rsplit_once('.')
                .map(|(_, extension)| extension)
                .unwrap_or(""),
            *data,
        ),
    };
    if extension.eq_ignore_ascii_case("png") {
        estimate_png_mask_decode_bytes(data, max_pixels)
    } else if extension.eq_ignore_ascii_case("jb2e") {
        (data.len() as u64).saturating_mul(8)
    } else {
        // `read_loaded_mask_bitmap` parses every other byte-backed mask as PBM
        // P4, copying the bitmap before encoding it.
        estimate_pbm_bytes_encode_bytes(data, max_pixels)
    }
}

/// A PNG mask decodes to 1 Bpp gray, packs into a bitmap while the gray
/// buffer is live, then encodes the bitmap through `BilevelStream::encode`.
#[cfg(not(target_family = "wasm"))]
fn estimate_png_mask_decode_bytes(bytes: &[u8], max_pixels: u64) -> u64 {
    evb_raster_io::read_png_metadata(
        bytes,
        evb_raster_io::PassthroughLimits {
            max_pixels,
            max_dimension: u32::MAX,
            max_icc_profile_bytes: 16 * 1024 * 1024,
        },
    )
    .ok()
    .map_or(0, |meta| {
        let gray_bytes = u64::from(meta.width).saturating_mul(u64::from(meta.height));
        let bitmap_bytes = u64::from(meta.width)
            .div_ceil(8)
            .saturating_mul(u64::from(meta.height));
        gray_bytes
            .saturating_add(bitmap_bytes)
            .saturating_add(estimate_bilevel_encode_peak_bytes(meta.width, meta.height))
    })
}

/// `read_loaded_soft_mask` keeps the alpha raster live while it copies a
/// byte-backed raster, converts RGB to luma, and Flate-encodes the result.
#[cfg(not(target_family = "wasm"))]
fn estimate_soft_mask_decode_bytes(source: &LoadedSource<'_>, max_pixels: u64) -> u64 {
    let (width, height, channels, copied) = match source {
        LoadedSource::Netpbm { image, .. } => (image.width, image.height, image.channels, false),
        LoadedSource::FileBytes { data, .. } => match parse_netpbm(data, max_pixels) {
            Ok(parsed) => (parsed.width, parsed.height, parsed.channels, true),
            Err(_) => return 0,
        },
        LoadedSource::Bytes { data, .. } => match parse_netpbm(data, max_pixels) {
            Ok(parsed) => (parsed.width, parsed.height, parsed.channels, true),
            Err(_) => return 0,
        },
        LoadedSource::Pbm { .. } | LoadedSource::DecodedExactImage { .. } => return 0,
    };
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    let copy_bytes = if copied {
        pixels.saturating_mul(u64::from(channels))
    } else {
        0
    };
    let luma_bytes = if channels == 3 { pixels } else { 0 };
    copy_bytes.saturating_add(luma_bytes).saturating_add(
        estimate_up_filtered_flate_working_set_bytes(u64::from(width), u64::from(height)),
    )
}

fn prepare_input_page_spec(
    spec: PdfPageSpec<'_>,
    options: &PdfBuildOptions,
    tiff_budget: Option<TiffBudget<'_, '_>>,
    mut on_page: impl FnMut(PreparedPage) -> Result<()>,
) -> Result<()> {
    if spec.streams_frames() {
        if let PageSpec::Image {
            page_size,
            placement,
            rotation_degrees,
            image,
            ..
        } = spec
        {
            match image.source {
                InputSource::File { label, file } => {
                    validate_open_input_file_is_regular(&label, &file)?;
                    visit_image_pages_from_file(
                        &label,
                        file,
                        options.max_pixels,
                        options.default_dpi,
                        options.max_tiff_frames,
                        tiff_budget,
                        |page| {
                            on_page(PreparedPage::Image {
                                page,
                                page_size,
                                placement,
                                rotation_degrees,
                            })
                        },
                    )?;
                }
                InputSource::Bytes { file_name, data } => {
                    #[cfg(not(target_family = "wasm"))]
                    let (mut source_reservation, passthrough_budget) = match tiff_budget {
                        Some(TiffBudget::Standalone(pipeline_budget, seq)) => (
                            Some(pipeline_budget.reserve_standalone_bytes(seq, data.len() as u64)?),
                            None,
                        ),
                        other => (None, other),
                    };
                    #[cfg(not(target_family = "wasm"))]
                    let effective_budget = match source_reservation.as_mut() {
                        Some(reservation) => Some(TiffBudget::StreamedPage(reservation)),
                        None => passthrough_budget,
                    };
                    #[cfg(target_family = "wasm")]
                    let effective_budget = tiff_budget;
                    visit_image_pages_from_bytes(
                        file_name,
                        data,
                        options.max_pixels,
                        options.default_dpi,
                        options.max_tiff_frames,
                        effective_budget,
                        |page| {
                            on_page(PreparedPage::Image {
                                page,
                                page_size,
                                placement,
                                rotation_degrees,
                            })
                        },
                    )?;
                }
            }
            return Ok(());
        }
    }
    let loaded = load_input_page_spec_budgeted(spec, options, None)?;
    prepare_loaded_page_spec(loaded, options, on_page)
}

fn prepare_loaded_page_spec(
    spec: PageSpec<LoadedSource<'_>>,
    options: &PdfBuildOptions,
    mut on_page: impl FnMut(PreparedPage) -> Result<()>,
) -> Result<()> {
    match spec {
        PageSpec::Image {
            page_size,
            placement,
            rotation_degrees,
            image,
            frames,
        } => prepare_loaded_image_spec(
            page_size,
            placement,
            rotation_degrees,
            image,
            frames,
            options,
            on_page,
        ),
        PageSpec::Layered {
            page_size,
            background,
            foreground_mask,
            foreground_color,
        } => {
            let background = read_exact_loaded_image(background, options, Some(page_size))?;
            let foreground_mask = read_loaded_mask(foreground_mask, options.max_bilevel_pixels)?;
            on_page(PreparedPage::Layered(Box::new(LayeredPdfPage {
                page_size,
                background: image_page_to_layered_image(background)?,
                foreground_mask,
                foreground_color,
            })))
        }
        PageSpec::SoftLayered {
            page_size,
            background,
            foreground_alpha,
            foreground_color,
        } => {
            let background = read_exact_loaded_image(background, options, Some(page_size))?;
            let foreground_alpha = read_loaded_soft_mask(foreground_alpha, options.max_pixels)?;
            on_page(PreparedPage::SoftLayered(Box::new(SoftLayeredPdfPage {
                page_size,
                background: image_page_to_layered_image(background)?,
                foreground_alpha,
                foreground_color,
            })))
        }
        PageSpec::AffineMaskedLayered {
            page_size,
            background,
            foreground,
            foreground_mask,
            foreground_mask_decode,
            foreground_matrix,
        } => {
            let background = read_exact_loaded_image(background, options, Some(page_size))?;
            let foreground = read_exact_loaded_image(foreground, options, Some(page_size))?;
            let foreground_mask = read_loaded_affine_foreground_mask(
                foreground_mask,
                foreground.width,
                foreground.height,
                options.max_bilevel_pixels,
                foreground_mask_decode,
            )?;
            on_page(PreparedPage::AffineMaskedLayered(Box::new(
                AffineMaskedLayeredPdfPage {
                    page_size,
                    background: image_page_to_layered_image(background)?,
                    foreground: image_page_to_layered_image(foreground)?,
                    foreground_mask,
                    foreground_matrix,
                },
            )))
        }
        PageSpec::Mask {
            page_size,
            foreground_mask,
        } => on_page(PreparedPage::Mask(MaskPdfPage {
            page_size,
            foreground_mask: read_loaded_mask(foreground_mask, options.max_bilevel_pixels)?,
        })),
    }
}

fn prepare_loaded_image_spec(
    page_size: Option<PdfPageSize>,
    placement: Option<PdfImagePlacement>,
    rotation_degrees: u16,
    image: ImageSpec<LoadedSource<'_>>,
    frames: FramePolicy,
    options: &PdfBuildOptions,
    mut on_page: impl FnMut(PreparedPage) -> Result<()>,
) -> Result<()> {
    let page = match frames {
        FramePolicy::All if image.visits_every_frame() => {
            visit_automatic_loaded_pages(image.source, options, |page| {
                on_page(PreparedPage::Image {
                    page,
                    page_size,
                    placement,
                    rotation_degrees,
                })
            })?;
            return Ok(());
        }
        FramePolicy::All => read_processed_loaded_image(image, options, page_size)?,
        FramePolicy::ExactlyOne => read_exact_loaded_image(image, options, page_size)?,
    };
    on_page(PreparedPage::Image {
        page,
        page_size,
        placement,
        rotation_degrees,
    })
}

#[cfg(target_family = "wasm")]
pub(crate) struct PipelineBudget;

#[cfg(target_family = "wasm")]
pub(crate) struct PageBytesReservation<'a>(std::marker::PhantomData<&'a ()>);

#[cfg(not(target_family = "wasm"))]
#[derive(Debug)]
struct PipelineCancelled;

#[cfg(not(target_family = "wasm"))]
impl std::fmt::Display for PipelineCancelled {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PDF combine pipeline cancelled after an earlier error")
    }
}

#[cfg(not(target_family = "wasm"))]
impl Error for PipelineCancelled {}

#[cfg(not(target_family = "wasm"))]
struct BudgetState {
    open_fds: usize,
    active_bytes: u64,
    next_admit_seq: usize,
    exclusive_seq: Option<usize>,
    min_failed_seq: Option<usize>,
    aborted: bool,
    peak_open_fds: usize,
    peak_in_flight_bytes: u64,
    active_reservations: usize,
    peak_concurrent_decodes: usize,
    active_prepares: usize,
    peak_concurrent_prepares: usize,
    /// Test-only rendezvous: the first workers entering preparation wait
    /// (bounded) until this many are inside together, then the gate opens.
    #[cfg(test)]
    prepare_rendezvous: usize,
}

#[cfg(all(test, not(target_family = "wasm")))]
thread_local! {
    /// Rendezvous size for budgets the current test thread creates.
    static TEST_PREPARE_RENDEZVOUS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(all(test, not(target_family = "wasm")))]
const TEST_PREPARE_RENDEZVOUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(not(target_family = "wasm"))]
impl BudgetState {
    fn is_cancelled_for(&self, seq: usize) -> bool {
        self.aborted || self.min_failed_seq.is_some_and(|failed| seq > failed)
    }

    fn record_byte_peak(&mut self) {
        self.peak_in_flight_bytes = self.peak_in_flight_bytes.max(self.active_bytes);
    }
}

#[cfg(not(target_family = "wasm"))]
pub(crate) struct PipelineBudget {
    max_open_fds: usize,
    max_in_flight_bytes: u64,
    state: Mutex<BudgetState>,
    changed: Condvar,
}

#[cfg(not(target_family = "wasm"))]
impl PipelineBudget {
    pub(crate) fn new(max_open_fds: usize, max_in_flight_bytes: u64) -> Self {
        Self {
            max_open_fds: max_open_fds.max(1),
            max_in_flight_bytes: max_in_flight_bytes.max(1),
            state: Mutex::new(BudgetState {
                open_fds: 0,
                active_bytes: 0,
                next_admit_seq: 0,
                exclusive_seq: None,
                min_failed_seq: None,
                aborted: false,
                peak_open_fds: 0,
                peak_in_flight_bytes: 0,
                active_reservations: 0,
                peak_concurrent_decodes: 0,
                active_prepares: 0,
                peak_concurrent_prepares: 0,
                #[cfg(test)]
                prepare_rendezvous: TEST_PREPARE_RENDEZVOUS.with(std::cell::Cell::get),
            }),
            changed: Condvar::new(),
        }
    }

    fn acquire_admit_turn(&self, seq: usize) -> Result<AdmitTurnGuard<'_>> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if state.is_cancelled_for(seq) {
                return Err(Box::new(PipelineCancelled));
            }
            if state.next_admit_seq == seq {
                return Ok(AdmitTurnGuard {
                    budget: self,
                    seq,
                    released: false,
                });
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn release_admit_turn(&self, seq: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.next_admit_seq == seq {
            state.next_admit_seq = seq.saturating_add(1);
        }
        self.changed.notify_all();
    }

    fn advance_admit_turn_for_streamed_item(&self, seq: usize) {
        self.release_admit_turn(seq);
    }

    pub(crate) fn acquire_standalone_fd(&self, seq: usize) -> Result<FdPermit<'_>> {
        // Reserve up to 2 FD slots during `open_validated_input_file` (1 for
        // the input descriptor + 1 for the transient destination identity check).
        let open_slots = 2usize.min(self.max_open_fds);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if state.is_cancelled_for(seq) {
                return Err(Box::new(PipelineCancelled));
            }
            let fd_ready = state.open_fds == 0
                || state.open_fds.saturating_add(open_slots) <= self.max_open_fds;
            if fd_ready {
                state.open_fds = state.open_fds.saturating_add(open_slots);
                state.peak_open_fds = state.peak_open_fds.max(state.open_fds);
                return Ok(FdPermit {
                    budget: self,
                    held: open_slots,
                });
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    pub(crate) fn empty_reservation(&self, seq: usize) -> PageBytesReservation<'_> {
        PageBytesReservation {
            budget: self,
            seq,
            held_bytes: 0,
            holds_exclusive: false,
            counted_active: false,
        }
    }

    pub(crate) fn reserve_standalone_bytes(
        &self,
        seq: usize,
        bytes: u64,
    ) -> Result<PageBytesReservation<'_>> {
        let mut reservation = self.empty_reservation(seq);
        reservation.reserve_additional(bytes)?;
        Ok(reservation)
    }

    fn reserve_page_bytes(
        &self,
        seq: usize,
        additional: u64,
        reservation: &mut PageBytesReservation<'_>,
    ) -> Result<()> {
        if additional == 0 {
            return Ok(());
        }
        let next_self_bytes = reservation.held_bytes.saturating_add(additional);
        let needs_exclusive = next_self_bytes > self.max_in_flight_bytes;

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if state.is_cancelled_for(seq) {
                return Err(Box::new(PipelineCancelled));
            }
            let can_admit = if needs_exclusive {
                let other_active = state.active_bytes.saturating_sub(reservation.held_bytes);
                state.exclusive_seq.is_none_or(|owner| owner == seq) && other_active == 0
            } else {
                state.exclusive_seq.is_none()
                    && state.active_bytes.saturating_add(additional) <= self.max_in_flight_bytes
            };
            if can_admit {
                if needs_exclusive {
                    state.exclusive_seq = Some(seq);
                    reservation.holds_exclusive = true;
                }
                if !reservation.counted_active {
                    reservation.counted_active = true;
                    state.active_reservations = state.active_reservations.saturating_add(1);
                    state.peak_concurrent_decodes =
                        state.peak_concurrent_decodes.max(state.active_reservations);
                }
                state.active_bytes = state.active_bytes.saturating_add(additional);
                state.record_byte_peak();
                reservation.held_bytes = next_self_bytes;
                return Ok(());
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn release_page_bytes(
        &self,
        seq: usize,
        bytes: u64,
        release_exclusive: bool,
        release_active_slot: bool,
    ) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active_bytes = state.active_bytes.saturating_sub(bytes);
        if release_exclusive && state.exclusive_seq == Some(seq) {
            state.exclusive_seq = None;
        }
        if release_active_slot {
            state.active_reservations = state.active_reservations.saturating_sub(1);
        }
        self.changed.notify_all();
    }

    fn register_external_fds(&self, count: usize) -> FdPermit<'_> {
        if count > 0 {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.open_fds = state.open_fds.saturating_add(count);
            state.peak_open_fds = state.peak_open_fds.max(state.open_fds);
        }
        FdPermit {
            budget: self,
            held: count,
        }
    }

    fn has_external_fd_headroom(&self, worst_case_fds: usize) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.open_fds == 0 || state.open_fds.saturating_add(worst_case_fds) <= self.max_open_fds
    }

    fn release_fds(&self, count: usize) {
        if count == 0 {
            return;
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.open_fds = state.open_fds.saturating_sub(count);
        self.changed.notify_all();
    }

    fn record_failure(&self, seq: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.min_failed_seq = Some(state.min_failed_seq.map_or(seq, |current| current.min(seq)));
        self.changed.notify_all();
    }

    fn abort(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.aborted = true;
        self.changed.notify_all();
    }

    fn enter_prepare(&self) -> PrepareConcurrencyGuard<'_> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active_prepares = state.active_prepares.saturating_add(1);
        state.peak_concurrent_prepares = state.peak_concurrent_prepares.max(state.active_prepares);
        #[cfg(test)]
        if state.prepare_rendezvous > 0 {
            // Serialized admission never brings a second worker in, so the
            // wait times out and the peak stays 1; concurrent admission
            // opens the gate as soon as enough workers arrive.
            let deadline = std::time::Instant::now() + TEST_PREPARE_RENDEZVOUS_TIMEOUT;
            while state.prepare_rendezvous > state.active_prepares {
                let now = std::time::Instant::now();
                if now >= deadline {
                    break;
                }
                state = self
                    .changed
                    .wait_timeout(state, deadline - now)
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .0;
            }
            state.prepare_rendezvous = 0;
            self.changed.notify_all();
        }
        PrepareConcurrencyGuard { budget: self }
    }

    fn exit_prepare(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active_prepares = state.active_prepares.saturating_sub(1);
    }

    pub(crate) fn metrics(&self) -> PipelineMetrics {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        PipelineMetrics {
            peak_open_fds: state.peak_open_fds,
            peak_in_flight_bytes: state.peak_in_flight_bytes,
            peak_concurrent_decodes: state.peak_concurrent_decodes,
            peak_concurrent_prepares: state.peak_concurrent_prepares,
        }
    }
}

#[cfg(not(target_family = "wasm"))]
struct PrepareConcurrencyGuard<'a> {
    budget: &'a PipelineBudget,
}

#[cfg(not(target_family = "wasm"))]
impl Drop for PrepareConcurrencyGuard<'_> {
    fn drop(&mut self) {
        self.budget.exit_prepare();
    }
}

#[cfg(not(target_family = "wasm"))]
struct AdmitTurnGuard<'a> {
    budget: &'a PipelineBudget,
    seq: usize,
    released: bool,
}

#[cfg(not(target_family = "wasm"))]
impl Drop for AdmitTurnGuard<'_> {
    fn drop(&mut self) {
        if !self.released {
            self.released = true;
            self.budget.release_admit_turn(self.seq);
        }
    }
}

#[cfg(not(target_family = "wasm"))]
pub(crate) struct PageBytesReservation<'a> {
    budget: &'a PipelineBudget,
    seq: usize,
    held_bytes: u64,
    holds_exclusive: bool,
    counted_active: bool,
}

#[cfg(not(target_family = "wasm"))]
impl PageBytesReservation<'_> {
    pub(crate) fn held_bytes(&self) -> u64 {
        self.held_bytes
    }

    pub(crate) fn reserve_additional(&mut self, additional: u64) -> Result<()> {
        self.budget.reserve_page_bytes(self.seq, additional, self)
    }

    /// Grows the reservation to `target_bytes`; never shrinks it.
    pub(crate) fn grow_to(&mut self, target_bytes: u64) -> Result<()> {
        if target_bytes > self.held_bytes {
            self.reserve_additional(target_bytes - self.held_bytes)
        } else {
            Ok(())
        }
    }

    fn reconcile_to(&mut self, target_bytes: u64) -> Result<()> {
        self.shrink_to(target_bytes);
        self.grow_to(target_bytes)
    }

    pub(crate) fn shrink_to(&mut self, target_bytes: u64) {
        if target_bytes >= self.held_bytes {
            return;
        }
        let release = self.held_bytes - target_bytes;
        self.held_bytes = target_bytes;
        let release_exclusive =
            self.holds_exclusive && target_bytes <= self.budget.max_in_flight_bytes;
        if release_exclusive {
            self.holds_exclusive = false;
        }
        self.budget
            .release_page_bytes(self.seq, release, release_exclusive, false);
    }
}

#[cfg(not(target_family = "wasm"))]
impl Drop for PageBytesReservation<'_> {
    fn drop(&mut self) {
        if self.held_bytes > 0 || self.holds_exclusive || self.counted_active {
            let held = self.held_bytes;
            let exclusive = self.holds_exclusive;
            let active_slot = self.counted_active;
            self.held_bytes = 0;
            self.holds_exclusive = false;
            self.counted_active = false;
            self.budget
                .release_page_bytes(self.seq, held, exclusive, active_slot);
        }
    }
}

#[cfg(not(target_family = "wasm"))]
pub(crate) struct FdPermit<'a> {
    budget: &'a PipelineBudget,
    held: usize,
}

#[cfg(not(target_family = "wasm"))]
impl FdPermit<'_> {
    pub(crate) fn release_transient_output_slot(&mut self) {
        if self.held > 1 {
            let excess = self.held - 1;
            self.held = 1;
            self.budget.release_fds(excess);
        }
    }
}

#[cfg(not(target_family = "wasm"))]
impl Drop for FdPermit<'_> {
    fn drop(&mut self) {
        if self.held > 0 {
            let count = self.held;
            self.held = 0;
            self.budget.release_fds(count);
        }
    }
}

#[cfg(not(target_family = "wasm"))]
struct PreparedPageError {
    code: Option<NativeErrorCode>,
    message: String,
}

#[cfg(not(target_family = "wasm"))]
impl PreparedPageError {
    fn capture(error: Box<dyn Error>) -> Self {
        Self {
            code: error
                .downcast_ref::<NativeError>()
                .map(|native_error| native_error.code),
            message: error.to_string(),
        }
    }

    fn from_panic(payload: Box<dyn std::any::Any + Send>) -> Self {
        let message = if let Some(text) = payload.downcast_ref::<&str>() {
            format!("PDF combine worker panicked: {text}")
        } else if let Some(text) = payload.downcast_ref::<String>() {
            format!("PDF combine worker panicked: {text}")
        } else {
            "PDF combine worker panicked".to_string()
        };
        Self {
            code: Some(NativeErrorCode::Panic),
            message,
        }
    }

    fn into_error(self) -> Box<dyn Error> {
        match self.code {
            Some(code) => Box::new(NativeError::new(code, self.message)),
            None => self.message.into(),
        }
    }
}

#[cfg(not(target_family = "wasm"))]
type CompletedSlot<'a> =
    std::result::Result<(Vec<PreparedPage>, PageBytesReservation<'a>), PreparedPageError>;

#[cfg(not(target_family = "wasm"))]
struct PipelineQueueState<'a, T> {
    pending: VecDeque<(usize, T)>,
    completed: BTreeMap<usize, CompletedSlot<'a>>,
    in_flight: usize,
    input_closed: bool,
    min_failed_seq: Option<usize>,
    aborted: bool,
}

#[cfg(not(target_family = "wasm"))]
struct PipelineQueue<'a, T> {
    state: Mutex<PipelineQueueState<'a, T>>,
    workers_cv: Condvar,
    writer_cv: Condvar,
}

#[cfg(not(target_family = "wasm"))]
impl<'a, T> PipelineQueue<'a, T> {
    fn new() -> Self {
        Self {
            state: Mutex::new(PipelineQueueState {
                pending: VecDeque::new(),
                completed: BTreeMap::new(),
                in_flight: 0,
                input_closed: false,
                min_failed_seq: None,
                aborted: false,
            }),
            workers_cv: Condvar::new(),
            writer_cv: Condvar::new(),
        }
    }

    fn push_work(&self, seq: usize, item: T) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.pending.push_back((seq, item));
        state.in_flight += 1;
        self.workers_cv.notify_one();
    }

    fn push_immediate_error(&self, seq: usize, error: PreparedPageError) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.min_failed_seq = Some(state.min_failed_seq.map_or(seq, |cur| cur.min(seq)));
        state.completed.insert(seq, Err(error));
        state.in_flight += 1;
        self.workers_cv.notify_all();
        self.writer_cv.notify_one();
    }

    fn pop_work(&self) -> Option<(usize, T)> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if state.aborted {
                return None;
            }
            if let Some((seq, item)) = state.pending.pop_front() {
                if state.min_failed_seq.is_some_and(|failed| seq > failed) {
                    state.in_flight = state.in_flight.saturating_sub(1);
                    self.writer_cv.notify_one();
                    continue;
                }
                return Some((seq, item));
            }
            if state.input_closed {
                return None;
            }
            state = self
                .workers_cv
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn drop_cancelled(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.in_flight = state.in_flight.saturating_sub(1);
        self.writer_cv.notify_one();
    }

    fn complete_work(&self, seq: usize, result: CompletedSlot<'a>, budget: &PipelineBudget) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.aborted || state.min_failed_seq.is_some_and(|failed| seq > failed) {
            drop(result);
            state.in_flight = state.in_flight.saturating_sub(1);
            self.writer_cv.notify_one();
            return;
        }
        if result.is_err() {
            state.min_failed_seq = Some(state.min_failed_seq.map_or(seq, |cur| cur.min(seq)));
            budget.record_failure(seq);
            self.workers_cv.notify_all();
        }
        state.completed.insert(seq, result);
        self.writer_cv.notify_one();
    }

    fn pop_ready(&self, next_write_seq: usize) -> Option<CompletedSlot<'a>> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let result = state.completed.remove(&next_write_seq)?;
        state.in_flight = state.in_flight.saturating_sub(1);
        Some(result)
    }

    fn in_flight(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .in_flight
    }

    fn has_failure(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .min_failed_seq
            .is_some()
    }

    fn wait_for_writer_progress(
        &self,
        next_write_seq: usize,
        max_in_flight: usize,
        can_refill: bool,
    ) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            let ready_to_write = state.completed.contains_key(&next_write_seq);
            let ready_to_refill =
                can_refill && state.min_failed_seq.is_none() && state.in_flight < max_in_flight;
            if state.aborted || state.in_flight == 0 || ready_to_write || ready_to_refill {
                break;
            }
            state = self
                .writer_cv
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn close_input(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.input_closed = true;
        self.workers_cv.notify_all();
    }

    fn abort(&self, budget: &PipelineBudget) {
        budget.abort();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.aborted = true;
        state.pending.clear();
        state.completed.clear();
        self.workers_cv.notify_all();
        self.writer_cv.notify_all();
    }
}

/// Ensures scoped worker threads are always woken and stopped if the writer
/// thread exits via an error or a panic (e.g. inside `on_processed` or `Write`).
#[cfg(not(target_family = "wasm"))]
struct PipelineShutdownGuard<'q, 'b, T> {
    queue: &'q PipelineQueue<'b, T>,
    budget: &'b PipelineBudget,
    completed: bool,
}

#[cfg(not(target_family = "wasm"))]
impl<T> Drop for PipelineShutdownGuard<'_, '_, T> {
    fn drop(&mut self) {
        if self.completed {
            self.queue.close_input();
        } else {
            self.queue.abort(self.budget);
        }
    }
}

#[cfg(not(target_family = "wasm"))]
#[allow(clippy::too_many_arguments)]
fn run_path_pipeline<W, I, P>(
    pdf: &mut PdfWriter<W>,
    output_path: &Path,
    page_specs: &mut std::iter::Peekable<I>,
    options: &PdfBuildOptions,
    worker_threads: usize,
    page_count: &mut usize,
    processed: &mut usize,
    on_processed: &mut P,
) -> Result<PipelineMetrics>
where
    W: Write,
    I: Iterator<Item = Result<PageSpec<PathBuf>>>,
    P: FnMut(usize),
{
    let max_in_flight = (worker_threads * 2).max(2);
    let budget = PipelineBudget::new(options.max_open_input_fds, options.max_in_flight_bytes);
    let queue = PipelineQueue::<PageSpec<PathBuf>>::new();

    let result = std::thread::scope(|scope| -> Result<()> {
        let mut shutdown_guard = PipelineShutdownGuard {
            queue: &queue,
            budget: &budget,
            completed: false,
        };
        for _ in 0..worker_threads {
            let queue = &queue;
            let budget = &budget;
            scope.spawn(move || {
                while let Some((seq, spec)) = queue.pop_work() {
                    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let admit_turn = budget.acquire_admit_turn(seq)?;
                        let mut reservation = budget.empty_reservation(seq);
                        let loaded = load_path_page_spec(
                            spec,
                            output_path,
                            options,
                            Some((budget, seq, &mut reservation)),
                        )?;
                        let decode_bytes = estimate_loaded_spec_decode_bytes(&loaded, options);
                        reservation.reserve_additional(decode_bytes)?;
                        drop(admit_turn);

                        let _prepare_guard = budget.enter_prepare();
                        let mut pages = Vec::new();
                        prepare_loaded_page_spec(loaded, options, |page| {
                            pages.push(page);
                            Ok(())
                        })?;
                        drop(_prepare_guard);
                        let prepared_bytes =
                            pages.iter().map(PreparedPage::payload_bytes).sum::<u64>();
                        reservation.shrink_to(prepared_bytes);
                        Ok::<_, Box<dyn Error>>((pages, reservation))
                    }));
                    let slot = match caught {
                        Ok(Ok(prepared)) => Ok(prepared),
                        Ok(Err(error)) => {
                            if error.downcast_ref::<PipelineCancelled>().is_some() {
                                queue.drop_cancelled();
                                continue;
                            }
                            Err(PreparedPageError::capture(error))
                        }
                        Err(panic_payload) => Err(PreparedPageError::from_panic(panic_payload)),
                    };
                    queue.complete_work(seq, slot, budget);
                }
            });
        }

        let mut next_submit_seq = 0usize;
        let mut next_write_seq = 0usize;
        let mut input_exhausted = false;

        loop {
            // Refill the bounded queue unless we hit a multi-frame TIFF
            // (which streams synchronously once prior pages are drained).
            while !input_exhausted && !queue.has_failure() && queue.in_flight() < max_in_flight {
                let next_is_tiff = matches!(
                    page_specs.peek(),
                    Some(Ok(spec)) if spec.streams_frames_path()
                );
                if next_is_tiff {
                    if queue.in_flight() > 0 {
                        break;
                    }
                    let spec = page_specs.next().expect("peeked TIFF spec")?;
                    let mut fd_permit = budget.acquire_standalone_fd(next_submit_seq)?;
                    let opened = open_single_page_spec_files(spec, output_path)?;
                    fd_permit.release_transient_output_slot();
                    prepare_input_page_spec(
                        opened,
                        options,
                        Some(TiffBudget::Standalone(&budget, next_submit_seq)),
                        |page| write_counted_page(pdf, page, page_count, options),
                    )?;
                    drop(fd_permit);
                    budget.advance_admit_turn_for_streamed_item(next_submit_seq);
                    *processed += 1;
                    on_processed(*processed);
                    next_submit_seq += 1;
                    next_write_seq += 1;
                    continue;
                }
                match page_specs.next() {
                    Some(Ok(spec)) => {
                        queue.push_work(next_submit_seq, spec);
                        next_submit_seq += 1;
                    }
                    Some(Err(error)) => {
                        queue.push_immediate_error(
                            next_submit_seq,
                            PreparedPageError::capture(error),
                        );
                        budget.record_failure(next_submit_seq);
                        next_submit_seq += 1;
                        input_exhausted = true;
                    }
                    None => {
                        input_exhausted = true;
                    }
                }
            }

            // Drain every ready in-order page into the PDF writer.
            let mut wrote_any = false;
            while let Some(slot) = queue.pop_ready(next_write_seq) {
                wrote_any = true;
                match slot {
                    Ok((pages, reservation)) => {
                        let write_res = (|| -> Result<()> {
                            for page in pages {
                                write_counted_page(pdf, page, page_count, options)?;
                            }
                            Ok(())
                        })();
                        drop(reservation);
                        write_res?;
                        *processed += 1;
                        on_processed(*processed);
                        next_write_seq += 1;
                    }
                    Err(error) => {
                        return Err(error.into_error());
                    }
                }
            }

            if input_exhausted && queue.in_flight() == 0 {
                shutdown_guard.completed = true;
                return Ok(());
            }

            if !wrote_any {
                let can_refill = !input_exhausted
                    && !queue.has_failure()
                    && !matches!(
                        page_specs.peek(),
                        Some(Ok(spec)) if spec.streams_frames_path()
                    );
                queue.wait_for_writer_progress(next_write_seq, max_in_flight, can_refill);
            }
        }
    });

    result?;
    Ok(budget.metrics())
}

#[cfg(not(target_family = "wasm"))]
#[allow(clippy::too_many_arguments)]
fn run_input_source_pipeline<'a, W, I, P>(
    pdf: &mut PdfWriter<W>,
    first_spec: PdfPageSpec<'a>,
    page_specs: &mut I,
    options: &PdfBuildOptions,
    worker_threads: usize,
    page_count: &mut usize,
    processed: &mut usize,
    on_processed: &mut P,
) -> Result<PipelineMetrics>
where
    W: Write,
    I: Iterator<Item = PdfPageSpec<'a>>,
    P: FnMut(usize),
{
    let max_in_flight = (worker_threads * 2).max(2);
    let max_open_fds = options.max_open_input_fds.max(1);
    let budget = PipelineBudget::new(max_open_fds, options.max_in_flight_bytes);
    let queue = PipelineQueue::<(PdfPageSpec<'a>, FdPermit<'_>)>::new();

    let result = std::thread::scope(|scope| -> Result<()> {
        let mut shutdown_guard = PipelineShutdownGuard {
            queue: &queue,
            budget: &budget,
            completed: false,
        };
        for _ in 0..worker_threads {
            let queue = &queue;
            let budget = &budget;
            scope.spawn(move || {
                while let Some((seq, (spec, fd_permit))) = queue.pop_work() {
                    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let admit_turn = budget.acquire_admit_turn(seq)?;
                        let mut reservation = budget.empty_reservation(seq);
                        let loaded =
                            load_input_page_spec_budgeted(spec, options, Some(&mut reservation))?;
                        // All open `File` descriptors from `spec` are now closed.
                        drop(fd_permit);
                        let decode_bytes = estimate_loaded_spec_decode_bytes(&loaded, options);
                        reservation.reserve_additional(decode_bytes)?;
                        drop(admit_turn);

                        let _prepare_guard = budget.enter_prepare();
                        let mut pages = Vec::new();
                        prepare_loaded_page_spec(loaded, options, |page| {
                            pages.push(page);
                            Ok(())
                        })?;
                        drop(_prepare_guard);
                        let prepared_bytes =
                            pages.iter().map(PreparedPage::payload_bytes).sum::<u64>();
                        reservation.shrink_to(prepared_bytes);
                        Ok::<_, Box<dyn Error>>((pages, reservation))
                    }));
                    let slot = match caught {
                        Ok(Ok(prepared)) => Ok(prepared),
                        Ok(Err(error)) => {
                            if error.downcast_ref::<PipelineCancelled>().is_some() {
                                queue.drop_cancelled();
                                continue;
                            }
                            Err(PreparedPageError::capture(error))
                        }
                        Err(panic_payload) => Err(PreparedPageError::from_panic(panic_payload)),
                    };
                    queue.complete_work(seq, slot, budget);
                }
            });
        }

        let first_fd_permit = budget.register_external_fds(first_spec.open_file_count());
        let mut lookahead: Option<(PdfPageSpec<'a>, FdPermit<'_>)> =
            Some((first_spec, first_fd_permit));
        let mut next_submit_seq = 0usize;
        let mut next_write_seq = 0usize;
        let mut input_exhausted = false;

        loop {
            while !queue.has_failure() && queue.in_flight() < max_in_flight {
                if lookahead.is_none() {
                    if input_exhausted || !budget.has_external_fd_headroom(3) {
                        break;
                    }
                    match page_specs.next() {
                        Some(spec) => {
                            if let Err(error) = reject_spec_if_fds_exceed_limit(&spec, max_open_fds)
                            {
                                drop(spec);
                                queue.push_immediate_error(
                                    next_submit_seq,
                                    PreparedPageError::capture(error),
                                );
                                budget.record_failure(next_submit_seq);
                                next_submit_seq += 1;
                                input_exhausted = true;
                                break;
                            }
                            let fd_permit = budget.register_external_fds(spec.open_file_count());
                            lookahead = Some((spec, fd_permit));
                        }
                        None => {
                            input_exhausted = true;
                            break;
                        }
                    }
                }

                let next_is_tiff = lookahead
                    .as_ref()
                    .is_some_and(|(spec, _)| spec.streams_frames());
                if next_is_tiff {
                    if queue.in_flight() > 0 {
                        break;
                    }
                    let (spec, fd_permit) = lookahead.take().expect("lookahead TIFF spec");
                    prepare_input_page_spec(
                        spec,
                        options,
                        Some(TiffBudget::Standalone(&budget, next_submit_seq)),
                        |page| write_counted_page(pdf, page, page_count, options),
                    )?;
                    drop(fd_permit);
                    budget.advance_admit_turn_for_streamed_item(next_submit_seq);
                    *processed += 1;
                    on_processed(*processed);
                    next_submit_seq += 1;
                    next_write_seq += 1;
                    continue;
                }

                if let Some((spec, fd_permit)) = lookahead.take() {
                    queue.push_work(next_submit_seq, (spec, fd_permit));
                    next_submit_seq += 1;
                }
            }

            let mut wrote_any = false;
            while let Some(slot) = queue.pop_ready(next_write_seq) {
                wrote_any = true;
                match slot {
                    Ok((pages, reservation)) => {
                        let write_res = (|| -> Result<()> {
                            for page in pages {
                                write_counted_page(pdf, page, page_count, options)?;
                            }
                            Ok(())
                        })();
                        drop(reservation);
                        write_res?;
                        *processed += 1;
                        on_processed(*processed);
                        next_write_seq += 1;
                    }
                    Err(error) => {
                        return Err(error.into_error());
                    }
                }
            }

            if input_exhausted && lookahead.is_none() && queue.in_flight() == 0 {
                shutdown_guard.completed = true;
                return Ok(());
            }

            if !wrote_any {
                let next_is_tiff = lookahead
                    .as_ref()
                    .is_some_and(|(spec, _)| spec.streams_frames());
                let can_refill = !next_is_tiff
                    && (lookahead.is_some()
                        || (!input_exhausted && budget.has_external_fd_headroom(3)));
                queue.wait_for_writer_progress(next_write_seq, max_in_flight, can_refill);
            }
        }
    });

    result?;
    Ok(budget.metrics())
}

fn visit_automatic_loaded_pages(
    source: LoadedSource<'_>,
    options: &PdfBuildOptions,
    mut on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    if source.is_pbm() {
        let mask = read_loaded_mask_bitmap(source, options.max_bilevel_pixels)?;
        on_page(bilevel_image_page(mask, DEFAULT_DPI, DEFAULT_DPI)?)?;
        return Ok(1);
    }

    match source {
        LoadedSource::FileBytes { label, data } => visit_image_pages_from_loaded_file_bytes(
            &label,
            data,
            options.max_pixels,
            options.default_dpi,
            options.max_tiff_frames,
            None,
            on_page,
        ),
        LoadedSource::Bytes { file_name, data } => visit_image_pages_from_bytes(
            file_name,
            data,
            options.max_pixels,
            options.default_dpi,
            options.max_tiff_frames,
            None,
            on_page,
        ),
        LoadedSource::Netpbm { image, .. } => {
            let page = read_owned_netpbm_page(
                &image,
                options,
                PdfImageCompression::Auto,
                ImageProcessing::None,
                None,
                None,
            )?;
            on_page(page)?;
            Ok(1)
        }
        LoadedSource::Pbm { image, .. } => {
            on_page(bilevel_image_page(image, DEFAULT_DPI, DEFAULT_DPI)?)?;
            Ok(1)
        }
        LoadedSource::DecodedExactImage {
            page, page_count, ..
        } => {
            if let Some(page) = page {
                on_page(page)?;
            }
            Ok(page_count)
        }
    }
}

fn read_exact_loaded_image(
    image: ImageSpec<LoadedSource<'_>>,
    options: &PdfBuildOptions,
    page_size: Option<PdfPageSize>,
) -> Result<ImagePage> {
    if image.compression != ImageCompression::Auto || image.processing != ImageProcessing::None {
        return read_processed_loaded_image(image, options, page_size);
    }

    let source_label = image.source.label();
    let mut first = None;
    let page_count = visit_automatic_loaded_pages(image.source, options, |page| {
        if first.is_none() {
            first = Some(page);
        }
        Ok(())
    })?;
    match (page_count, first) {
        (1, Some(page)) => Ok(page),
        (0, _) => Err(format!("No image pages found: {source_label}").into()),
        (count, _) => Err(format!(
            "Mixed PDF page images must contain exactly one page: {source_label} has {count}"
        )
        .into()),
    }
}

fn read_processed_loaded_image(
    image: ImageSpec<LoadedSource<'_>>,
    options: &PdfBuildOptions,
    page_size: Option<PdfPageSize>,
) -> Result<ImagePage> {
    if image.processing == ImageProcessing::BlackAndWhite {
        return read_loaded_black_and_white_page(image.source, options, page_size);
    }
    let compression = PdfImageCompression::from(image.compression);
    match image.source {
        LoadedSource::FileBytes { label, data } => read_image_page_from_loaded_file_bytes(
            &label,
            data,
            options,
            compression,
            image.processing,
            page_size,
            image.size_guardrail,
        ),
        LoadedSource::Bytes { file_name, data } => read_image_page_from_bytes(
            file_name,
            data,
            options,
            compression,
            image.processing,
            page_size,
            image.size_guardrail,
        ),
        LoadedSource::Netpbm { image: owned, .. } => read_owned_netpbm_page(
            &owned,
            options,
            compression,
            image.processing,
            page_size,
            image.size_guardrail,
        ),
        LoadedSource::Pbm { label, .. } | LoadedSource::DecodedExactImage { label, .. } => {
            Err(format!("Unsupported image extension: {}", label.display()).into())
        }
    }
}

fn read_loaded_black_and_white_page(
    source: LoadedSource<'_>,
    options: &PdfBuildOptions,
    page_size: Option<PdfPageSize>,
) -> Result<ImagePage> {
    let page_size = page_size.ok_or("Black-and-white pages need a page size")?;
    let (width_u32, height_u32, channels, pixels) = match source {
        LoadedSource::Netpbm { image, .. } => {
            (image.width, image.height, image.channels, image.pixels)
        }
        LoadedSource::FileBytes { data, .. } => {
            let render = parse_netpbm(&data, options.max_pixels)?;
            (
                render.width,
                render.height,
                render.channels,
                render.pixels.to_vec(),
            )
        }
        LoadedSource::Bytes { data, .. } => {
            let render = parse_netpbm(data, options.max_pixels)?;
            (
                render.width,
                render.height,
                render.channels,
                render.pixels.to_vec(),
            )
        }
        LoadedSource::Pbm { .. } | LoadedSource::DecodedExactImage { .. } => {
            return Err("Black-and-white pages need a grayscale (PGM) render".into());
        }
    };
    if channels != 1 {
        return Err("Black-and-white pages need a grayscale (PGM) render".into());
    }
    let width = width_u32 as usize;
    let height = height_u32 as usize;
    let dpi = f64::from(width_u32) * 72.0 / page_size.width_points;
    if !dpi.is_finite() || dpi <= 0.0 {
        return Err("Black-and-white page size gives no render resolution".into());
    }
    let gray = scan_primitives::GrayImage::from_vec(width, height, width, pixels)
        .ok_or("Black-and-white render has an invalid pixel buffer")?;
    // Scan cleanup's illumination normalization and its Sauvola route, with
    // its uncalibrated window. Its full black-and-white pass tunes stroke
    // weight from document-wide evidence; run on one page without it, it
    // thickened some words and not others.
    let normalized = scan_primitives::background::normalize_illumination(&gray, dpi);
    let radius = ((dpi * 25.5 / 300.0).round() as usize).clamp(8, 64);
    let binary = scan_primitives::threshold::threshold_local(
        &normalized,
        radius,
        scan_primitives::threshold::LocalThreshold::Sauvola { k: 0.34 },
    );
    // Both rasters pack black as one, most significant bit first.
    let row_stride = width.div_ceil(8);
    let mut bitmap = Vec::with_capacity(row_stride * height);
    for row in binary.words().chunks_exact(binary.words_per_line()) {
        let mut packed = row.iter().flat_map(|word| word.to_be_bytes());
        bitmap.extend(packed.by_ref().take(row_stride));
    }
    let dpi = dpi.round().clamp(1.0, f64::from(u32::MAX)) as u32;
    bilevel_image_page(
        PbmP4Image {
            width: width_u32,
            height: height_u32,
            row_stride,
            bitmap,
        },
        dpi,
        dpi,
    )
}

fn read_loaded_mask(source: LoadedSource<'_>, max_pixels: u64) -> Result<BilevelStream> {
    BilevelStream::encode(&read_loaded_mask_bitmap(source, max_pixels)?)
}

fn read_loaded_affine_foreground_mask(
    source: LoadedSource<'_>,
    expected_width: u32,
    expected_height: u32,
    max_pixels: u64,
    source_decode: PdfBilevelDecode,
) -> Result<BilevelStream> {
    let label = source.label();
    let is_pdf_jbig2 = label
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("jb2e"));
    if !is_pdf_jbig2 {
        return read_loaded_mask(source, max_pixels);
    }

    assert_pixel_limit(expected_width, expected_height, max_pixels)?;
    let bytes = match source {
        LoadedSource::FileBytes { data, .. } => data,
        LoadedSource::Bytes { data, .. } => data.to_vec(),
        LoadedSource::Netpbm { .. }
        | LoadedSource::Pbm { .. }
        | LoadedSource::DecodedExactImage { .. } => {
            return Err("Invalid source JBIG2 selection mask".into());
        }
    };
    let decoded =
        jbig2_codec::decode_pdf_generic_source(&bytes, jbig2_codec::DecodeLimits::new(max_pixels))
            .map_err(|error| format!("Invalid source JBIG2 selection mask: {error}"))?;
    if (decoded.width, decoded.height) != (expected_width, expected_height) {
        return Err(format!(
            "Source JBIG2 selection mask dimensions {}x{} differ from foreground image dimensions {expected_width}x{expected_height}",
            decoded.width, decoded.height
        )
        .into());
    }
    BilevelStream::from_pdf_jbig2(expected_width, expected_height, bytes, source_decode)
}

fn read_loaded_mask_bitmap(source: LoadedSource<'_>, max_pixels: u64) -> Result<PbmP4Image> {
    match source {
        LoadedSource::Pbm { image, .. } => Ok(image),
        LoadedSource::FileBytes { label, data } => {
            if path_has_extension(&label, &["png"]) {
                decode_png_mask_bitmap(&data, max_pixels)
            } else {
                parse_pbm_p4(&data, max_pixels)
            }
        }
        LoadedSource::Bytes { file_name, data } => {
            if file_name
                .rsplit_once('.')
                .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("png"))
            {
                decode_png_mask_bitmap(data, max_pixels)
            } else {
                parse_pbm_p4(data, max_pixels)
            }
        }
        LoadedSource::Netpbm { .. } | LoadedSource::DecodedExactImage { .. } => {
            Err("Expected a PBM P4 payload".into())
        }
    }
}

fn decode_png_mask_bitmap(bytes: &[u8], max_pixels: u64) -> Result<PbmP4Image> {
    let gray = decode_png_gray(
        bytes,
        DecodeLimits {
            max_pixels,
            max_dimension: u32::MAX,
            max_compressed_bytes: bytes.len(),
        },
    )?;
    let width = u32::try_from(gray.width())?;
    let height = u32::try_from(gray.height())?;
    let row_stride = gray.width().div_ceil(8);
    let mut bitmap = vec![0u8; row_stride * gray.height()];
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            if gray.get(x, y) >= 128 {
                bitmap[y * row_stride + x / 8] |= 0x80 >> (x % 8);
            }
        }
    }
    Ok(PbmP4Image {
        width,
        height,
        row_stride,
        bitmap,
    })
}

fn read_loaded_soft_mask(source: LoadedSource<'_>, max_pixels: u64) -> Result<SoftMaskStream> {
    let alpha = match source {
        LoadedSource::Netpbm { image, .. } => image,
        LoadedSource::FileBytes { data, .. } => {
            let parsed = parse_netpbm(&data, max_pixels)?;
            OwnedNetpbm {
                magic: if parsed.channels == 1 { *b"P5" } else { *b"P6" },
                width: parsed.width,
                height: parsed.height,
                channels: parsed.channels,
                pixels: parsed.pixels.to_vec(),
            }
        }
        LoadedSource::Bytes { data, .. } => {
            let parsed = parse_netpbm(data, max_pixels)?;
            OwnedNetpbm {
                magic: if parsed.channels == 1 { *b"P5" } else { *b"P6" },
                width: parsed.width,
                height: parsed.height,
                channels: parsed.channels,
                pixels: parsed.pixels.to_vec(),
            }
        }
        LoadedSource::Pbm { .. } | LoadedSource::DecodedExactImage { .. } => {
            return Err("Soft foreground alpha must be an 8-bit PGM or grayscale PPM".into());
        }
    };
    let pixels = if alpha.channels == 1 {
        alpha.pixels
    } else if alpha.channels == 3 {
        alpha.pixels.chunks_exact(3).map(netpbm_luma).collect()
    } else {
        return Err("Soft foreground alpha must be an 8-bit PGM or grayscale PPM".into());
    };
    SoftMaskStream::encode(alpha.width, alpha.height, &pixels)
}

fn netpbm_luma(pixel: &[u8]) -> u8 {
    ((u32::from(pixel[0]) * 77 + u32::from(pixel[1]) * 150 + u32::from(pixel[2]) * 29 + 128) >> 8)
        as u8
}

impl InputSource<'_> {
    fn is_tiff(&self) -> bool {
        self.has_extension(&["tif", "tiff"])
    }

    fn has_extension(&self, extensions: &[&str]) -> bool {
        let label = match self {
            Self::File { label, .. } => label.to_string_lossy(),
            Self::Bytes { file_name, .. } => Cow::Borrowed(*file_name),
        };
        name_has_extension(&label, extensions)
    }
}

impl From<ImageCompression> for PdfImageCompression {
    fn from(compression: ImageCompression) -> Self {
        match compression {
            ImageCompression::Auto => Self::Auto,
            ImageCompression::Jpeg { quality } => Self::Jpeg { quality },
            ImageCompression::JpegWithFlateFallback { quality } => {
                Self::JpegWithFlateFallback { quality }
            }
        }
    }
}

struct OutputLimitWriter<W: Write> {
    inner: W,
    max_bytes: u64,
    written: u64,
}

#[derive(Debug)]
struct OutputLimitExceeded;

impl std::fmt::Display for OutputLimitExceeded {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Combined PDF output exceeds the configured byte limit")
    }
}

impl Error for OutputLimitExceeded {}

fn is_output_limit_exceeded(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .and_then(std::io::Error::get_ref)
        .is_some_and(|source| source.downcast_ref::<OutputLimitExceeded>().is_some())
}

impl<W: Write> OutputLimitWriter<W> {
    fn new(inner: W, max_bytes: u64) -> Self {
        Self {
            inner,
            max_bytes,
            written: 0,
        }
    }

    fn into_inner(self) -> W {
        self.inner
    }
}

impl<W: Write> Write for OutputLimitWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let requested = u64::try_from(buffer.len()).unwrap_or(u64::MAX);
        if self.written.saturating_add(requested) > self.max_bytes {
            return Err(std::io::Error::other(OutputLimitExceeded));
        }
        let written = self.inner.write(buffer)?;
        self.written = self.written.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn next_page_count_with_limit(current: usize, max_pages: usize) -> Result<usize> {
    let next = current
        .checked_add(1)
        .ok_or_else(|| too_large_error("Combined PDF page count overflow"))?;
    if next > max_pages {
        return Err(too_large_error(format!(
            "Combined PDF is capped at {max_pages} pages"
        )));
    }
    Ok(next)
}

fn bilevel_image_page(
    mut image: crate::netpbm::PbmP4Image,
    dpi_x: u32,
    dpi_y: u32,
) -> Result<ImagePage> {
    if image.width % 8 != 0 {
        let used_bits = image.width % 8;
        let padding_mask = (1u8 << (8 - used_bits)) - 1;
        let last_byte = image.row_stride - 1;
        for row in image.bitmap.chunks_exact_mut(image.row_stride) {
            row[last_byte] &= !padding_mask;
        }
    }
    Ok(ImagePage {
        width: image.width,
        height: image.height,
        dpi_x,
        dpi_y,
        color_space: "DeviceGray",
        icc_profile: None,
        payload: ImagePayload::Bilevel(BilevelStream::encode(&image)?),
    })
}

fn image_page_to_layered_image(page: ImagePage) -> Result<LayeredPdfImage> {
    let payload = match page.payload {
        ImagePayload::RawFlate {
            data,
            decode_params,
        } => LayeredImagePayload::RawFlate {
            data,
            decode_params,
        },
        ImagePayload::Jpeg { data } => LayeredImagePayload::Jpeg { data },
        ImagePayload::Jpx { data } => LayeredImagePayload::Jpx { data },
        ImagePayload::Bilevel { .. } => {
            return Err("Bilevel images cannot be layered PDF backgrounds".into())
        }
    };
    Ok(LayeredPdfImage {
        width: page.width,
        height: page.height,
        color_space: page.color_space,
        payload,
    })
}

#[cfg(unix)]
const UNIX_O_NONBLOCK: i32 = {
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    ))]
    {
        0x0004
    }
    #[cfg(all(target_os = "linux", any(target_arch = "mips", target_arch = "mips64")))]
    {
        0x0080
    }
    #[cfg(all(
        target_os = "linux",
        any(target_arch = "sparc", target_arch = "sparc64")
    ))]
    {
        0x4000
    }
    #[cfg(all(
        target_os = "linux",
        not(any(
            target_arch = "mips",
            target_arch = "mips64",
            target_arch = "sparc",
            target_arch = "sparc64"
        ))
    ))]
    {
        0x0800
    }
};

#[cfg(unix)]
fn inspect_output_identity_unix(output_path: &Path) -> Result<Option<(u64, u64)>> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(UNIX_O_NONBLOCK)
        .open(output_path)
    {
        Ok(file) => {
            let metadata = file
                .metadata()
                .map_err(|error| NativeError::new(NativeErrorCode::Io, error.to_string()))?;
            if !metadata.is_file() {
                return Err(Box::new(NativeError::new(
                    NativeErrorCode::NativeFailure,
                    format!("Output is not a regular file: {}", output_path.display()),
                )));
            }
            Ok(Some((metadata.dev(), metadata.ino())))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            let metadata = std::fs::metadata(output_path)
                .map_err(|err| NativeError::new(NativeErrorCode::Io, err.to_string()))?;
            if !metadata.is_file() {
                return Err(Box::new(NativeError::new(
                    NativeErrorCode::NativeFailure,
                    format!("Output is not a regular file: {}", output_path.display()),
                )));
            }
            Ok(Some((metadata.dev(), metadata.ino())))
        }
        Err(error) => Err(Box::new(NativeError::new(
            NativeErrorCode::Io,
            error.to_string(),
        ))),
    }
}

/// Validates that an existing output path is a regular file without blocking on
/// unread Unix FIFOs or special files.
pub fn validate_output_path_non_blocking(output_path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        let _ = inspect_output_identity_unix(output_path)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        ValidatedInputFiles::open(&[], output_path)?;
        Ok(())
    }
}

/// Opens a single regular input file non-blocking (on Unix) and rejects any
/// non-regular file or same-file / hard-link alias of `output_path`.
pub(crate) fn open_validated_input_file(input_path: &Path, output_path: &Path) -> Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

        let output_identity = inspect_output_identity_unix(output_path)?;
        let output_canonical =
            output_identity.and_then(|_| std::fs::canonicalize(output_path).ok());

        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(UNIX_O_NONBLOCK)
            .open(input_path)
            .map_err(|error| NativeError::new(NativeErrorCode::Io, error.to_string()))?;
        let metadata = file
            .metadata()
            .map_err(|error| NativeError::new(NativeErrorCode::Io, error.to_string()))?;
        if !metadata.is_file() {
            return Err(Box::new(NativeError::new(
                NativeErrorCode::NativeFailure,
                format!("Input is not a regular file: {}", input_path.display()),
            )));
        }

        let input_identity = (metadata.dev(), metadata.ino());
        let aliases_output = output_identity.is_some_and(|output| output == input_identity)
            || output_canonical.as_ref().is_some_and(|output| {
                std::fs::canonicalize(input_path).ok().as_ref() == Some(output)
            });
        if aliases_output {
            return Err(Box::new(NativeError::new(
                NativeErrorCode::NativeFailure,
                format!("Output aliases an input file: {}", input_path.display()),
            )));
        }
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        Ok(
            ValidatedInputFiles::open(
                std::slice::from_ref(&input_path.to_path_buf()),
                output_path,
            )?
            .into_files()
            .next()
            .ok_or("Missing validated input")?,
        )
    }
}

fn open_validated_input(input_path: &Path, output_path: &Path) -> Result<File> {
    open_validated_input_file(input_path, output_path)
}

pub fn encode_netpbm_path_as_png(
    input_path: &Path,
    output_path: &Path,
    max_pixels: u64,
) -> Result<()> {
    encode_netpbm_path_as_png_with_dpi(input_path, output_path, max_pixels, None)
}

pub fn encode_netpbm_path_as_png_with_dpi(
    input_path: &Path,
    output_path: &Path,
    max_pixels: u64,
    dpi: Option<u32>,
) -> Result<()> {
    let netpbm = read_netpbm_file(open_validated_input(input_path, output_path)?, max_pixels)?;
    let total_pixels = netpbm.width as usize * netpbm.height as usize;
    let mut channels = netpbm.channels as usize;
    let pixels = if channels == 3 && is_rgb_data_grayscale(&netpbm.pixels, total_pixels) {
        channels = 1;
        Cow::Owned(
            netpbm
                .pixels
                .chunks_exact(3)
                .map(|pixel| pixel[0])
                .collect(),
        )
    } else {
        Cow::Borrowed(&netpbm.pixels)
    };
    let buffer = match channels {
        1 => PixelBuffer::Gray {
            width: netpbm.width as usize,
            height: netpbm.height as usize,
            stride: netpbm.width as usize,
            data: &pixels,
        },
        3 => PixelBuffer::Rgb {
            width: netpbm.width as usize,
            height: netpbm.height as usize,
            stride: netpbm.width as usize * 3,
            data: &pixels,
        },
        _ => unreachable!("the Netpbm parser only returns gray or RGB pixels"),
    };
    let mut output = AtomicOutput::create(output_path)?;
    match dpi {
        Some(dpi) => write_png_with_dpi(output.file_mut()?, buffer, dpi)?,
        None => write_png(output.file_mut()?, buffer)?,
    };
    output.publish()?;
    Ok(())
}

pub fn encode_netpbm_path_as_jpeg(
    input_path: &Path,
    output_path: &Path,
    max_pixels: u64,
    dpi: Option<u32>,
) -> Result<()> {
    let netpbm = read_netpbm_file(open_validated_input(input_path, output_path)?, max_pixels)?;
    let (pixels, color_type) = match netpbm.channels {
        1 => (Cow::Borrowed(netpbm.pixels.as_slice()), JpegColorType::Luma),
        3 => (Cow::Borrowed(netpbm.pixels.as_slice()), JpegColorType::Rgb),
        _ => unreachable!("the Netpbm parser only returns gray or RGB pixels"),
    };
    let width = u16::try_from(netpbm.width).map_err(|_| "JPEG width is too large to encode")?;
    let height = u16::try_from(netpbm.height).map_err(|_| "JPEG height is too large to encode")?;
    let mut bytes = Vec::new();
    let mut encoder = JpegEncoder::new(&mut bytes, 90);
    encoder.set_density(PixelDensity::dpi(
        dpi.unwrap_or(DEFAULT_DPI).min(u32::from(u16::MAX)) as u16,
    ));
    if matches!(color_type, JpegColorType::Rgb) {
        encoder.set_sampling_factor(SamplingFactor::R_4_2_0);
    }
    encoder.encode(&pixels, width, height, color_type)?;
    let mut output = AtomicOutput::create(output_path)?;
    output.file_mut()?.write_all(&bytes)?;
    output.publish()?;
    Ok(())
}

pub fn combine_tiff_paths(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    max_pages: usize,
    dpi: Option<u32>,
) -> Result<()> {
    combine_tiff_pages(input_paths, output_path, max_pixels, max_pages, dpi)
}

pub fn combine_tiff_paths_with_limits(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    max_pages: usize,
    dpi: Option<u32>,
    max_open_fds: usize,
    max_in_flight_bytes: u64,
) -> Result<()> {
    let _metrics = combine_tiff_pages_with_limits(
        input_paths,
        output_path,
        max_pixels,
        max_pages,
        dpi,
        max_open_fds,
        max_in_flight_bytes,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::ZlibEncoder, Compression};
    use std::{
        cell::RefCell,
        io::{Cursor, Error as IoError},
        rc::Rc,
    };
    use tiff::{
        encoder::{colortype, Rational, TiffEncoder},
        tags::ResolutionUnit,
    };

    const PAGE: PdfPageSize = PdfPageSize {
        width_points: 72.0,
        height_points: 36.0,
    };

    #[test]
    fn page_spec_golden_preserves_png_and_jpeg_icc_streams() {
        let profile = b"stage-3-equivalence-icc-profile";
        for (file_name, image, payload, color_space, components) in [
            {
                let (png, idat) = png_with_icc(0, &[0, 0x40], profile);
                ("gray.png", png, idat, "/DeviceGray", "/N 1")
            },
            {
                let (png, idat) = png_with_icc(2, &[0, 0x10, 0x20, 0x30], profile);
                ("rgb.png", png, idat, "/DeviceRGB", "/N 3")
            },
            {
                let jpeg = jpeg_with_icc(&[0x40], jpeg_encoder::ColorType::Luma, profile);
                ("gray.jpg", jpeg.clone(), jpeg, "/DeviceGray", "/N 1")
            },
            {
                let jpeg =
                    jpeg_with_icc(&[0x10, 0x20, 0x30], jpeg_encoder::ColorType::Rgb, profile);
                ("rgb.jpg", jpeg.clone(), jpeg, "/DeviceRGB", "/N 3")
            },
        ] {
            let pdf = write_pdf(
                Vec::new(),
                [image_page(
                    file_name,
                    &image,
                    Some(PAGE),
                    FramePolicy::ExactlyOne,
                )],
                &PdfBuildOptions::default(),
                |_| {},
            )
            .unwrap();
            let text = String::from_utf8_lossy(&pdf);
            assert!(text.contains(color_space));
            assert!(text.contains(components));
            assert!(text.contains("/Width 1 /Height 1"));
            assert!(text.contains("/MediaBox [0 0 72.0000 36.0000]"));
            assert!(contains_bytes(&pdf, profile));
            assert!(contains_bytes(&pdf, &payload));
        }
    }

    #[test]
    fn catalog_holds_only_the_page_tree() {
        let options = PdfBuildOptions::default();
        let pdf = write_pdf(
            Vec::new(),
            [image_page(
                "page.ppm",
                b"P6\n1 1\n255\n\x10\x20\x30",
                None,
                FramePolicy::ExactlyOne,
            )],
            &options,
            |_| {},
        )
        .unwrap();

        assert!(pdf.starts_with(
            b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>"
        ));
    }

    #[test]
    fn page_spec_golden_preserves_netpbm_auto_and_jpeg_modes() {
        for (file_name, data, colors) in [
            ("gray.pgm", b"P5\n4 1\n255\n\x10\x40\x80\xf0".as_slice(), 1),
            (
                "rgb.ppm",
                b"P6\n4 1\n255\n\x10\x20\x30\x40\x50\x60\x70\x80\x90\xd0\xe0\xf0".as_slice(),
                3,
            ),
        ] {
            let automatic = write_pdf(
                Vec::new(),
                [image_page(file_name, data, None, FramePolicy::All)],
                &PdfBuildOptions::default(),
                |_| {},
            )
            .unwrap();
            assert!(String::from_utf8_lossy(&automatic).contains(&format!(
                "/Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns 4"
            )));

            let jpeg = write_pdf(
                Vec::new(),
                [PageSpec::Image {
                    page_size: Some(PAGE),
                    placement: None,
                    rotation_degrees: 0,
                    image: ImageSpec {
                        source: InputSource::Bytes { file_name, data },
                        compression: ImageCompression::Jpeg { quality: 83 },
                        processing: ImageProcessing::DownscaleToPpi { ppi_cap: 2 },
                        size_guardrail: None,
                    },
                    frames: FramePolicy::ExactlyOne,
                }],
                &PdfBuildOptions::default(),
                |_| {},
            )
            .unwrap();
            let text = String::from_utf8_lossy(&jpeg);
            assert!(text.contains("/Filter /DCTDecode"));
            assert!(text.contains("/Width 2 /Height 1"));
            assert!(text.contains("/MediaBox [0 0 72.0000 36.0000]"));
        }
    }

    #[test]
    fn image_jpeg_record_keeps_flate_when_the_jpeg_candidate_is_larger() {
        let pixels = vec![248; 256 * 256];
        let png = evb_raster_io::encode_png(PixelBuffer::Gray {
            width: 256,
            height: 256,
            stride: 256,
            data: &pixels,
        })
        .unwrap();
        let pdf = write_pdf(
            Vec::new(),
            [jpeg_with_flate_fallback_page("blank.png", &png, 85)],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Filter /FlateDecode"));
        assert!(!text.contains("/Filter /DCTDecode"));
    }

    #[test]
    fn layered_jpeg_background_keeps_flate_when_the_jpeg_candidate_is_larger() {
        let pixels = vec![248; 256 * 256];
        let png = evb_raster_io::encode_png(PixelBuffer::Gray {
            width: 256,
            height: 256,
            stride: 256,
            data: &pixels,
        })
        .unwrap();
        let pdf = write_pdf(
            Vec::new(),
            [PageSpec::Layered {
                page_size: PAGE,
                background: ImageSpec {
                    source: InputSource::Bytes {
                        file_name: "blank.png",
                        data: &png,
                    },
                    compression: ImageCompression::JpegWithFlateFallback { quality: 85 },
                    processing: ImageProcessing::None,
                    size_guardrail: None,
                },
                foreground_mask: InputSource::Bytes {
                    file_name: "mask.pbm",
                    data: b"P4\n1 1\n\x80",
                },
                foreground_color: None,
            }],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Filter /FlateDecode"));
        assert!(!text.contains("/Filter /DCTDecode"));
    }

    #[test]
    fn soft_layered_alpha_accepts_gray_p5_and_luma_converted_p6() {
        let background = b"P5\n1 1\n255\n\xff";
        let pgm = b"P5\n2 1\n255\n\x00\x95";
        let ppm = b"P6\n2 1\n255\n\x00\x00\x00\x00\xff\x00";
        let build = |file_name: &str, alpha: &[u8]| {
            write_pdf(
                Vec::new(),
                [PageSpec::SoftLayered {
                    page_size: PAGE,
                    background: ImageSpec {
                        source: InputSource::Bytes {
                            file_name: "background.pgm",
                            data: background,
                        },
                        compression: ImageCompression::Auto,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    foreground_alpha: InputSource::Bytes {
                        file_name,
                        data: alpha,
                    },
                    foreground_color: None,
                }],
                &PdfBuildOptions::default(),
                |_| {},
            )
            .unwrap()
        };

        assert_eq!(build("alpha.pgm", pgm), build("alpha.ppm", ppm));
    }

    #[test]
    fn synthetic_tonal_page_uses_jpeg_and_is_materially_smaller_than_flate() {
        let width = 768usize;
        let height = 1_024usize;
        let mut pixels = Vec::with_capacity(width * height);
        let mut noise = 0x1234_5678u32;
        for y in 0..height {
            for x in 0..width {
                noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let paper = 218 + ((x * 19 / width + y * 13 / height) % 24) as i16;
                let texture = ((noise >> 28) as i16) - 8;
                let text = (y % 37 < 3 && x % 97 > 8) || (x % 211 < 2 && y % 113 > 20);
                pixels.push(if text {
                    (35 + texture).clamp(0, 255) as u8
                } else {
                    (paper + texture).clamp(0, 255) as u8
                });
            }
        }
        let png = evb_raster_io::encode_png(PixelBuffer::Gray {
            width,
            height,
            stride: width,
            data: &pixels,
        })
        .unwrap();
        let flate_pdf = write_pdf(
            Vec::new(),
            [image_page(
                "tonal.png",
                &png,
                Some(PAGE),
                FramePolicy::ExactlyOne,
            )],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .unwrap();
        let jpeg_pdf = write_pdf(
            Vec::new(),
            [jpeg_with_flate_fallback_page("tonal.png", &png, 85)],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .unwrap();

        assert!(String::from_utf8_lossy(&jpeg_pdf).contains("/Filter /DCTDecode"));
        assert!(
            jpeg_pdf.len() * 2 < flate_pdf.len(),
            "expected JPEG PDF to be less than half the Flate PDF: jpeg={} flate={}",
            jpeg_pdf.len(),
            flate_pdf.len()
        );
    }

    #[test]
    fn frame_policy_all_streams_tiff_frames_in_order_and_exactly_one_rejects() {
        let tiff = two_page_tiff();
        let mut progress = Vec::new();
        let pdf = write_pdf(
            Vec::new(),
            [image_page("two.tiff", &tiff, None, FramePolicy::All)],
            &PdfBuildOptions {
                max_pages: 10,
                max_tiff_frames: 10,
                ..PdfBuildOptions::default()
            },
            |processed| progress.push(processed),
        )
        .unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 2"));
        let first = text.find("/Width 1 /Height 1").unwrap();
        let second = text.find("/Width 2 /Height 1").unwrap();
        assert!(first < second);
        assert_eq!(progress, vec![1]);

        let error = write_pdf(
            Vec::new(),
            [image_page(
                "two.tiff",
                &tiff,
                Some(PAGE),
                FramePolicy::ExactlyOne,
            )],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .err()
        .unwrap();
        assert!(error
            .to_string()
            .contains("must contain exactly one page: two.tiff has 2"));
    }

    #[test]
    fn layered_color_and_mask_only_specs_preserve_pdf_structure() {
        let background = b"P6\n1 1\n255\n\xf0\xf0\xf0";
        let mask = b"P4\n8 1\n\xc0";
        let pdf = write_pdf(
            Vec::new(),
            [
                PageSpec::Layered {
                    page_size: PAGE,
                    background: ImageSpec {
                        source: InputSource::Bytes {
                            file_name: "background.ppm",
                            data: background,
                        },
                        compression: ImageCompression::Jpeg { quality: 75 },
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    foreground_mask: InputSource::Bytes {
                        file_name: "mask.pbm",
                        data: mask,
                    },
                    foreground_color: Some([128, 16, 16]),
                },
                PageSpec::Mask {
                    page_size: PdfPageSize {
                        width_points: 144.0,
                        height_points: 72.0,
                    },
                    foreground_mask: InputSource::Bytes {
                        file_name: "mask.pbm",
                        data: mask,
                    },
                },
            ],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 2"));
        assert_eq!(text.matches("/Filter /DCTDecode").count(), 1);
        assert_eq!(text.matches("/ImageMask true").count(), 2);
        assert!(text.contains("0.5020 0.0627 0.0627 rg"));
        assert!(text.contains("/MediaBox [0 0 144.0000 72.0000]"));
        assert!(text.contains("1 g\n0 0 144.0000 72.0000 re f\n0 g\n"));
    }

    #[test]
    fn affine_layered_spec_validates_and_preserves_source_jbig2_mask() {
        let background = b"P5\n8 1\n255\n\xf0\xf0\xf0\xf0\xf0\xf0\xf0\xf0";
        let foreground = b"P5\n8 1\n255\n\x10\x20\x30\x40\x50\x60\x70\x80";
        let mask_rows = [0b1100_0000];
        let mask = jbig2_codec::encode_pdf_generic(jbig2_codec::Bilevel {
            width: 8,
            height: 1,
            rows: &mask_rows,
        })
        .unwrap();
        let pdf = write_pdf(
            Vec::new(),
            [PageSpec::AffineMaskedLayered {
                page_size: PAGE,
                background: ImageSpec {
                    source: InputSource::Bytes {
                        file_name: "background.pgm",
                        data: background,
                    },
                    compression: ImageCompression::Auto,
                    processing: ImageProcessing::None,
                    size_guardrail: None,
                },
                foreground: ImageSpec {
                    source: InputSource::Bytes {
                        file_name: "foreground.pgm",
                        data: foreground,
                    },
                    compression: ImageCompression::Auto,
                    processing: ImageProcessing::None,
                    size_guardrail: None,
                },
                foreground_mask: InputSource::Bytes {
                    file_name: "mask.jb2e",
                    data: &mask,
                },
                foreground_mask_decode: PdfBilevelDecode::Default,
                foreground_matrix: [72.0, 0.0, 0.0, 36.0, 0.0, 0.0],
            }],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/SMask"));
        assert!(text.contains("/Filter /JBIG2Decode"));
        assert!(!text.contains("/Decode [1 0] /Filter /JBIG2Decode"));
        assert!(contains_bytes(&pdf, &mask));
    }

    #[test]
    fn empty_request_keeps_legacy_error_category() {
        let empty = write_pdf(
            Vec::new(),
            std::iter::empty::<PdfPageSpec<'_>>(),
            &PdfBuildOptions::default(),
            |_| {},
        )
        .err()
        .unwrap();
        assert_eq!(empty.to_string(), "At least one image input is required");
    }

    #[test]
    fn core_writes_incrementally_and_single_adapter_enforces_output_limit() {
        let state = Rc::new(RefCell::new(SinkState::default()));
        let sink = CountingSink {
            state: Rc::clone(&state),
            fail_after: Some(220),
        };
        let error = write_pdf(
            sink,
            [image_page(
                "page.ppm",
                b"P6\n2 1\n255\n\x10\x20\x30\x40\x50\x60",
                None,
                FramePolicy::All,
            )],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .err()
        .unwrap();
        assert_eq!(error.to_string(), "counting sink limit");
        assert_eq!(state.borrow().bytes, 220);
        assert!(state.borrow().writes > 4);

        let state = Rc::new(RefCell::new(SinkState::default()));
        let sink = CountingSink {
            state: Rc::clone(&state),
            fail_after: None,
        };
        let error = write_pdf(
            sink,
            [image_page(
                "page.ppm",
                b"P6\n1 1\n255\n\x10\x20\x30",
                None,
                FramePolicy::All,
            )],
            &PdfBuildOptions {
                max_output_bytes: 64,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .err()
        .unwrap();
        let native_error = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::TooLarge);
        assert!(error.to_string().contains("configured byte limit"));
        assert!(state.borrow().bytes <= 64);
    }

    #[test]
    fn default_path_writes_a_page_before_reporting_later_pages_processed() {
        let processed = Rc::new(RefCell::new(0usize));
        let error = write_pdf(
            FailOnPageObjectSink,
            (0..2).map(|_| image_page("page.pgm", b"P5\n1 1\n255\n\x00", None, FramePolicy::All)),
            &PdfBuildOptions {
                worker_threads: 1,
                ..PdfBuildOptions::default()
            },
            {
                let processed = Rc::clone(&processed);
                move |_| *processed.borrow_mut() += 1
            },
        )
        .err()
        .expect("the first page object should be rejected");

        assert_eq!(error.to_string(), "page object write blocked");
        assert_eq!(
            *processed.borrow(),
            0,
            "the default path must not report pages that are still buffered"
        );
    }

    #[test]
    fn page_ceiling_and_counter_overflow_return_typed_too_large_errors() {
        for error in [
            next_page_count_with_limit(1, 1).unwrap_err(),
            next_page_count_with_limit(usize::MAX, usize::MAX).unwrap_err(),
        ] {
            let native_error = error.downcast_ref::<NativeError>().unwrap();
            assert_eq!(native_error.code, NativeErrorCode::TooLarge);
        }
    }

    #[test]
    fn frame_visits_apply_page_and_frame_limits_before_progress() {
        let tiff = two_page_tiff();
        for options in [
            PdfBuildOptions {
                max_pages: 1,
                max_tiff_frames: 10,
                ..PdfBuildOptions::default()
            },
            PdfBuildOptions {
                max_tiff_frames: 1,
                ..PdfBuildOptions::default()
            },
        ] {
            let mut progress = Vec::new();
            let error = write_pdf(
                Vec::new(),
                [image_page("two.tiff", &tiff, None, FramePolicy::All)],
                &options,
                |processed| progress.push(processed),
            )
            .unwrap_err();
            assert!(error.to_string().contains("capped at 1"), "{}", error);
            assert!(progress.is_empty());
        }
    }

    #[test]
    fn tiff_frames_reach_the_output_before_the_next_frame_is_read() {
        let mut tiff = Vec::new();
        {
            let mut encoder = TiffEncoder::new(Cursor::new(&mut tiff)).unwrap();
            encoder
                .write_image::<colortype::RGB8>(1, 1, &[255, 0, 0])
                .unwrap();
            encoder
                .write_image::<colortype::Gray16>(1, 1, &[1])
                .unwrap();
        }
        let mut output = Vec::new();
        let error = write_pdf(
            &mut output,
            [image_page("frames.tiff", &tiff, None, FramePolicy::All)],
            &PdfBuildOptions::default(),
            |_| {},
        )
        .expect_err("the 16-bit second frame is rejected");

        assert!(
            error.to_string().contains("Only 8-bit TIFF samples"),
            "{error}"
        );
        assert!(
            contains_bytes(&output, b"<< /Type /Page /Parent"),
            "the first frame's page must be written before the second frame is decoded"
        );
    }

    #[test]
    fn progress_fires_once_per_spec_not_per_tiff_frame() {
        let tiff = two_page_tiff();
        let mut progress = Vec::new();
        let pdf = write_pdf(
            Vec::new(),
            [
                image_page("two.tiff", &tiff, None, FramePolicy::All),
                image_page("page.pgm", b"P5\n1 1\n255\n\x80", None, FramePolicy::All),
            ],
            &PdfBuildOptions {
                max_pages: 10,
                max_tiff_frames: 10,
                ..PdfBuildOptions::default()
            },
            |processed| progress.push(processed),
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("/Count 3"));
        assert_eq!(progress, vec![1, 2]);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn streaming_path_pipeline_bounds_open_fds_and_preserves_order_over_large_batch() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "evb-combine-fd-bounded-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let page_count = 320usize;
        let mut paths = Vec::with_capacity(page_count);
        for index in 0..page_count {
            let width = 1 + (index % 7);
            let mut ppm = format!("P6\n{width} 1\n255\n").into_bytes();
            for x in 0..width {
                ppm.extend_from_slice(&[(index & 0xff) as u8, (x * 31) as u8, 0x80]);
            }
            let path = dir.join(format!("page-{index:04}.ppm"));
            std::fs::write(&path, ppm).unwrap();
            paths.push(path);
        }
        let output_path = dir.join("combined.pdf");

        let make_specs = || {
            paths.iter().cloned().map(|source| {
                Ok(PageSpec::Image {
                    page_size: None,
                    placement: None,
                    rotation_degrees: 0,
                    image: ImageSpec {
                        source,
                        compression: ImageCompression::Auto,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    frames: FramePolicy::All,
                })
            })
        };

        // Each tiny automatic PPM page reserves its raster plus the ~416 KiB
        // live Flate encoder, so a 2 MiB cap admits about four pages at once.
        let single_options = PdfBuildOptions {
            max_pages: page_count,
            worker_threads: 1,
            max_open_input_fds: 4,
            max_in_flight_bytes: 2 * 1024 * 1024,
            ..PdfBuildOptions::default()
        };
        let (single_pdf, _) = write_pdf_paths_impl(
            Vec::new(),
            &output_path,
            make_specs(),
            &single_options,
            |_| {},
        )
        .unwrap();

        let concurrent_options = PdfBuildOptions {
            max_pages: page_count,
            worker_threads: 4,
            max_open_input_fds: 4,
            max_in_flight_bytes: 2 * 1024 * 1024,
            ..PdfBuildOptions::default()
        };
        let mut progress = Vec::new();
        let (concurrent_pdf, metrics) = write_pdf_paths_impl(
            Vec::new(),
            &output_path,
            make_specs(),
            &concurrent_options,
            |count| progress.push(count),
        )
        .unwrap();

        assert_eq!(single_pdf, concurrent_pdf);
        assert_eq!(progress, (1..=page_count).collect::<Vec<_>>());
        assert!(
            metrics.peak_open_fds <= concurrent_options.max_open_input_fds,
            "peak_open_fds={} exceeded cap {}",
            metrics.peak_open_fds,
            concurrent_options.max_open_input_fds
        );
        assert!(metrics.peak_open_fds >= 1);
        assert!(
            metrics.peak_in_flight_bytes <= concurrent_options.max_in_flight_bytes,
            "peak_in_flight_bytes={} exceeded cap {}",
            metrics.peak_in_flight_bytes,
            concurrent_options.max_in_flight_bytes
        );

        let text = String::from_utf8_lossy(&concurrent_pdf);
        assert!(text.contains(&format!("/Count {page_count}")));
        let widths: Vec<usize> = text
            .match_indices("/Subtype /Image /Width ")
            .map(|(idx, marker)| {
                text[idx + marker.len()..]
                    .split_whitespace()
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap()
            })
            .collect();
        assert_eq!(widths.len(), page_count);
        for (index, width) in widths.into_iter().enumerate() {
            assert_eq!(width, 1 + (index % 7), "page {index} out of order");
        }

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn streaming_path_pipeline_avoids_head_of_line_deadlock_under_tight_byte_cap() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "evb-combine-tight-bytes-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let page_count = 16usize;
        let mut paths = Vec::with_capacity(page_count);
        for index in 0..page_count {
            let mut jpeg = Vec::new();
            let pixels = vec![(index as u8).wrapping_mul(13); 64 * 64 * 3];
            jpeg_encoder::Encoder::new(&mut jpeg, 85)
                .encode(&pixels, 64, 64, jpeg_encoder::ColorType::Rgb)
                .unwrap();
            let path = dir.join(format!("page-{index:02}.jpg"));
            std::fs::write(&path, jpeg).unwrap();
            paths.push(path);
        }
        let output_path = dir.join("out.pdf");

        let make_specs = || {
            paths.iter().cloned().map(|source| {
                Ok(PageSpec::Image {
                    page_size: None,
                    placement: None,
                    rotation_degrees: 0,
                    image: ImageSpec {
                        source,
                        compression: ImageCompression::Auto,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    frames: FramePolicy::All,
                })
            })
        };

        // Byte cap (16 bytes) is far smaller than every single JPEG and its
        // 64x64x3 decoded buffer: head-of-line priority must complete cleanly
        // without deadlocking and produce byte-identical output.
        let single = write_pdf_paths(
            Vec::new(),
            &output_path,
            make_specs(),
            &PdfBuildOptions {
                worker_threads: 1,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();
        let tight = write_pdf_paths(
            Vec::new(),
            &output_path,
            make_specs(),
            &PdfBuildOptions {
                worker_threads: 4,
                max_open_input_fds: 2,
                max_in_flight_bytes: 16,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(single, tight);

        // Also reject same-file and hard-link aliasing inside the concurrent pipeline.
        let alias_error = write_pdf_paths(
            Vec::new(),
            &paths[10],
            make_specs(),
            &PdfBuildOptions {
                worker_threads: 4,
                max_open_input_fds: 4,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap_err();
        assert!(
            alias_error
                .to_string()
                .contains("Output aliases an input file"),
            "unexpected alias error: {alias_error}"
        );

        let hardlink = dir.join("hardlink-alias.pdf");
        std::fs::hard_link(&paths[15], &hardlink).unwrap();
        let hardlink_error = write_pdf_paths(
            Vec::new(),
            &hardlink,
            make_specs(),
            &PdfBuildOptions {
                worker_threads: 4,
                max_open_input_fds: 4,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap_err();
        assert!(
            hardlink_error
                .to_string()
                .contains("Output aliases an input file"),
            "unexpected hardlink alias error: {hardlink_error}"
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn worker_panic_returns_typed_panic_error_without_hanging_ordered_writer() {
        use std::sync::mpsc;
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "evb-combine-worker-panic-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let good = dir.join("good.pgm");
        let panicking = dir.join("__test_force_worker_panic__.pgm");
        let after = dir.join("after.pgm");
        std::fs::write(&good, b"P5\n1 1\n255\n\x40").unwrap();
        std::fs::write(&panicking, b"P5\n1 1\n255\n\x60").unwrap();
        std::fs::write(&after, b"P5\n1 1\n255\n\x80").unwrap();
        let output_path = dir.join("out.pdf");

        let make_spec = |source: PathBuf| {
            Ok(PageSpec::Image {
                page_size: None,
                placement: None,
                rotation_degrees: 0,
                image: ImageSpec {
                    source,
                    compression: ImageCompression::Auto,
                    processing: ImageProcessing::None,
                    size_guardrail: None,
                },
                frames: FramePolicy::All,
            })
        };

        // Test both path-backed and pre-opened InputSource pipelines under >=2 workers.
        let (tx, rx) = mpsc::channel();
        let dir_for_thread = dir.clone();
        std::thread::spawn(move || {
            let options = PdfBuildOptions {
                max_pixels: u64::MAX,
                worker_threads: 4,
                ..PdfBuildOptions::default()
            };
            let path_err = write_pdf_paths(
                Vec::new(),
                &output_path,
                [
                    make_spec(good.clone()),
                    make_spec(panicking.clone()),
                    make_spec(after.clone()),
                ],
                &options,
                |_| {},
            )
            .unwrap_err();
            let path_code = path_err.downcast_ref::<NativeError>().map(|err| err.code);
            let path_msg = path_err.to_string();

            let input_err = write_pdf(
                Vec::new(),
                [
                    PageSpec::Image {
                        page_size: None,
                        placement: None,
                        rotation_degrees: 0,
                        image: ImageSpec {
                            source: InputSource::File {
                                label: good.clone(),
                                file: File::open(&good).unwrap(),
                            },
                            compression: ImageCompression::Auto,
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
                            source: InputSource::File {
                                label: panicking.clone(),
                                file: File::open(&panicking).unwrap(),
                            },
                            compression: ImageCompression::Auto,
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
                            source: InputSource::File {
                                label: after.clone(),
                                file: File::open(&after).unwrap(),
                            },
                            compression: ImageCompression::Auto,
                            processing: ImageProcessing::None,
                            size_guardrail: None,
                        },
                        frames: FramePolicy::All,
                    },
                ],
                &options,
                |_| {},
            )
            .unwrap_err();
            let input_code = input_err.downcast_ref::<NativeError>().map(|err| err.code);
            let input_msg = input_err.to_string();
            let _ = std::fs::remove_dir_all(&dir_for_thread);
            let _ = tx.send((path_code, path_msg, input_code, input_msg));
        });

        let (path_code, path_msg, input_code, input_msg) = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("worker panic hung the streaming pipeline");
        assert_eq!(path_code, Some(NativeErrorCode::Panic), "{path_msg}");
        assert!(path_msg.contains("worker panicked"), "{path_msg}");
        assert_eq!(input_code, Some(NativeErrorCode::Panic), "{input_msg}");
        assert!(input_msg.contains("worker panicked"), "{input_msg}");
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn writer_progress_callback_panic_shuts_down_workers_without_hanging() {
        use std::sync::mpsc;
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "evb-combine-writer-panic-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let paths: Vec<PathBuf> = (0..8)
            .map(|index| {
                let path = dir.join(format!("page-{index}.pgm"));
                std::fs::write(&path, b"P5\n2 2\n255\n\x10\x20\x30\x40").unwrap();
                path
            })
            .collect();
        let output_path = dir.join("out.pdf");

        let (tx, rx) = mpsc::channel();
        let dir_for_thread = dir.clone();
        std::thread::spawn(move || {
            let options = PdfBuildOptions {
                worker_threads: 4,
                ..PdfBuildOptions::default()
            };
            let path_panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = write_pdf_paths(
                    Vec::new(),
                    &output_path,
                    paths.iter().cloned().map(|source| {
                        Ok(PageSpec::Image {
                            page_size: None,
                            placement: None,
                            rotation_degrees: 0,
                            image: ImageSpec {
                                source,
                                compression: ImageCompression::Auto,
                                processing: ImageProcessing::None,
                                size_guardrail: None,
                            },
                            frames: FramePolicy::All,
                        })
                    }),
                    &options,
                    |count| {
                        if count == 1 {
                            panic!("simulated writer callback panic (path)");
                        }
                    },
                );
            }));

            let input_panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = write_pdf(
                    Vec::new(),
                    (0..8).map(|_| {
                        image_page(
                            "page.pgm",
                            b"P5\n2 2\n255\n\x10\x20\x30\x40",
                            None,
                            FramePolicy::All,
                        )
                    }),
                    &options,
                    |count| {
                        if count == 1 {
                            panic!("simulated writer callback panic (input)");
                        }
                    },
                );
            }));

            let _ = std::fs::remove_dir_all(&dir_for_thread);
            let _ = tx.send((path_panic.is_err(), input_panic.is_err()));
        });

        let (path_panicked, input_panicked) = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("writer panic hung scoped worker join");
        assert!(path_panicked);
        assert!(input_panicked);
    }

    #[cfg(unix)]
    #[test]
    fn unread_unix_fifo_fails_immediately_without_blocking_earlier_error() {
        use std::process::Command;
        use std::sync::mpsc;
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("evb-combine-fifo-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let fifo_path = dir.join("unread.ppm");
        let status = Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .expect("mkfifo should be available on Unix");
        assert!(status.success(), "mkfifo failed");

        let missing_path = dir.join("missing.ppm");
        let output_path = dir.join("out.pdf");

        let (tx, rx) = mpsc::channel();
        let dir_for_thread = dir.clone();
        std::thread::spawn(move || {
            let options = PdfBuildOptions {
                worker_threads: 4,
                ..PdfBuildOptions::default()
            };
            let make_spec = |source: PathBuf| {
                Ok(PageSpec::Image {
                    page_size: None,
                    placement: None,
                    rotation_degrees: 0,
                    image: ImageSpec {
                        source,
                        compression: ImageCompression::Auto,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    frames: FramePolicy::All,
                })
            };

            // Index 0 is missing, index 1 is an unread FIFO: worker opening index 1
            // must reject it non-blocking so index 0's missing-file error returns promptly.
            let missing_first = write_pdf_paths(
                Vec::new(),
                &output_path,
                [make_spec(missing_path), make_spec(fifo_path.clone())],
                &options,
                |_| {},
            )
            .unwrap_err();
            let missing_code = missing_first
                .downcast_ref::<NativeError>()
                .map(|err| err.code);
            let missing_msg = missing_first.to_string();

            // Standalone unread FIFO input and output must also fail non-blocking.
            let fifo_input_err = write_pdf_paths(
                Vec::new(),
                &output_path,
                [make_spec(fifo_path.clone())],
                &options,
                |_| {},
            )
            .unwrap_err()
            .to_string();
            let fifo_output_err = validate_output_path_non_blocking(&fifo_path)
                .unwrap_err()
                .to_string();

            let _ = std::fs::remove_dir_all(&dir_for_thread);
            let _ = tx.send((missing_code, missing_msg, fifo_input_err, fifo_output_err));
        });

        let (missing_code, missing_msg, fifo_input_err, fifo_output_err) = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("unread Unix FIFO blocked worker thread");
        assert_eq!(missing_code, Some(NativeErrorCode::Io), "{missing_msg}");
        assert!(
            fifo_input_err.contains("Input is not a regular file"),
            "{fifo_input_err}"
        );
        assert!(
            fifo_output_err.contains("Output is not a regular file"),
            "{fifo_output_err}"
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn byte_budget_prevents_head_overrun_and_enforces_exclusive_oversized_admission() {
        use std::sync::mpsc;
        use std::time::Duration;

        const MIB: u64 = 1024 * 1024;
        let cap = 16 * MIB;

        // (a) With 12 MiB held by two other pages (6 MiB each), head page (seq 0)
        // requesting 8 MiB (2 MiB load + 6 MiB decode) must NOT overrun the 16 MiB cap.
        let budget = PipelineBudget::new(8, cap);
        let hold_a = budget.reserve_standalone_bytes(1, 6 * MIB).unwrap();
        let hold_b = budget.reserve_standalone_bytes(2, 6 * MIB).unwrap();

        let (head_loaded_tx, head_loaded_rx) = mpsc::channel();
        let (head_decoded_tx, head_decoded_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let mut head = budget.empty_reservation(0);
                head.reserve_additional(2 * MIB).unwrap();
                head_loaded_tx.send(()).unwrap();
                head.reserve_additional(6 * MIB).unwrap();
                head_decoded_tx.send(()).unwrap();
            });

            head_loaded_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("head 2 MiB load fits within 16 MiB cap");
            assert!(
                head_decoded_rx
                    .recv_timeout(Duration::from_millis(50))
                    .is_err(),
                "head 6 MiB decode must wait instead of overrunning the 16 MiB cap"
            );

            drop(hold_a);
            head_decoded_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("head 6 MiB decode should proceed once active bytes drop to 8 MiB");
            drop(hold_b);
        });
        assert!(
            budget.metrics().peak_in_flight_bytes <= cap,
            "peak_in_flight_bytes={} exceeded cap={cap}",
            budget.metrics().peak_in_flight_bytes
        );

        // (c) An oversized single page (20 MiB > 16 MiB cap) must wait for
        // exclusive occupancy (other active bytes == 0) and block concurrent
        // normal pages until released, without deadlocking.
        let budget = PipelineBudget::new(8, cap);
        let normal_first = budget.reserve_standalone_bytes(0, 6 * MIB).unwrap();
        let (oversized_acquired_tx, oversized_acquired_rx) = mpsc::channel();
        let (release_oversized_tx, release_oversized_rx) = mpsc::channel();
        let (after_acquired_tx, after_acquired_rx) = mpsc::channel();

        std::thread::scope(|scope| {
            let budget = &budget;
            scope.spawn(move || {
                let guard = budget.reserve_standalone_bytes(1, 20 * MIB).unwrap();
                oversized_acquired_tx.send(()).unwrap();
                release_oversized_rx.recv().unwrap();
                drop(guard);
            });

            assert!(
                oversized_acquired_rx
                    .recv_timeout(Duration::from_millis(50))
                    .is_err(),
                "oversized page must wait while another page holds 6 MiB"
            );
            drop(normal_first);
            oversized_acquired_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("oversized page must acquire exclusively once active bytes reach 0");

            scope.spawn(move || {
                let _guard = budget.reserve_standalone_bytes(2, 4 * MIB).unwrap();
                after_acquired_tx.send(()).unwrap();
            });
            assert!(
                after_acquired_rx
                    .recv_timeout(Duration::from_millis(50))
                    .is_err(),
                "normal page must not run concurrently with exclusive oversized page"
            );

            release_oversized_tx.send(()).unwrap();
            after_acquired_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("normal page must resume after exclusive oversized page drops");
        });
        assert_eq!(
            budget.metrics().peak_in_flight_bytes,
            20 * MIB,
            "oversized page must never overlap with another page's bytes"
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn single_worker_pdf_multiframe_tiff_and_tiff_export_honor_byte_admission() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "evb-combine-all-paths-budget-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let mut paths = Vec::new();
        for index in 0..4usize {
            let mut ppm = b"P6\n16 16\n255\n".to_vec();
            ppm.resize(ppm.len() + 16 * 16 * 3, (index as u8).wrapping_mul(37));
            let path = dir.join(format!("tile-{index}.ppm"));
            std::fs::write(&path, ppm).unwrap();
            paths.push(path);
        }
        let pdf_out = dir.join("single-worker.pdf");
        let tiff_out = dir.join("exported.tiff");
        // Fits one tile's raster plus its ~416 KiB live Flate encoder (PDF)
        // or Deflate strip encoder (TIFF export).
        let cap = 1024 * 1024u64;

        // 1. Single-worker path PDF honors byte and FD admission.
        let (_, single_metrics) = write_pdf_paths_impl(
            Vec::new(),
            &pdf_out,
            paths.iter().cloned().map(|source| {
                Ok(PageSpec::Image {
                    page_size: None,
                    placement: None,
                    rotation_degrees: 0,
                    image: ImageSpec {
                        source,
                        compression: ImageCompression::Auto,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    frames: FramePolicy::All,
                })
            }),
            &PdfBuildOptions {
                worker_threads: 1,
                max_open_input_fds: 2,
                max_in_flight_bytes: cap,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();
        assert!(single_metrics.peak_open_fds >= 1 && single_metrics.peak_open_fds <= 2);
        assert!(
            single_metrics.peak_in_flight_bytes > 0 && single_metrics.peak_in_flight_bytes <= cap,
            "single_metrics={single_metrics:?}"
        );

        // 2. Multi-frame TIFF streaming honors byte admission in both 1-worker and multi-worker modes.
        let tiff = two_page_tiff();
        let tiff_cap = 512 * 1024u64;
        for worker_threads in [1usize, 4] {
            let (_, tiff_metrics) = write_pdf_impl(
                Vec::new(),
                [image_page("two.tiff", &tiff, None, FramePolicy::All)],
                &PdfBuildOptions {
                    worker_threads,
                    max_in_flight_bytes: tiff_cap,
                    ..PdfBuildOptions::default()
                },
                |_| {},
            )
            .unwrap();
            assert!(
                tiff_metrics.peak_in_flight_bytes >= 412_736
                    && tiff_metrics.peak_in_flight_bytes <= tiff_cap,
                "worker_threads={worker_threads} tiff_metrics={tiff_metrics:?}"
            );

            // Under a tight 64 KiB cap (below the >=412,736-byte Flate encoder
            // overhead), streamed TIFF frames still make exclusive oversized
            // forward progress without deadlocking.
            let (_, tight_tiff_metrics) = write_pdf_impl(
                Vec::new(),
                [image_page("two.tiff", &tiff, None, FramePolicy::All)],
                &PdfBuildOptions {
                    worker_threads,
                    max_in_flight_bytes: 64 * 1024,
                    ..PdfBuildOptions::default()
                },
                |_| {},
            )
            .unwrap();
            assert_eq!(
                tight_tiff_metrics.peak_in_flight_bytes, tiff_metrics.peak_in_flight_bytes,
                "oversized streamed TIFF frame peak must match single-frame reservation"
            );
        }

        // 3. TIFF export honors FD and byte admission.
        let export_metrics = combine_tiff_pages_with_limits(
            &paths,
            &tiff_out,
            DEFAULT_MAX_IMAGE_PIXELS,
            16,
            Some(72),
            2,
            cap,
        )
        .unwrap();
        assert!(export_metrics.peak_open_fds >= 1 && export_metrics.peak_open_fds <= 2);
        assert!(
            export_metrics.peak_in_flight_bytes > 0 && export_metrics.peak_in_flight_bytes <= cap,
            "export_metrics={export_metrics:?}"
        );

        // 4. Multi-worker PDF with an oversized single page amidst small pages
        // makes exclusive forward progress without deadlocking.
        let big_ppm = dir.join("oversized.ppm");
        let mut big = b"P6\n256 256\n255\n".to_vec();
        big.resize(big.len() + 256 * 256 * 3, 0x55);
        std::fs::write(&big_ppm, big).unwrap();
        let mixed_paths = [
            paths[0].clone(),
            big_ppm,
            paths[1].clone(),
            paths[2].clone(),
        ];
        let make_mixed = || {
            mixed_paths.iter().cloned().map(|source| {
                Ok(PageSpec::Image {
                    page_size: None,
                    placement: None,
                    rotation_degrees: 0,
                    image: ImageSpec {
                        source,
                        compression: ImageCompression::Auto,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    frames: FramePolicy::All,
                })
            })
        };
        let (expected_pdf, _) = write_pdf_paths_impl(
            Vec::new(),
            &pdf_out,
            make_mixed(),
            &PdfBuildOptions {
                worker_threads: 1,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();
        let (actual_pdf, mixed_metrics) = write_pdf_paths_impl(
            Vec::new(),
            &pdf_out,
            make_mixed(),
            &PdfBuildOptions {
                worker_threads: 4,
                max_open_input_fds: 2,
                max_in_flight_bytes: 900 * 1024,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(expected_pdf, actual_pdf);
        // Two ~428 KiB tiles fit the 900 KiB cap together; the 256x256 page
        // (loaded raster + Flate working set, ~1 MiB) does not, so it ran
        // exclusively and its reservation alone is the peak.
        let oversized_peak = 256 * 256 * 3
            + estimate_netpbm_page_encode_bytes(256, 256, 3, PdfImageCompression::Auto);
        assert!(oversized_peak > 900 * 1024);
        assert_eq!(
            mixed_metrics.peak_in_flight_bytes, oversized_peak,
            "oversized page overlapped a sibling page"
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn preopened_pipeline_rejects_specs_exceeding_fd_cap_and_accounts_for_lookahead() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "evb-combine-preopened-fd-cap-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let bg_path = dir.join("bg.pgm");
        let fg_path = dir.join("fg.pgm");
        let mask_path = dir.join("mask.pbm");
        std::fs::write(&bg_path, b"P5\n8 1\n255\n\xf0\xf0\xf0\xf0\xf0\xf0\xf0\xf0").unwrap();
        std::fs::write(&fg_path, b"P5\n8 1\n255\n\x10\x20\x30\x40\x50\x60\x70\x80").unwrap();
        std::fs::write(&mask_path, b"P4\n8 1\n\xc0").unwrap();

        let make_affine_spec = || PageSpec::AffineMaskedLayered {
            page_size: PAGE,
            background: ImageSpec {
                source: InputSource::File {
                    label: bg_path.clone(),
                    file: File::open(&bg_path).unwrap(),
                },
                compression: ImageCompression::Auto,
                processing: ImageProcessing::None,
                size_guardrail: None,
            },
            foreground: ImageSpec {
                source: InputSource::File {
                    label: fg_path.clone(),
                    file: File::open(&fg_path).unwrap(),
                },
                compression: ImageCompression::Auto,
                processing: ImageProcessing::None,
                size_guardrail: None,
            },
            foreground_mask: InputSource::File {
                label: mask_path.clone(),
                file: File::open(&mask_path).unwrap(),
            },
            foreground_mask_decode: PdfBilevelDecode::Default,
            foreground_matrix: [72.0, 0.0, 0.0, 36.0, 0.0, 0.0],
        };

        // 3 open File handles on one affine page must be rejected when max_open_input_fds < 3
        // (both as first spec and as a later spec, under 1 worker and 4 workers).
        for worker_threads in [1usize, 4] {
            for fd_cap in [1usize, 2] {
                let first_err = write_pdf(
                    Vec::new(),
                    [make_affine_spec()],
                    &PdfBuildOptions {
                        worker_threads,
                        max_open_input_fds: fd_cap,
                        ..PdfBuildOptions::default()
                    },
                    |_| {},
                )
                .unwrap_err();
                assert_eq!(
                    first_err.downcast_ref::<NativeError>().map(|e| e.code),
                    Some(NativeErrorCode::TooLarge),
                    "worker_threads={worker_threads} fd_cap={fd_cap} err={first_err}"
                );

                let later_err = write_pdf(
                    Vec::new(),
                    [
                        PageSpec::Image {
                            page_size: None,
                            placement: None,
                            rotation_degrees: 0,
                            image: ImageSpec {
                                source: InputSource::File {
                                    label: bg_path.clone(),
                                    file: File::open(&bg_path).unwrap(),
                                },
                                compression: ImageCompression::Auto,
                                processing: ImageProcessing::None,
                                size_guardrail: None,
                            },
                            frames: FramePolicy::All,
                        },
                        make_affine_spec(),
                    ],
                    &PdfBuildOptions {
                        worker_threads,
                        max_open_input_fds: fd_cap,
                        ..PdfBuildOptions::default()
                    },
                    |_| {},
                )
                .unwrap_err();
                assert_eq!(
                    later_err.downcast_ref::<NativeError>().map(|e| e.code),
                    Some(NativeErrorCode::TooLarge),
                    "later spec worker_threads={worker_threads} fd_cap={fd_cap} err={later_err}"
                );
            }
        }

        // With max_open_input_fds == 3, the 3-handle affine page succeeds and stays <= 3 FDs.
        let (_, affine_metrics) = write_pdf_impl(
            Vec::new(),
            [make_affine_spec()],
            &PdfBuildOptions {
                worker_threads: 4,
                max_open_input_fds: 3,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(affine_metrics.peak_open_fds, 3);

        // Multi-spec lookahead is also accounted in the FD cap.
        let (_, multi_metrics) = write_pdf_impl(
            Vec::new(),
            (0..8).map(|_| PageSpec::Image {
                page_size: None,
                placement: None,
                rotation_degrees: 0,
                image: ImageSpec {
                    source: InputSource::File {
                        label: bg_path.clone(),
                        file: File::open(&bg_path).unwrap(),
                    },
                    compression: ImageCompression::Auto,
                    processing: ImageProcessing::None,
                    size_guardrail: None,
                },
                frames: FramePolicy::All,
            }),
            &PdfBuildOptions {
                worker_threads: 4,
                max_open_input_fds: 2,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();
        assert!(
            multi_metrics.peak_open_fds <= 2,
            "lookahead exceeded max_open_input_fds=2: peak={}",
            multi_metrics.peak_open_fds
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn preopened_fifo_with_silent_writer_is_rejected_without_blocking() {
        use std::os::unix::fs::OpenOptionsExt;
        use std::process::Command;
        use std::sync::mpsc;
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "evb-combine-preopened-fifo-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let fifo_path = dir.join("silent.ppm");
        let status = Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .expect("mkfifo should be available on Unix");
        assert!(status.success(), "mkfifo failed");

        // Hold a connected silent writer open (via O_RDWR) so opening the FIFO
        // read end succeeds immediately and any unvalidated `read()` would block
        // forever waiting for bytes.
        let _silent_writer = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(UNIX_O_NONBLOCK)
            .open(&fifo_path)
            .unwrap();

        let (tx, rx) = mpsc::channel();
        let fifo_for_thread = fifo_path.clone();
        std::thread::spawn(move || {
            let mut results = Vec::new();
            for worker_threads in [1usize, 4] {
                let options = PdfBuildOptions {
                    worker_threads,
                    ..PdfBuildOptions::default()
                };
                // 1. Ordinary non-streaming InputSource::File path.
                let ordinary_reader = File::open(&fifo_for_thread).unwrap();
                let ordinary_err = write_pdf(
                    Vec::new(),
                    [PageSpec::Image {
                        page_size: None,
                        placement: None,
                        rotation_degrees: 0,
                        image: ImageSpec {
                            source: InputSource::File {
                                label: fifo_for_thread.clone(),
                                file: ordinary_reader,
                            },
                            compression: ImageCompression::Auto,
                            processing: ImageProcessing::None,
                            size_guardrail: None,
                        },
                        frames: FramePolicy::All,
                    }],
                    &options,
                    |_| {},
                )
                .unwrap_err();
                results.push((
                    ordinary_err
                        .downcast_ref::<NativeError>()
                        .map(|err| err.code),
                    ordinary_err.to_string(),
                ));

                // 2. Streamed TIFF InputSource::File path.
                let tiff_reader = File::open(&fifo_for_thread).unwrap();
                let tiff_err = write_pdf(
                    Vec::new(),
                    [PageSpec::Image {
                        page_size: None,
                        placement: None,
                        rotation_degrees: 0,
                        image: ImageSpec {
                            source: InputSource::File {
                                label: PathBuf::from("streamed-fifo.tiff"),
                                file: tiff_reader,
                            },
                            compression: ImageCompression::Auto,
                            processing: ImageProcessing::None,
                            size_guardrail: None,
                        },
                        frames: FramePolicy::All,
                    }],
                    &options,
                    |_| {},
                )
                .unwrap_err();
                results.push((
                    tiff_err.downcast_ref::<NativeError>().map(|err| err.code),
                    tiff_err.to_string(),
                ));
            }
            let _ = tx.send(results);
        });

        let results = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("pre-opened FIFO with silent writer blocked write_pdf");
        drop(_silent_writer);
        std::fs::remove_dir_all(dir).unwrap();

        assert_eq!(results.len(), 4);
        for (code, message) in results {
            assert_eq!(code, Some(NativeErrorCode::NativeFailure), "{message}");
            assert!(
                message.contains("Input is not a regular file"),
                "unexpected FIFO rejection message: {message}"
            );
        }
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn byte_backed_exact_and_layered_tiffs_enforce_decoded_byte_budget() {
        use tiff::encoder::{Compression as TiffCompression, DeflateLevel};

        // 512x512 solid RGB8 Deflate TIFF: tiny compressed payload (<8 KiB)
        // whose decode + worst-case Flate peak is ~1.57 MiB (> 2 * 768 KiB).
        const WIDTH: u32 = 512;
        const HEIGHT: u32 = 512;
        let decoded_frame_bytes = u64::from(WIDTH) * u64::from(HEIGHT) * 3;
        let pixels = vec![0x7au8; decoded_frame_bytes as usize];
        let mut compressed_tiff = Vec::new();
        {
            let mut encoder = TiffEncoder::new(Cursor::new(&mut compressed_tiff))
                .unwrap()
                .with_compression(TiffCompression::Deflate(DeflateLevel::Fast));
            let mut image = encoder.new_image::<colortype::RGB8>(WIDTH, HEIGHT).unwrap();
            image.resolution(ResolutionUnit::Inch, Rational { n: 72, d: 1 });
            image.write_data(&pixels).unwrap();
        }
        assert!(
            (compressed_tiff.len() as u64) < 32 * 1024,
            "fixture TIFF should be much smaller compressed than decoded: {}",
            compressed_tiff.len()
        );

        // Cap (4 MiB) fits one page at a time, NOT two: an exact page's
        // ~2.7 MiB decode+encode peak (including Flate Vec doubling capacity),
        // or a layered page's ~3.1 MiB peak with its PBM mask encoder.
        let cap = 4 * 1024 * 1024u64;

        // Test both ordinary names and leading-dot names (`.tif`) where
        // `Path::extension()` returns `None`.
        for file_name in ["exact.tiff", ".tif"] {
            // 1. Multiple FramePolicy::ExactlyOne byte-backed TIFFs under 4 workers.
            let make_exact_specs = || {
                (0..4).map(|_| {
                    image_page(
                        file_name,
                        &compressed_tiff,
                        Some(PAGE),
                        FramePolicy::ExactlyOne,
                    )
                })
            };
            let (single_exact, _) = write_pdf_impl(
                Vec::new(),
                make_exact_specs(),
                &PdfBuildOptions {
                    worker_threads: 1,
                    max_in_flight_bytes: cap,
                    ..PdfBuildOptions::default()
                },
                |_| {},
            )
            .unwrap();
            let (multi_exact, exact_metrics) = write_pdf_impl(
                Vec::new(),
                make_exact_specs(),
                &PdfBuildOptions {
                    worker_threads: 4,
                    max_in_flight_bytes: cap,
                    ..PdfBuildOptions::default()
                },
                |_| {},
            )
            .unwrap();
            assert_eq!(single_exact, multi_exact, "file_name={file_name}");
            assert!(
                exact_metrics.peak_in_flight_bytes >= decoded_frame_bytes * 2
                    && exact_metrics.peak_in_flight_bytes <= cap,
                "file_name={file_name} exact byte-backed TIFF peak_in_flight_bytes={} expected in [{}, {cap}]",
                exact_metrics.peak_in_flight_bytes,
                decoded_frame_bytes * 2
            );

            // 2. Multiple Layered pages with byte-backed TIFF backgrounds under 4 workers.
            let mask_pbm = b"P4\n8 1\n\xc0";
            let make_layered_specs = || {
                (0..4).map(|_| PageSpec::Layered {
                    page_size: PAGE,
                    background: ImageSpec {
                        source: InputSource::Bytes {
                            file_name,
                            data: &compressed_tiff,
                        },
                        compression: ImageCompression::Auto,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    foreground_mask: InputSource::Bytes {
                        file_name: "mask.pbm",
                        data: mask_pbm,
                    },
                    foreground_color: None,
                })
            };
            let (single_layered, _) = write_pdf_impl(
                Vec::new(),
                make_layered_specs(),
                &PdfBuildOptions {
                    worker_threads: 1,
                    max_in_flight_bytes: cap,
                    ..PdfBuildOptions::default()
                },
                |_| {},
            )
            .unwrap();
            let (multi_layered, layered_metrics) = write_pdf_impl(
                Vec::new(),
                make_layered_specs(),
                &PdfBuildOptions {
                    worker_threads: 4,
                    max_in_flight_bytes: cap,
                    ..PdfBuildOptions::default()
                },
                |_| {},
            )
            .unwrap();
            assert_eq!(single_layered, multi_layered, "file_name={file_name}");
            assert!(
                layered_metrics.peak_in_flight_bytes >= decoded_frame_bytes * 2
                    && layered_metrics.peak_in_flight_bytes <= cap,
                "file_name={file_name} layered byte-backed TIFF peak_in_flight_bytes={} expected in [{}, {cap}]",
                layered_metrics.peak_in_flight_bytes,
                decoded_frame_bytes * 2
            );
        }
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn incompressible_tiff_reserves_encoding_peak_coexistence_and_shrinks_to_retained_stream() {
        const WIDTH: u32 = 512;
        const HEIGHT: u32 = 512;
        let raw_bytes = u64::from(WIDTH) * u64::from(HEIGHT) * 3;
        let mut state = 0x1234_5678u32;
        let mut pixels = Vec::with_capacity(raw_bytes as usize);
        for _ in 0..raw_bytes {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            pixels.push((state & 0xff) as u8);
        }
        let mut tiff_bytes = Vec::new();
        {
            let mut encoder = TiffEncoder::new(Cursor::new(&mut tiff_bytes)).unwrap();
            let mut image = encoder.new_image::<colortype::RGB8>(WIDTH, HEIGHT).unwrap();
            image.resolution(ResolutionUnit::Inch, Rational { n: 72, d: 1 });
            image.write_data(&pixels).unwrap();
        }

        // Verify direct per-frame reservation covers raw raster + incompressible
        // Flate stream coexistence and shrinks to the exact retained stream size.
        let budget = PipelineBudget::new(4, 16 * 1024 * 1024);
        let mut reservation = budget.empty_reservation(0);
        let mut retained_bytes = 0u64;
        let pages = crate::tiff_io::visit_tiff_pdf_pages_from_bytes_budgeted(
            &tiff_bytes,
            DEFAULT_MAX_IMAGE_PIXELS,
            None,
            16,
            Some(TiffBudget::Page(&mut reservation)),
            |page| {
                retained_bytes = page.payload_bytes();
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(pages, 1);
        assert!(
            retained_bytes >= raw_bytes,
            "incompressible RGB8 Flate stream should be >= raw raster: retained={retained_bytes} raw={raw_bytes}"
        );
        let actual_coexistence_peak = raw_bytes + retained_bytes;
        assert!(
            budget.metrics().peak_in_flight_bytes >= actual_coexistence_peak,
            "reserved peak {} did not cover raw+encoded coexistence {}",
            budget.metrics().peak_in_flight_bytes,
            actual_coexistence_peak
        );
        assert_eq!(
            reservation.held_bytes(),
            retained_bytes,
            "reservation must shrink to exact retained stream size after decoded raster drops"
        );
        drop(reservation);

        // Also verify end-to-end ExactlyOne and All streaming modes reserve the full coexistence peak.
        for frames in [FramePolicy::ExactlyOne, FramePolicy::All] {
            let (_, metrics) = write_pdf_impl(
                Vec::new(),
                [image_page("random.tiff", &tiff_bytes, Some(PAGE), frames)],
                &PdfBuildOptions {
                    worker_threads: 2,
                    max_in_flight_bytes: 16 * 1024 * 1024,
                    ..PdfBuildOptions::default()
                },
                |_| {},
            )
            .unwrap();
            assert!(
                metrics.peak_in_flight_bytes >= actual_coexistence_peak,
                "frames={frames:?} peak {} < coexistence {}",
                metrics.peak_in_flight_bytes,
                actual_coexistence_peak
            );
        }
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn parallel_byte_backed_exact_tiffs_decode_and_encode_concurrently_after_admission() {
        const WIDTH: u32 = 512;
        const HEIGHT: u32 = 512;
        let raw_bytes = u64::from(WIDTH) * u64::from(HEIGHT) * 3;
        let mut state = 0x9e37_79b9u32;
        let mut pixels = Vec::with_capacity(raw_bytes as usize);
        for _ in 0..raw_bytes {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            pixels.push((state & 0xff) as u8);
        }
        let mut tiff_bytes = Vec::new();
        {
            let mut encoder = TiffEncoder::new(Cursor::new(&mut tiff_bytes)).unwrap();
            let mut image = encoder.new_image::<colortype::RGB8>(WIDTH, HEIGHT).unwrap();
            image.resolution(ResolutionUnit::Inch, Rational { n: 72, d: 1 });
            image.write_data(&pixels).unwrap();
        }

        let make_specs = || {
            (0..12).map(|index| {
                let name = if index % 2 == 0 {
                    ".tif"
                } else {
                    "parallel.tiff"
                };
                image_page(name, &tiff_bytes, Some(PAGE), FramePolicy::ExactlyOne)
            })
        };

        let (single_pdf, _) = write_pdf_impl(
            Vec::new(),
            make_specs(),
            &PdfBuildOptions {
                worker_threads: 1,
                max_in_flight_bytes: 64 * 1024 * 1024,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();
        // Hold the first two workers at preparation entry until both are
        // inside, so the peak no longer depends on thread scheduling.
        TEST_PREPARE_RENDEZVOUS.with(|gate| gate.set(2));
        let parallel = write_pdf_impl(
            Vec::new(),
            make_specs(),
            &PdfBuildOptions {
                worker_threads: 4,
                max_in_flight_bytes: 64 * 1024 * 1024,
                ..PdfBuildOptions::default()
            },
            |_| {},
        );
        TEST_PREPARE_RENDEZVOUS.with(|gate| gate.set(0));
        let (parallel_pdf, metrics) = parallel.unwrap();

        assert_eq!(single_pdf, parallel_pdf);
        assert!(
            metrics.peak_concurrent_prepares >= 2,
            "byte-backed ExactlyOne TIFFs serialized behind admission turn: peak_concurrent_prepares={}",
            metrics.peak_concurrent_prepares
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn jpeg_icc_profile_assembly_is_reserved_before_preparation_and_plain_jpegs_are_unchanged() {
        let profile = vec![0x5au8; 48 * 1024];
        let icc_jpeg = jpeg_with_icc(&[0x40], jpeg_encoder::ColorType::Luma, &profile);
        let mut plain_jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut plain_jpeg, 90)
            .encode(&[0x40], 1, 1, jpeg_encoder::ColorType::Luma)
            .unwrap();
        let peak = |file_name: &str, data: &[u8]| {
            write_pdf_impl(
                Vec::new(),
                [image_page(
                    file_name,
                    data,
                    Some(PAGE),
                    FramePolicy::ExactlyOne,
                )],
                &PdfBuildOptions::default(),
                |_| {},
            )
            .unwrap()
            .1
            .peak_in_flight_bytes
        };

        // Source bytes, their owned copy, the 1x1 gray decode, and the ICC
        // chunk copies plus assembled profile.
        assert_eq!(
            peak("icc.jpg", &icc_jpeg),
            2 * icc_jpeg.len() as u64 + 1 + 2 * profile.len() as u64
        );
        // Without ICC data nothing beyond the decode estimate is reserved.
        assert_eq!(
            peak("plain.jpg", &plain_jpeg),
            2 * plain_jpeg.len() as u64 + 1
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn netpbm_pages_byte_backed_pbm_masks_and_soft_masks_reserve_their_encoders() {
        use crate::tiff_io::estimate_up_filtered_flate_working_set_bytes;

        let options = PdfBuildOptions::default();
        let peak = |spec: PdfPageSpec<'_>| {
            write_pdf_impl(Vec::new(), [spec], &options, |_| {})
                .unwrap()
                .1
                .peak_in_flight_bytes
        };

        // 1. An automatic PGM page from an open file keeps its loaded raster
        //    live while the Flate encoder, filter row, and output grow.
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "evb-combine-netpbm-admission-{}-{nonce}.pgm",
            std::process::id()
        ));
        std::fs::write(&path, b"P5\n4 2\n255\n\x10\x20\x30\x40\x50\x60\x70\x80").unwrap();
        let file_peak = peak(PageSpec::Image {
            page_size: None,
            placement: None,
            rotation_degrees: 0,
            image: ImageSpec {
                source: InputSource::File {
                    label: path.clone(),
                    file: File::open(&path).unwrap(),
                },
                compression: ImageCompression::Auto,
                processing: ImageProcessing::None,
                size_guardrail: None,
            },
            frames: FramePolicy::All,
        });
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            file_peak,
            8 + estimate_up_filtered_flate_working_set_bytes(4, 2)
        );

        // 2. A byte-backed PBM mask copies its bitmap and then encodes it.
        let mask = b"P4\n8 1\n\xc0";
        let mask_peak = peak(PageSpec::Mask {
            page_size: PAGE,
            foreground_mask: InputSource::Bytes {
                file_name: "mask.pbm",
                data: mask,
            },
        });
        assert_eq!(
            mask_peak,
            mask.len() as u64 + 1 + estimate_bilevel_encode_peak_bytes(8, 1)
        );

        // 3. A byte-backed RGB soft mask copies its raster, converts it to
        //    luma, and Flate-encodes it next to a Flate-encoded background.
        let background = b"P5\n1 1\n255\n\xff";
        let alpha = b"P6\n2 1\n255\n\x00\x00\x00\x00\xff\x00";
        let soft_peak = peak(PageSpec::SoftLayered {
            page_size: PAGE,
            background: ImageSpec {
                source: InputSource::Bytes {
                    file_name: "background.pgm",
                    data: background,
                },
                compression: ImageCompression::Auto,
                processing: ImageProcessing::None,
                size_guardrail: None,
            },
            foreground_alpha: InputSource::Bytes {
                file_name: "alpha.ppm",
                data: alpha,
            },
            foreground_color: None,
        });
        assert_eq!(
            soft_peak,
            (background.len() + alpha.len()) as u64
                + estimate_up_filtered_flate_working_set_bytes(1, 1)
                + 6
                + 2
                + estimate_up_filtered_flate_working_set_bytes(2, 1)
        );
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn positioned_netpbm_file_sources_check_truncation_from_their_start() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let prefix = vec![b'#'; 32];
        let header = b"P5\n2 2\n255\n";
        let write_positioned = |label: &str, raster: &[u8]| {
            let path = std::env::temp_dir().join(format!(
                "evb-combine-positioned-{label}-{}-{nonce}.pgm",
                std::process::id()
            ));
            let mut bytes = prefix.clone();
            bytes.extend_from_slice(header);
            bytes.extend_from_slice(raster);
            std::fs::write(&path, bytes).unwrap();
            let mut file = File::open(&path).unwrap();
            std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(prefix.len() as u64)).unwrap();
            (path, file)
        };
        let build = |path: &Path, file: File| {
            write_pdf(
                Vec::new(),
                [PageSpec::Image {
                    page_size: None,
                    placement: None,
                    rotation_degrees: 0,
                    image: ImageSpec {
                        source: InputSource::File {
                            label: path.to_path_buf(),
                            file,
                        },
                        compression: ImageCompression::Auto,
                        processing: ImageProcessing::None,
                        size_guardrail: None,
                    },
                    frames: FramePolicy::All,
                }],
                &PdfBuildOptions::default(),
                |_| {},
            )
        };

        let (valid_path, valid_file) = write_positioned("valid", &[1, 2, 3, 4]);
        let valid = build(&valid_path, valid_file);
        std::fs::remove_file(&valid_path).unwrap();
        let pdf = valid.unwrap();
        assert!(contains_bytes(&pdf, b"/Width 2"));

        // Two raster bytes are missing; the 32-byte prefix would hide that
        // if the bound were measured from the start of the file.
        let (truncated_path, truncated_file) = write_positioned("truncated", &[1, 2]);
        let truncated = build(&truncated_path, truncated_file);
        std::fs::remove_file(&truncated_path).unwrap();
        let error = match truncated {
            Ok(_) => panic!("truncated positioned PGM was accepted"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("Truncated Netpbm payload"),
            "unexpected error: {error}"
        );
    }

    fn image_page<'a>(
        file_name: &'a str,
        data: &'a [u8],
        page_size: Option<PdfPageSize>,
        frames: FramePolicy,
    ) -> PdfPageSpec<'a> {
        PageSpec::Image {
            page_size,
            placement: None,
            rotation_degrees: 0,
            image: ImageSpec {
                source: InputSource::Bytes { file_name, data },
                compression: ImageCompression::Auto,
                processing: ImageProcessing::None,
                size_guardrail: None,
            },
            frames,
        }
    }

    fn jpeg_with_flate_fallback_page<'a>(
        file_name: &'a str,
        data: &'a [u8],
        quality: u8,
    ) -> PdfPageSpec<'a> {
        PageSpec::Image {
            page_size: Some(PAGE),
            placement: None,
            rotation_degrees: 0,
            image: ImageSpec {
                source: InputSource::Bytes { file_name, data },
                compression: ImageCompression::JpegWithFlateFallback { quality },
                processing: ImageProcessing::None,
                size_guardrail: None,
            },
            frames: FramePolicy::ExactlyOne,
        }
    }

    fn two_page_tiff() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = TiffEncoder::new(Cursor::new(&mut bytes)).unwrap();
            let mut first = encoder.new_image::<colortype::RGB8>(1, 1).unwrap();
            first.resolution(ResolutionUnit::Inch, Rational { n: 72, d: 1 });
            first.write_data(&[255, 0, 0]).unwrap();
            let mut second = encoder.new_image::<colortype::RGB8>(2, 1).unwrap();
            second.resolution(ResolutionUnit::Inch, Rational { n: 72, d: 1 });
            second.write_data(&[0, 255, 0, 0, 0, 255]).unwrap();
        }
        bytes
    }

    fn png_with_icc(color_type: u8, pixels: &[u8], profile: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, color_type, 0, 0, 0]);
        let mut iccp = b"golden\0\0".to_vec();
        iccp.extend_from_slice(&zlib(profile));
        let idat = zlib(pixels);
        (
            [
                b"\x89PNG\r\n\x1a\n".as_slice(),
                &png_chunk(b"IHDR", &ihdr),
                &png_chunk(b"iCCP", &iccp),
                &png_chunk(b"IDAT", &idat),
                &png_chunk(b"IEND", b""),
            ]
            .concat(),
            idat,
        )
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        let mut crc = crc32fast::Hasher::new();
        crc.update(kind);
        crc.update(data);
        chunk.extend_from_slice(&crc.finalize().to_be_bytes());
        chunk
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    fn jpeg_with_icc(
        pixels: &[u8],
        color_type: jpeg_encoder::ColorType,
        profile: &[u8],
    ) -> Vec<u8> {
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 90)
            .encode(pixels, 1, 1, color_type)
            .unwrap();
        let mut segment = b"\xff\xe2".to_vec();
        let payload_len = b"ICC_PROFILE\0".len() + 2 + profile.len();
        segment.extend_from_slice(&u16::try_from(payload_len + 2).unwrap().to_be_bytes());
        segment.extend_from_slice(b"ICC_PROFILE\0");
        segment.extend_from_slice(&[1, 1]);
        segment.extend_from_slice(profile);
        jpeg.splice(2..2, segment);
        jpeg
    }

    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    #[derive(Default)]
    struct SinkState {
        bytes: usize,
        writes: usize,
    }

    struct CountingSink {
        state: Rc<RefCell<SinkState>>,
        fail_after: Option<usize>,
    }

    struct FailOnPageObjectSink;

    impl Write for FailOnPageObjectSink {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            if buffer
                .windows(b"/Type /Page".len())
                .any(|window| window == b"/Type /Page")
            {
                return Err(IoError::other("page object write blocked"));
            }
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Write for CountingSink {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            let mut state = self.state.borrow_mut();
            let allowed = self
                .fail_after
                .map(|limit| limit.saturating_sub(state.bytes))
                .unwrap_or(buffer.len())
                .min(buffer.len());
            if allowed == 0 {
                return Err(IoError::other("counting sink limit"));
            }
            state.bytes += allowed;
            state.writes += 1;
            Ok(allowed)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
