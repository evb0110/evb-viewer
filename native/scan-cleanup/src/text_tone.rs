use crate::content::border_artifact_mask;
use rayon::prelude::*;
use scan_primitives::{BinaryImage, ComponentMap, GrayImage};
use serde::{Deserialize, Serialize};

const MINIMUM_TEXT_LINES: usize = 6;
const OUTSIDE_MIDTONE_LIMIT: f64 = 0.02;
const OUTSIDE_MIDTONE_COHERENT_MINIMUM_EXTENT: f64 = 0.04;
const MIDTONE_LOW: u8 = 60;
const MIDTONE_HIGH: u8 = 245;
// Rasterizer antialiasing and JPEG/scanner noise routinely span 6–10 levels in
// an otherwise flat paper tile. Treating that as tone made the exact same page
// acquire or lose entire evidence tiles across render resolutions. A retained
// tonal tile must have a meaningful two-sided distribution, not just noise.
const LOCAL_TONAL_ROBUST_RANGE: u8 = 16;
const LOCAL_TONAL_TWO_SIDED_RANGE: u8 = 4;
const DARK_INK_ANCHOR: u8 = 90;
const TARGET_INK_ANCHOR: f64 = 60.0;
const WHITE_ANCHOR: f64 = 250.0;
const MINIMUM_RELIABLE_INK_SEPARATION: u8 = 24;
const FALLBACK_INK_MINIMUM_FRACTION: f64 = 0.001;
const FALLBACK_INK_MAXIMUM_FRACTION: f64 = 0.18;
const FALLBACK_PAPER_MINIMUM: u8 = 235;
const FALLBACK_INK_SEPARATION: u8 = 24;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct OutsideTonalEvidence {
    pub fraction: f64,
    pub largest_component_fraction: f64,
    pub largest_component_width_fraction: f64,
    pub largest_component_height_fraction: f64,
}

impl OutsideTonalEvidence {
    pub(crate) fn coherent(self) -> bool {
        self.fraction >= OUTSIDE_MIDTONE_LIMIT
            && self.largest_component_width_fraction >= OUTSIDE_MIDTONE_COHERENT_MINIMUM_EXTENT
            && self.largest_component_height_fraction >= OUTSIDE_MIDTONE_COHERENT_MINIMUM_EXTENT
    }

    pub(crate) fn vetoes_destructive_mode(self) -> bool {
        // A destructive veto must have the same two-dimensional coherence
        // required to call tone semantic. A weaker "distributed mass" or
        // "almost coherent" path promotes mirrored bleed-through, scanner
        // streaks, and repeated paper defects to protected content. Bounded
        // flat graphics and photographs have independent semantic owners.
        self.coherent()
    }
}

#[cfg(test)]
pub(crate) fn outside_tonal_evidence(
    normalized: &GrayImage,
    text_vicinity_mask: &BinaryImage,
) -> OutsideTonalEvidence {
    outside_tonal_evidence_with_mask(normalized, text_vicinity_mask).0
}

pub(crate) fn outside_tonal_evidence_with_mask(
    normalized: &GrayImage,
    text_vicinity_mask: &BinaryImage,
) -> (OutsideTonalEvidence, BinaryImage) {
    outside_tonal_evidence_excluding(normalized, text_vicinity_mask, None)
}

fn outside_tonal_evidence_excluding(
    normalized: &GrayImage,
    text_vicinity_mask: &BinaryImage,
    protected_tone_mask: Option<&BinaryImage>,
) -> (OutsideTonalEvidence, BinaryImage) {
    debug_assert_eq!(
        (normalized.width(), normalized.height()),
        (text_vicinity_mask.width(), text_vicinity_mask.height()),
    );
    if let Some(mask) = protected_tone_mask {
        debug_assert_eq!(
            (normalized.width(), normalized.height()),
            (mask.width(), mask.height()),
        );
    }
    let border_artifacts = border_artifact_mask(normalized);
    let page_pixels = normalized
        .width()
        .saturating_mul(normalized.height())
        .max(1);
    let mut outside_midtone_mask = BinaryImage::new(normalized.width(), normalized.height());
    let tile_edge = (normalized.width().min(normalized.height()) / 64).clamp(6, 24);
    for top in (0..normalized.height()).step_by(tile_edge) {
        for left in (0..normalized.width()).step_by(tile_edge) {
            let bottom = (top + tile_edge).min(normalized.height());
            let right = (left + tile_edge).min(normalized.width());
            let mut histogram = [0usize; 256];
            let mut sample_count = 0usize;
            for y in top..bottom {
                for x in left..right {
                    if !text_vicinity_mask.get(x, y)
                        && !border_artifacts.get(x, y)
                        && !protected_tone_mask.is_some_and(|mask| mask.get(x, y))
                    {
                        histogram[normalized.get(x, y) as usize] += 1;
                        sample_count += 1;
                    }
                }
            }
            let tile_pixels = (right - left).saturating_mul(bottom - top);
            if sample_count < tile_pixels.div_ceil(4) {
                continue;
            }
            let low = percentile(&histogram, 0.10);
            let median = percentile(&histogram, 0.50);
            let high = percentile(&histogram, 0.90);
            if high.saturating_sub(low) < LOCAL_TONAL_ROBUST_RANGE
                || median.saturating_sub(low) < LOCAL_TONAL_TWO_SIDED_RANGE
                || high.saturating_sub(median) < LOCAL_TONAL_TWO_SIDED_RANGE
                || !(MIDTONE_LOW..=MIDTONE_HIGH).contains(&median)
            {
                continue;
            }
            for y in top..bottom {
                for x in left..right {
                    if !text_vicinity_mask.get(x, y)
                        && !border_artifacts.get(x, y)
                        && !protected_tone_mask.is_some_and(|mask| mask.get(x, y))
                    {
                        outside_midtone_mask.set(x, y, true);
                    }
                }
            }
        }
    }
    let pixels = outside_midtone_mask.count_black();
    let components = ComponentMap::from_binary(&outside_midtone_mask);
    let largest = components
        .components()
        .iter()
        .max_by_key(|component| component.area);
    let evidence = OutsideTonalEvidence {
        fraction: pixels as f64 / page_pixels as f64,
        largest_component_fraction: largest
            .map_or(0.0, |component| component.area as f64 / page_pixels as f64),
        largest_component_width_fraction: largest.map_or(0.0, |component| {
            (component.right - component.left + 1) as f64 / normalized.width().max(1) as f64
        }),
        largest_component_height_fraction: largest.map_or(0.0, |component| {
            (component.bottom - component.top + 1) as f64 / normalized.height().max(1) as f64
        }),
    };
    (evidence, outside_midtone_mask)
}

fn curve_for_ink_anchor(ink_anchor: u8) -> (f64, f64) {
    let black_point = (WHITE_ANCHOR * f64::from(ink_anchor) - TARGET_INK_ANCHOR * WHITE_ANCHOR)
        / (WHITE_ANCHOR - TARGET_INK_ANCHOR);
    let slope = WHITE_ANCHOR / (WHITE_ANCHOR - black_point);
    (black_point.max(0.0), slope)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum TextToneRule {
    Applied,
    PictureEvidence,
    InsufficientText,
    TonalMassOutsideText,
    AlreadyDark,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TextToneDiagnostics {
    pub applied: bool,
    pub rule: TextToneRule,
    pub text_line_count: usize,
    pub text_ink_pixels: usize,
    pub picture_fraction: f64,
    pub outside_midtone_fraction: f64,
    pub outside_midtone_largest_component_fraction: f64,
    pub outside_midtone_largest_component_width_fraction: f64,
    pub outside_midtone_largest_component_height_fraction: f64,
    pub ink_anchor: Option<u8>,
    pub black_point: Option<f64>,
    pub slope: Option<f64>,
}

impl TextToneDiagnostics {
    pub fn identity(
        rule: TextToneRule,
        text_line_count: usize,
        text_ink_pixels: usize,
        picture_fraction: f64,
        outside_midtone_fraction: f64,
        outside_midtone_largest_component_fraction: f64,
        outside_midtone_largest_component_width_fraction: f64,
        outside_midtone_largest_component_height_fraction: f64,
        ink_anchor: Option<u8>,
    ) -> Self {
        Self {
            applied: false,
            rule,
            text_line_count,
            text_ink_pixels,
            picture_fraction,
            outside_midtone_fraction,
            outside_midtone_largest_component_fraction,
            outside_midtone_largest_component_width_fraction,
            outside_midtone_largest_component_height_fraction,
            ink_anchor,
            black_point: None,
            slope: None,
        }
    }

    pub fn validate(self) -> Result<(), String> {
        let fractions = [
            self.picture_fraction,
            self.outside_midtone_fraction,
            self.outside_midtone_largest_component_fraction,
            self.outside_midtone_largest_component_width_fraction,
            self.outside_midtone_largest_component_height_fraction,
        ];
        if fractions
            .into_iter()
            .any(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
        {
            return Err("Text-tone evidence fractions must be finite unit intervals".into());
        }
        if self.applied != (self.rule == TextToneRule::Applied) {
            return Err("Text-tone applied flag and rule disagree".into());
        }
        if self.applied {
            let ink_anchor = self
                .ink_anchor
                .ok_or("Applied text-tone evidence needs an ink anchor")?;
            let (black_point, slope) = curve_for_ink_anchor(ink_anchor);
            let provided_black_point = self
                .black_point
                .filter(|value| value.is_finite())
                .ok_or("Applied text-tone evidence needs a finite black point")?;
            let provided_slope = self
                .slope
                .filter(|value| value.is_finite() && *value > 0.0)
                .ok_or("Applied text-tone evidence needs a positive finite slope")?;
            if (provided_black_point - black_point).abs() > 1e-9
                || (provided_slope - slope).abs() > 1e-9
            {
                return Err("Text-tone curve does not match its canonical ink anchor".into());
            }
        } else if self.black_point.is_some() || self.slope.is_some() {
            return Err("Identity text-tone evidence cannot carry a render curve".into());
        }
        Ok(())
    }
}

pub fn derive_text_tone_diagnostics(
    normalized: &GrayImage,
    text_mask: &BinaryImage,
    text_vicinity_mask: &BinaryImage,
    picture_mask: &BinaryImage,
) -> TextToneDiagnostics {
    debug_assert_eq!(
        (normalized.width(), normalized.height()),
        (text_mask.width(), text_mask.height()),
    );
    debug_assert_eq!(
        (normalized.width(), normalized.height()),
        (text_vicinity_mask.width(), text_vicinity_mask.height()),
    );
    debug_assert_eq!(
        (normalized.width(), normalized.height()),
        (picture_mask.width(), picture_mask.height()),
    );
    let page_pixels = normalized
        .width()
        .saturating_mul(normalized.height())
        .max(1);
    let unprotected_text_mask = text_mask.subtract(picture_mask);
    let text_line_count = horizontal_band_count(&unprotected_text_mask);
    // This is the strong source-tone protection mask, not the deliberately
    // overbroad routing mask. It is derived from distributed local histograms
    // independently of text segmentation. It excludes protected pixels from
    // both curve derivation and application; its mere presence must not veto
    // darkening otherwise valid text elsewhere on the page.
    let picture_fraction = picture_mask.count_black() as f64 / page_pixels as f64;
    let text_ink_pixels = unprotected_text_mask.count_black();
    let outside_tone =
        outside_tonal_evidence_excluding(normalized, text_vicinity_mask, Some(picture_mask)).0;
    if text_line_count < MINIMUM_TEXT_LINES || text_ink_pixels == 0 {
        if !outside_tone.coherent() {
            if let Some((ink_anchor, fallback_ink_pixels)) =
                sparse_fallback_ink_anchor(normalized, Some(picture_mask))
            {
                if ink_anchor <= DARK_INK_ANCHOR {
                    return TextToneDiagnostics::identity(
                        TextToneRule::AlreadyDark,
                        text_line_count,
                        fallback_ink_pixels,
                        picture_fraction,
                        outside_tone.fraction,
                        outside_tone.largest_component_fraction,
                        outside_tone.largest_component_width_fraction,
                        outside_tone.largest_component_height_fraction,
                        Some(ink_anchor),
                    );
                }
                if ink_anchor > (WHITE_ANCHOR as u8).saturating_sub(MINIMUM_RELIABLE_INK_SEPARATION)
                {
                    return TextToneDiagnostics::identity(
                        TextToneRule::InsufficientText,
                        text_line_count,
                        fallback_ink_pixels,
                        picture_fraction,
                        outside_tone.fraction,
                        outside_tone.largest_component_fraction,
                        outside_tone.largest_component_width_fraction,
                        outside_tone.largest_component_height_fraction,
                        Some(ink_anchor),
                    );
                }
                let (black_point, slope) = curve_for_ink_anchor(ink_anchor);
                return TextToneDiagnostics {
                    applied: true,
                    rule: TextToneRule::Applied,
                    text_line_count,
                    text_ink_pixels: fallback_ink_pixels,
                    picture_fraction,
                    outside_midtone_fraction: outside_tone.fraction,
                    outside_midtone_largest_component_fraction: outside_tone
                        .largest_component_fraction,
                    outside_midtone_largest_component_width_fraction: outside_tone
                        .largest_component_width_fraction,
                    outside_midtone_largest_component_height_fraction: outside_tone
                        .largest_component_height_fraction,
                    ink_anchor: Some(ink_anchor),
                    black_point: Some(black_point),
                    slope: Some(slope),
                };
            }
        }
        return TextToneDiagnostics::identity(
            TextToneRule::InsufficientText,
            text_line_count,
            text_ink_pixels,
            picture_fraction,
            0.0,
            0.0,
            0.0,
            0.0,
            None,
        );
    }

    let histogram = (0..normalized.height())
        .into_par_iter()
        .map(|y| {
            let mut local = [0usize; 256];
            for x in 0..normalized.width() {
                if unprotected_text_mask.get(x, y) {
                    local[normalized.get(x, y) as usize] += 1;
                }
            }
            local
        })
        .reduce(
            || [0usize; 256],
            |mut left, right| {
                for (target, value) in left.iter_mut().zip(right) {
                    *target += value;
                }
                left
            },
        );
    let ink_anchor = percentile(&histogram, 0.10);
    let outside_midtone_fraction = outside_tone.fraction;
    let outside_midtone_largest_component_fraction = outside_tone.largest_component_fraction;
    let outside_midtone_largest_component_width_fraction =
        outside_tone.largest_component_width_fraction;
    let outside_midtone_largest_component_height_fraction =
        outside_tone.largest_component_height_fraction;
    if ink_anchor <= DARK_INK_ANCHOR {
        return TextToneDiagnostics::identity(
            TextToneRule::AlreadyDark,
            text_line_count,
            text_ink_pixels,
            picture_fraction,
            outside_midtone_fraction,
            outside_midtone_largest_component_fraction,
            outside_midtone_largest_component_width_fraction,
            outside_midtone_largest_component_height_fraction,
            Some(ink_anchor),
        );
    }
    if ink_anchor > (WHITE_ANCHOR as u8).saturating_sub(MINIMUM_RELIABLE_INK_SEPARATION) {
        return TextToneDiagnostics::identity(
            TextToneRule::InsufficientText,
            text_line_count,
            text_ink_pixels,
            picture_fraction,
            outside_midtone_fraction,
            outside_midtone_largest_component_fraction,
            outside_midtone_largest_component_width_fraction,
            outside_midtone_largest_component_height_fraction,
            Some(ink_anchor),
        );
    }
    let coherent_outside_tonal_region = outside_tone.coherent();
    if coherent_outside_tonal_region {
        return TextToneDiagnostics::identity(
            TextToneRule::TonalMassOutsideText,
            text_line_count,
            text_ink_pixels,
            picture_fraction,
            outside_midtone_fraction,
            outside_midtone_largest_component_fraction,
            outside_midtone_largest_component_width_fraction,
            outside_midtone_largest_component_height_fraction,
            Some(ink_anchor),
        );
    }
    let (black_point, slope) = curve_for_ink_anchor(ink_anchor);
    TextToneDiagnostics {
        applied: true,
        rule: TextToneRule::Applied,
        text_line_count,
        text_ink_pixels,
        picture_fraction,
        outside_midtone_fraction,
        outside_midtone_largest_component_fraction,
        outside_midtone_largest_component_width_fraction,
        outside_midtone_largest_component_height_fraction,
        ink_anchor: Some(ink_anchor),
        black_point: Some(black_point),
        slope: Some(slope),
    }
}

fn sparse_fallback_ink_anchor(
    normalized: &GrayImage,
    protected_tone_mask: Option<&BinaryImage>,
) -> Option<(u8, usize)> {
    let mut histogram = [0usize; 256];
    let mut eligible_pixels = 0usize;
    for y in 0..normalized.height() {
        for x in 0..normalized.width() {
            if !protected_tone_mask.is_some_and(|mask| mask.get(x, y)) {
                histogram[normalized.get(x, y) as usize] += 1;
                eligible_pixels += 1;
            }
        }
    }
    if eligible_pixels == 0 {
        return None;
    }
    let paper_anchor = percentile(&histogram, 0.75);
    if paper_anchor < FALLBACK_PAPER_MINIMUM {
        return None;
    }
    let cutoff = paper_anchor.saturating_sub(FALLBACK_INK_SEPARATION);
    let ink_pixels = histogram[..=cutoff as usize].iter().sum::<usize>();
    let ink_fraction = ink_pixels as f64 / eligible_pixels as f64;
    if !(FALLBACK_INK_MINIMUM_FRACTION..=FALLBACK_INK_MAXIMUM_FRACTION).contains(&ink_fraction) {
        return None;
    }
    let mut ink_histogram = histogram;
    ink_histogram[cutoff as usize + 1..].fill(0);
    let ink_anchor = percentile(&ink_histogram, 0.10);
    (paper_anchor.saturating_sub(ink_anchor) >= FALLBACK_INK_SEPARATION)
        .then_some((ink_anchor, ink_pixels))
}

fn horizontal_band_count(mask: &BinaryImage) -> usize {
    let mut bands = 0usize;
    let mut occupied_last_row = false;
    for y in 0..mask.height() {
        let occupied = (0..mask.width()).any(|x| mask.get(x, y));
        if occupied && !occupied_last_row {
            bands += 1;
        }
        occupied_last_row = occupied;
    }
    bands
}

pub fn apply_text_tone(image: &mut GrayImage, diagnostics: TextToneDiagnostics) {
    apply_text_tone_excluding(image, diagnostics, None);
}

pub(crate) fn apply_text_tone_excluding(
    image: &mut GrayImage,
    diagnostics: TextToneDiagnostics,
    preservation_alpha: Option<&GrayImage>,
) {
    if !diagnostics.applied {
        return;
    }
    let Some(ink_anchor) = diagnostics.ink_anchor else {
        return;
    };
    // The integer anchor is the canonical render parameter. Re-deriving the
    // curve avoids sub-ULP JSON number round trips changing preview/final or
    // base/detail rasterization.
    let lut = std::array::from_fn::<u8, 256, _>(|value| {
        if value >= WHITE_ANCHOR as usize {
            return value as u8;
        }
        let value = value as f64;
        let anchor = f64::from(ink_anchor).clamp(1.0, WHITE_ANCHOR - 1.0);
        let mapped = if value <= anchor {
            value * TARGET_INK_ANCHOR / anchor
        } else {
            TARGET_INK_ANCHOR
                + (value - anchor) * (WHITE_ANCHOR - TARGET_INK_ANCHOR) / (WHITE_ANCHOR - anchor)
        };
        mapped.round().clamp(0.0, WHITE_ANCHOR) as u8
    });
    let width = image.width();
    let height = image.height();
    image
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, value) in row.iter_mut().enumerate() {
                let alpha = preservation_alpha.map_or(0, |alpha| {
                    let alpha_x = x.saturating_mul(alpha.width()) / width.max(1);
                    let alpha_y = y.saturating_mul(alpha.height()) / height.max(1);
                    alpha.get(
                        alpha_x.min(alpha.width().saturating_sub(1)),
                        alpha_y.min(alpha.height().saturating_sub(1)),
                    )
                });
                let original = *value;
                let enhanced = lut[usize::from(original)];
                *value = ((u16::from(enhanced) * u16::from(255 - alpha)
                    + u16::from(original) * u16::from(alpha)
                    + 127)
                    / 255) as u8;
            }
        });
}

fn percentile(histogram: &[usize; 256], fraction: f64) -> u8 {
    let count = histogram.iter().sum::<usize>();
    let rank = ((count.saturating_sub(1)) as f64 * fraction).round() as usize;
    let mut cumulative = 0usize;
    for (value, frequency) in histogram.iter().copied().enumerate() {
        cumulative += frequency;
        if cumulative > rank {
            return value as u8;
        }
    }
    255
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_fixture(paper: u8, ink: u8) -> (GrayImage, BinaryImage, BinaryImage) {
        let mut image = GrayImage::new(320, 420, paper);
        let mut mask = BinaryImage::new(320, 420);
        let mut vicinity = BinaryImage::new(320, 420);
        for line in 0..12 {
            let top = 44 + line * 25;
            for y in top..top + 9 {
                for x in 28..28 + 24 * 11 {
                    vicinity.set(x, y, true);
                }
            }
            for glyph in 0..24 {
                let left = 28 + glyph * 11;
                for y in top..top + 9 {
                    for x in left..left + 6 {
                        if x == left || x + 1 == left + 6 || y == top || y + 1 == top + 9 {
                            image.set(x, y, ink);
                            mask.set(x, y, true);
                        }
                    }
                }
            }
        }
        (image, mask, vicinity)
    }

    #[test]
    fn gray_paper_text_gets_a_monotone_white_preserving_curve() {
        let (mut image, text_mask, text_vicinity_mask) = text_fixture(255, 138);
        let picture_mask = BinaryImage::new(image.width(), image.height());
        let diagnostics =
            derive_text_tone_diagnostics(&image, &text_mask, &text_vicinity_mask, &picture_mask);
        assert_eq!(diagnostics.rule, TextToneRule::Applied);
        let before = (0u8..=255).collect::<Vec<_>>();
        let mut ramp = GrayImage::from_vec(256, 1, 256, before).unwrap();
        apply_text_tone(&mut ramp, diagnostics);
        assert!(ramp.data().windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(ramp.get(250, 0), 250);
        assert_eq!(ramp.get(255, 0), 255);

        apply_text_tone(&mut image, diagnostics);
        assert!(image.get(28, 44) <= 65);
        assert_eq!(image.get(0, 0), 255);
    }

    #[test]
    fn sparse_faint_text_uses_histogram_fallback_when_line_detection_abstains() {
        let mut image = GrayImage::new(320, 420, 255);
        for line in 0..12 {
            let top = 38 + line * 27;
            for glyph in 0..24 {
                let left = 24 + glyph * 11;
                for y in top..top + 8 {
                    for x in left..left + 5 {
                        if x == left || y == top || y + 1 >= top + 8 {
                            image.set(x, y, 173);
                        }
                    }
                }
            }
        }
        let empty = BinaryImage::new(image.width(), image.height());
        let diagnostics = derive_text_tone_diagnostics(&image, &empty, &empty, &empty);

        assert_eq!(diagnostics.rule, TextToneRule::Applied);
        assert_eq!(diagnostics.text_line_count, 0);
        assert!(diagnostics.text_ink_pixels >= 4_000);
        apply_text_tone(&mut image, diagnostics);
        assert!(image.get(24, 38) <= 65);
        assert_eq!(image.get(0, 0), 255);
    }

    #[test]
    fn very_faint_sparse_text_reaches_the_requested_anchor_without_a_slope_clamp() {
        let mut image = GrayImage::new(320, 420, 255);
        for line in 0..5 {
            let top = 140 + line * 24;
            for glyph in 0..32 {
                let left = 34 + glyph * 7;
                for y in top..top + 7 {
                    for x in left..left + 4 {
                        if x == left || y == top || y + 1 == top + 7 {
                            image.set(x, y, 199);
                        }
                    }
                }
            }
        }
        let empty = BinaryImage::new(image.width(), image.height());
        let diagnostics = derive_text_tone_diagnostics(&image, &empty, &empty, &empty);

        assert_eq!(diagnostics.rule, TextToneRule::Applied);
        assert_eq!(diagnostics.ink_anchor, Some(199));
        assert!(
            diagnostics.slope.unwrap() > 2.5,
            "the old 2.5 slope clamp made this recoverable text remain pale"
        );
        apply_text_tone(&mut image, diagnostics);
        assert!((58..=62).contains(&image.get(34, 140)));
        assert_eq!(image.get(0, 0), 255);
    }

    #[test]
    fn continuous_tone_outside_text_refuses_the_curve() {
        let (mut image, text_mask, text_vicinity_mask) = text_fixture(255, 138);
        for y in 330..400 {
            for x in 20..300 {
                image.set(x, y, 80 + ((x * 7 + y * 11) % 150) as u8);
            }
        }
        let original = image.clone();
        let picture_mask = BinaryImage::new(image.width(), image.height());
        let diagnostics =
            derive_text_tone_diagnostics(&image, &text_mask, &text_vicinity_mask, &picture_mask);
        assert_eq!(diagnostics.rule, TextToneRule::TonalMassOutsideText);
        apply_text_tone(&mut image, diagnostics);
        assert_eq!(image, original);
    }

    #[test]
    fn a_thin_page_rule_does_not_masquerade_as_continuous_tone() {
        let (mut image, text_mask, text_vicinity_mask) = text_fixture(255, 138);
        for y in 18..22 {
            for x in 8..312 {
                image.set(x, y, 150);
            }
        }
        let picture_mask = BinaryImage::new(image.width(), image.height());
        let diagnostics =
            derive_text_tone_diagnostics(&image, &text_mask, &text_vicinity_mask, &picture_mask);
        assert_eq!(diagnostics.rule, TextToneRule::Applied);
        assert_eq!(
            diagnostics.outside_midtone_largest_component_fraction, 0.0,
            "a single flat tone is not continuous-tone evidence"
        );
        apply_text_tone(&mut image, diagnostics);
        assert!(image.get(28, 44) <= 65);
        assert_eq!(image.get(0, 0), 255);
    }

    #[test]
    fn tonal_tiles_reject_flat_raster_noise_but_keep_a_real_tone_distribution() {
        let mut noisy_paper = GrayImage::new(320, 420, 220);
        for y in 0..noisy_paper.height() {
            for x in 0..noisy_paper.width() {
                noisy_paper.set(x, y, 216 + ((x * 5 + y * 3) % 9) as u8);
            }
        }
        let vicinity = BinaryImage::new(noisy_paper.width(), noisy_paper.height());
        assert_eq!(
            outside_tonal_evidence(&noisy_paper, &vicinity),
            OutsideTonalEvidence::default(),
        );

        let mut tonal = GrayImage::new(320, 420, 255);
        for y in 260..390 {
            for x in 40..280 {
                tonal.set(
                    x,
                    y,
                    match (x + y) % 3 {
                        0 => 110,
                        1 => 160,
                        _ => 210,
                    },
                );
            }
        }
        let evidence = outside_tonal_evidence(&tonal, &vicinity);
        assert!(evidence.coherent(), "{evidence:?}");
        assert!(evidence.vetoes_destructive_mode(), "{evidence:?}");
    }

    #[test]
    fn already_black_text_is_idempotent() {
        let (mut image, text_mask, text_vicinity_mask) = text_fixture(255, 48);
        let original = image.clone();
        let picture_mask = BinaryImage::new(image.width(), image.height());
        let diagnostics =
            derive_text_tone_diagnostics(&image, &text_mask, &text_vicinity_mask, &picture_mask);
        assert_eq!(diagnostics.rule, TextToneRule::AlreadyDark);
        apply_text_tone(&mut image, diagnostics);
        assert_eq!(image, original);
    }

    #[test]
    fn isolated_picture_mask_noise_does_not_disable_text_tone() {
        let (image, text_mask, text_vicinity_mask) = text_fixture(255, 138);
        let mut picture_mask = BinaryImage::new(image.width(), image.height());
        picture_mask.set(3, 3, true);
        let diagnostics =
            derive_text_tone_diagnostics(&image, &text_mask, &text_vicinity_mask, &picture_mask);
        assert_eq!(diagnostics.rule, TextToneRule::Applied);
        assert!(diagnostics.picture_fraction > 0.0);
        assert!(diagnostics.picture_fraction < 0.012);
    }

    #[test]
    fn strong_tone_protection_overrides_overlapping_text_segmentation() {
        let (image, text_mask, text_vicinity_mask) = text_fixture(255, 138);
        let picture_mask = text_vicinity_mask.clone();
        let diagnostics =
            derive_text_tone_diagnostics(&image, &text_mask, &text_vicinity_mask, &picture_mask);

        assert_eq!(diagnostics.rule, TextToneRule::InsufficientText);
        assert!(diagnostics.picture_fraction >= 0.012);
    }

    #[test]
    fn real_picture_area_is_excluded_while_text_elsewhere_is_darkened() {
        let (mut image, text_mask, text_vicinity_mask) = text_fixture(255, 138);
        let mut picture_mask = BinaryImage::new(image.width(), image.height());
        for y in 360..410 {
            for x in 20..300 {
                picture_mask.set(x, y, true);
                image.set(
                    x,
                    y,
                    match (x + y) % 3 {
                        0 => 90,
                        1 => 150,
                        _ => 215,
                    },
                );
            }
        }
        let original_picture = image.clone();
        let diagnostics =
            derive_text_tone_diagnostics(&image, &text_mask, &text_vicinity_mask, &picture_mask);

        assert_eq!(diagnostics.rule, TextToneRule::Applied);
        assert!(diagnostics.picture_fraction >= 0.012);
        let mut preservation_alpha = GrayImage::new(picture_mask.width(), picture_mask.height(), 0);
        for y in 0..picture_mask.height() {
            for x in 0..picture_mask.width() {
                if picture_mask.get(x, y) {
                    preservation_alpha.set(x, y, 255);
                }
            }
        }
        apply_text_tone_excluding(&mut image, diagnostics, Some(&preservation_alpha));
        assert!(image.get(28, 44) <= 65);
        for y in 360..410 {
            for x in 20..300 {
                assert_eq!(image.get(x, y), original_picture.get(x, y));
            }
        }
    }

    #[test]
    fn destructive_mode_veto_requires_semantic_two_dimensional_coherence() {
        let subcoherent = OutsideTonalEvidence {
            fraction: 0.015,
            largest_component_fraction: 0.01,
            largest_component_width_fraction: 0.04,
            largest_component_height_fraction: 0.04,
        };
        assert!(!subcoherent.vetoes_destructive_mode());

        let thin_rule = OutsideTonalEvidence {
            fraction: 0.03,
            largest_component_height_fraction: 0.02,
            ..subcoherent
        };
        assert!(!thin_rule.vetoes_destructive_mode());

        let coherent_tone = OutsideTonalEvidence {
            fraction: 0.03,
            largest_component_height_fraction: 0.05,
            ..subcoherent
        };
        assert!(coherent_tone.vetoes_destructive_mode());

        let fragmented_tone = OutsideTonalEvidence {
            fraction: 0.12,
            largest_component_fraction: 0.01,
            largest_component_width_fraction: 0.40,
            largest_component_height_fraction: 0.025,
        };
        assert!(
            !fragmented_tone.vetoes_destructive_mode(),
            "distributed stroke-like contamination cannot become semantic tone by aggregate mass"
        );
    }
}
