//! Page decoding, analysis, rendering, and output publication.
use crate::cache::{PageCache, StageCacheKey};
use crate::clock::Instant;
use crate::engine::output_geometry::*;
use crate::engine::page_statistics::trusted_selection_is_incomplete;
use crate::engine::render::{
    analyze_page_with_color_and_document_prior_cached_cancellable,
    clean_detail_page_with_color_cancellable, clean_page_with_color_and_document_prior_cached,
    CanonicalAnalysisPlane, CleanupMetadata, CleanupResult, DetailRenderSources,
    LayeredForegroundKind, MixedLayers,
};
use crate::engine::render::{quantize_decimal, CleanupWarningEvent};
use crate::engine::staged_input::{invalid, map_raster_error};
use crate::ink_consistency::PageInkConsistencyContext;
use crate::io::{pbm, png, raster};
use crate::protocol::{
    manifest_v3::{CanvasScope, DetailRenderGeometry, DocumentCanvas, Page, PageOutput},
    progress::PageStageTimings,
};
use crate::split::LayoutClassification;
use crate::{CleanupOptions, OrthogonalRotation, OutputMode};
use evb_native_support::{bounded_io::deserialize_json_file_bounded, NativeError, NativeErrorCode};
use scan_primitives::{BinaryImage, GrayImage, RgbImage};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    error::Error,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

/// One page's result metadata, as a manifest writes it to the page's metadata
/// file. Reading it back is how the browser engine revises an analysis it
/// returned earlier, so every field the file carries round-trips exactly; the
/// skipped fields are reconciliation inputs the file never carries.
#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageResultMetadata {
    pub(crate) version: u32,
    pub(crate) source_page_index: usize,
    pub(crate) layout_classification: LayoutClassification,
    pub(crate) layout_confidence: f64,
    pub(crate) cutter_x_px: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    pub(crate) rotation_degrees: OrthogonalRotation,
    pub(crate) canvas_scope: CanvasScope,
    pub(crate) excluded: bool,
    pub(crate) blank_outputs_skipped: usize,
    pub(crate) output_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) outputs: Vec<crate::engine::render::AnalysisOutputMetadata>,
    pub(crate) tier1_verdict: LayoutClassification,
    pub(crate) reconciled: bool,
    pub(crate) cluster_agreement: f64,
    pub(crate) split_diagnostics: crate::split::SplitDiagnostics,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) document_prior: Option<crate::split::DocumentPrior>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) text_axis: Option<crate::engine::text_axis::TextAxisHint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recommended_output_mode: Option<crate::OutputMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recommended_output_mode_confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recommended_output_mode_reason:
        Option<crate::mode_select::OutputModeRecommendationReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) soft_alpha_foreground_recommendation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) output_mode_diagnostics: Option<crate::mode_select::OutputModeDiagnostics>,
    #[serde(skip)]
    pub(crate) rotated_width: usize,
    #[serde(skip)]
    pub(crate) rotated_height: usize,
    #[serde(skip)]
    pub(crate) candidate_cutter_ratio: Option<f64>,
    #[serde(skip)]
    pub(crate) whitespace_score: f64,
    #[serde(skip)]
    pub(crate) reconciliation_eligible: bool,
    #[serde(skip)]
    pub(crate) tier1_confidence: f64,
    #[serde(skip)]
    pub(crate) calibration_stroke_width_px: Option<f64>,
    #[serde(skip)]
    pub(crate) calibration_x_height_px: Option<f64>,
}

pub(crate) struct PageRunResult {
    pub(crate) outputs: Vec<WrittenOutput>,
    pub(crate) metadata: PageResultMetadata,
    pub(crate) page_metadata_path: PathBuf,
    pub(crate) timings: PageStageTimings,
}

pub(crate) const MAX_DETAIL_METADATA_BYTES: usize = 16 * 1024 * 1024;
const SOFT_FOREGROUND_MAX_DPI: f64 = 300.0;
type DecodedPageInputs = (Option<Arc<raster::DecodedRaster>>, Option<Arc<GrayImage>>);

/// The rasters a page render reads, by the role each plays.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PageRaster {
    Input,
    CanonicalAnalysis,
    TrustedForegroundMask,
    TrustedMrcBackground,
}

/// Where one page's rasters come from. The CLI decodes the manifest page's
/// files; the browser engine decodes the bytes its request carries. Every
/// decision after decoding is shared, so both routes produce the same output.
pub(crate) trait PageRasterSource {
    fn has(&self, raster: PageRaster) -> bool;
    /// The fixed analysis plane is the page input itself.
    fn analysis_is_input(&self) -> bool;
    fn read_image(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<raster::DecodedRaster, NativeError>;
    fn read_gray(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<GrayImage, NativeError>;
    fn read_foreground_selection(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<GrayImage, NativeError>;
    /// The base render a detail render refines, which a source offers only
    /// when its page carries a detail plan.
    fn read_detail_sources(
        &self,
        options: &CleanupOptions,
    ) -> Result<DetailSourceRasters, NativeError>;
}

/// The already-rendered page a detail render refines.
pub(crate) struct DetailSourceRasters {
    pub(crate) base_metadata: CleanupMetadata,
    pub(crate) base_source: raster::DecodedRaster,
    pub(crate) base_cleaned: Option<raster::DecodedRaster>,
}

fn page_raster_path(page: &Page, raster: PageRaster) -> Option<&Path> {
    match raster {
        PageRaster::Input => Some(&page.input_path),
        PageRaster::CanonicalAnalysis => page.analysis_input_path.as_deref(),
        PageRaster::TrustedForegroundMask => page.trusted_foreground_mask_path.as_deref(),
        PageRaster::TrustedMrcBackground => page.trusted_mrc_background_path.as_deref(),
    }
}

impl Page {
    fn read_raster<T>(
        &self,
        raster: PageRaster,
        read: impl FnOnce(&Path) -> Result<T, raster::RasterReadError>,
    ) -> Result<T, NativeError> {
        let path = page_raster_path(self, raster)
            .ok_or_else(|| invalid(format!("Page has no {raster:?} raster")))?;
        read(path).map_err(|error| map_raster_error(error, path, self.source_page_index))
    }
}

impl PageRasterSource for Page {
    fn has(&self, raster: PageRaster) -> bool {
        page_raster_path(self, raster).is_some()
    }

    fn analysis_is_input(&self) -> bool {
        self.analysis_input_path.as_ref() == Some(&self.input_path)
    }

    fn read_image(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<raster::DecodedRaster, NativeError> {
        self.read_raster(raster, |path| {
            raster::read_image(path, options.max_pixels, options.max_dimension)
        })
    }

    fn read_gray(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<GrayImage, NativeError> {
        self.read_raster(raster, |path| {
            raster::read_gray(path, options.max_pixels, options.max_dimension)
        })
    }

    fn read_foreground_selection(
        &self,
        raster: PageRaster,
        options: &CleanupOptions,
    ) -> Result<GrayImage, NativeError> {
        self.read_raster(raster, |path| {
            raster::read_foreground_selection(path, options.max_pixels, options.max_dimension)
        })
    }

    fn read_detail_sources(
        &self,
        options: &CleanupOptions,
    ) -> Result<DetailSourceRasters, NativeError> {
        let detail_plan = self
            .detail_render_plan
            .as_ref()
            .ok_or_else(|| invalid("Page has no detail render plan"))?;
        let base_metadata: CleanupMetadata = deserialize_json_file_bounded(
            &detail_plan.base_metadata_path,
            MAX_DETAIL_METADATA_BYTES,
            "detail base metadata",
        )
        .map_err(|error| {
            if error.code == NativeErrorCode::TooLarge {
                error
            } else {
                invalid(format!(
                    "Invalid detail base metadata {}: {error}",
                    detail_plan.base_metadata_path.display(),
                ))
            }
        })?;
        let base_source = raster::read_image(
            &detail_plan.base_raster_path,
            options.max_pixels,
            options.max_dimension,
        )
        .map_err(|error| {
            map_raster_error(error, &detail_plan.base_raster_path, self.source_page_index)
        })?;
        let base_cleaned = detail_plan
            .base_cleaned_raster_path
            .as_ref()
            .map(|path| {
                raster::read_image(path, options.max_pixels, options.max_dimension)
                    .map_err(|error| map_raster_error(error, path, self.source_page_index))
            })
            .transpose()?;
        Ok(DetailSourceRasters {
            base_metadata,
            base_source,
            base_cleaned,
        })
    }
}

/// Everything one page render needs besides its rasters.
pub(crate) struct PageRenderRequest<'a> {
    pub(crate) options: &'a CleanupOptions,
    pub(crate) source_page_index: usize,
    pub(crate) analysis_dpi: Option<f64>,
    pub(crate) document_prior: Option<crate::split::DocumentPrior>,
    pub(crate) detail_render_plan: Option<&'a DetailRenderGeometry>,
    pub(crate) canvas_scope: CanvasScope,
    pub(crate) final_render: bool,
    /// Every output can take a background and a foreground layer, so a final
    /// render may publish the separable layers instead of the composite.
    pub(crate) layer_destinations: bool,
    pub(crate) page_ink_consistency: Option<PageInkConsistencyContext>,
}

impl<'a> PageRenderRequest<'a> {
    fn for_page(
        page: &'a Page,
        canvas_scope: CanvasScope,
        final_render: bool,
        page_ink_consistency: Option<PageInkConsistencyContext>,
    ) -> Self {
        Self {
            options: &page.options,
            source_page_index: page.source_page_index,
            analysis_dpi: page.analysis_dpi,
            document_prior: page.document_prior,
            detail_render_plan: page.detail_render_plan.as_ref().map(|plan| &plan.geometry),
            canvas_scope,
            final_render,
            layer_destinations: OutputPlanes::take_layers(
                &page
                    .outputs
                    .iter()
                    .map(OutputPlanes::of_destination)
                    .collect::<Vec<_>>(),
            ),
            page_ink_consistency,
        }
    }
}

/// One cleaned page before publication.
pub(crate) struct RenderedPage {
    pub(crate) outputs: Vec<CleanupResult>,
    pub(crate) classification: LayoutClassification,
    pub(crate) metadata: PageResultMetadata,
    /// The options the page was cleaned with, at its scan resolution.
    pub(crate) options: CleanupOptions,
    pub(crate) timings: PageStageTimings,
}

pub(crate) fn map_analysis_error(error: crate::engine::render::AnalysisError) -> NativeError {
    let (code, message) = match error {
        crate::engine::render::AnalysisError::Invalid(message) => {
            (NativeErrorCode::InvalidRequest, message)
        }
        crate::engine::render::AnalysisError::TooLarge(message) => {
            (NativeErrorCode::TooLarge, message)
        }
        crate::engine::render::AnalysisError::Canceled(message) => (NativeErrorCode::Io, message),
    };
    NativeError::new(code, message)
}

fn resolve_destinations(
    page: &Page,
    output_count: usize,
    fallback: Option<(&Path, &Path)>,
) -> Result<Vec<PageOutput>, NativeError> {
    if !page.outputs.is_empty() {
        if page.outputs.len() < output_count {
            return Err(invalid(format!(
            "Cleanup produced {output_count} pages but only {} output destinations were supplied",
            page.outputs.len()
        )));
        }
        return Ok(page.outputs.iter().take(output_count).cloned().collect());
    }
    let (output, metadata) =
        fallback.ok_or_else(|| invalid("Render page requires output destinations"))?;
    if output_count == 1 {
        return Ok(vec![PageOutput {
            output_path: output.to_path_buf(),
            metadata_path: metadata.to_path_buf(),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
            foreground_alpha_output_path: None,
            picture_mask_output_path: None,
            tone_preservation_alpha_output_path: None,
        }]);
    }
    Ok((0..output_count)
        .map(|index| PageOutput {
            output_path: suffixed_path(output, index),
            metadata_path: suffixed_path(metadata, index),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
            foreground_alpha_output_path: None,
            picture_mask_output_path: None,
            tone_preservation_alpha_output_path: None,
        })
        .collect())
}

fn suffixed_path(path: &Path, index: usize) -> std::path::PathBuf {
    let suffix = if index == 0 { "left" } else { "right" };
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("page");
    let extension = path.extension().and_then(|value| value.to_str());
    let name = match extension {
        Some(extension) => format!("{stem}-{suffix}.{extension}"),
        None => format!("{stem}-{suffix}"),
    };
    path.with_file_name(name)
}

pub(crate) fn decode_page_inputs(
    source: &impl PageRasterSource,
    options: &CleanupOptions,
    cache: &PageCache,
    retain_decoded: bool,
    decode_color: bool,
) -> Result<DecodedPageInputs, Box<dyn Error>> {
    let color_input = if decode_color {
        let key = StageCacheKey::decoded(&cache.source, true, options);
        let cached = retain_decoded
            .then(|| {
                cache
                    .shared
                    .lock()
                    .ok()
                    .and_then(|mut shared| shared.get::<raster::DecodedRaster>(&key))
            })
            .flatten();
        Some(if let Some(cached) = cached {
            cached
        } else {
            let decoded = Arc::new(source.read_image(PageRaster::Input, options)?);
            if retain_decoded {
                let bytes = decoded.gray.data().len().saturating_add(
                    decoded
                        .rgb
                        .width()
                        .saturating_mul(decoded.rgb.height())
                        .saturating_mul(3),
                );
                if let Ok(mut shared) = cache.shared.lock() {
                    shared.insert(key, Arc::clone(&decoded), bytes);
                }
            }
            decoded
        })
    } else {
        None
    };
    let gray_input = if color_input.is_none() {
        let key = StageCacheKey::decoded(&cache.source, false, options);
        let cached = retain_decoded
            .then(|| {
                cache
                    .shared
                    .lock()
                    .ok()
                    .and_then(|mut shared| shared.get::<GrayImage>(&key))
            })
            .flatten();
        Some(if let Some(cached) = cached {
            cached
        } else {
            let decoded = Arc::new(source.read_gray(PageRaster::Input, options)?);
            if retain_decoded {
                let bytes = decoded.data().len();
                if let Ok(mut shared) = cache.shared.lock() {
                    shared.insert(key, Arc::clone(&decoded), bytes);
                }
            }
            decoded
        })
    } else {
        None
    };
    Ok((color_input, gray_input))
}

/// Cleans one page in memory: decode, analysis, render and the page's result
/// metadata. The CLI publishes what this returns to the manifest's files; the
/// browser engine returns it to its caller.
pub(crate) fn render_page(
    source: &impl PageRasterSource,
    request: PageRenderRequest<'_>,
    cache: &PageCache,
    is_canceled: &AtomicBool,
) -> Result<RenderedPage, Box<dyn Error>> {
    let PageRenderRequest {
        options,
        source_page_index,
        analysis_dpi,
        document_prior,
        detail_render_plan,
        canvas_scope,
        final_render,
        layer_destinations,
        page_ink_consistency,
    } = request;
    if is_canceled.load(Ordering::Acquire) {
        return Err(crate::engine::cancellation_error().into());
    }
    let options = options.clone();
    options.validate().map_err(invalid)?;
    let mut timings = PageStageTimings::default();
    let decode_started = Instant::now();
    // Render pages retain reusable analysis-stage artifacts, but decoded
    // source rasters are intentionally scoped to this invocation. Analyze's
    // classification path opts into decoded memoization below because its
    // document-prior reconciliation may replay a page.
    let decode_color = matches!(
        options.output_mode,
        OutputMode::Color | OutputMode::Mixed | OutputMode::Auto
    );
    let (color_input, gray_input) =
        decode_page_inputs(source, &options, cache, false, decode_color)?;
    if is_canceled.load(Ordering::Acquire) {
        return Err(crate::engine::cancellation_error().into());
    }
    timings.decode_ms += decode_started.elapsed().as_secs_f64() * 1_000.0;
    let input_gray = color_input
        .as_ref()
        .map(|input| &input.gray)
        .or(gray_input.as_deref())
        .expect("cleanup input is initialized");
    let options = options.at_scan_resolution(input_gray.width(), input_gray.height());
    let canonical_analysis_input = source
        .has(PageRaster::CanonicalAnalysis)
        .then(|| match &color_input {
            // A preview names one raster as both its input and its analysis
            // plane; a second decode of it cost ~65 ms at four megapixels.
            Some(input) if source.analysis_is_input() => Ok(Arc::clone(input)),
            _ => source
                .read_image(PageRaster::CanonicalAnalysis, &options)
                .map(Arc::new),
        })
        .transpose()?;
    if let Some(canonical) = canonical_analysis_input.as_ref() {
        if !aspect_ratio_matches(
            input_gray.width(),
            input_gray.height(),
            canonical.gray.width(),
            canonical.gray.height(),
        ) {
            return Err(invalid(format!(
                "Fixed analysis raster aspect ratio does not match page input: {}x{} versus {}x{}",
                canonical.gray.width(),
                canonical.gray.height(),
                input_gray.width(),
                input_gray.height(),
            ))
            .into());
        }
    }
    let canonical_analysis =
        canonical_analysis_input
            .as_ref()
            .map(|canonical| CanonicalAnalysisPlane {
                gray: &canonical.gray,
                color: Some(&canonical.rgb),
                dpi: analysis_dpi.expect("validated fixed analysis raster has a DPI")
                    * options.placement_scale,
            });
    let trusted_foreground = source
    .has(PageRaster::TrustedForegroundMask)
    .then(|| {
        let selection =
            source.read_foreground_selection(PageRaster::TrustedForegroundMask, &options)?;
        if !aspect_ratio_matches(
            input_gray.width(),
            input_gray.height(),
            selection.width(),
            selection.height(),
        ) {
            return Err(invalid(format!(
                "Trusted foreground mask aspect ratio does not match page input: {}x{} versus {}x{}",
                selection.width(),
                selection.height(),
                input_gray.width(),
                input_gray.height(),
            )));
        }
        let selection_width = selection.width();
        Ok((
            normalize_trusted_foreground_selection(&selection, input_gray),
            selection_width,
        ))
    })
    .transpose()?;
    let trusted_foreground_source_width = trusted_foreground
        .as_ref()
        .map(|(_, selection_width)| *selection_width);
    let trusted_foreground_mask = trusted_foreground.map(|(mask, _)| mask);
    let trusted_mrc_background = source
        .has(PageRaster::TrustedMrcBackground)
        .then(|| {
            let background = source.read_gray(PageRaster::TrustedMrcBackground, &options)?;
            let (background_width, background_height) = (background.width(), background.height());
            if !aspect_ratio_matches(
                input_gray.width(),
                input_gray.height(),
                background_width,
                background_height,
            ) {
                return Err(invalid(format!(
                "Trusted MRC background aspect ratio does not match page input: {}x{} versus {}x{}",
                background_width,
                background_height,
                input_gray.width(),
                input_gray.height(),
            )));
            }
            Ok(background)
        })
        .transpose()?;
    let trusted_selection_incomplete = trusted_mrc_background
        .as_ref()
        .zip(trusted_foreground_source_width)
        .is_some_and(|(background, selection_width)| {
            trusted_selection_is_incomplete(selection_width, background.width())
        });
    // A full-resolution background marks producer pages whose selection mask
    // is not a complete ink carrier. Keep the compatibility hint available to
    // late output-mode resolution. The renderer rebuilds the background while
    // retaining selected ink and raw-supported additions in the foreground.
    let mut options = options;
    options.trusted_selection_incomplete = trusted_selection_incomplete;
    options.trusted_mrc_source_available = trusted_mrc_background.is_some();
    options.page_ink_consistency = (options.output_mode == OutputMode::Bw
        && options.thickness == 0
        && !options.trusted_selection_incomplete
        && trusted_foreground_mask.is_some())
    .then_some(page_ink_consistency)
    .flatten();
    if trusted_mrc_background.is_some() != trusted_foreground_mask.is_some() {
        return Err(Box::new(invalid(
            "Trusted MRC evidence must provide both background and foreground selection layers",
        )));
    }
    let create_mixed_layers = final_render && layer_destinations;
    let mut result = if let Some(detail_plan) = detail_render_plan {
        let DetailSourceRasters {
            base_metadata,
            base_source,
            base_cleaned,
        } = source.read_detail_sources(&options)?;
        clean_detail_page_with_color_cancellable(
            DetailRenderSources {
                source_crop: input_gray,
                color_source_crop: color_input.as_ref().map(|input| &input.rgb),
                base_source: &base_source.gray,
                base_color_source: Some(&base_source.rgb),
                base_cleaned: base_cleaned
                    .as_ref()
                    .map(|cleaned| (&cleaned.gray, Some(&cleaned.rgb))),
            },
            &options,
            source_page_index,
            detail_plan,
            &base_metadata,
            &mut timings,
            is_canceled,
        )
        .map_err(map_analysis_error)?
    } else {
        clean_page_with_color_and_document_prior_cached(
            input_gray,
            color_input.as_ref().map(|input| &input.rgb),
            canonical_analysis,
            trusted_foreground_mask.as_ref(),
            trusted_mrc_background.as_ref(),
            &options,
            source_page_index,
            document_prior,
            cache,
            create_mixed_layers,
            // A concrete mode may have come from the user's setting or from
            // the already-completed document detector. In either case the
            // render has no reason to run mode recommendation again. Automatic
            // pages without reusable evidence still compute it here.
            options.output_mode == OutputMode::Auto,
            &mut timings,
            is_canceled,
        )
        .map_err(map_analysis_error)?
    };
    if is_canceled.load(Ordering::Acquire) {
        return Err(crate::engine::cancellation_error().into());
    }
    if final_render && result.classification == LayoutClassification::TwoPageSpread {
        // The matched-canvas planner must measure the same visible raster that
        // the compact manifest will publish. Mixed layers are useful for the
        // single-page layered path, but their mask/background planes can have
        // different crop headroom; restoring the spread composite first keeps
        // the shared vertical anchor in the composite's source coordinates.
        for output in &mut result.outputs {
            if output.mixed_layers.is_some() {
                restore_mixed_composite_from_layers(output);
            }
        }
    }
    for output in &mut result.outputs {
        output.metadata.canvas_scope = canvas_scope;
        report_in_placement_units(&mut output.metadata, &options);
    }
    if options.ocr_mode
        && (result.outputs.len() != 1
            || result.outputs[0].image.width() != input_gray.width()
            || result.outputs[0].image.height() != input_gray.height())
    {
        return Err(invalid("OCR mode changed output dimensions").into());
    }
    let page_metadata = PageResultMetadata {
        version: crate::protocol::manifest_v3::VERSION,
        source_page_index,
        layout_classification: result.classification,
        layout_confidence: result.layout_confidence,
        cutter_x_px: result.cutter_x,
        split_seam: result.split_seam,
        rotation_degrees: result.rotation,
        canvas_scope,
        excluded: result.excluded,
        blank_outputs_skipped: result.blank_outputs_skipped,
        output_count: result.outputs.len(),
        outputs: Vec::new(),
        tier1_verdict: result.reconciliation.tier1_verdict,
        reconciled: result.reconciliation.reconciled,
        cluster_agreement: result.reconciliation.cluster_agreement,
        split_diagnostics: result.split_diagnostics,
        document_prior,
        text_axis: None,
        recommended_output_mode: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.mode),
        recommended_output_mode_confidence: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.confidence),
        recommended_output_mode_reason: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.reason),
        soft_alpha_foreground_recommendation: result
            .output_mode_recommendation
            .filter(|recommendation| recommendation.mode == OutputMode::Mixed)
            .map(|recommendation| recommendation.prefer_soft_alpha_foreground),
        output_mode_diagnostics: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.diagnostics),
        rotated_width: if matches!(
            options.rotation,
            OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270
        ) {
            input_gray.height()
        } else {
            input_gray.width()
        },
        rotated_height: if matches!(
            options.rotation,
            OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270
        ) {
            input_gray.width()
        } else {
            input_gray.height()
        },
        candidate_cutter_ratio: result
            .cutter_x
            .map(|cutter| cutter / input_gray.width().max(1) as f64),
        whitespace_score: 0.0,
        reconciliation_eligible: false,
        tier1_confidence: result.layout_confidence,
        calibration_stroke_width_px: None,
        calibration_x_height_px: None,
    };
    Ok(RenderedPage {
        outputs: result.outputs,
        classification: result.classification,
        metadata: page_metadata,
        options,
        timings,
    })
}

/// The file type of an output's background destination: PPM or PGM by its
/// extension, PNG otherwise. A continuous-tone PPM is the managed handoff to
/// the PDF assembler, which JPEG-encodes it at once; a lossless PNG would be
/// encoded here only to be decoded again there.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub(crate) enum BackgroundFile {
    Png,
    Ppm,
    Pgm,
}

impl BackgroundFile {
    fn of_path(path: &Path) -> Self {
        match path.extension().and_then(|extension| extension.to_str()) {
            Some(extension) if extension.eq_ignore_ascii_case("ppm") => Self::Ppm,
            Some(extension) if extension.eq_ignore_ascii_case("pgm") => Self::Pgm,
            _ => Self::Png,
        }
    }
}

/// The planes one output's destination takes besides its composite and
/// metadata, which every destination takes. The CLI reads them off a manifest
/// output's paths; the browser engine off its request.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputPlanes {
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) bilevel: bool,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) background: Option<BackgroundFile>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) foreground_mask: bool,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) foreground_alpha: bool,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) picture_mask: bool,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) tone_preservation_alpha: bool,
}

impl OutputPlanes {
    pub(crate) fn of_destination(output: &PageOutput) -> Self {
        Self {
            bilevel: output.bilevel_output_path.is_some(),
            background: output
                .background_output_path
                .as_deref()
                .map(BackgroundFile::of_path),
            foreground_mask: output.foreground_mask_output_path.is_some(),
            foreground_alpha: output.foreground_alpha_output_path.is_some(),
            picture_mask: output.picture_mask_output_path.is_some(),
            tone_preservation_alpha: output.tone_preservation_alpha_output_path.is_some(),
        }
    }

    /// Every output can take a background and a foreground layer, so a final
    /// render may publish the separable layers instead of the composite.
    pub(crate) fn take_layers(outputs: &[Self]) -> bool {
        !outputs.is_empty()
            && outputs
                .iter()
                .all(|output| output.background.is_some() && output.foreground_mask)
    }
}

/// What a published plane carries.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlaneRole {
    Composite,
    Bilevel,
    Background,
    ForegroundMask,
    ForegroundAlpha,
    PictureMask,
    TonePreservationAlpha,
}

pub(crate) enum PlanePixels<'a> {
    Gray(Cow<'a, GrayImage>),
    Rgb(Cow<'a, RgbImage>),
    Bilevel(&'a BinaryImage),
}

/// The file format a plane is published in.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlaneFile {
    Png,
    /// PBM P4: packed rows, most significant bit first, one is black.
    Pbm,
    /// PPM P6; a gray plane repeats each sample in all three channels.
    Ppm,
    /// PGM P5.
    Pgm,
}

/// One plane of a finished output, as it is published.
pub(crate) struct OutputPlane<'a> {
    pub(crate) role: PlaneRole,
    pub(crate) pixels: PlanePixels<'a>,
    pub(crate) file: PlaneFile,
}

impl OutputPlane<'_> {
    /// The bytes [`Self::write_atomic`] publishes.
    #[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
    pub(crate) fn encode(&self) -> Result<Vec<u8>, String> {
        match (&self.pixels, self.file) {
            (PlanePixels::Gray(image), PlaneFile::Png) => png::encode_gray(image),
            (PlanePixels::Gray(image), PlaneFile::Ppm) => raster::encode_gray_ppm(image),
            (PlanePixels::Gray(image), PlaneFile::Pgm) => raster::encode_gray_pgm(image),
            (PlanePixels::Rgb(image), PlaneFile::Png) => png::encode_rgb(image),
            (PlanePixels::Rgb(image), PlaneFile::Ppm) => raster::encode_rgb_ppm(image),
            (PlanePixels::Bilevel(image), PlaneFile::Pbm) => pbm::encode_p4_bilevel(image),
            _ => Err(self.unsupported()),
        }
    }

    pub(crate) fn write_atomic(&self, path: &Path) -> Result<(), String> {
        match (&self.pixels, self.file) {
            (PlanePixels::Gray(image), PlaneFile::Png) => png::write_gray_atomic(path, image),
            (PlanePixels::Gray(image), PlaneFile::Ppm) => {
                raster::write_gray_ppm_atomic(path, image)
            }
            (PlanePixels::Gray(image), PlaneFile::Pgm) => {
                raster::write_gray_pgm_atomic(path, image)
            }
            (PlanePixels::Rgb(image), PlaneFile::Png) => png::write_rgb_atomic(path, image),
            (PlanePixels::Rgb(image), PlaneFile::Ppm) => raster::write_rgb_ppm_atomic(path, image),
            (PlanePixels::Bilevel(image), PlaneFile::Pbm) => {
                pbm::write_p4_bilevel_atomic(path, image)
            }
            _ => Err(self.unsupported()),
        }
    }

    fn unsupported(&self) -> String {
        format!("The {:?} plane has no {:?} encoding", self.role, self.file)
    }
}

/// Where a finished output's planes go: the manifest's files for the CLI, the
/// result frame for the browser engine.
pub(crate) trait PlaneSink {
    fn publish(&mut self, plane: &OutputPlane<'_>) -> Result<(), String>;
    /// Withdraws a plane after its output fell back to another representation.
    fn discard(&mut self, role: PlaneRole);
}

/// A finished page: every output in the representation it is published in,
/// matched to the document canvas where the page asks for it.
pub(crate) struct FinishedPage {
    pub(crate) outputs: Vec<FinishedOutput>,
    pub(crate) metadata: PageResultMetadata,
    /// The options the page was cleaned with, at its scan resolution.
    pub(crate) options: CleanupOptions,
    pub(crate) timings: PageStageTimings,
}

pub(crate) struct FinishedOutput {
    pub(crate) result: CleanupResult,
    planes: OutputPlanes,
    final_render: bool,
    layers: Option<LayerPlan>,
    matched_in_memory: bool,
}

/// How a final output's separable layers are published.
struct LayerPlan {
    background_file: BackgroundFile,
    background_width: usize,
    background_height: usize,
    background_dpi: f64,
    /// The soft foreground's published size when it is smaller than the page.
    foreground_alpha_size: Option<(usize, usize)>,
    foreground_kind: LayeredForegroundKind,
    foreground_dpi: Option<f64>,
}

impl LayerPlan {
    fn background_plane<'a>(&self, layers: &'a MixedLayers) -> OutputPlane<'a> {
        let (width, height) = (self.background_width, self.background_height);
        let (pixels, file) = if let Some(color) = &layers.color_background {
            let pixels = if color.width() != width || color.height() != height {
                Cow::Owned(color.resample_to_dimensions(width, height))
            } else {
                Cow::Borrowed(color)
            };
            let file = if self.background_file == BackgroundFile::Ppm {
                PlaneFile::Ppm
            } else {
                PlaneFile::Png
            };
            (PlanePixels::Rgb(pixels), file)
        } else {
            let pixels =
                if layers.background.width() != width || layers.background.height() != height {
                    Cow::Owned(layers.background.downscale_to_dimensions(width, height))
                } else {
                    Cow::Borrowed(&layers.background)
                };
            let file = match self.background_file {
                BackgroundFile::Ppm => PlaneFile::Ppm,
                BackgroundFile::Pgm => PlaneFile::Pgm,
                BackgroundFile::Png => PlaneFile::Png,
            };
            (PlanePixels::Gray(pixels), file)
        };
        OutputPlane {
            role: PlaneRole::Background,
            pixels,
            file,
        }
    }

    fn foreground_plane<'a>(&self, layers: &'a MixedLayers) -> OutputPlane<'a> {
        match &layers.foreground_alpha {
            Some(alpha) => OutputPlane {
                role: PlaneRole::ForegroundAlpha,
                pixels: PlanePixels::Gray(match self.foreground_alpha_size {
                    Some((width, height)) => {
                        Cow::Owned(alpha.downscale_to_dimensions(width, height))
                    }
                    None => Cow::Borrowed(alpha),
                }),
                file: PlaneFile::Pgm,
            },
            None => OutputPlane {
                role: PlaneRole::ForegroundMask,
                pixels: PlanePixels::Bilevel(&layers.foreground_mask),
                file: PlaneFile::Pbm,
            },
        }
    }
}

/// Places a rendered page's outputs on the document canvas when it is a final
/// matched render, and decides how each is published: its bilevel plane, its
/// separable layers or its composite. The pixels are produced as each plane is
/// published, so a page holds no more than the CLI writing it file by file.
pub(crate) fn finish_page(
    rendered: RenderedPage,
    final_render: bool,
    document_canvas: Option<DocumentCanvas>,
    planes: Vec<OutputPlanes>,
) -> Result<FinishedPage, NativeError> {
    let RenderedPage {
        mut outputs,
        classification,
        metadata,
        options,
        timings,
    } = rendered;
    debug_assert_eq!(outputs.len(), planes.len());
    let matched_canvas = if final_render && options.match_page_size && !options.ocr_mode {
        let canvas = document_canvas
            .ok_or_else(|| invalid("Matched page size requires a documentCanvas plan"))?;
        // PDF page matching is a physical-points contract. Each page keeps
        // the DPI at which it was actually cleaned.
        Some(matched_canvas_for_options(canvas, &options)?)
    } else {
        None
    };
    let matched_placements = if let Some(canvas) = matched_canvas {
        let geometry_outputs = outputs
            .iter()
            .map(|output| {
                let mut geometry = geometry_output_from_cleanup_result(output, &options);
                geometry.optical_content_bounds_x = PLACEMENT_CENTERING_BOUNDS_X;
                geometry
            })
            .collect::<Vec<_>>();
        plan_canvas_placements(&geometry_outputs, &canvas)
            .into_iter()
            .zip(&outputs)
            .map(|(mut placement, output)| {
                placement.optical_content_bounds_x = output
                    .metadata
                    .content_box
                    .is_some()
                    .then(|| optical_content_bounds_x_for_output(output))
                    .flatten();
                Some((placement, canvas))
            })
            .collect::<Vec<_>>()
    } else {
        vec![None; outputs.len()]
    };
    let mut finished = Vec::with_capacity(outputs.len());
    for ((mut output, planes), matched_placement) in
        outputs.drain(..).zip(planes).zip(matched_placements)
    {
        let layer_destinations_available = final_render
            && output.mixed_layers.as_ref().is_some_and(|layers| {
                planes.background.is_some()
                    && if layers.foreground_alpha.is_some() {
                        planes.foreground_alpha
                    } else {
                        planes.foreground_mask
                    }
            });
        if let Some((placement, canvas)) = matched_placement {
            apply_canvas_metadata(&mut output.metadata, placement, &canvas);
            match_picture_mask_in_memory(&mut output, placement, &canvas);
            match_tone_preservation_alpha_in_memory(&mut output, placement, &canvas);
            let spread_mixed = classification == LayoutClassification::TwoPageSpread
                && output.mixed_layers.is_some();
            if spread_mixed {
                // The shared spread anchor is native canvas geometry. A
                // compact layered manifest has no placement matrix; its
                // WASM/img2pdf assembler scales the background and mask
                // independently and can therefore reintroduce each leaf's
                // intrinsic crop headroom. The composite was restored before
                // planning, so materialize that exact source on the native
                // canvas. Single-page mixed output keeps its layered
                // representation.
                match_primary_raster_in_memory(&mut output, placement, &canvas);
                output.mixed_layers = None;
            } else if layer_destinations_available {
                // Layered and bilevel publication still materializes the
                // document canvas, so its intrinsic output is the placed
                // content rectangle on that grid.
                output.metadata.output_width = placement.content_width;
                output.metadata.output_height = placement.content_height;
                match_layers_in_memory(&mut output, &options, placement, &canvas);
            } else {
                match_primary_raster_in_memory(&mut output, placement, &canvas);
            }
        }
        let layers = match (
            output.mixed_layers.as_ref(),
            planes.background.filter(|_| final_render),
        ) {
            (Some(layers), Some(background_file)) => {
                let foreground_destination = if layers.foreground_alpha.is_some() {
                    planes.foreground_alpha
                } else {
                    planes.foreground_mask
                };
                if !foreground_destination {
                    return Err(invalid(
                        "Layered cleanup output is missing its foreground destination",
                    ));
                }
                // Source-MRC pages already carry the authored high-DPI photo
                // detail through their JPX+smask pair. Only pages without
                // that safe affine reuse need the larger fresh
                // continuous-tone plate.
                let confirmed_picture = output
                    .picture_mask
                    .as_ref()
                    .is_some_and(|mask| mask.count_black() > 0)
                    && !layers.source_mrc;
                let background_dpi = layered_background_dpi(&options, confirmed_picture);
                let (target_width, target_height) =
                    if let Some((_, canvas)) = matched_placement.as_ref() {
                        background_canvas_dimensions(canvas, background_dpi)
                    } else {
                        (
                            ((layers.foreground_mask.width() as f64 * background_dpi
                                / options.placement_dpi())
                            .round() as usize)
                                .max(1),
                            ((layers.foreground_mask.height() as f64 * background_dpi
                                / options.placement_dpi())
                            .round() as usize)
                                .max(1),
                        )
                    };
                let (background_width, background_height) = background_dimensions_to_publish(
                    layers.background.width(),
                    layers.background.height(),
                    target_width,
                    target_height,
                );
                let foreground_alpha_size = layers.foreground_alpha.as_ref().and_then(|alpha| {
                    let foreground_dpi = layered_foreground_dpi(&options);
                    (foreground_dpi < options.placement_dpi()).then(|| {
                        (
                            ((alpha.width() as f64 * foreground_dpi / options.placement_dpi())
                                .round() as usize)
                                .max(1),
                            ((alpha.height() as f64 * foreground_dpi / options.placement_dpi())
                                .round() as usize)
                                .max(1),
                        )
                    })
                });
                Some(LayerPlan {
                    background_file,
                    background_width,
                    background_height,
                    background_dpi,
                    foreground_alpha_size,
                    foreground_kind: if layers.source_mrc {
                        LayeredForegroundKind::SourceMrc
                    } else if layers.foreground_alpha.is_some() {
                        LayeredForegroundKind::SoftAlpha
                    } else {
                        LayeredForegroundKind::Stencil
                    },
                    foreground_dpi: if layers.source_mrc {
                        // The published selection mask remains on the
                        // rendered page grid. The original JP2's own DPI is
                        // retained later by the PDF affine matrix and is not
                        // this raster's metadata.
                        Some(options.placement_dpi())
                    } else {
                        layers
                            .foreground_alpha
                            .is_some()
                            .then(|| layered_foreground_dpi(&options))
                    },
                })
            }
            _ => None,
        };
        finished.push(FinishedOutput {
            result: output,
            planes,
            final_render,
            layers,
            matched_in_memory: matched_placement.is_some(),
        });
    }
    Ok(FinishedPage {
        outputs: finished,
        metadata,
        options,
        timings,
    })
}

impl FinishedOutput {
    pub(crate) fn matched_in_memory(&self) -> bool {
        self.matched_in_memory
    }

    /// Publishes this output's planes in the CLI's order and records them in
    /// its metadata. A bilevel or layered plane that cannot be published falls
    /// back to the composite with a warning; any other failure is the page's.
    pub(crate) fn publish(&mut self, sink: &mut impl PlaneSink) -> Result<(), NativeError> {
        let result = &mut self.result;
        // A binarized page is already packed bits, and PBM P4 is the same
        // layout: the raster itself decides whether this page has a bilevel
        // primary, so no mode/layer combination has to be re-derived here.
        let mut bilevel_published = false;
        if let Some(binary) = result.image.bilevel().filter(|_| self.planes.bilevel) {
            match sink.publish(&OutputPlane {
                role: PlaneRole::Bilevel,
                pixels: PlanePixels::Bilevel(binary),
                file: PlaneFile::Pbm,
            }) {
                Ok(()) => {
                    result.metadata.bilevel_written = true;
                    bilevel_published = true;
                }
                Err(error) => {
                    sink.discard(PlaneRole::Bilevel);
                    result.metadata.warnings.push(format!(
                        "Bilevel output was not written; the composite fallback was published instead: {error}"
                    ));
                }
            }
        }
        let mut layers_published = false;
        if let Some(plan) = self.layers.take() {
            let layers = result
                .mixed_layers
                .as_ref()
                .expect("a layer plan is made only for an output with layers");
            let foreground_role = plan.foreground_plane(layers).role;
            let published = sink
                .publish(&plan.background_plane(layers))
                .and_then(|()| sink.publish(&plan.foreground_plane(layers)));
            match published {
                Ok(()) => {
                    result.metadata.layered_written = true;
                    result.metadata.layered_foreground_kind = Some(plan.foreground_kind);
                    result.metadata.layered_background_dpi = Some(plan.background_dpi);
                    result.metadata.layered_foreground_dpi = plan.foreground_dpi;
                    layers_published = true;
                }
                Err(error) => {
                    sink.discard(PlaneRole::Background);
                    sink.discard(foreground_role);
                    restore_mixed_composite_from_layers(result);
                    result.metadata.warnings.push(format!(
                        "Mixed layers were not written safely; the composite fallback was published instead: {error}"
                    ));
                }
            }
        }
        let io = |message: String| NativeError::new(NativeErrorCode::Io, message);
        if self.final_render && self.planes.picture_mask {
            if let Some(mask) = result.picture_mask.as_ref() {
                sink.publish(&OutputPlane {
                    role: PlaneRole::PictureMask,
                    pixels: PlanePixels::Bilevel(mask),
                    file: PlaneFile::Pbm,
                })
                .map_err(io)?;
            }
        }
        if self.final_render && self.planes.tone_preservation_alpha {
            if let Some(alpha) = result.tone_preservation_alpha.as_ref() {
                sink.publish(&OutputPlane {
                    role: PlaneRole::TonePreservationAlpha,
                    pixels: PlanePixels::Gray(Cow::Borrowed(alpha)),
                    file: PlaneFile::Png,
                })
                .map_err(io)?;
            }
        }
        // The composite carries the page only when no primary raster did.
        // Deflating and fsyncing a full-resolution copy beside a published
        // PBM or layer pair buys insurance nobody collects.
        if !bilevel_published && !layers_published {
            let pixels = match &result.color_image {
                Some(color) => PlanePixels::Rgb(Cow::Borrowed(color)),
                None => PlanePixels::Gray(result.image.to_gray()),
            };
            sink.publish(&OutputPlane {
                role: PlaneRole::Composite,
                pixels,
                file: PlaneFile::Png,
            })
            .map_err(io)?;
        }
        Ok(())
    }

    /// The facts document-canvas planning reads off this published output.
    pub(crate) fn geometry(
        &self,
        options: &CleanupOptions,
        source_page_index: usize,
        document_canvas: Option<DocumentCanvas>,
    ) -> GeometryOutput {
        let output = &self.result;
        let (paper_width, paper_height) = matched_output_paper_dimensions_for(
            output.metadata.input_width,
            output.metadata.input_height,
            output.metadata.rotation,
            output.metadata.half,
        );
        let optical_content_bounds_x = output
            .metadata
            .content_box
            .is_some()
            .then(|| optical_content_bounds_x_for_output(output))
            .flatten();
        let mut paper_edge_runs = None;
        let fold_side_near_paper_run =
            if self.matched_in_memory || !options.match_page_size || options.ocr_mode {
                0
            } else if let Some(canvas) = document_canvas {
                let fit = canvas_fit_for(
                    output.image.width(),
                    output.image.height(),
                    paper_width,
                    paper_height,
                    output.metadata.content_box.is_some(),
                    options,
                    &canvas,
                );
                if horizontal_overflow_requires_fold_scan(
                    output.image.width(),
                    output.metadata.half,
                    fit,
                ) {
                    paper_edge_runs
                        .get_or_insert_with(|| paper_edge_runs_for_output(output))
                        .0
                } else {
                    0
                }
            } else {
                0
            };
        let outer_near_paper_edge_runs = if !self.matched_in_memory
            && options.match_page_size
            && !options.ocr_mode
            && optical_content_bounds_x.is_some()
        {
            paper_edge_runs
                .get_or_insert_with(|| paper_edge_runs_for_output(output))
                .1
        } else {
            NearPaperEdgeRuns::default()
        };
        GeometryOutput {
            options: options.clone(),
            source_page_index,
            half: output.metadata.half,
            width: output.image.width(),
            height: output.image.height(),
            paper_width,
            paper_height,
            content_detected: output.metadata.content_box.is_some(),
            spread_content_top: spread_content_top_for_output(output),
            optical_content_bounds_x,
            fold_side_near_paper_run,
            outer_near_paper_edge_runs,
        }
    }
}

pub(crate) fn run_page(
    page: &Page,
    canvas_scope: CanvasScope,
    final_render: bool,
    document_canvas: Option<DocumentCanvas>,
    fallback_destination: Option<(&Path, &Path)>,
    page_ink_consistency: Option<PageInkConsistencyContext>,
    cache: &PageCache,
    is_canceled: &AtomicBool,
) -> Result<PageRunResult, Box<dyn Error>> {
    let rendered = render_page(
        page,
        PageRenderRequest::for_page(page, canvas_scope, final_render, page_ink_consistency),
        cache,
        is_canceled,
    )?;
    let destinations = resolve_destinations(page, rendered.outputs.len(), fallback_destination)?;
    let mut written = Vec::with_capacity(destinations.len());
    let write_started = Instant::now();
    let publication_result = (|| -> Result<PageFinishTail, Box<dyn Error>> {
        let FinishedPage {
            mut outputs,
            metadata,
            options,
            mut timings,
        } = finish_page(
            rendered,
            final_render,
            document_canvas,
            destinations
                .iter()
                .map(OutputPlanes::of_destination)
                .collect(),
        )?;
        for (output, destination) in outputs.iter_mut().zip(&destinations) {
            if is_canceled.load(Ordering::Acquire) {
                return Err(crate::engine::cancellation_error().into());
            }
            let mut sink = FilePlaneSink {
                destination,
                published: Vec::new(),
            };
            output.publish(&mut sink)?;
            write_json_atomic(&destination.metadata_path, &output.result.metadata)?;
            let published_path = |role: PlaneRole, path: &Option<PathBuf>| {
                sink.published
                    .contains(&role)
                    .then(|| path.clone())
                    .flatten()
            };
            written.push(WrittenOutput {
                output_path: destination.output_path.clone(),
                metadata_path: destination.metadata_path.clone(),
                bilevel_output_path: published_path(
                    PlaneRole::Bilevel,
                    &destination.bilevel_output_path,
                ),
                background_output_path: published_path(
                    PlaneRole::Background,
                    &destination.background_output_path,
                ),
                foreground_mask_output_path: published_path(
                    PlaneRole::ForegroundMask,
                    &destination.foreground_mask_output_path,
                ),
                foreground_alpha_output_path: published_path(
                    PlaneRole::ForegroundAlpha,
                    &destination.foreground_alpha_output_path,
                ),
                picture_mask_output_path: published_path(
                    PlaneRole::PictureMask,
                    &destination.picture_mask_output_path,
                ),
                tone_preservation_alpha_output_path: published_path(
                    PlaneRole::TonePreservationAlpha,
                    &destination.tone_preservation_alpha_output_path,
                ),
                geometry: output.geometry(&options, page.source_page_index, document_canvas),
                matched_in_memory: output.matched_in_memory(),
            });
        }
        if is_canceled.load(Ordering::Acquire) {
            return Err(crate::engine::cancellation_error().into());
        }
        timings.write_ms += write_started.elapsed().as_secs_f64() * 1_000.0;
        Ok(PageFinishTail { metadata, timings })
    })();
    let PageFinishTail { metadata, timings } = match publication_result {
        Ok(tail) => tail,
        Err(error) => {
            for destination in &destinations {
                let _ = fs::remove_file(&destination.output_path);
                let _ = fs::remove_file(&destination.metadata_path);
                for path in [
                    &destination.bilevel_output_path,
                    &destination.background_output_path,
                    &destination.foreground_mask_output_path,
                    &destination.foreground_alpha_output_path,
                    &destination.picture_mask_output_path,
                    &destination.tone_preservation_alpha_output_path,
                ]
                .into_iter()
                .flatten()
                {
                    let _ = fs::remove_file(path);
                }
            }
            let _ = fs::remove_file(&page.page_metadata_path);
            return Err(error);
        }
    };
    Ok(PageRunResult {
        outputs: written,
        metadata,
        page_metadata_path: page.page_metadata_path.clone(),
        timings,
    })
}

struct PageFinishTail {
    metadata: PageResultMetadata,
    timings: PageStageTimings,
}

/// Publishes an output's planes to its manifest destination's files.
struct FilePlaneSink<'a> {
    destination: &'a PageOutput,
    published: Vec<PlaneRole>,
}

impl FilePlaneSink<'_> {
    fn path(&self, role: PlaneRole) -> Option<&Path> {
        let destination = self.destination;
        match role {
            PlaneRole::Composite => Some(&destination.output_path),
            PlaneRole::Bilevel => destination.bilevel_output_path.as_deref(),
            PlaneRole::Background => destination.background_output_path.as_deref(),
            PlaneRole::ForegroundMask => destination.foreground_mask_output_path.as_deref(),
            PlaneRole::ForegroundAlpha => destination.foreground_alpha_output_path.as_deref(),
            PlaneRole::PictureMask => destination.picture_mask_output_path.as_deref(),
            PlaneRole::TonePreservationAlpha => {
                destination.tone_preservation_alpha_output_path.as_deref()
            }
        }
    }
}

impl PlaneSink for FilePlaneSink<'_> {
    fn publish(&mut self, plane: &OutputPlane<'_>) -> Result<(), String> {
        let path = self
            .path(plane.role)
            .ok_or_else(|| format!("No destination for the {:?} plane", plane.role))?;
        plane.write_atomic(path)?;
        self.published.push(plane.role);
        Ok(())
    }

    fn discard(&mut self, role: PlaneRole) {
        if let Some(path) = self.path(role) {
            let _ = fs::remove_file(path);
        }
        self.published.retain(|published| *published != role);
    }
}

pub(crate) fn run_classification(
    page: &Page,
    canvas_scope: CanvasScope,
    document_prior: Option<crate::split::DocumentPrior>,
    recommend_output_mode: bool,
    plan_content: bool,
    cache: &PageCache,
    is_canceled: &AtomicBool,
) -> Result<PageRunResult, Box<dyn Error>> {
    let (metadata, timings) = classify_page(
        page,
        &page.options,
        page.source_page_index,
        canvas_scope,
        document_prior,
        recommend_output_mode,
        plan_content,
        cache,
        is_canceled,
    )?;
    Ok(PageRunResult {
        outputs: Vec::new(),
        metadata,
        page_metadata_path: page.page_metadata_path.clone(),
        timings,
    })
}

/// Analyzes one page in memory: its layout, content plan and diagnostics.
pub(crate) fn classify_page(
    source: &impl PageRasterSource,
    options: &CleanupOptions,
    source_page_index: usize,
    canvas_scope: CanvasScope,
    document_prior: Option<crate::split::DocumentPrior>,
    recommend_output_mode: bool,
    plan_content: bool,
    cache: &PageCache,
    is_canceled: &AtomicBool,
) -> Result<(PageResultMetadata, PageStageTimings), Box<dyn Error>> {
    if is_canceled.load(Ordering::Acquire) {
        return Err(crate::engine::cancellation_error().into());
    }
    let options = options.clone();
    options.validate().map_err(invalid)?;
    let mut timings = PageStageTimings::default();
    let decode_started = Instant::now();
    // Analyze produces mode-independent diagnostics even when a concrete mode
    // is selected. A concrete final render does not publish or consume those
    // recommendations, so keep that lane grayscale-only.
    let (color_input, gray_input) =
        decode_page_inputs(source, &options, cache, true, recommend_output_mode)?;
    if is_canceled.load(Ordering::Acquire) {
        return Err(crate::engine::cancellation_error().into());
    }
    timings.decode_ms += decode_started.elapsed().as_secs_f64() * 1_000.0;
    let input = color_input
        .as_ref()
        .map(|decoded| &decoded.gray)
        .or(gray_input.as_deref())
        .expect("classification input is initialized");
    let options = options.at_scan_resolution(input.width(), input.height());
    let result = analyze_page_with_color_and_document_prior_cached_cancellable(
        input,
        color_input.as_ref().map(|decoded| &decoded.rgb),
        &options,
        document_prior,
        recommend_output_mode,
        plan_content,
        cache,
        &mut timings,
        is_canceled,
    )
    .map_err(map_analysis_error)?;
    if is_canceled.load(Ordering::Acquire) {
        return Err(crate::engine::cancellation_error().into());
    }
    let page_metadata = PageResultMetadata {
        version: crate::protocol::manifest_v3::VERSION,
        source_page_index,
        layout_classification: result.classification,
        layout_confidence: result.confidence,
        cutter_x_px: result.cutter_x,
        split_seam: result.split_seam,
        rotation_degrees: result.rotation,
        canvas_scope,
        excluded: result.excluded,
        blank_outputs_skipped: 0,
        output_count: if result.excluded {
            0
        } else if result.classification == crate::split::LayoutClassification::TwoPageSpread {
            2
        } else {
            1
        },
        outputs: result.outputs,
        tier1_verdict: result.reconciliation.tier1_verdict,
        reconciled: result.reconciliation.reconciled,
        cluster_agreement: result.reconciliation.cluster_agreement,
        split_diagnostics: result.split_diagnostics,
        document_prior,
        text_axis: result.text_axis,
        recommended_output_mode: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.mode),
        recommended_output_mode_confidence: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.confidence),
        recommended_output_mode_reason: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.reason),
        soft_alpha_foreground_recommendation: result
            .output_mode_recommendation
            .filter(|recommendation| recommendation.mode == OutputMode::Mixed)
            .map(|recommendation| recommendation.prefer_soft_alpha_foreground),
        output_mode_diagnostics: result
            .output_mode_recommendation
            .map(|recommendation| recommendation.diagnostics),
        rotated_width: result.rotated_width,
        rotated_height: result.rotated_height,
        candidate_cutter_ratio: result.candidate_cutter_ratio,
        whitespace_score: result.whitespace_score,
        reconciliation_eligible: matches!(options.layout, crate::LayoutMode::Auto)
            && !options.has_split_evidence()
            && !options.excluded,
        tier1_confidence: if result.reconciliation.reconciled
            || result.reconciliation.cluster_agreement != 0.0
        {
            0.0
        } else {
            result.confidence
        },
        calibration_stroke_width_px: result.calibration_stroke_width_px,
        calibration_x_height_px: result.calibration_x_height_px,
    };
    Ok((page_metadata, timings))
}

/// Restates the resolutions an output reports in its placement's units, which
/// are what place its pixels on the PDF page.
fn report_in_placement_units(metadata: &mut CleanupMetadata, options: &CleanupOptions) {
    let scale = options.placement_scale;
    metadata.source_dpi /= scale;
    metadata.render_dpi /= scale;
    metadata.requested_render_dpi /= scale;
    for event in &mut metadata.warning_events {
        if let CleanupWarningEvent::RenderDpiLimited {
            applied_dpi_thousandths,
            requested_dpi_thousandths,
        } = event
        {
            *applied_dpi_thousandths = quantize_decimal(metadata.render_dpi, 3);
            *requested_dpi_thousandths = quantize_decimal(metadata.requested_render_dpi, 3);
        }
    }
}

/// The soft foreground's resolution in placement units, capped at a physical
/// resolution.
pub(crate) fn layered_foreground_dpi(options: &CleanupOptions) -> f64 {
    options
        .source_dpi()
        .min(options.dpi)
        .min(SOFT_FOREGROUND_MAX_DPI)
        / options.placement_scale
}

pub(crate) fn normalize_trusted_foreground_selection(
    selection: &GrayImage,
    source: &GrayImage,
) -> BinaryImage {
    let high_count = selection
        .data()
        .iter()
        .filter(|&&sample| sample >= 128)
        .count();
    let low_count = selection.data().len().saturating_sub(high_count);
    let high_is_foreground = match high_count.cmp(&low_count) {
        std::cmp::Ordering::Less => true,
        std::cmp::Ordering::Greater => false,
        std::cmp::Ordering::Equal => {
            let mut high_sum = 0u64;
            let mut low_sum = 0u64;
            for y in 0..selection.height() {
                let source_y = y * source.height() / selection.height().max(1);
                for x in 0..selection.width() {
                    let source_x = x * source.width() / selection.width().max(1);
                    let source_sample = u64::from(source.get(
                        source_x.min(source.width().saturating_sub(1)),
                        source_y.min(source.height().saturating_sub(1)),
                    ));
                    if selection.get(x, y) >= 128 {
                        high_sum += source_sample;
                    } else {
                        low_sum += source_sample;
                    }
                }
            }
            high_sum <= low_sum
        }
    };
    BinaryImage::from_fn_parallel(selection.width(), selection.height(), |x, y| {
        (selection.get(x, y) >= 128) == high_is_foreground
    })
}

#[cfg(test)]
mod moved_tests {
    use super::*;
    use crate::engine::resource_planning::{manifest_cache, page_cache_for, PlanningOperation};
    use crate::engine::staged_input::map_raster_error;
    use crate::engine::staged_input::planning_page;
    use crate::io::raster::RasterReadError;
    use crate::protocol::manifest_v3::Page;
    use crate::{CleanupOptions, OutputMode};
    use scan_primitives::GrayImage;
    use std::fs;
    use std::path::Path;

    #[test]
    fn trusted_mrc_foreground_uses_sparse_marks_for_either_soft_mask_polarity() {
        let mut source = GrayImage::new(8, 4, 176);
        for x in 2..6 {
            source.set(x, 2, 18);
        }
        let mut sparse_white = GrayImage::new(8, 4, 0);
        let mut dense_white = GrayImage::new(8, 4, 255);
        for x in 2..6 {
            sparse_white.set(x, 2, 255);
            dense_white.set(x, 2, 0);
        }

        let expected = BinaryImage::from_fn_parallel(8, 4, |x, y| y == 2 && (2..6).contains(&x));
        assert_eq!(
            super::normalize_trusted_foreground_selection(&sparse_white, &source),
            expected
        );
        assert_eq!(
            super::normalize_trusted_foreground_selection(&dense_white, &source),
            expected
        );
    }

    #[test]
    fn render_decode_bypasses_input_cache_while_analyze_retains_it() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-decode-cache-policy-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::io::png::encode_gray(&GrayImage::new(32, 24, 240)).unwrap(),
        )
        .unwrap();
        let page = Page {
            input_path: input,
            analysis_input_path: None,
            analysis_dpi: None,
            trusted_foreground_mask_path: None,
            trusted_mrc_background_path: None,
            source_page_index: 0,
            page_metadata_path: dir.join("page.json"),
            options: CleanupOptions {
                output_mode: OutputMode::Color,
                ..CleanupOptions::default()
            },
            document_prior: None,
            detail_render_plan: None,
            pdf_page: None,
            outputs: Vec::new(),
        };
        let render_cache = manifest_cache(PlanningOperation::Render, None);
        let render_page_cache = page_cache_for(&planning_page(&page), &render_cache).unwrap();
        decode_page_inputs(&page, &page.options, &render_page_cache, false, true).unwrap();
        let render_key =
            crate::cache::StageCacheKey::decoded(&render_page_cache.source, true, &page.options);
        assert!(render_cache
            .lock()
            .unwrap()
            .get::<crate::io::raster::DecodedRaster>(&render_key)
            .is_none());

        let analyze_cache = manifest_cache(PlanningOperation::Analyze, None);
        let analyze_page_cache = page_cache_for(&planning_page(&page), &analyze_cache).unwrap();
        decode_page_inputs(&page, &page.options, &analyze_page_cache, true, true).unwrap();
        assert!(analyze_cache
            .lock()
            .unwrap()
            .get::<crate::io::raster::DecodedRaster>(&render_key)
            .is_some());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn derived_geometry_guardrail_errors_are_too_large() {
        assert_eq!(
            map_analysis_error(crate::engine::render::AnalysisError::TooLarge(
                "Derived raster 100x100 exceeds cleanup guardrails".into(),
            ))
            .code,
            NativeErrorCode::TooLarge,
        );
        assert_eq!(
            map_analysis_error(crate::engine::render::AnalysisError::Invalid(
                "Derived content geometry must be finite".into(),
            ))
            .code,
            NativeErrorCode::InvalidRequest,
        );
        assert_eq!(
            map_analysis_error(crate::engine::render::AnalysisError::Invalid(
                "A request value mentions guardrails".into(),
            ))
            .code,
            NativeErrorCode::InvalidRequest,
        );
    }

    #[test]
    fn raster_io_errors_keep_their_code_and_page_context() {
        let path = Path::new("/tmp/missing-scan-cleanup-input.png");
        let metadata_error = NativeError::new(
            NativeErrorCode::Io,
            format!(
                "Unable to read scan-cleanup input for page 3 ({}): No such file or directory",
                path.display()
            ),
        );
        assert_eq!(metadata_error.code, NativeErrorCode::Io);
        assert!(metadata_error.message.contains("page 3"));
        assert!(metadata_error.message.contains(path.to_str().unwrap()));

        let io_error = map_raster_error(
            RasterReadError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "No such file or directory",
            )),
            path,
            2,
        );
        assert_eq!(io_error.code, NativeErrorCode::Io);
        assert!(io_error.message.contains("page 3"));
        assert!(io_error.message.contains(path.to_str().unwrap()));

        let invalid_error = map_raster_error(
            RasterReadError::Invalid("invalid PNG signature".to_string()),
            path,
            2,
        );
        assert_eq!(invalid_error.code, NativeErrorCode::InvalidRequest);

        let too_large_error = map_raster_error(
            RasterReadError::TooLarge("input exceeds guardrails".to_string()),
            path,
            2,
        );
        assert_eq!(too_large_error.code, NativeErrorCode::TooLarge);
    }

    #[test]
    fn gray_background_uses_pgm_encoding_for_pgm_paths() {
        let path = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-gray-background-{}.pgm",
            std::process::id()
        ));
        let layers = MixedLayers {
            foreground_mask: BinaryImage::new(2, 1),
            foreground_alpha: None,
            background: GrayImage::new(2, 1, 127),
            color_background: None,
            source_mrc: false,
        };
        let plan = LayerPlan {
            background_file: BackgroundFile::of_path(&path),
            background_width: 2,
            background_height: 1,
            background_dpi: 300.0,
            foreground_alpha_size: None,
            foreground_kind: LayeredForegroundKind::Stencil,
            foreground_dpi: None,
        };
        let plane = plan.background_plane(&layers);
        plane.write_atomic(&path).unwrap();
        assert_eq!(plane.encode().unwrap(), fs::read(&path).unwrap());
        let bytes = fs::read(&path).unwrap();
        let header = b"P5\n2 1\n255\n";
        assert!(bytes.starts_with(header));
        assert_eq!(&bytes[header.len()..], &[127, 127]);
        fs::remove_file(path).unwrap();
    }
}
