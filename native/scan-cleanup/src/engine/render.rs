pub use crate::domain::geometry::{AppliedMargins, PageHalf};
use crate::engine::prepare::{build_analysis_level, AnalysisLevel};
use crate::engine::render_plan::{
    content_result_for_dimensions, output_regions, ComposedRenderPlan,
};
use crate::engine::text_axis::{detect_text_axis, TextAxisHint};
use crate::mode_select::{
    has_pale_tonal_structure, independent_chroma_mask, is_blank_scan_candidate,
    is_line_art_picture, protect_bilevel_text_fidelity, qualifies_independent_outside_tone,
    recommend_output_mode_with_tone, should_veto_bilevel_fidelity, text_soft_edge_to_ink_ratio,
    veto_contradictory_mixed_ownership, OutputModeDiagnostics, OutputModeRecommendation,
    PreparedModeEvidence,
};
use crate::{
    auto_dewarp::detect_curves_at_dpi_with_depth,
    background::{
        normalize_illumination_for_layout_prepared, normalize_illumination_pair_with_masks,
        normalize_illumination_prepared_with_masks, normalize_illumination_rgb_with_masks,
        normalize_illumination_with_masks, normalize_region_with_reusable_model,
        normalize_rgb_region_with_reusable_model, prepare_illumination,
        reusable_illumination_model,
    },
    bw::{
        binarize_normalized_with_diagnostics, binarize_normalized_with_diagnostics_excluding,
        binary_to_gray, paper_reference, picture_protection_radius,
        postprocess_binary_with_diagnostics_and_raw, resolve_binarization_diagnostics,
        resolve_spread_binarization_plans, BinarizationDiagnostics, SpreadBinarizationPlan,
        BLEED_CRISPNESS_FLOOR, BLEED_SHALLOW_DEPTH, RULE_RAW_DEPTH,
    },
    cache::{PageCache, StageCacheKey},
    calibration::{CalibrationConfig, PageCalibration},
    content::{
        analyze_content_evidence_calibrated,
        detect_content_and_margins_calibrated_with_crop_authority,
    },
    deskew::{detect_skew, DeskewResult},
    dewarp::{
        rasterize_inverse_area_rgb_with, rasterize_inverse_area_with, DewarpModel, DEWARP_GRID_SIZE,
    },
    ink_consistency::{stabilize_trusted_stroke_mass, InkConsistencyDiagnostics},
    mrc::derive_halftone_zones,
    picture::{
        apply_manual_zones, detect_continuous_tone_mask, detect_picture_mask_with_continuous_tone,
        extend_picture_mask_for_content, extend_tone_mask_for_content,
        flat_graphic_tone_preservation_alpha, photo_tone_preservation_alpha, qualify_picture_owner,
        rectangularize_corroborated_photos, refine_line_art_preservation_alpha,
        refine_tone_preservation_alpha, resample_binary_mask_nearest,
        semantic_tone_preservation_alpha, veto_text_like_regions,
    },
    png::RgbImage,
    protocol::{
        manifest_v3::{ContentDiagnostics, DetailRenderPlan},
        progress::PageStageTimings,
    },
    split::{
        detect_split_at_analysis_level_with_threshold, DocumentPrior, LayoutClassification,
        ReconciliationMetadata, SplitDiagnostics, SplitResult, SPLIT_ANALYSIS_DPI,
    },
    text_tone::{
        apply_text_tone, apply_text_tone_excluding, derive_text_tone_diagnostics,
        outside_tonal_evidence_with_mask, OutsideTonalEvidence, TextToneDiagnostics,
    },
    CleanupOptions, OrthogonalRotation, OutputMode,
};
use rayon::prelude::*;
use scan_primitives::{
    distance::squared_euclidean_distance,
    morphology::{dilate, dilate_gray, erode, erode_gray},
    threshold::otsu_threshold,
    Affine, BinaryImage, ComponentMap, GrayImage, Point, Polygon, Rect,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{borrow::Cow, sync::Arc, time::Instant};

#[path = "render/document_analysis.rs"]
mod document_analysis;
#[path = "render/final_composition.rs"]
mod final_composition;
#[path = "render/fold_edge_filtering.rs"]
mod fold_edge_filtering;
#[path = "render/region_preparation.rs"]
mod region_preparation;
#[path = "render/region_rendering.rs"]
mod region_rendering;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DewarpMappingGrid {
    pub columns: usize,
    pub rows: usize,
    pub output_origin: Point,
    pub output_width: usize,
    pub output_height: usize,
    pub output_to_source: Vec<Point>,
    pub source_to_output: Vec<Point>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfImagePlacement {
    pub x_points: f64,
    pub y_points: f64,
    pub width_points: f64,
    pub height_points: f64,
}

/// Unit a warning event's physical extents are measured in. Native placement
/// works on the canvas pixel grid; the lossless path measures the same
/// conditions in PDF points.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WarningExtentUnit {
    Px,
    Pt,
}

/// Structured counterpart of `CleanupMetadata::warnings` for every condition
/// the pipeline aggregates or presents as a decision. Wording, units, and page
/// prefixes belong to the shared TypeScript formatter, so an event carries only
/// the parameters that sentence needs and never any user-facing text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CleanupWarningEvent {
    MatchedCanvasContentFitted {
        unit: WarningExtentUnit,
        content_width: f64,
        content_height: f64,
        inner_width: f64,
        inner_height: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        document_canvas_width: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        document_canvas_height: Option<f64>,
    },
    MatchedCanvasMarginsReduced,
    MatchedCanvasMarginsUnavailable,
    MatchedCanvasPaperDownscaled {
        unit: WarningExtentUnit,
        scale_percent_tenths: i64,
        document_canvas_width: f64,
        document_canvas_height: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        paper_width: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        paper_height: Option<f64>,
    },
    MatchedCanvasOpticalCenteringFallback,
    MatchedCanvasIntrinsicOverflow {
        left_px: usize,
        right_px: usize,
    },
    MatchedCanvasSpreadHeadroomTrimmed {
        top_px: usize,
    },
    MatchedCanvasFoldColumnsDiscarded {
        left_columns: usize,
        right_columns: usize,
    },
    RenderDpiLimited {
        applied_dpi_thousandths: i64,
        requested_dpi_thousandths: i64,
    },
}

/// Quantizes a measurement to `10^-decimals` units, rounding to nearest with
/// ties to even on the exact binary value — the rule this sidecar's own
/// `{:.N}` text followed before wording moved to TypeScript. Deciding the
/// digits here is what keeps them out of a formatter whose language resolves an
/// exact half the other way; the formatter only places the decimal point.
///
/// A non-finite measurement has no digits to report and quantizes to zero; a
/// magnitude past `i64` saturates, which the contract's own ceilings reject.
pub(crate) fn quantize_decimal(value: f64, decimals: u32) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    let scale = 10i128.pow(decimals);
    let bits = value.abs().to_bits();
    let biased_exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = i128::from(bits & ((1u64 << 52) - 1));
    // `value.abs()` is exactly `mantissa * 2^exponent`.
    let (mantissa, exponent) = if biased_exponent == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1i128 << 52), biased_exponent - 1075)
    };
    let scaled_mantissa = mantissa.saturating_mul(scale);
    let magnitude = if exponent >= 127 {
        i128::MAX
    } else if exponent >= 0 {
        scaled_mantissa.saturating_mul(1i128 << exponent)
    } else if -exponent >= 127 {
        // Below 2^-74 before scaling: less than half a quantum at any precision.
        0
    } else {
        let denominator = 1i128 << -exponent;
        let quotient = scaled_mantissa / denominator;
        let doubled_remainder = (scaled_mantissa % denominator) * 2;
        if doubled_remainder > denominator
            || (doubled_remainder == denominator && quotient % 2 == 1)
        {
            quotient + 1
        } else {
            quotient
        }
    };
    let clamped = magnitude.clamp(0, i128::from(i64::MAX)) as i64;
    if value.is_sign_negative() {
        -clamped
    } else {
        clamped
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupMetadata {
    pub source_page_index: usize,
    pub half: PageHalf,
    pub detected_skew_degrees: f64,
    pub skew_confidence: f64,
    pub skew_applied: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual_skew: bool,
    pub layout_classification: LayoutClassification,
    pub layout_confidence: f64,
    #[serde(rename = "cutterXPx")]
    pub cutter_x: Option<f64>,
    pub split_geometry: Vec<Polygon>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    #[serde(with = "pixel_rect_serde")]
    pub source_region: Rect,
    #[serde(with = "optional_pixel_rect_serde")]
    pub content_box: Option<Rect>,
    /// Applied crop in deskewed/dewarped page-region coordinates.
    #[serde(with = "pixel_rect_serde")]
    pub crop_rect: Rect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_diagnostics: Option<ContentDiagnostics>,
    pub applied_margins: AppliedMargins,
    #[serde(rename = "softMarginsPx")]
    pub soft_margins_pixels: [usize; 4],
    pub uniform_canvas: bool,
    #[serde(default)]
    pub canvas_policy: MatchedCanvasPolicy,
    #[serde(default)]
    pub canvas_overflow: bool,
    #[serde(default, rename = "matchedCanvasTargetWidthPx")]
    pub matched_canvas_target_width: Option<usize>,
    #[serde(default, rename = "matchedCanvasTargetHeightPx")]
    pub matched_canvas_target_height: Option<usize>,
    #[serde(default, rename = "matchedCanvasTargetWidthPoints")]
    pub matched_canvas_target_width_points: Option<f64>,
    #[serde(default, rename = "matchedCanvasTargetHeightPoints")]
    pub matched_canvas_target_height_points: Option<f64>,
    /// Size the intrinsic raster takes on the matched canvas. A final run has
    /// already resampled its raster to it; a preview reports it so the renderer
    /// presents the page at the document's scale without a second render.
    #[serde(default, rename = "matchedCanvasContentWidthPx")]
    pub matched_canvas_content_width: Option<usize>,
    #[serde(default, rename = "matchedCanvasContentHeightPx")]
    pub matched_canvas_content_height: Option<usize>,
    /// True when placement is anchored to the transformed optical content
    /// rather than requiring the retained white raster rectangle to fit.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub matched_canvas_optical_placement: bool,
    /// Horizontal optical bounds in the intrinsic raster coordinate space.
    /// Consumers use these with `intrinsicRasterWidthPx` to validate the
    /// optical placement in canvas pixels.
    #[serde(
        default,
        rename = "matchedCanvasOpticalContentLeftPx",
        skip_serializing_if = "Option::is_none"
    )]
    pub matched_canvas_optical_content_left: Option<f64>,
    #[serde(
        default,
        rename = "matchedCanvasOpticalContentRightPx",
        skip_serializing_if = "Option::is_none"
    )]
    pub matched_canvas_optical_content_right: Option<f64>,
    #[serde(
        default,
        rename = "matchedCanvasIntrinsicOverflowLeftPx",
        skip_serializing_if = "is_zero_usize"
    )]
    pub matched_canvas_intrinsic_overflow_left: usize,
    #[serde(
        default,
        rename = "matchedCanvasIntrinsicOverflowRightPx",
        skip_serializing_if = "is_zero_usize"
    )]
    pub matched_canvas_intrinsic_overflow_right: usize,
    #[serde(
        default,
        rename = "matchedCanvasIntrinsicOverflowTopPx",
        skip_serializing_if = "is_zero_usize"
    )]
    pub matched_canvas_intrinsic_overflow_top: usize,
    /// Canvas-grid columns excluded from the materialized source window at
    /// the fold edge. Preview consumers apply the same source clip.
    #[serde(
        default,
        rename = "foldClipLeftPx",
        skip_serializing_if = "is_zero_usize"
    )]
    pub fold_clip_left: usize,
    #[serde(
        default,
        rename = "foldClipRightPx",
        skip_serializing_if = "is_zero_usize"
    )]
    pub fold_clip_right: usize,
    /// Physical PDF rectangle for a source-grid continuous-tone raster. When
    /// absent, assemblers retain the legacy behavior of covering the MediaBox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_image_placement: Option<PdfImagePlacement>,
    pub output_mode: OutputMode,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bilevel_written: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub layered_written: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layered_foreground_kind: Option<LayeredForegroundKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layered_background_dpi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layered_foreground_dpi: Option<f64>,
    /// Compatibility field for the explicit lossless source path. Fresh
    /// raster cleanup never sets this bit, even when producer MRC layers are
    /// supplied as analysis hints.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trusted_mrc_background_preserved: bool,
    /// Compatibility field for legacy consumers. Fresh raster cleanup keeps
    /// producer selection masks as hints and never sets this bit.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trusted_selection_applied: bool,
    #[serde(default)]
    pub illumination_normalized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_tone_diagnostics: Option<TextToneDiagnostics>,
    pub binarization_mode: Option<crate::BinarizationMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binarization_diagnostics: Option<BinarizationDiagnostics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ink_consistency_diagnostics: Option<InkConsistencyDiagnostics>,
    #[serde(default)]
    pub despeckle_fallback: bool,
    pub forward_transform: Option<Affine>,
    pub inverse_transform: Option<Affine>,
    pub dewarp_model: Option<crate::DewarpOptions>,
    pub dewarp_mapping: Option<DewarpMappingGrid>,
    pub dewarp_confidence: Option<f64>,
    #[serde(rename = "inputWidthPx")]
    pub input_width: usize,
    #[serde(rename = "inputHeightPx")]
    pub input_height: usize,
    /// Intrinsic, unpadded cleaned-raster width.
    #[serde(rename = "outputWidthPx")]
    pub output_width: usize,
    /// Intrinsic, unpadded cleaned-raster height.
    #[serde(rename = "outputHeightPx")]
    pub output_height: usize,
    /// Width of the raster before matched-canvas materialization. The
    /// post-match output dimensions describe the content box, while this
    /// field keeps OCR and PDF geometry tied to the visible source raster.
    #[serde(
        default,
        rename = "intrinsicRasterWidthPx",
        skip_serializing_if = "Option::is_none"
    )]
    pub intrinsic_raster_width: Option<usize>,
    #[serde(
        default,
        rename = "intrinsicRasterHeightPx",
        skip_serializing_if = "Option::is_none"
    )]
    pub intrinsic_raster_height: Option<usize>,
    /// Actual preview payload bounds inside the full intrinsic output.
    #[serde(
        default,
        rename = "renderRegion",
        skip_serializing_if = "Option::is_none",
        with = "optional_pixel_rect_serde"
    )]
    pub render_region: Option<Rect>,
    #[serde(rename = "canvasWidthPx")]
    pub canvas_width: usize,
    #[serde(rename = "canvasHeightPx")]
    pub canvas_height: usize,
    #[serde(rename = "placementOffsetXPx")]
    pub placement_offset_x: usize,
    #[serde(rename = "placementOffsetYPx")]
    pub placement_offset_y: usize,
    #[serde(rename = "rotationDegrees")]
    pub rotation: OrthogonalRotation,
    #[serde(default)]
    pub canvas_scope: crate::protocol::manifest_v3::CanvasScope,
    pub resample_passes: usize,
    pub source_dpi: f64,
    pub render_dpi: f64,
    pub requested_render_dpi: f64,
    pub raster_scale_limited: bool,
    /// Unstructured diagnostics with no program logic or UI behind them.
    pub warnings: Vec<String>,
    #[serde(default)]
    pub warning_events: Vec<CleanupWarningEvent>,
}

fn is_zero_usize(value: &usize) -> bool {
    *value == 0
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchedCanvasPolicy {
    #[default]
    Intrinsic,
    StrictMaximum,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LayeredForegroundKind {
    Stencil,
    SoftAlpha,
    SourceMrc,
}

pub struct CleanupResult {
    pub image: CleanupRaster,
    pub color_image: Option<RgbImage>,
    pub metadata: CleanupMetadata,
    pub(crate) picture_mask: Option<BinaryImage>,
    pub(crate) tone_preservation_alpha: Option<GrayImage>,
    pub(crate) mixed_layers: Option<MixedLayers>,
    effectively_blank: bool,
}

/// The rendered page, in whichever representation produced it. A binarized page
/// stays in the binarizer's packed bits all the way to the PBM writer, which is
/// the same MSB-first layout; only consumers that need 8-bit samples widen it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CleanupRaster {
    Gray(GrayImage),
    Bilevel(BinaryImage),
}

impl CleanupRaster {
    pub fn width(&self) -> usize {
        match self {
            Self::Gray(image) => image.width(),
            Self::Bilevel(image) => image.width(),
        }
    }

    pub fn height(&self) -> usize {
        match self {
            Self::Gray(image) => image.height(),
            Self::Bilevel(image) => image.height(),
        }
    }

    pub fn get(&self, x: usize, y: usize) -> u8 {
        match self {
            Self::Gray(image) => image.get(x, y),
            Self::Bilevel(image) => {
                if image.get(x, y) {
                    0
                } else {
                    255
                }
            }
        }
    }

    pub fn bilevel(&self) -> Option<&BinaryImage> {
        match self {
            Self::Gray(_) => None,
            Self::Bilevel(image) => Some(image),
        }
    }

    pub fn to_gray(&self) -> Cow<'_, GrayImage> {
        match self {
            Self::Gray(image) => Cow::Borrowed(image),
            Self::Bilevel(image) => Cow::Owned(binary_to_gray(image)),
        }
    }

    pub fn into_gray(self) -> GrayImage {
        match self {
            Self::Gray(image) => image,
            Self::Bilevel(image) => binary_to_gray(&image),
        }
    }

    fn cropped(&self, rect: Rect) -> Self {
        match self {
            Self::Gray(image) => Self::Gray(crop_gray(image, rect)),
            Self::Bilevel(image) => Self::Bilevel(crop_binary(image, rect)),
        }
    }
}

pub(crate) struct MixedLayers {
    pub foreground_mask: BinaryImage,
    /// Eight-bit foreground opacity for undersampled antialiased text.
    /// When present, this is the authoritative foreground and the bilevel
    /// mask is retained only as diagnostic/fallback evidence.
    pub foreground_alpha: Option<GrayImage>,
    pub background: GrayImage,
    pub color_background: Option<RgbImage>,
    /// The assembler may replace this fresh foreground with the extracted
    /// source JPX through its authored smask. It is set only for confirmed
    /// photos whose page geometry remains affine and source-aligned.
    pub source_mrc: bool,
}

pub struct PageCleanupResult {
    pub outputs: Vec<CleanupResult>,
    pub classification: LayoutClassification,
    pub layout_confidence: f64,
    pub cutter_x: Option<f64>,
    pub split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    pub reconciliation: ReconciliationMetadata,
    pub split_diagnostics: SplitDiagnostics,
    pub blank_outputs_skipped: usize,
    pub excluded: bool,
    pub rotation: OrthogonalRotation,
    pub output_mode_recommendation: Option<OutputModeRecommendation>,
}

pub(crate) struct DetailRenderSources<'a> {
    pub source_crop: &'a GrayImage,
    pub color_source_crop: Option<&'a RgbImage>,
    pub base_source: &'a GrayImage,
    pub base_color_source: Option<&'a RgbImage>,
    pub base_cleaned: Option<(&'a GrayImage, Option<&'a RgbImage>)>,
}

pub(crate) fn clean_detail_page_with_color(
    sources: DetailRenderSources<'_>,
    options: &CleanupOptions,
    source_page_index: usize,
    plan: &DetailRenderPlan,
    base_metadata: &CleanupMetadata,
    timings: &mut PageStageTimings,
) -> Result<PageCleanupResult, AnalysisError> {
    let DetailRenderSources {
        source_crop,
        color_source_crop,
        base_source,
        base_color_source,
        base_cleaned,
    } = sources;
    options.validate()?;
    if options.output_mode == OutputMode::Mixed {
        return Err("Mixed-mode detail rendering requires the full-page picture mask".into());
    }
    if options.output_mode == OutputMode::Auto {
        return Err("Detail rendering requires an output mode resolved from the full page".into());
    }
    if !options.manual_zones.picture.is_empty() || !options.manual_zones.fill.is_empty() {
        return Err("Detail rendering with manual zones requires the full-page source".into());
    }
    let scale = plan.scale;
    let source_crop_rect = plan.source_crop.as_rect();
    let render_region = plan.render_region.as_rect();
    let sampled_region = plan.sampled_region.as_rect();
    if source_crop_rect.width.ceil() as usize != source_crop.width()
        || source_crop_rect.height.ceil() as usize != source_crop.height()
    {
        return Err("Detail source crop dimensions do not match its raster".into());
    }
    let canonical_replay = base_cleaned.filter(|_| {
        matches!(
            options.output_mode,
            OutputMode::Grayscale | OutputMode::Color
        )
    });
    let normalized_gray;
    let normalized_color;
    let processing_source = if canonical_replay.is_some() {
        normalized_color = color_source_crop.cloned();
        source_crop
    } else if options.normalize_illumination {
        let rotated_base = rotate_orthogonal(base_source, options.rotation);
        let model = reusable_illumination_model(&rotated_base);
        let coordinate = |x, y| {
            rotated_normalized_detail_coordinate(
                source_crop_rect.x + x as f64,
                source_crop_rect.y + y as f64,
                plan.full_source_width_px,
                plan.full_source_height_px,
                options.rotation,
            )
        };
        normalized_gray = normalize_region_with_reusable_model(source_crop, &model, coordinate);
        normalized_color = color_source_crop.map(|source| {
            normalize_rgb_region_with_reusable_model(source_crop, source, &model, coordinate)
        });
        &normalized_gray
    } else {
        normalized_color = color_source_crop.cloned();
        source_crop
    };
    let processing_color = normalized_color.as_ref();
    let sampled_width = sampled_region.width.ceil().max(1.0) as usize;
    let sampled_height = sampled_region.height.ceil().max(1.0) as usize;
    let map_output = |point: Point| {
        let target_output = Point::new(sampled_region.x + point.x, sampled_region.y + point.y);
        let base_output = Point::new(target_output.x / scale, target_output.y / scale);
        let rotated_source = if let Some(inverse) = base_metadata.inverse_transform {
            inverse.apply(base_output)
        } else if let Some(grid) = &base_metadata.dewarp_mapping {
            interpolate_dewarp_output_to_source(grid, base_output)?
        } else {
            return None;
        };
        let base_source = inverse_rotate_point(
            rotated_source,
            base_metadata.input_width,
            base_metadata.input_height,
            base_metadata.rotation,
        );
        let cropped = Point::new(
            base_source.x * scale - source_crop_rect.x,
            base_source.y * scale - source_crop_rect.y,
        );
        Some(cropped)
    };
    let mut mapped_gray =
        rasterize_inverse_area_with(processing_source, sampled_width, sampled_height, map_output);
    let mut mapped_color = processing_color.map(|source| {
        rasterize_inverse_area_rgb_with(source, sampled_width, sampled_height, map_output)
    });
    if let Some((base_cleaned_gray, base_cleaned_color)) = canonical_replay {
        replay_canonical_detail_transfer(
            &mut mapped_gray,
            mapped_color.as_mut(),
            base_source,
            base_color_source,
            base_cleaned_gray,
            base_cleaned_color,
            sampled_region,
            scale,
            base_metadata,
        );
    }

    // Geometry is replayed from the trusted base metadata above. Reuse the
    // ordinary cleanup pipeline for tonal normalization, binarization,
    // thickness, and despeckle so detail tiles cannot grow a second processing
    // implementation, but skip the layout analysis the replayed geometry
    // already answers.
    let mut tile_options = options.clone();
    tile_options.render_crop = None;
    tile_options.rotation = OrthogonalRotation::None;
    tile_options.layout = crate::LayoutMode::Single;
    tile_options.manual_split_x = None;
    tile_options.automatic_split = None;
    tile_options.manual_skew_degrees = Some(0.0);
    tile_options.manual_content_boxes = Default::default();
    tile_options.automatic_skew_degrees = Default::default();
    tile_options.automatic_content_boxes = Default::default();
    tile_options.manual_zones = Default::default();
    tile_options.normalize_illumination = false;
    tile_options.crop_content = false;
    tile_options.match_page_size = false;
    tile_options.margins_mm = None;
    tile_options.margins_pixels = None;
    tile_options.dewarp = None;
    tile_options.experimental = Default::default();
    // The detail tile applies the canonical full-page curve below. Leaving
    // reusable page-plan tone evidence here would apply the same LUT once in
    // the ordinary pipeline and then a second time after geometry replay.
    tile_options.resolved_text_tone_diagnostics = Default::default();
    tile_options.skip_blank_pages = false;
    let mut processed = clean_page_with_color_and_calibration_config(
        &mapped_gray,
        mapped_color.as_ref(),
        None,
        None,
        None,
        &tile_options,
        source_page_index,
        CalibrationConfig::default(),
        None,
        None,
        PageRenderPolicy::DETAIL_TILE,
        timings,
    )?;
    let mut output = processed
        .outputs
        .pop()
        .ok_or("Detail processing produced no output")?;
    if canonical_replay.is_none() {
        if let (CleanupRaster::Gray(image), Some(diagnostics)) =
            (&mut output.image, base_metadata.text_tone_diagnostics)
        {
            apply_text_tone(image, diagnostics);
        }
    }
    let payload_rect = Rect::new(
        render_region.x - sampled_region.x,
        render_region.y - sampled_region.y,
        render_region.width,
        render_region.height,
    );
    output.image = output.image.cropped(payload_rect);
    output.color_image = output
        .color_image
        .map(|image| crop_rgb(&image, payload_rect));
    output.picture_mask = output
        .picture_mask
        .map(|mask| crop_binary(&mask, payload_rect));
    output.mixed_layers = output.mixed_layers.map(|layers| MixedLayers {
        foreground_mask: crop_binary(&layers.foreground_mask, payload_rect),
        foreground_alpha: layers
            .foreground_alpha
            .map(|alpha| crop_gray(&alpha, payload_rect)),
        background: crop_gray(&layers.background, payload_rect),
        color_background: layers
            .color_background
            .map(|image| crop_rgb(&image, payload_rect)),
        source_mrc: layers.source_mrc,
    });

    let mut metadata = scale_detail_metadata(base_metadata, scale);
    metadata.source_page_index = source_page_index;
    metadata.render_region = Some(render_region);
    metadata.input_width = plan.full_source_width_px;
    metadata.input_height = plan.full_source_height_px;
    metadata.output_mode = output.metadata.output_mode;
    metadata.binarization_mode = output.metadata.binarization_mode;
    metadata.binarization_diagnostics = output.metadata.binarization_diagnostics;
    metadata.despeckle_fallback = output.metadata.despeckle_fallback;
    metadata.illumination_normalized = base_metadata.illumination_normalized;
    metadata.source_dpi = options.source_dpi();
    metadata.render_dpi = options.dpi;
    metadata.requested_render_dpi = options.requested_render_dpi();
    metadata.raster_scale_limited = options.dpi + f64::EPSILON < options.requested_render_dpi();
    metadata.canvas_scope = crate::protocol::manifest_v3::CanvasScope::Page;
    metadata.warnings = output.metadata.warnings;
    metadata.warning_events = output.metadata.warning_events;
    output.metadata = metadata;
    output.effectively_blank = false;

    let classification = base_metadata.layout_classification;
    let split_seam = base_metadata.split_seam.as_ref().map(|seam| {
        let mut seam = seam.clone();
        for point in &mut seam.points {
            point.x *= scale;
            point.y *= scale;
        }
        seam
    });
    Ok(PageCleanupResult {
        outputs: vec![output],
        classification,
        layout_confidence: base_metadata.layout_confidence,
        cutter_x: base_metadata.cutter_x.map(|x| x * scale),
        split_seam,
        reconciliation: ReconciliationMetadata {
            tier1_verdict: classification,
            reconciled: false,
            cluster_agreement: 0.0,
        },
        split_diagnostics: SplitDiagnostics::default(),
        blank_outputs_skipped: 0,
        excluded: false,
        rotation: base_metadata.rotation,
        output_mode_recommendation: None,
    })
}

#[derive(Clone, Copy)]
struct CanonicalTransferTap {
    weight: f64,
    gray_gain: f64,
    color_gain: Option<[f64; 3]>,
}

/// Replays the completed base preview's actual source-to-cleaned transfer.
///
/// The base raster already contains every page-global decision: protected
/// picture/tone masks, paper calibration, cover policy, and the text-tone
/// curve. A detail tile therefore samples that transfer instead of refitting
/// those decisions on a viewport crop. Around a discontinuity, only taps from
/// the nearest tap's gain class contribute; this keeps a paper whitening gain
/// from bleeding into a protected photograph (and vice versa).
#[allow(clippy::too_many_arguments)]
fn replay_canonical_detail_transfer(
    detail_gray: &mut GrayImage,
    detail_color: Option<&mut RgbImage>,
    base_source: &GrayImage,
    base_color_source: Option<&RgbImage>,
    base_cleaned_gray: &GrayImage,
    base_cleaned_color: Option<&RgbImage>,
    sampled_region: Rect,
    scale: f64,
    base_metadata: &CleanupMetadata,
) {
    const GAIN_CLASS_TOLERANCE: f64 = 0.18;
    let width = detail_gray.width();
    let stride = detail_gray.stride();
    if width == 0 || detail_gray.height() == 0 {
        return;
    }
    let process_row = |y: usize, gray_row: &mut [u8], mut color_row: Option<&mut [u8]>| {
        for x in 0..width {
            let base_output = Point::new(
                (sampled_region.x + x as f64) / scale,
                (sampled_region.y + y as f64) / scale,
            );
            let taps = canonical_transfer_taps(
                base_output,
                base_source,
                base_color_source,
                base_cleaned_gray,
                base_cleaned_color,
                base_metadata,
            );
            let reference = taps[0].map_or(1.0, |tap| tap.gray_gain);
            let mut gray_weight = 0.0;
            let mut gray_gain = 0.0;
            for tap in taps.into_iter().flatten() {
                if (tap.gray_gain - reference).abs() <= GAIN_CLASS_TOLERANCE {
                    gray_weight += tap.weight;
                    gray_gain += tap.weight * tap.gray_gain;
                }
            }
            let gray_gain = if gray_weight > f64::EPSILON {
                gray_gain / gray_weight
            } else {
                reference
            };
            gray_row[x] = (f64::from(gray_row[x]) * gray_gain)
                .round()
                .clamp(0.0, 255.0) as u8;

            let Some(color_row) = color_row.as_deref_mut() else {
                continue;
            };
            let pixel = &mut color_row[x * 3..x * 3 + 3];
            let source_pixel: [u8; 3] = (&*pixel).try_into().expect("rgb pixel width");
            let reference_color = taps[0].and_then(|tap| tap.color_gain);
            let mut target = source_pixel;
            for channel in 0..3 {
                let reference_gain = reference_color.map_or(gray_gain, |gain| gain[channel]);
                let mut weight = 0.0;
                let mut gain = 0.0;
                for tap in taps.into_iter().flatten() {
                    let tap_gain = tap
                        .color_gain
                        .map_or(tap.gray_gain, |values| values[channel]);
                    if (tap_gain - reference_gain).abs() <= GAIN_CLASS_TOLERANCE {
                        weight += tap.weight;
                        gain += tap.weight * tap_gain;
                    }
                }
                let gain = if weight > f64::EPSILON {
                    gain / weight
                } else {
                    reference_gain
                };
                target[channel] = (f64::from(source_pixel[channel]) * gain)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
            pixel.copy_from_slice(&target);
        }
    };
    match detail_color {
        Some(color) => {
            detail_gray
                .data_mut()
                .par_chunks_mut(stride)
                .zip(color.data_mut().par_chunks_mut(width * 3))
                .enumerate()
                .for_each(|(y, (gray_row, color_row))| process_row(y, gray_row, Some(color_row)));
        }
        None => {
            detail_gray
                .data_mut()
                .par_chunks_mut(stride)
                .enumerate()
                .for_each(|(y, gray_row)| process_row(y, gray_row, None));
        }
    }
}

fn canonical_transfer_taps(
    base_output: Point,
    base_source: &GrayImage,
    base_color_source: Option<&RgbImage>,
    base_cleaned_gray: &GrayImage,
    base_cleaned_color: Option<&RgbImage>,
    base_metadata: &CleanupMetadata,
) -> [Option<CanonicalTransferTap>; 4] {
    let maximum_x = base_cleaned_gray.width().saturating_sub(1) as f64;
    let maximum_y = base_cleaned_gray.height().saturating_sub(1) as f64;
    let x = base_output.x.clamp(0.0, maximum_x);
    let y = base_output.y.clamp(0.0, maximum_y);
    let left = x.floor() as usize;
    let top = y.floor() as usize;
    let right = (left + 1).min(base_cleaned_gray.width().saturating_sub(1));
    let bottom = (top + 1).min(base_cleaned_gray.height().saturating_sub(1));
    let tx = x - left as f64;
    let ty = y - top as f64;
    let coordinates = [
        (left, top, (1.0 - tx) * (1.0 - ty)),
        (right, top, tx * (1.0 - ty)),
        (left, bottom, (1.0 - tx) * ty),
        (right, bottom, tx * ty),
    ];
    coordinates.map(|(output_x, output_y, weight)| {
        let source_point = base_output_to_unrotated_source(
            base_metadata,
            Point::new(output_x as f64, output_y as f64),
        )?;
        let source_gray =
            sample_bilinear_white(base_source, source_point.x + 0.5, source_point.y + 0.5);
        let cleaned_gray = base_cleaned_gray.get(output_x, output_y);
        let gray_gain = transfer_gain(source_gray, cleaned_gray);
        let color_gain = base_color_source
            .zip(base_cleaned_color)
            .map(|(source, cleaned)| {
                let source_pixel =
                    sample_bilinear_rgb_white(source, source_point.x + 0.5, source_point.y + 0.5);
                let cleaned_pixel = cleaned.get(
                    output_x.min(cleaned.width().saturating_sub(1)),
                    output_y.min(cleaned.height().saturating_sub(1)),
                );
                std::array::from_fn(|channel| {
                    transfer_gain(source_pixel[channel], cleaned_pixel[channel])
                })
            });
        Some(CanonicalTransferTap {
            weight,
            gray_gain,
            color_gain,
        })
    })
}

fn transfer_gain(source: u8, cleaned: u8) -> f64 {
    if source <= 4 {
        if cleaned <= 4 {
            1.0
        } else {
            f64::from(cleaned) / 4.0
        }
    } else {
        f64::from(cleaned) / f64::from(source)
    }
}

fn base_output_to_unrotated_source(metadata: &CleanupMetadata, output: Point) -> Option<Point> {
    let rotated_source = if let Some(inverse) = metadata.inverse_transform {
        inverse.apply(output)
    } else if let Some(grid) = &metadata.dewarp_mapping {
        interpolate_dewarp_output_to_source(grid, output)?
    } else {
        return None;
    };
    Some(inverse_rotate_point(
        rotated_source,
        metadata.input_width,
        metadata.input_height,
        metadata.rotation,
    ))
}

fn rotated_normalized_detail_coordinate(
    x: f64,
    y: f64,
    source_width: usize,
    source_height: usize,
    rotation: OrthogonalRotation,
) -> (f64, f64) {
    let (rotated_x, rotated_y, rotated_width, rotated_height) = match rotation {
        OrthogonalRotation::None => (x, y, source_width, source_height),
        OrthogonalRotation::Clockwise90 => (
            source_height as f64 - 1.0 - y,
            x,
            source_height,
            source_width,
        ),
        OrthogonalRotation::Clockwise180 => (
            source_width as f64 - 1.0 - x,
            source_height as f64 - 1.0 - y,
            source_width,
            source_height,
        ),
        OrthogonalRotation::Clockwise270 => (
            y,
            source_width as f64 - 1.0 - x,
            source_height,
            source_width,
        ),
    };
    (
        rotated_x / rotated_width.saturating_sub(1).max(1) as f64,
        rotated_y / rotated_height.saturating_sub(1).max(1) as f64,
    )
}

fn inverse_rotate_point(
    point: Point,
    source_width: usize,
    source_height: usize,
    rotation: OrthogonalRotation,
) -> Point {
    // Pixel-index convention: a W x H image occupies indices 0..W-1, 0..H-1,
    // matching the forward transform above; "W - x" instead of "W-1 - x"
    // shifts every rotated detail tile by one pixel and clips the far edge.
    match rotation {
        OrthogonalRotation::None => point,
        OrthogonalRotation::Clockwise90 => {
            Point::new(point.y, source_height as f64 - 1.0 - point.x)
        }
        OrthogonalRotation::Clockwise180 => Point::new(
            source_width as f64 - 1.0 - point.x,
            source_height as f64 - 1.0 - point.y,
        ),
        OrthogonalRotation::Clockwise270 => {
            Point::new(source_width as f64 - 1.0 - point.y, point.x)
        }
    }
}

fn interpolate_dewarp_output_to_source(grid: &DewarpMappingGrid, output: Point) -> Option<Point> {
    if grid.columns < 2 || grid.rows < 2 || grid.output_width == 0 || grid.output_height == 0 {
        return None;
    }
    let grid_x = (output.x / grid.output_width as f64 * (grid.columns - 1) as f64)
        .clamp(0.0, (grid.columns - 1) as f64);
    let grid_y = (output.y / grid.output_height as f64 * (grid.rows - 1) as f64)
        .clamp(0.0, (grid.rows - 1) as f64);
    let left = grid_x.floor() as usize;
    let top = grid_y.floor() as usize;
    let right = (left + 1).min(grid.columns - 1);
    let bottom = (top + 1).min(grid.rows - 1);
    let tx = grid_x - left as f64;
    let ty = grid_y - top as f64;
    let at = |column: usize, row: usize| {
        grid.output_to_source
            .get(row * grid.columns + column)
            .copied()
    };
    let top_left = at(left, top)?;
    let top_right = at(right, top)?;
    let bottom_left = at(left, bottom)?;
    let bottom_right = at(right, bottom)?;
    Some(Point::new(
        (top_left.x * (1.0 - tx) + top_right.x * tx) * (1.0 - ty)
            + (bottom_left.x * (1.0 - tx) + bottom_right.x * tx) * ty,
        (top_left.y * (1.0 - tx) + top_right.y * tx) * (1.0 - ty)
            + (bottom_left.y * (1.0 - tx) + bottom_right.y * tx) * ty,
    ))
}

fn scale_detail_metadata(base: &CleanupMetadata, scale: f64) -> CleanupMetadata {
    let mut metadata = base.clone();
    let scale_rect = |rect: Rect| {
        Rect::new(
            rect.x * scale,
            rect.y * scale,
            rect.width * scale,
            rect.height * scale,
        )
    };
    metadata.source_region = scale_rect(metadata.source_region);
    metadata.content_box = metadata.content_box.map(scale_rect);
    metadata.crop_rect = scale_rect(metadata.crop_rect);
    metadata.applied_margins.left_px *= scale;
    metadata.applied_margins.top_px *= scale;
    metadata.applied_margins.right_px *= scale;
    metadata.applied_margins.bottom_px *= scale;
    metadata.soft_margins_pixels = metadata
        .soft_margins_pixels
        .map(|value| (value as f64 * scale).round() as usize);
    for transform in [
        metadata.forward_transform.as_mut(),
        metadata.inverse_transform.as_mut(),
    ]
    .into_iter()
    .flatten()
    {
        transform.matrix[0][2] *= scale;
        transform.matrix[1][2] *= scale;
    }
    if let Some(mapping) = &mut metadata.dewarp_mapping {
        mapping.output_origin.x *= scale;
        mapping.output_origin.y *= scale;
        mapping.output_width = (mapping.output_width as f64 * scale).round().max(1.0) as usize;
        mapping.output_height = (mapping.output_height as f64 * scale).round().max(1.0) as usize;
        for point in mapping
            .output_to_source
            .iter_mut()
            .chain(&mut mapping.source_to_output)
        {
            point.x *= scale;
            point.y *= scale;
        }
    }
    metadata.output_width = (metadata.output_width as f64 * scale).round().max(1.0) as usize;
    metadata.output_height = (metadata.output_height as f64 * scale).round().max(1.0) as usize;
    metadata.intrinsic_raster_width = metadata
        .intrinsic_raster_width
        .map(|value| (value as f64 * scale).round().max(1.0) as usize);
    metadata.intrinsic_raster_height = metadata
        .intrinsic_raster_height
        .map(|value| (value as f64 * scale).round().max(1.0) as usize);
    metadata.canvas_width = metadata.output_width;
    metadata.canvas_height = metadata.output_height;
    metadata.placement_offset_x = 0;
    metadata.placement_offset_y = 0;
    metadata.matched_canvas_target_width = None;
    metadata.matched_canvas_target_height = None;
    metadata.matched_canvas_target_width_points = None;
    metadata.matched_canvas_target_height_points = None;
    metadata.matched_canvas_content_width = None;
    metadata.matched_canvas_content_height = None;
    metadata.matched_canvas_optical_placement = false;
    metadata.matched_canvas_optical_content_left = None;
    metadata.matched_canvas_optical_content_right = None;
    metadata.matched_canvas_intrinsic_overflow_left = 0;
    metadata.matched_canvas_intrinsic_overflow_right = 0;
    metadata.matched_canvas_intrinsic_overflow_top = 0;
    metadata.fold_clip_left = 0;
    metadata.fold_clip_right = 0;
    metadata.canvas_policy = MatchedCanvasPolicy::Intrinsic;
    metadata.canvas_overflow = false;
    metadata
}

pub struct PageClassificationResult {
    pub classification: LayoutClassification,
    pub confidence: f64,
    pub cutter_x: Option<f64>,
    pub split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    pub excluded: bool,
    pub rotation: OrthogonalRotation,
    pub reconciliation: ReconciliationMetadata,
    pub split_diagnostics: SplitDiagnostics,
    pub rotated_width: usize,
    pub rotated_height: usize,
    pub candidate_cutter_ratio: Option<f64>,
    pub whitespace_score: f64,
    pub text_axis: Option<TextAxisHint>,
    pub output_mode_recommendation: Option<OutputModeRecommendation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOutputMetadata {
    pub half: PageHalf,
    #[serde(with = "pixel_rect_serde")]
    pub source_region: Rect,
    #[serde(with = "optional_pixel_rect_serde")]
    pub content_box: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_diagnostics: Option<ContentDiagnostics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_tone_diagnostics: Option<TextToneDiagnostics>,
    #[serde(with = "pixel_rect_serde")]
    pub crop_rect: Rect,
    pub applied_margins: AppliedMargins,
    #[serde(rename = "inputWidthPx")]
    pub input_width: usize,
    #[serde(rename = "inputHeightPx")]
    pub input_height: usize,
}

mod pixel_rect_serde {
    use super::*;

    #[derive(Deserialize, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PixelRect {
        x_px: f64,
        y_px: f64,
        width_px: f64,
        height_px: f64,
    }

    pub fn serialize<S>(rect: &Rect, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        PixelRect {
            x_px: rect.x,
            y_px: rect.y,
            width_px: rect.width,
            height_px: rect.height,
        }
        .serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Rect, D::Error>
    where
        D: Deserializer<'de>,
    {
        let rect = PixelRect::deserialize(deserializer)?;
        Ok(Rect::new(
            rect.x_px,
            rect.y_px,
            rect.width_px,
            rect.height_px,
        ))
    }
}

mod optional_pixel_rect_serde {
    use super::*;

    pub fn serialize<S>(rect: &Option<Rect>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match rect {
            Some(rect) => serializer.serialize_some(&PixelRectRef(rect)),
            None => serializer.serialize_none(),
        }
    }

    struct PixelRectRef<'a>(&'a Rect);

    impl Serialize for PixelRectRef<'_> {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            pixel_rect_serde::serialize(self.0, serializer)
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Rect>, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct PixelRect {
            x_px: f64,
            y_px: f64,
            width_px: f64,
            height_px: f64,
        }
        Ok(Option::<PixelRect>::deserialize(deserializer)?
            .map(|rect| Rect::new(rect.x_px, rect.y_px, rect.width_px, rect.height_px)))
    }
}

pub struct PageAnalysisResult {
    pub outputs: Vec<AnalysisOutputMetadata>,
    pub classification: LayoutClassification,
    pub confidence: f64,
    pub cutter_x: Option<f64>,
    pub split_seam: Option<crate::protocol::manifest_v3::SplitSeamPolyline>,
    pub excluded: bool,
    pub rotation: OrthogonalRotation,
    pub reconciliation: ReconciliationMetadata,
    pub split_diagnostics: SplitDiagnostics,
    pub rotated_width: usize,
    pub rotated_height: usize,
    /// Page-local calibration evidence carried into the batch document plan.
    /// The batch layer takes a robust median before serializing it into the
    /// document prior used by final spread rendering.
    pub calibration_stroke_width_px: Option<f64>,
    pub calibration_x_height_px: Option<f64>,
    pub candidate_cutter_ratio: Option<f64>,
    pub whitespace_score: f64,
    pub text_axis: Option<TextAxisHint>,
    pub output_mode_recommendation: Option<OutputModeRecommendation>,
}

#[derive(Debug)]
pub(crate) enum AnalysisError {
    Invalid(String),
    TooLarge(String),
}

impl std::fmt::Display for AnalysisError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) | Self::TooLarge(message) => formatter.write_str(message),
        }
    }
}

impl AnalysisError {
    #[cfg(test)]
    fn contains(&self, pattern: &str) -> bool {
        self.to_string().contains(pattern)
    }
}

impl From<&str> for AnalysisError {
    fn from(message: &str) -> Self {
        Self::Invalid(message.to_owned())
    }
}

impl From<String> for AnalysisError {
    fn from(message: String) -> Self {
        Self::Invalid(message)
    }
}

impl From<crate::domain::options::DerivedRasterError> for AnalysisError {
    fn from(error: crate::domain::options::DerivedRasterError) -> Self {
        match error {
            crate::domain::options::DerivedRasterError::Invalid(message) => Self::Invalid(message),
            crate::domain::options::DerivedRasterError::TooLarge(message) => {
                Self::TooLarge(message)
            }
        }
    }
}

struct PreparedPage<'a> {
    /// `None` when the rotated source and `normalized` are the same buffer.
    rotated_source: Option<Cow<'a, GrayImage>>,
    normalized: Arc<GrayImage>,
    analysis_normalized: Option<Arc<GrayImage>>,
    canonical_routing_source: Arc<GrayImage>,
    canonical_routing_dpi: f64,
    canonical_regions: Vec<(Rect, PageHalf)>,
    has_canonical_analysis: bool,
    analysis_scale_x: f64,
    analysis_scale_y: f64,
    calibration: PageCalibration,
    rotated_color: Option<RgbImage>,
    content_picture_mask: Option<Arc<BinaryImage>>,
    picture_mask: Option<Arc<BinaryImage>>,
    halftone_zone_mask: Option<Arc<BinaryImage>>,
    spatial_tone_mask: Option<Arc<BinaryImage>>,
    chroma_picture_mask: Option<Arc<BinaryImage>>,
    tone_picture_mask: Option<Arc<BinaryImage>>,
    tone_preservation_alpha: Option<Arc<GrayImage>>,
    text_mask: Option<Arc<BinaryImage>>,
    text_vicinity_mask: Option<Arc<BinaryImage>>,
    trusted_foreground_mask: Option<BinaryImage>,
    split: SplitResult,
    split_cache_key: Option<StageCacheKey>,
    source_effectively_blank: bool,
    output_mode_recommendation: Option<OutputModeRecommendation>,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    resolved_output_mode: OutputMode,
}

struct PreparedAnalysis {
    normalized: Arc<GrayImage>,
    canonical_routing_source: Arc<GrayImage>,
    split: SplitResult,
    scale_x: f64,
    scale_y: f64,
    full_width: usize,
    full_height: usize,
    calibration: PageCalibration,
    canonical_routing_dpi: f64,
    candidate_cutter_ratio: Option<f64>,
    whitespace_score: f64,
    text_axis: Option<TextAxisHint>,
    content_picture_mask: Option<Arc<BinaryImage>>,
    picture_mask: Option<Arc<BinaryImage>>,
    halftone_zone_mask: Option<Arc<BinaryImage>>,
    spatial_tone_mask: Option<Arc<BinaryImage>>,
    chroma_picture_mask: Option<Arc<BinaryImage>>,
    tonal_protection_mask: Option<Arc<BinaryImage>>,
    semantic_preservation_alpha: Option<Arc<GrayImage>>,
    photo_preservation_alpha: Option<Arc<GrayImage>>,
    tone_preservation_alpha: Option<Arc<GrayImage>>,
    text_mask: Option<Arc<BinaryImage>>,
    text_vicinity_mask: Option<Arc<BinaryImage>>,
    split_cache_key: Option<StageCacheKey>,
    source_effectively_blank: bool,
    output_mode_recommendation: Option<OutputModeRecommendation>,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    resolved_output_mode: OutputMode,
}

struct AnalysisArtifact {
    normalized: Arc<GrayImage>,
    layout_normalized: Arc<GrayImage>,
    canonical_routing_source: Arc<GrayImage>,
    scale_x: f64,
    scale_y: f64,
    full_width: usize,
    full_height: usize,
    calibration: PageCalibration,
    effective_dpi: f64,
    canonical_routing_dpi: f64,
    picture_mask: Option<Arc<BinaryImage>>,
    halftone_zone_mask: Option<Arc<BinaryImage>>,
    spatial_tone_mask: Option<Arc<BinaryImage>>,
    chroma_picture_mask: Option<Arc<BinaryImage>>,
    tonal_protection_mask: Option<Arc<BinaryImage>>,
    semantic_preservation_alpha: Option<Arc<GrayImage>>,
    photo_preservation_alpha: Option<Arc<GrayImage>>,
    tone_preservation_alpha: Option<Arc<GrayImage>>,
    text_mask: Option<Arc<BinaryImage>>,
    text_vicinity_mask: Option<Arc<BinaryImage>>,
    content_picture_mask: Option<Arc<BinaryImage>>,
    source_effectively_blank: bool,
    output_mode_recommendation: Option<OutputModeRecommendation>,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    resolved_output_mode: OutputMode,
    analysis_threshold: Option<u8>,
    text_axis: Option<TextAxisHint>,
}

/// A fixed source plane for every decision that must not move with output DPI.
/// PDF callers provide one Poppler render; image callers omit it because their
/// input raster is already fixed.
pub struct CanonicalAnalysisPlane<'a> {
    pub gray: &'a GrayImage,
    pub color: Option<&'a RgbImage>,
    pub dpi: f64,
}

fn union_optional_masks(
    left: Option<&Arc<BinaryImage>>,
    right: Option<&Arc<BinaryImage>>,
) -> Option<Arc<BinaryImage>> {
    match (left, right) {
        (Some(left), Some(right)) => Some(Arc::new(left.or(right))),
        (Some(mask), None) | (None, Some(mask)) => Some(Arc::clone(mask)),
        (None, None) => None,
    }
}

/// Every subtractive pass below binarization judges ink by local evidence
/// alone, and nothing measured the page as a whole, so one systematic
/// misjudgement could empty a leaf with no signal that anything went wrong.
/// The floor is scoped to ink the page's own text and picture ownership masks
/// claim: discarding an unowned scanner rail — what those passes exist for —
/// cannot trip it, while deleting owned text or picture ink does.
const OWNED_INK_RETENTION_FLOOR: f64 = 0.55;
/// Retention is not a meaningful ratio on a leaf that carries almost no owned
/// ink to begin with: a blank verso whose text mask caught nothing but a few
/// specks of the fold shadow would otherwise demand that the shadow be kept.
const OWNED_INK_RETENTION_MINIMUM_FRACTION: f64 = 0.000_2;
const OWNED_INK_RETENTION_MINIMUM_PIXELS: usize = 512;
/// Legacy collapse floor for an ordinary non-blank leaf whose normalized
/// bilevel rendition has lost essentially every mark.
const PALE_BILEVEL_COLLAPSE_INK_FRACTION: f64 = 0.000_05;
/// Wider collapse floor used only after page-scale pale tone has independently
/// established that a low-contrast plate, rather than paper, occupies the leaf.
const PALE_TONAL_BILEVEL_COLLAPSE_INK_FRACTION: f64 = 0.001;

/// Ownership is read from the strict text mask, never from the permissive
/// vicinity mask: the vicinity mask deliberately covers soft tone such as the
/// spread's fold shadow, and scoring retention over it would have the guard
/// demand that a correctly suppressed scanner rail be put back.
fn page_ink_ownership_mask(
    text: Option<&BinaryImage>,
    picture: Option<&BinaryImage>,
) -> Option<BinaryImage> {
    match (text, picture) {
        (Some(text), Some(picture)) => Some(text.or(picture)),
        (Some(mask), None) | (None, Some(mask)) => Some(mask.clone()),
        (None, None) => None,
    }
}

fn owned_ink_pixels(binary: &BinaryImage, ownership: &BinaryImage) -> usize {
    binary.and(ownership).count_black()
}

fn owned_ink_minimum(width: usize, height: usize) -> usize {
    ((width.saturating_mul(height) as f64 * OWNED_INK_RETENTION_MINIMUM_FRACTION) as usize)
        .max(OWNED_INK_RETENTION_MINIMUM_PIXELS)
}

fn page_half_label(half: PageHalf) -> &'static str {
    match half {
        PageHalf::Full => "full page",
        PageHalf::Left => "left half",
        PageHalf::Right => "right half",
    }
}

/// Returns the raster to publish and whether the conservative rendition had to
/// be restored.
fn conserve_page_ink(
    conservative: BinaryImage,
    cleaned: BinaryImage,
    ownership: Option<&BinaryImage>,
    source_page_index: usize,
    half: PageHalf,
    warnings: &mut Vec<String>,
) -> (BinaryImage, bool) {
    // Without an ownership mask there is no way to tell page ink from a
    // scanner rail, and a page-level ratio would be as likely to restore the
    // rail as to rescue content.
    let Some(ownership) = ownership else {
        return (cleaned, false);
    };
    let supported = owned_ink_pixels(&conservative, ownership);
    let surviving = owned_ink_pixels(&cleaned, ownership);
    let minimum = owned_ink_minimum(conservative.width(), conservative.height());
    if supported < minimum {
        return (cleaned, false);
    }
    let retention = surviving as f64 / supported as f64;
    if retention >= OWNED_INK_RETENTION_FLOOR {
        return (cleaned, false);
    }
    warnings.push(format!(
        "Cleanup kept only {:.1}% of the detected content ink on source page {} ({}); the conservative rendition was emitted instead",
        retention * 100.0,
        source_page_index + 1,
        page_half_label(half)
    ));
    (conservative, true)
}

/// Width of the leaf edge band that carries the fold shadow and the scanner
/// rail rather than page content. Page margins are wider than this at any scan
/// resolution, so no printed matter falls inside the band.
const LEAF_EDGE_BAND_FRACTION: f64 = 0.04;

fn leaf_interior_is_blank(gray: &GrayImage, dpi: f64) -> bool {
    let inset_x = (gray.width() as f64 * LEAF_EDGE_BAND_FRACTION) as usize;
    let inset_y = (gray.height() as f64 * LEAF_EDGE_BAND_FRACTION) as usize;
    let width = gray.width().saturating_sub(inset_x.saturating_mul(2));
    let height = gray.height().saturating_sub(inset_y.saturating_mul(2));
    if width == 0 || height == 0 {
        return false;
    }
    let interior = crop_gray(
        gray,
        Rect::new(inset_x as f64, inset_y as f64, width as f64, height as f64),
    );
    is_effectively_blank(&interior, dpi)
}

fn pale_bilevel_collapse(binary: &BinaryImage, pale_tonal_structure: bool) -> bool {
    let area = binary.width().saturating_mul(binary.height());
    let ink_fraction = if pale_tonal_structure {
        PALE_TONAL_BILEVEL_COLLAPSE_INK_FRACTION
    } else {
        PALE_BILEVEL_COLLAPSE_INK_FRACTION
    };
    (binary.count_black() as f64) < area as f64 * ink_fraction
}

/// A pale, otherwise blank spread leaf can legitimately fall back to the raw
/// grayscale rendition after its bilevel layer collapses. The fold filter has
/// already proved which binary components are scanner/fold residue, but the
/// raw fallback would put their continuous-tone halo back on the page. When
/// that proof exists, neutralize only the narrow physical fold margin. The
/// caller admits only a leaf with no material text or picture ownership, so a
/// pale plate and a tight-rebind text page retain the conservative fallback.
fn whiten_collapsed_blank_fold_margin(
    mut grayscale: GrayImage,
    removed_fold_edge: &BinaryImage,
    half: PageHalf,
    split: &SplitResult,
    unowned_blank_leaf: bool,
) -> GrayImage {
    let measured_gutter_band = split
        .cutter_x
        .is_some_and(|cutter| split.diagnostics.fold_band.has_suppression(cutter));
    if !unowned_blank_leaf
        || !measured_gutter_band
        || removed_fold_edge.count_black() == 0
        || half == PageHalf::Full
    {
        return grayscale;
    }

    let margin = (grayscale.width() as f64 * FOLD_EDGE_FRAGMENT_MARGIN_FRACTION)
        .ceil()
        .max(1.0) as usize;
    let (left, right) = match half {
        PageHalf::Left => (grayscale.width().saturating_sub(margin), grayscale.width()),
        PageHalf::Right => (0, margin.min(grayscale.width())),
        PageHalf::Full => return grayscale,
    };
    for y in 0..grayscale.height() {
        grayscale.row_mut(y)[left..right].fill(255);
    }
    grayscale
}

/// The physical fold margin is deliberately much narrower than an ordinary
/// page margin. Only fragments that are both cut by the fold-side boundary and
/// small enough to be a piece of a glyph may be removed here. Picture
/// ownership remains an absolute veto, while text ownership has to continue
/// into the leaf: a tight rebind can put real type in this same corridor, and
/// a map or marginal illustration must not be mistaken for a facing-page
/// sliver.
const FOLD_EDGE_FRAGMENT_MARGIN_FRACTION: f64 = 0.015;
const FOLD_EDGE_FRAGMENT_CONTACT_MM: f64 = 0.25;
const FOLD_EDGE_FRAGMENT_MAX_MAJOR_MM: f64 = 4.0;
const FOLD_EDGE_FRAGMENT_MAX_MINOR_MM: f64 = 2.5;
const FOLD_EDGE_FRAGMENT_MAX_AREA_MM2: f64 = 2.5;
const FOLD_EDGE_RULE_MIN_MAJOR_MM: f64 = 3.0;
const FOLD_EDGE_RAIL_MAX_WIDTH_MM: f64 = 2.5;
const FOLD_EDGE_RAIL_ALIGNMENT_MM: f64 = 1.0;
const FOLD_EDGE_RAIL_MIN_SINGLE_HEIGHT_MM: f64 = 8.0;
const FOLD_EDGE_RAIL_MIN_CHAIN_SPAN_MM: f64 = 20.0;
const FOLD_EDGE_RAIL_MIN_CHAIN_COVERAGE_MM: f64 = 6.0;
const FOLD_EDGE_RAIL_MAX_SINGLE_FILL: f64 = 0.85;
const FOLD_EDGE_BLANK_SPECK_MAX_MAJOR_MM: f64 = 2.0;
const FOLD_EDGE_BLANK_SPECK_MAX_MINOR_MM: f64 = 1.25;
const FOLD_EDGE_BLANK_SPECK_MAX_AREA_MM2: f64 = 0.5;

fn manual_picture_crop_authority(
    options: &CleanupOptions,
    width: usize,
    height: usize,
) -> Option<BinaryImage> {
    if !options
        .manual_zones
        .picture
        .iter()
        .any(|zone| zone.layer == crate::PictureZoneLayer::Painter2)
    {
        return None;
    }
    let mut mask = BinaryImage::new(width, height);
    apply_manual_zones(&mut mask, options);
    (mask.count_black() > 0).then_some(mask)
}

fn retain_trusted_mrc_tone_components(mask: BinaryImage, effective_dpi: f64) -> BinaryImage {
    let page_pixels = mask.width().saturating_mul(mask.height()).max(1);
    let minimum_area = (page_pixels as f64 * 0.005).round().max(1.0) as usize;
    let minimum_span = (effective_dpi * 0.20).round().max(12.0) as usize;
    ComponentMap::from_binary(&mask).retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        component.area >= minimum_area && width >= minimum_span && height >= minimum_span
    })
}

fn carve_trusted_mrc_tone_owner(
    source: &GrayImage,
    trusted_tone: BinaryImage,
    text_vicinity_mask: Option<&BinaryImage>,
    effective_dpi: f64,
    calibration: PageCalibration,
) -> BinaryImage {
    let component_vetoed = veto_text_like_regions(source, trusted_tone, effective_dpi, calibration);
    // Component rejection and the pixel-level text carve are cumulative
    // safeguards. A genuine photo component can contain a caption or an
    // antialiased producer-text ghost without being text-like as a whole;
    // conversely, subtracting from the original producer mask here would
    // silently revive components that the stricter veto already rejected.
    let carved = if let Some(text) = text_vicinity_mask {
        component_vetoed.subtract(text)
    } else {
        component_vetoed
    };
    retain_trusted_mrc_tone_components(carved, effective_dpi)
}

fn union_optional_gray_fields(
    left: Option<&Arc<GrayImage>>,
    right: Option<&Arc<GrayImage>>,
) -> Option<Arc<GrayImage>> {
    match (left, right) {
        (Some(left), Some(right)) => {
            debug_assert_eq!(left.width(), right.width());
            debug_assert_eq!(left.height(), right.height());
            let mut combined = GrayImage::new(left.width(), left.height(), 0);
            combined
                .data_mut()
                .iter_mut()
                .zip(left.data())
                .zip(right.data())
                .for_each(|((target, &left), &right)| *target = left.max(right));
            Some(Arc::new(combined))
        }
        (Some(field), None) | (None, Some(field)) => Some(Arc::clone(field)),
        (None, None) => None,
    }
}

fn coherent_photo_field(alpha: &GrayImage, source: &GrayImage) -> Option<Arc<BinaryImage>> {
    debug_assert_eq!(alpha.width(), source.width());
    debug_assert_eq!(alpha.height(), source.height());
    let width = alpha.width();
    let height = alpha.height();
    let dark_tone_threshold = otsu_threshold(source).saturating_add(32);
    let dense_rows = (0..height)
        .map(|y| {
            (0..width)
                .filter(|&x| alpha.get(x, y) >= 128 && source.get(x, y) <= dark_tone_threshold)
                .count()
                .saturating_mul(5)
                >= width
        })
        .collect::<Vec<_>>();
    let mut retained = BinaryImage::new(width, height);
    let mut row_start = None;
    for (y, is_dense) in dense_rows
        .iter()
        .copied()
        .chain(std::iter::once(false))
        .enumerate()
    {
        match (row_start, is_dense) {
            (None, true) => row_start = Some(y),
            (Some(top), false) => {
                let bottom = y - 1;
                let row_span = bottom - top + 1;
                if row_span.saturating_mul(8) >= height {
                    let dense_columns = (0..width)
                        .map(|x| {
                            (top..=bottom)
                                .filter(|&row| {
                                    alpha.get(x, row) >= 128
                                        && source.get(x, row) <= dark_tone_threshold
                                })
                                .count()
                                .saturating_mul(5)
                                >= row_span.saturating_mul(2)
                        })
                        .collect::<Vec<_>>();
                    let mut column_start = None;
                    let mut significant_runs = Vec::new();
                    for (x, is_dense) in dense_columns
                        .iter()
                        .copied()
                        .chain(std::iter::once(false))
                        .enumerate()
                    {
                        match (column_start, is_dense) {
                            (None, true) => column_start = Some(x),
                            (Some(left), false) => {
                                let right = x - 1;
                                if (right - left + 1).saturating_mul(20) >= width {
                                    significant_runs.push((left, right));
                                }
                                column_start = None;
                            }
                            _ => {}
                        }
                    }
                    if let (Some((left, _)), Some((_, right))) =
                        (significant_runs.first(), significant_runs.last())
                    {
                        if (right - left + 1).saturating_mul(8) >= width {
                            for row in top..=bottom {
                                for column in *left..=*right {
                                    retained.set(column, row, true);
                                }
                            }
                        }
                    }
                }
                row_start = None;
            }
            _ => {}
        }
    }
    (retained.count_black() > 0).then(|| Arc::new(retained))
}

#[derive(Clone)]
struct CachedContentDetection {
    detected_content: Option<Rect>,
    source_content_box: Option<Rect>,
    diagnostics: Option<ContentDiagnostics>,
}

pub fn classify_page(
    source: &GrayImage,
    options: &CleanupOptions,
) -> Result<PageClassificationResult, String> {
    classify_page_with_document_prior(source, options, None)
}

pub fn classify_page_with_document_prior(
    source: &GrayImage,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
) -> Result<PageClassificationResult, String> {
    let mut timings = PageStageTimings::default();
    classify_page_with_document_prior_impl(source, options, document_prior, None, &mut timings)
}

fn classify_page_with_document_prior_impl(
    source: &GrayImage,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
    cache: Option<&PageCache>,
    timings: &mut PageStageTimings,
) -> Result<PageClassificationResult, String> {
    options.validate()?;
    let prepared = document_analysis::run(document_analysis::Input {
        source,
        color_source: None,
        options,
        prepare_quality_raster: false,
        render_policy: PageRenderPolicy {
            create_mixed_layers: false,
            create_mixed_composite: false,
            recommend_output_mode: true,
            analyze_layout: true,
        },
        document_prior,
        calibration_config: CalibrationConfig::default(),
        cache,
        trusted_mrc_background: None,
        timings,
    });
    Ok(PageClassificationResult {
        classification: prepared.split.classification,
        confidence: prepared.split.confidence,
        cutter_x: prepared.split.cutter_x,
        split_seam: prepared.split.split_seam,
        excluded: options.excluded,
        rotation: options.rotation,
        reconciliation: prepared.split.reconciliation,
        split_diagnostics: prepared.split.diagnostics,
        rotated_width: prepared.full_width,
        rotated_height: prepared.full_height,
        candidate_cutter_ratio: prepared.candidate_cutter_ratio,
        whitespace_score: prepared.whitespace_score,
        text_axis: prepared.text_axis,
        output_mode_recommendation: prepared.output_mode_recommendation,
    })
}

pub fn analyze_page(
    source: &GrayImage,
    options: &CleanupOptions,
) -> Result<PageAnalysisResult, String> {
    analyze_page_with_document_prior(source, options, None)
}

pub fn analyze_page_with_document_prior(
    source: &GrayImage,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
) -> Result<PageAnalysisResult, String> {
    analyze_page_with_color_and_document_prior(source, None, options, document_prior)
}

pub fn analyze_page_with_color_and_document_prior(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
) -> Result<PageAnalysisResult, String> {
    let mut timings = PageStageTimings::default();
    analyze_page_with_color_and_document_prior_impl(
        source,
        color_source,
        options,
        document_prior,
        true,
        true,
        None,
        &mut timings,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn analyze_page_with_color_and_document_prior_cached(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
    recommend_output_mode: bool,
    plan_content: bool,
    cache: &PageCache,
    timings: &mut PageStageTimings,
) -> Result<PageAnalysisResult, AnalysisError> {
    analyze_page_with_color_and_document_prior_impl(
        source,
        color_source,
        options,
        document_prior,
        recommend_output_mode,
        plan_content,
        Some(cache),
        timings,
    )
}

fn analyze_page_with_color_and_document_prior_impl(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
    recommend_output_mode: bool,
    plan_content: bool,
    cache: Option<&PageCache>,
    timings: &mut PageStageTimings,
) -> Result<PageAnalysisResult, AnalysisError> {
    options.validate()?;
    if options.excluded {
        return Ok(PageAnalysisResult {
            outputs: Vec::new(),
            classification: LayoutClassification::SingleUncutPage,
            confidence: 1.0,
            cutter_x: None,
            split_seam: None,
            excluded: true,
            rotation: options.rotation,
            reconciliation: ReconciliationMetadata {
                tier1_verdict: LayoutClassification::SingleUncutPage,
                reconciled: false,
                cluster_agreement: 0.0,
            },
            split_diagnostics: SplitDiagnostics::default(),
            rotated_width: source.width(),
            rotated_height: source.height(),
            calibration_stroke_width_px: None,
            calibration_x_height_px: None,
            candidate_cutter_ratio: None,
            whitespace_score: 0.0,
            text_axis: None,
            output_mode_recommendation: None,
        });
    }
    let prepared = document_analysis::run(document_analysis::Input {
        source,
        color_source,
        options,
        prepare_quality_raster: plan_content,
        render_policy: PageRenderPolicy {
            create_mixed_layers: false,
            create_mixed_composite: false,
            recommend_output_mode,
            analyze_layout: true,
        },
        document_prior,
        calibration_config: CalibrationConfig::default(),
        cache,
        trusted_mrc_background: None,
        timings,
    });
    let mut split = prepared.split;
    let needs_raw_gutter_remeasurement = gutter_band_needs_raw_remeasurement(&split);
    if plan_content
        && split.classification == LayoutClassification::TwoPageSpread
        && needs_raw_gutter_remeasurement
    {
        // Analysis geometry is published before the final cleanup pass. Use
        // the rotated full-resolution source here as well, otherwise the
        // final renderer can discover the right edge only after the analyze
        // pass has already fixed both leaf origins at the cutter.
        let raw_source = rotate_orthogonal(source, options.rotation);
        split.remeasure_gutter_band_from_source(
            &raw_source,
            raw_source.width(),
            raw_source.height(),
        );
    }
    if !plan_content {
        return Ok(PageAnalysisResult {
            outputs: Vec::new(),
            classification: split.classification,
            confidence: split.confidence,
            cutter_x: split.cutter_x,
            split_seam: split.split_seam,
            excluded: false,
            rotation: options.rotation,
            reconciliation: split.reconciliation,
            split_diagnostics: split.diagnostics,
            rotated_width: prepared.full_width,
            rotated_height: prepared.full_height,
            calibration_stroke_width_px: prepared
                .calibration
                .valid
                .then_some(prepared.calibration.stroke_width_px),
            calibration_x_height_px: prepared
                .calibration
                .valid
                .then_some(prepared.calibration.x_height_px),
            candidate_cutter_ratio: prepared.candidate_cutter_ratio,
            whitespace_score: prepared.whitespace_score,
            text_axis: prepared.text_axis,
            output_mode_recommendation: prepared.output_mode_recommendation,
        });
    }
    let support_source = match options.rotation {
        OrthogonalRotation::None => Cow::Borrowed(source),
        rotation => Cow::Owned(rotate_orthogonal(source, rotation)),
    };
    let content_started = Instant::now();
    let manual_picture_crop_authority = manual_picture_crop_authority(
        options,
        prepared.normalized.width(),
        prepared.normalized.height(),
    );
    let outputs = output_regions(
        prepared.full_width,
        prepared.full_height,
        &split,
        options.layout,
    )
    .into_iter()
    .map(|(region, half)| {
        let analysis_region = Rect::new(
            region.x * prepared.scale_x,
            region.y * prepared.scale_y,
            region.width * prepared.scale_x,
            region.height * prepared.scale_y,
        );
        let working = crop_gray(&prepared.normalized, analysis_region);
        let text_tone_diagnostics = if prepared.resolved_output_mode == OutputMode::Grayscale {
            prepared
                .text_mask
                .as_ref()
                .zip(prepared.text_vicinity_mask.as_ref())
                .map(|(text_mask, text_vicinity_mask)| {
                    let picture_mask = prepared
                        .picture_mask
                        .as_ref()
                        .map(|mask| crop_binary(mask, analysis_region))
                        .unwrap_or_else(|| BinaryImage::new(working.width(), working.height()));
                    derive_text_tone_diagnostics(
                        &working,
                        &crop_binary(text_mask, analysis_region),
                        &crop_binary(text_vicinity_mask, analysis_region),
                        &picture_mask,
                    )
                })
        } else {
            None
        };
        let content_picture_mask = prepared
            .content_picture_mask
            .as_ref()
            .map(|mask| crop_binary(mask, analysis_region));
        let manual_picture_crop_authority = manual_picture_crop_authority
            .as_ref()
            .map(|mask| crop_binary(mask, analysis_region));
        let (detected_content, content_diagnostics) = if let Some(manual) =
            options.resolved_content_for(half, prepared.full_width, prepared.full_height)
        {
            let left = manual.x.clamp(0.0, region.width.max(1.0) - 1.0);
            let top = manual.y.clamp(0.0, region.height.max(1.0) - 1.0);
            let right = manual.right().clamp(left + 1.0, region.width);
            let bottom = manual.bottom().clamp(top + 1.0, region.height);
            (Some(Rect::new(left, top, right - left, bottom - top)), None)
        } else {
            let detected = detect_content_and_margins_calibrated_with_crop_authority(
                &working,
                content_picture_mask.as_ref(),
                manual_picture_crop_authority.as_ref(),
                prepared.calibration.effective_dpi,
                None,
                Some([0.0; 4]),
                prepared.calibration,
            );
            let content = detected.content.map(|content| {
                map_analysis_rect_to_source_support(
                    content,
                    prepared.scale_x,
                    prepared.scale_y,
                    region.width,
                    region.height,
                    SourceContentSupport::Rectilinear {
                        image: &support_source,
                        to_source: Affine::translation(region.x, region.y),
                    },
                )
            });
            (content, detected.diagnostics)
        };
        if options.match_page_size {
            // Matched margins are composed on the final document grid, but
            // their untrusted request geometry still has to pass the same
            // finite-arithmetic checks before the engine omits them here.
            content_result_for_dimensions(
                region.width.ceil().max(1.0) as usize,
                region.height.ceil().max(1.0) as usize,
                options.dpi,
                detected_content,
                options.margins_mm.map(crate::MarginsMm::values),
                options.margins_pixels,
            )?;
        }
        let content = content_result_for_dimensions(
            region.width.ceil().max(1.0) as usize,
            region.height.ceil().max(1.0) as usize,
            options.dpi,
            detected_content,
            if options.match_page_size {
                None
            } else {
                options.margins_mm.map(crate::MarginsMm::values)
            },
            if options.match_page_size {
                Some([0.0; 4])
            } else {
                options.margins_pixels
            },
        )?;
        options.validate_derived_raster_dimensions(
            content.output_rect.width,
            content.output_rect.height,
        )?;
        let crop_enabled = options.crop_content && content.content.is_some();
        let local_crop = if crop_enabled {
            content.output_rect
        } else {
            Rect::new(0.0, 0.0, region.width, region.height)
        };
        Ok(AnalysisOutputMetadata {
            half,
            source_region: region,
            content_box: content.content,
            content_diagnostics,
            text_tone_diagnostics,
            crop_rect: Rect::new(
                region.x + local_crop.x,
                region.y + local_crop.y,
                local_crop.width,
                local_crop.height,
            ),
            applied_margins: if crop_enabled {
                content.margins
            } else {
                [0.0; 4]
            }
            .into(),
            input_width: source.width(),
            input_height: source.height(),
        })
    })
    .collect::<Result<Vec<_>, AnalysisError>>()?;
    timings.content_ms += content_started.elapsed().as_secs_f64() * 1_000.0;
    Ok(PageAnalysisResult {
        outputs,
        classification: split.classification,
        confidence: split.confidence,
        cutter_x: split.cutter_x,
        split_seam: split.split_seam,
        excluded: false,
        rotation: options.rotation,
        reconciliation: split.reconciliation,
        split_diagnostics: split.diagnostics,
        rotated_width: prepared.full_width,
        rotated_height: prepared.full_height,
        calibration_stroke_width_px: prepared
            .calibration
            .valid
            .then_some(prepared.calibration.stroke_width_px),
        calibration_x_height_px: prepared
            .calibration
            .valid
            .then_some(prepared.calibration.x_height_px),
        candidate_cutter_ratio: prepared.candidate_cutter_ratio,
        whitespace_score: prepared.whitespace_score,
        text_axis: prepared.text_axis,
        output_mode_recommendation: prepared.output_mode_recommendation,
    })
}

#[derive(Clone, Copy)]
struct PageRenderPolicy {
    create_mixed_layers: bool,
    create_mixed_composite: bool,
    recommend_output_mode: bool,
    /// Picture mask, mode recommendation, text axis and split detection. A
    /// caller that already knows the page layout keeps calibration and
    /// binarization without paying for them. Only legal when the layout is
    /// already resolved to a single region.
    analyze_layout: bool,
}

impl PageRenderPolicy {
    const COMPLETE: Self = Self {
        create_mixed_layers: true,
        create_mixed_composite: true,
        recommend_output_mode: true,
        analyze_layout: true,
    };

    const DETAIL_TILE: Self = Self {
        create_mixed_layers: false,
        create_mixed_composite: true,
        recommend_output_mode: false,
        analyze_layout: false,
    };
}

pub fn clean_page(
    source: &GrayImage,
    options: &CleanupOptions,
    source_page_index: usize,
) -> Result<PageCleanupResult, String> {
    let mut timings = PageStageTimings::default();
    clean_page_with_color_and_calibration_config(
        source,
        None,
        None,
        None,
        None,
        options,
        source_page_index,
        CalibrationConfig::default(),
        None,
        None,
        PageRenderPolicy::COMPLETE,
        &mut timings,
    )
    .map_err(|error| error.to_string())
}

#[doc(hidden)]
pub fn clean_page_with_calibration_config(
    source: &GrayImage,
    options: &CleanupOptions,
    source_page_index: usize,
    calibration_config: CalibrationConfig,
) -> Result<PageCleanupResult, String> {
    let mut timings = PageStageTimings::default();
    clean_page_with_color_and_calibration_config(
        source,
        None,
        None,
        None,
        None,
        options,
        source_page_index,
        calibration_config,
        None,
        None,
        PageRenderPolicy::COMPLETE,
        &mut timings,
    )
    .map_err(|error| error.to_string())
}

pub fn clean_page_with_color(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    source_page_index: usize,
) -> Result<PageCleanupResult, String> {
    let mut timings = PageStageTimings::default();
    clean_page_with_color_and_calibration_config(
        source,
        color_source,
        None,
        None,
        None,
        options,
        source_page_index,
        CalibrationConfig::default(),
        None,
        None,
        PageRenderPolicy::COMPLETE,
        &mut timings,
    )
    .map_err(|error| error.to_string())
}

pub fn clean_page_with_color_and_document_prior(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    source_page_index: usize,
    document_prior: Option<DocumentPrior>,
) -> Result<PageCleanupResult, String> {
    let mut timings = PageStageTimings::default();
    clean_page_with_color_and_calibration_config(
        source,
        color_source,
        None,
        None,
        None,
        options,
        source_page_index,
        CalibrationConfig::default(),
        document_prior,
        None,
        PageRenderPolicy::COMPLETE,
        &mut timings,
    )
    .map_err(|error| error.to_string())
}

/// Test/diagnostic entrypoint for proving that a fixed analysis plane owns all
/// decisions while a different raster supplies only rendered output pixels.
#[doc(hidden)]
pub fn clean_page_with_canonical_analysis(
    source: &GrayImage,
    canonical_analysis: CanonicalAnalysisPlane<'_>,
    options: &CleanupOptions,
    source_page_index: usize,
) -> Result<PageCleanupResult, String> {
    let mut timings = PageStageTimings::default();
    clean_page_with_color_and_calibration_config(
        source,
        None,
        Some(canonical_analysis),
        None,
        None,
        options,
        source_page_index,
        CalibrationConfig::default(),
        None,
        None,
        PageRenderPolicy::COMPLETE,
        &mut timings,
    )
    .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn clean_page_with_color_and_document_prior_cached(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    canonical_analysis: Option<CanonicalAnalysisPlane<'_>>,
    trusted_foreground_mask: Option<&BinaryImage>,
    trusted_mrc_background: Option<&GrayImage>,
    options: &CleanupOptions,
    source_page_index: usize,
    document_prior: Option<DocumentPrior>,
    cache: &PageCache,
    create_mixed_layers: bool,
    recommend_output_mode: bool,
    timings: &mut PageStageTimings,
) -> Result<PageCleanupResult, AnalysisError> {
    clean_page_with_color_and_calibration_config(
        source,
        color_source,
        canonical_analysis,
        trusted_foreground_mask,
        trusted_mrc_background,
        options,
        source_page_index,
        CalibrationConfig::default(),
        document_prior,
        Some(cache),
        PageRenderPolicy {
            create_mixed_layers,
            // The batch adapter can publish the cheaper separable representation
            // only when it supplied destinations for both layers. Library callers
            // and ordinary single-raster outputs still need the composite.
            create_mixed_composite: !create_mixed_layers,
            recommend_output_mode,
            analyze_layout: true,
        },
        timings,
    )
}

#[allow(clippy::too_many_arguments)]
fn clean_page_with_color_and_calibration_config(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    canonical_analysis: Option<CanonicalAnalysisPlane<'_>>,
    trusted_foreground_mask: Option<&BinaryImage>,
    trusted_mrc_background: Option<&GrayImage>,
    options: &CleanupOptions,
    source_page_index: usize,
    calibration_config: CalibrationConfig,
    document_prior: Option<DocumentPrior>,
    cache: Option<&PageCache>,
    render_policy: PageRenderPolicy,
    timings: &mut PageStageTimings,
) -> Result<PageCleanupResult, AnalysisError> {
    options.validate()?;
    if options.excluded {
        return Ok(PageCleanupResult {
            outputs: Vec::new(),
            classification: LayoutClassification::SingleUncutPage,
            layout_confidence: 1.0,
            cutter_x: None,
            split_seam: None,
            reconciliation: ReconciliationMetadata {
                tier1_verdict: LayoutClassification::SingleUncutPage,
                reconciled: false,
                cluster_agreement: 0.0,
            },
            split_diagnostics: SplitDiagnostics::default(),
            blank_outputs_skipped: 0,
            excluded: true,
            rotation: options.rotation,
            output_mode_recommendation: None,
        });
    }
    let prepared = prepare_page(
        source,
        color_source,
        canonical_analysis,
        trusted_foreground_mask,
        trusted_mrc_background,
        options,
        calibration_config,
        document_prior,
        cache,
        render_policy,
        timings,
    );
    let auto_resolved_color = options.output_mode == OutputMode::Auto
        && prepared.resolved_output_mode == OutputMode::Color;
    let mut resolved_options;
    let options = if prepared.resolved_output_mode == options.output_mode && !auto_resolved_color {
        options
    } else {
        resolved_options = options.clone();
        resolved_options.output_mode = prepared.resolved_output_mode;
        if auto_resolved_color {
            resolved_options.normalize_illumination = false;
        }
        &resolved_options
    };
    let PreparedPage {
        rotated_source,
        normalized,
        analysis_normalized,
        canonical_routing_source,
        canonical_routing_dpi,
        canonical_regions,
        has_canonical_analysis,
        analysis_scale_x,
        analysis_scale_y,
        calibration,
        rotated_color,
        content_picture_mask,
        picture_mask,
        halftone_zone_mask,
        spatial_tone_mask,
        chroma_picture_mask,
        tone_picture_mask,
        tone_preservation_alpha,
        text_mask,
        text_vicinity_mask,
        trusted_foreground_mask,
        split,
        split_cache_key,
        source_effectively_blank,
        output_mode_recommendation,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        resolved_output_mode: _,
    } = prepared;
    let working_regions = output_regions(
        normalized.width(),
        normalized.height(),
        &split,
        options.layout,
    );
    debug_assert!(regions_match_in_common_coordinates(
        &canonical_regions,
        &working_regions,
        canonical_routing_source.width(),
        canonical_routing_source.height(),
        normalized.width(),
        normalized.height(),
    ));
    let canonical_width = canonical_routing_source.width().max(1) as f64;
    let canonical_height = canonical_routing_source.height().max(1) as f64;
    let working_width = normalized.width();
    let working_height = normalized.height();
    let regions = if has_canonical_analysis {
        canonical_regions
            .iter()
            .map(|(region, half)| {
                let left = (region.x * working_width as f64 / canonical_width)
                    .round()
                    .clamp(0.0, working_width.saturating_sub(1) as f64);
                let top = (region.y * working_height as f64 / canonical_height)
                    .round()
                    .clamp(0.0, working_height.saturating_sub(1) as f64);
                let right = (region.right() * working_width as f64 / canonical_width)
                    .round()
                    .clamp(left + 1.0, working_width as f64);
                let bottom = (region.bottom() * working_height as f64 / canonical_height)
                    .round()
                    .clamp(top + 1.0, working_height as f64);
                (Rect::new(left, top, right - left, bottom - top), *half)
            })
            .collect::<Vec<_>>()
    } else {
        working_regions
    };
    let canonical_regions = canonical_regions
        .into_iter()
        .map(|(region, _)| region)
        .collect::<Vec<_>>();
    let canonical_routing_inputs = canonical_regions
        .iter()
        .map(|region| {
            crop_canonical_routing_input(
                &canonical_routing_source,
                *region,
                picture_mask.as_deref(),
                canonical_routing_dpi,
            )
        })
        .collect::<Vec<_>>();
    let canonical_leaf_sources = canonical_regions
        .iter()
        .map(|region| crop_gray(&canonical_routing_source, *region))
        .collect::<Vec<_>>();
    let canonical_picture_masks = if let Some(picture_mask) = picture_mask.as_deref() {
        let canonical_mask = resample_binary_mask_nearest(
            picture_mask,
            canonical_routing_source.width(),
            canonical_routing_source.height(),
        );
        canonical_regions
            .iter()
            .map(|region| Some(crop_binary(&canonical_mask, *region)))
            .collect::<Vec<_>>()
    } else {
        canonical_regions.iter().map(|_| None).collect::<Vec<_>>()
    };
    let spread_plans = if split.classification == LayoutClassification::TwoPageSpread
        && regions.len() == 2
        && matches!(options.output_mode, OutputMode::Bw | OutputMode::Mixed)
    {
        // The joint keeps the base illumination-normalized evidence meaning,
        // now on the fixed canonical plane. Leaf routes remain raw-canonical;
        // full canonical leaves own intensity anchors, while established
        // working-leaf units remain authoritative for radius/faint-ink drift.
        let canonical_normalized = analysis_normalized.as_deref().unwrap_or(&normalized);
        let joint_routing_input = crop_canonical_routing_input(
            canonical_normalized,
            Rect::new(
                0.0,
                0.0,
                canonical_normalized.width() as f64,
                canonical_normalized.height() as f64,
            ),
            picture_mask.as_deref(),
            canonical_routing_dpi,
        );
        Some(resolve_spread_binarization_plans(
            &joint_routing_input,
            &canonical_routing_inputs[0],
            &canonical_routing_inputs[1],
            &canonical_leaf_sources[0],
            &canonical_leaf_sources[1],
            canonical_picture_masks[0].as_ref(),
            canonical_picture_masks[1].as_ref(),
            canonical_routing_dpi,
            options,
            calibration,
            document_prior.and_then(|prior| prior.stroke_width_median_px),
            document_prior.and_then(|prior| prior.x_height_median_px),
        ))
    } else {
        None
    };
    let mut outputs = Vec::with_capacity(regions.len());
    for (((region, half), canonical_routing_input), canonical_leaf_source) in regions
        .into_iter()
        .zip(canonical_routing_inputs.iter())
        .zip(canonical_leaf_sources.iter())
    {
        let spread_plan = spread_plans.as_ref().map(|plans| plans.for_half(half));
        outputs.push(
            region_rendering::run(region_rendering::Input {
                source,
                routing_source: rotated_source.as_deref().unwrap_or(&normalized),
                normalized: &normalized,
                analysis_normalized: analysis_normalized.as_deref().unwrap_or(&normalized),
                analysis_scale_x,
                analysis_scale_y,
                canonical_routing_sample: canonical_routing_input,
                canonical_leaf_source,
                canonical_routing_dpi,
                calibration,
                color_source: rotated_color.as_ref(),
                analysis_picture_mask: content_picture_mask.as_deref(),
                source_picture_mask: picture_mask.as_deref(),
                halftone_zone_mask: halftone_zone_mask.as_deref(),
                spatial_tone_mask: spatial_tone_mask.as_deref(),
                chroma_picture_mask: chroma_picture_mask.as_deref(),
                tone_picture_mask: tone_picture_mask.as_deref(),
                preserve_confirmed_photo_tones,
                use_soft_alpha_foreground,
                tone_preservation_alpha: tone_preservation_alpha.as_deref(),
                text_mask: text_mask.as_deref(),
                text_vicinity_mask: text_vicinity_mask.as_deref(),
                trusted_foreground_mask: trusted_foreground_mask.as_ref(),
                options,
                source_page_index,
                split: &split,
                spread_plan: spread_plan.as_ref(),
                region,
                half,
                cache,
                split_cache_key: split_cache_key.as_ref(),
                source_effectively_blank,
                create_mixed_layers: render_policy.create_mixed_layers,
                create_mixed_composite: render_policy.create_mixed_composite,
                timings,
            })
            .map(map_region_semantic_output)?,
        );
    }
    let before_blank_filter = outputs.len();
    if options.skip_blank_pages && options.render_crop.is_none() {
        outputs.retain(|output| !output.effectively_blank);
    }
    let blank_outputs_skipped = before_blank_filter - outputs.len();
    Ok(PageCleanupResult {
        outputs,
        classification: split.classification,
        layout_confidence: split.confidence,
        cutter_x: split.cutter_x,
        split_seam: split.split_seam.clone(),
        reconciliation: split.reconciliation,
        split_diagnostics: split.diagnostics,
        blank_outputs_skipped,
        excluded: false,
        rotation: options.rotation,
        output_mode_recommendation,
    })
}

#[allow(clippy::too_many_arguments)]
struct PreparedRenderPlanes<'a> {
    rotated_source: Option<Cow<'a, GrayImage>>,
    normalized: Arc<GrayImage>,
    analysis_normalized: Option<Arc<GrayImage>>,
    rotated_color: Option<RgbImage>,
    picture_mask: Option<Arc<BinaryImage>>,
    trusted_foreground_mask: Option<BinaryImage>,
}

struct PreparedRenderPlanesInput<'a, 'b> {
    color_source: Option<&'b RgbImage>,
    analysis_normalized: Arc<GrayImage>,
    analysis_is_full: bool,
    analysis_picture_mask: Option<Arc<BinaryImage>>,
    analysis_tonal_protection_mask: Option<Arc<BinaryImage>>,
    analysis_semantic_preservation_alpha: Option<Arc<GrayImage>>,
    analysis_photo_preservation_alpha: Option<Arc<GrayImage>>,
    output_mode_recommendation: Option<&'b OutputModeRecommendation>,
    options: &'b CleanupOptions,
    rotated_source: Cow<'a, GrayImage>,
    trusted_foreground_mask: Option<&'b BinaryImage>,
    timings: &'b mut PageStageTimings,
}

fn prepare_render_planes<'a, 'b>(
    input: PreparedRenderPlanesInput<'a, 'b>,
) -> PreparedRenderPlanes<'a> {
    let PreparedRenderPlanesInput {
        color_source,
        analysis_normalized,
        analysis_is_full,
        analysis_picture_mask,
        analysis_tonal_protection_mask,
        analysis_semantic_preservation_alpha,
        analysis_photo_preservation_alpha,
        output_mode_recommendation,
        options,
        rotated_source,
        trusted_foreground_mask,
        timings,
    } = input;
    let quality_normalization_started = Instant::now();
    // Picture segmentation is scale-stable evidence. Keep it at the bounded
    // analysis resolution and map it directly into the final render below;
    // rebuilding the same mask over a 15–35 MP source dominated mixed-page
    // cleanup and only created an intermediate mask that was immediately
    // resampled again.
    let mut picture_mask = if options.output_mode != OutputMode::Bw {
        analysis_picture_mask.clone()
    } else {
        None
    };
    let normalization_model_exclusion = union_optional_masks(
        analysis_picture_mask.as_ref(),
        analysis_tonal_protection_mask.as_ref(),
    );
    let normalization_model_exclusion = match options.output_mode {
        OutputMode::Grayscale => normalization_model_exclusion.as_deref(),
        OutputMode::Mixed => picture_mask.as_deref(),
        OutputMode::Color
            if output_mode_recommendation
                .is_some_and(|recommendation| recommendation.diagnostics.significant_picture) =>
        {
            normalization_model_exclusion.as_deref()
        }
        // A Color page without an embedded picture is commonly a full-bleed
        // cover. Supplying any mask makes RGB normalization assume that an
        // external paper field exists and can turn the cover into pale noise.
        // The unmasked color path already selects conservative levels when no
        // plausible paper background exists.
        OutputMode::Color => None,
        OutputMode::Bw | OutputMode::Auto => None,
    };
    // Semantic tone is reconstructed from the illumination-corrected raster;
    // only true photo regions may restore the raw scan. Their union remains
    // the render-space suppression field for text enhancement.
    let semantic_preservation_alpha = match options.output_mode {
        OutputMode::Grayscale => analysis_semantic_preservation_alpha.as_deref(),
        OutputMode::Mixed => analysis_semantic_preservation_alpha.as_deref(),
        OutputMode::Color
            if output_mode_recommendation
                .is_some_and(|recommendation| recommendation.diagnostics.significant_picture) =>
        {
            analysis_semantic_preservation_alpha.as_deref()
        }
        OutputMode::Color | OutputMode::Bw | OutputMode::Auto => None,
    };
    let photo_preservation_alpha = match options.output_mode {
        OutputMode::Grayscale => analysis_photo_preservation_alpha.as_deref(),
        OutputMode::Mixed => analysis_photo_preservation_alpha.as_deref(),
        OutputMode::Color
            if output_mode_recommendation
                .is_some_and(|recommendation| recommendation.diagnostics.significant_picture) =>
        {
            analysis_photo_preservation_alpha.as_deref()
        }
        OutputMode::Color | OutputMode::Bw | OutputMode::Auto => None,
    };
    let rotated_color_source = color_source.map(|image| match options.rotation {
        OrthogonalRotation::None => Cow::Borrowed(image),
        rotation => Cow::Owned(rotate_rgb_orthogonal(image, rotation)),
    });
    let trusted_foreground_mask =
        trusted_foreground_mask.map(|mask| rotate_binary_orthogonal(mask, options.rotation));
    let paired_normalized = if !analysis_is_full
        && options.normalize_illumination
        && matches!(options.output_mode, OutputMode::Mixed | OutputMode::Color)
    {
        rotated_color_source.as_ref().map(|rotated_color| {
            normalize_illumination_pair_with_masks(
                &rotated_source,
                rotated_color,
                normalization_model_exclusion,
                semantic_preservation_alpha,
                photo_preservation_alpha,
            )
        })
    } else {
        None
    };
    let rotated_color = rotated_color_source.map(|rotated| {
        if let Some((_, normalized_color)) = paired_normalized.as_ref() {
            normalized_color.clone()
        } else if options.normalize_illumination {
            normalize_illumination_rgb_with_masks(
                &rotated_source,
                &rotated,
                normalization_model_exclusion,
                semantic_preservation_alpha,
                photo_preservation_alpha,
            )
        } else {
            rotated.into_owned()
        }
    });
    let (rotated_source, normalized, analysis_normalized) = if analysis_is_full {
        (Some(rotated_source), analysis_normalized, None)
    } else if options.normalize_illumination {
        let normalized = if let Some((normalized, _)) = paired_normalized {
            normalized
        } else {
            normalize_illumination_with_masks(
                &rotated_source,
                options.dpi,
                normalization_model_exclusion,
                semantic_preservation_alpha,
                photo_preservation_alpha,
            )
        };
        (
            Some(rotated_source),
            Arc::new(normalized),
            Some(analysis_normalized),
        )
    } else {
        (
            None,
            Arc::new(rotated_source.into_owned()),
            Some(analysis_normalized),
        )
    };
    timings.quality_normalization_ms +=
        quality_normalization_started.elapsed().as_secs_f64() * 1_000.0;

    PreparedRenderPlanes {
        rotated_source,
        normalized,
        analysis_normalized,
        rotated_color,
        picture_mask: picture_mask.take(),
        trusted_foreground_mask,
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_page<'a>(
    source: &'a GrayImage,
    color_source: Option<&RgbImage>,
    canonical_analysis: Option<CanonicalAnalysisPlane<'_>>,
    trusted_foreground_mask: Option<&BinaryImage>,
    trusted_mrc_background: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration_config: CalibrationConfig,
    document_prior: Option<DocumentPrior>,
    cache: Option<&PageCache>,
    render_policy: PageRenderPolicy,
    timings: &mut PageStageTimings,
) -> PreparedPage<'a> {
    let has_canonical_analysis = canonical_analysis.is_some();
    let (analysis_source, analysis_color_source, analysis_dpi) = canonical_analysis
        .as_ref()
        .map_or((source, color_source, options.dpi), |plane| {
            (plane.gray, plane.color, plane.dpi)
        });
    let mut analysis_options_storage;
    let analysis_options = if canonical_analysis.is_some() {
        analysis_options_storage = options.clone();
        analysis_options_storage.dpi = analysis_dpi;
        &analysis_options_storage
    } else {
        options
    };
    let mut prepared_analysis = document_analysis::run(document_analysis::Input {
        source: analysis_source,
        color_source: analysis_color_source,
        options: analysis_options,
        prepare_quality_raster: true,
        render_policy,
        document_prior,
        calibration_config,
        cache,
        trusted_mrc_background,
        timings,
    });
    let (working_width, working_height) = match options.rotation {
        OrthogonalRotation::None | OrthogonalRotation::Clockwise180 => {
            (source.width(), source.height())
        }
        OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270 => {
            (source.height(), source.width())
        }
    };
    if prepared_analysis.split.classification == LayoutClassification::TwoPageSpread
        && gutter_band_needs_raw_remeasurement(&prepared_analysis.split)
    {
        prepared_analysis.split.remeasure_gutter_band_from_source(
            &prepared_analysis.canonical_routing_source,
            prepared_analysis.full_width,
            prepared_analysis.full_height,
        );
    }
    // Preserve the exact canonical leaf rectangles before the split is scaled
    // onto the working raster. Mapping rounded working rectangles back into
    // canonical pixels can move a crop edge by one sample at nearby DPIs and
    // reopen the very route instability the fixed plane is meant to remove.
    // The split is in the fixed canonical routing plane. The analysis-normalized
    // raster is DPI-capped below that plane whenever no canonical plane is
    // supplied, so clamping a full-space cutter into normalized bounds would
    // degenerate the right leaf to a sliver.
    let canonical_width = prepared_analysis.canonical_routing_source.width();
    let canonical_height = prepared_analysis.canonical_routing_source.height();
    debug_assert_eq!(
        (canonical_width, canonical_height),
        (prepared_analysis.full_width, prepared_analysis.full_height),
        "canonical routing and split dimensions must share one coordinate plane",
    );
    let canonical_regions = output_regions(
        canonical_width,
        canonical_height,
        &prepared_analysis.split,
        options.layout,
    )
    .into_iter()
    .collect();
    if canonical_analysis.is_some() {
        let canonical_to_working_x =
            prepared_analysis.full_width as f64 / working_width.max(1) as f64;
        let canonical_to_working_y =
            prepared_analysis.full_height as f64 / working_height.max(1) as f64;
        scale_split_result(
            &mut prepared_analysis.split,
            canonical_to_working_x,
            canonical_to_working_y,
            working_width,
            working_height,
        );
        prepared_analysis.scale_x =
            prepared_analysis.normalized.width() as f64 / working_width.max(1) as f64;
        prepared_analysis.scale_y =
            prepared_analysis.normalized.height() as f64 / working_height.max(1) as f64;
        prepared_analysis.full_width = working_width;
        prepared_analysis.full_height = working_height;
    }
    let PreparedAnalysis {
        normalized: analysis_normalized,
        canonical_routing_source,
        split,
        scale_x,
        scale_y,
        calibration,
        canonical_routing_dpi,
        content_picture_mask: analysis_content_picture_mask,
        picture_mask: analysis_picture_mask,
        halftone_zone_mask: analysis_halftone_zone_mask,
        spatial_tone_mask: analysis_spatial_tone_mask,
        chroma_picture_mask: analysis_chroma_picture_mask,
        tonal_protection_mask: analysis_tonal_protection_mask,
        semantic_preservation_alpha: analysis_semantic_preservation_alpha,
        photo_preservation_alpha: analysis_photo_preservation_alpha,
        tone_preservation_alpha: analysis_tone_preservation_alpha,
        text_mask: analysis_text_mask,
        text_vicinity_mask: analysis_text_vicinity_mask,
        full_width,
        full_height,
        split_cache_key,
        source_effectively_blank,
        output_mode_recommendation,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        resolved_output_mode,
        ..
    } = prepared_analysis;
    // Auto Color is an explicit semantic abstention from paper cleanup: the
    // page is continuous-tone/color content, not paper plus ink. Keeping
    // illumination normalization enabled here made preview invent a visual
    // change while the compact PDF assembler correctly wanted to preserve the
    // source objects. Explicit Color remains user-controlled and may normalize.
    let auto_resolved_color =
        options.output_mode == OutputMode::Auto && resolved_output_mode == OutputMode::Color;
    let mut resolved_options;
    let options = if resolved_output_mode == options.output_mode && !auto_resolved_color {
        options
    } else {
        resolved_options = options.clone();
        resolved_options.output_mode = resolved_output_mode;
        if auto_resolved_color {
            resolved_options.normalize_illumination = false;
        }
        &resolved_options
    };
    let rotated_source = match options.rotation {
        OrthogonalRotation::None => Cow::Borrowed(source),
        rotation => Cow::Owned(rotate_orthogonal(source, rotation)),
    };
    let analysis_is_full = analysis_normalized.width() == full_width
        && analysis_normalized.height() == full_height
        && scale_x == 1.0
        && scale_y == 1.0;
    let PreparedRenderPlanes {
        rotated_source,
        normalized,
        analysis_normalized,
        rotated_color,
        mut picture_mask,
        trusted_foreground_mask,
    } = prepare_render_planes(PreparedRenderPlanesInput {
        color_source,
        analysis_normalized,
        analysis_is_full,
        analysis_picture_mask,
        analysis_tonal_protection_mask: analysis_tonal_protection_mask.clone(),
        analysis_semantic_preservation_alpha,
        analysis_photo_preservation_alpha,
        output_mode_recommendation: output_mode_recommendation.as_ref(),
        options,
        rotated_source,
        trusted_foreground_mask,
        timings,
    });
    PreparedPage {
        rotated_source,
        normalized,
        analysis_normalized,
        canonical_routing_source,
        canonical_routing_dpi,
        canonical_regions,
        has_canonical_analysis,
        analysis_scale_x: scale_x,
        analysis_scale_y: scale_y,
        calibration,
        rotated_color,
        content_picture_mask: analysis_content_picture_mask,
        picture_mask: picture_mask.take(),
        halftone_zone_mask: analysis_halftone_zone_mask,
        spatial_tone_mask: analysis_spatial_tone_mask,
        chroma_picture_mask: analysis_chroma_picture_mask,
        tone_picture_mask: analysis_tonal_protection_mask,
        tone_preservation_alpha: analysis_tone_preservation_alpha,
        text_mask: analysis_text_mask,
        text_vicinity_mask: analysis_text_vicinity_mask,
        trusted_foreground_mask,
        split,
        split_cache_key,
        source_effectively_blank,
        output_mode_recommendation,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        resolved_output_mode,
    }
}

fn analysis_artifact_bytes(artifact: &AnalysisArtifact) -> usize {
    let gray = artifact.normalized.data().len()
        + artifact.layout_normalized.data().len()
        + artifact.canonical_routing_source.data().len();
    let picture_mask = artifact
        .picture_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let halftone_zone_mask = artifact
        .halftone_zone_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let spatial_tone_mask = artifact
        .spatial_tone_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let chroma_picture_mask = artifact
        .chroma_picture_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let tonal_protection_mask = artifact
        .tonal_protection_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let tone_preservation_alpha = artifact
        .tone_preservation_alpha
        .as_deref()
        .map_or(0, |alpha| alpha.data().len());
    let semantic_preservation_alpha = artifact
        .semantic_preservation_alpha
        .as_deref()
        .map_or(0, |alpha| alpha.data().len());
    let photo_preservation_alpha = artifact
        .photo_preservation_alpha
        .as_deref()
        .map_or(0, |alpha| alpha.data().len());
    let text_mask = artifact
        .text_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let text_vicinity_mask = artifact
        .text_vicinity_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    let content_picture_mask = artifact
        .content_picture_mask
        .as_deref()
        .map_or(0, |mask| std::mem::size_of_val(mask.words()));
    gray.saturating_add(picture_mask)
        .saturating_add(halftone_zone_mask)
        .saturating_add(spatial_tone_mask)
        .saturating_add(chroma_picture_mask)
        .saturating_add(tonal_protection_mask)
        .saturating_add(semantic_preservation_alpha)
        .saturating_add(photo_preservation_alpha)
        .saturating_add(tone_preservation_alpha)
        .saturating_add(text_mask)
        .saturating_add(text_vicinity_mask)
        .saturating_add(content_picture_mask)
        .saturating_add(std::mem::size_of::<AnalysisArtifact>())
}

fn split_result_bytes(split: &SplitResult) -> usize {
    let polygons = split
        .pages
        .iter()
        .map(|polygon| polygon.points.len() * std::mem::size_of::<Point>())
        .sum::<usize>();
    let seam = split
        .split_seam
        .as_ref()
        .map_or(0, |seam| seam.points.len() * std::mem::size_of::<Point>());
    let binary = split
        .reusable_binary
        .as_ref()
        .map_or(0, |binary| std::mem::size_of_val(binary.words()));
    std::mem::size_of::<SplitResult>()
        .saturating_add(polygons)
        .saturating_add(seam)
        .saturating_add(binary)
}

fn gutter_band_needs_raw_remeasurement(split: &SplitResult) -> bool {
    split.classification == LayoutClassification::TwoPageSpread
        && split
            .cutter_x
            .is_some_and(|cutter| split.diagnostics.fold_band.needs_raw_remeasurement(cutter))
}

/// Compare canonical and working region geometry after placing both planes in
/// the same unit square. Each output region is rounded independently on its
/// raster, so permit one sample from each plane at every edge while still
/// rejecting a same-half rectangle that materially moved or changed size.
fn regions_match_in_common_coordinates(
    canonical_regions: &[(Rect, PageHalf)],
    working_regions: &[(Rect, PageHalf)],
    canonical_width: usize,
    canonical_height: usize,
    working_width: usize,
    working_height: usize,
) -> bool {
    if canonical_regions.len() != working_regions.len() {
        return false;
    }
    let canonical_width = canonical_width.max(1) as f64;
    let canonical_height = canonical_height.max(1) as f64;
    let working_width = working_width.max(1) as f64;
    let working_height = working_height.max(1) as f64;
    let tolerance_x = 1.0 / canonical_width + 1.0 / working_width + f64::EPSILON;
    let tolerance_y = 1.0 / canonical_height + 1.0 / working_height + f64::EPSILON;
    canonical_regions.iter().zip(working_regions).all(
        |((canonical, canonical_half), (working, working_half))| {
            if canonical_half != working_half {
                return false;
            }
            let canonical_edges = [
                canonical.x / canonical_width,
                canonical.y / canonical_height,
                canonical.right() / canonical_width,
                canonical.bottom() / canonical_height,
            ];
            let working_edges = [
                working.x / working_width,
                working.y / working_height,
                working.right() / working_width,
                working.bottom() / working_height,
            ];
            canonical_edges[..]
                .iter()
                .zip(working_edges)
                .zip([tolerance_x, tolerance_y, tolerance_x, tolerance_y])
                .all(|((left, right), tolerance)| {
                    left.is_finite() && right.is_finite() && (left - right).abs() <= tolerance
                })
        },
    )
}

fn scale_split_result(
    split: &mut SplitResult,
    scale_x: f64,
    scale_y: f64,
    full_width: usize,
    full_height: usize,
) {
    split.cutter_x = split.cutter_x.map(|x| x / scale_x);
    split.diagnostics.fold_band.scale_x(scale_x, full_width);
    if let Some(seam) = &mut split.split_seam {
        for point in &mut seam.points {
            point.x = (point.x / scale_x).clamp(0.0, full_width as f64);
            point.y = (point.y / scale_y).clamp(0.0, full_height as f64);
        }
    }
    for page in &mut split.pages {
        for point in &mut page.points {
            point.x /= scale_x;
            point.y /= scale_y;
        }
    }
    for page in &mut split.pages {
        for point in &mut page.points {
            point.x = point.x.clamp(0.0, full_width as f64);
            point.y = point.y.clamp(0.0, full_height as f64);
        }
    }
}

fn should_refine_line_art_picture_ownership(diagnostics: &OutputModeDiagnostics) -> bool {
    is_line_art_picture(diagnostics)
}

fn confirmed_photo_preservation_policy(picture_owner: Option<&BinaryImage>) -> bool {
    picture_owner.is_some_and(|owner| owner.count_black() > 0)
}

fn picture_and_line_art_preservation_alpha(
    layout_normalized: &GrayImage,
    texture_source: &GrayImage,
    tonal_protection_mask: Option<&BinaryImage>,
    photographic_picture_mask: Option<&BinaryImage>,
    refine_line_art: bool,
) -> Option<Arc<GrayImage>> {
    let exact_photo_alpha = photographic_picture_mask
        .and_then(photo_tone_preservation_alpha)
        .map(Arc::new);
    let line_art_geometry = if refine_line_art {
        tonal_protection_mask.map(|geometry| {
            photographic_picture_mask.map_or_else(
                || Arc::new(geometry.clone()),
                |photo| Arc::new(geometry.subtract(photo)),
            )
        })
    } else {
        None
    };
    let refined_line_art_alpha = line_art_geometry
        .as_deref()
        .and_then(|geometry| {
            refine_line_art_preservation_alpha(layout_normalized, texture_source, Some(geometry))
        })
        .map(Arc::new);
    union_optional_gray_fields(exact_photo_alpha.as_ref(), refined_line_art_alpha.as_ref())
}

/// Illumination fitting can occasionally model a small isolated mark as part
/// of the paper field before binarization sees it. Reclaim only raw-dark
/// components that have printable line-art geometry and are outside the
/// semantic picture/chroma owner. Broad scanner shadows and photo plates are
/// therefore ineligible regardless of their absolute shade.
fn rescue_isolated_raw_ink(raw: &GrayImage, picture_mask: &BinaryImage, dpi: f64) -> BinaryImage {
    debug_assert_eq!(raw.width(), picture_mask.width());
    debug_assert_eq!(raw.height(), picture_mask.height());
    let threshold = otsu_threshold(raw);
    let candidates = BinaryImage::from_fn_parallel(raw.width(), raw.height(), |x, y| {
        raw.get(x, y) <= threshold && !picture_mask.get(x, y)
    });
    let px_per_mm = dpi.max(1.0) / 25.4;
    let compact_extent = (px_per_mm * 12.0).round().max(2.0) as usize;
    let compact_area = ((px_per_mm * 6.0).round().max(2.0) as usize).pow(2);
    let rule_minor_extent = (px_per_mm * 1.5).round().max(1.0) as usize;
    let rule_major_extent = (px_per_mm * 60.0).round().max(2.0) as usize;
    ComponentMap::from_binary(&candidates).retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let major = width.max(height);
        let minor = width.min(height);
        component.area >= 2
            && ((component.area <= compact_area && major <= compact_extent)
                || (minor <= rule_minor_extent && major <= rule_major_extent))
    })
}

// The verdict is per component, never per pixel: a binarized glyph edge
// legitimately extends a little past the raw dark core, and intersecting
// pixel-wise chews those contours into ragged type at high zoom. A component
// whose own pixels find almost no darker-than-local-paper source evidence is
// fabricated and dies whole; one with real support keeps its exact rendered
// shape.
const SOURCE_SUPPORT_MINIMUM_FRACTION_PERCENT: usize = 30;

fn enforce_source_ink_support(
    binary: BinaryImage,
    raw: &GrayImage,
    trusted_foreground: Option<&BinaryImage>,
    trusted_selection_complete: bool,
    dpi: f64,
) -> BinaryImage {
    debug_assert_eq!(binary.width(), raw.width());
    debug_assert_eq!(binary.height(), raw.height());
    if let Some(trusted_foreground) = trusted_foreground {
        debug_assert_eq!(binary.width(), trusted_foreground.width());
        debug_assert_eq!(binary.height(), trusted_foreground.height());
        // A complete high-resolution MRC selection already records the
        // producer's exact glyph boundary. Re-thresholding the flattened page
        // can only grow or reshape those one-bit contours, which is especially
        // visible on serif text at high zoom. Full-resolution MRC backgrounds
        // are classified as incomplete by the batch adapter and retain the
        // raw-supported union below because real ink may live outside their
        // selection mask.
        if trusted_selection_complete {
            return trusted_foreground.clone();
        }
    }
    let components = ComponentMap::from_binary(&binary);
    let padding = (dpi.max(1.0) * 0.7 / 25.4).round().max(2.0) as usize;
    let accepted = components.retain(|component| {
        let left = component.left.saturating_sub(padding);
        let top = component.top.saturating_sub(padding);
        let right = component
            .right
            .saturating_add(padding)
            .min(raw.width().saturating_sub(1));
        let bottom = component
            .bottom
            .saturating_add(padding)
            .min(raw.height().saturating_sub(1));
        let mut histogram = [0usize; 256];
        let mut sample_count = 0usize;
        for y in top..=bottom {
            for x in left..=right {
                histogram[usize::from(raw.get(x, y))] += 1;
                sample_count += 1;
            }
        }
        let target = sample_count.saturating_sub(1) * 3 / 4;
        let mut cumulative = 0usize;
        let mut paper = 255u8;
        for (value, count) in histogram.into_iter().enumerate() {
            cumulative += count;
            if cumulative > target {
                paper = value as u8;
                break;
            }
        }
        let mut supported = 0usize;
        let mut total = 0usize;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if components.label_at(x, y) != component.label {
                    continue;
                }
                total += 1;
                let sample = raw.get(x, y);
                if sample < paper || paper == 0 && sample == 0 {
                    supported += 1;
                }
            }
        }
        supported * 100 >= total * SOURCE_SUPPORT_MINIMUM_FRACTION_PERCENT
    });
    if let Some(trusted) = trusted_foreground {
        trusted.or(&accepted)
    } else {
        accepted
    }
}

fn trusted_mixed_foreground(
    trusted_foreground: Option<&BinaryImage>,
    picture_mask: &BinaryImage,
) -> Option<BinaryImage> {
    trusted_foreground.map(|trusted| trusted.subtract(picture_mask))
}

/// Keeps only the semantic-text components the stencil does not already own.
///
/// Text evidence is segmented on the coarser canonical analysis plane and is
/// nearest-neighbour resampled onto the render grid, so its contours are
/// quantized to the analysis grid rather than to the rendered scan. Unioning
/// that evidence pixel by pixel redrew every glyph the binarizer had already
/// found at the coarser grid's resolution, which published systematically
/// heavier text than the same page's B&W route. Recalling glyphs the
/// picture-excluding binarizer dropped outright is what this evidence is for,
/// and that survives here.
///
/// The gate is deliberately "the stencil found nothing of this component", not
/// the fractional accretion test [`drop_boundary_accretion_clusters`] applies to
/// faint-ink rescue, for three reasons that were measured rather than argued.
///
/// Ownership: stroke geometry belongs to the render-resolution binarizer, and
/// recall of dark source ink it missed already belongs to
/// [`rescue_isolated_raw_ink`], which reads the render-resolution source raster
/// on the very next line. A partially found glyph is a found glyph, so the only
/// question this coarse evidence can still answer is whether the stencil found
/// anything at all.
///
/// Calibration: the rescue cap is tuned for proposals generated at render
/// resolution, whose accretion is a one-pixel halo that is almost entirely
/// adjacent to captured ink. This evidence arrives through a 2x upsample, so its
/// accretion band is two to three pixels thick and only its inner layer is
/// adjacent. Applying that cap to the additions here kept 73k pixels on source
/// spread 5 of the reference scan and 81k on spread 90, of which 99.8% lay
/// within three pixels of ink the stencil had already captured: the same
/// outline redraw, retained.
///
/// Cost: on the faintest pages of that scan, nothing this gate drops carries
/// source ink. Of 151,504 pixels dropped on spread 5 and 174,161 on spread 15,
/// none had a source sample below 128; their median source tone was 241-243
/// against paper at 253-254 and captured ink at 8-10.
fn unowned_text_recall(text_mask: &BinaryImage, binary: &BinaryImage) -> BinaryImage {
    debug_assert_eq!(
        (text_mask.width(), text_mask.height()),
        (binary.width(), binary.height()),
    );
    let components = ComponentMap::from_binary(text_mask);
    // Contact is collected in one pass over the stencil. Testing each
    // component against its own bounding box instead would re-read the pixels
    // that overlapping bounds share, which on a mask of many long components
    // costs more than the raster itself. Labels are numbered from one, so
    // index zero absorbs the background and is never consulted.
    let mut contacted = vec![false; components.components().len() + 1];
    for y in 0..binary.height() {
        for x in 0..binary.width() {
            if binary.get(x, y) {
                contacted[components.label_at(x, y) as usize] = true;
            }
        }
    }
    components.retain(|component| !contacted[component.label as usize])
}

fn filter_soft_shallow_bleed_components(
    binary: &BinaryImage,
    raw: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
) -> BinaryImage {
    debug_assert_eq!(binary.width(), raw.width());
    debug_assert_eq!(binary.height(), raw.height());
    debug_assert!(picture_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    debug_assert!(text_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    if binary.count_black() == 0 {
        return binary.clone();
    }

    const LARGE_CRISPNESS_FLOOR: f64 = 24.0;
    const LARGE_SHALLOW_DEPTH: u8 = 72;
    let crispness_floor = f64::from(BLEED_CRISPNESS_FLOOR);
    let shallow_depth = BLEED_SHALLOW_DEPTH;

    let gradient_radius = (dpi * 0.12 / 25.4).round().clamp(1.0, 4.0) as usize;
    let boundary_radius = (dpi * 0.07 / 25.4).round().clamp(1.0, 3.0) as usize;
    let boundary = erode(binary, boundary_radius, boundary_radius);
    let (raw_max, raw_min) = rayon::join(
        || erode_gray(raw, gradient_radius, gradient_radius),
        || dilate_gray(raw, gradient_radius, gradient_radius),
    );
    let components = ComponentMap::from_binary(binary);
    let (raw_sums, raw_counts) = components.gray_sums_by_component(raw);
    let mut gradient_sums = vec![0u64; components.components().len() + 1];
    let mut gradient_counts = vec![0usize; components.components().len() + 1];
    let paper = paper_reference(raw);
    let shallow_floor = paper.saturating_sub(shallow_depth);
    let mut deep_pixels = vec![0usize; components.components().len() + 1];
    let mut text_overlap = vec![0usize; components.components().len() + 1];
    let mut protected = vec![false; components.components().len() + 1];
    let protected_picture = picture_mask.map(|mask| {
        let radius = picture_protection_radius(dpi);
        dilate(mask, radius, radius)
    });
    for y in 0..binary.height() {
        for x in 0..binary.width() {
            if !binary.get(x, y) {
                continue;
            }
            let label = components.label_at(x, y) as usize;
            if protected_picture
                .as_ref()
                .is_some_and(|mask| mask.get(x, y))
            {
                protected[label] = true;
            }
            if raw.get(x, y) < shallow_floor {
                deep_pixels[label] += 1;
            }
            if text_mask.is_some_and(|mask| mask.get(x, y)) {
                text_overlap[label] += 1;
            }
            if !boundary.get(x, y) {
                gradient_sums[label] +=
                    u64::from(raw_max.get(x, y).saturating_sub(raw_min.get(x, y)));
                gradient_counts[label] += 1;
            }
        }
    }
    let area_ceiling = ((dpi.max(1.0) * 2.0 / 25.4).powi(2)).round().max(16.0) as usize;
    let underline_major_extent = (dpi.max(1.0) * 15.0 / 25.4).round().max(24.0) as usize;
    let underline_max_thickness = (dpi.max(1.0) * 2.0 / 25.4).round().max(2.0) as usize;
    let underline_max_gap = (dpi.max(1.0) * 14.0 / 25.4).round().max(8.0) as usize;
    let trace_bleed = std::env::var_os("EVB_SCAN_CLEANUP_TRACE_BLEED").is_some();
    let underline_components = components.components().iter().fold(
        vec![false; components.components().len() + 1],
        |mut flags, component| {
            let label = component.label as usize;
            let width = component.right - component.left + 1;
            let height = component.bottom - component.top + 1;
            let text_row_above = {
                let left = component.left;
                let right = component.right.min(binary.width().saturating_sub(1));
                let top = component.top.saturating_sub(underline_max_gap);
                (top..component.top).any(|y| {
                    (left..=right).any(|x| {
                        text_mask.is_some_and(|mask| mask.get(x, y))
                            || text_vicinity_mask.is_some_and(|mask| mask.get(x, y))
                    })
                })
            };
            let horizontal_rule = width >= underline_major_extent
                && width >= height.saturating_mul(4)
                && height <= underline_max_thickness;
            let has_depth_or_crispness = deep_pixels[label].saturating_mul(4) >= component.area
                || (gradient_counts[label] > 0
                    && gradient_sums[label] as f64 / gradient_counts[label] as f64
                        >= LARGE_CRISPNESS_FLOOR);
            flags[label] = horizontal_rule
                && text_overlap[label] == 0
                && text_row_above
                && has_depth_or_crispness;
            flags
        },
    );
    let retained = components.retain(|component| {
        let label = component.label as usize;
        if protected[label]
            || underline_components[label]
            || gradient_counts[label] == 0
            || raw_counts[label] == 0
        {
            return true;
        }
        let mean = raw_sums[label] as f64 / raw_counts[label] as f64;
        let crispness = gradient_sums[label] as f64 / gradient_counts[label] as f64;
        let kept = if component.area <= area_ceiling {
            !(crispness < crispness_floor && mean >= f64::from(paper.saturating_sub(shallow_depth)))
        } else {
            !(crispness < LARGE_CRISPNESS_FLOOR
                && mean >= f64::from(paper.saturating_sub(LARGE_SHALLOW_DEPTH)))
        };
        if trace_bleed && component.area >= 8 {
            eprintln!(
                "{{\"event\":\"bleed-component\",\"left\":{},\"top\":{},\
                 \"right\":{},\"bottom\":{},\"area\":{},\"mean\":{mean:.2},\
                 \"crispness\":{crispness:.2},\"paper\":{paper},\"kept\":{kept}}}",
                component.left, component.top, component.right, component.bottom, component.area,
            );
        }
        kept
    });
    // A bleed rule that crosses a running head merges with the glyphs into
    // one component that the verdict above rightly keeps, so the merged
    // strike must be removed pixelwise: a bleed pixel is simultaneously
    // shallow and locally soft, while every genuine glyph pixel is either
    // deep (stroke interior) or crisp (antialiased edge). Erasing only the
    // pixels that fail both tests strips the strike and leaves the glyphs
    // it crossed intact.
    let stripped = BinaryImage::from_fn_parallel(retained.width(), retained.height(), |x, y| {
        let label = components.label_at(x, y) as usize;
        retained.get(x, y)
            && (underline_components[label]
                || raw.get(x, y) < shallow_floor
                || f64::from(raw_max.get(x, y).saturating_sub(raw_min.get(x, y)))
                    >= crispness_floor
                || protected_picture
                    .as_ref()
                    .is_some_and(|mask| mask.get(x, y)))
    });
    if trace_bleed {
        let mut erased = vec![0usize; components.components().len() + 1];
        for y in 0..retained.height() {
            for x in 0..retained.width() {
                if retained.get(x, y) && !stripped.get(x, y) {
                    erased[components.label_at(x, y) as usize] += 1;
                }
            }
        }
        for component in components.components() {
            let count = erased[component.label as usize];
            if count * 4 >= component.area.max(1) {
                eprintln!(
                    "{{\"event\":\"bleed-pixel-erase\",\"left\":{},\"top\":{},\
                     \"right\":{},\"bottom\":{},\"area\":{},\"erased\":{count}}}",
                    component.left,
                    component.top,
                    component.right,
                    component.bottom,
                    component.area,
                );
            }
        }
    }
    stripped
}

/// Reclaims only exact raw-dark pixels from a coherent horizontal rule that
/// survived source analysis but was absent from the binary input. This is a
/// narrow fallback for threshold loss; the primary preservation path exempts
/// rule-scale binary components from post-processing in `bw`.
fn restore_genuine_horizontal_rules(
    binary: &BinaryImage,
    raw: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
) -> BinaryImage {
    // The previous implementation filled the bounding box of any qualifying
    // dark row band, INVENTING solid bars where the source has a thin rule or
    // an unmasked text row (fullbook p8 grew a fabricated thick header bar
    // plus a duplicate mid-page). This fallback never fills a bounding box:
    // it can only re-mark exact raw-dark component pixels.
    debug_assert_eq!(binary.width(), raw.width());
    debug_assert_eq!(binary.height(), raw.height());
    debug_assert!(picture_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    debug_assert!(text_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| { mask.width() == binary.width() && mask.height() == binary.height() }));
    if raw.width() == 0 || raw.height() == 0 {
        return binary.clone();
    }

    let paper = paper_reference(raw);
    let raw_dark_floor = paper.saturating_sub(RULE_RAW_DEPTH);
    let picture_owner = picture_mask.map(|mask| {
        let radius = picture_protection_radius(dpi);
        dilate(mask, radius, radius)
    });
    let raw_candidates = BinaryImage::from_fn_parallel(raw.width(), raw.height(), |x, y| {
        raw.get(x, y) <= raw_dark_floor
            && !picture_owner.as_ref().is_some_and(|mask| mask.get(x, y))
    });
    // A scanned rule thresholds into dashes, so candidacy is measured on a
    // horizontally bridged map; the pixels that are re-marked still come
    // exclusively from the unbridged raw candidates, keeping the
    // no-invention subset property exact.
    let bridge_radius = (dpi.max(1.0) * 1.5 / 25.4).round().max(2.0) as usize;
    let bridged = dilate(&raw_candidates, bridge_radius, 0);
    let components = ComponentMap::from_binary(&bridged);
    if components.components().is_empty() {
        return binary.clone();
    }

    let minimum_span = (dpi.max(1.0) * 15.0 / 25.4).round().max(24.0) as usize;
    // Candidacy is measured on a map already bridged horizontally by
    // `bridge_radius`, which fuses the glyphs of an ordinary text line into one
    // long blob. Aspect ratio therefore cannot stand in for thinness: every
    // body, footnote, and index line clears any aspect threshold once bridged.
    // Thickness is the only property that still separates a printed rule from a
    // line of type, so it decides admission alone.
    let maximum_thickness = (dpi.max(1.0) * 2.0 / 25.4).round().max(2.0) as usize;
    let maximum_text_gap = (dpi.max(1.0) * 14.0 / 25.4).round().max(8.0) as usize;
    let minimum_row_support = (minimum_span / 8).max(8);
    let mut rule_components = vec![false; components.components().len() + 1];
    for component in components.components() {
        let label = component.label as usize;
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let horizontal_rule = width >= minimum_span
            && width >= height.saturating_mul(4)
            && height <= maximum_thickness
            && component.area >= width;
        if !horizontal_rule {
            continue;
        }

        let overlaps_text = text_mask.is_some_and(|mask| {
            (component.top..=component.bottom).any(|y| {
                (component.left..=component.right)
                    .any(|x| raw_candidates.get(x, y) && mask.get(x, y))
            })
        });
        if overlaps_text {
            continue;
        }

        let text_row_above =
            (component.top.saturating_sub(maximum_text_gap)..component.top).any(|y| {
                (component.left..=component.right).any(|x| {
                    text_mask.is_some_and(|mask| mask.get(x, y))
                        || text_vicinity_mask.is_some_and(|mask| mask.get(x, y))
                })
            });
        let raw_row_above = if text_mask.is_none() && text_vicinity_mask.is_none() {
            (component.top.saturating_sub(maximum_text_gap)..component.top).any(|y| {
                (component.left..=component.right)
                    .filter(|&x| raw_candidates.get(x, y))
                    .count()
                    >= minimum_row_support
            })
        } else {
            false
        };
        rule_components[label] = text_row_above || raw_row_above;
    }

    // Band acceptance came from the bridged map; the marked pixels are the
    // intersection with the unbridged raw candidates, so every new black
    // pixel is dark in `raw` at that exact coordinate.
    let accepted_bands = components.retain(|component| rule_components[component.label as usize]);
    let restored = BinaryImage::from_fn_parallel(raw.width(), raw.height(), |x, y| {
        accepted_bands.get(x, y) && raw_candidates.get(x, y)
    });
    binary.or(&restored)
}

fn normalize_tone_to_paper(sample: u8, paper: u8) -> u8 {
    normalize_tone_to_paper_with_shoulder(sample, paper, 48.0)
}

/// Maps paper-level samples to white through a smooth shoulder while keeping
/// darker content proportional. Zone interiors use a narrower shoulder so a
/// producer-authored plate field or a map sea lifts to white while photo
/// midtones and highlights keep their separation.
fn normalize_tone_to_paper_with_shoulder(sample: u8, paper: u8, shoulder: f64) -> u8 {
    if paper == 0 || sample >= paper {
        return 255;
    }
    let paper = f64::from(paper);
    let value = f64::from(sample);
    let scaled = value * 255.0 / paper;
    let shoulder_low = (paper - shoulder).max(0.0);
    if value <= shoulder_low {
        return scaled.round().clamp(0.0, 255.0) as u8;
    }
    let t = ((value - shoulder_low) / (paper - shoulder_low).max(1.0)).clamp(0.0, 1.0);
    let paper_weight = 1.0 - (1.0 - t).powi(3);
    (scaled * (1.0 - paper_weight) + 255.0 * paper_weight)
        .round()
        .clamp(0.0, 255.0) as u8
}

/// Applies the render-space ownership rules for a fresh Mixed partition.
///
/// The halftone classifier's completed zone is an exact stencil exclusion,
/// even when a later text-vicinity pass sees dark pixels inside that zone.
/// Text ownership may still carve a broader picture mask everywhere outside
/// the exact zone; this keeps nearby body text in the high-resolution
/// foreground without allowing it to turn a completed tonal region into
/// bilevel output.
fn partition_mixed_picture_mask(
    picture_mask: &mut Option<BinaryImage>,
    preserve_confirmed_photo_tones: bool,
    spatial_tone_mask: Option<&BinaryImage>,
    chroma_picture_mask: Option<&BinaryImage>,
    tone_picture_mask: Option<&BinaryImage>,
    halftone_zone_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
    text_line_count: usize,
) {
    // A qualified spatial-tone mask is another continuous-tone owner for the
    // fresh Mixed partition. It is deliberately unioned before the immutable
    // photo-owner early return so a flat diagram next to a photo is not
    // silently sent through the text/stencil carve.
    if let Some(spatial) = spatial_tone_mask {
        *picture_mask = Some(match picture_mask.take() {
            Some(picture) => picture.or(spatial),
            None => spatial.clone(),
        });
    }
    // A confirmed owner's exact pixels are immutable. This partition remains
    // useful for ownerless/chroma-only Mixed representations, but text-row
    // refinement cannot turn any part of a vetted photo back into paper or
    // bilevel foreground.
    if preserve_confirmed_photo_tones {
        return;
    }
    let (Some(picture_mask), Some(text_vicinity)) = (picture_mask.as_mut(), text_vicinity_mask)
    else {
        return;
    };
    // Mixed is a representation partition: semantic text belongs to the
    // high-resolution foreground even when a coarse picture mask surrounds
    // it. Coherent tone and the exact classifier zone are exceptions: both
    // retain ownership in the continuous-tone layer.
    // A line detector deliberately publishes tight per-line rectangles. If a
    // coarse picture component also surrounds those lines, carving only the
    // rectangles leaves alternating gray and white bands between baselines.
    // Close vertically by one physical millimetre so neighboring lines form
    // one paper field without changing the outer line boundaries or growing
    // sideways into an adjacent photograph. The larger guarded bridge is
    // applied after the initial ownership exceptions so it sees the actual
    // surviving row fields, not candidates that a tone mask later removes.
    let interline_radius = (dpi.max(1.0) / 25.4).round().clamp(1.0, 32.0) as usize;
    let text_field = erode(
        &dilate(text_vicinity, 0, interline_radius),
        0,
        interline_radius,
    )
    .or(text_vicinity);
    let mut text_owned = chroma_picture_mask
        .map_or_else(|| text_field.clone(), |chroma| text_field.subtract(chroma));
    if let Some(tone) = tone_picture_mask {
        text_owned = text_owned.subtract(tone);
    }
    if let Some(zone) = halftone_zone_mask {
        text_owned = text_owned.subtract(zone);
    }
    // A repeated chain of surviving extra-wide row fields is stronger
    // text-column evidence than a narrow generic gray-paper band between
    // them. Chroma and completed halftone zones remain exact ownership
    // exceptions.
    bridge_aligned_text_rows(&mut text_owned, dpi);
    bridge_scanline_text_rows(&mut text_owned, dpi, text_line_count);
    if let Some(chroma) = chroma_picture_mask {
        text_owned = text_owned.subtract(chroma);
    }
    if let Some(zone) = halftone_zone_mask {
        text_owned = text_owned.subtract(zone);
    }
    *picture_mask = picture_mask.subtract(&text_owned);
}

/// Applies one mild descreening pass inside a confirmed photo owner.
///
/// The sample outside the owner is replaced with the target center value, so
/// the filter cannot bleed normalized paper or nearby text into a photo edge.
/// This is intentionally a render-input filter, not a general page blur.
fn prefilter_confirmed_photo_regions(image: &mut GrayImage, owner: &BinaryImage) {
    debug_assert_eq!(
        (image.width(), image.height()),
        (owner.width(), owner.height())
    );
    if image.width() < 3 || image.height() < 3 || owner.count_black() == 0 {
        return;
    }
    let original = image.clone();
    let kernel = [1u32, 2, 1];
    let width = image.width();
    let height = image.height();
    let stride = image.stride();
    image
        .data_mut()
        .par_chunks_mut(stride)
        .enumerate()
        .for_each(|(y, row)| {
            if y == 0 || y == height - 1 {
                return;
            }
            for (x, target) in row.iter_mut().enumerate().take(width - 1).skip(1) {
                if !owner.get(x, y) {
                    continue;
                }
                let center = u32::from(original.get(x, y));
                let mut weighted_sum = 0u32;
                let mut weight_sum = 0u32;
                for (ky, &row_weight) in kernel.iter().enumerate() {
                    for (kx, &column_weight) in kernel.iter().enumerate() {
                        let sample_x = x + kx - 1;
                        let sample_y = y + ky - 1;
                        let weight = row_weight * column_weight;
                        let sample = if owner.get(sample_x, sample_y) {
                            u32::from(original.get(sample_x, sample_y))
                        } else {
                            center
                        };
                        weighted_sum += sample * weight;
                        weight_sum += weight;
                    }
                }
                *target = (weighted_sum / weight_sum.max(1)) as u8;
            }
        });
}

fn should_prefilter_confirmed_photo_regions(
    preserve_confirmed_photo_tones: bool,
    output_mode: OutputMode,
    rendered_width: usize,
    rendered_height: usize,
    source_width: usize,
    source_height: usize,
) -> bool {
    preserve_confirmed_photo_tones
        && matches!(output_mode, OutputMode::Grayscale | OutputMode::Mixed)
        && (rendered_width < source_width || rendered_height < source_height)
}

/// Joins only a repeated chain of wide, vertically separated row fields.
///
/// The content detector can miss one or two low-contrast lines inside an
/// otherwise coherent text column. Requiring three aligned fields with
/// near-total horizontal overlap identifies a column pattern. A chain-global
/// intersection prevents a wide hub from joining two unrelated columns.
fn bridge_aligned_text_rows(text_field: &mut BinaryImage, dpi: f64) {
    #[derive(Clone, Copy)]
    struct RowField {
        left: usize,
        top: usize,
        right: usize,
        bottom: usize,
    }

    fn root(parents: &mut [usize], mut index: usize) -> usize {
        while parents[index] != index {
            parents[index] = parents[parents[index]];
            index = parents[index];
        }
        index
    }

    fn union(parents: &mut [usize], left: usize, right: usize) {
        let left_root = root(parents, left);
        let right_root = root(parents, right);
        if left_root != right_root {
            parents[right_root] = left_root;
        }
    }

    let dpi = dpi.max(1.0);
    let minimum_width = (dpi * 30.0 / 25.4).round().max(1.0) as usize;
    let maximum_gap = (dpi * 9.0 / 25.4).round().max(1.0) as usize;
    let components = ComponentMap::from_binary(text_field);
    let mut rows = components
        .components()
        .iter()
        .filter_map(|component| {
            let width = component.right - component.left + 1;
            (width >= minimum_width).then_some(RowField {
                left: component.left,
                top: component.top,
                right: component.right,
                bottom: component.bottom,
            })
        })
        .collect::<Vec<_>>();
    rows.sort_unstable_by_key(|row| row.top);
    if rows.len() < 3 {
        return;
    }

    let mut parents = (0..rows.len()).collect::<Vec<_>>();
    for (upper_index, upper) in rows.iter().enumerate() {
        for (lower_index, lower) in rows.iter().enumerate().skip(upper_index + 1) {
            if lower.top <= upper.bottom {
                continue;
            }
            let gap = lower.top - upper.bottom - 1;
            if gap > maximum_gap {
                break;
            }
            let left = upper.left.max(lower.left);
            let right = upper.right.min(lower.right);
            if right < left {
                continue;
            }
            let overlap = right - left + 1;
            let smaller_width = (upper.right - upper.left + 1).min(lower.right - lower.left + 1);
            if overlap.saturating_mul(5) >= smaller_width.saturating_mul(4) {
                union(&mut parents, upper_index, lower_index);
            }
        }
    }

    let mut chain_sizes = vec![0usize; rows.len()];
    let mut chain_left = vec![0usize; rows.len()];
    let mut chain_right = vec![usize::MAX; rows.len()];
    let mut chain_top = vec![usize::MAX; rows.len()];
    let mut chain_bottom = vec![0usize; rows.len()];
    for (index, row) in rows.iter().enumerate() {
        let chain_root = root(&mut parents, index);
        chain_sizes[chain_root] += 1;
        chain_left[chain_root] = chain_left[chain_root].max(row.left);
        chain_right[chain_root] = chain_right[chain_root].min(row.right);
        chain_top[chain_root] = chain_top[chain_root].min(row.top);
        chain_bottom[chain_root] = chain_bottom[chain_root].max(row.bottom);
    }
    for chain_root in 0..rows.len() {
        if chain_sizes[chain_root] < 3
            || chain_right[chain_root] < chain_left[chain_root]
            || chain_right[chain_root] - chain_left[chain_root] + 1 < minimum_width
        {
            continue;
        }
        for y in chain_top[chain_root]..=chain_bottom[chain_root] {
            for x in chain_left[chain_root]..=chain_right[chain_root] {
                text_field.set(x, y, true);
            }
        }
    }
}

/// Finds text-column chains that narrow vertical connectors hide from 2-D
/// connected-component analysis.
///
/// On dense pages, a preparatory tier repairs shorter row fragments using the
/// established 30 mm / 9 mm limits. A strict second tier permits the larger
/// measured gaps only when every field is at least 60 mm wide and shares 90%
/// of its span. Both fill one chain-global horizontal intersection, so a run
/// that drifts around an adjacent portrait cannot widen the text owner.
fn bridge_scanline_text_rows(text_field: &mut BinaryImage, dpi: f64, text_line_count: usize) {
    if text_line_count >= 20 {
        bridge_scanline_text_row_tier(text_field, dpi, 30.0, 0.35, 9.0, 4, 5);
        bridge_scanline_text_row_tier(text_field, dpi, 60.0, 1.0, 13.0, 9, 10);
    }
}

#[allow(clippy::too_many_arguments)]
fn bridge_scanline_text_row_tier(
    text_field: &mut BinaryImage,
    dpi: f64,
    minimum_width_mm: f64,
    minimum_height_mm: f64,
    maximum_gap_mm: f64,
    overlap_numerator: usize,
    overlap_denominator: usize,
) {
    #[derive(Clone, Copy)]
    struct RunBand {
        left: usize,
        top: usize,
        right: usize,
        bottom: usize,
    }

    fn root(parents: &mut [usize], mut index: usize) -> usize {
        while parents[index] != index {
            parents[index] = parents[parents[index]];
            index = parents[index];
        }
        index
    }

    fn union(parents: &mut [usize], left: usize, right: usize) {
        let left_root = root(parents, left);
        let right_root = root(parents, right);
        if left_root != right_root {
            parents[right_root] = left_root;
        }
    }

    let dpi = dpi.max(1.0);
    let minimum_width = (dpi * minimum_width_mm / 25.4).round().max(1.0) as usize;
    let minimum_height = (dpi * minimum_height_mm / 25.4).round().max(1.0) as usize;
    let maximum_gap = (dpi * maximum_gap_mm / 25.4).round().max(1.0) as usize;
    let width = text_field.width();
    let height = text_field.height();
    if width < minimum_width || height < minimum_height {
        return;
    }

    // Track every simultaneous run independently. Matching against the
    // band's running intersection prevents a right-side portrait run from
    // being unioned into a left-side text column merely because their outer
    // bounding box overlaps.
    let mut active = Vec::<RunBand>::new();
    let mut finished = Vec::<RunBand>::new();
    for y in 0..height {
        let mut runs = Vec::<(usize, usize)>::new();
        let mut x = 0;
        while x < width {
            while x < width && !text_field.get(x, y) {
                x += 1;
            }
            let left = x;
            while x < width && text_field.get(x, y) {
                x += 1;
            }
            if x > left && x - left >= minimum_width {
                runs.push((left, x - 1));
            }
        }

        let mut used = vec![false; active.len()];
        let mut next = Vec::with_capacity(runs.len());
        for (left, right) in runs {
            let run_width = right - left + 1;
            let mut best = None;
            for (index, band) in active.iter().enumerate() {
                if used[index] || band.bottom + 1 != y {
                    continue;
                }
                let overlap_left = left.max(band.left);
                let overlap_right = right.min(band.right);
                if overlap_right < overlap_left {
                    continue;
                }
                let overlap = overlap_right - overlap_left + 1;
                let band_width = band.right - band.left + 1;
                let smaller_width = run_width.min(band_width);
                if overlap < minimum_width
                    || overlap.saturating_mul(overlap_denominator)
                        < smaller_width.saturating_mul(overlap_numerator)
                {
                    continue;
                }
                if best.is_none_or(|(_, best_overlap)| overlap > best_overlap) {
                    best = Some((index, overlap));
                }
            }
            if let Some((index, _)) = best {
                used[index] = true;
                let band = active[index];
                next.push(RunBand {
                    left: band.left.max(left),
                    top: band.top,
                    right: band.right.min(right),
                    bottom: y,
                });
            } else {
                next.push(RunBand {
                    left,
                    top: y,
                    right,
                    bottom: y,
                });
            }
        }
        finished.extend(
            active
                .into_iter()
                .zip(used)
                .filter_map(|(band, used)| (!used).then_some(band)),
        );
        active = next;
    }
    finished.extend(active);
    let mut bands = finished
        .into_iter()
        .filter(|band| band.bottom - band.top + 1 >= minimum_height)
        .collect::<Vec<_>>();
    bands.sort_unstable_by_key(|band| band.top);
    if bands.len() < 3 {
        return;
    }

    let mut parents = (0..bands.len()).collect::<Vec<_>>();
    for (upper_index, upper) in bands.iter().enumerate() {
        for (lower_index, lower) in bands.iter().enumerate().skip(upper_index + 1) {
            if lower.top <= upper.bottom {
                continue;
            }
            let gap = lower.top - upper.bottom - 1;
            if gap > maximum_gap {
                break;
            }
            let left = upper.left.max(lower.left);
            let right = upper.right.min(lower.right);
            if right < left {
                continue;
            }
            let overlap = right - left + 1;
            let smaller_width = (upper.right - upper.left + 1).min(lower.right - lower.left + 1);
            if overlap >= minimum_width
                && overlap.saturating_mul(overlap_denominator)
                    >= smaller_width.saturating_mul(overlap_numerator)
            {
                union(&mut parents, upper_index, lower_index);
            }
        }
    }

    let mut chain_sizes = vec![0usize; bands.len()];
    let mut chain_left = vec![0usize; bands.len()];
    let mut chain_right = vec![usize::MAX; bands.len()];
    let mut chain_top = vec![usize::MAX; bands.len()];
    let mut chain_bottom = vec![0usize; bands.len()];
    for (index, band) in bands.iter().enumerate() {
        let chain_root = root(&mut parents, index);
        chain_sizes[chain_root] += 1;
        chain_left[chain_root] = chain_left[chain_root].max(band.left);
        chain_right[chain_root] = chain_right[chain_root].min(band.right);
        chain_top[chain_root] = chain_top[chain_root].min(band.top);
        chain_bottom[chain_root] = chain_bottom[chain_root].max(band.bottom);
    }
    for chain_root in 0..bands.len() {
        if chain_sizes[chain_root] < 3
            || chain_right[chain_root] < chain_left[chain_root]
            || chain_right[chain_root] - chain_left[chain_root] + 1 < minimum_width
        {
            continue;
        }
        for y in chain_top[chain_root]..=chain_bottom[chain_root] {
            for x in chain_left[chain_root]..=chain_right[chain_root] {
                text_field.set(x, y, true);
            }
        }
    }
}

fn can_reuse_source_mrc_foreground(
    options: &CleanupOptions,
    trusted_foreground_mask: Option<&BinaryImage>,
    picture_mask: &BinaryImage,
    split: &SplitResult,
    half: PageHalf,
    deskew_applied: bool,
    dewarp_applied: bool,
    create_layers: bool,
) -> bool {
    options.trusted_mrc_source_available
        && trusted_foreground_mask.is_some()
        && picture_mask.count_black() > 0
        && create_layers
        && options.source_has_bilevel_layer
        && !options.trusted_selection_incomplete
        && options.manual_zones.picture.is_empty()
        && options.manual_zones.fill.is_empty()
        && options.thickness == 0
        && options.rotation == OrthogonalRotation::None
        && options
            .manual_skew_degrees
            .is_none_or(|degrees| degrees.abs() <= f64::EPSILON)
        && !deskew_applied
        && !dewarp_applied
        && split.classification == LayoutClassification::SingleUncutPage
        && half == PageHalf::Full
}

fn map_region_semantic_output(output: region_rendering::RegionSemanticOutput) -> CleanupResult {
    let region_rendering::RegionSemanticOutput {
        image,
        color_image,
        picture_mask,
        tone_preservation_alpha,
        mixed_layers,
        effectively_blank,
        metadata,
    } = output;
    CleanupResult {
        image,
        color_image,
        metadata,
        picture_mask,
        tone_preservation_alpha,
        mixed_layers,
        effectively_blank,
    }
}

fn render_binary_mask(
    source: &BinaryImage,
    width: usize,
    height: usize,
    map: impl Fn(Point) -> Option<Point> + Sync,
) -> BinaryImage {
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        let Some(mapped) = map(Point::new(x as f64, y as f64)) else {
            return false;
        };
        let source_x = mapped.x.round() as isize;
        let source_y = mapped.y.round() as isize;
        source_x >= 0
            && source_y >= 0
            && source_x < source.width() as isize
            && source_y < source.height() as isize
            && source.get(source_x as usize, source_y as usize)
    })
}

fn auxiliary_mask_scales(
    mask_width: usize,
    mask_height: usize,
    normalized: &GrayImage,
) -> (f64, f64) {
    let scale = |mask_extent: usize, normalized_extent: usize| {
        if normalized_extent <= 1 {
            0.0
        } else {
            mask_extent.saturating_sub(1) as f64 / normalized_extent.saturating_sub(1) as f64
        }
    };
    (
        scale(mask_width, normalized.width()),
        scale(mask_height, normalized.height()),
    )
}

fn map_auxiliary_mask_point(
    render_plan: &ComposedRenderPlan,
    mask_scale_x: f64,
    mask_scale_y: f64,
    point: Point,
) -> Option<Point> {
    let source = render_plan.output_to_source(point)?;
    Some(Point::new(source.x * mask_scale_x, source.y * mask_scale_y))
}

fn render_binary_mask_preserve_ink(
    source: &BinaryImage,
    width: usize,
    height: usize,
    footprint_width: f64,
    footprint_height: f64,
    map: impl Fn(Point) -> Option<Point> + Sync,
) -> BinaryImage {
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        let Some(mapped) = map(Point::new(x as f64, y as f64)) else {
            return false;
        };
        let Some((left, right)) = binary_coverage_bounds(mapped.x, footprint_width, source.width())
        else {
            return false;
        };
        let Some((top, bottom)) =
            binary_coverage_bounds(mapped.y, footprint_height, source.height())
        else {
            return false;
        };
        (top..bottom).any(|source_y| (left..right).any(|source_x| source.get(source_x, source_y)))
    })
}

fn binary_coverage_bounds(coordinate: f64, footprint: f64, limit: usize) -> Option<(usize, usize)> {
    if !coordinate.is_finite() || !footprint.is_finite() {
        return None;
    }
    let (start, end) = if footprint > 1.0 {
        (
            (coordinate - footprint * 0.5).ceil() as isize,
            (coordinate + footprint * 0.5).ceil() as isize,
        )
    } else {
        let index = coordinate.round() as isize;
        (index, index.saturating_add(1))
    };
    let limit = limit as isize;
    let start = start.clamp(0, limit) as usize;
    let end = end.clamp(0, limit) as usize;
    (start < end).then_some((start, end))
}

fn render_gray_field(
    source: &GrayImage,
    width: usize,
    height: usize,
    map: impl Fn(Point) -> Option<Point> + Sync,
) -> GrayImage {
    let mut output = GrayImage::new(width, height, 0);
    output
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                let Some(mapped) = map(Point::new(x as f64, y as f64)) else {
                    continue;
                };
                if mapped.x < 0.0
                    || mapped.y < 0.0
                    || mapped.x > source.width().saturating_sub(1) as f64
                    || mapped.y > source.height().saturating_sub(1) as f64
                {
                    continue;
                }
                *target = sample_bilinear_white(source, mapped.x, mapped.y);
            }
        });
    output
}

fn suppress_scanner_edge_bands(
    source: &BinaryImage,
    gray: &GrayImage,
    picture_mask: &BinaryImage,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
) -> (BinaryImage, BinaryImage) {
    debug_assert_eq!(source.width(), gray.width());
    debug_assert_eq!(source.height(), gray.height());
    debug_assert_eq!(source.width(), picture_mask.width());
    debug_assert_eq!(source.height(), picture_mask.height());
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| { mask.width() == source.width() && mask.height() == source.height() }));
    let minimum_thickness = (dpi * 0.6 / 25.4).round().max(2.0) as usize;
    let maximum_thickness = (dpi * 12.0 / 25.4).round().max(3.0) as usize;
    let edge_distance = (dpi * 10.0 / 25.4).round().max(4.0) as usize;
    let mut row_counts = vec![0usize; source.height()];
    let mut picture_row_counts = vec![0usize; source.height()];
    let mut column_counts = vec![0usize; source.width()];
    let mut picture_column_counts = vec![0usize; source.width()];
    for y in 0..source.height() {
        for x in 0..source.width() {
            row_counts[y] += usize::from(source.get(x, y));
            picture_row_counts[y] += usize::from(picture_mask.get(x, y));
            column_counts[x] += usize::from(source.get(x, y));
            picture_column_counts[x] += usize::from(picture_mask.get(x, y));
        }
    }
    let horizontal_bands = dense_edge_band_runs(
        &row_counts,
        &picture_row_counts,
        source.width(),
        minimum_thickness,
        maximum_thickness,
        edge_distance,
    );
    let vertical_bands = dense_edge_band_runs(
        &column_counts,
        &picture_column_counts,
        source.height(),
        minimum_thickness,
        maximum_thickness,
        edge_distance,
    );
    let mut removed = BinaryImage::new(source.width(), source.height());
    for (top, bottom) in horizontal_bands {
        for y in top..=bottom {
            for x in 0..source.width() {
                removed.set(x, y, true);
            }
        }
    }
    for (left, right) in vertical_bands {
        for y in 0..source.height() {
            for x in left..=right {
                removed.set(x, y, true);
            }
        }
    }
    let mut cleaned = source.subtract(&removed);
    // Thresholding a scan shadow can produce a long crescent or a broken cloud
    // rather than a row/column-dense band. Remove those connected components
    // only when their geometry belongs to the physical scan boundary and the
    // page's picture/text ownership masks do not claim them. This deliberately
    // makes ownership, not darkness, the content decision.
    let components = ComponentMap::from_binary(&cleaned);
    let mut owned_pixels = vec![0usize; components.components().len() + 1];
    let mut picture_owned_pixels = vec![0usize; components.components().len() + 1];
    let mut boundary_pixels = vec![0usize; components.components().len() + 1];
    let mut luminance_sum = vec![0usize; components.components().len() + 1];
    let boundary_depth = (dpi * 32.0 / 25.4).round().max(8.0) as usize;
    for y in 0..cleaned.height() {
        for x in 0..cleaned.width() {
            if !cleaned.get(x, y) {
                continue;
            }
            let label = components.label_at(x, y) as usize;
            if label == 0 {
                continue;
            }
            luminance_sum[label] += usize::from(gray.get(x, y));
            if x < boundary_depth
                || y < boundary_depth
                || source.width().saturating_sub(x) <= boundary_depth
                || source.height().saturating_sub(y) <= boundary_depth
            {
                boundary_pixels[label] += 1;
            }
            if picture_mask.get(x, y) {
                picture_owned_pixels[label] += 1;
            }
            if picture_mask.get(x, y) || text_vicinity_mask.is_some_and(|mask| mask.get(x, y)) {
                owned_pixels[label] += 1;
            }
        }
    }
    // "Contacts the scanner boundary" must mean the physical edge, not the
    // ordinary page margin. A 30 mm contact band treated headings, ornaments,
    // stamps, and marginal notes as scanner shadows. Broad inset shadows are
    // still handled by `mostly_boundary_shadow` below.
    let boundary_contact = (dpi * 3.0 / 25.4).round().max(2.0) as usize;
    let minimum_boundary_span = (dpi * 3.0 / 25.4).round().max(3.0) as usize;
    let minimum_boundary_area = ((dpi / 25.4).powi(2) * 12.0).round().max(16.0) as usize;
    let remove_component = |component: &scan_primitives::Component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let left_boundary = component.left <= boundary_contact
            && component.right <= boundary_depth
            && height >= minimum_boundary_span
            && width >= minimum_thickness;
        let right_boundary = source
            .width()
            .saturating_sub(1)
            .saturating_sub(component.right)
            <= boundary_contact
            && source.width().saturating_sub(component.left) <= boundary_depth
            && height >= minimum_boundary_span
            && width >= minimum_thickness;
        let top_boundary = component.top <= boundary_contact
            && component.bottom <= boundary_depth
            && width >= minimum_boundary_span
            && height >= minimum_thickness;
        let bottom_boundary = source
            .height()
            .saturating_sub(1)
            .saturating_sub(component.bottom)
            <= boundary_contact
            && source.height().saturating_sub(component.top) <= boundary_depth
            && width >= minimum_boundary_span
            && height >= minimum_thickness;
        // Keep the ordinary 3 mm contact rule narrow enough for marginal
        // content, but allow a tall, deep scanner rail to use the existing
        // 10 mm edge-distance contract. The span/area/depth/thickness gates
        // and ownership guard keep this bounded to catastrophic rails.
        let tall_deep_left_boundary = component.left <= edge_distance
            && component.right <= boundary_depth
            && height >= edge_distance
            && component.area >= minimum_boundary_area
            && height >= minimum_boundary_span
            && width >= minimum_thickness;
        let tall_deep_right_boundary = source
            .width()
            .saturating_sub(1)
            .saturating_sub(component.right)
            <= edge_distance
            && source.width().saturating_sub(component.left) <= boundary_depth
            && height >= edge_distance
            && component.area >= minimum_boundary_area
            && height >= minimum_boundary_span
            && width >= minimum_thickness;
        let mostly_boundary_shadow = component.area >= minimum_boundary_area
            && boundary_pixels[component.label as usize].saturating_mul(4)
                >= component.area.saturating_mul(3)
            && luminance_sum[component.label as usize] >= component.area.saturating_mul(72);
        let owned = owned_pixels[component.label as usize].saturating_mul(4) >= component.area;
        let picture_owned =
            picture_owned_pixels[component.label as usize].saturating_mul(4) >= component.area;
        // Full-resolution text recall can claim a scanner rail as semantic ink
        // even when the picture mask correctly excludes it. Let only the
        // strongest tall/deep shadow geometry override that text-only claim;
        // picture ownership remains absolute, and dark marginalia does not
        // satisfy the pale-shadow gate.
        let text_owned_tall_deep_shadow = !picture_owned
            && mostly_boundary_shadow
            && (tall_deep_left_boundary || tall_deep_right_boundary);
        if owned && !text_owned_tall_deep_shadow {
            return false;
        }
        left_boundary
            || right_boundary
            || tall_deep_left_boundary
            || tall_deep_right_boundary
            || top_boundary
            || bottom_boundary
            || mostly_boundary_shadow
    };
    let component_artifacts = components.retain(remove_component);
    removed = removed.or(&component_artifacts);
    cleaned = source.subtract(&removed);
    (cleaned, removed)
}

fn dense_edge_band_runs(
    counts: &[usize],
    picture_counts: &[usize],
    span: usize,
    minimum_thickness: usize,
    maximum_thickness: usize,
    edge_distance: usize,
) -> Vec<(usize, usize)> {
    let mut bands = Vec::new();
    let mut start = None;
    for index in 0..=counts.len() {
        let dense =
            index < counts.len() && counts[index].saturating_mul(4) >= span.saturating_mul(3);
        match (start, dense) {
            (None, true) => start = Some(index),
            (Some(first), false) => {
                let last = index - 1;
                let thickness = last - first + 1;
                let near_edge = first <= edge_distance
                    || counts.len().saturating_sub(1).saturating_sub(last) <= edge_distance;
                let picture_owned = picture_counts[first..=last]
                    .iter()
                    .sum::<usize>()
                    .saturating_mul(4)
                    >= span.saturating_mul(thickness);
                if near_edge
                    && !picture_owned
                    && (minimum_thickness..=maximum_thickness).contains(&thickness)
                {
                    let mut expanded_first = first;
                    let mut expanded_last = last;
                    while expanded_first > 0 && counts[expanded_first - 1].saturating_mul(5) >= span
                    {
                        expanded_first -= 1;
                    }
                    while expanded_last + 1 < counts.len()
                        && counts[expanded_last + 1].saturating_mul(5) >= span
                    {
                        expanded_last += 1;
                    }
                    bands.push((expanded_first, expanded_last));
                }
                start = None;
            }
            _ => {}
        }
    }
    bands
}

fn reserve_gray_endpoint(value: u8) -> u8 {
    match value {
        0 => 1,
        255 => 254,
        value => value,
    }
}

fn reserve_rgb_endpoints(value: [u8; 3]) -> [u8; 3] {
    match value {
        [0, 0, 0] => [1, 1, 1],
        [255, 255, 255] => [254, 254, 254],
        value => value,
    }
}

pub(crate) fn downscale_rgb_to_dimensions(
    source: &RgbImage,
    width: usize,
    height: usize,
) -> RgbImage {
    if source.width() == width && source.height() == height {
        return source.clone();
    }
    let mut output = RgbImage::new(width, height, [255; 3]);
    for output_y in 0..height {
        let source_y0 = output_y * source.height() / height;
        let source_y1 = ((output_y + 1) * source.height() / height)
            .max(source_y0 + 1)
            .min(source.height());
        for output_x in 0..width {
            let source_x0 = output_x * source.width() / width;
            let source_x1 = ((output_x + 1) * source.width() / width)
                .max(source_x0 + 1)
                .min(source.width());
            let mut sums = [0u64; 3];
            let mut count = 0u64;
            for source_y in source_y0..source_y1 {
                for source_x in source_x0..source_x1 {
                    let pixel = source.get(source_x, source_y);
                    for channel in 0..3 {
                        sums[channel] += u64::from(pixel[channel]);
                    }
                    count += 1;
                }
            }
            output.set(
                output_x,
                output_y,
                sums.map(|sum| (sum / count.max(1)) as u8),
            );
        }
    }
    output
}

fn rotate_rgb_orthogonal(source: &RgbImage, rotation: OrthogonalRotation) -> RgbImage {
    let (width, height) = (source.width(), source.height());
    match rotation {
        OrthogonalRotation::None => source.clone(),
        OrthogonalRotation::Clockwise180 => {
            let mut output = RgbImage::new(width, height, [255; 3]);
            let pixels = source.data().chunks_exact(3);
            for (target, value) in output.data_mut().chunks_exact_mut(3).rev().zip(pixels) {
                target.copy_from_slice(value);
            }
            output
        }
        OrthogonalRotation::Clockwise90 => {
            let mut output = RgbImage::new(height, width, [255; 3]);
            for y in 0..height {
                let target_x = height - 1 - y;
                for (x, value) in source.row(y).chunks_exact(3).enumerate() {
                    output.set(target_x, x, [value[0], value[1], value[2]]);
                }
            }
            output
        }
        OrthogonalRotation::Clockwise270 => {
            let mut output = RgbImage::new(height, width, [255; 3]);
            for y in 0..height {
                for (x, value) in source.row(y).chunks_exact(3).enumerate() {
                    output.set(y, width - 1 - x, [value[0], value[1], value[2]]);
                }
            }
            output
        }
    }
}

fn rotate_binary_orthogonal(source: &BinaryImage, rotation: OrthogonalRotation) -> BinaryImage {
    let (width, height) = (source.width(), source.height());
    match rotation {
        OrthogonalRotation::None => source.clone(),
        OrthogonalRotation::Clockwise180 => BinaryImage::from_fn_parallel(width, height, |x, y| {
            source.get(width - 1 - x, height - 1 - y)
        }),
        OrthogonalRotation::Clockwise90 => {
            BinaryImage::from_fn_parallel(height, width, |x, y| source.get(y, height - 1 - x))
        }
        OrthogonalRotation::Clockwise270 => {
            BinaryImage::from_fn_parallel(height, width, |x, y| source.get(width - 1 - y, x))
        }
    }
}

fn rotate_orthogonal(source: &GrayImage, rotation: OrthogonalRotation) -> GrayImage {
    let (width, height) = (source.width(), source.height());
    match rotation {
        OrthogonalRotation::None => {
            let mut output = GrayImage::new(width, height, 255);
            for y in 0..height {
                output.row_mut(y).copy_from_slice(source.row(y));
            }
            output
        }
        OrthogonalRotation::Clockwise180 => {
            let mut output = GrayImage::new(width, height, 255);
            for y in 0..height {
                let source_row = source.row(y);
                for (target, value) in output
                    .row_mut(height - 1 - y)
                    .iter_mut()
                    .rev()
                    .zip(source_row)
                {
                    *target = *value;
                }
            }
            output
        }
        OrthogonalRotation::Clockwise90 => {
            let mut output = GrayImage::new(height, width, 255);
            for y in 0..height {
                let target_x = height - 1 - y;
                for (x, value) in source.row(y).iter().enumerate() {
                    output.set(target_x, x, *value);
                }
            }
            output
        }
        OrthogonalRotation::Clockwise270 => {
            let mut output = GrayImage::new(height, width, 255);
            for y in 0..height {
                for (x, value) in source.row(y).iter().enumerate() {
                    output.set(y, width - 1 - x, *value);
                }
            }
            output
        }
    }
}

fn is_effectively_blank(image: &GrayImage, dpi: f64) -> bool {
    let ink = image.data().iter().filter(|&&value| value < 224).count();
    let dpi_floor = (24.0 * (dpi / 300.0).powi(2)).round().max(6.0) as usize;
    let coverage_floor =
        (image.width().saturating_mul(image.height()) as f64 * 0.00002).round() as usize;
    ink <= dpi_floor.max(coverage_floor)
}

fn crop_gray(source: &GrayImage, rect: Rect) -> GrayImage {
    let left = rect.x.round().clamp(0.0, source.width() as f64) as usize;
    let top = rect.y.round().clamp(0.0, source.height() as f64) as usize;
    let width = rect.width.round().max(1.0) as usize;
    let height = rect.height.round().max(1.0) as usize;
    let mut output = GrayImage::new(width, height, 255);
    let copy_width = width.min(source.width().saturating_sub(left));
    let copy_height = height.min(source.height().saturating_sub(top));
    for y in 0..copy_height {
        output.row_mut(y)[..copy_width]
            .copy_from_slice(&source.row(top + y)[left..left + copy_width]);
    }
    output
}

fn crop_rgb(source: &RgbImage, rect: Rect) -> RgbImage {
    let left = rect.x.round().clamp(0.0, source.width() as f64) as usize;
    let top = rect.y.round().clamp(0.0, source.height() as f64) as usize;
    let width = rect.width.round().max(1.0) as usize;
    let height = rect.height.round().max(1.0) as usize;
    let mut output = RgbImage::new(width, height, [255; 3]);
    for y in 0..height.min(source.height().saturating_sub(top)) {
        for x in 0..width.min(source.width().saturating_sub(left)) {
            output.set(x, y, source.get(left + x, top + y));
        }
    }
    output
}

fn crop_binary(source: &BinaryImage, rect: Rect) -> BinaryImage {
    let left = rect.x.round().clamp(0.0, source.width() as f64) as usize;
    let top = rect.y.round().clamp(0.0, source.height() as f64) as usize;
    let width = rect.width.round().max(1.0) as usize;
    let height = rect.height.round().max(1.0) as usize;
    let mut output = BinaryImage::new(width, height);
    for y in 0..height.min(source.height().saturating_sub(top)) {
        for x in 0..width.min(source.width().saturating_sub(left)) {
            output.set(x, y, source.get(left + x, top + y));
        }
    }
    output
}

/// Builds the sole Auto-routing input before working-resolution rendering.
/// Picture ownership is removed on the fixed analysis grid. The classifier
/// owns its bounded measurement sample so pixel-valued route diagnostics stay
/// in the same sample-space unit as their thresholds.
fn crop_canonical_routing_input(
    source: &GrayImage,
    rect: Rect,
    picture_mask: Option<&BinaryImage>,
    routing_dpi: f64,
) -> GrayImage {
    let mut sample_source = crop_gray(source, rect);
    if let Some(picture_mask) = picture_mask {
        let routing_mask =
            resample_binary_mask_nearest(picture_mask, source.width(), source.height());
        let picture_crop = crop_binary(&routing_mask, rect);
        let radius = picture_protection_radius(routing_dpi);
        let protected = dilate(&picture_crop, radius, radius);
        for y in 0..sample_source.height() {
            for x in 0..sample_source.width() {
                if protected.get(x, y) {
                    sample_source.set(x, y, 255);
                }
            }
        }
    }
    sample_source
}

/// Map detector bounds back through the analysis raster without treating its
/// pixel centers as exact source geometry. A detected sample owns a half-sample
/// footprint beyond its center; retaining that footprint prevents an
/// odd-coordinate source stroke from being clipped when 300-DPI input is
/// measured on the 150-DPI analysis level. Rectilinear paths gate each
/// expanded edge on source ink. Dewarp has no rectilinear pre-dewarp support
/// plane, so only that explicitly tagged reduced-analysis path expands without
/// a support probe. Either path expands by at most half an analysis sample per
/// edge.
#[derive(Clone, Copy)]
enum SourceContentSupport<'a> {
    Rectilinear {
        image: &'a GrayImage,
        to_source: Affine,
    },
    DewarpWithoutRectilinearPlane,
}

fn map_analysis_rect_to_source_support(
    rect: Rect,
    scale_x: f64,
    scale_y: f64,
    source_width: f64,
    source_height: f64,
    source_support: SourceContentSupport<'_>,
) -> Rect {
    let naive_left = (rect.x / scale_x).max(0.0);
    let naive_top = (rect.y / scale_y).max(0.0);
    let naive_right = (rect.right() / scale_x).min(source_width);
    let naive_bottom = (rect.bottom() / scale_y).min(source_height);
    let candidate_left = ((rect.x - 0.5) / scale_x).max(0.0);
    let candidate_top = ((rect.y - 0.5) / scale_y).max(0.0);
    let candidate_right = ((rect.right() + 0.5) / scale_x).min(source_width);
    let candidate_bottom = ((rect.bottom() + 0.5) / scale_y).min(source_height);
    let has_support = |bounds: Rect| {
        let SourceContentSupport::Rectilinear { image, to_source } = source_support else {
            return true;
        };
        source_rect_has_ink_support(
            image,
            transform_rect_bounds(bounds, to_source),
            paper_reference(image).saturating_sub(16),
        )
    };
    let unconditional_dewarp_x = matches!(
        source_support,
        SourceContentSupport::DewarpWithoutRectilinearPlane
    ) && scale_x < 1.0;
    let unconditional_dewarp_y = matches!(
        source_support,
        SourceContentSupport::DewarpWithoutRectilinearPlane
    ) && scale_y < 1.0;
    let rectilinear = matches!(source_support, SourceContentSupport::Rectilinear { .. });
    let left = if (rectilinear || unconditional_dewarp_x)
        && has_support(Rect::new(
            candidate_left,
            candidate_top,
            naive_left - candidate_left,
            candidate_bottom - candidate_top,
        )) {
        candidate_left
    } else {
        naive_left
    };
    let right = if (rectilinear || unconditional_dewarp_x)
        && has_support(Rect::new(
            naive_right,
            candidate_top,
            candidate_right - naive_right,
            candidate_bottom - candidate_top,
        )) {
        candidate_right
    } else {
        naive_right
    };
    let top = if (rectilinear || unconditional_dewarp_y)
        && has_support(Rect::new(
            candidate_left,
            candidate_top,
            candidate_right - candidate_left,
            naive_top - candidate_top,
        )) {
        candidate_top
    } else {
        naive_top
    };
    let bottom = if (rectilinear || unconditional_dewarp_y)
        && has_support(Rect::new(
            candidate_left,
            naive_bottom,
            candidate_right - candidate_left,
            candidate_bottom - naive_bottom,
        )) {
        candidate_bottom
    } else {
        naive_bottom
    };
    Rect::new(left, top, right - left, bottom - top)
}

fn source_rect_has_ink_support(source: &GrayImage, bounds: Rect, threshold: u8) -> bool {
    if bounds.width <= 0.0 || bounds.height <= 0.0 {
        return false;
    }
    let left = bounds.x.floor().max(0.0) as usize;
    let top = bounds.y.floor().max(0.0) as usize;
    let right = bounds.right().ceil().min(source.width() as f64) as usize;
    let bottom = bounds.bottom().ceil().min(source.height() as f64) as usize;
    (top..bottom).any(|y| (left..right).any(|x| source.get(x, y) <= threshold))
}

fn transform_rect_bounds(rect: Rect, transform: Affine) -> Rect {
    let points = [
        Point::new(rect.x, rect.y),
        Point::new(rect.right(), rect.y),
        Point::new(rect.x, rect.bottom()),
        Point::new(rect.right(), rect.bottom()),
    ]
    .map(|point| transform.apply(point));
    let left = points
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min);
    let top = points
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min);
    let right = points
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = points
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max);
    Rect::new(left, top, right - left, bottom - top)
}

fn transform_dewarp_options(
    options: &crate::DewarpOptions,
    transform: Affine,
) -> crate::DewarpOptions {
    crate::DewarpOptions {
        top_curve: options
            .top_curve
            .iter()
            .map(|&point| transform.apply(point))
            .collect(),
        bottom_curve: options
            .bottom_curve
            .iter()
            .map(|&point| transform.apply(point))
            .collect(),
        depth: options.depth,
    }
}

fn map_rect_bounds<F>(rect: Rect, map: F) -> Option<Rect>
where
    F: Fn(Point) -> Option<Point>,
{
    const EDGE_SAMPLES: usize = 17;
    let mut points = Vec::with_capacity(EDGE_SAMPLES * 4);
    for step in 0..EDGE_SAMPLES {
        let amount = step as f64 / (EDGE_SAMPLES - 1) as f64;
        let x = rect.x + rect.width * amount;
        let y = rect.y + rect.height * amount;
        points.push(map(Point::new(x, rect.y))?);
        points.push(map(Point::new(x, rect.bottom()))?);
        points.push(map(Point::new(rect.x, y))?);
        points.push(map(Point::new(rect.right(), y))?);
    }
    let left = points
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min);
    let top = points
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min);
    let right = points
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = points
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max);
    Some(Rect::new(left, top, right - left, bottom - top))
}

fn deskew_transform(width: usize, height: usize, deskew: DeskewResult) -> Affine {
    if !deskew.accepted {
        return Affine::IDENTITY;
    }
    let cx = width as f64 * 0.5;
    let cy = height as f64 * 0.5;
    Affine::translation(-cx, -cy)
        .then(Affine::rotation_radians(-deskew.angle_degrees.to_radians()))
        .then(Affine::translation(cx, cy))
}

fn render_affine_gray(
    source: &GrayImage,
    width: usize,
    height: usize,
    inverse: Affine,
) -> GrayImage {
    let mut output = GrayImage::new(width, height, 255);
    if let Some((translate_x, translate_y)) = integer_translation(inverse) {
        output
            .data_mut()
            .par_chunks_mut(width)
            .enumerate()
            .for_each(|(y, row)| {
                let source_y = y as isize + translate_y;
                if source_y < 0 || source_y >= source.height() as isize {
                    return;
                }
                for (x, target) in row.iter_mut().enumerate() {
                    let source_x = x as isize + translate_x;
                    if source_x >= 0 && source_x < source.width() as isize {
                        *target = source.get(source_x as usize, source_y as usize);
                    }
                }
            });
        return output;
    }
    let sample_offsets = adaptive_sample_offsets(inverse);
    let taps = sample_offsets.len();
    let matrix = inverse.matrix;
    let (step_x, step_y) = (matrix[0][0], matrix[1][0]);
    let source_data = source.data();
    let source_stride = source.stride();
    output
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            let mut mapped = [(0.0, 0.0); MAX_SAMPLE_OFFSETS];
            for (slot, &(offset_x, offset_y)) in mapped.iter_mut().zip(sample_offsets) {
                let source_y = y as f64 + offset_y;
                *slot = (
                    matrix[0][0] * offset_x + matrix[0][1] * source_y + matrix[0][2],
                    matrix[1][0] * offset_x + matrix[1][1] * source_y + matrix[1][2],
                );
            }
            let (interior_start, interior_end) = interior_column_span(
                &mapped[..taps],
                step_x,
                step_y,
                width,
                source.width(),
                source.height(),
            );
            for (x, target) in row.iter_mut().enumerate() {
                let interior = x >= interior_start && x < interior_end;
                let mut sum = 0u32;
                for (sample_x, sample_y) in mapped.iter_mut().take(taps) {
                    sum += if interior {
                        let position_x = *sample_x - 0.5;
                        let position_y = *sample_y - 0.5;
                        let column = position_x as usize;
                        let line = position_y as usize;
                        let fraction_x = (position_x - column as f64) as f32;
                        let fraction_y = (position_y - line as f64) as f32;
                        let base = line * source_stride + column;
                        let top = &source_data[base..base + 2];
                        let bottom = &source_data[base + source_stride..base + source_stride + 2];
                        let top_value = f32::from(top[0])
                            + (f32::from(top[1]) - f32::from(top[0])) * fraction_x;
                        let bottom_value = f32::from(bottom[0])
                            + (f32::from(bottom[1]) - f32::from(bottom[0])) * fraction_x;
                        (top_value + (bottom_value - top_value) * fraction_y + 0.5) as u32
                    } else {
                        u32::from(sample_bilinear_white(source, *sample_x, *sample_y))
                    };
                    *sample_x += step_x;
                    *sample_y += step_y;
                }
                *target = (sum / taps as u32) as u8;
            }
        });
    output
}

fn render_affine_rgb(source: &RgbImage, width: usize, height: usize, inverse: Affine) -> RgbImage {
    let mut output = RgbImage::new(width, height, [255; 3]);
    if let Some((translate_x, translate_y)) = integer_translation(inverse) {
        output
            .data_mut()
            .par_chunks_mut(width * 3)
            .enumerate()
            .for_each(|(y, row)| {
                let source_y = y as isize + translate_y;
                if source_y < 0 || source_y >= source.height() as isize {
                    return;
                }
                for (x, target) in row.chunks_exact_mut(3).enumerate() {
                    let source_x = x as isize + translate_x;
                    if source_x >= 0 && source_x < source.width() as isize {
                        target.copy_from_slice(&source.get(source_x as usize, source_y as usize));
                    }
                }
            });
        return output;
    }
    let sample_offsets = adaptive_sample_offsets(inverse);
    let taps = sample_offsets.len();
    let matrix = inverse.matrix;
    let (step_x, step_y) = (matrix[0][0], matrix[1][0]);
    let source_data = source.data();
    let source_stride = source.width() * 3;
    output
        .data_mut()
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let mut mapped = [(0.0, 0.0); MAX_SAMPLE_OFFSETS];
            for (slot, &(offset_x, offset_y)) in mapped.iter_mut().zip(sample_offsets) {
                let source_y = y as f64 + offset_y;
                *slot = (
                    matrix[0][0] * offset_x + matrix[0][1] * source_y + matrix[0][2],
                    matrix[1][0] * offset_x + matrix[1][1] * source_y + matrix[1][2],
                );
            }
            let (interior_start, interior_end) = interior_column_span(
                &mapped[..taps],
                step_x,
                step_y,
                width,
                source.width(),
                source.height(),
            );
            for (x, target) in row.chunks_exact_mut(3).enumerate() {
                let interior = x >= interior_start && x < interior_end;
                let mut sum = [0u32; 3];
                for (sample_x, sample_y) in mapped.iter_mut().take(taps) {
                    if interior {
                        let position_x = *sample_x - 0.5;
                        let position_y = *sample_y - 0.5;
                        let column = position_x as usize;
                        let line = position_y as usize;
                        let fraction_x = (position_x - column as f64) as f32;
                        let fraction_y = (position_y - line as f64) as f32;
                        let base = line * source_stride + column * 3;
                        let top = &source_data[base..base + 6];
                        let bottom = &source_data[base + source_stride..base + source_stride + 6];
                        for (channel, total) in sum.iter_mut().enumerate() {
                            let top_value = f32::from(top[channel])
                                + (f32::from(top[channel + 3]) - f32::from(top[channel]))
                                    * fraction_x;
                            let bottom_value = f32::from(bottom[channel])
                                + (f32::from(bottom[channel + 3]) - f32::from(bottom[channel]))
                                    * fraction_x;
                            *total +=
                                (top_value + (bottom_value - top_value) * fraction_y + 0.5) as u32;
                        }
                    } else {
                        let sample = sample_bilinear_rgb_white(source, *sample_x, *sample_y);
                        for (channel, total) in sum.iter_mut().enumerate() {
                            *total += u32::from(sample[channel]);
                        }
                    }
                    *sample_x += step_x;
                    *sample_y += step_y;
                }
                for (value, total) in target.iter_mut().zip(sum) {
                    *value = (total / taps as u32) as u8;
                }
            }
        });
    output
}

fn integer_translation(transform: Affine) -> Option<(isize, isize)> {
    let matrix = transform.matrix;
    let linear_is_identity = (matrix[0][0] - 1.0).abs() <= 1e-12
        && matrix[0][1].abs() <= 1e-12
        && matrix[1][0].abs() <= 1e-12
        && (matrix[1][1] - 1.0).abs() <= 1e-12;
    let tx = matrix[0][2].round();
    let ty = matrix[1][2].round();
    (linear_is_identity && (matrix[0][2] - tx).abs() <= 1e-12 && (matrix[1][2] - ty).abs() <= 1e-12)
        .then_some((tx as isize, ty as isize))
}

const MAX_SAMPLE_OFFSETS: usize = 4;

fn interior_column_span(
    starts: &[(f64, f64)],
    step_x: f64,
    step_y: f64,
    width: usize,
    source_width: usize,
    source_height: usize,
) -> (usize, usize) {
    let axis_span = |start: f64, step: f64, high: f64| -> Option<(f64, f64)> {
        if high < 0.5 {
            return None;
        }
        if step == 0.0 {
            return (start >= 0.5 && start <= high).then_some((f64::NEG_INFINITY, f64::INFINITY));
        }
        let first = (0.5 - start) / step;
        let second = (high - start) / step;
        Some(if step > 0.0 {
            (first, second)
        } else {
            (second, first)
        })
    };
    let mut low = 0.0_f64;
    let mut high = width as f64;
    for &(start_x, start_y) in starts {
        match (
            axis_span(start_x, step_x, source_width as f64 - 1.5),
            axis_span(start_y, step_y, source_height as f64 - 1.5),
        ) {
            (Some(x_span), Some(y_span)) => {
                low = low.max(x_span.0).max(y_span.0);
                high = high.min(x_span.1).min(y_span.1);
            }
            _ => return (0, 0),
        }
    }
    // One column of slack on each side absorbs the rounding of the span itself.
    let first = (low.ceil().max(0.0) as usize).saturating_add(1);
    let last = (high.floor().max(0.0) as usize)
        .min(width)
        .saturating_sub(1);
    if first < last {
        (first, last)
    } else {
        (0, 0)
    }
}

fn adaptive_sample_offsets(inverse: Affine) -> &'static [(f64, f64)] {
    const CENTER: &[(f64, f64)] = &[(0.5, 0.5)];
    const TWO_BY_TWO: &[(f64, f64)] = &[(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)];
    let x_footprint = inverse.matrix[0][0].hypot(inverse.matrix[1][0]);
    let y_footprint = inverse.matrix[0][1].hypot(inverse.matrix[1][1]);
    let mixes_axes = inverse.matrix[0][1].abs() > 1e-12 || inverse.matrix[1][0].abs() > 1e-12;
    if mixes_axes || x_footprint.max(y_footprint) > 1.25 {
        TWO_BY_TWO
    } else {
        CENTER
    }
}

fn sample_bilinear_rgb_white(source: &RgbImage, x: f64, y: f64) -> [u8; 3] {
    let x = x - 0.5;
    let y = y - 0.5;
    let x0 = x.floor() as isize;
    let y0 = y.floor() as isize;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let sample = |sx: isize, sy: isize| -> [u8; 3] {
        if sx < 0 || sy < 0 || sx as usize >= source.width() || sy as usize >= source.height() {
            [255; 3]
        } else {
            source.get(sx as usize, sy as usize)
        }
    };
    let samples = [
        sample(x0, y0),
        sample(x0 + 1, y0),
        sample(x0, y0 + 1),
        sample(x0 + 1, y0 + 1),
    ];
    let mut output = [0u8; 3];
    for (channel, target) in output.iter_mut().enumerate() {
        let top = f64::from(samples[0][channel]) * (1.0 - fx) + f64::from(samples[1][channel]) * fx;
        let bottom =
            f64::from(samples[2][channel]) * (1.0 - fx) + f64::from(samples[3][channel]) * fx;
        *target = (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8;
    }
    output
}

fn sample_bilinear_white(source: &GrayImage, x: f64, y: f64) -> u8 {
    let x = x - 0.5;
    let y = y - 0.5;
    let x0 = x.floor() as isize;
    let y0 = y.floor() as isize;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let sample = |sx: isize, sy: isize| -> f64 {
        if sx < 0 || sy < 0 || sx as usize >= source.width() || sy as usize >= source.height() {
            255.0
        } else {
            f64::from(source.get(sx as usize, sy as usize))
        }
    };
    let top = sample(x0, y0) * (1.0 - fx) + sample(x0 + 1, y0) * fx;
    let bottom = sample(x0, y0 + 1) * (1.0 - fx) + sample(x0 + 1, y0 + 1) * fx;
    (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8
}

fn sampled_dewarp_grid(plan: &ComposedRenderPlan, region: Rect) -> DewarpMappingGrid {
    const GRID: usize = DEWARP_GRID_SIZE;
    let mut output_to_source = Vec::with_capacity(GRID * GRID);
    let mut source_to_output = Vec::with_capacity(GRID * GRID);
    for row in 0..GRID {
        for column in 0..GRID {
            let u = column as f64 / (GRID - 1) as f64;
            let v = row as f64 / (GRID - 1) as f64;
            let output = Point::new(
                u * plan.output_width() as f64,
                v * plan.output_height() as f64,
            );
            output_to_source.push(plan.output_to_source(output).unwrap_or(output));
            let source = Point::new(region.x + u * region.width, region.y + v * region.height);
            source_to_output.push(plan.source_to_output(source).unwrap_or(source));
        }
    }
    DewarpMappingGrid {
        columns: GRID,
        rows: GRID,
        output_origin: Point::new(plan.output_rect().x, plan.output_rect().y),
        output_width: plan.output_width(),
        output_height: plan.output_height(),
        output_to_source,
        source_to_output,
    }
}

#[cfg(test)]
#[path = "render_tests/mod.rs"]
mod render_tests;

#[cfg(test)]
pub(crate) use render_tests::analyze_page_with_document_prior_cached;
