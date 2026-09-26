use crate::{
    analysis::build_analysis_level,
    deskew::{detect_skew, score_skew},
    protocol::manifest_v3::SplitSeamPolyline,
    LayoutMode,
};
use scan_primitives::{
    morphology::{open, reconstruct_binary},
    threshold::{otsu_threshold, threshold_global},
    Affine, BinaryImage, ComponentMap, GrayImage, Point, Polygon,
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::sync::OnceLock;

pub(crate) const SPLIT_ANALYSIS_DPI: f64 = 150.0;
const MAX_EVIDENCE_DISAGREEMENT: f64 = 0.04;
const MAX_OFFCUT_WIDTH_FRACTION: f64 = 0.30;
const MAX_UNANCHORED_OFFCUT_WIDTH_FRACTION: f64 = 0.18;
const MIN_CUTTER_ANGLE_DEGREES: f64 = -7.0;
const MAX_CUTTER_ANGLE_DEGREES: f64 = 7.0;
const CUTTER_ANGLE_STEP_DEGREES: f64 = 0.5;
const TOP_CUTTER_CANDIDATES: usize = 8;
const TOP_DESKEW_CANDIDATE_GROUPS: usize = 2;
const CURVED_SEAM_BAND_WIDTH_FRACTION: f64 = 0.015;
/// What a fully saturated fold is worth on its own in [`bilateral_page_score`],
/// chosen to clear that score's 0.08 gate and nothing more: the two leaves of a
/// folded sheet are proven separate by the fold itself, so the bilateral test
/// must stop asking them to look equally printed.
const FOLDED_SHEET_BILATERAL_FLOOR: f64 = 0.10;
const MAX_GUTTER_BAND_FRACTION: f64 = 0.03;
const MAX_OFFSET_GUTTER_BAND_FRACTION: f64 = 0.08;
const MIN_GUTTER_BAND_DEPRESSION: f64 = 6.0;
const GUTTER_BAND_PAPER_ROW_SHARE: f64 = 0.10;
const GUTTER_BAND_INK_ROW_SHARE: f64 = 0.10;
const GUTTER_BAND_MAX_COLUMN_CONTRAST: f64 = 60.0;
// Keep the ordinary bilateral min() policy as the default. The recovery lane
// below is deliberately much stricter and can only repair one contaminated
// outer edge when the other local evidence is saturated.
const OUTER_MARGIN_STANDARD_FLOOR: f64 = 0.02;
const OUTER_MARGIN_RECOVERY_STRONG_EDGE: f64 = 0.20;
const OUTER_MARGIN_RECOVERY_BILATERAL: f64 = 0.20;
const OUTER_MARGIN_RECOVERY_PAGE_SCORE: f64 = 0.20;
const OUTER_MARGIN_RECOVERY_SURFACE_SCORE: f64 = 0.15;
const OUTER_MARGIN_RECOVERY_GUTTER: f64 = 0.55;
const OUTER_MARGIN_RECOVERY_AGREEMENT: f64 = 0.90;
const OUTER_MARGIN_RECOVERY_ASPECT: f64 = 0.35;
const OUTER_MARGIN_RECOVERY_MIN_SIDE_FRACTION: f64 = 0.34;
const FOLD_SUPPORT_MAX_COLUMN_FRACTION: f64 = 0.60;
const FOLD_SUPPORT_MAX_COMPONENT_WIDTH_FRACTION: f64 = 0.03;
const FOLD_SUPPORT_MAX_COMPONENT_HEIGHT_FRACTION: f64 = 0.12;
const FOLD_SUPPORT_MAX_COMPONENT_AREA_FRACTION: f64 = 0.003;
const FOLD_SUPPORT_AMBIGUOUS_FILL: f64 = 0.20;
const FOLD_SUPPORT_MIN_REPEATED_ROWS: usize = 3;
const FOLD_SUPPORT_PIXEL_CONTRAST: f64 = 24.0;
// A broad connected run inside the fold corridor is scanner texture, even
// when thresholding fragments it into many small components. Real glyph rows
// stay short relative to the page height.
const FOLD_SUPPORT_MAX_ROW_HEIGHT_FRACTION: f64 = 0.05;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum LayoutClassification {
    SingleUncutPage,
    PageWithOffcut,
    TwoPageSpread,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum OuterMarginSide {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClusterDimensions {
    #[serde(rename = "widthPx")]
    pub width: f64,
    #[serde(rename = "heightPx")]
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentPrior {
    pub dominant_layout: LayoutClassification,
    pub cutter_ratio_median: Option<f64>,
    pub cluster_dims: ClusterDimensions,
    pub agreement_strength: f64,
    /// Robust document-level body-text calibration, measured in the analysis
    /// raster's effective-DPI pixels. These anchors let a spread share one
    /// threshold scale without making a noisy leaf's local estimate the
    /// document policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_width_median_px: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_height_median_px: Option<f64>,
}

impl DocumentPrior {
    pub fn validate(self) -> Result<(), String> {
        if !self.cluster_dims.width.is_finite()
            || !self.cluster_dims.height.is_finite()
            || self.cluster_dims.width <= 0.0
            || self.cluster_dims.height <= 0.0
        {
            return Err("Document prior cluster dimensions must be positive and finite".into());
        }
        if !self.agreement_strength.is_finite() || !(0.0..=1.0).contains(&self.agreement_strength) {
            return Err("Document prior agreement strength must be within 0..=1".into());
        }
        for (value, label) in [
            (self.stroke_width_median_px, "stroke width"),
            (self.x_height_median_px, "x-height"),
        ] {
            if value.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                return Err(format!(
                    "Document prior {label} median must be positive and finite"
                ));
            }
        }
        if self
            .cutter_ratio_median
            .is_some_and(|ratio| !ratio.is_finite() || !(0.20..=0.80).contains(&ratio))
        {
            return Err("Document prior cutter ratio must be within 0.20..=0.80".into());
        }
        if self.dominant_layout == LayoutClassification::TwoPageSpread
            && self.cutter_ratio_median.is_none()
        {
            return Err("A spread document prior requires a cutter ratio".into());
        }
        Ok(())
    }

    pub(crate) fn applies_to_dimensions(self, width: usize, height: usize) -> bool {
        self.validate().is_ok()
            && dimension_matches(width, self.cluster_dims.width)
            && dimension_matches(height, self.cluster_dims.height)
    }

    pub(crate) fn with_cluster_dimensions(mut self, width: usize, height: usize) -> Self {
        self.cluster_dims = ClusterDimensions {
            width: width as f64,
            height: height as f64,
        };
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationMetadata {
    pub tier1_verdict: LayoutClassification,
    pub reconciled: bool,
    pub cluster_agreement: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayoutDecision {
    pub classification: LayoutClassification,
    pub confidence: f64,
    pub cutter_x: Option<f64>,
    pub reconciliation: ReconciliationMetadata,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum FoldBandUnmeasuredReason {
    NotApplicable,
    NoFoldEvidence,
    FoldEvidenceUnquantified,
    CutterInvalidated,
    MeasurementUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum FoldBand {
    Measured {
        left_x_px: f64,
        right_x_px: f64,
    },
    Unmeasured {
        reason: FoldBandUnmeasuredReason,
        nominal_half_width_px: f64,
    },
}

impl Default for FoldBand {
    fn default() -> Self {
        Self::unmeasured(FoldBandUnmeasuredReason::NotApplicable)
    }
}

impl FoldBand {
    pub(crate) fn measured(left_x_px: f64, right_x_px: f64) -> Self {
        Self::Measured {
            left_x_px,
            right_x_px,
        }
    }

    pub(crate) fn unmeasured(reason: FoldBandUnmeasuredReason) -> Self {
        Self::Unmeasured {
            reason,
            nominal_half_width_px: 0.0,
        }
    }

    fn unquantified_evidence() -> Self {
        Self::unmeasured(FoldBandUnmeasuredReason::FoldEvidenceUnquantified)
    }

    pub(crate) fn edges(self, cutter_x: f64, width: usize) -> (f64, f64) {
        let maximum = width as f64;
        let cutter_x = cutter_x.clamp(0.0, maximum);
        match self {
            Self::Measured {
                left_x_px,
                right_x_px,
            } => (
                left_x_px.clamp(0.0, cutter_x),
                right_x_px.clamp(cutter_x, maximum),
            ),
            Self::Unmeasured { .. } => (cutter_x, cutter_x),
        }
    }

    pub(crate) fn has_suppression(self, cutter_x: f64) -> bool {
        match self {
            Self::Measured {
                left_x_px,
                right_x_px,
            } => left_x_px < cutter_x - 0.5 || right_x_px > cutter_x + 0.5,
            Self::Unmeasured { .. } => false,
        }
    }

    pub(crate) fn needs_raw_remeasurement(self, cutter_x: f64) -> bool {
        match self {
            Self::Measured {
                left_x_px,
                right_x_px,
            } => left_x_px >= cutter_x - 0.5 || right_x_px <= cutter_x + 0.5,
            Self::Unmeasured { .. } => true,
        }
    }

    pub(crate) fn scale_x(&mut self, scale_x: f64, full_width: usize) {
        match self {
            Self::Measured {
                left_x_px,
                right_x_px,
            } => {
                *left_x_px = (*left_x_px / scale_x).clamp(0.0, full_width as f64);
                *right_x_px = (*right_x_px / scale_x).clamp(0.0, full_width as f64);
            }
            Self::Unmeasured {
                nominal_half_width_px,
                ..
            } => {
                *nominal_half_width_px =
                    (*nominal_half_width_px / scale_x).clamp(0.0, full_width as f64);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SplitDiagnostics {
    pub fold_band: FoldBand,
    pub analysis_dpi: f64,
    pub deskew_angle_degrees: f64,
    pub deskew_confidence: f64,
    pub cutter_slope: f64,
    pub left_deskew_angle_degrees: f64,
    pub right_deskew_angle_degrees: f64,
    pub left_deskew_confidence: f64,
    pub right_deskew_confidence: f64,
    pub whitespace_x: f64,
    pub fold_x: f64,
    pub decision_x: f64,
    pub whitespace_score: f64,
    pub bilateral_score: f64,
    pub left_page_score: f64,
    pub right_page_score: f64,
    pub left_content_score: f64,
    pub right_content_score: f64,
    pub left_surface_score: f64,
    pub right_surface_score: f64,
    pub left_ink_pixels: usize,
    pub right_ink_pixels: usize,
    pub left_outer_margin_score: f64,
    pub right_outer_margin_score: f64,
    pub outer_margin_score: f64,
    pub gutter_score: f64,
    pub agreement_score: f64,
    pub fold_score: f64,
    pub gutter_darkness_score: f64,
    pub soft_gutter_score: f64,
    pub soft_gutter_coverage: f64,
    pub soft_gutter_continuity: f64,
    pub soft_gutter_mean_depression: f64,
    pub sparse_gutter_score: f64,
    pub sparse_gutter_coverage: f64,
    pub sparse_gutter_continuity: f64,
    pub sparse_gutter_mean_depression: f64,
    pub aspect_ratio: f64,
    pub aspect_spread_score: f64,
    pub aspect_single_score: f64,
    pub independent_spread_cues: usize,
    pub offcut_boundary_score: f64,
    pub offcut_empty_score: f64,
    pub offcut_populated_score: f64,
    pub offcut_width_score: f64,
    pub offcut_no_text_rows_score: f64,
    pub alternative_product: f64,
    pub evidence_product: f64,
    pub whitespace_gate_passed: bool,
    pub central_position_gate_passed: bool,
    pub bilateral_gate_passed: bool,
    pub outer_margin_gate_passed: bool,
    pub gutter_gate_passed: bool,
    pub independent_gutter_gate_passed: bool,
    pub aspect_support_gate_passed: bool,
    pub evidence_agreement_gate_passed: bool,
    pub outer_margin_recovery: bool,
    pub outer_margin_weak_edge: Option<OuterMarginSide>,
    pub sparse_spread_recovered: bool,
    pub abstained: bool,
}

#[derive(Clone, Debug)]
pub struct SplitResult {
    pub classification: LayoutClassification,
    pub confidence: f64,
    /// Where the right leaf begins, and the only leaf edge that survives the
    /// analyze-to-clean handoff.
    pub cutter_x: Option<f64>,
    pub pages: Vec<Polygon>,
    pub split_seam: Option<SplitSeamPolyline>,
    pub diagnostics: SplitDiagnostics,
    pub reconciliation: ReconciliationMetadata,
    pub(crate) reusable_binary: Option<BinaryImage>,
}

impl SplitResult {
    /// Re-measure a split against the full-resolution raw source. This keeps
    /// the conservative shadow test at the same physical cap even when layout
    /// illumination has flattened the fold ramp at analysis resolution.
    pub(crate) fn remeasure_gutter_band_from_source(
        &mut self,
        gray: &GrayImage,
        output_width: usize,
        output_height: usize,
    ) {
        let band = self
            .cutter_x
            .filter(|_| self.classification == LayoutClassification::TwoPageSpread)
            .and_then(|cutter| gutter_shadow_band(gray, cutter));
        if let Some((left, right)) = band {
            self.diagnostics.fold_band = FoldBand::measured(left, right);
            self.pages = match self.cutter_x {
                Some(cutter) => leaf_polygons(
                    output_width,
                    output_height,
                    cutter,
                    self.diagnostics.fold_band,
                ),
                None => vec![page_polygon(0.0, output_width as f64, output_height)],
            };
        }
    }

    pub(crate) fn apply_document_prior(
        &mut self,
        width: usize,
        height: usize,
        prior: DocumentPrior,
    ) {
        let candidate_ratio = (self.diagnostics.decision_x > 0.0)
            .then_some(self.diagnostics.decision_x / width.max(1) as f64);
        let decision = reconcile_layout_decision(
            self.classification,
            self.confidence,
            self.cutter_x,
            candidate_ratio,
            self.diagnostics.whitespace_score,
            width,
            height,
            prior,
        );
        let previous_cutter = self.cutter_x;
        self.classification = decision.classification;
        self.confidence = decision.confidence;
        self.cutter_x = decision.cutter_x;
        self.reconciliation = decision.reconciliation;
        self.diagnostics.evidence_product = decision.confidence;
        // A shadow measured for one cutter says nothing about a different one,
        // and a prior-forced split never observed a fold shadow at all. Carry
        // both sides as one evidence decision so a prior cannot leave an
        // asymmetric band behind.
        if decision.cutter_x != previous_cutter {
            self.diagnostics.fold_band =
                FoldBand::unmeasured(FoldBandUnmeasuredReason::CutterInvalidated);
        }
        self.pages = match decision.cutter_x {
            Some(cutter) => leaf_polygons(width, height, cutter, self.diagnostics.fold_band),
            None => vec![page_polygon(0.0, width as f64, height)],
        };
        if decision.classification != LayoutClassification::TwoPageSpread {
            self.split_seam = None;
        }
    }

    /// A lossy analysis level may still prove a spread from independent bilateral
    /// evidence, but it must not authorize destructive edge removal. Preserve
    /// the analysis diagnostics while converting that uncertain offcut to the
    /// classifier's normal fail-closed single-page result.
    pub(crate) fn abstain_from_resolution_limited_offcut(&mut self) {
        if self.classification != LayoutClassification::PageWithOffcut {
            return;
        }
        // A reduced raster is still authoritative when it resolved a strong
        // vertical boundary and independently proved that the narrow side is
        // not a peer page. This is the stable case the 150-DPI analysis level
        // was built to preserve; abstention remains mandatory for incomplete
        // or contradictory offcut evidence.
        if self.diagnostics.offcut_boundary_score >= 0.80
            && self.diagnostics.offcut_empty_score >= 0.95
            && self.diagnostics.offcut_width_score > 0.0
            && self.diagnostics.offcut_no_text_rows_score >= 0.90
        {
            return;
        }
        self.diagnostics.abstained = true;
        self.diagnostics.alternative_product = self.diagnostics.evidence_product;
        self.confidence = single_confidence(&self.diagnostics);
        self.diagnostics.evidence_product = self.confidence;
        self.classification = LayoutClassification::SingleUncutPage;
        self.reconciliation.tier1_verdict = LayoutClassification::SingleUncutPage;
        self.cutter_x = None;
        self.diagnostics.fold_band = FoldBand::unmeasured(FoldBandUnmeasuredReason::NotApplicable);
        let width = self
            .pages
            .iter()
            .flat_map(|page| page.points.iter())
            .map(|point| point.x)
            .fold(0.0, f64::max);
        let height = self
            .pages
            .iter()
            .flat_map(|page| page.points.iter())
            .map(|point| point.y)
            .fold(0.0, f64::max);
        self.pages = vec![page_polygon(0.0, width, height.ceil() as usize)];
        self.split_seam = None;
    }
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    x: f64,
    score: f64,
    start: usize,
    end: usize,
}

#[derive(Clone, Copy, Debug, Default)]
struct FoldCandidate {
    x: f64,
    slope: f64,
    score: f64,
    vertical_coverage: f64,
    left_deskew_angle_degrees: f64,
    right_deskew_angle_degrees: f64,
    left_deskew_confidence: f64,
    right_deskew_confidence: f64,
    joint_deskew_score: f64,
}

/// Column statistics the gutter band reads: `bright` and `dark` are the
/// luminance quantiles that separate a uniformly shadowed column from one that
/// carries ink over visible paper.
#[derive(Clone, Copy, Debug, Default)]
struct ColumnProfile {
    mean: f64,
    bright: f64,
    dark: f64,
}

#[derive(Clone, Copy, Debug, Default)]
struct SoftGutterCandidate {
    x: f64,
    score: f64,
    vertical_coverage: f64,
    continuity: f64,
    mean_depression: f64,
}

struct AnalysisImage<'a> {
    gray: Cow<'a, GrayImage>,
    binary: BinaryImage,
    cleaned: BinaryImage,
    dpi: f64,
    deskew_angle_degrees: f64,
    deskew_confidence: f64,
    // The full-image angle-x Hough voting pass costs far more than any
    // window readout, and up to three fold searches read the same votes
    // (global candidate, whitespace-local candidate, offcut candidate).
    fold_votes: OnceLock<FoldVotes>,
}

impl AnalysisImage<'_> {
    fn fold_votes(&self) -> &FoldVotes {
        self.fold_votes.get_or_init(|| build_fold_votes(&self.gray))
    }
}

struct FoldVotes {
    accumulator: Vec<u64>,
    slopes: Vec<f64>,
}

pub fn detect_split(
    gray: &GrayImage,
    dpi: f64,
    mode: LayoutMode,
    manual_split_x: Option<f64>,
) -> SplitResult {
    detect_split_impl(gray, dpi, mode, manual_split_x, false, None, None)
}

pub(crate) fn detect_split_at_analysis_level_with_threshold(
    gray: &GrayImage,
    dpi: f64,
    mode: LayoutMode,
    manual_split_x: Option<f64>,
    threshold: u8,
    document_prior: Option<DocumentPrior>,
) -> SplitResult {
    detect_split_impl(
        gray,
        dpi,
        mode,
        manual_split_x,
        true,
        Some(threshold),
        document_prior,
    )
}

fn detect_split_impl(
    gray: &GrayImage,
    dpi: f64,
    mode: LayoutMode,
    manual_split_x: Option<f64>,
    already_bounded: bool,
    threshold: Option<u8>,
    document_prior: Option<DocumentPrior>,
) -> SplitResult {
    // A cutter needs at least one pixel on each side; a narrower raster has
    // no legal cutter position, and the clamp below would panic on min > max.
    if gray.width() < 2 {
        return single(
            gray.width(),
            gray.height(),
            1.0,
            SplitDiagnostics::default(),
        );
    }
    if let Some(cutter) = manual_split_x {
        // A manually positioned cutter in Auto mode is an explicit spread
        // decision. Treating Auto as single here discarded the two halves on
        // the next preview and made the cutter disappear from the editor.
        let classification = if matches!(mode, LayoutMode::Auto) {
            LayoutClassification::TwoPageSpread
        } else {
            mode_classification(mode)
        };
        let cutter = cutter.clamp(1.0, gray.width().saturating_sub(1) as f64);
        // The shadow does not travel with the cutter, so re-measure it here on
        // the pixels this pass actually has. The cutter is taken as given, so
        // nothing anchored to either leaf shifts under it.
        let gutter_band = matches!(classification, LayoutClassification::TwoPageSpread)
            .then(|| gutter_shadow_band(gray, cutter))
            .flatten();
        let fold_band = if matches!(classification, LayoutClassification::TwoPageSpread) {
            gutter_band.map_or_else(
                || FoldBand::unmeasured(FoldBandUnmeasuredReason::MeasurementUnavailable),
                |(left, right)| FoldBand::measured(left, right),
            )
        } else {
            FoldBand::unmeasured(FoldBandUnmeasuredReason::NotApplicable)
        };
        return split_at(
            gray.width(),
            gray.height(),
            cutter,
            fold_band,
            classification,
            1.0,
            SplitDiagnostics::default(),
        );
    }
    if !matches!(mode, LayoutMode::Auto) {
        return if matches!(mode, LayoutMode::Single) {
            single(
                gray.width(),
                gray.height(),
                1.0,
                SplitDiagnostics::default(),
            )
        } else {
            split_at(
                gray.width(),
                gray.height(),
                gray.width() as f64 * 0.5,
                FoldBand::unmeasured(FoldBandUnmeasuredReason::NoFoldEvidence),
                mode_classification(mode),
                1.0,
                SplitDiagnostics::default(),
            )
        };
    }

    let analysis = prepare_analysis(gray, dpi, already_bounded, threshold);
    let prior_ratio = candidate_prior_ratio(document_prior);
    let whitespace = whitespace_candidate(&analysis.cleaned, true, prior_ratio);
    let offcut_whitespace = whitespace_candidate(&analysis.cleaned, false, None);
    let aspect_ratio = analysis.gray.width() as f64 / analysis.gray.height().max(1) as f64;
    let fold = (aspect_ratio >= 1.0)
        .then(|| fold_line_candidate(&analysis.gray, analysis.fold_votes(), prior_ratio))
        .flatten();
    let mut diagnostics = SplitDiagnostics {
        analysis_dpi: analysis.dpi,
        deskew_angle_degrees: analysis.deskew_angle_degrees,
        deskew_confidence: analysis.deskew_confidence,
        fold_score: fold.map_or(0.0, |candidate| candidate.score),
        fold_x: fold.map_or(0.0, |candidate| candidate.x),
        aspect_ratio,
        aspect_spread_score: ramp(aspect_ratio, 1.15, 1.40),
        aspect_single_score: ramp(1.15 - aspect_ratio, 0.0, 0.35),
        ..SplitDiagnostics::default()
    };

    if aspect_ratio >= 1.0 {
        if let Some(mut result) = spread_decision(
            gray,
            &analysis,
            whitespace,
            fold,
            document_prior,
            &mut diagnostics,
        ) {
            if analysis.deskew_angle_degrees == 0.0 {
                result.reusable_binary = Some(analysis.binary);
            }
            return result;
        }
    }
    if let Some(mut result) = offcut_decision(gray, &analysis, offcut_whitespace, &mut diagnostics)
    {
        if analysis.deskew_angle_degrees == 0.0 {
            result.reusable_binary = Some(analysis.binary);
        }
        return result;
    }

    diagnostics.abstained = whitespace.is_some() || offcut_whitespace.is_some() || fold.is_some();
    let confidence = single_confidence(&diagnostics);
    diagnostics.alternative_product = diagnostics.evidence_product;
    diagnostics.evidence_product = confidence;
    let mut result = single(gray.width(), gray.height(), confidence, diagnostics);
    if analysis.deskew_angle_degrees == 0.0 {
        result.reusable_binary = Some(analysis.binary);
    }
    result
}

fn prepare_analysis(
    gray: &GrayImage,
    dpi: f64,
    already_bounded: bool,
    threshold: Option<u8>,
) -> AnalysisImage<'_> {
    let (working, analysis_dpi) = if already_bounded {
        (Cow::Borrowed(gray), dpi)
    } else {
        let level = build_analysis_level(gray, dpi, SPLIT_ANALYSIS_DPI);
        (Cow::Owned(level.image), level.effective_dpi)
    };
    // Portrait sheets are overwhelmingly single-page candidates in this policy,
    // and the fold search already tolerates small line slopes. Reserve the
    // comparatively expensive global deskew pass for spread-shaped geometry.
    let should_deskew = working.width() as f64 / working.height().max(1) as f64 >= 1.15;
    let deskew = should_deskew.then(|| detect_skew(&working, analysis_dpi));
    let deskewed = if deskew.is_some_and(|result| result.accepted) {
        Cow::Owned(rotate_gray(
            &working,
            -deskew.map_or(0.0, |result| result.angle_degrees),
        ))
    } else {
        working
    };
    let threshold = if deskew.is_some_and(|result| result.accepted) {
        otsu_threshold(&deskewed)
    } else {
        threshold.unwrap_or_else(|| otsu_threshold(&deskewed))
    };
    let binary = threshold_global(&deskewed, threshold);
    let cleaned = shadow_cleaned_binary(&binary, analysis_dpi);
    AnalysisImage {
        gray: deskewed,
        binary,
        cleaned,
        dpi: analysis_dpi,
        deskew_angle_degrees: deskew.map_or(0.0, |result| result.angle_degrees),
        deskew_confidence: deskew.map_or(0.0, |result| result.confidence),
        fold_votes: OnceLock::new(),
    }
}

fn spread_decision(
    original: &GrayImage,
    analysis: &AnalysisImage<'_>,
    whitespace: Option<Candidate>,
    fold: Option<FoldCandidate>,
    document_prior: Option<DocumentPrior>,
    diagnostics: &mut SplitDiagnostics,
) -> Option<SplitResult> {
    let whitespace = whitespace?;
    diagnostics.whitespace_score = whitespace.score;
    diagnostics.whitespace_x = whitespace.x;
    diagnostics.whitespace_gate_passed = whitespace.score >= 0.20;
    let position = whitespace.x / analysis.gray.width().max(1) as f64;
    diagnostics.central_position_gate_passed = (0.28..=0.72).contains(&position);
    if !diagnostics.central_position_gate_passed {
        diagnostics.abstained = true;
        return None;
    }

    let local_fold = fold_candidate_near_whitespace(
        &analysis.gray,
        analysis.fold_votes(),
        &analysis.cleaned,
        whitespace,
    );
    let agrees = fold.is_some_and(|candidate| {
        let distance = (candidate.x - whitespace.x).abs() / analysis.gray.width().max(1) as f64;
        distance <= MAX_EVIDENCE_DISAGREEMENT
    });
    let agreed_global = fold.filter(|_| agrees);
    let selected_fold = match (local_fold, agreed_global) {
        (Some(local), Some(global)) if global.score > local.score => Some(global),
        (Some(local), _) => Some(local),
        (None, global) => global,
    };
    let fold_score = selected_fold.map_or(0.0, |candidate| candidate.score);
    let fold_x = selected_fold.map_or(whitespace.x, |candidate| candidate.x);
    let fold_darkness = gutter_darkness_score(&analysis.gray, fold_x);
    let (shadow_x, shadow_score) = darkest_gutter_position(&analysis.gray, whitespace);
    let soft_gutter = soft_gutter_candidate(&analysis.gray, whitespace);
    let sparse_gutter = sparse_gutter_candidate(&analysis.gray, whitespace);
    let (line_decision_x, gutter_darkness) = if shadow_score > fold_darkness {
        (shadow_x, shadow_score)
    } else {
        (fold_x, fold_darkness)
    };
    let decision_x = soft_gutter
        .filter(|candidate| candidate.score > gutter_darkness.max(fold_score))
        .map_or(line_decision_x, |candidate| candidate.x);
    let decision_slope = selected_fold.map_or(0.0, |candidate| candidate.slope);
    let agreement_score = if fold.is_some() && !agrees { 0.65 } else { 1.0 };
    let soft_gutter_score = soft_gutter.map_or(0.0, |candidate| candidate.score);
    let gutter_score = gutter_darkness.max(fold_score).max(soft_gutter_score) * agreement_score;
    let folded_sheet_balance = folded_sheet_balance(soft_gutter, gutter_darkness);
    let bilateral = bilateral_page_score(
        &analysis.cleaned,
        &analysis.gray,
        decision_x,
        folded_sheet_balance,
    );
    let outer_margins = outer_margin_scores(&analysis.cleaned, &analysis.binary, decision_x);
    let (mut confidence, independent_spread_cues) = spread_confidence(
        whitespace.score,
        bilateral.score,
        outer_margins.bilateral(),
        fold_score,
        soft_gutter_score,
        diagnostics.aspect_spread_score,
    );

    diagnostics.fold_x = selected_fold.map_or(diagnostics.fold_x, |candidate| candidate.x);
    diagnostics.fold_score = fold_score;
    diagnostics.decision_x = decision_x;
    diagnostics.cutter_slope = decision_slope;
    if let Some(candidate) = selected_fold {
        diagnostics.left_deskew_angle_degrees = candidate.left_deskew_angle_degrees;
        diagnostics.right_deskew_angle_degrees = candidate.right_deskew_angle_degrees;
        diagnostics.left_deskew_confidence = candidate.left_deskew_confidence;
        diagnostics.right_deskew_confidence = candidate.right_deskew_confidence;
    }
    diagnostics.bilateral_score = bilateral.score;
    diagnostics.left_page_score = bilateral.left.page_score;
    diagnostics.right_page_score = bilateral.right.page_score;
    diagnostics.left_content_score = bilateral.left.content_score;
    diagnostics.right_content_score = bilateral.right.content_score;
    diagnostics.left_surface_score = bilateral.left.surface_score;
    diagnostics.right_surface_score = bilateral.right.surface_score;
    diagnostics.left_ink_pixels = bilateral.left.ink;
    diagnostics.right_ink_pixels = bilateral.right.ink;
    diagnostics.left_outer_margin_score = outer_margins.left;
    diagnostics.right_outer_margin_score = outer_margins.right;
    diagnostics.outer_margin_score = outer_margins.bilateral();
    diagnostics.gutter_darkness_score = gutter_darkness;
    diagnostics.soft_gutter_score = soft_gutter_score;
    diagnostics.soft_gutter_coverage =
        soft_gutter.map_or(0.0, |candidate| candidate.vertical_coverage);
    diagnostics.soft_gutter_continuity = soft_gutter.map_or(0.0, |candidate| candidate.continuity);
    diagnostics.soft_gutter_mean_depression =
        soft_gutter.map_or(0.0, |candidate| candidate.mean_depression);
    diagnostics.sparse_gutter_score = sparse_gutter.map_or(0.0, |candidate| candidate.score);
    diagnostics.sparse_gutter_coverage =
        sparse_gutter.map_or(0.0, |candidate| candidate.vertical_coverage);
    diagnostics.sparse_gutter_continuity =
        sparse_gutter.map_or(0.0, |candidate| candidate.continuity);
    diagnostics.sparse_gutter_mean_depression =
        sparse_gutter.map_or(0.0, |candidate| candidate.mean_depression);
    diagnostics.gutter_score = gutter_score;
    diagnostics.agreement_score = agreement_score;
    diagnostics.independent_spread_cues = independent_spread_cues;

    diagnostics.bilateral_gate_passed = bilateral.score >= 0.08;
    diagnostics.outer_margin_gate_passed = outer_margins.bilateral() >= OUTER_MARGIN_STANDARD_FLOOR;
    diagnostics.gutter_gate_passed = gutter_score >= 0.25;
    diagnostics.independent_gutter_gate_passed =
        fold_score >= 0.25 || soft_gutter_score >= 0.25 || gutter_darkness >= 0.25;
    diagnostics.aspect_support_gate_passed =
        fold_score >= 0.25 || gutter_darkness >= 0.25 || diagnostics.aspect_spread_score >= 0.15;
    diagnostics.evidence_agreement_gate_passed = fold.is_none()
        || agrees
        || local_fold.is_some()
        || gutter_darkness.max(soft_gutter_score) >= 0.25;

    // The bilateral minimum remains the normal policy. Recovery is local and
    // one-sided only. It needs real page surfaces on both leaves, a strong
    // body score on both leaves, a saturated gutter, matching fold evidence,
    // spread-shaped geometry, and enough width on each side to rule out an
    // outer offcut. A cohort prior is intentionally absent from this gate.
    let recovery_edge = outer_margin_recovery_edge(
        outer_margins,
        bilateral,
        decision_x,
        analysis.gray.width(),
        gutter_score,
        fold_score,
        soft_gutter_score,
        gutter_darkness,
        agreement_score,
        diagnostics.aspect_spread_score,
        diagnostics.whitespace_gate_passed,
        diagnostics.central_position_gate_passed,
        diagnostics.evidence_agreement_gate_passed,
    );
    if let Some(weak_edge) = recovery_edge {
        diagnostics.outer_margin_recovery = true;
        diagnostics.outer_margin_weak_edge = Some(weak_edge);
        let (recovered_confidence, recovered_independent_spread_cues) = spread_confidence(
            whitespace.score,
            bilateral.score,
            outer_margins.strong_edge(weak_edge),
            fold_score,
            soft_gutter_score,
            diagnostics.aspect_spread_score,
        );
        confidence = recovered_confidence;
        diagnostics.independent_spread_cues = recovered_independent_spread_cues;
    }
    diagnostics.evidence_product = diagnostics.evidence_product.max(confidence);

    let standard_spread = diagnostics.whitespace_gate_passed
        && diagnostics.bilateral_gate_passed
        && diagnostics.outer_margin_gate_passed
        && diagnostics.gutter_gate_passed
        && diagnostics.independent_gutter_gate_passed
        && diagnostics.aspect_support_gate_passed
        && diagnostics.evidence_agreement_gate_passed;

    // Sparse title and half-title pages can make the best binary whitespace
    // midpoint miss their physical gutter, even when both leaves have enough
    // ink. Recover them only when spread geometry is saturated and a faint,
    // symmetric, vertically coherent surface valley independently corroborates
    // the central gap. The local path remains deliberately strict; a strong
    // document prior may widen its position window, but can never substitute
    // for an actually observed valley or two page bodies.
    let sparse_position =
        sparse_gutter.map(|candidate| candidate.x / analysis.gray.width().max(1) as f64);
    let strong_spread_prior = document_prior.filter(|prior| {
        prior.validate().is_ok()
            && prior.dominant_layout == LayoutClassification::TwoPageSpread
            && prior.agreement_strength >= 0.80
    });
    let sparse_position_matches = sparse_position.is_some_and(|ratio| {
        strong_spread_prior.map_or_else(
            || (0.38..=0.62).contains(&ratio),
            |prior| {
                prior
                    .cutter_ratio_median
                    .is_some_and(|median| (ratio - median).abs() <= 0.10)
            },
        )
    });
    let sparse_x = sparse_gutter.map_or(decision_x, |candidate| candidate.x);
    let sparse_bilateral = bilateral_page_score(
        &analysis.cleaned,
        &analysis.gray,
        sparse_x,
        folded_sheet_balance,
    );
    let sparse_outer_margin_scores =
        outer_margin_scores(&analysis.cleaned, &analysis.binary, sparse_x);
    let sparse_outer_margins = sparse_outer_margin_scores.bilateral();
    let sparse_agreement = fold.is_none()
        || agrees
        || local_fold.is_some()
        || fold.is_some_and(|candidate| candidate.score < 0.25);
    let sparse_spread = !standard_spread
        && diagnostics.aspect_ratio >= 1.40
        && diagnostics.whitespace_gate_passed
        && sparse_position_matches
        && sparse_outer_margins >= 0.20
        && sparse_bilateral.left.page_score >= 0.01
        && sparse_bilateral.right.page_score >= 0.01
        && sparse_gutter.is_some_and(|candidate| {
            candidate.score >= 0.35
                && candidate.mean_depression >= 0.80
                && candidate.vertical_coverage >= 0.62
                && candidate.continuity >= 0.50
        })
        && sparse_agreement;

    // These are policy gates, not compensating weights. A very strong cue may
    // never make up for a missing independent cue.
    if !standard_spread && recovery_edge.is_none() && !sparse_spread {
        diagnostics.abstained = true;
        return None;
    }

    let (decision_x, confidence) = if sparse_spread {
        diagnostics.sparse_spread_recovered = true;
        diagnostics.decision_x = sparse_x;
        diagnostics.bilateral_score = sparse_bilateral.score;
        diagnostics.left_page_score = sparse_bilateral.left.page_score;
        diagnostics.right_page_score = sparse_bilateral.right.page_score;
        diagnostics.left_content_score = sparse_bilateral.left.content_score;
        diagnostics.right_content_score = sparse_bilateral.right.content_score;
        diagnostics.left_surface_score = sparse_bilateral.left.surface_score;
        diagnostics.right_surface_score = sparse_bilateral.right.surface_score;
        diagnostics.left_ink_pixels = sparse_bilateral.left.ink;
        diagnostics.right_ink_pixels = sparse_bilateral.right.ink;
        diagnostics.left_outer_margin_score = sparse_outer_margin_scores.left;
        diagnostics.right_outer_margin_score = sparse_outer_margin_scores.right;
        diagnostics.outer_margin_score = sparse_outer_margins;
        let sparse = sparse_gutter.expect("sparse spread requires a gutter candidate");
        let mean_strength = (diagnostics.aspect_spread_score
            + whitespace.score
            + sparse_outer_margins
            + sparse.score
            + sparse_bilateral
                .left
                .page_score
                .min(sparse_bilateral.right.page_score))
            / 5.0;
        let sparse_confidence = (0.52 + 0.18 * mean_strength).min(0.72);
        diagnostics.evidence_product = sparse_confidence;
        (sparse_x, sparse_confidence)
    } else {
        (decision_x, confidence)
    };

    // The cutter itself does not move: relocating it would hand the leaf on
    // the far side material the other leaf used to own. Both leaves pull back
    // to the near edge of the fold the cutter runs through.
    let cutter = scale_x(decision_x, analysis.gray.width(), original.width());
    let gutter_band = gutter_shadow_band(&analysis.gray, decision_x).map(|(left, right)| {
        (
            scale_x(left, analysis.gray.width(), original.width()),
            scale_x(right, analysis.gray.width(), original.width()),
        )
    });
    let fold_band = gutter_band.map_or_else(
        || fold_band_without_measurement(diagnostics),
        |(left, right)| FoldBand::measured(left, right),
    );
    let mut result = split_at(
        original.width(),
        original.height(),
        cutter,
        fold_band,
        LayoutClassification::TwoPageSpread,
        confidence,
        *diagnostics,
    );
    result.split_seam =
        refine_curved_seam(&analysis.gray, &analysis.binary, decision_x, decision_slope).map(
            |seam| seam_in_source_coordinates(seam, analysis, original.width(), original.height()),
        );
    Some(result)
}

fn fold_band_without_measurement(diagnostics: &SplitDiagnostics) -> FoldBand {
    if diagnostics.independent_gutter_gate_passed {
        FoldBand::unquantified_evidence()
    } else {
        FoldBand::unmeasured(FoldBandUnmeasuredReason::NoFoldEvidence)
    }
}

fn offcut_decision(
    original: &GrayImage,
    analysis: &AnalysisImage<'_>,
    whitespace: Option<Candidate>,
    diagnostics: &mut SplitDiagnostics,
) -> Option<SplitResult> {
    let edge_whitespace = whitespace.filter(|candidate| {
        let position = candidate.x / analysis.gray.width().max(1) as f64;
        !(0.28..=0.72).contains(&position)
    });
    let whitespace_fold = edge_whitespace.and_then(|candidate| {
        fold_candidate_near_whitespace(
            &analysis.gray,
            analysis.fold_votes(),
            &analysis.cleaned,
            candidate,
        )
    });
    let direct_fold =
        offcut_boundary_candidate(&analysis.gray, analysis.fold_votes(), &analysis.cleaned);
    let fold = match (whitespace_fold, direct_fold) {
        (Some(whitespace), Some(direct)) if whitespace.score >= direct.score => whitespace,
        (_, Some(direct)) => direct,
        (Some(whitespace), None) => whitespace,
        (None, None) => return None,
    };
    let position = fold.x / analysis.gray.width().max(1) as f64;
    let discarded_fraction = position.min(1.0 - position);
    if discarded_fraction >= MAX_OFFCUT_WIDTH_FRACTION || fold.vertical_coverage < 0.52 {
        return None;
    }

    let whitespace_score = edge_whitespace
        .filter(|candidate| {
            (candidate.x - fold.x).abs() <= analysis.gray.width() as f64 * MAX_EVIDENCE_DISAGREEMENT
        })
        .map_or(0.0, |candidate| candidate.score);
    let whitespace_anchored_fold = whitespace_fold.is_some_and(|candidate| {
        (candidate.x - fold.x).abs() <= analysis.gray.width() as f64 * MAX_EVIDENCE_DISAGREEMENT
    }) || fold_has_adjacent_whitespace(&analysis.cleaned, fold.x);
    let boundary_score = fold.score * (0.7 + 0.3 * whitespace_score);
    let empty_score = smaller_side_empty_score(&analysis.cleaned, fold.x, analysis.dpi);
    let populated_score = smaller_side_sparse_score(&analysis.cleaned, fold.x);
    let discardable_score = empty_score.max(populated_score);
    let width_score = ramp(
        MAX_OFFCUT_WIDTH_FRACTION - discarded_fraction,
        0.0,
        MAX_OFFCUT_WIDTH_FRACTION - 0.10,
    );
    let no_text_rows_score = 1.0 - aligned_text_rows_score(&analysis.binary, fold.x);
    let evidence_product = boundary_score * discardable_score * width_score * no_text_rows_score;

    let decision_x = gutter_shadow_band(&analysis.gray, fold.x)
        .map_or(fold.x, |(left, right)| (left + right) * 0.5);

    diagnostics.whitespace_score = diagnostics.whitespace_score.max(whitespace_score);
    diagnostics.whitespace_x = edge_whitespace.map_or(0.0, |candidate| candidate.x);
    diagnostics.fold_x = fold.x;
    diagnostics.decision_x = decision_x;
    diagnostics.offcut_boundary_score = boundary_score;
    diagnostics.offcut_empty_score = empty_score;
    diagnostics.offcut_populated_score = populated_score;
    diagnostics.offcut_width_score = width_score;
    diagnostics.offcut_no_text_rows_score = no_text_rows_score;
    diagnostics.evidence_product = diagnostics.evidence_product.max(evidence_product);

    if boundary_score < 0.45
        || (empty_score < 0.95 && populated_score < 0.80)
        || width_score <= 0.0
        || no_text_rows_score < 0.90
        || (discarded_fraction > MAX_UNANCHORED_OFFCUT_WIDTH_FRACTION && !whitespace_anchored_fold)
    {
        diagnostics.abstained = true;
        return None;
    }

    let cutter = scale_x(decision_x, analysis.gray.width(), original.width());
    Some(split_at(
        original.width(),
        original.height(),
        cutter,
        FoldBand::unmeasured(FoldBandUnmeasuredReason::NotApplicable),
        LayoutClassification::PageWithOffcut,
        evidence_product,
        *diagnostics,
    ))
}

/// Find a physical boundary in either outer strip without requiring a white
/// gutter beside it. Populated offcuts commonly meet the retained page at a
/// dark cut or scanner seam, so a whitespace-anchored search cannot see them.
fn offcut_boundary_candidate(
    gray: &GrayImage,
    votes: &FoldVotes,
    cleaned: &BinaryImage,
) -> Option<FoldCandidate> {
    let inner = (gray.width() as f64 * MAX_OFFCUT_WIDTH_FRACTION).round() as usize;
    let outer = gray.width() / 20;
    let mut candidates = fold_line_candidates_in_range(gray, votes, outer, inner);
    candidates.extend(fold_line_candidates_in_range(
        gray,
        votes,
        gray.width().saturating_sub(inner),
        gray.width().saturating_sub(outer),
    ));
    select_fold_candidate(cleaned, candidates)
}

fn fold_has_adjacent_whitespace(cleaned: &BinaryImage, fold_x: f64) -> bool {
    let columns = column_counts(cleaned);
    let quiet_limit = (cleaned.height() as f64 * 0.012).ceil() as usize;
    let search_radius = (cleaned.width() as f64 * 0.03).ceil() as usize;
    let anchor_distance = (cleaned.width() as f64 * 0.02).ceil() as usize;
    let minimum_run = (cleaned.width() as f64 * 0.005).ceil().max(2.0) as usize;
    let fold = fold_x.round().clamp(0.0, cleaned.width() as f64) as usize;
    let left = fold.saturating_sub(search_radius);
    let right = (fold + search_radius).min(cleaned.width());
    let mut start = None;
    let anchored = |run_start: usize, run_end: usize| {
        let distance = run_start
            .saturating_sub(fold)
            .max(fold.saturating_sub(run_end));
        run_end - run_start >= minimum_run && distance <= anchor_distance
    };
    for (offset, &count) in columns[left..right].iter().enumerate() {
        let x = left + offset;
        let quiet = count <= quiet_limit;
        if quiet && start.is_none() {
            start = Some(x);
        }
        if !quiet {
            if let Some(run_start) = start.take() {
                if anchored(run_start, x) {
                    return true;
                }
            }
        }
    }
    start.is_some_and(|run_start| anchored(run_start, right))
}

fn rotate_gray(source: &GrayImage, correction_degrees: f64) -> GrayImage {
    let cx = source.width() as f64 * 0.5;
    let cy = source.height() as f64 * 0.5;
    let inverse = Affine::translation(-cx, -cy)
        .then(Affine::rotation_radians(-correction_degrees.to_radians()))
        .then(Affine::translation(cx, cy));
    let mut output = GrayImage::new(source.width(), source.height(), 255);
    for y in 0..output.height() {
        for x in 0..output.width() {
            let mapped = inverse.apply(Point::new(x as f64 + 0.5, y as f64 + 0.5));
            if mapped.x >= 0.0
                && mapped.y >= 0.0
                && mapped.x < source.width() as f64
                && mapped.y < source.height() as f64
            {
                output.set(
                    x,
                    y,
                    source.get(
                        mapped
                            .x
                            .floor()
                            .min(source.width().saturating_sub(1) as f64)
                            as usize,
                        mapped
                            .y
                            .floor()
                            .min(source.height().saturating_sub(1) as f64)
                            as usize,
                    ),
                );
            }
        }
    }
    output
}

fn shadow_cleaned_binary(binary: &BinaryImage, dpi: f64) -> BinaryImage {
    let shadow_radius = ((dpi / 300.0) * 60.0).round().max(12.0) as usize;
    let seed = open(
        binary,
        shadow_radius,
        ((dpi / 300.0) * 4.0).round().max(1.0) as usize,
    );
    let cleaned = binary.subtract(&reconstruct_binary(&seed, binary));
    let map = ComponentMap::from_binary(&cleaned);
    let min_area = ((dpi / 300.0).powi(2) * 3.0).round().max(2.0) as usize;
    map.retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let is_page_boundary = height as f64 >= cleaned.height() as f64 * 0.35
            && width as f64 <= cleaned.width() as f64 * 0.025;
        component.area >= min_area && !is_page_boundary
    })
}

fn candidate_prior_ratio(prior: Option<DocumentPrior>) -> Option<(f64, f64)> {
    // Callers must gate the prior against the full-resolution page dimensions
    // before the ratio narrows analysis-scale candidate searches.
    prior
        .filter(|prior| {
            prior.validate().is_ok()
                && prior.dominant_layout == LayoutClassification::TwoPageSpread
                && prior.agreement_strength > 0.0
        })
        .and_then(|prior| {
            prior
                .cutter_ratio_median
                .map(|ratio| (ratio, prior.agreement_strength))
        })
}

fn whitespace_candidate(
    cleaned: &BinaryImage,
    central: bool,
    prior: Option<(f64, f64)>,
) -> Option<Candidate> {
    if cleaned.width() < 8 || cleaned.height() < 8 {
        return None;
    }
    let columns = column_counts(cleaned);
    let search_left = cleaned.width() / 20;
    let search_right = cleaned.width() - search_left;
    let quiet_limit = (cleaned.height() as f64 * 0.012).ceil() as usize;
    let mut best: Option<Candidate> = None;
    let mut start = None;
    for x in search_left..=search_right {
        let quiet = x < search_right && columns[x] <= quiet_limit;
        if quiet && start.is_none() {
            start = Some(x);
        }
        if !quiet {
            if let Some(run_start) = start.take() {
                let run_width = x - run_start;
                let midpoint = (run_start + x) as f64 * 0.5;
                let width_fraction = run_width as f64 / cleaned.width() as f64;
                let mean_ink =
                    columns[run_start..x].iter().sum::<usize>() as f64 / run_width.max(1) as f64;
                let quietness = 1.0 - (mean_ink / quiet_limit.max(1) as f64).clamp(0.0, 1.0);
                let width_score = ramp(width_fraction, 0.001, 0.025);
                let score = width_score * (0.65 + 0.35 * quietness);
                let position = midpoint / cleaned.width() as f64;
                let eligible = if central {
                    let base_window = (0.20..=0.80).contains(&position);
                    let prior_window = prior.is_none_or(|(ratio, strength)| {
                        let half_width = 0.16 - 0.08 * strength.clamp(0.0, 1.0);
                        (position - ratio).abs() <= half_width
                    });
                    base_window && prior_window
                } else {
                    !(0.28..=0.72).contains(&position)
                };
                if !eligible {
                    continue;
                }
                let candidate = Candidate {
                    x: midpoint,
                    score,
                    start: run_start,
                    end: x,
                };
                let preferred_center = prior.map_or(0.5, |(ratio, _)| ratio);
                let centrality = 1.0 - ((position - preferred_center).abs() / 0.30).min(1.0);
                let ranking = if central {
                    candidate.score * (0.25 + 0.75 * centrality)
                } else {
                    candidate.score
                };
                let current_ranking = best.map_or(-1.0, |current| {
                    let current_position = current.x / cleaned.width() as f64;
                    let current_centrality =
                        1.0 - ((current_position - preferred_center).abs() / 0.30).min(1.0);
                    if central {
                        current.score * (0.25 + 0.75 * current_centrality)
                    } else {
                        current.score
                    }
                });
                if ranking > current_ranking {
                    best = Some(candidate);
                }
            }
        }
    }
    best.filter(|candidate| candidate.score >= 0.15)
}

#[derive(Clone, Copy, Debug, Default)]
struct BilateralScore {
    score: f64,
    left: SideScore,
    right: SideScore,
}

/// How strongly the gutter reads as the physical fold of a folded sheet rather
/// than as a page-internal gap: a shadow that is deep, unbroken and runs the
/// whole height of the raster.
fn folded_sheet_balance(soft_gutter: Option<SoftGutterCandidate>, gutter_darkness: f64) -> f64 {
    soft_gutter.map_or(0.0, |candidate| {
        ramp(candidate.mean_depression, 8.0, 20.0)
            * ramp(candidate.vertical_coverage, 0.88, 0.97)
            * ramp(candidate.continuity, 0.80, 0.95)
            * ramp(gutter_darkness, 0.40, 0.80)
    })
}

fn bilateral_page_score(
    cleaned: &BinaryImage,
    gray: &GrayImage,
    cutter_x: f64,
    folded_sheet_balance: f64,
) -> BilateralScore {
    let cutter = clamp_cutter(cleaned.width(), cutter_x);
    let left = side_page_score(cleaned, gray, 0, cutter);
    let right = side_page_score(cleaned, gray, cutter, cleaned.width());
    let content_balance = if left.ink == 0 || right.ink == 0 {
        0.0
    } else {
        ramp(
            left.ink.min(right.ink) as f64 / left.ink.max(right.ink) as f64,
            0.004,
            0.30,
        )
    };
    // A physically blank leaf is still a complete page. It may substitute for
    // content balance only when the grayscale raster independently exposes a
    // page-surface edge; a flat born-digital blank half never receives this
    // escape hatch.
    let blank_leaf_balance = if left.surface_score > 0.0 || right.surface_score > 0.0 {
        left.page_score.min(right.page_score)
    } else {
        0.0
    };
    // A fold that darkens the full height of the sheet proves the two leaves
    // are physically separate pages, so a pale plate facing a text page is a
    // spread even though neither their ink volumes nor their page scores can
    // balance. Both leaves must still expose their own page surface, which no
    // born-digital raster does, and the floor is a floor rather than a factor
    // because the pale leaf's own score measures how much of it was printed,
    // not whether it is a leaf.
    let folded_sheet_floor = if left.surface_score > 0.0 && right.surface_score > 0.0 {
        FOLDED_SHEET_BILATERAL_FLOOR * folded_sheet_balance
    } else {
        0.0
    };
    BilateralScore {
        score: (left.page_score.min(right.page_score) * content_balance.max(blank_leaf_balance))
            .max(folded_sheet_floor),
        left,
        right,
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct SideScore {
    page_score: f64,
    content_score: f64,
    surface_score: f64,
    ink: usize,
}

fn side_page_score(binary: &BinaryImage, gray: &GrayImage, left: usize, right: usize) -> SideScore {
    let width = right.saturating_sub(left);
    if width < 2 || binary.height() < 2 {
        return SideScore::default();
    }
    let mut ink = 0usize;
    let mut min_x = right;
    let mut max_x = left;
    let mut min_y = binary.height();
    let mut max_y = 0usize;
    for y in 0..binary.height() {
        for x in left..right {
            if binary.get(x, y) {
                ink += 1;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
    }
    let coverage = ink as f64 / (width * binary.height()) as f64;
    let half_aspect = width as f64 / binary.height() as f64;
    let shape_score = ramp(half_aspect, 0.46, 0.58) * ramp(1.35 - half_aspect, 0.0, 0.25);
    let content_score = if ink == 0 {
        0.0
    } else {
        let horizontal_span = (max_x - min_x + 1) as f64 / width as f64;
        let vertical_span = (max_y - min_y + 1) as f64 / binary.height() as f64;
        let ink_score = ramp(coverage, 0.00005, 0.006);
        let span_score = ramp(horizontal_span, 0.08, 0.45) * ramp(vertical_span, 0.06, 0.45);
        shape_score * ink_score * span_score
    };
    let surface_score = shape_score * page_surface_score(gray, left, right);
    SideScore {
        page_score: content_score.max(surface_score),
        content_score,
        surface_score,
        ink,
    }
}

fn page_surface_score(gray: &GrayImage, left: usize, right: usize) -> f64 {
    page_surface_edge_score(gray, left, right).max(page_surface_texture_score(gray, left, right))
}

fn page_surface_edge_score(gray: &GrayImage, left: usize, right: usize) -> f64 {
    let width = right.saturating_sub(left);
    if width < 8 || gray.height() < 16 {
        return 0.0;
    }
    let edge_band = (gray.height() as f64 * 0.10).ceil().max(4.0) as usize;
    let sample_step = (width / 320).max(1);
    let mut covered = 0usize;
    let mut samples = 0usize;
    for x in (left + 2..right.saturating_sub(2)).step_by(sample_step) {
        samples += 1;
        let top_end = edge_band.min(gray.height().saturating_sub(2));
        let bottom_start = gray.height().saturating_sub(edge_band).max(2);
        let internal_edge = (2..top_end)
            .chain(bottom_start..gray.height().saturating_sub(2))
            .any(|y| {
                let gradient = i16::from(gray.get(x, y + 2)) - i16::from(gray.get(x, y - 2));
                gradient.unsigned_abs() >= 28
            });
        let clipped_edge = [
            i16::from(gray.get(x, 0)) - i16::from(gray.get(x, top_end)),
            i16::from(gray.get(x, gray.height() - 1))
                - i16::from(gray.get(x, bottom_start.saturating_sub(1))),
        ]
        .into_iter()
        .any(|gradient| gradient.unsigned_abs() >= 28);
        let edge_present = internal_edge || clipped_edge;
        covered += usize::from(edge_present);
    }
    ramp(covered as f64 / samples.max(1) as f64, 0.12, 0.55)
}

fn page_surface_texture_score(gray: &GrayImage, left: usize, right: usize) -> f64 {
    const GRID: usize = 10;
    let width = right.saturating_sub(left);
    if width < GRID || gray.height() < GRID {
        return 0.0;
    }
    let inset_x = (width as f64 * 0.05).round() as usize;
    let inset_y = (gray.height() as f64 * 0.10).round() as usize;
    let inner_left = left + inset_x;
    let inner_right = right.saturating_sub(inset_x);
    let inner_top = inset_y;
    let inner_bottom = gray.height().saturating_sub(inset_y);
    let inner_width = inner_right.saturating_sub(inner_left);
    let inner_height = inner_bottom.saturating_sub(inner_top);
    if inner_width == 0 || inner_height == 0 {
        return 0.0;
    }

    let mut dark_samples = [0u8; GRID * GRID];
    for y in inner_top..inner_bottom {
        let cell_y = ((y - inner_top) * GRID / inner_height).min(GRID - 1);
        for x in inner_left..inner_right {
            if gray.get(x, y) >= 235 {
                continue;
            }
            let cell_x = ((x - inner_left) * GRID / inner_width).min(GRID - 1);
            let count = &mut dark_samples[cell_y * GRID + cell_x];
            *count = count.saturating_add(1).min(2);
        }
    }
    let occupied = dark_samples.iter().filter(|&&count| count >= 2).count();
    ramp(occupied as f64 / dark_samples.len() as f64, 0.05, 0.35)
}

#[derive(Clone, Copy, Debug, Default)]
struct OuterMarginScores {
    left: f64,
    right: f64,
}

impl OuterMarginScores {
    fn bilateral(self) -> f64 {
        self.left.min(self.right)
    }

    fn weak_edge(self) -> Option<OuterMarginSide> {
        match (
            self.left < OUTER_MARGIN_STANDARD_FLOOR,
            self.right < OUTER_MARGIN_STANDARD_FLOOR,
        ) {
            (true, false) => Some(OuterMarginSide::Left),
            (false, true) => Some(OuterMarginSide::Right),
            _ => None,
        }
    }

    fn strong_edge(self, weak: OuterMarginSide) -> f64 {
        match weak {
            OuterMarginSide::Left => self.right,
            OuterMarginSide::Right => self.left,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn outer_margin_recovery_edge(
    outer_margins: OuterMarginScores,
    bilateral: BilateralScore,
    cutter_x: f64,
    width: usize,
    gutter_score: f64,
    fold_score: f64,
    soft_gutter_score: f64,
    gutter_darkness: f64,
    agreement_score: f64,
    aspect_spread_score: f64,
    whitespace_gate_passed: bool,
    central_position_gate_passed: bool,
    evidence_agreement_gate_passed: bool,
) -> Option<OuterMarginSide> {
    outer_margins.weak_edge().filter(|&weak_edge| {
        let side_fraction = cutter_x / width.max(1) as f64;
        let strong_outer = outer_margins.strong_edge(weak_edge);
        let bilateral_surfaces = bilateral.left.surface_score
            >= OUTER_MARGIN_RECOVERY_SURFACE_SCORE
            && bilateral.right.surface_score >= OUTER_MARGIN_RECOVERY_SURFACE_SCORE;
        let bilateral_page_bodies = bilateral.left.page_score >= OUTER_MARGIN_RECOVERY_PAGE_SCORE
            && bilateral.right.page_score >= OUTER_MARGIN_RECOVERY_PAGE_SCORE;
        let independent_gutter =
            fold_score.max(soft_gutter_score).max(gutter_darkness) >= OUTER_MARGIN_RECOVERY_GUTTER;
        let offcut_rejection = (OUTER_MARGIN_RECOVERY_MIN_SIDE_FRACTION
            ..=1.0 - OUTER_MARGIN_RECOVERY_MIN_SIDE_FRACTION)
            .contains(&side_fraction);
        strong_outer >= OUTER_MARGIN_RECOVERY_STRONG_EDGE
            && bilateral.score >= OUTER_MARGIN_RECOVERY_BILATERAL
            && bilateral_surfaces
            && bilateral_page_bodies
            && gutter_score >= OUTER_MARGIN_RECOVERY_GUTTER
            && independent_gutter
            && whitespace_gate_passed
            && central_position_gate_passed
            && evidence_agreement_gate_passed
            && agreement_score >= OUTER_MARGIN_RECOVERY_AGREEMENT
            && aspect_spread_score >= OUTER_MARGIN_RECOVERY_ASPECT
            && offcut_rejection
    })
}

fn outer_margin_scores(
    cleaned: &BinaryImage,
    raw: &BinaryImage,
    cutter_x: f64,
) -> OuterMarginScores {
    let cutter = clamp_cutter(cleaned.width(), cutter_x);
    OuterMarginScores {
        left: edge_margin_score(cleaned, raw, 0, cutter, true),
        right: edge_margin_score(cleaned, raw, cutter, cleaned.width(), false),
    }
}

fn edge_margin_score(
    binary: &BinaryImage,
    raw: &BinaryImage,
    left: usize,
    right: usize,
    outer_is_left: bool,
) -> f64 {
    let width = right.saturating_sub(left);
    if width < 4 {
        return 0.0;
    }
    let columns = column_counts_range(binary, left, right);
    let quiet_limit = (binary.height() as f64 * 0.01).ceil() as usize;
    let scan = (width as f64 * 0.12).ceil().max(3.0) as usize;
    let edge_columns = if outer_is_left {
        &columns[..scan.min(columns.len())]
    } else {
        &columns[columns.len().saturating_sub(scan)..]
    };
    let quiet_ratio = edge_columns
        .iter()
        .filter(|&&ink| ink <= quiet_limit)
        .count() as f64
        / edge_columns.len().max(1) as f64;
    let quiet_score = ramp(quiet_ratio, 0.25, 0.80);
    let edge_band = (width as f64 * 0.06).ceil().max(2.0) as usize;
    let raw_columns = column_counts_range(raw, left, right);
    let outer_raw_columns: Box<dyn Iterator<Item = &usize>> = if outer_is_left {
        Box::new(raw_columns.iter().take(edge_band))
    } else {
        Box::new(raw_columns.iter().rev().take(edge_band))
    };
    let border_score = outer_raw_columns
        .map(|&ink| ink as f64 / raw.height() as f64)
        .fold(0.0, f64::max);
    let tight_crop_border = if quiet_ratio < 0.25 { 0.35 } else { 0.0 };
    quiet_score
        .max(ramp(border_score, 0.35, 0.80))
        .max(tight_crop_border)
}

fn gutter_darkness_score(gray: &GrayImage, cutter_x: f64) -> f64 {
    let cutter = clamp_cutter(gray.width(), cutter_x);
    let narrow = (gray.width() as f64 * 0.006).round().max(1.0) as usize;
    let shoulder = (gray.width() as f64 * 0.025).round().max(3.0) as usize;
    let gutter = mean_luminance(
        gray,
        cutter.saturating_sub(narrow),
        (cutter + narrow + 1).min(gray.width()),
    );
    let left = mean_luminance(
        gray,
        cutter.saturating_sub(shoulder),
        cutter.saturating_sub(narrow),
    );
    let right = mean_luminance(
        gray,
        (cutter + narrow + 1).min(gray.width()),
        (cutter + shoulder).min(gray.width()),
    );
    ramp((left + right) * 0.5 - gutter, 4.0, 32.0)
}

fn darkest_gutter_position(gray: &GrayImage, whitespace: Candidate) -> (f64, f64) {
    (whitespace.start..whitespace.end)
        .map(|x| (x as f64, gutter_darkness_score(gray, x as f64)))
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .unwrap_or((whitespace.x, 0.0))
}

fn soft_gutter_candidate(gray: &GrayImage, whitespace: Candidate) -> Option<SoftGutterCandidate> {
    if gray.width() < 24 || gray.height() < 24 || whitespace.start >= whitespace.end {
        return None;
    }
    let core_radius = (gray.width() as f64 * 0.0035).round().max(1.0) as usize;
    let inner_radius = (gray.width() as f64 * 0.010).round().max(3.0) as usize;
    let shoulder_radius = (gray.width() as f64 * 0.030).round().max(7.0) as usize;
    let y_start = gray.height() / 20;
    let y_end = gray.height() - y_start;
    let y_step = ((y_end - y_start) / 160).max(1);
    let x_step = ((whitespace.end - whitespace.start) / 64).max(1);
    let sample_rows = (y_start..y_end)
        .step_by(y_step)
        .map(|y| {
            let mut prefix = Vec::with_capacity(gray.width() + 1);
            prefix.push(0_u32);
            for x in 0..gray.width() {
                prefix.push(prefix[x] + u32::from(gray.get(x, y)));
            }
            prefix
        })
        .collect::<Vec<_>>();
    let mut best: Option<SoftGutterCandidate> = None;

    for x in (whitespace.start..whitespace.end).step_by(x_step) {
        if x <= shoulder_radius || x + shoulder_radius >= gray.width() {
            continue;
        }
        let mut samples = 0usize;
        let mut depressed = 0usize;
        let mut longest_run = 0usize;
        let mut current_run = 0usize;
        let mut depression_sum = 0.0;
        for prefix in &sample_rows {
            samples += 1;
            let core = prefixed_mean_luminance(
                prefix,
                x.saturating_sub(core_radius),
                (x + core_radius + 1).min(gray.width()),
            );
            let left = prefixed_mean_luminance(
                prefix,
                x - shoulder_radius,
                x.saturating_sub(inner_radius),
            );
            let right = prefixed_mean_luminance(
                prefix,
                (x + inner_radius).min(gray.width()),
                (x + shoulder_radius).min(gray.width()),
            );
            let symmetric_dip = left.min(right) - core;
            let one_sided_ramp = (left.max(right) - core) * 0.72;
            let depression = symmetric_dip.max(one_sided_ramp);
            if core <= 249.0 && depression >= 2.5 {
                depressed += 1;
                current_run += 1;
                longest_run = longest_run.max(current_run);
                depression_sum += depression;
            } else {
                current_run = 0;
            }
        }
        let coverage = depressed as f64 / samples.max(1) as f64;
        let continuity = longest_run as f64 / samples.max(1) as f64;
        let mean_depression = depression_sum / depressed.max(1) as f64;
        let score = ramp(mean_depression, 3.0, 18.0)
            * ramp(coverage, 0.42, 0.78)
            * ramp(continuity, 0.28, 0.65);
        let candidate = SoftGutterCandidate {
            x: x as f64,
            score,
            vertical_coverage: coverage,
            continuity,
            mean_depression,
        };
        if best.is_none_or(|current| candidate.score > current.score) {
            best = Some(candidate);
        }
    }
    best.filter(|candidate| candidate.score >= 0.04)
}

/// Finds a faint, broad valley in the illumination-normalized page surface.
///
/// Unlike `soft_gutter_candidate`, this intentionally ignores high-frequency
/// edges and measures a symmetric low-frequency depression independently on
/// many rows. It is only allowed to recover spread-shaped, sparse pages in
/// `spread_decision`; keeping the permissive measurement separate from that
/// strict policy prevents landscape artwork from becoming a spread merely
/// because it contains a dark vertical feature.
fn sparse_gutter_candidate(gray: &GrayImage, whitespace: Candidate) -> Option<SoftGutterCandidate> {
    if gray.width() < 48 || gray.height() < 32 || whitespace.start >= whitespace.end {
        return None;
    }
    let core_radius = (gray.width() as f64 * 0.008).round().max(2.0) as usize;
    let inner_radius = (gray.width() as f64 * 0.018).round().max(4.0) as usize;
    let shoulder_radius = (gray.width() as f64 * 0.055).round().max(10.0) as usize;
    let y_start = gray.height() / 20;
    let y_end = gray.height() - y_start;
    let y_step = ((y_end - y_start) / 180).max(1);
    // Sparse pages often have several broad binary-white runs. Their best
    // midpoint is useful proof of a central gap but is not a reliable gutter
    // coordinate. Search a bounded neighborhood around that midpoint so the
    // grayscale page surface, rather than an arbitrary quiet-run edge, chooses
    // the physical seam.
    let neighborhood = (gray.width() as f64 * 0.12).round() as usize;
    let search_start = (whitespace.x.round() as usize)
        .saturating_sub(neighborhood)
        .max((gray.width() as f64 * 0.28).round() as usize);
    let search_end = (whitespace.x.round() as usize + neighborhood)
        .min((gray.width() as f64 * 0.72).round() as usize)
        .min(gray.width());
    let x_step = ((search_end.saturating_sub(search_start)) / 160).max(1);
    let sample_rows = (y_start..y_end)
        .step_by(y_step)
        .map(|y| {
            let mut prefix = Vec::with_capacity(gray.width() + 1);
            prefix.push(0_u32);
            for x in 0..gray.width() {
                prefix.push(prefix[x] + u32::from(gray.get(x, y)));
            }
            prefix
        })
        .collect::<Vec<_>>();
    let mut best: Option<SoftGutterCandidate> = None;

    for x in (search_start..search_end).step_by(x_step) {
        if x <= shoulder_radius || x + shoulder_radius >= gray.width() {
            continue;
        }
        let mut samples = 0usize;
        let mut depressed = 0usize;
        let mut longest_run = 0usize;
        let mut current_run = 0usize;
        let mut depression_sum = 0.0;
        for prefix in &sample_rows {
            samples += 1;
            let core = prefixed_mean_luminance(
                prefix,
                x - core_radius,
                (x + core_radius + 1).min(gray.width()),
            );
            let left = prefixed_mean_luminance(prefix, x - shoulder_radius, x - inner_radius);
            let right = prefixed_mean_luminance(
                prefix,
                x + inner_radius,
                (x + shoulder_radius).min(gray.width()),
            );
            // Subtracting the local shoulders removes slow page illumination.
            // Requiring both shoulders to be brighter rejects ordinary ramps.
            let depression = left.min(right) - core;
            if core <= 253.5 && depression >= 0.65 {
                depressed += 1;
                current_run += 1;
                longest_run = longest_run.max(current_run);
                depression_sum += depression;
            } else {
                current_run = 0;
            }
        }
        let coverage = depressed as f64 / samples.max(1) as f64;
        let continuity = longest_run as f64 / samples.max(1) as f64;
        let mean_depression = depression_sum / depressed.max(1) as f64;
        let score = ramp(mean_depression, 0.65, 5.0)
            * ramp(coverage, 0.50, 0.82)
            * ramp(continuity, 0.35, 0.70);
        let candidate = SoftGutterCandidate {
            x: x as f64,
            score,
            vertical_coverage: coverage,
            continuity,
            mean_depression,
        };
        if best.is_none_or(|current| candidate.score > current.score) {
            best = Some(candidate);
        }
    }
    best.filter(|candidate| candidate.score >= 0.04)
}

fn prefixed_mean_luminance(prefix: &[u32], left: usize, right: usize) -> f64 {
    if left >= right || right >= prefix.len() {
        return 255.0;
    }
    f64::from(prefix[right] - prefix[left]) / (right - left) as f64
}

fn fold_line_candidate(
    gray: &GrayImage,
    votes: &FoldVotes,
    prior: Option<(f64, f64)>,
) -> Option<FoldCandidate> {
    let (search_left, search_right) = prior.map_or(
        (gray.width() / 4, gray.width() * 3 / 4),
        |(ratio, strength)| {
            let half_width = 0.16 - 0.08 * strength.clamp(0.0, 1.0);
            (
                ((ratio - half_width) * gray.width() as f64).round() as usize,
                ((ratio + half_width) * gray.width() as f64).round() as usize,
            )
        },
    );
    let candidates = fold_line_candidates_in_range(gray, votes, search_left, search_right);
    candidates.into_iter().max_by(|left, right| {
        left.score
            .total_cmp(&right.score)
            .then_with(|| right.x.total_cmp(&left.x))
            .then_with(|| right.slope.total_cmp(&left.slope))
    })
}

fn build_fold_votes(gray: &GrayImage) -> FoldVotes {
    if gray.width() < 8 || gray.height() < 8 {
        return FoldVotes {
            accumulator: Vec::new(),
            slopes: Vec::new(),
        };
    }
    let angle_steps = ((MAX_CUTTER_ANGLE_DEGREES - MIN_CUTTER_ANGLE_DEGREES)
        / CUTTER_ANGLE_STEP_DEGREES)
        .round() as usize
        + 1;
    let slopes = (0..angle_steps)
        .map(|index| {
            (MIN_CUTTER_ANGLE_DEGREES + index as f64 * CUTTER_ANGLE_STEP_DEGREES)
                .to_radians()
                .tan()
        })
        .collect::<Vec<_>>();
    let mut accumulator = vec![0u64; angle_steps * gray.width()];
    let center_y = gray.height() as f64 * 0.5;
    for y in 1..gray.height() - 1 {
        for x in 2..gray.width() - 2 {
            let horizontal = i16::from(gray.get(x + 2, y)) - i16::from(gray.get(x - 2, y));
            let vertical = i16::from(gray.get(x, y + 1)) - i16::from(gray.get(x, y - 1));
            let weight = horizontal.abs().saturating_sub(vertical.abs());
            if weight < 8 {
                continue;
            }
            for (angle_index, slope) in slopes.iter().enumerate() {
                let center_x = x as f64 - slope * (y as f64 - center_y);
                let bin = center_x.round() as isize;
                if bin >= 0 && bin < gray.width() as isize {
                    accumulator[angle_index * gray.width() + bin as usize] += weight as u64;
                }
            }
        }
    }
    FoldVotes {
        accumulator,
        slopes,
    }
}

fn fold_line_candidates_in_range(
    gray: &GrayImage,
    votes: &FoldVotes,
    search_left: usize,
    search_right: usize,
) -> Vec<FoldCandidate> {
    if votes.accumulator.is_empty() {
        return Vec::new();
    }
    let angle_steps = votes.slopes.len();
    let slopes = &votes.slopes;
    let accumulator = &votes.accumulator;
    let search_left = search_left.clamp(2, gray.width().saturating_sub(3));
    let search_right = search_right.clamp(search_left + 1, gray.width().saturating_sub(2));
    let mut total = 0u64;
    let mut bin_count = 0usize;
    let mut responses = Vec::with_capacity(angle_steps * (search_right - search_left));
    for angle_index in 0..angle_steps {
        for x in search_left..search_right {
            let score = accumulator[angle_index * gray.width() + x];
            total += score;
            bin_count += 1;
            responses.push((angle_index, x, score));
        }
    }
    let average = total as f64 / bin_count.max(1) as f64;
    responses.sort_by(|left, right| {
        right
            .2
            .cmp(&left.2)
            .then_with(|| left.0.cmp(&right.0))
            .then_with(|| left.1.cmp(&right.1))
    });
    let suppression_x = (gray.width() as f64 * 0.003).round().max(2.0);
    let suppression_slope = 0.75_f64.to_radians().tan();
    let mut candidates: Vec<FoldCandidate> = Vec::with_capacity(TOP_CUTTER_CANDIDATES);
    for (angle_index, x, response) in responses {
        if response == 0 || candidates.len() >= TOP_CUTTER_CANDIDATES {
            break;
        }
        let slope = slopes[angle_index];
        if candidates.iter().any(|candidate| {
            (candidate.x - x as f64).abs() <= suppression_x
                && (candidate.slope - slope).abs() <= suppression_slope
        }) {
            continue;
        }
        let coherence = if average > 0.0 {
            response as f64 / average
        } else {
            0.0
        };
        let line_strength = response as f64 / (gray.height() as f64 * 48.0);
        let coverage = vertical_gradient_coverage(gray, x as f64, slope);
        let score = ramp(coherence, 3.0, 14.0)
            * ramp(line_strength, 0.12, 0.75)
            * ramp(coverage, 0.04, 0.42);
        if score >= 0.04 {
            candidates.push(FoldCandidate {
                x: x as f64,
                slope,
                score,
                vertical_coverage: coverage,
                ..FoldCandidate::default()
            });
        }
    }
    candidates
}

fn fold_candidate_near_whitespace(
    gray: &GrayImage,
    votes: &FoldVotes,
    cleaned: &BinaryImage,
    whitespace: Candidate,
) -> Option<FoldCandidate> {
    let mut candidates = fold_line_candidates_in_range(
        gray,
        votes,
        whitespace.start.saturating_sub(4),
        (whitespace.end + 4).min(gray.width()),
    );
    let step = ((whitespace.end.saturating_sub(whitespace.start)) / 64).max(1);
    let vertical = (whitespace.start..whitespace.end)
        .step_by(step)
        .map(|x| x as f64)
        .filter_map(|x| vertical_boundary_candidate_at(gray, x))
        .max_by(|left, right| left.score.total_cmp(&right.score));
    if let Some(vertical) = vertical {
        candidates.push(vertical);
    }
    select_fold_candidate(cleaned, candidates)
}

fn select_fold_candidate(
    cleaned: &BinaryImage,
    mut candidates: Vec<FoldCandidate>,
) -> Option<FoldCandidate> {
    candidates.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.x.total_cmp(&right.x))
            .then_with(|| left.slope.total_cmp(&right.slope))
    });
    let group_radius = (cleaned.width() as f64 * 0.01).round().max(3.0);
    let mut scored_groups: Vec<FoldCandidate> = Vec::with_capacity(TOP_DESKEW_CANDIDATE_GROUPS);
    for candidate in &mut candidates {
        if let Some(group) = scored_groups
            .iter()
            .find(|group| (group.x - candidate.x).abs() <= group_radius)
        {
            copy_leaf_deskew_score(candidate, *group);
        } else if scored_groups.len() < TOP_DESKEW_CANDIDATE_GROUPS {
            *candidate = score_candidate_leaf_deskew(cleaned, *candidate);
            scored_groups.push(*candidate);
        }
    }
    candidates.into_iter().max_by(|left, right| {
        fold_candidate_rank(*left)
            .total_cmp(&fold_candidate_rank(*right))
            .then_with(|| right.x.total_cmp(&left.x))
            .then_with(|| right.slope.total_cmp(&left.slope))
    })
}

fn copy_leaf_deskew_score(target: &mut FoldCandidate, source: FoldCandidate) {
    target.left_deskew_angle_degrees = source.left_deskew_angle_degrees;
    target.right_deskew_angle_degrees = source.right_deskew_angle_degrees;
    target.left_deskew_confidence = source.left_deskew_confidence;
    target.right_deskew_confidence = source.right_deskew_confidence;
    target.joint_deskew_score = source.joint_deskew_score;
}

fn fold_candidate_rank(candidate: FoldCandidate) -> f64 {
    candidate.score * (1.0 + 0.12 * candidate.joint_deskew_score)
}

fn score_candidate_leaf_deskew(
    cleaned: &BinaryImage,
    mut candidate: FoldCandidate,
) -> FoldCandidate {
    let left = half_binary_for_cutter(cleaned, candidate, true);
    let right = half_binary_for_cutter(cleaned, candidate, false);
    let left_deskew = score_skew(&left);
    let right_deskew = score_skew(&right);
    candidate.left_deskew_angle_degrees = left_deskew.angle_degrees;
    candidate.right_deskew_angle_degrees = right_deskew.angle_degrees;
    candidate.left_deskew_confidence = left_deskew.confidence;
    candidate.right_deskew_confidence = right_deskew.confidence;
    candidate.joint_deskew_score = if left_deskew.accepted && right_deskew.accepted {
        0.5 + 0.5
            * ramp(
                left_deskew.confidence.min(right_deskew.confidence),
                2.0,
                6.0,
            )
    } else {
        0.0
    };
    candidate
}

fn half_binary_for_cutter(
    source: &BinaryImage,
    candidate: FoldCandidate,
    keep_left: bool,
) -> BinaryImage {
    let center_y = source.height() as f64 * 0.5;
    let boundary_at = |y: usize| candidate.x + candidate.slope * (y as f64 - center_y);
    let top = boundary_at(0);
    let bottom = boundary_at(source.height().saturating_sub(1));
    let source_left = if keep_left {
        0
    } else {
        top.min(bottom).floor().max(0.0) as usize
    };
    let source_right = if keep_left {
        top.max(bottom).ceil().min(source.width() as f64) as usize
    } else {
        source.width()
    };
    let mut half = BinaryImage::new(
        source_right.saturating_sub(source_left).max(1),
        source.height(),
    );
    for y in 0..source.height() {
        let boundary = boundary_at(y);
        for x in source_left..source_right {
            let retained = if keep_left {
                x as f64 + 0.5 < boundary
            } else {
                x as f64 + 0.5 >= boundary
            };
            if retained && source.get(x, y) {
                half.set(x - source_left, y, true);
            }
        }
    }
    half
}

fn vertical_boundary_candidate_at(gray: &GrayImage, x: f64) -> Option<FoldCandidate> {
    if gray.width() < 8 || gray.height() < 8 || x < 3.0 || x + 3.0 >= gray.width() as f64 {
        return None;
    }
    let coverage = vertical_gradient_coverage(gray, x, 0.0);
    let center = x.round() as isize;
    let mut strength = 0u64;
    for y in 1..gray.height() - 1 {
        let strongest = (-3..=3)
            .filter_map(|offset| {
                let sample = center + offset;
                if sample < 2 || sample + 2 >= gray.width() as isize {
                    return None;
                }
                let sample = sample as usize;
                let horizontal =
                    i16::from(gray.get(sample + 2, y)) - i16::from(gray.get(sample - 2, y));
                let vertical =
                    i16::from(gray.get(sample, y + 1)) - i16::from(gray.get(sample, y - 1));
                Some((horizontal.abs() - vertical.abs()).max(0) as u64)
            })
            .max()
            .unwrap_or(0);
        strength += strongest;
    }
    let mean_strength = strength as f64 / gray.height().saturating_sub(2).max(1) as f64;
    let score = ramp(coverage, 0.06, 0.40) * ramp(mean_strength, 5.0, 30.0);
    (score >= 0.04).then_some(FoldCandidate {
        x,
        score,
        vertical_coverage: coverage,
        ..FoldCandidate::default()
    })
}

fn vertical_gradient_coverage(gray: &GrayImage, center_x: f64, slope: f64) -> f64 {
    let center_y = gray.height() as f64 * 0.5;
    let mut covered = 0usize;
    for y in 1..gray.height() - 1 {
        let x = center_x + slope * (y as f64 - center_y);
        let x = x.round() as isize;
        let present = (-3..=3).any(|offset| {
            let sample = x + offset;
            if sample < 2 || sample + 2 >= gray.width() as isize {
                return false;
            }
            let sample = sample as usize;
            let horizontal =
                i16::from(gray.get(sample + 2, y)) - i16::from(gray.get(sample - 2, y));
            let vertical = i16::from(gray.get(sample, y + 1)) - i16::from(gray.get(sample, y - 1));
            horizontal.abs().saturating_sub(vertical.abs()) >= 8
        });
        covered += usize::from(present);
    }
    covered as f64 / gray.height().saturating_sub(2).max(1) as f64
}

fn refine_curved_seam(
    gray: &GrayImage,
    binary: &BinaryImage,
    center_x: f64,
    slope: f64,
) -> Option<SplitSeamPolyline> {
    if gray.width() < 8 || gray.height() < 2 || gray.width() != binary.width() {
        return None;
    }
    let band = (gray.width() as f64 * CURVED_SEAM_BAND_WIDTH_FRACTION)
        .ceil()
        .max(2.0) as usize;
    let center_y = gray.height() as f64 * 0.5;
    let ranges = (0..gray.height())
        .map(|y| {
            let predicted = center_x + slope * (y as f64 - center_y);
            let start = (predicted.floor() as isize - band as isize)
                .clamp(1, gray.width().saturating_sub(2) as isize) as usize;
            let end = (predicted.ceil() as isize + band as isize + 1)
                .clamp(start as isize + 1, gray.width().saturating_sub(1) as isize)
                as usize;
            (start, end, predicted)
        })
        .collect::<Vec<_>>();
    let (first_start, first_end, first_predicted) = ranges[0];
    let mut previous = (first_start..first_end)
        .map(|x| seam_evidence_cost(gray, binary, x, 0, first_predicted, band))
        .collect::<Vec<_>>();
    let mut predecessors = Vec::with_capacity(gray.height().saturating_sub(1));
    for y in 1..gray.height() {
        let (start, end, predicted) = ranges[y];
        let (previous_start, previous_end, _) = ranges[y - 1];
        let mut current = vec![f64::INFINITY; end - start];
        let mut row_predecessors = vec![previous_start; end - start];
        for x in start..end {
            let transition_start = x.saturating_sub(2).max(previous_start);
            let transition_end = (x + 3).min(previous_end);
            for previous_x in transition_start..transition_end {
                let smoothness = 0.10 * x.abs_diff(previous_x) as f64;
                let total = previous[previous_x - previous_start] + smoothness;
                let index = x - start;
                if total < current[index]
                    || (total == current[index] && previous_x < row_predecessors[index])
                {
                    current[index] = total;
                    row_predecessors[index] = previous_x;
                }
            }
            current[x - start] += seam_evidence_cost(gray, binary, x, y, predicted, band);
        }
        previous = current;
        predecessors.push(row_predecessors);
    }
    let (last_start, _, _) = ranges[gray.height() - 1];
    let mut x = previous
        .iter()
        .enumerate()
        .min_by(|left, right| left.1.total_cmp(right.1).then_with(|| left.0.cmp(&right.0)))
        .map(|(index, _)| last_start + index)?;
    let mut points = vec![Point::new(0.0, 0.0); gray.height()];
    for y in (0..gray.height()).rev() {
        points[y] = Point::new(x as f64 + 0.5, y as f64 + 0.5);
        if y > 0 {
            let (start, _, _) = ranges[y];
            x = predecessors[y - 1][x - start];
        }
    }
    Some(SplitSeamPolyline { points })
}

fn seam_evidence_cost(
    gray: &GrayImage,
    binary: &BinaryImage,
    x: usize,
    y: usize,
    predicted_x: f64,
    band: usize,
) -> f64 {
    let core_left = x.saturating_sub(1);
    let core_right = (x + 2).min(gray.width());
    let core = row_mean_luminance(gray, y, core_left, core_right);
    let shoulder_offset = (gray.width() as f64 * 0.010).round().max(3.0) as usize;
    let left = row_mean_luminance(
        gray,
        y,
        x.saturating_sub(shoulder_offset + 2),
        x.saturating_sub(shoulder_offset.saturating_sub(1)),
    );
    let right = row_mean_luminance(
        gray,
        y,
        (x + shoulder_offset.saturating_sub(1)).min(gray.width()),
        (x + shoulder_offset + 2).min(gray.width()),
    );
    let dark_evidence = ramp((left + right) * 0.5 - core, 2.0, 28.0);
    let ink_left = x.saturating_sub(2);
    let ink_right = (x + 3).min(binary.width());
    let ink_fraction = (ink_left..ink_right)
        .filter(|&sample_x| binary.get(sample_x, y))
        .count() as f64
        / ink_right.saturating_sub(ink_left).max(1) as f64;
    let whitespace_evidence = ramp(core, 210.0, 250.0) * (1.0 - ink_fraction);
    let evidence = dark_evidence.max(whitespace_evidence);
    let ink_penalty = 0.35 * ink_fraction * (1.0 - dark_evidence);
    let center_penalty = 0.02 * ((x as f64 - predicted_x).abs() / band.max(1) as f64);
    1.0 - evidence + ink_penalty + center_penalty
}

fn row_mean_luminance(gray: &GrayImage, y: usize, left: usize, right: usize) -> f64 {
    if left >= right || right > gray.width() {
        return 255.0;
    }
    let sum = (left..right)
        .map(|x| u64::from(gray.get(x, y)))
        .sum::<u64>();
    sum as f64 / (right - left) as f64
}

fn seam_in_source_coordinates(
    mut seam: SplitSeamPolyline,
    analysis: &AnalysisImage<'_>,
    source_width: usize,
    source_height: usize,
) -> SplitSeamPolyline {
    let inverse_deskew = (analysis.deskew_angle_degrees != 0.0).then(|| {
        let cx = analysis.gray.width() as f64 * 0.5;
        let cy = analysis.gray.height() as f64 * 0.5;
        Affine::translation(-cx, -cy)
            .then(Affine::rotation_radians(
                analysis.deskew_angle_degrees.to_radians(),
            ))
            .then(Affine::translation(cx, cy))
    });
    let scale_x = source_width as f64 / analysis.gray.width().max(1) as f64;
    let scale_y = source_height as f64 / analysis.gray.height().max(1) as f64;
    for point in &mut seam.points {
        if let Some(transform) = inverse_deskew {
            *point = transform.apply(*point);
        }
        point.x = (point.x * scale_x).clamp(0.0, source_width as f64);
        point.y = (point.y * scale_y).clamp(0.0, source_height as f64);
    }
    seam
}

fn smaller_side_empty_score(cleaned: &BinaryImage, cutter_x: f64, dpi: f64) -> f64 {
    let cutter = clamp_cutter(cleaned.width(), cutter_x);
    let boundary_band = (cleaned.width() as f64 * 0.008).round().max(2.0) as usize;
    let (left, right) = if cutter <= cleaned.width() - cutter {
        (0, cutter.saturating_sub(boundary_band))
    } else {
        (
            (cutter + boundary_band).min(cleaned.width()),
            cleaned.width(),
        )
    };
    let mut ink = 0usize;
    for y in 0..cleaned.height() {
        for x in left..right {
            ink += usize::from(cleaned.get(x, y));
        }
    }
    let area = (right - left).saturating_mul(cleaned.height());
    let dpi_scaled_speck_budget = (24.0 * (dpi / 300.0).powi(2)).round().max(4.0) as usize;
    let coverage_budget = (area as f64 * 0.0002).round() as usize;
    let budget = dpi_scaled_speck_budget.max(coverage_budget).max(1);
    if ink > budget {
        0.0
    } else {
        1.0 - 0.04 * ink as f64 / budget as f64
    }
}

/// Score a populated narrow side as an offcut only when it contains several
/// real components but substantially less ink than the retained side. This is
/// deliberately complementary to [`smaller_side_empty_score`]: a second page
/// with peer ink mass remains ineligible, while a clipped fragment carrying a
/// short column or marginal text can still be discarded at a strong boundary.
fn smaller_side_sparse_score(cleaned: &BinaryImage, cutter_x: f64) -> f64 {
    let cutter = clamp_cutter(cleaned.width(), cutter_x);
    let boundary_band = (cleaned.width() as f64 * 0.008).round().max(2.0) as usize;
    let discarded_is_left = cutter <= cleaned.width() - cutter;
    let discarded_range = if discarded_is_left {
        0..cutter.saturating_sub(boundary_band)
    } else {
        (cutter + boundary_band).min(cleaned.width())..cleaned.width()
    };
    let retained_range = if discarded_is_left {
        (cutter + boundary_band).min(cleaned.width())..cleaned.width()
    } else {
        0..cutter.saturating_sub(boundary_band)
    };
    let discarded_ink = (0..cleaned.height())
        .flat_map(|y| discarded_range.clone().map(move |x| (x, y)))
        .filter(|&(x, y)| cleaned.get(x, y))
        .count();
    let retained_ink = (0..cleaned.height())
        .flat_map(|y| retained_range.clone().map(move |x| (x, y)))
        .filter(|&(x, y)| cleaned.get(x, y))
        .count();
    if discarded_ink == 0 || retained_ink == 0 {
        return 0.0;
    }

    let components = ComponentMap::from_binary(cleaned)
        .components()
        .iter()
        .filter(|component| {
            let center = (component.left + component.right) / 2;
            discarded_range.contains(&center)
        })
        .count();
    if !(2..=64).contains(&components) {
        return 0.0;
    }

    let ink_ratio = discarded_ink as f64 / retained_ink as f64;
    ramp(components as f64, 2.0, 8.0) * ramp(0.50 - ink_ratio, 0.0, 0.35)
}

fn aligned_text_rows_score(binary: &BinaryImage, cutter_x: f64) -> f64 {
    let cutter = clamp_cutter(binary.width(), cutter_x);
    let discarded_is_left = cutter <= binary.width() - cutter;
    let boundary_band = (binary.width() as f64 * 0.008).round().max(2.0) as usize;
    let discarded_range = if discarded_is_left {
        0..cutter.saturating_sub(boundary_band)
    } else {
        (cutter + boundary_band).min(binary.width())..binary.width()
    };
    let retained_range = if discarded_is_left {
        (cutter + boundary_band).min(binary.width())..binary.width()
    } else {
        0..cutter.saturating_sub(boundary_band)
    };
    let discarded_bands = ink_row_bands(binary, discarded_range);
    if discarded_bands.is_empty() {
        0.0
    } else {
        let retained_bands = ink_row_bands(binary, retained_range);
        let aligned = discarded_bands
            .iter()
            .filter(|&&(start, end)| {
                let center_twice = start + end.saturating_sub(1);
                retained_bands.iter().any(|&(other_start, other_end)| {
                    let other_center_twice = other_start + other_end.saturating_sub(1);
                    center_twice.abs_diff(other_center_twice) <= 2
                })
            })
            .count();
        aligned as f64 / discarded_bands.len() as f64
    }
}

fn ink_row_bands(binary: &BinaryImage, range: std::ops::Range<usize>) -> Vec<(usize, usize)> {
    let mut bands = Vec::new();
    let mut start = None;
    for y in 0..binary.height() {
        let has_ink = range.clone().any(|x| binary.get(x, y));
        match (start, has_ink) {
            (None, true) => start = Some(y),
            (Some(band_start), false) => {
                bands.push((band_start, y));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(band_start) = start {
        bands.push((band_start, binary.height()));
    }
    bands
}

fn column_counts(binary: &BinaryImage) -> Vec<usize> {
    column_counts_range(binary, 0, binary.width())
}

fn column_counts_range(binary: &BinaryImage, left: usize, right: usize) -> Vec<usize> {
    let mut columns = vec![0usize; right.saturating_sub(left)];
    for y in 0..binary.height() {
        for (offset, count) in columns.iter_mut().enumerate() {
            *count += usize::from(binary.get(left + offset, y));
        }
    }
    columns
}

fn mean_luminance(gray: &GrayImage, left: usize, right: usize) -> f64 {
    if left >= right || right > gray.width() {
        return 255.0;
    }
    let mut sum = 0u64;
    let mut count = 0usize;
    for y in 0..gray.height() {
        for x in left..right {
            sum += u64::from(gray.get(x, y));
            count += 1;
        }
    }
    sum as f64 / count.max(1) as f64
}

fn ramp(value: f64, low: f64, high: f64) -> f64 {
    if high <= low {
        return f64::from(value >= high);
    }
    ((value - low) / (high - low)).clamp(0.0, 1.0)
}

fn single_confidence(diagnostics: &SplitDiagnostics) -> f64 {
    let spread_rejection = strongest_three_product([
        1.0 - diagnostics.whitespace_score,
        1.0 - diagnostics.bilateral_score,
        1.0 - diagnostics.outer_margin_score,
        1.0 - diagnostics.gutter_score,
        diagnostics.aspect_single_score,
    ]);
    let offcut_rejection = strongest_three_product([
        1.0 - diagnostics.offcut_boundary_score,
        1.0 - diagnostics.offcut_empty_score,
        1.0 - diagnostics.offcut_width_score,
        1.0 - diagnostics.offcut_no_text_rows_score,
    ]);
    spread_rejection * offcut_rejection
}

fn spread_confidence(
    whitespace: f64,
    bilateral: f64,
    outer_margins: f64,
    fold: f64,
    soft_gutter: f64,
    aspect: f64,
) -> (f64, usize) {
    let cues = [
        ramp(whitespace, 0.20, 0.80),
        ramp(bilateral, 0.08, 0.50),
        ramp(outer_margins, 0.02, 0.70),
        ramp(fold, 0.20, 0.75),
        ramp(soft_gutter, 0.20, 0.80),
        aspect,
    ];
    let independent = cues.iter().filter(|&&score| score > 0.0).count();
    let mean_strength = cues.iter().sum::<f64>() / cues.len() as f64;
    let confidence = match independent {
        6 => 0.90 + 0.10 * mean_strength,
        5 => 0.80 + 0.10 * mean_strength,
        4 => (0.55 + 0.20 * mean_strength).min(0.79),
        _ => 0.45 * mean_strength,
    };
    (confidence.clamp(0.0, 1.0), independent)
}

fn strongest_three_product<const N: usize>(mut scores: [f64; N]) -> f64 {
    scores.sort_by(f64::total_cmp);
    scores[N.saturating_sub(3)..].iter().product()
}

#[allow(clippy::too_many_arguments)]
pub fn reconcile_layout_decision(
    tier1_classification: LayoutClassification,
    tier1_confidence: f64,
    tier1_cutter_x: Option<f64>,
    candidate_cutter_ratio: Option<f64>,
    whitespace_score: f64,
    width: usize,
    height: usize,
    prior: DocumentPrior,
) -> LayoutDecision {
    let mut decision = LayoutDecision {
        classification: tier1_classification,
        confidence: tier1_confidence.clamp(0.0, 1.0),
        cutter_x: tier1_cutter_x,
        reconciliation: ReconciliationMetadata {
            tier1_verdict: tier1_classification,
            reconciled: false,
            cluster_agreement: 0.0,
        },
    };
    if prior.validate().is_err()
        || !dimension_matches(width, prior.cluster_dims.width)
        || !dimension_matches(height, prior.cluster_dims.height)
    {
        return decision;
    }

    let agreement = prior.agreement_strength.clamp(0.0, 1.0);
    if tier1_classification == prior.dominant_layout {
        decision.confidence = confidence_with_document_agreement(decision.confidence, agreement);
        decision.reconciliation.cluster_agreement = agreement;
        return decision;
    }

    let reconciled_cutter = match prior.dominant_layout {
        LayoutClassification::TwoPageSpread => {
            let median = prior
                .cutter_ratio_median
                .expect("validated spread prior has a cutter");
            candidate_cutter_ratio.and_then(|ratio| {
                let has_plausible_valley =
                    whitespace_score >= 0.15 && (0.28..=0.72).contains(&ratio);
                if !has_plausible_valley {
                    return None;
                }
                if (ratio - median).abs() <= 0.035 {
                    return Some(ratio * width as f64);
                }
                // A strong cluster prior already incorporates both dominant
                // layout support and cutter consistency. On sparse pages the
                // broadest quiet run can sit away from a faint physical seam;
                // accept any still-nearby observed valley, but use the stable
                // document median rather than the ambiguous local midpoint.
                (agreement >= 0.80 && (ratio - median).abs() <= 0.10)
                    .then_some(median * width as f64)
            })
        }
        LayoutClassification::SingleUncutPage => None,
        LayoutClassification::PageWithOffcut => {
            decision.confidence *= 1.0 - agreement * 0.5;
            decision.reconciliation.cluster_agreement = -agreement;
            return decision;
        }
    };
    let can_reconcile = prior.dominant_layout == LayoutClassification::SingleUncutPage
        || reconciled_cutter.is_some();
    if can_reconcile {
        decision.classification = prior.dominant_layout;
        decision.cutter_x = reconciled_cutter;
        decision.confidence = confidence_with_document_agreement(decision.confidence, agreement);
        decision.reconciliation.reconciled = true;
        decision.reconciliation.cluster_agreement = agreement;
    } else {
        decision.confidence *= 1.0 - agreement * 0.5;
        decision.reconciliation.cluster_agreement = -agreement;
    }
    decision
}

fn confidence_with_document_agreement(page_confidence: f64, agreement: f64) -> f64 {
    1.0 - (1.0 - page_confidence.clamp(0.0, 1.0)) * (1.0 - agreement.clamp(0.0, 1.0))
}

fn dimension_matches(actual: usize, expected: f64) -> bool {
    (actual as f64 - expected).abs() / expected.max(1.0) <= 0.02
}

fn gutter_column_profiles(gray: &GrayImage, range: std::ops::Range<usize>) -> Vec<ColumnProfile> {
    let top = gray.height() / 20;
    let bottom = gray.height() - top;
    let rows = (bottom - top).max(1);
    range
        .map(|x| {
            let mut histogram = [0u32; 256];
            let mut sum = 0u64;
            for y in top..bottom {
                let value = gray.get(x, y);
                histogram[usize::from(value)] += 1;
                sum += u64::from(value);
            }
            let share = |fraction: f64| (rows as f64 * fraction).ceil() as u32;
            ColumnProfile {
                mean: sum as f64 / rows as f64,
                bright: brightest_quantile(&histogram, share(GUTTER_BAND_PAPER_ROW_SHARE)),
                dark: darkest_quantile(&histogram, share(GUTTER_BAND_INK_ROW_SHARE)),
            }
        })
        .collect()
}

/// Measures the run of fold shadow the cutter stands in, so both leaves can
/// end at their near edge instead of carrying the fold into a page of their
/// own. The caller keeps the cutter where it was and uses the two returned
/// edges only as leaf geometry.
///
/// Each side is measured against paper from that same source leaf. The search
/// may reach [`MAX_OFFSET_GUTTER_BAND_FRACTION`] beyond the cutter, but it can
/// claim only a vertically continuous depressed run with no ink-like column.
/// The returned exclusion joins the cutter to the far edge of each proven
/// run, so an offset shadow cannot survive in the retained leaf as a pale
/// content block. A page whose fold leaves no measurable shadow yields `None`,
/// which cuts at a single column exactly as before. The band may be
/// asymmetric, since a sheet lit from one side casts its shadow mostly onto
/// one leaf.
fn gutter_shadow_band(gray: &GrayImage, cutter_x: f64) -> Option<(f64, f64)> {
    let band = gutter_shadow_band_unprotected(gray, cutter_x)?;
    Some(protect_fold_band_endpoints(gray, cutter_x, band))
}

fn gutter_shadow_band_unprotected(gray: &GrayImage, cutter_x: f64) -> Option<(f64, f64)> {
    let width = gray.width();
    let legacy_cap = (width as f64 * MAX_GUTTER_BAND_FRACTION).floor() as usize;
    let search_cap = (width as f64 * MAX_OFFSET_GUTTER_BAND_FRACTION).floor() as usize;
    let legacy_band = legacy_gutter_shadow_band(gray, cutter_x);
    let center = clamp_cutter(width, cutter_x);
    let lower = center.saturating_sub(search_cap).max(1);
    let upper = (center + search_cap).min(width.saturating_sub(1));
    if legacy_cap == 0
        || search_cap == 0
        || gray.height() < 16
        || lower >= center
        || upper <= center
    {
        return None;
    }
    // Each leaf supplies its own paper reference. A dark photograph on the
    // facing leaf must not lower the retained leaf's paper floor, which was
    // the reason the pale 125R shadow straddled every old gate. The upper
    // quartile of shoulder columns tolerates ordinary text without allowing
    // one near-white outlier to define the whole leaf.
    let shoulder_reference = |from: usize, to: usize| {
        (from < to).then(|| {
            let mut profiles = gutter_column_profiles(gray, from..to);
            profiles.sort_by(|left, right| left.mean.total_cmp(&right.mean));
            profiles[(profiles.len() - 1) * 3 / 4]
        })
    };
    let left_reference = shoulder_reference(lower.saturating_sub(legacy_cap), lower)?;
    let right_reference =
        shoulder_reference((upper + 1).min(width), (upper + legacy_cap + 1).min(width))?;
    let columns = gutter_column_profiles(gray, lower..upper + 1);
    // A shadowed column is dark over nearly its whole height and has no ink in
    // it: paper still shows through wherever glyphs are, and ink is far darker
    // than the fold it sits in. Both tests are per column, so the band can only
    // grow through columns that are shadow and nothing else.
    let shadowed = |offset: usize, reference: ColumnProfile| {
        let profile = columns[offset];
        profile.bright <= reference.bright - MIN_GUTTER_BAND_DEPRESSION
            && profile.mean - profile.dark <= GUTTER_BAND_MAX_COLUMN_CONTRAST
    };
    let center_offset = center - lower;
    let valid_run = |left_offset: usize, right_offset: usize, reference: ColumnProfile| {
        let deepest = (left_offset..=right_offset)
            .map(|offset| reference.bright - columns[offset].bright)
            .fold(f64::MIN, f64::max);
        (deepest >= MIN_GUTTER_BAND_DEPRESSION).then_some((left_offset, right_offset))
    };
    let continuous_run = |range: Box<dyn Iterator<Item = usize>>, reference: ColumnProfile| {
        let run_is_long_enough = |first: usize, last: usize| {
            let run_length = first.abs_diff(last) + 1;
            let claimed_distance = first
                .abs_diff(center_offset)
                .max(last.abs_diff(center_offset));
            let minimum_columns = search_cap
                .div_ceil(80)
                .max(2)
                .max(claimed_distance.div_ceil(4));
            run_length >= minimum_columns
        };
        let mut current: Option<(usize, usize)> = None;
        let mut runs = Vec::new();
        for offset in range {
            if columns[offset].mean - columns[offset].dark > GUTTER_BAND_MAX_COLUMN_CONTRAST + 24.0
            {
                if let Some(run) = current.take() {
                    if run_is_long_enough(run.0, run.1) {
                        runs.push(run);
                    }
                }
                break;
            }
            if shadowed(offset, reference) {
                current = Some(current.map_or((offset, offset), |(first, _)| (first, offset)));
            } else if let Some(run) = current.take() {
                if run_is_long_enough(run.0, run.1) {
                    runs.push(run);
                }
            }
        }
        if let Some(run) = current {
            if run_is_long_enough(run.0, run.1) {
                runs.push(run);
            }
        }
        runs.into_iter()
            .filter_map(|(first, last)| valid_run(first.min(last), first.max(last), reference))
            .max_by(|left, right| {
                let left_depth = (left.0..=left.1)
                    .map(|offset| reference.bright - columns[offset].bright)
                    .fold(f64::MIN, f64::max);
                let right_depth = (right.0..=right.1)
                    .map(|offset| reference.bright - columns[offset].bright)
                    .fold(f64::MIN, f64::max);
                left_depth.total_cmp(&right_depth)
            })
    };
    let left_run = continuous_run(Box::new((0..=center_offset).rev()), left_reference);
    let right_run = continuous_run(Box::new(center_offset..columns.len()), right_reference);
    let mut left_edge = left_run.map_or(center, |(first, last)| lower + first.min(last));
    let mut right_edge = right_run
        .map_or(center, |(first, last)| lower + first.max(last) + 1)
        .min(width);
    // A few extra columns beyond the legacy band are too small to establish
    // an offset fold, but large enough to move the leaf origin and perturb
    // downstream component grouping. Keep the legacy boundary in that
    // ambiguous transition; only a materially offset run may extend it. The
    // compatibility detector and clamp may be removed only after the shared
    // corpus and native integration pins prove the wider detector never
    // contracts a pre-offset band on previously covered inputs.
    let minimum_offset_extension = legacy_cap.div_ceil(8).max(4);
    if let Some((legacy_left_edge, legacy_right_edge)) = legacy_band {
        let legacy_left_edge = legacy_left_edge as usize;
        let legacy_right_edge = legacy_right_edge as usize;
        if left_edge >= legacy_left_edge || legacy_left_edge - left_edge < minimum_offset_extension
        {
            left_edge = legacy_left_edge;
        }
        if right_edge <= legacy_right_edge
            || right_edge - legacy_right_edge < minimum_offset_extension
        {
            right_edge = legacy_right_edge;
        }
    }
    (left_edge < right_edge).then_some((left_edge as f64, right_edge as f64))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FoldSupportKind {
    None,
    Confident,
    Ambiguous,
}

#[derive(Clone, Copy, Debug, Default)]
struct FoldEndpointSupport {
    kind: Option<FoldSupportKind>,
    min_x: usize,
    max_x: usize,
}

/// Keep a measured fold exclusion from swallowing source-supported material.
/// The fold detector intentionally works on grayscale columns because a
/// shadow is not ink. This second pass looks only inside the already measured
/// corridor and asks whether any dark support behaves like glyphs or repeated
/// text rows. A continuous rail or fold shadow has no such shape and leaves
/// the measured band byte-for-byte unchanged.
fn protect_fold_band_endpoints(
    gray: &GrayImage,
    cutter_x: f64,
    (left_edge, right_edge): (f64, f64),
) -> (f64, f64) {
    let cutter = clamp_cutter(gray.width(), cutter_x) as f64;
    let left_edge = left_edge.clamp(0.0, cutter);
    let right_edge = right_edge.clamp(cutter, gray.width() as f64);
    if gray.width() < 8 || gray.height() < 8 || left_edge >= right_edge {
        return (left_edge, right_edge);
    }

    let left_support = fold_endpoint_support(
        gray,
        left_edge.round().clamp(0.0, cutter) as usize,
        cutter as usize,
    );
    let right_support = fold_endpoint_support(
        gray,
        cutter as usize,
        right_edge.round().clamp(cutter, gray.width() as f64) as usize,
    );

    let left_edge = match left_support.kind {
        Some(FoldSupportKind::Confident) => (left_edge.round() as usize
            + left_support.max_x.saturating_add(1))
        .min(cutter as usize) as f64,
        Some(FoldSupportKind::Ambiguous) => cutter,
        Some(FoldSupportKind::None) | None => left_edge,
    };
    let right_edge = match right_support.kind {
        Some(FoldSupportKind::Confident) => {
            (right_edge.round() as usize).min(cutter as usize + right_support.min_x) as f64
        }
        Some(FoldSupportKind::Ambiguous) => cutter,
        Some(FoldSupportKind::None) | None => right_edge,
    };
    (left_edge, right_edge)
}

fn fold_endpoint_support(gray: &GrayImage, left: usize, right: usize) -> FoldEndpointSupport {
    if left >= right || right > gray.width() || gray.height() == 0 {
        return FoldEndpointSupport::default();
    }
    let width = right - left;
    let height = gray.height();
    let max_dark_pixels_per_column =
        (height as f64 * FOLD_SUPPORT_MAX_COLUMN_FRACTION).ceil() as usize;
    let profiles = gutter_column_profiles(gray, left..right);
    let mut support_mask = BinaryImage::new(width, height);
    let mut column_dark = vec![0usize; width];
    let mut dark_pixels = 0usize;
    let mut min_x = width;
    let mut max_x = 0;
    let mut row_has_support = vec![false; height];
    // A fold shadow can lower the whole corridor enough that its aggregate
    // quantile contrast looks flat even when a glyph is present. Use the
    // per-pixel threshold as the first test. The occupancy cap below still
    // rejects a continuous rail or shadow before it can become support.
    for (offset, x) in (left..right).enumerate() {
        let profile = profiles[offset];
        let support_threshold = profile.mean - FOLD_SUPPORT_PIXEL_CONTRAST;
        if support_threshold <= 0.0 {
            continue;
        }
        for y in 0..height {
            if f64::from(gray.get(x, y)) < support_threshold {
                column_dark[offset] += 1;
            }
        }
    }
    for (offset, x) in (left..right).enumerate() {
        let profile = profiles[offset];
        let support_threshold = profile.mean - FOLD_SUPPORT_PIXEL_CONTRAST;
        if column_dark[offset] == 0 || column_dark[offset] > max_dark_pixels_per_column {
            continue;
        }
        for (y, row_support) in row_has_support.iter_mut().enumerate() {
            if f64::from(gray.get(x, y)) >= support_threshold {
                // A continuously dark column is a rail or shadow, not a
                // glyph. It is excluded before row support is counted.
                continue;
            }
            dark_pixels += 1;
            min_x = min_x.min(offset);
            max_x = max_x.max(offset);
            *row_support = true;
            support_mask.set(offset, y, true);
        }
    }
    if dark_pixels == 0 {
        return FoldEndpointSupport::default();
    }

    let mut row_bands = Vec::new();
    let mut row_start = None;
    for (y, &has_support) in row_has_support.iter().enumerate() {
        match (row_start, has_support) {
            (None, true) => row_start = Some(y),
            (Some(start), false) => {
                row_bands.push((start, y));
                row_start = None;
            }
            _ => {}
        }
    }
    if let Some(start) = row_start {
        row_bands.push((start, height));
    }

    let components = ComponentMap::from_binary(&support_mask);
    let max_component_width = (gray.width() as f64 * FOLD_SUPPORT_MAX_COMPONENT_WIDTH_FRACTION)
        .ceil()
        .max(3.0) as usize;
    let max_component_height = (height as f64 * FOLD_SUPPORT_MAX_COMPONENT_HEIGHT_FRACTION)
        .ceil()
        .max(3.0) as usize;
    let max_component_area =
        (gray.width() as f64 * height as f64 * FOLD_SUPPORT_MAX_COMPONENT_AREA_FRACTION)
            .ceil()
            .max(8.0) as usize;
    let glyph_like_components = components
        .components()
        .iter()
        .filter(|component| {
            component.right < width
                && component.left < width
                && component.right - component.left < max_component_width
                && component.bottom - component.top < max_component_height
                && component.area <= max_component_area
        })
        .count();
    let max_row_height = (height as f64 * FOLD_SUPPORT_MAX_ROW_HEIGHT_FRACTION)
        .ceil()
        .max(3.0) as usize;
    let short_support_rows = row_bands
        .iter()
        .all(|&(top, bottom)| bottom.saturating_sub(top) <= max_row_height);
    // Require separated, glyph-sized rows for confident support. This keeps a
    // textured scanner shadow from shrinking the measured fold band.
    let repeated_rows = row_bands.len() >= FOLD_SUPPORT_MIN_REPEATED_ROWS
        && row_bands.len() as f64 / height as f64 <= 0.55
        && short_support_rows;
    let glyph_like = glyph_like_components >= 2 && short_support_rows;
    let confident = repeated_rows || glyph_like;
    let fill = dark_pixels as f64 / (width * height) as f64;
    let ambiguous = !confident
        && fill <= FOLD_SUPPORT_AMBIGUOUS_FILL
        && glyph_like_components <= 2
        && short_support_rows
        && components.components().iter().any(|component| {
            component.right < width
                && component.left < width
                && component.right - component.left < max_component_width
                && component.bottom - component.top < max_component_height
                && component.area <= max_component_area
        });
    FoldEndpointSupport {
        kind: Some(if confident {
            FoldSupportKind::Confident
        } else if ambiguous {
            FoldSupportKind::Ambiguous
        } else {
            FoldSupportKind::None
        }),
        min_x,
        max_x,
    }
}

/// Replays the pre-offset measurement as a stability reference. The wider
/// detector may supersede it only when the newly claimed distance is large
/// enough to establish an offset fold rather than a reference-sensitive edge.
fn legacy_gutter_shadow_band(gray: &GrayImage, cutter_x: f64) -> Option<(f64, f64)> {
    let width = gray.width();
    let cap = (width as f64 * MAX_GUTTER_BAND_FRACTION).floor() as usize;
    let center = clamp_cutter(width, cutter_x);
    let lower = center.saturating_sub(cap).max(1);
    let upper = (center + cap).min(width.saturating_sub(1));
    if cap == 0 || gray.height() < 16 || lower >= center || upper <= center {
        return None;
    }
    let shoulder_reference = |from: usize, to: usize| {
        (from < to).then(|| {
            let count = (to - from) as f64;
            gutter_column_profiles(gray, from..to).into_iter().fold(
                ColumnProfile::default(),
                |sums, profile| ColumnProfile {
                    mean: sums.mean + profile.mean / count,
                    bright: sums.bright + profile.bright / count,
                    dark: sums.dark + profile.dark / count,
                },
            )
        })
    };
    let left_reference = shoulder_reference(lower.saturating_sub(cap), lower)?;
    let right_reference = shoulder_reference((upper + 1).min(width), (upper + cap + 1).min(width))?;
    let reference = left_reference.mean.min(right_reference.mean);
    let paper_limit =
        left_reference.bright.min(right_reference.bright) - MIN_GUTTER_BAND_DEPRESSION;
    let columns = gutter_column_profiles(gray, lower..upper + 1);
    let shadowed = |offset: usize| {
        let profile = columns[offset];
        profile.bright <= paper_limit
            && profile.mean - profile.dark <= GUTTER_BAND_MAX_COLUMN_CONTRAST
    };
    let center_offset = center - lower;
    let valid_run = |left_offset: usize, right_offset: usize| {
        let deepest = (left_offset..=right_offset)
            .map(|offset| reference - columns[offset].mean)
            .fold(f64::MIN, f64::max);
        (deepest >= MIN_GUTTER_BAND_DEPRESSION).then_some((left_offset, right_offset, deepest))
    };
    let anchored_run = |direction: isize| {
        let mut offset = center_offset as isize + direction;
        let mut first_shadow: Option<usize> = None;
        let mut last_shadow: Option<usize> = None;
        let mut consecutive_shadow = 0usize;
        let mut longest_shadow = 0usize;
        while offset >= 0 && (offset as usize) < columns.len() {
            let current = offset as usize;
            if current.abs_diff(center_offset) > cap {
                break;
            }
            let profile = columns[current];
            if profile.mean - profile.dark > GUTTER_BAND_MAX_COLUMN_CONTRAST + 24.0 {
                break;
            }
            if shadowed(current) {
                first_shadow = Some(first_shadow.map_or(current, |first| first.min(current)));
                last_shadow = Some(last_shadow.map_or(current, |last| last.max(current)));
                consecutive_shadow += 1;
                longest_shadow = longest_shadow.max(consecutive_shadow);
            } else {
                consecutive_shadow = 0;
            }
            offset += direction;
        }
        (longest_shadow >= 2).then(|| {
            valid_run(
                first_shadow.expect("a shadow run has a first column"),
                last_shadow.expect("a shadow run has a last column"),
            )
        })?
    };

    let run = if shadowed(center_offset) {
        let mut left_offset = center_offset;
        while left_offset > 0 && shadowed(left_offset - 1) {
            left_offset -= 1;
        }
        let mut right_offset = center_offset;
        while right_offset + 1 < columns.len() && shadowed(right_offset + 1) {
            right_offset += 1;
        }
        valid_run(left_offset, right_offset)
    } else {
        let left = anchored_run(-1);
        let right = anchored_run(1);
        match (left, right) {
            (Some(left), Some(right)) => Some((left.0, right.1, left.2.max(right.2))),
            (Some(left), None) => Some((left.0, center_offset, left.2)),
            (None, Some(right)) => Some((center_offset, right.1, right.2)),
            (None, None) => None,
        }
    }?;
    let left_edge = lower + run.0;
    let right_edge = (lower + run.1 + 1)
        .min(center.saturating_add(cap))
        .min(width);
    (left_edge < right_edge).then_some((left_edge as f64, right_edge as f64))
}

/// The luminance at or above which `target` rows of the column sit.
fn brightest_quantile(histogram: &[u32; 256], target: u32) -> f64 {
    let mut seen = 0u32;
    for (value, count) in histogram.iter().enumerate().rev() {
        seen += count;
        if seen >= target {
            return value as f64;
        }
    }
    0.0
}

/// The luminance at or below which `target` rows of the column sit.
fn darkest_quantile(histogram: &[u32; 256], target: u32) -> f64 {
    let mut seen = 0u32;
    for (value, count) in histogram.iter().enumerate() {
        seen += count;
        if seen >= target {
            return value as f64;
        }
    }
    255.0
}

fn clamp_cutter(width: usize, cutter_x: f64) -> usize {
    cutter_x.round().clamp(1.0, width.saturating_sub(1) as f64) as usize
}

fn scale_x(x: f64, from_width: usize, to_width: usize) -> f64 {
    x / from_width.max(1) as f64 * to_width as f64
}

/// The result detection returns for an already-resolved single-region layout,
/// without inspecting pixels.
pub(crate) fn single_page(width: usize, height: usize) -> SplitResult {
    single(width, height, 1.0, SplitDiagnostics::default())
}

fn single(
    width: usize,
    height: usize,
    confidence: f64,
    mut diagnostics: SplitDiagnostics,
) -> SplitResult {
    diagnostics.fold_band = FoldBand::unmeasured(FoldBandUnmeasuredReason::NotApplicable);
    let reconciliation = ReconciliationMetadata {
        tier1_verdict: LayoutClassification::SingleUncutPage,
        reconciled: false,
        cluster_agreement: 0.0,
    };
    SplitResult {
        classification: LayoutClassification::SingleUncutPage,
        confidence,
        cutter_x: None,
        pages: vec![page_polygon(0.0, width as f64, height)],
        split_seam: None,
        diagnostics,
        reconciliation,
        reusable_binary: None,
    }
}

fn split_at(
    width: usize,
    height: usize,
    x: f64,
    fold_band: FoldBand,
    classification: LayoutClassification,
    confidence: f64,
    mut diagnostics: SplitDiagnostics,
) -> SplitResult {
    diagnostics.fold_band = fold_band;
    let reconciliation = ReconciliationMetadata {
        tier1_verdict: classification,
        reconciled: false,
        cluster_agreement: 0.0,
    };
    SplitResult {
        classification,
        confidence,
        cutter_x: Some(x),
        pages: leaf_polygons(width, height, x, fold_band),
        split_seam: None,
        diagnostics,
        reconciliation,
        reusable_binary: None,
    }
}

fn leaf_polygons(width: usize, height: usize, x: f64, fold_band: FoldBand) -> Vec<Polygon> {
    let (left_edge, right_edge) = fold_band.edges(x, width);
    vec![
        page_polygon(0.0, left_edge, height),
        page_polygon(right_edge, width as f64, height),
    ]
}

fn page_polygon(left: f64, right: f64, height: usize) -> Polygon {
    Polygon {
        points: vec![
            Point::new(left, 0.0),
            Point::new(right, 0.0),
            Point::new(right, height as f64),
            Point::new(left, height as f64),
        ],
    }
}

fn mode_classification(mode: LayoutMode) -> LayoutClassification {
    match mode {
        LayoutMode::PageWithOffcut | LayoutMode::KeepLeft | LayoutMode::KeepRight => {
            LayoutClassification::PageWithOffcut
        }
        LayoutMode::TwoPage => LayoutClassification::TwoPageSpread,
        LayoutMode::Auto | LayoutMode::Single => LayoutClassification::SingleUncutPage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measured_fold_edges_clamp_an_inconsistent_cutter_to_the_image() {
        let band = FoldBand::measured(10.0, 90.0);

        assert_eq!(band.edges(-5.0, 100), (0.0, 90.0));
        assert_eq!(band.edges(105.0, 100), (10.0, 100.0));
    }

    fn measured_fold_edges(split: &SplitResult) -> (f64, f64) {
        match split.diagnostics.fold_band {
            FoldBand::Measured {
                left_x_px,
                right_x_px,
            } => (left_x_px, right_x_px),
            other => panic!("expected a measured fold band, got {other:?}"),
        }
    }

    fn add_text_lines(gray: &mut GrayImage, x1: usize, x2: usize) {
        for y in (28..gray.height().saturating_sub(28)).step_by(18) {
            for x in x1..x2 {
                gray.set(x, y, 20);
                gray.set(x, y + 1, 20);
            }
        }
    }

    fn add_vertical_fold(gray: &mut GrayImage, x: usize) {
        for y in 4..gray.height().saturating_sub(4) {
            gray.set(x, y, 95);
            if x + 1 < gray.width() {
                gray.set(x + 1, y, 175);
            }
        }
    }

    fn ruled_index_fixture(rule_x: usize) -> GrayImage {
        let mut gray = GrayImage::new(900, 760, 245);
        add_text_lines(&mut gray, 80, 145);
        add_text_lines(&mut gray, 215, 850);
        for y in 4..gray.height().saturating_sub(4) {
            gray.set(rule_x, y, 72);
            gray.set(rule_x + 1, y, 165);
        }
        gray
    }

    fn scanner_shadow_fixture(shadow_x: usize) -> GrayImage {
        let mut gray = GrayImage::new(900, 760, 245);
        add_text_lines(&mut gray, 42, 858);
        for y in 4..gray.height().saturating_sub(4) {
            for x in shadow_x.saturating_sub(5)..=(shadow_x + 5).min(gray.width() - 1) {
                let distance = x.abs_diff(shadow_x) as u8;
                gray.set(x, y, 112 + distance * 15);
            }
        }
        gray
    }

    fn add_sparse_title(gray: &mut GrayImage, left: usize, right: usize) {
        let center = (left + right) / 2;
        let half_width = (right - left) / 9;
        for y in (gray.height() * 2 / 5..gray.height() * 3 / 5).step_by(14) {
            for x in center.saturating_sub(half_width)..(center + half_width).min(gray.width()) {
                gray.set(x, y, 35);
                if y + 1 < gray.height() {
                    gray.set(x, y + 1, 35);
                }
            }
        }
    }

    fn add_faint_surface_valley(gray: &mut GrayImage, x: usize) {
        for y in 5..gray.height().saturating_sub(5) {
            for sample_x in x.saturating_sub(8)..=(x + 8).min(gray.width() - 1) {
                gray.set(sample_x, y, gray.get(sample_x, y).saturating_sub(3));
            }
        }
    }

    fn add_sloped_fold(gray: &mut GrayImage, center_x: f64, angle_degrees: f64, value: u8) {
        let slope = angle_degrees.to_radians().tan();
        let center_y = gray.height() as f64 * 0.5;
        for y in 4..gray.height().saturating_sub(4) {
            let x = (center_x + slope * (y as f64 - center_y)).round() as usize;
            if x > 0 && x + 1 < gray.width() {
                gray.set(x, y, value);
                gray.set(x + 1, y, value.saturating_add(70));
            }
        }
    }

    fn add_slanted_binary_lines(
        binary: &mut BinaryImage,
        left: usize,
        right: usize,
        angle_degrees: f64,
    ) {
        let slope = angle_degrees.to_radians().tan();
        let center_x = (left + right) as f64 * 0.5;
        for base_y in (24..binary.height().saturating_sub(24)).step_by(18) {
            for x in left..right {
                let y = (base_y as f64 + slope * (x as f64 - center_x)).round() as isize;
                for offset in 0..3 {
                    let sample_y = y + offset;
                    if sample_y >= 0 && sample_y < binary.height() as isize {
                        binary.set(x, sample_y as usize, true);
                    }
                }
            }
        }
    }

    #[test]
    fn locates_known_two_page_gutter() {
        let mut gray = GrayImage::new(360, 240, 245);
        add_text_lines(&mut gray, 20, 160);
        add_text_lines(&mut gray, 202, 340);
        add_vertical_fold(&mut gray, 180);
        let result = detect_split(&gray, 300.0, LayoutMode::Auto, None);
        assert_eq!(result.classification, LayoutClassification::TwoPageSpread);
        assert!(
            (result.cutter_x.unwrap() - 181.0).abs() <= 5.0,
            "{result:?}"
        );
        assert!(result.confidence > 0.0);
        assert!(result.diagnostics.whitespace_gate_passed, "{result:?}");
        assert!(
            result.diagnostics.central_position_gate_passed,
            "{result:?}"
        );
        assert!(result.diagnostics.bilateral_gate_passed, "{result:?}");
        assert!(result.diagnostics.outer_margin_gate_passed, "{result:?}");
        assert!(result.diagnostics.gutter_gate_passed, "{result:?}");
        assert!(
            result.diagnostics.independent_gutter_gate_passed,
            "{result:?}"
        );
        assert!(result.diagnostics.aspect_support_gate_passed, "{result:?}");
        assert!(
            result.diagnostics.evidence_agreement_gate_passed,
            "{result:?}"
        );
        let seam = result.split_seam.as_ref().unwrap();
        assert!(seam.points.len() >= gray.height() / 3);
        assert!(seam.points.last().unwrap().y >= gray.height() as f64 - 3.0);
        assert_eq!(result.confidence, result.diagnostics.evidence_product);
        if result.confidence == 1.0 {
            let agreeing = [
                result.diagnostics.whitespace_score,
                result.diagnostics.bilateral_score,
                result.diagnostics.outer_margin_score,
                result.diagnostics.gutter_score,
            ]
            .into_iter()
            .filter(|&score| score >= 0.95)
            .count();
            assert!(agreeing >= 3, "{result:?}");
        }
    }

    #[test]
    fn one_contaminated_outer_edge_uses_strict_local_recovery() {
        let bilateral = BilateralScore {
            score: 0.82,
            left: SideScore {
                page_score: 0.86,
                surface_score: 0.72,
                ..SideScore::default()
            },
            right: SideScore {
                page_score: 0.88,
                surface_score: 0.74,
                ..SideScore::default()
            },
        };
        let recovered = outer_margin_recovery_edge(
            OuterMarginScores {
                left: 0.0,
                right: 0.64,
            },
            bilateral,
            450.0,
            900,
            0.80,
            0.72,
            0.0,
            0.78,
            1.0,
            0.80,
            true,
            true,
            true,
        );
        assert_eq!(recovered, Some(OuterMarginSide::Left));
    }

    #[test]
    fn one_contaminated_outer_edge_recovers_an_observed_spread() {
        let mut gray = GrayImage::new(660, 420, 245);
        add_text_lines(&mut gray, 0, 300);
        for y in 0..gray.height() {
            for x in 29..39 {
                gray.set(x, y, 245);
            }
        }
        add_text_lines(&mut gray, 360, 625);
        add_vertical_fold(&mut gray, 330);
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::TwoPageSpread,
            "{result:#?}"
        );
        assert!(
            result.diagnostics.outer_margin_recovery,
            "left={} right={} bilateral={} page={}..{} surface={}..{} gutter={} fold={} agreement={} aspect={} whitespace={} central={} evidence={}",
            result.diagnostics.left_outer_margin_score,
            result.diagnostics.right_outer_margin_score,
            result.diagnostics.bilateral_score,
            result.diagnostics.left_page_score,
            result.diagnostics.right_page_score,
            result.diagnostics.left_surface_score,
            result.diagnostics.right_surface_score,
            result.diagnostics.gutter_score,
            result.diagnostics.fold_score,
            result.diagnostics.agreement_score,
            result.diagnostics.aspect_spread_score,
            result.diagnostics.whitespace_score,
            result.diagnostics.central_position_gate_passed,
            result.diagnostics.evidence_agreement_gate_passed,
        );
        assert_eq!(
            result.diagnostics.outer_margin_weak_edge,
            Some(OuterMarginSide::Left),
            "{result:#?}"
        );
        let (_, expected_independent_spread_cues) = spread_confidence(
            result.diagnostics.whitespace_score,
            result.diagnostics.bilateral_score,
            result.diagnostics.right_outer_margin_score,
            result.diagnostics.fold_score,
            result.diagnostics.soft_gutter_score,
            result.diagnostics.aspect_spread_score,
        );
        assert_eq!(
            result.diagnostics.independent_spread_cues,
            expected_independent_spread_cues,
        );
        assert_eq!(result.confidence, result.diagnostics.evidence_product);
    }

    #[test]
    fn two_weak_outer_edges_do_not_use_local_recovery() {
        let bilateral = BilateralScore {
            score: 0.82,
            left: SideScore {
                page_score: 0.86,
                surface_score: 0.72,
                ..SideScore::default()
            },
            right: SideScore {
                page_score: 0.88,
                surface_score: 0.74,
                ..SideScore::default()
            },
        };
        let recovered = outer_margin_recovery_edge(
            OuterMarginScores {
                left: 0.0,
                right: 0.0,
            },
            bilateral,
            450.0,
            900,
            0.80,
            0.72,
            0.0,
            0.78,
            1.0,
            0.80,
            true,
            true,
            true,
        );
        assert_eq!(recovered, None);
    }

    #[test]
    fn manual_cutter_in_auto_mode_remains_a_two_page_spread() {
        let gray = GrayImage::new(300, 180, 245);
        let result = detect_split(&gray, 300.0, LayoutMode::Auto, Some(151.0));
        assert_eq!(result.classification, LayoutClassification::TwoPageSpread);
        assert_eq!(result.cutter_x, Some(151.0));
        assert_eq!(result.pages.len(), 2);
        assert!(result.split_seam.is_none());
    }

    #[test]
    fn fold_candidates_retain_their_direct_slope_response() {
        let mut gray = GrayImage::new(480, 320, 245);
        add_sloped_fold(&mut gray, 240.0, 4.0, 65);
        let candidates = fold_line_candidates_in_range(&gray, &build_fold_votes(&gray), 200, 280);
        let best = candidates
            .into_iter()
            .max_by(|left, right| left.score.total_cmp(&right.score))
            .unwrap();
        assert!((best.x - 240.0).abs() <= 3.0, "{best:?}");
        assert!(
            (best.slope - 4.0_f64.to_radians().tan()).abs()
                <= CUTTER_ANGLE_STEP_DEGREES.to_radians().tan(),
            "{best:?}"
        );
    }

    #[test]
    fn document_prior_biases_the_fold_search_window() {
        let mut gray = GrayImage::new(500, 320, 245);
        for y in (4..gray.height().saturating_sub(4)).step_by(4) {
            gray.set(200, y, 115);
            gray.set(201, y, 185);
        }
        add_sloped_fold(&mut gray, 300.0, 0.0, 35);
        let votes = build_fold_votes(&gray);
        let unconstrained = fold_line_candidate(&gray, &votes, None).unwrap();
        let prior_guided = fold_line_candidate(&gray, &votes, Some((0.40, 1.0))).unwrap();
        assert!((unconstrained.x - 300.0).abs() <= 4.0, "{unconstrained:?}");
        assert!((prior_guided.x - 200.0).abs() <= 4.0, "{prior_guided:?}");
    }

    #[test]
    fn per_leaf_deskew_scores_opposing_leaf_angles() {
        let mut binary = BinaryImage::new(420, 300);
        add_slanted_binary_lines(&mut binary, 18, 190, 3.0);
        add_slanted_binary_lines(&mut binary, 230, 402, -3.0);
        let candidate = score_candidate_leaf_deskew(
            &binary,
            FoldCandidate {
                x: 210.0,
                score: 1.0,
                ..FoldCandidate::default()
            },
        );
        assert!(candidate.joint_deskew_score >= 0.5, "{candidate:?}");
        assert!(
            candidate.left_deskew_angle_degrees * candidate.right_deskew_angle_degrees < 0.0,
            "{candidate:?}"
        );
    }

    #[test]
    fn curved_seam_dynamic_program_tracks_a_non_vertical_gutter_with_crossing_text() {
        let mut gray = GrayImage::new(320, 220, 238);
        let mut binary = BinaryImage::new(320, 220);
        let expected = (0..gray.height())
            .map(|y| 160.0 + 4.0 * (std::f64::consts::TAU * y as f64 / gray.height() as f64).sin())
            .collect::<Vec<_>>();
        for (y, &x) in expected.iter().enumerate() {
            let x = x.round() as usize;
            gray.set(x, y, 45);
            binary.set(x, y, true);
        }
        for y in (24..gray.height().saturating_sub(24)).step_by(18) {
            let center = expected[y].round() as usize;
            for x in center.saturating_sub(14)..=center.saturating_sub(9) {
                gray.set(x, y, 35);
                if y + 1 < gray.height() {
                    gray.set(x, y + 1, 35);
                }
            }
            for x in center.saturating_add(9)..=(center + 14).min(gray.width() - 1) {
                gray.set(x, y, 35);
                if y + 1 < gray.height() {
                    gray.set(x, y + 1, 35);
                }
            }
        }
        let seam = refine_curved_seam(&gray, &binary, 160.0, 0.0).unwrap();
        let seam_error = seam
            .points
            .iter()
            .zip(&expected)
            .map(|(point, expected_x)| (point.x - expected_x).abs())
            .sum::<f64>()
            / expected.len() as f64;
        let straight_error = expected
            .iter()
            .map(|expected_x| (160.0 - expected_x).abs())
            .sum::<f64>()
            / expected.len() as f64;
        assert!(seam_error < 1.0, "seam error {seam_error}");
        assert!(seam_error < straight_error * 0.5);
    }

    #[test]
    fn manual_override_is_authoritative() {
        let gray = GrayImage::new(200, 100, 255);
        let result = detect_split(&gray, 300.0, LayoutMode::TwoPage, Some(84.0));
        assert_eq!(result.cutter_x, Some(84.0));
        assert_eq!(result.confidence, 1.0);
    }

    #[test]
    fn a_fold_without_two_page_bodies_abstains() {
        let mut gray = GrayImage::new(360, 240, 235);
        add_vertical_fold(&mut gray, 180);
        let result = detect_split(&gray, 300.0, LayoutMode::Auto, None);
        assert_eq!(result.classification, LayoutClassification::SingleUncutPage);
        assert!(result.diagnostics.abstained);
    }

    #[test]
    fn portrait_two_column_page_is_not_a_spread() {
        let mut gray = GrayImage::new(300, 460, 245);
        add_text_lines(&mut gray, 24, 136);
        add_text_lines(&mut gray, 164, 276);
        add_vertical_fold(&mut gray, 150);
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(result.classification, LayoutClassification::SingleUncutPage);
        assert!(result.diagnostics.bilateral_score < 0.32, "{result:?}");
    }

    #[test]
    fn whitespace_without_gutter_evidence_is_not_a_spread() {
        let mut gray = GrayImage::new(660, 420, 245);
        add_text_lines(&mut gray, 35, 300);
        add_text_lines(&mut gray, 360, 625);
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::SingleUncutPage,
            "{result:?}"
        );
        assert!(result.diagnostics.abstained, "{result:?}");
        assert_eq!(result.diagnostics.soft_gutter_score, 0.0, "{result:?}");
        assert!(result.diagnostics.aspect_spread_score > 0.0, "{result:?}");
    }

    #[test]
    fn soft_shadow_gutter_counts_without_a_crisp_fold_line() {
        let mut gray = GrayImage::new(660, 420, 245);
        add_text_lines(&mut gray, 35, 300);
        add_text_lines(&mut gray, 360, 625);
        for y in 8..gray.height().saturating_sub(8) {
            for x in 316usize..=344 {
                let distance = x.abs_diff(330) as f64;
                let darkness = ((1.0_f64 - distance / 15.0).max(0.0) * 25.0).round() as u8;
                gray.set(x, y, 245 - darkness);
            }
        }
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::TwoPageSpread,
            "{result:?}"
        );
        assert!(result.diagnostics.soft_gutter_score >= 0.25, "{result:?}");
        assert!(
            result.diagnostics.soft_gutter_coverage >= 0.75,
            "{result:?}"
        );
        // The cut runs along the shadow's right edge, so the fold sits between
        // Measuring the shadow leaves the cut itself where it was; only the
        // left leaf pulls back into the fold.
        let cutter = result.cutter_x.unwrap();
        assert!((cutter - 330.0).abs() <= 8.0);
        let (gutter_left, gutter_right) = measured_fold_edges(&result);
        assert!(gutter_left < cutter, "{gutter_left}..{cutter}");
        assert!(
            cutter - gutter_left <= 660.0 * MAX_GUTTER_BAND_FRACTION,
            "{gutter_left}..{cutter}"
        );
        assert!(gutter_right > cutter, "{cutter}..{gutter_right}");
        assert!(
            gutter_right - cutter <= 660.0 * MAX_GUTTER_BAND_FRACTION,
            "{cutter}..{gutter_right}"
        );
    }

    #[test]
    fn coherent_faint_valley_recovers_a_sparse_title_spread() {
        let mut gray = GrayImage::new(660, 420, 245);
        add_sparse_title(&mut gray, 24, 310);
        add_sparse_title(&mut gray, 350, 636);
        add_faint_surface_valley(&mut gray, 330);

        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::TwoPageSpread,
            "{result:#?}"
        );
        assert!(result.diagnostics.sparse_spread_recovered, "{result:#?}");
        assert!(!result.diagnostics.gutter_gate_passed, "{result:#?}");
        assert!(
            !result.diagnostics.independent_gutter_gate_passed,
            "{result:#?}"
        );
        assert_eq!(result.diagnostics.gutter_darkness_score, 0.0, "{result:#?}");
        assert_eq!(result.diagnostics.soft_gutter_score, 0.0, "{result:#?}");
        assert!(
            result.diagnostics.sparse_gutter_score >= 0.35,
            "{result:#?}"
        );
        assert!(
            result.diagnostics.sparse_gutter_mean_depression >= 0.80,
            "{result:#?}"
        );
        assert!((result.cutter_x.unwrap() - 330.0).abs() <= 12.0);
    }

    #[test]
    fn landscape_single_without_a_central_valley_is_not_sparse_recovered() {
        let mut gray = GrayImage::new(660, 420, 245);
        for y in (30..390).step_by(16) {
            for x in 28..632 {
                gray.set(x, y, 35);
                gray.set(x, y + 1, 35);
            }
        }
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::SingleUncutPage,
            "{result:#?}"
        );
        assert!(!result.diagnostics.sparse_spread_recovered);
    }

    #[test]
    fn disagreeing_fold_and_whitespace_abstain() {
        let mut gray = GrayImage::new(660, 420, 245);
        add_text_lines(&mut gray, 35, 300);
        add_text_lines(&mut gray, 360, 625);
        add_vertical_fold(&mut gray, 240);
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::SingleUncutPage,
            "{result:?}"
        );
        assert!(result.diagnostics.abstained, "{result:?}");
        assert!(result.diagnostics.agreement_score < 1.0, "{result:?}");
    }

    #[test]
    fn split_analysis_deskews_before_collecting_cues() {
        let mut level = GrayImage::new(660, 420, 245);
        add_text_lines(&mut level, 35, 300);
        add_text_lines(&mut level, 360, 625);
        add_vertical_fold(&mut level, 330);
        let tilted = rotate_gray(&level, 3.0);
        let result = detect_split(&tilted, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::TwoPageSpread,
            "{result:?}"
        );
        assert!(
            result.diagnostics.deskew_angle_degrees.abs() >= 2.0,
            "{result:?}"
        );
        assert!((result.cutter_x.unwrap() - 330.0).abs() <= 12.0);
    }

    #[test]
    fn aligned_rows_prevent_discarding_a_narrow_side() {
        let mut gray = GrayImage::new(660, 936, 245);
        add_text_lines(&mut gray, 45, 530);
        add_vertical_fold(&mut gray, 570);
        for y in (28..gray.height().saturating_sub(28)).step_by(18).take(10) {
            gray.set(610, y, 20);
        }
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::SingleUncutPage,
            "{result:?}"
        );
        assert!(result.diagnostics.offcut_empty_score >= 0.95, "{result:?}");
        assert!(
            result.diagnostics.offcut_no_text_rows_score < 0.90,
            "{result:?}"
        );
    }

    #[test]
    fn auto_layout_distinguishes_real_margin_spread_and_empty_offcut() {
        let mut margin = GrayImage::new(660, 936, 245);
        add_text_lines(&mut margin, 45, 530);
        add_text_lines(&mut margin, 600, 635);
        let margin = detect_split(&margin, 150.0, LayoutMode::Auto, None);
        assert_eq!(margin.classification, LayoutClassification::SingleUncutPage);

        let mut spread = GrayImage::new(660, 420, 245);
        add_text_lines(&mut spread, 35, 300);
        add_text_lines(&mut spread, 360, 625);
        add_vertical_fold(&mut spread, 330);
        let spread = detect_split(&spread, 150.0, LayoutMode::Auto, None);
        assert_eq!(spread.classification, LayoutClassification::TwoPageSpread);

        let mut offcut = GrayImage::new(660, 936, 245);
        add_text_lines(&mut offcut, 45, 530);
        add_vertical_fold(&mut offcut, 570);
        let offcut = detect_split(&offcut, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            offcut.classification,
            LayoutClassification::PageWithOffcut,
            "{offcut:?}"
        );
        assert!(offcut.confidence > 0.0 && offcut.confidence < 1.0);
        assert_eq!(offcut.confidence, offcut.diagnostics.evidence_product);
    }

    #[test]
    fn populated_offcut_uses_its_dark_boundary_and_sparse_secondary_strip() {
        fn add_glyph(
            image: &mut GrayImage,
            left: usize,
            top: usize,
            width: usize,
            height: usize,
            value: u8,
        ) {
            for y in top..top + height {
                for x in left..left + 3.min(width) {
                    image.set(x, y, value);
                }
            }
            for y in top..top + 3.min(height) {
                for x in left..left + width {
                    image.set(x, y, value);
                }
            }
            for y in top + height / 2..top + height / 2 + 2 {
                for x in left..left + width.saturating_sub(2) {
                    image.set(x, y, value);
                }
            }
        }

        let mut image = GrayImage::new(900, 760, 245);
        for line in 0..7 {
            for column in 0..20 {
                if (line * 17 + column * 11) % 13 != 0 {
                    add_glyph(
                        &mut image,
                        90 + column * 28,
                        125 + line * (510 / 7),
                        10,
                        15,
                        65,
                    );
                }
            }
        }
        for y in 0..image.height() {
            for x in 678..693 {
                image.set(x, y, 96);
            }
        }
        for line in 0..5 {
            for column in 0..4 {
                add_glyph(&mut image, 735 + column * 25, 220 + line * 55, 9, 14, 90);
            }
        }

        let result = detect_split(&image, 300.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::PageWithOffcut,
            "{result:#?}"
        );
        assert!(
            (result.cutter_x.unwrap() - 686.0).abs() <= 3.0,
            "{result:#?}"
        );
        assert!(
            result.diagnostics.offcut_boundary_score >= 0.55,
            "{result:#?}"
        );
        assert!(result.diagnostics.offcut_empty_score < 0.95, "{result:#?}");
        assert!(
            result.diagnostics.offcut_populated_score >= 0.80,
            "{result:#?}"
        );
        assert!(
            result.diagnostics.offcut_no_text_rows_score >= 0.90,
            "{result:#?}"
        );
    }

    #[test]
    fn ruled_index_and_scanner_shadow_strips_stay_single_pages() {
        let fixtures = [
            ("ruled-index-20.8pct", ruled_index_fixture(187)),
            ("scanner-shadow-17.8pct", scanner_shadow_fixture(160)),
            ("scanner-shadow-26.7pct", scanner_shadow_fixture(240)),
        ];

        for (name, image) in fixtures {
            let result = detect_split(&image, 300.0, LayoutMode::Auto, None);
            assert_eq!(
                result.classification,
                LayoutClassification::SingleUncutPage,
                "{name}: {result:#?}"
            );
        }
    }

    #[test]
    fn resolution_limited_offcut_abstains_without_changing_spread_results() {
        let diagnostics = SplitDiagnostics {
            evidence_product: 0.7,
            offcut_boundary_score: 1.0,
            offcut_empty_score: 1.0,
            offcut_width_score: 1.0,
            offcut_no_text_rows_score: 0.7,
            ..SplitDiagnostics::default()
        };
        let mut offcut = split_at(
            660,
            936,
            570.0,
            FoldBand::unmeasured(FoldBandUnmeasuredReason::NotApplicable),
            LayoutClassification::PageWithOffcut,
            0.7,
            diagnostics,
        );
        offcut.abstain_from_resolution_limited_offcut();
        assert_eq!(offcut.classification, LayoutClassification::SingleUncutPage);
        assert_eq!(offcut.cutter_x, None);
        assert_eq!(offcut.pages, vec![page_polygon(0.0, 660.0, 936)]);
        assert!(offcut.diagnostics.abstained);

        let mut spread = split_at(
            660,
            420,
            330.0,
            FoldBand::unmeasured(FoldBandUnmeasuredReason::NoFoldEvidence),
            LayoutClassification::TwoPageSpread,
            0.8,
            SplitDiagnostics::default(),
        );
        let expected = spread.clone();
        spread.abstain_from_resolution_limited_offcut();
        assert_eq!(spread.classification, expected.classification);
        assert_eq!(spread.cutter_x, expected.cutter_x);
        assert_eq!(spread.pages, expected.pages);
    }

    #[test]
    fn resolution_limited_offcut_keeps_complete_independent_evidence() {
        let diagnostics = SplitDiagnostics {
            evidence_product: 0.7,
            offcut_boundary_score: 0.80,
            offcut_empty_score: 0.95,
            offcut_width_score: 0.40,
            offcut_no_text_rows_score: 0.90,
            ..SplitDiagnostics::default()
        };
        let mut offcut = split_at(
            900,
            760,
            686.0,
            FoldBand::unmeasured(FoldBandUnmeasuredReason::NotApplicable),
            LayoutClassification::PageWithOffcut,
            0.7,
            diagnostics,
        );
        offcut.abstain_from_resolution_limited_offcut();
        assert_eq!(offcut.classification, LayoutClassification::PageWithOffcut);
        assert_eq!(offcut.cutter_x, Some(686.0));
        assert!(!offcut.diagnostics.abstained);
    }

    #[test]
    fn resolution_limited_offcut_abstains_at_the_ordinary_acceptance_gate() {
        for (boundary_score, empty_score) in [(0.79, 1.0), (1.0, 0.94)] {
            let diagnostics = SplitDiagnostics {
                evidence_product: 0.7,
                offcut_boundary_score: boundary_score,
                offcut_empty_score: empty_score,
                offcut_width_score: 0.40,
                offcut_no_text_rows_score: 0.90,
                ..SplitDiagnostics::default()
            };
            let mut offcut = split_at(
                900,
                760,
                686.0,
                FoldBand::unmeasured(FoldBandUnmeasuredReason::NotApplicable),
                LayoutClassification::PageWithOffcut,
                0.7,
                diagnostics,
            );
            offcut.abstain_from_resolution_limited_offcut();
            assert_eq!(
                offcut.classification,
                LayoutClassification::SingleUncutPage,
                "boundary={boundary_score}, empty={empty_score}"
            );
            assert!(offcut.diagnostics.abstained);
        }
    }

    #[test]
    fn document_agreement_boosts_matching_pages_and_promotes_only_matching_candidates() {
        let prior = DocumentPrior {
            dominant_layout: LayoutClassification::TwoPageSpread,
            cutter_ratio_median: Some(0.53),
            cluster_dims: ClusterDimensions {
                width: 1200.0,
                height: 870.0,
            },
            agreement_strength: 0.85,
            stroke_width_median_px: None,
            x_height_median_px: None,
        };
        let matching = reconcile_layout_decision(
            LayoutClassification::TwoPageSpread,
            0.62,
            Some(636.0),
            Some(0.53),
            0.7,
            1200,
            870,
            prior,
        );
        assert_eq!(matching.classification, LayoutClassification::TwoPageSpread);
        assert!(matching.confidence > 0.9, "{matching:?}");
        assert!(!matching.reconciliation.reconciled);
        assert_eq!(matching.reconciliation.cluster_agreement, 0.85);

        let promoted = reconcile_layout_decision(
            LayoutClassification::SingleUncutPage,
            0.05,
            None,
            Some(0.535),
            0.3,
            1200,
            870,
            prior,
        );
        assert_eq!(promoted.classification, LayoutClassification::TwoPageSpread);
        assert!(promoted.reconciliation.reconciled);
        assert_eq!(promoted.cutter_x, Some(642.0));
        assert!(promoted.confidence >= 0.85, "{promoted:?}");

        let median_recovered = reconcile_layout_decision(
            LayoutClassification::SingleUncutPage,
            0.2,
            None,
            Some(0.44),
            0.5,
            1200,
            870,
            prior,
        );
        assert_eq!(
            median_recovered.classification,
            LayoutClassification::TwoPageSpread
        );
        assert!(median_recovered.reconciliation.reconciled);
        assert_eq!(median_recovered.cutter_x, Some(636.0));

        let rejected = reconcile_layout_decision(
            LayoutClassification::SingleUncutPage,
            0.2,
            None,
            None,
            0.5,
            1200,
            870,
            prior,
        );
        assert_eq!(
            rejected.classification,
            LayoutClassification::SingleUncutPage
        );
        assert!(!rejected.reconciliation.reconciled);
        assert_eq!(rejected.reconciliation.cluster_agreement, -0.85);
        assert!(rejected.confidence < 0.2);
    }

    fn fold_shadow_page(
        width: usize,
        height: usize,
        center: usize,
        half_width: usize,
        depth: u8,
    ) -> GrayImage {
        let mut gray = GrayImage::new(width, height, 245);
        for y in 0..height {
            for x in center.saturating_sub(half_width)..=(center + half_width).min(width - 1) {
                gray.set(x, y, 245 - depth);
            }
        }
        gray
    }

    fn add_fold_crossing_text(gray: &mut GrayImage, center: usize) {
        add_fold_crossing_text_with_value(gray, center, 35);
    }

    fn add_fold_crossing_text_with_value(gray: &mut GrayImage, center: usize, value: u8) {
        for y in (48..gray.height().saturating_sub(48)).step_by(18) {
            for x in center.saturating_sub(8)..=center.saturating_sub(2) {
                gray.set(x, y, value);
                if y + 1 < gray.height() {
                    gray.set(x, y + 1, value);
                }
            }
            for x in center.saturating_add(2)..=(center + 8).min(gray.width() - 1) {
                gray.set(x, y, value);
                if y + 1 < gray.height() {
                    gray.set(x, y + 1, value);
                }
            }
        }
    }

    #[test]
    fn gutter_band_covers_the_fold_shadow_and_stays_inside_the_capped_window() {
        let page = fold_shadow_page(1000, 600, 500, 8, 60);
        let (left, right) = gutter_shadow_band(&page, 500.0).unwrap();
        assert!(left <= 492.0 && right >= 508.0, "{left}..{right}");
        assert!(
            right - left <= 2.0 * 1000.0 * MAX_GUTTER_BAND_FRACTION,
            "{left}..{right}"
        );
        assert!(left < 500.0 && right > 500.0, "{left}..{right}");
    }

    #[test]
    fn gutter_band_can_start_at_the_fixed_cutter_when_the_shadow_is_just_beyond_it() {
        let page = fold_shadow_page(1000, 600, 520, 8, 60);
        let (left, right) = gutter_shadow_band(&page, 500.0).unwrap();
        assert_eq!(left, 500.0);
        assert_eq!(right, 529.0, "the right edge is half-open");
        assert!(right - 500.0 <= 1000.0 * MAX_GUTTER_BAND_FRACTION);
    }

    #[test]
    fn gutter_band_keeps_the_legacy_edge_for_an_immaterial_offset_extension() {
        let page = fold_shadow_page(1_000, 600, 500, 32, 60);

        assert_eq!(
            legacy_gutter_shadow_band(&page, 500.0),
            Some((470.0, 530.0))
        );
        assert_eq!(gutter_shadow_band(&page, 500.0), Some((470.0, 530.0)));
    }

    #[test]
    fn gutter_band_keeps_a_legacy_run_rejected_by_the_offset_length_gate() {
        let page = fold_shadow_page(1_000, 600, 500, 0, 60);

        assert_eq!(
            legacy_gutter_shadow_band(&page, 500.0),
            Some((500.0, 501.0))
        );
        assert_eq!(gutter_shadow_band(&page, 500.0), Some((500.0, 501.0)));
    }

    #[test]
    fn gutter_band_finds_a_continuous_same_side_shadow_beyond_the_legacy_cap() {
        let mut page = GrayImage::new(2200, 900, 255);
        // Facing-page tone must not lower the right leaf's paper reference.
        for y in 0..page.height() {
            for x in 0..900 {
                page.set(x, y, 174);
            }
        }
        // The retained leaf has ordinary text columns, then a fold shadow
        // beginning 117 px beyond the cutter (the adjudicated 125R geometry).
        add_text_lines(&mut page, 1240, 2100);
        for y in 45..855 {
            for x in 1120..1172 {
                page.set(x, y, 231);
            }
            for x in 1130..1150 {
                page.set(x, y, 184);
            }
        }

        let (left, right) = gutter_shadow_band(&page, 1003.0).expect("offset fold shadow");
        assert_eq!(left, 1003.0, "only the right leaf owns this shadow");
        assert!(right >= 1172.0, "offset shadow survived at {left}..{right}");
    }

    #[test]
    fn gutter_band_rejects_a_short_run_that_would_claim_a_distant_band() {
        let page = fold_shadow_page(1_000, 600, 575, 1, 60);

        assert_eq!(gutter_shadow_band(&page, 500.0), None);
    }

    #[test]
    fn gutter_band_is_absent_when_the_fold_leaves_no_shadow() {
        let page = fold_shadow_page(1000, 600, 500, 0, 0);
        assert_eq!(gutter_shadow_band(&page, 500.0), None);
        // A shadow wider than the search window leaves no clean shoulder to
        // measure against, which must degrade to the plain cutter as well.
        let engulfed = fold_shadow_page(1000, 600, 500, 200, 60);
        assert_eq!(gutter_shadow_band(&engulfed, 500.0), None);
    }

    #[test]
    fn raw_source_remeasurement_extends_a_collapsed_right_band_without_moving_cutter() {
        let mut page = fold_shadow_page(2000, 600, 1040, 20, 60);
        add_fold_crossing_text_with_value(&mut page, 1040, 120);
        let mut split = split_at(
            page.width(),
            page.height(),
            1000.0,
            FoldBand::measured(990.0, 1000.0),
            LayoutClassification::TwoPageSpread,
            0.9,
            SplitDiagnostics::default(),
        );
        split.remeasure_gutter_band_from_source(&page, page.width(), page.height());
        assert_eq!(split.cutter_x, Some(1000.0));
        let (left, right) = measured_fold_edges(&split);
        assert_eq!(left, 1000.0);
        assert!(
            right > 1000.0 && right < 1061.0,
            "text moved the endpoint: {right}"
        );
        assert_eq!(split.pages[1].points[0].x, right);

        let shadowless = GrayImage::new(2000, 600, 245);
        split.remeasure_gutter_band_from_source(&shadowless, 2000, 600);
        let (left, right) = measured_fold_edges(&split);
        assert_eq!(left, 1000.0);
        assert!(right > 1000.0);
    }

    #[test]
    fn gutter_band_stops_at_a_column_that_carries_ink() {
        let mut page = fold_shadow_page(1000, 600, 500, 20, 60);
        for y in (30..570).step_by(6) {
            page.set(485, y, 25);
            page.set(486, y, 25);
        }
        let (left, right) = gutter_shadow_band(&page, 500.0).unwrap();
        assert!(
            left >= 487.0,
            "the band must not reach the inked columns: {left}"
        );
        assert!(
            right >= 520.0,
            "the shadow-only side stays covered: {right}"
        );
    }

    #[test]
    fn fold_band_shrinks_toward_the_cutter_when_repeated_text_crosses_it() {
        let mut page = fold_shadow_page(1000, 600, 500, 20, 60);
        add_fold_crossing_text(&mut page, 500);
        let (left, right) = gutter_shadow_band(&page, 500.0).unwrap();
        assert!(
            left > 480.0 && left < 500.0,
            "left endpoint did not shrink: {left}"
        );
        assert!(
            right > 500.0 && right < 520.0,
            "right endpoint did not shrink: {right}"
        );
    }

    #[test]
    fn fold_band_retains_repeated_margin_glyphs_under_a_shadow() {
        let mut page = fold_shadow_page(1000, 600, 500, 20, 60);
        for y in (48..552).step_by(18) {
            for x in 503..510 {
                page.set(x, y, 35);
                page.set(x, y + 1, 35);
            }
        }

        let (left, right) = gutter_shadow_band(&page, 500.0).unwrap();
        assert_eq!(left, 480.0);
        assert_eq!(right, 503.0, "the first supported glyph column was cut");
    }

    #[test]
    fn fold_band_keeps_a_continuous_rail_as_shadow() {
        let mut page = fold_shadow_page(1000, 600, 500, 20, 60);
        for y in 0..page.height() {
            for x in 503..506 {
                page.set(x, y, 120);
            }
        }

        let raw = gutter_shadow_band_unprotected(&page, 500.0).unwrap();
        assert_eq!(gutter_shadow_band(&page, 500.0), Some(raw));
    }

    #[test]
    fn shadow_only_fold_band_keeps_the_measured_edges_byte_identical() {
        let page = fold_shadow_page(1000, 600, 500, 20, 60);
        assert_eq!(
            gutter_shadow_band(&page, 500.0),
            legacy_gutter_shadow_band(&page, 500.0)
        );
    }

    #[test]
    fn ambiguous_fold_corridor_support_retains_the_cutter_edge() {
        let mut page = fold_shadow_page(1000, 600, 500, 20, 60);
        for y in 260..284 {
            for x in 482..487 {
                page.set(x, y, 145);
            }
        }
        let (left, right) = gutter_shadow_band(&page, 500.0).unwrap();
        assert_eq!(left, 500.0);
        assert!(right > 500.0);
    }

    #[test]
    fn tall_fold_corridor_support_does_not_shrink_the_measured_band() {
        let mut page = fold_shadow_page(1000, 600, 500, 20, 60);
        for y in 240..304 {
            for x in 482..487 {
                page.set(x, y, 145);
            }
        }

        let raw = gutter_shadow_band_unprotected(&page, 500.0).unwrap();
        assert_eq!(gutter_shadow_band(&page, 500.0), Some(raw));
    }

    #[test]
    fn spread_leaves_exclude_the_fold_shadow_and_a_shadowless_cut_stays_adjacent() {
        let mut gray = GrayImage::new(1200, 800, 245);
        add_text_lines(&mut gray, 60, 560);
        add_text_lines(&mut gray, 640, 1140);
        for y in 0..800 {
            for x in 590..=610 {
                gray.set(x, y, 150);
            }
        }
        let banded = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(banded.classification, LayoutClassification::TwoPageSpread);
        let (gutter_left, gutter_right) = measured_fold_edges(&banded);
        let cutter = banded.cutter_x.expect("a spread cuts somewhere");
        // The cut still lands in the fold, and the left leaf pulls back to the
        // near edge of it.
        assert!((590.0..=610.0).contains(&cutter), "{cutter}");
        assert!(gutter_left <= 592.0, "{gutter_left}");
        assert!(gutter_right >= 608.0, "{gutter_right}");
        assert_eq!(banded.pages[0].points[1].x, gutter_left);
        assert_eq!(banded.pages[1].points[0].x, gutter_right);

        let plain = split_at(
            1200,
            800,
            600.0,
            FoldBand::unmeasured(FoldBandUnmeasuredReason::NoFoldEvidence),
            LayoutClassification::TwoPageSpread,
            0.9,
            SplitDiagnostics::default(),
        );
        assert_eq!(plain.pages[0].points[1].x, 600.0);
        assert_eq!(plain.pages[1].points[0].x, 600.0);
    }

    #[test]
    fn a_carried_cutter_trims_the_same_shadow_without_moving_the_leaf_it_anchors() {
        let mut gray = GrayImage::new(1200, 800, 245);
        add_text_lines(&mut gray, 60, 560);
        add_text_lines(&mut gray, 640, 1140);
        for y in 0..800 {
            for x in 590..=610 {
                gray.set(x, y, 150);
            }
        }
        let shadow_only = gray.clone();
        add_fold_crossing_text_with_value(&mut gray, 600, 120);
        let shadow_only_result = detect_split(&shadow_only, 150.0, LayoutMode::Auto, None);
        let measured = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        let cutter = measured.cutter_x.expect("a spread cuts somewhere");
        let (clean_left, clean_right) = measured_fold_edges(&shadow_only_result);
        let (text_left, text_right) = measured_fold_edges(&measured);
        assert!(
            text_left >= clean_left,
            "left endpoint expanded: {clean_left}..{text_left}"
        );
        assert!(
            text_right <= clean_right,
            "right endpoint expanded: {text_right}..{clean_right}"
        );
        assert!(
            text_left > clean_left || text_right < clean_right,
            "crossing text did not shrink either measured endpoint: {clean_left}..{clean_right} -> {text_left}..{text_right}"
        );
        // The clean pass inherits nothing but the cutter, so it has to find the
        // same shadow again and leave the right leaf exactly where the analyze
        // pass left it.
        let carried = detect_split(&gray, 150.0, LayoutMode::Auto, Some(cutter));
        assert_eq!(carried.cutter_x, Some(cutter));
        assert_eq!(
            carried.diagnostics.fold_band,
            measured.diagnostics.fold_band
        );
        assert_eq!(carried.pages[1].points[0].x, measured.pages[1].points[0].x);

        let shadowless = GrayImage::new(1200, 800, 245);
        let unavailable = detect_split(&shadowless, 150.0, LayoutMode::Auto, Some(600.0));
        assert_eq!(unavailable.pages[0].points[1].x, 600.0);
        assert_eq!(unavailable.pages[1].points[0].x, 600.0);
        assert_eq!(
            unavailable.diagnostics.fold_band,
            FoldBand::unmeasured(FoldBandUnmeasuredReason::MeasurementUnavailable),
        );
    }

    #[test]
    fn manual_cutter_stays_authoritative_when_fold_text_adjusts_endpoints() {
        let cutter = 600.0;
        let mut shadow_only = GrayImage::new(1200, 800, 245);
        add_text_lines(&mut shadow_only, 60, 560);
        add_text_lines(&mut shadow_only, 640, 1140);
        for y in 0..shadow_only.height() {
            for x in 590..=610 {
                shadow_only.set(x, y, 150);
            }
        }
        let mut supported = shadow_only.clone();
        add_fold_crossing_text_with_value(&mut supported, cutter as usize, 120);

        let clean = detect_split(&shadow_only, 150.0, LayoutMode::Auto, Some(cutter));
        let adjusted = detect_split(&supported, 150.0, LayoutMode::Auto, Some(cutter));
        assert_eq!(clean.cutter_x, Some(cutter));
        assert_eq!(adjusted.cutter_x, Some(cutter));
        let (clean_left, clean_right) = measured_fold_edges(&clean);
        let (adjusted_left, adjusted_right) = measured_fold_edges(&adjusted);
        assert!(adjusted_left >= clean_left);
        assert!(adjusted_right <= clean_right);
        assert!(
            adjusted_left > clean_left || adjusted_right < clean_right,
            "supported text did not adjust either endpoint: {clean_left}..{clean_right} -> {adjusted_left}..{adjusted_right}"
        );
        assert_eq!(adjusted.pages[0].points[1].x, adjusted_left);
        assert_eq!(adjusted.pages[1].points[0].x, adjusted_right);
    }

    #[test]
    fn a_full_height_fold_lets_a_nearly_inkless_leaf_still_prove_a_spread() {
        let mut gray = GrayImage::new(1200, 800, 245);
        // A pale photographic plate facing a text page: the two leaves can
        // never balance their ink, so only the fold can carry the decision.
        for y in 40..760 {
            for x in 40..560 {
                gray.set(x, y, 238 - u8::try_from((x + y) % 3).unwrap());
            }
        }
        for y in 60..64 {
            for x in 40..150 {
                gray.set(x, y, 150);
            }
        }
        add_text_lines(&mut gray, 640, 1140);
        for y in 0..800 {
            for x in 592..=608 {
                gray.set(x, y, 120);
            }
        }
        let result = detect_split(&gray, 150.0, LayoutMode::Auto, None);
        assert_eq!(
            result.classification,
            LayoutClassification::TwoPageSpread,
            "{result:?}"
        );
        assert!(result.diagnostics.bilateral_gate_passed, "{result:?}");
        // Neither ink balance nor the blank-leaf escape hatch can carry this
        // gate: the plate has a hundredth of the text page's ink, and squaring
        // its own page score stays below the bilateral threshold.
        assert!(
            result.diagnostics.left_ink_pixels * 20 < result.diagnostics.right_ink_pixels,
            "{result:?}"
        );
        assert!(
            result.diagnostics.left_page_score * result.diagnostics.left_page_score < 0.08,
            "{result:?}"
        );
        assert!(
            (result.diagnostics.bilateral_score - FOLDED_SHEET_BILATERAL_FLOOR).abs() < 1e-9,
            "{result:?}"
        );
    }

    #[test]
    fn folded_sheet_balance_needs_a_deep_unbroken_full_height_fold() {
        let saturated = SoftGutterCandidate {
            x: 600.0,
            score: 1.0,
            vertical_coverage: 1.0,
            continuity: 1.0,
            mean_depression: 24.0,
        };
        assert_eq!(folded_sheet_balance(Some(saturated), 1.0), 1.0);
        assert_eq!(folded_sheet_balance(None, 1.0), 0.0);
        assert_eq!(folded_sheet_balance(Some(saturated), 0.3), 0.0);
        let interrupted = SoftGutterCandidate {
            continuity: 0.6,
            ..saturated
        };
        assert_eq!(folded_sheet_balance(Some(interrupted), 1.0), 0.0);
        let shallow = SoftGutterCandidate {
            mean_depression: 6.0,
            ..saturated
        };
        assert_eq!(folded_sheet_balance(Some(shallow), 1.0), 0.0);
    }

    #[test]
    fn a_document_prior_never_reuses_a_shadow_measured_for_another_cutter() {
        let prior = DocumentPrior {
            dominant_layout: LayoutClassification::TwoPageSpread,
            cutter_ratio_median: Some(0.50),
            cluster_dims: ClusterDimensions {
                width: 1200.0,
                height: 800.0,
            },
            agreement_strength: 0.90,
            stroke_width_median_px: None,
            x_height_median_px: None,
        };
        let mut moved = split_at(
            1200,
            800,
            700.0,
            FoldBand::measured(690.0, 710.0),
            LayoutClassification::TwoPageSpread,
            0.4,
            SplitDiagnostics {
                decision_x: 700.0,
                whitespace_score: 0.6,
                ..SplitDiagnostics::default()
            },
        );
        moved.classification = LayoutClassification::SingleUncutPage;
        moved.apply_document_prior(1200, 800, prior);
        assert_eq!(moved.cutter_x, Some(600.0));
        assert_eq!(
            moved.diagnostics.fold_band,
            FoldBand::unmeasured(FoldBandUnmeasuredReason::CutterInvalidated)
        );
        assert_eq!(moved.pages[0].points[1].x, 600.0);
        assert_eq!(moved.pages[1].points[0].x, 600.0);

        let mut kept = split_at(
            1200,
            800,
            600.0,
            FoldBand::measured(590.0, 610.0),
            LayoutClassification::TwoPageSpread,
            0.8,
            SplitDiagnostics {
                decision_x: 600.0,
                whitespace_score: 0.6,
                ..SplitDiagnostics::default()
            },
        );
        kept.apply_document_prior(1200, 800, prior);
        assert_eq!(measured_fold_edges(&kept), (590.0, 610.0));
        assert_eq!(kept.pages[0].points[1].x, 590.0);
        assert_eq!(kept.pages[1].points[0].x, 610.0);
    }

    #[test]
    fn strong_spread_consensus_does_not_force_a_landscape_single_without_a_valley() {
        let prior = DocumentPrior {
            dominant_layout: LayoutClassification::TwoPageSpread,
            cutter_ratio_median: Some(0.47),
            cluster_dims: ClusterDimensions {
                width: 1400.0,
                height: 900.0,
            },
            agreement_strength: 0.94,
            stroke_width_median_px: None,
            x_height_median_px: None,
        };
        let decision = reconcile_layout_decision(
            LayoutClassification::SingleUncutPage,
            0.58,
            None,
            None,
            0.0,
            1400,
            900,
            prior,
        );
        assert_eq!(
            decision.classification,
            LayoutClassification::SingleUncutPage
        );
        assert_eq!(decision.cutter_x, None);
        assert!(!decision.reconciliation.reconciled);
        assert_eq!(decision.reconciliation.cluster_agreement, -0.94);
    }

    #[test]
    fn typed_fold_band_preserves_the_plain_cutter_for_unquantified_evidence() {
        let evidenced_diagnostics = SplitDiagnostics {
            analysis_dpi: 150.0,
            fold_score: 0.8,
            independent_gutter_gate_passed: true,
            ..SplitDiagnostics::default()
        };
        let evidenced = split_at(
            1200,
            800,
            600.0,
            fold_band_without_measurement(&evidenced_diagnostics),
            LayoutClassification::TwoPageSpread,
            0.9,
            evidenced_diagnostics,
        );
        assert_eq!(
            evidenced.diagnostics.fold_band,
            FoldBand::unmeasured(FoldBandUnmeasuredReason::FoldEvidenceUnquantified),
        );
        assert_eq!(evidenced.pages[0].points[1].x, 600.0);
        assert_eq!(evidenced.pages[1].points[0].x, 600.0);

        let no_evidence = split_at(
            1200,
            800,
            600.0,
            fold_band_without_measurement(&SplitDiagnostics::default()),
            LayoutClassification::TwoPageSpread,
            0.9,
            SplitDiagnostics::default(),
        );
        assert_eq!(no_evidence.pages[0].points[1].x, 600.0);
        assert_eq!(no_evidence.pages[1].points[0].x, 600.0);
    }

    #[test]
    fn typed_fold_band_serializes_cutter_invalidation_reason() {
        let prior = DocumentPrior {
            dominant_layout: LayoutClassification::TwoPageSpread,
            cutter_ratio_median: Some(0.50),
            cluster_dims: ClusterDimensions {
                width: 1200.0,
                height: 800.0,
            },
            agreement_strength: 0.90,
            stroke_width_median_px: None,
            x_height_median_px: None,
        };
        let mut moved = split_at(
            1200,
            800,
            700.0,
            FoldBand::measured(690.0, 710.0),
            LayoutClassification::TwoPageSpread,
            0.4,
            SplitDiagnostics {
                decision_x: 700.0,
                whitespace_score: 0.6,
                ..SplitDiagnostics::default()
            },
        );
        moved.classification = LayoutClassification::SingleUncutPage;
        moved.apply_document_prior(1200, 800, prior);

        let diagnostics = serde_json::to_value(moved.diagnostics).unwrap();
        assert_eq!(diagnostics["foldBand"]["reason"], "cutter-invalidated");
    }

    #[test]
    fn outer_margin_recovery_diagnostics_serialize_scores_and_weak_edge() {
        let diagnostics = serde_json::to_value(SplitDiagnostics {
            left_outer_margin_score: 0.0,
            right_outer_margin_score: 0.64,
            outer_margin_recovery: true,
            outer_margin_weak_edge: Some(OuterMarginSide::Left),
            ..SplitDiagnostics::default()
        })
        .unwrap();
        assert_eq!(diagnostics["leftOuterMarginScore"], 0.0);
        assert_eq!(diagnostics["rightOuterMarginScore"], 0.64);
        assert_eq!(diagnostics["outerMarginRecovery"], true);
        assert_eq!(diagnostics["outerMarginWeakEdge"], "left");
    }
}
