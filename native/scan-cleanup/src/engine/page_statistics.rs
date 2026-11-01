//! Robust page-level statistics used by reconciliation.
use crate::engine::resource_planning::PageDescriptor;
use crate::engine::staged_input::map_raster_error;
use crate::ink_consistency::{
    minority_selection_mask, stroke_mass_metrics, DocumentInkPrior, DocumentInkSample,
    PageInkConsistencyContext,
};
use crate::io::raster;
use crate::split::LayoutClassification;
use crate::OutputMode;
use evb_native_support::NativeError;

pub(crate) fn trusted_selection_is_incomplete(
    selection_width: usize,
    background_width: usize,
) -> bool {
    background_width.saturating_mul(2) > selection_width
}

pub(crate) fn page_needs_ink_sample(page: &PageDescriptor) -> bool {
    page.trusted_foreground_mask_path.is_some()
        && page.trusted_mrc_background_path.is_some()
        && page.options.output_mode == OutputMode::Bw
        && page.options.source_has_bilevel_layer
        && page.options.thickness == 0
}

pub(crate) fn derive_page_ink_sample(
    page: &PageDescriptor,
) -> Result<Option<DocumentInkSample>, NativeError> {
    if !ink_sample_eligible(
        page.options.output_mode,
        page.options.source_has_bilevel_layer,
        page.options.thickness,
    ) {
        return Ok(None);
    }
    let Some(selection_path) = page.trusted_foreground_mask_path.as_ref() else {
        return Ok(None);
    };
    let Some(background_path) = page.trusted_mrc_background_path.as_ref() else {
        return Ok(None);
    };
    let selection = raster::read_foreground_selection(
        selection_path,
        page.options.max_pixels,
        page.options.max_dimension,
    )
    .map_err(|error| map_raster_error(error, selection_path, page.source_page_index))?;
    let (background_width, _) = raster::read_dimensions(
        background_path,
        page.options.max_pixels,
        page.options.max_dimension,
    )
    .map_err(|error| map_raster_error(error, background_path, page.source_page_index))?;
    Ok(ink_sample_of(&selection, background_width))
}

/// Whether a page's producer-authored foreground can join the document's ink
/// prior: a bilevel source cleaned to black and white at its own weight.
pub(crate) fn ink_sample_eligible(
    output_mode: OutputMode,
    source_has_bilevel_layer: bool,
    thickness: i8,
) -> bool {
    output_mode == OutputMode::Bw && source_has_bilevel_layer && thickness == 0
}

/// One page's ink sample from its trusted foreground selection, unless the
/// selection is incomplete or carries no body text.
pub(crate) fn ink_sample_of(
    selection: &scan_primitives::GrayImage,
    background_width: usize,
) -> Option<DocumentInkSample> {
    if trusted_selection_is_incomplete(selection.width(), background_width) {
        return None;
    }
    let ink = minority_selection_mask(selection)?;
    let metrics = stroke_mass_metrics(&ink)?;
    Some(DocumentInkSample {
        metrics,
        width: ink.width(),
        height: ink.height(),
    })
}

pub(crate) fn derive_page_ink_contexts(
    samples: &[Option<DocumentInkSample>],
) -> Vec<Option<PageInkConsistencyContext>> {
    let Some(prior) = DocumentInkPrior::from_page_samples(samples.iter().flatten().copied()) else {
        return vec![None; samples.len()];
    };
    samples
        .iter()
        .map(|source_sample| {
            source_sample.map(|source_sample| PageInkConsistencyContext {
                prior,
                source_sample,
            })
        })
        .collect()
}

pub(crate) fn dimensions_within_tolerance(left: usize, right: usize) -> bool {
    left.abs_diff(right) as f64 / left.max(right).max(1) as f64 <= 0.02
}
pub(crate) fn classification_bucket(classification: LayoutClassification) -> usize {
    match classification {
        LayoutClassification::SingleUncutPage => 0,
        LayoutClassification::PageWithOffcut => 1,
        LayoutClassification::TwoPageSpread => 2,
    }
}
pub(crate) fn bucket_classification(bucket: usize) -> LayoutClassification {
    match bucket {
        0 => LayoutClassification::SingleUncutPage,
        1 => LayoutClassification::PageWithOffcut,
        _ => LayoutClassification::TwoPageSpread,
    }
}
/// Returns the median of an ascending-sorted slice.
pub(crate) fn median(values: &[f64]) -> Option<f64> {
    match values.len() {
        0 => None,
        length if length % 2 == 1 => Some(values[length / 2]),
        length => Some((values[length / 2 - 1] + values[length / 2]) * 0.5),
    }
}
pub(crate) fn robust_typographic_median(values: impl Iterator<Item = f64>) -> Option<f64> {
    let mut values = values
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect::<Vec<_>>();
    if values.len() < 3 {
        return None;
    }
    values.sort_by(f64::total_cmp);
    median(&values)
}
pub(crate) fn ramp_local(value: f64, low: f64, high: f64) -> f64 {
    ((value - low) / (high - low)).clamp(0.0, 1.0)
}
#[cfg(test)]
mod tests {
    use super::{derive_page_ink_contexts, median, ramp_local, robust_typographic_median};

    #[test]
    fn robust_statistics_keep_only_finite_positive_samples() {
        assert_eq!(median(&[1.0, 3.0, 5.0]), Some(3.0));
        assert_eq!(median(&[1.0, 3.0, 5.0, 7.0]), Some(4.0));
        assert_eq!(
            robust_typographic_median([f64::NAN, -1.0, 2.0, 4.0, 8.0].into_iter()),
            Some(4.0)
        );
        assert_eq!(ramp_local(0.01, 0.03, 0.12), 0.0);
        assert_eq!(ramp_local(0.20, 0.03, 0.12), 1.0);
    }

    #[test]
    fn empty_ink_samples_produce_no_contexts() {
        assert_eq!(derive_page_ink_contexts(&[None, None]), vec![None, None]);
    }
}
