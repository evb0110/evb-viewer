//! Browser entry for the scan-cleanup engine on `wasm32-unknown-unknown`.
//!
//! A request frame carries one page's raster bytes and a versioned JSON
//! request; the result frame carries the page's result metadata and each
//! output's metadata and pixels. The page is decoded from those bytes and then
//! cleaned by the same `render_page` and `classify_page` cores the CLI runs, so
//! the browser and the desktop produce the same pixels and metadata for the
//! same raster and options. Manifests, staging and file publication stay in the
//! native CLI.
//!
//! The module is single-threaded: Rayon runs on the calling thread, and a
//! request cannot be cancelled once it has entered the engine. The host stops
//! work by terminating the worker that owns the instance.

use crate::cache::{PageCache, SourceFingerprint};
use crate::engine::page_workflow::{
    classify_page, render_page, DetailSourceRasters, PageRaster, PageRasterSource,
    PageRenderRequest, PageResultMetadata, RenderedPage,
};
use crate::engine::render::CleanupMetadata;
use crate::engine::resource_planning::{manifest_cache, PlanningOperation};
use crate::io::{png, raster};
use crate::protocol::manifest_v3::{validate_page_options, AnalysisPurpose, CanvasScope};
use crate::split::DocumentPrior;
use crate::CleanupOptions;
use evb_native_support::{
    bounded_io::deserialize_json_slice,
    wasm_request_allocation::{WasmRequestAllocation, WASM_REQUEST_ALLOCATION_ABI_VERSION},
    NativeError, NativeErrorCode, NativeErrorEnvelope,
};
use scan_primitives::GrayImage;
use serde::Deserialize;
use std::{cell::RefCell, error::Error, slice, sync::atomic::AtomicBool};

pub(crate) const REQUEST_MAGIC: &[u8; 4] = b"ESCW";
pub(crate) const REQUEST_VERSION: u32 = 1;
/// Renders one page as the desktop preview and the OCR preprocessing CLI do:
/// page canvas scope, no matched canvas, no separable layers.
pub(crate) const OP_RENDER_PREVIEW: u32 = 1;
/// Analyzes one page as an analyze manifest does, before document
/// reconciliation.
pub(crate) const OP_ANALYZE: u32 = 2;
pub(crate) const PLANE_ENCODING_RAW: u32 = 0;
pub(crate) const PLANE_ENCODING_PNG: u32 = 1;
pub(crate) const PLANE_KIND_GRAY8: u32 = 1;
pub(crate) const PLANE_KIND_RGB8: u32 = 2;
pub(crate) const U32_BYTES: usize = std::mem::size_of::<u32>();
/// magic, version, operation, plane encoding, request JSON length, input
/// length, separate analysis input length; then those three byte runs.
pub(crate) const REQUEST_HEADER_BYTES: usize = REQUEST_MAGIC.len() + 6 * U32_BYTES;
/// Result: page metadata JSON length and output count, then the JSON, then
/// each output's header, metadata JSON and plane bytes.
pub(crate) const RESULT_HEADER_BYTES: usize = 2 * U32_BYTES;
/// Output: metadata JSON length, plane kind, plane encoding, width, height,
/// plane byte length.
pub(crate) const OUTPUT_HEADER_BYTES: usize = 6 * U32_BYTES;
pub(crate) const MAX_REQUEST_JSON_BYTES: usize = 5 * 1024 * 1024;
// A WASM32 allocation layout uses a signed pointer-sized length.
pub(crate) const MAX_REQUEST_BYTES: usize = 1024 * 1024 * 1024;
pub(crate) const MAX_OUTPUT_BYTES: usize = 1024 * 1024 * 1024;

thread_local! {
    static REQUEST_ALLOCATION: WasmRequestAllocation = const { WasmRequestAllocation::new(MAX_REQUEST_BYTES) };
    static LAST_OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// The JSON half of a render-preview request, version 1.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WasmRenderPreviewRequestV1 {
    pub(crate) options: CleanupOptions,
    pub(crate) source_page_index: usize,
    pub(crate) canvas_scope: CanvasScope,
    /// The resolution of the fixed analysis plane: the separate analysis
    /// raster, or the input itself when `analysisIsInput` is set.
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) analysis_dpi: Option<f64>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) analysis_is_input: bool,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) document_prior: Option<DocumentPrior>,
}

/// The JSON half of an analyze request, version 1.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WasmAnalyzePageRequestV1 {
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

struct RequestFrame<'a> {
    operation: u32,
    plane_encoding: u32,
    request_json: &'a [u8],
    input: &'a [u8],
    analysis_input: &'a [u8],
}

enum AnalysisRaster<'a> {
    None,
    Input,
    Separate(&'a [u8]),
}

/// One page's rasters as request bytes. MRC layers and detail renders come
/// from desktop extraction and staging, which the browser engine does not
/// have, so this source never offers them.
struct RequestRasters<'a> {
    input: &'a [u8],
    analysis: AnalysisRaster<'a>,
    source_page_index: usize,
}

impl RequestRasters<'_> {
    fn bytes(&self, raster: PageRaster) -> Result<&[u8], NativeError> {
        match (raster, &self.analysis) {
            (PageRaster::Input, _) | (PageRaster::CanonicalAnalysis, AnalysisRaster::Input) => {
                Ok(self.input)
            }
            (PageRaster::CanonicalAnalysis, AnalysisRaster::Separate(bytes)) => Ok(bytes),
            _ => Err(invalid(format!(
                "The browser cleanup request has no {raster:?} raster"
            ))),
        }
    }

    fn decode<T>(
        &self,
        raster: PageRaster,
        decode: impl FnOnce(&[u8]) -> Result<T, raster::RasterReadError>,
    ) -> Result<T, NativeError> {
        decode(self.bytes(raster)?).map_err(|error| {
            NativeError::new(
                match error {
                    raster::RasterReadError::Io(_) => NativeErrorCode::Io,
                    raster::RasterReadError::Invalid(_) => NativeErrorCode::InvalidRequest,
                    raster::RasterReadError::TooLarge(_) => NativeErrorCode::TooLarge,
                },
                format!(
                    "Unable to read scan-cleanup raster for page {} ({raster:?}): {error}",
                    self.source_page_index.saturating_add(1),
                ),
            )
        })
    }
}

impl PageRasterSource for RequestRasters<'_> {
    fn has(&self, raster: PageRaster) -> bool {
        match raster {
            PageRaster::Input => true,
            PageRaster::CanonicalAnalysis => !matches!(self.analysis, AnalysisRaster::None),
            PageRaster::TrustedForegroundMask | PageRaster::TrustedMrcBackground => false,
        }
    }

    fn analysis_is_input(&self) -> bool {
        matches!(self.analysis, AnalysisRaster::Input)
    }

    fn read_image(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<raster::DecodedRaster, NativeError> {
        self.decode(raster, |bytes| {
            raster::decode_image_bytes(bytes, options.max_pixels, options.max_dimension)
        })
    }

    fn read_gray(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<GrayImage, NativeError> {
        self.decode(raster, |bytes| {
            raster::decode_gray_bytes(bytes, options.max_pixels, options.max_dimension)
        })
    }

    fn read_foreground_selection(
        &self,
        raster: PageRaster,
        _options: &CleanupOptions,
    ) -> Result<GrayImage, NativeError> {
        Err(invalid(format!(
            "The browser cleanup request has no {raster:?} raster"
        )))
    }

    fn read_detail_sources(
        &self,
        _options: &CleanupOptions,
    ) -> Result<DetailSourceRasters, NativeError> {
        Err(invalid(
            "Detail renders are not available in the browser cleanup engine",
        ))
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
        OP_RENDER_PREVIEW => run_render_preview(&frame),
        OP_ANALYZE => run_analyze(&frame),
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
    let input_len = read_len(request, &mut offset)?;
    let analysis_input_len = read_len(request, &mut offset)?;
    if request_json_len > MAX_REQUEST_JSON_BYTES {
        return Err(NativeError::new(
            NativeErrorCode::TooLarge,
            format!(
                "Scan-cleanup WASM request JSON exceeds the {MAX_REQUEST_JSON_BYTES}-byte admission ceiling"
            ),
        ));
    }
    let frame = RequestFrame {
        operation,
        plane_encoding,
        request_json: take(request, &mut offset, request_json_len)?,
        input: take(request, &mut offset, input_len)?,
        analysis_input: take(request, &mut offset, analysis_input_len)?,
    };
    if offset != request.len() {
        return Err(invalid("Trailing bytes in scan-cleanup WASM request"));
    }
    if frame.input.is_empty() {
        return Err(invalid("Scan-cleanup WASM request has no input raster"));
    }
    Ok(frame)
}

fn page_cache(source_page_index: usize) -> PageCache {
    PageCache::new(
        manifest_cache(PlanningOperation::Render, None),
        SourceFingerprint::in_memory(source_page_index),
    )
}

fn run_render_preview(frame: &RequestFrame<'_>) -> Result<Vec<u8>, Box<dyn Error>> {
    if !matches!(
        frame.plane_encoding,
        PLANE_ENCODING_RAW | PLANE_ENCODING_PNG
    ) {
        return Err(invalid(format!(
            "Unsupported scan-cleanup WASM plane encoding: {}",
            frame.plane_encoding
        ))
        .into());
    }
    let request: WasmRenderPreviewRequestV1 =
        deserialize_json_slice(frame.request_json, "scan-cleanup WASM render request")?;
    validate_page_options(&request.options, request.source_page_index, true)?;
    if let Some(prior) = request.document_prior {
        prior.validate().map_err(invalid)?;
    }
    let analysis = match (frame.analysis_input.is_empty(), request.analysis_is_input) {
        (true, false) => AnalysisRaster::None,
        (true, true) => AnalysisRaster::Input,
        (false, false) => AnalysisRaster::Separate(frame.analysis_input),
        (false, true) => {
            return Err(invalid(
                "A render request names the input as its analysis plane and also carries one",
            )
            .into())
        }
    };
    match (&analysis, request.analysis_dpi) {
        (AnalysisRaster::None, None) => {}
        (AnalysisRaster::Input | AnalysisRaster::Separate(_), Some(dpi))
            if dpi.is_finite() && dpi > 0.0 => {}
        _ => {
            return Err(invalid(
                "An analysis raster and a positive finite analysisDpi must be provided together",
            )
            .into())
        }
    }
    let rasters = RequestRasters {
        input: frame.input,
        analysis,
        source_page_index: request.source_page_index,
    };
    static NEVER_CANCELED: AtomicBool = AtomicBool::new(false);
    let RenderedPage {
        outputs, metadata, ..
    } = render_page(
        &rasters,
        PageRenderRequest {
            options: &request.options,
            source_page_index: request.source_page_index,
            analysis_dpi: request.analysis_dpi,
            document_prior: request.document_prior,
            detail_render_plan: None,
            canvas_scope: request.canvas_scope,
            final_render: false,
            layer_destinations: false,
            page_ink_consistency: None,
        },
        &page_cache(request.source_page_index),
        &NEVER_CANCELED,
    )?;
    // A preview publishes each output's composite and metadata, exactly as
    // the CLI's page-scope render writes them.
    let outputs = outputs
        .iter()
        .map(|output| {
            let plane = match &output.color_image {
                Some(color) => OutputPlane::rgb(color, frame.plane_encoding),
                None => OutputPlane::gray(&output.image.to_gray(), frame.plane_encoding),
            }?;
            Ok((&output.metadata, plane))
        })
        .collect::<Result<Vec<_>, String>>()
        .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
    encode_result(&metadata, &outputs)
}

fn run_analyze(frame: &RequestFrame<'_>) -> Result<Vec<u8>, Box<dyn Error>> {
    if frame.plane_encoding != PLANE_ENCODING_RAW || !frame.analysis_input.is_empty() {
        return Err(invalid(
            "An analyze request carries only its input raster and no plane encoding",
        )
        .into());
    }
    let request: WasmAnalyzePageRequestV1 =
        deserialize_json_slice(frame.request_json, "scan-cleanup WASM analyze request")?;
    validate_page_options(&request.options, request.source_page_index, false)?;
    if let Some(prior) = request.document_prior {
        prior.validate().map_err(invalid)?;
    }
    let rasters = RequestRasters {
        input: frame.input,
        analysis: AnalysisRaster::None,
        source_page_index: request.source_page_index,
    };
    static NEVER_CANCELED: AtomicBool = AtomicBool::new(false);
    // The arguments an analyze manifest's first pass uses for each page.
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
    encode_result(&metadata, &[])
}

struct OutputPlane {
    kind: u32,
    encoding: u32,
    width: usize,
    height: usize,
    data: Vec<u8>,
}

impl OutputPlane {
    fn gray(image: &GrayImage, encoding: u32) -> Result<Self, String> {
        let data = if encoding == PLANE_ENCODING_PNG {
            png::encode_gray(image)?
        } else {
            let mut data = Vec::with_capacity(image.width() * image.height());
            for y in 0..image.height() {
                data.extend_from_slice(image.row(y));
            }
            data
        };
        Ok(Self {
            kind: PLANE_KIND_GRAY8,
            encoding,
            width: image.width(),
            height: image.height(),
            data,
        })
    }

    fn rgb(image: &scan_primitives::RgbImage, encoding: u32) -> Result<Self, String> {
        let data = if encoding == PLANE_ENCODING_PNG {
            png::encode_rgb(image)?
        } else {
            image.data().to_vec()
        };
        Ok(Self {
            kind: PLANE_KIND_RGB8,
            encoding,
            width: image.width(),
            height: image.height(),
            data,
        })
    }
}

fn encode_result(
    page_metadata: &PageResultMetadata,
    outputs: &[(&CleanupMetadata, OutputPlane)],
) -> Result<Vec<u8>, Box<dyn Error>> {
    // The same compact serialization the CLI writes to its metadata files.
    let page_json = serde_json::to_vec(page_metadata)?;
    let output_jsons = outputs
        .iter()
        .map(|(metadata, _)| serde_json::to_vec(metadata))
        .collect::<Result<Vec<_>, _>>()?;
    let total = outputs.iter().zip(&output_jsons).try_fold(
        RESULT_HEADER_BYTES + page_json.len(),
        |total: usize, ((_, plane), json)| {
            total
                .checked_add(OUTPUT_HEADER_BYTES + json.len())
                .and_then(|total| total.checked_add(plane.data.len()))
        },
    );
    let total = total
        .filter(|total| *total <= MAX_OUTPUT_BYTES)
        .ok_or_else(|| {
            NativeError::new(
                NativeErrorCode::TooLarge,
                "Scan-cleanup WASM output exceeds the admission ceiling",
            )
        })?;
    let mut bytes = Vec::with_capacity(total);
    write_len(&mut bytes, page_json.len())?;
    write_len(&mut bytes, outputs.len())?;
    bytes.extend_from_slice(&page_json);
    for ((_, plane), json) in outputs.iter().zip(&output_jsons) {
        write_len(&mut bytes, json.len())?;
        bytes.extend_from_slice(&plane.kind.to_le_bytes());
        bytes.extend_from_slice(&plane.encoding.to_le_bytes());
        write_len(&mut bytes, plane.width)?;
        write_len(&mut bytes, plane.height)?;
        write_len(&mut bytes, plane.data.len())?;
        bytes.extend_from_slice(json);
        bytes.extend_from_slice(&plane.data);
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
