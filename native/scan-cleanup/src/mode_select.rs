use crate::protocol::manifest_v3::ContentBlockEvidence;
use crate::{calibration::PageCalibration, io::png::RgbImage, OutputMode};
use scan_primitives::{threshold::otsu_threshold, BinaryImage, ComponentMap, GrayImage};
use serde::{Deserialize, Serialize};

const CHROMA_NOISE_FLOOR: f64 = 18.0;
const DARK_CHROMA_NOISE_FLOOR: f64 = 36.0;
const DARK_LUMINANCE_CUTOFF: u8 = 48;
const CHROMA_SATURATION_FLOOR: f64 = 0.08;
const COLOR_PIXEL_FRACTION_FLOOR: f64 = 0.003;
const COLOR_PIXEL_FRACTION_HYSTERESIS: f64 = 0.0005;
const COLOR_DOMINANT_FRACTION_FLOOR: f64 = 0.18;
const COLOR_DOMINANT_MAX_TEXT_LINES: usize = 6;
// Tinted paper with sparse dark writing can use Mixed so the paper is whitened
// while independent color survives. A dark chromatic field covering most of
// the page is instead a cover or continuous-color surface; treating a small
// sticker/barcode as "text on paper" would send the empty-picture-mask Mixed
// path to destructive bilevel output.
const COLOR_TEXT_MAX_INK_FRACTION: f64 = 0.70;
const SIGNIFICANT_CHROMA_COMPONENT_PIXELS: usize = 500;
const CHROMA_COMPONENT_HYSTERESIS_PIXELS: usize = 80;
#[cfg(test)]
const MIN_PICTURE_COMPONENT_PIXELS: usize = 1_024;
const PICTURE_NOISE_FLOOR: f64 = 0.012;
// `picture_mask` is produced after picture candidates have been corroborated
// by distributed continuous-tone evidence (and may also contain an explicit
// user-owned picture zone). Keep that evidence from falling through the
// generic 1.2% noise gate: the detector's own minimum retained tone component
// is 0.5% of a page, so this lower floor is still evidence-backed rather than
// a promotion for isolated dark pixels.
const CORROBORATED_PICTURE_NOISE_FLOOR: f64 = 0.005;
const PICTURE_HYSTERESIS: f64 = 0.003;
const PICTURE_BALANCE_FRACTION: f64 = 0.14;
const BLANK_EDGE_DIFFERENCE: u8 = 12;
const BLANK_MAX_EDGE_FRACTION: f64 = 0.0015;
const BLANK_MAX_ROBUST_LUMINANCE_RANGE: f64 = 48.0;
/// Width of the leaf edge band that carries scanner rails and fold shadow
/// rather than page content. Page margins at any scan resolution are wider
/// than this, so no printed matter falls inside the band.
const BLANK_EDGE_BAND_FRACTION: f64 = 0.04;
/// Coarse grid used to find page-scale pale continuous-tone regions without
/// promoting isolated scanner noise.
const PALE_TONE_GRID_SIZE: usize = 64;
/// Minimum mean depth below the paper reference for a pale-tone tile.
const PALE_TONE_MIN_DELTA: f64 = 1.0;
/// Second contour used to detach a real plate from one-level paper drift while
/// preserving the edge-attachment rejection for monotone scanner falloff.
const PALE_TONE_EDGE_DETACH_DELTA: f64 = 2.0;
/// Maximum mean depth below paper that can still represent a pale plate.
const PALE_TONE_MAX_DELTA: f64 = 24.0;
/// Largest fraction of crisp, deeper-than-pale ink admitted in a plate tile.
const PALE_TONE_MAX_INK_FRACTION: f64 = 0.005;
/// Minimum connected share of the grid required for page-scale tone.
const PALE_TONE_MIN_COMPONENT_FRACTION: f64 = 0.05;
const PALE_TONE_MIN_COMPONENT_WIDTH_FRACTION: f64 = 0.25;
const PALE_TONE_MIN_COMPONENT_HEIGHT_FRACTION: f64 = 0.125;
const STRONG_BIMODALITY: f64 = 0.78;
const BIMODALITY_HYSTERESIS: f64 = 0.055;
const MIN_LUMINANCE_MODE_DISTANCE: f64 = 60.0;
const LUMINANCE_DISTANCE_HYSTERESIS: f64 = 6.0;
const MAX_BW_MIDTONE_FRACTION: f64 = 0.16;
const MIDTONE_HYSTERESIS: f64 = 0.03;
const TONAL_MIDTONE_FRACTION: f64 = 0.24;
const MIN_TEXT_LINES: usize = 2;
const DENSE_TEXT_MIN_LINES: usize = 6;
const DENSE_TEXT_BIMODALITY: f64 = 0.67;
const DENSE_TEXT_MODE_DISTANCE: f64 = 78.0;
const DENSE_TEXT_RELATIVE_MIN_MODE_DISTANCE: f64 = 30.0;
const DENSE_TEXT_RELATIVE_MIN_SEPARATION: f64 = 0.60;
const DENSE_TEXT_RELATIVE_MAX_LUMINANCE_RANGE: f64 = 110.0;
const DENSE_TEXT_MAX_MIDTONE_FRACTION: f64 = 0.10;
const VERY_DENSE_TEXT_MIN_LINES: usize = 20;
const VERY_DENSE_TEXT_MIN_BIMODALITY: f64 = 0.80;
const VERY_DENSE_TEXT_MIN_MODE_DISTANCE: f64 = 60.0;
// Dense book spreads can devote a sizeable fraction of the raster to antialiased
// glyph edges, gutter shade, and show-through. This broader ceiling is safe only
// behind the very-high line-count, bimodality, separation, and no-picture gates
// below; the spatial-tone veto still gets the final word before B&W is applied.
const VERY_DENSE_TEXT_MAX_MIDTONE_FRACTION: f64 = 0.16;
const STRONG_SINGLE_LINE_BIMODALITY: f64 = 0.85;
const STRONG_SINGLE_LINE_MODE_DISTANCE: f64 = 144.0;
const STRONG_SINGLE_LINE_MAX_MIDTONE_FRACTION: f64 = 0.08;
const MIN_TEXT_INK_FRACTION: f64 = 0.01;
const MIN_SPARSE_TEXT_INK_FRACTION: f64 = 0.00005;
const MAX_SPARSE_TEXT_INK_FRACTION: f64 = 0.002;
const MIN_SPARSE_TEXT_MODE_DISTANCE: f64 = 36.0;
const FLAT_FEW_LINE_TEXT_MAX_LINES: usize = 5;
const FLAT_FEW_LINE_TEXT_MAX_INK_FRACTION: f64 = 0.012;
const FLAT_FEW_LINE_TEXT_MIN_MODE_DISTANCE: f64 = 28.0;
const MIN_TEXT_EDGE_TO_INK_RATIO: f64 = 0.5;
const MIN_MIXED_OWNERSHIP_OVERLAP_PIXELS: usize = 256;
const MIN_MIXED_OWNERSHIP_OVERLAP_FRACTION: f64 = 0.50;
const MAX_INDEPENDENT_OUTSIDE_TONE_FRACTION: f64 = 0.12;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum OutputModeRecommendationReason {
    Blank,
    ColorChroma,
    TextWithPictures,
    ContinuousTone,
    BimodalText,
    UncertainTonal,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OutputModeRecommendation {
    pub mode: OutputMode,
    pub confidence: f64,
    pub reason: OutputModeRecommendationReason,
    pub diagnostics: OutputModeDiagnostics,
    /// Physical representation chosen with Auto's semantic mode. The caller
    /// persists this so another rasterization cannot silently change it.
    pub prefer_soft_alpha_foreground: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum OutputModeRule {
    Blank,
    ColorTextWithPictures,
    Color,
    TextWithPictures,
    Picture,
    SparseText,
    ContinuousTone,
    ConfidentText,
    DenseText,
    StrongSingleLineText,
    SpatialTone,
    BilevelFidelity,
    MixedOwnershipVeto,
    UncertainFallback,
}

/// The raw measurements and signed gate margins behind an automatic output-mode
/// decision. Positive margins satisfy a lower-bound gate. Negative margins
/// satisfy an upper-bound gate. Keeping the values in page metadata makes an
/// Auto decision reproducible instead of exposing only its final label.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OutputModeDiagnostics {
    pub rule: OutputModeRule,
    pub fallback_used: bool,
    pub analysis_width: usize,
    pub analysis_height: usize,
    pub otsu_threshold: u8,
    pub dark_mean: f64,
    pub light_mean: f64,
    pub midtone_lower: f64,
    pub midtone_upper: f64,
    pub p01: f64,
    pub p50: f64,
    pub p99: f64,
    pub bimodality: f64,
    pub midtone_fraction: f64,
    pub relative_midtone_fraction: f64,
    pub mode_distance: f64,
    pub ink_fraction: f64,
    pub edge_fraction: f64,
    pub robust_luminance_range: f64,
    pub colored_fraction: f64,
    pub largest_color_component_pixels: usize,
    pub mean_saturation: f64,
    pub picture_fraction: f64,
    pub text_line_count: usize,
    pub significant_color: bool,
    pub significant_picture: bool,
    pub picture_gate_margin: f64,
    pub tonal_midtone_gate_margin: f64,
    pub strong_bimodality_gate_margin: f64,
    pub confident_text_bimodality_margin: f64,
    pub confident_text_mode_distance_margin: f64,
    pub confident_text_midtone_margin: f64,
    pub dense_text_line_margin: f64,
    pub dense_text_bimodality_margin: f64,
    pub dense_text_mode_distance_margin: f64,
    pub dense_text_midtone_margin: f64,
    pub outside_tonal_fraction: f64,
    pub outside_tonal_largest_component_fraction: f64,
    pub outside_tonal_largest_component_width_fraction: f64,
    pub outside_tonal_largest_component_height_fraction: f64,
    pub coherent_outside_tonal_region: bool,
    pub destructive_mode_tonal_veto: bool,
    pub protected_text_block_count: usize,
    pub protected_text_block_picture_overlap_pixels: usize,
    pub protected_text_block_picture_overlap_fraction: f64,
    pub mixed_ownership_independent_picture_evidence: bool,
    pub mixed_ownership_veto: bool,
    pub source_dpi: f64,
    pub analysis_dpi: f64,
    pub calibrated_source_stroke_width_px: f64,
    pub calibrated_source_x_height_px: f64,
    pub soft_edge_to_ink_ratio: f64,
    pub bilevel_fidelity_veto: bool,
}

#[derive(Clone, Copy, Debug)]
struct ChromaEvidence {
    colored_fraction: f64,
    largest_component_pixels: usize,
    mean_saturation: f64,
    paper_tint: f64,
}

#[derive(Clone, Copy, Debug)]
struct LuminanceEvidence {
    otsu_threshold: u8,
    dark_mean: f64,
    light_mean: f64,
    midtone_lower: f64,
    midtone_upper: f64,
    p01: f64,
    p50: f64,
    p99: f64,
    bimodality: f64,
    midtone_fraction: f64,
    relative_midtone_fraction: f64,
    mode_distance: f64,
    ink_fraction: f64,
    edge_fraction: f64,
    robust_luminance_range: f64,
}

#[derive(Clone, Copy)]
pub(crate) struct PreparedModeEvidence<'a> {
    pub analysis: &'a GrayImage,
    pub analysis_rgb: Option<&'a RgbImage>,
    pub picture_mask: &'a BinaryImage,
    /// True only when the owner was corroborated by distributed tone,
    /// trusted producer tone, or an explicit picture-zone override. This
    /// keeps the 0.5% floor evidence-backed instead of allowing a stain or
    /// tape patch to become a picture on one knife-edge sample.
    pub picture_tone_evidence: bool,
    pub text_line_count: usize,
}

fn picture_noise_floor(evidence: PreparedModeEvidence<'_>) -> f64 {
    if evidence.picture_tone_evidence {
        CORROBORATED_PICTURE_NOISE_FLOOR
    } else {
        PICTURE_NOISE_FLOOR
    }
}

fn recommendation(
    mode: OutputMode,
    confidence: f64,
    reason: OutputModeRecommendationReason,
    rule: OutputModeRule,
    evidence: PreparedModeEvidence<'_>,
    luminance: LuminanceEvidence,
    chroma: ChromaEvidence,
    picture_fraction: f64,
) -> OutputModeRecommendation {
    let significant_color = has_significant_chroma(chroma);
    let significant_picture = picture_fraction >= picture_noise_floor(evidence);
    let dense_text_bimodality_floor = DENSE_TEXT_BIMODALITY + BIMODALITY_HYSTERESIS;
    let dense_text_mode_distance_floor = DENSE_TEXT_MODE_DISTANCE + LUMINANCE_DISTANCE_HYSTERESIS;
    let dense_text_midtone_ceiling = DENSE_TEXT_MAX_MIDTONE_FRACTION - MIDTONE_HYSTERESIS;
    OutputModeRecommendation {
        mode,
        confidence,
        reason,
        prefer_soft_alpha_foreground: false,
        diagnostics: OutputModeDiagnostics {
            rule,
            fallback_used: rule == OutputModeRule::UncertainFallback,
            analysis_width: evidence.analysis.width(),
            analysis_height: evidence.analysis.height(),
            otsu_threshold: luminance.otsu_threshold,
            dark_mean: luminance.dark_mean,
            light_mean: luminance.light_mean,
            midtone_lower: luminance.midtone_lower,
            midtone_upper: luminance.midtone_upper,
            p01: luminance.p01,
            p50: luminance.p50,
            p99: luminance.p99,
            bimodality: luminance.bimodality,
            midtone_fraction: luminance.midtone_fraction,
            relative_midtone_fraction: luminance.relative_midtone_fraction,
            mode_distance: luminance.mode_distance,
            ink_fraction: luminance.ink_fraction,
            edge_fraction: luminance.edge_fraction,
            robust_luminance_range: luminance.robust_luminance_range,
            colored_fraction: chroma.colored_fraction,
            largest_color_component_pixels: chroma.largest_component_pixels,
            mean_saturation: chroma.mean_saturation,
            picture_fraction,
            text_line_count: evidence.text_line_count,
            significant_color,
            significant_picture,
            picture_gate_margin: picture_fraction - picture_noise_floor(evidence),
            tonal_midtone_gate_margin: luminance.midtone_fraction - TONAL_MIDTONE_FRACTION,
            strong_bimodality_gate_margin: luminance.bimodality - STRONG_BIMODALITY,
            confident_text_bimodality_margin: luminance.bimodality
                - (STRONG_BIMODALITY + BIMODALITY_HYSTERESIS),
            confident_text_mode_distance_margin: luminance.mode_distance
                - (MIN_LUMINANCE_MODE_DISTANCE + LUMINANCE_DISTANCE_HYSTERESIS),
            confident_text_midtone_margin: (MAX_BW_MIDTONE_FRACTION - MIDTONE_HYSTERESIS)
                - luminance.midtone_fraction,
            dense_text_line_margin: evidence.text_line_count as f64 - DENSE_TEXT_MIN_LINES as f64,
            dense_text_bimodality_margin: luminance.bimodality - dense_text_bimodality_floor,
            dense_text_mode_distance_margin: luminance.mode_distance
                - dense_text_mode_distance_floor,
            dense_text_midtone_margin: dense_text_midtone_ceiling - luminance.midtone_fraction,
            outside_tonal_fraction: 0.0,
            outside_tonal_largest_component_fraction: 0.0,
            outside_tonal_largest_component_width_fraction: 0.0,
            outside_tonal_largest_component_height_fraction: 0.0,
            coherent_outside_tonal_region: false,
            destructive_mode_tonal_veto: false,
            protected_text_block_count: 0,
            protected_text_block_picture_overlap_pixels: 0,
            protected_text_block_picture_overlap_fraction: 0.0,
            mixed_ownership_independent_picture_evidence: false,
            mixed_ownership_veto: false,
            source_dpi: 0.0,
            analysis_dpi: 0.0,
            calibrated_source_stroke_width_px: 0.0,
            calibrated_source_x_height_px: 0.0,
            soft_edge_to_ink_ratio: 0.0,
            bilevel_fidelity_veto: false,
        },
    }
}

// Binarization quantizes each antialiased edge by roughly half a render
// pixel, so the relative stem error is ~0.5/stroke_width. Measured against
// the calibrated 360 dpi book corpus: real print spans strokes 4.8–9.6 px
// and x-heights 14.4–26.4 px, is stored as bilevel JBIG2 by its own
// producer, and binarizes cleanly (≤10% stem error). The undersampled class
// this veto exists for (an 82 dpi scan) measures stroke ~2.4 px and
// x-height 8 px, where a one-pixel decision closes counters. These floors
// are a sampling-quality boundary between those measured populations, not a
// paper-shade heuristic.
// The x-height floor sits between the two measured populations: an 82 dpi
// soft scan calibrates at 8 px and visibly loses glyph topology, while
// 6 pt map labels on a 360 dpi plate calibrate at 12 px with crisp 4.8 px
// strokes and binarize cleanly (their source stores them as bilevel).
const MIN_BILEVEL_SOURCE_STROKE_WIDTH_PX: f64 = 4.0;
const MIN_BILEVEL_SOURCE_X_HEIGHT_PX: f64 = 10.0;
const MIN_SOFT_EDGE_TO_INK_RATIO: f64 = 0.05;
const UNCALIBRATED_BILEVEL_SOURCE_DPI_FLOOR: f64 = 180.0;

pub(crate) fn should_veto_bilevel_fidelity(
    calibration_valid: bool,
    source_stroke_width_px: f64,
    source_x_height_px: f64,
    source_dpi: f64,
    soft_edge_to_ink_ratio: f64,
    text_line_count: usize,
) -> bool {
    if text_line_count == 0 || soft_edge_to_ink_ratio < MIN_SOFT_EDGE_TO_INK_RATIO {
        return false;
    }
    if calibration_valid {
        source_stroke_width_px < MIN_BILEVEL_SOURCE_STROKE_WIDTH_PX
            || source_x_height_px < MIN_BILEVEL_SOURCE_X_HEIGHT_PX
    } else {
        source_dpi < UNCALIBRATED_BILEVEL_SOURCE_DPI_FLOOR
    }
}

/// Keeps antialiased low-resolution text continuous-tone when thresholding
/// cannot preserve the source glyph topology.
///
/// This gate is independent of the paper's absolute gray or tint. It compares
/// calibrated source-space glyph sampling with the amount of soft edge ink.
/// A genuinely bilevel fax page therefore remains eligible for B&W even at a
/// low nominal DPI, while a 1–2 pixel antialiased stem stays grayscale after
/// its paper field is normalized to white.
pub(crate) fn protect_bilevel_text_fidelity(
    mut recommendation: OutputModeRecommendation,
    calibration: PageCalibration,
    source_dpi: f64,
    text_line_count: usize,
    text_soft_edge_to_ink_ratio: Option<f64>,
) -> OutputModeRecommendation {
    let analysis_dpi = calibration.effective_dpi.max(1.0);
    let source_scale = source_dpi.max(1.0) / analysis_dpi;
    let source_stroke_width_px = calibration.stroke_width_px * source_scale;
    let source_x_height_px = calibration.x_height_px * source_scale;
    let soft_edge_to_ink_ratio = text_soft_edge_to_ink_ratio.unwrap_or_else(|| {
        recommendation.diagnostics.relative_midtone_fraction
            / recommendation.diagnostics.ink_fraction.max(1e-9)
    });
    // The stencil shortcut may only bypass the fidelity veto when the
    // SOURCE geometry can actually carry a stencil. Capable on either
    // signal: adequately sampled glyphs (ordinary book print measures
    // soft-edge ratios up to ~1.3 at analysis scale and still binarizes)
    // OR measured crispness (a title page's small imprint type at ratio
    // ~0.3). An undersampled soft scan fails both (x-height ~8 px at
    // 82 dpi AND ratio ~0.9) and keeps the veto's protection.
    let stencil_capable_source =
        source_x_height_px >= MIN_BILEVEL_SOURCE_X_HEIGHT_PX || soft_edge_to_ink_ratio <= 0.35;
    let crisp_stencil =
        stencil_capable_source && is_bimodal_stencil_page(&recommendation.diagnostics);
    let undersampled_soft_text = !crisp_stencil
        && should_veto_bilevel_fidelity(
            calibration.valid,
            source_stroke_width_px,
            source_x_height_px,
            source_dpi,
            soft_edge_to_ink_ratio,
            text_line_count,
        );
    // A raster cleanup render cannot reuse the source PDF's bilevel object:
    // it thresholds the normalized quality raster again. Therefore the mere
    // existence of a compact source layer is not fidelity evidence for the
    // newly generated foreground. When a genuine photograph shares the page
    // with undersampled soft text, keep the whole result continuous-tone.
    // Large low-midtone/bimodal picture fields are maps and line art; their
    // Mixed representation remains useful and does not take this photo path.
    let line_art_picture = is_line_art_picture(&recommendation.diagnostics);
    let undersampled_photo_dominant_mixed = recommendation.mode == OutputMode::Mixed
        && recommendation.diagnostics.significant_picture
        && !line_art_picture
        && should_veto_bilevel_fidelity(
            calibration.valid,
            source_stroke_width_px,
            source_x_height_px,
            source_dpi,
            soft_edge_to_ink_ratio,
            text_line_count,
        );
    let fidelity_veto = (recommendation.mode == OutputMode::Bw && undersampled_soft_text)
        || undersampled_photo_dominant_mixed;
    recommendation.diagnostics.source_dpi = source_dpi;
    recommendation.diagnostics.analysis_dpi = analysis_dpi;
    recommendation.diagnostics.calibrated_source_stroke_width_px = source_stroke_width_px;
    recommendation.diagnostics.calibrated_source_x_height_px = source_x_height_px;
    recommendation.diagnostics.soft_edge_to_ink_ratio = soft_edge_to_ink_ratio;
    recommendation.diagnostics.bilevel_fidelity_veto = fidelity_veto;
    if fidelity_veto {
        let preserves_color = recommendation.mode == OutputMode::Mixed
            && recommendation.diagnostics.significant_color;
        // A photographic plate plus undersampled soft text is still
        // semantically Mixed: the photograph and the foreground ink have
        // different owners. The fidelity veto selects an 8-bit soft-alpha
        // foreground later in the renderer; changing the semantic mode to
        // Grayscale would flatten the compact layered source into a full-page
        // high-resolution JPEG. Text-only B&W pages still become Grayscale,
        // while independently colored content remains Color because a
        // constant black alpha foreground cannot reproduce it.
        recommendation.mode = if preserves_color {
            OutputMode::Color
        } else if recommendation.mode == OutputMode::Mixed {
            OutputMode::Mixed
        } else {
            OutputMode::Grayscale
        };
        recommendation.confidence = if recommendation.mode == OutputMode::Mixed {
            recommendation.confidence.max(0.82)
        } else {
            0.82
        };
        recommendation.reason = match recommendation.mode {
            OutputMode::Color => OutputModeRecommendationReason::ColorChroma,
            OutputMode::Mixed => OutputModeRecommendationReason::TextWithPictures,
            OutputMode::Grayscale => OutputModeRecommendationReason::UncertainTonal,
            OutputMode::Bw | OutputMode::Auto => {
                unreachable!("fidelity veto resolves a concrete continuous representation")
            }
        };
        recommendation.diagnostics.rule = OutputModeRule::BilevelFidelity;
        recommendation.diagnostics.fallback_used = false;
    }
    recommendation
}

/// Returns whether a detector-owned picture field is a predominantly bimodal
/// drawing/map rather than a photographic plate.  The picture detector can
/// cover only the printed field's darker lobes, so a 60% area threshold would
/// classify perfectly good line-art pages as photographs whenever their paper
/// is bright.  Keep the decision tied to the same low-midtone/high-bimodality
/// evidence used by the fidelity gate and allow the compositor to use a crisp
/// stencil for smaller, sparse drawing fields as well.
pub(crate) fn is_line_art_picture(diagnostics: &OutputModeDiagnostics) -> bool {
    diagnostics.picture_fraction >= 0.20
        && diagnostics.midtone_fraction <= 0.16
        && diagnostics.bimodality >= 0.65
}

fn has_bimodal_stencil_signal(
    significant_picture: bool,
    significant_color: bool,
    text_line_count: usize,
    bimodality: f64,
    mode_distance: f64,
    midtone_fraction: f64,
    ink_fraction: f64,
    edge_fraction: f64,
) -> bool {
    if significant_picture || significant_color {
        return false;
    }
    let strong_text_or_line_art = text_line_count >= 6
        && bimodality >= 0.78
        && mode_distance >= 80.0
        && midtone_fraction <= 0.18
        && edge_fraction >= ink_fraction * 0.75;
    // At print resolution, a dense page with a very clean two-mode histogram
    // is still a stencil candidate even when the calibration estimates a
    // slightly undersized x-height. This is the common raw-book case where
    // the page is text-only but antialiased paper texture pulls the mode gap
    // just below the general 80-level boundary.
    let dense_text_stencil = text_line_count >= 20
        && bimodality >= 0.76
        && mode_distance >= 72.0
        && midtone_fraction <= 0.12
        && edge_fraction >= ink_fraction * 0.45;
    let flat_dense_text_stencil = text_line_count >= 20
        && bimodality >= 0.70
        && mode_distance >= 60.0
        && midtone_fraction <= 0.05
        && edge_fraction >= ink_fraction * 0.75;
    let dense_dark_page = text_line_count >= 20
        && bimodality >= 0.65
        && mode_distance >= 80.0
        && midtone_fraction <= 0.10
        && edge_fraction >= ink_fraction * 0.45;
    let sparse_dark_page = (1..=5).contains(&text_line_count)
        && bimodality >= 0.50
        && mode_distance >= 90.0
        && midtone_fraction <= 0.10
        && edge_fraction >= ink_fraction * 0.75;
    strong_text_or_line_art
        || dense_text_stencil
        || flat_dense_text_stencil
        || dense_dark_page
        || sparse_dark_page
}

/// A detector-independent line-art/text signal used when a gray drawing's
/// texture mask is empty. It deliberately requires text-like edge density and
/// strong luminance separation, so faint pencil and continuous-tone pages stay
/// on the tonal path. A small, shallow tone island is retained for line-art
/// pages because hatching and flat washes can be classifier-owned evidence
/// without being a photographic plate.
pub(crate) fn is_bimodal_stencil_page(diagnostics: &OutputModeDiagnostics) -> bool {
    if !has_bimodal_stencil_signal(
        diagnostics.significant_picture,
        diagnostics.significant_color,
        diagnostics.text_line_count,
        diagnostics.bimodality,
        diagnostics.mode_distance,
        diagnostics.midtone_fraction,
        diagnostics.ink_fraction,
        diagnostics.edge_fraction,
    ) {
        return false;
    }
    let isolated_line_art_tone = diagnostics.coherent_outside_tonal_region
        && diagnostics.outside_tonal_fraction <= 0.12
        && diagnostics.outside_tonal_largest_component_width_fraction <= 0.50
        && diagnostics.outside_tonal_largest_component_height_fraction <= 0.10;
    diagnostics.outside_tonal_fraction <= 0.06 || isolated_line_art_tone
}

/// Measures antialiased edge samples only around detected text.
///
/// A page-wide ratio confuses gray scanner bars, gutter shadows and tonal
/// pictures with soft glyph edges, which can needlessly demote an otherwise
/// safe B&W or mixed result. The vicinity mask keeps the fidelity veto tied to
/// the content it is meant to protect.
pub(crate) fn text_soft_edge_to_ink_ratio(
    analysis: &GrayImage,
    text_vicinity: &BinaryImage,
    picture_mask: Option<&BinaryImage>,
) -> Option<f64> {
    if analysis.width() == 0
        || analysis.height() == 0
        || analysis.width() != text_vicinity.width()
        || analysis.height() != text_vicinity.height()
        || picture_mask.is_some_and(|mask| {
            mask.width() != analysis.width() || mask.height() != analysis.height()
        })
    {
        return None;
    }
    let luminance = luminance_evidence(analysis);
    let relative_lower = luminance.dark_mean + (luminance.light_mean - luminance.dark_mean) * 0.15;
    let relative_upper = luminance.light_mean - (luminance.light_mean - luminance.dark_mean) * 0.15;
    // Soft tone hugging the page frame is scanner shadow, not glyph
    // antialiasing; it must not push a crisp text page into the
    // low-resolution-text veto. Same 1/20 border zone as content trimming.
    let frame_x = analysis.width().div_ceil(20).max(1);
    let frame_y = analysis.height().div_ceil(20).max(1);
    let mut ink = 0usize;
    let mut soft_edges = 0usize;
    for y in frame_y..analysis.height().saturating_sub(frame_y) {
        for x in frame_x..analysis.width().saturating_sub(frame_x) {
            if !text_vicinity.get(x, y) || picture_mask.is_some_and(|mask| mask.get(x, y)) {
                continue;
            }
            let value = analysis.get(x, y);
            ink += usize::from(value < luminance.otsu_threshold);
            soft_edges += usize::from(
                f64::from(value) >= relative_lower && f64::from(value) <= relative_upper,
            );
        }
    }
    (ink > 0).then(|| soft_edges as f64 / ink as f64)
}

pub(crate) fn recommend_output_mode_with_tone(
    evidence: PreparedModeEvidence<'_>,
    outside_tone: crate::text_tone::OutsideTonalEvidence,
) -> OutputModeRecommendation {
    let mut result = recommend_output_mode(evidence);
    result.diagnostics.outside_tonal_fraction = outside_tone.fraction;
    result.diagnostics.outside_tonal_largest_component_fraction =
        outside_tone.largest_component_fraction;
    result
        .diagnostics
        .outside_tonal_largest_component_width_fraction =
        outside_tone.largest_component_width_fraction;
    result
        .diagnostics
        .outside_tonal_largest_component_height_fraction =
        outside_tone.largest_component_height_fraction;
    result.diagnostics.coherent_outside_tonal_region = outside_tone.coherent();
    result.diagnostics.destructive_mode_tonal_veto = outside_tone.vetoes_destructive_mode();

    // Outside-text tone remains diagnostic evidence for line-art refinement,
    // but it is not a second mode owner. The old SpatialTone promotion was
    // unsatisfiable after picture qualification moved before mode selection:
    // every owner at the lower floor had already selected Mixed/Grayscale,
    // while the B&W path carried no owner. Keeping this channel out of mode
    // selection prevents show-through from becoming a UI "Text + pics" label.
    result
}

/// Rejects an automatic Mixed recommendation when its own protected text
/// evidence says that a meaningful text block is mostly picture-owned, but no
/// independent picture owner corroborates that assignment. The comparison is
/// made against the existing analysis-resolution content blocks. It does not
/// render a second candidate, and it never changes an explicit user mode.
pub(crate) fn veto_contradictory_mixed_ownership(
    mut recommendation: OutputModeRecommendation,
    auto_mode: bool,
    protected_blocks: &[ContentBlockEvidence],
    independent_picture_evidence: bool,
) -> OutputModeRecommendation {
    let mut protected_text_block_count = 0usize;
    let mut largest_overlap_pixels = 0usize;
    let mut largest_overlap_fraction = 0.0f64;
    let mut contradiction = false;

    for block in protected_blocks {
        // Content diagnostics already filter these blocks through the
        // calibrated protection policy. Restrict the summary to blocks that
        // carry text-like evidence so a picture-only block cannot veto its
        // own Mixed recommendation.
        if !(block.text_evidence || block.heading_evidence || block.grayscale_evidence) {
            continue;
        }
        let block_area = block.bounds.width_px.saturating_mul(block.bounds.height_px);
        if block_area == 0 {
            continue;
        }
        let overlap_fraction = block.picture_mask_overlap_pixels as f64 / block_area as f64;
        protected_text_block_count += 1;
        largest_overlap_pixels = largest_overlap_pixels.max(block.picture_mask_overlap_pixels);
        largest_overlap_fraction = largest_overlap_fraction.max(overlap_fraction);
        contradiction |= block.picture_mask_overlap_pixels >= MIN_MIXED_OWNERSHIP_OVERLAP_PIXELS
            && overlap_fraction >= MIN_MIXED_OWNERSHIP_OVERLAP_FRACTION;
    }

    recommendation.diagnostics.protected_text_block_count = protected_text_block_count;
    recommendation
        .diagnostics
        .protected_text_block_picture_overlap_pixels = largest_overlap_pixels;
    recommendation
        .diagnostics
        .protected_text_block_picture_overlap_fraction = largest_overlap_fraction.clamp(0.0, 1.0);
    recommendation
        .diagnostics
        .mixed_ownership_independent_picture_evidence = independent_picture_evidence;

    let veto = auto_mode
        && recommendation.mode == OutputMode::Mixed
        && contradiction
        && !independent_picture_evidence;
    recommendation.diagnostics.mixed_ownership_veto = veto;
    if veto {
        let preserves_color = recommendation.diagnostics.significant_color;
        recommendation.mode = if preserves_color {
            OutputMode::Color
        } else {
            OutputMode::Grayscale
        };
        recommendation.confidence = recommendation.confidence.min(0.82);
        recommendation.reason = if preserves_color {
            OutputModeRecommendationReason::ColorChroma
        } else {
            OutputModeRecommendationReason::UncertainTonal
        };
        recommendation.diagnostics.rule = OutputModeRule::MixedOwnershipVeto;
        recommendation.diagnostics.fallback_used = true;
    }
    recommendation
}

/// A broad coherent field can veto destructive B&W, but it is not by itself
/// a picture owner. Keep the same bounded-area qualification used by the
/// stencil path so a photographed page background or cloth does not exempt a
/// contradictory Mixed recommendation.
pub(crate) fn qualifies_independent_outside_tone(
    outside_tone: crate::text_tone::OutsideTonalEvidence,
) -> bool {
    outside_tone.coherent() && outside_tone.fraction <= MAX_INDEPENDENT_OUTSIDE_TONE_FRACTION
}

/// Chooses a concrete output mode from the renderer's prepared analysis artifacts.
///
/// Detect-all receives a direct 150-DPI raster while final rendering can downsample
/// a source-DPI raster to the same analysis ceiling. Those inputs can differ by a
/// few pixels and histogram counts. Every destructive B&W gate therefore includes
/// an explicit hysteresis margin; evidence near a boundary resolves to the more
/// tonal mode in both paths instead of depending on exact `>=` comparisons.
pub(crate) fn recommend_output_mode(
    evidence: PreparedModeEvidence<'_>,
) -> OutputModeRecommendation {
    let luminance = luminance_evidence(evidence.analysis);
    let (chroma, _) = chroma_evidence_and_mask(
        evidence.analysis,
        evidence.analysis_rgb,
        evidence.text_line_count,
    );
    let significant_color = has_significant_chroma(chroma);

    // Blankness is source evidence, not a property of a later normalized or
    // binarized raster. Resolve it before picture/content segmentation: subtle
    // paper texture can look like a page-sized picture after illumination
    // normalization even though the raw scan contains no meaningful marks.
    if is_blank_luminance(luminance)
        && !significant_color
        && !has_coherent_edge_structure(evidence.analysis)
    {
        let range_margin = (1.0
            - luminance.robust_luminance_range / BLANK_MAX_ROBUST_LUMINANCE_RANGE)
            .clamp(0.0, 1.0);
        let edge_margin = (1.0 - luminance.edge_fraction / BLANK_MAX_EDGE_FRACTION).clamp(0.0, 1.0);
        return recommendation(
            OutputMode::Bw,
            (0.8 + 0.08 * range_margin + 0.08 * edge_margin).clamp(0.0, 1.0),
            OutputModeRecommendationReason::Blank,
            OutputModeRule::Blank,
            evidence,
            luminance,
            chroma,
            0.0,
        );
    }

    let pixel_count = evidence
        .analysis
        .width()
        .saturating_mul(evidence.analysis.height())
        .max(1);
    // `picture_mask` is the vetted semantic owner. Qualification happens once
    // in picture.rs before this function; re-filtering here was the source of
    // the old non-monotonic state where diagnostics saw tone but mode selection
    // reduced pictureFraction to zero.
    let picture_pixels = evidence.picture_mask.count_black();
    let picture_fraction = picture_pixels as f64 / pixel_count as f64;
    let picture_floor = picture_noise_floor(evidence);
    let significant_picture = picture_fraction >= picture_floor;
    let has_text = evidence.text_line_count >= MIN_TEXT_LINES;

    // Paper tint is not a picture owner. It can make a camera page look
    // "color text with pictures" even when the vetted picture mask is empty.
    // Mixed has a bilevel foreground, so allowing that branch without an
    // actual tone owner silently turns the whole page into destructive B&W.
    // A real detector-owned picture still qualifies through
    // `significant_picture`; unowned chroma falls through to Color and keeps
    // the camera evidence instead of inventing a Mixed layer.
    let tinted_text_with_picture_owner = evidence.picture_tone_evidence
        && chroma.paper_tint >= 8.0
        && luminance.ink_fraction <= COLOR_TEXT_MAX_INK_FRACTION;
    if significant_color
        && (significant_picture || tinted_text_with_picture_owner)
        && has_text
        && !(chroma.colored_fraction >= COLOR_DOMINANT_FRACTION_FLOOR
            && evidence.text_line_count <= COLOR_DOMINANT_MAX_TEXT_LINES)
    {
        let picture_margin = (picture_fraction / PICTURE_BALANCE_FRACTION).clamp(0.0, 1.0);
        let text_margin = (evidence.text_line_count as f64 / 8.0).clamp(0.0, 1.0);
        return recommendation(
            OutputMode::Mixed,
            (0.72 + 0.16 * picture_margin + 0.12 * text_margin).clamp(0.0, 1.0),
            OutputModeRecommendationReason::TextWithPictures,
            OutputModeRule::ColorTextWithPictures,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }

    if significant_color {
        let fraction_margin = ((chroma.colored_fraction + COLOR_PIXEL_FRACTION_HYSTERESIS)
            / COLOR_PIXEL_FRACTION_FLOOR)
            .clamp(0.0, 1.0);
        let component_margin = (chroma
            .largest_component_pixels
            .saturating_add(CHROMA_COMPONENT_HYSTERESIS_PIXELS)
            as f64
            / SIGNIFICANT_CHROMA_COMPONENT_PIXELS as f64)
            .clamp(0.0, 1.0);
        let saturation_margin =
            (chroma.mean_saturation / (CHROMA_SATURATION_FLOOR * 3.0)).clamp(0.0, 1.0);
        return recommendation(
            OutputMode::Color,
            (0.68 + 0.12 * fraction_margin + 0.12 * component_margin + 0.08 * saturation_margin)
                .clamp(0.0, 1.0),
            OutputModeRecommendationReason::ColorChroma,
            OutputModeRule::Color,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }

    // A sheet the picture detector mostly owns is one photograph, not a
    // text page with an illustration: whatever the line detector found
    // inside it is the photograph's own periodic structure, and a Mixed
    // manifest would publish a worthless stencil over it. Real
    // text-with-picture pages in the calibrated book measure picture
    // fractions of 0.1-0.45, while a full-bleed tonal sheet measures 0.59
    // even when only its darker half seeds zones.
    if significant_picture && has_text && picture_fraction < 0.55 {
        let picture_margin = (picture_fraction / PICTURE_BALANCE_FRACTION).clamp(0.0, 1.0);
        let text_margin = (evidence.text_line_count as f64 / 8.0).clamp(0.0, 1.0);
        return recommendation(
            OutputMode::Mixed,
            (0.68 + 0.18 * picture_margin + 0.14 * text_margin).clamp(0.0, 1.0),
            OutputModeRecommendationReason::TextWithPictures,
            OutputModeRule::TextWithPictures,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }

    if significant_picture {
        let picture_margin = (picture_fraction / PICTURE_BALANCE_FRACTION).clamp(0.0, 1.0);
        let tonal_margin = (luminance.midtone_fraction / TONAL_MIDTONE_FRACTION).clamp(0.0, 1.0);
        let weak_bimodality = ((STRONG_BIMODALITY - luminance.bimodality) / 0.35).clamp(0.0, 1.0);
        return recommendation(
            OutputMode::Grayscale,
            (0.66 + 0.16 * picture_margin + 0.1 * tonal_margin + 0.08 * weak_bimodality)
                .clamp(0.0, 1.0),
            OutputModeRecommendationReason::ContinuousTone,
            OutputModeRule::Picture,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }

    // A few glyphs can occupy far below one percent of a page. On otherwise
    // flat paper, absolute luminance is irrelevant: the dark Otsu class,
    // separation from the dominant paper tone, and coherent edge structure
    // are the useful evidence. Route that case to binary before the broad
    // midtone fallback interprets a gray sheet as continuous-tone content.
    let sparse_ink_fraction = (MIN_SPARSE_TEXT_INK_FRACTION..=MAX_SPARSE_TEXT_INK_FRACTION)
        .contains(&luminance.ink_fraction);
    let few_line_ink_fraction = evidence.text_line_count <= FLAT_FEW_LINE_TEXT_MAX_LINES
        && (MAX_SPARSE_TEXT_INK_FRACTION..=FLAT_FEW_LINE_TEXT_MAX_INK_FRACTION)
            .contains(&luminance.ink_fraction);
    let sparse_text_on_flat_paper = evidence.text_line_count >= 1
        && picture_fraction + PICTURE_HYSTERESIS < picture_floor
        && luminance.robust_luminance_range <= BLANK_MAX_ROBUST_LUMINANCE_RANGE
        && ((sparse_ink_fraction && luminance.mode_distance >= MIN_SPARSE_TEXT_MODE_DISTANCE)
            || (few_line_ink_fraction
                && luminance.mode_distance >= FLAT_FEW_LINE_TEXT_MIN_MODE_DISTANCE))
        && luminance.edge_fraction >= luminance.ink_fraction * MIN_TEXT_EDGE_TO_INK_RATIO
        && has_coherent_edge_structure(evidence.analysis);
    if sparse_text_on_flat_paper {
        let separation_margin =
            ((luminance.mode_distance - MIN_SPARSE_TEXT_MODE_DISTANCE) / 96.0).clamp(0.0, 1.0);
        let edge_margin = (luminance.edge_fraction
            / luminance.ink_fraction.max(MIN_SPARSE_TEXT_INK_FRACTION))
        .clamp(0.0, 1.0);
        return recommendation(
            OutputMode::Bw,
            (0.66 + 0.16 * separation_margin + 0.08 * edge_margin).clamp(0.0, 0.9),
            OutputModeRecommendationReason::BimodalText,
            OutputModeRule::SparseText,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }

    // A classifier can miss a large line drawing when its gray wash is too
    // broad for the texture picture mask. Strongly separated, edge-dense
    // pages with no independent picture or color ownership are still
    // bimodal text/line-art pages, not uncertain full-page photographs. Keep
    // them on the 1-bit path so a fresh raster actually earns the compact
    // representation promised by Auto.
    let bimodal_stencil_page = has_bimodal_stencil_signal(
        significant_picture,
        significant_color,
        evidence.text_line_count,
        luminance.bimodality,
        luminance.mode_distance,
        luminance.midtone_fraction,
        luminance.ink_fraction,
        luminance.edge_fraction,
    );
    if bimodal_stencil_page {
        return recommendation(
            OutputMode::Bw,
            (0.76
                + 0.08 * ((luminance.bimodality - 0.78) / 0.12).clamp(0.0, 1.0)
                + 0.08 * ((luminance.mode_distance - 80.0) / 80.0).clamp(0.0, 1.0)
                + 0.08
                    * (luminance.edge_fraction
                        / luminance.ink_fraction.max(MIN_TEXT_INK_FRACTION))
                    .clamp(0.0, 1.0))
            .clamp(0.0, 0.92),
            OutputModeRecommendationReason::BimodalText,
            OutputModeRule::DenseText,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }

    if luminance.midtone_fraction >= TONAL_MIDTONE_FRACTION
        && luminance.bimodality < STRONG_BIMODALITY
    {
        let tonal_margin = (luminance.midtone_fraction / TONAL_MIDTONE_FRACTION).clamp(0.0, 1.0);
        let weak_bimodality = ((STRONG_BIMODALITY - luminance.bimodality) / 0.35).clamp(0.0, 1.0);
        return recommendation(
            OutputMode::Grayscale,
            (0.64 + 0.22 * tonal_margin + 0.14 * weak_bimodality).clamp(0.0, 1.0),
            OutputModeRecommendationReason::ContinuousTone,
            OutputModeRule::ContinuousTone,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }

    let confident_text = has_text
        && picture_fraction + PICTURE_HYSTERESIS < picture_floor
        && luminance.bimodality >= STRONG_BIMODALITY + BIMODALITY_HYSTERESIS
        && luminance.mode_distance >= MIN_LUMINANCE_MODE_DISTANCE + LUMINANCE_DISTANCE_HYSTERESIS
        && luminance.midtone_fraction <= MAX_BW_MIDTONE_FRACTION - MIDTONE_HYSTERESIS;
    if confident_text {
        let bimodal_margin = ((luminance.bimodality - STRONG_BIMODALITY - BIMODALITY_HYSTERESIS)
            / 0.15)
            .clamp(0.0, 1.0);
        let separation_margin = ((luminance.mode_distance
            - MIN_LUMINANCE_MODE_DISTANCE
            - LUMINANCE_DISTANCE_HYSTERESIS)
            / 100.0)
            .clamp(0.0, 1.0);
        let tonal_margin = ((MAX_BW_MIDTONE_FRACTION - luminance.midtone_fraction)
            / MAX_BW_MIDTONE_FRACTION)
            .clamp(0.0, 1.0);
        let text_margin = (evidence.text_line_count as f64 / 10.0).clamp(0.0, 1.0);
        return recommendation(
            OutputMode::Bw,
            (0.72
                + 0.08 * bimodal_margin
                + 0.08 * separation_margin
                + 0.06 * tonal_margin
                + 0.06 * text_margin)
                .clamp(0.0, 1.0),
            OutputModeRecommendationReason::BimodalText,
            OutputModeRule::ConfidentText,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }

    // Bleed-through and paper texture widen the background mode and depress
    // Otsu bimodality even when a page still has two well-separated luminance
    // classes. Dense line structure can safely offset that weaker histogram
    // score only when the remaining text evidence is emphatically binary.
    let dense_text_bimodality_floor = DENSE_TEXT_BIMODALITY + BIMODALITY_HYSTERESIS;
    let dense_text_mode_distance_floor = DENSE_TEXT_MODE_DISTANCE + LUMINANCE_DISTANCE_HYSTERESIS;
    let dense_text_midtone_ceiling = DENSE_TEXT_MAX_MIDTONE_FRACTION - MIDTONE_HYSTERESIS;
    let dense_text_relative_separation =
        luminance.mode_distance / luminance.robust_luminance_range.max(1.0);
    let dense_text_separated = luminance.mode_distance >= dense_text_mode_distance_floor
        || (luminance.mode_distance >= DENSE_TEXT_RELATIVE_MIN_MODE_DISTANCE
            && luminance.robust_luminance_range <= DENSE_TEXT_RELATIVE_MAX_LUMINANCE_RANGE
            && dense_text_relative_separation >= DENSE_TEXT_RELATIVE_MIN_SEPARATION);
    let very_dense_text = evidence.text_line_count >= VERY_DENSE_TEXT_MIN_LINES
        && luminance.bimodality >= VERY_DENSE_TEXT_MIN_BIMODALITY
        && luminance.mode_distance >= VERY_DENSE_TEXT_MIN_MODE_DISTANCE
        && luminance.midtone_fraction <= VERY_DENSE_TEXT_MAX_MIDTONE_FRACTION;
    let dense_text = picture_fraction + PICTURE_HYSTERESIS < picture_floor
        && ((evidence.text_line_count >= DENSE_TEXT_MIN_LINES
            && luminance.bimodality >= dense_text_bimodality_floor
            && dense_text_separated
            && luminance.midtone_fraction <= dense_text_midtone_ceiling)
            || very_dense_text)
        && luminance.ink_fraction >= MIN_TEXT_INK_FRACTION
        && luminance.edge_fraction >= luminance.ink_fraction * MIN_TEXT_EDGE_TO_INK_RATIO;
    if dense_text {
        let bimodal_margin =
            ((luminance.bimodality - dense_text_bimodality_floor) / 0.08).clamp(0.0, 1.0);
        let separation_margin = if luminance.mode_distance >= dense_text_mode_distance_floor {
            ((luminance.mode_distance - dense_text_mode_distance_floor) / 100.0).clamp(0.0, 1.0)
        } else {
            ((dense_text_relative_separation - DENSE_TEXT_RELATIVE_MIN_SEPARATION) / 0.4)
                .clamp(0.0, 1.0)
        };
        let tonal_margin = ((dense_text_midtone_ceiling - luminance.midtone_fraction)
            / dense_text_midtone_ceiling)
            .clamp(0.0, 1.0);
        let text_margin = (evidence.text_line_count as f64 / 20.0).clamp(0.0, 1.0);
        return recommendation(
            OutputMode::Bw,
            (0.64
                + 0.06 * bimodal_margin
                + 0.06 * separation_margin
                + 0.05 * tonal_margin
                + 0.05 * text_margin)
                .clamp(0.0, 0.8),
            OutputModeRecommendationReason::BimodalText,
            OutputModeRule::DenseText,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }

    // Dense or tightly spaced text can collapse to one provisional line. Keep the
    // normal two-line safety gate and admit that case only with emphatically
    // binary, text-like luminance evidence. Apply the same cross-path hysteresis
    // margins as the normal B&W gate.
    let single_line_bimodality_floor = STRONG_SINGLE_LINE_BIMODALITY + BIMODALITY_HYSTERESIS;
    let single_line_mode_distance_floor =
        STRONG_SINGLE_LINE_MODE_DISTANCE + LUMINANCE_DISTANCE_HYSTERESIS;
    let single_line_midtone_ceiling = STRONG_SINGLE_LINE_MAX_MIDTONE_FRACTION - MIDTONE_HYSTERESIS;
    let strong_single_line_text = evidence.text_line_count == 1
        && picture_fraction + PICTURE_HYSTERESIS < picture_floor
        && luminance.bimodality >= single_line_bimodality_floor
        && luminance.mode_distance >= single_line_mode_distance_floor
        && luminance.midtone_fraction <= single_line_midtone_ceiling
        && luminance.ink_fraction >= MIN_TEXT_INK_FRACTION
        && luminance.edge_fraction >= luminance.ink_fraction * MIN_TEXT_EDGE_TO_INK_RATIO;
    if strong_single_line_text {
        let bimodal_margin =
            ((luminance.bimodality - single_line_bimodality_floor) / 0.1).clamp(0.0, 1.0);
        let separation_margin =
            ((luminance.mode_distance - single_line_mode_distance_floor) / 100.0).clamp(0.0, 1.0);
        let tonal_margin = ((single_line_midtone_ceiling - luminance.midtone_fraction)
            / single_line_midtone_ceiling)
            .clamp(0.0, 1.0);
        return recommendation(
            OutputMode::Bw,
            (0.62 + 0.03 * bimodal_margin + 0.03 * separation_margin + 0.02 * tonal_margin)
                .clamp(0.0, 0.7),
            OutputModeRecommendationReason::BimodalText,
            OutputModeRule::StrongSingleLineText,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }

    // A text-bearing page reaching this point was cleared of picture, color
    // and broad-midtone ownership; only its histogram margins were too weak
    // for the confident gates. When the ink itself is emphatically dark
    // (full mode separation), that weakness comes from texture the cleanup
    // exists to remove — map hatching, verso show-through — and a full-page
    // continuous-tone fallback would republish it at 30-60x the encoded
    // size. Faint media (pencil, low-contrast reproduction) keeps the
    // grayscale fallback: its mode separation is genuinely small and
    // thresholding would destroy the marks.
    if has_text
        && luminance.mode_distance >= MIN_LUMINANCE_MODE_DISTANCE
        && luminance.midtone_fraction <= MAX_BW_MIDTONE_FRACTION
    {
        return recommendation(
            OutputMode::Bw,
            0.58,
            OutputModeRecommendationReason::BimodalText,
            OutputModeRule::DenseText,
            evidence,
            luminance,
            chroma,
            picture_fraction,
        );
    }
    recommendation(
        OutputMode::Grayscale,
        (0.52
            + 0.18 * (luminance.midtone_fraction / TONAL_MIDTONE_FRACTION).clamp(0.0, 1.0)
            + 0.1
                * ((MIN_LUMINANCE_MODE_DISTANCE - luminance.mode_distance)
                    / MIN_LUMINANCE_MODE_DISTANCE)
                    .clamp(0.0, 1.0))
        .clamp(0.0, 1.0),
        OutputModeRecommendationReason::UncertainTonal,
        OutputModeRule::UncertainFallback,
        evidence,
        luminance,
        chroma,
        picture_fraction,
    )
}

/// Returns whether a bounded raw scan contains no meaningful luminance or
/// chroma evidence. Callers must evaluate this before illumination
/// normalization so preview- and source-resolution renders share one decision.
pub(crate) fn is_blank_scan_candidate(
    analysis: &GrayImage,
    analysis_rgb: Option<&RgbImage>,
) -> bool {
    // A leaf carries the scanner rail and the spread's fold shadow in its own
    // edge band. Those are sheet artifacts, not page content, and their
    // luminance spread was enough to deny a blank verso its clean white page:
    // the verso then kept whatever streak the crop locked onto. Tone evidence
    // is therefore read from the interior. Glyph structure and chroma still
    // answer for the whole leaf, so a marginal note or an edge-hugging stamp
    // keeps vetoing the verdict — the page must never be erased because its
    // only content sits near the edge.
    let interior = blank_interior_bounds(analysis);
    is_blank_luminance(luminance_evidence_region(analysis, interior))
        && !has_pale_tonal_structure_in_region(analysis, interior)
        && !has_coherent_edge_structure(analysis)
        && !has_significant_chroma(chroma_evidence(analysis, analysis_rgb, 0))
}

fn blank_interior_bounds(analysis: &GrayImage) -> (usize, usize, usize, usize) {
    let inset_x = (analysis.width() as f64 * BLANK_EDGE_BAND_FRACTION).round() as usize;
    let inset_y = (analysis.height() as f64 * BLANK_EDGE_BAND_FRACTION).round() as usize;
    let width = analysis.width().saturating_sub(inset_x * 2);
    let height = analysis.height().saturating_sub(inset_y * 2);
    if width == 0 || height == 0 {
        return (0, 0, analysis.width(), analysis.height());
    }
    (inset_x, inset_y, inset_x + width, inset_y + height)
}

fn has_significant_chroma(chroma: ChromaEvidence) -> bool {
    chroma.colored_fraction + COLOR_PIXEL_FRACTION_HYSTERESIS >= COLOR_PIXEL_FRACTION_FLOOR
        || chroma
            .largest_component_pixels
            .saturating_add(CHROMA_COMPONENT_HYSTERESIS_PIXELS)
            >= SIGNIFICANT_CHROMA_COMPONENT_PIXELS
}

fn is_blank_luminance(luminance: LuminanceEvidence) -> bool {
    luminance.edge_fraction <= BLANK_MAX_EDGE_FRACTION
        && luminance.robust_luminance_range <= BLANK_MAX_ROBUST_LUMINANCE_RANGE
}

pub(crate) fn has_pale_tonal_structure(image: &GrayImage) -> bool {
    has_pale_tonal_structure_in_region(image, blank_interior_bounds(image))
}

fn has_pale_tonal_structure_in_region(
    image: &GrayImage,
    (region_left, region_top, region_right, region_bottom): (usize, usize, usize, usize),
) -> bool {
    let width = region_right.saturating_sub(region_left);
    let height = region_bottom.saturating_sub(region_top);
    let grid_width = width.min(PALE_TONE_GRID_SIZE);
    let grid_height = height.min(PALE_TONE_GRID_SIZE);
    if grid_width < 8 || grid_height < 8 {
        return false;
    }

    let mut means = vec![0.0; grid_width * grid_height];
    for grid_y in 0..grid_height {
        let top = grid_y * height / grid_height;
        let bottom = ((grid_y + 1) * height / grid_height).max(top + 1);
        for grid_x in 0..grid_width {
            let left = grid_x * width / grid_width;
            let right = ((grid_x + 1) * width / grid_width).max(left + 1);
            let mut sum = 0usize;
            let mut count = 0usize;
            for y in top..bottom.min(height) {
                for x in left..right.min(width) {
                    sum += usize::from(image.get(region_left + x, region_top + y));
                    count += 1;
                }
            }
            means[grid_y * grid_width + grid_x] = sum as f64 / count.max(1) as f64;
        }
    }

    let mut paper_levels = means.clone();
    paper_levels.sort_by(f64::total_cmp);
    let paper = paper_levels[paper_levels.len().saturating_sub(1) * 9 / 10];
    let crisp_cutoff = (paper - PALE_TONE_MAX_DELTA).floor().clamp(0.0, 255.0) as u8;
    let mut ink_fractions = vec![0.0; means.len()];
    for grid_y in 0..grid_height {
        let top = grid_y * height / grid_height;
        let bottom = ((grid_y + 1) * height / grid_height).max(top + 1);
        for grid_x in 0..grid_width {
            let left = grid_x * width / grid_width;
            let right = ((grid_x + 1) * width / grid_width).max(left + 1);
            let mut ink = 0usize;
            let mut count = 0usize;
            for y in top..bottom.min(height) {
                for x in left..right.min(width) {
                    ink += usize::from(image.get(region_left + x, region_top + y) < crisp_cutoff);
                    count += 1;
                }
            }
            ink_fractions[grid_y * grid_width + grid_x] = ink as f64 / count.max(1) as f64;
        }
    }
    let mut smoothed = vec![0.0; means.len()];
    for grid_y in 0..grid_height {
        for grid_x in 0..grid_width {
            let mut sum = 0.0;
            let mut count = 0usize;
            for neighbor_y in grid_y.saturating_sub(1)..=(grid_y + 1).min(grid_height - 1) {
                for neighbor_x in grid_x.saturating_sub(1)..=(grid_x + 1).min(grid_width - 1) {
                    sum += means[neighbor_y * grid_width + neighbor_x];
                    count += 1;
                }
            }
            smoothed[grid_y * grid_width + grid_x] = sum / count as f64;
        }
    }

    let minimum_area = (grid_width * grid_height) as f64 * PALE_TONE_MIN_COMPONENT_FRACTION;
    for minimum_delta in [PALE_TONE_MIN_DELTA, PALE_TONE_EDGE_DETACH_DELTA] {
        let candidate = smoothed
            .iter()
            .enumerate()
            .map(|(index, &value)| {
                let tile_delta = paper - means[index];
                let smoothed_delta = paper - value;
                (minimum_delta..=PALE_TONE_MAX_DELTA).contains(&tile_delta)
                    && (minimum_delta..=PALE_TONE_MAX_DELTA).contains(&smoothed_delta)
                    && ink_fractions[index] <= PALE_TONE_MAX_INK_FRACTION
            })
            .collect::<Vec<_>>();
        let mut visited = vec![false; candidate.len()];
        for seed in 0..candidate.len() {
            if !candidate[seed] || visited[seed] {
                continue;
            }
            let mut stack = vec![seed];
            visited[seed] = true;
            let mut area = 0usize;
            let mut left = grid_width;
            let mut top = grid_height;
            let mut right = 0usize;
            let mut bottom = 0usize;
            let mut tone_sum = 0.0;
            while let Some(index) = stack.pop() {
                let x = index % grid_width;
                let y = index / grid_width;
                area += 1;
                left = left.min(x);
                top = top.min(y);
                right = right.max(x);
                bottom = bottom.max(y);
                tone_sum += smoothed[index];
                for (neighbor_x, neighbor_y) in [
                    (x.checked_sub(1), Some(y)),
                    (
                        x.checked_add(1).filter(|&value| value < grid_width),
                        Some(y),
                    ),
                    (Some(x), y.checked_sub(1)),
                    (
                        Some(x),
                        y.checked_add(1).filter(|&value| value < grid_height),
                    ),
                ] {
                    let (Some(neighbor_x), Some(neighbor_y)) = (neighbor_x, neighbor_y) else {
                        continue;
                    };
                    let neighbor = neighbor_y * grid_width + neighbor_x;
                    if candidate[neighbor] && !visited[neighbor] {
                        visited[neighbor] = true;
                        stack.push(neighbor);
                    }
                }
            }
            let component_width = right - left + 1;
            let component_height = bottom - top + 1;
            let attached_to_edge =
                left == 0 || top == 0 || right + 1 == grid_width || bottom + 1 == grid_height;
            if !attached_to_edge
                && area as f64 >= minimum_area
                && component_width as f64
                    >= grid_width as f64 * PALE_TONE_MIN_COMPONENT_WIDTH_FRACTION
                && component_height as f64
                    >= grid_height as f64 * PALE_TONE_MIN_COMPONENT_HEIGHT_FRACTION
                && paper - tone_sum / area as f64 >= minimum_delta
            {
                return true;
            }
        }
    }
    false
}

/// Global coverage is intentionally not sufficient to erase a page: a short
/// word or page number can occupy less than the blank-coverage hysteresis. This
/// retains compact, connected dark-side edge structures while ignoring
/// isolated sensor noise. It is relative to neighbouring pixels, so changing
/// the paper from light gray to dark gray does not change the verdict.
fn has_coherent_edge_structure(image: &GrayImage) -> bool {
    let mut edges = BinaryImage::new(image.width(), image.height());
    for y in 0..image.height() {
        for x in 0..image.width() {
            let value = image.get(x, y);
            if x > 0 {
                let neighbor = image.get(x - 1, y);
                if value.abs_diff(neighbor) >= BLANK_EDGE_DIFFERENCE {
                    if value <= neighbor {
                        edges.set(x, y, true);
                    } else {
                        edges.set(x - 1, y, true);
                    }
                }
            }
            if y > 0 {
                let neighbor = image.get(x, y - 1);
                if value.abs_diff(neighbor) >= BLANK_EDGE_DIFFERENCE {
                    if value <= neighbor {
                        edges.set(x, y, true);
                    } else {
                        edges.set(x, y - 1, true);
                    }
                }
            }
        }
    }

    let minimum_height = ((image.height() as f64 * 0.003).round() as usize).clamp(2, 6);
    let minimum_area = minimum_height.saturating_mul(3);
    let maximum_width = (image.width() / 5).max(1);
    let maximum_height = (image.height() / 5).max(1);
    let components = ComponentMap::from_binary(&edges);
    let candidates = components
        .components()
        .iter()
        .filter(|component| {
            let width = component.right - component.left + 1;
            let height = component.bottom - component.top + 1;
            let border_attached = component.left == 0
                || component.top == 0
                || component.right + 1 == image.width()
                || component.bottom + 1 == image.height();
            !border_attached
                && width >= 2
                && height >= minimum_height
                && width <= maximum_width
                && height <= maximum_height
                && component.area >= minimum_area
        })
        .collect::<Vec<_>>();

    // A single dust fleck can be as compact as a tiny glyph, but it generally
    // lacks either the scale of a standalone mark or neighbouring glyphs on a
    // shared baseline. Preserve both larger standalone characters and very
    // short aligned text while allowing isolated scan dirt to remain blank.
    if candidates.iter().any(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        height >= minimum_height.saturating_mul(3)
            && component.area >= minimum_area.saturating_mul(2)
            && width.saturating_mul(8) >= height
            && height.saturating_mul(8) >= width
    }) {
        return true;
    }

    candidates.iter().enumerate().any(|(index, left)| {
        candidates.iter().skip(index + 1).any(|right| {
            let left_height = left.bottom - left.top + 1;
            let right_height = right.bottom - right.top + 1;
            let maximum_glyph_height = left_height.max(right_height);
            let minimum_glyph_height = left_height.min(right_height);
            let left_center = left.top + left_height / 2;
            let right_center = right.top + right_height / 2;
            let vertical_offset = left_center.abs_diff(right_center);
            let horizontal_gap = if left.right < right.left {
                right.left - left.right - 1
            } else if right.right < left.left {
                left.left - right.right - 1
            } else {
                0
            };
            maximum_glyph_height <= minimum_glyph_height.saturating_mul(2)
                && vertical_offset <= maximum_glyph_height / 2
                && horizontal_gap <= maximum_glyph_height.saturating_mul(4)
        })
    })
}

fn chroma_vector(pixel: [f64; 3]) -> [f64; 3] {
    let mean = pixel.iter().sum::<f64>() / 3.0;
    [pixel[0] - mean, pixel[1] - mean, pixel[2] - mean]
}

fn dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    left.into_iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum()
}

fn norm(vector: [f64; 3]) -> f64 {
    dot(vector, vector).sqrt()
}

fn dominant_ink_color(
    gray: &GrayImage,
    rgb: &RgbImage,
    background: [f64; 3],
    bright_cutoff: u8,
    text_line_count: usize,
) -> Option<[f64; 3]> {
    if text_line_count == 0 {
        return None;
    }
    let ink_cutoff = otsu_threshold(gray).min(bright_cutoff.saturating_sub(12));
    let paper_chroma = chroma_vector(background);
    let paper_tint = norm(paper_chroma);
    let mut histograms = [[0usize; 256]; 3];
    let mut count = 0usize;
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            if gray.get(x, y) > ink_cutoff {
                continue;
            }
            let pixel = rgb.get(x, y);
            let ink_chroma = chroma_vector(pixel.map(f64::from));
            let ink_tint = norm(ink_chroma);
            let neutral_ink = ink_tint <= 18.0;
            let same_tint_family = paper_tint >= 8.0
                && ink_tint >= 8.0
                && dot(paper_chroma, ink_chroma) / (paper_tint * ink_tint) >= 0.82;
            if !neutral_ink && !same_tint_family {
                // A seal or a photograph can occupy enough of the Otsu-dark
                // class to corrupt independent per-channel quantiles into a
                // color that never existed. Only samples plausibly belonging
                // to the paper's ink family may estimate its endpoint.
                continue;
            }
            for channel in 0..3 {
                histograms[channel][pixel[channel] as usize] += 1;
            }
            count += 1;
        }
    }
    let minimum_samples = gray.width().saturating_mul(gray.height()) / 10_000;
    // Rasterized glyph edges can outnumber their solid cores by a wide margin.
    // The median of the whole Otsu-dark class therefore lands halfway between
    // paper and ink, causing the actual cores to fall beyond the modeled
    // paper→ink segment and masquerade as independent color. A low robust
    // quantile anchors the segment at the ink core while remaining insensitive
    // to a handful of compression outliers.
    (count >= minimum_samples.max(16)).then(|| {
        histograms
            .map(|histogram| histogram_percentile(&histogram, count.saturating_sub(1) / 10) as f64)
    })
}

fn paper_ink_model(
    gray: &GrayImage,
    rgb: &RgbImage,
    background: [f64; 3],
    bright_cutoff: u8,
    text_line_count: usize,
) -> Option<([f64; 3], [f64; 3])> {
    let ink = dominant_ink_color(gray, rgb, background, bright_cutoff, text_line_count)?;
    let paper_chroma = chroma_vector(background);
    let ink_chroma = chroma_vector(ink);
    let paper_tint = norm(paper_chroma);
    let ink_tint = norm(ink_chroma);
    let neutral_ink = ink_tint <= 18.0;
    let same_tint_family = paper_tint >= 8.0
        && ink_tint >= 8.0
        && dot(paper_chroma, ink_chroma) / (paper_tint * ink_tint) >= 0.82;
    (neutral_ink || same_tint_family).then_some((background, ink))
}

fn explained_by_paper_ink_segment(pixel: [u8; 3], paper: [f64; 3], ink: [f64; 3]) -> bool {
    let pixel = pixel.map(f64::from);
    let direction = [ink[0] - paper[0], ink[1] - paper[1], ink[2] - paper[2]];
    let length_squared = dot(direction, direction);
    if length_squared <= f64::EPSILON {
        return false;
    }
    let offset = [
        pixel[0] - paper[0],
        pixel[1] - paper[1],
        pixel[2] - paper[2],
    ];
    let projection = dot(offset, direction) / length_squared;
    if !(-0.08..=1.20).contains(&projection) {
        return false;
    }
    let residual = [
        offset[0] - projection * direction[0],
        offset[1] - projection * direction[1],
        offset[2] - projection * direction[2],
    ];
    // JPEG ringing around antialiased tinted glyphs can move a paper/ink
    // mixture by roughly twenty channel levels away from the ideal segment.
    // Keeping the tolerance below the independent-color noise floor still
    // rejects seals and photos while preventing their presence from turning
    // ordinary tinted text into Mixed-background ownership.
    norm(residual) <= 24.0
}

fn chroma_evidence(
    gray: &GrayImage,
    rgb: Option<&RgbImage>,
    text_line_count: usize,
) -> ChromaEvidence {
    chroma_evidence_and_mask(gray, rgb, text_line_count).0
}

/// Pixels whose color cannot be explained by the page's paper-to-ink color
/// axis. This deliberately excludes uniform tinted paper and matching colored
/// ink, but retains an independent seal, annotation, photograph, or plate.
///
/// The mode selector and renderer must share this ownership definition. A
/// Mixed recommendation with an empty picture detector previously reached the
/// writer as a pure bilevel page and silently discarded the color evidence
/// that selected Mixed in the first place.
pub(crate) fn independent_chroma_mask(
    gray: &GrayImage,
    rgb: Option<&RgbImage>,
    text_line_count: usize,
) -> Option<BinaryImage> {
    let (_, mask) = chroma_evidence_and_mask(gray, rgb, text_line_count);
    mask.filter(|mask| mask.count_black() > 0)
}

fn chroma_evidence_and_mask(
    gray: &GrayImage,
    rgb: Option<&RgbImage>,
    text_line_count: usize,
) -> (ChromaEvidence, Option<BinaryImage>) {
    let Some(rgb) = rgb else {
        return (
            ChromaEvidence {
                colored_fraction: 0.0,
                largest_component_pixels: 0,
                mean_saturation: 0.0,
                paper_tint: 0.0,
            },
            None,
        );
    };
    let bright_cutoff = grayscale_percentile(gray, 0.7);
    let mut background_histograms = [[0usize; 256]; 3];
    let mut background_count = 0usize;
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            if gray.get(x, y) < bright_cutoff {
                continue;
            }
            let pixel = rgb.get(x, y);
            for channel in 0..3 {
                background_histograms[channel][pixel[channel] as usize] += 1;
            }
            background_count += 1;
        }
    }
    if background_count == 0 {
        return (
            ChromaEvidence {
                colored_fraction: 0.0,
                largest_component_pixels: 0,
                mean_saturation: 0.0,
                paper_tint: 0.0,
            },
            None,
        );
    }
    let background = background_histograms
        .map(|histogram| histogram_percentile(&histogram, background_count / 2).max(1) as f64);
    let background_mean = background.iter().sum::<f64>() / 3.0;
    let background_chroma = chroma_vector(background);
    let background_tint = norm(background_chroma);
    let paper_ink_model = paper_ink_model(gray, rgb, background, bright_cutoff, text_line_count);
    let mut colored = 0usize;
    let mut saturation_sum = 0.0;
    let mut chroma_mask = BinaryImage::new(gray.width(), gray.height());
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            let pixel = rgb.get(x, y);
            let dark_ink = gray.get(x, y) <= DARK_LUMINANCE_CUTOFF;
            let pixel_chroma = chroma_vector(pixel.map(f64::from));
            let pixel_tint = norm(pixel_chroma);
            let follows_paper_tint = dark_ink
                && background_tint >= 8.0
                && pixel_tint >= 8.0
                && dot(background_chroma, pixel_chroma) / (background_tint * pixel_tint) >= 0.82;
            let compared = if paper_ink_model
                .is_some_and(|(paper, ink)| explained_by_paper_ink_segment(pixel, paper, ink))
                || follows_paper_tint
            {
                [0.0; 3]
            } else if dark_ink {
                pixel.map(f64::from)
            } else {
                [
                    f64::from(pixel[0]) * background_mean / background[0],
                    f64::from(pixel[1]) * background_mean / background[1],
                    f64::from(pixel[2]) * background_mean / background[2],
                ]
            };
            let minimum = compared.iter().copied().fold(f64::INFINITY, f64::min);
            let maximum = compared.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let chroma = maximum - minimum;
            let saturation = chroma / maximum.max(1.0);
            let noise_floor = if dark_ink {
                DARK_CHROMA_NOISE_FLOOR
            } else {
                CHROMA_NOISE_FLOOR
            };
            if chroma >= noise_floor && saturation >= CHROMA_SATURATION_FLOOR {
                colored += 1;
                saturation_sum += saturation;
                chroma_mask.set(x, y, true);
            }
        }
    }
    let largest_component_pixels = ComponentMap::from_binary(&chroma_mask)
        .components()
        .iter()
        .map(|component| component.area)
        .max()
        .unwrap_or(0);
    (
        ChromaEvidence {
            colored_fraction: colored as f64
                / gray.width().saturating_mul(gray.height()).max(1) as f64,
            largest_component_pixels,
            mean_saturation: saturation_sum / colored.max(1) as f64,
            paper_tint: norm(chroma_vector(background)),
        },
        Some(chroma_mask),
    )
}

fn luminance_evidence(image: &GrayImage) -> LuminanceEvidence {
    luminance_evidence_region(image, (0, 0, image.width(), image.height()))
}

fn luminance_evidence_region(
    image: &GrayImage,
    (left, top, right, bottom): (usize, usize, usize, usize),
) -> LuminanceEvidence {
    let mut histogram = [0u64; 256];
    for y in top..bottom {
        for x in left..right {
            histogram[image.get(x, y) as usize] += 1;
        }
    }
    let total = histogram.iter().sum::<u64>().max(1);
    let mean = histogram
        .iter()
        .enumerate()
        .map(|(value, count)| value as f64 * *count as f64)
        .sum::<f64>()
        / total as f64;
    let total_variance = histogram
        .iter()
        .enumerate()
        .map(|(value, count)| {
            let difference = value as f64 - mean;
            difference * difference * *count as f64
        })
        .sum::<f64>();
    let threshold = otsu_threshold_from_histogram(&histogram) as usize;
    let dark_count = histogram[..threshold].iter().sum::<u64>();
    let light_count = total.saturating_sub(dark_count);
    let dark_mean = if dark_count == 0 {
        0.0
    } else {
        histogram[..threshold]
            .iter()
            .enumerate()
            .map(|(value, count)| value as f64 * *count as f64)
            .sum::<f64>()
            / dark_count as f64
    };
    let light_mean = if light_count == 0 {
        255.0
    } else {
        histogram[threshold..]
            .iter()
            .enumerate()
            .map(|(offset, count)| (threshold + offset) as f64 * *count as f64)
            .sum::<f64>()
            / light_count as f64
    };
    let between_variance =
        dark_count as f64 * light_count as f64 / total as f64 * (dark_mean - light_mean).powi(2);
    let lower = (dark_mean + 18.0).clamp(0.0, 255.0);
    let upper = (light_mean - 18.0).clamp(0.0, 255.0);
    let midtone_count = if lower < upper {
        histogram[lower.ceil() as usize..=upper.floor() as usize]
            .iter()
            .sum::<u64>()
    } else {
        0
    };
    // A fixed number of gray levels cannot describe antialiasing on both
    // charcoal paper and pale stock. This band is relative to the page's own
    // dark/light modes, excluding the endpoint 15% at either side.
    let relative_lower = (dark_mean + (light_mean - dark_mean) * 0.15).clamp(0.0, 255.0);
    let relative_upper = (light_mean - (light_mean - dark_mean) * 0.15).clamp(0.0, 255.0);
    let relative_midtone_count = if relative_lower < relative_upper {
        histogram[relative_lower.ceil() as usize..=relative_upper.floor() as usize]
            .iter()
            .sum::<u64>()
    } else {
        0
    };
    let mut strong_edges = 0usize;
    let mut edge_comparisons = 0usize;
    for y in top..bottom {
        for x in left..right {
            let value = image.get(x, y);
            if x > left {
                strong_edges +=
                    usize::from(value.abs_diff(image.get(x - 1, y)) >= BLANK_EDGE_DIFFERENCE);
                edge_comparisons += 1;
            }
            if y > top {
                strong_edges +=
                    usize::from(value.abs_diff(image.get(x, y - 1)) >= BLANK_EDGE_DIFFERENCE);
                edge_comparisons += 1;
            }
        }
    }
    LuminanceEvidence {
        otsu_threshold: threshold as u8,
        dark_mean,
        light_mean,
        midtone_lower: lower,
        midtone_upper: upper,
        p01: luminance_histogram_percentile(&histogram, total, 0.01),
        p50: luminance_histogram_percentile(&histogram, total, 0.50),
        p99: luminance_histogram_percentile(&histogram, total, 0.99),
        bimodality: if total_variance <= f64::EPSILON {
            0.0
        } else {
            (between_variance / total_variance).clamp(0.0, 1.0)
        },
        midtone_fraction: midtone_count as f64 / total as f64,
        relative_midtone_fraction: relative_midtone_count as f64 / total as f64,
        mode_distance: light_mean - dark_mean,
        // The darker Otsu class is relative to this page's paper tone. An
        // absolute "ink is below N" cutoff makes the same black text occupy
        // either none or all of a page merely because the paper is dark gray.
        ink_fraction: dark_count as f64 / total as f64,
        edge_fraction: strong_edges as f64 / edge_comparisons.max(1) as f64,
        robust_luminance_range: luminance_histogram_percentile(&histogram, total, 0.99)
            - luminance_histogram_percentile(&histogram, total, 0.01),
    }
}

fn otsu_threshold_from_histogram(histogram: &[u64; 256]) -> u8 {
    let total = histogram.iter().sum::<u64>();
    if total == 0 {
        return 0;
    }
    let weighted_total = histogram
        .iter()
        .enumerate()
        .map(|(value, count)| value as u64 * count)
        .sum::<u64>();
    let mut background_count = 0u64;
    let mut background_sum = 0u64;
    let mut best_score = -1.0f64;
    let mut first_best = 0u8;
    let mut last_best = 0u8;
    for threshold in 1..=255u16 {
        let value = threshold as usize - 1;
        background_count += histogram[value];
        background_sum += value as u64 * histogram[value];
        let foreground_count = total - background_count;
        if background_count == 0 || foreground_count == 0 {
            continue;
        }
        let mean_difference = background_sum as f64 / background_count as f64
            - (weighted_total - background_sum) as f64 / foreground_count as f64;
        let score =
            background_count as f64 * foreground_count as f64 * mean_difference * mean_difference;
        let tolerance = best_score.abs().max(1.0) * 1e-12;
        if score > best_score + tolerance {
            best_score = score;
            first_best = threshold as u8;
            last_best = threshold as u8;
        } else if (score - best_score).abs() <= tolerance {
            last_best = threshold as u8;
        }
    }
    ((u16::from(first_best) + u16::from(last_best)) / 2) as u8
}

fn luminance_histogram_percentile(histogram: &[u64; 256], total: u64, percentile: f64) -> f64 {
    let rank = ((total.saturating_sub(1)) as f64 * percentile).round() as u64;
    let mut cumulative = 0u64;
    for (value, count) in histogram.iter().enumerate() {
        cumulative += *count;
        if cumulative > rank {
            return value as f64;
        }
    }
    255.0
}

fn grayscale_percentile(image: &GrayImage, percentile: f64) -> u8 {
    let mut histogram = [0usize; 256];
    for y in 0..image.height() {
        for &value in image.row(y) {
            histogram[value as usize] += 1;
        }
    }
    let rank = (image.width().saturating_mul(image.height()) as f64 * percentile).floor() as usize;
    histogram_percentile(&histogram, rank)
}

fn histogram_percentile(histogram: &[usize; 256], rank: usize) -> u8 {
    let mut cumulative = 0usize;
    for (value, count) in histogram.iter().enumerate() {
        cumulative += count;
        if cumulative > rank {
            return value as u8;
        }
    }
    255
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::render::analyze_page_with_color_and_document_prior;
    use crate::CleanupOptions;
    use crate::{
        calibration::{CalibrationConfig, PageCalibration},
        picture::detect_picture_mask,
    };
    use std::path::PathBuf;

    #[test]
    fn grayscale_percentile_ignores_stride_padding() {
        let image = GrayImage::from_vec(
            3,
            2,
            6,
            vec![10, 20, 30, 255, 255, 255, 40, 50, 60, 255, 255, 255],
        )
        .unwrap();
        assert_eq!(grayscale_percentile(&image, 0.5), 40);
    }

    #[test]
    fn bilevel_fidelity_veto_tracks_sampling_and_soft_edges_not_paper_shade() {
        for source_dpi in [72.0, 100.0, 150.0] {
            assert!(should_veto_bilevel_fidelity(
                true, 2.0, 8.0, source_dpi, 0.2, 4,
            ));
        }
        assert!(should_veto_bilevel_fidelity(true, 3.0, 12.0, 100.0, 0.9, 4,));
        assert!(
            !should_veto_bilevel_fidelity(true, 4.8, 14.4, 360.0, 0.6, 4),
            "measured 360 dpi book print (stroke 4.8 px, x-height 14.4 px) binarizes cleanly"
        );
        assert!(
            !should_veto_bilevel_fidelity(true, 1.0, 6.0, 100.0, 0.0, 4),
            "an already-bilevel source has no soft edge topology to preserve"
        );
        assert!(
            !should_veto_bilevel_fidelity(false, 0.0, 0.0, 300.0, 0.2, 1),
            "uncalibrated sparse text at print resolution is not rejected by DPI alone"
        );
    }

    #[test]
    fn soft_text_with_a_genuine_photo_uses_soft_mixed_but_line_art_uses_a_stencil() {
        let (gray, rgb) = text_page([192, 192, 192]);
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 2.0,
            x_height_px: 8.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let mut genuine_photo = classify(&gray, Some(&rgb));
        genuine_photo.mode = OutputMode::Mixed;
        genuine_photo.diagnostics.significant_picture = true;
        genuine_photo.diagnostics.significant_color = false;
        genuine_photo.diagnostics.picture_fraction = 0.55;
        genuine_photo.diagnostics.midtone_fraction = 0.42;
        genuine_photo.diagnostics.bimodality = 0.45;

        let protected_photo =
            protect_bilevel_text_fidelity(genuine_photo, calibration, 150.0, 8, Some(0.2));
        assert_eq!(protected_photo.mode, OutputMode::Mixed);
        assert!(protected_photo.diagnostics.bilevel_fidelity_veto);

        let mut line_art = genuine_photo;
        line_art.diagnostics.picture_fraction = 0.75;
        line_art.diagnostics.midtone_fraction = 0.12;
        line_art.diagnostics.bimodality = 0.80;
        let protected_line_art =
            protect_bilevel_text_fidelity(line_art, calibration, 150.0, 8, Some(0.2));
        assert_eq!(protected_line_art.mode, OutputMode::Mixed);
        assert!(!protected_line_art.diagnostics.bilevel_fidelity_veto);
    }

    fn synthetic_photo_value(x: usize, y: usize) -> u8 {
        // Shadow masses beside midtone fields at picture scale — what the
        // halftone classifier's rank cascade and spread verdict actually
        // see in a printed photograph (per-pixel noise is not a photo).
        if (x / 24 + y / 24) % 2 == 0 {
            30 + ((x * 37 + y * 61) % 24) as u8
        } else {
            120 + ((x * 13 + y * 41) % 48) as u8
        }
    }

    fn text_page(background: [u8; 3]) -> (GrayImage, RgbImage) {
        let mut rgb = RgbImage::new(360, 260, background);
        for row in 0..8 {
            for column in 0..14 {
                let left = 18 + column * 22;
                let top = 18 + row * 28;
                for y in top..top + 14 {
                    for x in left..left + 12 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            let value = [35, 32, 28];
                            rgb.set(x, y, value);
                        }
                    }
                }
            }
        }
        (rgb_to_gray(&rgb), rgb)
    }

    fn rgb_to_gray(rgb: &RgbImage) -> GrayImage {
        let mut gray = GrayImage::new(rgb.width(), rgb.height(), 255);
        for y in 0..rgb.height() {
            for x in 0..rgb.width() {
                let pixel = rgb.get(x, y);
                gray.set(
                    x,
                    y,
                    ((u32::from(pixel[0]) * 77
                        + u32::from(pixel[1]) * 150
                        + u32::from(pixel[2]) * 29
                        + 128)
                        >> 8) as u8,
                );
            }
        }
        gray
    }

    fn auto_options() -> CleanupOptions {
        CleanupOptions {
            output_mode: OutputMode::Auto,
            dpi: 150.0,
            normalize_illumination: false,
            crop_content: false,
            ..CleanupOptions::default()
        }
    }

    fn classify(gray: &GrayImage, rgb: Option<&RgbImage>) -> OutputModeRecommendation {
        analyze_page_with_color_and_document_prior(gray, rgb, &auto_options(), None)
            .unwrap()
            .output_mode_recommendation
            .expect("automatic mode emits a recommendation")
    }

    fn report(label: &str, recommendation: OutputModeRecommendation) {
        println!(
            "CLASSIFICATION_MATRIX\t{label}\t{:?}\t{:.6}\t{:?}",
            recommendation.mode, recommendation.confidence, recommendation.reason
        );
    }

    #[test]
    fn near_blank_flyleaf_is_explicitly_clean_bw() {
        let mut gray = GrayImage::new(620, 877, 190);
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                gray.set(x, y, 187 + ((x * 7 + y * 11) % 7) as u8);
            }
        }
        for y in 20..24 {
            for x in 20..28 {
                gray.set(x, y, 145);
            }
        }
        let picture_mask = BinaryImage::new(gray.width(), gray.height());
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 0,
        });
        report("blank-flyleaf", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Bw);
        assert_eq!(recommendation.reason, OutputModeRecommendationReason::Blank);
        assert!(recommendation.confidence >= 0.8);
    }

    #[test]
    fn blank_candidate_is_invariant_to_paper_luminance_and_gentle_shading() {
        for base in [72i16, 112, 152, 192, 232] {
            let mut gray = GrayImage::new(620, 877, base as u8);
            for y in 0..gray.height() {
                for x in 0..gray.width() {
                    let horizontal_shading = (x * 32 / gray.width()) as i16 - 16;
                    let paper_texture = ((x * 7 + y * 11) % 5) as i16 - 2;
                    gray.set(
                        x,
                        y,
                        (base + horizontal_shading + paper_texture).clamp(0, 255) as u8,
                    );
                }
            }
            assert!(
                is_blank_scan_candidate(&gray, None),
                "blank gray sheet at luminance {base} was treated as content",
            );
        }
    }

    #[test]
    fn compact_text_vetoes_blank_candidate_at_every_paper_luminance() {
        for background in [72u8, 112, 152, 192, 232] {
            let mut gray = GrayImage::new(620, 877, background);
            let ink = background.saturating_sub(64);
            for glyph in 0..6 {
                let left = 282 + glyph * 9;
                for y in 424..431 {
                    gray.set(left, y, ink);
                    gray.set(left + 4, y, ink);
                }
                for x in left..=left + 4 {
                    gray.set(x, 424, ink);
                    gray.set(x, 427, ink);
                }
            }
            assert!(
                !is_blank_scan_candidate(&gray, None),
                "compact text was treated as blank at luminance {background}",
            );
        }
    }

    #[test]
    fn real_rome_flyleaves_are_blank_candidates_before_normalization() {
        for page_number in 2..=4 {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
                "tests/fixtures/blank/rome-flyleaf-p{page_number:05}-150dpi.png",
            ));
            let gray =
                crate::png::decode_gray(&std::fs::read(path).unwrap(), 2_000_000, 2_000).unwrap();
            let luminance = luminance_evidence(&gray);
            let chroma = chroma_evidence(&gray, None, 0);
            assert!(
                is_blank_scan_candidate(&gray, None),
                "page={page_number}, luminance={luminance:?}, chroma={chroma:?}, coherent_edges={}",
                has_coherent_edge_structure(&gray),
            );
        }
    }

    #[test]
    fn auto_mode_turns_sparse_black_text_on_any_gray_paper_into_bw() {
        for background in [72u8, 112, 152, 192, 232] {
            let mut gray = GrayImage::new(620, 877, background);
            let ink = background.saturating_sub(64);
            for glyph in 0..6 {
                let left = 282 + glyph * 9;
                for y in 424..431 {
                    gray.set(left, y, ink);
                    gray.set(left + 4, y, ink);
                }
                for x in left..=left + 4 {
                    gray.set(x, 424, ink);
                    gray.set(x, 427, ink);
                }
            }
            let recommendation = recommend_output_mode(PreparedModeEvidence {
                analysis: &gray,
                analysis_rgb: None,
                picture_mask: &BinaryImage::new(gray.width(), gray.height()),
                picture_tone_evidence: false,
                text_line_count: 1,
            });
            assert_eq!(
                recommendation.mode,
                OutputMode::Bw,
                "sparse text on luminance {background} resolved as {recommendation:?}; evidence={:?}",
                luminance_evidence(&gray),
            );
        }
    }

    #[test]
    fn a_few_lines_of_faint_text_on_flat_paper_are_not_left_gray() {
        let mut gray = GrayImage::new(620, 877, 205);
        for line in 0..5 {
            let top = 340 + line * 24;
            for glyph in 0..24 {
                let left = 145 + glyph * 10;
                for y in top..top + 11 {
                    gray.set(left, y, 145);
                    gray.set(left + 1, y, 145);
                }
                for x in left..left + 7 {
                    gray.set(x, top, 145);
                    gray.set(x, top + 5, 145);
                }
            }
        }

        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &BinaryImage::new(gray.width(), gray.height()),
            picture_tone_evidence: false,
            text_line_count: 5,
        });

        assert_eq!(
            recommendation.mode,
            OutputMode::Bw,
            "{recommendation:?}; evidence={:?}",
            luminance_evidence(&gray),
        );
    }

    #[test]
    fn isolated_compact_dust_does_not_look_like_text() {
        let mut gray = GrayImage::new(620, 877, 170);
        for y in 436..441 {
            for x in 308..313 {
                gray.set(x, y, 80);
            }
        }
        assert!(is_blank_scan_candidate(&gray, None));
    }

    fn leaf_with_a_fold_shadow(base: u8) -> GrayImage {
        let mut gray = GrayImage::new(620, 877, base);
        for y in 0..gray.height() {
            for x in 0..22 {
                gray.set(x, y, (26 + x * 9).min(base as usize) as u8);
            }
        }
        gray
    }

    #[test]
    fn a_fold_shadow_in_the_edge_band_does_not_deny_a_blank_verso() {
        let gray = leaf_with_a_fold_shadow(232);
        assert!(
            is_blank_scan_candidate(&gray, None),
            "the leaf's own fold shadow was read as page content: {:?}",
            luminance_evidence(&gray),
        );
    }

    #[test]
    fn a_single_full_page_pale_plate_is_never_a_blank_candidate() {
        let mut gray = GrayImage::new(1_116, 1_626, 240);
        for y in 160..1_460 {
            for x in 0..gray.width() {
                gray.set(x, y, 239);
            }
        }
        for y in 190..1_450 {
            for x in 120..1_000 {
                gray.set(x, y, 232);
            }
        }
        let interior_area = (gray.width() as f64 * (1.0 - 2.0 * BLANK_EDGE_BAND_FRACTION))
            * (gray.height() as f64 * (1.0 - 2.0 * BLANK_EDGE_BAND_FRACTION));
        let plate_area = (1_000 - 120) * (1_450 - 190);
        assert!(plate_area as f64 / interior_area >= 0.60);
        assert!(has_pale_tonal_structure(&gray));
        assert!(
            !is_blank_scan_candidate(&gray, None),
            "a pale photo plate would have been emitted blank",
        );
    }

    #[test]
    fn a_near_blank_leaf_without_a_plate_stays_a_blank_candidate() {
        let mut gray = leaf_with_a_fold_shadow(244);
        for y in 120..760 {
            for x in 22..gray.width() {
                gray.set(x, y, 243);
            }
        }
        assert!(!has_pale_tonal_structure(&gray));
        assert!(is_blank_scan_candidate(&gray, None));
    }

    #[test]
    fn ordinary_text_pages_do_not_have_pale_tonal_structure() {
        let mut dense = GrayImage::new(1_024, 1_400, 240);
        for top in (120..1_280).step_by(25) {
            for y in top..top + 4 {
                for x in 100..924 {
                    if (x / 31) % 6 != 5 {
                        dense.set(x, y, 24);
                    }
                }
            }
        }

        let mut two_column = GrayImage::new(1_024, 1_400, 240);
        for top in (140..1_260).step_by(28) {
            for y in top..top + 5 {
                for (left, right) in [(90, 480), (544, 934)] {
                    for x in left..right {
                        if (x / 29) % 5 != 4 {
                            two_column.set(x, y, 20);
                        }
                    }
                }
            }
        }

        let mut title = GrayImage::new(1_024, 1_400, 240);
        for (top, left, right) in [
            (360, 210, 814),
            (430, 150, 874),
            (510, 260, 764),
            (610, 330, 694),
        ] {
            for y in top..top + 12 {
                for x in left..right {
                    if (x / 37) % 6 != 5 {
                        title.set(x, y, 18);
                    }
                }
            }
        }

        for (label, page) in [
            ("dense", dense),
            ("two-column", two_column),
            ("title", title),
        ] {
            assert!(
                !has_pale_tonal_structure(&page),
                "ordinary {label} text was promoted to a pale plate",
            );
        }
    }

    #[test]
    fn a_spurious_line_counter_without_source_edges_does_not_veto_blank_mode() {
        let gray = GrayImage::new(620, 877, 190);
        let picture_mask = BinaryImage::new(gray.width(), gray.height());
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 1,
        });
        assert_eq!(recommendation.reason, OutputModeRecommendationReason::Blank);
    }

    #[test]
    fn recommends_bw_for_text_and_ignores_yellowed_paper_tint() {
        for background in [[245, 245, 245], [244, 226, 176]] {
            let (gray, rgb) = text_page(background);
            let recommendation = classify(&gray, Some(&rgb));
            if background == [244, 226, 176] {
                report("yellowed-black-ink", recommendation);
            }
            assert_eq!(
                recommendation.mode,
                OutputMode::Bw,
                "{background:?}: {recommendation:?}"
            );
            assert!(recommendation.confidence >= 0.75);
        }
    }

    #[test]
    fn uniform_light_paper_tint_and_shade_sweep_normalizes_to_bw() {
        for background in [
            [245, 245, 245],
            [205, 225, 245],
            [225, 205, 215],
            [235, 220, 175],
            [190, 215, 195],
            [165, 180, 205],
            [170, 170, 170],
        ] {
            let (_, mut rgb) = text_page(background);
            let matching_ink = background
                .map(|channel| (f64::from(channel) * 0.18).round().clamp(8.0, 64.0) as u8);
            for y in 0..rgb.height() {
                for x in 0..rgb.width() {
                    if rgb.get(x, y) != background {
                        rgb.set(x, y, matching_ink);
                    }
                }
            }
            let recommendation = classify(&rgb_to_gray(&rgb), Some(&rgb));
            assert_eq!(
                recommendation.mode,
                OutputMode::Bw,
                "paper={background:?} ink={matching_ink:?}: {recommendation:?}"
            );
        }
    }

    #[test]
    fn dense_text_on_dark_or_low_contrast_uniform_gray_paper_is_bw() {
        for (background, ink) in [(72_u8, 0_u8), (112, 8), (152, 96), (192, 20)] {
            let (mut gray, _) = text_page([background; 3]);
            for value in gray.data_mut() {
                if *value != background {
                    *value = ink;
                }
            }

            let recommendation = classify(&gray, None);

            assert_eq!(
                recommendation.mode,
                OutputMode::Bw,
                "paper={background} ink={ink}: {recommendation:?}; evidence={:?}",
                luminance_evidence(&gray),
            );
        }
    }

    #[test]
    fn hollow_red_seal_on_text_page_is_color() {
        let (_, mut rgb) = text_page([245; 3]);
        let center = (290_i32, 170_i32);
        for y in 135..205 {
            for x in 255..325 {
                let distance_squared = (x as i32 - center.0).pow(2) + (y as i32 - center.1).pow(2);
                if (28_i32.pow(2)..=34_i32.pow(2)).contains(&distance_squared) {
                    rgb.set(x, y, [150, 25, 32]);
                }
            }
        }
        let gray = rgb_to_gray(&rgb);
        let recommendation = classify(&gray, Some(&rgb));
        report("hollow-seal-small", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Color);
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::ColorChroma
        );
    }

    #[test]
    fn a4_hollow_seal_qualifies_only_through_its_connected_component() {
        let mut rgb = RgbImage::new(1_240, 1_754, [245; 3]);
        for row in 0..18 {
            for column in 0..24 {
                let left = 80 + column * 42;
                let top = 90 + row * 76;
                for y in top..top + 18 {
                    for x in left..left + 20 {
                        if x < left + 3 || y < top + 3 || y >= top + 15 {
                            rgb.set(x, y, [35, 32, 28]);
                        }
                    }
                }
            }
        }
        let center = (1_070_i32, 1_520_i32);
        for y in 1_475..1_565 {
            for x in 1_025..1_115 {
                let distance_squared = (x as i32 - center.0).pow(2) + (y as i32 - center.1).pow(2);
                if (36_i32.pow(2)..=41_i32.pow(2)).contains(&distance_squared) {
                    rgb.set(x, y, [150, 25, 32]);
                }
            }
        }
        let gray = rgb_to_gray(&rgb);
        let chroma = chroma_evidence(&gray, Some(&rgb), 18);
        assert!(
            chroma.colored_fraction + COLOR_PIXEL_FRACTION_HYSTERESIS < COLOR_PIXEL_FRACTION_FLOOR,
            "{chroma:?}"
        );
        assert!(
            chroma.largest_component_pixels >= SIGNIFICANT_CHROMA_COMPONENT_PIXELS,
            "{chroma:?}"
        );
        let recommendation = classify(&gray, Some(&rgb));
        report("hollow-seal-a4-component-only", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Color, "{recommendation:?}");
    }

    #[test]
    fn dark_blue_stamp_on_text_page_is_color() {
        let (_, mut rgb) = text_page([245; 3]);
        for y in 150..175 {
            for x in 255..285 {
                rgb.set(x, y, [5, 18, 55]);
            }
        }
        let gray = rgb_to_gray(&rgb);
        let recommendation = classify(&gray, Some(&rgb));
        report("dark-blue-stamp", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Color, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::ColorChroma
        );
    }

    #[test]
    fn dark_text_matching_tinted_stock_is_bw_but_independent_color_survives() {
        let mut blue_stock = RgbImage::new(360, 260, [205, 225, 245]);
        for row in 0..8 {
            for column in 0..14 {
                let left = 18 + column * 22;
                let top = 18 + row * 28;
                for y in top..top + 14 {
                    for x in left..left + 12 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            blue_stock.set(x, y, [12, 32, 76]);
                        }
                    }
                }
            }
        }
        let blue_recommendation = classify(&rgb_to_gray(&blue_stock), Some(&blue_stock));
        report("pale-blue-stock-dark-blue-ink", blue_recommendation);
        assert_eq!(
            blue_recommendation.mode,
            OutputMode::Bw,
            "{blue_recommendation:?}"
        );

        let (yellow_gray, yellow_stock) = text_page([244, 226, 176]);
        let yellow_recommendation = classify(&yellow_gray, Some(&yellow_stock));
        assert_eq!(
            yellow_recommendation.mode,
            OutputMode::Bw,
            "{yellow_recommendation:?}"
        );

        for y in 202..222 {
            for x in 244..326 {
                blue_stock.set(x, y, [150, 22, 35]);
            }
        }
        let red_mark_recommendation = classify(&rgb_to_gray(&blue_stock), Some(&blue_stock));
        assert_eq!(
            red_mark_recommendation.mode,
            OutputMode::Color,
            "an interior color mark without a picture owner should preserve the whole page: {red_mark_recommendation:?}"
        );
        assert!(red_mark_recommendation.diagnostics.significant_color);

        let red_mark_gray = rgb_to_gray(&blue_stock);
        let ownership = independent_chroma_mask(&red_mark_gray, Some(&blue_stock), 8)
            .expect("independent red mark owns Mixed background pixels");
        assert!(
            ownership.get(270, 210),
            "the independent red object was not retained"
        );
        assert!(
            !ownership.get(350, 250),
            "uniform blue paper was mistaken for independent color"
        );
        assert!(
            !ownership.get(20, 20),
            "matching blue ink was mistaken for independent color"
        );
    }

    #[test]
    fn color_photo_does_not_make_cream_paper_or_brown_ink_own_mixed_pixels() {
        let mut page = RgbImage::new(360, 260, [235, 220, 175]);
        for row in 0..8 {
            for column in 0..14 {
                let left = 18 + column * 22;
                let top = 18 + row * 28;
                for y in top..top + 14 {
                    for x in left..left + 12 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            page.set(x, y, [35, 30, 22]);
                        }
                    }
                }
            }
        }
        for y in 150..240 {
            for x in 230..345 {
                page.set(
                    x,
                    y,
                    [
                        30 + ((x * 11 + y * 7) % 190) as u8,
                        25 + ((x * 3 + y * 17) % 170) as u8,
                        55 + ((x * 19 + y * 5) % 180) as u8,
                    ],
                );
            }
        }

        let gray = rgb_to_gray(&page);
        let ownership = independent_chroma_mask(&gray, Some(&page), 8)
            .expect("the independent color photo owns Mixed pixels");
        assert!(ownership.get(300, 200));
        assert!(
            !ownership.get(20, 20),
            "brown ink was contaminated by the photo's dark colors"
        );
        assert!(
            !ownership.get(350, 250),
            "cream paper was contaminated by the photo's color model"
        );
    }

    #[test]
    fn dark_jpeg_chroma_noise_stays_bw_below_36_and_qualifies_at_36() {
        let (gray, mut below_boundary) = text_page([245; 3]);
        for y in 155..180 {
            for x in 250..282 {
                let wobble = ((x * 13 + y * 17) % 4) as u8;
                below_boundary.set(x, y, [10 + wobble, 10, 45]);
            }
        }
        let below_gray = rgb_to_gray(&below_boundary);
        let below = classify(&below_gray, Some(&below_boundary));
        report("jpeg-dark-chroma-35", below);
        assert_eq!(below.mode, OutputMode::Bw, "{below:?}");

        let mut at_boundary = below_boundary;
        for y in 155..180 {
            for x in 250..282 {
                at_boundary.set(x, y, [10, 10, 46]);
            }
        }
        let at_boundary_gray = rgb_to_gray(&at_boundary);
        let at_boundary_recommendation = classify(&at_boundary_gray, Some(&at_boundary));
        report("jpeg-dark-chroma-36", at_boundary_recommendation);
        assert_eq!(
            at_boundary_recommendation.mode,
            OutputMode::Color,
            "{at_boundary_recommendation:?}; baseline={:?}",
            classify(&gray, None)
        );
    }

    #[test]
    fn recommends_grayscale_for_a_photo_like_page() {
        let mut gray = GrayImage::new(360, 260, 255);
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                let gradient = 28 + (x * 176 / gray.width()) as u8;
                let texture = ((x * 17 + y * 29 + x * y % 53) % 45) as u8;
                gray.set(x, y, gradient.saturating_add(texture));
            }
        }
        let recommendation = classify(&gray, None);
        report("photo-like-page", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Grayscale);
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::ContinuousTone
        );
    }

    #[test]
    fn ten_percent_photo_vetoes_bw_and_keeps_text_page_mixed() {
        let (mut gray, _) = text_page([245; 3]);
        for y in 115..235 {
            for x in 225..345 {
                gray.set(x, y, synthetic_photo_value(x, y));
            }
        }
        let recommendation = classify(&gray, None);
        report("ten-percent-photo", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Mixed, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::TextWithPictures
        );
    }

    #[test]
    fn small_corroborated_picture_on_text_page_uses_mixed() {
        let mut gray = GrayImage::new(1_000, 1_400, 245);
        for row in 0..18 {
            let top = 80 + row * 64;
            for column in 0..30 {
                let left = 70 + column * 29;
                for y in top..top + 18 {
                    for x in left..left + 14 {
                        if x < left + 2 || y < top + 2 || y >= top + 16 {
                            gray.set(x, y, 28);
                        }
                    }
                }
            }
        }
        let mut picture_mask = BinaryImage::new(gray.width(), gray.height());
        for y in 600..700 {
            for x in 780..880 {
                picture_mask.set(x, y, true);
                gray.set(x, y, 80 + ((x * 17 + y * 29) % 130) as u8);
            }
        }

        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: true,
            text_line_count: 18,
        });
        report("small-corroborated-picture", recommendation);
        assert!(recommendation.diagnostics.picture_fraction >= CORROBORATED_PICTURE_NOISE_FLOOR);
        assert!(
            recommendation.diagnostics.picture_fraction < PICTURE_NOISE_FLOOR,
            "fixture must stay below the ordinary picture gate: {recommendation:?}"
        );
        assert!(
            recommendation.diagnostics.significant_picture,
            "corroborated tone evidence should keep the lower picture floor: {recommendation:?}"
        );
        assert_eq!(recommendation.mode, OutputMode::Mixed, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::TextWithPictures
        );
    }

    #[test]
    fn localized_tone_beside_text_uses_layers_instead_of_a_full_page_gray_raster() {
        let (gray, _) = text_page([205; 3]);
        let outside_tone = crate::text_tone::OutsideTonalEvidence {
            fraction: 0.025,
            largest_component_fraction: 0.02,
            largest_component_width_fraction: 0.12,
            largest_component_height_fraction: 0.10,
        };

        // With detector-corroborated ownership, localized tone beside text
        // is layered rather than flattening the sheet to an 8-bit raster.
        let mut owned_picture_mask = BinaryImage::new(gray.width(), gray.height());
        for y in 40..90 {
            for x in 250..330 {
                owned_picture_mask.set(x, y, true);
            }
        }
        let recommendation = recommend_output_mode_with_tone(
            PreparedModeEvidence {
                analysis: &gray,
                analysis_rgb: None,
                picture_mask: &owned_picture_mask,
                picture_tone_evidence: true,
                text_line_count: 8,
            },
            outside_tone,
        );
        assert_eq!(recommendation.mode, OutputMode::Mixed, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::TextWithPictures
        );
        assert!(recommendation.diagnostics.destructive_mode_tonal_veto);

        // Without detector ownership the same tone evidence must NOT promote:
        // verso show-through measures as coherent gray outside every text
        // line on plain text pages, and a promoted page would publish a
        // Mixed manifest that owns no tone at all.
        let empty_picture_mask = BinaryImage::new(gray.width(), gray.height());
        let unowned = recommend_output_mode_with_tone(
            PreparedModeEvidence {
                analysis: &gray,
                analysis_rgb: None,
                picture_mask: &empty_picture_mask,
                picture_tone_evidence: false,
                text_line_count: 8,
            },
            outside_tone,
        );
        assert_eq!(unowned.mode, OutputMode::Bw, "{unowned:?}");
        assert_eq!(unowned.reason, OutputModeRecommendationReason::BimodalText);
        assert_eq!(unowned.diagnostics.picture_fraction, 0.0);
        assert!(!unowned.diagnostics.significant_picture);

        // The old SpatialTone second opinion promoted this same sub-floor
        // owner whenever outside-text tone was coherent. That path is gone:
        // without corroboration the legacy 1.2% floor still protects a text
        // page from a tape patch, stain, or distributed show-through.
        let mut subfloor_picture_mask = BinaryImage::new(gray.width(), gray.height());
        for y in 40..70 {
            for x in 250..274 {
                subfloor_picture_mask.set(x, y, true);
            }
        }
        let subfloor_unconfirmed = recommend_output_mode_with_tone(
            PreparedModeEvidence {
                analysis: &gray,
                analysis_rgb: None,
                picture_mask: &subfloor_picture_mask,
                picture_tone_evidence: false,
                text_line_count: 8,
            },
            outside_tone,
        );
        assert_eq!(
            subfloor_unconfirmed.mode,
            OutputMode::Bw,
            "outside tone must not revive the deleted second mode owner: {subfloor_unconfirmed:?}"
        );
        assert!(!subfloor_unconfirmed.diagnostics.significant_picture);
    }

    fn protected_text_block(
        width: usize,
        height: usize,
        picture_overlap: usize,
    ) -> ContentBlockEvidence {
        ContentBlockEvidence {
            bounds: crate::protocol::manifest_v3::ContentDiagnosticRect {
                x_px: 12,
                y_px: 18,
                width_px: width,
                height_px: height,
            },
            picture_mask_overlap_pixels: picture_overlap,
            heading_evidence: false,
            grayscale_evidence: false,
            text_evidence: true,
        }
    }

    #[test]
    fn broad_outside_tone_does_not_exempt_contradictory_mixed_ownership() {
        let photographed_field = crate::text_tone::OutsideTonalEvidence {
            fraction: 0.34,
            largest_component_fraction: 0.12,
            largest_component_width_fraction: 0.28,
            largest_component_height_fraction: 0.59,
        };
        assert!(!qualifies_independent_outside_tone(photographed_field));

        let localized_tone = crate::text_tone::OutsideTonalEvidence {
            fraction: 0.025,
            largest_component_fraction: 0.02,
            largest_component_width_fraction: 0.12,
            largest_component_height_fraction: 0.10,
        };
        assert!(qualifies_independent_outside_tone(localized_tone));
    }

    #[test]
    fn auto_mixed_veto_falls_back_for_camera_paper_and_red_cloth() {
        let (_, mut rgb) = text_page([245; 3]);
        // A narrow red cloth strip supplies chroma, while the oversized
        // detector mask incorrectly claims the printed block below it.
        for y in 0..42 {
            for x in 0..36 {
                rgb.set(x, y, [128, 18, 24]);
            }
        }
        let gray = rgb_to_gray(&rgb);
        let mut picture_mask = BinaryImage::new(gray.width(), gray.height());
        for y in 18..238 {
            for x in 12..340 {
                picture_mask.set(x, y, true);
            }
        }
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: Some(&rgb),
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 8,
        });
        assert_eq!(recommendation.mode, OutputMode::Mixed, "{recommendation:?}");
        assert!(recommendation.diagnostics.significant_color);

        let vetoed = veto_contradictory_mixed_ownership(
            recommendation,
            true,
            &[protected_text_block(328, 220, 328 * 220)],
            false,
        );
        assert_eq!(vetoed.mode, OutputMode::Color, "{vetoed:?}");
        assert!(vetoed.diagnostics.mixed_ownership_veto);
        assert_eq!(vetoed.diagnostics.protected_text_block_count, 1);
        assert_eq!(
            vetoed
                .diagnostics
                .protected_text_block_picture_overlap_pixels,
            328 * 220
        );
        assert_eq!(
            vetoed
                .diagnostics
                .protected_text_block_picture_overlap_fraction,
            1.0
        );
    }

    #[test]
    fn auto_mixed_veto_falls_back_to_grayscale_without_color_evidence() {
        let (gray, _) = text_page([205; 3]);
        let mut picture_mask = BinaryImage::new(gray.width(), gray.height());
        for y in 18..158 {
            for x in 12..340 {
                picture_mask.set(x, y, true);
            }
        }
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 8,
        });
        assert_eq!(recommendation.mode, OutputMode::Mixed, "{recommendation:?}");
        assert!(!recommendation.diagnostics.significant_color);

        let vetoed = veto_contradictory_mixed_ownership(
            recommendation,
            true,
            &[protected_text_block(328, 140, 328 * 140)],
            false,
        );
        assert_eq!(vetoed.mode, OutputMode::Grayscale, "{vetoed:?}");
        assert!(vetoed.diagnostics.mixed_ownership_veto);
        assert_eq!(
            vetoed.reason,
            OutputModeRecommendationReason::UncertainTonal
        );
    }

    #[test]
    fn independent_picture_evidence_preserves_genuine_auto_mixed() {
        let (gray, _) = text_page([245; 3]);
        let mut picture_mask = BinaryImage::new(gray.width(), gray.height());
        for y in 40..130 {
            for x in 230..340 {
                picture_mask.set(x, y, true);
            }
        }
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: true,
            text_line_count: 8,
        });
        assert_eq!(recommendation.mode, OutputMode::Mixed, "{recommendation:?}");
        let preserved = veto_contradictory_mixed_ownership(
            recommendation,
            true,
            &[protected_text_block(328, 220, 328 * 220)],
            true,
        );
        assert_eq!(preserved.mode, OutputMode::Mixed, "{preserved:?}");
        assert!(!preserved.diagnostics.mixed_ownership_veto);
        assert!(
            preserved
                .diagnostics
                .mixed_ownership_independent_picture_evidence
        );

        let explicit_mode = veto_contradictory_mixed_ownership(
            recommendation,
            false,
            &[protected_text_block(328, 220, 328 * 220)],
            false,
        );
        assert_eq!(explicit_mode.mode, OutputMode::Mixed, "{explicit_mode:?}");
        assert!(!explicit_mode.diagnostics.mixed_ownership_veto);
    }

    #[test]
    fn photo_dominant_page_stays_semantically_mixed() {
        let (mut gray, _) = text_page([245; 3]);
        for y in 92..242 {
            for x in 190..350 {
                gray.set(x, y, synthetic_photo_value(x, y));
            }
        }
        let recommendation = classify(&gray, None);
        assert_eq!(recommendation.mode, OutputMode::Mixed, "{recommendation:?}");
        assert!(
            recommendation.diagnostics.picture_fraction >= PICTURE_NOISE_FLOOR,
            "{recommendation:?}"
        );
    }

    #[test]
    fn color_plate_with_caption_routes_to_mixed_while_a_color_cover_stays_color() {
        let (_, mut plate_page) = text_page([245; 3]);
        for y in 125..235 {
            for x in 225..345 {
                let base = synthetic_photo_value(x, y);
                let red = base;
                let green = base.saturating_sub(20);
                let blue = base.saturating_add(35);
                plate_page.set(x, y, [red, green, blue]);
            }
        }
        let plate_recommendation = classify(&rgb_to_gray(&plate_page), Some(&plate_page));
        report("color-plate-with-caption", plate_recommendation);
        assert_eq!(
            plate_recommendation.mode,
            OutputMode::Mixed,
            "{plate_recommendation:?}"
        );
        assert_eq!(
            plate_recommendation.reason,
            OutputModeRecommendationReason::TextWithPictures
        );

        let mut dominant_plate = RgbImage::new(360, 260, [242; 3]);
        let mut dominant_picture_mask = BinaryImage::new(360, 260);
        for y in 30..230 {
            for x in 60..300 {
                let colors = [[190, 35, 55], [35, 100, 205], [35, 155, 80], [225, 150, 30]];
                dominant_plate.set(x, y, colors[(x / 40 + y / 40) % colors.len()]);
                dominant_picture_mask.set(x, y, true);
            }
        }
        let dominant_gray = rgb_to_gray(&dominant_plate);
        let dominant_recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &dominant_gray,
            analysis_rgb: Some(&dominant_plate),
            picture_mask: &dominant_picture_mask,
            picture_tone_evidence: true,
            text_line_count: 4,
        });
        assert_eq!(
            dominant_recommendation.mode,
            OutputMode::Color,
            "{dominant_recommendation:?}"
        );

        let mut cover = RgbImage::new(360, 260, [28, 74, 132]);
        for y in 0..cover.height() {
            for x in 0..cover.width() {
                cover.set(
                    x,
                    y,
                    [
                        20 + ((x * 5 + y * 3) % 210) as u8,
                        35 + ((x * 7 + y * 11) % 180) as u8,
                        45 + ((x * 13 + y * 17) % 170) as u8,
                    ],
                );
            }
        }
        let cover_recommendation = classify(&rgb_to_gray(&cover), Some(&cover));
        report("pure-color-cover", cover_recommendation);
        assert_eq!(
            cover_recommendation.mode,
            OutputMode::Color,
            "{cover_recommendation:?}"
        );
        assert_eq!(
            cover_recommendation.reason,
            OutputModeRecommendationReason::ColorChroma
        );
    }

    #[test]
    fn tinted_camera_text_without_picture_owner_stays_color() {
        let (_, mut rgb) = text_page([245, 228, 214]);
        // Camera-bed color is real chroma, but it is attached to the raster
        // edge and disappears when the page crop is applied.
        for y in 0..rgb.height() {
            for x in 0..18 {
                rgb.set(x, y, [128, 18, 24]);
            }
        }
        let gray = rgb_to_gray(&rgb);
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: Some(&rgb),
            picture_mask: &BinaryImage::new(gray.width(), gray.height()),
            picture_tone_evidence: false,
            text_line_count: 8,
        });
        assert_eq!(
            recommendation.mode,
            OutputMode::Color,
            "paper tint must not manufacture a Mixed bilevel foreground: {recommendation:?}"
        );
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::ColorChroma
        );
        assert!(!recommendation.diagnostics.significant_picture);
    }

    #[test]
    fn dark_textured_cover_with_a_small_barcode_sticker_stays_color() {
        let mut cover = RgbImage::new(360, 260, [62, 16, 12]);
        for y in 0..cover.height() {
            for x in 0..cover.width() {
                let texture = ((x * 17 + y * 29 + x * y % 31) % 26) as u8;
                cover.set(
                    x,
                    y,
                    [
                        52_u8.saturating_add(texture),
                        12_u8.saturating_add(texture / 3),
                        9_u8.saturating_add(texture / 5),
                    ],
                );
            }
        }
        for y in 205..252 {
            for x in 120..300 {
                cover.set(x, y, [194, 181, 151]);
            }
        }
        for stripe in 0..24 {
            let left = 145 + stripe * 5;
            let width = 1 + stripe % 2;
            for y in 220..238 {
                for x in left..left + width {
                    cover.set(x, y, [32, 28, 24]);
                }
            }
        }
        let gray = rgb_to_gray(&cover);
        let picture_mask = BinaryImage::new(gray.width(), gray.height());
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: Some(&cover),
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 2,
        });
        report("dark-textured-cover-with-sticker", recommendation);
        assert!(
            recommendation.diagnostics.ink_fraction > COLOR_TEXT_MAX_INK_FRACTION,
            "{recommendation:?}",
        );
        assert!(
            recommendation.diagnostics.significant_color,
            "{recommendation:?}",
        );
        assert_eq!(recommendation.mode, OutputMode::Color, "{recommendation:?}",);
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::ColorChroma,
        );
    }

    #[test]
    fn scanner_edge_bars_and_gutter_shadow_do_not_veto_bw() {
        let (_, half_page) = text_page([245; 3]);
        let mut rgb = RgbImage::new(760, 300, [245; 3]);
        for y in 0..half_page.height() {
            for x in 0..half_page.width() {
                rgb.set(x + 10, y + 20, half_page.get(x, y));
                rgb.set(x + 390, y + 20, half_page.get(x, y));
            }
        }
        for y in 0..rgb.height() {
            for x in 0..10 {
                rgb.set(x, y, [18; 3]);
                rgb.set(rgb.width() - 1 - x, y, [18; 3]);
            }
            for x in 370_usize..390 {
                let distance = x.abs_diff(379).min(8) as u8;
                let texture = ((x * 17 + y * 29 + x * y % 31) % 28) as u8;
                let value = 34_u8
                    .saturating_add(distance.saturating_mul(12))
                    .saturating_add(texture);
                rgb.set(x, y, [value; 3]);
            }
        }
        let gray = rgb_to_gray(&rgb);
        let calibration = PageCalibration::estimate(&gray, 150.0, CalibrationConfig::default());
        let raw_picture_mask = detect_picture_mask(&gray, 150.0, calibration);
        let raw_picture_pixels = ComponentMap::from_binary(&raw_picture_mask)
            .components()
            .iter()
            .filter(|component| component.area >= MIN_PICTURE_COMPONENT_PIXELS)
            .map(|component| component.area)
            .sum::<usize>();
        // The vetted owner now rejects the synthetic scanner rails and
        // gutter before mode selection; this fixture must not manufacture a
        // picture fraction merely to exercise the old second opinion.
        assert!(
            (raw_picture_pixels as f64 / gray.width().saturating_mul(gray.height()) as f64)
                < PICTURE_NOISE_FLOOR,
            "artifact-only rails must stay below the picture floor: pixels={raw_picture_pixels}"
        );

        let recommendation = classify(&gray, Some(&rgb));
        report("scanner-border-and-gutter", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Bw, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::BimodalText
        );
    }

    #[test]
    fn full_page_halftone_plate_touching_edges_stays_tonal() {
        let mut gray = GrayImage::new(360, 260, 238);
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                let coarse_tone = 28 + (x * 176 / gray.width()) as u8;
                let irregular_screen = ((x * 17 + y * 29 + x * y % 53) % 45) as u8;
                gray.set(x, y, coarse_tone.saturating_add(irregular_screen));
            }
        }
        let mut picture_mask = BinaryImage::new(gray.width(), gray.height());
        for y in 0..picture_mask.height() {
            for x in 0..picture_mask.width() {
                picture_mask.set(x, y, true);
            }
        }
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: true,
            text_line_count: 0,
        });
        report("full-page-edge-halftone", recommendation);
        assert_eq!(
            recommendation.mode,
            OutputMode::Grayscale,
            "{recommendation:?}"
        );
    }

    #[test]
    fn aggregate_of_many_small_picture_components_vetoes_bw() {
        let (small_gray, _) = text_page([245; 3]);
        let mut gray = GrayImage::new(1_240, 1_754, 245);
        for y in 0..small_gray.height() {
            for x in 0..small_gray.width() {
                gray.set(x + 40, y + 40, small_gray.get(x, y));
            }
        }
        let mut picture_mask = BinaryImage::new(gray.width(), gray.height());
        for thumbnail in 0..7 {
            let left = 80 + (thumbnail % 4) * 260;
            let top = 520 + (thumbnail / 4) * 260;
            for y in top..top + 80 {
                for x in left..left + 50 {
                    picture_mask.set(x, y, true);
                }
            }
        }
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: true,
            text_line_count: 8,
        });
        report("many-small-pictures", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Mixed, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::TextWithPictures
        );
    }

    #[test]
    fn dense_bleed_through_text_trades_line_evidence_for_weaker_bimodality() {
        let mut gray = GrayImage::new(360, 260, 210);
        for y in 0..gray.height() {
            for x in 0..gray.width() / 2 {
                gray.set(x, y, 180);
            }
        }
        for line in 0..8 {
            let value = if line % 2 == 0 { 20 } else { 90 };
            let top = 18 + line * 28;
            for y in top..top + 2 {
                for x in 20..260 {
                    gray.set(x, y, value);
                }
            }
        }
        let picture_mask = BinaryImage::new(gray.width(), gray.height());
        let luminance = luminance_evidence(&gray);
        assert!(
            (DENSE_TEXT_BIMODALITY + BIMODALITY_HYSTERESIS
                ..STRONG_BIMODALITY + BIMODALITY_HYSTERESIS)
                .contains(&luminance.bimodality),
            "{luminance:?}"
        );
        assert!(
            luminance.mode_distance >= DENSE_TEXT_MODE_DISTANCE + LUMINANCE_DISTANCE_HYSTERESIS,
            "{luminance:?}"
        );
        assert!(
            luminance.midtone_fraction <= DENSE_TEXT_MAX_MIDTONE_FRACTION - MIDTONE_HYSTERESIS,
            "{luminance:?}"
        );

        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 8,
        });
        assert_eq!(recommendation.mode, OutputMode::Bw, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::BimodalText
        );
        assert!(
            (0.7..=0.8).contains(&recommendation.confidence),
            "{recommendation:?}"
        );

        let mut low_contrast = gray.clone();
        for value in low_contrast.data_mut() {
            if *value <= 90 {
                *value = 155;
            }
        }
        let low_contrast_recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &low_contrast,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 8,
        });
        assert_eq!(
            low_contrast_recommendation.mode,
            OutputMode::Grayscale,
            "{low_contrast_recommendation:?}"
        );

        let mut tonal = gray.clone();
        for y in 0..tonal.height() / 2 {
            for x in 0..tonal.width() {
                tonal.set(x, y, 110 + (x % 70) as u8);
            }
        }
        let tonal_evidence = luminance_evidence(&tonal);
        assert!(
            tonal_evidence.midtone_fraction > DENSE_TEXT_MAX_MIDTONE_FRACTION - MIDTONE_HYSTERESIS,
            "{tonal_evidence:?}"
        );
        let tonal_recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &tonal,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 8,
        });
        assert_eq!(
            tonal_recommendation.mode,
            OutputMode::Grayscale,
            "{tonal_recommendation:?}"
        );
    }

    #[test]
    fn one_detected_line_needs_exceptionally_strong_text_evidence() {
        let (gray, _) = text_page([245; 3]);
        let picture_mask = BinaryImage::new(gray.width(), gray.height());
        let recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 1,
        });
        report("strong-single-line-text", recommendation);
        assert_eq!(recommendation.mode, OutputMode::Bw, "{recommendation:?}");
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::BimodalText
        );
        assert!(
            (0.62..=0.7).contains(&recommendation.confidence),
            "{recommendation:?}"
        );

        let no_line_recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &gray,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 0,
        });
        assert_eq!(
            no_line_recommendation.mode,
            OutputMode::Grayscale,
            "{no_line_recommendation:?}"
        );

        let mut faint = gray.clone();
        for value in faint.data_mut() {
            if *value < 230 {
                *value = 215;
            }
        }
        let faint_recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &faint,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 1,
        });
        assert_eq!(
            faint_recommendation.mode,
            OutputMode::Grayscale,
            "{faint_recommendation:?}"
        );

        let mut sparse = GrayImage::new(gray.width(), gray.height(), 245);
        for mark in 0..20 {
            let left = 12 + mark * 17;
            for y in 120..135 {
                for x in left..left + 2 {
                    sparse.set(x, y, 35);
                }
            }
        }
        let sparse_recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &sparse,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 1,
        });
        assert_eq!(
            sparse_recommendation.mode,
            OutputMode::Bw,
            "{sparse_recommendation:?}"
        );
        assert_eq!(
            sparse_recommendation.reason,
            OutputModeRecommendationReason::BimodalText
        );

        let mut solid_blob = GrayImage::new(gray.width(), gray.height(), 245);
        for y in 40..220 {
            for x in 40..320 {
                solid_blob.set(x, y, 35);
            }
        }
        let blob_recommendation = recommend_output_mode(PreparedModeEvidence {
            analysis: &solid_blob,
            analysis_rgb: None,
            picture_mask: &picture_mask,
            picture_tone_evidence: false,
            text_line_count: 1,
        });
        assert_eq!(
            blob_recommendation.mode,
            OutputMode::Grayscale,
            "{blob_recommendation:?}"
        );
    }

    #[test]
    fn faint_pencil_text_is_grayscale_despite_bimodality() {
        let (mut gray, _) = text_page([235; 3]);
        for value in gray.data_mut() {
            if *value < 230 {
                *value = 215;
            }
        }
        let recommendation = classify(&gray, None);
        report("faint-pencil", recommendation);
        assert_eq!(
            recommendation.mode,
            OutputMode::Grayscale,
            "{recommendation:?}"
        );
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::UncertainTonal
        );
    }

    #[test]
    fn textless_halftone_page_is_grayscale_not_mixed() {
        let mut gray = GrayImage::new(360, 260, 238);
        for y in 25..235 {
            for x in 30..330 {
                let cell = (x / 4 + y / 4) % 7;
                if x % 4 < 1 + cell % 2 && y % 4 < 1 + (cell / 2) % 2 {
                    gray.set(x, y, 35 + (cell * 18) as u8);
                }
            }
        }
        let recommendation = classify(&gray, None);
        report("halftone", recommendation);
        assert_eq!(
            recommendation.mode,
            OutputMode::Grayscale,
            "{recommendation:?}"
        );
        assert_eq!(
            recommendation.reason,
            OutputModeRecommendationReason::UncertainTonal
        );
    }
}
