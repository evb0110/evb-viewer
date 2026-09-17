use crate::{
    background::{normalize_illumination, smooth_for_binarization},
    calibration::{CalibrationConfig, PageCalibration},
    BinarizationMode, CleanupOptions, DespeckleLevel,
};
use rayon::prelude::*;
use scan_primitives::{
    distance::squared_euclidean_distance,
    morphology::{dilate, dilate_gray, erode_gray},
    threshold::{
        otsu_threshold, otsu_threshold_excluding, threshold_global, threshold_global_biased,
        threshold_local, threshold_local_biased, threshold_local_biased_excluding,
        threshold_local_multiscale_biased_excluding_with_integrals_for_consensus,
        threshold_local_multiscale_biased_with_integrals_for_consensus, IntegralImages,
        LocalThreshold, MaskedIntegralImages,
    },
    BinaryImage, ComponentMap, GrayImage,
};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, sync::OnceLock, time::Instant};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct BinarizationStageTimings {
    pub preparation_ms: f64,
    pub thresholding_ms: f64,
    pub postprocess_ms: f64,
}

// Corpus calibration keeps Wolf below the 0.3 reference setting: 0.3 erased
// the Stage-B thin-stroke golden, while 0.2 retained it without adding noise.
const WOLF_K: f64 = 0.20;
const SAUVOLA_K: f64 = 0.34;
const WOLF_MINIMUM_PERCENTILE: f64 = 0.01;
const WOLF_HARD_INK: u8 = 48;
const WOLF_HARD_PAPER: u8 = 248;
const STROKE_EDGE_THRESHOLD: u16 = 24;
const TILE_PAPER_DELTA: u8 = 48;
const TILE_PAPER_FRACTION_FLOOR: f64 = 0.97;
const MIN_QUALIFYING_PAPER_TILES: usize = 4;
const UNIFORM_PAPER_MAXIMUM_RANGE: u8 = 8;
const FALLBACK_X_HEIGHT_AT_300_DPI_PX: f64 = 17.0;
// Canonical book calibration leaves the nearest corroborated true-Wolf fixture
// at 9.868637% coverage and the next dark book leaf after the two observed
// Otsu victims at 11.055276%. Inside this gap the border statistic alone cannot
// distinguish a scanner rail from otherwise flat-lit text, so preserve Otsu
// only when the rest of the clean-uniform evidence independently agrees.
const FLAT_LIT_OTSU_DARK_BORDER_COVERAGE_BAND: (f64, f64) = (0.099, 0.110_25);

// A rule is preserved only when the source itself contains a long, thin run
// of dark pixels. The geometry is intentionally shared with the render-side
// fallback, while the raw plane remains the authority for every candidate.
pub(crate) const RULE_RAW_DEPTH: u8 = 72;
const RULE_MINIMUM_SPAN_MM: f64 = 15.0;
// Running-head rules in the reference scans run up to ~3.5 mm; above
// 2 mm the aspect requirement tightens to 8:1 so short thick blocks
// (caption fragments, stamps) cannot ride the exemption.
const RULE_MAXIMUM_THICKNESS_MM: f64 = 4.0;
const RULE_THIN_THICKNESS_MM: f64 = 2.0;

// These are shared with the final bleed filter. A rescue may recover a raw
// candidate only when it has the same crisp-or-deep evidence that the final
// filter trusts for retaining a printed component. The filter still gets the
// last word, because a rescued component can merge with a shallow strike.
pub(crate) const BLEED_CRISPNESS_FLOOR: u16 = 32;
pub(crate) const BLEED_SHALLOW_DEPTH: u8 = 80;
const RESCUE_CANDIDATE_DEPTH: u8 = 24;
const RESCUE_ROW_SIGNAL_DEPTH: u8 = 24;
const RESCUE_ROW_SIGNAL_CRISPNESS: u16 = 18;
// Absolute raw threshold used only for locating the captured dark core whose
// immediately adjacent ring Wolf may have admitted as antialiasing.
const RESCUE_SOLID_DEPTH: u8 = 128;
// Must recognize captured healthy ink while leaving pale captured skeletons rescue-eligible.
const RESCUE_SOLID_CAPTURED_MEDIAN: u8 = 96;
// A missing structural stroke may defeat the solid-core skip only when it is
// materially below paper and lies beyond the captured ink's immediate halo.
const RESCUE_STRUCTURAL_DEPTH: u8 = 64;
// Wolf may admit a gray antialias halo around a fully captured dark core. The
// cap is applied only to components that satisfy the same two-sided solid-core
// evidence used to deny unnecessary faint-stroke rescue.
const WOLF_SOLID_STROKE_CEILING: u8 = 128;
// A deep-missing body must remain a substantial part of the nearby raw
// candidate field. This protects captured faint skeletons while allowing a
// few detached dark samples around an otherwise complete solid glyph.
const WOLF_SOLID_MAXIMUM_DEEP_MISSING_DENOMINATOR: usize = 4;

// These are the tracked stroke-weight oracle's calibration constants. The
// production guard deliberately uses the same component census, line grouping,
// 32 mm comparison population, and >1.6x decision boundary as the judge in
// scripts/diagnostics/stroke-weight-oracle. Keep this as the single owner of
// the Rust-side ridge-width measurement used by all three interventions below.
const STROKE_BUDGET_CALIBRATION_DPI: f64 = 300.0;
const STROKE_BUDGET_COMPONENT_AREA_MIN_PX: usize = 8;
const STROKE_BUDGET_COMPONENT_HEIGHT_MIN_PX_AT_300_DPI: f64 = 12.0;
const STROKE_BUDGET_COMPONENT_HEIGHT_MAX_PX_AT_300_DPI: f64 = 70.0;
const STROKE_BUDGET_COMPONENT_WIDTH_MIN_PX_AT_300_DPI: f64 = 2.0;
const STROKE_BUDGET_COMPONENT_WIDTH_MAX_PX_AT_300_DPI: f64 = 200.0;
const STROKE_BUDGET_LINE_CLUSTER_GAP_HEIGHT_FRACTION: f64 = 0.72;
const STROKE_BUDGET_MINIMUM_LINE_COMPONENTS: usize = 8;
// A quarter of a line over tolerance is systemic/bimodal evidence, not the
// sparse one-off weight defect this budget is allowed to rewrite.
const STROKE_BUDGET_SYSTEMIC_OFFENDER_DENOMINATOR: usize = 4;
const STROKE_BUDGET_LOCAL_WINDOW_MM: f64 = 32.0;
const STROKE_BUDGET_MINIMUM_LOCAL_COMPONENTS: usize = 7;
const STROKE_BUDGET_TOLERANCE_RATIO: f64 = 1.6;
/// Ridge widths are twice an integer chamfer distance, so measured values sit
/// on a 2-pixel lattice regardless of DPI, and odd true stroke widths inflate
/// by one pixel. A local budget is only meaningful where its tolerance margin
/// (median * (ratio - 1)) exceeds this quantization step; below that, one
/// lattice step reads as an offense and ordinary small print gets eroded.
const RIDGE_WIDTH_QUANTIZATION_STEP_PX: f64 = 2.0;
/// Fraction of a proposed rescue cluster allowed to touch already-captured
/// ink before the cluster is judged halo accretion rather than missing
/// stroke material.
const RESCUE_ACCRETION_FRACTION_CAP: f64 = 0.55;

// OpenCV DIST_L2 with maskSize=5 is the oracle's distance transform. These
// documented chamfer weights reproduce it without introducing a second width
// proxy (maximum radius, run length, or area/extent) into the mechanism.
const DISTANCE_L2_5_CARDINAL: u32 = 65_536;
const DISTANCE_L2_5_DIAGONAL: u32 = 91_750;
const DISTANCE_L2_5_KNIGHT: u32 = 143_976;
const DISTANCE_L2_5_INFINITY: u32 = u32::MAX - DISTANCE_L2_5_KNIGHT;
const DISTANCE_L2_5_SCALE: f32 = 1.0 / 65_536.0;

#[derive(Clone, Debug)]
struct StrokeBudgetComponent {
    center_x: f64,
    center_y: f64,
    ridge_width_px: f64,
}

#[derive(Clone, Debug)]
struct StrokeBudgetLine {
    center_y: f64,
    intervention_enabled: bool,
    components: Vec<StrokeBudgetComponent>,
}

#[derive(Clone, Debug)]
struct LineStrokeBudget {
    dpi: f64,
    minimum_component_area: usize,
    maximum_center_gap: f64,
    lines: Vec<StrokeBudgetLine>,
}

#[derive(Clone, Copy, Debug)]
struct LocalStrokeBudget {
    median_width_px: f64,
    maximum_width_px: f64,
}

#[derive(Clone, Copy, Debug)]
struct InitialStrokeBudgetOffender {
    label: u32,
    maximum_width_px: f64,
    before_width_px: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct LineStrokeBudgetInterventions {
    raster_width: usize,
    raster_height: usize,
    source_components_normalized: usize,
    source_pixels_removed: usize,
    source_components_unreachable: usize,
    smoothing_components_capped: usize,
    smoothing_pixels_suppressed: usize,
    rescue_components_capped: usize,
    rescue_bridge_components_capped: usize,
    rescue_pixels_suppressed: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StrokeBudgetAdditionStage {
    Smoothing,
    Rescue,
}

impl LineStrokeBudget {
    fn from_binary(
        source: &BinaryImage,
        dpi: f64,
    ) -> Option<(Self, Vec<InitialStrokeBudgetOffender>)> {
        if source.width() == 0 || source.height() == 0 {
            return None;
        }
        let map = ComponentMap::from_binary(source);
        let eligibility = stroke_budget_eligibility(dpi);
        let mut sums_x = vec![0u64; map.components().len() + 1];
        let mut sums_y = vec![0u64; map.components().len() + 1];
        for y in 0..source.height() {
            for x in 0..source.width() {
                let label = map.label_at(x, y) as usize;
                if label != 0 {
                    sums_x[label] += x as u64;
                    sums_y[label] += y as u64;
                }
            }
        }
        let mut measured = Vec::new();
        for component in map.components() {
            let width = component.right - component.left + 1;
            let height = component.bottom - component.top + 1;
            if component.area < eligibility.minimum_area
                || !(eligibility.minimum_height..=eligibility.maximum_height).contains(&height)
                || !(eligibility.minimum_width..=eligibility.maximum_width).contains(&width)
            {
                continue;
            }
            let ridge_width_px = component_ridge_width(source, &map, component.label);
            if ridge_width_px <= 0.0 {
                continue;
            }
            measured.push((
                component.label,
                height,
                StrokeBudgetComponent {
                    center_x: sums_x[component.label as usize] as f64 / component.area as f64,
                    center_y: sums_y[component.label as usize] as f64 / component.area as f64,
                    ridge_width_px,
                },
            ));
        }
        if measured.len() < STROKE_BUDGET_MINIMUM_LINE_COMPONENTS {
            return None;
        }
        let mut heights = measured
            .iter()
            .map(|(_, height, _)| *height as f64)
            .collect::<Vec<_>>();
        let median_height = median_f64(&mut heights)?;
        let maximum_center_gap =
            (STROKE_BUDGET_LINE_CLUSTER_GAP_HEIGHT_FRACTION * median_height).max(2.0);
        measured.sort_by(|left, right| {
            left.2
                .center_y
                .total_cmp(&right.2.center_y)
                .then_with(|| left.2.center_x.total_cmp(&right.2.center_x))
        });
        let mut grouped = Vec::<Vec<(u32, StrokeBudgetComponent)>>::new();
        for (label, _, component) in measured {
            let mut best = None;
            for (index, group) in grouped.iter().enumerate() {
                let mut centers = group
                    .iter()
                    .map(|(_, item)| item.center_y)
                    .collect::<Vec<_>>();
                let center = median_f64(&mut centers).unwrap_or(component.center_y);
                let distance = (component.center_y - center).abs();
                if distance <= maximum_center_gap
                    && best.is_none_or(|(_, best_distance)| distance < best_distance)
                {
                    best = Some((index, distance));
                }
            }
            if let Some((index, _)) = best {
                grouped[index].push((label, component));
            } else {
                grouped.push(vec![(label, component)]);
            }
        }
        let mut lines = Vec::new();
        let mut offenders = Vec::new();
        for mut group in grouped {
            if group.len() < STROKE_BUDGET_MINIMUM_LINE_COMPONENTS {
                continue;
            }
            group.sort_by(|left, right| left.1.center_x.total_cmp(&right.1.center_x));
            let mut centers = group
                .iter()
                .map(|(_, component)| component.center_y)
                .collect::<Vec<_>>();
            let center_y = median_f64(&mut centers).unwrap_or_default();
            let components = group
                .iter()
                .map(|(_, component)| component.clone())
                .collect::<Vec<_>>();
            let mut line = StrokeBudgetLine {
                center_y,
                intervention_enabled: true,
                components,
            };
            let mut line_offenders = Vec::new();
            for (label, component) in &group {
                if let Some(local_budget) = local_stroke_budget(&line, component.center_x, dpi) {
                    if component.ridge_width_px > local_budget.maximum_width_px {
                        line_offenders.push(InitialStrokeBudgetOffender {
                            label: *label,
                            maximum_width_px: local_budget.maximum_width_px,
                            before_width_px: component.ridge_width_px,
                        });
                    }
                }
            }
            line.intervention_enabled = line_offenders
                .len()
                .saturating_mul(STROKE_BUDGET_SYSTEMIC_OFFENDER_DENOMINATOR)
                < group.len();
            if line.intervention_enabled {
                offenders.extend(line_offenders);
            }
            lines.push(line);
        }
        (!lines.is_empty()).then_some((
            Self {
                dpi,
                minimum_component_area: eligibility.minimum_area,
                maximum_center_gap,
                lines,
            },
            offenders,
        ))
    }

    fn local_budget_at(&self, center_x: f64, center_y: f64) -> Option<LocalStrokeBudget> {
        let line = self
            .lines
            .iter()
            .filter(|line| line.intervention_enabled)
            .filter_map(|line| {
                let distance = (line.center_y - center_y).abs();
                (distance <= self.maximum_center_gap).then_some((line, distance))
            })
            .min_by(|left, right| left.1.total_cmp(&right.1))?
            .0;
        local_stroke_budget(line, center_x, self.dpi)
    }
}

fn local_stroke_budget(
    line: &StrokeBudgetLine,
    center_x: f64,
    dpi: f64,
) -> Option<LocalStrokeBudget> {
    let window_px = STROKE_BUDGET_LOCAL_WINDOW_MM * dpi.max(1.0) / 25.4;
    let mut widths = line
        .components
        .iter()
        .filter(|component| (component.center_x - center_x).abs() <= window_px)
        .map(|component| component.ridge_width_px)
        .collect::<Vec<_>>();
    if widths.len() < STROKE_BUDGET_MINIMUM_LOCAL_COMPONENTS {
        return None;
    }
    median_f64(&mut widths)
        .filter(|median_width_px| {
            median_width_px * (STROKE_BUDGET_TOLERANCE_RATIO - 1.0)
                > RIDGE_WIDTH_QUANTIZATION_STEP_PX
        })
        .map(|median_width_px| LocalStrokeBudget {
            median_width_px,
            maximum_width_px: median_width_px * STROKE_BUDGET_TOLERANCE_RATIO,
        })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StrokeBudgetEligibility {
    minimum_area: usize,
    minimum_height: usize,
    maximum_height: usize,
    minimum_width: usize,
    maximum_width: usize,
}

fn stroke_budget_eligibility(dpi: f64) -> StrokeBudgetEligibility {
    let scale = dpi.max(1.0) / STROKE_BUDGET_CALIBRATION_DPI;
    // Rust's round is half-away-from-zero. The Python oracle deliberately uses
    // the same rule; changing either side is covered by the conformance pin.
    StrokeBudgetEligibility {
        minimum_area: ((STROKE_BUDGET_COMPONENT_AREA_MIN_PX as f64) * (scale * scale).max(0.25))
            .round()
            .max(2.0) as usize,
        minimum_height: (STROKE_BUDGET_COMPONENT_HEIGHT_MIN_PX_AT_300_DPI * scale)
            .round()
            .max(1.0) as usize,
        maximum_height: (STROKE_BUDGET_COMPONENT_HEIGHT_MAX_PX_AT_300_DPI * scale)
            .round()
            .max(1.0) as usize,
        minimum_width: (STROKE_BUDGET_COMPONENT_WIDTH_MIN_PX_AT_300_DPI * scale)
            .round()
            .max(1.0) as usize,
        maximum_width: (STROKE_BUDGET_COMPONENT_WIDTH_MAX_PX_AT_300_DPI * scale)
            .round()
            .max(1.0) as usize,
    }
}

fn median_f64(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) * 0.5
    } else {
        values[middle]
    })
}

fn component_ridge_width(source: &BinaryImage, map: &ComponentMap, label: u32) -> f64 {
    let Some(component) = map.components().get(label as usize - 1) else {
        return 0.0;
    };
    let width = component.right - component.left + 1;
    let height = component.bottom - component.top + 1;
    let isolated = BinaryImage::from_fn_parallel(width, height, |x, y| {
        map.label_at(component.left + x, component.top + y) == label
            && source.get(component.left + x, component.top + y)
    });
    ridge_width_of_isolated_component(&isolated)
}

fn ridge_width_of_isolated_component(component: &BinaryImage) -> f64 {
    if component.count_black() == 0 {
        return 0.0;
    }
    let padding = 2usize;
    let width = component.width() + padding * 2;
    let height = component.height() + padding * 2;
    let mut distances = vec![0u32; width * height];
    for y in 0..component.height() {
        for x in 0..component.width() {
            if component.get(x, y) {
                distances[(y + padding) * width + x + padding] = DISTANCE_L2_5_INFINITY;
            }
        }
    }
    for y in padding..height - padding {
        for x in padding..width - padding {
            let index = y * width + x;
            if distances[index] != DISTANCE_L2_5_INFINITY {
                continue;
            }
            distances[index] = distance_l2_5_forward(&distances, width, x, y);
        }
    }
    for y in (padding..height - padding).rev() {
        for x in (padding..width - padding).rev() {
            let index = y * width + x;
            if distances[index] == 0 {
                continue;
            }
            distances[index] =
                distances[index].min(distance_l2_5_backward(&distances, width, x, y));
        }
    }
    let mut ridge = Vec::new();
    for y in padding..height - padding {
        for x in padding..width - padding {
            let value = distances[y * width + x];
            if value == 0 {
                continue;
            }
            let mut local_maximum = 0u32;
            for neighbor_y in y - 1..=y + 1 {
                for neighbor_x in x - 1..=x + 1 {
                    local_maximum = local_maximum.max(distances[neighbor_y * width + neighbor_x]);
                }
            }
            if value == local_maximum {
                ridge.push(f64::from(value as f32 * DISTANCE_L2_5_SCALE) * 2.0);
            }
        }
    }
    median_f64(&mut ridge).unwrap_or_default()
}

fn distance_l2_5_forward(distances: &[u32], width: usize, x: usize, y: usize) -> u32 {
    [
        distances[y * width + x - 1].saturating_add(DISTANCE_L2_5_CARDINAL),
        distances[(y - 1) * width + x].saturating_add(DISTANCE_L2_5_CARDINAL),
        distances[(y - 1) * width + x - 1].saturating_add(DISTANCE_L2_5_DIAGONAL),
        distances[(y - 1) * width + x + 1].saturating_add(DISTANCE_L2_5_DIAGONAL),
        distances[(y - 1) * width + x - 2].saturating_add(DISTANCE_L2_5_KNIGHT),
        distances[(y - 2) * width + x - 1].saturating_add(DISTANCE_L2_5_KNIGHT),
        distances[(y - 2) * width + x + 1].saturating_add(DISTANCE_L2_5_KNIGHT),
        distances[(y - 1) * width + x + 2].saturating_add(DISTANCE_L2_5_KNIGHT),
    ]
    .into_iter()
    .min()
    .unwrap_or(DISTANCE_L2_5_INFINITY)
}

fn distance_l2_5_backward(distances: &[u32], width: usize, x: usize, y: usize) -> u32 {
    [
        distances[y * width + x + 1].saturating_add(DISTANCE_L2_5_CARDINAL),
        distances[(y + 1) * width + x].saturating_add(DISTANCE_L2_5_CARDINAL),
        distances[(y + 1) * width + x - 1].saturating_add(DISTANCE_L2_5_DIAGONAL),
        distances[(y + 1) * width + x + 1].saturating_add(DISTANCE_L2_5_DIAGONAL),
        distances[(y + 1) * width + x - 2].saturating_add(DISTANCE_L2_5_KNIGHT),
        distances[(y + 2) * width + x - 1].saturating_add(DISTANCE_L2_5_KNIGHT),
        distances[(y + 2) * width + x + 1].saturating_add(DISTANCE_L2_5_KNIGHT),
        distances[(y + 1) * width + x + 2].saturating_add(DISTANCE_L2_5_KNIGHT),
    ]
    .into_iter()
    .min()
    .unwrap_or(DISTANCE_L2_5_INFINITY)
}

fn establish_line_stroke_budget(
    source: &BinaryImage,
    dpi: f64,
) -> (
    BinaryImage,
    Option<LineStrokeBudget>,
    LineStrokeBudgetInterventions,
) {
    let Some((budget, offenders)) = LineStrokeBudget::from_binary(source, dpi) else {
        let interventions = LineStrokeBudgetInterventions {
            raster_width: source.width(),
            raster_height: source.height(),
            ..LineStrokeBudgetInterventions::default()
        };
        return (source.clone(), None, interventions);
    };
    let initial_map = ComponentMap::from_binary(source);
    let mut normalized = source.clone();
    let mut interventions = LineStrokeBudgetInterventions {
        raster_width: source.width(),
        raster_height: source.height(),
        ..LineStrokeBudgetInterventions::default()
    };
    for offender in offenders {
        let Some(component) = initial_map.components().get(offender.label as usize - 1) else {
            continue;
        };
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let mut isolated = BinaryImage::from_fn_parallel(width, height, |x, y| {
            initial_map.label_at(component.left + x, component.top + y) == offender.label
        });
        let Some((candidate, removed, current_width)) = normalize_offender_component(
            &isolated,
            offender.before_width_px,
            offender.maximum_width_px,
            budget.minimum_component_area,
            &topology_preserving_boundary_removal,
        ) else {
            interventions.source_components_unreachable += 1;
            continue;
        };
        isolated = candidate;
        interventions.source_components_normalized += 1;
        interventions.source_pixels_removed += removed;
        if current_width > offender.maximum_width_px {
            interventions.source_components_unreachable += 1;
        }
        for y in 0..height {
            for x in 0..width {
                if initial_map.label_at(component.left + x, component.top + y) == offender.label
                    && !isolated.get(x, y)
                {
                    normalized.set(component.left + x, component.top + y, false);
                }
            }
        }
    }
    (normalized, Some(budget), interventions)
}

fn line_stroke_budget_has_offenders(source: &BinaryImage, dpi: f64) -> bool {
    LineStrokeBudget::from_binary(source, dpi).is_some_and(|(_, offenders)| !offenders.is_empty())
}

fn inactive_line_stroke_budget_interventions(
    source: &BinaryImage,
) -> LineStrokeBudgetInterventions {
    LineStrokeBudgetInterventions {
        raster_width: source.width(),
        raster_height: source.height(),
        ..LineStrokeBudgetInterventions::default()
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_thresholded_with_line_budget(
    thresholded: &BinaryImage,
    normalized: &GrayImage,
    raw_source: &GrayImage,
    options: &CleanupOptions,
    calibration: PageCalibration,
    picture_mask: Option<&BinaryImage>,
    text_vicinity: Option<&BinaryImage>,
    requested_mode: BinarizationMode,
    selected_mode: BinarizationMode,
    spread_fallback: bool,
    output_exclusion: Option<&BinaryImage>,
) -> (BinaryImage, bool, LineStrokeBudgetInterventions) {
    let mut preview_interventions = inactive_line_stroke_budget_interventions(thresholded);
    let (preview, preview_fallback) = postprocess_binary_with_diagnostics_and_raw_budgeted(
        thresholded,
        Some(normalized),
        Some(raw_source),
        options,
        calibration,
        None,
        &mut preview_interventions,
    );
    let preview = rescue_component_scoped_faint_strokes_budgeted(
        &preview,
        raw_source,
        picture_mask,
        text_vicinity,
        None,
        requested_mode,
        selected_mode,
        options.dpi,
        spread_fallback,
        None,
        &mut preview_interventions,
    );
    let preview = output_exclusion.map_or(preview.clone(), |mask| preview.subtract(mask));
    if !line_stroke_budget_has_offenders(&preview, options.dpi) {
        return (preview, preview_fallback, preview_interventions);
    }

    let (source, budget, mut interventions) =
        establish_line_stroke_budget(thresholded, options.dpi);
    let (output, fallback) = postprocess_binary_with_diagnostics_and_raw_budgeted(
        &source,
        Some(normalized),
        Some(raw_source),
        options,
        calibration,
        budget.as_ref(),
        &mut interventions,
    );
    let output = rescue_component_scoped_faint_strokes_budgeted(
        &output,
        raw_source,
        picture_mask,
        text_vicinity,
        None,
        requested_mode,
        selected_mode,
        options.dpi,
        spread_fallback,
        budget.as_ref(),
        &mut interventions,
    );
    let output = output_exclusion.map_or(output.clone(), |mask| output.subtract(mask));
    (output, fallback, interventions)
}

fn normalize_offender_component<F>(
    component: &BinaryImage,
    before_width_px: f64,
    maximum_width_px: f64,
    minimum_component_area: usize,
    can_remove: &F,
) -> Option<(BinaryImage, usize, f64)>
where
    F: Fn(&BinaryImage, usize, usize) -> bool,
{
    let before_topology = binary_topology_signature(component);
    let before_sub_floor = component_count_below_area(component, minimum_component_area);
    let mut candidate = component.clone();
    let mut removed = 0usize;
    let mut current_width = before_width_px;
    while current_width > maximum_width_px {
        let (removed_in_ring, measured_width) = erode_one_topology_preserving_boundary_ring(
            &mut candidate,
            maximum_width_px,
            can_remove,
        );
        if removed_in_ring == 0 {
            break;
        }
        removed += removed_in_ring;
        current_width = measured_width;
    }
    if removed == 0 {
        return None;
    }
    // The simple-point predicate is the primary topology guarantee. Keep a
    // whole-component release-build backstop so a future predicate regression
    // can only make an offender unreachable, never publish a split or hole.
    if before_topology != binary_topology_signature(&candidate)
        || component_count_below_area(&candidate, minimum_component_area) > before_sub_floor
    {
        return None;
    }
    Some((candidate, removed, current_width))
}

fn erode_one_topology_preserving_boundary_ring<F>(
    component: &mut BinaryImage,
    target_width_px: f64,
    can_remove: &F,
) -> (usize, f64)
where
    F: Fn(&BinaryImage, usize, usize) -> bool,
{
    let mut boundary = Vec::new();
    for y in 0..component.height() {
        for x in 0..component.width() {
            if !component.get(x, y) {
                continue;
            }
            let touches_paper = x == 0
                || y == 0
                || x + 1 == component.width()
                || y + 1 == component.height()
                || !component.get(x - 1, y)
                || !component.get(x + 1, y)
                || !component.get(x, y - 1)
                || !component.get(x, y + 1);
            if touches_paper {
                boundary.push((x, y));
            }
        }
    }
    let mut removed = 0usize;
    for (x, y) in boundary {
        if component.get(x, y) && can_remove(component, x, y) {
            component.set(x, y, false);
            removed += 1;
            let current_width = ridge_width_of_isolated_component(component);
            if current_width <= target_width_px {
                return (removed, current_width);
            }
        }
    }
    (removed, ridge_width_of_isolated_component(component))
}

fn topology_preserving_boundary_removal(component: &BinaryImage, x: usize, y: usize) -> bool {
    let mut pattern = 0u16;
    for offset_y in 0..3isize {
        for offset_x in 0..3isize {
            let sample_x = x as isize + offset_x - 1;
            let sample_y = y as isize + offset_y - 1;
            if sample_x >= 0
                && sample_y >= 0
                && sample_x < component.width() as isize
                && sample_y < component.height() as isize
                && component.get(sample_x as usize, sample_y as usize)
            {
                pattern |= 1 << (offset_y * 3 + offset_x);
            }
        }
    }
    let neighbor_count = (pattern & !(1 << 4)).count_ones();
    if pattern & (1 << 4) == 0 || neighbor_count < 2 {
        return false;
    }
    let changed = pattern & !(1 << 4);
    neighborhood_component_count(pattern, true, true)
        == neighborhood_component_count(changed, true, true)
        && neighborhood_component_count(pattern, false, false)
            == neighborhood_component_count(changed, false, false)
}

fn binary_topology_signature(source: &BinaryImage) -> (usize, usize) {
    let ink_components = ComponentMap::from_binary(source).components().len();
    let padded = BinaryImage::from_fn_parallel(source.width() + 2, source.height() + 2, |x, y| {
        x == 0
            || y == 0
            || x == source.width() + 1
            || y == source.height() + 1
            || !source.get(x - 1, y - 1)
    });
    let paper_components = ComponentMap::from_binary(&padded).components().len();
    (ink_components, paper_components.saturating_sub(1))
}

fn component_count_below_area(source: &BinaryImage, minimum_area: usize) -> usize {
    ComponentMap::from_binary(source)
        .components()
        .iter()
        .filter(|component| component.area < minimum_area)
        .count()
}

fn cap_added_ink_to_stroke_budget(
    base: &BinaryImage,
    candidate: &BinaryImage,
    source_supported_additions: Option<&BinaryImage>,
    budget: Option<&LineStrokeBudget>,
    stage: StrokeBudgetAdditionStage,
    interventions: &mut LineStrokeBudgetInterventions,
) -> BinaryImage {
    let Some(budget) = budget else {
        return candidate.clone();
    };
    assert_eq!(
        (base.width(), base.height()),
        (candidate.width(), candidate.height())
    );
    assert!(source_supported_additions.is_none_or(|mask| {
        mask.width() == candidate.width() && mask.height() == candidate.height()
    }));
    let adds_ink = (0..candidate.height())
        .any(|y| (0..candidate.width()).any(|x| candidate.get(x, y) && !base.get(x, y)));
    if !adds_ink {
        return candidate.clone();
    }
    let stage_budget =
        LineStrokeBudget::from_binary(candidate, budget.dpi).map(|(budget, _)| budget);
    let comparison_budget = stage_budget.as_ref().unwrap_or(budget);
    let map = ComponentMap::from_binary(candidate);
    let mut output = candidate.clone();
    let mut capped_components = 0usize;
    let mut capped_pixels = 0usize;
    for component in map.components() {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let mut sum_x = 0u64;
        let mut sum_y = 0u64;
        let mut added = 0usize;
        let mut isolated_candidate = BinaryImage::new(width, height);
        let mut base_overlap = BinaryImage::new(width, height);
        let mut protected_overlap = BinaryImage::new(width, height);
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if map.label_at(x, y) != component.label {
                    continue;
                }
                isolated_candidate.set(x - component.left, y - component.top, true);
                sum_x += x as u64;
                sum_y += y as u64;
                if base.get(x, y) {
                    base_overlap.set(x - component.left, y - component.top, true);
                } else {
                    added += 1;
                    if source_supported_additions.is_some_and(|mask| mask.get(x, y)) {
                        protected_overlap.set(x - component.left, y - component.top, true);
                    }
                }
            }
        }
        if added == 0 || base_overlap.count_black() == 0 {
            continue;
        }
        let center_x = sum_x as f64 / component.area as f64;
        let center_y = sum_y as f64 / component.area as f64;
        let Some(local_budget) = comparison_budget.local_budget_at(center_x, center_y) else {
            continue;
        };
        let candidate_width = component_ridge_width(candidate, &map, component.label);
        // The cap is an offender guard, not a normalizer. A line/component
        // already within the oracle's >1.6x tolerance is bit-for-bit untouched.
        if candidate_width <= local_budget.maximum_width_px {
            continue;
        }
        let base_map = ComponentMap::from_binary(&base_overlap);
        let base_width = base_map
            .components()
            .iter()
            .map(|base_component| {
                component_ridge_width(&base_overlap, &base_map, base_component.label)
            })
            .fold(0.0f64, f64::max);
        // A merge can evade the ridge cap when two already complete glyphs have
        // the same maximum ridge as the merged silhouette. Above tolerance,
        // reject that bridge rather than directionally shaving both glyphs.
        let rescue_crosses_full_weight = stage == StrokeBudgetAdditionStage::Rescue
            && base_map.components().len() > 1
            && base_width >= local_budget.median_width_px
            && candidate_width >= base_width;
        let protect_source_support =
            stage == StrokeBudgetAdditionStage::Rescue && base_width < local_budget.median_width_px;
        let mut capped = isolated_candidate.clone();
        let mut removed = 0usize;
        if base_width >= local_budget.maximum_width_px || rescue_crosses_full_weight {
            for y in 0..height {
                for x in 0..width {
                    if capped.get(x, y)
                        && !base_overlap.get(x, y)
                        && !(protect_source_support && protected_overlap.get(x, y))
                    {
                        capped.set(x, y, false);
                        removed += 1;
                    }
                }
            }
        } else {
            let (trimmed, reached_budget) = trim_added_ink_to_budget(
                &mut capped,
                &base_overlap,
                protect_source_support.then_some(&protected_overlap),
                local_budget.maximum_width_px,
            );
            removed = trimmed;
            // When ordinary additions cannot be brought within tolerance by
            // simple-point trimming, fall back to the base delta. The fragment
            // floor below rejects that fallback if it would detach debris.
            // Source-supported faint rescue is different: keep every protected
            // pixel and publish only safe pale-shell trimming.
            if !reached_budget && !protect_source_support {
                if base_width < local_budget.maximum_width_px {
                    capped = base_overlap.clone();
                    removed = added;
                } else {
                    continue;
                }
            }
        }
        if removed == 0 {
            continue;
        }
        let before_sub_floor = component_count_below_area(
            &isolated_candidate,
            comparison_budget.minimum_component_area,
        );
        if component_count_below_area(&capped, comparison_budget.minimum_component_area)
            > before_sub_floor
        {
            if !rescue_crosses_full_weight || base_width >= local_budget.maximum_width_px {
                continue;
            }
            capped = isolated_candidate.clone();
            let (trimmed, reached_budget) = trim_added_ink_to_budget(
                &mut capped,
                &base_overlap,
                None,
                local_budget.maximum_width_px,
            );
            if !reached_budget
                || component_count_below_area(&capped, comparison_budget.minimum_component_area)
                    > before_sub_floor
            {
                continue;
            }
            removed = trimmed;
        }
        capped_components += 1;
        capped_pixels += removed;
        if rescue_crosses_full_weight {
            interventions.rescue_bridge_components_capped += 1;
        }
        for y in 0..height {
            for x in 0..width {
                if isolated_candidate.get(x, y) && !capped.get(x, y) {
                    output.set(component.left + x, component.top + y, false);
                }
            }
        }
    }
    match stage {
        StrokeBudgetAdditionStage::Smoothing => {
            interventions.smoothing_components_capped += capped_components;
            interventions.smoothing_pixels_suppressed += capped_pixels;
        }
        StrokeBudgetAdditionStage::Rescue => {
            interventions.rescue_components_capped += capped_components;
            interventions.rescue_pixels_suppressed += capped_pixels;
        }
    }
    if capped_components == 0 {
        return candidate.clone();
    }
    output
}

fn trim_added_ink_to_budget(
    candidate: &mut BinaryImage,
    base: &BinaryImage,
    protected: Option<&BinaryImage>,
    maximum_width_px: f64,
) -> (usize, bool) {
    let mut removed = 0usize;
    let mut current_width = ridge_width_of_isolated_component(candidate);
    while current_width > maximum_width_px {
        let mut boundary = Vec::new();
        for y in 0..candidate.height() {
            for x in 0..candidate.width() {
                if !candidate.get(x, y)
                    || base.get(x, y)
                    || protected.is_some_and(|mask| mask.get(x, y))
                {
                    continue;
                }
                let touches_paper = x == 0
                    || y == 0
                    || x + 1 == candidate.width()
                    || y + 1 == candidate.height()
                    || !candidate.get(x - 1, y)
                    || !candidate.get(x + 1, y)
                    || !candidate.get(x, y - 1)
                    || !candidate.get(x, y + 1);
                if touches_paper {
                    boundary.push((x, y));
                }
            }
        }
        let before_ring = removed;
        for (x, y) in boundary {
            if candidate.get(x, y)
                && !base.get(x, y)
                && topology_preserving_boundary_removal(candidate, x, y)
            {
                candidate.set(x, y, false);
                removed += 1;
                current_width = ridge_width_of_isolated_component(candidate);
                if current_width <= maximum_width_px {
                    return (removed, true);
                }
            }
        }
        if removed == before_ring {
            break;
        }
        current_width = ridge_width_of_isolated_component(candidate);
    }
    (removed, current_width <= maximum_width_px)
}

fn trace_line_stroke_budget(interventions: &LineStrokeBudgetInterventions) {
    if std::env::var_os("EVB_STROKE_BUDGET_TRACE").is_some() {
        eprintln!(
            "EVB_STROKE_BUDGET {}",
            serde_json::to_string(interventions).expect("stroke-budget trace must serialize")
        );
    }
}

/// Raw Auto-routing measurements from the canonical, at-most-256px routing
/// sample. These values intentionally describe the decision basis rather than
/// the working-resolution raster that receives the selected threshold.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinarizationDiagnostics {
    pub route: BinarizationMode,
    pub robust_contrast: f64,
    pub illumination_deviation: f64,
    pub edge_density: f64,
    pub estimated_stroke_width_px: f64,
    pub dark_border_coverage: f64,
    pub otsu_adaptive_agreement: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spread_plan: Option<SpreadBinarizationPlanDiagnostics>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadBinarizationPlanDiagnostics {
    pub route: BinarizationMode,
    pub threshold_anchor: u8,
    pub threshold_radius: usize,
    pub stroke_width_anchor_px: f64,
    pub x_height_anchor_px: f64,
    pub document_anchor: bool,
    pub joint_candidate_route: BinarizationMode,
    pub left_candidate_route: BinarizationMode,
    pub right_candidate_route: BinarizationMode,
    pub decision: SpreadBinarizationPlanDecision,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpreadBinarizationPlanDecision {
    SharedJoint,
    PerLeafRouteMismatch,
    PerLeafAnchorDrift,
    PerLeafRadiusDrift,
    PerLeafFaintInkDrift,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SpreadBinarizationPlan {
    route: BinarizationMode,
    threshold_anchor: u8,
    threshold_radius: usize,
    x_height_anchor_px: f64,
    route_diagnostics: BinarizationDiagnostics,
    diagnostics: SpreadBinarizationPlanDiagnostics,
}

impl SpreadBinarizationPlan {
    pub(crate) fn diagnostics(self) -> BinarizationDiagnostics {
        let mut diagnostics = self.route_diagnostics;
        diagnostics.route = self.route;
        diagnostics.spread_plan = Some(self.diagnostics);
        diagnostics
    }

    pub(crate) fn uses_per_leaf_fallback(self) -> bool {
        self.diagnostics.decision != SpreadBinarizationPlanDecision::SharedJoint
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SpreadBinarizationPlans {
    pub left: SpreadBinarizationPlan,
    pub right: SpreadBinarizationPlan,
}

impl SpreadBinarizationPlans {
    pub(crate) fn for_half(
        self,
        half: crate::domain::geometry::PageHalf,
    ) -> SpreadBinarizationPlan {
        match half {
            crate::domain::geometry::PageHalf::Left => self.left,
            crate::domain::geometry::PageHalf::Right => self.right,
            crate::domain::geometry::PageHalf::Full => self.left,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BwResult {
    pub normalized: GrayImage,
    pub binary: BinaryImage,
    pub mode: BinarizationMode,
}

pub fn clean_black_and_white(source: &GrayImage, options: &CleanupOptions) -> BwResult {
    clean_black_and_white_with_calibration_config(source, options, CalibrationConfig::default())
}

#[doc(hidden)]
pub fn clean_black_and_white_with_calibration_config(
    source: &GrayImage,
    options: &CleanupOptions,
    calibration_config: CalibrationConfig,
) -> BwResult {
    let normalized = if options.normalize_illumination {
        normalize_illumination(source, options.dpi)
    } else {
        source.clone()
    };
    let calibration = PageCalibration::estimate(&normalized, options.dpi, calibration_config);
    let (binary, mode) =
        binarize_normalized_calibrated(&normalized, source, options, calibration, None, None);
    BwResult {
        normalized,
        binary,
        mode,
    }
}

/// Binarizes an already illumination-normalized image. Keeping normalization out of
/// this step lets callers resample gray tones exactly once before thresholding.
pub fn binarize_normalized(
    normalized: &GrayImage,
    options: &CleanupOptions,
) -> (BinaryImage, BinarizationMode) {
    let calibration =
        PageCalibration::estimate(normalized, options.dpi, CalibrationConfig::default());
    binarize_normalized_calibrated(normalized, normalized, options, calibration, None, None)
}

fn binarize_normalized_calibrated(
    normalized: &GrayImage,
    raw_source: &GrayImage,
    options: &CleanupOptions,
    calibration: PageCalibration,
    picture_mask: Option<&BinaryImage>,
    text_vicinity: Option<&BinaryImage>,
) -> (BinaryImage, BinarizationMode) {
    let threshold_input = smooth_for_binarization(normalized, options.dpi);
    let diagnostics = resolve_binarization_diagnostics(&threshold_input, options);
    let mode = diagnostics.route;
    (
        binarize_with_mode(
            &threshold_input,
            normalized,
            raw_source,
            options,
            mode,
            calibration,
            picture_mask,
            text_vicinity,
        ),
        mode,
    )
}

pub(crate) fn binarize_normalized_with_diagnostics(
    normalized: &GrayImage,
    raw_source: &GrayImage,
    routing_diagnostics: BinarizationDiagnostics,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
    picture_mask: Option<&BinaryImage>,
    text_vicinity: Option<&BinaryImage>,
    spread_plan: Option<&SpreadBinarizationPlan>,
) -> (
    BinaryImage,
    BinarizationDiagnostics,
    bool,
    BinarizationStageTimings,
) {
    let mut timings = BinarizationStageTimings::default();
    let preparation_started = Instant::now();
    let threshold_input = smooth_for_binarization(normalized, options.dpi);
    let diagnostics = spread_plan.map_or(routing_diagnostics, |plan| plan.diagnostics());
    timings.preparation_ms += preparation_started.elapsed().as_secs_f64() * 1_000.0;
    let thresholding_started = Instant::now();
    let binary = threshold_with_mode(
        &threshold_input,
        normalized,
        global_threshold_source,
        options,
        diagnostics.route,
        calibration,
        spread_plan,
    );
    timings.thresholding_ms += thresholding_started.elapsed().as_secs_f64() * 1_000.0;
    let postprocess_started = Instant::now();
    let (binary, despeckle_fallback, interventions) = finish_thresholded_with_line_budget(
        &binary,
        normalized,
        raw_source,
        options,
        calibration,
        picture_mask,
        text_vicinity,
        options.binarization,
        diagnostics.route,
        should_rescue_spread_fallback(spread_plan, &diagnostics),
        None,
    );
    trace_line_stroke_budget(&interventions);
    timings.postprocess_ms += postprocess_started.elapsed().as_secs_f64() * 1_000.0;
    (binary, diagnostics, despeckle_fallback, timings)
}

/// Mixed-mode binarization with picture pixels omitted from threshold
/// statistics and held white through despeckling and morphological smoothing.
pub(crate) fn binarize_normalized_with_diagnostics_excluding(
    normalized: &GrayImage,
    raw_source: &GrayImage,
    routing_diagnostics: BinarizationDiagnostics,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
    picture_mask: &BinaryImage,
    text_vicinity: Option<&BinaryImage>,
    spread_plan: Option<&SpreadBinarizationPlan>,
) -> (
    BinaryImage,
    BinarizationDiagnostics,
    bool,
    BinarizationStageTimings,
) {
    let mut timings = BinarizationStageTimings::default();
    let preparation_started = Instant::now();
    assert_eq!(
        (normalized.width(), normalized.height()),
        (picture_mask.width(), picture_mask.height())
    );
    if let Some(source) = global_threshold_source {
        assert_eq!(
            (normalized.width(), normalized.height()),
            (source.width(), source.height())
        );
    }
    let protection_radius = picture_protection_radius(options.dpi);
    let protected_picture_mask = dilate(picture_mask, protection_radius, protection_radius);
    let mut masked_input = normalized.clone();
    let masked_width = masked_input.width();
    masked_input
        .data_mut()
        .par_chunks_mut(masked_width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, value) in row.iter_mut().enumerate() {
                if protected_picture_mask.get(x, y) {
                    *value = 255;
                }
            }
        });
    let threshold_input = smooth_for_binarization(&masked_input, options.dpi);
    let diagnostics = spread_plan.map_or(routing_diagnostics, |plan| plan.diagnostics());
    timings.preparation_ms += preparation_started.elapsed().as_secs_f64() * 1_000.0;
    let thresholding_started = Instant::now();
    let binary = threshold_with_mode_excluding(
        &threshold_input,
        normalized,
        global_threshold_source,
        options,
        diagnostics.route,
        calibration,
        &protected_picture_mask,
        spread_plan,
    );
    timings.thresholding_ms += thresholding_started.elapsed().as_secs_f64() * 1_000.0;
    let postprocess_started = Instant::now();
    let (binary, despeckle_fallback, interventions) = finish_thresholded_with_line_budget(
        &binary,
        normalized,
        raw_source,
        options,
        calibration,
        Some(picture_mask),
        text_vicinity,
        options.binarization,
        diagnostics.route,
        should_rescue_spread_fallback(spread_plan, &diagnostics),
        Some(&protected_picture_mask),
    );
    trace_line_stroke_budget(&interventions);
    timings.postprocess_ms += postprocess_started.elapsed().as_secs_f64() * 1_000.0;
    (binary, diagnostics, despeckle_fallback, timings)
}

pub(crate) fn picture_protection_radius(dpi: f64) -> usize {
    (dpi * 0.35 / 25.4).round().clamp(1.0, 12.0) as usize
}

fn should_rescue_spread_fallback(
    spread_plan: Option<&SpreadBinarizationPlan>,
    diagnostics: &BinarizationDiagnostics,
) -> bool {
    let Some(plan) = spread_plan else {
        return false;
    };
    if !plan.uses_per_leaf_fallback() {
        return false;
    }

    // Local routes already have their own faint-stroke rescue. A divergent
    // Otsu leaf needs the same protection only when its evidence is sparse;
    // dense Otsu leaves must retain ordinary Otsu mass (the joint plan's
    // fallback rescue can otherwise add a visible amount of extra ink).
    matches!(
        diagnostics.route,
        BinarizationMode::Sauvola | BinarizationMode::Wolf
    ) || (diagnostics.route == BinarizationMode::Otsu && diagnostics.edge_density <= 0.32)
}

fn binarize_with_mode(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    raw_source: &GrayImage,
    options: &CleanupOptions,
    mode: BinarizationMode,
    calibration: PageCalibration,
    picture_mask: Option<&BinaryImage>,
    text_vicinity: Option<&BinaryImage>,
) -> BinaryImage {
    let binary = threshold_with_mode(
        threshold_input,
        normalized,
        None,
        options,
        mode,
        calibration,
        None,
    );
    let (output, _, interventions) = finish_thresholded_with_line_budget(
        &binary,
        normalized,
        raw_source,
        options,
        calibration,
        picture_mask,
        text_vicinity,
        options.binarization,
        mode,
        false,
        None,
    );
    trace_line_stroke_budget(&interventions);
    output
}

fn threshold_with_mode(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    mode: BinarizationMode,
    calibration: PageCalibration,
    spread_plan: Option<&SpreadBinarizationPlan>,
) -> BinaryImage {
    let radius = spread_plan.map_or_else(
        || calibration.threshold_radius(options.dpi),
        |plan| plan.threshold_radius,
    );
    let bias = i16::from(options.thickness) * crate::THICKNESS_GRAY_STEP;
    match mode {
        BinarizationMode::Otsu => {
            let source = global_threshold_source.unwrap_or(normalized);
            let decision = paper_ink_midpoint_threshold(source, None);
            let threshold = if decision.uniform_empty {
                decision.threshold
            } else {
                spread_plan.map_or(decision.threshold, |plan| plan.threshold_anchor)
            };
            let bias = if decision.uniform_empty { 0 } else { bias };
            threshold_global_biased(source, threshold, bias)
        }
        BinarizationMode::Sauvola => threshold_local_for_route(
            threshold_input,
            normalized,
            radius,
            LocalThreshold::Sauvola { k: SAUVOLA_K },
            bias,
            calibration,
            options.dpi,
            spread_plan.map(|plan| plan.threshold_radius),
            spread_plan.map(|plan| plan.x_height_anchor_px),
        ),
        BinarizationMode::Wolf | BinarizationMode::Auto => threshold_local_for_route(
            threshold_input,
            normalized,
            radius,
            LocalThreshold::Wolf {
                k: WOLF_K,
                deviation_floor: 2.0,
                minimum_percentile: WOLF_MINIMUM_PERCENTILE,
                hard_ink: WOLF_HARD_INK,
                hard_paper: WOLF_HARD_PAPER,
            },
            bias,
            calibration,
            options.dpi,
            spread_plan.map(|plan| plan.threshold_radius),
            spread_plan.map(|plan| plan.x_height_anchor_px),
        ),
    }
}

fn threshold_with_mode_excluding(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    global_threshold_source: Option<&GrayImage>,
    options: &CleanupOptions,
    mode: BinarizationMode,
    calibration: PageCalibration,
    picture_mask: &BinaryImage,
    spread_plan: Option<&SpreadBinarizationPlan>,
) -> BinaryImage {
    let radius = spread_plan.map_or_else(
        || calibration.threshold_radius(options.dpi),
        |plan| plan.threshold_radius,
    );
    let bias = i16::from(options.thickness) * crate::THICKNESS_GRAY_STEP;
    match mode {
        BinarizationMode::Otsu => {
            let source = global_threshold_source.unwrap_or(normalized);
            let decision = paper_ink_midpoint_threshold(source, Some(picture_mask));
            let threshold = if decision.uniform_empty {
                decision.threshold
            } else {
                spread_plan.map_or(decision.threshold, |plan| plan.threshold_anchor)
            };
            let bias = if decision.uniform_empty { 0 } else { bias };
            threshold_global_biased(source, threshold, bias).subtract(picture_mask)
        }
        BinarizationMode::Sauvola => threshold_local_for_route_excluding(
            threshold_input,
            normalized,
            picture_mask,
            radius,
            LocalThreshold::Sauvola { k: SAUVOLA_K },
            bias,
            calibration,
            options.dpi,
            spread_plan.map(|plan| plan.threshold_radius),
            spread_plan.map(|plan| plan.x_height_anchor_px),
        ),
        BinarizationMode::Wolf | BinarizationMode::Auto => threshold_local_for_route_excluding(
            threshold_input,
            normalized,
            picture_mask,
            radius,
            LocalThreshold::Wolf {
                k: WOLF_K,
                deviation_floor: 2.0,
                minimum_percentile: WOLF_MINIMUM_PERCENTILE,
                hard_ink: WOLF_HARD_INK,
                hard_paper: WOLF_HARD_PAPER,
            },
            bias,
            calibration,
            options.dpi,
            spread_plan.map(|plan| plan.threshold_radius),
            spread_plan.map(|plan| plan.x_height_anchor_px),
        ),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GlobalThresholdDecision {
    threshold: u8,
    uniform_empty: bool,
}

fn paper_ink_midpoint_threshold(
    image: &GrayImage,
    exclusion: Option<&BinaryImage>,
) -> GlobalThresholdDecision {
    let mut histogram = [0usize; 256];
    for y in 0..image.height() {
        for x in 0..image.width() {
            if exclusion.is_some_and(|mask| mask.get(x, y)) {
                continue;
            }
            histogram[image.get(x, y) as usize] += 1;
        }
    }
    let total = histogram.iter().sum::<usize>();
    if total == 0 {
        return GlobalThresholdDecision {
            threshold: 127,
            uniform_empty: true,
        };
    }
    let darkest = histogram.iter().position(|&count| count > 0).unwrap_or(0) as u8;
    let lightest = histogram
        .iter()
        .rposition(|&count| count > 0)
        .unwrap_or(255) as u8;
    let darkest_end = usize::from(darkest).saturating_add(2).min(255);
    let darkest_three = histogram[usize::from(darkest)..=darkest_end]
        .iter()
        .sum::<usize>();
    // Otsu has no foreground class to separate on a normalized blank leaf.
    // A narrow range is not enough to prove that case: faint uniform print
    // can sit only a few levels below paper. The shortcut is valid only when
    // the dark end is itself the dominant paper class. Its exclusive
    // threshold must also bypass thickness bias or the paper class floods.
    if lightest.saturating_sub(darkest) <= UNIFORM_PAPER_MAXIMUM_RANGE
        && darkest_three.saturating_mul(5) >= total
    {
        return GlobalThresholdDecision {
            threshold: darkest,
            uniform_empty: true,
        };
    }
    let otsu = exclusion.map_or_else(
        || otsu_threshold(image),
        |mask| otsu_threshold_excluding(image, mask),
    );
    let dark_count = histogram[..=otsu as usize].iter().sum::<usize>();
    if dark_count < 16 {
        return GlobalThresholdDecision {
            threshold: otsu,
            uniform_empty: false,
        };
    }
    let percentile = |rank: usize| {
        let mut cumulative = 0usize;
        histogram
            .iter()
            .position(|frequency| {
                cumulative += *frequency;
                cumulative > rank
            })
            .unwrap_or(255) as u8
    };
    // On clean uniform paper, the Otsu boundary is sensitive to how many
    // antialiased edge pixels happen to be present. Anchor the destructive
    // threshold at the physical paper/ink endpoints instead: a low quantile
    // of the Otsu-dark class estimates the ink core, while the page's 70th
    // percentile estimates its dominant paper. Their midpoint preserves the
    // 50% glyph boundary across paper shades and tints.
    let ink_core = percentile(dark_count.saturating_sub(1) / 10);
    let paper = percentile(total.saturating_sub(1) * 7 / 10);
    let threshold = if paper <= ink_core.saturating_add(8) {
        otsu
    } else {
        ((u16::from(ink_core) + u16::from(paper)) / 2) as u8
    };
    GlobalThresholdDecision {
        threshold,
        uniform_empty: false,
    }
}

#[allow(clippy::too_many_arguments)]
fn threshold_local_for_route_excluding(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    picture_mask: &BinaryImage,
    legacy_radius: usize,
    method: LocalThreshold,
    bias: i16,
    calibration: PageCalibration,
    raster_dpi: f64,
    shared_threshold_radius: Option<usize>,
    shared_x_height_px: Option<f64>,
) -> BinaryImage {
    if !calibration.config.multiscale_local_threshold {
        return threshold_local_biased_excluding(
            threshold_input,
            picture_mask,
            legacy_radius,
            method,
            bias,
        );
    }
    let integrals = MaskedIntegralImages::new(threshold_input, picture_mask);
    let [small_radius, medium_radius, large_radius] = multiscale_threshold_radii(
        calibration,
        raster_dpi,
        shared_threshold_radius,
        shared_x_height_px,
    );
    threshold_local_multiscale_biased_excluding_with_integrals_for_consensus(
        threshold_input,
        picture_mask,
        &integrals,
        [small_radius, medium_radius, large_radius],
        method,
        bias,
        |x, y| sobel_gradient_magnitude(normalized, x, y) > STROKE_EDGE_THRESHOLD,
    )
}

fn threshold_local_for_route(
    threshold_input: &GrayImage,
    normalized: &GrayImage,
    legacy_radius: usize,
    method: LocalThreshold,
    bias: i16,
    calibration: PageCalibration,
    raster_dpi: f64,
    shared_threshold_radius: Option<usize>,
    shared_x_height_px: Option<f64>,
) -> BinaryImage {
    if !calibration.config.multiscale_local_threshold {
        return threshold_local_biased(threshold_input, legacy_radius, method, bias);
    }

    let integrals = IntegralImages::new(threshold_input);
    let [small_radius, medium_radius, large_radius] = multiscale_threshold_radii(
        calibration,
        raster_dpi,
        shared_threshold_radius,
        shared_x_height_px,
    );
    threshold_local_multiscale_biased_with_integrals_for_consensus(
        threshold_input,
        &integrals,
        [small_radius, medium_radius, large_radius],
        method,
        bias,
        |x, y| sobel_gradient_magnitude(normalized, x, y) > STROKE_EDGE_THRESHOLD,
    )
}

fn multiscale_threshold_radii(
    calibration: PageCalibration,
    raster_dpi: f64,
    shared_threshold_radius: Option<usize>,
    shared_x_height_px: Option<f64>,
) -> [usize; 3] {
    shared_threshold_radius.map_or_else(
        || calibration.multiscale_threshold_radii(raster_dpi),
        |base_radius| {
            let shared_x_height = shared_x_height_px.unwrap_or_else(|| {
                // Legacy callers without a spread plan have no explicit
                // x-height. Keep their old radius-derived behavior, while
                // spread plans carry the unclamped document/leaf estimate.
                base_radius as f64 / 1.5
            }) * raster_dpi.max(1.0)
                / calibration.effective_dpi.max(1.0);
            [1.0, 2.5, 5.0]
                .map(|scale| (scale * shared_x_height).round() as usize)
                .map(|radius| radius.clamp(8, 256))
        },
    )
}

fn sobel_gradient_magnitude(image: &GrayImage, x: usize, y: usize) -> u16 {
    if image.width() == 0 || image.height() == 0 {
        return 0;
    }
    let left = x.saturating_sub(1);
    let right = x.saturating_add(1).min(image.width() - 1);
    let top = y.saturating_sub(1);
    let bottom = y.saturating_add(1).min(image.height() - 1);
    let top_left = i32::from(image.get(left, top));
    let top_center = i32::from(image.get(x, top));
    let top_right = i32::from(image.get(right, top));
    let center_left = i32::from(image.get(left, y));
    let center_right = i32::from(image.get(right, y));
    let bottom_left = i32::from(image.get(left, bottom));
    let bottom_center = i32::from(image.get(x, bottom));
    let bottom_right = i32::from(image.get(right, bottom));
    let gradient_x =
        -top_left + top_right - 2 * center_left + 2 * center_right - bottom_left + bottom_right;
    let gradient_y =
        -top_left - 2 * top_center - top_right + bottom_left + 2 * bottom_center + bottom_right;

    ((gradient_x.unsigned_abs() + gradient_y.unsigned_abs() + 2) / 4).min(u32::from(u16::MAX))
        as u16
}

#[cfg(test)]
fn postprocess_binary_with_raw(
    binary: &BinaryImage,
    normalized: Option<&GrayImage>,
    raw: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
) -> BinaryImage {
    let mut interventions = LineStrokeBudgetInterventions::default();
    postprocess_binary_with_raw_budgeted(
        binary,
        normalized,
        raw,
        options,
        calibration,
        None,
        &mut interventions,
    )
}

#[cfg(test)]
fn postprocess_binary_with_raw_budgeted(
    binary: &BinaryImage,
    normalized: Option<&GrayImage>,
    raw: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
    budget: Option<&LineStrokeBudget>,
    interventions: &mut LineStrokeBudgetInterventions,
) -> BinaryImage {
    postprocess_binary_with_diagnostics_and_raw_budgeted(
        binary,
        normalized,
        raw,
        options,
        calibration,
        budget,
        interventions,
    )
    .0
}

pub(crate) fn postprocess_binary_with_diagnostics_and_raw(
    binary: &BinaryImage,
    normalized: Option<&GrayImage>,
    raw: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
) -> (BinaryImage, bool) {
    let mut interventions = LineStrokeBudgetInterventions::default();
    postprocess_binary_with_diagnostics_and_raw_budgeted(
        binary,
        normalized,
        raw,
        options,
        calibration,
        None,
        &mut interventions,
    )
}

fn postprocess_binary_with_diagnostics_and_raw_budgeted(
    binary: &BinaryImage,
    normalized: Option<&GrayImage>,
    raw: Option<&GrayImage>,
    options: &CleanupOptions,
    calibration: PageCalibration,
    budget: Option<&LineStrokeBudget>,
    interventions: &mut LineStrokeBudgetInterventions,
) -> (BinaryImage, bool) {
    let level = options.effective_despeckle_level();
    let rule_components = raw
        .filter(|image| image.width() == binary.width() && image.height() == binary.height())
        .map(|image| rule_scale_component_flags(binary, image, options.dpi));
    let (despeckled, despeckle_fallback) = if level != DespeckleLevel::Off {
        let outcome = despeckle_connected_impl_with_protection(
            binary,
            normalized,
            rule_components.as_deref(),
            options.dpi,
            calibration,
            level,
            true,
        );
        (outcome.image, outcome.fallback)
    } else {
        (binary.clone(), false)
    };
    let smoothed_candidate = smooth_edges_for_page(&despeckled, options.dpi);
    let smoothed = cap_added_ink_to_stroke_budget(
        &despeckled,
        &smoothed_candidate,
        None,
        budget,
        StrokeBudgetAdditionStage::Smoothing,
        interventions,
    );
    let preserved_rules = rule_components.map(|flags| {
        ComponentMap::from_binary(binary).retain(|component| flags[component.label as usize])
    });
    let output = match preserved_rules {
        Some(rules) => smoothed.or(&rules),
        None => smoothed,
    };
    (output, despeckle_fallback)
}

pub(crate) fn resolve_binarization_diagnostics(
    image: &GrayImage,
    options: &CleanupOptions,
) -> BinarizationDiagnostics {
    let mut diagnostics = measure_binarization_diagnostics(image, options);
    diagnostics.route = match options.binarization {
        BinarizationMode::Auto => choose_mode(
            diagnostics.robust_contrast,
            diagnostics.illumination_deviation,
            diagnostics.edge_density,
            diagnostics.estimated_stroke_width_px,
            diagnostics.dark_border_coverage,
            diagnostics.otsu_adaptive_agreement,
        ),
        explicit => explicit,
    };
    diagnostics
}

fn measure_binarization_diagnostics(
    image: &GrayImage,
    options: &CleanupOptions,
) -> BinarizationDiagnostics {
    let sample = image.downscale_to_fit(256, 256);
    let otsu = threshold_global(&sample, otsu_threshold(&sample));
    let adaptive_radius =
        ((sample.width().min(sample.height()) as f64 * 0.035).round() as usize).clamp(4, 12);
    let adaptive = threshold_local(
        &sample,
        adaptive_radius,
        LocalThreshold::Wolf {
            k: WOLF_K,
            deviation_floor: 2.0,
            minimum_percentile: WOLF_MINIMUM_PERCENTILE,
            hard_ink: WOLF_HARD_INK,
            hard_paper: WOLF_HARD_PAPER,
        },
    );
    let robust_contrast =
        f64::from(image_percentile(&sample, 0.95)) - f64::from(image_percentile(&sample, 0.05));
    let illumination_deviation = tile_paper_deviation(&sample);
    let edge_density = edge_density(&sample);
    // The route threshold is calibrated in the bounded measurement sample's
    // pixels. Keep this estimate in that same space: scaling it back into the
    // canonical input makes the <=8 Sauvola gate depend on page dimensions and
    // silently kills the route on ordinary production pages.
    let estimated_stroke_width_px = estimated_stroke_width(&otsu);
    let dark_border_coverage = dark_border_coverage(&sample, otsu_threshold(&sample));
    let otsu_adaptive_agreement = binary_agreement(&otsu, &adaptive);
    BinarizationDiagnostics {
        route: options.binarization,
        robust_contrast,
        illumination_deviation,
        edge_density,
        estimated_stroke_width_px,
        dark_border_coverage,
        otsu_adaptive_agreement,
        spread_plan: None,
    }
}

/// Resolves a symmetric spread candidate first, then keeps each leaf's own
/// route/threshold scale whenever the evidence is materially different. On a
/// shared plan the joint measurement (taken on the illumination-normalized
/// spread) and the leaf measurements (taken on the raw canonical crops) can
/// disagree about the route, and neither reading is authoritative: the joint
/// override sent low-contrast register pages from Otsu into Wolf, while the
/// leaf vote sent photo-plate pages the other way. Both failures embolden
/// individual words, because the local thresholders re-normalize contrast per
/// window. A disagreement therefore means the routing evidence is marginal,
/// and the shared plan resolves it toward the global thresholder: Otsu wins
/// whenever either reading proposes it, and only a disagreement between two
/// local routes keeps the leaf reading. The joint route always survives as a
/// reported candidate.
#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_spread_binarization_plans(
    routing_joint: &GrayImage,
    routing_left: &GrayImage,
    routing_right: &GrayImage,
    canonical_left: &GrayImage,
    canonical_right: &GrayImage,
    canonical_left_picture_mask: Option<&BinaryImage>,
    canonical_right_picture_mask: Option<&BinaryImage>,
    canonical_dpi: f64,
    options: &CleanupOptions,
    calibration: PageCalibration,
    document_stroke_width_px: Option<f64>,
    document_x_height_px: Option<f64>,
) -> SpreadBinarizationPlans {
    let joint = measure_binarization_diagnostics(routing_joint, options);
    let left_candidate = measure_binarization_diagnostics(routing_left, options);
    let right_candidate = measure_binarization_diagnostics(routing_right, options);
    let joint_route = match options.binarization {
        BinarizationMode::Auto => resolve_route_for_diagnostics(&joint, options),
        explicit => explicit,
    };
    let left_route = resolve_route_for_diagnostics(&left_candidate, options);
    let right_route = resolve_route_for_diagnostics(&right_candidate, options);
    let canonical_dpi = canonical_dpi.max(1.0);
    // Absolute gray-level anchors are measured on the full canonical leaf.
    // Downscaling is valid for route features, but it blends away the ink core
    // this histogram threshold deliberately anchors to. Picture ownership is
    // excluded, not whitened into the paper population.
    let left_anchor =
        full_leaf_intensity_anchor(canonical_left, canonical_left_picture_mask, canonical_dpi);
    let right_anchor =
        full_leaf_intensity_anchor(canonical_right, canonical_right_picture_mask, canonical_dpi);
    let left_input =
        masked_spread_input(canonical_left, canonical_left_picture_mask, canonical_dpi);
    let right_input =
        masked_spread_input(canonical_right, canonical_right_picture_mask, canonical_dpi);
    // Reconciliation must not depend on the output render. Measure it on the
    // full canonical leaves, retaining the established semantics of comparing
    // clamped pixel radii (rather than raw x-heights). The selected radii are
    // subsequently expressed in working pixels for the actual threshold.
    let left_calibration =
        PageCalibration::estimate(canonical_left, canonical_dpi, calibration.config);
    let right_calibration =
        PageCalibration::estimate(canonical_right, canonical_dpi, calibration.config);
    let left_x_height = leaf_x_height(left_calibration, None, calibration, canonical_dpi);
    let right_x_height = leaf_x_height(right_calibration, None, calibration, canonical_dpi);
    let left_reference_radius =
        threshold_radius_for_x_height_at_dpi(left_x_height, canonical_dpi, calibration);
    let right_reference_radius =
        threshold_radius_for_x_height_at_dpi(right_x_height, canonical_dpi, calibration);
    let route_mismatch = left_route != right_route;
    let anchor_drift = relative_difference(f64::from(left_anchor), f64::from(right_anchor)) > 0.20;
    let radius_drift =
        relative_difference(left_reference_radius as f64, right_reference_radius as f64) > 0.20;
    let faint_ink_drift = relative_difference(
        faint_ink_fraction(&left_input),
        faint_ink_fraction(&right_input),
    ) > 0.20;
    let decision = if route_mismatch {
        SpreadBinarizationPlanDecision::PerLeafRouteMismatch
    } else if anchor_drift {
        SpreadBinarizationPlanDecision::PerLeafAnchorDrift
    } else if radius_drift {
        SpreadBinarizationPlanDecision::PerLeafRadiusDrift
    } else if faint_ink_drift {
        SpreadBinarizationPlanDecision::PerLeafFaintInkDrift
    } else {
        SpreadBinarizationPlanDecision::SharedJoint
    };
    if std::env::var_os("EVB_SCAN_CLEANUP_TRACE_SPREAD_PLAN").is_some() {
        eprintln!(
            "spread-plan left-anchor={} right-anchor={} left-radius={} right-radius={} left-route={:?} right-route={:?} decision={decision:?}",
            left_anchor,
            right_anchor,
            left_reference_radius,
            right_reference_radius,
            left_route,
            right_route,
        );
    }

    let shared_x_height = document_x_height_px
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or((left_x_height + right_x_height) / 2.0);
    let shared_anchor = midpoint_u8(left_anchor, right_anchor);
    let shared_stroke_width = document_stroke_width_px
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or_else(|| {
            let left_stroke = leaf_stroke_width(
                left_calibration,
                left_candidate.estimated_stroke_width_px,
                calibration,
                canonical_dpi,
            );
            let right_stroke = leaf_stroke_width(
                right_calibration,
                right_candidate.estimated_stroke_width_px,
                calibration,
                canonical_dpi,
            );
            (left_stroke + right_stroke) / 2.0
        });
    let common_diagnostics =
        |route: BinarizationMode,
         threshold_anchor: u8,
         threshold_radius: usize,
         x_height_anchor_px: f64,
         document_anchor: bool,
         decision: SpreadBinarizationPlanDecision| {
            SpreadBinarizationPlanDiagnostics {
                route,
                threshold_anchor,
                threshold_radius,
                stroke_width_anchor_px: shared_stroke_width,
                x_height_anchor_px,
                document_anchor,
                joint_candidate_route: joint_route,
                left_candidate_route: left_route,
                right_candidate_route: right_route,
                decision,
            }
        };
    let shared_route =
        if left_route == BinarizationMode::Otsu || joint_route == BinarizationMode::Otsu {
            BinarizationMode::Otsu
        } else {
            left_route
        };
    let shared_plan = SpreadBinarizationPlan {
        route: shared_route,
        threshold_anchor: shared_anchor,
        threshold_radius: threshold_radius_for_x_height(shared_x_height, options, calibration),
        x_height_anchor_px: shared_x_height,
        route_diagnostics: left_candidate,
        diagnostics: common_diagnostics(
            shared_route,
            shared_anchor,
            threshold_radius_for_x_height(shared_x_height, options, calibration),
            shared_x_height,
            document_x_height_px.is_some() || document_stroke_width_px.is_some(),
            decision,
        ),
    };
    if decision == SpreadBinarizationPlanDecision::SharedJoint {
        return SpreadBinarizationPlans {
            left: shared_plan,
            right: SpreadBinarizationPlan {
                route_diagnostics: right_candidate,
                ..shared_plan
            },
        };
    }

    let left_plan = leaf_plan(
        left_route,
        left_anchor,
        left_calibration,
        left_candidate.estimated_stroke_width_px,
        options,
        calibration,
        canonical_dpi,
        document_stroke_width_px,
        document_x_height_px,
        left_candidate,
        common_diagnostics,
        decision,
    );
    let right_plan = leaf_plan(
        right_route,
        right_anchor,
        right_calibration,
        right_candidate.estimated_stroke_width_px,
        options,
        calibration,
        canonical_dpi,
        document_stroke_width_px,
        document_x_height_px,
        right_candidate,
        common_diagnostics,
        decision,
    );
    SpreadBinarizationPlans {
        left: left_plan,
        right: right_plan,
    }
}

#[allow(clippy::too_many_arguments)]
fn leaf_plan<F>(
    route: BinarizationMode,
    threshold_anchor: u8,
    leaf_calibration: PageCalibration,
    estimated_stroke_width_px: f64,
    options: &CleanupOptions,
    spread_calibration: PageCalibration,
    canonical_dpi: f64,
    document_stroke_width_px: Option<f64>,
    document_x_height_px: Option<f64>,
    route_diagnostics: BinarizationDiagnostics,
    diagnostics: F,
    decision: SpreadBinarizationPlanDecision,
) -> SpreadBinarizationPlan
where
    F: Fn(
        BinarizationMode,
        u8,
        usize,
        f64,
        bool,
        SpreadBinarizationPlanDecision,
    ) -> SpreadBinarizationPlanDiagnostics,
{
    let x_height_anchor_px = if leaf_calibration.valid {
        leaf_x_height(leaf_calibration, None, spread_calibration, canonical_dpi)
    } else {
        document_x_height_px
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or_else(|| {
                leaf_x_height(leaf_calibration, None, spread_calibration, canonical_dpi)
            })
    };
    let threshold_radius =
        threshold_radius_for_x_height(x_height_anchor_px, options, spread_calibration);
    let stroke_width_anchor_px = document_stroke_width_px
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or_else(|| {
            leaf_stroke_width(
                leaf_calibration,
                estimated_stroke_width_px,
                spread_calibration,
                canonical_dpi,
            )
        });
    let mut plan_diagnostics = diagnostics(
        route,
        threshold_anchor,
        threshold_radius,
        x_height_anchor_px,
        document_x_height_px.is_some() || document_stroke_width_px.is_some(),
        decision,
    );
    plan_diagnostics.stroke_width_anchor_px = stroke_width_anchor_px;
    SpreadBinarizationPlan {
        route,
        threshold_anchor,
        threshold_radius,
        x_height_anchor_px,
        route_diagnostics,
        diagnostics: plan_diagnostics,
    }
}

fn masked_spread_input(
    image: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    dpi: f64,
) -> GrayImage {
    let Some(picture_mask) = picture_mask else {
        return image.clone();
    };
    let protected = protected_picture_mask(picture_mask, dpi);
    let mut masked = image.clone();
    let width = masked.width();
    let stride = masked.stride();
    if width == 0 {
        return masked;
    }
    masked
        .data_mut()
        .par_chunks_mut(stride)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, value) in row[..width].iter_mut().enumerate() {
                if protected.get(x, y) {
                    *value = 255;
                }
            }
        });
    masked
}

fn faint_ink_fraction(image: &GrayImage) -> f64 {
    let paper = paper_reference(image);
    let threshold = paper.saturating_sub(24);
    let total = image.width().saturating_mul(image.height()).max(1);
    (0..image.height())
        .map(|y| {
            image
                .row(y)
                .iter()
                .filter(|&&value| value < threshold)
                .count()
        })
        .sum::<usize>() as f64
        / total as f64
}

fn protected_picture_mask(mask: &BinaryImage, dpi: f64) -> BinaryImage {
    dilate(
        mask,
        picture_protection_radius(dpi),
        picture_protection_radius(dpi),
    )
}

fn full_leaf_intensity_anchor(
    image: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    dpi: f64,
) -> u8 {
    let protected_picture_mask = picture_mask.map(|mask| protected_picture_mask(mask, dpi));
    paper_ink_midpoint_threshold(image, protected_picture_mask.as_ref()).threshold
}

fn leaf_x_height(
    leaf_calibration: PageCalibration,
    document_x_height_px: Option<f64>,
    spread_calibration: PageCalibration,
    working_dpi: f64,
) -> f64 {
    document_x_height_px
        .filter(|value| value.is_finite() && *value > 0.0)
        .or_else(|| {
            leaf_calibration
                .valid
                .then_some(
                    leaf_calibration.x_height_px * spread_calibration.effective_dpi.max(1.0)
                        / working_dpi.max(1.0),
                )
                .filter(|value| value.is_finite() && *value > 0.0)
        })
        .unwrap_or(
            FALLBACK_X_HEIGHT_AT_300_DPI_PX * spread_calibration.effective_dpi.max(1.0) / 300.0,
        )
}

fn leaf_stroke_width(
    leaf_calibration: PageCalibration,
    estimated_stroke_width_px: f64,
    spread_calibration: PageCalibration,
    working_dpi: f64,
) -> f64 {
    leaf_calibration
        .valid
        .then_some(
            leaf_calibration.stroke_width_px * spread_calibration.effective_dpi.max(1.0)
                / working_dpi.max(1.0),
        )
        .filter(|value| value.is_finite() && *value > 0.0)
        .or_else(|| {
            (estimated_stroke_width_px.is_finite() && estimated_stroke_width_px > 0.0)
                .then_some(estimated_stroke_width_px)
        })
        .unwrap_or_else(|| spread_calibration.stroke_width_px.max(1.0))
}

fn threshold_radius_for_x_height(
    x_height_anchor_px: f64,
    options: &CleanupOptions,
    calibration: PageCalibration,
) -> usize {
    threshold_radius_for_x_height_at_dpi(x_height_anchor_px, options.dpi, calibration)
}

fn threshold_radius_for_x_height_at_dpi(
    x_height_anchor_px: f64,
    dpi: f64,
    calibration: PageCalibration,
) -> usize {
    (1.5 * x_height_anchor_px * dpi.max(1.0) / calibration.effective_dpi.max(1.0))
        .round()
        .clamp(8.0, 64.0) as usize
}

fn relative_difference(left: f64, right: f64) -> f64 {
    (left - right).abs() / left.abs().max(right.abs()).max(f64::EPSILON)
}

fn midpoint_u8(left: u8, right: u8) -> u8 {
    ((u16::from(left) + u16::from(right)) / 2) as u8
}

fn resolve_route_for_diagnostics(
    diagnostics: &BinarizationDiagnostics,
    options: &CleanupOptions,
) -> BinarizationMode {
    match options.binarization {
        BinarizationMode::Auto => choose_mode(
            diagnostics.robust_contrast,
            diagnostics.illumination_deviation,
            diagnostics.edge_density,
            diagnostics.estimated_stroke_width_px,
            diagnostics.dark_border_coverage,
            diagnostics.otsu_adaptive_agreement,
        ),
        explicit => explicit,
    }
}

fn choose_mode(
    robust_contrast: f64,
    illumination_deviation: f64,
    edge_density: f64,
    estimated_stroke_width_px: f64,
    dark_border_coverage: f64,
    otsu_adaptive_agreement: f64,
) -> BinarizationMode {
    // On a flat-lit sheet Wolf has no illumination to correct and its local
    // contrast normalization erases faint strokes outright, so the agreement
    // guard must not be the deciding vote there: the disagreement it measures
    // on such pages IS Wolf dropping faint text, and routing by it sends the
    // page into the very mode that damages it. Flat pages accept a lower
    // agreement before giving up on the global threshold.
    let agreement_floor = if illumination_deviation <= 2.0 {
        0.95
    } else {
        0.975
    };
    let flat_lit_text = illumination_deviation <= 8.0
        && otsu_adaptive_agreement >= agreement_floor
        && (robust_contrast >= 64.0 || edge_density <= 0.18);
    let near_boundary_otsu = dark_border_coverage >= FLAT_LIT_OTSU_DARK_BORDER_COVERAGE_BAND.0
        && dark_border_coverage <= FLAT_LIT_OTSU_DARK_BORDER_COVERAGE_BAND.1;
    if flat_lit_text && (dark_border_coverage <= 0.08 || near_boundary_otsu) {
        return BinarizationMode::Otsu;
    }
    let uneven_text = illumination_deviation > 12.0
        && edge_density <= 0.24
        && estimated_stroke_width_px <= 8.0
        && otsu_adaptive_agreement >= 0.84;
    if uneven_text {
        BinarizationMode::Sauvola
    } else {
        BinarizationMode::Wolf
    }
}

fn image_percentile(image: &GrayImage, fraction: f64) -> u8 {
    let mut histogram = [0usize; 256];
    for y in 0..image.height() {
        for &value in image.row(y) {
            histogram[value as usize] += 1;
        }
    }
    let count = image.width().saturating_mul(image.height());
    if count == 0 {
        return 255;
    }
    let target = ((count - 1) as f64 * fraction.clamp(0.0, 1.0)).round() as usize;
    let mut cumulative = 0usize;
    for (value, frequency) in histogram.into_iter().enumerate() {
        cumulative += frequency;
        if cumulative > target {
            return value as u8;
        }
    }
    255
}

fn tile_paper_deviation(image: &GrayImage) -> f64 {
    let paper = paper_reference(image);
    let paper_floor = paper.saturating_sub(TILE_PAPER_DELTA);
    let filtered_paper = tile_paper_values(image, Some(paper_floor));
    if filtered_paper.len() >= MIN_QUALIFYING_PAPER_TILES {
        return paper_spread(&filtered_paper);
    }
    paper_spread(&tile_paper_values(image, None))
}

pub(crate) fn paper_reference(image: &GrayImage) -> u8 {
    let mut histogram = [0usize; 256];
    for y in 0..image.height() {
        for &value in image.row(y) {
            histogram[value as usize] += 1;
        }
    }
    let target = image
        .width()
        .saturating_mul(image.height())
        .saturating_sub(1)
        .saturating_mul(3)
        / 4;
    let mut cumulative = 0usize;
    histogram
        .iter()
        .position(|frequency| {
            cumulative += frequency;
            cumulative > target
        })
        .unwrap_or(255) as u8
}

/// Recover faint print that a selected local threshold dropped, but only as
/// compact raw-plane components aligned with an independent text-row signal.
/// Faint rescue runs for a selected local route or a selected Otsu route, but
/// only after the component-, row-, picture-, and raw-plane gates below pass.
pub(crate) fn rescue_component_scoped_faint_strokes(
    damaged: &BinaryImage,
    raw: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    text_vicinity: Option<&BinaryImage>,
    row_evidence_exclusion: Option<&BinaryImage>,
    requested_mode: BinarizationMode,
    selected_mode: BinarizationMode,
    dpi: f64,
    spread_fallback: bool,
) -> BinaryImage {
    let mut interventions = LineStrokeBudgetInterventions::default();
    let budget = LineStrokeBudget::from_binary(damaged, dpi).map(|(budget, _)| budget);
    rescue_component_scoped_faint_strokes_budgeted(
        damaged,
        raw,
        picture_mask,
        text_vicinity,
        row_evidence_exclusion,
        requested_mode,
        selected_mode,
        dpi,
        spread_fallback,
        budget.as_ref(),
        &mut interventions,
    )
}

#[allow(clippy::too_many_arguments)]
fn rescue_component_scoped_faint_strokes_budgeted(
    damaged: &BinaryImage,
    raw: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    text_vicinity: Option<&BinaryImage>,
    row_evidence_exclusion: Option<&BinaryImage>,
    requested_mode: BinarizationMode,
    selected_mode: BinarizationMode,
    dpi: f64,
    spread_fallback: bool,
    budget: Option<&LineStrokeBudget>,
    interventions: &mut LineStrokeBudgetInterventions,
) -> BinaryImage {
    let faint_rescue_enabled = spread_fallback
        || selected_mode == BinarizationMode::Otsu
        || (matches!(
            requested_mode,
            BinarizationMode::Sauvola | BinarizationMode::Wolf
        ) && matches!(
            selected_mode,
            BinarizationMode::Sauvola | BinarizationMode::Wolf
        ));
    if (!faint_rescue_enabled && selected_mode != BinarizationMode::Wolf)
        || damaged.width() == 0
        || damaged.height() == 0
    {
        return damaged.clone();
    }
    assert_eq!(
        (damaged.width(), damaged.height()),
        (raw.width(), raw.height())
    );
    debug_assert!(picture_mask.is_none_or(|mask| {
        mask.width() == damaged.width() && mask.height() == damaged.height()
    }));
    debug_assert!(text_vicinity.is_none_or(|mask| {
        mask.width() == damaged.width() && mask.height() == damaged.height()
    }));
    debug_assert!(row_evidence_exclusion.is_none_or(|mask| {
        mask.width() == damaged.width() && mask.height() == damaged.height()
    }));

    let paper = paper_reference(raw);
    let picture_owner = picture_mask.map(|mask| {
        dilate(
            mask,
            picture_protection_radius(dpi),
            picture_protection_radius(dpi),
        )
    });
    let candidates = BinaryImage::from_fn_parallel(raw.width(), raw.height(), |x, y| {
        raw.get(x, y) <= paper.saturating_sub(RESCUE_CANDIDATE_DEPTH)
            && !picture_owner.as_ref().is_some_and(|owner| owner.get(x, y))
    });
    if candidates.count_black() == 0 {
        return damaged.clone();
    }

    let components = ComponentMap::from_binary(&candidates);
    let gradient_radius = (dpi * 0.12 / 25.4).round().clamp(1.0, 4.0) as usize;
    let (raw_max, raw_min) = rayon::join(
        || erode_gray(raw, gradient_radius, gradient_radius),
        || dilate_gray(raw, gradient_radius, gradient_radius),
    );
    // The crispness window is intentionally small, but depth must see past a
    // complete glyph interior to the nearby paper. A wider local paper field
    // does that for text while leaving a broad shadow's interior shallow.
    let paper_radius = (dpi * 0.80 / 25.4).round().clamp(3.0, 12.0) as usize;
    let local_paper = erode_gray(raw, paper_radius, paper_radius);
    let row_tolerance = (dpi * 0.65 / 25.4).round().clamp(1.0, 8.0) as usize;
    let row_signal = text_vicinity.map(|mask| {
        let horizontal = (dpi * 3.0 / 25.4).round().max(2.0) as usize;
        dilate(mask, horizontal, row_tolerance)
    });
    let independent_row_profile = (row_signal.is_none() || selected_mode == BinarizationMode::Wolf)
        .then(|| {
            raw_text_row_profile(
                raw,
                picture_owner.as_ref(),
                row_evidence_exclusion,
                &raw_max,
                &raw_min,
                paper,
                dpi,
            )
        });
    let minimum_independent_row_support = (dpi * 0.30 / 25.4).round().max(4.0) as usize;
    let mut rescued = BinaryImage::new(damaged.width(), damaged.height());
    let mut source_supported_rescued = BinaryImage::new(damaged.width(), damaged.height());
    let mut retained = damaged.clone();

    if selected_mode == BinarizationMode::Wolf {
        let damaged_components = ComponentMap::from_binary(damaged);
        for component in damaged_components.components() {
            if !is_text_like_rescue_component(component, dpi, RescueAdmission::HaloStrip) {
                continue;
            }
            let mut captured_raw = Vec::with_capacity(component.area);
            let mut component_rows = vec![0usize; component.bottom - component.top + 1];
            let mut row_aligned = false;
            let mut touches_picture_owner = false;
            for y in component.top..=component.bottom {
                for x in component.left..=component.right {
                    if damaged_components.label_at(x, y) != component.label {
                        continue;
                    }
                    captured_raw.push(raw.get(x, y));
                    component_rows[y - component.top] += 1;
                    touches_picture_owner |=
                        picture_owner.as_ref().is_some_and(|owner| owner.get(x, y));
                    row_aligned |= row_signal.as_ref().is_some_and(|signal| signal.get(x, y));
                }
            }
            captured_raw.sort_unstable();
            let captured_median_raw = median_u8(&captured_raw);
            if let Some(profile) = independent_row_profile.as_ref() {
                row_aligned |= (component.top..=component.bottom).any(|y| {
                    profile[y]
                        >= minimum_independent_row_support + component_rows[y - component.top]
                });
            }
            let left = component.left.saturating_sub(gradient_radius);
            let right = component
                .right
                .saturating_add(gradient_radius)
                .min(raw.width() - 1);
            let top = component.top.saturating_sub(gradient_radius);
            let bottom = component
                .bottom
                .saturating_add(gradient_radius)
                .min(raw.height() - 1);
            let mut missing = 0usize;
            let mut deep_missing = 0usize;
            for y in top..=bottom {
                for x in left..=right {
                    if damaged.get(x, y)
                        || raw.get(x, y) > paper.saturating_sub(RESCUE_CANDIDATE_DEPTH)
                        || picture_owner.as_ref().is_some_and(|owner| owner.get(x, y))
                    {
                        continue;
                    }
                    missing += 1;
                    if raw.get(x, y) <= local_paper.get(x, y).saturating_sub(RESCUE_SOLID_DEPTH) {
                        deep_missing += 1;
                    }
                }
            }
            let solid_core_already_captured = captured_median_raw
                .is_some_and(|median| median <= RESCUE_SOLID_CAPTURED_MEDIAN)
                && (missing == 0
                    || deep_missing.saturating_mul(WOLF_SOLID_MAXIMUM_DEEP_MISSING_DENOMINATOR)
                        < missing);
            if touches_picture_owner || !row_aligned || !solid_core_already_captured {
                continue;
            }
            for y in component.top..=component.bottom {
                for x in component.left..=component.right {
                    if damaged_components.label_at(x, y) == component.label
                        && raw.get(x, y) >= WOLF_SOLID_STROKE_CEILING
                        && has_adjacent_component_core(
                            &damaged_components,
                            component.label,
                            raw,
                            x,
                            y,
                        )
                        && !has_coherent_noncore_run(
                            &damaged_components,
                            component.label,
                            raw,
                            x,
                            y,
                        )
                    {
                        retained.set(x, y, false);
                    }
                }
            }
        }
    }

    if !faint_rescue_enabled {
        return retained;
    }

    for component in components.components() {
        if !is_text_like_rescue_component(component, dpi, RescueAdmission::Additive) {
            continue;
        }
        let mut missing = 0usize;
        let mut qualifying_missing = 0usize;
        let mut captured_raw = Vec::new();
        let mut missing_samples = Vec::new();
        let mut component_rows = vec![0usize; component.bottom - component.top + 1];
        let mut row_aligned = false;
        let mut touches_picture_owner = false;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if components.label_at(x, y) != component.label {
                    continue;
                }
                component_rows[y - component.top] += 1;
                if picture_owner.as_ref().is_some_and(|owner| owner.get(x, y)) {
                    touches_picture_owner = true;
                }
                if row_signal.as_ref().is_some_and(|signal| signal.get(x, y)) {
                    row_aligned = true;
                }
                if damaged.get(x, y) {
                    captured_raw.push(raw.get(x, y));
                    continue;
                }
                missing += 1;
                missing_samples.push((x, y, raw.get(x, y), local_paper.get(x, y)));
                let gradient = raw_max.get(x, y).saturating_sub(raw_min.get(x, y));
                if is_crisp_or_deep_sample(raw.get(x, y), local_paper.get(x, y), gradient) {
                    qualifying_missing += 1;
                }
            }
        }
        captured_raw.sort_unstable();
        let captured_median_raw = median_u8(&captured_raw);
        if row_signal.is_none() {
            if let Some(profile) = independent_row_profile.as_ref() {
                row_aligned = (component.top..=component.bottom).any(|y| {
                    profile[y]
                        >= minimum_independent_row_support + component_rows[y - component.top]
                });
            }
        }
        let solid_core_already_captured = captured_median_raw.is_some_and(|median| {
            median <= RESCUE_SOLID_CAPTURED_MEDIAN
                && if selected_mode == BinarizationMode::Wolf {
                    missing_samples
                        .iter()
                        .filter(|&&(_, _, sample, sample_paper)| {
                            sample <= sample_paper.saturating_sub(RESCUE_SOLID_DEPTH)
                        })
                        .count()
                        .saturating_mul(WOLF_SOLID_MAXIMUM_DEEP_MISSING_DENOMINATOR)
                        < missing
                } else {
                    !missing_samples.iter().any(|&(x, y, sample, sample_paper)| {
                        is_component_relative_deep_missing(sample, sample_paper, median)
                            || is_structural_deep_missing(
                                &components,
                                component.label,
                                damaged,
                                x,
                                y,
                                sample,
                                sample_paper,
                            )
                    })
                }
        });
        if touches_picture_owner
            || !row_aligned
            || missing == 0
            || solid_core_already_captured
            || qualifying_missing < 2
            || qualifying_missing.saturating_mul(4) < missing
        {
            continue;
        }
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if components.label_at(x, y) != component.label
                    || damaged.get(x, y)
                    || picture_owner.as_ref().is_some_and(|owner| owner.get(x, y))
                {
                    continue;
                }
                let gradient = raw_max.get(x, y).saturating_sub(raw_min.get(x, y));
                if is_crisp_or_deep_sample(raw.get(x, y), local_paper.get(x, y), gradient) {
                    rescued.set(x, y, true);
                    if raw.get(x, y) < local_paper.get(x, y).saturating_sub(BLEED_SHALLOW_DEPTH) {
                        source_supported_rescued.set(x, y, true);
                    }
                }
            }
        }
    }
    let rescued = drop_boundary_accretion_clusters(&rescued, &retained);
    let source_supported_rescued = source_supported_rescued.and(&rescued);
    let candidate = retained.or(&rescued);
    cap_added_ink_to_stroke_budget(
        &retained,
        &candidate,
        Some(&source_supported_rescued),
        budget,
        StrokeBudgetAdditionStage::Rescue,
        interventions,
    )
}

/// Rescue exists to recover stroke material the threshold missed entirely:
/// faded fragments and broken glyph parts that stand on their own. A cluster
/// of proposed pixels that mostly hugs already-captured ink is not missing
/// material — it is the gray halo around a complete stroke, and re-adding it
/// thickens exactly the words whose halos are darkest, amplifying the page's
/// existing weight contrast. Keep a cluster only when most of its pixels sit
/// clear of captured ink; junction pixels of a kept fragment stay with it.
fn drop_boundary_accretion_clusters(proposed: &BinaryImage, captured: &BinaryImage) -> BinaryImage {
    if proposed.count_black() == 0 {
        return proposed.clone();
    }
    let map = ComponentMap::from_binary(proposed);
    let mut kept = proposed.clone();
    for component in map.components() {
        let mut hugging = 0usize;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if map.label_at(x, y) != component.label {
                    continue;
                }
                let adjacent =
                    (y.saturating_sub(1)..=(y + 1).min(captured.height() - 1)).any(|neighbor_y| {
                        (x.saturating_sub(1)..=(x + 1).min(captured.width() - 1))
                            .any(|neighbor_x| captured.get(neighbor_x, neighbor_y))
                    });
                if adjacent {
                    hugging += 1;
                }
            }
        }
        if (hugging as f64) <= RESCUE_ACCRETION_FRACTION_CAP * component.area as f64 {
            continue;
        }
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if map.label_at(x, y) == component.label {
                    kept.set(x, y, false);
                }
            }
        }
    }
    kept
}

fn has_coherent_noncore_run(
    components: &ComponentMap,
    label: u32,
    raw: &GrayImage,
    x: usize,
    y: usize,
) -> bool {
    const MINIMUM_RUN: usize = 5;
    let anchor = raw.get(x, y);
    [(1isize, 0isize), (0, 1), (1, 1), (1, -1)]
        .into_iter()
        .any(|(dx, dy)| {
            let mut length = 1usize;
            let mut reaches_beyond_core_ring = false;
            for sign in [-1isize, 1] {
                for step in 1..MINIMUM_RUN {
                    let sample_x = x as isize + dx * step as isize * sign;
                    let sample_y = y as isize + dy * step as isize * sign;
                    if sample_x < 0
                        || sample_y < 0
                        || sample_x >= raw.width() as isize
                        || sample_y >= raw.height() as isize
                        || components.label_at(sample_x as usize, sample_y as usize) != label
                        || raw.get(sample_x as usize, sample_y as usize) < RESCUE_SOLID_DEPTH
                        || raw.get(sample_x as usize, sample_y as usize) != anchor
                    {
                        break;
                    }
                    length += 1;
                    reaches_beyond_core_ring |= !has_adjacent_component_core(
                        components,
                        label,
                        raw,
                        sample_x as usize,
                        sample_y as usize,
                    );
                }
            }
            length >= MINIMUM_RUN && reaches_beyond_core_ring
        })
}

fn has_adjacent_component_core(
    components: &ComponentMap,
    label: u32,
    raw: &GrayImage,
    x: usize,
    y: usize,
) -> bool {
    let left = x.saturating_sub(1);
    let right = x.saturating_add(1).min(raw.width() - 1);
    let top = y.saturating_sub(1);
    let bottom = y.saturating_add(1).min(raw.height() - 1);
    (top..=bottom).any(|sample_y| {
        (left..=right).any(|sample_x| {
            (sample_x != x || sample_y != y)
                && components.label_at(sample_x, sample_y) == label
                && raw.get(sample_x, sample_y) < RESCUE_SOLID_DEPTH
        })
    })
}

fn is_component_relative_deep_missing(raw: u8, local_paper: u8, captured_median: u8) -> bool {
    let absolute_deep = raw <= local_paper.saturating_sub(RESCUE_SOLID_DEPTH);
    let faded_relative_depth = u16::from(local_paper.saturating_sub(captured_median)) * 2 / 5;
    absolute_deep
        || (local_paper <= 240 && u16::from(raw) + faded_relative_depth <= u16::from(local_paper))
}

fn is_structural_deep_missing(
    components: &ComponentMap,
    label: u32,
    damaged: &BinaryImage,
    x: usize,
    y: usize,
    raw: u8,
    local_paper: u8,
) -> bool {
    if raw > local_paper.saturating_sub(RESCUE_STRUCTURAL_DEPTH) {
        return false;
    }
    let left = x.saturating_sub(1);
    let right = x.saturating_add(1).min(damaged.width() - 1);
    let top = y.saturating_sub(1);
    let bottom = y.saturating_add(1).min(damaged.height() - 1);
    !(top..=bottom).any(|sample_y| {
        (left..=right).any(|sample_x| {
            (sample_x != x || sample_y != y)
                && components.label_at(sample_x, sample_y) == label
                && damaged.get(sample_x, sample_y)
        })
    })
}

fn median_u8(values: &[u8]) -> Option<u8> {
    if values.is_empty() {
        return None;
    }
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        ((u16::from(values[middle - 1]) + u16::from(values[middle])) / 2) as u8
    } else {
        values[middle]
    })
}

fn raw_text_row_profile(
    raw: &GrayImage,
    picture_owner: Option<&BinaryImage>,
    row_evidence_exclusion: Option<&BinaryImage>,
    raw_max: &GrayImage,
    raw_min: &GrayImage,
    paper: u8,
    dpi: f64,
) -> Vec<usize> {
    let mut profile = vec![0usize; raw.height()];
    for (y, row_count) in profile.iter_mut().enumerate() {
        for x in 0..raw.width() {
            if picture_owner.is_some_and(|owner| owner.get(x, y))
                || row_evidence_exclusion.is_some_and(|excluded| excluded.get(x, y))
            {
                continue;
            }
            let gradient = raw_max.get(x, y).saturating_sub(raw_min.get(x, y));
            if raw.get(x, y) <= paper.saturating_sub(RESCUE_ROW_SIGNAL_DEPTH)
                || u16::from(gradient) >= RESCUE_ROW_SIGNAL_CRISPNESS
            {
                *row_count += 1;
            }
        }
    }
    let band_radius = (dpi * 0.45 / 25.4).round().clamp(1.0, 6.0) as usize;
    let mut banded = vec![0usize; raw.height()];
    for (y, target) in banded.iter_mut().enumerate() {
        *target = (y.saturating_sub(band_radius)
            ..=y.saturating_add(band_radius)
                .min(raw.height().saturating_sub(1)))
            .map(|sample_y| profile[sample_y])
            .max()
            .unwrap_or(0);
    }
    banded
}

/// Which of the two rescue passes is asking whether a component is text-like.
///
/// The passes need different extent bounds because they can do different damage.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RescueAdmission {
    /// Additive faint-ink rescue. It can turn paper into ink, so a component
    /// larger than a single glyph in any direction must never be admitted.
    Additive,
    /// Subtractive Wolf halo strip. It can only remove halo, never fabricate
    /// ink, so the longest-side bound does not apply and is actively harmful:
    /// the halo is what fuses adjacent letters into one multi-letter blob, so
    /// an extent cap rejects exactly the components whose halo most needs
    /// removing, leaving them at full Wolf weight beside de-haloed neighbours.
    /// Height still confines admission to text-line-sized material.
    HaloStrip,
}

/// Checks the extent perpendicular to a horizontal morphology bridge.
///
/// A bridge can join a whole text line or several rule fragments, so the
/// component width is not a trustworthy thickness measure after that pass.
/// Keeping this predicate shared makes the halo and rule recovery passes use
/// the same fusion-aware admission rule without changing either threshold.
pub(crate) fn is_horizontally_fused_extent_admissible(
    component: &scan_primitives::Component,
    maximum_cross_bridge_extent: usize,
) -> bool {
    let height = component.bottom - component.top + 1;
    height <= maximum_cross_bridge_extent
}

fn is_text_like_rescue_component(
    component: &scan_primitives::Component,
    dpi: f64,
    admission: RescueAdmission,
) -> bool {
    let px_per_mm = dpi.max(1.0) / 25.4;
    let width = component.right - component.left + 1;
    let height = component.bottom - component.top + 1;
    let major = width.max(height);
    let minor = width.min(height);
    let aspect = major as f64 / minor.max(1) as f64;
    let average_stroke = component.area as f64 / major.max(1) as f64;
    let maximum_extent = (px_per_mm * 8.0).round().max(4.0) as usize;
    let maximum_area = (px_per_mm * 4.5).round().max(16.0).powf(2.0) as usize;
    let minimum_stroke = (px_per_mm * 0.08).max(0.75);
    let maximum_stroke = (px_per_mm * 2.5).max(2.0);

    let extent_admitted = match admission {
        RescueAdmission::Additive => {
            major <= maximum_extent && aspect <= 10.0 && component.area <= maximum_area
        }
        RescueAdmission::HaloStrip => {
            is_horizontally_fused_extent_admissible(component, maximum_extent)
        }
    };

    component.area >= 2
        && extent_admitted
        && minor >= 1
        && average_stroke >= minimum_stroke
        && average_stroke <= maximum_stroke
}

pub(crate) fn is_crisp_or_deep_sample(sample: u8, local_paper: u8, gradient: u8) -> bool {
    sample < local_paper.saturating_sub(BLEED_SHALLOW_DEPTH)
        || u16::from(gradient) >= BLEED_CRISPNESS_FLOOR
}

fn tile_paper_values(image: &GrayImage, paper_floor: Option<u8>) -> Vec<f64> {
    let mut paper = Vec::with_capacity(16);
    for tile_y in 0..4 {
        let top = tile_y * image.height() / 4;
        let bottom = ((tile_y + 1) * image.height() / 4).max(top + 1);
        for tile_x in 0..4 {
            let left = tile_x * image.width() / 4;
            let right = ((tile_x + 1) * image.width() / 4).max(left + 1);
            let mut histogram = [0usize; 256];
            let mut count = 0usize;
            let mut visible_paper = 0usize;
            for y in top..bottom.min(image.height()) {
                for x in left..right.min(image.width()) {
                    let value = image.get(x, y);
                    histogram[value as usize] += 1;
                    visible_paper += usize::from(paper_floor.is_none_or(|floor| value >= floor));
                    count += 1;
                }
            }
            if paper_floor.is_some()
                && visible_paper as f64 / (count.max(1) as f64) < TILE_PAPER_FRACTION_FLOOR
            {
                continue;
            }
            let target = ((count.saturating_sub(1)) as f64 * 0.8).round() as usize;
            let mut cumulative = 0usize;
            let value = histogram
                .into_iter()
                .enumerate()
                .find_map(|(value, frequency)| {
                    cumulative += frequency;
                    (cumulative > target).then_some(value as f64)
                })
                .unwrap_or(255.0);
            paper.push(value);
        }
    }
    paper
}

fn paper_spread(paper: &[f64]) -> f64 {
    let mean = paper.iter().sum::<f64>() / paper.len().max(1) as f64;
    (paper
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / paper.len().max(1) as f64)
        .sqrt()
}

fn edge_density(image: &GrayImage) -> f64 {
    if image.width() < 2 || image.height() < 2 {
        return 0.0;
    }
    let mut edges = 0usize;
    let mut count = 0usize;
    for y in 1..image.height() {
        for x in 1..image.width() {
            let value = image.get(x, y);
            let gradient = value.abs_diff(image.get(x - 1, y)) as usize
                + value.abs_diff(image.get(x, y - 1)) as usize;
            edges += usize::from(gradient >= 32);
            count += 1;
        }
    }
    edges as f64 / count.max(1) as f64
}

fn estimated_stroke_width(binary: &BinaryImage) -> f64 {
    // Run lengths live in 1..=32, so a fixed histogram replaces collecting
    // and sorting millions of runs; rows accumulate independently.
    let (histogram, total) = (0..binary.height())
        .into_par_iter()
        .map(|y| {
            let mut local = [0usize; 33];
            let mut count = 0usize;
            let mut start = None;
            for x in 0..=binary.width() {
                let black = x < binary.width() && binary.get(x, y);
                match (start, black) {
                    (None, true) => start = Some(x),
                    (Some(run_start), false) => {
                        let length = x - run_start;
                        if length <= 32 {
                            local[length] += 1;
                            count += 1;
                        }
                        start = None;
                    }
                    _ => {}
                }
            }
            (local, count)
        })
        .reduce(
            || ([0usize; 33], 0usize),
            |(mut left, left_count), (right, right_count)| {
                for (target, value) in left.iter_mut().zip(right) {
                    *target += value;
                }
                (left, left_count + right_count)
            },
        );
    if total == 0 {
        return 0.0;
    }
    let mut cumulative = 0usize;
    for (length, &count) in histogram.iter().enumerate() {
        cumulative += count;
        if cumulative > total / 2 {
            return length as f64;
        }
    }
    0.0
}

fn dark_border_coverage(image: &GrayImage, threshold: u8) -> f64 {
    let band = image.width().min(image.height()).div_ceil(30).max(1);
    let mut dark = 0usize;
    let mut count = 0usize;
    for y in 0..image.height() {
        for x in 0..image.width() {
            if x < band || y < band || x + band >= image.width() || y + band >= image.height() {
                dark += usize::from(image.get(x, y) < threshold);
                count += 1;
            }
        }
    }
    dark as f64 / count.max(1) as f64
}

fn binary_agreement(left: &BinaryImage, right: &BinaryImage) -> f64 {
    let mut matching = 0usize;
    let count = left.width().saturating_mul(left.height());
    for y in 0..left.height() {
        for x in 0..left.width() {
            matching += usize::from(left.get(x, y) == right.get(x, y));
        }
    }
    matching as f64 / count.max(1) as f64
}

pub fn binary_to_gray(binary: &BinaryImage) -> GrayImage {
    let mut output = GrayImage::new(binary.width(), binary.height(), 255);
    for y in 0..binary.height() {
        for x in 0..binary.width() {
            if binary.get(x, y) {
                output.set(x, y, 0);
            }
        }
    }
    output
}

pub fn smooth_edges(source: &BinaryImage) -> BinaryImage {
    smooth_edges_with_profile(source, SmoothProfile::Legacy)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SmoothProfile {
    Legacy,
    TopologySafe,
}

fn smooth_edges_for_page(source: &BinaryImage, dpi: f64) -> BinaryImage {
    let profile = resolve_smooth_profile(source, dpi);
    let smoothed = smooth_edges_with_profile(source, profile);
    if !smoothing_exceeds_page_growth_limit(source, &smoothed, profile) {
        return smoothed;
    }
    if profile == SmoothProfile::TopologySafe {
        return source.clone();
    }
    let topology_safe = smooth_edges_with_profile(source, SmoothProfile::TopologySafe);
    if smoothing_exceeds_page_growth_limit(source, &topology_safe, SmoothProfile::TopologySafe) {
        source.clone()
    } else {
        topology_safe
    }
}

fn smoothing_exceeds_page_growth_limit(
    source: &BinaryImage,
    smoothed: &BinaryImage,
    profile: SmoothProfile,
) -> bool {
    if profile == SmoothProfile::Legacy {
        return smoothing_exceeds_edge_growth_limit(source, smoothed);
    }
    let growth = smoothed.count_black().saturating_sub(source.count_black());
    (growth as u128) * 100 > (source.count_black() as u128) * 8
}

fn smoothing_exceeds_edge_growth_limit(source: &BinaryImage, smoothed: &BinaryImage) -> bool {
    let growth = smoothed.count_black().saturating_sub(source.count_black());
    growth > 64 || (growth as u128) * 40 > (binary_edge_length(source) as u128) * 9
}

fn binary_edge_length(source: &BinaryImage) -> usize {
    let mut edges = 0usize;
    for y in 0..source.height() {
        for x in 0..source.width() {
            let ink = source.get(x, y);
            edges += usize::from(x == 0 && ink);
            edges += usize::from(y == 0 && ink);
            edges += usize::from(x + 1 == source.width() && ink);
            edges += usize::from(y + 1 == source.height() && ink);
            edges += usize::from(x + 1 < source.width() && ink != source.get(x + 1, y));
            edges += usize::from(y + 1 < source.height() && ink != source.get(x, y + 1));
        }
    }
    edges
}

fn resolve_smooth_profile(source: &BinaryImage, _dpi: f64) -> SmoothProfile {
    let stroke_width = estimated_stroke_width(source);
    if (1.0..=12.0).contains(&stroke_width) {
        SmoothProfile::TopologySafe
    } else {
        SmoothProfile::Legacy
    }
}

fn smooth_edges_with_profile(source: &BinaryImage, profile: SmoothProfile) -> BinaryImage {
    if source.width() < 3 || source.height() < 3 {
        return source.clone();
    }
    if profile == SmoothProfile::TopologySafe {
        return smooth_edges_with_topology_lut(source);
    }
    BinaryImage::from_fn_parallel(source.width(), source.height(), |x, y| {
        if x == 0 || y == 0 || x + 1 == source.width() || y + 1 == source.height() {
            return source.get(x, y);
        }
        let north = source.get(x, y - 1);
        let south = source.get(x, y + 1);
        let west = source.get(x - 1, y);
        let east = source.get(x + 1, y);
        let diagonals = [
            source.get(x - 1, y - 1),
            source.get(x + 1, y - 1),
            source.get(x - 1, y + 1),
            source.get(x + 1, y + 1),
        ];
        let cardinal_count = [north, south, west, east]
            .into_iter()
            .filter(|value| *value)
            .count();
        let neighbor_count = cardinal_count + diagonals.into_iter().filter(|value| *value).count();
        let center = source.get(x, y);
        if !center {
            neighbor_count >= 5 && ((north && south) || (west && east))
        } else {
            neighbor_count > 1
        }
    })
}

static TOPOLOGY_SMOOTH_LUT: OnceLock<[bool; 512]> = OnceLock::new();

fn topology_smooth_lut() -> &'static [bool; 512] {
    TOPOLOGY_SMOOTH_LUT.get_or_init(|| {
        let mut lut = [false; 512];
        for (pattern, output) in lut.iter_mut().enumerate() {
            *output = topology_checked_center(pattern as u16);
        }
        lut
    })
}

fn smooth_edges_with_topology_lut(source: &BinaryImage) -> BinaryImage {
    let lut = topology_smooth_lut();
    BinaryImage::from_fn_parallel(source.width(), source.height(), |x, y| {
        if x == 0 || y == 0 || x + 1 == source.width() || y + 1 == source.height() {
            return source.get(x, y);
        }
        let mut pattern = 0usize;
        for offset_y in 0..3 {
            for offset_x in 0..3 {
                if source.get(x + offset_x - 1, y + offset_y - 1) {
                    pattern |= 1 << (offset_y * 3 + offset_x);
                }
            }
        }
        lut[pattern]
    })
}

fn topology_checked_center(pattern: u16) -> bool {
    let center = pattern & (1 << 4) != 0;
    let proposed = legacy_center_decision(pattern);
    if proposed == center {
        return center;
    }
    let neighbor_count = (pattern & !(1 << 4)).count_ones();
    if center && neighbor_count < 2 {
        return center;
    }
    let changed = if proposed {
        pattern | (1 << 4)
    } else {
        pattern & !(1 << 4)
    };
    let preserves_ink = neighborhood_component_count(pattern, true, true)
        == neighborhood_component_count(changed, true, true);
    let preserves_paper = neighborhood_component_count(pattern, false, false)
        == neighborhood_component_count(changed, false, false);
    if preserves_ink && preserves_paper {
        proposed
    } else {
        center
    }
}

fn legacy_center_decision(pattern: u16) -> bool {
    let center = pattern & (1 << 4) != 0;
    let black = |bit: usize| pattern & (1 << bit) != 0;
    let north = black(1);
    let west = black(3);
    let east = black(5);
    let south = black(7);
    let neighbor_count = (pattern & !(1 << 4)).count_ones();
    if !center && neighbor_count >= 5 && ((north && south) || (west && east)) {
        true
    } else if center && neighbor_count <= 1 {
        false
    } else {
        center
    }
}

fn neighborhood_component_count(pattern: u16, black: bool, eight_connected: bool) -> usize {
    let mut visited = [false; 9];
    let mut count = 0usize;
    for start in 0..9 {
        if visited[start] || ((pattern & (1 << start) != 0) != black) {
            continue;
        }
        count += 1;
        let mut stack = [0usize; 9];
        let mut length = 1usize;
        stack[0] = start;
        visited[start] = true;
        while length > 0 {
            length -= 1;
            let current = stack[length];
            let current_x = current % 3;
            let current_y = current / 3;
            for (candidate, candidate_visited) in visited.iter_mut().enumerate() {
                if *candidate_visited || ((pattern & (1 << candidate) != 0) != black) {
                    continue;
                }
                let candidate_x = candidate % 3;
                let candidate_y = candidate / 3;
                let delta_x = current_x.abs_diff(candidate_x);
                let delta_y = current_y.abs_diff(candidate_y);
                let adjacent = if eight_connected {
                    delta_x <= 1 && delta_y <= 1 && delta_x + delta_y > 0
                } else {
                    delta_x + delta_y == 1
                };
                if adjacent {
                    *candidate_visited = true;
                    stack[length] = candidate;
                    length += 1;
                }
            }
        }
    }
    count
}

pub fn despeckle_connected(source: &BinaryImage, dpi: f64) -> BinaryImage {
    despeckle_connected_with_calibration_config(source, dpi, CalibrationConfig::default())
}

#[doc(hidden)]
pub fn despeckle_connected_with_calibration_config(
    source: &BinaryImage,
    dpi: f64,
    calibration_config: CalibrationConfig,
) -> BinaryImage {
    let calibration = PageCalibration::estimate_from_binary(source, dpi, calibration_config);
    despeckle_connected_impl(source, None, dpi, calibration, DespeckleLevel::Normal, true).image
}

pub(crate) fn despeckle_connected_calibrated(
    source: &BinaryImage,
    dpi: f64,
    calibration: PageCalibration,
) -> BinaryImage {
    let outcome =
        despeckle_connected_impl(source, None, dpi, calibration, DespeckleLevel::Normal, true);
    // Content-box preprocessing has no grayscale evidence and treats an all-small
    // page as potential marginalia/photo structure. Keep its historical fail-open
    // behavior; output despeckling still uses the required top-decile anchors.
    if outcome.fallback {
        source.clone()
    } else {
        outcome.image
    }
}

struct DespeckleOutcome {
    image: BinaryImage,
    fallback: bool,
}

fn rule_scale_component_flags(source: &BinaryImage, raw: &GrayImage, dpi: f64) -> Vec<bool> {
    debug_assert_eq!(
        (source.width(), source.height()),
        (raw.width(), raw.height())
    );
    let components = ComponentMap::from_binary(source);
    let mut raw_dark_pixels = vec![0usize; components.components().len() + 1];
    let paper = paper_reference(raw);
    let dark_floor = paper.saturating_sub(RULE_RAW_DEPTH);
    for y in 0..source.height() {
        for x in 0..source.width() {
            if source.get(x, y) && raw.get(x, y) <= dark_floor {
                raw_dark_pixels[components.label_at(x, y) as usize] += 1;
            }
        }
    }
    let minimum_span = (dpi.max(1.0) * RULE_MINIMUM_SPAN_MM / 25.4)
        .round()
        .max(24.0) as usize;
    let maximum_thickness = (dpi.max(1.0) * RULE_MAXIMUM_THICKNESS_MM / 25.4)
        .round()
        .max(2.0) as usize;
    let mut flags = vec![false; components.components().len() + 1];
    for component in components.components() {
        let label = component.label as usize;
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let thin_thickness = (dpi.max(1.0) * RULE_THIN_THICKNESS_MM / 25.4)
            .round()
            .max(2.0) as usize;
        let aspect_floor = if height <= thin_thickness { 4 } else { 8 };
        let geometry = width >= minimum_span
            && width >= height.saturating_mul(aspect_floor)
            && height <= maximum_thickness;
        let raw_support = raw_dark_pixels[label] >= minimum_span
            && raw_dark_pixels[label].saturating_mul(2) >= component.area;
        flags[label] = geometry && raw_support;
    }
    flags
}

fn despeckle_connected_impl(
    source: &BinaryImage,
    normalized: Option<&GrayImage>,
    dpi: f64,
    calibration: PageCalibration,
    level: DespeckleLevel,
    use_attachment_graph: bool,
) -> DespeckleOutcome {
    despeckle_connected_impl_with_protection(
        source,
        normalized,
        None,
        dpi,
        calibration,
        level,
        use_attachment_graph,
    )
}

fn despeckle_connected_impl_with_protection(
    source: &BinaryImage,
    normalized: Option<&GrayImage>,
    protected_rule_components: Option<&[bool]>,
    dpi: f64,
    calibration: PageCalibration,
    level: DespeckleLevel,
    use_attachment_graph: bool,
) -> DespeckleOutcome {
    let components = ComponentMap::from_binary(source);
    if components.components().is_empty() || level == DespeckleLevel::Off {
        return DespeckleOutcome {
            image: source.clone(),
            fallback: false,
        };
    }
    let component_radii = component_maximum_inscribed_radius_squared(source, &components);
    let pixel_count = source.width().saturating_mul(source.height()).max(1);
    let calibration = PageCalibration::estimate_from_components(
        components.components(),
        &component_radii,
        source.count_black() as f64 / pixel_count as f64,
        dpi,
        calibration.config,
    );
    let mut graph = vec![Vec::<AttachmentEdge>::new(); components.components().len() + 1];
    if use_attachment_graph {
        populate_attachment_graph(components.components(), &mut graph);
    }
    let (mut keep, fallback) = despeckle_keep_decision(
        components.components(),
        &component_radii,
        &graph,
        dpi,
        calibration,
        level,
        use_attachment_graph,
    );
    if let Some(protected) = protected_rule_components {
        debug_assert_eq!(protected.len(), components.components().len() + 1);
        for component in components.components() {
            let label = component.label as usize;
            if protected[label] {
                keep[label] = true;
            }
        }
    }
    if let Some(gray) =
        normalized.filter(|gray| gray.width() == source.width() && gray.height() == source.height())
    {
        let more_cautious = match level {
            DespeckleLevel::Aggressive => Some(DespeckleLevel::Normal),
            DespeckleLevel::Normal => Some(DespeckleLevel::Cautious),
            DespeckleLevel::Cautious | DespeckleLevel::Off => None,
        };
        let cautious_keep = more_cautious.map(|cautious_level| {
            despeckle_keep_decision(
                components.components(),
                &component_radii,
                &graph,
                dpi,
                calibration,
                cautious_level,
                use_attachment_graph,
            )
            .0
        });
        protect_high_contrast_components(&components, gray, cautious_keep.as_deref(), &mut keep);
    }
    DespeckleOutcome {
        image: components.retain(|component| keep[component.label as usize]),
        fallback,
    }
}

#[derive(Clone, Copy, Debug)]
struct AttachmentEdge {
    neighbor: usize,
    distance_squared: u64,
}

fn despeckle_keep_decision(
    components: &[scan_primitives::Component],
    component_radii: &[u32],
    graph: &[Vec<AttachmentEdge>],
    dpi: f64,
    calibration: PageCalibration,
    requested_level: DespeckleLevel,
    use_attachment_graph: bool,
) -> (Vec<bool>, bool) {
    let (substantial_area, minimum_radius_squared) =
        despeckle_seed_thresholds(calibration, dpi, requested_level);
    let mut seeds = vec![false; components.len() + 1];
    for component in components {
        let label = component.label as usize;
        seeds[label] =
            component.area >= substantial_area && component_radii[label] >= minimum_radius_squared;
    }
    let fallback = !seeds.iter().any(|&seed| seed);
    let level = if fallback {
        let mut areas = components
            .iter()
            .map(|component| component.area)
            .collect::<Vec<_>>();
        areas.sort_unstable();
        let top_decile = areas[(areas.len() * 9) / 10];
        for component in components {
            seeds[component.label as usize] = component.area >= top_decile;
        }
        DespeckleLevel::Cautious
    } else {
        requested_level
    };
    let parameters = DespeckleParameters::for_level(level, dpi);
    let mut keep = seeds.clone();
    if use_attachment_graph {
        let mut hops = vec![u8::MAX; keep.len()];
        let mut queue = VecDeque::new();
        for component in components {
            let label = component.label as usize;
            if seeds[label] {
                hops[label] = 0;
                queue.push_back(label);
            }
        }
        while let Some(label) = queue.pop_front() {
            if hops[label] >= parameters.maximum_hops {
                continue;
            }
            let parent = &components[label - 1];
            for edge in &graph[label] {
                let candidate = &components[edge.neighbor - 1];
                if seeds[edge.neighbor]
                    || (parent.area as f64) < candidate.area as f64 * parameters.parent_area_ratio
                    || edge.distance_squared
                        > (candidate.area as f64 * parameters.distance_factor).round() as u64
                {
                    continue;
                }
                let next_hops = hops[label] + 1;
                if next_hops >= hops[edge.neighbor] {
                    continue;
                }
                hops[edge.neighbor] = next_hops;
                keep[edge.neighbor] = true;
                queue.push_back(edge.neighbor);
            }
        }
        protect_line_supported_marks(components, &seeds, dpi, &mut keep);
    }
    (keep, fallback)
}

#[derive(Clone, Copy)]
struct DespeckleParameters {
    distance_factor: f64,
    parent_area_ratio: f64,
    maximum_hops: u8,
    seed_stroke_area_factor: f64,
}

impl DespeckleParameters {
    fn for_level(level: DespeckleLevel, dpi: f64) -> Self {
        let dpi_factor = (dpi / 300.0).clamp(0.5, 4.0);
        match level {
            DespeckleLevel::Off | DespeckleLevel::Cautious => Self {
                distance_factor: 100.0,
                parent_area_ratio: 0.125 * dpi_factor,
                maximum_hops: 5,
                seed_stroke_area_factor: 0.35,
            },
            DespeckleLevel::Normal => Self {
                distance_factor: 42.0,
                parent_area_ratio: 0.175 * dpi_factor,
                maximum_hops: 3,
                seed_stroke_area_factor: 0.5,
            },
            DespeckleLevel::Aggressive => Self {
                distance_factor: 12.0,
                parent_area_ratio: 0.225 * dpi_factor,
                maximum_hops: 3,
                seed_stroke_area_factor: 0.75,
            },
        }
    }
}

fn despeckle_seed_thresholds(
    calibration: PageCalibration,
    dpi: f64,
    level: DespeckleLevel,
) -> (usize, u32) {
    let scale = (dpi / 300.0).clamp(0.5, 4.0);
    if calibration.config.despeckle_substantial_area && calibration.valid {
        let stroke_width = calibration.stroke_width_px * dpi.max(1.0) / calibration.effective_dpi;
        let area = (DespeckleParameters::for_level(level, dpi).seed_stroke_area_factor
            * stroke_width.powi(2))
        .round()
        .max(16.0) as usize;
        let minimum_radius_squared = (stroke_width * 0.5).powi(2).round().max(1.0) as u32;
        (area, minimum_radius_squared)
    } else {
        (
            calibration.despeckle_substantial_area(dpi),
            scale.powi(2).ceil().max(1.0) as u32,
        )
    }
}

fn component_maximum_inscribed_radius_squared(
    source: &BinaryImage,
    components: &ComponentMap,
) -> Vec<u32> {
    let distances = squared_euclidean_distance(&source.invert());
    components.maximum_values_by_component(&distances)
}

fn protect_high_contrast_components(
    components: &ComponentMap,
    normalized: &GrayImage,
    more_cautious_keep: Option<&[bool]>,
    keep: &mut [bool],
) {
    const INKY_CONTRAST_THRESHOLD: f64 = 40.0;
    let (ink_sums, ink_counts) = components.gray_sums_by_component(normalized);
    for component in components.components() {
        let label = component.label as usize;
        if keep[label]
            || ink_counts[label] == 0
            || more_cautious_keep.is_some_and(|decision| !decision[label])
        {
            continue;
        }
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let radius = width.min(height).div_ceil(2).clamp(2, 12);
        let left = component.left.saturating_sub(radius);
        let right = component
            .right
            .saturating_add(radius)
            .min(normalized.width() - 1);
        let top = component.top.saturating_sub(radius);
        let bottom = component
            .bottom
            .saturating_add(radius)
            .min(normalized.height() - 1);
        let mut paper_sum = 0u64;
        let mut paper_count = 0usize;
        for y in top..=bottom {
            for x in left..=right {
                if components.label_at(x, y) == 0 {
                    paper_sum += u64::from(normalized.get(x, y));
                    paper_count += 1;
                }
            }
        }
        if paper_count == 0 {
            continue;
        }
        let ink_mean = ink_sums[label] as f64 / ink_counts[label] as f64;
        let paper_mean = paper_sum as f64 / paper_count as f64;
        if paper_mean - ink_mean >= INKY_CONTRAST_THRESHOLD {
            keep[label] = true;
        }
    }
}

fn populate_attachment_graph(
    components: &[scan_primitives::Component],
    graph: &mut [Vec<AttachmentEdge>],
) {
    let mut by_left = (0..components.len()).collect::<Vec<_>>();
    by_left.sort_unstable_by_key(|&index| components[index].left);
    let maximum_area = components
        .iter()
        .map(|component| component.area)
        .max()
        .unwrap_or(0);
    let horizontal_reach = (maximum_area as f64 * 100.0).sqrt().ceil() as usize;
    for (position, &left_index) in by_left.iter().enumerate() {
        let left = &components[left_index];
        for &right_index in &by_left[position + 1..] {
            let right = &components[right_index];
            if right.left > left.right.saturating_add(horizontal_reach + 1) {
                break;
            }
            let distance_squared = component_gap_distance_squared(left, right);
            if distance_squared <= left.area.max(right.area) as u64 * 100 {
                graph[left.label as usize].push(AttachmentEdge {
                    neighbor: right.label as usize,
                    distance_squared,
                });
                graph[right.label as usize].push(AttachmentEdge {
                    neighbor: left.label as usize,
                    distance_squared,
                });
            }
        }
    }
}

fn protect_line_supported_marks(
    components: &[scan_primitives::Component],
    seeds: &[bool],
    dpi: f64,
    keep: &mut [bool],
) {
    // Cautious mode treats an entire bracketed text row as supporting evidence.
    // This protects long dot leaders and isolated punctuation without making
    // them graph bridges: they are retained but never added to the Dijkstra queue.
    let scale = (dpi / 300.0).clamp(0.5, 4.0);
    let horizontal_reach = (224.0 * scale).round() as usize;
    let vertical_reach = (9.0 * scale).round().max(2.0) as usize;
    let anchors = components
        .iter()
        .filter(|component| seeds[component.label as usize])
        .collect::<Vec<_>>();
    for mark in components {
        let label = mark.label as usize;
        if keep[label] || mark.area < 2 || seeds[label] {
            continue;
        }
        let mark_center_y = (mark.top + mark.bottom) / 2;
        let mut supported_left = false;
        let mut supported_right = false;
        for anchor in &anchors {
            let anchor_center_y = (anchor.top + anchor.bottom) / 2;
            let line_tolerance = vertical_reach.max((anchor.bottom - anchor.top).div_ceil(2));
            if mark_center_y.abs_diff(anchor_center_y) > line_tolerance {
                continue;
            }
            if anchor.right < mark.left && mark.left - anchor.right - 1 <= horizontal_reach {
                supported_left = true;
            }
            if mark.right < anchor.left && anchor.left - mark.right - 1 <= horizontal_reach {
                supported_right = true;
            }
        }
        if supported_left && supported_right {
            keep[label] = true;
        }
    }
}

fn component_gap_distance_squared(
    left: &scan_primitives::Component,
    right: &scan_primitives::Component,
) -> u64 {
    let x_gap = axis_gap(left.left, left.right, right.left, right.right) as u64;
    let y_gap = axis_gap(left.top, left.bottom, right.top, right.bottom) as u64;
    x_gap * x_gap + y_gap * y_gap
}

fn axis_gap(first_start: usize, first_end: usize, second_start: usize, second_end: usize) -> usize {
    if first_end < second_start {
        second_start - first_end - 1
    } else if second_end < first_start {
        first_start - second_end - 1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grayscale_percentiles_and_faint_fraction_ignore_stride_padding() {
        let image = GrayImage::from_vec(
            3,
            2,
            6,
            vec![10, 20, 30, 255, 255, 255, 40, 50, 60, 255, 255, 255],
        )
        .unwrap();
        assert_eq!(image_percentile(&image, 0.5), 40);
        assert_eq!(paper_reference(&image), 40);

        let uniform = GrayImage::from_vec(
            3,
            2,
            6,
            vec![100, 100, 100, 0, 0, 0, 100, 100, 100, 0, 0, 0],
        )
        .unwrap();
        assert_eq!(faint_ink_fraction(&uniform), 0.0);
    }

    fn binary_fixture(bytes: &[u8]) -> BinaryImage {
        let gray = crate::png::decode_gray(bytes, 1_000_000, 2_000).unwrap();
        let mut binary = BinaryImage::new(gray.width(), gray.height());
        for y in 0..gray.height() {
            for x in 0..gray.width() {
                binary.set(x, y, gray.get(x, y) < 128);
            }
        }
        binary
    }

    #[test]
    fn horizontal_bridge_admission_uses_cross_bridge_extent() {
        let fused_text = scan_primitives::Component {
            label: 1,
            area: 200,
            left: 0,
            top: 0,
            right: 199,
            bottom: 19,
        };
        let thick_fused_blob = scan_primitives::Component {
            bottom: 39,
            ..fused_text.clone()
        };

        assert!(is_horizontally_fused_extent_admissible(&fused_text, 20));
        assert!(!is_horizontally_fused_extent_admissible(&fused_text, 19));
        assert!(!is_horizontally_fused_extent_admissible(
            &thick_fused_blob,
            20
        ));
    }

    fn assert_binary_eq(left: &BinaryImage, right: &BinaryImage) {
        assert_eq!(
            (left.width(), left.height()),
            (right.width(), right.height())
        );
        for y in 0..left.height() {
            for x in 0..left.width() {
                assert_eq!(left.get(x, y), right.get(x, y), "pixel ({x}, {y})");
            }
        }
    }

    fn solid_component_line(widths: &[usize]) -> BinaryImage {
        let mut image = BinaryImage::new(20 + widths.len() * 28, 48);
        for (index, &width) in widths.iter().enumerate() {
            let left = 10 + index * 28;
            for y in 14..34 {
                for x in left..left + width {
                    image.set(x, y, true);
                }
            }
        }
        image
    }

    #[test]
    fn ridge_width_matches_the_oracles_opencv_l2_5_measurement() {
        let mut rectangle = BinaryImage::new(5, 9);
        for y in 0..rectangle.height() {
            for x in 0..rectangle.width() {
                rectangle.set(x, y, true);
            }
        }
        assert_eq!(ridge_width_of_isolated_component(&rectangle), 6.0);

        let mut diamond = BinaryImage::new(11, 11);
        for y in 0..diamond.height() {
            for x in 0..diamond.width() {
                if x.abs_diff(5) + y.abs_diff(5) <= 4 {
                    diamond.set(x, y, true);
                }
            }
        }
        let diamond_width = ridge_width_of_isolated_component(&diamond);
        assert!(
            (diamond_width - 7.193_786_6).abs() < 0.000_01,
            "diamond width {diamond_width}"
        );
    }

    #[test]
    fn stroke_budget_rounding_is_half_away_from_zero_at_half_tie_dpi() {
        assert_eq!(
            stroke_budget_eligibility(312.5),
            StrokeBudgetEligibility {
                minimum_area: 9,
                minimum_height: 13,
                maximum_height: 73,
                minimum_width: 2,
                maximum_width: 208,
            }
        );
    }

    #[test]
    fn simple_point_guard_rejects_a_two_sided_articulation() {
        let mut component = BinaryImage::new(5, 3);
        for x in 1..=3 {
            component.set(x, 1, true);
        }
        assert!(!topology_preserving_boundary_removal(&component, 2, 1));
    }

    #[test]
    fn endpoint_guard_rejects_a_removable_digital_simple_point() {
        let mut component = BinaryImage::new(5, 3);
        component.set(1, 1, true);
        component.set(2, 1, true);
        assert!(!topology_preserving_boundary_removal(&component, 1, 1));
    }

    #[test]
    fn release_backstop_rejects_a_faulty_removal_predicate() {
        let mut dumbbell = BinaryImage::new(17, 9);
        for y in 1..8 {
            for x in 1..7 {
                dumbbell.set(x, y, true);
            }
            for x in 10..16 {
                dumbbell.set(x, y, true);
            }
        }
        for x in 7..10 {
            dumbbell.set(x, 4, true);
        }
        let before_width = ridge_width_of_isolated_component(&dumbbell);
        assert!(normalize_offender_component(
            &dumbbell,
            before_width,
            2.0,
            STROKE_BUDGET_COMPONENT_AREA_MIN_PX,
            &|_, _, _| true,
        )
        .is_none());
    }

    #[test]
    fn source_heavy_normalization_stops_at_budget_without_changing_topology() {
        let source = solid_component_line(&[4, 4, 4, 4, 4, 4, 4, 8]);
        let before_topology = binary_topology_signature(&source);
        let (normalized, budget, interventions) = establish_line_stroke_budget(&source, 300.0);
        assert!(budget.is_some());
        assert_eq!(interventions.source_components_normalized, 1);
        assert_eq!(interventions.source_components_unreachable, 0);
        assert_eq!(binary_topology_signature(&normalized), before_topology);

        let map = ComponentMap::from_binary(&normalized);
        let label = map.label_at(10 + 7 * 28 + 4, 24);
        let width = component_ridge_width(&normalized, &map, label);
        assert!((4.0..=6.4).contains(&width), "normalized width {width}");
    }

    #[test]
    fn source_heavy_normalization_preserves_an_existing_counter() {
        let mut source = solid_component_line(&[4, 4, 4, 4, 4, 4, 4, 22]);
        let left = 10 + 7 * 28;
        for y in 18..30 {
            for x in left + 8..left + 14 {
                source.set(x, y, false);
            }
        }
        let before_topology = binary_topology_signature(&source);
        assert_eq!(before_topology, (8, 1));

        let (normalized, budget, interventions) = establish_line_stroke_budget(&source, 300.0);
        assert!(budget.is_some());
        assert_eq!(interventions.source_components_normalized, 1);
        assert_eq!(interventions.source_components_unreachable, 0);
        assert_eq!(binary_topology_signature(&normalized), before_topology);
    }

    #[test]
    fn systemic_heavy_line_abstains_but_a_sparse_offender_remains_actionable() {
        let systemic = solid_component_line(&[4, 4, 4, 4, 4, 4, 8, 8]);
        let (systemic_budget, systemic_offenders) =
            LineStrokeBudget::from_binary(&systemic, 300.0).unwrap();
        assert!(systemic_offenders.is_empty());
        assert!(systemic_budget.local_budget_at(10.0, 24.0).is_none());

        let sparse = solid_component_line(&[4, 4, 4, 4, 4, 4, 4, 8]);
        let (sparse_budget, sparse_offenders) =
            LineStrokeBudget::from_binary(&sparse, 300.0).unwrap();
        assert_eq!(sparse_offenders.len(), 1);
        assert!(sparse_budget.local_budget_at(10.0, 24.0).is_some());
    }

    #[test]
    fn small_print_line_below_quantization_floor_abstains_from_budgeting() {
        let small_print = solid_component_line(&[2, 2, 2, 2, 2, 2, 2, 4]);
        let (budget, offenders) = LineStrokeBudget::from_binary(&small_print, 300.0).unwrap();
        assert!(offenders.is_empty());
        assert!(budget.local_budget_at(10.0, 24.0).is_none());
    }

    #[test]
    fn quantization_floor_boundary_abstains_until_the_margin_exceeds_the_step() {
        let boundary_median =
            RIDGE_WIDTH_QUANTIZATION_STEP_PX / (STROKE_BUDGET_TOLERANCE_RATIO - 1.0);
        let line_with_median = |median_width_px: f64| StrokeBudgetLine {
            center_y: 24.0,
            intervention_enabled: true,
            components: (0..STROKE_BUDGET_MINIMUM_LOCAL_COMPONENTS)
                .map(|index| StrokeBudgetComponent {
                    center_x: index as f64 * 10.0,
                    center_y: 24.0,
                    ridge_width_px: median_width_px,
                })
                .collect(),
        };

        // At the boundary the rounded margin equals the step exactly, and the
        // strict inequality must treat equality as unmeasurable.
        assert_eq!(
            boundary_median * (STROKE_BUDGET_TOLERANCE_RATIO - 1.0),
            RIDGE_WIDTH_QUANTIZATION_STEP_PX
        );
        for median_width_px in [boundary_median.next_down(), boundary_median] {
            assert!(
                local_stroke_budget(&line_with_median(median_width_px), 0.0, 300.0).is_none(),
                "median {median_width_px} must abstain",
            );
        }

        let engaged = local_stroke_budget(&line_with_median(boundary_median.next_up()), 0.0, 300.0)
            .expect("one ULP above the boundary must engage budgeting");
        assert!(engaged.maximum_width_px > boundary_median);
    }

    #[test]
    fn smoothing_guard_suppresses_only_the_delta_that_crosses_the_shared_budget() {
        let base = solid_component_line(&[4, 4, 4, 4, 4, 4, 4, 6]);
        let (budget, offenders) = LineStrokeBudget::from_binary(&base, 300.0).unwrap();
        assert!(offenders.is_empty());
        let mut candidate = base.clone();
        let left = 10 + 7 * 28;
        for y in 14..34 {
            candidate.set(left - 1, y, true);
            candidate.set(left + 6, y, true);
        }
        let mut interventions = LineStrokeBudgetInterventions::default();
        let guarded = cap_added_ink_to_stroke_budget(
            &base,
            &candidate,
            None,
            Some(&budget),
            StrokeBudgetAdditionStage::Smoothing,
            &mut interventions,
        );
        for y in 0..base.height() {
            for x in 0..base.width() {
                assert!(!base.get(x, y) || guarded.get(x, y));
            }
        }
        let guarded_map = ComponentMap::from_binary(&guarded);
        let label = guarded_map.label_at(left + 3, 24);
        let guarded_width = component_ridge_width(&guarded, &guarded_map, label);
        assert!(guarded_width <= 6.4, "guarded width {guarded_width}");
        assert_eq!(interventions.smoothing_components_capped, 1);
        assert!((1..40).contains(&interventions.smoothing_pixels_suppressed));
    }

    #[test]
    fn rescue_guard_does_not_merge_full_weight_comparator_components() {
        let mut base = solid_component_line(&[4, 4, 4, 4, 4, 4]);
        let left = 10 + 6 * 28;
        for y in 14..34 {
            for x in left..left + 4 {
                base.set(x, y, true);
            }
            for x in left + 6..left + 10 {
                base.set(x, y, true);
            }
        }
        let (budget, offenders) = LineStrokeBudget::from_binary(&base, 300.0).unwrap();
        assert!(offenders.is_empty());
        let mut candidate = base.clone();
        for y in 14..34 {
            candidate.set(left + 4, y, true);
            candidate.set(left + 5, y, true);
        }
        let mut interventions = LineStrokeBudgetInterventions::default();
        let guarded = cap_added_ink_to_stroke_budget(
            &base,
            &candidate,
            None,
            Some(&budget),
            StrokeBudgetAdditionStage::Rescue,
            &mut interventions,
        );
        assert_binary_eq(&guarded, &base);
        assert_eq!(interventions.rescue_components_capped, 1);
        assert_eq!(interventions.rescue_bridge_components_capped, 1);
        assert_eq!(interventions.rescue_pixels_suppressed, 40);
    }

    #[test]
    fn addition_guard_does_not_touch_a_candidate_within_offender_tolerance() {
        let mut base = solid_component_line(&[4, 4, 4, 4, 4, 4]);
        let left = 10 + 6 * 28;
        for y in 8..22 {
            for x in left..left + 4 {
                base.set(x, y, true);
            }
        }
        for y in 24..38 {
            for x in left..left + 4 {
                base.set(x, y, true);
            }
        }
        let (budget, _) = LineStrokeBudget::from_binary(&base, 300.0).unwrap();
        let mut candidate = base.clone();
        for y in 22..24 {
            for x in left..left + 4 {
                candidate.set(x, y, true);
            }
        }
        let mut interventions = LineStrokeBudgetInterventions::default();
        let guarded = cap_added_ink_to_stroke_budget(
            &base,
            &candidate,
            None,
            Some(&budget),
            StrokeBudgetAdditionStage::Rescue,
            &mut interventions,
        );
        assert_binary_eq(&guarded, &candidate);
        assert_eq!(interventions.rescue_components_capped, 0);
    }

    #[test]
    fn addition_guard_rejects_delta_when_the_base_is_already_over_budget() {
        let base = solid_component_line(&[4, 4, 4, 4, 4, 4, 4, 8]);
        let (budget, offenders) = LineStrokeBudget::from_binary(&base, 300.0).unwrap();
        assert_eq!(offenders.len(), 1);
        let mut candidate = base.clone();
        let left = 10 + 7 * 28;
        for y in 14..34 {
            candidate.set(left - 1, y, true);
            candidate.set(left + 8, y, true);
        }
        let mut interventions = LineStrokeBudgetInterventions::default();
        let guarded = cap_added_ink_to_stroke_budget(
            &base,
            &candidate,
            None,
            Some(&budget),
            StrokeBudgetAdditionStage::Smoothing,
            &mut interventions,
        );
        assert_binary_eq(&guarded, &base);
        assert_eq!(interventions.smoothing_pixels_suppressed, 40);
    }

    #[test]
    fn addition_guard_will_not_detach_a_sub_floor_fragment() {
        let mut base = solid_component_line(&[4, 4, 4, 4, 4, 4, 4, 4]);
        let left = 10 + 7 * 28;
        for y in 21..24 {
            base.set(left + 10, y, true);
        }
        let (budget, _) = LineStrokeBudget::from_binary(&base, 300.0).unwrap();
        let mut candidate = base.clone();
        for y in 14..34 {
            for x in left + 4..left + 8 {
                candidate.set(x, y, true);
            }
        }
        for x in left + 8..=left + 10 {
            candidate.set(x, 22, true);
        }
        assert_eq!(component_count_below_area(&base, 8), 1);
        assert_eq!(component_count_below_area(&candidate, 8), 0);
        let mut interventions = LineStrokeBudgetInterventions::default();
        let guarded = cap_added_ink_to_stroke_budget(
            &base,
            &candidate,
            None,
            Some(&budget),
            StrokeBudgetAdditionStage::Rescue,
            &mut interventions,
        );
        assert_eq!(
            component_count_below_area(&guarded, budget.minimum_component_area),
            0,
            "budget suppression detached a sub-floor fragment"
        );
        let guarded_map = ComponentMap::from_binary(&guarded);
        assert_eq!(
            guarded_map.label_at(left, 22),
            guarded_map.label_at(left + 10, 22),
            "the three-pixel mark must remain attached to its parent glyph"
        );
        assert_eq!(component_count_below_area(&guarded, 8), 0);
    }

    fn black_count(image: &BinaryImage) -> usize {
        (0..image.height())
            .map(|y| (0..image.width()).filter(|&x| image.get(x, y)).count())
            .sum()
    }

    fn has_ink_near(image: &BinaryImage, point: (usize, usize), radius: usize) -> bool {
        let (x, y) = point;
        (y.saturating_sub(radius)..=(y + radius).min(image.height() - 1)).any(|sample_y| {
            (x.saturating_sub(radius)..=(x + radius).min(image.width() - 1))
                .any(|sample_x| image.get(sample_x, sample_y))
        })
    }

    fn tiny_component_count(image: &BinaryImage, maximum_area: usize) -> usize {
        ComponentMap::from_binary(image)
            .components()
            .iter()
            .filter(|component| component.area <= maximum_area)
            .count()
    }

    #[test]
    fn shallow_paper_gradient_remains_blank() {
        let mut source = GrayImage::new(720, 960, 250);
        let mut state = 0x5eed_2f01_u64 ^ 17;
        for y in 0..source.height() {
            for x in 0..source.width() {
                let horizontal = x as f64 / source.width() as f64;
                let vertical = y as f64 / source.height() as f64;
                let blend = horizontal * 0.65 + vertical * 0.35;
                let base = 242.0 + 8.0 * blend;
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                let noise = -2 + ((state >> 16) as u32 % 5) as i16;
                source.set(x, y, (base.round() as i16 + noise) as u8);
            }
        }
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: BinarizationMode::Auto,
            despeckle: false,
            ..CleanupOptions::default()
        };

        let result = clean_black_and_white(&source, &options);
        let threshold = paper_ink_midpoint_threshold(&result.normalized, None);
        let minimum = result.normalized.data().iter().copied().min().unwrap();
        let maximum = result.normalized.data().iter().copied().max().unwrap();
        let diagnostics = resolve_binarization_diagnostics(
            &smooth_for_binarization(&result.normalized, options.dpi),
            &options,
        );
        assert_eq!(
            result.binary.count_black(),
            0,
            "shallow paper texture became ink: mode={:?}, threshold={threshold:?}, range={minimum}..={maximum}, diagnostics={diagnostics:?}, components={}",
            result.mode,
            ComponentMap::from_binary(&result.binary).components().len(),
        );
    }

    #[test]
    fn uniform_empty_otsu_verdict_survives_the_full_thickness_range() {
        let mut source = GrayImage::new(720, 960, 248);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(x, y, 248 + ((x * 7 + y * 11) % 3) as u8);
            }
        }
        let calibration = PageCalibration::estimate(&source, 300.0, CalibrationConfig::default());

        for thickness in 0..=2 {
            let options = CleanupOptions {
                dpi: 300.0,
                binarization: BinarizationMode::Otsu,
                thickness,
                despeckle: false,
                normalize_illumination: false,
                ..CleanupOptions::default()
            };
            let decision = paper_ink_midpoint_threshold(&source, None);
            assert!(
                decision.uniform_empty,
                "thickness={thickness}: {decision:?}"
            );
            let binary = threshold_with_mode(
                &source,
                &source,
                None,
                &options,
                BinarizationMode::Otsu,
                calibration,
                None,
            );
            assert_eq!(
                binary.count_black(),
                0,
                "thickness={thickness} flooded a uniform blank leaf"
            );
        }
    }

    #[test]
    fn faint_uniform_ink_uses_otsu_even_with_one_dust_mote() {
        const FAINT_INK_PIXELS: usize = 17_632;
        for ink in [246, 245, 242] {
            for dust_mote in [false, true] {
                let mut source = GrayImage::new(720, 960, 250);
                for index in 0..FAINT_INK_PIXELS {
                    let x = 120 + index % 128;
                    let y = 180 + index / 128;
                    source.set(x, y, ink);
                }
                if dust_mote {
                    source.set(30, 30, 32);
                }
                let decision = paper_ink_midpoint_threshold(&source, None);
                assert!(
                    !decision.uniform_empty,
                    "ink={ink}, dust={dust_mote}: faint print was declared blank"
                );
                let options = CleanupOptions {
                    dpi: 300.0,
                    binarization: BinarizationMode::Otsu,
                    despeckle: false,
                    normalize_illumination: false,
                    ..CleanupOptions::default()
                };
                let calibration =
                    PageCalibration::estimate(&source, options.dpi, CalibrationConfig::default());
                let binary = threshold_with_mode(
                    &source,
                    &source,
                    None,
                    &options,
                    BinarizationMode::Otsu,
                    calibration,
                    None,
                );
                let expected = FAINT_INK_PIXELS + usize::from(dust_mote);
                assert_eq!(
                    binary.count_black(),
                    expected,
                    "ink={ink}, dust={dust_mote}, decision={decision:?}"
                );
            }
        }
    }

    #[test]
    fn spread_plan_is_symmetric_and_overrides_leaf_route_selection() {
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: BinarizationMode::Auto,
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };
        let mut left = GrayImage::new(256, 256, 242);
        let mut right = GrayImage::new(256, 256, 242);
        for y in 32..224 {
            for x in 24..232 {
                if (x / 12 + y / 18) % 5 == 0 {
                    left.set(x, y, 54);
                    right.set(x, y, if x < 128 { 54 } else { 92 });
                }
            }
        }
        let mut normalized = GrayImage::new(512, 256, 242);
        for y in 0..256 {
            for x in 0..256 {
                normalized.set(x, y, left.get(x, y));
                normalized.set(x + 256, y, right.get(x, y));
            }
        }
        let calibration =
            PageCalibration::estimate(&normalized, options.dpi, CalibrationConfig::default());
        let plans = resolve_spread_binarization_plans(
            &normalized,
            &left,
            &right,
            &left,
            &right,
            None,
            None,
            options.dpi,
            &options,
            calibration,
            Some(2.5),
            Some(18.0),
        );
        let swapped = resolve_spread_binarization_plans(
            &normalized,
            &right,
            &left,
            &right,
            &left,
            None,
            None,
            options.dpi,
            &options,
            calibration,
            Some(2.5),
            Some(18.0),
        );

        assert_eq!(plans.left.route, swapped.right.route);
        assert_eq!(plans.right.route, swapped.left.route);
        assert_eq!(plans.left.threshold_anchor, swapped.right.threshold_anchor);
        assert_eq!(plans.left.threshold_radius, 27);
        assert_eq!(plans.left.threshold_radius, swapped.right.threshold_radius);
        assert!(plans.left.diagnostics.document_anchor);
        assert_eq!(
            plans.left.diagnostics.left_candidate_route,
            swapped.right.diagnostics.right_candidate_route
        );
        assert_eq!(
            plans.left.diagnostics.right_candidate_route,
            swapped.right.diagnostics.left_candidate_route
        );

        let (_, left_diagnostics, _, _) = binarize_normalized_with_diagnostics(
            &left,
            &left,
            resolve_binarization_diagnostics(&left, &options),
            None,
            &options,
            calibration,
            None,
            None,
            Some(&plans.left),
        );
        let (_, right_diagnostics, _, _) = binarize_normalized_with_diagnostics(
            &right,
            &right,
            resolve_binarization_diagnostics(&right, &options),
            None,
            &options,
            calibration,
            None,
            None,
            Some(&plans.right),
        );
        assert_eq!(left_diagnostics.route, plans.left.route);
        assert_eq!(right_diagnostics.route, plans.right.route);
        assert_eq!(
            left_diagnostics.spread_plan.unwrap().threshold_radius,
            plans.left.threshold_radius
        );
        assert_eq!(
            right_diagnostics.spread_plan.unwrap().threshold_radius,
            plans.right.threshold_radius
        );
    }

    #[test]
    fn shared_spread_plan_prefers_otsu_when_the_joint_reading_disagrees() {
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: BinarizationMode::Auto,
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };
        let mut leaf = GrayImage::new(256, 256, 242);
        for y in 32..224 {
            for x in 24..232 {
                if (x / 12 + y / 18) % 5 == 0 {
                    leaf.set(x, y, 54);
                }
            }
        }
        // The joint reading is taken on a differently prepared raster; a dark
        // scanner border on it is enough to push the spread-level route off
        // Otsu while both leaves remain flat-lit text.
        let mut joint = GrayImage::new(512, 256, 242);
        for y in 0..256 {
            for x in 0..256 {
                joint.set(x, y, leaf.get(x, y));
                joint.set(x + 256, y, leaf.get(x, y));
            }
        }
        for y in 0..256 {
            for x in 0..512 {
                if !(40..472).contains(&x) || !(24..232).contains(&y) {
                    joint.set(x, y, 12);
                }
            }
        }
        let leaf_route = resolve_route_for_diagnostics(
            &measure_binarization_diagnostics(&leaf, &options),
            &options,
        );
        let joint_route = resolve_route_for_diagnostics(
            &measure_binarization_diagnostics(&joint, &options),
            &options,
        );
        assert_eq!(
            leaf_route,
            BinarizationMode::Otsu,
            "fixture leaf must route Otsu"
        );
        assert_ne!(
            joint_route,
            BinarizationMode::Otsu,
            "fixture joint must disagree"
        );

        let calibration =
            PageCalibration::estimate(&joint, options.dpi, CalibrationConfig::default());
        let plans = resolve_spread_binarization_plans(
            &joint,
            &leaf,
            &leaf,
            &leaf,
            &leaf,
            None,
            None,
            options.dpi,
            &options,
            calibration,
            Some(2.5),
            Some(18.0),
        );

        assert_eq!(
            plans.left.diagnostics.decision,
            SpreadBinarizationPlanDecision::SharedJoint
        );
        assert_eq!(plans.left.route, BinarizationMode::Otsu);
        assert_eq!(plans.right.route, BinarizationMode::Otsu);
        assert_eq!(plans.left.diagnostics.route, BinarizationMode::Otsu);
        assert_eq!(plans.left.diagnostics.joint_candidate_route, joint_route);
    }

    #[test]
    fn shared_spread_plan_prefers_otsu_when_the_leaves_disagree_with_it() {
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: BinarizationMode::Auto,
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };
        // The mirror image of the register failure: photo-plate leaves carry a
        // dark border that pushes their own reading off Otsu, while the
        // normalized joint still reads as flat-lit text. The global
        // thresholder must win this disagreement too.
        let mut leaf = GrayImage::new(256, 256, 242);
        for y in 32..224 {
            for x in 24..232 {
                if (x / 12 + y / 18) % 5 == 0 {
                    leaf.set(x, y, 54);
                }
            }
        }
        for y in 0..256 {
            for x in 0..256 {
                if !(20..236).contains(&x) || !(12..244).contains(&y) {
                    leaf.set(x, y, 12);
                }
            }
        }
        let mut joint = GrayImage::new(512, 256, 242);
        for y in 32..224 {
            for x in 24..232 {
                if (x / 12 + y / 18) % 5 == 0 {
                    let value = 54;
                    joint.set(x + 16, y, value);
                    joint.set(x + 272, y, value);
                }
            }
        }
        let leaf_route = resolve_route_for_diagnostics(
            &measure_binarization_diagnostics(&leaf, &options),
            &options,
        );
        let joint_route = resolve_route_for_diagnostics(
            &measure_binarization_diagnostics(&joint, &options),
            &options,
        );
        assert_ne!(
            leaf_route,
            BinarizationMode::Otsu,
            "fixture leaves must route off Otsu"
        );
        assert_eq!(
            joint_route,
            BinarizationMode::Otsu,
            "fixture joint must read Otsu"
        );

        let calibration =
            PageCalibration::estimate(&joint, options.dpi, CalibrationConfig::default());
        let plans = resolve_spread_binarization_plans(
            &joint,
            &leaf,
            &leaf,
            &leaf,
            &leaf,
            None,
            None,
            options.dpi,
            &options,
            calibration,
            Some(2.5),
            Some(18.0),
        );

        assert_eq!(
            plans.left.diagnostics.decision,
            SpreadBinarizationPlanDecision::SharedJoint
        );
        assert_eq!(plans.left.route, BinarizationMode::Otsu);
        assert_eq!(plans.right.route, BinarizationMode::Otsu);
        assert_eq!(plans.left.diagnostics.joint_candidate_route, joint_route);
        assert_eq!(plans.left.diagnostics.left_candidate_route, leaf_route);
    }

    #[test]
    fn spread_plan_falls_back_to_leaf_anchors_when_threshold_evidence_drifts() {
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: BinarizationMode::Auto,
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };
        let mut left = GrayImage::new(256, 256, 242);
        let mut right = GrayImage::new(256, 256, 242);
        for y in 32..224 {
            for x in 24..232 {
                if (x / 12 + y / 18) % 5 == 0 {
                    left.set(x, y, 48);
                    right.set(x, y, 156);
                }
            }
        }
        let mut normalized = GrayImage::new(512, 256, 242);
        for y in 0..256 {
            for x in 0..256 {
                normalized.set(x, y, left.get(x, y));
                normalized.set(x + 256, y, right.get(x, y));
            }
        }
        let calibration =
            PageCalibration::estimate(&normalized, options.dpi, CalibrationConfig::default());
        let plans = resolve_spread_binarization_plans(
            &normalized,
            &left,
            &right,
            &left,
            &right,
            None,
            None,
            options.dpi,
            &options,
            calibration,
            Some(2.5),
            Some(18.0),
        );

        assert_eq!(plans.left.route, BinarizationMode::Otsu);
        assert_eq!(plans.right.route, BinarizationMode::Otsu);
        assert_eq!(
            plans.left.diagnostics.decision,
            SpreadBinarizationPlanDecision::PerLeafAnchorDrift
        );
        assert_eq!(
            plans.right.diagnostics.decision,
            SpreadBinarizationPlanDecision::PerLeafAnchorDrift
        );
        assert_ne!(
            plans.left.threshold_anchor, plans.right.threshold_anchor,
            "the fallback must retain each leaf's measured threshold anchor"
        );
    }

    #[test]
    fn spread_reconciliation_is_carried_from_canonical_samples_across_working_dpi() {
        let mut routing_left = GrayImage::new(128, 192, 242);
        for y in 20..172 {
            for x in (12..116).step_by(13) {
                for stroke_x in x..x + 3 {
                    routing_left.set(stroke_x, y, 48);
                }
            }
        }
        let routing_right = routing_left.clone();
        let working_left = routing_left.clone();
        let mut working_right = GrayImage::new(128, 192, 242);
        for y in 20..172 {
            for x in (12..116).step_by(13) {
                for stroke_x in x..x + 3 {
                    working_right.set(stroke_x, y, 198);
                }
            }
        }
        let mut routing_joint = GrayImage::new(256, 192, 242);
        for y in 0..192 {
            for x in 0..128 {
                routing_joint.set(x, y, routing_left.get(x, y));
                routing_joint.set(x + 128, y, routing_right.get(x, y));
            }
        }

        let mut decisions = Vec::new();
        let mut routes = Vec::new();
        for dpi in [298.0, 299.0, 300.0, 600.0] {
            let options = CleanupOptions {
                dpi,
                normalize_illumination: false,
                despeckle: false,
                ..CleanupOptions::default()
            };
            let calibration =
                PageCalibration::estimate(&routing_joint, 150.0, CalibrationConfig::default());
            let plans = resolve_spread_binarization_plans(
                &routing_joint,
                &routing_left,
                &routing_right,
                &routing_left,
                &routing_right,
                None,
                None,
                150.0,
                &options,
                calibration,
                Some(2.5),
                Some(18.0),
            );
            decisions.push(plans.left.diagnostics.decision);
            routes.push((plans.left.route, plans.right.route));
        }

        assert!(
            decisions
                .iter()
                .all(|decision| *decision == SpreadBinarizationPlanDecision::SharedJoint),
            "working DPI must not reopen canonical spread reconciliation: {decisions:?}"
        );
        assert!(routes.windows(2).all(|pair| pair[0] == pair[1]));

        let options = CleanupOptions {
            dpi: 300.0,
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };
        let calibration =
            PageCalibration::estimate(&routing_joint, 150.0, CalibrationConfig::default());
        let substituted = resolve_spread_binarization_plans(
            &routing_joint,
            &routing_left,
            &routing_right,
            &working_left,
            &working_right,
            None,
            None,
            300.0,
            &options,
            calibration,
            Some(2.5),
            Some(18.0),
        );
        assert_ne!(
            substituted.left.diagnostics.decision,
            SpreadBinarizationPlanDecision::SharedJoint,
            "the mutation control must fail when reconciliation reads working rasters"
        );
    }

    fn faint_text_fixture() -> (GrayImage, BinaryImage) {
        let mut raw = GrayImage::new(240, 100, 232);
        let mut text_vicinity = BinaryImage::new(240, 100);
        for y in 34..49 {
            text_vicinity.set(20, y, true);
            for x in 20..220 {
                if x % 19 < 2 {
                    raw.set(x, y, 198);
                }
            }
        }
        (raw, text_vicinity)
    }

    #[test]
    fn explicit_wolf_and_sauvola_rescue_faint_text_rows_dropped_by_thresholding() {
        let (raw, text_vicinity) = faint_text_fixture();
        let normalized = GrayImage::new(raw.width(), raw.height(), 232);
        for mode in [BinarizationMode::Wolf, BinarizationMode::Sauvola] {
            let options = CleanupOptions {
                dpi: 300.0,
                binarization: mode,
                normalize_illumination: false,
                despeckle: false,
                ..CleanupOptions::default()
            };
            let calibration =
                PageCalibration::estimate(&normalized, options.dpi, CalibrationConfig::default());
            let damaged = postprocess_binary_with_raw(
                &threshold_with_mode(
                    &normalized,
                    &normalized,
                    None,
                    &options,
                    mode,
                    calibration,
                    None,
                ),
                Some(&normalized),
                Some(&normalized),
                &options,
                calibration,
            );
            assert!(!damaged.get(38, 40));
            let (routed, diagnostics, _, _) = binarize_normalized_with_diagnostics(
                &normalized,
                &raw,
                resolve_binarization_diagnostics(&raw, &options),
                None,
                &options,
                calibration,
                None,
                Some(&text_vicinity),
                None,
            );
            assert_eq!(diagnostics.route, mode);
            assert!(
                routed.get(38, 40),
                "{mode:?} binarizer did not recover the row-aligned faint stroke"
            );
            let rescued = rescue_component_scoped_faint_strokes(
                &damaged,
                &raw,
                None,
                Some(&text_vicinity),
                None,
                mode,
                mode,
                options.dpi,
                false,
            );
            assert!(
                rescued.get(38, 40),
                "{mode:?} did not recover the row-aligned faint stroke"
            );
            assert!(rescued.count_black() > damaged.count_black());
        }
    }

    #[test]
    fn postprocess_exempts_a_raw_supported_horizontal_rule_component() {
        let mut raw = GrayImage::new(420, 120, 220);
        let mut binary = BinaryImage::new(420, 120);
        for y in 58..60 {
            for x in 48..372 {
                raw.set(x, y, 120);
                binary.set(x, y, true);
            }
        }
        // A nearby isolated mark remains eligible for normal despeckling; the
        // rule exemption must not turn the whole page into a pass-through.
        raw.set(12, 12, 210);
        binary.set(12, 12, true);
        let options = CleanupOptions {
            dpi: 300.0,
            despeckle: true,
            despeckle_level: DespeckleLevel::Normal,
            ..CleanupOptions::default()
        };
        let calibration =
            PageCalibration::estimate(&raw, options.dpi, CalibrationConfig::default());
        let (cleaned, _) = postprocess_binary_with_diagnostics_and_raw(
            &binary,
            Some(&raw),
            Some(&raw),
            &options,
            calibration,
        );

        assert!((48..372).all(|x| (58..60).all(|y| cleaned.get(x, y))));
        assert!(
            !cleaned.get(12, 12),
            "ordinary speckle must remain removable"
        );
    }

    #[test]
    fn faint_rescue_rejects_an_isolated_raw_component_without_a_text_row() {
        let mut raw = GrayImage::new(160, 100, 232);
        for y in 45..70 {
            for x in 84..108 {
                raw.set(x, y, 198);
            }
        }
        let damaged = BinaryImage::new(160, 100);
        let rescued = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            None,
            None,
            BinarizationMode::Wolf,
            BinarizationMode::Wolf,
            300.0,
            false,
        );
        assert_eq!(rescued.count_black(), 0);
    }

    #[test]
    fn faint_rescue_skips_a_solid_stroke_component_with_a_full_gray_halo() {
        let mut raw = GrayImage::new(120, 80, 232);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());
        for y in 23..57 {
            for x in 49..56 {
                raw.set(x, y, 170);
                text_vicinity.set(x, y, true);
            }
        }
        for y in 24..56 {
            for x in 50..55 {
                raw.set(x, y, 40);
                damaged.set(x, y, true);
            }
        }

        let rescued = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            BinarizationMode::Otsu,
            BinarizationMode::Otsu,
            300.0,
            true,
        );

        assert_eq!(
            rescued, damaged,
            "a healthy stroke's halo must not become ink"
        );
    }

    #[test]
    fn wolf_rescue_removes_a_gray_halo_only_after_capturing_the_solid_core() {
        let mut raw = GrayImage::new(120, 80, 232);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());
        for y in 23..57 {
            for x in 49..57 {
                raw.set(x, y, 170);
                damaged.set(x, y, true);
                text_vicinity.set(x, y, true);
            }
        }
        for y in 24..56 {
            for x in 50..56 {
                raw.set(x, y, 40);
            }
        }

        let rescued = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            BinarizationMode::Wolf,
            BinarizationMode::Wolf,
            300.0,
            false,
        );

        assert!(rescued.get(52, 40), "the captured dark core must remain");
        assert!(
            !rescued.get(49, 40) && !rescued.get(56, 40),
            "Wolf's gray halo must not remain ink around a captured solid core"
        );
    }

    #[test]
    fn wolf_halo_strip_de_halos_letters_the_halo_itself_fused_into_one_component() {
        // The halo is what welds adjacent letters together, so a fused word is
        // wider than any single glyph. Bounding the component's longest side
        // would skip exactly these and leave them at full Wolf weight beside
        // de-haloed neighbours, which is the stroke-weight unevenness this pass
        // exists to prevent.
        const STEM_PITCH: usize = 11;
        const HALO_WIDTH: usize = 9;
        let mut raw = GrayImage::new(220, 80, 232);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());
        let stems: Vec<usize> = (0..12).map(|i| 40 + i * STEM_PITCH).collect();
        for &stem in &stems {
            for y in 25..55 {
                for x in stem..stem + HALO_WIDTH {
                    raw.set(x, y, 170);
                    damaged.set(x, y, true);
                    text_vicinity.set(x, y, true);
                }
            }
            for y in 26..54 {
                for x in stem + 1..stem + HALO_WIDTH - 1 {
                    raw.set(x, y, 40);
                }
            }
        }
        // Adjacent halos touch across the two-pixel gap, which is how the halo
        // fuses letters on a real page.
        for pair in stems.windows(2) {
            for y in 38..42 {
                for x in pair[0] + HALO_WIDTH..pair[1] {
                    raw.set(x, y, 170);
                    damaged.set(x, y, true);
                    text_vicinity.set(x, y, true);
                }
            }
        }

        let component_extent = stems[stems.len() - 1] + HALO_WIDTH - stems[0];
        assert!(
            component_extent > (300.0f64 / 25.4 * 8.0).round() as usize,
            "the fixture must exceed the additive pass's 8 mm extent cap"
        );

        let stripped = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            BinarizationMode::Wolf,
            BinarizationMode::Wolf,
            300.0,
            false,
        );

        for &stem in &stems {
            assert!(
                stripped.get(stem + 4, 40),
                "the captured dark core of the letter at x={stem} must remain"
            );
            assert!(
                !stripped.get(stem, 40),
                "the gray halo left of the letter at x={stem} must not remain ink"
            );
            assert!(
                !stripped.get(stem + HALO_WIDTH - 1, 40),
                "the gray halo right of the letter at x={stem} must not remain ink"
            );
        }

        // The strip only removes gray that hugs a captured core, so the gray
        // between two letters outlives the halo that surrounded them. That is
        // this pass's remit, not an oversight: gray with no adjacent core is
        // indistinguishable here from a genuine faint hairline or ligature, and
        // deleting it would erase the thin strokes has_coherent_noncore_run
        // exists to protect. On real pages the leftover is reabsorbed into the
        // neighbouring glyphs rather than left standing alone.
        for pair in stems.windows(2) {
            assert!(
                (pair[0] + HALO_WIDTH..pair[1]).all(|x| stripped.get(x, 40)),
                "gray with no adjacent captured core is out of this pass's scope"
            );
        }
    }

    #[test]
    fn wolf_halo_strip_keeps_a_connected_midgray_serif_endpoint() {
        let mut raw = GrayImage::new(120, 90, 232);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());
        for y in 28..62 {
            for x in 54..57 {
                raw.set(x, y, 60);
                damaged.set(x, y, true);
                text_vicinity.set(x, y, true);
            }
        }
        for x in 47..64 {
            raw.set(x, 58, 150);
            damaged.set(x, 58, true);
            text_vicinity.set(x, 58, true);
        }
        for x in 54..57 {
            raw.set(x, 58, 60);
        }

        let stripped = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            BinarizationMode::Wolf,
            BinarizationMode::Wolf,
            300.0,
            false,
        );

        assert!(
            stripped.get(47, 58),
            "the raw-150 serif endpoint was erased"
        );
        assert!(
            stripped.get(63, 58),
            "the raw-150 serif endpoint was erased"
        );
        assert_eq!(
            ComponentMap::from_binary(&stripped).components().len(),
            1,
            "stripping the halo ring disconnected the serif from its dark stem"
        );
    }

    #[test]
    fn wolf_halo_strip_keeps_a_faint_blob_beyond_a_two_pixel_bridge() {
        let mut raw = GrayImage::new(120, 90, 232);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());
        for y in 34..48 {
            for x in 30..42 {
                raw.set(x, y, 60);
                damaged.set(x, y, true);
                text_vicinity.set(x, y, true);
            }
        }
        for x in 42..44 {
            raw.set(x, 41, 150);
            damaged.set(x, 41, true);
            text_vicinity.set(x, 41, true);
        }
        for y in 36..48 {
            for x in 44..54 {
                raw.set(x, y, 150);
                damaged.set(x, y, true);
                text_vicinity.set(x, y, true);
            }
        }

        let stripped = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            BinarizationMode::Wolf,
            BinarizationMode::Wolf,
            300.0,
            false,
        );

        assert!(
            (36..48).all(|y| (44..54).all(|x| stripped.get(x, y))),
            "the bridged raw-150 blob was stripped as if it were a core halo"
        );
        assert_eq!(
            ComponentMap::from_binary(&stripped).components().len(),
            1,
            "the two-pixel bridge must keep the faint blob attached"
        );
    }

    #[test]
    fn faded_photocopy_missing_body_is_deep_relative_to_its_captured_core() {
        let mut raw = GrayImage::new(120, 90, 232);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());
        for y in 28..62 {
            for x in 50..56 {
                raw.set(x, y, 150);
                text_vicinity.set(x, y, true);
            }
            raw.set(52, y, 70);
            damaged.set(52, y, true);
        }

        let rescued = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            BinarizationMode::Otsu,
            BinarizationMode::Otsu,
            300.0,
            true,
        );

        assert!(rescued.get(50, 45), "the raw-150 missing body was skipped");
        assert!(rescued.get(55, 45), "the raw-150 missing body was skipped");
        assert!(rescued.count_black() > damaged.count_black());
    }

    #[test]
    fn dense_auto_otsu_rescues_a_bright_paper_arc_via_structural_depth() {
        let mut raw = GrayImage::new(140, 90, 246);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());

        for y in 36..64 {
            for x in 54..59 {
                raw.set(x, y, 60);
                damaged.set(x, y, true);
                text_vicinity.set(x, y, true);
            }
        }
        for y in 33..38 {
            for x in 58..60 {
                raw.set(x, y, 166);
                text_vicinity.set(x, y, true);
            }
        }
        for y in 31..35 {
            for x in 59..61 {
                raw.set(x, y, 166);
                text_vicinity.set(x, y, true);
            }
        }
        for y in 29..31 {
            for x in 60..71 {
                raw.set(x, y, 166);
                text_vicinity.set(x, y, true);
            }
        }
        for y in 30..42 {
            for x in 69..71 {
                raw.set(x, y, 166);
                text_vicinity.set(x, y, true);
            }
        }

        let rescued = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            BinarizationMode::Auto,
            BinarizationMode::Otsu,
            300.0,
            false,
        );

        assert!(rescued.get(66, 29), "the raw-166 upper arc was skipped");
        assert!(rescued.get(70, 38), "the raw-166 arc return was skipped");
        assert!(rescued.count_black() > damaged.count_black());
        assert_eq!(
            ComponentMap::from_binary(&rescued).components().len(),
            1,
            "the rescued upper arc must connect to the captured dark body"
        );
    }

    #[test]
    fn dense_auto_otsu_solid_glyph_halo_has_zero_structural_depth_and_gains_no_ink() {
        let mut raw = GrayImage::new(120, 80, 246);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());

        for y in 23..57 {
            for x in 49..57 {
                raw.set(x, y, 130 + ((x + y) % 61) as u8);
                text_vicinity.set(x, y, true);
            }
        }
        for y in 24..56 {
            for x in 50..56 {
                raw.set(x, y, 40);
                damaged.set(x, y, true);
                text_vicinity.set(x, y, true);
            }
        }

        let candidates = BinaryImage::from_fn_parallel(raw.width(), raw.height(), |x, y| {
            raw.get(x, y) <= 246 - RESCUE_CANDIDATE_DEPTH
        });
        let components = ComponentMap::from_binary(&candidates);
        let label = components.label_at(50, 24);
        let structural_deep = components
            .components()
            .iter()
            .find(|component| component.label == label)
            .into_iter()
            .flat_map(|component| {
                (component.top..=component.bottom).flat_map(move |y| {
                    (component.left..=component.right).map(move |x| (component, x, y))
                })
            })
            .filter(|&(component, x, y)| {
                components.label_at(x, y) == component.label
                    && !damaged.get(x, y)
                    && is_structural_deep_missing(
                        &components,
                        component.label,
                        &damaged,
                        x,
                        y,
                        raw.get(x, y),
                        246,
                    )
            })
            .count();
        assert_eq!(
            structural_deep, 0,
            "an immediate raw-130..190 halo ring must contain no structural-deep pixels"
        );

        let rescued = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            Some(&text_vicinity),
            None,
            BinarizationMode::Auto,
            BinarizationMode::Otsu,
            300.0,
            false,
        );

        assert_eq!(
            rescued, damaged,
            "the raw-130..190 halo around a healthy dense glyph gained ink"
        );
    }

    #[test]
    fn solid_skip_is_monotonic_from_sixteen_to_seventeen_missing_pixels() {
        fn fixture(missing: usize) -> (GrayImage, BinaryImage, BinaryImage) {
            let mut raw = GrayImage::new(100, 70, 232);
            let mut damaged = BinaryImage::new(raw.width(), raw.height());
            let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());
            for y in 34..36 {
                for x in 30..34 {
                    raw.set(x, y, 40);
                    damaged.set(x, y, true);
                    text_vicinity.set(x, y, true);
                }
            }
            for index in 0..missing {
                let x = 34 + index / 2;
                let y = 34 + index % 2;
                raw.set(x, y, if index == 0 { 120 } else { 170 });
                text_vicinity.set(x, y, true);
            }
            (raw, damaged, text_vicinity)
        }

        let rescued_counts = [16, 17].map(|missing| {
            let (raw, damaged, text_vicinity) = fixture(missing);
            let rescued = rescue_component_scoped_faint_strokes(
                &damaged,
                &raw,
                None,
                Some(&text_vicinity),
                None,
                BinarizationMode::Otsu,
                BinarizationMode::Otsu,
                300.0,
                true,
            );
            assert!(
                rescued.count_black() > damaged.count_black(),
                "the {missing}-pixel missing body was skipped"
            );
            rescued.count_black()
        });

        assert!(
            rescued_counts[1] >= rescued_counts[0],
            "adding a missing body pixel reduced rescue: {rescued_counts:?}"
        );
    }

    #[test]
    fn faint_rescue_keeps_a_pale_captured_skeleton_with_a_deep_missing_body() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/stroke-budget/sol-faint-glyph.json"
        ))
        .unwrap();
        let number = |name: &str| fixture[name].as_u64().unwrap() as usize;
        let mut raw = GrayImage::new(number("width"), number("height"), number("paperGray") as u8);
        let mut damaged = BinaryImage::new(raw.width(), raw.height());
        let mut text_vicinity = BinaryImage::new(raw.width(), raw.height());
        for index in 0..number("comparatorCount") {
            let left = number("comparatorStartX") + index * number("comparatorStrideX");
            for y in number("comparatorTop")..number("comparatorTop") + number("comparatorHeight") {
                for x in left..left + number("comparatorWidth") {
                    raw.set(x, y, number("comparatorGray") as u8);
                    damaged.set(x, y, true);
                    text_vicinity.set(x, y, true);
                }
            }
        }
        for y in number("faintBodyTop")..number("faintBodyTop") + number("faintBodyHeight") {
            for x in number("faintBodyLeft")..number("faintBodyLeft") + number("faintBodyWidth") {
                raw.set(x, y, number("faintBodyGray") as u8);
                text_vicinity.set(x, y, true);
            }
            for x in number("capturedSkeletonLeft")
                ..number("capturedSkeletonLeft") + number("capturedSkeletonWidth")
            {
                damaged.set(x, y, true);
            }
        }
        let dpi = fixture["dpi"].as_f64().unwrap();
        let (budget, offenders) = LineStrokeBudget::from_binary(&damaged, dpi).unwrap();
        assert!(offenders.is_empty());
        let faint_base_map = ComponentMap::from_binary(&damaged);
        let body_center_y = number("faintBodyTop") + number("faintBodyHeight") / 2;
        let faint_label = faint_base_map.label_at(number("capturedSkeletonLeft"), body_center_y);
        let faint_base_width = component_ridge_width(&damaged, &faint_base_map, faint_label);
        let local_budget = budget
            .local_budget_at(
                number("capturedSkeletonLeft") as f64 + 0.5,
                body_center_y as f64,
            )
            .unwrap();
        assert!(faint_base_width < local_budget.median_width_px);

        for mode in [BinarizationMode::Otsu, BinarizationMode::Wolf] {
            let rescued = rescue_component_scoped_faint_strokes(
                &damaged,
                &raw,
                None,
                Some(&text_vicinity),
                None,
                mode,
                mode,
                dpi,
                true,
            );

            assert!(
                rescued.get(number("faintBodyLeft"), body_center_y),
                "{mode:?} lost the deep body"
            );
            assert!(
                rescued.get(
                    number("faintBodyLeft") + number("faintBodyWidth") - 1,
                    body_center_y
                ),
                "{mode:?} lost the deep body"
            );
            assert_eq!(
                rescued.count_black() - damaged.count_black(),
                number("expectedRescuedPixels"),
                "{mode:?} did not preserve the complete source-supported body"
            );
        }
    }

    #[test]
    fn row_evidence_exclusion_prevents_a_scanner_rail_from_supporting_specks() {
        let mut raw = GrayImage::new(160, 100, 232);
        let mut rail = BinaryImage::new(160, 100);
        for y in 0..raw.height() {
            for x in 0..8 {
                raw.set(x, y, 80);
                rail.set(x, y, true);
            }
        }
        for y in 48..52 {
            for x in 84..86 {
                raw.set(x, y, 198);
            }
        }
        let damaged = BinaryImage::new(raw.width(), raw.height());
        let rescued_with_rail = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            None,
            None,
            BinarizationMode::Wolf,
            BinarizationMode::Wolf,
            300.0,
            false,
        );
        let rescued_without_rail = rescue_component_scoped_faint_strokes(
            &damaged,
            &raw,
            None,
            None,
            Some(&rail),
            BinarizationMode::Wolf,
            BinarizationMode::Wolf,
            300.0,
            false,
        );

        assert!(
            rescued_with_rail.get(84, 49),
            "the fixture must prove that the unmasked rail supplies row evidence",
        );
        assert_eq!(rescued_without_rail.count_black(), 0);
    }

    #[test]
    fn legacy_calibration_keeps_single_window_thresholding() {
        let mut image = GrayImage::new(61, 43, 232);
        for y in 7..36 {
            for x in (8..53).step_by(9) {
                image.set(x, y, 105 + (x % 4) as u8);
            }
        }
        let options = CleanupOptions {
            dpi: 300.0,
            binarization: BinarizationMode::Wolf,
            ..CleanupOptions::default()
        };
        let calibration =
            PageCalibration::estimate(&image, options.dpi, CalibrationConfig::legacy());
        let method = LocalThreshold::Wolf {
            k: WOLF_K,
            deviation_floor: 2.0,
            minimum_percentile: WOLF_MINIMUM_PERCENTILE,
            hard_ink: WOLF_HARD_INK,
            hard_paper: WOLF_HARD_PAPER,
        };
        let expected =
            threshold_local_biased(&image, calibration.threshold_radius(options.dpi), method, 0);

        assert_eq!(
            threshold_with_mode(
                &image,
                &image,
                None,
                &options,
                BinarizationMode::Wolf,
                calibration,
                None,
            ),
            expected
        );
    }

    #[test]
    #[ignore = "manual release-mode timing for the A3 report"]
    fn benchmark_multiscale_wolf_against_single_window_bw_route() {
        use std::time::Instant;

        let mut image = GrayImage::new(1_275, 1_650, 238);
        for y in 0..image.height() {
            for x in 0..image.width() {
                image.set(x, y, 232 + ((x * 7 + y * 11 + x * y % 17) % 13) as u8);
            }
        }
        for top in (35..1_610).step_by(24) {
            for left in (30..1_235).step_by(19) {
                for y in top..top + 14 {
                    for x in left..left + 8 {
                        if x < left + 2 || y < top + 2 || y >= top + 12 {
                            image.set(x, y, 82 + ((x + y) % 9) as u8);
                        }
                    }
                }
            }
        }
        let options = CleanupOptions {
            binarization: BinarizationMode::Wolf,
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };
        let multiscale = CalibrationConfig::default();
        let single_window = CalibrationConfig {
            multiscale_local_threshold: false,
            ..CalibrationConfig::default()
        };

        let _ = clean_black_and_white_with_calibration_config(&image, &options, single_window);
        let _ = clean_black_and_white_with_calibration_config(&image, &options, multiscale);
        let mut single_samples = Vec::new();
        let mut multiscale_samples = Vec::new();
        for _ in 0..3 {
            let started = Instant::now();
            let single = std::hint::black_box(clean_black_and_white_with_calibration_config(
                &image,
                &options,
                single_window,
            ));
            single_samples.push(started.elapsed());

            let started = Instant::now();
            let multiple = std::hint::black_box(clean_black_and_white_with_calibration_config(
                &image, &options, multiscale,
            ));
            multiscale_samples.push(started.elapsed());
            assert_eq!(single.binary.width(), multiple.binary.width());
            assert_eq!(single.binary.height(), multiple.binary.height());
        }
        single_samples.sort_unstable();
        multiscale_samples.sort_unstable();
        let single = single_samples[1];
        let multiscale = multiscale_samples[1];
        let ratio = multiscale.as_secs_f64() / single.as_secs_f64();
        eprintln!(
            "A3 Wolf BW route 1275x1650: single={single:?} multiscale={multiscale:?} ratio={ratio:.3}x"
        );
        assert!(ratio <= 1.5, "multiscale BW route ratio was {ratio:.3}x");
    }

    #[test]
    fn router_uses_page_features_instead_of_a_single_contrast_statistic() {
        assert_eq!(
            choose_mode(100.0, 4.0, 0.12, 3.0, 0.01, 0.98),
            BinarizationMode::Otsu
        );
        assert_eq!(
            choose_mode(18.0, 2.0, 0.10, 2.0, 0.0, 0.99),
            BinarizationMode::Otsu,
            "sparse clean pages have low percentile contrast but strong agreement"
        );
        assert_eq!(
            choose_mode(100.0, 18.0, 0.12, 3.0, 0.01, 0.90),
            BinarizationMode::Sauvola
        );
        assert_eq!(
            choose_mode(100.0, 4.0, 0.12, 3.0, 0.12, 0.98),
            BinarizationMode::Wolf
        );
        assert_eq!(
            choose_mode(100.0, 18.0, 0.30, 12.0, 0.01, 0.90),
            BinarizationMode::Wolf
        );
        assert_eq!(
            choose_mode(67.0, 0.5, 0.17, 15.0, 0.064, 0.976),
            BinarizationMode::Otsu,
            "dense text on uniform tinted paper must not be thickened by a local route"
        );
    }

    #[test]
    fn uniform_paper_threshold_is_anchored_at_the_paper_ink_midpoint() {
        for (paper, ink) in [(221u8, 42u8), (218, 46), (192, 28), (112, 8)] {
            let mut image = GrayImage::new(240, 180, paper);
            for y in 20..160 {
                for x in (18..220).step_by(12) {
                    image.set(x, y, ink);
                    image.set(x + 1, y, ((u16::from(ink) + u16::from(paper)) / 2) as u8);
                }
            }
            let threshold = paper_ink_midpoint_threshold(&image, None).threshold;
            let expected = ((u16::from(ink) + u16::from(paper)) / 2) as i16;
            assert!(
                (i16::from(threshold) - expected).abs() <= 2,
                "paper={paper}, ink={ink}, threshold={threshold}, expected={expected}"
            );
        }
    }

    #[test]
    fn full_leaf_intensity_anchor_is_scale_stable_with_picture_exclusion() {
        let mut small = GrayImage::new(240, 180, 248);
        let mut small_picture = BinaryImage::new(240, 180);
        for y in 18..162 {
            for x in (16..168).step_by(14) {
                small.set(x, y, 6);
                small.set(x + 1, y, 72);
            }
        }
        for y in 30..150 {
            for x in 176..228 {
                small.set(x, y, 118 + ((x + y) % 32) as u8);
                small_picture.set(x, y, true);
            }
        }
        let mut large = GrayImage::new(480, 360, 255);
        let mut large_picture = BinaryImage::new(480, 360);
        for y in 0..large.height() {
            for x in 0..large.width() {
                large.set(x, y, small.get(x / 2, y / 2));
                large_picture.set(x, y, small_picture.get(x / 2, y / 2));
            }
        }

        let small_anchor = full_leaf_intensity_anchor(&small, Some(&small_picture), 150.0);
        let large_anchor = full_leaf_intensity_anchor(&large, Some(&large_picture), 300.0);

        assert_eq!(small_anchor, 127);
        assert_eq!(large_anchor, 127);
        assert!(
            (i16::from(small_anchor) - i16::from(large_anchor)).abs() <= 1,
            "full-leaf anchor drifted across scale: {small_anchor} vs {large_anchor}",
        );
        assert!(
            small_anchor < 150,
            "anchor was measured after destructive downscaling"
        );
    }

    #[test]
    fn router_diagnostics_are_finite_and_bounded() {
        let mut image = GrayImage::new(160, 120, 238);
        for y in 18..102 {
            for x in (14..146).step_by(16) {
                for stroke_x in x..(x + 3) {
                    image.set(stroke_x, y, 42 + (y / 8) as u8);
                }
            }
        }
        let diagnostics = resolve_binarization_diagnostics(&image, &CleanupOptions::default());
        for value in [
            diagnostics.robust_contrast,
            diagnostics.illumination_deviation,
            diagnostics.edge_density,
            diagnostics.estimated_stroke_width_px,
            diagnostics.dark_border_coverage,
            diagnostics.otsu_adaptive_agreement,
        ] {
            assert!(value.is_finite());
            assert!(value >= 0.0);
        }
        assert!(diagnostics.edge_density <= 1.0);
        assert!(diagnostics.dark_border_coverage <= 1.0);
        assert!(diagnostics.otsu_adaptive_agreement <= 1.0);
    }

    #[test]
    fn stroke_width_diagnostic_matches_for_exact_integer_upscale() {
        let mut canonical = GrayImage::new(256, 192, 242);
        for y in 18..174 {
            for x in (16..240).step_by(14) {
                for stroke_x in x..x + 3 {
                    canonical.set(stroke_x, y, 46 + (y % 24) as u8);
                }
            }
        }
        let mut full_resolution = GrayImage::new(1_024, 768, 255);
        for y in 0..full_resolution.height() {
            for x in 0..full_resolution.width() {
                full_resolution.set(x, y, canonical.get(x / 4, y / 4));
            }
        }
        let options = CleanupOptions::default();
        let canonical_diagnostics = resolve_binarization_diagnostics(&canonical, &options);
        let full_resolution_diagnostics =
            resolve_binarization_diagnostics(&full_resolution, &options);

        assert_eq!(
            full_resolution_diagnostics.estimated_stroke_width_px,
            canonical_diagnostics.estimated_stroke_width_px,
            "stroke width must stay in bounded routing-sample pixels",
        );
        assert_eq!(
            canonical_diagnostics.dark_border_coverage,
            full_resolution_diagnostics.dark_border_coverage
        );
    }

    #[test]
    fn wide_strokes_reject_sauvola_at_bounded_and_large_scale() {
        let mut bounded = GrayImage::new(256, 192, 220);
        for y in 0..bounded.height() {
            let paper = 160 + (y * 64 / bounded.height()) as u8;
            for x in 0..bounded.width() {
                bounded.set(x, y, paper);
            }
            for x in (16..bounded.width().saturating_sub(16)).step_by(28) {
                for stroke_x in x..(x + 12).min(bounded.width()) {
                    bounded.set(stroke_x, y, 42);
                }
            }
        }
        let mut large = GrayImage::new(1_024, 768, 255);
        for y in 0..large.height() {
            for x in 0..large.width() {
                large.set(x, y, bounded.get(x / 4, y / 4));
            }
        }
        let options = CleanupOptions::default();

        for source in [&bounded, &large] {
            let diagnostics = resolve_binarization_diagnostics(source, &options);
            assert!(
                diagnostics.illumination_deviation > 12.0,
                "fixture must reach the uneven-light routing arm: {diagnostics:?}"
            );
            assert!(
                diagnostics.estimated_stroke_width_px > 8.0,
                "fixture must exercise the Sauvola stroke-width rejection: {diagnostics:?}"
            );
            assert_eq!(diagnostics.route, BinarizationMode::Wolf, "{diagnostics:?}");
        }
    }

    #[test]
    fn uneven_illumination_reaches_sauvola_through_the_full_bw_route() {
        // This is deliberately larger than the bounded 256-pixel routing
        // sample. With the old full-input rescaling, the sampled 3-pixel
        // strokes become >8 pixels and this exact end-to-end route falls back
        // to Wolf; in sample units it remains a Sauvola candidate.
        let mut source = GrayImage::new(2_048, 1_536, 220);
        for y in 0..source.height() {
            let paper = 160 + (y * 64 / source.height()) as u8;
            for x in 0..source.width() {
                source.set(x, y, paper);
            }
            for x in (96..source.width().saturating_sub(96)).step_by(96) {
                for stroke_x in x..x + 24 {
                    for stroke_y in y.saturating_sub(2)..=(y + 2).min(source.height() - 1) {
                        source.set(stroke_x, stroke_y, 42);
                    }
                }
            }
        }
        let options = CleanupOptions {
            dpi: 150.0,
            normalize_illumination: false,
            despeckle: false,
            ..CleanupOptions::default()
        };

        let result = clean_black_and_white(&source, &options);
        let diagnostics = resolve_binarization_diagnostics(
            &smooth_for_binarization(&result.normalized, options.dpi),
            &options,
        );

        assert!(
            diagnostics.illumination_deviation > 12.0,
            "fixture must exercise the uneven-illumination arm: {diagnostics:?}"
        );
        assert_eq!(result.mode, BinarizationMode::Sauvola, "{diagnostics:?}");
        assert_eq!(diagnostics.route, BinarizationMode::Sauvola);
        assert!(
            result.binary.count_black() > 0,
            "Sauvola fixture lost all ink"
        );
    }

    #[test]
    fn zero_stroke_width_remains_a_valid_sauvola_route_at_any_scale() {
        for (width, height) in [(320, 240), (1_280, 960)] {
            let mut source = GrayImage::new(width, height, 0);
            for y in 0..height {
                // The broad dark field produces only >32-pixel Otsu runs
                // (the estimator's intentional degenerate 0.0 result), while
                // the clean bright band keeps Otsu and local agreement high.
                let paper = if y < height * 3 / 4 { 40 } else { 220 };
                for x in 0..width {
                    source.set(x, y, paper);
                }
            }
            let options = CleanupOptions {
                dpi: 150.0,
                normalize_illumination: false,
                despeckle: false,
                ..CleanupOptions::default()
            };
            let diagnostics = resolve_binarization_diagnostics(
                &smooth_for_binarization(&source, options.dpi),
                &options,
            );

            assert_eq!(
                diagnostics.estimated_stroke_width_px, 0.0,
                "large dark runs must produce the degenerate zero estimate: {diagnostics:?}"
            );
            assert!(
                diagnostics.illumination_deviation > 12.0,
                "fixture must exercise the uneven-illumination arm: {diagnostics:?}"
            );
            assert_eq!(
                diagnostics.route,
                BinarizationMode::Sauvola,
                "{diagnostics:?}"
            );
        }
    }

    #[test]
    fn canonical_cell_edge_routes_are_carried_across_working_dpi() {
        let clean_working = GrayImage::new(96, 96, 244);
        let mut dirty_working = clean_working.clone();
        for y in 0..dirty_working.height() {
            for x in 0..dirty_working.width() {
                if x < 18 || x + 18 >= dirty_working.width() || (x + y) % 3 == 0 {
                    dirty_working.set(x, y, 24);
                }
            }
        }
        let mut route_by_dpi = Vec::new();
        for (dpi, working) in [(299.0, &clean_working), (300.0, &dirty_working)] {
            let options = CleanupOptions {
                dpi,
                normalize_illumination: false,
                despeckle: false,
                ..CleanupOptions::default()
            };
            route_by_dpi.push(resolve_binarization_diagnostics(working, &options).route);
        }
        assert_ne!(
            route_by_dpi[0], route_by_dpi[1],
            "the mutation control must disagree when routing bypasses canonical evidence"
        );

        for cells in 380..=383 {
            let coverage = cells as f64 / 4_752.0;
            let expected = choose_mode(128.0, 0.704, 0.384, 2.0, coverage, 0.985);
            let canonical = BinarizationDiagnostics {
                route: expected,
                robust_contrast: 128.0,
                illumination_deviation: 0.704,
                edge_density: 0.384,
                estimated_stroke_width_px: 2.0,
                dark_border_coverage: coverage,
                otsu_adaptive_agreement: 0.985,
                spread_plan: None,
            };
            let mut rendered_routes = Vec::new();
            for (dpi, working) in [(299.0, &clean_working), (300.0, &dirty_working)] {
                let options = CleanupOptions {
                    dpi,
                    normalize_illumination: false,
                    despeckle: false,
                    ..CleanupOptions::default()
                };
                let calibration =
                    PageCalibration::estimate(working, dpi, CalibrationConfig::default());
                let (_, diagnostics, _, _) = binarize_normalized_with_diagnostics(
                    working,
                    working,
                    canonical,
                    None,
                    &options,
                    calibration,
                    None,
                    None,
                    None,
                );
                rendered_routes.push(diagnostics.route);
            }
            assert_eq!(rendered_routes, [expected, expected], "cells={cells}");
        }
    }

    #[test]
    fn router_limits_flat_lit_otsu_override_to_the_calibrated_border_band() {
        for coverage in [0.099_455_611_390_284_76, 0.110_240_963_855_421_69] {
            assert_eq!(
                choose_mode(127.0, 1.0, 0.48, 19.0, coverage, 0.98),
                BinarizationMode::Otsu,
                "flat-lit canonical victim at {coverage:.6} must retain Otsu"
            );
        }
        assert_eq!(
            choose_mode(39.0, 0.0, 0.077, 4.69, 0.098_686_371_100_164_2, 0.9833),
            BinarizationMode::Wolf,
            "the nearest tracked true-Wolf fixture must remain below the band"
        );
        assert_eq!(
            choose_mode(131.0, 1.05, 0.468, 12.7, 0.110_552_763_819_095_48, 0.982),
            BinarizationMode::Wolf,
            "the next dark book leaf must remain above the band"
        );
    }

    #[test]
    fn attachment_graph_preserves_diacritic_but_removes_equal_sized_far_blob() {
        let mut image = BinaryImage::new(80, 45);
        for y in 20..28 {
            for x in 15..28 {
                image.set(x, y, true);
            }
        }
        for y in 15..18 {
            for x in 18..21 {
                image.set(x, y, true);
            }
        }
        for y in 4..7 {
            for x in 55..58 {
                image.set(x, y, true);
            }
        }
        for &(x, y) in &[(2, 2), (70, 38), (45, 22)] {
            image.set(x, y, true);
        }
        let cleaned = despeckle_connected(&image, 300.0);
        let calibration =
            PageCalibration::estimate_from_binary(&image, 300.0, CalibrationConfig::default());
        let graph_disabled = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Normal,
            false,
        )
        .image;
        assert!(
            cleaned.get(18, 15),
            "nearby diacritic must remain through attachment graph"
        );
        assert!(
            !graph_disabled.get(18, 15),
            "fixture must prove the attachment graph is load-bearing"
        );
        assert!(
            !cleaned.get(55, 4),
            "equal-sized isolated blob must be removed"
        );
        assert!(!cleaned.get(2, 2));
        assert!(!cleaned.get(70, 38));
    }

    #[test]
    fn grayscale_contrast_demotes_deletion_to_cautious_attachment() {
        let mut image = BinaryImage::new(70, 40);
        for y in 18..28 {
            for x in 10..20 {
                image.set(x, y, true);
            }
        }
        for y in 21..23 {
            for x in 35..37 {
                image.set(x, y, true);
            }
        }
        let mut normalized = GrayImage::new(70, 40, 235);
        for y in 0..image.height() {
            for x in 0..image.width() {
                if image.get(x, y) {
                    normalized.set(x, y, 25);
                }
            }
        }
        let calibration =
            PageCalibration::estimate_from_binary(&image, 300.0, CalibrationConfig::default());
        let binary_only = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Normal,
            true,
        )
        .image;
        let contrast_aware = despeckle_connected_impl(
            &image,
            Some(&normalized),
            300.0,
            calibration,
            DespeckleLevel::Normal,
            true,
        )
        .image;
        assert!(!binary_only.get(35, 21));
        assert!(contrast_aware.get(35, 21));
    }

    #[test]
    fn despeckle_fallback_preserves_pages_without_a_substantial_seed() {
        let mut image = BinaryImage::new(120, 80);
        for index in 0..20 {
            let left = 4 + (index % 10) * 11;
            let top = 5 + (index / 10) * 30;
            let width = 2 + index % 3;
            let height = 2 + (index / 3) % 3;
            for y in top..top + height {
                for x in left..left + width {
                    image.set(x, y, true);
                }
            }
        }
        let calibration =
            PageCalibration::estimate_from_binary(&image, 300.0, CalibrationConfig::default());
        let outcome = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Normal,
            true,
        );
        assert!(outcome.fallback);
        assert!(black_count(&outcome.image) > 0);
    }

    #[test]
    fn pencil_only_page_survives_top_decile_fallback_anchors() {
        let mut image = BinaryImage::new(140, 90);
        for row in 0..3 {
            for column in 0..12 {
                let left = 6 + column * 11;
                let top = 8 + row * 25;
                for offset in 0..7 {
                    image.set(left + offset, top + offset, true);
                }
            }
        }
        let calibration =
            PageCalibration::estimate_from_binary(&image, 300.0, CalibrationConfig::default());
        let outcome = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Normal,
            true,
        );
        assert!(outcome.fallback);
        assert_eq!(outcome.image, image);
    }

    #[test]
    fn normal_despeckle_caps_transitive_noise_chains_at_three_hops() {
        let mut image = BinaryImage::new(90, 50);
        for y in 20..28 {
            for x in 5..13 {
                image.set(x, y, true);
            }
        }
        for left in [25, 39, 53, 67] {
            for y in 23..25 {
                for x in left..left + 2 {
                    image.set(x, y, true);
                }
            }
        }
        let cleaned = despeckle_connected(&image, 300.0);
        assert!(cleaned.get(25, 23), "directly attached mark must remain");
        assert!(cleaned.get(39, 23), "the second hop must remain");
        assert!(cleaned.get(53, 23), "the third hop must remain");
        assert!(
            !cleaned.get(67, 23),
            "a speck chain must not propagate arbitrarily far"
        );
    }

    #[test]
    fn aggressive_level_removes_more_pepper_than_normal_without_erasing_page() {
        let mut image = BinaryImage::new(100, 55);
        for y in 20..32 {
            for x in 8..20 {
                image.set(x, y, true);
            }
        }
        for &(left, top) in &[(31, 22), (46, 23), (63, 21), (82, 40)] {
            for y in top..top + 2 {
                for x in left..left + 2 {
                    image.set(x, y, true);
                }
            }
        }
        let calibration =
            PageCalibration::estimate_from_binary(&image, 300.0, CalibrationConfig::default());
        let normal = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Normal,
            true,
        )
        .image;
        let aggressive = despeckle_connected_impl(
            &image,
            None,
            300.0,
            calibration,
            DespeckleLevel::Aggressive,
            true,
        )
        .image;
        assert!(black_count(&normal) > black_count(&aggressive));
        assert!(black_count(&aggressive) > 0);
    }

    #[test]
    fn cautious_despeckle_protects_bracketed_line_punctuation_only() {
        let mut image = BinaryImage::new(90, 50);
        for left in [10, 60] {
            for y in 20..28 {
                for x in left..left + 8 {
                    image.set(x, y, true);
                }
            }
        }
        for y in 23..25 {
            for x in 40..42 {
                image.set(x, y, true);
            }
        }
        for y in 3..5 {
            for x in 40..42 {
                image.set(x, y, true);
            }
        }
        let cleaned = despeckle_connected(&image, 300.0);
        assert!(cleaned.get(40, 23), "bracketed punctuation must remain");
        assert!(!cleaned.get(40, 3), "unsupported dust must be removed");
    }

    #[test]
    fn corpus_glyph_goldens_preserve_niqqud_and_arabic_dots() {
        let cases = [
            (
                "BHS p126 Hebrew niqqud",
                binary_fixture(include_bytes!(
                    "../tests/fixtures/glyphs/hebrew-bhs-p126-niqqud-input.png"
                )),
                300.0,
                &[(380, 44), (676, 29), (763, 29), (928, 43), (971, 225)][..],
                3,
            ),
            (
                "Wright p82 Arabic dots",
                binary_fixture(include_bytes!(
                    "../tests/fixtures/glyphs/arabic-wright-p82-dots-input.png"
                )),
                150.0,
                &[(189, 75), (457, 75), (757, 216), (634, 248), (1246, 74)][..],
                5,
            ),
        ];
        for (name, source, dpi, protected_points, radius) in cases {
            let despeckled = despeckle_connected(&source, dpi);
            assert_eq!(
                resolve_smooth_profile(&despeckled, dpi),
                SmoothProfile::TopologySafe,
                "{name} must exercise the topology-safe LUT"
            );
            let cleaned = smooth_edges_for_page(&despeckled, dpi);
            for &point in protected_points {
                assert!(
                    has_ink_near(&source, point, radius),
                    "bad {name} annotation"
                );
                assert!(
                    has_ink_near(&cleaned, point, radius),
                    "{name} lost protected mark near {point:?}"
                );
            }
            let retention = black_count(&cleaned) as f64 / black_count(&source).max(1) as f64;
            assert!(
                retention >= 0.985,
                "{name} retained only {:.2}% of ink",
                retention * 100.0
            );
        }
    }

    #[test]
    fn niqqud_page_is_untouched_when_rescue_stays_within_budget() {
        let raw = crate::png::decode_gray(
            include_bytes!("../tests/fixtures/glyphs/hebrew-bhs-p126-niqqud-input.png"),
            1_000_000,
            2_000,
        )
        .unwrap();
        let options = CleanupOptions {
            dpi: 300.0,
            normalize_illumination: true,
            ..CleanupOptions::default()
        };
        let normalized = normalize_illumination(&raw, options.dpi);
        let calibration =
            PageCalibration::estimate(&normalized, options.dpi, CalibrationConfig::default());
        let threshold_input = smooth_for_binarization(&normalized, options.dpi);
        let mode = resolve_binarization_diagnostics(&threshold_input, &options).route;
        let thresholded = threshold_with_mode(
            &threshold_input,
            &normalized,
            None,
            &options,
            mode,
            calibration,
            None,
        );
        let mut expected_interventions = LineStrokeBudgetInterventions::default();
        let expected = postprocess_binary_with_raw_budgeted(
            &thresholded,
            Some(&normalized),
            Some(&raw),
            &options,
            calibration,
            None,
            &mut expected_interventions,
        );
        let expected = rescue_component_scoped_faint_strokes_budgeted(
            &expected,
            &raw,
            None,
            None,
            None,
            options.binarization,
            mode,
            options.dpi,
            false,
            None,
            &mut expected_interventions,
        );

        let (_, expected_offenders) = LineStrokeBudget::from_binary(&expected, options.dpi)
            .expect("niqqud fixture must have eligible lines");
        assert!(expected_offenders.is_empty());
        let (actual, _, actual_interventions) = finish_thresholded_with_line_budget(
            &thresholded,
            &normalized,
            &raw,
            &options,
            calibration,
            None,
            None,
            options.binarization,
            mode,
            false,
            None,
        );

        assert_binary_eq(&actual, &expected);
        assert_eq!(actual_interventions.source_components_normalized, 0);
        assert_eq!(actual_interventions.rescue_components_capped, 0);
        assert_eq!(actual_interventions.rescue_pixels_suppressed, 0);
    }

    #[test]
    fn supersampled_thin_strokes_use_final_raster_calibration() {
        let mut binary = BinaryImage::new(1_200, 400);
        for y in 40..80 {
            for x in 40..80 {
                binary.set(x, y, true);
            }
        }
        let mut protected_endpoints = Vec::new();
        for column in 0..12 {
            let left = 650 + column * 35;
            let top = 120;
            protected_endpoints.push((left, top));
            for y in top..top + 20 {
                for x in left..left + 2 {
                    binary.set(x, y, true);
                }
                for x in left + 10..left + 12 {
                    binary.set(x, y, true);
                }
            }
            for y in top + 18..top + 20 {
                for x in left..left + 12 {
                    binary.set(x, y, true);
                }
            }
        }
        let normalized = binary_to_gray(&binary);
        let analysis_calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 18.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let options = CleanupOptions {
            dpi: 1_200.0,
            despeckle: true,
            despeckle_level: DespeckleLevel::Normal,
            ..CleanupOptions::default()
        };

        let (cleaned, fallback) = postprocess_binary_with_diagnostics_and_raw(
            &binary,
            Some(&normalized),
            Some(&normalized),
            &options,
            analysis_calibration,
        );

        assert!(!fallback);
        for endpoint in protected_endpoints {
            assert!(
                cleaned.get(endpoint.0, endpoint.1),
                "supersampled two-pixel stroke endpoint was erased at {endpoint:?}"
            );
        }
        let retention = black_count(&cleaned) as f64 / black_count(&binary) as f64;
        assert!(
            retention >= 0.99,
            "supersampled thin-stroke retention was only {retention:.4}"
        );
    }

    #[test]
    fn bedjan_corpus_golden_still_removes_isolated_speckles() {
        let source = binary_fixture(include_bytes!(
            "../tests/fixtures/glyphs/bedjan-p2-speckles-input.png"
        ));
        let cleaned = despeckle_connected(&source, 150.0);
        let before_tiny = tiny_component_count(&source, 7);
        let after_tiny = tiny_component_count(&cleaned, 7);
        assert!(
            before_tiny >= 5,
            "Bedjan fixture needs a real speckle load, found {before_tiny}"
        );
        assert!(
            after_tiny * 2 <= before_tiny,
            "Bedjan tiny components were not reduced enough: {before_tiny} -> {after_tiny}"
        );
        let retention = black_count(&cleaned) as f64 / black_count(&source).max(1) as f64;
        assert!(
            retention >= 0.97,
            "Bedjan text ink retention was {retention:.4}"
        );
    }

    #[test]
    fn edge_smoothing_fills_dents_and_trims_isolated_bumps() {
        let mut image = BinaryImage::new(7, 7);
        for y in 2..5 {
            for x in 2..5 {
                image.set(x, y, true);
            }
        }
        image.set(3, 3, false);
        image.set(5, 5, true);
        let smoothed = smooth_edges(&image);
        assert!(smoothed.get(3, 3), "one-pixel dent must be filled");
        assert!(!smoothed.get(5, 5), "one-pixel bump must be trimmed");
    }

    #[test]
    fn page_edge_smoothing_allows_sparse_dent_repair_over_eight_percent() {
        let mut image = BinaryImage::new(96, 96);
        for y in 16..80 {
            for x in 20..33 {
                image.set(x, y, true);
            }
            if y % 2 == 0 {
                image.set(20, y, false);
                image.set(32, y, false);
            }
        }
        assert_eq!(resolve_smooth_profile(&image, 300.0), SmoothProfile::Legacy);

        let legacy = smooth_edges_with_profile(&image, SmoothProfile::Legacy);
        assert_eq!(legacy.count_black() - image.count_black(), 62);
        assert_eq!(binary_edge_length(&image), 278);
        assert!(!smoothing_exceeds_edge_growth_limit(&image, &legacy));

        assert_eq!(smooth_edges_for_page(&image, 300.0), legacy);
    }

    #[test]
    fn page_edge_smoothing_still_rejects_legacy_dilation_from_about_five_to_seven_pixels() {
        let mut image = BinaryImage::new(96, 96);
        for y in 16..80 {
            let (left, right) = if y % 2 == 0 { (30, 37) } else { (31, 36) };
            for x in left..right {
                image.set(x, y, true);
            }
        }

        let legacy = smooth_edges_with_profile(&image, SmoothProfile::Legacy);
        assert_eq!(legacy.count_black() - image.count_black(), 62);
        assert_eq!(binary_edge_length(&image), 266);
        assert_eq!((30..37).filter(|&x| image.get(x, 17)).count(), 5);
        assert_eq!((30..37).filter(|&x| legacy.get(x, 17)).count(), 7);
        assert!(smoothing_exceeds_edge_growth_limit(&image, &legacy));

        let guarded = smooth_edges_for_page(&image, 300.0);
        assert!(guarded.count_black() < legacy.count_black());
    }

    #[test]
    fn page_edge_smoothing_passes_through_neutral_legacy_result() {
        let mut image = BinaryImage::new(48, 48);
        for y in 12..36 {
            for x in 12..36 {
                image.set(x, y, true);
            }
        }
        assert_eq!(resolve_smooth_profile(&image, 300.0), SmoothProfile::Legacy);

        let legacy = smooth_edges_with_profile(&image, SmoothProfile::Legacy);
        assert_eq!(legacy, image);
        assert_eq!(smooth_edges_for_page(&image, 300.0), legacy);
    }

    #[test]
    fn topology_lut_exhaustively_preserves_local_components() {
        let lut = topology_smooth_lut();
        let mut changed_patterns = 0usize;
        for pattern in 0u16..512 {
            let center = pattern & (1 << 4) != 0;
            let actual = lut[pattern as usize];
            assert_eq!(actual, topology_checked_center(pattern));
            assert!(actual == center || actual == legacy_center_decision(pattern));
            if actual != center {
                changed_patterns += 1;
                let changed = if actual {
                    pattern | (1 << 4)
                } else {
                    pattern & !(1 << 4)
                };
                assert_eq!(
                    neighborhood_component_count(pattern, true, true),
                    neighborhood_component_count(changed, true, true),
                    "ink topology changed for {pattern:09b}"
                );
                assert_eq!(
                    neighborhood_component_count(pattern, false, false),
                    neighborhood_component_count(changed, false, false),
                    "paper topology changed for {pattern:09b}"
                );
            }
            if center && (pattern & !(1 << 4)).count_ones() <= 1 {
                assert!(
                    actual,
                    "isolated marks and endpoints must survive {pattern:09b}"
                );
            }
            assert_eq!(actual, lut[rotate_pattern_clockwise(pattern) as usize]);
        }
        assert!(
            changed_patterns > 0,
            "topology profile must retain useful smoothing"
        );
        assert!(lut[16], "an isolated punctuation pixel must survive");
        assert!(lut[48], "a one-neighbor stroke endpoint must survive");
        assert!(lut[47], "a topology-safe boundary dent should be filled");
    }

    fn rotate_pattern_clockwise(pattern: u16) -> u16 {
        let mut rotated = 0u16;
        for y in 0..3 {
            for x in 0..3 {
                if pattern & (1 << (y * 3 + x)) != 0 {
                    rotated |= 1 << (x * 3 + (2 - y));
                }
            }
        }
        rotated
    }

    #[test]
    fn edge_smoothing_uses_topology_profile_for_fragile_strokes_at_every_dpi() {
        let mut image = BinaryImage::new(11, 9);
        for y in 2..7 {
            for x in 2..5 {
                image.set(x, y, true);
            }
        }
        image.set(8, 6, true);
        assert_eq!(estimated_stroke_width(&image), 3.0);
        assert!(
            smooth_edges_for_page(&image, 300.0).get(8, 6),
            "topology profile must retain isolated punctuation"
        );
        assert!(
            smooth_edges_for_page(&image, 72.0).get(8, 6),
            "low-DPI punctuation must not fall back to destructive legacy smoothing"
        );
    }
}
