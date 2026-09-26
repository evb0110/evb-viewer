use scan_primitives::{
    morphology::{dilate, erode},
    BinaryImage, ComponentMap, GrayImage,
};
use serde::{Deserialize, Serialize};

const DENSE_TEXT_INK_FRACTION_MIN: f64 = 0.15;
const DENSE_TEXT_INK_FRACTION_MAX: f64 = 0.185;
const MINIMUM_PRIOR_PAGES: usize = 12;
const MAXIMUM_ADDED_INK_FRACTION: f64 = 0.25;
const MINIMUM_RAW_EDGE_DEPTH: u8 = 12;
// Per-component survival deltas slightly over-predict the page result because
// the final 3x3 erosion sees neighboring components at once. Corpus sampling
// measured a 1.0–1.7 point difference, so stop the projection above the
// document target while retaining the exact final measurement in metadata.
const PROJECTED_SURVIVAL_SAFETY_MARGIN: f64 = 0.018;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrokeMassMetrics {
    pub ink_fraction: f64,
    pub erosion_survival: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DocumentInkPrior {
    pub sample_count: usize,
    pub survival_p10: f64,
    pub survival_median: f64,
    pub survival_p90: f64,
    pub reference_width: usize,
    pub reference_height: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DocumentInkSample {
    pub metrics: StrokeMassMetrics,
    pub width: usize,
    pub height: usize,
}

/// Batch-owned runtime evidence for applying one document prior to a specific
/// producer-authored mask. The source sample keeps dense-text eligibility in
/// the uncropped mask coordinate system; crop geometry must not change whether
/// a page belongs to the document's body-text population.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageInkConsistencyContext {
    pub prior: DocumentInkPrior,
    pub source_sample: DocumentInkSample,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct InkConsistencyDiagnostics {
    pub prior_sample_count: usize,
    pub prior_survival_median: f64,
    pub survival_before: f64,
    pub survival_after: f64,
    pub added_ink_pixels: usize,
    pub applied: bool,
}

pub fn stroke_mass_metrics(binary: &BinaryImage) -> Option<StrokeMassMetrics> {
    let pixels = binary.width().checked_mul(binary.height())?;
    let ink = binary.count_black();
    if pixels == 0 || ink == 0 {
        return None;
    }
    let surviving = erode(binary, 1, 1).count_black();
    Some(StrokeMassMetrics {
        ink_fraction: ink as f64 / pixels as f64,
        erosion_survival: surviving as f64 / ink as f64,
    })
}

/// Producer soft masks use both polarities. The selected ink is the minority
/// class; exact ties are ambiguous without the flattened source and therefore
/// cannot contribute to a document prior.
pub fn minority_selection_mask(selection: &GrayImage) -> Option<BinaryImage> {
    let high = selection
        .data()
        .iter()
        .filter(|&&sample| sample >= 128)
        .count();
    let low = selection.data().len().saturating_sub(high);
    if high == low {
        return None;
    }
    let high_is_ink = high < low;
    Some(BinaryImage::from_fn_parallel(
        selection.width(),
        selection.height(),
        |x, y| (selection.get(x, y) >= 128) == high_is_ink,
    ))
}

impl DocumentInkPrior {
    pub fn from_page_metrics(metrics: impl IntoIterator<Item = StrokeMassMetrics>) -> Option<Self> {
        Self::from_page_samples(metrics.into_iter().map(|metrics| DocumentInkSample {
            metrics,
            width: 1,
            height: 1,
        }))
    }

    pub fn from_page_samples(samples: impl IntoIterator<Item = DocumentInkSample>) -> Option<Self> {
        let mut eligible = samples
            .into_iter()
            .filter(|sample| {
                (DENSE_TEXT_INK_FRACTION_MIN..=DENSE_TEXT_INK_FRACTION_MAX)
                    .contains(&sample.metrics.ink_fraction)
                    && sample.metrics.erosion_survival.is_finite()
                    && (0.0..=1.0).contains(&sample.metrics.erosion_survival)
                    && sample.width > 0
                    && sample.height > 0
            })
            .collect::<Vec<_>>();
        if eligible.len() < MINIMUM_PRIOR_PAGES {
            return None;
        }
        let mut survival = eligible
            .iter()
            .map(|sample| sample.metrics.erosion_survival)
            .collect::<Vec<_>>();
        survival.sort_by(f64::total_cmp);
        eligible.sort_by_key(|sample| sample.width);
        let reference_width = eligible[eligible.len() / 2].width;
        eligible.sort_by_key(|sample| sample.height);
        let reference_height = eligible[eligible.len() / 2].height;
        Some(Self {
            sample_count: survival.len(),
            survival_p10: quantile(&survival, 0.10),
            survival_median: quantile(&survival, 0.50),
            survival_p90: quantile(&survival, 0.90),
            reference_width,
            reference_height,
        })
    }

    fn target_survival(self, width: usize, height: usize) -> f64 {
        let scale_x = width as f64 / self.reference_width.max(1) as f64;
        let scale_y = height as f64 / self.reference_height.max(1) as f64;
        let scale = ((scale_x + scale_y) * 0.5).clamp(0.5, 4.0);
        (1.0 - (1.0 - self.survival_median) / scale).clamp(0.0, 1.0)
    }
}

fn quantile(sorted: &[f64], fraction: f64) -> f64 {
    debug_assert!(!sorted.is_empty());
    let position = (sorted.len() - 1) as f64 * fraction;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower as f64)
}

#[derive(Clone, Copy)]
struct GrowthCandidate {
    x: u32,
    y: u32,
    owner: u32,
}

/// Raises unusually thin producer-authored text toward the document median
/// without deleting ink, filling glyph counters, or joining components.
///
/// The source mask remains authoritative: growth is limited to its exterior
/// one-pixel boundary and requires independent dark-tone evidence from the
/// flattened source. Explicit thickness controls are gated by the caller.
/// This is intentionally a trusted-mask mechanism: it does not constrain or
/// lock binarization routes on pages that need a fresh gray-to-binary decision.
/// The Rome fixture's dense body pages use authored masks and therefore bypass
/// those thresholds entirely; document-level route-flapping policy remains a
/// separate limitation for freshly binarized documents.
pub fn stabilize_trusted_stroke_mass(
    binary: &BinaryImage,
    raw: &GrayImage,
    protected: Option<&BinaryImage>,
    context: PageInkConsistencyContext,
    full_render_width: usize,
    full_render_height: usize,
    dpi: f64,
) -> (BinaryImage, InkConsistencyDiagnostics) {
    debug_assert_eq!(
        (binary.width(), binary.height()),
        (raw.width(), raw.height())
    );
    debug_assert!(protected
        .is_none_or(|mask| { (mask.width(), mask.height()) == (binary.width(), binary.height()) }));
    let Some(before) = stroke_mass_metrics(binary) else {
        return (binary.clone(), InkConsistencyDiagnostics::default());
    };
    let target_survival = context
        .prior
        .target_survival(full_render_width, full_render_height);
    let mut diagnostics = InkConsistencyDiagnostics {
        prior_sample_count: context.prior.sample_count,
        prior_survival_median: target_survival,
        survival_before: before.erosion_survival,
        survival_after: before.erosion_survival,
        ..InkConsistencyDiagnostics::default()
    };
    if !(DENSE_TEXT_INK_FRACTION_MIN..=DENSE_TEXT_INK_FRACTION_MAX)
        .contains(&context.source_sample.metrics.ink_fraction)
        || before.erosion_survival >= target_survival
    {
        return (binary.clone(), diagnostics);
    }

    let components = ComponentMap::from_binary(binary);
    let exterior = exterior_white_components(binary);
    let boundary = dilate(binary, 1, 1).subtract(binary);
    let paper = page_paper_reference(raw);
    let darkest_allowed = paper.saturating_sub(MINIMUM_RAW_EDGE_DEPTH);
    let mut candidates = vec![Vec::<GrowthCandidate>::new(); components.components().len() + 1];
    for y in 0..binary.height() {
        for x in 0..binary.width() {
            if !boundary.get(x, y)
                || !exterior.get(x, y)
                || protected.is_some_and(|mask| mask.get(x, y))
            {
                continue;
            }
            let tone = raw.get(x, y);
            if tone > darkest_allowed {
                continue;
            }
            let Some(owner) = unique_neighbor_owner(&components, x, y) else {
                continue;
            };
            candidates[owner as usize].push(GrowthCandidate {
                x: x as u32,
                y: y as u32,
                owner,
            });
        }
    }
    let maximum_additions =
        ((binary.count_black() as f64 * MAXIMUM_ADDED_INK_FRACTION).round() as usize).max(1);
    let (stabilized, added) = apply_component_growth(
        binary,
        &components,
        &candidates,
        before,
        target_survival,
        maximum_additions,
        dpi,
    );
    let after = stroke_mass_metrics(&stabilized).unwrap_or(before);
    diagnostics.survival_after = after.erosion_survival;
    diagnostics.added_ink_pixels = added;
    diagnostics.applied = added > 0;
    (stabilized, diagnostics)
}

fn exterior_white_components(binary: &BinaryImage) -> BinaryImage {
    let mut exterior = BinaryImage::new(binary.width(), binary.height());
    let mut stack = Vec::new();
    let push_paper =
        |x: usize, y: usize, exterior: &mut BinaryImage, stack: &mut Vec<(usize, usize)>| {
            if !binary.get(x, y) && !exterior.get(x, y) {
                exterior.set(x, y, true);
                stack.push((x, y));
            }
        };
    if binary.width() == 0 || binary.height() == 0 {
        return exterior;
    }
    for x in 0..binary.width() {
        push_paper(x, 0, &mut exterior, &mut stack);
        push_paper(x, binary.height() - 1, &mut exterior, &mut stack);
    }
    for y in 0..binary.height() {
        push_paper(0, y, &mut exterior, &mut stack);
        push_paper(binary.width() - 1, y, &mut exterior, &mut stack);
    }
    while let Some((x, y)) = stack.pop() {
        if x > 0 {
            push_paper(x - 1, y, &mut exterior, &mut stack);
        }
        if x + 1 < binary.width() {
            push_paper(x + 1, y, &mut exterior, &mut stack);
        }
        if y > 0 {
            push_paper(x, y - 1, &mut exterior, &mut stack);
        }
        if y + 1 < binary.height() {
            push_paper(x, y + 1, &mut exterior, &mut stack);
        }
    }
    exterior
}

fn unique_neighbor_owner(components: &ComponentMap, x: usize, y: usize) -> Option<u32> {
    let mut owner = 0u32;
    let left = x.saturating_sub(1);
    let right = x
        .saturating_add(1)
        .min(components.width().saturating_sub(1));
    let top = y.saturating_sub(1);
    let bottom = y
        .saturating_add(1)
        .min(components.height().saturating_sub(1));
    for sample_y in top..=bottom {
        for sample_x in left..=right {
            let label = components.label_at(sample_x, sample_y);
            if label == 0 {
                continue;
            }
            if owner != 0 && owner != label {
                return None;
            }
            owner = label;
        }
    }
    (owner != 0).then_some(owner)
}

struct ComponentGrowth<'a> {
    component_index: usize,
    survival: f64,
    candidates: &'a [GrowthCandidate],
}

#[allow(clippy::too_many_arguments)]
fn apply_component_growth(
    binary: &BinaryImage,
    components: &ComponentMap,
    candidates: &[Vec<GrowthCandidate>],
    before: StrokeMassMetrics,
    target_survival: f64,
    maximum_additions: usize,
    dpi: f64,
) -> (BinaryImage, usize) {
    let eroded = erode(binary, 1, 1);
    let mut surviving_by_component = vec![0usize; components.components().len() + 1];
    for y in 0..binary.height() {
        for x in 0..binary.width() {
            if eroded.get(x, y) {
                surviving_by_component[components.label_at(x, y) as usize] += 1;
            }
        }
    }
    let maximum_extent = (dpi.max(1.0) * 8.0 / 25.4).round().max(8.0) as usize;
    let mut growth = components
        .components()
        .iter()
        .enumerate()
        .filter_map(|(index, component)| {
            let width = component.right - component.left + 1;
            let height = component.bottom - component.top + 1;
            if component.area < 4
                || width.max(height) > maximum_extent
                || width.max(height) > width.min(height).max(1) * 10
            {
                return None;
            }
            let additions = candidates.get(component.label as usize)?.as_slice();
            if additions.is_empty() {
                return None;
            }
            let old_surviving = surviving_by_component[component.label as usize];
            let old_survival = old_surviving as f64 / component.area as f64;
            if old_survival >= target_survival {
                return None;
            }
            let new_surviving = component_survival_after_growth(components, component, additions);
            let added_survival = new_surviving.saturating_sub(old_surviving);
            if added_survival * component.area <= additions.len() * old_surviving {
                return None;
            }
            Some(ComponentGrowth {
                component_index: index,
                survival: old_survival,
                candidates: additions,
            })
        })
        .collect::<Vec<_>>();
    growth.sort_by(|left, right| {
        left.survival
            .total_cmp(&right.survival)
            .then(left.component_index.cmp(&right.component_index))
    });

    let mut output = binary.clone();
    let mut added_owner = vec![0u32; binary.width().saturating_mul(binary.height())];
    let mut added = 0usize;
    let mut projected_ink = binary.count_black();
    let mut projected_surviving = (before.erosion_survival * projected_ink as f64).round() as usize;
    let projected_target = (target_survival + PROJECTED_SURVIVAL_SAFETY_MARGIN).clamp(0.0, 1.0);
    for group in growth {
        if projected_surviving as f64 / projected_ink as f64 >= projected_target {
            break;
        }
        let conflicts = group.candidates.iter().any(|candidate| {
            let x = candidate.x as usize;
            let y = candidate.y as usize;
            let left = x.saturating_sub(1);
            let right = x.saturating_add(1).min(binary.width().saturating_sub(1));
            let top = y.saturating_sub(1);
            let bottom = y.saturating_add(1).min(binary.height().saturating_sub(1));
            (top..=bottom).any(|sample_y| {
                (left..=right).any(|sample_x| {
                    let original_owner = components.label_at(sample_x, sample_y);
                    let grown_owner = added_owner[sample_y * binary.width() + sample_x];
                    original_owner != 0 && original_owner != candidate.owner
                        || grown_owner != 0 && grown_owner != candidate.owner
                })
            })
        });
        if conflicts {
            continue;
        }
        let component = &components.components()[group.component_index];
        let old_surviving = surviving_by_component[component.label as usize];
        let mut accepted = Vec::with_capacity(group.candidates.len());
        for candidate in group.candidates {
            if added.saturating_add(accepted.len()) >= maximum_additions {
                break;
            }
            let x = candidate.x as usize;
            let y = candidate.y as usize;
            if !addition_preserves_topology(&output, x, y) {
                continue;
            }
            output.set(x, y, true);
            added_owner[y * binary.width() + x] = candidate.owner;
            accepted.push(*candidate);
        }
        if accepted.is_empty() {
            continue;
        }
        let new_surviving = component_survival_after_growth(components, component, &accepted);
        let added_survival = new_surviving.saturating_sub(old_surviving);
        if added_survival * component.area <= accepted.len() * old_surviving {
            for candidate in accepted {
                let x = candidate.x as usize;
                let y = candidate.y as usize;
                output.set(x, y, false);
                added_owner[y * binary.width() + x] = 0;
            }
            continue;
        }
        added += accepted.len();
        projected_ink += accepted.len();
        projected_surviving += added_survival;
    }
    (output, added)
}

/// Adding an 8-connected foreground point is topology-preserving when the
/// surrounding 4-connected paper remains one local component. Rechecking
/// after every accepted point matters: individually harmless additions can
/// otherwise cooperate to close the aperture of a Cyrillic glyph.
fn addition_preserves_topology(binary: &BinaryImage, x: usize, y: usize) -> bool {
    debug_assert!(!binary.get(x, y));
    let left = x.saturating_sub(1);
    let right = x.saturating_add(1).min(binary.width().saturating_sub(1));
    let top = y.saturating_sub(1);
    let bottom = y.saturating_add(1).min(binary.height().saturating_sub(1));
    let local_width = right - left + 1;
    let local_height = bottom - top + 1;
    let center_x = x - left;
    let center_y = y - top;
    let paper = BinaryImage::from_fn_parallel(local_width, local_height, |sample_x, sample_y| {
        !(binary.get(left + sample_x, top + sample_y)
            || sample_x == center_x && sample_y == center_y)
    });
    let mut visited = [false; 9];
    let mut components = 0usize;
    for start_y in 0..local_height {
        for start_x in 0..local_width {
            let start = start_y * 3 + start_x;
            if !paper.get(start_x, start_y) || visited[start] {
                continue;
            }
            components += 1;
            if components > 1 {
                return false;
            }
            let mut stack = vec![(start_x, start_y)];
            visited[start] = true;
            while let Some((sample_x, sample_y)) = stack.pop() {
                let neighbors = [
                    sample_x.checked_sub(1).map(|next| (next, sample_y)),
                    (sample_x + 1 < local_width).then_some((sample_x + 1, sample_y)),
                    sample_y.checked_sub(1).map(|next| (sample_x, next)),
                    (sample_y + 1 < local_height).then_some((sample_x, sample_y + 1)),
                ];
                for (next_x, next_y) in neighbors.into_iter().flatten() {
                    let next = next_y * 3 + next_x;
                    if paper.get(next_x, next_y) && !visited[next] {
                        visited[next] = true;
                        stack.push((next_x, next_y));
                    }
                }
            }
        }
    }
    components == 1
}

fn component_survival_after_growth(
    components: &ComponentMap,
    component: &scan_primitives::Component,
    additions: &[GrowthCandidate],
) -> usize {
    let left = component.left.saturating_sub(1);
    let top = component.top.saturating_sub(1);
    let right = component
        .right
        .saturating_add(1)
        .min(components.width().saturating_sub(1));
    let bottom = component
        .bottom
        .saturating_add(1)
        .min(components.height().saturating_sub(1));
    let mut local = BinaryImage::new(right - left + 1, bottom - top + 1);
    for y in component.top..=component.bottom {
        for x in component.left..=component.right {
            if components.label_at(x, y) == component.label {
                local.set(x - left, y - top, true);
            }
        }
    }
    for candidate in additions {
        local.set(
            candidate.x as usize - left,
            candidate.y as usize - top,
            true,
        );
    }
    erode(&local, 1, 1).count_black()
}

fn page_paper_reference(image: &GrayImage) -> u8 {
    let mut histogram = [0usize; 256];
    for &sample in image.data() {
        histogram[usize::from(sample)] += 1;
    }
    let target = image.data().len().saturating_sub(1) * 3 / 4;
    let mut cumulative = 0usize;
    histogram
        .iter()
        .position(|frequency| {
            cumulative += frequency;
            cumulative > target
        })
        .unwrap_or(255) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glyph_page(glyph_width: usize) -> (BinaryImage, GrayImage) {
        let mut binary = BinaryImage::new(240, 200);
        for row in 0..10 {
            for column in 0..18 {
                let left = 5 + column * 13;
                let top = 10 + row * 18;
                for y in top..top + 10 {
                    for x in left..left + glyph_width {
                        binary.set(x, y, true);
                    }
                }
            }
        }
        let fringe = dilate(&binary, 1, 1);
        let mut raw = GrayImage::new(binary.width(), binary.height(), 250);
        for y in 0..raw.height() {
            for x in 0..raw.width() {
                if fringe.get(x, y) {
                    raw.set(x, y, if binary.get(x, y) { 32 } else { 180 });
                }
            }
        }
        (binary, raw)
    }

    fn enclosed_paper_components(binary: &BinaryImage) -> usize {
        ComponentMap::from_binary(&binary.invert())
            .components()
            .iter()
            .filter(|component| {
                component.left > 0
                    && component.top > 0
                    && component.right + 1 < binary.width()
                    && component.bottom + 1 < binary.height()
            })
            .count()
    }

    fn page_context(
        prior: DocumentInkPrior,
        source_sample: DocumentInkSample,
    ) -> PageInkConsistencyContext {
        PageInkConsistencyContext {
            prior,
            source_sample,
        }
    }

    #[test]
    fn prior_uses_dense_text_pages_and_robust_quantiles() {
        let metrics = (0..20).map(|index| StrokeMassMetrics {
            ink_fraction: 0.16,
            erosion_survival: 0.48 + index as f64 * 0.002,
        });
        let prior = DocumentInkPrior::from_page_metrics(metrics).unwrap();
        assert_eq!(prior.sample_count, 20);
        assert!((prior.survival_median - 0.499).abs() < 1e-12);
        assert!((prior.survival_p90 - prior.survival_p10) < 0.032);
    }

    #[test]
    fn document_prior_normalizes_both_source_mask_polarities() {
        let mut selection = GrayImage::new(30, 20, 0);
        for y in 5..15 {
            for x in 4..12 {
                selection.set(x, y, 255);
            }
        }
        let mut opposite = selection.clone();
        for sample in opposite.data_mut() {
            *sample = 255 - *sample;
        }
        let ink = minority_selection_mask(&selection).unwrap();
        let inverted = minority_selection_mask(&opposite).unwrap();
        assert_eq!(ink, inverted);
        assert_eq!(ink.count_black(), 80);
    }

    #[test]
    fn trusted_growth_adds_raw_supported_ink_without_merging_components() {
        let (thin, raw) = glyph_page(4);
        let component_count = ComponentMap::from_binary(&thin).components().len();
        let before = stroke_mass_metrics(&thin).unwrap();
        let prior = DocumentInkPrior {
            sample_count: 208,
            survival_p10: 0.486,
            survival_median: 0.515,
            survival_p90: 0.539,
            reference_width: thin.width(),
            reference_height: thin.height(),
        };
        let source_sample = DocumentInkSample {
            metrics: before,
            width: thin.width(),
            height: thin.height(),
        };
        let (stabilized, diagnostics) = stabilize_trusted_stroke_mass(
            &thin,
            &raw,
            None,
            page_context(prior, source_sample),
            thin.width(),
            thin.height(),
            360.0,
        );
        assert!(diagnostics.applied);
        assert!(stabilized.count_black() > thin.count_black());
        assert_eq!(thin.subtract(&stabilized).count_black(), 0);
        assert_eq!(
            ComponentMap::from_binary(&stabilized).components().len(),
            component_count,
        );
        assert!(
            stroke_mass_metrics(&stabilized).unwrap().erosion_survival > before.erosion_survival
        );
    }

    #[test]
    fn growth_preserves_enclosed_glyph_counters_and_picture_ownership() {
        let mut ring = BinaryImage::new(60, 60);
        for y in 15..45 {
            for x in 15..45 {
                if !(21..39).contains(&x) || !(21..39).contains(&y) {
                    ring.set(x, y, true);
                }
            }
        }
        let mut raw = GrayImage::new(60, 60, 250);
        for y in 0..60 {
            for x in 0..60 {
                if dilate(&ring, 1, 1).get(x, y) {
                    raw.set(x, y, 80);
                }
            }
        }
        let mut protected = BinaryImage::new(60, 60);
        for y in 14..46 {
            protected.set(14, y, true);
        }
        let prior = DocumentInkPrior {
            sample_count: 20,
            survival_p10: 0.7,
            survival_median: 0.8,
            survival_p90: 0.9,
            reference_width: ring.width(),
            reference_height: ring.height(),
        };
        let source_sample = DocumentInkSample {
            metrics: stroke_mass_metrics(&ring).unwrap(),
            width: ring.width(),
            height: ring.height(),
        };
        let (stabilized, _) = stabilize_trusted_stroke_mass(
            &ring,
            &raw,
            Some(&protected),
            page_context(prior, source_sample),
            ring.width(),
            ring.height(),
            360.0,
        );
        assert!(!stabilized.get(30, 30));
        assert!(!stabilized.get(14, 30));
    }

    #[test]
    fn growth_does_not_close_open_glyph_apertures_into_new_counters() {
        let mut page = BinaryImage::new(240, 200);
        for row in 0..7 {
            for column in 0..18 {
                let left = 5 + column * 13;
                let top = 10 + row * 25;
                for y in top..top + 12 {
                    for x in left..left + 9 {
                        let border = x < left + 2 || x >= left + 7 || y < top + 2 || y >= top + 10;
                        let aperture = x >= left + 7 && y == top + 6;
                        if border && !aperture {
                            page.set(x, y, true);
                        }
                    }
                }
            }
        }
        let fringe = dilate(&page, 1, 1);
        let mut raw = GrayImage::new(page.width(), page.height(), 250);
        for y in 0..raw.height() {
            for x in 0..raw.width() {
                if fringe.get(x, y) {
                    raw.set(x, y, 80);
                }
            }
        }
        let prior = DocumentInkPrior {
            sample_count: 20,
            survival_p10: 0.7,
            survival_median: 0.8,
            survival_p90: 0.9,
            reference_width: page.width(),
            reference_height: page.height(),
        };
        let counters_before = enclosed_paper_components(&page);
        let source_sample = DocumentInkSample {
            metrics: stroke_mass_metrics(&page).unwrap(),
            width: page.width(),
            height: page.height(),
        };
        let (stabilized, diagnostics) = stabilize_trusted_stroke_mass(
            &page,
            &raw,
            None,
            page_context(prior, source_sample),
            page.width(),
            page.height(),
            360.0,
        );
        assert!(diagnostics.applied);
        assert_eq!(page.subtract(&stabilized).count_black(), 0);
        assert_eq!(enclosed_paper_components(&stabilized), counters_before);
    }

    #[test]
    fn crop_geometry_does_not_change_dense_eligibility_or_lower_the_target() {
        // Five-pixel glyphs occupy 18.75% of this cropped raster, just above
        // the dense-source band. The uncropped producer mask remains the
        // authority for classification, while the full render grid (not this
        // crop) determines the true raster scale.
        let (cropped, raw) = glyph_page(5);
        let prior = DocumentInkPrior {
            sample_count: 208,
            survival_p10: 0.486,
            survival_median: 0.515,
            survival_p90: 0.539,
            reference_width: cropped.width(),
            reference_height: cropped.height(),
        };
        let source_sample = DocumentInkSample {
            metrics: StrokeMassMetrics {
                ink_fraction: 0.16,
                erosion_survival: 0.48,
            },
            width: cropped.width(),
            height: cropped.height(),
        };
        let (stabilized, diagnostics) = stabilize_trusted_stroke_mass(
            &cropped,
            &raw,
            None,
            page_context(prior, source_sample),
            cropped.width(),
            cropped.height(),
            360.0,
        );
        assert!(diagnostics.applied);
        assert!((diagnostics.prior_survival_median - prior.survival_median).abs() < 1e-12);
        assert_eq!(cropped.subtract(&stabilized).count_black(), 0);
    }

    #[test]
    fn sparse_source_sample_is_not_promoted_by_a_dense_render_crop() {
        let (cropped, raw) = glyph_page(4);
        let prior = DocumentInkPrior {
            sample_count: 208,
            survival_p10: 0.486,
            survival_median: 0.515,
            survival_p90: 0.539,
            reference_width: cropped.width(),
            reference_height: cropped.height(),
        };
        let source_sample = DocumentInkSample {
            metrics: StrokeMassMetrics {
                ink_fraction: 0.05,
                erosion_survival: 0.40,
            },
            width: cropped.width(),
            height: cropped.height(),
        };
        let (stabilized, diagnostics) = stabilize_trusted_stroke_mass(
            &cropped,
            &raw,
            None,
            page_context(prior, source_sample),
            cropped.width(),
            cropped.height(),
            360.0,
        );
        assert!(!diagnostics.applied);
        assert_eq!(stabilized, cropped);
    }
}
