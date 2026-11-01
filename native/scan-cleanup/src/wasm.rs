//! Browser entry for the scan-cleanup engine on `wasm32-unknown-unknown`.
//!
//! A request frame carries a versioned JSON request and the page's rasters and
//! earlier results as role-tagged attachments; the result frame carries the
//! page's metadata JSON, the operation's details JSON, and each output's
//! metadata and planes. Every operation is one page of a manifest, or one step
//! of the document-level work a manifest does between its pages, run by the
//! same cores the CLI runs: `render_page` and `finish_page` for a render,
//! `classify_page` and document reconciliation for an analysis, and the
//! document ink prior for producer MRC pages. The CLI then publishes files;
//! this entry returns the same bytes in the result frame instead, so a page
//! with the same rasters and options comes out byte-identical on either
//! platform. Manifests, staging and file publication stay in the native CLI.
//!
//! The module is single-threaded: Rayon runs on the calling thread, and a
//! request cannot be cancelled once it has entered the engine. The host stops
//! work by terminating the worker that owns the instance.

use crate::cache::{PageCache, SourceFingerprint};
use crate::engine::batch_reconciliation::{
    reconcile_classification_batch, PageReconciliation, ReconciliationCandidate,
    MANIFEST_RECONCILIATION_POLICY,
};
use crate::engine::lossless_placement::{
    plan_lossless_page, record_source_preservation_json, PdfPageGeometry,
};
use crate::engine::output_geometry::{
    place_metadata_on_document_canvas, plan_document_canvas_placements,
};
use crate::engine::page_statistics::{
    derive_page_ink_contexts, ink_sample_eligible, ink_sample_of,
};
use crate::engine::page_workflow::{
    classify_page, finish_page, render_page, DetailSourceRasters, FinishedPage, OutputPlane,
    OutputPlanes, PageRaster, PageRasterSource, PageRenderRequest, PageResultMetadata, PlaneFile,
    PlanePixels, PlaneRole, PlaneSink, MAX_DETAIL_METADATA_BYTES,
};
use crate::engine::render::CleanupMetadata;
use crate::engine::resource_planning::{manifest_cache, PlanningOperation};
use crate::ink_consistency::{DocumentInkSample, PageInkConsistencyContext};
use crate::io::{pbm, raster};
use crate::protocol::manifest_v3::{
    validate_document_canvas, validate_matched_canvas_plan, validate_page_options, AnalysisPurpose,
    CanvasScope, DetailRenderGeometry, DocumentCanvas, Operation, PageAdmission, RenderMode,
    MAX_MANIFEST_BYTES, MAX_MANIFEST_PAGES_PER_BATCH,
};
use crate::split::DocumentPrior;
use crate::CleanupOptions;
use evb_native_support::{
    bounded_io::deserialize_json_slice,
    wasm_request_allocation::{
        WasmRequestAllocation, WASM_MAX_BUFFER_BYTES, WASM_REQUEST_ALLOCATION_ABI_VERSION,
    },
    NativeError, NativeErrorCode, NativeErrorEnvelope,
};
use scan_primitives::GrayImage;
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, error::Error, slice, sync::atomic::AtomicBool};

pub(crate) const REQUEST_MAGIC: &[u8; 4] = b"ESCW";
pub(crate) const REQUEST_VERSION: u32 = 2;
/// Renders one page as a one-page render manifest does, preview or final.
pub(crate) const OP_RENDER_PAGE: u32 = 1;
/// Analyzes one page as an analyze manifest's first pass does, and returns
/// what document reconciliation reads from it.
pub(crate) const OP_ANALYZE_PAGE: u32 = 2;
/// Reconciles one manifest batch of analyzed pages into a decision per page.
pub(crate) const OP_RECONCILE_DOCUMENT: u32 = 3;
/// Applies a page's reconciliation and PDF placement to its analysis: the
/// page metadata an analyze manifest finally writes.
pub(crate) const OP_FINISH_PAGE_ANALYSIS: u32 = 4;
/// Measures one producer MRC page's ink for the document ink prior.
pub(crate) const OP_SAMPLE_PAGE_INK: u32 = 5;
/// Derives each page's ink consistency context from one batch's samples.
pub(crate) const OP_DERIVE_INK_CONTEXTS: u32 = 6;
/// Planes come back as pixels.
pub(crate) const PLANES_RAW: u32 = 0;
/// Planes come back as the file bytes the CLI writes to their destination.
pub(crate) const PLANES_ENCODED: u32 = 1;
pub(crate) const ATTACHMENT_INPUT: u32 = 1;
pub(crate) const ATTACHMENT_ANALYSIS: u32 = 2;
pub(crate) const ATTACHMENT_TRUSTED_FOREGROUND_SELECTION: u32 = 3;
pub(crate) const ATTACHMENT_TRUSTED_MRC_BACKGROUND: u32 = 4;
pub(crate) const ATTACHMENT_DETAIL_BASE_METADATA: u32 = 5;
pub(crate) const ATTACHMENT_DETAIL_BASE_SOURCE: u32 = 6;
pub(crate) const ATTACHMENT_DETAIL_BASE_CLEANED: u32 = 7;
pub(crate) const ATTACHMENT_PAGE_METADATA: u32 = 8;
const ATTACHMENT_ROLES: usize = 8;
pub(crate) const PLANE_ROLE_COMPOSITE: u32 = 1;
pub(crate) const PLANE_ROLE_BILEVEL: u32 = 2;
pub(crate) const PLANE_ROLE_BACKGROUND: u32 = 3;
pub(crate) const PLANE_ROLE_FOREGROUND_MASK: u32 = 4;
pub(crate) const PLANE_ROLE_FOREGROUND_ALPHA: u32 = 5;
pub(crate) const PLANE_ROLE_PICTURE_MASK: u32 = 6;
pub(crate) const PLANE_ROLE_TONE_PRESERVATION_ALPHA: u32 = 7;
pub(crate) const PLANE_KIND_GRAY8: u32 = 1;
pub(crate) const PLANE_KIND_RGB8: u32 = 2;
/// Packed rows, most significant bit first, one is black: a PBM P4 payload.
pub(crate) const PLANE_KIND_BILEVEL1: u32 = 3;
pub(crate) const PLANE_ENCODING_RAW: u32 = 0;
pub(crate) const PLANE_ENCODING_PNG: u32 = 1;
pub(crate) const PLANE_ENCODING_PBM: u32 = 2;
pub(crate) const PLANE_ENCODING_PPM: u32 = 3;
pub(crate) const PLANE_ENCODING_PGM: u32 = 4;
pub(crate) const U32_BYTES: usize = std::mem::size_of::<u32>();
/// magic, version, operation, plane encoding, request JSON length and
/// attachment count; then each attachment's role and length, the JSON, and the
/// attachments' bytes in table order.
pub(crate) const REQUEST_HEADER_BYTES: usize = REQUEST_MAGIC.len() + 5 * U32_BYTES;
pub(crate) const ATTACHMENT_HEADER_BYTES: usize = 2 * U32_BYTES;
/// Result: page metadata JSON length, details JSON length and output count,
/// then the two JSONs, then each output.
pub(crate) const RESULT_HEADER_BYTES: usize = 3 * U32_BYTES;
/// Output: metadata JSON length and plane count, then the JSON and its planes.
pub(crate) const OUTPUT_HEADER_BYTES: usize = 2 * U32_BYTES;
/// Plane: role, kind, encoding, width, height, byte length; then the bytes.
pub(crate) const PLANE_HEADER_BYTES: usize = 6 * U32_BYTES;
/// A request's JSON is one manifest's worth of pages at most, as the CLI reads.
pub(crate) const MAX_REQUEST_JSON_BYTES: usize = MAX_MANIFEST_BYTES;
pub(crate) const MAX_REQUEST_BYTES: usize = WASM_MAX_BUFFER_BYTES;
pub(crate) const MAX_OUTPUT_BYTES: usize = WASM_MAX_BUFFER_BYTES;

thread_local! {
    static REQUEST_ALLOCATION: WasmRequestAllocation = const { WasmRequestAllocation::new(MAX_REQUEST_BYTES) };
    static LAST_OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

static NEVER_CANCELED: AtomicBool = AtomicBool::new(false);

/// A render request: one page of a render manifest. Its input raster is the
/// `input` attachment; the separate analysis plane, the producer MRC layers
/// and a detail render's base are their own attachments.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WasmRenderPageRequestV2 {
    pub(crate) options: CleanupOptions,
    pub(crate) source_page_index: usize,
    pub(crate) canvas_scope: CanvasScope,
    pub(crate) render_mode: RenderMode,
    /// The resolution of the fixed analysis plane: the `analysis` attachment,
    /// or the input itself when `analysisIsInput` is set.
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) analysis_dpi: Option<f64>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) analysis_is_input: bool,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) document_prior: Option<DocumentPrior>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) document_canvas: Option<DocumentCanvas>,
    /// The trusted foreground selection is a PDF JBIG2 generic region, which
    /// the CLI recognizes by its `.jb2e` file type, rather than a raster.
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) trusted_foreground_jbig2: bool,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) detail_render_plan: Option<DetailRenderGeometry>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) pdf_page: Option<PdfPageGeometry>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) page_ink_consistency: Option<PageInkConsistencyContext>,
    /// Each output destination's planes, as a manifest page's `outputs` list
    /// them. Absent, every output takes its composite only, as the direct
    /// CLI's destinations do.
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) outputs: Option<Vec<OutputPlanes>>,
}

/// An analyze request: one page of an analyze manifest's first pass, or its
/// rerun under the document prior reconciliation chose.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WasmAnalyzePageRequestV2 {
    pub(crate) options: CleanupOptions,
    pub(crate) source_page_index: usize,
    pub(crate) canvas_scope: CanvasScope,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) analysis_purpose: AnalysisPurpose,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) document_prior: Option<DocumentPrior>,
}

/// What an analysis returns beside its page metadata.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct WasmAnalyzePageDetailsV2 {
    pub(crate) reconciliation: ReconciliationCandidate,
}

/// One manifest batch's analyzed pages, in page order.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WasmReconcileDocumentRequestV2 {
    pub(crate) candidates: Vec<ReconciliationCandidate>,
}

/// Each page's reconciliation, or `null` where its analysis stands.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct WasmReconcileDocumentResultV2 {
    pub(crate) pages: Vec<Option<PageReconciliation>>,
}

/// Where a lossless analysis places its outputs on the PDF page.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WasmPdfPlacementV2 {
    pub(crate) pdf_page: PdfPageGeometry,
    /// The page's options as its analysis request carried them.
    pub(crate) options: CleanupOptions,
    pub(crate) render_mode: RenderMode,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) document_canvas: Option<DocumentCanvas>,
}

/// Finishes an analysis carried as the `pageMetadata` attachment: the page's
/// own, or its rerun's when its reconciliation is a rerun.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WasmFinishPageAnalysisRequestV2 {
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) reconciliation: Option<PageReconciliation>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) pdf_placement: Option<WasmPdfPlacementV2>,
}

/// Samples one page's producer MRC layers, carried as the trusted foreground
/// selection and background attachments.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WasmSamplePageInkRequestV2 {
    pub(crate) options: CleanupOptions,
    pub(crate) source_page_index: usize,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) trusted_foreground_jbig2: bool,
}

/// The page's sample, or `null` when the page cannot join the ink prior.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct WasmSamplePageInkResultV2 {
    pub(crate) sample: Option<DocumentInkSample>,
}

/// One render manifest batch's samples, in page order.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WasmDeriveInkContextsRequestV2 {
    pub(crate) samples: Vec<Option<DocumentInkSample>>,
}

/// Each page's context for its render request's `pageInkConsistency`.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct WasmDeriveInkContextsResultV2 {
    pub(crate) contexts: Vec<Option<PageInkConsistencyContext>>,
}

struct RequestFrame<'a> {
    operation: u32,
    plane_encoding: u32,
    request_json: &'a [u8],
    attachments: [Option<&'a [u8]>; ATTACHMENT_ROLES],
}

impl<'a> RequestFrame<'a> {
    fn attachment(&self, role: u32) -> Option<&'a [u8]> {
        self.attachments[role as usize - 1]
    }

    /// Admits only the attachments and plane encoding an operation reads.
    fn admit(&self, roles: &[u32], plane_encodings: &[u32]) -> Result<(), NativeError> {
        if !plane_encodings.contains(&self.plane_encoding) {
            return Err(invalid(format!(
                "Unsupported scan-cleanup WASM plane encoding: {}",
                self.plane_encoding
            )));
        }
        for (index, attachment) in self.attachments.iter().enumerate() {
            let role = index as u32 + 1;
            if attachment.is_some() && !roles.contains(&role) {
                return Err(invalid(format!(
                    "Scan-cleanup WASM operation {} takes no attachment of role {role}",
                    self.operation
                )));
            }
        }
        Ok(())
    }

    fn required(&self, role: u32, label: &str) -> Result<&'a [u8], NativeError> {
        self.attachment(role)
            .ok_or_else(|| invalid(format!("Scan-cleanup WASM request has no {label}")))
    }
}

enum AnalysisRaster<'a> {
    None,
    Input,
    Separate(&'a [u8]),
}

/// One page's rasters as request attachments.
struct RequestRasters<'a> {
    input: &'a [u8],
    analysis: AnalysisRaster<'a>,
    trusted_foreground_selection: Option<&'a [u8]>,
    trusted_foreground_jbig2: bool,
    trusted_mrc_background: Option<&'a [u8]>,
    detail_base_metadata: Option<&'a [u8]>,
    detail_base_source: Option<&'a [u8]>,
    detail_base_cleaned: Option<&'a [u8]>,
    source_page_index: usize,
}

impl RequestRasters<'_> {
    fn bytes(&self, raster: PageRaster) -> Result<&[u8], NativeError> {
        match (raster, &self.analysis) {
            (PageRaster::Input, _) | (PageRaster::CanonicalAnalysis, AnalysisRaster::Input) => {
                Some(self.input)
            }
            (PageRaster::CanonicalAnalysis, AnalysisRaster::Separate(bytes)) => Some(*bytes),
            (PageRaster::TrustedForegroundMask, _) => self.trusted_foreground_selection,
            (PageRaster::TrustedMrcBackground, _) => self.trusted_mrc_background,
            (PageRaster::CanonicalAnalysis, AnalysisRaster::None) => None,
        }
        .ok_or_else(|| {
            invalid(format!(
                "The browser cleanup request has no {raster:?} raster"
            ))
        })
    }

    fn decode<T>(
        &self,
        label: impl std::fmt::Display,
        bytes: &[u8],
        decode: impl FnOnce(&[u8]) -> Result<T, raster::RasterReadError>,
    ) -> Result<T, NativeError> {
        decode(bytes).map_err(|error| {
            NativeError::new(
                match error {
                    raster::RasterReadError::Io(_) => NativeErrorCode::Io,
                    raster::RasterReadError::Invalid(_) => NativeErrorCode::InvalidRequest,
                    raster::RasterReadError::TooLarge(_) => NativeErrorCode::TooLarge,
                },
                format!(
                    "Unable to read scan-cleanup raster for page {} ({label}): {error}",
                    self.source_page_index.saturating_add(1),
                ),
            )
        })
    }
}

impl PageRasterSource for RequestRasters<'_> {
    fn has(&self, raster: PageRaster) -> bool {
        self.bytes(raster).is_ok()
    }

    fn analysis_is_input(&self) -> bool {
        matches!(self.analysis, AnalysisRaster::Input)
    }

    fn read_image(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<raster::DecodedRaster, NativeError> {
        self.decode(format!("{raster:?}"), self.bytes(raster)?, |bytes| {
            raster::decode_image_bytes(bytes, options.max_pixels, options.max_dimension)
        })
    }

    fn read_gray(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<GrayImage, NativeError> {
        self.decode(format!("{raster:?}"), self.bytes(raster)?, |bytes| {
            raster::decode_gray_bytes(bytes, options.max_pixels, options.max_dimension)
        })
    }

    fn read_foreground_selection(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<GrayImage, NativeError> {
        self.decode(format!("{raster:?}"), self.bytes(raster)?, |bytes| {
            raster::decode_foreground_selection_bytes(
                bytes,
                self.trusted_foreground_jbig2,
                options.max_pixels,
                options.max_dimension,
            )
        })
    }

    fn read_detail_sources(
        &self,
        options: &CleanupOptions,
    ) -> Result<DetailSourceRasters, NativeError> {
        let (Some(metadata), Some(source)) = (self.detail_base_metadata, self.detail_base_source)
        else {
            return Err(invalid(
                "A detail render needs its base metadata and base source raster",
            ));
        };
        if metadata.len() > MAX_DETAIL_METADATA_BYTES {
            return Err(NativeError::new(
                NativeErrorCode::TooLarge,
                format!(
                    "Detail base metadata exceeds the {MAX_DETAIL_METADATA_BYTES}-byte admission ceiling"
                ),
            ));
        }
        let base_metadata: CleanupMetadata =
            deserialize_json_slice(metadata, "detail base metadata").map_err(|error| {
                if error.code == NativeErrorCode::TooLarge {
                    error
                } else {
                    invalid(format!("Invalid detail base metadata: {error}"))
                }
            })?;
        let image = |label: &str, bytes: &[u8]| {
            self.decode(label, bytes, |bytes| {
                raster::decode_image_bytes(bytes, options.max_pixels, options.max_dimension)
            })
        };
        Ok(DetailSourceRasters {
            base_metadata,
            base_source: image("detail base source", source)?,
            base_cleaned: self
                .detail_base_cleaned
                .map(|bytes| image("detail base cleaned", bytes))
                .transpose()?,
        })
    }
}

#[no_mangle]
pub extern "C" fn evb_wasm_request_allocation_abi_version() -> u32 {
    WASM_REQUEST_ALLOCATION_ABI_VERSION
}

#[no_mangle]
pub extern "C" fn evb_scan_cleanup_alloc(len: usize) -> *mut u8 {
    REQUEST_ALLOCATION.with(|allocation| allocation.allocate(len))
}

/// # Safety
/// `pointer` and `byte_length` must be the values `evb_scan_cleanup_alloc`
/// returned and was called with; any other pair is ignored.
#[no_mangle]
pub unsafe extern "C" fn evb_scan_cleanup_free(pointer: *mut u8, byte_length: usize) {
    REQUEST_ALLOCATION.with(|allocation| allocation.free(pointer, byte_length));
}

/// Runs one request frame. Returns 0 with the result frame at
/// `evb_scan_cleanup_output_ptr`, or -1 with a native error envelope at
/// `evb_scan_cleanup_error_ptr`.
///
/// # Safety
/// `request_pointer` must be the live allocation of `request_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn evb_scan_cleanup_run(
    request_pointer: *const u8,
    request_len: usize,
) -> i32 {
    clear_last_result();
    if request_pointer.is_null() || request_len == 0 || request_len > MAX_REQUEST_BYTES {
        set_error_envelope(NativeErrorEnvelope {
            code: NativeErrorCode::TooLarge,
            message: "Scan-cleanup WASM request exceeds the admission ceiling".to_string(),
        });
        return -1;
    }
    if !REQUEST_ALLOCATION.with(|allocation| allocation.matches(request_pointer, request_len)) {
        set_error_envelope(NativeErrorEnvelope {
            code: NativeErrorCode::InvalidRequest,
            message: "Scan-cleanup WASM request does not match the live allocation".to_string(),
        });
        return -1;
    }
    let request = slice::from_raw_parts(request_pointer, request_len);
    match std::panic::catch_unwind(|| run_request(request)) {
        Ok(Ok(output)) if output.len() <= MAX_OUTPUT_BYTES => {
            LAST_OUTPUT.with(|slot| *slot.borrow_mut() = output);
            0
        }
        Ok(Ok(_)) => {
            set_error_envelope(NativeErrorEnvelope {
                code: NativeErrorCode::TooLarge,
                message: "Scan-cleanup WASM output exceeds the admission ceiling".to_string(),
            });
            -1
        }
        Ok(Err(error)) => {
            set_error_envelope(NativeErrorEnvelope::from_error(error.as_ref()));
            -1
        }
        Err(_) => {
            set_error_envelope(NativeErrorEnvelope {
                code: NativeErrorCode::Panic,
                message: "Native scan cleanup panicked".to_string(),
            });
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn evb_scan_cleanup_output_ptr() -> *const u8 {
    LAST_OUTPUT.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_scan_cleanup_output_len() -> usize {
    LAST_OUTPUT.with(|slot| slot.borrow().len())
}

#[no_mangle]
pub extern "C" fn evb_scan_cleanup_error_ptr() -> *const u8 {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_scan_cleanup_error_len() -> usize {
    LAST_ERROR.with(|slot| slot.borrow().len())
}

fn set_error_envelope(envelope: NativeErrorEnvelope) {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = envelope.to_json().into_bytes());
}

fn clear_last_result() {
    // Release the previous result's capacity: a page's planes can be large.
    LAST_OUTPUT.with(|slot| *slot.borrow_mut() = Vec::new());
    LAST_ERROR.with(|slot| slot.borrow_mut().clear());
}

fn invalid(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::InvalidRequest, message)
}

pub(crate) fn run_request(request: &[u8]) -> Result<Vec<u8>, Box<dyn Error>> {
    let frame = parse_request_frame(request)?;
    match frame.operation {
        OP_RENDER_PAGE => run_render_page(&frame),
        OP_ANALYZE_PAGE => run_analyze_page(&frame),
        OP_RECONCILE_DOCUMENT => run_reconcile_document(&frame),
        OP_FINISH_PAGE_ANALYSIS => run_finish_page_analysis(&frame),
        OP_SAMPLE_PAGE_INK => run_sample_page_ink(&frame),
        OP_DERIVE_INK_CONTEXTS => run_derive_ink_contexts(&frame),
        operation => Err(invalid(format!(
            "Unsupported scan-cleanup WASM operation: {operation}"
        ))
        .into()),
    }
}

fn parse_request_frame(request: &[u8]) -> Result<RequestFrame<'_>, NativeError> {
    if request.len() < REQUEST_HEADER_BYTES {
        return Err(invalid("Truncated scan-cleanup WASM request"));
    }
    let mut offset = 0usize;
    if take(request, &mut offset, REQUEST_MAGIC.len())? != REQUEST_MAGIC {
        return Err(invalid("Invalid scan-cleanup WASM request magic"));
    }
    let version = read_u32(request, &mut offset)?;
    if version != REQUEST_VERSION {
        return Err(invalid(format!(
            "Unsupported scan-cleanup WASM request version: {version}"
        )));
    }
    let operation = read_u32(request, &mut offset)?;
    let plane_encoding = read_u32(request, &mut offset)?;
    let request_json_len = read_len(request, &mut offset)?;
    let attachment_count = read_len(request, &mut offset)?;
    if request_json_len > MAX_REQUEST_JSON_BYTES {
        return Err(NativeError::new(
            NativeErrorCode::TooLarge,
            format!(
                "Scan-cleanup WASM request JSON exceeds the {MAX_REQUEST_JSON_BYTES}-byte admission ceiling"
            ),
        ));
    }
    if attachment_count > ATTACHMENT_ROLES {
        return Err(invalid(
            "Scan-cleanup WASM request has too many attachments",
        ));
    }
    if request.len() < REQUEST_HEADER_BYTES + attachment_count * ATTACHMENT_HEADER_BYTES {
        return Err(invalid("Truncated scan-cleanup WASM request"));
    }
    let mut table = Vec::with_capacity(attachment_count);
    for _ in 0..attachment_count {
        let role = read_u32(request, &mut offset)?;
        let len = read_len(request, &mut offset)?;
        if role == 0 || role as usize > ATTACHMENT_ROLES {
            return Err(invalid(format!(
                "Unknown scan-cleanup WASM attachment role: {role}"
            )));
        }
        if len == 0 {
            return Err(invalid(format!(
                "Scan-cleanup WASM attachment of role {role} is empty"
            )));
        }
        table.push((role, len));
    }
    let request_json = take(request, &mut offset, request_json_len)?;
    let mut attachments = [None; ATTACHMENT_ROLES];
    for (role, len) in table {
        let slot = &mut attachments[role as usize - 1];
        if slot.is_some() {
            return Err(invalid(format!(
                "Scan-cleanup WASM request repeats attachment role {role}"
            )));
        }
        *slot = Some(take(request, &mut offset, len)?);
    }
    if offset != request.len() {
        return Err(invalid("Trailing bytes in scan-cleanup WASM request"));
    }
    Ok(RequestFrame {
        operation,
        plane_encoding,
        request_json,
        attachments,
    })
}

fn page_cache(source_page_index: usize) -> PageCache {
    // One request is one page, so its cache only ever holds that page's
    // stages; the render budget bounds it as it bounds a render manifest's.
    PageCache::new(
        manifest_cache(PlanningOperation::Render, None),
        SourceFingerprint::in_memory(source_page_index),
    )
}

/// Collects published planes into the result frame, as pixels or as the bytes
/// the CLI writes to each plane's destination.
struct FramePlaneSink {
    encoded: bool,
    planes: Vec<FramePlane>,
}

struct FramePlane {
    role: u32,
    kind: u32,
    encoding: u32,
    width: usize,
    height: usize,
    data: Vec<u8>,
}

fn plane_role_code(role: PlaneRole) -> u32 {
    match role {
        PlaneRole::Composite => PLANE_ROLE_COMPOSITE,
        PlaneRole::Bilevel => PLANE_ROLE_BILEVEL,
        PlaneRole::Background => PLANE_ROLE_BACKGROUND,
        PlaneRole::ForegroundMask => PLANE_ROLE_FOREGROUND_MASK,
        PlaneRole::ForegroundAlpha => PLANE_ROLE_FOREGROUND_ALPHA,
        PlaneRole::PictureMask => PLANE_ROLE_PICTURE_MASK,
        PlaneRole::TonePreservationAlpha => PLANE_ROLE_TONE_PRESERVATION_ALPHA,
    }
}

impl PlaneSink for FramePlaneSink {
    fn publish(&mut self, plane: &OutputPlane<'_>) -> Result<(), String> {
        let (kind, width, height) = match &plane.pixels {
            PlanePixels::Gray(image) => (PLANE_KIND_GRAY8, image.width(), image.height()),
            PlanePixels::Rgb(image) => (PLANE_KIND_RGB8, image.width(), image.height()),
            PlanePixels::Bilevel(image) => (PLANE_KIND_BILEVEL1, image.width(), image.height()),
        };
        let (encoding, data) = if self.encoded {
            let encoding = match plane.file {
                PlaneFile::Png => PLANE_ENCODING_PNG,
                PlaneFile::Pbm => PLANE_ENCODING_PBM,
                PlaneFile::Ppm => PLANE_ENCODING_PPM,
                PlaneFile::Pgm => PLANE_ENCODING_PGM,
            };
            (encoding, plane.encode()?)
        } else {
            let data = match &plane.pixels {
                PlanePixels::Gray(image) => {
                    let mut data = Vec::with_capacity(image.width() * image.height());
                    for y in 0..image.height() {
                        data.extend_from_slice(image.row(y));
                    }
                    data
                }
                PlanePixels::Rgb(image) => image.data().to_vec(),
                PlanePixels::Bilevel(image) => {
                    // The P4 payload after its header is exactly the packed rows.
                    let encoded = pbm::encode_p4_bilevel(image)?;
                    let rows = image.width().div_ceil(8) * image.height();
                    encoded[encoded.len() - rows..].to_vec()
                }
            };
            (PLANE_ENCODING_RAW, data)
        };
        self.planes.push(FramePlane {
            role: plane_role_code(plane.role),
            kind,
            encoding,
            width,
            height,
            data,
        });
        Ok(())
    }

    fn discard(&mut self, role: PlaneRole) {
        let role = plane_role_code(role);
        self.planes.retain(|plane| plane.role != role);
    }
}

struct FrameOutput {
    metadata_json: Vec<u8>,
    planes: Vec<FramePlane>,
}

fn run_render_page(frame: &RequestFrame<'_>) -> Result<Vec<u8>, Box<dyn Error>> {
    frame.admit(
        &[
            ATTACHMENT_INPUT,
            ATTACHMENT_ANALYSIS,
            ATTACHMENT_TRUSTED_FOREGROUND_SELECTION,
            ATTACHMENT_TRUSTED_MRC_BACKGROUND,
            ATTACHMENT_DETAIL_BASE_METADATA,
            ATTACHMENT_DETAIL_BASE_SOURCE,
            ATTACHMENT_DETAIL_BASE_CLEANED,
        ],
        &[PLANES_RAW, PLANES_ENCODED],
    )?;
    let request: WasmRenderPageRequestV2 =
        deserialize_json_slice(frame.request_json, "scan-cleanup WASM render request")?;
    let input = frame.required(ATTACHMENT_INPUT, "input raster")?;
    let analysis = match (
        frame.attachment(ATTACHMENT_ANALYSIS),
        request.analysis_is_input,
    ) {
        (None, false) => AnalysisRaster::None,
        (None, true) => AnalysisRaster::Input,
        (Some(bytes), false) => AnalysisRaster::Separate(bytes),
        (Some(_), true) => {
            return Err(invalid(
                "A render request names the input as its analysis plane and also carries one",
            )
            .into())
        }
    };
    PageAdmission {
        operation: Operation::Render,
        render_mode: request.render_mode,
        source_page_index: request.source_page_index,
        options: &request.options,
        has_analysis_input: !matches!(analysis, AnalysisRaster::None),
        analysis_dpi: request.analysis_dpi,
        detail: request.detail_render_plan.as_ref(),
        document_prior: request.document_prior,
        output_destinations: request.outputs.as_ref().map_or(1, Vec::len),
    }
    .validate()?;
    validate_document_canvas(request.document_canvas)?;
    validate_matched_canvas_plan(
        Operation::Render,
        request.document_canvas,
        std::iter::once(&request.options),
    )?;
    if let Some(context) = request.page_ink_consistency {
        context.validate().map_err(invalid)?;
    }
    let detail_attachments = [
        frame.attachment(ATTACHMENT_DETAIL_BASE_METADATA),
        frame.attachment(ATTACHMENT_DETAIL_BASE_SOURCE),
        frame.attachment(ATTACHMENT_DETAIL_BASE_CLEANED),
    ];
    if request.detail_render_plan.is_none() && detail_attachments.iter().any(Option::is_some) {
        return Err(invalid("Detail base attachments require a detailRenderPlan").into());
    }
    let rasters = RequestRasters {
        input,
        analysis,
        trusted_foreground_selection: frame.attachment(ATTACHMENT_TRUSTED_FOREGROUND_SELECTION),
        trusted_foreground_jbig2: request.trusted_foreground_jbig2,
        trusted_mrc_background: frame.attachment(ATTACHMENT_TRUSTED_MRC_BACKGROUND),
        detail_base_metadata: detail_attachments[0],
        detail_base_source: detail_attachments[1],
        detail_base_cleaned: detail_attachments[2],
        source_page_index: request.source_page_index,
    };
    let final_render = request.render_mode == RenderMode::Final;
    let declared = request.outputs.as_deref().unwrap_or_default();
    let rendered = render_page(
        &rasters,
        PageRenderRequest {
            options: &request.options,
            source_page_index: request.source_page_index,
            analysis_dpi: request.analysis_dpi,
            document_prior: request.document_prior,
            detail_render_plan: request.detail_render_plan.as_ref(),
            canvas_scope: request.canvas_scope,
            final_render,
            layer_destinations: OutputPlanes::take_layers(declared),
            page_ink_consistency: request.page_ink_consistency,
        },
        &page_cache(request.source_page_index),
        &NEVER_CANCELED,
    )?;
    let output_count = rendered.outputs.len();
    let planes = match &request.outputs {
        Some(declared) if declared.len() < output_count => {
            return Err(invalid(format!(
            "Cleanup produced {output_count} pages but only {} output destinations were supplied",
            declared.len()
        ))
            .into())
        }
        Some(declared) => declared[..output_count].to_vec(),
        None => vec![OutputPlanes::default(); output_count],
    };
    let FinishedPage {
        mut outputs,
        mut metadata,
        options,
        ..
    } = finish_page(rendered, final_render, request.document_canvas, planes)?;
    let mut frame_outputs = Vec::with_capacity(outputs.len());
    let mut geometries = Vec::with_capacity(outputs.len());
    for output in &mut outputs {
        let mut sink = FramePlaneSink {
            encoded: frame.plane_encoding == PLANES_ENCODED,
            planes: Vec::new(),
        };
        output.publish(&mut sink)?;
        frame_outputs.push(FrameOutput {
            // The same compact serialization the CLI writes to its files.
            metadata_json: serde_json::to_vec(&output.result.metadata)?,
            planes: sink.planes,
        });
        geometries.push(output.geometry(
            &options,
            request.source_page_index,
            request.document_canvas,
        ));
    }
    // What a render manifest does once its pages are published, for this page.
    if let Some(pdf_page) = &request.pdf_page {
        plan_lossless_page(
            &mut metadata.outputs,
            pdf_page,
            metadata.rotation_degrees,
            &request.options,
            request.document_canvas,
            request.render_mode == RenderMode::Preview,
        );
    }
    let matched = outputs
        .iter()
        .zip(&geometries)
        .map(|(output, geometry)| (geometry, output.matched_in_memory()))
        .collect::<Vec<_>>();
    for (index, placement, canvas) in
        plan_document_canvas_placements(&matched, request.document_canvas)?
    {
        frame_outputs[index].metadata_json = place_metadata_on_document_canvas(
            &frame_outputs[index].metadata_json,
            &geometries[index],
            placement,
            &canvas,
        )?;
    }
    if let Some(pdf_page) = &request.pdf_page {
        for output in &mut frame_outputs {
            if let Some(metadata) =
                record_source_preservation_json(&output.metadata_json, pdf_page, &request.options)?
            {
                output.metadata_json = metadata;
            }
        }
    }
    encode_result(&serde_json::to_vec(&metadata)?, &[], &frame_outputs)
}

fn run_analyze_page(frame: &RequestFrame<'_>) -> Result<Vec<u8>, Box<dyn Error>> {
    frame.admit(&[ATTACHMENT_INPUT], &[PLANES_RAW])?;
    let request: WasmAnalyzePageRequestV2 =
        deserialize_json_slice(frame.request_json, "scan-cleanup WASM analyze request")?;
    PageAdmission {
        operation: Operation::Analyze,
        render_mode: RenderMode::Preview,
        source_page_index: request.source_page_index,
        options: &request.options,
        has_analysis_input: false,
        analysis_dpi: None,
        detail: None,
        document_prior: request.document_prior,
        output_destinations: 0,
    }
    .validate()?;
    let rasters = RequestRasters {
        input: frame.required(ATTACHMENT_INPUT, "input raster")?,
        analysis: AnalysisRaster::None,
        trusted_foreground_selection: None,
        trusted_foreground_jbig2: false,
        trusted_mrc_background: None,
        detail_base_metadata: None,
        detail_base_source: None,
        detail_base_cleaned: None,
        source_page_index: request.source_page_index,
    };
    // The arguments an analyze manifest passes for each page, on its first
    // pass and on a rerun under the prior reconciliation chose.
    let (metadata, _) = classify_page(
        &rasters,
        &request.options,
        request.source_page_index,
        request.canvas_scope,
        request.document_prior,
        true,
        request.analysis_purpose == AnalysisPurpose::PagePlan,
        &page_cache(request.source_page_index),
        &NEVER_CANCELED,
    )?;
    let details = WasmAnalyzePageDetailsV2 {
        reconciliation: ReconciliationCandidate::of(&metadata),
    };
    encode_result(
        &serde_json::to_vec(&metadata)?,
        &serde_json::to_vec(&details)?,
        &[],
    )
}

fn run_reconcile_document(frame: &RequestFrame<'_>) -> Result<Vec<u8>, Box<dyn Error>> {
    frame.admit(&[], &[PLANES_RAW])?;
    let request: WasmReconcileDocumentRequestV2 =
        deserialize_json_slice(frame.request_json, "scan-cleanup WASM reconcile request")?;
    if request.candidates.len() > MAX_MANIFEST_PAGES_PER_BATCH {
        return Err(NativeError::new(
            NativeErrorCode::TooLarge,
            format!(
                "Scan-cleanup reconciliation exceeds the {MAX_MANIFEST_PAGES_PER_BATCH}-page batch limit"
            ),
        )
        .into());
    }
    for candidate in &request.candidates {
        let finite = [
            Some(candidate.tier1_confidence),
            Some(candidate.whitespace_score),
            candidate.cutter_x,
            candidate.candidate_cutter_ratio,
            candidate.calibration_stroke_width_px,
            candidate.calibration_x_height_px,
        ]
        .into_iter()
        .flatten()
        .all(f64::is_finite);
        if !finite {
            return Err(invalid("Reconciliation candidate values must be finite").into());
        }
        if let Some(prior) = candidate.document_prior {
            prior.validate().map_err(invalid)?;
        }
    }
    let mut pages = vec![None; request.candidates.len()];
    for action in
        reconcile_classification_batch(&request.candidates, MANIFEST_RECONCILIATION_POLICY)
    {
        pages[action.index] = Some(action.change);
    }
    encode_result(
        &[],
        &serde_json::to_vec(&WasmReconcileDocumentResultV2 { pages })?,
        &[],
    )
}

fn run_finish_page_analysis(frame: &RequestFrame<'_>) -> Result<Vec<u8>, Box<dyn Error>> {
    frame.admit(&[ATTACHMENT_PAGE_METADATA], &[PLANES_RAW])?;
    let request: WasmFinishPageAnalysisRequestV2 = deserialize_json_slice(
        frame.request_json,
        "scan-cleanup WASM finish-analysis request",
    )?;
    let mut metadata: PageResultMetadata = deserialize_json_slice(
        frame.required(ATTACHMENT_PAGE_METADATA, "page metadata")?,
        "scan-cleanup page metadata",
    )?;
    if let Some(reconciliation) = &request.reconciliation {
        let prior = reconciliation.prior();
        prior.validate().map_err(invalid)?;
        // A rerun's analysis was made under the prior; an updated page's
        // first pass had none, which is what made it eligible.
        let analyzed_under = match reconciliation {
            PageReconciliation::Rerun { .. } => Some(prior),
            PageReconciliation::Update { .. } => None,
        };
        if metadata.document_prior != analyzed_under {
            return Err(invalid("The page analysis does not belong to its reconciliation").into());
        }
        reconciliation.apply(&mut metadata);
    }
    if let Some(placement) = &request.pdf_placement {
        validate_page_options(&placement.options, metadata.source_page_index, false)?;
        validate_document_canvas(placement.document_canvas)?;
        plan_lossless_page(
            &mut metadata.outputs,
            &placement.pdf_page,
            metadata.rotation_degrees,
            &placement.options,
            placement.document_canvas,
            placement.render_mode == RenderMode::Preview,
        );
    }
    encode_result(&serde_json::to_vec(&metadata)?, &[], &[])
}

fn run_sample_page_ink(frame: &RequestFrame<'_>) -> Result<Vec<u8>, Box<dyn Error>> {
    frame.admit(
        &[
            ATTACHMENT_TRUSTED_FOREGROUND_SELECTION,
            ATTACHMENT_TRUSTED_MRC_BACKGROUND,
        ],
        &[PLANES_RAW],
    )?;
    let request: WasmSamplePageInkRequestV2 =
        deserialize_json_slice(frame.request_json, "scan-cleanup WASM ink sample request")?;
    validate_page_options(&request.options, request.source_page_index, false)?;
    let options = &request.options;
    let sample = if ink_sample_eligible(
        options.output_mode,
        options.source_has_bilevel_layer,
        options.thickness,
    ) {
        let rasters = RequestRasters {
            input: &[],
            analysis: AnalysisRaster::None,
            trusted_foreground_selection: Some(frame.required(
                ATTACHMENT_TRUSTED_FOREGROUND_SELECTION,
                "trusted foreground selection",
            )?),
            trusted_foreground_jbig2: request.trusted_foreground_jbig2,
            trusted_mrc_background: Some(
                frame.required(ATTACHMENT_TRUSTED_MRC_BACKGROUND, "trusted MRC background")?,
            ),
            detail_base_metadata: None,
            detail_base_source: None,
            detail_base_cleaned: None,
            source_page_index: request.source_page_index,
        };
        let selection =
            rasters.read_foreground_selection(PageRaster::TrustedForegroundMask, options)?;
        let (background_width, _) = rasters.decode(
            "TrustedMrcBackground",
            rasters.bytes(PageRaster::TrustedMrcBackground)?,
            |bytes| {
                raster::decode_dimensions_bytes(bytes, options.max_pixels, options.max_dimension)
            },
        )?;
        ink_sample_of(&selection, background_width)
    } else {
        None
    };
    encode_result(
        &[],
        &serde_json::to_vec(&WasmSamplePageInkResultV2 { sample })?,
        &[],
    )
}

fn run_derive_ink_contexts(frame: &RequestFrame<'_>) -> Result<Vec<u8>, Box<dyn Error>> {
    frame.admit(&[], &[PLANES_RAW])?;
    let request: WasmDeriveInkContextsRequestV2 =
        deserialize_json_slice(frame.request_json, "scan-cleanup WASM ink context request")?;
    if request.samples.len() > MAX_MANIFEST_PAGES_PER_BATCH {
        return Err(NativeError::new(
            NativeErrorCode::TooLarge,
            format!(
                "Scan-cleanup ink contexts exceed the {MAX_MANIFEST_PAGES_PER_BATCH}-page batch limit"
            ),
        )
        .into());
    }
    let contexts = derive_page_ink_contexts(&request.samples);
    encode_result(
        &[],
        &serde_json::to_vec(&WasmDeriveInkContextsResultV2 { contexts })?,
        &[],
    )
}

fn encode_result(
    page_json: &[u8],
    details_json: &[u8],
    outputs: &[FrameOutput],
) -> Result<Vec<u8>, Box<dyn Error>> {
    let too_large = || {
        NativeError::new(
            NativeErrorCode::TooLarge,
            "Scan-cleanup WASM output exceeds the admission ceiling",
        )
    };
    let mut total = RESULT_HEADER_BYTES
        .checked_add(page_json.len())
        .and_then(|total| total.checked_add(details_json.len()))
        .ok_or_else(too_large)?;
    for output in outputs {
        total = total
            .checked_add(OUTPUT_HEADER_BYTES + output.metadata_json.len())
            .ok_or_else(too_large)?;
        for plane in &output.planes {
            total = total
                .checked_add(PLANE_HEADER_BYTES + plane.data.len())
                .ok_or_else(too_large)?;
        }
    }
    if total > MAX_OUTPUT_BYTES {
        return Err(too_large().into());
    }
    let mut bytes = Vec::with_capacity(total);
    write_len(&mut bytes, page_json.len())?;
    write_len(&mut bytes, details_json.len())?;
    write_len(&mut bytes, outputs.len())?;
    bytes.extend_from_slice(page_json);
    bytes.extend_from_slice(details_json);
    for output in outputs {
        write_len(&mut bytes, output.metadata_json.len())?;
        write_len(&mut bytes, output.planes.len())?;
        bytes.extend_from_slice(&output.metadata_json);
        for plane in &output.planes {
            for value in [plane.role, plane.kind, plane.encoding] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            write_len(&mut bytes, plane.width)?;
            write_len(&mut bytes, plane.height)?;
            write_len(&mut bytes, plane.data.len())?;
            bytes.extend_from_slice(&plane.data);
        }
    }
    Ok(bytes)
}

fn write_len(bytes: &mut Vec<u8>, value: usize) -> Result<(), NativeError> {
    let value = u32::try_from(value).map_err(|_| {
        NativeError::new(
            NativeErrorCode::TooLarge,
            "Scan-cleanup WASM output field exceeds 32 bits",
        )
    })?;
    bytes.extend_from_slice(&value.to_le_bytes());
    Ok(())
}

fn take<'a>(request: &'a [u8], offset: &mut usize, len: usize) -> Result<&'a [u8], NativeError> {
    let end = offset
        .checked_add(len)
        .filter(|end| *end <= request.len())
        .ok_or_else(|| invalid("Truncated scan-cleanup WASM request"))?;
    let bytes = &request[*offset..end];
    *offset = end;
    Ok(bytes)
}

fn read_u32(request: &[u8], offset: &mut usize) -> Result<u32, NativeError> {
    let bytes = take(request, offset, U32_BYTES)?;
    Ok(u32::from_le_bytes(
        bytes.try_into().expect("took exactly four bytes"),
    ))
}

fn read_len(request: &[u8], offset: &mut usize) -> Result<usize, NativeError> {
    usize::try_from(read_u32(request, offset)?)
        .map_err(|_| invalid("Scan-cleanup WASM request length exceeds the address space"))
}

#[cfg(test)]
#[path = "wasm_tests.rs"]
mod tests;
