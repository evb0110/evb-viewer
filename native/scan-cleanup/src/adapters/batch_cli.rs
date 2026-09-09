use crate::adapters::manifest_publication::run_manifest_transaction;
use crate::adapters::single_ocr_cli::{invalid, parse_options};
use crate::cache::{PageCache, StageCacheKey};
use crate::engine::batch_reconciliation::{
    reconcile_classification_batch, ReconciliationAction, ReconciliationCandidate,
    ReconciliationPolicy,
};
use crate::engine::output_geometry::{
    background_canvas_dimensions, background_dimensions_to_publish, canvas_fit_for,
    canvas_placement_warning_events, horizontal_overflow_requires_fold_scan,
    layered_background_dpi, matched_output_paper_dimensions_for, plan_canvas_placements,
    validate_canvas_for_options, CanvasPlacement, GeometryCanvas, GeometryOutput,
    NearPaperEdgeRuns, PLACEMENT_CENTERING_BOUNDS_X,
};
use crate::engine::page_statistics::{
    derive_page_ink_contexts, derive_page_ink_sample, page_needs_ink_sample,
    trusted_selection_is_incomplete,
};
use crate::engine::render::{CleanupRaster, CleanupResult};
use crate::engine::render::{CleanupWarningEvent, WarningExtentUnit};
use crate::engine::resource_planning::{
    manifest_cache, page_cache_for, page_worker_threads, run_page_jobs, run_regular_page_jobs,
};
use crate::engine::resource_planning::{
    CleanupOptionsView, PageDescriptor, PlanningManifest, PlanningOperation,
};
use crate::engine::staged_input::map_raster_error;
use crate::engine::staged_input::{
    acquire_staged_page_input, assert_paths_within_root, preflight_paths,
    release_staged_page_input, with_announced_staged_page_input, LeaseEvent, StagedInputBatch,
    StagedLeaseDescriptor, StagedPageDescriptor, StagedPathPlan,
};
use crate::ink_consistency::PageInkConsistencyContext;
use crate::io::MAX_STREAM_INPUT_BYTES;
use crate::{
    io::{pbm, png, raster},
    pipeline::{
        analyze_page_with_color_and_document_prior_cached, clean_detail_page_with_color,
        clean_page_with_color_and_document_prior_cached, downscale_rgb_to_dimensions,
        CanonicalAnalysisPlane, CleanupMetadata, DetailRenderSources, LayeredForegroundKind,
        MatchedCanvasPolicy,
    },
    protocol::{
        manifest_v3::{
            AnalysisPurpose, CanvasScope, DocumentCanvas, ManifestV3, Operation, Page, PageOutput,
            RenderMode,
        },
        progress::{PageStageTimings, Progress, ProgressEnvelope, ProgressStage},
        result::ResultEnvelope,
    },
    split::LayoutClassification,
    CleanupOptions, OrthogonalRotation, OutputMode,
};
use evb_native_support::{
    bounded_io::deserialize_json_file_bounded, NativeError, NativeErrorCode, NativeErrorEnvelope,
};
use scan_primitives::{BinaryImage, GrayImage, RgbImage};
use serde::Serialize;
use std::{
    collections::HashSet,
    error::Error,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageResultMetadata {
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) outputs: Vec<crate::pipeline::AnalysisOutputMetadata>,
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

pub(crate) struct WrittenOutput {
    output_path: PathBuf,
    metadata_path: PathBuf,
    bilevel_output_path: Option<PathBuf>,
    background_output_path: Option<PathBuf>,
    foreground_mask_output_path: Option<PathBuf>,
    foreground_alpha_output_path: Option<PathBuf>,
    picture_mask_output_path: Option<PathBuf>,
    tone_preservation_alpha_output_path: Option<PathBuf>,
    options: CleanupOptions,
    source_page_index: usize,
    half: crate::pipeline::PageHalf,
    width: usize,
    height: usize,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    spread_content_top: Option<f64>,
    optical_content_bounds_x: Option<(f64, f64)>,
    fold_side_near_paper_run: usize,
    outer_near_paper_edge_runs: NearPaperEdgeRuns,
    matched_in_memory: bool,
}

fn geometry_output(output: &WrittenOutput) -> GeometryOutput {
    GeometryOutput {
        options: output.options.clone(),
        source_page_index: output.source_page_index,
        half: output.half,
        width: output.width,
        height: output.height,
        paper_width: output.paper_width,
        paper_height: output.paper_height,
        content_detected: output.content_detected,
        spread_content_top: output.spread_content_top,
        optical_content_bounds_x: output.optical_content_bounds_x,
        fold_side_near_paper_run: output.fold_side_near_paper_run,
        outer_near_paper_edge_runs: output.outer_near_paper_edge_runs,
    }
}

fn geometry_output_from_cleanup_result(
    output: &CleanupResult,
    options: &CleanupOptions,
) -> GeometryOutput {
    let (paper_width, paper_height) = matched_output_paper_dimensions_for(
        output.metadata.input_width,
        output.metadata.input_height,
        output.metadata.rotation,
        output.metadata.half,
    );
    let (fold_side_near_paper_run, outer_near_paper_edge_runs) = paper_edge_runs_for_output(output);
    GeometryOutput {
        options: options.clone(),
        source_page_index: output.metadata.source_page_index,
        half: output.metadata.half,
        width: output.image.width(),
        height: output.image.height(),
        paper_width,
        paper_height,
        content_detected: output.metadata.content_box.is_some(),
        spread_content_top: spread_content_top_for_output(output),
        optical_content_bounds_x: optical_content_bounds_x_for_output(output),
        fold_side_near_paper_run,
        outer_near_paper_edge_runs,
    }
}

fn geometry_plane_view(
    output: &CleanupResult,
) -> crate::engine::output_geometry::GeometryPlaneView<'_> {
    use crate::engine::output_geometry::{
        GeometryMixedLayersView, GeometryPlaneView, GeometryRasterView,
    };
    GeometryPlaneView {
        image: match &output.image {
            CleanupRaster::Gray(image) => GeometryRasterView::Gray(image),
            CleanupRaster::Bilevel(image) => GeometryRasterView::Bilevel(image),
        },
        color_image: output.color_image.as_ref(),
        picture_mask: output.picture_mask.as_ref(),
        tone_preservation_alpha: output.tone_preservation_alpha.as_ref(),
        mixed_layers: output
            .mixed_layers
            .as_ref()
            .map(|layers| GeometryMixedLayersView {
                foreground_mask: &layers.foreground_mask,
                foreground_alpha: layers.foreground_alpha.as_ref(),
                background: &layers.background,
                color_background: layers.color_background.as_ref(),
            }),
        output_mode: output.metadata.output_mode,
        half: output.metadata.half,
        fallback_content_top: output
            .metadata
            .content_box
            .map(|content| content.y - output.metadata.crop_rect.y)
            .filter(|top| top.is_finite() && *top >= 0.0),
    }
}

fn apply_geometry_raster(
    output: &mut CleanupResult,
    image: crate::engine::output_geometry::GeometryRaster,
) {
    use crate::engine::output_geometry::GeometryRaster;
    output.image = match image {
        GeometryRaster::Gray(image) => CleanupRaster::Gray(image),
        GeometryRaster::Bilevel(image) => CleanupRaster::Bilevel(image),
    };
}

fn take_geometry_raster(
    output: &mut CleanupResult,
) -> crate::engine::output_geometry::GeometryRaster {
    match std::mem::replace(
        &mut output.image,
        CleanupRaster::Gray(GrayImage::new(1, 1, 255)),
    ) {
        CleanupRaster::Gray(image) => crate::engine::output_geometry::GeometryRaster::Gray(image),
        CleanupRaster::Bilevel(image) => {
            crate::engine::output_geometry::GeometryRaster::Bilevel(image)
        }
    }
}

fn take_geometry_layers(
    output: &mut CleanupResult,
) -> Option<crate::engine::output_geometry::GeometryMixedLayers> {
    output.mixed_layers.take().map(
        |layers| crate::engine::output_geometry::GeometryMixedLayers {
            foreground_mask: layers.foreground_mask,
            foreground_alpha: layers.foreground_alpha,
            background: layers.background,
            color_background: layers.color_background,
            source_mrc: layers.source_mrc,
        },
    )
}

fn restore_geometry_layers(
    output: &mut CleanupResult,
    layers: Option<crate::engine::output_geometry::GeometryMixedLayers>,
) {
    output.mixed_layers = layers.map(|layers| crate::engine::render::MixedLayers {
        foreground_mask: layers.foreground_mask,
        foreground_alpha: layers.foreground_alpha,
        background: layers.background,
        color_background: layers.color_background,
        source_mrc: layers.source_mrc,
    });
}

const MAX_DETAIL_METADATA_BYTES: usize = 16 * 1024 * 1024;
const SOFT_FOREGROUND_MAX_DPI: f64 = 300.0;
type DecodedPageInputs = (Option<Arc<raster::DecodedRaster>>, Option<Arc<GrayImage>>);

pub(crate) fn match_primary_raster_in_memory(
    output: &mut CleanupResult,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) {
    let intrinsic_width = output.image.width();
    let intrinsic_height = output.image.height();
    let image = take_geometry_raster(output);
    let color_image = output.color_image.take();
    let (image, color_image) = crate::engine::output_geometry::compose_primary_raster(
        image,
        color_image,
        placement,
        canvas,
    );
    apply_geometry_raster(output, image);
    output.color_image = color_image;
    output.metadata.intrinsic_raster_width = Some(intrinsic_width);
    output.metadata.intrinsic_raster_height = Some(intrinsic_height);
    output.metadata.output_width = placement.content_width;
    output.metadata.output_height = placement.content_height;
    output.metadata.pdf_image_placement = None;
}

pub(crate) fn match_picture_mask_in_memory(
    output: &mut CleanupResult,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) {
    output.picture_mask = crate::engine::output_geometry::compose_picture_mask(
        output.picture_mask.take(),
        placement,
        canvas,
    );
}

pub(crate) fn match_tone_preservation_alpha_in_memory(
    output: &mut CleanupResult,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) {
    output.tone_preservation_alpha =
        crate::engine::output_geometry::compose_tone_preservation_alpha(
            output.tone_preservation_alpha.take(),
            placement,
            canvas,
        );
}

pub(crate) fn restore_mixed_composite_from_layers(output: &mut CleanupResult) {
    let layers = output.mixed_layers.as_ref().map(|layers| {
        crate::engine::output_geometry::GeometryMixedLayersView {
            foreground_mask: &layers.foreground_mask,
            foreground_alpha: layers.foreground_alpha.as_ref(),
            background: &layers.background,
            color_background: layers.color_background.as_ref(),
        }
    });
    if let Some((image, color_image)) =
        crate::engine::output_geometry::restore_mixed_composite(layers)
    {
        apply_geometry_raster(output, image);
        output.color_image = color_image;
    }
}

pub(crate) fn match_layers_in_memory(
    output: &mut CleanupResult,
    options: &CleanupOptions,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) {
    let layers = take_geometry_layers(output);
    let picture_mask = output.picture_mask.as_ref();
    let layers = crate::engine::output_geometry::compose_layers(
        picture_mask,
        layers,
        options,
        placement,
        canvas,
    );
    restore_geometry_layers(output, layers);
}

fn paper_edge_runs_for_output(output: &CleanupResult) -> (usize, NearPaperEdgeRuns) {
    let planes = geometry_plane_view(output);
    crate::engine::output_geometry::paper_edge_runs(&planes)
}

pub(crate) fn optical_content_bounds_x_for_output(output: &CleanupResult) -> Option<(f64, f64)> {
    let planes = geometry_plane_view(output);
    crate::engine::output_geometry::planes_optical_content_bounds_x(&planes)
}

pub(crate) fn spread_content_top_for_output(output: &CleanupResult) -> Option<f64> {
    let planes = geometry_plane_view(output);
    crate::engine::output_geometry::spread_content_top(&planes)
}

fn geometry_canvas(canvas: &DocumentCanvas) -> GeometryCanvas {
    GeometryCanvas {
        width_points: canvas.width_points,
        height_points: canvas.height_points,
        width_px: canvas.width_px,
        height_px: canvas.height_px,
    }
}

fn apply_canvas_metadata(
    metadata: &mut CleanupMetadata,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) {
    let facts = crate::engine::output_geometry::canvas_metadata_facts(placement, canvas);
    metadata.soft_margins_pixels = facts.soft_margins_pixels;
    metadata.applied_margins = placement
        .requested_margins
        .map(|margin| margin as f64)
        .into();
    metadata.uniform_canvas = true;
    metadata.canvas_policy = MatchedCanvasPolicy::StrictMaximum;
    metadata.canvas_overflow = facts.canvas_overflow;
    metadata.matched_canvas_target_width = Some(canvas.width_px);
    metadata.matched_canvas_target_height = Some(canvas.height_px);
    metadata.matched_canvas_target_width_points = Some(canvas.width_points);
    metadata.matched_canvas_target_height_points = Some(canvas.height_points);
    metadata.matched_canvas_content_width = Some(placement.content_width);
    metadata.matched_canvas_content_height = Some(placement.content_height);
    metadata.matched_canvas_optical_placement = placement.optical_content_centered;
    metadata.matched_canvas_optical_content_left =
        placement.optical_content_bounds_x.map(|(left, _)| left);
    metadata.matched_canvas_optical_content_right =
        placement.optical_content_bounds_x.map(|(_, right)| right);
    metadata.matched_canvas_intrinsic_overflow_left = placement.intrinsic_overflow_left;
    metadata.matched_canvas_intrinsic_overflow_right = placement.intrinsic_overflow_right;
    metadata.matched_canvas_intrinsic_overflow_top = placement.intrinsic_overflow_top;
    metadata.fold_clip_left = placement.fold_clip_left;
    metadata.fold_clip_right = placement.fold_clip_right;
    metadata.canvas_width = canvas.width_px;
    metadata.canvas_height = canvas.height_px;
    metadata.placement_offset_x = placement.left;
    metadata.placement_offset_y = placement.top;
    metadata.warning_events.extend(
        canvas_placement_warning_events(placement, canvas, metadata.content_box.is_some())
            .into_iter()
            .map(canvas_warning_to_protocol),
    );
}

fn canvas_warning_to_protocol(
    warning: crate::engine::output_geometry::CanvasWarning,
) -> CleanupWarningEvent {
    use crate::engine::output_geometry::CanvasWarning;
    match warning {
        CanvasWarning::MatchedCanvasContentFitted {
            content_width,
            content_height,
            inner_width,
            inner_height,
            document_canvas_width,
            document_canvas_height,
            ..
        } => CleanupWarningEvent::MatchedCanvasContentFitted {
            unit: WarningExtentUnit::Px,
            content_width,
            content_height,
            inner_width,
            inner_height,
            document_canvas_width,
            document_canvas_height,
        },
        CanvasWarning::MatchedCanvasMarginsReduced => {
            CleanupWarningEvent::MatchedCanvasMarginsReduced
        }
        CanvasWarning::MatchedCanvasMarginsUnavailable => {
            CleanupWarningEvent::MatchedCanvasMarginsUnavailable
        }
        CanvasWarning::MatchedCanvasPaperDownscaled {
            paper_scale,
            document_canvas_width,
            document_canvas_height,
            paper_width,
            paper_height,
            ..
        } => CleanupWarningEvent::MatchedCanvasPaperDownscaled {
            unit: WarningExtentUnit::Px,
            scale_percent_tenths: crate::pipeline::quantize_decimal(paper_scale * 100.0, 1),
            document_canvas_width,
            document_canvas_height,
            paper_width,
            paper_height,
        },
        CanvasWarning::MatchedCanvasOpticalCenteringFallback => {
            CleanupWarningEvent::MatchedCanvasOpticalCenteringFallback
        }
        CanvasWarning::MatchedCanvasIntrinsicOverflow { left_px, right_px } => {
            CleanupWarningEvent::MatchedCanvasIntrinsicOverflow { left_px, right_px }
        }
        CanvasWarning::MatchedCanvasSpreadHeadroomTrimmed { top_px } => {
            CleanupWarningEvent::MatchedCanvasSpreadHeadroomTrimmed { top_px }
        }
        CanvasWarning::MatchedCanvasFoldColumnsDiscarded {
            left_columns,
            right_columns,
        } => CleanupWarningEvent::MatchedCanvasFoldColumnsDiscarded {
            left_columns,
            right_columns,
        },
    }
}

fn planning_page(page: &Page) -> PageDescriptor {
    PageDescriptor {
        input_path: page.input_path.clone(),
        source_page_index: page.source_page_index,
        stream_input: fs::metadata(&page.input_path)
            .is_ok_and(|metadata| !metadata.file_type().is_file()),
        trusted_foreground_mask_path: page.trusted_foreground_mask_path.clone(),
        trusted_mrc_background_path: page.trusted_mrc_background_path.clone(),
        options: CleanupOptionsView {
            max_pixels: page.options.max_pixels,
            max_dimension: page.options.max_dimension,
            output_mode: page.options.output_mode,
            source_has_bilevel_layer: page.options.source_has_bilevel_layer,
            thickness: page.options.thickness,
        },
    }
}

fn planning_page_from_staged(
    original: &PageDescriptor,
    staged: &StagedPageDescriptor,
) -> PageDescriptor {
    PageDescriptor {
        input_path: staged.input_path.clone(),
        stream_input: staged.stream_input,
        ..original.clone()
    }
}

fn page_from_staged(page: &Page, staged: &PageDescriptor) -> Page {
    let mut translated = page.clone();
    translated.input_path = staged.input_path.clone();
    translated
}

fn staged_page_descriptor(page: &Page) -> StagedPageDescriptor {
    let stream_input =
        fs::metadata(&page.input_path).is_ok_and(|metadata| !metadata.file_type().is_file());
    staged_page_descriptor_with_stream(page, stream_input)
}

fn staged_page_descriptor_with_stream(page: &Page, stream_input: bool) -> StagedPageDescriptor {
    StagedPageDescriptor {
        input_path: page.input_path.clone(),
        metadata_path: page.page_metadata_path.clone(),
        source_page_index: page.source_page_index,
        max_bytes: MAX_STREAM_INPUT_BYTES,
        stream_input,
    }
}

fn staged_input_batch(manifest: &ManifestV3) -> StagedInputBatch {
    StagedInputBatch {
        raster_window: manifest.raster_window,
        pages: manifest.pages.iter().map(staged_page_descriptor).collect(),
    }
}

fn run_one_staged_page_job<T, F>(
    manifest: &ManifestV3,
    index: usize,
    stream_input: bool,
    task: F,
) -> Result<T, Box<dyn Error>>
where
    T: Send,
    F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync,
{
    let batch = StagedInputBatch {
        raster_window: 1,
        pages: vec![staged_page_descriptor_with_stream(
            &manifest.pages[index],
            stream_input,
        )],
    };
    let mut results = crate::engine::staged_input::run_stream_page_jobs(&batch, |(_, staged)| {
        let original = planning_page(&manifest.pages[index]);
        let descriptor = planning_page_from_staged(&original, staged);
        task((index, &descriptor))
    })?;
    results.pop().ok_or_else(|| {
        NativeError::new(
            NativeErrorCode::NativeFailure,
            "Staged scan-cleanup page job produced no result",
        )
        .into()
    })
}

fn staged_path_plan(manifest: &ManifestV3) -> StagedPathPlan {
    StagedPathPlan {
        input_paths: manifest
            .input_paths()
            .into_iter()
            .map(Path::to_path_buf)
            .collect(),
        destination_paths: manifest
            .destination_paths()
            .into_iter()
            .map(Path::to_path_buf)
            .collect(),
    }
}

fn staged_lease(manifest: &ManifestV3, page: &Page) -> StagedLeaseDescriptor {
    StagedLeaseDescriptor {
        input_path: page.input_path.clone(),
        page_number: page.source_page_index.saturating_add(1),
        total_pages: manifest.pages.len(),
        enabled: manifest.staged_input_window.is_some(),
    }
}

fn planning_operation(operation: Operation) -> PlanningOperation {
    match operation {
        Operation::Analyze => PlanningOperation::Analyze,
        Operation::Render => PlanningOperation::Render,
    }
}

impl PlanningManifest for ManifestV3 {
    fn operation(&self) -> PlanningOperation {
        planning_operation(self.operation)
    }

    fn host_memory_bytes(&self) -> Option<u64> {
        self.host_memory_bytes
    }

    fn staged_input_window(&self) -> Option<usize> {
        self.staged_input_window
    }

    fn staged_input_peak_pixels(&self) -> Option<u64> {
        self.staged_input_peak_pixels
    }

    fn page_count(&self) -> usize {
        self.pages.len()
    }

    fn page(&self, index: usize) -> PageDescriptor {
        planning_page(&self.pages[index])
    }

    fn run_stream_page_jobs<T, F>(&self, task: F) -> Result<Vec<T>, Box<dyn Error>>
    where
        T: Send,
        F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync,
    {
        let batch = staged_input_batch(self);
        crate::engine::staged_input::run_stream_page_jobs(&batch, |(index, staged)| {
            let original = planning_page(&self.pages[index]);
            let descriptor = planning_page_from_staged(&original, staged);
            task((index, &descriptor))
        })
    }
}

fn remove_written_output_files(output: &WrittenOutput) {
    for path in [
        Some(&output.output_path),
        Some(&output.metadata_path),
        output.bilevel_output_path.as_ref(),
        output.background_output_path.as_ref(),
        output.foreground_mask_output_path.as_ref(),
        output.foreground_alpha_output_path.as_ref(),
        output.picture_mask_output_path.as_ref(),
        output.tone_preservation_alpha_output_path.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        let _ = fs::remove_file(path);
    }
}

fn match_page_sizes(
    outputs: &[&WrittenOutput],
    document_canvas: Option<crate::protocol::manifest_v3::DocumentCanvas>,
) -> Result<(), Box<dyn Error>> {
    let eligible = outputs
        .iter()
        .copied()
        .filter(|output| {
            output.options.match_page_size && !output.options.ocr_mode && !output.matched_in_memory
        })
        .collect::<Vec<_>>();
    if eligible.is_empty() {
        return Ok(());
    }
    let Some(canvas) = document_canvas.map(|canvas| geometry_canvas(&canvas)) else {
        return Err(NativeError::new(
            NativeErrorCode::InvalidRequest,
            "Matched page size requires a documentCanvas plan; the manifest carried none",
        )
        .into());
    };
    let geometry_outputs = eligible
        .iter()
        .map(|output| geometry_output(output))
        .collect::<Vec<_>>();
    let placements = plan_canvas_placements(&geometry_outputs, &canvas);

    for (output, placement) in eligible.into_iter().zip(placements) {
        let repad_result = (|| -> Result<(), Box<dyn Error>> {
            validate_canvas_for_options(canvas.width_px, canvas.height_px, &output.options)?;
            let mut metadata: CleanupMetadata =
                serde_json::from_slice(&fs::read(&output.metadata_path)?)?;
            metadata.intrinsic_raster_width.get_or_insert(output.width);
            metadata
                .intrinsic_raster_height
                .get_or_insert(output.height);
            apply_canvas_metadata(&mut metadata, placement, &canvas);
            write_json_atomic(&output.metadata_path, &metadata)?;
            Ok(())
        })();
        if let Err(error) = repad_result {
            remove_written_output_files(output);
            return Err(error);
        }
    }
    Ok(())
}

const MAX_MANIFEST_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Eq, PartialEq)]
enum ScanCleanupCliInvocation {
    Direct {
        input: PathBuf,
        output: PathBuf,
        metadata: PathBuf,
        options: Option<String>,
        ocr_mode: bool,
        experimental_auto_dewarp: bool,
    },
    Manifest {
        path: PathBuf,
        allowed_path_root: Option<PathBuf>,
    },
}

fn cli_value<'a>(
    args: &'a [String],
    index: &mut usize,
    flag: &str,
) -> Result<&'a str, NativeError> {
    let value = args
        .get(*index + 1)
        .filter(|value| !value.is_empty() && !value.starts_with("--"))
        .ok_or_else(|| invalid(format!("{flag} requires a value")))?;
    *index += 2;
    Ok(value)
}

fn parse_cli_args(args: &[String]) -> Result<ScanCleanupCliInvocation, NativeError> {
    let mut seen = HashSet::new();
    let mut manifest = None;
    let mut allowed_path_root = None;
    let mut input = None;
    let mut output = None;
    let mut metadata = None;
    let mut options = None;
    let mut ocr_mode = false;
    let mut experimental_auto_dewarp = false;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !flag.starts_with("--") {
            return Err(invalid(format!(
                "Unexpected positional argument {}",
                args[index]
            )));
        }
        if !seen.insert(flag) {
            return Err(invalid(format!("Duplicate argument {flag}")));
        }
        match flag {
            "--manifest" => manifest = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--allowed-path-root" => {
                allowed_path_root = Some(PathBuf::from(cli_value(args, &mut index, flag)?))
            }
            "--input" => input = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--output" => output = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--metadata" => metadata = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--options" => options = Some(cli_value(args, &mut index, flag)?.to_string()),
            "--ocr-mode" => {
                ocr_mode = true;
                index += 1;
            }
            "--experimental-auto-dewarp" => {
                experimental_auto_dewarp = true;
                index += 1;
            }
            _ => return Err(invalid(format!("Unknown argument {flag}"))),
        }
    }

    if let Some(path) = manifest {
        if input.is_some()
            || output.is_some()
            || metadata.is_some()
            || options.is_some()
            || ocr_mode
            || experimental_auto_dewarp
        {
            return Err(invalid(
                "--manifest cannot be combined with direct-mode arguments",
            ));
        }
        return Ok(ScanCleanupCliInvocation::Manifest {
            path,
            allowed_path_root,
        });
    }

    if allowed_path_root.is_some() {
        return Err(invalid("--allowed-path-root requires --manifest"));
    }

    Ok(ScanCleanupCliInvocation::Direct {
        input: input.ok_or_else(|| invalid("Missing required argument --input"))?,
        output: output.ok_or_else(|| invalid("Missing required argument --output"))?,
        metadata: metadata.ok_or_else(|| invalid("Missing required argument --metadata"))?,
        options,
        ocr_mode,
        experimental_auto_dewarp,
    })
}

pub fn run(args: impl IntoIterator<Item = String>) -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = args.into_iter().collect();
    let (input, output, metadata, options, ocr_mode, experimental_auto_dewarp) =
        match parse_cli_args(&args)? {
            ScanCleanupCliInvocation::Direct {
                input,
                output,
                metadata,
                options,
                ocr_mode,
                experimental_auto_dewarp,
            } => (
                input,
                output,
                metadata,
                options,
                ocr_mode,
                experimental_auto_dewarp,
            ),
            ScanCleanupCliInvocation::Manifest {
                path,
                allowed_path_root,
            } => return run_manifest(&path, allowed_path_root.as_deref()),
        };
    let mut options = options
        .as_deref()
        .map(parse_options)
        .transpose()?
        .unwrap_or_default();
    if ocr_mode {
        options.ocr_mode = true;
    }
    if experimental_auto_dewarp {
        options.experimental.auto_dewarp = true;
    }
    let page = Page {
        input_path: input,
        analysis_input_path: None,
        analysis_dpi: None,
        trusted_foreground_mask_path: None,
        trusted_mrc_background_path: None,
        outputs: Vec::new(),
        source_page_index: 0,
        page_metadata_path: metadata.clone(),
        options,
        document_prior: None,
        detail_render_plan: None,
    };
    let cache = manifest_cache(PlanningOperation::Render, None);
    let page_cache = page_cache_for(&planning_page(&page), &cache)?;
    run_page(
        &page,
        CanvasScope::Page,
        false,
        None,
        Some((&output, &metadata)),
        None,
        &page_cache,
    )
    .map(|_| ())
}

fn run_manifest(path: &Path, allowed_path_root: Option<&Path>) -> Result<(), Box<dyn Error>> {
    let manifest: ManifestV3 =
        deserialize_json_file_bounded(path, MAX_MANIFEST_BYTES, "v3 batch manifest")?;
    manifest.validate_for_execution()?;
    if let Some(root) = allowed_path_root {
        assert_paths_within_root(&staged_path_plan(&manifest), root)?;
    }
    preflight_paths(&staged_path_plan(&manifest))?;
    let total = manifest.pages.len();
    let result = run_manifest_transaction(&manifest, || run_manifest_inner(&manifest));
    match result {
        Ok(()) => {
            println!(
                "{}",
                serde_json::to_string(&ResultEnvelope::success(total, total))?
            );
            Ok(())
        }
        Err(error) => {
            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
            println!(
                "{}",
                serde_json::to_string(&ResultEnvelope::failure(&envelope))?
            );
            Err(error)
        }
    }
}

fn map_page_error(error: &(dyn Error + 'static)) -> NativeError {
    let envelope = NativeErrorEnvelope::from_error(error);
    NativeError::new(envelope.code, envelope.message)
}

fn aspect_ratio_matches(
    input_width: usize,
    input_height: usize,
    reference_width: usize,
    reference_height: usize,
) -> bool {
    let input_aspect = input_width as f64 / input_height.max(1) as f64;
    let reference_aspect = reference_width as f64 / reference_height.max(1) as f64;
    !matches!(
        (input_aspect / reference_aspect - 1.0)
            .abs()
            .partial_cmp(&0.02),
        Some(std::cmp::Ordering::Greater)
    )
}

fn reconciliation_candidates(results: &[PageRunResult]) -> Vec<ReconciliationCandidate> {
    results
        .iter()
        .map(|result| ReconciliationCandidate {
            cutter_x: result.metadata.cutter_x_px,
            tier1_verdict: result.metadata.tier1_verdict,
            tier1_confidence: result.metadata.tier1_confidence,
            candidate_cutter_ratio: result.metadata.candidate_cutter_ratio,
            whitespace_score: result.metadata.whitespace_score,
            rotated_width: result.metadata.rotated_width,
            rotated_height: result.metadata.rotated_height,
            calibration_stroke_width_px: result.metadata.calibration_stroke_width_px,
            calibration_x_height_px: result.metadata.calibration_x_height_px,
            reconciliation_eligible: result.metadata.reconciliation_eligible,
            excluded: result.metadata.excluded,
            document_prior: result.metadata.document_prior,
        })
        .collect()
}

fn preserve_tier1_provenance_after_rerun(
    metadata: &mut PageResultMetadata,
    tier1: crate::engine::batch_reconciliation::Tier1Provenance,
    prior: crate::split::DocumentPrior,
) {
    metadata.tier1_verdict = tier1.verdict;
    metadata.tier1_confidence = tier1.confidence;
    metadata.candidate_cutter_ratio = tier1.candidate_cutter_ratio;
    metadata.whitespace_score = tier1.whitespace_score;
    metadata.reconciled = metadata.layout_classification != tier1.verdict;
    metadata.cluster_agreement = if metadata.layout_classification == prior.dominant_layout {
        prior.agreement_strength
    } else {
        -prior.agreement_strength
    };
    metadata.document_prior = Some(prior);
}

fn finish_staged_rerun<T>(
    rerun_result: Result<T, Box<dyn Error>>,
    release_result: Result<(), NativeError>,
) -> Result<T, Box<dyn Error>> {
    match release_result {
        Ok(()) => rerun_result,
        Err(release_error) => match rerun_result {
            Ok(_) => Err(Box::new(release_error)),
            Err(rerun_error) => {
                eprintln!("Unable to release reconciliation staged input: {release_error}");
                Err(rerun_error)
            }
        },
    }
}

fn apply_reconciliation_actions<F>(
    page_results: &mut [PageRunResult],
    actions: &[ReconciliationAction],
    mut rerun: F,
) -> Result<(), Box<dyn Error>>
where
    F: FnMut(usize, crate::split::DocumentPrior) -> Result<PageRunResult, Box<dyn Error>>,
{
    for action in actions {
        match *action {
            ReconciliationAction::Rerun {
                index,
                prior,
                tier1,
            } => {
                let mut rerun_result = rerun(index, prior)?;
                rerun_result.timings += page_results[index].timings;
                page_results[index] = rerun_result;
                preserve_tier1_provenance_after_rerun(
                    &mut page_results[index].metadata,
                    tier1,
                    prior,
                );
            }
            ReconciliationAction::Update {
                index,
                prior,
                classification,
                confidence,
                cutter_x,
                tier1_verdict,
                reconciled,
                cluster_agreement,
                output_count,
            } => {
                let metadata = &mut page_results[index].metadata;
                metadata.layout_classification = classification;
                metadata.layout_confidence = confidence;
                metadata.cutter_x_px = cutter_x;
                metadata.tier1_verdict = tier1_verdict;
                metadata.reconciled = reconciled;
                metadata.cluster_agreement = cluster_agreement;
                metadata.document_prior = Some(prior);
                metadata.output_count = output_count;
                if classification != LayoutClassification::TwoPageSpread {
                    metadata.split_seam = None;
                }
                if reconciled {
                    metadata.outputs.clear();
                }
            }
        }
    }
    Ok(())
}

fn run_manifest_inner(manifest: &ManifestV3) -> Result<(), Box<dyn Error>> {
    write_progress(Progress {
        stage: ProgressStage::Started,
        completed_pages: 0,
        total_pages: manifest.pages.len(),
        page_number: None,
        output_paths: None,
        classification: None,
        confidence: None,
        cutter_x_px: None,
        tier1_verdict: None,
        reconciled: None,
        cluster_agreement: None,
        document_prior: None,
        text_axis: None,
        stage_timings: None,
        recommended_output_mode: None,
        recommended_output_mode_confidence: None,
        recommended_output_mode_reason: None,
        soft_alpha_foreground_recommendation: None,
        output_mode_diagnostics: None,
    })?;
    let cache = manifest_cache(
        planning_operation(manifest.operation),
        manifest.host_memory_bytes,
    );
    let total_pages = manifest.pages.len();
    // Pages finish out of order under the worker pool, but the progress stream is
    // a monotone per-page sequence, so each page's event waits for its
    // predecessors before it is published.
    let pending_progress = Mutex::new((
        manifest.pages.iter().map(|_| None).collect::<Vec<_>>(),
        0usize,
    ));
    let report_page = |index: usize, progress: Progress| -> Result<(), NativeError> {
        let mut state = pending_progress.lock().map_err(|_| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to publish scan-cleanup page progress",
            )
        })?;
        state.0[index] = Some(progress);
        loop {
            let cursor = state.1;
            let Some(published) = state.0.get_mut(cursor).and_then(Option::take) else {
                break;
            };
            state.1 = cursor + 1;
            write_progress(published).map_err(|error| {
                NativeError::new(
                    NativeErrorCode::NativeFailure,
                    format!("Unable to publish scan-cleanup page progress: {error}"),
                )
            })?;
        }
        Ok(())
    };
    let announce_lease = |event: LeaseEvent, page_number: usize, total: usize| {
        let stage = match event {
            LeaseEvent::Required => ProgressStage::PageInputRequired,
            LeaseEvent::Released => ProgressStage::PageInputReleased,
        };
        write_progress(Progress::page_input(stage, page_number, total)).map_err(|error| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                format!("Unable to publish scan-cleanup staged input lease: {error}"),
            )
        })
    };
    let analyzing = manifest.operation == Operation::Analyze;
    let page_ink_contexts = if analyzing {
        vec![None; manifest.pages.len()]
    } else {
        let planning_pages = manifest.pages.iter().map(planning_page).collect::<Vec<_>>();
        let samples = if planning_pages.iter().any(page_needs_ink_sample) {
            let worker_threads = page_worker_threads(manifest)?;
            let processing_threads = std::thread::available_parallelism().map_or(1, usize::from);
            run_regular_page_jobs(
                manifest,
                |(_, page)| derive_page_ink_sample(page),
                worker_threads,
                processing_threads,
            )?
        } else {
            vec![None; planning_pages.len()]
        };
        derive_page_ink_contexts(&samples)
    };
    let plan_content = manifest.analysis_purpose == AnalysisPurpose::PagePlan;
    let run_analysis =
        |(index, descriptor): (usize, &PageDescriptor)| -> Result<PageRunResult, NativeError> {
            let page = page_from_staged(&manifest.pages[index], descriptor);
            let lease = staged_lease(manifest, &page);
            let result = with_announced_staged_page_input(&lease, &announce_lease, || {
                let page_cache = page_cache_for(descriptor, &cache)?;
                run_classification(
                    &page,
                    manifest.canvas_scope,
                    page.document_prior,
                    true,
                    plan_content,
                    &page_cache,
                )
                .map_err(|error| map_page_error(error.as_ref()))
            })?;
            // Publish the page's independent verdict immediately. Document
            // reconciliation may revise it after the batch finishes, at which
            // point PageComplete replaces this provisional result. Keeping the
            // useful fields off PageAnalyzed forced every thumbnail to spin until
            // the slowest page in a large document had finished.
            let mut progress = page_complete_progress(&result, index, total_pages);
            progress.stage = ProgressStage::PageAnalyzed;
            progress.output_paths = None;
            report_page(index, progress)?;
            Ok(result)
        };
    let run_one =
        |(index, descriptor): (usize, &PageDescriptor)| -> Result<PageRunResult, NativeError> {
            let page = page_from_staged(&manifest.pages[index], descriptor);
            let page_cache = page_cache_for(descriptor, &cache)?;
            let result = run_page(
                &page,
                manifest.canvas_scope,
                manifest.render_mode == RenderMode::Final,
                manifest.document_canvas,
                None,
                page_ink_contexts[index],
                &page_cache,
            )
            .map_err(|error| map_page_error(error.as_ref()))?;
            report_page(index, page_complete_progress(&result, index, total_pages))?;
            Ok(result)
        };
    let mut page_results = if analyzing {
        run_page_jobs(manifest, run_analysis)?
    } else {
        run_page_jobs(manifest, run_one)?
    };

    // Reconciliation only ever revises classification-pass results; a render pass
    // has already published its pages by the time it returns.
    if analyzing {
        let candidates = reconciliation_candidates(&page_results);
        let actions = reconcile_classification_batch(
            &candidates,
            ReconciliationPolicy {
                minimum_confidence: 0.60,
                minimum_support: 2,
            },
        );
        let rerun = |index, prior| {
            let page = &manifest.pages[index];
            let lease = staged_lease(manifest, page);
            let stream_input = planning_page(page).stream_input;
            acquire_staged_page_input(&lease, &announce_lease)?;
            let rerun_result =
                run_one_staged_page_job(manifest, index, stream_input, |(_, descriptor)| {
                    let page = page_from_staged(&manifest.pages[index], descriptor);
                    let page_cache = page_cache_for(descriptor, &cache)?;
                    run_classification(
                        &page,
                        manifest.canvas_scope,
                        Some(prior),
                        manifest.operation == Operation::Analyze
                            || page.options.output_mode == crate::OutputMode::Auto,
                        manifest.analysis_purpose == AnalysisPurpose::PagePlan,
                        &page_cache,
                    )
                    .map_err(|error| map_page_error(error.as_ref()))
                });
            let released = release_staged_page_input(&lease, &announce_lease);
            finish_staged_rerun(rerun_result, released)
        };
        apply_reconciliation_actions(&mut page_results, &actions, rerun)?;
    }
    for (index, page_result) in page_results.iter().enumerate() {
        write_json_atomic(&page_result.page_metadata_path, &page_result.metadata)?;
        if analyzing {
            write_progress(page_complete_progress(page_result, index, total_pages))?;
        }
    }
    let written_outputs = page_results
        .iter()
        .flat_map(|page_result| page_result.outputs.iter())
        .collect::<Vec<_>>();
    match_page_sizes(&written_outputs, manifest.document_canvas)?;
    write_progress(Progress {
        stage: ProgressStage::Completed,
        completed_pages: manifest.pages.len(),
        total_pages: manifest.pages.len(),
        page_number: None,
        output_paths: None,
        classification: None,
        confidence: None,
        cutter_x_px: None,
        tier1_verdict: None,
        reconciled: None,
        cluster_agreement: None,
        document_prior: None,
        text_axis: None,
        stage_timings: None,
        recommended_output_mode: None,
        recommended_output_mode_confidence: None,
        recommended_output_mode_reason: None,
        soft_alpha_foreground_recommendation: None,
        output_mode_diagnostics: None,
    })?;
    Ok(())
}

pub(crate) fn write_progress(progress: Progress) -> Result<(), Box<dyn Error>> {
    println!(
        "{}",
        serde_json::to_string(&ProgressEnvelope::new(progress))?
    );
    Ok(())
}

mod page_workflow {
    use super::*;

    pub(crate) fn map_image_error(message: String) -> NativeError {
        let code = if message.contains("guardrails") {
            NativeErrorCode::TooLarge
        } else {
            NativeErrorCode::InvalidRequest
        };
        NativeError::new(code, message)
    }

    pub(crate) fn write_gray_layer_background(
        path: &Path,
        image: &GrayImage,
    ) -> Result<(), String> {
        if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("ppm"))
        {
            raster::write_gray_ppm_atomic(path, image)
        } else if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pgm"))
        {
            raster::write_gray_pgm_atomic(path, image)
        } else {
            png::write_gray_atomic(path, image)
        }
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
        page: &Page,
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
                let decoded = Arc::new(
                    raster::read_image(&page.input_path, options.max_pixels, options.max_dimension)
                        .map_err(|error| {
                            map_raster_error(error, &page.input_path, page.source_page_index)
                        })?,
                );
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
                let decoded = Arc::new(
                    raster::read_gray(&page.input_path, options.max_pixels, options.max_dimension)
                        .map_err(|error| {
                            map_raster_error(error, &page.input_path, page.source_page_index)
                        })?,
                );
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

    pub(crate) fn run_page(
        page: &Page,
        canvas_scope: CanvasScope,
        final_render: bool,
        document_canvas: Option<DocumentCanvas>,
        fallback_destination: Option<(&Path, &Path)>,
        page_ink_consistency: Option<PageInkConsistencyContext>,
        cache: &PageCache,
    ) -> Result<PageRunResult, Box<dyn Error>> {
        let options = page.options.clone();
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
            decode_page_inputs(page, &options, cache, false, decode_color)?;
        timings.decode_ms += decode_started.elapsed().as_secs_f64() * 1_000.0;
        let input_gray = color_input
            .as_ref()
            .map(|input| &input.gray)
            .or(gray_input.as_deref())
            .expect("cleanup input is initialized");
        let canonical_analysis_input = page
            .analysis_input_path
            .as_ref()
            .map(|path| {
                raster::read_image(path, options.max_pixels, options.max_dimension)
                    .map_err(|error| map_raster_error(error, path, page.source_page_index))
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
                    dpi: page
                        .analysis_dpi
                        .expect("validated fixed analysis raster has a DPI"),
                });
        let trusted_foreground = page
        .trusted_foreground_mask_path
        .as_ref()
        .map(|path| {
            let selection =
                raster::read_foreground_selection(path, options.max_pixels, options.max_dimension)
                .map_err(|error| map_raster_error(error, path, page.source_page_index))?;
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
        let trusted_mrc_background = page
        .trusted_mrc_background_path
        .as_ref()
        .map(|path| {
            let background =
                raster::read_gray(path, options.max_pixels, options.max_dimension)
                    .map_err(|error| map_raster_error(error, path, page.source_page_index))?;
            let (background_width, background_height) =
                (background.width(), background.height());
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
        let create_mixed_layers = final_render
            && !page.outputs.is_empty()
            && page.outputs.iter().all(|output| {
                output.background_output_path.is_some()
                    && output.foreground_mask_output_path.is_some()
            });
        let mut result = if let Some(detail_plan) = &page.detail_render_plan {
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
                map_raster_error(error, &detail_plan.base_raster_path, page.source_page_index)
            })?;
            let base_cleaned = detail_plan
                .base_cleaned_raster_path
                .as_ref()
                .map(|path| raster::read_image(path, options.max_pixels, options.max_dimension))
                .transpose()
                .map_err(|error| {
                    map_raster_error(
                        error,
                        detail_plan
                            .base_cleaned_raster_path
                            .as_deref()
                            .expect("base cleaned path exists when decoding succeeds"),
                        page.source_page_index,
                    )
                })?;
            clean_detail_page_with_color(
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
                page.source_page_index,
                detail_plan,
                &base_metadata,
                &mut timings,
            )
            .map_err(map_image_error)?
        } else {
            clean_page_with_color_and_document_prior_cached(
                input_gray,
                color_input.as_ref().map(|input| &input.rgb),
                canonical_analysis,
                trusted_foreground_mask.as_ref(),
                trusted_mrc_background.as_ref(),
                &options,
                page.source_page_index,
                page.document_prior,
                cache,
                create_mixed_layers,
                // A concrete mode may have come from the user's setting or from
                // the already-completed document detector. In either case the
                // render has no reason to run mode recommendation again. Automatic
                // pages without reusable evidence still compute it here.
                options.output_mode == OutputMode::Auto,
                &mut timings,
            )
            .map_err(map_image_error)?
        };
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
        }
        if options.ocr_mode
            && (result.outputs.len() != 1
                || result.outputs[0].image.width() != input_gray.width()
                || result.outputs[0].image.height() != input_gray.height())
        {
            return Err(invalid("OCR mode changed output dimensions").into());
        }
        let page_metadata = PageResultMetadata {
            source_page_index: page.source_page_index,
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
            document_prior: page.document_prior,
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
        let destinations = resolve_destinations(page, result.outputs.len(), fallback_destination)?;
        let matched_canvas = if final_render && options.match_page_size && !options.ocr_mode {
            let canvas = document_canvas
                .ok_or_else(|| invalid("Matched page size requires a documentCanvas plan"))?;
            // PDF page matching is a physical-points contract, not a
            // same-number-of-pixels contract. Reusing the document's finest raster
            // grid upscaled lower-DPI B&W/Mixed pages after cleanup, adding no
            // information while changing stroke geometry and bloating masks. Each
            // page keeps the DPI at which it was actually cleaned.
            let mut canvas = geometry_canvas(&canvas);
            canvas = canvas.at_dpi(options.dpi);
            validate_canvas_for_options(canvas.width_px, canvas.height_px, &options)?;
            Some(canvas)
        } else {
            None
        };
        let matched_placements = if let Some(canvas) = matched_canvas {
            let geometry_outputs = result
                .outputs
                .iter()
                .map(|output| {
                    let mut geometry = geometry_output_from_cleanup_result(output, &options);
                    geometry.optical_content_bounds_x = PLACEMENT_CENTERING_BOUNDS_X;
                    geometry
                })
                .collect::<Vec<_>>();
            plan_canvas_placements(&geometry_outputs, &canvas)
                .into_iter()
                .zip(&result.outputs)
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
            vec![None; result.outputs.len()]
        };
        let mut written = Vec::with_capacity(result.outputs.len());
        let write_started = Instant::now();
        let publication_result = (|| -> Result<(), Box<dyn Error>> {
            for ((output, destination), matched_placement) in result
                .outputs
                .iter_mut()
                .zip(&destinations)
                .zip(matched_placements.into_iter())
            {
                let layer_destinations_available = final_render
                    && output.mixed_layers.as_ref().is_some_and(|layers| {
                        destination.background_output_path.is_some()
                            && if layers.foreground_alpha.is_some() {
                                destination.foreground_alpha_output_path.is_some()
                            } else {
                                destination.foreground_mask_output_path.is_some()
                            }
                    });
                if let Some((placement, canvas)) = matched_placement {
                    apply_canvas_metadata(&mut output.metadata, placement, &canvas);
                    match_picture_mask_in_memory(output, placement, &canvas);
                    match_tone_preservation_alpha_in_memory(output, placement, &canvas);
                    let spread_mixed = result.classification == LayoutClassification::TwoPageSpread
                        && output.mixed_layers.is_some();
                    if spread_mixed {
                        // The shared spread anchor is native canvas geometry. A
                        // compact layered manifest has no placement matrix; its
                        // WASM/img2pdf assembler scales the background and mask
                        // independently and can therefore reintroduce each
                        // leaf's intrinsic crop headroom. The composite was
                        // restored before planning, so materialize that exact
                        // source on the native canvas. Single-page mixed output
                        // keeps its layered representation.
                        match_primary_raster_in_memory(output, placement, &canvas);
                        output.mixed_layers = None;
                    } else if layer_destinations_available {
                        // Layered and bilevel publication still materializes the
                        // document canvas, so its intrinsic output is the placed
                        // content rectangle on that grid.
                        output.metadata.output_width = placement.content_width;
                        output.metadata.output_height = placement.content_height;
                        match_layers_in_memory(output, &options, placement, &canvas);
                    } else {
                        match_primary_raster_in_memory(output, placement, &canvas);
                    }
                }
                // A binarized page is already packed bits, and PBM P4 is the same
                // layout: the raster itself decides whether this page has a bilevel
                // primary, so no mode/layer combination has to be re-derived here.
                let bilevel_write = destination
                    .bilevel_output_path
                    .as_ref()
                    .zip(output.image.bilevel())
                    .map(|(path, binary)| (path, pbm::write_p4_bilevel_atomic(path, binary)));
                let bilevel_output_path = match bilevel_write {
                    Some((path, Ok(()))) => {
                        output.metadata.bilevel_written = true;
                        Some(path.clone())
                    }
                    Some((path, Err(error))) => {
                        let _ = fs::remove_file(path);
                        output.metadata.warnings.push(format!(
                        "Bilevel output was not written; the composite fallback was published instead: {error}"
                    ));
                        None
                    }
                    None => None,
                };
                let (
                    background_output_path,
                    foreground_mask_output_path,
                    foreground_alpha_output_path,
                ) = if let (Some(layers), Some(background_path)) = (
                    output.mixed_layers.as_ref(),
                    final_render
                        .then_some(destination.background_output_path.as_ref())
                        .flatten(),
                ) {
                    let foreground_path = if layers.foreground_alpha.is_some() {
                        destination.foreground_alpha_output_path.as_ref()
                    } else {
                        destination.foreground_mask_output_path.as_ref()
                    };
                    let foreground_path = foreground_path.ok_or_else(|| {
                        invalid("Layered cleanup output is missing its foreground destination")
                    })?;
                    // Source-MRC pages already carry the authored high-DPI
                    // photo detail through their JPX+smask pair. Only pages
                    // without that safe affine reuse need the larger fresh
                    // continuous-tone plate.
                    let confirmed_picture = output
                        .picture_mask
                        .as_ref()
                        .is_some_and(|mask| mask.count_black() > 0)
                        && !layers.source_mrc;
                    let background_dpi = layered_background_dpi(&options, confirmed_picture);
                    let layer_result = (|| -> Result<(), String> {
                        let (target_background_width, target_background_height) =
                            if let Some((_, canvas)) = matched_placement.as_ref() {
                                background_canvas_dimensions(canvas, background_dpi)
                            } else {
                                (
                                    ((layers.foreground_mask.width() as f64 * background_dpi
                                        / options.dpi)
                                        .round() as usize)
                                        .max(1),
                                    ((layers.foreground_mask.height() as f64 * background_dpi
                                        / options.dpi)
                                        .round() as usize)
                                        .max(1),
                                )
                            };
                        let (background_width, background_height) =
                            background_dimensions_to_publish(
                                layers.background.width(),
                                layers.background.height(),
                                target_background_width,
                                target_background_height,
                            );
                        if let Some(color) = &layers.color_background {
                            if color.width() != background_width
                                || color.height() != background_height
                            {
                                let background = downscale_rgb_to_dimensions(
                                    color,
                                    background_width,
                                    background_height,
                                );
                                write_layer_background(background_path, &background)?;
                            } else {
                                write_layer_background(background_path, color)?;
                            }
                        } else if layers.background.width() != background_width
                            || layers.background.height() != background_height
                        {
                            let background = layers
                                .background
                                .downscale_to_dimensions(background_width, background_height);
                            write_gray_layer_background(background_path, &background)?;
                        } else {
                            write_gray_layer_background(background_path, &layers.background)?;
                        }
                        if let Some(alpha) = layers.foreground_alpha.as_ref() {
                            let foreground_dpi = layered_foreground_dpi(&options);
                            let foreground_width =
                                ((alpha.width() as f64 * foreground_dpi / options.dpi).round()
                                    as usize)
                                    .max(1);
                            let foreground_height =
                                ((alpha.height() as f64 * foreground_dpi / options.dpi).round()
                                    as usize)
                                    .max(1);
                            let foreground = if foreground_dpi < options.dpi {
                                alpha.downscale_to_dimensions(foreground_width, foreground_height)
                            } else {
                                alpha.clone()
                            };
                            raster::write_gray_pgm_atomic(foreground_path, &foreground)
                        } else {
                            pbm::write_p4_bilevel_atomic(foreground_path, &layers.foreground_mask)
                        }
                    })();
                    if let Err(error) = layer_result {
                        let _ = fs::remove_file(background_path);
                        let _ = fs::remove_file(foreground_path);
                        restore_mixed_composite_from_layers(output);
                        output.metadata.warnings.push(format!(
                            "Mixed layers were not written safely; the composite fallback was published instead: {error}"
                        ));
                        (None, None, None)
                    } else {
                        output.metadata.layered_written = true;
                        output.metadata.layered_foreground_kind = Some(if layers.source_mrc {
                            LayeredForegroundKind::SourceMrc
                        } else if layers.foreground_alpha.is_some() {
                            LayeredForegroundKind::SoftAlpha
                        } else {
                            LayeredForegroundKind::Stencil
                        });
                        output.metadata.layered_background_dpi = Some(background_dpi);
                        output.metadata.layered_foreground_dpi = if layers.source_mrc {
                            // The published selection mask remains on the
                            // rendered page grid. The original JP2's own
                            // DPI is retained later by the PDF affine
                            // matrix and is not this raster's metadata.
                            Some(options.dpi)
                        } else {
                            layers
                                .foreground_alpha
                                .is_some()
                                .then(|| layered_foreground_dpi(&options))
                        };
                        (
                            Some(background_path.clone()),
                            layers
                                .foreground_alpha
                                .is_none()
                                .then(|| foreground_path.clone()),
                            layers
                                .foreground_alpha
                                .is_some()
                                .then(|| foreground_path.clone()),
                        )
                    }
                } else {
                    (None, None, None)
                };
                let picture_mask_output_path = if final_render {
                    destination
                        .picture_mask_output_path
                        .as_ref()
                        .zip(output.picture_mask.as_ref())
                        .map(|(path, picture_mask)| {
                            pbm::write_p4_bilevel_atomic(path, picture_mask)
                                .map(|()| path.clone())
                                .map_err(|message| NativeError::new(NativeErrorCode::Io, message))
                        })
                        .transpose()?
                } else {
                    None
                };
                let tone_preservation_alpha_output_path = if final_render {
                    destination
                        .tone_preservation_alpha_output_path
                        .as_ref()
                        .zip(output.tone_preservation_alpha.as_ref())
                        .map(|(path, tone_preservation_alpha)| {
                            png::write_gray_atomic(path, tone_preservation_alpha)
                                .map(|()| path.clone())
                                .map_err(|message| NativeError::new(NativeErrorCode::Io, message))
                        })
                        .transpose()?
                } else {
                    None
                };
                // The composite carries the page only when no primary raster did.
                // Deflating and fsyncing a full-resolution copy beside a published
                // PBM or layer pair buys insurance nobody collects.
                if bilevel_output_path.is_none() && background_output_path.is_none() {
                    if let Some(color) = &output.color_image {
                        png::write_rgb_atomic(&destination.output_path, color)
                            .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                    } else {
                        png::write_gray_atomic(&destination.output_path, &output.image.to_gray())
                            .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
                    }
                }
                write_json_atomic(&destination.metadata_path, &output.metadata)?;
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
                let fold_side_near_paper_run = if matched_placement.is_some()
                    || !options.match_page_size
                    || options.ocr_mode
                {
                    0
                } else if let Some(canvas) = document_canvas.map(|canvas| geometry_canvas(&canvas))
                {
                    let fit = canvas_fit_for(
                        output.image.width(),
                        output.image.height(),
                        paper_width,
                        paper_height,
                        output.metadata.content_box.is_some(),
                        &options,
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
                let outer_near_paper_edge_runs = if matched_placement.is_none()
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
                written.push(WrittenOutput {
                    output_path: destination.output_path.clone(),
                    metadata_path: destination.metadata_path.clone(),
                    bilevel_output_path,
                    background_output_path,
                    foreground_mask_output_path,
                    foreground_alpha_output_path,
                    picture_mask_output_path,
                    tone_preservation_alpha_output_path,
                    options: options.clone(),
                    source_page_index: page.source_page_index,
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
                    matched_in_memory: matched_placement.is_some(),
                });
            }
            Ok(())
        })();
        if let Err(error) = publication_result {
            for destination in &destinations {
                let _ = fs::remove_file(&destination.output_path);
                let _ = fs::remove_file(&destination.metadata_path);
                if let Some(bilevel_path) = &destination.bilevel_output_path {
                    let _ = fs::remove_file(bilevel_path);
                }
                if let Some(background_path) = &destination.background_output_path {
                    let _ = fs::remove_file(background_path);
                }
                if let Some(mask_path) = &destination.foreground_mask_output_path {
                    let _ = fs::remove_file(mask_path);
                }
                if let Some(alpha_path) = &destination.foreground_alpha_output_path {
                    let _ = fs::remove_file(alpha_path);
                }
                if let Some(mask_path) = &destination.picture_mask_output_path {
                    let _ = fs::remove_file(mask_path);
                }
                if let Some(mask_path) = &destination.tone_preservation_alpha_output_path {
                    let _ = fs::remove_file(mask_path);
                }
            }
            let _ = fs::remove_file(&page.page_metadata_path);
            return Err(error);
        }
        timings.write_ms += write_started.elapsed().as_secs_f64() * 1_000.0;
        Ok(PageRunResult {
            outputs: written,
            metadata: page_metadata,
            page_metadata_path: page.page_metadata_path.clone(),
            timings,
        })
    }

    pub(crate) fn run_classification(
        page: &Page,
        canvas_scope: CanvasScope,
        document_prior: Option<crate::split::DocumentPrior>,
        recommend_output_mode: bool,
        plan_content: bool,
        cache: &PageCache,
    ) -> Result<PageRunResult, Box<dyn Error>> {
        let options = page.options.clone();
        options.validate().map_err(invalid)?;
        let mut timings = PageStageTimings::default();
        let decode_started = Instant::now();
        // Analyze produces mode-independent diagnostics even when a concrete mode
        // is selected. A concrete final render does not publish or consume those
        // recommendations, so keep that lane grayscale-only.
        let (color_input, gray_input) =
            decode_page_inputs(page, &options, cache, true, recommend_output_mode)?;
        timings.decode_ms += decode_started.elapsed().as_secs_f64() * 1_000.0;
        let input = color_input
            .as_ref()
            .map(|decoded| &decoded.gray)
            .or(gray_input.as_deref())
            .expect("classification input is initialized");
        let result = analyze_page_with_color_and_document_prior_cached(
            input,
            color_input.as_ref().map(|decoded| &decoded.rgb),
            &options,
            document_prior,
            recommend_output_mode,
            plan_content,
            cache,
            &mut timings,
        )
        .map_err(map_image_error)?;
        let page_metadata = PageResultMetadata {
            source_page_index: page.source_page_index,
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
        Ok(PageRunResult {
            outputs: Vec::new(),
            metadata: page_metadata,
            page_metadata_path: page.page_metadata_path.clone(),
            timings,
        })
    }

    pub(crate) fn layered_foreground_dpi(options: &CleanupOptions) -> f64 {
        options
            .source_dpi()
            .min(options.dpi)
            .min(SOFT_FOREGROUND_MAX_DPI)
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

    pub(crate) fn write_layer_background(path: &Path, image: &RgbImage) -> Result<(), String> {
        if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("ppm"))
        {
            // This is a managed handoff to the PDF assembler, which immediately
            // JPEG-encodes the continuous-tone layer. Raw PPM avoids a lossless PNG
            // encode here and its matching decode in the next process.
            raster::write_rgb_ppm_atomic(path, image)
        } else {
            png::write_rgb_atomic(path, image)
        }
    }
}

fn page_complete_progress(result: &PageRunResult, index: usize, total_pages: usize) -> Progress {
    let metadata = &result.metadata;
    let stage_timings = result.timings;
    Progress {
        stage: ProgressStage::PageComplete,
        completed_pages: index + 1,
        total_pages,
        page_number: Some(index + 1),
        output_paths: Some(
            result
                .outputs
                .iter()
                .map(|output| output.output_path.clone())
                .collect(),
        ),
        classification: Some(metadata.layout_classification),
        confidence: Some(metadata.layout_confidence),
        cutter_x_px: (metadata.layout_classification == LayoutClassification::TwoPageSpread)
            .then_some(metadata.cutter_x_px)
            .flatten(),
        tier1_verdict: Some(metadata.tier1_verdict),
        reconciled: Some(metadata.reconciled),
        cluster_agreement: Some(metadata.cluster_agreement),
        document_prior: metadata.document_prior,
        text_axis: metadata.text_axis,
        stage_timings: (!stage_timings.is_empty()).then_some(stage_timings),
        recommended_output_mode: metadata.recommended_output_mode,
        recommended_output_mode_confidence: metadata.recommended_output_mode_confidence,
        recommended_output_mode_reason: metadata.recommended_output_mode_reason,
        soft_alpha_foreground_recommendation: metadata.soft_alpha_foreground_recommendation,
        output_mode_diagnostics: metadata.output_mode_diagnostics,
    }
}

pub(crate) use page_workflow::{run_classification, run_page};

pub(crate) fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let bytes = serde_json::to_vec_pretty(value)?;
    crate::io::write_atomic(path, &bytes).map_err(|error| std::io::Error::other(error).into())
}

#[cfg(test)]
mod tests {
    use super::page_workflow::decode_page_inputs;
    use super::page_workflow::{map_image_error, write_gray_layer_background};
    use super::planning_page;
    use super::{
        map_raster_error, parse_cli_args, ManifestV3, PlanningManifest, ScanCleanupCliInvocation,
    };
    use super::{PageResultMetadata, PageRunResult};
    use crate::engine::batch_reconciliation::{
        reconcile_classification_batch, ReconciliationAction, ReconciliationPolicy,
    };
    use crate::engine::resource_planning::{manifest_cache, page_cache_for, page_worker_threads};
    use crate::engine::resource_planning::{CleanupOptionsView, PageDescriptor, PlanningOperation};
    use crate::engine::staged_input::StagedPageDescriptor;
    use crate::io::raster::RasterReadError;
    use crate::io::MAX_STREAM_INPUT_BYTES;
    use crate::protocol::manifest_v3::{
        AnalysisPurpose, CanvasScope, DetailPixelRect, DetailRenderPlan, Operation, Page,
        PageOutput, RenderMode, SplitSeamPolyline, VERSION,
    };
    use crate::protocol::progress::PageStageTimings;
    use crate::split::{ClusterDimensions, DocumentPrior, LayoutClassification};
    use crate::{CleanupOptions, OrthogonalRotation, OutputMode};
    use evb_native_support::{NativeError, NativeErrorCode};
    use scan_primitives::{BinaryImage, GrayImage, Point};

    #[test]
    fn rerun_error_remains_primary_when_lease_release_also_fails() {
        let error = super::finish_staged_rerun::<()>(
            Err(Box::new(NativeError::new(
                NativeErrorCode::NativeFailure,
                "rerun failed",
            ))),
            Err(NativeError::new(NativeErrorCode::Io, "release failed")),
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "rerun failed");
    }

    #[test]
    fn lease_release_error_is_returned_when_rerun_succeeds() {
        let error = super::finish_staged_rerun::<()>(
            Ok(()),
            Err(NativeError::new(NativeErrorCode::Io, "release failed")),
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "release failed");
    }

    #[test]
    fn analyze_workers_ignore_duplicate_unused_render_outputs() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-analyze-output-contract-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(100, 50, 240)).unwrap(),
        )
        .unwrap();
        let duplicate_output = PageOutput {
            output_path: dir.join("unused.png"),
            metadata_path: dir.join("unused-output.json"),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
            foreground_alpha_output_path: None,
            picture_mask_output_path: None,
            tone_preservation_alpha_output_path: None,
        };
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: (0..2)
                .map(|index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: vec![duplicate_output.clone()],
                })
                .collect(),
        };

        // Analyze does not publish PageOutput destinations. Validation accepts
        // the duplicated unused values, while the worker bound still follows
        // the memory-derived page limit instead of a destination scan.
        manifest.validate().unwrap();
        assert_eq!(page_worker_threads(&manifest).unwrap(), 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn prior_rerun_preserves_unbiased_tier1_provenance() {
        let seam = SplitSeamPolyline {
            points: vec![Point::new(120.0, 0.0), Point::new(121.0, 200.0)],
        };
        let metadata = || PageResultMetadata {
            source_page_index: 3,
            layout_classification: LayoutClassification::TwoPageSpread,
            layout_confidence: 0.92,
            cutter_x_px: Some(121.0),
            split_seam: Some(seam.clone()),
            rotation_degrees: OrthogonalRotation::None,
            canvas_scope: CanvasScope::default(),
            excluded: false,
            blank_outputs_skipped: 0,
            output_count: 2,
            outputs: Vec::new(),
            tier1_verdict: LayoutClassification::TwoPageSpread,
            reconciled: false,
            cluster_agreement: 0.9,
            split_diagnostics: crate::split::SplitDiagnostics::default(),
            document_prior: None,
            text_axis: None,
            recommended_output_mode: None,
            recommended_output_mode_confidence: None,
            recommended_output_mode_reason: None,
            soft_alpha_foreground_recommendation: None,
            output_mode_diagnostics: None,
            rotated_width: 240,
            rotated_height: 200,
            candidate_cutter_ratio: Some(0.505),
            whitespace_score: 0.8,
            reconciliation_eligible: true,
            tier1_confidence: 0.0,
            calibration_stroke_width_px: None,
            calibration_x_height_px: None,
        };
        let tier1 = crate::engine::batch_reconciliation::Tier1Provenance {
            verdict: LayoutClassification::SingleUncutPage,
            confidence: 0.47,
            candidate_cutter_ratio: Some(0.49),
            whitespace_score: 0.18,
        };
        let prior = DocumentPrior {
            dominant_layout: LayoutClassification::TwoPageSpread,
            cutter_ratio_median: Some(0.5),
            cluster_dims: ClusterDimensions {
                width: 240.0,
                height: 200.0,
            },
            agreement_strength: 0.9,
            stroke_width_median_px: None,
            x_height_median_px: None,
        };
        let result = PageRunResult {
            outputs: Vec::new(),
            metadata: metadata(),
            page_metadata_path: std::env::temp_dir().join("reconciliation-test.json"),
            timings: PageStageTimings::default(),
        };
        let rerun_result = PageRunResult {
            outputs: Vec::new(),
            metadata: metadata(),
            page_metadata_path: std::env::temp_dir().join("reconciliation-rerun-test.json"),
            timings: PageStageTimings::default(),
        };
        let action = ReconciliationAction::Rerun {
            index: 0,
            prior,
            tier1,
        };
        let mut results = vec![result];
        let mut rerun_result = Some(rerun_result);
        super::apply_reconciliation_actions(&mut results, &[action], |_, _| {
            Ok(rerun_result.take().unwrap())
        })
        .unwrap();
        let metadata = &results[0].metadata;
        assert_eq!(
            metadata.tier1_verdict,
            LayoutClassification::SingleUncutPage
        );
        assert_eq!(metadata.tier1_confidence, 0.47);
        assert_eq!(metadata.candidate_cutter_ratio, Some(0.49));
        assert_eq!(metadata.whitespace_score, 0.18);
        assert!(metadata.reconciled);
        assert_eq!(metadata.cluster_agreement, 0.9);
        assert_eq!(metadata.document_prior, Some(prior));
        assert_eq!(metadata.output_count, 2);
        assert_eq!(metadata.split_seam, Some(seam));
    }

    #[test]
    fn reconciliation_prior_rerun_accumulates_every_stage_timing_field() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-reconcile-timings-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        let mut source = GrayImage::new(240, 200, 245);
        for y in 20..180 {
            for x in 20..110 {
                source.set(x, y, 40);
            }
        }
        fs::write(&input, crate::png::encode_gray(&source).unwrap()).unwrap();
        let manifest = ManifestV3 {
            version: crate::protocol::manifest_v3::VERSION,
            operation: crate::protocol::manifest_v3::Operation::Analyze,
            analysis_purpose: crate::protocol::manifest_v3::AnalysisPurpose::Classification,
            render_mode: crate::protocol::manifest_v3::RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: Some(8 * 1024 * 1024 * 1024),
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: (0..4)
                .map(|index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        let seeded_timings = PageStageTimings {
            decode_ms: 1010.0,
            analysis_level_ms: 1020.0,
            normalization_ms: 1030.0,
            illumination_preparation_ms: 1040.0,
            layout_normalization_ms: 1050.0,
            calibration_ms: 1060.0,
            picture_mask_ms: 1070.0,
            mode_recommendation_ms: 1080.0,
            quality_normalization_ms: 1090.0,
            text_axis_ms: 1100.0,
            split_ms: 1110.0,
            deskew_ms: 1120.0,
            content_ms: 1130.0,
            rasterization_ms: 1140.0,
            mask_rasterization_ms: 1150.0,
            binarization_ms: 1160.0,
            threshold_preparation_ms: 1170.0,
            thresholding_ms: 1180.0,
            binary_postprocess_ms: 1190.0,
            mixed_composition_ms: 1200.0,
            output_processing_ms: 1210.0,
            render_ms: 1220.0,
            write_ms: 1230.0,
        };
        let result = |index: usize, verdict, confidence: f64, timings| PageRunResult {
            outputs: Vec::new(),
            metadata: PageResultMetadata {
                source_page_index: index,
                layout_classification: verdict,
                layout_confidence: confidence,
                cutter_x_px: (verdict == LayoutClassification::TwoPageSpread).then_some(120.0),
                split_seam: None,
                rotation_degrees: OrthogonalRotation::None,
                canvas_scope: CanvasScope::default(),
                excluded: false,
                blank_outputs_skipped: 0,
                output_count: usize::from(verdict == LayoutClassification::TwoPageSpread) + 1,
                outputs: Vec::new(),
                tier1_verdict: verdict,
                reconciled: false,
                cluster_agreement: 0.0,
                split_diagnostics: crate::split::SplitDiagnostics::default(),
                document_prior: None,
                text_axis: None,
                recommended_output_mode: None,
                recommended_output_mode_confidence: None,
                recommended_output_mode_reason: None,
                soft_alpha_foreground_recommendation: None,
                output_mode_diagnostics: None,
                rotated_width: 240,
                rotated_height: 200,
                candidate_cutter_ratio: Some(0.5),
                whitespace_score: 0.9,
                reconciliation_eligible: true,
                tier1_confidence: confidence,
                calibration_stroke_width_px: None,
                calibration_x_height_px: None,
            },
            page_metadata_path: dir.join(format!("page-{index}.json")),
            timings,
        };
        let mut results = vec![
            result(
                0,
                LayoutClassification::TwoPageSpread,
                0.92,
                PageStageTimings::default(),
            ),
            result(
                1,
                LayoutClassification::TwoPageSpread,
                0.91,
                PageStageTimings::default(),
            ),
            result(
                2,
                LayoutClassification::TwoPageSpread,
                0.90,
                PageStageTimings::default(),
            ),
            result(
                3,
                LayoutClassification::SingleUncutPage,
                0.40,
                seeded_timings,
            ),
        ];
        let actions = reconcile_classification_batch(
            &super::reconciliation_candidates(&results),
            ReconciliationPolicy {
                minimum_confidence: 0.60,
                minimum_support: 2,
            },
        );
        assert!(actions
            .iter()
            .any(|action| matches!(action, ReconciliationAction::Rerun { index: 3, .. })));
        let mut rerun_result = Some(result(
            3,
            LayoutClassification::TwoPageSpread,
            0.90,
            PageStageTimings::default(),
        ));
        super::apply_reconciliation_actions(&mut results, &actions, |_index, _prior| {
            assert_eq!(manifest.pages.len(), 4);
            Ok(rerun_result.take().unwrap())
        })
        .unwrap();

        let reconciled = &results[3];
        assert!(reconciled.timings.decode_ms >= 1010.0);
        assert!(reconciled.timings.analysis_level_ms >= 1020.0);
        assert!(reconciled.timings.normalization_ms >= 1030.0);
        assert!(reconciled.timings.illumination_preparation_ms >= 1040.0);
        assert!(reconciled.timings.layout_normalization_ms >= 1050.0);
        assert!(reconciled.timings.calibration_ms >= 1060.0);
        assert!(reconciled.timings.picture_mask_ms >= 1070.0);
        assert!(reconciled.timings.mode_recommendation_ms >= 1080.0);
        assert!(reconciled.timings.quality_normalization_ms >= 1090.0);
        assert!(reconciled.timings.text_axis_ms >= 1100.0);
        assert!(reconciled.timings.split_ms >= 1110.0);
        assert!(reconciled.timings.deskew_ms >= 1120.0);
        assert!(reconciled.timings.content_ms >= 1130.0);
        assert!(reconciled.timings.rasterization_ms >= 1140.0);
        assert!(reconciled.timings.mask_rasterization_ms >= 1150.0);
        assert!(reconciled.timings.binarization_ms >= 1160.0);
        assert!(reconciled.timings.threshold_preparation_ms >= 1170.0);
        assert!(reconciled.timings.thresholding_ms >= 1180.0);
        assert!(reconciled.timings.binary_postprocess_ms >= 1190.0);
        assert!(reconciled.timings.mixed_composition_ms >= 1200.0);
        assert!(reconciled.timings.output_processing_ms >= 1210.0);
        assert!(reconciled.timings.render_ms >= 1220.0);
        assert!(reconciled.timings.write_ms >= 1230.0);
        assert_eq!(
            reconciled.metadata.tier1_verdict,
            LayoutClassification::SingleUncutPage
        );
        assert_eq!(reconciled.metadata.tier1_confidence, 0.40);
        assert_eq!(reconciled.metadata.candidate_cutter_ratio, Some(0.5));
        assert_eq!(reconciled.metadata.whitespace_score, 0.9);
        assert_eq!(
            reconciled
                .metadata
                .document_prior
                .map(|prior| prior.dominant_layout),
            Some(LayoutClassification::TwoPageSpread)
        );
        assert_eq!(
            reconciled.metadata.reconciled,
            reconciled.metadata.layout_classification != LayoutClassification::SingleUncutPage
        );
        for confident in &results[..3] {
            assert_eq!(confident.timings, PageStageTimings::default());
            assert_eq!(
                confident.metadata.tier1_verdict,
                LayoutClassification::TwoPageSpread
            );
        }
        let _ = fs::remove_dir_all(dir);
    }

    fn assert_manifest_paths_within_root(
        manifest: &ManifestV3,
        root: &Path,
    ) -> Result<(), NativeError> {
        super::assert_paths_within_root(&super::staged_path_plan(manifest), root)
    }

    fn preflight_manifest_paths(manifest: &ManifestV3) -> Result<(), NativeError> {
        super::preflight_paths(&super::staged_path_plan(manifest))
    }

    #[cfg(unix)]
    #[test]
    fn allowed_path_root_rejects_symlink_escapes_and_keeps_real_descendants() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-allowed-root-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("input.png"), b"input").unwrap();
        fs::write(outside.join("secret.png"), b"secret").unwrap();
        symlink(outside.join("secret.png"), root.join("input-link.png")).unwrap();
        symlink(&outside, root.join("escape-dir")).unwrap();
        symlink(root.join("input.png"), root.join("inside-link.png")).unwrap();
        symlink(outside.join("missing.png"), root.join("dangling.png")).unwrap();

        let manifest_with = |input: PathBuf, output: PathBuf| ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Final,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: vec![Page {
                input_path: input,
                analysis_input_path: None,
                analysis_dpi: None,
                trusted_foreground_mask_path: None,
                trusted_mrc_background_path: None,
                source_page_index: 0,
                page_metadata_path: root.join("page.json"),
                options: CleanupOptions {
                    match_page_size: false,
                    ..CleanupOptions::default()
                },
                document_prior: None,
                detail_render_plan: None,
                outputs: vec![PageOutput {
                    output_path: output,
                    metadata_path: root.join("output.json"),
                    bilevel_output_path: None,
                    background_output_path: None,
                    foreground_mask_output_path: None,
                    foreground_alpha_output_path: None,
                    picture_mask_output_path: None,
                    tone_preservation_alpha_output_path: None,
                }],
            }],
        };

        // A real input and a not-yet-created output below a real directory.
        assert_manifest_paths_within_root(
            &manifest_with(root.join("input.png"), root.join("nested/output.png")),
            &root,
        )
        .unwrap();

        // A symlink that resolves back inside the root stays valid.
        assert_manifest_paths_within_root(
            &manifest_with(root.join("inside-link.png"), root.join("nested/output.png")),
            &root,
        )
        .unwrap();

        // An existing input symlink pointing outside the root.
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("input-link.png"), root.join("nested/output.png")),
            &root,
        )
        .unwrap_err()
        .to_string()
        .contains("escapes the allowed path root"));

        // A missing output below a symlinked external ancestor.
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("input.png"), root.join("escape-dir/output.png")),
            &root,
        )
        .unwrap_err()
        .to_string()
        .contains("escapes the allowed path root"));

        // A lexical escape that never touches the filesystem.
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("input.png"), root.join("../outside/output.png")),
            &root,
        )
        .unwrap_err()
        .to_string()
        .contains("escapes the allowed path root"));

        // A dangling symlink resolves to nothing this root can vouch for.
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("dangling.png"), root.join("nested/output.png")),
            &root,
        )
        .unwrap_err()
        .to_string()
        .contains("cannot be resolved"));

        // input_paths() and destination_paths() carry more than inputPath and
        // the primary output. Every auxiliary entry is judged by the same root,
        // so each slot is filled twice: once with a symlink that resolves back
        // inside the root, once with one that resolves outside it.
        let inside_link = root.join("inside-link.png");
        let outside_link = root.join("input-link.png");
        let detail_plan = |base_metadata: PathBuf, base_raster: PathBuf, base_cleaned: PathBuf| {
            let region = DetailPixelRect {
                x_px: 0.0,
                y_px: 0.0,
                width_px: 16.0,
                height_px: 16.0,
            };
            DetailRenderPlan {
                base_metadata_path: base_metadata,
                base_raster_path: base_raster,
                base_cleaned_raster_path: Some(base_cleaned),
                source_crop: region.clone(),
                full_source_width_px: 32,
                full_source_height_px: 32,
                scale: 1.0,
                render_region: region.clone(),
                sampled_region: region,
            }
        };
        let detail_slot = |select: fn(PathBuf, PathBuf) -> (PathBuf, PathBuf, PathBuf)| {
            let inside = inside_link.clone();
            move |page: &mut Page, path: PathBuf| {
                let (base_metadata, base_raster, base_cleaned) = select(path, inside.clone());
                page.detail_render_plan =
                    Some(detail_plan(base_metadata, base_raster, base_cleaned));
            }
        };
        type AuxiliarySlot = (&'static str, Box<dyn Fn(&mut Page, PathBuf)>);
        let auxiliary_slots: Vec<AuxiliarySlot> = vec![
            (
                "analysisInputPath",
                Box::new(|page: &mut Page, path| {
                    page.analysis_input_path = Some(path);
                    page.analysis_dpi = Some(150.0);
                }),
            ),
            (
                "trustedForegroundMaskPath",
                Box::new(|page: &mut Page, path| page.trusted_foreground_mask_path = Some(path)),
            ),
            (
                "trustedMrcBackgroundPath",
                Box::new(|page: &mut Page, path| page.trusted_mrc_background_path = Some(path)),
            ),
            (
                "detailRenderPlan.baseMetadataPath",
                Box::new(detail_slot(|path, inside| (path, inside.clone(), inside))),
            ),
            (
                "detailRenderPlan.baseRasterPath",
                Box::new(detail_slot(|path, inside| (inside.clone(), path, inside))),
            ),
            (
                "detailRenderPlan.baseCleanedRasterPath",
                Box::new(detail_slot(|path, inside| (inside.clone(), inside, path))),
            ),
            (
                "pageMetadataPath",
                Box::new(|page: &mut Page, path| page.page_metadata_path = path),
            ),
            (
                "outputs.metadataPath",
                Box::new(|page: &mut Page, path| page.outputs[0].metadata_path = path),
            ),
            (
                "outputs.bilevelOutputPath",
                Box::new(|page: &mut Page, path| page.outputs[0].bilevel_output_path = Some(path)),
            ),
            (
                "outputs.backgroundOutputPath",
                Box::new(|page: &mut Page, path| {
                    page.outputs[0].background_output_path = Some(path)
                }),
            ),
            (
                "outputs.foregroundMaskOutputPath",
                Box::new(|page: &mut Page, path| {
                    page.outputs[0].foreground_mask_output_path = Some(path)
                }),
            ),
            (
                "outputs.foregroundAlphaOutputPath",
                Box::new(|page: &mut Page, path| {
                    page.outputs[0].foreground_alpha_output_path = Some(path)
                }),
            ),
            (
                "outputs.pictureMaskOutputPath",
                Box::new(|page: &mut Page, path| {
                    page.outputs[0].picture_mask_output_path = Some(path)
                }),
            ),
            (
                "outputs.tonePreservationAlphaOutputPath",
                Box::new(|page: &mut Page, path| {
                    page.outputs[0].tone_preservation_alpha_output_path = Some(path)
                }),
            ),
        ];
        for (label, fill) in &auxiliary_slots {
            let mut accepted =
                manifest_with(root.join("input.png"), root.join("nested/output.png"));
            fill(&mut accepted.pages[0], inside_link.clone());
            assert!(
                assert_manifest_paths_within_root(&accepted, &root).is_ok(),
                "{label} resolving inside the root must be accepted",
            );

            let mut rejected =
                manifest_with(root.join("input.png"), root.join("nested/output.png"));
            fill(&mut rejected.pages[0], outside_link.clone());
            let error = assert_manifest_paths_within_root(&rejected, &root)
                .expect_err(&format!(
                    "{label} resolving outside the root must be rejected"
                ))
                .to_string();
            assert!(
                error.contains("escapes the allowed path root"),
                "{label}: {error}"
            );
        }

        // A missing or non-directory root is rejected before any path check.
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("input.png"), root.join("nested/output.png")),
            &base.join("no-such-root"),
        )
        .unwrap_err()
        .to_string()
        .contains("not an existing directory"));
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("input.png"), root.join("nested/output.png")),
            &root.join("input.png"),
        )
        .unwrap_err()
        .to_string()
        .contains("not a directory"));

        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn manifest_path_preflight_rejects_hardlink_aliases() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-manifest-aliases-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("input.png");
        let input_alias = dir.join("input-alias.png");
        fs::write(&input, b"input").unwrap();
        fs::hard_link(&input, &input_alias).unwrap();
        let mut manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: vec![Page {
                input_path: input,
                analysis_input_path: None,
                analysis_dpi: None,
                trusted_foreground_mask_path: None,
                trusted_mrc_background_path: None,
                source_page_index: 0,
                page_metadata_path: input_alias,
                options: CleanupOptions::default(),
                document_prior: None,
                detail_render_plan: None,
                outputs: Vec::new(),
            }],
        };
        manifest.validate().unwrap();
        assert!(preflight_manifest_paths(&manifest)
            .unwrap_err()
            .to_string()
            .contains("aliases an input file"));

        let shared_destination = dir.join("shared-destination");
        let destination_alias = dir.join("destination-alias");
        fs::write(&shared_destination, b"old output").unwrap();
        fs::hard_link(&shared_destination, &destination_alias).unwrap();
        manifest.operation = Operation::Render;
        manifest.pages[0].options.match_page_size = false;
        manifest.pages[0].page_metadata_path = shared_destination.clone();
        manifest.pages[0].outputs.push(PageOutput {
            output_path: dir.join("output.png"),
            metadata_path: destination_alias.clone(),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
            foreground_alpha_output_path: None,
            picture_mask_output_path: None,
            tone_preservation_alpha_output_path: None,
        });
        manifest.validate().unwrap();
        assert!(preflight_manifest_paths(&manifest)
            .unwrap_err()
            .to_string()
            .contains("different files"));
        assert_eq!(fs::read(&shared_destination).unwrap(), b"old output");
        assert_eq!(fs::read(&destination_alias).unwrap(), b"old output");

        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn reconciliation_does_not_skip_a_prior_rerun_for_nonregular_input() {
        let dir = PathBuf::from(format!("/tmp/evb-scan-reconcile-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("already-consumed-input");
        fs::create_dir(&input).unwrap();
        let manifest = ManifestV3 {
            version: crate::protocol::manifest_v3::VERSION,
            operation: crate::protocol::manifest_v3::Operation::Analyze,
            analysis_purpose: crate::protocol::manifest_v3::AnalysisPurpose::Classification,
            render_mode: crate::protocol::manifest_v3::RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: (0..4)
                .map(|index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        let metadata = |index, verdict, confidence| PageResultMetadata {
            source_page_index: index,
            layout_classification: verdict,
            layout_confidence: confidence,
            cutter_x_px: (verdict == LayoutClassification::TwoPageSpread).then_some(120.0),
            split_seam: None,
            rotation_degrees: OrthogonalRotation::None,
            canvas_scope: CanvasScope::default(),
            excluded: false,
            blank_outputs_skipped: 0,
            output_count: usize::from(verdict == LayoutClassification::TwoPageSpread) + 1,
            outputs: Vec::new(),
            tier1_verdict: verdict,
            reconciled: false,
            cluster_agreement: 0.0,
            split_diagnostics: crate::split::SplitDiagnostics::default(),
            document_prior: None,
            text_axis: None,
            recommended_output_mode: None,
            recommended_output_mode_confidence: None,
            recommended_output_mode_reason: None,
            soft_alpha_foreground_recommendation: None,
            output_mode_diagnostics: None,
            rotated_width: 240,
            rotated_height: 200,
            candidate_cutter_ratio: Some(0.5),
            whitespace_score: 0.9,
            reconciliation_eligible: true,
            tier1_confidence: confidence,
            calibration_stroke_width_px: None,
            calibration_x_height_px: None,
        };
        let result = |index, verdict, confidence| PageRunResult {
            outputs: Vec::new(),
            metadata: metadata(index, verdict, confidence),
            page_metadata_path: dir.join(format!("page-{index}.json")),
            timings: PageStageTimings::default(),
        };
        let mut results = vec![
            result(0, LayoutClassification::TwoPageSpread, 0.92),
            result(1, LayoutClassification::TwoPageSpread, 0.91),
            result(2, LayoutClassification::TwoPageSpread, 0.90),
            result(3, LayoutClassification::SingleUncutPage, 0.40),
        ];
        let actions = reconcile_classification_batch(
            &super::reconciliation_candidates(&results),
            ReconciliationPolicy {
                minimum_confidence: 0.60,
                minimum_support: 2,
            },
        );
        assert!(actions
            .iter()
            .any(|action| matches!(action, ReconciliationAction::Rerun { index: 3, .. })));
        let error = super::apply_reconciliation_actions(&mut results, &actions, |index, _prior| {
            assert!(fs::metadata(&manifest.pages[index].input_path)
                .map(|metadata| !metadata.file_type().is_file())
                .unwrap_or(false));
            Err("rerun input failed".into())
        })
        .unwrap_err();
        assert!(!error.to_string().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

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
            super::page_workflow::normalize_trusted_foreground_selection(&sparse_white, &source),
            expected
        );
        assert_eq!(
            super::page_workflow::normalize_trusted_foreground_selection(&dense_white, &source),
            expected
        );
    }
    use std::{
        fs,
        io::Write,
        path::{Path, PathBuf},
        thread,
    };

    fn cli_args(args: &[&str]) -> Vec<String> {
        args.iter()
            .map(|argument| (*argument).to_string())
            .collect()
    }

    #[test]
    fn staged_translation_passes_materialized_input_to_downstream_once() {
        let original = PageDescriptor {
            input_path: PathBuf::from("/source/page.fifo"),
            source_page_index: 4,
            options: CleanupOptionsView {
                max_pixels: 100,
                max_dimension: 200,
                output_mode: crate::OutputMode::Auto,
                source_has_bilevel_layer: false,
                thickness: 0,
            },
            stream_input: true,
            trusted_foreground_mask_path: None,
            trusted_mrc_background_path: None,
        };
        let staged = StagedPageDescriptor {
            input_path: PathBuf::from("/scratch/materialized-page.raster"),
            metadata_path: PathBuf::from("/scratch/page.json"),
            source_page_index: 4,
            max_bytes: MAX_STREAM_INPUT_BYTES,
            stream_input: false,
        };

        let materialized = std::env::temp_dir().join(format!(
            "scan-cleanup-adapter-staged-{}-{}.raster",
            std::process::id(),
            original.source_page_index
        ));
        fs::write(&materialized, b"materialized page").unwrap();
        let staged = StagedPageDescriptor {
            input_path: materialized.clone(),
            ..staged
        };
        let translated = super::planning_page_from_staged(&original, &staged);
        assert_eq!(translated.input_path, staged.input_path);
        assert!(!translated.stream_input);
        assert_eq!(translated.source_page_index, original.source_page_index);
        let cache = super::manifest_cache(PlanningOperation::Analyze, None);
        assert!(super::page_cache_for(&translated, &cache).is_ok());
        assert!(!original.input_path.exists());
        fs::remove_file(materialized).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn production_stream_planning_reads_the_materialized_fifo_copy_once() {
        use crate::protocol::manifest_v3::{
            AnalysisPurpose, CanvasScope, Operation, RenderMode, VERSION,
        };
        use std::os::unix::fs::FileTypeExt;

        let root =
            std::env::temp_dir().join(format!("scan-cleanup-adapter-fifo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let fifo = root.join("source.fifo");
        let fifo_c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        assert!(fs::metadata(&fifo).unwrap().file_type().is_fifo());

        let page = crate::protocol::manifest_v3::Page {
            input_path: fifo.clone(),
            analysis_input_path: None,
            analysis_dpi: None,
            trusted_foreground_mask_path: None,
            trusted_mrc_background_path: None,
            outputs: Vec::new(),
            source_page_index: 0,
            page_metadata_path: root.join("page.json"),
            options: crate::CleanupOptions::default(),
            document_prior: None,
            detail_render_plan: None,
        };
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: vec![page],
        };
        let producer_path = fifo.clone();
        let producer = thread::spawn(move || {
            let mut source = fs::OpenOptions::new()
                .write(true)
                .open(producer_path)
                .unwrap();
            source.write_all(b"one materialized read").unwrap();
        });

        let reads = manifest
            .run_stream_page_jobs(|(_, descriptor)| {
                assert_ne!(descriptor.input_path, fifo);
                assert!(!descriptor.stream_input);
                Ok::<_, NativeError>(fs::read(&descriptor.input_path).unwrap())
            })
            .unwrap();
        producer.join().unwrap();

        assert_eq!(reads, vec![b"one materialized read".to_vec()]);
        assert!(fs::metadata(&fifo).unwrap().file_type().is_fifo());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn warning_mapping_keeps_wire_shape_and_rounds_scale_at_adapter_boundary() {
        use crate::engine::output_geometry::CanvasWarning;

        let warning = CanvasWarning::MatchedCanvasPaperDownscaled {
            paper_scale: 1.2345,
            document_canvas_width: 1000.0,
            document_canvas_height: 800.0,
            paper_width: Some(1100.0),
            paper_height: Some(900.0),
        };
        let json = serde_json::to_value(super::canvas_warning_to_protocol(warning)).unwrap();

        assert_eq!(json["code"], "matched-canvas-paper-downscaled");
        assert_eq!(json["unit"], "px");
        assert_eq!(json["scalePercentTenths"], 1234);
        assert_eq!(json["documentCanvasWidth"], 1000.0);
        assert_eq!(json["paperHeight"], 900.0);

        let fitted = CanvasWarning::MatchedCanvasContentFitted {
            content_width: 600.0,
            content_height: 500.0,
            inner_width: 952.0,
            inner_height: 952.0,
            document_canvas_width: Some(1000.0),
            document_canvas_height: Some(1000.0),
        };
        let fitted_json = serde_json::to_value(super::canvas_warning_to_protocol(fitted)).unwrap();
        assert_eq!(fitted_json["code"], "matched-canvas-content-fitted");
        assert_eq!(fitted_json["unit"], "px");
        assert_eq!(fitted_json["contentWidth"], 600.0);
        assert_eq!(fitted_json["documentCanvasHeight"], 1000.0);

        let margins = vec![
            super::canvas_warning_to_protocol(CanvasWarning::MatchedCanvasMarginsReduced),
            super::canvas_warning_to_protocol(CanvasWarning::MatchedCanvasMarginsUnavailable),
        ];
        let margins_json = serde_json::to_value(margins).unwrap();
        assert_eq!(margins_json[0]["code"], "matched-canvas-margins-reduced");
        assert_eq!(
            margins_json[1]["code"],
            "matched-canvas-margins-unavailable"
        );

        let edge = CanvasWarning::MatchedCanvasPaperDownscaled {
            paper_scale: 1.225,
            document_canvas_width: 1.0,
            document_canvas_height: 1.0,
            paper_width: None,
            paper_height: None,
        };
        let edge_json = serde_json::to_value(super::canvas_warning_to_protocol(edge)).unwrap();
        assert_eq!(edge_json["scalePercentTenths"], 1225);
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
            crate::png::encode_gray(&GrayImage::new(32, 24, 240)).unwrap(),
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
    fn strict_cli_parser_preserves_documented_invocations() {
        assert_eq!(
            parse_cli_args(&cli_args(&["--manifest", "/tmp/manifest.json"])).unwrap(),
            ScanCleanupCliInvocation::Manifest {
                path: PathBuf::from("/tmp/manifest.json"),
                allowed_path_root: None,
            },
        );
        assert_eq!(
            parse_cli_args(&cli_args(&[
                "--manifest",
                "/tmp/manifest.json",
                "--allowed-path-root",
                "/tmp/run-root",
            ]))
            .unwrap(),
            ScanCleanupCliInvocation::Manifest {
                path: PathBuf::from("/tmp/manifest.json"),
                allowed_path_root: Some(PathBuf::from("/tmp/run-root")),
            },
        );
        assert_eq!(
            parse_cli_args(&cli_args(&[
                "--ocr-mode",
                "--metadata",
                "/tmp/page.json",
                "--output",
                "/tmp/page.png",
                "--experimental-auto-dewarp",
                "--input",
                "/tmp/page.ppm",
                "--options",
                "{}",
            ]))
            .unwrap(),
            ScanCleanupCliInvocation::Direct {
                input: PathBuf::from("/tmp/page.ppm"),
                output: PathBuf::from("/tmp/page.png"),
                metadata: PathBuf::from("/tmp/page.json"),
                options: Some("{}".to_string()),
                ocr_mode: true,
                experimental_auto_dewarp: true,
            },
        );
    }

    #[test]
    fn strict_cli_parser_rejects_unknown_duplicate_missing_and_invalid_arguments() {
        let cases: &[(&[&str], &str)] = &[
            (&["--manifest"], "--manifest requires a value"),
            (&["--manifest", ""], "--manifest requires a value"),
            (
                &["--manifest", "/tmp/a.json", "--manifest", "/tmp/b.json"],
                "Duplicate argument --manifest",
            ),
            (
                &["--manifest", "/tmp/a.json", "--unknown"],
                "Unknown argument --unknown",
            ),
            (
                &["--manifest", "/tmp/a.json", "--input", "/tmp/page.ppm"],
                "--manifest cannot be combined with direct-mode arguments",
            ),
            (
                &["--input", "/tmp/page.ppm", "--output"],
                "--output requires a value",
            ),
            (
                &[
                    "--input",
                    "/tmp/page.ppm",
                    "--input",
                    "/tmp/other.ppm",
                    "--output",
                    "/tmp/page.png",
                    "--metadata",
                    "/tmp/page.json",
                ],
                "Duplicate argument --input",
            ),
            (
                &[
                    "--input",
                    "/tmp/page.ppm",
                    "--output",
                    "/tmp/page.png",
                    "--metadata",
                    "/tmp/page.json",
                    "--ocr-mode",
                    "true",
                ],
                "Unexpected positional argument true",
            ),
            (
                &["--allowed-path-root"],
                "--allowed-path-root requires a value",
            ),
            (
                &[
                    "--manifest",
                    "/tmp/a.json",
                    "--allowed-path-root",
                    "/tmp/root",
                    "--allowed-path-root",
                    "/tmp/other",
                ],
                "Duplicate argument --allowed-path-root",
            ),
            (
                &[
                    "--input",
                    "/tmp/page.ppm",
                    "--output",
                    "/tmp/page.png",
                    "--metadata",
                    "/tmp/page.json",
                    "--allowed-path-root",
                    "/tmp/root",
                ],
                "--allowed-path-root requires --manifest",
            ),
            (&["--input=page.ppm"], "Unknown argument --input=page.ppm"),
            (&["--version"], "Unknown argument --version"),
            (&["-V"], "Unexpected positional argument -V"),
            (&["unflagged"], "Unexpected positional argument unflagged"),
        ];

        for (args, expected) in cases {
            let error = parse_cli_args(&cli_args(args)).unwrap_err();
            assert_eq!(
                error.code,
                NativeErrorCode::InvalidRequest,
                "args: {args:?}"
            );
            assert_eq!(error.message, *expected, "args: {args:?}");
        }
    }

    #[test]
    fn strict_direct_cli_reports_each_required_value() {
        for (args, missing) in [
            (vec![], "--input"),
            (vec!["--input", "in.ppm"], "--output"),
            (
                vec!["--input", "in.ppm", "--output", "out.png"],
                "--metadata",
            ),
        ] {
            let error = parse_cli_args(&cli_args(&args)).unwrap_err();
            assert_eq!(error.code, NativeErrorCode::InvalidRequest);
            assert_eq!(
                error.message,
                format!("Missing required argument {missing}")
            );
        }
    }

    #[test]
    fn derived_geometry_guardrail_errors_are_too_large() {
        assert_eq!(
            map_image_error("Derived raster 100x100 exceeds cleanup guardrails".into()).code,
            NativeErrorCode::TooLarge,
        );
        assert_eq!(
            map_image_error("Derived content geometry must be finite".into()).code,
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
        let image = GrayImage::new(2, 1, 127);
        write_gray_layer_background(&path, &image).unwrap();
        let bytes = fs::read(&path).unwrap();
        let header = b"P5\n2 1\n255\n";
        assert!(bytes.starts_with(header));
        assert_eq!(&bytes[header.len()..], &[127, 127]);
        fs::remove_file(path).unwrap();
    }
}
