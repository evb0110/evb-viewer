//! Image-to-PDF combination used by the native CLI and browser WASM build.
//!
//! Set `EVB_PDF_COMBINE_TIMING=1` when running the native CLI to emit one
//! `jbig2-encode-timing` JSON object on stderr for every bilevel base image or
//! image mask. `elapsedMs` is the verified JBIG2 candidate's encode-and-decode
//! wall time for that page; records appear in page-encoding order, which is not
//! page order once more than one encoder runs. `EVB_PDF_COMBINE_THREADS` caps
//! that fan-out; the written PDF is byte-identical at every setting.

mod binary;
mod flate;
mod image;
mod jpeg;
mod jpx;
mod netpbm;
mod pdf;
mod tiff_io;

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
mod wasm;

use std::{
    borrow::Cow,
    error::Error,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use evb_native_support::{
    output::{AtomicOutput, ValidatedInputFiles},
    NativeError, NativeErrorCode,
};
use evb_raster_io::{decode_png_gray, write_png, write_png_with_dpi, DecodeLimits, PixelBuffer};

use crate::{
    image::{
        assert_pixel_limit, read_image_page_from_bytes, read_image_page_from_file,
        visit_image_pages_from_bytes, visit_image_pages_from_file, PdfImageCompression,
    },
    netpbm::{
        is_rgb_data_grayscale, parse_netpbm, parse_pbm_p4, read_netpbm_file, read_pbm_p4_file,
        OwnedNetpbm,
    },
    pdf::{
        apply_shared_symbol_encoding, write_pdf_to_writer, AffineMaskedLayeredPdfPage,
        BilevelStream, ImagePage, ImagePayload, LayeredImagePayload, LayeredPdfImage,
        LayeredPdfPage, MaskPdfPage, PdfWriter, SoftLayeredPdfPage, SoftMaskStream,
    },
    tiff_io::combine_tiff_pages,
};

pub use crate::{
    image::JpegSizeGuardrail,
    netpbm::{probe_netpbm_path, NetpbmProbe},
    pdf::{PdfImagePlacement, PdfPageSize},
};
pub use evb_native_support::pdf_catalog::{BookmarkEntry, PageLabelRange};

pub const DEFAULT_DPI: u32 = 72;
pub const DEFAULT_MAX_IMAGE_PIXELS: u64 = 80_000_000;
pub const DEFAULT_MAX_BILEVEL_PIXELS: u64 = 160_000_000;
/// Shared output cap for native, WASM, and browser PDF combines.
pub const PDF_COMBINE_MAX_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const CM_PER_INCH: f64 = 2.54;
pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn too_large_error(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(NativeError::new(NativeErrorCode::TooLarge, message))
}

#[doc(hidden)]
pub fn fuzz_parse_jpeg(data: &[u8]) {
    let _ = jpeg::parse_jpeg_metadata(data);
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

pub struct PdfBuildOptions {
    pub default_dpi: Option<u32>,
    pub max_pages: usize,
    pub max_pixels: u64,
    pub max_bilevel_pixels: u64,
    pub max_output_bytes: u64,
    pub max_tiff_frames: usize,
    /// Lowercase hex encoding of the canonical JSON provenance payload to
    /// publish in the PDF Info dictionary.
    pub provenance_stamp_hex: Option<String>,
    /// Pages whose payloads may be encoded concurrently. The written bytes are
    /// identical for every value; only wall-clock and peak memory change.
    pub worker_threads: usize,
    /// Enables the experimental cross-page JBIG2 symbol pass. This remains
    /// opt-in because its conservative, lossless verification can add
    /// substantial wall-clock time without reliably beating the generic
    /// per-page payloads on scanned books.
    pub enable_shared_symbol_encoding: bool,
    /// Optional outline entries written into the output catalog.
    pub outlines: Vec<BookmarkEntry>,
    /// Optional page-label ranges written into the output catalog.
    pub page_labels: Vec<PageLabelRange>,
}

impl Default for PdfBuildOptions {
    fn default() -> Self {
        Self {
            default_dpi: None,
            max_pages: 500,
            max_pixels: DEFAULT_MAX_IMAGE_PIXELS,
            max_bilevel_pixels: DEFAULT_MAX_BILEVEL_PIXELS,
            max_output_bytes: PDF_COMBINE_MAX_OUTPUT_BYTES,
            max_tiff_frames: 250,
            provenance_stamp_hex: None,
            worker_threads: 1,
            enable_shared_symbol_encoding: false,
            outlines: Vec::new(),
            page_labels: Vec::new(),
        }
    }
}

/// Upper bound on concurrent page encoders. The combiner shares the machine
/// with the scan-cleanup sidecar's own pool, so the fan-out stays bounded
/// instead of tracking the core count without a ceiling.
pub const MAX_WORKER_THREADS: usize = 8;
const JBIG2_SYMBOL_CHUNK_PAGES: usize = 50;

#[must_use]
pub fn default_worker_threads() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| parallelism.get())
        .unwrap_or(1)
        .clamp(1, MAX_WORKER_THREADS)
}

pub fn write_pdf<'a, W, I, P>(
    output: W,
    page_specs: I,
    options: &PdfBuildOptions,
    mut on_processed: P,
) -> Result<W>
where
    W: Write,
    I: IntoIterator<Item = PdfPageSpec<'a>>,
    P: FnMut(usize),
{
    let mut page_specs = page_specs.into_iter().peekable();
    if page_specs.peek().is_none() {
        return Err("At least one image input is required".into());
    }

    let batch_size = options.worker_threads.max(1);
    let encoders = PageEncoders::new(batch_size)?;
    let output = OutputLimitWriter::new(
        output,
        options.max_output_bytes.min(PDF_COMBINE_MAX_OUTPUT_BYTES),
    );
    let mut page_count = 0usize;
    let mut processed = 0usize;
    let output = write_pdf_to_writer(
        output,
        options.provenance_stamp_hex.as_deref(),
        &options.outlines,
        &options.page_labels,
        |pdf| {
            let mut symbol_chunk = options
                .enable_shared_symbol_encoding
                .then(|| Vec::with_capacity(JBIG2_SYMBOL_CHUNK_PAGES));
            loop {
                let batch = page_specs
                    .by_ref()
                    .take(batch_size)
                    .collect::<Vec<PdfPageSpec<'a>>>();
                if batch.is_empty() {
                    if let Some(symbol_chunk) = symbol_chunk.as_mut() {
                        write_symbol_chunk(pdf, symbol_chunk)?;
                    }
                    return Ok(());
                }
                for prepared in encoders.prepare(batch, options) {
                    for page in prepared? {
                        page_count = next_page_count_with_limit(page_count, options.max_pages)?;
                        if let Some(symbol_chunk) = symbol_chunk.as_mut() {
                            symbol_chunk.push(page);
                            if symbol_chunk.len() == JBIG2_SYMBOL_CHUNK_PAGES {
                                write_symbol_chunk(pdf, symbol_chunk)?;
                            }
                        } else {
                            write_prepared_page(pdf, page)?;
                        }
                    }
                    processed += 1;
                    on_processed(processed);
                }
            }
        },
    )
    .map_err(|error| {
        if is_output_limit_exceeded(error.as_ref()) {
            too_large_error(error.to_string())
        } else {
            error
        }
    })?;
    Ok(output.into_inner())
}

fn write_symbol_chunk<W: Write>(
    pdf: &mut PdfWriter<W>,
    pages: &mut Vec<PreparedPage>,
) -> Result<()> {
    let mut masks = pages
        .iter_mut()
        .filter_map(PreparedPage::generated_bilevel_stream_mut)
        .collect::<Vec<_>>();
    apply_shared_symbol_encoding(&mut masks);
    for page in pages.drain(..) {
        write_prepared_page(pdf, page)?;
    }
    Ok(())
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
    fn generated_bilevel_stream_mut(&mut self) -> Option<&mut BilevelStream> {
        match self {
            Self::Image { page, .. } => match &mut page.payload {
                ImagePayload::Bilevel(stream) if stream.supports_symbol_encoding() => Some(stream),
                _ => None,
            },
            Self::Layered(page) if page.foreground_mask.supports_symbol_encoding() => {
                Some(&mut page.foreground_mask)
            }
            Self::AffineMaskedLayered(page) if page.foreground_mask.supports_symbol_encoding() => {
                Some(&mut page.foreground_mask)
            }
            Self::Mask(page) if page.foreground_mask.supports_symbol_encoding() => {
                Some(&mut page.foreground_mask)
            }
            Self::SoftLayered(_)
            | Self::Layered(_)
            | Self::AffineMaskedLayered(_)
            | Self::Mask(_) => None,
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

fn prepare_page_spec(
    spec: PdfPageSpec<'_>,
    options: &PdfBuildOptions,
) -> Result<Vec<PreparedPage>> {
    match spec {
        PageSpec::Image {
            page_size,
            placement,
            rotation_degrees,
            image,
            frames,
        } => prepare_image_spec(
            page_size,
            placement,
            rotation_degrees,
            image,
            frames,
            options,
        ),
        PageSpec::Layered {
            page_size,
            background,
            foreground_mask,
            foreground_color,
        } => {
            let background = read_exact_image(background, options, Some(page_size))?;
            let foreground_mask = read_mask(foreground_mask, options.max_bilevel_pixels)?;
            Ok(vec![PreparedPage::Layered(Box::new(LayeredPdfPage {
                page_size,
                background: image_page_to_layered_image(background)?,
                foreground_mask,
                foreground_color,
            }))])
        }
        PageSpec::SoftLayered {
            page_size,
            background,
            foreground_alpha,
            foreground_color,
        } => {
            let background = read_exact_image(background, options, Some(page_size))?;
            let foreground_alpha = read_soft_mask(foreground_alpha, options.max_pixels)?;
            Ok(vec![PreparedPage::SoftLayered(Box::new(
                SoftLayeredPdfPage {
                    page_size,
                    background: image_page_to_layered_image(background)?,
                    foreground_alpha,
                    foreground_color,
                },
            ))])
        }
        PageSpec::AffineMaskedLayered {
            page_size,
            background,
            foreground,
            foreground_mask,
            foreground_mask_decode,
            foreground_matrix,
        } => {
            let background = read_exact_image(background, options, Some(page_size))?;
            let foreground = read_exact_image(foreground, options, Some(page_size))?;
            let foreground_mask = read_affine_foreground_mask(
                foreground_mask,
                foreground.width,
                foreground.height,
                options.max_bilevel_pixels,
                foreground_mask_decode,
            )?;
            Ok(vec![PreparedPage::AffineMaskedLayered(Box::new(
                AffineMaskedLayeredPdfPage {
                    page_size,
                    background: image_page_to_layered_image(background)?,
                    foreground: image_page_to_layered_image(foreground)?,
                    foreground_mask,
                    foreground_matrix,
                },
            ))])
        }
        PageSpec::Mask {
            page_size,
            foreground_mask,
        } => Ok(vec![PreparedPage::Mask(MaskPdfPage {
            page_size,
            foreground_mask: read_mask(foreground_mask, options.max_bilevel_pixels)?,
        })]),
    }
}

fn prepare_image_spec(
    page_size: Option<PdfPageSize>,
    placement: Option<PdfImagePlacement>,
    rotation_degrees: u16,
    image: ImageSpec<InputSource<'_>>,
    frames: FramePolicy,
    options: &PdfBuildOptions,
) -> Result<Vec<PreparedPage>> {
    let mut prepared = Vec::new();
    match frames {
        FramePolicy::All
            if image.compression == ImageCompression::Auto
                && image.processing == ImageProcessing::None =>
        {
            visit_automatic_pages(image.source, options, |page| {
                prepared.push(PreparedPage::Image {
                    page,
                    page_size,
                    placement,
                    rotation_degrees,
                });
                Ok(())
            })?;
        }
        FramePolicy::All => prepared.push(PreparedPage::Image {
            page: read_processed_image(image, options, page_size)?,
            page_size,
            placement,
            rotation_degrees,
        }),
        FramePolicy::ExactlyOne => prepared.push(PreparedPage::Image {
            page: read_exact_image(image, options, page_size)?,
            page_size,
            placement,
            rotation_degrees,
        }),
    }
    Ok(prepared)
}

#[cfg(not(target_family = "wasm"))]
struct PageEncoders {
    pool: Option<rayon::ThreadPool>,
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

    fn into_error(self) -> Box<dyn Error> {
        match self.code {
            Some(code) => Box::new(NativeError::new(code, self.message)),
            None => self.message.into(),
        }
    }
}

#[cfg(not(target_family = "wasm"))]
impl PageEncoders {
    fn new(threads: usize) -> Result<Self> {
        let pool = if threads > 1 {
            Some(
                rayon::ThreadPoolBuilder::new()
                    .num_threads(threads)
                    .build()?,
            )
        } else {
            None
        };
        Ok(Self { pool })
    }

    fn prepare<'a>(
        &self,
        batch: Vec<PdfPageSpec<'a>>,
        options: &PdfBuildOptions,
    ) -> Vec<Result<Vec<PreparedPage>>> {
        let Some(pool) = self.pool.as_ref() else {
            return prepare_batch_in_order(batch, options);
        };
        use rayon::iter::{IntoParallelIterator, ParallelIterator};
        pool.install(|| {
            batch
                .into_par_iter()
                .map(|spec| prepare_page_spec(spec, options).map_err(PreparedPageError::capture))
                .collect::<Vec<_>>()
        })
        .into_iter()
        .map(|prepared| prepared.map_err(PreparedPageError::into_error))
        .collect()
    }
}

#[cfg(target_family = "wasm")]
struct PageEncoders;

#[cfg(target_family = "wasm")]
impl PageEncoders {
    fn new(_threads: usize) -> Result<Self> {
        Ok(Self)
    }

    fn prepare<'a>(
        &self,
        batch: Vec<PdfPageSpec<'a>>,
        options: &PdfBuildOptions,
    ) -> Vec<Result<Vec<PreparedPage>>> {
        prepare_batch_in_order(batch, options)
    }
}

fn prepare_batch_in_order(
    batch: Vec<PdfPageSpec<'_>>,
    options: &PdfBuildOptions,
) -> Vec<Result<Vec<PreparedPage>>> {
    batch
        .into_iter()
        .map(|spec| prepare_page_spec(spec, options))
        .collect()
}

fn visit_automatic_pages(
    source: InputSource<'_>,
    options: &PdfBuildOptions,
    mut on_page: impl FnMut(ImagePage) -> Result<()>,
) -> Result<usize> {
    if source.is_pbm() {
        on_page(bilevel_image_page(read_mask_bitmap(
            source,
            options.max_bilevel_pixels,
        )?)?)?;
        return Ok(1);
    }

    match source {
        InputSource::File { label, file } => visit_image_pages_from_file(
            &label,
            file,
            options.max_pixels,
            options.default_dpi,
            options.max_tiff_frames,
            on_page,
        ),
        InputSource::Bytes { file_name, data } => visit_image_pages_from_bytes(
            file_name,
            data,
            options.max_pixels,
            options.default_dpi,
            options.max_tiff_frames,
            on_page,
        ),
    }
}

fn read_exact_image(
    image: ImageSpec<InputSource<'_>>,
    options: &PdfBuildOptions,
    page_size: Option<PdfPageSize>,
) -> Result<ImagePage> {
    if image.compression != ImageCompression::Auto || image.processing != ImageProcessing::None {
        return read_processed_image(image, options, page_size);
    }

    let source_label = image.source.label();
    let mut first = None;
    let page_count = visit_automatic_pages(image.source, options, |page| {
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

fn read_processed_image(
    image: ImageSpec<InputSource<'_>>,
    options: &PdfBuildOptions,
    page_size: Option<PdfPageSize>,
) -> Result<ImagePage> {
    let compression = PdfImageCompression::from(image.compression);
    match image.source {
        InputSource::File { label, file } => read_image_page_from_file(
            &label,
            file,
            options,
            compression,
            image.processing,
            page_size,
            image.size_guardrail,
        ),
        InputSource::Bytes { file_name, data } => read_image_page_from_bytes(
            file_name,
            data,
            options,
            compression,
            image.processing,
            page_size,
            image.size_guardrail,
        ),
    }
}

fn read_mask(source: InputSource<'_>, max_pixels: u64) -> Result<BilevelStream> {
    BilevelStream::encode(&read_mask_bitmap(source, max_pixels)?)
}

fn read_affine_foreground_mask(
    source: InputSource<'_>,
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
        return read_mask(source, max_pixels);
    }

    assert_pixel_limit(expected_width, expected_height, max_pixels)?;
    let bytes = source.read_all()?.into_owned();
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

fn read_mask_bitmap(source: InputSource<'_>, max_pixels: u64) -> Result<crate::netpbm::PbmP4Image> {
    let label = source.label();
    if label
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("png"))
    {
        let bytes = source.read_all()?;
        let gray = decode_png_gray(
            bytes.as_ref(),
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
        return Ok(crate::netpbm::PbmP4Image {
            width,
            height,
            row_stride,
            bitmap,
        });
    }
    match source {
        InputSource::File { file, .. } => Ok(read_pbm_p4_file(file, max_pixels)?),
        InputSource::Bytes { data, .. } => Ok(parse_pbm_p4(data, max_pixels)?),
    }
}

fn read_soft_mask(source: InputSource<'_>, max_pixels: u64) -> Result<SoftMaskStream> {
    let alpha = match source {
        InputSource::File { file, .. } => read_netpbm_file(file, max_pixels)?,
        InputSource::Bytes { data, .. } => {
            let parsed = parse_netpbm(data, max_pixels)?;
            OwnedNetpbm {
                magic: if parsed.channels == 1 { *b"P5" } else { *b"P6" },
                width: parsed.width,
                height: parsed.height,
                channels: parsed.channels,
                pixels: parsed.pixels.to_vec(),
            }
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

impl<'a> InputSource<'a> {
    fn label(&self) -> String {
        match self {
            Self::File { label, .. } => label.display().to_string(),
            Self::Bytes { file_name, .. } => (*file_name).to_string(),
        }
    }

    fn is_pbm(&self) -> bool {
        let label = match self {
            Self::File { label, .. } => label.to_string_lossy(),
            Self::Bytes { file_name, .. } => Cow::Borrowed(*file_name),
        };
        label
            .rsplit_once('.')
            .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("pbm"))
    }

    fn read_all(self) -> Result<Cow<'a, [u8]>> {
        match self {
            Self::File { mut file, .. } => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)?;
                Ok(Cow::Owned(bytes))
            }
            Self::Bytes { data, .. } => Ok(Cow::Borrowed(data)),
        }
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

fn bilevel_image_page(mut image: crate::netpbm::PbmP4Image) -> Result<ImagePage> {
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
        dpi: DEFAULT_DPI,
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
    let validated_inputs = ValidatedInputFiles::open(&[input_path.to_path_buf()], output_path)?;
    let netpbm = read_netpbm_file(validated_inputs.clone_file(0)?, max_pixels)?;
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

pub fn combine_tiff_paths(
    input_paths: &[PathBuf],
    output_path: &Path,
    max_pixels: u64,
    max_pages: usize,
) -> Result<()> {
    combine_tiff_pages(input_paths, output_path, max_pixels, max_pages)
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
    fn catalog_block_writes_outlines_and_page_labels() {
        let options = PdfBuildOptions {
            outlines: vec![BookmarkEntry {
                title: "Cover".to_string(),
                page_index: Some(0),
                page_y_ratio: None,
                named_dest: None,
                bold: false,
                italic: false,
                color: None,
                items: Vec::new(),
            }],
            page_labels: vec![PageLabelRange {
                start_page: 1,
                style: Some("D".to_string()),
                prefix: "Page ".to_string(),
                start_number: 1,
            }],
            ..PdfBuildOptions::default()
        };

        let pdf = write_pdf(
            Vec::new(),
            [image_page(
                "cover.ppm",
                b"P6\n1 1\n255\n\x10\x20\x30",
                Some(PdfPageSize {
                    width_points: 72.0,
                    height_points: 36.0,
                }),
                FramePolicy::ExactlyOne,
            )],
            &options,
            |_| {},
        )
        .unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Outlines 3 0 R /PageMode /UseOutlines"));
        assert!(text.contains("/PageLabels 4 0 R"));
        assert!(text.contains("/Type /Outlines /Count 1"));
        assert!(text.contains("/PageLabel /S /D /P <FEFF00500061006700650020>"));
    }

    #[test]
    fn catalog_block_is_absent_when_empty() {
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
        let text = String::from_utf8_lossy(&pdf);

        assert!(pdf.starts_with(
            b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>"
        ));
        assert!(!text.contains("/Outlines"));
        assert!(!text.contains("/PageLabels"));
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
    fn shared_symbol_encoding_is_explicitly_opt_in() {
        let mask = include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-007-notes.pbm");
        let pages = || {
            [
                image_page("first.pbm", mask, Some(PAGE), FramePolicy::ExactlyOne),
                image_page("second.pbm", mask, Some(PAGE), FramePolicy::ExactlyOne),
            ]
        };

        let default_pdf =
            write_pdf(Vec::new(), pages(), &PdfBuildOptions::default(), |_| {}).unwrap();
        assert!(!String::from_utf8_lossy(&default_pdf).contains("/JBIG2Globals"));

        let symbol_pdf = write_pdf(
            Vec::new(),
            pages(),
            &PdfBuildOptions {
                enable_shared_symbol_encoding: true,
                ..PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&symbol_pdf)
                .matches("/JBIG2Globals")
                .count(),
            2
        );
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
            (0..JBIG2_SYMBOL_CHUNK_PAGES)
                .map(|_| image_page("page.pgm", b"P5\n1 1\n255\n\x00", None, FramePolicy::All)),
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
