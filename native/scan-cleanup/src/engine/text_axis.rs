use scan_primitives::GrayImage;
use serde::{Deserialize, Serialize};

const MIN_AXIS_CONFIDENCE: f64 = 0.25;
const MIN_SUPPORTED_LINES: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextAxisHint {
    pub sideways: bool,
    pub confidence: f64,
}

#[derive(Clone, Copy, Debug)]
struct ProjectionEvidence {
    score: f64,
    period: usize,
}

pub(crate) fn detect_text_axis(image: &GrayImage, otsu_threshold: u8) -> Option<TextAxisHint> {
    let (rows, columns) = ink_projections(image, otsu_threshold.clamp(48, 232));
    let horizontal = projection_evidence(&rows);
    let vertical = projection_evidence(&columns);
    let sideways = vertical.score > horizontal.score;
    let (winning_profile, period) = if sideways {
        (&columns, vertical.period)
    } else {
        (&rows, horizontal.period)
    };
    let supported_lines = supported_line_count(winning_profile, period);
    let total_axis_score = horizontal.score + vertical.score + f64::EPSILON;
    let axis_margin = (horizontal.score - vertical.score).abs() / total_axis_score;
    let confidence = (axis_margin * 2.2).clamp(0.0, 1.0);
    (supported_lines >= MIN_SUPPORTED_LINES && confidence >= MIN_AXIS_CONFIDENCE).then_some(
        TextAxisHint {
            sideways,
            confidence,
        },
    )
}

fn ink_projections(image: &GrayImage, threshold: u8) -> (Vec<f64>, Vec<f64>) {
    let mut rows = vec![0.0; image.height()];
    let mut columns = vec![0.0; image.width()];
    let x_margin = image.width() / 25;
    let y_margin = image.height() / 25;
    let x_start = x_margin.min(image.width());
    let x_end = image.width().saturating_sub(x_margin).max(x_start);
    let y_start = y_margin.min(image.height());
    let y_end = image.height().saturating_sub(y_margin).max(y_start);
    let threshold = f64::from(threshold);
    let softness = 24.0;
    for (y, row_sum) in rows.iter_mut().enumerate().take(y_end).skip(y_start) {
        for (x, column_sum) in columns.iter_mut().enumerate().take(x_end).skip(x_start) {
            let value = f64::from(image.get(x, y));
            let ink = ((threshold + softness - value) / softness).clamp(0.0, 1.0);
            *row_sum += ink;
            *column_sum += ink;
        }
    }
    let row_scale = (x_end.saturating_sub(x_start)).max(1) as f64;
    let column_scale = (y_end.saturating_sub(y_start)).max(1) as f64;
    for value in &mut rows[y_start..y_end] {
        *value /= row_scale;
    }
    for value in &mut columns[x_start..x_end] {
        *value /= column_scale;
    }
    (rows, columns)
}

fn projection_evidence(profile: &[f64]) -> ProjectionEvidence {
    if profile.len() < 24 {
        return ProjectionEvidence {
            score: 0.0,
            period: 8,
        };
    }
    let cap = percentile(profile, 0.92);
    let clipped: Vec<f64> = profile.iter().map(|value| value.min(cap)).collect();
    let small = moving_average(&clipped, 1);
    let broad_radius = (profile.len() / 90).clamp(5, 24);
    let broad = moving_average(&small, broad_radius);
    let residual: Vec<f64> = small
        .iter()
        .zip(&broad)
        .map(|(value, background)| value - background)
        .collect();
    let start = profile.len() / 25;
    let end = profile.len().saturating_sub(start);
    let body = &residual[start..end.max(start)];
    let residual_energy = mean_square(body).sqrt();
    let mean_ink = clipped[start..end.max(start)].iter().sum::<f64>() / body.len().max(1) as f64;
    let min_lag = 6usize;
    let max_lag = (profile.len() / 12).clamp(min_lag + 1, 80);
    let mut best_correlation = 0.0_f64;
    let mut best_period = min_lag;
    let energy = body.iter().map(|value| value * value).sum::<f64>();
    if energy > f64::EPSILON {
        for lag in min_lag..=max_lag.min(body.len().saturating_sub(1)) {
            let numerator = body[..body.len() - lag]
                .iter()
                .zip(&body[lag..])
                .map(|(left, right)| left * right)
                .sum::<f64>();
            let correlation = numerator / energy;
            if correlation > best_correlation {
                best_correlation = correlation;
                best_period = lag;
            }
        }
    }
    let periodicity = best_correlation.max(0.0).sqrt();
    let normalized_energy = residual_energy / (mean_ink + 0.0025);
    ProjectionEvidence {
        score: normalized_energy * (0.55 + 0.45 * periodicity),
        period: best_period,
    }
}

fn supported_line_count(profile: &[f64], estimated_period: usize) -> usize {
    let forward = supported_line_count_one_way(profile, estimated_period);
    let reversed: Vec<f64> = profile.iter().rev().copied().collect();
    forward.min(supported_line_count_one_way(&reversed, estimated_period))
}

fn supported_line_count_one_way(profile: &[f64], estimated_period: usize) -> usize {
    if profile.len() < 24 {
        return 0;
    }
    let smooth = moving_average(profile, 1);
    let background = moving_average(&smooth, estimated_period.clamp(6, 60));
    let residual: Vec<f64> = smooth
        .iter()
        .zip(&background)
        .map(|(value, local)| (value - local).max(0.0))
        .collect();
    let mean = residual.iter().sum::<f64>() / residual.len() as f64;
    let deviation = residual
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / (residual.len().max(1) as f64).sqrt();
    let peak_floor = mean + deviation * 0.35;
    let half_window = (estimated_period * 2 / 5).clamp(3, 24);
    let min_separation = (estimated_period * 3 / 5).clamp(4, 36);
    let mut candidates: Vec<(usize, f64)> = (half_window..residual.len() - half_window)
        .filter(|&index| {
            residual[index] >= peak_floor
                && residual[index] >= residual[index - 1]
                && residual[index] > residual[index + 1]
        })
        .map(|index| (index, residual[index]))
        .collect();
    candidates.sort_by(|left, right| right.1.total_cmp(&left.1));
    let mut peaks = Vec::new();
    for (index, strength) in candidates {
        if peaks
            .iter()
            .all(|&(selected, _): &(usize, f64)| selected.abs_diff(index) >= min_separation)
        {
            peaks.push((index, strength));
        }
    }
    let supported = peaks
        .into_iter()
        .filter(|&(peak, _)| {
            let mass = (1..=half_window)
                .map(|distance| {
                    let weight = 1.0 - (distance - 1) as f64 / half_window as f64 * 0.45;
                    (residual[peak - distance] + residual[peak + distance]) * weight
                })
                .sum::<f64>();
            mass > mean * half_window as f64 * 0.8
        })
        .count();
    supported - 2 * (supported / 8)
}

fn percentile(values: &[f64], quantile: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len().saturating_sub(1)) as f64 * quantile)
        .round()
        .clamp(0.0, sorted.len().saturating_sub(1) as f64) as usize;
    sorted.get(index).copied().unwrap_or(0.0)
}

fn moving_average(values: &[f64], radius: usize) -> Vec<f64> {
    let mut prefix = Vec::with_capacity(values.len() + 1);
    prefix.push(0.0);
    for &value in values {
        prefix.push(prefix.last().copied().unwrap_or(0.0) + value);
    }
    (0..values.len())
        .map(|index| {
            let start = index.saturating_sub(radius);
            let end = (index + radius + 1).min(values.len());
            (prefix[end] - prefix[start]) / (end - start).max(1) as f64
        })
        .collect()
}

fn mean_square(values: &[f64]) -> f64 {
    values.iter().map(|value| value * value).sum::<f64>() / values.len().max(1) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        background::normalize_illumination_for_layout, engine::render::analyze_page,
        png::decode_gray, CleanupOptions, OrthogonalRotation, DEFAULT_MAX_DIMENSION,
        DEFAULT_MAX_PIXELS,
    };
    use scan_primitives::threshold::otsu_threshold;

    fn rotate_clockwise(source: &GrayImage) -> GrayImage {
        let mut output = GrayImage::new(source.height(), source.width(), 255);
        for y in 0..source.height() {
            for x in 0..source.width() {
                output.set(source.height() - 1 - y, x, source.get(x, y));
            }
        }
        output
    }

    fn fixture(bytes: &[u8]) -> GrayImage {
        decode_gray(bytes, DEFAULT_MAX_PIXELS, DEFAULT_MAX_DIMENSION).unwrap()
    }

    #[test]
    fn dense_text_flags_only_while_sideways() {
        let source = fixture(include_bytes!(
            "../../tests/fixtures/split/hard-07-single-hebrew-weingreen-p00080.png"
        ));
        let upright = normalize_illumination_for_layout(&source);
        let upright_hint = detect_text_axis(&upright, otsu_threshold(&upright)).unwrap();
        assert!(!upright_hint.sideways);

        let sideways = rotate_clockwise(&upright);
        let sideways_hint = detect_text_axis(&sideways, otsu_threshold(&sideways)).unwrap();
        assert!(sideways_hint.sideways);
        assert!(sideways_hint.confidence >= MIN_AXIS_CONFIDENCE);
    }

    #[test]
    fn sparse_walton_page_abstains_in_both_axes() {
        let source = fixture(include_bytes!(
            "../../tests/fixtures/split/spread-spread-walton-p00001.png"
        ));
        let upright = normalize_illumination_for_layout(&source);
        assert_eq!(detect_text_axis(&upright, otsu_threshold(&upright)), None);
        let sideways = rotate_clockwise(&upright);
        assert_eq!(detect_text_axis(&sideways, otsu_threshold(&sideways)), None);
    }

    #[test]
    fn user_rotation_is_applied_before_axis_scoring() {
        let upright = fixture(include_bytes!(
            "../../tests/fixtures/split/hard-07-single-hebrew-weingreen-p00080.png"
        ));
        let sideways = rotate_clockwise(&upright);
        assert!(analyze_page(&sideways, &CleanupOptions::default())
            .unwrap()
            .text_axis
            .is_some_and(|axis| axis.sideways));

        let corrected = analyze_page(
            &sideways,
            &CleanupOptions {
                rotation: OrthogonalRotation::Clockwise270,
                ..CleanupOptions::default()
            },
        )
        .unwrap();
        assert!(corrected.text_axis.is_some_and(|axis| !axis.sideways));
    }
}
